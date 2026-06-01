const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');
const { authRequired, adminOnly, userManagementOnly, checkRoleAssignment, writeAuditLog } = require('../middleware/auth');

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
                u.timekeeper_classification, u.allowed_tabs,
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

router.post('/', authRequired, userManagementOnly, (req, res) => {
  const {
    email, password, full_name, role, role_id, role_code,
    designation, default_rate, lawyer_code, timekeeper_classification
  } = req.body || {};
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'email, password, full_name required' });
  }
  // Resolve the role: prefer role_id / role_code (new RBAC), fall back to legacy role text.
  let roleRow = null;
  if (role_id) roleRow = db.prepare('SELECT * FROM roles WHERE id = ? AND is_active = 1').get(role_id);
  if (!roleRow && role_code) roleRow = db.prepare('SELECT * FROM roles WHERE code = ? AND is_active = 1').get(role_code);
  if (!roleRow && role) roleRow = db.prepare('SELECT * FROM roles WHERE code = ? AND is_active = 1').get(role);
  if (!roleRow) return res.status(400).json({ error: 'Valid role / role_code / role_id required' });

  // Role-assignment hierarchy check (privilege escalation prevention).
  // Only super_admin can create super_admin / admin users.
  const denial = checkRoleAssignment(req.user, roleRow.code);
  if (denial) return res.status(denial.status).json({ error: denial.error });

  // The legacy `role` text column has a CHECK constraint allowing only
  // admin/associate/billing. For new roles (hr, partner_view, super_admin),
  // store 'admin' as a no-op placeholder; the new RBAC reads role_id only.
  const legacyRoleText = ['admin','associate','billing'].includes(roleRow.code) ? roleRow.code : 'admin';

  // Validate timekeeper classification if provided (must be one of LEDES values)
  const validClassifications = ['SENIOR_PARTNER','PARTNER','SENIOR_ASSOCIATE','ASSOCIATE','OF_COUNSEL','PARALEGAL'];
  const tkClass = timekeeper_classification && validClassifications.includes(timekeeper_classification)
    ? timekeeper_classification
    : null;

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, role_id, designation, default_rate,
                          lawyer_code, timekeeper_classification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(email.trim(), hash, full_name.trim(), legacyRoleText, roleRow.id,
          designation || null, default_rate || 0,
          lawyer_code || null, tkClass);
    writeAuditLog(req, 'user_create', 'user', info.lastInsertRowid,
      `${email} (${full_name}) created with role=${roleRow.code}${tkClass ? ', classification=' + tkClass : ''}`);
    res.json({ id: info.lastInsertRowid, role: roleRow.code });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

router.patch('/:id', authRequired, userManagementOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = db.prepare('SELECT email, full_name, role_id, is_active FROM users WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'User not found' });

  // Role-assignment hierarchy check + legacy-column rewrite. When the caller
  // sends `role: 'hr'` (or 'super_admin' / 'partner_view'), we cannot write
  // that directly to the legacy `users.role` column -- it has a CHECK
  // constraint allowing only ('admin','associate','billing'). Instead, look up
  // the role in the `roles` table and:
  //   1. Set `role_id` to that role's ID (this is the source of truth now).
  //   2. Rewrite `role` (legacy) to a CHECK-safe placeholder so future PATCHes
  //      on other columns don't fail. 'admin' is used for new roles like hr /
  //      partner_view / super_admin since they have admin-like access patterns.
  if ('role_id' in req.body || 'role_code' in req.body || 'role' in req.body) {
    let targetRoleRow = null;
    if (req.body.role_id) {
      targetRoleRow = db.prepare('SELECT id, code FROM roles WHERE id = ? AND is_active = 1').get(req.body.role_id);
    } else if (req.body.role_code) {
      targetRoleRow = db.prepare('SELECT id, code FROM roles WHERE code = ? AND is_active = 1').get(req.body.role_code);
    } else if (req.body.role) {
      targetRoleRow = db.prepare('SELECT id, code FROM roles WHERE code = ? AND is_active = 1').get(req.body.role);
    }

    if (!targetRoleRow) {
      return res.status(400).json({
        error: `Unknown role: "${req.body.role || req.body.role_code || req.body.role_id}". Valid roles: super_admin, admin, billing, hr, partner_view, associate.`
      });
    }

    // Hierarchy check (privilege escalation prevention)
    const denial = checkRoleAssignment(req.user, targetRoleRow.code);
    if (denial) return res.status(denial.status).json({ error: denial.error });

    // Additional safety: only super_admin can MODIFY an existing super_admin or admin
    const beforeRole = before.role_id
      ? db.prepare('SELECT code FROM roles WHERE id = ?').get(before.role_id)
      : null;
    if (beforeRole && ['super_admin', 'admin'].includes(beforeRole.code)) {
      const actorRole = req.user.role_code || req.user.role;
      if (actorRole !== 'super_admin') {
        return res.status(403).json({
          error: `Only a super_admin can modify a user with role "${beforeRole.code}". This protects against unauthorised demotion.`
        });
      }
    }

    // Normalise req.body so the column-allowlist loop below writes the right
    // values. Always set both `role_id` (new RBAC source of truth) and `role`
    // (legacy CHECK-safe placeholder).
    req.body.role_id = targetRoleRow.id;
    req.body.role = ['admin','associate','billing'].includes(targetRoleRow.code)
      ? targetRoleRow.code
      : 'admin';   // hr / partner_view / super_admin → 'admin' placeholder
    delete req.body.role_code;  // not a column; do not let it leak through
  }

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

  const allowed = ['full_name','role','designation','default_rate','lawyer_code','is_active','role_id','timekeeper_classification','allowed_tabs'];
  const validClassifications = ['SENIOR_PARTNER','PARTNER','SENIOR_ASSOCIATE','ASSOCIATE','OF_COUNSEL','PARALEGAL'];
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k];
      // Validate timekeeper classification
      if (k === 'timekeeper_classification') {
        if (v && !validClassifications.includes(v)) {
          return res.status(400).json({ error: `Invalid timekeeper_classification: ${v}. Must be one of: ${validClassifications.join(', ')}` });
        }
        if (!v) v = null;  // empty string -> NULL
      }
      // Auto-trim text fields
      if (typeof v === 'string' && k !== 'designation') v = v.trim();
      fields.push(`${k} = ?`); values.push(v);
    }
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

router.delete('/:id', authRequired, userManagementOnly, (req, res) => {
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

  const actorRole = req.user.role_code || req.user.role;
  const isSuperAdmin = actorRole === 'super_admin';
  const wantsHard = req.query.hard === 'true' || req.query.hard === '1';

  // ── Hard-delete branch: super_admin only.
  //    Refuses if the user has any timesheet entries or invoices, because
  //    those rows reference the user_id and would become orphan/NULL-FK.
  //    Soft-delete is the right choice for users who have ever logged work.
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
    const tsCount = db.prepare('SELECT COUNT(*) AS c FROM timesheet_entries WHERE user_id = ?').get(id).c;
    const invCount = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE created_by = ?').get(id).c;
    if (tsCount > 0 || invCount > 0) {
      return res.status(409).json({
        error: `Cannot hard-delete: user has ${tsCount} timesheet entry(ies) and ${invCount} invoice(s) on record. Use soft-delete (recycle bin) — hard-delete would orphan financial data.`
      });
    }
    const snapshot = JSON.stringify({ before: user, actor: req.user.email, at: new Date().toISOString() });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    try {
      db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)').run(
        req.user.id, 'user_hard_deleted_super_admin', 'user', id, snapshot
      );
    } catch(_) {}
    return res.json({ ok: true, hard_deleted: user.full_name });
  }

  // ── SOFT delete: default path. Moves to recycle bin + deactivates login.
  //    Preserves FK integrity for timesheet entries / invoices owned by this user.
  db.prepare(
    "UPDATE users SET deleted_at = datetime('now'), deleted_by = ?, is_active = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(req.user.id, id);
  writeAuditLog(req, 'user_soft_delete', 'user', id, `${user.email} (${user.full_name}) moved to recycle bin`);
  res.json({ ok: true, soft_deleted: user.full_name });
});

module.exports = router;
