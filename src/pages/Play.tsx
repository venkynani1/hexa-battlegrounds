import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendly, GameError, newKey, rpc, store } from '../lib/api';
import { useLive } from '../lib/live';
import { msUntil, progress, secondsLeft, useNow, fmtClock, serverTime } from '../lib/time';
import { FINALE_STAGES, KIND_LABEL, locName, MapData, neighbors, ROLE_ORDER, ROLES, Role, TIER_COLOR, useMapData, ZONE_TEXT } from '../lib/game';
import { buzz, sfx, unlockAudio } from '../lib/sound';
import CampusMap from '../components/CampusMap';
import { Countdown, FeedList, HostOverlays, HpBar, Loading, SettingsSheet, Sheet, TimerBar, toast, ZoneChip } from '../components/ui';

type Tab = 'mission' | 'map' | 'squad' | 'comms';

export default function Play() {
  const nav = useNavigate();
  const token = store.get('hb_token');
  const map = useMapData();
  const fetcher = useCallback(() => rpc('player_state', { p_token: token }), [token]);
  const [topics, setTopics] = useState<string[]>([]);
  const live = useLive<any>(fetcher, {
    topics,
    pollMs: 8000,
    pollFastMs: 3500,
    enabled: !!token,
    deadlines: (s) => [s?.mission?.deadline, s?.battle?.deadline, s?.team?.travel_arrive_at, s?.team?.recovery_deadline,
      s?.arena?.shuttle_arrive_at, s?.arena?.roles_deadline, s?.arena?.zone_next_at, s?.mission?.relay?.fallback_at,
      s?.mission?.clue?.reveal_seconds ? new Date(new Date(s.mission.started_at).getTime() + s.mission.clue.reveal_seconds * 1000).toISOString() : null],
  });
  const s = live.data;
  const [tab, setTab] = useState<Tab>('mission');
  const [settings, setSettings] = useState(false);

  useEffect(() => { if (!token) nav('/join'); }, [token, nav]);
  useEffect(() => {
    if (s?.arena?.id && s?.team?.id) {
      const t = [`arena-${s.arena.id}`, `team-${s.team.id}`];
      if (t.join() !== topics.join()) setTopics(t);
    }
  }, [s?.arena?.id, s?.team?.id]);
  useEffect(() => {
    if (live.error instanceof GameError && live.error.code === 'AUTH') {
      store.del('hb_token');
      toast(friendly(live.error), 'bad');
      nav('/join');
    }
  }, [live.error, nav]);

  useGameEffects(s, map);

  if (!token) return null;
  if (!s) return <Loading text={live.error ? friendly(live.error) : 'Connecting to your squad…'} />;

  const phase = s.arena.phase;
  const role: Role | null = s.me.role;
  const isCaptain = role === 'captain';
  const inGame = phase === 'play' || phase === 'finale';
  const unread = isCaptain ? countUnread(s) : 0;

  return (
    <div className="app" onClick={() => unlockAudio()}>
      <HostOverlays overlay={s.arena.overlay} paused={s.arena.paused} />
      <TopBar s={s} onSettings={() => setSettings(true)} connected={live.connected} />
      <main className="content">
        {phase === 'lobby' && <Lobby s={s} />}
        {phase === 'boarding' && <Boarding s={s} />}
        {phase === 'shuttle' && <Shuttle s={s} />}
        {phase === 'roles' && <Roles s={s} token={token} refresh={live.refresh} />}
        {inGame && <RoleReveal s={s} />}
        {inGame && phase === 'finale' && <FinaleBanner s={s} />}
        {inGame && tab === 'mission' && <MissionTab s={s} token={token} map={map} refresh={live.refresh} goMap={() => setTab('map')} goComms={() => setTab('comms')} />}
        {inGame && tab === 'map' && map && <MapTab s={s} token={token} map={map} refresh={live.refresh} />}
        {inGame && tab === 'squad' && <SquadTab s={s} token={token} map={map} refresh={live.refresh} />}
        {inGame && tab === 'comms' && isCaptain && <CommsTab s={s} token={token} refresh={live.refresh} />}
        {(phase === 'results' || phase === 'ended') && <Results s={s} />}
      </main>
      {inGame && (
        <nav className="tabbar" aria-label="Game sections">
          <div className="tabbar-inner">
            <TabBtn id="mission" tab={tab} set={setTab} ico="◎" label={s.battle ? 'Battle' : 'Mission'} badge={s.battle ? '!' : undefined} />
            <TabBtn id="map" tab={tab} set={setTab} ico="⌖" label="Map" />
            <TabBtn id="squad" tab={tab} set={setTab} ico="⬡" label="Squad" badge={s.bargains?.length && isCaptain ? '!' : undefined} />
            {isCaptain && <TabBtn id="comms" tab={tab} set={setTab} ico="✉" label="Comms" badge={unread ? String(unread) : s.codewords?.length ? '!' : undefined} />}
          </div>
        </nav>
      )}
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

function TabBtn({ id, tab, set, ico, label, badge }: { id: Tab; tab: Tab; set: (t: Tab) => void; ico: string; label: string; badge?: string }) {
  return (
    <button className={`tab ${tab === id ? 'on' : ''}`} onClick={() => { sfx.tap(); set(id); }} aria-current={tab === id}>
      <span className="ico" aria-hidden>{ico}</span>{label}{badge && <span className="badge">{badge}</span>}
    </button>
  );
}

// ── Sounds, vibration and toasts driven by state changes ─────────────────
function useGameEffects(s: any, map: MapData | null) {
  const prev = useRef<any>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = s;
    if (!s || !p) return;
    if (p.arena.phase !== s.arena.phase) {
      if (s.arena.phase === 'shuttle') sfx.shuttle();
      if (s.arena.phase === 'roles') { sfx.gate(); buzz([80, 60, 80]); }
      if (s.arena.phase === 'play') sfx.go();
      if (s.arena.phase === 'finale') { sfx.reveal(); toast('FINALE — Training Room 14', 'warn'); }
    }
    if (s.mission?.id && s.mission.id !== p.mission?.id) { sfx.mission(); buzz(60); }
    if (s.battle?.id && s.battle.id !== p.battle?.id) {
      sfx.enemy(); buzz([200, 100, 200]);
      toast(s.battle.we_attacked ? `⚔ You engaged Squad ${s.battle.defender}!` : `⚔ ENEMY SQUAD ${s.battle.attacker} ATTACKS!`, 'bad');
    }
    if (s.last_result?.id && s.last_result.id !== p.last_result?.id) {
      if (s.last_result.status === 'solved') { sfx.success(); toast(`✔ ${s.last_result.title}${s.last_result.points ? ` +${s.last_result.points}` : ''}`, 'good'); }
      else if (s.last_result.status !== 'cancelled') { sfx.fail(); toast(`✖ ${s.last_result.title} — ${s.last_result.status}`, 'bad'); }
    }
    if (s.team.hp < p.team.hp) { sfx.damage(); buzz(300); toast(`−${p.team.hp - s.team.hp} HP`, 'bad'); }
    const pInv = Object.values(p.inventory || {}).reduce((a: number, b: any) => a + b, 0) as number;
    const sInv = Object.values(s.inventory || {}).reduce((a: number, b: any) => a + b, 0) as number;
    if (sInv > pInv) sfx.loot();
    if (s.arena.zone_next_at && s.arena.zone_next_at !== p.arena.zone_next_at) { sfx.zone(); buzz([300, 100, 300]); toast(`☢ Zone collapsing — ${ZONE_TEXT[s.arena.zone_stage + 1] || ''}`, 'bad'); }
    if ((s.airdrops?.length || 0) > (p.airdrops?.length || 0)) { sfx.airdrop(); toast(`✈ Airdrop at ${locName(map, s.airdrops[0]?.location)}`, 'warn'); }
    if (s.story?.[0]?.at && s.story[0].at !== p.story?.[0]?.at) { sfx.transmission(); toast(`▓ Squad 00: ${s.story[0].title}`, 'warn'); }
    if (s.team.state === 'traveling' && p.team.state !== 'traveling') sfx.tap();
    if (p.team.state === 'traveling' && s.team.state === 'idle') sfx.gate();
    const newMsg = (s.comms?.messages?.length || 0) > (p.comms?.messages?.length || 0) && !s.comms.messages.at(-1)?.mine;
    if (newMsg) { sfx.tap(); toast(`✉ Message from Squad ${s.comms.messages.at(-1).from_number}`, 'info'); }
  }, [s, map]);
}

function countUnread(s: any) {
  const seen = Number(store.get('hb_seen_msg') || 0);
  return (s.comms?.messages || []).filter((m: any) => !m.mine && m.id > seen).length;
}

// ── Top HUD ─────────────────────────────────────────────────────────────
function TopBar({ s, onSettings, connected }: { s: any; onSettings: () => void; connected: boolean }) {
  const role: Role | null = s.me.role;
  return (
    <header className="topbar">
      <div className="row between" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className="up" style={{ fontSize: 18 }}>SQ {s.team.number}</span>
          <span className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.team.name} · {s.arena.name}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {role && <span className="role-badge" style={{ color: ROLES[role].color }}>{ROLES[role].icon} {ROLES[role].name}</span>}
          <span className={`dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Polling'} aria-label={connected ? 'Live connection' : 'Reconnecting'} />
          <button className="btn xs ghost" onClick={onSettings} aria-label="Settings">⚙</button>
        </div>
      </div>
      {(s.arena.phase === 'play' || s.arena.phase === 'finale') && (
        <div className="row" style={{ marginTop: 8, gap: 12 }}>
          <div className="grow"><HpBar hp={s.team.hp} shield={s.team.shield} /></div>
          <div className="stat"><b>{s.team.points}</b><span>Pts</span></div>
          <div className="stat"><b style={{ color: 'var(--gold)' }}>{s.team.coins}</b><span>Coins</span></div>
          <div className="stat"><b style={{ color: 'var(--green)' }}>{s.team.trust}</b><span>Trust</span></div>
        </div>
      )}
      {(s.arena.phase === 'play') && (
        <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
          <ZoneChip stage={s.arena.zone_stage} next={s.arena.zone_next_at} />
          {s.team.state === 'recovery' && <span className="chip bad">✚ Recovery</span>}
          {s.team.protected_until && msUntil(s.team.protected_until) > 0 && <span className="chip good">🛡 Protected <Countdown to={s.team.protected_until} /></span>}
          {s.team.jammed_until && msUntil(s.team.jammed_until) > 0 && <span className="chip">📡 Jammed <Countdown to={s.team.jammed_until} /></span>}
          {s.team.scan_until && msUntil(s.team.scan_until) > 0 && <span className="chip">🛰 Scanning <Countdown to={s.team.scan_until} /></span>}
        </div>
      )}
    </header>
  );
}

// ── Pre-game phases ─────────────────────────────────────────────────────
function Lobby({ s }: { s: any }) {
  const n = s.roster.length;
  return (
    <>
      <div className="panel">
        <div className="panel-title">Squad lobby</div>
        <div className="row between"><h2 style={{ fontSize: 28 }}>{s.team.name}</h2><span className={`chip ${n === 4 ? 'good' : 'warn'}`}>{n}/4</span></div>
        <div className="list" style={{ marginTop: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="list-item">
              <span className={`dot ${s.roster[i]?.online ? 'on' : ''}`} />
              <span className="grow">{s.roster[i] ? s.roster[i].name : <span className="dim">Waiting for player…</span>}</span>
              {s.roster[i]?.me && <span className="chip">You</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <p style={{ margin: 0 }}>{n < 4 ? 'Your squad needs exactly 4 players. Ask your teammates to join with the same squad number and PIN.' : 'Squad ready! Waiting for the host to open the shuttles.'}</p>
      </div>
      <HowToPlay />
    </>
  );
}

function HowToPlay() {
  return (
    <div className="panel">
      <div className="panel-title">How it works</div>
      <div className="col" style={{ gap: 8, fontSize: 14 }}>
        {ROLE_ORDER.map((r) => (
          <div key={r} className="row" style={{ alignItems: 'flex-start' }}>
            <span style={{ color: ROLES[r].color, fontSize: 20, width: 24 }} aria-hidden>{ROLES[r].icon}</span>
            <div><b style={{ color: ROLES[r].color }}>{ROLES[r].name}.</b> <span className="muted">{ROLES[r].blurb}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Boarding({ s }: { s: any }) {
  return (
    <div className="panel center col" style={{ alignItems: 'center', padding: 24 }}>
      <div className="panel-title">SIPCOT Entrance</div>
      <div style={{ fontSize: 64 }} aria-hidden>🚌</div>
      <div className="mega" style={{ fontSize: 56 }}>BUS {s.team.bus ?? '—'}</div>
      <div className="muted">Squad {s.team.number} · {s.roster.map((r: any) => r.name).join(', ')}</div>
      <span className="chip warn">Boarded · awaiting departure</span>
    </div>
  );
}

function Shuttle({ s }: { s: any }) {
  useNow(100);
  const p = progress(s.arena.shuttle_departed_at, s.arena.shuttle_arrive_at);
  return (
    <div className="panel col" style={{ padding: 22 }}>
      <div className="panel-title">Shuttle {s.team.bus} en route</div>
      <div className="row between up" style={{ fontSize: 13 }}><span>SIPCOT</span><span>Gate 1</span></div>
      <div style={{ position: 'relative', height: 60, borderBottom: '3px dashed var(--line-strong)' }}>
        <div style={{ position: 'absolute', left: `calc(${p * 100}% - 30px)`, bottom: 4, fontSize: 44, transition: 'left 0.1s linear' }} aria-hidden>🚌</div>
      </div>
      <div className="center timer-big">{secondsLeft(s.arena.shuttle_arrive_at)}s</div>
      <p className="center muted" style={{ margin: 0 }}>Get ready: at Gate 1 you must claim your role — fast!</p>
    </div>
  );
}

function Roles({ s, token, refresh }: { s: any; token: string; refresh: () => void }) {
  useNow(200);
  const [busy, setBusy] = useState<string | null>(null);
  const left = secondsLeft(s.arena.roles_deadline);
  async function claim(r: Role) {
    unlockAudio();
    setBusy(r);
    try { await rpc('claim_role', { p_token: token, p_role: r }); sfx.success(); buzz(80); }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { setBusy(null); refresh(); }
  }
  return (
    <>
      <div className="panel warn center">
        <div className="kind-tag">Gate 1 · Identity check</div>
        <h2 style={{ fontSize: 30, marginTop: 6 }}>Claim your role!</h2>
        <div className={`timer-big ${left <= 5 ? 'low' : ''}`} style={{ marginTop: 8 }}>{left}s</div>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>First tap wins. Unclaimed roles are assigned automatically.</p>
      </div>
      <div className="role-grid">
        {ROLE_ORDER.map((r) => {
          const holder = s.roles?.[r];
          const mine = s.me.role === r;
          return (
            <button key={r} className={`role-tile ${holder && !mine ? 'taken' : ''} ${mine ? 'mine' : ''}`} style={{ color: ROLES[r].color }}
              disabled={!!holder || !!s.me.role || !!busy || left === 0} onClick={() => claim(r)} aria-label={`Claim ${ROLES[r].name}`}>
              <span className="ico" aria-hidden>{ROLES[r].icon}</span>
              <span className="nm">{ROLES[r].name}</span>
              <span className="who">{holder ? (mine ? 'YOU' : holder) : busy === r ? 'Claiming…' : 'Available'}</span>
            </button>
          );
        })}
      </div>
      {s.me.role && <div className="panel good center">You are the <b style={{ color: ROLES[s.me.role as Role].color }}>{ROLES[s.me.role as Role].name}</b>. {ROLES[s.me.role as Role].blurb}</div>}
    </>
  );
}

function RoleReveal({ s }: { s: any }) {
  const key = `hb_reveal_${s.team.id}_${s.me.role}`;
  const [show, setShow] = useState(() => !!s.me.role && !store.get(key));
  useEffect(() => {
    if (!show) return;
    sfx.reveal();
    store.set(key, '1');
    const t = setTimeout(() => setShow(false), 4500);
    return () => clearTimeout(t);
  }, [show, key]);
  if (!show || !s.me.role) return null;
  const r = ROLES[s.me.role as Role];
  return (
    <div className="modal-bg" onClick={() => setShow(false)} style={{ zIndex: 70 }}>
      <div className="center col result-flash" style={{ alignItems: 'center', gap: 12 }}>
        <div className="up muted">You are the</div>
        <div style={{ fontSize: 80, color: r.color, lineHeight: 1 }} aria-hidden>{r.icon}</div>
        <div className="mega" style={{ color: r.color, fontSize: 64 }}>{r.name}</div>
        <p style={{ maxWidth: 360 }}>{r.blurb}</p>
        <div className="muted" style={{ fontSize: 13 }}>Captain: <b>{s.roles?.captain}</b></div>
      </div>
    </div>
  );
}

function FinaleBanner({ s }: { s: any }) {
  const st = FINALE_STAGES[s.arena.finale_stage] || FINALE_STAGES.A;
  return (
    <div className="panel warn">
      <div className="kind-tag">Final battleground · Training Room 14</div>
      <div className="row between"><h3 style={{ fontSize: 22 }}>Stage {s.arena.finale_stage}: {st.name}</h3></div>
      <div className="muted" style={{ fontSize: 13 }}>{st.text}</div>
    </div>
  );
}

// ── Mission tab ─────────────────────────────────────────────────────────
function MissionTab({ s, token, map, refresh, goMap, goComms }: { s: any; token: string; map: MapData | null; refresh: () => void; goMap: () => void; goComms: () => void }) {
  const isCaptain = s.me.role === 'captain';
  return (
    <>
      {s.team.state === 'recovery' && (
        <div className="panel danger center">
          <div className="kind-tag" style={{ color: 'var(--red)' }}>Squad down · Recovery mode</div>
          <p style={{ margin: '6px 0' }}>Not eliminated! Solve the recovery mission to respawn with 50 HP. If time runs out you respawn anyway.</p>
          <div className="up">Respawn in <Countdown to={s.team.recovery_deadline} /></div>
        </div>
      )}
      {s.battle && <ActivityCard a={s.battle} s={s} token={token} refresh={refresh} battle />}
      {s.mission && <ActivityCard a={s.mission} s={s} token={token} refresh={refresh} />}
      {!s.mission && !s.battle && s.team.state === 'traveling' && <Travel s={s} map={map} />}
      {!s.mission && !s.battle && s.team.state === 'idle' && s.arena.phase === 'play' && (
        <Idle s={s} token={token} map={map} refresh={refresh} goMap={goMap} goComms={goComms} />
      )}
      {!s.mission && !s.battle && s.arena.phase === 'finale' && (
        <div className="panel center"><div className="kind-tag">Standby</div><p>All squads are in Training Room 14. The next synchronized challenge starts when the host launches it.</p></div>
      )}
      {!isCaptain && !s.mission && !s.battle && s.arena.phase === 'play' && (
        <div className="panel"><div className="panel-title">Your job</div><p style={{ margin: 0 }} className="muted">{ROLES[s.me.role as Role]?.blurb} Your clue appears here when a mission starts. Your captain picks where to go.</p></div>
      )}
    </>
  );
}

function Travel({ s, map }: { s: any; map: MapData | null }) {
  useNow(150);
  const p = progress(s.team.travel_started_at, s.team.travel_arrive_at);
  return (
    <div className="panel col">
      <div className="panel-title">Moving out</div>
      <div className="row between up" style={{ fontSize: 13 }}><span>{locName(map, s.team.travel_from)}</span><span>{locName(map, s.team.travel_to)}</span></div>
      <div className="bar timer"><i style={{ width: `${p * 100}%` }} /></div>
      <div className="center timer-big">{secondsLeft(s.team.travel_arrive_at)}s</div>
      <p className="muted center" style={{ margin: 0, fontSize: 13 }}>A mission unlocks as soon as you arrive.</p>
    </div>
  );
}

function Idle({ s, token, map, refresh, goMap, goComms }: { s: any; token: string; map: MapData | null; refresh: () => void; goMap: () => void; goComms: () => void }) {
  const isCaptain = s.me.role === 'captain';
  const here = (s.squads || []).filter((x: any) => x.location === s.team.location && x.id !== s.team.id && !x.traveling);
  const drops = (s.airdrops || []).filter((a: any) => a.location === s.team.location);
  const loc = map?.locations.find((l) => l.id === s.team.location);
  const [busy, setBusy] = useState(false);
  const [weapon, setWeapon] = useState('pistol');
  const weapons = Object.entries(s.inventory || {}).filter(([k]) => ['pistol', 'smg', 'sniper'].includes(k));
  const left = (s.team.visit_limit ?? 2) - (s.team.visit_missions ?? 0);
  const cooldown = s.team.attack_cooldown_until && msUntil(s.team.attack_cooldown_until) > 0;

  async function act(fn: string, args: any, ok?: string) {
    setBusy(true);
    try { await rpc(fn, { p_token: token, ...args }); if (ok) toast(ok, 'good'); sfx.tap(); }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { setBusy(false); refresh(); }
  }

  return (
    <>
      <div className="panel">
        <div className="panel-title">Current position</div>
        <h2 style={{ fontSize: 26 }}>{loc?.name || (s.team.location === 'gate_1' ? 'Gate 1' : '—')}</h2>
        {loc && <div className="muted" style={{ fontSize: 13 }}>{loc.reward} · Risk {'▲'.repeat(loc.risk)}{'△'.repeat(3 - loc.risk)}</div>}
        {!s.team.dropped && s.team.location === 'gate_1' && <p style={{ marginBottom: 0 }}>You are at Gate 1. {isCaptain ? 'Choose your first drop zone on the map.' : 'Your captain is choosing the first drop zone.'}</p>}
        {isCaptain && (
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary grow" onClick={goMap}>⌖ Choose destination</button>
            {s.team.dropped && <button className="btn grow" disabled={busy || left <= 0} onClick={() => act('captain_explore', {})}>Search area ({Math.max(0, left)} left)</button>}
          </div>
        )}
      </div>

      {drops.map((d: any) => (
        <div key={d.id} className="panel warn">
          <div className="kind-tag" style={{ color: TIER_COLOR[d.tier] }}>✈ {d.tier} airdrop here</div>
          <p style={{ margin: '6px 0' }}>First squad to crack the crate lock takes the loot. Expires in <Countdown to={d.expires_at} />.</p>
          {isCaptain && <button className="btn warn block" disabled={busy} onClick={() => act('captain_claim_airdrop', { p_airdrop: d.id })}>Crack the airdrop</button>}
        </div>
      ))}

      {here.length > 0 && (
        <div className="panel danger">
          <div className="kind-tag" style={{ color: 'var(--red)' }}>Enemy squad detected</div>
          <div className="list" style={{ marginTop: 8 }}>
            {here.map((x: any) => (
              <div key={x.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                <b>Squad {x.number}</b><span className="muted grow">{x.name}</span>
                {x.allied && <span className="chip good">Ally</span>}
                {x.protected && <span className="chip">Protected</span>}
                {x.in_battle && <span className="chip bad">In battle</span>}
                {isCaptain && (
                  <div className="row wrap" style={{ width: '100%', gap: 6 }}>
                    <select className="input" style={{ minHeight: 38, padding: 6, width: 'auto', flex: 1 }} value={weapon} onChange={(e) => setWeapon(e.target.value)} aria-label="Weapon">
                      {weapons.map(([k, q]) => <option key={k} value={k}>{k.toUpperCase()}{k !== 'pistol' ? ` ×${q}` : ''}</option>)}
                    </select>
                    <button className="btn sm danger" disabled={busy || x.protected || x.in_battle || cooldown}
                      onClick={() => { sfx.weapon(); act('captain_attack', { p_target: x.id, p_weapon: weapon }); }}>
                      {cooldown ? <>Cooldown <Countdown to={s.team.attack_cooldown_until} /></> : x.allied ? 'Betray' : 'Engage'}
                    </button>
                    {!x.allied && <button className="btn sm ghost" disabled={busy} onClick={() => act('captain_alliance', { p_action: 'propose', p_team: x.number, p_alliance: null }, 'Alliance proposed')}>Ally</button>}
                    <button className="btn sm ghost" onClick={goComms}>Message</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!isCaptain && <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>Only your captain can engage, ally or trade.</p>}
        </div>
      )}
    </>
  );
}

function ActivityCard({ a, s, token, refresh, battle = false }: { a: any; s: any; token: string; refresh: () => void; battle?: boolean }) {
  useNow(500);
  const isCaptain = s.me.role === 'captain';
  const parts: string[] = a.parts || [];
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const pendingKey = useRef<string | null>(null);
  useEffect(() => { setAnswers(parts.map(() => '')); pendingKey.current = null; }, [a.id]);

  async function submit() {
    if (answers.some((x) => !x.trim())) { toast('Fill in every box', 'warn'); return; }
    setBusy(true);
    const key = pendingKey.current || newKey();
    pendingKey.current = key;
    try {
      const r = await rpc('captain_submit', { p_token: token, p_instance: a.id, p_answers: answers, p_idem: key });
      pendingKey.current = null;
      if (!r.correct) { sfx.fail(); buzz(200); setShake(true); setTimeout(() => setShake(false), 500); toast(`Wrong — ${r.attempts_left} attempt${r.attempts_left === 1 ? '' : 's'} left`, 'bad'); }
    } catch (e) {
      if (!(e instanceof GameError && e.code === 'NETWORK')) pendingKey.current = null;
      toast(friendly(e), 'bad');
    } finally { setBusy(false); refresh(); }
  }
  async function hint() {
    try { await rpc('captain_hint', { p_token: token, p_instance: a.id }); sfx.tap(); } catch (e) { toast(friendly(e), 'bad'); }
    refresh();
  }

  const clue = a.clue;
  const revealLeft = clue?.reveal_seconds && !clue.expired ? Math.max(0, clue.reveal_seconds - Math.floor((serverTime() - new Date(a.started_at).getTime()) / 1000)) : null;

  return (
    <div className={`panel ${battle ? 'danger' : a.kind === 'recovery' ? 'good' : a.sync ? 'warn' : ''} ${shake ? 'shake' : ''}`}>
      <div className="row between">
        <span className="kind-tag" style={battle ? { color: 'var(--red)' } : undefined}>
          {battle ? `⚔ Battle · Squad ${a.attacker} vs Squad ${a.defender}` : KIND_LABEL[a.kind] || 'Mission'}
        </span>
        <span className="chip">{a.attempts_left} tries</span>
      </div>
      <div className="row between" style={{ marginTop: 6, alignItems: 'flex-end' }}>
        <h2 style={{ fontSize: 24 }}>{a.title}</h2>
        <Countdown to={a.deadline} className="timer-big" low={20} />
      </div>
      <div style={{ margin: '8px 0' }}><TimerBar start={a.started_at || s.server_now} end={a.deadline} /></div>
      <p style={{ margin: '0 0 10px' }}>{a.objective}</p>
      {battle && <div className="notice bad" style={{ marginBottom: 10 }}>Loser takes {a.damage} damage · First correct answer wins</div>}

      {a.relay && (
        <div className="notice warn" style={{ marginBottom: 10 }}>
          ✉ Squad {a.relay.partner}’s captain holds your codeword.{' '}
          {msUntil(a.relay.fallback_at) > 0 ? <>Backup intel in <b><Countdown to={a.relay.fallback_at} /></b> (half reward).</> : 'Backup copy delivered to your Intel Officer.'}
        </div>
      )}

      {!isCaptain && clue && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row between">
            <span className="up" style={{ color: ROLES[s.me.role as Role].color, fontSize: 13 }}>{ROLES[s.me.role as Role].icon} {clue.title}</span>
            {revealLeft !== null && <span className="chip bad">Vanishes in {revealLeft}s</span>}
          </div>
          <div className={`clue ${clue.mono ? 'mono' : ''} ${clue.expired ? 'expired' : ''} ${clue.reveal_seconds && !clue.expired ? 'big' : ''}`}>{clue.body}</div>
          {a.relay_backup && <div className="panel good"><div className="panel-title">Backup codeword</div><div className="clue big mono">{a.relay_backup}</div></div>}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Tell your captain what you see. Only the captain can submit.</p>
        </div>
      )}

      {isCaptain && (
        <div className="col" style={{ gap: 8 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Your Scout, Decoder and Intel Officer each hold a different piece. Ask them!</p>
          {parts.map((label, i) => (
            <div key={i} className="field">
              <label htmlFor={`ans${i}`}>{label}</label>
              <input id={`ans${i}`} className="input mono" value={answers[i] || ''} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                onChange={(e) => setAnswers((x) => x.map((v, j) => (j === i ? e.target.value : v)))}
                onKeyDown={(e) => { if (e.key === 'Enter' && i === parts.length - 1) submit(); }} />
            </div>
          ))}
          {a.hint && <div className="notice gold">💡 {a.hint}</div>}
          <div className="row">
            <button className={`btn big grow ${battle ? 'danger' : 'primary'}`} disabled={busy} onClick={submit}>{busy ? 'Checking…' : 'Submit answer'}</button>
            {!battle && !a.hint && a.hint_cost != null && <button className="btn ghost" onClick={hint} disabled={busy || s.team.coins < a.hint_cost}>Hint<br />{a.hint_cost}c</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Map tab ────────────────────────────────────────────────────────────
function MapTab({ s, token, map, refresh }: { s: any; token: string; map: MapData; refresh: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCaptain = s.me.role === 'captain';
  const reachable = useMemo(() => {
    if (s.team.state !== 'idle') return new Map<string, number>();
    if (!s.team.dropped && s.team.location === 'gate_1') {
      return new Map(map.locations.filter((l) => l.drop && l.enabled && l.collapse > s.arena.zone_stage).map((l) => [l.id, 8]));
    }
    const n = neighbors(map, s.team.location);
    for (const id of [...n.keys()]) {
      const l = map.locations.find((x) => x.id === id);
      if (!l || !l.enabled || l.collapse <= s.arena.zone_stage || l.kind === 'start') n.delete(id);
    }
    return n;
  }, [map, s.team.location, s.team.dropped, s.team.state, s.arena.zone_stage]);
  const loc = map.locations.find((l) => l.id === sel);
  const squads = (s.squads || []).map((x: any) => ({
    number: x.number, location: x.location, me: x.id === s.team.id, allied: x.allied, in_battle: x.in_battle,
    travel_to: x.id === s.team.id ? s.team.travel_to : null, travel_from: x.id === s.team.id ? s.team.travel_from : null,
    travel_started_at: x.id === s.team.id ? s.team.travel_started_at : null, travel_arrive_at: x.id === s.team.id ? s.team.travel_arrive_at : null,
  }));
  const zoneWarn = !!s.arena.zone_next_at && msUntil(s.arena.zone_next_at) > 0;

  async function go() {
    if (!sel) return;
    setBusy(true);
    try {
      await rpc('captain_move', { p_token: token, p_location: sel });
      sfx.go(); toast(`Moving to ${loc?.name}`, 'info'); setSel(null);
    } catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { setBusy(false); refresh(); }
  }

  const sameBuilding = loc?.building ? map.locations.filter((l) => l.building === loc.building) : [];
  return (
    <>
      <CampusMap map={map} zoneStage={s.arena.zone_stage} zoneWarning={zoneWarn} squads={squads}
        airdrops={s.airdrops} selected={sel} onSelect={(id) => { sfx.tap(); setSel(id); }} reachable={isCaptain ? reachable : undefined} height="58vh" />
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="chip">☢ {ZONE_TEXT[s.arena.zone_stage]}</span>
        {isCaptain && s.team.state === 'idle' && s.arena.phase === 'play' && <span className="chip" style={{ borderColor: 'var(--cyan)' }}>Dashed ring = reachable</span>}
      </div>
      <Sheet open={!!loc} onClose={() => setSel(null)} title={loc?.name}>
        {loc && (
          <div className="col">
            <div className="row wrap" style={{ gap: 6 }}>
              {loc.building && <span className="chip">{loc.building.toUpperCase()}{loc.floor ? ` · Floor ${loc.floor}` : ''}</span>}
              <span className="chip">Risk {'▲'.repeat(loc.risk)}{'△'.repeat(Math.max(0, 3 - loc.risk))}</span>
              <span className="chip gold">{loc.reward}</span>
              {loc.collapse <= s.arena.zone_stage ? <span className="chip bad">Danger zone</span>
                : loc.collapse === s.arena.zone_stage + 1 ? <span className="chip warn">Collapses next</span> : <span className="chip good">Safe</span>}
            </div>
            {sameBuilding.length > 1 && (
              <div className="field"><span className="label">Floors in this building</span>
                <div className="row wrap" style={{ gap: 6 }}>
                  {sameBuilding.sort((a, b) => String(a.floor).localeCompare(String(b.floor))).map((l) => (
                    <button key={l.id} className={`btn xs ${l.id === sel ? 'primary' : 'ghost'}`} onClick={() => setSel(l.id)}>{l.floor ?? '·'} {l.name.split('(')[0].trim()}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="muted" style={{ fontSize: 14 }}>
              Squads here: {(s.squads || []).filter((x: any) => x.location === loc.id).map((x: any) => `#${x.number}`).join(', ') || 'none visible'}
              {(s.airdrops || []).some((a: any) => a.location === loc.id) && ' · ✈ airdrop!'}
            </div>
            {isCaptain && s.arena.phase === 'play' && (
              reachable.has(loc.id)
                ? <button className="btn primary big block" disabled={busy} onClick={go}>Deploy · {reachable.get(loc.id)}s</button>
                : <div className="notice">{loc.id === s.team.location ? 'You are here.' : s.team.state !== 'idle' ? 'Finish your current action first.' : 'Not directly reachable from here — move to a neighbouring location first.'}</div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── Squad tab ───────────────────────────────────────────────────────────
function SquadTab({ s, token, map, refresh }: { s: any; token: string; map: MapData | null; refresh: () => void }) {
  const isCaptain = s.me.role === 'captain';
  const [busy, setBusy] = useState(false);
  const loc = map?.locations.find((l) => l.id === s.team.location);
  const market = loc && (loc.tags.includes('market') || loc.tags.includes('social')) && s.team.state === 'idle';
  async function act(fn: string, args: any, ok?: string) {
    setBusy(true);
    try { await rpc(fn, { p_token: token, ...args }); if (ok) toast(ok, 'good'); sfx.loot(); }
    catch (e) { toast(friendly(e), 'bad'); sfx.fail(); }
    finally { setBusy(false); refresh(); }
  }
  const items = map?.items || [];
  const myRank = (s.leaderboard || []).findIndex((r: any) => r.number === s.team.number) + 1;
  return (
    <>
      <div className="panel">
        <div className="panel-title">Squad {s.team.number} roster</div>
        <div className="list">
          {s.roster.map((r: any, i: number) => (
            <div key={i} className="list-item">
              <span className={`dot ${r.online ? 'on' : 'off'}`} aria-label={r.online ? 'online' : 'offline'} />
              <span className="grow">{r.name}{r.me ? ' (you)' : ''}</span>
              {r.role && <span className="role-badge" style={{ color: ROLES[r.role as Role].color, fontSize: 11 }}>{ROLES[r.role as Role].icon} {ROLES[r.role as Role].name}</span>}
            </div>
          ))}
        </div>
      </div>

      {s.bargains?.length > 0 && s.bargains.map((b: any) => (
        <div key={b.id} className="panel danger scanlines">
          <div className="kind-tag transmission">▓ Squad 00 offers a deal</div>
          <h3 style={{ marginTop: 6 }}>{b.title}</h3>
          <p className="transmission" style={{ whiteSpace: 'pre-wrap' }}>{b.body}</p>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="chip gold">+{b.offer?.coins ?? 0} coins</span>
            <span className="chip bad">{b.offer?.trust ?? 0} trust</span>
            <span className="chip bad">+{b.offer?.threat ?? 1} threat</span>
          </div>
          {isCaptain ? (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn danger grow" disabled={busy} onClick={() => act('captain_bargain', { p_story: b.id, p_accept: true }, 'Deal accepted…')}>Accept</button>
              <button className="btn ghost grow" disabled={busy} onClick={() => act('captain_bargain', { p_story: b.id, p_accept: false }, 'Deal refused')}>Refuse</button>
            </div>
          ) : <p className="muted" style={{ fontSize: 13 }}>Your captain decides. Every choice is recorded for the finale.</p>}
        </div>
      ))}

      <div className="panel">
        <div className="panel-title">Inventory</div>
        {Object.keys(s.inventory || {}).length === 0 && <p className="muted" style={{ margin: 0 }}>Empty. Complete missions to collect loot.</p>}
        <div className="list">
          {Object.entries(s.inventory || {}).map(([id, qty]: any) => {
            const it = items.find((x) => x.id === id);
            const weapon = it?.kind === 'weapon';
            return (
              <div key={id} className="list-item">
                <div className="grow"><b>{it?.name || id}</b> <span className="muted">×{qty}</span><div className="muted" style={{ fontSize: 12 }}>{it?.description}</div></div>
                {isCaptain && !weapon && <button className="btn sm" disabled={busy} onClick={() => act('captain_use_item', { p_item: id }, `${it?.name} used`)}>Use</button>}
                {weapon && <span className="chip">Use when enemies are near</span>}
              </div>
            );
          })}
        </div>
      </div>

      {market && (
        <div className="panel good">
          <div className="panel-title">{loc!.tags.includes('market') ? 'Hexadine supply market' : 'Hexacafe intel market'}</div>
          <div className="list">
            {items.filter((it) => it.price > 0 && (loc!.tags.includes('market') || ['intel', 'stealth', 'airdrop'].includes(it.kind))).map((it) => (
              <div key={it.id} className="list-item">
                <div className="grow"><b>{it.name}</b><div className="muted" style={{ fontSize: 12 }}>{it.description}</div></div>
                {isCaptain ? <button className="btn sm gold" disabled={busy || s.team.coins < it.price} onClick={() => act('captain_buy', { p_item: it.id }, `Bought ${it.name}`)}>{it.price}c</button> : <span className="chip gold">{it.price}c</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {s.alliances?.length > 0 && (
        <div className="panel">
          <div className="panel-title">Alliances</div>
          <div className="list">
            {s.alliances.map((al: any) => (
              <div key={al.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                <span className="grow">Squad {al.other} · {al.status === 'active' ? <>active <Countdown to={al.expires_at} /></> : al.incoming ? 'wants to ally with you' : 'proposal sent'}</span>
                {isCaptain && al.status === 'proposed' && al.incoming && <>
                  <button className="btn sm primary" disabled={busy} onClick={() => act('captain_alliance', { p_action: 'accept', p_team: null, p_alliance: al.id }, 'Alliance formed')}>Accept</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => act('captain_alliance', { p_action: 'decline', p_team: null, p_alliance: al.id })}>Decline</button>
                </>}
                {isCaptain && al.status === 'active' && <button className="btn sm ghost" disabled={busy} onClick={() => act('captain_alliance', { p_action: 'end', p_team: null, p_alliance: al.id })}>End</button>}
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Alliance: both pay 10 coins, both gain 10 trust and always see each other on the map. Attacking an ally is a betrayal: −20 trust and the Squad 00 threat rises.</p>
        </div>
      )}

      {s.story?.length > 0 && (
        <div className="panel scanlines">
          <div className="panel-title">Squad 00 transmissions</div>
          {s.story.map((st: any, i: number) => (
            <div key={i} style={{ marginBottom: 8 }}><b className="transmission">{st.title}</b><div className="transmission" style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{st.body}</div></div>
          ))}
        </div>
      )}

      {s.leaderboard && (
        <div className="panel">
          <div className="panel-title">Leaderboard · you are #{myRank || '—'}</div>
          <div className="list">
            {s.leaderboard.slice(0, 8).map((r: any, i: number) => (
              <div key={r.number} className="list-item" style={r.number === s.team.number ? { borderColor: 'var(--gold)' } : undefined}>
                <b style={{ width: 26 }}>{i + 1}</b><span className="grow">Squad {r.number} · {r.name}</span><b>{r.points}</b>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel"><div className="panel-title">Live feed</div><FeedList feed={s.feed} map={map} limit={8} /></div>
    </>
  );
}

// ── Comms tab (captain only) ───────────────────────────────────────────
function CommsTab({ s, token, refresh }: { s: any; token: string; refresh: () => void }) {
  const others = (s.squads || []).filter((x: any) => x.id !== s.team.id);
  const [to, setTo] = useState<number | null>(others[0]?.number ?? null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const msgs = (s.comms?.messages || []).filter((m: any) => m.from_number === to || m.to_number === to);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const maxId = Math.max(0, ...(s.comms?.messages || []).map((m: any) => m.id));
    store.set('hb_seen_msg', String(maxId));
  }, [s.comms?.messages?.length]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, to]);
  async function send(body = text) {
    if (!to || !body.trim()) return;
    setBusy(true);
    try { await rpc('captain_chat', { p_token: token, p_to_team: to, p_body: body }); setText(''); sfx.tap(); }
    catch (e) { toast(friendly(e), 'bad'); }
    finally { setBusy(false); refresh(); }
  }
  const blocked: number[] = s.comms?.blocked || [];
  return (
    <>
      {s.codewords?.length > 0 && (
        <div className="panel warn">
          <div className="panel-title">Codewords you hold for other squads</div>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Sharing earns your squad points and trust when they solve it in time. Or keep it… your call.</p>
          <div className="list">
            {s.codewords.map((c: any, i: number) => (
              <div key={i} className="list-item">
                <span className="grow">Squad {c.for_team} needs <b className="mono">{c.key}</b></span>
                <button className="btn sm warn" disabled={busy} onClick={() => { setTo(c.for_team); send(`Your codeword: ${c.key}`); }}>Send</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-title">Captain channel</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {others.map((x: any) => (
            <button key={x.number} className={`btn xs ${to === x.number ? 'primary' : 'ghost'}`} onClick={() => setTo(x.number)}>
              #{x.number}{blocked.includes(x.number) ? ' 🚫' : ''}
            </button>
          ))}
        </div>
      </div>
      {to && (
        <div className="panel col">
          <div className="row between"><b>Squad {to}</b>
            <button className="btn xs ghost" onClick={async () => { await rpc('captain_block', { p_token: token, p_team: to, p_block: !blocked.includes(to) }).catch((e) => toast(friendly(e), 'bad')); refresh(); }}>
              {blocked.includes(to) ? 'Unblock' : 'Block'}
            </button>
          </div>
          <div className="col" style={{ gap: 6, maxHeight: '42vh', overflow: 'auto' }}>
            {msgs.length === 0 && <p className="muted" style={{ margin: 0 }}>No messages yet. Negotiate, trade intel, propose alliances.</p>}
            {msgs.map((m: any) => (
              <div key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div className="clue" style={{ padding: '8px 12px', fontSize: 15, background: m.mine ? 'rgba(42,140,255,0.2)' : undefined }}>{m.body}</div>
                {!m.mine && <button className="btn xs ghost" style={{ marginTop: 2 }} onClick={async () => { await rpc('captain_report', { p_token: token, p_message: m.id }).catch(() => {}); toast('Reported to the host', 'info'); }}>Report</button>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="answer-row">
            <input className="input grow" value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder="Message to captain…" onKeyDown={(e) => e.key === 'Enter' && send()} aria-label="Message" />
            <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send()}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Results ─────────────────────────────────────────────────────────────
function Results({ s }: { s: any }) {
  if (!s.results) {
    return (
      <div className="panel center col" style={{ alignItems: 'center', padding: 30 }}>
        <div className="kind-tag">Results sealed</div>
        <div className="mega" style={{ fontSize: 48 }}>Eyes on the big screen</div>
        <p className="muted">The host will reveal the champion shortly.</p>
      </div>
    );
  }
  const mine = s.results.find((r: any) => r.number === s.team.number);
  return (
    <>
      <div className={`panel center ${mine?.rank === 1 ? 'good' : ''}`}>
        <div className="kind-tag">Final placement</div>
        <div className="mega" style={{ fontSize: 72, color: mine?.rank === 1 ? 'var(--gold)' : undefined }}>#{mine?.rank ?? '—'}</div>
        <div>{mine?.points} points · {mine?.missions} missions · {mine?.battles} battle wins</div>
        {mine?.rank === 1 && <div className="mega gold" style={{ fontSize: 30, marginTop: 10 }}>Winner winner chicken dinner!</div>}
      </div>
      <div className="panel">
        <div className="panel-title">Top squads</div>
        <div className="list">
          {s.results.slice(0, 5).map((r: any) => (
            <div key={r.number} className="list-item"><b style={{ width: 26 }}>{r.rank}</b><span className="grow">Squad {r.number} · {r.name}</span><b>{r.points}</b></div>
          ))}
        </div>
      </div>
    </>
  );
}

export { fmtClock };
