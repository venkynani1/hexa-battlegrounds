// Smooth squad movement on every screen.
//  • Teammates: the captain's phone broadcasts position + velocity straight to its own squad over a
//    Supabase Realtime broadcast channel (no database round trip). Teammates dead-reckon between
//    messages, so the squad glides instead of jumping every couple of seconds.
//  • Rivals: a cheap positions-only RPC every ~2 s, also with velocity, dead-reckoned in between.
// The server stays authoritative for game rules; this is presentation only.
import { useEffect, useRef } from 'react';
import { supabase } from './supabase';
import { rpc } from './api';
import { serverTime } from './time';

export type Motion = { x: number; y: number; vx: number; vy: number; l: number; b?: string | null; h?: number; t: number; moving?: boolean; /** the raw positions-feed record (HP, on foot, parachute, buggy…) */ q?: any };

const MAX_EXTRAPOLATE = 1.2; // seconds: never run on past a lost message for long
/** Positions that come from the ~2 s poll are carried a little longer so squads do not stop between polls. */
export const POLL_EXTRAPOLATE = 3.4;

/** Where a moving thing is now, given its last known position and velocity. */
export function predict(m: Motion, now = serverTime(), max = MAX_EXTRAPOLATE) {
  const dt = Math.max(0, Math.min(max, (now - m.t) / 1000));
  return { x: Math.max(0.02, Math.min(0.98, m.x + m.vx * dt)), y: Math.max(0.02, Math.min(0.98, m.y + m.vy * dt)) };
}

/**
 * Captain → teammates link for one squad. The captain calls `send` every frame; it only transmits
 * when direction or speed changes noticeably (or as a heartbeat), keeping Realtime traffic tiny.
 */
export function useSquadLink(teamId: string | null | undefined, isCaptain: boolean) {
  const latest = useRef<Motion | null>(null);
  const chan = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null);
  const last = useRef<{ at: number; vx: number; vy: number; l: number; moving: boolean }>({ at: 0, vx: 0, vy: 0, l: 0, moving: false });

  useEffect(() => {
    if (!supabase || !teamId) return;
    const c = supabase.channel(`mv-${teamId}`, { config: { broadcast: { self: false, ack: false } } });
    if (!isCaptain) {
      c.on('broadcast', { event: 'm' }, ({ payload }) => {
        const p = payload as Motion;
        if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return;
        // both phones keep a server-synced clock; fall back to "just now" if the stamp looks wrong
        const st = Number((p as any).st); const now = serverTime();
        latest.current = { ...p, t: Number.isFinite(st) && Math.abs(now - st) < 1500 ? st : now - 120 };
      });
    }
    c.subscribe();
    chan.current = c;
    return () => { supabase!.removeChannel(c); chan.current = null; };
  }, [teamId, isCaptain]);

  function send(m: { x: number; y: number; vx: number; vy: number; l: number; h?: number }, force = false) {
    const c = chan.current;
    if (!c || !isCaptain) return;
    const now = performance.now();
    const L = last.current;
    const moving = Math.hypot(m.vx, m.vy) > 1e-5;
    const dirChange = Math.abs(Math.atan2(m.vy, m.vx) - Math.atan2(L.vy, L.vx));
    const turn = moving && L.moving && Math.min(dirChange, Math.PI * 2 - dirChange) > 0.21; // ~12°
    const speed = Math.abs(Math.hypot(m.vx, m.vy) - Math.hypot(L.vx, L.vy)) > 0.2 * Math.max(1e-4, Math.hypot(L.vx, L.vy));
    const due = (moving && now - L.at > 1200) || (!moving && L.moving) || m.l !== L.l || moving !== L.moving;
    if (!force && !due && !((turn || speed) && now - L.at > 180)) return;
    last.current = { at: now, vx: m.vx, vy: m.vy, l: m.l, moving };
    c.send({ type: 'broadcast', event: 'm', payload: { ...m, x: +m.x.toFixed(5), y: +m.y.toFixed(5), vx: +m.vx.toFixed(6), vy: +m.vy.toFixed(6), st: serverTime() } });
  }
  return { latest, send };
}

/** Rival squads' positions + velocity, refreshed every ~2 s while `enabled`. */
export function useRivals(token: string | null, enabled: boolean, fast = false) {
  const rivals = useRef(new Map<string, Motion>());
  useEffect(() => {
    if (!token || !enabled) return;
    let stop = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stop) return;
      if (document.visibilityState === 'visible') {
        try {
          const r = await rpc<any>('arena_positions', { p_token: token });
          const t = serverTime();
          const next = new Map<string, Motion>();
          for (const q of r.squads || []) {
            if (!q.pos) continue;
            const v = q.vel || [0, 0];
            // `age` = how long ago the server recorded this position: start the prediction from then
            const age = q.vel && typeof q.age === 'number' ? Math.min(3, Math.max(0, q.age)) * 1000 : 0;
            next.set(q.id, { x: q.pos[0], y: q.pos[1], vx: v[0] || 0, vy: v[1] || 0, l: q.level || 0, b: q.bldg, t: t - age, moving: !!q.vel, q });
          }
          rivals.current = next;
        } catch { /* the full state refresh still covers positions */ }
      }
      // the captain steers and fights: every ~2.5 s; teammates watch: every ~4.5 s (positions are extrapolated in between)
      timer = setTimeout(poll, fast ? 2300 + Math.random() * 500 : 4200 + Math.random() * 800);
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [token, enabled, fast]);
  return rivals;
}

/**
 * Gunfire effects for one map: every shot (after the server has decided hit or miss) is broadcast so
 * every phone and the big screen can draw the tracer at once. Presentation only — damage is on the server.
 */
export type Shot = { a: number; b: number; hit: boolean; crit?: boolean; dmg?: number; ko?: boolean; w?: string };
export function useShots(arenaId: string | null | undefined, onShot: (s: Shot) => void) {
  const chan = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null);
  const cb = useRef(onShot);
  cb.current = onShot;
  useEffect(() => {
    if (!supabase || !arenaId) return;
    const c = supabase.channel(`fx-${arenaId}`, { config: { broadcast: { self: false, ack: false } } });
    c.on('broadcast', { event: 's' }, ({ payload }) => { if (payload && typeof (payload as any).a === 'number') cb.current(payload as Shot); });
    c.subscribe();
    chan.current = c;
    return () => { supabase!.removeChannel(c); chan.current = null; };
  }, [arenaId]);
  return (s: Shot) => { chan.current?.send({ type: 'broadcast', event: 's', payload: s }); cb.current(s); };
}
