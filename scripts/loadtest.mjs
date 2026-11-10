// Heavy load test against a real Supabase project (or the local server).
// Simulates full maps of real phones doing what real phones do:
//   • every phone: full state every few seconds + the positions feed every ~2 s
//   • every captain: steering 3 times a second while driving, searching, answering, climbing stairs
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
const STATE_MS = Number(process.env.STATE_MS || (REALTIME ? 8000 : 3500));
const EVENT = process.env.EVENT || `LOAD${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const SECRET = process.env.SECRET || 'loadtest-secret';

const lat = {}; let errors = 0; let calls = 0; const errs = {}; let failed = 0;
async function rpc(fn, args, track = true) {
  const t0 = performance.now();
  calls++;
  let r; let body = null;
  try {
    r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    });
    body = await r.json().catch(() => null);
  } catch (e) { failed++; throw new Error('NETWORK'); }
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

const host = (await rpc('host_create_event', { p_code: EVENT, p_name: 'Load test', p_secret: SECRET, p_arenas: MAPS }, false)).token;
await rpc('host_settings', { p_token: host, p_settings: { shuttle_seconds: 8, roles_seconds: 3, plane_seconds: 40 } }, false);
const pins = await rpc('host_generate_teams', { p_token: host, p_count: SQUADS }, false);
console.log(`Event ${EVENT}: ${pins.length} squads on ${MAPS} map(s). Joining ${pins.length * 4} phones…`);
const squads = [];
for (let i = 0; i < pins.length; i += 5) {
  squads.push(...await Promise.all(pins.slice(i, i + 5).map(async (p) => {
    const tokens = [];
    for (const n of ['A', 'B', 'C', 'D']) tokens.push((await rpc('join_team', { p_event_code: EVENT, p_team_number: p.number, p_pin: p.pin, p_name: `${n}${p.number}`, p_consent: true, p_rules: true }, false)).token);
    return { ...p, tokens };
  })));
}
const ov = await rpc('host_overview', { p_token: host }, false);
const arenas = ov.arenas.map((a) => a.id);
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'zone_cancel', p_args: {} }, false).catch(() => {});
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'open_boarding', p_args: {} }, false);
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'drive', p_args: {} }, false);
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
const map = await rpc('map_data', {}, false);
const ground = map.locations.filter((l) => l.enabled !== false && (l.level || 0) === 0 && !['start', 'stairs'].includes(l.kind));
const end = Date.now() + MINUTES * 60000;
let solved = 0; let steers = 0; let shots = 0; let knocks = 0;
console.log(`Playing for ${MINUTES} min with ${squads.length * 4} phones (${REALTIME ? 'Realtime on' : 'Realtime off: fast polling'})…`);

// answers come from the host view, fetched once every few seconds for everybody (the host console does the same)
let hostView = null;
(async () => { while (Date.now() < end) { try { hostView = await rpc('host_overview', { p_token: host }); } catch { /* counted */ } await sleep(4000); } })();

async function phone(token) {
  await sleep(Math.random() * STATE_MS);
  let st = null; let pos = null; let goal = null; let captain = false; let speed = 0.016;
  const state = async () => {
    try {
      st = await rpc('player_state', { p_token: token });
      captain = st.me.role === 'captain'; speed = st.arena.overlay?.world?.speed || speed;
      if (!pos && st.team.pos) pos = [...st.team.pos];
    } catch { /* counted */ }
  };
  const loops = [
    (async () => { while (Date.now() < end) { await state(); await sleep(STATE_MS * (0.85 + Math.random() * 0.3)); } })(),
    (async () => { while (Date.now() < end) { await sleep(1800 + Math.random() * 500); await rpc('arena_positions', { p_token: token }).catch(() => {}); } })(),
  ];
  await sleep(STATE_MS + 500);
  // every phone shoots at the nearest rival in range (like holding FIRE), from phase 1
  if (process.env.FIRE !== '0') loops.push((async () => {
    while (Date.now() < end) {
      await sleep(700 + Math.random() * 200);
      if (!st || st.arena.phase !== 'play' || (st.arena.overlay?.match?.phase ?? 0) < 1 || !st.team.dropped) continue;
      try {
        const ps = await rpc('arena_positions', { p_token: token });
        const me = ps.squads.find((q) => q.id === st.team.id);
        if (!me?.pos) continue;
        const rv = ps.squads.filter((q) => q.id !== me.id && q.pos && !q.plane && !q.chute && q.state !== 'recovery' && q.level === me.level)
          .map((q) => ({ q, d: Math.hypot(q.pos[0] - me.pos[0], q.pos[1] - me.pos[1]) })).filter((x) => x.d < 0.05).sort((a, b) => a.d - b.d)[0];
        if (rv) { const r = await rpc('squad_fire', { p_token: token, p_target: rv.q.id }); shots++; if (r.knocked) knocks++; }
      } catch { /* refusals (cover, cooldown, protected) are part of the game */ }
    }
  })());
  if (captain) loops.push((async () => {
    while (Date.now() < end) {
      if (!st || st.arena.phase !== 'play') { await sleep(1000); continue; }
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
        } else if (!st.team.dropped) {
          const l = ground[Math.floor(Math.random() * ground.length)];
          await rpc('captain_move', { p_token: token, p_location: l.id });
          await sleep(1500); await state();
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
            const step = Math.min(d, speed * 0.3); const vx = (goal.x - pos[0]) / d; const vy = (goal.y - pos[1]) / d;
            pos = [pos[0] + vx * step, pos[1] + vy * step];
            const r = await rpc('captain_steer', { p_token: token, p_x: pos[0], p_y: pos[1], p_vx: vx * speed, p_vy: vy * speed }); steers++;
            if (r.clamped) pos = [r.x, r.y];
            if (r.wall) goal = null;
            await sleep(300);
          }
        } else await sleep(500);
      } catch { await sleep(700); await state(); }
    }
  })());
  await Promise.all(loops);
}
const t0 = Date.now();
const prog = setInterval(() => {
  const all = Object.values(lat).flat();
  console.log(`  ${Math.round((Date.now() - t0) / 1000)}s · ${calls} calls · p95 ${pct(all, 95)} ms · steer p95 ${pct(lat.captain_steer || [0], 95)} ms · server errors ${failed}`);
}, 30000);
await Promise.all(squads.flatMap((s) => s.tokens.map((t) => phone(t))));
clearInterval(prog);
const secs = (Date.now() - t0) / 1000;
const all = Object.values(lat).flat();
console.log(`\nPhones: ${squads.length * 4} · calls: ${calls} (${(calls / secs).toFixed(0)} per second) · steering calls: ${steers} · shots: ${shots} · knock-outs: ${knocks} · missions solved: ${solved}`);
console.log(`All calls, ms: p50 ${pct(all, 50)} · p95 ${pct(all, 95)} · p99 ${pct(all, 99)} · max ${Math.round(Math.max(...all))}`);
for (const [fn, a] of Object.entries(lat).sort((x, y) => y[1].length - x[1].length)) console.log(`  ${fn.padEnd(22)} ${String(a.length).padStart(6)} calls · p50 ${String(pct(a, 50)).padStart(4)} · p95 ${String(pct(a, 95)).padStart(5)} · max ${Math.round(Math.max(...a))}`);
console.log(`Server errors / dropped requests (should be 0): ${failed}`);
console.log('Game-rule refusals (normal: cooldowns, areas searched out, rounds closed):', errs);
console.log('Target on venue Wi-Fi: p95 under 500 ms and no server errors.');
