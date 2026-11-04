// 3D campus world (three.js). Daylight battle-royale look: sky, sun shadows, solid textured
// buildings, roads, trees, parked cars, and squads of four animated characters.
// Campus coordinates are 0..1 (x east, y south); world units = S per campus width.
import * as THREE from 'three';
import type { MapData } from '../lib/game';
import { animatePerson, makePerson, Person, ROLE_HEX } from './people';

export const S = 120;
const W = (x: number, y: number) => new THREE.Vector3((x - 0.5) * S, 0, (y - 0.5) * S);

export type WorldSquad = {
  key: string; number: number; x: number; y: number; me?: boolean; ally?: boolean; inBattle?: boolean; down?: boolean; moving?: boolean;
  roles?: string[]; label?: string;
};
export type WorldState = {
  squads: WorldSquad[];
  zone?: { cur?: number[] | null; next?: number[] | null } | null;
  red?: { x: number; y: number; r: number; at: string } | null;
  airdrops?: { key: string; location: string; tier: string }[];
  battles?: { key: string; x: number; y: number }[];
  focus?: { x: number; y: number } | null;
  locRadius?: number;
  highlight?: string | null;
  waypoint?: { x: number; y: number } | null;
  route?: { x: number; y: number } | null;
};
export type CameraMode = 'follow' | 'overview' | 'orbit';
export type LiveMe = { x: number; y: number; moving: boolean; joy?: boolean; yaw?: number };

const TIER_HEX: Record<string, number> = { common: 0xdfe6ee, rare: 0x3ea5ff, legendary: 0xffc23d, mystery: 0xb07cff, cursed: 0xff4d5e, intel: 0x5dff9e };
const BUILDING: Record<string, { h: number; wall: string; glass: string; roof: number; name: string }> = {
  hexavarsity: { h: 15, wall: '#eef1f4', glass: '#3a8fb7', roof: 0x7d8792, name: 'HEXAVARSITY' },
  eb1: { h: 19, wall: '#d9cbb0', glass: '#4f7ea8', roof: 0x6f7378, name: 'EB1' },
  eb2: { h: 19, wall: '#dcd3c4', glass: '#47809f', roof: 0x6f7378, name: 'EB2' },
  eb3: { h: 19, wall: '#d4c7b4', glass: '#4b789d', roof: 0x6f7378, name: 'EB3' },
  rtb: { h: 17, wall: '#b8644a', glass: '#355d7c', roof: 0x5d5f63, name: 'RATAN TATA BLDG' },
  phase2: { h: 17, wall: '#c4ccd6', glass: '#2f6f9a', roof: 0x6a7079, name: 'PHASE 2' },
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
  sp.userData.base = sp.scale.clone();
  return sp;
}

function facadeTexture(wall: string, glass: string, floors: number) {
  return canvasTex(256, 64 * floors, (g) => {
    g.fillStyle = wall; g.fillRect(0, 0, 256, 64 * floors);
    for (let f = 0; f < floors; f++) {
      const y = f * 64;
      const ground = f === floors - 1;
      // window band with a sky reflection gradient
      const grd = g.createLinearGradient(0, y + 12, 0, y + 52);
      grd.addColorStop(0, '#cfe9ff'); grd.addColorStop(0.35, glass); grd.addColorStop(1, '#1c3550');
      g.fillStyle = grd;
      g.fillRect(8, y + (ground ? 8 : 14), 240, ground ? 50 : 36);
      g.fillStyle = wall;
      for (let x = 8; x <= 248; x += ground ? 80 : 40) g.fillRect(x - 2, y + 10, 4, 48); // mullions
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y + 60, 256, 4); // floor line shadow
      if (Math.random() < 0.25 && !ground) { g.fillStyle = 'rgba(255,230,170,0.35)'; g.fillRect(48 + Math.floor(Math.random() * 4) * 40, y + 16, 34, 32); }
    }
  });
}

const grassTex = () => canvasTex(256, 256, (g) => {
  g.fillStyle = '#5f9b45'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const c = ['#6aa94e', '#538a3c', '#78b35a', '#4d7f37'][i % 4];
    g.fillStyle = c; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 3);
  }
}, [60, 60]);
const pavingTex = () => canvasTex(128, 128, (g) => {
  g.fillStyle = '#c9c2b4'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(90,80,70,0.25)'; g.lineWidth = 2;
  for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
}, [6, 6]);
const roofTex = (base: number) => canvasTex(128, 128, (g) => {
  const c = new THREE.Color(base);
  g.fillStyle = `#${c.getHexString()}`; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 800; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)'; g.fillRect(Math.random() * 128, Math.random() * 128, 3, 3); }
}, [3, 3]);

type SquadObj = { group: THREE.Group; people: Person[]; ring: THREE.Mesh; label: THREE.Sprite; target: THREE.Vector3; heading: number; data: WorldSquad; sig: string };
type Bldg = { body: THREE.Mesh; extras: THREE.Object3D[]; mats: THREE.MeshStandardMaterial[]; x0: number; x1: number; y0: number; y1: number; fade: number };

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
  private labels: { sprite: THREE.Sprite; pos: THREE.Vector3; id: string }[] = [];
  private squads = new Map<string, SquadObj>();
  private drops = new Map<string, THREE.Group>();
  private battles = new Map<string, THREE.Group>();
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
  private camPos = new THREE.Vector3(0, 140, 110);
  private focus = new THREE.Vector3();
  private locXY = new Map<string, { x: number; y: number }>();
  private ro: ResizeObserver;
  private onPick?: (id: string) => void;
  private reduced: boolean;
  private lowEnd: boolean;
  private highlightRing!: THREE.Mesh;
  private ray = new THREE.Raycaster();
  private animated: THREE.Object3D[] = [];
  private waypoint!: THREE.Group;
  private routeLine!: THREE.Mesh;
  private routeTo: THREE.Vector3 | null = null;
  private trees: { p: THREE.Vector3; s: number }[] = [];
  private treeMeshes: THREE.InstancedMesh[] = [];
  private treeHidden = '';

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
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 1200);
    this.camera.position.copy(this.camPos);
    const haze = 0xcde4f5;
    this.scene.background = new THREE.Color(haze);
    this.scene.fog = new THREE.Fog(haze, 160, 460);

    this.buildSky();
    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5d7a3f, 1.25));
    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
    this.sun.castShadow = !this.lowEnd;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 260;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.buildWorld(map);
    this.buildZone();

    this.highlightRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.highlightRing.rotation.x = -Math.PI / 2; this.highlightRing.position.y = 0.35; this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);
    // marker beacon (yellow) and the path the squad is auto-running along
    this.waypoint = new THREE.Group();
    const wb = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 70, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    wb.position.y = 35;
    const wr = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.6, 32), new THREE.MeshBasicMaterial({ color: 0xffd23d, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
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

  // ── sky dome with sun glow and drifting clouds ──
  private buildSky() {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
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
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(cm);
      const a = (i / 14) * Math.PI * 2; const d = 220 + Math.random() * 200;
      s.position.set(Math.cos(a) * d, 90 + Math.random() * 70, Math.sin(a) * d);
      s.scale.set(140 + Math.random() * 80, 60 + Math.random() * 30, 1);
      s.userData.cloud = true;
      this.animated.push(s);
      this.scene.add(s);
    }
  }

  private buildWorld(map: MapData) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshLambertMaterial({ map: grassTex() }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    this.scene.add(ground);
    // campus boundary wall with a hedge
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.9 });
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 1 });
    for (const [x, z, w, d] of [[0, -S * 0.53, S * 1.06, 0.6], [0, S * 0.53, S * 1.06, 0.6], [-S * 0.53, 0, 0.6, S * 1.06], [S * 0.53, 0, 0.6, S * 1.06]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.8, d), wallMat); m.position.set(x, 0.9, z); m.castShadow = m.receiveShadow = true;
      const h = new THREE.Mesh(new THREE.BoxGeometry(w + (w > 1 ? 0 : 1.2), 1.2, d + (d > 1 ? 0 : 1.2)), hedgeMat); h.position.set(x, 0.6, z + (z < 0 ? 1.2 : z > 0 ? -1.2 : 0)); h.position.x += x < 0 ? 1.2 : x > 0 ? -1.2 : 0;
      this.scene.add(m, h);
    }

    const locs = map.locations;
    for (const l of locs) this.locXY.set(l.id, { x: l.x, y: l.y });
    const byId = new Map(locs.map((l) => [l.id, l]));

    // roads with sidewalks and lane markings
    const road = new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.95 });
    const walk = new THREE.MeshStandardMaterial({ color: 0xbdb6a6, roughness: 0.9 });
    const lane = new THREE.MeshBasicMaterial({ color: 0xf2efe4 });
    const roadPts: THREE.Vector3[] = [];
    for (const [a, b] of map.edges) {
      const A = byId.get(a); const B = byId.get(b);
      if (!A || !B || (A.building && A.building === B.building)) continue;
      const pa = W(A.x, A.y); const pb = W(B.x, B.y);
      const len = pa.distanceTo(pb);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const side = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, len), walk); side.position.set(mid.x, 0.05, mid.z); side.lookAt(pb.x, 0.05, pb.z); side.receiveShadow = true;
      const tar = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, len), road); tar.position.set(mid.x, 0.08, mid.z); tar.rotation.copy(side.rotation); tar.receiveShadow = true;
      this.scene.add(side, tar);
      for (let d = 2; d < len - 2; d += 4) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 1.8), lane);
        const p = pa.clone().lerp(pb, d / len);
        dash.position.set(p.x, 0.15, p.z); dash.rotation.x = -Math.PI / 2; dash.rotation.z = -Math.atan2(pb.x - pa.x, pb.z - pa.z);
        this.scene.add(dash);
      }
      for (let d = 6; d < len - 4; d += 14) roadPts.push(pa.clone().lerp(pb, d / len));
    }
    // street lamps
    const lampPole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), new THREE.MeshStandardMaterial({ color: 0x4a4f57 }), roadPts.length);
    const lampHead = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0b0, emissiveIntensity: 0.6 }), roadPts.length);
    const m4 = new THREE.Matrix4();
    roadPts.forEach((p, i) => {
      m4.makeTranslation(p.x + 3.2, 2.1, p.z); lampPole.setMatrixAt(i, m4);
      m4.makeTranslation(p.x + 2.9, 4.2, p.z); lampHead.setMatrixAt(i, m4);
    });
    lampPole.castShadow = true;
    this.scene.add(lampPole, lampHead);

    // central plaza paving
    const plaza = ['central_steps', 'hexadine', 'hexacafe', 'hexaraunt', 'fountain'].map((id) => byId.get(id)).filter(Boolean) as typeof locs;
    if (plaza.length) {
      const cx = plaza.reduce((a, l) => a + l.x, 0) / plaza.length; const cy = plaza.reduce((a, l) => a + l.y, 0) / plaza.length;
      const c = W(cx, cy);
      const pv = new THREE.Mesh(new THREE.CircleGeometry(13, 48), new THREE.MeshStandardMaterial({ map: pavingTex(), roughness: 0.95 }));
      pv.rotation.x = -Math.PI / 2; pv.position.set(c.x, 0.07, c.z); pv.receiveShadow = true;
      this.scene.add(pv);
    }

    // buildings: solid blocks with facades, parapet, rooftop units
    const groups = new Map<string, typeof locs>();
    for (const l of locs) if (l.building && BUILDING[l.building]) groups.set(l.building, [...(groups.get(l.building) || []), l]);
    for (const [bid, ls] of groups) {
      const spec = BUILDING[bid];
      const xs = ls.map((l) => l.x); const ys = ls.map((l) => l.y);
      const pad = 0.04;
      const x0 = Math.min(...xs) - pad; const x1 = Math.max(...xs) + pad; const y0 = Math.min(...ys) - pad; const y1 = Math.max(...ys) + pad;
      const w = (x1 - x0) * S; const d = (y1 - y0) * S; const h = spec.h;
      const floors = Math.max(3, Math.round(h / 3.6));
      const fx = facadeTexture(spec.wall, spec.glass, floors); fx.wrapS = THREE.RepeatWrapping; fx.repeat.set(Math.max(1, Math.round(w / 9)), 1);
      const fz = facadeTexture(spec.wall, spec.glass, floors); fz.wrapS = THREE.RepeatWrapping; fz.repeat.set(Math.max(1, Math.round(d / 9)), 1);
      const sideX = new THREE.MeshStandardMaterial({ map: fz, roughness: 0.55, metalness: 0.1 });
      const sideZ = new THREE.MeshStandardMaterial({ map: fx, roughness: 0.55, metalness: 0.1 });
      const roof = new THREE.MeshStandardMaterial({ map: roofTex(spec.roof), roughness: 0.95 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [sideX, sideX, roof, roof, sideZ, sideZ]);
      const c = W((x0 + x1) / 2, (y0 + y1) / 2);
      body.position.set(c.x, h / 2, c.z);
      body.castShadow = body.receiveShadow = true;
      this.scene.add(body);
      const extras: THREE.Object3D[] = [];
      const parMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(spec.wall).multiplyScalar(0.85), roughness: 0.8 });
      for (const [px, pz, pw, pd] of [[0, -d / 2, w, 0.4], [0, d / 2, w, 0.4], [-w / 2, 0, 0.4, d], [w / 2, 0, 0.4, d]] as const) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(pw + 0.4, 1, pd + 0.4), parMat); p.position.set(c.x + px, h + 0.5, c.z + pz); p.castShadow = true; extras.push(p);
      }
      const unitMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.6, metalness: 0.3 });
      for (let i = 0; i < 4; i++) {
        const u = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 1.2), unitMat);
        u.position.set(c.x + (i % 2 ? 1 : -1) * w * 0.22, h + 0.55, c.z + (i < 2 ? 1 : -1) * d * 0.2); u.castShadow = true; extras.push(u);
      }
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.8, 14), new THREE.MeshStandardMaterial({ color: 0x2f5d8a, roughness: 0.5 }));
      tank.position.set(c.x + w * 0.3, h + 0.9, c.z - d * 0.3); tank.castShadow = true; extras.push(tank);
      // entrance canopy on the south face
      const can = new THREE.Mesh(new THREE.BoxGeometry(Math.min(8, w * 0.4), 0.3, 2.4), new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.4, metalness: 0.4 }));
      can.position.set(c.x, 3.4, c.z + d / 2 + 1.1); can.castShadow = true; extras.push(can);
      for (const e of extras) this.scene.add(e);
      const sign = labelSprite(spec.name, '#ffffff', 'rgba(20,40,70,0.75)', 1.4);
      sign.position.set(c.x, h + 3.2, c.z);
      extras.push(sign);
      this.scene.add(sign);
      const mats = [sideX, sideZ, roof, parMat, unitMat];
      this.bldgs.push({ body, extras, mats, x0, x1, y0, y1, fade: 1 });
    }

    // sports fields
    for (const l of locs.filter((l) => l.kind === 'sports')) {
      const c = W(l.x, l.y);
      const turf = canvasTex(256, 160, (g) => {
        for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#3f9b49' : '#47a852'; g.fillRect(i * 32, 0, 32, 160); }
        g.strokeStyle = '#f4f4f4'; g.lineWidth = 4; g.strokeRect(10, 10, 236, 140); g.beginPath(); g.moveTo(128, 10); g.lineTo(128, 150); g.stroke();
        g.beginPath(); g.arc(128, 80, 26, 0, Math.PI * 2); g.stroke();
      });
      const f = new THREE.Mesh(new THREE.PlaneGeometry(14, 9), new THREE.MeshStandardMaterial({ map: turf, roughness: 1 }));
      f.rotation.x = -Math.PI / 2; f.position.set(c.x, 0.06, c.z); f.receiveShadow = true;
      this.scene.add(f);
      const netMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
      for (const sx of [-1, 1]) { const goal = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.6, 3), netMat); goal.position.set(c.x + sx * 6.8, 0.8, c.z); goal.castShadow = true; this.scene.add(goal); }
    }
    // fountain + kiosks
    const fountain = byId.get('fountain');
    if (fountain) {
      const c = W(fountain.x, fountain.y).add(new THREE.Vector3(0, 0, -6.5)); // beside the spot squads stand on
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.2, 0.8, 32), new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 0.7 }));
      basin.position.set(c.x, 0.4, c.z); basin.castShadow = basin.receiveShadow = true;
      const water = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 0.15, 32), new THREE.MeshStandardMaterial({ color: 0x4fb3e8, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.9 }));
      water.position.set(c.x, 0.75, c.z);
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.6, 20), new THREE.MeshStandardMaterial({ color: 0xd9d4c8 }));
      tier.position.set(c.x, 1.4, c.z); tier.castShadow = true;
      const jet = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.55 }));
      jet.position.set(c.x, 3.2, c.z); jet.userData.jet = true; this.animated.push(jet);
      this.scene.add(basin, water, tier, jet);
    }
    for (const l of ['hexadine', 'hexacafe', 'hexaraunt'].map((id) => byId.get(id)).filter(Boolean) as typeof locs) {
      const c = W(l.x, l.y);
      const kiosk = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 3.6), new THREE.MeshStandardMaterial({ color: l.tags.includes('coffee') ? 0x6b3e2e : 0xf2ead8, roughness: 0.7 }));
      kiosk.position.set(c.x, 1.6, c.z - 2.4); kiosk.castShadow = kiosk.receiveShadow = true;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.25, 1.8), new THREE.MeshStandardMaterial({ color: l.tags.includes('coffee') ? 0x1f7a4d : 0xe2453b }));
      awning.position.set(c.x, 3, c.z - 0.3); awning.rotation.x = 0.25; awning.castShadow = true;
      const umb = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.6, 10), new THREE.MeshStandardMaterial({ color: 0xffc23d }));
      umb.position.set(c.x + 3.4, 2.3, c.z + 1.6); umb.castShadow = true;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2), new THREE.MeshStandardMaterial({ color: 0x777777 }));
      pole.position.set(c.x + 3.4, 1.1, c.z + 1.6);
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.08, 12), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      table.position.set(c.x + 3.4, 0.8, c.z + 1.6);
      this.scene.add(kiosk, awning, umb, pole, table);
    }
    // gates: pillars, boom barrier and a guard booth
    for (const l of locs.filter((l) => l.kind === 'gate')) {
      const c = W(l.x, l.y);
      const horiz = Math.abs(l.y - 0.5) > Math.abs(l.x - 0.5);
      const off = new THREE.Vector3(horiz ? 4 : 0, 0, horiz ? 0 : 4);
      const pil = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.8 });
      for (const sgn of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 5, 1.2), pil); p.position.copy(c).addScaledVector(off, sgn); p.position.y = 2.5; p.castShadow = true; this.scene.add(p); }
      const arch = new THREE.Mesh(new THREE.BoxGeometry(horiz ? 9.2 : 1, 1, horiz ? 1 : 9.2), new THREE.MeshStandardMaterial({ color: 0x1d4f91, roughness: 0.5 }));
      arch.position.set(c.x, 5.3, c.z); arch.castShadow = true;
      const boom = new THREE.Mesh(new THREE.BoxGeometry(horiz ? 6 : 0.18, 0.18, horiz ? 0.18 : 6), new THREE.MeshStandardMaterial({ color: 0xe03b3b }));
      boom.position.set(c.x, 1.1, c.z);
      const booth = new THREE.Mesh(new THREE.BoxGeometry(2, 2.6, 2), new THREE.MeshStandardMaterial({ color: 0xf0ece2 }));
      booth.position.copy(c).addScaledVector(off, 1.8); booth.position.y = 1.3; booth.castShadow = true;
      this.scene.add(arch, boom, booth);
    }
    // TR14 marker: golden light column
    const tr = byId.get('tr14');
    if (tr) {
      const c = W(tr.x, tr.y);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 90, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      beam.position.set(c.x, 45, c.z);
      this.scene.add(beam);
    }
    // parked cars
    const carCols = [0xd23b3b, 0xf2f2f2, 0x2a6bd1, 0x222222, 0xc0c4c8, 0xf0b429];
    for (const l of locs.filter((l) => l.tags.includes('parking'))) {
      const c = W(l.x, l.y);
      for (let i = 0; i < 6; i++) {
        const car = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 3.6), new THREE.MeshStandardMaterial({ color: carCols[(i + l.x * 10) % carCols.length | 0], roughness: 0.35, metalness: 0.5 }));
        body.position.y = 0.55; body.castShadow = true;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 1.9), new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: 0.1, metalness: 0.6 }));
        cab.position.set(0, 1.15, 0.2); cab.castShadow = true;
        car.add(body, cab);
        car.position.set(c.x - 6 + (i % 3) * 2.6 + 5, 0, c.z + (i < 3 ? -2.8 : 2.8));
        this.scene.add(car);
      }
    }

    // trees (instanced, two crown sizes) avoiding buildings and roads
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const N = 220;
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 2, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 }), N);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.6, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), N);
    const col = new THREE.Color();
    let n = 0;
    const blocked = (x: number, y: number) => this.bldgs.some((b) => x > b.x0 - 0.02 && x < b.x1 + 0.02 && y > b.y0 - 0.02 && y < b.y1 + 0.02) || locs.some((l) => Math.hypot(l.x - x, l.y - y) < 0.05);
    for (let i = 0; i < 1400 && n < N; i++) {
      const x = 0.03 + rnd() * 0.94; const y = 0.03 + rnd() * 0.94;
      if (blocked(x, y)) continue;
      const p = W(x, y); const s = 0.8 + rnd() * 0.7;
      m4.makeScale(s, s, s).setPosition(p.x, s, p.z); trunks.setMatrixAt(n, m4);
      m4.makeScale(s * 1.1, s * 1.25, s * 1.1).setPosition(p.x, 2.6 * s, p.z); crowns.setMatrixAt(n, m4);
      crowns.setColorAt(n, col.setHSL(0.27 + rnd() * 0.08, 0.5, 0.28 + rnd() * 0.12));
      this.trees.push({ p: p.clone(), s });
      n++;
    }
    trunks.count = crowns.count = n;
    trunks.castShadow = crowns.castShadow = true;
    this.treeMeshes = [trunks, crowns];
    this.scene.add(trunks, crowns);

    // location rings + labels
    for (const l of locs) {
      if (l.kind === 'start') continue;
      const c = W(l.x, l.y);
      const color = l.id === 'tr14' ? 0xffc23d : 0x2ee6ff;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 0.22, c.z);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2; fill.position.set(c.x, 0.2, c.z);
      fill.userData.id = l.id; fill.userData.ring = ring;
      this.pads.push(fill);
      this.scene.add(ring, fill);
      const sp = labelSprite(SHORT_LABEL[l.id] || l.name.replace(/\s*\(.*\)$/, '').replace(' — Final Battleground', ''), l.id === 'tr14' ? '#ffd56b' : '#ffffff', 'rgba(10,16,28,0.7)', 0.7, true);
      sp.position.set(c.x, 2.6, c.z);
      this.labels.push({ sprite: sp, pos: sp.position.clone(), id: l.id });
      this.scene.add(sp);
    }
    this.setLocRadius(0.035);
  }

  private buildZone() {
    this.wallTex = canvasTex(64, 256, (g) => {
      const grd = g.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, 'rgba(70,140,255,0)'); grd.addColorStop(0.5, 'rgba(70,140,255,0.35)'); grd.addColorStop(1, 'rgba(120,190,255,0.75)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
      g.fillStyle = 'rgba(220,240,255,0.35)';
      for (let y = 0; y < 256; y += 16) g.fillRect(0, y, 64, 2);
    });
    this.wallTex.wrapS = this.wallTex.wrapT = THREE.RepeatWrapping; this.wallTex.repeat.set(30, 1);
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 60, 128, 1, true), new THREE.MeshBasicMaterial({ map: this.wallTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    this.zoneWall.position.y = 30; this.zoneWall.visible = false; this.zoneWall.renderOrder = 5;
    this.zoneOutside = new THREE.Mesh(new THREE.RingGeometry(1, 700, 128, 1), new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    this.zoneOutside.rotation.x = -Math.PI / 2; this.zoneOutside.position.y = 0.3; this.zoneOutside.visible = false;
    this.nextRing = new THREE.Mesh(new THREE.RingGeometry(0.99, 1, 160, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    this.nextRing.rotation.x = -Math.PI / 2; this.nextRing.position.y = 0.4; this.nextRing.visible = false;
    this.red = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.3, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.45;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 64), new THREE.MeshBasicMaterial({ color: 0xff3b4e, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.5; ring.name = 'ring';
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 80, 48, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    pillar.position.y = 40;
    this.red.add(disc, ring, pillar); this.red.visible = false;
    this.scene.add(this.zoneWall, this.zoneOutside, this.nextRing, this.red);
  }

  setLocRadius(r: number) {
    for (const p of this.pads) { p.scale.setScalar(r * S); (p.userData.ring as THREE.Mesh).scale.setScalar(r * S); }
  }
  setMode(m: CameraMode) { this.mode = m; }
  setZoom(z: number) { this.zoom = Math.max(0.45, Math.min(2.4, z)); }

  private makeSquad(d: WorldSquad): SquadObj {
    const group = new THREE.Group();
    const color = d.me ? 0x2ee6ff : d.ally ? 0x5dff9e : 0xff4d5e;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.25, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.25;
    group.add(ring);
    const roles = d.roles && d.roles.length ? d.roles : ['captain', 'scout', 'decoder', 'intel'];
    const people: Person[] = roles.slice(0, 4).map((r, i) => {
      const p = makePerson({ team: d.me || d.ally ? ROLE_HEX[r] ?? 0xcccccc : [0xd13b3b, 0xa82c2c, 0xc94a2a, 0x9e2b44][i], seed: d.number * 4 + i, enemy: !d.me && !d.ally, cap: i % 2 === 0 });
      group.add(p);
      return p;
    });
    const label = labelSprite(d.label || `SQ ${d.number}`, d.me ? '#2ee6ff' : d.ally ? '#5dff9e' : '#ff8a96', 'rgba(10,16,28,0.78)', d.me ? 0.75 : 0.85, true);
    label.position.y = 3.2;
    group.add(label);
    const p = W(d.x, d.y);
    group.position.copy(p);
    this.scene.add(group);
    return { group, people, ring, label, target: p.clone(), heading: 0, data: d, sig: '' };
  }

  setState(st: WorldState) {
    if (st.locRadius) this.setLocRadius(st.locRadius);
    const seen = new Set<string>();
    for (const d of st.squads) {
      seen.add(d.key);
      const sig = `${d.me}|${d.ally}|${(d.roles || []).join()}|${d.label || ''}`;
      let o = this.squads.get(d.key);
      if (o && o.sig !== sig) { this.scene.remove(o.group); o = undefined; }
      if (!o) { o = this.makeSquad(d); o.sig = sig; this.squads.set(d.key, o); }
      if (!(d.me && this.liveMe)) o.target.copy(W(d.x, d.y));
      o.data = d;
      (o.ring.material as THREE.MeshBasicMaterial).opacity = d.down ? 0.35 : 0.9;
    }
    for (const [k, o] of this.squads) if (!seen.has(k)) { this.scene.remove(o.group); this.squads.delete(k); }

    const cur = st.zone?.cur;
    if (cur && cur[2] < 0.86) {
      const c = W(cur[0], cur[1]);
      this.zoneWall.visible = this.zoneOutside.visible = true;
      this.zoneWall.position.set(c.x, 30, c.z); this.zoneWall.scale.set(cur[2] * S, 1, cur[2] * S);
      if (this.zoneR !== cur[2]) {
        this.zoneR = cur[2];
        this.zoneOutside.geometry.dispose();
        this.zoneOutside.geometry = new THREE.RingGeometry(cur[2] * S, 700, 128, 1);
      }
      this.zoneOutside.position.set(c.x, 0.3, c.z);
    } else { this.zoneWall.visible = this.zoneOutside.visible = false; }
    const nx = st.zone?.next;
    if (nx) { const c = W(nx[0], nx[1]); this.nextRing.visible = true; this.nextRing.position.set(c.x, 0.4, c.z); this.nextRing.scale.setScalar(nx[2] * S); }
    else this.nextRing.visible = false;

    if (st.red) {
      const c = W(st.red.x, st.red.y);
      this.red.visible = true; this.red.position.set(c.x, 0, c.z); this.red.scale.set(st.red.r * S, 1, st.red.r * S);
      this.redAt = new Date(st.red.at).getTime();
    } else this.red.visible = false;

    const dseen = new Set<string>();
    for (const a of st.airdrops || []) {
      dseen.add(a.key);
      if (this.drops.has(a.key)) continue;
      const l = this.locXY.get(a.location); if (!l) continue;
      const g = new THREE.Group();
      const col = TIER_HEX[a.tier] ?? 0xffc23d;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), new THREE.MeshStandardMaterial({ color: 0x9a6a37, roughness: 0.8 }));
      crate.position.y = 0.7; crate.castShadow = true;
      for (const y of [0.25, 1.15]) { const band = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.18, 1.86), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5 })); band.position.y = y; g.add(band); }
      const chute = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, roughness: 0.6 }));
      chute.position.y = 7;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 90, 12, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      beam.position.y = 45;
      const smoke = new THREE.Group();
      const sm = new THREE.SpriteMaterial({ map: canvasTex(64, 64, (gg) => { const r = gg.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,90,70,0.8)'); r.addColorStop(1, 'rgba(255,90,70,0)'); gg.fillStyle = r; gg.fillRect(0, 0, 64, 64); }), transparent: true, depthWrite: false });
      for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(sm); s.position.set(0, 1 + i * 1.3, 0); s.scale.setScalar(1.5 + i * 0.5); s.userData.i = i; smoke.add(s); }
      g.add(crate, chute, beam, smoke);
      g.userData = { chute, smoke, t0: performance.now() };
      const p = W(l.x, l.y); g.position.set(p.x + 2.4, 0, p.z + 1.6);
      this.scene.add(g);
      this.drops.set(a.key, g);
    }
    for (const [k, g] of this.drops) if (!dseen.has(k)) { this.scene.remove(g); this.drops.delete(k); }

    const bseen = new Set<string>();
    for (const b of st.battles || []) {
      bseen.add(b.key);
      if (this.battles.has(b.key)) continue;
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.4, 40), new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.5;
      const sp = labelSprite('⚔ DUEL', '#ffffff', 'rgba(220,30,50,0.9)', 1.2); sp.position.y = 6;
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
    const hl = st.highlight ? this.locXY.get(st.highlight) : null;
    if (hl) { const p = W(hl.x, hl.y); this.highlightRing.visible = true; this.highlightRing.position.set(p.x, 0.35, p.z); }
    else this.highlightRing.visible = false;
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
        // one-finger drag turns the camera (1:1 with the finger)
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
      const hit = this.ray.intersectObjects(this.pads, false)[0];
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

    const live = this.liveMe?.current;
    const meObj = [...this.squads.values()].find((o) => o.data.me);
    if (live && meObj) { meObj.target.copy(W(live.x, live.y)); meObj.data.moving = live.moving; }

    for (const o of this.squads.values()) {
      const before = o.group.position.clone();
      o.group.position.lerp(o.target, o.data.me && live ? 1 : k * 0.9);
      const step = o.group.position.clone().sub(before);
      const spd = step.length() / Math.max(dt, 0.001);
      if (step.lengthSq() > 0.00005) o.heading = Math.atan2(-step.x, -step.z);
      const running = Math.min(1, spd / 2.4) * (this.reduced ? 0 : 1);
      // 4 people in a loose wedge behind the leader, all facing the heading
      const offs = [[0, -0.8], [-1.1, 0.4], [1.1, 0.4], [0, 1.4]];
      o.people.forEach((p, i) => {
        const [ox, oz] = offs[i];
        const c = Math.cos(o.heading); const s = Math.sin(o.heading);
        p.position.x = ox * c + oz * s; p.position.z = -ox * s + oz * c;
        let dr = o.heading - p.rotation.y; while (dr > Math.PI) dr -= Math.PI * 2; while (dr < -Math.PI) dr += Math.PI * 2;
        p.rotation.y += dr * Math.min(1, dt * 10);
        animatePerson(p, t, o.data.moving || running > 0.15 ? Math.max(running, o.data.moving ? 0.8 : 0) : 0, !!o.data.down);
      });
      if (o.data.me && !this.reduced) o.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.05);
      o.group.scale.setScalar(this.mode === 'follow' ? 1 : 2.2);
      // auto-run: the camera swings behind the squad; joystick: the camera stays put
      if (o.data.me && this.mode === 'follow' && live && live.moving && !live.joy && step.lengthSq() > 0.0004) {
        const want = Math.atan2(step.x, -step.z);
        let d = want - this.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += d * Math.min(1, dt * 1.5);
      }
    }
    if (live) live.yaw = this.yaw;
    // ground path from the squad to its auto-run destination
    if (this.routeTo && meObj) {
      const a = meObj.group.position; const b = this.routeTo;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      this.routeLine.visible = len > 1;
      this.routeLine.scale.set(0.5, len, 1);
      this.routeLine.position.set((a.x + b.x) / 2, 0.32, (a.z + b.z) / 2);
      this.routeLine.rotation.set(-Math.PI / 2, 0, Math.atan2(b.x - a.x, b.z - a.z) + Math.PI);
    } else this.routeLine.visible = false;
    if (this.waypoint.visible && !this.reduced) this.waypoint.getObjectByName('ring')!.scale.setScalar(1 + Math.sin(t * 4) * 0.15);

    if (!this.reduced) {
      this.wallTex.offset.y = (t * 0.1) % 1;
      for (const g of this.drops.values()) {
        const fall = Math.min(1, (performance.now() - g.userData.t0) / 3000);
        g.position.y = (1 - fall) * 35;
        g.userData.chute.visible = fall < 1;
        g.userData.smoke.visible = fall >= 1;
        g.userData.smoke.children.forEach((s: THREE.Sprite) => { s.position.y = 1 + ((s.userData.i * 1.3 + t * 1.5) % 10); (s.material as THREE.SpriteMaterial).opacity = 0.7; });
      }
      for (const g of this.battles.values()) { const ph = (t * 1.5) % 1; g.userData.ring.scale.setScalar(1 + ph * 0.6); g.userData.ring.material.opacity = 1 - ph; }
      if (this.red.visible) this.red.getObjectByName('ring')!.scale.setScalar(1 + Math.sin(t * (this.redAt - Date.now() < 5000 ? 9 : 3)) * 0.03);
      this.highlightRing.scale.setScalar(4 + Math.sin(t * 5) * 0.4);
      for (const o of this.animated) { if (o.userData.jet) o.scale.y = 1 + Math.sin(t * 6) * 0.08; else o.position.x += dt * 0.6; }
    }

    // camera
    if (this.mode === 'follow') {
      const f = meObj ? meObj.group.position : this.focus;
      const dist = 11 * this.zoom; const height = 6.5 * this.zoom;
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const tgt = f.clone().addScaledVector(fwd, 3).setY(1.4);
      this.camTarget.lerp(tgt, Math.min(1, k * 3));
      this.camPos.lerp(f.clone().addScaledVector(fwd, -dist).setY(height), Math.min(1, k * 3));
    } else if (this.mode === 'overview') {
      this.camTarget.lerp(new THREE.Vector3(0, 0, 6), k);
      this.camPos.lerp(new THREE.Vector3(0, 115 * this.zoom, 85 * this.zoom), k);
    } else {
      const a = t * 0.05;
      this.camTarget.lerp(new THREE.Vector3(0, 0, 0), k);
      this.camPos.lerp(new THREE.Vector3(Math.sin(a) * 110, 85, Math.cos(a) * 110), k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // sun + shadow box follow what the camera is looking at
    const st = this.mode === 'follow' ? this.camTarget : new THREE.Vector3();
    this.sun.position.set(st.x - 50, 90, st.z + 40);
    this.sun.target.position.copy(st);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    const span = this.mode === 'follow' ? 40 * this.zoom : 75;
    if (sc.right !== span) { sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.updateProjectionMatrix(); }

    // buildings fade when you are inside them or they block the view of your squad
    if (this.mode === 'follow' && meObj) {
      const mp = meObj.group.position;
      const mx = mp.x / S + 0.5; const my = mp.z / S + 0.5;
      const dir = mp.clone().setY(1.2).sub(this.camera.position); const len = dir.length(); dir.normalize();
      this.ray.set(this.camera.position, dir); this.ray.far = len;
      const hits = new Set(this.ray.intersectObjects(this.bldgs.map((b) => b.body), false).map((h) => h.object));
      for (const b of this.bldgs) {
        const inside = mx > b.x0 - 0.005 && mx < b.x1 + 0.005 && my > b.y0 - 0.005 && my < b.y1 + 0.005;
        this.setFade(b, inside ? 0.12 : hits.has(b.body) ? 0.3 : 1, dt);
      }
      this.clearTrees(this.camera.position, mp);
    } else { for (const b of this.bldgs) this.setFade(b, 1, dt); this.clearTrees(null, null); }

    for (const lb of this.labels) {
      const d = lb.pos.distanceTo(this.camTarget);
      const m = lb.sprite.material as THREE.SpriteMaterial;
      // in the squad view: hide the label of the place you're standing in and fade far ones
      const standing = this.mode === 'follow' && meObj && lb.pos.distanceTo(meObj.group.position.clone().setY(lb.pos.y)) < 5;
      m.opacity = standing ? 0 : this.mode === 'follow' ? Math.max(0, Math.min(1, (32 * this.zoom - d) / 8)) : 0.9;
      lb.sprite.visible = m.opacity > 0.02;
    }
    this.renderer.render(this.scene, this.camera);
  };

  // trees standing between the camera and the squad shrink away so they never block the view
  private clearTrees(cam: THREE.Vector3 | null, me: THREE.Vector3 | null) {
    const hide: number[] = [];
    if (cam && me) {
      const a = new THREE.Vector2(cam.x, cam.z); const b = new THREE.Vector2(me.x, me.z); const ab = b.clone().sub(a); const l2 = ab.lengthSq() || 1;
      this.trees.forEach((t, i) => {
        const p = new THREE.Vector2(t.p.x, t.p.z);
        const u = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2));
        const dd = p.distanceTo(a.clone().addScaledVector(ab, u));
        if (dd < 2.6 * t.s || p.distanceTo(b) < 3) hide.push(i);
      });
    }
    const key = hide.join(',');
    if (key === this.treeHidden) return;
    const prev = new Set(this.treeHidden ? this.treeHidden.split(',').map(Number) : []);
    this.treeHidden = key;
    const now = new Set(hide);
    const m4 = new THREE.Matrix4();
    for (const i of new Set([...prev, ...now])) {
      const t = this.trees[i]; const vis = !now.has(i); const s = vis ? t.s : 0.0001;
      m4.makeScale(s, s, s).setPosition(t.p.x, t.s, t.p.z); this.treeMeshes[0].setMatrixAt(i, m4);
      m4.makeScale(s * 1.1, s * 1.25, s * 1.1).setPosition(t.p.x, 2.6 * t.s, t.p.z); this.treeMeshes[1].setMatrixAt(i, m4);
    }
    for (const m of this.treeMeshes) m.instanceMatrix.needsUpdate = true;
  }

  private setFade(b: Bldg, target: number, dt: number) {
    const f = b.fade + (target - b.fade) * Math.min(1, dt * 8);
    if (Math.abs(f - b.fade) < 0.002 && f === target) return;
    b.fade = Math.abs(f - target) < 0.01 ? target : f;
    const solid = b.fade > 0.98;
    for (const m of b.mats) {
      if (m.transparent === solid) { m.transparent = !solid; m.depthWrite = solid; m.needsUpdate = true; }
      m.opacity = solid ? 1 : b.fade;
    }
    b.body.castShadow = solid;
    for (const e of b.extras) e.visible = b.fade > 0.5;
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
