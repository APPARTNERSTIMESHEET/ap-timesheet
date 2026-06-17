/**
 * Diagnose which DB the running app sees. Opens with the EXACT same options
 * as utils/db.js and forces a WAL checkpoint so we read latest committed state.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DB_PATH || './database/aptimesheet.db');
console.log('Resolved DB_PATH:', DB_PATH);
console.log('process.env.DB_PATH raw:', JSON.stringify(process.env.DB_PATH));

const db = new Database(DB_PATH);

// Force a WAL checkpoint so any pending writes from the running app are flushed
// into the main file before we read.
try {
  const cp = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  console.log('WAL checkpoint result:', cp);
} catch(e) { console.log('checkpoint failed:', e.message); }

const total = db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c;
console.log('Total invoices in this DB:', total);

const last5 = db.prepare(`
  SELECT id, invoice_no, status, ROUND(total,2) AS total, paid_at, created_at
  FROM invoices ORDER BY id DESC LIMIT 10
`).all();
console.log('Last 10 invoices:');
for (const r of last5) console.log('  ', JSON.stringify(r));

// Also search for ANY invoice with total = 0 (the issue we're trying to fix)
const zeroes = db.prepare(`
  SELECT id, invoice_no, status, ROUND(total,2) AS total, paid_at
  FROM invoices WHERE total <= 0 ORDER BY id DESC
`).all();
console.log('\nZero-total invoices:', zeroes.length);
for (const r of zeroes) console.log('  ', JSON.stringify(r));
