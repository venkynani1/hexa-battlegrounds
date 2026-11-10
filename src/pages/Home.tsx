import { lazy, Suspense, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { configured } from '../lib/supabase';
import { store } from '../lib/api';
import { ROLE_ORDER, ROLES } from '../lib/game';
import { sfx, unlockAudio } from '../lib/sound';

const Stage = lazy(() => import('../three/LobbyStage'));

// Landing page as a game lobby: your buggy on the launch pad, squad slots on the left,
// the match card and the big start button bottom-right.
export default function Home() {
  const nav = useNavigate();
  const resume = !!store.get('hb_token');
  const [code, setCode] = useState(store.get('hb_event') || '');
  const webgl = typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl');

  function start() {
    unlockAudio(); sfx.tap();
    if (resume) nav('/play');
    else nav(code.trim() ? `/join?e=${encodeURIComponent(code.trim().toUpperCase())}` : '/join');
  }

  return (
    <div className="lobby">
      <div className="lobby-sky" aria-hidden />
      {webgl && <Suspense fallback={null}><Stage /></Suspense>}
      <div className="lobby-shade" aria-hidden />

      <header className="lobby-top">
        <div className="lobby-brand">
          <span className="lb1">Hexaware</span>
          <h1 className="lb2">Battlegrounds</h1>
          <span className="lb3">Operation Siruseri</span>
        </div>
        <nav className="lobby-links" aria-label="Organiser tools">
          <Link to="/demo" className="lobby-chip" onClick={() => unlockAudio()}>▶ Watch a demo match</Link>
          <Link to="/host" className="lobby-chip ghost">Host console</Link>
        </nav>
      </header>

      <aside className="lobby-squad" aria-label="The four roles in a squad">
        {ROLE_ORDER.map((r) => (
          <div key={r} className="lobby-slot" style={{ ['--c' as any]: ROLES[r].color }}>
            <span className="ls-ico" aria-hidden>{ROLES[r].icon}</span>
            <span className="ls-txt"><b>{ROLES[r].name}</b><small>{ROLES[r].blurb}</small></span>
          </div>
        ))}
      </aside>

      <p className="lobby-tag">Drop. Decode. Dominate.</p>

      <section className="lobby-go" aria-label="Start">
        {!configured && (
          <div className="lobby-warn">Server not set up yet. Add the Supabase integration in Vercel (Storage → Supabase), then redeploy.</div>
        )}
        <div className="lobby-mode">
          <div className="lm-head"><b>Squad battle royale</b><span>4 players a squad, 15 squads a map</span></div>
          {!resume && (
            <label className="lm-code">
              <span>Event code</span>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HEXA26" maxLength={12} autoCapitalize="characters" autoComplete="off"
                onKeyDown={(e) => { if (e.key === 'Enter') start(); }} />
            </label>
          )}
          {resume && <div className="lm-resume">You are already in a squad on this phone.</div>}
        </div>
        <button className="lobby-start" onClick={start}>
          <b>{resume ? 'Resume' : 'Start'}</b>
          <span>{resume ? 'Back to my squad' : 'Join my squad'}</span>
        </button>
        {resume && <Link to="/join" className="lobby-alt">Join a different squad</Link>}
      </section>
    </div>
  );
}
