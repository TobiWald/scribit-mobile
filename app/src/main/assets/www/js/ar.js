// AR-Vorschau: Kamera oder Foto der Wand, Aufhängepunkte antippen,
// Motiv maßstabsgetreu einblenden und direkt im Bild verschieben/skalieren/drehen.

import { positionFrom, safeArea } from './kinematics.js';
import { placedCorners, pointInPolygon } from './geometry.js';
import { getCss } from './preview.js';
import { putBlob, getBlob } from './store.js';

export class ARView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.video = el.querySelector('video');
    this.img = el.querySelector('img');
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.stage = el.querySelector('.ar-stage');
    this.hint = el.querySelector('.ar-hint');
    this.stream = null;
    this.mode = 'none';     // live | photo | none
    this.reg = null;        // {pts:[[ix,iy],...], robot:{x,y}, w, h}
    this.tapStep = 0;       // 0 = fertig, 1..3 = Punkt erwartet
    this.taps = [];
    this.opacity = 0.9;
    this.live = null;
    this.ptrs = new Map();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.stage);
    this.bind();
  }

  bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (this.tapStep) return;
      this.startGesture();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (!this.tapStep) this.moveGesture();
    });
    const up = (e) => {
      if (!this.ptrs.has(e.pointerId)) return;
      const p = this.ptrs.get(e.pointerId);
      this.ptrs.delete(e.pointerId);
      if (this.tapStep) { this.onTap(p[0], p[1]); return; }
      if (this.ptrs.size === 0) this.endGesture(); else this.startGesture();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => { this.ptrs.delete(e.pointerId); });
  }

  async restore() {
    const saved = await getBlob('ar-photo');
    if (saved && saved.src) {
      this.showPhoto(saved.src, saved.reg || null);
      return true;
    }
    return false;
  }

  async startCamera() {
    this.stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Kamera hier nicht verfügbar. Nimm „Foto laden“.');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.mode = 'live';
    this.video.hidden = false;
    this.img.hidden = true;
    this.reg = null;
    this.setHint('Richte die Kamera so aus, dass beide Aufhängepunkte und der Roboter zu sehen sind. Dann „Foto aufnehmen“.');
    const loop = () => { if (this.mode === 'live') { this.draw(); requestAnimationFrame(loop); } };
    requestAnimationFrame(loop);
  }

  stopCamera() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
  }

  capture() {
    if (this.mode !== 'live' || !this.video.videoWidth) return false;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const k = Math.min(1, 1800 / Math.max(vw, vh));
    const c = document.createElement('canvas');
    c.width = Math.round(vw * k); c.height = Math.round(vh * k);
    c.getContext('2d').drawImage(this.video, 0, 0, c.width, c.height);
    const src = c.toDataURL('image/jpeg', 0.85);
    this.stopCamera();
    this.showPhoto(src, null);
    this.beginRegistration();
    return true;
  }

  async loadFile(file) {
    const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    // verkleinern
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const k = Math.min(1, 1800 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    this.stopCamera();
    this.showPhoto(c.toDataURL('image/jpeg', 0.85), null);
    this.beginRegistration();
  }

  showPhoto(src, reg) {
    this.mode = 'photo';
    this.video.hidden = true;
    this.img.hidden = false;
    this.img.onload = () => this.draw();
    this.img.src = src;
    this.photoSrc = src;
    this.reg = reg;
    if (reg) this.setHint('Ziehe das Motiv mit einem Finger, mit zwei Fingern größer/kleiner machen.');
    this.draw();
  }

  beginRegistration() {
    this.tapStep = 1;
    this.taps = [];
    this.reg = null;
    this.setHint('Tippe auf den linken Aufhängepunkt.');
    this.app.onArState && this.app.onArState();
    this.draw();
  }

  skipRobotPoint() {
    if (this.tapStep === 3) this.finishRegistration();
  }

  onTap(x, y) {
    const ip = this.cssToImage(x, y);
    if (!ip) return;
    this.taps.push(ip);
    if (this.tapStep === 1) { this.tapStep = 2; this.setHint('Jetzt den rechten Aufhängepunkt antippen.'); }
    else if (this.tapStep === 2) { this.tapStep = 3; this.setHint('Optional: Stiftspitze des Roboters antippen (verbessert die Perspektive) oder „Überspringen“.'); }
    else if (this.tapStep === 3) this.finishRegistration();
    this.app.onArState && this.app.onArState();
    this.draw();
  }

  finishRegistration() {
    const sc = this.app.getScene();
    const robot = positionFrom(sc.geom, sc.robot.L, sc.robot.R);
    this.reg = { pts: this.taps.slice(0, 3), robot: { x: robot.x, y: robot.y }, w: this.imgW(), h: this.imgH() };
    this.tapStep = 0;
    this.setHint('Ziehe das Motiv mit einem Finger, mit zwei Fingern größer/kleiner machen.');
    putBlob('ar-photo', { src: this.photoSrc, reg: this.reg });
    this.app.onArState && this.app.onArState();
    this.draw();
  }

  setHint(t) { if (this.hint) this.hint.textContent = t; }

  imgW() { return this.mode === 'live' ? this.video.videoWidth : this.img.naturalWidth; }
  imgH() { return this.mode === 'live' ? this.video.videoHeight : this.img.naturalHeight; }

  // object-fit: contain -> Abbildung Bildpixel <-> CSS-Pixel
  layout() {
    const r = this.stage.getBoundingClientRect();
    const iw = this.imgW(), ih = this.imgH();
    if (!iw || !ih || !r.width) return null;
    const k = Math.min(r.width / iw, r.height / ih);
    return { k, ox: (r.width - iw * k) / 2, oy: (r.height - ih * k) / 2, w: r.width, h: r.height };
  }
  cssToImage(x, y) { const L = this.layout(); return L ? [(x - L.ox) / L.k, (y - L.oy) / L.k] : null; }

  // Wand(mm) -> Bild(px) als Affinmatrix [a,b,c,d,e,f]: x' = a x + c y + e, y' = b x + d y + f
  matrix() {
    if (!this.reg) return null;
    const sc = this.app.getScene();
    const A = sc.geom.anchorDistance;
    const [P1, P2, P3] = this.reg.pts;
    if (P3) {
      const W = [[0, 0], [A, 0], [this.reg.robot.x, this.reg.robot.y]];
      const P = [P1, P2, P3];
      const m = solveAffine(W, P);
      if (m) return m;
    }
    const a = (P2[0] - P1[0]) / A, b = (P2[1] - P1[1]) / A;
    return [a, b, -b, a, P1[0], P1[1]];
  }

  startGesture() {
    const pts = [...this.ptrs.values()];
    const sc = this.app.getScene();
    if (!sc.placement || !this.reg) { this.g = null; return; }
    const base = this.live || sc.placement;
    if (pts.length === 1) this.g = { mode: 'move', p0: pts[0], pl0: { ...base } };
    else this.g = { mode: 'pinch', a0: pts[0], b0: pts[1], pl0: { ...base } };
  }

  // CSS-Delta -> Wand-Delta über inverse lineare Abbildung
  cssDeltaToWall(dx, dy) {
    const L = this.layout(), m = this.matrix();
    if (!L || !m) return [0, 0];
    const ix = dx / L.k, iy = dy / L.k;
    const det = m[0] * m[3] - m[2] * m[1];
    return [(m[3] * ix - m[2] * iy) / det, (-m[1] * ix + m[0] * iy) / det];
  }

  moveGesture() {
    const g = this.g;
    if (!g) return;
    const pts = [...this.ptrs.values()];
    if (g.mode === 'move' && pts.length === 1) {
      const [dx, dy] = this.cssDeltaToWall(pts[0][0] - g.p0[0], pts[0][1] - g.p0[1]);
      this.live = { ...g.pl0, cx: g.pl0.cx + dx, cy: g.pl0.cy + dy };
    } else if (g.mode === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const k = Math.hypot(b[0] - a[0], b[1] - a[1]) / (Math.hypot(g.b0[0] - g.a0[0], g.b0[1] - g.a0[1]) || 1);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(g.b0[1] - g.a0[1], g.b0[0] - g.a0[0]);
      let rot = g.pl0.rotation + (this.app.allowRotate() ? ang * 180 / Math.PI : 0);
      const snap = Math.round(rot / 90) * 90;
      if (Math.abs(rot - snap) < 4) rot = snap;
      const m0 = [(g.a0[0] + g.b0[0]) / 2, (g.a0[1] + g.b0[1]) / 2], m1 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [dx, dy] = this.cssDeltaToWall(m1[0] - m0[0], m1[1] - m0[1]);
      this.live = { ...g.pl0, width: Math.max(10, g.pl0.width * k), rotation: rot, cx: g.pl0.cx + dx, cy: g.pl0.cy + dy };
    }
    this.app.onPlacementLive && this.app.onPlacementLive(this.live);
    this.draw();
  }

  endGesture() {
    if (this.live) { const pl = this.live; this.app.onPlacement(pl); }
    this.g = null;
  }

  planChanged() { this.live = null; this.draw(); }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const L = this.layout();
    if (!L) return;
    // Getippte Punkte
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mark = (ip, label) => {
      const x = L.ox + ip[0] * L.k, y = L.oy + ip[1] * L.k;
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = getCss('--accent');
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y); ctx.moveTo(x, y - 18); ctx.lineTo(x, y + 18); ctx.stroke();
      ctx.font = '600 13px system-ui, sans-serif'; ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
      ctx.strokeText(label, x + 16, y - 14); ctx.fillText(label, x + 16, y - 14);
    };
    const labels = ['Links', 'Rechts', 'Roboter'];
    if (this.tapStep) { this.taps.forEach((p, i) => mark(p, labels[i])); return; }
    const m = this.matrix();
    if (!m) return;
    const sc = this.app.getScene();
    // Gesamttransformation Wand -> Canvas
    const T = [L.k * m[0], L.k * m[1], L.k * m[2], L.k * m[3], L.k * m[4] + L.ox, L.k * m[5] + L.oy].map(v => v * dpr);
    ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    const unit = 1 / Math.hypot(T[0], T[1]); // 1 Canvas-Pixel in mm
    // Sicherer Bereich und Ankerlinie
    const area = safeArea(sc.geom, sc.limits);
    ctx.setLineDash([10 * unit, 8 * unit]);
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.strokeRect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    ctx.setLineDash([]);
    // Motiv
    if (sc.plan) {
      ctx.save();
      if (this.live && sc.planPlacement) {
        const p0 = sc.planPlacement, p1 = this.live;
        ctx.translate(p1.cx, p1.cy);
        ctx.rotate(((p1.rotation || 0) - (p0.rotation || 0)) * Math.PI / 180);
        ctx.scale(p1.width / p0.width, p1.width / p0.width);
        ctx.translate(-p0.cx, -p0.cy);
      }
      ctx.globalAlpha = this.opacity;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(sc.penWidth || 1.5, 1.5 * unit);
      for (const ps of sc.plan.passes) {
        ctx.strokeStyle = ps.color;
        ctx.beginPath();
        for (const s of ps.strokes) { s.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (sc.design && (this.live || sc.placement)) {
      const cs = placedCorners(sc.design, this.live || sc.placement);
      ctx.setLineDash([8 * unit, 6 * unit]);
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = sc.outside ? '#ff5a4f' : '#ffffff';
      ctx.beginPath(); cs.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Anker
    ctx.fillStyle = getCss('--accent');
    for (const ax of [0, sc.geom.anchorDistance]) { ctx.beginPath(); ctx.arc(ax, 0, 8 * unit, 0, Math.PI * 2); ctx.fill(); }
  }

  hitDesign(x, y) {
    const sc = this.app.getScene();
    const m = this.matrix(), L = this.layout();
    if (!m || !L || !sc.design) return false;
    const ix = (x - L.ox) / L.k, iy = (y - L.oy) / L.k;
    const det = m[0] * m[3] - m[2] * m[1];
    const wx = (m[3] * (ix - m[4]) - m[2] * (iy - m[5])) / det;
    const wy = (-m[1] * (ix - m[4]) + m[0] * (iy - m[5])) / det;
    return pointInPolygon(wx, wy, placedCorners(sc.design, sc.placement));
  }
}

function solveAffine(W, P) {
  // [x y 1] * [a c e; b d f]^T, zwei 3x3 Systeme
  const M = W.map(([x, y]) => [x, y, 1]);
  const solve = (rhs) => {
    const A = M.map((r, i) => [...r, rhs[i]]);
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
      }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  };
  const X = solve(P.map(p => p[0])), Y = solve(P.map(p => p[1]));
  if (!X || !Y) return null;
  // x' = X0 x + X1 y + X2 ; y' = Y0 x + Y1 y + Y2
  return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
}
