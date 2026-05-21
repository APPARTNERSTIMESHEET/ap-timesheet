const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly, writeAuditLog } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM matters m WHERE m.client_id = c.id AND m.deleted_at IS NULL) AS matter_count
    FROM clients c
    WHERE c.is_active = 1 AND c.deleted_at IS NULL
    ORDER BY c.name
  `).all();
  res.json({ clients: rows });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const { code, name, contact_person, email, phone, gstin, address, state_name, state_code, kind_attn, ref_text, default_currency } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Client name required' });
  const info = db.prepare(
    `INSERT INTO clients (code, name, contact_person, email, phone, gstin, address, state_name, state_code, kind_attn, ref_text, default_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code || null, name, contact_person || null, email || null, phone || null, gstin || null, address || null,
        state_name || null, state_code || null, kind_attn || null, ref_text || null, default_currency || null);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['code','name','contact_person','email','phone','gstin','address','is_active','state_name','state_code','kind_attn','ref_text','default_currency'];
  const fields = []; const values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = db.prepare('SELECT id, name, deleted_at FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.deleted_at) return res.status(400).json({ error: 'Client already in recycle bin' });

  // HARD-DELETE PERMANENTLY BLOCKED (per firm data-protection policy).
  if (req.query.hard === 'true' || req.query.hard === '1') {
    return res.status(403).json({
      error: 'Hard-delete is permanently disabled. All deletions move to the recycle bin (forever retention).'
    });
  }

  // SOFT-delete: move client to recycle bin. Super_admin can restore from there.
  db.prepare(
    "UPDATE clients SET deleted_at = datetime('now'), deleted_by = ?, is_active = 0 WHERE id = ?"
  ).run(req.user.id, id);
  writeAuditLog(req, 'client_soft_delete', 'client', id, `${client.name} moved to recycle bin`);
  res.json({ ok: true, soft_deleted: client.name });
});

module.exports = router;
