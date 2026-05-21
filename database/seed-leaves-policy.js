/**
 * Idempotent seed: AP & Partners HR policy leave types + 2026 holiday list.
 *
 * Safe to run multiple times — uses INSERT OR IGNORE for codes/dates that
 * already exist, so re-running won't duplicate rows or overwrite admin edits.
 *
 * Run:
 *   node database/seed-leaves-policy.js
 */
require('dotenv').config();
const { db } = require('../utils/db');

// ─── Leave types per AP & Partners HR Policy Manual ─────────────────────────
// Schema reminder: (code, name, default_annual_quota, is_paid, carry_forward,
//                   max_carry_forward, color, count_method)
const leaveTypes = [
  // MAT counts every calendar day per the Maternity Benefit Act 1961 (26 weeks
  // = 182 days, weekends/holidays included). Hence count_method='calendar_days'.
  ['MAT',     'Maternity Leave',     182, 1, 0, 0, '#ec4899', 'calendar_days'],

  // PAT — 5 working days, within 90 days of birth/adoption, max 2x in tenure.
  ['PAT',     'Paternity Leave',       5, 1, 0, 0, '#8b5cf6', 'working_days'],

  // COMPASSIONATE — 3 working days, death of immediate family.
  // Policy: holidays/weekends NOT counted (matches default working_days behavior).
  ['COMPASSIONATE', 'Compassionate Leave', 3, 1, 0, 0, '#475569', 'working_days'],
];

const insertLT = db.prepare(
  `INSERT OR IGNORE INTO leave_types
   (code, name, default_annual_quota, is_paid, carry_forward, max_carry_forward, color, count_method)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
let ltAdded = 0;
for (const row of leaveTypes) {
  const info = insertLT.run(...row);
  if (info.changes > 0) ltAdded++;
}
console.log(`[seed] Leave types: ${ltAdded} added, ${leaveTypes.length - ltAdded} already existed.`);

// ─── 2026 Holiday list (AP & Partners) ──────────────────────────────────────
// Working-day holidays — affect leave day computation.
const publicHolidays2026 = [
  ['2026-01-01', "New Year's Day"],
  ['2026-01-26', 'Republic Day'],
  ['2026-03-04', 'Holi'],
  ['2026-03-26', 'Ram Navami'],
  ['2026-04-03', 'Good Friday'],
  ['2026-08-28', 'Raksha Bandhan'],
  ['2026-10-02', 'Mahatma Gandhi Jayanti'],
  ['2026-10-20', 'Dussehra'],
  ['2026-11-09', 'Diwali (Gowardhan Puja)'],
  ['2026-11-10', 'Diwali Break / Balipadyami'],
  ['2026-11-24', 'Guru Nanak Jayanti'],
  ['2026-12-25', 'Christmas'],
];

// Weekend holidays — informational only (already off, marked is_optional=1
// so calendar shows them but leave-day computation skips).
const weekendHolidays2026 = [
  ['2026-02-15', 'Maha Shivaratri'],          // Sunday
  ['2026-03-21', 'Ramzan Eid-Al-Fitr'],       // Saturday
  ['2026-08-15', 'Independence Day'],         // Saturday
  ['2026-11-08', 'Diwali (Laxmi Puja)'],      // Sunday
];

const insertHoliday = db.prepare(
  `INSERT OR IGNORE INTO holidays (holiday_date, name, is_optional, description) VALUES (?, ?, ?, ?)`
);
let hAdded = 0, hSkipped = 0;
for (const [d, n] of publicHolidays2026) {
  const info = insertHoliday.run(d, n, 0, null);
  if (info.changes > 0) hAdded++; else hSkipped++;
}
for (const [d, n] of weekendHolidays2026) {
  const info = insertHoliday.run(d, n, 1, 'Falls on weekend');
  if (info.changes > 0) hAdded++; else hSkipped++;
}
console.log(`[seed] Holidays 2026: ${hAdded} added, ${hSkipped} already existed.`);

console.log('[seed] Done.');
