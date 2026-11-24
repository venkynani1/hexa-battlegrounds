// Original rigged character, built in code (no downloaded assets): one shared skinned geometry,
// a 16-bone skeleton per character, keyframed animation clips (idle, walk, run, jump, free-fall,
// parachute hang, knocked) with cross-fades, an upper-body aim/fire pose, and a cheap LOD proxy.
// Purely visual: it only reads the state the game already decided (speed, airborne, aiming…).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ── skeleton (rest pose, metres; character faces −z, +x is its left… the mesh is symmetric) ──
type BoneDef = { name: string; parent: string | null; at: [number, number, number] };
const BONES: BoneDef[] = [
  { name: 'hips', parent: null, at: [0, 0.95, 0] },
  { name: 'spine', parent: 'hips', at: [0, 1.07, 0] },
  { name: 'chest', parent: 'spine', at: [0, 1.27, 0] },
  { name: 'neck', parent: 'chest', at: [0, 1.5, 0] },
  { name: 'head', parent: 'neck', at: [0, 1.58, 0] },
  { name: 'armL', parent: 'chest', at: [-0.215, 1.44, 0] },
  { name: 'foreL', parent: 'armL', at: [-0.235, 1.16, 0] },
  { name: 'handL', parent: 'foreL', at: [-0.245, 0.92, 0] },
  { name: 'armR', parent: 'chest', at: [0.215, 1.44, 0] },
  { name: 'foreR', parent: 'armR', at: [0.235, 1.16, 0] },
  { name: 'handR', parent: 'foreR', at: [0.245, 0.92, 0] },
  { name: 'legL', parent: 'hips', at: [-0.1, 0.92, 0] },
  { name: 'shinL', parent: 'legL', at: [-0.1, 0.5, 0] },
  { name: 'footL', parent: 'shinL', at: [-0.1, 0.09, 0] },
  { name: 'legR', parent: 'hips', at: [0.1, 0.92, 0] },
  { name: 'shinR', parent: 'legR', at: [0.1, 0.5, 0] },
  { name: 'footR', parent: 'shinR', at: [0.1, 0.09, 0] },
];
const BI: Record<string, number> = Object.fromEntries(BONES.map((b, i) => [b.name, i]));

function buildSkeleton() {
  const bones: THREE.Bone[] = [];
  for (const d of BONES) {
    const b = new THREE.Bone(); b.name = d.name;
    const p = d.parent ? BONES[BI[d.parent]].at : [0, 0, 0];
    b.position.set(d.at[0] - p[0], d.at[1] - p[1], d.at[2] - p[2]);
    if (d.parent) bones[BI[d.parent]].add(b);
    bones.push(b);
  }
  return new THREE.Skeleton(bones);
}

// ── shared geometry: rigid parts with soft blending at the joints ──
const SKIN = new THREE.Color(0xb98159);
const PANTS = new THREE.Color(0x2b3442);
const DARK = new THREE.Color(0x1c1f25);
const VEST = new THREE.Color(0x3d4a33);
const WHITE = new THREE.Color(0xffffff); // jersey: tinted by the squad material

/** part = geometry placed in character space, bound to `bone`; vertices within `blend` of the top joint lean into `parent`. */
function part(geo: THREE.BufferGeometry, at: [number, number, number], bone: string, color: THREE.Color, jersey: boolean, opts: { rotZ?: number; rotX?: number; blendTo?: string; blendY?: number; blendR?: number } = {}) {
  const g = geo.toNonIndexed();
  if (opts.rotX) g.rotateX(opts.rotX);
  if (opts.rotZ) g.rotateZ(opts.rotZ);
  g.translate(at[0], at[1], at[2]);
  const n = g.getAttribute('position').count;
  const pos = g.getAttribute('position');
  const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4); const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let w = 0;
    if (opts.blendTo && opts.blendY !== undefined) {
      const dy = pos.getY(i) - opts.blendY; const r = opts.blendR ?? 0.06;
      if (dy > -r) w = Math.min(0.5, (dy + r) / (2 * r) * 0.5 + (dy > 0 ? 0.25 : 0));
    }
    si[i * 4] = BI[bone]; sw[i * 4] = 1 - w;
    si[i * 4 + 1] = opts.blendTo ? BI[opts.blendTo] : 0; sw[i * 4 + 1] = w;
    col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  g.userData.jersey = jersey;
  return g;
}

let SHARED: { geo: THREE.BufferGeometry; proxy: THREE.BufferGeometry } | null = null;
function sharedGeometry() {
  if (SHARED) return SHARED;
  const cap = (r: number, len: number, seg = 8) => new THREE.CapsuleGeometry(r, len, 3, seg);
  const parts: THREE.BufferGeometry[] = [];
  const jerseyParts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry) => (g.userData.jersey ? jerseyParts : parts).push(g);
  // torso (jersey), pelvis (pants), vest straps
  add(part(cap(0.17, 0.16, 12), [0, 1.13, 0], 'spine', WHITE, true, { blendTo: 'hips', blendY: 1.02, blendR: 0.07 }));
  add(part(cap(0.195, 0.2, 12), [0, 1.34, 0], 'chest', WHITE, true, { blendTo: 'spine', blendY: 1.24, blendR: 0.06 }));
  add(part(cap(0.165, 0.08, 12), [0, 0.95, 0], 'hips', PANTS, false));
  add(part(new THREE.BoxGeometry(0.34, 0.09, 0.27), [0, 0.98, 0], 'hips', DARK, false)); // belt
  add(part(new THREE.CapsuleGeometry(0.13, 0.14, 3, 10).scale(1.15, 1, 0.55), [0, 1.3, 0.19], 'chest', VEST, false)); // backpack
  add(part(new THREE.BoxGeometry(0.05, 0.36, 0.38), [-0.13, 1.33, 0], 'chest', VEST, false, { rotZ: 0.12 })); // pack straps
  add(part(new THREE.BoxGeometry(0.05, 0.36, 0.38), [0.13, 1.33, 0], 'chest', VEST, false, { rotZ: -0.12 }));
  // neck, head, hair, ears
  add(part(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 10), [0, 1.55, 0], 'neck', SKIN, false));
  add(part(new THREE.SphereGeometry(0.115, 16, 12), [0, 1.69, -0.01], 'head', SKIN, false));
  add(part(new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), [0, 1.71, 0.012], 'head', DARK, false, { rotX: -0.25 }));
  for (const sx of [-1, 1]) add(part(new THREE.SphereGeometry(0.016, 8, 6), [sx * 0.042, 1.705, -0.104], 'head', DARK, false)); // eyes
  add(part(new THREE.SphereGeometry(0.02, 8, 6).scale(1, 1.2, 1), [0, 1.67, -0.115], 'head', SKIN, false)); // nose
  // arms: sleeve (jersey), forearm + hand (skin), glove
  for (const [s, a, f, h] of [[-1, 'armL', 'foreL', 'handL'], [1, 'armR', 'foreR', 'handR']] as const) {
    add(part(cap(0.062, 0.2), [s * 0.225, 1.3, 0], a, WHITE, true, { blendTo: 'chest', blendY: 1.42, blendR: 0.05 }));
    add(part(cap(0.052, 0.18), [s * 0.24, 1.04, 0], f, SKIN, false, { blendTo: a, blendY: 1.16, blendR: 0.05 }));
    add(part(new THREE.SphereGeometry(0.055, 10, 8), [s * 0.245, 0.88, 0], h, DARK, false));
  }
  // legs: thigh, shin (pants), boots
  for (const [s, l, sh, ft] of [[-1, 'legL', 'shinL', 'footL'], [1, 'legR', 'shinR', 'footR']] as const) {
    add(part(cap(0.082, 0.3), [s * 0.1, 0.72, 0], l, PANTS, false, { blendTo: 'hips', blendY: 0.9, blendR: 0.06 }));
    add(part(cap(0.066, 0.3), [s * 0.1, 0.3, 0], sh, PANTS, false, { blendTo: l, blendY: 0.5, blendR: 0.06 }));
    add(part(new THREE.BoxGeometry(0.12, 0.1, 0.27), [s * 0.1, 0.05, -0.04], ft, DARK, false));
  }
  const body = mergeGeometries(parts)!; const jersey = mergeGeometries(jerseyParts)!;
  const geo = mergeGeometries([jersey, body], true)!; // group 0 = jersey (squad colour), group 1 = body (vertex colours)
  geo.computeBoundingSphere(); geo.userData.shared = true;
  // far proxy: 3 shapes, no skeleton
  const pb = new THREE.CapsuleGeometry(0.22, 0.75, 2, 8); pb.translate(0, 0.98, 0);
  const ph = new THREE.SphereGeometry(0.13, 8, 6); ph.translate(0, 1.68, 0);
  const proxy = mergeGeometries([pb.toNonIndexed(), ph.toNonIndexed()], true)!; proxy.userData.shared = true;
  SHARED = { geo, proxy };
  return SHARED;
}

const jerseyMats = new Map<string, THREE.MeshStandardMaterial>();
const jerseyMat = (color: string) => {
  let m = jerseyMats.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02 }); m.userData.shared = true; jerseyMats.set(color, m); }
  return m;
};
let bodyMat: THREE.MeshStandardMaterial | null = null;
const getBodyMat = () => { if (!bodyMat) { bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.03 }); bodyMat.userData.shared = true; } return bodyMat; };
let skinMat: THREE.MeshStandardMaterial | null = null;
const getSkinMat = () => { if (!skinMat) { skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.85 }); skinMat.userData.shared = true; } return skinMat; };
let gunMat: THREE.MeshStandardMaterial | null = null;
const getGunMat = () => { if (!gunMat) { gunMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.35, metalness: 0.7 }); gunMat.userData.shared = true; } return gunMat; };

// ── animation clips (built once, shared by every character) ──
type Pose = Partial<Record<string, [number, number, number]>>;
const q = new THREE.Quaternion(); const e = new THREE.Euler();
function clip(name: string, duration: number, keys: { t: number; pose: Pose; hipsY?: number }[], loop = true): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const bones = new Set<string>(); keys.forEach((k) => Object.keys(k.pose).forEach((b) => bones.add(b)));
  for (const b of bones) {
    const times: number[] = []; const vals: number[] = [];
    for (const k of keys) { const r = k.pose[b] || [0, 0, 0]; e.set(r[0], r[1], r[2]); q.setFromEuler(e); times.push(k.t * duration); vals.push(q.x, q.y, q.z, q.w); }
    if (loop) { const r = keys[0].pose[b] || [0, 0, 0]; e.set(r[0], r[1], r[2]); q.setFromEuler(e); times.push(duration); vals.push(q.x, q.y, q.z, q.w); }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, vals));
  }
  if (keys.some((k) => k.hipsY !== undefined)) {
    const times: number[] = []; const vals: number[] = [];
    for (const k of keys) { times.push(k.t * duration); vals.push(0, k.hipsY ?? 0.95, 0); }
    if (loop) { times.push(duration); vals.push(0, keys[0].hipsY ?? 0.95, 0); }
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, vals));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}
/** a two-beat locomotion cycle: amplitude a (legs), arms k, knee bend kn, lean, bob */
function cycle(name: string, dur: number, a: number, arm: number, kn: number, elbow: number, lean: number, bob: number) {
  const P = (s: number, up: boolean): Pose => ({
    legL: [-a * s, 0, 0], legR: [a * s, 0, 0],
    shinL: [up && s > 0 ? kn : kn * 0.25, 0, 0], shinR: [up && s < 0 ? kn : kn * 0.25, 0, 0],
    footL: [s * 0.25, 0, 0], footR: [-s * 0.25, 0, 0],
    armL: [arm * s, 0, -0.08], armR: [-arm * s, 0, 0.08], foreL: [-elbow, 0, 0], foreR: [-elbow, 0, 0],
    spine: [lean, s * 0.06, 0], chest: [lean * 0.5, -s * 0.12, 0], head: [-lean * 0.8, s * 0.05, 0],
  });
  return clip(name, dur, [
    { t: 0, pose: P(1, false), hipsY: 0.95 - bob }, { t: 0.25, pose: P(0, true), hipsY: 0.95 }, // passing: lifted knee
    { t: 0.5, pose: P(-1, false), hipsY: 0.95 - bob }, { t: 0.75, pose: { ...P(0, true), shinR: [kn, 0, 0], shinL: [kn * 0.25, 0, 0] }, hipsY: 0.95 },
  ]);
}
let CLIPS: Record<string, THREE.AnimationClip> | null = null;
function clips() {
  if (CLIPS) return CLIPS;
  const idleA: Pose = { armL: [0.05, 0, -0.1], armR: [0.05, 0, 0.1], foreL: [-0.15, 0, 0], foreR: [-0.15, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] };
  const idleB: Pose = { armL: [0.08, 0, -0.13], armR: [0.03, 0, 0.12], foreL: [-0.2, 0, 0], foreR: [-0.18, 0, 0], chest: [0.035, 0, 0], head: [-0.03, 0.08, 0] };
  CLIPS = {
    idle: clip('idle', 2.6, [{ t: 0, pose: idleA, hipsY: 0.95 }, { t: 0.5, pose: idleB, hipsY: 0.94 }]),
    walk: cycle('walk', 1.05, 0.45, 0.35, 0.55, 0.25, -0.04, 0.025),
    run: cycle('run', 0.66, 0.85, 0.85, 1.35, 1.25, -0.22, 0.05),
    jump: clip('jump', 0.7, [
      { t: 0, pose: { legL: [-0.5, 0, 0], legR: [-0.5, 0, 0], shinL: [1, 0, 0], shinR: [1, 0, 0], armL: [0.6, 0, -0.2], armR: [0.6, 0, 0.2], spine: [-0.25, 0, 0] }, hipsY: 0.78 },
      { t: 0.35, pose: { legL: [-1.1, 0, 0], legR: [-0.7, 0, 0], shinL: [1.6, 0, 0], shinR: [1.1, 0, 0], armL: [-2.4, 0, -0.3], armR: [-2.4, 0, 0.3], spine: [0.05, 0, 0] }, hipsY: 1.0 },
      { t: 1, pose: { legL: [-0.4, 0, 0], legR: [-0.3, 0, 0], shinL: [0.7, 0, 0], shinR: [0.6, 0, 0], armL: [-1.2, 0, -0.5], armR: [-1.2, 0, 0.5] }, hipsY: 0.95 },
    ], false),
    // body is laid flat by the world (rotation of the whole character); here: spread-eagle with flutter
    fall: clip('fall', 1.2, [
      { t: 0, pose: { armL: [-0.3, 0, -1.35], armR: [-0.3, 0, 1.35], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0], legL: [0.25, 0, -0.35], legR: [0.25, 0, 0.35], shinL: [0.7, 0, 0], shinR: [0.7, 0, 0], head: [-0.6, 0, 0] } },
      { t: 0.5, pose: { armL: [-0.2, 0, -1.25], armR: [-0.4, 0, 1.45], foreL: [-0.4, 0, 0], foreR: [-0.6, 0, 0], legL: [0.35, 0, -0.3], legR: [0.2, 0, 0.4], shinL: [0.8, 0, 0], shinR: [0.6, 0, 0], head: [-0.6, 0.1, 0] } },
    ]),
    chute: clip('chute', 3, [
      { t: 0, pose: { armL: [-2.75, 0, -0.25], armR: [-2.75, 0, 0.25], foreL: [-0.35, 0, 0], foreR: [-0.35, 0, 0], legL: [-0.15, 0, -0.05], legR: [0.1, 0, 0.05], shinL: [0.3, 0, 0], shinR: [0.2, 0, 0], head: [0.15, 0, 0] } },
      { t: 0.5, pose: { armL: [-2.6, 0, -0.2], armR: [-2.85, 0, 0.3], foreL: [-0.5, 0, 0], foreR: [-0.25, 0, 0], legL: [0.1, 0, -0.05], legR: [-0.15, 0, 0.05], shinL: [0.2, 0, 0], shinR: [0.35, 0, 0], head: [0.1, 0.15, 0] } },
    ]),
    down: clip('down', 2, [
      { t: 0, pose: { legL: [-1.5, 0, 0], legR: [0.3, 0, 0], shinL: [1.6, 0, 0], shinR: [1.9, 0, 0], spine: [-0.35, 0, 0], armL: [-0.4, 0, -0.2], armR: [-0.8, 0, 0.3], foreR: [-1.2, 0, 0], head: [-0.3, 0, 0] }, hipsY: 0.5 },
      { t: 0.5, pose: { legL: [-1.5, 0, 0], legR: [0.3, 0, 0], shinL: [1.6, 0, 0], shinR: [1.9, 0, 0], spine: [-0.42, 0, 0], armL: [-0.4, 0, -0.2], armR: [-0.85, 0, 0.3], foreR: [-1.3, 0, 0], head: [-0.25, 0, 0] }, hipsY: 0.49 },
    ]),
  };
  return CLIPS;
}

// upper-body aim pose (rifle at shoulder), blended over whatever the legs are doing
const AIM: Pose = { armR: [-1.45, -0.15, 0.05], foreR: [-0.25, 0, 0], armL: [-1.25, 0.55, -0.05], foreL: [-0.55, 0, 0], chest: [0, -0.12, 0], head: [0, 0.1, 0] };
const AIMQ: Record<string, THREE.Quaternion> = Object.fromEntries(Object.entries(AIM).map(([b, r]) => [b, new THREE.Quaternion().setFromEuler(new THREE.Euler(r![0], r![1], r![2]))]));

export type Motion = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'chute' | 'down';

export class Character {
  root = new THREE.Group();
  lod = new THREE.LOD();
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current: Motion = 'idle';
  private aimK = 0;
  private recoil = 0;
  private bones: Record<string, THREE.Bone> = {};
  gun: THREE.Mesh;

  constructor(opts: { color: string; number: number; plate?: THREE.Texture }) {
    const { geo, proxy } = sharedGeometry();
    this.skeleton = buildSkeleton();
    for (const b of this.skeleton.bones) this.bones[b.name] = b;
    this.mesh = new THREE.SkinnedMesh(geo, [jerseyMat(opts.color), getBodyMat()]);
    this.mesh.add(this.skeleton.bones[0]);
    this.mesh.bind(this.skeleton);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // bones move the mesh outside its rest bounds (parachute arms)
    // attachments: rifle in the right hand, number plate on the back
    this.gun = new THREE.Mesh(GUN_GEO(), getGunMat()); this.gun.castShadow = true;
    this.gun.position.set(0, -0.03, -0.18); this.bones.handR.add(this.gun);
    if (opts.plate) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.19), new THREE.MeshBasicMaterial({ map: opts.plate }));
      plate.position.set(0, 0.04, 0.268); this.bones.chest.add(plate);
    }
    const far = new THREE.Mesh(proxy, [jerseyMat(opts.color), getSkinMat()]); far.castShadow = false;
    this.lod.addLevel(this.mesh, 0);
    this.lod.addLevel(far, 70);
    this.root.add(this.lod);
    this.mixer = new THREE.AnimationMixer(this.mesh);
    for (const [k, c] of Object.entries(clips())) {
      const a = this.mixer.clipAction(c);
      if (k === 'jump') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[k] = a;
    }
    this.actions.idle.play();
    this.mixer.update(Math.random() * 2); // de-sync idles
  }

  private go(next: Motion, fade = 0.2) {
    if (next === this.current) return;
    const from = this.actions[this.current]; const to = this.actions[next];
    to.reset(); to.enabled = true; to.setEffectiveWeight(1); to.play();
    if (from) to.crossFadeFrom(from, fade, false);
    this.current = next;
  }

  /** speed in m/s (world units), plus what the game says the character is doing */
  update(dt: number, s: { speed: number; fall?: boolean; chute?: boolean; aiming?: boolean; fired?: boolean; down?: boolean; airborne?: boolean; reduced?: boolean }) {
    const far = this.lod.getCurrentLevel() > 0;
    let want: Motion = 'idle';
    if (s.down) want = 'down';
    else if (s.fall) want = 'fall';
    else if (s.chute) want = 'chute';
    else if (s.airborne) want = 'jump';
    else if (s.speed > 4.2) want = 'run';
    else if (s.speed > 0.35) want = 'walk';
    this.go(want, want === 'chute' ? 0.35 : want === 'fall' ? 0.3 : 0.2);
    // match the stride to the ground speed so feet do not skate
    if (want === 'walk') this.actions.walk.timeScale = THREE.MathUtils.clamp(s.speed / 2.2, 0.6, 1.6);
    if (want === 'run') this.actions.run.timeScale = THREE.MathUtils.clamp(s.speed / 6.5, 0.75, 1.5);
    if (s.reduced) { this.actions.idle.timeScale = 0; }
    if (far) { this.mixer.update(0); return; } // distant: no per-frame skinning work
    this.mixer.update(dt);
    // upper-body aim layer + recoil kick
    const aimWant = s.aiming && !s.fall && !s.chute && !s.down ? 1 : 0;
    this.aimK += (aimWant - this.aimK) * Math.min(1, dt * 10);
    if (s.fired && !s.reduced) this.recoil = 1;
    this.recoil = Math.max(0, this.recoil - dt * 8);
    // rifle: low-ready (barrel down) when moving, raised to the shoulder when aiming; stowed in the air
    this.gun.rotation.x = -(1 - this.aimK) * 1.1;
    this.gun.visible = !s.fall && !s.chute;
    if (this.aimK > 0.01) {
      for (const [b, qa] of Object.entries(AIMQ)) this.bones[b].quaternion.slerp(qa, this.aimK);
      if (this.recoil > 0) { this.bones.armR.rotateX(-0.12 * this.recoil); this.bones.chest.rotateX(0.05 * this.recoil); }
    }
  }

  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.mesh); this.skeleton.dispose(); }
}

let GUN: THREE.BufferGeometry | null = null;
function GUN_GEO() {
  if (GUN) return GUN;
  const body = new THREE.BoxGeometry(0.06, 0.09, 0.5);
  const barrel = new THREE.CylinderGeometry(0.014, 0.014, 0.28, 8); barrel.rotateX(Math.PI / 2); barrel.translate(0, 0.015, -0.38);
  const mag = new THREE.BoxGeometry(0.045, 0.14, 0.07); mag.translate(0, -0.1, -0.05);
  const stock = new THREE.BoxGeometry(0.05, 0.1, 0.16); stock.translate(0, -0.02, 0.3);
  const sight = new THREE.BoxGeometry(0.03, 0.04, 0.1); sight.translate(0, 0.065, 0);
  GUN = mergeGeometries([body, barrel, mag, stock, sight].map((g) => g.toNonIndexed()))!;
  GUN.userData.shared = true;
  return GUN;
}
