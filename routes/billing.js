const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { buildInvoicePreview, createInvoice } = require('../utils/billing');
const { streamInvoicePDF } = require('../utils/invoice-pdf');

const router = express.Router();

router.get('/preview', authRequired, adminOnly, (req, res) => {
  const { client_id, from, to } = req.query;
  if (!client_id || !from || !to) return res.status(400).json({ error: 'client_id, from, to required' });
  const data = buildInvoicePreview({ client_id: parseInt(client_id, 10), from, to });
  res.json(data);
});

router.post('/invoices', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.invoice_date || !b.period_from || !b.period_to) {
    return res.status(400).json({ error: 'client_id, invoice_date, period_from, period_to required' });
  }
  try {
    const out = createInvoice({
      client_id: parseInt(b.client_id, 10),
      invoice_date: b.invoice_date,
      period_from: b.period_from,
      period_to: b.period_to,
      tax_rate: b.tax_rate,
      currency: b.currency,
      notes: b.notes,
      created_by: req.user.id
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/invoices', authRequired, adminOnly, (req, res) => {
  const { client_id, status, from, to } = req.query;
  const conds = []; const params = [];
  if (client_id) { conds.push('i.client_id = ?'); params.push(client_id); }
  if (status)    { conds.push('i.status = ?'); params.push(status); }
  if (from)      { conds.push('i.invoice_date >= ?'); params.push(from); }
  if (to)        { conds.push('i.invoice_date <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON c.id = i.client_id
    ${where}
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all(...params);
  res.json({ invoices: rows });
});

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

router.get('/invoices/:id/pdf', authRequired, adminOnly, (req, res) => {
  streamInvoicePDF(parseInt(req.params.id, 10), res);
});

router.patch('/invoices/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, notes } = req.body || {};
  if (status && !['draft','issued','paid','cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  const fields = []; const values = [];
  if (status) { fields.push('status = ?'); values.push(status); }
  if (notes != null) { fields.push('notes = ?'); values.push(notes); }
  if (status === 'paid') { fields.push("paid_at = datetime('now')"); }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // If cancelled, free up the entries so they can be re-billed
  if (status === 'cancelled') {
    db.prepare(`
      UPDATE timesheet_entries SET status = 'approved', invoice_id = NULL
       WHERE invoice_id = ?
    `).run(id);
  }
  res.json({ ok: true });
});

module.exports = router;
