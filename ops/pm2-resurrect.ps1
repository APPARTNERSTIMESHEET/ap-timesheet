# ─── PM2 resurrect on boot ─────────────────────────────────────────────────────
# Triggered by Task Scheduler at boot. Calls `pm2 resurrect` to re-spawn the
# saved process list. Logs every attempt for troubleshooting.
# ────────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Continue'
$AppRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $AppRoot 'logs\resurrect.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Log($msg) {
    "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Add-Content -Path $LogPath
}

# Wait up to 60s for network/disk to settle after boot
Start-Sleep -Seconds 15

$pm2 = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $pm2) {
    Log 'ERROR: pm2 not in PATH for SYSTEM account — install with `npm install -g pm2` and ensure global npm bin is on system PATH'
    exit 1
}

Log "Boot detected — running pm2 resurrect"
Push-Location $AppRoot
& $pm2 resurrect 2>&1 | ForEach-Object { Log $_ }
$rc = $LASTEXITCODE
Pop-Location

# Belt-and-suspenders: if resurrect didn't bring our app up, start it explicitly
Start-Sleep -Seconds 5
$desc = & $pm2 describe ap-timesheet 2>$null
if ($LASTEXITCODE -ne 0) {
    Log "ap-timesheet not present after resurrect — running pm2 start ecosystem.config.js"
    Push-Location $AppRoot
    & $pm2 start (Join-Path $AppRoot 'ecosystem.config.js') 2>&1 | ForEach-Object { Log $_ }
    & $pm2 save 2>&1 | ForEach-Object { Log $_ }
    Pop-Location
}

Log "Done (exit $rc)"
exit 0
