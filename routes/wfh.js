/**
 * Work From Home — applications, approvals, calendar, reports.
 *
 * Parallel to routes/leaves.js but with a critical difference: WFH does NOT
 * deduct from any balance (employee is still working, just remotely). All the
 * approval workflow is the same — submit → approved/rejected/cancelled.
 *
 * Per AP & Partners HR Policy:
 *   "Retainers may also work from home subject to prior approval of the
 *    reporting partner and intimation to the HR."
 *
 * Approver pool: admin, HR, billing, super_admin (configurable via RBAC).
 */
const express = require('express');
const { db } = require('../utils/db');
const {
  authRequired, requirePermission, userHas,
  writeAuditLog
} = require('../middleware/auth');

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Working days between two ISO dates, inclusive. Always working_days style —
// WFH doesn't make sense for weekends/holidays (employee is off anyway).
function computeWfhDays(fromIso, toIso) {
  if (toIso < fromIso) return 0;
  const holidayRows = db.prepare(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND is_optional = 0'
  ).all(fromIso, toIso);
  const holidaySet = new Set(holidayRows.map(r => r.holiday_date));
  let days = 0;
  const start = new Date(fromIso + 'T00:00:00');
  const end   = new Date(toIso   + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (holidaySet.has(iso)) continue;
    days += 1;
  }
  return days;
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATIONS
// ═══════════════════════════════════════════════════════════════════════════
router.get('/applications', authRequired, (req, res) => {
  const { status, from, to } = req.query;
  const wantUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  const canSeeAll = userHas(req, 'wfh.view_all');

  const conds = []; const params = [];
  if (!canSeeAll) {
    conds.push('w.user_id = ?'); params.push(req.user.id);
  } else if (wantUserId) {
    conds.push('w.user_id = ?'); params.push(wantUserId);
  }
  if (status) { conds.push('w.status = ?'); params.push(status); }
  if (from)   { conds.push('w.to_date >= ?'); params.push(from); }
  if (to)     { conds.push('w.from_date <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT w.*, u.full_name AS user_name, u.email AS user_email, u.designation,
           d.full_name AS decided_by_name
    FROM wfh_applications w
    JOIN users u      ON u.id = w.user_id
    LEFT JOIN users d ON d.id = w.decided_by
    ${where}
    ORDER BY w.from_date DESC, w.id DESC
  `).all(...params);
  res.json({ applications: rows });
});

router.get('/applications/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`
    SELECT w.*, u.full_name AS user_name, d.full_name AS decided_by_name
    FROM wfh_applications w
    JOIN users u      ON u.id = w.user_id
    LEFT JOIN users d ON d.id = w.decided_by
    WHERE w.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Application not found' });
  if (!userHas(req, 'wfh.view_all') && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ application: row });
});

router.post('/applications', authRequired, requirePermission(['wfh.apply_own', 'wfh.apply_for_others']), (req, res) => {
  const b = req.body || {};
  // Filing on behalf of another user requires the dedicated permission.
  const userId = (userHas(req, 'wfh.apply_for_others') && b.user_id)
    ? parseInt(b.user_id, 10) : req.user.id;

  if (!b.from_date || !b.to_date || !b.reason) {
    return res.status(400).json({ error: 'from_date, to_date and reason are required' });
  }
  if (b.to_date < b.from_date) {
    return res.status(400).json({ error: 'to_date cannot be before from_date' });
  }

  const days = computeWfhDays(b.from_date, b.to_date);
  if (days <= 0) {
    return res.status(400).json({ error: 'Selected dates contain no working days (only weekends/holidays)' });
  }

  // Block overlapping WFH applications for the same user.
  const overlap = db.prepare(`
    SELECT id FROM wfh_applications
    WHERE user_id = ? AND status IN ('submitted','approved')
      AND NOT (to_date < ? OR from_date > ?)
  `).get(userId, b.from_date, b.to_date);
  if (overlap) {
    return res.status(409).json({ error: `Overlaps with existing WFH application #${overlap.id}` });
  }

  // Also block overlap with an APPROVED leave (can't be on leave AND WFH).
  // Pending leaves don't block — admin will resolve the conflict during approval.
  const leaveOverlap = db.prepare(`
    SELECT id FROM leave_applications
    WHERE user_id = ? AND status = 'approved'
      AND NOT (to_date < ? OR from_date > ?)
  `).get(userId, b.from_date, b.to_date);
  if (leaveOverlap) {
    return res.status(409).json({ error: `Overlaps with an approved leave (#${leaveOverlap.id}) for the same period.` });
  }

  // Admin convenience: file + auto-approve in one call.
  const autoApprove = userHas(req, 'wfh.approve') && !!b.auto_approve;
  const initialStatus = autoApprove ? 'approved' : 'submitted';

  const info = db.prepare(
    `INSERT INTO wfh_applications
       (user_id, from_date, to_date, days, reason, contact_during_wfh, status,
        decided_by, decided_at, decision_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, b.from_date, b.to_date, days,
    b.reason, b.contact_during_wfh || null, initialStatus,
    autoApprove ? req.user.id : null,
    autoApprove ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    autoApprove ? (b.decision_note || 'Recorded by admin') : null
  );

  const action = autoApprove ? 'wfh_manual_entry' : 'wfh_apply';
  writeAuditLog(req, action, 'wfh_application', info.lastInsertRowid,
    `${b.from_date}->${b.to_date} (${days}d)` +
    (autoApprove && userId !== req.user.id ? ` for user_id=${userId}` : ''));

  res.json({ id: info.lastInsertRowid, days, status: initialStatus });
});

// ── Approve / reject / cancel ──────────────────────────────────────────────
function decideWfh(req, res, decision) {
  const id = parseInt(req.params.id, 10);
  const note = (req.body && req.body.note) || null;
  const app = db.prepare('SELECT * FROM wfh_applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'submitted') {
    return res.status(400).json({ error: `Application already ${app.status}` });
  }
  if (decision === 'cancelled') {
    if (!userHas(req, 'wfh.approve') && app.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else if (!userHas(req, 'wfh.approve')) {
    return res.status(403).json({ error: 'Missing permission: wfh.approve' });
  }

  db.prepare(
    `UPDATE wfh_applications
     SET status = ?, decided_by = ?, decided_at = datetime('now'),
         decision_note = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(decision, req.user.id, note, id);

  writeAuditLog(req, `wfh_${decision}`, 'wfh_application', id, note || '');
  res.json({ ok: true });
}

router.post('/applications/:id/approve', authRequired, requirePermission('wfh.approve'),
  (req, res) => decideWfh(req, res, 'approved'));
router.post('/applications/:id/reject',  authRequired, requirePermission('wfh.approve'),
  (req, res) => decideWfh(req, res, 'rejected'));
router.post('/applications/:id/cancel',  authRequired,
  (req, res) => decideWfh(req, res, 'cancelled'));

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR — who's WFH in a date range (visible to everyone authenticated so
// the team can see who's remote on any given day, without exposing reasons)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/calendar', authRequired, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const rows = db.prepare(`
    SELECT w.id, w.from_date, w.to_date, w.days,
           u.id AS user_id, u.full_name AS user_name, u.designation
    FROM wfh_applications w
    JOIN users u ON u.id = w.user_id
    WHERE w.status = 'approved' AND NOT (w.to_date < ? OR w.from_date > ?)
    ORDER BY w.from_date
  `).all(from, to);
  res.json({ wfh: rows });
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD — today's WFH list, pending count, upcoming
// ═══════════════════════════════════════════════════════════════════════════
router.get('/dashboard', authRequired, requirePermission('wfh.view_all'), (req, res) => {
  const today = todayISO();
  const pending = db.prepare(
    "SELECT COUNT(*) AS c FROM wfh_applications WHERE status = 'submitted'"
  ).get().c;
  const onWfhToday = db.prepare(`
    SELECT w.id, u.full_name, u.designation, w.from_date, w.to_date
    FROM wfh_applications w
    JOIN users u ON u.id = w.user_id
    WHERE w.status = 'approved' AND ? BETWEEN w.from_date AND w.to_date
    ORDER BY u.full_name
  `).all(today);
  const upcoming = db.prepare(`
    SELECT w.id, u.full_name, w.from_date, w.to_date, w.days
    FROM wfh_applications w
    JOIN users u ON u.id = w.user_id
    WHERE w.status = 'approved' AND w.from_date > ?
    ORDER BY w.from_date LIMIT 10
  `).all(today);
  res.json({ pending_count: pending, on_wfh_today: onWfhToday, upcoming_wfh: upcoming });
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS — per-user monthly / yearly WFH day counts (pivot)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/reports/summary', authRequired, requirePermission('wfh.reports'), (req, res) => {
  const year  = parseInt(req.query.year  || (new Date()).getFullYear(), 10);
  const month = req.query.month ? parseInt(req.query.month, 10) : null;  // 1-12, optional

  let from, to;
  if (month) {
    from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  } else {
    from = `${year}-01-01`;
    to   = `${year}-12-31`;
  }

  // Sum WFH days per user for approved applications overlapping the window.
  // Note: days field already excludes weekends/holidays at apply time.
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.full_name, u.email, u.designation,
           COALESCE(SUM(w.days), 0) AS total_days,
           COUNT(w.id)              AS application_count
    FROM users u
    LEFT JOIN wfh_applications w
      ON w.user_id = u.id AND w.status = 'approved'
     AND NOT (w.to_date < ? OR w.from_date > ?)
    WHERE u.is_active = 1 AND u.deleted_at IS NULL
    GROUP BY u.id
    ORDER BY total_days DESC, u.full_name
  `).all(from, to);
  res.json({ rows, period: { year, month, from, to } });
});

// Per-user deep-dive
router.get('/reports/user/:id', authRequired, requirePermission('wfh.reports'), (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const year  = parseInt(req.query.year || (new Date()).getFullYear(), 10);
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const apps = db.prepare(`
    SELECT * FROM wfh_applications
    WHERE user_id = ? AND status = 'approved'
      AND NOT (to_date < ? OR from_date > ?)
    ORDER BY from_date
  `).all(userId, from, to);
  // Aggregate by month
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, days: 0 }));
  for (const a of apps) {
    const m = parseInt(a.from_date.slice(5, 7), 10);
    byMonth[m - 1].days += a.days;
  }
  res.json({ applications: apps, by_month: byMonth, year });
});

module.exports = router;
