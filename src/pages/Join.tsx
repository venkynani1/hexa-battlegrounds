// Check-in at Chennai International Airport: map number + squad PIN (no squad number to remember).
// After check-in the phone shows the boarding pass (Play → lobby).
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { friendly, rpc, store } from '../lib/api';
import { unlockAudio, sfx } from '../lib/sound';
import { useNow } from '../lib/time';

function Departures({ code }: { code: string }) {
  useNow(1000);
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'); const mm = String(t.getMinutes()).padStart(2, '0');
  const rows: [string, string, string, string][] = [
    [`HX 26${'1'}`, 'SIRUSERI · HEXAWARE', 'GATE 1', 'CHECK-IN'],
    [`HX 26${'2'}`, 'SIRUSERI · HEXAWARE', 'GATE 2', 'CHECK-IN'],
    [`HX 26${'3'}`, 'SIRUSERI · HEXAWARE', 'GATE 3', 'CHECK-IN'],
  ];
  return (
    <div className="fids" aria-label="Departures board">
      <div className="fids-head"><span>✈ DEPARTURES</span><span className="mono">{hh}:{mm}</span></div>
      {rows.map((r) => (
        <div key={r[0]} className="fids-row"><b className="mono">{r[0]}</b><span>{r[1]}</span><span className="mono">{r[2]}</span><em>{r[3]}</em></div>
      ))}
      {code && <div className="fids-foot">Event <b className="mono">{code}</b></div>}
    </div>
  );
}

export default function Join() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('e') || store.get('hb_event') || '');
  const [name, setName] = useState(store.get('hb_name') || '');
  const [map, setMap] = useState<number>(Number(params.get('m')) || 0);
  const [pin, setPin] = useState('');
  const [consent, setConsent] = useState(false);
  const [rules, setRules] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showCode, setShowCode] = useState(!params.get('e') && !params.get('c') && !store.get('hb_event'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const existing = store.get('hb_token');

  useEffect(() => { if (params.get('e')) setCode(params.get('e')!.toUpperCase()); }, [params]);
  // fixed squad card: the QR code carries the card set and squad number; the server says which event is on
  const card = /^([a-f0-9]{6,20})-(\d{1,3})$/i.exec(params.get('c') || '');
  const [cardNote, setCardNote] = useState('');
  useEffect(() => {
    if (!card) return;
    setMap(Math.ceil(Number(card[2]) / 15));
    rpc<any>('card_event', { p_set: card[1].toLowerCase() }).then((r) => {
      if (r?.code) { setCode(r.code); setCardNote(`Squad ${Number(card[2])} · ${r.name}`); }
      else { setCardNote('No event is open for this card yet. Ask the organiser, or type the event code.'); setShowCode(true); }
    }).catch(() => { setCardNote('Could not look up this card. Type the event code shown on the big screen.'); setShowCode(true); });
  }, [card?.[1], card?.[2]]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    unlockAudio();
    setErr('');
    setBusy(true);
    try {
      const r = await rpc('join_flight', {
        p_event_code: code.trim(), p_map: map, p_pin: pin.trim(), p_name: name.trim(),
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
    <div className="airport">
      <div className="airport-in">
        <header className="airport-top">
          <span className="ap-logo" aria-hidden>✈</span>
          <div><b>Chennai International Airport</b><small>MAA · Terminal 1 · Departures</small></div>
        </header>
        <Departures code={code} />
        <form className="checkin" onSubmit={submit}>
          <div className="ci-title"><span>Check-in counter</span><b>Hexaware Air · Operation Siruseri</b></div>
          {cardNote && <div className="chip" role="status" style={{ whiteSpace: 'normal', padding: 10 }}>🎫 {cardNote}</div>}
          <div className="field">
            <label htmlFor="name">Passenger name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="First name is enough" autoComplete="nickname" required />
          </div>
          <div className="field">
            <span className="lbl" id="maplbl">Map number</span>
            <div className="map-pick" role="radiogroup" aria-labelledby="maplbl">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={map === n} className={map === n ? 'on' : ''} onClick={() => { setMap(n); sfx.tap(); }}>
                  <b>{n}</b><small>Gate {n}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="pin">Squad PIN</label>
            <input id="pin" className="input mono pin-in" type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" placeholder="6 digits" required />
          </div>
          {showCode ? (
            <div className="field">
              <label htmlFor="code">Event code</label>
              <input id="code" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. HEXA26" autoCapitalize="characters" required />
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Event <b className="mono">{code}</b> · <a href="#code" onClick={(e) => { e.preventDefault(); setShowCode(true); }}>change</a></p>
          )}
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree to take part and for my display name to appear on the event screens. Nothing else about me is collected.</span></label>
          <label className="check"><input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} />
            <span>I have read the <a href="#rules" onClick={(e) => { e.preventDefault(); setShowRules((s) => !s); }}>game rules</a>.</span></label>
          {showRules && (
            <div className="clue" style={{ fontSize: 14 }}>
              {`• Squads of 4, one phone each. The game hands out the roles at take-off: Captain, Scout, Decoder, Intel Officer.
• The plane flies over Hexaware Siruseri: the captain picks a landing spot and your squad parachutes down.
• You land on foot: walk to the parking yard and collect the buggy with your squad number.
• Each teammate sees a different clue. Only the Captain types answers — talk to your squad.
• Rival squads in range can be shot: everyone in the squad can hold FIRE. Zero HP knocks you out into Recovery — never out of the game.
• Stay inside the safe zone: the gas wall closes in until only Training Room 14 remains.`}
            </div>
          )}
          {err && <div className="chip bad" role="alert" style={{ whiteSpace: 'normal', padding: 10 }}>{err}</div>}
          <button className="btn primary big block" disabled={busy || !consent || !rules || !map || pin.length < 4 || !name || !code}>
            {busy ? 'Checking in…' : 'Check in · get my boarding pass'}
          </button>
          <p className="muted center" style={{ fontSize: 13, margin: 0 }}>Map number and squad PIN are on your squad card. Never share the PIN with other squads.</p>
        </form>
      </div>
    </div>
  );
}
