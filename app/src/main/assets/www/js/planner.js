// Planer: Design + Platzierung + Stifte -> Zeichenreihenfolge und atomare Schritte.

import { makeTransform, simplify, subdivide, hatchRings, polyLength } from './geometry.js';
import { toHex, nearestPen, parseColor, deltaE } from './colors.js';
import { positionFrom, safeArea } from './kinematics.js';

export const PLAN_DEFAULTS = {
  drawLines: true,
  drawOutlines: true,
  drawFills: true,
  hatchSpacing: 3,      // mm
  hatchAngle: 0,        // zusätzlicher Winkel in Grad
  simplifyTol: 0.25,    // mm
  maxSeg: 8,            // mm, längere Strecken werden unterteilt
  minLen: 1.5,          // mm, kürzere Striche weglassen
  joinDist: 0.6,        // mm, Lücken darunter ohne Absetzen
  hatchJoin: 2.2,       // x Schraffurabstand: Zickzack ohne Absetzen
  optimize: true,
  homePen: true,        // Stiftmechanik vor Start kalibrieren
  returnHome: true,
  swapSlot: 3,          // Stiftplatz für Tausch-Farben (0-basiert)
};

// Farben im Design sammeln (ähnliche zusammenfassen)
export function collectColors(design) {
  const list = [];
  const add = (rgb, len, kind) => {
    let hit = list.find(c => deltaE(c.rgb, rgb) < 6);
    if (!hit) { hit = { hex: toHex(rgb), rgb, len: 0, kinds: new Set() }; list.push(hit); }
    hit.len += len; hit.kinds.add(kind);
  };
  for (const s of design.strokes) add(s.color, polyLength(s.pts), s.kind);
  for (const f of design.fills) add(f.color, f.rings.reduce((a, r) => a + polyLength(r), 0), 'fill');
  list.sort((a, b) => b.len - a.len);
  return list;
}

export function colorKey(design, rgb, colors) {
  const c = colors.find(c => deltaE(c.rgb, rgb) < 6);
  return c ? c.hex : toHex(rgb);
}

// Standard-Zuordnung: nächster Stift
export function autoColorMap(colors, pens) {
  const map = {};
  for (const c of colors) {
    // Fast-Weiß ignorieren (Wand ist hell)
    const l = (0.299 * c.rgb[0] + 0.587 * c.rgb[1] + 0.114 * c.rgb[2]) / 255;
    map[c.hex] = l > 0.93 ? -1 : nearestPen(c.rgb, pens);
  }
  return map;
}

// --- Reihenfolge-Optimierung (gieriger nächster Nachbar mit Raster) ---
function orderStrokes(strokes, start) {
  const n = strokes.length;
  if (n <= 1) return strokes.map(s => orient(s, 0, false));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const entries = []; // [x, y, strokeIdx, vertexIdx, rev]
  strokes.forEach((s, i) => {
    const p = s.pts;
    if (s.closed && p.length > 2) {
      const step = Math.max(1, Math.floor(p.length / 24));
      for (let k = 0; k < p.length; k += step) entries.push([p[k][0], p[k][1], i, k, 0]);
    } else {
      entries.push([p[0][0], p[0][1], i, 0, 0]);
      const e = p[p.length - 1];
      entries.push([e[0], e[1], i, p.length - 1, 1]);
    }
  });
  for (const e of entries) { if (e[0] < x0) x0 = e[0]; if (e[1] < y0) y0 = e[1]; if (e[0] > x1) x1 = e[0]; if (e[1] > y1) y1 = e[1]; }
  const cell = Math.max(5, Math.hypot(x1 - x0, y1 - y0) / Math.sqrt(entries.length) * 1.5);
  const gw = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), gh = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const grid = new Array(gw * gh);
  entries.forEach((e, k) => {
    const gx = Math.min(gw - 1, Math.floor((e[0] - x0) / cell)), gy = Math.min(gh - 1, Math.floor((e[1] - y0) / cell));
    const id = gy * gw + gx;
    (grid[id] || (grid[id] = [])).push(k);
  });
  const used = new Uint8Array(n);
  const out = [];
  let cx = start[0], cy = start[1];
  for (let done = 0; done < n; done++) {
    const gx = Math.max(0, Math.min(gw - 1, Math.floor((cx - x0) / cell)));
    const gy = Math.max(0, Math.min(gh - 1, Math.floor((cy - y0) / cell)));
    let best = -1, bd = Infinity;
    const maxR = Math.max(gw, gh);
    for (let r = 0; r <= maxR; r++) {
      if (best >= 0 && (r - 1) * cell > Math.sqrt(bd)) break;
      for (let yy = gy - r; yy <= gy + r; yy++) {
        if (yy < 0 || yy >= gh) continue;
        for (let xx = gx - r; xx <= gx + r; xx++) {
          if (xx < 0 || xx >= gw) continue;
          if (r > 0 && yy !== gy - r && yy !== gy + r && xx !== gx - r && xx !== gx + r) continue;
          const lst = grid[yy * gw + xx];
          if (!lst) continue;
          let w = 0;
          for (let q = 0; q < lst.length; q++) {
            const k = lst[q];
            const e = entries[k];
            if (used[e[2]]) continue;
            lst[w++] = k;
            const d = (e[0] - cx) ** 2 + (e[1] - cy) ** 2;
            if (d < bd) { bd = d; best = k; }
          }
          lst.length = w;
        }
      }
    }
    if (best < 0) break;
    const e = entries[best];
    used[e[2]] = 1;
    const o = orient(strokes[e[2]], e[3], !!e[4]);
    out.push(o);
    const last = o.pts[o.pts.length - 1];
    cx = last[0]; cy = last[1];
  }
  return out;
}

function orient(s, k, rev) {
  let pts;
  if (s.closed && s.pts.length > 2) {
    pts = s.pts.slice(k).concat(s.pts.slice(0, k));
    pts.push(pts[0]);
  } else {
    pts = rev ? s.pts.slice().reverse() : s.pts.slice();
  }
  return { pts, hatch: s.hatch, spacing: s.spacing };
}

function joinStrokes(list, opt) {
  const out = [];
  for (const s of list) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = prev.pts[prev.pts.length - 1], b = s.pts[0];
      const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const lim = prev.hatch && s.hatch ? Math.max(opt.joinDist, opt.hatchJoin * (s.spacing || opt.hatchSpacing)) : opt.joinDist;
      if (gap <= lim) {
        prev.pts = prev.pts.concat(gap < 1e-6 ? s.pts.slice(1) : s.pts);
        prev.hatch = prev.hatch && s.hatch;
        continue;
      }
    }
    out.push({ pts: s.pts.slice(), hatch: s.hatch, spacing: s.spacing });
  }
  return out;
}

// Hauptfunktion
export function buildPlan(design, placement, pens, colorMap, opt, geom, robot, extraColors) {
  const o = Object.assign({}, PLAN_DEFAULTS, opt);
  const T = makeTransform(design, placement);
  const colors = collectColors(design);
  const keyOf = (rgb) => colorKey(design, rgb, colors);
  const targetOf = (rgb) => {
    const k = keyOf(rgb);
    const t = colorMap[k];
    return t === undefined ? nearestPen(rgb, pens) : t;
  };

  // Gruppen pro Ziel (0..3 = Stiftplatz, >=10 = Tausch-Farbe)
  const groups = new Map();
  const group = (t) => { if (!groups.has(t)) groups.set(t, []); return groups.get(t); };

  for (const s of design.strokes) {
    if (s.kind === 'outline' && !o.drawOutlines) continue;
    if (s.kind === 'line' && !o.drawLines) continue;
    const t = targetOf(s.color);
    if (t < 0) continue;
    let pts = s.pts.map(T);
    if (s.closed && pts.length > 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
    }
    pts = simplify(s.closed ? pts.concat([pts[0]]) : pts, o.simplifyTol);
    if (s.closed && pts.length > 2) pts.pop();
    if (polyLength(s.closed ? pts.concat([pts[0]]) : pts) < o.minLen) continue;
    group(t).push({ pts, closed: !!s.closed && pts.length > 2, hatch: false });
  }
  if (o.drawFills) {
    for (const f of design.fills) {
      const t = targetOf(f.color);
      if (t < 0) continue;
      const rings = f.rings.map(r => r.map(T));
      const ang = (f.angle ?? 45) + (o.hatchAngle || 0) + (placement.rotation || 0);
      const sp = o.hatchSpacing;
      const segs = hatchRings(rings, ang, sp, f.rule);
      for (const sg of segs) {
        if (Math.hypot(sg[1][0] - sg[0][0], sg[1][1] - sg[0][1]) < Math.min(o.minLen, sp * 0.5)) continue;
        group(t).push({ pts: sg, closed: false, hatch: true, spacing: sp });
      }
    }
  }

  // Stiftreihenfolge
  const start = positionFrom(geom, robot.L, robot.R);
  let curSlot = o.homePen ? 0 : (robot.penSlot ?? 0);
  const realTargets = [...groups.keys()].filter(t => t >= 0 && t < 4);
  realTargets.sort((a, b) => ((a - curSlot + 5) % 5) - ((b - curSlot + 5) % 5));
  const swapTargets = [...groups.keys()].filter(t => t >= 10).sort((a, b) => a - b);

  const passes = [];
  let cur = [start.x, start.y];
  for (const t of [...realTargets, ...swapTargets]) {
    let list = groups.get(t);
    list = o.optimize ? orderStrokes(list, cur) : list.map(s => orient(s, 0, false));
    list = joinStrokes(list, o);
    const isSwap = t >= 10;
    const slot = isSwap ? o.swapSlot : t;
    const ex = isSwap ? (extraColors || [])[t - 10] : null;
    passes.push({
      target: t, slot, swap: isSwap,
      color: isSwap ? (ex ? ex.color : '#888') : pens[t].color,
      name: isSwap ? (ex ? ex.name : 'Extra') : pens[t].name,
      strokes: list,
    });
    if (list.length) { const l = list[list.length - 1].pts; cur = l[l.length - 1]; }
  }

  // Atomare Schritte
  const steps = [];
  let slot = robot.penSlot ?? 0;
  if (o.homePen) { steps.push({ k: 'init' }); slot = 0; }
  let drawn = 0, travel = 0, lifts = 0, changes = 0;
  let px = start.x, py = start.y;
  const area = safeArea(geom, o.limits);
  let outside = 0;
  const check = (x, y) => { if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) outside++; };
  passes.forEach((ps, pi) => {
    if (!ps.strokes.length) return;
    if (ps.slot !== slot) { steps.push({ k: 'pen', from: slot, to: ps.slot }); slot = ps.slot; changes++; }
    if (ps.swap) steps.push({ k: 'swap', slot: ps.slot, color: ps.color, name: ps.name, pass: pi });
    ps.strokes.forEach((s, si) => {
      const pts = subdivide(s.pts, o.maxSeg);
      const a = pts[0];
      travel += Math.hypot(a[0] - px, a[1] - py);
      steps.push({ k: 'move', x: a[0], y: a[1], draw: false, pass: pi, stroke: si });
      check(a[0], a[1]);
      steps.push({ k: 'down', pass: pi, stroke: si });
      lifts++;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        drawn += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
        steps.push({ k: 'move', x: p[0], y: p[1], draw: true, pass: pi, stroke: si, at: drawn });
        check(p[0], p[1]);
      }
      steps.push({ k: 'up', pass: pi, stroke: si });
      const e = pts[pts.length - 1]; px = e[0]; py = e[1];
    });
  });
  if (o.returnHome) {
    travel += Math.hypot(start.x - px, start.y - py);
    steps.push({ k: 'move', x: start.x, y: start.y, draw: false, home: true });
  }

  return {
    passes, steps, start, robot: { ...robot }, geom: { ...geom }, finalSlot: slot,
    stats: { drawn, travel, lifts, changes, outside, strokes: passes.reduce((a, p) => a + p.strokes.length, 0) },
  };
}

export { parseColor };
