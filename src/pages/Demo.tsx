// Demo mode control room. One click creates a match full of dummy squads that play by themselves:
// they drop, drive, search, solve challenges, fight, grab crates, run from lockdowns and play the
// finale. The big screen shows the projector view; the phone on the right is what any chosen
// dummy player sees, and a captain's phone can be taken over to play against the dummies.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { friendly, GameError, rpc, store } from '../lib/api';
import { ROLE_ORDER, ROLES, Role } from '../lib/game';
import { toast } from '../components/ui';

type Session = { token: string; code: string };
const LENGTHS: [string, string, string][] = [['quick', 'Quick', 'about 15 min'], ['standard', 'Standard', 'about 35 min'], ['full', 'Full', 'about 75 min']];

function load(): Session | null { try { return JSON.parse(store.get('hb_demo') || 'null'); } catch { return null; } }

export default function Demo() {
  const [sess, setSess] = useState<Session | null>(load);
  const end = useCallback(() => { store.del('hb_demo'); setSess(null); }, []);
  return sess ? <Room sess={sess} onEnd={end} /> : <Start onStart={(s) => { store.set('hb_demo', JSON.stringify(s)); setSess(s); }} />;
}

function Start({ onStart }: { onStart: (s: Session) => void }) {
  const [maps, setMaps] = useState(1);
  const [length, setLength] = useState('quick');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await rpc<any>('demo_create', { p_maps: maps, p_squads: 15, p_length: length });
      onStart({ token: r.token, code: r.code });
    } catch (e) { setErr(friendly(e)); } finally { setBusy(false); }
  }
  return (
    <div className="app" style={{ maxWidth: 640 }}>
      <div className="demo-start">
        <div className="brand" style={{ alignItems: 'flex-start' }}><span className="l1">Demo mode</span><span className="l2">Battlegrounds</span></div>
        <p style={{ margin: 0 }}>See a whole match without gathering 60 people. Dummy squads of four play by themselves on the real map with the real rules. You watch the big screen, open any dummy player's phone, or take a squad over and play against the rest.</p>
        <div className="panel col">
          <div className="panel-title">How many maps?</div>
          <div className="demo-opts">
            {[1, 2, 3].map((n) => (
              <button key={n} className={maps === n ? 'on' : ''} onClick={() => setMaps(n)} aria-pressed={maps === n}>
                <b>{n} map{n > 1 ? 's' : ''}</b><small>{n * 15} squads, {n * 60} dummy players</small>
              </button>
            ))}
          </div>
          <div className="panel-title" style={{ marginTop: 6 }}>How long?</div>
          <div className="demo-opts">
            {LENGTHS.map(([id, name, sub]) => (
              <button key={id} className={length === id ? 'on' : ''} onClick={() => setLength(id)} aria-pressed={length === id}><b>{name}</b><small>{sub}</small></button>
            ))}
          </div>
        </div>
        {err && <div className="chip bad" style={{ whiteSpace: 'normal', padding: 10 }}>{err}</div>}
        <button className="btn primary big" disabled={busy} onClick={go}>{busy ? 'Setting up the match…' : 'Start the demo match'}</button>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>A demo is separate from your real events and is deleted after a few hours. Keep this page open while it runs: it keeps the match clock ticking.</p>
        <Link to="/" className="btn ghost">Back to the lobby</Link>
      </div>
    </div>
  );
}

function Room({ sess, onEnd }: { sess: Session; onEnd: () => void }) {
  const [x, setX] = useState<any>(null);
  const [map, setMap] = useState(1);
  const [squad, setSquad] = useState<number | null>(null);
  const [role, setRole] = useState<Role>('captain');
  const [phone, setPhone] = useState<string | null>(null);
  const [pane, setPane] = useState<'map' | 'phone'>('map');
  const dead = useRef(false);

  // squads, maps and scores every few seconds; the match clock every second
  useEffect(() => {
    let stop = false;
    const gone = (e: unknown) => {
      if (e instanceof GameError && (e.code === 'HOST_AUTH' || e.code === 'NOT_DEMO') && !dead.current) { dead.current = true; toast('This demo has ended', 'warn'); onEnd(); }
    };
    const extras = () => rpc<any>('host_extras', { p_token: sess.token }).then((r) => { if (!stop) setX(r); }).catch(gone);
    extras();
    const a = setInterval(extras, 5000);
    const b = setInterval(() => { if (document.visibilityState === 'visible') rpc('demo_pulse', { p_token: sess.token }).catch(gone); }, 1000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [sess.token, onEnd]);

  const squads: any[] = (x?.bots || []).filter((b: any) => b.map === map);
  useEffect(() => { if (squads.length && !squads.some((b) => b.number === squad)) setSquad(squads[0].number); }, [squads.length, map]);
  // roles are handed out at take-off, so look the player up again when the map's phase changes
  const mapPhase = x?.maps?.find((m: any) => m.number === map)?.phase;
  const rolesKnown = !['lobby', 'boarding'].includes(mapPhase || 'lobby');
  useEffect(() => {
    if (squad == null) return;
    let stop = false;
    rpc<any>('demo_view', { p_token: sess.token, p_team: squad, p_role: role }).then((r) => { if (!stop) setPhone(r.token); }).catch((e) => toast(friendly(e), 'bad'));
    return () => { stop = true; };
  }, [squad, role, sess.token, rolesKnown]);

  async function endDemo() {
    if (!confirm('End this demo match and delete its dummy squads?')) return;
    try { await rpc('demo_end', { p_token: sess.token }); } catch { /* already gone */ }
    onEnd();
  }
  const cur = x?.maps?.find((m: any) => m.number === map);
  return (
    <div className="demo-room">
      <header className="demo-head">
        <h1>Demo match <span className="mono" style={{ color: 'var(--gold)' }}>{sess.code}</span></h1>
        <div className="row wrap" style={{ gap: 6 }}>
          {(x?.maps || []).map((m: any) => (
            <button key={m.id} className={`btn sm ${map === m.number ? 'primary' : 'ghost'}`} onClick={() => setMap(m.number)}>{m.name} · {m.phase}</button>
          ))}
        </div>
        <span className="sp" />
        <div className="demo-tabs">
          <button className={`btn sm ${pane === 'map' ? 'primary' : 'ghost'}`} onClick={() => setPane('map')}>Big screen</button>
          <button className={`btn sm ${pane === 'phone' ? 'primary' : 'ghost'}`} onClick={() => setPane('phone')}>Player phone</button>
        </div>
        <a className="btn sm" href={`/host#host=${sess.token}`} target="_blank" rel="noreferrer">Host console</a>
        <button className="btn sm danger" onClick={endDemo}>End demo</button>
      </header>
      <div className={`demo-body show-${pane}`}>
        <div className="demo-stage">
          {cur ? <iframe key={cur.spectator_token} src={`/screen/${cur.spectator_token}`} title={`Big screen, ${cur.name}`} allow="autoplay; fullscreen" />
            : <div className="screen-full"><div className="tagline">Setting up the match…</div></div>}
        </div>
        <aside className="demo-side">
          <div className="demo-pick">
            <label>Dummy squad
              <select className="input" value={squad ?? ''} onChange={(e) => setSquad(Number(e.target.value))}>
                {squads.map((b) => <option key={b.number} value={b.number}>Squad {b.number} · {b.name} · {b.points} pts{b.manual ? ' · you' : ''}</option>)}
              </select>
            </label>
            <label>Player
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLES[r].name}</option>)}
              </select>
            </label>
            <span className="muted wide" style={{ fontSize: 12 }}>
              This is the phone of that dummy player. On the Captain's phone, <b>Take control</b> lets you drive and answer yourself.
              {phone && <> <a href={`/play#demo=${phone}`} target="_blank" rel="noreferrer">Open in its own tab</a></>}
            </span>
          </div>
          <div className="demo-phone">
            {phone && <iframe key={phone} src={`/play#demo=${phone}`} title={`Phone of squad ${squad}, ${ROLES[role].name}`} allow="autoplay" />}
          </div>
        </aside>
      </div>
    </div>
  );
}
