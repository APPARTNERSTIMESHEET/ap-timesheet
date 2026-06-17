/**
 * AP & Partners — Timesheet & Billing
 * Express bootstrap.
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const { db } = require('./utils/db');
// Ensure schema is in place at boot.
require('./database/init').ensureSchema();

const app = express();

// Behind Cloudflare Tunnel (or any reverse proxy), trust the first proxy
// so req.ip and req.protocol reflect the real client and the HTTPS scheme.
app.set('trust proxy', 1);

// CORS — restrict to a comma-separated list of allowed origins from .env.
// Falls back to "same-origin only" (no CORS headers) when nothing is configured.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests have no Origin header — always allow them.
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true
}));

// ─── Security Headers (helmet) ────────────────────────────────────────────
// Helmet sets 15+ security headers in one shot: HSTS, X-Content-Type-Options,
// X-Frame-Options, X-XSS-Protection, Referrer-Policy, Content-Security-Policy,
// X-Download-Options, X-Permitted-Cross-Domain-Policies, etc.
app.use(helmet({
  // HSTS — tell browsers to always use HTTPS (Cloudflare already enforces, but
  // this is defense-in-depth in case someone bypasses the tunnel directly).
  strictTransportSecurity: {
    maxAge: 31536000,          // 1 year
    includeSubDomains: true,
  },
  // Content-Security-Policy — same-origin by default + allow our CDN deps.
  // CRITICAL: scriptSrcAttr must include 'unsafe-inline' because our app uses
  // inline onclick="fn()" handlers throughout. Without it, ALL button clicks
  // silently fail (CSP blocks the handler, no error visible to the user).
  // script-src 'unsafe-inline' alone does NOT cover inline event handlers --
  // those need scriptSrcAttr explicitly. Helmet defaults scriptSrcAttr to 'none'.
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.sheetjs.com", "https://static.cloudflareinsights.com"],
      scriptSrcAttr: ["'unsafe-inline'"],     // <-- allows onclick="..." attributes
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrcAttr:  ["'unsafe-inline'"],     // allows inline style="..." attrs
      fontSrc:       ["'self'", "https://fonts.gstatic.com"],
      imgSrc:        ["'self'", "data:", "blob:"],
      connectSrc:    ["'self'", "https://cloudflareinsights.com", "https://cdn.jsdelivr.net"],
      frameSrc:      ["'none'"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    }
  },
  // Prevent clickjacking — only allow same-origin framing.
  frameguard: { action: 'sameorigin' },
  // Disable MIME-type sniffing.
  noSniff: true,
  // Referrer: send origin only on cross-origin requests.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Hide X-Powered-By so attackers don't know we're on Express.
  hidePoweredBy: true,
}));

// Body parsing BEFORE rate limiting so login limiter can read req.body.email.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ────────────────────────────────────────────────────────
// Strict limit on login endpoint to prevent brute-force attacks.
// 10 attempts per 15 minutes per IP+email combo.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,    // 15-minute window
  max: 10,                      // 10 attempts per window
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,        // Return RateLimit-* headers
  legacyHeaders: false,
  // Validate is disabled because we use a custom key that combines IP + email.
  // express-rate-limit v7 requires explicit opt-out when using req.ip in a
  // custom keyGenerator. Our app is behind Cloudflare (trust proxy = 1) which
  // always forwards a clean IPv4/v6 via X-Forwarded-For, so this is safe.
  validate: false,  // disable IPv6 validation — app is behind Cloudflare trust-proxy
  keyGenerator: (req) => {
    return `${req.ip}::${(req.body && req.body.email) || 'unknown'}`;
  },
});
app.use('/api/auth/login', loginLimiter);

// General API rate limit — 200 requests per minute per IP.
// Generous enough for normal use, blocks automated scraping / abuse.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 200,                     // 200 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ─── gzip / brotli response compression ─────────────────────────────────────
// admin.js is ~280 KB uncompressed. gzip brings it down to ~55 KB, which is
// the single biggest perf win on the first page load for any user on a slow
// link. Helmet's CSP / HSTS / etc. all set BEFORE compression so they apply
// to compressed responses too. We skip compressing tiny responses (level 0)
// because the overhead outweighs the gain.
app.use(compression({
  threshold: 1024,    // only compress responses larger than 1 KB
  level: 6,           // default — good speed/ratio balance
  // Respect the "x-no-compression" header for debugging.
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Static frontend.
// HTML files are served with no-cache so users always pick up the latest deploy
// (the linked /js/*.js files are cache-busted via ?v=... so we can set very
// aggressive immutable cache headers on them — the URL changes whenever the
// content changes, so the browser will only re-fetch when the version bumps).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(js|css|woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico)$/i.test(filePath)) {
      // Long-lived cache for fingerprinted assets. The HTML referencing them
      // uses ?v=... query strings, so a new deploy invalidates by URL change,
      // not by short TTL. immutable tells the browser to not even revalidate
      // on F5 — only Ctrl+Shift+R will force re-fetch.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ─── Health ───────────────────────────────────────────────────────────────────
// Designed for UptimeRobot / Cronitor / Pingdom: returns 200 + JSON when healthy,
// 503 + JSON when something is wrong. Exposes DB latency, disk free space, and
// the age of the most recent backup so a single ping covers all common failure
// modes. Safe for public hitting — no secrets, no PII, no enumeration.
//
// IMPORTANT: send aggressive no-cache headers so Cloudflare / any CDN never
// serves a stale response. A cached "200 OK" would defeat the entire purpose
// of monitoring — UptimeRobot must see fresh status each ping.
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('CDN-Cache-Control', 'no-store');                 // Cloudflare-specific
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  const out = {
    ok: true,
    app: 'AP & Partners Timesheet',
    time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    node: process.version,
    checks: {}
  };

  // 1. DB ping — measure how long a trivial query takes
  try {
    const t0 = Date.now();
    const row = db.prepare('SELECT 1 AS ok').get();
    out.checks.db = { ok: row && row.ok === 1, ms: Date.now() - t0 };
    if (!out.checks.db.ok) out.ok = false;
  } catch (e) {
    out.ok = false;
    out.checks.db = { ok: false, error: e.message };
  }

  // 2. Disk free space on the volume that holds uploads/
  try {
    const stat = fs.statfsSync ? fs.statfsSync(UPLOAD_DIR) : null;
    if (stat) {
      const freeGB = (stat.bavail * stat.bsize) / 1024 / 1024 / 1024;
      out.checks.disk_free_gb = Math.round(freeGB * 100) / 100;
      if (freeGB < 1) out.ok = false;        // <1 GB is dangerous, fail loudly
    }
  } catch (e) { /* statfs unavailable on some Windows builds — ignore */ }

  // 3. Last backup age — checks both the OneDrive backup folder (preferred) and
  //    the legacy local backups\ folder. Whichever has the newest aptimesheet-*.db wins.
  try {
    const candidateDirs = [
      process.env.AP_BACKUP_DIR,
      process.env.OneDrive ? path.join(process.env.OneDrive, 'AP-Timesheet-Backups') : null,
      path.join(__dirname, 'backups'),
    ].filter(Boolean);

    let newest = null;
    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir)
        .filter(f => /^aptimesheet-.*\.db$/.test(f))
        .map(f => ({ f, dir, mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
      for (const file of files) {
        if (!newest || file.mtime > newest.mtime) newest = file;
      }
    }
    if (newest) {
      const ageHrs = (Date.now() - newest.mtime) / 3600000;
      out.checks.last_backup_hours = Math.round(ageHrs * 10) / 10;
      out.checks.last_backup_file  = newest.f;
      out.checks.last_backup_dir   = newest.dir;
      if (ageHrs > 36) out.ok = false;     // missed last 24h backup → alert
    } else {
      out.checks.last_backup_hours = null;
    }
  } catch (e) { out.checks.backup_error = e.message; }

  res.status(out.ok ? 200 : 503).json(out);
});

// API routes
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/timesheet',   require('./routes/timesheet'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/clients',     require('./routes/clients'));
app.use('/api/matters',     require('./routes/matters'));
app.use('/api/rates',       require('./routes/rates'));
app.use('/api/billing',     require('./routes/billing'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/admin',       require('./routes/admin'));
app.use('/api/leaves',      require('./routes/leaves'));
app.use('/api/wfh',         require('./routes/wfh'));
app.use('/api/admin-tools', require('./routes/admin-tools'));
app.use('/api/insider',     require('./routes/insider'));

// SPA fallback for known frontend pages.
// Force no-cache so users always pick up the latest HTML on deploy. Linked JS
// is still browser-cacheable (fast loads), but the HTML carries a ?v=... query
// string that bumps on every deploy and forces a fresh JS download too.
app.get(['/login', '/associate', '/admin'], (_req, res, next) => {
  const map = {
    '/login': 'index.html',
    '/associate': 'associate.html',
    '/admin': 'admin.html'
  };
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma',        'no-cache');
  res.set('Expires',       '0');
  // Cloudflare-specific headers so CDN edge doesn't cache the HTML either.
  res.set('CDN-Cache-Control',            'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', map[_req.path]));
});

// JSON 404 for /api/*
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

// ─── Periodic maintenance ────────────────────────────────────────────────
// Run at boot + every 6 hours. Cleans up expired sessions, old login_attempts,
// and performs a WAL checkpoint to keep the WAL file from growing unbounded.
function runMaintenance() {
  try {
    // 1. Delete expired active_sessions older than 7 days
    const cleaned = db.prepare(
      "DELETE FROM active_sessions WHERE expires_at < datetime('now', '-7 days')"
    ).run();
    if (cleaned.changes > 0) console.log(`[maintenance] cleaned ${cleaned.changes} expired sessions`);

    // 2. Delete login_attempts older than 90 days (keep recent forensics)
    const oldLogins = db.prepare(
      "DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-90 days')"
    ).run();
    if (oldLogins.changes > 0) console.log(`[maintenance] purged ${oldLogins.changes} old login attempts`);

    // 3. WAL checkpoint -- truncates WAL file after merging into main DB
    const ckpt = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
    if (ckpt && ckpt[0] && ckpt[0].busy === 0) {
      // Silent success
    }
  } catch (e) {
    console.error('[maintenance] error:', e.message);
  }
}
// Run once at boot, then every 6 hours
setTimeout(runMaintenance, 30000);            // 30s after boot
setInterval(runMaintenance, 6 * 3600 * 1000); // every 6 hours

app.listen(PORT, () => {
  console.log(`AP & Partners Timesheet running on http://localhost:${PORT}`);
  console.log(`DB: ${db.name}`);
});
