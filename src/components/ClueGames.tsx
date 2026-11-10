// Mini-game clues from challenge pack 4: the bomb (Scout), the rooftop signal lamp (Scout) and
// the photo of a pattern lock (Intel). They only show information; the captain types the answer.
import { useEffect, useRef, useState } from 'react';
import { buzz, sfx } from '../lib/sound';

const WIRE: Record<string, string> = { red: '#e8283a', blue: '#2f7dff', yellow: '#ffd23d', white: '#f2f2f2', black: '#1a1a1a', green: '#2fbf5d' };

export function Bomb({ wires, serial, led }: { wires: string[]; serial: string; led: string }) {
  const [cut, setCut] = useState<number | null>(null);
  return (
    <div className="minigame bomb" aria-label={`Device with ${wires.length} wires`}>
      <svg viewBox="0 0 300 210" className="bomb-svg">
        <rect x="8" y="8" width="284" height="194" rx="14" fill="#3b3f46" stroke="#1d2026" strokeWidth="4" />
        <rect x="22" y="20" width="110" height="34" rx="6" fill="#0b0f0b" />
        <text x="77" y="44" textAnchor="middle" fill="#ff3b3b" fontFamily="monospace" fontSize="20" fontWeight="700">{serial}</text>
        <circle cx="262" cy="37" r="11" fill={led === 'red' ? '#ff3030' : led === 'blue' ? '#3a7bff' : '#2fe06a'}>
          <animate attributeName="opacity" values="1;0.35;1" dur="1s" repeatCount="indefinite" />
        </circle>
        <text x="236" y="42" textAnchor="end" fill="#c9ced6" fontSize="11">LED</text>
        <rect x="26" y="66" width="18" height="128" rx="4" fill="#9aa0a6" /><rect x="256" y="66" width="18" height="128" rx="4" fill="#9aa0a6" />
        {wires.map((w, i) => {
          const y = 76 + i * (112 / Math.max(1, wires.length - 1 || 1));
          const done = cut === i;
          return (
            <g key={i} onClick={() => { setCut(i); sfx.tap(); buzz(20); }} style={{ cursor: 'pointer' }}>
              <text x="14" y={y + 4} fill="#fff" fontSize="11" fontWeight="700">{i + 1}</text>
              {done
                ? <><path d={`M44 ${y} C 90 ${y - 18}, 120 ${y + 18}, 140 ${y}`} stroke={WIRE[w]} strokeWidth="7" fill="none" strokeLinecap="round" /><path d={`M160 ${y + 6} C 190 ${y - 14}, 220 ${y + 18}, 256 ${y}`} stroke={WIRE[w]} strokeWidth="7" fill="none" strokeLinecap="round" /></>
                : <path d={`M44 ${y} C 110 ${y - 22}, 190 ${y + 22}, 256 ${y}`} stroke={WIRE[w]} strokeWidth="7" fill="none" strokeLinecap="round" />}
              <path d={`M44 ${y} C 110 ${y - 22}, 190 ${y + 22}, 256 ${y}`} stroke="transparent" strokeWidth="18" fill="none" />
            </g>
          );
        })}
      </svg>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>Tapping a wire here is only practice — the captain types the wire number to really cut it.</p>
    </div>
  );
}

const LAMP: Record<string, string> = { red: '#ff3b3b', green: '#2fe06a', blue: '#3a7bff', yellow: '#ffd23d', purple: '#b36bff', white: '#ffffff' };

export function SignalLights({ seq, replays = 3 }: { seq: string[]; replays?: number }) {
  const [left, setLeft] = useState(replays);
  const [on, setOn] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  function play() {
    if (playing || left <= 0) return;
    setPlaying(true); setLeft((n) => n - 1);
    seq.forEach((c, i) => {
      timers.current.push(window.setTimeout(() => { setOn(c); sfx.tick(); buzz(15); }, 700 + i * 1100));
      timers.current.push(window.setTimeout(() => setOn(null), 700 + i * 1100 + 650));
    });
    timers.current.push(window.setTimeout(() => setPlaying(false), 900 + seq.length * 1100));
  }
  return (
    <div className="minigame signal">
      <div className="lamp" style={{ background: on ? LAMP[on] : '#20242c', boxShadow: on ? `0 0 46px 14px ${LAMP[on]}` : 'none' }} aria-live="polite" aria-label={on ? `${on} flash` : 'Lamp dark'} />
      <div className="row between" style={{ marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 13 }}>{seq.length} flashes · {left} replay{left === 1 ? '' : 's'} left</span>
        <button className="btn sm primary" disabled={playing || left <= 0} onClick={play}>{playing ? 'Watching…' : left === replays ? '▶ Play' : '↻ Replay'}</button>
      </div>
    </div>
  );
}

export function PatternLock({ path }: { path: number[] }) {
  const xy = (i: number) => [50 + (i % 3) * 100, 50 + Math.floor(i / 3) * 100];
  return (
    <div className="minigame pattern">
      <svg viewBox="0 0 300 300" className="pattern-svg" aria-label="Photo of a swipe pattern">
        <rect width="300" height="300" rx="22" fill="#121722" />
        <polyline points={path.map((i) => xy(i).join(',')).join(' ')} fill="none" stroke="#2ee6ff" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
        {Array.from({ length: 9 }, (_, i) => { const [x, y] = xy(i); return <circle key={i} cx={x} cy={y} r={path.includes(i) ? 16 : 11} fill={i === path[0] ? '#2fe06a' : path.includes(i) ? '#2ee6ff' : '#4a5160'} />; })}
        {path.slice(1).map((i, k) => { const [x, y] = xy(i); return <text key={k} x={x + 18} y={y - 14} fill="#fff" fontSize="14" fontWeight="700">{k + 2}</text>; })}
        <text x={xy(path[0])[0] + 18} y={xy(path[0])[1] - 14} fill="#2fe06a" fontSize="14" fontWeight="700">1</text>
      </svg>
    </div>
  );
}
