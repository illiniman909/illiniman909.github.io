/**
 * Krusty Kardboard — Custom Binder Request handler (Cloudflare Worker)
 *
 * The browser posts the binder form (text fields + image files) to this Worker.
 *
 * Preferred path (no shared-IP rate limits): everything goes through Resend,
 * authenticated by API key. The shop gets the order email with the customer's
 * images attached, and the customer gets an automatic confirmation.
 *
 * Legacy fallback: if RESEND_API_KEY is not set (or Resend errors), the Worker
 * falls back to the old flow — images to ImgBB, order email via Web3Forms.
 * Both of those rate-limit by IP, and Workers share Cloudflare egress IPs
 * with other people's Workers, so that path can be blocked through no fault
 * of ours. It exists only so nothing breaks before Resend is configured.
 *
 * Order log: if SHEET_WEBHOOK_URL is set, every submission is also appended as
 * a row to a Google Sheet, via the Apps Script in ../google-apps-script. That
 * is a durable record independent of email — it replaces the row the old
 * Web3Forms → Sheets integration used to write. It is best-effort and runs
 * after the response, so a Sheets outage can never fail an order.
 *
 * Secrets (set in the dashboard under Settings → Variables and Secrets):
 *   RESEND_API_KEY        — from https://resend.com (preferred path)
 *   SHEET_WEBHOOK_TOKEN   — shared secret the Apps Script checks (order log)
 *   IMGBB_API_KEY         — legacy fallback only
 *   WEB3FORMS_ACCESS_KEY  — legacy fallback only
 *
 * Optional vars:
 *   SHEET_WEBHOOK_URL — Apps Script /exec URL; unset disables the order log
 *   FROM_EMAIL     — verified sender, default
 *                    "Krusty Kardboard <orders@krustykardboard.com>"
 *   SHOP_EMAIL     — where order emails go, default krustykardboard@gmail.com
 *   REPLY_TO       — reply address on customer confirmations, default SHOP_EMAIL
 *   ALLOWED_ORIGIN — site allowed to call this Worker,
 *                    default https://krustykardboard.com
 */

export default {
  async fetch(request, env, ctx) {
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://krustykardboard.com';
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed.' }, 405, cors);
    }

    try {
      const form = await request.formData();

      // Honeypot — silently accept bot submissions without sending anything.
      if (form.get('botcheck')) {
        return json({ success: true, message: 'OK' }, 200, cors);
      }

      const frontFile = form.get('front_image');
      const backFile = form.get('back_image');

      if (!frontFile || typeof frontFile === 'string' || frontFile.size === 0) {
        return json({ success: false, message: 'A front image is required.' }, 400, cors);
      }
      const back = (backFile && typeof backFile !== 'string' && backFile.size > 0) ? backFile : null;

      const fields = {
        name: form.get('name') || '',
        phone: form.get('phone') || '',
        email: form.get('email') || '',
        address: form.get('address') || '',
        binder_brand: form.get('binder_brand') || '',
        binder_color: form.get('binder_color') || '',
        binder_type: form.get('binder_type') || '',
        binder_size: form.get('binder_size') || '',
        binder_price: form.get('binder_price') || '',
        notes: form.get('notes') || '',
        has_back: !!back,
        // Prefixed so the attachments are self-labelling — otherwise two
        // camera-roll names like IMG_1234.jpg are indistinguishable.
        front_name: 'FRONT-' + (frontFile.name || 'image.jpg'),
        back_name: back ? 'BACK-' + (back.name || 'image.jpg') : '',
      };

      // Durable record, independent of whichever email path runs below. Kept
      // best-effort on purpose: a row is worth having even if a send fails,
      // and a Sheets problem must never cost us an order.
      deferred(ctx, logToSheet(fields, env));

      // ---- Preferred path: Resend end-to-end ----
      if (env.RESEND_API_KEY) {
        try {
          await sendShopEmail(fields, frontFile, back, env);
          // The confirmation is best-effort and the customer should not wait
          // on it: hand it to the runtime and respond immediately.
          deferred(ctx, sendCustomerConfirmation(fields, env));
          return json({ success: true, message: 'OK' }, 200, cors);
        } catch (err) {
          // Fall back to the legacy path if it is configured; otherwise report.
          if (!(env.IMGBB_API_KEY && env.WEB3FORMS_ACCESS_KEY)) throw err;
        }
      }

      // ---- Legacy fallback: ImgBB + Web3Forms ----
      const frontUrl = await uploadToImgbb(frontFile, env.IMGBB_API_KEY);
      const backUrl = back ? await uploadToImgbb(back, env.IMGBB_API_KEY) : '';

      const payload = {
        access_key: env.WEB3FORMS_ACCESS_KEY,
        subject: 'New Custom Binder Request',
        from_name: 'Krusty Kardboard Custom Binders',
        ...fields,
        front_image_url: frontUrl,
        back_image_url: backUrl || 'None provided',
      };
      delete payload.has_back;
      delete payload.front_name;
      delete payload.back_name;

      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      // Identify the form service in its error messages (e.g. rate limits).
      if (!data.success && data.message) {
        data.message = 'Form service: ' + data.message;
      }
      if (data.success && env.RESEND_API_KEY) {
        deferred(ctx, sendCustomerConfirmation(fields, env));
      }
      return json(data, res.status, cors);
    } catch (err) {
      return json({ success: false, message: (err && err.message) || 'Server error.' }, 500, cors);
    }
  },
};

/** Run a best-effort task after the response is sent, if the runtime allows. */
function deferred(ctx, promise) {
  const p = Promise.resolve(promise).catch((err) => {
    // Best-effort work must never fail the request, but swallowing the error
    // outright leaves nothing to debug. Send it to the Worker's logs
    // (Cloudflare dashboard → Logs, or `wrangler tail`) instead.
    console.error('Deferred task failed:', (err && err.message) || err);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- Branded email template (matches krustykardboard.com) ---------- */

const BRAND = {
  tan: '#cfa972',        // cardboard backdrop
  paper: '#fffaf2',      // cream card
  ink: '#2a1a00',
  inkSoft: '#8a6a3a',
  orange: '#c97f1a',
  orangeDk: '#9c5e0d',
  boxBg: '#fff6e9',
  boxBorder: '#f0d6a8',
  logo: 'https://krustykardboard.com/logo.png',
};

const headingStyle =
  "font-family:'Bangers','Arial Black',Arial,sans-serif;font-weight:normal;" +
  'letter-spacing:1px;color:' + BRAND.orangeDk + ';font-size:27px;margin:0 0 14px;';

const detailRow = (label, value) => value
  ? '<tr><td style="padding:7px 14px 7px 12px;color:' + BRAND.inkSoft + ';font-weight:bold;' +
    'vertical-align:top;white-space:nowrap;">' + label + '</td>' +
    '<td style="padding:7px 12px 7px 0;color:' + BRAND.ink + ';white-space:pre-wrap;width:100%;">' +
    esc(value) + '</td></tr>'
  : '';

const detailBox = (rows) =>
  '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="' +
  'background:' + BRAND.boxBg + ';border:2px solid ' + BRAND.boxBorder + ';' +
  'border-radius:12px;margin:16px 0;font-size:14px;">' + rows + '</table>';

/** Wraps email content in the site look: logo, cream card on tan, tagline. */
function emailShell(content) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Bangers&display=swap");</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.tan + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + BRAND.tan + '" ' +
    'style="background:' + BRAND.tan + ';"><tr><td align="center" style="padding:30px 14px 34px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">' +
    '<tr><td align="center" style="padding:0 0 18px;">' +
    '<a href="https://krustykardboard.com" style="text-decoration:none;">' +
    '<img src="' + BRAND.logo + '" width="210" alt="Krusty Kardboard TCG" ' +
    'style="display:block;width:210px;max-width:72%;height:auto;border:0;"></a>' +
    '</td></tr>' +
    '<tr><td style="background:' + BRAND.paper + ';border-radius:18px;padding:28px 26px;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:' + BRAND.ink + ';">' +
    content +
    '</td></tr>' +
    '<tr><td align="center" style="padding:18px 0 0;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:11px;font-weight:bold;letter-spacing:2px;color:#5c3610;text-transform:uppercase;">' +
    'Singles &bull; Slabs &bull; Sealed</td></tr>' +
    '<tr><td align="center" style="padding:7px 0 0;">' +
    '<a href="https://krustykardboard.com" style="font-family:Arial,Helvetica,sans-serif;' +
    'font-size:12px;color:' + BRAND.orangeDk + ';font-weight:bold;">krustykardboard.com</a>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

/** Customer confirmation body. */
function customerEmailHtml(f) {
  return emailShell(
    '<h1 style="' + headingStyle + '">We Got Your Binder Request!</h1>' +
    '<p style="margin:0 0 12px;">Hi ' + esc(f.name || 'there') + ',</p>' +
    '<p style="margin:0 0 4px;">Thanks for your request &mdash; we&rsquo;re reviewing it now and ' +
    'will reach out soon at this email address to confirm the details.</p>' +
    detailBox(
      detailRow('Binder', f.binder_type) +
      detailRow('Layout', f.binder_size) +
      detailRow('Color', f.binder_color) +
      detailRow('Price', f.binder_price) +
      detailRow('Back image', f.has_back ? 'Yes (extra charge)' : 'No') +
      detailRow('Notes', f.notes)
    ) +
    '<p style="margin:0 0 12px;"><strong>No payment is due yet.</strong> Once we confirm your ' +
    'order by email, a 50% deposit gets your build started.</p>' +
    '<p style="margin:18px 0 0;color:' + BRAND.inkSoft + ';">&mdash; Your Local Card Guys<br>' +
    'Krusty Kardboard TCG</p>'
  );
}

/** Shop order-notification body. */
function shopEmailHtml(f) {
  return emailShell(
    '<h1 style="' + headingStyle + '">New Custom Binder Request</h1>' +
    detailBox(
      detailRow('Name', f.name) +
      detailRow('Phone', f.phone) +
      detailRow('Email', f.email) +
      detailRow('Ship to', f.address) +
      detailRow('Binder', f.binder_type) +
      detailRow('Layout', f.binder_size) +
      detailRow('Color', f.binder_color) +
      detailRow('Price', f.binder_price) +
      detailRow('Front image', f.front_name || 'attached') +
      detailRow('Back image', f.has_back ? (f.back_name || 'attached') : 'No') +
      detailRow('Notes', f.notes)
    ) +
    '<p style="margin:0;color:' + BRAND.inkSoft + ';">Artwork is attached, named ' +
    '<strong>FRONT-</strong> and <strong>BACK-</strong>. Hitting reply goes ' +
    'straight to the customer.</p>'
  );
}

async function resendSend(env, message) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) {}
    throw new Error('Email service: ' + (detail || ('send failed (' + res.status + ')')));
  }
}

/** Order email to the shop, with the customer's images attached. */
async function sendShopEmail(f, frontFile, backFile, env) {
  const from = env.FROM_EMAIL || 'Krusty Kardboard <orders@krustykardboard.com>';
  const shop = env.SHOP_EMAIL || 'krustykardboard@gmail.com';

  // ~30MB pre-encoding keeps the email under Resend's 40MB total limit.
  const totalBytes = frontFile.size + (backFile ? backFile.size : 0);
  if (totalBytes > 30 * 1024 * 1024) {
    throw new Error('Images are too large — please use images under 15MB each.');
  }

  // Names are assigned by the handler so the order log and this email agree.
  const frontName = f.front_name;
  const backName = f.back_name;

  const attachments = [{
    filename: frontName,
    content: await fileToBase64(frontFile),
  }];
  if (backFile) {
    attachments.push({ filename: backName, content: await fileToBase64(backFile) });
  }

  await resendSend(env, {
    from,
    to: [shop],
    reply_to: f.email || undefined,
    subject: 'New Custom Binder Request — ' + (f.name || 'Unknown'),
    html: shopEmailHtml(f),
    attachments,
  });
}

/** Confirmation email to the customer. */
async function sendCustomerConfirmation(f, env) {
  const from = env.FROM_EMAIL || 'Krusty Kardboard <orders@krustykardboard.com>';
  if (!f.email) return;

  await resendSend(env, {
    from,
    to: [f.email],
    reply_to: env.REPLY_TO || env.SHOP_EMAIL || 'krustykardboard@gmail.com',
    subject: 'We received your custom binder request — Krusty Kardboard',
    html: customerEmailHtml(f),
  });
}

/**
 * Append the order to the Google Sheet through the Apps Script web app.
 * The script matches these keys to its own header row, so renaming a column
 * in the Sheet does not require redeploying the Worker.
 */
async function logToSheet(f, env) {
  if (!env.SHEET_WEBHOOK_URL) return;

  const res = await fetch(env.SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.SHEET_WEBHOOK_TOKEN || '',
      timestamp: new Date().toISOString(),
      name: f.name,
      phone: f.phone,
      email: f.email,
      address: f.address,
      binder_brand: f.binder_brand,
      binder_type: f.binder_type,
      binder_size: f.binder_size,
      binder_color: f.binder_color,
      binder_price: f.binder_price,
      // Artwork rides along on the order email rather than a public host, so
      // the Sheet records the filenames to match a row against that email.
      front_image: f.front_name,
      back_image: f.has_back ? f.back_name : 'None provided',
      notes: f.notes,
    }),
  });

  // Apps Script serves the result via a 302 to script.googleusercontent.com;
  // fetch follows it as a GET, which is fine — doPost has already run by then.
  // It also answers 200 with an HTML error page for some failures, so trust
  // the JSON body over the status code.
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (!res.ok || body.success === false) {
    throw new Error('Order log: ' + (body.message || ('failed (' + res.status + ')')));
  }
}

async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function uploadToImgbb(file, key) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('https://api.imgbb.com/1/upload?key=' + key, {
    method: 'POST',
    body: fd,
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error('Image host: ' + ((data.error && data.error.message) || 'upload failed.'));
  }
  return data.data.url;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
