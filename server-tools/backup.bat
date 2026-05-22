@echo off
REM ============================================================
REM  Daily backup of the timesheet SQLite database + uploads
REM  Runs automatically every day at 2:00 AM (set by install.bat)
REM  Keeps the last 30 days of backups.
REM ============================================================
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0\.."

set "BACKUP_ROOT=C:\ap-timesheet-backups"
if not exist "%BACKUP_ROOT%" mkdir "%BACKUP_ROOT%"

REM Build a YYYY-MM-DD stamp without depending on locale
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value ^| find "="') do set "DT=%%I"
set "STAMP=!DT:~0,4!-!DT:~4,2!-!DT:~6,2!_!DT:~8,2!!DT:~10,2!"

set "TARGET=%BACKUP_ROOT%\backup_!STAMP!"
mkdir "%TARGET%"

echo [%date% %time%] Backup starting -> %TARGET% >> "%BACKUP_ROOT%\backup.log"

REM Copy DB (better-sqlite3 uses WAL; copy main + wal + shm if present)
copy /Y "database\aptimesheet.db"     "%TARGET%\aptimesheet.db"      >> "%BACKUP_ROOT%\backup.log" 2>&1
if exist "database\aptimesheet.db-wal" copy /Y "database\aptimesheet.db-wal" "%TARGET%\aptimesheet.db-wal" >> "%BACKUP_ROOT%\backup.log" 2>&1
if exist "database\aptimesheet.db-shm" copy /Y "database\aptimesheet.db-shm" "%TARGET%\aptimesheet.db-shm" >> "%BACKUP_ROOT%\backup.log" 2>&1

REM Copy uploads folder if present
if exist "uploads" robocopy "uploads" "%TARGET%\uploads" /E /NFL /NDL /NP >> "%BACKUP_ROOT%\backup.log" 2>&1

REM Delete backups older than 30 days
forfiles /P "%BACKUP_ROOT%" /D -30 /C "cmd /c if @isdir==TRUE rmdir /S /Q @path" >nul 2>&1

echo [%date% %time%] Backup complete. >> "%BACKUP_ROOT%\backup.log"
exit /b 0
