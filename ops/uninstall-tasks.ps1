# ─── Remove all AP-Timesheet scheduled tasks ───────────────────────────────────
# Run as Administrator.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'SilentlyContinue'

$tasks = @('Resurrect','DailyBackup','CloudSync','WeeklyHealth')
foreach ($t in $tasks) {
    Unregister-ScheduledTask -TaskPath '\AP-Timesheet\' -TaskName $t -Confirm:$false
    Write-Host "Removed: \AP-Timesheet\$t"
}
# Remove the empty folder
$null = (New-Object -ComObject Schedule.Service).Connect()
Write-Host "Done."
