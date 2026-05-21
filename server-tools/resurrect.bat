@echo off
REM ============================================================
REM  Auto-run on Windows boot via Task Scheduler ("AP-Timesheet-Server")
REM  Runs as SYSTEM. Restores the PM2 process list saved by install.bat.
REM ============================================================
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"

REM Wait a bit so network + filesystem are fully ready
timeout /t 20 /nobreak >nul

if not exist logs mkdir logs
echo [%date% %time%] resurrect.bat started (PM2_HOME=%PM2_HOME%) >> logs\boot.log

call pm2 resurrect >> logs\boot.log 2>&1

echo [%date% %time%] resurrect.bat done >> logs\boot.log
exit /b 0
