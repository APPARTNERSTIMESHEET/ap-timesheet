# === Optional: copy local backups to cloud ====================================
# Uses rclone (https://rclone.org/install/) to push the backups\ folder to a
# remote (Google Drive / OneDrive / S3 / Dropbox / Backblaze B2). One-time
# setup:  rclone config       -- name the remote "backup"
#
# Schedule with Task Scheduler AFTER the local backup task completes.
# ==============================================================================

$ErrorActionPreference = 'Stop'
$AppRoot   = Split-Path -Parent $PSScriptRoot
$BackupDir = Join-Path $AppRoot 'backups'
$LogPath   = Join-Path $AppRoot 'logs\backup-cloud.log'
$Remote    = 'backup:ap-timesheet'      # change to your rclone remote + folder
$KeepDays  = 90                         # keep 3 months in the cloud

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

try {
    Log "--- Cloud sync started ($Remote) ---"
    $rclone = (Get-Command rclone -ErrorAction SilentlyContinue).Source
    if (-not $rclone) { throw "rclone not installed -- see https://rclone.org/install/" }

    & $rclone copy $BackupDir $Remote --transfers 2 --checkers 4 --log-file $LogPath --log-level INFO
    if ($LASTEXITCODE -ne 0) { throw "rclone copy failed (exit $LASTEXITCODE)" }

    # Delete cloud backups older than KeepDays so storage doesn't grow forever
    & $rclone delete $Remote --min-age "${KeepDays}d" --log-file $LogPath --log-level INFO
    Log "--- Cloud sync OK ---`r`n"
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    Log "--- Cloud sync FAILED ---`r`n"
    exit 1
}
