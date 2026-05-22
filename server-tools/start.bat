@echo off
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"
call pm2 start ecosystem.config.js
call pm2 save
call pm2 status
pause
