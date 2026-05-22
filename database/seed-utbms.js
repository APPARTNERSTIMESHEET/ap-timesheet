/**
 * Seeds UTBMS (Uniform Task-Based Management System) codes used by LEDES.
 *
 * Idempotent — safe to run on every boot. INSERT OR IGNORE means existing
 * rows aren't touched, so admins can mark codes inactive without seed undoing.
 *
 * Source: LEDES Oversight Committee published code sets (https://ledes.org).
 * Reproduced here for offline operation; codes are public standards.
 */
const { db } = require('../utils/db');

function seedUTBMS() {
  // ─── TASK CODES ────────────────────────────────────────────────────────────
  // L100-L800: Litigation
  const taskCodes = [
    // Litigation - Case Assessment, Development and Administration (L100s)
    ['L110', 'Litigation', 'Fact Investigation/Development'],
    ['L120', 'Litigation', 'Analysis/Strategy'],
    ['L130', 'Litigation', 'Experts/Consultants'],
    ['L140', 'Litigation', 'Document/File Management'],
    ['L150', 'Litigation', 'Budgeting'],
    ['L160', 'Litigation', 'Settlement/Non-Binding ADR'],
    ['L190', 'Litigation', 'Other Case Assessment, Development and Administration'],

    // Litigation - Pre-Trial Pleadings and Motions (L200s)
    ['L210', 'Litigation', 'Pleadings'],
    ['L220', 'Litigation', 'Preliminary Injunctions/Provisional Remedies'],
    ['L230', 'Litigation', 'Court Mandated Conferences'],
    ['L240', 'Litigation', 'Dispositive Motions'],
    ['L250', 'Litigation', 'Other Written Motions and Submissions'],
    ['L260', 'Litigation', 'Class Action Certification and Notice'],

    // Litigation - Discovery (L300s)
    ['L310', 'Litigation', 'Written Discovery'],
    ['L320', 'Litigation', 'Document Production'],
    ['L330', 'Litigation', 'Depositions'],
    ['L340', 'Litigation', 'Expert Discovery'],
    ['L350', 'Litigation', 'Discovery Motions'],
    ['L390', 'Litigation', 'Other Discovery'],

    // Litigation - Trial Preparation and Trial (L400s)
    ['L410', 'Litigation', 'Fact Witnesses'],
    ['L420', 'Litigation', 'Expert Witnesses'],
    ['L430', 'Litigation', 'Written Motions and Submissions'],
    ['L440', 'Litigation', 'Other Trial Preparation and Support'],
    ['L450', 'Litigation', 'Trial and Hearing Attendance'],
    ['L460', 'Litigation', 'Post-Trial Motions and Submissions'],
    ['L470', 'Litigation', 'Enforcement'],

    // Litigation - Appeal (L500s)
    ['L510', 'Litigation', 'Appellate Motions and Submissions'],
    ['L520', 'Litigation', 'Appellate Briefs'],
    ['L530', 'Litigation', 'Oral Argument'],

    // C100-C800: Counseling
    ['C100', 'Counseling', 'Fact Gathering'],
    ['C200', 'Counseling', 'Researching Law'],
    ['C300', 'Counseling', 'Analysis and Advice'],
    ['C400', 'Counseling', 'Other'],

    // A100-A700: Project Activities (typical for transactional / corporate work)
    ['P100', 'Project', 'Project Administration'],
    ['P200', 'Project', 'Fact Gathering / Due Diligence'],
    ['P300', 'Project', 'Structure / Strategy / Analysis'],
    ['P400', 'Project', 'Initial Document Preparation / Filing'],
    ['P500', 'Project', 'Negotiation / Revisions / Responses'],
    ['P600', 'Project', 'Completion / Closing'],
    ['P700', 'Project', 'Post-Completion / Closing'],

    // B100-B500: Bankruptcy
    ['B100', 'Bankruptcy', 'Administration'],
    ['B110', 'Bankruptcy', 'Case Administration'],
    ['B120', 'Bankruptcy', 'Asset Analysis and Recovery'],
    ['B130', 'Bankruptcy', 'Asset Disposition'],
    ['B140', 'Bankruptcy', 'Relief from Stay/Adequate Protection Proceedings'],
    ['B150', 'Bankruptcy', 'Meetings of and Communications with Creditors'],
    ['B160', 'Bankruptcy', 'Fee/Employment Applications'],
    ['B170', 'Bankruptcy', 'Fee/Employment Objections'],
    ['B180', 'Bankruptcy', 'Avoidance Action Analysis'],
    ['B190', 'Bankruptcy', 'Other Contested Matters'],
    ['B210', 'Bankruptcy', 'Business Operations'],
    ['B220', 'Bankruptcy', 'Employee Benefits/Pensions'],
    ['B230', 'Bankruptcy', 'Financing/Cash Collateral'],
    ['B240', 'Bankruptcy', 'Tax Issues'],
    ['B250', 'Bankruptcy', 'Real Estate'],
    ['B260', 'Bankruptcy', 'Board of Directors Matters'],
    ['B310', 'Bankruptcy', 'Claims Administration and Objections'],
    ['B320', 'Bankruptcy', 'Plan and Disclosure Statement']
  ];

  const insertTask = db.prepare(
    `INSERT OR IGNORE INTO utbms_task_codes (code, category, description) VALUES (?, ?, ?)`
  );
  for (const [code, category, description] of taskCodes) insertTask.run(code, category, description);

  // ─── ACTIVITY CODES ───────────────────────────────────────────────────────
  // How the work was performed.
  const activityCodes = [
    ['A101', 'Plan and prepare for'],
    ['A102', 'Research'],
    ['A103', 'Draft/revise'],
    ['A104', 'Review/analyze'],
    ['A105', 'Communicate (in firm)'],
    ['A106', 'Communicate (with client)'],
    ['A107', 'Communicate (other outside counsel)'],
    ['A108', 'Communicate (other external)'],
    ['A109', 'Appear for/attend'],
    ['A110', 'Manage data/files'],
    ['A111', 'Other']
  ];
  const insertActivity = db.prepare(
    `INSERT OR IGNORE INTO utbms_activity_codes (code, description) VALUES (?, ?)`
  );
  for (const [code, description] of activityCodes) insertActivity.run(code, description);

  // ─── EXPENSE CODES ────────────────────────────────────────────────────────
  // Types of disbursements/expenses charged to the matter.
  const expenseCodes = [
    ['E101', 'Copying'],
    ['E102', 'Outside printing'],
    ['E103', 'Word processing'],
    ['E104', 'Facsimile'],
    ['E105', 'Telephone'],
    ['E106', 'Online research'],
    ['E107', 'Delivery services / messengers'],
    ['E108', 'Postage'],
    ['E109', 'Local travel'],
    ['E110', 'Out-of-town travel'],
    ['E111', 'Meals'],
    ['E112', 'Court fees'],
    ['E113', 'Subpoena fees'],
    ['E114', 'Witness fees'],
    ['E115', 'Deposition transcripts'],
    ['E116', 'Trial transcripts'],
    ['E117', 'Trial exhibits'],
    ['E118', 'Litigation support vendors'],
    ['E119', 'Experts'],
    ['E120', 'Private investigators'],
    ['E121', 'Arbitrators/mediators'],
    ['E122', 'Local counsel'],
    ['E123', 'Other professionals'],
    ['E124', 'Other']
  ];
  const insertExpense = db.prepare(
    `INSERT OR IGNORE INTO utbms_expense_codes (code, description) VALUES (?, ?)`
  );
  for (const [code, description] of expenseCodes) insertExpense.run(code, description);

  // ─── DEFAULT ACTIVITY → UTBMS MAPPING ────────────────────────────────────
  // Maps our internal activity_type (used in timesheet_entries) to LEDES
  // task+activity codes. These are global defaults (client_id = NULL).
  // Per-client overrides can be added later via the admin UI.
  const defaultMappings = [
    ['drafting', 'L210', 'A103'],   // Pleadings + Draft/revise
    ['research', 'L120', 'A102'],   // Analysis + Research
    ['court',    'L450', 'A109'],   // Trial + Appear/attend
    ['meeting',  'L120', 'A106'],   // Analysis + Communicate (client)
    ['call',     'L120', 'A106'],   // Same as meeting
    ['review',   'L120', 'A104'],   // Analysis + Review/analyze
    ['other',    'L190', 'A111']    // Other case admin + Other
  ];
  const insertMapping = db.prepare(
    `INSERT OR IGNORE INTO activity_utbms_mapping (activity_type, task_code, activity_code, client_id)
     VALUES (?, ?, ?, NULL)`
  );
  for (const [act, task, activity] of defaultMappings) insertMapping.run(act, task, activity);

  const taskCount = db.prepare('SELECT COUNT(*) AS c FROM utbms_task_codes').get().c;
  const actCount  = db.prepare('SELECT COUNT(*) AS c FROM utbms_activity_codes').get().c;
  const expCount  = db.prepare('SELECT COUNT(*) AS c FROM utbms_expense_codes').get().c;
  const mapCount  = db.prepare('SELECT COUNT(*) AS c FROM activity_utbms_mapping').get().c;
  console.log(`[seed-utbms] tasks=${taskCount} activities=${actCount} expenses=${expCount} mappings=${mapCount}`);
}

module.exports = { seedUTBMS };
