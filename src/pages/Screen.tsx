import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { friendly, rpc } from '../lib/api';
import { useLive } from '../lib/live';
import { msUntil, progress, secondsLeft, useNow, fmtClock } from '../lib/time';
import { feedText, FINALE_STAGES, KIND_LABEL, MapData, useMapData, ZONE_TEXT } from '../lib/game';
import { sfx, unlockAudio, audioReady } from '../lib/sound';
import CampusMap from '../components/CampusMap';
import { RoadScene, busCode, shuttleStage } from '../components/Shuttle';
import { PhaseBanner, TrialRibbon } from '../components/Phase';
import { Countdown, FeedList, HostOverlays, Loading, QR, ThreatMeter } from '../components/ui';

export default function Screen() {
  const { token } = useParams();
  const map = useMapData();
  const fetcher = useCallback(() => rpc('spectator_state', { p_token: token }), [token]);
  const [topics, setTopics] = useState<string[]>([]);
  const live = useLive<any>(fetcher, {
    topics, pollMs: 3000, pollFastMs: 2000,
    deadlines: (s) => [s?.arena?.shuttle_arrive_at, s?.arena?.roles_deadline, s?.arena?.zone_next_at, s?.sync?.deadline],
  });
  const s = live.data;
  const [armed, setArmed] = useState(audioReady());
  useEffect(() => { if (s?.arena?.id && topics[0] !== `arena-${s.arena.id}`) setTopics([`arena-${s.arena.id}`]); }, [s?.arena?.id]);
  useScreenSounds(s);
  const [alert, setAlert] = useState<{ text: string; tone: string } | null>(null);
  useFeedAlerts(s, map, setAlert);

  if (live.error && !s) return <Loading text={friendly(live.error)} />;
  if (!s || !map) return <Loading text="Linking projector…" />;
  const phase = s.arena.phase;

  return (
    <div style={{ position: 'fixed', inset: 0 }} onClick={() => { unlockAudio(); setArmed(true); }}>
      <HostOverlays overlay={s.arena.overlay} paused={s.arena.paused} />
      <TrialRibbon on={!!s.arena.overlay?.trial || String(s.event?.name || '').startsWith('TRIAL')} />
      {!armed && (
        <button className="btn ghost sm" style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 99 }}
          onClick={() => { unlockAudio(); setArmed(true); document.documentElement.requestFullscreen?.().catch(() => {}); sfx.gate(); }}>
          🔊 Enable sound & fullscreen
        </button>
      )}
      {alert && <div className={`broadcast ${alert.tone === 'good' ? 'info' : ''}`} style={{ fontSize: 26, padding: 18 }}>{alert.text}</div>}
      <StoryFlash story={s.story} />
      {phase === 'lobby' && <LobbyScreen s={s} />}
      {(phase === 'boarding' || phase === 'shuttle') && <ShuttleScreen s={s} />}
      {phase === 'roles' && <RolesScreen s={s} />}
      {phase === 'play' && <PlayScreen s={s} map={map} />}
      {phase === 'finale' && <FinaleScreen s={s} map={map} />}
      {(phase === 'results' || phase === 'ended') && <ResultsScreen s={s} />}
    </div>
  );
}

function useScreenSounds(s: any) {
  const prev = useRef<any>(null);
  useEffect(() => {
    const p = prev.current; prev.current = s;
    if (!s || !p) return;
    if (p.arena.phase !== s.arena.phase) {
      if (s.arena.phase === 'shuttle') sfx.shuttle();
      if (s.arena.phase === 'roles') sfx.gate();
      if (s.arena.phase === 'play') sfx.reveal();
      if (s.arena.phase === 'finale') sfx.reveal();
    }
    if (s.arena.zone_next_at && s.arena.zone_next_at !== p.arena.zone_next_at) sfx.zone();
    if (s.arena.zone_stage > p.arena.zone_stage) sfx.damage();
    if ((s.airdrops?.length || 0) > (p.airdrops?.length || 0)) sfx.airdrop();
    if ((s.battles?.length || 0) > (p.battles?.length || 0)) sfx.weapon();
    if (s.sync && s.sync.deadline !== p.sync?.deadline) sfx.go();
    if (s.sync && p.sync && s.sync.solved > p.sync.solved) sfx.success();
  }, [s]);
}

function useFeedAlerts(s: any, map: MapData | null, set: (a: any) => void) {
  const seen = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!s?.feed?.length) return;
    const newest = s.feed[0].id;
    if (seen.current === 0) { seen.current = newest; return; }
    const fresh = s.feed.filter((f: any) => f.id > seen.current).reverse();
    seen.current = Math.max(seen.current, newest);
    const big = fresh.map((f: any) => ({ f, t: feedText(f.type, f.payload, map) }))
      .filter((x: any) => x.t && ['battle.started', 'airdrop.spawned', 'zone.warning', 'zone.collapsed', 'alliance.betrayed', 'airdrop.claimed', 'final.started'].includes(x.f.type));
    if (big.length) {
      set(big.at(-1).t);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => set(null), 4500);
    }
  }, [s?.feed?.[0]?.id]);
}

function Head({ s, right }: { s: any; right?: React.ReactNode }) {
  return (
    <div className="screen-head">
      <div className="row" style={{ gap: 18 }}>
        <div className="brand" style={{ fontSize: 0 }}><span className="l2" style={{ fontSize: 34 }}>Battlegrounds</span></div>
        <div className="col" style={{ gap: 2 }}>
          <span className="up" style={{ color: 'var(--orange)', fontSize: 16 }}>Operation Siruseri · {s.arena.name}</span>
          <span className="tagline" style={{ fontSize: 12 }}>Drop. Decode. Dominate.</span>
        </div>
      </div>
      {right}
    </div>
  );
}

function LobbyScreen({ s }: { s: any }) {
  const url = `${window.location.origin}/join?e=${s.event.code}`;
  const ready = s.squads.filter((x: any) => x.ready).length;
  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <Head s={s} />
      <div className="col" style={{ justifyContent: 'center', gap: 24 }}>
        <div className="brand"><span className="l1" style={{ fontSize: 26 }}>Hexaware</span><span className="l2" style={{ fontSize: 'clamp(50px,7vw,120px)' }}>Battlegrounds</span><span className="l3" style={{ fontSize: 'clamp(26px,3vw,48px)' }}>Operation Siruseri</span></div>
        <div className="tagline" style={{ fontSize: 22 }}>Drop. Decode. Dominate.</div>
        <div className="row" style={{ gap: 24, alignItems: 'center' }}>
          <QR value={url} size={240} />
          <div className="col" style={{ gap: 8 }}>
            <span className="up muted">Scan to join</span>
            <span className="mono" style={{ fontSize: 22 }}>{url.replace(/^https?:\/\//, '')}</span>
            <span className="up muted">Event code</span>
            <span className="mega" style={{ fontSize: 56, color: 'var(--cyan)' }}>{s.event.code}</span>
          </div>
        </div>
      </div>
      <div className="col" style={{ minHeight: 0 }}>
        <div className="row between"><span className="up" style={{ fontSize: 20 }}>Squads</span><span className="chip good" style={{ fontSize: 16 }}>{ready}/{s.squads.length} ready</span></div>
        <div className="squad-grid" style={{ overflow: 'auto' }}>
          {s.squads.map((q: any) => (
            <div key={q.number} className={`squad-tile ${q.ready ? 'ready' : ''}`}>
              <div className="row between"><b className="up" style={{ fontSize: 22 }}>#{q.number}</b><span className={`chip ${q.ready ? 'good' : ''}`}>{q.players}/4</span></div>
              <div className="muted" style={{ fontSize: 13 }}>{q.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ShuttleScreen({ s }: { s: any }) {
  useNow(500);
  const buses = useMemo(() => {
    const m: Record<number, any[]> = {};
    s.squads.filter((q: any) => q.bus).forEach((q: any) => (m[q.bus] ||= []).push(q));
    return Object.entries(m).map(([b, sq]) => ({ bus: Number(b), squads: sq })).sort((a, b) => a.bus - b.bus);
  }, [s.squads]);
  const ready = s.squads.filter((q: any) => q.ready).length;
  if (s.arena.phase === 'shuttle') {
    const st = shuttleStage(s.arena.shuttle_departed_at, s.arena.shuttle_arrive_at);
    return (
      <div className="screen-full" style={{ justifyContent: 'flex-start', paddingTop: '3vh', gap: '2vh' }}>
        <div className="row between" style={{ width: '94vw' }}>
          <span className="up" style={{ fontSize: 26, color: 'var(--orange)' }}>SIPCOT → Operation Siruseri · {s.arena.name}</span>
          <span className="mega" style={{ fontSize: 'clamp(30px,4vw,64px)' }}>{st.doors ? 'Doors closing' : st.arriving ? 'Arriving at Gate 1' : 'En route'}</span>
        </div>
        <div style={{ width: '94vw' }}>
          <RoadScene big start={s.arena.shuttle_departed_at} end={s.arena.shuttle_arrive_at}
            buses={buses.filter((b) => b.squads.some((q: any) => q.ready)).map((b) => ({ bus: b.bus, label: b.squads.filter((q: any) => q.ready).map((q: any) => q.name).join(' · ') }))} />
        </div>
        <div className="row wrap" style={{ gap: 12, justifyContent: 'center' }}>
          {buses.map((b) => <span key={b.bus} className="chip gold" style={{ fontSize: 18, padding: '8px 14px' }}>{busCode(b.bus)}: {b.squads.filter((q: any) => q.ready).map((q: any) => `#${q.number}`).join(' ')}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div className="screen-full" style={{ justifyContent: 'flex-start', paddingTop: '4vh' }}>
      <div className="up muted" style={{ fontSize: 24 }}>SIPCOT shuttle terminal · {s.arena.name}</div>
      <div className="mega">Boarding</div>
      <div className="up" style={{ fontSize: 22, color: 'var(--green)' }}>{ready} / {s.squads.length} squads ready · doors open</div>
      <div className="squad-grid" style={{ width: '92vw', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', marginTop: 12 }}>
        {buses.map((b) => (
          <div key={b.bus} className="bus-card">
            <div className="row between"><b className="up" style={{ fontSize: 26, color: 'var(--gold)' }}>🚌 {busCode(b.bus)}</b>
              <span className="chip">{b.squads.filter((q: any) => q.ready).length}/{b.squads.length} squads</span></div>
            {b.squads.map((q: any) => (
              <div key={q.number} style={{ marginTop: 10, textAlign: 'left' }}>
                <div className="row between"><span style={{ fontSize: 17 }}><b>#{q.number}</b> {q.name}</span><span className={`chip ${q.ready ? 'good' : ''}`}>{q.players}/4</span></div>
                <div className="seats">{[0, 1, 2, 3].map((i) => <i key={i} className={i < q.players ? 'on' : ''} />)}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function RolesScreen({ s }: { s: any }) {
  useNow(200);
  return (
    <div className="screen-full">
      <div className="up" style={{ fontSize: 28, color: 'var(--orange)' }}>Gate 1 · Identity check</div>
      <div className="mega">Claim your roles</div>
      <div className={`huge-timer ${secondsLeft(s.arena.roles_deadline) <= 5 ? 'glitch' : ''}`}>{secondsLeft(s.arena.roles_deadline)}</div>
      <div className="row" style={{ gap: 30, fontSize: 26 }}>
        <span style={{ color: 'var(--gold)' }}>★ Captain</span><span style={{ color: 'var(--cyan)' }}>◉ Scout</span>
        <span style={{ color: 'var(--violet)' }}>⌬ Decoder</span><span style={{ color: 'var(--green)' }}>◈ Intel Officer</span>
      </div>
    </div>
  );
}

function PlayScreen({ s, map }: { s: any; map: MapData }) {
  const zoneWarn = !!s.arena.zone_next_at && msUntil(s.arena.zone_next_at) > 0;
  const board = [...s.squads].filter((q: any) => q.ready).sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0) || a.number - b.number);
  return (
    <div className="screen">
      <Head s={s} right={<div className="row" style={{ gap: 10 }}>
        <span className={`chip ${zoneWarn ? 'bad' : 'warn'}`} style={{ fontSize: 18, padding: '8px 14px' }}>☢ Zone {s.arena.zone_stage}{zoneWarn && <> · collapse in <Countdown to={s.arena.zone_next_at} /></>}</span>
      </div>} />
      <div className="screen-main">
        <CampusMap map={map} zoneStage={s.arena.zone_stage} zoneWarning={zoneWarn} interactive={false} height="100%" bigLabels
          squads={s.squads.filter((q: any) => q.ready)} airdrops={s.airdrops} battles={s.battles} />

      </div>
      <div className="screen-side">
        <PhaseBanner overlay={s.arena.overlay} />
        <div className="panel" style={{ padding: '10px 14px' }}>
          <span className="up" style={{ fontSize: 13 }}>☢ {ZONE_TEXT[s.arena.zone_stage]}</span>
          <div style={{ marginTop: 8 }}><ThreatMeter value={s.arena.threat} /></div>
        </div>
        <div className="panel" style={{ minHeight: 0, flex: '1 1 50%', overflow: 'hidden' }}>
          <div className="panel-title">Leaderboard</div>
          {s.arena.overlay?.hide_rankings ? (
            <div className="center col" style={{ gap: 10, padding: '30px 0' }}>
              <div className="mega" style={{ fontSize: 40 }}>Rankings sealed</div>
              <div className="muted">The host will reveal the standings.</div>
            </div>
          ) : <div className="col" style={{ gap: 6 }}>
            {board.slice(0, 10).map((q: any, i: number) => (
              <div key={q.number} className={`leader-row top${i + 1}`}>
                <span className="rk">{i + 1}</span>
                <span>Squad {q.number} {q.name !== `Squad ${q.number}` && <span className="muted" style={{ fontSize: 13 }}>{q.name}</span>}{q.state === 'recovery' && ' ✚'}{q.in_battle && ' ⚔'}</span>
                <b className="mono">{q.points ?? 0}</b>
              </div>
            ))}
          </div>}
        </div>
        <div className="panel" style={{ flex: '1 1 40%', minHeight: 0, overflow: 'hidden' }}>
          <div className="panel-title">Live feed</div>
          <FeedList feed={s.feed} map={map} limit={8} big />
        </div>
      </div>
    </div>
  );
}

function FinaleScreen({ s, map }: { s: any; map: MapData }) {
  useNow(250);
  const stage = s.arena.finale_stage || 'A';
  if (stage === 'D' && s.recap) return <Squad00Reveal s={s} />;
  const st = FINALE_STAGES[stage];
  return (
    <div className="screen-full" style={{ justifyContent: 'flex-start', paddingTop: '4vh' }}>
      <div className="up" style={{ color: 'var(--orange)', fontSize: 24 }}>Final battleground · Training Room 14</div>
      <div className="mega">Stage {stage}: {st?.name}</div>
      <div className="muted" style={{ fontSize: 22 }}>{st?.text}</div>
      {s.sync ? (
        <>
          <div className="up" style={{ fontSize: 22, marginTop: 10 }}>{KIND_LABEL[s.sync.kind]} · “{s.sync.title}”</div>
          <div className={`huge-timer ${secondsLeft(s.sync.deadline) <= 10 ? 'glitch' : ''}`} style={{ color: secondsLeft(s.sync.deadline) <= 10 ? 'var(--red)' : undefined }}>{fmtClock(secondsLeft(s.sync.deadline))}</div>
          <div className="up" style={{ fontSize: 20 }}>{s.sync.solved} / {s.sync.total} squads cracked it</div>
          <div className="row wrap" style={{ width: '90vw', justifyContent: 'center', gap: 12 }}>
            {s.squads.filter((q: any) => q.ready).map((q: any) => (
              <div key={q.number} className={`squad-tile ${q.sync_solved ? 'solved' : ''}`} style={{ width: 170 }}>
                <b className="up" style={{ fontSize: 26 }}>#{q.number}</b>
                <div style={{ fontSize: 15 }}>{q.sync_solved ? '✔ CRACKED' : '… decoding'}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ width: '70vw', height: '55vh', marginTop: 10 }}>
          <CampusMap map={map} zoneStage={5} interactive={false} height="100%" squads={s.squads.filter((q: any) => q.ready)} bigLabels />
        </div>
      )}
      <div style={{ position: 'fixed', right: 16, bottom: 16, width: 380 }} className="panel"><ThreatMeter value={s.arena.threat} /></div>
    </div>
  );
}

function Squad00Reveal({ s }: { s: any }) {
  const r = s.recap;
  const threat = r.threat || 0;
  const [step, setStep] = useState(0);
  useEffect(() => {
    sfx.transmission();
    const ids = [1, 2, 3, 4].map((n) => setTimeout(() => { setStep(n); sfx.transmission(); }, n * 2600));
    return () => ids.forEach(clearTimeout);
  }, []);
  const verdict = threat <= 2
    ? 'You starved it. Most squads refused its bargains and kept their word. The campus network is yours.'
    : threat <= 5
      ? 'It fed on every shortcut you took — and on every promise you kept, it weakened. Tonight it is wounded, not gone.'
      : 'Every bargain and every betrayal made it stronger. Squad 00 was built from your own choices — and it almost won.';
  return (
    <div className="screen-full scanlines" style={{ background: 'radial-gradient(circle, rgba(60,0,10,0.6), #000)' }}>
      <div className="transmission up glitch" style={{ fontSize: 26 }}>▓▓ Decrypting Squad 00 ▓▓</div>
      {step >= 1 && <div className="mega glitch" style={{ color: 'var(--red)' }}>Squad 00 was never a team</div>}
      {step >= 2 && <div className="transmission" style={{ fontSize: 'clamp(18px,2.2vw,32px)', maxWidth: '70vw' }}>It was the campus security AI, built to test one thing: would squads trust each other, or sell each other out?</div>}
      {step >= 3 && (
        <div className="row wrap" style={{ gap: 14, justifyContent: 'center', fontSize: 22 }}>
          <span className="chip bad" style={{ fontSize: 20, padding: '10px 16px' }}>{r.bargains_accepted} bargains accepted</span>
          <span className="chip good" style={{ fontSize: 20, padding: '10px 16px' }}>{r.bargains_refused} bargains refused</span>
          <span className="chip bad" style={{ fontSize: 20, padding: '10px 16px' }}>{r.betrayals} betrayals</span>
          <span className="chip good" style={{ fontSize: 20, padding: '10px 16px' }}>{r.codewords_shared} codewords shared</span>
          <span className="chip" style={{ fontSize: 20, padding: '10px 16px' }}>{r.battles} battles</span>
        </div>
      )}
      {step >= 4 && <div className="mega" style={{ fontSize: 'clamp(24px,3vw,52px)', maxWidth: '80vw', color: threat <= 2 ? 'var(--green)' : threat <= 5 ? 'var(--gold)' : 'var(--red)' }}>{verdict}</div>}
      <div style={{ position: 'fixed', bottom: 20, width: 420 }}><ThreatMeter value={threat} /></div>
    </div>
  );
}

function ResultsScreen({ s }: { s: any }) {
  const grand = s.event.grand_revealed && s.grand;
  const list = grand ? s.grand : s.results;
  const [step, setStep] = useState(0);
  const key = grand ? 'grand' : s.results ? 'arena' : 'none';
  useEffect(() => {
    if (!list) return;
    setStep(0);
    const seq = [[1, 1000], [2, 2000], [3, 3000], [4, 5500], [5, 8500], [6, 11500]];
    const ids = seq.map(([n, t]) => setTimeout(() => {
      setStep(n);
      if (n <= 3) sfx.tick();
      if (n === 4 || n === 5) sfx.success();
      if (n === 6) sfx.reveal();
    }, t));
    return () => ids.forEach(clearTimeout);
  }, [key]);

  if (!list) {
    return (
      <div className="screen-full">
        <div className="up muted" style={{ fontSize: 26 }}>{s.arena.name}</div>
        <div className="mega">Results sealed</div>
        <div className="tagline" style={{ fontSize: 20 }}>The champion will be revealed by the host</div>
      </div>
    );
  }
  const [first, second, third] = list;
  const tie = first?.tie;
  return (
    <div className="screen-full">
      {step >= 6 && <Confetti />}
      <div className="up" style={{ fontSize: 26, color: 'var(--orange)' }}>{grand ? 'Grand champion · all maps' : `${s.arena.name} champion`}</div>
      {step >= 1 && step <= 3 && <div className="huge-timer">{4 - step}</div>}
      {step >= 4 && (
        <div className="podium" style={{ marginTop: 10 }}>
          <div>{step >= 5 && second && <><b className="up" style={{ fontSize: 30 }}>Squad {second.number}</b><span className="muted">{second.name}{grand ? ` · Map ${second.arena}` : ''} · {second.points}</span></>}
            <div className="block" style={{ height: '22vh', background: 'linear-gradient(180deg,#d6e2f0,#7f8ea3)', color: '#0b1220' }}>2</div></div>
          <div>{step >= 6 && first && <><b className="mega gold" style={{ fontSize: 'clamp(30px,4vw,64px)' }}>Squad {first.number}</b><span style={{ fontSize: 20 }}>{first.name}{grand ? ` · Map ${first.arena}` : ''} · {first.points} pts</span></>}
            <div className="block" style={{ height: '32vh', background: 'linear-gradient(180deg,#ffd76b,#d49513)', color: '#1a1200' }}>1</div></div>
          <div>{third && <><b className="up" style={{ fontSize: 26 }}>Squad {third.number}</b><span className="muted">{third.name}{grand ? ` · Map ${third.arena}` : ''} · {third.points}</span></>}
            <div className="block" style={{ height: '15vh', background: 'linear-gradient(180deg,#e9a873,#9b5a2a)', color: '#1a0b00' }}>3</div></div>
        </div>
      )}
      {step >= 6 && (tie
        ? <div className="mega" style={{ color: 'var(--orange)', fontSize: 'clamp(30px,5vw,80px)' }}>Tie at the top — tiebreaker challenge!</div>
        : <div className="mega gold glitch" style={{ fontSize: 'clamp(36px,6.5vw,120px)' }}>Winner winner chicken dinner!</div>)}
    </div>
  );
}

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 90 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 3, dur: 3 + Math.random() * 3,
    color: ['#ffc23d', '#3ef0ff', '#ff8a3d', '#5dff9e', '#b07cff', '#ff4d5e'][i % 6],
  })), []);
  return <div className="confetti" aria-hidden>{pieces.map((p, i) => <i key={i} style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s` }} />)}</div>;
}

function StoryFlash({ story }: { story: any[] }) {
  const [show, setShow] = useState<any>(null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    const st = story?.[0];
    if (!st) return;
    if (last.current === null) { last.current = st.at; return; }
    if (st.at !== last.current && st.kind === 'transmission') {
      last.current = st.at;
      setShow(st); sfx.transmission();
      const t = setTimeout(() => setShow(null), 12000);
      return () => clearTimeout(t);
    }
  }, [story?.[0]?.at]);
  if (!show) return null;
  return (
    <div className="modal-bg scanlines" style={{ zIndex: 88, background: 'rgba(0,0,0,0.9)' }} onClick={() => setShow(null)}>
      <div className="col center" style={{ maxWidth: '75vw', gap: 20 }}>
        <div className="transmission up glitch" style={{ fontSize: 26 }}>▓ Incoming transmission · Squad 00 ▓</div>
        <div className="mega transmission" style={{ fontSize: 'clamp(30px,4vw,70px)' }}>{show.title}</div>
        <div className="transmission" style={{ fontSize: 'clamp(18px,2.2vw,34px)', whiteSpace: 'pre-wrap' }}>{show.body}</div>
      </div>
    </div>
  );
}
