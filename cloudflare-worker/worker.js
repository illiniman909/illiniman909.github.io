/**
 * Krusty Kardboard — Custom Binder Request handler (Cloudflare Worker)
 *
 * The browser posts the binder form (text fields + image files) to this Worker.
 * The Worker uploads the images to ImgBB and forwards the request to Web3Forms,
 * using API keys stored as encrypted Worker secrets — so no keys live in the
 * public web page.
 *
 * Required secrets (set with `wrangler secret put ...` or in the dashboard):
 *   IMGBB_API_KEY         — from https://api.imgbb.com
 *   WEB3FORMS_ACCESS_KEY  — from https://web3forms.com
 *
 * Optional (enables the automatic customer confirmation email):
 *   RESEND_API_KEY        — from https://resend.com (free tier is plenty)
 *   FROM_EMAIL            — verified sender, e.g.
 *                           "Krusty Kardboard <orders@krustykardboard.com>"
 *
 * Optional var:
 *   ALLOWED_ORIGIN        — site allowed to call this Worker
 *                           (defaults to https://krustykardboard.com)
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

      // 1. Upload images to ImgBB.
      const frontUrl = await uploadToImgbb(frontFile, env.IMGBB_API_KEY);
      let backUrl = '';
      if (backFile && typeof backFile !== 'string' && backFile.size > 0) {
        backUrl = await uploadToImgbb(backFile, env.IMGBB_API_KEY);
      }

      // 2. Forward the request to Web3Forms with the hosted image URLs.
      const payload = {
        access_key: env.WEB3FORMS_ACCESS_KEY,
        subject: 'New Custom Binder Request',
        from_name: 'Krusty Kardboard Custom Binders',
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
        front_image_url: frontUrl,
        back_image_url: backUrl || 'None provided',
      };

      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      // 3. On success, email the customer a confirmation with their request
      //    details. Never fails the submission — the shop email above is the
      //    source of truth; this is a courtesy copy.
      if (data.success && env.RESEND_API_KEY && payload.email) {
        try {
          await sendCustomerConfirmation(payload, env);
        } catch (_) { /* confirmation is best-effort */ }
      }

      return json(data, res.status, cors);
    } catch (err) {
      return json({ success: false, message: (err && err.message) || 'Server error.' }, 500, cors);
    }
  },
};

async function sendCustomerConfirmation(p, env) {
  const from = env.FROM_EMAIL || 'Krusty Kardboard <orders@krustykardboard.com>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const row = (label, value) => value
    ? '<tr><td style="padding:6px 14px 6px 0;color:#8a6a3a;font-weight:bold;">' +
      label + '</td><td style="padding:6px 0;color:#2a1a00;">' + esc(value) + '</td></tr>'
    : '';

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#2a1a00;">' +
    '<h2 style="color:#9c5e0d;">We got your custom binder request!</h2>' +
    '<p>Hi ' + esc(p.name || 'there') + ',</p>' +
    '<p>Thanks for your request — we&rsquo;re reviewing it now and will reach out ' +
    'soon at this email address to confirm the details.</p>' +
    '<table style="border-collapse:collapse;background:#fff6e9;border:1px solid #f0d6a8;' +
    'border-radius:8px;padding:8px;width:100%;" cellpadding="8">' +
    row('Binder', p.binder_type) +
    row('Layout', p.binder_size) +
    row('Color', p.binder_color) +
    row('Price', p.binder_price) +
    row('Back image', p.back_image_url === 'None provided' ? 'No' : 'Yes (extra charge)') +
    row('Notes', p.notes) +
    '</table>' +
    '<p><strong>No payment is due yet.</strong> Once we confirm your order by ' +
    'email, a 50% deposit gets your build started.</p>' +
    '<p>&mdash; Krusty Kardboard TCG<br>' +
    '<span style="color:#8a6a3a;font-size:12px;">Singles &bull; Slabs &bull; Sealed</span></p>' +
    '</div>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [p.email],
      subject: 'We received your custom binder request — Krusty Kardboard',
      html,
    }),
  });
  if (!res.ok) throw new Error('Confirmation email failed: ' + res.status);
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
    throw new Error((data.error && data.error.message) || 'Image upload failed.');
  }
  return data.data.url;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
