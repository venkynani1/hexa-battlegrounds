// Bus lobby and shuttle journey. Everything that moves is derived from server timestamps
// (shuttle_departed_at / shuttle_arrive_at), so every phone and the projector show the same
// moment, a refresh resumes at the right point, and no device can arrive "early".
import { useMemo } from 'react';
import { progress, secondsLeft, serverTime, useNow } from '../lib/time';
import { ROLES, ROLE_ORDER, Role } from '../lib/game';

const pad2 = (n: number | null | undefined) => String(n ?? 0).padStart(2, '0');
export const busCode = (bus?: number | null) => `HBX-${pad2(bus || 1)}`;

const reduced = () => typeof document !== 'undefined' && document.documentElement.classList.contains('reduced-motion');

// ── Phone: inside the bus while waiting ──────────────────────────────────
export function BusInterior({ s }: { s: any }) {
  useNow(1000);
  const seats = [0, 1, 2, 3].map((i) => s.roster[i] || null);
  const n = s.roster.length;
  const boarding = s.arena.phase === 'boarding';
  const status = n < 4 ? `BOARDING · ${n}/4 ABOARD` : boarding ? 'DOORS OPEN · AWAITING DRIVER' : 'WAITING FOR DEPARTURE';
  const announce = s.arena.overlay?.broadcast?.text;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="depart-board" role="status" aria-live="polite">
        <div className="db-row"><span>BUS NO</span><b>{busCode(s.team.bus)}</b></div>
        <div className="db-row"><span>DESTINATION</span><b>OPERATION SIRUSERI</b></div>
        <div className="db-row"><span>SQUAD</span><b>{String(s.team.name).toUpperCase()}</b></div>
        <div className="db-row"><span>MAP</span><b>{s.arena.name.toUpperCase()}</b></div>
        <div className="db-row"><span>STATUS</span><b className={n === 4 ? 'ok' : 'blink'}>{status}</b></div>
        {announce && <div className="db-ticker"><span>📣 {announce}</span></div>}
      </div>

      <div className="bus-shell" aria-label={`Bus ${busCode(s.team.bus)} interior, ${n} of 4 seats taken`}>
        <div className="bus-windows" aria-hidden>
          <div className={`bus-scenery ${boarding ? 'idle' : ''}`} />
          {[0, 1, 2, 3].map((i) => <i key={i} className="bus-pane" />)}
        </div>
        <div className="bus-cabin">
          <div className="bus-front" aria-hidden><span className="bus-driver">⎈</span><span className="muted">DRIVER</span></div>
          <div className="seat-rows">
            {[0, 2].map((row) => (
              <div key={row} className="seat-row">
                {[row, row + 1].map((i, col) => {
                  const p = seats[i];
                  const r = p?.role as Role | null;
                  return (
                    <div key={i} className={`seat ${p ? 'taken' : ''} ${p?.me ? 'me' : ''}`} style={r ? { borderColor: ROLES[r].color } : undefined}>
                      <span className="seat-no">SEAT {pad2(i + 1)}</span>
                      <span className="seat-name">{p ? p.name : 'EMPTY'}</span>
                      <span className="seat-role" style={r ? { color: ROLES[r].color } : undefined}>
                        {r ? `${ROLES[r].icon} ${ROLES[r].name}` : p ? 'Role at Gate 1' : 'Waiting…'}
                      </span>
                      {p && <span className={`dot ${p.online ? 'on' : 'off'}`} style={{ position: 'absolute', top: 8, right: 8 }} />}
                      {col === 0 && <span className="aisle" aria-hidden />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="row between"><span className="panel-title" style={{ margin: 0 }}>Readiness</span><span className={`chip ${n === 4 ? 'good' : 'warn'}`}>{n}/4</span></div>
        <div className="bar" style={{ marginTop: 8 }}><i style={{ width: `${(n / 4) * 100}%` }} /></div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          {n < 4 ? 'Your squad needs exactly 4 players. Teammates join with the same squad number and PIN.'
            : boarding ? 'All aboard. The host will start the engine any moment.' : 'Squad ready. Waiting for the host to open the doors.'}
        </p>
      </div>
    </div>
  );
}

// ── Road scene used by phones and the projector ──────────────────────────
const TRACK = 5200;
const SIGNS = [
  { at: 0.12, text: 'SIPCOT IT PARK', sub: 'GATE 1' },
  { at: 0.32, text: 'IT CORRIDOR', sub: 'SIRUSERI →' },
  { at: 0.55, text: 'HEXAWARE CAMPUS', sub: '1 KM' },
  { at: 0.8, text: 'DEPLOYMENT POINT', sub: 'GATE 1 →' },
];
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function shuttleStage(start?: string | null, end?: string | null) {
  const total = start && end ? (new Date(end).getTime() - new Date(start).getTime()) / 1000 : 10;
  const doorFrac = Math.min(0.3, 3 / Math.max(1, total)); // ~3 s of doors closing
  const p = progress(start, end);
  const drive = p <= doorFrac ? 0 : (p - doorFrac) / (1 - doorFrac);
  return { p, doorFrac, drive, doors: p < doorFrac, arriving: drive > 0.88, total };
}

export function RoadScene({ start, end, buses = [{ bus: 1, label: '' }], big = false }: {
  start?: string | null; end?: string | null; buses?: { bus: number; label: string }[]; big?: boolean;
}) {
  useNow(reduced() ? 500 : 50);
  const st = shuttleStage(start, end);
  const off = reduced() ? 0 : easeInOut(st.drive) * TRACK;
  const W = 800; const H = big ? 330 : 300;
  const far = -((off * 0.12) % 400);
  const mid = -((off * 0.45) % 300);
  const lane = -(off % 80);
  const wheel = (off * 2.2) % 360;
  const doorsLeft = st.doors ? Math.max(0, Math.ceil((st.doorFrac - st.p) * st.total)) : 0;
  const skyline = useMemo(() => Array.from({ length: 14 }, (_, i) => ({ x: i * 60, h: 40 + ((i * 37) % 70), w: 44 + ((i * 13) % 20) })), []);
  return (
    <div className={`road-wrap ${big ? 'big' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" role="img"
        aria-label={st.doors ? 'Bus doors closing' : st.arriving ? 'Bus arriving at Gate 1' : `Shuttle en route, ${Math.round(st.drive * 100)} percent`}>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a1630" /><stop offset="0.7" stopColor="#1b2b52" /><stop offset="1" stopColor="#3b2a3e" /></linearGradient>
          <linearGradient id="busBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd25e" /><stop offset="1" stopColor="#e09a12" /></linearGradient>
        </defs>
        <rect width={W} height={H} fill="url(#sky)" />
        {/* far skyline */}
        <g transform={`translate(${far} 0)`} opacity={0.5}>
          {[0, 840].map((dx) => skyline.map((b, i) => (
            <g key={`${dx}-${i}`}>
              <rect x={b.x + dx} y={H * 0.62 - b.h} width={b.w} height={b.h} fill="#13224a" />
              {Array.from({ length: Math.floor(b.h / 14) }, (_, j) => (
                <rect key={j} x={b.x + dx + 8} y={H * 0.62 - b.h + 8 + j * 14} width={b.w - 16} height={3} fill={(i + j) % 3 ? '#1f3a73' : '#ffd25e'} opacity={0.6} />
              ))}
            </g>
          )))}
        </g>
        {/* mid layer: trees and campus walls */}
        <g transform={`translate(${mid} 0)`}>
          {Array.from({ length: 6 }, (_, i) => (
            <g key={i} transform={`translate(${i * 300 - 100} ${H * 0.66})`}>
              <rect x={0} y={-6} width={180} height={10} rx={3} fill="#1c2f55" />
              <circle cx={220} cy={-26} r={22} fill="#123a33" /><rect x={217} y={-8} width={6} height={14} fill="#2a1c12" />
            </g>
          ))}
        </g>
        {/* streetlights */}
        {Array.from({ length: 6 }, (_, i) => {
          const x = i * 200 - (off % 200);
          return (
            <g key={`sl${i}`} transform={`translate(${x} 0)`}>
              <rect x={0} y={H * 0.36} width={4} height={H * 0.36} fill="#3a4a6a" />
              <rect x={-14} y={H * 0.36} width={20} height={4} fill="#3a4a6a" />
              <circle cx={-12} cy={H * 0.37 + 4} r={5} fill="#ffe8a6" />
              <path d={`M -22 ${H * 0.38} L -2 ${H * 0.38} L 14 ${H * 0.72} L -38 ${H * 0.72} Z`} fill="#ffe8a6" opacity={0.05} />
            </g>
          );
        })}
        {/* signs */}
        {SIGNS.map((sg) => {
          const x = sg.at * TRACK - off + 820;
          if (x < -260 || x > W + 40) return null;
          return (
            <g key={sg.text} transform={`translate(${x} ${H * 0.2})`}>
              <rect x={60} y={42} width={6} height={H * 0.5} fill="#5d6b85" />
              <rect x={0} y={0} width={210} height={48} rx={4} fill="#0f6b3a" stroke="#e6f0ff" strokeWidth={2} />
              <text x={105} y={21} textAnchor="middle" fontSize={14} fontWeight={700} fill="#fff" fontFamily="Rajdhani, sans-serif">{sg.text}</text>
              <text x={105} y={39} textAnchor="middle" fontSize={12} fill="#cfe2ff" fontFamily="Rajdhani, sans-serif">{sg.sub}</text>
            </g>
          );
        })}
        {/* road */}
        <rect x={0} y={H * 0.72} width={W} height={H * 0.28} fill="#11151f" />
        <rect x={0} y={H * 0.72} width={W} height={3} fill="#ffc23d" opacity={0.6} />
        <g transform={`translate(${lane} 0)`}>
          {Array.from({ length: 12 }, (_, i) => <rect key={i} x={i * 80} y={H * 0.86} width={44} height={5} rx={2} fill="#e6f0ff" opacity={0.7} />)}
        </g>
        {/* gate arch arriving */}
        {st.drive > 0.7 && (
          <g transform={`translate(${W - (st.drive - 0.7) / 0.3 * 230} ${H * 0.28})`}>
            <rect x={0} y={0} width={12} height={H * 0.46} fill="#3ea5ff" />
            <rect x={170} y={0} width={12} height={H * 0.46} fill="#3ea5ff" />
            <rect x={0} y={0} width={182} height={30} rx={4} fill="#0b1220" stroke="#3ef0ff" strokeWidth={2} />
            <text x={91} y={21} textAnchor="middle" fontSize={16} fontWeight={700} fill="#3ef0ff" fontFamily="Rajdhani, sans-serif">GATE 1</text>
          </g>
        )}
        {/* convoy */}
        {buses.slice(0, big ? 4 : 1).map((b, i) => {
          const bx = (big ? 90 : 230) + i * (big ? 185 : 0) - (big ? 0 : 0);
          const by = H * 0.72 - 74 + (reduced() ? 0 : Math.sin((off + i * 40) / 40) * 1.2);
          return (
            <g key={b.bus} transform={`translate(${bx} ${by})`}>
              <rect x={0} y={0} width={170} height={66} rx={12} fill="url(#busBody)" stroke="#2b1a00" strokeWidth={2} />
              <rect x={150} y={8} width={18} height={30} rx={4} fill="#9fd3ff" />
              {Array.from({ length: 5 }, (_, w) => <rect key={w} x={10 + w * 27} y={8} width={22} height={22} rx={3} fill="#9fd3ff" opacity={0.85} />)}
              {/* door */}
              <rect x={122} y={8} width={st.doors ? 10 + (1 - (st.doorFrac - st.p) / st.doorFrac) * 12 : 22} height={50} rx={2} fill="#7a5200" />
              <rect x={0} y={40} width={170} height={6} fill="#2b1a00" opacity={0.4} />
              <text x={62} y={58} textAnchor="middle" fontSize={11} fontWeight={800} fill="#2b1a00" fontFamily="Rajdhani, sans-serif">{busCode(b.bus)}</text>
              {[34, 132].map((wx) => (
                <g key={wx} transform={`translate(${wx} 66) rotate(${wheel})`}>
                  <circle r={13} fill="#151515" /><circle r={5} fill="#888" /><rect x={-1.5} y={-11} width={3} height={8} fill="#666" />
                </g>
              ))}
              {big && b.label && <text x={85} y={-10} textAnchor="middle" fontSize={13} fontWeight={700} fill="#e6f0ff" fontFamily="Rajdhani, sans-serif">{b.label}</text>}
            </g>
          );
        })}
        {st.doors && (
          <g>
            <rect x={0} y={0} width={W} height={H} fill="#000" opacity={0.35} />
            <text x={W / 2} y={H * 0.36} textAnchor="middle" fontSize={22} fontWeight={700} fill="#ffc23d" fontFamily="Rajdhani, sans-serif" letterSpacing={4}>DOORS CLOSING</text>
            <text x={W / 2} y={H * 0.58} textAnchor="middle" fontSize={64} fontWeight={700} fill="#fff" fontFamily="Rajdhani, sans-serif">{doorsLeft}</text>
          </g>
        )}
      </svg>
      <div className="road-hud">
        <span className="up">SIPCOT</span>
        <div className="bar timer grow"><i style={{ width: `${st.drive * 100}%` }} /></div>
        <span className="up" style={{ color: 'var(--gold)' }}>GATE 1</span>
        <b className="mono">{secondsLeft(end)}s</b>
      </div>
    </div>
  );
}

// ── Phone: full shuttle phase screen ─────────────────────────────────────
export function ShuttleJourney({ s }: { s: any }) {
  useNow(500);
  const st = shuttleStage(s.arena.shuttle_departed_at, s.arena.shuttle_arrive_at);
  // rotate through the four role briefings during the ride (same order on every phone)
  const idx = Math.floor((serverTime() / 4000) % 4);
  const r = ROLE_ORDER[idx];
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="depart-board compact">
        <div className="db-row"><span>{busCode(s.team.bus)}</span><b className={st.doors ? 'blink' : 'ok'}>{st.doors ? 'DOORS CLOSING' : st.arriving ? 'ARRIVING · GATE 1' : 'EN ROUTE'}</b></div>
      </div>
      <RoadScene start={s.arena.shuttle_departed_at} end={s.arena.shuttle_arrive_at} buses={[{ bus: s.team.bus || 1, label: '' }]} />
      <div className="panel" style={{ borderColor: ROLES[r].color }}>
        <div className="kind-tag">Arrival briefing · {idx + 1}/4</div>
        <div className="row" style={{ marginTop: 6, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 30, color: ROLES[r].color, lineHeight: 1 }} aria-hidden>{ROLES[r].icon}</span>
          <div><b style={{ color: ROLES[r].color }}>{ROLES[r].name}.</b> <span className="muted">{ROLES[r].blurb}</span></div>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 14 }}>At Gate 1 you get a few seconds to claim a role — the first tap wins. Agree in your squad now who takes which seat.</p>
      </div>
    </div>
  );
}
