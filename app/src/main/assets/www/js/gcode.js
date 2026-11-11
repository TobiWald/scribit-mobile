// G-Code-Erzeugung für den Scribit (Unbrickit-Firmware, G91 Fadenlängen-Deltas).
//   X = Änderung linker Faden, Y = -(Änderung rechter Faden)
//   Stift: G1 Z-30 runter, G1 Z30 hoch, Wechsel: Z72 je Platz + Z60/Z-60 Einrasten
// Pakete werden klein gehalten, weil die Firmware Uploads nur bis 65535 Byte
// (uint16) annimmt und den Body ohne Warten einliest.

import { correctedTarget, lengthsAt } from './kinematics.js';

export const GCODE_DEFAULTS = {
  feedDraw: 1000,
  feedTravel: 1000,
  feedPen: 1000,
  dwellDown: 0,      // ms Pause nach dem Absenken
};

const MAX_FEED = 2400; // mm/min (40 mm/s laut MK4duo-Konfiguration)

function fmt(v) {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export function cloneState(s) { return { L: s.L, R: s.R, z: s.z, slot: s.slot, feed: s.feed }; }

// Erzeugt die Zeilen für einen Schritt; verändert st. Liefert {lines, time}
export function compileStep(step, st, plan, cfg) {
  const lines = [];
  let time = 0;
  const feedSuffix = (f) => {
    if (st.feed !== f) { st.feed = f; return ' F' + f; }
    return '';
  };
  const zMove = (deg) => {
    lines.push('G1 Z' + fmt(deg) + feedSuffix(cfg.feedPen));
    time += Math.abs(deg) / (Math.min(cfg.feedPen, MAX_FEED) / 60) + 0.1;
  };
  switch (step.k) {
    case 'init':
      lines.push('M17', 'G77', 'G90', 'G1 Z160', 'G91', 'G1 Z-70');
      st.z = 0; st.slot = 0;
      time += 8;
      break;
    case 'pen': {
      if (st.z !== 0) { zMove(30); st.z = 0; }
      const n = ((step.to - st.slot) % 5 + 5) % 5;
      if (n > 0) {
        for (let i = 0; i < n; i++) zMove(72);
        zMove(60); zMove(-60);
      }
      st.slot = step.to;
      break;
    }
    case 'down':
      if (st.z === 0) {
        zMove(-30); st.z = -30;
        if (cfg.dwellDown > 0) { lines.push('G4 P' + Math.round(cfg.dwellDown)); time += cfg.dwellDown / 1000; }
      }
      break;
    case 'up':
      if (st.z !== 0) { zMove(30); st.z = 0; }
      break;
    case 'move': {
      const t = correctedTarget(plan.geom, plan.start, step.x, step.y);
      const { L, R } = lengthsAt(plan.geom, t.x, t.y);
      const dL = Math.round((L - st.L) * 100) / 100;
      const dR = Math.round((R - st.R) * 100) / 100;
      if (dL === 0 && dR === 0) break;
      const f = step.draw ? cfg.feedDraw : cfg.feedTravel;
      let line = 'G1';
      if (dL !== 0) line += ' X' + fmt(dL);
      if (dR !== 0) line += ' Y' + fmt(-dR);
      line += feedSuffix(f);
      lines.push(line);
      st.L += dL; st.R += dR;
      time += Math.hypot(dL, dR) / (Math.min(f, MAX_FEED) / 60) + 0.03;
      break;
    }
    case 'raw':
      lines.push(...step.lines);
      time += step.time || 1;
      break;
    case 'swap':
      break;
  }
  return { lines, time };
}

// Nächstes Paket ab Schritt i0. Bricht bevorzugt dort, wo der Stift oben ist.
export function makeChunk(plan, i0, state, cfg, budget = 1300) {
  const steps = plan.steps;
  if (i0 >= steps.length) return null;
  if (steps[i0].k === 'swap') return { swap: steps[i0], from: i0, to: i0 + 1, stateBefore: cloneState(state), stateAfter: cloneState(state) };
  const st = cloneState(state);
  const header = ['G91', 'G1 F' + st.feed];
  const body = [];
  const meta = [];
  let bytes = header.join('\n').length;
  let time = 0;
  let i = i0;
  let safe = null;
  while (i < steps.length) {
    const step = steps[i];
    if (step.k === 'swap') break;
    const before = cloneState(st);
    const r = compileStep(step, st, plan, cfg);
    const add = r.lines.reduce((a, l) => a + l.length + 1, 0);
    if (bytes + add > budget && body.length > 0) {
      // Rückgängig und an guter Stelle trennen
      Object.assign(st, before);
      if (safe && safe.bytes > budget * 0.35) {
        body.length = safe.body; meta.length = safe.body;
        Object.assign(st, safe.state); i = safe.i; time = safe.time; bytes = safe.bytes;
      }
      break;
    }
    // Zwischenzustände pro Zeile merken (für Wiederaufsetzen bei abgeschnittenem Upload)
    if (r.lines.length) {
      const tmp = cloneState(before);
      r.lines.forEach((l, k) => {
        applyLine(tmp, l);
        meta.push({ step: i, state: cloneState(tmp), last: k === r.lines.length - 1, kind: step.k });
      });
      meta[meta.length - 1].state = cloneState(st);
      body.push(...r.lines);
    }
    bytes += add;
    time += r.time;
    i++;
    if (step.k === 'up' || (step.k === 'move' && !step.draw && st.z === 0)) {
      safe = { body: body.length, state: cloneState(st), i, time, bytes };
    }
  }
  if (!body.length && i > i0) {
    // Nur Schritte ohne Zeilen (z.B. Nullbewegungen)
    return { empty: true, from: i0, to: i, stateBefore: cloneState(state), stateAfter: cloneState(st), time: 0 };
  }
  const text = header.concat(body).join('\n');
  return { text, from: i0, to: i, header: header.length, meta, stateBefore: cloneState(state), stateAfter: cloneState(st), bytes: text.length, time };
}

// Wendet eine (evtl. abgeschnittene) Zeile auf den Zustand an (nur G91-Moves relevant)
function applyLine(st, line) {
  const m = /^G1\b(.*)$/.exec(line.trim());
  if (!m) return;
  const get = (ax) => {
    const r = new RegExp(ax + '(-?\\d*\\.?\\d*)').exec(m[1]);
    if (!r) return null;
    const v = parseFloat(r[1]);
    return isNaN(v) ? 0 : v;
  };
  const x = get('X'), y = get('Y'), z = get('Z'), f = get('F');
  if (x !== null) st.L += x;
  if (y !== null) st.R -= y;
  if (z !== null) st.z += z;
  if (f !== null && f > 0) st.feed = f;
}

// Upload wurde abgeschnitten: Was hat der Roboter wirklich ausgeführt?
export function resyncAfterTruncation(chunk, executedBytes) {
  const exec = chunk.text.slice(0, executedBytes);
  const parts = exec.split('\n');
  const partial = parts.pop(); // letzte, evtl. unvollständige Zeile
  const complete = parts.length;
  const bodyDone = complete - chunk.header;
  let state = cloneState(chunk.stateBefore);
  let next = chunk.from;
  let penUnknown = false;
  if (bodyDone > 0) {
    const m = chunk.meta[bodyDone - 1];
    state = cloneState(m.state);
    if (m.last) next = m.step + 1;
    else if (m.kind === 'down' || m.kind === 'move') next = m.step + 1;
    else { penUnknown = true; next = m.step + 1; }
  }
  if (partial && partial.length) {
    const idx = Math.max(0, bodyDone);
    const m = chunk.meta[idx];
    if (m && bodyDone >= 0) {
      if (m.kind === 'move') { applyLine(state, partial); next = m.step; }
      else if (/Z/.test(partial) || m.kind === 'init' || m.kind === 'pen') penUnknown = true;
    }
  }
  state.feed = chunk.stateBefore.feed; // nächster Paketkopf setzt den Vorschub neu
  return { state, next, penUnknown };
}

// Kompletter Export als eine Datei (z.B. für Unbrickit oder zum Archivieren)
export function exportGcode(plan, cfg, robot) {
  const st = { L: robot.L, R: robot.R, z: 0, slot: robot.penSlot ?? 0, feed: cfg.feedDraw };
  const out = ['; Scribit Mobile Export', 'M17', 'G91', 'G1 F' + st.feed];
  let time = 0;
  for (const step of plan.steps) {
    if (step.k === 'swap') { out.push(`; Stift in Platz ${step.slot + 1} tauschen: ${step.name}`); out.push('G4 P1'); continue; }
    const r = compileStep(step, st, plan, cfg);
    out.push(...r.lines);
    time += r.time;
  }
  out.push('M18');
  return { text: out.join('\n'), time, finalState: st };
}

// Zeitschätzung für einen ganzen Plan
export function estimatePlan(plan, cfg, robot) {
  const st = { L: robot.L, R: robot.R, z: 0, slot: robot.penSlot ?? 0, feed: cfg.feedDraw };
  let time = 0, bytes = 0, lines = 0;
  for (const step of plan.steps) {
    const r = compileStep(step, st, plan, cfg);
    time += r.time;
    lines += r.lines.length;
    for (const l of r.lines) bytes += l.length + 1;
  }
  return { time, bytes, lines };
}
