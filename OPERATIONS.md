# AP & Partners Timesheet — Lifetime Operations Guide

**Goal:** Server saalon tak bina downtime / data-loss ke chalta rahe.

This doc covers: **hosting choice → install → daily/weekly/monthly schedule → disaster recovery → common problems**.

Pair with `BUG-FIX-REPORT.md` (one-time security & code fixes) and `README.md` (developer setup).

---

## 1. Hosting recommendation

A small law firm with ~10–30 daily users has **three sensible options**. I'd pick **Option B (Cloudflare Tunnel + office PC)** as the best balance of cost, simplicity, and reliability for AP & Partners specifically — but the trade-offs are summarized first.

| Option | Cost / month | Uptime SLA | Maintenance | Best for |
|---|---|---|---|---|
| **A. Office PC + LAN only** | ₹0 | ~95% (depends on power, AC, person) | Lowest | LAN-only, no remote work |
| **B. Office PC + Cloudflare Tunnel** ★ recommended | ₹0 | ~98% | Low | Small firm, you control hardware |
| **C. Cloud VPS (Hetzner / Contabo / DO)** | ₹450–₹1,200 | 99.9% | Medium | Remote-first team, multi-office |
| D. Render.com / Railway (managed) | ₹2,000+ (paid plan needed for SQLite persistence) | 99.9% | Lowest | If nobody on staff is technical |

### Why I recommend Option B for AP & Partners

- **Same physical security as your file cabinets** — DB lives on your office machine, not a foreign server.
- **Cloudflare Tunnel is free, no port forwarding, auto-HTTPS** — you get a public URL like `https://timesheet.appartners.in` without exposing your office IP. Setup is one command.
- **You already have `start-timesheet.bat` + PM2 + ecosystem.config.js** — infrastructure exists.
- **Backups go offsite via rclone → Google Drive / OneDrive** (you already have an Office 365 account → 1 TB free).
- **Total cost: ₹0/month** beyond what you already pay.

The two real failure modes of Option B are (1) office power outage and (2) the office PC dies. **Both are mitigated by**: (a) a small UPS for the server PC (~₹3000), (b) the daily cloud backup, and (c) keeping a second laptop ready that can `git pull` + `npm install` + restore the latest backup.

If at any point you grow past ~50 daily users or open a second office, migrate to Option C — the code is identical, only the server moves.

### Cloudflare Tunnel — 3-step setup

```powershell
# 1. Install
winget install Cloudflare.cloudflared

# 2. Login (opens browser)
cloudflared tunnel login

# 3. Create + run
cloudflared tunnel create ap-timesheet
cloudflared tunnel route dns ap-timesheet timesheet.appartners.in
cloudflared tunnel run --url http://localhost:3000 ap-timesheet
```

Then install it as a Windows service so it boots automatically:
```powershell
cloudflared service install
```

Done — `https://timesheet.appartners.in` now points to your office PC, with HTTPS + DDoS protection from Cloudflare's edge.

---

## 2. One-time install (do this once after the bug fixes)

Order matters. Run each step as **Administrator** PowerShell.

```powershell
# 0. Make sure dependencies are fresh
cd C:\ap-timesheet
npm install
npm install -g pm2 pm2-windows-startup

# 1. Install pm2-windows-startup so PM2 restarts after Windows reboot
pm2-startup install

# 2. Start the app and save the PM2 process list
pm2 start ecosystem.config.js
pm2 save

# 3. Verify it's running
pm2 status
curl http://localhost:3000/api/health

# 4. Install all four scheduled tasks (boot resurrect, daily backup, cloud sync, weekly health)
powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\install-tasks.ps1

# 5. (Optional but recommended) Set up offsite backup
winget install Rclone.Rclone
rclone config         # follow prompts, name the remote "backup"
                      # OneDrive recommended since you already have Office 365

# 6. (Optional) Cloudflare Tunnel — see section 1 above

# 7. Sign up for free uptime monitoring at https://uptimerobot.com
#    Add a monitor for https://timesheet.appartners.in/api/health (HTTP-S, 5-min interval)
#    Configure email + SMS alerts to it@appartners.in / +91-9911503786
```

After step 4 you should see four tasks under `\AP-Timesheet\` in Task Scheduler:

```powershell
Get-ScheduledTask -TaskPath '\AP-Timesheet\*' | Format-Table TaskName, State, NextRunTime
```

---

## 3. Maintenance schedule

**Hands-off — these all run automatically once installed.** The columns labelled "you" are things a human still needs to do.

### Daily (automatic)
| Time  | What | Script |
|---|---|---|
| 02:00 | DB hot-backup + uploads zip + 30-day rotation + integrity check | `ops\backup.ps1` |
| 02:30 | Push backups to cloud, prune cloud copies > 90 days | `ops\backup-to-cloud.ps1` |

### Weekly (automatic)
| Time  | What | Script |
|---|---|---|
| Sun 03:00 | `integrity_check`, `wal_checkpoint(TRUNCATE)`, `PRAGMA optimize`, `npm audit`, log trim | `ops\weekly-health.ps1` |

### Weekly (you — 2 minutes Monday morning)
- Open `C:\ap-timesheet\logs\weekly-health.log` and skim last entry. Anything that says **ALERT** needs action.
- Open Task Scheduler → `\AP-Timesheet\` → confirm all 4 tasks show **Last Run Result = 0x0**.
- Open https://uptimerobot.com → confirm uptime > 99% for the week.

### Monthly (you — 15 minutes, first Monday)
- `pm2 logs ap-timesheet --lines 500` → look for repeated errors.
- Run `npm audit` → if any **high/critical** CVEs, plan an upgrade window.
- Check `C:\ap-timesheet\backups` size: should be ~30 daily DB files + ~30 zips. Rotation working?
- Open the latest backup file in DB Browser for SQLite to confirm it actually opens (sanity check).
- **Dry-run a restore** every quarter — see Disaster Recovery below. Backups you don't test will fail when you need them.

### Quarterly (you — 30 minutes)
- **Rotate JWT_SECRET** (generate a new random one, paste into `.env`, restart). Forces re-login of all users — ok since they're internal.
- **Rotate SMTP password** in Office 365 admin → update `.env` → restart.
- **Update Node.js** to latest LTS. Run `npm install` after.
- **Test restore** from a 30-day-old backup on a spare machine.

### Yearly (you — 1 hour)
- Audit user list — disable anyone who left the firm (`PATCH /api/users/:id { is_active: 0 }`).
- Review GST rate constant if changed.
- Cloudflare Tunnel certificate rotation (it's automatic but worth verifying).

---

## 4. Monitoring — what fires alerts

You'll get **two channels** of alerts:

### A. UptimeRobot (free, every 5 min from the internet)
Hits `https://timesheet.appartners.in/api/health`. The endpoint now returns:

```json
{
  "ok": true,
  "uptime_seconds": 84210,
  "checks": {
    "db":               { "ok": true, "ms": 2 },
    "disk_free_gb":     128.4,
    "last_backup_hours": 7.2,
    "last_backup_file": "aptimesheet-20260511-020001.db"
  }
}
```

Returns **HTTP 503** instead of 200 if **any** of: DB query fails, disk free < 1 GB, last backup > 36 hours old. UptimeRobot then emails / SMSes you. No 503 means everything's actually working — not just "the process is up".

### B. Local logs (`logs\backup.log`, `logs\weekly-health.log`)
Backup failures and integrity-check failures get written here. You skim these weekly. If you want active alerting, point a second UptimeRobot heartbeat URL (or [healthchecks.io](https://healthchecks.io/) — also free) at the end of `backup.ps1`:

```powershell
# Add to the end of ops\backup.ps1, just before exit 0:
Invoke-WebRequest -Uri 'https://hc-ping.com/YOUR-UUID-HERE' -UseBasicParsing | Out-Null
```

If healthchecks.io doesn't get a ping by 03:00, it emails you — guaranteed alert even if the backup script fails to even start.

---

## 5. Disaster recovery

**Test this once a quarter.** Untested backups are not backups.

### Scenario 1 — DB corruption (integrity_check failed)
1. Stop the app: `pm2 stop ap-timesheet`
2. Run `powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\restore.ps1`
3. Pick the most recent backup → type `YES` → it stops PM2, swaps the DB, restarts.
4. Login at http://localhost:3000, verify recent entries are intact.

### Scenario 2 — Whole machine died
1. New machine: install Node 18+ LTS, Git, PM2.
2. `git clone <your repo> C:\ap-timesheet`
3. `cd C:\ap-timesheet && npm install`
4. Copy latest `.env` from password manager / 1Password / etc.
5. Pull latest backup from cloud:
   ```powershell
   rclone copy backup:ap-timesheet C:\ap-timesheet\backups\ --include "aptimesheet-*.db" --max-age 36h
   ```
6. Run restore script — same as Scenario 1.
7. Re-install scheduled tasks: `ops\install-tasks.ps1`.
8. Reconfigure Cloudflare Tunnel: `cloudflared tunnel run ap-timesheet`.

**Target recovery time: 60 minutes** if you've practiced it.

### Scenario 3 — Ransomware encrypted everything
Cloud backups in OneDrive have **30-day version history** — restore the day-before-encryption version of the entire `ap-timesheet` folder from OneDrive web UI. Then proceed as Scenario 2.

This is why offsite cloud backup is non-negotiable.

---

## 6. Common problems — quick fixes

| Symptom | Probable cause | Fix |
|---|---|---|
| App returns 502 / "PM2 says stopped" | Out-of-memory restart or Node crash | `pm2 logs ap-timesheet --err --lines 100` → fix root cause. PM2 will auto-restart up to 50 times. |
| Login throws 500 | `.env` corrupted / `JWT_SECRET` removed | Check `.env` exists and has all required keys. Restart. |
| PDFs slow / timeout | DB locked by long backup OR disk full | Check `logs\backup.log`. Make sure free disk > 5 GB. |
| Email "503 SMTP not configured" | `.env` SMTP vars missing | Restore from `.env.example`, fill in `SMTP_PASS`. |
| Daily backup task shows red in Task Scheduler | `node` not in SYSTEM PATH | Re-install Node with "Add to PATH for all users" checked. |
| `pm2 resurrect` does nothing on boot | Forgot to `pm2 save` after first start | `pm2 start ecosystem.config.js && pm2 save` once. |
| `last_backup_hours` keeps climbing | Daily backup task disabled / failing | Check Task Scheduler history; rerun `install-tasks.ps1` if needed. |
| User can't login but admin can | User `is_active = 0` | Admin → Users → reactivate. |
| Invoice shows wrong total after rate change | (Already fixed by `effective_from` filter) | If pre-fix invoices look wrong, regenerate after fix is deployed. |

---

## 7. What changes break "lifetime" stability — avoid these

- **Don't run `npm update` blindly.** Use `npm audit fix` for security patches; do major version bumps in a planned window with a backup taken first.
- **Don't edit `.env` while the server is running** — env vars are read once at boot. Always restart after.
- **Don't put the DB on a network drive / NAS / SMB share.** SQLite locking is unreliable over network filesystems. Local SSD only.
- **Don't disable WAL mode.** It's the reason readers don't block writers.
- **Don't run two `node server.js` processes against the same DB file** — use PM2 with `instances: 1` (already configured in `ecosystem.config.js`).
- **Don't grow `uploads/` past ~10 GB on the same disk as the DB.** Move to a separate disk if it gets large; symlink works fine.
- **Don't skip backups during "busy weeks".** That's exactly when corruption happens.

---

## 8. Files in `ops\`

| Script | What it does |
|---|---|
| `backup.ps1` | Daily local backup (DB + uploads), 30-day rotation, integrity verify |
| `backup-to-cloud.ps1` | Push local backups to rclone remote, 90-day cloud retention |
| `restore.ps1` | Interactive restore from any backup with safety prompts |
| `weekly-health.ps1` | Sunday: integrity check, WAL checkpoint, npm audit, log trim |
| `pm2-resurrect.ps1` | At boot: re-spawn ap-timesheet via PM2 |
| `install-tasks.ps1` | One-time: register all 4 scheduled tasks |
| `uninstall-tasks.ps1` | Remove all scheduled tasks (reverse of install) |

All are PowerShell, all are idempotent (safe to re-run), all log to `logs\`.

---

## 9. Contact / handover

If `it@appartners.in` ever leaves the firm, the next IT person needs:

1. **Read** `README.md`, `BUG-FIX-REPORT.md`, this file (`OPERATIONS.md`), in that order.
2. **Access to**: the office PC, the `.env` file (in 1Password / shared password manager), the OneDrive account holding cloud backups, the Cloudflare account, the UptimeRobot account.
3. **Test the restore procedure** in the first week, before anything else.

That's it. Once steps 1–4 of section 2 are done, the system runs itself.
