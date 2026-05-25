const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly, superAdminOnly, notifyAdminsOfBillingAction } = require('../middleware/auth');
const { buildInvoicePreview, createInvoice } = require('../utils/billing');
const { streamInvoicePDF } = require('../utils/invoice-pdf');
const { generateLEDES1998B, generateLEDES1998BI, generateLEDESXML21, validateLEDES } = require('../utils/ledes-export');
const { writeAuditLog } = require('../middleware/auth');
const path = require('path');

const router = express.Router();

// ─── Review workflow stages (only meaningful while invoice.status='draft') ────
// drafting        -> billing still preparing, nothing sent out
// sent_for_review -> printed/PDF handed to partner/associate, awaiting feedback
// revisions_pending -> reviewer marked changes on paper, billing updating now
// ready_to_issue  -> reviewer approved, just waiting for final issue click
const REVIEW_STAGES = ['drafting','sent_for_review','revisions_pending','ready_to_issue'];

// ─── Preview ──────────────────────────────────────────────────────────────────
router.get('/preview', authRequired, adminOnly, (req, res) => {
  const { client_id, from, to } = req.query;
  if (!client_id || !from || !to) return res.status(400).json({ error: 'client_id, from, to required' });
  const data = buildInvoicePreview({ client_id: parseInt(client_id, 10), from, to });
  res.json(data);
});

// ─── Create invoice ───────────────────────────────────────────────────────────
router.post('/invoices', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.invoice_date || !b.period_from || !b.period_to) {
    return res.status(400).json({ error: 'client_id, invoice_date, period_from, period_to required' });
  }
  try {
    const out = createInvoice({
      client_id: parseInt(b.client_id, 10),
      invoice_date: b.invoice_date,
      due_date: b.due_date || null,
      period_from: b.period_from,
      period_to: b.period_to,
      tax_rate: b.tax_rate,
      currency: b.currency,
      fx_rate: parseFloat(b.fx_rate) || 1,
      notes: b.notes,
      tax_type: b.tax_type || null,
      firm_entity: b.firm_entity || 'delhi',
      save_as_draft: !!b.save_as_draft,
      created_by: req.user.id,
      invoice_no: b.invoice_no || null,
      // Optional: client-edited line items from the editable preview. When
      // present, server uses them as-is instead of re-deriving from timesheets.
      items: Array.isArray(b.items) ? b.items : null,
      discount_amount: b.discount_amount,
      discount_type:   b.discount_type,
      discount_note:   b.discount_note || null,
      // Reverse charge (GST RCM) — default true (existing behaviour). If false,
      // firm collects tax and grand total = subtotal + tax.
      reverse_charge: (b.reverse_charge === undefined || b.reverse_charge === null) ? 1
                      : (b.reverse_charge ? 1 : 0)
    });
    const action = b.save_as_draft ? 'Draft Invoice Saved' : 'Invoice Created';
    notifyAdminsOfBillingAction(req, action, `Invoice ${out.invoice_no} · Total: ${out.total} ${b.currency||'INR'}`);
    res.json(out);
  } catch (e) {
    if (String(e.message || e).match(/UNIQUE.*invoice_no/i)) {
      return res.status(409).json({ error: `Invoice number "${b.invoice_no}" is already used. Pick a different one or leave blank to auto-generate.` });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── Create manual invoice (custom line items, no timesheet entries) ──────────
router.post('/invoices/manual', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.invoice_date || !b.items || !b.items.length) {
    return res.status(400).json({ error: 'client_id, invoice_date, and at least one item required' });
  }
  try {
    const { nextInvoiceNumber } = require('../utils/billing');
    const round2 = n => Math.round(n * 100) / 100;

    const cur = b.currency || process.env.DEFAULT_CURRENCY || 'INR';
    const fxRate = (cur !== 'INR' && b.fx_rate && b.fx_rate > 0) ? Number(b.fx_rate) : 1;

    const items = b.items.map(it => ({
      description: it.description || '',
      hsn_code:    it.hsn_code    || '9982',
      quantity:    Number(it.quantity  || 1),
      unit:        it.unit        || 'lot',
      rate:        round2(Number(it.rate   || 0) / fxRate),
      amount:      round2(Number(it.amount || 0) / fxRate),
      matter_id:   it.matter_id   || null,
      user_id:     null
    }));

    const subtotal  = round2(items.reduce((s, i) => s + i.amount, 0));
    const taxRate   = cur !== 'INR' ? 0 : Number(b.tax_rate || 0);
    const taxAmount = round2(subtotal * (taxRate / 100));
    // Reverse Charge flag — default true (existing behaviour). Yes → total = subtotal
    // (tax payable by client directly). No → firm collects tax → total = subtotal + tax.
    const reverseCharge = (b.reverse_charge === undefined || b.reverse_charge === null)
                          ? 1 : (b.reverse_charge ? 1 : 0);
    const total     = round2(reverseCharge ? subtotal : (subtotal + taxAmount));
    const invoice_no = (b.invoice_no && b.invoice_no.trim()) ? b.invoice_no.trim() : nextInvoiceNumber();

    const tx = db.transaction(() => {
      const inv = db.prepare(`
        INSERT INTO invoices
          (invoice_no, client_id, invoice_date, due_date, period_from, period_to,
           subtotal, tax_rate, tax_amount, total, currency, notes, created_by, status, tax_type,
           state_name, state_code, firm_entity, reverse_charge)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?)
      `).run(
        invoice_no, parseInt(b.client_id, 10), b.invoice_date, b.due_date || null,
        b.period_from || b.invoice_date, b.period_to || b.invoice_date,
        subtotal, taxRate, taxAmount, total, cur,
        b.notes || null, req.user.id, b.tax_type || null,
        b.state_name || null, b.state_code || null, b.firm_entity || 'delhi',
        reverseCharge
      );
      const invoiceId = inv.lastInsertRowid;
      const itemStmt = db.prepare(`
        INSERT INTO invoice_items
          (invoice_id, matter_id, user_id, description, quantity, unit, rate, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of items) {
        itemStmt.run(invoiceId, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
      }
      return invoiceId;
    });

    const invoiceId = tx();
    notifyAdminsOfBillingAction(req, 'Manual Invoice Created', `Invoice ${invoice_no} · Total: ${total} ${cur}`);
    res.json({ id: invoiceId, invoice_no, subtotal, tax_amount: taxAmount, total });
  } catch (e) {
    if (String(e.message || e).match(/UNIQUE.*invoice_no/i)) {
      return res.status(409).json({ error: `Invoice number "${b.invoice_no}" is already used. Pick a different one or leave blank to auto-generate.` });
    }
    console.error('Manual invoice error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── 🛑 SUPER-ADMIN: Hard-delete an invoice ──────────────────────────────────
// Bypasses the firm-wide no-hard-delete policy. ONLY accessible to super_admin.
// Use cases: cleanup of test invoices, accidental duplicates, GDPR/legitimate
// erasure requests. Removes: invoice row, invoice_items rows, ledes_exports rows.
// Releases any timesheet entries that were linked to this invoice.
// Preserves: audit_log entries (so the destruction itself is traceable).
//
// Requires body { confirm: 'DELETE', reason: '...' } to prevent accidental
// fat-finger deletes via the API.
router.delete('/invoices/:id', authRequired, superAdminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b  = req.body || {};

  if (b.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required. Send body { "confirm":"DELETE", "reason":"..." } to proceed.' });
  }

  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  // Snapshot the invoice + line items so the audit log preserves enough
  // detail to reconstruct the deleted record if ever needed.
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(id);
  const snapshot = {
    invoice: inv,
    items,
    deleted_by: { id: req.user.id, email: req.user.email, role: req.user.role_code },
    deleted_at: new Date().toISOString(),
    reason: (b.reason || '').toString().slice(0, 500) || '(no reason given)'
  };

  const tx = db.transaction(() => {
    // Release timesheet entries linked to this invoice (back to approved/free)
    const released = db.prepare(`
      UPDATE timesheet_entries
      SET status = CASE WHEN status = 'invoiced' THEN 'approved' ELSE status END,
          invoice_id = NULL
      WHERE invoice_id = ?
    `).run(id).changes;

    let ledesCount = 0;
    try {
      ledesCount = db.prepare('DELETE FROM ledes_exports WHERE invoice_id = ?').run(id).changes;
    } catch(_) { /* table may not exist */ }

    const itemCount = db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id).changes;
    const invCount  = db.prepare('DELETE FROM invoices WHERE id = ?').run(id).changes;

    // Audit BEFORE returning so the trail survives even if response is dropped.
    try {
      db.prepare(`
        INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
        VALUES (?, 'invoice_hard_deleted_super_admin', 'invoice', ?, ?)
      `).run(req.user.id, id, JSON.stringify({
        ...snapshot,
        counts: { items_deleted: itemCount, ledes_deleted: ledesCount, entries_released: released, invoice_deleted: invCount }
      }));
    } catch(_) {}

    return { items: itemCount, ledes: ledesCount, entries_released: released, invoice: invCount };
  });

  const r = tx();
  notifyAdminsOfBillingAction(req, 'Invoice HARD-DELETED (super-admin)',
    `${inv.invoice_no} · status was ${inv.status} · total was ${inv.currency || 'INR'} ${inv.total} · reason: ${snapshot.reason}`);
  res.json({
    ok: true,
    invoice_no: inv.invoice_no,
    deleted: r,
    message: `Invoice ${inv.invoice_no} hard-deleted. Action audit-logged.`
  });
});

// ─── List invoices ────────────────────────────────────────────────────────────
router.get('/invoices', authRequired, adminOnly, (req, res) => {
  const { client_id, status, from, to, review_stage } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const conds = []; const params = [];

  if (client_id) { conds.push('i.client_id = ?'); params.push(client_id); }
  if (from)      { conds.push('i.invoice_date >= ?'); params.push(from); }
  if (to)        { conds.push('i.invoice_date <= ?'); params.push(to); }

  // Special virtual status: overdue = issued + past due_date
  if (status === 'overdue') {
    conds.push("i.status = 'issued'");
    conds.push('i.due_date IS NOT NULL');
    conds.push('i.due_date < ?'); params.push(today);
  } else if (status) {
    conds.push('i.status = ?'); params.push(status);
  }

  // Review stage filter (only meaningful for drafts). Special value
  // "unassigned" = drafts that don't have any review_stage set yet.
  if (review_stage === 'unassigned') {
    conds.push("i.status = 'draft' AND (i.review_stage IS NULL OR i.review_stage = '')");
  } else if (review_stage) {
    conds.push('i.review_stage = ?'); params.push(review_stage);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT i.*, c.name AS client_name,
           u.full_name AS review_assignee_name
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN users u ON u.id = i.review_assignee
    ${where}
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all(...params);
  res.json({ invoices: rows });
});

// ─── Review history for a single invoice (audit trail) ───────────────────────
router.get('/invoices/:id/review-history', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = db.prepare(`
    SELECT a.id, a.action, a.detail, a.at,
           u.full_name AS user_name, u.role AS user_role
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity = 'invoice' AND a.entity_id = ?
      AND a.action IN ('review_stage_changed','Invoice Created','Draft Invoice Saved',
                       'Draft Invoice Issued','Manual Invoice Created',
                       'Invoice Status Changed to "draft"','Invoice Status Changed to "issued"',
                       'Invoice Status Changed to "paid"','Invoice Status Changed to "cancelled"')
    ORDER BY a.id DESC
  `).all(id);
  res.json({ history: rows });
});

// ─── Get single invoice ───────────────────────────────────────────────────────
router.get('/invoices/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inv = db.prepare(`
    SELECT i.*, c.name AS client_name, c.gstin AS client_gstin
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?
  `).get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(id);
  res.json({ invoice: inv, items });
});

// ─── PDF ──────────────────────────────────────────────────────────────────────
router.get('/invoices/:id/pdf', authRequired, adminOnly, (req, res) => {
  streamInvoicePDF(parseInt(req.params.id, 10), res);
});

// ─── Update status / payment / review stage ──────────────────────────────────
router.patch('/invoices/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, notes, payment_ref, review_stage, review_notes, review_assignee, invoice_no } = req.body || {};
  if (status && !['draft','issued','paid','cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (review_stage != null && review_stage !== '' && !REVIEW_STAGES.includes(review_stage)) {
    return res.status(400).json({ error: 'invalid review_stage (allowed: ' + REVIEW_STAGES.join(', ') + ')' });
  }
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  // invoice_no change is restricted to draft invoices — once issued, the number
  // is on file with the client / accounting system and must not drift.
  // Super-admin can override via admin_override:true in body, audit-logged.
  const actorRoleP = req.user.role_code || req.user.role;
  const isSuperAdminP = actorRoleP === 'super_admin';
  const overrideRequestedP = !!(req.body && req.body.admin_override);
  if (invoice_no != null && invoice_no !== '' && invoice_no !== inv.invoice_no) {
    if (inv.status !== 'draft' && !(isSuperAdminP && overrideRequestedP)) {
      return res.status(400).json({ error: 'Invoice number can only be changed while the invoice is a draft. Super-admin can override with admin_override:true.' });
    }
    const trimmed = String(invoice_no).trim();
    if (!trimmed) return res.status(400).json({ error: 'Invoice number cannot be blank.' });
    if (inv.status !== 'draft' && isSuperAdminP && overrideRequestedP) {
      try {
        db.prepare(`
          INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
          VALUES (?, 'invoice_no_changed_super_admin_override', 'invoice', ?, ?)
        `).run(req.user.id, id, `${inv.invoice_no} -> ${trimmed} (status=${inv.status})`);
      } catch(_) {}
    }
  }
  // Review fields only make sense while invoice is a draft. Allow setting on
  // non-draft only to clear (so audit/history can be preserved when issued).
  if (review_stage && inv.status !== 'draft' && status !== 'draft') {
    return res.status(400).json({ error: 'review_stage only applies to draft invoices' });
  }

  const fields = []; const values = [];
  if (status)       { fields.push('status = ?'); values.push(status); }
  if (notes != null){ fields.push('notes = ?'); values.push(notes); }
  if (payment_ref != null) { fields.push('payment_ref = ?'); values.push(payment_ref); }
  if (invoice_no != null && invoice_no !== '' && String(invoice_no).trim() !== inv.invoice_no) {
    fields.push('invoice_no = ?'); values.push(String(invoice_no).trim());
  }
  // Sync paid_at with status: set on transition INTO paid, clear on transition OUT of paid
  if (status === 'paid' && inv.status !== 'paid')      { fields.push("paid_at = datetime('now')"); }
  else if (status && status !== 'paid' && inv.status === 'paid') { fields.push('paid_at = NULL'); }
  // Review tracking
  let stageChanged = false;
  if (review_stage !== undefined) {
    fields.push('review_stage = ?'); values.push(review_stage || null);
    fields.push("review_updated_at = datetime('now')");
    stageChanged = (review_stage || null) !== (inv.review_stage || null);
  }
  if (review_notes !== undefined) {
    fields.push('review_notes = ?'); values.push(review_notes || null);
  }
  if (review_assignee !== undefined) {
    fields.push('review_assignee = ?');
    values.push(review_assignee ? parseInt(review_assignee, 10) : null);
  }
  // Clear review state when the invoice leaves draft (issued/cancelled/paid)
  if (status && status !== 'draft' && inv.status === 'draft') {
    fields.push('review_stage = NULL');
    fields.push("review_updated_at = datetime('now')");
  }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  try {
    db.prepare(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  } catch (e) {
    if (String(e.message || e).match(/UNIQUE.*invoice_no/i)) {
      return res.status(409).json({ error: `Invoice number "${invoice_no}" is already in use.` });
    }
    throw e;
  }

  // Audit invoice_no changes — easy to trace if the firm ever needs to explain
  // why a particular draft was renumbered before issue.
  if (invoice_no != null && String(invoice_no).trim() !== inv.invoice_no) {
    try {
      db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)").run(
        req.user.id, 'invoice_no_changed', 'invoice', id,
        `${inv.invoice_no} -> ${String(invoice_no).trim()}`
      );
    } catch(e) { /* non-blocking */ }
  }

  // Audit trail: any review stage change gets its own audit_log row so we can
  // reconstruct who-changed-what-when later, even after the invoice is issued.
  if (stageChanged) {
    try {
      db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)").run(
        req.user.id,
        'review_stage_changed',
        'invoice',
        id,
        `${inv.review_stage || '(none)'} -> ${review_stage || '(none)'}` + (review_notes ? ` · "${String(review_notes).slice(0, 120)}"` : '')
      );
    } catch(e) { /* non-blocking */ }
  }

  if (status === 'cancelled') {
    // Drafts reserve entries as 'approved'; issued invoices lock them as 'invoiced'.
    // When cancelling, restore entries to 'approved' (they were already approved before invoicing) —
    // not 'submitted', which would discard the prior approval audit trail.
    if (inv.status === 'draft') {
      db.prepare(`UPDATE timesheet_entries SET invoice_id = NULL WHERE invoice_id = ?`).run(id);
    } else {
      db.prepare(`UPDATE timesheet_entries SET status = 'approved', invoice_id = NULL WHERE invoice_id = ?`).run(id);
    }
  }
  if (status) {
    notifyAdminsOfBillingAction(req, `Invoice Status Changed to "${status}"`, `Invoice ID: ${id}${payment_ref ? ' · Ref: ' + payment_ref : ''}`);
  }
  res.json({ ok: true });
});

// ─── Edit draft invoice line items ───────────────────────────────────────────
router.put('/invoices/:id/items', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  // Standard rule: only draft invoices can be edited (preserves audit trail
  // and matches GST Sec 31 — issued invoices must not be silently modified).
  // Super-admin escape hatch: allows editing any invoice with heavy audit
  // logging — for genuine correction scenarios where the firm decides this
  // override is acceptable. Body must include admin_override:true.
  const actorRole = req.user.role_code || req.user.role;
  const isSuperAdmin = actorRole === 'super_admin';
  const overrideRequested = !!(req.body && req.body.admin_override);
  if (inv.status !== 'draft') {
    if (!isSuperAdmin || !overrideRequested) {
      return res.status(400).json({ error: 'Only draft invoices can be edited. Super-admin can override by passing admin_override:true.' });
    }
    // Audit the override before doing anything
    try {
      const snapshot = {
        before: { status: inv.status, subtotal: inv.subtotal, total: inv.total, paid_at: inv.paid_at, invoice_no: inv.invoice_no },
        reason: (req.body.override_reason || '').slice(0, 500) || '(no reason provided)'
      };
      db.prepare(`
        INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
        VALUES (?, 'invoice_edit_super_admin_override', 'invoice', ?, ?)
      `).run(req.user.id, id, JSON.stringify(snapshot));
    } catch(_) {}
  }

  const b = req.body || {};
  const items = b.items;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one item required' });

  const round2 = n => Math.round(n * 100) / 100;
  const cur = inv.currency || 'INR';
  const taxRate = Number(inv.tax_rate || 0);

  const mappedItems = items.map(it => ({
    description: it.description || '',
    matter_id:   it.matter_id   || null,
    user_id:     it.user_id     || null,
    quantity:    Number(it.quantity || 1),
    unit:        it.unit        || 'lot',
    rate:        round2(Number(it.rate   || 0)),
    amount:      round2(Number(it.amount || 0))
  }));

  // Discount can be flat ₹ or % of subtotal. Honour what the client sends;
  // fall back to the previously-saved values on the invoice.
  const dType = (b.discount_type === 'percent') ? 'percent'
              : (b.discount_type === 'flat')    ? 'flat'
              : (inv.discount_type || 'flat');
  const dInputRaw = (b.discount_amount != null) ? b.discount_amount : inv.discount_amount;
  const dInput = Math.max(0, Number(dInputRaw) || 0);

  const subtotal  = round2(mappedItems.reduce((s, i) => s + i.amount, 0));
  const discountValue = round2(
    dType === 'percent' ? subtotal * dInput / 100 : Math.min(dInput, subtotal)
  );
  const discountedSub = round2(Math.max(0, subtotal - discountValue));
  const taxAmount = round2(discountedSub * (taxRate / 100));
  // Reverse Charge flag — accept on edit if sent, else preserve invoice's current value.
  // 1 → total = discountedSub. 0 → total = discountedSub + taxAmount.
  const reverseChargeFlag = (b.reverse_charge === undefined || b.reverse_charge === null)
                            ? (inv.reverse_charge == null ? 1 : inv.reverse_charge)
                            : (b.reverse_charge ? 1 : 0);
  const total     = round2(reverseChargeFlag ? discountedSub : (discountedSub + taxAmount));

  const tx = db.transaction(() => {
    // Replace all items
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    const stmt = db.prepare(`
      INSERT INTO invoice_items (invoice_id, matter_id, user_id, description, quantity, unit, rate, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of mappedItems) {
      stmt.run(id, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
    }
    // Update invoice totals + discount fields
    db.prepare(`
      UPDATE invoices SET subtotal = ?, tax_amount = ?, total = ?,
        tax_rate = ?, invoice_date = ?, due_date = ?, notes = ?,
        discount_amount = ?, discount_type = ?, discount_note = ?,
        reverse_charge = ?
      WHERE id = ?
    `).run(subtotal, taxAmount, total, taxRate,
      b.invoice_date || inv.invoice_date,
      b.due_date || inv.due_date || null,
      b.notes != null ? b.notes : inv.notes,
      discountValue, dType,
      b.discount_note != null ? b.discount_note : inv.discount_note,
      reverseChargeFlag,
      id);
  });
  tx();
  res.json({ ok: true, subtotal, tax_amount: taxAmount, total });
});

// ─── Quick stage transition (convenience wrapper around PATCH) ──────────────
// Lets the frontend post just { stage: 'sent_for_review' } without having to
// also pass the no-op fields. Notes are optional but recommended ("printed and
// handed to RK", "RKM returned with markups", etc.).
router.post('/invoices/:id/review-stage', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { stage, note, assignee_id } = req.body || {};
  if (!REVIEW_STAGES.includes(stage)) {
    return res.status(400).json({ error: 'stage must be one of: ' + REVIEW_STAGES.join(', ') });
  }
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'review_stage only applies to draft invoices' });

  // Build the UPDATE dynamically based on which optional fields were sent
  const upd = []; const vals = [];
  upd.push('review_stage = ?'); vals.push(stage);
  upd.push("review_updated_at = datetime('now')");
  if (note != null)        { upd.push('review_notes = ?'); vals.push(note); }
  if (assignee_id != null) { upd.push('review_assignee = ?'); vals.push(assignee_id ? parseInt(assignee_id, 10) : null); }
  vals.push(id);
  db.prepare(`UPDATE invoices SET ${upd.join(', ')} WHERE id = ?`).run(...vals);

  try {
    db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)").run(
      req.user.id, 'review_stage_changed', 'invoice', id,
      `${inv.review_stage || '(none)'} -> ${stage}` + (note ? ` · "${String(note).slice(0, 120)}"` : '')
    );
  } catch(e) { /* non-blocking */ }

  res.json({ ok: true, stage });
});

// ─── Revise an issued invoice (one-click cancel + recreate as draft) ────────
// Standard law-firm workflow for "we noticed an issue after issuing": this
// cancels the existing invoice (preserving it in the audit trail) and copies
// all line items + linked entries into a fresh draft so billing can correct
// them and re-issue without manually re-entering everything.
//
// Rules:
//   - only `issued` invoices can be revised (paid/draft/cancelled refused)
//   - if invoice is already paid, you need a Credit Note instead (404 here)
//   - new draft gets a fresh invoice_no, links back via parent_invoice_id
router.post('/invoices/:id/revise', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inv = db.prepare(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ?
  `).get(id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'paid') {
    return res.status(400).json({ error: 'Paid invoices cannot be revised. Issue a Credit Note instead.' });
  }
  if (inv.status !== 'issued') {
    return res.status(400).json({ error: `Only issued invoices can be revised (this one is "${inv.status}")` });
  }

  const items = db.prepare(`
    SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id
  `).all(id);

  const { nextInvoiceNumber } = require('../utils/billing');
  const newNo = nextInvoiceNumber();

  const tx = db.transaction(() => {
    // 1. Mark the old invoice as cancelled (preserved for audit)
    db.prepare(`
      UPDATE invoices SET status = 'cancelled',
        notes = COALESCE(notes || char(10), '') || ?
      WHERE id = ?
    `).run(`[Revised to ${newNo} by ${req.user.full_name || req.user.email} at ${new Date().toISOString()}]`, id);

    // 2. Release the source entries from the old invoice (status → approved)
    db.prepare(`
      UPDATE timesheet_entries SET status = 'approved', invoice_id = NULL
      WHERE invoice_id = ?
    `).run(id);

    // 3. Create the new draft as a copy
    const newInv = db.prepare(`
      INSERT INTO invoices
        (invoice_no, client_id, invoice_date, due_date, period_from, period_to,
         subtotal, tax_rate, tax_amount, total, currency, notes, created_by, status,
         tax_type, state_name, state_code, firm_entity, parent_invoice_id, review_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 'drafting')
    `).run(
      newNo, inv.client_id,
      new Date().toISOString().slice(0,10),  // new invoice_date = today
      inv.due_date, inv.period_from, inv.period_to,
      inv.subtotal, inv.tax_rate, inv.tax_amount, inv.total,
      inv.currency,
      `Revision of cancelled invoice ${inv.invoice_no}` + (inv.notes ? ' · ' + inv.notes : ''),
      req.user.id,
      inv.tax_type, inv.state_name, inv.state_code, inv.firm_entity || 'delhi',
      id  // parent_invoice_id -> original
    );
    const newId = newInv.lastInsertRowid;

    // 4. Copy line items
    const copyStmt = db.prepare(`
      INSERT INTO invoice_items (invoice_id, matter_id, user_id, description, quantity, unit, rate, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      copyStmt.run(newId, it.matter_id, it.user_id, it.description, it.quantity, it.unit, it.rate, it.amount);
    }

    // 5. Re-link the entries to the new draft as reserved
    db.prepare(`
      UPDATE timesheet_entries SET invoice_id = ? WHERE id IN (
        SELECT id FROM timesheet_entries WHERE invoice_id IS NULL
          AND client_id = ?
          AND entry_date BETWEEN ? AND ?
          AND status = 'approved'
      )
    `).run(newId, inv.client_id, inv.period_from, inv.period_to);

    // 6. Audit log entries for both invoices
    const logStmt = db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)");
    logStmt.run(req.user.id, 'Invoice Revised', 'invoice', id, `Cancelled ${inv.invoice_no} → new draft ${newNo}`);
    logStmt.run(req.user.id, 'Draft Invoice Saved', 'invoice', newId, `Revision of ${inv.invoice_no}`);

    return { newId, newNo };
  });

  const out = tx();
  notifyAdminsOfBillingAction(req, 'Invoice Revised', `${inv.invoice_no} cancelled, new draft ${out.newNo} created`);
  res.json({ ok: true, original: { id, invoice_no: inv.invoice_no }, draft: { id: out.newId, invoice_no: out.newNo } });
});

// ─── Issue draft invoice (draft → issued) ────────────────────────────────────
router.post('/invoices/:id/issue', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'Invoice is not a draft' });

  const tx = db.transaction(() => {
    // Mark as issued
    db.prepare(`UPDATE invoices SET status = 'issued' WHERE id = ?`).run(id);
    // Lock timesheet entries that are assigned to this invoice
    db.prepare(`UPDATE timesheet_entries SET status = 'invoiced' WHERE invoice_id = ?`).run(id);
  });
  tx();

  notifyAdminsOfBillingAction(req, 'Draft Invoice Issued', `Invoice ID: ${id} · ${inv.invoice_no}`);
  res.json({ ok: true });
});

// ─── Email invoice ────────────────────────────────────────────────────────────
router.post('/invoices/:id/email', authRequired, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { to, cc, subject: customSubject, body: customBody } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Recipient email (to) required' });

  const inv = db.prepare(`
    SELECT i.*, c.name AS client_name FROM invoices i
    JOIN clients c ON c.id = i.client_id WHERE i.id = ?
  `).get(id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  try {
    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch(e) {
      return res.status(503).json({ error: 'Email not configured. Run: npm install nodemailer and configure SMTP in .env' });
    }

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass) {
      return res.status(503).json({ error: 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT in .env' });
    }

    // Generate PDF into buffer
    const PDFDocument = require('pdfkit');
    const { streamInvoicePDFToBuffer } = require('../utils/invoice-pdf');
    const pdfBuffer = await streamInvoicePDFToBuffer(id);

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: false,           // false for 587 (STARTTLS), true only for 465
      requireTLS: true,        // force STARTTLS — required by Office 365
      tls: { rejectUnauthorized: false },
      auth: { user: smtpUser, pass: smtpPass }
    });

    // Use admin-supplied subject + body if provided (from Compose Email modal),
    // otherwise fall back to the default invoice template.
    const subjectLine = (customSubject && customSubject.trim())
      ? customSubject.trim()
      : `Invoice ${inv.invoice_no} from AP & Partners`;
    const textBody = (customBody && customBody.trim())
      ? customBody
      : `Dear Client,\n\nPlease find attached invoice ${inv.invoice_no} for ${inv.client_name}.\nAmount: ${inv.currency} ${Number(inv.total).toLocaleString('en-IN', {minimumFractionDigits:2})}\n\nThank you for your business.\n\nAP & Partners\naccounts@appartners.in\nTel: +91 124 4891670`;

    await transporter.sendMail({
      from: `"AP & Partners" <${smtpFrom}>`,
      to,
      cc: (cc && String(cc).trim()) ? String(cc).trim() : undefined,
      subject: subjectLine,
      text: textBody,
      attachments: [{ filename: `${inv.invoice_no}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
    });

    // Log in audit
    try { db.prepare("INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)").run(req.user.id,'email_invoice','invoice',id,'Sent to: '+to); } catch(e){}
    res.json({ ok: true, message: `Invoice emailed to ${to}` });
  } catch (e) {
    console.error('Email send failed:', e.message);
    res.status(500).json({ error: 'Failed to send email: ' + e.message });
  }
});

// ─── Outstanding report ───────────────────────────────────────────────────────
router.get('/outstanding', authRequired, adminOnly, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = today.slice(0, 4) + '-01-01';
  const monthStart = today.slice(0, 7) + '-01';

  // Total outstanding (issued)
  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total
    FROM invoices WHERE status = 'issued'
  `).get();

  // Overdue invoices
  const overdue = db.prepare(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < ?
    ORDER BY i.due_date ASC
  `).all(today);

  const overdueAmount = overdue.reduce((s, r) => s + Number(r.total || 0), 0);

  // Paid this month
  const paidMonth = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total
    FROM invoices WHERE status = 'paid' AND paid_at >= ?
  `).get(monthStart);

  // Total billed YTD
  const ytd = db.prepare(`
    SELECT COALESCE(SUM(total),0) as total FROM invoices
    WHERE status IN ('issued','paid') AND invoice_date >= ?
  `).get(yearStart);

  // Client-wise outstanding
  const byClient = db.prepare(`
    SELECT c.name AS client_name, COUNT(*) as count,
           COALESCE(SUM(i.total),0) as total,
           MIN(i.due_date) as oldest_due
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued'
    GROUP BY i.client_id ORDER BY total DESC
  `).all();

  // Monthly revenue (last 6 months)
  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', invoice_date) AS month,
           COALESCE(SUM(CASE WHEN status IN ('issued','paid') THEN total ELSE 0 END),0) AS total_billed,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END),0) AS total_paid
    FROM invoices
    WHERE invoice_date >= date('now', '-6 months')
    GROUP BY month ORDER BY month ASC
  `).all();

  res.json({
    total_outstanding: totalRow.total,
    issued_count: totalRow.cnt,
    overdue,
    overdue_amount: overdueAmount,
    paid_this_month: paidMonth.total,
    paid_count_month: paidMonth.cnt,
    total_billed_ytd: ytd.total,
    by_client: byClient,
    monthly_revenue: monthlyRevenue
  });
});

// ─── Activity / Audit Log ─────────────────────────────────────────────────────
router.get('/activity', authRequired, adminOnly, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || 100), 500);
  const offset = parseInt(req.query.offset || 0);
  const user_id = req.query.user_id || null;

  const conds = []; const params = [];
  if (user_id) { conds.push('a.user_id = ?'); params.push(user_id); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.at,
           u.full_name AS user_name, u.role AS user_role
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM audit_log a ${where}`).get(...params);

  res.json({ log: rows, total: total.cnt });
});

// ─── LEDES Export ────────────────────────────────────────────────────────────
// Exports an invoice in LEDES format for upload to a corporate client's
// e-billing platform (Tymetrix 360, LegalTracker, Passport, etc.).
//
// Query parameter:  ?format=1998B | 1998BI | XML-2.1  (default 1998BI)
//
// Returns the file as a download with appropriate Content-Type. Every export
// is logged to ledes_exports and the audit_log for compliance traceability.
router.get('/invoices/:id/export-ledes', authRequired, (req, res) => {
  const invoiceId = parseInt(req.params.id, 10);
  const format = (req.query.format || '1998BI').toUpperCase();

  // Permission: billing role or admin/super_admin
  const role = req.user.role_code || req.user.role;
  if (!['admin', 'super_admin', 'billing'].includes(role)) {
    return res.status(403).json({ error: 'LEDES export requires billing/admin permission' });
  }

  // Verify invoice exists
  const inv = db.prepare('SELECT id, invoice_no, total, currency FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  // Optional ?style=short uses Tymetrix-style abbreviated field names
  // (e.g., LINE_ITEM_UNITS instead of LINE_ITEM_NUMBER_OF_UNITS). Required
  // by some validators (ledesshield.com) and certain client platforms.
  const style = (req.query.style || 'official').toLowerCase();
  const exportOpts = { style: style === 'short' ? 'short' : 'official' };

  let content, ext, mime;
  try {
    switch (format) {
      case '1998B':
        content = generateLEDES1998B(invoiceId, exportOpts);
        ext = 'txt'; mime = 'text/plain';
        break;
      case '1998BI':
      case 'INTERNATIONAL':
        content = generateLEDES1998BI(invoiceId, exportOpts);
        ext = 'txt'; mime = 'text/plain';
        break;
      case 'XML-2.1':
      case 'XML':
        content = generateLEDESXML21(invoiceId, exportOpts);
        ext = 'xml'; mime = 'application/xml';
        break;
      default:
        return res.status(400).json({ error: `Unsupported LEDES format: ${format}. Use 1998B, 1998BI, or XML-2.1` });
    }
  } catch (e) {
    console.error('[LEDES] export failed:', e);
    return res.status(500).json({ error: 'LEDES generation failed: ' + e.message });
  }

  // Audit
  const lineItemCount = db.prepare('SELECT COUNT(*) AS c FROM invoice_items WHERE invoice_id = ?').get(invoiceId).c;
  const filename = `LEDES-${inv.invoice_no.replace(/[^A-Za-z0-9_-]/g, '_')}-${format}.${ext}`;

  try {
    db.prepare(`
      INSERT INTO ledes_exports
        (invoice_id, format_version, filename, line_item_count, total_amount, currency, exported_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, format, filename, lineItemCount, inv.total, inv.currency || 'INR', req.user.id);
  } catch (e) { /* non-fatal */ }

  writeAuditLog(req, 'LEDES_EXPORT', 'invoice', invoiceId,
    `Format=${format}, lines=${lineItemCount}, total=${inv.currency || 'INR'} ${inv.total}`);

  // LEDES 1998B and 1998BI are strict 7-bit ASCII formats per spec. XML 2.0/2.1
  // is UTF-8. Set charset accordingly so picky parsers (ledesshield.com etc.)
  // accept the response. Content has already been sanitised to ASCII by
  // toAscii() in escapePipes — sending as us-ascii is safe.
  const charset = /^xml/i.test(format) ? 'utf-8' : 'us-ascii';
  res.setHeader('Content-Type', mime + '; charset=' + charset);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-LEDES-Format', format);
  // For non-XML LEDES, write the buffer as pure ASCII bytes so no UTF-8
  // multi-byte sequences accidentally leak through if upstream sanitising
  // missed something. Buffer.from('ascii') drops the high bit on each char.
  if (charset === 'us-ascii') {
    res.send(Buffer.from(content, 'ascii'));
  } else {
    res.send(content);
  }
});

// ─── LEDES Pre-Export Validation ─────────────────────────────────────────────
// Runs all sanity checks BEFORE generating the file so the billing team
// can fix issues without wasting a submission slot with the client.
// Returns ok=true if safe to export, plus errors[] (blocking) and warnings[].
router.get('/invoices/:id/validate-ledes', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (!['admin', 'super_admin', 'billing'].includes(role)) {
    return res.status(403).json({ error: 'Admin/billing only' });
  }
  const invoiceId = parseInt(req.params.id, 10);
  const format = (req.query.format || '1998BI').toUpperCase();
  try {
    const result = validateLEDES(invoiceId, format);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, errors: [{ code: 'SERVER_ERROR', msg: e.message }] });
  }
});

// ─── LEDES Export History ────────────────────────────────────────────────────
// Returns the export history for an invoice so the UI can show which formats
// have been exported when (audit trail for the billing team).
router.get('/invoices/:id/ledes-history', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (!['admin', 'super_admin', 'billing'].includes(role)) {
    return res.status(403).json({ error: 'Admin/billing only' });
  }
  const rows = db.prepare(`
    SELECT le.*, u.full_name AS exported_by_name
    FROM ledes_exports le
    LEFT JOIN users u ON u.id = le.exported_by
    WHERE le.invoice_id = ?
    ORDER BY le.exported_at DESC
  `).all(parseInt(req.params.id, 10));
  res.json({ history: rows });
});

// ─── UTBMS Code Lists (for admin UI dropdowns) ──────────────────────────────
router.get('/utbms/task-codes', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM utbms_task_codes WHERE is_active = 1 ORDER BY code').all();
  res.json({ codes: rows });
});
router.get('/utbms/activity-codes', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM utbms_activity_codes WHERE is_active = 1 ORDER BY code').all();
  res.json({ codes: rows });
});
router.get('/utbms/expense-codes', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM utbms_expense_codes WHERE is_active = 1 ORDER BY code').all();
  res.json({ codes: rows });
});

// ─── Activity → UTBMS Mapping CRUD (admin only) ──────────────────────────────
router.get('/utbms/mappings', authRequired, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, c.name AS client_name
    FROM activity_utbms_mapping m
    LEFT JOIN clients c ON c.id = m.client_id
    ORDER BY (m.client_id IS NOT NULL), c.name, m.activity_type
  `).all();
  res.json({ mappings: rows });
});

router.put('/utbms/mappings', authRequired, adminOnly, (req, res) => {
  const { activity_type, task_code, activity_code, client_id } = req.body || {};
  if (!activity_type) return res.status(400).json({ error: 'activity_type required' });

  // Validate codes exist (if provided)
  if (task_code) {
    const t = db.prepare('SELECT 1 FROM utbms_task_codes WHERE code = ?').get(task_code);
    if (!t) return res.status(400).json({ error: `Unknown UTBMS task code: ${task_code}` });
  }
  if (activity_code) {
    const a = db.prepare('SELECT 1 FROM utbms_activity_codes WHERE code = ?').get(activity_code);
    if (!a) return res.status(400).json({ error: `Unknown UTBMS activity code: ${activity_code}` });
  }

  // Upsert: replace existing mapping for (activity_type, client_id) tuple
  db.prepare('DELETE FROM activity_utbms_mapping WHERE activity_type = ? AND IFNULL(client_id,0) = IFNULL(?,0)')
    .run(activity_type, client_id || null);
  db.prepare(`
    INSERT INTO activity_utbms_mapping (activity_type, task_code, activity_code, client_id)
    VALUES (?, ?, ?, ?)
  `).run(activity_type, task_code || null, activity_code || null, client_id || null);

  writeAuditLog(req, 'UTBMS_MAPPING_UPDATE', 'mapping', null,
    `${activity_type} -> task=${task_code || '-'} activity=${activity_code || '-'} client_id=${client_id || 'global'}`);
  res.json({ ok: true });
});

module.exports = router;
