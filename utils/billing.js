/**
 * Billing engine — converts approved (uninvoiced) entries for a client/period
 * into invoice line items, applying each matter's billing rule.
 */
const { db } = require('./db');

function rateForUserOnMatter(matter, userId) {
  // 1. matter rate-card row (latest by effective_from)
  const card = db.prepare(`
    SELECT hourly_rate FROM rate_cards
     WHERE matter_id = ? AND user_id = ?
     ORDER BY effective_from DESC LIMIT 1
  `).get(matter.id, userId);
  if (card) return card.hourly_rate;
  // 2. user default rate
  const u = db.prepare('SELECT default_rate FROM users WHERE id = ?').get(userId);
  return u && u.default_rate ? u.default_rate : 0;
}

/**
 * Build a preview of invoiceable items for a client between dates.
 * Only entries with status='approved' and is_billable=1 are considered.
 */
function buildInvoicePreview({ client_id, from, to }) {
  const matters = db.prepare(`
    SELECT m.* FROM matters m WHERE m.client_id = ?
  `).all(client_id);

  const items = [];

  for (const matter of matters) {
    const entries = db.prepare(`
      SELECT t.*, u.full_name AS user_name
      FROM timesheet_entries t
      JOIN users u ON u.id = t.user_id
      WHERE t.client_id = ? AND t.matter_id = ?
        AND t.is_billable = 1
        AND t.status = 'approved'
        AND t.invoice_id IS NULL
        AND t.entry_date BETWEEN ? AND ?
      ORDER BY t.entry_date, t.id
    `).all(client_id, matter.id, from, to);

    if (!entries.length && matter.billing_type !== 'flat') continue;

    if (matter.billing_type === 'flat') {
      // Charge flat fee once for the matter when there's at least one entry
      // and no previous invoice item for this matter exists.
      const previouslyBilled = db.prepare(`
        SELECT 1 FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.matter_id = ? AND i.status != 'cancelled' LIMIT 1
      `).get(matter.id);
      if (entries.length && !previouslyBilled) {
        items.push({
          matter_id: matter.id,
          user_id: null,
          description: `${matter.file_no} — ${matter.title} (Flat fee)`,
          quantity: 1,
          unit: 'lot',
          rate: matter.flat_fee || 0,
          amount: matter.flat_fee || 0,
          source_entry_ids: entries.map(e => e.id)
        });
      }
      continue;
    }

    if (matter.billing_type === 'hourly_matter') {
      const rate = matter.matter_rate || 0;
      const totalHours = entries.reduce((s, e) => s + e.hours, 0);
      items.push({
        matter_id: matter.id,
        user_id: null,
        description: `${matter.file_no} — ${matter.title} (Hourly @ ${rate.toFixed(2)})`,
        quantity: round2(totalHours),
        unit: 'hr',
        rate,
        amount: round2(totalHours * rate),
        source_entry_ids: entries.map(e => e.id)
      });
      continue;
    }

    // Default: hourly per associate, group by user
    const grouped = new Map();
    for (const e of entries) {
      if (!grouped.has(e.user_id)) grouped.set(e.user_id, { user_name: e.user_name, hours: 0, entries: [] });
      const g = grouped.get(e.user_id);
      g.hours += e.hours;
      g.entries.push(e);
    }
    for (const [userId, g] of grouped.entries()) {
      const rate = matter.billing_type === 'retainer'
        ? rateForUserOnMatter(matter, userId) // retainer still uses per-user rate to draw down
        : rateForUserOnMatter(matter, userId);
      items.push({
        matter_id: matter.id,
        user_id: userId,
        description: `${matter.file_no} — ${matter.title} • ${g.user_name} @ ${rate.toFixed(2)}/hr`,
        quantity: round2(g.hours),
        unit: 'hr',
        rate,
        amount: round2(g.hours * rate),
        source_entry_ids: g.entries.map(e => e.id),
        billing_type: matter.billing_type
      });
    }
  }

  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  return { items, subtotal };
}

function round2(n) { return Math.round(n * 100) / 100; }

function nextInvoiceNumber() {
  const prefix = process.env.INVOICE_PREFIX || 'AP';
  const year = new Date().getFullYear();
  const row = db.prepare(`
    SELECT invoice_no FROM invoices
    WHERE invoice_no LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`${prefix}/${year}/%`);
  let n = 1;
  if (row) {
    const m = row.invoice_no.match(/\/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}/${year}/${String(n).padStart(4, '0')}`;
}

/**
 * Persist preview as a saved invoice. Marks source entries invoice_id and status.
 */
function createInvoice({ client_id, invoice_date, period_from, period_to, tax_rate, notes, currency, created_by }) {
  const preview = buildInvoicePreview({ client_id, from: period_from, to: period_to });
  if (!preview.items.length) {
    const err = new Error('No billable items in this period');
    err.status = 400; throw err;
  }
  const subtotal = preview.subtotal;
  const taxRate = tax_rate == null ? 0 : Number(tax_rate);
  const taxAmount = round2(subtotal * (taxRate / 100));
  const total = round2(subtotal + taxAmount);
  const invoice_no = nextInvoiceNumber();

  const tx = db.transaction(() => {
    const inv = db.prepare(`
      INSERT INTO invoices
        (invoice_no, client_id, invoice_date, period_from, period_to,
         subtotal, tax_rate, tax_amount, total, currency, notes, created_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')
    `).run(
      invoice_no, client_id, invoice_date,
      period_from, period_to,
      subtotal, taxRate, taxAmount, total,
      currency || process.env.DEFAULT_CURRENCY || 'INR',
      notes || null, created_by
    );
    const invoiceId = inv.lastInsertRowid;

    const itemStmt = db.prepare(`
      INSERT INTO invoice_items
        (invoice_id, matter_id, user_id, description, quantity, unit, rate, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updEntry = db.prepare(`
      UPDATE timesheet_entries SET status = 'invoiced', invoice_id = ? WHERE id = ?
    `);

    for (const it of preview.items) {
      itemStmt.run(invoiceId, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
      for (const eid of it.source_entry_ids) updEntry.run(invoiceId, eid);
    }
    return invoiceId;
  });

  const invoiceId = tx();
  return { id: invoiceId, invoice_no, subtotal, tax_amount: taxAmount, total, items: preview.items };
}

module.exports = { buildInvoicePreview, createInvoice, nextInvoiceNumber };
