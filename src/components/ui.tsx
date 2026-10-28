import { ReactNode, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { fmtClock, secondsLeft, msUntil, useNow, progress } from '../lib/time';
import { feedText, MapData, ZONE_TEXT } from '../lib/game';
import { sfx, setMuted, isMuted, setVolume, getVolume, unlockAudio } from '../lib/sound';
import { store } from '../lib/api';
import { applyPrefs } from '../lib/game';

// ── Toasts ────────────────────────────────────────────────────────────────
type Toast = { id: number; text: string; tone: string };
const listeners = new Set<(t: Toast) => void>();
let toastId = 0;
export function toast(text: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info') {
  const t = { id: ++toastId, text, tone };
  listeners.forEach((l) => l(t));
}
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const l = (t: Toast) => {
      setItems((x) => [...x.slice(-3), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 3800);
    };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
    </div>
  );
}

// ── Timers & bars ────────────────────────────────────────────────────────
export function Countdown({ to, low = 15, className = '', onEnd }: { to?: string | null; low?: number; className?: string; onEnd?: () => void }) {
  useNow(250);
  const s = secondsLeft(to);
  const ended = useRef(false);
  useEffect(() => {
    if (s === 0 && to && !ended.current) { ended.current = true; onEnd?.(); }
    if (s > 0) ended.current = false;
  }, [s, to, onEnd]);
  return <span className={`${className} ${s <= low && s > 0 ? 'low' : ''}`} aria-label={`${s} seconds left`}>{fmtClock(s)}</span>;
}

export function TimerBar({ start, end }: { start?: string | null; end?: string | null }) {
  useNow(250);
  const p = 1 - progress(start, end);
  const low = msUntil(end) < 15000;
  return <div className={`bar timer ${low ? 'low' : ''}`} aria-hidden><i style={{ width: `${p * 100}%` }} /></div>;
}

export function HpBar({ hp, shield = 0, max = 100 }: { hp: number; shield?: number; max?: number }) {
  const cls = hp <= 25 ? 'hp-low' : hp <= 55 ? 'hp-mid' : '';
  return (
    <div className="col" style={{ gap: 3 }}>
      <div className="row between" style={{ fontSize: 12 }}>
        <span className="up" style={{ fontSize: 11 }}>HP</span>
        <span className="mono" style={{ fontSize: 12 }}>{hp}{shield > 0 && <span style={{ color: 'var(--cyan)' }}> +{shield}🛡</span>}</span>
      </div>
      <div className={`bar ${cls}`} role="meter" aria-valuenow={hp} aria-valuemin={0} aria-valuemax={max} aria-label="Squad HP">
        <i style={{ width: `${(hp / max) * 100}%` }} />
        {shield > 0 && <b style={{ width: `${Math.min(100, (shield / max) * 100)}%` }} />}
      </div>
    </div>
  );
}

export function ThreatMeter({ value }: { value: number }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row between"><span className="up" style={{ fontSize: 11, color: 'var(--red)' }}>Squad 00 threat</span><span className="mono">{Math.min(value, 10)}/10</span></div>
      <div className="threat" aria-label={`Threat level ${value} of 10`}>
        {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < value ? 'on' : ''} />)}
      </div>
    </div>
  );
}

export function ZoneChip({ stage, next }: { stage: number; next?: string | null }) {
  useNow(500);
  const warn = next && msUntil(next) > 0;
  return (
    <span className={`chip ${warn ? 'bad' : stage > 0 ? 'warn' : ''}`} title={ZONE_TEXT[stage]}>
      ☢ Zone {stage}{warn && <> · <Countdown to={next} /></>}
    </span>
  );
}

// ── Overlays controlled by the host ──────────────────────────────────────
export function HostOverlays({ overlay, paused }: { overlay: any; paused?: boolean }) {
  useNow(250);
  const bc = overlay?.broadcast;
  const [hidden, setHidden] = useState<string | null>(null);
  const showBroadcast = bc && bc.at !== hidden && msUntil(bc.at) > -45000;
  const cd = overlay?.countdown;
  const cdLeft = cd ? secondsLeft(cd.until) : 0;
  const lastBeep = useRef(-1);
  useEffect(() => {
    if (cd && cdLeft > 0 && cdLeft <= 10 && cdLeft !== lastBeep.current) { lastBeep.current = cdLeft; sfx.tick(); }
    if (cd && cdLeft === 0 && lastBeep.current > 0) { lastBeep.current = 0; sfx.go(); }
  }, [cdLeft, cd]);
  const lastBc = useRef<string | null>(null);
  useEffect(() => {
    if (bc?.at && bc.at !== lastBc.current) { lastBc.current = bc.at; if (msUntil(bc.at) > -10000) sfx.transmission(); }
  }, [bc?.at]);
  return (
    <>
      {showBroadcast && (
        <div className={`broadcast ${bc.tone === 'info' ? 'info' : ''}`} onClick={() => setHidden(bc.at)} role="alert">
          📣 {bc.text}
        </div>
      )}
      {cd && cdLeft > 0 && (
        <div className="countdown-overlay" aria-live="assertive">
          <div className="up muted" style={{ fontSize: 'clamp(16px,3vw,40px)' }}>{cd.label}</div>
          <div className="num" key={cdLeft}>{cdLeft}</div>
        </div>
      )}
      {overlay?.blackout && (
        <div className="blackout scanlines">
          <div className="glitch" style={{ fontSize: 'clamp(22px,5vw,64px)' }}>▓▓ SIGNAL LOST ▓▓</div>
          <div className="muted" style={{ letterSpacing: '0.2em' }}>SQUAD 00 HAS TAKEN THE NETWORK</div>
        </div>
      )}
      {paused && <div className="broadcast info" style={{ top: 'auto', bottom: 0 }}>⏸ GAME PAUSED BY HOST — timers are frozen</div>}
    </>
  );
}

// ── Sheets & modals ──────────────────────────────────────────────────────
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        {title && <div className="row between" style={{ marginBottom: 10 }}><h3>{title}</h3><button className="btn xs ghost" onClick={onClose} aria-label="Close">✕</button></div>}
        {children}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  if (!open) return null;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        {title && <div className="row between" style={{ marginBottom: 12 }}><h3>{title}</h3><button className="btn xs ghost" onClick={onClose} aria-label="Close">✕</button></div>}
        {children}
      </div>
    </div>
  );
}

// ── QR code ──────────────────────────────────────────────────────────────
export function QR({ value, size = 220 }: { value: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: '#04101f', light: '#ffffff' } }).then(setSrc).catch(() => {});
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt={`QR code for ${value}`} style={{ borderRadius: 10, background: '#fff', padding: 6 }} /> : null;
}

// ── Feed ────────────────────────────────────────────────────────────────
export function FeedList({ feed, map, limit = 10, big = false }: { feed: any[]; map: MapData | null; limit?: number; big?: boolean }) {
  return (
    <div className="feed" aria-live="polite">
      {(feed || []).map((f, i) => ({ f, t: feedText(f.type, f.payload, map), i }))
        .filter((x) => x.t).slice(0, limit)
        .map(({ f, t }) => (
          <div key={f.id ?? `${f.at}-${f.type}`} className={`feed-item ${t!.tone}`} style={big ? { fontSize: 17 } : undefined}>{t!.text}</div>
        ))}
    </div>
  );
}

// ── Settings (sound + accessibility) ─────────────────────────────────────
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [muted, setM] = useState(isMuted());
  const [vol, setV] = useState(getVolume());
  const [motion, setMotion] = useState(store.get('hb_motion') || 'auto');
  const [text, setText] = useState(store.get('hb_text') || 'normal');
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="col" style={{ gap: 14 }}>
        <label className="check"><input type="checkbox" checked={!muted} onChange={(e) => { unlockAudio(); setMuted(!e.target.checked); setM(!e.target.checked); sfx.tap(); }} /> Sound effects</label>
        <div className="field"><label htmlFor="vol">Volume</label>
          <input id="vol" type="range" min={0} max={1} step={0.1} value={vol} onChange={(e) => { setVolume(Number(e.target.value)); setV(Number(e.target.value)); sfx.tap(); }} />
        </div>
        <div className="field"><label htmlFor="mot">Motion</label>
          <select id="mot" className="input" value={motion} onChange={(e) => { setMotion(e.target.value); store.set('hb_motion', e.target.value); applyPrefs(); }}>
            <option value="auto">Follow my device</option><option value="full">Full animations</option><option value="reduced">Reduced motion</option>
          </select>
        </div>
        <div className="field"><label htmlFor="txt">Text size</label>
          <select id="txt" className="input" value={text} onChange={(e) => { setText(e.target.value); store.set('hb_text', e.target.value); applyPrefs(); }}>
            <option value="normal">Normal</option><option value="big">Large</option>
          </select>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>Every sound also has an on-screen alert, so you never miss anything in a noisy room.</p>
      </div>
    </Sheet>
  );
}

export function Loading({ text = 'Connecting…' }: { text?: string }) {
  return (
    <div className="screen-full" style={{ position: 'static', minHeight: '60vh' }}>
      <div className="tagline glitch">{text}</div>
    </div>
  );
}

export function ZoneLine({ stage }: { stage: number }) {
  return <span className="muted">{ZONE_TEXT[stage] || ''}</span>;
}
