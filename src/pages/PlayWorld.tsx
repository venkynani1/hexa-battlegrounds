// In-game battle screen: full-screen 3D campus + Free Fire-style HUD.
// Movement: the captain drives the squad buggy with a floating joystick (client-side prediction,
// server-capped speed via captain_steer, velocity broadcast to teammates for lag-free motion) or
// taps a place to auto-run there (captain_move). Buildings have floors: climb at the stairwell.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { friendly, rpc } from '../lib/api';
import { feedText, floorLabel, floorName, locName, MapData, MATCH_PHASES, ROLES, ROLE_ORDER, Role, TIER_COLOR } from '../lib/game';
import { POLL_EXTRAPOLATE, predict, useRivals, useSquadLink } from '../lib/motion';
import { ROADS, LOTS } from '../../content/campus.mjs';
import { msUntil, serverTime, useNow } from '../lib/time';
import { buzz, sfx } from '../lib/sound';
import { Countdown, HpBar, Sheet, toast } from '../components/ui';
import CampusMap, { SHORT } from '../components/CampusMap';
import BigMap, { METERS } from './BigMap';
import type { WorldState } from '../three/world';

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
  const KEY = 'hb_coach_v2';
  const [step, setStep] = useState(() => { try { return localStorage.getItem(KEY) ? -1 : 0; } catch { return 0; } });
  if (step < 0) return null;
  const tips = isCaptain ? [
    { at: 'bl', title: 'Drive', text: 'Your squad is a buggy. Put your thumb anywhere bottom-left and drag. Drag the right side of the screen to turn the camera.' },
    { at: 'tl', title: 'Map', text: 'Tap the minimap for the full campus. Tap a place, then Drive — or Drop for your first landing.' },
    { at: 'br', title: 'Act', text: 'The big button changes: SEARCH in a place, CRACK at a crate or vault, ENGAGE near enemies, SOLVE during a challenge.' },
    { at: 'tr', title: 'Floors & lockdowns', text: 'Rooms are upstairs: drive onto a green STAIRS ring and use ▲▼. When a building sounds its alarm, get out before the doors shut.' },
  ] : [
    { at: 'tl', title: 'Your squad', text: 'Your captain drives the squad buggy. You can watch, turn the camera and open the map.' },
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
type IconName = 'search' | 'crate' | 'target' | 'puzzle' | 'med' | 'bag' | 'plus' | 'minus' | 'map' | 'chat' | 'gear';
const ICONS: Record<IconName, string> = {
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm4.8 11.3L20 20',
  crate: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm0 0l8 4 8-4M12 12v8',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  puzzle: 'M9 4h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v6h-5a2 2 0 1 0-4 0H5v-5a2 2 0 1 0 0-4V4h4Z',
  med: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6V4Z',
  bag: 'M8 7V5a4 4 0 0 1 8 0v2M5 7h14l-1 13H6L5 7Zm4 5h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6Zm6-2v14m6-12v14',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  gear: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1 7 17m10-10 2.1-2.1',
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden width="26" height="26">
      <path d={ICONS[name]} fill={name === 'med' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={name === 'med' ? 0 : 2.2} strokeLinecap="round" strokeLinejoin="round" />
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

type Live = { x: number; y: number; moving: boolean; joy?: boolean; yaw?: number; level?: number; bldg?: string | null; vx?: number; vy?: number };

export default function WorldTab({ s, token, map, refresh, openMission, openSquad, openComms, unread, onSettings, connected, spectating }: {
  s: any; token: string; map: MapData | null; refresh: () => void; openMission: () => void; openSquad: () => void; openComms: () => void; unread: number; onSettings: () => void; connected: boolean;
  /** demo mode: a dummy captain drives this squad, so this screen only watches */
  spectating?: boolean;
}) {
  useNow(500);
  const isCaptain = s.me.role === 'captain' && !spectating;
  const world = s.arena.overlay?.world || { speed: 0.016, loc_radius: 0.018, engage_range: 0.04 };
  const zone = s.arena.overlay?.zone;
  const red = s.arena.overlay?.red && msUntil(s.arena.overlay.red.at) > -2000 ? s.arena.overlay.red : null;
  const lock: any[] = s.arena.overlay?.lock || [];
  const buildings = map?.buildings || [];
  const level: number = s.team.level || 0;
  const bldg: string | null = s.team.bldg || null;
  const canMove = isCaptain && s.arena.phase === 'play' && !s.arena.paused && s.team.state !== 'recovery' && !s.battle;
  const [zoom] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);
  const [marker, setMarker] = useState<XY | null>(null);
  const [engage, setEngage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [climbing, setClimbing] = useState<string | null>(null);
  const link = useSquadLink(s.team.id, isCaptain);
  const rivals = useRivals(token, s.arena.phase === 'play');

  // ── own position: prediction while steering (captain), the captain's live feed (teammates), server truth otherwise ──
  const serverPos = travelPos(s, map);
  const me = useRef<Live>({ x: serverPos?.[0] ?? 0.47, y: serverPos?.[1] ?? 0.93, moving: false, yaw: 0, level, bldg });
  const vec = useRef({ x: 0, y: 0 });
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
      if (isCaptain) {
        const v = vec.current;
        const mag = Math.hypot(v.x, v.y);
        if (mag > 0 && canMove) {
          steering.current = true;
          // the joystick is relative to where the camera looks (push up = drive forward)
          const yaw = L.yaw || 0; const c = Math.cos(yaw); const sn = Math.sin(yaw);
          const wx = c * v.x - sn * v.y; const wy = sn * v.x + c * v.y;
          let nx = clamp01(L.x + wx * world.speed * dt); let ny = clamp01(L.y + wy * world.speed * dt);
          if (level > 0 && B) { nx = Math.max(B.x0 + 0.004, Math.min(B.x1 - 0.004, nx)); ny = Math.max(B.y0 + 0.004, Math.min(B.y1 - 0.004, ny)); }
          else if (sealedAt(nx, ny) && !sealedAt(L.x, L.y)) { nx = L.x; ny = L.y; }
          // velocity actually achieved (smoothed): slow phones and walls never make teammates overshoot
          const ivx = (nx - L.x) / Math.max(dt, 0.001); const ivy = (ny - L.y) / Math.max(dt, 0.001);
          L.vx = (L.vx || 0) * 0.75 + ivx * 0.25; L.vy = (L.vy || 0) * 0.75 + ivy * 0.25;
          L.x = nx; L.y = ny; L.moving = true; L.joy = true;
          link.send({ x: L.x, y: L.y, vx: L.vx, vy: L.vy, l: level, h: yaw });
          if (t - lastSend.current > 300) sendSteer();
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
          if (own && serverTime() - own.t < 6000) { target = predict(own, undefined, POLL_EXTRAPOLATE); moving = Math.hypot(own.vx, own.vy) > 1e-5; }
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
  }, [s, map, canMove, world.speed, isCaptain, level, bldg, lock.length]);

  const myLevel = me.current.level ?? level;
  const myXY: XY = [me.current.x, me.current.y];
  const here = locAt(map, myXY, world.loc_radius, level, bldg);
  const squads = s.squads || [];
  const enemiesNear = squads.filter((x: any) => x.id !== s.team.id && x.pos && dist(x.pos, myXY) <= world.engage_range && x.state !== 'recovery'
    && (x.level || 0) === level && (level === 0 || x.bldg === bldg));
  const dropsHere = (s.airdrops || []).filter((a: any) => here && a.location === here.id);
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
  const inB = level > 0 ? buildings.find((b) => b.id === bldg) : buildings.find((b) => myXY[0] > b.x0 && myXY[0] < b.x1 && myXY[1] > b.y0 && myXY[1] < b.y1);
  const stairsB = buildings.find((b) => b.floors > 1 && (level === 0 || b.id === bldg) && Math.hypot(b.stairs[0] - myXY[0], b.stairs[1] - myXY[1]) < 0.016);
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
      };
    }),
    zone, red, locRadius: world.loc_radius, lock,
    pickups: s.pickups || [],
    airdrops: (s.airdrops || []).map((a: any) => ({ key: a.id, location: a.location, tier: a.tier })),
    battles: [],
    focus: { x: me.current.x, y: me.current.y },
  }), [s, zone, red, world.loc_radius, lock, Math.floor(now / 300), myLevel]);

  async function act(fn: string, args: any, ok?: string) {
    setBusy(true);
    try { const r = await rpc(fn, { p_token: token, ...args }); if (ok) toast(ok, 'good'); sfx.tap(); return r; }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); return null; }
    finally { setBusy(false); refresh(); }
  }

  async function climb(dir: 1 | -1) {
    if (!stairsB) return;
    const to = level + dir;
    setClimbing(`${dir > 0 ? 'Climbing to' : 'Going down to'} ${floorLabel(to)}…`);
    sfx.stairs(); buzz(15);
    try {
      const r = await rpc<any>('captain_stairs', { p_token: token, p_dir: dir });
      me.current.x = r.x; me.current.y = r.y; me.current.level = r.level; me.current.bldg = r.level > 0 ? r.building : null;
      link.send({ x: r.x, y: r.y, vx: 0, vy: 0, l: r.level }, true);
      lastLoc.current = r.location;
    } catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { refresh(); setTimeout(() => setClimbing(null), 650); }
  }

  // primary context action
  let primary: { label: string; icon: IconName; sub?: string; tone: string; onClick: () => void; disabled?: boolean } | null = null;
  if (s.battle) primary = { icon: 'target', label: 'DUEL', sub: 'answer now', tone: 'danger', onClick: openMission };
  else if (s.mission) primary = { icon: 'puzzle', label: 'SOLVE', sub: s.mission.title, tone: 'primary', onClick: openMission };
  else if (s.team.state === 'recovery') primary = { icon: 'med', label: 'REVIVE', sub: 'recovery', tone: 'good', onClick: openMission };
  else if (isCaptain && dropsHere.length) primary = { icon: 'crate', label: 'CRACK', sub: dropsHere[0].tier === 'vault' ? 'VAULT' : `${dropsHere[0].tier} crate`, tone: 'gold', disabled: busy, onClick: () => act('captain_claim_airdrop', { p_airdrop: dropsHere[0].id }).then((r) => r && openMission()) };
  else if (isCaptain && enemiesNear.length && !duelsLocked) primary = { icon: 'target', label: 'ENGAGE', sub: `SQ ${enemiesNear[0].number}`, tone: 'danger', disabled: busy || !!cooldown, onClick: () => setEngage(true) };
  else if (isCaptain && here && here.kind !== 'stairs' && s.arena.phase === 'play') primary = { icon: 'search', label: 'SEARCH', sub: searchesLeft > 0 ? `${searchesLeft} left` : 'area empty', tone: 'primary', disabled: busy || searchesLeft <= 0 || s.team.state !== 'idle', onClick: () => act('captain_explore', {}).then((r) => r && openMission()) };
  const medkits = s.inventory?.medkit || 0;
  const weapons = Object.entries(s.inventory || {}).filter(([k]) => ['pistol', 'smg', 'sniper'].includes(k)) as [string, number][];
  const hp = s.team.hp;

  const webgl = hasWebGL();
  const zoneWarn = !!zone?.next_at && msUntil(zone.next_at) > 0;
  const markerDist = marker ? Math.hypot(marker[0] - myXY[0], marker[1] - myXY[1]) : 0;
  const markerBearing = marker ? Math.atan2(marker[0] - myXY[0], -(marker[1] - myXY[1])) : null;
  const markerPlace = marker ? map?.locations.filter((l) => l.kind !== 'start' && l.enabled && (l.level || 0) === level && (level === 0 || l.building === bldg))
    .map((l) => ({ l, d: Math.hypot(l.x - marker[0], l.y - marker[1]) })).sort((a, b) => a.d - b.d)[0] : null;
  const markerLoc = markerPlace && markerPlace.d < 0.03 ? markerPlace.l : null;
  async function runTo(id: string) {
    const r = await act('captain_move', { p_location: id });
    if (r) { sfx.go(); toast(`${!s.team.dropped ? 'Parachuting' : 'Driving'} to ${SHORT[id] || locName(map, id)} · ${Math.round(r.seconds)}s`, 'info'); setMapOpen(false); }
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
    : !s.team.dropped && s.arena.phase === 'play' ? { tone: 'info', text: isCaptain ? '🪂 Open the map and pick where to drop' : '🪂 Your captain is picking a drop point' }
    : nextLock && msUntil(nextLock.at) > 0 ? { tone: 'warn', text: <>🚨 {floorName(nextLock.n, nextLock.l)} seals in <Countdown to={nextLock.at} /></> }
    : s.arena.phase === 'play' && auto?.label === 'Finale' && auto.at && msUntil(auto.at) > 0 && msUntil(auto.at) < 120_000 ? { tone: 'warn', text: <>🏁 Finale in Training Room 14 in <Countdown to={auto.at} /></> }
    : zoneWarn ? { tone: 'zone', text: <>Safe zone shrinking in <Countdown to={zone.next_at} /></> }
    : null;
  const travelDest = s.team.state === 'traveling' && s.team.travel_to ? map?.locations.find((l) => l.id === s.team.travel_to) : null;
  const world3d: WorldState = { ...state, waypoint: marker ? { x: marker[0], y: marker[1] } : null, route: travelDest ? { x: travelDest.x, y: travelDest.y } : null };
  const where = here ? (SHORT[here.id] || here.name) : inB ? inB.name : travelDest ? null : 'Open ground';

  return (
    <div className={`world-screen ${myLock ? 'alarm' : ''}`}>
      <div className="world-view">
        {map && webgl ? (
          <Suspense fallback={<div className="world-loading">Loading 3D campus…</div>}>
            <World3D map={map} state={world3d} mode="follow" zoom={zoom} live={me}
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

      {/* top-left: minimap, team */}
      <div className="hud-tl">
        {map && <MiniMap map={map} me={myXY} yaw={me.current.yaw || 0} squads={squads.map((x: any) => ({ ...x, me: x.id === s.team.id }))} zone={zone} red={red}
          drops={s.airdrops || []} marker={marker} overview={false} lock={lock} level={level}
          tag={zoneWarn ? <>☢ <Countdown to={zone.next_at} /></> : <>Zone {zone?.stage ?? s.arena.zone_stage}/5</>} warn={zoneWarn}
          onClick={() => { sfx.tap(); setMapOpen(true); }} />}
        <div className="hud-squad" aria-label="Your squad">
          {ROLE_ORDER.map((r: Role) => {
            const p = s.roster.find((x: any) => x.role === r);
            return <span key={r} className={`sq-dot ${p?.online ? 'on' : ''} ${p?.me ? 'me' : ''}`} style={{ background: ROLES[r].color }} title={`${ROLES[r].name}: ${p?.name || '—'}`}>{ROLES[r].icon}</span>;
          })}
        </div>
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
          {isCaptain && stairsB && <button className="fl-btn" disabled={!canMove || level >= stairsB.floors - 1 || !!climbing} onClick={() => climb(1)} aria-label="Go up one floor">▲</button>}
          <div className="fl-stack">
            {Array.from({ length: (stairsB || inB)!.floors }, (_, i) => (stairsB || inB)!.floors - 1 - i).map((f) => (
              <span key={f} className={`fl ${f === level ? 'on' : ''} ${lock.some((l) => l.b === (stairsB || inB)!.id && (l.l === null || l.l === f)) ? 'locked' : ''}`}>{f === 0 ? 'G' : f}</span>
            ))}
          </div>
          {isCaptain && stairsB && <button className="fl-btn" disabled={!canMove || level <= 0 || !!climbing} onClick={() => climb(-1)} aria-label="Go down one floor">▼</button>}
          {!isCaptain && stairsB && <small>Stairs</small>}
        </div>
      ) : null}

      {/* bottom centre: marker card / location, HP */}
      <div className="hud-bc">
        {marker ? (
          <div className="hud-marker">
            <span className="grow"><b>{markerLoc ? (SHORT[markerLoc.id] || markerLoc.name) : 'Marker'}</b> · {Math.round(markerDist * METERS)} m · {Math.max(1, Math.round(markerDist / world.speed))} s</span>
            {markerLoc && isCaptain && s.arena.phase === 'play' && here?.id !== markerLoc.id && (
              <button className="btn xs primary" disabled={busy || !canMove} onClick={() => runTo(markerLoc.id)}>{!s.team.dropped ? '🪂 Drop' : 'Drive'}</button>
            )}
            <button className="btn xs ghost" onClick={() => setMarker(null)} aria-label="Remove marker">✕</button>
          </div>
        ) : (
          <div className="hud-loc">
            {where ? <>📍 {where}</> : travelDest ? <>🚙 To {SHORT[travelDest.id] || travelDest.name}</> : null}
            {(level > 0 || (inB && inB.floors > 1)) && <span className="fl-chip">{floorLabel(level)}</span>}
            {stairsB && <span className="fl-chip go">⇅ {isCaptain ? 'Use ▲▼ to climb' : 'Stairs'}</span>}
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
      {isCaptain && s.arena.phase === 'play'
        ? <Joystick disabled={!canMove} onMove={(x, y) => { vec.current = { x, y }; }} />
        : <div className="hud-bl-hint">{spectating && s.me.role === 'captain'
            ? <>🤖 Demo: this dummy captain drives by itself. Tap <b>Take control</b> to drive.</>
            : <>{ROLES[s.me.role as Role]?.icon} You are {ROLES[s.me.role as Role]?.name}. <b>{s.roles?.captain || 'The captain'}</b> drives the squad.</>}</div>}

      {/* bottom-right: actions */}
      <div className="hud-actions">
        {isCaptain && medkits > 0 && hp < 100 && s.team.state !== 'recovery' && (
          <button className="act md good" disabled={busy} onClick={() => act('captain_use_item', { p_item: 'medkit' }, '+ HP')} aria-label="Use med kit"><Icon name="med" /><small>{medkits}</small></button>
        )}
        {primary && (
          <button className={`act lg ${primary.tone}`} disabled={primary.disabled} onClick={() => { buzz(15); primary!.onClick(); }}>
            <Icon name={primary.icon} /><span>{primary.label}</span>{primary.sub && <small>{primary.sub}</small>}
          </button>
        )}
      </div>

      {/* engage: pick a weapon */}
      <Sheet open={engage} onClose={() => setEngage(false)} title="Engage enemy squad">
        <div className="col">
          {enemiesNear.map((x: any) => (
            <div key={x.id} className="panel danger col" style={{ gap: 8 }}>
              <div className="row between"><b>Squad {x.number} · {x.name}</b>{x.allied && <span className="chip good">Ally (betrayal!)</span>}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {weapons.map(([w, q]) => (
                  <button key={w} className="btn danger grow" disabled={busy || x.protected || x.in_battle || !!cooldown}
                    onClick={async () => { sfx.weapon(); const r = await act('captain_attack', { p_target: x.id, p_weapon: w }); setEngage(false); if (r) openMission(); }}>
                    {w.toUpperCase()}{w !== 'pistol' ? ` ×${q}` : ''}
                  </button>
                ))}
              </div>
              {x.protected && <span className="muted" style={{ fontSize: 13 }}>Protected after respawn — try later.</span>}
            </div>
          ))}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>A duel is a puzzle race: the first squad to answer wins and the loser takes damage. Pistol 25 damage (90 s, reusable) · SMG 20 (50 s, one use) · Sniper 40 (120 s, hard, one use).</p>
        </div>
      </Sheet>

      <Coach isCaptain={isCaptain} />

      {mapOpen && map && (
        <BigMap map={map} me={myXY} yaw={me.current.yaw || 0} title={`Map · Phase ${phase} ${MATCH_PHASES[phase]?.name || ''}`}
          squads={squads.map((x: any) => ({ id: x.id, number: x.number, pos: x.pos, me: x.id === s.team.id, allied: x.allied }))}
          zone={zone} zoneNextAt={zone?.next_at} red={red} drops={s.airdrops || []} marker={marker} setMarker={setMarker}
          lock={lock} level={level} bldg={bldg} pickups={s.pickups || []}
          onRun={runTo} canRun={isCaptain && s.arena.phase === 'play' && canMove} speed={world.speed} onClose={() => setMapOpen(false)} />
      )}
    </div>
  );
}
