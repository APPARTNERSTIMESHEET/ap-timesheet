/**
 * Super-admin operational endpoints:
 *   - Role / permission listing + matrix editor
 *   - Force-reset any user's password (no need to know the current one)
 *   - Impersonation: "login as" another user, audit-logged
 *   - Recycle bin: list + restore soft-deleted entities
 *   - Permission lookup for the current logged-in user (so the frontend can
 *     decide which tabs / buttons to render)
 *
 * All routes are auth-gated; per-route requirePermission() controls who can use them.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');
const {
  authRequired, requirePermission, userHas,
  signToken, writeAuditLog
} = require('../middleware/auth');

const router = express.Router();

// ─── Helpers (used by System tab) ───────────────────────────────────────────
function pickBackupDir() {
  // Same selection logic as ops/backup.ps1: AP_BACKUP_DIR env first, else
  // OneDrive backup folder (auto-cloud-synced), else local C:\ap-timesheet\backups.
  if (process.env.AP_BACKUP_DIR) return process.env.AP_BACKUP_DIR;
  if (process.env.OneDrive && fs.existsSync(process.env.OneDrive)) {
    return path.join(process.env.OneDrive, 'AP-Timesheet-Backups');
  }
  return path.resolve(__dirname, '..', 'backups');
}

function dirSize(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else                     total += fs.statSync(full).size;
    } catch(_) { /* ignore unreadable file */ }
  }
  return total;
}

function fileStat(p) {
  try { return fs.statSync(p); } catch(_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// SELF: current user permissions (any authed user can ask "what can I do?")
// ═══════════════════════════════════════════════════════════════════════════
router.get('/me/permissions', authRequired, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      full_name: req.user.full_name,
      role_code: req.user.role_code,
      role_name: req.user.role_name,
      legacy_role: req.user.role
    },
    permissions: Array.from(req.user.permissions || []),
    impersonator: req.impersonator ? {
      id: req.impersonator.id,
      email: req.impersonator.email,
      full_name: req.impersonator.full_name
    } : null
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLES & PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/roles', authRequired, requirePermission(['roles.manage', 'users.view']), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
           (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
    FROM roles r
    WHERE r.is_active = 1
    ORDER BY r.is_system DESC, r.name
  `).all();
  res.json({ roles: rows });
});

router.get('/permissions', authRequired, requirePermission('roles.manage'), (req, res) => {
  const rows = db.prepare('SELECT * FROM permissions ORDER BY category, name').all();
  // Group by category for the matrix UI
  const byCategory = {};
  for (const p of rows) {
    (byCategory[p.category] ||= []).push(p);
  }
  res.json({ permissions: rows, by_category: byCategory });
});

// GET a single role's permission set (for the matrix editor)
router.get('/roles/:id/permissions', authRequired, requirePermission('roles.manage'), (req, res) => {
  const roleId = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const granted = db.prepare(
    `SELECT p.code FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ?`
  ).all(roleId).map(r => r.code);
  res.json({ role, granted });
});

// PUT replace the entire permission set of a role (matrix save).
// Super_admin's permissions are fixed — refused here to prevent lockout.
router.put('/roles/:id/permissions', authRequired, requirePermission('roles.manage'), (req, res) => {
  const roleId = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.code === 'super_admin') {
    return res.status(400).json({ error: 'super_admin permissions are immutable (always all permissions)' });
  }
  const { permission_codes } = req.body || {};
  if (!Array.isArray(permission_codes)) {
    return res.status(400).json({ error: 'permission_codes (array of strings) required' });
  }
  const valid = db.prepare(
    `SELECT id, code FROM permissions WHERE code IN (${permission_codes.map(() => '?').join(',') || "''"})`
  ).all(...permission_codes);
  const validIds = valid.map(v => v.id);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const ins = db.prepare(
      'INSERT INTO role_permissions (role_id, permission_id, granted_by) VALUES (?, ?, ?)'
    );
    for (const pid of validIds) ins.run(roleId, pid, req.user.id);
  });
  tx();
  writeAuditLog(req, 'role_permissions_replaced', 'role', roleId,
    `${role.code}: ${valid.length} permissions set`);
  res.json({ ok: true, granted: valid.length });
});

// Create a custom role
router.post('/roles', authRequired, requirePermission('roles.manage'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'code and name required' });
  try {
    const info = db.prepare(
      'INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)'
    ).run(String(b.code).toLowerCase().replace(/[^a-z0-9_]/g, '_'), b.name, b.description || null);
    writeAuditLog(req, 'role_create', 'role', info.lastInsertRowid, b.code);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Role code already exists' });
    throw e;
  }
});

router.patch('/roles/:id', authRequired, requirePermission('roles.manage'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const allowed = ['name', 'description', 'is_active'];
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k];
      if (k === 'is_active') v = v ? 1 : 0;
      fields.push(`${k} = ?`); values.push(v);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  writeAuditLog(req, 'role_update', 'role', id, JSON.stringify(req.body));
  res.json({ ok: true });
});

router.delete('/roles/:id', authRequired, requirePermission('roles.manage'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be deleted' });
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ? AND is_active = 1').get(id).c;
  if (inUse > 0) return res.status(409).json({ error: `Role is assigned to ${inUse} active user(s). Reassign them first.` });
  db.prepare('UPDATE roles SET is_active = 0 WHERE id = ?').run(id);
  writeAuditLog(req, 'role_deactivate', 'role', id, role.code);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// USER ROLE ASSIGNMENT (separate from full user update so it gets its own
// permission gate — HR can edit profile fields but not change role)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/users/:id/role', authRequired, requirePermission('roles.manage'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role_id, role_code } = req.body || {};
  const role = role_id
    ? db.prepare('SELECT * FROM roles WHERE id = ? AND is_active = 1').get(role_id)
    : db.prepare('SELECT * FROM roles WHERE code = ? AND is_active = 1').get(role_code);
  if (!role) return res.status(404).json({ error: 'Role not found or inactive' });
  const target = db.prepare('SELECT id, email, role_id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Privilege-escalation prevention:
  //   - Only super_admin can assign super_admin role.
  //   - Only super_admin can assign admin role.
  //   - Only super_admin can MODIFY an existing super_admin or admin.
  const { checkRoleAssignment } = require('../middleware/auth');
  const denial = checkRoleAssignment(req.user, role.code);
  if (denial) return res.status(denial.status).json({ error: denial.error });

  if (target.role_id !== null) {
    const beforeRole = db.prepare('SELECT code FROM roles WHERE id = ?').get(target.role_id);
    if (beforeRole && ['super_admin', 'admin'].includes(beforeRole.code)) {
      const actorRole = req.user.role_code || req.user.role;
      if (actorRole !== 'super_admin') {
        return res.status(403).json({
          error: `Only a super_admin can modify the role of a user currently holding "${beforeRole.code}".`
        });
      }
    }
  }

  // Last-admin protection: don't allow removing the last active super_admin.
  if (target.role_id !== null) {
    const oldRole = db.prepare('SELECT code FROM roles WHERE id = ?').get(target.role_id);
    if (oldRole && oldRole.code === 'super_admin' && role.code !== 'super_admin') {
      const activeSAs = db.prepare(
        `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'super_admin' AND u.is_active = 1 AND u.deleted_at IS NULL`
      ).get().c;
      if (activeSAs <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last active super_admin. Promote another user first.' });
      }
    }
  }

  db.prepare("UPDATE users SET role_id = ?, updated_at = datetime('now') WHERE id = ?").run(role.id, userId);
  writeAuditLog(req, 'user_role_change', 'user', userId, `${target.email} -> ${role.code}`);
  res.json({ ok: true, role: role.code });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORCE PASSWORD RESET (super_admin / HR — can reset anyone's password)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/users/:id/force-reset-password', authRequired, requirePermission('users.force_password_reset'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT id, email, role_id FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use the normal change-password flow for your own account.' });

  // Caller must not be able to reset a higher-privileged user (e.g. HR can't
  // reset super_admin / admin). Super_admin can reset anyone.
  if (req.user.role_code !== 'super_admin') {
    const targetRole = target.role_id
      ? db.prepare('SELECT code FROM roles WHERE id = ?').get(target.role_id)
      : null;
    if (targetRole && ['super_admin', 'admin'].includes(targetRole.code)) {
      return res.status(403).json({ error: 'Only super_admin can reset password for admin / super_admin accounts.' });
    }
  }

  const newPassword = (req.body && req.body.new_password) || generateTempPassword();
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
  writeAuditLog(req, 'force_password_reset', 'user', userId, `Reset password for ${target.email}`);
  res.json({ ok: true, email: target.email, temp_password: newPassword,
    message: `Share this temp password with the user securely. Ask them to log in and change it immediately.` });
});

function generateTempPassword() {
  // 12-char password with mixed case + digits, no ambiguous chars (0/O/1/l).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pw = '';
  const buf = require('crypto').randomBytes(12);
  for (let i = 0; i < 12; i++) pw += chars[buf[i] % chars.length];
  return pw;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPERSONATION ("login as user")
// ═══════════════════════════════════════════════════════════════════════════
router.post('/users/:id/impersonate', authRequired, requirePermission('users.impersonate'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const target = db.prepare(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.deleted_at, r.code AS role_code
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`
  ).get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!target.is_active || target.deleted_at) return res.status(400).json({ error: 'Target account is not active.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You are already logged in as yourself.' });

  // Even super_admin can't impersonate another super_admin — prevents one super_admin
  // running unattributable actions in another's name.
  if (target.role_code === 'super_admin') {
    return res.status(403).json({ error: 'Cannot impersonate a super_admin account.' });
  }

  // 30-min short-lived token. Frontend banner clearly indicates impersonation.
  const token = signToken(target, {
    impersonator_id: req.user.id,
    expiresIn: '30m'
  });
  writeAuditLog(req, 'impersonation_start', 'user', userId,
    `${req.user.email} started impersonating ${target.email}`);

  res.json({
    token,
    user: { id: target.id, email: target.email, full_name: target.full_name, role: target.role_code || target.role },
    impersonator: { id: req.user.id, email: req.user.email, full_name: req.user.full_name },
    expires_in_minutes: 30
  });
});

router.post('/impersonate/stop', authRequired, (req, res) => {
  // The frontend simply switches back to the super_admin's own JWT (which it
  // kept in a separate localStorage key before starting impersonation). This
  // endpoint just records the audit row.
  if (!req.impersonator) return res.json({ ok: true, was_impersonating: false });
  writeAuditLog(req, 'impersonation_stop', 'user', req.user.id,
    `${req.impersonator.email} stopped impersonating ${req.user.email}`);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// RECYCLE BIN — list soft-deleted entities + restore
// ═══════════════════════════════════════════════════════════════════════════
router.get('/recycle-bin', authRequired, requirePermission('recycle_bin.view'), (req, res) => {
  const out = {
    users:    db.prepare(`SELECT u.id, u.email, u.full_name, u.role, u.deleted_at, db.full_name AS deleted_by_name
                          FROM users u LEFT JOIN users db ON db.id = u.deleted_by
                          WHERE u.deleted_at IS NOT NULL ORDER BY u.deleted_at DESC`).all(),
    clients:  db.prepare(`SELECT c.id, c.name, c.code, c.deleted_at, db.full_name AS deleted_by_name
                          FROM clients c LEFT JOIN users db ON db.id = c.deleted_by
                          WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC`).all(),
    matters:  db.prepare(`SELECT m.id, m.file_no, m.title, m.deleted_at, c.name AS client_name, db.full_name AS deleted_by_name
                          FROM matters m
                          LEFT JOIN clients c ON c.id = m.client_id
                          LEFT JOIN users db ON db.id = m.deleted_by
                          WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC`).all(),
    invoices: db.prepare(`SELECT i.id, i.invoice_no, i.total, i.currency, i.deleted_at, c.name AS client_name, db.full_name AS deleted_by_name
                          FROM invoices i
                          LEFT JOIN clients c ON c.id = i.client_id
                          LEFT JOIN users db ON db.id = i.deleted_by
                          WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC`).all()
  };
  res.json(out);
});

// Generic restore handler factory. Each entity restores by clearing the soft-delete columns.
function buildRestore(entity, table, permission) {
  return [authRequired, requirePermission(permission), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare(`SELECT id, deleted_at FROM ${table} WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: `${entity} not found` });
    if (!row.deleted_at) return res.status(400).json({ error: `${entity} is not in the recycle bin` });
    db.prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(id);
    writeAuditLog(req, `${entity}_restore`, entity, id, `Restored from recycle bin`);
    res.json({ ok: true });
  }];
}

router.post('/recycle-bin/users/:id/restore',    ...buildRestore('user',    'users',    'users.restore'));
router.post('/recycle-bin/clients/:id/restore',  ...buildRestore('client',  'clients',  'clients.create'));   // restore uses create perm by default
router.post('/recycle-bin/matters/:id/restore',  ...buildRestore('matter',  'matters',  'matters.create'));
router.post('/recycle-bin/invoices/:id/restore', ...buildRestore('invoice', 'invoices', 'invoices.restore'));

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM — Backup, Storage, Scan (super_admin only)
// ═══════════════════════════════════════════════════════════════════════════

// ── 💾 Backup Now ─────────────────────────────────────────────────────────
// Online backup using better-sqlite3's safe backup API — doesn't block live
// reads/writes. Writes to the OneDrive backup folder (auto-syncs to cloud) or
// the local backups dir as a fallback. Manual snapshots are tagged so the
// scheduled rotation script can tell them apart from automatic daily backups.
router.post('/backup/run', authRequired, requirePermission('system.settings'), async (req, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = pickBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `aptimesheet-manual-${stamp}.db`);

    await db.backup(outPath);
    const sz = fs.statSync(outPath).size;
    writeAuditLog(req, 'manual_backup', 'system', null,
      `${path.basename(outPath)} (${(sz/1024).toFixed(1)} KB) -> ${dir}`);

    res.json({
      ok: true,
      file: path.basename(outPath),
      dir,
      size_bytes: sz,
      size_kb: Math.round(sz / 1024),
      created_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

// List recent backups (newest first) so the UI can show "last 5" + sizes.
// Now also includes the hourly sub-folder so the System tab can show both.
router.get('/backup/list', authRequired, requirePermission('system.settings'), (req, res) => {
  const dir = pickBackupDir();
  if (!fs.existsSync(dir)) return res.json({ dir, backups: [], hourly: [] });

  function scan(folder, label) {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder)
      .filter(f => /^aptimesheet.*\.db$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(folder, f));
        return {
          name: f, label,
          size_bytes: st.size, size_kb: Math.round(st.size/1024),
          mtime: st.mtime.toISOString()
        };
      });
  }

  const daily  = scan(dir, 'daily').sort((a,b)=>b.mtime.localeCompare(a.mtime)).slice(0, 15);
  const hourly = scan(path.join(dir, 'hourly'), 'hourly').sort((a,b)=>b.mtime.localeCompare(a.mtime)).slice(0, 24);

  res.json({ dir, backups: daily, hourly });
});

// Read integrity-log.json -- shows last 50 backup integrity verifications so
// the Super Admin "Last verified OK: N minutes ago" indicator stays current.
router.get('/backup/integrity-history', authRequired, requirePermission('system.settings'), (req, res) => {
  const dir = pickBackupDir();
  const logPath = path.join(dir, 'integrity-log.json');
  if (!fs.existsSync(logPath)) {
    return res.json({ entries: [], latest_ok: null, latest_at: null });
  }
  try {
    let raw = fs.readFileSync(logPath, 'utf8');
    // Strip UTF-8 BOM (﻿) -- Windows PowerShell 5.1's `Set-Content -Encoding utf8`
    // writes a BOM that Node's JSON.parse() rejects with "Unexpected token".
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.trim();
    if (!raw) {
      return res.json({ entries: [], latest_ok: null, latest_at: null });
    }
    let entries = JSON.parse(raw);
    if (!Array.isArray(entries)) entries = [entries];
    // Newest first, max 50 entries returned
    entries = entries.slice(-50).reverse();
    const latestOk = entries.find(e => e.ok === true);
    res.json({
      entries,
      latest_ok: latestOk || null,
      latest_at: entries[0] ? entries[0].timestamp : null,
      latest_failure: entries.find(e => e.ok === false) || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read integrity log: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSONAL REMINDERS — per-user to-do list with login-time popup
// ═══════════════════════════════════════════════════════════════════════════

// List current user's open reminders (sorted by date, urgent priority first).
router.get('/reminders', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name AS client_name, m.title AS matter_title, m.file_no AS matter_file_no,
           i.invoice_no
    FROM user_reminders r
    LEFT JOIN clients  c ON c.id = r.client_id
    LEFT JOIN matters  m ON m.id = r.matter_id
    LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.user_id = ? AND r.status = 'open'
    ORDER BY
      CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      r.remind_on
  `).all(req.user.id);
  res.json({ reminders: rows });
});

// Reminders due today or earlier (for the login popup).
router.get('/reminders/due', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name AS client_name, m.title AS matter_title, m.file_no AS matter_file_no,
           i.invoice_no
    FROM user_reminders r
    LEFT JOIN clients  c ON c.id = r.client_id
    LEFT JOIN matters  m ON m.id = r.matter_id
    LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.user_id = ? AND r.status = 'open' AND r.remind_on <= date('now','localtime')
    ORDER BY r.remind_on, r.id
  `).all(req.user.id);
  res.json({ reminders: rows });
});

// Create a new reminder for the current user.
router.post('/reminders', authRequired, (req, res) => {
  const { title, notes, remind_on, priority, client_id, matter_id, invoice_id } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  if (!remind_on || !/^\d{4}-\d{2}-\d{2}$/.test(remind_on)) {
    return res.status(400).json({ error: 'remind_on must be in YYYY-MM-DD format' });
  }
  const validPriorities = ['low','normal','high','urgent'];
  const pri = validPriorities.includes(priority) ? priority : 'normal';

  const info = db.prepare(`
    INSERT INTO user_reminders
      (user_id, title, notes, remind_on, priority, client_id, matter_id, invoice_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, String(title).trim(), notes || null, remind_on, pri,
         client_id || null, matter_id || null, invoice_id || null);
  res.json({ id: info.lastInsertRowid });
});

// Mark a reminder done (or snooze by updating remind_on, or dismiss).
// Super-admin can edit anyone's reminder (god-mode). Audit-logged when used.
router.patch('/reminders/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = db.prepare('SELECT user_id FROM user_reminders WHERE id = ?').get(id);
  if (!own) return res.status(404).json({ error: 'Reminder not found' });
  const isSuperAdmin = (req.user.role_code || req.user.role) === 'super_admin';
  if (own.user_id !== req.user.id && !isSuperAdmin) {
    return res.status(403).json({ error: 'Not your reminder' });
  }
  if (own.user_id !== req.user.id && isSuperAdmin) {
    writeAuditLog(req, 'reminder_edit_super_admin', 'reminder', id,
      `Edited reminder owned by user_id=${own.user_id}`);
  }

  const { status, remind_on, priority, title, notes } = req.body || {};
  const fields = [], values = [];
  if (status && ['open','done','dismissed'].includes(status)) {
    fields.push('status = ?'); values.push(status);
    if (status === 'done') { fields.push("completed_at = datetime('now')"); }
  }
  if (remind_on && /^\d{4}-\d{2}-\d{2}$/.test(remind_on))   { fields.push('remind_on = ?'); values.push(remind_on); }
  if (priority && ['low','normal','high','urgent'].includes(priority)) { fields.push('priority = ?'); values.push(priority); }
  if (title != null)                                         { fields.push('title = ?'); values.push(String(title).trim()); }
  if (notes != null)                                         { fields.push('notes = ?'); values.push(notes || null); }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE user_reminders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Delete a reminder (only your own; super_admin can delete anyone's, audit-logged).
router.delete('/reminders/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = db.prepare('SELECT user_id FROM user_reminders WHERE id = ?').get(id);
  if (!own) return res.status(404).json({ error: 'Reminder not found' });
  const isSuperAdmin = (req.user.role_code || req.user.role) === 'super_admin';
  if (own.user_id !== req.user.id && !isSuperAdmin) {
    return res.status(403).json({ error: 'Not your reminder' });
  }
  if (own.user_id !== req.user.id && isSuperAdmin) {
    writeAuditLog(req, 'reminder_delete_super_admin', 'reminder', id,
      `Deleted reminder owned by user_id=${own.user_id}`);
  }
  db.prepare('DELETE FROM user_reminders WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── Manual email compose endpoint ────────────────────────────────────────
// Admin-triggered email send. Replaces the previous auto-notify behaviour
// where every billing action spammed admins. Now nothing goes out unless
// the admin explicitly composes and sends from the Compose Email modal.
router.post('/email/compose', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (!['admin', 'super_admin', 'billing'].includes(role)) {
    return res.status(403).json({ error: 'Only admin/super_admin/billing can send emails' });
  }
  const { to, cc, subject, body } = req.body || {};
  if (!to || !String(to).trim()) return res.status(400).json({ error: 'Recipient (to) is required' });
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Body is required' });

  // SMTP config check
  const smtpHost = process.env.SMTP_HOST, smtpUser = process.env.SMTP_USER, smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    return res.status(503).json({ error: 'SMTP is not configured on the server. Check .env values.' });
  }

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { return res.status(503).json({ error: 'nodemailer not installed' }); }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, requireTLS: true,
    tls: { rejectUnauthorized: false },
    auth: { user: smtpUser, pass: smtpPass }
  });

  transporter.sendMail({
    from: `"${process.env.FIRM_NAME || 'AP & Partners'}" <${process.env.SMTP_FROM || smtpUser}>`,
    to: String(to).trim(),
    cc: cc && String(cc).trim() ? String(cc).trim() : undefined,
    subject: String(subject).trim(),
    text: String(body)
  }, (err, info) => {
    if (err) {
      console.error('[email/compose] failed:', err.message);
      return res.status(500).json({ error: 'Email failed: ' + err.message });
    }
    writeAuditLog(req, 'EMAIL_SENT', 'email', null,
      `to=${to}${cc ? ', cc='+cc : ''}, subject="${subject.slice(0, 80)}"`);
    res.json({ ok: true, message: 'Email sent successfully' });
  });
});

// ── 📊 Storage stats ──────────────────────────────────────────────────────
router.get('/storage', authRequired, requirePermission('system.settings'), (req, res) => {
  const root        = path.resolve(__dirname, '..');
  const dbDir       = path.join(root, 'database');
  const uploadsDir  = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'uploads'));
  const logsDir     = path.join(root, 'logs');
  const backupsDir  = pickBackupDir();

  const dbMain = fileStat(path.join(dbDir, 'aptimesheet.db'));
  const dbWal  = fileStat(path.join(dbDir, 'aptimesheet.db-wal'));
  const dbShm  = fileStat(path.join(dbDir, 'aptimesheet.db-shm'));

  // Disk free on the volume holding the DB (Windows only via statfs).
  let diskFreeGB = null, diskTotalGB = null;
  try {
    if (fs.statfsSync) {
      const stat = fs.statfsSync(dbDir);
      diskFreeGB  = Math.round((stat.bavail * stat.bsize) / 1024 / 1024 / 1024 * 100) / 100;
      diskTotalGB = Math.round((stat.blocks * stat.bsize) / 1024 / 1024 / 1024 * 100) / 100;
    }
  } catch(_) {}

  const counts = {
    users:     db.prepare('SELECT COUNT(*) AS c FROM users    WHERE deleted_at IS NULL').get().c,
    clients:   db.prepare('SELECT COUNT(*) AS c FROM clients  WHERE deleted_at IS NULL').get().c,
    matters:   db.prepare('SELECT COUNT(*) AS c FROM matters  WHERE deleted_at IS NULL').get().c,
    invoices:  db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c,
    timesheet_entries: db.prepare('SELECT COUNT(*) AS c FROM timesheet_entries').get().c,
    leave_applications: db.prepare('SELECT COUNT(*) AS c FROM leave_applications').get().c,
    audit_log: db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c
  };

  res.json({
    database: {
      main_kb: dbMain ? Math.round(dbMain.size/1024) : 0,
      wal_kb:  dbWal  ? Math.round(dbWal.size/1024)  : 0,
      shm_kb:  dbShm  ? Math.round(dbShm.size/1024)  : 0,
      total_kb: Math.round(((dbMain?.size || 0) + (dbWal?.size || 0) + (dbShm?.size || 0)) / 1024)
    },
    folders: {
      uploads_mb: Math.round(dirSize(uploadsDir) / 1024 / 1024 * 100) / 100,
      logs_mb:    Math.round(dirSize(logsDir)    / 1024 / 1024 * 100) / 100,
      backups_mb: Math.round(dirSize(backupsDir) / 1024 / 1024 * 100) / 100
    },
    paths: { db: dbDir, uploads: uploadsDir, logs: logsDir, backups: backupsDir },
    disk: { free_gb: diskFreeGB, total_gb: diskTotalGB },
    counts
  });
});

// ── 🔍 Scan (DB integrity + orphan records + SECURITY posture) ───────────
// Returns { ok, checks: [{ name, ok, severity, category, detail, fix_code,
//                          manual_steps[] }] }
//
// severity: 'critical' | 'warning' | 'info'
// category: 'database' | 'security' | 'backup' | 'data-quality'
// fix_code: string identifier matching POST /scan/auto-fix (undefined when
//           the issue can't be fixed automatically — only manual_steps apply)
// manual_steps: ordered list of human-readable instructions to fix by hand
router.post('/scan', authRequired, requirePermission('system.settings'), (req, res) => {
  const report = { ok: true, checks: [] };
  const add = (c) => {
    report.checks.push(c);
    if (!c.ok && c.severity !== 'info') report.ok = false;
  };

  // 1. SQLite integrity check — corrupted pages, index inconsistencies, etc.
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const verdict = rows.length === 1 && rows[0].integrity_check === 'ok';
    add({
      name: 'DB integrity',
      category: 'database',
      severity: verdict ? 'info' : 'critical',
      ok: verdict,
      detail: verdict ? 'All pages and indexes consistent.' : rows.map(r => r.integrity_check).join('; '),
      fix_code: verdict ? null : 'reindex_db',
      manual_steps: verdict ? [] : [
        'Stop the app: pm2 stop ap-timesheet',
        'Open SQLite CLI: sqlite3 database/aptimesheet.db',
        'Run: PRAGMA integrity_check; — confirm the corrupted page',
        'If irrecoverable, restore the latest backup: copy backups/aptimesheet-YYYY-MM-DD.db over database/aptimesheet.db',
        'Restart the app: pm2 start ap-timesheet'
      ]
    });
  } catch (e) {
    add({ name: 'DB integrity', category: 'database', severity: 'critical', ok: false, detail: 'Error: ' + e.message });
  }

  // 2. Foreign key check
  try {
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    add({
      name: 'Foreign keys',
      category: 'database',
      severity: fk.length === 0 ? 'info' : 'warning',
      ok: fk.length === 0,
      detail: fk.length === 0 ? 'No FK violations.' : `${fk.length} FK violation(s) found.`
    });
  } catch(e) {
    add({ name: 'Foreign keys', category: 'database', severity: 'warning', ok: false, detail: e.message });
  }

  // 3. Orphan invoice_items (user_id null AND no [NO CHARGE] / no recognised expense label)
  const orphans = db.prepare(`
    SELECT COUNT(*) AS c FROM invoice_items
    WHERE user_id IS NULL AND matter_id IS NULL
      AND description NOT LIKE '%[NO CHARGE]%'
      AND description NOT LIKE '%Travel%'
      AND description NOT LIKE '%Court Fee%'
      AND description NOT LIKE '%Disbursement%'
      AND description NOT LIKE '%Discount%'
      AND description NOT LIKE '%Reimbursement%'
  `).get().c;
  add({
    name: 'Orphan invoice items',
    category: 'data-quality',
    severity: orphans === 0 ? 'info' : 'warning',
    ok: orphans === 0,
    detail: orphans === 0
      ? 'All line items are either linked to a matter/lawyer or recognised as a custom charge.'
      : `${orphans} item(s) have no matter/user link and aren't clearly a custom expense.`,
    manual_steps: orphans === 0 ? [] : [
      'Open PowerShell in the project folder',
      'Run: node ops/relink-orphan-invoice-items.js',
      'Review the output — it lists which invoices were affected'
    ]
  });

  // 4. Last backup age
  const dir = pickBackupDir();
  let lastBackupHours = null, lastBackupFile = null;
  if (fs.existsSync(dir)) {
    let newest = null;
    for (const f of fs.readdirSync(dir)) {
      if (!/^aptimesheet.*\.db$/.test(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, mtimeMs: st.mtimeMs };
    }
    if (newest) {
      lastBackupHours = Math.round((Date.now() - newest.mtimeMs) / 3600000 * 10) / 10;
      lastBackupFile = newest.f;
    }
  }
  const backupOk = lastBackupHours != null && lastBackupHours < 36;
  add({
    name: 'Daily backup freshness',
    category: 'backup',
    severity: backupOk ? 'info' : 'critical',
    ok: backupOk,
    detail: lastBackupHours == null
      ? 'No backup files found in ' + dir
      : `Latest backup: ${lastBackupFile} — ${lastBackupHours} hours old.`,
    fix_code: backupOk ? null : 'run_backup_now',
    manual_steps: backupOk ? [] : [
      'Open elevated PowerShell',
      'Run: powershell -ExecutionPolicy Bypass -File ops\\backup.ps1',
      'Check Task Scheduler → "AP Timesheet Daily Backup" task is enabled and last run is recent'
    ]
  });

  // 5. Users without a default rate (often the cause of zero-fee bugs)
  const zeroRate = db.prepare(`
    SELECT COUNT(*) AS c FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.code IN ('associate', 'admin', 'super_admin') AND u.is_active = 1
      AND u.deleted_at IS NULL
      AND (u.default_rate IS NULL OR u.default_rate = 0)
  `).get().c;
  add({
    name: 'Lawyers with INR 0 default rate',
    category: 'data-quality',
    severity: 'info',
    ok: true,    // informational, not a failure
    detail: zeroRate === 0
      ? 'All active lawyers have a non-zero default rate.'
      : `${zeroRate} active lawyer(s) have default_rate = 0. Set rates via Masters > Users or use Rate Cards / per-invoice edits.`
  });

  // ════════════════════════════════════════════════════════════════════════
  // 🔐 SECURITY POSTURE CHECKS
  // ════════════════════════════════════════════════════════════════════════

  // 6. JWT_SECRET strength — at least 32 chars and not the demo default.
  const jwt = process.env.JWT_SECRET || '';
  const jwtWeak = jwt.length < 32
                  || /^(dev|test|demo|change[-_ ]?me|secret|password)/i.test(jwt)
                  || /^[a-zA-Z]+$/.test(jwt);
  add({
    name: 'JWT secret strength',
    category: 'security',
    severity: jwtWeak ? 'critical' : 'info',
    ok: !jwtWeak,
    detail: jwtWeak
      ? `JWT_SECRET is weak or default (${jwt ? jwt.length + ' chars, low entropy' : 'NOT SET'}). All sessions can be forged if leaked.`
      : `Strong secret (${jwt.length} chars).`,
    fix_code: jwtWeak ? 'rotate_jwt_secret' : null,
    manual_steps: jwtWeak ? [
      'Generate a strong secret: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
      'Open .env in the project folder',
      'Replace the JWT_SECRET=... line with the new value',
      'Restart the app: pm2 reload ap-timesheet (this will sign out everyone)'
    ] : []
  });

  // 7. Default admin password — checks whether any super_admin still has the
  //    seeded "Admin@123" password. This is a critical compromise vector
  //    because the seed is publicly visible in init.js.
  let defaultPwUsers = [];
  try {
    const adminUsers = db.prepare(`
      SELECT u.id, u.email, u.full_name, u.password_hash
      FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND u.deleted_at IS NULL
        AND (r.code IN ('admin','super_admin') OR u.role = 'admin')
    `).all();
    for (const u of adminUsers) {
      if (u.password_hash && bcrypt.compareSync('Admin@123', u.password_hash)) {
        defaultPwUsers.push(u.email);
      }
    }
  } catch(_) {}
  add({
    name: 'Default admin password',
    category: 'security',
    severity: defaultPwUsers.length ? 'critical' : 'info',
    ok: defaultPwUsers.length === 0,
    detail: defaultPwUsers.length
      ? `${defaultPwUsers.length} admin account(s) still use the seeded password "Admin@123": ${defaultPwUsers.join(', ')}`
      : 'No admin account is using the seeded password.',
    manual_steps: defaultPwUsers.length ? [
      'Log in as that user and click "Change password" in the top-right menu',
      'OR, as super-admin: open System tab → Users → "Force Reset" on the affected account',
      'Use a strong password (12+ chars, mixed case, numbers, symbols)'
    ] : []
  });

  // 8. .env file protections — actually inspect the Windows ACLs via icacls
  //    instead of just checking file existence. The previous version always
  //    warned because .env exists; this version only warns if the ACL grants
  //    access to broad groups (BUILTIN\Users or Authenticated Users).
  //    SAFE owners: NT AUTHORITY\SYSTEM (PM2 daemon) + BUILTIN\Administrators
  //    + the maintainer's own user account.
  const envPath = path.resolve(__dirname, '..', '.env');
  const envExists = fs.existsSync(envPath);
  if (!envExists) {
    add({
      name: '.env file protection',
      category: 'security',
      severity: 'info',
      ok: true,
      detail: 'No .env file present (env vars set elsewhere). No exposure risk.',
      manual_steps: []
    });
  } else {
    // Parse icacls output. Permissive entries look like:
    //   BUILTIN\Users:(RX)
    //   NT AUTHORITY\Authenticated Users:(M)
    //   Everyone:(R)
    // Safe entries: NT AUTHORITY\SYSTEM, BUILTIN\Administrators, specific user accounts.
    let aclDetail = 'Could not inspect ACLs (icacls unavailable).';
    let aclSafe   = false;
    let broadGroups = [];
    try {
      const { execSync } = require('child_process');
      const out = execSync(`icacls "${envPath}"`, { encoding: 'utf8', timeout: 5000 });
      // Each line after the file path is one ACE entry. Strip the file-path
      // header and the trailing "Successfully processed" line.
      const aceLines = out.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !/^Successfully processed/i.test(l) && !/Failed processing/i.test(l));
      const broadPatterns = [
        /BUILTIN\\Users\b/i,
        /\bAuthenticated Users\b/i,
        /\bEveryone\b/i,
        /\bINTERACTIVE\b/i,
        /\bNETWORK\b/i
      ];
      for (const line of aceLines) {
        for (const pat of broadPatterns) {
          if (pat.test(line)) {
            broadGroups.push(line.split(':')[0].trim());
            break;
          }
        }
      }
      if (broadGroups.length === 0) {
        aclSafe = true;
        aclDetail = `ACLs locked down — only SYSTEM, Administrators, and named user have access (${aceLines.length} ACE entr${aceLines.length === 1 ? 'y' : 'ies'}).`;
      } else {
        aclDetail = `.env grants access to broad group(s): ${[...new Set(broadGroups)].join(', ')}. Anyone logged into this machine can read your JWT secret / DB path / SMTP credentials.`;
      }
    } catch (e) {
      aclDetail = `.env exists at ${envPath}. Could not inspect ACLs automatically (${(e.message || '').slice(0, 100)}). Verify manually.`;
    }
    add({
      name: '.env file protection',
      category: 'security',
      severity: aclSafe ? 'info' : 'warning',
      ok: aclSafe,
      detail: aclDetail,
      manual_steps: aclSafe ? [] : [
        'Open elevated PowerShell, cd to C:\\ap-timesheet',
        'icacls .env /inheritance:r',
        'icacls .env /remove "BUILTIN\\Users"',
        'icacls .env /remove "NT AUTHORITY\\Authenticated Users"',
        'icacls .env /grant:r SYSTEM:F',
        'icacls .env /grant:r "$($env:USERNAME):R"',
        'icacls .env  (verify only SYSTEM + Administrators + your user remain)'
      ]
    });
  }

  // 9. Expired sessions cluttering the table — sessions past their expires_at
  //    waste DB space. Easy to auto-fix.
  let expiredSessions = 0;
  try {
    expiredSessions = db.prepare(`
      SELECT COUNT(*) AS c FROM sessions
      WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
    `).get().c;
  } catch(_) {}
  add({
    name: 'Expired sessions',
    category: 'security',
    severity: expiredSessions > 50 ? 'warning' : 'info',
    ok: expiredSessions === 0,
    detail: expiredSessions === 0
      ? 'No expired sessions in the table.'
      : `${expiredSessions} expired session(s) sitting in the DB. Safe to purge.`,
    fix_code: expiredSessions > 0 ? 'purge_expired_sessions' : null,
    manual_steps: expiredSessions > 0 ? [
      'Open SQLite CLI: sqlite3 database/aptimesheet.db',
      "Run: DELETE FROM sessions WHERE expires_at < datetime('now');",
      'Run: VACUUM;'
    ] : []
  });

  // 10. WAL file bloat — > 50 MB suggests checkpoint isn't happening. SQLite
  //     normally auto-checkpoints, but the WAL can grow under heavy write load
  //     or if a long-running reader is open.
  let walSizeMB = 0, dbSizeMB = 0;
  try {
    const dbPath = path.resolve(__dirname, '..', 'database', 'aptimesheet.db');
    if (fs.existsSync(dbPath)) dbSizeMB = fs.statSync(dbPath).size / 1048576;
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) walSizeMB = fs.statSync(walPath).size / 1048576;
  } catch(_) {}
  const walBloated = walSizeMB > 50 || (dbSizeMB > 0 && walSizeMB > dbSizeMB * 3);
  add({
    name: 'WAL file size',
    category: 'database',
    severity: walBloated ? 'warning' : 'info',
    ok: !walBloated,
    detail: `WAL: ${walSizeMB.toFixed(1)} MB · main DB: ${dbSizeMB.toFixed(1)} MB`
            + (walBloated ? ' — WAL is unusually large; checkpoint recommended.' : ''),
    fix_code: walBloated ? 'wal_checkpoint' : null,
    manual_steps: walBloated ? [
      'Open SQLite CLI: sqlite3 database/aptimesheet.db',
      'Run: PRAGMA wal_checkpoint(TRUNCATE);',
      'The WAL file should shrink to near 0 bytes'
    ] : []
  });

  // 11. Audit log retention — > 100,000 rows or > 1 year old rows suggest
  //     pruning. Old audit logs aren't dangerous but bloat backups.
  let oldAuditCount = 0, totalAudit = 0;
  try {
    totalAudit = db.prepare("SELECT COUNT(*) AS c FROM audit_log").get().c;
    oldAuditCount = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE created_at < datetime('now','-365 days')").get().c;
  } catch(_) {}
  const auditBloat = oldAuditCount > 5000;
  add({
    name: 'Audit log retention',
    category: 'database',
    severity: 'info',
    ok: !auditBloat,
    detail: `${totalAudit.toLocaleString('en-IN')} audit rows total, ${oldAuditCount.toLocaleString('en-IN')} older than 1 year.`
            + (auditBloat ? ' Consider archiving.' : ''),
    fix_code: auditBloat ? 'archive_old_audit' : null,
    manual_steps: auditBloat ? [
      'Backup first: node ops/export-audit-log.js > audit-archive.json',
      "Then prune: sqlite3 database/aptimesheet.db \"DELETE FROM audit_log WHERE created_at < datetime('now','-365 days');\"",
      'VACUUM to reclaim space: sqlite3 database/aptimesheet.db "VACUUM;"'
    ] : []
  });

  // 12. Locked / failed-login-spike accounts — accounts currently locked OR
  //     with >10 failed attempts in last 24h that aren't yet locked. Signals
  //     brute-force attempt or a user struggling to remember their password.
  let lockedAccounts = 0, recentFailures = 0;
  try {
    lockedAccounts = db.prepare(`
      SELECT COUNT(*) AS c FROM users
      WHERE locked_until IS NOT NULL AND datetime(locked_until) > datetime('now')
    `).get().c;
    recentFailures = db.prepare(`
      SELECT COUNT(*) AS c FROM login_history
      WHERE success = 0 AND attempted_at > datetime('now','-1 day')
    `).get().c;
  } catch(_) {}
  const securitySignal = lockedAccounts > 0 || recentFailures > 20;
  add({
    name: 'Account lockouts / brute-force attempts',
    category: 'security',
    severity: securitySignal ? 'warning' : 'info',
    ok: !securitySignal,
    detail: securitySignal
      ? `${lockedAccounts} account(s) currently locked, ${recentFailures} failed login(s) in last 24h. Review the Activity / Login History tab.`
      : `${recentFailures} failed login(s) in last 24h — within normal range.`,
    fix_code: lockedAccounts > 0 ? 'unlock_all_accounts' : null,
    manual_steps: lockedAccounts > 0 ? [
      'Review Login History tab to confirm these are legitimate users, not attacks',
      'Per-user unlock: open Masters → Users → click the user → Reset Lockout',
      'Or use the auto-fix to clear all lockouts (if you trust the situation)'
    ] : []
  });

  writeAuditLog(req, 'system_scan_run', 'system', null,
    `${report.checks.filter(c => c.ok).length}/${report.checks.length} checks passed`);

  res.json(report);
});

// ── 🔧 Auto-fix endpoint — applies a whitelisted remediation by fix_code ─
// Each fix is small, idempotent, and audit-logged. Anything more invasive
// (DB rebuild, restore from backup) is intentionally manual-only.
router.post('/scan/auto-fix', authRequired, requirePermission('system.settings'), (req, res) => {
  const fixCode = (req.body && req.body.fix_code) || '';
  const result = { fix_code: fixCode, ok: false, message: '', details: null };

  try {
    switch (fixCode) {
      case 'purge_expired_sessions': {
        const r = db.prepare(`
          DELETE FROM sessions
          WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')
        `).run();
        result.ok = true;
        result.message = `Purged ${r.changes} expired session(s).`;
        result.details = { rows_deleted: r.changes };
        break;
      }

      case 'wal_checkpoint': {
        const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
        result.ok = true;
        result.message = `WAL checkpoint complete. ${JSON.stringify(r[0] || {})}`;
        result.details = r[0] || null;
        break;
      }

      case 'unlock_all_accounts': {
        const r = db.prepare(`
          UPDATE users SET locked_until = NULL, failed_login_count = 0
          WHERE locked_until IS NOT NULL
        `).run();
        result.ok = true;
        result.message = `Unlocked ${r.changes} account(s) and reset their failed-login counters.`;
        result.details = { accounts_unlocked: r.changes };
        break;
      }

      case 'reindex_db': {
        // Safe: rebuilds indexes from base tables. Doesn't touch row data.
        db.prepare('REINDEX').run();
        result.ok = true;
        result.message = 'All indexes rebuilt successfully.';
        break;
      }

      case 'archive_old_audit': {
        // Soft archive: copy rows older than 1 year to audit_log_archive,
        // then delete from main table. Creates the archive table if needed.
        db.prepare(`
          CREATE TABLE IF NOT EXISTS audit_log_archive AS SELECT * FROM audit_log WHERE 0
        `).run();
        const tx = db.transaction(() => {
          const moved = db.prepare(`
            INSERT INTO audit_log_archive
            SELECT * FROM audit_log WHERE created_at < datetime('now','-365 days')
          `).run();
          const deleted = db.prepare(`
            DELETE FROM audit_log WHERE created_at < datetime('now','-365 days')
          `).run();
          return { moved: moved.changes, deleted: deleted.changes };
        });
        const r = tx();
        result.ok = true;
        result.message = `Archived ${r.moved} audit row(s) to audit_log_archive table; deleted ${r.deleted} from primary.`;
        result.details = r;
        break;
      }

      case 'run_backup_now': {
        // Trigger ops/backup.ps1 in the background. We don't block on it —
        // the user can refresh the scan in a few seconds to see updated freshness.
        const { spawn } = require('child_process');
        const scriptPath = path.resolve(__dirname, '..', 'ops', 'backup.ps1');
        if (!fs.existsSync(scriptPath)) {
          result.ok = false;
          result.message = 'ops/backup.ps1 not found. Run a manual backup or reinstall the backup scripts.';
          break;
        }
        spawn('powershell.exe',
          ['-NoProfile','-ExecutionPolicy','Bypass','-File', scriptPath],
          { detached: true, stdio: 'ignore', windowsHide: true }
        ).unref();
        result.ok = true;
        result.message = 'Backup triggered in the background. Re-run the scan in 30-60 seconds to verify freshness.';
        break;
      }

      case 'rotate_jwt_secret':
        // Refused: this is genuinely dangerous (logs out every user, breaks
        // any in-flight automation) and writes to .env which the process
        // typically cannot modify on production Windows installs. Manual only.
        result.ok = false;
        result.message = 'JWT secret rotation must be done manually. See the manual steps shown alongside this check.';
        break;

      default:
        return res.status(400).json({ error: 'Unknown fix_code: ' + fixCode });
    }

    writeAuditLog(req, 'system_auto_fix', 'system', null,
      `fix_code=${fixCode}; ok=${result.ok}; ${result.message}`);
    res.json(result);
  } catch (e) {
    result.ok = false;
    result.message = 'Auto-fix failed: ' + (e.message || String(e));
    writeAuditLog(req, 'system_auto_fix_failed', 'system', null,
      `fix_code=${fixCode}; error=${e.message}`);
    res.status(500).json(result);
  }
});

module.exports = router;
