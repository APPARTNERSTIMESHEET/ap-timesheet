/**
 * One-time cleanup: re-link invoice_items that lost their matter_id / user_id
 * during the (now-fixed) Edit Draft save bug.
 *
 * Description format from buildInvoicePreview:
 *   "<file_no> — <matter_title> • <Lawyer Full Name> @ ₹<rate>/hr"
 *
 * We parse the lawyer name out of the "• Name @" segment and the file_no out
 * of the "<file_no> — " prefix, then look those up against the users and
 * matters tables. Items that can't be matched are left alone (logged at the
 * end so the admin can review).
 *
 * Safe to re-run — only touches rows where the FK column is currently NULL
 * AND a confident match is found.
 *
 * Run against prod:
 *   cd C:\ap-timesheet
 *   node ops\relink-orphan-invoice-items.js
 */
const { db } = require('../utils/db');

// Fetch every orphan invoice_item that still has a description we can parse.
const orphans = db.prepare(
  `SELECT id, invoice_id, description, matter_id, user_id, rate, amount
   FROM invoice_items
   WHERE (user_id IS NULL OR matter_id IS NULL)
     AND description IS NOT NULL`
).all();

console.log(`Found ${orphans.length} candidate orphan item(s).`);

// Build lookup tables once.
const usersByName = new Map();
for (const u of db.prepare('SELECT id, full_name FROM users WHERE full_name IS NOT NULL').all()) {
  usersByName.set(u.full_name.trim().toLowerCase(), u.id);
}
const mattersByFileNo = new Map();
for (const m of db.prepare('SELECT id, file_no FROM matters WHERE file_no IS NOT NULL').all()) {
  mattersByFileNo.set(m.file_no.trim().toLowerCase(), m.id);
}

const upd = db.prepare(
  `UPDATE invoice_items
   SET matter_id = COALESCE(matter_id, ?),
       user_id   = COALESCE(user_id,   ?)
   WHERE id = ?`
);

let fixed = 0, partial = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const it of orphans) {
    const desc = it.description;
    // Lawyer name: between "•" and "@"
    let userId = null;
    const userMatch = desc.match(/[•·]\s*([^@]+?)\s*@/);
    if (userMatch) {
      const name = userMatch[1].trim().toLowerCase();
      userId = usersByName.get(name) || null;
    }
    // file_no: starts of description until " — "
    let matterId = null;
    const fileMatch = desc.match(/^([^—]+?)\s+—/);
    if (fileMatch) {
      const fno = fileMatch[1].trim().toLowerCase();
      matterId = mattersByFileNo.get(fno) || null;
    }
    if (!userId && !matterId) {
      console.log(`  SKIP item #${it.id}: no match in description "${desc.slice(0,60)}..."`);
      skipped++;
      continue;
    }
    upd.run(matterId, userId, it.id);
    if (userId && matterId) {
      fixed++;
      console.log(`  RELINKED item #${it.id} -> user=${userId} matter=${matterId}`);
    } else {
      partial++;
      console.log(`  PARTIAL  item #${it.id} -> user=${userId||'?'} matter=${matterId||'?'}`);
    }
  }
});
tx();

console.log(`\nDone. fully-relinked: ${fixed}, partially-relinked: ${partial}, skipped: ${skipped}`);

// Audit trail
try {
  db.prepare(
    `INSERT INTO audit_log (user_id, user_email, user_name, action, entity, detail)
     VALUES (NULL, 'system', 'cleanup script', 'invoice_items_relinked', 'invoice_items', ?)`
  ).run(`fixed=${fixed} partial=${partial} skipped=${skipped} on ${new Date().toISOString()}`);
} catch (_) {}
