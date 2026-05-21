# Cloudflare Tunnel — timesheet.appartners.in

Yeh setup `https://timesheet.appartners.in` ko laptop ke `localhost:3000` se connect karta hai.

**Faayda:**
- Internet par kahin se bhi accessible (office, ghar, mobile data)
- HTTPS automatic (free SSL certificate)
- Port forwarding NAHI chahiye router me
- Aapka public IP hidden rahega
- Cloudflare ka DDoS protection free me mil jaata hai
- Free plan kaafi hai (1000+ tunnels free)

---

## Setup steps (Dashboard + 1 CLI command)

### Step 1 — Cloudflare Zero Trust dashboard kholo

1. Browser me jao: **https://one.dash.cloudflare.com**
2. Apne Cloudflare account se login karo (wahi jisse `appartners.in` manage karte ho)
3. **Pehli baar** jaa rahe ho to:
   - Team name pucha jaayega — koi bhi name dal do (e.g. `appartners`)
   - Free plan select karo (`50 users` tak free)
   - Payment method add karna pad sakta hai (free plan ke liye bhi card maangta hai, charge nahi karta)

### Step 2 — Tunnel banao

Left sidebar me:

1. **Networks** → **Tunnels**
2. **Create a tunnel** button
3. Tunnel type: **Cloudflared** → Next
4. Tunnel name: **`ap-timesheet`** → Save tunnel
5. "Install and run a connector" page khulegi
6. **Choose your environment:** Windows → **64-bit**
7. **Big command** dikhayega — kuch aisa:
   ```
   cloudflared.exe service install eyJhIjoi...long-token-here...
   ```
8. **Copy** karo us command ko

### Step 3 — Laptop par command run karo

1. **Admin CMD** kholo (Start menu → "cmd" → right-click → Run as administrator)
2. Wahi command paste karke Enter dabao:
   ```
   cloudflared.exe service install eyJhIjoi...
   ```
3. Yeh automatically:
   - cloudflared download karega (~30 MB)
   - Windows service install karega ("Cloudflared" naam se)
   - Service start karega
   - Aapke account se connect karega
4. ~30 second me Cloudflare dashboard me **Connectors** ke neeche aapke laptop ka name dikhega — "Connected" hara dot.

### Step 4 — Public hostname add karo

Dashboard me wapas aao (Step 2 ke continuation me):

1. **Next** button
2. **Public Hostnames** tab par jao
3. **Add a public hostname**:
   - **Subdomain:** `timesheet`
   - **Domain:** `appartners.in` (dropdown se select karo)
   - **Path:** khali chhod do
   - **Service Type:** `HTTP`
   - **URL:** `localhost:3000`
4. **Save hostname**

Bas! Cloudflare automatically DNS me CNAME entry add kar dega.

### Step 5 — Test karo

1. Naya browser tab kholo
2. Type karo: `timesheet.appartners.in`
3. Login page khulna chahiye (HTTPS lock icon ke saath)
4. **Phone par mobile data se** bhi try karo — kaam karega ✅

---

## Troubleshooting

**Q: Browser me "DNS_PROBE_FINISHED_NXDOMAIN"**
A: DNS propagate hone me 1-2 min lagta hai. Wait karo. Phir incognito mode me try karo.

**Q: "522: Connection timed out"**
A: Mtlb cloudflared service connected hai par localhost:3000 nahi mil raha:
- Admin CMD me: `pm2 status` — `ap-timesheet` `online` hona chahiye
- `pm2 logs ap-timesheet` se errors check karo

**Q: Cloudflare connector me red dot (Disconnected)?**
A: Services kholo (`services.msc`) → "Cloudflared" service search karo → Start karo
   Ya CMD me: `sc start cloudflared`

**Q: Service running par hostname kaam nahi kar raha?**
A: Dashboard me Public Hostnames check karo, `timesheet.appartners.in` add hua hai ya nahi.
   DNS tab me bhi check karo — CNAME entry honi chahiye `timesheet → <tunnel-id>.cfargotunnel.com`

---

## Reboot par auto-start?

Haan automatic — `cloudflared.exe service install` ne ise Windows Service banaya hai jiska Startup Type **"Automatic"** hai. Reboot ke baad bhi connect ho jaayega.

Manual check:
```
sc query cloudflared
```
Status `RUNNING` hona chahiye.

---

## Cloudflared uninstall karna ho to

Admin CMD me:
```
cloudflared.exe service uninstall
```

Cloudflare dashboard me jaake tunnel bhi delete kar dena.

---

**Help:** Mohd Amir — it@appartners.in
