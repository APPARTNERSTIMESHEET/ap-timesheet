@echo off
REM Live logs tail. Press Ctrl+C to exit.
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"
call pm2 logs ap-timesheet --lines 100
