# deploy.ps1 - Deploy from OneDrive dev folder to C:\ap-timesheet prod
#
# Copies code (NOT database, NOT uploads, NOT .env) from the OneDrive source-of-truth
# folder to C:\ap-timesheet, then triggers a PM2 reload via a one-shot SYSTEM-context
# scheduled task (since the PM2 daemon runs as SYSTEM via pm2-windows-startup).
#
# Run from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\OneDrive - AP Partners\ap-timesheet\ops\deploy.ps1"

$ErrorActionPreference = 'Stop'

$Src = "C:\Users\Admin\Desktop\OneDrive - AP Partners\ap-timesheet"
$Dst = "C:\ap-timesheet"

Write-Host "==> Deploying $Src" -ForegroundColor Cyan
Write-Host "          to $Dst" -ForegroundColor Cyan

if (-not (Test-Path $Dst)) { throw "Production path $Dst not found." }
if (-not (Test-Path $Src)) { throw "Source path $Src not found." }

# Folders to sync (whitelist - anything not listed is left alone in prod)
$codeFolders = @('routes','middleware','utils','public','ops','server-tools','cloudflare-tunnel')

foreach ($f in $codeFolders) {
    $s = Join-Path $Src $f
    $d = Join-Path $Dst $f
    if (-not (Test-Path $s)) { Write-Host "  skip (not in source): $f"; continue }
    Write-Host "  sync folder: $f" -ForegroundColor Gray
    & robocopy $s $d /E /NP /NDL /NJH /NJS /NFL /R:2 /W:2 | Out-Null
    # robocopy exit >=8 = real failure; <8 = normal (files copied / nothing to do)
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $f (exit $LASTEXITCODE)" }
}

# database/ - copy ONLY .js files. Never touch .db/.db-shm/.db-wal (prod data).
Write-Host "  sync database/*.js (prod DB files preserved)" -ForegroundColor Gray
& robocopy "$Src\database" "$Dst\database" *.js /NP /NDL /NJH /NJS /NFL /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed for database" }

# Top-level files. .env intentionally skipped - prod has its own JWT_SECRET etc.
$topFiles = @(
    'server.js','package.json','package-lock.json','ecosystem.config.js',
    'README.md','OPERATIONS.md','SECURITY.md','SETUP.md','MIGRATION.md',
    'BUG-FIX-REPORT.md','FEATURES-2026-05.md','start-timesheet.bat'
)
foreach ($f in $topFiles) {
    $s = Join-Path $Src $f
    if (Test-Path $s) {
        Copy-Item $s -Destination (Join-Path $Dst $f) -Force
        Write-Host "  copy file: $f" -ForegroundColor Gray
    }
}

# npm install only if package-lock changed (saves time on most deploys)
$lockSrc = (Get-FileHash "$Src\package-lock.json" -ErrorAction SilentlyContinue).Hash
$lockDst = (Get-FileHash "$Dst\package-lock.json" -ErrorAction SilentlyContinue).Hash
if ($lockSrc -ne $lockDst -or -not (Test-Path "$Dst\node_modules")) {
    Write-Host "==> package-lock changed - running npm install in $Dst" -ForegroundColor Yellow
    Push-Location $Dst
    try { & npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }
}

# PM2 reload via SYSTEM-context one-shot scheduled task
Write-Host "==> Reloading PM2 (ap-timesheet) as SYSTEM..." -ForegroundColor Cyan
$taskName = "AP-Timesheet-Reload-Once"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Run via cmd /c so PATH expansion picks up the global npm bin where pm2.cmd lives
$action    = New-ScheduledTaskAction    -Execute "cmd.exe" -Argument "/c pm2 reload ap-timesheet --update-env"
$principal = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -RunLevel Highest    # SID for NT AUTHORITY\SYSTEM
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName

# Wait for the reload to settle. PM2 reload kicks the child within a couple of seconds.
Start-Sleep -Seconds 7
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Health check
Write-Host "==> Health check..." -ForegroundColor Cyan
try {
    $r = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5
    $color = if ($r.checks.db.ok) { 'Green' } else { 'Red' }
    Write-Host ("    db={0}  uptime={1}s  node={2}" -f $r.checks.db.ok, $r.uptime_seconds, $r.node) -ForegroundColor $color
    if ($r.uptime_seconds -lt 60) {
        Write-Host "    NEW PROCESS confirmed (low uptime = reload worked)" -ForegroundColor Green
    } else {
        Write-Host "    WARN: uptime > 60s - reload may not have happened. Check pm2 logs." -ForegroundColor Yellow
    }
} catch {
    Write-Host ("    Health check failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
}

Write-Host "==> Deploy complete." -ForegroundColor Green
