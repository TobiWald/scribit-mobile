// SVG-Import: nutzt die SVG-Engine des Browsers für Transforms, CSS und Farben.
// Unterstützt path, rect, circle, ellipse, line, polyline, polygon, verschachtelte Gruppen,
// transform-Attribute, <use>-Verweise und gefüllte Flächen (werden später schraffiert).

import { parseColor } from './colors.js';
import { designBBox } from './geometry.js';

// ---------- Pfad-Parser (alle Befehle, relativ/absolut, implizite Wiederholungen) ----------
function tokenize(d) {
  const toks = [];
  let i = 0;
  const n = d.length;
  while (i < n) {
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { toks.push(ch); i++; continue; }
    if (/[\s,]/.test(ch)) { i++; continue; }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i, i + 40));
    if (m) { toks.push(parseFloat(m[0])); i += m[0].length; continue; }
    i++; // unbekanntes Zeichen überspringen
  }
  return toks;
}

// Bögen: Flags können ohne Trennzeichen stehen ("a1 1 0 01 2 2")
function fixArcFlags(d) {
  return d.replace(/([Aa])([^MmLlHhVvCcSsQqTtZz]*)/g, (all, cmd, args) => {
    const out = [];
    const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
    let idx = 0;
    const raw = args;
    let pos = 0;
    while (pos < raw.length) {
      const c = raw[pos];
      if (/[\s,]/.test(c)) { pos++; continue; }
      const k = idx % 7;
      if (k === 3 || k === 4) {
        if (c === '0' || c === '1') { out.push(c); pos++; idx++; continue; }
      }
      re.lastIndex = pos;
      const m = re.exec(raw);
      if (!m || m.index !== pos) { pos++; continue; }
      out.push(m[0]); pos += m[0].length; idx++;
    }
    return cmd + ' ' + out.join(' ') + ' ';
  });
}

function arcToPoints(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, seg) {
  const pts = [];
  if (rx === 0 || ry === 0) { pts.push([x2, y2]); return pts; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = phiDeg * Math.PI / 180;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / (den || 1)));
  if (fa === fs) co = -co;
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) * Math.max(rx, ry) / seg));
  for (let i = 1; i <= n; i++) {
    const t = t1 + dt * i / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push([cx + ex * cp - ey * sp, cy + ex * sp + ey * cp]);
  }
  return pts;
}

function cubic(p0, p1, p2, p3, seg) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(2, Math.min(200, Math.ceil(len / seg)));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function quad(p0, p1, p2, seg) {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const n = Math.max(2, Math.min(200, Math.ceil(len / seg)));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

// Liefert Teilpfade: [{pts:[[x,y]...], closed}]
export function parsePathD(d, seg = 1) {
  const toks = tokenize(fixArcFlags(d || ''));
  const subs = [];
  let cur = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let lcx = null, lcy = null, lqx = null, lqy = null;
  let cmd = null;
  let i = 0;
  const num = () => { const v = toks[i++]; return typeof v === 'number' ? v : NaN; };
  const start = (nx, ny) => {
    if (cur && cur.pts.length > 1) subs.push(cur);
    cur = { pts: [[nx, ny]], closed: false };
    sx = nx; sy = ny;
  };
  const lineTo = (nx, ny) => { if (!cur) start(x, y); cur.pts.push([nx, ny]); };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') { cmd = toks[i++]; }
    else if (cmd === null) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      if (cur) { cur.closed = true; if (cur.pts.length > 1) subs.push(cur); cur = null; }
      x = sx; y = sy; lcx = lcy = lqx = lqy = null;
      // Nach Z darf direkt ein neuer Befehl kommen
      if (typeof toks[i] === 'number') cmd = rel ? 'l' : 'L';
      continue;
    }
    if (typeof toks[i] !== 'number') { continue; }
    if (C === 'M') {
      const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
      if (isNaN(nx) || isNaN(ny)) break;
      start(nx, ny); x = nx; y = ny;
      cmd = rel ? 'l' : 'L';
      lcx = lcy = lqx = lqy = null;
    } else if (C === 'L') {
      const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
      if (isNaN(nx) || isNaN(ny)) break;
      lineTo(nx, ny); x = nx; y = ny; lcx = lcy = lqx = lqy = null;
    } else if (C === 'H') {
      const nx = num() + (rel ? x : 0); if (isNaN(nx)) break;
      lineTo(nx, y); x = nx; lcx = lcy = lqx = lqy = null;
    } else if (C === 'V') {
      const ny = num() + (rel ? y : 0); if (isNaN(ny)) break;
      lineTo(x, ny); y = ny; lcx = lcy = lqx = lqy = null;
    } else if (C === 'C') {
      const a = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      const b = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      const e = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      if (e.some(isNaN)) break;
      if (!cur) start(x, y);
      cur.pts.push(...cubic([x, y], a, b, e, seg));
      lcx = b[0]; lcy = b[1]; lqx = lqy = null; x = e[0]; y = e[1];
    } else if (C === 'S') {
      const a = lcx !== null ? [2 * x - lcx, 2 * y - lcy] : [x, y];
      const b = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      const e = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      if (e.some(isNaN)) break;
      if (!cur) start(x, y);
      cur.pts.push(...cubic([x, y], a, b, e, seg));
      lcx = b[0]; lcy = b[1]; lqx = lqy = null; x = e[0]; y = e[1];
    } else if (C === 'Q') {
      const a = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      const e = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      if (e.some(isNaN)) break;
      if (!cur) start(x, y);
      cur.pts.push(...quad([x, y], a, e, seg));
      lqx = a[0]; lqy = a[1]; lcx = lcy = null; x = e[0]; y = e[1];
    } else if (C === 'T') {
      const a = lqx !== null ? [2 * x - lqx, 2 * y - lqy] : [x, y];
      const e = [num() + (rel ? x : 0), num() + (rel ? y : 0)];
      if (e.some(isNaN)) break;
      if (!cur) start(x, y);
      cur.pts.push(...quad([x, y], a, e, seg));
      lqx = a[0]; lqy = a[1]; lcx = lcy = null; x = e[0]; y = e[1];
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), fa = num(), fs = num();
      const ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0);
      if (isNaN(ey)) break;
      if (!cur) start(x, y);
      cur.pts.push(...arcToPoints(x, y, rx, ry, rot, !!fa, !!fs, ex, ey, seg));
      x = ex; y = ey; lcx = lcy = lqx = lqy = null;
    } else {
      i++;
    }
  }
  if (cur && cur.pts.length > 1) subs.push(cur);
  return subs;
}

function ellipsePts(cx, cy, rx, ry, seg) {
  const n = Math.max(16, Math.min(360, Math.ceil(2 * Math.PI * Math.max(rx, ry) / seg)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * Math.PI * 2;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

function num(el, a, def = 0) {
  const v = parseFloat(el.getAttribute(a));
  return isNaN(v) ? def : v;
}

function elementSubpaths(el, seg) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') return parsePathD(el.getAttribute('d'), seg);
  if (tag === 'line') return [{ pts: [[num(el, 'x1'), num(el, 'y1')], [num(el, 'x2'), num(el, 'y2')]], closed: false }];
  if (tag === 'polyline' || tag === 'polygon') {
    const v = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const pts = [];
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
    return pts.length > 1 ? [{ pts, closed: tag === 'polygon' }] : [];
  }
  if (tag === 'circle') {
    const r = num(el, 'r');
    return r > 0 ? [{ pts: ellipsePts(num(el, 'cx'), num(el, 'cy'), r, r, seg), closed: true }] : [];
  }
  if (tag === 'ellipse') {
    const rx = num(el, 'rx'), ry = num(el, 'ry');
    return rx > 0 && ry > 0 ? [{ pts: ellipsePts(num(el, 'cx'), num(el, 'cy'), rx, ry, seg), closed: true }] : [];
  }
  if (tag === 'rect') {
    const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
    if (w <= 0 || h <= 0) return [];
    let rx = num(el, 'rx', NaN), ry = num(el, 'ry', NaN);
    if (isNaN(rx) && !isNaN(ry)) rx = ry;
    if (isNaN(ry) && !isNaN(rx)) ry = rx;
    if (isNaN(rx)) rx = ry = 0;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    if (rx <= 0) return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
    const d = `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
    return parsePathD(d, seg);
  }
  return [];
}

const SHAPES = 'path,rect,circle,ellipse,line,polyline,polygon';

function isHidden(el, root) {
  for (let e = el; e && e !== root.parentNode; e = e.parentNode) {
    if (!e.tagName) continue;
    const t = e.tagName.toLowerCase();
    if (['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'lineargradient', 'radialgradient'].includes(t)) return true;
  }
  const st = getComputedStyle(el);
  return st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0;
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

// Hauptfunktion: SVG-Text -> Design-Modell
export function importSVG(text, name = 'SVG') {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('SVG konnte nicht gelesen werden');
  const src = doc.documentElement;
  if (!src || src.tagName.toLowerCase() !== 'svg') throw new Error('Keine SVG-Datei');

  // Natürliche Größe in mm aus width/height-Attributen
  const parseLen = (s) => {
    const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(s || '');
    return m ? parseFloat(m[1]) * UNIT_MM[m[2] || ''] : null;
  };
  const natW = parseLen(src.getAttribute('width'));

  // Ins Live-DOM hängen, damit CTM und CSS ausgewertet werden
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-12000px;top:0;width:1000px;height:1000px;overflow:hidden;opacity:0;pointer-events:none';
  const svg = document.importNode(src, true);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  if (!svg.getAttribute('viewBox')) {
    // ohne viewBox: Koordinaten 1:1 übernehmen
    svg.setAttribute('width', '1000');
    svg.setAttribute('height', '1000');
    svg.style.overflow = 'visible';
  } else {
    svg.setAttribute('width', '1000');
    svg.setAttribute('height', '1000');
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  }
  host.appendChild(svg);
  document.body.appendChild(host);

  const warnings = [];
  const strokes = [];
  const fills = [];
  try {
    // <use> auflösen (einfache Fälle)
    svg.querySelectorAll('use').forEach(u => {
      const href = u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href || !href.startsWith('#')) return;
      const ref = svg.querySelector(href.replace(/([:.[\]])/g, '\\$1'));
      if (!ref) return;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const tx = num(u, 'x'), ty = num(u, 'y');
      const tr = (u.getAttribute('transform') || '') + (tx || ty ? ` translate(${tx},${ty})` : '');
      if (tr.trim()) g.setAttribute('transform', tr);
      for (const a of ['style', 'class', 'fill', 'stroke']) if (u.getAttribute(a)) g.setAttribute(a, u.getAttribute(a));
      const clone = ref.cloneNode(true);
      clone.removeAttribute('id');
      if (clone.tagName.toLowerCase() === 'symbol') {
        while (clone.firstChild) g.appendChild(clone.firstChild);
      } else g.appendChild(clone);
      u.parentNode.replaceChild(g, u);
    });
    if (svg.querySelector('text')) warnings.push('Texte werden nicht gezeichnet. In Inkscape vorher "Objekt in Pfad umwandeln".');
    if (svg.querySelector('image')) warnings.push('Eingebettete Bilder werden ignoriert. Für Fotos bitte als Bild importieren.');

    // Kurvenauflösung abhängig von der Gesamtgröße
    let diag = 1000;
    try { const b = svg.getBBox(); diag = Math.hypot(b.width, b.height) || 1000; } catch (e) { /* egal */ }
    const seg = diag / 600;

    const els = svg.querySelectorAll(SHAPES);
    els.forEach(el => {
      if (isHidden(el, svg)) return;
      const subs = elementSubpaths(el, seg);
      if (!subs.length) return;
      const m = el.getCTM();
      const tf = (p) => m ? [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f] : p;
      const st = getComputedStyle(el);
      const strokeC = parseFloat(st.strokeOpacity) === 0 ? null : parseColor(st.stroke);
      const fillC = parseFloat(st.fillOpacity) === 0 ? null : parseColor(st.fill);
      const tag = el.tagName.toLowerCase();
      const fillable = tag !== 'line' && tag !== 'polyline';
      const rings = subs.map(sp => sp.pts.map(tf));
      if (strokeC) {
        rings.forEach((pts, k) => strokes.push({ pts, color: strokeC, closed: subs[k].closed, kind: 'line' }));
      }
      if (fillC && fillable) {
        fills.push({ rings: rings.filter(r => r.length > 2), color: fillC, rule: st.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' });
        // Fläche ohne Kontur: Umriss in Füllfarbe als Kontur anbieten
        if (!strokeC) rings.forEach((pts, k) => strokes.push({ pts, color: fillC, closed: true, kind: 'outline' }));
      }
    });
  } finally {
    document.body.removeChild(host);
  }

  const design = { name, source: 'svg', strokes, fills, warnings };
  design.bbox = designBBox(design);
  // Natürliche Breite: Viewport war 1000 px breit -> mm pro Einheit
  if (natW) {
    const vb = (src.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      const k = Math.min(1000 / vb[2], 1000 / vb[3]); // Host-px pro viewBox-Einheit
      design.mmPerUnit = (natW / vb[2]) / k;
    } else design.mmPerUnit = 25.4 / 96;
  }
  if (!strokes.length && !fills.length) throw new Error('Keine zeichenbaren Formen in der SVG gefunden');
  return design;
}
