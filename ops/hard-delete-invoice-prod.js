/**
 * HARD DELETE invoice AP/2026/0008 from the LIVE production DB.
 * Explicit user request — overrides the no-hard-delete policy as a one-shot
 * admin cleanup of a test invoice that has zero financial impact (total=0,
 * already cancelled, all linked timesheet entries already released).
 *
 * Removes: invoices row, invoice_items rows, ledes_exports rows.
 * Preserves: audit_log entries (so the action history stays auditable).
 */
const Database = require('better-sqlite3');

const DB_PATH = 'C:\\ap-timesheet\\database\\aptimesheet.db';
const INV_NO  = 'AP/2026/0008';

console.log('Opening DB:', DB_PATH);
const db = new Database(DB_PATH);
try { db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); } catch(_) {}

const inv = db.prepare(
  'SELECT id, invoice_no, status, total FROM invoices WHERE invoice_no = ?'
).get(INV_NO);

if (!inv) {
  console.log(`[skip] ${INV_NO} already gone — nothing to do.`);
  process.exit(0);
}

console.log('[before]', inv);

// Safety guard: only hard-delete if (a) total = 0 AND (b) status = cancelled.
// Prevents accidental destruction of real financial records.
if (Number(inv.total) !== 0) {
  console.error(`[ABORT] Invoice has non-zero total (${inv.total}). Refusing to hard-delete a real invoice.`);
  process.exit(2);
}
if (inv.status !== 'cancelled') {
  console.error(`[ABORT] Invoice status is "${inv.status}", expected "cancelled". Cancel it first via the UI or the cancel-invoice-prod.js script.`);
  process.exit(2);
}

const tx = db.transaction(() => {
  const lineItems = db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(inv.id).changes;
  let ledesExports = 0;
  try {
    ledesExports = db.prepare('DELETE FROM ledes_exports WHERE invoice_id = ?').run(inv.id).changes;
  } catch(_) { /* table may not exist */ }
  // Defensive: ensure no timesheet_entries still point here
  const lingering = db.prepare('UPDATE timesheet_entries SET invoice_id = NULL WHERE invoice_id = ?').run(inv.id).changes;
  const invRow = db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id).changes;
  // Audit-log the destructive action
  try {
    db.prepare(`
      INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
      VALUES (NULL, 'invoice_hard_deleted_admin_script', 'invoice', ?, ?)
    `).run(inv.id, `Hard-deleted ${INV_NO} (total=0, cancelled); items=${lineItems}, ledes=${ledesExports}, lingering_entries_unlinked=${lingering}.`);
  } catch(_) {}
  return { lineItems, ledesExports, lingering, invRow };
});

const r = tx();
console.log('[done]', r);

const after = db.prepare('SELECT id FROM invoices WHERE invoice_no = ?').get(INV_NO);
console.log('[verify] Re-query for', INV_NO, '→', after || '(not found — successfully deleted)');
