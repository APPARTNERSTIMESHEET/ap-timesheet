const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.resolve(__dirname, '..', 'database', 'aptimesheet.db');
console.log('DB path:', dbPath);
const db = new Database(dbPath, { readonly: true });

// Loose search — anything containing "0008"
const rows = db.prepare(`
  SELECT id, invoice_no, status, client_id, subtotal, total, paid_at, created_at
  FROM invoices
  WHERE invoice_no LIKE '%0008%' OR invoice_no LIKE '%008%'
  ORDER BY id DESC LIMIT 20
`).all();
console.log('Matches:', JSON.stringify(rows, null, 2));

// Also: latest 10 invoices regardless
const recent = db.prepare(`
  SELECT id, invoice_no, status, total, paid_at
  FROM invoices
  ORDER BY id DESC LIMIT 10
`).all();
console.log('\nLatest 10 invoices:', JSON.stringify(recent, null, 2));
