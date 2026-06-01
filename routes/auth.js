const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
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
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.designation, u.allowed_tabs,
            u.totp_secret, u.totp_enabled,
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

  // ── Case 5: Password verified. If user has 2FA enabled, demand TOTP code
  //   before issuing the session token. Two flows:
  //   - First call (no code yet): respond with { need_2fa: true } + a short-
  //     lived "challenge" token (5 min) the client returns with the code.
  //   - Second call (code present): verify TOTP + issue real session token.
  //
  //   Backup codes are 8-char single-use strings; if a user lost their phone,
  //   they can submit a backup code in place of the TOTP. Used backup codes
  //   are stripped from totp_backup_codes so they can't replay. ──
  const submittedCode = (req.body.totp_code || '').toString().trim();
  if (user.totp_enabled && user.totp_secret) {
    if (!submittedCode) {
      // First step — tell client to ask for the TOTP code. The client will
      // re-POST to /api/auth/login with same email+password PLUS totp_code.
      return res.json({ need_2fa: true });
    }
    // Verify TOTP. Allow ±1 step (30s) drift for clock skew.
    let codeOk = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: submittedCode.replace(/\s/g, ''),
      window: 1
    });
    // If TOTP fails, try backup codes.
    let usedBackup = null;
    if (!codeOk) {
      try {
        const codes = JSON.parse(user.totp_backup_codes || '[]');
        const idx = codes.indexOf(submittedCode.toUpperCase());
        if (idx >= 0) {
          codes.splice(idx, 1);   // consume code
          db.prepare('UPDATE users SET totp_backup_codes = ? WHERE id = ?')
            .run(JSON.stringify(codes), user.id);
          codeOk = true;
          usedBackup = true;
        }
      } catch (_) {}
    }
    if (!codeOk) {
      handleFailedLogin(user);
      recordLoginAttempt(email, ip, ua, false, '2fa_invalid_code');
      return res.status(401).json({ error: 'Invalid 2FA code. Try again or use a backup code.' });
    }
    if (usedBackup) {
      writeAuditLog(user.id, '2fa_backup_code_used', 'user', user.id,
        'Backup code consumed at login from IP ' + ip);
    }
  }

  // Case 5b: All checks passed.
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
      designation: user.designation,
      // Per-user panel-access override (CSV of tab IDs). When non-null, the
      // frontend uses ONLY these tabs instead of the role's default set.
      allowed_tabs: user.allowed_tabs || null
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

// ════════════════════════════════════════════════════════════════════════
// 2FA / TOTP endpoints
// ════════════════════════════════════════════════════════════════════════

// Generate a fresh TOTP secret + QR code image for the logged-in user.
// User scans the QR with Google Authenticator / Microsoft Authenticator,
// then calls /2fa/verify-setup with the first generated 6-digit code to
// activate. Secret is staged (not enabled) until verified — so an interrupted
// setup doesn't lock anyone out.
router.post('/2fa/setup', authRequired, async (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totp_enabled) {
      return res.status(400).json({ error: '2FA already enabled. Disable first to re-enrol.' });
    }

    // Generate base32 secret (160 bits = 32 chars — RFC 6238 recommendation)
    const secret = speakeasy.generateSecret({
      name: `AP Partners (${user.email})`,
      issuer: 'AP Partners',
      length: 20
    });

    // Stage the secret (not enabled until verified)
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);

    // Generate QR code as data URL (PNG embedded as base64)
    const qrDataURL = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      secret: secret.base32,               // for manual entry option
      otpauth_url: secret.otpauth_url,     // app-compatible URL
      qr_data_url: qrDataURL,               // <img src="..."> ready
      message: 'Scan the QR code in Google/Microsoft Authenticator, then verify with the first 6-digit code.'
    });
  } catch (e) {
    res.status(500).json({ error: '2FA setup failed: ' + e.message });
  }
});

// Verify the first TOTP code + activate 2FA. Returns 10 backup codes for
// the user to download / print and store offline. Each backup code is
// single-use (consumed when used to log in).
router.post('/2fa/verify-setup', authRequired, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: 'Run /2fa/setup first to generate a secret.' });
  }
  if (user.totp_enabled) return res.status(400).json({ error: '2FA already enabled.' });

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 1
  });
  if (!verified) return res.status(400).json({ error: 'Code did not match. Re-scan QR and try the latest 6-digit code.' });

  // Generate 10 backup codes (8 chars each, uppercased alphanumeric)
  const backupCodes = [];
  for (let i = 0; i < 10; i++) {
    backupCodes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }

  db.prepare(`
    UPDATE users
    SET totp_enabled = 1,
        totp_backup_codes = ?,
        totp_enrolled_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(backupCodes), req.user.id);

  writeAuditLog(req.user.id, '2fa_enabled', 'user', req.user.id,
    'Enrolled via authenticator app');

  res.json({
    ok: true,
    backup_codes: backupCodes,
    message: 'SAVE these 10 backup codes offline. Each can be used ONCE if you lose your phone.'
  });
});

// Disable 2FA. Requires current password to prevent CSRF + over-the-shoulder
// disable. Audit-logged.
router.post('/2fa/disable', authRequired, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Current password required to disable 2FA' });

  const user = db.prepare('SELECT password_hash, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA not currently enabled' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  db.prepare(`
    UPDATE users
    SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_enrolled_at = NULL
    WHERE id = ?
  `).run(req.user.id);

  writeAuditLog(req.user.id, '2fa_disabled', 'user', req.user.id, 'Disabled by user');
  res.json({ ok: true, message: '2FA has been disabled. Re-enrol anytime via /2fa/setup.' });
});

// Check current 2FA status for the logged-in user (used by the settings UI).
router.get('/2fa/status', authRequired, (req, res) => {
  const user = db.prepare(
    'SELECT totp_enabled, totp_enrolled_at, totp_backup_codes FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let remainingBackup = 0;
  try { remainingBackup = JSON.parse(user.totp_backup_codes || '[]').length; } catch (_) {}
  res.json({
    enabled: !!user.totp_enabled,
    enrolled_at: user.totp_enrolled_at,
    backup_codes_remaining: remainingBackup
  });
});

module.exports = router;
