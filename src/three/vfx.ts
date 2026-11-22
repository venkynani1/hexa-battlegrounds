// Pooled visual effects. Two particle layers, one draw call each:
//   glow — additive HDR sparks (> 1, so only these trigger bloom);
//   soft — normal-blended dust and smoke (never glows).
// Tracers and muzzle flashes are recycled meshes with shared geometry — nothing is allocated per shot,
// so long matches do not leak. Visual only: effects are spawned from state the game already decided.
import * as THREE from 'three';

const MAX = 1600;

const VERT = /* glsl */ `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vAlpha; varying vec3 vColor;
uniform float uScale;
void main() {
  vAlpha = aAlpha; vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG_GLOW = /* glsl */ `
varying float vAlpha; varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
  if (r > 0.25) discard;
  float a = vAlpha * smoothstep(0.25, 0.0, r);
  gl_FragColor = vec4(vColor * a, a);
}`;
const FRAG_SOFT = /* glsl */ `
varying float vAlpha; varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
  if (r > 0.25) discard;
  gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.25, 0.02, r));
}`;

type Burst = { soft?: boolean; count: number; color: THREE.ColorRepresentation; intensity?: number; speed: number; up?: number; life: number; size: number; gravity?: number; drag?: number; spread?: number; grow?: number };

class Layer {
  points: THREE.Points;
  pos = new Float32Array(MAX * 3); vel = new Float32Array(MAX * 3); col = new Float32Array(MAX * 3);
  size = new Float32Array(MAX); alpha = new Float32Array(MAX); life = new Float32Array(MAX); age = new Float32Array(MAX);
  grav = new Float32Array(MAX); drag = new Float32Array(MAX); grow = new Float32Array(MAX); base = new Float32Array(MAX); peak = new Float32Array(MAX);
  next = 0; live = 0;
  constructor(scene: THREE.Scene, uScale: { value: number }, glow: boolean) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: glow ? FRAG_GLOW : FRAG_SOFT, uniforms: { uScale }, transparent: true, depthWrite: false,
      blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; this.points.renderOrder = glow ? 6 : 5;
    scene.add(this.points);
  }
  spawn(p: THREE.Vector3, v: THREE.Vector3, c: THREE.Color, size: number, life: number, gravity: number, drag: number, grow: number, peak = 1) {
    const i = this.next; this.next = (this.next + 1) % MAX;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.base[i] = size; this.size[i] = size; this.life[i] = life; this.age[i] = 0; this.alpha[i] = peak; this.peak[i] = peak;
    this.grav[i] = gravity; this.drag[i] = drag; this.grow[i] = grow;
    this.live = Math.max(this.live, i + 1);
  }
  update(dt: number) {
    let maxLive = 0;
    for (let i = 0; i < this.live; i++) {
      if (this.alpha[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= dr; this.vel[i * 3 + 2] *= dr; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr + this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.peak[i] * (1 - t) * (t < 0.1 ? t * 10 : 1);
      this.size[i] = this.base[i] * (1 + this.grow[i] * t);
      maxLive = i + 1;
    }
    this.live = maxLive;
    const g = this.points.geometry;
    g.setDrawRange(0, this.live);
    this.points.visible = this.live > 0;
    if (!this.live) return;
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) {
      const at = g.getAttribute(name) as THREE.BufferAttribute;
      at.clearUpdateRanges(); at.addUpdateRange(0, this.live * at.itemSize); at.needsUpdate = true;
    }
  }
  dispose(scene: THREE.Scene) { scene.remove(this.points); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

const UP = new THREE.Vector3(0, 1, 0);

export class VFX {
  private glow: Layer;
  private soft: Layer;
  private uScale = { value: 300 };
  private tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  private flashGeo = new THREE.SphereGeometry(1, 8, 6);
  private pool: { tracer: THREE.Mesh; flash: THREE.Mesh; t0: number; dur: number; busy: boolean }[] = [];
  private emitters = new Map<string, { p: THREE.Vector3; acc: number; rate: number; kind: 'smoke' | 'flare' }>();
  private v = new THREE.Vector3();
  private c = new THREE.Color();
  /** 0..1 from the quality preset (reduced motion caps it) */
  density = 1;

  constructor(private scene: THREE.Scene) {
    this.soft = new Layer(scene, this.uScale, false);
    this.glow = new Layer(scene, this.uScale, true);
    const tracerC = new THREE.Color(1, 0.85, 0.45).multiplyScalar(3);
    const flashC = new THREE.Color(1, 0.9, 0.6).multiplyScalar(2.6);
    for (let i = 0; i < 12; i++) {
      const tm = new THREE.MeshBasicMaterial({ color: tracerC, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const fm = new THREE.MeshBasicMaterial({ color: flashC, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const tracer = new THREE.Mesh(this.tracerGeo, tm); const flash = new THREE.Mesh(this.flashGeo, fm);
      tracer.visible = flash.visible = false; tracer.frustumCulled = flash.frustumCulled = false;
      scene.add(tracer, flash);
      this.pool.push({ tracer, flash, t0: 0, dur: 0, busy: false });
    }
  }

  /** drawing-buffer height in px and camera fov: keeps particle sizes in metres on every screen */
  setViewport(h: number, fovDeg: number) { this.uScale.value = h / (2 * Math.tan((fovDeg * Math.PI) / 360)); }

  burst(at: THREE.Vector3, b: Burst) {
    const n = Math.round(b.count * this.density);
    if (n <= 0) return;
    this.c.set(b.color).multiplyScalar(b.intensity ?? 1);
    const L = b.soft ? this.soft : this.glow;
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2; const ph = (Math.random() - 0.5) * (b.spread ?? Math.PI);
      const sp = b.speed * (0.4 + Math.random() * 0.8);
      this.v.set(Math.cos(th) * Math.cos(ph) * sp, Math.abs(Math.sin(ph)) * sp + (b.up ?? 0) * (0.6 + Math.random() * 0.8), Math.sin(th) * Math.cos(ph) * sp);
      L.spawn(at, this.v, this.c, b.size * (0.7 + Math.random() * 0.6), b.life * (0.7 + Math.random() * 0.6), b.gravity ?? 0, b.drag ?? 1.5, b.grow ?? 0, b.soft ? 0.75 : 1);
    }
  }

  /** gunshot: muzzle flash, tracer, and sparks (hit) or a dust puff (miss) */
  shot(a: THREE.Vector3, b: THREE.Vector3, hit: boolean) {
    const s = this.pool.find((x) => !x.busy) || this.pool.reduce((o, x) => (x.t0 < o.t0 ? x : o));
    s.busy = true; s.t0 = performance.now(); s.dur = 160;
    const len = a.distanceTo(b);
    s.tracer.position.copy(a).add(b).multiplyScalar(0.5);
    s.tracer.quaternion.setFromUnitVectors(UP, this.v.copy(b).sub(a).normalize());
    s.tracer.scale.set(0.045, len, 0.045); s.tracer.visible = true;
    s.flash.position.copy(a); s.flash.scale.setScalar(0.2); s.flash.visible = true;
    this.burst(a, { count: 5, color: 0xffd27a, intensity: 2.4, speed: 3, life: 0.1, size: 0.25 });
    if (hit) {
      this.burst(b, { count: 22, color: 0xff6a3d, intensity: 3.2, speed: 7, up: 2, life: 0.35, size: 0.28, gravity: -14, drag: 2 });
      this.burst(b, { count: 4, color: 0xffffff, intensity: 2, speed: 2, life: 0.12, size: 0.5 });
    } else {
      this.burst(b, { soft: true, count: 10, color: 0xb9ab94, intensity: 0.85, speed: 1.6, up: 1.2, life: 0.8, size: 0.7, gravity: -1, drag: 2.5, grow: 1.4 });
    }
  }
  /** touchdown: a ring of dust */
  landing(at: THREE.Vector3) {
    const n = Math.round(28 * this.density);
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      this.v.set(Math.cos(th) * 5, 0.8 + Math.random(), Math.sin(th) * 5);
      this.soft.spawn(at, this.v, this.c.setRGB(0.62, 0.57, 0.49), 1.1, 0.9 + Math.random() * 0.4, -1.5, 3, 1.6, 0.7);
    }
  }
  /** loot crate pops open: sparkle fountain in the tier colour */
  loot(at: THREE.Vector3, tier: number = 0xffc23d) {
    this.burst(at, { count: 30, color: tier, intensity: 2.6, speed: 2.5, up: 6, life: 1.0, size: 0.3, gravity: -9, drag: 1 });
    this.burst(at, { count: 5, color: 0xffffff, intensity: 1.6, speed: 1, up: 2, life: 0.35, size: 0.7 });
  }
  /** knocked down (red) or back on their feet (cyan) */
  pulse(at: THREE.Vector3, color: number) {
    this.burst(at, { count: 36, color, intensity: 2.4, speed: 5, up: 1, life: 0.6, size: 0.35, drag: 3, spread: 0.4 });
  }
  /** continuous emitters (airdrop smoke columns, flares), keyed so they can be removed */
  setEmitter(key: string, p: THREE.Vector3 | null, kind: 'smoke' | 'flare' = 'smoke') {
    if (!p) { this.emitters.delete(key); return; }
    const e = this.emitters.get(key);
    if (e) e.p.copy(p); else this.emitters.set(key, { p: p.clone(), acc: 0, rate: kind === 'smoke' ? 12 : 30, kind });
  }

  update(dt: number, now = performance.now()) {
    for (const s of this.pool) {
      if (!s.busy) continue;
      const k = (now - s.t0) / s.dur;
      if (k >= 1) { s.busy = false; s.tracer.visible = s.flash.visible = false; continue; }
      (s.tracer.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      (s.flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k * 2.5);
      s.flash.scale.setScalar(0.2 + k * 0.25);
    }
    for (const e of this.emitters.values()) {
      e.acc += dt * e.rate * this.density;
      while (e.acc >= 1) {
        e.acc -= 1;
        if (e.kind === 'smoke') {
          this.v.set((Math.random() - 0.5) * 0.8, 4 + Math.random() * 2, (Math.random() - 0.5) * 0.8);
          this.soft.spawn(e.p, this.v, this.c.setRGB(0.85, 0.22, 0.38), 1.3, 3.4, 0.2, 0.4, 2.4, 0.55); // pink signal smoke
        } else {
          this.v.set((Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2);
          this.glow.spawn(e.p, this.v, this.c.setRGB(3, 1.6, 0.4), 0.35, 0.8, -3, 1, 0);
        }
      }
    }
    this.glow.update(dt); this.soft.update(dt);
  }

  dispose() {
    this.glow.dispose(this.scene); this.soft.dispose(this.scene);
    for (const s of this.pool) { this.scene.remove(s.tracer, s.flash); (s.tracer.material as THREE.Material).dispose(); (s.flash.material as THREE.Material).dispose(); }
    this.tracerGeo.dispose(); this.flashGeo.dispose();
  }
}

/** Safe-zone wall: brighter (HDR, so it blooms) where it meets the ground, scrolling scan bands and a cell shimmer.
 *  Pass a shared { value: seconds } so the owner can animate it (or freeze it for reduced motion). */
export function zoneWallMaterial(time: { value: number }) {
  return new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
      uniforms: { uTime: time, uRepeat: { value: 40 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uTime; uniform float uRepeat; varying vec2 vUv;
        void main(){
          float h = vUv.y;                                   // 0 = ground, 1 = top
          vec2 p = vec2(vUv.x * uRepeat * 6.0, h * 18.0);
          vec2 q = vec2(p.x + 0.5 * floor(p.y), p.y);        // offset rows: hexagon-ish cells
          vec2 f = abs(fract(q) - 0.5);
          float cell = smoothstep(0.42, 0.5, max(f.x, f.y));
          float band = smoothstep(0.0, 0.08, fract(h * 4.0 - uTime * 0.25)) * (1.0 - smoothstep(0.08, 0.2, fract(h * 4.0 - uTime * 0.25)));
          float fade = 1.0 - smoothstep(0.0, 0.9, h);
          vec3 base = vec3(0.32, 0.62, 1.0);
          vec3 col = base * (0.45 + 0.6 * cell + 0.7 * band) + vec3(0.5, 0.8, 1.5) * pow(1.0 - h, 24.0) * 1.4;
          float a = clamp(fade * (0.08 + 0.22 * cell + 0.28 * band) + pow(1.0 - h, 14.0) * 0.55, 0.0, 0.75);
          gl_FragColor = vec4(col, a);
        }`,
  });
}
