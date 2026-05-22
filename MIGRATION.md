# AP & Partners Timesheet -- Migration: Laptop A -> Laptop B

**Goal:** Pura system (server, DB, files, backups, Cloudflare tunnel) Laptop A se Laptop B par shift karna, taaki Laptop A ko safely reset kiya ja sake.

**Total time:** 30-45 min if both laptops on same WiFi.

**Critical insight:** Cloudflare Tunnel ka **credentials file** (`%USERPROFILE%\.cloudflared\`) Laptop A par hai. Yeh file Laptop B par copy karne se same tunnel uthayi ja sakti hai bina Cloudflare account login ke. DNS already `timesheet.appartners.in -> tunnel-UUID` point karta hai, machine matter nahi karti.

---

## PHASE A -- Laptop A par export tayyar karna (10 min)

### A1. Final fresh backup le lein

Admin PowerShell on Laptop A:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\backup.ps1
```

Yeh latest backup OneDrive folder mein bana dega. Output mein `--- Backup OK ---` aana chahiye.

### A2. Server temporarily stop karein (taaki DB consistent state mein ho transfer ke time)

```powershell
pm2 stop ap-timesheet
```

`status: stopped` dikhega. Yeh **important** hai -- agar server chal raha hoga to DB file open hai aur copy mein WAL inconsistency aa sakti hai.

### A3. Cloudflared service stop karein bhi (briefly)

```powershell
Stop-Service Cloudflared
```

Yeh tunnel ko temporarily band karega. `https://timesheet.appartners.in` ab ~5-10 min ke liye unreachable rahega -- normal, aage migration ke baad fix ho jayega.

### A4. Sab kuch zip karein

```powershell
$timestamp = Get-Date -Format 'yyyyMMdd-HHmm'
$zipPath   = "C:\ap-timesheet-export-$timestamp.zip"
$cloudflaredZip = "C:\cloudflared-export-$timestamp.zip"

# Project zip -- node_modules exclude karein (Laptop B par fresh install hoga)
Compress-Archive -Path C:\ap-timesheet\* -DestinationPath $zipPath -Force `
    -CompressionLevel Optimal

# Cloudflared credentials zip
Compress-Archive -Path "$env:USERPROFILE\.cloudflared" -DestinationPath $cloudflaredZip -Force

Write-Host "Project zip:    $zipPath"
Write-Host "Cloudflared:    $cloudflaredZip"
Write-Host "Size project:   $((Get-Item $zipPath).Length / 1MB) MB"
Write-Host "Size cloudflared: $((Get-Item $cloudflaredZip).Length / 1KB) KB"
```

**Note:** Default `Compress-Archive` `node_modules` include kar lega -- file bahut badi hogi (300+ MB). Better:

```powershell
# node_modules ko exclude karte hue zip karein
$tempStaging = "C:\ap-timesheet-staging"
robocopy C:\ap-timesheet $tempStaging /E /XD node_modules .git\objects /XF *.log
Compress-Archive -Path "$tempStaging\*" -DestinationPath $zipPath -Force
Remove-Item $tempStaging -Recurse -Force
```

Final zip ~10-50 MB hona chahiye (depend karta hai DB size aur uploads par).

---

## PHASE B -- Laptop B par prerequisites (5-10 min)

Laptop B par Admin PowerShell kholein.

### B1. Node.js version check + upgrade if needed

```powershell
node --version
```

Agar version **18 ya higher** nahi hai (e.g. v16 dikhe), upgrade karein:

```powershell
winget install OpenJS.NodeJS.LTS
```

### B2. Execution policy set karein

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine
```

Confirmation mein `Y`.

### B3. PM2 + pm2-windows-startup install

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
```

### B4. Cloudflared install

```powershell
winget install Cloudflare.cloudflared
```

Verify (PowerShell band-kholna padega ek baar PATH update ke liye):

```powershell
exit
# Fresh admin PowerShell kholein
cloudflared --version
```

### B5. (Optional) Git install if not already

```powershell
git --version
# Agar nahi hai:
winget install Git.Git
```

---

## PHASE C -- Files Laptop A se Laptop B par transfer (5-15 min)

### C1. Laptop A par network share enable karein

Admin PowerShell on Laptop A:

```powershell
# Temporary share C:\ folder ko (sirf admin access ke liye)
# Ya simpler: directly zip files ko share kar dein
New-SmbShare -Name "TempMigrate" -Path "C:\" -FullAccess "Everyone" -Temporary
```

Ya **easier**: zip files ko shared OneDrive folder mein daal dein (agar OneDrive same account hai), ya pendrive mein copy kar lein.

### C2. Laptop A ka local IP nikalein

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' }).IPAddress
```

E.g. `192.168.1.45`. Note this down.

### C3. Laptop B par files copy karein

Admin PowerShell on Laptop B:

```powershell
# Replace 192.168.1.45 with Laptop A's actual IP
$LaptopA = "192.168.1.45"

# Copy zip files
Copy-Item "\\$LaptopA\TempMigrate\ap-timesheet-export-*.zip" -Destination "C:\"
Copy-Item "\\$LaptopA\TempMigrate\cloudflared-export-*.zip" -Destination "C:\"
```

Agar SMB share access mein issue ho (credentials prompt aaye), use Laptop A ka Windows username + password.

### C4. Files extract karein on Laptop B

```powershell
# Project extract
Expand-Archive -Path "C:\ap-timesheet-export-*.zip" -DestinationPath "C:\ap-timesheet" -Force

# Cloudflared credentials extract (HOME directory mein)
Expand-Archive -Path "C:\cloudflared-export-*.zip" -DestinationPath "$env:USERPROFILE\" -Force

# Verify cloudflared folder ki files hai
ls "$env:USERPROFILE\.cloudflared\"
# Output mein dikhna chahiye: cert.pem aur ek <UUID>.json file
```

### C5. Laptop A par network share remove karein (cleanup)

Admin PowerShell on Laptop A:

```powershell
Remove-SmbShare -Name "TempMigrate" -Force
```

---

## PHASE D -- Laptop B par server start + tunnel (10 min)

### D1. node_modules rebuild karein (Laptop B ki architecture ke liye)

```powershell
cd C:\ap-timesheet
npm install
```

**Important:** `better-sqlite3` aur `bcryptjs` native modules hain -- inhein new machine par compile karna padta hai. `npm install` yeh karega automatically. ~2 min lagega.

### D2. .env file verify karein

```powershell
type C:\ap-timesheet\.env
```

Saare values present hone chahiye -- JWT_SECRET, SMTP_*, etc. Agar `.env` zip mein nahi aaya, Laptop A se manually copy karein (yeh `.gitignore` mein hai but transfer mein include hona chahiye).

### D3. Database file verify karein

```powershell
ls C:\ap-timesheet\database\
```

`aptimesheet.db` dikhna chahiye -- 100KB se zyada size mein.

### D4. PM2 par server start karein

```powershell
cd C:\ap-timesheet
pm2 start ecosystem.config.js
pm2 save
```

Status check:

```powershell
pm2 status
```

`ap-timesheet` `online` dikhna chahiye.

### D5. Local health test

```powershell
curl.exe http://localhost:3000/api/health
```

JSON dikhe with `"ok": true` aur `"db": { "ok": true, ... }` -- server kaam kar raha hai.

### D6. Cloudflared service install karein

```powershell
cloudflared service install
```

Yeh Windows service register karega jo boot par auto-start hogi. Service status check:

```powershell
Get-Service Cloudflared | Format-List
```

Status `Running` aur StartType `Automatic` dikhna chahiye.

### D7. Public URL test karein

Browser mein **kisi bhi device se** kholo:

```
https://timesheet.appartners.in
```

2-3 min wait karein DNS / Cloudflare edge ko propagate hone ke liye. Agar login screen dikhe to **public access bhi kaam kar raha hai Laptop B par.**

Verify health endpoint bhi:

```
https://timesheet.appartners.in/api/health
```

JSON dikhna chahiye full response ke saath.

---

## PHASE E -- Scheduled tasks + verification (5 min)

### E1. Laptop B par scheduled tasks install karein

```powershell
powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\install-tasks.ps1
```

3-4 tasks register hone chahiye. Verify:

```powershell
Get-ScheduledTask -TaskPath '\AP-Timesheet\*' | Format-Table TaskName, State, NextRunTime
```

### E2. Manual backup test on Laptop B

```powershell
powershell -ExecutionPolicy Bypass -File C:\ap-timesheet\ops\backup.ps1
```

`--- Backup OK ---` aana chahiye. Lekin **NOTE:** Laptop B par OneDrive ka path `$env:OneDrive` differs -- backup script automatically detect karega aur Laptop B ki OneDrive folder mein save karega.

### E3. UptimeRobot verify

https://uptimerobot.com par dashboard kholo -- 5-10 min wait karein. Monitor green dikhna chahiye (UptimeRobot ko pata bhi nahi chalega ki backend laptop change hua, bas URL same hai).

### E4. Login test

`https://timesheet.appartners.in` par `it@appartners.in` / password se login karein. Aapka existing data (entries, invoices) intact dikhna chahiye -- DB file Laptop A se Laptop B par same exact copy gayi.

---

## 24-HOUR HOLDING PERIOD (Laptop A reset karne SE PEHLE)

**Laptop A ko abhi reset MAT karein.** Iske bajaye:

1. **Laptop A par PM2 stop kar dein permanently:**
   ```powershell
   pm2 stop ap-timesheet
   pm2 save
   ```
   Lekin folder + .cloudflared file delete mat karein -- backup ke taur par 24 hour rakhein.

2. **24 ghante observe karein** Laptop B par:
   - Roz raat 2 AM ka backup chala kya? (`C:\Users\<NewAdmin>\OneDrive\AP-Timesheet-Backups` mein date check karein)
   - UptimeRobot mein 24 hour green raha?
   - Login/usage smoothly kaam kiya?
   - Health endpoint sahi response de raha?

3. **Agar 24 hour theek raha:**
   - Laptop A par ek FINAL backup zip karke OneDrive ya pendrive mein safe rakh lein:
     ```powershell
     Compress-Archive -Path C:\ap-timesheet\* -DestinationPath C:\final-laptopa-backup.zip
     ```
   - Phir Laptop A safely reset kar dein
   - Laptop A par cloudflared service ko bhi remove karein:
     ```powershell
     cloudflared service uninstall
     ```

4. **Agar koi issue aaye Laptop B par:**
   - Laptop A wapas start kar do (`pm2 start ecosystem.config.js`)
   - Laptop A par cloudflared service start karein (`Start-Service Cloudflared`)
   - Laptop B par cloudflared service stop karein (`Stop-Service Cloudflared`)
   - 5 min mein traffic Laptop A par wapas aa jayega

---

## TROUBLESHOOTING

### Public URL sirf Laptop A par chal raha hai, Laptop B par nahi

- Confirm Laptop A par `cloudflared` service stopped hai (do laptops ek saath same tunnel ko serve nahi kar sakte)
- Laptop B par check: `Get-Service Cloudflared` -- Running hona chahiye
- `cloudflared tunnel info <UUID>` (UUID `.cloudflared\` folder ki JSON file ka filename hai)

### Login kaam nahi kar raha Laptop B par

- DB file transfer hui nahi shayad: `dir C:\ap-timesheet\database\aptimesheet.db` -- size 100 KB+ hona chahiye
- `.env` file missing: `JWT_SECRET` use hua hai existing tokens encrypt karne mein -- agar mismatch ho to existing sessions invalid ho jayenge (login page wapas aayega, naya login krke kaam karega)

### npm install fail ho raha

- Internet connection check karein
- Visual Studio Build Tools chahiye native modules ke liye -- `npm install --global windows-build-tools` (admin)

### Cloudflared service install fail

- Already exists ho sakta hai: `cloudflared service uninstall` then re-install

---

## SUMMARY -- final state

| Laptop A (purana server) | Laptop B (naya server) |
|---|---|
| PM2 stopped | PM2 running |
| Cloudflared service stopped | Cloudflared service running |
| Folder still present (24 hour safety) | Active production system |
| After 24 hours: safe to reset | OneDrive backups, UptimeRobot, scheduled tasks running |

Public URL `https://timesheet.appartners.in` continuously work karta rahega -- bas backend machine change ho jayegi.
