# === Boot Auto-Start -- AP Timesheet ==========================================
# Runs once at Windows boot via Task Scheduler. Ensures both PM2 (ap-timesheet)
# and Cloudflared service are running so the public URL works without any
# manual intervention after laptop power-on.
#
# Idempotent: safe to run multiple times.
# ==============================================================================

$ErrorActionPreference = 'Continue'
$AppRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $AppRoot 'logs\boot-autostart.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

Log "=== Boot auto-start started ==="

# 1. Wait for system to settle (network adapters, disks, etc.)
Start-Sleep -Seconds 20

# 2. Start Cloudflared service (so tunnel is up)
try {
    $cf = Get-Service Cloudflared -ErrorAction Stop
    if ($cf.Status -ne 'Running') {
        Log "Cloudflared was $($cf.Status). Starting..."
        Start-Service Cloudflared
        Start-Sleep -Seconds 5
        $cf = Get-Service Cloudflared
        Log "Cloudflared now: $($cf.Status)"
    } else {
        Log "Cloudflared already Running"
    }
    # Ensure StartType is Automatic so this survives Windows updates etc.
    Set-Service Cloudflared -StartupType Automatic -ErrorAction SilentlyContinue
} catch {
    Log "ERROR: Cloudflared service not found -- it may not be installed. Run: cloudflared service install <token>"
}

# 3. Start PM2 + ap-timesheet
try {
    $pm2 = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
    if (-not $pm2) {
        # PM2 not on SYSTEM PATH -- try the common npm global location
        $candidates = @(
            "$env:APPDATA\npm\pm2.cmd",
            "C:\Users\Admin\AppData\Roaming\npm\pm2.cmd"
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $pm2 = $c; break }
        }
    }
    if (-not $pm2) {
        Log "ERROR: pm2 not found. Install with: npm install -g pm2 pm2-windows-startup"
    } else {
        Log "Using pm2 at: $pm2"

        # Try resurrect first (restores last saved process list)
        Push-Location $AppRoot
        & $pm2 resurrect 2>&1 | ForEach-Object { Log "[pm2] $_" }
        Start-Sleep -Seconds 5

        # Check if ap-timesheet is running
        $desc = & $pm2 describe ap-timesheet 2>&1
        $isRunning = ($desc -match 'online') -and ($LASTEXITCODE -eq 0)
        if (-not $isRunning) {
            Log "ap-timesheet not online after resurrect -- starting fresh from ecosystem.config.js"
            & $pm2 start (Join-Path $AppRoot 'ecosystem.config.js') 2>&1 | ForEach-Object { Log "[pm2] $_" }
            & $pm2 save 2>&1 | ForEach-Object { Log "[pm2] $_" }
        } else {
            Log "ap-timesheet is online"
        }
        Pop-Location
    }
} catch {
    Log "ERROR starting PM2: $($_.Exception.Message)"
}

# 4. Health-check after 15 sec to verify everything is responding
Start-Sleep -Seconds 15
try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 10
    if ($resp.StatusCode -eq 200) {
        Log "Local health check OK (HTTP $($resp.StatusCode))"
    } else {
        Log "WARN: Local health returned HTTP $($resp.StatusCode)"
    }
} catch {
    Log "WARN: Local health check failed: $($_.Exception.Message)"
}

# 5. Public URL health check (verifies tunnel is connected)
try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri 'https://timesheet.appartners.in/api/health' -TimeoutSec 30
    if ($resp.StatusCode -eq 200) {
        Log "Public URL OK -- tunnel is live"
    } else {
        Log "WARN: Public URL returned HTTP $($resp.StatusCode)"
    }
} catch {
    Log "WARN: Public URL check failed: $($_.Exception.Message)"
}

Log "=== Boot auto-start done ===`r`n"
exit 0
