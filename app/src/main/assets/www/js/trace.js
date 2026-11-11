// Bild -> Vektor: Konturen (Marching Squares), Tonstufen-Schraffur, Farbflächen.

import { simplify, polyLength, ringArea, designBBox } from './geometry.js';
import { rgbToLab, parseColor } from './colors.js';

export async function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
    img.src = src;
  });
}

function getPixels(img, maxSize) {
  const k = Math.min(1, maxSize / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(2, Math.round((img.naturalWidth || img.width) * k));
  const h = Math.max(2, Math.round((img.naturalHeight || img.height) * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h); // Transparenz = weiß
  ctx.drawImage(img, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

function boxBlur(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Marching Squares. "Innen" = Wert < iso. Gitter wird mit outside gepolstert -> geschlossene Konturen.
export function marchingSquares(vals, w, h, iso, outside = 1) {
  const W = w + 2, H = h + 2;
  const v = new Float32Array(W * H).fill(outside);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[(y + 1) * W + x + 1] = vals[y * w + x];
  const segA = [], segB = [];
  const pos = new Map();
  const edgePoint = (id) => {
    if (pos.has(id)) return id;
    const cell = id >> 1, vert = id & 1;
    const x = cell % W, y = (cell / W) | 0;
    let ax = x, ay = y, bx = vert ? x : x + 1, by = vert ? y + 1 : y;
    const va = v[ay * W + ax], vb = v[by * W + bx];
    const t = va === vb ? 0.5 : Math.max(0, Math.min(1, (iso - va) / (vb - va)));
    pos.set(id, [ax + (bx - ax) * t - 1, ay + (by - ay) * t - 1]);
    return id;
  };
  const Hd = (x, y) => (y * W + x) * 2;
  const Vd = (x, y) => (y * W + x) * 2 + 1;
  const add = (a, b) => { segA.push(edgePoint(a)); segB.push(edgePoint(b)); };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = v[y * W + x], tr = v[y * W + x + 1], br = v[(y + 1) * W + x + 1], bl = v[(y + 1) * W + x];
      const c = (tl < iso ? 8 : 0) | (tr < iso ? 4 : 0) | (br < iso ? 2 : 0) | (bl < iso ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = Hd(x, y), R = Vd(x + 1, y), B = Hd(x, y + 1), L = Vd(x, y);
      switch (c) {
        case 1: case 14: add(L, B); break;
        case 2: case 13: add(B, R); break;
        case 3: case 12: add(L, R); break;
        case 4: case 11: add(T, R); break;
        case 6: case 9: add(T, B); break;
        case 7: case 8: add(L, T); break;
        case 5: {
          const ctr = (tl + tr + br + bl) / 4 < iso;
          if (ctr) { add(L, T); add(B, R); } else { add(L, B); add(T, R); }
          break;
        }
        case 10: {
          const ctr = (tl + tr + br + bl) / 4 < iso;
          if (ctr) { add(T, R); add(L, B); } else { add(L, T); add(B, R); }
          break;
        }
      }
    }
  }
  // Segmente zu Linienzügen verketten
  const n = segA.length;
  const at = new Map();
  for (let i = 0; i < n; i++) {
    for (const e of [segA[i], segB[i]]) {
      const l = at.get(e);
      if (l) l.push(i); else at.set(e, [i]);
    }
  }
  const used = new Uint8Array(n);
  const lines = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const chain = [segA[s], segB[s]];
    // vorwärts
    for (let dir = 0; dir < 2; dir++) {
      let guard = 0;
      while (guard++ < 1e7) {
        const end = dir === 0 ? chain[chain.length - 1] : chain[0];
        const cand = at.get(end) || [];
        let next = -1;
        for (const k of cand) if (!used[k]) { next = k; break; }
        if (next < 0) break;
        used[next] = 1;
        const other = segA[next] === end ? segB[next] : segA[next];
        if (dir === 0) chain.push(other); else chain.unshift(other);
      }
    }
    const closed = chain.length > 3 && chain[0] === chain[chain.length - 1];
    const pts = chain.map(id => pos.get(id));
    if (closed) pts.pop();
    lines.push({ pts, closed });
  }
  return lines;
}

function contoursToRings(lines, simplifyTol, minArea) {
  const rings = [];
  for (const l of lines) {
    if (!l.closed || l.pts.length < 3) continue;
    const s = simplify(l.pts.concat([l.pts[0]]), simplifyTol);
    s.pop();
    if (s.length < 3) continue;
    if (Math.abs(ringArea(s)) < minArea) continue;
    rings.push(s);
  }
  return rings;
}

function kmeans(samples, k, iters = 12) {
  // samples: Array von Lab-Werten
  const cents = [];
  // k-means++ Initialisierung (deterministisch über Schritte)
  cents.push(samples[Math.floor(samples.length / 2)].slice());
  while (cents.length < k) {
    let best = null, bd = -1;
    for (let i = 0; i < samples.length; i += Math.max(1, (samples.length / 2000) | 0)) {
      let d = Infinity;
      for (const c of cents) d = Math.min(d, (samples[i][0] - c[0]) ** 2 + (samples[i][1] - c[1]) ** 2 + (samples[i][2] - c[2]) ** 2);
      if (d > bd) { bd = d; best = samples[i]; }
    }
    cents.push(best.slice());
  }
  for (let it = 0; it < iters; it++) {
    const sum = cents.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const c = cents[j];
        const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (d < bd) { bd = d; bi = j; }
      }
      const a = sum[bi]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++;
    }
    sum.forEach((a, j) => { if (a[3]) cents[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return cents;
}

export const TRACE_DEFAULTS = {
  mode: 'outline',     // outline | hatch | color
  detail: 500,         // Arbeitsauflösung in px (lange Seite)
  blur: 1,
  threshold: 0.5,      // Helligkeit 0..1 für Konturen
  levels: 1,           // Anzahl Konturstufen
  tones: 3,            // Tonstufen für Schraffur
  colors: 3,           // Farben für Farbmodus
  usePenColors: true,
  invert: false,
  background: 0.88,    // heller als das = Hintergrund
  outline: true,       // Umrisse zusätzlich zur Schraffur
  smooth: 0.8,         // Vereinfachung in px
  minArea: 12,         // Mindestfläche in px²
};

const HATCH_ANGLES = [45, -45, 0, 90, 22.5, -67.5];

export function traceImage(img, opt, pens) {
  const o = Object.assign({}, TRACE_DEFAULTS, opt);
  const { w, h, data } = getPixels(img, o.detail);
  const N = w * h;
  let lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let l = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    lum[i] = o.invert ? 1 - l : l;
  }
  lum = boxBlur(lum, w, h, Math.round(o.blur));
  const strokes = [], fills = [];
  const black = [27, 27, 31];

  if (o.mode === 'outline') {
    const lv = Math.max(1, Math.min(6, o.levels | 0));
    for (let k = 0; k < lv; k++) {
      const iso = lv === 1 ? o.threshold : o.threshold * (1 - k / lv) + 0.04;
      const lines = marchingSquares(lum, w, h, iso, 1);
      for (const l of lines) {
        if (l.pts.length < 2) continue;
        const pts = l.closed ? l.pts.concat([l.pts[0]]) : l.pts;
        const s = simplify(pts, o.smooth);
        if (polyLength(s) < Math.sqrt(o.minArea) * 2) continue;
        strokes.push({ pts: s, color: black, closed: l.closed, kind: 'line' });
      }
    }
  } else if (o.mode === 'hatch') {
    const T = Math.max(1, Math.min(6, o.tones | 0));
    for (let k = 0; k < T; k++) {
      const iso = o.background * (1 - k / T);
      const rings = contoursToRings(marchingSquares(lum, w, h, iso, 1), o.smooth, o.minArea);
      if (rings.length) fills.push({ rings, color: black, rule: 'evenodd', angle: HATCH_ANGLES[k % HATCH_ANGLES.length], tone: k });
    }
    if (o.outline) {
      const lines = marchingSquares(lum, w, h, o.threshold, 1);
      for (const l of lines) {
        const pts = l.closed ? l.pts.concat([l.pts[0]]) : l.pts;
        const s = simplify(pts, o.smooth);
        if (polyLength(s) < Math.sqrt(o.minArea) * 3) continue;
        strokes.push({ pts: s, color: black, closed: l.closed, kind: 'outline' });
      }
    }
  } else {
    // Farbmodus
    const labs = new Array(N);
    const fg = [];
    for (let i = 0; i < N; i++) {
      const rgb = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
      labs[i] = rgbToLab(rgb);
      if (lumRaw(rgb) < o.background) fg.push(i);
    }
    let palette; // Array von {rgb, lab}
    if (o.usePenColors && pens && pens.length) {
      palette = pens.map(p => { const rgb = parseColor(p.color) || [0, 0, 0]; return { rgb, lab: rgbToLab(rgb) }; });
    } else {
      const K = Math.max(1, Math.min(6, o.colors | 0));
      const step = Math.max(1, Math.floor(fg.length / 6000));
      const samples = [];
      for (let j = 0; j < fg.length; j += step) samples.push(labs[fg[j]]);
      const cents = samples.length >= K ? kmeans(samples, K) : [[20, 0, 0]];
      palette = cents.map(lab => ({ lab, rgb: labToRgb(lab) }));
    }
    const assign = new Int16Array(N).fill(-1);
    for (const i of fg) {
      let bi = 0, bd = Infinity;
      const L = labs[i];
      palette.forEach((p, j) => {
        const d = (L[0] - p.lab[0]) ** 2 + (L[1] - p.lab[1]) ** 2 + (L[2] - p.lab[2]) ** 2;
        if (d < bd) { bd = d; bi = j; }
      });
      assign[i] = bi;
    }
    palette.forEach((p, j) => {
      let mask = new Float32Array(N);
      let count = 0;
      for (let i = 0; i < N; i++) { const inside = assign[i] === j; mask[i] = inside ? 0 : 1; if (inside) count++; }
      if (count < o.minArea) return;
      mask = boxBlur(mask, w, h, 1);
      const rings = contoursToRings(marchingSquares(mask, w, h, 0.5, 1), o.smooth, o.minArea);
      if (!rings.length) return;
      fills.push({ rings, color: p.rgb, rule: 'evenodd', angle: HATCH_ANGLES[j % HATCH_ANGLES.length], tone: 0 });
      if (o.outline) rings.forEach(r => strokes.push({ pts: r.concat([r[0]]), color: p.rgb, closed: true, kind: 'outline' }));
    });
  }

  const design = { name: 'Bild', source: 'image', strokes, fills, warnings: [], pixelSize: { w, h } };
  design.bbox = { x0: 0, y0: 0, x1: w, y1: h };
  if (!strokes.length && !fills.length) design.warnings.push('Nichts gefunden. Schwelle oder Hintergrund-Regler anpassen.');
  else {
    const bb = designBBox(design);
    if (isFinite(bb.x0)) design.contentBBox = bb;
  }
  return design;
}

function lumRaw([r, g, b]) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

function labToRgb([L, a, b]) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  x = 0.95047 * f(x); y = f(y); z = 1.08883 * f(z);
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let bb = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const gam = v => Math.max(0, Math.min(255, Math.round(255 * (v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v))));
  return [gam(r), gam(g), gam(bb)];
}
