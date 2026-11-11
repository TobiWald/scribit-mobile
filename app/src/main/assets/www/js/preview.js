// Wand-Vorschau: Canvas mit Aufhängung, Fäden, Roboter, Motiv, Simulation und Gesten.

import { positionFrom, safeArea } from './kinematics.js';
import { placedCorners, pointInPolygon } from './geometry.js';

export function buildSim(plan) {
  const steps = plan.steps;
  const n = steps.length;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  const draw = new Uint8Array(n), pass = new Int16Array(n), valid = new Uint8Array(n);
  let x = plan.start.x, y = plan.start.y, down = 0, ps = 0;
  for (let i = 0; i < n; i++) {
    const s = steps[i];
    if (s.k === 'down') down = 1;
    else if (s.k === 'up') down = 0;
    if (s.pass !== undefined) ps = s.pass;
    if (s.k === 'move') { x = s.x; y = s.y; valid[i] = 1; draw[i] = s.draw && down ? 1 : 0; }
    xs[i] = x; ys[i] = y; pass[i] = ps;
  }
  return { xs, ys, draw, pass, valid, n };
}

export class WallView {
  constructor(canvas, cb = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = cb;
    this.view = { s: 0.2, ox: 0, oy: 0 };
    this.scene = null;
    this.ptrs = new Map();
    this.gesture = null;
    this.live = null;          // Platzierung während der Geste
    this.paths = null;
    this.interactive = cb.interactive !== false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    if (this.interactive) this.bindGestures();
    this.fitted = false;   // true = Nutzer hat Ansicht selbst verschoben/gezoomt
    this.dpr = 0;
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (r.width < 2) return;
    this.c.width = Math.round(r.width * dpr);
    this.c.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    if (!this.fitted) this.fit(true);
    this.draw();
  }

  setScene(scene) {
    const planChanged = !this.scene || this.scene.plan !== scene.plan;
    this.scene = scene;
    if (planChanged) { this.paths = null; this.sim = scene.plan ? buildSim(scene.plan) : null; this.live = null; }
    if (!this.fitted) this.fit(true);
    this.draw();
  }

  // auto=true: automatische Anpassung, Nutzer-Zoom bleibt erhalten bis "Ganze Wand"
  fit(auto) {
    const sc = this.scene;
    if (!sc || !this.dpr) return;
    if (!auto) this.fitted = false;
    const A = sc.geom.anchorDistance;
    const pos = positionFrom(sc.geom, sc.robot.L, sc.robot.R);
    const area = safeArea(sc.geom, sc.limits);
    let x0 = -60, x1 = A + 60, y0 = -90, y1 = Math.max(pos.y + 200, area.y1 * 0.75);
    if (this.cb.fitPlan && sc.plan && sc.plan.passes.length) {
      x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
      const inc = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
      inc(pos.x, pos.y);
      for (const ps of sc.plan.passes) for (const s of ps.strokes) for (const q of s.pts) inc(q[0], q[1]);
      const m = Math.max(80, (x1 - x0) * 0.08);
      x0 -= m; x1 += m; y0 -= m; y1 += m;
    }
    if (!auto && sc.placement && sc.design) {
      for (const p of placedCorners(sc.design, sc.placement)) { y1 = Math.max(y1, p[1] + 80); x0 = Math.min(x0, p[0] - 40); x1 = Math.max(x1, p[0] + 40); }
    }
    const W = this.c.width, H = this.c.height;
    const s = Math.min(W / (x1 - x0), H / (y1 - y0));
    this.view = { s, ox: (W - (x1 - x0) * s) / 2 - x0 * s, oy: (H - (y1 - y0) * s) / 2 - y0 * s };
  }

  toWall(px, py) { const v = this.view; return [(px * this.dpr - v.ox) / v.s, (py * this.dpr - v.oy) / v.s]; }

  ensurePaths() {
    if (this.paths || !this.scene.plan) return;
    this.paths = this.scene.plan.passes.map(ps => {
      const p = new Path2D();
      for (const s of ps.strokes) {
        p.moveTo(s.pts[0][0], s.pts[0][1]);
        for (let i = 1; i < s.pts.length; i++) p.lineTo(s.pts[i][0], s.pts[i][1]);
      }
      return { path: p, color: ps.color };
    });
  }

  draw() {
    const sc = this.scene;
    const ctx = this.ctx;
    if (!sc || !this.dpr) return;
    const W = this.c.width, H = this.c.height, v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getCss('--wall');
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
    const px = 1 / v.s; // 1 Bildschirmpixel in mm
    const g = sc.geom, A = g.anchorDistance;

    // Raster 100 mm
    const [gx0, gy0] = [(-v.ox) / v.s, (-v.oy) / v.s];
    const [gx1, gy1] = [(W - v.ox) / v.s, (H - v.oy) / v.s];
    ctx.lineWidth = px;
    ctx.strokeStyle = getCss('--grid');
    ctx.beginPath();
    for (let x = Math.floor(gx0 / 100) * 100; x <= gx1; x += 100) { ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); }
    for (let y = Math.floor(gy0 / 100) * 100; y <= gy1; y += 100) { ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); }
    ctx.stroke();

    // Sicherer Bereich
    const area = safeArea(g, sc.limits);
    ctx.setLineDash([8 * px, 6 * px]);
    ctx.strokeStyle = getCss('--safe');
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    ctx.setLineDash([]);

    // Ankerlinie
    ctx.strokeStyle = getCss('--ink-soft');
    ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(A, 0); ctx.stroke();

    // Motiv
    const pw = Math.max(sc.penWidth || 1.5, 1.2 * px);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let robotPos = positionFrom(g, sc.robot.L, sc.robot.R);
    const prog = sc.progressStep; // Index bis zu dem gezeichnet ist (Simulation/Job)
    if (sc.plan) {
      this.ensurePaths();
      ctx.save();
      if (this.live && sc.planPlacement) applyDelta(ctx, sc.planPlacement, this.live);
      const faded = prog !== undefined && prog !== null;
      ctx.globalAlpha = faded ? 0.18 : 1;
      ctx.lineWidth = pw;
      for (const p of this.paths) { ctx.strokeStyle = p.color; ctx.stroke(p.path); }
      ctx.globalAlpha = 1;
      if (sc.showTravel && !faded) {
        ctx.strokeStyle = getCss('--travel');
        ctx.lineWidth = px;
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.beginPath();
        const st = sc.plan.steps;
        let lx = sc.plan.start.x, ly = sc.plan.start.y;
        for (const s of st) if (s.k === 'move') { if (!s.draw) { ctx.moveTo(lx, ly); ctx.lineTo(s.x, s.y); } lx = s.x; ly = s.y; }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (faded && this.sim) {
        const sim = this.sim;
        const k = Math.max(0, Math.min(sim.n - 1, Math.floor(prog)));
        let curPass = -1, open = false;
        ctx.lineWidth = pw;
        ctx.beginPath();
        let lx = sc.plan.start.x, ly = sc.plan.start.y;
        for (let i = 0; i <= k; i++) {
          if (!sim.valid[i]) continue;
          if (sim.draw[i]) {
            if (sim.pass[i] !== curPass) {
              if (open) ctx.stroke();
              curPass = sim.pass[i];
              ctx.strokeStyle = sc.plan.passes[curPass].color;
              ctx.beginPath(); open = true;
              ctx.moveTo(lx, ly);
            }
            ctx.lineTo(sim.xs[i], sim.ys[i]);
          } else if (open) { ctx.moveTo(sim.xs[i], sim.ys[i]); }
          lx = sim.xs[i]; ly = sim.ys[i];
        }
        if (open) ctx.stroke();
        robotPos = { x: sim.xs[k], y: sim.ys[k] };
      }
      ctx.restore();
    }

    // Rahmen des Motivs
    if (sc.design && sc.placement) {
      const pl = this.live || sc.placement;
      const cs = placedCorners(sc.design, pl);
      ctx.strokeStyle = sc.outside ? getCss('--danger') : getCss('--accent');
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.beginPath(); cs.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Fäden + Roboter
    const w = g.gondolaWidth / 2;
    ctx.strokeStyle = getCss('--string');
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(robotPos.x - w, robotPos.y - w);
    ctx.moveTo(A, 0); ctx.lineTo(robotPos.x + w, robotPos.y - w);
    ctx.stroke();
    ctx.fillStyle = 'rgba(31,42,68,0.10)';
    ctx.strokeStyle = getCss('--ink');
    ctx.lineWidth = 2 * px;
    roundRect(ctx, robotPos.x - w, robotPos.y - w, 2 * w, 2 * w, 14);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(robotPos.x, robotPos.y, Math.max(4, 3 * px), 0, Math.PI * 2);
    ctx.fillStyle = getCss('--ink'); ctx.fill();

    // Anker
    for (const ax of [0, A]) {
      ctx.beginPath(); ctx.arc(ax, 0, Math.max(10, 7 * px), 0, Math.PI * 2);
      ctx.fillStyle = getCss('--ink'); ctx.fill();
    }
    // Maßstab
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = this.dpr || 1;
    ctx.font = `${12 * d}px system-ui, sans-serif`;
    ctx.fillStyle = getCss('--ink-soft');
    ctx.fillText('Raster 10 cm', 10 * d, H - 10 * d);
  }

  bindGestures() {
    const c = this.c;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      this.startGesture();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      this.moveGesture();
    });
    const up = (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.delete(e.pointerId);
      this.endGesture(this.ptrs.size === 0);
      if (this.ptrs.size) this.startGesture();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * 0.0015);
      this.zoomAt(e.offsetX, e.offsetY, k);
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.fit(); this.draw(); });
  }

  zoomAt(x, y, k) {
    const v = this.view, d = this.dpr;
    v.ox = x * d - (x * d - v.ox) * k;
    v.oy = y * d - (y * d - v.oy) * k;
    v.s *= k;
    this.fitted = true;
    this.draw();
  }

  hitDesign(px, py) {
    const sc = this.scene;
    if (!sc || !sc.design || !sc.placement || !this.cb.onPlacement) return false;
    const [x, y] = this.toWall(px, py);
    const cs = placedCorners(sc.design, sc.placement);
    if (pointInPolygon(x, y, cs)) return true;
    // etwas Toleranz für kleine Motive
    const cx = cs.reduce((a, p) => a + p[0], 0) / 4, cy = cs.reduce((a, p) => a + p[1], 0) / 4;
    return Math.hypot(x - cx, y - cy) < 40 / this.view.s * this.dpr;
  }

  startGesture() {
    const pts = [...this.ptrs.values()];
    const sc = this.scene;
    const prev = this.gesture;
    if (pts.length === 1) {
      const onDesign = this.cb.lockDesign ? false : this.hitDesign(pts[0][0], pts[0][1]);
      this.gesture = { mode: onDesign ? 'move' : 'pan', p0: pts[0], view0: { ...this.view }, pl0: sc && sc.placement ? { ...sc.placement } : null };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const onDesign = prev && (prev.mode === 'move' || prev.mode === 'transform');
      this.gesture = {
        mode: onDesign ? 'transform' : 'zoom',
        a0: a, b0: b, view0: { ...this.view },
        pl0: this.live ? { ...this.live } : (sc && sc.placement ? { ...sc.placement } : null),
      };
    }
    this.moved = false;
  }

  moveGesture() {
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.ptrs.values()];
    const d = this.dpr;
    if (g.mode === 'pan' && pts.length === 1) {
      this.fitted = true;
      this.view.ox = g.view0.ox + (pts[0][0] - g.p0[0]) * d;
      this.view.oy = g.view0.oy + (pts[0][1] - g.p0[1]) * d;
      this.draw();
    } else if (g.mode === 'move' && pts.length === 1) {
      const dx = (pts[0][0] - g.p0[0]) * d / this.view.s, dy = (pts[0][1] - g.p0[1]) * d / this.view.s;
      if (Math.hypot(dx, dy) * this.view.s > 2) this.moved = true;
      this.live = { ...g.pl0, cx: g.pl0.cx + dx, cy: g.pl0.cy + dy };
      this.cb.onPlacementLive && this.cb.onPlacementLive(this.live);
      this.draw();
    } else if (pts.length >= 2 && (g.mode === 'zoom' || g.mode === 'transform')) {
      const [a, b] = pts;
      const d0 = Math.hypot(g.b0[0] - g.a0[0], g.b0[1] - g.a0[1]) || 1;
      const d1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const k = d1 / d0;
      const m0 = [(g.a0[0] + g.b0[0]) / 2, (g.a0[1] + g.b0[1]) / 2];
      const m1 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (g.mode === 'zoom') {
        const v0 = g.view0;
        const s = v0.s * k;
        // Punkt unter m0 bleibt unter m1
        const wx = (m0[0] * d - v0.ox) / v0.s, wy = (m0[1] * d - v0.oy) / v0.s;
        this.view = { s, ox: m1[0] * d - wx * s, oy: m1[1] * d - wy * s };
        this.fitted = true;
        this.draw();
      } else if (g.pl0) {
        const ang0 = Math.atan2(g.b0[1] - g.a0[1], g.b0[0] - g.a0[0]);
        const ang1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        let rot = g.pl0.rotation + (this.cb.allowRotate ? (ang1 - ang0) * 180 / Math.PI : 0);
        const snap = Math.round(rot / 90) * 90;
        if (Math.abs(rot - snap) < 4) rot = snap;
        const dx = (m1[0] - m0[0]) * d / this.view.s, dy = (m1[1] - m0[1]) * d / this.view.s;
        this.live = { ...g.pl0, width: Math.max(10, g.pl0.width * k), rotation: rot, cx: g.pl0.cx + dx, cy: g.pl0.cy + dy };
        this.moved = true;
        this.cb.onPlacementLive && this.cb.onPlacementLive(this.live);
        this.draw();
      }
    }
  }

  endGesture(all) {
    if (all && this.live && this.cb.onPlacement) {
      const pl = this.live;
      this.cb.onPlacement(pl);
    } else if (all && this.gesture && this.gesture.mode === 'pan' && !this.moved && this.cb.onTap) {
      this.cb.onTap();
    }
    if (all) this.gesture = null;
  }
}

function applyDelta(ctx, p0, p1) {
  const k = p1.width / p0.width;
  const dr = ((p1.rotation || 0) - (p0.rotation || 0)) * Math.PI / 180;
  ctx.translate(p1.cx, p1.cy);
  ctx.rotate(dr);
  ctx.scale(k, k);
  ctx.translate(-p0.cx, -p0.cy);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const cssCache = {};
export function getCss(name) {
  if (!cssCache[name]) cssCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  return cssCache[name];
}
export function resetCssCache() { for (const k in cssCache) delete cssCache[k]; }

// Kleine Vorschau eines Designs (ohne Wand)
export function drawDesignThumb(canvas, design, opts = {}) {
  const ctx = canvas.getContext('2d');
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(10, Math.round(r.width * dpr));
  canvas.height = Math.max(10, Math.round(r.height * dpr));
  ctx.fillStyle = getCss('--wall');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!design) return;
  const bb = design.bbox;
  const bw = bb.x1 - bb.x0 || 1, bh = bb.y1 - bb.y0 || 1;
  const pad = 12 * dpr;
  const s = Math.min((canvas.width - 2 * pad) / bw, (canvas.height - 2 * pad) / bh);
  const ox = (canvas.width - bw * s) / 2 - bb.x0 * s, oy = (canvas.height - bh * s) / 2 - bb.y0 * s;
  ctx.setTransform(s, 0, 0, s, ox, oy);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const color = (rgb) => opts.colorFor ? opts.colorFor(rgb) : `rgb(${rgb.join(',')})`;
  if (opts.fills !== false) {
    for (const f of design.fills) {
      const c = color(f.color);
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.globalAlpha = f.tone !== undefined ? 0.28 : 0.35;
      const p = new Path2D();
      for (const ring of f.rings) { ring.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); p.closePath(); }
      ctx.fill(p, f.rule === 'evenodd' ? 'evenodd' : 'nonzero');
    }
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = 1.4 * dpr / s;
  for (const st of design.strokes) {
    const c = color(st.color);
    if (!c) continue;
    if (st.kind === 'outline' && opts.outlines === false) continue;
    ctx.strokeStyle = c;
    ctx.beginPath();
    st.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
    if (st.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
