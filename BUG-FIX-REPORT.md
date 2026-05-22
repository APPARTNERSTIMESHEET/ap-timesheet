# AP & Partners Timesheet — Bug Fix & Improvement Report

**Reviewer:** Claude (automated code review)
**Date:** 2026-05-11
**Scope:** Full backend (`server.js`, `routes/`, `utils/`, `middleware/`, `database/`), config files, README.

---

## 1. Summary

Codebase overall mein **well-structured** hai — Express + better-sqlite3 + JWT + PDFKit ka clean separation hai, schema migrations safe hain (column-add via try/catch), aur invoice PDF generation kaafi sophisticated hai (CGST/SGST/IGST handling, reverse-charge, multi-firm-entity, draft watermark, etc.).

Lekin review mein **18 bugs aur security issues** mile, jisme se **17 fix kar diye** gaye hain. 1 stale duplicate file (`public/js/admin_fixed.js`) chhod diya hai — usko delete karna safe hai but aap khud confirm karein.

Sath hi **6 manual actions** chahiye jo code se nahi ho sakte (e.g. SMTP password rotate karna, JWT secret regenerate karna).

---

## 2. CRITICAL — Manual action chahiye (sabse pehle ye karein)

### 2.1 SMTP password leak ho gaya — turant rotate karein
`.env` file mein real Office 365 password `Welcome@$1298` plain text mein hai. `.env` `.gitignore` mein hai (good), lekin agar yeh file kabhi share hui ho — backup, USB, email, Slack, screen-share, anything — to attacker mailbox use kar sakta hai. **Aaj hi**:

1. Office 365 admin portal mein jaake `accounts@appartners.in` ka password change karein.
2. `.env` mein new password daalein.
3. PM2 restart: `pm2 restart ap-timesheet`.

### 2.2 JWT_SECRET cryptographically weak hai
Current value `appartners-2026-mohd-amir-9911503786-secret` guess-able hai (firm + year + IT manager phone). Attacker isse forge token bana ke admin ban sakta hai.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Output ko `.env` mein `JWT_SECRET=` ke baad paste karein. Restart server. **Note:** Restart hone par sab existing logged-in users ko fir se login karna padega — yeh expected hai.

(Code mein safety check daal di hai — production mein ab default secret accept hi nahi hoga, server start hi nahi karega.)

### 2.3 Login rate-limiting nahi hai
`/api/auth/login` par koi throttle nahi hai. Attacker brute-force se passwords guess kar sakta hai, especially weak passwords par.

**Fix:** `npm install express-rate-limit` aur `server.js` mein:
```js
const rateLimit = require('express-rate-limit');
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10 }));
```

Mein automatically install nahi kiya kyunki dependency add karne se aapka `package-lock.json` change hoga aur deployment workflow par asar pad sakta hai. Aap install kar lein, restart kar lein, done.

### 2.4 SMTP TLS verification disabled hai (`rejectUnauthorized: false`)
`middleware/auth.js` aur `routes/billing.js` dono mein `tls: { rejectUnauthorized: false }` hai. Yeh man-in-the-middle attack ke liye open hai. Office 365 ke valid cert hote hain — agar `requireTLS: true` set hai (jo hai) to `rejectUnauthorized` ko `true` rakhna safe hai. Test karke hata dein.

### 2.5 JWT token query-parameter mein accept hota hai (`?token=...`)
`middleware/auth.js` mein PDF download ke liye query token allow kiya gaya hai. Yeh token Cloudflare/nginx access logs mein, browser history mein, aur referer headers mein leak ho jata hai. **Better approach:** PDF download ke liye ek short-lived signed download URL banayein (5 minute validity) jisme `?signature=...&exp=...` ho — ya cookie-based auth use karein. Filhal as-is rakha hai kyunki frontend break ho jata; please plan karein.

### 2.6 `database/aptimesheet.db` git mein committed hai
`.gitignore` mein `database/*.db` aur `database/*.db-journal` hain, lekin `.db-wal` aur `.db-shm` files committed ho rahi hain. Aur DB file khud kabhi commit ho gayi thi (initial commit `7c6af29 timesheet app` mein). Production data git mein nahi jana chahiye.

```bash
git rm --cached database/aptimesheet.db database/aptimesheet.db-shm database/aptimesheet.db-wal
echo "database/*.db-shm" >> .gitignore
echo "database/*.db-wal" >> .gitignore
git commit -m "stop tracking sqlite runtime files"
```

---

## 3. Bugs jo fix kar diye gaye

### 3.1 `routes/users.js` — 'partner' role create nahi ho sakta tha
Route validation mein `'partner'` allowed tha but DB ke CHECK constraint mein nahi. Result: partner user create karne pe SQLite error throw hota tha, aur catch nahi tha. **Fix:** `'partner'` ko allow list se hata diya — partner ek **designation** hai, role nahi (jaisa middleware/auth.js comment khud kehta hai).

### 3.2 `routes/timesheet.js` — `billing` role ko 403 milta tha entry view par
Line 78 par check tha `req.user.role !== 'admin'` — sirf 'admin' dekhta tha, 'billing' role bhi entry dekhna chahta to 403 milta. Baaki sab places mein `['admin','billing']` use ho raha hai. **Fix:** Consistent check `['admin','billing'].includes(req.user.role)` lagaya.

### 3.3 `routes/timesheet.js` — admin/billing dusre ke liye entry create nahi kar sakte the
Line 89 par `req.user.role === 'admin'` tha — billing role ne dusre user ka time enter karna chaha to apni hi ID save hoti. **Fix:** Ab dono allowed.

### 3.4 `routes/timesheet.js` — 0 hours / NaN hours validation buggy
`if (!hours)` — 0 hours falsy hai, but message `hours/start+end required` confusing tha; aur invalid `parseFloat` se NaN bhi pass ho sakta tha (NaN truthy hai? actually falsy via `!hours` — but error message galat). **Fix:** Explicit check `hours == null || NaN || <= 0` se proper error.

### 3.5 `routes/timesheet.js` — matter-client mismatch validate nahi hota tha
User ek client choose karke kisi aur client ka matter_id POST kar sakta tha (frontend dropdown ke baahar API directly hit karke). Result: orphan entry. **Fix:** POST par DB se matter ka client_id verify karte hain.

### 3.6 `utils/billing.js` — `rateForUserOnMatter` future-dated rates use karta tha (CRITICAL billing bug)
Old query: `ORDER BY effective_from DESC LIMIT 1` — kisi associate ka rate Jan 2026 se ₹5000/hr set kar diya, to **December 2025 ke entries bhi ₹5000/hr** se bill ho jate the. Yeh client invoices retroactively change kar deta tha.
**Fix:** `effective_from <= entry_date` filter add kiya. Ab har entry ka rate uske date par jo applicable tha wahi use hoga. Same fix `utils/invoice-pdf.js` ke `rateForUser` mein bhi.

### 3.7 `routes/billing.js` — invoice cancel par approved entries reset hote the as 'submitted'
Line 184 par cancel ke time entries ka status `'submitted'` ho jata tha — lekin woh actually `'approved'` thi pehle se. Approval audit trail loss hota tha aur fir se approve karna padta tha. **Fix:** Cancel par `'approved'` set karte hain.

### 3.8 `routes/billing.js` — `paid_at` clear nahi hota tha agar status paid se kuch aur ho
Status 'paid' → 'issued' (galat mark kiya tha) → `paid_at` rehta tha → outstanding report galat dikhati. **Fix:** Status transition out-of-paid par `paid_at = NULL` set karte hain.

### 3.9 `routes/admin.js` — `bulk-approve` ne hamesha total count return karta
Pehle `count: ids.length` return hota tha bina dekhe ki kitne actually approve hue. Already-invoiced entries bhi count mein chale jate the. **Fix:** Ab `requested`, `approved`, `skipped` separately return karta hai.

### 3.10 `utils/billing.js` — `nextInvoiceNumber` mein potential race
`ORDER BY id DESC LIMIT 1` se latest invoice nikalta tha — par agar kisi ne purane saal ki invoice baad mein insert ki, to wrong sequence aata. **Fix:** `MAX(parsed seq number)` use karta hai. (Note: full SERIAL transaction lock SQLite mein limited hai — for safety, invoice creation ko sequential rakha hai by being inside transaction in `createInvoice`.)

### 3.11 `routes/users.js`, `routes/clients.js`, `routes/matters.js` — DELETE ne timesheet history nuke kar di thi (CRITICAL data-loss risk)
Pehle DELETE user, client, ya matter karne par sab linked timesheet entries `DELETE` ho jate the — billing history, audit trail, sab gone. Law firm ke liye yeh **acceptable nahi** hai (statutory record-keeping requirements).

**Fix:** Default DELETE ab **soft-delete** karta hai (`is_active=0` for users/clients, `status='closed'` for matters). Hard delete sirf `?hard=true` query param se hota hai aur tab bhi:
- User mein timesheet entries hain → 409 Conflict
- Client mein invoices hain → 409 Conflict
- Matter mein invoice line items hain → 409 Conflict

Yeh data ko safe rakhta hai aur "oops mistake" cases mein recoverable banata hai.

### 3.12 `routes/matters.js` — PATCH par `billing_type` aur `status` validate nahi hote the
POST par check tha but PATCH par koi validation nahi — admin DB ko corrupt status mein laa sakta tha (e.g., `status='archived'` jo schema CHECK ko violate karta hai → 500 error). **Fix:** PATCH par bhi same validation.

### 3.13 `routes/admin.js` — bulk-approve ne `rejection_note` clear nahi kiya
Single approve karta hai but bulk approve ne purane reject ka note rakh diya. **Fix:** `rejection_note=NULL` add kiya.

### 3.14 `middleware/auth.js` — JWT secret production mein default fallback accept karta tha
`process.env.JWT_SECRET || 'dev-secret-change-me'` — agar `.env` load nahi hua to insecure secret use ho jata. **Fix:** Production mein server start hi nahi karega bina secret ke; aur 32 char minimum bhi enforce karta hai.

### 3.15 `start-timesheet.bat` — hardcoded path galat tha
`cd /d "C:\Users\Sayed Noor\Downloads\ap-timesheet"` — yeh path kisi aur machine ka hai (purana developer). README aur ecosystem.config.js says `C:\ap-timesheet`. **Fix:** `cd /d "%~dp0"` — batch file jis folder mein hai wahi use karta hai. Aur `pm2 start ecosystem.config.js` use karta hai (consistent logging, memory limits).

### 3.16 `README.md` — `utils/invoice.js` reference (file actually `utils/invoice-pdf.js`)
Folder layout section mein wrong filename. Aur `utils/billing.js` toh listed bhi nahi tha. **Fix:** Updated.

### 3.17 `server.js` — wide-open CORS aur missing security headers
`app.use(cors())` har origin ko allow karta tha. **Fix:** `ALLOWED_ORIGINS` env var se restrict (blank rakha to same-origin only). Plus basic headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.

`.env.example` mein `ALLOWED_ORIGINS=` field add ki hai — production deployment se pehle apna domain (e.g., `https://timesheet.appartners.in`) daal dein.

---

## 4. Open issues — recommend kiye, fix nahi kiye (need your decision)

### 4.1 `public/js/admin_fixed.js` — stale duplicate file
Ye file May 1 ka hai, aur `admin.js` se 1000+ lines chhoti hai. `admin.js` May 11 ka updated version hai. Koi HTML page isse load nahi karta (verify kar lein), so ye dead code hai. **Recommendation:** delete kar dein. Mein automatically delete nahi kar raha, kyunki kabhi-kabhi developer "_fixed" suffix se experimental backup rakhte hain.

```bash
del C:\ap-timesheet\public\js\admin_fixed.js
```

### 4.2 Token in `localStorage` (XSS exposure)
`public/js/common.js` mein JWT `localStorage` mein store hota hai. XSS vulnerability ho to attacker token chura le. Better: **httpOnly cookie** use karein. Lekin yeh frontend-wide refactor hai aur scope se bahar tha.

### 4.3 Frontend `innerHTML` heavy use (57 occurrences)
`escapeHtml` zyaadatar jagah use hota hai (good), but har occurrence audit karna chahiye. Khaaska user-supplied fields (entry description, notes, client name) jab template literals mein interpolate hote hain.

### 4.4 File upload — koi MIME type allowlist nahi
`multer` 15 MB tak kuch bhi accept karta hai. Attacker `.exe` upload karke bhi save kar sakta hai. Although download `Content-Disposition: attachment` se forced hai (so browser execute nahi karega), better practice hai allowlist:
```js
fileFilter: (req, file, cb) => {
  const ok = ['application/pdf', 'image/jpeg', 'image/png',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/msword'].includes(file.mimetype);
  cb(ok ? null : new Error('File type not allowed'), ok);
}
```

### 4.5 Password complexity nahi enforce hoti
8 char minimum hai, but no digit/symbol/uppercase requirement. Law firm sensitive data ke liye 12+ char + complexity recommended. Plus periodic rotation policy (90-day expiry) consider karein.

### 4.6 No JWT revocation mechanism
Agar koi laptop chori ho jaye, ya kisi associate ko fire kar dein, to woh JWT expire hone tak (8 hours) valid rahega. **Mitigation:** Login ke time `users.token_version` increment karein (DB column add karna padega), aur `authRequired` mein verify karein. Ya simpler: server-side session table maintain karein.

### 4.7 No automated tests
Koi unit/integration test nahi hain. Refactor ya naya feature add karte time silently break hone ka risk hai. **Recommendation:** Critical paths ke liye Vitest/Jest setup karein — billing engine (`buildInvoicePreview`), `nextInvoiceNumber`, role-based authz.

### 4.8 `routes/clients.js` GET `/` sirf active clients dikhata hai
Admin ko inactive bhi dikhna chahiye (taaki reactivate kar sake). Add `?include_inactive=true` query support.

### 4.9 No request logging
Production mein `morgan` ya equivalent helpful hota hai for debugging. PM2 logs request data nahi capture karte.

---

## 5. Files Modified Summary

| File | Reason |
|---|---|
| `server.js` | CORS restrict + security headers |
| `middleware/auth.js` | Production JWT secret enforcement |
| `routes/auth.js` | (no changes — recommend rate-limit separately) |
| `routes/admin.js` | Bulk-approve count + rejection_note clear |
| `routes/billing.js` | paid_at sync + cancel restores 'approved' |
| `routes/clients.js` | Soft-delete by default |
| `routes/matters.js` | Soft-close by default + PATCH validation |
| `routes/timesheet.js` | Role consistency + hours/matter validation |
| `routes/users.js` | Remove invalid 'partner' role + soft-delete |
| `utils/billing.js` | effective_from rate filter + safer invoice numbering |
| `utils/invoice-pdf.js` | effective_from rate filter |
| `start-timesheet.bat` | Use %~dp0 + ecosystem.config.js |
| `README.md` | Correct utils/ filenames |
| `.env.example` | Add ALLOWED_ORIGINS + SMTP block + secret warning |

---

## 6. Next steps (priority order)

1. **Today:** Rotate SMTP password in Office 365, regenerate JWT_SECRET, restart server.
2. **This week:** `npm install express-rate-limit`, add login throttling, set `ALLOWED_ORIGINS` in `.env`, remove `database/*.db*` from git.
3. **This month:** Decide on httpOnly cookie auth; add file MIME allowlist; pick a test framework and write basic tests for the billing engine (it does the most math).
4. **Roadmap:** JWT revocation, password complexity, request logging, SMTP TLS verification re-enable.

---

**Questions ya kuch aur fix karna ho to bata dein.**
