// Scribit Mobile – App-Logik und Oberfläche

import { DEFAULT_GEOMETRY, positionFrom, lengthsAt, safeArea } from './kinematics.js';
import { PEN_PRESETS, parseColor, toHex } from './colors.js';
import { importSVG } from './svgimport.js';
import { loadImage, traceImage, TRACE_DEFAULTS } from './trace.js';
import { buildPlan, collectColors, autoColorMap, colorKey, PLAN_DEFAULTS } from './planner.js';
import { GCODE_DEFAULTS, estimatePlan, exportGcode, compileStep } from './gcode.js';
import { placedCorners, designBBox } from './geometry.js';
import { WallView, drawDesignThumb } from './preview.js';
import { ARView } from './ar.js';
import { JobRunner } from './job.js';
import { SAMPLES, testSquareSVG } from './samples.js';
import { loadSettings, saveSettings, putBlob, getBlob } from './store.js';
import * as dev from './device.js';

const $ = (id) => document.getElementById(id);
const nf = (v, d = 0) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------- Zustand ----------------
function defaults() {
  return {
    conn: { host: '192.168.240.1', port: 8888, budget: 1300 },
    geom: { ...DEFAULT_GEOMETRY },
    robot: { L: 1270, R: 1270, penSlot: 0, homed: false },
    limits: { side: 150, top: 200, bottom: 1800 },
    pens: PEN_PRESETS.slice(0, 4).map(p => ({ ...p })),
    extra: [],
    plan: { ...PLAN_DEFAULTS },
    gcode: { ...GCODE_DEFAULTS },
    trace: { ...TRACE_DEFAULTS },
    placement: null,
    colorMap: {},
    view: { penWidth: 1.5, showTravel: false, rotGesture: false },
    jogStep: 10,
  };
}
function loadState() {
  const d = defaults();
  const s = loadSettings();
  for (const k of Object.keys(d)) {
    if (s[k] === undefined || s[k] === null) continue;
    if (Array.isArray(d[k])) d[k] = Array.isArray(s[k]) ? s[k] : d[k];
    else if (typeof d[k] === 'object' && d[k] !== null) d[k] = { ...d[k], ...s[k] };
    else d[k] = s[k];
  }
  if (!d.pens || d.pens.length !== 4) d.pens = defaults().pens;
  if (s.placement) d.placement = s.placement;
  return d;
}
const S = loadState();
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => saveSettings(S), 250); }

let design = null;          // aktuelles Motiv
let sourceImg = null;       // Quelle bei Bild-Umwandlung
let colors = [];
let plan = null, planPlacement = null, planEst = null;
let runner = null;
let lastStatus = { online: false };
let wall, jobView, ar;

dev.setConnection(S.conn.host, S.conn.port);

// ---------------- Hilfen ----------------
let toastT = null;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2800);
}

function modal(title, body, buttons) {
  const m = $('modal');
  $('modalTitle').textContent = title;
  const b = $('modalBody');
  b.innerHTML = '';
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  const row = $('modalBtns');
  row.innerHTML = '';
  const close = () => { m.hidden = true; modal.closeCb && modal.closeCb(); modal.closeCb = null; };
  (buttons || [{ label: 'OK' }]).forEach(bt => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (bt.cls || '');
    el.textContent = bt.label;
    el.onclick = () => { if (bt.onClick && bt.onClick() === false) return; close(); };
    row.appendChild(el);
  });
  m.hidden = false;
  return close;
}
function confirmBox(title, text, okLabel = 'Trotzdem') {
  return new Promise(res => {
    modal(title, `<p>${text}</p>`, [
      { label: 'Abbrechen', onClick: () => res(false) },
      { label: okLabel, cls: 'primary', onClick: () => res(true) },
    ]);
  });
}

function fmtTime(s) {
  s = Math.round(s);
  if (s < 60) return s + ' s';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function log(msg) {
  const el = $('log');
  const t = new Date().toLocaleTimeString('de-DE');
  el.textContent = `${t}  ${msg}\n` + el.textContent.slice(0, 20000);
}

function slider(container, o) {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const sp = document.createElement('span'); sp.textContent = o.label;
  const out = document.createElement('output');
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = o.min; inp.max = o.max; inp.step = o.step || 1;
  inp.value = o.get();
  const show = () => { out.textContent = o.fmt ? o.fmt(+inp.value) : inp.value; };
  show();
  let t = null;
  inp.oninput = () => { show(); o.set(+inp.value); clearTimeout(t); t = setTimeout(() => o.done && o.done(+inp.value), o.delay ?? 200); };
  wrap.append(sp, out, inp);
  container.appendChild(wrap);
  return inp;
}
function toggle(container, o) {
  const l = document.createElement('label');
  l.className = 'check-line';
  const i = document.createElement('input');
  i.type = 'checkbox'; i.checked = !!o.get();
  i.onchange = () => { o.set(i.checked); o.done && o.done(i.checked); };
  const s = document.createElement('span'); s.textContent = o.label;
  l.append(i, s);
  container.appendChild(l);
  return i;
}

function saveFile(name, mime, text) {
  if (dev.native('saveFile', name, mime, text) !== null) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function robotPos() { return positionFrom(S.geom, S.robot.L, S.robot.R); }

// ---------------- Tabs ----------------
let currentTab = 'motiv';
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'wand') { requestAnimationFrame(() => { wall.resize(); }); }
  if (name === 'ar') { requestAnimationFrame(() => ar.draw()); arUi(); }
  else if (ar && ar.mode === 'live') { ar.stopCamera(); ar.mode = 'none'; arUi(); }
  if (name === 'draw') renderDraw();
  if (name === 'device') renderDevice();
}
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('connChip').onclick = () => showTab('device');

window.onAndroidBack = () => {
  if (!$('modal').hidden) { $('modal').hidden = true; if (modal.closeCb) { modal.closeCb(); modal.closeCb = null; } return true; }
  if (currentTab !== 'motiv') { showTab('motiv'); return true; }
  return false;
};

// ---------------- Motiv ----------------
function defaultPlacement(d) {
  const bb = d.bbox || designBBox(d);
  const area = safeArea(S.geom, S.limits);
  const aw = area.x1 - area.x0;
  const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
  let width = d.mmPerUnit ? bw * d.mmPerUnit : Math.min(400, aw * 0.5);
  const maxW = Math.min(aw * 0.9, (area.y1 - area.y0) * 0.9 * bw / Math.max(bh, 1e-6));
  width = Math.max(40, Math.min(width, maxW));
  const p = robotPos();
  return { cx: p.x, cy: p.y, width: Math.round(width), rotation: 0, flipX: false };
}

async function setDesign(d, opts = {}) {
  design = d;
  colors = collectColors(d);
  keyMemo.clear();
  const auto = autoColorMap(colors, S.pens);
  for (const c of colors) if (S.colorMap[c.hex] === undefined) S.colorMap[c.hex] = auto[c.hex];
  if (!opts.keepPlacement || !S.placement) S.placement = defaultPlacement(d);
  save();
  if (!opts.noPersist) putBlob('design', { design: d, image: opts.imageSrc || null, kind: opts.kind || d.source });
  renderMotiv();
  replanNow();
}

function renderMotiv() {
  $('designName').textContent = design ? design.name : 'Noch kein Motiv';
  if (design) {
    const nS = design.strokes.length, nF = design.fills.length;
    const parts = [];
    if (nS) parts.push(`${nS} Linien`);
    if (nF) parts.push(`${nF} Flächen`);
    parts.push(`${colors.length} Farbe${colors.length === 1 ? '' : 'n'}`);
    $('designInfo').textContent = parts.join(', ');
  }
  const w = $('warnings');
  w.innerHTML = '';
  (design?.warnings || []).forEach(t => { const d = document.createElement('div'); d.className = 'warn'; d.textContent = t; w.appendChild(d); });
  drawDesignThumb($('designThumb'), design, { colorFor: thumbColor });
  $('traceBox').hidden = !sourceImg;
  $('colorBox').hidden = !design;
  $('drawWhatBox').hidden = !design;
  renderColors();
  renderPlanControls();
}

function thumbColor(rgb) {
  const t = targetFor(rgb);
  if (t < 0) return null;
  if (t >= 10) return (S.extra[t - 10] || {}).color || '#888';
  return S.pens[t] ? S.pens[t].color : '#888';
}
const keyMemo = new Map();
function targetFor(rgb) {
  const id = rgb.join(',');
  let k = keyMemo.get(id);
  if (k === undefined) { k = colorKey(design, rgb, colors); keyMemo.set(id, k); }
  const v = S.colorMap[k];
  return v === undefined ? 0 : v;
}

function renderColors() {
  const list = $('colorList');
  list.innerHTML = '';
  if (!design) return;
  const total = colors.reduce((a, c) => a + c.len, 0) || 1;
  for (const c of colors) {
    const row = document.createElement('div');
    row.className = 'color-item';
    const sw = document.createElement('div'); sw.className = 'swatch'; sw.style.background = c.hex;
    const tx = document.createElement('div');
    const kinds = [...c.kinds].map(k => ({ line: 'Linien', outline: 'Umriss', fill: 'Fläche' })[k]).join(', ');
    tx.innerHTML = `<b>${c.hex.toUpperCase()}</b><small>${kinds}, ${nf(c.len / total * 100)} %</small>`;
    const sel = document.createElement('select');
    S.pens.forEach((p, i) => sel.add(new Option(`Stift ${i + 1}: ${p.name}`, String(i))));
    S.extra.forEach((p, i) => sel.add(new Option(`Tausch: ${p.name}`, String(10 + i))));
    sel.add(new Option('Weglassen', '-1'));
    sel.value = String(S.colorMap[c.hex] ?? 0);
    sel.onchange = () => { S.colorMap[c.hex] = parseInt(sel.value, 10); save(); drawDesignThumb($('designThumb'), design, { colorFor: thumbColor }); replan(); };
    row.append(sw, tx, sel);
    list.appendChild(row);
  }
}

function renderPlanControls() {
  const tg = $('planToggles'), sl = $('planSliders');
  tg.innerHTML = ''; sl.innerHTML = '';
  if (!design) return;
  const hasKind = (k) => design.strokes.some(s => s.kind === k);
  if (hasKind('line')) toggle(tg, { label: 'Linien zeichnen', get: () => S.plan.drawLines, set: v => { S.plan.drawLines = v; save(); }, done: replan });
  if (hasKind('outline')) toggle(tg, { label: 'Umrisse von Flächen zeichnen', get: () => S.plan.drawOutlines, set: v => { S.plan.drawOutlines = v; save(); }, done: replan });
  if (design.fills.length) {
    toggle(tg, { label: 'Flächen ausfüllen (Schraffur)', get: () => S.plan.drawFills, set: v => { S.plan.drawFills = v; save(); }, done: replan });
    slider(sl, { label: 'Schraffur-Abstand', min: 1, max: 12, step: 0.5, get: () => S.plan.hatchSpacing, set: v => { S.plan.hatchSpacing = v; save(); }, done: replan, fmt: v => nf(v, 1) + ' mm' });
    slider(sl, { label: 'Schraffur-Winkel', min: 0, max: 180, step: 5, get: () => S.plan.hatchAngle, set: v => { S.plan.hatchAngle = v; save(); }, done: replan, fmt: v => v + '°' });
  }
  slider(sl, { label: 'Kurze Striche weglassen unter', min: 0, max: 10, step: 0.5, get: () => S.plan.minLen, set: v => { S.plan.minLen = v; save(); }, done: replan, fmt: v => nf(v, 1) + ' mm' });
  slider(sl, { label: 'Vereinfachen', min: 0, max: 2, step: 0.05, get: () => S.plan.simplifyTol, set: v => { S.plan.simplifyTol = v; save(); }, done: replan, fmt: v => nf(v, 2) + ' mm' });
  slider(sl, { label: 'Strichstärke in der Vorschau', min: 0.5, max: 5, step: 0.1, get: () => S.view.penWidth, set: v => { S.view.penWidth = v; save(); }, done: () => { updateScenes(); }, fmt: v => nf(v, 1) + ' mm', delay: 30 });
}

// Bild-Umwandlung
const MODE_HINT = {
  outline: 'Für Strichzeichnungen, Logos und Comics. Zeichnet die Kanten zwischen hell und dunkel nach.',
  hatch: 'Für Fotos. Dunkle Bereiche werden mit Linien in mehreren Richtungen schraffiert, wie ein Kupferstich.',
  color: 'Für bunte Bilder. Teilt das Bild in Farbflächen auf und schraffiert jede mit ihrem Stift.',
};
function renderTrace() {
  document.querySelectorAll('#traceMode button').forEach(b => b.classList.toggle('on', b.dataset.v === S.trace.mode));
  $('traceModeHint').textContent = MODE_HINT[S.trace.mode];
  const sl = $('traceSliders'), tg = $('traceToggles');
  sl.innerHTML = ''; tg.innerHTML = '';
  const T = S.trace;
  const set = (k) => (v) => { T[k] = v; save(); };
  const pct = (v) => Math.round(v * 100) + ' %';
  const add = (o) => slider(sl, { ...o, done: retrace });
  add({ label: 'Detail', min: 150, max: 1200, step: 50, get: () => T.detail, set: set('detail'), fmt: v => v + ' px' });
  add({ label: 'Weichzeichnen', min: 0, max: 4, step: 1, get: () => T.blur, set: set('blur') });
  if (T.mode === 'outline') {
    add({ label: 'Schwelle hell/dunkel', min: 0.05, max: 0.95, step: 0.01, get: () => T.threshold, set: set('threshold'), fmt: pct });
    add({ label: 'Konturstufen', min: 1, max: 6, step: 1, get: () => T.levels, set: set('levels') });
  }
  if (T.mode === 'hatch') {
    add({ label: 'Tonstufen', min: 1, max: 5, step: 1, get: () => T.tones, set: set('tones') });
    add({ label: 'Schwelle für Umrisse', min: 0.05, max: 0.95, step: 0.01, get: () => T.threshold, set: set('threshold'), fmt: pct });
  }
  if (T.mode === 'color' && !T.usePenColors) add({ label: 'Anzahl Farben', min: 1, max: 6, step: 1, get: () => T.colors, set: set('colors') });
  if (T.mode !== 'outline') add({ label: 'Hintergrund (heller wird ignoriert)', min: 0.4, max: 0.99, step: 0.01, get: () => T.background, set: set('background'), fmt: pct });
  add({ label: 'Glätten', min: 0, max: 3, step: 0.1, get: () => T.smooth, set: set('smooth'), fmt: v => nf(v, 1) });
  add({ label: 'Kleine Flecken entfernen', min: 0, max: 300, step: 4, get: () => T.minArea, set: set('minArea'), fmt: v => v + ' px²' });
  if (T.mode !== 'outline') toggle(tg, { label: 'Umrisse zusätzlich zeichnen', get: () => T.outline, set: set('outline'), done: retrace });
  if (T.mode === 'color') toggle(tg, { label: 'Direkt auf meine 4 Stiftfarben reduzieren', get: () => T.usePenColors, set: set('usePenColors'), done: () => { renderTrace(); retrace(); } });
  toggle(tg, { label: 'Hell und dunkel tauschen', get: () => T.invert, set: set('invert'), done: retrace });
}
document.querySelectorAll('#traceMode button').forEach(b => b.onclick = () => { S.trace.mode = b.dataset.v; save(); renderTrace(); retrace(); });

let traceT = null;
function retrace() {
  clearTimeout(traceT);
  traceT = setTimeout(() => {
    if (!sourceImg) return;
    try {
      const d = traceImage(sourceImg, S.trace, S.pens);
      d.name = sourceImg.dataset.name || 'Bild';
      S.colorMap = {}; // Farben ändern sich mit jeder Umwandlung
      setDesign(d, { keepPlacement: true, imageSrc: sourceImg.src, kind: 'image' });
    } catch (e) { toast('Umwandlung fehlgeschlagen: ' + e.message, true); }
  }, 60);
}

async function downscaleDataUrl(src, max = 1600) {
  const im = await loadImage(src);
  const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  if (k >= 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

async function useImage(src, name) {
  const small = await downscaleDataUrl(src);
  sourceImg = await loadImage(small);
  sourceImg.dataset.name = name || 'Bild';
  S.placement = null;
  renderTrace();
  const d = traceImage(sourceImg, S.trace, S.pens);
  d.name = sourceImg.dataset.name;
  S.colorMap = {};
  await setDesign(d, { imageSrc: small, kind: 'image' });
}

function readFile(file, asText) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (asText) r.readAsText(file); else r.readAsDataURL(file);
  });
}

async function useSvgText(text, name) {
  const d = importSVG(text, name);
  sourceImg = null;
  await setDesign(d, { kind: 'svg' });
}

$('btnOpenSvg').onclick = () => $('fileSvg').click();
$('btnOpenImg').onclick = () => $('fileImg').click();
$('fileSvg').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const text = await readFile(f, true);
    if (!/<svg[\s>]/i.test(text)) {
      if (f.type.startsWith('image/')) { await useImage(await readFile(f, false), f.name.replace(/\.[^.]+$/, '')); return; }
      throw new Error('Das ist keine SVG-Datei');
    }
    await useSvgText(text, f.name.replace(/\.svg$/i, ''));
    toast('SVG geladen');
  } catch (err) { toast(err.message, true); }
};
$('fileImg').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    if (/svg/.test(f.type) || /\.svg$/i.test(f.name)) { await useSvgText(await readFile(f, true), f.name.replace(/\.svg$/i, '')); return; }
    await useImage(await readFile(f, false), f.name.replace(/\.[^.]+$/, ''));
  } catch (err) { toast(err.message, true); }
};

$('btnCamImg').onclick = async () => {
  const box = document.createElement('div');
  const v = document.createElement('video');
  v.playsInline = true; v.muted = true;
  box.appendChild(v);
  let stream = null;
  const stop = () => { if (stream) stream.getTracks().forEach(t => t.stop()); };
  modal.closeCb = stop;
  modal('Foto für die Umwandlung', box, [
    { label: 'Abbrechen' },
    {
      label: 'Aufnehmen', cls: 'primary', onClick: () => {
        if (!v.videoWidth) return false;
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        useImage(c.toDataURL('image/jpeg', 0.9), 'Foto');
      },
    },
  ]);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    v.srcObject = stream; await v.play();
  } catch (e) {
    $('modal').hidden = true; stop();
    toast('Kamera nicht verfügbar. Nimm „Bild umwandeln“.', true);
  }
};

function renderSamples() {
  const el = $('samples');
  el.innerHTML = '';
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sample';
    const svg = s.svg();
    const img = document.createElement('img');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.alt = '';
    const t = document.createElement('span'); t.textContent = s.name;
    b.append(img, t);
    b.onclick = () => { S.placement = null; useSvgText(svg, s.name); };
    el.appendChild(b);
  }
}

// ---------------- Planen ----------------
let planT = null;
function replan() { clearTimeout(planT); planT = setTimeout(replanNow, 120); }
function planOptions() {
  return { ...S.plan, limits: S.limits };
}
function makePlan(placement) {
  return buildPlan(design, placement || S.placement, S.pens, S.colorMap, planOptions(), S.geom, S.robot, S.extra);
}
function replanNow() {
  if (!design || !S.placement) { plan = null; updateScenes(); return; }
  try {
    plan = makePlan();
    planPlacement = { ...S.placement };
    planEst = estimatePlan(plan, S.gcode, S.robot);
  } catch (e) {
    console.error(e);
    toast('Planung fehlgeschlagen: ' + e.message, true);
    plan = null;
  }
  updateScenes();
}

function sceneBase() {
  return {
    geom: S.geom, robot: S.robot, limits: S.limits, design, placement: S.placement, planPlacement,
    plan, penWidth: S.view.penWidth, showTravel: S.view.showTravel,
    outside: plan ? plan.stats.outside > 0 : false,
  };
}

function updateScenes() {
  if (wall) wall.setScene({ ...sceneBase(), progressStep: simStep });
  if (ar) ar.planChanged();
  renderPlacementFields();
  renderStats();
  if (currentTab === 'draw') renderDraw();
}

// ---------------- Wand ----------------
let simStep = null, simTimer = null;
function renderPlacementFields(live) {
  const pl = live || S.placement;
  const on = !!(design && pl);
  ['plW', 'plH', 'plR', 'plX', 'plY'].forEach(id => { $(id).disabled = !on; });
  if (!on) return;
  const bb = design.bbox;
  const aspect = (bb.y1 - bb.y0) / Math.max(1e-6, bb.x1 - bb.x0);
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = Math.round(v); };
  set('plW', pl.width); set('plH', pl.width * aspect); set('plR', pl.rotation || 0);
  set('plX', pl.cx); set('plY', pl.cy);
  $('arSize').textContent = `${nf(pl.width / 10, 1)} × ${nf(pl.width * aspect / 10, 1)} cm`;
}
function bindPlacementField(id, fn) {
  $(id).onchange = () => {
    if (!design || !S.placement) return;
    const v = parseFloat($(id).value);
    if (isNaN(v)) return;
    fn(v);
    save(); replanNow();
  };
}
bindPlacementField('plW', v => { S.placement.width = Math.max(5, v); });
bindPlacementField('plH', v => { const bb = design.bbox; S.placement.width = Math.max(5, v * (bb.x1 - bb.x0) / Math.max(1e-6, bb.y1 - bb.y0)); });
bindPlacementField('plR', v => { S.placement.rotation = v; });
bindPlacementField('plX', v => { S.placement.cx = v; });
bindPlacementField('plY', v => { S.placement.cy = v; });
$('plRotGesture').checked = S.view.rotGesture;
$('plRotGesture').onchange = () => { S.view.rotGesture = $('plRotGesture').checked; save(); };

$('btnCenterRobot').onclick = () => { if (!S.placement) return; const p = robotPos(); S.placement.cx = Math.round(p.x); S.placement.cy = Math.round(p.y); save(); replanNow(); };
$('btnFitArea').onclick = () => {
  if (!design || !S.placement) return;
  const area = safeArea(S.geom, S.limits);
  const test = { ...S.placement, width: 1000, cx: 0, cy: 0 };
  const cs = placedCorners(design, test);
  const w = Math.max(...cs.map(p => p[0])) - Math.min(...cs.map(p => p[0]));
  const h = Math.max(...cs.map(p => p[1])) - Math.min(...cs.map(p => p[1]));
  const k = Math.min((area.x1 - area.x0) / w, (area.y1 - area.y0) / h) * 0.96;
  S.placement.width = Math.round(1000 * k);
  S.placement.cx = Math.round((area.x0 + area.x1) / 2);
  S.placement.cy = Math.round((area.y0 + area.y1) / 2);
  save(); replanNow();
};
$('btnFlip').onclick = () => { if (!S.placement) return; S.placement.flipX = !S.placement.flipX; save(); replanNow(); };
$('btnFitView').onclick = () => { wall.fit(); wall.draw(); };
$('btnTravel').onclick = () => { S.view.showTravel = !S.view.showTravel; $('btnTravel').classList.toggle('on', S.view.showTravel); save(); updateScenes(); };

$('simRange').oninput = () => {
  stopSim();
  const v = +$('simRange').value;
  simStep = v >= 1000 || !plan ? null : v / 1000 * plan.steps.length;
  wall.setScene({ ...sceneBase(), progressStep: simStep });
  simLabel();
};
function simLabel() {
  if (!plan || simStep === null) { $('simLabel').textContent = 'Ablauf'; return; }
  const k = Math.floor(simStep);
  const st = plan.steps[Math.min(k, plan.steps.length - 1)];
  const ps = st && st.pass !== undefined ? plan.passes[st.pass] : null;
  $('simLabel').textContent = ps ? ps.name : '';
}
function stopSim() { if (simTimer) { cancelAnimationFrame(simTimer); simTimer = null; $('btnSim').textContent = '▶'; } }
$('btnSim').onclick = () => {
  if (!plan) return;
  if (simTimer) { stopSim(); return; }
  $('btnSim').textContent = '❚❚';
  const n = plan.steps.length;
  let t0 = null;
  const from = simStep === null ? 0 : simStep;
  const dur = 9000;
  const tick = (ts) => {
    if (t0 === null) t0 = ts;
    const s = from + (ts - t0) / dur * n;
    if (s >= n) { simStep = null; $('simRange').value = 1000; stopSim(); wall.setScene({ ...sceneBase(), progressStep: null }); simLabel(); return; }
    simStep = s;
    $('simRange').value = Math.round(s / n * 1000);
    wall.setScene({ ...sceneBase(), progressStep: simStep });
    simLabel();
    simTimer = requestAnimationFrame(tick);
  };
  simTimer = requestAnimationFrame(tick);
};

function renderStats() {
  const el = $('planStats');
  const lg = $('wallLegend');
  lg.innerHTML = '';
  if (!plan) { el.innerHTML = '<span class="muted">Wähle zuerst ein Motiv.</span>'; return; }
  const s = plan.stats;
  const bb = design.bbox;
  const h = S.placement.width * (bb.y1 - bb.y0) / Math.max(1e-6, bb.x1 - bb.x0);
  const items = [
    ['Größe', `${nf(S.placement.width / 10, 1)} × ${nf(h / 10, 1)} cm`],
    ['Strichlänge', `${nf(s.drawn / 1000, 1)} m`],
    ['Dauer ca.', fmtTime(planEst.time + Math.ceil(planEst.bytes / S.conn.budget) * 1.2)],
    ['Absetzen', nf(s.lifts)],
    ['Stiftwechsel', nf(s.changes)],
    ['Pakete', nf(Math.ceil(planEst.bytes / S.conn.budget))],
  ];
  el.innerHTML = items.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')
    + (s.outside ? `<div class="stat bad"><b>${nf(s.outside)} Punkte</b><span>außerhalb des sicheren Bereichs</span></div>` : '');
  plan.passes.forEach(p => {
    if (!p.strokes.length) return;
    const c = document.createElement('span');
    c.className = 'legend-chip';
    c.innerHTML = `<span class="cap small" style="background:${p.color}">${p.slot + 1}</span>${escapeHtml(p.name)}`;
    lg.appendChild(c);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ---------------- AR ----------------
function arUi() {
  const live = ar.mode === 'live';
  const tapping = ar.tapStep > 0;
  $('arShot').hidden = !live;
  $('arCam').hidden = live;
  $('arRedo').hidden = ar.mode !== 'photo' || tapping;
  $('arSkip').hidden = ar.tapStep !== 3;
  $('arEmpty').hidden = ar.mode !== 'none';
  if (ar.mode === 'none') ar.setHint('');
  else if (ar.mode === 'photo' && !design && !tapping) ar.setHint('Wähle unter „Motiv“ etwas aus, dann erscheint es hier an der Wand.');
}
$('arCam').onclick = async () => { try { await ar.startCamera(); } catch (e) { toast(e.message || 'Kamera nicht erlaubt', true); } arUi(); };
$('arShot').onclick = () => { ar.capture(); arUi(); };
$('arLoad').onclick = () => $('fileAr').click();
$('fileAr').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { await ar.loadFile(f); arUi(); } };
$('arRedo').onclick = () => { ar.beginRegistration(); arUi(); };
$('arSkip').onclick = () => { ar.skipRobotPoint(); arUi(); };
$('arOpacity').oninput = () => { ar.opacity = $('arOpacity').value / 100; ar.draw(); };

// ---------------- Zeichnen ----------------
function renderDraw() {
  $('drawTitle').textContent = design ? design.name : 'Kein Motiv';
  drawDesignThumb($('drawThumb'), design, { colorFor: thumbColor });
  const f = $('drawFacts');
  if (plan) {
    const bb = design.bbox;
    const h = S.placement.width * (bb.y1 - bb.y0) / Math.max(1e-6, bb.x1 - bb.x0);
    f.innerHTML = `${nf(S.placement.width / 10, 1)} × ${nf(h / 10, 1)} cm, ${nf(plan.stats.drawn / 1000, 1)} m Linie<br>Dauer ca. ${fmtTime(planEst.time + Math.ceil(planEst.bytes / S.conn.budget) * 1.2)}`;
  } else f.textContent = 'Wähle zuerst ein Motiv.';
  const pn = $('penNeeded');
  pn.innerHTML = '';
  if (plan) {
    plan.passes.filter(p => p.strokes.length).forEach(p => {
      const d = document.createElement('div');
      d.className = 'pen-need';
      d.innerHTML = `<span class="cap" style="background:${p.color}">${p.slot + 1}</span><span>${p.swap ? 'Unterwegs tauschen: ' : ''}<b>${escapeHtml(p.name)}</b> in Platz ${p.slot + 1}</span>`;
      pn.appendChild(d);
    });
    if (!pn.children.length) pn.innerHTML = '<span class="muted">Nichts zu zeichnen. Prüfe die Farbzuordnung.</span>';
  }
  $('chkGeomText').textContent = `Wandmaße stimmen (A ${nf(S.geom.anchorDistance)} mm, links ${nf(S.robot.L)} mm, rechts ${nf(S.robot.R)} mm)`;
  $('optHome').checked = S.plan.homePen;
  $('optReturn').checked = S.plan.returnHome;
  const busy = runner && ['running', 'paused', 'swap', 'stopping'].includes(runner.state);
  $('btnStart').disabled = !plan || busy;
  $('btnFrame').disabled = !plan || busy;
  $('btnStart').textContent = busy ? 'Zeichnet…' : 'Zeichnen starten';
}
$('optHome').onchange = () => { S.plan.homePen = $('optHome').checked; save(); replan(); };
$('optReturn').onchange = () => { S.plan.returnHome = $('optReturn').checked; save(); replan(); };

async function ensureReady() {
  const s = await dev.getStatus();
  if (!s.online) { toast('Roboter nicht erreichbar. Mit dem ScribIt-WLAN verbunden?', true); return false; }
  if (s.state !== 'IDLE') { toast('Roboter ist beschäftigt (' + s.state + ')', true); return false; }
  return true;
}

function startRunner(p, label, after) {
  runner = new JobRunner(p, S.gcode, {
    budget: S.conn.budget,
    onUpdate: renderJob,
    onLog: log,
    onRobot: (st) => { S.robot.L = round2(st.L); S.robot.R = round2(st.R); S.robot.penSlot = st.slot; save(); },
    onSwap: (sw) => {
      modal('Stift tauschen', `<div class="pen-need"><span class="cap" style="background:${sw.color}">${sw.slot + 1}</span><span>Nimm den Stift aus <b>Platz ${sw.slot + 1}</b> und setze <b>${escapeHtml(sw.name)}</b> ein. Den Roboter dabei möglichst nicht verschieben.</span></div>`, [
        { label: 'Abbrechen', onClick: () => { runner.stop(); } },
        { label: 'Getauscht, weiter', cls: 'primary', onClick: () => { runner.confirmSwap(); } },
      ]);
      dev.native('notifyUser', 'Stift tauschen: ' + sw.name);
    },
  });
  jobView.setScene({ ...sceneBase(), plan: p, design: null, placement: null, progressStep: 0 });
  jobView.fitted = false; jobView.fit();
  $('jobPanel').hidden = false;
  requestAnimationFrame(() => $('jobPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('log').textContent = '';
  log(label + ' gestartet');
  dev.native('keepScreenOn', true);
  dev.native('jobStarted', label);
  const t = setInterval(() => renderJob(runner), 1000);
  runner.start().finally(() => {
    clearInterval(t);
    dev.native('keepScreenOn', false);
    dev.native('jobStopped', runner.message || 'Fertig');
    log(runner.message);
    renderJob(runner);
    if (runner.state === 'done') {
      S.robot.homed = true; save();
      toast(label + ' fertig');
      after && after();
    } else if (runner.state === 'error') toast(runner.message, true);
    renderDraw();
    replan();
  });
  renderDraw();
}

function renderJob(r) {
  if (!r) return;
  const pr = r.progress();
  const names = { running: 'Zeichnet', paused: 'Pausiert', swap: 'Wartet auf Stiftwechsel', stopping: 'Stoppt', done: 'Fertig', stopped: 'Gestoppt', error: 'Fehler', idle: 'Bereit' };
  $('jobState').textContent = names[r.state] || r.state;
  const pct = r.state === 'done' ? 100 : Math.min(99, Math.floor(pr.fraction * 100));
  $('jobPct').textContent = pct + ' %';
  $('jobBar').style.width = pct + '%';
  $('jobFacts').innerHTML = `<div><b>${nf(pr.drawn / 1000, 2)} m</b><br><span class="muted">von ${nf(pr.totalDraw / 1000, 1)} m</span></div>`
    + `<div><b>${fmtTime(pr.elapsed)}</b><br><span class="muted">vergangen</span></div>`
    + `<div><b>${r.state === 'done' ? '0 s' : fmtTime(pr.remaining)}</b><br><span class="muted">noch ca.</span></div>`
    + `<div style="grid-column:1/-1" class="muted">${escapeHtml(r.message || '')}</div>`;
  const active = ['running', 'paused', 'swap', 'stopping'].includes(r.state);
  $('btnPause').disabled = !active || r.state === 'stopping' || r.state === 'swap';
  $('btnPause').textContent = r.state === 'paused' ? 'Weiter' : 'Pause';
  $('btnStop').disabled = !active || r.state === 'stopping';
  jobView.setScene({ ...jobView.scene, robot: S.robot, progressStep: r.state === 'done' ? null : pr.step });
  dev.native('jobProgress', `${pct} %, noch ${fmtTime(pr.remaining)}`);
}
$('btnPause').onclick = () => { if (!runner) return; if (runner.state === 'paused') runner.resume(); else runner.pause(); renderJob(runner); };
$('btnStop').onclick = async () => {
  if (!runner) return;
  if (await confirmBox('Zeichnung stoppen?', 'Der Roboter beendet das aktuelle Paket (wenige Sekunden), hebt den Stift und fährt zurück zur Startposition.', 'Stoppen')) runner.stop();
};

$('btnStart').onclick = async () => {
  if (!design || !plan) { toast('Erst ein Motiv wählen'); return; }
  if (!(await ensureReady())) return;
  if (!$('chkGeom').checked || !$('chkPens').checked) {
    if (!(await confirmBox('Noch nicht alles abgehakt', 'Wandmaße und Stifte sind nicht bestätigt. Falsche Maße verzerren das Bild oder fahren den Roboter an den Rand.', 'Trotzdem starten'))) return;
  }
  const p = makePlan();
  if (p.stats.outside > 0 && !(await confirmBox('Außerhalb des sicheren Bereichs', `${nf(p.stats.outside)} Punkte liegen außerhalb des grün gestrichelten Bereichs. Der Roboter könnte anstoßen oder die Fäden zu stark spannen.`, 'Trotzdem starten'))) return;
  plan = p; planPlacement = { ...S.placement };
  updateScenes();
  startRunner(p, 'Zeichnung');
};

$('btnFrame').onclick = async () => {
  if (!plan || !(await ensureReady())) return;
  const cs = placedCorners(design, S.placement);
  const start = robotPos();
  const steps = [...cs, cs[0]].map(c => ({ k: 'move', x: c[0], y: c[1], draw: false }));
  steps.push({ k: 'move', x: start.x, y: start.y, draw: false, home: true });
  const p = { steps, passes: [], start, robot: { ...S.robot }, geom: { ...S.geom }, stats: { drawn: 0 } };
  startRunner(p, 'Rahmen');
};

$('btnExport').onclick = () => {
  if (!plan) return;
  const ex = exportGcode(plan, S.gcode, S.robot);
  const name = (design.name || 'motiv').replace(/[^\w\-äöüÄÖÜß]+/g, '_') + '.gcode';
  saveFile(name, 'text/plain', ex.text);
  toast(`${name} (${nf(ex.text.length / 1024, 1)} KB)`);
};

// ---------------- Gerät ----------------
function renderDevice() {
  $('connHost').value = S.conn.host;
  $('connPort').value = S.conn.port;
  $('budget').value = String(S.conn.budget);
  $('gA').value = S.geom.anchorDistance;
  $('gL').value = S.robot.L;
  $('gR').value = S.robot.R;
  renderGeo();
  renderPens();
  renderKInfo();
  renderConnInfo();
}

function renderGeo() {
  const p = robotPos();
  const A = S.geom.anchorDistance;
  if (document.activeElement !== $('gX')) $('gX').value = Math.round(p.x);
  if (document.activeElement !== $('gY')) $('gY').value = Math.round(p.y);
  const ok = p.valid;
  $('geoInfo').innerHTML = ok
    ? `Stiftspitze bei ${nf(p.x)} mm von links, ${nf(p.y)} mm unter der Ankerlinie.`
    : '<span style="color:var(--danger)">Diese Fadenlängen passen nicht zusammen (Summe muss größer als der Abstand sein).</span>';
  // Diagramm
  const sx = 280 / A;
  const bx = 20 + Math.max(0, Math.min(A, p.x)) * sx, by = 20 + Math.min(110, Math.max(30, p.y * sx));
  $('geoL').setAttribute('x2', bx); $('geoL').setAttribute('y2', by);
  $('geoR').setAttribute('x2', bx); $('geoR').setAttribute('y2', by);
  $('geoBot').setAttribute('x', bx - 12); $('geoBot').setAttribute('y', by - 6);
  $('geoLt').setAttribute('x', (20 + bx) / 2 - 18); $('geoLt').setAttribute('y', (20 + by) / 2);
  $('geoRt').setAttribute('x', (300 + bx) / 2 + 6); $('geoRt').setAttribute('y', (20 + by) / 2);
}

function geoChanged() { save(); renderGeo(); replan(); if (wall) wall.fitted = false; }
$('gA').onchange = () => { const v = parseFloat($('gA').value); if (v > 200) { S.geom.anchorDistance = v; geoChanged(); } };
$('gL').onchange = () => { const v = parseFloat($('gL').value); if (v > 50) { S.robot.L = v; geoChanged(); } };
$('gR').onchange = () => { const v = parseFloat($('gR').value); if (v > 50) { S.robot.R = v; geoChanged(); } };
$('btnPosApply').onclick = () => {
  const x = parseFloat($('gX').value), y = parseFloat($('gY').value);
  if (isNaN(x) || isNaN(y) || y <= 0) { toast('Position ungültig', true); return; }
  const l = lengthsAt(S.geom, x, y);
  S.robot.L = round2(l.L); S.robot.R = round2(l.R);
  $('gL').value = S.robot.L; $('gR').value = S.robot.R;
  geoChanged();
  toast('Fadenlängen berechnet');
};
$('connHost').onchange = () => { S.conn.host = $('connHost').value.trim() || '192.168.240.1'; dev.setConnection(S.conn.host, S.conn.port); save(); pollNow(); };
$('connPort').onchange = () => { S.conn.port = parseInt($('connPort').value, 10) || 8888; dev.setConnection(S.conn.host, S.conn.port); save(); pollNow(); };
$('budget').onchange = () => { S.conn.budget = parseInt($('budget').value, 10) || 1300; save(); renderStats(); };
$('btnWifi').onclick = () => { if (dev.native('openWifiSettings') === null) toast('Öffne die WLAN-Einstellungen am Handy'); };
$('btnReconnect').onclick = () => { dev.native('rebindWifi'); pollNow(); };

// Joggen
document.querySelectorAll('#jogStep button').forEach(b => {
  b.classList.toggle('on', +b.dataset.v === S.jogStep);
  b.onclick = () => { S.jogStep = +b.dataset.v; save(); document.querySelectorAll('#jogStep button').forEach(x => x.classList.toggle('on', x === b)); };
});
async function moveTo(x, y) {
  if (!(await ensureReady())) return;
  const l = lengthsAt(S.geom, x, y);
  const dL = round2(l.L - S.robot.L), dR = round2(l.R - S.robot.R);
  if (!dL && !dR) return;
  const r = await dev.sendCommands(['G91', `G1 X${dL} Y${round2(-dR)} F${S.gcode.feedTravel}`]);
  if (r.ok) {
    S.robot.L = round2(S.robot.L + dL); S.robot.R = round2(S.robot.R + dR);
    save(); renderDevice(); replan();
  } else toast('Befehl nicht angenommen: ' + (r.error || r.status), true);
}
document.querySelectorAll('.jog-btn[data-d]').forEach(b => b.onclick = () => {
  const [dx, dy] = b.dataset.d.split(',').map(Number);
  const p = robotPos();
  moveTo(p.x + dx * S.jogStep, p.y + dy * S.jogStep);
});
$('btnJogCenter').onclick = () => { const p = robotPos(); moveTo(S.geom.anchorDistance / 2, p.y); };

// Stifte
function renderPens() {
  const el = $('penSlots');
  el.innerHTML = '';
  S.pens.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pen-slot';
    const cap = document.createElement('span');
    cap.className = 'cap' + (S.robot.penSlot === i ? ' current' : '');
    cap.style.background = p.color; cap.textContent = i + 1;
    const name = document.createElement('input');
    name.type = 'text'; name.value = p.name; name.setAttribute('list', 'penNames');
    name.onchange = () => {
      p.name = name.value.trim() || ('Stift ' + (i + 1));
      const pre = PEN_PRESETS.find(x => x.name.toLowerCase() === p.name.toLowerCase());
      if (pre) { p.color = pre.color; col.value = pre.color; cap.style.background = pre.color; }
      save(); renderColors(); replan();
    };
    const col = document.createElement('input');
    col.type = 'color'; col.value = toHex(parseColor(p.color) || [0, 0, 0]);
    col.oninput = () => { p.color = col.value; cap.style.background = col.value; };
    col.onchange = () => { save(); replan(); drawDesignThumb($('designThumb'), design, { colorFor: thumbColor }); };
    row.append(cap, name, col);
    el.appendChild(row);
  });
  let dl = document.getElementById('penNames');
  if (!dl) {
    dl = document.createElement('datalist'); dl.id = 'penNames';
    PEN_PRESETS.forEach(p => dl.appendChild(new Option(p.name)));
    document.body.appendChild(dl);
  }
  $('penState').textContent = S.robot.homed
    ? `Aktuell vorne: Platz ${S.robot.penSlot + 1} (${S.pens[S.robot.penSlot]?.name || ''}), Stift oben.`
    : 'Stiftmechanik seit dem letzten Start nicht kalibriert.';
  $('swapSlot').value = String(S.plan.swapSlot);
  renderExtras();
}
$('swapSlot').onchange = () => { S.plan.swapSlot = parseInt($('swapSlot').value, 10); save(); replan(); };

function renderExtras() {
  const el = $('extraColors');
  el.innerHTML = '';
  S.extra.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pen-slot';
    const cap = document.createElement('span');
    cap.className = 'cap'; cap.style.background = p.color; cap.textContent = 'T' + (i + 1);
    const name = document.createElement('input');
    name.type = 'text'; name.value = p.name; name.setAttribute('list', 'penNames');
    name.onchange = () => { p.name = name.value.trim() || 'Tausch ' + (i + 1); const pre = PEN_PRESETS.find(x => x.name.toLowerCase() === p.name.toLowerCase()); if (pre) { p.color = pre.color; } save(); renderExtras(); renderColors(); replan(); };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'Entfernen';
    del.onclick = () => {
      S.extra.splice(i, 1);
      for (const k of Object.keys(S.colorMap)) { const v = S.colorMap[k]; if (v === 10 + i) S.colorMap[k] = 0; else if (v > 10 + i) S.colorMap[k] = v - 1; }
      save(); renderExtras(); renderColors(); replan();
    };
    row.append(cap, name, del);
    el.appendChild(row);
  });
}
$('btnAddExtra').onclick = () => {
  const used = new Set([...S.pens, ...S.extra].map(p => p.name));
  const pre = PEN_PRESETS.find(p => !used.has(p.name)) || PEN_PRESETS[4];
  S.extra.push({ name: pre.name, color: pre.color });
  save(); renderExtras(); renderColors();
};

async function penCommand(lines, okMsg, after) {
  if (!(await ensureReady())) return;
  const r = await dev.sendCommands(lines);
  if (r.ok) { after && after(); save(); renderPens(); toast(okMsg); } else toast('Befehl nicht angenommen: ' + (r.error || r.status), true);
}
$('btnHomePen').onclick = () => penCommand(['M17', 'G77', 'G90', 'G1 Z160', 'G91', 'G1 Z-70'], 'Stiftmechanik kalibriert: Platz 1 vorne, Stift oben', () => { S.robot.penSlot = 0; S.robot.homed = true; });
$('btnNextPen').onclick = () => {
  if (!S.robot.homed) { toast('Bitte zuerst kalibrieren, sonst weiß die App nicht, welcher Stift vorne ist.', true); return; }
  const st = { L: 0, R: 0, z: 0, slot: S.robot.penSlot, feed: S.gcode.feedPen };
  const to = (S.robot.penSlot + 1) % 4;
  const r = compileStep({ k: 'pen', from: st.slot, to }, st, null, S.gcode);
  penCommand(['G91', ...r.lines], `Platz ${to + 1} ist jetzt vorne`, () => { S.robot.penSlot = to; });
};
$('btnTestPen').onclick = () => penCommand(['G91', 'G1 Z-30', 'G4 P1200', 'G1 Z30'], 'Stift abgesenkt und wieder gehoben');
$('btnRotCcw').onclick = () => { const d = Math.abs(parseFloat($('rotDeg').value) || 0); if (d) penCommand(['G91', `G1 Z${d}`], `${d}° gedreht`, () => { S.robot.homed = false; }); };
$('btnRotCw').onclick = () => { const d = Math.abs(parseFloat($('rotDeg').value) || 0); if (d) penCommand(['G91', `G1 Z-${d}`], `${d}° im Uhrzeigersinn gedreht`, () => { S.robot.homed = false; }); };

// Kalibrierung Maßhaltigkeit
function renderKInfo() {
  $('kInfo').textContent = `Korrektur aktuell: Breite × ${nf(S.geom.kx, 3)}, Höhe × ${nf(S.geom.ky, 3)}`;
}
$('btnTestSquare').onclick = async () => {
  const size = parseFloat($('tqSize').value) || 200;
  if (!(await ensureReady())) return;
  const d = importSVG(testSquareSVG(size), 'Testquadrat');
  const p0 = robotPos();
  const cmap = {};
  collectColors(d).forEach(c => { cmap[c.hex] = S.plan.homePen ? 0 : S.robot.penSlot; });
  const p = buildPlan(d, { cx: p0.x, cy: p0.y, width: size, rotation: 0 }, S.pens, cmap,
    { ...S.plan, drawFills: false, minLen: 0, simplifyTol: 0.05, returnHome: true, limits: S.limits }, S.geom, S.robot, S.extra);
  startRunner(p, 'Testquadrat', () => { $('tqW').focus(); toast('Jetzt Breite und Höhe nachmessen'); });
  showTab('draw');
};
$('btnTqApply').onclick = () => {
  const size = parseFloat($('tqSize').value) || 200;
  const w = parseFloat($('tqW').value), h = parseFloat($('tqH').value);
  if (!(w > 0) && !(h > 0)) { toast('Gemessene Werte eintragen', true); return; }
  if (w > 0) S.geom.kx = round3(S.geom.kx * size / w);
  if (h > 0) S.geom.ky = round3(S.geom.ky * size / h);
  save(); renderKInfo(); replan();
  toast('Korrektur gespeichert');
};
const round3 = (v) => Math.round(v * 1000) / 1000;

function renderStaticDeviceControls() {
  const gt = $('geoToggles');
  gt.innerHTML = '';
  toggle(gt, { label: 'Unbrickit Höhenkorrektur (gemessen am echten Gerät)', get: () => S.geom.yCorrection, set: v => { S.geom.yCorrection = v; save(); }, done: replan });
  toggle(gt, { label: 'Winkelkorrektur der Fadenbreite', get: () => S.geom.angleCorrection, set: v => { S.geom.angleCorrection = v; save(); }, done: replan });
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn'; b.textContent = 'Korrektur auf 1,0 zurücksetzen';
  b.onclick = () => { S.geom.kx = 1; S.geom.ky = 1; save(); renderKInfo(); replan(); };
  gt.appendChild(b);

  const a = $('advSliders');
  a.innerHTML = '';
  const G = S.gcode;
  const mm = v => nf(v) + ' mm/min';
  slider(a, { label: 'Tempo beim Zeichnen', min: 300, max: 2400, step: 50, get: () => G.feedDraw, set: v => { G.feedDraw = v; save(); }, done: replan, fmt: mm });
  slider(a, { label: 'Tempo bei Leerfahrten', min: 300, max: 2400, step: 50, get: () => G.feedTravel, set: v => { G.feedTravel = v; save(); }, done: replan, fmt: mm });
  slider(a, { label: 'Tempo des Stiftzylinders', min: 300, max: 2400, step: 50, get: () => G.feedPen, set: v => { G.feedPen = v; save(); }, done: replan, fmt: v => nf(v) + ' °/min' });
  slider(a, { label: 'Warten nach Stift runter', min: 0, max: 1000, step: 50, get: () => G.dwellDown, set: v => { G.dwellDown = v; save(); }, done: replan, fmt: v => v + ' ms' });
  slider(a, { label: 'Max. Teilstrecke', min: 2, max: 30, step: 1, get: () => S.plan.maxSeg, set: v => { S.plan.maxSeg = v; save(); }, done: replan, fmt: v => v + ' mm' });
  slider(a, { label: 'Sicherer Bereich: Rand seitlich', min: 0, max: 500, step: 10, get: () => S.limits.side, set: v => { S.limits.side = v; save(); }, done: replan, fmt: v => v + ' mm' });
  slider(a, { label: 'Sicherer Bereich: Abstand oben', min: 50, max: 800, step: 10, get: () => S.limits.top, set: v => { S.limits.top = v; save(); }, done: replan, fmt: v => v + ' mm' });
  slider(a, { label: 'Sicherer Bereich: tiefster Punkt', min: 400, max: 4000, step: 50, get: () => S.limits.bottom, set: v => { S.limits.bottom = v; save(); }, done: replan, fmt: v => v + ' mm' });
  slider(a, { label: 'Gondel: Abstand Faden-Austritte', min: 40, max: 200, step: 1, get: () => S.geom.gondolaWidth, set: v => { S.geom.gondolaWidth = v; save(); }, done: replan, fmt: v => v + ' mm' });
  slider(a, { label: 'Gondel: Höhenversatz', min: 0, max: 150, step: 0.5, get: () => S.geom.attachOffset, set: v => { S.geom.attachOffset = v; save(); }, done: replan, fmt: v => nf(v, 1) + ' mm' });
}

$('btnSendG').onclick = async () => {
  const t = $('gcodeIn').value.trim();
  if (!t) return;
  if (!(await ensureReady())) return;
  const r = await dev.sendCommands(t);
  if (r.ok) { toast('Gesendet'); if (/G77|Z/i.test(t)) { S.robot.homed = /G77/.test(t) ? S.robot.homed : false; save(); } }
  else toast('Nicht angenommen: ' + (r.error || r.status), true);
};
$('btnResetAll').onclick = async () => {
  if (!(await confirmBox('Alles zurücksetzen?', 'Wandmaße, Stifte, Kalibrierung und Einstellungen gehen verloren.', 'Zurücksetzen'))) return;
  const d = defaults();
  Object.keys(S).forEach(k => delete S[k]);
  Object.assign(S, d);
  saveSettings(S);
  location.reload();
};

// ---------------- Verbindung ----------------
function renderConnChip(s) {
  const c = $('connChip');
  let cls = 'off', lbl = 'Nicht verbunden';
  if (s.online) {
    if (s.state === 'IDLE') { cls = 'ok'; lbl = 'Bereit'; }
    else if (s.state === 'PRINTING') { cls = s.paused !== 'running' ? 'paused' : 'busy'; lbl = s.paused !== 'running' ? 'Pausiert' : 'Zeichnet'; }
    else if (s.state === 'ERROR') { cls = 'err'; lbl = 'Fehler'; }
    else { cls = 'busy'; lbl = s.state; }
  }
  c.className = 'conn ' + cls;
  c.querySelector('.lbl').textContent = lbl;
}
function renderConnInfo() {
  const s = lastStatus;
  $('connInfo').innerHTML = s.online
    ? `Verbunden: ${escapeHtml(s.state)}${s.version ? ', Firmware ' + escapeHtml(s.version) : ''}${s.id ? '<br><span class="muted">Gerät ' + escapeHtml(s.id) + '</span>' : ''}`
    : `Nicht erreichbar <span class="muted">(${escapeHtml(s.error || '')})</span>`;
}
dev.onStatus((s) => { lastStatus = s; renderConnChip(s); if (currentTab === 'device') renderConnInfo(); });
let pollT = null;
async function pollNow() {
  clearTimeout(pollT);
  const busy = runner && ['running', 'paused', 'swap', 'stopping'].includes(runner.state);
  if (!busy) await dev.getStatus();
  pollT = setTimeout(pollNow, lastStatus.online ? 3000 : 2500);
}

// ---------------- Start ----------------
function init() {
  wall = new WallView($('wallCanvas'), {
    onPlacementLive: (pl) => renderPlacementFields(pl),
    onPlacement: (pl) => { S.placement = { ...pl }; save(); replanNow(); },
    get allowRotate() { return S.view.rotGesture; },
  });
  jobView = new WallView($('jobCanvas'), { interactive: false, fitPlan: true });
  ar = new ARView($('tab-ar'), {
    getScene: () => sceneBase(),
    onPlacementLive: (pl) => renderPlacementFields(pl),
    onPlacement: (pl) => { S.placement = { ...pl }; save(); replanNow(); },
    allowRotate: () => S.view.rotGesture,
    onArState: () => arUi(),
  });
  $('btnTravel').classList.toggle('on', S.view.showTravel);
  renderSamples();
  renderTrace();
  renderStaticDeviceControls();
  renderDevice();
  renderMotiv();
  const ver = dev.native('appVersion');
  $('appVer').textContent = ver ? 'v' + ver : '';
  ar.restore().then(() => arUi());
  // letztes Motiv wiederherstellen
  getBlob('design').then(async (saved) => {
    if (saved && saved.design) {
      if (saved.kind === 'image' && saved.image) {
        try { sourceImg = await loadImage(saved.image); sourceImg.dataset.name = saved.design.name; renderTrace(); } catch (e) { sourceImg = null; }
      }
      await setDesign(saved.design, { keepPlacement: true, noPersist: true, kind: saved.kind });
    } else updateScenes();
  });
  pollNow();
}
init();

// Aus der Galerie geteilt oder SVG mit der App geöffnet
window.onSharedFile = async () => {
  const raw = dev.native('takeSharedFile');
  if (!raw) return;
  try {
    const o = JSON.parse(raw);
    S.placement = null;
    if (o.kind === 'svg') await useSvgText(o.text, (o.name || 'SVG').replace(/\.svg$/i, ''));
    else await useImage(o.dataUrl, (o.name || 'Bild').replace(/\.[^.]+$/, ''));
    showTab('motiv');
  } catch (e) { toast('Datei konnte nicht geöffnet werden: ' + e.message, true); }
};
setTimeout(() => window.onSharedFile(), 600);

// Für Tests im Browser
window.__app = { get plan() { return plan; }, get runner() { return runner; }, S };
