const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');
const { authRequired, adminOnly, writeAuditLog } = require('../middleware/auth');

const router = express.Router();

// list (soft-deleted users excluded by default — use ?include_deleted=1 for recycle bin view)
router.get('/', authRequired, (req, res) => {
  // admins / billing / hr / super_admin / partner_view all see the full list with role info;
  // plain associates see a minimal active-only list (for filters/dropdowns).
  const adminish = ['admin','billing','super_admin','hr','partner_view'].includes(req.user.role_code || req.user.role);
  const includeDeleted = adminish && req.query.include_deleted === '1';
  const rows = db.prepare(
    adminish
      ? `SELECT u.id, u.email, u.full_name, u.role, u.role_id, u.designation, u.default_rate,
                u.lawyer_code, u.is_active, u.created_at, u.deleted_at,
                u.last_login_at, u.last_login_ip, u.failed_login_count, u.locked_until,
                r.code AS role_code, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         ${includeDeleted ? '' : 'WHERE u.deleted_at IS NULL'}
         ORDER BY u.full_name`
      : `SELECT id, full_name, role, designation, lawyer_code FROM users
         WHERE is_active = 1 AND deleted_at IS NULL ORDER BY full_name`
  ).all();
  res.json({ users: rows });
});

router.post('/', authRequired, adminOnly, (req, res) => {
  const { email, password, full_name, role, role_id, role_code, designation, default_rate } = req.body || {};
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'email, password, full_name required' });
  }
  // Resolve the role: prefer role_id / role_code (new RBAC), fall back to legacy role text.
  let roleRow = null;
  if (role_id) roleRow = db.prepare('SELECT * FROM roles WHERE id = ? AND is_active = 1').get(role_id);
  if (!roleRow && role_code) roleRow = db.prepare('SELECT * FROM roles WHERE code = ? AND is_active = 1').get(role_code);
  if (!roleRow && role) roleRow = db.prepare('SELECT * FROM roles WHERE code = ? AND is_active = 1').get(role);
  if (!roleRow) return res.status(400).json({ error: 'Valid role / role_code / role_id required' });

  // The legacy `role` text column has a CHECK constraint allowing only
  // admin/associate/billing. For new roles (hr, partner_view, super_admin),
  // store 'admin' as a no-op placeholder; the new RBAC reads role_id only.
  const legacyRoleText = ['admin','associate','billing'].includes(roleRow.code) ? roleRow.code : 'admin';

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, role_id, designation, default_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(email, hash, full_name, legacyRoleText, roleRow.id, designation || null, default_rate || 0);
    writeAuditLog(req, 'user_create', 'user', info.lastInsertRowid,
      `${email} (${full_name}) created with role=${roleRow.code}`);
    res.json({ id: info.lastInsertRowid, role: roleRow.code });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

router.patch('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = db.prepare('SELECT email, full_name, role_id, is_active FROM users WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  // Last-admin protection: don't allow deactivating the last active super_admin.
  if ('is_active' in req.body && !req.body.is_active && before.role_id !== null) {
    const oldRole = db.prepare('SELECT code FROM roles WHERE id = ?').get(before.role_id);
    if (oldRole && oldRole.code === 'super_admin') {
      const active = db.prepare(
        `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'super_admin' AND u.is_active = 1 AND u.deleted_at IS NULL`
      ).get().c;
      if (active <= 1) return res.status(400).json({ error: 'Cannot deactivate the last super_admin. Promote another user first.' });
    }
  }

  const allowed = ['full_name','role','designation','default_rate','lawyer_code','is_active','role_id'];
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

  // Build a concise change summary for the audit log
  const changes = Object.keys(req.body).filter(k => allowed.includes(k) || k === 'password').join(',');
  writeAuditLog(req, 'user_update', 'user', id, `${before.email}: ${changes}`);
  res.json({ ok: true });
});

router.delete('/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const user = db.prepare(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.role_id, u.deleted_at,
            r.code AS role_code
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`
  ).get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Last-admin protection: don't allow removing the last active super_admin.
  if (user.role_code === 'super_admin') {
    const active = db.prepare(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = 'super_admin' AND u.is_active = 1 AND u.deleted_at IS NULL`
    ).get().c;
    if (active <= 1) return res.status(400).json({ error: 'Cannot delete the last super_admin. Promote another user first.' });
  }

  // HARD-DELETE PERMANENTLY BLOCKED (per firm data-protection policy).
  // Every "delete" request now soft-deletes only — record moves to recycle bin
  // and can be restored by super_admin. NO API path can permanently remove
  // a user record. This protects against accidental wipes, malicious admins,
  // and ransomware. To purge for real, a DBA must connect directly to SQLite.
  if (req.query.hard === 'true' || req.query.hard === '1') {
    return res.status(403).json({
      error: 'Hard-delete is permanently disabled. All deletions move to the recycle bin (forever retention). Contact the DBA if you need to physically purge a record.'
    });
  }

  // SOFT delete: move to recycle bin. Also deactivate so login stops. Preserves
  // FK integrity for timesheet entries / invoices created by this user.
  db.prepare(
    "UPDATE users SET deleted_at = datetime('now'), deleted_by = ?, is_active = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, id);
  writeAuditLog(req, 'user_soft_delete', 'user', id, `${user.email} (${user.full_name}) moved to recycle bin`);
  res.json({ ok: true, soft_deleted: user.full_name });
});

module.exports = router;
