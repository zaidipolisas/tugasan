const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const archiver = require('archiver');

// Initialize database (creates tables + seeds admin)
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/mentors', express.static(path.join(__dirname, 'mentors')));

app.use(session({
  secret: 'tugasan-system-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Make io accessible in routes
app.set('io', io);

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/login.html');
}

// --- Auth Routes ---
const bcrypt = require('bcrypt');

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password tidak sah.' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

app.get('/auth/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// --- Multer: students upload ---
const storageStudents = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'students');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const uploadStudents = multer({ storage: storageStudents });

// --- Multer: tugasan upload ---
const storageTugasan = multer.diskStorage({
  destination: (req, file, cb) => {
    // Will be set dynamically in route
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadTugasan = multer({ storage: storageTugasan });

// --- Multer: mentor photo upload ---
const storageMentor = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'mentors');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const uploadMentor = multer({ storage: storageMentor });

// --- Admin Routes (protected) ---

// Tambah sesi
app.post('/admin/sesi', requireAuth, (req, res) => {
  const { nama_semester, tahun } = req.body;
  if (!nama_semester || !tahun) return res.status(400).json({ error: 'nama_semester dan tahun diperlukan.' });
  const result = db.prepare('INSERT INTO sesi (nama_semester, tahun) VALUES (?, ?)').run(nama_semester, tahun);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Padam sesi
app.delete('/admin/sesi/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sesi WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Tambah kelas
app.post('/admin/kelas', requireAuth, (req, res) => {
  const { nama_kelas, sesi_id } = req.body;
  if (!nama_kelas || !sesi_id) return res.status(400).json({ error: 'nama_kelas dan sesi_id diperlukan.' });
  const result = db.prepare('INSERT INTO kelas (nama_kelas, sesi_id) VALUES (?, ?)').run(nama_kelas, sesi_id);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Padam kelas
app.delete('/admin/kelas/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM kelas WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Upload senarai pelajar (Excel / PDF)
app.post('/admin/upload-pelajar', requireAuth, uploadStudents.single('fail'), async (req, res) => {
  const { kelas_id } = req.body;
  if (!kelas_id || !req.file) return res.status(400).json({ error: 'kelas_id dan fail diperlukan.' });

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  let names = [];

  try {
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = xlsx.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });
      // Find column index for "Nama Pelajar" or use first column
      let colIdx = 0;
      if (rows.length > 0) {
        const header = rows[0].map(h => String(h || '').toLowerCase());
        const found = header.findIndex(h => h.includes('nama'));
        if (found >= 0) colIdx = found;
      }
      for (let i = 1; i < rows.length; i++) {
        const name = String(rows[i][colIdx] || '').trim();
        if (name) names.push(name);
      }
    } else if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      // Split by newlines, filter out short/empty lines
      names = data.text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 2 && l.length < 100);
    } else {
      return res.status(400).json({ error: 'Hanya fail .xlsx, .xls, atau .pdf diterima.' });
    }

    if (names.length === 0) return res.status(400).json({ error: 'Tiada nama pelajar dijumpai dalam fail.' });

    const insert = db.prepare('INSERT INTO pelajar (nama, kelas_id) VALUES (?, ?)');
    for (const nama of names) insert.run(nama, kelas_id);

    res.json({ success: true, count: names.length, names });
  } catch (err) {
    console.error('[upload-pelajar]', err);
    res.status(500).json({ error: 'Gagal parse fail: ' + err.message });
  }
});

// Tambah pelajar manual
app.post('/admin/pelajar', requireAuth, (req, res) => {
  const { nama, no_matrik, kelas_id } = req.body;
  if (!nama || !kelas_id) return res.status(400).json({ error: 'nama dan kelas_id diperlukan.' });
  const result = db.prepare('INSERT INTO pelajar (nama, no_matrik, kelas_id) VALUES (?, ?, ?)').run(nama, no_matrik || null, kelas_id);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Padam pelajar
app.delete('/admin/pelajar/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM pelajar WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Tambah mentor
app.post('/admin/mentor', requireAuth, uploadMentor.single('gambar'), (req, res) => {
  const { pelajar_id, jenis_tugasan } = req.body;
  if (!pelajar_id || !jenis_tugasan) return res.status(400).json({ error: 'pelajar_id dan jenis_tugasan diperlukan.' });
  const gambar_path = req.file ? '/mentors/' + req.file.filename : null;
  // Upsert — satu mentor per jenis tugasan
  const existing = db.prepare('SELECT id FROM mentors WHERE jenis_tugasan = ?').get(jenis_tugasan);
  if (existing) {
    db.prepare('UPDATE mentors SET pelajar_id=?, gambar_path=?, tarikh_ditetapkan=CURRENT_TIMESTAMP WHERE id=?')
      .run(pelajar_id, gambar_path, existing.id);
  } else {
    db.prepare('INSERT INTO mentors (pelajar_id, jenis_tugasan, gambar_path) VALUES (?, ?, ?)').run(pelajar_id, jenis_tugasan, gambar_path);
  }
  const io = req.app.get('io');
  const mentors = db.prepare(`
    SELECT m.id, m.jenis_tugasan, m.gambar_path, m.tarikh_ditetapkan,
           p.nama, k.nama_kelas, s.nama_semester, s.tahun
    FROM mentors m
    JOIN pelajar p ON p.id = m.pelajar_id
    JOIN kelas k ON k.id = p.kelas_id
    JOIN sesi s ON s.id = k.sesi_id
    ORDER BY m.jenis_tugasan
  `).all();
  io.emit('mentor-update', mentors);
  res.json({ success: true });
});

// --- API Routes ---
app.get('/api/sesi', (req, res) => {
  const rows = db.prepare('SELECT * FROM sesi ORDER BY id DESC').all();
  res.json(rows);
});

app.get('/api/kelas/:sesi_id', (req, res) => {
  const rows = db.prepare('SELECT * FROM kelas WHERE sesi_id = ?').all(req.params.sesi_id);
  res.json(rows);
});

app.get('/api/pelajar/:kelas_id', (req, res) => {
  const rows = db.prepare('SELECT * FROM pelajar WHERE kelas_id = ?').all(req.params.kelas_id);
  res.json(rows);
});

app.get('/api/dashboard/:kelas_id', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.nama, p.no_matrik,
           s.id AS submission_id, s.jenis_tugasan, s.fail_path, s.masa_submit
    FROM pelajar p
    LEFT JOIN submissions s ON s.pelajar_id = p.id
    WHERE p.kelas_id = ?
    ORDER BY p.nama
  `).all(req.params.kelas_id);
  res.json(rows);
});

app.get('/api/mentors', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.jenis_tugasan, m.gambar_path, m.tarikh_ditetapkan,
           p.nama, k.nama_kelas, s.nama_semester, s.tahun
    FROM mentors m
    JOIN pelajar p ON p.id = m.pelajar_id
    JOIN kelas k ON k.id = p.kelas_id
    JOIN sesi s ON s.id = k.sesi_id
    ORDER BY m.jenis_tugasan
  `).all();
  res.json(rows);
});

// --- Submit Tugasan ---
app.post('/submit', (req, res, next) => {
  // Dynamic multer destination based on sesi/kelas
  const { sesi_id, kelas_id, pelajar_id, jenis_tugasan } = req.body;
  const kelasMeta = sesi_id && kelas_id
    ? db.prepare('SELECT k.nama_kelas, s.nama_semester, s.tahun FROM kelas k JOIN sesi s ON s.id = k.sesi_id WHERE k.id = ?').get(kelas_id)
    : null;
  const folder = kelasMeta
    ? path.join(__dirname, 'uploads', `${kelasMeta.tahun}_${kelasMeta.nama_semester}`, kelasMeta.nama_kelas)
    : path.join(__dirname, 'uploads', 'misc');
  fs.mkdirSync(folder, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, folder),
    filename: (req, file, cb) => {
      const pelajar = pelajar_id ? db.prepare('SELECT nama FROM pelajar WHERE id = ?').get(pelajar_id) : null;
      const nama = pelajar ? pelajar.nama.replace(/\s+/g, '_') : 'Unknown';
      const tugasan = (jenis_tugasan || 'Tugasan').replace(/\s+/g, '_');
      const tarikh = new Date().toISOString().slice(0, 10);
      const ext = path.extname(file.originalname);
      cb(null, `${nama}_${tugasan}_${tarikh}${ext}`);
    }
  });
  multer({ storage }).single('fail')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { pelajar_id, jenis_tugasan } = req.body;
    if (!pelajar_id || !jenis_tugasan || !req.file) {
      return res.status(400).json({ error: 'pelajar_id, jenis_tugasan, dan fail diperlukan.' });
    }

    const fail_path = req.file.path.replace(__dirname, '').replace(/\\/g, '/');
    const result = db.prepare('INSERT INTO submissions (pelajar_id, jenis_tugasan, fail_path) VALUES (?, ?, ?)').run(pelajar_id, jenis_tugasan, fail_path);

    // Get full pelajar info for broadcast
    const pelajar = db.prepare(`
      SELECT p.id, p.nama, p.no_matrik, p.kelas_id,
             s.id AS submission_id, s.jenis_tugasan, s.fail_path, s.masa_submit
      FROM pelajar p JOIN submissions s ON s.pelajar_id = p.id
      WHERE s.id = ?
    `).get(result.lastInsertRowid);

    req.app.get('io').emit('status-update', pelajar);
    res.json({ success: true });
  });
});

// --- Preview & Download (protected) ---
app.get('/tugasan/preview/:submission_id', requireAuth, async (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.submission_id);
  if (!sub) return res.status(404).send('Tidak dijumpai.');
  const absPath = path.join(__dirname, sub.fail_path);
  const ext = path.extname(sub.fail_path).toLowerCase();
  if (ext === '.docx') {
    try {
      const result = await mammoth.convertToHtml({ path: absPath });
      res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1rem">${result.value}</body></html>`);
    } catch { res.status(500).send('Gagal preview Word.'); }
  } else {
    res.sendFile(absPath);
  }
});

app.get('/tugasan/download/:submission_id', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.submission_id);
  if (!sub) return res.status(404).send('Tidak dijumpai.');
  const absPath = path.join(__dirname, sub.fail_path);
  res.download(absPath);
});

app.get('/tugasan/download-all/:kelas_id', requireAuth, (req, res) => {
  const subs = db.prepare(`
    SELECT s.fail_path, p.nama, s.jenis_tugasan
    FROM submissions s JOIN pelajar p ON p.id = s.pelajar_id
    WHERE p.kelas_id = ?
  `).all(req.params.kelas_id);
  if (subs.length === 0) return res.status(404).send('Tiada submission untuk kelas ini.');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="kelas_${req.params.kelas_id}_tugasan.zip"`);
  const archive = archiver('zip');
  archive.pipe(res);
  for (const s of subs) {
    const absPath = path.join(__dirname, s.fail_path);
    if (fs.existsSync(absPath)) archive.file(absPath, { name: path.basename(absPath) });
  }
  archive.finalize();
});

// --- Root redirect ---
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[Server] Tugasan System berjalan di http://localhost:${PORT}`);
});
