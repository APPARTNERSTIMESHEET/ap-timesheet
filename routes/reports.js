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

module.exports = router;
