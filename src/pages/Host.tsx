import { ONLINE } from '../lib/edition';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { friendly, GameError, rpc, store } from '../lib/api';
import { useLive } from '../lib/live';
import { msUntil, useNow } from '../lib/time';
import { FINALE_STAGES, KIND_LABEL, locName, MapData, ROLE_ORDER, ROLES, Role, TIER_COLOR, useMapData, ZONE_TEXT } from '../lib/game';
import CampusMap from '../components/CampusMap';
import { PacingPanel, PhaseControls, rememberPins, RosterPanel } from './HostP0';
import { Countdown, FeedList, Modal, QR, toast } from '../components/ui';

type Section = 'control' | 'squads' | 'map' | 'missions' | 'production' | 'finale' | 'links' | 'settings' | 'log';
const PHASES = ['lobby', 'boarding', 'shuttle', 'roles', 'play', 'finale', 'results', 'ended'];

export default function Host() {
  const [token, setToken] = useState(store.get('hb_host_token'));
  if (!token) return <HostLogin onLogin={(t) => { store.set('hb_host_token', t); setToken(t); }} />;
  return <Dashboard token={token} onLogout={() => { store.del('hb_host_token'); setToken(null); }} />;
}

// ── Login / create ─────────────────────────────────────────────────────
function HostLogin({ onLogin }: { onLogin: (t: string) => void }) {
  const [mode, setMode] = useState<'login' | 'create'>('login');
  const [code, setCode] = useState(store.get('hb_host_code') || '');
  const [name, setName] = useState('Hexaware Battlegrounds × Operation Siruseri');
  const [secret, setSecret] = useState('');
  const [maps, setMaps] = useState(ONLINE ? 1 : 3);
  const [fixed, setFixed] = useState(!ONLINE);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = mode === 'login'
        ? await rpc('host_login', { p_code: code, p_secret: secret })
        : await rpc('host_create_event', { p_code: code, p_name: name, p_secret: secret, p_arenas: maps });
      store.set('hb_host_code', r.code);
      if (mode === 'create' && ONLINE) await rpc('host_settings', { p_token: r.token, p_settings: { online: 1 } });
      if (mode === 'create' && fixed) {
        // create the squads with this host's fixed PINs straight away (same cards every time)
        try { const c = await rpc<any>('host_fixed_cards', { p_token: r.token, p_secret: secret }); rememberPins(c.squads || []); } catch { /* can be done later in Links & PINs */ }
      }
      onLogin(r.token);
    } catch (ex) { setErr(friendly(ex)); } finally { setBusy(false); }
  }
  return (
    <div className="app" style={{ maxWidth: 520 }}>
      <div className="content">
        <div className="center" style={{ padding: '20px 0' }}>
          <div className="brand"><span className="l1">Host console</span><span className="l2">Battlegrounds</span><span className="l3">Operation Siruseri</span></div>
        </div>
        <div className="row">
          <button className={`btn grow ${mode === 'login' ? 'primary' : 'ghost'}`} onClick={() => setMode('login')}>Log in</button>
          <button className={`btn grow ${mode === 'create' ? 'primary' : 'ghost'}`} onClick={() => setMode('create')}>Create event</button>
        </div>
        <form className="panel col" onSubmit={submit} style={{ gap: 14 }}>
          <div className="field"><label htmlFor="c">Event code</label>
            <input id="c" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HEXA26" required /></div>
          {mode !== 'login' && <>
            <div className="field"><label htmlFor="n">Event name</label><input id="n" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
            {ONLINE ? <p className="notice" style={{ margin: 0 }}>Online edition: maps open by themselves as squads check in (15 squads = 60 players per map). Players sign in with their employee ID and company e-mail.</p> : <div className="field"><label htmlFor="m">Parallel maps (max 15 squads = 60 players each)</label>
              <select id="m" className="input" value={maps} onChange={(e) => setMaps(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} map{n > 1 ? 's' : ''} · up to {n * 60} players</option>)}
              </select></div>}
          </>}
          <div className="field"><label htmlFor="s">Host password</label>
            <input id="s" className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} minLength={6} required autoComplete="current-password" /></div>
          {err && <div className="chip bad" style={{ whiteSpace: 'normal', padding: 10 }}>{err}</div>}
          <button className="btn primary big" disabled={busy}>{mode === 'login' ? 'Enter control room' : 'Create event'}</button>
          <a href="/demo" className="btn ghost">No players yet? Watch a demo match with dummy squads</a>
          {mode === 'create' && !ONLINE && (
            <label className="check"><input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
              <span>Create the squads with my <b>fixed squad cards</b>: the same PINs and QR codes every time I use this host password.</span></label>
          )}
          {mode === 'create' && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Share the host password only with your co-host. Anyone with it controls the game.</p>}
        </form>
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────
function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const fetcher = useCallback(() => rpc('host_overview', { p_token: token }), [token]);
  const [topics, setTopics] = useState<string[]>([]);
  const live = useLive<any>(fetcher, {
    topics, pollMs: 4000, pollFastMs: 2500,
    deadlines: (d) => (d?.arenas || []).flatMap((a: any) => [a.shuttle_arrive_at, a.roles_deadline, a.zone_next_at, a.auto?.at]),
  });
  const d = live.data;
  const [section, setSection] = useState<Section>('control');
  const [arena, setArena] = useState<string>('all');
  const [mapKey, setMapKey] = useState(0);
  const map = useMapData(mapKey);

  useEffect(() => {
    if (d?.arenas) {
      const t = d.arenas.map((a: any) => `arena-${a.id}`);
      if (t.join() !== topics.join()) setTopics(t);
    }
  }, [d?.arenas?.length]);
  useEffect(() => {
    if (live.error instanceof GameError && live.error.code === 'HOST_AUTH') { toast('Host session expired', 'bad'); onLogout(); }
  }, [live.error]);

  const cmd = useCallback(async (arenaId: string | null, command: string, args: any = {}, reason?: string, quiet = false) => {
    try {
      const r = await rpc('host_command', { p_token: token, p_arena: arenaId, p_cmd: command, p_args: args, p_reason: reason ?? null });
      if (!r.ok) { toast(friendly(new GameError(r.error)), 'bad'); return null; }
      const errs = Object.values(r.result || {}).filter((x: any) => x?.error);
      if (errs.length) toast(`Some maps refused: ${errs.map((x: any) => friendly(new GameError(x.error))).join('; ')}`, 'warn');
      else if (!quiet) toast(`✔ ${command.replace(/_/g, ' ')}`, 'good');
      live.refresh();
      return r.result;
    } catch (e) { toast(friendly(e), 'bad'); return null; }
  }, [token, live.refresh]);

  if (!d) return <div className="screen-full"><div className="tagline glitch">{live.error ? friendly(live.error) : 'Loading control room…'}</div></div>;
  const arenas = d.arenas;
  const selArena = arenas.find((a: any) => a.id === arena) || null;
  const teams = d.teams.filter((t: any) => arena === 'all' || t.arena_id === arena);
  const nav: [Section, string][] = [['control', 'Game control'], ['squads', 'Squads'], ['map', 'Map & zone'], ['missions', 'Missions'],
    ['production', 'Suspense'], ['finale', 'Finale & results'], [ 'links', ONLINE ? 'Players & attendance' : 'Links & PINs'], ['settings', 'Settings'], ['log', 'Logs']];

  return (
    <div className="host">
      <aside className="host-nav">
        <div className="col" style={{ gap: 2, padding: '4px 8px 12px' }}>
          <span className="up" style={{ fontSize: 20 }}>{d.event.code}</span>
          <span className="muted" style={{ fontSize: 12 }}>{d.event.name}</span>
        </div>
        {nav.map(([id, label]) => <button key={id} className={section === id ? 'on' : ''} onClick={() => setSection(id)}>{label}{id === 'log' && d.reports > 0 ? ` (${d.reports})` : ''}</button>)}
        <button onClick={onLogout} style={{ marginTop: 'auto' }}>Log out</button>
      </aside>
      <main className="host-main">
        <div className="row wrap between">
          <div className="row wrap" style={{ gap: 6 }}>
            <button className={`btn sm ${arena === 'all' ? 'primary' : 'ghost'}`} onClick={() => setArena('all')}>All maps</button>
            {arenas.map((a: any) => <button key={a.id} className={`btn sm ${arena === a.id ? 'primary' : 'ghost'}`} onClick={() => setArena(a.id)}>{a.name} · {a.phase}{a.paused ? ' ⏸' : ''}</button>)}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="chip"><span className={`dot ${live.connected ? 'on' : ''}`} />{live.connected ? 'Realtime' : 'Polling'}</span>
            <span className="chip good">{d.metrics.players_online}/{d.metrics.players_total} online</span>
            <span className="chip">{d.metrics.squads_ready} squads ready</span>
            <span className="chip">{d.metrics.submissions_5m} answers/5m ({d.metrics.wrong_5m} wrong)</span>
            {d.metrics.host_errors > 0 && <span className="chip bad">{d.metrics.host_errors} refused cmds</span>}
          </div>
        </div>
        {section === 'control' && <Control d={d} arenas={arenas} arena={arena} cmd={cmd} map={map} token={token}
          pacing={arenas.some((a: any) => a.auto?.on) ? null : <PacingPanel d={d} token={token} refresh={live.refresh} arena={selArena || arenas.find((a: any) => a.phase === 'play') || arenas[0] || null} />} />}
        {section === 'squads' && <Squads d={d} teams={teams} arenas={arenas} cmd={cmd} token={token} map={map} />}
        {section === 'map' && map && <MapControl d={d} arenas={arenas} selArena={selArena} setArena={setArena} cmd={cmd} map={map} reloadMap={() => setMapKey((k) => k + 1)} />}
        {section === 'missions' && <Missions token={token} />}
        {section === 'production' && <Production arena={arena === 'all' ? null : arena} cmd={cmd} />}
        {section === 'finale' && <Finale d={d} arenas={arenas} arena={arena} cmd={cmd} />}
        {section === 'links' && (ONLINE ? <OnlinePanel d={d} token={token} /> : <Links d={d} token={token} refresh={live.refresh} cmd={cmd} />)}
        {section === 'settings' && <Settings d={d} token={token} refresh={live.refresh} />}
        {section === 'log' && <Logs d={d} token={token} arenas={arenas} cmd={cmd} map={map} />}
      </main>
    </div>
  );
}

type Cmd = (arenaId: string | null, command: string, args?: any, reason?: string, quiet?: boolean) => Promise<any>;

// ── Control ─────────────────────────────────────────────────────────────
function Control({ d, arenas, arena, cmd, map, pacing, token }: { d: any; arenas: any[]; arena: string; cmd: Cmd; map: MapData | null; pacing: React.ReactNode; token: string }) {
  useNow(500);
  const list = arena === 'all' ? arenas : arenas.filter((a: any) => a.id === arena);
  // online edition: the one Start button (automatic maps) is the main control; per-map buttons are advanced
  if (ONLINE) return (
    <>
      <OnlinePanel d={d} token={token} />
      <details className="manual-pacing"><summary>Per-map controls (advanced — not needed with automatic maps)</summary>
        <div className="grid2">{list.map((a: any) => <ArenaCard key={a.id} a={a} d={d} cmd={cmd} />)}</div>
      </details>
      <div className="panel"><div className="panel-title">Live feed (all maps)</div><FeedList feed={d.feed} map={map} limit={14} /></div>
    </>
  );
  return (
    <>
      <AutoPanel d={d} list={list} all={arena === 'all'} cmd={cmd} />
      {pacing && <details className="manual-pacing"><summary>Manual match pacing (advanced)</summary>{pacing}</details>}
      {arena === 'all' && arenas.length > 1 && (
        <div className="panel warn">
          <div className="panel-title">All maps at once</div>
          <div className="row wrap">
            <button className="btn sm" onClick={() => cmd(null, 'open_boarding')}>Open boarding</button>
            <button className="btn sm primary" onClick={() => cmd(null, 'drive')}>🚌 Drive all</button>
            <button className="btn sm" onClick={() => cmd(null, 'finalize_roles')}>Finalize roles</button>
            <button className="btn sm" onClick={() => cmd(null, 'pause')}>⏸ Pause all</button>
            <button className="btn sm" onClick={() => cmd(null, 'resume')}>▶ Resume all</button>
            <button className="btn sm warn" onClick={() => cmd(null, 'zone_warn')}>☢ Zone warning all</button>
            <button className="btn sm danger" onClick={() => confirm('Begin the finale on every map?') && cmd(null, 'begin_finale')}>Begin finale all</button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Every map uses the same mission seed and the same finale challenges, so the combined grand champion is fair.</p>
        </div>
      )}
      <div className="grid2">
        {list.map((a: any) => <ArenaCard key={a.id} a={a} d={d} cmd={cmd} />)}
      </div>
      <div className="panel"><div className="panel-title">Live feed (all maps)</div><FeedList feed={d.feed} map={map} limit={14} /></div>
    </>
  );
}

// ── Automatic match ─────────────────────────────────────────────────────
const LENGTHS: [string, string, string][] = [
  ['quick', 'Quick', '≈ 15 min · 1 finale battle'],
  ['standard', 'Standard', '≈ 35 min · 2 finale battles'],
  ['full', 'Full', '≈ 75 min · 3 finale battles'],
];

function AutoPanel({ d, list, all, cmd }: { d: any; list: any[]; all: boolean; cmd: Cmd }) {
  const [len, setLen] = useState('standard');
  const running = list.filter((a: any) => a.auto?.on);
  const startable = list.filter((a: any) => !a.auto?.on && a.phase !== 'ended');
  const ready = d.teams.filter((t: any) => t.ready && list.some((a: any) => a.id === t.arena_id)).length;
  const target = all ? null : list[0]?.id ?? null;
  const start = () => {
    const where = all && list.length > 1 ? `all ${list.length} maps` : list[0]?.name;
    if (!confirm(`Start an automatic ${len} match on ${where}?\n\nBoarding, the bus, roles, phases, zone, airdrops, red zones, loot, building lockdowns, finale rounds and the results all run by themselves. You can still pause or override anything.`)) return;
    cmd(target, 'start_match', { length: len });
  };
  return (
    <div className={`panel auto-panel ${running.length ? 'on' : ''}`}>
      <div className="row between wrap">
        <div className="panel-title" style={{ margin: 0 }}>Automatic match</div>
        {running.length > 0 && <span className="chip good"><span className="dot on" />Autopilot running</span>}
      </div>
      {startable.length > 0 && (
        <>
          <div className="auto-lengths" role="radiogroup" aria-label="Match length">
            {LENGTHS.map(([id, name, sub]) => (
              <button key={id} role="radio" aria-checked={len === id} className={len === id ? 'on' : ''} onClick={() => setLen(id)}>
                <b>{name}</b><span>{sub}</span>
              </button>
            ))}
          </div>
          <button className="btn primary auto-start" disabled={ready === 0} onClick={start}>▶ START MATCH</button>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {ready === 0 ? 'Waiting for at least one complete squad (4 players).' : `${ready} squad${ready === 1 ? '' : 's'} ready. One press runs everything — from boarding to the winner reveal.`}
          </p>
        </>
      )}
      {running.map((a: any) => (
        <div key={a.id} className="auto-row">
          <div className="col" style={{ gap: 2 }}>
            <span className="muted" style={{ fontSize: 12 }}>{a.name} · {a.auto.length || 'standard'}{a.paused ? ' · paused' : ''}</span>
            <b>{a.auto.label}{a.auto.at && msUntil(a.auto.at) > 0 && !a.paused && <> in <Countdown to={a.auto.at} /></>}</b>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {a.paused ? <button className="btn sm primary" onClick={() => cmd(a.id, 'resume')}>▶ Resume</button> : <button className="btn sm" onClick={() => cmd(a.id, 'pause')}>⏸ Pause</button>}
            <button className="btn sm ghost" onClick={() => confirm(`Take manual control of ${a.name}? Nothing will happen on its own until you start the autopilot again.`) && cmd(a.id, 'autopilot_off')}>Manual control</button>
          </div>
        </div>
      ))}
      {!running.length && list.some((a: any) => !['lobby', 'boarding', 'ended'].includes(a.phase)) && (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>A match is already running by hand. Start match hands it to the autopilot from where it is now.</p>
      )}
    </div>
  );
}

function ArenaCard({ a, d, cmd }: { a: any; d: any; cmd: Cmd }) {
  const teams = d.teams.filter((t: any) => t.arena_id === a.id);
  const ready = teams.filter((t: any) => t.ready).length;
  const idx = PHASES.indexOf(a.phase);
  const battles = d.battles.filter((b: any) => b.arena_id === a.id).length;
  const recovering = teams.filter((t: any) => t.state === 'recovery').length;
  return (
    <div className={`panel ${a.paused ? 'warn' : ''}`}>
      <div className="row between"><h3 style={{ fontSize: 22 }}>{a.name}</h3><div className="row" style={{ gap: 6 }}>{a.auto?.on && <span className="chip good">AUTO</span>}<span className="chip">{ready}/{teams.length} squads ready</span></div></div>
      <div className="phase-steps" style={{ margin: '10px 0' }}>
        {PHASES.slice(0, 7).map((p, i) => <span key={p} className={i < idx ? 'done' : i === idx ? 'now' : ''}>{p}</span>)}
      </div>
      <div className="kv">
        <span className="muted">Zone</span><span>Stage {a.zone_stage} — {ZONE_TEXT[a.zone_stage]}{a.zone_next_at && msUntil(a.zone_next_at) > 0 && <b style={{ color: 'var(--red)' }}> · next in <Countdown to={a.zone_next_at} /></b>}</span>
        <span className="muted">Activity</span><span>{battles} battles · {recovering} recovering · threat {a.threat}</span>
        {a.phase === 'shuttle' && <><span className="muted">Shuttle</span><span>arrives in <Countdown to={a.shuttle_arrive_at} /></span></>}
        {a.phase === 'roles' && <><span className="muted">Roles</span><span>close in <Countdown to={a.roles_deadline} /></span></>}
        {a.phase === 'finale' && <><span className="muted">Finale</span><span>Stage {a.finale_stage} · {FINALE_STAGES[a.finale_stage]?.name}</span></>}
      </div>
      <div className="row wrap" style={{ marginTop: 12 }}>
        {(a.phase === 'lobby' || a.phase === 'boarding') && <button className="btn sm" onClick={() => cmd(a.id, 'open_boarding')}>{a.phase === 'lobby' ? 'Open boarding & assign buses' : 'Rebalance buses'}</button>}
        {a.phase === 'boarding' && <button className="btn sm primary" onClick={() => cmd(a.id, 'drive')}>🚌 DRIVE</button>}
        {(a.phase === 'shuttle' || a.phase === 'roles') && <button className="btn sm" onClick={() => cmd(a.id, 'finalize_roles')}>{a.phase === 'shuttle' ? 'Skip to Gate 1' : 'Finalize roles now'}</button>}
        {a.phase === 'play' && <button className="btn sm danger" onClick={() => confirm(`Begin the finale on ${a.name}? Active missions are cancelled without penalty.`) && cmd(a.id, 'begin_finale')}>Begin finale (TR14)</button>}
        {a.paused ? <button className="btn sm primary" onClick={() => cmd(a.id, 'resume')}>▶ Resume</button> : <button className="btn sm" onClick={() => cmd(a.id, 'pause')}>⏸ Pause</button>}
        <button className="btn sm ghost" onClick={() => window.open(`/screen/${a.spectator_token}`, '_blank')}>Open projector</button>
        <button className="btn sm ghost" title="Rehearsal helper: wipes gameplay on this map, keeps squads and players"
          onClick={() => { const c = prompt(`Reset ${a.name} to the lobby? All scores, missions and chat on this map are wiped. Type RESET to confirm.`); if (c === 'RESET') cmd(a.id, 'reset_arena', { confirm: 'RESET' }); }}>
          Reset map
        </button>
      </div>
      <PhaseControls a={a} cmd={cmd} />
      {a.phase === 'lobby' && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{ready} complete squad{ready === 1 ? '' : 's'} ready on this map. You can start with any number from 1 to 15 — you don’t need a full map.{ready < teams.length ? ' Incomplete squads stay in the lobby and are not boarded.' : ''}</p>}
    </div>
  );
}

// ── Squads ──────────────────────────────────────────────────────────────
function Squads({ d, teams, arenas, cmd, token, map }: { d: any; teams: any[]; arenas: any[]; cmd: Cmd; token: string; map: MapData | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = d.teams.find((x: any) => x.id === open);
  const arenaName = (id: string) => arenas.find((a) => a.id === id)?.name;
  return (
    <div className="panel scroll-x">
      <table className="tbl">
        <thead><tr><th>#</th><th>Squad</th><th>Map</th><th>Players</th><th>HP</th><th>Pts</th><th>Coins</th><th>Trust</th><th>Where</th><th>Doing</th><th /></tr></thead>
        <tbody>
          {teams.map((x: any) => (
            <tr key={x.id}>
              <td><b>{x.number}</b></td>
              <td>{x.name}{x.ready ? '' : <span className="chip warn" style={{ marginLeft: 6 }}>incomplete</span>}</td>
              <td>{arenaName(x.arena_id)}{x.bus ? ` · bus ${x.bus}` : ''}</td>
              <td>{x.players.map((p: any) => <div key={p.id} className="row" style={{ gap: 4 }}><span className={`dot ${p.online ? 'on' : 'off'}`} />{p.name}{p.role && <span style={{ color: ROLES[p.role as Role].color }}> {ROLES[p.role as Role].icon}</span>}</div>)}</td>
              <td>{x.hp}{x.shield ? `+${x.shield}` : ''}{x.state === 'recovery' && ' ✚'}</td>
              <td>{x.points}</td><td>{x.coins}</td><td>{x.trust}</td>
              <td>{x.state === 'traveling' ? `→ ${locName(map, x.travel_to)}` : locName(map, x.location)}</td>
              <td>{x.activity ? `${KIND_LABEL[x.activity.kind] || x.activity.kind}: ${x.activity.title}` : '—'}</td>
              <td><button className="btn xs" onClick={() => setOpen(x.id)}>Manage</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {teams.length === 0 && <p className="muted">No squads yet. Create them in “Links & PINs”.</p>}
      {t && <SquadModal t={t} close={() => setOpen(null)} cmd={cmd} token={token} map={map} />}
    </div>
  );
}

function SquadModal({ t, close, cmd, token, map }: { t: any; close: () => void; cmd: Cmd; token: string; map: MapData | null }) {
  const [adj, setAdj] = useState({ points: 0, coins: 0, hp: 0, trust: 0, item: '' });
  const [reason, setReason] = useState('');
  const [loc, setLoc] = useState('');
  const [tpl, setTpl] = useState('');
  const [templates, setTemplates] = useState<any[]>([]);
  const [spoil, setSpoil] = useState(false);
  useEffect(() => { rpc('host_missions', { p_token: token }).then((m) => setTemplates(m.filter((x: any) => ['approved', 'published'].includes(x.status) && ['mission', 'relay', 'recovery'].includes(x.kind)))).catch(() => {}); }, [token]);
  return (
    <Modal open onClose={close} title={`Squad ${t.number} · ${t.name}`}>
      <div className="col" style={{ gap: 14 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">HP {t.hp}</span><span className="chip">Shield {t.shield}</span><span className="chip gold">{t.coins} coins</span>
          <span className="chip">{t.points} pts</span><span className="chip">{t.final_points} final</span><span className="chip good">trust {t.trust}</span>
          <span className="chip">{t.missions} missions</span><span className="chip">{t.battles} wins</span>
          {Object.entries(t.inventory || {}).map(([k, v]: any) => <span key={k} className="chip">{k}×{v}</span>)}
        </div>
        <div className="panel">
          <div className="panel-title">Players & roles</div>
          {t.players.map((p: any) => (
            <div key={p.id} className="row" style={{ marginBottom: 6 }}>
              <span className={`dot ${p.online ? 'on' : 'off'}`} /><span className="grow">{p.name}</span>
              <select className="input" style={{ minHeight: 34, padding: 4, width: 140 }} value={p.role || ''} onChange={(e) => cmd(null, 'set_role', { player_id: p.id, role: e.target.value })}>
                <option value="" disabled>no role</option>
                {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLES[r].name}</option>)}
              </select>
              <button className="btn xs danger" onClick={() => confirm(`Remove ${p.name}? A replacement can join with the squad PIN.`) && cmd(null, 'remove_player', { player_id: p.id })}>Remove</button>
            </div>
          ))}
          <div className="row wrap">
            <button className="btn xs" onClick={() => cmd(null, 'reopen_team', { team_id: t.id })}>Reopen roster for replacement</button>
            <button className="btn xs" onClick={() => cmd(null, 'lock_team', { team_id: t.id })}>Lock roster</button>
            <button className="btn xs" onClick={() => cmd(null, 'fill_roles', { team_id: t.id })}>Auto-fill empty roles</button>
          </div>
        </div>
        {t.activity && (
          <div className="panel warn">
            <div className="panel-title">Current: {KIND_LABEL[t.activity.kind]} · {t.activity.title}</div>
            <div className="muted" style={{ fontSize: 13 }}>{t.activity.attempts_left} attempts · ends <Countdown to={t.activity.deadline} /></div>
            <div className={`spoiler ${spoil ? 'open' : ''}`} onClick={() => setSpoil(true)} style={{ margin: '8px 0', fontSize: 13 }}>
              Answer: {t.activity.answer.map((p: any) => `${p.label}: ${p.accept.map((x: string) => (x === '{KEY}' ? t.activity.relay_key : x)).join(' / ')}`).join(' · ')}
              <div className="muted">{t.activity.explanation}</div>
            </div>
            <div className="row wrap">
              <button className="btn xs" onClick={() => cmd(null, 'reveal_hint', { instance_id: t.activity.id })}>Reveal hint</button>
              <button className="btn xs warn" onClick={() => cmd(null, 'cancel_instance', { instance_id: t.activity.id })}>Cancel (no penalty)</button>
            </div>
          </div>
        )}
        <div className="panel">
          <div className="panel-title">Assign an equivalent challenge</div>
          <div className="row"><select className="input grow" value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">Choose a reviewed mission…</option>
            {templates.map((m) => <option key={m.id} value={m.id}>{m.title} · {m.id}</option>)}
          </select><button className="btn sm" disabled={!tpl} onClick={() => cmd(null, 'assign_mission', { team_id: t.id, template_id: tpl })}>Assign</button></div>
        </div>
        <div className="panel">
          <div className="panel-title">Relocate / respawn</div>
          <div className="row"><select className="input grow" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">Choose location…</option>
            {map?.locations.filter((l) => l.kind !== 'start').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select><button className="btn sm" disabled={!loc} onClick={() => cmd(null, 'relocate', { team_id: t.id, location: loc })}>Move</button></div>
          {t.state === 'recovery' && <button className="btn sm primary" style={{ marginTop: 8 }} onClick={() => cmd(null, 'respawn', { team_id: t.id })}>Respawn now</button>}
        </div>
        <div className="panel danger">
          <div className="panel-title">Manual adjustment (audited)</div>
          <div className="grid3" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {(['points', 'coins', 'hp', 'trust'] as const).map((k) => (
              <div key={k} className="field"><label>{k}</label><input className="input" type="number" value={adj[k]} onChange={(e) => setAdj({ ...adj, [k]: Number(e.target.value) })} /></div>
            ))}
          </div>
          <div className="field" style={{ marginTop: 6 }}><label>Give item</label>
            <select className="input" value={adj.item} onChange={(e) => setAdj({ ...adj, item: e.target.value })}>
              <option value="">none</option>{map?.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select></div>
          <div className="field" style={{ marginTop: 6 }}><label>Reason (required)</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Dispute resolved — clue rendering issue" /></div>
          <button className="btn danger block" style={{ marginTop: 8 }} disabled={reason.trim().length < 3}
            onClick={async () => { await cmd(null, 'adjust', { team_id: t.id, ...adj, item: adj.item || null }, reason); setAdj({ points: 0, coins: 0, hp: 0, trust: 0, item: '' }); setReason(''); }}>Apply adjustment</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Map & zone ──────────────────────────────────────────────────────────
function MapControl({ d, arenas, selArena, setArena, cmd, map, reloadMap }: { d: any; arenas: any[]; selArena: any; setArena: (id: string) => void; cmd: Cmd; map: MapData; reloadMap: () => void }) {
  useNow(500);
  const a = selArena || arenas[0];
  const [tier, setTier] = useState('rare');
  const [loc, setLoc] = useState('');
  const [secs, setSecs] = useState(60);
  const [sel, setSel] = useState<string | null>(null);
  if (!a) return null;
  const teams = d.teams.filter((t: any) => t.arena_id === a.id && t.ready);
  const zoneWarn = !!a.zone_next_at && msUntil(a.zone_next_at) > 0;
  const selLoc = map.locations.find((l) => l.id === sel);
  return (
    <div className="grid2" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
      <div className="col">
        {!selArena && <div className="row" style={{ gap: 6 }}>{arenas.map((x) => <button key={x.id} className="btn xs" onClick={() => setArena(x.id)}>{x.name}</button>)}</div>}
        <CampusMap map={map} zoneStage={a.zone_stage} zoneWarning={zoneWarn} height="70vh" selected={sel} onSelect={setSel} zone={a.overlay?.zone} red={a.overlay?.red}
          squads={teams.map((t: any) => ({ number: t.number, location: t.location, pos: t.pos, in_battle: d.battles.some((b: any) => b.attacker === t.number || b.defender === t.number) }))}
          airdrops={d.airdrops.filter((x: any) => x.arena_id === a.id)} labels="all" />
        {selLoc && (
          <div className="panel row wrap between">
            <span><b>{selLoc.name}</b> <span className="muted">· collapses at stage {selLoc.collapse === 99 ? 'never' : selLoc.collapse} · {selLoc.enabled ? 'enabled' : 'DISABLED'}</span></span>
            <button className="btn sm" onClick={async () => { await cmd(null, 'set_location', { location: selLoc.id, enabled: !selLoc.enabled }); reloadMap(); }}>{selLoc.enabled ? 'Disable' : 'Enable'} location</button>
          </div>
        )}
      </div>
      <div className="col">
        <div className="panel warn">
          <div className="panel-title">Safe zone · {a.name}</div>
          <p style={{ marginTop: 0 }}>Stage {a.zone_stage}: {ZONE_TEXT[a.zone_stage]}{zoneWarn && <><br /><b style={{ color: 'var(--red)' }}>Collapse in <Countdown to={a.zone_next_at} /></b></>}</p>
          <div className="row wrap">
            <input className="input" type="number" style={{ width: 90 }} value={secs} onChange={(e) => setSecs(Number(e.target.value))} aria-label="Warning seconds" />
            <button className="btn sm warn" onClick={() => cmd(a.id, 'zone_warn', { seconds: secs })}>Warn & schedule</button>
            <button className="btn sm danger" onClick={() => confirm('Collapse the next zone stage right now?') && cmd(a.id, 'zone_now')}>Collapse now</button>
            <button className="btn sm ghost" onClick={() => cmd(a.id, 'zone_cancel')}>Cancel</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted">Set stage</span>
            {[0, 1, 2, 3, 4, 5].map((n) => <button key={n} className={`btn xs ${n === a.zone_stage ? 'primary' : 'ghost'}`} onClick={() => cmd(a.id, 'zone_set', { stage: n })}>{n}</button>)}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>The safe zone is a shrinking circle (same circles on every map) that always ends on TR14. Squads outside lose {d.event.settings.zone_tick_damage ?? 4} HP every {d.event.settings.zone_tick_seconds ?? 6} s until they run back inside — nobody is teleported.</p>
        </div>
        <div className="panel danger">
          <div className="panel-title">Red zone · {a.name}</div>
          {a.red_at
            ? <p style={{ marginTop: 0 }}><b style={{ color: 'var(--red)' }}>Strike in <Countdown to={a.red_at} /></b> — squads inside the red circle lose {d.event.settings.red_damage ?? 30} HP.</p>
            : <p style={{ marginTop: 0 }} className="muted">Call a bombardment: phones get a {d.event.settings.red_warning ?? 20}-second warning, then squads still inside the red circle lose {d.event.settings.red_damage ?? 30} HP. Never lands on TR14.</p>}
          <div className="row wrap">
            <button className="btn sm danger" disabled={a.phase !== 'play' || !!a.red_at} onClick={() => cmd(a.id, 'red_zone', {})}>💥 Random red zone</button>
            <button className="btn sm danger" disabled={a.phase !== 'play' || !!a.red_at || !selLoc} onClick={() => selLoc && cmd(a.id, 'red_zone', { x: selLoc.x, y: selLoc.y })}>💥 On {selLoc ? selLoc.name.split('(')[0] : 'selected location'}</button>
            {a.red_at && <button className="btn sm ghost" onClick={() => cmd(a.id, 'red_cancel')}>Cancel</button>}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Automatic red zones: set “Red zone every N minutes” in Settings (from Phase 2).</p>
        </div>
        <div className="panel">
          <div className="panel-title">Airdrop</div>
          <div className="field"><label>Tier</label><div className="row wrap" style={{ gap: 4 }}>
            {Object.keys(TIER_COLOR).map((t) => <button key={t} className={`btn xs ${tier === t ? 'primary' : 'ghost'}`} style={{ color: TIER_COLOR[t] }} onClick={() => setTier(t)}>{t}</button>)}
          </div></div>
          <div className="field" style={{ marginTop: 6 }}><label>Location</label>
            <select className="input" value={loc} onChange={(e) => setLoc(e.target.value)}>
              <option value="">Auto (inside the next safe zone)</option>
              {map.locations.filter((l) => l.kind !== 'start').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></div>
          <button className="btn warn block" style={{ marginTop: 8 }} onClick={() => cmd(a.id, 'spawn_airdrop', { tier, location: loc || null })}>✈ Drop it</button>
        </div>
      </div>
    </div>
  );
}

// ── Missions editor ─────────────────────────────────────────────────────
const EMPTY = {
  id: '', title: '', kind: 'mission', family: 'custom', category: 'custom', difficulty: 1, tags: ['any'], objective: '',
  clues: { scout: { title: 'Evidence', body: '', mono: false }, decoder: { title: 'Rules', body: '' }, intel: { title: 'Intel', body: '' } },
  parts: [{ label: 'Answer', accept: [''] }], relay: false, attempts: 3, time_limit: 180, hint: '', explanation: '', points: null, coins: 25, status: 'draft',
};
function Missions({ token }: { token: string }) {
  const [all, setAll] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [edit, setEdit] = useState<any>(null);
  const [test, setTest] = useState<string[]>([]);
  const load = useCallback(() => rpc('host_missions', { p_token: token }).then(setAll).catch((e) => toast(friendly(e), 'bad')), [token]);
  useEffect(() => { load(); }, [load]);
  const list = all.filter((m) => (kind === 'all' || m.kind === kind) && (!q || (m.id + m.title + m.tags.join()).toLowerCase().includes(q.toLowerCase())));
  async function save(status?: string) {
    try {
      const m = { ...edit, status: status || edit.status };
      const saved = await rpc('host_save_mission', { p_token: token, p_mission: m });
      setEdit(saved); toast(`Saved v${saved.version} (${saved.status})`, 'good'); load();
    } catch (e) { toast(friendly(e), 'bad'); }
  }
  async function runTest() {
    try { const r = await rpc('host_test_answer', { p_token: token, p_template: edit.id, p_answers: test }); toast(r.correct ? '✔ Accepted' : '✖ Rejected', r.correct ? 'good' : 'bad'); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  const set = (path: string, value: any) => setEdit((m: any) => {
    const c = structuredClone(m); const keys = path.split('.'); let o = c;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)!] = value; return c;
  });
  if (edit) {
    return (
      <div className="col">
        <div className="row between"><button className="btn sm ghost" onClick={() => setEdit(null)}>← Library</button>
          <div className="row wrap">
            <span className="chip">{edit.status} · v{edit.version || 1}</span>
            <button className="btn sm" onClick={() => save()}>Save</button>
            {edit.status === 'draft' && <button className="btn sm" onClick={() => save('review')}>Send to review</button>}
            {edit.status === 'review' && <button className="btn sm primary" onClick={() => save('approved')}>Approve</button>}
            {edit.status === 'approved' && <button className="btn sm primary" onClick={() => save('published')}>Publish</button>}
            {edit.status !== 'retired' && <button className="btn sm danger" onClick={() => save('retired')}>Retire</button>}
          </div>
        </div>
        <div className="grid2">
          <div className="panel col">
            <div className="grid3">
              <div className="field"><label>ID</label><input className="input mono" value={edit.id} onChange={(e) => set('id', e.target.value)} placeholder="mission-costa-rebus-1" /></div>
              <div className="field"><label>Title</label><input className="input" value={edit.title} onChange={(e) => set('title', e.target.value)} /></div>
              <div className="field"><label>Kind</label><select className="input" value={edit.kind} onChange={(e) => set('kind', e.target.value)}>
                {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
              <div className="field"><label>Difficulty</label><select className="input" value={edit.difficulty} onChange={(e) => set('difficulty', Number(e.target.value))}><option value={1}>Standard</option><option value={2}>Hard</option></select></div>
              <div className="field"><label>Location tags</label><input className="input" value={edit.tags.join(', ')} onChange={(e) => set('tags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} placeholder="costa, coffee, any" /></div>
              <div className="field"><label>Time (s) / attempts</label><div className="row"><input className="input" type="number" value={edit.time_limit} onChange={(e) => set('time_limit', Number(e.target.value))} /><input className="input" type="number" value={edit.attempts} onChange={(e) => set('attempts', Number(e.target.value))} /></div></div>
            </div>
            <div className="field"><label>Objective (captain + everyone)</label><textarea className="input" value={edit.objective} onChange={(e) => set('objective', e.target.value)} /></div>
            {(['scout', 'decoder', 'intel'] as Role[]).map((r) => (
              <div key={r} className="field">
                <label style={{ color: ROLES[r].color }}>{ROLES[r].name} clue — indispensable fact</label>
                <input className="input" value={edit.clues[r].title} onChange={(e) => set(`clues.${r}.title`, e.target.value)} placeholder="Clue title" />
                <textarea className="input" value={edit.clues[r].body} onChange={(e) => set(`clues.${r}.body`, e.target.value)} />
                <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={!!edit.clues[r].mono} onChange={(e) => set(`clues.${r}.mono`, e.target.checked)} />Monospace layout (grids, rebus, code)</label>
              </div>
            ))}
            <div className="field"><label>Answer boxes (comma = alternative accepted answers; {'{KEY}'} = partner codeword)</label>
              {edit.parts.map((p: any, i: number) => (
                <div key={i} className="row">
                  <input className="input" style={{ width: 150 }} value={p.label} onChange={(e) => set(`parts.${i}.label`, e.target.value)} />
                  <input className="input grow mono" value={p.accept.join(', ')} onChange={(e) => set(`parts.${i}.accept`, e.target.value.split(',').map((x) => x.trim()))} />
                  <button className="btn xs ghost" onClick={() => set('parts', edit.parts.filter((_: any, j: number) => j !== i))} disabled={edit.parts.length < 2}>✕</button>
                </div>
              ))}
              <button className="btn xs" onClick={() => set('parts', [...edit.parts, { label: `Part ${edit.parts.length + 1}`, accept: [''] }])}>+ Answer box</button>
            </div>
            <div className="grid3">
              <div className="field"><label>Hint (costs coins)</label><input className="input" value={edit.hint || ''} onChange={(e) => set('hint', e.target.value)} /></div>
              <div className="field"><label>Points override</label><input className="input" type="number" value={edit.points ?? ''} onChange={(e) => set('points', e.target.value === '' ? null : Number(e.target.value))} placeholder="default by difficulty" /></div>
              <div className="field"><label>Coins</label><input className="input" type="number" value={edit.coins} onChange={(e) => set('coins', Number(e.target.value))} /></div>
            </div>
            <div className="field"><label>Explanation (host only)</label><textarea className="input" value={edit.explanation || ''} onChange={(e) => set('explanation', e.target.value)} /></div>
            <label className="check"><input type="checkbox" checked={edit.relay} onChange={(e) => set('relay', e.target.checked)} /> Cross-team relay (needs a partner squad's codeword, with timed backup to Intel)</label>
          </div>
          <div className="col">
            <div className="panel">
              <div className="panel-title">Four-screen preview</div>
              <div className="preview4">
                <div className="phone"><span className="role-badge" style={{ color: ROLES.captain.color }}>★ Captain</span><p style={{ fontSize: 13 }}>{edit.objective}</p>
                  {edit.parts.map((p: any, i: number) => <div key={i} className="field" style={{ marginBottom: 6 }}><label>{p.label}</label><div className="input" style={{ minHeight: 34 }} /></div>)}</div>
                {(['scout', 'decoder', 'intel'] as Role[]).map((r) => (
                  <div key={r} className="phone"><span className="role-badge" style={{ color: ROLES[r].color }}>{ROLES[r].icon} {ROLES[r].name}</span>
                    <div className="up" style={{ fontSize: 12, margin: '8px 0 4px' }}>{edit.clues[r].title}</div>
                    <div className={`clue ${edit.clues[r].mono ? 'mono' : ''}`} style={{ fontSize: 12 }}>{edit.clues[r].body}</div></div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panel-title">Test answer validation (save first)</div>
              {edit.parts.map((p: any, i: number) => <input key={i} className="input mono" style={{ marginBottom: 6 }} placeholder={p.label} value={test[i] || ''} onChange={(e) => setTest((t) => { const c = [...t]; c[i] = e.target.value; return c; })} />)}
              <button className="btn sm" onClick={runTest} disabled={!edit.id}>Test</button>
              <p className="muted" style={{ fontSize: 12 }}>Answers are normalised: case, spaces and punctuation are ignored.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="panel col">
      <div className="row wrap between">
        <div className="row wrap"><input className="input" style={{ width: 240 }} placeholder="Search id, title, tag" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All kinds</option>{Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
        <button className="btn sm primary" onClick={() => setEdit(structuredClone(EMPTY))}>+ New mission</button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>{list.length} of {all.length} templates · only approved/published missions appear in live games; every instance stores the version it was created from.</div>
      <div className="scroll-x" style={{ maxHeight: '70vh' }}>
        <table className="tbl"><thead><tr><th>Title</th><th>Kind</th><th>Tags</th><th>Diff</th><th>Status</th><th>v</th><th /></tr></thead>
          <tbody>{list.map((m) => (
            <tr key={m.id}><td><b>{m.title}</b><div className="dim mono" style={{ fontSize: 11 }}>{m.id}</div></td><td>{KIND_LABEL[m.kind]}</td>
              <td style={{ fontSize: 12 }}>{m.tags.join(', ')}</td><td>{m.difficulty}</td><td><span className={`chip ${m.status === 'published' ? 'good' : m.status === 'retired' ? 'bad' : 'warn'}`}>{m.status}</span></td><td>{m.version}</td>
              <td><button className="btn xs" onClick={() => { setEdit(structuredClone(m)); setTest([]); }}>Open</button></td></tr>
          ))}</tbody></table>
      </div>
    </div>
  );
}

// ── Production / suspense ───────────────────────────────────────────────
const LOCK_BUILDINGS: [string, string, number][] = [
  ['eb1', 'EB1', 4], ['rtb', 'Ratan Tata Building', 5], ['datacenter', 'Data Center', 1], ['eb3', 'EB3', 4], ['eb2', 'EB2', 4],
  ['phase2', 'Phase 2 Tower', 5], ['gym', 'Fitness Center', 2], ['foodcourt', 'Food Court', 1], ['security', 'Security HQ', 1],
];
function Production({ arena, cmd }: { arena: string | null; cmd: Cmd }) {
  const [text, setText] = useState('');
  const [tone, setTone] = useState('warn');
  const [cd, setCd] = useState({ seconds: 10, label: 'Next stage begins in' });
  const [lb, setLb] = useState({ building: 'eb1', level: '' as string | number });
  const target = arena ? 'this map' : 'ALL maps';
  return (
    <div className="grid2">
      <div className="panel col">
        <div className="panel-title">Broadcast to {target}</div>
        <textarea className="input" style={{ fontFamily: 'var(--font-body)' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Short announcement shown on every phone and the projector" maxLength={280} />
        <div className="row"><select className="input" style={{ width: 160 }} value={tone} onChange={(e) => setTone(e.target.value)}><option value="warn">Alert (orange)</option><option value="info">Info (blue)</option></select>
          <button className="btn primary grow" disabled={!text.trim()} onClick={() => cmd(arena, 'broadcast', { text, tone })}>📣 Broadcast</button></div>
        <div className="row wrap">
          <button className="btn sm" onClick={() => cmd(arena, 'blackout', { on: true })}>Screen blackout ON</button>
          <button className="btn sm ghost" onClick={() => cmd(arena, 'blackout', { on: false })}>Blackout OFF</button>
          <button className="btn sm ghost" onClick={() => cmd(arena, 'clear_overlay')}>Clear all overlays</button>
        </div>
      </div>
      <div className="panel col">
        <div className="panel-title">Countdown on {target}</div>
        <div className="row"><input className="input" type="number" style={{ width: 100 }} value={cd.seconds} onChange={(e) => setCd({ ...cd, seconds: Number(e.target.value) })} />
          <input className="input grow" value={cd.label} onChange={(e) => setCd({ ...cd, label: e.target.value })} /></div>
        <button className="btn warn" onClick={() => cmd(arena, 'countdown', cd)}>Start countdown</button>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Countdowns are cosmetic. Game timers are always server-side.</p>
      </div>
      <div className="panel col danger">
        <div className="panel-title">Collapsing Campus · lockdowns on {target}</div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>From phase 1 an alarm sounds on a timetable (setting <b>lock_interval</b>), farthest buildings first, top floors before whole buildings. Each alarm gives squads <b>lock_warning</b> seconds to get out and opens a vault inside. Squads caught inside lose <b>lock_damage</b> HP and are thrown out. Hexavarsity never seals.</p>
        <button className="btn danger" onClick={() => cmd(arena, 'lock_next')}>🚨 Sound the next alarm now</button>
        <div className="row wrap">
          <select className="input" style={{ width: 200 }} value={lb.building} onChange={(e) => setLb({ building: e.target.value, level: '' })}>
            {LOCK_BUILDINGS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select className="input" style={{ width: 190 }} value={lb.level} onChange={(e) => setLb({ ...lb, level: e.target.value === '' ? '' : Number(e.target.value) })}>
            <option value="">Whole building</option>
            {Array.from({ length: LOCK_BUILDINGS.find((b) => b[0] === lb.building)?.[2] || 1 }, (_, f) => <option key={f} value={f}>Floor {f === 0 ? 'G' : f}</option>)}
          </select>
        </div>
        <div className="row wrap">
          <button className="btn sm warn grow" onClick={() => cmd(arena, 'lock_building', { building: lb.building, level: lb.level === '' ? null : lb.level })}>Alarm (with countdown)</button>
          <button className="btn sm danger grow" onClick={() => { if (confirm('Seal it immediately? Squads inside take damage now.')) cmd(arena, 'lock_building', { building: lb.building, level: lb.level === '' ? null : lb.level, now: true }); }}>Seal now</button>
        </div>
        <div className="row wrap">
          <button className="btn sm ghost" onClick={() => { if (confirm('Lift every lockdown on ' + target + '?')) cmd(arena, 'unlock_all'); }}>Lift all lockdowns</button>
          <button className="btn sm ghost" onClick={() => cmd(arena, 'spawn_loot')}>Top up med kits &amp; loot</button>
        </div>
      </div>
    </div>
  );
}

// ── Finale & results ────────────────────────────────────────────────────
const STAGE_KIND: Record<string, string> = { A: 'finale_entry', B: 'finale_exchange', C: 'finale_battle', E: 'final_code' };
function Finale({ d, arenas, arena, cmd }: { d: any; arenas: any[]; arena: string; cmd: Cmd }) {
  useNow(500);
  const target = arena === 'all' ? null : arena;
  const [secs, setSecs] = useState<number | ''>('');
  const [kind, setKind] = useState('finale_entry');
  const rounds = d.sync_rounds.filter((r: any) => r.status === 'active' && (arena === 'all' || r.arena_id === arena));
  const standings = (arenaId: string) => d.teams.filter((t: any) => t.arena_id === arenaId && t.ready)
    .sort((a: any, b: any) => b.points - a.points || b.final_points - a.final_points || b.missions - a.missions || b.battles - a.battles);
  return (
    <>
      <div className="panel warn">
        <div className="panel-title">Finale run-sheet {target ? '' : '(all maps)'}</div>
        <div className="col" style={{ gap: 8 }}>
          {Object.entries(FINALE_STAGES).map(([k, v]) => (
            <div key={k} className="list-item" style={{ flexWrap: 'wrap' }}>
              <b style={{ width: 24 }}>{k}</b><div className="grow"><b>{v.name}</b> <span className="muted">— {v.text}</span></div>
              <button className="btn xs" onClick={() => { cmd(target, 'finale_stage', { stage: k }); if (STAGE_KIND[k]) setKind(STAGE_KIND[k]); }}>Set stage</button>
              {STAGE_KIND[k] && <button className="btn xs primary" onClick={() => cmd(target, 'launch_sync', { kind: STAGE_KIND[k], seconds: secs || null })}>Launch round</button>}
              {k === 'D' && <button className="btn xs danger" onClick={() => cmd(target, 'final_lockdown')}>Final lockdown</button>}
            </div>
          ))}
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <select className="input" style={{ width: 240 }} value={kind} onChange={(e) => setKind(e.target.value)}>
            {['finale_entry', 'finale_exchange', 'finale_battle', 'final_code'].map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input className="input" type="number" style={{ width: 130 }} placeholder="secs (default)" value={secs} onChange={(e) => setSecs(e.target.value === '' ? '' : Number(e.target.value))} />
          <button className="btn sm primary" onClick={() => cmd(target, 'launch_sync', { kind, seconds: secs || null })}>Launch synchronized round</button>
          <button className="btn sm ghost" onClick={() => cmd(target, 'close_sync')}>Close round now</button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Points per round: 50–100% of the stage maximum depending on time left (entry/exchange {d.event.settings.finale_entry_max}, battles and final code {d.event.settings.finale_max}). Exchange rounds pair every squad with the next one; Intel Officers get a backup after {d.event.settings.intel_fallback}s (half points), so nobody can be blocked.</p>
      </div>
      {rounds.length > 0 && (
        <div className="panel"><div className="panel-title">Live rounds</div>
          {rounds.map((r: any) => <div key={r.id} className="list-item">{arenas.find((a) => a.id === r.arena_id)?.name} · {KIND_LABEL[r.kind]} · {r.solved}/{r.total} solved · <Countdown to={r.deadline} /></div>)}
        </div>
      )}
      <div className="grid2">
        {arenas.filter((a: any) => arena === 'all' || a.id === arena).map((a: any) => (
          <div key={a.id} className="panel">
            <div className="row between"><h3>{a.name}</h3><span className="chip">{a.results_locked ? 'locked' : 'live'}{a.winner_revealed ? ' · revealed' : ''}</span></div>
            <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>#</th><th>Squad</th><th>Pts</th><th>Final</th><th>Missions</th><th>Wins</th></tr></thead>
              <tbody>{standings(a.id).map((t: any, i: number) => <tr key={t.id}><td>{i + 1}</td><td>{t.number} · {t.name}</td><td><b>{t.points}</b></td><td>{t.final_points}</td><td>{t.missions}</td><td>{t.battles}</td></tr>)}</tbody></table>
            <div className="row wrap" style={{ marginTop: 10 }}>
              {!a.results_locked && <button className="btn sm warn" onClick={() => confirm(`Lock results for ${a.name}? The active round closes.`) && cmd(a.id, 'lock_results')}>Lock results</button>}
              {a.results_locked && !a.winner_revealed && <button className="btn sm gold" onClick={() => cmd(a.id, 'reveal_winner')}>🏆 Reveal winner</button>}
              {a.results_locked && <button className="btn sm ghost" onClick={() => confirm('Unlock results and return to the finale?') && cmd(a.id, 'unlock_results')}>Unlock</button>}
              <button className="btn sm ghost" onClick={() => confirm('End the game on this map?') && cmd(a.id, 'end_game')}>End game</button>
            </div>
            {a.results?.[0]?.tie && <p className="chip warn" style={{ whiteSpace: 'normal' }}>Tie at the top after all tie-breakers — run a tiebreaker round (launch a final round) before revealing.</p>}
          </div>
        ))}
      </div>
      {arenas.length > 1 && (
        <div className="panel">
          <div className="panel-title">Grand champion across all maps</div>
          <button className="btn gold" disabled={!arenas.every((a: any) => a.results_locked)} onClick={() => cmd(null, 'reveal_grand')}>Reveal grand champion on every projector</button>
          {!arenas.every((a: any) => a.results_locked) && <p className="muted" style={{ fontSize: 12 }}>Lock results on every map first.</p>}
        </div>
      )}
    </>
  );
}

// ── Links, QR and squad PINs ────────────────────────────────────────────
function Links({ d, token, refresh, cmd }: { d: any; token: string; refresh: () => void; cmd: Cmd }) {
  const joinUrl = `${window.location.origin}/join?e=${d.event.code}`;
  return (
    <>
      <div className="grid2 no-print">
        <div className="panel col" style={{ alignItems: 'center' }}>
          <div className="panel-title" style={{ alignSelf: 'flex-start' }}>Player join link (no secrets inside)</div>
          <QR value={joinUrl} size={200} />
          <code className="mono">{joinUrl}</code>
          <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(joinUrl); toast('Copied', 'good'); }}>Copy</button>
        </div>
        {d.arenas.map((a: any) => {
          const url = `${window.location.origin}/screen/${a.spectator_token}`;
          return (
            <div key={a.id} className="panel col" style={{ alignItems: 'center' }}>
              <div className="panel-title" style={{ alignSelf: 'flex-start' }}>Projector · {a.name} (read-only)</div>
              <QR value={url} size={160} />
              <div className="row wrap">
                <button className="btn sm" onClick={() => window.open(url, '_blank')}>Open</button>
                <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(url); toast('Copied', 'good'); }}>Copy</button>
                <button className="btn sm danger" onClick={() => confirm('Revoke this projector link? Open screens will disconnect.') && cmd(a.id, 'revoke_spectator')}>Revoke</button>
              </div>
            </div>
          );
        })}
      </div>
      <RosterPanel d={d} token={token} cmd={cmd} refresh={refresh} />
    </>
  );
}

// ── Settings ────────────────────────────────────────────────────────────
const SETTING_HELP: Record<string, string> = {
  pts_standard: 'Standard mission points', pts_hard: 'Hard mission points', pts_battle: 'Battle victory', pts_airdrop: 'Airdrop objective',
  pts_relay_bonus: 'Bonus to the squad that shared a codeword', pts_relocation: 'Escaping a collapsing zone in time', pen_recovery: 'Penalty on reaching 0 HP',
  finale_max: 'Max points per final battle/code round', finale_entry_max: 'Max points: entry lock', finale_exchange_max: 'Max points: exchange',
  hp_max: 'Max HP', hp_respawn: 'HP after recovery', dmg_fail: 'Damage for a failed mission', dmg_zone: 'Legacy zone damage (unused by the circular zone)', shield_max: 'Max shield',
  shuttle_seconds: 'Shuttle ride (s)', roles_seconds: 'Role claim window (s)', bus_size: 'Squads per bus', arena_size: 'Squads per map (≤15 keeps the free tier safe)',
  attack_cooldown: 'Attacker cooldown (s)', protect_seconds: 'Protection after battle/respawn (s)', recovery_seconds: 'Recovery window (s)',
  zone_warning: 'Zone warning (s)', airdrop_window: 'Airdrop claim window (s)', airdrop_interval: 'Auto airdrop every N minutes (0 = host only)',
  intel_fallback: 'Codeword backup to Intel after (s)', relay_chance: 'Chance (%) a mission is a cross-team relay', hint_cost: 'Hint cost (coins)',
  alliance_minutes: 'Alliance duration (min)', alliance_cost: 'Alliance cost (coins each)', chat_limit: 'Captain messages per 30 s',
  drop_seconds: 'First drop flight (s)', visit_missions: 'Missions per location visit', zone_auto: 'Legacy automatic zone schedule (1 = on)',
  zone_schedule: 'Legacy zone times (minutes, used when “Automatic zone schedule” = 1)', sync_seconds: 'Default finale round length (0 = per template)',
  auto_pacing: 'Automatic match phases (1 = on)', phase_schedule: 'Phase 1–4 start (minutes after play starts)', duel_phase: 'Duels unlock in phase',
  mission_time_pct: 'Mission timer scale (%)', pin_length: 'Digits in generated PINs (4–8)',
  move_speed: 'Run speed (‰ of campus per second; 25 ≈ 40 s to cross)', loc_radius: 'Location area radius (‰)', engage_range: 'Duel range (‰)',
  zone_tick_seconds: 'Outside the zone: damage every N s', zone_tick_damage: 'Outside the zone: HP lost per tick',
  red_interval: 'Red zone every N minutes from Phase 2 (0 = host only)', red_warning: 'Red zone warning (s)', red_damage: 'Red zone damage', red_radius: 'Red zone radius (‰)',
};
function Settings({ d, token, refresh }: { d: any; token: string; refresh: () => void }) {
  const [vals, setVals] = useState<any>(d.event.settings);
  async function save() {
    const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => String(v) !== String(d.event.settings[k]))
      .map(([k, v]) => [k, k === 'zone_schedule' || k === 'phase_schedule' ? String(v) : Number(v)]));
    if (!Object.keys(changed).length) return toast('No changes', 'info');
    try { await rpc('host_settings', { p_token: token, p_settings: changed }); toast('Settings saved', 'good'); refresh(); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  return (
    <div className="panel col">
      <div className="row between"><div className="panel-title">Balancing & timers</div><button className="btn primary sm" onClick={save}>Save changes</button></div>
      <div className="grid3">
        {Object.keys(SETTING_HELP).map((k) => (
          <div key={k} className="field"><label title={k}>{SETTING_HELP[k]}</label>
            <input className="input" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>These are starting values — rehearse and tune. Battle Points rank squads; coins buy items; HP only affects survival; trust unlocks alliances. They never mix.</p>
    </div>
  );
}

// ── Logs, moderation & export ───────────────────────────────────────────
function Logs({ d, token, arenas, cmd, map }: { d: any; token: string; arenas: any[]; cmd: Cmd; map: MapData | null }) {
  const [log, setLog] = useState<any>(null);
  const [chat, setChat] = useState<any[]>([]);
  const [arena, setArena] = useState(arenas[0]?.id);
  const load = useCallback(() => {
    rpc('host_audit', { p_token: token }).then(setLog).catch(() => {});
    if (arena) rpc('host_chat_log', { p_token: token, p_arena: arena }).then(setChat).catch(() => {});
  }, [token, arena]);
  useEffect(() => { load(); }, [load]);
  async function exportAll() {
    try {
      const r = await rpc('host_export', { p_token: token });
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      a.download = `${d.event.code}-event-summary.json`; a.click();
    } catch (e) { toast(friendly(e), 'bad'); }
  }
  return (
    <>
      <div className="row"><button className="btn sm" onClick={load}>Refresh</button><button className="btn sm gold" onClick={exportAll}>Export event summary (JSON)</button></div>
      <div className="grid2">
        <div className="panel col">
          <div className="row between"><div className="panel-title">Captain chat moderation</div>
            <select className="input" style={{ width: 160, minHeight: 34, padding: 4 }} value={arena} onChange={(e) => setArena(e.target.value)}>{arenas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="scroll-x" style={{ maxHeight: 420 }}>
            <table className="tbl"><tbody>{chat.map((m) => (
              <tr key={m.id} style={m.reported ? { background: 'rgba(255,77,94,0.12)' } : undefined}>
                <td>{m.from}→{m.to}</td><td style={{ textDecoration: m.hidden ? 'line-through' : undefined }}>{m.body}{m.reported && <span className="chip bad" style={{ marginLeft: 6 }}>reported</span>}</td>
                <td>{!m.hidden && <button className="btn xs danger" onClick={async () => { await cmd(null, 'hide_message', { message_id: m.id }, undefined, true); load(); }}>Hide</button>}</td>
              </tr>))}</tbody></table>
            {chat.length === 0 && <p className="muted">No messages.</p>}
          </div>
        </div>
        <div className="panel col">
          <div className="panel-title">Scoring ledger (latest)</div>
          <div className="scroll-x" style={{ maxHeight: 420 }}>
            <table className="tbl"><thead><tr><th>Squad</th><th>What</th><th>Pts</th><th>Coins</th><th>HP</th><th>Trust</th><th>By</th></tr></thead>
              <tbody>{(log?.ledger || []).map((l: any, i: number) => <tr key={i}><td>{l.team}</td><td>{l.kind}<div className="dim" style={{ fontSize: 11 }}>{l.reason}</div></td><td>{l.points || ''}</td><td>{l.coins || ''}</td><td>{l.hp || ''}</td><td>{l.trust || ''}</td><td>{l.actor}</td></tr>)}</tbody></table>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">Host audit log</div>
        <div className="scroll-x" style={{ maxHeight: 420 }}>
          <table className="tbl"><thead><tr><th>Time</th><th>Action</th><th>Args</th><th>Reason</th><th>Result</th></tr></thead>
            <tbody>{(log?.audit || []).map((a: any) => <tr key={a.id}><td>{new Date(a.at).toLocaleTimeString()}</td><td>{a.action}</td><td className="mono" style={{ fontSize: 11 }}>{a.args ? JSON.stringify(a.args).slice(0, 80) : ''}</td><td>{a.reason}</td><td>{a.ok ? '✔' : <span style={{ color: 'var(--red)' }}>✖ {a.error}</span>}</td></tr>)}</tbody></table>
        </div>
      </div>
    </>
  );
}

// ── Online edition: join link, maps that open by themselves, attendance export ──
function OnlinePanel({ d, token }: { d: any; token: string }) {
  const joinUrl = `${window.location.origin}/join?e=${d.event.code}`;
  const [sum, setSum] = useState<any>(null);
  const [maxMaps, setMaxMaps] = useState<string>(String(d.event.settings.online_max_maps ?? 8));
  const [domain, setDomain] = useState<string>(String(d.event.settings.email_domain ?? ''));
  const load = useCallback(() => { rpc('host_online_summary', { p_token: token }).then(setSum).catch(() => {}); }, [token]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function save() {
    try { await rpc('host_settings', { p_token: token, p_settings: { online_max_maps: Math.max(1, Math.min(12, Number(maxMaps) || 1)), email_domain: domain.trim().toLowerCase() } }); toast('Saved', 'good'); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  const [length, setLength] = useState<'quick' | 'standard' | 'full'>('standard');
  const [starting, setStarting] = useState(false);
  async function startGame() {
    if (!sum) return;
    if (!confirm(`Start the online game now?\n\n${sum.players} players · ${sum.squads} squads (${sum.short} still short).\nSmall squads are merged, squads are spread over the maps and every map takes off together. Nobody can create a new squad after this; late players fill open seats.`)) return;
    setStarting(true);
    try {
      const r = await rpc<any>('host_online_start', { p_token: token, p_length: length });
      toast(`Started: ${r.squads} squads on ${r.maps} map${r.maps > 1 ? 's' : ''}${r.merged ? ` · ${r.merged} players moved into fuller squads` : ''}${r.left_out ? ` · ${r.left_out} player could not be placed` : ''}`, 'good');
      load();
    } catch (e) { toast(friendly(e), 'bad'); } finally { setStarting(false); }
  }
  const [autoBusy, setAutoBusy] = useState(false);
  async function startAuto(on: boolean) {
    if (on && !confirm(`Start the online game in automatic mode?\n\nPlayers keep checking in and forming squads. Each map takes off by itself when it has ${sum?.map_size ?? 15} complete squads, or ${Math.round((sum?.fill_seconds ?? 180) / 60)} minutes after its first 4 players arrive. The next map then starts filling. Every match runs on its own.`)) return;
    setAutoBusy(true);
    try { setSum(await rpc<any>('host_online_auto', { p_token: token, p_length: length, p_on: on })); toast(on ? 'Automatic maps are on — maps take off by themselves' : 'Automatic starts paused', 'good'); }
    catch (e) { toast(friendly(e), 'bad'); } finally { setAutoBusy(false); }
  }
  async function launchNow() {
    if (!confirm('Launch the filling map now with the squads that are there?')) return;
    try { const r = await rpc<any>('host_online_launch', { p_token: token }); toast(`Map ${r.map} took off with ${r.squads} squads`, 'good'); load(); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  const fillMap = (sum?.maps || []).find((m: any) => !m.launched && m.players > 0);
  async function attendance() {
    try {
      const rows = await rpc<any[]>('host_attendance', { p_token: token });
      const cols = ['emp_id', 'name', 'email', 'map', 'squad', 'squad_name', 'squad_code', 'size', 'role', 'points', 'joined_at', 'last_seen_at'];
      const esc = (v: any) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      // employee IDs keep their leading zeros in Excel
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => (c === 'emp_id' ? `="${r[c]}"` : esc(r[c]))).join(','))].join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
      a.download = `${d.event.code}-attendance.csv`; a.click();
      toast(`${rows.length} players exported`, 'good');
    } catch (e) { toast(friendly(e), 'bad'); }
  }
  return (
    <>
      <div className="grid2">
        <div className="panel col" style={{ alignItems: 'center' }}>
          <div className="panel-title" style={{ alignSelf: 'flex-start' }}>Online join link — paste it in the Teams call chat</div>
          <QR value={joinUrl} size={180} />
          <code className="mono">{joinUrl}</code>
          <div className="row"><button className="btn sm" onClick={() => { navigator.clipboard?.writeText(joinUrl); toast('Copied', 'good'); }}>Copy link</button>
            <button className="btn sm gold" onClick={attendance}>⬇ Attendance (CSV)</button></div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Event code <b className="mono">{d.event.code}</b>. Players sign in with their 10-digit employee ID and company e-mail.</p>
        </div>
        <div className="panel col">
          <div className="panel-title">Check-in rules</div>
          <div className="field"><label htmlFor="mm">Most maps the game may use (60 players each)</label>
            <input id="mm" className="input" inputMode="numeric" value={maxMaps} onChange={(e) => setMaxMaps(e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field"><label htmlFor="dm">Allowed e-mail domains (comma-separated, empty = any)</label>
            <input id="dm" className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="hexaware.com" /></div>
          <button className="btn primary sm" onClick={save}>Save</button>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Squads of 3 are ready to play; squads of 4 are full. Nothing takes off until you press Start below — then maps fill and take off by themselves.</p>
        </div>
      </div>
      {sum && !sum.started && sum.auto && (
        <div className="panel online-start">
          <div className="row between"><div className="panel-title" style={{ margin: 0 }}>Automatic maps are ON</div><span className="chip good">● Running</span></div>
          <div className="os-stats">
            <div><b>{sum.players}</b><small>players checked in</small></div>
            <div><b>{(sum.maps || []).filter((m: any) => m.launched).length}</b><small>maps playing</small></div>
            <div><b>{fillMap ? `Map ${fillMap.number}` : '—'}</b><small>filling now</small></div>
            <div><b>{fillMap ? `${fillMap.squads}/${sum.map_size}` : '0'}</b><small>squads on it</small></div>
            <div><b>{fillMap?.fill_deadline ? <Countdown to={fillMap.fill_deadline} /> : fillMap ? 'waits for 4 players' : '—'}</b><small>takes off in</small></div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn primary" disabled={!fillMap} onClick={launchNow}>🛫 Launch {fillMap ? `Map ${fillMap.number}` : 'the filling map'} now</button>
            <button className="btn ghost" disabled={autoBusy} onClick={() => startAuto(false)}>⏸ Pause automatic starts</button>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Nothing else to press. A map takes off when it has {sum.map_size} complete squads, or {Math.round((sum.fill_seconds ?? 180) / 60)} minutes after its first 4 players arrive (45 seconds once all its squads are there). Small squads on that map are merged at take-off; extra players go to the next map, which starts filling at once. Keep this page open.</p>
        </div>
      )}
      {sum && !sum.started && !sum.auto && (
        <div className="panel online-start">
          <div className="panel-title">Start the online game</div>
          <div className="os-stats">
            <div><b>{sum.players}</b><small>players checked in</small></div>
            <div><b>{sum.squads}</b><small>squads</small></div>
            <div><b>{sum.full}</b><small>full (4)</small></div>
            <div><b>{sum.three}</b><small>ready (3)</small></div>
            <div className={sum.short ? 'warn' : ''}><b>{sum.short}</b><small>short (1–2) — merged at start</small></div>
            <div><b>{Math.min(sum.maps_needed, sum.max_maps)}</b><small>map{sum.maps_needed > 1 ? 's' : ''} at start</small></div>
          </div>
          <div className="auto-lengths">
            {(['quick', 'standard', 'full'] as const).map((l) => (
              <button key={l} className={length === l ? 'on' : ''} onClick={() => setLength(l)}>
                <b>{l === 'quick' ? 'Quick' : l === 'standard' ? 'Standard' : 'Full event'}</b><span>{l === 'quick' ? 'about 10 minutes' : l === 'standard' ? 'about 30 minutes' : '60–90 minutes'}</span>
              </button>
            ))}
          </div>
          <button className="btn primary big auto-start" disabled={autoBusy} onClick={() => startAuto(true)}>{autoBusy ? 'Starting…' : '▶ Start — automatic maps'}</button>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}><b>Recommended.</b> Press once: players keep joining, each map fills up and takes off by itself, and every match runs on its own.</p>
          <details><summary className="muted" style={{ cursor: 'pointer' }}>Or start everyone at once</summary>
          <button className="btn big" style={{ marginTop: 8 }} disabled={starting || sum.squads === 0} onClick={startGame}>{starting ? 'Starting…' : '▶ Start all squads now (one wave)'}</button>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Until you press Start, everyone waits in the lobby with their squad and nothing moves. At Start: squads of 1–2 are merged (a last squad of 2 plays with the bot covering), squads are spread evenly over the maps, and every map takes off together. Late players can still fill an open seat until their squad lands.</p>
          </details>
        </div>
      )}
      <div className="panel">
        <div className="row between"><div className="panel-title">{sum?.started ? 'Online maps' : 'Lobby'} · {sum?.players ?? '…'} players checked in</div><button className="btn sm" onClick={load}>Refresh</button></div>
        <table className="tbl"><thead><tr><th>Map</th><th>Phase</th><th>Takes off</th><th>Players</th><th>Squads</th><th>Full (4)</th><th>Ready (3+)</th><th>Short (1–2)</th><th>Projector</th></tr></thead>
          <tbody>{(sum?.maps || []).map((m: any) => {
            const a = d.arenas.find((x: any) => x.id === m.id);
            return <tr key={m.id}><td>Map {m.number}</td><td>{m.phase}</td><td>{m.launched ? '✓ playing' : m.fill_deadline ? <Countdown to={m.fill_deadline} /> : sum?.auto ? 'filling' : '—'}</td><td>{m.players}</td><td>{m.squads}</td><td>{m.full}</td><td>{m.ready}</td><td>{m.short ? <span className="chip warn">{m.short}</span> : 0}</td>
              <td>{a && <button className="btn xs" onClick={() => window.open(`${window.location.origin}/screen/${a.spectator_token}`, '_blank')}>Open</button>}</td></tr>;
          })}</tbody></table>
      </div>
    </>
  );
}
