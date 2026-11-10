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

export type Vehicle = THREE.Group & { userData: { wheels: THREE.Object3D[]; steer: THREE.Object3D[]; body: THREE.Object3D; flag: THREE.Mesh; spin: number } };

export function makeVehicle(opts: { color: string; number: number; dim?: boolean }): Vehicle {
  const v = new THREE.Group() as Vehicle;
  const paint = mat(opts.color, { rough: 0.32, metal: 0.45 });
  const dark = mat(0x1b2028, { rough: 0.85 });
  const cage = mat(0x2b2f36, { rough: 0.4, metal: 0.7 });
  const chrome = mat(0xc9ced6, { rough: 0.25, metal: 0.9 });
  const body = new THREE.Group();
  body.add(new THREE.Mesh(G.body, paint));
  const skid = new THREE.Mesh(G.skid, dark); skid.position.set(0, 0.4, -0.15); body.add(skid);
  const grille = new THREE.Mesh(G.grille, dark); grille.position.set(0, 0.74, -2.2); body.add(grille);
  // cabin: two seats, dashboard, steering wheel, windscreen
  for (const sx of [-0.4, 0.4]) {
    const st = new THREE.Mesh(G.seat, dark); st.position.set(sx, 1.02, 0.1); body.add(st);
    const sb = new THREE.Mesh(G.seatBack, dark); sb.position.set(sx, 1.38, 0.42); sb.rotation.x = 0.14; body.add(sb);
  }
  const dash = new THREE.Mesh(G.dash, dark); dash.position.set(0, 1.14, -0.66); body.add(dash);
  const sw = new THREE.Mesh(G.wheelRing, cage); sw.position.set(-0.4, 1.3, -0.45); sw.rotation.x = -0.5; body.add(sw);
  const glass = new THREE.Mesh(G.glass, new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.6, side: THREE.DoubleSide }));
  glass.position.set(0, 1.5, -0.84); glass.rotation.x = -0.32; glass.castShadow = false; glass.userData.noShadow = true; body.add(glass);
  // roll cage
  const bars: [number, number, number, number, number, number][] = [
    [-0.72, 1.14, -0.75, -0.64, 2.15, -0.1], [0.72, 1.14, -0.75, 0.64, 2.15, -0.1],
    [-0.72, 1.18, 0.95, -0.64, 2.15, 0.7], [0.72, 1.18, 0.95, 0.64, 2.15, 0.7],
    [-0.64, 2.15, -0.1, 0.64, 2.15, -0.1], [-0.64, 2.15, 0.7, 0.64, 2.15, 0.7],
    [-0.64, 2.15, -0.1, -0.64, 2.15, 0.7], [0.64, 2.15, -0.1, 0.64, 2.15, 0.7],
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
  for (const y of [0.56, 0.8]) { const bp = new THREE.Mesh(G.bumper, cage); bp.position.set(0, y, -2.32); body.add(bp); }
  const rb = new THREE.Mesh(G.bumper, cage); rb.position.set(0, 0.56, 1.86); body.add(rb);
  const headM = mat(0xfff6d8, { emissive: 0xfff2c0, ei: 1.6 });
  const tailM = mat(0xff2a3a, { emissive: 0xff2a3a, ei: 1.3 });
  for (const sx of [-0.58, 0.58]) {
    const h = new THREE.Mesh(G.lamp, headM); h.position.set(sx, 0.86, -2.2); body.add(h);
    const rim = new THREE.Mesh(G.wheelRing, chrome); rim.position.set(sx, 0.86, -2.25); body.add(rim);
    const t = new THREE.Mesh(G.tail, tailM); t.position.set(sx, 1.02, 1.84); body.add(t);
  }
  // spare wheel and a fuel can on the back
  const spare = new THREE.Mesh(G.spare, mat(0x15171b, { rough: 0.95 })); spare.position.set(0, 1.02, 1.93); body.add(spare);
  const jerry = new THREE.Mesh(G.jerry, mat(0x7a1f1f, { rough: 0.6, metal: 0.3 })); jerry.position.set(0.52, 1.44, 1.35); body.add(jerry);
  // antenna with a pennant in the squad colour
  const pole = new THREE.Mesh(G.pole, cage); pole.position.set(0.62, 2.9, 0.75); body.add(pole);
  const flag = new THREE.Mesh(G.flag, mat(opts.color, { rough: 0.8 }));
  (flag.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  flag.position.set(0.62 + 0.25, 3.45, 0.75); body.add(flag);
  v.add(body);

  const wheels: THREE.Object3D[] = []; const steer: THREE.Object3D[] = [];
  const tyre = mat(0x15171b, { rough: 0.95 });
  for (const [x, z] of [[-0.95, -1.3], [0.95, -1.3], [-0.95, 1.15], [0.95, 1.15]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.5, z);
    const w = new THREE.Group();
    w.add(new THREE.Mesh(G.tyre, tyre), new THREE.Mesh(G.rim, chrome));
    for (let k = 0; k < 3; k++) { const sp = new THREE.Mesh(G.spoke, cage); sp.rotation.x = (k / 3) * Math.PI; sp.scale.set(1.02, 1, 1); w.add(sp); }
    pivot.add(w); v.add(pivot);
    wheels.push(w);
    if (z < 0) steer.push(pivot);
    // mudguard arch over each wheel, fixed to the body
    const arch = new THREE.Mesh(G.arch, dark); arch.position.set(x * 0.98, 0.5, z); arch.scale.set(2.6, 1, 1); body.add(arch);
  }
  const sh = new THREE.Mesh(G.shadow, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.04; sh.scale.set(0.75, 1.15, 1);
  v.add(sh);
  v.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== sh && !o.userData.noShadow) { o.castShadow = true; } });
  v.userData = { wheels, steer, body, flag, spin: 0 };
  return v;
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
