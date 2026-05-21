@echo off
REM ============================================================
REM  AP & Partners Timesheet — Server Installer
REM  Run this ONCE, as Administrator (right-click -> Run as admin)
REM ============================================================
setlocal enableextensions
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"

echo.
echo ============================================================
echo   AP ^& Partners Timesheet - Server Installer
echo ============================================================
echo.

REM --- 1. Check admin rights ----------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Please run this script as ADMINISTRATOR.
    echo Right-click install.bat - "Run as administrator"
    pause
    exit /b 1
)

REM --- 2. Check Node.js ---------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org first.
    pause
    exit /b 1
)
echo [OK] Node.js found:
call node --version
call npm --version
echo PM2_HOME = %PM2_HOME%
echo.

REM --- 3. Install PM2 globally --------------------------------
echo [STEP] Installing PM2 globally...
call npm install -g pm2
if errorlevel 1 (
    echo [ERROR] PM2 install failed. Check internet connection.
    pause
    exit /b 1
)
echo [OK] PM2 installed.
echo.

REM --- 4. Make logs + pm2 home folders -----------------------
if not exist logs mkdir logs
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%"

REM --- 5. Stop any existing instance --------------------------
call pm2 delete ap-timesheet >nul 2>&1

REM --- 6. Start app under PM2 ---------------------------------
echo [STEP] Starting ap-timesheet under PM2...
call pm2 start ecosystem.config.js
if errorlevel 1 (
    echo [ERROR] PM2 start failed. Check logs.
    pause
    exit /b 1
)
echo.

REM --- 7. Save PM2 process list so it can be resurrected -----
echo [STEP] Saving PM2 process list...
call pm2 save
echo.

REM --- 8. Register Windows Task Scheduler entry for boot ------
echo [STEP] Registering Task Scheduler entry for auto-start on boot...
schtasks /Delete /TN "AP-Timesheet-Server" /F >nul 2>&1
schtasks /Create /TN "AP-Timesheet-Server" /TR "\"%~dp0resurrect.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (
    echo [WARN] Task Scheduler registration failed.
) else (
    echo [OK] Will auto-start on every Windows boot.
)
echo.

REM --- 9. Apply power settings (no sleep when plugged in) -----
echo [STEP] Applying power settings (laptop will never sleep when plugged in)...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30
powercfg /hibernate off
echo [OK] Power settings applied. Monitor will turn off after 30 min, but PC will stay on.
echo.

REM --- 10. Firewall rule for port 3000 (LAN access optional) --
echo [STEP] Adding Windows Firewall inbound rule for port 3000...
netsh advfirewall firewall delete rule name="AP Timesheet (port 3000)" >nul 2>&1
netsh advfirewall firewall add rule name="AP Timesheet (port 3000)" dir=in action=allow protocol=TCP localport=3000
echo.

REM --- 11. Register daily backup task -------------------------
echo [STEP] Registering daily backup task (runs at 2:00 AM)...
schtasks /Delete /TN "AP-Timesheet-Backup" /F >nul 2>&1
schtasks /Create /TN "AP-Timesheet-Backup" /TR "\"%~dp0backup.bat\"" /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST /F
echo.

echo ============================================================
echo   INSTALL COMPLETE
echo ============================================================
echo.
call pm2 status
echo.
echo Browser me kholein:  http://localhost:3000
echo.
echo Test karne ke liye:
echo   1. Laptop restart karo
echo   2. Login ke baad ~30 sec wait karo (boot delay)
echo   3. Browser me http://localhost:3000 kholo - app chalti milegi
echo.
echo Useful commands:
echo   pm2 status                     - dekho server chal raha hai ya nahi
echo   pm2 logs ap-timesheet          - live logs dekho
echo   pm2 restart ap-timesheet       - server restart karo
echo.
echo Ya server-tools folder me .bat files use karo (status/start/stop/restart/logs)
echo.
pause
