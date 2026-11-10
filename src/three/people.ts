// Captain on foot, parachute, the drop plane and gun tracers. Built from primitives (no assets).
// Scale: 1 world unit ≈ 1 m (a buggy is ~4.5 long, a person 1.8 tall).
import * as THREE from 'three';

const mat = (c: THREE.ColorRepresentation, o: { rough?: number; metal?: number; emissive?: number; ei?: number } = {}) =>
  new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.7, metalness: o.metal ?? 0.05, emissive: o.emissive ?? 0x000000, emissiveIntensity: o.ei ?? 0 });

const G = {
  torso: new THREE.CapsuleGeometry(0.26, 0.5, 4, 10),
  head: new THREE.SphereGeometry(0.17, 14, 10),
  hair: new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
  limb: new THREE.CapsuleGeometry(0.08, 0.5, 3, 8),
  leg: new THREE.CapsuleGeometry(0.1, 0.62, 3, 8),
  shoe: new THREE.BoxGeometry(0.16, 0.1, 0.3),
  pack: new THREE.BoxGeometry(0.42, 0.5, 0.2),
  gun: new THREE.BoxGeometry(0.08, 0.1, 0.55),
  plate: new THREE.PlaneGeometry(0.34, 0.24),
};

const plateCache = new Map<string, THREE.Texture>();
function numberTex(n: number, color: string) {
  const key = `${n}|${color}`;
  let t = plateCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = color; g.fillRect(0, 0, 64, 48);
  g.fillStyle = '#ffffff'; g.font = '900 34px Rajdhani, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 32, 26);
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  plateCache.set(key, t);
  return t;
}

export type Avatar = THREE.Group & { userData: { armL: THREE.Object3D; armR: THREE.Object3D; legL: THREE.Object3D; legR: THREE.Object3D; body: THREE.Object3D; phase: number } };

/** The squad's captain, walking. Shirt in the squad colour with the number on the back. */
export function makeAvatar(opts: { color: string; number: number }): Avatar {
  const g = new THREE.Group() as Avatar;
  const shirt = mat(opts.color, { rough: 0.8 });
  const skin = mat(0xb07a52, { rough: 0.85 });
  const dark = mat(0x23262d, { rough: 0.9 });
  const body = new THREE.Group(); body.position.y = 0.95; g.add(body);
  const torso = new THREE.Mesh(G.torso, shirt); torso.position.y = 0.42; body.add(torso);
  const head = new THREE.Mesh(G.head, skin); head.position.y = 0.98; body.add(head);
  const hair = new THREE.Mesh(G.hair, dark); hair.position.y = 1.0; hair.rotation.x = -0.25; body.add(hair);
  const pack = new THREE.Mesh(G.pack, mat(0x3b4a2f, { rough: 0.9 })); pack.position.set(0, 0.48, 0.24); body.add(pack);
  const plate = new THREE.Mesh(G.plate, new THREE.MeshBasicMaterial({ map: numberTex(opts.number, opts.color) }));
  plate.position.set(0, 0.5, 0.345); body.add(plate);
  const limb = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geo, m); mesh.position.y = -0.33; pivot.add(mesh);
    return pivot;
  };
  const armL = limb(G.limb, shirt, -0.34, 0.72); const armR = limb(G.limb, shirt, 0.34, 0.72);
  const gun = new THREE.Mesh(G.gun, mat(0x15171b, { rough: 0.4, metal: 0.6 })); gun.position.set(0, -0.62, -0.2); armR.add(gun);
  body.add(armL, armR);
  const legL = limb(G.leg, dark, -0.13, 0.02); const legR = limb(G.leg, dark, 0.13, 0.02);
  for (const L of [legL, legR]) { const s = new THREE.Mesh(G.shoe, dark); s.position.set(0, -0.78, -0.06); L.add(s); }
  body.add(legL, legR);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  g.userData = { armL, armR, legL, legR, body, phase: 0 };
  return g;
}

/** speed in world units / s: walk cycle, a little bob and lean */
export function animateAvatar(a: Avatar, dt: number, speed: number, aiming = false) {
  const u = a.userData;
  const run = Math.min(1, speed / 7);
  u.phase += dt * (4 + run * 7) * (run > 0.05 ? 1 : 0);
  const sw = Math.sin(u.phase) * 0.9 * run;
  u.legL.rotation.x = sw; u.legR.rotation.x = -sw;
  u.armL.rotation.x = -sw * 0.8;
  u.armR.rotation.x = aiming ? -1.45 : sw * 0.8;
  u.body.position.y = 0.95 + Math.abs(Math.cos(u.phase)) * 0.06 * run;
  u.body.rotation.x = -0.12 * run;
}

/** Parachute canopy with lines, in the squad colour. Hang an avatar under it at y = 0. */
export function makeChute(color: string) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(3.4, 18, 6, 0, Math.PI * 2, 0, Math.PI * 0.32);
  // stripes: alternate squad colour and white by face
  const cols: number[] = []; const a = new THREE.Color(color); const w = new THREE.Color(0xffffff);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const ang = Math.atan2(pos.getZ(i), pos.getX(i));
    const c = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 9) % 2 ? a : w;
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const canopy = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  canopy.position.y = 3.2; canopy.castShadow = true;
  g.add(canopy);
  const lineM = new THREE.LineBasicMaterial({ color: 0x333333 });
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    pts.push(new THREE.Vector3(0, 1.9, 0), new THREE.Vector3(Math.cos(t) * 2.9, 5.0, Math.sin(t) * 2.9));
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineM));
  return g;
}

/** The drop plane: a big transport with four engines and lights. Faces −z. */
export function makePlane() {
  const g = new THREE.Group();
  const hullM = mat(0xdfe4ea, { rough: 0.35, metal: 0.5 });
  const darkM = mat(0x4a5562, { rough: 0.5, metal: 0.4 });
  const fus = new THREE.Mesh(new THREE.CapsuleGeometry(2.6, 26, 6, 16), hullM); fus.rotation.x = Math.PI / 2; g.add(fus);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.64, 2.64, 22, 16, 1, true, -0.4, 0.8), mat(0x1e8fd6, { rough: 0.4 })); stripe.rotation.x = Math.PI / 2; g.add(stripe);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(44, 0.5, 6), hullM); wing.position.set(0, 0.6, -1); g.add(wing);
  const tailW = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 3.2), hullM); tailW.position.set(0, 2.2, 13); g.add(tailW);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 4.5), mat(0x1e8fd6, { rough: 0.4 })); fin.position.set(0, 5, 13.5); g.add(fin);
  for (const x of [-15, -8, 8, 15]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 4, 12), darkM); eng.rotation.x = Math.PI / 2; eng.position.set(x, -0.6, -2.5); g.add(eng);
    const prop = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.25, 0.12), darkM); prop.position.set(x, -0.6, -4.6); prop.name = 'prop'; g.add(prop);
  }
  const winM = new THREE.MeshBasicMaterial({ color: 0x9fd8ff });
  for (let i = 0; i < 9; i++) for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.5), winM); w.position.set(sx * 2.62, 0.9, -9 + i * 2.2); w.rotation.y = sx * Math.PI / 2; g.add(w);
  }
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3333 })); red.position.set(-22, 0.6, -1); g.add(red);
  const grn = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0x33ff66 })); grn.position.set(22, 0.6, -1); g.add(grn);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); beacon.position.set(0, -2.7, 0); beacon.name = 'beacon'; g.add(beacon);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

export function animatePlane(p: THREE.Object3D, t: number) {
  p.children.forEach((c) => { if (c.name === 'prop') c.rotation.z = t * 40; if (c.name === 'beacon') c.visible = Math.sin(t * 6) > 0.6; });
}

/** A short bright streak from a to b; caller fades and removes it. */
export function makeTracer(a: THREE.Vector3, b: THREE.Vector3, hit: boolean) {
  const g = new THREE.Group();
  const len = a.distanceTo(b);
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 4, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
  line.position.copy(a).add(b).multiplyScalar(0.5);
  line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.add(line);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  flash.position.copy(a); g.add(flash);
  if (hit) {
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3a3a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    spark.position.copy(b); g.add(spark);
  }
  g.userData.t0 = performance.now();
  return g;
}
