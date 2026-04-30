/**
 * Optional sample data — useful for demoing the UI.
 *
 *   npm run seed
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../utils/db');
require('./init').ensureSchema();

function ensureUser({ email, full_name, role, designation, default_rate, password }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, designation, default_rate)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(email, hash, full_name, role, designation, default_rate);
  return info.lastInsertRowid;
}

function ensureClient(c) {
  const existing = db.prepare('SELECT id FROM clients WHERE name = ?').get(c.name);
  if (existing) return existing.id;
  const info = db.prepare(
    `INSERT INTO clients (code, name, contact_person, email, phone, gstin, address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(c.code, c.name, c.contact_person || null, c.email || null, c.phone || null, c.gstin || null, c.address || null);
  return info.lastInsertRowid;
}

function ensureMatter(m) {
  const existing = db.prepare(
    'SELECT id FROM matters WHERE client_id = ? AND file_no = ?'
  ).get(m.client_id, m.file_no);
  if (existing) return existing.id;
  const info = db.prepare(
    `INSERT INTO matters (client_id, file_no, title, description, billing_type,
                          matter_rate, flat_fee, retainer_amount, opened_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))`
  ).run(m.client_id, m.file_no, m.title, m.description || null, m.billing_type,
        m.matter_rate || 0, m.flat_fee || 0, m.retainer_amount || 0);
  return info.lastInsertRowid;
}

(function run() {
  const adminId      = ensureUser({ email: 'it@appartners.in', full_name: 'Mohd Amir',     role: 'admin',     designation: 'IT Manager',         default_rate: 0,    password: 'Admin@123' });
  const partnerId    = ensureUser({ email: 'partner@appartners.in', full_name: 'Senior Partner', role: 'admin', designation: 'Partner',          default_rate: 5000, password: 'Partner@123' });
  const associateA   = ensureUser({ email: 'rohan@appartners.in', full_name: 'Rohan Sharma',  role: 'associate', designation: 'Senior Associate', default_rate: 3000, password: 'Pass@123' });
  const associateB   = ensureUser({ email: 'priya@appartners.in', full_name: 'Priya Singh',   role: 'associate', designation: 'Associate',        default_rate: 2000, password: 'Pass@123' });
  const associateC   = ensureUser({ email: 'arjun@appartners.in', full_name: 'Arjun Verma',   role: 'associate', designation: 'Junior Associate', default_rate: 1500, password: 'Pass@123' });

  const clientAcme   = ensureClient({ code: 'ACME', name: 'Acme Industries Pvt. Ltd.', contact_person: 'Mr. R. Kapoor', email: 'legal@acme.in', phone: '+91-1142020202', gstin: '07AAACA1234A1Z5', address: 'Connaught Place, New Delhi' });
  const clientBeta   = ensureClient({ code: 'BETA', name: 'Beta Logistics Ltd.',       contact_person: 'Ms. S. Mehta',  email: 'mehta@beta.com', phone: '+91-2266767676', gstin: '27AAFCB9999B1Z9', address: 'Andheri East, Mumbai' });
  const clientGamma  = ensureClient({ code: 'GAMA', name: 'Gamma Realty LLP',          contact_person: 'Mr. A. Iyer',   email: 'a.iyer@gamma.in' });

  const matter1 = ensureMatter({ client_id: clientAcme,  file_no: 'AP/2026/001', title: 'Acme vs. Delhi MCD — writ petition', billing_type: 'hourly_user' });
  const matter2 = ensureMatter({ client_id: clientAcme,  file_no: 'AP/2026/002', title: 'Acme — vendor contract review',     billing_type: 'flat', flat_fee: 75000 });
  const matter3 = ensureMatter({ client_id: clientBeta,  file_no: 'AP/2026/010', title: 'Beta Logistics — labour dispute',   billing_type: 'hourly_matter', matter_rate: 4000 });
  const matter4 = ensureMatter({ client_id: clientGamma, file_no: 'AP/2026/020', title: 'Gamma Realty — title due diligence', billing_type: 'retainer', retainer_amount: 200000 });

  // a couple of sample timesheet entries
  const insertEntry = db.prepare(
    `INSERT INTO timesheet_entries
       (user_id, client_id, matter_id, entry_date, start_time, end_time, hours,
        activity_type, description, is_billable, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`
  );

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  insertEntry.run(associateA, clientAcme, matter1, today,    '10:00', '13:30', 3.5, 'court',     'High Court hearing — interim relief argued', 1);
  insertEntry.run(associateA, clientAcme, matter1, yesterday,'15:00', '18:00', 3.0, 'drafting',  'Drafted reply to MCD counter-affidavit', 1);
  insertEntry.run(associateB, clientBeta, matter3, today,    '11:00', '14:00', 3.0, 'research',  'Researched Industrial Disputes Act amendments', 1);
  insertEntry.run(associateC, clientAcme, matter2, yesterday,'09:30', '12:30', 3.0, 'drafting',  'Reviewed vendor MSA Section 8 onwards', 1);

  console.log('[seed] Done.');
  console.log('  Admin    : it@appartners.in / Admin@123');
  console.log('  Partner  : partner@appartners.in / Partner@123');
  console.log('  Assoc-A  : rohan@appartners.in / Pass@123');
  console.log('  Assoc-B  : priya@appartners.in / Pass@123');
  console.log('  Assoc-C  : arjun@appartners.in / Pass@123');
})();
