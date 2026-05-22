# === AP Timesheet -- DISASTER RECOVERY Restore Script =============
# One-click restore from the most recent OneDrive backup.
# Use this on a fresh Windows install (or after Windows corruption)
# to bring the application back up.
#
# PREREQUISITES (must be done manually first):
#   1. OneDrive is logged in and synced with it@appartners.in
#   2. Node.js is installed (winget install OpenJS.NodeJS)
#   3. PM2 is installed (npm install -g pm2 pm2-windows-startup)
#
# USAGE (run as Administrator):
#   powershell -ExecutionPolicy Bypass -File this-script.ps1
# ==================================================================

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "  AP TIMESHEET -- DISASTER RECOVERY RESTORE" -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Locate OneDrive ──
$srcRoot = "$env:OneDrive\..\OneDrive - AP Partners\ap-timesheet"
if (-not (Test-Path $srcRoot)) {
    # Try common alternate location
    $srcRoot = "C:\Users\$env:USERNAME\Desktop\OneDrive - AP Partners\ap-timesheet"
}
if (-not (Test-Path $srcRoot)) {
    Write-Host "ERROR: Could not find OneDrive source at expected path." -ForegroundColor Red
    Write-Host "Tried: $srcRoot"
    Write-Host "Manual: Ensure OneDrive is synced with the AP Partners account first."
    exit 1
}

$backupRoot = Split-Path $srcRoot -Parent
$backupDir = Join-Path $backupRoot 'AP-Timesheet-Backups'
$prodRoot = 'C:\ap-timesheet'

Write-Host "Source (OneDrive):  $srcRoot"
Write-Host "Backups:            $backupDir"
Write-Host "Production target:  $prodRoot"
Write-Host ""

# Confirm
$ans = Read-Host "Proceed with disaster recovery restore? (yes/no)"
if ($ans -ne 'yes') {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
}

# ── Step 1: Stop any running instance ──
Write-Host ""
Write-Host "[1/7] Stopping existing PM2 process (if any)..." -ForegroundColor Yellow
pm2 delete ap-timesheet 2>$null | Out-Null
Write-Host "  OK"

# ── Step 2: Copy source code ──
Write-Host ""
Write-Host "[2/7] Copying source code from OneDrive to C:\ap-timesheet..." -ForegroundColor Yellow
robocopy $srcRoot $prodRoot /MIR /XD node_modules .git uploads /XF .env *.db *.db-wal *.db-shm /NFL /NDL /NJH /NJS | Out-Null
Write-Host "  OK"

# ── Step 3: Install dependencies ──
Write-Host ""
Write-Host "[3/7] Installing npm dependencies (this takes 1-2 min)..." -ForegroundColor Yellow
Push-Location $prodRoot
npm install --production 2>&1 | Select-Object -Last 3
Pop-Location
Write-Host "  OK"

# ── Step 4: Restore latest DB backup ──
Write-Host ""
Write-Host "[4/7] Restoring latest database backup..." -ForegroundColor Yellow
$dbDest = Join-Path $prodRoot 'database\aptimesheet.db'
New-Item -ItemType Directory -Force -Path (Split-Path $dbDest) | Out-Null

# Prefer most recent hourly snapshot (least data loss)
$hourlyDir = Join-Path $backupDir 'hourly'
$latestHourly = if (Test-Path $hourlyDir) {
    Get-ChildItem -Path $hourlyDir -Filter 'aptimesheet-hourly-*.db' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
} else { $null }
$latestDaily = Get-ChildItem -Path $backupDir -Filter 'aptimesheet-*.db' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

$candidate = if ($latestHourly -and (-not $latestDaily -or $latestHourly.LastWriteTime -gt $latestDaily.LastWriteTime)) {
    $latestHourly
} else {
    $latestDaily
}
if (-not $candidate) {
    Write-Host "  ERROR: No backups found in $backupDir" -ForegroundColor Red
    exit 1
}
Copy-Item $candidate.FullName $dbDest -Force
$ageHrs = [math]::Round(((Get-Date) - $candidate.LastWriteTime).TotalHours, 1)
Write-Host "  Restored: $($candidate.Name)"
Write-Host "  Age: $ageHrs hours ago"
Write-Host "  Data loss window: at most $ageHrs hour(s)"

# ── Step 5: Restore .env from encrypted backup (if available) ──
Write-Host ""
Write-Host "[5/7] Restoring .env file..." -ForegroundColor Yellow
$secretsDir = Join-Path $backupDir 'secrets'
$envDest = Join-Path $prodRoot '.env'

$latestEnv = if (Test-Path $secretsDir) {
    Get-ChildItem -Path $secretsDir -Filter 'env-*.encrypted' -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
} else { $null }

if ($latestEnv) {
    try {
        $b64 = Get-Content $latestEnv.FullName -Raw
        $encrypted = [Convert]::FromBase64String($b64)
        Add-Type -AssemblyName System.Security
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
        $envContent = [System.Text.Encoding]::UTF8.GetString($decrypted)
        Set-Content -Path $envDest -Value $envContent -Encoding UTF8 -NoNewline
        Write-Host "  Decrypted and restored from: $($latestEnv.Name)"
    } catch {
        Write-Host "  WARN: Could not decrypt .env backup (different machine?)" -ForegroundColor Yellow
        Write-Host "  Copying .env.example as fallback. You MUST edit it manually:" -ForegroundColor Yellow
        Copy-Item (Join-Path $prodRoot '.env.example') $envDest -Force
        Write-Host "    notepad C:\ap-timesheet\.env" -ForegroundColor Cyan
    }
} else {
    Write-Host "  No .env backup found. Using .env.example as template." -ForegroundColor Yellow
    Copy-Item (Join-Path $prodRoot '.env.example') $envDest -Force
    Write-Host "  EDIT REQUIRED: notepad C:\ap-timesheet\.env" -ForegroundColor Red
}

# Lock down .env permissions
icacls $envDest /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" 2>&1 | Out-Null

# ── Step 6: Restore uploads (from latest daily ZIP) ──
Write-Host ""
Write-Host "[6/7] Restoring uploads folder..." -ForegroundColor Yellow
$latestUploadsZip = Get-ChildItem -Path $backupDir -Filter 'uploads-*.zip' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestUploadsZip) {
    $uploadsDest = Join-Path $prodRoot 'uploads'
    New-Item -ItemType Directory -Force -Path $uploadsDest | Out-Null
    Expand-Archive -Path $latestUploadsZip.FullName -DestinationPath $uploadsDest -Force
    $count = (Get-ChildItem $uploadsDest -File -Recurse).Count
    Write-Host "  Restored $count files from $($latestUploadsZip.Name)"
} else {
    Write-Host "  No uploads backup found (skip)"
}

# ── Step 7: Start the app ──
Write-Host ""
Write-Host "[7/7] Starting application via PM2..." -ForegroundColor Yellow
$eco = Join-Path $prodRoot 'ecosystem.config.js'
if (-not (Test-Path $eco)) {
    # Fallback start
    Push-Location $prodRoot
    pm2 start server.js --name ap-timesheet
    Pop-Location
} else {
    Push-Location $prodRoot
    pm2 start ecosystem.config.js
    Pop-Location
}
pm2 save | Out-Null
Write-Host "  OK"

# ── Verify ──
Start-Sleep -Seconds 3
Write-Host ""
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "  RESTORE COMPLETE -- VERIFICATION" -ForegroundColor Green
Write-Host "===============================================================" -ForegroundColor Cyan
try {
    $h = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    if ($h.ok) {
        Write-Host "  Health endpoint: OK" -ForegroundColor Green
        Write-Host "  DB ping: $($h.checks.db.ms) ms"
        Write-Host "  Last backup age: $($h.checks.last_backup_hours) hours"
    } else {
        Write-Host "  Health: UNHEALTHY -- check logs" -ForegroundColor Red
    }
} catch {
    Write-Host "  Health check failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Reinstall Cloudflare tunnel:"
Write-Host "     Run: cloudflared service install <tunnel-token>"
Write-Host ""
Write-Host "  2. Reinstall scheduled tasks:"
Write-Host "     & 'C:\ap-timesheet\ops\install-tasks.ps1'"
Write-Host ""
Write-Host "  3. Verify in browser: https://timesheet.appartners.in"
Write-Host ""
Write-Host "  4. All users will need to re-login (JWT secret may have changed)"
Write-Host ""
Write-Host "DONE." -ForegroundColor Green
