// ═══════════════════════════════════════════════════════════
//  LED Screen Design — Servidor de Licencias
//  By Rodrigo Pérez
// ═══════════════════════════════════════════════════════════

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'cambia-esta-clave-2024';
const DB_PATH = process.env.DB_PATH || './data.json';

// ── Base de datos en JSON ────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { licenses: [], activations: [], log: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch(e) { return { licenses: [], activations: [], log: [] }; }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function logEvent(event, licenseKey, machineId, details) {
  const db = loadDB();
  db.log.unshift({ event, licenseKey, machineId, details, at: new Date().toISOString() });
  if (db.log.length > 200) db.log = db.log.slice(0, 200);
  saveDB(db);
}

function generateKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `LED-${seg()}-${seg()}-${seg()}-${seg()}`;
}

app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET)
    return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ═══════════════════════════════════════════════════════════
//  API PÚBLICA
// ═══════════════════════════════════════════════════════════

// Activar licencia
app.post('/api/activate', (req, res) => {
  const { licenseKey, machineId, machineName } = req.body;
  if (!licenseKey || !machineId)
    return res.status(400).json({ ok: false, error: 'Faltan datos' });

  const db = loadDB();
  const key = licenseKey.trim().toUpperCase();
  const lic = db.licenses.find(l => l.key === key && l.active);

  if (!lic) {
    logEvent('ACTIVATE_FAILED', key, machineId, 'Licencia no encontrada');
    return res.status(404).json({ ok: false, error: 'Licencia no válida o inactiva' });
  }

  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) {
    logEvent('ACTIVATE_EXPIRED', key, machineId, 'Expirada');
    return res.status(403).json({ ok: false, error: 'Licencia expirada' });
  }

  const existing = db.activations.find(a => a.key === key && a.machineId === machineId);
  if (existing) {
    existing.lastCheck = new Date().toISOString();
    saveDB(db);
    logEvent('ACTIVATE_RECHECK', key, machineId, 'OK');
    return res.json({ ok: true, plan: lic.plan, name: lic.name });
  }

  const activeCount = db.activations.filter(a => a.key === key).length;
  if (activeCount >= (lic.maxDevices || 1)) {
    logEvent('ACTIVATE_LIMIT', key, machineId, 'Límite alcanzado');
    return res.status(403).json({ ok: false, error: `Límite de dispositivos alcanzado (${lic.maxDevices}). Contactá al soporte.` });
  }

  db.activations.push({ key, machineId, machineName: machineName || 'PC', activatedAt: new Date().toISOString(), lastCheck: new Date().toISOString() });
  saveDB(db);
  logEvent('ACTIVATED', key, machineId, `En: ${machineName}`);
  res.json({ ok: true, plan: lic.plan, name: lic.name, message: 'Activada correctamente' });
});

// Verificar licencia
app.post('/api/verify', (req, res) => {
  const { licenseKey, machineId } = req.body;
  if (!licenseKey || !machineId)
    return res.status(400).json({ ok: false, error: 'Faltan datos' });

  const db = loadDB();
  const key = licenseKey.trim().toUpperCase();
  const lic = db.licenses.find(l => l.key === key && l.active);
  if (!lic) return res.json({ ok: false, error: 'Licencia no válida' });
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date())
    return res.json({ ok: false, error: 'Licencia expirada' });

  const act = db.activations.find(a => a.key === key && a.machineId === machineId);
  if (!act) return res.json({ ok: false, error: 'Dispositivo no registrado' });

  act.lastCheck = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, plan: lic.plan, name: lic.name });
});

// Desactivar
app.post('/api/deactivate', (req, res) => {
  const { licenseKey, machineId } = req.body;
  const db = loadDB();
  db.activations = db.activations.filter(a => !(a.key === licenseKey && a.machineId === machineId));
  saveDB(db);
  logEvent('DEACTIVATED', licenseKey, machineId, 'Por el usuario');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  API ADMIN
// ═══════════════════════════════════════════════════════════

app.post('/admin/licenses', requireAdmin, (req, res) => {
  const { email, name, plan = 'pro', maxDevices = 1, expiresAt, notes } = req.body;
  const key = generateKey();
  const db = loadDB();
  db.licenses.unshift({ key, email, name, plan, maxDevices, expiresAt: expiresAt || null, notes: notes || '', active: true, createdAt: new Date().toISOString() });
  saveDB(db);
  logEvent('LICENSE_CREATED', key, null, `Para: ${name} (${email})`);
  res.json({ ok: true, key, email, name, plan, maxDevices });
});

app.get('/admin/licenses', requireAdmin, (req, res) => {
  const db = loadDB();
  const licenses = db.licenses.map(l => ({
    ...l,
    devicesUsed: db.activations.filter(a => a.key === l.key).length
  }));
  res.json({ ok: true, licenses });
});

app.get('/admin/licenses/:key', requireAdmin, (req, res) => {
  const db = loadDB();
  const lic = db.licenses.find(l => l.key === req.params.key);
  if (!lic) return res.status(404).json({ ok: false, error: 'No encontrada' });
  const activations = db.activations.filter(a => a.key === req.params.key);
  res.json({ ok: true, license: lic, activations });
});

app.put('/admin/licenses/:key/toggle', requireAdmin, (req, res) => {
  const db = loadDB();
  const lic = db.licenses.find(l => l.key === req.params.key);
  if (!lic) return res.status(404).json({ ok: false, error: 'No encontrada' });
  lic.active = !lic.active;
  saveDB(db);
  logEvent('LICENSE_TOGGLED', req.params.key, null, `Estado: ${lic.active ? 'activa' : 'inactiva'}`);
  res.json({ ok: true, active: lic.active });
});

app.delete('/admin/licenses/:key/activations', requireAdmin, (req, res) => {
  const db = loadDB();
  db.activations = db.activations.filter(a => a.key !== req.params.key);
  saveDB(db);
  logEvent('ACTIVATIONS_CLEARED', req.params.key, null, 'Liberado por admin');
  res.json({ ok: true });
});

app.get('/admin/stats', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({
    ok: true,
    stats: {
      total: db.licenses.length,
      active: db.licenses.filter(l => l.active).length,
      inactive: db.licenses.filter(l => !l.active).length,
      devices: db.activations.length
    },
    recentActivity: db.log.slice(0, 20)
  });
});

app.get('/admin/log', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({ ok: true, logs: db.log.slice(0, 100) });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'LED Screen Design License Server', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor de licencias corriendo en puerto ${PORT}`);
});
