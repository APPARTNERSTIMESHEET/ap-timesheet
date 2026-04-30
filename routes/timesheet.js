const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db } = require('../utils/db');
const { authRequired } = require('../middleware/auth');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '15', 10);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${stamp}-${rand}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 }
});

const router = express.Router();

function hoursFromTimes(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return null;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// GET entries (own; admin can pass user_id=any or all)
router.get('/', authRequired, (req, res) => {
  const { from, to, user_id, client_id, matter_id, status } = req.query;
  const isAdmin = req.user.role === 'admin';
  const conds = [];
  const params = [];
  if (!isAdmin) { conds.push('t.user_id = ?'); params.push(req.user.id); }
  else if (user_id) { conds.push('t.user_id = ?'); params.push(user_id); }
  if (from) { conds.push('t.entry_date >= ?'); params.push(from); }
  if (to)   { conds.push('t.entry_date <= ?'); params.push(to); }
  if (client_id) { conds.push('t.client_id = ?'); params.push(client_id); }
  if (matter_id) { conds.push('t.matter_id = ?'); params.push(matter_id); }
  if (status) { conds.push('t.status = ?'); params.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*, u.full_name AS user_name,
           c.name AS client_name, c.code AS client_code,
           m.file_no, m.title AS matter_title,
           (SELECT COUNT(*) FROM attachments a WHERE a.entry_id = t.id) AS attachment_count
    FROM timesheet_entries t
    JOIN users   u ON u.id = t.user_id
    JOIN clients c ON c.id = t.client_id
    JOIN matters m ON m.id = t.matter_id
    ${where}
    ORDER BY t.entry_date DESC, t.id DESC
  `).all(...params);
  res.json({ entries: rows });
});

router.get('/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`
    SELECT t.*, u.full_name AS user_name, c.name AS client_name,
           m.file_no, m.title AS matter_title
    FROM timesheet_entries t
    JOIN users u ON u.id = t.user_id
    JOIN clients c ON c.id = t.client_id
    JOIN matters m ON m.id = t.matter_id
    WHERE t.id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Entry not found' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const attachments = db.prepare('SELECT id, original_name, mimetype, size_bytes FROM attachments WHERE entry_id = ?').all(id);
  res.json({ entry: row, attachments });
});

// Create entry (with optional attachment as field "file")
router.post('/', authRequired, upload.single('file'), (req, res) => {
  const b = req.body || {};
  // Accept admin passing user_id, otherwise self
  const userId = (req.user.role === 'admin' && b.user_id) ? parseInt(b.user_id, 10) : req.user.id;

  let hours = b.hours ? parseFloat(b.hours) : hoursFromTimes(b.start_time, b.end_time);
  if (!b.entry_date || !b.client_id || !b.matter_id || !b.activity_type || !b.description || !hours) {
    return res.status(400).json({ error: 'entry_date, client_id, matter_id, activity_type, description and hours/start+end required' });
  }
  const status = (b.status === 'draft' ? 'draft' : 'submitted');
  const isBillable = (b.is_billable === undefined || b.is_billable === null)
                     ? 1 : (b.is_billable === '0' || b.is_billable === false || b.is_billable === 'false' ? 0 : 1);

  const info = db.prepare(`
    INSERT INTO timesheet_entries
      (user_id, client_id, matter_id, entry_date, start_time, end_time, hours,
       activity_type, description, notes, is_billable, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, b.client_id, b.matter_id, b.entry_date,
    b.start_time || null, b.end_time || null, hours,
    b.activity_type, b.description, b.notes || null, isBillable, status
  );

  if (req.file) {
    db.prepare(`
      INSERT INTO attachments (entry_id, filename, original_name, mimetype, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(info.lastInsertRowid, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  }

  res.json({ id: info.lastInsertRowid });
});

// Edit entry
router.patch('/:id', authRequired, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && entry.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!isAdmin && ['approved','invoiced'].includes(entry.status)) {
    return res.status(400).json({ error: 'Entry locked (approved/invoiced) — contact admin' });
  }

  const b = req.body || {};
  const allowed = ['client_id','matter_id','entry_date','start_time','end_time','hours',
                   'activity_type','description','notes','is_billable','status'];
  // recompute hours if start/end changed but hours not
  if ((b.start_time || b.end_time) && b.hours == null) {
    const s = b.start_time ?? entry.start_time;
    const e = b.end_time   ?? entry.end_time;
    const h = hoursFromTimes(s, e);
    if (h) b.hours = h;
  }
  const fields = []; const values = [];
  for (const k of allowed) {
    if (k in b) {
      let v = b[k];
      if (k === 'is_billable') v = (v === '0' || v === false || v === 'false') ? 0 : 1;
      fields.push(`${k} = ?`); values.push(v);
    }
  }
  if (!fields.length && !req.file) return res.json({ ok: true });
  if (fields.length) {
    values.push(id);
    db.prepare(`UPDATE timesheet_entries SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  }
  if (req.file) {
    db.prepare(`
      INSERT INTO attachments (entry_id, filename, original_name, mimetype, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  }
  res.json({ ok: true });
});

router.delete('/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const entry = db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && entry.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!isAdmin && ['approved','invoiced'].includes(entry.status)) {
    return res.status(400).json({ error: 'Cannot delete approved/invoiced entry' });
  }
  // Remove attachments from disk
  const atts = db.prepare('SELECT filename FROM attachments WHERE entry_id = ?').all(id);
  for (const a of atts) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, a.filename)); } catch (_) {}
  }
  db.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.get('/:id/attachment/:attId', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const attId = parseInt(req.params.attId, 10);
  const entry = db.prepare('SELECT user_id FROM timesheet_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && entry.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND entry_id = ?').get(attId, id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOAD_DIR, att.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
  res.download(filePath, att.original_name);
});

router.delete('/:id/attachment/:attId', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const attId = parseInt(req.params.attId, 10);
  const entry = db.prepare('SELECT user_id, status FROM timesheet_entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && entry.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!isAdmin && ['approved','invoiced'].includes(entry.status)) {
    return res.status(400).json({ error: 'Entry is locked' });
  }
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND entry_id = ?').get(attId, id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, att.filename)); } catch (_) {}
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attId);
  res.json({ ok: true });
});

module.exports = router;
