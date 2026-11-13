// In-game battle screen: full-screen 3D campus + Free Fire-style HUD.
// Movement: the captain drives the squad buggy with a floating joystick (client-side prediction,
// server-capped speed via captain_steer, velocity broadcast to teammates for lag-free motion) or
// taps a place to auto-run there (captain_move). Buildings have floors: climb at the stairwell.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { friendly, rpc, store } from '../lib/api';
import { feedText, floorLabel, floorName, locName, MapData, MATCH_PHASES, ROLES, ROLE_ORDER, Role, TIER_COLOR } from '../lib/game';
import { POLL_EXTRAPOLATE, predict, Shot, useRivals, useShots, useSquadLink } from '../lib/motion';
import { inBuilding, walkBlocked } from '../lib/walls';
import { zoneNow } from '../lib/zone';
import { ROADS, LOTS } from '../../content/campus.mjs';
import { msUntil, serverTime, useNow } from '../lib/time';
import { buzz, sfx } from '../lib/sound';
import { Countdown, HpBar, Sheet, toast } from '../components/ui';
import CampusMap, { SHORT } from '../components/CampusMap';
import BigMap, { METERS } from './BigMap';
import type { WorldScene, WorldState } from '../three/world';

const World3D = lazy(() => import('../three/World3D'));

type XY = [number, number];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (v: number) => Math.max(0.02, Math.min(0.98, v));

let webglOk: boolean | null = null;
function hasWebGL() {
  if (webglOk !== null) return webglOk;
  try {
    const c = document.createElement('canvas');
    webglOk = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { webglOk = false; }
  return webglOk;
}

/** Position of the own squad right now, interpolating an auto-run by server time. */
function travelPos(s: any, map: MapData | null): XY | null {
  const t = s.team;
  if (t.state === 'traveling' && t.travel_to && t.travel_arrive_at && map) {
    const to = map.locations.find((l) => l.id === t.travel_to);
    const from: XY | null = t.travel_from_xy || (t.pos as XY) || null;
    if (to && from) {
      const a = new Date(t.travel_started_at).getTime(); const b = new Date(t.travel_arrive_at).getTime();
      const p = Math.max(0, Math.min(1, (serverTime() - a) / Math.max(1, b - a)));
      return [from[0] + (to.x - from[0]) * p, from[1] + (to.y - from[1]) * p];
    }
  }
  return (t.pos as XY) || null;
}

function locAt(map: MapData | null, p: XY | null, r: number, level = 0, bldg: string | null = null) {
  if (!map || !p) return null;
  let best: any = null; let bd = r;
  for (const l of map.locations) {
    if (l.kind === 'start' || !l.enabled) continue;
    if ((l.level || 0) !== level || (level > 0 && l.building !== bldg)) continue;
    const d = Math.hypot(l.x - p[0], l.y - p[1]);
    if (d <= bd) { bd = d; best = l; }
  }
  return best;
}

// ── Floating joystick (Free Fire style): touch anywhere in the left zone ────────────
function Joystick({ onMove, disabled }: { onMove: (x: number, y: number) => void; disabled?: boolean }) {
  const zone = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<{ x: number; y: number } | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const id = useRef<number | null>(null);
  const R = 52;
  function move(e: React.PointerEvent, b = base) {
    if (!b) return;
    let dx = e.clientX - b.x; let dy = e.clientY - b.y;
    const m = Math.hypot(dx, dy);
    if (m > R) { dx = (dx / m) * R; dy = (dy / m) * R; }
    setKnob({ x: dx, y: dy });
    const mag = Math.min(1, m / R);
    onMove(mag < 0.15 ? 0 : (dx / R), mag < 0.15 ? 0 : (dy / R));
  }
  function end() {
    id.current = null; setBase(null); setKnob({ x: 0, y: 0 }); onMove(0, 0);
  }
  return (
    <div ref={zone} className={`joy-zone ${disabled ? 'off' : ''}`}
      onPointerDown={(e) => {
        if (disabled || id.current !== null) return;
        id.current = e.pointerId;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const b = { x: e.clientX, y: e.clientY };
        setBase(b); buzz(8); move(e, b);
      }}
      onPointerMove={(e) => { if (e.pointerId === id.current) move(e); }}
      onPointerUp={(e) => { if (e.pointerId === id.current) end(); }}
      onPointerCancel={(e) => { if (e.pointerId === id.current) end(); }}
      aria-label="Movement joystick: drag to move your squad">
      <div className={`joy-base ${base ? 'live' : ''}`} style={base ? { left: base.x - (zone.current?.getBoundingClientRect().left || 0), top: base.y - (zone.current?.getBoundingClientRect().top || 0) } : undefined}>
        <div className="joy-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>
      {!base && !disabled && <span className="joy-hint">DRAG TO MOVE</span>}
    </div>
  );
}

// ── First-game walkthrough (3 tips, shown once per device) ──────────────
function Coach({ isCaptain }: { isCaptain: boolean }) {
  const KEY = 'hb_coach_v3';
  const [step, setStep] = useState(() => { try { return localStorage.getItem(KEY) ? -1 : 0; } catch { return 0; } });
  if (step < 0) return null;
  const tips = isCaptain ? [
    { at: 'bl', title: 'Move', text: 'Thumb anywhere bottom-left and drag. Tap RUN to sprint. You land on foot: run to the parking yard and tap GET IN at your numbered buggy. Buggies stop at building doors — walk inside. Drag the right side to look around.' },
    { at: 'tl', title: 'Map', text: 'Tap the minimap for the full campus. Tap a place, then Drive there.' },
    { at: 'br', title: 'Act & fight', text: 'The big button changes: OPEN BOX, CRACK a crate, SOLVE a challenge. When a rival squad is in range, hold FIRE — everyone in your squad can shoot.' },
    { at: 'tr', title: 'Lift & lockdowns', text: 'Every floor is open. Walk to the 🛗 LIFT and tap a floor number to ride up. When a building sounds its alarm, get out before the doors shut.' },
  ] : [
    { at: 'tl', title: 'Your squad', text: 'Your captain moves the squad. You watch, open the map — and hold FIRE when a rival squad comes into range.' },
    { at: 'br', title: 'Your clue', text: 'When a challenge starts, your clue opens by itself. Read it out — the captain types the answer.' },
  ];
  const t = tips[step];
  const done = () => { try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ } setStep(-1); };
  return (
    <div className="coach" onClick={() => (step + 1 < tips.length ? setStep(step + 1) : done())}>
      <div className={`coach-card at-${t.at}`} role="dialog" aria-label={t.title}>
        <b>{t.title}</b><p>{t.text}</p>
        <div className="row between"><span className="muted">{step + 1}/{tips.length}</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn xs ghost" onClick={(e) => { e.stopPropagation(); done(); }}>Skip</button>
            <button className="btn xs primary">{step + 1 < tips.length ? 'Next' : 'Play'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Icons (simple line icons, original) ─────────────────────────────────
type IconName = 'search' | 'crate' | 'target' | 'puzzle' | 'med' | 'bag' | 'plus' | 'minus' | 'map' | 'chat' | 'gear' | 'car' | 'chute' | 'run' | 'box' | 'pistol';
const ICONS: Record<IconName, string> = {
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm4.8 11.3L20 20',
  crate: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm0 0l8 4 8-4M12 12v8',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  car: 'M4 15l1.5-5h13L20 15v3H4v-3Zm2 3v2m12-2v2M7 15h.01M17 15h.01M7 10l1.5-4h7L17 10',
  chute: 'M3 11a9 7 0 0 1 18 0M3 11l9 9 9-9M8 11l4 9 4-9M12 11v9',
  run: 'M13 4a2 2 0 1 1 0 .01M9 21l3-6 3 2v5M6 12l4-4 4 2 3 3 3-1M10 8l-2 5 4 2',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5V8Zm0 0l9 5 9-5M12 13v8',
  pistol: 'M3 7h15l1-1h2v4h-3l-1 1h-4l-1 2h-1l-1 5H6l1-5H5L3 11V7Z',
  puzzle: 'M9 4h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v6h-5a2 2 0 1 0-4 0H5v-5a2 2 0 1 0 0-4V4h4Z',
  med: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6V4Z',
  bag: 'M8 7V5a4 4 0 0 1 8 0v2M5 7h14l-1 13H6L5 7Zm4 5h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6Zm6-2v14m6-12v14',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  gear: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1 7 17m10-10 2.1-2.1',
};
// filled silhouettes (Free Fire style) for the buttons people press most
const SOLID: Partial<Record<IconName, string>> = {
  med: 'M9 3.5h6v2h4.2A1.8 1.8 0 0 1 21 7.3v11.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.7V7.3a1.8 1.8 0 0 1 1.8-1.8H9v-2Zm1.6 2h2.8V5h-2.8v.5ZM10.8 9v3.1H7.7v2.6h3.1v3.1h2.4v-3.1h3.1v-2.6h-3.1V9h-2.4Z',
  bag: 'M9 2.5h6v2.2h.8A4.2 4.2 0 0 1 20 8.9V19a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19V8.9a4.2 4.2 0 0 1 4.2-4.2H9V2.5Zm1.6 2.2h2.8V4h-2.8v.7ZM7.5 12.2v6.3h9v-6.3h-9Zm2.5 1.4h4v1.6h-4v-1.6Z',
  map: 'M2.5 6.2 8.6 4l6.8 2.6 6.1-2.2v14.4l-6.1 2.2-6.8-2.6-6.1 2.2V6.2Zm7.3.3v11.2l4.4 1.7V8.2L9.8 6.5Z',
  run: 'M14.6 1.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4ZM9.6 7.3l4.6-.9 2.4 2.6 3.1-.7.5 2-4.3 1-1.4-1.5-1.5 3.6 2.9 2.6V22h-2.2v-5.1l-3.1-2.6-1.5 3.4-5.5.9-.4-2.1 4.3-.7 2.8-6.6-1.7.4-1.5 2.7-1.9-1 2-3.7Z',
  pistol: 'M2.5 7h15.2l.9-1H21v4.4h-2.6l-1 1H13l-.9 1.9h-1.3l-1.1 4.9H5.9l1.2-5.1H5.3L2.5 10.8V7Zm8.6 4.4.5-1h-2l-.2 1h1.7Z',
  gear: 'M10.3 2h3.4l.5 2.6 1.6.7 2.2-1.5 2.4 2.4-1.5 2.2.7 1.6 2.6.5v3.4l-2.6.5-.7 1.6 1.5 2.2-2.4 2.4-2.2-1.5-1.6.7-.5 2.6h-3.4l-.5-2.6-1.6-.7-2.2 1.5-2.4-2.4 1.5-2.2-.7-1.6L2 13.7v-3.4l2.6-.5.7-1.6-1.5-2.2 2.4-2.4 2.2 1.5 1.6-.7.5-2.6Zm1.7 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z',
  chat: 'M4 4h16a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 17H10l-5 4v-4H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 4Zm3 5v2h2V9H7Zm4 0v2h2V9h-2Zm4 0v2h2V9h-2Z',
  car: 'M6.2 6h11.6l2.2 5.2H21a1 1 0 0 1 1 1V17h-2a2.5 2.5 0 0 1-5 0H9a2.5 2.5 0 0 1-5 0H2v-4.8a1 1 0 0 1 1-1h1l2.2-5.2Zm1.4 2-1.4 3.2h11.6L16.4 8H7.6Z',
  box: 'M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Zm0 2.3L6.1 7.7 12 10.6l5.9-2.9L12 4.8Zm-7 4.5v6.5l6 3v-6.5l-6-3Zm14 0-6 3v6.5l6-3V9.3Z',
};
function Icon({ name }: { name: IconName }) {
  const solid = SOLID[name];
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden width="26" height="26">
      {solid ? <path d={solid} fill="currentColor" fillRule="evenodd" />
        : <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

// ── Compass strip (heading of the camera) ───────────────────────────────
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function Compass({ src, marker }: { src: { current: { yaw?: number } }; marker?: number | null }) {
  const [yaw, setYaw] = useState(src.current.yaw || 0);
  useEffect(() => {
    let raf = 0;
    const f = () => { raf = requestAnimationFrame(f); const y = src.current.yaw || 0; setYaw((p) => (Math.abs(p - y) > 0.004 ? y : p)); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [src]);
  const deg = ((yaw * 180) / Math.PI % 360 + 360) % 360;
  const ticks = [];
  for (let d = -60; d <= 60; d += 15) {
    const a = Math.round((deg + d) / 15) * 15;
    const off = a - deg;
    if (Math.abs(off) > 60) continue;
    const norm = ((a % 360) + 360) % 360;
    const lab = norm % 45 === 0 ? CARD[norm / 45] : '';
    ticks.push(<span key={a} className={`cp-t ${norm % 45 === 0 ? 'big' : ''}`} style={{ left: `${50 + (off / 60) * 50}%` }}>{lab}</span>);
  }
  let pin: React.ReactNode = null;
  if (marker != null) {
    let off = ((marker * 180) / Math.PI - deg) % 360; if (off > 180) off -= 360; if (off < -180) off += 360;
    const clamped = Math.max(-60, Math.min(60, off));
    pin = <i className={`cp-pin ${Math.abs(off) > 60 ? 'edge' : ''}`} style={{ left: `${50 + (clamped / 60) * 50}%` }} />;
  }
  return <div className="compass" aria-label={`Facing ${CARD[Math.round(deg / 45) % 8]}`}>{ticks}{pin}<i className="cp-mark" /></div>;
}

// ── Minimap ─────────────────────────────────────────────────────────────
function MiniMap({ map, me, yaw, squads, zone, red, drops, marker, onClick, overview, tag, warn, lock, level }: {
  map: MapData; me: XY | null; yaw: number; squads: any[]; zone: any; red: any; drops: any[]; marker?: XY | null; onClick: () => void; overview: boolean;
  tag?: React.ReactNode; warn?: boolean; lock: any[]; level: number;
}) {
  const cur = zone?.cur; const nxt = zone?.next;
  // the minimap is a local view: about a third of the campus around the squad
  const span = 0.36;
  const cx = me ? Math.max(span / 2, Math.min(1 - span / 2, me[0])) : 0.5; const cy = me ? Math.max(span / 2, Math.min(1 - span / 2, me[1])) : 0.5;
  const vb = `${cx - span / 2} ${cy - span / 2} ${span} ${span}`;
  const k = span / 1.04; // stroke / marker scale vs the full map
  return (
    <button className="minimap" onClick={onClick} aria-label={overview ? 'Back to squad view' : 'Show whole campus'}>
      <svg viewBox={vb} aria-hidden>
        <defs>
          <mask id="mm-safe"><rect x="-1" y="-1" width="3" height="3" fill="white" />{cur && <circle cx={cur[0]} cy={cur[1]} r={cur[2]} fill="black" />}</mask>
        </defs>
        <rect x="-1" y="-1" width="3" height="3" fill="#4f7f3c" />
        {ROADS.map((r: any, i: number) => <polyline key={i} points={r.pts.map((p: number[]) => p.join(',')).join(' ')} fill="none" stroke="#9aa0a6" strokeWidth={r.w} strokeLinejoin="round" />)}
        {LOTS.map((l: any) => <rect key={l.id} x={l.x0} y={l.y0} width={l.x1 - l.x0} height={l.y1 - l.y0} fill="#5d636b" />)}
        {(map.buildings || []).map((b) => {
          const st = lock.filter((l) => l.b === b.id);
          const sealed = st.some((l) => l.l === null && l.sealed); const alarm = st.some((l) => !l.sealed);
          return <rect key={b.id} x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} rx="0.004"
            fill={sealed ? '#3a3e45' : '#e2ddd0'} stroke={alarm ? '#ff2238' : 'none'} strokeWidth={0.006 * k * 3} />;
        })}
        {map.locations.filter((l) => l.kind !== 'start' && (l.level || 0) === level && (level === 0 || l.building === squads.find((x) => x.me)?.bldg) && l.kind !== 'room').map((l) => (
          <circle key={l.id} cx={l.x} cy={Math.min(0.99, l.y)} r={0.006} fill={l.kind === 'stairs' ? '#5dff9e' : '#3d5878'} />
        ))}
        {cur && cur[2] < 0.86 && <rect x="-1" y="-1" width="3" height="3" fill="#2a6bff" opacity="0.35" mask="url(#mm-safe)" />}
        {nxt && <circle cx={nxt[0]} cy={nxt[1]} r={nxt[2]} fill="none" stroke="#fff" strokeWidth={0.004} />}
        {red && <circle cx={red.x} cy={red.y} r={red.r} fill="#ff2238" opacity="0.45" />}
        {drops.map((d: any) => { const l = map.locations.find((x) => x.id === d.location); return l ? <rect key={d.id} x={l.x - 0.008} y={l.y - 0.008} width="0.016" height="0.016" fill={TIER_COLOR[d.tier] || '#ffc23d'} /> : null; })}
        {squads.filter((x) => x.pos && !x.me).map((x) => <circle key={x.id} cx={x.pos[0]} cy={x.pos[1]} r="0.008" fill={x.allied ? '#5dff9e' : '#ff4d5e'} stroke="#fff" strokeWidth="0.002" />)}
        {marker && <circle cx={marker[0]} cy={marker[1]} r="0.009" fill="#ffd23d" stroke="#1b2430" strokeWidth="0.003" />}
        {me && <path d={`M ${me[0]} ${me[1]} L ${me[0] + Math.sin(yaw - 0.5) * 0.06} ${me[1] - Math.cos(yaw - 0.5) * 0.06} A 0.06 0.06 0 0 1 ${me[0] + Math.sin(yaw + 0.5) * 0.06} ${me[1] - Math.cos(yaw + 0.5) * 0.06} Z`} fill="#ffffff" opacity="0.22" />}
        {me && <path d={`M ${me[0] + Math.sin(yaw) * 0.016} ${me[1] - Math.cos(yaw) * 0.016} L ${me[0] + Math.sin(yaw + 2.5) * 0.011} ${me[1] - Math.cos(yaw + 2.5) * 0.011} L ${me[0] + Math.sin(yaw - 2.5) * 0.011} ${me[1] - Math.cos(yaw - 2.5) * 0.011} Z`} fill="#3ef0ff" stroke="#fff" strokeWidth="0.002" />}
      </svg>
      <span className={`mm-tag ${warn ? 'warn' : ''}`}>{tag ?? (overview ? 'SQUAD VIEW' : 'MAP')}</span>
    </button>
  );
}

// ── Kill feed ──────────────────────────────────────────────────────────
// Free Fire-style squad list: numbered teammates with their role, and who is online, reconnecting
// or covered by the bot. Tapping it opens squad chat.
const MATE_COLORS = ['#ffd23d', '#3ef0ff', '#b07cff', '#5dff9e'];
function SquadStrip({ s }: { s: any }) {
  const list: any[] = s.squad || (s.roster || []).map((r: any) => ({ ...r, status: r.online ? 'on' : 'weak' }));
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const f = (e: Event) => setUnread((e as CustomEvent).detail || 0);
    window.addEventListener('hb:unread', f);
    return () => window.removeEventListener('hb:unread', f);
  }, []);
  // tell the squad when someone drops or comes back
  const prev = useRef<Record<string, string>>({});
  useEffect(() => {
    const p = prev.current; const next: Record<string, string> = {};
    for (const m of list) {
      next[m.name] = m.status;
      if (m.me || !p[m.name] || p[m.name] === m.status) continue;
      if (m.status === 'away') { toast(`🤖 ${m.name} is offline — a bot covers ${m.role ? ROLES[m.role as Role].name : 'their role'}`, 'warn'); buzz([30, 40, 30]); }
      else if (m.status === 'weak' && p[m.name] === 'on') toast(`📶 ${m.name} is reconnecting…`, 'info');
      else if (m.status === 'on' && p[m.name] === 'away') { toast(`✅ ${m.name} is back`, 'good'); }
    }
    prev.current = next;
  }, [list.map((m) => m.name + m.status).join()]);
  return (
    <button className="ff-squad" onClick={() => window.dispatchEvent(new Event('hb:chat'))} aria-label={`Your squad${unread ? `, ${unread} new messages` : ''} — open squad chat`}>
      {list.map((m, i) => {
        const r = m.role as Role | null;
        return (
          <span key={i} className={`ff-mate ${m.status} ${m.me ? 'me' : ''}`}>
            <i className="ff-num" style={{ background: MATE_COLORS[i % 4] }}>{i + 1}</i>
            <span className="ff-name">{m.me ? 'You' : m.name}</span>
            {r && <span className="ff-role" style={{ color: ROLES[r].color }} title={ROLES[r].name}>{ROLES[r].icon}{m.role2 ? <em style={{ color: ROLES[m.role2 as Role].color }}>{ROLES[m.role2 as Role].icon}</em> : null}</span>}
            {m.status === 'away' ? <b className="ff-tag bot">BOT</b> : m.status === 'weak' ? <b className="ff-tag weak" aria-label="weak connection">📶</b> : null}
          </span>
        );
      })}
      <span className="ff-chat">💬 Squad chat{unread > 0 && <em>{unread}</em>}</span>
    </button>
  );
}

function KillFeed({ feed, map }: { feed: any[]; map: MapData | null }) {
  useNow(1000);
  const now = serverTime();
  const items = (feed || []).filter((f) => now - new Date(f.at).getTime() < 6000).slice(0, 2);
  return (
    <div className="killfeed" aria-live="polite">
      {items.map((f, i) => {
        const t = feedText(f.type, f.payload, map);
        return t ? <div key={`${i}-${f.at}-${f.type}`} className={`kf ${t.tone}`}>{t.text}</div> : null;
      })}
    </div>
  );
}

type Live = { x: number; y: number; moving: boolean; joy?: boolean; jx?: number; yaw?: number; level?: number; bldg?: string | null; vx?: number; vy?: number };

/** a clear line of fire outdoors: no building between the two squads */
function clearShot(map: MapData | null, a: XY, b: XY) {
  for (const B of map?.buildings || []) {
    const near = (p: XY) => p[0] > B.x0 - 0.002 && p[0] < B.x1 + 0.002 && p[1] > B.y0 - 0.002 && p[1] < B.y1 + 0.002;
    if (near(a) || near(b)) continue;
    for (let k = 1; k < 16; k++) { const x = a[0] + (b[0] - a[0]) * k / 16; const y = a[1] + (b[1] - a[1]) * k / 16; if (x > B.x0 && x < B.x1 && y > B.y0 && y < B.y1) return false; }
  }
  return true;
}

export default function WorldTab({ s, token, map, refresh, openMission, openSquad, openComms, unread, onSettings, connected, spectating }: {
  s: any; token: string; map: MapData | null; refresh: () => void; openMission: () => void; openSquad: () => void; openComms: () => void; unread: number; onSettings: () => void; connected: boolean;
  /** demo mode: a dummy captain drives this squad, so this screen only watches */
  spectating?: boolean;
}) {
  useNow(500);
  const isCaptain = s.me.role === 'captain' && !spectating;
  const world = s.arena.overlay?.world || { speed: 0.016, loc_radius: 0.018, engage_range: 0.04 };
  const zoneRaw = s.arena.overlay?.zone;
  const zn = zoneNow(zoneRaw, serverTime());
  // what the maps draw: the circle right now (moving while the wall closes in) and the white target circle
  const zone = zoneRaw ? { ...zoneRaw, cur: zn.cur, next: zn.next } : zoneRaw;
  const red = s.arena.overlay?.red && msUntil(s.arena.overlay.red.at) > -2000 ? s.arena.overlay.red : null;
  const lock: any[] = s.arena.overlay?.lock || [];
  const buildings = map?.buildings || [];
  const level: number = s.team.level || 0;
  const bldg: string | null = s.team.bldg || null;
  const inAir = !!s.team.jump_at && s.team.dropped === false;
  const canMove = isCaptain && s.arena.phase === 'play' && !s.arena.paused && s.team.state !== 'recovery' && !s.battle && (s.team.dropped !== false || inAir);
  // walk or run on foot (the server allows up to the running speed)
  const [running, setRunning] = useState(() => store.get('hb_run') !== '0');
  const runRef = useRef(running); runRef.current = running;
  const airRef = useRef(inAir); airRef.current = inAir;
  // on foot or in the buggy (older servers: always the buggy)
  const vehRef = useRef<string>(s.team.vehicle || 'in');
  useEffect(() => { vehRef.current = s.team.vehicle || 'in'; }, [s.team.vehicle]);
  const onFoot = (s.team.vehicle || 'in') !== 'in';
  const inPlane = !!s.team.in_plane && s.arena.phase === 'play';
  const chute = !!s.team.parachute;
  const plane = s.arena.overlay?.plane || null;
  const weapon = s.team.weapon || { id: 'pistol', name: 'Pistol', range: 0.055, rate: 650, mag: 12, reload: 1600 };
  const sceneRef = useRef<WorldScene | null>(null);
  const [zoom] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);
  const [marker, setMarker] = useState<XY | null>(null);
  const [engage, setEngage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [climbing, setClimbing] = useState<string | null>(null);
  const link = useSquadLink(s.team.id, isCaptain);
  const rivals = useRivals(token, s.arena.phase === 'play', s.me.role === 'captain');

  // ── own position: prediction while steering (captain), the captain's live feed (teammates), server truth otherwise ──
  const serverPos = travelPos(s, map);
  const me = useRef<Live>({ x: serverPos?.[0] ?? 0.47, y: serverPos?.[1] ?? 0.93, moving: false, yaw: 0, level, bldg });
  const vec = useRef({ x: 0, y: 0 });
  // laptop controls (online players): WASD / arrows move, R walk/run, Space or E = the big button, hold F = fire
  const keys = useRef(new Set<string>());
  const primaryRef = useRef<null | { onClick: () => void; disabled?: boolean }>(null);
  const fireKeys = useRef<{ start: () => void; stop: () => void; run: () => void }>({ start: () => {}, stop: () => {}, run: () => {} });
  useEffect(() => {
    const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
    const apply = () => {
      const k = keys.current;
      const x = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      const y = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
      const m = Math.hypot(x, y) || 1;
      vec.current = { x: x / m, y: y / m };
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.current.add(k); apply(); e.preventDefault(); }
      else if ((k === ' ' || k === 'e') && !e.repeat) { const p = primaryRef.current; if (p && !p.disabled) { buzz(15); p.onClick(); } e.preventDefault(); }
      else if (k === 'f' && !e.repeat) fireKeys.current.start();
      else if (k === 'r' && !e.repeat) fireKeys.current.run();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (keys.current.delete(k)) apply();
      if (k === 'f') fireKeys.current.stop();
    };
    const blur = () => { keys.current.clear(); vec.current = { x: 0, y: 0 }; fireKeys.current.stop(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  const steering = useRef(false);
  const lastSend = useRef(0);
  const inflight = useRef(false);
  const lastLoc = useRef<string | null>(s.team.location);
  const wallToast = useRef(0);
  if (import.meta.env.DEV) (window as any).__hbMe = me.current; // play-test hook (dev builds only)
  const [, tick] = useState(0);

  useEffect(() => {
    me.current.level = level; me.current.bldg = bldg;
    if (steering.current || !serverPos) return;
    if (s.team.state === 'traveling') return; // the loop interpolates
    const d = Math.hypot(me.current.x - serverPos[0], me.current.y - serverPos[1]);
    // teammates follow the captain's live feed; only a big disagreement snaps them to the server
    if (isCaptain ? d > 0.002 : d > 0.06) { me.current.x = serverPos[0]; me.current.y = serverPos[1]; }
  }, [serverPos?.[0], serverPos?.[1], s.team.state, level, bldg]);

  const sealedAt = (x: number, y: number) => buildings.find((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && lock.some((l) => l.b === b.id && l.l === null && l.sealed));

  async function sendSteer(final = false) {
    if (inflight.current) return;
    inflight.current = true;
    lastSend.current = performance.now();
    try {
      const r = await rpc('captain_steer', { p_token: token, p_x: me.current.x, p_y: me.current.y, p_vx: final ? 0 : me.current.vx || 0, p_vy: final ? 0 : me.current.vy || 0 });
      if (r.clamped) { me.current.x = r.x; me.current.y = r.y; }
      if (r.wall && performance.now() - wallToast.current > 4000) { wallToast.current = performance.now(); toast('Sealed by a lockdown — drive around it', 'bad'); }
      if (r.parked) { vehRef.current = 'parked'; sfx.tap(); buzz(30); toast('Buggy parked — you are on foot. Walk in through the front door.', 'info'); refresh(); }
      if (r.vehicle) vehRef.current = r.vehicle;
      if (r.picked?.length) {
        sfx.pickup(); buzz(25);
        for (const k of r.picked) toast(k === 'medkit' ? '+1 Med kit' : k === 'shield' ? '+20 Shield' : '+15 coins', 'good');
      }
      if (r.location !== lastLoc.current || r.picked) {
        if (r.location !== lastLoc.current && r.location) { sfx.gate(); buzz(20); }
        lastLoc.current = r.location;
        refresh();
      } else if (final) refresh();
    } catch (e) {
      const m = friendly(e);
      if (!/moving too fast/i.test(m)) toast(m, 'bad');
      steering.current = false; vec.current = { x: 0, y: 0 };
      refresh();
    } finally { inflight.current = false; }
  }

  // movement loop (RAF)
  useEffect(() => {
    let raf = 0; let last = performance.now();
    const B = buildings.find((b) => b.id === bldg);
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      const L = me.current;
      if (s.team.in_plane && plane && !airRef.current) {
        const a = new Date(plane.t0).getTime(); const b = new Date(plane.t1).getTime(); const p = Math.max(0, Math.min(1, (serverTime() - a) / Math.max(1, b - a)));
        L.x = plane.a[0] + (plane.b[0] - plane.a[0]) * p; L.y = plane.a[1] + (plane.b[1] - plane.a[1]) * p; L.moving = true; L.level = 0;
        L.yaw = Math.atan2(plane.b[0] - plane.a[0], -(plane.b[1] - plane.a[1]));
        return;
      }
      if (isCaptain) {
        const v = vec.current;
        const mag = Math.hypot(v.x, v.y);
        if (mag > 0 && canMove) {
          steering.current = true;
          // the joystick is relative to where the camera looks (push up = drive forward)
          const yaw = L.yaw || 0; const c = Math.cos(yaw); const sn = Math.sin(yaw);
          const wx = c * v.x - sn * v.y; const wy = sn * v.x + c * v.y;
          const air = airRef.current;
          const foot = vehRef.current !== 'in';
          const spd = air ? (world.glide_speed || 0.018) : foot ? (world.foot_speed || 0.013) * (runRef.current ? 1 : 0.6) : world.speed;
          L.jx = v.x;
          let nx = clamp01(L.x + wx * spd * dt); let ny = clamp01(L.y + wy * spd * dt);
          if (air) { /* falling: fly over everything */ }
          else if (level > 0 && B) { nx = Math.max(B.x0 + 0.004, Math.min(B.x1 - 0.004, nx)); ny = Math.max(B.y0 + 0.004, Math.min(B.y1 - 0.004, ny)); }
          else if (sealedAt(nx, ny) && !sealedAt(L.x, L.y)) { nx = L.x; ny = L.y; }
          if (!air && !foot && level === 0 && inBuilding(map, nx, ny) && !inBuilding(map, L.x, L.y)) {
            // a buggy stops at the building: the server parks it and the captain walks on
            nx = L.x; ny = L.y;
            if (t - lastSend.current > 250) sendSteer();
          }
          if (false && foot && map && walkBlocked(map, [L.x, L.y], [nx, ny], level, bldg)) {
            // slide along the wall
            if (!walkBlocked(map, [L.x, L.y], [nx, L.y], level, bldg)) ny = L.y;
            else if (!walkBlocked(map, [L.x, L.y], [L.x, ny], level, bldg)) nx = L.x;
            else { nx = L.x; ny = L.y; }
          }
          // velocity actually achieved (smoothed): slow phones and walls never make teammates overshoot
          const ivx = (nx - L.x) / Math.max(dt, 0.001); const ivy = (ny - L.y) / Math.max(dt, 0.001);
          L.vx = (L.vx || 0) * 0.75 + ivx * 0.25; L.vy = (L.vy || 0) * 0.75 + ivy * 0.25;
          L.x = nx; L.y = ny; L.moving = true; L.joy = true;
          link.send({ x: L.x, y: L.y, vx: L.vx, vy: L.vy, l: level, h: yaw });
          if (t - lastSend.current > 500) sendSteer();
        } else {
          L.joy = false;
          if (steering.current) {
            steering.current = false; L.moving = false; L.vx = 0; L.vy = 0;
            link.send({ x: L.x, y: L.y, vx: 0, vy: 0, l: level }, true);
            setTimeout(() => sendSteer(true), 40);
          }
          const tp = travelPos(s, map);
          if (s.team.state === 'traveling' && tp) { L.x = tp[0]; L.y = tp[1]; L.moving = true; }
          else L.moving = false;
        }
      } else {
        // teammate: glide along the captain's broadcast (dead reckoning), else the server's position
        const tp = travelPos(s, map);
        const feed = link.latest.current;
        let target: { x: number; y: number } | null = null; let moving = false;
        if (s.team.state === 'traveling' && tp) { target = { x: tp[0], y: tp[1] }; moving = true; }
        else if (feed && serverTime() - feed.t < 5000) {
          target = predict(feed); moving = Math.hypot(feed.vx, feed.vy) > 1e-5 && serverTime() - feed.t < 1300;
          if (typeof feed.l === 'number') L.level = feed.l;
        } else {
          // no live feed (realtime blocked): glide along the positions poll, else the last full state
          const own = rivals.current.get(s.team.id);
          if (own && serverTime() - own.t < 9000) { target = predict(own, undefined, POLL_EXTRAPOLATE); moving = Math.hypot(own.vx, own.vy) > 1e-5; }
          else if (serverPos) target = { x: serverPos[0], y: serverPos[1] };
        }
        if (target) {
          // glide toward the prediction; a big gap (a missed stop, a respawn) closes faster
          const gap = Math.hypot(target.x - L.x, target.y - L.y);
          const kk = Math.min(1, dt * (gap > 0.02 ? 14 : 8));
          L.x += (target.x - L.x) * kk; L.y += (target.y - L.y) * kk;
        }
        L.moving = moving;
      }
    };
    raf = requestAnimationFrame(step);
    const iv = setInterval(() => tick((n) => n + 1), 300); // refresh HUD readouts and rival positions
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, [s, map, canMove, world.speed, world.foot_speed, isCaptain, level, bldg, lock.length]);

  const myLevel = me.current.level ?? level;
  const myXY: XY = [me.current.x, me.current.y];
  const here = inAir || inPlane ? null : locAt(map, myXY, world.loc_radius, level, bldg);
  const squads = s.squads || [];
  const enemiesNear = squads.filter((x: any) => x.id !== s.team.id && x.pos && dist(x.pos, myXY) <= world.engage_range && x.state !== 'recovery'
    && (x.level || 0) === level && (level === 0 || x.bldg === bldg));
  const dropsHere = (s.airdrops || []).filter((a: any) => here && a.location === here.id);

  // ── gunfights: every squad member can shoot the nearest rival in range and in sight ──
  const phaseNow = s.arena.overlay?.match?.phase ?? 0;
  const fireFrom = world.fire_from_phase ?? 1;
  const canFight = s.arena.phase === 'play' && !s.arena.paused && phaseNow >= fireFrom && s.team.dropped !== false && !inPlane && !chute
    && s.team.state !== 'recovery' && s.team.state !== 'traveling' && !!s.me.role;
  const targets = !canFight ? [] : squads.filter((x: any) => x.id !== s.team.id && !x.allied && x.state !== 'recovery' && !x.protected)
    .map((x: any) => {
      const rv = rivals.current.get(x.id);
      const fresh = rv && serverTime() - rv.t < 9000;
      if (fresh && (rv!.q?.plane || rv!.q?.chute)) return null;
      const p = fresh ? predict(rv!, undefined, POLL_EXTRAPOLATE) : x.pos ? { x: x.pos[0], y: x.pos[1] } : null;
      const lv = fresh ? rv!.l : x.level || 0; const bd = fresh ? rv!.b : x.bldg;
      if (!p || lv !== level || (level > 0 && bd !== bldg)) return null;
      const d = Math.hypot(p.x - myXY[0], p.y - myXY[1]);
      if (d > weapon.range || (level === 0 && !clearShot(map, myXY, [p.x, p.y]))) return null;
      return { id: x.id, number: x.number, d, hp: fresh ? rv!.q?.hp : x.hp };
    }).filter(Boolean).sort((a: any, b: any) => a.d - b.d) as { id: string; number: number; d: number; hp?: number }[];
  const target = targets[0] || null;
  const [ammo, setAmmo] = useState<number | null>(null);
  const [reloadAt, setReloadAt] = useState(0);
  const [hitFx, setHitFx] = useState<{ t: number; crit?: boolean; dmg?: number; ko?: boolean } | null>(null);
  const [hurt, setHurt] = useState<{ t: number; ang: number } | null>(null);
  const firing = useRef(false);
  const fireBusy = useRef(false);
  const targetRef = useRef(target); targetRef.current = target;
  const sendShot = useShots(s.arena.id, (sh: Shot) => {
    sceneRef.current?.shot(sh.a, sh.b, sh.hit);
    if (sh.b === s.team.number && sh.hit) {
      // hit from a direction: show it on the screen edge
      const from = squads.find((x: any) => x.number === sh.a);
      const rv = from ? rivals.current.get(from.id) : null;
      const fp = rv ? [rv.x, rv.y] : from?.pos;
      const ang = fp ? Math.atan2(fp[0] - me.current.x, -(fp[1] - me.current.y)) - (me.current.yaw || 0) : 0;
      setHurt({ t: performance.now(), ang }); sfx.damage(); buzz(sh.crit ? [60, 40, 60] : 40);
      if (sh.ko) { toast(`Squad ${sh.a} knocked your squad out!`, 'bad'); refresh(); }
    }
  });
  async function fireOnce() {
    const tg = targetRef.current;
    if (!tg || fireBusy.current) return;
    if (reloadAt > performance.now()) return;
    fireBusy.current = true;
    try {
      const r = await rpc<any>('squad_fire', { p_token: token, p_target: tg.id });
      sfx.weapon(); buzz(10);
      sendShot({ a: s.team.number, b: tg.number, hit: r.hit, crit: r.crit, dmg: r.dmg, ko: r.knocked, w: r.weapon?.id });
      setAmmo(r.mag);
      if (r.reload_until) { setReloadAt(performance.now() + Math.max(300, msUntil(r.reload_until))); sfx.tap(); }
      if (r.hit) setHitFx({ t: performance.now(), crit: r.crit, dmg: r.dmg, ko: r.knocked });
      if (r.knocked) { sfx.success(); buzz([80, 40, 120]); toast(`You knocked out Squad ${tg.number}! +points and loot`, 'good'); refresh(); }
    } catch (e: any) {
      const code = e?.code || '';
      if (!['TOO_FAST', 'RELOADING'].includes(code)) { firing.current = false; toast(friendly(e), 'bad'); }
    } finally { fireBusy.current = false; }
  }
  function startFire() {
    if (firing.current) return;
    firing.current = true;
    const loop = () => { if (!firing.current) return; fireOnce(); setTimeout(loop, (weapon.rate || 650) + 40); };
    loop();
  }
  const stopFire = () => { firing.current = false; };
  useEffect(() => () => { firing.current = false; }, []);
  useEffect(() => { if (!target) firing.current = false; }, [target?.id]);
  const reloading = reloadAt > performance.now();
  const ammoLeft = ammo ?? s.me.mag ?? weapon.mag;

  // ── the plane and the jump ──
  const overCampus = inPlane && me.current.x > 0.03 && me.current.x < 0.97 && me.current.y > 0.03 && me.current.y < 0.97;
  const glide = world.glide_range || 0.3;
  const planeLeaves = plane ? new Date(plane.t0).getTime() + (new Date(plane.t1).getTime() - new Date(plane.t0).getTime()) * 0.8 : 0;
  // ── the buggy ──
  const buggy: XY | null = s.team.buggy || null;
  const buggyDist = buggy ? Math.hypot(buggy[0] - myXY[0], buggy[1] - myXY[1]) : 1;
  const nearBuggy = onFoot && level === 0 && buggyDist < 0.008;
  const duelPhase = s.arena.overlay?.match?.duel_phase ?? 2;
  const duelsLocked = (s.arena.overlay?.match?.phase ?? 99) < duelPhase;
  const cooldown = s.team.attack_cooldown_until && msUntil(s.team.attack_cooldown_until) > 0;
  const searchesLeft = (s.team.visit_limit ?? 2) - (s.team.visit_missions ?? 0);
  const cur = zone?.cur as number[] | undefined;
  const outside = cur && cur[2] < 0.86 && Math.hypot(myXY[0] - cur[0], myXY[1] - cur[1]) > cur[2];
  const inRed = red && Math.hypot(myXY[0] - red.x, myXY[1] - red.y) <= red.r;
  const zoneArrow = outside && cur ? Math.atan2(cur[0] - myXY[0], -(cur[1] - myXY[1])) - (me.current.yaw || 0) : 0;
  const alive = squads.filter((x: any) => x.state !== 'recovery').length;
  const phase = s.arena.overlay?.match?.phase ?? 0;

  // building / floor I am in, stairs within reach, lockdowns
  const inB = inAir || inPlane ? undefined : level > 0 ? buildings.find((b) => b.id === bldg) : buildings.find((b) => myXY[0] > b.x0 && myXY[0] < b.x1 && myXY[1] > b.y0 && myXY[1] < b.y1);
  const stairsB = inAir || inPlane ? undefined : buildings.find((b) => b.floors > 1 && (level === 0 || b.id === bldg) && Math.hypot(b.stairs[0] - myXY[0], b.stairs[1] - myXY[1]) < 0.016);
  const pendingLocks = lock.filter((l) => !l.sealed && msUntil(l.at) > -2000);
  const myLock = inB ? pendingLocks.find((l) => l.b === inB.id && (l.l === null || l.l === level)) : null;
  const nextLock = pendingLocks.sort((a, b) => msUntil(a.at) - msUntil(b.at))[0];
  const sirenFor = useRef<string | null>(null);
  useEffect(() => {
    if (myLock && sirenFor.current !== myLock.id) { sirenFor.current = myLock.id; sfx.siren(); buzz([200, 120, 200, 120, 200]); }
  }, [myLock?.id]);
  const sealedSeen = useRef(new Set<string>(lock.filter((l) => l.sealed).map((l) => l.id)));
  useEffect(() => {
    for (const l of lock) if (l.sealed && !sealedSeen.current.has(l.id)) { sealedSeen.current.add(l.id); sfx.slam(); }
  }, [lock.map((l) => `${l.id}${l.sealed}`).join()]);

  // 3D state: own squad from the prediction above; rivals from the positions feed (dead-reckoned in the scene)
  const now = serverTime();
  const state: WorldState = useMemo(() => ({
    squads: squads.filter((x: any) => x.pos).map((x: any) => {
      const mine = x.id === s.team.id;
      const rv = rivals.current.get(x.id);
      const fresh = rv && now - rv.t < 5000;
      return {
        key: x.id, number: x.number, me: mine, ally: x.allied, inBattle: x.in_battle, down: x.state === 'recovery', moving: x.traveling,
        x: mine ? me.current.x : fresh ? rv!.x : x.pos[0], y: mine ? me.current.y : fresh ? rv!.y : x.pos[1],
        vx: mine ? 0 : fresh ? rv!.vx : x.vel?.[0] || 0, vy: mine ? 0 : fresh ? rv!.vy : x.vel?.[1] || 0,
        at: mine ? now : fresh ? rv!.t : new Date(s.server_now).getTime(),
        level: mine ? myLevel : fresh ? rv!.l : x.level || 0, bldg: mine ? bldg : fresh ? rv!.b : x.bldg,
        label: mine ? `SQ ${x.number} · YOU` : `SQ ${x.number}`,
        ...(mine
          ? { foot: onFoot || chute, buggy: s.team.buggy || null, chute, landAt: chute && s.team.land_at ? new Date(s.team.land_at).getTime() : undefined,
              jumpAt: s.team.jump_at ? new Date(s.team.jump_at).getTime() : undefined, hidden: inPlane, hp: s.team.hp, shield: s.team.shield }
          : fresh && rv!.q
            ? { foot: (rv!.q.veh && rv!.q.veh !== 'in') || rv!.q.chute, buggy: rv!.q.buggy || null, chute: !!rv!.q.chute, landAt: rv!.q.land_at ? new Date(rv!.q.land_at).getTime() : undefined,
                jumpAt: rv!.q.jump_at ? new Date(rv!.q.jump_at).getTime() : undefined,
                hidden: !!rv!.q.plane, hp: rv!.q.hp, shield: rv!.q.shield, fight: !!rv!.q.fight }
            : {}),
      };
    }),
    zone, red, locRadius: world.loc_radius, lock,
    pickups: s.pickups || [],
    airdrops: (s.airdrops || []).map((a: any) => ({ key: a.id, location: a.location, tier: a.tier })),
    battles: [],
    focus: { x: me.current.x, y: me.current.y },
  }), [s, zone, red, world.loc_radius, lock, Math.floor(now / 300), myLevel, onFoot, chute, inPlane]);

  async function act(fn: string, args: any, ok?: string) {
    setBusy(true);
    try { const r = await rpc(fn, { p_token: token, ...args }); if (ok) toast(ok, 'good'); sfx.tap(); return r; }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); return null; }
    finally { setBusy(false); refresh(); }
  }

  async function climb(to: number) {
    if (!stairsB || to === level) return;
    setClimbing(`🛗 Lift · ${to > level ? 'up' : 'down'} to ${floorLabel(to)}…`);
    sfx.stairs(); buzz(15);
    try {
      const r = await rpc<any>('captain_lift', { p_token: token, p_level: to });
      me.current.x = r.x; me.current.y = r.y; me.current.level = r.level; me.current.bldg = r.level > 0 ? r.building : null;
      link.send({ x: r.x, y: r.y, vx: 0, vy: 0, l: r.level }, true);
      lastLoc.current = r.location;
    } catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { refresh(); setTimeout(() => setClimbing(null), 1400); }
  }

  const markerDist = marker ? Math.hypot(marker[0] - myXY[0], marker[1] - myXY[1]) : 0;
  const markerBearing = marker ? Math.atan2(marker[0] - myXY[0], -(marker[1] - myXY[1])) : null;
  const markerPlace = marker ? map?.locations.filter((l) => l.kind !== 'start' && l.enabled && (l.level || 0) === level && (level === 0 || l.building === bldg))
    .map((l) => ({ l, d: Math.hypot(l.x - marker[0], l.y - marker[1]) })).sort((a, b) => a.d - b.d)[0] : null;
  const markerLoc = markerPlace && markerPlace.d < 0.03 ? markerPlace.l : null;
  // primary context action
  let primary: { label: string; icon: IconName; sub?: string; tone: string; onClick: () => void; disabled?: boolean } | null = null;
  if (s.battle) primary = { icon: 'target', label: 'DUEL', sub: 'answer now', tone: 'danger', onClick: openMission };
  else if (s.mission) primary = { icon: 'puzzle', label: 'SOLVE', sub: s.mission.title, tone: 'primary', onClick: openMission };
  else if (s.team.state === 'recovery') primary = { icon: 'med', label: 'REVIVE', sub: 'recovery', tone: 'good', onClick: openMission };
  else if (isCaptain && dropsHere.length) primary = { icon: 'crate', label: 'CRACK', sub: dropsHere[0].tier === 'vault' ? 'VAULT' : `${dropsHere[0].tier} crate`, tone: 'gold', disabled: busy, onClick: () => act('captain_claim_airdrop', { p_airdrop: dropsHere[0].id }).then((r) => r && openMission()) };
  else if (isCaptain && inPlane && overCampus) primary = { icon: 'chute', label: 'JUMP', sub: 'now', tone: 'gold', disabled: busy,
    onClick: () => act('captain_jump', {}).then((r) => { if (r) { sfx.go(); buzz([40, 30, 80]); toast('🪂 Jumped! Steer with the joystick — the parachute opens by itself', 'good'); setMarker(null); } }) };
  else if (isCaptain && here && here.kind !== 'stairs' && s.arena.phase === 'play') primary = { icon: 'box', label: 'OPEN BOX', sub: searchesLeft > 0 ? `${searchesLeft} left` : 'area empty', tone: 'primary', disabled: busy || searchesLeft <= 0 || s.team.state !== 'idle', onClick: () => act('captain_explore', {}).then((r) => r && openMission()) };
  const medkits = s.inventory?.medkit || 0;
  const weapons = Object.entries(s.inventory || {}).filter(([k]) => ['pistol', 'smg', 'sniper'].includes(k)) as [string, number][];
  const hp = s.team.hp;

  const webgl = hasWebGL();
  const zoneWarn = !!zone?.next_at && msUntil(zone.next_at) > 0;
  async function runTo(id: string) {
    const r = await act('captain_move', { p_location: id });
    if (r) { sfx.go(); toast(`${!s.team.dropped ? '🪂 Jumped! Gliding' : onFoot ? 'Running' : 'Driving'} to ${SHORT[id] || locName(map, id)} · ${Math.round(r.seconds)}s`, 'info'); setMapOpen(false); setMarker(null); }
  }
  const auto = s.arena.overlay?.auto?.on ? s.arena.overlay.auto : null;
  // one banner, most urgent first (no stacked boxes over the view)
  const banner: { tone: string; text: React.ReactNode; arrow?: number } | null =
    s.arena.paused ? { tone: '', text: '⏸ Paused by the host' }
    : myLock ? { tone: 'bad', text: <>🚨 {floorName(myLock.n, myLock.l)} seals in <Countdown to={myLock.at} /> — GET OUT!</> }
    : outside ? { tone: 'bad', text: 'Outside the safe zone — run!', arrow: zoneArrow }
    : inRed && msUntil(red.at) > 0 ? { tone: 'bad', text: <>Red zone! Get out <Countdown to={red.at} /></> }
    : s.team.state === 'recovery' ? { tone: 'bad', text: 'Squad down — solve the recovery puzzle' }
    : red && msUntil(red.at) > 0 ? { tone: 'warn', text: <>💥 Red zone strike in <Countdown to={red.at} /></> }
    : s.arena.phase === 'finale' && auto?.at && auto.label !== 'Round ends' && msUntil(auto.at) > 0 ? { tone: 'warn', text: <>Next: {auto.label} in <Countdown to={auto.at} /></> }
    : s.arena.phase === 'finale' ? { tone: 'warn', text: 'Finale in Training Room 14 — open the mission' }
    : inPlane && !overCampus && msUntil(plane?.t0) > -60000 ? { tone: 'info', text: '✈ Approaching Hexaware — get ready to jump' }
    : inPlane ? { tone: 'warn', text: <>🪂 {isCaptain ? 'Press JUMP when you like the spot below' : 'Your captain decides when to jump'} · auto-jump in <Countdown to={new Date(planeLeaves).toISOString()} /></> }
    : chute ? { tone: 'info', text: <>🪂 {isCaptain ? 'Steer with the joystick' : 'Falling'} · touchdown in <Countdown to={s.team.land_at} /></> }
    : zn.shrinking && outside ? { tone: 'bad', text: <>☢ The zone is closing in — {zoneRaw?.dps ?? 1} HP/s outside!</>, arrow: zoneArrow }
    : nextLock && msUntil(nextLock.at) > 0 ? { tone: 'warn', text: <>🚨 {floorName(nextLock.n, nextLock.l)} seals in <Countdown to={nextLock.at} /></> }
    : s.arena.phase === 'play' && auto?.label === 'Finale' && auto.at && msUntil(auto.at) > 0 && msUntil(auto.at) < 120_000 ? { tone: 'warn', text: <>🏁 Finale in Training Room 14 in <Countdown to={auto.at} /></> }
    : zn.shrinking ? { tone: 'zone', text: <>☢ Zone closing · <Countdown to={new Date(zn.until!).toISOString()} /> · run to the white circle</> }
    : zoneWarn ? { tone: 'zone', text: <>Safe zone shrinks in <Countdown to={zone.next_at} /> · white circle = next zone</> }
    : onFoot && s.team.vehicle === 'none' && level === 0 && !inB && buggy && s.arena.phase === 'play' ? { tone: 'info', text: <>🚙 Walk to the parking yard — buggy {s.team.number} waits · {Math.round(buggyDist * METERS)} m</>, arrow: Math.atan2(buggy[0] - myXY[0], -(buggy[1] - myXY[1])) - (me.current.yaw || 0) }
    : null;
  const travelDest = s.team.state === 'traveling' && s.team.travel_to ? map?.locations.find((l) => l.id === s.team.travel_to) : null;
  primaryRef.current = primary;
  fireKeys.current = {
    start: () => { if (canFight && target) startFire(); }, stop: stopFire,
    run: () => { if (isCaptain && onFoot) { const v = !runRef.current; setRunning(v); store.set('hb_run', v ? '1' : '0'); sfx.tap(); } },
  };
  const fpv = false; // open floors are shown from behind the captain (third person), like Free Fire
  const world3d: WorldState = { ...state, zone: zoneRaw, plane: s.arena.phase === 'play' ? plane : null, fpv, target: target?.id || null,
    waypoint: marker ? { x: marker[0], y: marker[1] } : null, route: travelDest && s.team.dropped ? { x: travelDest.x, y: travelDest.y } : null };
  const where = here ? (SHORT[here.id] || here.name) : inB ? inB.name : travelDest ? null : 'Open ground';

  return (
    <div className={`world-screen ${myLock ? 'alarm' : ''}`}>
      <div className="world-view">
        {map && webgl ? (
          <Suspense fallback={<div className="world-loading">Loading 3D campus…</div>}>
            <World3D map={map} state={world3d} mode="follow" zoom={zoom} live={me} sceneRef={sceneRef}
              onPick={(id) => { const l = map.locations.find((x) => x.id === id); if (l) { sfx.tap(); setMarker([l.x, l.y]); } }} />
          </Suspense>
        ) : map ? (
          <div style={{ padding: '120px 8px 0' }}>
            <CampusMap map={map} zoneStage={s.arena.zone_stage} squads={squads.map((x: any) => ({ number: x.number, location: x.location, pos: x.pos, me: x.id === s.team.id, allied: x.allied, in_battle: x.in_battle }))}
              zone={zone} red={red} airdrops={s.airdrops} selected={markerLoc?.id || null} onSelect={(id) => { const l = map.locations.find((x) => x.id === id); if (l) setMarker([l.x, l.y]); }} height="60vh" />
          </div>
        ) : null}
      </div>
      {myLock && <div className="alarm-vignette" aria-hidden />}
      {climbing && <div className="climb-flash" role="status">{climbing}</div>}
      {hurt && performance.now() - hurt.t < 700 && <div className="hurt-arc" style={{ transform: `rotate(${hurt.ang}rad)` }} aria-hidden />}
      {fpv && <div className="fpv-cross" aria-hidden />}
      {target && canFight && (
        <div className={`aim ${hitFx && performance.now() - hitFx.t < 260 ? 'hit' : ''}`} aria-hidden>
          <i /><span>SQ {target.number}{typeof target.hp === 'number' ? ` · ${target.hp} HP` : ''} · {Math.round(target.d * METERS)} m</span>
          {hitFx && performance.now() - hitFx.t < 700 && <b className={hitFx.crit ? 'crit' : ''}>{hitFx.ko ? 'KNOCKED!' : `-${hitFx.dmg}`}</b>}
        </div>
      )}

      {/* top-left: minimap, team */}
      <div className="hud-tl">
        {map && <MiniMap map={map} me={myXY} yaw={me.current.yaw || 0} squads={squads.map((x: any) => ({ ...x, me: x.id === s.team.id }))} zone={zone} red={red}
          drops={s.airdrops || []} marker={marker} overview={false} lock={lock} level={level}
          tag={zoneWarn ? <>☢ <Countdown to={zone.next_at} /></> : <>Zone {zone?.stage ?? s.arena.zone_stage}/5</>} warn={zoneWarn}
          onClick={() => { sfx.tap(); setMapOpen(true); }} />}
        <SquadStrip s={s} />
        {(s.mission || s.battle) && (
          <button className={`hud-mission ${s.battle ? 'battle' : ''}`} onClick={openMission}>
            <span>{s.battle ? `⚔ Duel vs SQ ${s.battle.we_attacked ? s.battle.defender : s.battle.attacker}` : s.mission.title}</span>
            <b className="mono"><Countdown to={(s.battle || s.mission).deadline} low={20} /></b>
          </button>
        )}
      </div>

      {/* top centre: compass, counters, one banner */}
      <div className="hud-top">
        <Compass src={me} marker={markerBearing} />
        <div className="hud-info">
          <span><b>{alive}</b> {alive === 1 ? 'squad' : 'squads'}</span>
          <span><b>{s.team.points}</b> pts</span>
          <span className="gold"><b>{s.team.coins}</b> ¢</span>
        </div>
        {banner && (
          <div className={`hud-banner ${banner.tone}`} role="status">
            {banner.arrow != null && <span className="arrow" style={{ transform: `rotate(${banner.arrow}rad)` }} aria-hidden>➤</span>}
            {banner.text}
          </div>
        )}
      </div>

      {/* top-right: buttons + kill feed */}
      <div className="hud-tr">
        <div className="hud-btns">
          <button className="hb" onClick={() => { sfx.tap(); setMapOpen(true); }} aria-label="Open map"><Icon name="map" /></button>
          <button className="hb" onClick={openSquad} aria-label="Bag and squad"><Icon name="bag" /></button>
          {isCaptain && <button className="hb" onClick={openComms} aria-label="Captain chat"><Icon name="chat" />{unread > 0 && <em>{unread}</em>}</button>}
          <button className="hb" onClick={onSettings} aria-label="Settings"><Icon name="gear" /><span className={`dot ${connected ? 'on' : ''}`} /></button>
        </div>
        <KillFeed feed={s.feed} map={map} />
      </div>

      {/* right: floor indicator inside buildings; stairs controls at the stairwell */}
      {(inB && inB.floors > 1) || stairsB ? (
        <div className="hud-floors" aria-label={`${(stairsB || inB)!.name}, ${floorLabel(level)}`}>
          {stairsB && <small className="lift-t">🛗 LIFT</small>}
          <div className={`fl-stack ${isCaptain && stairsB ? 'lift' : ''}`}>
            {Array.from({ length: (stairsB || inB)!.floors }, (_, i) => (stairsB || inB)!.floors - 1 - i).map((f) => {
              const locked = lock.some((l) => l.b === (stairsB || inB)!.id && (l.l === null || l.l === f));
              return isCaptain && stairsB
                ? <button key={f} className={`fl ${f === level ? 'on' : ''} ${locked ? 'locked' : ''}`} disabled={!canMove || f === level || !!climbing || locked} onClick={() => climb(f)} aria-label={`Lift to ${floorLabel(f)}`}>{f === 0 ? 'G' : f}</button>
                : <span key={f} className={`fl ${f === level ? 'on' : ''} ${locked ? 'locked' : ''}`}>{f === 0 ? 'G' : f}</span>;
            })}
          </div>
        </div>
      ) : null}

      {/* bottom centre: marker card / location, HP */}
      <div className="hud-bc">
        {marker ? (
          <div className="hud-marker">
            <span className="grow"><b>{markerLoc ? (SHORT[markerLoc.id] || markerLoc.name) : 'Marker'}</b> · {Math.round(markerDist * METERS)} m{!inPlane && <> · {Math.max(1, Math.round(markerDist / (onFoot ? (world.foot_speed || 0.006) : world.speed)))} s</>}</span>
            {markerLoc && isCaptain && s.arena.phase === 'play' && here?.id !== markerLoc.id && (
              <button className="btn xs primary" disabled={busy || !(canMove || (inPlane && overCampus))} onClick={() => runTo(markerLoc.id)}>{inPlane ? '🪂 Jump' : onFoot ? 'Run' : 'Drive'}</button>
            )}
            <button className="btn xs ghost" onClick={() => setMarker(null)} aria-label="Remove marker">✕</button>
          </div>
        ) : (
          <div className="hud-loc">
            {where ? <>📍 {where}</> : travelDest ? <>🚙 To {SHORT[travelDest.id] || travelDest.name}</> : null}
            {(level > 0 || (inB && inB.floors > 1)) && <span className="fl-chip">{floorLabel(level)}</span>}
            {stairsB && <span className="fl-chip go">🛗 {isCaptain ? 'Lift: tap a floor' : 'At the lift'}</span>}
          </div>
        )}
        <div className="hud-hp" aria-label={`Health ${hp} of 100${s.team.shield ? `, shield ${s.team.shield}` : ''}`}>
          <div className="hp-track">
            <i className="hp-fill" style={{ width: `${Math.max(0, Math.min(100, hp))}%`, background: hp > 50 ? '#f2f5f8' : hp > 25 ? '#ffc23d' : '#ff4d5e' }} />
            {s.team.shield > 0 && <i className="hp-shield" style={{ width: `${Math.min(100, s.team.shield)}%` }} />}
          </div>
          <b>{hp}</b>
        </div>
      </div>

      {/* bottom-left: joystick or role hint */}
      {isCaptain && s.arena.phase === 'play' && !inPlane && (!chute || inAir)
        ? <Joystick disabled={!canMove} onMove={(x, y) => { vec.current = { x, y }; }} />
        : <div className="hud-bl-hint">{spectating && s.me.role === 'captain'
            ? <>🤖 Demo: this dummy captain drives by itself. Tap <b>Take control</b> to drive.</>
            : <>{ROLES[s.me.role as Role]?.icon} You are {ROLES[s.me.role as Role]?.name}. <b>{s.roles?.captain || 'The captain'}</b> {onFoot ? 'leads the squad on foot' : 'drives the squad'}{canFight ? ' — hold FIRE when a rival is in range' : ''}.</>}</div>}

      {isCaptain && s.arena.phase === 'play' && <div className="kbd-hint" aria-hidden><kbd>W A S D</kbd> move · <kbd>R</kbd> run · <kbd>Space</kbd> {primary?.label?.toLowerCase() || 'action'} · <kbd>F</kbd> fire</div>}
      {!isCaptain && canFight && <div className="kbd-hint" aria-hidden>Hold <kbd>F</kbd> to fire</div>}
      {/* bottom-right: actions */}
      <div className="hud-actions">
        {canFight && (
          <button className={`act fire ${target ? 'live' : ''} ${reloading ? 'reload' : ''}`} disabled={!target}
            onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); startFire(); }}
            onPointerUp={stopFire} onPointerCancel={stopFire} onPointerLeave={stopFire} onContextMenu={(e) => e.preventDefault()}
            aria-label={target ? `Fire at squad ${target.number}` : 'No target in range'}>
            <Icon name="pistol" /><span>{reloading ? 'RELOAD' : 'FIRE'}</span><small>{weapon.name} · {ammoLeft}/{weapon.mag}</small>
          </button>
        )}
        {isCaptain && onFoot && !inAir && canMove && (
          <button className={`act md run ${running ? 'on' : ''}`} onClick={() => { const v = !running; setRunning(v); store.set('hb_run', v ? '1' : '0'); sfx.tap(); }} aria-pressed={running} aria-label={running ? 'Running — tap to walk' : 'Walking — tap to run'}>
            <Icon name="run" /><small>{running ? 'RUN' : 'WALK'}</small>
          </button>
        )}
        {isCaptain && nearBuggy && canMove && (
          <button className="act md getin" disabled={busy} onClick={() => act('captain_vehicle', { p_in: true }).then((r) => { if (r) { vehRef.current = 'in'; sfx.go(); buzz(30); toast('Engine on — drive!', 'good'); } })} aria-label="Get in your buggy"><Icon name="car" /><small>GET IN</small></button>
        )}
        {isCaptain && s.team.vehicle === 'in' && canMove && level === 0 && (
          <button className="act md" disabled={busy} onClick={() => act('captain_vehicle', { p_in: false }).then((r) => { if (r) vehRef.current = 'parked'; })} aria-label="Get out of the buggy"><Icon name="car" /><small>OUT</small></button>
        )}
        {isCaptain && medkits > 0 && hp < 100 && s.team.state !== 'recovery' && (
          <button className="act md good" disabled={busy} onClick={() => act('captain_use_item', { p_item: 'medkit' }, '+ HP')} aria-label="Use med kit"><Icon name="med" /><small>{medkits}</small></button>
        )}
        {primary && (
          <button className={`act lg ${primary.tone}`} disabled={primary.disabled} onClick={() => { buzz(15); primary!.onClick(); }}>
            <Icon name={primary.icon} /><span>{primary.label}</span>{primary.sub && <small>{primary.sub}</small>}
          </button>
        )}
      </div>

      <Coach isCaptain={isCaptain} />

      {mapOpen && map && (
        <BigMap map={map} me={myXY} yaw={me.current.yaw || 0} title={`Map · Phase ${phase} ${MATCH_PHASES[phase]?.name || ''}`}
          squads={squads.map((x: any) => ({ id: x.id, number: x.number, pos: x.pos, me: x.id === s.team.id, allied: x.allied }))}
          zone={zone} zoneNextAt={zone?.next_at} red={red} drops={s.airdrops || []} marker={marker} setMarker={setMarker}
          lock={lock} level={level} bldg={bldg} pickups={s.pickups || []}
          onRun={runTo} canRun={isCaptain && s.arena.phase === 'play' && (canMove || (inPlane && overCampus))} speed={onFoot ? (world.foot_speed || 0.006) : world.speed} onClose={() => setMapOpen(false)}
          runLabel={inPlane ? '🪂 Land here' : onFoot ? 'Run here' : 'Drive here'} glide={inPlane ? { x: myXY[0], y: myXY[1], r: glide } : null} buggy={onFoot ? buggy : null} />
      )}
    </div>
  );
}
