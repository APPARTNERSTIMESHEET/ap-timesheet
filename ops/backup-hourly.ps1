# === AP & Partners Timesheet -- Hourly Backup =================================
# Lightweight snapshot of the SQLite DB, taken every hour. Designed for fast
# point-in-time recovery: if data is lost at 3:47 PM, the 3:00 PM hourly
# snapshot is at most 47 minutes stale (vs 23 hours for the daily backup).
#
# Differences from daily backup:
#   - DB only (no uploads zip) -- runs in seconds, no business-hours impact
#   - 24-snapshot rotation (1 day rolling window) -- daily backup keeps 30 days
#   - Saves to OneDrive\AP-Timesheet-Backups\hourly\ (separate folder)
#   - Records integrity_check result + row counts into integrity-log.json
#     so the Super Admin "System" tab can show "Last verified: HH:MM ago".
#
# Schedule with Windows Task Scheduler -- see ops\install-tasks.ps1
# Run manually:
#   powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\backup-hourly.ps1
# ==============================================================================

$ErrorActionPreference = 'Stop'
$AppRoot   = Split-Path -Parent $PSScriptRoot
$DbPath    = Join-Path $AppRoot 'database\aptimesheet.db'

# Backups land inside the OneDrive auto-synced folder when available.
$RootBackup = if ($env:AP_BACKUP_DIR) {
    $env:AP_BACKUP_DIR
} elseif ($env:OneDrive -and (Test-Path $env:OneDrive)) {
    Join-Path $env:OneDrive 'AP-Timesheet-Backups'
} else {
    Join-Path $AppRoot 'backups'
}
$BackupDir = Join-Path $RootBackup 'hourly'
$LogPath   = Join-Path $AppRoot 'logs\backup-hourly.log'
$IntegrityLog = Join-Path $RootBackup 'integrity-log.json'

# Rolling window: keep latest 24 hourly snapshots. Older ones auto-purge.
$KeepCount = 24

New-Item -ItemType Directory -Force -Path $BackupDir, (Split-Path $LogPath) | Out-Null

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

# Read previous integrity log entries (if any) so we keep a history.
function Read-IntegrityLog {
    if (-not (Test-Path $IntegrityLog)) { return @() }
    try {
        $raw = Get-Content $IntegrityLog -Raw -ErrorAction Stop
        if (-not $raw) { return @() }
        $parsed = $raw | ConvertFrom-Json
        # Always return an array, even with one entry
        if ($null -eq $parsed) { return @() }
        if ($parsed -is [array]) { return $parsed }
        return @($parsed)
    } catch { return @() }
}

# Persist integrity-log.json -- keep last 200 entries (about 8 days of hourly runs).
# IMPORTANT: write without BOM + retry loop with file lock awareness. Both the
# daily and hourly backup processes can race for this file when their schedules
# align (e.g., both at 11:01). Retry up to 10 times with 200ms backoff.
function Write-IntegrityLog {
    param($entries)
    $trimmed = @($entries | Select-Object -Last 200)
    $json = ConvertTo-Json -InputObject $trimmed -Depth 4
    if ($trimmed.Count -eq 1 -and -not $json.TrimStart().StartsWith('[')) {
        $json = "[$json]"
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    # Write to a temp file first, then atomically rename. This eliminates the
    # race condition entirely -- the rename is atomic on NTFS.
    $tmpFile = "$IntegrityLog.tmp.$PID"
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            [System.IO.File]::WriteAllText($tmpFile, $json, $utf8NoBom)
            # Move with overwrite -- atomic on NTFS
            [System.IO.File]::Move($tmpFile, $IntegrityLog, $true)
            return
        } catch {
            if ($attempt -eq 10) {
                Log "WARN: Could not write integrity log after 10 attempts: $($_.Exception.Message)"
                if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
                return
            }
            Start-Sleep -Milliseconds 200
        }
    }
}

try {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dbOut = Join-Path $BackupDir "aptimesheet-hourly-$stamp.db"

    Log "--- Hourly backup started ---"

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node.exe not found in PATH" }

    # 1. SQLite hot backup using better-sqlite3's backup() API.
    $dbPathJs = $DbPath -replace '\\','\\\\'
    $dbOutJs  = $dbOut  -replace '\\','\\\\'
    $script = @"
const Database = require('better-sqlite3');
const db = new Database('$dbPathJs', { readonly: true });
db.backup('$dbOutJs')
  .then(() => { db.close(); process.exit(0); })
  .catch(e  => { console.error(e); process.exit(1); });
"@
    Push-Location $AppRoot
    & $node -e $script
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "DB backup failed (exit $LASTEXITCODE)" }
    Pop-Location
    $sizeKb = [math]::Round((Get-Item $dbOut).Length / 1KB, 1)
    Log "DB snapshot: $dbOut ($sizeKb KB)"

    # 2. Integrity check + row counts on the backup copy.
    $checkScript = @"
const Database = require('better-sqlite3');
const db = new Database('$dbOutJs', { readonly: true });
const integrity = db.pragma('integrity_check', { simple: true });
const fk = db.pragma('foreign_key_check');
const counts = {};
for (const tbl of ['users','clients','matters','timesheet_entries','invoices','invoice_items','leave_applications','audit_log']) {
  try { counts[tbl] = db.prepare('SELECT COUNT(*) AS c FROM ' + tbl).get().c; } catch(_) { counts[tbl] = null; }
}
console.log(JSON.stringify({ integrity, fk_violations: fk.length, counts }));
"@
    Push-Location $AppRoot
    $checkResult = & $node -e $checkScript
    Pop-Location

    $parsed = $checkResult | ConvertFrom-Json
    $integrityOk = ($parsed.integrity -eq 'ok' -and $parsed.fk_violations -eq 0)
    if ($integrityOk) {
        Log "Integrity OK -- users=$($parsed.counts.users) invoices=$($parsed.counts.invoices) timesheet=$($parsed.counts.timesheet_entries)"
    } else {
        Log "INTEGRITY FAIL: integrity=$($parsed.integrity) fk_violations=$($parsed.fk_violations)"
    }

    # 3. Append result to integrity-log.json (last 200 entries kept).
    $history = Read-IntegrityLog
    $entry = [PSCustomObject]@{
        timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        type = 'hourly'
        file = (Split-Path $dbOut -Leaf)
        size_kb = $sizeKb
        integrity = $parsed.integrity
        fk_violations = $parsed.fk_violations
        ok = $integrityOk
        counts = $parsed.counts
    }
    $history = @($history) + @($entry)
    Write-IntegrityLog -entries $history

    if (-not $integrityOk) {
        throw "Integrity check FAILED on hourly backup -- possible DB corruption"
    }

    # 4. Rotate: keep only the latest N hourly snapshots.
    $allHourly = Get-ChildItem -Path $BackupDir -File -Filter 'aptimesheet-hourly-*.db' | Sort-Object LastWriteTime -Descending
    if ($allHourly.Count -gt $KeepCount) {
        $toDelete = $allHourly | Select-Object -Skip $KeepCount
        foreach ($f in $toDelete) {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        }
        Log "Rotation: kept latest $KeepCount, removed $($toDelete.Count) older snapshot(s)"
    }

    Log "--- Hourly backup OK ---`r`n"
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"

    # Even on failure, record the error in integrity log so System tab shows it.
    $history = Read-IntegrityLog
    $entry = [PSCustomObject]@{
        timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        type = 'hourly'
        ok = $false
        error = $_.Exception.Message
    }
    $history = @($history) + @($entry)
    try { Write-IntegrityLog -entries $history } catch {}

    Log "--- Hourly backup FAILED ---`r`n"
    exit 1
}
