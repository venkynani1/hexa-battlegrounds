// Open-world tests: joystick steering with a server speed cap, distance-based auto-run,
// location areas, duel range, red zones, and starting a map with fewer than 15 squads.
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
const cmd = async (tok, arena, c, args = {}, reason = null) => call('host_command', tok, arena, c, args, reason);
const tick = (id) => one('select _tick($1, true)', [id]);

let ev, arena, empty;
const sq = {};

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  ev = await call('host_create_event', 'WORLD', 'World', 'worldpass1', 2);
  [arena, empty] = (await db.query(`select id from arenas where event_id = $1 order by number`, [ev.event_id])).rows.map((r) => r.id);
  const pins = await call('host_generate_teams', ev.token, 2); // only two squads on a 15-squad map
  for (const p of pins) {
    const toks = [];
    for (const n of ['A', 'B', 'C', 'D']) toks.push((await call('join_team', 'WORLD', p.number, p.pin, `${p.number}${n}`, true, true, null)).token);
    const team = await one(`select id from teams where event_id = $1 and number = $2`, [ev.event_id, p.number]);
    sq[p.number] = { id: team.id, tokens: toks };
  }
});

test('an empty map cannot start; a map with 2 of 15 squads can', async () => {
  const r = await cmd(ev.token, empty, 'open_boarding');
  assert.equal(r.ok, false);
  assert.match(r.error, /NO_READY_SQUADS/);
  await cmd(ev.token, arena, 'open_boarding');
  await cmd(ev.token, arena, 'drive');
  await cmd(ev.token, arena, 'finalize_roles');
  await db.query('update arenas set last_tick_at = null where id = $1', [arena]);
  await cmd(ev.token, arena, 'finalize_roles');
  assert.equal((await one(`select phase from arenas where id = $1`, [arena])).phase, 'play');
  for (const n of [1, 2]) {
    for (const t of sq[n].tokens) {
      const st = await call('player_state', t);
      if (st.me.role === 'captain') sq[n].captain = t;
      if (st.me.role === 'scout') sq[n].scout = t;
    }
    assert.ok(sq[n].captain && sq[n].scout);
  }
  const st = await call('player_state', sq[1].scout);
  assert.ok(st.team.pos && st.team.pos.length === 2, 'squads have a position');
  assert.ok(st.arena.overlay.zone && st.arena.overlay.world, 'zone and world settings are public');
});

test('joystick: only the captain steers; the server caps speed so nobody can teleport', async () => {
  await fails(call('captain_steer', sq[1].scout, 0.5, 0.5), 'NOT_CAPTAIN');
  await db.query(`update teams set pos_x = 0.5, pos_y = 0.5, pos_at = now() - interval '1 second', location_id = null, dropped = true where id = $1`, [sq[1].id]);
  const r = await call('captain_steer', sq[1].captain, 0.95, 0.5); // asks to jump almost half the campus
  assert.equal(r.clamped, true);
  assert.ok(r.x - 0.5 < 0.04, `moved ${r.x - 0.5} in ~1 s`);
  // a long idle never banks a teleport either (capped at a few seconds of running)
  await db.query(`update teams set pos_at = now() - interval '10 minutes' where id = $1`, [sq[1].id]);
  const r2 = await call('captain_steer', sq[1].captain, 0.05, 0.05);
  assert.ok(Math.hypot(r2.x - r.x, r2.y - r.y) < 0.13);
  await fails(call('captain_steer', sq[1].captain, 'NaN', 0.5), 'BAD_REQUEST');
});

test('walking into a location area puts the squad there; search needs an area', async () => {
  const fountain = await one(`select x, y from locations where id = 'fountain'`);
  await db.query(`update teams set pos_x = $2, pos_y = $3 + 0.03, pos_at = now() - interval '2 seconds', location_id = null where id = $1`, [sq[1].id, fountain.x, fountain.y]);
  await fails(call('captain_explore', sq[1].captain), 'NOT_AT_LOCATION');
  const r = await call('captain_steer', sq[1].captain, fountain.x, fountain.y);
  assert.equal(r.location, 'fountain');
  const ex = await call('captain_explore', sq[1].captain);
  assert.ok(ex.instance);
  // walking out of the area ends that search without a penalty
  await db.query(`update teams set pos_x = $2 + 0.034, pos_at = now() - interval '2 seconds' where id = $1`, [sq[1].id, fountain.x]);
  await call('captain_steer', sq[1].captain, fountain.x + 0.08, fountain.y);
  assert.equal((await one(`select status from mission_instances where id = $1`, [ex.instance])).status, 'cancelled');
});

test('tap-to-travel: time grows with distance; position is interpolated en route', async () => {
  const tr = await one(`select x, y from locations where id = 'tr14'`);
  await db.query(`update teams set pos_x = $2, pos_y = $3, location_id = null, state = 'idle' where id = $1`, [sq[1].id, tr.x - 0.1, tr.y]);
  const near = await call('captain_move', sq[1].captain, 'tr14');
  await db.query(`update teams set state = 'idle', travel_to = null, pos_x = 0.05, pos_y = 0.05 where id = $1`, [sq[1].id]);
  const far = await call('captain_move', sq[1].captain, 'tr14');
  assert.ok(Number(far.seconds) > Number(near.seconds) * 3, `${far.seconds} vs ${near.seconds}`);
  await db.query(`update teams set travel_started_at = now() - (travel_arrive_at - travel_started_at) / 2 where id = $1`, [sq[1].id]);
  const mid = (await call('player_state', sq[1].scout)).team.pos;
  assert.ok(mid[0] > 0.1 && mid[0] < tr.x, 'half way there');
  await db.query(`update teams set travel_arrive_at = now() - interval '1 second' where id = $1`, [sq[1].id]);
  await tick(arena);
  const t = await one(`select location_id, pos_x, pos_y, state from teams where id = $1`, [sq[1].id]);
  assert.equal(t.location_id, 'tr14');
  assert.equal(t.state, 'idle');
  assert.ok(Math.abs(t.pos_x - tr.x) < 1e-6);
});

test('duels need the squads within engage range', async () => {
  await cmd(ev.token, arena, 'set_phase', { phase: 2 });
  await cmd(ev.token, arena, 'zone_cancel');
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  await db.query(`update teams set state = 'idle', location_id = null, protected_until = null, attack_cooldown_until = null, pos_x = 0.3, pos_y = 0.3 where id = $1`, [sq[1].id]);
  await db.query(`update teams set state = 'idle', location_id = null, protected_until = null, attack_cooldown_until = null, pos_x = 0.6, pos_y = 0.3 where id = $1`, [sq[2].id]);
  await fails(call('captain_attack', sq[1].captain, sq[2].id, 'pistol'), 'NOT_IN_RANGE');
  await db.query(`update teams set pos_x = 0.34 where id = $1`, [sq[2].id]);
  const b = await call('captain_attack', sq[1].captain, sq[2].id, 'pistol');
  const row = await one(`select x, y from battles where id = $1`, [b.battle]);
  assert.ok(Math.abs(row.x - 0.32) < 1e-6, 'the duel is placed between the squads');
  await db.query(`update battles set deadline = now() - interval '1 second' where status = 'active'`);
  await tick(arena);
});

test('red zone: warned first, then squads inside take damage once', async () => {
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  await db.query(`update teams set hp = 100, shield = 0, state = 'idle', pos_x = 0.3, pos_y = 0.3 where id = $1`, [sq[1].id]);
  await db.query(`update teams set hp = 100, shield = 0, state = 'idle', pos_x = 0.8, pos_y = 0.8 where id = $1`, [sq[2].id]);
  const r = await cmd(ev.token, arena, 'red_zone', { x: 0.3, y: 0.3 });
  assert.equal(r.ok, true);
  const again = await cmd(ev.token, arena, 'red_zone', { x: 0.5, y: 0.5 });
  assert.match(again.error, /RED_ZONE_ACTIVE/);
  const st = await call('player_state', sq[2].scout);
  assert.ok(st.arena.overlay.red && st.arena.overlay.red.at, 'everyone sees the warning');
  await tick(arena);
  assert.equal((await one(`select hp from teams where id = $1`, [sq[1].id])).hp, 100, 'nothing before the strike');
  await db.query(`update arenas set red_at = now() - interval '1 second' where id = $1`, [arena]);
  await tick(arena);
  assert.equal((await one(`select hp from teams where id = $1`, [sq[1].id])).hp, 70);
  assert.equal((await one(`select hp from teams where id = $1`, [sq[2].id])).hp, 100, 'outside the blast');
  const a = await one(`select red_at, overlay from arenas where id = $1`, [arena]);
  assert.equal(a.red_at, null);
  assert.equal(a.overlay.red, undefined);
  // host can cancel a warning
  await cmd(ev.token, arena, 'red_zone', {});
  await cmd(ev.token, arena, 'red_cancel');
  assert.equal((await one(`select red_at from arenas where id = $1`, [arena])).red_at, null);
});

test('hints are free; revealing an answer box shows it to the captain only and costs points once', async () => {
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  await db.query(`update teams set state = 'idle', hp = 100, points = 500 where id = $1`, [sq[1].id]);
  const inst = (await one(`select _start_instance($1, 'mission-riddle-0', 'fountain') id`, [sq[1].id])).id;
  const h = await call('captain_hint', sq[1].captain, inst);
  assert.ok(h.hint);
  assert.equal((await one(`select points, coins from teams where id = $1`, [sq[1].id])).points, 500, 'hint is free');
  let st = await call('player_state', sq[1].captain);
  const cost = st.mission.reveal_cost;
  assert.ok(cost > 0 && cost < 100);
  await fails(call('captain_reveal', sq[1].scout, inst, 0), 'NOT_CAPTAIN');
  const r = await call('captain_reveal', sq[1].captain, inst, 1);
  const parts = (await one(`select parts from mission_templates where id = 'mission-riddle-0'`)).parts;
  assert.equal(r.answer, parts[1].accept[0]);
  assert.equal((await one(`select points from teams where id = $1`, [sq[1].id])).points, 500 - cost);
  const again = await call('captain_reveal', sq[1].captain, inst, 1);
  assert.equal(again.cost, 0, 'revealing the same box twice is free');
  assert.equal((await one(`select points from teams where id = $1`, [sq[1].id])).points, 500 - cost);
  st = await call('player_state', sq[1].captain);
  assert.equal(st.mission.revealed['1'], parts[1].accept[0]);
  const scout = await call('player_state', sq[1].scout);
  assert.equal(scout.mission.revealed, undefined, 'teammates never receive answers');
  // solving still pays the mission reward (no 20 % hint cut any more)
  const answers = parts.map((p) => p.accept[0]);
  const res = await call('captain_submit', sq[1].captain, inst, answers, 'idem-reveal-1');
  assert.equal(res.correct, true);
  assert.equal(res.points, 100);
});
