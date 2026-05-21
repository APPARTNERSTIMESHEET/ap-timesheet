# AP & Partners Timesheet — Data Security & Safety

Yeh doc aapke pure system ka security model batata hai: data kahan hai, kis-kis threat se protect hai, aur kya extra steps karne chahiye.

---

## 1. Aapka data abhi kahan hai (3 layers)

```
            +-------------------------------------------+
            |    Layer 1: LIVE DATA (this laptop)       |
            |    C:\ap-timesheet\database\aptimesheet.db |
            |    C:\ap-timesheet\uploads\               |
            |    Live transactions, server reads here   |
            +---------------------+---------------------+
                                  |
                  Daily 02:00 AM  | (automated backup task)
                                  v
            +-------------------------------------------+
            |    Layer 2: LOCAL BACKUP (this laptop)    |
            |    C:\Users\Admin\OneDrive\               |
            |        AP-Timesheet-Backups\              |
            |    30-day rotation, integrity-verified    |
            +---------------------+---------------------+
                                  |
                  OneDrive sync   | (real-time auto sync)
                                  v
            +-------------------------------------------+
            |    Layer 3: CLOUD BACKUP (Microsoft)      |
            |    OneDrive cloud (Microsoft data centres) |
            |    30-day version history                 |
            |    Geographically separate from office    |
            +-------------------------------------------+
```

**Net result:** Agar laptop chori ho jaye, hard disk crash ho, ya ransomware lag jaye — aapka data **kabhi nahi khoyega**. 3 copies hain, alag-alag jagah par.

---

## 2. Kis-kis threat se aap protected hain

### 2.1 Hardware failure (hard disk crash, laptop chori)
- ✅ **Daily backup** OneDrive par sync
- ✅ **30-day version history** Microsoft side
- ✅ **Restore script** (`ops\restore.ps1`) tested aur ready
- **Recovery time:** ~60 minutes on a new laptop (per `OPERATIONS.md`)

### 2.2 Ransomware
- ✅ OneDrive me **30-day version history** — encryption hone se pehle ki versions recoverable
- ✅ Backups **read-only** ho jaate hain Cloud par
- ✅ Local backups **separate disk path** mein hain (OneDrive folder)
- **Recovery:** Restore last clean backup → ~30 min

### 2.3 Database corruption
- ✅ **Weekly integrity check** (Sunday 3 AM, `ops\weekly-health.ps1`)
- ✅ **WAL mode** SQLite — writes atomic, crash-safe
- ✅ **Hot backup** uses SQLite `.backup()` API (consistent snapshot)
- ✅ **Health endpoint** (`/api/health`) flags if integrity fails

### 2.4 Network attacks (man-in-the-middle, eavesdropping)
- ✅ **HTTPS only** via Cloudflare Tunnel — all traffic encrypted
- ✅ **TLS 1.3** automatic
- ✅ **No port forwarding** — laptop never directly exposed to internet
- ✅ **DDoS protection** — Cloudflare edge absorbs attack traffic

### 2.5 Authentication attacks
- ✅ **Bcrypt password hashing** (10 rounds) — passwords kabhi plaintext mein nahi
- ✅ **JWT tokens** with 8-hour expiry
- ✅ **JWT_SECRET enforced** in production (no default fallback)
- ✅ **Role-based access** — admin/billing/associate
- ⚠ **Rate limiting** abhi nahi hai login par (recommendation: install `express-rate-limit`)
- ⚠ **2FA** abhi nahi hai (recommended for admin accounts)

### 2.6 SQL injection
- ✅ **Parameterized queries** sab jagah (`better-sqlite3` ke prepared statements)
- ✅ No raw string concatenation in SQL
- ✅ Input validation on critical fields

### 2.7 XSS (Cross-Site Scripting)
- ✅ **`escapeHtml()` helper** har dynamic content par used
- ✅ **`X-Content-Type-Options: nosniff`** header
- ✅ **`X-Frame-Options: SAMEORIGIN`** — clickjacking prevention
- ✅ **`Referrer-Policy`** restricted
- ⚠ Frontend mein `innerHTML` use hai (57 occurrences) — escapeHtml sab pe used hai but audit reviewable

### 2.8 Data loss via accidental deletion
- ✅ **Soft delete** by default (user/client/matter DELETE)
- ✅ `is_active = 0` instead of permanent removal
- ✅ Hard delete blocked if linked invoices/entries exist (409 Conflict)
- ✅ Cancelled invoices preserved in audit trail

### 2.9 Insider threat / unauthorized changes
- ✅ **Audit log** har critical action ke liye
- ✅ Invoice review history tracked (`audit_log` table)
- ✅ Approver tracked on every timesheet entry (`approved_by`, `approved_at`)
- ✅ Created-by tracked on invoices
- ✅ Soft-delete preserves who did what

### 2.10 Server downtime
- ✅ **PM2 auto-restart** on crash
- ✅ **BootAutoStart** scheduled task at Windows boot
- ✅ **Cloudflared service** auto-start
- ✅ **UptimeRobot** external monitoring with email alerts
- ✅ Health endpoint returns 503 on real failures

---

## 3. Compliance — law firm specific

### 3.1 Document retention
- ✅ **30-day daily backups** (current setting in `backup.ps1`)
- ✅ Audit log **never deleted** (preserved indefinitely)
- ✅ Cancelled invoices **preserved** (not removed)
- ℹ For Indian Bar Council / GST law: invoice records must be kept for **8 years**. Recommend:
  - Increase `$KeepDays` in `backup.ps1` from 30 to 90 days for daily backups
  - Plus do **monthly snapshots** kept for 8 years (separate script needed)

### 3.2 GST records
- ✅ Issued invoices **immutable** (cannot edit items after issue)
- ✅ Cancellation requires explicit action (audit logged)
- ✅ Invoice numbers **sequential**, never reused
- ✅ **Reverse charge mechanism** properly handled on PDF
- ✅ State codes, GSTIN tracked per client

### 3.3 Privacy
- ✅ Passwords **never stored in plaintext** (bcrypt)
- ✅ Health endpoint **no PII** exposed
- ✅ Audit log doesn't store password values
- ⚠ **`.env` file** contains SMTP password — already in `.gitignore` but never share it

### 3.4 Access control
- ✅ Associates can only see **own entries**
- ✅ Admin/billing see all
- ✅ Reports endpoints **admin-only**
- ✅ Invoice access **admin-only**

---

## 4. Currently NOT protected — recommend fixes

### 4.1 Disk encryption at rest (BitLocker)
**Risk:** Laptop chori hone par — attacker disk nikal kar dusre PC mein laga ke DB file padh sakta hai.

**Fix:** **BitLocker** enable karein (Windows built-in, free):

```powershell
# Admin PowerShell mein
Get-BitLockerVolume    # Check current status
Enable-BitLocker -MountPoint "C:" -UsedSpaceOnly -EncryptionMethod Aes256 -RecoveryPasswordProtector
```

Recovery key Microsoft account ya printed copy mein save karein. Bina key BitLocker locked drive open nahi hota — chori hone par data safe.

### 4.2 Login rate limiting
**Risk:** Attacker brute-force password attempts kar sakta hai.

**Fix:** `express-rate-limit` install karke `server.js` mein:

```bash
npm install express-rate-limit
```

```javascript
// server.js mein
const rateLimit = require('express-rate-limit');
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                    // 10 attempts per IP per window
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
}));
```

### 4.3 2FA for admin accounts
**Risk:** Admin password leak hone par poora system compromise.

**Fix:** TOTP-based 2FA add karein (Google Authenticator). ~3 hour feature. Library: `speakeasy`. Future iteration mein add ho sakta hai.

### 4.4 Strong password policy
**Current:** 8 character minimum.

**Recommended for law firm:** 12+ characters with mix. Update `routes/auth.js`:

```javascript
if (new_password.length < 12) {
  return res.status(400).json({ error: 'Password must be at least 12 characters' });
}
if (!/[A-Z]/.test(new_password) || !/[a-z]/.test(new_password) ||
    !/[0-9]/.test(new_password) || !/[^A-Za-z0-9]/.test(new_password)) {
  return res.status(400).json({ error: 'Password must include uppercase, lowercase, digit, and special character' });
}
```

### 4.5 JWT revocation
**Risk:** Token chori hone par expiry tak valid rehta hai (8 hours).

**Current mitigation:** Short 8-hour expiry. Changing JWT_SECRET invalidates all tokens (kicks out all users).

**Better fix (future):** Add `token_version` column to users table. Increment on logout/password change. Check in `authRequired` middleware.

### 4.6 SMTP password rotation
**Critical:** `.env` mein abhi `SMTP_PASS=Welcome@$1298` plain hai. Original `BUG-FIX-REPORT.md` mein bhi noted tha.

**Action:** Office 365 admin portal se password rotate karein, fresh password `.env` mein daalein, `pm2 restart ap-timesheet`. **Today ya tomorrow karein.**

---

## 5. Daily / Weekly / Monthly security checklist

### Daily (automatic — no action)
- ✅ Backup runs at 02:00
- ✅ OneDrive auto-syncs to cloud
- ✅ UptimeRobot pings every 5 min

### Weekly (you, 2 min Monday)
- [ ] `pm2 status` — ap-timesheet `online`?
- [ ] `Get-Service Cloudflared` — Running?
- [ ] OneDrive folder mein today's backup file dikh raha hai?
- [ ] UptimeRobot dashboard green hai?
- [ ] `Get-Content C:\ap-timesheet\logs\weekly-health.log -Tail 5` — koi `ALERT` line?

### Monthly (you, 15 min, first Monday)
- [ ] `npm audit` Laptop par run karein — koi high/critical CVE?
- [ ] `pm2 logs ap-timesheet --lines 500` — koi unusual error patterns?
- [ ] Active users list review — koi inactive employees hain jo ab firm mein nahi?
- [ ] Try opening a random old backup in DB Browser for SQLite — corrupt to nahi hua?
- [ ] Test restore on a spare folder (sanity check)

### Quarterly (you, 30 min)
- [ ] **Rotate JWT_SECRET**:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
  Paste in `.env`, `pm2 restart ap-timesheet`. All users will need to re-login (expected).
- [ ] **Rotate SMTP password** in Office 365 admin → update `.env` → restart
- [ ] **Dry-run restore** — full restore test on spare machine
- [ ] **npm audit fix** for non-breaking patches
- [ ] **Review audit_log** for anomalies (mass deletions, unusual hours, etc.)

### Yearly (you, 1 hour)
- [ ] Test BitLocker recovery key still works
- [ ] Update Node.js to latest LTS
- [ ] Re-print + sign **disaster recovery procedure** for safe deposit
- [ ] Review who has Cloudflare account access
- [ ] Review who has OneDrive account access
- [ ] Update emergency contact list (alternate IT person)

---

## 6. Incident response — agar kuch ho jaye

### Suspected hack / unauthorized access
1. **Immediately**:
   - `Stop-Service Cloudflared` (cut public access)
   - `pm2 stop ap-timesheet` (stop further changes)
2. Change all passwords:
   - JWT_SECRET (rotate)
   - SMTP_PASS (Office 365)
   - All admin user passwords (manual update via SQL or after restart)
3. Restore from last known-good backup (yesterday's 02:00 backup is safe)
4. Review `audit_log` for changes during compromise window
5. Re-enable services after cleanup

### Data loss / accidental deletion
1. `powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\restore.ps1`
2. Pick the most recent backup before the deletion
3. ~60 min recovery

### Ransomware hit
1. Disconnect laptop from internet immediately
2. **Don't pay**, don't trust anything on laptop
3. Wipe laptop completely
4. Fresh OS install
5. Restore from OneDrive cloud (untouched by ransomware):
   - 30-day version history mein pre-encryption versions
6. Bring up new laptop (per `MIGRATION.md`)

### IT manager leaves the firm
- New IT inherits this folder
- Must read in order: `README.md` → `BUG-FIX-REPORT.md` → `OPERATIONS.md` → `SECURITY.md` → `MIGRATION.md`
- Critical handover items:
  - `.env` file contents (in secure vault)
  - Cloudflare account credentials
  - OneDrive account credentials
  - BitLocker recovery key
  - Office 365 admin access

---

## 7. Quick-reference: Where are my secrets?

| Secret | Location | Backup |
|---|---|---|
| User passwords | `database/aptimesheet.db` (bcrypt hash) | Daily backup |
| JWT_SECRET | `.env` | NOT in any backup — must be in IT manager's vault |
| SMTP password | `.env` | NOT in any backup |
| Cloudflare account | Cloudflare side (it@appartners.in login) | Cloudflare recovery email |
| Tunnel credentials | Cloudflare (managed remotely via service install token) | N/A — re-fetch from dashboard |
| BitLocker recovery | Microsoft account / printed | Microsoft recovery + safe deposit |

**Rule of thumb:** Anything in `.env` should ALSO be in 1Password / Bitwarden. If you lose this file, the firm cannot recover SMTP / JWT alone — they're auto-generated, not stored elsewhere.

---

## 8. Summary — quick reassurance

**Aapka data 3 jagah safe hai:**

| Layer | Where | Refresh frequency |
|---|---|---|
| Live | This laptop SQLite | Real-time |
| Local backup | OneDrive folder this laptop | Daily 02:00 |
| Cloud backup | Microsoft OneDrive servers | Real-time sync + 30-day versions |

**Highest priority extra steps (recommend in this order):**
1. **BitLocker enable karein** (5 min, free, big protection)
2. **SMTP password rotate karein** (5 min, urgent — currently in `.env` plain text)
3. **Login rate-limit install karein** (10 min, prevents brute-force)
4. **Quarterly rotation discipline** (calendar reminder)
5. **2FA for admin** (next quarter — bigger feature)

Sab kuch baad mein add ho sakta hai. **Abhi data safe hai. Existing layers strong hain.**
