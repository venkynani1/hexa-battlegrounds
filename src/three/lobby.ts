// Lobby stage for the landing page: the squad buggy on a lit turntable in front of the campus
// skyline at dusk. Drag to spin the buggy. Small scene, built from primitives, no assets to load.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { animateVehicle, makeVehicle, Vehicle } from './vehicle';

function windowTex(seed: number) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16202e'; g.fillRect(0, 0, 64, 128);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let y = 4; y < 124; y += 10) for (let x = 4; x < 60; x += 8) {
    const r = rnd();
    g.fillStyle = r < 0.34 ? 'rgba(255,214,140,0.95)' : r < 0.46 ? 'rgba(140,220,255,0.8)' : 'rgba(40,58,82,0.9)';
    g.fillRect(x, y, 5, 6);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
  return t;
}

export class LobbyStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.5, 600);
  private hero: Vehicle;
  private turn = new THREE.Group();
  private escorts: Vehicle[] = [];
  private beams: THREE.Mesh[] = [];
  private plane = new THREE.Group();
  private raf = 0; private last = 0; private t = 0;
  private spin = 0.35; private vel = 0; private dragging = false; private lastX = 0;
  private still: boolean;
  private ro: ResizeObserver;
  private portrait = false;

  constructor(private canvas: HTMLCanvasElement, heroColor = '#ffc23d') {
    this.still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
    r.outputColorSpace = THREE.SRGBColorSpace;

    const sc = this.scene;
    sc.fog = new THREE.Fog(0x4a3a5e, 70, 420);
    // dusk sky: one big back-facing sphere with a vertical gradient and a low sun glow
    const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP;
        void main(){ float h = clamp(vP.y, -0.1, 1.0);
          vec3 top = vec3(0.05,0.09,0.22); vec3 mid = vec3(0.30,0.24,0.46); vec3 low = vec3(0.98,0.56,0.26);
          vec3 c = h > 0.22 ? mix(mid, top, smoothstep(0.22, 0.8, h)) : mix(low, mid, smoothstep(-0.02, 0.22, h));
          float s = max(dot(vP, normalize(vec3(-0.55, 0.07, -0.83))), 0.0);
          c += vec3(1.0,0.72,0.4) * (pow(s, 40.0) * 0.55 + pow(s, 900.0) * 3.0);
          gl_FragColor = vec4(c, 1.0); }`,
    }));
    sc.add(sky);

    // soft studio reflections so paint and metal look like paint and metal
    const pm = new THREE.PMREMGenerator(r); sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; sc.environmentIntensity = 0.45; pm.dispose();
    sc.add(new THREE.HemisphereLight(0x8fa8ff, 0x3a2a22, 0.6));
    const sun = new THREE.DirectionalLight(0xffb070, 2.6);
    sun.position.set(-26, 18, -30); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sh = sun.shadow.camera; sh.left = -14; sh.right = 14; sh.top = 14; sh.bottom = -14; sh.near = 5; sh.far = 90;
    sun.shadow.bias = -0.0015;
    sc.add(sun);
    const key = new THREE.SpotLight(0xdff3ff, 900, 60, 0.5, 0.6, 2);
    key.position.set(7, 15, 12); key.target.position.set(0, 1, 0);
    sc.add(key, key.target);
    const rim = new THREE.PointLight(0x3ef0ff, 60, 30, 2); rim.position.set(-7, 3, 6); sc.add(rim);

    // plaza floor + turntable
    const floor = new THREE.Mesh(new THREE.CircleGeometry(260, 48), new THREE.MeshStandardMaterial({ color: 0x2c3342, roughness: 0.55, metalness: 0.35 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; sc.add(floor);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.6, 0.5, 48), new THREE.MeshStandardMaterial({ color: 0x39435a, roughness: 0.32, metalness: 0.85 }));
    deck.position.y = 0.25; deck.receiveShadow = true; deck.castShadow = true; sc.add(deck);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.25, 0.07, 8, 96), new THREE.MeshBasicMaterial({ color: 0x3ef0ff }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.52; sc.add(ring);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(6.4, 6.55, 96), new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    ring2.rotation.x = -Math.PI / 2; ring2.position.y = 0.03; sc.add(ring2);
    // hex markings radiating on the plaza
    const hexM = new THREE.MeshBasicMaterial({ color: 0x5f7fb0, transparent: true, opacity: 0.16, side: THREE.DoubleSide });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + (i % 2) * 0.12; const d = 10 + (i % 5) * 4.2;
      const h = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.62, 6), hexM);
      h.rotation.x = -Math.PI / 2; h.position.set(Math.cos(a) * d, 0.02, Math.sin(a) * d); sc.add(h);
    }

    this.hero = makeVehicle({ color: heroColor, number: 1 });
    this.hero.scale.setScalar(1.45);
    this.turn.position.y = 0.5; this.turn.add(this.hero); sc.add(this.turn);
    // three more squads waiting behind, like a lobby filling up
    const others: [string, number, number, number, number][] = [['#33a8ff', 2, -10.5, -6, 0.5], ['#ff4d4d', 3, 10.5, -7, -0.55], ['#2fd67b', 4, -3.5, -13, 0.15]];
    for (const [c, n, x, z, a] of others) {
      const v = makeVehicle({ color: c, number: n });
      v.position.set(x, 0, z); v.rotation.y = a; sc.add(v); this.escorts.push(v);
    }

    // campus skyline: office blocks with lit windows, a water tower, a comms mast
    const texes = [windowTex(7), windowTex(31), windowTex(93)];
    const blocks: [number, number, number, number, number][] = [
      [-92, -170, 54, 26, 30], [-24, -185, 70, 18, 34], [52, -172, 46, 32, 28], [118, -190, 58, 20, 30], [-160, -195, 50, 16, 30],
      [-60, -250, 40, 40, 30], [16, -262, 48, 28, 30], [176, -240, 44, 24, 30], [-210, -255, 56, 22, 30], [96, -280, 36, 46, 30],
    ];
    blocks.forEach(([x, z, w, h, d], i) => {
      const tx = texes[i % 3].clone(); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(Math.max(1, Math.round(w / 14)), Math.max(1, Math.round(h / 22))); tx.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ map: tx, emissiveMap: tx, emissive: 0xffffff, emissiveIntensity: 0.38, roughness: 0.6, metalness: 0.3 });
      const roofM = new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.8 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [m, m, roofM, roofM, m, m]);
      b.position.set(x, h / 2, z); sc.add(b);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 3, d * 0.4), roofM); cap.position.set(x + w * 0.15, h + 1.5, z); sc.add(cap);
    });
    const steel = new THREE.MeshStandardMaterial({ color: 0x55606f, roughness: 0.5, metalness: 0.7 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.8, 70, 6), steel); mast.position.set(-128, 35, -200); sc.add(mast);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3045 })); beacon.position.set(-128, 71, -200); sc.add(beacon);
    // palms flanking the plaza
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }); const leafM = new THREE.MeshStandardMaterial({ color: 0x1f5a3a, roughness: 0.9, side: THREE.DoubleSide });
    for (const [x, z] of [[-17, -4], [17, -3], [-24, -20], [25, -22], [-34, -40], [36, -44]]) {
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 9, 6), trunkM); tr.position.set(x, 4.5, z); tr.castShadow = true; sc.add(tr);
      for (let k = 0; k < 7; k++) {
        const lf = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 4.6), leafM);
        lf.position.set(x, 9, z); lf.rotation.set(0.95, (k / 7) * Math.PI * 2, 0, 'YXZ'); lf.translateY(2); sc.add(lf);
      }
    }
    // searchlights sweeping the sky behind the stage
    const beamM = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (const x of [-46, 52]) {
      const g = new THREE.ConeGeometry(9, 150, 20, 1, true); g.translate(0, -75, 0); g.rotateX(Math.PI);
      const b = new THREE.Mesh(g, beamM); b.position.set(x, 0, -95); sc.add(b); this.beams.push(b);
    }
    // the drop plane crossing the sky
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 12, 4, 10), steel); hull.rotation.z = Math.PI / 2;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.3, 20), steel);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.4, 0.3), steel); tail.position.set(-7, 1.8, 0);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4444 })); lamp.position.set(0, -1.6, 0);
    this.plane.add(hull, wing, tail, lamp); sc.add(this.plane);

    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    document.addEventListener('visibilitychange', this.vis);
    this.raf = requestAnimationFrame(this.frame);
  }

  private down = (e: PointerEvent) => { this.dragging = true; this.lastX = e.clientX; this.vel = 0; };
  private move = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX; this.lastX = e.clientX;
    this.spin += dx * 0.01; this.vel = dx * 0.6;
  };
  private up = () => { this.dragging = false; };
  private vis = () => { if (document.visibilityState === 'visible') { this.last = 0; cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.frame); } };

  private resize() {
    const w = this.canvas.clientWidth || 1; const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.portrait = h > w * 1.05;
    // tall phones: pull back and widen so the whole buggy and the skyline stay in frame
    this.camera.fov = this.portrait ? 50 : 34;
    this.camera.updateProjectionMatrix();
  }

  private frame = (now: number) => {
    if (document.visibilityState !== 'visible') return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016; this.last = now;
    this.t += dt;
    if (!this.dragging) {
      this.vel *= Math.pow(0.04, dt);
      this.spin += (this.vel + (this.still ? 0 : 0.22)) * dt;
    }
    this.turn.rotation.y = this.spin;
    animateVehicle(this.hero, this.t, dt, 0, 0, false);
    const sway = this.still ? 0 : Math.sin(this.t * 0.25) * 0.9;
    if (this.portrait) { this.camera.position.set(sway * 0.6, 4.2, 23); this.camera.lookAt(0, 0.4, 0); }
    else { this.camera.position.set(-3 + sway, 4.2, 20); this.camera.lookAt(-1.2, 2.2, 0); }
    if (!this.still) {
      this.beams[0].rotation.set(Math.sin(this.t * 0.35) * 0.35 - 0.1, 0, Math.cos(this.t * 0.28) * 0.4);
      this.beams[1].rotation.set(Math.cos(this.t * 0.3) * 0.3 - 0.1, 0, Math.sin(this.t * 0.33 + 1) * 0.4);
      const p = ((this.t * 0.035) % 1);
      this.plane.position.set(-260 + p * 520, 78 + Math.sin(p * 6) * 3, -210);
    } else this.plane.position.set(60, 78, -210);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.down);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    document.removeEventListener('visibilitychange', this.vis);
    this.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry?.dispose?.(); });
    this.renderer.dispose();
  }
}
