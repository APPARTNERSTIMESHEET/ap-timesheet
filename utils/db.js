/**
 * SQLite connection helper.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DB_PATH || './database/aptimesheet.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Safe migrations — add columns if they don't exist ────────────────────────
(function runMigrations() {
  const migrations = [
    "ALTER TABLE clients ADD COLUMN default_currency TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN tax_type TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN state_name TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN state_code TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN firm_entity TEXT DEFAULT 'delhi'",
    "ALTER TABLE timesheet_entries ADD COLUMN rate_override REAL DEFAULT NULL",
    // Review workflow tracking (only meaningful for draft invoices)
    "ALTER TABLE invoices ADD COLUMN review_stage TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN review_notes TEXT DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN review_assignee INTEGER DEFAULT NULL",
    "ALTER TABLE invoices ADD COLUMN review_updated_at TEXT DEFAULT NULL",
    // Revision tracking: if this invoice was created by revising another, store
    // the original invoice id so audit trail / PDF can reference it.
    "ALTER TABLE invoices ADD COLUMN parent_invoice_id INTEGER DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column already exists — safe to ignore */ }
  }

  // ── Expand role CHECK constraint to include 'billing' ────────────────────────
  // SQLite doesn't support ALTER COLUMN — we recreate the users table with the
  // updated constraint, then copy all data across.
  try {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (info && info.sql && !info.sql.includes("'billing'")) {
      db.pragma('foreign_keys = OFF');
      // Drop users_new if it exists from a previous failed attempt
      db.exec(`DROP TABLE IF EXISTS users_new;`);
      db.exec(`
        CREATE TABLE users_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          email           TEXT NOT NULL UNIQUE,
          password_hash   TEXT NOT NULL,
          full_name       TEXT NOT NULL,
          role            TEXT NOT NULL CHECK (role IN ('admin','associate','billing')),
          designation     TEXT,
          default_rate    REAL DEFAULT 0,
          lawyer_code     TEXT,
          is_active       INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (id, email, password_hash, full_name, role, designation, default_rate, lawyer_code, is_active, created_at)
          SELECT id, email, password_hash, full_name, role, designation, default_rate, lawyer_code, is_active, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      db.pragma('foreign_keys = ON');
      console.log('Role migration: added billing role to CHECK constraint');
    }
  } catch(e) { console.error('Role migration failed:', e.message); db.pragma('foreign_keys = ON'); }
})();

module.exports = { db };
