/**
 * Production DB cleanup: cancel invoice AP/2026/0008 directly in the
 * LIVE database at C:\ap-timesheet\database\aptimesheet.db (NOT the
 * OneDrive copy, which is just source/dev). Confirmed from server log:
 *   "DB: C:\ap-timesheet\database\aptimesheet.db"
 *
 * Sets status='cancelled', clears paid_at, releases linked timesheet entries.
 * Idempotent.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = 'C:\\ap-timesheet\\database\\aptimesheet.db';
const INV_NO = 'AP/2026/0008';

console.log('Opening DB:', DB_PATH);
const db = new Database(DB_PATH);

// Force checkpoint so we see latest writes from the running app
try { db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); } catch(_) {}

const inv = db.prepare(
  'SELECT id, invoice_no, status, subtotal, total, paid_at FROM invoices WHERE invoice_no = ?'
).get(INV_NO);

if (!inv) {
  console.log(`[skip] Invoice ${INV_NO} not found in this DB either.`);
  console.log('Last 10 invoices in this DB:');
  for (const r of db.prepare('SELECT id, invoice_no, status, total FROM invoices ORDER BY id DESC LIMIT 10').all()) {
    console.log('  ', r);
  }
  process.exit(0);
}

console.log('[before]', inv);

const tx = db.transaction(() => {
  const released = db.prepare(`
    UPDATE timesheet_entries
    SET status = CASE WHEN status = 'invoiced' THEN 'approved' ELSE status END,
        invoice_id = NULL
    WHERE invoice_id = ?
  `).run(inv.id);

  db.prepare(`
    UPDATE invoices
    SET status = 'cancelled', paid_at = NULL
    WHERE id = ?
  `).run(inv.id);

  try {
    db.prepare(`
      INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
      VALUES (NULL, 'invoice_cancelled_via_script', 'invoice', ?, ?)
    `).run(inv.id, `Cancelled zero-total invoice ${INV_NO}; released ${released.changes} timesheet entry(ies).`);
  } catch (e) { /* non-fatal */ }

  return released.changes;
});

const releasedCount = tx();
const after = db.prepare(
  'SELECT id, invoice_no, status, subtotal, total, paid_at FROM invoices WHERE invoice_no = ?'
).get(INV_NO);

console.log('[after] ', after);
console.log(`[done]   Released ${releasedCount} timesheet entry(ies).`);
console.log(`[done]   Invoice ${INV_NO} is now CANCELLED.`);
