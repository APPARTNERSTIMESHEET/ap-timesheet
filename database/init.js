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
`;

function ensureSchema() {
  db.exec(SCHEMA);
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
}

if (require.main === module) {
  ensureSchema();
  console.log('[init] Schema ready at', db.name);
}

module.exports = { ensureSchema };
