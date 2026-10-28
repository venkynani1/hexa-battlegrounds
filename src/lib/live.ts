import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { syncClock, msUntil } from './time';

type Options = {
  /** realtime topics to listen to, e.g. ['arena-<id>', 'team-<id>'] */
  topics: string[];
  /** fallback poll interval while realtime is connected */
  pollMs?: number;
  /** poll interval when realtime is down */
  pollFastMs?: number;
  /** ISO timestamps in the state at which the server will change something */
  deadlines?: (data: any) => (string | null | undefined)[];
  enabled?: boolean;
};

/**
 * Live state: fetch via RPC, re-fetch when a realtime "ping" arrives, poll as a
 * fallback, and re-fetch right after any known deadline so timers resolve on time.
 */
export function useLive<T = any>(fetcher: () => Promise<T>, opts: Options) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connected, setConnected] = useState(false);
  const inflight = useRef(false);
  const again = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const deadlineTimer = useRef<ReturnType<typeof setTimeout>>();
  const enabled = opts.enabled !== false;

  const refresh = useCallback(async () => {
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    const sentAt = Date.now();
    try {
      const d: any = await fetcherRef.current();
      syncClock(d?.server_now, sentAt);
      setData(d);
      setError(null);
      // schedule a refresh just after the next deadline
      clearTimeout(deadlineTimer.current);
      const dl = (optsRef.current.deadlines?.(d) || [])
        .map((x) => msUntil(x))
        .filter((ms) => ms > -2000 && ms < 15 * 60 * 1000)
        .sort((a, b) => a - b)[0];
      if (dl !== undefined) {
        deadlineTimer.current = setTimeout(() => refresh(), Math.max(300, dl + 450 + Math.random() * 400));
      }
    } catch (e) {
      setError(e);
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; setTimeout(() => refresh(), 150); }
    }
  }, []);

  // ping → jittered refresh (spreads 60 phones over ~300 ms instead of a spike)
  const onPing = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => refresh(), 80 + Math.random() * 320);
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  const topicKey = opts.topics.filter(Boolean).join('|');
  useEffect(() => {
    if (!enabled || !supabase || !topicKey) return;
    const channels = topicKey.split('|').map((topic) =>
      supabase!
        .channel(topic, { config: { broadcast: { self: false } } })
        .on('broadcast', { event: 'ping' }, onPing)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') setConnected(true);
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setConnected(false);
        }),
    );
    return () => { channels.forEach((c) => supabase!.removeChannel(c)); };
  }, [topicKey, enabled, onPing]);

  useEffect(() => {
    if (!enabled) return;
    const ms = connected ? opts.pollMs ?? 8000 : opts.pollFastMs ?? 3000;
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, ms);
    return () => clearInterval(id);
  }, [connected, enabled, opts.pollMs, opts.pollFastMs, refresh]);

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onVis); };
  }, [refresh]);

  useEffect(() => () => { clearTimeout(debounce.current); clearTimeout(deadlineTimer.current); }, []);

  return { data, error, connected, refresh, setData };
}
