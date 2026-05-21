const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', authRequired, adminOnly, (req, res) => {
  const { from, to, group_by } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const validGroup = ['user','client','matter','activity'];
  const g = validGroup.includes(group_by) ? group_by : 'user';

  const groupExpr = {
    user:     'u.full_name',
    client:   'c.name',
    matter:   "m.file_no || ' — ' || m.title",
    activity: 't.activity_type'
  }[g];

  const rows = db.prepare(`
    SELECT ${groupExpr} AS label,
           SUM(t.hours) AS hours,
           SUM(CASE WHEN t.is_billable = 1 THEN t.hours ELSE 0 END) AS billable_hours,
           COUNT(*) AS entry_count
    FROM timesheet_entries t
    JOIN users u   ON u.id = t.user_id
    JOIN clients c ON c.id = t.client_id
    JOIN matters m ON m.id = t.matter_id
    WHERE t.entry_date BETWEEN ? AND ?
    GROUP BY ${groupExpr}
    ORDER BY hours DESC
  `).all(from, to);
  res.json({ from, to, group_by: g, rows });
});

router.get('/by-user', authRequired, adminOnly, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from, to required' });
  const rows = db.prepare(`
    SELECT u.id, u.full_name,
           SUM(t.hours) AS total_hours,
           SUM(CASE WHEN t.is_billable = 1 THEN t.hours ELSE 0 END) AS billable_hours
    FROM users u
    LEFT JOIN timesheet_entries t
      ON t.user_id = u.id AND t.entry_date BETWEEN ? AND ?
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY u.full_name
  `).all(from, to);
  res.json({ rows });
});



// ─── Matter profitability ─────────────────────────────────────────────────────
router.get('/profitability', authRequired, adminOnly, (req, res) => {
  const { from, to, client_id } = req.query;
  const conds = ["te.status IN ('approved','invoiced')"];
  const params = [];
  if (from) { conds.push('te.entry_date >= ?'); params.push(from); }
  if (to)   { conds.push('te.entry_date <= ?'); params.push(to); }
  if (client_id) { conds.push('te.client_id = ?'); params.push(client_id); }
  const where = `WHERE ${conds.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      c.name  AS client_name,
      m.title AS matter_title,
      m.file_no,
      COALESCE(SUM(te.hours), 0) AS hours,
      COALESCE(SUM(ii.amount), 0) AS billed_amount
    FROM timesheet_entries te
    JOIN clients c ON c.id = te.client_id
    JOIN matters m ON m.id = te.matter_id
    LEFT JOIN invoice_items ii ON ii.matter_id = m.id
    ${where}
    GROUP BY te.client_id, te.matter_id
    ORDER BY billed_amount DESC
  `).all(...params);

  res.json({ rows });
});

module.exports = router;
