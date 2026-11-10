// The flight from Chennai International Airport to Hexaware Siruseri, as one cinematic driven by
// progress p (0 → 1): taxi and take-off on runway 07, climb out over the city, cruise above the
// clouds along the coast (OMR), then descend towards the campus. Primitives only, no assets.
import * as THREE from 'three';
import { animatePlane, makePlane } from './people';

const LEN = 5200;          // runway start → campus, in world units
const CRUISE = 260;

function cityTex(seed: number) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#c9cdd3'; g.fillRect(0, 0, 64, 128);
  for (let y = 6; y < 124; y += 10) for (let x = 5; x < 60; x += 9) { g.fillStyle = rnd() < 0.5 ? '#5e7da0' : '#8aa4bf'; g.fillRect(x, y, 6, 6); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** where the plane is at progress p (x along the route, y altitude) and its pitch */
export function flightPath(p: number) {
  const roll = 0.13; const climb = 0.32; const descend = 0.8;
  if (p < roll) { const k = p / roll; return { x: 120 + k * k * 520, y: 2.6, pitch: 0, phase: 'Take-off roll' }; }
  if (p < climb) { const k = (p - roll) / (climb - roll); return { x: 640 + k * 900, y: 2.6 + (CRUISE - 2.6) * (1 - Math.cos(k * Math.PI)) / 2, pitch: 0.22 * Math.sin(k * Math.PI), phase: 'Climbing out of Chennai' }; }
  if (p < descend) { const k = (p - climb) / (descend - climb); return { x: 1540 + k * 2900, y: CRUISE, pitch: 0, phase: 'Cruising along OMR' }; }
  const k = (p - descend) / (1 - descend);
  return { x: 4440 + k * 760, y: CRUISE - 110 * k, pitch: -0.08 * Math.sin(k * Math.PI), phase: 'Approaching Hexaware Siruseri' };
}

export class FlightStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 1, 9000);
  private plane = makePlane();
  private clouds: THREE.Sprite[] = [];
  private raf = 0;
  private ro: ResizeObserver;
  private camPos = new THREE.Vector3(60, 12, 40);
  progress = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
    const sc = this.scene;
    sc.background = new THREE.Color(0x9fc9ec);
    sc.fog = new THREE.Fog(0xb9d6ee, 600, 3600);
    sc.add(new THREE.HemisphereLight(0xdcefff, 0x5a6b48, 1.3));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2); sun.position.set(-400, 800, 300); sc.add(sun);

    // land, sea and the coastline running along the route
    const land = new THREE.Mesh(new THREE.PlaneGeometry(9000, 3000), new THREE.MeshLambertMaterial({ color: 0x7f9a5a }));
    land.rotation.x = -Math.PI / 2; land.position.set(2600, 0, -900); sc.add(land);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(9000, 3000), new THREE.MeshStandardMaterial({ color: 0x2f74a8, roughness: 0.25, metalness: 0.2 }));
    sea.rotation.x = -Math.PI / 2; sea.position.set(2600, -0.5, 1900); sc.add(sea);
    const beach = new THREE.Mesh(new THREE.PlaneGeometry(9000, 60), new THREE.MeshLambertMaterial({ color: 0xe9d7a8 }));
    beach.rotation.x = -Math.PI / 2; beach.position.set(2600, 0.2, 420); sc.add(beach);

    // the airport: runway with markings, taxiway, terminal and tower
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(1500, 46), new THREE.MeshLambertMaterial({ color: 0x3a3d42 }));
    rw.rotation.x = -Math.PI / 2; rw.position.set(700, 0.3, 0); sc.add(rw);
    const markM = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
    for (let x = 0; x < 1440; x += 40) { const m = new THREE.Mesh(new THREE.PlaneGeometry(22, 1.2), markM); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.35, 0); sc.add(m); }
    for (let k = -3; k <= 3; k++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(26, 2), markM); m.rotation.x = -Math.PI / 2; m.position.set(-30, 0.35, k * 5.5); sc.add(m); }
    const term = new THREE.Mesh(new THREE.BoxGeometry(360, 22, 60), new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.3, metalness: 0.4 }));
    term.position.set(380, 11, -170); sc.add(term);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 360, 20, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.4, metalness: 0.5 }));
    roof.rotation.z = Math.PI / 2; roof.scale.set(1, 1, 0.4); roof.position.set(380, 22, -170); sc.add(roof);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, 70, 10), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 })); tower.position.set(700, 35, -120); sc.add(tower);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(11, 9, 9, 10), new THREE.MeshStandardMaterial({ color: 0x2a4a66, metalness: 0.5, roughness: 0.2 })); cab.position.set(700, 74, -120); sc.add(cab);
    const sign = labelSprite('CHENNAI · MAA', '#0b2a4a', '#ffffff'); sign.position.set(380, 48, -140); sign.scale.set(120, 22, 1); sc.add(sign);

    // the city under the climb-out and cruise
    const texes = [cityTex(11), cityTex(57), cityTex(91)];
    const mats = texes.map((t) => new THREE.MeshLambertMaterial({ map: t }));
    const box = new THREE.BoxGeometry(1, 1, 1);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const m of mats) {
      const inst = new THREE.InstancedMesh(box, m, 380);
      const d = new THREE.Object3D();
      for (let i = 0; i < 380; i++) {
        const x = 1100 + rnd() * 3500; const z = -1100 + rnd() * 1450;
        const h = 10 + Math.pow(rnd(), 2.2) * (x < 2600 ? 110 : 55);
        d.position.set(x, h / 2, z + (Math.abs(z) < 90 ? 200 : 0)); d.scale.set(14 + rnd() * 24, h, 14 + rnd() * 24); d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
      }
      sc.add(inst);
    }
    // OMR: the road to Siruseri
    const road = new THREE.Mesh(new THREE.PlaneGeometry(5000, 16), new THREE.MeshLambertMaterial({ color: 0x55585e }));
    road.rotation.x = -Math.PI / 2; road.position.set(2900, 0.4, 140); sc.add(road);

    // the campus at the end of the route
    const camp = new THREE.Group(); camp.position.set(5150, 0, 0);
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(560, 560), new THREE.MeshLambertMaterial({ color: 0x5f9a46 })); lawn.rotation.x = -Math.PI / 2; lawn.position.y = 0.3; camp.add(lawn);
    const bm = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5 }); const gm = new THREE.MeshStandardMaterial({ color: 0x2f6f9a, roughness: 0.15, metalness: 0.5 });
    for (const [x, z, w, h, d] of [[-130, -120, 120, 34, 70], [90, -150, 140, 40, 80], [140, 90, 120, 30, 90], [-120, 120, 90, 26, 70], [0, 10, 70, 20, 60]] as number[][]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [bm, bm, bm, bm, gm, gm]); b.position.set(x, h / 2, z); camp.add(b);
    }
    const hx = labelSprite('HEXAWARE', '#ffffff', '#1e8fd6'); hx.position.set(0, 70, 0); hx.scale.set(150, 30, 1); camp.add(hx);
    sc.add(camp);

    // clouds
    const cloudTex = (() => {
      const c = document.createElement('canvas'); c.width = 128; c.height = 128; const g = c.getContext('2d')!;
      for (let i = 0; i < 9; i++) { const gr = g.createRadialGradient(30 + Math.random() * 68, 40 + Math.random() * 48, 2, 64, 64, 50); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    for (let i = 0; i < 70; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.6, depthWrite: false }));
      sp.position.set(1200 + Math.random() * 3600, 120 + Math.random() * 60, (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 600)); sp.scale.setScalar(120 + Math.random() * 140);
      sc.add(sp); this.clouds.push(sp);
    }
    this.plane.scale.setScalar(1.3);
    sc.add(this.plane);

    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize() {
    const w = this.canvas.clientWidth || 1; const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
    this.camera.fov = h > w ? 62 : 46; this.camera.updateProjectionMatrix();
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const p = Math.max(0, Math.min(1, this.progress));
    const f = flightPath(p);
    this.plane.position.set(f.x, f.y + 3.4, 0);
    this.plane.rotation.set(0, -Math.PI / 2, 0);
    this.plane.rotateX(f.pitch);
    animatePlane(this.plane, now / 1000);
    // chase camera: low beside the runway, then behind and above in the air
    const air = Math.min(1, Math.max(0, (p - 0.08) / 0.2));
    const want = new THREE.Vector3(f.x - 70 - air * 60, f.y + 10 + air * 34, 46 + air * 20);
    this.camPos.lerp(want, 0.08);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(f.x + 40 + air * 80, f.y - air * 28, 0);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.raf); this.ro.disconnect();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry?.dispose?.(); });
    this.renderer.dispose();
  }
}

function labelSprite(text: string, color: string, bg: string) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, 512, 96);
  g.fillStyle = color; g.font = '800 58px Rajdhani, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t }));
}
