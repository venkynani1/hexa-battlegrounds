// Check-in for both editions: Mavericks events ask employee ID + company e-mail + name, Segue (campus)
// events ask name + e-mail + college. Then create a squad, join one with a code, or let matchmaking find
// one. Rejoining with the same details restores the player on any device.
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { friendly, rpc, store } from '../lib/api';
import { unlockAudio, sfx } from '../lib/sound';
import { ONLINE } from '../lib/edition';

type Mode = 'queue' | 'create' | 'join' | 'rejoin';
const MODES: { id: Mode; icon: string; title: string; text: string }[] = [
  { id: 'queue', icon: '🎯', title: 'Find me a squad', text: 'Matchmaking puts you with other players. Squads of 4 (3 if needed).' },
  { id: 'create', icon: '➕', title: 'Create a squad', text: 'Get a 4-letter squad code and share it with up to 3 friends.' },
  { id: 'join', icon: '🔑', title: 'Join with a code', text: 'A friend already created a squad and gave you the code.' },
];

export default function OnlineJoin() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get('e') || store.get('hb_event') || '').toUpperCase());
  const [name, setName] = useState(store.get('hb_name') || '');
  const [emp, setEmp] = useState(store.get('hb_emp') || '');
  const [email, setEmail] = useState(store.get('hb_email') || '');
  const [college, setCollege] = useState(store.get('hb_college') || '');
  const [info, setInfo] = useState<{ name: string; segue: boolean; online: boolean } | null>(null);
  const [mode, setMode] = useState<Mode>(params.get('s') ? 'join' : 'queue');
  const [squad, setSquad] = useState((params.get('s') || '').toUpperCase());
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const existing = store.get('hb_token');

  useEffect(() => { if (params.get('s')) { setSquad(params.get('s')!.toUpperCase()); setMode('join'); } }, [params]);
  // which sign-in this event uses (Mavericks: employee ID; Segue: college)
  useEffect(() => {
    const c = code.trim();
    if (c.length < 3) { setInfo(null); return; }
    const t = setTimeout(() => { rpc<any>('online_event_info', { p_event_code: c }).then((r) => setInfo(r || null)).catch(() => setInfo({ name: '', segue: false, online: true })); }, 350);
    return () => clearTimeout(t);
  }, [code]);
  const segue = !!info?.segue;

  const empOk = /^\d{10}$/.test(emp);
  const emailOk = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim());
  const collegeOk = college.trim().length >= 2;
  const idOk = segue ? (mode === 'rejoin' || collegeOk) : empOk;
  const ready = !!code && !!info && idOk && emailOk && (mode === 'rejoin' || (!!name.trim() && consent)) && (mode !== 'join' || squad.length === 4);

  async function submit(e: FormEvent) {
    e.preventDefault();
    unlockAudio(); setErr(''); setBusy(true);
    try {
      const common = { p_event_code: code.trim(), p_email: email.trim(), p_name: name.trim(), p_mode: mode,
        p_code: mode === 'join' ? squad : null, p_consent: consent, p_existing_token: existing || null };
      const r = segue
        ? await rpc<any>('online_join_segue', { ...common, p_college: college.trim() })
        : await rpc<any>('online_join', { ...common, p_emp_id: emp });
      store.set('hb_token', r.token);
      store.set('hb_event', code.trim().toUpperCase());
      if (!segue) store.set('hb_emp', emp);
      if (segue && college.trim()) store.set('hb_college', college.trim());
      store.set('hb_email', email.trim().toLowerCase());
      if (name.trim()) store.set('hb_name', name.trim());
      sfx.success();
      nav('/play');
    } catch (ex) { setErr(friendly(ex)); sfx.fail(); } finally { setBusy(false); }
  }

  return (
    <div className="airport online-gate">
      <div className="airport-in">
        <header className="airport-top">
          <span className="ap-logo" aria-hidden>✈</span>
          <div><b>Hexaware Air · {ONLINE ? 'Online check-in' : 'Check-in'}</b><small>{info?.name || 'Operation Siruseri'} · {ONLINE ? 'play from your laptop on the Teams call' : 'play on your phone'}</small></div>
        </header>
        <form className="checkin" onSubmit={submit}>
          <div className="ci-title"><span>Web check-in</span><b>{mode === 'rejoin' ? 'Welcome back' : 'Who are you?'}</b></div>
          <div className="field">
            <label htmlFor="code">Event code</label>
            <input id="code" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={ONLINE ? 'Shown on the Teams call, e.g. HEXA26' : 'Shown on the screen, e.g. HEXA26'} autoCapitalize="characters" required />
            {code.trim().length >= 3 && !info && <small className="muted">Checking the event code…</small>}
          </div>
          {segue ? (
            <div className="field">
              <label htmlFor="email">E-mail</label>
              <input id="email" className={`input ${email && !emailOk ? 'bad' : ''}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@college.edu" required />
            </div>
          ) : (
          <div className="grid2 tight">
            <div className="field">
              <label htmlFor="emp">Employee ID (10 digits)</label>
              <input id="emp" className={`input mono ${emp && !empOk ? 'bad' : ''}`} value={emp} onChange={(e) => setEmp(e.target.value.replace(/\D/g, '').slice(0, 10))} inputMode="numeric" autoComplete="off" placeholder="0000000000" required />
            </div>
            <div className="field">
              <label htmlFor="email">Company e-mail{ONLINE ? ' (Teams)' : ''}</label>
              <input id="email" className={`input ${email && !emailOk ? 'bad' : ''}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@hexaware.com" required />
            </div>
          </div>
          )}
          {mode !== 'rejoin' && (
            <>
              <div className="field">
                <label htmlFor="name">Display name</label>
                <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Shown to everyone in the game" autoComplete="name" required />
              </div>
              {segue && (
                <div className="field">
                  <label htmlFor="college">College</label>
                  <input id="college" className={`input ${college && !collegeOk ? 'bad' : ''}`} value={college} onChange={(e) => setCollege(e.target.value)} maxLength={80} placeholder="Your college name" autoComplete="organization" required />
                </div>
              )}
              <div className="field">
                <span className="lbl" id="modelbl">Squad</span>
                <div className="mode-pick" role="radiogroup" aria-labelledby="modelbl">
                  {MODES.map((m) => (
                    <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => { setMode(m.id); sfx.tap(); }}>
                      <span aria-hidden>{m.icon}</span><b>{m.title}</b><small>{m.text}</small>
                    </button>
                  ))}
                </div>
              </div>
              {mode === 'join' && (
                <div className="field">
                  <label htmlFor="squad">Squad code</label>
                  <input id="squad" className="input mono pin-in" value={squad} onChange={(e) => setSquad(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))} placeholder="ABCD" autoCapitalize="characters" autoComplete="off" required />
                </div>
              )}
              <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{segue
                  ? 'I agree to take part. My name appears on the game screens; my name, e-mail and college go to the organiser for attendance, and my e-mail is shown only to my own squad.'
                  : `I agree to take part. My display name appears on the game screens; my employee ID and e-mail go to the organiser for attendance, and my e-mail is shown only to my own squad${ONLINE ? ' so we can start a Teams call' : ''}.`}</span></label>
            </>
          )}
          {err && <div className="chip bad" role="alert" style={{ whiteSpace: 'normal', padding: 10 }}>{err}</div>}
          <button className="btn primary big block" disabled={busy || !ready}>
            {busy ? 'Checking in…' : mode === 'rejoin' ? 'Rejoin my squad' : mode === 'create' ? 'Create my squad' : mode === 'join' ? 'Join the squad' : 'Find me a squad'}
          </button>
          <p className="muted center" style={{ fontSize: 13, margin: 0 }}>
            {mode === 'rejoin'
              ? <a href="#new" onClick={(e) => { e.preventDefault(); setMode('queue'); }}>First time? Check in here</a>
              : <>Already checked in on another device? <a href="#rejoin" onClick={(e) => { e.preventDefault(); setMode('rejoin'); }}>{segue ? 'Rejoin with your e-mail' : 'Rejoin with your ID'}</a></>}
          </p>
        </form>
      </div>
    </div>
  );
}
