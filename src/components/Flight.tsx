// The start of the match: boarding pass at the gate, the flight from Chennai airport to Hexaware
// Siruseri (3D), and the approach where the game hands out roles. Phones and the big screen.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ROLES, Role } from '../lib/game';
import { serverTime, useNow } from '../lib/time';

/** Boarding group label for a squad's bus/group number (host roster). */
export const busCode = (n?: number | null) => (n ? `Group ${String.fromCharCode(64 + Math.min(26, n))}` : '—');

export function flightTimes(s: any) {
  const f = s.arena.overlay?.flight;
  const t1 = f?.t1 ? new Date(f.t1).getTime() : s.arena.shuttle_arrive_at ? new Date(s.arena.shuttle_arrive_at).getTime() : 0;
  const t0 = f?.t0 ? new Date(f.t0).getTime() : t1 - 40000;
  return { t0, t1 };
}

function FlightCanvas({ progress }: { progress: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stage: any = null; let raf = 0; let alive = true;
    import('../three/flight').then(({ FlightStage }) => {
      if (!alive || !ref.current) return;
      try { stage = new FlightStage(ref.current); } catch { setFailed(true); return; }
      const f = () => { raf = requestAnimationFrame(f); stage.progress = progress(); };
      f();
    });
    return () => { alive = false; cancelAnimationFrame(raf); stage?.dispose(); };
  }, []);
  return failed ? <div className="flight-fallback" aria-hidden>✈</div> : <canvas ref={ref} className="flight-canvas" aria-label="The plane taking off from Chennai and flying to Hexaware Siruseri" />;
}

/** A small route map: MAA → OMR → Siruseri, with the plane on it. */
function Route({ p }: { p: number }) {
  const pts = [[30, 40], [120, 70], [210, 120], [262, 176]];
  const seg = (k: number) => {
    const n = pts.length - 1; const t = Math.max(0, Math.min(1, k)) * n; const i = Math.min(n - 1, Math.floor(t)); const f = t - i;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };
  const [x, y] = seg(p);
  return (
    <svg className="route" viewBox="0 0 300 200" aria-hidden>
      <path d="M0 0 H300 V200 H0Z" fill="#14324a" />
      <path d="M190 0 C 230 60, 250 120, 300 160 V0Z" fill="#1d5f8c" opacity="0.8" />
      <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none" stroke="#8fb3d1" strokeWidth="2" strokeDasharray="5 5" />
      <circle cx="30" cy="40" r="6" fill="#ffc23d" /><text x="40" y="34" fill="#fff" fontSize="12" fontWeight="700">MAA Chennai</text>
      <circle cx="262" cy="176" r="7" fill="#2ee6ff" /><text x="178" y="194" fill="#fff" fontSize="12" fontWeight="700">Hexaware Siruseri</text>
      <text x="128" y="100" fill="#8fb3d1" fontSize="10">OMR · IT corridor</text>
      <text x={x} y={y + 5} fontSize="16" textAnchor="middle" transform={`rotate(35 ${x} ${y})`}>✈</text>
    </svg>
  );
}

function Barcode({ seed }: { seed: string }) {
  const bars = useMemo(() => {
    let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return Array.from({ length: 46 }, (_, i) => { h = (h * 1103515245 + 12345) >>> 0; return { x: i * 4.2, w: 1 + (h % 3) }; });
  }, [seed]);
  return <svg className="bp-bar" viewBox="0 0 196 40" aria-hidden>{bars.map((b, i) => <rect key={i} x={b.x} y="0" width={b.w} height="40" fill="#111" />)}</svg>;
}

export function BoardingPass({ s }: { s: any }) {
  const map = s.arena.number || 1;
  const role = s.me.role as Role | null;
  const boarding = s.arena.phase === 'boarding';
  return (
    <div className="bpass" aria-label="Boarding pass">
      <div className="bp-head">
        <span className="bp-air">✈ Hexaware Air</span>
        <span className="bp-class">BOARDING PASS</span>
      </div>
      <div className="bp-route">
        <div><b>MAA</b><small>Chennai</small></div>
        <span className="bp-plane" aria-hidden>✈</span>
        <div><b>HEX</b><small>Siruseri</small></div>
      </div>
      <div className="bp-grid">
        <div><small>Passenger</small><b>{s.me.name}</b></div>
        <div><small>Flight</small><b className="mono">HX 26{map}</b></div>
        <div><small>Squad</small><b>{s.team.number}</b></div>
        <div><small>Seat</small><b className="mono">{s.me.seat || `${String(s.team.number).padStart(2, '0')}A`}</b></div>
        <div><small>Gate</small><b>{map}</b></div>
        <div><small>Boarding</small><b className={boarding ? 'now' : ''}>{boarding ? 'NOW' : 'Soon'}</b></div>
      </div>
      <div className="bp-role">
        <small>Role</small>
        {role ? <b style={{ color: ROLES[role].color }}>{ROLES[role].icon} {ROLES[role].name}</b> : <b className="muted">Assigned by the crew at take-off</b>}
      </div>
      <div className="bp-tear" aria-hidden />
      <div className="bp-foot"><Barcode seed={`${s.team.id}${s.me.name}`} /><span className="mono">{String(s.team.number).padStart(2, '0')}·{(s.me.seat || 'A').slice(-1)}·HX26{map}</span></div>
    </div>
  );
}

export function Lounge({ s }: { s: any }) {
  const boarding = s.arena.phase === 'boarding';
  return (
    <div className="lounge">
      <div className={`gate-sign ${boarding ? 'go' : ''}`}>
        <span>Gate {s.arena.number || 1}</span>
        <b>{boarding ? 'Now boarding — take your seat' : 'Waiting for boarding'}</b>
      </div>
      <BoardingPass s={s} />
      <div className="panel">
        <div className="panel-title">Your squad on this flight</div>
        <div className="col" style={{ gap: 6 }}>
          {(s.roster || []).map((p: any, i: number) => (
            <div key={i} className="row between" style={{ fontSize: 15 }}>
              <span>{p.me ? <b>{p.name} (you)</b> : p.name}</span>
              <span className={`chip ${p.online ? 'good' : ''}`}>{p.online ? 'checked in' : 'away'}</span>
            </div>
          ))}
          {(s.roster || []).length < 4 && <span className="muted" style={{ fontSize: 13 }}>{4 - (s.roster || []).length} seat{4 - (s.roster || []).length > 1 ? 's' : ''} still empty — teammates check in with the same map number and PIN.</span>}
        </div>
      </div>
    </div>
  );
}

export function Cabin({ s }: { s: any }) {
  useNow(500);
  const { t0, t1 } = flightTimes(s);
  const prog = () => Math.max(0, Math.min(1, (serverTime() - t0) / Math.max(1, t1 - t0)));
  const p = prog();
  const left = Math.max(0, Math.ceil((t1 - serverTime()) / 1000));
  const phase = p < 0.13 ? 'Take-off roll' : p < 0.32 ? 'Climbing out of Chennai' : p < 0.8 ? 'Cruising along OMR' : 'Approaching Hexaware Siruseri';
  const role = s.me.role as Role | null;
  return (
    <div className="cabin">
      <FlightCanvas progress={prog} />
      <div className="cabin-hud">
        <div className="ch-top"><span className="mono">HX 26{s.arena.number || 1}</span><b>{phase}</b><span className="mono">ETA {left}s</span></div>
        <Route p={p} />
        {role ? (
          <div className="role-card" style={{ borderColor: ROLES[role].color }}>
            <small>The crew has assigned your role</small>
            <b style={{ color: ROLES[role].color }}>{ROLES[role].icon} {ROLES[role].name}</b>
            <p>{ROLES[role].blurb}</p>
            <span className="muted">Captain: <b>{s.roles?.captain || '—'}</b></span>
          </div>
        ) : <div className="role-card"><small>Roles are being assigned…</small></div>}
      </div>
    </div>
  );
}

export function Approach({ s }: { s: any }) {
  useNow(250);
  const left = Math.max(0, Math.ceil((new Date(s.arena.roles_deadline).getTime() - serverTime()) / 1000));
  const role = s.me.role as Role | null;
  return (
    <div className="cabin approach">
      <FlightCanvas progress={() => 0.96} />
      <div className="cabin-hud">
        <div className="ch-top"><span className="mono">HX 26{s.arena.number || 1}</span><b>Over Hexaware · rear door opening</b><span className="mono">{left}s</span></div>
        {role && (
          <div className="role-card" style={{ borderColor: ROLES[role].color }}>
            <small>You are the</small>
            <b style={{ color: ROLES[role].color }}>{ROLES[role].icon} {ROLES[role].name}</b>
            <p>{role === 'captain' ? 'Open the map, pick a landing spot inside the dashed circle and press JUMP. Your squad lands with you.' : 'Your captain picks where the squad lands. Watch the map and talk it through.'}</p>
          </div>
        )}
        <div className="jump-light" aria-hidden><i /><span>Get ready to jump</span></div>
      </div>
    </div>
  );
}

/** Projector: the whole map's flight */
export function FlightScreen({ s }: { s: any }) {
  useNow(500);
  const { t0, t1 } = flightTimes(s);
  const prog = () => Math.max(0, Math.min(1, (serverTime() - t0) / Math.max(1, t1 - t0)));
  const p = prog();
  const phase = s.arena.phase === 'roles' ? 'Over Hexaware — doors opening' : p < 0.13 ? 'Take-off' : p < 0.32 ? 'Climbing out of Chennai' : p < 0.8 ? 'Cruising along OMR' : 'Approaching Hexaware Siruseri';
  const seated = (s.squads || []).filter((q: any) => q.ready);
  return (
    <div className="flight-screen">
      <FlightCanvas progress={s.arena.phase === 'roles' ? () => 0.96 : prog} />
      <div className="fs-hud">
        <div className="fs-title"><span className="mono">HX 26{s.arena.number || 1} · MAA → HEX</span><b>{phase}</b></div>
        <div className="fs-squads">{seated.map((q: any) => <span key={q.number}>#{q.number} {q.name}</span>)}</div>
      </div>
    </div>
  );
}

/** Projector: the gate before take-off */
export function GateScreen({ s }: { s: any }) {
  const ready = (s.squads || []).filter((q: any) => q.ready).length;
  const boarding = s.arena.phase === 'boarding';
  return (
    <div className="screen-full gate-screen">
      <div className="up muted" style={{ fontSize: 24 }}>Chennai International Airport · Gate {s.arena.number || 1} · {s.arena.name}</div>
      <div className="mega">{boarding ? 'Now boarding' : 'Check-in open'}</div>
      <div className="up" style={{ fontSize: 22, color: 'var(--green)' }}>Flight HX 26{s.arena.number || 1} to Hexaware Siruseri · {ready} / {(s.squads || []).length} squads on board</div>
      <div className="squad-grid" style={{ width: '92vw', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', marginTop: 12 }}>
        {(s.squads || []).map((q: any) => (
          <div key={q.number} className="bus-card">
            <div className="row between"><span style={{ fontSize: 18 }}><b>#{q.number}</b> {q.name}</span><span className={`chip ${q.ready ? 'good' : ''}`}>{q.players}/4</span></div>
            <div className="seats">{[0, 1, 2, 3].map((i) => <i key={i} className={i < q.players ? 'on' : ''} />)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
