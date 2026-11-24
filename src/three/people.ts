// Captain on foot (rigged character, see rig.ts), parachute, the drop plane and gun tracers. All built in code (no assets).
// Scale: 1 world unit ≈ 1 m (a buggy is ~4.5 long, a person 1.8 tall).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Character } from './rig';

const mat = (c: THREE.ColorRepresentation, o: { rough?: number; metal?: number; emissive?: number; ei?: number } = {}) =>
  new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.7, metalness: o.metal ?? 0.05, emissive: o.emissive ?? 0x000000, emissiveIntensity: o.ei ?? 0 });



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

export type Avatar = THREE.Group & { userData: { char: Character; aimAt?: number; firedAt?: number; lastFired?: number } };

/** The squad's captain on foot: an original rigged character in the squad colour, number on the back. */
export function makeAvatar(opts: { color: string; number: number }): Avatar {
  const char = new Character({ color: opts.color, number: opts.number, plate: numberTex(opts.number, opts.color) });
  const g = char.root as Avatar;
  g.userData = { char };
  return g;
}

/** Drive the character from what the game already decided: ground speed (m/s), free fall, canopy, aiming, knocked. */
export function animateAvatar(a: Avatar, dt: number, s: { speed: number; fall?: boolean; chute?: boolean; aiming?: boolean; down?: boolean; reduced?: boolean }) {
  const u = a.userData;
  const fired = !!u.firedAt && u.firedAt !== u.lastFired;
  u.lastFired = u.firedAt;
  u.char.update(dt, { ...s, fired });
}

export function disposeAvatar(a: Avatar) { a.userData.char?.dispose(); }

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
  // cabin windows: 18 panes, one mesh
  const panes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) for (const sx of [-1, 1]) panes.push(new THREE.PlaneGeometry(0.6, 0.5).rotateY(sx * Math.PI / 2).translate(sx * 2.62, 0.9, -9 + i * 2.2));
  g.add(new THREE.Mesh(mergeGeometries(panes, false)!, new THREE.MeshBasicMaterial({ color: 0x9fd8ff })));
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3333 })); red.position.set(-22, 0.6, -1); g.add(red);
  const grn = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0x33ff66 })); grn.position.set(22, 0.6, -1); g.add(grn);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); beacon.position.set(0, -2.7, 0); beacon.name = 'beacon'; g.add(beacon);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

export function animatePlane(p: THREE.Object3D, t: number) {
  p.children.forEach((c) => { if (c.name === 'prop') c.rotation.z = t * 40; if (c.name === 'beacon') c.visible = Math.sin(t * 6) > 0.6; });
}
