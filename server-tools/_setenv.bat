@echo off
REM ============================================================
REM  Common environment setup — sourced by every other .bat file
REM  Ensures PM2 sees the same home directory whether the caller
REM  is the logged-in user (CMD) or the SYSTEM account (boot task).
REM ============================================================

REM Use a fixed location for PM2 state so SYSTEM and user agree
set "PM2_HOME=C:\ap-timesheet\.pm2"

REM Make sure Node.js is on PATH even if SYSTEM's PATH is stripped
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "C:\Program Files (x86)\nodejs\node.exe" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"

REM npm global bin (for pm2.cmd) when installed under SYSTEM profile
if exist "%ProgramData%\npm" set "PATH=%ProgramData%\npm;%PATH%"
if exist "%APPDATA%\npm" set "PATH=%APPDATA%\npm;%PATH%"

exit /b 0
