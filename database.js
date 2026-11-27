const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'tugasan.db'));

// Enable WAL mode for better performance
db.exec('PRAGMA journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'guru'
  );

  CREATE TABLE IF NOT EXISTS sesi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama_semester TEXT NOT NULL,
    tahun TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama_kelas TEXT NOT NULL,
    sesi_id INTEGER NOT NULL,
    FOREIGN KEY (sesi_id) REFERENCES sesi(id)
  );

  CREATE TABLE IF NOT EXISTS pelajar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    no_matrik TEXT,
    kelas_id INTEGER NOT NULL,
    FOREIGN KEY (kelas_id) REFERENCES kelas(id)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelajar_id INTEGER NOT NULL,
    jenis_tugasan TEXT NOT NULL,
    fail_path TEXT NOT NULL,
    masa_submit DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pelajar_id) REFERENCES pelajar(id)
  );

  CREATE TABLE IF NOT EXISTS mentors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelajar_id INTEGER NOT NULL,
    jenis_tugasan TEXT NOT NULL,
    gambar_path TEXT,
    tarikh_ditetapkan DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pelajar_id) REFERENCES pelajar(id)
  );
`);

// Seed default admin account if not exists
function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'guru');
    console.log('[DB] Admin akaun dibuat: username=admin, password=admin123');
  }
}

seedAdmin();

module.exports = db;
