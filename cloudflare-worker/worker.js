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
 * Secrets (set in the dashboard under Settings → Variables and Secrets):
 *   RESEND_API_KEY        — from https://resend.com (preferred path)
 *   IMGBB_API_KEY         — legacy fallback only
 *   WEB3FORMS_ACCESS_KEY  — legacy fallback only
 *
 * Optional vars:
 *   FROM_EMAIL     — verified sender, default
 *                    "Krusty Kardboard <orders@krustykardboard.com>"
 *   SHOP_EMAIL     — where order emails go, default krustykardboard@gmail.com
 *   REPLY_TO       — reply address on customer confirmations, default SHOP_EMAIL
 *   ALLOWED_ORIGIN — site allowed to call this Worker,
 *                    default https://krustykardboard.com
 */

export default {
  async fetch(request, env) {
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
      };

      // ---- Preferred path: Resend end-to-end ----
      if (env.RESEND_API_KEY) {
        try {
          await sendShopEmail(fields, frontFile, back, env);
          try {
            await sendCustomerConfirmation(fields, env);
          } catch (_) { /* confirmation is best-effort */ }
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
        try { await sendCustomerConfirmation(fields, env); } catch (_) {}
      }
      return json(data, res.status, cors);
    } catch (err) {
      return json({ success: false, message: (err && err.message) || 'Server error.' }, 500, cors);
    }
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const detailRow = (label, value) => value
  ? '<tr><td style="padding:6px 14px 6px 0;color:#8a6a3a;font-weight:bold;vertical-align:top;">' +
    label + '</td><td style="padding:6px 0;color:#2a1a00;white-space:pre-wrap;">' + esc(value) + '</td></tr>'
  : '';

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

  const attachments = [{
    filename: frontFile.name || 'front-image',
    content: await fileToBase64(frontFile),
  }];
  if (backFile) {
    attachments.push({
      filename: backFile.name || 'back-image',
      content: await fileToBase64(backFile),
    });
  }

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2a1a00;">' +
    '<h2 style="color:#9c5e0d;">New Custom Binder Request</h2>' +
    '<table style="border-collapse:collapse;width:100%;" cellpadding="8">' +
    detailRow('Name', f.name) +
    detailRow('Phone', f.phone) +
    detailRow('Email', f.email) +
    detailRow('Shipping address', f.address) +
    detailRow('Binder', f.binder_type) +
    detailRow('Layout', f.binder_size) +
    detailRow('Color', f.binder_color) +
    detailRow('Price', f.binder_price) +
    detailRow('Back image', f.has_back ? 'Yes (attached)' : 'No') +
    detailRow('Notes', f.notes) +
    '</table>' +
    '<p style="color:#8a6a3a;">The customer&rsquo;s artwork is attached. ' +
    'Reply goes straight to the customer.</p>' +
    '</div>';

  await resendSend(env, {
    from,
    to: [shop],
    reply_to: f.email || undefined,
    subject: 'New Custom Binder Request — ' + (f.name || 'Unknown'),
    html,
    attachments,
  });
}

/** Confirmation email to the customer. */
async function sendCustomerConfirmation(f, env) {
  const from = env.FROM_EMAIL || 'Krusty Kardboard <orders@krustykardboard.com>';
  if (!f.email) return;

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2a1a00;">' +
    '<h2 style="color:#9c5e0d;">We got your custom binder request!</h2>' +
    '<p>Hi ' + esc(f.name || 'there') + ',</p>' +
    '<p>Thanks for your request — we&rsquo;re reviewing it now and will reach out ' +
    'soon at this email address to confirm the details.</p>' +
    '<table style="border-collapse:collapse;background:#fff6e9;border:1px solid #f0d6a8;' +
    'border-radius:8px;padding:8px;width:100%;" cellpadding="8">' +
    detailRow('Binder', f.binder_type) +
    detailRow('Layout', f.binder_size) +
    detailRow('Color', f.binder_color) +
    detailRow('Price', f.binder_price) +
    detailRow('Back image', f.has_back ? 'Yes (extra charge)' : 'No') +
    detailRow('Notes', f.notes) +
    '</table>' +
    '<p><strong>No payment is due yet.</strong> Once we confirm your order by ' +
    'email, a 50% deposit gets your build started.</p>' +
    '<p>&mdash; Krusty Kardboard TCG<br>' +
    '<span style="color:#8a6a3a;font-size:12px;">Singles &bull; Slabs &bull; Sealed</span></p>' +
    '</div>';

  await resendSend(env, {
    from,
    to: [f.email],
    reply_to: env.REPLY_TO || env.SHOP_EMAIL || 'krustykardboard@gmail.com',
    subject: 'We received your custom binder request — Krusty Kardboard',
    html,
  });
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
