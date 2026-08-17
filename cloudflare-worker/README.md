# Custom Binder form handler — Cloudflare Worker

The browser sends the binder form to this Worker; the Worker emails you the
order (with the customer's images attached) and sends the customer an
automatic confirmation — all via **Resend**, using keys stored as encrypted
secrets.

**Why Resend for everything:** Workers share Cloudflare egress IPs with other
people's Workers. ImgBB and Web3Forms rate-limit by IP, so submissions could be
blocked by *other people's* traffic ("Rate limit exceeded. IP temporarily
blocked"). Resend authenticates by API key, not IP, so it is immune. The old
ImgBB + Web3Forms flow remains only as an automatic fallback when
`RESEND_API_KEY` isn't set.

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
   | `RESEND_API_KEY` | Secret (Encrypt) | your Resend key — powers both emails |
   | `ALLOWED_ORIGIN` | Text | `https://krustykardboard.com` |
   | `FROM_EMAIL` | Text | *(optional)* default `Krusty Kardboard <orders@krustykardboard.com>` |
   | `SHOP_EMAIL` | Text | *(optional)* where orders go, default `krustykardboard@gmail.com` |
   | `IMGBB_API_KEY` | Secret (Encrypt) | *(legacy fallback only)* |
   | `WEB3FORMS_ACCESS_KEY` | Secret (Encrypt) | *(legacy fallback only)* |
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

---

## Customer confirmation email (optional)

When `RESEND_API_KEY` is set, the Worker automatically emails the customer a
confirmation as soon as their request is accepted — a recap of their binder
(type, layout, color, price, notes), a note that we're reviewing the
submission and will reach out soon, and a reminder that a 50% deposit is due
only after the order is confirmed by email.

Setup (~10 minutes, free tier covers 3,000 emails/month):

1. Create an account at <https://resend.com>.
2. **Domains → Add Domain** → `krustykardboard.com`, then add the DNS records
   Resend shows you (in Cloudflare DNS). Wait for it to verify.
3. **API Keys → Create API Key**, and add it to the Worker as the
   `RESEND_API_KEY` secret. Optionally set `FROM_EMAIL` (defaults to
   `Krusty Kardboard <orders@krustykardboard.com>`).
4. Re-deploy the Worker (paste the current `worker.js` if using the dashboard).

If the key is not set, or the confirmation fails to send, the submission still
goes through exactly as before — the confirmation is best-effort.

> **Tip:** Because the old keys were briefly committed to this repo, regenerate
> fresh keys in ImgBB and Web3Forms and use the new ones in the Worker secrets.
