// Squad buggy: one compact all-terrain buggy per squad, painted in the squad's colour with its
// number on the roof. Original low-poly design; replaces the four-person squads so 15 squads fit
// on one screen without clutter.
import * as THREE from 'three';

const mats = new Map<string, THREE.Material>();
function mat(color: number | string, o: { rough?: number; metal?: number; emissive?: number; ei?: number } = {}) {
  const key = `${color}|${o.rough ?? 0.6}|${o.metal ?? 0}|${o.emissive ?? 0}|${o.ei ?? 0}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.6, metalness: o.metal ?? 0, emissive: o.emissive ?? 0, emissiveIntensity: o.ei ?? (o.emissive ? 1 : 0) });
    mats.set(key, m);
  }
  return m;
}

const G = {
  tub: new THREE.BoxGeometry(1.7, 0.42, 2.9),
  nose: new THREE.BoxGeometry(1.55, 0.36, 0.9),
  hood: new THREE.BoxGeometry(1.5, 0.12, 1.0),
  rear: new THREE.BoxGeometry(1.6, 0.5, 0.7),
  seat: new THREE.BoxGeometry(0.55, 0.55, 0.5),
  bar: new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
  wheel: new THREE.CylinderGeometry(0.46, 0.46, 0.38, 16).rotateZ(Math.PI / 2),
  hub: new THREE.CylinderGeometry(0.22, 0.22, 0.4, 10).rotateZ(Math.PI / 2),
  tread: new THREE.TorusGeometry(0.43, 0.06, 4, 16).rotateY(Math.PI / 2),
  light: new THREE.BoxGeometry(0.28, 0.14, 0.06),
  bumper: new THREE.BoxGeometry(1.8, 0.16, 0.18),
  pole: new THREE.CylinderGeometry(0.025, 0.025, 1.4, 5),
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

export type Vehicle = THREE.Group & { userData: { wheels: THREE.Object3D[]; steer: THREE.Object3D[]; body: THREE.Object3D; flag: THREE.Mesh; spin: number } };

export function makeVehicle(opts: { color: string; number: number; dim?: boolean }): Vehicle {
  const v = new THREE.Group() as Vehicle;
  const paint = mat(opts.color, { rough: 0.35, metal: 0.35 });
  const dark = mat(0x1b2028, { rough: 0.8 });
  const cage = mat(0x2b2f36, { rough: 0.4, metal: 0.7 });
  const body = new THREE.Group();
  const tub = new THREE.Mesh(G.tub, paint); tub.position.y = 0.7;
  const nose = new THREE.Mesh(G.nose, paint); nose.position.set(0, 0.66, -1.75); nose.rotation.x = 0.18;
  const hood = new THREE.Mesh(G.hood, dark); hood.position.set(0, 0.9, -1.3); hood.rotation.x = 0.12;
  const rear = new THREE.Mesh(G.rear, dark); rear.position.set(0, 0.95, 1.2);
  body.add(tub, nose, hood, rear);
  for (const sx of [-0.38, 0.38]) { const s = new THREE.Mesh(G.seat, dark); s.position.set(sx, 1.1, 0.25); body.add(s); }
  // roll cage
  const bars: [number, number, number, number, number, number][] = [
    [-0.72, 0.95, -0.55, -0.62, 2.15, 0.15], [0.72, 0.95, -0.55, 0.62, 2.15, 0.15],
    [-0.72, 0.95, 0.9, -0.62, 2.15, 0.6], [0.72, 0.95, 0.9, 0.62, 2.15, 0.6],
    [-0.62, 2.15, 0.15, 0.62, 2.15, 0.15], [-0.62, 2.15, 0.6, 0.62, 2.15, 0.6],
  ];
  for (const [x0, y0, z0, x1, y1, z1] of bars) {
    const a = new THREE.Vector3(x0, y0, z0); const b = new THREE.Vector3(x1, y1, z1);
    const m = new THREE.Mesh(G.bar, cage);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.y = a.distanceTo(b);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    body.add(m);
  }
  // roof panel with the squad number (readable from the follow camera and from above)
  const roof = new THREE.Mesh(G.roof, [paint, paint, mat(0xffffff, { rough: 0.5 }), paint, paint, paint]);
  (roof.material as THREE.Material[])[2] = new THREE.MeshStandardMaterial({ map: plate(opts.number, opts.color), roughness: 0.5 });
  roof.position.set(0, 2.2, 0.38);
  body.add(roof);
  const bumper = new THREE.Mesh(G.bumper, cage); bumper.position.set(0, 0.55, -2.18); body.add(bumper);
  const headM = mat(0xfff6d8, { emissive: 0xfff2c0, ei: 1.4 });
  const tailM = mat(0xff2a3a, { emissive: 0xff2a3a, ei: 1.2 });
  for (const sx of [-0.55, 0.55]) {
    const h = new THREE.Mesh(G.light, headM); h.position.set(sx, 0.82, -2.2); body.add(h);
    const t = new THREE.Mesh(G.light, tailM); t.position.set(sx, 0.95, 1.56); body.add(t);
  }
  // antenna with a pennant in the squad colour
  const pole = new THREE.Mesh(G.pole, cage); pole.position.set(0.62, 2.85, 0.75); body.add(pole);
  const flag = new THREE.Mesh(G.flag, mat(opts.color, { rough: 0.8 }));
  (flag.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  flag.position.set(0.62 + 0.25, 3.35, 0.75); body.add(flag);
  v.add(body);

  const wheels: THREE.Object3D[] = []; const steer: THREE.Object3D[] = [];
  const tyre = mat(0x15171b, { rough: 0.95 }); const hubM = mat(0xc9ced6, { rough: 0.3, metal: 0.8 });
  for (const [x, z] of [[-0.98, -1.25], [0.98, -1.25], [-0.98, 1.15], [0.98, 1.15]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.46, z);
    const w = new THREE.Group();
    w.add(new THREE.Mesh(G.wheel, tyre), new THREE.Mesh(G.hub, hubM), new THREE.Mesh(G.tread, tyre));
    pivot.add(w); v.add(pivot);
    wheels.push(w);
    if (z < 0) steer.push(pivot);
  }
  const sh = new THREE.Mesh(G.shadow, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.04; sh.scale.set(0.75, 1.15, 1);
  v.add(sh);
  v.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== sh) { o.castShadow = true; } });
  v.userData = { wheels, steer, body, flag, spin: 0 };
  return v;
}

/** Wheel spin, steering and suspension bob. speed in world units / s, turn in rad / s. */
export function animateVehicle(v: Vehicle, t: number, dt: number, speed: number, turn: number, down: boolean) {
  const u = v.userData;
  u.spin += (speed * dt) / 0.46;
  for (const w of u.wheels) w.rotation.x = -u.spin;
  const st = Math.max(-0.5, Math.min(0.5, turn * 0.35));
  for (const s of u.steer) s.rotation.y += (st - s.rotation.y) * Math.min(1, dt * 8);
  const bob = speed > 0.3 ? Math.sin(t * 18) * 0.025 : 0;
  u.body.position.y = bob;
  u.body.rotation.z += ((down ? 0.18 : -st * 0.12) - u.body.rotation.z) * Math.min(1, dt * 5);
  u.body.rotation.x += ((speed > 0.3 ? 0.03 : 0) - u.body.rotation.x) * Math.min(1, dt * 4);
  u.flag.rotation.y = Math.sin(t * 6 + speed) * 0.25 * (0.3 + Math.min(1, speed / 6));
}
