const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly, writeAuditLog } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, (req, res) => {
  const { client_id, status } = req.query;
  // Exclude soft-deleted matters by default. The recycle bin endpoint surfaces them separately.
  let sql = `
    SELECT m.*, c.name AS client_name, c.code AS client_code
    FROM matters m
    JOIN clients c ON c.id = m.client_id
    WHERE m.deleted_at IS NULL
  `;
  const params = [];
  // 'open' was the default before — preserve it unless caller asks for all/closed.
  if (!status || status === 'open') sql += " AND m.status = 'open'";
  else if (status !== 'all')        { sql += " AND m.status = ?"; params.push(status); }
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
  if (req.body.billing_type && !['hourly_user','hourly_matter','flat','retainer'].includes(req.body.billing_type)) {
    return res.status(400).json({ error: 'invalid billing_type' });
  }
  if (req.body.status && !['open','closed'].includes(req.body.status)) {
    return res.status(400).json({ error: 'status must be open or closed' });
  }
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
  const matter = db.prepare('SELECT * FROM matters WHERE id = ?').get(id);
  if (!matter) return res.status(404).json({ error: 'Matter not found' });

  const actorRole = req.user.role_code || req.user.role;
  const isSuperAdmin = actorRole === 'super_admin';
  const wantsHard = req.query.hard === 'true' || req.query.hard === '1';

  // ── Hard-delete branch: super_admin only ──────────────────────────────
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
    // Block if there are dependent records — would orphan financial / time data.
    const tsCount = db.prepare('SELECT COUNT(*) AS c FROM timesheet_entries WHERE matter_id = ?').get(id).c;
    const itemCount = db.prepare('SELECT COUNT(*) AS c FROM invoice_items WHERE matter_id = ?').get(id).c;
    if (tsCount > 0 || itemCount > 0) {
      return res.status(409).json({
        error: `Cannot hard-delete: matter has ${tsCount} timesheet entry(ies) and ${itemCount} invoice line(s). Use soft-delete (recycle bin).`
      });
    }
    const snapshot = JSON.stringify({ before: matter, actor: req.user.email, at: new Date().toISOString() });
    db.prepare('DELETE FROM matters WHERE id = ?').run(id);
    try {
      db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)').run(
        req.user.id, 'matter_hard_deleted_super_admin', 'matter', id, snapshot
      );
    } catch(_) {}
    return res.json({ ok: true, hard_deleted: matter.title });
  }

  // ── Soft-delete branch: default ───────────────────────────────────────
  if (matter.deleted_at) return res.status(400).json({ error: 'Matter already in recycle bin' });
  db.prepare(
    "UPDATE matters SET deleted_at = datetime('now'), deleted_by = ?, status = 'closed', closed_on = COALESCE(closed_on, date('now')) WHERE id = ?"
  ).run(req.user.id, id);
  writeAuditLog(req, 'matter_soft_delete', 'matter', id, `${matter.title} moved to recycle bin`);
  res.json({ ok: true, soft_deleted: matter.title });
});

module.exports = router;
