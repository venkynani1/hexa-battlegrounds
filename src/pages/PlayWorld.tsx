// In-game battle screen: full-screen 3D campus + Free Fire-style HUD.
// Movement: the captain drives the squad with a floating joystick (client-side prediction,
// server-capped speed via captain_steer) or taps a location ring to auto-run there (captain_move).
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { friendly, rpc } from '../lib/api';
import { feedText, locName, MapData, MATCH_PHASES, ROLES, ROLE_ORDER, Role, TIER_COLOR } from '../lib/game';
import { msUntil, serverTime, useNow } from '../lib/time';
import { buzz, sfx } from '../lib/sound';
import { Countdown, HpBar, Sheet, toast } from '../components/ui';
import CampusMap, { SHORT } from '../components/CampusMap';
import BigMap, { METERS } from './BigMap';
import type { WorldState } from '../three/world';

const World3D = lazy(() => import('../three/World3D'));

type XY = [number, number];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (v: number) => Math.max(0.035, Math.min(0.965, v));

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

function locAt(map: MapData | null, p: XY | null, r: number) {
  if (!map || !p) return null;
  let best: any = null; let bd = r;
  for (const l of map.locations) {
    if (l.kind === 'start' || !l.enabled) continue;
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
  const KEY = 'hb_coach_v1';
  const [step, setStep] = useState(() => { try { return localStorage.getItem(KEY) ? -1 : 0; } catch { return 0; } });
  if (step < 0) return null;
  const tips = isCaptain ? [
    { at: 'bl', title: 'Move', text: 'Put your thumb anywhere bottom-left and drag. Drag the right side of the screen to turn the camera.' },
    { at: 'tl', title: 'Map', text: 'Tap the minimap for the full map. Tap a place, then Run here — or Drop for your first landing.' },
    { at: 'br', title: 'Act', text: 'The big button changes: SEARCH in a place, CRACK at a crate, ENGAGE near enemies, SOLVE during a mission.' },
  ] : [
    { at: 'tl', title: 'Your squad', text: 'Your captain moves the squad. You can watch, turn the camera and open the map.' },
    { at: 'br', title: 'Your clue', text: 'When a mission starts, your clue opens by itself. Read it out — the captain types the answer.' },
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
function MiniMap({ map, me, yaw, squads, zone, red, drops, marker, onClick, overview, tag, warn }: {
  map: MapData; me: XY | null; yaw: number; squads: any[]; zone: any; red: any; drops: any[]; marker?: XY | null; onClick: () => void; overview: boolean;
  tag?: React.ReactNode; warn?: boolean;
}) {
  const cur = zone?.cur; const nxt = zone?.next;
  return (
    <button className="minimap" onClick={onClick} aria-label={overview ? 'Back to squad view' : 'Show whole campus'}>
      <svg viewBox="-0.02 -0.02 1.04 1.04" aria-hidden>
        <defs>
          <mask id="mm-safe"><rect x="-1" y="-1" width="3" height="3" fill="white" />{cur && <circle cx={cur[0]} cy={cur[1]} r={cur[2]} fill="black" />}</mask>
        </defs>
        <rect x="0" y="0" width="1" height="1" rx="0.04" fill="#4f7f3c" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="0.01" />
        {mmBlocks(map).map((b) => <rect key={b.id} x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} rx="0.01" fill="#d9d4c8" opacity="0.9" />)}
        {map.locations.filter((l) => l.kind !== 'start' && (l.kind !== 'room' || l.id === 'tr14')).map((l) => (
          <circle key={l.id} cx={l.x} cy={Math.min(0.99, l.y)} r={l.id === 'tr14' ? 0.022 : 0.012} fill={l.id === 'tr14' ? '#ffc23d' : '#3d5878'} />
        ))}
        {cur && cur[2] < 0.86 && <rect x="-1" y="-1" width="3" height="3" fill="#2a6bff" opacity="0.35" mask="url(#mm-safe)" />}
        {nxt && <circle cx={nxt[0]} cy={nxt[1]} r={nxt[2]} fill="none" stroke="#fff" strokeWidth="0.012" />}
        {red && <circle cx={red.x} cy={red.y} r={red.r} fill="#ff2238" opacity="0.45" />}
        {drops.map((d: any) => { const l = map.locations.find((x) => x.id === d.location); return l ? <rect key={d.id} x={l.x - 0.02} y={l.y - 0.02} width="0.04" height="0.04" fill={TIER_COLOR[d.tier] || '#ffc23d'} /> : null; })}
        {squads.filter((x) => x.pos && !x.me).map((x) => <circle key={x.id} cx={x.pos[0]} cy={x.pos[1]} r="0.02" fill={x.allied ? '#5dff9e' : '#ff4d5e'} />)}
        {marker && <circle cx={marker[0]} cy={marker[1]} r="0.025" fill="#ffd23d" stroke="#1b2430" strokeWidth="0.008" />}
        {me && <path d={`M ${me[0]} ${me[1]} L ${me[0] + Math.sin(yaw - 0.5) * 0.16} ${me[1] - Math.cos(yaw - 0.5) * 0.16} A 0.16 0.16 0 0 1 ${me[0] + Math.sin(yaw + 0.5) * 0.16} ${me[1] - Math.cos(yaw + 0.5) * 0.16} Z`} fill="#ffffff" opacity="0.22" />}
        {me && <path d={`M ${me[0] + Math.sin(yaw) * 0.045} ${me[1] - Math.cos(yaw) * 0.045} L ${me[0] + Math.sin(yaw + 2.5) * 0.03} ${me[1] - Math.cos(yaw + 2.5) * 0.03} L ${me[0] + Math.sin(yaw - 2.5) * 0.03} ${me[1] - Math.cos(yaw - 2.5) * 0.03} Z`} fill="#3ef0ff" stroke="#fff" strokeWidth="0.006" />}
      </svg>
      <span className={`mm-tag ${warn ? 'warn' : ''}`}>{tag ?? (overview ? 'SQUAD VIEW' : 'MAP')}</span>
    </button>
  );
}

const mmCache = new WeakMap<MapData, { id: string; x0: number; x1: number; y0: number; y1: number }[]>();
function mmBlocks(map: MapData) {
  let b = mmCache.get(map);
  if (!b) {
    const g = new Map<string, MapData['locations']>();
    for (const l of map.locations) if (l.building && !['central', 'sports'].includes(l.building)) g.set(l.building, [...(g.get(l.building) || []), l]);
    b = [...g].map(([id, ls]) => ({ id, x0: Math.min(...ls.map((l) => l.x)) - 0.04, x1: Math.max(...ls.map((l) => l.x)) + 0.04, y0: Math.min(...ls.map((l) => l.y)) - 0.04, y1: Math.max(...ls.map((l) => l.y)) + 0.04 }));
    mmCache.set(map, b);
  }
  return b;
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

export default function WorldTab({ s, token, map, refresh, openMission, openSquad, openComms, unread, onSettings, connected }: {
  s: any; token: string; map: MapData | null; refresh: () => void; openMission: () => void; openSquad: () => void; openComms: () => void; unread: number; onSettings: () => void; connected: boolean;
}) {
  useNow(500);
  const isCaptain = s.me.role === 'captain';
  const world = s.arena.overlay?.world || { speed: 0.025, loc_radius: 0.035, engage_range: 0.06 };
  const zone = s.arena.overlay?.zone;
  const red = s.arena.overlay?.red && msUntil(s.arena.overlay.red.at) > -2000 ? s.arena.overlay.red : null;
  const canMove = isCaptain && s.arena.phase === 'play' && !s.arena.paused && s.team.state !== 'recovery' && !s.battle;
  const [zoom] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);
  const [marker, setMarker] = useState<XY | null>(null);
  const pick = null as string | null;
  const [engage, setEngage] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── own position: prediction while steering, server truth otherwise ──
  const serverPos = travelPos(s, map);
  const me = useRef<{ x: number; y: number; moving: boolean; joy?: boolean; yaw?: number }>({ x: serverPos?.[0] ?? 0.5, y: serverPos?.[1] ?? 0.93, moving: false, yaw: 0 });
  const vec = useRef({ x: 0, y: 0 });
  const steering = useRef(false);
  const lastSend = useRef(0);
  const inflight = useRef(false);
  const lastLoc = useRef<string | null>(s.team.location);
  const [, tick] = useState(0);

  useEffect(() => {
    if (steering.current || !serverPos) return;
    if (s.team.state === 'traveling') return; // the loop interpolates
    const d = Math.hypot(me.current.x - serverPos[0], me.current.y - serverPos[1]);
    if (d > 0.002) { me.current.x = serverPos[0]; me.current.y = serverPos[1]; }
  }, [serverPos?.[0], serverPos?.[1], s.team.state]);

  async function sendSteer(final = false) {
    if (inflight.current) return;
    inflight.current = true;
    lastSend.current = performance.now();
    try {
      const r = await rpc('captain_steer', { p_token: token, p_x: me.current.x, p_y: me.current.y });
      if (r.clamped) { me.current.x = r.x; me.current.y = r.y; }
      if (r.location !== lastLoc.current) {
        lastLoc.current = r.location;
        if (r.location) { sfx.gate(); buzz(20); }
        refresh();
      } else if (final) refresh();
    } catch (e) {
      const m = friendly(e);
      if (!/moving too fast/i.test(m)) toast(m, 'bad');
      steering.current = false; vec.current = { x: 0, y: 0 };
      refresh();
    } finally { inflight.current = false; }
  }

  // movement loop (RAF): integrate the joystick at the server's speed; interpolate auto-runs
  useEffect(() => {
    let raf = 0; let last = performance.now();
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      const v = vec.current;
      const mag = Math.hypot(v.x, v.y);
      if (mag > 0 && canMove) {
        steering.current = true;
        // the joystick is relative to where the camera looks (push up = run forward)
        const yaw = me.current.yaw || 0; const c = Math.cos(yaw); const sn = Math.sin(yaw);
        const wx = c * v.x - sn * v.y; const wy = sn * v.x + c * v.y;
        me.current.x = clamp01(me.current.x + wx * world.speed * dt);
        me.current.y = clamp01(me.current.y + wy * world.speed * dt);
        me.current.moving = true; me.current.joy = true;
        if (t - lastSend.current > 260) sendSteer();
      } else {
        me.current.joy = false;
        if (steering.current) { steering.current = false; me.current.moving = false; setTimeout(() => sendSteer(true), 40); }
        const tp = travelPos(s, map);
        if (s.team.state === 'traveling' && tp) { me.current.x = tp[0]; me.current.y = tp[1]; me.current.moving = true; }
        else me.current.moving = false;
      }
    };
    raf = requestAnimationFrame(step);
    const iv = setInterval(() => tick((n) => n + 1), 300); // refresh HUD readouts (location, distances)
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, [s, map, canMove, world.speed]);

  const myXY: XY = [me.current.x, me.current.y];
  const here = locAt(map, myXY, world.loc_radius);
  const squads = s.squads || [];
  const enemiesNear = squads.filter((x: any) => x.id !== s.team.id && x.pos && dist(x.pos, myXY) <= world.engage_range && x.state !== 'recovery');
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

  // 3D state (positions of others come from the server; own squad from the prediction above)
  const state: WorldState = useMemo(() => ({
    squads: squads.filter((x: any) => x.pos).map((x: any) => {
      const mine = x.id === s.team.id;
      return {
        key: x.id, number: x.number, x: mine ? me.current.x : x.pos[0], y: mine ? me.current.y : x.pos[1], me: mine, ally: x.allied,
        inBattle: x.in_battle, down: x.state === 'recovery', moving: x.traveling, label: mine ? `SQ ${x.number} · YOU` : `SQ ${x.number}`,
        roles: ['captain', 'scout', 'decoder', 'intel'],
      };
    }),
    zone, red, locRadius: world.loc_radius,
    airdrops: (s.airdrops || []).map((a: any) => ({ key: a.id, location: a.location, tier: a.tier })),
    battles: [],
    focus: { x: me.current.x, y: me.current.y },
    highlight: pick,
  }), [s, zone, red, pick, world.loc_radius, Math.round(me.current.x * 200), Math.round(me.current.y * 200)]);

  async function act(fn: string, args: any, ok?: string) {
    setBusy(true);
    try { const r = await rpc(fn, { p_token: token, ...args }); if (ok) toast(ok, 'good'); sfx.tap(); return r; }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); return null; }
    finally { setBusy(false); refresh(); }
  }


  // primary context action
  let primary: { label: string; icon: IconName; sub?: string; tone: string; onClick: () => void; disabled?: boolean } | null = null;
  if (s.battle) primary = { icon: 'target', label: 'DUEL', sub: 'answer now', tone: 'danger', onClick: openMission };
  else if (s.mission) primary = { icon: 'puzzle', label: 'SOLVE', sub: s.mission.title, tone: 'primary', onClick: openMission };
  else if (s.team.state === 'recovery') primary = { icon: 'med', label: 'REVIVE', sub: 'recovery', tone: 'good', onClick: openMission };
  else if (isCaptain && dropsHere.length) primary = { icon: 'crate', label: 'CRACK', sub: `${dropsHere[0].tier} crate`, tone: 'gold', disabled: busy, onClick: () => act('captain_claim_airdrop', { p_airdrop: dropsHere[0].id }).then((r) => r && openMission()) };
  else if (isCaptain && enemiesNear.length && !duelsLocked) primary = { icon: 'target', label: 'ENGAGE', sub: `SQ ${enemiesNear[0].number}`, tone: 'danger', disabled: busy || !!cooldown, onClick: () => setEngage(true) };
  else if (isCaptain && here && s.arena.phase === 'play') primary = { icon: 'search', label: 'SEARCH', sub: searchesLeft > 0 ? `${searchesLeft} left` : 'area empty', tone: 'primary', disabled: busy || searchesLeft <= 0 || s.team.state !== 'idle', onClick: () => act('captain_explore', {}).then((r) => r && openMission()) };
  const medkits = s.inventory?.medkit || 0;
  const weapons = Object.entries(s.inventory || {}).filter(([k]) => ['pistol', 'smg', 'sniper'].includes(k)) as [string, number][];
  const hp = s.team.hp;

  const webgl = hasWebGL();
  const zoneWarn = !!zone?.next_at && msUntil(zone.next_at) > 0;
  const markerDist = marker ? Math.hypot(marker[0] - myXY[0], marker[1] - myXY[1]) : 0;
  const markerBearing = marker ? Math.atan2(marker[0] - myXY[0], -(marker[1] - myXY[1])) : null;
  const markerPlace = marker ? map?.locations.filter((l) => l.kind !== 'start' && l.enabled)
    .map((l) => ({ l, d: Math.hypot(l.x - marker[0], l.y - marker[1]) })).sort((a, b) => a.d - b.d)[0] : null;
  const markerLoc = markerPlace && markerPlace.d < 0.05 ? markerPlace.l : null;
  async function runTo(id: string) {
    const r = await act('captain_move', { p_location: id });
    if (r) { sfx.go(); toast(`${!s.team.dropped ? 'Parachuting' : 'Running'} to ${SHORT[id] || locName(map, id)} · ${Math.round(r.seconds)}s`, 'info'); setMapOpen(false); }
  }
  // one banner, most urgent first (no stacked boxes over the view)
  const banner: { tone: string; text: React.ReactNode; arrow?: number } | null =
    s.arena.paused ? { tone: '', text: '⏸ Paused by the host' }
    : outside ? { tone: 'bad', text: 'Outside the safe zone — run!', arrow: zoneArrow }
    : inRed && msUntil(red.at) > 0 ? { tone: 'bad', text: <>Red zone! Get out <Countdown to={red.at} /></> }
    : s.team.state === 'recovery' ? { tone: 'bad', text: 'Squad down — solve the recovery puzzle' }
    : red && msUntil(red.at) > 0 ? { tone: 'warn', text: <>💥 Red zone strike in <Countdown to={red.at} /></> }
    : s.arena.phase === 'finale' ? { tone: 'warn', text: 'Finale in Training Room 14 — open the mission' }
    : !s.team.dropped && s.arena.phase === 'play' ? { tone: 'info', text: isCaptain ? '🪂 Open the map and pick where to drop' : '🪂 Your captain is picking a drop point' }
    : zoneWarn ? { tone: 'zone', text: <>Safe zone shrinking in <Countdown to={zone.next_at} /></> }
    : null;
  const travelDest = s.team.state === 'traveling' && s.team.travel_to ? map?.locations.find((l) => l.id === s.team.travel_to) : null;
  const world3d: WorldState = { ...state, waypoint: marker ? { x: marker[0], y: marker[1] } : null, route: travelDest ? { x: travelDest.x, y: travelDest.y } : null };

  return (
    <div className="world-screen">
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

      {/* top-left: minimap, zone timer, team */}
      <div className="hud-tl">
        {map && <MiniMap map={map} me={myXY} yaw={me.current.yaw || 0} squads={squads.map((x: any) => ({ ...x, me: x.id === s.team.id }))} zone={zone} red={red}
          drops={s.airdrops || []} marker={marker} overview={false} tag={zoneWarn ? <>☢ <Countdown to={zone.next_at} /></> : <>Zone {zone?.stage ?? s.arena.zone_stage}/5</>} warn={zoneWarn}
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

      {/* bottom centre: marker card / location, HP */}
      <div className="hud-bc">
        {marker ? (
          <div className="hud-marker">
            <span className="grow"><b>{markerLoc ? (SHORT[markerLoc.id] || markerLoc.name) : 'Marker'}</b> · {Math.round(markerDist * METERS)} m · {Math.max(1, Math.round(markerDist / world.speed))} s</span>
            {markerLoc && isCaptain && s.arena.phase === 'play' && here?.id !== markerLoc.id && (
              <button className="btn xs primary" disabled={busy || !canMove} onClick={() => runTo(markerLoc.id)}>{!s.team.dropped ? '🪂 Drop' : 'Run'}</button>
            )}
            <button className="btn xs ghost" onClick={() => setMarker(null)} aria-label="Remove marker">✕</button>
          </div>
        ) : (
          <div className="hud-loc">{here ? <>📍 {SHORT[here.id] || here.name}</> : travelDest ? <>🏃 To {SHORT[travelDest.id] || travelDest.name}</> : 'Open ground'}</div>
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
        : <div className="hud-bl-hint">{ROLES[s.me.role as Role]?.icon} You are {ROLES[s.me.role as Role]?.name}. <b>{s.roles?.captain || 'The captain'}</b> moves the squad.</div>}

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
          onRun={runTo} canRun={isCaptain && s.arena.phase === 'play' && canMove} speed={world.speed} onClose={() => setMapOpen(false)} />
      )}
    </div>
  );
}
