# === AP & Partners Timesheet -- Daily Backup ==================================
# Safely backs up the SQLite DB (using .backup() so WAL-mode + writers don't
# break it), zips the uploads/ folder, runs an integrity check, and rotates
# old copies.
#
# Schedule with Windows Task Scheduler -- see ops\install-tasks.ps1
# Run manually:
#   powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\backup.ps1
# ==============================================================================

$ErrorActionPreference = 'Stop'
$AppRoot   = Split-Path -Parent $PSScriptRoot              # e.g. C:\ap-timesheet
$DbPath    = Join-Path $AppRoot 'database\aptimesheet.db'
$UpDir     = Join-Path $AppRoot 'uploads'
# Backups land inside OneDrive folder so they auto-sync to the cloud.
# OneDrive desktop client handles the upload + 30-day version history. No rclone
# / no Azure consent needed. Override with $env:AP_BACKUP_DIR if you ever move it.
$BackupDir = if ($env:AP_BACKUP_DIR) {
    $env:AP_BACKUP_DIR
} elseif ($env:OneDrive -and (Test-Path $env:OneDrive)) {
    Join-Path $env:OneDrive 'AP-Timesheet-Backups'
} else {
    Join-Path $AppRoot 'backups'                           # local-only fallback
}
$LogPath   = Join-Path $AppRoot 'logs\backup.log'
$IntegrityLog = Join-Path $BackupDir 'integrity-log.json'  # shared with hourly backup
$KeepDays  = 30                                            # keep last 30 daily backups

# Ensure folders exist
New-Item -ItemType Directory -Force -Path $BackupDir, (Split-Path $LogPath) | Out-Null

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

try {
    $stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dbOut     = Join-Path $BackupDir "aptimesheet-$stamp.db"
    $upOut     = Join-Path $BackupDir "uploads-$stamp.zip"

    Log "--- Backup started ---"

    # 1. SQLite hot backup using better-sqlite3's backup() API (already a dep)
    Log "DB backup -> $dbOut"
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node.exe not found in PATH -- install Node.js or add it to PATH" }

    $dbPathJs = $DbPath  -replace '\\','\\\\'
    $dbOutJs  = $dbOut   -replace '\\','\\\\'
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

    # WAL checkpoint on the LIVE database to keep WAL file from growing
    # unbounded. TRUNCATE mode forces the WAL to be reset after merging into
    # the main DB file. Safe to call concurrently with other readers.
    $checkpointScript = @"
const Database = require('better-sqlite3');
const db = new Database('$dbPathJs');
try {
  const r = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
  console.log('checkpoint:', JSON.stringify(r));
} catch (e) { console.error('checkpoint failed:', e.message); }
db.close();
"@
    Push-Location $AppRoot
    & $node -e $checkpointScript
    Pop-Location
    Log "WAL checkpoint complete"

    # 2. Integrity check on the *backup copy* (not the live DB) + row counts.
    # Result is appended to integrity-log.json which the System tab reads to
    # show "Last verified OK: N minutes ago".
    $integrityScript = @"
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
    $checkOutput = & $node -e $integrityScript
    Pop-Location
    $parsed = $checkOutput | ConvertFrom-Json
    $integrityOk = ($parsed.integrity -eq 'ok' -and $parsed.fk_violations -eq 0)

    # Append to integrity-log.json (shared with hourly backup)
    $history = @()
    if (Test-Path $IntegrityLog) {
        try {
            $raw = Get-Content $IntegrityLog -Raw -ErrorAction Stop
            if ($raw) {
                $p = $raw | ConvertFrom-Json
                if ($p -is [array]) { $history = $p } elseif ($p) { $history = @($p) }
            }
        } catch {}
    }
    $sizeKb = [math]::Round((Get-Item $dbOut).Length / 1KB, 1)
    $entry = [PSCustomObject]@{
        timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        type = 'daily'
        file = (Split-Path $dbOut -Leaf)
        size_kb = $sizeKb
        integrity = $parsed.integrity
        fk_violations = $parsed.fk_violations
        ok = $integrityOk
        counts = $parsed.counts
    }
    $history = @(@($history) + @($entry) | Select-Object -Last 200)
    $json = ConvertTo-Json -InputObject $history -Depth 4
    if ($history.Count -eq 1 -and -not $json.TrimStart().StartsWith('[')) {
        $json = "[$json]"
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    # Atomic write via temp + rename to avoid race with hourly backup.
    $tmpFile = "$IntegrityLog.tmp.$PID"
    $written = $false
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            [System.IO.File]::WriteAllText($tmpFile, $json, $utf8NoBom)
            [System.IO.File]::Move($tmpFile, $IntegrityLog, $true)
            $written = $true
            break
        } catch {
            if ($attempt -eq 10) {
                Log "WARN: Could not write integrity log: $($_.Exception.Message)"
                if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
                break
            }
            Start-Sleep -Milliseconds 200
        }
    }

    if (-not $integrityOk) {
        throw "Integrity check FAILED on backup -- integrity='$($parsed.integrity)' fk_violations=$($parsed.fk_violations)"
    }
    Log "Integrity OK -- users=$($parsed.counts.users) invoices=$($parsed.counts.invoices) timesheet=$($parsed.counts.timesheet_entries)"

    # 3. Uploads folder -- zip it (only if non-empty)
    if (Test-Path $UpDir) {
        $count = (Get-ChildItem $UpDir -File -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
        if ($count -gt 0) {
            Log "Zipping $count upload files -> $upOut"
            Compress-Archive -Path (Join-Path $UpDir '*') -DestinationPath $upOut -CompressionLevel Optimal -Force
        } else {
            Log "uploads/ is empty -- skipping zip"
        }
    }

    # 4. Rotate -- delete backups older than KeepDays
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    $removed = 0
    Get-ChildItem -Path $BackupDir -File | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
        Remove-Item $_.FullName -Force
        $removed++
    }
    Log "Rotated: removed $removed file(s) older than $KeepDays days"

    # 5. Disk space sanity warning
    $drive = (Get-Item $BackupDir).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 2)
    Log "Free space on $($drive.Name): ${freeGB} GB"
    if ($freeGB -lt 5) { Log "WARNING: less than 5 GB free -- backups will start to fail soon" }

    Log "--- Backup OK ---`r`n"
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    Log "--- Backup FAILED ---`r`n"
    exit 1
}
