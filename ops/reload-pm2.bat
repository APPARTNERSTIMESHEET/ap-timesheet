@echo off
REM Right-click this file -> "Run as administrator" to reload the live PM2 process.
REM Required after backend code changes (routes/*, middleware/*, utils/*).
REM Frontend-only changes (public/*) just need a browser hard refresh, no PM2 reload.

echo.
echo ========================================
echo  AP-Timesheet PM2 reload
echo ========================================
echo.

REM Auto-elevate if not already running as admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Not running as admin - relaunching elevated...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit /b
)

echo Running pm2 reload ap-timesheet --update-env ...
echo.
pm2 reload ap-timesheet --update-env
echo.

echo ----------------------------------------
echo Health check:
echo ----------------------------------------
timeout /t 4 /nobreak >nul
powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5; Write-Host ('uptime = ' + $r.uptime_seconds + 's  |  db_ok = ' + $r.checks.db.ok) -ForegroundColor Green; if ($r.uptime_seconds -lt 60) { Write-Host 'RELOAD CONFIRMED' -ForegroundColor Green } else { Write-Host 'WARN: uptime > 60s - reload may not have taken effect' -ForegroundColor Yellow } } catch { Write-Host ('Health check failed: ' + $_.Exception.Message) -ForegroundColor Red }"
echo.
echo Press any key to close...
pause >nul
