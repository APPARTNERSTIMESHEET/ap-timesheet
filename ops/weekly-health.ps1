# ─── Weekly health check ───────────────────────────────────────────────────────
# Runs every Sunday at 03:00. Does 4 things:
#   1. SQLite integrity_check on the live DB (read-only, safe)
#   2. PRAGMA optimize  + WAL checkpoint (keeps the WAL file from growing forever)
#   3. npm audit         (logs any new high/critical CVEs)
#   4. Trims old PM2/app log files (>30 days)
#
# Writes a summary line to logs\weekly-health.log. No emails — wire UptimeRobot
# to /api/health to get pinged on real outages.
# ────────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Continue'
$AppRoot = Split-Path -Parent $PSScriptRoot
$DbPath  = Join-Path $AppRoot 'database\aptimesheet.db'
$LogPath = Join-Path $AppRoot 'logs\weekly-health.log'
$LogsDir = Join-Path $AppRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    $line | Add-Content -Path $LogPath
    Write-Host $line
}

Log "─── Weekly health started ───"

# ── 1. integrity_check ─────────────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    $dbJs = $DbPath -replace '\\','\\\\'
    $script = @"
const Database = require('better-sqlite3');
const db = new Database('$dbJs', { readonly: true });
const r1 = db.pragma('integrity_check', { simple: true });
const r2 = db.pragma('foreign_key_check', { simple: false });
const fkBroken = Array.isArray(r2) ? r2.length : 0;
console.log('integrity_check=' + r1 + ' fk_violations=' + fkBroken);
process.exit(r1 === 'ok' && fkBroken === 0 ? 0 : 2);
"@
    Push-Location $AppRoot
    $out = & $node -e $script 2>&1
    $rc  = $LASTEXITCODE
    Pop-Location
    Log "DB check: $out"
    if ($rc -ne 0) { Log "ALERT: DB problem detected — restore from latest backup ASAP" }
} else {
    Log "WARN: node not in PATH — skipped DB check"
}

# ── 2. WAL checkpoint + optimize (compacts the wal file) ──────────────────────
if ($node) {
    $dbJs = $DbPath -replace '\\','\\\\'
    $script = @"
const Database = require('better-sqlite3');
const db = new Database('$dbJs');
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('optimize');
db.close();
console.log('checkpoint+optimize done');
"@
    Push-Location $AppRoot
    $out = & $node -e $script 2>&1
    Pop-Location
    Log "DB maintenance: $out"
}

# ── 3. npm audit ──────────────────────────────────────────────────────────────
Push-Location $AppRoot
$audit = & npm audit --omit=dev --audit-level=high --json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
Pop-Location
if ($audit -and $audit.metadata) {
    $high = $audit.metadata.vulnerabilities.high     + $audit.metadata.vulnerabilities.critical
    Log "npm audit: $high high/critical vulnerabilities (run 'npm audit' for details, 'npm audit fix' to patch)"
} else {
    Log "npm audit: skipped (npm not in PATH or no advisories)"
}

# ── 4. Log rotation — gzip + remove >30 day logs ──────────────────────────────
$cutoff = (Get-Date).AddDays(-30)
$removed = 0
Get-ChildItem -Path $LogsDir -File -Recurse -Include *.log | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
    Remove-Item $_.FullName -Force; $removed++
}
Log "Rotated $removed old log file(s) (>30 days)"

# ── 5. Disk space check ────────────────────────────────────────────────────────
$drive = (Get-Item $AppRoot).PSDrive
$freeGB = [math]::Round($drive.Free / 1GB, 2)
Log "Free space on $($drive.Name): ${freeGB} GB"
if ($freeGB -lt 5) { Log "ALERT: Less than 5 GB free — backups will start failing" }

Log "─── Weekly health done ───`r`n"
