/**
 * Render an invoice as a PDF buffer / stream using PDFKit.
 */
const PDFDocument = require('pdfkit');
const { db } = require('./db');

function fmtCurrency(amount, currency) {
  const sym = currency === 'INR' ? '₹' : (currency || '');
  const n = Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym} ${n}`;
}

function streamInvoicePDF(invoiceId, res) {
  const inv = db.prepare(`
    SELECT i.*, c.name AS client_name, c.gstin AS client_gstin, c.address AS client_address,
           c.email AS client_email, c.phone AS client_phone, c.contact_person
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ?
  `).get(invoiceId);
  if (!inv) { res.status(404).json({ error: 'Invoice not found' }); return; }
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);

  const firm = {
    name: process.env.FIRM_NAME || 'AP & Partners',
    tagline: process.env.FIRM_TAGLINE || 'Advocates & Solicitors',
    addr1: process.env.FIRM_ADDRESS_LINE1 || '',
    addr2: process.env.FIRM_ADDRESS_LINE2 || '',
    city:  process.env.FIRM_CITY || '',
    phone: process.env.FIRM_PHONE || '',
    email: process.env.FIRM_EMAIL || '',
    gstin: process.env.FIRM_GSTIN || ''
  };

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_no.replace(/[\\/]/g, '-')}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(22).fillColor('#1f2937').font('Helvetica-Bold').text(firm.name, { continued: false });
  doc.fontSize(10).fillColor('#6b7280').font('Helvetica').text(firm.tagline);
  if (firm.addr1) doc.text(firm.addr1);
  if (firm.addr2) doc.text(firm.addr2);
  if (firm.city)  doc.text(firm.city);
  doc.text([firm.phone, firm.email].filter(Boolean).join('   |   '));
  if (firm.gstin) doc.text(`GSTIN: ${firm.gstin}`);
  doc.moveDown();

  // Invoice meta
  const metaTop = doc.y;
  doc.fontSize(20).fillColor('#111827').font('Helvetica-Bold').text('TAX INVOICE', 350, 50, { align: 'right', width: 200 });
  doc.fontSize(10).fillColor('#374151').font('Helvetica');
  doc.text(`Invoice No: ${inv.invoice_no}`, 350, 78, { align: 'right', width: 200 });
  doc.text(`Date: ${inv.invoice_date}`, 350, 92, { align: 'right', width: 200 });
  if (inv.period_from && inv.period_to) {
    doc.text(`Period: ${inv.period_from} to ${inv.period_to}`, 350, 106, { align: 'right', width: 200 });
  }
  doc.text(`Status: ${inv.status.toUpperCase()}`, 350, 120, { align: 'right', width: 200 });
  doc.y = Math.max(doc.y, metaTop + 80);
  doc.moveDown(2);

  // Bill to
  doc.fontSize(11).fillColor('#111827').font('Helvetica-Bold').text('Bill To', 50);
  doc.fontSize(10).font('Helvetica').fillColor('#374151');
  doc.text(inv.client_name);
  if (inv.contact_person) doc.text(`Attn: ${inv.contact_person}`);
  if (inv.client_address) doc.text(inv.client_address);
  if (inv.client_email)   doc.text(inv.client_email);
  if (inv.client_phone)   doc.text(inv.client_phone);
  if (inv.client_gstin)   doc.text(`GSTIN: ${inv.client_gstin}`);
  doc.moveDown();

  // Items table
  const tableTop = doc.y + 10;
  const cols = {
    desc: 50, qty: 350, rate: 410, amount: 480
  };
  const colW = { desc: 290, qty: 50, rate: 60, amount: 70 };

  doc.fillColor('#ffffff').rect(50, tableTop, 510, 22).fill('#1f2937');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
  doc.text('Description', cols.desc + 6, tableTop + 6, { width: colW.desc - 10 });
  doc.text('Qty',         cols.qty,      tableTop + 6, { width: colW.qty,    align: 'right' });
  doc.text('Rate',        cols.rate,     tableTop + 6, { width: colW.rate,   align: 'right' });
  doc.text('Amount',      cols.amount,   tableTop + 6, { width: colW.amount, align: 'right' });

  let y = tableTop + 22;
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  let alt = false;
  for (const it of items) {
    if (y > 720) { doc.addPage(); y = 60; }
    if (alt) doc.fillColor('#ffffff').rect(50, y, 510, 22).fill('#f9fafb');
    doc.fillColor('#111827');
    doc.text(it.description, cols.desc + 6, y + 6, { width: colW.desc - 10 });
    doc.text(`${Number(it.quantity).toFixed(2)} ${it.unit}`, cols.qty, y + 6, { width: colW.qty, align: 'right' });
    doc.text(fmtCurrency(it.rate, inv.currency), cols.rate, y + 6, { width: colW.rate, align: 'right' });
    doc.text(fmtCurrency(it.amount, inv.currency), cols.amount, y + 6, { width: colW.amount, align: 'right' });
    y += 22; alt = !alt;
  }

  // Totals
  y += 6;
  const labelX = 380, valueX = 480, valueW = 80;
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  doc.text('Subtotal', labelX, y, { width: 90, align: 'right' });
  doc.text(fmtCurrency(inv.subtotal, inv.currency), valueX, y, { width: valueW, align: 'right' });
  y += 18;
  if (inv.tax_rate > 0) {
    doc.text(`Tax (${inv.tax_rate}%)`, labelX, y, { width: 90, align: 'right' });
    doc.text(fmtCurrency(inv.tax_amount, inv.currency), valueX, y, { width: valueW, align: 'right' });
    y += 18;
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827');
  doc.text('Total', labelX, y + 4, { width: 90, align: 'right' });
  doc.text(fmtCurrency(inv.total, inv.currency), valueX, y + 4, { width: valueW, align: 'right' });
  doc.font('Helvetica');

  // Notes / footer
  if (inv.notes) {
    doc.moveDown(3);
    doc.fontSize(10).fillColor('#374151').font('Helvetica-Bold').text('Notes');
    doc.font('Helvetica').fillColor('#4b5563').text(inv.notes, { width: 510 });
  }

  doc.fontSize(9).fillColor('#6b7280').text(
    `This is a computer-generated invoice. For queries: ${firm.email || firm.phone}`,
    50, 770, { width: 510, align: 'center' }
  );

  doc.end();
}

module.exports = { streamInvoicePDF };
