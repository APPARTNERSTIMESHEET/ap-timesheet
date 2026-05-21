@echo off
REM Cloudflare Tunnel ka status check
echo.
echo === Windows Service: Cloudflared ===
sc query cloudflared 2>nul
if errorlevel 1 (
    echo [NOT INSTALLED] Cloudflared service nahi mila.
    echo Pehle dashboard se "service install <token>" command chalao.
    goto :end
)
echo.
echo === Connectivity test ===
echo Testing https://timesheet.appartners.in ...
curl -sI -o nul -w "HTTP Status: %%{http_code}\nTotal time: %%{time_total}s\n" https://timesheet.appartners.in
echo.
echo === Local app ===
curl -sI -o nul -w "localhost:3000 -> HTTP %%{http_code}\n" http://localhost:3000
echo.
:end
pause
