const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const { client_id } = req.query;
  let sql = `
    SELECT m.*, c.name AS client_name, c.code AS client_code
    FROM matters m
    JOIN clients c ON c.id = m.client_id
    WHERE m.status = 'open'
  `;
  const params = [];
  if (client_id) { sql += ' AND m.client_id = ?'; params.push(client_id); }
  sql += ' ORDER BY c.name, m.file_no';
  res.json({ matters: db.prepare(sql).all(...params) });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const m = req.body || {};
  if (!m.client_id || !m.file_no || !m.title) {
    return res.status(400).json({ error: 'client_id, file_no, title required' });
  }
  if (m.billing_type && !['hourly_user','hourly_matter','flat','retainer'].includes(m.billing_type)) {
    return res.status(400).json({ error: 'invalid billing_type' });
  }
  try {
    const info = db.prepare(
      `INSERT INTO matters
        (client_id, file_no, title, description, billing_type, matter_rate, flat_fee, retainer_amount, opened_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')))`
    ).run(
      m.client_id, m.file_no, m.title, m.description || null,
      m.billing_type || 'hourly_user',
      m.matter_rate || 0, m.flat_fee || 0, m.retainer_amount || 0,
      m.opened_on || null
    );
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'file_no already exists for this client' });
    throw e;
  }
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['file_no','title','description','billing_type','matter_rate','flat_fee','retainer_amount','status','closed_on'];
  const fields = []; const values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE matters SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("UPDATE matters SET status = 'closed', closed_on = date('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
