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
        binder_color: form.get('binder_color') || '',
        binder_type: form.get('binder_type') || '',
        binder_size: form.get('binder_size') || '',
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
      return json(data, res.status, cors);
    } catch (err) {
      return json({ success: false, message: (err && err.message) || 'Server error.' }, 500, cors);
    }
  },
};

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
