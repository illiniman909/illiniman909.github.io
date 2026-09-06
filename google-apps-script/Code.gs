/**
 * Krusty Kardboard — binder order log (Google Apps Script)
 *
 * Bound to the Google Sheet that records custom binder requests. Deployed as
 * a web app, it accepts a JSON POST from the Cloudflare Worker and appends one
 * row per submission — the job the old Web3Forms → Sheets integration did
 * before orders moved to Resend.
 *
 * Setup lives in ../cloudflare-worker/README.md ("Order log").
 *
 * The web app must be deployed with access "Anyone" so the Worker can reach it
 * without a Google login, so the URL alone is not a secret. SHARED_TOKEN is
 * what actually keeps strangers from writing rows: set it to a long random
 * string and give the Worker the same value as SHEET_WEBHOOK_TOKEN.
 */

var SHARED_TOKEN = 'CHANGE-ME';

/** Sheet tab to append to. Leave as '' to use the first tab. */
var SHEET_NAME = '';

/**
 * Column order used only when the sheet has no header row yet. An existing
 * sheet keeps its own headers — rows are matched to them by label, so you can
 * reorder or rename columns in the Sheet without touching this script or the
 * Worker.
 */
var FIELDS = [
  ['timestamp',    'Timestamp'],
  ['name',         'Name'],
  ['phone',        'Phone'],
  ['email',        'Email'],
  ['address',      'Ship To'],
  ['binder_brand', 'Binder Brand'],
  ['binder_type',  'Binder'],
  ['binder_size',  'Layout'],
  ['binder_color', 'Color'],
  ['binder_price', 'Price'],
  ['front_image',  'Front Image'],
  ['back_image',   'Back Image'],
  // Blank when the upload was rate-limited. Sheets makes a bare URL
  // clickable on its own, so no formula is needed.
  ['front_url',    'Front Link'],
  ['back_url',     'Back Link'],
  ['notes',        'Notes'],
];

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (SHARED_TOKEN && payload.token !== SHARED_TOKEN) {
      return reply({ success: false, message: 'Unauthorized.' });
    }

    // Appends race when two people submit at once, so serialize them.
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      appendRow(payload);
    } finally {
      lock.releaseLock();
    }

    return reply({ success: true });
  } catch (err) {
    return reply({ success: false, message: String((err && err.message) || err) });
  }
}

/** A GET is only ever a human checking the deployment is live. */
function doGet() {
  return reply({ success: true, message: 'Krusty Kardboard order log is running.' });
}

function appendRow(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found.');

  var headers = readHeaders(sheet);
  if (!headers.length) {
    headers = FIELDS.map(function (f) { return f[1]; });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // Map each header to the payload key whose default label matches it, so a
  // column we do not know about is simply left blank rather than shifting the
  // row out of alignment.
  var byLabel = {};
  FIELDS.forEach(function (f) { byLabel[normalize(f[1])] = f[0]; });

  var row = headers.map(function (header) {
    var key = byLabel[normalize(header)];
    if (!key) return '';
    // A real Date so the column sorts and formats as one, in the Sheet's
    // own timezone, rather than sitting there as ISO text.
    if (key === 'timestamp') {
      var when = new Date(payload.timestamp);
      return isNaN(when.getTime()) ? new Date() : when;
    }
    return sanitize(payload[key]);
  });

  sheet.appendRow(row);
}

/**
 * Anyone on the internet can fill in the binder form, so a value that starts
 * like a formula would otherwise be evaluated when it lands in the Sheet.
 * The leading apostrophe pins it as text and is not shown in the cell.
 */
function sanitize(value) {
  if (value === undefined || value === null) return '';
  var text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function readHeaders(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  var values = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return values.join('') === '' ? [] : values.map(String);
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
