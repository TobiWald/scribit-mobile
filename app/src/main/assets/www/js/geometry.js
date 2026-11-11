// Geometrie-Hilfen: Polylinien, Vereinfachung, Schraffur-Füllung

export function bboxOf(polys, bb) {
  bb = bb || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const pts of polys) {
    for (const p of pts) {
      if (p[0] < bb.x0) bb.x0 = p[0];
      if (p[1] < bb.y0) bb.y0 = p[1];
      if (p[0] > bb.x1) bb.x1 = p[0];
      if (p[1] > bb.y1) bb.y1 = p[1];
    }
  }
  return bb;
}

export function designBBox(design) {
  const bb = bboxOf(design.strokes.map(s => s.pts));
  for (const f of design.fills) bboxOf(f.rings, bb);
  if (!isFinite(bb.x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return bb;
}

export function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

// Ramer-Douglas-Peucker, iterativ
export function simplify(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const qx = px - t * dx, qy = py - t * dy;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Lange Segmente unterteilen (im Fadenraum werden lange Geraden sonst krumm)
export function subdivide(pts, maxSeg) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(d / maxSeg);
    for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    out.push(b);
  }
  return out;
}

export function makeTransform(design, placement) {
  const bb = design.bbox || designBBox(design);
  const bw = Math.max(bb.x1 - bb.x0, 1e-9);
  const s = placement.width / bw;
  const mcx = (bb.x0 + bb.x1) / 2, mcy = (bb.y0 + bb.y1) / 2;
  const th = (placement.rotation || 0) * Math.PI / 180;
  const c = Math.cos(th), sn = Math.sin(th);
  const fx = placement.flipX ? -1 : 1;
  const fn = (p) => {
    const x = (p[0] - mcx) * s * fx, y = (p[1] - mcy) * s;
    return [placement.cx + x * c - y * sn, placement.cy + x * sn + y * c];
  };
  fn.scale = s;
  return fn;
}

// Ecken des platzierten Motivs (für Rahmen/Hit-Test)
export function placedCorners(design, placement) {
  const bb = design.bbox || designBBox(design);
  const T = makeTransform(design, placement);
  return [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]].map(T);
}

export function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Schraffur einer Fläche (Ringe in mm). Liefert Liste von Segmenten [[x,y],[x,y]],
// pro Scanline abwechselnd in der Richtung (Zickzack).
export function hatchRings(rings, angleDeg, spacing, rule = 'evenodd') {
  if (spacing <= 0.05) spacing = 0.05;
  const a = angleDeg * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // In ein Koordinatensystem drehen, in dem die Schraffurlinien waagrecht sind
  const edges = [];
  let ymin = Infinity, ymax = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      const py = -p[0] * s + p[1] * c, qy = -q[0] * s + q[1] * c;
      const px = p[0] * c + p[1] * s, qx = q[0] * c + q[1] * s;
      if (py === qy) continue;
      const e = py < qy
        ? { y0: py, y1: qy, x0: px, x1: qx, dir: 1 }
        : { y0: qy, y1: py, x0: qx, x1: px, dir: -1 };
      e.k = (e.x1 - e.x0) / (e.y1 - e.y0);
      edges.push(e);
      if (e.y0 < ymin) ymin = e.y0;
      if (e.y1 > ymax) ymax = e.y1;
    }
  }
  if (!edges.length) return [];
  edges.sort((u, v) => u.y0 - v.y0);
  const out = [];
  let active = [];
  let ei = 0;
  let line = 0;
  const rem = (ymax - ymin) % spacing;
  const startY = ymin + (rem > 1e-9 ? rem / 2 : spacing / 2);
  for (let y = startY; y < ymax; y += spacing, line++) {
    while (ei < edges.length && edges[ei].y0 <= y) active.push(edges[ei++]);
    active = active.filter(e => e.y1 > y);
    const xs = [];
    for (const e of active) if (e.y0 <= y) xs.push([e.x0 + (y - e.y0) * e.k, e.dir]);
    if (xs.length < 2) continue;
    xs.sort((u, v) => u[0] - v[0]);
    const spans = [];
    if (rule === 'nonzero') {
      let w = 0, start = 0;
      for (const [x, d] of xs) {
        const nw = w + d;
        if (w === 0 && nw !== 0) start = x;
        else if (w !== 0 && nw === 0) spans.push([start, x]);
        w = nw;
      }
    } else {
      for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i][0], xs[i + 1][0]]);
    }
    if (line % 2 === 1) { spans.reverse(); spans.forEach(sp => sp.reverse()); }
    for (const [xa, xb] of spans) {
      if (Math.abs(xb - xa) < 0.2) continue;
      // zurückdrehen
      out.push([[xa * c - y * s, xa * s + y * c], [xb * c - y * s, xb * s + y * c]]);
    }
  }
  return out;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}
