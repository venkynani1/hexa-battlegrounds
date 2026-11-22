// Dev-only visual lab (/lab, not in production builds): every character motion and VFX side by side,
// for screenshots and visual regression. Uses the same rig, materials and quality presets as the game.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { animateAvatar, makeAvatar, makeChute, Avatar } from '../three/people';
import { squadHex } from '../lib/game';
import { VFX } from '../three/vfx';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const MOTIONS: { label: string; s: Parameters<typeof animateAvatar>[2]; tilt?: number; chute?: boolean }[] = [
  { label: 'idle', s: { speed: 0 } }, { label: 'walk', s: { speed: 3.6 } }, { label: 'run', s: { speed: 6.4 } },
  { label: 'aim / fire', s: { speed: 0, aiming: true } }, { label: 'run + aim', s: { speed: 6.4, aiming: true } },
  { label: 'free fall', s: { speed: 0, fall: true }, tilt: -Math.PI / 2 * 0.85 }, { label: 'parachute', s: { speed: 0, chute: true }, chute: true },
  { label: 'knocked', s: { speed: 0, down: true } },
];

export default function Lab() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio)); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xcfe3f2);
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5d7a3f, 1.1));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.5); sun.position.set(-6, 10, 6); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 8, bottom: -8 }); scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshStandardMaterial({ color: 0x8a9a7a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const hp = new URLSearchParams(location.hash.slice(1));
    const cx = Number(hp.get('x') || 0), cz = Number(hp.get('z') || 17), cy = Number(hp.get('y') || 3.2);
    const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 200); cam.position.set(cx, cy, cz); cam.lookAt(cx, 1.2, 0);
    const avatars: { a: Avatar; m: typeof MOTIONS[number] }[] = [];
    MOTIONS.forEach((m, i) => {
      const a = makeAvatar({ color: squadHex(i + 1), number: i + 1 });
      const holder = new THREE.Group(); holder.add(a);
      holder.position.set((i - (MOTIONS.length - 1) / 2) * 2.6, m.tilt ? 1.2 : 0, 0);
      a.rotation.y = Math.PI * 0.82; if (m.tilt) a.rotation.x = m.tilt;
      if (m.chute) { const c = makeChute(squadHex(i + 1)); c.scale.setScalar(0.42); c.position.y = 0.5; holder.add(c); holder.position.y = 0.4; }
      scene.add(holder);
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const g = cv.getContext('2d')!;
      g.fillStyle = 'rgba(10,16,28,.8)'; g.fillRect(0, 0, 256, 64); g.fillStyle = '#fff'; g.font = '700 30px system-ui'; g.textAlign = 'center'; g.fillText(m.label, 128, 42);
      const lab = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) })); lab.scale.set(2, 0.5, 1); lab.position.set(holder.position.x, 2.9, 0); scene.add(lab);
      avatars.push({ a, m });
    });
    const vfx = new VFX(scene);
    const comp = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    comp.addPass(new RenderPass(scene, cam)); comp.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.35, 1.15)); comp.addPass(new OutputPass());
    const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; r.setSize(w, h, false); comp.setSize(w, h); comp.setPixelRatio(r.getPixelRatio()); cam.aspect = w / h; cam.updateProjectionMatrix(); vfx.setViewport(h * r.getPixelRatio(), cam.fov); };
    const fx = hp.get('fx');
    if (fx) vfx.setEmitter('smoke', new THREE.Vector3(9, 0.5, -3), 'smoke');
    resize(); window.addEventListener('resize', resize);
    const clock = new THREE.Clock(); let raf = 0; let fireT = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop); const dt = Math.min(0.05, clock.getDelta());
      fireT += dt;
      for (const { a, m } of avatars) { if (m.s.aiming && fireT > 0.35) a.userData.firedAt = performance.now(); animateAvatar(a, dt, m.s); }
      if (fx && fireT > 0.35) {
        vfx.shot(new THREE.Vector3(-3.4, 1.5, 0.5), new THREE.Vector3(3.6, 1.2, -1), Math.random() > 0.3);
        if (Math.random() > 0.6) vfx.landing(new THREE.Vector3(-8 + Math.random() * 4, 0.05, 2));
        if (Math.random() > 0.7) vfx.loot(new THREE.Vector3(6.5, 0.8, 2));
      }
      if (fireT > 0.35) fireT = 0;
      vfx.update(dt);
      comp.render(dt);
    };
    loop();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); r.dispose(); };
  }, []);
  return <canvas ref={ref} style={{ width: '100vw', height: '100vh', display: 'block' }} />;
}
