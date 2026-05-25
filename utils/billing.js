/**
 * Billing engine — converts approved (uninvoiced) entries for a client/period
 * into invoice line items, applying each matter's billing rule.
 */
const { db } = require('./db');

function rateForUserOnMatter(matter, userId, asOfDate) {
  // Pick the rate-card row whose effective_from is on or before the entry date
  // (or today if no date supplied). Without this filter, future-dated rate
  // changes would retroactively re-price already-completed work.
  const cutoff = asOfDate || new Date().toISOString().slice(0, 10);
  const card = db.prepare(`
    SELECT hourly_rate FROM rate_cards
     WHERE matter_id = ? AND user_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC LIMIT 1
  `).get(matter.id, userId, cutoff);
  if (card) return card.hourly_rate;
  // Fallback to the user's default rate
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
        AND t.status NOT IN ('rejected','invoiced')
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

    // Default: hourly per associate, group by (user_id + effective_rate)
    // Entries with a rate_override are grouped separately so they get their own line item.
    // Pass entry_date so rate_card lookups respect their effective_from.
    const grouped = new Map();
    for (const e of entries) {
      const effectiveRate = (e.rate_override != null) ? e.rate_override : rateForUserOnMatter(matter, e.user_id, e.entry_date);
      const key = `${e.user_id}::${effectiveRate}`;
      if (!grouped.has(key)) grouped.set(key, { user_id: e.user_id, user_name: e.user_name, hours: 0, entries: [], rate: effectiveRate });
      const g = grouped.get(key);
      g.hours += e.hours;
      g.entries.push(e);
    }
    for (const g of grouped.values()) {
      items.push({
        matter_id: matter.id,
        user_id: g.user_id,
        description: `${matter.file_no} — ${matter.title} • ${g.user_name} @ ₹${g.rate.toFixed(2)}/hr`,
        quantity: round2(g.hours),
        unit: 'hr',
        rate: g.rate,
        amount: round2(g.hours * g.rate),
        source_entry_ids: g.entries.map(e => e.id),
        billing_type: matter.billing_type
      });
    }
  }

  // ─── Out-of-pocket expenses logged by associates ──────────────────────
  // Associates can log per-entry expenses (court fee, taxi, courier, etc.)
  // via the popup on the timesheet grid. Collect them here as SEPARATE line
  // items grouped by (matter, description) — they're disbursements, not fees,
  // so they appear distinctly on the invoice (and map to UTBMS E-codes on LEDES).
  const expenseRows = db.prepare(`
    SELECT t.matter_id, t.user_id, t.entry_date, t.expense_amount, t.expense_description,
           m.file_no, m.title AS matter_title
    FROM timesheet_entries t
    JOIN matters m ON m.id = t.matter_id
    WHERE t.client_id = ?
      AND t.status NOT IN ('rejected','invoiced')
      AND t.invoice_id IS NULL
      AND t.entry_date BETWEEN ? AND ?
      AND t.expense_amount IS NOT NULL
      AND t.expense_amount > 0
    ORDER BY t.entry_date, t.id
  `).all(client_id, from, to);

  // Group expenses by (matter_id, description) so multiple "Court fee" entries
  // for the same matter become one line item with total amount + count.
  const expenseGroups = new Map();
  for (const r of expenseRows) {
    const key = `${r.matter_id}::${(r.expense_description || 'Expense').toLowerCase()}`;
    if (!expenseGroups.has(key)) {
      expenseGroups.set(key, {
        matter_id: r.matter_id,
        file_no: r.file_no,
        matter_title: r.matter_title,
        description: r.expense_description || 'Expense',
        total: 0,
        count: 0
      });
    }
    const g = expenseGroups.get(key);
    g.total += Number(r.expense_amount) || 0;
    g.count += 1;
  }

  for (const g of expenseGroups.values()) {
    items.push({
      matter_id: g.matter_id,
      user_id: null,    // expenses aren't tied to a single lawyer
      description: `${g.file_no} — ${g.matter_title} • ${g.description}${g.count > 1 ? ' (×' + g.count + ')' : ''}`,
      quantity: 1,
      unit: 'lot',
      rate: round2(g.total),
      amount: round2(g.total),
      source_entry_ids: [],   // expenses aren't 1:1 with single entries here
      is_expense: true        // marker so the UI / PDF can style it differently
    });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  return { items, subtotal };
}

function round2(n) { return Math.round(n * 100) / 100; }

function nextInvoiceNumber() {
  const prefix = process.env.INVOICE_PREFIX || 'AP';
  const year = new Date().getFullYear();
  // Find the highest sequence number already used for this prefix/year by
  // parsing every matching invoice_no — a plain ORDER BY id DESC is unsafe
  // because invoice rows for past years may have been inserted later.
  const rows = db.prepare(`
    SELECT invoice_no FROM invoices WHERE invoice_no LIKE ?
  `).all(`${prefix}/${year}/%`);
  let max = 0;
  for (const r of rows) {
    const m = r.invoice_no.match(/\/(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}/${year}/${String(max + 1).padStart(4, '0')}`;
}

/**
 * Persist preview as a saved invoice. Marks source entries invoice_id and status.
 * fx_rate: how many INR = 1 foreign currency unit (e.g. 84.50 means 1 USD = 84.50 INR)
 * save_as_draft: if true, invoice status = 'draft'; entries get invoice_id but remain 'approved'
 */
function createInvoice({ client_id, invoice_date, due_date, period_from, period_to, tax_rate, notes, currency, fx_rate, tax_type, firm_entity, save_as_draft, created_by, invoice_no: customInvoiceNo, items: customItems, discount_amount, discount_type, discount_note, reverse_charge }) {
  // Two modes:
  //   1. customItems provided  → user edited the preview before issuing. Use
  //      exactly what they sent (already in destination currency — front-end
  //      shows rates as-is). source_entry_ids on each item still get linked
  //      to the new invoice; any timesheet entries the user removed from the
  //      preview simply don't get marked invoiced and stay billable for next time.
  //   2. customItems missing   → auto-derive from approved+billable entries,
  //      then apply currency conversion server-side (legacy behaviour).
  let workingItems;
  if (Array.isArray(customItems) && customItems.length) {
    workingItems = customItems.map(it => ({
      matter_id:        it.matter_id || null,
      user_id:          it.user_id   || null,
      description:      String(it.description || '').trim(),
      quantity:         Number(it.quantity || 0),
      unit:             it.unit || 'hr',
      rate:             round2(Number(it.rate   || 0)),
      amount:           round2(Number(it.amount || 0)),
      source_entry_ids: Array.isArray(it.source_entry_ids) ? it.source_entry_ids : []
    }));
  } else {
    const preview = buildInvoicePreview({ client_id, from: period_from, to: period_to });
    if (!preview.items.length) {
      const err = new Error('No billable items in this period');
      err.status = 400; throw err;
    }
    // Apply exchange rate conversion only when auto-deriving — when the user
    // sends custom items, the rates they typed are already in the target currency.
    const fxRate = (currency && currency !== 'INR' && fx_rate && fx_rate > 0) ? Number(fx_rate) : 1;
    workingItems = preview.items.map(it => ({
      ...it,
      rate:   round2(it.rate   / fxRate),
      amount: round2(it.amount / fxRate)
    }));
  }

  if (!workingItems.length) {
    const err = new Error('No line items to invoice');
    err.status = 400; throw err;
  }

  const cur = currency || process.env.DEFAULT_CURRENCY || 'INR';
  const subtotal = round2(workingItems.reduce((s, i) => s + i.amount, 0));

  // Discount can be flat ₹ or % of subtotal. Resulting amount stored alongside
  // type so the PDF can render it correctly. Clamp to [0, subtotal] so we never
  // produce a negative payable.
  const dType = (discount_type === 'percent') ? 'percent' : 'flat';
  const dInput = Math.max(0, Number(discount_amount) || 0);
  const discountValue = round2(
    dType === 'percent' ? subtotal * dInput / 100 : Math.min(dInput, subtotal)
  );
  const discountedSub = round2(Math.max(0, subtotal - discountValue));

  // For foreign currency: GST = 0 (export of services); force 0 if not INR.
  // Tax is computed on the DISCOUNTED subtotal (post-discount) since the
  // discount represents a price reduction agreed with the client.
  const taxRate   = cur !== 'INR' ? 0 : (tax_rate == null ? 0 : Number(tax_rate));
  const taxAmount = round2(discountedSub * (taxRate / 100));
  // Reverse Charge (GST RCM) toggle — default true (legacy behaviour).
  //   Yes → firm bills only the (discounted) service fee; client pays GST to govt.
  //   No  → firm collects GST → total = discounted subtotal + tax.
  const reverseChargeFlag = (reverse_charge === undefined || reverse_charge === null)
                            ? 1 : (reverse_charge ? 1 : 0);
  const total     = round2(reverseChargeFlag ? discountedSub : (discountedSub + taxAmount));
  // Allow caller (admin) to override the auto-generated number. Blank/undefined
  // falls back to the next sequence. UNIQUE constraint on invoice_no will
  // surface a clear 409 at the route layer if the caller picked a duplicate.
  const invoice_no = (customInvoiceNo && String(customInvoiceNo).trim())
    ? String(customInvoiceNo).trim()
    : nextInvoiceNumber();
  const invStatus  = save_as_draft ? 'draft' : 'issued';

  const tx = db.transaction(() => {
    const inv = db.prepare(`
      INSERT INTO invoices
        (invoice_no, client_id, invoice_date, due_date, period_from, period_to,
         subtotal, tax_rate, tax_amount, total, currency, notes, created_by, status, tax_type, firm_entity,
         discount_amount, discount_type, discount_note, reverse_charge)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoice_no, client_id, invoice_date, due_date || null,
      period_from, period_to,
      subtotal, taxRate, taxAmount, total,
      cur,
      notes || null, created_by,
      invStatus,
      tax_type || null,
      firm_entity || 'delhi',
      discountValue, dType, discount_note || null,
      reverseChargeFlag
    );
    const invoiceId = inv.lastInsertRowid;

    const itemStmt = db.prepare(`
      INSERT INTO invoice_items
        (invoice_id, matter_id, user_id, description, quantity, unit, rate, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (save_as_draft) {
      // Draft: reserve entries (assign invoice_id) but keep status='approved' so they show as pending
      const reserveEntry = db.prepare(`
        UPDATE timesheet_entries SET invoice_id = ? WHERE id = ?
      `);
      for (const it of workingItems) {
        itemStmt.run(invoiceId, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
        for (const eid of (it.source_entry_ids || [])) reserveEntry.run(invoiceId, eid);
      }
    } else {
      const updEntry = db.prepare(`
        UPDATE timesheet_entries SET status = 'invoiced', invoice_id = ? WHERE id = ?
      `);
      for (const it of workingItems) {
        itemStmt.run(invoiceId, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
        for (const eid of (it.source_entry_ids || [])) updEntry.run(invoiceId, eid);
      }
    }
    return invoiceId;
  });

  const invoiceId = tx();
  return {
    id: invoiceId, invoice_no, subtotal,
    discount_amount: discountValue, discount_type: dType, discount_note: discount_note || null,
    tax_amount: taxAmount, total,
    items: workingItems
  };
}

module.exports = { buildInvoicePreview, createInvoice, nextInvoiceNumber };
