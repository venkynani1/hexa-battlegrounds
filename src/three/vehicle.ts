// Squad buggy: one compact all-terrain buggy per squad, painted in the squad's colour with its
// number on the roof. Original low-poly design; replaces the four-person squads so 15 squads fit
// on one screen without clutter.
import * as THREE from 'three';
import { Baker, shared, sharedMat } from './bake';

// Body side profile (z = length, y = height), extruded across the width with rounded edges.
function bodyGeo() {
  const sh = new THREE.Shape();
  const pts: [number, number][] = [[-2.12, 0.5], [-2.18, 0.78], [-1.95, 0.98], [-0.95, 1.1], [-0.72, 1.16], [-0.6, 0.98], [0.55, 0.98], [0.7, 1.2],
    [1.55, 1.2], [1.78, 0.95], [1.72, 0.5], [1.1, 0.42], [-1.5, 0.42]];
  sh.moveTo(pts[0][0], pts[0][1]);
  for (const [z, y] of pts.slice(1)) sh.lineTo(z, y);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.07, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -0.75);      // centre across the width
  g.rotateY(-Math.PI / 2);       // shape x → world z (length), extrusion → world x (width)
  g.computeVertexNormals();
  return g;
}

const G = {
  body: bodyGeo(),
  grille: new THREE.BoxGeometry(1.1, 0.26, 0.06),
  skid: new THREE.BoxGeometry(1.5, 0.08, 3.5),
  seat: new THREE.BoxGeometry(0.52, 0.16, 0.56),
  seatBack: new THREE.BoxGeometry(0.52, 0.62, 0.14),
  dash: new THREE.BoxGeometry(1.4, 0.2, 0.22),
  wheelRing: new THREE.TorusGeometry(0.16, 0.022, 6, 14),
  glass: new THREE.PlaneGeometry(1.42, 0.62),
  bar: new THREE.CylinderGeometry(0.05, 0.05, 1, 8),
  tyre: new THREE.TorusGeometry(0.33, 0.17, 10, 22).rotateY(Math.PI / 2),
  rim: new THREE.CylinderGeometry(0.24, 0.24, 0.26, 14).rotateZ(Math.PI / 2),
  spoke: new THREE.BoxGeometry(0.28, 0.07, 0.44),
  arch: new THREE.TorusGeometry(0.6, 0.085, 6, 12, Math.PI).rotateY(Math.PI / 2),
  lamp: new THREE.CylinderGeometry(0.13, 0.15, 0.1, 12).rotateX(Math.PI / 2),
  tail: new THREE.BoxGeometry(0.26, 0.12, 0.06),
  bumper: new THREE.CylinderGeometry(0.07, 0.07, 1.85, 8).rotateZ(Math.PI / 2),
  spare: new THREE.TorusGeometry(0.3, 0.15, 8, 18),
  jerry: new THREE.BoxGeometry(0.3, 0.42, 0.18),
  pole: new THREE.CylinderGeometry(0.02, 0.025, 1.5, 5),
  flag: new THREE.PlaneGeometry(0.5, 0.32),
  roof: new THREE.BoxGeometry(1.45, 0.06, 1.5),
  shadow: new THREE.CircleGeometry(1.6, 20),
};

const plateCache = new Map<string, THREE.Texture>();
function plate(number: number, color: string) {
  const key = `${number}|${color}`;
  let t = plateCache.get(key);
  if (!t) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = color; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 10; g.strokeRect(5, 5, 118, 118);
    g.fillStyle = '#0b1220'; g.font = '900 84px Rajdhani, "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(number), 64, 70);
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    plateCache.set(key, t);
  }
  return t;
}

export type Vehicle = THREE.Group & { userData: { wheels: THREE.Object3D[]; steer: THREE.Object3D[]; body: THREE.Object3D; flag: THREE.Mesh; spin: number; detail: THREE.Object3D[]; near: boolean } };

// ── baked parts: every buggy shares the same merged geometry; only the paint and the roof plate differ.
// One buggy used to be ~45 meshes (≈90 draw calls with shadows); now it is 12.
const MATTE = 'matte'; const METAL = 'metal'; const PAINT = 'paint';
const VC = {
  matte: sharedMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 })),
  metal: sharedMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.8 })),
  glass: sharedMat(new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.6, side: THREE.DoubleSide })),
  head: sharedMat(new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 1.6 })),
  tail: sharedMat(new THREE.MeshStandardMaterial({ color: 0xff2a3a, emissive: 0xff2a3a, emissiveIntensity: 1.3 })),
  shadow: sharedMat(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })),
};

let BAKED: { body: Record<string, THREE.BufferGeometry>; wheel: THREE.BufferGeometry; plate: THREE.BufferGeometry; flag: THREE.BufferGeometry; shadow: THREE.BufferGeometry } | null = null;
function baked() {
  if (BAKED) return BAKED;
  const b = new Baker();
  const DARK = 0x1b2028; const CAGE = 0x2b2f36; const CHROME = 0xc9ced6; const TYRE = 0x15171b;
  b.add(PAINT, G.body, 0xffffff, [0, 0, 0]);
  b.add(MATTE, G.skid, DARK, [0, 0.4, -0.15]);
  b.add(MATTE, G.grille, DARK, [0, 0.74, -2.2]);
  for (const sx of [-0.4, 0.4]) { b.add(MATTE, G.seat, DARK, [sx, 1.02, 0.1]); b.add(MATTE, G.seatBack, DARK, [sx, 1.38, 0.42], [0.14, 0, 0]); }
  b.add(MATTE, G.dash, DARK, [0, 1.14, -0.66]);
  b.add(METAL, G.wheelRing, CAGE, [-0.4, 1.3, -0.45], [-0.5, 0, 0]);
  const bars: [number, number, number, number, number, number][] = [
    [-0.72, 1.14, -0.75, -0.64, 2.15, -0.1], [0.72, 1.14, -0.75, 0.64, 2.15, -0.1],
    [-0.72, 1.18, 0.95, -0.64, 2.15, 0.7], [0.72, 1.18, 0.95, 0.64, 2.15, 0.7],
    [-0.64, 2.15, -0.1, 0.64, 2.15, -0.1], [-0.64, 2.15, 0.7, 0.64, 2.15, 0.7],
    [-0.64, 2.15, -0.1, -0.64, 2.15, 0.7], [0.64, 2.15, -0.1, 0.64, 2.15, 0.7],
  ];
  for (const [x0, y0, z0, x1, y1, z1] of bars) {
    const A = new THREE.Vector3(x0, y0, z0); const B = new THREE.Vector3(x1, y1, z1);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    b.add(METAL, G.bar, CAGE, [mid.x, mid.y, mid.z], undefined, [1, A.distanceTo(B), 1], q);
  }
  b.add(PAINT, G.roof, 0xffffff, [0, 2.2, 0.38]);
  for (const y of [0.56, 0.8]) b.add(METAL, G.bumper, CAGE, [0, y, -2.32]);
  b.add(METAL, G.bumper, CAGE, [0, 0.56, 1.86]);
  for (const sx of [-0.58, 0.58]) {
    b.add('head', G.lamp, 0xffffff, [sx, 0.86, -2.2]);
    b.add(METAL, G.wheelRing, CHROME, [sx, 0.86, -2.25]);
    b.add('tail', G.tail, 0xffffff, [sx, 1.02, 1.84]);
  }
  b.add(MATTE, G.spare, TYRE, [0, 1.02, 1.93]);
  b.add(MATTE, G.jerry, 0x7a1f1f, [0.52, 1.44, 1.35]);
  b.add(METAL, G.pole, CAGE, [0.62, 2.9, 0.75]);
  b.add('glass', G.glass, 0xffffff, [0, 1.5, -0.84], [-0.32, 0, 0]);
  for (const [x, z] of [[-0.95, -1.3], [0.95, -1.3], [-0.95, 1.15], [0.95, 1.15]]) b.add(MATTE, G.arch, DARK, [x * 0.98, 0.5, z], [0, 0, 0], [2.6, 1, 1]);
  const body = b.build();
  // one wheel: tyre, rim and three spokes in a single mesh
  const w = new Baker();
  w.add('w', G.tyre, TYRE, [0, 0, 0]); w.add('w', G.rim, 0x9aa1ab, [0, 0, 0]);
  for (let k = 0; k < 3; k++) w.add('w', G.spoke, CAGE, [0, 0, 0], [(k / 3) * Math.PI, 0, 0], [1.02, 1, 1]);
  const wheel = w.build().w;
  const plateGeo = shared(new THREE.PlaneGeometry(1.4, 1.45).rotateX(-Math.PI / 2).translate(0, 2.234, 0.38));
  const flagGeo = shared(G.flag.clone().translate(0.25, 0, 0)); // hinged at the pole
  const shadowGeo = shared(G.shadow.clone().rotateX(-Math.PI / 2).scale(0.75, 1, 1.15).translate(0, 0.04, 0));
  BAKED = { body, wheel, plate: plateGeo, flag: flagGeo, shadow: shadowGeo };
  return BAKED;
}

const plateMats = new Map<string, THREE.Material>();
function plateMat(n: number, color: string) {
  const k = `${n}|${color}`; let m = plateMats.get(k);
  if (!m) { m = sharedMat(new THREE.MeshStandardMaterial({ map: plate(n, color), roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1 })); plateMats.set(k, m); }
  return m;
}
const paintMats = new Map<string, THREE.Material>();
function paintMat(color: string) {
  let m = paintMats.get(color);
  if (!m) { m = sharedMat(new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.45 })); paintMats.set(color, m); }
  return m;
}
const flagMats = new Map<string, THREE.Material>();
function flagMat(color: string) {
  let m = flagMats.get(color);
  if (!m) { m = sharedMat(new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide })); flagMats.set(color, m); }
  return m;
}

export function makeVehicle(opts: { color: string; number: number; dim?: boolean }): Vehicle {
  const B = baked();
  const v = new THREE.Group() as Vehicle;
  const body = new THREE.Group();
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, shadow = true) => { const x = new THREE.Mesh(g, m); x.castShadow = shadow; x.receiveShadow = true; body.add(x); return x; };
  mesh(B.body[PAINT], paintMat(opts.color));
  const matte = mesh(B.body[MATTE], VC.matte);
  const metal = mesh(B.body[METAL], VC.metal);
  const glass = mesh(B.body.glass, VC.glass, false);
  const head = mesh(B.body.head, VC.head, false);
  const tail = mesh(B.body.tail, VC.tail, false);
  const plateM = mesh(B.plate, plateMat(opts.number, opts.color), false);
  const flag = new THREE.Mesh(B.flag, flagMat(opts.color)); flag.position.set(0.62, 3.45, 0.75); body.add(flag);
  v.add(body);
  const wheels: THREE.Object3D[] = []; const steer: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.95, -1.3], [0.95, -1.3], [-0.95, 1.15], [0.95, 1.15]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.5, z);
    const w = new THREE.Mesh(B.wheel, VC.matte); w.castShadow = true;
    pivot.add(w); v.add(pivot);
    wheels.push(w);
    if (z < 0) steer.push(pivot);
  }
  const sh = new THREE.Mesh(B.shadow, VC.shadow); v.add(sh);
  v.userData = { wheels, steer, body, flag, spin: 0, detail: [matte, metal, glass, head, tail, plateM, flag], near: true };
  return v;
}

/** far away a buggy keeps only its painted shell and wheels (5 meshes instead of 12) */
export function setVehicleDetail(v: Vehicle, near: boolean) {
  if (v.userData.near === near) return;
  v.userData.near = near;
  for (const o of v.userData.detail) o.visible = near;
  for (const w of v.userData.wheels) (w as THREE.Mesh).castShadow = near;
}

/** Wheel spin, steering and suspension bob. speed in world units / s, turn in rad / s. */
export function animateVehicle(v: Vehicle, t: number, dt: number, speed: number, turn: number, down: boolean) {
  const u = v.userData;
  u.spin += (speed * dt) / 0.5;
  for (const w of u.wheels) w.rotation.x = -u.spin;
  const st = Math.max(-0.5, Math.min(0.5, turn * 0.35));
  for (const s of u.steer) s.rotation.y += (st - s.rotation.y) * Math.min(1, dt * 8);
  const bob = speed > 0.3 ? Math.sin(t * 18) * 0.025 : 0;
  u.body.position.y = bob;
  u.body.rotation.z += ((down ? 0.18 : -st * 0.12) - u.body.rotation.z) * Math.min(1, dt * 5);
  u.body.rotation.x += ((speed > 0.3 ? 0.03 : 0) - u.body.rotation.x) * Math.min(1, dt * 4);
  u.flag.rotation.y = Math.sin(t * 6 + speed) * 0.25 * (0.3 + Math.min(1, speed / 6));
}
