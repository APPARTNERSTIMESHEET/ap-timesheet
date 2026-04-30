const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();

// list
router.get('/', authRequired, (req, res) => {
  // associates can see basic list (for filters); admin sees full
  const isAdmin = req.user.role === 'admin';
  const rows = db.prepare(
    isAdmin
      ? `SELECT id, email, full_name, role, designation, default_rate, is_active, created_at
         FROM users ORDER BY full_name`
      : `SELECT id, full_name, role, designation FROM users WHERE is_active = 1 ORDER BY full_name`
  ).all();
  res.json({ users: rows });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const { email, password, full_name, role, designation, default_rate } = req.body || {};
  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: 'email, password, full_name, role required' });
  }
  if (!['admin','associate'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or associate' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, designation, default_rate)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(email, hash, full_name, role, designation || null, default_rate || 0);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['full_name','role','designation','default_rate','is_active'];
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  }
  if (req.body.password) {
    fields.push('password_hash = ?');
    values.push(bcrypt.hashSync(req.body.password, 10));
  }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  // Soft-delete: deactivate. Hard delete would cascade-break entries.
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
