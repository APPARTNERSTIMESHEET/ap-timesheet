/**
 * Insider Trading Policy (SEBI Compliance) — Backend API
 * ──────────────────────────────────────────────────────────────────────────────
 * Implements the AP & Partners Code of Conduct for Prohibition of Insider
 * Trading (per SEBI Insider Trading Regulations, 2015).
 *
 * Routes are grouped by audience:
 *   - /me/*           — every Designated Person (Annexure 1, 2, 3, 4, 5, 7, 8)
 *   - /co/*           — Compliance Officer (Annexure 6 + Restricted List + UPSI log)
 *   - /admin/*        — DP roster admin (HR / super_admin)
 *   - /report/*       — Annual compliance reports (Management Committee)
 *
 * Penalty for non-compliance per Section VII.E: ₹25 Cr OR 3× profits, whichever
 * higher, plus up to 10 years imprisonment. So every write is audit-logged.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../utils/db');
const {
  authRequired, requirePermission, userHas, writeAuditLog
} = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a row to insider_audit_trail. This is SEBI-mandated audit retention
 * for 5 years; it sits beside the firm-wide audit_log so this module can
 * retain independently of other purges.
 */
function logInsider(req, action, entityType, entityId, payload) {
  try {
    db.prepare(
      `INSERT INTO insider_audit_trail
       (user_id, user_email, user_name, action, entity_type, entity_id,
        payload_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.id, req.user.email, req.user.full_name,
      action, entityType || null, entityId || null,
      payload ? JSON.stringify(payload) : null,
      req.ip || null, req.headers['user-agent'] || null
    );
  } catch (_) { /* non-blocking */ }
}

/**
 * Get the active Designated Person row for a user. Auto-creates one if the
 * user has the `insider.self` permission but no DP entry yet (covers existing
 * users when the module rolls out).
 */
function getOrCreateDpForUser(userId, dpType = 'staff') {
  let dp = db.prepare(
    `SELECT * FROM insider_designated_persons
     WHERE user_id = ? AND removed_on IS NULL`
  ).get(userId);
  if (dp) return dp;
  // Auto-onboard with a sensible default type — admin can change later.
  const info = db.prepare(
    `INSERT INTO insider_designated_persons (user_id, dp_type) VALUES (?, ?)`
  ).run(userId, dpType);
  return db.prepare('SELECT * FROM insider_designated_persons WHERE id = ?').get(info.lastInsertRowid);
}

/** Singleton config row. */
function getConfig() {
  return db.prepare('SELECT * FROM insider_config WHERE id = 1').get();
}

/** The currently active Code version (whatever insider_config points at). */
function getActiveCodeVersion() {
  const cfg = getConfig();
  if (!cfg || !cfg.active_code_version_id) {
    return db.prepare(
      'SELECT * FROM insider_code_versions ORDER BY id DESC LIMIT 1'
    ).get();
  }
  return db.prepare(
    'SELECT * FROM insider_code_versions WHERE id = ?'
  ).get(cfg.active_code_version_id);
}

/** Has this DP signed the currently-active Code? Returns the ack row or null. */
function getActiveAcknowledgment(dpId) {
  const v = getActiveCodeVersion();
  if (!v) return null;
  return db.prepare(
    `SELECT * FROM insider_acknowledgments WHERE dp_id = ? AND code_version_id = ?`
  ).get(dpId, v.id);
}

/** ISO date N days from a date string. */
function addTradingDays(fromIso, days) {
  // Trading days ≈ calendar days for simple deadline arithmetic. We approximate
  // by adding `days + Math.ceil(days/5)*2` to skip weekends. Good enough for
  // the 7-trading-day window; a future enhancement can use an exchange calendar.
  const d = new Date(fromIso);
  const padded = days + Math.ceil(days / 5) * 2;
  d.setDate(d.getDate() + padded);
  return d.toISOString().slice(0, 10);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DESIGNATED PERSON SELF-SERVICE (/me/*)
// Every DP can submit their own Annexures. Required permission: insider.self
// ═════════════════════════════════════════════════════════════════════════════

router.use(authRequired);

/**
 * GET /me/status
 * Aggregate status: am I a DP? have I signed the Code? holdings filed?
 * pending pre-clearances? Used by the dashboard to drive banners + KPIs.
 */
router.get('/me/status', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const activeVersion = getActiveCodeVersion();
  const ack = getActiveAcknowledgment(dp.id);
  // Latest Annexure 1
  const anx1 = db.prepare(
    `SELECT id, submitted_at FROM insider_annexure1_statements
     WHERE dp_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1`
  ).get(dp.id);
  // Holdings statements
  const holdingsInitial = db.prepare(
    `SELECT id, as_of_date, submitted_at FROM insider_holdings_statements
     WHERE dp_id = ? AND statement_type = 'initial' ORDER BY id DESC LIMIT 1`
  ).get(dp.id);
  const currentYear = new Date().getFullYear();
  const lastAnnual = db.prepare(
    `SELECT id, as_of_date, submitted_at FROM insider_holdings_statements
     WHERE dp_id = ? AND statement_type = 'annual'
     ORDER BY id DESC LIMIT 1`
  ).get(dp.id);
  // Pre-clearance counts
  const pending = db.prepare(
    `SELECT COUNT(*) AS c FROM insider_preclearance_requests
     WHERE dp_id = ? AND status = 'pending'`
  ).get(dp.id).c;
  const approvedAwaitingTrade = db.prepare(
    `SELECT COUNT(*) AS c FROM insider_preclearance_requests
     WHERE dp_id = ? AND status = 'approved'`
  ).get(dp.id).c;

  res.json({
    dp: {
      id: dp.id, dp_type: dp.dp_type, designated_on: dp.designated_on
    },
    active_code: activeVersion ? {
      id: activeVersion.id, label: activeVersion.version_label,
      effective_from: activeVersion.effective_from
    } : null,
    code_acknowledged: !!ack,
    code_acknowledged_at: ack ? ack.signed_at : null,
    annexure1_current_id: anx1 ? anx1.id : null,
    annexure1_submitted_at: anx1 ? anx1.submitted_at : null,
    holdings_initial: holdingsInitial || null,
    holdings_last_annual: lastAnnual || null,
    annual_due_this_fy: !lastAnnual || lastAnnual.as_of_date < `${currentYear - 1}-03-31`,
    pending_preclearances: pending,
    approved_awaiting_trade: approvedAwaitingTrade
  });
});

/**
 * POST /me/acknowledge
 * Annexure 2 — sign the Code. One signature per Code version.
 * Body: { signature_name }
 */
router.post('/me/acknowledge', requirePermission('insider.self'), (req, res) => {
  const { signature_name } = req.body || {};
  if (!signature_name || !signature_name.trim()) {
    return res.status(400).json({ error: 'Typed signature (full name) is required' });
  }
  const dp = getOrCreateDpForUser(req.user.id);
  const v = getActiveCodeVersion();
  if (!v) return res.status(500).json({ error: 'No active Code version on file' });

  try {
    const info = db.prepare(
      `INSERT INTO insider_acknowledgments
       (dp_id, code_version_id, signed_ip, signed_ua, signature_name, signature_image, photo_image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(dp.id, v.id, req.ip || null, req.headers['user-agent'] || null,
          signature_name.trim(),
          (req.body && req.body.signature_image) || null,
          (req.body && req.body.photo_image) || null);
    logInsider(req, 'annexure2.signed', 'acknowledgment', info.lastInsertRowid, {
      code_version: v.version_label
    });
    res.json({ ok: true, ack_id: info.lastInsertRowid, code_version: v.version_label });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res.status(409).json({ error: 'You have already acknowledged this Code version' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /me/annexure1
 * Submit (or re-submit) Annexure 1 — Immediate Relatives + PwMFR + Education + Past Employers.
 * Body: {
 *   signature_name,
 *   relatives: [{ full_name, relation_status, relation_type, pan, ... }],
 *   education: [{ institution, years }],
 *   past_employers: [{ employer, years }]
 * }
 */
router.post('/me/annexure1', requirePermission('insider.self'), (req, res) => {
  const { signature_name, signature_image, photo_image, relatives = [], education = [], past_employers = [] } = req.body || {};
  if (!signature_name || !signature_name.trim()) {
    return res.status(400).json({ error: 'Typed signature is required' });
  }
  const dp = getOrCreateDpForUser(req.user.id);

  const tx = db.transaction(() => {
    // Mark previous current statement as superseded
    db.prepare(
      `UPDATE insider_annexure1_statements SET is_current = 0 WHERE dp_id = ? AND is_current = 1`
    ).run(dp.id);

    const sInfo = db.prepare(
      `INSERT INTO insider_annexure1_statements
       (dp_id, submitted_ip, signature_name, signature_image, photo_image, is_current)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(dp.id, req.ip || null, signature_name.trim(), signature_image || null, photo_image || null);
    const statementId = sInfo.lastInsertRowid;

    const insRel = db.prepare(
      `INSERT INTO insider_relatives
       (statement_id, full_name, relation_status, relation_type,
        pan, other_id_type, other_id_value, contact_phone, contact_email,
        financial_dep, consults_dp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of relatives) {
      if (!r.full_name) continue;
      insRel.run(
        statementId, r.full_name, r.relation_status || 'immediate_relative',
        r.relation_type || null,
        r.pan || null, r.other_id_type || null, r.other_id_value || null,
        r.contact_phone || null, r.contact_email || null,
        r.financial_dep ? 1 : 0, r.consults_dp ? 1 : 0
      );
    }
    const insEdu = db.prepare(
      `INSERT INTO insider_education (statement_id, institution, years) VALUES (?, ?, ?)`
    );
    for (const e of education) {
      if (!e.institution) continue;
      insEdu.run(statementId, e.institution, e.years || null);
    }
    const insEmp = db.prepare(
      `INSERT INTO insider_past_employers (statement_id, employer, years) VALUES (?, ?, ?)`
    );
    for (const e of past_employers) {
      if (!e.employer) continue;
      insEmp.run(statementId, e.employer, e.years || null);
    }
    return statementId;
  });

  const statementId = tx();
  logInsider(req, 'annexure1.submitted', 'annexure1', statementId, {
    relatives_count: relatives.length,
    education_count: education.length,
    employers_count: past_employers.length
  });
  res.json({ ok: true, statement_id: statementId });
});

/**
 * GET /me/annexure1
 * Return the DP's current Annexure 1 (relatives + education + employers).
 */
router.get('/me/annexure1', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const statement = db.prepare(
    `SELECT * FROM insider_annexure1_statements
     WHERE dp_id = ? AND is_current = 1`
  ).get(dp.id);
  if (!statement) return res.json({ statement: null });
  const relatives = db.prepare(
    'SELECT * FROM insider_relatives WHERE statement_id = ?'
  ).all(statement.id);
  const education = db.prepare(
    'SELECT * FROM insider_education WHERE statement_id = ?'
  ).all(statement.id);
  const past_employers = db.prepare(
    'SELECT * FROM insider_past_employers WHERE statement_id = ?'
  ).all(statement.id);
  res.json({ statement, relatives, education, past_employers });
});

/**
 * POST /me/holdings
 * Annexure 3 — Statement of Securities Holdings. Two flavours:
 *   statement_type = 'initial' (within 7 days of joining/getting copy of Code)
 *   statement_type = 'annual'  (before April 30 each FY, as of March 31)
 * Body: {
 *   statement_type, as_of_date, signature_name,
 *   lines: [{ security_name, isin, opening_balance, increase_qty, decrease_qty,
 *             closing_balance, dp_name_broker, dp_id_broker, client_folio,
 *             held_by, relative_name }]
 * }
 */
router.post('/me/holdings', requirePermission('insider.self'), (req, res) => {
  const { statement_type, as_of_date, signature_name, signature_image, photo_image, lines = [] } = req.body || {};
  if (!['initial', 'annual'].includes(statement_type)) {
    return res.status(400).json({ error: 'statement_type must be initial or annual' });
  }
  if (!as_of_date) return res.status(400).json({ error: 'as_of_date required (YYYY-MM-DD)' });
  if (!signature_name || !signature_name.trim()) {
    return res.status(400).json({ error: 'Typed signature is required' });
  }

  const dp = getOrCreateDpForUser(req.user.id);
  const tx = db.transaction(() => {
    const sInfo = db.prepare(
      `INSERT INTO insider_holdings_statements
       (dp_id, statement_type, as_of_date, submitted_ip, signature_name, signature_image, photo_image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(dp.id, statement_type, as_of_date, req.ip || null, signature_name.trim(), signature_image || null, photo_image || null);
    const statementId = sInfo.lastInsertRowid;
    const insLine = db.prepare(
      `INSERT INTO insider_holdings_lines
       (statement_id, security_name, isin, opening_balance, increase_qty,
        decrease_qty, closing_balance, dp_name_broker, dp_id_broker,
        client_folio, held_by, relative_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      if (!l.security_name) continue;
      insLine.run(
        statementId, l.security_name, l.isin || null,
        Number(l.opening_balance) || 0,
        Number(l.increase_qty) || 0,
        Number(l.decrease_qty) || 0,
        Number(l.closing_balance) || 0,
        l.dp_name_broker || null, l.dp_id_broker || null,
        l.client_folio || null, l.held_by || 'self',
        l.relative_name || null
      );
    }
    return statementId;
  });
  const statementId = tx();
  logInsider(req, 'annexure3.submitted', 'holdings', statementId, {
    statement_type, lines_count: lines.length
  });
  res.json({ ok: true, statement_id: statementId });
});

/**
 * GET /me/holdings — list all my holdings statements (newest first).
 */
router.get('/me/holdings', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const stmts = db.prepare(
    `SELECT id, statement_type, as_of_date, submitted_at
     FROM insider_holdings_statements WHERE dp_id = ?
     ORDER BY id DESC`
  ).all(dp.id);
  res.json({ statements: stmts });
});

/**
 * GET /me/holdings/:id — single statement with line items.
 */
router.get('/me/holdings/:id', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const stmt = db.prepare(
    'SELECT * FROM insider_holdings_statements WHERE id = ? AND dp_id = ?'
  ).get(req.params.id, dp.id);
  if (!stmt) return res.status(404).json({ error: 'Statement not found' });
  const lines = db.prepare(
    'SELECT * FROM insider_holdings_lines WHERE statement_id = ?'
  ).all(stmt.id);
  res.json({ statement: stmt, lines });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PRE-CLEARANCE (Annexure 4 + 5 + 6 + 7 + 8)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /me/preclearance
 * Annexure 4 + 5 — Dealing Authorization Request with UPSI declaration.
 * All four declarations must be true to submit.
 */
router.post('/me/preclearance', requirePermission('insider.self'), (req, res) => {
  const b = req.body || {};
  const required = ['security_name', 'txn_nature', 'qty_proposed', 'signature_name'];
  for (const k of required) {
    if (!b[k]) return res.status(400).json({ error: `${k} is required` });
  }
  if (!b.decl_no_upsi || !b.decl_will_inform_if_upsi || !b.decl_no_contravention || !b.decl_full_disclosure) {
    return res.status(400).json({
      error: 'All four Annexure 5 declarations must be confirmed before submission'
    });
  }
  const dp = getOrCreateDpForUser(req.user.id);

  // Block submission if DP hasn't signed the current Code
  if (!getActiveAcknowledgment(dp.id)) {
    return res.status(403).json({
      error: 'You must first acknowledge the Code of Conduct (Annexure 2) before submitting a pre-clearance request.'
    });
  }

  const info = db.prepare(
    `INSERT INTO insider_preclearance_requests
     (dp_id, trader_kind, trader_name, security_name, isin, txn_nature,
      qty_proposed, qty_held_before, broker_dp_id, broker_client_id,
      decl_no_upsi, decl_will_inform_if_upsi, decl_no_contravention,
      decl_full_disclosure, submitted_ip, signature_name, signature_image, photo_image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?, ?)`
  ).run(
    dp.id,
    b.trader_kind || 'self',
    b.trader_kind === 'immediate_relative' ? (b.trader_name || null) : null,
    b.security_name, b.isin || null, b.txn_nature,
    Number(b.qty_proposed),
    Number(b.qty_held_before) || 0,
    b.broker_dp_id || null, b.broker_client_id || null,
    req.ip || null, b.signature_name.trim(), b.signature_image || null, b.photo_image || null
  );
  logInsider(req, 'annexure4.submitted', 'preclearance', info.lastInsertRowid, {
    security: b.security_name, txn_nature: b.txn_nature, qty: b.qty_proposed
  });
  res.json({ ok: true, request_id: info.lastInsertRowid });
});

/**
 * GET /me/preclearance — list my pre-clearance requests (newest first).
 */
router.get('/me/preclearance', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const rows = db.prepare(
    `SELECT r.*, d.decision, d.decision_at, d.valid_until
     FROM insider_preclearance_requests r
     LEFT JOIN insider_preclearance_decisions d ON d.request_id = r.id
     WHERE r.dp_id = ?
     ORDER BY r.id DESC`
  ).all(dp.id);
  res.json({ requests: rows });
});

/**
 * GET /me/preclearance/:id — single request with decision.
 */
router.get('/me/preclearance/:id', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const r = db.prepare(
    'SELECT * FROM insider_preclearance_requests WHERE id = ? AND dp_id = ?'
  ).get(req.params.id, dp.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const d = db.prepare(
    'SELECT * FROM insider_preclearance_decisions WHERE request_id = ?'
  ).get(r.id);
  res.json({ request: r, decision: d || null });
});

/**
 * POST /me/preclearance/:id/post-trade
 * Annexure 7 — Post-Trade Report. Must be filed within 7 days of execution.
 * Auto-computes the 6-month contra trade lock-until date.
 */
router.post('/me/preclearance/:id/post-trade', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const r = db.prepare(
    'SELECT * FROM insider_preclearance_requests WHERE id = ? AND dp_id = ?'
  ).get(req.params.id, dp.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'approved') {
    return res.status(409).json({ error: `Cannot file post-trade — request status is "${r.status}"` });
  }
  const d = db.prepare(
    'SELECT * FROM insider_preclearance_decisions WHERE request_id = ?'
  ).get(r.id);
  if (!d || d.decision !== 'approved') {
    return res.status(409).json({ error: 'No approval decision found for this request' });
  }

  const b = req.body || {};
  for (const k of ['security_name', 'qty_traded', 'trade_price', 'traded_at', 'signature_name']) {
    if (!b[k]) return res.status(400).json({ error: `${k} is required` });
  }

  const cfg = getConfig();
  const contraMonths = cfg ? cfg.contra_trade_months : 6;
  const contraDate = new Date(b.traded_at);
  contraDate.setMonth(contraDate.getMonth() + contraMonths);
  const contraLockedUntil = contraDate.toISOString().slice(0, 10);

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO insider_post_trade_reports
       (decision_id, dp_id, holder_flag, isin, security_name, qty_traded,
        trade_price, broker_name, traded_at, submitted_ip, signature_name,
        signature_image, contra_locked_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      d.id, dp.id,
      (b.holder_flag === 'J' ? 'J' : 'F'),
      b.isin || r.isin || null, b.security_name,
      Number(b.qty_traded), Number(b.trade_price),
      b.broker_name || null, b.traded_at, req.ip || null,
      b.signature_name.trim(), b.signature_image || null, contraLockedUntil
    );
    db.prepare(
      `UPDATE insider_preclearance_requests SET status = 'executed' WHERE id = ?`
    ).run(r.id);
    return info.lastInsertRowid;
  });
  const reportId = tx();
  logInsider(req, 'annexure7.submitted', 'post_trade', reportId, {
    security: b.security_name, qty: b.qty_traded,
    contra_locked_until: contraLockedUntil
  });
  res.json({ ok: true, report_id: reportId, contra_locked_until: contraLockedUntil });
});

/**
 * POST /me/preclearance/:id/no-trade
 * Annexure 8 — No Trade Report (trade was not executed within the window).
 */
router.post('/me/preclearance/:id/no-trade', requirePermission('insider.self'), (req, res) => {
  const dp = getOrCreateDpForUser(req.user.id);
  const r = db.prepare(
    'SELECT * FROM insider_preclearance_requests WHERE id = ? AND dp_id = ?'
  ).get(req.params.id, dp.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (!['approved', 'expired'].includes(r.status)) {
    return res.status(409).json({ error: `Cannot file no-trade — request status is "${r.status}"` });
  }
  const d = db.prepare(
    'SELECT * FROM insider_preclearance_decisions WHERE request_id = ?'
  ).get(r.id);
  if (!d) return res.status(409).json({ error: 'No decision found for this request' });

  const b = req.body || {};
  if (!b.reason || !b.signature_name) {
    return res.status(400).json({ error: 'reason and signature_name are required' });
  }
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO insider_no_trade_reports
       (decision_id, dp_id, reason, submitted_ip, signature_name, signature_image)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(d.id, dp.id, b.reason, req.ip || null, b.signature_name.trim(), b.signature_image || null);
    db.prepare(
      `UPDATE insider_preclearance_requests SET status = 'no_trade' WHERE id = ?`
    ).run(r.id);
    return info.lastInsertRowid;
  });
  const reportId = tx();
  logInsider(req, 'annexure8.submitted', 'no_trade', reportId, { reason: b.reason });
  res.json({ ok: true, report_id: reportId });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — COMPLIANCE OFFICER (/co/*)
// Requires permission: insider.review (approve/reject), insider.restricted_list,
// insider.upsi_log
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /co/queue — pending pre-clearance requests for the CO to action.
 */
router.get('/co/queue', requirePermission('insider.review'), (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, u.full_name AS dp_name, u.email AS dp_email,
            dp.dp_type
     FROM insider_preclearance_requests r
     JOIN insider_designated_persons dp ON dp.id = r.dp_id
     JOIN users u ON u.id = dp.user_id
     WHERE r.status = 'pending'
     ORDER BY r.submitted_at ASC`
  ).all();
  // Decorate each row with a Restricted List flag — if the security appears
  // (by name OR ISIN) on the active list, the CO sees a red badge.
  const rl = db.prepare(
    `SELECT company_name, isin FROM insider_restricted_list WHERE removed_at IS NULL`
  ).all();
  const rlNames = new Set(rl.map(x => (x.company_name || '').toLowerCase()));
  const rlIsins = new Set(rl.map(x => x.isin).filter(Boolean));
  for (const r of rows) {
    r.on_restricted_list = rlNames.has((r.security_name || '').toLowerCase())
      || (r.isin && rlIsins.has(r.isin));
  }
  res.json({ queue: rows });
});

/**
 * POST /co/decide/:request_id
 * Approve or reject a pre-clearance request. Generates Annexure 6.
 * Body: { decision: 'approved'|'rejected', internal_note? }
 */
router.post('/co/decide/:request_id', requirePermission('insider.review'), (req, res) => {
  const { decision, internal_note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }
  const r = db.prepare(
    'SELECT * FROM insider_preclearance_requests WHERE id = ?'
  ).get(req.params.request_id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'pending') {
    return res.status(409).json({ error: `Request already decided (status: ${r.status})` });
  }
  const cfg = getConfig();
  const window = cfg ? cfg.trade_window_days : 7;
  const validUntil = decision === 'approved'
    ? addTradingDays(new Date().toISOString().slice(0, 10), window)
    : null;

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO insider_preclearance_decisions
       (request_id, decided_by, decision, valid_until, internal_note)
       VALUES (?, ?, ?, ?, ?)`
    ).run(r.id, req.user.id, decision, validUntil, internal_note || null);
    db.prepare(
      `UPDATE insider_preclearance_requests SET status = ? WHERE id = ?`
    ).run(decision, r.id);
    return info.lastInsertRowid;
  });
  const decisionId = tx();
  logInsider(req, 'annexure6.decided', 'preclearance', r.id, {
    decision, valid_until: validUntil
  });
  res.json({ ok: true, decision_id: decisionId, valid_until: validUntil });
});

// ─── Restricted List ────────────────────────────────────────────────────────

/** GET /co/restricted-list — current + history (CO + audit roles only). */
router.get('/co/restricted-list', requirePermission(['insider.restricted_list', 'insider.audit_trail']), (req, res) => {
  const includeHistory = req.query.history === '1';
  const sql = includeHistory
    ? 'SELECT * FROM insider_restricted_list ORDER BY id DESC'
    : 'SELECT * FROM insider_restricted_list WHERE removed_at IS NULL ORDER BY id DESC';
  res.json({ list: db.prepare(sql).all() });
});

/** POST /co/restricted-list — add a company. */
router.post('/co/restricted-list', requirePermission('insider.restricted_list'), (req, res) => {
  const b = req.body || {};
  if (!b.company_name) return res.status(400).json({ error: 'company_name required' });
  const info = db.prepare(
    `INSERT INTO insider_restricted_list
     (company_name, isin, scrip_code, added_by_partner, added_reason, matter_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    b.company_name, b.isin || null, b.scrip_code || null,
    req.user.id, b.added_reason || null, b.matter_id || null
  );
  logInsider(req, 'restricted_list.added', 'restricted_list', info.lastInsertRowid, {
    company_name: b.company_name, isin: b.isin
  });
  res.json({ ok: true, id: info.lastInsertRowid });
});

/** DELETE /co/restricted-list/:id — remove from list (UPSI became public, etc). */
router.delete('/co/restricted-list/:id', requirePermission('insider.restricted_list'), (req, res) => {
  const { removal_reason } = req.body || {};
  const r = db.prepare('SELECT * FROM insider_restricted_list WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.removed_at) return res.status(409).json({ error: 'Already removed' });
  db.prepare(
    `UPDATE insider_restricted_list
     SET removed_at = datetime('now'), removed_by = ?, removal_reason = ?
     WHERE id = ?`
  ).run(req.user.id, removal_reason || null, req.params.id);
  logInsider(req, 'restricted_list.removed', 'restricted_list', r.id, {
    company_name: r.company_name, reason: removal_reason
  });
  res.json({ ok: true });
});

// ─── UPSI Sharing Log ───────────────────────────────────────────────────────

/** GET /co/upsi-log — all UPSI sharing events (SEBI audit data). */
router.get('/co/upsi-log', requirePermission(['insider.upsi_log', 'insider.audit_trail']), (req, res) => {
  const rows = db.prepare(
    `SELECT l.*, u.full_name AS shared_by_name, u.email AS shared_by_email
     FROM insider_upsi_log l
     LEFT JOIN users u ON u.id = l.shared_by_user
     ORDER BY l.id DESC`
  ).all();
  res.json({ log: rows });
});

/** POST /co/upsi-log — log a sharing event. */
router.post('/co/upsi-log', requirePermission('insider.upsi_log'), (req, res) => {
  const b = req.body || {};
  for (const k of ['company_name', 'recipient_name', 'purpose']) {
    if (!b[k]) return res.status(400).json({ error: `${k} required` });
  }
  const info = db.prepare(
    `INSERT INTO insider_upsi_log
     (restricted_id, company_name, recipient_name, recipient_pan,
      recipient_other_id, recipient_type, purpose, shared_by_user,
      shared_ip, matter_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    b.restricted_id || null, b.company_name, b.recipient_name,
    b.recipient_pan || null, b.recipient_other_id || null,
    b.recipient_type || 'other', b.purpose,
    req.user.id, req.ip || null, b.matter_id || null
  );
  logInsider(req, 'upsi.logged', 'upsi_log', info.lastInsertRowid, {
    company: b.company_name, recipient: b.recipient_name
  });
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — DP ROSTER ADMIN (/admin/*)
// HR / super_admin manages who is a DP and what type. Requires insider.dp_admin.
// ═════════════════════════════════════════════════════════════════════════════

/** GET /admin/dps — all DPs with onboarding status. */
router.get('/admin/dps', requirePermission(['insider.dp_admin', 'insider.audit_trail']), (req, res) => {
  const rows = db.prepare(
    `SELECT dp.id AS dp_id, dp.dp_type, dp.designated_on, dp.removed_on,
            u.id AS user_id, u.full_name, u.email, u.is_active,
            (SELECT COUNT(*) FROM insider_acknowledgments WHERE dp_id = dp.id) AS ack_count,
            (SELECT COUNT(*) FROM insider_annexure1_statements WHERE dp_id = dp.id AND is_current = 1) AS anx1_count,
            (SELECT COUNT(*) FROM insider_holdings_statements WHERE dp_id = dp.id) AS holdings_count,
            (SELECT COUNT(*) FROM insider_preclearance_requests WHERE dp_id = dp.id) AS preclear_count
     FROM insider_designated_persons dp
     JOIN users u ON u.id = dp.user_id
     ORDER BY dp.removed_on IS NULL DESC, u.full_name`
  ).all();
  res.json({ dps: rows });
});

/** POST /admin/dps — designate a user. */
router.post('/admin/dps', requirePermission('insider.dp_admin'), (req, res) => {
  const { user_id, dp_type, notes } = req.body || {};
  if (!user_id || !dp_type) return res.status(400).json({ error: 'user_id and dp_type required' });
  const existing = db.prepare(
    `SELECT * FROM insider_designated_persons WHERE user_id = ? AND removed_on IS NULL`
  ).get(user_id);
  if (existing) return res.status(409).json({ error: 'Already a designated person' });
  const info = db.prepare(
    `INSERT INTO insider_designated_persons (user_id, dp_type, designated_by, notes)
     VALUES (?, ?, ?, ?)`
  ).run(user_id, dp_type, req.user.id, notes || null);
  logInsider(req, 'dp.designated', 'dp', info.lastInsertRowid, { user_id, dp_type });
  res.json({ ok: true, dp_id: info.lastInsertRowid });
});

/** DELETE /admin/dps/:id — remove DP status (left firm, etc). */
router.delete('/admin/dps/:id', requirePermission('insider.dp_admin'), (req, res) => {
  const { removal_reason } = req.body || {};
  db.prepare(
    `UPDATE insider_designated_persons
     SET removed_on = date('now'), removed_by = ?, removal_reason = ?
     WHERE id = ? AND removed_on IS NULL`
  ).run(req.user.id, removal_reason || null, req.params.id);
  logInsider(req, 'dp.removed', 'dp', Number(req.params.id), { reason: removal_reason });
  res.json({ ok: true });
});

/** GET /admin/dps/:id/submissions — full audit view of one DP. */
router.get('/admin/dps/:id/submissions', requirePermission(['insider.dp_admin', 'insider.audit_trail']), (req, res) => {
  const dpId = req.params.id;
  const dp = db.prepare(
    `SELECT dp.*, u.full_name, u.email
     FROM insider_designated_persons dp
     JOIN users u ON u.id = dp.user_id
     WHERE dp.id = ?`
  ).get(dpId);
  if (!dp) return res.status(404).json({ error: 'DP not found' });
  const acks = db.prepare(
    `SELECT a.*, v.version_label
     FROM insider_acknowledgments a
     JOIN insider_code_versions v ON v.id = a.code_version_id
     WHERE a.dp_id = ? ORDER BY a.signed_at DESC`
  ).all(dpId);
  const anx1s = db.prepare(
    'SELECT * FROM insider_annexure1_statements WHERE dp_id = ? ORDER BY id DESC'
  ).all(dpId);
  const holdings = db.prepare(
    'SELECT * FROM insider_holdings_statements WHERE dp_id = ? ORDER BY id DESC'
  ).all(dpId);
  const preclearances = db.prepare(
    `SELECT r.*, d.decision, d.decision_at, d.valid_until
     FROM insider_preclearance_requests r
     LEFT JOIN insider_preclearance_decisions d ON d.request_id = r.id
     WHERE r.dp_id = ? ORDER BY r.id DESC`
  ).all(dpId);
  res.json({ dp, acks, anx1s, holdings, preclearances });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — CONFIG (/config) — Management Committee only
// ═════════════════════════════════════════════════════════════════════════════

/** GET /config — read singleton. */
router.get('/config', requirePermission(['insider.config', 'insider.review', 'insider.audit_trail']), (req, res) => {
  res.json({ config: getConfig() });
});

/** PATCH /config — update settings. */
router.patch('/config', requirePermission('insider.config'), (req, res) => {
  const b = req.body || {};
  const cfg = getConfig();
  if (!cfg) return res.status(500).json({ error: 'Config row missing' });
  db.prepare(
    `UPDATE insider_config SET
       compliance_officer_id = COALESCE(?, compliance_officer_id),
       interim_co_id         = COALESCE(?, interim_co_id),
       pre_clearance_threshold = COALESCE(?, pre_clearance_threshold),
       trade_window_days     = COALESCE(?, trade_window_days),
       contra_trade_months   = COALESCE(?, contra_trade_months),
       annual_deadline_day   = COALESCE(?, annual_deadline_day),
       annual_deadline_month = COALESCE(?, annual_deadline_month),
       active_code_version_id = COALESCE(?, active_code_version_id),
       updated_by = ?,
       updated_at = datetime('now')
     WHERE id = 1`
  ).run(
    b.compliance_officer_id ?? null,
    b.interim_co_id ?? null,
    b.pre_clearance_threshold ?? null,
    b.trade_window_days ?? null,
    b.contra_trade_months ?? null,
    b.annual_deadline_day ?? null,
    b.annual_deadline_month ?? null,
    b.active_code_version_id ?? null,
    req.user.id
  );
  logInsider(req, 'config.updated', 'config', 1, b);
  res.json({ ok: true, config: getConfig() });
});

/** GET /code-versions — list Code revisions. */
router.get('/code-versions', requirePermission('insider.self'), (req, res) => {
  res.json({
    versions: db.prepare(
      'SELECT * FROM insider_code_versions ORDER BY id DESC'
    ).all(),
    active: getActiveCodeVersion()
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — AUDIT TRAIL (/audit) — Management Committee / Compliance Officer
// ═════════════════════════════════════════════════════════════════════════════

/** GET /audit — paginated audit trail (5-year retention). */
router.get('/audit', requirePermission('insider.audit_trail'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Number(req.query.offset) || 0;
  const rows = db.prepare(
    `SELECT * FROM insider_audit_trail
     ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM insider_audit_trail').get().c;
  res.json({ rows, total, limit, offset });
});

module.exports = router;
