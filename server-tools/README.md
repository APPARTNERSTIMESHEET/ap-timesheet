# AP & Partners Timesheet — Server Mode Setup

Yeh folder aapke laptop ko **24x7 timesheet server** banane ke liye hai.
Iske baad app hamesha background me chalti rahegi, crash hone par auto-restart hogi,
aur Windows reboot ke baad bhi automatically chalu ho jaayegi.

---

## Kya hota hai install.bat se?

1. **PM2** install hota hai (Node.js process manager — production-grade).
2. App PM2 ke under start hoti hai → `http://localhost:3000`
3. PM2 ki state save hoti hai (`pm2 save`).
4. **Windows Task Scheduler** me 2 task register hote hain:
   - `AP-Timesheet-Server` → har boot par PM2 resurrect karta hai
   - `AP-Timesheet-Backup` → daily 2:00 AM par DB + uploads backup leta hai
5. **Power settings** badalti hain — plugged in par laptop kabhi sleep/hibernate nahi hoga.
6. **Windows Firewall** me port 3000 ka inbound allow ho jaata hai (LAN ke liye).
7. Backup `C:\ap-timesheet-backups\` me jaata hai, 30 din rakhta hai.

---

## Setup steps (sirf ek baar)

1. Laptop charger me lagayein, lid open rakhein.
2. `C:\ap-timesheet\server-tools\` folder kholein.
3. **`install.bat`** par right-click → **"Run as administrator"** click karein.
4. ~2 minute wait karein. End me PM2 status table dikhayega.
5. Browser me `http://localhost:3000` kholein. Login: `it@appartners.in` / `Admin@123`
   (agar password pehle change kar diya hai to wahi use karein).
6. **Bas.** Ab app hamesha chalti rahegi.

---

## Daily use ke commands

### GUI-style (`.bat` files double-click)
| File             | Kya karta hai                                |
|------------------|-----------------------------------------------|
| `status.bat`     | Server chal raha hai ya nahi dekho            |
| `start.bat`      | Manually start karo (agar stop kiya tha)      |
| `stop.bat`       | Server band karo                              |
| `restart.bat`    | Restart karo (code change ke baad)            |
| `logs.bat`       | Live logs dekho (Ctrl+C se exit)              |
| `uninstall.bat`  | Server mode hata do (data safe rahega)        |

### Command line (PowerShell / CMD)
```
pm2 status                      # sab apps ka status
pm2 logs ap-timesheet           # live logs
pm2 logs ap-timesheet --lines 200
pm2 restart ap-timesheet
pm2 stop ap-timesheet
pm2 start ap-timesheet
pm2 monit                       # interactive monitor (CPU/memory)
```

---

## Backup

- Automatic backup: daily 2:00 AM par `C:\ap-timesheet-backups\backup_YYYY-MM-DD_HHMM\`
- Manual backup: `server-tools\backup.bat` double-click karo
- Purane backups 30 din ke baad auto-delete hote hain
- Backup folder kabhi-kabhi external HDD / Google Drive par copy kar lijiye

---

## Troubleshooting

**Q: App start hi nahi ho raha?**
A: `logs.bat` chalao, error padho. Most common:
   - Port 3000 already in use → `netstat -ano | findstr :3000` se PID find karo, `taskkill /PID <pid> /F`.
   - Database locked → server stop karke `pm2 restart ap-timesheet`.

**Q: Browser me "site can't be reached"?**
A: `pm2 status` chalao. Agar `errored` hai → `pm2 logs ap-timesheet --lines 50`.

**Q: Laptop restart hua, app nahi chala?**
A: Task Scheduler kholo (`taskschd.msc`), `AP-Timesheet-Server` task check karo —
   "Last Run Result" 0x0 hona chahiye. Manually run karke dekho.

**Q: Office ke baki computers se access karna ho?**
A: Is laptop ka IPv4 nikalo (`ipconfig`), e.g. `192.168.1.50`.
   Sab ko bolo browser me `http://192.168.1.50:3000` kholein.
   (Firewall rule install.bat ne already laga di hai.)

**Q: Internet par expose karna ho?**
A: Cloudflare Tunnel sabse easy aur free hai —
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
   Lekin pehle JWT_SECRET ko `.env` me long random string se replace karo
   aur HTTPS use karo.

---

## Files in this folder

```
server-tools/
├── README.md         ← yeh file
├── install.bat       ← ek baar Admin se chalao
├── uninstall.bat     ← server mode hatao
├── start.bat
├── stop.bat
├── restart.bat
├── status.bat
├── logs.bat
├── backup.bat        ← manual backup
└── resurrect.bat     ← Task Scheduler ne use karta hai (mat chhuna)
```

Aur parent folder me:
```
ap-timesheet/
├── ecosystem.config.js   ← PM2 configuration
└── logs/                 ← PM2 ke log files (yahan se purane delete kar sakte ho)
```

---

**Help:** Mohd Amir — it@appartners.in
