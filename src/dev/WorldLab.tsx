// Dev-only (/lab/world, not in production builds): the real 3D campus with a staged state, for screenshots of
// specific moments — street level, interiors, lifts, free fall, canopy, the on-board flyover, an airdrop.
// #shot=street|interior|lift|freefall|chute|board|drop|cars&q=low|balanced|high
import { useEffect, useRef } from 'react';
import { rpc } from '../lib/api';
import type { MapData } from '../lib/game';
import { WorldScene, WorldState, WorldSquad } from '../three/world';

export default function WorldLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const hp = new URLSearchParams(location.hash.slice(1));
    if (hp.get('q')) localStorage.setItem('hb_quality', hp.get('q')!);
    const shot = hp.get('shot') || 'street';
    let sc: WorldScene | null = null; let alive = true;
    rpc<MapData>('map_data').then((map) => {
      if (!alive || !ref.current) return;
      const now = Date.now();
      const others: WorldSquad[] = [[0.47, 0.6], [0.3, 0.62], [0.62, 0.56], [0.25, 0.56], [0.55, 0.8]].map(([x, y], i) => ({ key: `r${i}`, number: i + 2, x, y, at: now, vx: i % 2 ? 0.004 : -0.003, vy: 0.002 }));
      const me = (o: Partial<WorldSquad>): WorldSquad => ({ key: 'me', number: 1, me: true, x: 0.194, y: 0.79, at: now, ...o });
      const st: Record<string, { s: WorldState; mode?: 'follow' | 'orbit'; yaw?: number; zoom?: number }> = {
        street: { s: { squads: [me({ foot: true, buggy: [0.21, 0.8] }), ...others] }, yaw: 0.35 },
        interior: { s: { squads: [me({ foot: true, level: 1, bldg: 'eb2', x: 0.175, y: 0.69 })] }, yaw: -0.6, zoom: 1.2 },
        lift: { s: { squads: [me({ foot: true, level: 0, bldg: 'eb2', x: 0.205, y: 0.695 })] }, yaw: 0.9 },
        freefall: { s: { squads: [me({ chute: true, x: 0.47, y: 0.5, jumpAt: now - 600, landAt: now + 26000 }), ...others], plane: { a: [0.05, 0.5], b: [0.95, 0.5], t0: new Date(now - 30000).toISOString(), t1: new Date(now + 20000).toISOString() } } },
        chute: { s: { squads: [me({ chute: true, x: 0.47, y: 0.5, jumpAt: now - 14000, landAt: now + 9000 }), ...others] } },
        board: { s: { squads: [me({ hidden: true }), ...others], plane: { a: [0.02, 0.3], b: [0.98, 0.7], t0: new Date(now - 4000).toISOString(), t1: new Date(now + 60000).toISOString() } } },
        drop: { s: { squads: others, airdrops: [{ key: 'd1', location: 'central_steps', tier: 'legendary' }] }, mode: 'orbit' },
        buggy: { s: { squads: [me({ x: 0.31, y: 0.585 }), { key: 'r9', number: 7, x: 0.325, y: 0.578, at: Date.now() }] }, yaw: 2.2, zoom: 0.55 },
        cars: { s: { squads: [me({ x: 0.3, y: 0.86 }), ...others] }, zoom: 2.2, yaw: 2.6 },
      };
      const cfg = st[shot] || st.street;
      sc = new WorldScene(ref.current, map, { mode: cfg.mode || 'follow' });
      if (cfg.yaw !== undefined) sc.yaw = cfg.yaw;
      if (cfg.zoom) sc.setZoom(cfg.zoom);
      // the drop arrives a moment after the scene starts, so the big-screen cut plays from the top
      if (shot === 'drop') { sc.setState({ squads: others }); setTimeout(() => sc?.setState(cfg.s), 800); } else sc.setState(cfg.s);
      (window as any).__lab = { sc, cfg };
    });
    return () => { alive = false; sc?.dispose(); };
  }, []);
  return <div className="world3d" style={{ width: '100vw', height: '100vh' }}><canvas ref={ref} /></div>;
}
