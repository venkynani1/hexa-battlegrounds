// Online edition: the squad card at the gate (squad code, teammates, Teams call and chat) and the
// squad comms panel (chat, quick pings, Teams buttons) that floats over every screen.
import { FormEvent, useEffect, useRef, useState } from 'react';
import { friendly, rpc, store } from '../lib/api';
import { ROLES, Role } from '../lib/game';
import { teamsCall, teamsChat } from '../lib/edition';
import { sfx } from '../lib/sound';
import { toast } from './ui';

const PINGS = ['📍 Come to me', '🔎 I have my clue', '🆘 Need help!', '✅ Got it', '⏳ Wait', '🎯 Enemy near'];

function mates(s: any) { return (s.online?.squad || []).filter((m: any) => !m.me && m.email).map((m: any) => m.email as string); }
const topic = (s: any) => `Hexa Battlegrounds · Squad ${s.team.number}`;

export function TeamsButtons({ s, compact = false }: { s: any; compact?: boolean }) {
  const emails = mates(s);
  const none = emails.length === 0;
  return (
    <div className={`teams-btns ${compact ? 'compact' : ''}`}>
      <a className={`btn teams ${none ? 'disabled' : ''}`} href={none ? undefined : teamsCall(emails)} target="_blank" rel="noreferrer"
        aria-disabled={none} onClick={() => sfx.tap()}>📹 {compact ? 'Call' : 'Teams squad call'}</a>
      <a className={`btn ghost ${none ? 'disabled' : ''}`} href={none ? undefined : teamsChat(emails, topic(s), `Squad ${s.team.number} — let's go! 🪂`)} target="_blank" rel="noreferrer"
        aria-disabled={none} onClick={() => sfx.tap()}>💬 {compact ? 'Teams chat' : 'Teams group chat'}</a>
    </div>
  );
}

/** At the gate (lobby / boarding): who is in the squad, the code to share, and the Teams buttons. */
export function OnlineSquad({ s, token, refresh }: { s: any; token: string; refresh: () => void }) {
  const o = s.online;
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const link = `${window.location.origin}/join?e=${encodeURIComponent(store.get('hb_event') || '')}&s=${o.code}`;
  const empty = Math.max(0, 4 - o.size);
  async function switchTo(mode: 'queue' | 'join' | 'create') {
    setBusy(true);
    try {
      const r = await rpc<any>('online_join', { p_event_code: store.get('hb_event'), p_emp_id: store.get('hb_emp'), p_email: store.get('hb_email'),
        p_name: s.me.name, p_mode: mode, p_code: mode === 'join' ? code : null, p_consent: true, p_existing_token: token });
      if (r.token && r.token !== token) store.set('hb_token', r.token);
      toast(mode === 'queue' ? 'Looking for a squad…' : `You are in squad ${r.code}`, 'good'); setCode('');
    } catch (e) { toast(friendly(e), 'bad'); } finally { setBusy(false); refresh(); }
  }
  return (
    <div className="panel online-squad">
      <div className="row between">
        <div className="panel-title" style={{ margin: 0 }}>Squad {s.team.number} · {o.open ? 'matchmade' : 'friends'}</div>
        <span className={`chip ${o.size >= 3 ? 'good' : 'warn'}`}>{o.size}/4 {o.size >= 4 ? 'full' : o.size === 3 ? 'ready · 1 seat open' : 'waiting'}</span>
      </div>
      <div className="sq-code">
        <small>Squad code</small>
        <b className="mono">{o.code}</b>
        <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>
          <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(o.code); toast('Code copied', 'good'); }}>Copy code</button>
          <button className="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(link); toast('Invite link copied — paste it in Teams', 'good'); }}>Copy invite link</button>
        </div>
      </div>
      <div className="col" style={{ gap: 6 }}>
        {o.squad.map((m: any, i: number) => (
          <div key={i} className="row between sq-mate">
            <span><i className={`dot ${m.online ? 'on' : ''}`} /> {m.me ? <b>{m.name} (you)</b> : m.name}</span>
            <span className="muted mono" style={{ fontSize: 12 }}>{m.email}</span>
          </div>
        ))}
        {Array.from({ length: empty }, (_, i) => <div key={`e${i}`} className="sq-mate empty">{o.open ? 'Matchmaking is finding a player…' : 'Empty seat — share the squad code'}</div>)}
      </div>
      <TeamsButtons s={s} />
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {o.started ? 'The game is on — your map is on your boarding pass. ' : 'Maps are assigned when the host starts the game. '}
        {o.size >= 3 ? 'Your squad is ready. Start the Teams call now — you will need to talk: everyone sees a different clue.'
          : 'If your squad is still short when the host starts, you are merged with other players, so nobody is left out.'}
      </p>
      {!o.started && <details className="sq-switch">
        <summary>Change squad</summary>
        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
          <input className="input mono" style={{ width: 110 }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))} placeholder="CODE" aria-label="Squad code" />
          <button className="btn sm" disabled={busy || code.length !== 4} onClick={() => switchTo('join')}>Join code</button>
          {!o.open && <button className="btn sm ghost" disabled={busy} onClick={() => switchTo('queue')}>Find me a squad</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => switchTo('create')}>New squad</button>
        </div>
      </details>}
    </div>
  );
}

/** Floating squad comms: chat + pings + Teams buttons. Works on every screen of the online edition. */
export function SquadComms({ s, token, inGame = false }: { s: any; token: string; inGame?: boolean }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const seenKey = `hb_chat_seen_${s.team.id}`;
  const [seen, setSeen] = useState<number>(() => Number(store.get(seenKey) || 0));
  const lastId = useRef(0);
  const last = Number(s.online?.chat_last || s.chat_last || 0);
  const box = useRef<HTMLDivElement>(null);

  const inflight = useRef(false);
  async function load() {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = (await rpc<any[]>('squad_chat', { p_token: token, p_after: lastId.current })).filter((x) => x.id > lastId.current);
      if (r.length) {
        lastId.current = r[r.length - 1].id;
        setMsgs((m) => { const ids = new Set(m.map((x) => x.id)); return [...m, ...r.filter((x) => !ids.has(x.id))].slice(-80); });
        if (!open && r.some((x) => !x.me && x.kind !== 'system')) sfx.tap();
      }
    } catch { /* next poll */ } finally { inflight.current = false; }
  }
  // reset when the squad changes (merged at take-off, switched at the gate)
  useEffect(() => { lastId.current = 0; setMsgs([]); setSeen(Number(store.get(seenKey) || 0)); load(); }, [s.team.id]);
  useEffect(() => { if (last > lastId.current) load(); }, [last]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, s.team.id]);
  useEffect(() => {
    if (open && lastId.current > seen) { setSeen(lastId.current); store.set(seenKey, String(lastId.current)); }
    box.current?.scrollTo({ top: 1e6 });
  }, [open, msgs.length]);
  const unread = msgs.filter((m) => m.id > seen && !m.me && m.kind !== 'system').length;
  useEffect(() => { window.dispatchEvent(new CustomEvent('hb:unread', { detail: unread })); }, [unread]);
  useEffect(() => {
    const f = () => setOpen((o) => !o);
    window.addEventListener('hb:chat', f);
    return () => window.removeEventListener('hb:chat', f);
  }, []);

  async function send(body: string, kind: 'msg' | 'ping' = 'msg', e?: FormEvent) {
    e?.preventDefault();
    if (!body.trim()) return;
    try { await rpc('squad_chat_send', { p_token: token, p_body: body.trim(), p_kind: kind }); setText(''); sfx.tap(); load(); }
    catch (ex) { toast(friendly(ex), 'bad'); }
  }

  return (
    <>
      {!inGame && <button className={`comms-fab ${unread ? 'new' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Squad chat${unread ? `, ${unread} new` : ''}`}>
        💬<span>Squad</span>{unread > 0 && <em>{unread}</em>}
      </button>}
      {open && (
        <aside className={`comms-panel ${inGame ? 'in-game' : ''}`} aria-label="Squad chat">
          <header>
            <b>Squad {s.team.number} · {(s.squad || s.roster || []).length} players</b>
            <button className="gd-close" onClick={() => setOpen(false)} aria-label="Close squad chat">✕</button>
          </header>
          <div className="comms-mates">
            {(s.squad || s.online?.squad || []).map((m: any, i: number) => (
              <span key={i} className={`mate ${m.status === 'on' || m.online ? 'on' : ''} ${m.status === 'away' ? 'away' : ''}`}>
                {m.role ? ROLES[m.role as Role].icon : '•'}{m.role2 ? ROLES[m.role2 as Role].icon : ''} {m.me ? 'You' : m.name}{m.status === 'away' ? ' · 🤖 bot' : ''}
              </span>
            ))}
          </div>
          {s.online && <TeamsButtons s={s} compact />}
          <div className="comms-msgs" ref={box}>
            {msgs.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Say hi! Clues stay on your own screen — read them out or type them here for your captain.</p>}
            {msgs.map((m) => (
              <div key={m.id} className={`cm ${m.me ? 'me' : ''} ${m.kind}`}>
                {m.kind !== 'system' && !m.me && <small>{m.name}</small>}
                <span>{m.body}</span>
              </div>
            ))}
          </div>
          <div className="comms-pings">{PINGS.map((p) => <button key={p} onClick={() => send(p, 'ping')}>{p}</button>)}</div>
          <form className="comms-input" onSubmit={(e) => send(text, 'msg', e)}>
            <input className="input" value={text} onChange={(e) => setText(e.target.value.slice(0, 240))} placeholder="Message your squad" aria-label="Message your squad" />
            <button className="btn primary sm" disabled={!text.trim()}>Send</button>
          </form>
        </aside>
      )}
    </>
  );
}
