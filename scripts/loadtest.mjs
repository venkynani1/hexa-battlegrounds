// Load test against a real Supabase project (or the local server).
// Simulates N squads × 4 players polling state, captains moving and answering.
//
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_KEY=<anon key> \
//   EVENT=LOADTEST SECRET=loadtest123 SQUADS=15 MINUTES=3 node scripts/loadtest.mjs
//
// Use a dedicated test event (it creates one if the code is free). 15 squads = one full map (60 players).
const URL_ = process.env.SUPABASE_URL || 'http://localhost:54321';
const KEY = process.env.SUPABASE_KEY || 'local';
const EVENT = process.env.EVENT || 'LOADTEST';
const SECRET = process.env.SECRET || 'loadtest123';
const SQUADS = Number(process.env.SQUADS || 15);
const MINUTES = Number(process.env.MINUTES || 3);
const POLL_MS = Number(process.env.POLL_MS || 8000);

const lat = []; let errors = 0; let calls = 0; const errs = {};
async function rpc(fn, args, track = true) {
  const t0 = performance.now();
  calls++;
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  if (track) lat.push(performance.now() - t0);
  if (!r.ok) { errors++; const m = String(body?.message || r.status).split(':')[0]; errs[m] = (errs[m] || 0) + 1; throw new Error(m); }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]?.toFixed(0); };

let host;
try { host = (await rpc('host_create_event', { p_code: EVENT, p_name: 'Load test', p_secret: SECRET, p_arenas: Math.ceil(SQUADS / 15) }, false)).token; }
catch { host = (await rpc('host_login', { p_code: EVENT, p_secret: SECRET }, false)).token; }
const pins = await rpc('host_generate_teams', { p_token: host, p_count: SQUADS }, false);
console.log(`Created ${pins.length} squads. Joining ${pins.length * 4} players…`);
const squads = await Promise.all(pins.map(async (p) => {
  const tokens = [];
  for (const n of ['A', 'B', 'C', 'D']) tokens.push((await rpc('join_team', { p_event_code: EVENT, p_team_number: p.number, p_pin: p.pin, p_name: `${n}${p.number}`, p_consent: true, p_rules: true })).token);
  return { ...p, tokens };
}));
const ov = await rpc('host_overview', { p_token: host }, false);
const arenas = ov.arenas.filter((a) => a.phase === 'lobby').map((a) => a.id);
for (const a of arenas) { await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'open_boarding', p_args: {} }, false); }
for (const a of arenas) { await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'drive', p_args: {} }, false); }
await sleep(11000);
// everyone races for captain at once (race-safety check)
await Promise.allSettled(squads.flatMap((s) => s.tokens.map((t) => rpc('claim_role', { p_token: t, p_role: 'captain' }))));
for (const a of arenas) await rpc('host_command', { p_token: host, p_arena: a, p_cmd: 'finalize_roles', p_args: {} }, false);
const end = Date.now() + MINUTES * 60000;
let solved = 0;
console.log(`Playing for ${MINUTES} min with ${squads.length * 4} simulated phones…`);

async function player(token, captain) {
  await sleep(Math.random() * POLL_MS);
  while (Date.now() < end) {
    try {
      const s = await rpc('player_state', { p_token: token });
      if (s.me.role === 'captain' && s.arena.phase === 'play') {
        if (s.mission && Math.random() < 0.5) {
          const o = await rpc('host_overview', { p_token: host }, false);
          const t = o.teams.find((x) => x.id === s.team.id);
          const ans = t?.activity?.answer?.map((p) => (p.accept[0] === '{KEY}' ? t.activity.relay_key : p.accept[0]));
          if (ans) { const r = await rpc('captain_submit', { p_token: token, p_instance: s.mission.id, p_answers: ans, p_idem: crypto.randomUUID() }); if (r.correct) solved++; }
        } else if (!s.mission && s.team.state === 'idle') {
          const locs = ['fountain', 'hexadine', 'hexacafe', 'central_steps', 'hx_lobby', 'eb3_lobby', 'rt_lobby', 'pickleball'];
          await rpc('captain_move', { p_token: token, p_location: locs[Math.floor(Math.random() * locs.length)] }).catch(() => {});
        }
      }
    } catch { /* counted */ }
    await sleep(POLL_MS * (0.8 + Math.random() * 0.4));
  }
}
const t0 = Date.now();
await Promise.all(squads.flatMap((s) => s.tokens.map((t) => player(t))));
const secs = (Date.now() - t0) / 1000;
console.log(`\nCalls: ${calls} (${(calls / secs).toFixed(1)}/s) · errors: ${errors} · missions solved: ${solved}`);
console.log(`Latency ms — p50 ${pct(lat, 50)} · p95 ${pct(lat, 95)} · p99 ${pct(lat, 99)} · max ${Math.max(...lat).toFixed(0)}`);
console.log('Rejections by reason (game rules like ROLE_TAKEN / NOT_CONNECTED are expected):', errs);
console.log('Target: p95 < 500 ms on venue Wi-Fi. Run this once more on event day as a warm-up.');
