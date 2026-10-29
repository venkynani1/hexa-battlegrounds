import { useEffect, useMemo, useRef, useState } from 'react';
import { MapData, TIER_COLOR } from '../lib/game';
import { serverTime, useNow } from '../lib/time';

const S = 1000;
const BUILDING_NAMES: Record<string, string> = {
  hexavarsity: 'Hexavarsity', eb2: 'EB2', phase2: 'Phase 2', rtb: 'Ratan Tata Bldg', eb1: 'EB1', eb3: 'EB3', central: 'Central',
};

// Short labels used when zoomed out; full names appear when zoomed in or selected.
export const SHORT: Record<string, string> = {
  sipcot: 'SIPCOT', gate_1: 'Gate 1', gate_2: 'Gate 2', gate_3: 'Gate 3', gate_4: 'Gate 4',
  hx_lobby: 'Hexavarsity', hx_help: 'Help Desk', hx_costa: 'Costa', hx_tr_wing2: 'TR 1–13', hx_pantry2: 'Pantry',
  hx_tr_wing3: 'TR 15–19', hx_odc: 'ODC', tr14: 'TR14',
  eb2_lobby: 'EB2', eb2_stg: 'STG', eb2_floors: 'EB2 Floors', eb2_terrace: 'EB2 Terrace', eb2_parking: 'EB2 Parking',
  p2_lobby: 'Phase 2', p2_parking: 'P2 Parking', p2_floors: 'P2 F1–2', p2_upper: 'P2 F3–5',
  rt_lobby: 'RTB', rt_cec: 'CEC Boardroom', rt_floors: 'RTB Floors', rt_glass: 'Glass Zone', rt_parking: 'RTB Parking',
  eb1_lobby: 'EB1', eb1_floors: 'EB1 Floors', eb1_terrace: 'EB1 Terrace', eb1_parking: 'EB1 Parking',
  eb3_lobby: 'EB3', eb3_hr: 'HR Zone', eb3_floors: 'EB3 Floors', eb3_terrace: 'EB3 Terrace', eb3_parking: 'EB3 Parking',
  central_steps: 'Steps', hexadine: 'Hexadine', hexaraunt: 'Hexaraunt', hexacafe: 'Hexacafe', fountain: 'Fountain',
  shuttle_court: 'Shuttle Ct', pickleball: 'Pickleball', cricket: 'Cricket',
};
export const fullName = (n: string) => n.replace(' — Final Battleground', '');

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
  /** current location of the viewing squad (route highlighting + centring) */
  from?: string | null;
  height?: number | string;
  interactive?: boolean;
  showStart?: boolean;
  labels?: 'all' | 'major';
  bigLabels?: boolean;
  /** show toggle chips (labels, zone, squads, drops) */
  toolbar?: boolean;
};

type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// Convex hull (monotone chain) — used for the safe-zone boundary.
function hull(pts: [number, number][]) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = []; const hi: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
// Smooth padded outline around a set of points (circle for 1–2 points).
function zonePath(pts: [number, number][], pad: number) {
  if (!pts.length) return '';
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  if (pts.length < 3) {
    const r = Math.max(pad, ...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy) + pad));
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  const h = hull(pts).map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * pad, y + ((y - cy) / d) * pad] as [number, number];
  });
  // quadratic smoothing through edge midpoints
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = '';
  for (let i = 0; i < h.length; i++) {
    const a = h[i]; const b = h[(i + 1) % h.length]; const m = mid(a, b);
    if (i === 0) { const m0 = mid(h[h.length - 1], a); d += `M ${m0[0]} ${m0[1]} `; }
    d += `Q ${a[0]} ${a[1]} ${m[0]} ${m[1]} `;
  }
  return d + 'Z';
}

// Shortest path (Dijkstra) over enabled, safe edges.
function route(map: MapData, from: string, to: string, zoneStage: number) {
  const ok = new Set(map.locations.filter((l) => l.enabled && l.collapse > zoneStage && l.kind !== 'start').map((l) => l.id));
  if (!ok.has(to)) return null;
  const adj: Record<string, [string, number][]> = {};
  for (const [a, b, s] of map.edges) { (adj[a] ||= []).push([b, s]); (adj[b] ||= []).push([a, s]); }
  const dist: Record<string, number> = { [from]: 0 }; const prev: Record<string, string> = {}; const done = new Set<string>();
  while (true) {
    let u: string | null = null;
    for (const k in dist) if (!done.has(k) && (u === null || dist[k] < dist[u])) u = k;
    if (u === null || u === to) break;
    done.add(u);
    for (const [v, s] of adj[u] || []) {
      if (!ok.has(v) && v !== to) continue;
      if (dist[v] === undefined || dist[u] + s < dist[v]) { dist[v] = dist[u] + s; prev[v] = u; }
    }
  }
  if (dist[to] === undefined) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, seconds: dist[to] };
}
export { route as shortestRoute };

export default function CampusMap({
  map, zoneStage, zoneWarning, squads = [], airdrops = [], battles = [], selected, onSelect, reachable, from,
  height = 420, interactive = true, showStart = false, labels = 'major', bigLabels = false, toolbar = false,
}: Props) {
  const anyTravel = squads.some((s) => s.travel_to);
  useNow(anyTravel ? 120 : 1000);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [show, setShow] = useState({ labels: true, zone: true, squads: true, drops: true });
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const pinch = useRef<{ d: number; k: number } | null>(null);

  const locs = useMemo(() => map.locations.filter((l) => showStart || l.kind !== 'start'), [map, showStart]);
  const byId = useMemo(() => Object.fromEntries(map.locations.map((l) => [l.id, l])), [map]);
  const vb = showStart ? [-50, -50, S + 100, S + 170] : [-50, -50, S + 100, S + 100];
  const vbRef = useRef(vb);
  vbRef.current = vb;

  // units-per-pixel so text and markers stay readable on a 360 px phone and on a projector
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

  const hulls = useMemo(() => {
    const groups: Record<string, typeof locs> = {};
    for (const l of locs) if (l.building && l.building !== 'sports') (groups[l.building] ||= []).push(l);
    return Object.entries(groups).map(([b, ls]) => {
      const xs = ls.map((l) => l.x * S); const ys = ls.map((l) => l.y * S);
      const pad = 30;
      return {
        id: b, name: BUILDING_NAMES[b] || b, x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2,
        danger: ls.every((l) => l.collapse <= zoneStage),
      };
    });
  }, [locs, zoneStage]);

  const safeZone = useMemo(() => {
    const pts = (stage: number) => locs.filter((l) => l.collapse > stage && l.enabled && l.kind !== 'start').map((l) => [l.x * S, l.y * S] as [number, number]);
    return {
      now: zoneStage > 0 ? zonePath(pts(zoneStage), 46) : '',
      next: zoneWarning && zoneStage < 5 ? zonePath(pts(zoneStage + 1), 40) : '',
    };
  }, [locs, zoneStage, zoneWarning]);

  const plan = useMemo(() => (from && selected && from !== selected ? route(map, from, selected, zoneStage) : null), [map, from, selected, zoneStage]);
  const routeEdges = useMemo(() => {
    const set = new Set<string>();
    if (plan) for (let i = 0; i < plan.path.length - 1; i++) { set.add(`${plan.path[i]}|${plan.path[i + 1]}`); set.add(`${plan.path[i + 1]}|${plan.path[i]}`); }
    return set;
  }, [plan]);

  const unitsPerPx = () => {
    const el = svgRef.current;
    if (!el || !el.clientWidth) return 1;
    return Math.max(vb[2] / el.clientWidth, vb[3] / el.clientHeight);
  };
  const clamp = (v: { k: number; x: number; y: number }) => {
    const max = (S * (v.k - 1)) / 2 + 40;
    return { k: v.k, x: Math.max(-max, Math.min(max, v.x)), y: Math.max(-max, Math.min(max, v.y)) };
  };
  const zoom = (f: number) => setView((v) => clamp({ ...v, k: Math.min(4, Math.max(1, v.k * f)) }));
  const centerOn = (id?: string | null, k = 2.2) => {
    const l = id ? byId[id] : null;
    if (!l) return;
    setView(clamp({ k, x: -k * (l.x * S - S / 2), y: -k * (l.y * S - S / 2) }));
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
      const k = Math.min(4, Math.max(1, (pinch.current.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d));
      setView((v) => clamp({ ...v, k }));
      dragged.current = true;
      return;
    }
    const dx = cur.x - prev.x; const dy = cur.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged.current = true;
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

  const center = S / 2;
  const transform = `translate(${center + view.x} ${center + view.y}) scale(${view.k}) translate(${-center} ${-center})`;
  const scaleTxt = bigLabels ? 1.5 : 1;
  const px = (n: number) => (n * upp * scaleTxt) / Math.pow(view.k, 0.9); // font size in map units for n screen px
  const rs = Math.max(1, upp / 1.8) / Math.sqrt(view.k); // marker scale

  // visible map region (map coords)
  const vis = {
    x0: center + (vb[0] - center - view.x) / view.k, y0: center + (vb[1] - center - view.y) / view.k,
    x1: center + (vb[0] + vb[2] - center - view.x) / view.k, y1: center + (vb[1] + vb[3] - center - view.y) / view.k,
  };

  // squads (interpolated while travelling; grouped when crowded)
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
  const groups: Record<string, typeof positioned> = {};
  for (const s of positioned) (groups[s.travelling ? `t${s.number}` : `${Math.round(s.x)}:${Math.round(s.y)}`] ||= []).push(s);
  const markers: ({ kind: 'squad'; s: (typeof positioned)[0]; x: number; y: number } | { kind: 'cluster'; n: number; x: number; y: number; battle: boolean })[] = [];
  for (const g of Object.values(groups)) {
    const mine = g.find((s) => s.me);
    if (g.length >= 4 && view.k < 2.5) {
      const others = g.filter((s) => !s.me);
      markers.push({ kind: 'cluster', n: others.length, x: g[0].x + 20 * rs, y: g[0].y + 4 * rs, battle: others.some((s) => s.in_battle) });
      if (mine) markers.push({ kind: 'squad', s: mine, x: mine.x - 14 * rs, y: mine.y });
    } else {
      g.forEach((s, i) => {
        if (i === 0) return markers.push({ kind: 'squad', s, x: s.x, y: s.y });
        const ang = i * 2.1; const r = (17 + i * 3) * rs;
        markers.push({ kind: 'squad', s, x: s.x + Math.cos(ang) * r, y: s.y + Math.sin(ang) * r });
      });
    }
  }

  // ── label placement with collision avoidance ─────────────────────────────
  const majorKinds = new Set(['building', 'gate', 'amenity', 'sports', 'hub', 'start']);
  const myLoc = from || squads.find((s) => s.me)?.location;
  const radiusOf = (l: (typeof locs)[0]) => (l.id === 'tr14' ? 14 : majorKinds.has(l.kind) ? 10.5 : 7) * rs;
  const labelsOut = useMemo(() => {
    if (!show.labels) return [];
    const nodes: Box[] = locs.map((l) => { const r = radiusOf(l) + 2; return { x: l.x * S - r, y: l.y * S - r, w: r * 2, h: r * 2 }; });
    const placed: Box[] = [];
    const out: { id: string; text: string; x: number; y: number; fs: number; strong: boolean }[] = [];
    const prio = (l: (typeof locs)[0]) =>
      l.id === selected ? 100 : l.id === myLoc ? 95 : l.id === 'tr14' ? 90 : reachable?.has(l.id) ? 70
        : l.kind === 'building' ? 60 : l.kind === 'amenity' || l.kind === 'hub' ? 50 : l.kind === 'gate' ? 45 : l.kind === 'sports' ? 40 : 10;
    const cands = locs
      .filter((l) => l.x * S >= vis.x0 - 20 && l.x * S <= vis.x1 + 20 && l.y * S >= vis.y0 - 20 && l.y * S <= vis.y1 + 20)
      .map((l) => ({ l, p: prio(l) }))
      .filter(({ p }) => labels === 'all' || p >= 40 || view.k >= 1.6)
      .sort((a, b) => b.p - a.p);
    for (const { l, p } of cands) {
      const strong = p >= 90;
      const full = view.k >= 2.4 || l.id === selected || (bigLabels && view.k >= 1);
      const text = full ? fullName(l.name) : SHORT[l.id] || fullName(l.name);
      const fs = px(strong ? 11.5 : majorKinds.has(l.kind) ? 10.5 : 9.5);
      const w = text.length * fs * 0.55 + fs * 0.4; const h = fs * 1.15;
      const r = radiusOf(l); const x = l.x * S; const y = l.y * S;
      const spots: Box[] = [
        { x: x - w / 2, y: y - r - 3 - h, w, h }, { x: x - w / 2, y: y + r + 3, w, h },
        { x: x + r + 4, y: y - h / 2, w, h }, { x: x - r - 4 - w, y: y - h / 2, w, h },
      ];
      const own = nodes[locs.indexOf(l)];
      let spot = spots.find((b) => !placed.some((o) => hit(o, b)) && !nodes.some((n) => n !== own && hit(n, b)));
      if (!spot && p >= 95) spot = spots[0];
      if (!spot) continue;
      placed.push(spot);
      out.push({ id: l.id, text, x: spot.x + fs * 0.2, y: spot.y + h * 0.8, fs, strong });
    }
    return out;
  }, [locs, show.labels, selected, myLoc, reachable, view.k, view.x, view.y, upp, labels, bigLabels]);

  return (
    <div className="map-wrap" style={{ height }}>
      {interactive && (
        <div className="map-tools">
          <button className="btn ghost" onClick={() => zoom(1.4)} aria-label="Zoom in">+</button>
          <button className="btn ghost" onClick={() => zoom(0.7)} aria-label="Zoom out">−</button>
          {myLoc && <button className="btn ghost" onClick={() => centerOn(myLoc)} aria-label="Centre on my squad" title="Centre on my squad">◎</button>}
          <button className="btn ghost" onClick={() => setView({ k: 1, x: 0, y: 0 })} aria-label="Reset view">⌂</button>
        </div>
      )}
      {toolbar && (
        <div className="map-filters" role="group" aria-label="Map layers">
          {([['labels', 'Labels'], ['zone', 'Zone'], ['squads', 'Squads'], ['drops', 'Drops']] as const).map(([k, label]) => (
            <button key={k} className={`chip ${show[k] ? 'on' : ''}`} aria-pressed={show[k]} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))}>{label}</button>
          ))}
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
          <pattern id="hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="14" height="14" fill="rgba(255,77,94,0.06)" /><line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,77,94,0.28)" strokeWidth="4" />
          </pattern>
          <radialGradient id="radar"><stop offset="0" stopColor="#3ef0ff" stopOpacity="0.16" /><stop offset="1" stopColor="#3ef0ff" stopOpacity="0" /></radialGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g transform={transform}>
          {/* campus ground + roads */}
          <rect x={30} y={30} width={S - 60} height={S - 60} rx={40} fill="rgba(62,165,255,0.03)" stroke="rgba(110,170,255,0.25)" strokeWidth={3} strokeDasharray="14 10" />
          {showStart && <path d={`M ${S / 2} ${S * 0.93} L ${S / 2} ${S * 1.07}`} stroke="rgba(255,194,61,0.5)" strokeWidth={14} strokeLinecap="round" />}
          {map.edges.map(([a, b]) => byId[a] && byId[b] && (
            <line key={`road-${a}-${b}`} x1={byId[a].x * S} y1={byId[a].y * S} x2={byId[b].x * S} y2={byId[b].y * S}
              stroke="rgba(120,150,190,0.16)" strokeWidth={9} strokeLinecap="round" />
          ))}

          {/* building footprints */}
          {hulls.map((h) => (
            <g key={h.id}>
              <rect x={h.x} y={h.y} width={h.w} height={h.h} rx={16}
                fill={h.danger ? 'url(#hatch)' : 'rgba(62,165,255,0.05)'}
                stroke={h.danger ? 'rgba(255,77,94,0.5)' : 'rgba(110,170,255,0.22)'} strokeWidth={2} />
              {view.k >= 1.3 && <text x={h.x + 8} y={h.y + h.h - 7} className="bldg-label" fontSize={px(8.5)}>{h.name}</text>}
            </g>
          ))}

          {/* danger outside the safe zone, current boundary, and next-zone preview */}
          {show.zone && safeZone.now && (
            <>
              <path d={`M -60 -60 H ${S + 60} V ${S + 60} H -60 Z ${safeZone.now}`} fillRule="evenodd" fill="url(#hatch)" />
              <path d={safeZone.now} fill="none" stroke="#3ef0ff" strokeWidth={3} filter="url(#glow)" />
            </>
          )}
          {show.zone && safeZone.next && (
            <path d={safeZone.next} fill="none" stroke="#ff8a3d" strokeWidth={3} strokeDasharray="12 8" className="zone-next" />
          )}

          {/* paths */}
          {map.edges.map(([a, b]) => {
            if (!byId[a] || !byId[b]) return null;
            const onRoute = routeEdges.has(`${a}|${b}`);
            const direct = reachable && myLoc && ((a === myLoc && reachable.has(b)) || (b === myLoc && reachable.has(a)));
            return (
              <line key={`${a}-${b}`} x1={byId[a].x * S} y1={byId[a].y * S} x2={byId[b].x * S} y2={byId[b].y * S}
                stroke={onRoute ? '#3ef0ff' : direct ? 'rgba(62,240,255,0.45)' : 'rgba(110,170,255,0.25)'}
                strokeWidth={onRoute ? 5 : 2} strokeDasharray={onRoute ? '10 6' : '5 7'} className={onRoute ? 'route-flow' : undefined} />
            );
          })}

          {/* locations */}
          {locs.map((l) => {
            const danger = l.collapse <= zoneStage;
            const warn = !danger && zoneWarning && l.collapse === zoneStage + 1;
            const r = radiusOf(l);
            const reach = reachable?.has(l.id);
            const x = l.x * S; const y = l.y * S;
            const fill = !l.enabled ? '#334' : danger ? '#ff4d5e' : l.id === 'tr14' ? '#ffc23d' : warn ? '#ff8a3d'
              : l.tags.includes('market') || l.tags.includes('healing') ? '#5dff9e' : l.tags.includes('airdrop') ? '#b07cff'
              : majorKinds.has(l.kind) ? '#3ea5ff' : '#8fc3ff';
            const shape = l.kind === 'gate' ? 'hex' : l.kind === 'sports' ? 'tri' : l.kind === 'amenity' || l.kind === 'hub' ? 'diamond' : l.kind === 'building' ? 'square' : 'circle';
            return (
              <g key={l.id} style={{ cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => { if (!dragged.current) onSelect?.(l.id); }}>
                {l.id === myLoc && <circle cx={x} cy={y} r={46 * rs} fill="url(#radar)" className="radar" />}
                {warn && <circle cx={x} cy={y} r={r + 7} fill="none" stroke="#ff8a3d" strokeWidth={2.5} className="danger-blink" />}
                {reach && <circle cx={x} cy={y} r={r + 6} fill="none" stroke="#3ef0ff" strokeWidth={2.2} strokeDasharray="4 4" />}
                {selected === l.id && <circle cx={x} cy={y} r={r + 11} fill="none" stroke="#fff" strokeWidth={2.5} />}
                <Marker shape={shape} x={x} y={y} r={r} fill={fill} dim={!l.enabled} />
                {l.kind === 'gate' && <text x={x} y={y + 4 * rs} textAnchor="middle" fontSize={11 * rs} fontWeight={800} fill="#04101f">G</text>}
                {l.id === 'tr14' && <text x={x} y={y + 4 * rs} textAnchor="middle" fontSize={11 * rs} fontWeight={800} fill="#1a1200">14</text>}
                <circle cx={x} cy={y} r={Math.max(22, r + 10)} fill="transparent" />
              </g>
            );
          })}

          {/* labels (placed without overlaps) */}
          {labelsOut.map((lb) => (
            <text key={`lb-${lb.id}`} x={lb.x} y={lb.y} className={`node-label ${lb.strong ? 'strong' : ''}`} fontSize={lb.fs}
              style={{ pointerEvents: 'none' }}>{lb.text}</text>
          ))}

          {/* airdrops */}
          {show.drops && airdrops.map((a) => byId[a.location] && (
            <g key={`ad-${a.location}-${a.tier}`} transform={`translate(${byId[a.location].x * S + 18 * rs} ${byId[a.location].y * S - 24 * rs}) scale(${rs})`}>
              <g className="drop-in">
                <circle r={14} fill="none" stroke={TIER_COLOR[a.tier] || '#fff'} strokeWidth={3} className="pulse-ring" />
                <path d="M -12 -4 Q 0 -20 12 -4 Z" fill={TIER_COLOR[a.tier] || '#fff'} />
                <line x1={-10} y1={-4} x2={-4} y2={6} stroke="#cfe2ff" strokeWidth={1.5} /><line x1={10} y1={-4} x2={4} y2={6} stroke="#cfe2ff" strokeWidth={1.5} />
                <rect x={-6} y={5} width={12} height={10} rx={2} fill="#8b6b3d" stroke="#ffd58a" strokeWidth={1.5} />
              </g>
            </g>
          ))}

          {/* battles */}
          {show.squads && battles.map((b, i) => byId[b.location] && (
            <g key={`bt${i}`} transform={`translate(${byId[b.location].x * S} ${byId[b.location].y * S}) scale(${rs})`}>
              <circle r={24} fill="none" stroke="#ff4d5e" strokeWidth={4} className="pulse-ring" />
              <path d="M -9 -36 L 9 -20 M 9 -36 L -9 -20" stroke="#ff4d5e" strokeWidth={4} strokeLinecap="round" />
            </g>
          ))}

          {/* squads */}
          {show.squads && markers.map((m, i) => m.kind === 'cluster' ? (
            <g key={`cl${i}`} transform={`translate(${m.x} ${m.y}) scale(${rs})`}>
              <rect x={-19} y={-13} width={38} height={26} rx={13} fill={m.battle ? '#ff4d5e' : '#cfe2ff'} stroke="#050912" strokeWidth={3} />
              <text y={6} textAnchor="middle" fontSize={15} fontWeight={800} fill="#04101f" fontFamily="Rajdhani, sans-serif">×{m.n}</text>
            </g>
          ) : (
            <g key={`sq${m.s.number}`} transform={`translate(${m.x} ${m.y}) scale(${rs})`}>
              {m.s.me && <circle r={22} fill="none" stroke="#ffc23d" strokeWidth={3} className="pulse-ring" />}
              <rect x={-17} y={-13} width={34} height={26} rx={6}
                fill={m.s.me ? '#ffc23d' : m.s.allied ? '#5dff9e' : m.s.in_battle ? '#ff4d5e' : '#e6f0ff'}
                stroke="#050912" strokeWidth={3} opacity={m.s.travelling ? 0.9 : 1} />
              <text y={6} textAnchor="middle" fontSize={16} fontWeight={800} fill="#04101f" fontFamily="Rajdhani, sans-serif">{m.s.number}</text>
            </g>
          ))}
        </g>
      </svg>
      <div className="map-legend" aria-hidden>
        <span className="chip"><span className="dot" style={{ background: '#ffc23d' }} />You · TR14</span>
        {zoneStage > 0 && <span className="chip"><span className="dot" style={{ background: '#3ef0ff' }} />Safe zone</span>}
        {zoneWarning && <span className="chip warn"><span className="dot" style={{ background: '#ff8a3d' }} />Next zone</span>}
        {zoneStage > 0 && <span className="chip bad"><span className="dot" style={{ background: '#ff4d5e' }} />Danger</span>}
        {plan && <span className="chip" style={{ borderColor: 'var(--cyan)' }}>Route {plan.seconds}s · {plan.path.length - 1} hop{plan.path.length > 2 ? 's' : ''}</span>}
      </div>
    </div>
  );
}

function Marker({ shape, x, y, r, fill, dim }: { shape: string; x: number; y: number; r: number; fill: string; dim: boolean }) {
  const common = { fill, stroke: '#050912', strokeWidth: 2.5, opacity: dim ? 0.45 : 1 };
  if (shape === 'square') return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={r * 0.35} {...common} />;
  if (shape === 'diamond') return <path d={`M ${x} ${y - r * 1.25} L ${x + r * 1.25} ${y} L ${x} ${y + r * 1.25} L ${x - r * 1.25} ${y} Z`} {...common} />;
  if (shape === 'tri') return <path d={`M ${x} ${y - r * 1.2} L ${x + r * 1.1} ${y + r * 0.85} L ${x - r * 1.1} ${y + r * 0.85} Z`} {...common} />;
  if (shape === 'hex') {
    const pts = Array.from({ length: 6 }, (_, i) => `${x + r * 1.1 * Math.cos((Math.PI / 3) * i)},${y + r * 1.1 * Math.sin((Math.PI / 3) * i)}`).join(' ');
    return <polygon points={pts} {...common} />;
  }
  return <circle cx={x} cy={y} r={r} {...common} />;
}
