// Device-aware graphics quality: Low / Balanced / High presets, automatic choice, adaptive resolution
// and a frame-time monitor. Purely visual — nothing here touches game state, scoring or the network.
import * as THREE from 'three';
import { store } from '../lib/api';

export type Quality = 'low' | 'balanced' | 'high';
export type QualityChoice = Quality | 'auto';

export type Preset = {
  /** device-pixel-ratio ceiling; adaptive resolution moves between minScale×this and this */
  maxDpr: number;
  minScale: number;
  antialias: boolean;
  shadows: boolean;
  shadowSize: number;
  bloom: boolean;
  /** bloom buffer size relative to the canvas */
  bloomScale: number;
  fogFar: number;
  /** 0..1 multiplier for particle counts (VFX) */
  particles: number;
  /** fraction of decorative instanced props (trees, shrubs) drawn */
  decor: number;
  /** frame budget the adaptive resolution aims for, in ms */
  budgetMs: number;
};

export const PRESETS: Record<Quality, Preset> = {
  low: { maxDpr: 1, minScale: 0.6, antialias: false, shadows: false, shadowSize: 0, bloom: false, bloomScale: 0, fogFar: 1000, particles: 0.35, decor: 0.55, budgetMs: 33 },
  balanced: { maxDpr: 1.5, minScale: 0.65, antialias: false, shadows: true, shadowSize: 1024, bloom: true, bloomScale: 0.4, fogFar: 1350, particles: 0.7, decor: 0.85, budgetMs: 22 },
  high: { maxDpr: 2, minScale: 0.7, antialias: true, shadows: true, shadowSize: 2048, bloom: true, bloomScale: 0.5, fogFar: 1500, particles: 1, decor: 1, budgetMs: 17 },
};

export const QUALITY_LABEL: Record<QualityChoice, string> = { auto: 'Auto (recommended)', low: 'Low — smoothest', balanced: 'Balanced', high: 'High — best looking' };

let gpuName = '';
/** The GPU's name, when the browser shares it (used only to pick a sensible default). */
export function gpu(): string {
  if (gpuName) return gpuName;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpuName = String((ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl?.getParameter(gl.RENDERER) || '');
    (gl?.getExtension('WEBGL_lose_context') as any)?.loseContext?.();
  } catch { gpuName = ''; }
  return gpuName;
}

/** Best guess for this device. Mid-range Android → Balanced, old/weak devices → Low, desktops → High. */
export function detectQuality(): Quality {
  const nav = navigator as any;
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory || 4;
  const mobile = /Android|iPhone|iPad|Mobi/i.test(nav.userAgent || '') || matchMedia('(pointer: coarse)').matches;
  const g = gpu().toLowerCase();
  if (/swiftshader|llvmpipe|software|mali-4|mali-t|adreno \(tm\) [1-4]\d\d|powervr|sgx/.test(g)) return 'low';
  if (mem <= 2 || cores <= 2) return 'low';
  if (mobile) {
    if (/apple gpu/.test(g) && mem >= 4) return 'balanced';
    if (/adreno \(tm\) (7\d\d|6[4-9]\d)|mali-g7[1-9]|mali-g7\d\d|immortalis|xclipse/.test(g)) return 'balanced';
    return cores >= 8 && mem >= 6 ? 'balanced' : 'low';
  }
  if (/intel.*(hd|uhd) graphics [2-6]\d\d\b/.test(g) || cores <= 4) return 'balanced';
  return 'high';
}

export function qualityChoice(): QualityChoice {
  const v = store.get('hb_quality');
  return v === 'low' || v === 'balanced' || v === 'high' ? v : 'auto';
}
export function currentQuality(): Quality {
  const c = qualityChoice();
  return c === 'auto' ? detectQuality() : c;
}
export function setQualityChoice(c: QualityChoice) {
  store.set('hb_quality', c);
  window.dispatchEvent(new CustomEvent('hb:quality', { detail: c === 'auto' ? detectQuality() : c }));
}
export const showFps = () => store.get('hb_fps') === '1';
export function setShowFps(on: boolean) { store.set('hb_fps', on ? '1' : '0'); window.dispatchEvent(new CustomEvent('hb:fps', { detail: on })); }
export const reducedMotion = () => document.documentElement.classList.contains('reduced-motion');

/** Rolling frame-time statistics (last ~2 s). */
export class FrameMonitor {
  private buf: number[] = [];
  private i = 0;
  constructor(private size = 120) {}
  push(ms: number) { if (this.buf.length < this.size) this.buf.push(ms); else { this.buf[this.i] = ms; this.i = (this.i + 1) % this.size; } }
  get count() { return this.buf.length; }
  pct(p: number) { if (!this.buf.length) return 0; const s = [...this.buf].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
  get fps() { if (!this.buf.length) return 0; const avg = this.buf.reduce((a, b) => a + b, 0) / this.buf.length; return 1000 / Math.max(1, avg); }
  reset() { this.buf = []; this.i = 0; }
}

/**
 * Adaptive resolution: lowers the render scale when frames run over budget, raises it again when there is
 * headroom. Changes at most once a second, in small steps, so it never "pumps".
 */
export class AdaptiveResolution {
  scale = 1;
  private last = 0;
  private calm = 0;
  constructor(private apply: (scale: number) => void) {}
  update(mon: FrameMonitor, p: Preset, now: number) {
    if (mon.count < 60 || now - this.last < 1000) return;
    this.last = now;
    const p90 = mon.pct(0.9);
    let s = this.scale;
    if (p90 > p.budgetMs * 1.15) { s = Math.max(p.minScale, s - 0.08); this.calm = 0; }
    else if (p90 < p.budgetMs * 0.7) { this.calm++; if (this.calm >= 3) { s = Math.min(1, s + 0.05); this.calm = 0; } }
    else this.calm = 0;
    if (Math.abs(s - this.scale) > 0.001) { this.scale = s; this.apply(s); mon.reset(); }
  }
}

/** Small corner readout: fps, 95th-percentile frame time, render scale, quality. */
export class FpsOverlay {
  el: HTMLDivElement;
  private t = 0;
  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'fps-overlay';
    this.el.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.el);
  }
  update(mon: FrameMonitor, scale: number, q: Quality, info: THREE.WebGLInfo, now: number) {
    if (now - this.t < 500) return; this.t = now;
    this.el.textContent = `${Math.round(mon.fps)} fps · p95 ${mon.pct(0.95).toFixed(1)} ms · ${Math.round(scale * 100)}% · ${q} · ${info.render.calls} draws`;
  }
  dispose() { this.el.remove(); }
}

/** Dispose everything a subtree owns (geometries, materials, their textures). Shared resources marked userData.shared are kept. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (m.userData?.shared) continue;
      for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap']) m[k]?.dispose?.();
      m.dispose?.();
    }
  });
}
