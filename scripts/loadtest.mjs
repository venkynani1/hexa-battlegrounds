// Heavy load test against a real Supabase project (or the local server).
// Simulates full maps of real phones doing what real phones do:
//   • every phone: full state every few seconds + the positions feed every ~2 s
//   • every captain: jumping, steering 3 times a second while running/driving, opening boxes, answering
//
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_KEY=<anon key> \
//   MAPS=3 MINUTES=5 node scripts/loadtest.mjs
//
// It creates its own event (LOAD + random letters) with 15 squads per map, 4 phones per squad.
// REALTIME=0 (default) assumes Realtime is down, the worst case: every phone polls fast.
const URL_ = process.env.SUPABASE_URL || 'http://localhost:54321';
const KEY = process.env.SUPABASE_KEY || 'local';
const MAPS = Math.max(1, Math.min(4, Number(process.env.MAPS || 3)));
const SQUADS = Number(process.env.SQUADS || MAPS * 15);
const MINUTES = Number(process.env.MINUTES || 3);
const REALTIME = process.env.REALTIME === '1';
const STATE_MS = Number(process.env.STATE_MS || (REALTIME ? 15000 : 9000));
const EVENT = process.env.EVENT || `LOAD${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const SECRET = process.env.SECRET || 'loadtest-secret';

const lat = {}; let errors = 0; let calls = 0; const errs = {}; let failed = 0;
// PG_URL=postgres://… talks to Postgres directly through a small pool, like Supabase's API server does
// (used to test lock contention on a real Postgres server without going through the internet).
let pool = null;
if (process.env.PG_URL) { const { default: pg } = await import('pg'); pool = new pg.Pool({ connectionString: process.env.PG_URL, max: Number(process.env.PG_POOL || 15) }); }
async function rpcPg(fn, args, track) {
  const t0 = performance.now(); calls++;
  const keys = Object.keys(args);
  const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  try {
    const r = await pool.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
    if (track) (lat[fn] ||= []).push(performance.now() - t0);
    const v = r.rows[0].r;
    if (v && typeof v === 'object' && !Array.isArray(v) && v.error) { errors++; errs[v.error] = (errs[v.error] || 0) + 1; throw new Error(v.error); }
    return v;
  } catch (e) {
    if (track && !(lat[fn] || []).length) (lat[fn] ||= []).push(performance.now() - t0);
    const m = String(e.message).split(':')[0];
    if (!/^[A-Z_]+$/.test(m)) failed++; else errors++;
    errs[m] = (errs[m] || 0) + 1; throw new Error(m);
  }
}
async function rpc(fn, args, track = true) {
  if (pool) return rpcPg(fn, args, track);
  const t0 = performance.now();
  calls++;
  let r; let body = null;
  try {
    r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    body = await r.json().catch(() => null);
  } catch (e) { failed++; errs.NETWORK_TESTER_SIDE = (errs.NETWORK_TESTER_SIDE || 0) + 1; throw new Error('NETWORK'); }
  if (track) (lat[fn] ||= []).push(performance.now() - t0);
  if (!r.ok) {
    const m = String(body?.message || r.status).split(':')[0];
    if (r.status >= 500 || r.status === 429) failed++; else errors++;
    errs[m] = (errs[m] || 0) + 1; throw new Error(m);
  }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] || 0); };

const ONLINE = process.env.ONLINE === '1';
const PLAYERS = Number(process.env.PLAYERS || 200);
// AUTO=1 (online): the host presses Start once (automatic maps); players arrive over JOIN_SECONDS
// and every map fills and takes off by itself. FILL_SECONDS = countdown once a map has 2 ready squads.
const AUTO = ONLINE && process.env.AUTO === '1';
const JOIN_SECONDS = Number(process.env.JOIN_SECONDS || 120);
const host = (await rpc('host_create_event', { p_code: EVENT, p_name: 'Load test', p_secret: SECRET, p_arenas: ONLINE ? 1 : MAPS }, false)).token;
await rpc('host_settings', { p_token: host, p_settings: { shuttle_seconds: 8, roles_seconds: 3, plane_seconds: 40, ...(ONLINE ? { online: 1, online_max_maps: 8 } : {}) } }, false);
const squads = [];
if (AUTO) {
  await rpc('host_settings', { p_token: host, p_settings: { online_fill_seconds: Number(process.env.FILL_SECONDS || 60) } }, false);
  await rpc('host_online_auto', { p_token: host, p_length: 'quick', p_on: true }, false);
  console.log(`Online event ${EVENT}: automatic maps ON; ${PLAYERS} players will arrive over ${JOIN_SECONDS}s`);
} else if (ONLINE) {
  // online edition: everyone checks in with an employee ID and e-mail; a few create squads for friends,
  // most use matchmaking. Squads of 4 (3 allowed), maps open by themselves.
  console.log(`Online event ${EVENT}: ${PLAYERS} players checking in…`);
  const toks = []; const t0 = performance.now();
  for (let i = 0; i < PLAYERS; i += 10) {
    toks.push(...await Promise.all(Array.from({ length: Math.min(10, PLAYERS - i) }, (_, k) => {
      const n = i + k; const friendsCode = n % 20 === 1 ? toks[toks.length - 1]?.code : null;
      return rpc('online_join', { p_event_code: EVENT, p_emp_id: String(7000000000 + n), p_email: `load${n}@hexaware.com`, p_name: `P${n}`,
        p_mode: n % 20 === 0 ? 'create' : 'queue', p_code: friendsCode, p_consent: true, p_existing_token: null });
    })));
  }
  console.log(`  ${PLAYERS} check-ins in ${Math.round(performance.now() - t0)} ms`);
  const by = {}; for (const t of toks) (by[t.team] ||= []).push(t.token);
  for (const [num, tokens] of Object.entries(by)) squads.push({ number: Number(num), tokens });
} else {
const pins = await rpc('host_generate_teams', { p_token: host, p_count: SQUADS }, false);
console.log(`Event ${EVENT}: ${pins.length} squads on ${MAPS} map(s). Joining ${pins.length * 4} phones…`);
for (let i = 0; i < pins.length; i += 5) {
  squads.push(...await Promise.all(pins.slice(i, i + 5).map(async (p) => {
    const tokens = [];
    for (const n of ['A', 'B', 'C', 'D']) tokens.push((await rpc('join_team', { p_event_code: EVENT, p_team_number: p.number, p_pin: p.pin, p_name: `${n}${p.number}`, p_consent: true, p_rules: true }, false)).token);
    return { ...p, tokens };
  })));
}
}
if (ONLINE && !AUTO) {
  // the host presses Start: small squads merge, squads are dealt over the maps, every map takes off
  const st = await rpc('host_online_start', { p_token: host, p_length: 'quick' }, false);
  console.log(`  Start: ${st.squads} squads on ${st.maps} maps (${st.merged} players merged, ${st.left_out} left out)`);
}
const ov = await rpc('host_overview', { p_token: host }, false);
let arenas = ov.arenas.map((a) => a.id);
// START=1 (in-person): the host presses "Start match" (automatic quick match) like on the day
const START = !ONLINE && process.env.START === '1';
if (START) {
  await rpc('host_command', { p_token: host, p_arena: null, p_cmd: 'start_match', p_args: { length: process.env.LENGTH || 'quick' }, p_reason: null }, false);
  console.log('Host pressed Start match (automatic, ' + (process.env.LENGTH || 'quick') + ')');
}
if (!AUTO && !START) {
if (!ONLINE) for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'zone_cancel', p_args: {} }, false).catch(() => {});
if (!ONLINE) for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'open_boarding', p_args: {} }, false);
if (!ONLINE) for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'drive', p_args: {} }, false);
const shuttle = 8000;
console.log(`Bus ride (${shuttle / 1000}s)…`);
await sleep(shuttle + 1500);
// everyone races for captain at once (race-safety check), then the rest of the roles are filled
await Promise.allSettled(squads.flatMap((s) => s.tokens.map((t) => rpc('claim_role', { p_token: t, p_role: 'captain' }, false))));
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'finalize_roles', p_args: {} }, false);
await sleep(1200);
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'finalize_roles', p_args: {} }, false).catch(() => {});
await sleep(1000);
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'set_phase', p_args: { phase: 1 } }, false).catch(() => {}); // gunfights on
}
const map = await rpc('map_data', {}, false);
const ground = map.locations.filter((l) => l.enabled !== false && (l.level || 0) === 0 && !['start', 'stairs'].includes(l.kind));
const end = Date.now() + (AUTO ? JOIN_SECONDS * 1000 : 0) + MINUTES * 60000;
let solved = 0; let steers = 0; let shots = 0; let knocks = 0;
console.log(`Playing for ${MINUTES} min with ${squads.reduce((n, q) => n + q.tokens.length, 0)} players (${REALTIME ? 'Realtime on' : 'Realtime off: fast polling'})…`);

// answers come from the host view, fetched once every few seconds for everybody (the host console does the same)
let hostView = null;
(async () => { while (Date.now() < end) { try { hostView = await rpc('host_overview', { p_token: host }); } catch { /* counted */ } await sleep(4000); } })();

async function phone(token) {
  await sleep(Math.random() * STATE_MS);
  let st = null; let pos = null; let goal = null; let captain = false; let speed = 0.016; let lastPos = null;
  const state = async () => {
    try {
      st = await rpc('player_state', { p_token: token });
      captain = st.me.role === 'captain'; speed = st.arena.overlay?.world?.speed || speed;
      if (!pos && st.team.pos) pos = [...st.team.pos];
    } catch { /* counted */ }
  };
  const loops = [
    (async () => { while (Date.now() < end) { await state(); await sleep(STATE_MS * (0.85 + Math.random() * 0.3)); } })(),
    (async () => { while (Date.now() < end) { await sleep(st?.me?.role === 'captain' ? 3500 + Math.random() * 700 : 6800 + Math.random() * 1400); lastPos = await rpc('arena_positions', { p_token: token }).catch(() => lastPos); } })(),
  ];
  await sleep(STATE_MS + 500);
  // every phone shoots at the nearest rival in range (like holding FIRE), from phase 1
  if (process.env.FIRE !== '0') loops.push((async () => {
    while (Date.now() < end) {
      await sleep(700 + Math.random() * 200);
      if (!st || st.arena.phase !== 'play' || (st.arena.overlay?.match?.phase ?? 0) < 1 || !st.team.dropped) continue;
      try {
        const ps = lastPos;
        if (!ps) continue;
        const me = ps.squads.find((q) => q.id === st.team.id);
        if (!me?.pos) continue;
        const rv = ps.squads.filter((q) => q.id !== me.id && q.pos && !q.plane && !q.chute && q.state !== 'recovery' && q.level === me.level)
          .map((q) => ({ q, d: Math.hypot(q.pos[0] - me.pos[0], q.pos[1] - me.pos[1]) })).filter((x) => x.d < 0.05).sort((a, b) => a.d - b.d)[0];
        if (rv) { const r = await rpc('squad_fire', { p_token: token, p_target: rv.q.id }); shots++; if (r.knocked) knocks++; }
      } catch { /* refusals (cover, cooldown, protected) are part of the game */ }
    }
  })());
  if (ONLINE) loops.push((async () => {
    while (Date.now() < end) { await sleep(15000 + Math.random() * 10000); await rpc('squad_chat_send', { p_token: token, p_body: 'clue: ' + Math.random().toString(36).slice(2, 7), p_kind: 'msg' }).catch(() => {}); await rpc('squad_chat', { p_token: token, p_after: 0 }).catch(() => {}); }
  })());
  loops.push((async () => {
    while (Date.now() < end) {
      if (!captain || !st || st.arena.phase !== 'play') { await sleep(1000); continue; }
      try {
        if (st.mission || st.battle) {
          // think for a while, then answer (right two times out of three)
          await sleep(6000 + Math.random() * 9000);
          const act = st.battle || st.mission;
          const t = hostView?.teams.find((x) => x.id === st.team.id);
          const ans = (t?.activity?.answer || []).map((p) => (Math.random() < 0.67 ? (p.accept[0] === '{KEY}' ? t.activity.relay_key : p.accept[0]) : 'wrong'));
          if (ans.length) { const r = await rpc('captain_submit', { p_token: token, p_instance: act.id, p_answers: ans, p_idem: crypto.randomUUID() }); if (r.correct) solved++; }
          await state();
        } else if (st.team.state === 'traveling') {
          await sleep(1500); await state(); pos = st?.team?.pos ? [...st.team.pos] : pos;
        } else if (!st.team.dropped && !st.team.jump_at) {
          // in the plane: jump somewhere over the campus (refused until the plane is over it)
          await rpc('captain_jump', { p_token: token }).catch(() => {});
          await sleep(1500); await state(); pos = st?.team?.pos ? [...st.team.pos] : pos;
        } else if (!st.team.dropped) {
          await sleep(1500); await state(); pos = st?.team?.pos ? [...st.team.pos] : pos;
        } else if (pos) {
          // drive to a place like a thumb on the joystick: a steer call every 300 ms
          if (!goal) goal = ground[Math.floor(Math.random() * ground.length)];
          const d = Math.hypot(goal.x - pos[0], goal.y - pos[1]);
          if (d < 0.006) {
            goal = null;
            await rpc('captain_steer', { p_token: token, p_x: pos[0], p_y: pos[1], p_vx: 0, p_vy: 0 }); steers++;
            await rpc('captain_explore', { p_token: token }).catch(() => {});
            await state();
          } else {
            const step = Math.min(d, speed * 0.5); const vx = (goal.x - pos[0]) / d; const vy = (goal.y - pos[1]) / d;
            pos = [pos[0] + vx * step, pos[1] + vy * step];
            const r = await rpc('captain_steer', { p_token: token, p_x: pos[0], p_y: pos[1], p_vx: vx * speed, p_vy: vy * speed }); steers++;
            if (r.clamped) pos = [r.x, r.y];
            if (r.wall) goal = null;
            await sleep(500);
          }
        } else await sleep(500);
      } catch { await sleep(700); await state(); }
    }
  })());
  await Promise.all(loops);
}
const t0 = Date.now();
const prog = setInterval(() => {
  if (process.env.QUIET) return;
  const all = Object.values(lat).flat();
  console.log(`  ${Math.round((Date.now() - t0) / 1000)}s · ${calls} calls · p95 ${pct(all, 95)} ms · steer p95 ${pct(lat.captain_steer || [0], 95)} ms · server errors ${failed}`);
}, 30000);
if (AUTO) {
  // the host console stays open (it runs the automatic starter every 5 s); players arrive one by one
  const hostLoop = (async () => { while (Date.now() < end) { await rpc('host_online_summary', { p_token: host }).catch(() => {}); await sleep(5000); } })();
  const phones = []; const toks = [];
  for (let n = 0; n < PLAYERS; n++) {
    await sleep((JOIN_SECONDS * 1000) / PLAYERS);
    const friendsCode = n % 20 >= 1 && n % 20 <= 3 ? toks[toks.length - (n % 20)]?.code : null;
    const r = await rpc('online_join', { p_event_code: EVENT, p_emp_id: String(7000000000 + n), p_email: `load${n}@hexaware.com`, p_name: `P${n}`,
      p_mode: n % 20 === 0 ? 'create' : friendsCode ? 'join' : 'queue', p_code: friendsCode, p_consent: true, p_existing_token: null }).catch(() => null);
    if (!r?.token) continue;
    toks.push(r); phones.push(phone(r.token));
  }
  squads.push({ tokens: toks.map((t) => t.token) });
  await Promise.all([...phones, hostLoop]);
  const sum = await rpc('host_online_summary', { p_token: host }, false);
  arenas = sum.maps.map((m) => m.id);
  console.log('\nMaps:'); for (const m of sum.maps) console.log(`  Map ${m.number}: ${m.phase}${m.launched ? '' : ' (not launched)'} · ${m.players} players · ${m.squads} squads`);
  const stuck = sum.maps.filter((m) => !m.launched).reduce((n, m) => n + m.players, 0);
  console.log(`Players still in a lobby at the end: ${stuck}`);
} else await Promise.all(squads.flatMap((s) => s.tokens.map((t) => phone(t))));
clearInterval(prog);
const secs = (Date.now() - t0) / 1000;
const all = Object.values(lat).flat();
console.log(`\nPlayers: ${squads.reduce((n, q) => n + q.tokens.length, 0)} · maps: ${arenas.length} · calls: ${calls} (${(calls / secs).toFixed(0)} per second) · steering calls: ${steers} · shots: ${shots} · knock-outs: ${knocks} · missions solved: ${solved}`);
console.log(`All calls, ms: p50 ${pct(all, 50)} · p95 ${pct(all, 95)} · p99 ${pct(all, 99)} · max ${Math.round(Math.max(...all))}`);
for (const [fn, a] of Object.entries(lat).sort((x, y) => y[1].length - x[1].length)) console.log(`  ${fn.padEnd(22)} ${String(a.length).padStart(6)} calls · p50 ${String(pct(a, 50)).padStart(4)} · p95 ${String(pct(a, 95)).padStart(5)} · max ${Math.round(Math.max(...a))}`);
console.log(`Server errors / dropped requests (should be 0): ${failed}`);
if (process.env.TO_RESULTS === '1') {
  // keep the host console open until every map that took off has its results
  const until = Date.now() + 8 * 60000; let ovr = null;
  while (Date.now() < until) {
    ovr = await rpc('host_overview', { p_token: host }, false).catch(() => ovr);
    const live = (ovr?.arenas || []).filter((a) => a.autopilot);
    if (live.length && live.every((a) => ['results', 'ended'].includes(a.phase))) break;
    await sleep(10000);
  }
  console.log('Final state of every map:');
  for (const a of ovr?.arenas || []) {
    const w = (a.results || [])[0];
    console.log(`  Map ${a.number}: ${a.phase}${a.autopilot ? '' : ' (never took off)'}${w ? ` · winner Squad ${w.number}${w.name ? ' ' + w.name : ''}${w.points != null ? ' (' + w.points + ' pts)' : ''}` : ''}`);
  }
}
console.log('Game-rule refusals (normal: cooldowns, areas searched out, rounds closed):', errs);
console.log('Target on venue Wi-Fi: p95 under 500 ms and no server errors.');
if (pool) await pool.end();
