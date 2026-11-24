// Winner reveal: light rays behind the trophy and a burst of confetti in the winning squad's colour.
// 2D canvas, ~250 particles for 6 seconds, then it stops. Nothing moves with reduced motion.
import { useEffect, useRef } from 'react';

export function Celebrate({ color = '#ffc23d', big = false }: { color?: string; big?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (document.documentElement.classList.contains('reduced-motion')) return;
    const c = ref.current; if (!c) return;
    const g = c.getContext('2d'); if (!g) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const fit = () => { c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; };
    fit();
    const cols = [color, '#ffc23d', '#ffffff', '#2ee6ff', color];
    const N = big ? 320 : 200;
    const P = Array.from({ length: N }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      return { x: c.width * (0.5 + side * 0.08), y: c.height * 0.62, vx: side * (2 + Math.random() * 7) * dpr, vy: -(8 + Math.random() * 10) * dpr,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, w: (5 + Math.random() * 6) * dpr, h: (8 + Math.random() * 8) * dpr, c: cols[i % cols.length], d: Math.random() * 400 };
    });
    const t0 = performance.now(); let raf = 0;
    const tick = (t: number) => {
      const age = t - t0;
      g.clearRect(0, 0, c.width, c.height);
      for (const p of P) {
        if (age < p.d) continue;
        p.vy += 0.32 * dpr; p.vx *= 0.99; p.vy *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.scale(1, Math.cos(p.r * 2));
        g.globalAlpha = Math.max(0, 1 - age / 6500); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
      }
      if (age < 6500) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', fit);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', fit); };
  }, [color, big]);
  return (
    <div className="celebrate" aria-hidden>
      <div className="celebrate-rays" style={{ ['--ray' as any]: color }} />
      <canvas ref={ref} />
    </div>
  );
}
