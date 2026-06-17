const Database = require('better-sqlite3');
const db = new Database('C:\\ap-timesheet\\database\\aptimesheet.db', { readonly: true });

console.log('=== All active admin/super_admin users ===');
const rows = db.prepare(`
  SELECT u.id, u.email, u.full_name, u.role AS legacy_role, r.code AS role_code, r.name AS role_name,
         u.is_active, u.deleted_at, u.last_login_at
  FROM users u
  LEFT JOIN roles r ON r.id = u.role_id
  WHERE u.is_active = 1 AND u.deleted_at IS NULL
    AND (u.role IN ('admin','super_admin') OR r.code IN ('admin','super_admin'))
  ORDER BY u.last_login_at DESC NULLS LAST
`).all();
for (const r of rows) console.log(JSON.stringify(r));

console.log('\n=== All roles defined in the system ===');
const roles = db.prepare('SELECT id, code, name FROM roles ORDER BY id').all();
for (const r of roles) console.log(JSON.stringify(r));
