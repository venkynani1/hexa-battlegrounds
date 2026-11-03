// Fruit Slash mini-game (Scout's clue). Fruits are thrown up in arcs; swipe across one to slice it
// and reveal the digit hidden inside. Each fruit type always hides the same digit. It loops forever,
// so it is a game of observation and calling out, not of reflexes.
import { useEffect, useRef, useState } from 'react';
import { buzz, sfx } from '../lib/sound';

type Fruit = { f: string; d: number };
type Body = { id: number; f: string; d: number | null; x: number; y: number; vx: number; vy: number; r: number; rot: number; vr: number; cut: number; half?: number };

export default function FruitSlash({ fruits, bomb = true }: { fruits: Fruit[]; bomb?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [found, setFound] = useState<Record<string, number>>({});
  const [score, setScore] = useState(0);
  const [stunned, setStunned] = useState(false);
  const foundRef = useRef(found);
  foundRef.current = found;
  const fr = useRef(fruits);
  fr.current = fruits;
  const key = JSON.stringify(fruits);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const reduced = document.documentElement.classList.contains('reduced-motion');
    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cv);
    let bodies: Body[] = [];
    let id = 0; let raf = 0; let last = performance.now(); let spawnIn = 0.3; let stunUntil = 0;
    const trail: { x: number; y: number; t: number }[] = [];
    const pops: { x: number; y: number; text: string; t: number }[] = [];
    const g = reduced ? 380 : 520;

    function spawn() {
      const n = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const isBomb = bomb && Math.random() < 0.12;
        const pool = fr.current; const one = pool[Math.floor(Math.random() * pool.length)];
        const x = W * (0.2 + Math.random() * 0.6);
        bodies.push({
          id: id++, f: isBomb ? '💣' : one.f, d: isBomb ? null : one.d, x, y: H + 30,
          vx: (W / 2 - x) * (0.3 + Math.random() * 0.5), vy: -(Math.sqrt(2 * g * H * (0.6 + Math.random() * 0.3))),
          r: Math.max(24, Math.min(36, W / 11)), rot: 0, vr: (Math.random() - 0.5) * 4, cut: 0,
        });
      }
    }
    function segHit(ax: number, ay: number, bx: number, by: number, b: Body) {
      const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((b.x - ax) * dx + (b.y - ay) * dy) / l2));
      return Math.hypot(ax + dx * t - b.x, ay + dy * t - b.y) < b.r;
    }
    function slice(ax: number, ay: number, bx: number, by: number) {
      if (performance.now() < stunUntil) return;
      for (const b of bodies) {
        if (b.cut || b.half !== undefined || !segHit(ax, ay, bx, by, b)) continue;
        if (b.d === null) {
          b.cut = 1; stunUntil = performance.now() + 1800; setStunned(true); setTimeout(() => setStunned(false), 1800);
          sfx.damage(); buzz([60, 40, 60]);
          pops.push({ x: b.x, y: b.y, text: 'BOOM', t: performance.now() });
          continue;
        }
        b.cut = 1;
        bodies.push({ ...b, id: id++, half: -1, vx: b.vx - 80, vy: b.vy * 0.4, vr: -5 }, { ...b, id: id++, half: 1, vx: b.vx + 80, vy: b.vy * 0.4, vr: 5 });
        pops.push({ x: b.x, y: b.y, text: String(b.d), t: performance.now() });
        sfx.tap(); buzz(12);
        setScore((s) => s + 1);
        if (foundRef.current[b.f] === undefined) setFound((m) => ({ ...m, [b.f]: b.d! }));
      }
    }
    const pts = new Map<number, { x: number; y: number }>();
    const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e: PointerEvent) => { cv.setPointerCapture?.(e.pointerId); const p = pos(e); pts.set(e.pointerId, p); trail.push({ ...p, t: performance.now() }); };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId); if (!prev) return;
      const p = pos(e); slice(prev.x, prev.y, p.x, p.y); pts.set(e.pointerId, p); trail.push({ ...p, t: performance.now() });
    };
    const up = (e: PointerEvent) => pts.delete(e.pointerId);
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      spawnIn -= dt; if (spawnIn <= 0) { spawn(); spawnIn = reduced ? 1.6 : 0.9 + Math.random() * 0.6; }
      for (const b of bodies) { b.vy += g * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.vr * dt; }
      bodies = bodies.filter((b) => b.y < H + 80 && !(b.cut && b.half === undefined));
      ctx.clearRect(0, 0, W, H);
      const grd = ctx.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#2a1a10'); grd.addColorStop(1, '#120c08');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      for (let x = 0; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const b of bodies) {
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
        if (b.half !== undefined) { ctx.beginPath(); ctx.rect(b.half < 0 ? -b.r * 1.2 : 0, -b.r * 1.2, b.r * 1.2, b.r * 2.4); ctx.clip(); }
        ctx.font = `${b.r * 1.7}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.fillText(b.f, 0, 0);
        ctx.restore();
      }
      // slash trail
      const now = performance.now();
      while (trail.length && now - trail[0].t > 160) trail.shift();
      if (trail.length > 1) {
        ctx.lineCap = 'round';
        for (let i = 1; i < trail.length; i++) {
          const a = 1 - (now - trail[i].t) / 160;
          ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 5 * a + 1;
          ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
        }
      }
      for (const p of pops) {
        const a = 1 - (now - p.t) / 900; if (a <= 0) continue;
        ctx.font = '700 34px Rajdhani, system-ui, sans-serif'; ctx.fillStyle = p.text === 'BOOM' ? `rgba(255,77,94,${a})` : `rgba(255,194,61,${a})`;
        ctx.fillText(p.text, p.x, p.y - (1 - a) * 40);
      }
      if (now < stunUntil) { ctx.fillStyle = 'rgba(255,40,60,0.18)'; ctx.fillRect(0, 0, W, H); }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
  }, [key, bomb]);

  const order = fruits.map((x) => x.f);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className={`fruit-stage ${stunned ? 'shake' : ''}`}>
        <canvas ref={ref} aria-label="Fruit Slash: swipe across fruit to slice it and reveal its digit" />
        <span className="fruit-score">✂ {score}</span>
      </div>
      <div className="fruit-found" aria-live="polite">
        {order.map((f) => (
          <span key={f} className={`ff ${found[f] !== undefined ? 'on' : ''}`}>{f} <b className="mono">{found[f] ?? '?'}</b></span>
        ))}
      </div>
    </div>
  );
}
