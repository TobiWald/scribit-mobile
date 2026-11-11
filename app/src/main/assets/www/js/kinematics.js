// Wandkinematik für den Scribit.
// Koordinaten in mm: Ursprung = linker Aufhängepunkt, x nach rechts, y nach unten.
// Das Modell entspricht dem hardware-getesteten Unbrickit-Konverter
// (Gondel 105 mm breit, Fäden an den oberen Ecken, Winkelkorrektur der Fadenbreite),
// ist aber in beide Richtungen konsistent (Vorwärts = numerische Umkehrung).

export const DEFAULT_GEOMETRY = {
  anchorDistance: 2250,   // mm zwischen den Aufhängepunkten
  gondolaWidth: 105,      // mm
  attachOffset: 52.5,     // mm, vertikaler Versatz Befestigung
  angleCorrection: true,  // Unbrickit-Winkelkorrektur der Fadenbreite
  yCorrection: true,      // Unbrickit empirische Y-Korrektur
  kx: 1.0,                // eigene Kalibrierfaktoren (Testquadrat)
  ky: 1.0,
};

// Ziel-Position (Gondelmitte) -> Fadenlängen
export function lengthsAt(g, x, y) {
  const A = g.anchorDistance;
  const w = g.gondolaWidth / 2;
  const h = g.attachOffset;
  const D = y + h;
  let we = w;
  if (g.angleCorrection && D > 0) {
    const la = Math.atan2(x, D);
    const ra = Math.atan2(A - x, D);
    we = (w * Math.abs(Math.sin(la)) + w * Math.abs(Math.sin(ra))) / 2;
  }
  return {
    L: Math.hypot(x - we, D),
    R: Math.hypot(A - x - we, D),
  };
}

// Analytische Startlösung (volle Gondelbreite), wie calculate_position in Unbrickit
function analyticPosition(g, L, R) {
  const A = g.anchorDistance;
  const w = g.gondolaWidth / 2;
  const h = g.attachOffset;
  const x = (A * A - 2 * A * w + L * L - R * R) / (2 * (A - 2 * w));
  const s = L * L - (x - w) * (x - w);
  const y = Math.sqrt(Math.max(s, 1)) - h;
  return { x, y };
}

// Fadenlängen -> Position (Newton auf lengthsAt, damit beide Richtungen zusammenpassen)
export function positionFrom(g, L, R) {
  let { x, y } = analyticPosition(g, L, R);
  if (!isFinite(x) || !isFinite(y)) return { x: g.anchorDistance / 2, y: 800, valid: false };
  for (let i = 0; i < 25; i++) {
    const f = lengthsAt(g, x, y);
    const eL = f.L - L, eR = f.R - R;
    if (Math.abs(eL) < 1e-6 && Math.abs(eR) < 1e-6) break;
    const d = 0.01;
    const fx = lengthsAt(g, x + d, y), fy = lengthsAt(g, x, y + d);
    const a = (fx.L - f.L) / d, b = (fy.L - f.L) / d;
    const c = (fx.R - f.R) / d, e = (fy.R - f.R) / d;
    const det = a * e - b * c;
    if (Math.abs(det) < 1e-9) break;
    x -= (e * eL - b * eR) / det;
    y -= (-c * eL + a * eR) / det;
  }
  const valid = L + R > g.anchorDistance && Math.abs(L - R) < g.anchorDistance && y > 0;
  return { x, y, valid };
}

// Unbrickit empirische Y-Korrektur (Messwerte: nahe der Aufhängung 0.94, weiter unten 0.99)
export function yCorrectionAt(y) {
  return Math.max(0.94, Math.min(1.03, 0.94 + (y / 1000) * 0.05));
}

// Gewünschter Wandpunkt -> Ziel, das der Roboter anfahren muss (inkl. Korrekturen).
// start = Startposition des Roboters (Bezugspunkt der Korrekturen wie in Unbrickit)
export function correctedTarget(g, start, px, py) {
  let rx = (px - start.x) * (g.kx || 1);
  let ry = py - start.y;
  if (g.yCorrection) ry = ry / yCorrectionAt(py);
  ry *= g.ky || 1;
  return { x: start.x + rx, y: start.y + ry };
}

// Sicherer Arbeitsbereich (Warnung, keine harte Sperre)
export function safeArea(g, limits) {
  const m = limits || {};
  const side = m.side ?? 150;
  const top = m.top ?? 200;
  const bottom = m.bottom ?? 1800;
  return {
    x0: side, x1: g.anchorDistance - side,
    y0: top, y1: bottom,
  };
}
