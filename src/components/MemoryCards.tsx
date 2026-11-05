// Memory Cards mini-game (Scout's clue): flip two cards at a time; a matching pair stays face up
// and shows the letter printed on it. Letters only appear on matched pairs.
import { useEffect, useState } from 'react';
import { buzz, sfx } from '../lib/sound';

type Card = { s: string; l: string };
const RED = new Set(['♥', '♦']);

export default function MemoryCards({ deck }: { deck: Card[] }) {
  const [open, setOpen] = useState<number[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [moves, setMoves] = useState(0);
  const key = JSON.stringify(deck);
  useEffect(() => { setOpen([]); setDone(new Set()); setMoves(0); }, [key]);
  useEffect(() => {
    if (open.length !== 2) return;
    const [a, b] = open;
    if (deck[a].s === deck[b].s) {
      sfx.success(); buzz(30);
      setDone((d) => new Set([...d, deck[a].s])); setOpen([]);
    } else {
      const t = setTimeout(() => setOpen([]), 750);
      return () => clearTimeout(t);
    }
  }, [open, deck]);
  const tap = (i: number) => {
    if (open.length >= 2 || open.includes(i) || done.has(deck[i].s)) return;
    sfx.tap(); buzz(8);
    setOpen((o) => [...o, i]);
    if (open.length === 1) setMoves((m) => m + 1);
  };
  const matched = [...done];
  return (
    <div className="minigame cards">
      <div className="mg-hud"><span>🃏 {done.size}/{new Set(deck.map((c) => c.s)).size} pairs</span><span className="muted">{moves} moves</span></div>
      <div className="mem-grid">
        {deck.map((c, i) => {
          const up = open.includes(i) || done.has(c.s);
          return (
            <button key={i} className={`mem-card ${up ? 'up' : ''} ${done.has(c.s) ? 'done' : ''}`} onClick={() => tap(i)} aria-label={up ? `${c.s}${done.has(c.s) ? ` letter ${c.l}` : ''}` : 'Face-down card'}>
              <span className="mem-face" style={{ color: RED.has(c.s) ? '#e8283a' : '#141a24' }}>
                {up ? <><b>{c.s}</b>{done.has(c.s) && <em>{c.l}</em>}</> : null}
              </span>
            </button>
          );
        })}
      </div>
      {matched.length > 0 && <div className="mg-found">{matched.map((sy) => <span key={sy} className="mg-chip"><b style={{ color: RED.has(sy) ? '#ff6b7a' : '#fff' }}>{sy}</b> = <b>{deck.find((c) => c.s === sy)!.l}</b></span>)}</div>}
    </div>
  );
}
