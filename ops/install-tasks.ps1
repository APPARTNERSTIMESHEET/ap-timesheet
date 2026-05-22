# === AP & Partners Timesheet -- Install Scheduled Tasks =======================
# Registers four Windows Scheduled Tasks under the "AP-Timesheet\" folder:
#
#   1. AP-Timesheet\Resurrect       at boot       -- pm2 resurrect (extra safety net
#                                                    on top of pm2-windows-startup)
#   2. AP-Timesheet\DailyBackup     02:00 daily   -- local DB + uploads backup
#   3. AP-Timesheet\CloudSync       02:30 daily   -- push backups to cloud (rclone)
#   4. AP-Timesheet\WeeklyHealth    Sun 03:00     -- DB integrity + dependency audit
#
# RUN AS ADMINISTRATOR:
#   powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\install-tasks.ps1
#
# To remove:  ops\uninstall-tasks.ps1
# ==============================================================================

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $PSScriptRoot
$Folder  = '\AP-Timesheet'
$pwsh    = (Get-Command powershell.exe).Source

function Register-ApTask {
    param(
        [string]$Name,
        [string]$Description,
        $Trigger,
        [string]$Script
    )
    $taskPath = "$Folder\"
    $fullName = "$taskPath$Name"

    # Remove any existing version
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

    $cmdArgs = "-ExecutionPolicy Bypass -NoProfile -File `"$Script`""
    $action  = New-ScheduledTaskAction  -Execute $pwsh -Argument $cmdArgs -WorkingDirectory $AppRoot
    $princ   = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    $set     = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1)

    Register-ScheduledTask -TaskName $Name -TaskPath $taskPath `
        -Description $Description -Action $action -Trigger $Trigger -Principal $princ -Settings $set | Out-Null

    Write-Host ("  Installed: " + $fullName) -ForegroundColor Green
}

Write-Host ""
Write-Host "--- Installing AP-Timesheet scheduled tasks ---" -ForegroundColor Cyan
Write-Host "App root: $AppRoot"
Write-Host ""

# 1. Boot auto-start (starts BOTH pm2 ap-timesheet AND Cloudflared service)
Register-ApTask `
    -Name 'BootAutoStart' `
    -Description 'On Windows boot: start PM2 ap-timesheet + Cloudflared service + verify health' `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Script  (Join-Path $AppRoot 'ops\boot-autostart.ps1')

# 2. Daily backup at 11:00 AM (during business hours so failures are noticed quickly)
Register-ApTask `
    -Name 'DailyBackup' `
    -Description 'Daily SQLite + uploads backup with 30-day rotation' `
    -Trigger (New-ScheduledTaskTrigger -Daily -At '11:00am') `
    -Script  (Join-Path $AppRoot 'ops\backup.ps1')

# 2b. Hourly backup -- lightweight DB-only snapshot, 24-snapshot rolling window.
# Runs every hour at H:05 (offset 5 min from daily 11:00 backup to avoid race
# condition on integrity-log.json). Provides 1-hour granularity recovery.
# RepetitionDuration set to 3650 days (10 years) -- Task Scheduler rejects
# [TimeSpan]::MaxValue as out-of-range.
$hourlyStart = (Get-Date).Date.AddHours((Get-Date).Hour + 1).AddMinutes(5)
$hourlyTrigger = New-ScheduledTaskTrigger -Once -At $hourlyStart `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ApTask `
    -Name 'HourlyBackup' `
    -Description 'Hourly SQLite snapshot (24-snapshot rolling) + integrity verification' `
    -Trigger $hourlyTrigger `
    -Script  (Join-Path $AppRoot 'ops\backup-hourly.ps1')

# 3. Cloud sync at 11:30 AM (only if rclone is configured)
if (Get-Command rclone -ErrorAction SilentlyContinue) {
    Register-ApTask `
        -Name 'CloudSync' `
        -Description 'Push local backups to cloud via rclone' `
        -Trigger (New-ScheduledTaskTrigger -Daily -At '11:30am') `
        -Script  (Join-Path $AppRoot 'ops\backup-to-cloud.ps1')
} else {
    Write-Host "  Skipped CloudSync (rclone not installed -- install from https://rclone.org/install/)" -ForegroundColor Yellow
}

# 3b. Daily secrets backup at 11:10 AM (right after daily DB backup, encrypted via DPAPI).
# Backs up .env, Cloudflare tunnel creds, and PM2 config so disaster recovery
# can fully restore without re-typing passwords or re-issuing certificates.
Register-ApTask `
    -Name 'SecretsBackup' `
    -Description 'Daily encrypted backup of .env, Cloudflare tunnel creds, PM2 config' `
    -Trigger (New-ScheduledTaskTrigger -Daily -At '11:10am') `
    -Script  (Join-Path $AppRoot 'ops\backup-secrets.ps1')

# 4. Weekly health check on Sundays 03:00
$sun = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '3:00am'
Register-ApTask `
    -Name 'WeeklyHealth' `
    -Description 'DB integrity check + dependency audit + log rotation' `
    -Trigger $sun `
    -Script  (Join-Path $AppRoot 'ops\weekly-health.ps1')

Write-Host ""
Write-Host "--- Done. Verify with: ---" -ForegroundColor Cyan
Write-Host "    Get-ScheduledTask -TaskPath '\AP-Timesheet\*' | ft TaskName,State,LastRunTime,NextRunTime"
Write-Host ""
