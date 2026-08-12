/**
 * Krusty Kardboard — Custom Binder submission logger (Google Apps Script)
 *
 * Paste this into the Apps Script editor attached to your Google Sheet
 * (Sheet → Extensions → Apps Script), then Deploy it as a Web App. The
 * Cloudflare Worker POSTs each submission here and this appends one row.
 *
 * SECURITY — read cloudflare-worker/README.md. In short:
 *   • This script ONLY appends a row to THIS one Sheet. It cannot read your
 *     Gmail, Drive, or other docs — it has no code that touches them, and
 *     Apps Script only grants the permissions the code actually uses.
 *   • Set SHARED_SECRET below to a long random string and store the SAME
 *     value in the Worker secret SHEET_SHARED_SECRET. Requests without the
 *     matching secret are rejected, so a leaked URL alone can't write.
 *
 * The sheet is self-describing: the first row is treated as headers. New
 * fields sent by the Worker automatically get their own new column, so you
 * never have to edit this script when the form gains a field.
 */

// Must match the Worker secret SHEET_SHARED_SECRET exactly.
const SHARED_SECRET = 'CHANGE-ME-to-a-long-random-string';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize writes so concurrent submissions don't collide
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    // Reject anything that doesn't carry the shared secret.
    if (SHARED_SECRET && body.secret !== SHARED_SECRET) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    delete body.secret; // never store the secret in the sheet

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // Read (or create) the header row, adding columns for any new fields.
    const lastCol = sheet.getLastColumn();
    let headers = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      : [];
    let headersChanged = false;
    Object.keys(body).forEach(function (key) {
      if (headers.indexOf(key) === -1) {
        headers.push(key);
        headersChanged = true;
      }
    });
    if (headersChanged) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }

    // Build the row aligned to the header order.
    const row = headers.map(function (h) {
      return body[h] !== undefined ? body[h] : '';
    });
    sheet.appendRow(row);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
