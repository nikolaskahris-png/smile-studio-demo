/**
 * Smile Studio demo — Google Sheets backend (Apps Script web app).
 * Stores bookings, leads and human-handoff requests sent by the Cloudflare Worker.
 *
 * Setup: Extensions → Apps Script → paste this file → Deploy → New deployment
 *        → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 */

const SECRET = 'SET-YOUR-OWN-SECRET'; // must match SHEET_SECRET in the Worker
const TZ = 'Europe/Athens';
const SLOT_MIN = 30;
// Opening hours per weekday (0 = Sunday ... 6 = Saturday). Missing day = closed.
const HOURS = {
  1: ['09:00', '17:00'],
  2: ['09:00', '17:00'],
  3: ['09:00', '17:00'],
  4: ['09:00', '17:00'],
  5: ['09:00', '17:00'],
  6: ['10:00', '14:00'],
};

const H_BOOK = ['Created', 'ID', 'Name', 'Phone', 'Email', 'Service', 'Date', 'Time', 'Notes', 'Status'];
const H_LEAD = ['Created', 'Name', 'Phone', 'Email', 'Interest'];
const H_HAND = ['Created', 'Name', 'Phone', 'Reason', 'Summary'];

function doPost(e) {
  let b;
  try {
    b = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'bad_json' });
  }
  if (b.secret !== SECRET) return out({ ok: false, error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    switch (b.action) {
      case 'availability': return out(availability(b.date));
      case 'book': return out(book(b));
      case 'lead': return out(lead(b));
      case 'handoff': return out(handoff(b));
      case 'recent': return out(recent());
      default: return out({ ok: false, error: 'unknown_action' });
    }
  } finally {
    lock.releaseLock();
  }
}

/* ---------- actions ---------- */

function availability(date) {
  const slots = slotsFor(date);
  if (slots === null) return { ok: false, error: 'date must be YYYY-MM-DD' };
  if (date < today()) return { ok: false, error: 'date is in the past' };
  if (!slots.length) return { ok: true, date: date, open: false, free: [] };
  const taken = booked(date);
  const now = date === today() ? nowHM() : '00:00';
  const free = slots.filter(function (t) { return taken.indexOf(t) === -1 && t > now; });
  return { ok: true, date: date, open: true, free: free };
}

function book(b) {
  const name = clean(b.name, 80), phone = clean(b.phone, 30), service = clean(b.service, 80);
  const date = clean(b.date, 10), time = clean(b.time, 5);
  if (!name || !phone || !service) return { ok: false, error: 'name, phone and service are required' };
  const av = availability(date);
  if (!av.ok) return av;
  if (!av.open) return { ok: false, error: 'clinic is closed that day' };
  if (av.free.indexOf(time) === -1) return { ok: false, error: 'slot not available', free: av.free };
  const id = 'SS-' + Math.floor(1000 + Math.random() * 9000);
  sheet('Bookings', H_BOOK).appendRow([
    stamp(), id, safe(name), "'" + phone, safe(clean(b.email, 80)), safe(service), "'" + date, "'" + time, safe(clean(b.notes, 300)), 'confirmed',
  ]);
  return { ok: true, booking_id: id, name: name, service: service, date: date, time: time };
}

function lead(b) {
  const name = clean(b.name, 80);
  if (!name || (!b.phone && !b.email)) return { ok: false, error: 'name and phone or email are required' };
  sheet('Leads', H_LEAD).appendRow([stamp(), safe(name), "'" + clean(b.phone, 30), safe(clean(b.email, 80)), safe(clean(b.interest, 200))]);
  return { ok: true };
}

function handoff(b) {
  sheet('Handoffs', H_HAND).appendRow([stamp(), safe(clean(b.name, 80)), "'" + clean(b.phone, 30), safe(clean(b.reason, 200)), safe(clean(b.summary, 500))]);
  // In a real deployment this would also notify staff (email / Telegram / WhatsApp).
  return { ok: true, message: 'A team member has been notified and will contact the patient.' };
}

function recent() {
  const rows = sheet('Bookings', H_BOOK).getDataRange().getValues().slice(1).slice(-8).reverse();
  return {
    ok: true,
    bookings: rows.map(function (r) {
      const parts = String(r[2]).trim().split(/\s+/);
      const shortName = parts[0] + (parts[1] ? ' ' + parts[1].charAt(0) + '.' : '');
      return { id: r[1], name: shortName, service: r[5], date: asText(r[6], 'yyyy-MM-dd'), time: asText(r[7], 'HH:mm'), status: r[9] };
    }),
  };
}

/* ---------- helpers ---------- */

function slotsFor(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return null;
  const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  const h = HOURS[dow];
  if (!h) return [];
  const start = toMin(h[0]), end = toMin(h[1]), res = [];
  for (let t = start; t + SLOT_MIN <= end; t += SLOT_MIN) res.push(pad(Math.floor(t / 60)) + ':' + pad(t % 60));
  return res;
}

function booked(date) {
  return sheet('Bookings', H_BOOK).getDataRange().getValues().slice(1)
    .filter(function (r) { return asText(r[6], 'yyyy-MM-dd') === date && r[9] !== 'cancelled'; })
    .map(function (r) { return asText(r[7], 'HH:mm'); });
}

function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(headers);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return s;
}

function asText(v, fmt) { return v instanceof Date ? Utilities.formatDate(v, TZ, fmt) : String(v); }
function clean(v, max) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max); }
// Stops text that starts with = + - @ from being run as a spreadsheet formula.
function safe(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }
function stamp() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowHM() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function toMin(hm) { const p = hm.split(':'); return +p[0] * 60 + +p[1]; }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
