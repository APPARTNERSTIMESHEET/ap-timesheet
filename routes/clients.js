const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM matters m WHERE m.client_id = c.id) AS matter_count
    FROM clients c
    WHERE c.is_active = 1
    ORDER BY c.name
  `).all();
  res.json({ clients: rows });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const { code, name, contact_person, email, phone, gstin, address } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Client name required' });
  const info = db.prepare(
    `INSERT INTO clients (code, name, contact_person, email, phone, gstin, address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(code || null, name, contact_person || null, email || null, phone || null, gstin || null, address || null);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['code','name','contact_person','email','phone','gstin','address','is_active'];
  const fields = []; const values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Soft delete
  db.prepare('UPDATE clients SET is_active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
