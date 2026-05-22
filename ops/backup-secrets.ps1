# === AP Timesheet -- Secrets Backup ==============================
# Backs up critical config files that aren't in the regular DB backup:
#   - .env (JWT secret, SMTP password, etc.)
#   - .cloudflared\*.json (tunnel credentials)
#   - PM2 ecosystem config
#
# Encrypts using DPAPI so only the AP-Admin user can read the backup.
# Run via scheduled task once a day OR after .env changes.
# =================================================================

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot

# Destination -- inside OneDrive Backups in a separate "secrets" subfolder
$RootBackup = if ($env:AP_BACKUP_DIR) {
    $env:AP_BACKUP_DIR
} elseif ($env:OneDrive -and (Test-Path $env:OneDrive)) {
    Join-Path $env:OneDrive 'AP-Timesheet-Backups'
} else {
    Join-Path $AppRoot 'backups'
}
$SecretsDir = Join-Path $RootBackup 'secrets'
New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null

$LogPath = Join-Path $AppRoot 'logs\backup-secrets.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Log($m) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

try {
    Log "--- Secrets backup started ---"
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    # 1. Backup .env
    $envFile = Join-Path $AppRoot '.env'
    if (Test-Path $envFile) {
        # Read raw content
        $envContent = Get-Content $envFile -Raw

        # Encrypt with DPAPI -- only the current user account can decrypt
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($envContent)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
        $b64 = [Convert]::ToBase64String($encrypted)

        $envBackup = Join-Path $SecretsDir "env-$stamp.encrypted"
        Set-Content -Path $envBackup -Value $b64 -Encoding ASCII

        # Also save a SHA-256 hash sidecar for integrity verification
        $hash = (Get-FileHash $envFile -Algorithm SHA256).Hash
        Set-Content -Path "$envBackup.sha256" -Value $hash -Encoding ASCII

        Log "Encrypted .env saved: $envBackup"
    }

    # 2. Backup Cloudflare tunnel credentials
    $cfDir = "$env:USERPROFILE\.cloudflared"
    if (Test-Path $cfDir) {
        $cfBackup = Join-Path $SecretsDir "cloudflared-$stamp.zip"
        Compress-Archive -Path "$cfDir\*" -DestinationPath $cfBackup -Force
        Log "Cloudflared credentials zipped: $cfBackup"
    }

    # 3. Backup PM2 ecosystem config + dump
    $eco = Join-Path $AppRoot 'ecosystem.config.js'
    if (Test-Path $eco) {
        Copy-Item $eco (Join-Path $SecretsDir "ecosystem-$stamp.config.js") -Force
        Log "PM2 ecosystem config saved"
    }
    $pm2Dump = "$env:USERPROFILE\.pm2\dump.pm2"
    if (Test-Path $pm2Dump) {
        Copy-Item $pm2Dump (Join-Path $SecretsDir "pm2-dump-$stamp.pm2") -Force
        Log "PM2 process dump saved"
    }

    # 4. Rotate -- keep last 30 backups of each
    $patterns = @('env-*.encrypted', 'env-*.encrypted.sha256', 'cloudflared-*.zip', 'ecosystem-*.config.js', 'pm2-dump-*.pm2')
    foreach ($p in $patterns) {
        $files = Get-ChildItem -Path $SecretsDir -Filter $p -File | Sort-Object LastWriteTime -Descending
        if ($files.Count -gt 30) {
            $files | Select-Object -Skip 30 | Remove-Item -Force
        }
    }

    Log "--- Secrets backup OK ---`r`n"
    exit 0
} catch {
    Log "ERROR: $($_.Exception.Message)"
    exit 1
}
