@echo off
REM Run as Administrator. Removes all server-mode setup.
setlocal enableextensions
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"

net session >nul 2>&1
if errorlevel 1 (
    echo Run as Administrator.
    pause
    exit /b 1
)

echo Stopping ap-timesheet...
call pm2 delete ap-timesheet >nul 2>&1
call pm2 save --force >nul 2>&1

echo Removing scheduled tasks...
schtasks /Delete /TN "AP-Timesheet-Server" /F >nul 2>&1
schtasks /Delete /TN "AP-Timesheet-Backup" /F >nul 2>&1

echo Removing firewall rule...
netsh advfirewall firewall delete rule name="AP Timesheet (port 3000)" >nul 2>&1

echo Done. (PM2 itself, Node, .env, database are kept.)
pause
