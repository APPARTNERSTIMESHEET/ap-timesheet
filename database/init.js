/**
 * Creates the schema if missing and seeds a default admin account.
 *
 * Run standalone:
 *   npm run init-db
 *
 * It is also called automatically from server.js on boot, so a fresh DB will
 * always be set up.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','associate')),
  designation     TEXT,
  default_rate    REAL DEFAULT 0,         -- per hour, INR
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT UNIQUE,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  email           TEXT,
  phone           TEXT,
  gstin           TEXT,
  address         TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  file_no         TEXT NOT NULL,                         -- internal matter number
  title           TEXT NOT NULL,
  description     TEXT,
  billing_type    TEXT NOT NULL DEFAULT 'hourly_user'     -- hourly_user | hourly_matter | flat | retainer
                  CHECK (billing_type IN ('hourly_user','hourly_matter','flat','retainer')),
  matter_rate     REAL DEFAULT 0,         -- used when billing_type = hourly_matter
  flat_fee        REAL DEFAULT 0,         -- used when billing_type = flat
  retainer_amount REAL DEFAULT 0,         -- used when billing_type = retainer (advance)
  retainer_used   REAL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open'           -- open | closed
                  CHECK (status IN ('open','closed')),
  opened_on       TEXT,
  closed_on       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_id, file_no)
);

-- per-user override rate for a matter (optional)
CREATE TABLE IF NOT EXISTS rate_cards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  matter_id       INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hourly_rate     REAL NOT NULL,
  effective_from  TEXT NOT NULL DEFAULT (date('now')),
  UNIQUE(matter_id, user_id, effective_from)
);

CREATE TABLE IF NOT EXISTS timesheet_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  matter_id       INTEGER NOT NULL REFERENCES matters(id),
  entry_date      TEXT NOT NULL,                         -- YYYY-MM-DD
  start_time      TEXT,                                  -- HH:MM (optional)
  end_time        TEXT,
  hours           REAL NOT NULL,                         -- decimal hours
  activity_type   TEXT NOT NULL,                         -- drafting/court/research/meeting/call/other
  description     TEXT NOT NULL,
  notes           TEXT,
  is_billable     INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'draft'          -- draft | submitted | approved | rejected | invoiced
                  CHECK (status IN ('draft','submitted','approved','rejected','invoiced')),
  rejection_note  TEXT,
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  invoice_id      INTEGER REFERENCES invoices(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ts_entry_date     ON timesheet_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_ts_user           ON timesheet_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ts_client_matter  ON timesheet_entries(client_id, matter_id);
CREATE INDEX IF NOT EXISTS idx_ts_status         ON timesheet_entries(status);

CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES timesheet_entries(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,             -- on-disk filename
  original_name   TEXT NOT NULL,
  mimetype        TEXT,
  size_bytes      INTEGER,
  uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no         TEXT UNIQUE NOT NULL,
  client_id          INTEGER NOT NULL REFERENCES clients(id),
  invoice_date       TEXT NOT NULL,
  period_from        TEXT,
  period_to          TEXT,
  subtotal           REAL NOT NULL DEFAULT 0,
  tax_rate           REAL NOT NULL DEFAULT 0,            -- e.g. 18 for 18% GST
  tax_amount         REAL NOT NULL DEFAULT 0,
  total              REAL NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'INR',
  status             TEXT NOT NULL DEFAULT 'issued'      -- draft | issued | paid | cancelled
                     CHECK (status IN ('draft','issued','paid','cancelled')),
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at            TEXT
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  matter_id    INTEGER REFERENCES matters(id),
  user_id      INTEGER REFERENCES users(id),
  description  TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 1,    -- hours, or 1 for flat
  unit         TEXT NOT NULL DEFAULT 'hr',
  rate         REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  action       TEXT NOT NULL,
  entity       TEXT,
  entity_id    INTEGER,
  detail       TEXT,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Leave management ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_types (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT UNIQUE NOT NULL,                  -- CL, SL, PL, EL, COMP, UNPAID
  name                 TEXT NOT NULL,
  default_annual_quota REAL NOT NULL DEFAULT 0,
  is_paid              INTEGER NOT NULL DEFAULT 1,
  carry_forward        INTEGER NOT NULL DEFAULT 0,
  max_carry_forward    REAL NOT NULL DEFAULT 0,
  color                TEXT NOT NULL DEFAULT '#3b82f6',
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id   INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL,
  allocated       REAL NOT NULL DEFAULT 0,
  used            REAL NOT NULL DEFAULT 0,
  pending         REAL NOT NULL DEFAULT 0,
  carried_forward REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, leave_type_id, year)
);
CREATE INDEX IF NOT EXISTS idx_lb_user_year ON leave_balances(user_id, year);

CREATE TABLE IF NOT EXISTS leave_applications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  leave_type_id         INTEGER NOT NULL REFERENCES leave_types(id),
  from_date             TEXT NOT NULL,
  to_date               TEXT NOT NULL,
  half_day_session      TEXT NOT NULL DEFAULT 'full'
                        CHECK (half_day_session IN ('full','first_half','second_half')),
  days                  REAL NOT NULL,
  reason                TEXT NOT NULL,
  contact_during_leave  TEXT,
  status                TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','approved','rejected','cancelled')),
  decided_by            INTEGER REFERENCES users(id),
  decided_at            TEXT,
  decision_note         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_la_user        ON leave_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_la_status      ON leave_applications(status);
CREATE INDEX IF NOT EXISTS idx_la_from_date   ON leave_applications(from_date);

CREATE TABLE IF NOT EXISTS holidays (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date  TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_optional   INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(holiday_date, name)
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);

-- ─── Work From Home applications ───────────────────────────────────────────
-- Parallel to leave_applications. Same approval workflow (submitted → approved
-- / rejected / cancelled) but NO balance deduction — the employee is working,
-- just remotely. Per AP HR policy, Retainers need prior approval from the
-- reporting partner; HR is also informed.
CREATE TABLE IF NOT EXISTS wfh_applications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  from_date          TEXT NOT NULL,
  to_date            TEXT NOT NULL,
  days               REAL NOT NULL,           -- working days in the range (skip weekends + holidays)
  reason             TEXT NOT NULL,
  contact_during_wfh TEXT,                    -- optional alt contact during WFH window
  status             TEXT NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted','approved','rejected','cancelled')),
  decided_by         INTEGER REFERENCES users(id),
  decided_at         TEXT,
  decision_note      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wfh_user      ON wfh_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_wfh_status    ON wfh_applications(status);
CREATE INDEX IF NOT EXISTS idx_wfh_from_date ON wfh_applications(from_date);

-- ─── RBAC: Roles, Permissions, Role-Permissions ─────────────────────────────
-- A role is a named bundle of permissions. The is_system flag marks built-in
-- roles (super_admin, admin, etc.) that the UI can't delete to prevent lockout.
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A permission is one atomic capability, like "users.delete" or "invoices.cancel".
-- Grouped by category for the matrix UI.
CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,     -- e.g. 'users.delete'
  category    TEXT NOT NULL,            -- e.g. 'Users'
  name        TEXT NOT NULL,            -- e.g. 'Delete users'
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by     INTEGER REFERENCES users(id),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS idx_rp_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_rp_perm ON role_permissions(permission_id);

-- Optional per-user permission overrides (additive on top of role). Useful when
-- one HR person also needs to view billing reports without changing the HR role.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id  INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by     INTEGER REFERENCES users(id),
  PRIMARY KEY (user_id, permission_id)
);

-- ─── Personal reminders (per-user to-do list with popup notifications) ───
-- Lets admins / billing / lawyers set their own reminders: "Follow up with
-- Reliance on contract draft", "Call Anjali about partnership note", etc.
-- A popup appears on login when any reminder is due (date <= today and not
-- dismissed). Optionally linked to a client / matter / invoice for context.
CREATE TABLE IF NOT EXISTS user_reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  notes         TEXT,
  remind_on     TEXT NOT NULL,           -- YYYY-MM-DD when the popup should appear
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','urgent')),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','done','dismissed')),
  -- Optional links to provide context (clicking the reminder opens that item)
  client_id     INTEGER REFERENCES clients(id),
  matter_id     INTEGER REFERENCES matters(id),
  invoice_id    INTEGER REFERENCES invoices(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_user_status ON user_reminders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_remind_on   ON user_reminders(remind_on);

-- ─── Security: Login attempt tracking ──────────────────────────────────────
-- Records every login attempt (success or failure) with IP address for
-- forensic analysis and brute-force detection. The lockout logic reads
-- recent failures to block repeated bad-password attempts.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL COLLATE NOCASE,
  ip_address  TEXT,
  user_agent  TEXT,
  success     INTEGER NOT NULL DEFAULT 0,    -- 0 = failed, 1 = success
  failure_reason TEXT,                       -- 'invalid_email', 'wrong_password', 'account_locked', 'inactive'
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_email    ON login_attempts(email);
CREATE INDEX IF NOT EXISTS idx_login_ip       ON login_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_login_at       ON login_attempts(attempted_at);

-- ─── Security: Active sessions tracking ────────────────────────────────────
-- Tracks active JWT sessions so super_admin can revoke them (force logout).
CREATE TABLE IF NOT EXISTS active_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,                 -- SHA-256 of the JWT (never store raw token)
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT                           -- NULL = active; non-NULL = force-revoked
);
CREATE INDEX IF NOT EXISTS idx_sess_user   ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sess_hash   ON active_sessions(token_hash);

-- ─── LEDES: Legal Electronic Data Exchange Standard ─────────────────────────
-- International e-billing format required by Fortune 500 corporate clients
-- and their e-billing platforms (Tymetrix 360, LegalTracker, Passport, etc.).
-- See https://ledes.org

-- UTBMS Task Codes (L100-L800 Litigation, C100-C800 Counseling, etc.)
CREATE TABLE IF NOT EXISTS utbms_task_codes (
  code        TEXT PRIMARY KEY,         -- e.g. L120, C100
  category    TEXT NOT NULL,            -- Litigation, Counseling, Project, Bankruptcy
  description TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- UTBMS Activity Codes (A101-A111 — how the work was performed)
CREATE TABLE IF NOT EXISTS utbms_activity_codes (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- UTBMS Expense Codes (E101-E124 — types of disbursements)
CREATE TABLE IF NOT EXISTS utbms_expense_codes (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- Per-firm mapping of internal activity_type to UTBMS task + activity codes.
-- client_id NULL = global default; non-NULL = per-client override.
CREATE TABLE IF NOT EXISTS activity_utbms_mapping (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_type TEXT NOT NULL,           -- our internal: drafting, court, research, meeting, call, review, other
  task_code     TEXT REFERENCES utbms_task_codes(code),
  activity_code TEXT REFERENCES utbms_activity_codes(code),
  client_id     INTEGER REFERENCES clients(id),  -- NULL = global default
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(activity_type, client_id)
);

-- Audit log of every LEDES export -- proves what was sent to which client when.
CREATE TABLE IF NOT EXISTS ledes_exports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id),
  format_version  TEXT NOT NULL,        -- '1998B', '1998BI', 'XML-2.0', 'XML-2.1'
  filename        TEXT,
  line_item_count INTEGER,
  total_amount    REAL,
  currency        TEXT,
  exported_by     INTEGER REFERENCES users(id),
  exported_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledes_invoice ON ledes_exports(invoice_id);
`;

function ensureSchema() {
  db.exec(SCHEMA);
  // Migrations — add columns if missing
  const migrations = [
    "ALTER TABLE clients ADD COLUMN state_name TEXT",
    "ALTER TABLE clients ADD COLUMN state_code TEXT",
    "ALTER TABLE clients ADD COLUMN kind_attn  TEXT",
    "ALTER TABLE clients ADD COLUMN ref_text   TEXT",
    "ALTER TABLE invoices ADD COLUMN currency  TEXT NOT NULL DEFAULT 'INR'",
    "ALTER TABLE users ADD COLUMN lawyer_code TEXT",
    "ALTER TABLE invoices ADD COLUMN due_date TEXT",
    "ALTER TABLE invoices ADD COLUMN payment_ref TEXT",
    // Leave types: how the working-day count is calculated. Most types use
    // 'working_days' (skip weekends + holidays). Maternity per the Maternity
    // Benefit Act 1961 counts ALL calendar days, so this lets us mark such
    // types with 'calendar_days' instead.
    "ALTER TABLE leave_types ADD COLUMN count_method TEXT NOT NULL DEFAULT 'working_days'",

    // ── RBAC: FK to roles table. Old `role` text column is kept in place so
    // existing middleware (req.user.role) keeps working through the rollout.
    // Once the new middleware is everywhere, we can ignore the text column.
    "ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)",

    // ── Soft-delete + recycle-bin columns. NULL = not deleted; non-NULL =
    // deleted, recoverable by super_admin from the recycle bin. Forever
    // retention per product decision — no auto-purge.
    "ALTER TABLE users    ADD COLUMN deleted_at TEXT",
    "ALTER TABLE users    ADD COLUMN deleted_by INTEGER REFERENCES users(id)",
    "ALTER TABLE clients  ADD COLUMN deleted_at TEXT",
    "ALTER TABLE clients  ADD COLUMN deleted_by INTEGER REFERENCES users(id)",
    "ALTER TABLE matters  ADD COLUMN deleted_at TEXT",
    "ALTER TABLE matters  ADD COLUMN deleted_by INTEGER REFERENCES users(id)",
    "ALTER TABLE invoices ADD COLUMN deleted_at TEXT",
    "ALTER TABLE invoices ADD COLUMN deleted_by INTEGER REFERENCES users(id)",

    // ── Audit log enrichment: store actor's name/email at log-time so the
    // forensic trail survives even if the user account is later hard-deleted.
    "ALTER TABLE audit_log ADD COLUMN user_email TEXT",
    "ALTER TABLE audit_log ADD COLUMN user_name  TEXT",

    // ── Impersonation tracking: when super_admin "logs in as" another user,
    // every audit log row from that session records the original actor here.
    "ALTER TABLE audit_log ADD COLUMN impersonated_by INTEGER REFERENCES users(id)",

    // ── users.updated_at restoration. The original schema had this column but
    // the billing-role CHECK-constraint migration in utils/db.js recreates the
    // table and accidentally drops it, breaking every PATCH (no such column).
    // SQLite ALTER TABLE doesn't allow non-constant defaults; we add a nullable
    // column and let UPDATEs populate it on next write.
    "ALTER TABLE users ADD COLUMN updated_at TEXT",

    // ── Per-invoice discount support. Either a flat ₹ amount (discount_type
    // = 'flat') or a percentage of subtotal ('percent'). discount_note is a
    // free-text reason shown on the PDF ("Loyalty discount", "Festive offer",
    // "Goodwill adjustment", etc).
    "ALTER TABLE invoices ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN discount_type   TEXT NOT NULL DEFAULT 'flat'",
    "ALTER TABLE invoices ADD COLUMN discount_note   TEXT",

    // ── Security: last login tracking on user record ────────────────────
    "ALTER TABLE users ADD COLUMN last_login_at TEXT",
    "ALTER TABLE users ADD COLUMN last_login_ip TEXT",
    "ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN locked_until TEXT",   // NULL = not locked; ISO datetime = locked until

    // ── Associate-logged expenses on timesheet entries ─────────────────
    // Lawyers can attach an out-of-pocket expense (e.g., court fee, travel,
    // courier) to a timesheet entry. Stored alongside the time entry so the
    // billing team sees both labour and reimbursable disbursements when
    // generating the invoice. Currency follows the matter / invoice.
    "ALTER TABLE timesheet_entries ADD COLUMN expense_amount REAL NOT NULL DEFAULT 0",
    "ALTER TABLE timesheet_entries ADD COLUMN expense_description TEXT",

    // ── LEDES: International e-billing support ───────────────────────────
    // Timekeeper classification per LEDES standard: PARTNER, SENIOR_ASSOCIATE,
    // ASSOCIATE, OF_COUNSEL, PARALEGAL, LAW_CLERK, OTHER. Required by client
    // e-billing platforms to validate rates against pre-approved schedules.
    "ALTER TABLE users ADD COLUMN timekeeper_classification TEXT",

    // Client's own internal ID for the firm (e.g., 'APPARTNERS-IN-001').
    // Required in CLIENT_ID field of LEDES output.
    "ALTER TABLE clients ADD COLUMN client_internal_id TEXT",

    // Whether this client requires LEDES e-billing for invoices.
    "ALTER TABLE clients ADD COLUMN requires_ledes INTEGER NOT NULL DEFAULT 0",

    // Preferred LEDES format per client (1998B, 1998BI, XML-2.0, XML-2.1).
    "ALTER TABLE clients ADD COLUMN ledes_format TEXT",

    // Client's matter ID (their internal code, different from our file_no).
    // Required by LEDES CLIENT_MATTER_ID field for cross-system reconciliation.
    "ALTER TABLE matters ADD COLUMN client_matter_id TEXT",

    // ── GST Reverse Charge Mechanism (RCM) toggle per invoice ─────────────
    // 1 (default) = client pays GST directly to govt; firm collects only the
    //   service fee. Grand total = subtotal − discount.
    // 0           = firm collects GST → grand total = subtotal − discount + tax.
    // Existing rows backfill to 1 to preserve historical behaviour.
    "ALTER TABLE invoices ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 1",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column already exists — skip */ }
  }
  // Default admin if no users exist
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const passwordHash = bcrypt.hashSync('Admin@123', 10);
    db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, designation, default_rate)
       VALUES (?, ?, ?, 'admin', ?, ?)`
    ).run('it@appartners.in', passwordHash, 'Mohd Amir', 'IT Manager', 0);
    console.log('[init] Created default admin → it@appartners.in / Admin@123');
  }

  // Default leave types — only seed if the table is empty (lets admins fully
  // customise after first boot without us overwriting their changes).
  const ltCount = db.prepare('SELECT COUNT(*) AS c FROM leave_types').get().c;
  if (ltCount === 0) {
    const seedLT = db.prepare(
      `INSERT INTO leave_types (code, name, default_annual_quota, is_paid, carry_forward, max_carry_forward, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const defaults = [
      ['CL',     'Casual Leave',   12, 1, 0, 0,  '#3b82f6'],
      ['SL',     'Sick Leave',     8,  1, 0, 0,  '#ef4444'],
      ['PL',     'Privilege Leave',15, 1, 1, 30, '#10b981'],
      ['COMP',   'Compensatory Off', 0, 1, 0, 0, '#f59e0b'],
      ['UNPAID', 'Unpaid Leave',   0,  0, 0, 0,  '#6b7280'],
    ];
    for (const row of defaults) seedLT.run(...row);
    console.log('[init] Seeded default leave types (CL, SL, PL, COMP, UNPAID)');
  }

  // RBAC: seed roles + permissions + grants. Idempotent — safe on every boot.
  try {
    require('./seed-rbac').seedRBAC();
  } catch (e) {
    console.error('[init] RBAC seed failed:', e.message);
  }

  // LEDES: seed UTBMS codes + default activity_type mappings.
  try {
    require('./seed-utbms').seedUTBMS();
  } catch (e) {
    console.error('[init] UTBMS seed failed:', e.message);
  }
}

if (require.main === module) {
  ensureSchema();
  console.log('[init] Schema ready at', db.name);
}

module.exports = { ensureSchema };
