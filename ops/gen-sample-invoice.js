/**
 * Generate a sample invoice PDF to ~/Downloads for visual review.
 * Usage: node ops/gen-sample-invoice.js [invoiceId]
 *
 * If no invoiceId is given, picks the most recently issued invoice from the
 * production DB and writes the PDF as sample-invoice-<no>.pdf.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Force the script to read the PRODUCTION database so the sample reflects what
// real clients receive. The OneDrive copy may be empty / out of date.
process.env.DB_PATH = process.env.DB_PATH || 'C:/ap-timesheet/database/aptimesheet.db';

const { db } = require('../utils/db');
const { streamInvoicePDFToBuffer } = require('../utils/invoice-pdf');

const argId = process.argv[2] ? parseInt(process.argv[2], 10) : null;

const target = argId
  ? db.prepare('SELECT id, invoice_no FROM invoices WHERE id = ?').get(argId)
  : db.prepare("SELECT id, invoice_no FROM invoices WHERE status IN ('issued','paid') ORDER BY id DESC LIMIT 1").get();

if (!target) {
  console.error('No invoice found. Pass an invoice id as the first arg.');
  process.exit(1);
}

(async () => {
  const buf = await streamInvoicePDFToBuffer(target.id);
  const safeNo = String(target.invoice_no).replace(/[^\w]/g, '_');
  const out = path.join(os.homedir(), 'Downloads', `sample-invoice-${safeNo}.pdf`);
  fs.writeFileSync(out, buf);
  console.log(`Sample PDF written: ${out}`);
  console.log(`Invoice ${target.invoice_no} · ${buf.length.toLocaleString()} bytes`);
})().catch(e => { console.error('Failed:', e); process.exit(1); });
