// Farb-Hilfen: Parsing, Lab-Abstand, Zuordnung zu Stiften

export function parseColor(str) {
  if (!str) return null;
  str = String(str).trim().toLowerCase();
  if (str === 'none' || str === 'transparent') return null;
  let m = str.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return null;
    return [+m[1], +m[2], +m[3]].map(v => Math.max(0, Math.min(255, Math.round(v))));
  }
  m = str.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const named = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
    yellow: [255, 255, 0], orange: [255, 165, 0], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128],
    lime: [0, 255, 0], navy: [0, 0, 128], brown: [165, 42, 42], pink: [255, 192, 203], cyan: [0, 255, 255], magenta: [255, 0, 255] };
  return named[str] || null;
}

export function toHex(rgb) {
  return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToLab([r, g, b]) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

export function deltaE(a, b) {
  const A = rgbToLab(a), B = rgbToLab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

export function luminance([r, g, b]) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Index des ähnlichsten Stifts
export function nearestPen(rgb, pens) {
  let best = 0, bd = Infinity;
  pens.forEach((p, i) => {
    const d = deltaE(rgb, parseColor(p.color) || [0, 0, 0]);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export const PEN_PRESETS = [
  { name: 'Schwarz', color: '#1b1b1f' },
  { name: 'Rot', color: '#d32f2f' },
  { name: 'Blau', color: '#1e4fd8' },
  { name: 'Grün', color: '#178a45' },
  { name: 'Orange', color: '#f57c00' },
  { name: 'Gelb', color: '#f2c200' },
  { name: 'Lila', color: '#7b3fb5' },
  { name: 'Pink', color: '#e94b8a' },
  { name: 'Braun', color: '#7a4a2a' },
  { name: 'Grau', color: '#6b7280' },
  { name: 'Hellblau', color: '#2aa7e0' },
  { name: 'Türkis', color: '#11a39a' },
];
