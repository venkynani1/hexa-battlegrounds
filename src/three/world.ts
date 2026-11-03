// 3D campus world (three.js, no framework). One instance per canvas.
// Campus coordinates are 0..1 (x east, y south); world units = S per campus width.
import * as THREE from 'three';
import type { MapData } from '../lib/game';

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
};
export type CameraMode = 'follow' | 'overview' | 'orbit';

const ROLE_HEX: Record<string, number> = { captain: 0xffc23d, scout: 0x3ef0ff, decoder: 0xb07cff, intel: 0x5dff9e };
const TIER_HEX: Record<string, number> = { common: 0x9fb3c8, rare: 0x3ea5ff, legendary: 0xffc23d, mystery: 0xb07cff, cursed: 0xff4d5e, intel: 0x5dff9e };
const KIND_HEX: Record<string, number> = { gate: 0xff8a3d, building: 0x3ea5ff, room: 0x3ea5ff, hub: 0x3ef0ff, amenity: 0x5dff9e, sports: 0x5dff9e };
const BUILDING_H: Record<string, number> = { hexavarsity: 13, eb1: 17, eb2: 17, eb3: 17, rtb: 15, phase2: 15 };

export const SHORT_LABEL: Record<string, string> = {};

function labelSprite(text: string, color = '#e6f0ff', bg = 'rgba(6,10,18,0.72)', scale = 1) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '700 44px Rajdhani, "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w; c.height = 64;
  ctx.font = font;
  ctx.fillStyle = bg;
  const r = 14;
  ctx.beginPath(); ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, 64, r); ctx.arcTo(w, 64, 0, 64, r); ctx.arcTo(0, 64, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sp.scale.set((w / 64) * 2.2 * scale, 2.2 * scale, 1);
  sp.renderOrder = 10;
  return sp;
}

function windowTexture(lit = 0.35) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f2036'; g.fillRect(0, 0, 128, 256);
  for (let y = 8; y < 256; y += 20) for (let x = 6; x < 128; x += 16) {
    const on = Math.random() < lit;
    g.fillStyle = on ? (Math.random() < 0.7 ? '#9fd8ff' : '#ffd38a') : '#16314f';
    g.globalAlpha = on ? 0.95 : 0.7;
    g.fillRect(x, y, 10, 12);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16251c'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(40,70,48,0.5)' : 'rgba(10,24,16,0.5)';
    g.fillRect(Math.random() * 512, Math.random() * 512, 3, 3);
  }
  g.strokeStyle = 'rgba(120,200,255,0.06)'; g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function zoneWallTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(62,165,255,0)');
  grd.addColorStop(0.55, 'rgba(62,165,255,0.35)');
  grd.addColorStop(1, 'rgba(120,200,255,0.85)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
  g.fillStyle = 'rgba(200,235,255,0.35)';
  for (let y = 0; y < 256; y += 16) g.fillRect(0, y, 64, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 1);
  return t;
}

type SquadObj = { group: THREE.Group; ring: THREE.Mesh; label: THREE.Sprite; figs: THREE.Group[]; target: THREE.Vector3; data: WorldSquad; labelText: string };

export class WorldScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'follow';
  zoom = 1;
  private raf = 0;
  private clock = new THREE.Clock();
  private pads: THREE.Mesh[] = [];
  private labels: { sprite: THREE.Sprite; pos: THREE.Vector3; id: string }[] = [];
  private squads = new Map<string, SquadObj>();
  private drops = new Map<string, THREE.Group>();
  private battles = new Map<string, THREE.Group>();
  private zoneWall: THREE.Mesh;
  private zoneOutside: THREE.Mesh;
  private nextRing: THREE.Mesh;
  private red: THREE.Group;
  private redAt = 0;
  private wallTex: THREE.Texture;
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3(0, 140, 110);
  private focus = new THREE.Vector3();
  private locXY = new Map<string, { x: number; y: number }>();
  private ro: ResizeObserver;
  private onPick?: (id: string) => void;
  private reduced: boolean;
  private highlightRing: THREE.Mesh;
  liveMe: { current: { x: number; y: number; moving: boolean } } | null = null;
  private zoneR = -1;
  disposed = false;

  constructor(private canvas: HTMLCanvasElement, map: MapData, opts: { onPick?: (id: string) => void; mode?: CameraMode } = {}) {
    this.onPick = opts.onPick;
    this.mode = opts.mode || 'follow';
    this.reduced = document.documentElement.classList.contains('reduced-motion');
    const lowEnd = (navigator as any).hardwareConcurrency && (navigator as any).hardwareConcurrency <= 4;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 900);
    this.camera.position.copy(this.camPos);
    this.scene.background = new THREE.Color(0x070c16);
    this.scene.fog = new THREE.Fog(0x070c16, 140, 380);

    this.scene.add(new THREE.HemisphereLight(0x8cbcff, 0x0a1220, 1.1));
    const sun = new THREE.DirectionalLight(0xffd9a8, 1.6);
    sun.position.set(-60, 120, 80);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x3ea5ff, 0.6);
    rim.position.set(80, 60, -90);
    this.scene.add(rim);

    this.buildWorld(map);

    // zone visuals
    this.wallTex = zoneWallTexture();
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 40, 96, 1, true),
      new THREE.MeshBasicMaterial({ map: this.wallTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }));
    this.zoneWall.position.y = 20;
    this.zoneWall.visible = false;
    this.zoneWall.renderOrder = 5;
    this.scene.add(this.zoneWall);
    this.zoneOutside = new THREE.Mesh(new THREE.RingGeometry(1, 600, 96, 1),
      new THREE.MeshBasicMaterial({ color: 0x2a6bff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    this.zoneOutside.rotation.x = -Math.PI / 2;
    this.zoneOutside.position.y = 0.25;
    this.zoneOutside.visible = false;
    this.scene.add(this.zoneOutside);
    this.nextRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 128, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.nextRing.rotation.x = -Math.PI / 2;
    this.nextRing.position.y = 0.35;
    this.nextRing.visible = false;
    this.scene.add(this.nextRing);

    this.red = new THREE.Group();
    const redDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.28, depthWrite: false }));
    redDisc.rotation.x = -Math.PI / 2; redDisc.position.y = 0.4;
    const redRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    redRing.rotation.x = -Math.PI / 2; redRing.position.y = 0.45; redRing.name = 'ring';
    const redPillar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 60, 48, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2238, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    redPillar.position.y = 30;
    this.red.add(redDisc, redRing, redPillar);
    this.red.visible = false;
    this.scene.add(this.red);

    this.highlightRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.highlightRing.rotation.x = -Math.PI / 2; this.highlightRing.position.y = 0.6; this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this.bindInput();
    this.loop();
  }

  private buildWorld(map: MapData) {
    // ground + campus pad
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ map: groundTexture() }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(S * 1.04, 0.2, S * 1.04), new THREE.MeshLambertMaterial({ color: 0x1a2a24 }));
    pad.position.y = 0.05;
    this.scene.add(pad);
    // perimeter wall
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x2b3a52 });
    for (const [x, z, w, d] of [[0, -S * 0.52, S * 1.04, 0.8], [0, S * 0.52, S * 1.04, 0.8], [-S * 0.52, 0, 0.8, S * 1.04], [S * 0.52, 0, 0.8, S * 1.04]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, d), wallMat);
      m.position.set(x, 0.8, z);
      this.scene.add(m);
    }

    const locs = map.locations;
    for (const l of locs) this.locXY.set(l.id, { x: l.x, y: l.y });
    const byId = new Map(locs.map((l) => [l.id, l]));

    // roads between different buildings/areas
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x232c3a });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x5b6f8a });
    for (const [a, b] of map.edges) {
      const A = byId.get(a); const B = byId.get(b);
      if (!A || !B || (A.building && A.building === B.building)) continue;
      const pa = W(A.x, A.y); const pb = W(B.x, B.y);
      const len = pa.distanceTo(pb);
      const road = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, len), roadMat);
      road.position.copy(pa).add(pb).multiplyScalar(0.5); road.position.y = 0.18;
      road.lookAt(pb.x, 0.18, pb.z);
      this.scene.add(road);
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, len * 0.92), lineMat);
      dash.position.copy(road.position); dash.position.y = 0.26; dash.rotation.copy(road.rotation);
      this.scene.add(dash);
    }

    // buildings: one glass block per building group
    const groups = new Map<string, typeof locs>();
    for (const l of locs) if (l.building && BUILDING_H[l.building]) groups.set(l.building, [...(groups.get(l.building) || []), l]);
    for (const [bid, ls] of groups) {
      const xs = ls.map((l) => l.x); const ys = ls.map((l) => l.y);
      const pad2 = 0.045;
      const x0 = Math.min(...xs) - pad2; const x1 = Math.max(...xs) + pad2; const y0 = Math.min(...ys) - pad2; const y1 = Math.max(...ys) + pad2;
      const w = (x1 - x0) * S; const d = (y1 - y0) * S; const h = BUILDING_H[bid];
      const tex = windowTexture(0.28);
      tex.repeat.set(Math.max(1, w / 16), Math.max(1, h / 14));
      const side = new THREE.MeshStandardMaterial({
        color: 0x1d3656, map: tex, emissive: 0x6fb8ff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0.5,
        transparent: true, opacity: 0.5, depthWrite: false,
      });
      const roof = new THREE.MeshStandardMaterial({ color: 0x24456e, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.2, metalness: 0.4 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, roof, roof, side, side]);
      const c = W((x0 + x1) / 2, (y0 + y1) / 2);
      body.position.set(c.x, h / 2 + 0.2, c.z);
      body.renderOrder = 2;
      this.scene.add(body);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.85 }));
      edges.position.copy(body.position);
      this.scene.add(edges);
      // floor slabs
      for (let f = 1; f < Math.floor(h / 4); f++) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.25, d * 0.98), new THREE.MeshLambertMaterial({ color: 0x24405f, transparent: true, opacity: 0.35, depthWrite: false }));
        slab.position.set(c.x, f * 4 + 0.2, c.z);
        this.scene.add(slab);
      }
      // roof sign
      const sign = labelSprite(bid === 'hexavarsity' ? 'HEXAVARSITY' : bid === 'rtb' ? 'RATAN TATA BLDG' : bid === 'phase2' ? 'PHASE 2' : bid.toUpperCase(), '#7cc4ff', 'rgba(6,10,18,0.55)', 1.25);
      sign.position.set(c.x, h + 3.4, c.z);
      this.scene.add(sign);
    }

    // sports fields
    for (const l of locs.filter((l) => l.kind === 'sports')) {
      const c = W(l.x, l.y);
      const f = new THREE.Mesh(new THREE.BoxGeometry(11, 0.15, 7.5), new THREE.MeshLambertMaterial({ color: 0x2f7a3e }));
      f.position.set(c.x, 0.2, c.z);
      this.scene.add(f);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(10, 0.01, 6.5)), new THREE.LineBasicMaterial({ color: 0xe8fff0 }));
      lines.position.set(c.x, 0.3, c.z);
      this.scene.add(lines);
    }
    // central plaza + fountain
    const fountain = byId.get('fountain');
    if (fountain) {
      const c = W(fountain.x, fountain.y);
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.8, 0.9, 32), new THREE.MeshStandardMaterial({ color: 0x9aa7b8, roughness: 0.7 }));
      basin.position.set(c.x, 0.45, c.z);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.2, 32), new THREE.MeshStandardMaterial({ color: 0x3ea5ff, emissive: 0x1a5fa0, emissiveIntensity: 0.6, roughness: 0.1 }));
      water.position.set(c.x, 0.85, c.z);
      const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.4, 3, 12), new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.7 }));
      spout.position.set(c.x, 2.2, c.z);
      this.scene.add(basin, water, spout);
    }
    const plaza = ['central_steps', 'hexadine', 'hexacafe', 'hexaraunt'].map((id) => byId.get(id)).filter(Boolean) as typeof locs;
    for (const l of plaza) {
      const c = W(l.x, l.y);
      const kiosk = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 4), new THREE.MeshStandardMaterial({ color: l.tags.includes('food') ? 0x5a3b26 : 0x2c4c3a, roughness: 0.6 }));
      kiosk.position.set(c.x, 1.7, c.z - 1.5);
      const awning = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.25, 2), new THREE.MeshStandardMaterial({ color: l.tags.includes('coffee') ? 0x7a1f2b : 0xffc23d, emissive: 0x221100 }));
      awning.position.set(c.x, 3.1, c.z + 0.3);
      if (l.id !== 'central_steps') this.scene.add(kiosk, awning);
    }
    // gates: two pillars and a lit beam
    for (const l of locs.filter((l) => l.kind === 'gate')) {
      const c = W(l.x, l.y);
      const horiz = Math.abs(l.y - 0.5) > Math.abs(l.x - 0.5);
      const off = new THREE.Vector3(horiz ? 3.2 : 0, 0, horiz ? 0 : 3.2);
      const mat = new THREE.MeshStandardMaterial({ color: 0x3a4658, roughness: 0.5 });
      for (const sgn of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), mat);
        p.position.copy(c).addScaledVector(off, sgn); p.position.y = 3;
        this.scene.add(p);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(horiz ? 7.4 : 0.6, 0.6, horiz ? 0.6 : 7.4), new THREE.MeshStandardMaterial({ color: 0xff8a3d, emissive: 0xff8a3d, emissiveIntensity: 0.9 }));
      beam.position.set(c.x, 6.2, c.z);
      this.scene.add(beam);
    }
    // TR14 beacon
    const tr = byId.get('tr14');
    if (tr) {
      const c = W(tr.x, tr.y);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 80, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
      beam.position.set(c.x, 40, c.z);
      this.scene.add(beam);
    }

    // trees (instanced) on a seeded scatter, avoiding buildings and roads roughly
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6), new THREE.MeshLambertMaterial({ color: 0x5a3d26 }), 140);
    const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1.3, 3.2, 7), new THREE.MeshLambertMaterial({ color: 0x2e8a4a }), 140);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < 600 && n < 140; i++) {
      const x = 0.04 + rnd() * 0.92; const y = 0.04 + rnd() * 0.92;
      if (locs.some((l) => Math.hypot(l.x - x, l.y - y) < 0.07)) continue;
      const p = W(x, y); const s = 0.8 + rnd() * 0.6;
      m4.makeScale(s, s, s).setPosition(p.x, 0.7 * s, p.z); trunks.setMatrixAt(n, m4);
      m4.makeScale(s, s, s).setPosition(p.x, 2.8 * s, p.z); crowns.setMatrixAt(n, m4);
      n++;
    }
    trunks.count = crowns.count = n;
    this.scene.add(trunks, crowns);

    // location pads + labels
    for (const l of locs) {
      if (l.kind === 'start') continue;
      const c = W(l.x, l.y);
      const color = l.id === 'tr14' ? 0xffc23d : KIND_HEX[l.kind] ?? 0x3ea5ff;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 0.5, c.z);
      ring.userData.baseScale = 1;
      this.scene.add(ring);
      const hit = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ visible: false }));
      hit.rotation.x = -Math.PI / 2; hit.position.set(c.x, 0.55, c.z);
      hit.userData.id = l.id; hit.userData.ring = ring;
      this.pads.push(hit);
      this.scene.add(hit);
      const sp = labelSprite(SHORT_LABEL[l.id] || l.name.replace(/\s*\(.*\)$/, '').replace(' — Final Battleground', ''), l.id === 'tr14' ? '#ffc23d' : '#e6f0ff', 'rgba(6,10,18,0.72)', 0.85);
      const h = l.building && BUILDING_H[l.building] ? 2.4 : 3.2;
      sp.position.set(c.x, h, c.z);
      sp.userData.base = sp.scale.clone();
      this.labels.push({ sprite: sp, pos: sp.position.clone(), id: l.id });
      this.scene.add(sp);
    }
    this.setLocRadius(0.035);
  }

  setLocRadius(r: number) {
    for (const p of this.pads) {
      p.scale.setScalar(r * S);
      (p.userData.ring as THREE.Mesh).scale.setScalar(r * S);
    }
  }

  setMode(m: CameraMode) { this.mode = m; }
  setZoom(z: number) { this.zoom = Math.max(0.5, Math.min(2.2, z)); }

  private makeSquad(d: WorldSquad): SquadObj {
    const group = new THREE.Group();
    const color = d.me ? 0x3ef0ff : d.ally ? 0x5dff9e : 0xff4d5e;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.1, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.7;
    group.add(ring);
    const roles = d.roles && d.roles.length ? d.roles : ['captain', 'scout', 'decoder', 'intel'];
    const figs: THREE.Group[] = [];
    const offs = [[0, -0.7], [-0.8, 0.2], [0.8, 0.2], [0, 1]];
    roles.slice(0, 4).forEach((r, i) => {
      const f = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.75, 4, 8), new THREE.MeshStandardMaterial({ color: ROLE_HEX[r] ?? 0xcccccc, roughness: 0.5, emissive: ROLE_HEX[r] ?? 0, emissiveIntensity: 0.15 }));
      body.position.y = 1.15;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), new THREE.MeshStandardMaterial({ color: 0xf0c9a0, roughness: 0.7 }));
      head.position.y = 2.05;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.12), new THREE.MeshStandardMaterial({ color: 0x0b1220 }));
      visor.position.set(0, 2.08, -0.26);
      f.add(body, head, visor);
      f.position.set(offs[i][0], 0, offs[i][1]);
      group.add(f);
      figs.push(f);
    });
    const label = labelSprite(d.label || `SQ ${d.number}`, d.me ? '#3ef0ff' : d.ally ? '#5dff9e' : '#ff8a96', 'rgba(6,10,18,0.78)', 0.9);
    label.position.y = 5.4;
    label.userData.base = label.scale.clone();
    group.add(label);
    const p = W(d.x, d.y);
    group.position.copy(p);
    this.scene.add(group);
    return { group, ring, label, figs, target: p.clone(), data: d, labelText: d.label || `SQ ${d.number}` };
  }

  setState(st: WorldState) {
    if (st.locRadius) this.setLocRadius(st.locRadius);
    // squads
    const seen = new Set<string>();
    for (const d of st.squads) {
      seen.add(d.key);
      let o = this.squads.get(d.key);
      const stale = o && (o.data.me !== d.me || o.data.ally !== d.ally || (o.data.roles || []).join() !== (d.roles || []).join() || o.labelText !== (d.label || `SQ ${d.number}`));
      if (o && stale) { this.scene.remove(o.group); o = undefined; }
      if (!o) { o = this.makeSquad(d); this.squads.set(d.key, o); }
      o.target.copy(W(d.x, d.y));
      o.data = d;
      (o.ring.material as THREE.MeshBasicMaterial).opacity = d.down ? 0.35 : 0.95;
    }
    for (const [k, o] of this.squads) if (!seen.has(k)) { this.scene.remove(o.group); this.squads.delete(k); }

    // zone
    const cur = st.zone?.cur;
    if (cur && cur[2] < 0.86) {
      const c = W(cur[0], cur[1]);
      this.zoneWall.visible = true; this.zoneOutside.visible = true;
      this.zoneWall.position.set(c.x, 20, c.z); this.zoneWall.scale.set(cur[2] * S, 1, cur[2] * S);
      if (this.zoneR !== cur[2]) {
        this.zoneR = cur[2];
        (this.zoneOutside.geometry as THREE.RingGeometry).dispose();
        this.zoneOutside.geometry = new THREE.RingGeometry(cur[2] * S, 600, 96, 1);
      }
      this.zoneOutside.position.set(c.x, 0.25, c.z);
    } else { this.zoneWall.visible = false; this.zoneOutside.visible = false; }
    const nx = st.zone?.next;
    if (nx) { const c = W(nx[0], nx[1]); this.nextRing.visible = true; this.nextRing.position.set(c.x, 0.35, c.z); this.nextRing.scale.setScalar(nx[2] * S); }
    else this.nextRing.visible = false;

    // red zone
    if (st.red) {
      const c = W(st.red.x, st.red.y);
      this.red.visible = true; this.red.position.set(c.x, 0, c.z); this.red.scale.set(st.red.r * S, 1, st.red.r * S);
      this.redAt = new Date(st.red.at).getTime();
    } else this.red.visible = false;

    // airdrops
    const dseen = new Set<string>();
    for (const a of st.airdrops || []) {
      dseen.add(a.key);
      if (this.drops.has(a.key)) continue;
      const l = this.locXY.get(a.location); if (!l) continue;
      const g = new THREE.Group();
      const col = TIER_HEX[a.tier] ?? 0xffc23d;
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.3, 1.6), new THREE.MeshStandardMaterial({ color: 0x8a5a2b, emissive: col, emissiveIntensity: 0.35, roughness: 0.6 }));
      crate.position.y = 0.9;
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 1.7), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }));
      band.position.y = 0.9;
      const chute = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
      chute.position.y = 6;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 70, 12, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
      beam.position.y = 35;
      g.add(crate, band, chute, beam);
      g.userData.chute = chute; g.userData.t0 = performance.now();
      const p = W(l.x, l.y); g.position.set(p.x + 2.2, 0, p.z + 1.5);
      this.scene.add(g);
      this.drops.set(a.key, g);
    }
    for (const [k, g] of this.drops) if (!dseen.has(k)) { this.scene.remove(g); this.drops.delete(k); }

    // battles
    const bseen = new Set<string>();
    for (const b of st.battles || []) {
      bseen.add(b.key);
      if (this.battles.has(b.key)) continue;
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.4, 40), new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.8;
      const sp = labelSprite('⚔ DUEL', '#ffffff', 'rgba(255,40,60,0.85)', 1.1);
      sp.position.y = 6.5;
      g.add(ring, sp);
      g.userData.ring = ring;
      const p = W(b.x, b.y); g.position.set(p.x, 0, p.z);
      this.scene.add(g);
      this.battles.set(b.key, g);
    }
    for (const [k, g] of this.battles) if (!bseen.has(k)) { this.scene.remove(g); this.battles.delete(k); }

    if (st.focus) this.focus.copy(W(st.focus.x, st.focus.y));
    if (st.highlight) {
      const l = this.locXY.get(st.highlight);
      if (l) { const p = W(l.x, l.y); this.highlightRing.visible = true; this.highlightRing.position.set(p.x, 0.6, p.z); }
    } else this.highlightRing.visible = false;
  }

  private resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || 360; const h = el.clientHeight || 640;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.75 ? 58 : 46;
    this.camera.updateProjectionMatrix();
  }

  private bindInput() {
    const ray = new THREE.Raycaster();
    const v = new THREE.Vector2();
    const pts = new Map<number, { x: number; y: number }>();
    let downAt = 0; let downPos = { x: 0, y: 0 }; let pinch0 = 0; let zoom0 = 1;
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = performance.now(); downPos = { x: e.clientX, y: e.clientY };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = this.zoom; }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch0 > 0) { const [a, b] = [...pts.values()]; this.setZoom(zoom0 * (pinch0 / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)))); }
    });
    const up = (e: PointerEvent) => {
      const wasSingle = pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = 0;
      if (!wasSingle || !this.onPick) return;
      if (performance.now() - downAt > 450 || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 12) return;
      const r = el.getBoundingClientRect();
      v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(v, this.camera);
      const hit = ray.intersectObjects(this.pads, false)[0];
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
    const k = 1 - Math.pow(0.0015, dt);

    if (this.liveMe) {
      const m = [...this.squads.values()].find((o) => o.data.me);
      if (m) { m.target.copy(W(this.liveMe.current.x, this.liveMe.current.y)); m.data.moving = this.liveMe.current.moving; }
    }
    for (const o of this.squads.values()) {
      const before = o.group.position.clone();
      o.group.position.lerp(o.target, o.data.me ? Math.min(1, k * 2.2) : k);
      const moved = before.distanceTo(o.group.position) > 0.01 || o.data.moving;
      o.figs.forEach((f, i) => {
        f.position.y = moved && !this.reduced ? Math.abs(Math.sin(t * 9 + i * 1.3)) * 0.25 : 0;
        f.rotation.z = o.data.down ? 1.3 : 0;
      });
      const dir = o.target.clone().sub(before);
      if (dir.lengthSq() > 0.0004) o.group.rotation.y = Math.atan2(-dir.x, -dir.z);
      if (o.data.me && !this.reduced) o.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
      o.label.scale.copy(o.label.userData.base).multiplyScalar(this.mode === 'follow' ? 0.8 : 2.4);
      o.group.scale.setScalar(this.mode !== 'follow' ? 1.8 : 1.35);
    }
    if (!this.reduced) {
      this.wallTex.offset.y = (t * 0.12) % 1;
      for (const g of this.drops.values()) {
        const fall = Math.min(1, (performance.now() - g.userData.t0) / 2500);
        g.position.y = (1 - fall) * 30;
        g.userData.chute.visible = fall < 1;
        g.rotation.y = t * 0.6;
      }
      for (const g of this.battles.values()) { const s = 1 + (t * 1.5 % 1) * 0.6; g.userData.ring.scale.setScalar(s); g.userData.ring.material.opacity = 1 - (t * 1.5 % 1); }
      if (this.red.visible) {
        const left = this.redAt - Date.now();
        const ring = this.red.getObjectByName('ring')!;
        const pulse = left < 5000 ? 8 : 3;
        ring.scale.setScalar(1 + Math.sin(t * pulse) * 0.03);
      }
      this.highlightRing.scale.setScalar(4 + Math.sin(t * 5) * 0.4);
    }

    // camera
    const me = [...this.squads.values()].find((o) => o.data.me);
    if (this.mode === 'follow') {
      const f = me ? me.group.position : this.focus;
      this.camTarget.lerp(new THREE.Vector3(f.x, 0, f.z - 6), k * 1.5);
      const dist = 34 * this.zoom;
      this.camPos.lerp(new THREE.Vector3(f.x, dist * 0.95, f.z + dist * 0.85), k * 1.5);
    } else if (this.mode === 'overview') {
      this.camTarget.lerp(new THREE.Vector3(0, 0, 4), k);
      this.camPos.lerp(new THREE.Vector3(0, 125 * this.zoom, 78 * this.zoom), k);
    } else {
      const a = t * 0.05;
      this.camTarget.lerp(new THREE.Vector3(0, 0, 0), k);
      this.camPos.lerp(new THREE.Vector3(Math.sin(a) * 105, 92, Math.cos(a) * 105), k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    // labels: in follow mode fade the far ones so the view stays readable
    for (const lb of this.labels) {
      const d = lb.pos.distanceTo(this.camTarget);
      const m = lb.sprite.material as THREE.SpriteMaterial;
      m.opacity = this.mode === 'follow' ? Math.max(0, Math.min(1, (60 * this.zoom - d) / 15)) : 0.85;
      lb.sprite.scale.copy(lb.sprite.userData.base).multiplyScalar(this.mode === 'follow' ? 1 : 1.7);
      lb.sprite.visible = m.opacity > 0.02;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    });
    this.renderer.dispose();
  }
}
