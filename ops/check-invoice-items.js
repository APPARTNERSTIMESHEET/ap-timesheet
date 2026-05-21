process.env.DB_PATH = 'C:/ap-timesheet/database/aptimesheet.db';
const { db } = require('../utils/db');
const inv = db.prepare(
  "SELECT id, invoice_no, status FROM invoices WHERE invoice_no LIKE 'AP/2026/%' ORDER BY id DESC LIMIT 5"
).all();
console.log('Latest 5 invoices on prod:');
console.table(inv);
if (inv[0]) {
  const items = db.prepare(
    `SELECT ii.id, ii.user_id, u.full_name AS lawyer, ii.matter_id, ii.description, ii.quantity, ii.rate, ii.amount
     FROM invoice_items ii LEFT JOIN users u ON u.id = ii.user_id
     WHERE ii.invoice_id = ? ORDER BY ii.id`
  ).all(inv[0].id);
  console.log(`Items for ${inv[0].invoice_no}:`);
  console.table(items);
}
