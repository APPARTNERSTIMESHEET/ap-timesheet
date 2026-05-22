@echo off
cd /d "%~dp0\.."
call "%~dp0_setenv.bat"
call pm2 status
echo.
echo Server URL: http://localhost:3000
echo.
pause
