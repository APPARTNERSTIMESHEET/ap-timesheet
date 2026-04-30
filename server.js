/**
 * AP & Partners — Timesheet & Billing
 * Express bootstrap.
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const { db } = require('./utils/db');
// Ensure schema is in place at boot.
require('./database/init').ensureSchema();

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'AP & Partners Timesheet',
    time: new Date().toISOString()
  });
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

// SPA fallback for known frontend pages
app.get(['/login', '/associate', '/admin'], (_req, res, next) => {
  const map = {
    '/login': 'index.html',
    '/associate': 'associate.html',
    '/admin': 'admin.html'
  };
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

app.listen(PORT, () => {
  console.log(`AP & Partners Timesheet running on http://localhost:${PORT}`);
  console.log(`DB: ${db.name}`);
});
