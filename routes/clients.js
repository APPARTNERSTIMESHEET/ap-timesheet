const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly, writeAuditLog, notifyAdminsOfBillingAction } = require('../middleware/auth');

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
  const { code, name, contact_person, email, phone, gstin, address, state_name, state_code,
          kind_attn, ref_text, default_currency,
          client_internal_id, requires_ledes, ledes_format,
          tds_applicable, tds_rate, tds_section } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Client name required' });
  // Auto-trim whitespace to prevent " Vensure " kind of issues
  const cleanName = String(name).trim();
  const info = db.prepare(
    `INSERT INTO clients (code, name, contact_person, email, phone, gstin, address, state_name, state_code,
                          kind_attn, ref_text, default_currency,
                          client_internal_id, requires_ledes, ledes_format,
                          tds_applicable, tds_rate, tds_section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code || null, cleanName, contact_person || null, email || null, phone || null, gstin || null, address || null,
        state_name || null, state_code || null, kind_attn || null, ref_text || null, default_currency || null,
        client_internal_id || null, requires_ledes ? 1 : 0, ledes_format || null,
        tds_applicable ? 1 : 0,
        (tds_rate != null && tds_rate !== '') ? Number(tds_rate) : 10,
        tds_section || '194J');
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['code','name','contact_person','email','phone','gstin','address','is_active',
                   'state_name','state_code','kind_attn','ref_text','default_currency',
                   'client_internal_id','requires_ledes','ledes_format',
                   'tds_applicable','tds_rate','tds_section'];
  const fields = []; const values = [];
  for (const k of allowed) if (k in req.body) {
    // Auto-trim text fields to prevent trailing whitespace
    let v = req.body[k];
    if (typeof v === 'string' && k !== 'address') v = v.trim();
    fields.push(`${k} = ?`); values.push(v);
  }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const actorRole = req.user.role_code || req.user.role;
  const isSuperAdmin = actorRole === 'super_admin';
  const wantsHard = req.query.hard === 'true' || req.query.hard === '1';

  // ── Hard-delete branch: super_admin only, bypasses recycle bin entirely.
  //    Requires query ?hard=1&confirm=DELETE. Heavily audit-logged with a
  //    snapshot so the destructive action is forensically traceable.
  if (wantsHard) {
    if (!isSuperAdmin) {
      return res.status(403).json({
        error: 'Hard-delete is restricted to super_admin. Use a normal delete to send to recycle bin.'
      });
    }
    if (req.query.confirm !== 'DELETE') {
      return res.status(400).json({
        error: 'Hard-delete requires ?confirm=DELETE on the query string to prevent accidental destruction.'
      });
    }
    // Block when client has dependent records that would orphan critical data.
    const matterCount = db.prepare('SELECT COUNT(*) AS c FROM matters WHERE client_id = ?').get(id).c;
    const invoiceCount = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE client_id = ?').get(id).c;
    if (matterCount > 0 || invoiceCount > 0) {
      return res.status(409).json({
        error: `Cannot hard-delete: client has ${matterCount} matter(s) and ${invoiceCount} invoice(s). Hard-delete those first, or use soft-delete (recycle bin).`
      });
    }
    const snapshot = JSON.stringify({ before: client, actor: req.user.email, at: new Date().toISOString() });
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    try {
      db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)').run(
        req.user.id, 'client_hard_deleted_super_admin', 'client', id, snapshot
      );
    } catch(_) {}
    return res.json({ ok: true, hard_deleted: client.name });
  }

  // ── Soft-delete branch: normal flow. Idempotent on already-deleted rows.
  if (client.deleted_at) return res.status(400).json({ error: 'Client already in recycle bin' });
  db.prepare(
    "UPDATE clients SET deleted_at = datetime('now'), deleted_by = ?, is_active = 0 WHERE id = ?"
  ).run(req.user.id, id);
  writeAuditLog(req, 'client_soft_delete', 'client', id, `${client.name} moved to recycle bin`);
  res.json({ ok: true, soft_deleted: client.name });
});

module.exports = router;
