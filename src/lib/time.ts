import { useEffect, useState } from 'react';

// Server-authoritative clock. Every state response carries server_now; we keep a
// smoothed offset so countdowns on every phone match the server, not the device clock.
let offset = 0;
let samples = 0;

export function syncClock(serverNowIso: string | undefined, sentAt: number) {
  if (!serverNowIso) return;
  const recv = Date.now();
  const rtt = recv - sentAt;
  if (rtt > 4000) return; // ignore very slow samples
  const sample = new Date(serverNowIso).getTime() + rtt / 2 - recv;
  offset = samples === 0 ? sample : offset * 0.7 + sample * 0.3;
  samples++;
}

export const serverTime = () => Date.now() + offset;

export function msUntil(iso?: string | null): number {
  if (!iso) return 0;
  return new Date(iso).getTime() - serverTime();
}

export function secondsLeft(iso?: string | null): number {
  return Math.max(0, Math.ceil(msUntil(iso) / 1000));
}

export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function progress(startIso?: string | null, endIso?: string | null): number {
  if (!startIso || !endIso) return 0;
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (b <= a) return 1;
  return Math.min(1, Math.max(0, (serverTime() - a) / (b - a)));
}

/** Re-render every `ms` milliseconds (for countdowns and animations). */
export function useNow(ms = 250) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return serverTime();
}
