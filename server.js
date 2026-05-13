// ═══════════════════════════════════════════════════════════
//  LED Screen Design — Servidor de Licencias
//  By Rodrigo Pérez
// ═══════════════════════════════════════════════════════════

const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Clave secreta del admin (cambiala antes de subir) ──────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'cambia-esta-clave-secreta-2024';

// ── Base de datos SQLite ────────────────────────────────────
const db = new Database(process.env.DB_PATH || './licenses.db');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT UNIQUE NOT NULL,
    email      TEXT,
    name       TEXT,
    plan       TEXT DEFAULT 'pro',
    max_devices INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    notes      TEXT,
    active     INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS activations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key  TEXT NOT NULL,
    machine_id   TEXT NOT NULL,
    machine_name TEXT,
    activated_at TEXT DEFAULT (datetime('now')),
    last_check   TEXT DEFAULT (datetime('now')),
    UNIQUE(license_key, machine_id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event      TEXT,
    license_key TEXT,
    machine_id TEXT,
    details    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

app.use(express.json());

// ── CORS para permitir requests desde la app ────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Middleware de autenticación admin ───────────────────────
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ── Generar clave de licencia ───────────────────────────────
function generateLicenseKey() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return 'LED-' + segments.join('-');
  // Ejemplo: LED-A1B2-C3D4-E5F6-G7H8
}

// ═══════════════════════════════════════════════════════════
//  API PÚBLICA — usada por la app del usuario
// ═══════════════════════════════════════════════════════════

// POST /api/activate — Activar una licencia
app.post('/api/activate', (req, res) => {
  const { licenseKey, machineId, machineName } = req.body;

  if (!licenseKey || !machineId) {
    return res.status(400).json({ ok: false, error: 'Faltan datos requeridos' });
  }

  // Buscar la licencia
  const license = db.prepare(
    'SELECT * FROM licenses WHERE key = ? AND active = 1'
  ).get(licenseKey.trim().toUpperCase());

  if (!license) {
    log('ACTIVATE_FAILED', licenseKey, machineId, 'Licencia no encontrada o inactiva');
    return res.status(404).json({ ok: false, error: 'Licencia no válida o inactiva' });
  }

  // Verificar expiración
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    log('ACTIVATE_EXPIRED', licenseKey, machineId, 'Licencia expirada');
    return res.status(403).json({ ok: false, error: 'Licencia expirada' });
  }

  // Verificar si ya está activada en esta máquina
  const existing = db.prepare(
    'SELECT * FROM activations WHERE license_key = ? AND machine_id = ?'
  ).get(licenseKey, machineId);

  if (existing) {
    // Ya activada en esta máquina — actualizar last_check
    db.prepare(
      'UPDATE activations SET last_check = datetime("now") WHERE license_key = ? AND machine_id = ?'
    ).run(licenseKey, machineId);
    log('ACTIVATE_RECHECK', licenseKey, machineId, 'Reactivación exitosa');
    return res.json({ ok: true, message: 'Licencia válida', plan: license.plan, name: license.name });
  }

  // Verificar límite de dispositivos
  const activeCount = db.prepare(
    'SELECT COUNT(*) as count FROM activations WHERE license_key = ?'
  ).get(licenseKey).count;

  if (activeCount >= license.max_devices) {
    log('ACTIVATE_LIMIT', licenseKey, machineId, `Límite de ${license.max_devices} dispositivos alcanzado`);
    return res.status(403).json({
      ok: false,
      error: `Límite de dispositivos alcanzado (${license.max_devices}). Contactá al soporte para transferir la licencia.`
    });
  }

  // Registrar activación
  db.prepare(
    'INSERT INTO activations (license_key, machine_id, machine_name) VALUES (?, ?, ?)'
  ).run(licenseKey, machineId, machineName || 'Desconocido');

  log('ACTIVATED', licenseKey, machineId, `Activado en: ${machineName}`);
  res.json({ ok: true, message: 'Licencia activada exitosamente', plan: license.plan, name: license.name });
});

// POST /api/verify — Verificar licencia (chequeo silencioso al abrir la app)
app.post('/api/verify', (req, res) => {
  const { licenseKey, machineId } = req.body;

  if (!licenseKey || !machineId) {
    return res.status(400).json({ ok: false, error: 'Faltan datos' });
  }

  const license = db.prepare('SELECT * FROM licenses WHERE key = ? AND active = 1').get(licenseKey);
  if (!license) return res.json({ ok: false, error: 'Licencia no válida' });

  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.json({ ok: false, error: 'Licencia expirada' });
  }

  const activation = db.prepare(
    'SELECT * FROM activations WHERE license_key = ? AND machine_id = ?'
  ).get(licenseKey, machineId);

  if (!activation) return res.json({ ok: false, error: 'Dispositivo no registrado' });

  // Actualizar last_check
  db.prepare(
    'UPDATE activations SET last_check = datetime("now") WHERE license_key = ? AND machine_id = ?'
  ).run(licenseKey, machineId);

  res.json({ ok: true, plan: license.plan, name: license.name });
});

// POST /api/deactivate — Desactivar en esta máquina
app.post('/api/deactivate', (req, res) => {
  const { licenseKey, machineId } = req.body;
  db.prepare('DELETE FROM activations WHERE license_key = ? AND machine_id = ?').run(licenseKey, machineId);
  log('DEACTIVATED', licenseKey, machineId, 'Desactivado por el usuario');
  res.json({ ok: true, message: 'Licencia desactivada en este dispositivo' });
});

// ═══════════════════════════════════════════════════════════
//  API ADMIN — solo para vos (requiere X-Admin-Secret)
// ═══════════════════════════════════════════════════════════

// POST /admin/licenses — Crear nueva licencia
app.post('/admin/licenses', requireAdmin, (req, res) => {
  const { email, name, plan = 'pro', maxDevices = 1, expiresAt, notes } = req.body;
  const key = generateLicenseKey();

  db.prepare(`
    INSERT INTO licenses (key, email, name, plan, max_devices, expires_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(key, email, name, plan, maxDevices, expiresAt || null, notes || null);

  log('LICENSE_CREATED', key, null, `Para: ${name} (${email})`);
  res.json({ ok: true, key, email, name, plan, maxDevices });
});

// GET /admin/licenses — Listar todas las licencias
app.get('/admin/licenses', requireAdmin, (req, res) => {
  const licenses = db.prepare(`
    SELECT l.*, 
      (SELECT COUNT(*) FROM activations a WHERE a.license_key = l.key) as devices_used
    FROM licenses l
    ORDER BY l.created_at DESC
  `).all();
  res.json({ ok: true, licenses });
});

// GET /admin/licenses/:key — Ver detalle de una licencia
app.get('/admin/licenses/:key', requireAdmin, (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE key = ?').get(req.params.key);
  if (!license) return res.status(404).json({ ok: false, error: 'No encontrada' });
  const activations = db.prepare('SELECT * FROM activations WHERE license_key = ?').all(req.params.key);
  res.json({ ok: true, license, activations });
});

// PUT /admin/licenses/:key/toggle — Activar/desactivar licencia
app.put('/admin/licenses/:key/toggle', requireAdmin, (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE key = ?').get(req.params.key);
  if (!license) return res.status(404).json({ ok: false, error: 'No encontrada' });
  const newState = license.active ? 0 : 1;
  db.prepare('UPDATE licenses SET active = ? WHERE key = ?').run(newState, req.params.key);
  log('LICENSE_TOGGLED', req.params.key, null, `Estado: ${newState ? 'activa' : 'inactiva'}`);
  res.json({ ok: true, active: newState });
});

// DELETE /admin/activations — Limpiar activaciones de una licencia (para transferir)
app.delete('/admin/licenses/:key/activations', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM activations WHERE license_key = ?').run(req.params.key);
  log('ACTIVATIONS_CLEARED', req.params.key, null, 'Activaciones eliminadas por admin');
  res.json({ ok: true, message: 'Activaciones eliminadas — el usuario puede activar en nuevo dispositivo' });
});

// GET /admin/stats — Estadísticas generales
app.get('/admin/stats', requireAdmin, (req, res) => {
  const total    = db.prepare('SELECT COUNT(*) as c FROM licenses').get().c;
  const active   = db.prepare('SELECT COUNT(*) as c FROM licenses WHERE active = 1').get().c;
  const devices  = db.prepare('SELECT COUNT(*) as c FROM activations').get().c;
  const logs     = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20').all();
  res.json({ ok: true, stats: { total, active, inactive: total - active, devices }, recentActivity: logs });
});

// GET /admin/log — Ver log completo
app.get('/admin/log', requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 100').all();
  res.json({ ok: true, logs });
});

// ── Panel web de administración ─────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  // Redirigir al panel HTML con el secret en el query para no tener que reingresarlo
  res.redirect(`/panel.html?secret=${req.headers['x-admin-secret']}`);
});

app.get('/panel.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LED Screen Design License Server', version: '1.0.0' });
});

// ── Helper: registrar actividad ─────────────────────────────
function log(event, licenseKey, machineId, details) {
  try {
    db.prepare(
      'INSERT INTO activity_log (event, license_key, machine_id, details) VALUES (?, ?, ?, ?)'
    ).run(event, licenseKey, machineId, details);
  } catch(e) {}
}

// ── Iniciar servidor ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Servidor de licencias corriendo en puerto ${PORT}`);
  console.log(`📋 Panel admin: http://localhost:${PORT}/panel.html`);
});
