import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { friendly, rpc, store } from '../lib/api';
import { unlockAudio, sfx } from '../lib/sound';

export default function Join() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('e') || store.get('hb_event') || '');
  const [name, setName] = useState(store.get('hb_name') || '');
  const [team, setTeam] = useState(params.get('s')?.replace(/\D/g, '') || '');
  const [pin, setPin] = useState('');
  const [consent, setConsent] = useState(false);
  const [rules, setRules] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const existing = store.get('hb_token');

  useEffect(() => { if (params.get('e')) setCode(params.get('e')!.toUpperCase()); }, [params]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    unlockAudio();
    setErr('');
    setBusy(true);
    try {
      const r = await rpc('join_team', {
        p_event_code: code.trim(), p_team_number: Number(team), p_pin: pin.trim(), p_name: name.trim(),
        p_consent: consent, p_rules: rules, p_existing_token: existing || null,
      });
      store.set('hb_token', r.token);
      store.set('hb_event', code.trim().toUpperCase());
      store.set('hb_name', name.trim());
      sfx.success();
      nav('/play');
    } catch (ex) {
      setErr(friendly(ex));
      sfx.fail();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="content" style={{ paddingBottom: 40 }}>
        <div className="center" style={{ padding: '18px 0 6px' }}>
          <div className="brand"><span className="l1">Hexaware</span><span className="l2">Battlegrounds</span><span className="l3">Operation Siruseri</span></div>
          <div className="tagline" style={{ marginTop: 10 }}>Drop. Decode. Dominate.</div>
        </div>

        {existing && (
          <div className="panel good">
            <div className="panel-title">You are already registered on this phone</div>
            <button className="btn primary block" onClick={() => { unlockAudio(); nav('/play'); }}>Continue to my squad</button>
          </div>
        )}

        <form className="panel col" onSubmit={submit} style={{ gap: 14 }}>
          <div className="panel-title">Squad registration</div>
          <div className="field">
            <label htmlFor="code">Event code</label>
            <input id="code" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. HEXA26" autoCapitalize="characters" required />
          </div>
          <div className="field">
            <label htmlFor="name">Your display name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="First name is enough" autoComplete="nickname" required />
          </div>
          <div className="row">
            <div className="field grow">
              <label htmlFor="team">Squad number</label>
              <input id="team" className="input mono" value={team} onChange={(e) => setTeam(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="7" required />
            </div>
            <div className="field grow">
              <label htmlFor="pin">Squad PIN</label>
              <input id="pin" className="input mono" type="password" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="••••" required />
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree to take part and for my display name to appear on the event screens. Nothing else about me is collected.</span></label>
          <label className="check"><input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} />
            <span>I have read the <a href="#rules" onClick={(e) => { e.preventDefault(); setShowRules((s) => !s); }}>game rules</a>.</span></label>
          {showRules && (
            <div className="clue" style={{ fontSize: 14 }}>
              {`• Squads of exactly 4, one phone each. Stay seated — everything happens on screen.
• Roles: Captain, Scout, Decoder, Intel Officer. Only the Captain submits answers and makes decisions.
• Each teammate sees a different clue. Talk to your squad — you need all three clues.
• Zero HP never eliminates you: you go into Recovery and come back.
• The safe zone shrinks until only Training Room 14 remains. Everyone plays the finale together.
• Be kind in captain chat. No real employee data, no spoilers shouted across the room.`}
            </div>
          )}
          {err && <div className="chip bad" role="alert" style={{ whiteSpace: 'normal', padding: 10 }}>{err}</div>}
          <button className="btn primary big block" disabled={busy || !consent || !rules || !team || !pin || !name || !code}>
            {busy ? 'Verifying…' : 'Join my squad'}
          </button>
        </form>
        <p className="muted center" style={{ fontSize: 13 }}>Your squad number and PIN come from the organiser. Never share your PIN with other squads.</p>
      </div>
    </div>
  );
}
