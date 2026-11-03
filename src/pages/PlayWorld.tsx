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

// ── Minimap ─────────────────────────────────────────────────────────────
function MiniMap({ map, me, squads, zone, red, drops, onClick, overview }: {
  map: MapData; me: XY | null; squads: any[]; zone: any; red: any; drops: any[]; onClick: () => void; overview: boolean;
}) {
  const cur = zone?.cur; const nxt = zone?.next;
  return (
    <button className="minimap" onClick={onClick} aria-label={overview ? 'Back to squad view' : 'Show whole campus'}>
      <svg viewBox="-0.02 -0.02 1.04 1.04" aria-hidden>
        <defs>
          <mask id="mm-safe"><rect x="-1" y="-1" width="3" height="3" fill="white" />{cur && <circle cx={cur[0]} cy={cur[1]} r={cur[2]} fill="black" />}</mask>
        </defs>
        <rect x="0" y="0" width="1" height="1" rx="0.04" fill="#0f1d2c" stroke="#3ea5ff" strokeOpacity="0.4" strokeWidth="0.01" />
        {map.locations.filter((l) => l.kind !== 'start').map((l) => (
          <circle key={l.id} cx={l.x} cy={Math.min(0.99, l.y)} r={l.id === 'tr14' ? 0.022 : 0.012} fill={l.id === 'tr14' ? '#ffc23d' : '#3d5878'} />
        ))}
        {cur && cur[2] < 0.86 && <rect x="-1" y="-1" width="3" height="3" fill="#2a6bff" opacity="0.35" mask="url(#mm-safe)" />}
        {nxt && <circle cx={nxt[0]} cy={nxt[1]} r={nxt[2]} fill="none" stroke="#fff" strokeWidth="0.012" />}
        {red && <circle cx={red.x} cy={red.y} r={red.r} fill="#ff2238" opacity="0.45" />}
        {drops.map((d: any) => { const l = map.locations.find((x) => x.id === d.location); return l ? <rect key={d.id} x={l.x - 0.02} y={l.y - 0.02} width="0.04" height="0.04" fill={TIER_COLOR[d.tier] || '#ffc23d'} /> : null; })}
        {squads.filter((x) => x.pos && !x.me).map((x) => <circle key={x.id} cx={x.pos[0]} cy={x.pos[1]} r="0.02" fill={x.allied ? '#5dff9e' : '#ff4d5e'} />)}
        {me && <circle cx={me[0]} cy={me[1]} r="0.03" fill="#3ef0ff" stroke="#fff" strokeWidth="0.008" />}
      </svg>
      <span className="mm-tag">{overview ? 'SQUAD VIEW' : 'FULL MAP'}</span>
    </button>
  );
}

// ── Kill feed ──────────────────────────────────────────────────────────
function KillFeed({ feed, map }: { feed: any[]; map: MapData | null }) {
  useNow(1000);
  const now = serverTime();
  const items = (feed || []).filter((f) => now - new Date(f.at).getTime() < 9000).slice(0, 4);
  return (
    <div className="killfeed" aria-live="polite">
      {items.map((f, i) => {
        const t = feedText(f.type, f.payload, map);
        return t ? <div key={`${i}-${f.at}-${f.type}`} className={`kf ${t.tone}`}>{t.text}</div> : null;
      })}
    </div>
  );
}

export default function WorldTab({ s, token, map, refresh, openMission, openSquad, onSettings, connected }: {
  s: any; token: string; map: MapData | null; refresh: () => void; openMission: () => void; openSquad: () => void; onSettings: () => void; connected: boolean;
}) {
  useNow(500);
  const isCaptain = s.me.role === 'captain';
  const world = s.arena.overlay?.world || { speed: 0.025, loc_radius: 0.035, engage_range: 0.06 };
  const zone = s.arena.overlay?.zone;
  const red = s.arena.overlay?.red && msUntil(s.arena.overlay.red.at) > -2000 ? s.arena.overlay.red : null;
  const canMove = isCaptain && s.arena.phase === 'play' && !s.arena.paused && s.team.state !== 'recovery' && !s.battle;
  const [mode, setMode] = useState<'follow' | 'overview'>('follow');
  const [zoom, setZoom] = useState(1);
  const [pick, setPick] = useState<string | null>(null);
  const [engage, setEngage] = useState(false);
  const [busy, setBusy] = useState(false);

  // ── own position: prediction while steering, server truth otherwise ──
  const serverPos = travelPos(s, map);
  const me = useRef<{ x: number; y: number; moving: boolean }>({ x: serverPos?.[0] ?? 0.5, y: serverPos?.[1] ?? 0.93, moving: false });
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
        me.current.x = clamp01(me.current.x + v.x * world.speed * dt);
        me.current.y = clamp01(me.current.y + v.y * world.speed * dt);
        me.current.moving = true;
        if (t - lastSend.current > 260) sendSteer();
      } else {
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
  const zoneArrow = outside && cur ? Math.atan2(cur[0] - myXY[0], -(cur[1] - myXY[1])) : 0;
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

  const pickLoc = map?.locations.find((l) => l.id === pick);
  const runSecs = pickLoc ? (!s.team.dropped ? 8 : Math.max(1, Math.round(Math.hypot(pickLoc.x - myXY[0], pickLoc.y - myXY[1]) / world.speed))) : 0;

  // primary context action
  let primary: { label: string; sub?: string; tone: string; onClick: () => void; disabled?: boolean } | null = null;
  if (s.battle) primary = { label: 'DUEL', sub: 'answer now', tone: 'danger', onClick: openMission };
  else if (s.mission) primary = { label: 'SOLVE', sub: s.mission.title, tone: 'primary', onClick: openMission };
  else if (s.team.state === 'recovery') primary = { label: 'REVIVE', sub: 'recovery', tone: 'good', onClick: openMission };
  else if (isCaptain && dropsHere.length) primary = { label: 'CRACK', sub: `${dropsHere[0].tier} crate`, tone: 'gold', disabled: busy, onClick: () => act('captain_claim_airdrop', { p_airdrop: dropsHere[0].id }).then((r) => r && openMission()) };
  else if (isCaptain && enemiesNear.length && !duelsLocked) primary = { label: 'ENGAGE', sub: `SQ ${enemiesNear[0].number}`, tone: 'danger', disabled: busy || !!cooldown, onClick: () => setEngage(true) };
  else if (isCaptain && here && s.arena.phase === 'play') primary = { label: 'SEARCH', sub: searchesLeft > 0 ? `${searchesLeft} left` : 'area empty', tone: 'primary', disabled: busy || searchesLeft <= 0 || s.team.state !== 'idle', onClick: () => act('captain_explore', {}).then((r) => r && openMission()) };
  const medkits = s.inventory?.medkit || 0;
  const weapons = Object.entries(s.inventory || {}).filter(([k]) => ['pistol', 'smg', 'sniper'].includes(k)) as [string, number][];
  const hp = s.team.hp;

  const webgl = hasWebGL();
  return (
    <div className="world-screen">
      <div className="world-view">
        {map && webgl ? (
          <Suspense fallback={<div className="world-loading">Loading 3D campus…</div>}>
            <World3D map={map} state={state} mode={mode} zoom={zoom} live={me} onPick={(id) => { sfx.tap(); setPick(id); }} />
          </Suspense>
        ) : map ? (
          <div style={{ padding: '120px 8px 0' }}>
            <CampusMap map={map} zoneStage={s.arena.zone_stage} squads={squads.map((x: any) => ({ number: x.number, location: x.location, me: x.id === s.team.id, allied: x.allied, in_battle: x.in_battle }))}
              airdrops={s.airdrops} selected={pick} onSelect={(id) => setPick(id)} height="60vh" />
          </div>
        ) : null}
      </div>

      {/* top-left: squad status */}
      <div className="hud-tl">
        <div className="hud-card">
          <div className="row between" style={{ gap: 6 }}>
            <b className="up" style={{ fontSize: 14 }}>SQ {s.team.number}</b>
            <span className="muted hud-name">{s.team.name}</span>
          </div>
          <HpBar hp={hp} shield={s.team.shield} />
          <div className="hud-team">
            {ROLE_ORDER.map((r: Role) => {
              const p = s.roster.find((x: any) => x.role === r);
              return (
                <span key={r} className={`hud-mate ${p?.online ? 'on' : ''} ${p?.me ? 'me' : ''}`} style={{ borderColor: ROLES[r].color }} title={`${ROLES[r].name}: ${p?.name || '—'}`}>
                  <i style={{ color: ROLES[r].color }}>{ROLES[r].icon}</i>{(p?.name || '—').slice(0, 7)}
                </span>
              );
            })}
          </div>
        </div>
        <div className="hud-loc">{here ? <>📍 {SHORT[here.id] || here.name}</> : s.team.state === 'traveling' ? <>🏃 Running to {SHORT[s.team.travel_to] || locName(map, s.team.travel_to)}</> : <>Open ground</>}</div>
        {(s.mission || s.battle) && (
          <button className={`hud-mission ${s.battle ? 'battle' : ''}`} onClick={openMission}>
            <span>{s.battle ? `⚔ DUEL · SQ ${s.battle.attacker} vs ${s.battle.defender}` : `◎ ${s.mission.title}`}</span>
            <b className="mono"><Countdown to={(s.battle || s.mission).deadline} low={20} /></b>
          </button>
        )}
        <KillFeed feed={s.feed} map={map} />
      </div>

      {/* top-right: minimap + score */}
      <div className="hud-tr">
        {map && <MiniMap map={map} me={myXY} squads={squads.map((x: any) => ({ ...x, me: x.id === s.team.id }))} zone={zone} red={red} drops={s.airdrops || []}
          overview={mode === 'overview'} onClick={() => { sfx.tap(); setMode((m) => (m === 'follow' ? 'overview' : 'follow')); }} />}
        <div className="row" style={{ gap: 6 }}>
          <div className="hud-stats">
            <span><b>{s.team.points}</b> PTS</span>
            <span style={{ color: 'var(--gold)' }}><b>{s.team.coins}</b> ¢</span>
          </div>
          <button className="hud-gear" onClick={onSettings} aria-label="Settings"><span className={`dot ${connected ? 'on' : ''}`} />⚙</button>
        </div>
        <div className="hud-phase">P{phase} · {MATCH_PHASES[phase]?.name}</div>
        {zone?.next_at && msUntil(zone.next_at) > 0
          ? <div className="hud-zone warn">☢ ZONE <Countdown to={zone.next_at} /></div>
          : <div className="hud-zone">◯ ZONE {zone?.stage ?? s.arena.zone_stage}/5</div>}
      </div>

      {/* center alerts */}
      <div className="hud-alerts" aria-live="assertive">
        {outside && (
          <div className="alert bad">
            <span className="arrow" style={{ transform: `rotate(${zoneArrow}rad)` }} aria-hidden>➤</span>
            OUTSIDE SAFE ZONE — RUN!
          </div>
        )}
        {red && !inRed && msUntil(red.at) > 0 && <div className="alert warn">💥 RED ZONE STRIKE IN <Countdown to={red.at} /></div>}
        {inRed && msUntil(red.at) > 0 && <div className="alert bad">💥 GET OUT OF THE RED ZONE <Countdown to={red.at} /></div>}
        {s.team.state === 'recovery' && <div className="alert bad">SQUAD DOWN — solve the recovery mission</div>}
        {s.arena.paused && <div className="alert">⏸ PAUSED BY HOST</div>}
        {s.arena.phase === 'finale' && <div className="alert warn">FINALE · Training Room 14 — open Mission</div>}
        {!s.team.dropped && s.arena.phase === 'play' && <div className="alert info">{isCaptain ? '🪂 Tap any glowing ring to parachute there — or drag to walk' : '🪂 Your captain is choosing where to drop'}</div>}
      </div>

      {/* bottom-left: joystick or role hint */}
      {isCaptain && s.arena.phase === 'play'
        ? <Joystick disabled={!canMove} onMove={(x, y) => { vec.current = { x, y }; }} />
        : <div className="hud-bl-hint">{ROLES[s.me.role as Role]?.icon} {ROLES[s.me.role as Role]?.name} · Captain <b>{s.roles?.captain || '—'}</b> moves the squad</div>}

      {/* bottom-right: actions */}
      <div className="hud-actions">
        <div className="act-col">
          <button className="act sm" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Zoom in">＋</button>
          <button className="act sm" onClick={() => setZoom((z) => Math.min(2.2, z * 1.25))} aria-label="Zoom out">－</button>
        </div>
        <div className="act-col">
          {isCaptain && medkits > 0 && hp < 100 && s.team.state !== 'recovery' && (
            <button className="act md good" disabled={busy} onClick={() => act('captain_use_item', { p_item: 'medkit' }, '+ HP')} aria-label="Use med kit">✚<small>{medkits}</small></button>
          )}
          <button className="act md" onClick={openSquad} aria-label="Bag and squad">🎒</button>
        </div>
        {primary && (
          <button className={`act lg ${primary.tone}`} disabled={primary.disabled} onClick={() => { buzz(15); primary!.onClick(); }}>
            <span>{primary.label}</span>{primary.sub && <small>{primary.sub}</small>}
          </button>
        )}
      </div>

      {/* tap a location: info + auto-run */}
      <Sheet open={!!pickLoc} onClose={() => setPick(null)} title={pickLoc?.name}>
        {pickLoc && (
          <div className="col">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="chip gold">{pickLoc.reward}</span>
              <span className="chip">Risk {'▲'.repeat(pickLoc.risk)}{'△'.repeat(Math.max(0, 3 - pickLoc.risk))}</span>
              {cur && Math.hypot(pickLoc.x - cur[0], pickLoc.y - cur[1]) > cur[2] && <span className="chip bad">Outside safe zone</span>}
              {(s.airdrops || []).some((a: any) => a.location === pickLoc.id) && <span className="chip warn">✈ Airdrop</span>}
            </div>
            <div className="muted" style={{ fontSize: 14 }}>Loot: {pickLoc.tags.join(', ')} · Squads here: {squads.filter((x: any) => x.location === pickLoc.id).map((x: any) => `#${x.number}`).join(', ') || 'none seen'}</div>
            {isCaptain && s.arena.phase === 'play' ? (
              <button className="btn primary big block" disabled={busy || !canMove || here?.id === pickLoc.id}
                onClick={async () => { const r = await act('captain_move', { p_location: pickLoc.id }); if (r) { sfx.go(); toast(`${!s.team.dropped ? 'Parachuting' : 'Running'} to ${SHORT[pickLoc.id] || pickLoc.name} · ${Math.round(r.seconds)}s`, 'info'); setPick(null); } }}>
                {here?.id === pickLoc.id ? 'You are here' : `${!s.team.dropped ? '🪂 Drop here' : '🏃 Auto-run'} · ~${runSecs}s`}
              </button>
            ) : <div className="notice">{isCaptain ? 'Movement opens during play.' : 'Tell your captain if you want to go here.'}</div>}
          </div>
        )}
      </Sheet>

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
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>A duel is a puzzle race: the first squad to answer wins and the loser takes damage. Pistol 25 · SMG 35 (fast) · Sniper 50 (hard).</p>
        </div>
      </Sheet>
    </div>
  );
}
