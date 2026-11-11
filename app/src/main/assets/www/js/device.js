// Kommunikation mit dem Scribit (HTTP auf Port 8888).
// In der Android-App läuft das über die native Bridge (bindet ans WLAN, auch ohne Internet).
// Im Browser (Test mit Simulator) per fetch.

const conn = { host: '192.168.240.1', port: 8888 };
const pending = new Map();
let seq = 0;

window.__scribitCb = (id, json) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  try { p(JSON.parse(json)); } catch (e) { p({ status: 0, error: 'Antwort unlesbar' }); }
};

export function setConnection(host, port) {
  conn.host = (host || '192.168.240.1').trim();
  conn.port = parseInt(port, 10) || 8888;
}
export function getConnection() { return { ...conn }; }

export const hasBridge = () => typeof window.ScribitBridge !== 'undefined';

export function http(method, path, body = '', timeout = 6000) {
  if (hasBridge()) {
    return new Promise((resolve) => {
      const id = 'r' + (++seq);
      pending.set(id, resolve);
      try {
        window.ScribitBridge.request(id, method, conn.host, conn.port, path, body || '', timeout);
      } catch (e) {
        pending.delete(id);
        resolve({ status: 0, error: String(e) });
      }
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ status: 0, error: 'Zeitüberschreitung' }); } }, timeout + 3000);
    }).then(normalize);
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  return fetch(`http://${conn.host}:${conn.port}${path}`, {
    method,
    body: method === 'POST' ? body : undefined,
    headers: method === 'POST' ? { 'Content-Type': 'text/plain' } : undefined,
    signal: ctl.signal,
    cache: 'no-store',
  }).then(async r => ({ status: r.status, body: await r.text() }))
    .catch(e => ({ status: 0, error: e.name === 'AbortError' ? 'Zeitüberschreitung' : (e.message || 'Netzwerkfehler') }))
    .finally(() => clearTimeout(t))
    .then(normalize);
}

function normalize(r) {
  let json = null;
  if (r.body) {
    const m = r.body.match(/\{[\s\S]*\}/);
    if (m) { try { json = JSON.parse(m[0]); } catch (e) { /* kein JSON */ } }
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.body || '', json, error: r.error };
}

const statusListeners = [];
export function onStatus(cb) { statusListeners.push(cb); }

export async function getStatus() {
  const r = await http('GET', '/status', '', 3500);
  const s = (!r.ok || !r.json)
    ? { online: false, error: r.error || ('HTTP ' + r.status) }
    : { online: true, state: r.json.state || 'UNKNOWN', paused: r.json.paused || 'running', id: r.json.id, version: r.json.version };
  statusListeners.forEach(cb => { try { cb(s); } catch (e) { /* egal */ } });
  return s;
}

export async function upload(gcode) {
  const r = await http('POST', '/upload', gcode, 15000);
  return { ok: r.ok, status: r.status, size: r.json && typeof r.json.size === 'number' ? r.json.size : null, error: r.error || (r.json && r.json.error), text: r.text };
}

export const pause = () => http('POST', '/pause', '', 5000);
export const resume = () => http('POST', '/resume', '', 5000);

// Einzelbefehle (Joggen, Stift) — Gerät muss IDLE sein
export async function sendCommands(lines) {
  const text = (Array.isArray(lines) ? lines : String(lines).split('\n')).map(l => l.trim()).filter(l => l && !l.startsWith(';')).join('\n');
  if (!text) return { ok: false, error: 'Leer' };
  return upload(text);
}

// Warten über Android-Timer (werden im Hintergrund nicht gedrosselt), sonst setTimeout
export function sleep(ms) {
  if (hasBridge() && typeof window.ScribitBridge.sleep === 'function') {
    return new Promise((resolve) => {
      const id = 's' + (++seq);
      pending.set(id, () => resolve());
      try { window.ScribitBridge.sleep(id, Math.round(ms)); } catch (e) { pending.delete(id); setTimeout(resolve, ms); }
    });
  }
  return new Promise(r => setTimeout(r, ms));
}

export function native(name, ...args) {
  if (!hasBridge() || typeof window.ScribitBridge[name] !== 'function') return null;
  try { return window.ScribitBridge[name](...args); } catch (e) { return null; }
}
