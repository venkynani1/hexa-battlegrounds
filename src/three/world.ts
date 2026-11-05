// 3D campus world (three.js), daylight battle-royale look.
// A 1.6 km campus: street grid with sidewalks and lamps, parking yards full of cars, a fountain
// plaza, sports grounds, helipad, solar farm, palms and trees, and multi-storey buildings you can
// enter — every floor has rooms with sliding doors and a stairwell. Squads are buggies in their
// squad colour. Lockdowns light buildings up in red and then shutter them.
// Campus coordinates are 0..1 (x east, y south); world units = S per campus width; one storey = FLOOR_H.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapData, Building } from '../lib/game';
import { squadHex } from '../lib/game';
import { serverTime } from '../lib/time';
import { BUILDINGS as LAYOUT_BUILDINGS, building as layoutBuilding, ROADS, LOTS, FEATURES, FLOOR_H } from '../../content/campus.mjs';
import { animateVehicle, makeVehicle, Vehicle } from './vehicle';

export const S = 560; // campus width in world units (a buggy is ~4.5 long)
export { FLOOR_H };
const W = (x: number, y: number, level = 0) => new THREE.Vector3((x - 0.5) * S, level * FLOOR_H, (y - 0.5) * S);

export type WorldSquad = {
  key: string; number: number; x: number; y: number; me?: boolean; ally?: boolean; inBattle?: boolean; down?: boolean; moving?: boolean;
  vx?: number; vy?: number; at?: number; level?: number; bldg?: string | null; label?: string;
};
export type WorldState = {
  squads: WorldSquad[];
  zone?: { cur?: number[] | null; next?: number[] | null } | null;
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
export type LiveMe = { x: number; y: number; moving: boolean; joy?: boolean; yaw?: number; level?: number; bldg?: string | null; vx?: number; vy?: number };

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

// screen = true keeps a constant on-screen size (game-style name plates)
function labelSprite(text: string, color = '#ffffff', bg = 'rgba(10,16,28,0.72)', scale = 1, screen = false) {
  const font = '700 44px Rajdhani, "Segoe UI", system-ui, sans-serif';
  const probe = document.createElement('canvas').getContext('2d')!; probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 36;
  const tex = canvasTex(w, 64, (g) => {
    g.font = font; g.fillStyle = bg;
    const r = 14;
    g.beginPath(); g.moveTo(r, 0); g.arcTo(w, 0, w, 64, r); g.arcTo(w, 64, 0, 64, r); g.arcTo(0, 64, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.fill();
    g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(text, w / 2, 34);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: !screen, transparent: true, fog: false, sizeAttenuation: !screen }));
  const hgt = screen ? 0.04 * scale : 1.6 * scale;
  sp.scale.set((w / 64) * hgt, hgt, 1);
  sp.renderOrder = 10;
  return sp;
}

function facadeTexture(wall: string, glass: string, floors: number, style: string) {
  const tower = style === 'tower'; const dc = style === 'datacenter';
  return canvasTex(256, 64 * floors, (g) => {
    g.fillStyle = wall; g.fillRect(0, 0, 256, 64 * floors);
    for (let f = 0; f < floors; f++) {
      const y = f * 64; const ground = f === floors - 1;
      if (dc) {
        g.fillStyle = 'rgba(0,0,0,0.18)';
        for (let x = 10; x < 250; x += 16) g.fillRect(x, y + 14, 8, 36); // vents
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y + 60, 256, 4);
        continue;
      }
      const grd = g.createLinearGradient(0, y + 8, 0, y + 56);
      grd.addColorStop(0, '#d8eeff'); grd.addColorStop(0.35, glass); grd.addColorStop(1, '#16304a');
      g.fillStyle = grd;
      if (tower) g.fillRect(2, y + 4, 252, 56);
      else g.fillRect(8, y + (ground ? 8 : 14), 240, ground ? 50 : 36);
      g.fillStyle = tower ? 'rgba(220,235,250,0.6)' : wall;
      for (let x = 8; x <= 248; x += ground ? 80 : tower ? 32 : 40) g.fillRect(x - (tower ? 1 : 2), y + 4, tower ? 2 : 4, 56);
      g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(0, y + 60, 256, 4);
      // lit offices
      for (let k = 0; k < 3; k++) if (Math.random() < 0.3 && !ground) { g.fillStyle = 'rgba(255,232,170,0.35)'; g.fillRect(16 + Math.floor(Math.random() * 6) * 40, y + 16, 30, 30); }
    }
  });
}

const noiseTex = (base: string, dots: string[], n: number, rep: [number, number], size = 256, dot = 3) => canvasTex(size, size, (g) => {
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) { g.fillStyle = dots[i % dots.length]; g.fillRect(Math.random() * size, Math.random() * size, dot, dot); }
}, rep);

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
      parent.add(mesh);
      list.forEach((g) => g.dispose());
    }
    this.m.clear();
  }
}

type SquadObj = { car: Vehicle; ring: THREE.Mesh; label: THREE.Sprite; target: THREE.Vector3; heading: number; turn: number; data: WorldSquad; sig: string; y: number };
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
  disposed = false;
  private raf = 0;
  private clock = new THREE.Clock();
  private pads: THREE.Mesh[] = [];
  private labels: { sprite: THREE.Sprite; pos: THREE.Vector3; id: string; level: number; bldg: string | null }[] = [];
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
  private highlightRing!: THREE.Mesh;
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

  constructor(private canvas: HTMLCanvasElement, map: MapData, opts: { onPick?: (id: string) => void; mode?: CameraMode } = {}) {
    this.onPick = opts.onPick;
    this.mode = opts.mode || 'follow';
    this.reduced = document.documentElement.classList.contains('reduced-motion');
    this.lowEnd = !!(navigator as any).hardwareConcurrency && (navigator as any).hardwareConcurrency <= 4;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.lowEnd, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.lowEnd ? 1.25 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.lowEnd;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 2600);
    this.camera.position.copy(this.camPos);
    const haze = 0xcfe3f2;
    this.scene.background = new THREE.Color(haze);
    this.scene.fog = new THREE.Fog(haze, 380, 1500);

    this.buildSky();
    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5d7a3f, 1.2));
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.5);
    this.sun.castShadow = !this.lowEnd;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1; sc.far = 400;
    this.scene.add(this.sun, this.sun.target);

    for (const l of map.locations) this.locs.set(l.id, l);
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
    };
    const P = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
      plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      disc: new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
    };

    // ground + campus boundary
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshLambertMaterial({ map: noiseTex('#5c9a43', ['#68a84d', '#518a3b', '#76b358', '#4a7e36'], 6000, [140, 140]) }));
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
    const lampPts: THREE.Vector3[] = [];
    const dashes: { p: THREE.Vector3; a: number }[] = [];
    for (const r of ROADS) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, ay] = r.pts[i]; const [bx, by] = r.pts[i + 1];
        const a = W(ax, ay); const b = W(bx, by); const len = a.distanceTo(b);
        const mid = a.clone().add(b).multiplyScalar(0.5); const ang = Math.atan2(b.x - a.x, b.z - a.z);
        const w = r.w * S;
        batch.add(P.plane, M.walk, [mid.x, 0.06, mid.z], ang, [w + 7, 1, len + w + 7]);
        batch.add(P.box, M.curb, [mid.x, 0.12, mid.z], ang, [w + 0.6, 0.18, len + w]);
        batch.add(P.plane, M.road, [mid.x, 0.22, mid.z], ang, [w, 1, len + w]);
        for (let d = 3; d < len - 3; d += 6) dashes.push({ p: a.clone().lerp(b, d / len), a: ang });
        const side = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(w / 2 + 2.6);
        for (let d = 8; d < len - 4; d += 34) { const p = a.clone().lerp(b, d / len); lampPts.push(p.clone().add(side)); lampPts.push(p.clone().sub(side)); }
        roadSegs.push([ax, ay, bx, by, r.w]);
      }
    }
    for (const d of dashes) batch.add(P.plane, M.lane, [d.p.x, 0.25, d.p.z], d.a, [0.22, 1, 2.6]);
    for (const p of lampPts) {
      batch.add(P.cyl6, M.metal, [p.x, 3, p.z], 0, [0.22, 6, 0.22]);
      batch.add(P.box, M.lampHead, [p.x, 6.05, p.z], 0, [1, 0.22, 0.45]);
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
        batch.add(P.box, M.white, [x, 1.9, z], Math.PI / 2, [2.6, 2.8, 11]);
        batch.add(P.box, M.glassDark, [x, 2.5, z], Math.PI / 2, [2.66, 1, 10]);
      }
    }
    // cars (instanced, two parts)
    const carBody = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.75, 4.2), new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }), Math.max(1, cars.length));
    const carCab = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, 0.65, 2.2), new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.1, metalness: 0.6 }), Math.max(1, cars.length));
    const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1); const col = new THREE.Color();
    cars.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.a + (rnd() - 0.5) * 0.06);
      m4.compose(new THREE.Vector3(c.p.x, 0.6, c.p.z), q, one); carBody.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(c.p.x, 1.28, c.p.z + (c.a ? 0.25 : -0.25)), q, one); carCab.setMatrixAt(i, m4);
      carBody.setColorAt(i, col.setHex(c.c));
    });
    carBody.count = carCab.count = cars.length;
    carBody.castShadow = carCab.castShadow = true;
    this.scene.add(carBody, carCab);

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
    const N = this.lowEnd ? 380 : 700;
    for (let i = 0; i < 6000 && spots.length < N; i++) {
      const x = 0.02 + rnd() * 0.96; const y = 0.02 + rnd() * 0.96;
      if (blocked(x, y)) continue;
      const nearWater = Math.hypot(x - 0.47, y - 0.44) < 0.12 || Math.hypot(x - 0.06, y - 0.9) < 0.1;
      spots.push({ x, y, palm: nearWater || rnd() < 0.2 });
    }
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 }), spots.length);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), spots.length);
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

    batch.flush(this.scene);

    // ── place rings + labels (outdoors and ground floors; upstairs rooms show inside their building) ──
    for (const l of map.locations) {
      if (l.kind === 'start' || !l.enabled) continue;
      const level = l.level || 0;
      const c = W(l.x, l.y, level);
      const color = l.id === 'tr14' ? 0xffc23d : l.kind === 'stairs' ? 0x5dff9e : 0xffffff;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, c.y + 0.32, c.z);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2; fill.position.set(c.x, c.y + 0.3, c.z);
      fill.userData = { id: l.id, ring, level, bldg: level > 0 ? l.building : null };
      this.pads.push(fill);
      this.scene.add(ring, fill);
      const name = l.kind === 'stairs' ? '⇅ STAIRS' : SHORT_LABEL[l.id] || l.name.replace(/\s*\(.*\)$/, '').replace(' — Final Battleground', '');
      const sp = labelSprite(name, l.id === 'tr14' ? '#ffd56b' : l.kind === 'stairs' ? '#5dff9e' : '#ffffff', 'rgba(10,16,28,0.7)', 0.7, true);
      sp.position.set(c.x, c.y + 3.2, c.z);
      this.labels.push({ sprite: sp, pos: sp.position.clone(), id: l.id, level, bldg: level > 0 ? l.building : null });
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
    const fx = facadeTexture(st.wall, st.glass, b.floors, b.style); fx.wrapS = THREE.RepeatWrapping; fx.repeat.set(Math.max(1, Math.round(w / 10)), 1);
    const fz = facadeTexture(st.wall, st.glass, b.floors, b.style); fz.wrapS = THREE.RepeatWrapping; fz.repeat.set(Math.max(1, Math.round(d / 10)), 1);
    const sideX = new THREE.MeshStandardMaterial({ map: fz, roughness: 0.5, metalness: b.style === 'tower' ? 0.35 : 0.1 });
    const sideZ = new THREE.MeshStandardMaterial({ map: fx, roughness: 0.5, metalness: b.style === 'tower' ? 0.35 : 0.1 });
    const roof = new THREE.MeshStandardMaterial({ map: noiseTex(`#${new THREE.Color(st.roof).getHexString()}`, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.06)'], 800, [3, 3], 128), roughness: 0.95 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [sideX, sideX, roof, roof, sideZ, sideZ]);
    body.position.set(c.x, h / 2, c.z);
    body.castShadow = body.receiveShadow = true;
    this.scene.add(body);
    const extras: THREE.Object3D[] = [];
    const parMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(st.wall).multiplyScalar(0.85), roughness: 0.8 });
    const add = (m: THREE.Object3D) => { extras.push(m); this.scene.add(m); return m; };
    for (const [px, pz, pw, pd] of [[0, -d / 2, w, 0.5], [0, d / 2, w, 0.5], [-w / 2, 0, 0.5, d], [w / 2, 0, 0.5, d]] as const) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(pw + 0.5, 1.1, pd + 0.5), parMat); p.position.set(c.x + px, h + 0.55, c.z + pz); p.castShadow = true; add(p);
    }
    // storey bands (accent stripes) — also used to show which floor is under lockdown
    const bands: THREE.Mesh[] = [];
    for (let f = 1; f < b.floors + 1; f++) {
      // a frame of four strips around the facade (not a slab: the camera can be inside a building)
      const frame = new THREE.BoxGeometry(1, 1, 1);
      const parts = [[0, -d / 2, w + 0.3, 0.3], [0, d / 2, w + 0.3, 0.3], [-w / 2, 0, 0.3, d + 0.3], [w / 2, 0, 0.3, d + 0.3]].map(([px, pz, sx, sz]) =>
        frame.clone().scale(sx, 0.35, sz).translate(px, 0, pz));
      const band = new THREE.Mesh(mergeGeometries(parts, false)!, new THREE.MeshStandardMaterial({ color: st.band ? new THREE.Color(st.band) : new THREE.Color(st.wall).multiplyScalar(0.8), emissive: 0x000000, roughness: 0.6 }));
      band.position.set(c.x, f * FLOOR_H - 0.1, c.z); add(band); bands.push(band);
    }
    const unitMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.6, metalness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const u = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 1.8), unitMat);
      u.position.set(c.x + (i % 2 ? 1 : -1) * w * 0.22, h + 0.75, c.z + (i < 2 ? 1 : -1) * d * 0.2); u.castShadow = true; add(u);
    }
    if (b.floors >= 4) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 14), new THREE.MeshStandardMaterial({ color: 0x2f5d8a, roughness: 0.5 }));
      tank.position.set(c.x + w * 0.3, h + 1.3, c.z - d * 0.3); tank.castShadow = true; add(tank);
    }
    if (b.style === 'pavilion') {
      const over = new THREE.Mesh(new THREE.BoxGeometry(w + 6, 0.6, d + 6), new THREE.MeshStandardMaterial({ color: st.roof, roughness: 0.7 }));
      over.position.set(c.x, h + 0.2, c.z); over.castShadow = true; add(over);
    }
    // entrance: canopy over sliding glass doors at the front door
    const door = W(b.door[0], b.door[1]);
    const can = new THREE.Mesh(new THREE.BoxGeometry(Math.min(14, w * 0.4), 0.35, 4.2), new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.4, metalness: 0.4 }));
    can.position.set(door.x, 3.6, c.z + d / 2 + 1.9); can.castShadow = true; add(can);
    const gl = new THREE.Mesh(new THREE.BoxGeometry(Math.min(8, w * 0.25), 3, 0.2), new THREE.MeshStandardMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.45, roughness: 0.05, metalness: 0.4 }));
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
    return { b, body, extras, mats: [sideX, sideZ, roof, parMat, unitMat], fade: 1, interior: null, floors: [], doors: [], alarm, shutter, sealed: false, lockLabel: null, lockKey: '', bands };
  }

  // Interior of a building: a slab per floor, rooms with walls and sliding doors along a corridor,
  // a stairwell with real steps, and room name plates. Built once, on first entry.
  private buildInterior(B: Bldg) {
    const b = B.b; const g = new THREE.Group();
    const w = (b.x1 - b.x0) * S; const d = (b.y1 - b.y0) * S;
    const c = W((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    const slabM = new THREE.MeshStandardMaterial({ map: canvasTex(128, 128, (gg) => { gg.fillStyle = '#d9d6cf'; gg.fillRect(0, 0, 128, 128); gg.strokeStyle = 'rgba(0,0,0,0.08)'; for (let i = 0; i <= 128; i += 32) { gg.beginPath(); gg.moveTo(i, 0); gg.lineTo(i, 128); gg.stroke(); gg.beginPath(); gg.moveTo(0, i); gg.lineTo(128, i); gg.stroke(); } }, [Math.round(w / 4), Math.round(d / 4)]), roughness: 0.7 });
    const wallM = new THREE.MeshStandardMaterial({ color: 0xf1efe9, roughness: 0.8 });
    const glassM = new THREE.MeshStandardMaterial({ color: 0x9ed4f5, transparent: true, opacity: 0.35, roughness: 0.05 });
    const doorM = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.4, metalness: 0.3 });
    const corM = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.7 });
    const stepM = new THREE.MeshStandardMaterial({ color: 0x9aa1a9, roughness: 0.6 });
    const deskM = new THREE.MeshStandardMaterial({ color: 0xc8a477, roughness: 0.7 });
    const corridorZ = W(0, (b.y0 + b.y1) / 2).z;
    const rooms = [...this.locs.values()].filter((l) => l.building === b.id && l.kind !== 'stairs' && l.enabled);
    const st = W(b.stairs[0], b.stairs[1]);
    for (let f = 0; f < b.floors; f++) {
      const fg = new THREE.Group(); const y = f * FLOOR_H;
      const bt = new Batch();
      const box = new THREE.BoxGeometry(1, 1, 1);
      bt.add(box, slabM, [c.x, y + 0.15, c.z], 0, [w - 0.4, 0.3, d - 0.4]);
      bt.add(box, corM, [c.x, y + 0.32, corridorZ], 0, [w - 1.2, 0.04, 5]);
      // outer walls as low glass (you can see out) with solid corners
      for (const [px, pz, pw, pd] of [[0, -d / 2 + 0.3, w - 0.6, 0.2], [0, d / 2 - 0.3, w - 0.6, 0.2], [-w / 2 + 0.3, 0, 0.2, d - 0.6], [w / 2 - 0.3, 0, 0.2, d - 0.6]] as const) {
        bt.add(box, glassM, [c.x + px, y + 1.4, c.z + pz], 0, [pw, 2.4, pd]);
      }
      const here = rooms.filter((l) => (l.level || 0) === f);
      const cellW = Math.min(w / 3.2, 22); const cellD = Math.min((d - 6) / 2 - 0.5, 16);
      for (const l of here) {
        const p = W(l.x, l.y);
        const north = p.z < corridorZ;
        const rz = north ? corridorZ - 2.5 - cellD / 2 : corridorZ + 2.5 + cellD / 2;
        const doorSideZ = north ? rz + cellD / 2 : rz - cellD / 2;
        // three solid walls + corridor wall with a door gap
        bt.add(box, wallM, [p.x - cellW / 2, y + 1.5, rz], 0, [0.25, 2.7, cellD]);
        bt.add(box, wallM, [p.x + cellW / 2, y + 1.5, rz], 0, [0.25, 2.7, cellD]);
        bt.add(box, wallM, [p.x, y + 1.5, north ? rz - cellD / 2 : rz + cellD / 2], 0, [cellW, 2.7, 0.25]);
        const gap = 3.2;
        const seg = (cellW - gap) / 2;
        bt.add(box, wallM, [p.x - gap / 2 - seg / 2, y + 1.5, doorSideZ], 0, [seg, 2.7, 0.25]);
        bt.add(box, wallM, [p.x + gap / 2 + seg / 2, y + 1.5, doorSideZ], 0, [seg, 2.7, 0.25]);
        // furniture: rows of desks
        for (let k = -1; k <= 1; k++) bt.add(box, deskM, [p.x + k * cellW * 0.28, y + 0.75, rz + (north ? -1.5 : 1.5)], 0, [cellW * 0.2, 0.1, 1.4]);
        if (l.id === 'tr14') bt.add(box, new THREE.MeshStandardMaterial({ color: 0xffc23d, emissive: 0xffa000, emissiveIntensity: 0.4 }), [p.x, y + 0.36, rz], 0, [cellW - 1, 0.04, cellD - 1]);
        // sliding door
        const dm = new THREE.Mesh(new THREE.BoxGeometry(gap, 2.5, 0.15), doorM);
        dm.position.set(p.x, y + 1.45, doorSideZ);
        fg.add(dm);
        B.doors.push({ mesh: dm, open: 0, x: l.x, y: l.y, level: f, axis: 'x', home: p.x });
        const lab = labelSprite(SHORT_LABEL[l.id] || l.name.replace(' — Final Battleground', ''), l.id === 'tr14' ? '#ffd56b' : '#ffffff', 'rgba(10,16,28,0.78)', 0.9);
        lab.position.set(p.x, y + 3.4, doorSideZ);
        fg.add(lab);
      }
      // stairwell: a flight of steps going up from this floor, railing, a landing
      if (b.floors > 1) {
        for (let k = 0; k < 12; k++) bt.add(box, stepM, [st.x - 2.4 + k * 0.4, y + 0.3 + (k + 1) * (FLOOR_H / 12) / 2, st.z - 1.2], 0, [0.4, (k + 1) * (FLOOR_H / 12), 2.2]);
        bt.add(box, stepM, [st.x, y + 0.2, st.z + 1.4], 0, [5, 0.1, 2.4]);
        bt.add(box, new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 }), [st.x, y + 1.2, st.z - 2.4], 0, [5, 0.08, 0.08]);
        const sl = labelSprite(`⇅ STAIRS · ${f === 0 ? 'G' : f}`, '#5dff9e', 'rgba(10,16,28,0.8)', 0.9);
        sl.position.set(st.x, y + 3.6, st.z); fg.add(sl);
      }
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
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 120, 160, 1, true), new THREE.MeshBasicMaterial({ map: this.wallTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
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

  setLocRadius(r: number) {
    for (const p of this.pads) { p.scale.setScalar(r * S); (p.userData.ring as THREE.Mesh).scale.setScalar(r * S); }
  }
  setMode(m: CameraMode) { this.mode = m; }
  setZoom(z: number) { this.zoom = Math.max(0.45, Math.min(2.4, z)); }

  private makeSquad(d: WorldSquad): SquadObj {
    const car = makeVehicle({ color: squadHex(d.number), number: d.number });
    const color = d.me ? 0x2ee6ff : d.ally ? 0x5dff9e : 0xff4d5e;
    const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.5, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3;
    car.add(ring);
    const label = labelSprite(d.label || `SQ ${d.number}`, d.me ? '#2ee6ff' : d.ally ? '#5dff9e' : '#ff8a96', 'rgba(10,16,28,0.78)', 0.85, true);
    label.position.y = 5;
    label.visible = !d.me;
    car.add(label);
    const p = W(d.x, d.y, d.level || 0);
    car.position.copy(p);
    this.scene.add(car);
    return { car, ring, label, target: p.clone(), heading: 0, turn: 0, data: d, sig: '', y: p.y };
  }

  setState(st: WorldState) {
    if (st.locRadius) this.setLocRadius(st.locRadius);
    const seen = new Set<string>();
    for (const d of st.squads) {
      seen.add(d.key);
      const sig = `${d.me}|${d.ally}|${d.label || ''}|${d.number}`;
      let o = this.squads.get(d.key);
      if (o && o.sig !== sig) { this.scene.remove(o.car); o = undefined; }
      if (!o) { o = this.makeSquad(d); o.sig = sig; this.squads.set(d.key, o); }
      o.data = d;
      (o.ring.material as THREE.MeshBasicMaterial).opacity = d.down ? 0.35 : 0.9;
    }
    for (const [k, o] of this.squads) if (!seen.has(k)) { this.scene.remove(o.car); this.squads.delete(k); }

    const cur = st.zone?.cur;
    if (cur && cur[2] < 0.86) {
      const c = W(cur[0], cur[1]);
      this.zoneWall.visible = this.zoneOutside.visible = true;
      this.zoneWall.position.set(c.x, 60, c.z); this.zoneWall.scale.set(cur[2] * S, 1, cur[2] * S);
      if (this.zoneR !== cur[2]) {
        this.zoneR = cur[2];
        this.zoneOutside.geometry.dispose();
        this.zoneOutside.geometry = new THREE.RingGeometry(cur[2] * S, 3000, 160, 1);
      }
      this.zoneOutside.position.set(c.x, 0.4, c.z);
    } else { this.zoneWall.visible = this.zoneOutside.visible = false; }
    const nx = st.zone?.next;
    if (nx) { const c = W(nx[0], nx[1]); this.nextRing.visible = true; this.nextRing.position.set(c.x, 0.5, c.z); this.nextRing.scale.setScalar(nx[2] * S); }
    else this.nextRing.visible = false;

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
    }
    for (const [k, g] of this.drops) if (!dseen.has(k)) { this.scene.remove(g); this.drops.delete(k); }

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
    const hl = st.highlight ? this.locs.get(st.highlight) : null;
    if (hl) { const p = W(hl.x, hl.y, hl.level || 0); this.highlightRing.visible = true; this.highlightRing.position.set(p.x, p.y + 0.4, p.z); }
    else this.highlightRing.visible = false;
  }

  private makeCrate(tier: string) {
    const g = new THREE.Group();
    const col = TIER_HEX[tier] ?? 0xffc23d;
    const crate = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2.4), new THREE.MeshStandardMaterial({ color: 0x9a6a37, roughness: 0.8 }));
    crate.position.y = 0.9; crate.castShadow = true;
    for (const y of [0.3, 1.5]) { const band = new THREE.Mesh(new THREE.BoxGeometry(2.46, 0.22, 2.46), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5 })); band.position.y = y; g.add(band); }
    const chute = new THREE.Mesh(new THREE.SphereGeometry(3.6, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, roughness: 0.6 }));
    chute.position.y = 9;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 140, 12, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    beam.position.y = 70;
    const smoke = new THREE.Group();
    const sm = new THREE.SpriteMaterial({ map: canvasTex(64, 64, (gg) => { const r = gg.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,90,70,0.8)'); r.addColorStop(1, 'rgba(255,90,70,0)'); gg.fillStyle = r; gg.fillRect(0, 0, 64, 64); }), transparent: true, depthWrite: false });
    for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(sm); s.position.set(0, 1 + i * 1.6, 0); s.scale.setScalar(2 + i * 0.6); s.userData.i = i; smoke.add(s); }
    g.add(crate, chute, beam, smoke);
    g.userData = { chute, smoke, t0: performance.now(), fall: true };
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
  private makeLoot(kind: string) {
    const g = new THREE.Group();
    if (kind === 'medkit') {
      const tex = canvasTex(64, 64, (c) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, 64, 64); c.fillStyle = '#e8283a'; c.fillRect(24, 10, 16, 44); c.fillRect(10, 24, 44, 16); });
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0x401010, emissiveIntensity: 0.3 }));
      g.add(m);
    } else if (kind === 'shield') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.35, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3ea5ff, emissive: 0x1d6fd1, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.3 }));
      g.add(m);
    } else {
      const gold = new THREE.MeshStandardMaterial({ color: 0xffc23d, emissive: 0x7a5200, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.25 });
      for (let i = 0; i < 4; i++) { const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.14, 16), gold); coin.position.y = i * 0.16 - 0.2; coin.position.x = (i % 2) * 0.08; g.add(coin); }
    }
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.3, 24), new THREE.MeshBasicMaterial({ color: kind === 'medkit' ? 0xff6b6b : kind === 'shield' ? 0x3ea5ff : 0xffc23d, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = -0.8; glow.name = 'glow';
    g.add(glow);
    return g;
  }

  private resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || 360; const h = el.clientHeight || 640;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.75 ? 62 : 50;
    this.camera.updateProjectionMatrix();
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
        const dx = e.clientX - last.x;
        if (Math.abs(e.clientX - downPos.x) > 6) dragged = true;
        if (dragged) this.yaw -= dx * 0.008;
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
        const age = Math.max(0, Math.min(1.2, (now - (d.at || now)) / 1000));
        o.target.copy(W(d.x + (d.vx || 0) * age, d.y + (d.vy || 0) * age, d.level || 0));
      }
      const before = o.car.position.clone();
      // own squad follows the prediction exactly; others glide with a short smoothing
      o.car.position.lerp(o.target, d.me && live ? 1 : Math.min(1, dt * 7));
      const step = o.car.position.clone().sub(before); step.y = 0;
      const spd = step.length() / Math.max(dt, 0.001);
      let turn = 0;
      if (step.lengthSq() > 0.0004) {
        const hd = Math.atan2(-step.x, -step.z);
        let dh = hd - o.heading; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
        o.heading += dh * Math.min(1, dt * 8); turn = dh / Math.max(dt, 0.016);
      }
      o.car.rotation.y = o.heading;
      animateVehicle(o.car, t, dt, this.reduced ? 0 : spd, this.reduced ? 0 : turn, !!d.down);
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
        const fall = Math.min(1, (performance.now() - g.userData.t0) / 3000);
        g.position.y = (1 - fall) * 50;
        g.userData.chute.visible = fall < 1;
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
    const insideB = this.myLevel > 0 || this.bldgs.some((B) => meObj && this.isInside(B, meObj.car.position));
    if (this.mode === 'follow') {
      const f = meObj ? meObj.car.position : this.focus;
      const dist = (insideB ? 13 : 17) * this.zoom; const height = (insideB ? 12 : 8.5) * this.zoom;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const tgt = f.clone().addScaledVector(fwd, 4); tgt.y = f.y + 1.6;
      this.camTarget.lerp(tgt, Math.min(1, k * 3));
      const cp = f.clone().addScaledVector(fwd, -dist); cp.y = f.y + height;
      this.camPos.lerp(cp, Math.min(1, k * 3));
    } else if (this.mode === 'overview') {
      this.camTarget.lerp(new THREE.Vector3(0, 0, 10), k);
      this.camPos.lerp(new THREE.Vector3(0, 420 * this.zoom, 320 * this.zoom), k);
    } else {
      const a = t * 0.04;
      this.camTarget.lerp(new THREE.Vector3(0, 0, 0), k);
      this.camPos.lerp(new THREE.Vector3(Math.sin(a) * 400, 300, Math.cos(a) * 400), k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

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
        const inside = this.isInside(B, mp) || (this.myLevel > 0 && this.myBldg === B.b.id);
        if (inside && !B.interior) this.buildInterior(B);
        const camIn = this.isInside(B, this.camera.position) && this.camera.position.y < B.b.floors * FLOOR_H + 2;
        this.setFade(B, inside ? 0.0 : hits.has(B.body) || camIn ? 0.25 : 1, dt);
        if (B.interior) {
          B.interior.visible = inside;
          B.floors.forEach((fg, i) => { fg.visible = inside && i <= this.myLevel; fg.children.forEach((ch) => { if ((ch as THREE.Sprite).isSprite) ch.visible = i === this.myLevel; }); });
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
      const want = !ref ? (lb.level === 0 && !lb.id.endsWith('_stairs') ? 0.9 : 0) : named.has(lb.id) ? 1 : 0;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 6);
      lb.sprite.visible = m.opacity > 0.03;
    }
    for (const pad of this.pads) {
      const ring = pad.userData.ring as THREE.Mesh;
      const floorOk = ref ? onMyFloor(pad.userData.level, pad.userData.bldg) : pad.userData.level === 0 && !String(pad.userData.id).endsWith('_stairs');
      const dd = ref ? Math.hypot(pad.position.x - ref.x, pad.position.z - ref.z) : 0;
      const op = !floorOk ? 0 : !ref ? 0.6 : Math.max(0, Math.min(0.75, (80 - dd) / 25));
      (ring.material as THREE.MeshBasicMaterial).opacity = op;
      ring.visible = pad.visible = op > 0.02;
    }
    this.renderer.render(this.scene, this.camera);
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
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { m.map?.dispose?.(); m.dispose?.(); }
    });
    this.renderer.dispose();
  }
}
