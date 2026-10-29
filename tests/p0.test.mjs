// P0 tests: match phases, pacing, trial mode isolation, squad preparation, multi-map isolation.
// Run: npm test   (uses the real migrations in embedded Postgres)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let db;
const MIG = new URL(process.env.SQL_DIR || '../supabase/migrations/', import.meta.url);
async function call(fn, ...args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query(`select ${fn}(${ph}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  const out = r.rows[0].r;
  if (out && typeof out === 'object' && out.error && out.ok === undefined) throw new Error(out.error);
  return out;
}
async function fails(p, code) { await assert.rejects(p, (e) => { assert.match(e.message, new RegExp(code)); return true; }); }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const cmd = async (tok, arena, c, args = {}, reason = null) => call('host_command', tok, arena, c, args, reason);
const unthrottle = (id) => db.query('update arenas set last_tick_at = null where id = $1', [id]);

let live, trial, liveArenas, trialArena;
const squads = {};

async function joinSquad(code, number, pin, prefix) {
  const tokens = [];
  for (const n of ['A', 'B', 'C', 'D']) tokens.push((await call('join_team', code, number, pin, `${prefix}${n}`, true, true, null)).token);
  return tokens;
}
async function toPlay(tok, arenaId) {
  await cmd(tok, arenaId, 'open_boarding');
  await cmd(tok, arenaId, 'drive');
  await cmd(tok, arenaId, 'finalize_roles'); // skips to Gate 1 then closes role claims
  await unthrottle(arenaId);
  await cmd(tok, arenaId, 'finalize_roles');
}

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  live = await call('host_create_event', 'LIVE1', 'Live', 'livepass1', 2);
  trial = await call('host_create_trial', 'TRY1', 'Rehearsal', 'trialpass1', 1);
  liveArenas = (await all(`select id from arenas where event_id = $1 order by number`, [live.event_id])).map((r) => r.id);
  trialArena = (await one(`select id from arenas where event_id = $1`, [trial.event_id])).id;
});

test('generated squads: 6-digit strong PINs, codenames, bus numbers at creation', async () => {
  const pins = await call('host_generate_teams', live.token, 17);
  assert.ok(pins.every((p) => /^\d{6}$/.test(p.pin)));
  assert.equal(new Set(pins.map((p) => p.pin)).size, pins.length, 'PINs are not repeated');
  assert.equal(pins[0].name, 'Alpha-01');
  assert.equal(pins[6].name, 'Golf-07');
  assert.deepEqual(pins.slice(0, 7).map((p) => p.bus), [1, 1, 1, 2, 2, 2, 3]);
  assert.equal(pins[15].map, 2);
  assert.equal(pins[15].bus, 1, 'bus numbering restarts per map');
  for (const p of pins) squads[p.number] = p;
  const roster = await call('host_roster', live.token);
  assert.equal(roster.length, 17);
  assert.ok(!JSON.stringify(roster).includes(pins[0].pin), 'roster never contains PINs');
  const stored = await one(`select pin_hash from teams where event_id = $1 and number = 1`, [live.event_id]);
  assert.notEqual(stored.pin_hash, pins[0].pin);
});

test('PIN reset: old PIN stops working, new PIN works, PIN never reaches the audit log', async () => {
  const t = await one(`select id from teams where event_id = $1 and number = 3`, [live.event_id]);
  const r = await cmd(live.token, null, 'reset_pin', { team_id: t.id });
  const fresh = r.result.event.pin;
  assert.match(fresh, /^\d{6}$/);
  await fails(call('join_team', 'LIVE1', 3, squads[3].pin, 'Old', true, true, null), 'BAD_PIN');
  const ok = await call('join_team', 'LIVE1', 3, fresh, 'New', true, true, null);
  assert.ok(ok.token);
  const audit = await all(`select args::text a from audit_log where event_id = $1 and action = 'reset_pin'`, [live.event_id]);
  assert.ok(audit.length && audit.every((x) => !x.a.includes(fresh)));
  squads[3].pin = fresh;
});

test('CSV import validates the whole file before writing anything', async () => {
  const before = (await one(`select count(*)::int n from teams where event_id = $1`, [live.event_id])).n;
  await fails(call('host_import_teams', live.token, [{ number: 40, pin: '482913' }, { number: 40, pin: '739120' }]), 'appears twice');
  await fails(call('host_import_teams', live.token, [{ number: 41, pin: '123456' }]), 'sequential');
  await fails(call('host_import_teams', live.token, [{ number: 41, pin: '7777' }]), 'repeated');
  await fails(call('host_import_teams', live.token, [{ number: 41, pin: '48a1' }]), '4–8 digits');
  await fails(call('host_import_teams', live.token, [{ number: 41, pin: '482913', map: 9 }]), 'map 9 does not exist');
  await fails(call('host_import_teams', live.token, [{ number: 'x' }]), 'squad number');
  assert.equal((await one(`select count(*)::int n from teams where event_id = $1`, [live.event_id])).n, before, 'nothing written');
  const trialImport = await call('host_import_teams', trial.token, [{ number: 1, name: 'Falcons', pin: '582039' }, { number: 2, name: '' }]);
  assert.equal(trialImport.imported, 2);
  assert.equal(trialImport.squads[0].pin, null, 'supplied PINs are never echoed');
  assert.match(trialImport.squads[1].pin, /^\d{6}$/, 'missing PINs are generated and shown once');
  assert.equal(trialImport.squads[1].name, 'Bravo-02');
});

test('Phase 0 starts with play; the public phase is visible to players and the projector', async () => {
  for (const n of [1, 2, 4, 16]) squads[n].tokens = await joinSquad('LIVE1', n, squads[n].pin, `S${n}`);
  for (const id of liveArenas) await toPlay(live.token, id);
  const a = await one(`select phase, match_phase from arenas where id = $1`, [liveArenas[0]]);
  assert.deepEqual(a, { phase: 'play', match_phase: 0 });
  const ps = await call('player_state', squads[1].tokens[0]);
  assert.equal(ps.arena.overlay.match.phase, 0);
  assert.equal(ps.arena.overlay.match.duel_phase, 2);
  const spec = (await one(`select spectator_token from arenas where id = $1`, [liveArenas[0]])).spectator_token;
  assert.equal((await call('spectator_state', spec)).arena.overlay.match.phase, 0);
});

test('phase changes drive zone contraction; zone_cancel holds it; phases cannot skip to the finale', async () => {
  const A = liveArenas[0];
  await cmd(live.token, A, 'set_phase', { phase: 1 });
  assert.equal((await one(`select zone_next_at from arenas where id = $1`, [A])).zone_next_at, null, 'Phase 1 keeps the full campus');
  await cmd(live.token, A, 'next_phase');
  let a = await one(`select match_phase, zone_next_at, zone_stage from arenas where id = $1`, [A]);
  assert.equal(a.match_phase, 2);
  assert.ok(a.zone_next_at, 'Phase 2 schedules the first contraction');
  await cmd(live.token, A, 'zone_cancel');
  await unthrottle(A); await call('player_state', squads[1].tokens[0]);
  assert.equal((await one(`select zone_next_at from arenas where id = $1`, [A])).zone_next_at, null, 'host hold is respected');
  await cmd(live.token, A, 'set_phase', { phase: 3 });
  // collapse due → next warning for the following stage until the phase target (3) is reached
  for (let i = 0; i < 6; i++) {
    await db.query(`update arenas set zone_next_at = now() - interval '1 second' where id = $1 and zone_next_at is not null`, [A]);
    await unthrottle(A);
    await call('player_state', squads[1].tokens[0]);
  }
  a = await one(`select zone_stage, zone_next_at from arenas where id = $1`, [A]);
  assert.equal(a.zone_stage, 3, 'Phase 3 contracts to stage 3 and stops');
  assert.equal(a.zone_next_at, null);
  const r = await cmd(live.token, A, 'set_phase', { phase: 5 });
  assert.equal(r.ok, false, 'the finale only starts through begin_finale');
  const pins = await all(`select location_id from teams where arena_id = $1 and ready`, [A]);
  const unsafe = await all(`select id from locations where id = any($1) and collapse_stage <= 3`, [pins.map((p) => p.location_id)]);
  assert.equal(unsafe.length, 0, 'every squad was evacuated to a safe, reachable location');
});

test('automatic pacing advances phases on schedule; pause/resume shifts the phase timer', async () => {
  const A = liveArenas[1];
  await call('host_settings', live.token, { auto_pacing: 1, phase_schedule: '1,2,3,4' });
  await cmd(live.token, A, 'set_phase', { phase: 0 });
  let a = await one(`select phase_next_at, overlay from arenas where id = $1`, [A]);
  assert.ok(a.phase_next_at, 'next phase time scheduled');
  assert.ok(a.overlay.match.next_at, 'and published to clients');
  await cmd(live.token, A, 'pause');
  await db.query(`update arenas set paused_at = paused_at - interval '40 seconds' where id = $1`, [A]);
  await cmd(live.token, A, 'resume');
  const b = await one(`select phase_next_at from arenas where id = $1`, [A]);
  assert.ok(new Date(b.phase_next_at) - new Date(a.phase_next_at) >= 39000, 'pause shifted the phase deadline');
  await db.query(`update arenas set phase_next_at = now() - interval '1 second', last_tick_at = null where id = $1`, [A]);
  await call('player_state', squads[16].tokens[0]);
  assert.equal((await one(`select match_phase from arenas where id = $1`, [A])).match_phase, 1);
  await call('host_settings', live.token, { auto_pacing: 0 });
});

test('mission timers scale with mission_time_pct', async () => {
  await call('host_settings', live.token, { mission_time_pct: 50 });
  const t = await one(`select id from teams where event_id = $1 and number = 16`, [live.event_id]);
  const tpl = await one(`select id, time_limit from mission_templates where kind = 'mission' and status = 'published' limit 1`);
  const r = await cmd(live.token, null, 'assign_mission', { team_id: t.id, template_id: tpl.id });
  const mi = await one(`select extract(epoch from deadline - started_at)::int s from mission_instances where id = $1`, [r.result.event.instance]);
  assert.ok(Math.abs(mi.s - tpl.time_limit / 2) <= 1);
  await call('host_settings', live.token, { mission_time_pct: 100 });
});

test('trial-only commands are rejected on a live event', async () => {
  for (const c of ['trial_skip', 'trial_bots', 'trial_reset']) {
    const r = await cmd(live.token, liveArenas[0], c, { seconds: 60, count: 1 });
    assert.equal(r.ok, false); assert.match(r.error, /TRIAL_ONLY/);
  }
  const ts = await call('host_trial_status', live.token);
  assert.equal(ts.is_trial, false);
});

test('trial: simulated squads join through join_team and play through the player RPCs', async () => {
  const r = await cmd(trial.token, trialArena, 'trial_bots', { count: 2 });
  const bots = r.result[trialArena].bots;
  assert.equal(bots.length, 2);
  assert.ok(bots.every((b) => b.tokens.length === 4));
  const st = await call('player_state', bots[0].tokens[0]);
  assert.equal(st.team.ready, true);
  assert.match(st.event.name, /^TRIAL/);
  await cmd(trial.token, trialArena, 'open_boarding');
  await cmd(trial.token, trialArena, 'drive');
  await cmd(trial.token, trialArena, 'trial_skip', { seconds: 20 });
  assert.equal((await one(`select phase from arenas where id = $1`, [trialArena])).phase, 'roles', 'fast-forward moved the server clock');
  // bots race for roles through claim_role
  const claims = await Promise.allSettled(bots[0].tokens.map((t) => call('claim_role', t, 'captain')));
  assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1, 'exactly one captain');
  await cmd(trial.token, trialArena, 'trial_skip', { seconds: 20 });
  const cap = (await Promise.all(bots[0].tokens.map((t) => call('player_state', t)))).find((s) => s.me.role === 'captain');
  assert.equal(cap.arena.phase, 'play');
  assert.equal(cap.arena.overlay.trial, true);
  const tok = bots[0].tokens.find((_, i) => i === 0);
  const mv = await call('captain_move', tok, 'fountain');
  assert.ok(mv.seconds > 0);
  await cmd(trial.token, trialArena, 'trial_skip', { seconds: 15 });
  const after = await call('player_state', tok);
  assert.equal(after.team.location, 'fountain');
  assert.ok(after.mission, 'arrival started a mission');
  const status = await call('host_trial_status', trial.token);
  assert.equal(status.is_trial, true);
  assert.equal(status.steps.shuttle, true);
  assert.equal(status.steps.movement, true);
});

test('trial reset returns the map to the lobby and phase 0', async () => {
  const r = await cmd(trial.token, trialArena, 'trial_reset');
  assert.equal(r.ok, true);
  const a = await one(`select phase, match_phase, zone_stage from arenas where id = $1`, [trialArena]);
  assert.deepEqual(a, { phase: 'lobby', match_phase: 0, zone_stage: 0 });
  assert.equal((await one(`select count(*)::int n from mission_instances where arena_id = $1`, [trialArena])).n, 0);
});

test('maps are isolated: no cross-map visibility, chat or attacks', async () => {
  const s1 = await call('player_state', squads[1].tokens[0]);
  assert.ok(!s1.squads.some((x) => x.number === 16), 'Map 1 never lists Map 2 squads');
  const caps = await all(`select p.session_hash, p.team_id from players p join teams t on t.id = p.team_id where t.number = 1 and t.event_id = $1 and p.role = 'captain'`, [live.event_id]);
  const capTok = (await Promise.all(squads[1].tokens.map(async (t) => ({ t, s: await call('player_state', t) })))).find((x) => x.s.me.role === 'captain').t;
  await fails(call('captain_chat', capTok, 16, 'hello other map'), 'BAD_TARGET');
  const t16 = await one(`select id from teams where event_id = $1 and number = 16`, [live.event_id]);
  await fails(call('captain_attack', capTok, t16.id, 'pistol'), 'BAD_TARGET|NOT_IN_PLAY|TARGET_UNAVAILABLE|NOT_IN_RANGE');
  assert.ok(caps.length === 1);
});

test('every map plays the same finale challenge (fair grand champion)', async () => {
  for (const id of liveArenas) {
    await db.query(`update arenas set paused = false where id = $1`, [id]);
    await cmd(live.token, id, 'begin_finale');
  }
  const r = await cmd(live.token, null, 'launch_sync', { kind: 'finale_entry' });
  const tpls = Object.values(r.result).map((x) => x.template);
  assert.equal(tpls.length, 2);
  assert.equal(tpls[0], tpls[1]);
  assert.equal((await one(`select match_phase from arenas where id = $1`, [liveArenas[0]])).match_phase, 5);
});

test('browser key can call the new API but not the new internals', async () => {
  await db.exec('set role anon');
  try {
    for (const f of ['_set_match_phase', '_shift_arena', '_host_exec_p0', '_new_pin']) {
      const r = await db.query(`select has_function_privilege('anon', p.oid, 'execute') ok from pg_proc p where proname = $1`, [f]);
      assert.equal(r.rows[0].ok, false, f);
    }
    for (const f of ['host_roster', 'host_create_trial', 'host_trial_status']) {
      const r = await db.query(`select has_function_privilege('anon', p.oid, 'execute') ok from pg_proc p where proname = $1`, [f]);
      assert.equal(r.rows[0].ok, true, f);
    }
    await fails(db.query(`select * from arenas`), 'permission denied');
  } finally { await db.exec('reset role'); }
});
