# Optional: Office LAN par fast access

Cloudflare Tunnel internet ke through route karta hai (Cloudflare → laptop). Yeh secure hai par office me **same WiFi par** kabhi-kabhi slightly slow lagta hai, aur internet down ho to access nahi hota.

Iska fix: **office machines ke hosts file me ek line add karke** `timesheet.appartners.in` ko seedha laptop ke LAN IP par bhej do. Internet round-trip skip ho jaayegi.

**Note:** Yeh sirf HTTP par chalega (no HTTPS), warning aayegi browser me. Yeh sirf office LAN ke liye hai, internet par to HTTPS hi rahega.

---

## Steps (har office machine par ek baar)

### Pehle laptop ka LAN IP nikalo (server wali machine par):

Admin CMD:
```
ipconfig | findstr IPv4
```
Result jaisa: `IPv4 Address . . . . . . . . . . . : 192.168.1.50`
Yeh IP note karo.

---

### Office ki har machine par:

1. **Notepad** ko **Run as administrator** se kholo
2. File → Open
3. Path likho: `C:\Windows\System32\drivers\etc\hosts`
4. File type "All Files" karo (`.txt` ke alawa dikhane ke liye)
5. `hosts` file select karo → Open
6. File ke end me yeh line add karo (apna IP use karo):
   ```
   192.168.1.50    timesheet.appartners.in
   ```
7. Save (Ctrl+S)

### Test:

Us machine par CMD me:
```
ping timesheet.appartners.in
```
Reply `192.168.1.50` se aana chahiye (Cloudflare IP nahi).

Browser me kholo: `http://timesheet.appartners.in:3000` (port :3000 zaruri hai is mode me, kyunki HTTPS bypass hua)

**Better experience ke liye** — Step 3 me chote sa nginx ya Caddy local pe lagana padega taaki port :3000 hatakar `http://timesheet.appartners.in` se direct kaam kare. Wo baad me karenge agar zaroorat lage.

---

## Best practice (recommendation)

- **Sabhi associates / clients / bahar wale** → `https://timesheet.appartners.in` (Cloudflare ke through, HTTPS)
- **Sirf office WiFi par jab internet slow ho** → hosts file wala fallback

Bahar wale ke liye HTTPS valid certificate matlab browser warning nahi, lawyers / clients ko confidence rahega.
