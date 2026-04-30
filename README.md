# AP & Partners — Timesheet & Billing

A self-hosted timesheet and billing web application built for **AP & Partners (Advocates & Solicitors)**.
Associates log time entries against clients/matters; admin (IT Manager / Partners) approves entries,
manages masters (users, clients, matters, rate cards), generates client invoices as PDF, and runs reports.

**IT Owner:** Mohd Amir — it@appartners.in — +91 9911503786

---

## Features

**For associates**
- Login with email + password (JWT session)
- Daily timesheet entry: Date, Client, Matter / File No., Activity type, Task description, Start/End time (auto computes hours), Hours, Billable Y/N, Notes
- Attach documents to entries (PDF, DOCX, images, etc.)
- View / edit own entries (until they're locked/approved)
- See own monthly summary

**For admin**
- View / edit / approve / reject **all** entries from any associate
- Lock periods so associates can't change submitted timesheets
- Manage **masters**: users (associates), clients, matters, rate cards
- **Billing**: configure each matter as
  - Hourly rate per associate
  - Hourly rate per client/matter
  - Flat fee
  - Retainer (advance balance)
- **Generate client invoices (PDF)**: pick client + date range → auto-creates invoice with line items, tax, totals
- **Reports** by associate / client / matter / period — exportable as CSV
- Dashboard with KPIs (billable hours, billable value, pending approvals)

**Tech**
- Node.js 18+ / Express
- SQLite (single file, zero-config — `better-sqlite3`)
- JWT auth + bcrypt password hashing
- PDFKit for invoices
- Multer for attachments
- Vanilla HTML / CSS / JS frontend (no build step)

---

## Quick start (local)

```bash
# 1. Install Node.js 18+ from https://nodejs.org
# 2. Open a terminal in this folder
cd ap-timesheet

# 3. Install dependencies
npm install

# 4. Configure environment
cp .env.example .env
# Edit .env — set JWT_SECRET to a long random string

# 5. Initialise the database (creates tables + a default admin)
npm run init-db

# 6. (Optional) Seed sample data — sample users, clients, matters
npm run seed

# 7. Start the server
npm start
```

Open http://localhost:3000 in your browser.

**Default admin login** (created by `init-db`):
- Email: `it@appartners.in`
- Password: `Admin@123` — **change immediately** after first login.

---

## Deploying to a server

This is a standard Node app. Any of the following will work:

| Option | Notes |
| --- | --- |
| Your own VPS (DigitalOcean / Contabo / AWS Lightsail / Hetzner) | Cheapest. Use `pm2` to keep the process alive, nginx in front for HTTPS. |
| Render.com / Railway.app / Fly.io | Push the repo, set env vars, done. SQLite needs a persistent volume — Render's free tier does not provide one, paid tier does. |
| Internal office machine | Run `npm start` and expose port 3000 over the LAN, or use Cloudflare Tunnel for remote access. |

For multi-user production usage:
1. Set `NODE_ENV=production` and a strong `JWT_SECRET` in `.env`.
2. Run behind nginx/caddy with HTTPS.
3. Back up the SQLite file (`database/aptimesheet.db`) and the `uploads/` folder regularly — both contain all data.
4. If you outgrow SQLite, the schema is portable to PostgreSQL with minor changes.

---

## API overview

All endpoints (except `/api/auth/login`) require `Authorization: Bearer <token>` header.

```
POST   /api/auth/login                       { email, password } → { token, user }
GET    /api/auth/me

# Timesheet (any logged-in user)
GET    /api/timesheet                        ?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=...
POST   /api/timesheet                        create entry (with optional file)
PATCH  /api/timesheet/:id                    edit entry (own, or admin)
DELETE /api/timesheet/:id                    delete entry (own & not approved, or admin)
GET    /api/timesheet/:id/attachment         download attachment

# Admin only
POST   /api/admin/timesheet/:id/approve
POST   /api/admin/timesheet/:id/reject

GET    /api/users      POST /api/users     PATCH /api/users/:id   DELETE /api/users/:id
GET    /api/clients    POST /api/clients   PATCH /api/clients/:id DELETE /api/clients/:id
GET    /api/matters    POST /api/matters   PATCH /api/matters/:id DELETE /api/matters/:id
GET    /api/rates      POST /api/rates     DELETE /api/rates/:id

# Billing
GET    /api/billing/preview?client_id=..&from=..&to=..    line-item preview
POST   /api/billing/invoices                              create invoice
GET    /api/billing/invoices                              list
GET    /api/billing/invoices/:id/pdf                      download PDF
PATCH  /api/billing/invoices/:id                          mark paid / cancel

# Reports
GET    /api/reports/summary?from=..&to=..&group_by=user|client|matter
```

---

## Folder layout

```
ap-timesheet/
├── server.js                # Express bootstrap
├── package.json
├── .env.example
├── README.md
├── database/
│   ├── init.js              # creates tables + default admin
│   ├── seed.js              # sample data (optional)
│   └── aptimesheet.db       # generated on first run
├── middleware/
│   └── auth.js              # JWT + role guards
├── utils/
│   ├── db.js                # SQLite connection
│   └── invoice.js           # PDF invoice generator
├── routes/
│   ├── auth.js
│   ├── timesheet.js
│   ├── users.js
│   ├── clients.js
│   ├── matters.js
│   ├── rates.js
│   ├── billing.js
│   ├── reports.js
│   └── admin.js
├── public/                  # served as static
│   ├── index.html           # login
│   ├── associate.html       # timesheet entry app
│   ├── admin.html           # admin console
│   ├── css/styles.css
│   └── js/{auth,common,associate,admin}.js
└── uploads/                 # attachments (per-entry, hashed filenames)
```

---

## Roadmap (next iterations)

- Email notifications (entry approved / rejected, invoice sent)
- 2FA for admin accounts
- Bulk import of clients & matters from Excel
- Payment gateway hook (Razorpay) on invoice
- Mobile-friendly PWA shell
- Tally / Zoho Books export

---

© AP & Partners. All rights reserved.
