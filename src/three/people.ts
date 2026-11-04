// Low-poly people with a simple walk cycle. Original design (no third-party models).
import * as THREE from 'three';

export const ROLE_HEX: Record<string, number> = { captain: 0xffb020, scout: 0x22c7e6, decoder: 0x9a6bff, intel: 0x3fcf6e };
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x1b1209, 0x2f1d10, 0x4a2c17, 0x0d0d0d];

export type Person = THREE.Group & {
  userData: { legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; torso: THREE.Object3D; phase: number };
};

const mats = new Map<string, THREE.Material>();
function mat(color: number, opts: { rough?: number; metal?: number; emissive?: number } = {}) {
  const key = `${color}-${opts.rough ?? 0.75}-${opts.metal ?? 0}-${opts.emissive ?? 0}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.75, metalness: opts.metal ?? 0, emissive: opts.emissive ?? 0, emissiveIntensity: opts.emissive ? 0.25 : 0 });
    mats.set(key, m);
  }
  return m;
}
const geo = {
  leg: new THREE.BoxGeometry(0.2, 0.78, 0.22).translate(0, -0.39, 0),
  shoe: new THREE.BoxGeometry(0.22, 0.12, 0.34).translate(0, -0.8, -0.05),
  torso: new THREE.BoxGeometry(0.56, 0.66, 0.3),
  vest: new THREE.BoxGeometry(0.6, 0.42, 0.34),
  arm: new THREE.BoxGeometry(0.16, 0.66, 0.18).translate(0, -0.3, 0),
  hand: new THREE.SphereGeometry(0.09, 8, 6).translate(0, -0.66, 0),
  neck: new THREE.CylinderGeometry(0.09, 0.1, 0.12, 8),
  head: new THREE.SphereGeometry(0.22, 14, 12),
  hair: new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
  cap: new THREE.CylinderGeometry(0.24, 0.25, 0.12, 14),
  visor: new THREE.BoxGeometry(0.3, 0.04, 0.16),
  pack: new THREE.BoxGeometry(0.42, 0.5, 0.2),
  belt: new THREE.BoxGeometry(0.58, 0.08, 0.32),
};

/** One person. `team` colours the vest/cap; `seed` varies skin, hair and trousers. */
export function makePerson(opts: { team: number; seed?: number; enemy?: boolean; hood?: boolean; cap?: boolean }): Person {
  const seed = opts.seed ?? 0;
  const g = new THREE.Group() as Person;
  const skin = mat(opts.hood ? 0x1a1a1a : SKIN[seed % SKIN.length]);
  const pants = mat(opts.enemy ? 0x3a2a2a : [0x2f3e56, 0x3b4a3a, 0x44403a][seed % 3]);
  const shirt = mat(opts.hood ? 0x111111 : opts.enemy ? 0x5a1f24 : 0x2a3446);
  const team = mat(opts.team, { emissive: opts.team });
  const hips = new THREE.Group(); hips.position.y = 0.95; g.add(hips);
  const legL = new THREE.Group(); legL.position.set(-0.13, 0, 0);
  const legR = new THREE.Group(); legR.position.set(0.13, 0, 0);
  for (const leg of [legL, legR]) {
    const l = new THREE.Mesh(geo.leg, pants); l.castShadow = true;
    const s = new THREE.Mesh(geo.shoe, mat(0x1b1b1b)); s.castShadow = true;
    leg.add(l, s); hips.add(leg);
  }
  const torso = new THREE.Group(); torso.position.y = 0.33; hips.add(torso);
  const body = new THREE.Mesh(geo.torso, shirt); body.castShadow = true; torso.add(body);
  const vest = new THREE.Mesh(geo.vest, team); vest.position.y = 0.08; vest.castShadow = true; torso.add(vest);
  const belt = new THREE.Mesh(geo.belt, mat(0x2b2b2b)); belt.position.y = -0.3; torso.add(belt);
  const pack = new THREE.Mesh(geo.pack, mat(opts.enemy ? 0x3d2a1f : 0x4b5a3a)); pack.position.set(0, 0.02, 0.26); pack.castShadow = true; torso.add(pack);
  const armL = new THREE.Group(); armL.position.set(-0.37, 0.28, 0);
  const armR = new THREE.Group(); armR.position.set(0.37, 0.28, 0);
  for (const arm of [armL, armR]) {
    const a = new THREE.Mesh(geo.arm, shirt); a.castShadow = true;
    const h = new THREE.Mesh(geo.hand, skin);
    arm.add(a, h); torso.add(arm);
  }
  const neck = new THREE.Mesh(geo.neck, skin); neck.position.y = 0.39; torso.add(neck);
  const head = new THREE.Mesh(geo.head, skin); head.position.y = 0.6; head.castShadow = true; torso.add(head);
  if (opts.hood) {
    const hood = new THREE.Mesh(geo.hair, mat(0x0b0b0b)); hood.position.y = 0.62; hood.scale.set(1.12, 1.25, 1.12); torso.add(hood);
    const eyes = new THREE.Mesh(geo.visor, new THREE.MeshBasicMaterial({ color: 0xff2238 })); eyes.position.set(0, 0.62, -0.17); torso.add(eyes);
  } else if (opts.cap !== false) {
    const cap = new THREE.Mesh(geo.cap, team); cap.position.y = 0.76; torso.add(cap);
    const visor = new THREE.Mesh(geo.visor, team); visor.position.set(0, 0.72, -0.2); torso.add(visor);
  } else {
    const hair = new THREE.Mesh(geo.hair, mat(HAIR[seed % HAIR.length])); hair.position.y = 0.63; torso.add(hair);
  }
  g.userData = { legL, legR, armL, armR, torso, phase: seed * 1.7 };
  return g;
}

/** Advance the walk cycle. speed 0 = idle (breathing), 1 = running. */
export function animatePerson(p: Person, t: number, speed: number, down = false) {
  const u = p.userData;
  if (down) {
    p.rotation.x = -Math.PI / 2 + 0.05; p.position.y = 0.25;
    u.legL.rotation.x = u.legR.rotation.x = 0; u.armL.rotation.x = u.armR.rotation.x = -0.3;
    return;
  }
  p.rotation.x = 0;
  const w = t * 10 + u.phase;
  const swing = Math.sin(w) * 0.75 * speed;
  u.legL.rotation.x = swing; u.legR.rotation.x = -swing;
  u.armL.rotation.x = -swing * 0.9; u.armR.rotation.x = swing * 0.9;
  u.armL.rotation.z = 0.08; u.armR.rotation.z = -0.08;
  u.torso.rotation.x = -0.12 * speed;
  p.position.y = speed > 0.05 ? Math.abs(Math.sin(w)) * 0.08 * speed : Math.sin(t * 2 + u.phase) * 0.01;
}
