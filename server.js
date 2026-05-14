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
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

let DB = { licenses: [], activations: [], log: [] };

function loadDB() {
  try {
    const raw = process.env.DB_DATA;
    if (raw) DB = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch(e) { console.log('DB nueva:', e.message); }
  return DB;
}

async function saveDB() {
  const encoded = Buffer.from(JSON.stringify(DB)).toString('base64');
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log('Sin Render API — datos solo en memoria');
    return;
  }
  const body = JSON.stringify({ envVars: [{ key: 'DB_DATA', value: encoded }] });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.render.com',
      path: `/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => { res.on('data',()=>{}); res.on('end',resolve); });
    req.on('error', (e) => { console.log('Error guardando:', e.message); resolve(); });
    req.write(body); req.end();
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

loadDB();
console.log(`✅ DB cargada: ${DB.licenses.length} licencias, ${DB.activations.length} activaciones`);

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

app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
