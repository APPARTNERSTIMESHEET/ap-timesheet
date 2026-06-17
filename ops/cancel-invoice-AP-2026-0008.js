/**
 * One-shot cleanup: cancel the zero-total test invoice AP/2026/0008.
 * Sets status='cancelled', clears paid_at, and releases any timesheet
 * entries linked to it so they become billable again.
 *
 * Idempotent — safe to re-run. Run with: node ops/cancel-invoice-AP-2026-0008.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'database', 'aptimesheet.db');
const db = new Database(dbPath);
const INV_NO = 'AP/2026/0008';

const inv = db.prepare(
  'SELECT id, invoice_no, status, subtotal, total, paid_at FROM invoices WHERE invoice_no = ?'
).get(INV_NO);

if (!inv) {
  console.log(`[skip] Invoice ${INV_NO} not found — nothing to do.`);
  process.exit(0);
}

console.log('[before]', inv);

const tx = db.transaction(() => {
  // 1. Release any timesheet entries that were locked to this invoice.
  //    'invoiced' → 'approved' (re-billable). Drafts had status='approved' already.
  const released = db.prepare(`
    UPDATE timesheet_entries
    SET status = CASE WHEN status = 'invoiced' THEN 'approved' ELSE status END,
        invoice_id = NULL
    WHERE invoice_id = ?
  `).run(inv.id);

  // 2. Flip the invoice to cancelled + clear paid date. Keep payment_ref for audit.
  db.prepare(`
    UPDATE invoices
    SET status = 'cancelled',
        paid_at = NULL
    WHERE id = ?
  `).run(inv.id);

  // 3. Log an audit row so the action is traceable.
  try {
    db.prepare(`
      INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
      VALUES (NULL, 'invoice_cancelled_via_script', 'invoice', ?, ?)
    `).run(inv.id, `Cancelled zero-total invoice ${INV_NO}; released ${released.changes} timesheet entry(ies).`);
  } catch (e) { /* audit_log shape may differ — non-fatal */ }

  return released.changes;
});

const releasedCount = tx();
const after = db.prepare(
  'SELECT id, invoice_no, status, subtotal, total, paid_at FROM invoices WHERE invoice_no = ?'
).get(INV_NO);

console.log('[after] ', after);
console.log(`[done]   Released ${releasedCount} timesheet entry(ies).`);
console.log(`[done]   Invoice ${INV_NO} is now CANCELLED. It will only appear in All Invoices when status filter = Cancelled.`);
