// ═══════════════════════════════════════════════════════════
//  LED Screen Design — Servidor de Licencias
//  By Rodrigo Pérez
// ═══════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'cambia-esta-clave-2024';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BIN = process.env.JSONBIN_BIN || '';

let DB = { licenses: [], activations: [], log: [] };

// ── Cargar datos desde JSONBin ───────────────────────────────
function loadDB() {
  return new Promise((resolve) => {
    if (!JSONBIN_KEY || !JSONBIN_BIN) { resolve(DB); return; }
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${JSONBIN_BIN}/latest`,
      method: 'GET',
      headers: { 'X-Master-Key': JSONBIN_KEY }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.record) {
            DB = parsed.record;
            if (!DB.licenses) DB.licenses = [];
            if (!DB.activations) DB.activations = [];
            if (!DB.log) DB.log = [];
          }
        } catch(e) { console.log('Error cargando DB:', e.message); }
        resolve(DB);
      });
    });
    req.on('error', (e) => { console.log('Error conectando JSONBin:', e.message); resolve(DB); });
    req.end();
  });
}

// ── Guardar datos en JSONBin ─────────────────────────────────
function saveDB() {
  if (!JSONBIN_KEY || !JSONBIN_BIN) return Promise.resolve();
  const body = JSON.stringify(DB);
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${JSONBIN_BIN}`,
      method: 'PUT',
      headers: {
        'X-Master-Key': JSONBIN_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', (e) => { console.log('Error guardando:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

function logEvent(event, licenseKey, machineId, details) {
  DB.log.unshift({ event, licenseKey, machineId, details, at: new Date().toISOString() });
  if (DB.log.length > 200) DB.log = DB.log.slice(0, 200);
  saveDB();
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

app.post('/api/activate', (req, res) => {
  const { licenseKey, machineId, machineName } = req.body;
  if (!licenseKey || !machineId) return res.status(400).json({ ok:false, error:'Faltan datos' });
  const key = licenseKey.trim().toUpperCase();
  const lic = DB.licenses.find(l => l.key === key && l.active);
  if (!lic) { logEvent('ACTIVATE_FAILED',key,machineId,'No encontrada'); return res.status(404).json({ ok:false, error:'Licencia no válida o inactiva' }); }
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) { logEvent('ACTIVATE_EXPIRED',key,machineId,'Expirada'); return res.status(403).json({ ok:false, error:'Licencia expirada' }); }
  const existing = DB.activations.find(a => a.key === key && a.machineId === machineId);
  if (existing) { existing.lastCheck = new Date().toISOString(); saveDB(); return res.json({ ok:true, plan:lic.plan, name:lic.name }); }
  const activeCount = DB.activations.filter(a => a.key === key).length;
  if (activeCount >= (lic.maxDevices||1)) { logEvent('ACTIVATE_LIMIT',key,machineId,'Límite'); return res.status(403).json({ ok:false, error:'Límite de dispositivos alcanzado. Contactá al soporte.' }); }
  DB.activations.push({ key, machineId, machineName:machineName||'PC', activatedAt:new Date().toISOString(), lastCheck:new Date().toISOString() });
  saveDB(); logEvent('ACTIVATED',key,machineId,`En: ${machineName}`);
  res.json({ ok:true, plan:lic.plan, name:lic.name, message:'Activada correctamente' });
});

app.post('/api/verify', (req, res) => {
  const { licenseKey, machineId } = req.body;
  if (!licenseKey || !machineId) return res.status(400).json({ ok:false, error:'Faltan datos' });
  const key = licenseKey.trim().toUpperCase();
  const lic = DB.licenses.find(l => l.key === key && l.active);
  if (!lic) return res.json({ ok:false, error:'Licencia no válida' });
  if (lic.expiresAt && new Date(lic.expiresAt) < new Date()) return res.json({ ok:false, error:'Licencia expirada' });
  const act = DB.activations.find(a => a.key === key && a.machineId === machineId);
  if (!act) return res.json({ ok:false, error:'Dispositivo no registrado' });
  act.lastCheck = new Date().toISOString(); saveDB();
  res.json({ ok:true, plan:lic.plan, name:lic.name });
});

app.post('/api/deactivate', (req, res) => {
  const { licenseKey, machineId } = req.body;
  DB.activations = DB.activations.filter(a => !(a.key===licenseKey && a.machineId===machineId));
  saveDB(); logEvent('DEACTIVATED',licenseKey,machineId,'Por usuario');
  res.json({ ok:true });
});

// ═══════════════════════════════════════════════════════════
//  API ADMIN
// ═══════════════════════════════════════════════════════════

app.post('/admin/licenses', requireAdmin, (req, res) => {
  const { email, name, plan='pro', maxDevices=1, expiresAt, notes } = req.body;
  const key = generateKey();
  DB.licenses.unshift({ key, email, name, plan, maxDevices, expiresAt:expiresAt||null, notes:notes||'', active:true, createdAt:new Date().toISOString() });
  saveDB(); logEvent('LICENSE_CREATED',key,null,`Para: ${name} (${email})`);
  res.json({ ok:true, key, email, name, plan, maxDevices });
});

app.get('/admin/licenses', requireAdmin, (req, res) => {
  const licenses = DB.licenses.map(l => ({ ...l, devicesUsed: DB.activations.filter(a=>a.key===l.key).length }));
  res.json({ ok:true, licenses });
});

app.put('/admin/licenses/:key/toggle', requireAdmin, (req, res) => {
  const lic = DB.licenses.find(l => l.key===req.params.key);
  if (!lic) return res.status(404).json({ ok:false, error:'No encontrada' });
  lic.active = !lic.active; saveDB();
  logEvent('LICENSE_TOGGLED',req.params.key,null,`Estado: ${lic.active?'activa':'inactiva'}`);
  res.json({ ok:true, active:lic.active });
});

app.delete('/admin/licenses/:key/activations', requireAdmin, (req, res) => {
  DB.activations = DB.activations.filter(a => a.key!==req.params.key);
  saveDB(); logEvent('ACTIVATIONS_CLEARED',req.params.key,null,'Liberado por admin');
  res.json({ ok:true });
});

app.get('/admin/stats', requireAdmin, (req, res) => {
  res.json({ ok:true, stats:{ total:DB.licenses.length, active:DB.licenses.filter(l=>l.active).length, inactive:DB.licenses.filter(l=>!l.active).length, devices:DB.activations.length }, recentActivity:DB.log.slice(0,20) });
});

app.get('/admin/log', requireAdmin, (req, res) => {
  res.json({ ok:true, logs:DB.log.slice(0,100) });
});

app.get('/', (req, res) => {
  res.json({ status:'ok', service:'LED Screen Design License Server', version:'1.0.0' });
});

// Iniciar servidor cargando DB primero
loadDB().then(() => {
  console.log(`✅ DB cargada: ${DB.licenses.length} licencias, ${DB.activations.length} activaciones`);
  app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
});
