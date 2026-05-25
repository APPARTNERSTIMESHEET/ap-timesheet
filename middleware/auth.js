const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../utils/db');

// Refuse the insecure fallback in production. In development we allow a default
// so the dev experience is not broken, but the server logs a loud warning.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production'
  ? (() => { throw new Error('JWT_SECRET is not set — refusing to start in production with a default secret'); })()
  : (console.warn('[auth] WARNING: JWT_SECRET not set — using an insecure development default'), 'dev-secret-change-me'));
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

if (process.env.NODE_ENV === 'production' && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET is too short for production (need at least 32 characters of randomness)');
}

function signToken(user, options = {}) {
  const payload = { id: user.id, role: user.role, email: user.email, name: user.full_name };
  // Impersonation tokens carry the original super_admin's id so audit can stamp both actors.
  if (options.impersonator_id) payload.impersonator_id = options.impersonator_id;
  // Optional short-lived expiry for impersonation tokens (15 min default).
  const expiresIn = options.expiresIn || JWT_EXPIRES_IN;
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

// ── Load the full permission set for a user ─────────────────────────────────
// Combines role permissions (via role_permissions table) with per-user
// overrides (via user_permissions). Falls back to the legacy `role` text for
// users created before the RBAC migration ran.
function loadUserPermissions(user) {
  if (!user) return new Set();
  const perms = new Set();
  // Permissions granted via the user's role.
  if (user.role_id) {
    const rows = db.prepare(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`
    ).all(user.role_id);
    for (const r of rows) perms.add(r.code);
  }
  // Per-user grant overrides (additive on top of role).
  const overrides = db.prepare(
    `SELECT p.code FROM user_permissions up
     JOIN permissions p ON p.id = up.permission_id
     WHERE up.user_id = ?`
  ).all(user.id);
  for (const r of overrides) perms.add(r.code);
  return perms;
}

function authRequired(req, res, next) {
  // Accept token from Authorization header OR ?token= query param (for PDF/file downloads)
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const tokenStr = m ? m[1] : (req.query.token || null);
  if (!tokenStr) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(tokenStr, JWT_SECRET);
    const user = db.prepare(
      `SELECT u.id, u.email, u.full_name, u.role, u.role_id, u.is_active,
              u.deleted_at, u.locked_until,
              r.code AS role_code, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    ).get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'User inactive' });

    // Refuse access if account is soft-deleted (recycle bin) — even if the
    // token is still valid. Super admin restores them from the bin to re-enable.
    if (user.deleted_at) return res.status(401).json({ error: 'Account suspended' });

    // Refuse access if account is locked (too many failed login attempts).
    if (user.locked_until) {
      const lockedUntil = new Date(user.locked_until + 'Z');
      if (Date.now() < lockedUntil.getTime()) {
        return res.status(423).json({ error: 'Account locked' });
      }
    }

    // Check if this token's session was force-revoked by super_admin.
    try {
      const tokenHash = crypto.createHash('sha256').update(tokenStr).digest('hex');
      const sess = db.prepare(
        'SELECT revoked_at FROM active_sessions WHERE token_hash = ?'
      ).get(tokenHash);
      if (sess && sess.revoked_at) {
        return res.status(401).json({ error: 'Session has been revoked. Please login again.' });
      }
    } catch (_) { /* active_sessions table might not exist yet during migration — ignore */ }

    req.user = user;
    // Eager-load permissions onto req.user for cheap requirePermission() checks.
    req.user.permissions = loadUserPermissions(user);

    // Impersonation: super_admin can "act as" another user. The JWT carries the
    // real super_admin id in `impersonator_id`; we surface it on req so the
    // audit logger can stamp both actors.
    if (payload.impersonator_id) {
      const impersonator = db.prepare(
        'SELECT id, email, full_name FROM users WHERE id = ?'
      ).get(payload.impersonator_id);
      if (impersonator) req.impersonator = impersonator;
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Roles that can access admin-level routes (LEGACY — being phased out in
// favour of requirePermission). Kept so existing routes keep working until
// they're migrated one-by-one.
const ADMIN_ROLES = ['admin', 'billing', 'super_admin', 'hr'];

function adminOnly(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Admin only' });
  // Honor either the new role code or the legacy role text. super_admin / hr
  // / partner_view didn't exist in the legacy column, so we check role_code too.
  const r = req.user.role_code || req.user.role;
  if (!ADMIN_ROLES.includes(r)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ── User-management privilege gate (stricter than adminOnly) ─────────────────
// Only super_admin and admin can manage users (create/update/delete + change
// roles). Billing and HR roles are explicitly EXCLUDED -- billing should not
// be able to escalate themselves or others to admin/super_admin, which would
// be a classic privilege escalation. HR can manage employee profiles via
// leaves/wfh modules but not core user records.
const USER_MGMT_ROLES = ['admin', 'super_admin'];

// ── super-admin-only gate (strictest tier) ──────────────────────────────────
// For destructive / compliance-sensitive actions that should NEVER be available
// to anyone except the firm's super-admin: hard-deleting invoices, editing
// already-issued/paid invoices, etc. Use sparingly.
function superAdminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const r = req.user.role_code || req.user.role;
  if (r !== 'super_admin') {
    return res.status(403).json({
      error: 'This action is restricted to super-admin only. It bypasses standard compliance guards (issued/paid invoice locking, no-hard-delete policy) and is audit-logged with a before/after snapshot.'
    });
  }
  next();
}

function userManagementOnly(req, res, next) {
  if (!req.user) return res.status(403).json({ error: 'Not authenticated' });
  const r = req.user.role_code || req.user.role;
  if (!USER_MGMT_ROLES.includes(r)) {
    return res.status(403).json({
      error: 'User management is restricted to admin and super_admin only. Your role is not authorised for this action.'
    });
  }
  next();
}

// ── Role-assignment hierarchy check ──────────────────────────────────────────
// Enforces the rule:
//   - Only super_admin can assign super_admin role to any user.
//   - Only super_admin can assign admin role (prevents admins from creating
//     more admins without super_admin oversight).
//   - admin/super_admin can assign all OTHER roles (billing/hr/associate/etc).
//
// Returns null if allowed, or an error object { status, error } if blocked.
function checkRoleAssignment(actor, targetRoleCode) {
  if (!targetRoleCode) return null;  // no role change requested
  const actorRole = actor.role_code || actor.role;

  // super_admin role: only super_admin can assign
  if (targetRoleCode === 'super_admin') {
    if (actorRole !== 'super_admin') {
      return {
        status: 403,
        error: 'Only a super_admin can assign the super_admin role. This protects against privilege escalation.'
      };
    }
  }
  // admin role: only super_admin can assign (admins cannot create more admins)
  else if (targetRoleCode === 'admin') {
    if (actorRole !== 'super_admin') {
      return {
        status: 403,
        error: 'Only a super_admin can assign the admin role.'
      };
    }
  }
  // Other roles (billing/hr/partner_view/associate): admin or super_admin
  else {
    if (!['admin', 'super_admin'].includes(actorRole)) {
      return {
        status: 403,
        error: `Only admin or super_admin can assign roles. Your current role is "${actorRole}".`
      };
    }
  }
  return null;
}

// ── NEW: Permission-based gate ───────────────────────────────────────────────
// Use this instead of adminOnly for any new route. Accepts one permission code
// or an array of permission codes; passes if the user has at least one of them.
//
//   router.delete('/users/:id', authRequired, requirePermission('users.delete'), handler)
//
// Super admin implicitly has all permissions, so we don't have to list every
// permission for them.
function requirePermission(perms) {
  const needed = Array.isArray(perms) ? perms : [perms];
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role_code === 'super_admin') return next();
    const granted = req.user.permissions || new Set();
    if (needed.some(p => granted.has(p))) return next();
    return res.status(403).json({
      error: `Missing permission: ${needed.join(' or ')}`
    });
  };
}

// Inline check (handy inside a route handler when permission gating depends on
// the request body — e.g. allow if owner, or if user has the permission).
function userHas(req, ...perms) {
  if (!req.user) return false;
  if (req.user.role_code === 'super_admin') return true;
  const granted = req.user.permissions || new Set();
  return perms.some(p => granted.has(p));
}

// ── Audit log writer ─────────────────────────────────────────────────────────
// Two call styles, both supported for backward compatibility:
//   writeAuditLog(userId, action, entity, entityId, detail)       — legacy
//   writeAuditLog(req,    action, entity, entityId, detail)       — preferred
// The req form captures user name/email and any impersonator at log time, so
// the forensic trail survives even if the user is later hard-deleted and
// audit_log.user_id ends up NULL.
function writeAuditLog(actorOrUserId, action, entity, entityId, detail) {
  try {
    const { db } = require('../utils/db');
    let userId = null, userEmail = null, userName = null, impersonatedBy = null;
    if (actorOrUserId && typeof actorOrUserId === 'object' && actorOrUserId.user) {
      // Called with a req object — extract everything we can.
      const req = actorOrUserId;
      userId    = req.user.id;
      userEmail = req.user.email;
      userName  = req.user.full_name;
      if (req.impersonator) impersonatedBy = req.impersonator.id;
    } else {
      // Called with a plain user id (legacy).
      userId = actorOrUserId;
      try {
        const u = db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(userId);
        if (u) { userEmail = u.email; userName = u.full_name; }
      } catch(_) {}
    }
    db.prepare(
      "INSERT INTO audit_log(user_id, user_email, user_name, action, entity, entity_id, detail, impersonated_by) VALUES (?,?,?,?,?,?,?,?)"
    ).run(userId, userEmail, userName, action, entity || null, entityId || null, detail || null, impersonatedBy);
  } catch(e) { /* non-blocking */ }
}

// ── Notify admins of billing-role actions ────────────────────────────────────
// 1. Always writes to audit_log (permanent record)
// 2. Sends email to admins if SMTP is configured and actor is billing role
function notifyAdminsOfBillingAction(req, action, detail, entity, entityId) {
  if (!req.user) return;

  // Always write to audit log -- this is the silent paper trail. The actor's
  // name, email, IP, and impersonator (if any) are captured by writeAuditLog.
  writeAuditLog(req, action, entity || 'invoice', entityId || null, detail);

  // AUTOMATIC email notifications are DISABLED per firm policy. The audit log
  // captures everything for review, and admins explicitly compose email
  // notifications via the "📧 Notify" button when they actually want one sent.
  // (Previous behaviour sent an email to every admin on every billing action,
  // which produced inbox spam and could not be turned off per-user.)
  return;
}

module.exports = {
  signToken, authRequired, adminOnly, userManagementOnly, superAdminOnly, checkRoleAssignment,
  requirePermission, userHas, loadUserPermissions,
  notifyAdminsOfBillingAction, writeAuditLog,
  JWT_SECRET
};
