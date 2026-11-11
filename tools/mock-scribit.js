#!/usr/bin/env node
// Scribit-Simulator: ahmt die HTTP-Schnittstelle der Unbrickit-Firmware nach.
//   node tools/mock-scribit.js            -> API auf :8888, Web-App auf :8080
//   SPEED=50 node tools/mock-scribit.js   -> 50x schneller als echt
//   TRUNC=0.2 ...                         -> 20 % der Uploads werden abgeschnitten (Firmware-Eigenheit)
// Zusätzlich: GET /__drawing liefert die "gezeichneten" Linien, POST /__reset setzt zurück.

const http = require('http');
const fs = require('fs');
const path = require('path');

const SPEED = parseFloat(process.env.SPEED || '20');
const TRUNC = parseFloat(process.env.TRUNC || '0');
const API_PORT = parseInt(process.env.PORT || '8888', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || '8080', 10);
const WWW = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');

const dev = { state: 'IDLE', paused: false, L: 0, R: 0, Z: 0, absZ: false, feed: 1000, queue: [], ink: [], uploads: 0, log: [] };
let penDownStart = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function execLine(line) {
  const t = line.trim();
  if (!t || t.startsWith(';')) return 0;
  if (/^G90/.test(t)) { dev.absZ = true; return 0.01; }
  if (/^G91/.test(t)) { dev.absZ = false; return 0.01; }
  if (/^G77/.test(t)) { dev.Z = 0; return 3; }
  if (/^G4/.test(t)) { const p = /P(\d+)/.exec(t); return p ? +p[1] / 1000 : 0; }
  const m = /^G[01]\b(.*)$/.exec(t);
  if (!m) return 0.01;
  const v = (a) => { const r = new RegExp(a + '(-?\\d*\\.?\\d*)').exec(m[1]); return r ? (parseFloat(r[1]) || 0) : null; };
  const x = v('X'), y = v('Y'), z = v('Z'), f = v('F');
  if (f) dev.feed = f;
  let time = 0;
  if (z !== null) {
    const nz = dev.absZ ? z : dev.Z + z;
    time += Math.abs(nz - dev.Z) / (Math.min(dev.feed, 2400) / 60);
    dev.Z = nz;
  }
  const before = { L: dev.L, R: dev.R };
  if (x !== null) dev.L += x;
  if (y !== null) dev.R -= y;
  time += Math.hypot(dev.L - before.L, dev.R - before.R) / (Math.min(dev.feed, 2400) / 60);
  // Stift unten, wenn Z relativ zur letzten "oben"-Stellung -30 ist (vereinfacht: Z-Rest mod 72)
  if (dev.penDown && (x !== null || y !== null)) dev.ink.push([before.L, before.R, dev.L, dev.R]);
  if (z !== null && !dev.absZ) {
    if (z === -30) dev.penDown = true;
    if (z === 30) dev.penDown = false;
  }
  return time;
}

function runQueue() {
  if (dev.paused) { setTimeout(runQueue, 50); return; }
  const line = dev.queue.shift();
  if (line === undefined) { dev.state = 'IDLE'; return; }
  const t = execLine(line);
  setTimeout(runQueue, Math.max(0, (t * 1000) / SPEED));
}

const api = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj) + '\n'); };
    if (req.url === '/status' && req.method === 'GET') {
      return json(200, { state: dev.state, paused: dev.paused ? (dev.queue.length ? 'paused' : 'paused') : 'running', id: 'a1b2c3d4e5f6', version: '1.3.0-sim' });
    }
    if (req.url === '/upload' && req.method === 'POST') {
      // Firmware: uint16_t contentLen
      let len = parseInt(req.headers['content-length'] || '0', 10) % 65536;
      if (len === 0) return json(400, { error: 'Invalid content length' });
      if (dev.state !== 'IDLE') return json(409, { error: 'Device not idle' });
      let text = body.slice(0, len);
      if (TRUNC > 0 && Math.random() < TRUNC && text.length > 40) {
        text = text.slice(0, Math.floor(text.length * (0.3 + Math.random() * 0.6)));
      }
      dev.uploads++;
      dev.queue = text.split('\n');
      dev.state = 'PRINTING';
      dev.paused = false;
      json(200, { status: 'uploaded', size: text.length });
      setTimeout(runQueue, 30);
      return;
    }
    if (req.url === '/pause' && req.method === 'POST') {
      if (dev.state !== 'PRINTING') return json(409, { error: 'Cannot pause in state 0' });
      if (dev.paused) return json(409, { error: 'Already paused' });
      dev.paused = true; return json(200, { status: 'paused' });
    }
    if (req.url === '/resume' && req.method === 'POST') {
      if (dev.state !== 'PRINTING') return json(409, { error: 'Cannot resume in state 0' });
      if (!dev.paused) return json(409, { error: 'Not paused' });
      dev.paused = false; return json(200, { status: 'resumed' });
    }
    if (req.url === '/__drawing') return json(200, { L: dev.L, R: dev.R, Z: dev.Z, ink: dev.ink, uploads: dev.uploads });
    if (req.url === '/__reset') { dev.L = 0; dev.R = 0; dev.Z = 0; dev.ink = []; dev.uploads = 0; dev.state = 'IDLE'; dev.queue = []; return json(200, { ok: true }); }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found\n');
  });
});
api.listen(API_PORT, () => console.log(`Scribit-Simulator API: http://127.0.0.1:${API_PORT}  (SPEED=${SPEED}, TRUNC=${TRUNC})`));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('nicht gefunden'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(WEB_PORT, () => console.log(`Web-App: http://127.0.0.1:${WEB_PORT}`));
