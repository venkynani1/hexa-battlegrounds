import { Link } from 'react-router-dom';
import { configured } from '../lib/supabase';
import { ROLE_ORDER, ROLES } from '../lib/game';
import { unlockAudio } from '../lib/sound';

export default function Home() {
  return (
    <div className="app">
      <div className="content" style={{ paddingBottom: 40, justifyContent: 'center' }}>
        <div className="center" style={{ padding: '24px 0 8px' }}>
          <div className="brand"><span className="l1">Hexaware</span><span className="l2" style={{ fontSize: 52 }}>Battlegrounds</span><span className="l3">× Operation Siruseri</span></div>
          <div className="tagline" style={{ marginTop: 14 }}>Drop. Decode. Dominate.</div>
        </div>
        {!configured && (
          <div className="panel danger">
            <div className="panel-title">Server not configured</div>
            <p style={{ margin: 0 }}>Add the Supabase integration in Vercel (Storage → Supabase) or set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then redeploy. See README.</p>
          </div>
        )}
        <Link to="/join" className="btn primary big block" onClick={() => unlockAudio()}>Join my squad</Link>
        <div className="panel">
          <div className="panel-title">Four roles. One squad.</div>
          <div className="role-grid">
            {ROLE_ORDER.map((r) => (
              <div key={r} className="role-tile" style={{ color: ROLES[r].color, cursor: 'default', minHeight: 110 }}>
                <span className="ico" aria-hidden>{ROLES[r].icon}</span><span className="nm" style={{ fontSize: 16 }}>{ROLES[r].name}</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: 14 }}>Every major mission splits the clues across Scout, Decoder and Intel Officer. Only the Captain can submit. Talk to your squad.</p>
        </div>
        <Link to="/host" className="btn ghost block">Host console</Link>
      </div>
    </div>
  );
}
