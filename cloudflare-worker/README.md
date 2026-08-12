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

---

## Optional — log every submission to a Google Sheet

The Worker already emails each request via Web3Forms. You can *also* have it
append every field of every submission as a row in a Google Sheet, so you have
a permanent, searchable record even if an email is ever missed. The email keeps
working exactly as before — the Sheet write is a best-effort extra that can
never break or delay a request.

### Steps

1. Create a new Google Sheet (any Google account). Leave it blank — the script
   fills in the header row automatically on the first submission.
2. In the Sheet: **Extensions → Apps Script**. Delete the sample and paste the
   contents of [`google-sheet-apps-script.gs`](./google-sheet-apps-script.gs).
3. In that script, set `SHARED_SECRET` to a long random string (e.g. a
   password-manager-generated 32+ char value). Save.
4. **Deploy → New deployment → Web app.**
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*  ← this means "anyone with the URL can POST",
     not "anyone can read your Google account" (see security note below).
   - Click **Deploy**, authorize when prompted, and copy the **Web app URL**
     (it ends in `/exec`).
5. Add two secrets to the Worker (dashboard: *Settings → Variables and Secrets*,
   or `wrangler secret put ...`):
   | Name | Type | Value |
   |------|------|-------|
   | `SHEET_WEBHOOK_URL` | Secret (Encrypt) | the `/exec` Web app URL from step 4 |
   | `SHEET_SHARED_SECRET` | Secret (Encrypt) | the **same** string you set as `SHARED_SECRET` |
6. **Deploy** the Worker once more so the new secrets take effect.

That's it. If you skip this section entirely (no `SHEET_WEBHOOK_URL` set), the
Worker simply doesn't log to a Sheet — email-only behavior is unchanged.

### Is this secure? (Yes — here's why)

Short version: **this does not give anyone access to your Gmail or your Google
Docs.** Three separate protections:

1. **The script can only do what its code does — append a row to this one
   Sheet.** It contains no code that reads Gmail, Drive, or other documents, and
   Apps Script only ever grants the narrow permissions the code actually uses.
   A visitor hitting the URL cannot make it do anything else.
2. **The Web app URL is a long, unguessable token, and it lives only inside the
   Worker as an encrypted secret** — never in the public web page. Nobody
   browsing your site can see it.
3. **The shared secret.** Even if the URL leaked, every write must include the
   matching `SHARED_SECRET`. Requests without it are rejected, so a leaked URL
   alone can't add rows or spam your Sheet.

The `binder_size` / stale-deploy fix aside, the customer never talks to Google
at all — only your Worker does, server-to-server.
