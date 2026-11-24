// 3D campus world (three.js), daylight battle-royale look.
// A 1.6 km campus: street grid with sidewalks and lamps, parking yards full of cars, a fountain
// plaza, sports grounds, helipad, solar farm, palms and trees, and multi-storey buildings you can
// enter — every floor has rooms with sliding doors and a stairwell. Squads are buggies in their
// squad colour. Lockdowns light buildings up in red and then shutter them.
// Campus coordinates are 0..1 (x east, y south); world units = S per campus width; one storey = FLOOR_H.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { animateAvatar, animatePlane, Avatar, disposeAvatar, makeAvatar, makeChute, makePlane } from './people';
import { zoneNow } from '../lib/zone';
import type { MapData, Building } from '../lib/game';
import { squadHex } from '../lib/game';
import { serverTime } from '../lib/time';
import { BUILDINGS as LAYOUT_BUILDINGS, building as layoutBuilding, ROADS, LOTS, FEATURES, FLOOR_H } from '../../content/campus.mjs';
import { Baker, sharedMat } from './bake';
import { Ambience } from '../lib/ambience';
import { animateVehicle, makeVehicle, setVehicleDetail, Vehicle } from './vehicle';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VFX, zoneWallMaterial } from './vfx';
import { AdaptiveResolution, currentQuality, FpsOverlay, FrameMonitor, PRESETS, Preset, Quality, showFps } from './quality';

export const S = 560;
const DROP_FROM = 140; const DROP_FALL_S = 9; const DROP_CUT_MS = 13000; // campus width in world units (a buggy is ~4.5 long)
export { FLOOR_H };
const W = (x: number, y: number, level = 0) => new THREE.Vector3((x - 0.5) * S, level * FLOOR_H, (y - 0.5) * S);

export type WorldSquad = {
  key: string; number: number; x: number; y: number; me?: boolean; ally?: boolean; inBattle?: boolean; down?: boolean; moving?: boolean;
  vx?: number; vy?: number; at?: number; level?: number; bldg?: string | null; label?: string;
  /** on foot (the captain walks; the buggy is parked at `buggy`) */
  foot?: boolean; buggy?: number[] | null; chute?: boolean; landAt?: number; jumpAt?: number; hidden?: boolean;
  hp?: number; shield?: number; fight?: boolean;
};
export type WorldState = {
  squads: WorldSquad[];
  zone?: { cur?: number[] | null; next?: number[] | null; prev?: number[] | null; shrink_from?: string | null; shrink_until?: string | null } | null;
  /** the drop plane's straight path over the campus */
  plane?: { a: number[]; b: number[]; t0: string; t1: string } | null;
  /** first-person view for your own captain (on foot inside a building) */
  fpv?: boolean;
  /** the rival squad your gun is locked on */
  target?: string | null;
  red?: { x: number; y: number; r: number; at: string } | null;
  airdrops?: { key: string; location: string; tier: string }[];
  battles?: { key: string; x: number; y: number }[];
  pickups?: { id: string; k: string; x: number; y: number; l: number }[];
  lock?: { id: string; b: string; l: number | null; at: string; sealed: boolean }[];
  focus?: { x: number; y: number } | null;
  locRadius?: number;
  highlight?: string | null;
  waypoint?: { x: number; y: number } | null;
  route?: { x: number; y: number } | null;
};
export type CameraMode = 'follow' | 'overview' | 'orbit';
export type LiveMe = { x: number; y: number; moving: boolean; joy?: boolean; jx?: number; yaw?: number; level?: number; bldg?: string | null; vx?: number; vy?: number };

const TIER_HEX: Record<string, number> = { common: 0xdfe6ee, rare: 0x3ea5ff, legendary: 0xffc23d, mystery: 0xb07cff, cursed: 0xff4d5e, intel: 0x5dff9e, vault: 0xff9d2e };
const STYLE: Record<string, { wall: string; glass: string; roof: number; band?: string }> = {
  learning: { wall: '#eef1f4', glass: '#2f8fb0', roof: 0x7d8792, band: '#1fb6c9' },
  tower: { wall: '#9fb0c2', glass: '#2a5f8f', roof: 0x5f6873, band: '#7fd0ff' },
  brick: { wall: '#b5644a', glass: '#365d7c', roof: 0x5d5f63 },
  office: { wall: '#d9cdb5', glass: '#4b7ea6', roof: 0x6f7378 },
  pavilion: { wall: '#efe7d6', glass: '#5e8fae', roof: 0xb2603f },
  datacenter: { wall: '#9aa3ad', glass: '#2b3a4a', roof: 0x6b7480 },
};

export const SHORT_LABEL: Record<string, string> = {};

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

// Label atlas: every name plate is drawn once into a shared 2048×1024 canvas page. Each sprite gets a texture
// clone (same image source, own offset/repeat), so all labels upload as one GPU texture per page.
const ATLAS_W = 2048; const ATLAS_H = 1024; const ROW = 68;
type AtlasPage = { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; tex: THREE.CanvasTexture; x: number; y: number };
const atlasPages: AtlasPage[] = [];
const atlasCache = new Map<string, { page: AtlasPage; x: number; y: number; w: number }>();
function atlasSlot(key: string, w: number, draw: (g: CanvasRenderingContext2D, x: number, y: number) => void) {
  const hit = atlasCache.get(key); if (hit) return hit;
  let page = atlasPages[atlasPages.length - 1];
  if (page && page.x + w + 4 > ATLAS_W) { page.x = 0; page.y += ROW; }
  if (!page || page.y + ROW > ATLAS_H) {
    const canvas = document.createElement('canvas'); canvas.width = ATLAS_W; canvas.height = ATLAS_H;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.userData.shared = true;
    page = { canvas, g: canvas.getContext('2d')!, tex, x: 0, y: 0 }; atlasPages.push(page);
  }
  const slot = { page, x: page.x, y: page.y, w };
  page.g.save(); draw(page.g, slot.x, slot.y); page.g.restore();
  page.x += w + 4; page.tex.needsUpdate = true;
  atlasCache.set(key, slot);
  return slot;
}

// screen = true keeps a constant on-screen size (game-style name plates)
function labelSprite(text: string, color = '#ffffff', bg = 'rgba(10,16,28,0.72)', scale = 1, screen = false) {
  const font = '700 44px Rajdhani, "Segoe UI", system-ui, sans-serif';
  const probe = document.createElement('canvas').getContext('2d')!; probe.font = font;
  const w = Math.min(ATLAS_W - 8, Math.ceil(probe.measureText(text).width) + 36);
  const slot = atlasSlot(`${text}|${color}|${bg}`, w, (g, x, y) => {
    g.translate(x, y + 2); g.font = font; g.fillStyle = bg;
    const r = 14;
    g.beginPath(); g.moveTo(r, 0); g.arcTo(w, 0, w, 64, r); g.arcTo(w, 64, 0, 64, r); g.arcTo(0, 64, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.fill();
    g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(text, w / 2, 34);
  });
  const tex = slot.page.tex.clone(); // shares the page's image source: one upload for every label
  tex.repeat.set(w / ATLAS_W, 64 / ATLAS_H);
  tex.offset.set(slot.x / ATLAS_W, 1 - (slot.y + 2 + 64) / ATLAS_H);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: !screen, transparent: true, fog: false, sizeAttenuation: !screen }));
  const hgt = screen ? 0.04 * scale : 1.6 * scale;
  sp.scale.set((w / 64) * hgt, hgt, 1);
  sp.renderOrder = 10;
  return sp;
}

const facadeCache = new Map<string, THREE.CanvasTexture & { orm?: THREE.CanvasTexture }>();

/**
 * Facade textures for one building style: a colour map and a matching roughness/metalness map
 * (green = roughness, blue = metalness, as three.js reads them), so glass is smooth and reflects the sky
 * while walls stay matte. Same layout in both maps.
 */
function facadeTexture(wall: string, glass: string, floors: number, style: string): THREE.CanvasTexture & { orm?: THREE.CanvasTexture } {
  const tower = style === 'tower'; const dc = style === 'datacenter';
  const lit: boolean[] = Array.from({ length: floors * 6 }, () => Math.random() < 0.12);
  const paint = (orm: boolean) => (g: CanvasRenderingContext2D) => {
    const WALL = orm ? 'rgb(255,215,8)' : wall;            // rough, non-metal
    const GLASS = orm ? 'rgb(255,26,165)' : null;           // smooth, fairly metallic
    const FRAME = orm ? 'rgb(255,120,150)' : tower ? 'rgba(220,235,250,0.6)' : wall;
    g.fillStyle = WALL; g.fillRect(0, 0, 256, 64 * floors);
    for (let f = 0; f < floors; f++) {
      const y = f * 64; const ground = f === floors - 1;
      if (dc) {
        g.fillStyle = orm ? 'rgb(255,190,40)' : 'rgba(0,0,0,0.18)';
        for (let x = 10; x < 250; x += 16) g.fillRect(x, y + 14, 8, 36); // vents
        g.fillStyle = orm ? 'rgb(255,200,20)' : 'rgba(0,0,0,0.25)'; g.fillRect(0, y + 60, 256, 4);
        continue;
      }
      if (orm) g.fillStyle = GLASS!;
      else {
        // sky reflected at the top of each pane, darker interior below, a soft diagonal sheen
        const grd = g.createLinearGradient(0, y + 8, 0, y + 56);
        grd.addColorStop(0, '#cfe6fb'); grd.addColorStop(0.3, glass); grd.addColorStop(1, '#122a42');
        g.fillStyle = grd;
      }
      if (tower) g.fillRect(2, y + 4, 252, 56);
      else g.fillRect(8, y + (ground ? 8 : 14), 240, ground ? 50 : 36);
      if (!orm) {
        g.save(); g.globalAlpha = 0.12; g.fillStyle = '#ffffff';
        g.beginPath(); g.moveTo(40, y + 58); g.lineTo(90, y + 6); g.lineTo(110, y + 6); g.lineTo(60, y + 58); g.fill(); g.restore();
        // interior hints: ceiling strip lights and a few lit offices
        g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(8, y + (ground ? 10 : 16), 240, 2);
        for (let k = 0; k < 6; k++) if (lit[f * 6 + k] && !ground) { g.fillStyle = 'rgba(255,226,160,0.32)'; g.fillRect(12 + k * 40, y + 18, 32, 28); }
      }
      g.fillStyle = FRAME;
      for (let x = 8; x <= 248; x += ground ? 80 : tower ? 32 : 40) g.fillRect(x - (tower ? 1 : 2), y + 4, tower ? 2 : 4, 56);
      g.fillStyle = orm ? 'rgb(255,200,20)' : 'rgba(0,0,0,0.14)'; g.fillRect(0, y + 60, 256, 4); // slab edge
    }
  };
  const t = canvasTex(256, 64 * floors, paint(false)) as THREE.CanvasTexture & { orm?: THREE.CanvasTexture };
  const orm = canvasTex(256, 64 * floors, paint(true)); orm.colorSpace = THREE.NoColorSpace;
  t.orm = orm;
  return t;
}

const noiseTex = (base: string, dots: string[], n: number, rep: [number, number], size = 256, dot = 3) => canvasTex(size, size, (g) => {
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) { g.fillStyle = dots[i % dots.length]; g.fillRect(Math.random() * size, Math.random() * size, dot, dot); }
}, rep);

/** Lawn: soft light/dark patches with fine blade strokes on top, so it reads as grass up close and from the air. */
function grassTex(rep: [number, number]) {
  const size = 512;
  const t = canvasTex(size, size, (g) => {
    g.fillStyle = '#5a9844'; g.fillRect(0, 0, size, size);
    const patch = ['rgba(120,176,84,0.22)', 'rgba(64,122,52,0.22)', 'rgba(142,186,92,0.16)', 'rgba(52,104,48,0.18)'];
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * size; const y = Math.random() * size; const r = 24 + Math.random() * 60;
      // draw each patch on all nine neighbouring tiles so the texture repeats without seams
      for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, patch[i % patch.length]); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    const blade = ['rgba(150,200,100,0.5)', 'rgba(60,118,50,0.5)', 'rgba(104,160,72,0.5)', 'rgba(44,96,44,0.45)', 'rgba(178,208,112,0.35)'];
    g.lineWidth = 1;
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * size; const y = Math.random() * size; const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2; const l = 2 + Math.random() * 4;
      g.strokeStyle = blade[i % blade.length]; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  }, rep);
  t.anisotropy = 8;
  return t;
}

/** A small sky + sun + ground scene baked into a PMREM environment map (cached per renderer). */
function skyEnvironment(renderer: THREE.WebGLRenderer) {
  const sc = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; void main(){ float h = vP.y;
      vec3 top = vec3(0.10,0.32,0.72), mid = vec3(0.55,0.75,0.92), gnd = vec3(0.20,0.26,0.17);
      vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.6, h)) : mix(mid * 0.8, gnd, smoothstep(0.0, -0.25, h));
      vec3 sd = normalize(vec3(-0.4, 0.55, 0.3)); float s = max(dot(vP, sd), 0.0);
      c += vec3(1.0, 0.9, 0.7) * (pow(s, 300.0) * 40.0 + pow(s, 8.0) * 0.5);
      gl_FragColor = vec4(c, 1.0); }`,
  }));
  sc.add(dome);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(sc, 0.02).texture;
  pm.dispose(); dome.geometry.dispose(); (dome.material as THREE.Material).dispose();
  return tex;
}

const PICK_GEO = new THREE.CircleGeometry(1, 24); PICK_GEO.userData.shared = true;
const PICK_MAT = sharedMat(new THREE.MeshBasicMaterial({ visible: false }));
const IG = { cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12), shrub: new THREE.IcosahedronGeometry(1, 1) };

const CRATE = {
  body: new THREE.BoxGeometry(1.8, 1.1, 1.2), stripe: new THREE.BoxGeometry(1.84, 0.12, 1.24), lid: new THREE.BoxGeometry(1.9, 0.16, 1.3),
  glow: new THREE.CylinderGeometry(0.7, 0.2, 2.6, 16, 1, true),
  drop: new THREE.BoxGeometry(2.4, 1.8, 2.4), dropBand: new THREE.BoxGeometry(2.46, 0.22, 2.46),
  canopy: new THREE.SphereGeometry(3.6, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2.2).scale(1, 0.55, 1),
  cords: (() => { const v: number[] = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; v.push(Math.cos(a) * 3.3, 8.9, Math.sin(a) * 3.3, Math.cos(a) * 1.1, 1.85, Math.sin(a) * 1.1); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); return g; })(),
};
for (const g of Object.values(CRATE)) g.userData.shared = true;
const CORD_MAT = sharedMat(new THREE.LineBasicMaterial({ color: 0x3a3f46 }));
let crateTrimGeo: THREE.BufferGeometry | null = null;
/** steel corner brackets and side handles of a challenge box (shared by every box) */
function crateTrim() {
  if (crateTrimGeo) return crateTrimGeo;
  const k = new Baker(); const b = new THREE.BoxGeometry(1, 1, 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add('m', b, 0xaab4bf, [sx * 0.88, 0.55, sz * 0.58], [0, 0, 0], [0.12, 1.14, 0.12]);
  for (const sx of [-1, 1]) k.add('m', b, 0x3a3f46, [sx * 0.92, 0.62, 0], [0, 0, 0], [0.08, 0.14, 0.5]);
  crateTrimGeo = k.build().m; return crateTrimGeo;
}
let dropStrapGeo: THREE.BufferGeometry | null = null;
function dropStraps() {
  if (dropStrapGeo) return dropStrapGeo;
  const k = new Baker(); const b = new THREE.BoxGeometry(1, 1, 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.add('m', b, 0x59606a, [sx * 1.18, 0.9, sz * 1.18], [0, 0, 0], [0.16, 1.84, 0.16]);
  for (const r of [0, Math.PI / 2]) k.add('m', b, 0x2b2f36, [0, 1.81, 0], [0, r, 0], [2.42, 0.06, 0.24]);
  k.add('m', b, 0xc9ced6, [0, 1.9, 0], [0, 0, 0], [0.4, 0.14, 0.4]);
  dropStrapGeo = k.build().m; return dropStrapGeo;
}
let woodMat: THREE.Material | null = null;
function dropWoodMat() {
  if (woodMat) return woodMat;
  const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d')!;
  g.fillStyle = '#9a6a37'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 21) { g.fillStyle = y % 42 ? '#8c5f31' : '#a5733d'; g.fillRect(0, y, 128, 19); g.fillStyle = 'rgba(40,24,10,0.55)'; g.fillRect(0, y + 19, 128, 2); }
  g.strokeStyle = 'rgba(40,24,10,0.6)'; g.lineWidth = 6; g.beginPath(); g.moveTo(8, 8); g.lineTo(120, 120); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  woodMat = sharedMat(new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 })); return woodMat;
}
const tierMats = new Map<number, THREE.Material>();
function tierMat(c: number) { let m = tierMats.get(c); if (!m) { m = sharedMat(new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.5 })); tierMats.set(c, m); } return m; }
const canopyMats = new Map<number, THREE.Material>();
function canopyMat(c: number) {
  let m = canopyMats.get(c);
  if (!m) {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 8; const g = cv.getContext('2d')!;
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f4f4f2' : `#${new THREE.Color(c).getHexString()}`; g.fillRect(i * 16, 0, 16, 8); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    m = sharedMat(new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.7 })); canopyMats.set(c, m);
  }
  return m;
}
let smokeT: THREE.Texture | null = null;
function smokeTex() {
  if (smokeT) return smokeT;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const gg = c.getContext('2d')!;
  const r = gg.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,90,70,0.8)'); r.addColorStop(1, 'rgba(255,90,70,0)'); gg.fillStyle = r; gg.fillRect(0, 0, 64, 64);
  smokeT = new THREE.CanvasTexture(c); smokeT.userData.shared = true; return smokeT;
}

let LOOT: { geo: Record<string, THREE.BufferGeometry>; mat: Record<string, THREE.Material>; glow: Record<string, THREE.Material>; ring: THREE.BufferGeometry } | null = null;
function lootAssets() {
  if (LOOT) return LOOT;
  const tex = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d')!; g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#e8283a'; g.fillRect(24, 10, 16, 44); g.fillRect(10, 24, 44, 16); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const coins = mergeGeometries([0, 1, 2, 3].map((i) => new THREE.CylinderGeometry(0.45, 0.45, 0.14, 16).translate((i % 2) * 0.08, i * 0.16 - 0.2, 0)), false)!;
  LOOT = {
    geo: { medkit: new THREE.BoxGeometry(1.3, 0.8, 1), shield: new THREE.CylinderGeometry(0.8, 0.8, 0.35, 6).rotateX(Math.PI / 2), coins },
    mat: {
      medkit: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0x401010, emissiveIntensity: 0.3 }),
      shield: new THREE.MeshStandardMaterial({ color: 0x3ea5ff, emissive: 0x1d6fd1, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.3 }),
      coins: new THREE.MeshStandardMaterial({ color: 0xffc23d, emissive: 0x7a5200, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.25 }),
    },
    glow: Object.fromEntries(([['medkit', 0xff6b6b], ['shield', 0x3ea5ff], ['coins', 0xffc23d]] as const).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide })])),
    ring: new THREE.RingGeometry(0.9, 1.3, 24),
  };
  for (const g of [...Object.values(LOOT.geo), LOOT.ring]) g.userData.shared = true;
  for (const m of [...Object.values(LOOT.mat), ...Object.values(LOOT.glow)]) m.userData.shared = true;
  return LOOT;
}

/** shared vertex-coloured materials for baked props (buildings, interiors, lifts) */
const VCM = {
  trim: sharedMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.05 })),
  metal: sharedMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.7 })),
  glow: sharedMat(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.4 })),
};
// emissive tinted by vertex colour (screens, lift arrows, ceiling strips)
VCM.glow.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor;'); };

/** Collects static geometry per material and merges it: thousands of props, a few draw calls. */
class Batch {
  private m = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private mtx = new THREE.Matrix4();
  add(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3 | [number, number, number], rotY = 0, scale?: [number, number, number]) {
    const p = Array.isArray(pos) ? new THREE.Vector3(...pos) : pos;
    this.mtx.compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(...(scale || [1, 1, 1])));
    const g = geo.index ? geo.clone() : geo.clone();
    g.applyMatrix4(this.mtx);
    const list = this.m.get(mat) || [];
    list.push(g); this.m.set(mat, list);
  }
  flush(parent: THREE.Object3D, shadows = true) {
    for (const [mat, list] of this.m) {
      const geo = mergeGeometries(list, false);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadows; mesh.receiveShadow = true;
      // Flat ground layers (footpaths, car parks, roads, lane paint) lie a few cm apart and overlap
      // at junctions. Drawing them strictly in layer order, pulled towards the camera and without
      // writing depth, stops them flickering (z-fighting) when the camera is far away.
      const layer = (mat.userData as any).groundLayer as number | undefined;
      if (layer) {
        mat.depthWrite = false; mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -4 * layer;
        mesh.renderOrder = layer; mesh.castShadow = false;
      }
      parent.add(mesh);
      list.forEach((g) => g.dispose());
    }
    this.m.clear();
  }
}

type SquadObj = { car: THREE.Group; veh: Vehicle; avatar: Avatar; chute: THREE.Group; parked: Vehicle | null; hpBar: THREE.Sprite; hpKey: string; aimRing: THREE.Mesh;
  ring: THREE.Mesh; label: THREE.Sprite; target: THREE.Vector3; heading: number; turn: number; data: WorldSquad; sig: string; y: number;
  wasChute?: boolean; wasDown?: boolean; wasFree?: boolean; spd?: number };
type Bldg = {
  b: Building; body: THREE.Mesh; extras: THREE.Object3D[]; mats: THREE.MeshStandardMaterial[]; fade: number;
  interior: THREE.Group | null; floors: THREE.Group[]; doors: { mesh: THREE.Mesh; open: number; x: number; y: number; level: number; axis: 'x' | 'z'; home: number }[];
  alarm: THREE.Group; shutter: THREE.Mesh; sealed: boolean; lockLabel: THREE.Sprite | null; lockKey: string; bands: THREE.Mesh[];
};

export class WorldScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'follow';
  zoom = 1;
  yaw = 0;
  liveMe: { current: LiveMe } | null = null;
  /** world events for sound and the HUD: 'dropLanded', 'chuteOpen', 'landed', 'shot' */
  onEvent?: (kind: string, p?: THREE.Vector3) => void;
  disposed = false;
  private raf = 0;
  private clock = new THREE.Clock();
  private pads: THREE.Mesh[] = [];
  private labels: { sprite: THREE.Sprite; pos: THREE.Vector3; id: string; level: number; bldg: string | null; inB?: boolean }[] = [];
  private squads = new Map<string, SquadObj>();
  private drops = new Map<string, THREE.Group>();
  private battles = new Map<string, THREE.Group>();
  private loot = new Map<string, THREE.Object3D>();
  private bldgs: Bldg[] = [];
  private zoneWall!: THREE.Mesh;
  private zoneOutside!: THREE.Mesh;
  private nextRing!: THREE.Mesh;
  private red!: THREE.Group;
  private redAt = 0;
  private wallTex!: THREE.Texture;
  private zoneR = -1;
  private sun!: THREE.DirectionalLight;
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3(0, 260, 220);
  private focus = new THREE.Vector3();
  private locs = new Map<string, MapData['locations'][number]>();
  private ro: ResizeObserver;
  private onPick?: (id: string) => void;
  private reduced: boolean;
  private lowEnd: boolean;
  quality: Quality;
  private preset: Preset;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private monitor = new FrameMonitor();
  vfx!: VFX;
  private shake = 0;
  private zoneTime = { value: 0 };
  private myHp: number | null = null;
  private adaptive: AdaptiveResolution;
  private fpsOverlay: FpsOverlay | null = null;
  private lastFrame = 0;
  private onQuality = (e: Event) => this.applyQuality((e as CustomEvent).detail as Quality);
  private onFps = () => this.syncFpsOverlay();
  private highlightRing!: THREE.Mesh;
  private hlId: string | null = null;
  private crateMats: Record<string, THREE.Material> | null = null;
  private ray = new THREE.Raycaster();
  private animated: THREE.Object3D[] = [];
  private water: THREE.Points | null = null;
  private waypoint!: THREE.Group;
  private routeLine!: THREE.Mesh;
  private routeTo: THREE.Vector3 | null = null;
  private trees: { p: THREE.Vector3; s: number; palm: boolean }[] = [];
  private treeMeshes: THREE.InstancedMesh[] = [];
  private treeHidden = '';
  private lock: NonNullable<WorldState['lock']> = [];
  private myLevel = 0;
  private myBldg: string | null = null;
  private beacon: THREE.Mesh | null = null;
  private zoneData: WorldState['zone'] = null;
  private zoneT = 0;
  private plane: THREE.Group | null = null;
  private planeData: WorldState['plane'] = null;
  private fpv = false;
  private pitch = -0.05;
  private targetKey: string | null = null;
  private climb: { t0: number; from: THREE.Vector3; to: THREE.Vector3; dir: number } | null = null;
  private lastLevel = 0;
  private lastBldg: string | null = null;
  private jumpAt = 0;
  private chuteAt = 0;
  private boardAt = 0;
  private fovKick = 0;
  /** big-screen cut to a new airdrop: where and since when */
  private dropCut: { p: THREE.Vector3; t0: number } | null = null;
  private seenDrops = new Set<string>();
  private amb: Ambience;
  private ambAt = 0;

  constructor(private canvas: HTMLCanvasElement, map: MapData, opts: { onPick?: (id: string) => void; mode?: CameraMode; onEvent?: (kind: string, p?: THREE.Vector3) => void } = {}) {
    this.onPick = opts.onPick;
    this.mode = opts.mode || 'follow';
    this.reduced = document.documentElement.classList.contains('reduced-motion');
    this.quality = currentQuality();
    this.preset = PRESETS[this.quality];
    this.lowEnd = this.quality === 'low';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.preset.antialias, powerPreference: 'high-performance' });
    this.adaptive = new AdaptiveResolution((sc) => this.setRenderScale(sc));
    this.renderer.info.autoReset = false; // count every pass of a frame (bloom included)
    this.renderer.setPixelRatio(this.baseDpr());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 2600);
    this.camera.position.copy(this.camPos);
    const haze = 0xcfe3f2;
    this.scene.background = new THREE.Color(haze);
    this.scene.fog = new THREE.Fog(haze, 380, this.preset.fogFar);

    this.buildSky();
    // soft reflections so car paint, glass and steel pick up light like the real things
    // outdoor reflections: glass and car paint mirror this campus sky (blue above, warm sun, green-grey ground)
    this.scene.environment = skyEnvironment(this.renderer); this.scene.environmentIntensity = 0.5;
    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5d7a3f, 0.85));
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.5);
    this.sun.castShadow = this.preset.shadows;
    this.sun.shadow.mapSize.set(this.preset.shadowSize || 1024, this.preset.shadowSize || 1024);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1; sc.far = 400;
    this.scene.add(this.sun, this.sun.target);

    for (const l of map.locations) this.locs.set(l.id, l);
    const ft = (FEATURES as any[]).find((f) => f.kind === 'fountain');
    this.amb = new Ambience({ fountain: ft ? (() => { const c = W(ft.x, ft.y); return { x: c.x, y: 2, z: c.z }; })() : null, lowEnd: this.quality === 'low' });
    this.buildWorld(map);
    this.buildZone();

    this.highlightRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.highlightRing.rotation.x = -Math.PI / 2; this.highlightRing.position.y = 0.35; this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);
    this.waypoint = new THREE.Group();
    const wb = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 120, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    wb.position.y = 60;
    const wr = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.4, 32), new THREE.MeshBasicMaterial({ color: 0xffd23d, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    wr.rotation.x = -Math.PI / 2; wr.position.y = 0.4; wr.name = 'ring';
    this.waypoint.add(wb, wr); this.waypoint.visible = false;
    this.routeLine = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    this.routeLine.rotation.x = -Math.PI / 2; this.routeLine.visible = false;
    this.scene.add(this.waypoint, this.routeLine);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this.bindInput();
    this.vfx = new VFX(this.scene);
    this.vfx.density = this.reduced ? Math.min(0.3, this.preset.particles) : this.preset.particles;
    this.setupPost();
    window.addEventListener('hb:quality', this.onQuality);
    window.addEventListener('hb:fps', this.onFps);
    this.syncFpsOverlay();
    (window as any).__hexaWorld = this; // dev/perf tooling: renderer.info, frame times
    const user = opts.onEvent; this.onEvent = (kind, p) => {
      if (p) { if (kind === 'dropLanded') this.amb.at('thud', p); else if (kind === 'chuteOpen') this.amb.at('chute', p); else if (kind === 'landed') this.amb.at('land', p); }
      user?.(kind, p);
    };
    this.loop();
  }

  // ── sky dome with sun glow and drifting clouds; hazy hills on the horizon ──
  private buildSky() {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(2200, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x2f7fd6) }, mid: { value: new THREE.Color(0x8fc4f0) }, bottom: { value: new THREE.Color(0xdcecf7) }, sunDir: { value: new THREE.Vector3(-0.4, 0.55, 0.3).normalize() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.15 ? mix(mid, top, smoothstep(0.15, 0.7, h)) : mix(bottom, mid, smoothstep(-0.05, 0.15, h));
        float s = max(dot(vP, sunDir), 0.0); c += vec3(1.0,0.92,0.75) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0); }`,
    }));
    sky.renderOrder = -10;
    this.scene.add(sky);
    const cloud = canvasTex(256, 128, (g) => {
      for (let i = 0; i < 9; i++) {
        const x = 50 + Math.random() * 156; const y = 50 + Math.random() * 30; const r = 26 + Math.random() * 30;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    });
    const cm = new THREE.SpriteMaterial({ map: cloud, transparent: true, depthWrite: false, fog: false, opacity: 0.9 });
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Sprite(cm);
      const a = (i / 18) * Math.PI * 2; const d = 500 + Math.random() * 500;
      s.position.set(Math.cos(a) * d, 180 + Math.random() * 120, Math.sin(a) * d);
      s.scale.set(300 + Math.random() * 160, 120 + Math.random() * 60, 1);
      s.userData.cloud = true;
      this.animated.push(s);
      this.scene.add(s);
    }
    // far city blocks / hills so the horizon is not empty
    const far = new Batch();
    const farMat = new THREE.MeshLambertMaterial({ color: 0xa9bccb, fog: true });
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + Math.random() * 0.05; const d = 520 + Math.random() * 260;
      const h = 15 + Math.random() * 55; const w = 18 + Math.random() * 30;
      far.add(new THREE.BoxGeometry(w, h, w * 0.8), farMat, [Math.cos(a) * d, h / 2, Math.sin(a) * d], a);
    }
    far.flush(this.scene, false);
  }

  private buildWorld(map: MapData) {
    const batch = new Batch();
    const M = {
      road: new THREE.MeshStandardMaterial({ map: noiseTex('#3b3f45', ['#44484f', '#34373c', '#4b4f56'], 4000, [40, 40], 256, 2), roughness: 0.95 }),
      walk: new THREE.MeshStandardMaterial({ map: canvasTex(128, 128, (g) => { g.fillStyle = '#c8c1b2'; g.fillRect(0, 0, 128, 128); g.strokeStyle = 'rgba(80,70,60,0.25)'; g.lineWidth = 2; for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); } }, [60, 60]), roughness: 0.9 }),
      curb: new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.8 }),
      lane: new THREE.MeshBasicMaterial({ color: 0xf2efe4 }),
      yellow: new THREE.MeshBasicMaterial({ color: 0xf2c53d }),
      lot: new THREE.MeshStandardMaterial({ map: noiseTex('#4a4e55', ['#52565d', '#43474d'], 2500, [20, 20], 256, 2), roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x59606a, roughness: 0.4, metalness: 0.7 }),
      lampHead: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0b0, emissiveIntensity: 0.6 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.85 }),
      paving: new THREE.MeshStandardMaterial({ map: canvasTex(128, 128, (g) => { g.fillStyle = '#d6cdbb'; g.fillRect(0, 0, 128, 128); g.strokeStyle = 'rgba(120,100,80,0.28)'; g.lineWidth = 2; for (let i = 0; i <= 128; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); } }, [24, 24]), roughness: 0.9 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.8 }),
      hedge: new THREE.MeshStandardMaterial({ color: 0x3c7a33, roughness: 1 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.6 }),
      glassDark: new THREE.MeshStandardMaterial({ color: 0x1d3550, roughness: 0.15, metalness: 0.6 }),
      solar: new THREE.MeshStandardMaterial({ color: 0x1c3260, roughness: 0.25, metalness: 0.6 }),
      water: new THREE.MeshStandardMaterial({ color: 0x3aa3d8, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.88 }),
      turf: new THREE.MeshStandardMaterial({ color: 0x4aa24f, roughness: 1 }),
      clay: new THREE.MeshStandardMaterial({ color: 0xc9a46b, roughness: 1 }),
      red: new THREE.MeshStandardMaterial({ color: 0xd8423a, roughness: 0.6 }),
      livery: new THREE.MeshStandardMaterial({ color: 0x1d4f91, roughness: 0.4 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.95 }),
      vcTrim: VCM.trim,
      vcMetal: VCM.metal,
      doorGlass: new THREE.MeshStandardMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.45, roughness: 0.05, metalness: 0.4 }),
    };
    // ground layers, bottom to top (see Batch.flush)
    ([[M.walk, 1], [M.turf, 1], [M.lot, 2], [M.paving, 2], [M.clay, 2], [M.road, 3], [M.lane, 4]] as [THREE.Material, number][]).forEach(([m, n]) => { m.userData.groundLayer = n; });
    const P = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
      plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      disc: new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
      shrub: new THREE.IcosahedronGeometry(1, 1),
      wheelZ: new THREE.CylinderGeometry(0.5, 0.5, 1, 12).rotateX(Math.PI / 2),
    };

    // ground + campus boundary
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshLambertMaterial({ map: grassTex([210, 210]) }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    this.scene.add(ground);
    const wallH = 2.4;
    const gaps = map.locations.filter((l) => l.kind === 'gate');
    const wallSeg = (x0: number, y0: number, x1: number, y1: number) => {
      const a = W(x0, y0); const b = W(x1, y1); const len = a.distanceTo(b); if (len < 1) return;
      const mid = a.clone().add(b).multiplyScalar(0.5); const ang = Math.atan2(b.x - a.x, b.z - a.z);
      batch.add(P.box, M.concrete, [mid.x, wallH / 2, mid.z], ang, [0.7, wallH, len]);
      batch.add(P.box, M.hedge, [mid.x, 0.9, mid.z], ang, [2.2, 1.8, len]);
    };
    // perimeter with openings at the gates
    const edges: [number, number, number, number][] = [[0.005, 0.005, 0.995, 0.005], [0.995, 0.005, 0.995, 0.995], [0.995, 0.995, 0.005, 0.995], [0.005, 0.995, 0.005, 0.005]];
    for (const [x0, y0, x1, y1] of edges) {
      const cuts = gaps.map((g) => (y0 === y1 ? (Math.abs(g.y - y0) < 0.06 ? g.x : null) : (Math.abs(g.x - x0) < 0.06 ? g.y : null))).filter((v) => v !== null) as number[];
      const lo = y0 === y1 ? Math.min(x0, x1) : Math.min(y0, y1); const hi = y0 === y1 ? Math.max(x0, x1) : Math.max(y0, y1);
      let s = lo;
      for (const c of cuts.sort()) { const e = c - 0.025; if (e > s) wallSeg(y0 === y1 ? s : x0, y0 === y1 ? y0 : s, y0 === y1 ? e : x0, y0 === y1 ? y0 : e); s = c + 0.025; }
      if (hi > s) wallSeg(y0 === y1 ? s : x0, y0 === y1 ? y0 : s, y0 === y1 ? hi : x0, y0 === y1 ? y0 : hi);
    }
    // outside road (SIPCOT side)
    batch.add(P.plane, M.road, [0, 0.05, 0.53 * S], 0, [S * 1.6, 1, 16]);

    // ── streets ──
    const roadSegs: number[][] = [];
    const lampPts: { p: THREE.Vector3; a: number }[] = [];
    const edges2: { p: THREE.Vector3; a: number; len: number }[] = [];
    const benches: { p: THREE.Vector3; a: number }[] = [];
    const dashes: { p: THREE.Vector3; a: number }[] = [];
    const zebra: { p: THREE.Vector3; a: number }[] = [];
    for (const r of ROADS) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, ay] = r.pts[i]; const [bx, by] = r.pts[i + 1];
        const a = W(ax, ay); const b = W(bx, by); const len = a.distanceTo(b);
        const mid = a.clone().add(b).multiplyScalar(0.5); const ang = Math.atan2(b.x - a.x, b.z - a.z);
        const w = r.w * S;
        batch.add(P.plane, M.walk, [mid.x, 0.06, mid.z], ang, [w + 7, 1, len + w + 7]);
        batch.add(P.box, M.curb, [mid.x, 0.1, mid.z], ang, [w + 0.6, 0.16, len + w]);
        batch.add(P.plane, M.road, [mid.x, 0.26, mid.z], ang, [w, 1, len + w]);
        for (let d = 3; d < len - 3; d += 6) dashes.push({ p: a.clone().lerp(b, d / len), a: ang });
        if (len > 46) {
          const across = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang));
          for (const d of [w / 2 + 9, len - w / 2 - 9]) {
            const c = a.clone().lerp(b, d / len);
            for (let k = -w / 2 + 0.6; k < w / 2 - 0.3; k += 1.1) zebra.push({ p: c.clone().addScaledVector(across, k), a: ang });
          }
        }
        const side = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(w / 2 + 2.6);
        for (let d = 8; d < len - 4; d += 34) { const p = a.clone().lerp(b, d / len); lampPts.push({ p: p.clone().add(side), a: ang + Math.PI / 2 }); lampPts.push({ p: p.clone().sub(side), a: ang - Math.PI / 2 }); }
        // solid edge lines either side of the carriageway
        const edgeOff = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(w / 2 - 0.45);
        edges2.push({ p: mid.clone().add(edgeOff), a: ang, len: Math.max(0, len - w) }, { p: mid.clone().sub(edgeOff), a: ang, len: Math.max(0, len - w) });
        for (let d = 25; d < len - 12; d += 68) { const pp = a.clone().lerp(b, d / len); benches.push({ p: pp.clone().add(side.clone().multiplyScalar(1.25)), a: ang }); }
        roadSegs.push([ax, ay, bx, by, r.w]);
      }
    }
    for (const d of dashes) batch.add(P.plane, M.lane, [d.p.x, 0.3, d.p.z], d.a, [0.22, 1, 2.6]);
    for (const z of zebra) batch.add(P.plane, M.lane, [z.p.x, 0.3, z.p.z], z.a, [0.55, 1, 3.4]);
    for (const e of edges2) if (e.len > 2) batch.add(P.plane, M.lane, [e.p.x, 0.3, e.p.z], e.a, [0.18, 1, e.len]);
    // street lamps: base, tapered post, an arm reaching over the kerb and a flat LED head
    for (const { p, a } of lampPts) {
      const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      batch.add(P.cyl, M.concrete, [p.x, 0.25, p.z], 0, [0.6, 0.5, 0.6]);
      batch.add(P.cyl6, M.metal, [p.x, 3.4, p.z], 0, [0.2, 6.6, 0.2]);
      const arm = p.clone().addScaledVector(out, 0.9);
      batch.add(P.box, M.metal, [arm.x, 6.6, arm.z], a, [0.12, 0.12, 1.9]);
      const hd = p.clone().addScaledVector(out, 1.75);
      batch.add(P.box, M.metal, [hd.x, 6.55, hd.z], a, [0.5, 0.16, 0.9]);
      batch.add(P.box, M.lampHead, [hd.x, 6.45, hd.z], a, [0.4, 0.06, 0.75]);
    }
    // benches and bins along the footpaths
    for (const { p, a } of benches) {
      batch.add(P.box, M.wood, [p.x, 0.48, p.z], a, [0.5, 0.08, 2]);
      batch.add(P.box, M.wood, [p.x + Math.cos(a) * 0.22, 0.78, p.z - Math.sin(a) * 0.22], a, [0.08, 0.5, 2]);
      for (const k of [-0.8, 0.8]) batch.add(P.box, M.metal, [p.x + Math.sin(a) * k, 0.24, p.z + Math.cos(a) * k], a, [0.5, 0.48, 0.08]);
      batch.add(P.cyl, M.metal, [p.x + Math.sin(a) * 1.7, 0.45, p.z + Math.cos(a) * 1.7], 0, [0.5, 0.9, 0.5]);
    }

    // ── parking yards: bays, parked cars, carports ──
    const carCols = [0xd23b3b, 0xf2f2f2, 0x2a6bd1, 0x222222, 0xc0c4c8, 0xf0b429, 0x6a7b8c, 0xffffff, 0x8a1c1c];
    const cars: { p: THREE.Vector3; a: number; c: number }[] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const lot of LOTS) {
      const a = W(lot.x0, lot.y0); const b = W(lot.x1, lot.y1);
      const w = b.x - a.x; const d = b.z - a.z; const cx = (a.x + b.x) / 2; const cz = (a.z + b.z) / 2;
      batch.add(P.plane, M.lot, [cx, 0.08, cz], 0, [w, 1, d]);
      batch.add(P.box, M.curb, [cx, 0.15, a.z], 0, [w, 0.25, 0.5]); batch.add(P.box, M.curb, [cx, 0.15, b.z], 0, [w, 0.25, 0.5]);
      const rowD = d / lot.rows;
      for (let r = 0; r < lot.rows; r++) {
        const rz = a.z + rowD * (r + 0.5);
        const facing = r % 2 ? Math.PI : 0;
        const bayZ = rz + (r % 2 ? -1 : 1) * rowD * 0.18;
        for (let x = a.x + 3; x < b.x - 3; x += 3.2) {
          batch.add(P.plane, M.lane, [x, 0.12, bayZ], 0, [0.15, 1, 5.2]);
          if (rnd() < 0.72) cars.push({ p: new THREE.Vector3(x + 1.6, 0, bayZ), a: facing, c: carCols[Math.floor(rnd() * carCols.length)] });
        }
        if (lot.roof && r % 2 === 0) {
          // solar carport over the row
          batch.add(P.box, M.solar, [cx, 4.4, bayZ], 0, [w - 4, 0.25, 6.4]);
          for (let x = a.x + 4; x < b.x - 3; x += 12) batch.add(P.cyl6, M.metal, [x, 2.2, bayZ - 2.6], 0, [0.25, 4.4, 0.25]);
        }
      }
      for (let x = a.x + 6; x < b.x; x += 22) { batch.add(P.cyl6, M.metal, [x, 3.5, cz], 0, [0.25, 7, 0.25]); batch.add(P.box, M.lampHead, [x, 7, cz], 0, [1.6, 0.25, 0.5]); }
    }
    // bus bay: shelter + parked shuttles
    const busbay = FEATURES.find((f: any) => f.kind === 'busbay');
    if (busbay) {
      const a = W(busbay.x0, busbay.y0); const b = W(busbay.x1, busbay.y1);
      batch.add(P.plane, M.lot, [(a.x + b.x) / 2, 0.08, (a.z + b.z) / 2], 0, [b.x - a.x, 1, b.z - a.z]);
      batch.add(P.box, M.glassDark, [(a.x + b.x) / 2, 3.2, a.z + 2], 0, [b.x - a.x - 6, 0.25, 3.5]);
      for (let k = 0; k < 3; k++) {
        const x = a.x + 10 + k * 13; const z = (a.z + b.z) / 2 + 2;
        // campus shuttle: white body, tinted window band, blue livery stripe, windscreen, wheels
        batch.add(P.box, M.white, [x, 1.95, z], Math.PI / 2, [2.6, 2.7, 11]);
        batch.add(P.box, M.white, [x, 3.35, z], Math.PI / 2, [2.4, 0.15, 10.6]);
        batch.add(P.box, M.glassDark, [x, 2.55, z], Math.PI / 2, [2.66, 1.05, 9.6]);
        batch.add(P.box, M.glassDark, [x - 5.52, 2.3, z], Math.PI / 2, [2.3, 1.6, 0.06]);
        batch.add(P.box, M.livery, [x, 1.45, z], Math.PI / 2, [2.64, 0.32, 11.02]);
        for (const wx of [-3.6, 3.4]) for (const sz of [-1, 1]) batch.add(P.wheelZ, M.tyre, [x + wx, 0.55, z + sz * 1.25], 0, [1.1, 1.1, 0.3]);
      }
    }
    // parked cars (instanced): a rounded sedan shell, a glass cabin and four wheels — 3 draw calls for all of them
    const sedan = (() => {
      const sh = new THREE.Shape(); const pts: [number, number][] = [[-2.15, 0.25], [-2.2, 0.62], [-1.9, 0.78], [-0.95, 0.82], [0.9, 0.82], [1.95, 0.74], [2.15, 0.5], [2.1, 0.25]];
      sh.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts.slice(1)) sh.lineTo(x, y); sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 1.72, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 2 });
      g.translate(0, 0, -0.86); g.rotateY(-Math.PI / 2); g.computeVertexNormals(); return g;
    })();
    const cabin = (() => {
      const sh = new THREE.Shape(); const pts: [number, number][] = [[-1.0, 0.8], [-0.55, 1.32], [0.75, 1.32], [1.25, 0.8]];
      sh.moveTo(pts[0][0], pts[0][1]); for (const [x, y] of pts.slice(1)) sh.lineTo(x, y); sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1 });
      g.translate(0, 0, -0.75); g.rotateY(-Math.PI / 2); g.computeVertexNormals(); return g;
    })();
    const carBody = new THREE.InstancedMesh(sedan, new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }), Math.max(1, cars.length));
    const carCab = new THREE.InstancedMesh(cabin, new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.08, metalness: 0.7 }), Math.max(1, cars.length));
    const carWheel = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.9 }), Math.max(1, cars.length * 4));
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1); const col = new THREE.Color();
    const wOff = [[-0.82, -1.35], [0.82, -1.35], [-0.82, 1.35], [0.82, 1.35]];
    cars.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.a + (rnd() - 0.5) * 0.06);
      m4.compose(new THREE.Vector3(c.p.x, 0.12, c.p.z), q, one); carBody.setMatrixAt(i, m4); carCab.setMatrixAt(i, m4);
      wOff.forEach(([wx, wz], k) => { const off = new THREE.Vector3(wx, 0.34, wz).applyQuaternion(q); m4.compose(off.add(c.p), q, one); carWheel.setMatrixAt(i * 4 + k, m4); });
      carBody.setColorAt(i, col.setHex(c.c));
    });
    carBody.count = carCab.count = cars.length; carWheel.count = cars.length * 4;
    carBody.castShadow = true; carBody.receiveShadow = true;
    this.scene.add(carBody, carCab, carWheel);

    // ── open-ground features ──
    for (const f of FEATURES as any[]) {
      if (f.kind === 'plaza') {
        const c = W(f.x, f.y);
        batch.add(P.disc, M.paving, [c.x, 0.1, c.z], 0, [f.r * S, 1, f.r * S]);
        // benches and planters around the ring
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2; const r = f.r * S * 0.62;
          const p = new THREE.Vector3(c.x + Math.cos(a) * r, 0, c.z + Math.sin(a) * r);
          if (i % 2) { batch.add(P.box, M.wood, [p.x, 0.5, p.z], -a, [0.6, 0.12, 2.2]); batch.add(P.box, M.metal, [p.x, 0.25, p.z], -a, [0.5, 0.5, 0.15]); }
          else { batch.add(P.cyl, M.concrete, [p.x, 0.5, p.z], 0, [2.4, 1, 2.4]); batch.add(P.cyl, M.hedge, [p.x, 1.2, p.z], 0, [2, 0.6, 2]); }
        }
        // flag poles
        for (let i = 0; i < 3; i++) { batch.add(P.cyl6, M.metal, [c.x - 6 + i * 6, 6, c.z + f.r * S * 0.85], 0, [0.2, 12, 0.2]); }
      } else if (f.kind === 'fountain') {
        const c = W(f.x, f.y); const r = f.r * S;
        batch.add(P.cyl, M.concrete, [c.x, 0.5, c.z], 0, [r * 2, 1, r * 2]);
        batch.add(P.cyl, M.water, [c.x, 0.95, c.z], 0, [r * 1.85, 0.12, r * 1.85]);
        batch.add(P.cyl, M.concrete, [c.x, 1.8, c.z], 0, [r * 0.5, 2.2, r * 0.5]);
        batch.add(P.cyl, M.concrete, [c.x, 2.9, c.z], 0, [r * 0.95, 0.3, r * 0.95]);
        batch.add(P.cyl, M.water, [c.x, 3.1, c.z], 0, [r * 0.85, 0.12, r * 0.85]);
        batch.add(P.cyl, M.concrete, [c.x, 4.1, c.z], 0, [1.2, 2, 1.2]);
        // animated water: arcs of droplets from the top and the rim
        const N = this.lowEnd ? 300 : 700;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
        const seeds = new Float32Array(N * 4);
        for (let i = 0; i < N; i++) { seeds[i * 4] = Math.random() * Math.PI * 2; seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = i < N * 0.4 ? 0 : 1; seeds[i * 4 + 3] = 0.8 + Math.random() * 0.4; }
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdff4ff, size: 0.35, transparent: true, opacity: 0.85, depthWrite: false }));
        pts.userData = { seeds, c, r };
        pts.frustumCulled = false;
        this.water = pts; this.scene.add(pts);
      } else if (f.kind === 'steps') {
        const c = W(f.x, f.y);
        for (let k = 0; k < 5; k++) batch.add(P.box, M.concrete, [c.x, (k + 1) * 0.15, c.z + (2 - k) * 1.4], 0, [f.w * S, (k + 1) * 0.3, 1.4]);
      } else if (f.kind === 'cricket') {
        const c = W(f.x, f.y);
        batch.add(P.disc, M.turf, [c.x, 0.07, c.z], 0, [f.rx * S, 1, f.ry * S]);
        batch.add(P.plane, M.clay, [c.x, 0.09, c.z], 0, [3, 1, 20]);
        for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; batch.add(P.box, M.white, [c.x + Math.cos(a) * f.rx * S * 0.97, 0.25, c.z + Math.sin(a) * f.ry * S * 0.97], -a, [0.3, 0.3, 2]); }
        for (const s of [-1, 1]) batch.add(P.box, M.white, [c.x, 3, c.z + s * f.ry * S * 0.9], 0, [8, 6, 0.4]);
        for (const s of [-1, 1]) for (const k of [-0.25, 0, 0.25]) batch.add(P.cyl6, M.wood, [c.x + k, 0.4, c.z + s * 10], 0, [0.08, 0.8, 0.08]);
      } else if (f.kind === 'court') {
        const c = W(f.x, f.y); const w = f.w * S; const d = f.d * S;
        const turf = new THREE.MeshStandardMaterial({ map: canvasTex(256, 160, (g) => { g.fillStyle = '#2f7fb8'; g.fillRect(0, 0, 256, 160); g.fillStyle = '#3f9b49'; g.fillRect(14, 14, 228, 132); g.strokeStyle = '#f4f4f4'; g.lineWidth = 4; g.strokeRect(14, 14, 228, 132); g.beginPath(); g.moveTo(128, 14); g.lineTo(128, 146); g.stroke(); }), roughness: 1 });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), turf); m.position.set(c.x, 0.1, c.z); m.receiveShadow = true; this.scene.add(m);
        batch.add(P.box, M.white, [c.x, 0.6, c.z], 0, [0.12, 1.2, d * 0.8]);
        for (const s of [-1, 1]) batch.add(P.box, M.metal, [c.x + s * w / 2, 1.5, c.z], 0, [0.1, 3, d]);
      } else if (f.kind === 'amphi') {
        const c = W(f.x, f.y); const r = f.r * S;
        for (let k = 0; k < 5; k++) {
          for (let i = 0; i < 9; i++) { const a = Math.PI * 0.15 + (i / 8) * Math.PI * 0.7; const rr = r * (0.5 + k * 0.12); batch.add(P.box, M.concrete, [c.x + Math.cos(a) * rr, (k + 1) * 0.225, c.z - Math.sin(a) * rr], -a + Math.PI / 2, [rr * 0.36, (k + 1) * 0.45, 2.2]); }
        }
        batch.add(P.box, M.wood, [c.x, 0.5, c.z + r * 0.15], 0, [r * 0.8, 1, r * 0.35]);
      } else if (f.kind === 'helipad') {
        const c = W(f.x, f.y); const r = f.r * S;
        const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: canvasTex(256, 256, (g) => { g.fillStyle = '#3d4249'; g.fillRect(0, 0, 256, 256); g.strokeStyle = '#f2c53d'; g.lineWidth = 10; g.beginPath(); g.arc(128, 128, 110, 0, Math.PI * 2); g.stroke(); g.fillStyle = '#ffffff'; g.font = '900 150px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', 128, 136); }), roughness: 0.9 }));
        pad.position.set(c.x, 0.12, c.z); pad.receiveShadow = true; this.scene.add(pad);
      } else if (f.kind === 'solar') {
        const a = W(f.x0, f.y0); const b = W(f.x1, f.y1);
        for (let z = a.z + 3; z < b.z - 2; z += 6) for (let x = a.x + 3; x < b.x - 2; x += 5.5) {
          batch.add(P.box, M.solar, [x, 1.4, z], 0, [5, 0.12, 3.2]);
          batch.add(P.cyl6, M.metal, [x, 0.7, z + 1], 0, [0.15, 1.4, 0.15]);
        }
      } else if (f.kind === 'pond') {
        const c = W(f.x, f.y);
        batch.add(P.disc, M.concrete, [c.x, 0.06, c.z], 0, [f.rx * S + 1.5, 1, f.ry * S + 1.5]);
        batch.add(P.disc, M.water, [c.x, 0.14, c.z], 0, [f.rx * S, 1, f.ry * S]);
        for (let i = 0; i < 14; i++) batch.add(P.disc, M.hedge, [c.x + (rnd() - 0.5) * f.rx * S * 1.4, 0.18, c.z + (rnd() - 0.5) * f.ry * S * 1.4], 0, [1.1, 1, 1.1]);
      } else if (f.kind === 'tower') {
        const c = W(f.x, f.y);
        for (const [dx, dz] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) batch.add(P.cyl6, M.metal, [c.x + dx, 9, c.z + dz], 0, [0.5, 18, 0.5]);
        batch.add(P.cyl, M.white, [c.x, 21, c.z], 0, [9, 6, 9]);
        batch.add(new THREE.ConeGeometry(5, 2.5, 16), M.red, [c.x, 25.2, c.z]);
      }
    }

    // ── gates: pillars, arch, boom barrier, guard booth ──
    for (const l of map.locations.filter((l) => l.kind === 'gate')) {
      const c = W(l.x, l.y);
      const horiz = Math.abs(l.y - 0.5) > Math.abs(l.x - 0.5);
      const off = new THREE.Vector3(horiz ? 7 : 0, 0, horiz ? 0 : 7);
      for (const sgn of [-1, 1]) batch.add(P.box, M.concrete, c.clone().addScaledVector(off, sgn).setY(3.5), 0, [1.8, 7, 1.8]);
      batch.add(P.box, new THREE.MeshStandardMaterial({ color: 0x1d4f91, roughness: 0.5 }), [c.x, 7.4, c.z], 0, horiz ? [16, 1.4, 1.4] : [1.4, 1.4, 16]);
      batch.add(P.box, M.red, [c.x, 1.2, c.z], 0, horiz ? [10, 0.22, 0.22] : [0.22, 0.22, 10]);
      batch.add(P.box, M.white, c.clone().addScaledVector(off, 1.6).setY(1.5), 0, [3, 3, 3]);
      const sign = labelSprite(l.name.replace(/\s*\(.*\)$/, '').toUpperCase(), '#ffffff', 'rgba(29,79,145,0.85)', 1.5);
      sign.position.set(c.x, 9.6, c.z); this.scene.add(sign);
    }

    // ── buildings ──
    const blds: Building[] = (map.buildings && map.buildings.length ? map.buildings : LAYOUT_BUILDINGS.map(([id]: any) => {
      const b = layoutBuilding(id); return { id: b.id, name: b.name, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, floors: b.floors, stairs: b.stairs, door: b.door, style: b.style };
    }));
    for (const b of blds) this.bldgs.push(this.makeBuilding(b, batch, M, P));

    // ── trees: rows along streets + groves; coconut palms near the plaza and pond ──
    const segD = (x: number, y: number, q: number[]) => { const dx = q[2] - q[0]; const dy = q[3] - q[1]; const l2 = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((x - q[0]) * dx + (y - q[1]) * dy) / l2)); return Math.hypot(x - q[0] - dx * u, y - q[1] - dy * u); };
    const inRect = (x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }, pad: number) => x > r.x0 - pad && x < r.x1 + pad && y > r.y0 - pad && y < r.y1 + pad;
    const blocked = (x: number, y: number) => blds.some((b) => inRect(x, y, b, 0.012)) || LOTS.some((l: any) => inRect(x, y, l, 0.006))
      || roadSegs.some((q) => segD(x, y, q) < q[4] / 2 + 0.01) || map.locations.some((l) => (l.level || 0) === 0 && Math.hypot(l.x - x, l.y - y) < 0.022)
      || (FEATURES as any[]).some((f) => (f.r ? Math.hypot(f.x - x, f.y - y) < f.r + 0.012 : f.rx ? Math.hypot((f.x - x) / (f.rx + 0.01), (f.y - y) / (f.ry + 0.01)) < 1 : f.x0 !== undefined ? inRect(x, y, f, 0.01) : f.w ? Math.abs(f.x - x) < f.w / 2 + 0.01 && Math.abs(f.y - y) < f.d / 2 + 0.01 : false));
    const spots: { x: number; y: number; palm: boolean }[] = [];
    // street rows
    for (const q of roadSegs) {
      const len = Math.hypot(q[2] - q[0], q[3] - q[1]); const nx = -(q[3] - q[1]) / len; const ny = (q[2] - q[0]) / len;
      for (let d = 0.02; d < len; d += 0.026) for (const s of [-1, 1]) {
        const x = q[0] + (q[2] - q[0]) * (d / len) + nx * s * (q[4] / 2 + 0.016); const y = q[1] + (q[3] - q[1]) * (d / len) + ny * s * (q[4] / 2 + 0.016);
        if (x > 0.02 && x < 0.98 && y > 0.02 && y < 0.98 && !blds.some((b) => inRect(x, y, b, 0.006)) && !LOTS.some((l: any) => inRect(x, y, l, 0.003))) spots.push({ x, y, palm: false });
      }
    }
    const N = Math.round(700 * this.preset.decor);
    for (let i = 0; i < 6000 && spots.length < N; i++) {
      const x = 0.02 + rnd() * 0.96; const y = 0.02 + rnd() * 0.96;
      if (blocked(x, y)) continue;
      const nearWater = Math.hypot(x - 0.47, y - 0.44) < 0.12 || Math.hypot(x - 0.06, y - 0.9) < 0.1;
      spots.push({ x, y, palm: nearWater || rnd() < 0.2 });
    }
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 }), spots.length);
    // canopy: three overlapping lumps instead of one ball (one ball on slow phones)
    const lump = (r: number, x: number, y: number, z: number) => new THREE.IcosahedronGeometry(r, this.quality === 'high' ? 1 : 0).translate(x, y, z); // 80 vs 20 faces a lump: the biggest triangle cost on phones
    const crownGeo = this.lowEnd ? new THREE.IcosahedronGeometry(2.1, 1) : mergeGeometries([lump(1.75, 0, 0, 0), lump(1.3, 1.05, -0.45, 0.4), lump(1.2, -0.9, -0.3, -0.7), lump(1.05, 0.1, 0.95, 0.2)])!;
    // fake ambient occlusion + sun: crowns darken toward the inside/bottom and lighten on top
    {
      crownGeo.computeBoundingBox(); const bb = crownGeo.boundingBox!; const pa = crownGeo.getAttribute('position');
      const cols = new Float32Array(pa.count * 3);
      for (let i = 0; i < pa.count; i++) {
        const h = (pa.getY(i) - bb.min.y) / Math.max(0.001, bb.max.y - bb.min.y);
        const k = 0.5 + 0.75 * Math.pow(h, 0.8);
        cols[i * 3] = k * 0.95; cols[i * 3 + 1] = k; cols[i * 3 + 2] = k * 0.85;
      }
      crownGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true }), spots.length);
    const palmT = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.26, 7, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 1 }), spots.length);
    const palmC = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, 1.6, 7, 1, true), new THREE.MeshStandardMaterial({ color: 0x3f8a3a, roughness: 0.9, flatShading: true, side: THREE.DoubleSide }), spots.length);
    let nt = 0; let np = 0;
    for (const s of spots) {
      const p = W(s.x, s.y); const sc = 0.8 + rnd() * 0.6;
      if (s.palm) {
        m4.makeScale(sc, sc, sc).setPosition(p.x, 3.5 * sc, p.z); palmT.setMatrixAt(np, m4);
        m4.makeScale(sc, sc, sc).setPosition(p.x, 7.2 * sc, p.z); palmC.setMatrixAt(np, m4);
        this.trees.push({ p: p.clone(), s: sc, palm: true }); np++;
      } else {
        m4.makeScale(sc, sc, sc).setPosition(p.x, 1.2 * sc, p.z); trunks.setMatrixAt(nt, m4);
        m4.makeScale(sc * 1.1, sc * 1.25, sc * 1.1).setPosition(p.x, 3.4 * sc, p.z); crowns.setMatrixAt(nt, m4);
        crowns.setColorAt(nt, col.setHSL(0.26 + rnd() * 0.08, 0.5, 0.26 + rnd() * 0.12));
        this.trees.push({ p: p.clone(), s: sc, palm: false }); nt++;
      }
    }
    trunks.count = crowns.count = nt; palmT.count = palmC.count = np;
    for (const t of [trunks, crowns, palmT, palmC]) { t.castShadow = true; this.scene.add(t); }
    this.treeMeshes = [trunks, crowns, palmT, palmC];

    // landscaping: clipped shrubs under the trees and along the lots, with a few flowering beds — one draw call
    {
      const NS = Math.round(900 * this.preset.decor);
      const shrubs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), Math.max(1, NS));
      let ns = 0;
      const put = (x: number, y: number, sc: number, flower: boolean) => {
        if (ns >= NS) return; const p = W(x, y);
        m4.compose(new THREE.Vector3(p.x, sc * 0.55, p.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3(sc * 1.3, sc * 0.75, sc * 1.3));
        shrubs.setMatrixAt(ns, m4);
        shrubs.setColorAt(ns, flower ? col.setHSL([0.95, 0.12, 0.83, 0.02][Math.floor(rnd() * 4)], 0.7, 0.55) : col.setHSL(0.24 + rnd() * 0.1, 0.5, 0.2 + rnd() * 0.12));
        ns++;
      };
      for (const t of spots) if (!t.palm && rnd() < 0.55) for (let k = 0; k < 2; k++) { const ox = (rnd() - 0.5) * 0.012; const oy = (rnd() - 0.5) * 0.012; if (!blocked(t.x + ox, t.y + oy)) put(t.x + ox, t.y + oy, 0.6 + rnd() * 0.6, false); }
      for (const lot of LOTS as any[]) for (let x = lot.x0 + 0.004; x < lot.x1; x += 0.006) for (const y of [lot.y0 - 0.006, lot.y1 + 0.006]) if (!blocked(x, y)) put(x, y, 0.7, false);
      for (let i = 0; i < 3000 && ns < NS; i++) {
        const x = 0.03 + rnd() * 0.94; const y = 0.03 + rnd() * 0.94; if (blocked(x, y)) continue;
        // flower bed: a tight cluster of colour
        const flower = rnd() < 0.18; const n = flower ? 7 : 1;
        for (let k = 0; k < n; k++) put(x + (rnd() - 0.5) * 0.008, y + (rnd() - 0.5) * 0.008, flower ? 0.45 + rnd() * 0.2 : 0.6 + rnd() * 0.7, flower);
      }
      shrubs.count = ns; shrubs.receiveShadow = true; shrubs.castShadow = false;
      this.scene.add(shrubs);
    }

    batch.flush(this.scene);

    // ── place rings + labels (outdoors and ground floors; upstairs rooms show inside their building) ──
    for (const l of map.locations) {
      if (l.kind === 'start' || !l.enabled) continue;
      const level = l.level || 0;
      const c = W(l.x, l.y, level);
      // a challenge box (or, at a lift, a lift call pad) instead of a circle on the floor
      const ring = l.kind === 'stairs' ? this.makeLiftPad() : this.makeBox(l.id === 'tr14');
      ring.position.set(c.x, c.y + 0.3, c.z);
      // invisible tap target: never drawn (material.visible = false) but still hit by the picking ray
      const fill = new THREE.Mesh(PICK_GEO, PICK_MAT);
      fill.rotation.x = -Math.PI / 2; fill.position.set(c.x, c.y + 0.3, c.z);
      fill.userData = { id: l.id, ring, level, bldg: level > 0 ? l.building : null };
      this.pads.push(fill);
      this.scene.add(ring, fill);
      const name = l.kind === 'stairs' ? '🛗 LIFT' : SHORT_LABEL[l.id] || l.name.replace(/\s*\(.*\)$/, '').replace(' — Final Battleground', '');
      const sp = labelSprite(name, l.id === 'tr14' ? '#ffd56b' : l.kind === 'stairs' ? '#5dff9e' : '#ffffff', 'rgba(10,16,28,0.7)', 0.7, true);
      sp.position.set(c.x, c.y + 4.2, c.z);
      this.labels.push({ sprite: sp, pos: sp.position.clone(), id: l.id, level, bldg: level > 0 ? l.building : null, inB: !!l.building });
      this.scene.add(sp);
    }
    // Training Room 14 beacon (hidden when you are inside Hexavarsity)
    const tr = this.locs.get('tr14');
    if (tr) {
      const c = W(tr.x, tr.y);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 160, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      beam.position.set(c.x, 80 + FLOOR_H * 4, c.z);
      this.beacon = beam;
      this.scene.add(beam);
    }
    this.setLocRadius(0.018);
  }

  // One building: shell with a facade per storey, rooftop, entrance, lockdown alarm lights and
  // shutters; the interior (floors, rooms, sliding doors, stairs) is built when a squad enters.
  private makeBuilding(b: Building, batch: Batch, M: Record<string, THREE.Material>, P: Record<string, THREE.BufferGeometry>): Bldg {
    const st = STYLE[b.style] || STYLE.office;
    const w = (b.x1 - b.x0) * S; const d = (b.y1 - b.y0) * S; const h = b.floors * FLOOR_H + 0.6;
    const c = W((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    const facade = (len: number) => {
      // one facade image per style and height, shared by every building that looks the same; each side
      // keeps its own repeat through a texture clone of the same source (one upload)
      const fk = `${st.wall}|${st.glass}|${b.floors}|${b.style}`;
      let base = facadeCache.get(fk);
      if (!base) { base = facadeTexture(st.wall, st.glass, b.floors, b.style); facadeCache.set(fk, base); }
      const t = base.clone() as typeof base; t.orm = base.orm!.clone();
      for (const x of [t, t.orm!]) { x.wrapS = THREE.RepeatWrapping; x.repeat.set(Math.max(1, Math.round(len / 10)), 1); x.needsUpdate = true; }
      return new THREE.MeshStandardMaterial({ map: t, roughnessMap: t.orm, metalnessMap: t.orm, roughness: 1, metalness: 1, envMapIntensity: b.style === 'tower' ? 1.3 : 1 });
    };
    const sideX = facade(d); const sideZ = facade(w);
    const roof = new THREE.MeshStandardMaterial({ map: noiseTex(`#${new THREE.Color(st.roof).getHexString()}`, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.06)'], 800, [3, 3], 128), roughness: 0.95 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [sideX, sideX, roof, roof, sideZ, sideZ]);
    body.position.set(c.x, h / 2, c.z);
    body.castShadow = body.receiveShadow = true;
    this.scene.add(body);
    const extras: THREE.Object3D[] = [];
    const add = (m: THREE.Object3D) => { extras.push(m); this.scene.add(m); return m; };
    // every rooftop, entrance and landscaping prop of this building bakes into two meshes (matte + metal)
    const bk = new Baker(); const box = P.box; const cyl = P.cyl;
    const wallC = new THREE.Color(st.wall); const parC = wallC.clone().multiplyScalar(0.85).getHex(); const capC = wallC.clone().lerp(new THREE.Color(0xffffff), 0.35).getHex();
    const bandC = st.band ? new THREE.Color(st.band).getHex() : wallC.clone().multiplyScalar(0.75).getHex();
    for (const [px, pz, pw, pd] of [[0, -d / 2, w, 0.5], [0, d / 2, w, 0.5], [-w / 2, 0, 0.5, d], [w / 2, 0, 0.5, d]] as const) {
      bk.add('trim', box, parC, [c.x + px, h + 0.55, c.z + pz], [0, 0, 0], [pw + 0.5, 1.1, pd + 0.5]);
      bk.add('trim', box, capC, [c.x + px, h + 1.15, c.z + pz], [0, 0, 0], [pw + 0.7, 0.12, pd + 0.7]); // coping
    }
    // corner pilasters give the block a crisp silhouette
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bk.add('trim', box, bandC, [c.x + sx * (w / 2 + 0.05), h / 2, c.z + sz * (d / 2 + 0.05)], [0, 0, 0], [0.9, h, 0.9]);
    // rooftop plant: AC units with fan grilles, a lift machine room, ducts, a water tank on legs
    const nUnits = Math.max(2, Math.min(6, Math.round((w * d) / 260)));
    for (let i = 0; i < nUnits; i++) {
      const ux = c.x + ((i % 3) - 1) * w * 0.22; const uz = c.z + (i < 3 ? 1 : -1) * d * 0.2;
      bk.add('metal', box, 0xb9bec4, [ux, h + 0.85, uz], [0, 0, 0], [2.4, 1.5, 1.8]);
      bk.add('metal', cyl, 0x3a3f46, [ux - 0.55, h + 1.62, uz], [0, 0, 0], [0.95, 0.06, 0.95]);
      bk.add('metal', cyl, 0x3a3f46, [ux + 0.55, h + 1.62, uz], [0, 0, 0], [0.95, 0.06, 0.95]);
    }
    const stp = W(b.stairs[0], b.stairs[1]);
    bk.add('trim', box, capC, [stp.x, h + 1.7, stp.z], [0, 0, 0], [5, 3.2, 5]);
    bk.add('metal', box, 0x4a525c, [stp.x, h + 1.3, stp.z + 2.52], [0, 0, 0], [1.2, 2.2, 0.06]);
    bk.add('metal', box, 0x8d949c, [c.x, h + 0.5, c.z - d * 0.05], [0, 0, 0], [w * 0.55, 0.45, 0.6]); // duct run
    if (b.floors >= 4) {
      const tx = c.x + w * 0.3; const tz = c.z - d * 0.3;
      bk.add('trim', cyl, 0x2f5d8a, [tx, h + 2.6, tz], [0, 0, 0], [2.8, 2.6, 2.8]);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bk.add('metal', box, 0x59606a, [tx + lx, h + 0.8, tz + lz], [0, 0, 0], [0.18, 1.3, 0.18]);
    }
    if (b.style === 'tower') { bk.add('metal', cyl, 0xc9ced6, [c.x - w * 0.3, h + 4, c.z + d * 0.25], [0, 0, 0], [0.25, 6, 0.25]); bk.add('metal', cyl, 0xe8ecf0, [c.x - w * 0.3, h + 1.6, c.z - d * 0.25], [0.6, 0, 0], [2.2, 0.2, 2.2]); }
    if (b.style === 'pavilion') bk.add('trim', box, new THREE.Color(st.roof).getHex(), [c.x, h + 0.2, c.z], [0, 0, 0], [w + 6, 0.6, d + 6]);
    // entrance: canopy on two columns, planters, bollards
    const door = W(b.door[0], b.door[1]);
    const cw = Math.min(14, w * 0.4); const fz = c.z + d / 2;
    bk.add('metal', box, 0x2b3440, [door.x, 3.6, fz + 1.9], [0, 0, 0], [cw, 0.35, 4.2]);
    bk.add('metal', box, 0xdfe5ea, [door.x, 3.82, fz + 1.9], [0, 0, 0], [cw - 0.4, 0.08, 3.8]);
    for (const sx of [-1, 1]) {
      bk.add('metal', cyl, 0x59606a, [door.x + sx * (cw / 2 - 0.6), 1.8, fz + 3.6], [0, 0, 0], [0.32, 3.6, 0.32]);
      bk.add('trim', box, 0xcfc8b8, [door.x + sx * (cw / 2 + 1.6), 0.45, fz + 1.4], [0, 0, 0], [2, 0.9, 2]);
      bk.add('trim', P.shrub, 0x3f7f36, [door.x + sx * (cw / 2 + 1.6), 1.35, fz + 1.4], [0, 0, 0], [1.1, 0.9, 1.1]);
      for (let k = 0; k < 2; k++) bk.add('metal', cyl, 0xe6e2d8, [door.x + sx * (1.5 + k * 2.2), 0.45, fz + 6.4], [0, 0, 0], [0.32, 0.9, 0.32]);
    }
    // landscaping: a clipped hedge along the facades (gap at the door) and shrubs at the corners
    const hedge = (x0: number, x1: number, z: number) => { if (x1 - x0 > 1) bk.add('trim', box, 0x55a044, [(x0 + x1) / 2, 0.55, z], [0, 0, 0], [x1 - x0, 1.1, 1.2]); };
    hedge(c.x - w / 2 + 1, door.x - cw / 2 - 3, fz + 1.2); hedge(door.x + cw / 2 + 3, c.x + w / 2 - 1, fz + 1.2);
    hedge(c.x - w / 2 + 1, c.x + w / 2 - 1, c.z - d / 2 - 1.2);
    let sd = (b.id.length * 7919) % 233;
    const r2 = () => { sd = (sd * 9301 + 49297) % 233280; return sd / 233280; };
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let k = 0; k < 3; k++) {
      const sc = 0.7 + r2() * 0.6; const tint = new THREE.Color().setHSL(0.24 + r2() * 0.1, 0.45, 0.24 + r2() * 0.1).getHex();
      bk.add('trim', P.shrub, tint, [c.x + sx * (w / 2 + 1.6 + r2() * 1.5), 0.7 * sc, c.z + sz * (d / 2 + 1.6 + r2() * 1.5)], [0, r2() * 3, 0], [sc * 1.3, sc, sc * 1.3]);
    }
    const parts = bk.build(false);
    for (const [k, g] of Object.entries(parts)) { const m = new THREE.Mesh(g, k === 'metal' ? M.vcMetal : M.vcTrim); m.castShadow = m.receiveShadow = true; add(m); }
    const parMat = M.vcTrim as THREE.MeshStandardMaterial; const unitMat = M.vcMetal as THREE.MeshStandardMaterial;
    // storey bands (accent stripes) — also used to show which floor is under lockdown
    const bands: THREE.Mesh[] = [];
    for (let f = 1; f < b.floors + 1; f++) {
      // a frame of four strips around the facade (not a slab: the camera can be inside a building)
      const frame = new THREE.BoxGeometry(1, 1, 1);
      const parts = [[0, -d / 2, w + 0.3, 0.3], [0, d / 2, w + 0.3, 0.3], [-w / 2, 0, 0.3, d + 0.3], [w / 2, 0, 0.3, d + 0.3]].map(([px, pz, sx, sz]) =>
        frame.clone().scale(sx, 0.35, sz).translate(px, 0, pz));
      const band = new THREE.Mesh(mergeGeometries(parts, false)!, new THREE.MeshStandardMaterial({ color: bandC, emissive: 0x000000, roughness: 0.6 }));
      band.position.set(c.x, f * FLOOR_H - 0.1, c.z); add(band); bands.push(band);
    }
    const gl = new THREE.Mesh(new THREE.BoxGeometry(Math.min(8, w * 0.25), 3, 0.2), M.doorGlass);
    gl.position.set(door.x, 1.5, c.z + d / 2 + 0.12); add(gl);
    const sign = labelSprite(b.name.toUpperCase(), '#ffffff', 'rgba(20,40,70,0.78)', 2.2);
    sign.position.set(c.x, h + 4.6, c.z); add(sign);
    // lockdown: rotating red beacons on the roof and a steel shutter shell
    const alarm = new THREE.Group();
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.8, 10), new THREE.MeshStandardMaterial({ color: 0xff2238, emissive: 0xff2238, emissiveIntensity: 2 }));
      lamp.position.set(c.x + sx * (w / 2 - 1), h + 1.6, c.z + sz * (d / 2 - 1));
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3, 14, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xff3045, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      cone.rotation.z = Math.PI / 2; cone.position.set(7, 0, 0);
      const pivot = new THREE.Group(); pivot.position.copy(lamp.position); pivot.add(cone);
      alarm.add(lamp, pivot);
    }
    const ring = new THREE.Mesh(new THREE.BoxGeometry(w + 2, h + 2, d + 2), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.BackSide }));
    ring.position.set(c.x, h / 2, c.z); alarm.add(ring);
    alarm.visible = false; this.scene.add(alarm);
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.2, d + 0.4), new THREE.MeshStandardMaterial({
      map: canvasTex(64, 64, (g) => { g.fillStyle = '#5a5f66'; g.fillRect(0, 0, 64, 64); g.fillStyle = 'rgba(0,0,0,0.35)'; for (let y = 0; y < 64; y += 6) g.fillRect(0, y, 64, 2); }, [Math.round(w / 4), Math.round(h / 3)]),
      roughness: 0.6, metalness: 0.5, transparent: true, opacity: 0.94,
    }));
    shutter.position.set(c.x, h / 2, c.z); shutter.visible = false; this.scene.add(shutter);
    void parMat; void unitMat;
    return { b, body, extras, mats: [sideX, sideZ, roof], fade: 1, interior: null, floors: [], doors: [], alarm, shutter, sealed: false, lockLabel: null, lockKey: '', bands };
  }

  // Interior of a building: every floor is one open hall (like Free Fire's buildings): a tiled slab,
  // pillars, glass outer walls, a few low partitions for cover, and a glass lift in the core.
  // No ceilings, rooms or doors, so the third-person camera always sees the captain clearly.
  private buildInterior(B: Bldg) {
    const b = B.b; const g = new THREE.Group();
    const w = (b.x1 - b.x0) * S; const d = (b.y1 - b.y0) * S;
    const c = W((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    const slabM = new THREE.MeshStandardMaterial({ map: canvasTex(128, 128, (gg) => { gg.fillStyle = '#d6d2c8'; gg.fillRect(0, 0, 128, 128); gg.strokeStyle = 'rgba(0,0,0,0.13)'; gg.lineWidth = 2; for (let i = 0; i <= 128; i += 64) { gg.beginPath(); gg.moveTo(i, 0); gg.lineTo(i, 128); gg.stroke(); gg.beginPath(); gg.moveTo(0, i); gg.lineTo(128, i); gg.stroke(); } }, [Math.round(w / 6), Math.round(d / 6)]), roughness: 0.55 });
    const edgeM = new THREE.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.7 });
    const pillarM = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.8 });
    const glassM = new THREE.MeshStandardMaterial({ color: 0x9ed4f5, transparent: true, opacity: 0.22, roughness: 0.05, depthWrite: false });
    const coverM = new THREE.MeshStandardMaterial({ color: 0x5b6573, roughness: 0.6 });
    const liftGlass = new THREE.MeshStandardMaterial({ color: 0x5dff9e, transparent: true, opacity: 0.18, emissive: 0x5dff9e, emissiveIntensity: 0.25, depthWrite: false });
    const st = W(b.stairs[0], b.stairs[1]);
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (let f = 0; f < b.floors; f++) {
      const fg = new THREE.Group(); const y = f * FLOOR_H;
      const bt = new Batch();
      bt.add(box, slabM, [c.x, y + 0.15, c.z], 0, [w - 0.4, 0.3, d - 0.4]);
      // a clean edge band and a waist-high glass rail all round (you can see out, nothing blocks the view)
      for (const [px, pz, pw, pd] of [[0, -d / 2 + 0.3, w - 0.6, 0.2], [0, d / 2 - 0.3, w - 0.6, 0.2], [-w / 2 + 0.3, 0, 0.2, d - 0.6], [w / 2 - 0.3, 0, 0.2, d - 0.6]] as const) {
        bt.add(box, edgeM, [c.x + px, y + 0.4, c.z + pz], 0, [pw, 0.5, pd + 0.05]);
        bt.add(box, glassM, [c.x + px, y + 1.3, c.z + pz], 0, [pw, 1.3, pd]);
      }
      // pillars on a regular grid
      const nx = Math.max(2, Math.round(w / 14)); const nz = Math.max(2, Math.round(d / 14));
      for (let i = 1; i < nx; i++) for (let k = 1; k < nz; k++) {
        const px = c.x - w / 2 + (i * w) / nx; const pz = c.z - d / 2 + (k * d) / nz;
        if (Math.hypot(px - st.x, pz - st.z) < 5) continue;
        bt.add(box, pillarM, [px, y + 1.6, pz], 0, [0.8, 2.6, 0.8]);
      }
      // a few low cover walls (waist high) between the pillars
      let seed = (b.id.length * 31 + f * 7) % 97;
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let k = 0; k < Math.min(4, Math.round((w * d) / 360)); k++) {
        const px = c.x - w / 2 + 3 + rnd() * (w - 6); const pz = c.z - d / 2 + 3 + rnd() * (d - 6);
        if (Math.hypot(px - st.x, pz - st.z) < 6) continue;
        const along = rnd() > 0.5;
        bt.add(box, coverM, [px, y + 0.85, pz], 0, along ? [3.2, 1.1, 0.35] : [0.35, 1.1, 3.2]);
      }
      // furniture: workstation pods (waist-high cover) between the pillars, planters in the corners,
      // reception on the ground floor — baked per floor into three meshes (matte, metal, glowing screens)
      const fk = new Baker();
      const cellW = w / nx; const cellD = d / nz;
      const cells: [number, number][] = [];
      for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) cells.push([c.x - w / 2 + (i + 0.5) * cellW, c.z - d / 2 + (k + 0.5) * cellD]);
      const pods = Math.min(6, Math.max(1, Math.round((w * d) / 420)));
      for (let n = 0; n < pods && cells.length; n++) {
        const [px, pz] = cells.splice(Math.floor(rnd() * cells.length), 1)[0];
        if (Math.hypot(px - st.x, pz - st.z) < 8 || Math.min(cellW, cellD) < 7) continue;
        const rot = rnd() > 0.5 ? 0 : Math.PI / 2; const ca = Math.cos(rot); const sa = Math.sin(rot);
        const at = (lx: number, lz: number): [number, number] => [px + lx * ca + lz * sa, pz - lx * sa + lz * ca];
        const top = (lx: number, lz: number, sx: number, sz: number, yy: number, sy: number, col: number, bucket = 'trim') => { const [x, z] = at(lx, lz); fk.add(bucket, box, col, [x, y + yy, z], [0, rot, 0], [sx, sy, sz]); };
        top(0, 0, 3.4, 1.7, 1.02, 0.06, 0xe9e4da);                 // shared desk top
        top(0, 0, 3.4, 0.05, 1.32, 0.55, 0x5d7e9e);                 // fabric divider
        for (const lx of [-1.6, 1.6]) top(lx, 0, 0.06, 1.6, 0.52, 1, 0x59606a, 'metal');
        for (const sz of [-1, 1]) for (const lx of [-0.85, 0.85]) {
          top(lx, sz * 0.35, 0.62, 0.05, 1.32, 0.4, 0x1b2028, 'metal');               // monitor
          top(lx, sz * 0.32, 0.56, 0.02, 1.33, 0.32, 0x4fb4ff, 'glow');              // screen
          top(lx, sz * 1.25, 0.55, 0.55, 0.55, 0.08, 0x2b2f36);                      // chair seat
          top(lx, sz * 1.5, 0.55, 0.08, 0.85, 0.55, 0x2b2f36);                       // chair back
          top(lx, sz * 1.25, 0.08, 0.08, 0.27, 0.5, 0x59606a, 'metal');              // chair post
        }
      }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const px = c.x + sx * (w / 2 - 1.6); const pz = c.z + sz * (d / 2 - 1.6);
        fk.add('trim', IG.cyl, 0xcfc8b8, [px, y + 0.6, pz], [0, 0, 0], [1.1, 0.6, 1.1]);
        fk.add('trim', IG.shrub, 0x3f7f36, [px, y + 1.4, pz], [0, rnd() * 3, 0], [0.75, 0.8, 0.75]);
      }
      if (f === 0) {
        const dr = W(b.door[0], b.door[1]); const rz = c.z + d / 2 - 6;
        fk.add('trim', box, 0xf2efe8, [dr.x, y + 0.6, rz], [0, 0, 0], [5, 1.2, 1]);
        fk.add('trim', box, 0x1d4f91, [dr.x, y + 0.6, rz + 0.52], [0, 0, 0], [5.02, 0.3, 0.04]);
        fk.add('trim', box, 0xe9e4da, [dr.x, y + 1.24, rz], [0, 0, 0], [5.3, 0.08, 1.3]);
        fk.add('glow', box, 0x2ee6ff, [dr.x, y + 3.2, c.z + d / 2 - 0.5], [0, 0, 0], [4, 0.6, 0.05]);
      }
      // the lift: a glass cab in a steel frame — back panel, side glass, floor and lit roof, a call panel with
      // up/down arrows beside the doors and the floor number over them
      if (b.floors > 1) {
        const lx = st.x; const lz = st.z;
        for (const [ox, oz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) fk.add('metal', box, 0x8d97a2, [lx + ox, y + FLOOR_H / 2, lz + oz], [0, 0, 0], [0.16, FLOOR_H, 0.16]);
        fk.add('metal', box, 0x8d97a2, [lx, y + FLOOR_H - 0.1, lz - 1.6], [0, 0, 0], [3.4, 0.22, 0.16]);
        fk.add('trim', box, 0xd9dee3, [lx, y + FLOOR_H / 2, lz + 1.6], [0, 0, 0], [3.2, FLOOR_H, 0.08]);      // back panel (brushed light steel)
        fk.add('trim', box, 0xc2cad2, [lx, y + 1.1, lz + 1.52], [0, 0, 0], [3, 0.08, 0.1]);                  // handrail
        fk.add('metal', box, 0x2b3440, [lx, y + 0.34, lz], [0, 0, 0], [3.2, 0.08, 3.2]);                     // cab floor
        fk.add('metal', box, 0x2b3440, [lx, y + FLOOR_H - 0.32, lz], [0, 0, 0], [3.2, 0.08, 3.2]);           // cab roof
        fk.add('glow', box, 0xfff2d0, [lx, y + FLOOR_H - 0.37, lz], [0, 0, 0], [2.2, 0.02, 0.3]);            // light strip
        fk.add('metal', box, 0x2b2f36, [lx + 2.05, y + 1.3, lz - 1.7], [0, 0, 0], [0.32, 0.6, 0.06]);        // call panel
        fk.add('glow', box, 0x5dff9e, [lx + 2.05, y + 1.42, lz - 1.735], [0, 0, 0], [0.14, 0.12, 0.02]);
        fk.add('glow', box, 0xffc23d, [lx + 2.05, y + 1.18, lz - 1.735], [0, 0, 0], [0.14, 0.12, 0.02]);
        for (const sx of [-1, 1]) bt.add(box, liftGlass, [lx + sx * 1.6, y + FLOOR_H / 2, lz], 0, [0.05, FLOOR_H, 3.2]);
        for (const sx of [-1, 1]) bt.add(box, liftGlass, [lx + sx * 1.05, y + FLOOR_H / 2 - 0.1, lz - 1.62], 0, [0.9, FLOOR_H - 0.5, 0.04]); // doors, half open
        if (f > 0) { const sl = labelSprite(`🛗 LIFT · ${f}`, '#5dff9e', 'rgba(10,16,28,0.8)', 0.8); sl.position.set(st.x, y + FLOOR_H - 0.2, st.z + 1.8); fg.add(sl); } // ground floor: the place tag already says LIFT
      }
      if (!fk.empty) for (const [k, g] of Object.entries(fk.build(false))) { const m = new THREE.Mesh(g, k === 'metal' ? VCM.metal : k === 'glow' ? VCM.glow : VCM.trim); m.receiveShadow = true; fg.add(m); }
      bt.flush(fg, false);
      fg.visible = false;
      g.add(fg);
      B.floors.push(fg);
    }
    this.scene.add(g);
    B.interior = g;
  }

  private buildZone() {
    this.wallTex = canvasTex(64, 256, (g) => {
      const grd = g.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, 'rgba(70,140,255,0)'); grd.addColorStop(0.5, 'rgba(70,140,255,0.35)'); grd.addColorStop(1, 'rgba(120,190,255,0.75)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
      g.fillStyle = 'rgba(220,240,255,0.35)';
      for (let y = 0; y < 256; y += 16) g.fillRect(0, y, 64, 2);
    });
    this.wallTex.wrapS = this.wallTex.wrapT = THREE.RepeatWrapping; this.wallTex.repeat.set(40, 1);
    // energy wall: brighter (HDR, so it blooms) where it meets the ground, scrolling scan bands and a hex shimmer
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 120, 160, 1, true), zoneWallMaterial(this.zoneTime));
    this.zoneWall.position.y = 60; this.zoneWall.visible = false; this.zoneWall.renderOrder = 5;
    this.zoneOutside = new THREE.Mesh(new THREE.RingGeometry(1, 3000, 160, 1), new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    this.zoneOutside.rotation.x = -Math.PI / 2; this.zoneOutside.position.y = 0.4; this.zoneOutside.visible = false;
    this.nextRing = new THREE.Mesh(new THREE.RingGeometry(0.995, 1, 200, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    this.nextRing.rotation.x = -Math.PI / 2; this.nextRing.position.y = 0.5; this.nextRing.visible = false;
    this.red = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.3, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.55;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 64), new THREE.MeshBasicMaterial({ color: 0xff3b4e, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.6; ring.name = 'ring';
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 140, 48, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    pillar.position.y = 70;
    this.red.add(disc, ring, pillar); this.red.visible = false;
    this.scene.add(this.zoneWall, this.zoneOutside, this.nextRing, this.red);
  }

  // A challenge box: a sturdy supply crate with a squad-blue stripe; its lid opens when you walk up.
  private makeBox(gold: boolean) {
    if (!this.crateMats) {
      const wood = canvasTex(64, 64, (g) => {
        g.fillStyle = '#2b3a4f'; g.fillRect(0, 0, 64, 64);
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; for (let i = 8; i < 64; i += 14) { g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); }
        g.strokeStyle = '#9fb0c4'; g.lineWidth = 4; g.strokeRect(2, 2, 60, 60);
        g.fillStyle = '#2ee6ff'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 32, 34);
      });
      this.crateMats = {
        body: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.6, metalness: 0.3 }),
        gold: new THREE.MeshStandardMaterial({ color: 0xffc23d, roughness: 0.4, metalness: 0.6, emissive: 0x6a4500, emissiveIntensity: 0.4 }),
        stripe: new THREE.MeshStandardMaterial({ color: 0x2ee6ff, emissive: 0x2ee6ff, emissiveIntensity: 0.9 }),
        glow: new THREE.MeshBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
      };
    }
    const M = this.crateMats;
    const g = new THREE.Group();
    const body = new THREE.Mesh(CRATE.body, gold ? M.gold : M.body);
    body.position.y = 0.55; body.castShadow = true;
    const steel = new THREE.Mesh(crateTrim(), VCM.metal); steel.castShadow = true; steel.userData.detail = true;
    g.add(steel);
    const stripe = new THREE.Mesh(CRATE.stripe, M.stripe); stripe.position.y = 0.85; stripe.userData.detail = true;
    const hinge = new THREE.Group(); hinge.position.set(0, 1.1, -0.6);
    const lid = new THREE.Mesh(CRATE.lid, gold ? M.gold : M.body); lid.position.set(0, 0.08, 0.6); lid.castShadow = true;
    hinge.add(lid);
    const glow = new THREE.Mesh(CRATE.glow, M.glow); glow.position.y = 2.2; glow.visible = false;
    g.add(body, stripe, hinge, glow);
    g.userData = { lid: hinge, glow, gold };
    return g;
  }

  // Where the lift is: a green call pad on the floor with an up/down arrow post.
  private makeLiftPad() {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 3.2), new THREE.MeshStandardMaterial({ color: 0x1d6b45, emissive: 0x5dff9e, emissiveIntensity: 0.35 }));
    pad.position.y = 0.03;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.3, 0.2), new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.7, roughness: 0.3 }));
    post.position.set(1.4, 0.65, -1.4);
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.06), new THREE.MeshBasicMaterial({ color: 0x5dff9e }));
    btn.position.set(1.4, 1.05, -1.28);
    g.add(pad, post, btn);
    return g;
  }

  setLocRadius(r: number) {
    for (const p of this.pads) p.scale.setScalar(r * S); // the pick area; the box itself keeps its size
  }
  setMode(m: CameraMode) { this.mode = m; }
  setZoom(z: number) { this.zoom = Math.max(0.45, Math.min(2.4, z)); }

  private makeSquad(d: WorldSquad): SquadObj {
    const hex = squadHex(d.number);
    const car = new THREE.Group();
    const veh = makeVehicle({ color: hex, number: d.number });
    const avatar = makeAvatar({ color: hex, number: d.number });
    avatar.scale.setScalar(1.15); avatar.visible = false;
    const chute = makeChute(hex); chute.position.y = 1.4; chute.visible = false;
    car.add(veh, avatar, chute);
    const color = d.me ? 0x2ee6ff : d.ally ? 0x5dff9e : 0xff4d5e;
    const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.5, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3;
    car.add(ring);
    const aimRing = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.6, 4), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    aimRing.position.y = 2.2; aimRing.visible = false; car.add(aimRing);
    const label = labelSprite(d.label || `SQ ${d.number}`, d.me ? '#2ee6ff' : d.ally ? '#5dff9e' : '#ff8a96', 'rgba(10,16,28,0.78)', this.mode === 'follow' ? 0.85 : 0.5, true); // 15 squads on the big map: small tags that do not cover each other
    label.position.y = 5;
    label.visible = !d.me;
    car.add(label);
    const hpBar = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    hpBar.scale.set(3.2, 0.42, 1); hpBar.position.y = 3.9; hpBar.visible = false; car.add(hpBar);
    const p = W(d.x, d.y, d.level || 0);
    car.position.copy(p);
    this.scene.add(car);
    return { car, veh, avatar, chute, parked: null, hpBar, hpKey: '', aimRing, ring, label, target: p.clone(), heading: 0, turn: 0, data: d, sig: '', y: p.y };
  }

  private drawHp(o: SquadObj) {
    const hp = Math.max(0, Math.min(100, o.data.hp ?? 100)); const sh = Math.max(0, Math.min(100, o.data.shield ?? 0));
    const key = `${hp}|${sh}`;
    if (key === o.hpKey) return;
    o.hpKey = key;
    const c = document.createElement('canvas'); c.width = 128; c.height = 18;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(10,14,22,0.85)'; g.fillRect(0, 0, 128, 18);
    g.fillStyle = hp > 50 ? '#f2f5f8' : hp > 25 ? '#ffc23d' : '#ff4d5e'; g.fillRect(2, 2, 124 * hp / 100, sh > 0 ? 9 : 14);
    if (sh > 0) { g.fillStyle = '#3ea5ff'; g.fillRect(2, 12, 124 * sh / 100, 4); }
    const m = o.hpBar.material as THREE.SpriteMaterial;
    m.map?.dispose(); m.map = new THREE.CanvasTexture(c); m.map.colorSpace = THREE.SRGBColorSpace; m.needsUpdate = true;
  }

  /** a shot between two squads (by key or squad number); everyone sees the tracer */
  shot(from: string | number, to: string | number, hit: boolean) {
    const find = (k: string | number) => [...this.squads.values()].find((o) => o.data.key === k || o.data.number === Number(k));
    const A = find(from); const B = find(to);
    if (!A || !B || !A.car.visible) return;
    const a = A.car.position.clone(); a.y += A.data.foot ? 1.5 : 1.8;
    const b = B.car.position.clone(); b.y += B.data.foot ? 1.2 : 1.3;
    if (!hit) b.add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 1.5, (Math.random() - 0.5) * 3));
    this.vfx.shot(a, b, hit);
    if (!A.data.me) this.amb.at('shot', a);
    if (A.data.foot) { A.avatar.userData.aimAt = performance.now(); A.avatar.userData.firedAt = performance.now(); }
  }

  /** the safe zone: the blue wall closes in smoothly while it shrinks (Free Fire style); white circle = next zone */
  private drawZone() {
    const z = zoneNow(this.zoneData, serverTime());
    const cur = z.cur;
    if (cur && cur[2] < 0.86) {
      const c = W(cur[0], cur[1]);
      this.zoneWall.visible = this.zoneOutside.visible = true;
      this.zoneWall.position.set(c.x, 60, c.z); this.zoneWall.scale.set(cur[2] * S, 1, cur[2] * S);
      (this.zoneWall.material as THREE.ShaderMaterial).uniforms.uRepeat.value = Math.max(4, (Math.PI * 2 * cur[2] * S) / 36); // ~6 m cells at any size
      if (Math.abs(this.zoneR - cur[2]) > 0.0006) {
        this.zoneR = cur[2];
        this.zoneOutside.geometry.dispose();
        this.zoneOutside.geometry = new THREE.RingGeometry(cur[2] * S, 3000, 120, 1);
      }
      this.zoneOutside.position.set(c.x, 0.4, c.z);
    } else { this.zoneWall.visible = this.zoneOutside.visible = false; }
    const nx = z.next;
    if (nx) { const c = W(nx[0], nx[1]); this.nextRing.visible = true; this.nextRing.position.set(c.x, 0.5, c.z); this.nextRing.scale.setScalar(nx[2] * S); }
    else this.nextRing.visible = false;
  }

  setState(st: WorldState) {
    if (st.locRadius) this.setLocRadius(st.locRadius);
    const seen = new Set<string>();
    for (const d of st.squads) {
      seen.add(d.key);
      const sig = `${d.me}|${d.ally}|${d.label || ''}|${d.number}`;
      let o = this.squads.get(d.key);
      if (o && o.sig !== sig) { this.scene.remove(o.car); disposeAvatar(o.avatar); if (o.parked) this.scene.remove(o.parked); o = undefined; }
      if (!o) { o = this.makeSquad(d); o.sig = sig; this.squads.set(d.key, o); }
      o.data = d;
      (o.ring.material as THREE.MeshBasicMaterial).opacity = d.down ? 0.35 : 0.9;
    }
    for (const [k, o] of this.squads) if (!seen.has(k)) { this.scene.remove(o.car); disposeAvatar(o.avatar); if (o.parked) this.scene.remove(o.parked); this.squads.delete(k); }
    this.zoneData = st.zone || null;
    this.planeData = st.plane || null;
    this.fpv = !!st.fpv && this.mode === 'follow';
    this.targetKey = st.target || null;
    this.drawZone();

    if (st.red) {
      const c = W(st.red.x, st.red.y);
      this.red.visible = true; this.red.position.set(c.x, 0, c.z); this.red.scale.set(st.red.r * S, 1, st.red.r * S);
      this.redAt = new Date(st.red.at).getTime();
    } else this.red.visible = false;

    // airdrops and vaults
    const dseen = new Set<string>();
    for (const a of st.airdrops || []) {
      dseen.add(a.key);
      if (this.drops.has(a.key)) continue;
      const l = this.locs.get(a.location); if (!l) continue;
      const g = a.tier === 'vault' ? this.makeVault() : this.makeCrate(a.tier);
      const p = W(l.x, l.y, l.level || 0); g.position.set(p.x + 3, p.y, p.z + 2);
      g.userData.level = l.level || 0; g.userData.bldg = (l.level || 0) > 0 ? l.building : null;
      this.scene.add(g);
      this.drops.set(a.key, g);
      if (!this.seenDrops.has(a.key)) {
        this.seenDrops.add(a.key);
        if (a.tier !== 'vault' && (l.level || 0) === 0) { this.onEvent?.('dropIncoming', g.position.clone()); if (this.mode === 'orbit' && !this.reduced) this.dropCut = { p: g.position.clone(), t0: performance.now() }; }
      }
      if ((l.level || 0) === 0) this.vfx.setEmitter('drop:' + a.key, g.position.clone().add(new THREE.Vector3(1.4, 1.2, 0)), 'smoke');
    }
    for (const [k, g] of this.drops) if (!dseen.has(k)) { this.scene.remove(g); this.drops.delete(k); this.vfx.setEmitter('drop:' + k, null); }

    // loot on the ground
    const lseen = new Set<string>();
    for (const p of st.pickups || []) {
      lseen.add(p.id);
      if (this.loot.has(p.id)) continue;
      const m = this.makeLoot(p.k);
      const w = W(p.x, p.y, p.l || 0); m.position.set(w.x, w.y + 0.9, w.z);
      m.userData.level = p.l || 0; m.userData.base = w.y + 0.9;
      this.scene.add(m); this.loot.set(p.id, m);
    }
    for (const [k, m] of this.loot) if (!lseen.has(k)) { this.scene.remove(m); this.loot.delete(k); }

    this.lock = st.lock || [];
    for (const B of this.bldgs) {
      const mine = this.lock.filter((l) => l.b === B.b.id);
      const key = mine.map((l) => `${l.l}:${l.sealed}:${l.at}`).join('|');
      if (key === B.lockKey) continue;
      B.lockKey = key;
      const whole = mine.find((l) => l.l === null);
      B.sealed = !!whole?.sealed;
      B.shutter.visible = B.sealed;
      for (const [i, band] of B.bands.entries()) {
        const floorLock = mine.find((l) => l.l === i);
        const m = band.material as THREE.MeshStandardMaterial;
        m.emissive.setHex(floorLock ? 0xff2238 : 0x000000); m.emissiveIntensity = floorLock ? (floorLock.sealed ? 0.5 : 1.4) : 0;
      }
      if (B.lockLabel) { this.scene.remove(B.lockLabel); B.lockLabel = null; }
      const pending = mine.find((l) => !l.sealed);
      if (pending || whole?.sealed) {
        const c = W((B.b.x0 + B.b.x1) / 2, (B.b.y0 + B.b.y1) / 2);
        const txt = pending ? `🚨 LOCKDOWN${pending.l !== null ? ` · F${pending.l}` : ''}` : '🔒 SEALED';
        B.lockLabel = labelSprite(txt, '#ffffff', pending ? 'rgba(220,30,50,0.9)' : 'rgba(40,44,52,0.9)', 2.4);
        B.lockLabel.position.set(c.x, B.b.floors * FLOOR_H + 9, c.z);
        this.scene.add(B.lockLabel);
      }
    }

    const bseen = new Set<string>();
    for (const b of st.battles || []) {
      bseen.add(b.key);
      if (this.battles.has(b.key)) continue;
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(5, 5.6, 40), new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.5;
      const sp = labelSprite('⚔ DUEL', '#ffffff', 'rgba(220,30,50,0.9)', 1.6); sp.position.y = 8;
      g.add(ring, sp); g.userData.ring = ring;
      const p = W(b.x, b.y); g.position.set(p.x, 0, p.z);
      this.scene.add(g);
      this.battles.set(b.key, g);
    }
    for (const [k, g] of this.battles) if (!bseen.has(k)) { this.scene.remove(g); this.battles.delete(k); }

    if (st.waypoint) { const p = W(st.waypoint.x, st.waypoint.y); this.waypoint.position.set(p.x, 0, p.z); this.waypoint.visible = true; }
    else this.waypoint.visible = false;
    this.routeTo = st.route ? W(st.route.x, st.route.y) : null;
    if (st.focus) this.focus.copy(W(st.focus.x, st.focus.y));
    this.hlId = st.highlight || null;
    const hl = st.highlight ? this.locs.get(st.highlight) : null;
    if (hl) { const p = W(hl.x, hl.y, hl.level || 0); this.highlightRing.visible = true; this.highlightRing.position.set(p.x, p.y + 0.4, p.z); }
    else this.highlightRing.visible = false;
  }

  // Airdrop: a slatted wooden crate with steel straps in the tier colour, hanging from a striped canopy on
  // eight cords. It drifts down from high above, sways, lands with a dust burst, then the canopy collapses.
  private makeCrate(tier: string) {
    const g = new THREE.Group();
    const col = TIER_HEX[tier] ?? 0xffc23d;
    const crate = new THREE.Mesh(CRATE.drop, dropWoodMat()); crate.position.y = 0.9; crate.castShadow = true;
    const straps = new THREE.Mesh(dropStraps(), VCM.metal); straps.castShadow = true;
    for (const y of [0.3, 1.5]) { const band = new THREE.Mesh(CRATE.dropBand, tierMat(col)); band.position.y = y; g.add(band); }
    const canopy = new THREE.Group();
    const chute = new THREE.Mesh(CRATE.canopy, canopyMat(col)); chute.position.y = 9;
    const cords = new THREE.LineSegments(CRATE.cords, CORD_MAT);
    canopy.add(chute, cords);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 140, 12, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    beam.position.y = 70;
    const smoke = new THREE.Group();
    const sm = new THREE.SpriteMaterial({ map: smokeTex(), transparent: true, depthWrite: false });
    for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(sm); s.position.set(0, 1 + i * 1.6, 0); s.scale.setScalar(2 + i * 0.6); s.userData.i = i; smoke.add(s); }
    const body = new THREE.Group(); body.add(crate, straps); g.add(body);
    g.add(canopy, beam, smoke);
    g.userData = { chute: canopy, body, smoke, beam, t0: performance.now(), fall: true, landed: false };
    return g;
  }
  private makeVault() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x7c848f, roughness: 0.35, metalness: 0.85 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.8, 2.6, 2.4), steel); box.position.y = 1.3; box.castShadow = true;
    const doorM = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.25, 24).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff9d2e, emissive: 0xff7a00, emissiveIntensity: 0.6, metalness: 0.7, roughness: 0.3 }));
    doorM.position.set(0, 1.3, 1.25);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 6, 16), steel); wheel.position.set(0, 1.3, 1.42); wheel.name = 'wheel';
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 60, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xff9d2e, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    beam.position.y = 30;
    const lab = labelSprite('VAULT', '#1a1004', 'rgba(255,157,46,0.95)', 1.1); lab.position.y = 4.4;
    g.add(box, doorM, wheel, beam, lab);
    g.userData = { vault: true, wheel };
    return g;
  }
  // Ground loot: shared meshes per kind (a stack of coins is one mesh), so 40 pickups cost ~80 draws, not 200.
  private makeLoot(kind: string) {
    const L = lootAssets();
    const g = new THREE.Group();
    const k = kind === 'medkit' || kind === 'shield' ? kind : 'coins';
    g.add(new THREE.Mesh(L.geo[k], L.mat[k]));
    const glow = new THREE.Mesh(L.ring, L.glow[k]);
    glow.rotation.x = -Math.PI / 2; glow.position.y = -0.8; glow.name = 'glow';
    g.add(glow);
    return g;
  }

  // ── graphics quality: presets, post-processing, adaptive resolution (visual only) ──
  private baseDpr() { return Math.min(window.devicePixelRatio || 1, this.preset.maxDpr); }
  private setRenderScale(sc: number) {
    this.renderer.setPixelRatio(this.baseDpr() * sc);
    this.resize();
  }
  /** Selective bloom: only pixels brighter than the threshold glow (lamps, beacons, tracers, zone wall, VFX). */
  private setupPost() {
    this.composer?.dispose(); this.composer = null; this.bloom = null;
    if (!this.preset.bloom) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.preset.antialias ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bs = this.preset.bloomScale;
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * bs, size.y * bs), 0.45, 0.35, 1.15);
    const set = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => set(Math.max(64, Math.round(w * bs)), Math.max(64, Math.round(h * bs)));
    this.bloom = bloom;
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }
  applyQuality(q: Quality) {
    if (!PRESETS[q] || this.disposed) return;
    const had = this.preset.shadows;
    this.quality = q; this.preset = PRESETS[q]; this.lowEnd = q === 'low';
    this.adaptive.scale = 1; this.monitor.reset();
    this.renderer.setPixelRatio(this.baseDpr());
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.far = this.preset.fogFar;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.sun.castShadow = this.preset.shadows;
    if (this.preset.shadows) {
      const n = this.preset.shadowSize;
      if (this.sun.shadow.mapSize.x !== n) { this.sun.shadow.mapSize.set(n, n); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null as any; }
    }
    if (had !== this.preset.shadows) this.scene.traverse((o: any) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; for (const m of ms) m.needsUpdate = true; });
    if (this.vfx) this.vfx.density = this.reduced ? Math.min(0.3, this.preset.particles) : this.preset.particles;
    this.setupPost();
    this.resize();
  }
  private syncFpsOverlay() {
    const want = showFps();
    if (want && !this.fpsOverlay) this.fpsOverlay = new FpsOverlay(this.canvas.parentElement || document.body);
    else if (!want && this.fpsOverlay) { this.fpsOverlay.dispose(); this.fpsOverlay = null; }
  }
  /** camera shake impulse (landing, taking a hit); none with reduced motion */
  kick(amount: number) { if (!this.reduced) this.shake = Math.min(1, this.shake + amount); }
  /** for perf tooling */
  stats() { return { quality: this.quality, scale: this.adaptive.scale, fps: this.monitor.fps, p95: this.monitor.pct(0.95), calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles }; }

  private resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || 360; const h = el.clientHeight || 640;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.75 ? 62 : 50;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.vfx?.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
  }

  private bindInput() {
    const v = new THREE.Vector2();
    const pts = new Map<number, { x: number; y: number }>();
    let downAt = 0; let downPos = { x: 0, y: 0 }; let last = { x: 0, y: 0 }; let pinch0 = 0; let zoom0 = 1; let dragged = false;
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = performance.now(); downPos = { x: e.clientX, y: e.clientY }; last = { ...downPos }; dragged = false;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = this.zoom; }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch0 > 0) {
        const [a, b] = [...pts.values()];
        this.setZoom(zoom0 * (pinch0 / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y))));
        dragged = true;
      } else if (pts.size === 1) {
        const dx = e.clientX - last.x; const dy = e.clientY - last.y;
        if (Math.abs(e.clientX - downPos.x) > 6 || Math.abs(e.clientY - downPos.y) > 6) dragged = true;
        if (dragged) this.yaw -= dx * (this.fpv ? 0.006 : 0.008);
        if (dragged && this.fpv) this.pitch = Math.max(-0.9, Math.min(0.7, this.pitch - dy * 0.005));
      }
      last = { x: e.clientX, y: e.clientY };
    });
    const up = (e: PointerEvent) => {
      const single = pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = 0;
      if (!single || dragged || !this.onPick) return;
      if (performance.now() - downAt > 450) return;
      const r = el.getBoundingClientRect();
      v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(v, this.camera);
      const hit = this.ray.intersectObjects(this.pads.filter((p) => p.visible), false)[0];
      if (hit) this.onPick(hit.object.userData.id);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch0 = 0; });
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY > 0 ? 1.1 : 0.9)); }, { passive: false });
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const nowMs = performance.now();
    if (this.lastFrame) { const ft = nowMs - this.lastFrame; if (ft < 1500) this.monitor.push(Math.min(ft, 250)); } // > 1.5 s = tab was hidden
    this.lastFrame = nowMs;
    this.renderer.info.reset();
    this.adaptive.update(this.monitor, this.preset, nowMs, this.baseDpr());
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const k = 1 - Math.pow(0.002, dt);
    const now = serverTime();

    const live = this.liveMe?.current;
    const meObj = [...this.squads.values()].find((o) => o.data.me);
    if (live && meObj) { meObj.target.copy(W(live.x, live.y, live.level ?? meObj.data.level ?? 0)); meObj.data.moving = live.moving; }
    this.myLevel = live?.level ?? meObj?.data.level ?? 0;
    this.myBldg = live?.bldg ?? meObj?.data.bldg ?? null;

    for (const o of this.squads.values()) {
      const d = o.data;
      if (!(d.me && live)) {
        // dead-reckon rivals between updates (velocity in campus units / s)
        const age = Math.max(0, Math.min(2.6, (now - (d.at || now)) / 1000)); // positions arrive every ~2 s: keep rolling in between
        o.target.copy(W(d.x + (d.vx || 0) * age, d.y + (d.vy || 0) * age, d.level || 0));
      }
      // parachuting: drop from the plane's altitude to the ground by the landing time
      // falling: free fall covers most of the height fast, then the canopy opens and the last part is slow (like Free Fire)
      let freefall = false;
      if (d.chute && d.landAt && d.jumpAt && d.landAt > d.jumpAt) {
        const f = Math.max(0, Math.min(1, (now - d.jumpAt) / (d.landAt - d.jumpAt)));
        const g = f < 0.45 ? 0.72 * (f / 0.45) : 0.72 + 0.28 * ((f - 0.45) / 0.55);
        o.target.y += 160 * (1 - g);
        freefall = f < 0.45;
      } else if (d.chute && d.landAt) o.target.y += Math.min(150, Math.max(0, (d.landAt - now) / 1000) * 11);
      if (d.hidden) { o.car.visible = false; if (o.parked) o.parked.visible = false; continue; }
      const before = o.car.position.clone();
      // own squad follows the prediction exactly; others glide with a short smoothing
      o.car.position.lerp(o.target, d.me && live ? 1 : Math.min(1, dt * 7));
      const step = o.car.position.clone().sub(before); step.y = 0;
      const spd = step.length() / Math.max(dt, 0.001);
      o.spd = (o.spd ?? 0) + (spd - (o.spd ?? 0)) * Math.min(1, dt * 4);
      let turn = 0;
      if (step.lengthSq() > 0.0004) {
        const hd = Math.atan2(-step.x, -step.z);
        let dh = hd - o.heading; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
        o.heading += dh * Math.min(1, dt * 8); turn = dh / Math.max(dt, 0.016);
      }
      o.car.rotation.y = o.heading;
      const foot = !!d.foot || !!d.chute;
      // one-shot effects on state changes the server already made
      if (o.wasChute && !d.chute && o.avatar.visible) { this.vfx.landing(o.car.position); if (d.me) this.kick(0.5); }
      if (d.me && d.hp != null) { if (this.myHp != null && d.hp < this.myHp) this.kick(Math.min(0.6, (this.myHp - d.hp) / 40)); this.myHp = d.hp; }
      if (o.wasDown !== undefined && o.wasDown !== !!d.down) this.vfx.pulse(o.car.position.clone().setY(o.car.position.y + 1), d.down ? 0xff4d5e : 0x2ee6ff);
      if (o.wasChute && !d.chute && o.avatar.visible) this.onEvent?.('landed', o.car.position.clone());
      if (o.wasFree && d.chute && !freefall) { // the canopy just opened
        this.onEvent?.('chuteOpen', o.car.position.clone());
        if (d.me) { this.kick(0.25); this.chuteAt = performance.now(); }
      }
      if (d.me && d.chute && freefall && !o.wasFree) this.jumpAt = performance.now();
      o.wasFree = !!d.chute && freefall;
      o.wasChute = !!d.chute; o.wasDown = !!d.down;
      o.veh.visible = !foot;
      o.avatar.visible = foot && !(d.me && this.fpv);
      // free fall: body flat, arms out, no canopy; then the canopy pops open and the body hangs upright
      const openK = d.chute && !freefall ? Math.min(1, (o.chute.userData.k ?? 0) + dt * 2.5) : 0;
      o.chute.userData.k = openK;
      o.chute.visible = !!d.chute && !freefall;
      o.chute.scale.set(0.3 + 0.7 * openK, 0.3 + 0.7 * openK, 0.3 + 0.7 * openK);
      const tilt = freefall ? -Math.PI / 2 * 0.85 : 0;
      o.avatar.rotation.x += (tilt - o.avatar.rotation.x) * Math.min(1, dt * 6);
      o.avatar.position.y = freefall ? 0.9 : 0;
      if (foot) {
        const aimAge = performance.now() - (o.avatar.userData.aimAt || 0);
        animateAvatar(o.avatar, dt, { speed: d.chute ? 0 : spd / 1.15, fall: freefall, chute: !!d.chute && !freefall, aiming: aimAge < 900, down: !!d.down, reduced: this.reduced });
      }
      if (!foot) animateVehicle(o.veh, t, dt, this.reduced ? 0 : spd, this.reduced ? 0 : turn, !!d.down);
      // level of detail: far buggies drop their small parts (cabin, cage, lamps, plate)
      const camD = o.car.position.distanceTo(this.camera.position);
      setVehicleDetail(o.veh, camD < (this.mode === 'follow' ? 110 : 260));
      if (o.parked) setVehicleDetail(o.parked, camD < 110);
      // the buggy waits where it was parked (or in its parking bay) while the captain walks
      if (d.foot && d.buggy && !d.chute) {
        if (!o.parked) { o.parked = makeVehicle({ color: squadHex(d.number), number: d.number }); this.scene.add(o.parked); }
        const bp = W(d.buggy[0], d.buggy[1], 0);
        o.parked.position.set(bp.x, 0, bp.z);
        o.parked.visible = this.mode !== 'follow' || this.myLevel === 0;
        o.parked.scale.setScalar(this.mode === 'follow' ? 1 : 2);
      } else if (o.parked) o.parked.visible = false;
      // health bar over a rival you are fighting or aiming at
      const showHp = !d.me && d.hp != null && this.mode === 'follow' && (d.fight || this.targetKey === d.key || (d.hp ?? 100) < 100);
      o.hpBar.visible = showHp;
      if (showHp) this.drawHp(o);
      o.aimRing.visible = this.targetKey === d.key;
      if (o.aimRing.visible) { o.aimRing.rotation.set(0, t * 2, Math.PI / 4); o.aimRing.position.y = foot ? 2.4 : 3; }
      o.label.position.y = foot ? 3.1 : 5; o.hpBar.position.y = foot ? 2.6 : 3.9;
      if (d.me && !this.reduced) o.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.05);
      // squads on another floor of the building you are in are hidden; inside, outdoor squads are hidden
      const inMine = this.myLevel > 0;
      o.car.visible = d.me || (!inMine && (d.level || 0) === 0) || (inMine && d.bldg === this.myBldg && (d.level || 0) === this.myLevel) || this.mode !== 'follow';
      o.car.scale.setScalar(this.mode === 'follow' ? 1 : 2);
      if (d.me && this.mode === 'follow' && live && live.moving && !live.joy && step.lengthSq() > 0.0004) {
        const want = Math.atan2(step.x, -step.z);
        let dd = want - this.yaw; while (dd > Math.PI) dd -= Math.PI * 2; while (dd < -Math.PI) dd += Math.PI * 2;
        this.yaw += dd * Math.min(1, dt * 1.5);
      }
    }
    if (live) live.yaw = this.yaw;
    if (this.routeTo && meObj && this.myLevel === 0) {
      const a = meObj.car.position; const b = this.routeTo;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      this.routeLine.visible = len > 1;
      this.routeLine.scale.set(0.8, len, 1);
      this.routeLine.position.set((a.x + b.x) / 2, 0.42, (a.z + b.z) / 2);
      this.routeLine.rotation.set(-Math.PI / 2, 0, Math.atan2(b.x - a.x, b.z - a.z) + Math.PI);
    } else this.routeLine.visible = false;
    if (this.waypoint.visible && !this.reduced) this.waypoint.getObjectByName('ring')!.scale.setScalar(1 + Math.sin(t * 4) * 0.15);

    if (this.beacon) this.beacon.visible = !(this.mode === 'follow' && this.myBldg === 'hexavarsity');
    // loot bobs and spins; only what is on your floor shows inside buildings; never right in front of the lens
    for (const m of this.loot.values()) {
      const lvl = m.userData.level || 0;
      m.visible = (this.mode !== 'follow' || lvl === this.myLevel) && m.position.distanceTo(this.camera.position) > 7;
      if (!this.reduced) { m.rotation.y = t * 1.6; m.position.y = m.userData.base + Math.sin(t * 2.4 + m.position.x) * 0.2; }
    }
    if (!this.reduced) {
      this.wallTex.offset.y = (t * 0.1) % 1;
      for (const g of this.drops.values()) {
        g.visible = this.mode !== 'follow' || (g.userData.level || 0) === this.myLevel;
        if (g.userData.vault) { (g.userData.wheel as THREE.Object3D).rotation.z = t * 0.8; continue; }
        // drift down from high above on the canopy (swaying), touch down with a dust burst, canopy collapses
        const age = (performance.now() - g.userData.t0) / 1000;
        const fall = (g.userData.level || 0) > 0 ? 1 : Math.min(1, age / DROP_FALL_S); // indoor drops are already there
        const base = (g.userData.level || 0) * FLOOR_H;
        g.position.y = base + Math.pow(1 - fall, 1.15) * DROP_FROM;
        const sway = (1 - fall) * 0.18;
        g.userData.body.rotation.set(Math.sin(t * 1.3) * sway, 0, Math.cos(t * 1.1) * sway);
        const canopy = g.userData.chute as THREE.Group;
        if (fall < 1) { canopy.visible = true; canopy.rotation.set(Math.sin(t * 1.3) * sway * 0.6, t * 0.3, Math.cos(t * 1.1) * sway * 0.6); canopy.scale.set(1, 1, 1); }
        else {
          const k = Math.min(1, (age - DROP_FALL_S) / 1.2); // canopy collapses onto the ground beside the crate
          canopy.scale.set(1 + k * 0.3, Math.max(0.02, 1 - k), 1 + k * 0.3); canopy.position.set(k * 3, -k * 7.5, 0);
          canopy.visible = k < 1 && !((g.userData.level || 0) > 0);
        }
        if (fall >= 1 && !g.userData.landed && (g.userData.level || 0) > 0) { g.userData.landed = true; (g.userData.chute as THREE.Object3D).visible = false; }
        if (fall >= 1 && !g.userData.landed) {
          g.userData.landed = true;
          this.vfx.landing(g.position.clone()); this.vfx.landing(g.position.clone().add(new THREE.Vector3(1, 0, -1)));
          if (this.mode === 'follow' && g.position.distanceTo(this.camPos) < 45) this.kick(0.35);
          this.onEvent?.('dropLanded', g.position.clone());
        }
        g.userData.smoke.visible = fall >= 1;
        g.userData.smoke.children.forEach((s: THREE.Sprite) => { s.position.y = 1 + ((s.userData.i * 1.6 + t * 1.8) % 13); });
      }
      for (const g of this.battles.values()) { const ph = (t * 1.5) % 1; g.userData.ring.scale.setScalar(1 + ph * 0.6); g.userData.ring.material.opacity = 1 - ph; }
      if (this.red.visible) this.red.getObjectByName('ring')!.scale.setScalar(1 + Math.sin(t * (this.redAt - Date.now() < 5000 ? 9 : 3)) * 0.03);
      this.highlightRing.scale.setScalar(6 + Math.sin(t * 5) * 0.5);
      for (const o of this.animated) o.position.x += dt * 1.2;
      if (this.water) this.animateWater(t);
    }
    // lockdown alarms flash and sweep
    for (const B of this.bldgs) {
      const pending = this.lock.some((l) => l.b === B.b.id && !l.sealed);
      B.alarm.visible = pending;
      if (pending && !this.reduced) {
        B.alarm.children.forEach((ch) => { if (ch instanceof THREE.Group) ch.rotation.y = t * 4; });
        const ringM = (B.alarm.children[B.alarm.children.length - 1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
        ringM.opacity = 0.06 + Math.abs(Math.sin(t * 5)) * 0.14;
        for (const [i, band] of B.bands.entries()) if (this.lock.some((l) => l.b === B.b.id && !l.sealed && (l.l === null || l.l === i))) (band.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 + Math.abs(Math.sin(t * 6)) * 1.5;
      }
    }

    // camera
    const insideB = this.myLevel > 0 || this.bldgs.some((B) => meObj && !meObj.data.chute && this.isInside(B, meObj.car.position));
    // the drop plane crossing the campus
    const pd = this.planeData;
    if (pd) {
      const a = new Date(pd.t0).getTime(); const b = new Date(pd.t1).getTime(); const p = (now - a) / Math.max(1, b - a);
      if (!this.plane) { this.plane = makePlane(); this.plane.scale.setScalar(1.6); this.scene.add(this.plane); }
      this.plane.visible = p > -0.02 && p < 1.05;
      const A = W(pd.a[0], pd.a[1]); const Bp = W(pd.b[0], pd.b[1]);
      this.plane.position.copy(A).lerp(Bp, Math.max(0, Math.min(1.05, p))); this.plane.position.y = 150;
      this.plane.rotation.y = Math.atan2(-(Bp.x - A.x), -(Bp.z - A.z));
      if (!this.reduced) animatePlane(this.plane, t);
    } else if (this.plane) this.plane.visible = false;
    // gun tracers fade in a blink
    this.vfx.update(dt);
    if (!this.reduced) this.zoneTime.value = t;
    if (this.zoneData?.shrink_until && now - this.zoneT > 120) { this.zoneT = now; this.drawZone(); }

    // stairs walk in first person: follow the flight of steps up (or down) to the next floor
    if (this.myLevel !== this.lastLevel) {
      const B = this.bldgs.find((x) => x.b.id === (this.myBldg || this.lastBldg));
      if (B && this.fpv) {
        const st = W(B.b.stairs[0], B.b.stairs[1]); const up = this.myLevel > this.lastLevel;
        const lo = new THREE.Vector3(st.x - 2.9, Math.min(this.myLevel, this.lastLevel) * FLOOR_H + 1.7, st.z - 1.2);
        const hi = new THREE.Vector3(st.x + 2.4, Math.max(this.myLevel, this.lastLevel) * FLOOR_H + 1.7, st.z - 1.2);
        this.climb = { t0: performance.now(), from: up ? lo : hi, to: up ? hi : lo, dir: up ? 1 : -1 };
        this.yaw = up ? Math.PI / 2 : -Math.PI / 2;
        this.pitch = up ? 0.32 : -0.38; // look up the flight of steps (or down it)
      }
      this.lastLevel = this.myLevel; this.lastBldg = this.myBldg;
    }
    if (this.mode === 'follow' && this.fpv && meObj) {
      const eye = meObj.car.position.clone(); eye.y += 1.7;
      if (this.climb) {
        const p = Math.min(1, (performance.now() - this.climb.t0) / 1700);
        eye.copy(this.climb.from).lerp(this.climb.to, p);
        eye.y += Math.abs(Math.sin(p * Math.PI * 7)) * 0.07;
        if (p >= 1) { this.climb = null; this.pitch = -0.05; }
      } else if (live?.moving && !this.reduced) eye.y += Math.abs(Math.sin(t * 9)) * 0.05;
      if (live?.joy && live.jx) this.yaw += live.jx * dt * 1.7;
      const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      this.camPos.lerp(eye, Math.min(1, dt * 14));
      this.camTarget.copy(this.camPos).add(fwd);
    } else if (this.mode === 'follow' && meObj?.data.hidden && this.plane?.visible) {
      // on board — flyover sequence: open on a low side-on shot of the plane against the sky, swing round
      // behind it over ~12 s and settle into a high chase view looking down at the campus ahead
      if (!this.boardAt) this.boardAt = performance.now();
      const pp = this.plane.position; const fwd = new THREE.Vector3(-Math.sin(this.plane.rotation.y), 0, -Math.cos(this.plane.rotation.y));
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const u = this.reduced ? 1 : Math.min(1, (performance.now() - this.boardAt) / 12000);
      const e = u * u * (3 - 2 * u); // smoothstep
      const ang = (1 - e) * 1.25; // radians off the tail: ~70° (side-on) → 0 (behind)
      const dist = 55 + 40 * e; const hgt = 6 + 32 * e + Math.sin(t * 0.4) * 2;
      const off = fwd.clone().multiplyScalar(-Math.cos(ang) * dist).addScaledVector(side, Math.sin(ang) * dist);
      this.camPos.lerp(pp.clone().add(off).add(new THREE.Vector3(0, hgt, 0)), Math.min(1, k * 2));
      const look = pp.clone().lerp(pp.clone().addScaledVector(fwd, 120).setY(10), e);
      this.camTarget.lerp(look, Math.min(1, k * 2));
    } else if (this.mode === 'follow' && meObj?.data.chute) {
      this.boardAt = 0;
      const f = meObj.car.position; const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const inFree = !!meObj.wasFree;
      if (inFree) {
        // free fall: the camera dives with you — tight behind the shoulders, looking steeply down at the ground
        const sinceJump = (performance.now() - this.jumpAt) / 1000;
        const settle = Math.min(1, sinceJump / 1.4); // first moments: tumble out of the plane, then lock on
        const back = 9 + 6 * (1 - settle); const up = 7 + 8 * (1 - settle);
        this.camPos.lerp(f.clone().addScaledVector(fwd, -back).add(new THREE.Vector3(0, up, 0)), Math.min(1, k * 4));
        // aim below the diver so they sit in the upper third with the campus rushing up beneath
        this.camTarget.lerp(f.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, -14, 0)), Math.min(1, k * 4));
        this.fovKick += ((this.reduced ? 0 : 8) - this.fovKick) * Math.min(1, dt * 2); // speed feel
      } else {
        // canopy open: pull back and up (a quick jolt as the lines take the weight), look at the landing spot
        const sinceOpen = (performance.now() - this.chuteAt) / 1000;
        const jolt = this.reduced || sinceOpen > 1.2 ? 0 : Math.sin(Math.min(1, sinceOpen / 1.2) * Math.PI) * 4;
        this.camPos.lerp(f.clone().addScaledVector(fwd, -18).add(new THREE.Vector3(0, 12 + jolt, 0)), Math.min(1, k * 2.5));
        this.camTarget.lerp(f.clone().addScaledVector(fwd, 14).add(new THREE.Vector3(0, -22, 0)), Math.min(1, k * 2.5));
        this.fovKick += (0 - this.fovKick) * Math.min(1, dt * 1.5);
      }
    } else if (this.mode === 'follow') {
      this.boardAt = 0; this.fovKick += (0 - this.fovKick) * Math.min(1, dt * 2);
      const f = meObj ? meObj.car.position : this.focus;
      const onFoot = !!meObj?.data.foot;
      const dist = (onFoot ? (insideB ? 7.5 : 8.5) : insideB ? 13 : 17) * this.zoom; const height = (onFoot ? (insideB ? 6.5 : 4.2) : insideB ? 12 : 8.5) * this.zoom;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const tgt = f.clone().addScaledVector(fwd, 4); tgt.y = f.y + 1.6;
      this.camTarget.lerp(tgt, Math.min(1, k * 3));
      const cp = f.clone().addScaledVector(fwd, -dist); cp.y = f.y + height;
      this.camPos.lerp(cp, Math.min(1, k * 3));
    } else if (this.mode === 'overview') {
      this.camTarget.lerp(new THREE.Vector3(0, 0, 10), k);
      this.camPos.lerp(new THREE.Vector3(0, 420 * this.zoom, 320 * this.zoom), k);
    } else if (this.dropCut && performance.now() - this.dropCut.t0 < DROP_CUT_MS) {
      // big screen: cut to a new airdrop — follow the crate down on its canopy, hold on the landing, then back
      const dc = this.dropCut; const g = [...this.drops.values()].find((x) => Math.hypot(x.position.x - dc.p.x, x.position.z - dc.p.z) < 6);
      const cy = g ? g.position.y : 0; const u = (performance.now() - dc.t0) / DROP_CUT_MS;
      const a = u * 0.9 + 0.6;
      this.camTarget.lerp(new THREE.Vector3(dc.p.x, cy + 2, dc.p.z), Math.min(1, k * 2.5));
      this.camPos.lerp(new THREE.Vector3(dc.p.x + Math.sin(a) * 42, Math.max(14, cy * 0.7 + 16), dc.p.z + Math.cos(a) * 42), Math.min(1, k * 2));
    } else {
      this.dropCut = null;
      const a = t * 0.04;
      this.camTarget.lerp(new THREE.Vector3(0, 0, 0), k);
      this.camPos.lerp(new THREE.Vector3(Math.sin(a) * 400, 300, Math.cos(a) * 400), k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    const baseFov = this.camera.aspect < 0.75 ? 62 : 50;
    const fov = baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    // never fly the lens through the plane's hull (after the jump the diver starts right beside it)
    if (this.plane?.visible && meObj && !meObj.data.hidden && this.plane.position.distanceTo(this.camPos) < 34) this.plane.visible = false;
    const near = this.mode === 'follow' ? (this.fpv ? 0.08 : 0.3) : 3;
    if (this.camera.near !== near) { this.camera.near = near; this.camera.updateProjectionMatrix(); }

    const stt = this.mode === 'follow' ? this.camTarget : new THREE.Vector3();
    this.sun.position.set(stt.x - 80, stt.y + 140, stt.z + 60);
    this.sun.target.position.copy(stt);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    const span = this.mode === 'follow' ? 55 * this.zoom : 300;
    if (sc.right !== span) { sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.updateProjectionMatrix(); }

    // buildings: fade when you are inside or they block the view; interiors show your floor
    if (this.mode === 'follow' && meObj) {
      const mp = meObj.car.position;
      const dir = mp.clone().setY(mp.y + 1.2).sub(this.camera.position); const len = dir.length(); dir.normalize();
      this.ray.set(this.camera.position, dir); this.ray.far = len;
      const hits = new Set(this.ray.intersectObjects(this.bldgs.map((b) => b.body), false).map((h) => h.object));
      for (const B of this.bldgs) {
        const inside = (!meObj.data.chute && this.isInside(B, mp)) || (this.myLevel > 0 && this.myBldg === B.b.id);
        if (inside && !B.interior) this.buildInterior(B);
        const camIn = this.isInside(B, this.camera.position) && this.camera.position.y < B.b.floors * FLOOR_H + 2;
        this.setFade(B, inside ? 0.0 : hits.has(B.body) || camIn ? 0.25 : 1, dt);
        if (B.interior) {
          B.interior.visible = inside;
          B.floors.forEach((fg, i) => { fg.visible = inside && i <= this.myLevel; fg.children.forEach((ch) => { if ((ch as THREE.Sprite).isSprite) ch.visible = i === this.myLevel && ch.position.distanceTo(this.camera.position) > 9; }); });
          // sliding doors open as you drive up to a room
          for (const dr of B.doors) {
            const near = inside && dr.level === this.myLevel && Math.hypot(dr.x - (mp.x / S + 0.5), dr.y - (mp.z / S + 0.5)) < 0.03;
            dr.open += ((near ? 1 : 0) - dr.open) * Math.min(1, dt * 6);
            dr.mesh.position.x = dr.home + dr.open * 3.1;
          }
        }
        B.shutter.visible = B.sealed && !inside;
      }
      this.clearTrees(this.camera.position, mp);
    } else { for (const B of this.bldgs) { this.setFade(B, 1, dt); B.shutter.visible = B.sealed; if (B.interior) B.interior.visible = false; } this.clearTrees(null, null); }

    // labels and rings: your floor only; in squad view only the nearest few places get a name
    const ref = this.mode === 'follow' && meObj ? meObj.car.position : null;
    const onMyFloor = (lvl: number, bldg: string | null) => (this.myLevel === 0 ? lvl === 0 : lvl === this.myLevel && bldg === this.myBldg);
    const ranked = ref ? this.labels.filter((lb) => onMyFloor(lb.level, lb.bldg)).map((lb) => ({ lb, d: Math.hypot(lb.pos.x - ref.x, lb.pos.z - ref.z) })).sort((a, b) => a.d - b.d) : [];
    const named = new Set(ranked.filter((r) => r.d > 8 && r.d < 90).slice(0, 4).map((r) => r.lb.id));
    for (const lb of this.labels) {
      const m = lb.sprite.material as THREE.SpriteMaterial;
      const want = !ref ? (lb.level === 0 && !lb.inB && !lb.id.endsWith('_stairs') ? 0.9 : 0) : named.has(lb.id) && !meObj?.data.hidden && !meObj?.data.chute ? 1 : 0; // no place tags while on board or in the air // big map: buildings carry their own sign, so only outdoor places get a tag
      m.opacity += (want - m.opacity) * Math.min(1, dt * 6);
      lb.sprite.visible = m.opacity > 0.03;
    }
    for (const pad of this.pads) {
      const box = pad.userData.ring as THREE.Group;
      const floorOk = ref ? onMyFloor(pad.userData.level, pad.userData.bldg) : pad.userData.level === 0 && !String(pad.userData.id).endsWith('_stairs');
      const dd = ref ? Math.hypot(pad.position.x - ref.x, pad.position.z - ref.z) : 0;
      box.visible = pad.visible = floorOk && (!ref || dd < 140);
      box.scale.setScalar(ref ? 1.4 : Math.max(1.4, Math.min(4, box.position.distanceTo(this.camera.position) / 70))); // big map: readable from afar, normal size up close
      // far away (or on the big map) a box is just its body and lid: trim, stripe and shadows off
      const nearBox = !!ref && dd < 45;
      if (box.userData.near !== nearBox) { box.userData.near = nearBox; for (const ch of box.children) { if (ch === box.userData.lid || ch === box.userData.glow) continue; if (ch.userData.detail) ch.visible = nearBox; if ((ch as THREE.Mesh).isMesh) (ch as THREE.Mesh).castShadow = nearBox; } }
      // the lid swings open when you walk up to the box (or it is your target)
      const lid = box.userData.lid as THREE.Object3D | undefined;
      if (lid && box.visible) {
        const want = (ref && dd < 7) || this.hlId === pad.userData.id ? 1 : 0;
        box.userData.k = (box.userData.k || 0) + (want - (box.userData.k || 0)) * Math.min(1, dt * 5);
        const was = box.userData.k0 || 0; box.userData.k0 = box.userData.k;
        if (was < 0.5 && box.userData.k >= 0.5) this.vfx.loot(box.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.8, 0)), box.userData.gold ? 0xffc23d : 0x7fd0ff);
        lid.rotation.x = -box.userData.k * 1.9;
        (box.userData.glow as THREE.Mesh).visible = box.userData.k > 0.2;
      }
    }
    let shook = false;
    if (this.shake > 0.01) {
      const a = this.shake * this.shake * 0.35; shook = true;
      this.camera.position.x += (Math.random() - 0.5) * a; this.camera.position.y += (Math.random() - 0.5) * a;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    // sound: listener on the camera, beds by situation, the nearest engines
    if (nowMs - this.ambAt > 66) {
      this.ambAt = nowMs;
      const me = meObj?.data;
      const scene = this.mode !== 'follow' ? 'outdoor' : me?.hidden && this.plane?.visible ? 'board' : me?.chute ? (meObj?.wasFree ? 'freefall' : 'chute') : insideB ? 'indoor' : 'outdoor';
      const cam = this.camera.position; const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      const engines = [...this.squads.values()].filter((o) => o.car.visible && !o.data.foot && !o.data.chute && !o.data.hidden && !o.data.down)
        .map((o) => ({ id: o.data.key, p: o.car.position, speed: o.spd ?? 0, d: o.car.position.distanceTo(cam) })).filter((e) => e.d < 120).sort((a, b) => a.d - b.d);
      this.amb.update({ cam, fwd, up: this.camera.up, scene, engines, plane: this.planeData && this.plane ? this.plane.position : null });
    }
    if (this.composer) this.composer.render(dt); else this.renderer.render(this.scene, this.camera);
    if (shook) this.camera.position.copy(this.camPos);
    this.fpsOverlay?.update(this.monitor, this.adaptive.scale, this.quality, this.renderer.info, nowMs);
  };

  private isInside(B: Bldg, p: THREE.Vector3) {
    const x = p.x / S + 0.5; const y = p.z / S + 0.5;
    return x > B.b.x0 && x < B.b.x1 && y > B.b.y0 && y < B.b.y1;
  }

  private animateWater(t: number) {
    const pts = this.water!; const { seeds, c, r } = pts.userData;
    const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = pos.count;
    for (let i = 0; i < n; i++) {
      const a = seeds[i * 4]; const ph = (seeds[i * 4 + 1] + t * 0.6 * seeds[i * 4 + 3]) % 1; const rim = seeds[i * 4 + 2];
      if (rim) {
        // rim jets arc inward
        const rr = r * 0.9 * (1 - ph * 0.6); const hgt = 1 + Math.sin(ph * Math.PI) * 3.2;
        pos.setXYZ(i, c.x + Math.cos(a) * rr, hgt, c.z + Math.sin(a) * rr);
      } else {
        // central plume
        const rr = ph * 3.6; const hgt = 5.2 + Math.sin(ph * Math.PI) * 4.5 - ph * 2;
        pos.setXYZ(i, c.x + Math.cos(a) * rr, hgt, c.z + Math.sin(a) * rr);
      }
    }
    pos.needsUpdate = true;
  }

  // trees standing between the camera and the squad shrink away so they never block the view
  private clearTrees(cam: THREE.Vector3 | null, me: THREE.Vector3 | null) {
    const hide: number[] = [];
    if (cam && me) {
      const a = new THREE.Vector2(cam.x, cam.z); const b = new THREE.Vector2(me.x, me.z); const ab = b.clone().sub(a); const l2 = ab.lengthSq() || 1;
      this.trees.forEach((t, i) => {
        const p = new THREE.Vector2(t.p.x, t.p.z);
        if (p.distanceTo(b) > 40) return;
        const u = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2));
        const dd = p.distanceTo(a.clone().addScaledVector(ab, u));
        if (dd < 3.4 * t.s || p.distanceTo(b) < 4) hide.push(i);
      });
    }
    const key = hide.join(',');
    if (key === this.treeHidden) return;
    const prev = new Set(this.treeHidden ? this.treeHidden.split(',').map(Number) : []);
    this.treeHidden = key;
    const now = new Set(hide);
    const m4 = new THREE.Matrix4();
    // indices are per kind: rebuild the visible matrices of changed trees
    let nt = 0; let np = 0;
    const idx = this.trees.map((t) => (t.palm ? np++ : nt++));
    for (const i of new Set([...prev, ...now])) {
      const t = this.trees[i]; const s = now.has(i) ? 0.0001 : t.s; const j = idx[i];
      if (t.palm) {
        m4.makeScale(s, s, s).setPosition(t.p.x, 3.5 * t.s, t.p.z); this.treeMeshes[2].setMatrixAt(j, m4);
        m4.makeScale(s, s, s).setPosition(t.p.x, 7.2 * t.s, t.p.z); this.treeMeshes[3].setMatrixAt(j, m4);
      } else {
        m4.makeScale(s, s, s).setPosition(t.p.x, 1.2 * t.s, t.p.z); this.treeMeshes[0].setMatrixAt(j, m4);
        m4.makeScale(s * 1.1, s * 1.25, s * 1.1).setPosition(t.p.x, 3.4 * t.s, t.p.z); this.treeMeshes[1].setMatrixAt(j, m4);
      }
    }
    for (const m of this.treeMeshes) m.instanceMatrix.needsUpdate = true;
  }

  private setFade(B: Bldg, target: number, dt: number) {
    const f = B.fade + (target - B.fade) * Math.min(1, dt * 8);
    if (Math.abs(f - B.fade) < 0.002 && f === target) return;
    B.fade = Math.abs(f - target) < 0.01 ? target : f;
    const solid = B.fade > 0.98;
    for (const m of B.mats) {
      if (m.transparent === solid) { m.transparent = !solid; m.depthWrite = solid; m.needsUpdate = true; }
      m.opacity = solid ? 1 : B.fade;
    }
    B.body.visible = B.fade > 0.02;
    B.body.castShadow = solid;
    for (const e of B.extras) e.visible = B.fade > 0.5;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('hb:quality', this.onQuality);
    window.removeEventListener('hb:fps', this.onFps);
    this.fpsOverlay?.dispose();
    this.vfx?.dispose();
    this.amb?.dispose();
    this.composer?.dispose();
    if ((window as any).__hexaWorld === this) (window as any).__hexaWorld = null;
    for (const o of this.squads.values()) disposeAvatar(o.avatar);
    this.scene.traverse((o: any) => {
      if (!o.geometry?.userData?.shared) o.geometry?.dispose?.();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { if (m.userData?.shared) continue; m.map?.dispose?.(); m.dispose?.(); }
    });
    this.renderer.dispose();
  }
}
