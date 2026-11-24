// Ambient and positional campus audio, synthesised with Web Audio (no files). Runs under the same master
// volume and mute switch as the sound effects, and only once the player has tapped (browser policy).
//
// Beds (non-positional, crossfaded by situation):
//   outdoors   wind through the trees, birdsong, distant traffic
//   indoors    building air-handling hum
//   on board   turboprop cabin drone
//   free fall  rushing wind; under the canopy a softer wind with fabric flutter
// Positional (follow the 3D camera as the listener):
//   the fountain, nearby squads' buggy engines, rival gunshots, airdrop landings, the drop plane overhead
import { audioGraph, isMuted } from './sound';

type Vec = { x: number; y: number; z: number };
export type AmbienceFrame = {
  cam: Vec; fwd: Vec; up: Vec;
  scene: 'outdoor' | 'indoor' | 'board' | 'freefall' | 'chute';
  engines: { id: string; p: Vec; speed: number }[];
  plane: Vec | null;
};

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
let enabled = store.get('hb_ambience') !== '0';
export const ambienceOn = () => enabled;
export function setAmbience(on: boolean) { enabled = on; store.set('hb_ambience', on ? '1' : '0'); window.dispatchEvent(new CustomEvent('hb:ambience')); }

function noiseBuffer(ctx: AudioContext, seconds: number, brown = false) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0); let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return b;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private beds: Record<string, GainNode> = {};
  private loops: AudioScheduledSourceNode[] = [];
  private fountain: { panner: PannerNode; p: Vec } | null = null;
  private engines = new Map<string, { osc: OscillatorNode; sub: OscillatorNode; gain: GainNode; panner: PannerNode; lp: BiquadFilterNode }>();
  private planeV: { gain: GainNode; panner: PannerNode } | null = null;
  private nextBird = 0;
  private scene: AmbienceFrame['scene'] = 'outdoor';
  private white: AudioBuffer | null = null;
  private lowEnd: boolean;
  private disposed = false;
  private onToggle = () => this.applyEnabled();

  constructor(private opts: { fountain?: Vec | null; lowEnd?: boolean } = {}) {
    this.lowEnd = !!opts.lowEnd;
    window.addEventListener('hb:ambience', this.onToggle);
  }

  /** builds the graph the first time audio is available (after the player's first tap) */
  private ensure(): boolean {
    if (this.ctx) return true;
    const g = audioGraph(); if (!g) return false;
    const ctx = this.ctx = g.ctx;
    this.out = ctx.createGain(); this.out.gain.value = enabled ? 1 : 0; this.out.connect(g.master);
    this.white = noiseBuffer(ctx, 2.5);
    const brown = noiseBuffer(ctx, 3, true);
    const bed = (name: string) => { const n = ctx.createGain(); n.gain.value = 0; n.connect(this.out!); this.beds[name] = n; return n; };
    const loop = (buf: AudioBuffer, ...chain: AudioNode[]) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = Math.random() * 0.5;
      let n: AudioNode = s; for (const c of chain) { n.connect(c); n = c; }
      s.start(); this.loops.push(s); return s;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const lfo = (target: AudioParam, rate: number, depth: number) => { const o = ctx.createOscillator(); o.frequency.value = rate; const k = ctx.createGain(); k.gain.value = depth; o.connect(k).connect(target); o.start(); this.loops.push(o); };
    const gain = (v: number) => { const x = ctx.createGain(); x.gain.value = v; return x; };

    // outdoors: wind (slowly breathing) + low traffic rumble
    const out = bed('outdoor');
    const windG = gain(0.05); loop(this.white, filt('lowpass', 420), windG, out); lfo(windG.gain, 0.09, 0.03);
    loop(brown, filt('lowpass', 140), gain(0.12), out);
    // indoors: air handling — mains hum and filtered air
    const ind = bed('indoor');
    for (const [f, v] of [[60, 0.018], [120, 0.01]] as const) { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(gain(v)).connect(ind); o.start(); this.loops.push(o); }
    loop(this.white, filt('bandpass', 260, 0.5), gain(0.06), ind);
    // on board: turboprop drone with a slow beat between the engines
    const brd = bed('board');
    for (const f of [92, 93.3, 184]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(filt('lowpass', 520)).connect(gain(0.035)).connect(brd); o.start(); this.loops.push(o); }
    loop(brown, filt('lowpass', 300), gain(0.25), brd);
    // free fall: a roar of wind; canopy: softer wind with a flutter
    const ff = bed('freefall');
    const rush = gain(0.22); loop(this.white, filt('bandpass', 700, 0.4), rush, ff); lfo(rush.gain, 0.7, 0.05);
    const ch = bed('chute');
    const flap = gain(0.06); loop(this.white, filt('bandpass', 380, 0.8), flap, ch); lfo(flap.gain, 7, 0.05);
    loop(this.white, filt('lowpass', 500), gain(0.05), ch);

    // the fountain: splashing water at its position
    if (this.opts.fountain) {
      const p = this.panner(this.opts.fountain, 6, 70);
      loop(this.white, filt('highpass', 1400), filt('lowpass', 6000), gain(0.22), p);
      this.fountain = { panner: p, p: this.opts.fountain };
    }
    // the drop plane overhead (heard from the ground, positional)
    {
      const pg = gain(0); const pn = this.panner({ x: 0, y: 150, z: 0 }, 40, 900, 1.2);
      for (const f of [88, 89.5]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(filt('lowpass', 380)).connect(pg); o.start(); this.loops.push(o); }
      pg.connect(pn); this.planeV = { gain: pg, panner: pn };
    }
    return true;
  }

  private panner(p: Vec, ref: number, max: number, rolloff = 1.4) {
    const ctx = this.ctx!;
    const pn = ctx.createPanner();
    pn.panningModel = this.lowEnd ? 'equalpower' : 'HRTF'; pn.distanceModel = 'inverse';
    pn.refDistance = ref; pn.maxDistance = max; pn.rolloffFactor = rolloff;
    this.setPos(pn, p); pn.connect(this.out!);
    return pn;
  }
  private setPos(pn: PannerNode, p: Vec) {
    const t = this.ctx!.currentTime;
    if (pn.positionX) { pn.positionX.setTargetAtTime(p.x, t, 0.05); pn.positionY.setTargetAtTime(p.y, t, 0.05); pn.positionZ.setTargetAtTime(p.z, t, 0.05); }
    else (pn as any).setPosition(p.x, p.y, p.z);
  }

  private applyEnabled() { if (this.out && this.ctx) this.out.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.3); }

  update(f: AmbienceFrame) {
    if (this.disposed || !this.ensure() || !this.ctx) return;
    const ctx = this.ctx; const now = ctx.currentTime;
    // listener = camera
    const L = ctx.listener as any;
    if (L.positionX) {
      L.positionX.setTargetAtTime(f.cam.x, now, 0.03); L.positionY.setTargetAtTime(f.cam.y, now, 0.03); L.positionZ.setTargetAtTime(f.cam.z, now, 0.03);
      L.forwardX.setTargetAtTime(f.fwd.x, now, 0.03); L.forwardY.setTargetAtTime(f.fwd.y, now, 0.03); L.forwardZ.setTargetAtTime(f.fwd.z, now, 0.03);
      L.upX.setTargetAtTime(f.up.x, now, 0.03); L.upY.setTargetAtTime(f.up.y, now, 0.03); L.upZ.setTargetAtTime(f.up.z, now, 0.03);
    } else { L.setPosition(f.cam.x, f.cam.y, f.cam.z); L.setOrientation(f.fwd.x, f.fwd.y, f.fwd.z, f.up.x, f.up.y, f.up.z); }
    // beds: crossfade to the current situation
    if (f.scene !== this.scene) this.scene = f.scene;
    const level: Record<string, number> = { outdoor: 0, indoor: 0, board: 0, freefall: 0, chute: 0 };
    level[f.scene] = 1;
    if (f.scene === 'chute') level.outdoor = 0.35; // the campus fades in as you come down
    for (const [k, gnode] of Object.entries(this.beds)) gnode.gain.setTargetAtTime(level[k], now, f.scene === 'freefall' || this.scene === 'freefall' ? 0.25 : 0.8);
    // birdsong outdoors on the ground, now and then from somewhere around you
    if (f.scene === 'outdoor' && performance.now() > this.nextBird) {
      this.nextBird = performance.now() + 2500 + Math.random() * 6000;
      const a = Math.random() * Math.PI * 2; const d = 15 + Math.random() * 30;
      this.chirp({ x: f.cam.x + Math.cos(a) * d, y: 6 + Math.random() * 6, z: f.cam.z + Math.sin(a) * d });
    }
    // engines of the nearest few buggies
    const near = f.scene === 'outdoor' || f.scene === 'indoor' ? f.engines.slice(0, this.lowEnd ? 2 : 4) : [];
    const keep = new Set(near.map((e) => e.id));
    for (const [id, e] of this.engines) if (!keep.has(id)) { e.gain.gain.setTargetAtTime(0, now, 0.2); const n = e; setTimeout(() => { try { n.osc.stop(); n.sub.stop(); n.panner.disconnect(); } catch { /* gone */ } }, 800); this.engines.delete(id); }
    for (const e of near) {
      let v = this.engines.get(e.id);
      if (!v) {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const sub = ctx.createOscillator(); sub.type = 'square';
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const panner = this.panner(e.p, 5, 120, 1.6);
        osc.connect(lp); sub.connect(lp); lp.connect(gain).connect(panner);
        osc.start(); sub.start();
        v = { osc, sub, gain, panner, lp }; this.engines.set(e.id, v);
      }
      const rpm = Math.min(1, e.speed / 14);
      v.osc.frequency.setTargetAtTime(38 + rpm * 70, now, 0.15); v.sub.frequency.setTargetAtTime(19 + rpm * 35, now, 0.15);
      v.lp.frequency.setTargetAtTime(220 + rpm * 900, now, 0.15);
      v.gain.gain.setTargetAtTime(0.025 + rpm * 0.06, now, 0.2);
      this.setPos(v.panner, e.p);
    }
    // the drop plane, heard from below while it crosses
    if (this.planeV) {
      const on = !!f.plane && f.scene !== 'board';
      this.planeV.gain.gain.setTargetAtTime(on ? 0.12 : 0, now, 0.6);
      if (f.plane) this.setPos(this.planeV.panner, f.plane);
    }
  }

  private chirp(p: Vec) {
    const ctx = this.ctx!; const pn = this.panner(p, 4, 80, 1.5);
    const base = 2600 + Math.random() * 1800; const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const t0 = ctx.currentTime + i * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(base, t0); o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), t0 + 0.06);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
      o.connect(g).connect(pn); o.start(t0); o.stop(t0 + 0.1);
    }
    setTimeout(() => { try { pn.disconnect(); } catch { /* gone */ } }, 1500);
  }

  /** a one-shot at a point in the world: rival gunshots, airdrop landings, canopy opening */
  at(kind: 'shot' | 'thud' | 'chute' | 'land', p: Vec) {
    if (this.disposed || isMuted() || !this.ensure() || !this.ctx || !this.white) return;
    const ctx = this.ctx; const t0 = ctx.currentTime;
    const pn = this.panner(p, kind === 'shot' ? 8 : 6, kind === 'shot' ? 400 : 200, kind === 'shot' ? 1.1 : 1.4);
    const src = ctx.createBufferSource(); src.buffer = this.white;
    const f = ctx.createBiquadFilter(); const g = ctx.createGain();
    const spec = { shot: { type: 'bandpass', freq: 1800, dur: 0.18, gain: 0.7 }, thud: { type: 'lowpass', freq: 220, dur: 0.6, gain: 0.9 }, chute: { type: 'bandpass', freq: 500, dur: 0.45, gain: 0.5 }, land: { type: 'lowpass', freq: 400, dur: 0.3, gain: 0.5 } }[kind];
    f.type = spec.type as BiquadFilterType; f.frequency.value = spec.freq;
    g.gain.setValueAtTime(spec.gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    src.connect(f).connect(g).connect(pn); src.start(t0, Math.random() * 1.5); src.stop(t0 + spec.dur + 0.05);
    if (kind === 'thud' || kind === 'shot') { // body: a low knock
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(kind === 'shot' ? 160 : 70, t0); o.frequency.exponentialRampToValueAtTime(kind === 'shot' ? 60 : 35, t0 + spec.dur);
      const og = ctx.createGain(); og.gain.setValueAtTime(kind === 'shot' ? 0.25 : 0.5, t0); og.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
      o.connect(og).connect(pn); o.start(t0); o.stop(t0 + spec.dur + 0.05);
    }
    setTimeout(() => { try { pn.disconnect(); } catch { /* gone */ } }, (spec.dur + 0.5) * 1000);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('hb:ambience', this.onToggle);
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.out?.gain.setTargetAtTime(0, now, 0.15);
    const loops = this.loops; const engines = [...this.engines.values()]; const out = this.out;
    setTimeout(() => { for (const s of loops) { try { s.stop(); } catch { /* stopped */ } } for (const e of engines) { try { e.osc.stop(); e.sub.stop(); } catch { /* stopped */ } } try { out?.disconnect(); } catch { /* gone */ } }, 600);
  }
}
