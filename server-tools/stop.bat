@echo off
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"
call pm2 stop ap-timesheet
call pm2 save
call pm2 status
pause
