// Bottle Shoot mini-game (Scout's clue). Glass bottles slide along three shelves of a gun range;
// tap to shoot. A shattered bottle shows its hidden digit — every bottle of one colour hides the
// same digit. 6 rounds per magazine, then a short reload. Bottles come back, so it never locks up.
import { useEffect, useRef, useState } from 'react';
import { buzz, sfx } from '../lib/sound';

type B = { c: string; d: number };
type Body = { id: number; c: string; d: number; x: number; shelf: number; speed: number; broken: number; shards: { x: number; y: number; vx: number; vy: number; r: number }[] };

const HEX: Record<string, string> = { red: '#ff4747', blue: '#3b8bff', green: '#33c46a', yellow: '#ffd23d', purple: '#a66bff', orange: '#ff8a2e' };
const NAME: Record<string, string> = { red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow', purple: 'Purple', orange: 'Orange' };

export default function BottleShoot({ bottles, ammo = 6 }: { bottles: B[]; ammo?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [found, setFound] = useState<Record<string, number>>({});
  const [mag, setMag] = useState(ammo);
  const [reloading, setReloading] = useState(false);
  const st = useRef({ mag: ammo, reloading: false });
  const shotAt = useRef<{ x: number; y: number; t: number } | null>(null);
  const bodies = useRef<Body[]>([]);
  const key = JSON.stringify(bottles);

  useEffect(() => {
    const cv = ref.current!; const ctx = cv.getContext('2d')!;
    let W = 0, H = 0, raf = 0, last = performance.now(), id = 0;
    const resize = () => { const dpr = Math.min(2, window.devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cv);
    // two of every colour, spread over the three shelves, sliding at different speeds
    const list: Body[] = [];
    bottles.forEach((b, i) => {
      for (let k = 0; k < 2; k++) list.push({ id: id++, c: b.c, d: b.d, x: ((i * 2 + k) * 0.17 + k * 0.08) % 1, shelf: (i + k * 2) % 3, speed: 0.05 + ((i * 7 + k * 3) % 5) * 0.018, broken: 0, shards: [] });
    });
    bodies.current = list;
    const shelfY = (s: number) => H * (0.3 + s * 0.27);
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      ctx.clearRect(0, 0, W, H);
      // range backdrop
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#2a2016'); g.addColorStop(1, '#14100b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; for (let x = 0; x < W; x += 28) ctx.fillRect(x, 0, 14, H);
      for (let s = 0; s < 3; s++) { ctx.fillStyle = '#6b4a2e'; ctx.fillRect(0, shelfY(s), W, 8); ctx.fillStyle = '#3f2b1a'; ctx.fillRect(0, shelfY(s) + 8, W, 6); }
      const bw = Math.max(18, Math.min(30, W / 16)); const bh = bw * 2.2;
      for (const b of bodies.current) {
        b.x = (b.x + b.speed * dt * (b.shelf % 2 ? -1 : 1) + 1.2) % 1.2;
        const x = (b.x - 0.1) * W; const y = shelfY(b.shelf);
        if (b.broken > 0) {
          b.broken += dt;
          for (const sh of b.shards) { sh.x += sh.vx * dt; sh.y += sh.vy * dt; sh.vy += 900 * dt; ctx.fillStyle = HEX[b.c]; ctx.globalAlpha = Math.max(0, 1 - b.broken); ctx.fillRect(sh.x, sh.y, sh.r, sh.r); }
          ctx.globalAlpha = Math.max(0, 1 - Math.max(0, b.broken - 1.2) / 0.6);
          ctx.fillStyle = '#fff'; ctx.font = `900 ${bh * 0.55}px Rajdhani, system-ui, sans-serif`; ctx.textAlign = 'center';
          ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.strokeText(String(b.d), x, y - bh * 0.35); ctx.fillStyle = HEX[b.c]; ctx.fillText(String(b.d), x, y - bh * 0.35);
          ctx.globalAlpha = 1;
          if (b.broken > 3) { b.broken = 0; b.shards = []; } // a new bottle is put up
          continue;
        }
        // bottle: body, shoulder, neck, highlight
        ctx.fillStyle = HEX[b.c];
        ctx.beginPath();
        ctx.moveTo(x - bw / 2, y); ctx.lineTo(x - bw / 2, y - bh * 0.55); ctx.quadraticCurveTo(x - bw / 2, y - bh * 0.72, x - bw * 0.18, y - bh * 0.78);
        ctx.lineTo(x - bw * 0.18, y - bh); ctx.lineTo(x + bw * 0.18, y - bh); ctx.lineTo(x + bw * 0.18, y - bh * 0.78);
        ctx.quadraticCurveTo(x + bw / 2, y - bh * 0.72, x + bw / 2, y - bh * 0.55); ctx.lineTo(x + bw / 2, y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x - bw * 0.32, y - bh * 0.62, bw * 0.12, bh * 0.5);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x - bw * 0.2, y - bh * 1.02, bw * 0.4, bh * 0.06);
      }
      // crosshair flash
      const sa = shotAt.current;
      if (sa && t - sa.t < 160) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sa.x, sa.y, 14, 0, Math.PI * 2); ctx.moveTo(sa.x - 22, sa.y); ctx.lineTo(sa.x + 22, sa.y); ctx.moveTo(sa.x, sa.y - 22); ctx.lineTo(sa.x, sa.y + 22); ctx.stroke();
        ctx.fillStyle = 'rgba(255,220,120,0.6)'; ctx.beginPath(); ctx.arc(sa.x, sa.y, 6, 0, Math.PI * 2); ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    const shoot = (e: PointerEvent) => {
      e.preventDefault();
      if (st.current.reloading) return;
      if (st.current.mag <= 0) { reload(); return; }
      const r = cv.getBoundingClientRect(); const px = e.clientX - r.left; const py = e.clientY - r.top;
      st.current.mag -= 1; setMag(st.current.mag);
      shotAt.current = { x: px, y: py, t: performance.now() };
      sfx.weapon(); buzz(18);
      const bw = Math.max(18, Math.min(30, W / 16)); const bh = bw * 2.2;
      const hit = bodies.current.find((b) => { if (b.broken) return false; const x = (b.x - 0.1) * W; const y = shelfY(b.shelf); return px > x - bw * 0.7 && px < x + bw * 0.7 && py < y + 6 && py > y - bh - 6; });
      if (hit) {
        hit.broken = 0.001;
        const x = (hit.x - 0.1) * W; const y = shelfY(hit.shelf);
        hit.shards = Array.from({ length: 14 }, () => ({ x, y: y - bh * 0.5, vx: (Math.random() - 0.5) * 360, vy: -Math.random() * 380, r: 2 + Math.random() * 4 }));
        sfx.tick(); buzz(30);
        setFound((f) => (f[hit.c] === undefined ? { ...f, [hit.c]: hit.d } : f));
      }
      if (st.current.mag <= 0) setTimeout(reload, 250);
    };
    const reload = () => {
      if (st.current.reloading) return;
      st.current.reloading = true; setReloading(true); sfx.tap();
      setTimeout(() => { st.current.mag = ammo; st.current.reloading = false; setMag(ammo); setReloading(false); }, 1200);
    };
    cv.addEventListener('pointerdown', shoot);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); cv.removeEventListener('pointerdown', shoot); };
  }, [key, ammo]);

  return (
    <div className="minigame bottle">
      <div className="mg-hud">
        <span>🔫 {reloading ? 'Reloading…' : `${mag}/${ammo}`}</span>
        <span className="muted">Tap a bottle to shoot</span>
      </div>
      <canvas ref={ref} className="mg-canvas" aria-label="Gun range: tap bottles to shoot them and reveal their digits" />
      <div className="mg-found">
        {Object.keys(HEX).filter((c) => bottles.some((b) => b.c === c)).map((c) => (
          <span key={c} className="mg-chip" style={{ borderColor: HEX[c] }}><i style={{ background: HEX[c] }} />{NAME[c]} {found[c] !== undefined ? <b>= {found[c]}</b> : <em>?</em>}</span>
        ))}
      </div>
    </div>
  );
}
