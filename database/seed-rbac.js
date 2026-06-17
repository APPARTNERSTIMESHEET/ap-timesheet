/**
 * Idempotent RBAC seed.
 *
 * Run on every server boot (called from database/init.js) to:
 *   1. Ensure all default permissions exist (40+ atomic capabilities).
 *   2. Ensure default roles exist (super_admin, admin, billing, hr, associate, partner_view).
 *   3. Wire default role → permission grants.
 *   4. Backfill users.role_id from the legacy users.role text column.
 *
 * Re-running is safe: INSERT OR IGNORE for new rows, no overwrites of admin
 * edits made via the Roles & Permissions UI later.
 *
 * Stand-alone run:
 *   node database/seed-rbac.js
 */
const { db } = require('../utils/db');

// ─── 1. Permission catalogue ─────────────────────────────────────────────────
// Each entry is [code, category, name, description]. The code is the stable
// identifier checked by requirePermission() in middleware.
const PERMISSIONS = [
  // Users & Roles
  ['users.view',                  'Users',     'View user list',           'See the user list and basic profile info'],
  ['users.create',                'Users',     'Create users',             'Add new employees / associates'],
  ['users.update',                'Users',     'Edit users',               'Edit name, designation, role, rate, etc.'],
  ['users.delete',                'Users',     'Delete (soft) users',      'Move users to recycle bin'],
  ['users.restore',               'Users',     'Restore deleted users',    'Bring soft-deleted users back from recycle bin'],
  ['users.hard_delete',           'Users',     'Permanently delete users', 'Irreversible removal from DB (super-admin only)'],
  ['users.force_password_reset',  'Users',     'Force password reset',     'Reset any user password without knowing the old one'],
  ['users.impersonate',           'Users',     'Impersonate users',        'Login as any user to debug their view (audit-logged)'],
  ['roles.manage',                'Users',     'Manage roles & permissions','Create custom roles and edit the permission matrix'],

  // Clients
  ['clients.view',                'Clients',   'View clients',             'See client list and details'],
  ['clients.create',              'Clients',   'Create clients',           'Add new clients'],
  ['clients.update',              'Clients',   'Edit clients',             'Edit client details'],
  ['clients.delete',              'Clients',   'Delete (soft) clients',    'Move clients to recycle bin'],

  // Matters
  ['matters.view',                'Matters',   'View matters',             'See matters / cases'],
  ['matters.create',              'Matters',   'Create matters',           'Add new matters'],
  ['matters.update',              'Matters',   'Edit matters',             'Edit matter details, billing type, rates'],
  ['matters.delete',              'Matters',   'Delete (soft) matters',    'Move matters to recycle bin'],
  ['rates.manage',                'Matters',   'Manage rate cards',        'Set per-matter / per-user hourly rate overrides'],

  // Timesheets
  ['timesheet.view_own',          'Timesheet', 'View own timesheets',      'Self-service timesheet entry and history'],
  ['timesheet.view_all',          'Timesheet', 'View all timesheets',      'See every associate\'s entries'],
  ['timesheet.create_own',        'Timesheet', 'Create own timesheets',    'Self-service create / edit own entries'],
  ['timesheet.create_for_others', 'Timesheet', 'Create on behalf',         'File timesheets on behalf of another user'],
  ['timesheet.approve',           'Timesheet', 'Approve / reject',         'Decide on submitted timesheet entries'],
  ['timesheet.delete',            'Timesheet', 'Delete entries',           'Remove entries (own or any, depending on combined perms)'],

  // Billing
  ['invoices.view',               'Billing',   'View invoices',            'See invoice list and details'],
  ['invoices.create',             'Billing',   'Create invoices',          'Generate / save invoice drafts'],
  ['invoices.issue',              'Billing',   'Issue invoices',           'Lock and issue drafts to clients'],
  ['invoices.edit_draft',         'Billing',   'Edit drafts',              'Change line items, invoice no., dates on drafts'],
  ['invoices.cancel',             'Billing',   'Cancel invoices',          'Cancel issued or draft invoices'],
  ['invoices.email',              'Billing',   'Email invoices',           'Send invoice PDF to client by email'],
  ['invoices.delete',             'Billing',   'Delete (soft) invoices',   'Move invoices to recycle bin'],
  ['invoices.restore',            'Billing',   'Restore invoices',         'Bring soft-deleted invoices back from recycle bin'],
  ['invoices.mark_paid',          'Billing',   'Mark invoices paid',       'Record payments / mark as paid (for accounts staff)'],
  ['invoices.tds_report',         'Billing',   'View TDS report',          'See TDS aggregation for Form 26AS reconciliation'],

  // Reports
  ['reports.hours',               'Reports',   'View hours reports',       'Hours summary, utilization, profitability'],
  ['reports.billing',             'Reports',   'View billing reports',     'Revenue, outstanding, overdue'],
  ['reports.export',              'Reports',   'Export reports to CSV',    'Download CSV exports'],

  // Work From Home
  ['wfh.apply_own',               'WFH',       'Apply for own WFH',        'Self-service work-from-home request'],
  ['wfh.apply_for_others',        'WFH',       'Apply WFH on behalf',      'File WFH request on behalf of another user (HR / Manual entry)'],
  ['wfh.view_own',                'WFH',       'View own WFH history',     'See own WFH applications'],
  ['wfh.view_all',                'WFH',       'View all WFH',             'See every employee\'s WFH records and calendar'],
  ['wfh.approve',                 'WFH',       'Approve / reject WFH',     'Decide on submitted WFH applications'],
  ['wfh.reports',                 'WFH',       'View WFH reports',         'Per-user WFH day counts, monthly summaries'],

  // Leaves
  ['leaves.apply_own',            'Leaves',    'Apply for own leave',      'Self-service leave application'],
  ['leaves.apply_for_others',     'Leaves',    'Apply on behalf',          'File leave on behalf of another user (HR / Manual entry)'],
  ['leaves.view_own',             'Leaves',    'View own leave history',   'See own balance and applications'],
  ['leaves.view_all',             'Leaves',    'View all leaves',          'See every employee\'s leave records'],
  ['leaves.approve',              'Leaves',    'Approve / reject',         'Decide on leave applications'],
  ['leaves.manage_types',         'Leaves',    'Manage leave types',       'Create / edit leave types and quotas'],
  ['leaves.manage_holidays',      'Leaves',    'Manage holidays',          'Add / remove public holidays'],
  ['leaves.allocate',             'Leaves',    'Allocate leave balances',  'Bulk allocate annual quotas to users'],
  ['leaves.reports',              'Leaves',    'View leave reports',       'Pivot reports, deep-dive, CSV export'],

  // System / Audit
  ['audit.view',                  'System',    'View activity log',        'See the full audit trail'],
  ['recycle_bin.view',            'System',    'View recycle bin',         'Browse soft-deleted items'],
  ['system.settings',             'System',    'System settings',          'App-wide settings (super-admin only)'],

  // ── Insider Trading Policy (SEBI compliance) ────────────────────────────
  // Every DP (designated person) gets `.self` perms automatically — those let
  // them file their own annexures. Compliance Officer gets the broader
  // `.review` + `.config` perms to approve/reject, manage Restricted List,
  // and audit. Management Committee gets `.report` for annual reviews.
  ['insider.self',                  'Insider Policy', 'File own annexures',         'Submit own Annexure 1/2/3/4/5/7/8 (every Designated Person needs this)'],
  ['insider.view_own',              'Insider Policy', 'View own submissions',       'See history of own pre-clearance requests, holdings statements, etc.'],
  ['insider.review',                'Insider Policy', 'Review pre-clearances',      'Approve / reject pre-clearance requests (Compliance Officer)'],
  ['insider.restricted_list',       'Insider Policy', 'Manage Restricted List',     'Add / remove companies from the Restricted List (confidential)'],
  ['insider.upsi_log',              'Insider Policy', 'Maintain UPSI sharing log',  'Log every UPSI sharing event with recipient PAN (SEBI audit requirement)'],
  ['insider.dp_admin',              'Insider Policy', 'Manage Designated Persons',  'Add / remove DPs, set DP type, view all DP submissions'],
  ['insider.report',                'Insider Policy', 'Annual compliance reports',  'View annual compliance report (Management Committee)'],
  ['insider.audit_trail',           'Insider Policy', 'View insider audit trail',   'Read-only access to the SEBI 5-year audit trail'],
  ['insider.config',                'Insider Policy', 'Configure insider policy',   'Set Compliance Officer, thresholds, trade window (Management Committee)'],
];

// ─── 2. Default roles ────────────────────────────────────────────────────────
// is_system roles can't be deleted from the UI (prevents lockout). Their
// permission lists CAN be edited by super_admin if the firm needs tweaks.
const ROLES = [
  { code: 'super_admin',  name: 'Super Admin',     description: 'Full system control. Can manage roles, restore deleted items, impersonate users.', is_system: 1 },
  { code: 'admin',        name: 'Administrator',   description: 'Day-to-day admin. Timesheet approval, billing, masters.',                              is_system: 1 },
  { code: 'billing',      name: 'Billing',         description: 'Billing-only access. Invoice create / issue / cancel / email.',                        is_system: 1 },
  { code: 'hr',           name: 'HR',              description: 'HR operations: leaves, holidays, user management, leave reports.',                     is_system: 1 },
  { code: 'partner_view', name: 'Partner (read-only)', description: 'Partners can view everything but make no changes.',                                is_system: 1 },
  { code: 'associate',    name: 'Associate',       description: 'Self-service: own timesheets, leaves, profile.',                                       is_system: 1 },
  { code: 'accounts',     name: 'Accounts',        description: 'Read-only billing access: invoices, outstanding, TDS, payment tracking. No timesheets / users / masters / leaves.', is_system: 1 },
  { code: 'compliance_officer', name: 'Compliance Officer', description: 'SEBI Insider Trading Policy administrator. Reviews pre-clearance requests, manages Restricted List + UPSI log, prepares annual reports.', is_system: 1 },
];

// ─── 3. Role → Permission grants ─────────────────────────────────────────────
const GRANTS = {
  // Super admin: every permission, including the destructive / sensitive ones.
  super_admin: PERMISSIONS.map(p => p[0]),

  // Regular admin: everything except super-admin-only capabilities.
  admin: [
    'users.view','users.create','users.update','users.delete','users.restore','users.force_password_reset',
    'clients.view','clients.create','clients.update','clients.delete',
    'matters.view','matters.create','matters.update','matters.delete','rates.manage',
    'timesheet.view_own','timesheet.view_all','timesheet.create_own','timesheet.create_for_others','timesheet.approve','timesheet.delete',
    'invoices.view','invoices.create','invoices.issue','invoices.edit_draft','invoices.cancel','invoices.email','invoices.delete',
    'reports.hours','reports.billing','reports.export',
    'leaves.apply_own','leaves.apply_for_others','leaves.view_own','leaves.view_all','leaves.approve','leaves.manage_types','leaves.manage_holidays','leaves.allocate','leaves.reports',
    'wfh.apply_own','wfh.apply_for_others','wfh.view_own','wfh.view_all','wfh.approve','wfh.reports',
    'audit.view',
    // Insider — admin can file own + view audit trail (read-only). Approve/reject + Restricted List = CO only.
    'insider.self','insider.view_own','insider.audit_trail','insider.report',
  ],

  // Billing-only role: invoice operations + read-only context. Per user's
  // request billing can also approve WFH (same approver pool as admin/HR).
  billing: [
    'users.view','clients.view','matters.view',
    'timesheet.view_all',
    'invoices.view','invoices.create','invoices.issue','invoices.edit_draft','invoices.cancel','invoices.email',
    'reports.hours','reports.billing','reports.export',
    'leaves.apply_own','leaves.view_own',
    'wfh.apply_own','wfh.view_own','wfh.view_all','wfh.approve','wfh.reports',
    // Insider — billing staff are DPs (Section I.A(e): "accounts, administration,
    // ... business development, IT, ..."). So self-file annexures.
    'insider.self','insider.view_own',
  ],

  // HR role per user request: leave management + employee management + reports + WFH approval.
  hr: [
    'users.view','users.create','users.update','users.delete','users.restore','users.force_password_reset',
    'leaves.apply_own','leaves.apply_for_others','leaves.view_own','leaves.view_all','leaves.approve',
    'leaves.manage_types','leaves.manage_holidays','leaves.allocate','leaves.reports',
    'wfh.apply_own','wfh.apply_for_others','wfh.view_own','wfh.view_all','wfh.approve','wfh.reports',
    'reports.hours','reports.export',
    'audit.view',
    // Insider — HR staff are DPs per Section I.A(e). HR also has visibility
    // on whether new joiners completed their onboarding annexures.
    'insider.self','insider.view_own','insider.dp_admin',
  ],

  // Partner view: read-only across the board, no destructive actions.
  partner_view: [
    'users.view','clients.view','matters.view',
    'timesheet.view_all',
    'invoices.view',
    'reports.hours','reports.billing','reports.export',
    'leaves.view_own','leaves.view_all','leaves.reports',
    'wfh.apply_own','wfh.view_own','wfh.view_all','wfh.reports',
    'audit.view',
    // Insider — Partners are DPs (Section I.A(a)). They also see the annual
    // compliance report since the Management Committee is partners.
    'insider.self','insider.view_own','insider.report','insider.audit_trail',
  ],

  // Plain associate: self-service only. Can apply for own WFH (policy: prior
  // approval from reporting partner required — approval still done by admin/HR/billing).
  associate: [
    'timesheet.view_own','timesheet.create_own','timesheet.delete',
    'leaves.apply_own','leaves.view_own',
    'wfh.apply_own','wfh.view_own',
    // Insider — every associate is a Designated Person per the policy, so
    // they MUST be able to file Annexure 1/2/3/4/5/7/8 and view their own
    // submissions. Approval / Restricted List / UPSI log = CO only.
    'insider.self','insider.view_own',
  ],

  // Accounts: dedicated for the firm's accounts staff. Read invoices, mark
  // them paid/unpaid, run TDS + outstanding reports. Light view of clients
  // (just to identify who owes what) but NO ability to modify clients/matters
  // or see internal HR data. Designed for the person who does monthly
  // collections + Form 26AS reconciliation, not invoice generation.
  accounts: [
    'clients.view',                                       // just to see client list/name
    'invoices.view',                                       // read all invoices
    'invoices.mark_paid',                                  // record payments — their core job
    'invoices.tds_report',                                 // TDS aggregation for Form 26AS
    'invoices.email',                                      // payment receipts / reminders
    'reports.billing','reports.export',                    // financial reports + Excel
    'leaves.apply_own','leaves.view_own',                  // own HR self-service only
    'wfh.apply_own','wfh.view_own',                        // own WFH self-service only
    // Intentionally NOT granted: invoices.create / .issue / .edit_draft /
    //   .cancel / .delete — accounts shouldn't generate / modify invoices.
    // Insider — accounts staff are DPs per Section I.A(e).
    'insider.self','insider.view_own',
  ],

  // Compliance Officer — the SEBI-mandated role per Section IV. Approves /
  // rejects pre-clearance requests, maintains the (highly confidential)
  // Restricted List, logs every UPSI sharing event, runs annual compliance
  // reviews, and answers to the Management Committee. Should be a senior
  // partner or trusted IT lead. Per policy, AP Partners has appointed Mr.
  // Sanjay Bhat (currently — switchable via insider_config).
  compliance_officer: [
    // CO is themselves a DP per the policy
    'insider.self','insider.view_own',
    // Core CO duties
    'insider.review','insider.restricted_list','insider.upsi_log',
    'insider.dp_admin','insider.report','insider.audit_trail',
    // Read context to make informed decisions
    'users.view','clients.view','matters.view',
    // CO also gets self-service HR like everyone else
    'leaves.apply_own','leaves.view_own',
    'wfh.apply_own','wfh.view_own',
  ],
};

// ─── 4. Run seed in one transaction ──────────────────────────────────────────
function seedRBAC() {
  const insertPerm = db.prepare(
    `INSERT OR IGNORE INTO permissions (code, category, name, description) VALUES (?, ?, ?, ?)`
  );
  const insertRole = db.prepare(
    `INSERT OR IGNORE INTO roles (code, name, description, is_system) VALUES (?, ?, ?, ?)`
  );
  const insertGrant = db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
     WHERE r.code = ? AND p.code = ?`
  );

  const tx = db.transaction(() => {
    let pNew = 0, rNew = 0, gNew = 0;

    for (const [code, cat, name, desc] of PERMISSIONS) {
      const info = insertPerm.run(code, cat, name, desc);
      if (info.changes) pNew++;
    }

    for (const r of ROLES) {
      const info = insertRole.run(r.code, r.name, r.description, r.is_system);
      if (info.changes) rNew++;
    }

    for (const [roleCode, permList] of Object.entries(GRANTS)) {
      for (const permCode of permList) {
        const info = insertGrant.run(roleCode, permCode);
        if (info.changes) gNew++;
      }
    }

    return { pNew, rNew, gNew };
  });
  const { pNew, rNew, gNew } = tx();

  // ── Backfill users.role_id from legacy users.role text ───────────────────
  // Maps 'admin'/'billing'/'associate' to the new role rows. Idempotent — only
  // touches users whose role_id is still NULL.
  const linkUsers = db.prepare(
    `UPDATE users
     SET role_id = (SELECT id FROM roles WHERE code = users.role)
     WHERE role_id IS NULL AND role IS NOT NULL`
  );
  const linked = linkUsers.run().changes;

  // ── Promote the default IT-manager admin to super_admin (one-time) ───────
  // Only happens if the firm has *no* super_admin user yet, so re-running this
  // seed never demotes anyone after the org has restructured.
  const haveSuperAdmin = db.prepare(
    `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'super_admin' AND u.is_active = 1`
  ).get().c;
  let promoted = 0;
  if (haveSuperAdmin === 0) {
    const promoteList = ['it@appartners.in', 'mohd.amir@appartners.in'];
    const superAdminRoleId = db.prepare("SELECT id FROM roles WHERE code = 'super_admin'").get().id;
    // Note: only update role_id. The legacy `users.role` text column has a
    // CHECK constraint allowing only 'admin'/'associate'/'billing' and will be
    // dropped in a later phase once all middleware reads role_id.
    const updStmt = db.prepare("UPDATE users SET role_id = ? WHERE email = ? AND is_active = 1 AND role_id IS NOT NULL");
    for (const em of promoteList) {
      const r = updStmt.run(superAdminRoleId, em);
      if (r.changes) promoted++;
    }
  }

  console.log(`[seed-rbac] permissions: +${pNew} new (${PERMISSIONS.length} total), roles: +${rNew} new (${ROLES.length} total), grants: +${gNew} new`);
  console.log(`[seed-rbac] users.role_id backfilled for ${linked} user(s); promoted ${promoted} user(s) to super_admin`);
}

if (require.main === module) {
  seedRBAC();
  console.log('[seed-rbac] Done.');
}

module.exports = { seedRBAC };
