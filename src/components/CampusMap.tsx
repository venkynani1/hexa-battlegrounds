import { useEffect, useMemo, useRef, useState } from 'react';
import { MapData, TIER_COLOR } from '../lib/game';
import { serverTime, useNow } from '../lib/time';

const S = 1000;
const BUILDING_NAMES: Record<string, string> = {
  hexavarsity: 'Hexavarsity', eb2: 'EB2', phase2: 'Phase 2', rtb: 'Ratan Tata Bldg', eb1: 'EB1', eb3: 'EB3', central: 'Central',
};

export type MapSquad = {
  number: number; location?: string | null; travel_from?: string | null; travel_to?: string | null;
  travel_started_at?: string | null; travel_arrive_at?: string | null; me?: boolean; allied?: boolean; in_battle?: boolean; hp?: number;
};

type Props = {
  map: MapData;
  zoneStage: number;
  zoneWarning?: boolean;
  squads?: MapSquad[];
  airdrops?: { location: string; tier: string }[];
  battles?: { location: string }[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  reachable?: Map<string, number>;
  height?: number | string;
  interactive?: boolean;
  showStart?: boolean;
  labels?: 'all' | 'major';
  bigLabels?: boolean;
};

export default function CampusMap({
  map, zoneStage, zoneWarning, squads = [], airdrops = [], battles = [], selected, onSelect, reachable,
  height = 420, interactive = true, showStart = false, labels = 'major', bigLabels = false,
}: Props) {
  useNow(200);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const pinch = useRef<{ d: number; k: number } | null>(null);

  // units-per-pixel so labels and markers stay readable on a phone and on a projector
  const [upp, setUpp] = useState(1.4);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) setUpp(Math.max(vbRef.current[2] / el.clientWidth, vbRef.current[3] / el.clientHeight));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const locs = useMemo(() => map.locations.filter((l) => showStart || l.kind !== 'start'), [map, showStart]);
  const byId = useMemo(() => Object.fromEntries(map.locations.map((l) => [l.id, l])), [map]);
  const vb = showStart ? [-50, -50, S + 100, S + 170] : [-50, -50, S + 100, S + 100];
  const vbRef = useRef(vb);
  vbRef.current = vb;

  const hulls = useMemo(() => {
    const groups: Record<string, typeof locs> = {};
    for (const l of locs) if (l.building && l.building !== 'sports') (groups[l.building] ||= []).push(l);
    return Object.entries(groups).map(([b, ls]) => {
      const xs = ls.map((l) => l.x * S); const ys = ls.map((l) => l.y * S);
      const pad = 34;
      return {
        id: b, name: BUILDING_NAMES[b] || b, x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2,
        danger: ls.every((l) => l.collapse <= zoneStage),
      };
    });
  }, [locs, zoneStage]);

  const unitsPerPx = () => {
    const el = svgRef.current;
    if (!el) return 1;
    return Math.max(vb[2] / el.clientWidth, vb[3] / el.clientHeight);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const k = Math.min(4, Math.max(1, (pinch.current.k * d) / pinch.current.d));
      setView((v) => ({ ...v, k }));
      dragged.current = true;
      return;
    }
    const dx = cur.x - prev.x; const dy = cur.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true;
    if (view.k > 1) {
      const u = unitsPerPx();
      setView((v) => clamp({ ...v, x: v.x + dx * u, y: v.y + dy * u }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!interactive) return;
    setView((v) => clamp({ ...v, k: Math.min(4, Math.max(1, v.k * (e.deltaY < 0 ? 1.15 : 0.87))) }));
  };
  const clamp = (v: { k: number; x: number; y: number }) => {
    const max = (S * (v.k - 1)) / 2;
    return { k: v.k, x: Math.max(-max, Math.min(max, v.x)), y: Math.max(-max, Math.min(max, v.y)) };
  };
  const zoom = (f: number) => setView((v) => clamp({ ...v, k: Math.min(4, Math.max(1, v.k * f)) }));

  const center = S / 2;
  const transform = `translate(${center + view.x} ${center + view.y}) scale(${view.k}) translate(${-center} ${-center})`;
  const px = (n: number) => (n * upp * (bigLabels ? 1.6 : 1)) / Math.pow(view.k, 0.85);
  const dense = upp > 1.9; // phone-sized map
  const rs = Math.max(1, upp / 2) / Math.sqrt(view.k); // radius/marker scale

  // squad positions (interpolated while travelling)
  const now = serverTime();
  const positioned = squads.map((sq) => {
    let x = 0; let y = 0; let visible = false;
    if (sq.travel_to && sq.travel_from && sq.travel_arrive_at && sq.travel_started_at && byId[sq.travel_from] && byId[sq.travel_to]) {
      const a = new Date(sq.travel_started_at).getTime(); const b = new Date(sq.travel_arrive_at).getTime();
      const p = Math.min(1, Math.max(0, (now - a) / Math.max(1, b - a)));
      x = (byId[sq.travel_from].x + (byId[sq.travel_to].x - byId[sq.travel_from].x) * p) * S;
      y = (byId[sq.travel_from].y + (byId[sq.travel_to].y - byId[sq.travel_from].y) * p) * S;
      visible = true;
    } else if (sq.location && byId[sq.location]) {
      x = byId[sq.location].x * S; y = byId[sq.location].y * S; visible = true;
    }
    return { ...sq, x, y, visible, travelling: !!sq.travel_to };
  }).filter((s) => s.visible);
  // spread squads sharing a spot
  const spots: Record<string, number> = {};
  const placed = positioned.map((s) => {
    const key = s.travelling ? `t${s.number}` : `${Math.round(s.x)}:${Math.round(s.y)}`;
    const i = (spots[key] = (spots[key] ?? -1) + 1);
    if (i === 0) return s;
    const ang = i * 2.1; const r = (16 + i * 3) * rs;
    return { ...s, x: s.x + Math.cos(ang) * r, y: s.y + Math.sin(ang) * r };
  });

  const majorKinds = new Set(['building', 'gate', 'amenity', 'sports', 'hub', 'start']);

  return (
    <div className="map-wrap" style={{ height }}>
      {interactive && (
        <div className="map-tools">
          <button className="btn ghost" onClick={() => zoom(1.4)} aria-label="Zoom in">+</button>
          <button className="btn ghost" onClick={() => zoom(0.7)} aria-label="Zoom out">−</button>
          <button className="btn ghost" onClick={() => setView({ k: 1, x: 0, y: 0 })} aria-label="Reset view">⌂</button>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={vb.join(' ')}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp} onWheel={onWheel}
        role="img" aria-label="Campus tactical map"
      >
        <defs>
          <radialGradient id="dangerGlow"><stop offset="0" stopColor="#ff4d5e" stopOpacity="0.45" /><stop offset="1" stopColor="#ff4d5e" stopOpacity="0" /></radialGradient>
          <pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="14" height="14" fill="rgba(255,77,94,0.08)" /><line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,77,94,0.35)" strokeWidth="4" />
          </pattern>
        </defs>
        <g transform={transform}>
          {/* campus boundary with gate gaps */}
          <rect x={30} y={30} width={S - 60} height={S - 60} rx={40} fill="rgba(62,165,255,0.03)" stroke="rgba(110,170,255,0.25)" strokeWidth={3} strokeDasharray="14 10" />
          {showStart && <path d={`M ${S / 2} ${S * 0.93} L ${S / 2} ${S * 1.07}`} stroke="rgba(255,194,61,0.5)" strokeWidth={14} strokeLinecap="round" />}

          {/* building footprints */}
          {hulls.map((h) => (
            <g key={h.id}>
              <rect x={h.x} y={h.y} width={h.w} height={h.h} rx={18}
                fill={h.danger ? 'url(#hatch)' : 'rgba(62,165,255,0.06)'}
                stroke={h.danger ? 'rgba(255,77,94,0.6)' : 'rgba(110,170,255,0.3)'} strokeWidth={2} />
              <text x={h.x + 8} y={h.y + h.h - 8} className="bldg-label" fontSize={px(9.5)}>{h.name}</text>
            </g>
          ))}

          {/* routes */}
          {map.edges.map(([a, b]) => byId[a] && byId[b] && (
            <line key={`${a}-${b}`} x1={byId[a].x * S} y1={byId[a].y * S} x2={byId[b].x * S} y2={byId[b].y * S}
              stroke={reachable && ((reachable.has(a) && selected === b) || (reachable.has(b) && selected === a)) ? 'rgba(62,240,255,0.7)' : 'rgba(110,170,255,0.22)'}
              strokeWidth={2.5} strokeDasharray="6 7" />
          ))}

          {/* locations */}
          {locs.map((l) => {
            const danger = l.collapse <= zoneStage;
            const warn = !danger && zoneWarning && l.collapse === zoneStage + 1;
            const major = majorKinds.has(l.kind);
            const r = (l.id === 'tr14' ? 15 : major ? 12 : 8) * rs;
            const reach = reachable?.has(l.id);
            const fill = !l.enabled ? '#334' : danger ? '#ff4d5e' : l.id === 'tr14' ? '#ffc23d' : warn ? '#ff8a3d' : major ? '#3ea5ff' : '#7fb8ff';
            const showLabel = labels === 'all' || selected === l.id || l.id === 'tr14' || (dense
              ? view.k >= 1.7 || l.kind === 'gate' || l.kind === 'sports' || l.id === 'fountain'
              : major || view.k >= 1.8);
            return (
              <g key={l.id} style={{ cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => { if (!dragged.current) onSelect?.(l.id); }}>
                {danger && <circle cx={l.x * S} cy={l.y * S} r={34} fill="url(#dangerGlow)" />}
                {warn && <circle cx={l.x * S} cy={l.y * S} r={r + 8} fill="none" stroke="#ff8a3d" strokeWidth={3} className="danger-blink" />}
                {reach && <circle cx={l.x * S} cy={l.y * S} r={r + 7} fill="none" stroke="#3ef0ff" strokeWidth={2.5} strokeDasharray="4 4" />}
                {selected === l.id && <circle cx={l.x * S} cy={l.y * S} r={r + 12} fill="none" stroke="#fff" strokeWidth={2.5} />}
                <circle cx={l.x * S} cy={l.y * S} r={r} fill={fill} stroke="#050912" strokeWidth={3} opacity={l.enabled ? 1 : 0.5} />
                {l.kind === 'gate' && <text x={l.x * S} y={l.y * S + 4.5 * rs} textAnchor="middle" fontSize={13 * rs} fontWeight={700} fill="#04101f">G</text>}
                {l.id === 'tr14' && <text x={l.x * S} y={l.y * S + 4.5 * rs} textAnchor="middle" fontSize={13 * rs} fontWeight={700} fill="#1a1200">14</text>}
                <rect x={l.x * S - 30} y={l.y * S - 30} width={60} height={60} fill="transparent" />
                {showLabel && (
                  <text x={l.x * S} y={l.y * S - r - 6} textAnchor="middle" className="node-label" fontSize={px(major ? 11 : 9.5)}>
                    {shortName(l.name)}
                  </text>
                )}
              </g>
            );
          })}

          {/* airdrops */}
          {airdrops.map((a, i) => byId[a.location] && (
            <g key={`ad${i}`} transform={`translate(${byId[a.location].x * S + 18 * rs} ${byId[a.location].y * S - 26 * rs}) scale(${rs})`}>
              <circle r={14} fill="none" stroke={TIER_COLOR[a.tier] || '#fff'} strokeWidth={3} className="pulse-ring" />
              <path d="M -12 -4 Q 0 -20 12 -4 Z" fill={TIER_COLOR[a.tier] || '#fff'} />
              <line x1={-10} y1={-4} x2={-4} y2={6} stroke="#cfe2ff" strokeWidth={1.5} /><line x1={10} y1={-4} x2={4} y2={6} stroke="#cfe2ff" strokeWidth={1.5} />
              <rect x={-6} y={5} width={12} height={10} rx={2} fill="#8b6b3d" stroke="#ffd58a" strokeWidth={1.5} />
            </g>
          ))}

          {/* battles */}
          {battles.map((b, i) => byId[b.location] && (
            <g key={`bt${i}`} transform={`translate(${byId[b.location].x * S} ${byId[b.location].y * S}) scale(${rs})`}>
              <circle r={26} fill="none" stroke="#ff4d5e" strokeWidth={4} className="pulse-ring" />
              <text y={-30} textAnchor="middle" fontSize={22}>⚔️</text>
            </g>
          ))}

          {/* squads */}
          {placed.map((s) => (
            <g key={`sq${s.number}`} transform={`translate(${s.x} ${s.y}) scale(${rs})`} style={{ transition: 'transform 0.2s linear' }}>
              {s.me && <circle r={22} fill="none" stroke="#ffc23d" strokeWidth={3} className="pulse-ring" />}
              <rect x={-17} y={-13} width={34} height={26} rx={6}
                fill={s.me ? '#ffc23d' : s.allied ? '#5dff9e' : s.in_battle ? '#ff4d5e' : '#e6f0ff'}
                stroke="#050912" strokeWidth={3} opacity={s.travelling ? 0.85 : 1} />
              <text y={6} textAnchor="middle" fontSize={16} fontWeight={800} fill="#04101f" fontFamily="Rajdhani, sans-serif">{s.number}</text>
            </g>
          ))}
        </g>
      </svg>
      <div className="map-legend" aria-hidden>
        <span className="chip"><span className="dot" style={{ background: '#3ea5ff' }} />Safe</span>
        {zoneWarning && <span className="chip warn"><span className="dot" style={{ background: '#ff8a3d' }} />Collapsing</span>}
        {zoneStage > 0 && <span className="chip bad"><span className="dot" style={{ background: '#ff4d5e' }} />Danger</span>}
        <span className="chip gold"><span className="dot" style={{ background: '#ffc23d' }} />TR14</span>
      </div>
    </div>
  );
}

function shortName(n: string) {
  return n.replace(' — Final Battleground', '').replace(/\s*\((.*?)\)\s*$/, '').replace('Training Rooms', 'TR');
}
