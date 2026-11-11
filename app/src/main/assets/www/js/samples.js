// Eingebaute Beispielmotive (prozedural erzeugt, eigene Werke)

const f = (n) => n.toFixed(2);

function poly(pts, close) {
  return 'M' + pts.map(p => f(p[0]) + ',' + f(p[1])).join(' L') + (close ? ' Z' : '');
}

function star() {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 40 : 95, a = -Math.PI / 2 + i * Math.PI / 5;
    pts.push([100 + r * Math.cos(a), 100 + r * Math.sin(a)]);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${poly(pts, true)}" fill="none" stroke="#1b1b1f" stroke-width="2"/></svg>`;
}

function spiral() {
  const pts = [];
  for (let t = 0; t < Math.PI * 14; t += 0.05) {
    const r = 3 + t * 2.1;
    pts.push([100 + r * Math.cos(t), 100 + r * Math.sin(t)]);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${poly(pts)}" fill="none" stroke="#1e4fd8" stroke-width="2"/></svg>`;
}

function rose() {
  const paths = [];
  const cols = ['#d32f2f', '#1b1b1f'];
  [[5, 90], [7, 55]].forEach(([k, R], j) => {
    const pts = [];
    for (let t = 0; t <= Math.PI * 2 + 0.001; t += 0.01) {
      const r = R * Math.cos(k * t);
      pts.push([100 + r * Math.cos(t), 100 + r * Math.sin(t)]);
    }
    paths.push(`<path d="${poly(pts)}" fill="none" stroke="${cols[j]}" stroke-width="2"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${paths.join('')}</svg>`;
}

function heart() {
  const pts = [];
  for (let t = 0; t <= Math.PI * 2; t += 0.02) {
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([100 + x * 5.5, 95 - y * 5.5]);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${poly(pts, true)}" fill="#d32f2f" stroke="#1b1b1f" stroke-width="2"/></svg>`;
}

function waves() {
  const cols = ['#1b1b1f', '#d32f2f', '#1e4fd8', '#178a45'];
  const paths = [];
  for (let j = 0; j < 12; j++) {
    const pts = [];
    for (let x = 0; x <= 300; x += 3) pts.push([x, 20 + j * 13 + Math.sin(x / 22 + j * 0.6) * 9]);
    paths.push(`<path d="${poly(pts)}" fill="none" stroke="${cols[j % 4]}" stroke-width="2"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 190">${paths.join('')}</svg>`;
}

function mandala() {
  const cols = ['#1b1b1f', '#1e4fd8', '#178a45', '#d32f2f'];
  let out = '';
  for (let ring = 0; ring < 4; ring++) {
    const n = 8 + ring * 4, R = 25 + ring * 22;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      const cx = 100 + R * Math.cos(a), cy = 100 + R * Math.sin(a);
      out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(6 + ring * 3)}" fill="none" stroke="${cols[ring]}" stroke-width="2"/>`;
    }
  }
  out += `<circle cx="100" cy="100" r="14" fill="none" stroke="#d32f2f" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 220 220">${out}</svg>`;
}

function house() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g fill="none" stroke="#1b1b1f" stroke-width="2">
    <rect x="40" y="90" width="120" height="90"/>
    <path d="M30 95 L100 30 L170 95"/>
    <rect x="88" y="130" width="26" height="50"/>
    <rect x="55" y="105" width="24" height="22"/><rect x="121" y="105" width="24" height="22"/>
  </g>
  <rect x="128" y="45" width="16" height="30" fill="#7a4a2a"/>
  <circle cx="165" cy="35" r="14" fill="#f2c200" stroke="#f57c00" stroke-width="2"/>
  </svg>`;
}

export const SAMPLES = [
  { id: 'star', name: 'Stern', svg: star },
  { id: 'heart', name: 'Herz (gefüllt)', svg: heart },
  { id: 'rose', name: 'Rosette', svg: rose },
  { id: 'spiral', name: 'Spirale', svg: spiral },
  { id: 'waves', name: 'Wellen 4 Farben', svg: waves },
  { id: 'mandala', name: 'Mandala', svg: mandala },
  { id: 'house', name: 'Haus', svg: house },
];

export function testSquareSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}">
  <path d="M0 0 H${size} V${size} H0 Z M${size / 2} ${size * 0.35} V${size * 0.65} M${size * 0.35} ${size / 2} H${size * 0.65}" fill="none" stroke="#000"/></svg>`;
}
