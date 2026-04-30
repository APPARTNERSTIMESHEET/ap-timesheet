const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, m.title AS matter_title, m.file_no, u.full_name
    FROM rate_cards r
    JOIN matters m ON m.id = r.matter_id
    JOIN users u   ON u.id = r.user_id
    ORDER BY m.file_no, u.full_name
  `).all();
  res.json({ rates: rows });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const { matter_id, user_id, hourly_rate, effective_from } = req.body || {};
  if (!matter_id || !user_id || hourly_rate == null) {
    return res.status(400).json({ error: 'matter_id, user_id, hourly_rate required' });
  }
  try {
    const info = db.prepare(
      `INSERT INTO rate_cards (matter_id, user_id, hourly_rate, effective_from)
       VALUES (?, ?, ?, COALESCE(?, date('now')))`
    ).run(matter_id, user_id, hourly_rate, effective_from || null);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'rate already exists for that date' });
    throw e;
  }
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  db.prepare('DELETE FROM rate_cards WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

module.exports = router;
