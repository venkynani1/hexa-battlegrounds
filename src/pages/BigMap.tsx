// Full-screen tactical map in the style of battle-royale games: top-down campus with a grid,
// place names, safe/next/red zones, airdrops and squads. Pinch/drag to look around, tap to drop a
// marker (shows distance and run time), tap near a place to run there.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapData } from '../lib/game';
import { TIER_COLOR } from '../lib/game';
import { Countdown } from '../components/ui';
import { msUntil } from '../lib/time';
import { SHORT } from '../components/CampusMap';

export type XY = [number, number];
export const METERS = 600; // campus width shown as metres (distances read like a real map)

const BUILD: Record<string, { fill: string; name: string }> = {
  hexavarsity: { fill: '#e9edf1', name: 'HEXAVARSITY' }, eb1: { fill: '#d9cbb0', name: 'EB1' }, eb2: { fill: '#dcd3c4', name: 'EB2' },
  eb3: { fill: '#d4c7b4', name: 'EB3' }, rtb: { fill: '#c07a62', name: 'RATAN TATA' }, phase2: { fill: '#c4ccd6', name: 'PHASE 2' },
};
const V = 1000; // svg units per campus width

export default function BigMap({ map, me, yaw, squads, zone, zoneNextAt, red, drops, marker, setMarker, onRun, canRun, speed, onClose, title }: {
  map: MapData; me: XY | null; yaw: number; squads: { id: string; number: number; pos?: number[] | null; me?: boolean; allied?: boolean }[];
  zone: any; zoneNextAt?: string | null; red: any; drops: { id: string; location: string; tier: string }[];
  marker: XY | null; setMarker: (m: XY | null) => void; onRun: (locId: string) => void; canRun: boolean; speed: number; onClose: () => void; title: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  // the viewBox follows the screen shape so the map fills it and the grid labels sit on the edges
  const [box, setBox] = useState({ w: V, h: V });
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setBox({ w: Math.max(V, (V * r.width) / r.height), h: Math.max(V, (V * r.height) / r.width) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const vx = -(box.w - V) / 2; const vy = -(box.h - V) / 2;
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d0: number; k0: number; moved: boolean; start: { x: number; y: number }; v0: typeof view } | null>(null);

  // centre on the squad when opened
  useEffect(() => { if (me) setView({ k: 1.6, x: V / 2 - me[0] * V * 1.6 + 0, y: V / 2 - me[1] * V * 1.6 }); }, []);

  const byId = useMemo(() => new Map(map.locations.map((l) => [l.id, l])), [map]);
  const blocks = useMemo(() => {
    const g = new Map<string, typeof map.locations>();
    for (const l of map.locations) if (l.building && BUILD[l.building]) g.set(l.building, [...(g.get(l.building) || []), l]);
    return [...g].map(([b, ls]) => {
      const xs = ls.map((l) => l.x); const ys = ls.map((l) => l.y);
      return { id: b, x0: Math.min(...xs) - 0.04, x1: Math.max(...xs) + 0.04, y0: Math.min(...ys) - 0.04, y1: Math.max(...ys) + 0.04 };
    });
  }, [map]);

  function toMap(cx: number, cy: number): XY {
    const r = svg.current!.getBoundingClientRect();
    const s = r.width / box.w;
    const sx = (cx - r.left) / s + vx; const sy = (cy - r.top) / s + vy;
    return [(sx - view.x) / view.k / V, (sy - view.y) / view.k / V];
  }
  function onDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const list = [...pts.current.values()];
    gesture.current = { d0: list.length === 2 ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) : 0, k0: view.k, moved: gesture.current?.moved && list.length > 1 ? true : false, start: { x: e.clientX, y: e.clientY }, v0: view };
  }
  function onMove(e: React.PointerEvent) {
    if (!pts.current.has(e.pointerId) || !gesture.current) return;
    const prev = pts.current.get(e.pointerId)!;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const r = svg.current!.getBoundingClientRect(); const s = r.width / box.w;
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.d0 > 0) {
        const k = Math.max(1, Math.min(6, g.k0 * (d / g.d0)));
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        zoomAt(c.x, c.y, k);
        g.moved = true;
      }
    } else {
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 8) g.moved = true;
      if (g.moved) setView((v) => clampView({ ...v, x: v.x + (e.clientX - prev.x) / s, y: v.y + (e.clientY - prev.y) / s }));
    }
  }
  function onUp(e: React.PointerEvent) {
    const single = pts.current.size === 1;
    pts.current.delete(e.pointerId);
    if (single && gesture.current && !gesture.current.moved) {
      const p = toMap(e.clientX, e.clientY);
      if (p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) setMarker(p);
    }
    if (pts.current.size === 0) gesture.current = null;
  }
  function clampView(v: typeof view) {
    const lx = V * v.k - V; const ly = V * v.k - V;
    return { k: v.k, x: Math.max(-lx - 200, Math.min(200, v.x)), y: Math.max(-ly - 200, Math.min(200, v.y)) };
  }
  function zoomAt(cx: number, cy: number, k: number) {
    setView((v) => {
      const r = svg.current!.getBoundingClientRect(); const s = r.width / box.w;
      const sx = (cx - r.left) / s + vx; const sy = (cy - r.top) / s + vy;
      const mx = (sx - v.x) / v.k; const my = (sy - v.y) / v.k;
      return clampView({ k, x: sx - mx * k, y: sy - my * k });
    });
  }

  // marker → nearest place (if any) for "run here"
  const near = marker ? map.locations.filter((l) => l.kind !== 'start' && l.enabled)
    .map((l) => ({ l, d: Math.hypot(l.x - marker[0], l.y - marker[1]) })).sort((a, b) => a.d - b.d)[0] : null;
  const place = near && near.d < 0.05 ? near.l : null;
  const dist = marker && me ? Math.hypot(marker[0] - me[0], marker[1] - me[1]) : 0;
  const k = view.k;
  const fs = (n: number) => n / Math.sqrt(k); // labels shrink less than the map grows
  const cur = zone?.cur as number[] | undefined; const nxt = zone?.next as number[] | undefined;
  const majors = map.locations.filter((l) => l.kind !== 'start' && (!l.building || !BUILD[l.building] || l.kind === 'building'));

  return (
    <div className="bigmap" role="dialog" aria-label="Campus map">
      <div className="bm-top">
        <b className="up">{title}</b>
        {zoneNextAt && msUntil(zoneNextAt) > 0 ? <span className="bm-chip warn">☢ Zone shrinks in <Countdown to={zoneNextAt} /></span> : <span className="bm-chip">◯ Safe zone {zone?.stage ?? 0}/5</span>}
        <button className="bm-close" onClick={onClose} aria-label="Close map">✕</button>
      </div>
      <svg ref={svg} className="bm-svg" viewBox={`${vx} ${vy} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onWheel={(e) => zoomAt(e.clientX, e.clientY, Math.max(1, Math.min(6, view.k * (e.deltaY > 0 ? 0.88 : 1.14))))}>
        <defs>
          <pattern id="bm-grass" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#6fa452" /><circle cx="6" cy="8" r="1.4" fill="#5f9446" /><circle cx="17" cy="18" r="1.2" fill="#7db45e" /></pattern>
          <mask id="bm-safe"><rect x="-2000" y="-2000" width="5000" height="5000" fill="white" />{cur && <circle cx={cur[0] * V} cy={cur[1] * V} r={cur[2] * V} fill="black" />}</mask>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
          <rect x={-2000} y={-2000} width={V + 4000} height={V + 4000} fill="#5f9446" />
          <rect x={10} y={10} width={V - 20} height={V - 20} rx={30} fill="url(#bm-grass)" stroke="#d8d2c4" strokeWidth={8} />
          {/* roads */}
          {map.edges.map(([a, b]) => {
            const A = byId.get(a); const B = byId.get(b);
            if (!A || !B || (A.building && A.building === B.building)) return null;
            return <g key={`${a}-${b}`}>
              <line x1={A.x * V} y1={A.y * V} x2={B.x * V} y2={B.y * V} stroke="#c9c2b4" strokeWidth={34} strokeLinecap="round" />
              <line x1={A.x * V} y1={A.y * V} x2={B.x * V} y2={B.y * V} stroke="#4a4f57" strokeWidth={24} strokeLinecap="round" />
              <line x1={A.x * V} y1={A.y * V} x2={B.x * V} y2={B.y * V} stroke="#efe9d8" strokeWidth={2} strokeDasharray="14 12" />
            </g>;
          })}
          {/* buildings */}
          {blocks.map((b) => (
            <g key={b.id}>
              <rect x={b.x0 * V + 6} y={b.y0 * V + 8} width={(b.x1 - b.x0) * V} height={(b.y1 - b.y0) * V} rx={6} fill="rgba(0,0,0,0.25)" />
              <rect x={b.x0 * V} y={b.y0 * V} width={(b.x1 - b.x0) * V} height={(b.y1 - b.y0) * V} rx={6} fill={BUILD[b.id].fill} stroke="#5b5f66" strokeWidth={3} />
            </g>
          ))}
          {/* sports & plaza */}
          {map.locations.filter((l) => l.kind === 'sports').map((l) => (
            <g key={l.id}><rect x={l.x * V - 58} y={l.y * V - 38} width={116} height={76} fill="#47a852" stroke="#fff" strokeWidth={3} /><line x1={l.x * V} y1={l.y * V - 38} x2={l.x * V} y2={l.y * V + 38} stroke="#fff" strokeWidth={2} /></g>
          ))}
          {byId.get('fountain') && <circle cx={byId.get('fountain')!.x * V} cy={byId.get('fountain')!.y * V} r={16} fill="#4fb3e8" stroke="#e6e1d6" strokeWidth={5} />}
          {/* grid */}
          {Array.from({ length: 9 }, (_, i) => (
            <g key={i} opacity={0.35}>
              <line x1={i * 125} y1={0} x2={i * 125} y2={V} stroke="#fff" strokeWidth={1.5 / k} />
              <line x1={0} y1={i * 125} x2={V} y2={i * 125} stroke="#fff" strokeWidth={1.5 / k} />
            </g>
          ))}
          {/* zones */}
          {cur && cur[2] < 0.86 && <rect x={-2000} y={-2000} width={5000} height={5000} fill="#2f6bff" opacity={0.28} mask="url(#bm-safe)" />}
          {cur && cur[2] < 0.86 && <circle cx={cur[0] * V} cy={cur[1] * V} r={cur[2] * V} fill="none" stroke="#7fb2ff" strokeWidth={4 / k} />}
          {nxt && <circle cx={nxt[0] * V} cy={nxt[1] * V} r={nxt[2] * V} fill="none" stroke="#fff" strokeWidth={4 / k} strokeDasharray={`${16 / k} ${10 / k}`} />}
          {red && <circle cx={red.x * V} cy={red.y * V} r={red.r * V} fill="rgba(255,34,56,0.35)" stroke="#ff3b4e" strokeWidth={4 / k} />}
          {/* place names */}
          {majors.map((l) => (
            <g key={l.id}>
              <circle cx={l.x * V} cy={l.y * V} r={5 / Math.sqrt(k)} fill={l.id === 'tr14' ? '#ffc23d' : '#fff'} stroke="#1b2430" strokeWidth={1.5 / Math.sqrt(k)} />
              <text x={l.x * V} y={l.y * V - 10 / Math.sqrt(k)} className="bm-name" fontSize={fs(l.kind === 'building' ? 22 : 18)} textAnchor="middle">{(SHORT[l.id] || l.name).toUpperCase()}</text>
            </g>
          ))}
          {k >= 2.2 && map.locations.filter((l) => !majors.includes(l) && l.kind !== 'start').map((l) => (
            <g key={l.id}>
              <circle cx={l.x * V} cy={l.y * V} r={4 / Math.sqrt(k)} fill="#2ee6ff" />
              <text x={l.x * V} y={l.y * V - 8 / Math.sqrt(k)} className="bm-name small" fontSize={fs(13)} textAnchor="middle">{SHORT[l.id] || l.name}</text>
            </g>
          ))}
          {blocks.map((b) => <text key={`n${b.id}`} x={((b.x0 + b.x1) / 2) * V} y={b.y1 * V - 8} className="bm-bname" fontSize={fs(16)} textAnchor="middle">{BUILD[b.id].name}</text>)}
          {/* airdrops */}
          {drops.map((d) => { const l = byId.get(d.location); return l ? (
            <g key={d.id} transform={`translate(${l.x * V + 18} ${l.y * V - 18}) scale(${1 / Math.sqrt(k)})`}>
              <rect x={-12} y={-12} width={24} height={24} rx={4} fill={TIER_COLOR[d.tier] || '#ffc23d'} stroke="#1b2430" strokeWidth={3} />
              <path d="M-12 -2 H12 M0 -12 V12" stroke="#1b2430" strokeWidth={3} />
            </g>) : null; })}
          {/* marker + line from me */}
          {marker && me && <line x1={me[0] * V} y1={me[1] * V} x2={marker[0] * V} y2={marker[1] * V} stroke="#ffd23d" strokeWidth={3 / k} strokeDasharray={`${10 / k} ${8 / k}`} />}
          {marker && (
            <g transform={`translate(${marker[0] * V} ${marker[1] * V}) scale(${1.2 / Math.sqrt(k)})`}>
              <path d="M0 0 C -14 -18 -14 -34 0 -34 C 14 -34 14 -18 0 0 Z" fill="#ffd23d" stroke="#1b2430" strokeWidth={2.5} />
              <circle cx={0} cy={-24} r={5} fill="#1b2430" />
            </g>
          )}
          {/* squads */}
          {squads.filter((q) => q.pos && !q.me).map((q) => (
            <g key={q.id} transform={`translate(${q.pos![0] * V} ${q.pos![1] * V}) scale(${1 / Math.sqrt(k)})`}>
              <circle r={9} fill={q.allied ? '#5dff9e' : '#ff4d5e'} stroke="#fff" strokeWidth={2.5} />
              <text y={-14} className="bm-name small" fontSize={13} textAnchor="middle">SQ {q.number}</text>
            </g>
          ))}
          {me && (
            <g transform={`translate(${me[0] * V} ${me[1] * V}) rotate(${(yaw * 180) / Math.PI}) scale(${1.3 / Math.sqrt(k)})`}>
              <path d="M0 -26 L 22 -60 A 40 40 0 0 0 -22 -60 Z" fill="#ffffff" opacity={0.25} transform="translate(0 16)" />
              <path d="M0 -16 L 11 11 L 0 5 L -11 11 Z" fill="#2ee6ff" stroke="#fff" strokeWidth={2.5} strokeLinejoin="round" />
            </g>
          )}
        </g>
        {/* grid labels pinned to the edges */}
        {Array.from({ length: 8 }, (_, i) => (
          <g key={`g${i}`} className="bm-grid">
            <text x={(i * 125 + 62) * k + view.x} y={vy + 26} textAnchor="middle">{'ABCDEFGH'[i]}</text>
            <text x={vx + 16} y={(i * 125 + 70) * k + view.y} textAnchor="middle">{i + 1}</text>
          </g>
        ))}
      </svg>

      <div className="bm-bottom">
        {marker ? (
          <div className="bm-card">
            <div className="grow">
              <b>{place ? place.name : 'Marker'}</b>
              <div className="muted">{Math.round(dist * METERS)} m · about {Math.max(1, Math.round(dist / speed))} s on foot{place ? ` · ${place.reward}` : ''}</div>
            </div>
            {place && canRun && <button className="btn primary" onClick={() => onRun(place.id)}>Run here</button>}
            <button className="btn ghost" onClick={() => setMarker(null)} aria-label="Remove marker">✕</button>
          </div>
        ) : (
          <div className="bm-hint">Tap the map to drop a marker · pinch to zoom · drag to look around</div>
        )}
        <div className="bm-legend">
          <span><i style={{ background: '#2ee6ff' }} />You</span><span><i style={{ background: '#ff4d5e' }} />Enemy</span>
          <span><i style={{ background: '#5dff9e' }} />Ally</span><span><i className="ring" />Next zone</span><span><i style={{ background: '#ffc23d' }} />Airdrop</span>
        </div>
      </div>
    </div>
  );
}
