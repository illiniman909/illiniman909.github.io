# Custom Binder form handler — Cloudflare Worker

This Worker keeps your **ImgBB** and **Web3Forms** keys off the public web page.
The browser sends the binder form to the Worker; the Worker uploads the images
and emails you the request, using keys stored as encrypted secrets.

You can deploy it in ~5 minutes with **no command line** (Dashboard) or with the
`wrangler` CLI.

---

## Option A — Cloudflare Dashboard (no CLI)

1. Create a free account at <https://dash.cloudflare.com>.
2. In the left menu: **Workers & Pages → Create → Create Worker**.
3. Give it a name (e.g. `krusty-binder`) and click **Deploy**.
4. Click **Edit code**, delete the sample, and paste the entire contents of
   [`worker.js`](./worker.js). Click **Deploy** again.
5. Go to the Worker's **Settings → Variables and Secrets** and add:
   | Name | Type | Value |
   |------|------|-------|
   | `IMGBB_API_KEY` | Secret (Encrypt) | your ImgBB key |
   | `WEB3FORMS_ACCESS_KEY` | Secret (Encrypt) | your Web3Forms key |
   | `ALLOWED_ORIGIN` | Text | `https://krustykardboard.com` |
6. **Deploy** once more so the secrets take effect.
7. Copy the Worker URL shown at the top — it looks like
   `https://krusty-binder.YOUR-SUBDOMAIN.workers.dev`.

## Option B — Wrangler CLI

```bash
npm install -g wrangler
cd cloudflare-worker
wrangler login
wrangler secret put IMGBB_API_KEY         # paste key when prompted
wrangler secret put WEB3FORMS_ACCESS_KEY   # paste key when prompted
wrangler deploy
```

The deploy output prints your Worker URL.

---

## Final step

Put the Worker URL into `custom-binder.html` — set the `WORKER_URL` constant
near the bottom of the page:

```js
const WORKER_URL = 'https://krusty-binder.YOUR-SUBDOMAIN.workers.dev';
```

Then commit and push. That's it — the page now carries no secrets.

> **Tip:** Because the old keys were briefly committed to this repo, regenerate
> fresh keys in ImgBB and Web3Forms and use the new ones in the Worker secrets.
