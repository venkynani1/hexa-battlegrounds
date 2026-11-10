// Host console additions for P0: pacing presets and timeline, phase controls, squad roster
// (codenames, QR codes, PIN reset, CSV).
// fast-forward, reset).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendly, newKey, rpc, store } from '../lib/api';
import { MapData, MATCH_PHASES, neighbors } from '../lib/game';
import { msUntil, serverTime, useNow } from '../lib/time';
import { Countdown, QR, toast } from '../components/ui';
import { busCode } from '../components/Flight';

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

/** PINs the server handed to this browser session (never stored). */
export function rememberPins(rows: any[]) { rows.forEach((r) => r.pin && issuedPins.set(r.number, r.pin)); }

export function RosterPanel({ d, token, cmd, refresh }: { d: any; token: string; cmd: Cmd; refresh: () => void }) {
  const [roster, setRoster] = useState<any[]>([]);
  const [count, setCount] = useState(15);
  const [csv, setCsv] = useState('');
  const [, force] = useState(0);
  const load = useCallback(() => rpc('host_roster', { p_token: token }).then(setRoster).catch((e) => toast(friendly(e), 'bad')), [token]);
  useEffect(() => { load(); }, [load, d.teams.length]);
  const origin = window.location.origin;
  const remember = (rows: any[]) => { rememberPins(rows); force((x) => x + 1); };
  // fixed squad cards: same PINs and QR codes every time (derived from the host password on the server)
  const [cardSet, setCardSet] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [fixing, setFixing] = useState(false);
  useEffect(() => { rpc<any>('host_extras', { p_token: token }).then((x) => setCardSet(x.card_set || null)).catch(() => {}); }, [token]);
  const joinLink = (n: number) => (cardSet ? `${origin}/join?c=${cardSet}-${n}` : `${origin}/join?e=${d.event.code}&s=${n}`);
  async function fixedCards() {
    setFixing(true);
    try {
      const r = await rpc<any>('host_fixed_cards', { p_token: token, p_secret: secret });
      remember(r.squads || []); setCardSet(r.set); setSecret('');
      toast(r.created ? `Fixed cards ready: ${r.created} squads created` : 'Fixed cards ready: PINs shown below', 'good'); load(); refresh();
    } catch (e) { toast(friendly(e), 'bad'); } finally { setFixing(false); }
  }

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
    const rows = roster.map((t) => [t.map, t.number, t.name, busCode(t.bus), issuedPins.get(t.number) || '', joinLink(t.number)]);
    const body = 'map,squad,name,bus,pin,join_link\n' + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    a.download = `${d.event.code}-roster.csv`; a.click();
  }
  const known = roster.filter((t) => issuedPins.has(t.number)).length;
  return (
    <>
      <div className="panel col no-print" style={{ borderColor: 'var(--gold)' }}>
        <div className="panel-title">Fixed squad cards {cardSet && <span className="chip good" style={{ marginLeft: 8 }}>in use</span>}</div>
        <p style={{ margin: 0, fontSize: 14 }}>The same PIN and the same QR code for every squad, every time you create an event with this host password: squads 1–15 on Map 1, 16–30 on Map 2, 31–45 on Map 3. Print the cards once and reuse them for rehearsals and the real event.</p>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); fixedCards(); }}>
          <input className="input grow" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Host password" aria-label="Host password" autoComplete="current-password" minLength={6} required style={{ minWidth: 180 }} />
          <button className="btn gold" disabled={fixing || secret.length < 6}>{cardSet ? 'Show my fixed PINs' : 'Use my fixed cards'}</button>
        </form>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Missing squads are created; squads that already exist keep their players and get their fixed PIN. The QR code opens the newest event that uses these cards. Change the host password and you get a different card set.</p>
      </div>
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
              <QR value={joinLink(t.number)} size={96} />
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
