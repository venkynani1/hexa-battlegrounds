// 3D shuttle bus with the squad seated inside (cutaway roof), parked at SIPCOT or driving to Gate 1.
import * as THREE from 'three';

export type Seat = { name: string; role?: string | null; me?: boolean; online?: boolean } | null;
const ROLE_HEX: Record<string, number> = { captain: 0xffc23d, scout: 0x3ef0ff, decoder: 0xb07cff, intel: 0x5dff9e };
const SHIRTS = [0x3ea5ff, 0xff8a3d, 0xe85d9a, 0x7bd389];

function label(text: string, color: string, bg = 'rgba(6,10,18,0.8)') {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '700 40px Rajdhani, "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 30;
  c.width = w; c.height = 58;
  ctx.font = font; ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect?.(0, 0, w, 58, 12); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, w / 2, 31);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sp.scale.set((w / 58) * 0.9, 0.9, 1);
  sp.renderOrder = 20;
  return sp;
}

function person(shirt: number, opts: { hood?: boolean } = {}) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.6 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 4, 10), mat);
  torso.position.y = 0.95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), new THREE.MeshStandardMaterial({ color: opts.hood ? 0x111111 : 0xe2b48c, roughness: 0.7 }));
  head.position.y = 1.62;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: opts.hood ? 0x0a0a0a : 0x2a1a10 }));
  hair.position.y = 1.66;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.7), new THREE.MeshStandardMaterial({ color: 0x23324a }));
  legs.position.set(0, 0.62, -0.3);
  const shins = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.55, 0.2), new THREE.MeshStandardMaterial({ color: 0x23324a }));
  shins.position.set(0, 0.32, -0.62);
  g.add(torso, head, hair, legs, shins);
  if (opts.hood) {
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: 0xff2238 }));
    visor.position.set(0, 1.64, -0.25);
    g.add(visor);
  }
  g.userData.head = head;
  return g;
}

export class BusScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  private raf = 0;
  private clock = new THREE.Clock();
  private ro: ResizeObserver;
  private seatSlots: THREE.Group[] = [];
  private seatKey = '';
  private bus = new THREE.Group();
  private scenery = new THREE.Group();
  private dashes: THREE.Mesh[] = [];
  private trees: THREE.Group[] = [];
  private gate: THREE.Group;
  private driving = false;
  private progress = 0;
  private speed = 0;
  private reduced: boolean;
  private people: THREE.Group[] = [];
  disposed = false;

  constructor(private canvas: HTMLCanvasElement, busCode: string) {
    this.reduced = document.documentElement.classList.contains('reduced-motion');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(0x0b1424);
    this.scene.fog = new THREE.Fog(0x0b1424, 30, 90);
    this.scene.add(new THREE.HemisphereLight(0xa8ccff, 0x1a1410, 1.25));
    const sun = new THREE.DirectionalLight(0xffe0b0, 1.5); sun.position.set(-10, 20, 12); this.scene.add(sun);

    // road + verge
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 200), new THREE.MeshLambertMaterial({ color: 0x1c3324 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(400, 9), new THREE.MeshLambertMaterial({ color: 0x2a313d }));
    road.rotation.x = -Math.PI / 2; road.position.y = 0;
    this.scene.add(ground, road);
    for (let i = 0; i < 26; i++) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.22), new THREE.MeshBasicMaterial({ color: 0xe8e2c8 }));
      d.rotation.x = -Math.PI / 2; d.position.set(-60 + i * 5, 0.01, 2.6);
      this.dashes.push(d); this.scenery.add(d);
    }
    for (let i = 0; i < 18; i++) {
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.2, 6), new THREE.MeshLambertMaterial({ color: 0x5a3d26 }));
      trunk.position.y = 0.6;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.8, 7), new THREE.MeshLambertMaterial({ color: i % 3 ? 0x2e8a4a : 0x3d9a55 }));
      crown.position.y = 2.4;
      t.add(trunk, crown);
      t.position.set(-60 + i * 7 + (i % 2) * 2, 0, i % 2 ? -7.5 : 8 + (i % 3));
      this.trees.push(t); this.scenery.add(t);
    }
    // SIPCOT stop sign / Gate 1 arch
    const stop = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 8), new THREE.MeshStandardMaterial({ color: 0x9aa7b8 }));
    pole.position.y = 1.5;
    const sign = label('SIPCOT STOP', '#ffc23d');
    sign.position.y = 3.3; sign.scale.multiplyScalar(0.9);
    stop.add(pole, sign); stop.position.set(2, 0, -6.5);
    this.scene.add(stop);
    stop.userData.isStop = true;
    this.gate = new THREE.Group();
    for (const z of [-5.5, 5.5]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 1), new THREE.MeshStandardMaterial({ color: 0x3a4658 }));
      p.position.set(0, 3.5, z); this.gate.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 12), new THREE.MeshStandardMaterial({ color: 0xff8a3d, emissive: 0xff8a3d, emissiveIntensity: 0.8 }));
    beam.position.y = 7.2; this.gate.add(beam);
    const gl = label('GATE 1 · HEXAWARE SIRUSERI', '#ff8a3d'); gl.position.set(0, 8.6, 0); gl.scale.multiplyScalar(1.4); this.gate.add(gl);
    this.gate.position.x = -80; this.gate.visible = false;
    this.scene.add(this.scenery, this.gate);
    this.scenery.userData.stop = stop;

    this.buildBus(busCode);
    this.scene.add(this.bus);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
    this.loop();
  }

  private buildBus(code: string) {
    const L = 11; const Wd = 3.4; const H = 2.9;
    const paint = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.45, metalness: 0.2 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x3ea5ff, emissive: 0x0d3a66, roughness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.6, depthWrite: false });
    // floor
    const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.3, Wd), new THREE.MeshStandardMaterial({ color: 0x2b3442 }));
    floor.position.y = 0.75;
    this.bus.add(floor);
    const aisle = new THREE.Mesh(new THREE.BoxGeometry(L - 1.2, 0.02, 0.7), new THREE.MeshStandardMaterial({ color: 0xc23a3a }));
    aisle.position.set(0.2, 0.92, 0);
    this.bus.add(aisle);
    // lower walls (solid) with stripe, upper walls glass; roof removed (cutaway)
    for (const z of [-Wd / 2, Wd / 2]) {
      const low = new THREE.Mesh(new THREE.BoxGeometry(L, 1.3, 0.12), paint); low.position.set(0, 1.5, z); this.bus.add(low);
      const st = new THREE.Mesh(new THREE.BoxGeometry(L, 0.28, 0.14), stripe); st.position.set(0, 1.55, z); this.bus.add(st);
      const up = new THREE.Mesh(new THREE.BoxGeometry(L, 1.1, 0.06), glass); up.position.set(0, 2.7, z); up.renderOrder = 3; this.bus.add(up);
      for (let i = -2; i <= 2; i++) { const pil = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), paint); pil.position.set(i * 2.2, 2.7, z); this.bus.add(pil); }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(L, 0.14, 0.16), paint); rail.position.set(0, H + 0.35, z); this.bus.add(rail);
    }
    for (const x of [-L / 2, L / 2]) {
      const end = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, Wd), paint); end.position.set(x, 1.5, 0); this.bus.add(end);
      const ws = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, Wd), glass); ws.position.set(x, 2.7, 0); this.bus.add(ws);
    }
    // headlights (front = -x, the direction of travel)
    for (const z of [-1.1, 1.1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.5), new THREE.MeshBasicMaterial({ color: 0xfff3c4 }));
      hl.position.set(-L / 2 - 0.05, 1.2, z); this.bus.add(hl);
    }
    // wheels
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.9 });
    for (const x of [-3.4, 3.4]) for (const z of [-Wd / 2, Wd / 2]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 18), wheelMat);
      w.rotation.x = Math.PI / 2; w.position.set(x, 0.55, z); w.userData.wheel = true; this.bus.add(w);
    }
    // destination board on the front (a lit panel, not a floating label)
    const boardTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 48;
      const g = c.getContext('2d')!; g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, 256, 48);
      g.fillStyle = '#ffc23d'; g.font = '700 30px Rajdhani, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(code, 128, 26);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.42), new THREE.MeshBasicMaterial({ map: boardTex }));
    board.position.set(-L / 2 - 0.09, 2.15, 0); board.rotation.y = -Math.PI / 2;
    this.bus.add(board);
    // driver (Squad 00?)
    const drv = person(0x111111, { hood: true });
    drv.position.set(-4.4, 0.9, -0.9); drv.rotation.y = Math.PI / 2;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.05, 8, 20), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    wheel.position.set(-4.95, 1.75, -0.9); wheel.rotation.y = Math.PI / 2; wheel.rotation.x = 0.4;
    this.bus.add(drv, wheel);
    this.people.push(drv);
    // seats: rows of 2+2; the squad sits in the first two rows, the rest are empty
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a6bff, roughness: 0.7 });
    const seatPos: [number, number][] = [];
    for (let row = 0; row < 4; row++) for (const z of [-1.15, -0.45, 0.45, 1.15]) seatPos.push([-2.6 + row * 1.9, z]);
    seatPos.forEach(([x, z]) => {
      const s = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.6), seatMat); base.position.y = 0.55;
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.6), seatMat); back.position.set(0.32, 1.0, 0);
      s.add(base, back);
      s.position.set(x, 0.9, z);
      this.bus.add(s);
    });
    // squad slots: front two rows, aisle-side pairs
    const order: [number, number][] = [[-2.6, -1.15], [-2.6, 1.15], [-0.7, -1.15], [-0.7, 1.15]];
    for (const [x, z] of order) { const g = new THREE.Group(); g.position.set(x, 0.9, z); this.bus.add(g); this.seatSlots.push(g); }
  }

  setSeats(seats: Seat[]) {
    const key = JSON.stringify(seats);
    if (key === this.seatKey) return;
    this.seatKey = key;
    this.seatSlots.forEach((slot, i) => {
      slot.clear();
      const p = seats[i];
      if (!p) {
        const empty = label('EMPTY', '#5b6f8a', 'rgba(6,10,18,0.55)');
        empty.position.set(0, 1.6, 0); empty.scale.multiplyScalar(0.6);
        slot.add(empty);
        return;
      }
      const fig = person(p.role ? ROLE_HEX[p.role] ?? SHIRTS[i] : SHIRTS[i]);
      fig.rotation.y = -Math.PI / 2; // facing forward (−x)
      fig.position.y = 0.05;
      if (p.online === false) fig.traverse((o: any) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; } });
      slot.add(fig);
      this.people.push(fig);
      const nm = label(p.me ? `${p.name} (YOU)` : p.name, p.me ? '#3ef0ff' : '#e6f0ff');
      nm.position.set(0, 2.45 + Math.floor(i / 2) * 0.05, i % 2 ? 0.45 : -0.45);
      nm.scale.multiplyScalar(0.62);
      slot.add(nm);
      if (p.me) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0x3ef0ff, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08;
        slot.add(ring);
      }
    });
  }

  setDriving(driving: boolean, progress = 0) {
    this.driving = driving;
    this.progress = progress;
  }

  private resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || 360; const h = el.clientHeight || 260;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const target = this.driving ? 14 : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 1.2);
    const move = this.reduced ? 0 : this.speed * dt;
    // scenery streams past (+x) while the bus "drives" toward −x
    for (const d of this.dashes) { d.position.x += move; if (d.position.x > 70) d.position.x -= 130; }
    for (const tr of this.trees) { tr.position.x += move; if (tr.position.x > 70) tr.position.x -= 126; }
    const stop = this.scenery.userData.stop as THREE.Group;
    stop.position.x += move;
    // Gate 1 arrives at the end of the journey
    this.gate.visible = this.driving && this.progress > 0.7;
    if (this.gate.visible) this.gate.position.x = -6 - (1 - Math.min(1, (this.progress - 0.7) / 0.3)) * 60;
    // bus bounce + wheel spin + passengers sway
    const bounce = this.speed > 0.5 && !this.reduced ? Math.sin(t * 14) * 0.03 : 0;
    this.bus.position.y = bounce;
    this.bus.children.forEach((c) => { if (c.userData.wheel) c.rotation.y -= move * 1.8; });
    for (const p of this.people) {
      const h = p.userData.head as THREE.Mesh | undefined;
      if (h && !this.reduced) h.rotation.y = Math.sin(t * 0.7 + p.id) * 0.5;
      if (!this.reduced) p.rotation.z = this.speed > 0.5 ? Math.sin(t * 2 + p.id) * 0.04 : 0;
    }
    // camera: three-quarter view from above the cutaway roof, slow drift
    const a = this.reduced ? 0.5 : 0.5 + Math.sin(t * 0.15) * 0.18;
    const far = this.camera.aspect < 1.1 ? 1.35 : 1;
    this.camera.position.set(Math.sin(a) * 9 * far + 1, 11.5 * far, Math.cos(a) * 12 * far);
    this.camera.lookAt(-1.4, 0.6, 0);
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
