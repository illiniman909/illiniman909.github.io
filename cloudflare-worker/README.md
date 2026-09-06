# Custom Binder form handler — Cloudflare Worker

The browser sends the binder form to this Worker; the Worker emails you the
order (with the customer's images attached) and sends the customer an
automatic confirmation — all via **Resend**, using keys stored as encrypted
secrets. If the [order log](#order-log--google-sheet) is set up, it also
appends the order as a row to a Google Sheet.

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
   | `SHEET_WEBHOOK_URL` | Text | *(optional)* Apps Script `/exec` URL — see [Order log](#order-log--google-sheet) |
   | `SHEET_WEBHOOK_TOKEN` | Secret (Encrypt) | *(optional)* must match `SHARED_TOKEN` in the Apps Script |
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

## Order log — Google Sheet

Orders used to land in a Google Sheet because they went through Web3Forms, and
Web3Forms had a Sheets integration configured on its side. Since orders moved
to Resend, Web3Forms is no longer called on the normal path, so those rows
stopped appearing. The Worker now writes the row itself instead, through a
small Apps Script bound to your Sheet — no third-party integration in between.

The row is written **after** the customer gets their response and is entirely
best-effort: if the Sheet is unreachable, the order email still goes out and
the submission still succeeds.

Setup (~10 minutes, no billing, no API console):

1. Open the Google Sheet you want the orders in (or create one).
2. **Extensions → Apps Script**. Delete the sample and paste the contents of
   [`../google-apps-script/Code.gs`](../google-apps-script/Code.gs).
3. Replace `CHANGE-ME` on the `SHARED_TOKEN` line with a long random string —
   this is what stops strangers from writing rows. Keep a copy of it.
   Optionally set `SHEET_NAME` if the orders belong on a tab other than the
   first one. Save.
4. **Deploy → New deployment → Web app**, with:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**

   Authorize it when Google asks. "Anyone" is required so the Worker can post
   without a Google login — the shared token, not the URL, is the access
   control.
5. Copy the deployment's **Web app URL** (it ends in `/exec`) and add it to the
   Worker as `SHEET_WEBHOOK_URL`, plus your token as `SHEET_WEBHOOK_TOKEN`.
   Re-deploy the Worker.
6. Submit a test order from the site. A row should appear within a few seconds.

**Columns.** On an empty sheet the script writes its own header row:

> Timestamp · Name · Phone · Email · Ship To · Binder Brand · Binder · Layout ·
> Color · Price · Front Image · Back Image · Notes

On a sheet that already has headers, it keeps yours and matches each incoming
value to the column with that label (ignoring case, spaces and punctuation), so
you can reorder columns or add your own — an "Order Status" column you fill in
by hand is left alone. A column whose label it doesn't recognise stays blank,
so if your existing sheet says e.g. *Binder Price* where the script says
*Price*, either rename the column or edit the label in the script's `FIELDS`
list to match. Nothing needs redeploying on the Worker side.

**Artwork.** The images ride along as attachments on the order email rather
than being uploaded to a public host, so the Sheet records their filenames
(`FRONT-…`, `BACK-…`) — that's what matches a row to its email.

**Changing the script later:** edit it, then **Deploy → Manage deployments →**
pencil icon **→ Version: New version → Deploy**. Editing alone does not update
the live web app, and creating a *new deployment* would change the URL.

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
