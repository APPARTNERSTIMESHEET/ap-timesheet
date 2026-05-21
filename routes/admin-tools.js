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

// ── 🔍 Scan (DB integrity + orphan record detection) ─────────────────────
router.post('/scan', authRequired, requirePermission('system.settings'), (req, res) => {
  const report = { ok: true, checks: [] };

  // 1. SQLite integrity check — corrupted pages, index inconsistencies, etc.
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const verdict = rows.length === 1 && rows[0].integrity_check === 'ok';
    report.checks.push({
      name: 'DB integrity',
      ok: verdict,
      detail: verdict ? 'All pages and indexes consistent.' : rows.map(r => r.integrity_check).join('; ')
    });
    if (!verdict) report.ok = false;
  } catch (e) {
    report.checks.push({ name: 'DB integrity', ok: false, detail: 'Error: ' + e.message });
    report.ok = false;
  }

  // 2. Foreign key check
  try {
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    report.checks.push({
      name: 'Foreign keys',
      ok: fk.length === 0,
      detail: fk.length === 0 ? 'No FK violations.' : `${fk.length} FK violation(s) found.`
    });
    if (fk.length) report.ok = false;
  } catch(e) {
    report.checks.push({ name: 'Foreign keys', ok: false, detail: e.message });
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
  report.checks.push({
    name: 'Orphan invoice items',
    ok: orphans === 0,
    detail: orphans === 0
      ? 'All line items are either linked to a matter/lawyer or recognised as a custom charge.'
      : `${orphans} item(s) have no matter/user link and aren't clearly a custom expense. Run ops/relink-orphan-invoice-items.js.`
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
  report.checks.push({
    name: 'Daily backup freshness',
    ok: lastBackupHours != null && lastBackupHours < 36,
    detail: lastBackupHours == null
      ? 'No backup files found in ' + dir
      : `Latest backup: ${lastBackupFile} — ${lastBackupHours} hours old.`
  });

  // 5. Users without a default rate (often the cause of zero-fee bugs)
  const zeroRate = db.prepare(`
    SELECT COUNT(*) AS c FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.code IN ('associate', 'admin', 'super_admin') AND u.is_active = 1
      AND u.deleted_at IS NULL
      AND (u.default_rate IS NULL OR u.default_rate = 0)
  `).get().c;
  report.checks.push({
    name: 'Lawyers with ₹0 default rate',
    ok: true,    // informational, not a failure
    detail: zeroRate === 0
      ? 'All active lawyers have a non-zero default rate.'
      : `${zeroRate} active lawyer(s) have default_rate = 0. Set rates via Masters > Users or use Rate Cards / per-invoice edits.`
  });

  writeAuditLog(req, 'system_scan_run', 'system', null,
    `${report.checks.filter(c => c.ok).length}/${report.checks.length} checks passed`);

  res.json(report);
});

module.exports = router;
