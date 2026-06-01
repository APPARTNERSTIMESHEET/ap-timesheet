/**
 * Invoice PDF — AP & Partners | Main page + per-matter annexures
 * Professional A4 layout, 10pt body text, properly spaced sections
 */
const PDFDocument = require('pdfkit');
const { db } = require('./db');

// ── Layout constants ─────────────────────────────────────────────────────────
const L = 45, R = 550;   // left/right margins on A4 (595pt wide)
const W = R - L;         // 505pt usable width

// ── Amount helpers ──────────────────────────────────────────────────────────
const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
  'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
function w1000(n) {
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' '+ones[n%10] : '');
  return ones[Math.floor(n/100)]+' Hundred'+(n%100 ? ' '+w1000(n%100) : '');
}
function amountInWords(amount, currency) {
  const n = Math.round(Number(amount)*100);
  const main = Math.floor(n/100), sub = n%100;
  const pfx = currency==='INR' ? 'Rs.' : '('+currency+')';
  let w = '';
  if (!main) { w='Zero'; }
  else {
    const cr=Math.floor(main/10000000), lk=Math.floor((main%10000000)/100000),
          th=Math.floor((main%100000)/1000), rm=main%1000;
    if(cr) w+=w1000(cr)+' Crore '; if(lk) w+=w1000(lk)+' Lakh ';
    if(th) w+=w1000(th)+' Thousand '; if(rm) w+=w1000(rm);
    w=w.trim();
  }
  if(currency==='INR'){ if(sub) w+=' and '+w1000(sub)+' Paise'; w+=' Only'; }
  else { if(sub) w+=' and '+w1000(sub)+' Cents'; w+=' Only'; }
  return pfx+' '+w;
}
function fmtAmt(n) {
  return Number(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtDate(d) {
  if(!d) return '';
  const mo=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const p=d.split('-'); if(p.length===3) return parseInt(p[2])+' '+mo[parseInt(p[1])-1]+' '+p[0]; return d;
}
function fmtDateShort(d) {
  if(!d) return '';
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p=d.split('-'); if(p.length===3) return parseInt(p[2])+'-'+mo[parseInt(p[1])-1]+'-'+p[0]; return d;
}
function periodLabel(from) {
  if(!from) return '';
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p=from.split('-'); return mo[parseInt(p[1])-1]+"'"+p[0].slice(2);
}
function fmtHours(h) {
  const hh=Math.floor(h), mm=Math.round((h-hh)*60);
  return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
}
function rateForUser(matterId, userId, asOfDate) {
  // Use the rate that was in effect on the entry's date so that a future-dated
  // rate change does not retroactively alter past invoices.
  const cutoff = asOfDate || new Date().toISOString().slice(0,10);
  const c=db.prepare('SELECT hourly_rate FROM rate_cards WHERE matter_id=? AND user_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1').get(matterId,userId,cutoff);
  if(c) return c.hourly_rate;
  const u=db.prepare('SELECT default_rate FROM users WHERE id=?').get(userId);
  return u&&u.default_rate ? u.default_rate : 0;
}
function initials(name) {
  if(!name) return '???';
  return name.split(' ').filter(Boolean).map(w=>w[0].toUpperCase()).join('').slice(0,3);
}

// ── Firm entity definitions ──────────────────────────────────────────────────
const FIRM_ENTITIES = {
  delhi: {
    name:      'AP & PARTNERS, ADVOCATES',
    lines: [
      'C-77, G.F, Panchsheel Enclave, Panchsheel Park, New Delhi - 110017, India',
      'E-mail: accounts@appartners.in   Tel: +91 11 42594444',
      'GSTIN: 07ABPFA8851M1ZP   PAN: ABPFA8851M'
    ],
    gstin: '07ABPFA8851M1ZP', state: 'Delhi', stateCode: '07'
  },
  haryana: {
    name:      'AP AND PARTNERS, ADVOCATES',
    lines: [
      '5th Floor, Global Gateway Tower A, M G Road, Sector 26, Gurgaon, Haryana',
      'GSTIN/UIN: 06ABPFA8851M1ZR   State Name: Haryana, Code: 06',
      'E-Mail: accounts@appartners.in'
    ],
    gstin: '06ABPFA8851M1ZR', state: 'Haryana', stateCode: '06'
  }
};

// ── Page header ─────────────────────────────────────────────────────────────
function pageHeader(doc, inv, label, isDraft) {
  const fe = FIRM_ENTITIES[inv.firm_entity || 'delhi'] || FIRM_ENTITIES.delhi;
  let y = 35;

  // Firm name — large bold
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#1c3d5a').text(fe.name, L, y); y += 17;

  // Address lines — use doc.y to handle any wrapping
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  for (const line of fe.lines) {
    doc.text(line, L, y, {width: R - L - 120}); // leave room for label on right
    y = doc.y + 2;
  }

  // Label (right-aligned) and optional DRAFT watermark
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
     .text(label, L, 35, {width: W, align: 'right'});

  if (isDraft) {
    doc.save();
    doc.font('Helvetica-Bold').fontSize(60).fillColor('#cc0000').opacity(0.08)
       .text('DRAFT', 0, 250, {width: 595, align: 'center', lineBreak: false});
    doc.restore();
  }

  y += 6;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor('#1c3d5a').stroke();
  return y + 10;
}

// ── Derive clean 2-char GST state code ──────────────────────────────────────
function resolveStateCode(state_code, gstin) {
  const sc = (state_code || '').trim();
  if (sc.length === 2 && /^\d{2}$/.test(sc)) return sc;
  const g = (gstin || '').trim();
  if (g.length >= 15 && /^\d{2}/.test(g)) return g.slice(0, 2);
  return sc || '';
}

// ── Main invoice page ────────────────────────────────────────────────────────
function mainPage(doc, inv, items, currency, isDraft) {
  const isINR = currency === 'INR';
  const sub    = Number(inv.subtotal || 0);
  const totTax = Number(inv.tax_amount || 0);
  const tot    = Number(inv.total || sub);
  // GST Reverse Charge flag — default true for older invoices that pre-date
  // the column. When true, firm bills only the service fee; client pays tax
  // directly. When false, firm collects tax → grand total = netSub + totTax.
  const reverseCharge = (inv.reverse_charge === undefined || inv.reverse_charge === null)
                        ? true : !!Number(inv.reverse_charge);

  // Discount applied at invoice level (flat ₹ or percent of subtotal). The
  // stored discount_amount is always the absolute ₹ value (computed at save
  // time), so we only need the type + note for display formatting.
  const discAmt  = Number(inv.discount_amount || 0);
  const discType = inv.discount_type || 'flat';
  const discNote = (inv.discount_note || '').trim();
  const hasDiscount = discAmt > 0;
  // `inv.subtotal` is the GROSS (pre-discount) subtotal; `inv.total` is post-
  // discount. We expose both so the summary section can show the breakdown.
  const netSub = Math.max(0, Math.round((sub - discAmt) * 100) / 100);

  const derivedStateCode = resolveStateCode(inv.state_code, inv.client_gstin);
  const fe = FIRM_ENTITIES[inv.firm_entity || 'delhi'] || FIRM_ENTITIES.delhi;

  const clientState = derivedStateCode;
  const autoSameState = (clientState === fe.stateCode);
  const isSameState = inv.tax_type === 'intra_state' ? true
                    : inv.tax_type === 'inter_state'  ? false
                    : autoSameState;
  const taxRate = Number(inv.tax_rate || 0);
  const cgstRate = isSameState ? taxRate/2 : 0;
  const sgstRate = isSameState ? taxRate/2 : 0;
  const igstRate = isSameState ? 0 : taxRate;
  const cgstAmt  = isSameState ? Math.round(totTax/2*100)/100 : 0;
  const sgstAmt  = isSameState ? Math.round(totTax/2*100)/100 : 0;
  const igstAmt  = isSameState ? 0 : totTax;

  let y = pageHeader(doc, inv, 'Original for Recipient', isDraft);

  // ── Title ──────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000')
     .text(isDraft ? 'Tax Invoice (DRAFT)' : 'Tax Invoice', L, y, {width:W, align:'center'});
  y += 26;

  // If this invoice is a revision of an earlier one, show a small notice so
  // the recipient can tell it's a corrected version of an invoice they may
  // have already seen. Lookup the parent invoice number for display.
  if (inv.parent_invoice_id) {
    try {
      const parent = db.prepare('SELECT invoice_no FROM invoices WHERE id = ?').get(inv.parent_invoice_id);
      if (parent && parent.invoice_no) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#7a4413')
           .text('This invoice supersedes the earlier (cancelled) invoice ' + parent.invoice_no,
                 L, y, {width: W, align: 'center'});
        y += 14;
      }
    } catch(e) { /* non-blocking — just skip the notice */ }
  }

  // ── Invoice meta box ────────────────────────────────────────────────────────
  // Two rows, two columns each
  const mLW = 100, mRX = 340;
  const rowH = 20;
  doc.rect(L, y, W, rowH*2).stroke('#ccc');
  doc.moveTo(L, y+rowH).lineTo(R, y+rowH).lineWidth(0.3).strokeColor('#ccc').stroke();
  doc.moveTo(mRX, y).lineTo(mRX, y+rowH*2).lineWidth(0.3).strokeColor('#ccc').stroke();

  // Row 1
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555')
     .text('Invoice No:', L+6, y+5, {lineBreak:false, width:mLW});
  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
     .text(inv.invoice_no, L+6+mLW, y+5, {lineBreak:false});
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555')
     .text('Firm State:', mRX+6, y+5, {lineBreak:false, width:mLW});
  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
     .text(fe.state + '  (Code: ' + fe.stateCode + ')', mRX+6+mLW, y+5);

  // Row 2
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555')
     .text('Invoice Date:', L+6, y+rowH+5, {lineBreak:false, width:mLW});
  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
     .text(fmtDate(inv.invoice_date), L+6+mLW, y+rowH+5, {lineBreak:false});
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555')
     .text('Due Date:', mRX+6, y+rowH+5, {lineBreak:false, width:mLW});
  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
     .text(inv.due_date ? fmtDate(inv.due_date) : '—', mRX+6+mLW, y+rowH+5);
  y += rowH*2 + 12;

  // ── Invoice To / Place of Supply ──────────────────────────────────────────
  const col2X = L + 290;
  const addrW = col2X - L - 10;   // left column width
  const posW  = R - col2X - 4;    // right column width

  // Section headers
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1c3d5a')
     .text('INVOICE TO', L, y, {width: addrW, lineBreak: false});
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1c3d5a')
     .text('PLACE OF SUPPLY', col2X, y, {width: posW, lineBreak: false});
  y += 15;

  const startY = y;
  let aY = startY, sY = startY;

  // ── Left: Client block ────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
     .text(inv.client_name || '', L, aY, {width: addrW});
  aY = doc.y + 3;

  if (inv.client_address) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#333');
    const addrLines = inv.client_address.split('\n').filter(l => l.trim());
    for (const ln of addrLines) {
      doc.text(ln.trim(), L, aY, {width: addrW});
      aY = doc.y + 2;
    }
  }
  if (isINR && inv.client_gstin) {
    // Render "GSTIN: XXXXXXXX" as a single string to avoid Y-tracking issues
    doc.font('Helvetica').fontSize(9).fillColor('#000')
       .text('GSTIN: ' + inv.client_gstin, L, aY, {width: addrW});
    aY = doc.y + 2;
  }

  // ── Right: Place of Supply block ─────────────────────────────────────────
  const posStateName = isINR ? (inv.state_name || '') : 'Outside India';
  const posStateCode = isINR ? (derivedStateCode || 'N.A.') : 'N.A.';
  const ka = inv.kind_attn || inv.contact_person || '';
  const refTxt = inv.ref_text || (isINR ? 'Legal Services' : 'Legal services');

  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
     .text('State: ' + posStateName, col2X, sY, {width: posW});
  sY = doc.y + 2;
  doc.text('State Code: ' + posStateCode, col2X, sY, {width: posW});
  sY = doc.y + 2;
  if (ka) {
    doc.text('Kind Attn.: ' + ka, col2X, sY, {width: posW});
    sY = doc.y + 2;
  }
  doc.text('Ref: ' + refTxt, col2X, sY, {width: posW});
  sY = doc.y + 2;

  y = Math.max(aY, sY) + 12;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#ccc').stroke();
  y += 10;

  // ── Service table ──────────────────────────────────────────────────────────
  // Columns: Description | HSN Code | Amount
  const c1w = W - 80 - 110, c2w = 80, c3w = 110;
  const c1x = L, c2x = L+c1w, c3x = L+c1w+c2w;
  const rH = 22;

  function tblRect(ty, th) {
    doc.rect(L, ty, W, th).stroke('#aaa');
    doc.moveTo(c2x, ty).lineTo(c2x, ty+th).lineWidth(0.3).strokeColor('#bbb').stroke();
    doc.moveTo(c3x, ty).lineTo(c3x, ty+th).lineWidth(0.3).strokeColor('#bbb').stroke();
  }

  // Header
  doc.rect(L, y, W, rH).fillAndStroke('#1c3d5a', '#1c3d5a');
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#fff');
  doc.text('Description of Services',  c1x+6,  y+6, {width:c1w-12, align:'left',   lineBreak:false});
  doc.text('HSN Code',                 c2x+2,  y+6, {width:c2w-4,  align:'center',  lineBreak:false});
  doc.text('Amount ('+currency+')',    c3x+4,  y+6, {width:c3w-8,  align:'right'});
  doc.fillColor('#000'); y += rH;

  if (isINR) {
    // Split items: matter-linked fees (timesheet-derived) get consolidated
    // into the standard "Fees for legal services" line; custom non-matter items
    // (e.g. travel reimbursement, court filing fees that the user added on the
    // editable preview) show as separate line rows so they're visible to the client.
    const matterItems = items.filter(it => it.matter_id);
    const customItems = items.filter(it => !it.matter_id);
    const matterSub   = matterItems.reduce((s, it) => s + Number(it.amount || 0), 0);

    if (matterItems.length || !customItems.length) {
      const rowH2 = rH;
      tblRect(y, rowH2);
      doc.font('Helvetica').fontSize(9.5).fillColor('#000');
      doc.text('Fees for legal services for the month of ' + periodLabel(inv.period_from),
               c1x+6, y+6, {width:c1w-12, lineBreak:false});
      doc.text('9982',                c2x+2, y+6, {width:c2w-4, align:'center', lineBreak:false});
      doc.text(fmtAmt(matterSub || sub), c3x+4, y+6, {width:c3w-8, align:'right'});
      y += rowH2;
    }
    for (const it of customItems) {
      const rowH2 = rH;
      tblRect(y, rowH2);
      doc.font('Helvetica').fontSize(9.5).fillColor('#000');
      doc.text(it.description || 'Other charges', c1x+6, y+6, {width:c1w-12, lineBreak:false});
      doc.text('9982',                              c2x+2, y+6, {width:c2w-4, align:'center', lineBreak:false});
      doc.text(fmtAmt(it.amount),                  c3x+4, y+6, {width:c3w-8, align:'right'});
      y += rowH2;
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rowH2 = rH;
      tblRect(y, rowH2);
      doc.font('Helvetica').fontSize(9.5).fillColor('#000');
      doc.text(it.description||'', c1x+6, y+6, {width:c1w-12, lineBreak:false});
      doc.text('9982',              c2x+2, y+6, {width:c2w-4, align:'center', lineBreak:false});
      doc.text(fmtAmt(it.amount), c3x+4, y+6, {width:c3w-8, align:'right'});
      y += rowH2;
    }
  }
  y += 4;

  // ── Summary section ─────────────────────────────────────────────────────────
  // 4 columns: Label | Rate | GST Amount | Service Amount
  const sumLblX  = L;
  const sumRateX = L + 295;
  const sumGSTX  = L + 365;
  const sumAmtX  = L + 450;
  const sumLblW  = 295;
  const sumRateW = 70;
  const sumGSTW  = 85;
  const sumSvcW  = R - sumAmtX; // ~100

  function drawSumDiv(ty, th) {
    doc.moveTo(sumRateX, ty).lineTo(sumRateX, ty+th).lineWidth(0.3).strokeColor('#ccc').stroke();
    doc.moveTo(sumGSTX,  ty).lineTo(sumGSTX,  ty+th).lineWidth(0.3).strokeColor('#aaa').stroke();
    doc.moveTo(sumAmtX,  ty).lineTo(sumAmtX,  ty+th).lineWidth(0.3).strokeColor('#aaa').stroke();
  }

  function svcRow(label, amt, bold, fillCol) {
    const rh = 20;
    if (fillCol) doc.rect(L, y, W, rh).fillAndStroke(fillCol, '#aaa');
    else         doc.rect(L, y, W, rh).stroke('#aaa');
    drawSumDiv(y, rh);
    const ff = bold ? 'Helvetica-Bold' : 'Helvetica';
    const fc = (fillCol && fillCol !== '#fff' && fillCol !== '#f5f7fa') ? '#fff' : '#000';
    doc.font(ff).fontSize(9.5).fillColor(fc)
       .text(label, sumLblX+6, y+5, {width: sumLblW+sumRateW+sumGSTW-10, align:'left', lineBreak:false});
    if (amt != null)
      doc.font(ff).fontSize(9.5).fillColor(fc)
         .text(String(amt), sumAmtX+4, y+5, {width: sumSvcW-6, align:'right'});
    doc.fillColor('#000'); y += rh;
  }

  function gstRow(taxName, rate, gstAmt) {
    const rh = 20;
    doc.rect(L, y, W, rh).stroke('#aaa');
    drawSumDiv(y, rh);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
       .text(taxName||'', sumLblX+6, y+5, {width: sumLblW-8, align:'left', lineBreak:false});
    if (rate != null)
      doc.font('Helvetica').fontSize(9.5)
         .text(String(rate), sumRateX+2, y+5, {width: sumRateW-4, align:'center', lineBreak:false});
    if (gstAmt != null)
      doc.font('Helvetica').fontSize(9.5)
         .text(String(gstAmt), sumGSTX+4, y+5, {width: sumGSTW-6, align:'right'});
    doc.fillColor('#000'); y += rh;
  }

  function totalGSTRow(label, gstAmt) {
    const rh = 20;
    doc.rect(L, y, W, rh).fillAndStroke('#e8ecf0', '#aaa');
    drawSumDiv(y, rh);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
       .text(label, sumLblX+6, y+5, {width: sumLblW+sumRateW-8, align:'left', lineBreak:false});
    if (gstAmt != null)
      doc.font('Helvetica-Bold').fontSize(9.5)
         .text(String(gstAmt), sumGSTX+4, y+5, {width: sumGSTW-6, align:'right'});
    doc.fillColor('#000'); y += rh;
  }

  function rcRow() {
    const rh = 18;
    doc.rect(L, y, W, rh).stroke('#aaa');
    drawSumDiv(y, rh);
    doc.font('Helvetica').fontSize(9).fillColor('#555')
       .text('Reverse Charge applicable', sumLblX+6, y+4, {width: sumLblW-8, lineBreak:false});
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
       .text(reverseCharge ? 'YES' : 'NO', sumRateX+2, y+4, {width: sumRateW-4, align:'center', lineBreak:false});
    doc.fillColor('#000'); y += rh;
  }

  function fmtRate(r) { return r%1===0 ? r.toFixed(0)+'%' : r.toFixed(1)+'%'; }

  if (isINR) {
    if (hasDiscount) {
      // Show the pre-discount subtotal, the discount line itself (with type
      // and optional note), then the post-discount taxable base.
      svcRow('Gross Value of Services',                                        fmtAmt(sub),    false);
      const discLabel = 'Less: Discount' +
        (discType === 'percent' ? ` (${Number(inv.discount_amount && (inv.discount_amount * 100 / (sub || 1)) || 0).toFixed(2)}% on ${fmtAmt(sub)})` : '') +
        (discNote ? ` — ${discNote}` : '');
      svcRow(discLabel, '(' + fmtAmt(discAmt) + ')', false);
      svcRow('Net Value of Services before tax',                               fmtAmt(netSub), true);
    } else {
      svcRow('Value of Services before tax', fmtAmt(sub), true);
    }
    rcRow();
    // GST sub-header
    const hRh = 16;
    doc.rect(L, y, W, hRh).fillAndStroke('#e8ecf0', '#aaa');
    drawSumDiv(y, hRh);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555');
    doc.text('Tax Component', sumLblX+6,  y+4, {width:sumLblW-8,   lineBreak:false});
    doc.text('Rate',          sumRateX+2, y+4, {width:sumRateW-4,  align:'center', lineBreak:false});
    doc.text('Amount ('+currency+')', sumGSTX+4, y+4, {width:sumGSTW-6, align:'right', lineBreak:false});
    doc.fillColor('#000'); y += hRh;

    gstRow('Add: CGST', fmtRate(cgstRate), cgstAmt>0 ? fmtAmt(cgstAmt) : '-');
    gstRow('Add: SGST', fmtRate(sgstRate), sgstAmt>0 ? fmtAmt(sgstAmt) : '-');
    gstRow('Add: IGST', fmtRate(igstRate), igstAmt>0 ? fmtAmt(igstAmt) : '-');
    totalGSTRow(
      reverseCharge
        ? 'Total GST payable on Reverse Charge (See Note)'
        : 'Total GST (collected by firm)',
      fmtAmt(totTax)
    );
    // Reverse charge ON  → firm collects only the (post-discount) service fee.
    // Reverse charge OFF → firm collects fee + GST → grand total = netSub + totTax.
    const grandINR = reverseCharge ? netSub : (netSub + totTax);
    svcRow(
      reverseCharge ? 'Total Value of Services after tax' : 'Total Amount Payable',
      fmtAmt(grandINR),
      true, '#1c3d5a'
    );

    // ── TDS deduction block (only for INR + when applicable) ─────────
    // Shows client the TDS they will deduct + the net amount they remit.
    const tdsApp     = !!Number(inv.tds_applicable);
    const tdsRate    = Number(inv.tds_rate || 0);
    const tdsAmt     = Number(inv.tds_amount || 0);
    const tdsSection = inv.tds_section || '194J';
    const netReceiv  = Number(inv.net_receivable || grandINR);
    if (tdsApp && tdsAmt > 0) {
      // Less: TDS row (light red tint for visibility)
      svcRow(
        `Less: TDS @ ${tdsRate}% u/s ${tdsSection} of Income Tax Act`,
        '(' + fmtAmt(tdsAmt) + ')',
        false,
        '#fef2f2'
      );
      // Net Amount Receivable row (highlighted green — what client actually pays)
      svcRow(
        'Net Amount Receivable (after TDS deduction)',
        fmtAmt(netReceiv),
        true,
        '#0f6b30'
      );
    }
  } else {
    if (hasDiscount) {
      svcRow('Gross Fees for Legal Services for the month of '+periodLabel(inv.period_from), fmtAmt(sub), false);
      svcRow('Less: Discount' + (discNote ? ` — ${discNote}` : ''), '(' + fmtAmt(discAmt) + ')', false);
      svcRow('Total Fees for Legal Services',                                                fmtAmt(netSub), true);
    } else {
      svcRow('Total Fees for Legal Services for the month of '+periodLabel(inv.period_from), fmtAmt(sub), true);
    }
    const expH = 22;
    doc.rect(L, y, W, expH).stroke('#aaa');
    doc.font('Helvetica').fontSize(9)
       .text('Supply meant for export on Letter of Undertaking without payment of integrated tax',
             L+6, y+5, {width:W-12}); y += expH;
    svcRow('Total Amount (' + currency + ')', currency + ' ' + fmtAmt(tot), true, '#1c3d5a');
  }
  y += 16;

  // ── Amount in words ───────────────────────────────────────────────────────
  doc.rect(L, y, W, 22).fillAndStroke('#f9f9f9', '#ccc');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
     .text('Amount in words: ', L+6, y+6, {lineBreak:false});
  doc.font('Helvetica').fontSize(9).fillColor('#000')
     .text(amountInWords(tot, currency), {width: W-130, lineBreak: false});
  y += 28;

  // ── Bank Details ──────────────────────────────────────────────────────────
  // Advance past the text height (10pt font ~ 13pt line) BEFORE drawing the
  // underline; the earlier `y += 4` placed the line through the middle of the
  // heading and made it look like a strikethrough.
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1c3d5a').text('Bank Details', L, y); y += 13;
  doc.moveTo(L, y).lineTo(L+90, y).lineWidth(0.8).strokeColor('#1c3d5a').stroke(); y += 8;

  const bankRows=[
    ['Bank Name:',      'HDFC Bank'],
    ['Account Name:',   'AP & Partners, Advocates'],
    ['Account No.:',    '50200044761396'],
    ['IFSC Code:',      'HDFC0000011'],
    ['SWIFT Code:',     'HDFCINBB']
  ];
  for (const [lb, vl] of bankRows) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555')
       .text(lb, L, y, {lineBreak:false, width:120});
    doc.font('Helvetica').fontSize(9.5).fillColor('#000')
       .text(vl, L+120, y);
    y += 14;
  }
  y += 8;

  // ── GST Note ──────────────────────────────────────────────────────────────
  if (isINR) {
    if (reverseCharge) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333')
         .text('Note — GST (CGST / SGST / IGST):', L, y); y += 12;
      doc.font('Helvetica').fontSize(8.5).fillColor('#555')
         .text('The Government has notified that the entire GST on legal services supplied by an advocate to a business entity shall be paid under Reverse Charge Mechanism by the recipient. Please pay this tax accordingly.',
               L, y, {width: W});
    } else {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333')
         .text('Note — GST:', L, y); y += 12;
      doc.font('Helvetica').fontSize(8.5).fillColor('#555')
         .text('GST is collected by the firm and will be deposited with the Government as per applicable rules. The Total Amount Payable above is inclusive of all applicable taxes.',
               L, y, {width: W});
    }
    y = doc.y + 10;
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  const sigY = Math.max(y, 715);
  doc.moveTo(350, sigY).lineTo(R, sigY).lineWidth(0.5).strokeColor('#000').stroke();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
     .text(isINR ? 'AP & PARTNERS, ADVOCATES' : 'AP & Partners, Advocates',
           350, sigY+5, {width:R-350, align:'center'});
  doc.font('Helvetica').fontSize(9)
     .text('Please pay within 30 days of receipt of this invoice.', L, sigY+5, {width:290});
}

// ── Annexure page ────────────────────────────────────────────────────────────
// `items` is the optional list of invoice_items for THIS matter. When provided,
// rates are taken from there first (so any manual edits made in the draft
// editor reflect on the annexure) before falling back to rate_cards / user
// default_rate. Without this, the annexure silently re-derives rates from the
// users table and ignores admin edits to the saved invoice.
function annexurePage(doc, inv, matter, entries, annexNo, totalAnnex, currency, isDraft, items) {
  // Build (user_id → rate) map from the saved invoice items for this matter.
  // First matching item per user wins. We try TWO ways to resolve user_id from
  // each item: (a) the item's own user_id column (preferred), and (b) parsing
  // the lawyer's full name out of the description "...• Lawyer Name @ ..." —
  // useful for older items that got saved with user_id=NULL by the now-fixed
  // Edit Draft bug. Without (b) the annexure would fall back to user.default_rate
  // and silently show 0 fees on those orphan invoices.
  const itemRateByUser = new Map();
  // Quick name → user_id lookup from the entries we already have.
  const userByName = new Map();
  for (const e of entries) {
    if (e.lawyer_name) userByName.set(String(e.lawyer_name).trim().toLowerCase(), e.user_id);
  }
  for (const it of (items || [])) {
    let uid = it && it.user_id ? it.user_id : null;
    if (!uid && it && it.description) {
      const m = it.description.match(/[•·]\s*([^@]+?)\s*@/);
      if (m) uid = userByName.get(m[1].trim().toLowerCase()) || null;
    }
    if (uid && !itemRateByUser.has(uid)) {
      itemRateByUser.set(uid, Number(it.rate || 0));
    }
  }
  // Helper: prefer the saved invoice_item rate; only fall back when none exists.
  function effectiveRateFor(entry) {
    if (entry.rate_override != null) return entry.rate_override;
    if (itemRateByUser.has(entry.user_id)) return itemRateByUser.get(entry.user_id);
    return rateForUser(matter.id, entry.user_id, entry.entry_date);
  }

  let y = pageHeader(doc, inv, 'Annexure '+annexNo+' of '+totalAnnex+'  |  '+inv.invoice_no, isDraft);

  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text('Invoice: '+inv.invoice_no+'   Date: '+fmtDate(inv.invoice_date)+'   Client: '+(inv.client_name||''), L, y, {width:W}); y += 14;

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1c3d5a')
     .text((matter.file_no ? matter.file_no+' — ' : '')+matter.title, L, y, {width:W, align:'center'}); y += 20;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.8).strokeColor('#1c3d5a').stroke(); y += 12;

  // Lawyer rate table
  const lawyerMap = new Map();
  for (const e of entries) {
    if (!lawyerMap.has(e.user_id)) {
      lawyerMap.set(e.user_id, {
        name: e.lawyer_name||'', code: e.lawyer_code||initials(e.lawyer_name||''), rate: effectiveRateFor(e)
      });
    }
  }
  const lawyers = Array.from(lawyerMap.values());

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
     .text('Lawyer codes and rates:', L, y); y += 13;

  const ltCols = [
    {label:'Lawyer Name', w:210, align:'left'},
    {label:'Lawyer Code', w:110, align:'center'},
    {label:'Fees ('+currency+'/hr)', w:130, align:'center'}
  ];
  const ltTW = ltCols.reduce((s,c)=>s+c.w, 0), ltH = 20;

  doc.rect(L, y, ltTW, ltH).fillAndStroke('#1c3d5a', '#000');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff');
  let cx = L;
  for (const c of ltCols) { doc.text(c.label, cx+4, y+5, {width:c.w-8, align:c.align, lineBreak:false}); cx += c.w; }
  doc.fillColor('#000'); y += ltH;

  for (const lw of lawyers) {
    doc.rect(L, y, ltTW, ltH).stroke('#aaa');
    doc.font('Helvetica').fontSize(9.5).fillColor('#000');
    cx = L;
    const vals = [lw.name, lw.code, fmtAmt(lw.rate)];
    for (let i = 0; i < ltCols.length; i++) {
      doc.text(vals[i], cx+4, y+5, {width:ltCols[i].w-8, align:ltCols[i].align, lineBreak:false}); cx += ltCols[i].w;
    }
    y += ltH;
  }
  y += 14;

  // Detail table
  // S.No(30) | Date(72) | LawyerCode(58) | Narrations(205) | Hours(55) | Fees(85)
  const feeW = W - 30 - 72 - 58 - 205 - 55;
  const dCols = [
    {label:'S.No',                        w:30,   align:'center'},
    {label:'Date',                        w:72,   align:'center'},
    {label:'Lawyer\nCode',                w:58,   align:'center'},
    {label:'Narrations',                  w:205,  align:'left'},
    {label:'Hours',                       w:55,   align:'center'},
    {label:'Prof. Fees\n('+currency+')',  w:feeW, align:'right'}
  ];
  const dtH = 26;

  function detailHeader(yy) {
    doc.rect(L, yy, W, dtH).fillAndStroke('#1c3d5a', '#000');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
    let x2 = L;
    for (const c of dCols) {
      doc.text(c.label, x2+2, yy+4, {width:c.w-4, align:c.align, lineBreak:true});
      x2 += c.w;
    }
    doc.fillColor('#000'); return yy + dtH;
  }
  y = detailHeader(y);

  let totHrs = 0, totFees = 0, sno = 0;
  const rowBg = ['#ffffff','#f5f7fa'];

  for (const e of entries) {
    sno++;
    const code = e.lawyer_code || initials(e.lawyer_name||'');
    const rate  = effectiveRateFor(e);
    const bill  = e.is_billable !== 0;
    const fee   = bill ? Math.round(e.hours * rate * 100) / 100 : 0;
    const narr  = e.description || e.activity_type || '';
    const narLines = Math.max(1, Math.ceil((narr.length * 5) / (dCols[3].w - 8)));
    const rh = Math.max(20, 10 + narLines * 12);

    doc.rect(L, y, W, rh).fillAndStroke(rowBg[sno%2], '#ddd');
    doc.fillColor('#000');
    const midY = y + (rh - 9) / 2;
    cx = L;
    doc.font('Helvetica').fontSize(8.5).text(String(sno), cx+2, midY, {width:dCols[0].w-4, align:'center', lineBreak:false}); cx += dCols[0].w;
    doc.text(fmtDateShort(e.entry_date), cx+2, midY, {width:dCols[1].w-4, align:'center', lineBreak:false}); cx += dCols[1].w;
    doc.font('Helvetica-Bold').fontSize(8.5).text(code, cx+2, midY, {width:dCols[2].w-4, align:'center', lineBreak:false}); cx += dCols[2].w;
    doc.font('Helvetica').fontSize(8.5).text(narr, cx+2, y+4, {width:dCols[3].w-4, lineBreak:true}); cx += dCols[3].w;
    doc.text(fmtHours(e.hours), cx+2, midY, {width:dCols[4].w-4, align:'center', lineBreak:false}); cx += dCols[4].w;
    if (bill) {
      doc.font('Helvetica').fontSize(8.5).text(fmtAmt(fee), cx+2, midY, {width:dCols[5].w-4, align:'right', lineBreak:false});
      totFees += fee;
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor('#c0392b')
         .text('Not charged', cx+2, midY, {width:dCols[5].w-4, align:'right', lineBreak:false});
      doc.fillColor('#000');
    }
    totHrs += e.hours; y += rh;

    if (y > 760) {
      doc.addPage();
      y = pageHeader(doc, inv, 'Annexure '+annexNo+' of '+totalAnnex+' (contd.)', isDraft);
      y = detailHeader(y);
    }
  }

  // Total row
  const trH = 22;
  doc.rect(L, y, W, trH).fillAndStroke('#e8ecf0', '#aaa');
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000');
  const lblSpan = dCols[0].w + dCols[1].w + dCols[2].w + dCols[3].w;
  doc.text('Total', L+2, y+6, {width:lblSpan-4, align:'right'});
  cx = L + lblSpan;
  doc.text(fmtHours(totHrs), cx+2, y+6, {width:dCols[4].w-4, align:'center', lineBreak:false}); cx += dCols[4].w;
  doc.text(fmtAmt(totFees), cx+2, y+6, {width:dCols[5].w-4, align:'right'}); y += trH + 8;

  const nb = entries.filter(e => !e.is_billable).length;
  if (nb > 0) {
    doc.font('Helvetica').fontSize(8).fillColor('#888')
       .text('* '+nb+' entr'+(nb>1?'ies':'y')+' marked "Not charged" excluded from fees.', L, y, {width:W});
  }
}

// ── Stream PDF ────────────────────────────────────────────────────────────────
function streamInvoicePDF(invoiceId, res) {
  const inv = db.prepare(`
    SELECT i.*,
           c.name AS client_name, c.gstin AS client_gstin, c.address AS client_address,
           c.email AS client_email, c.phone AS client_phone, c.contact_person,
           c.state_name AS client_state_name,
           COALESCE(i.state_name, c.state_name) AS state_name,
           COALESCE(i.state_code, c.state_code) AS state_code,
           c.kind_attn, c.ref_text
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?
  `).get(invoiceId);
  if (!inv) { res.status(404).json({error:'Invoice not found'}); return; }

  const items = db.prepare(`
    SELECT ii.*, m.title AS matter_title, m.file_no
    FROM invoice_items ii LEFT JOIN matters m ON m.id=ii.matter_id
    WHERE ii.invoice_id=? ORDER BY ii.id
  `).all(invoiceId);

  const allEntries = db.prepare(`
    SELECT t.*, u.full_name AS lawyer_name, u.lawyer_code,
           m.title AS matter_title, m.file_no
    FROM timesheet_entries t
    JOIN users u ON u.id=t.user_id
    JOIN matters m ON m.id=t.matter_id
    WHERE t.invoice_id=? ORDER BY t.matter_id, t.entry_date, t.id
  `).all(invoiceId);

  const byMatter = new Map();
  for (const e of allEntries) {
    if (!byMatter.has(e.matter_id)) {
      byMatter.set(e.matter_id, {matter:{id:e.matter_id,title:e.matter_title,file_no:e.file_no}, entries:[]});
    }
    byMatter.get(e.matter_id).entries.push(e);
  }

  const currency = inv.currency || 'INR';
  const isDraft  = inv.status === 'draft';
  const doc = new PDFDocument({size:'A4', margin:0, bufferPages:true});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="'+(isDraft?'DRAFT-':'')+inv.invoice_no.replace(/[\\/]/g,'-')+'.pdf"');
  doc.pipe(res);

  mainPage(doc, inv, items, currency, isDraft);

  const groups = Array.from(byMatter.values());
  for (let i = 0; i < groups.length; i++) {
    const {matter, entries} = groups[i];
    doc.addPage();
    // Filter invoice_items to just this matter so annexure picks up the
    // (possibly admin-edited) rate per lawyer instead of re-deriving from user table.
    const matterItems = items.filter(it => it.matter_id === matter.id);
    annexurePage(doc, inv, matter, entries, i+1, groups.length, currency, isDraft, matterItems);
  }
  doc.end();
}

// ── Buffer version (for email) ────────────────────────────────────────────────
async function streamInvoicePDFToBuffer(invoiceId) {
  const inv = db.prepare(`
    SELECT i.*,
           c.name AS client_name, c.gstin AS client_gstin,
           c.address AS client_address, c.contact_person,
           c.state_name AS client_state_name,
           COALESCE(i.state_name, c.state_name) AS state_name,
           COALESCE(i.state_code, c.state_code) AS state_code,
           c.kind_attn, c.ref_text,
           c.email AS client_email, c.phone AS client_phone
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?
  `).get(invoiceId);
  if (!inv) throw new Error('Invoice not found: ' + invoiceId);

  const items = db.prepare(`
    SELECT ii.*, m.title AS matter_title, m.file_no
    FROM invoice_items ii LEFT JOIN matters m ON m.id=ii.matter_id
    WHERE ii.invoice_id=? ORDER BY ii.id
  `).all(invoiceId);

  const allEntries = db.prepare(`
    SELECT t.*, u.full_name AS lawyer_name, u.lawyer_code,
           m.title AS matter_title, m.file_no
    FROM timesheet_entries t
    JOIN users u ON u.id=t.user_id
    JOIN matters m ON m.id=t.matter_id
    WHERE t.invoice_id=? ORDER BY t.matter_id, t.entry_date, t.id
  `).all(invoiceId);

  const byMatter = new Map();
  for (const e of allEntries) {
    if (!byMatter.has(e.matter_id)) {
      byMatter.set(e.matter_id, {matter:{id:e.matter_id,title:e.matter_title,file_no:e.file_no}, entries:[]});
    }
    byMatter.get(e.matter_id).entries.push(e);
  }

  const currency = inv.currency || 'INR';
  const isDraft  = inv.status === 'draft';
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    mainPage(doc, inv, items, currency, isDraft);
    const groups = Array.from(byMatter.values());
    for (let i = 0; i < groups.length; i++) {
      const {matter, entries} = groups[i];
      doc.addPage();
      const matterItems = items.filter(it => it.matter_id === matter.id);
      annexurePage(doc, inv, matter, entries, i+1, groups.length, currency, isDraft, matterItems);
    }
    doc.end();
  });
}

module.exports = { streamInvoicePDF, streamInvoicePDFToBuffer };
