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

/** Escape any pipe characters in a string (LEDES uses | as field separator). */
function escapePipes(s) {
  if (s == null) return '';
  return String(s).replace(/[|\r\n]/g, ' ').trim();
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

  // For each invoice_item, find the source timesheet entry to recover activity_type
  // (used to map to UTBMS). If multiple entries roll into one item, use the
  // most common activity_type.
  const itemsWithActivity = items.map(item => {
    let activityType = null;
    if (item.user_id && item.matter_id) {
      const row = db.prepare(`
        SELECT activity_type, COUNT(*) AS c
        FROM timesheet_entries
        WHERE invoice_id = ? AND user_id = ? AND matter_id = ?
        GROUP BY activity_type
        ORDER BY c DESC LIMIT 1
      `).get(invoiceId, item.user_id, item.matter_id);
      activityType = row ? row.activity_type : null;
    }
    return { ...item, activity_type: activityType };
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
      ? { task: '', activity: '' }
      : resolveUTBMS(item.activity_type, inv.client_id);
    const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';

    const fields = [
      fmtDateYYYYMMDD(inv.invoice_date),
      escapePipes(inv.invoice_no),
      escapePipes(inv.client_internal_id || inv.client_name),
      escapePipes(item.client_matter_id || item.file_no || ''),
      Number(inv.total).toFixed(2),
      fmtDateYYYYMMDD(inv.period_from),
      fmtDateYYYYMMDD(inv.period_to),
      escapePipes(inv.notes || `Legal services - invoice ${inv.invoice_no}`),
      idx + 1,
      isExpense ? 'E' : 'F',
      Number(item.quantity).toFixed(2),
      0,
      Number(item.amount).toFixed(2),
      fmtDateYYYYMMDD(inv.period_to || inv.invoice_date),  // line item date
      utbms.task,
      expenseCode,
      utbms.activity,
      escapePipes(item.lawyer_code || (item.user_id ? `TK${item.user_id}` : '')),
      escapePipes(item.description),
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

// ═════════════════════════════════════════════════════════════════════════
// LEDES 1998BI — International format (with currency)
// ═════════════════════════════════════════════════════════════════════════

const LEDES_1998BI_HEADER =
  'INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID|LAW_FIRM_MATTER_ID|INVOICE_TOTAL|' +
  'BILLING_START_DATE|BILLING_END_DATE|INVOICE_DESCRIPTION|LINE_ITEM_NUMBER|' +
  'EXP/FEE/INV_ADJ_TYPE|LINE_ITEM_NUMBER_OF_UNITS|LINE_ITEM_ADJUSTMENT_AMOUNT|' +
  'LINE_ITEM_TOTAL|LINE_ITEM_DATE|LINE_ITEM_TASK_CODE|LINE_ITEM_EXPENSE_CODE|' +
  'LINE_ITEM_ACTIVITY_CODE|TIMEKEEPER_ID|LINE_ITEM_DESCRIPTION|LAW_FIRM_ID|' +
  'LINE_ITEM_UNIT_COST|TIMEKEEPER_NAME|TIMEKEEPER_CLASSIFICATION|CLIENT_MATTER_ID|' +
  'INVOICE_CURRENCY|TIMEKEEPER_LAST_NAME|TIMEKEEPER_FIRST_NAME|ACCOUNT_TYPE[]';

function generateLEDES1998BI(invoiceId) {
  const { inv, items } = loadInvoiceForLEDES(invoiceId);
  const lawFirmId = process.env.LEDES_LAW_FIRM_ID || 'APPARTNERS';
  const currency = (inv.currency || 'INR').toUpperCase();

  let output = 'LEDES1998BI V2[]\n' + LEDES_1998BI_HEADER + '\n';

  items.forEach((item, idx) => {
    const isExpense = isExpenseLine(item);
    const utbms = isExpense
      ? { task: '', activity: '' }
      : resolveUTBMS(item.activity_type, inv.client_id);
    const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';
    const nameParts = (item.timekeeper_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    const fields = [
      fmtDateYYYYMMDD(inv.invoice_date),
      escapePipes(inv.invoice_no),
      escapePipes(inv.client_internal_id || inv.client_name),
      escapePipes(item.client_matter_id || item.file_no || ''),
      Number(inv.total).toFixed(2),
      fmtDateYYYYMMDD(inv.period_from),
      fmtDateYYYYMMDD(inv.period_to),
      escapePipes(inv.notes || `Legal services - invoice ${inv.invoice_no}`),
      idx + 1,
      isExpense ? 'E' : 'F',
      Number(item.quantity).toFixed(2),
      0,
      Number(item.amount).toFixed(2),
      fmtDateYYYYMMDD(inv.period_to || inv.invoice_date),
      utbms.task,
      expenseCode,
      utbms.activity,
      escapePipes(item.lawyer_code || (item.user_id ? `TK${item.user_id}` : '')),
      escapePipes(item.description),
      lawFirmId,
      Number(item.rate).toFixed(2),
      escapePipes(item.timekeeper_name || ''),
      tkClass(item),
      escapePipes(item.client_matter_id || item.file_no || ''),
      currency,                              // INVOICE_CURRENCY (new in 1998BI)
      escapePipes(lastName),                 // TIMEKEEPER_LAST_NAME
      escapePipes(firstName),                // TIMEKEEPER_FIRST_NAME
      isExpense ? 'IC' : 'CL'                // ACCOUNT_TYPE: IC=Inv Charge, CL=Client
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
    xml += `      <ClientMatterID>${xmlEscape(g.client_matter_id || g.file_no || '')}</ClientMatterID>\n`;
    xml += `      <LawFirmMatterID>${xmlEscape(g.file_no || '')}</LawFirmMatterID>\n`;
    if (g.title) xml += `      <MatterName>${xmlEscape(g.title)}</MatterName>\n`;

    g.items.forEach((item, idx) => {
      const isExpense = isExpenseLine(item);
      const utbms = isExpense
        ? { task: '', activity: '' }
        : resolveUTBMS(item.activity_type, inv.client_id);
      const expenseCode = isExpense ? deriveExpenseCode(item.description) : '';

      xml += '      <LineItem>\n';
      xml += `        <LineItemNumber>${idx + 1}</LineItemNumber>\n`;
      xml += `        <LineItemDate>${fmtDateYYYYMMDD(inv.period_to || inv.invoice_date)}</LineItemDate>\n`;
      xml += `        <LineItemType>${isExpense ? 'E' : 'F'}</LineItemType>\n`;
      xml += `        <Units>${Number(item.quantity).toFixed(2)}</Units>\n`;
      xml += `        <Rate>${Number(item.rate).toFixed(2)}</Rate>\n`;
      xml += `        <LineItemTotal>${Number(item.amount).toFixed(2)}</LineItemTotal>\n`;
      if (utbms.task) xml += `        <TaskCode>${utbms.task}</TaskCode>\n`;
      if (utbms.activity) xml += `        <ActivityCode>${utbms.activity}</ActivityCode>\n`;
      if (expenseCode) xml += `        <ExpenseCode>${expenseCode}</ExpenseCode>\n`;
      xml += `        <Description>${xmlEscape(item.description)}</Description>\n`;
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
  if (/cop(y|ies|ying)/.test(d))     return 'E101';
  if (/print/.test(d))               return 'E102';
  if (/fax|facsimile/.test(d))       return 'E104';
  if (/telephone|call charges/.test(d)) return 'E105';
  if (/online research|database/.test(d)) return 'E106';
  if (/courier|messenger|delivery/.test(d)) return 'E107';
  if (/postage|stamp/.test(d))       return 'E108';
  if (/local travel|cab|taxi/.test(d)) return 'E109';
  if (/out.?of.?town|flight|hotel/.test(d)) return 'E110';
  if (/meal|food|lunch|dinner/.test(d)) return 'E111';
  if (/court fee/.test(d))           return 'E112';
  if (/subpoena/.test(d))            return 'E113';
  if (/witness/.test(d))             return 'E114';
  if (/deposition/.test(d))          return 'E115';
  if (/transcript/.test(d))          return 'E116';
  if (/expert/.test(d))              return 'E119';
  if (/private investigat/.test(d))  return 'E120';
  if (/arbitrat|mediat/.test(d))     return 'E121';
  if (/local counsel/.test(d))       return 'E122';
  return 'E124';  // Other
}

module.exports = {
  generateLEDES1998B,
  generateLEDES1998BI,
  generateLEDESXML21,
  // Exported for testing
  resolveUTBMS,
  deriveExpenseCode,
  isExpenseLine
};
