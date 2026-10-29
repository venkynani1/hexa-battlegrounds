import { MATCH_PHASES } from '../lib/game';
import { msUntil, useNow } from '../lib/time';
import { Countdown } from './ui';

/** Current match phase (public mirror in arena.overlay.match), with rules and time to the next phase. */
export function PhaseBanner({ overlay, big = false }: { overlay: any; big?: boolean }) {
  useNow(1000);
  const m = overlay?.match;
  if (!m) return null;
  const ph = Math.max(0, Math.min(5, Number(m.phase) || 0));
  const info = MATCH_PHASES[ph];
  const next = m.next_at && msUntil(m.next_at) > 0 ? m.next_at : null;
  const duelsIn = (m.duel_phase ?? 2) - ph;
  return (
    <div className="phase-banner" style={big ? { padding: 16 } : undefined} role="status" aria-live="polite">
      <span className="ph-n" style={big ? { fontSize: 44 } : undefined} aria-hidden>{ph}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row between" style={{ gap: 6 }}>
          <b className="up" style={{ fontSize: big ? 22 : 14 }}>Phase {ph} · {info.name}</b>
          {next && <span className="chip">Next in <Countdown to={next} /></span>}
        </div>
        <div className="muted" style={{ fontSize: big ? 16 : 12 }}>{info.theme} — {info.rules}{duelsIn > 0 ? ` Duels unlock in phase ${m.duel_phase ?? 2}.` : ''}</div>
        <div className="phase-track" style={{ marginTop: 6 }} aria-hidden>
          {MATCH_PHASES.map((_, i) => <i key={i} className={i < ph ? 'done' : i === ph ? 'now' : ''} />)}
        </div>
      </div>
    </div>
  );
}

export function TrialRibbon({ on }: { on: boolean }) {
  if (!on) return null;
  return <div className="trial-ribbon" role="note"><span>TRIAL MODE</span></div>;
}
