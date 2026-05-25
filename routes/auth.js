const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('../utils/db');
const { signToken, authRequired, writeAuditLog } = require('../middleware/auth');

const router = express.Router();

// ─── Security constants ──────────────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;           // lock after 5 consecutive failures
const LOCKOUT_DURATION_MIN = 15;         // lock for 15 minutes
const LOGIN_HISTORY_WINDOW_MIN = 30;     // track failures within 30-minute window

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Record a login attempt (success or failure) for forensic analysis. */
function recordLoginAttempt(email, ip, userAgent, success, failureReason) {
  try {
    db.prepare(
      `INSERT INTO login_attempts (email, ip_address, user_agent, success, failure_reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(email, ip || null, userAgent || null, success ? 1 : 0, failureReason || null);
  } catch (_) { /* non-blocking — never crash login for logging failure */ }
}

/** Check if an account is locked due to too many failed attempts. */
function isAccountLocked(user) {
  if (!user || !user.locked_until) return false;
  const lockedUntil = new Date(user.locked_until + 'Z');
  if (Date.now() < lockedUntil.getTime()) return true;
  // Lock expired — reset
  try {
    db.prepare('UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = ?')
      .run(user.id);
  } catch (_) {}
  return false;
}

/** Increment failed login count and lock the account if threshold reached. */
function handleFailedLogin(user) {
  if (!user) return;
  try {
    const newCount = (user.failed_login_count || 0) + 1;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MIN * 60 * 1000)
        .toISOString().replace('Z', '').replace('T', ' ').split('.')[0];
      db.prepare(
        'UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?'
      ).run(newCount, lockUntil, user.id);
    } else {
      db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?')
        .run(newCount, user.id);
    }
  } catch (_) {}
}

/** Reset failed login count on successful login and update last_login. */
function handleSuccessfulLogin(user, ip) {
  try {
    const now = new Date().toISOString().replace('Z', '').replace('T', ' ').split('.')[0];
    db.prepare(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL,
              last_login_at = ?, last_login_ip = ? WHERE id = ?`
    ).run(now, ip || null, user.id);
  } catch (_) {}
}

/** Password strength validation. */
function validatePasswordStrength(password) {
  const errors = [];
  if (!password || password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('at least one uppercase letter (A-Z)');
  if (!/[a-z]/.test(password)) errors.push('at least one lowercase letter (a-z)');
  if (!/[0-9]/.test(password)) errors.push('at least one number (0-9)');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('at least one special character (!@#$%^&*)');
  return errors;
}

// ─── Login ───────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip || req.connection.remoteAddress;
  const ua = req.headers['user-agent'] || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email & password required' });
  }

  // Find user (include security fields + role_code from joined roles table)
  const user = db.prepare(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.designation,
            u.failed_login_count, u.locked_until, u.is_active, u.deleted_at,
            r.code AS role_code, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.email = ? COLLATE NOCASE`
  ).get(email);

  // Case 1: No user found
  if (!user) {
    recordLoginAttempt(email, ip, ua, false, 'invalid_email');
    // Don't reveal whether email exists — same error message
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Case 2: User is inactive or soft-deleted
  if (!user.is_active || user.deleted_at) {
    recordLoginAttempt(email, ip, ua, false, 'inactive');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Case 3: Account is locked
  if (isAccountLocked(user)) {
    recordLoginAttempt(email, ip, ua, false, 'account_locked');
    const remainingMin = Math.ceil(
      (new Date(user.locked_until + 'Z').getTime() - Date.now()) / 60000
    );
    return res.status(423).json({
      error: `Account temporarily locked due to too many failed attempts. Try again in ${remainingMin} minute(s).`,
      locked: true,
      retry_after_minutes: remainingMin
    });
  }

  // Case 4: Wrong password
  if (!bcrypt.compareSync(password, user.password_hash)) {
    handleFailedLogin(user);
    recordLoginAttempt(email, ip, ua, false, 'wrong_password');

    const remaining = MAX_FAILED_ATTEMPTS - ((user.failed_login_count || 0) + 1);
    const warn = remaining <= 2 && remaining > 0
      ? ` (${remaining} attempt(s) remaining before lockout)`
      : remaining === 0
        ? ' (Account is now locked for 15 minutes)'
        : '';

    return res.status(401).json({ error: `Invalid credentials${warn}` });
  }

  // Case 5: Success!
  handleSuccessfulLogin(user, ip);
  recordLoginAttempt(email, ip, ua, true, null);

  // Generate token and hash it for session tracking
  const token = signToken(user);
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 8 * 3600000) // 8h default
      .toISOString().replace('Z', '').replace('T', ' ').split('.')[0];
    db.prepare(
      `INSERT INTO active_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(user.id, tokenHash, ip, ua, expiresAt);
  } catch (_) { /* non-blocking */ }

  // Audit log
  writeAuditLog(user.id, 'LOGIN', 'user', user.id, `IP: ${ip}`);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,                  // legacy text role (admin/associate/billing)
      role_code: user.role_code,        // new RBAC role code (super_admin/hr/partner_view/etc.)
      role_name: user.role_name,        // human-readable role name
      designation: user.designation
    }
  });
});

// ─── Get current user ────────────────────────────────────────────────────────
router.get('/me', authRequired, (req, res) => {
  const u = db.prepare(
    'SELECT id, email, full_name, role, designation, default_rate FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json({ user: u });
});

// ─── Change password ─────────────────────────────────────────────────────────
router.post('/change-password', authRequired, (req, res) => {
  // Per firm policy: plain associates cannot change their own password.
  // HR / admin handles all resets via the Super Admin panel's "Force Reset
  // Password" button. Defense in depth — blocked at the route too so anyone
  // crafting a direct API call (curl / Postman) also gets refused.
  const role = req.user.role_code || req.user.role;
  if (role === 'associate') {
    return res.status(403).json({
      error: 'Self-service password change is disabled. Please contact HR / Admin to reset your password.'
    });
  }
  const { current_password, new_password } = req.body || {};

  // Password strength validation
  const strengthErrors = validatePasswordStrength(new_password);
  if (strengthErrors.length > 0) {
    return res.status(400).json({
      error: `Password must have: ${strengthErrors.join(', ')}`
    });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(hash, req.user.id);

  writeAuditLog(req, 'CHANGE_PASSWORD', 'user', req.user.id, 'Self-service password change');

  res.json({ ok: true });
});

// ─── Login history (super admin) ─────────────────────────────────────────────
router.get('/login-history', authRequired, (req, res) => {
  // Only super_admin can view login history
  const role = req.user.role_code || req.user.role;
  if (role !== 'super_admin' && role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const email = req.query.email || null;

  let sql = `SELECT la.*, u.full_name
             FROM login_attempts la
             LEFT JOIN users u ON u.email = la.email COLLATE NOCASE`;
  const params = [];

  if (email) {
    sql += ' WHERE la.email = ? COLLATE NOCASE';
    params.push(email);
  }
  sql += ' ORDER BY la.attempted_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json({ login_history: rows });
});

// ─── Active sessions (super admin) ───────────────────────────────────────────
router.get('/active-sessions', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin only' });
  }

  const rows = db.prepare(
    `SELECT s.id, s.user_id, u.full_name, u.email, s.ip_address, s.user_agent,
            s.created_at, s.expires_at, s.revoked_at
     FROM active_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.revoked_at IS NULL AND s.expires_at > datetime('now')
     ORDER BY s.created_at DESC`
  ).all();
  res.json({ sessions: rows });
});

// ─── Revoke session (force logout) ───────────────────────────────────────────
router.post('/sessions/:id/revoke', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin only' });
  }

  const session = db.prepare('SELECT * FROM active_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare('UPDATE active_sessions SET revoked_at = datetime(\'now\') WHERE id = ?')
    .run(req.params.id);

  writeAuditLog(req, 'REVOKE_SESSION', 'session', session.id,
    `Force-logged out user_id=${session.user_id}`);

  res.json({ ok: true });
});

// ─── Unlock account (super admin) ────────────────────────────────────────────
router.post('/users/:id/unlock', authRequired, (req, res) => {
  const role = req.user.role_code || req.user.role;
  if (role !== 'super_admin' && role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const target = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?')
    .get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?')
    .run(target.id);

  writeAuditLog(req, 'UNLOCK_ACCOUNT', 'user', target.id,
    `Unlocked account for ${target.full_name} (${target.email})`);

  res.json({ ok: true, message: `Account unlocked for ${target.full_name}` });
});

module.exports = router;
