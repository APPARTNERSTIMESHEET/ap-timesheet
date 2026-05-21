@echo off
title AP ^& Partners - Timesheet Server
REM Use the directory this batch file lives in, so the script works regardless
REM of where the project is checked out (no more hardcoded user paths).
cd /d "%~dp0"

echo Starting Timesheet Server...
REM Prefer the PM2 ecosystem file so logging, memory limits and env stay consistent.
call pm2 describe ap-timesheet >nul 2>&1
IF %ERRORLEVEL% EQU 0 (
    call pm2 restart ap-timesheet
) ELSE (
    call pm2 start ecosystem.config.js
)

echo Timesheet server started!
timeout /t 3 >nul
