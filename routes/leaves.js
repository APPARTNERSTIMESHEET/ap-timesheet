/**
 * Leave management — types, balances, applications, holidays.
 *
 * Roles:
 *   - associate: apply for leave, view own balance/history, cancel own pending
 *                applications, view holiday calendar, view who's on leave.
 *   - admin    : everything above, plus manage leave types, allocate balances,
 *                approve/reject applications, manage holiday calendar.
 *   - billing  : treated as admin-equivalent for leave operations (consistent
 *                with how billing handles other approval-style flows).
 */
const express = require('express');
const { db } = require('../utils/db');
const { authRequired, adminOnly, writeAuditLog } = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ───────────────────────────────────────────────────────────────
function isAdminLike(user) {
  if (!user) return false;
  // Check both new role_code and legacy role text. super_admin / hr inherit
  // admin-like leave-management privileges. This is intentionally broad so
  // super_admin gets god-mode (cancel anyone's leave, view all applications).
  const code = user.role_code || user.role;
  return ['admin', 'billing', 'super_admin', 'hr'].includes(code);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function yearOf(iso) { return parseInt(String(iso).slice(0, 4), 10); }

// Compute leave days between two ISO dates (inclusive). Behaviour depends on
// the leave type's count_method:
//   - 'working_days'  (default): skip weekends and public holidays
//   - 'calendar_days' (e.g. maternity per Maternity Benefit Act 1961): count
//      every day in the range including weekends and holidays
// Half-day requests always count as 0.5 (caller validates single-day range).
function computeLeaveDays(fromIso, toIso, halfDaySession, countMethod) {
  if (toIso < fromIso) return 0;
  if (halfDaySession && halfDaySession !== 'full') return 0.5;

  const start = new Date(fromIso + 'T00:00:00');
  const end   = new Date(toIso   + 'T00:00:00');

  if (countMethod === 'calendar_days') {
    return Math.round((end - start) / 86400000) + 1;
  }

  // working_days (default)
  const holidayRows = db.prepare(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND is_optional = 0'
  ).all(fromIso, toIso);
  const holidaySet = new Set(holidayRows.map(r => r.holiday_date));
  let days = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();              // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (holidaySet.has(iso)) continue;
    days += 1;
  }
  return days;
}

// Atomically reserve / consume / release balance against an application.
// All callers run inside db.transaction(). Pending = submitted but undecided.
function ensureBalanceRow(userId, leaveTypeId, year) {
  let row = db.prepare(
    'SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?'
  ).get(userId, leaveTypeId, year);
  if (!row) {
    // Auto-create using the leave type's default quota — so a freshly added
    // associate doesn't have to wait for an explicit allocation before they
    // can see their entitlement.
    const lt = db.prepare('SELECT default_annual_quota FROM leave_types WHERE id = ?').get(leaveTypeId);
    const quota = (lt && lt.default_annual_quota) || 0;
    db.prepare(
      `INSERT INTO leave_balances (user_id, leave_type_id, year, allocated)
       VALUES (?, ?, ?, ?)`
    ).run(userId, leaveTypeId, year, quota);
    row = db.prepare(
      'SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?'
    ).get(userId, leaveTypeId, year);
  }
  return row;
}

function availableBalance(bal) {
  return (bal.allocated + bal.carried_forward) - bal.used - bal.pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE TYPES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/types', authRequired, (req, res) => {
  const includeInactive = req.query.all === '1' && isAdminLike(req.user);
  const rows = db.prepare(
    includeInactive
      ? 'SELECT * FROM leave_types ORDER BY name'
      : 'SELECT * FROM leave_types WHERE is_active = 1 ORDER BY name'
  ).all();
  res.json({ types: rows });
});

router.post('/types', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'code and name required' });
  const countMethod = (b.count_method === 'calendar_days') ? 'calendar_days' : 'working_days';
  try {
    const info = db.prepare(
      `INSERT INTO leave_types (code, name, default_annual_quota, is_paid, carry_forward, max_carry_forward, color, count_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(b.code).toUpperCase(), b.name,
      Number(b.default_annual_quota || 0),
      b.is_paid === false || b.is_paid === 0 ? 0 : 1,
      b.carry_forward ? 1 : 0,
      Number(b.max_carry_forward || 0),
      b.color || '#3b82f6',
      countMethod
    );
    writeAuditLog(req.user.id, 'leave_type_create', 'leave_type', info.lastInsertRowid, b.code);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Code already exists' });
    throw e;
  }
});

router.patch('/types/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['name', 'default_annual_quota', 'is_paid', 'carry_forward', 'max_carry_forward', 'color', 'is_active', 'count_method'];
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k];
      if (['is_paid', 'carry_forward', 'is_active'].includes(k)) v = v ? 1 : 0;
      if (k === 'count_method') v = (v === 'calendar_days') ? 'calendar_days' : 'working_days';
      fields.push(`${k} = ?`); values.push(v);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  values.push(id);
  db.prepare(`UPDATE leave_types SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  writeAuditLog(req.user.id, 'leave_type_update', 'leave_type', id, JSON.stringify(req.body));
  res.json({ ok: true });
});

router.delete('/types/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Soft-delete only — preserves historical balances and applications.
  db.prepare('UPDATE leave_types SET is_active = 0 WHERE id = ?').run(id);
  writeAuditLog(req.user.id, 'leave_type_deactivate', 'leave_type', id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// BALANCES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/balances', authRequired, (req, res) => {
  const year = parseInt(req.query.year || yearOf(todayISO()), 10);
  const wantUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  // Non-admins can only see their own balances.
  const userId = isAdminLike(req.user) ? (wantUserId || null) : req.user.id;

  const where = ['lb.year = ?']; const params = [year];
  if (userId) { where.push('lb.user_id = ?'); params.push(userId); }

  const rows = db.prepare(`
    SELECT lb.*, lt.code AS type_code, lt.name AS type_name, lt.is_paid, lt.color,
           u.full_name AS user_name, u.email AS user_email
    FROM leave_balances lb
    JOIN leave_types lt ON lt.id = lb.leave_type_id
    JOIN users u        ON u.id  = lb.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY u.full_name, lt.name
  `).all(...params);

  // Attach `available` for convenience.
  for (const r of rows) r.available = (r.allocated + r.carried_forward) - r.used - r.pending;
  res.json({ balances: rows, year });
});

// Bulk allocate: pick a leave type + year + list of user ids (or "all active")
// and apply either the type's default quota or a specific amount. Used by admin
// at the start of a calendar year.
router.post('/balances/allocate', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  const year = parseInt(b.year || yearOf(todayISO()), 10);
  const leaveTypeId = parseInt(b.leave_type_id, 10);
  if (!leaveTypeId) return res.status(400).json({ error: 'leave_type_id required' });
  const lt = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(leaveTypeId);
  if (!lt) return res.status(404).json({ error: 'Leave type not found' });
  const quota = (b.allocated != null) ? Number(b.allocated) : lt.default_annual_quota;

  let userIds = [];
  if (Array.isArray(b.user_ids) && b.user_ids.length) {
    userIds = b.user_ids.map(n => parseInt(n, 10));
  } else if (b.all_active) {
    userIds = db.prepare("SELECT id FROM users WHERE is_active = 1 AND role IN ('associate','admin','billing')").all().map(r => r.id);
  } else {
    return res.status(400).json({ error: 'Provide user_ids[] or all_active=true' });
  }

  const upsert = db.prepare(
    `INSERT INTO leave_balances (user_id, leave_type_id, year, allocated)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, leave_type_id, year) DO UPDATE SET
       allocated  = excluded.allocated,
       updated_at = datetime('now')`
  );
  const tx = db.transaction(() => {
    for (const uid of userIds) upsert.run(uid, leaveTypeId, year, quota);
  });
  tx();
  writeAuditLog(req.user.id, 'leave_allocate', 'leave_type', leaveTypeId,
    `${userIds.length} users × ${quota} days for ${year} (${lt.code})`);
  res.json({ ok: true, count: userIds.length, allocated: quota, year });
});

// Manual adjust — for one-off corrections (used in YYYY, allocated bump, etc.)
router.patch('/balances/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['allocated', 'used', 'carried_forward'];
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in req.body) { fields.push(`${k} = ?`); values.push(Number(req.body[k])); }
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE leave_balances SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  writeAuditLog(req.user.id, 'leave_balance_adjust', 'leave_balance', id, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATIONS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/applications', authRequired, (req, res) => {
  const { status, from, to } = req.query;
  const wantUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const conds = []; const params = [];
  if (!isAdminLike(req.user)) {
    conds.push('la.user_id = ?'); params.push(req.user.id);
  } else if (wantUserId) {
    conds.push('la.user_id = ?'); params.push(wantUserId);
  }
  if (status) { conds.push('la.status = ?'); params.push(status); }
  if (from)   { conds.push('la.to_date >= ?'); params.push(from); }
  if (to)     { conds.push('la.from_date <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT la.*,
           u.full_name AS user_name, u.email AS user_email, u.designation,
           lt.code AS type_code, lt.name AS type_name, lt.color,
           d.full_name AS decided_by_name
    FROM leave_applications la
    JOIN users u         ON u.id  = la.user_id
    JOIN leave_types lt  ON lt.id = la.leave_type_id
    LEFT JOIN users d    ON d.id  = la.decided_by
    ${where}
    ORDER BY la.from_date DESC, la.id DESC
  `).all(...params);
  res.json({ applications: rows });
});

router.get('/applications/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`
    SELECT la.*, u.full_name AS user_name, lt.code AS type_code, lt.name AS type_name,
           d.full_name AS decided_by_name
    FROM leave_applications la
    JOIN users u        ON u.id  = la.user_id
    JOIN leave_types lt ON lt.id = la.leave_type_id
    LEFT JOIN users d   ON d.id  = la.decided_by
    WHERE la.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Application not found' });
  if (!isAdminLike(req.user) && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ application: row });
});

router.post('/applications', authRequired, (req, res) => {
  const b = req.body || {};
  // Admin/billing may file leave on behalf of another user — useful for offline applications.
  const userId = (isAdminLike(req.user) && b.user_id) ? parseInt(b.user_id, 10) : req.user.id;
  const leaveTypeId = parseInt(b.leave_type_id, 10);
  const session = b.half_day_session && ['full', 'first_half', 'second_half'].includes(b.half_day_session)
    ? b.half_day_session : 'full';

  if (!leaveTypeId || !b.from_date || !b.to_date || !b.reason) {
    return res.status(400).json({ error: 'leave_type_id, from_date, to_date and reason are required' });
  }
  if (b.to_date < b.from_date) {
    return res.status(400).json({ error: 'to_date cannot be before from_date' });
  }
  if (session !== 'full' && b.from_date !== b.to_date) {
    return res.status(400).json({ error: 'Half-day leave must be for a single date' });
  }
  const lt = db.prepare('SELECT * FROM leave_types WHERE id = ? AND is_active = 1').get(leaveTypeId);
  if (!lt) return res.status(400).json({ error: 'Leave type not found or inactive' });

  const days = computeLeaveDays(b.from_date, b.to_date, session, lt.count_method);
  if (days <= 0) {
    return res.status(400).json({ error: 'Selected dates contain no working days (only weekends/holidays)' });
  }

  // Block overlapping applications for the same user (any non-final status counts).
  const overlap = db.prepare(`
    SELECT id FROM leave_applications
    WHERE user_id = ? AND status IN ('submitted','approved')
      AND NOT (to_date < ? OR from_date > ?)
  `).get(userId, b.from_date, b.to_date);
  if (overlap) {
    return res.status(409).json({ error: `Overlaps with existing leave application #${overlap.id}` });
  }

  const year = yearOf(b.from_date);

  // Admin-only convenience: file + immediately approve in one call. Used by the
  // admin "Manual Leave" modal when recording leaves the employee already took
  // (offline applications, past-dated entries, etc).
  const autoApprove = isAdminLike(req.user) && !!b.auto_approve;
  const initialStatus = autoApprove ? 'approved' : 'submitted';

  // For unpaid leave (default_annual_quota=0 AND is_paid=0) we still record it,
  // but we don't fail on insufficient balance. For all other types we enforce.
  const tx = db.transaction(() => {
    const bal = ensureBalanceRow(userId, leaveTypeId, year);
    if (lt.is_paid) {
      const avail = availableBalance(bal);
      if (days > avail) {
        throw Object.assign(new Error(
          `Insufficient ${lt.code} balance. Requested ${days}, available ${avail.toFixed(1)}.`
        ), { status: 400 });
      }
    }
    const info = db.prepare(
      `INSERT INTO leave_applications
         (user_id, leave_type_id, from_date, to_date, half_day_session, days,
          reason, contact_during_leave, status, decided_by, decided_at, decision_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, leaveTypeId, b.from_date, b.to_date, session, days,
      b.reason, b.contact_during_leave || null, initialStatus,
      autoApprove ? req.user.id : null,
      autoApprove ? new Date().toISOString().replace('T',' ').slice(0,19) : null,
      autoApprove ? (b.decision_note || 'Recorded by admin') : null
    );
    if (lt.is_paid) {
      // If auto-approved, the leave is already taken — go straight to `used`.
      // Otherwise it's pending until an approver decides.
      const balanceUpdate = autoApprove
        ? "UPDATE leave_balances SET used = used + ?, updated_at = datetime('now') WHERE id = ?"
        : "UPDATE leave_balances SET pending = pending + ?, updated_at = datetime('now') WHERE id = ?";
      db.prepare(balanceUpdate).run(days, bal.id);
    }
    return info.lastInsertRowid;
  });
  try {
    const newId = tx();
    const action = autoApprove ? 'leave_manual_entry' : 'leave_apply';
    writeAuditLog(req.user.id, action, 'leave_application', newId,
      `${lt.code} ${b.from_date}->${b.to_date} (${days}d)` +
      (autoApprove && userId !== req.user.id ? ` for user_id=${userId}` : ''));
    res.json({ id: newId, days, status: initialStatus });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Admin: approve / reject. Owner: cancel (only while submitted).
function decideApplication(req, res, decision) {
  const id = parseInt(req.params.id, 10);
  const note = (req.body && req.body.note) || null;
  const app = db.prepare('SELECT * FROM leave_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'submitted') {
    return res.status(400).json({ error: `Application already ${app.status}` });
  }
  if (decision === 'cancelled') {
    if (!isAdminLike(req.user) && app.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else if (!isAdminLike(req.user)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const lt = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(app.leave_type_id);
  const year = yearOf(app.from_date);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE leave_applications
       SET status = ?, decided_by = ?, decided_at = datetime('now'),
           decision_note = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(decision, req.user.id, note, id);

    if (!lt.is_paid) return;

    const bal = db.prepare(
      'SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?'
    ).get(app.user_id, app.leave_type_id, year);
    if (!bal) return; // shouldn't happen — apply path creates it

    if (decision === 'approved') {
      // Move pending → used.
      db.prepare(
        `UPDATE leave_balances
         SET pending = MAX(pending - ?, 0),
             used    = used + ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(app.days, app.days, bal.id);
    } else {
      // rejected or cancelled — release the hold.
      db.prepare(
        `UPDATE leave_balances
         SET pending = MAX(pending - ?, 0),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(app.days, bal.id);
    }
  });
  tx();
  writeAuditLog(req.user.id, `leave_${decision}`, 'leave_application', id, note || '');
  res.json({ ok: true });
}

router.post('/applications/:id/approve', authRequired, adminOnly, (req, res) => decideApplication(req, res, 'approved'));
router.post('/applications/:id/reject',  authRequired, adminOnly, (req, res) => decideApplication(req, res, 'rejected'));
router.post('/applications/:id/cancel',  authRequired,            (req, res) => decideApplication(req, res, 'cancelled'));

// ═══════════════════════════════════════════════════════════════════════════
// HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/holidays', authRequired, (req, res) => {
  const year = req.query.year ? parseInt(req.query.year, 10) : null;
  const rows = year
    ? db.prepare("SELECT * FROM holidays WHERE substr(holiday_date,1,4) = ? ORDER BY holiday_date").all(String(year))
    : db.prepare("SELECT * FROM holidays ORDER BY holiday_date").all();
  res.json({ holidays: rows });
});

router.post('/holidays', authRequired, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.holiday_date || !b.name) return res.status(400).json({ error: 'holiday_date and name required' });
  try {
    const info = db.prepare(
      `INSERT INTO holidays (holiday_date, name, is_optional, description)
       VALUES (?, ?, ?, ?)`
    ).run(b.holiday_date, b.name, b.is_optional ? 1 : 0, b.description || null);
    writeAuditLog(req.user.id, 'holiday_create', 'holiday', info.lastInsertRowid, `${b.holiday_date} — ${b.name}`);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Holiday already exists for that date' });
    throw e;
  }
});

router.delete('/holidays/:id', authRequired, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM holidays WHERE id = ?').run(id);
  writeAuditLog(req.user.id, 'holiday_delete', 'holiday', id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR / DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
// Combined view: approved leaves + holidays in a date range. Everyone can see
// this so the team knows who's out without exposing reasons or notes.
router.get('/calendar', authRequired, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const leaves = db.prepare(`
    SELECT la.id, la.from_date, la.to_date, la.half_day_session, la.days,
           u.id AS user_id, u.full_name AS user_name, u.designation,
           lt.code AS type_code, lt.color
    FROM leave_applications la
    JOIN users u        ON u.id  = la.user_id
    JOIN leave_types lt ON lt.id = la.leave_type_id
    WHERE la.status = 'approved' AND NOT (la.to_date < ? OR la.from_date > ?)
    ORDER BY la.from_date
  `).all(from, to);
  const holidays = db.prepare(
    'SELECT * FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date'
  ).all(from, to);
  res.json({ leaves, holidays });
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════
//
// Two views, both for admin/billing only:
//   GET /api/leaves/reports/summary?year=YYYY[&month=MM]
//     -> Pivot: rows = users, cols = leave types, cells = approved days
//        Month optional - omit for full-year summary.
//
//   GET /api/leaves/reports/user/:id?year=YYYY
//     -> Per-user deep-dive: rows = months 1..12, cols = leave types, cells = days
//        plus a totals row.
//
// Only `approved` applications count toward the totals — that matches what HR
// actually cares about (taken vs. just-asked).

function rangeForPeriod(year, month) {
  // Returns [fromIso, toIso] inclusive. Month is 1-based; null/undefined = full year.
  const y = String(year);
  if (month) {
    const m = String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    return [`${y}-${m}-01`, `${y}-${m}-${String(lastDay).padStart(2,'0')}`];
  }
  return [`${y}-01-01`, `${y}-12-31`];
}

// Sum the portion of each application's days that falls inside [from, to].
// Since applications can straddle months, we clip the date range. For working_days
// types we recompute working days in the clipped range; for calendar_days we
// recompute calendar days. This keeps month rollups consistent with the live
// computeLeaveDays helper.
function daysInRange(app, fromIso, toIso, holidaySet) {
  const f = app.from_date > fromIso ? app.from_date : fromIso;
  const t = app.to_date   < toIso   ? app.to_date   : toIso;
  if (t < f) return 0;
  if (app.half_day_session !== 'full') {
    // Half-day stored as a single date. If the date is in range, count 0.5.
    return (app.from_date >= fromIso && app.from_date <= toIso) ? 0.5 : 0;
  }
  if (app.count_method === 'calendar_days') {
    const d1 = new Date(f + 'T00:00:00');
    const d2 = new Date(t + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000) + 1;
  }
  // working_days
  let days = 0;
  const d1 = new Date(f + 'T00:00:00');
  const d2 = new Date(t + 'T00:00:00');
  for (let d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (holidaySet.has(iso)) continue;
    days += 1;
  }
  return days;
}

router.get('/reports/summary', authRequired, adminOnly, (req, res) => {
  const year  = parseInt(req.query.year || yearOf(todayISO()), 10);
  const month = req.query.month ? parseInt(req.query.month, 10) : null;
  if (month && (month < 1 || month > 12)) return res.status(400).json({ error: 'month must be 1-12' });

  const [from, to] = rangeForPeriod(year, month);

  // Holidays in scope (used by daysInRange for working_days clipping)
  const holidaySet = new Set(db.prepare(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND is_optional = 0'
  ).all(from, to).map(r => r.holiday_date));

  // All approved apps overlapping the period (clip later)
  const apps = db.prepare(`
    SELECT la.id, la.user_id, la.leave_type_id, la.from_date, la.to_date,
           la.half_day_session, la.days,
           lt.code AS type_code, lt.count_method
    FROM leave_applications la
    JOIN leave_types lt ON lt.id = la.leave_type_id
    WHERE la.status = 'approved'
      AND NOT (la.to_date < ? OR la.from_date > ?)
  `).all(from, to);

  const types = db.prepare(
    'SELECT id, code, name, color FROM leave_types ORDER BY name'
  ).all();
  const users = db.prepare(
    "SELECT id, full_name, email, designation FROM users WHERE is_active = 1 ORDER BY full_name"
  ).all();

  // Build pivot: { user_id: { type_code: days } }
  const pivot = new Map();
  for (const u of users) pivot.set(u.id, {});
  for (const a of apps) {
    const d = daysInRange(a, from, to, holidaySet);
    if (d <= 0) continue;
    if (!pivot.has(a.user_id)) pivot.set(a.user_id, {});
    const row = pivot.get(a.user_id);
    row[a.type_code] = (row[a.type_code] || 0) + d;
  }

  // Shape output: include rows even for users with zero leaves so the report
  // reads naturally as a list of all employees (with blanks where applicable).
  const rows = users.map(u => {
    const counts = pivot.get(u.id) || {};
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    return {
      user_id: u.id, full_name: u.full_name, email: u.email, designation: u.designation,
      counts, total: Math.round(total * 10) / 10
    };
  });

  res.json({ year, month, from, to, types, rows });
});

router.get('/reports/user/:id', authRequired, adminOnly, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const year = parseInt(req.query.year || yearOf(todayISO()), 10);
  const user = db.prepare('SELECT id, full_name, email, designation FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [yearFrom, yearTo] = rangeForPeriod(year, null);
  const holidaySet = new Set(db.prepare(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND is_optional = 0'
  ).all(yearFrom, yearTo).map(r => r.holiday_date));

  const apps = db.prepare(`
    SELECT la.id, la.from_date, la.to_date, la.half_day_session, la.days,
           la.reason, la.status, la.decision_note, la.decided_at,
           lt.code AS type_code, lt.name AS type_name, lt.color, lt.count_method
    FROM leave_applications la
    JOIN leave_types lt ON lt.id = la.leave_type_id
    WHERE la.user_id = ? AND la.status = 'approved'
      AND NOT (la.to_date < ? OR la.from_date > ?)
    ORDER BY la.from_date
  `).all(userId, yearFrom, yearTo);

  const types = db.prepare(
    'SELECT id, code, name, color FROM leave_types ORDER BY name'
  ).all();

  // Months: 1..12 each with { type_code: days }
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const [from, to] = rangeForPeriod(year, m);
    const counts = {};
    for (const a of apps) {
      if (a.to_date < from || a.from_date > to) continue;
      const d = daysInRange(a, from, to, holidaySet);
      if (d > 0) counts[a.type_code] = (counts[a.type_code] || 0) + d;
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    months.push({
      month: m,
      label: new Date(year, m - 1, 1).toLocaleString('en-IN', { month: 'short' }),
      counts,
      total: Math.round(total * 10) / 10
    });
  }

  // Year totals (re-derive from months for consistency)
  const yearTotals = {};
  for (const mo of months) for (const [code, v] of Object.entries(mo.counts)) {
    yearTotals[code] = (yearTotals[code] || 0) + v;
  }
  const yearTotal = Object.values(yearTotals).reduce((s, v) => s + v, 0);

  // Current balance snapshot for the same year
  const balances = db.prepare(`
    SELECT lt.code AS type_code, lt.name AS type_name, lb.allocated, lb.used, lb.pending, lb.carried_forward
    FROM leave_balances lb
    JOIN leave_types lt ON lt.id = lb.leave_type_id
    WHERE lb.user_id = ? AND lb.year = ?
    ORDER BY lt.name
  `).all(userId, year);

  res.json({
    user, year, types, months,
    year_totals: yearTotals,
    year_total: Math.round(yearTotal * 10) / 10,
    applications: apps,
    balances
  });
});

// Admin-facing summary widget for dashboard.
router.get('/dashboard', authRequired, adminOnly, (req, res) => {
  const today = todayISO();
  const pending = db.prepare(
    "SELECT COUNT(*) AS c FROM leave_applications WHERE status = 'submitted'"
  ).get().c;
  const onLeaveToday = db.prepare(`
    SELECT la.id, u.full_name, u.designation, lt.code AS type_code, lt.color,
           la.from_date, la.to_date, la.half_day_session
    FROM leave_applications la
    JOIN users u        ON u.id  = la.user_id
    JOIN leave_types lt ON lt.id = la.leave_type_id
    WHERE la.status = 'approved' AND ? BETWEEN la.from_date AND la.to_date
    ORDER BY u.full_name
  `).all(today);
  const upcomingHolidays = db.prepare(
    "SELECT * FROM holidays WHERE holiday_date >= ? ORDER BY holiday_date LIMIT 5"
  ).all(today);
  res.json({ pending_count: pending, on_leave_today: onLeaveToday, upcoming_holidays: upcomingHolidays });
});

module.exports = router;
