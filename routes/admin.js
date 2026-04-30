const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.post('/timesheet/:id/approve', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE timesheet_entries
       SET status = 'approved', approved_by = ?, approved_at = datetime('now'), rejection_note = NULL
     WHERE id = ?
  `).run(req.user.id, id);
  res.json({ ok: true });
});

router.post('/timesheet/:id/reject', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const note = (req.body && req.body.note) || null;
  db.prepare(`
    UPDATE timesheet_entries
       SET status = 'rejected', approved_by = ?, approved_at = datetime('now'), rejection_note = ?
     WHERE id = ?
  `).run(req.user.id, note, id);
  res.json({ ok: true });
});

router.post('/timesheet/bulk-approve', authRequired, adminOnly, (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });
  const stmt = db.prepare(`
    UPDATE timesheet_entries SET status='approved', approved_by=?, approved_at=datetime('now')
     WHERE id = ? AND status IN ('submitted','draft','rejected')
  `);
  const tx = db.transaction((arr) => arr.forEach(id => stmt.run(req.user.id, id)));
  tx(ids);
  res.json({ ok: true, count: ids.length });
});

router.get('/dashboard', authRequired, adminOnly, (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM timesheet_entries WHERE status = 'submitted'").get().c,
    draft:   db.prepare("SELECT COUNT(*) AS c FROM timesheet_entries WHERE status = 'draft'").get().c,
    approved: db.prepare("SELECT COUNT(*) AS c FROM timesheet_entries WHERE status IN ('approved','invoiced')").get().c,
    today_hours: db.prepare("SELECT COALESCE(SUM(hours),0) AS h FROM timesheet_entries WHERE entry_date = ?").get(today).h,
    month_hours: db.prepare("SELECT COALESCE(SUM(hours),0) AS h FROM timesheet_entries WHERE entry_date >= ?").get(monthStart).h,
    month_billable_hours: db.prepare(
      "SELECT COALESCE(SUM(hours),0) AS h FROM timesheet_entries WHERE entry_date >= ? AND is_billable = 1"
    ).get(monthStart).h,
    active_users: db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_active = 1 AND role = 'associate'").get().c,
    open_matters: db.prepare("SELECT COUNT(*) AS c FROM matters WHERE status = 'open'").get().c,
    open_invoices: db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE status = 'issued'").get().c,
    invoiced_total_month: db.prepare(
      "SELECT COALESCE(SUM(total),0) AS t FROM invoices WHERE invoice_date >= ?"
    ).get(monthStart).t
  };
  res.json(counts);
});

module.exports = router;
