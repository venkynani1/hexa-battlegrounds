// Host console additions for P0: pacing presets and timeline, phase controls, squad roster
// (codenames, QR codes, PIN reset, CSV), and Trial mode (guided checklist, simulated squads,
// fast-forward, reset).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendly, newKey, rpc, store } from '../lib/api';
import { MapData, MATCH_PHASES, neighbors } from '../lib/game';
import { msUntil, serverTime, useNow } from '../lib/time';
import { Countdown, QR, toast } from '../components/ui';
import { busCode } from '../components/Shuttle';

type Cmd = (arenaId: string | null, command: string, args?: any, reason?: string, quiet?: boolean) => Promise<any>;

// ── Pacing presets ────────────────────────────────────────────────────────
export const PRESETS: Record<string, { label: string; blurb: string; minutes: string; settings: Record<string, number | string> }> = {
  quick: {
    label: 'Quick demo', blurb: 'Whole match in about 10 minutes — for showing people how it works.', minutes: '8–12',
    settings: { auto_pacing: 1, phase_schedule: '1,3,5,7', zone_warning: 30, shuttle_seconds: 12, roles_seconds: 12, recovery_seconds: 45,
      airdrop_interval: 2, airdrop_window: 90, intel_fallback: 45, attack_cooldown: 45, protect_seconds: 45, mission_time_pct: 70 },
  },
  rehearsal: {
    label: 'Rehearsal', blurb: 'Every phase, compressed — for crew rehearsals.', minutes: '20–30',
    settings: { auto_pacing: 1, phase_schedule: '2,7,13,19', zone_warning: 45, shuttle_seconds: 20, roles_seconds: 15, recovery_seconds: 75,
      airdrop_interval: 4, airdrop_window: 120, intel_fallback: 60, attack_cooldown: 60, protect_seconds: 75, mission_time_pct: 85 },
  },
  full: {
    label: 'Full event', blurb: 'The real thing: long phases, cinematic shuttle, full mission timers.', minutes: '60–90',
    settings: { auto_pacing: 1, phase_schedule: '3,20,40,58', zone_warning: 90, shuttle_seconds: 30, roles_seconds: 15, recovery_seconds: 120,
      airdrop_interval: 8, airdrop_window: 180, intel_fallback: 90, attack_cooldown: 90, protect_seconds: 120, mission_time_pct: 100 },
  },
};

const ZONE_AT_PHASE = [0, 0, 1, 3, 4, 5];

export function PacingPanel({ d, token, refresh, arena }: { d: any; token: string; refresh: () => void; arena: any | null }) {
  useNow(1000);
  const st = d.event.settings;
  const sched = String(st.phase_schedule || '').split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
  const end = (sched[3] ?? 50) + 15; // +~15 min of finale
  const elapsed = arena?.play_started_at && arena.phase === 'play' ? (serverTime() - new Date(arena.play_started_at).getTime()) / 60000 : null;
  const starts = [0, ...sched.slice(0, 4)];
  async function apply(settings: Record<string, any>, label: string) {
    try { await rpc('host_settings', { p_token: token, p_settings: settings }); toast(`${label} applied`, 'good'); refresh(); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  return (
    <div className="panel col">
      <div className="row between wrap">
        <div className="panel-title" style={{ margin: 0 }}>Match pacing</div>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className={`chip ${Number(st.auto_pacing) ? 'good' : ''}`}>Auto phases {Number(st.auto_pacing) ? 'ON' : 'OFF'}</span>
          <button className="btn xs ghost" onClick={() => apply({ auto_pacing: Number(st.auto_pacing) ? 0 : 1 }, Number(st.auto_pacing) ? 'Manual pacing' : 'Automatic pacing')}>
            {Number(st.auto_pacing) ? 'Switch to manual' : 'Switch to automatic'}
          </button>
        </div>
      </div>
      <div className="grid3">
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} className="btn ghost" style={{ flexDirection: 'column', alignItems: 'flex-start', textTransform: 'none', letterSpacing: 0, height: 'auto', padding: 12 }}
            onClick={() => confirm(`Apply the ${p.label} preset to every map of this event?`) && apply(p.settings, p.label)}>
            <b className="up" style={{ fontSize: 15 }}>{p.label} · {p.minutes} min</b>
            <span className="muted" style={{ fontSize: 12, fontFamily: 'var(--font-body)' }}>{p.blurb}</span>
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>Shuttle ride:</span>
        <button className={`btn xs ${Number(st.shuttle_seconds) <= 15 ? 'primary' : 'ghost'}`} onClick={() => apply({ shuttle_seconds: 12 }, 'Short shuttle')}>Short · 12 s</button>
        <button className={`btn xs ${Number(st.shuttle_seconds) >= 25 ? 'primary' : 'ghost'}`} onClick={() => apply({ shuttle_seconds: 30 }, 'Cinematic shuttle')}>Cinematic · 30 s</button>
        <span className="muted" style={{ fontSize: 13 }}>Now {st.shuttle_seconds}s · zone warning {st.zone_warning}s · mission timers {st.mission_time_pct}%</span>
      </div>
      <div aria-label="Phase timeline">
        <div style={{ position: 'relative', height: 46, marginTop: 4 }}>
          {MATCH_PHASES.slice(0, 5).map((ph, i) => {
            const a = starts[i] ?? 0; const b = i < 4 ? starts[i + 1] ?? end : end;
            return (
              <div key={i} title={`${ph.name}: ${ph.rules}`} style={{ position: 'absolute', left: `${(a / end) * 100}%`, width: `${((b - a) / end) * 100}%`, top: 0, height: 30,
                background: ['#173a6b', '#1d4f8f', '#7a4a12', '#8a2a1c', '#6b1a3a'][i], borderRight: '2px solid #050912', padding: '4px 6px', overflow: 'hidden', fontSize: 11, whiteSpace: 'nowrap' }}>
                <b>{i}</b> {ph.name} {ZONE_AT_PHASE[i] > ZONE_AT_PHASE[Math.max(0, i - 1)] && <span title="zone contracts">☢{ZONE_AT_PHASE[i]}</span>}
              </div>
            );
          })}
          <div style={{ position: 'absolute', left: `${((sched[3] ?? 50) / end) * 100}%`, right: 0, top: 0, height: 30, background: '#5a4500', padding: '4px 6px', fontSize: 11, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <b>5</b> TR14 finale (host)
          </div>
          {elapsed !== null && elapsed <= end && <div style={{ position: 'absolute', left: `${(elapsed / end) * 100}%`, top: -4, height: 40, width: 3, background: '#3ef0ff', boxShadow: '0 0 8px #3ef0ff' }} title="Now" />}
          <div className="row between" style={{ position: 'absolute', top: 32, left: 0, right: 0, fontSize: 11 }} >
            <span className="muted">0 min</span><span className="muted">{Math.round(end / 2)} min</span><span className="muted">~{end} min</span>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
          Phases start at minutes {sched.join(', ')} after play begins{Number(st.auto_pacing) ? '' : ' (manual: use Next phase)'}. ☢ marks zone contractions; each one is announced {st.zone_warning}s ahead. The finale always starts when you press Begin finale.
        </p>
      </div>
    </div>
  );
}

export function PhaseControls({ a, cmd }: { a: any; cmd: Cmd }) {
  useNow(1000);
  if (a.phase !== 'play') return null;
  const ph = a.match_phase ?? 0;
  return (
    <div className="phase-banner" style={{ marginTop: 10, flexWrap: 'wrap' }}>
      <span className="ph-n">{ph}</span>
      <div className="grow" style={{ minWidth: 160 }}>
        <b className="up" style={{ fontSize: 14 }}>{MATCH_PHASES[ph]?.name}</b>
        <div className="muted" style={{ fontSize: 12 }}>{MATCH_PHASES[ph]?.rules}{a.phase_next_at && msUntil(a.phase_next_at) > 0 && <> · next in <Countdown to={a.phase_next_at} /></>}</div>
      </div>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn xs ghost" disabled={ph <= 0} onClick={() => cmd(a.id, 'set_phase', { phase: ph - 1 })}>◀</button>
        <button className="btn xs primary" disabled={ph >= 4} onClick={() => cmd(a.id, 'next_phase')}>Next phase ▶</button>
        <button className={`btn xs ${a.overlay?.hide_rankings ? 'warn' : 'ghost'}`} onClick={() => cmd(a.id, 'hide_rankings', { on: !a.overlay?.hide_rankings })}>
          {a.overlay?.hide_rankings ? 'Rankings hidden' : 'Hide rankings'}
        </button>
      </div>
    </div>
  );
}

// ── Roster: codenames, QR per squad, PIN reset, CSV ──────────────────────
const issuedPins = new Map<number, string>(); // squad number → PIN shown in this browser session only

export function RosterPanel({ d, token, cmd, refresh }: { d: any; token: string; cmd: Cmd; refresh: () => void }) {
  const [roster, setRoster] = useState<any[]>([]);
  const [count, setCount] = useState(15);
  const [csv, setCsv] = useState('');
  const [, force] = useState(0);
  const load = useCallback(() => rpc('host_roster', { p_token: token }).then(setRoster).catch((e) => toast(friendly(e), 'bad')), [token]);
  useEffect(() => { load(); }, [load, d.teams.length]);
  const origin = window.location.origin;
  const remember = (rows: any[]) => { rows.forEach((r) => r.pin && issuedPins.set(r.number, r.pin)); force((x) => x + 1); };

  async function generate() {
    try { remember(await rpc('host_generate_teams', { p_token: token, p_count: count })); toast(`${count} squads created — print or download the PINs now`, 'good'); load(); refresh(); }
    catch (e) { toast(friendly(e), 'bad'); }
  }
  async function importCsv() {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const head = lines[0]?.toLowerCase().includes('squad') || lines[0]?.toLowerCase().includes('number') ? lines.shift()!.toLowerCase().split(',').map((x) => x.trim()) : ['number', 'name', 'pin', 'map'];
    const col = (n: string[]) => head.findIndex((h) => n.includes(h));
    const ci = { number: col(['number', 'squad', 'squad number']), name: col(['name', 'squad name']), pin: col(['pin']), map: col(['map', 'arena']) };
    const rows = lines.map((l) => { const c = l.split(',').map((x) => x.trim()); return { number: c[ci.number], name: ci.name >= 0 ? c[ci.name] : '', pin: ci.pin >= 0 ? c[ci.pin] : '', map: ci.map >= 0 ? c[ci.map] : '' }; });
    try {
      const r = await rpc('host_import_teams', { p_token: token, p_teams: rows });
      remember(r.squads || []);
      toast(`Imported ${r.imported} squads`, 'good'); setCsv(''); load(); refresh();
    } catch (e) { toast(friendly(e), 'bad'); }
  }
  async function resetPin(t: any) {
    if (!confirm(`Issue a new PIN for squad ${t.number} (${t.name})? The old PIN stops working immediately. Players already in the squad stay in.`)) return;
    const r = await cmd(null, 'reset_pin', { team_id: t.team_id }, 'PIN reset by host');
    const pin = r?.event?.pin;
    if (pin) { issuedPins.set(t.number, pin); force((x) => x + 1); toast(`New PIN for squad ${t.number}: ${pin}`, 'good'); }
  }
  function download() {
    const rows = roster.map((t) => [t.map, t.number, t.name, busCode(t.bus), issuedPins.get(t.number) || '', `${origin}/join?e=${d.event.code}&s=${t.number}`]);
    const body = 'map,squad,name,bus,pin,join_link\n' + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    a.download = `${d.event.code}-roster.csv`; a.click();
  }
  const known = roster.filter((t) => issuedPins.has(t.number)).length;
  return (
    <>
      <div className="grid2 no-print">
        <div className="panel col">
          <div className="panel-title">Create squads with secure PINs</div>
          <div className="row"><input className="input" type="number" min={1} max={120} style={{ width: 110 }} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of squads" />
            <button className="btn primary grow" onClick={generate}>Create {count} squads</button></div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>Squads get codenames (Alpha-01, Bravo-02…), a bus and a {d.event.settings.pin_length}-digit PIN from strong randomness. Maps fill 15 squads at a time. PINs are stored hashed: print or download them before leaving this page; you can always issue a new one per squad.</p>
        </div>
        <div className="panel col">
          <div className="panel-title">…or import an approved squad list (CSV)</div>
          <textarea className="input" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'number,name,pin,map\n1,Code Falcons,582039,1\n2,Bug Busters,,1'} style={{ minHeight: 110 }} />
          <div className="row wrap">
            <button className="btn" disabled={!csv.trim()} onClick={importCsv}>Validate and import</button>
            <button className="btn ghost sm" onClick={() => setCsv('number,name,pin,map\n')}>Insert template</button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>The whole file is checked first (duplicate squads, unknown maps, weak PINs such as 123456 or 7777) and nothing is written if any row fails. Leave PIN empty to have one generated.</p>
        </div>
      </div>
      <div className="panel col print-area">
        <div className="row between wrap no-print">
          <div className="panel-title" style={{ margin: 0 }}>Squad roster · {roster.length} squads · PINs known in this session: {known}</div>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm" onClick={load}>Refresh</button>
            <button className="btn sm gold" onClick={download}>Download CSV</button>
            <button className="btn sm" onClick={() => window.print()}>Print squad cards</button>
          </div>
        </div>
        <div className="print-only"><h2>{d.event.name} · {d.event.code}</h2><p>Scan your squad's code, then enter your squad PIN. Keep the PIN within your squad.</p></div>
        <div className="roster-grid">
          {roster.map((t) => (
            <div key={t.team_id} className="roster-card">
              <QR value={`${origin}/join?e=${d.event.code}&s=${t.number}`} size={96} />
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <b className="up" style={{ fontSize: 17 }}>#{String(t.number).padStart(2, '0')} {t.name}</b>
                <span className="muted" style={{ fontSize: 12 }}>Map {t.map} · {busCode(t.bus)} · {t.players}/4 joined</span>
                <span className="mono" style={{ fontSize: 15 }}>PIN: {issuedPins.get(t.number) || <span className="dim">hidden</span>}</span>
                <button className="btn xs ghost no-print" style={{ alignSelf: 'flex-start' }} onClick={() => resetPin(t)}>Issue new PIN</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Trial mode ────────────────────────────────────────────────────────────
type Bot = { team_id: string; number: number; tokens: string[] };
const botKey = (code: string) => `hb_bots_${code}`;
const loadBots = (code: string): Bot[] => { try { return JSON.parse(store.get(botKey(code)) || '[]'); } catch { return []; } };

const STEPS: { key: string; label: string; how: string; action?: { cmd: string; label: string; args?: any; reason?: string } }[] = [
  { key: 'squads', label: 'Squads prepared', how: 'Create squads in Links & PINs, or add simulated squads below.' },
  { key: 'joined', label: 'A squad joins (4/4)', how: 'Scan the join QR on a phone with a squad PIN — or rely on simulated squads.' },
  { key: 'boarding', label: 'Bus lobby & boarding', how: 'Phones show the bus interior and departure board. Open boarding assigns buses.', action: { cmd: 'open_boarding', label: 'Open boarding' } },
  { key: 'shuttle', label: 'Shuttle departs', how: 'Doors close, the bus drives to Gate 1 on every screen at the same moment.', action: { cmd: 'drive', label: 'DRIVE' } },
  { key: 'roles', label: 'Gate 1 role claim', how: 'First tap wins; unclaimed roles are auto-assigned when the timer ends.', action: { cmd: 'finalize_roles', label: 'Close role claims now' } },
  { key: 'movement', label: 'Map navigation', how: 'The captain picks a drop zone; the squad travels and lands.' },
  { key: 'mission', label: 'First mission solved', how: 'Scout, Decoder and Intel each see a different clue; only the captain can submit.' },
  { key: 'wrong_answer', label: 'Wrong answer handled', how: 'A wrong answer costs an attempt; three wrong answers fail the mission (−10 HP).' },
  { key: 'phase2', label: 'Phase 2 · duels unlock', how: 'Advance the match phase; the first zone contraction is announced.', action: { cmd: 'next_phase', label: 'Next phase' } },
  { key: 'battle', label: 'Squad encounter / duel', how: 'Two squads at one location can duel once duels unlock.' },
  { key: 'airdrop', label: 'Airdrop claimed', how: 'Drop a crate; squads at that location race to crack it.', action: { cmd: 'spawn_airdrop', label: 'Spawn airdrop', args: { tier: 'rare' } } },
  { key: 'zone', label: 'Zone contraction', how: 'Squads outside take damage once and are evacuated to safety.', action: { cmd: 'zone_now', label: 'Collapse next stage' } },
  { key: 'recovery', label: 'Recovery at 0 HP', how: 'Nobody is eliminated: a squad at 0 HP solves a recovery puzzle or respawns on a timer.' },
  { key: 'pause', label: 'Pause and resume', how: 'Every timer freezes during a pause and shifts on resume.', action: { cmd: 'pause', label: 'Pause' } },
  { key: 'chat', label: 'Captain chat', how: 'Captains message each other to trade codewords and alliances.' },
  { key: 'finale', label: 'Finale in TR14', how: 'All squads move to Training Room 14 together.', action: { cmd: 'begin_finale', label: 'Begin finale' } },
  { key: 'finale_round', label: 'Finale round solved', how: 'Every squad gets the same synchronized challenge.', action: { cmd: 'launch_sync', label: 'Launch round', args: { kind: 'finale_entry' } } },
  { key: 'results', label: 'Results locked', how: 'Standings freeze and stay hidden until the reveal.', action: { cmd: 'lock_results', label: 'Lock results' } },
  { key: 'winner', label: 'Winner reveal', how: 'Projector countdown, podium and confetti.', action: { cmd: 'reveal_winner', label: 'Reveal winner' } },
];
const MANUAL = [
  ['privacy', 'Mission privacy', 'Open two teammates’ phones: each shows a different clue; the captain sees answer boxes only.'],
  ['reconnect', 'Reconnection', 'Close a phone’s browser mid-mission and reopen /play — same role, same clue, same timer.'],
  ['projector', 'Projector check', 'Readable from the back row, sound on, correct map.'],
];

export function TrialPanel({ d, token, cmd, map, arena, onLogout }: { d: any; token: string; cmd: Cmd; map: MapData | null; arena: string; onLogout: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [bots, setBots] = useState<Bot[]>(() => loadBots(d.event.code));
  const [botCount, setBotCount] = useState(3);
  const [running, setRunning] = useState(false);
  const [accuracy, setAccuracy] = useState(0.8);
  const [manual, setManual] = useState<Record<string, boolean>>(() => { try { return JSON.parse(store.get(`hb_manual_${d.event.code}`) || '{}'); } catch { return {}; } });
  const target = arena === 'all' ? null : arena;
  const botLog = useBotDriver({ token, code: d.event.code, running, accuracy, map });

  useEffect(() => {
    let stop = false;
    const tick = () => rpc('host_trial_status', { p_token: token }).then((s) => !stop && setStatus(s)).catch(() => {});
    tick();
    const id = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [token]);

  if (status && !status.is_trial) {
    return (
      <div className="panel warn col">
        <div className="panel-title">Trial mode</div>
        <p style={{ margin: 0 }}>This is a <b>live event</b>, so trial controls (fast-forward, simulated squads, trial reset) are switched off here on purpose. Rehearse in a separate trial event: it has its own code, squads and data, and can never touch this one.</p>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Log out, choose <b>Trial</b> on the host login screen and create e.g. <code>{d.event.code}T</code>.</li>
          <li>Open Trial in that event and follow the guided checklist.</li>
        </ol>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={onLogout}>Log out to create a trial</button>
      </div>
    );
  }
  const steps = status?.steps || {};
  const done = STEPS.filter((s) => steps[s.key]).length + MANUAL.filter(([k]) => manual[k]).length;
  const total = STEPS.length + MANUAL.length;
  const lobbyArena = d.arenas.find((a: any) => (target ? a.id === target : true) && a.phase === 'lobby');

  async function addBots() {
    if (!lobbyArena) return toast('Simulated squads can only board a map that is still in the lobby. Reset the map first.', 'warn');
    const r = await cmd(lobbyArena.id, 'trial_bots', { count: botCount });
    const added: Bot[] = r?.[lobbyArena.id]?.bots || [];
    if (added.length) {
      const all = [...loadBots(d.event.code), ...added];
      store.set(botKey(d.event.code), JSON.stringify(all)); setBots(all);
      toast(`${added.length} simulated squads joined ${lobbyArena.name}`, 'good');
    }
  }
  function toggleManual(k: string) {
    const m = { ...manual, [k]: !manual[k] };
    setManual(m); store.set(`hb_manual_${d.event.code}`, JSON.stringify(m));
  }
  return (
    <>
      <div className="panel warn col">
        <div className="row between wrap">
          <div className="panel-title" style={{ margin: 0 }}>Trial mode · guided rehearsal</div>
          <span className="chip gold">{done}/{total} checked</span>
        </div>
        <div className="bar"><i style={{ width: `${(done / total) * 100}%` }} /></div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>This event is labelled TRIAL on every phone and projector. Fast-forward moves the server clock for this event only; live events reject every trial command.</p>
      </div>
      <div className="grid2">
        <div className="panel col">
          <div className="panel-title">Simulated squads</div>
          <div className="row wrap">
            <input className="input" type="number" min={1} max={15} style={{ width: 90 }} value={botCount} onChange={(e) => setBotCount(Number(e.target.value))} aria-label="Simulated squads to add" />
            <button className="btn primary" onClick={addBots}>Add simulated squads{lobbyArena ? ` to ${lobbyArena.name}` : ''}</button>
          </div>
          <div className="row wrap">
            <button className={`btn ${running ? 'danger' : 'gold'}`} disabled={!bots.length} onClick={() => setRunning((r) => !r)}>{running ? '■ Stop simulated players' : '▶ Start simulated players'}</button>
            <select className="input" style={{ width: 170 }} value={accuracy} onChange={(e) => setAccuracy(Number(e.target.value))} aria-label="Simulated accuracy">
              <option value={0.6}>60% correct answers</option><option value={0.8}>80% correct answers</option><option value={0.95}>95% correct answers</option>
            </select>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>{bots.length} simulated squads ({bots.length * 4} players). They join with real PINs and play through exactly the same player and captain calls as phones: claim roles, move, search, duel, crack airdrops, answer finale rounds. They take answers from the host view, so this tab must stay open.</p>
          {botLog.length > 0 && <div className="clue mono" style={{ fontSize: 12, maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{botLog.slice(-8).join('\n')}</div>}
        </div>
        <div className="panel col">
          <div className="panel-title">Time controls {target ? '' : '(all maps)'}</div>
          <div className="row wrap">
            {[15, 60, 180].map((s) => <button key={s} className="btn" onClick={() => cmd(target, 'trial_skip', { seconds: s }, undefined, true).then(() => toast(`Fast-forwarded ${s}s`, 'good'))}>⏩ +{s >= 60 ? `${s / 60} min` : `${s}s`}</button>)}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>Fast-forward shifts every server deadline (shuttle, roles, missions, battles, phases, zone, airdrops) — clients follow automatically. Combine with the Quick demo preset to see a full match in about 10 minutes.</p>
          <div className="row wrap">
            <button className="btn danger" onClick={() => confirm('Reset the trial map(s) to the lobby? Squads and players stay; gameplay is wiped.') && cmd(target, 'trial_reset')}>Reset trial to lobby</button>
            <button className="btn ghost" onClick={() => { store.del(botKey(d.event.code)); setBots([]); setRunning(false); }}>Forget simulated squads</button>
          </div>
        </div>
      </div>
      <div className="panel col">
        <div className="panel-title">Rehearsal checklist</div>
        <div className="list">
          {STEPS.map((s, i) => (
            <div key={s.key} className="list-item" style={{ alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18, width: 22, color: steps[s.key] ? 'var(--green)' : 'var(--dim)' }} aria-label={steps[s.key] ? 'done' : 'not yet'}>{steps[s.key] ? '✔' : '○'}</span>
              <div className="grow"><b>{i + 1}. {s.label}</b><div className="muted" style={{ fontSize: 13 }}>{s.how}</div></div>
              {s.action && <button className="btn xs" onClick={() => cmd(target, s.action!.cmd, s.action!.args || {})}>{s.action.label}</button>}
              {s.key === 'pause' && <button className="btn xs" onClick={() => cmd(target, 'resume')}>Resume</button>}
            </div>
          ))}
          {MANUAL.map(([k, label, how]) => (
            <label key={k} className="list-item check" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!manual[k]} onChange={() => toggleManual(k)} />
              <div className="grow"><b>{label}</b> <span className="chip">manual</span><div className="muted" style={{ fontSize: 13 }}>{how}</div></div>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// Plays simulated squads through the public player/captain RPCs (never writes game state directly).
function useBotDriver({ token, code, running, accuracy, map }: { token: string; code: string; running: boolean; accuracy: number; map: MapData | null }) {
  const [log, setLog] = useState<string[]>([]);
  const acc = useRef(accuracy); acc.current = accuracy;
  const mapRef = useRef(map); mapRef.current = map;
  const say = (t: string) => setLog((l) => [...l.slice(-30), `${new Date().toLocaleTimeString()}  ${t}`]);

  const step = useMemo(() => async () => {
    const bots = loadBots(code);
    if (!bots.length) return;
    const ov = await rpc('host_overview', { p_token: token });
    for (const b of bots) {
      const states = await Promise.all(b.tokens.map((t) => rpc('player_state', { p_token: t }).catch(() => null)));
      const any = states.find(Boolean);
      if (!any || any.arena.paused) continue;
      const phase = any.arena.phase;
      if (phase === 'roles') {
        const free = ['captain', 'scout', 'decoder', 'intel'].filter((r) => !any.roles?.[r]);
        for (let i = 0; i < b.tokens.length && free.length; i++) {
          if (states[i]?.me.role) continue;
          const r = free.shift()!;
          await rpc('claim_role', { p_token: b.tokens[i], p_role: r }).then(() => say(`#${b.number} claimed ${r}`)).catch(() => {});
        }
        continue;
      }
      if (phase !== 'play' && phase !== 'finale') continue;
      const ci = states.findIndex((s) => s?.me.role === 'captain');
      if (ci < 0) continue;
      const s = states[ci]; const tok = b.tokens[ci];
      const team = ov.teams.find((t: any) => t.id === s.team.id);
      const act = s.battle || s.mission;
      try {
        if (act && team?.activity && team.activity.id === act.id) {
          const started = new Date(act.started_at || s.server_now).getTime();
          const wait = 6000 + ((b.number * 3700) % 9000);
          if (serverTime() - started < wait) continue;
          let answers = team.activity.answer.map((p: any) => (p.accept[0] === '{KEY}' ? team.activity.relay_key : p.accept[0]));
          const right = Math.random() < acc.current;
          if (!right) answers = answers.map(() => 'WRONG');
          const r = await rpc('captain_submit', { p_token: tok, p_instance: act.id, p_answers: answers, p_idem: newKey() });
          say(`#${b.number} ${r.correct ? 'solved' : 'missed'} “${act.title}”`);
          continue;
        }
        if (phase !== 'play' || s.team.state !== 'idle') continue;
        const here = (s.airdrops || []).find((a: any) => a.location === s.team.location);
        if (here) { await rpc('captain_claim_airdrop', { p_token: tok, p_airdrop: here.id }); say(`#${b.number} cracking an airdrop`); continue; }
        const m = s.arena.overlay?.match;
        const duels = m && m.phase >= (m.duel_phase ?? 2) && !(s.team.attack_cooldown_until && new Date(s.team.attack_cooldown_until).getTime() > serverTime());
        const foe = (s.squads || []).find((x: any) => x.id !== s.team.id && x.location === s.team.location && !x.protected && !x.in_battle && !x.traveling);
        if (duels && foe && Math.random() < 0.3) { await rpc('captain_attack', { p_token: tok, p_target: foe.id, p_weapon: 'pistol' }); say(`#${b.number} engaged squad ${foe.number}`); continue; }
        if (s.team.dropped && s.team.visit_missions < s.team.visit_limit && Math.random() < 0.4) { await rpc('captain_explore', { p_token: tok }); continue; }
        const mp = mapRef.current;
        if (!mp) continue;
        const zone = s.arena.zone_stage;
        const options = !s.team.dropped
          ? mp.locations.filter((l) => l.drop && l.enabled && l.collapse > zone).map((l) => l.id)
          : [...neighbors(mp, s.team.location).keys()].filter((id) => { const l = mp.locations.find((x) => x.id === id); return l && l.enabled && l.kind !== 'start' && l.collapse > zone; });
        if (options.length) {
          const dest = options[Math.floor(Math.random() * options.length)];
          await rpc('captain_move', { p_token: tok, p_location: dest }); say(`#${b.number} → ${dest}`);
        }
      } catch (e) { say(`#${b.number} ${friendly(e)}`); }
    }
  }, [token, code]);

  useEffect(() => {
    if (!running) return;
    let stop = false;
    (async () => {
      say('Simulated players started');
      while (!stop) {
        try { await step(); } catch (e) { say(friendly(e)); }
        await new Promise((r) => setTimeout(r, 2500));
      }
    })();
    return () => { stop = true; say('Simulated players stopped'); };
  }, [running, step]);
  return log;
}
