// Original sound effects synthesised with the Web Audio API — no audio files,
// nothing licensed. Audio starts only after the player taps (browser policy).
import { store } from './api';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = store.get('hb_muted') === '1';
let volume = Number(store.get('hb_volume') ?? '0.6');

export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx!.createGain();
      master.gain.value = muted ? 0 : volume * 0.5;
      master.connect(ctx!.destination);
    }
    if (ctx!.state === 'suspended') ctx!.resume();
  } catch { /* audio unavailable */ }
}

export const audioReady = () => !!ctx && ctx.state === 'running';
export const isMuted = () => muted;
export const getVolume = () => volume;

export function setMuted(m: boolean) {
  muted = m;
  store.set('hb_muted', m ? '1' : '0');
  if (master) master.gain.value = m ? 0 : volume * 0.5;
}
export function setVolume(v: number) {
  volume = v;
  store.set('hb_volume', String(v));
  if (master && !muted) master.gain.value = v * 0.5;
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; at?: number; gain?: number; to?: number } = {}) {
  if (!ctx || !master || muted) return;
  const t0 = ctx.currentTime + (opts.at || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.25, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise(dur: number, { at = 0, gain = 0.15, filter = 800 } = {}) {
  if (!ctx || !master || muted) return;
  const t0 = ctx.currentTime + at;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = filter;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
}

export const sfx = {
  tap: () => tone(660, 0.06, { type: 'triangle', gain: 0.12 }),
  success: () => { tone(523, 0.12, { type: 'triangle' }); tone(659, 0.12, { type: 'triangle', at: 0.1 }); tone(988, 0.25, { type: 'triangle', at: 0.2 }); },
  fail: () => { tone(220, 0.18, { type: 'sawtooth', gain: 0.12 }); tone(160, 0.3, { type: 'sawtooth', at: 0.15, gain: 0.12 }); },
  mission: () => { tone(392, 0.1, { type: 'square', gain: 0.08 }); tone(784, 0.18, { type: 'square', at: 0.1, gain: 0.08 }); },
  loot: () => { [0, 0.07, 0.14, 0.21].forEach((at, i) => tone(700 + i * 180, 0.12, { type: 'triangle', at, gain: 0.12 })); },
  enemy: () => { tone(880, 0.15, { type: 'square', gain: 0.1 }); tone(880, 0.15, { type: 'square', at: 0.25, gain: 0.1 }); },
  weapon: () => { noise(0.25, { gain: 0.2, filter: 2400 }); tone(140, 0.25, { type: 'sawtooth', to: 60, gain: 0.15 }); },
  damage: () => { noise(0.35, { gain: 0.25, filter: 600 }); tone(110, 0.35, { type: 'sawtooth', to: 55, gain: 0.12 }); },
  airdrop: () => { tone(300, 0.8, { type: 'sine', to: 900, gain: 0.12 }); tone(1200, 0.2, { type: 'triangle', at: 0.8, gain: 0.1 }); },
  zone: () => { tone(500, 0.5, { type: 'sawtooth', to: 900, gain: 0.08 }); tone(900, 0.5, { type: 'sawtooth', at: 0.5, to: 500, gain: 0.08 }); },
  tick: () => tone(1000, 0.05, { type: 'square', gain: 0.06 }),
  go: () => tone(1400, 0.35, { type: 'square', gain: 0.1 }),
  shuttle: () => { noise(2.5, { gain: 0.12, filter: 300 }); tone(70, 2.5, { type: 'sawtooth', to: 110, gain: 0.06 }); },
  gate: () => { tone(330, 0.2, { type: 'triangle' }); tone(495, 0.4, { type: 'triangle', at: 0.18 }); },
  transmission: () => { for (let i = 0; i < 6; i++) tone(200 + Math.random() * 1200, 0.05, { type: 'square', at: i * 0.06, gain: 0.06 }); noise(0.4, { at: 0.35, gain: 0.08, filter: 3000 }); },
  reveal: () => {
    const notes = [392, 523, 659, 784, 1047];
    notes.forEach((f, i) => tone(f, 0.35, { type: 'triangle', at: i * 0.14, gain: 0.16 }));
    tone(1047, 1.2, { type: 'sine', at: 0.75, gain: 0.12 });
  },
};

// Simple vibration helper for phones (no-op where unsupported).
export function buzz(pattern: number | number[]) {
  try { if (!muted) navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
