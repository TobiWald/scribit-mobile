// Zeichenauftrag: schickt den Plan in kleinen Paketen, wartet jeweils bis der Roboter fertig ist.
// Dadurch gibt es kein Größenlimit, echtes "Stopp", Stiftwechsel-Pausen und Wiederaufsetzen.

import { makeChunk, compileStep, cloneState, resyncAfterTruncation } from './gcode.js';
import * as dev from './device.js';

const sleep = (ms) => dev.sleep(ms);

export class JobRunner {
  constructor(plan, cfg, opts) {
    this.plan = plan;
    this.cfg = cfg;
    this.opts = Object.assign({ budget: 1300, pollMs: 700 }, opts);
    this.state = 'idle';
    this.message = '';
    this.userPaused = false;
    this.stopRequested = false;
    this.i = 0;
    this.chunks = 0;
    this.errors = 0;
    this.ratio = 1;          // tatsächliche / geschätzte Zeit
    this.overhead = 1.2;     // s Lücke pro Paket
    this.st = { L: plan.robot.L, R: plan.robot.R, z: 0, slot: plan.robot.penSlot ?? 0, feed: cfg.feedDraw };
    // Vorberechnung: Zeit und gezeichnete Länge pro Schritt
    const n = plan.steps.length;
    this.cumTime = new Float64Array(n + 1);
    this.cumDraw = new Float64Array(n + 1);
    const tmp = cloneState(this.st);
    let lastAt = 0;
    plan.steps.forEach((s, k) => {
      const r = compileStep(s, tmp, plan, cfg);
      this.cumTime[k + 1] = this.cumTime[k] + r.time;
      if (s.at) lastAt = s.at;
      this.cumDraw[k + 1] = lastAt;
    });
    this.totalTime = this.cumTime[n];
    this.totalDraw = plan.stats.drawn;
    this.current = null;
    this.chunkStart = 0;
    this.startTime = 0;
    this.swapResolver = null;
    this.resumeResolver = null;
  }

  emit() { this.opts.onUpdate && this.opts.onUpdate(this); }
  log(msg) { this.opts.onLog && this.opts.onLog(msg); }
  setState(s, msg) { this.state = s; if (msg !== undefined) this.message = msg; this.emit(); }

  progress() {
    const n = this.plan.steps.length;
    let stepPos = this.i;
    if (this.current && this.state !== 'swap') {
      const el = (Date.now() - this.chunkStart) / 1000;
      const frac = Math.min(0.95, el / Math.max(0.5, this.current.time * this.ratio));
      stepPos = this.current.from + (this.current.to - this.current.from) * frac;
    }
    const k = Math.min(n, Math.floor(stepPos));
    const remaining = (this.totalTime - this.cumTime[k]) * this.ratio
      + Math.max(0, (this.totalTime - this.cumTime[k])) / Math.max(1, this.avgChunkTime()) * this.overhead;
    return {
      fraction: n ? stepPos / n : 1,
      step: k,
      drawn: this.cumDraw[k],
      totalDraw: this.totalDraw,
      elapsed: this.startTime ? (Date.now() - this.startTime) / 1000 : 0,
      remaining: Math.max(0, remaining),
      chunks: this.chunks,
    };
  }

  avgChunkTime() { return this.chunks ? (this.cumTime[this.i] / this.chunks) : 20; }

  async start() {
    this.startTime = Date.now();
    this.setState('running', 'Starte…');
    try {
      await this.run();
    } catch (e) {
      this.setState('error', 'Fehler: ' + e.message);
      return;
    }
  }

  pause() {
    if (this.state !== 'running') return;
    this.userPaused = true;
    this.setState('paused', 'Pausiert');
    dev.pause();
  }

  resume() {
    if (this.resumeResolver) { const r = this.resumeResolver; this.resumeResolver = null; r(); }
    if (this.state === 'paused' || this.userPaused) {
      this.userPaused = false;
      this.setState('running', 'Läuft weiter');
      dev.resume();
    }
  }

  confirmSwap() {
    if (this.swapResolver) { const r = this.swapResolver; this.swapResolver = null; r(); }
  }

  async stop() {
    this.stopRequested = true;
    this.userPaused = false;
    this.setState('stopping', 'Stoppe nach aktuellem Paket…');
    if (this.resumeResolver) { const r = this.resumeResolver; this.resumeResolver = null; r(); }
    if (this.swapResolver) { const r = this.swapResolver; this.swapResolver = null; r(); }
    const s = await dev.getStatus();
    if (s.online && s.paused !== 'running') await dev.resume();
  }

  async waitIdle(label) {
    let offline = 0;
    for (;;) {
      const s = await dev.getStatus();
      if (s.online) {
        offline = 0;
        if (s.state === 'IDLE') return s;
        if (s.state === 'ERROR') throw new Error('Roboter meldet ERROR');
        if (s.paused === 'paused' && !this.userPaused && this.state === 'running') this.message = 'Roboter pausiert';
      } else {
        offline++;
        if (offline === 3) { this.message = 'Verbindung weg – warte auf Roboter…'; this.emit(); }
      }
      if (label && offline === 0 && this.state === 'running') { this.message = label; }
      this.emit();
      await sleep(this.opts.pollMs);
    }
  }

  async waitResume(msg) {
    this.setState('paused', msg);
    await new Promise(r => { this.resumeResolver = r; });
    if (!this.stopRequested) this.setState('running', 'Läuft weiter');
  }

  async sendText(text) {
    // Upload mit Wiederholung; erkennt, ob ein verlorener Upload trotzdem angekommen ist
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await dev.upload(text);
      if (r.ok) return r;
      if (r.status === 409) { await this.waitIdle(); continue; }
      if (r.status === 0) {
        await sleep(800);
        const s = await dev.getStatus();
        if (s.online && s.state === 'PRINTING') return { ok: true, size: null, assumed: true };
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error('Upload abgelehnt (HTTP ' + r.status + (r.error ? ': ' + r.error : '') + ')');
    }
    throw new Error('Upload nach mehreren Versuchen fehlgeschlagen');
  }

  async run() {
    const steps = this.plan.steps;
    await this.waitIdle('Warte auf Roboter…');
    while (this.i < steps.length) {
      if (this.stopRequested) break;
      while (this.userPaused && !this.stopRequested) await sleep(300);
      if (this.stopRequested) break;
      const c = makeChunk(this.plan, this.i, this.st, this.cfg, this.opts.budget);
      if (!c) break;
      if (c.swap) {
        this.setState('swap', `Stift in Platz ${c.swap.slot + 1} gegen „${c.swap.name}“ tauschen`);
        this.swapInfo = c.swap;
        this.opts.onSwap && this.opts.onSwap(c.swap);
        await new Promise(r => { this.swapResolver = r; });
        this.swapInfo = null;
        if (this.stopRequested) break;
        this.i = c.to;
        this.setState('running', 'Weiter mit ' + c.swap.name);
        continue;
      }
      if (c.empty) { this.i = c.to; this.st = c.stateAfter; continue; }

      await this.waitIdle();
      const r = await this.sendText(c.text);
      this.current = c;
      this.chunkStart = Date.now();
      this.chunks++;
      if (r.size !== null && r.size !== undefined && r.size !== c.bytes) {
        // Firmware hat nur einen Teil gelesen -> exakt dort weitermachen
        const rs = resyncAfterTruncation(c, r.size);
        this.log(`Paket ${this.chunks} unvollständig angekommen (${r.size}/${c.bytes} Byte), setze exakt wieder auf.`);
        await this.waitIdle();
        this.current = null;
        const wasDown = rs.state.z !== 0;
        this.st = rs.state;
        this.i = rs.next;
        if (rs.penUnknown) {
          await this.waitResume('Stiftmechanik unklar: bitte Weiter drücken, dann wird sie neu kalibriert.');
          if (this.stopRequested) break;
          await this.recoverPen(wasDown);
        }
        this.opts.onRobot && this.opts.onRobot(this.st);
        continue;
      }
      this.setState(this.stopRequested ? 'stopping' : (this.userPaused ? 'paused' : 'running'), this.stopRequested ? this.message : (this.userPaused ? 'Pausiert' : 'Zeichnet…'));
      await this.waitIdle();
      const took = (Date.now() - this.chunkStart) / 1000;
      if (c.time > 3 && !this.userPaused) this.ratio = this.ratio * 0.8 + Math.max(0.3, Math.min(4, took / c.time)) * 0.2;
      this.current = null;
      this.st = c.stateAfter;
      this.i = c.to;
      this.opts.onRobot && this.opts.onRobot(this.st);
      this.emit();
    }

    if (this.stopRequested) {
      await this.finishAfterStop();
      this.setState('stopped', 'Gestoppt, Roboter steht wieder am Start');
    } else {
      this.setState('done', 'Fertig!');
    }
  }

  async recoverPen(wasDown) {
    const st = cloneState(this.st);
    const target = st.slot;
    const lines = ['G91', 'G1 F' + st.feed];
    lines.push(...compileStep({ k: 'init' }, st, this.plan, this.cfg).lines);
    if (target) lines.push(...compileStep({ k: 'pen', from: 0, to: target }, st, this.plan, this.cfg).lines);
    if (wasDown) lines.push(...compileStep({ k: 'down' }, st, this.plan, this.cfg).lines);
    await this.sendText(lines.join('\n'));
    await this.waitIdle();
    this.st = st;
  }

  async finishAfterStop() {
    const st = cloneState(this.st);
    const lines = ['G91', 'G1 F' + st.feed];
    lines.push(...compileStep({ k: 'up' }, st, this.plan, this.cfg).lines);
    const dL = Math.round((this.plan.robot.L - st.L) * 100) / 100;
    const dR = Math.round((this.plan.robot.R - st.R) * 100) / 100;
    if (dL || dR) { lines.push(`G1 X${dL} Y${-dR}`); st.L += dL; st.R += dR; }
    await this.waitIdle();
    await this.sendText(lines.join('\n'));
    await this.waitIdle();
    this.st = st;
    this.opts.onRobot && this.opts.onRobot(this.st);
  }
}
