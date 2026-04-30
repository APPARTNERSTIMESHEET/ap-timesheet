# SETUP — Quick start (Hindi + English)

## Aapko sirf 6 commands chalane hai (Windows / Mac / Linux — sab same)

### 1. Pehle Node.js install karein
Download from https://nodejs.org — LTS version (v18 ya v20 ya v22 — koi bhi).
Install karke terminal/CMD/PowerShell open karein.

### 2. Is folder me jayein
```bash
cd ap-timesheet
```

### 3. Purana node_modules folder delete karein (agar exist karta hai)
**Important:** zip/copy ke time agar koi `node_modules` folder aa gaya ho — usko delete karein, kyunki incomplete ho sakta hai.

Windows PowerShell:
```powershell
Remove-Item -Recurse -Force node_modules
```
Mac / Linux:
```bash
rm -rf node_modules
```

### 4. Dependencies install karein
```bash
npm install
```
Yeh ~1-2 min lega. Ek-do warnings normal hai.

### 5. Environment file copy karein
Windows PowerShell:
```powershell
Copy-Item .env.example .env
```
Mac / Linux:
```bash
cp .env.example .env
```

Open `.env` file in Notepad (or any editor) aur `JWT_SECRET=` line ko ek long random string se replace kar dein. Example:
```
JWT_SECRET=appartners-2026-very-secret-string-mohd-amir-9911503786
```

### 6. Database initialize aur (optional) sample data load karein
```bash
npm run init-db
npm run seed
```

`init-db` default admin banata hai → **`it@appartners.in` / `Admin@123`**
`seed` 4 sample associates aur 3 clients add kar deta hai (skip kar sakte hai agar production data se start karna hai).

### 7. Server start karein
```bash
npm start
```

Output: `AP & Partners Timesheet running on http://localhost:3000`

### 8. Browser me kholein
- **http://localhost:3000** — Login page
- Login karein: `it@appartners.in` / `Admin@123`
- **Sabse pehle password change karein** (top-right me "Password" button hai)

---

## Quick demo flow

1. Login as admin (`it@appartners.in`)
2. Go to **Masters → Clients** → "+ New client" — add a client
3. Go to **Masters → Matters** → "+ New matter" — add a matter for that client, set billing type
4. Go to **Masters → Users** → "+ New user" — add an associate (email + password + default rate)
5. Logout aur associate ke email/password se login karein
6. **New Entry** tab → date, client, matter, hours, description fill karein → Save
7. Wapas admin se login → **Timesheets** → entry dikhegi → "Approve" karein
8. Admin → **Billing** → client + period select → "Preview" → "Generate invoice"
9. Invoice ka PDF auto-download ho jaayega (firm letterhead, tax, totals ke saath)

---

## Office network par sabhi associates ko access dena ho to:

Server jis machine par chal raha hai uska IP nikalein:
```bash
# Windows
ipconfig
# Mac/Linux
ifconfig
```

Apna IPv4 address (e.g. `192.168.1.50`) note karein. Sab associates ko bolo browser me kholein:
```
http://192.168.1.50:3000
```

(Firewall me port 3000 allow karna pad sakta hai — Windows Defender Firewall me "Inbound Rule" add kar dein.)

---

## Internet par expose karna ho to:

1. **Cloudflare Tunnel** (sabse easy, free): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
   - Aapke laptop / office PC se ek HTTPS link mil jaayega jo associates kahin se bhi use kar sakte hain
2. **VPS hosting** (DigitalOcean / AWS Lightsail / Contabo) — production ke liye recommended
3. **Render.com / Railway.app** — managed hosting, but SQLite ke liye paid plan chahiye (persistent disk ke liye)

Detail steps `README.md` me hain.

---

## Backup

Sabse important file: `database/aptimesheet.db` — saara data isi me hai.
`uploads/` folder me sabhi attachments hain.

Daily backup script (cron / Task Scheduler):
```bash
# Linux/Mac (cron)
0 2 * * * cp /path/to/ap-timesheet/database/aptimesheet.db /backups/aptimesheet-$(date +\%Y\%m\%d).db

# Windows (Task Scheduler)
copy "C:\path\to\ap-timesheet\database\aptimesheet.db" "C:\backups\aptimesheet-%DATE:~-4%%DATE:~3,2%%DATE:~0,2%.db"
```

---

## Help / questions

**IT Manager:** Mohd Amir
**Email:** it@appartners.in
**Phone:** +91-9911503786

Logs `server.js` ke same folder me terminal me dikhte hai. Koi error ho to wahan check karein.
