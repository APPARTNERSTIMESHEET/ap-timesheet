# === AP & Partners Timesheet -- Restore from backup ===========================
# Use this when:
#   - DB corruption (integrity_check failed)
#   - Accidental data deletion
#   - Hardware failure / new machine setup
#
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\restore.ps1
#
# Lists available backups, asks which to restore, stops PM2, swaps the DB,
# restarts PM2. The previous live DB is preserved as .before-restore-<stamp>
# so you can roll back if the restore was the wrong choice.
# ==============================================================================

$ErrorActionPreference = 'Stop'
$AppRoot   = Split-Path -Parent $PSScriptRoot
$DbPath    = Join-Path $AppRoot 'database\aptimesheet.db'
$BackupDir = Join-Path $AppRoot 'backups'

if (-not (Test-Path $BackupDir)) { Write-Error "No backups folder at $BackupDir"; exit 1 }

# List available DB backups (newest first)
$dbBackups = Get-ChildItem -Path $BackupDir -Filter 'aptimesheet-*.db' | Sort-Object LastWriteTime -Descending
if (-not $dbBackups) { Write-Error "No DB backups found in $BackupDir"; exit 1 }

Write-Host ""
Write-Host "--- Available DB backups (newest first) ---" -ForegroundColor Cyan
for ($i = 0; $i -lt $dbBackups.Count; $i++) {
    $b = $dbBackups[$i]
    $age  = ((Get-Date) - $b.LastWriteTime).TotalDays
    $sizeMB = [math]::Round($b.Length / 1MB, 2)
    Write-Host ("  [{0}]  {1}   ({2:N1} days old, {3} MB)" -f $i, $b.Name, $age, $sizeMB)
}
Write-Host ""

$choice = Read-Host "Which backup # to restore? (Ctrl+C to cancel)"
if (-not ($choice -match '^\d+$') -or [int]$choice -ge $dbBackups.Count) {
    Write-Error "Invalid selection"
    exit 1
}
$selected = $dbBackups[[int]$choice]

Write-Host ""
Write-Host ("About to restore: " + $selected.Name) -ForegroundColor Yellow
Write-Host ("Current live DB will be moved to: " + $DbPath + ".before-restore-<timestamp>") -ForegroundColor Yellow
$confirm = Read-Host "Type YES to proceed"
if ($confirm -ne 'YES') { Write-Host "Cancelled."; exit 0 }

# 1. Stop PM2 process so no one writes during restore
Write-Host "Stopping ap-timesheet..."
& pm2 stop ap-timesheet 2>$null

Start-Sleep -Seconds 2

# 2. Move current DB out of the way
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safeName  = "$DbPath.before-restore-$timestamp"
if (Test-Path $DbPath) {
    Move-Item -Path $DbPath -Destination $safeName -Force
    if (Test-Path "$DbPath-wal") { Move-Item -Path "$DbPath-wal" -Destination "$safeName-wal" -Force }
    if (Test-Path "$DbPath-shm") { Move-Item -Path "$DbPath-shm" -Destination "$safeName-shm" -Force }
    Write-Host ("Live DB moved to: " + $safeName) -ForegroundColor Green
}

# 3. Copy backup into place
Copy-Item -Path $selected.FullName -Destination $DbPath -Force
Write-Host ("Restored: " + $selected.Name + " -> " + $DbPath) -ForegroundColor Green

# 4. Restart PM2
Write-Host "Starting ap-timesheet..."
Push-Location $AppRoot
& pm2 start ecosystem.config.js
Pop-Location

Write-Host ""
Write-Host "--- Restore complete ---" -ForegroundColor Green
Write-Host "Verify by logging in at http://localhost:3000 and checking recent entries."
Write-Host ("If anything is wrong, the previous DB is at: " + $safeName)
