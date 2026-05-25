/**
 * LEDES Export Engine
 * ===================
 *
 * Generates LEDES 1998B, 1998BI, and XML 2.1 formatted files from an invoice.
 * LEDES (Legal Electronic Data Exchange Standard) is the international format
 * required by corporate e-billing platforms like Tymetrix 360, LegalTracker,
 * Passport, CounselLink, Brightflag, etc.
 *
 * See https://ledes.org for the canonical specification.
 *
 * Usage:
 *   const { generateLEDES1998BI, generateLEDESXML21 } = require('./utils/ledes-export');
 *   const content = generateLEDES1998BI(invoiceId);
 */

const { db } = require('./db');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a date string as YYYYMMDD (LEDES requirement). Handles both
 *  'YYYY-MM-DD' and ISO datetime inputs. */
function fmtDateYYYYMMDD(input) {
  if (!input) return '';
  const s = String(input).slice(0, 10);  // YYYY-MM-DD prefix
  return s.replace(/-/g, '');
}

/** Escape any pipe characters in a string (LEDES uses | as field separator).
 *  ALSO forces 7-bit ASCII via toAscii() — LEDES 1998B/BI parsers reject any
 *  byte > 127 (₹, ©, em-dash, smart quotes, etc.). This is the single
 *  choke-point for every text field, so we sanitise centrally here. */
function escapePipes(s) {
  if (s == null) return '';
  // toAscii is defined later in the file — function declarations are hoisted,
  // so it's safe to reference it here.
  const ascii = toAscii(String(s));
  return ascii.replace(/[|\r\n]/g, ' ').trim();
}

/** Clean a description for LEDES output — strips internal-only annotations
 *  that look unprofessional to corporate clients. The internal description
 *  format used in invoice_items.description is:
 *      "{file_no} — {matter_title} • {lawyer_name} @ {rate}/hr"
 *  But LEDES has SEPARATE fields for matter_id, timekeeper, and rate, so
 *  the description should only contain the actual WORK description, not
 *  these annotations which would be duplicated. */
/** Aggressively convert any string to pure 7-bit ASCII. LEDES 1998B/BI are
 *  strict ASCII formats — any byte > 127 (₹, ©, em-dash, smart quotes,
 *  accented letters, non-breaking space, etc.) makes validators like
 *  ledesshield.com reject the file. We map the common offenders to ASCII
 *  equivalents and strip the rest. */
function toAscii(s) {
  if (s == null) return '';
  let out = String(s);
  // Normalise diacritics: "café" -> "cafe", "naïve" -> "naive"
  try { out = out.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch(_) {}
  // Currency symbols → ISO codes (most common offender for Indian firms is ₹)
  out = out
    .replace(/[₹]/g, 'INR ')
    .replace(/[$]/g, 'USD ')   // only when used as a symbol; bare $ stays valid ASCII anyway
    .replace(/[€]/g, 'EUR ')
    .replace(/[£]/g, 'GBP ')
    .replace(/[¥]/g, 'JPY ');
  // Smart punctuation → plain ASCII
  out = out
    .replace(/[‘’‚‛′]/g, "'")   // ' ' ‚ ‛ ′
    .replace(/[“”„‟″]/g, '"')   // " " „ ‟ ″
    .replace(/[–—―−]/g, '-')         // – — ― −
    .replace(/[•·▪●]/g, ',')         // • · ▪ ●
    .replace(/[…]/g, '...')                         // …
    .replace(/[  -​  ]/g, ' ')  // non-breaking + various spaces
    .replace(/[©®™]/g, '')                // © ® ™
    .replace(/[°]/g, ' deg ')                       // °
    .replace(/[±]/g, '+/-')                         // ±
    .replace(/[¼]/g, '1/4').replace(/[½]/g, '1/2').replace(/[¾]/g, '3/4');
  // Drop anything still outside printable 7-bit ASCII (0x20–0x7E) + tab/newline.
  out = out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return out;
}

function cleanDescriptionForLEDES(desc) {
  if (!desc) return '';
  let s = String(desc);
  // Remove leading file_no pattern: "APP/002/2026-27 — " or "AP/123 - "
  s = s.replace(/^[A-Z]{2,5}\/[0-9\/-]+\s*[—–-]\s*/i, '');
  // Remove "@ rate/hr" annotations and everything after
  s = s.replace(/\s*[•·]\s*[A-Za-z .]+\s*@\s*[0-9,.]+\s*\/?\s*hr.*$/i, '');
  s = s.replace(/\s*@\s*[0-9,.]+\s*\/?\s*hr.*$/i, '');
  // Replace unicode em/en dash with regular hyphen (some platforms choke)
  s = s.replace(/[—–]/g, '-');
  // Replace bullets with comma
  s = s.replace(/[•·]/g, ',');
  // Collapse multiple spaces and trim
  s = s.replace(/\s+/g, ' ').trim();
  // Common typo fix
  s = s.replace(/\bBanglore\b/g, 'Bangalore');
  // Final pass: force pure ASCII. LEDES validators reject any byte > 127.
  s = toAscii(s);
  // If we stripped everything, fall back to a clean phrase
  if (!s || s.length < 3) s = 'Professional services rendered';
  return s;
}

/** Generate professional description for a fee line.
 *  Priority order:
 *    1. Concatenated narratives from underlying timesheet entries (preferred --
 *       this is the lawyer's actual work description)
 *    2. Cleaned invoice_items.description (after stripping internal formatting)
 *    3. Synthesised description from matter + activity_type
 *
 *  Each narrative is sentence-cased and joined with semicolons so the LEDES
 *  output reads like a polished invoice line, not internal shorthand. */
function professionalFeeDescription(item) {
  // (1) Use timesheet narratives if available
  if (item.narratives && item.narratives.length > 0) {
    const clean = item.narratives
      .map(n => cleanDescriptionForLEDES(n))
      .filter(n => n && n !== 'Professional services rendered')
      .map(n => n.charAt(0).toUpperCase() + n.slice(1));
    if (clean.length) {
      // Dedupe consecutive identical narratives
      const dedup = [];
      for (const n of clean) {
        if (dedup.length === 0 || dedup[dedup.length - 1] !== n) dedup.push(n);
      }
      return dedup.join('; ');
    }
  }
  // (2) Fall back to cleaned invoice_items.description
  const cleaned = cleanDescriptionForLEDES(item.description);
  if (cleaned && cleaned !== 'Professional services rendered') return cleaned;
  // (3) Synthesise from matter + activity_type
  const parts = [];
  if (item.matter_title) parts.push(item.matter_title);
  if (item.activity_type) {
    const map = {
      drafting: 'Drafting and preparation of documents',
      research: 'Legal research and analysis',
      court: 'Court attendance and representation',
      meeting: 'Client conference and consultation',
      call: 'Client consultation by telephone',
      review: 'Review and analysis of documents',
      other: 'Professional services'
    };
    parts.push(map[item.activity_type] || 'Professional services');
  }
  return parts.length ? parts.join(' - ') : 'Professional legal services';
}

/** Escape characters for XML. */
function xmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Detect if an invoice line item is a fee (lawyer hours) vs an expense.
 *  We treat as expense if there's no user_id (no lawyer) OR if description
 *  matches recognised expense keywords. */
function isExpenseLine(item) {
  if (!item.user_id) return true;
  const d = (item.description || '').toLowerCase();
  return /\b(travel|court fee|disbursement|reimbursement|courier|postage|filing fee)\b/.test(d);
}

/** Map an internal activity_type (drafting/court/research/etc.) plus per-client
 *  override to a UTBMS task_code + activity_code pair. Falls back to global
 *  defaults if no per-client mapping exists. */
function resolveUTBMS(activityType, clientId) {
  if (!activityType) return { task: 'L120', activity: 'A111' };
  // Per-client override first, then global default
  const row = db.prepare(`
    SELECT task_code, activity_code FROM activity_utbms_mapping
    WHERE activity_type = ?
      AND (client_id = ? OR client_id IS NULL)
    ORDER BY client_id DESC LIMIT 1
  `).get(activityType, clientId || 0);
  return {
    task: (row && row.task_code) || 'L120',
    activity: (row && row.activity_code) || 'A111'
  };
}

/** Map LEDES timekeeper classification — fall back to ASSOCIATE if not set. */
function tkClass(user) {
  return user && user.timekeeper_classification
    ? user.timekeeper_classification.toUpperCase()
    : 'ASSOCIATE';
}

/** Load all data needed to render LEDES for one invoice. */
function loadInvoiceForLEDES(invoiceId) {
  const inv = db.prepare(`
    SELECT i.*, c.name AS client_name, c.client_internal_id, c.gstin AS client_gstin
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    WHERE i.id = ?
  `).get(invoiceId);
  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);

  const items = db.prepare(`
    SELECT ii.*,
           u.full_name AS timekeeper_name,
           u.timekeeper_classification,
           u.lawyer_code,
           m.file_no, m.client_matter_id, m.title AS matter_title
    FROM invoice_items ii
    LEFT JOIN users u ON u.id = ii.user_id
    LEFT JOIN matters m ON m.id = ii.matter_id
    WHERE ii.invoice_id = ?
    ORDER BY ii.id
  `).all(invoiceId);

  // For each invoice_item, find the source timesheet entries to recover (a)
  // the most common activity_type for UTBMS mapping, (b) the latest work
  // date for LINE_ITEM_DATE (LEDES expects the actual work date, not the
  // invoice issue date), and (c) the lawyer's actual work narratives -- the
  // invoice_items.description is internal summary; LEDES needs the original.
  const itemsWithActivity = items.map(item => {
    let activityType = null;
    let lineItemDate = null;
    let narratives = [];
    if (item.user_id && item.matter_id) {
      const actRow = db.prepare(`
        SELECT activity_type, COUNT(*) AS c
        FROM timesheet_entries
        WHERE invoice_id = ? AND user_id = ? AND matter_id = ?
        GROUP BY activity_type
        ORDER BY c DESC LIMIT 1
      `).get(invoiceId, item.user_id, item.matter_id);
      activityType = actRow ? actRow.activity_type : null;

      const dateRow = db.prepare(`
        SELECT MAX(entry_date) AS d
        FROM timesheet_entries
        WHERE invoice_id = ? AND user_id = ? AND matter_id = ?
      `).get(invoiceId, item.user_id, item.matter_id);
      lineItemDate = dateRow ? dateRow.d : null;

      // Lawyer's actual narratives from timesheet_entries -- this is what
      // corporate e-billing platforms expect to see, NOT the internal summary.
      const narrRows = db.prepare(`
        SELECT description, entry_date, hours
        FROM timesheet_entries
        WHERE invoice_id = ? AND user_id = ? AND matter_id = ?
        ORDER BY entry_date
      `).all(invoiceId, item.user_id, item.matter_id);
      narratives = narrRows.map(r => r.description).filter(Boolean);
    }
    return {
      ...item,
      activity_type: activityType,
      line_item_date: lineItemDate,
      narratives
    };
  });

  return { inv, items: itemsWithActivity };
}

// ═════════════════════════════════════════════════════════════════════════
// LEDES 1998B — Original pipe-delimited format
// ═════════════════════════════════════════════════════════════════════════

const LEDES_1998B_HEADER =
  'INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID|LAW_FIRM_MATTER_ID|INVOICE_TOTAL|' +
  'BILLING_START_DATE|BILLING_END_DATE|INVOICE_DESCRIPTION|LINE_ITEM_NUMBER|' +
  'EXP/FEE/INV_ADJ_TYPE|LINE_ITEM_NUMBER_OF_UNITS|LINE_ITEM_ADJUSTMENT_AMOUNT|' +
  'LINE_ITEM_TOTAL|LINE_ITEM_DATE|LINE_ITEM_TASK_CODE|LINE_ITEM_EXPENSE_CODE|' +
  'LINE_ITEM_ACTIVITY_CODE|TIMEKEEPER_ID|LINE_ITEM_DESCRIPTION|LAW_FIRM_ID|' +
  'LINE_ITEM_UNIT_COST|TIMEKEEPER_NAME|TIMEKEEPER_CLASSIFICATION|CLIENT_MATTER_ID[]';

function generateLEDES1998B(invoiceId) {
  const { inv, items } = loadInvoiceForLEDES(invoiceId);
  const lawFirmId = process.env.LEDES_LAW_FIRM_ID || 'APPARTNERS';

  let output = 'LEDES1998B[]\n' + LEDES_1998B_HEADER + '\n';

  items.forEach((item, idx) => {
    const isExpense = isExpenseLine(item);
    const utbms = isExpense
      ? { task: 'L190', activity: '' }     // L190 = case admin (default for expenses)
      : resolveUTBMS(item.activity_type, inv.client_id);
    const cleanDesc = isExpense
      ? cleanDescriptionForLEDES(item.description)
      : professionalFeeDescription(item);
    const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';
    const lineDate = item.line_item_date || inv.period_to || inv.invoice_date;

    const fields = [
      fmtDateYYYYMMDD(inv.invoice_date),
      escapePipes(inv.invoice_no),
      escapePipes(inv.client_internal_id || inv.client_name),
      escapePipes(item.client_matter_id || item.file_no || ''),
      Number(inv.total).toFixed(2),
      fmtDateYYYYMMDD(inv.period_from),
      fmtDateYYYYMMDD(inv.period_to),
      escapePipes(inv.notes || `Legal services for the period ${fmtDateRange(inv.period_from, inv.period_to)}`),
      idx + 1,
      isExpense ? 'E' : 'F',
      Number(item.quantity).toFixed(2),
      0,
      Number(item.amount).toFixed(2),
      fmtDateYYYYMMDD(lineDate),
      utbms.task,
      expenseCode,
      utbms.activity,
      escapePipes(item.lawyer_code || (item.user_id ? `TK${item.user_id}` : '')),
      escapePipes(cleanDesc),
      lawFirmId,
      Number(item.rate).toFixed(2),
      escapePipes(item.timekeeper_name || ''),
      tkClass(item),
      escapePipes(item.client_matter_id || item.file_no || '')
    ];

    output += fields.join('|') + '[]\n';
  });

  return output;
}

/** Format a human-readable date range like "May 2026" or "1-12 May 2026" */
function fmtDateRange(from, to) {
  if (!from || !to) return '';
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear()) {
    return `${f.getUTCDate()}-${t.getUTCDate()} ${months[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
  }
  return `${f.getUTCDate()} ${months[f.getUTCMonth()]} ${f.getUTCFullYear()} - ${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

// ═════════════════════════════════════════════════════════════════════════
// LEDES 1998BI — International format (with currency)
// ═════════════════════════════════════════════════════════════════════════

// Official LEDES.org 1998BI V2 header (per https://ledes.org).
const LEDES_1998BI_HEADER_OFFICIAL =
  'INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID|LAW_FIRM_MATTER_ID|INVOICE_TOTAL|' +
  'BILLING_START_DATE|BILLING_END_DATE|INVOICE_DESCRIPTION|LINE_ITEM_NUMBER|' +
  'EXP/FEE/INV_ADJ_TYPE|LINE_ITEM_NUMBER_OF_UNITS|LINE_ITEM_ADJUSTMENT_AMOUNT|' +
  'LINE_ITEM_TOTAL|LINE_ITEM_DATE|LINE_ITEM_TASK_CODE|LINE_ITEM_EXPENSE_CODE|' +
  'LINE_ITEM_ACTIVITY_CODE|TIMEKEEPER_ID|LINE_ITEM_DESCRIPTION|LAW_FIRM_ID|' +
  'LINE_ITEM_UNIT_COST|TIMEKEEPER_NAME|TIMEKEEPER_CLASSIFICATION|CLIENT_MATTER_ID|' +
  'INVOICE_CURRENCY|TIMEKEEPER_LAST_NAME|TIMEKEEPER_FIRST_NAME|ACCOUNT_TYPE[]';

// Tymetrix-style short header (used by some validators like ledesshield.com).
// Same data, just abbreviated field names — useful if the client's platform
// rejects the full LEDES.org names.
const LEDES_1998BI_HEADER_SHORT =
  'INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID|LAW_FIRM_MATTER_ID|INVOICE_TOTAL|' +
  'BILLING_START_DATE|BILLING_END_DATE|INVOICE_DESCRIPTION|LINE_ITEM_NUMBER|' +
  'EXP/FEE/INV_ADJ_TYPE|LINE_ITEM_UNITS|LINE_ITEM_ADJUSTMENT_AMOUNT|' +
  'LINE_ITEM_TOTAL|LINE_ITEM_DATE|LINE_ITEM_TASK_CODE|LINE_ITEM_EXPENSE_CODE|' +
  'LINE_ITEM_ACTIVITY_CODE|TIMEKEEPER_ID|LINE_ITEM_DESCRIPTION|LAW_FIRM_ID|' +
  'LINE_ITEM_UNIT_COST|TIMEKEEPER_NAME|TIMEKEEPER_CLASSIFICATION|CLIENT_MATTER_ID|' +
  'INVOICE_CURRENCY|TIMEKEEPER_LAST_NAME|TIMEKEEPER_FIRST_NAME|ACCOUNT_TYPE[]';

// DEFAULT to the SHORT (Tymetrix-compatible) header since most real-world
// e-billing platforms (Tymetrix 360, LegalTracker, ledesshield, etc.) use this
// abbreviated naming. Pass options.style='official' to get the pure LEDES.org
// spec naming when a strict-compliant platform requires it.
const LEDES_1998BI_HEADER = LEDES_1998BI_HEADER_SHORT;

function generateLEDES1998BI(invoiceId, options) {
  options = options || {};
  const useOfficialHeader = options.style === 'official';
  const header = useOfficialHeader ? LEDES_1998BI_HEADER_OFFICIAL : LEDES_1998BI_HEADER_SHORT;
  const { inv, items } = loadInvoiceForLEDES(invoiceId);
  const lawFirmId = process.env.LEDES_LAW_FIRM_ID || 'APPARTNERS';
  const currency = (inv.currency || 'INR').toUpperCase();

  let output = 'LEDES1998BI V2[]\n' + header + '\n';

  items.forEach((item, idx) => {
    const isExpense = isExpenseLine(item);
    const utbms = isExpense
      ? { task: 'L190', activity: '' }
      : resolveUTBMS(item.activity_type, inv.client_id);
    const cleanDesc = isExpense
      ? cleanDescriptionForLEDES(item.description)
      : professionalFeeDescription(item);
    const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';
    const nameParts = (item.timekeeper_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';
    const lineDate = item.line_item_date || inv.period_to || inv.invoice_date;

    const fields = [
      fmtDateYYYYMMDD(inv.invoice_date),
      escapePipes(inv.invoice_no),
      escapePipes(inv.client_internal_id || inv.client_name),
      escapePipes(item.client_matter_id || item.file_no || ''),
      Number(inv.total).toFixed(2),
      fmtDateYYYYMMDD(inv.period_from),
      fmtDateYYYYMMDD(inv.period_to),
      escapePipes(inv.notes || `Legal services for the period ${fmtDateRange(inv.period_from, inv.period_to)}`),
      idx + 1,
      isExpense ? 'E' : 'F',
      Number(item.quantity).toFixed(2),
      0,
      Number(item.amount).toFixed(2),
      fmtDateYYYYMMDD(lineDate),
      utbms.task,
      expenseCode,
      utbms.activity,
      escapePipes(item.lawyer_code || (item.user_id ? `TK${item.user_id}` : '')),
      escapePipes(cleanDesc),
      lawFirmId,
      Number(item.rate).toFixed(2),
      escapePipes(item.timekeeper_name || ''),
      tkClass(item),
      escapePipes(item.client_matter_id || item.file_no || ''),
      currency,
      escapePipes(lastName),
      escapePipes(firstName),
      isExpense ? 'IC' : 'CL'
    ];

    output += fields.join('|') + '[]\n';
  });

  return output;
}

// ═════════════════════════════════════════════════════════════════════════
// LEDES XML 2.1 — Modern XML format (preferred by Tymetrix, LegalTracker)
// ═════════════════════════════════════════════════════════════════════════

function generateLEDESXML21(invoiceId) {
  const { inv, items } = loadInvoiceForLEDES(invoiceId);
  const lawFirmId = process.env.LEDES_LAW_FIRM_ID || 'APPARTNERS';
  const lawFirmName = process.env.FIRM_NAME || 'AP & Partners';
  const currency = (inv.currency || 'INR').toUpperCase();

  const fees = items.filter(i => !isExpenseLine(i));
  const expenses = items.filter(i => isExpenseLine(i));
  const subtotal = items.reduce((s, i) => s + Number(i.amount), 0);
  const tax = Number(inv.tax_amount || 0);
  const discount = Number(inv.discount_amount || 0);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<LEDESBillingData version="2.1">\n';
  xml += '  <Firm>\n';
  xml += `    <ID>${xmlEscape(lawFirmId)}</ID>\n`;
  xml += `    <Name>${xmlEscape(lawFirmName)}</Name>\n`;
  xml += '  </Firm>\n';
  xml += '  <Invoice>\n';
  xml += `    <InvoiceNumber>${xmlEscape(inv.invoice_no)}</InvoiceNumber>\n`;
  xml += `    <InvoiceDate>${fmtDateYYYYMMDD(inv.invoice_date)}</InvoiceDate>\n`;
  xml += `    <BillingStartDate>${fmtDateYYYYMMDD(inv.period_from)}</BillingStartDate>\n`;
  xml += `    <BillingEndDate>${fmtDateYYYYMMDD(inv.period_to)}</BillingEndDate>\n`;
  xml += `    <InvoiceTotal>${Number(inv.total).toFixed(2)}</InvoiceTotal>\n`;
  xml += `    <Currency>${currency}</Currency>\n`;
  xml += `    <NetTotal>${(subtotal - discount).toFixed(2)}</NetTotal>\n`;
  if (tax > 0) {
    xml += `    <TaxTotal>${tax.toFixed(2)}</TaxTotal>\n`;
    xml += `    <TaxRate>${Number(inv.tax_rate || 0).toFixed(2)}</TaxRate>\n`;
  }
  if (discount > 0) {
    xml += `    <DiscountAmount>${discount.toFixed(2)}</DiscountAmount>\n`;
    xml += `    <DiscountDescription>${xmlEscape(inv.discount_note || 'Discount applied')}</DiscountDescription>\n`;
  }
  xml += `    <Description>${xmlEscape(inv.notes || 'Legal services')}</Description>\n`;

  xml += '    <Client>\n';
  xml += `      <ClientID>${xmlEscape(inv.client_internal_id || inv.client_name)}</ClientID>\n`;
  xml += `      <ClientName>${xmlEscape(inv.client_name)}</ClientName>\n`;
  xml += '    </Client>\n';

  // Group by matter
  const matterGroups = {};
  for (const item of items) {
    const key = item.client_matter_id || item.file_no || 'UNASSIGNED';
    if (!matterGroups[key]) {
      matterGroups[key] = {
        client_matter_id: item.client_matter_id,
        file_no: item.file_no,
        title: item.matter_title,
        items: []
      };
    }
    matterGroups[key].items.push(item);
  }

  for (const key of Object.keys(matterGroups)) {
    const g = matterGroups[key];
    xml += '    <Matter>\n';
    // Only emit non-empty IDs so the XML doesn't show ugly empty tags.
    // For expense-only invoices with no matter, use the invoice number as a
    // fallback reference so clients can still reconcile.
    const cmid = g.client_matter_id || g.file_no || inv.invoice_no;
    const lfmid = g.file_no || inv.invoice_no;
    xml += `      <ClientMatterID>${xmlEscape(cmid)}</ClientMatterID>\n`;
    xml += `      <LawFirmMatterID>${xmlEscape(lfmid)}</LawFirmMatterID>\n`;
    if (g.title) xml += `      <MatterName>${xmlEscape(g.title)}</MatterName>\n`;

    g.items.forEach((item, idx) => {
      const isExpense = isExpenseLine(item);
      const utbms = isExpense
        ? { task: 'L190', activity: '' }
        : resolveUTBMS(item.activity_type, inv.client_id);
      const cleanDesc = isExpense
        ? cleanDescriptionForLEDES(item.description)
        : professionalFeeDescription(item);
      const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';
      const lineDate = item.line_item_date || inv.period_to || inv.invoice_date;

      xml += '      <LineItem>\n';
      xml += `        <LineItemNumber>${idx + 1}</LineItemNumber>\n`;
      xml += `        <LineItemDate>${fmtDateYYYYMMDD(lineDate)}</LineItemDate>\n`;
      xml += `        <LineItemType>${isExpense ? 'E' : 'F'}</LineItemType>\n`;
      xml += `        <Units>${Number(item.quantity).toFixed(2)}</Units>\n`;
      xml += `        <Rate>${Number(item.rate).toFixed(2)}</Rate>\n`;
      xml += `        <LineItemTotal>${Number(item.amount).toFixed(2)}</LineItemTotal>\n`;
      if (utbms.task) xml += `        <TaskCode>${utbms.task}</TaskCode>\n`;
      if (utbms.activity) xml += `        <ActivityCode>${utbms.activity}</ActivityCode>\n`;
      if (expenseCode) xml += `        <ExpenseCode>${expenseCode}</ExpenseCode>\n`;
      xml += `        <Description>${xmlEscape(cleanDesc)}</Description>\n`;
      if (item.timekeeper_name) {
        xml += '        <Timekeeper>\n';
        xml += `          <TimekeeperID>${xmlEscape(item.lawyer_code || `TK${item.user_id}`)}</TimekeeperID>\n`;
        xml += `          <TimekeeperName>${xmlEscape(item.timekeeper_name)}</TimekeeperName>\n`;
        xml += `          <TimekeeperClassification>${tkClass(item)}</TimekeeperClassification>\n`;
        xml += '        </Timekeeper>\n';
      }
      xml += '      </LineItem>\n';
    });

    xml += '    </Matter>\n';
  }

  xml += '  </Invoice>\n';
  xml += '</LEDESBillingData>\n';
  return xml;
}

// ─── Expense code heuristic ──────────────────────────────────────────────────
// Maps free-text expense descriptions to UTBMS expense codes (E101-E124).
function deriveExpenseCode(description) {
  const d = (description || '').toLowerCase();
  // More specific patterns first (court fee before generic court, etc.)
  if (/cop(y|ies|ying)/.test(d))     return 'E101';
  if (/print/.test(d))               return 'E102';
  if (/fax|facsimile/.test(d))       return 'E104';
  if (/telephone|phone call/.test(d)) return 'E105';
  if (/online research|database|lexis|westlaw/.test(d)) return 'E106';
  if (/courier|messenger|delivery|fedex|dhl/.test(d)) return 'E107';
  if (/postage|stamp/.test(d))       return 'E108';
  // Travel: check specific keywords before generic "travel"
  if (/flight|airfare|airline|hotel|lodging/.test(d)) return 'E110';  // Out-of-town
  // City names suggest out-of-town travel
  if (/travel.*\b(mumbai|delhi|bangalore|banglore|chennai|kolkata|hyderabad|pune|ahmedabad|jaipur|kochi|goa)\b/.test(d)) return 'E110';
  if (/\b(mumbai|delhi|bangalore|banglore|chennai|kolkata|hyderabad|pune)\b.*travel/.test(d)) return 'E110';
  if (/local travel|cab|taxi|uber|ola|auto/.test(d)) return 'E109';
  if (/\btravel\b/.test(d))          return 'E110';  // generic travel = out-of-town default
  if (/meal|food|lunch|dinner|breakfast/.test(d)) return 'E111';
  if (/court fee/.test(d))           return 'E112';
  if (/subpoena/.test(d))            return 'E113';
  if (/witness/.test(d))             return 'E114';
  if (/deposition/.test(d))          return 'E115';
  if (/transcript/.test(d))          return 'E116';
  if (/exhibit/.test(d))             return 'E117';
  if (/expert/.test(d))              return 'E119';
  if (/private investigat/.test(d))  return 'E120';
  if (/arbitrat|mediat/.test(d))     return 'E121';
  if (/local counsel/.test(d))       return 'E122';
  if (/disbursement|reimbursement/.test(d)) return 'E124';
  return 'E124';  // Other
}

// ═════════════════════════════════════════════════════════════════════════
// VALIDATION — Pre-flight check before export
// ═════════════════════════════════════════════════════════════════════════
//
// Returns { ok: boolean, errors: [...], warnings: [...], summary: {...} }.
// Errors block the export (corporate platforms will reject). Warnings are
// non-blocking but should be reviewed.
//
// Categories of checks:
//   1. Invoice header (mandatory fields, valid amounts, currency)
//   2. Line items (mandatory fields per type, valid UTBMS codes)
//   3. Math (subtotal + tax = total, line items sum to subtotal)
//   4. Master data (client_internal_id, timekeeper classification)
//   5. Format hygiene (no pipes, no smart quotes, dates valid)

function validateLEDES(invoiceId, format) {
  const errors = [];
  const warnings = [];
  format = (format || '1998BI').toUpperCase();

  let inv, items;
  try {
    const data = loadInvoiceForLEDES(invoiceId);
    inv = data.inv;
    items = data.items;
  } catch (e) {
    return {
      ok: false,
      errors: [{ code: 'NOT_FOUND', msg: e.message }],
      warnings: [],
      summary: null
    };
  }

  // ── 1. Invoice Header Checks ──────────────────────────────────────────
  if (!inv.invoice_no)          errors.push({ code: 'MISSING_INVOICE_NO', msg: 'Invoice number is required' });
  if (!inv.invoice_date)        errors.push({ code: 'MISSING_INVOICE_DATE', msg: 'Invoice date is required' });
  if (!inv.period_from)         warnings.push({ code: 'NO_PERIOD_FROM', msg: 'Billing period start date is missing' });
  if (!inv.period_to)           warnings.push({ code: 'NO_PERIOD_TO', msg: 'Billing period end date is missing' });
  if (!inv.client_id)           errors.push({ code: 'MISSING_CLIENT', msg: 'Invoice has no client linked' });
  if (Number(inv.total) <= 0)   errors.push({ code: 'ZERO_TOTAL', msg: 'Invoice total is zero or negative' });

  if (!inv.client_internal_id) {
    warnings.push({
      code: 'NO_CLIENT_INTERNAL_ID',
      msg: `Client "${inv.client_name}" has no client_internal_id set. The client name is being used as fallback. Set it in Masters > Clients for cleaner LEDES output.`
    });
  }

  const currency = (inv.currency || 'INR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push({ code: 'INVALID_CURRENCY', msg: `Invalid currency code "${currency}". Must be a 3-letter ISO 4217 code (INR, USD, GBP, EUR).` });
  }

  // ── 2. Line Items Checks ─────────────────────────────────────────────
  if (!items.length) {
    errors.push({ code: 'NO_LINE_ITEMS', msg: 'Invoice has no line items' });
  }

  let subtotalActual = 0;
  let feeCount = 0, expenseCount = 0;
  let missingTKClass = 0, missingMatterId = 0;
  let unmappedActivities = new Set();

  items.forEach((item, idx) => {
    const lineRef = `Line ${idx + 1}`;
    const isExpense = isExpenseLine(item);
    if (isExpense) expenseCount++; else feeCount++;

    if (Number(item.quantity) <= 0) {
      errors.push({ code: 'ZERO_QUANTITY', msg: `${lineRef}: quantity is zero or negative` });
    }
    if (Number(item.amount) < 0) {
      errors.push({ code: 'NEGATIVE_AMOUNT', msg: `${lineRef}: amount is negative` });
    }
    subtotalActual += Number(item.amount);

    if (!isExpense) {
      // Fee lines need timekeeper info
      if (!item.user_id) {
        errors.push({ code: 'NO_TIMEKEEPER', msg: `${lineRef}: fee line has no lawyer/timekeeper linked` });
      }
      if (!item.timekeeper_classification) {
        missingTKClass++;
      }
      // Validate UTBMS code resolution
      const utbms = resolveUTBMS(item.activity_type, inv.client_id);
      if (!utbms.task || !utbms.activity) {
        unmappedActivities.add(item.activity_type || 'unknown');
      }
    } else {
      // Expense lines need expense code
      const expCode = deriveExpenseCode(item.description);
      if (expCode === 'E124') {
        warnings.push({
          code: 'GENERIC_EXPENSE_CODE',
          msg: `${lineRef}: expense "${item.description}" mapped to E124 (Other). Consider clarifying the description for better categorisation.`
        });
      }
    }

    // Matter ID coverage
    if (!item.client_matter_id && !item.file_no) {
      missingMatterId++;
    }

    // Description checks
    const desc = item.description || '';
    if (desc.length < 5) {
      warnings.push({ code: 'SHORT_DESCRIPTION', msg: `${lineRef}: description is very short (${desc.length} chars). Corporate platforms often reject lines with no narrative.` });
    }
    if (/[|]/.test(desc)) {
      errors.push({ code: 'PIPE_IN_DESCRIPTION', msg: `${lineRef}: description contains "|" which conflicts with LEDES delimiter` });
    }
  });

  if (missingTKClass > 0) {
    warnings.push({
      code: 'MISSING_TIMEKEEPER_CLASSIFICATION',
      msg: `${missingTKClass} fee line(s) have no timekeeper classification. Defaulting to ASSOCIATE. Set it in Masters > Users for each lawyer.`
    });
  }
  if (missingMatterId > 0) {
    warnings.push({
      code: 'MISSING_MATTER_ID',
      msg: `${missingMatterId} line(s) have no matter ID. Invoice number will be used as fallback. Set client_matter_id in Masters > Matters for proper matter tracking.`
    });
  }
  if (unmappedActivities.size > 0) {
    warnings.push({
      code: 'UNMAPPED_ACTIVITY',
      msg: `Activity types with no UTBMS mapping (using defaults): ${Array.from(unmappedActivities).join(', ')}. Configure in Masters > UTBMS Mappings.`
    });
  }

  // ── 3. Math Validation ────────────────────────────────────────────────
  const declaredTotal = Number(inv.total);
  const subtotalDeclared = Number(inv.subtotal || 0);
  const taxDeclared = Number(inv.tax_amount || 0);
  const discountDeclared = Number(inv.discount_amount || 0);

  if (Math.abs(subtotalActual - (subtotalDeclared || subtotalActual)) > 0.01) {
    warnings.push({
      code: 'SUBTOTAL_MISMATCH',
      msg: `Sum of line items (${subtotalActual.toFixed(2)}) does not match declared subtotal (${subtotalDeclared.toFixed(2)})`
    });
  }

  // The firm uses REVERSE-CHARGE billing for B2B services (Indian GST):
  //   - Subtotal = professional fee + expenses (what client pays the firm)
  //   - Tax = informational only (client self-assesses GST under RCM)
  //   - Total = Subtotal - Discount (tax NOT added)
  //
  // For LEDES, this is the correct behaviour — the firm only collects the
  // net amount, and tax/RCM is handled separately by the client's accounts
  // team. We detect this pattern and treat it as valid; only true math
  // errors (where total doesn't match either model) get flagged.
  const netExpected         = subtotalActual - discountDeclared;
  const grossExpected       = subtotalActual - discountDeclared + taxDeclared;
  const matchesNet          = Math.abs(declaredTotal - netExpected)   < 0.50;
  const matchesGross        = Math.abs(declaredTotal - grossExpected) < 0.50;
  const isReverseCharge     = matchesNet && taxDeclared > 0 && !matchesGross;

  if (isReverseCharge) {
    // Informational note (not really a warning) — but useful for foreign
    // clients who may not understand Indian RCM.
    warnings.push({
      code: 'REVERSE_CHARGE_BILLING',
      msg: `Invoice uses reverse-charge mechanism: subtotal ${currency} ${subtotalActual.toFixed(2)} is the total amount the firm collects. Tax of ${currency} ${taxDeclared.toFixed(2)} (informational) is paid by the client directly under RCM. LEDES InvoiceTotal will be set to ${currency} ${declaredTotal.toFixed(2)}.`
    });
  } else if (!matchesNet && !matchesGross) {
    // Real math error — neither model matches
    warnings.push({
      code: 'TOTAL_MATH_MISMATCH',
      msg: `Total math check failed: subtotal (${subtotalActual.toFixed(2)}) - discount (${discountDeclared.toFixed(2)}) [+ tax (${taxDeclared.toFixed(2)})] = ${netExpected.toFixed(2)} or ${grossExpected.toFixed(2)}, but invoice total is ${declaredTotal.toFixed(2)}. Neither net nor gross matches.`
    });
  }

  // ── 4. Foreign Client / Export-of-Services Tax Check ─────────────────
  // Per Section 2(6) of IGST Act, export of services to foreign clients in
  // foreign currency is ZERO-RATED — no GST applies. If the invoice is in
  // USD/EUR/GBP but has tax > 0, that's almost certainly an error.
  const foreignCurrencies = ['USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'JPY', 'AED', 'CHF'];
  const isForeignCurrency = foreignCurrencies.includes(currency);

  if (isForeignCurrency && taxDeclared > 0) {
    warnings.push({
      code: 'GST_ON_FOREIGN_INVOICE',
      msg: `Invoice in ${currency} (foreign currency) has GST of ${taxDeclared.toFixed(2)} applied. Under Indian GST law, export of services to clients outside India is ZERO-RATED. Verify whether this client is truly foreign or an Indian entity; if foreign, set tax_rate=0 and file LUT annually.`
    });
  }

  // ── 5. Format-Specific Checks ────────────────────────────────────────
  if (format === 'XML-2.1' || format === 'XML') {
    // XML-specific: no extra checks
  } else if (format === '1998BI') {
    // 1998BI is INTERNATIONAL — INR is uncommon here unless billing an
    // Indian subsidiary of a multinational that mandates LEDES.
    if (currency === 'INR' && !inv.client_internal_id) {
      warnings.push({
        code: 'INR_LEDES_DOMESTIC_HINT',
        msg: 'Currency is INR (domestic) but LEDES export is being generated. Indian domestic clients rarely require LEDES — confirm whether this client is actually an Indian subsidiary of a multinational that mandates LEDES (e.g., Microsoft India, Google India) or a purely domestic client who only needs a PDF invoice.'
      });
    }
  } else if (format === '1998B') {
    if (currency !== 'USD') {
      warnings.push({
        code: 'NON_USD_IN_1998B',
        msg: `Currency is ${currency} but LEDES 1998B is US-only and does not carry currency. Use LEDES 1998BI for international billing.`
      });
    }
  }

  // ── 5. Summary ───────────────────────────────────────────────────────
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      invoice_no:    inv.invoice_no,
      client:        inv.client_name,
      currency,
      total:         Number(inv.total).toFixed(2),
      line_items:    items.length,
      fee_lines:     feeCount,
      expense_lines: expenseCount,
      format
    }
  };
}

module.exports = {
  generateLEDES1998B,
  generateLEDES1998BI,
  generateLEDESXML21,
  validateLEDES,
  // Exported for testing
  resolveUTBMS,
  deriveExpenseCode,
  isExpenseLine,
  cleanDescriptionForLEDES
};
