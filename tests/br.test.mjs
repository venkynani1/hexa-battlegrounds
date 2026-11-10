// v6: Free Fire zone, buggy and on foot, live gunfights, airport check-in and plane jump.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let db;
const MIG = new URL(process.env.SQL_DIR || '../supabase/migrations/', import.meta.url);
async function call(fn, ...args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query(`select ${fn}(${ph}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  return r.rows[0].r;
}
async function fails(p, code) {
  try { await p; } catch (e) { assert.match(String(e.message), new RegExp(code)); return; }
  assert.fail(`expected ${code}`);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
let host; let arena; const sq = {};
const cmd = (c, args = {}) => call('host_command', host, arena, c, args, null);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  host = (await call('host_create_event', 'FLY26', 'Flight', 'flightpass', 2)).token;
  await call('host_fixed_cards', host, 'flightpass');
  arena = (await call('host_overview', host)).arenas[0].id;
});

test('check-in: map number + squad PIN finds the squad; wrong PINs lock the map out after many tries', async () => {
  const cards = await call('host_fixed_cards', host, 'flightpass');
  for (const n of [1, 2, 3]) {
    sq[n] = { tokens: [] };
    for (const nm of ['Asha', 'Ben', 'Chen']) {
      const j = await call('join_flight', 'fly26', 1, cards.squads[n - 1].pin, nm + n, true, true, null);
      assert.ok(j.token, JSON.stringify(j)); sq[n].tokens.push(j.token);
    }
    sq[n].id = (await one(`select id from teams where number = $1 and event_id = (select id from events where code = 'FLY26')`, [n])).id;
  }
  // map 2 has squads 16..30: squad 1's PIN does not work there
  assert.equal((await call('join_flight', 'FLY26', 2, cards.squads[0].pin, 'Dev', true, true, null)).error, 'BAD_PIN');
  assert.equal((await call('join_flight', 'FLY26', 3, cards.squads[0].pin, 'Dev', true, true, null)).error, 'BAD_MAP');
  const st = await call('player_state', sq[1].tokens[1]);
  assert.equal(st.team.number, 1);
  assert.match(st.me.seat, /^01[A-F]$/);
  for (let i = 0; i < 29; i++) await call('join_flight', 'FLY26', 2, '000000', 'X', true, true, null);
  await fails(call('join_flight', 'FLY26', 2, cards.squads[15].pin, 'Late', true, true, null), 'LOCKED_OUT');
  assert.ok((await call('join_flight', 'FLY26', 1, cards.squads[3].pin, 'Other map ok', true, true, null)).token, 'a lock-out on map 2 does not block map 1');
});

test('take-off: roles are handed out automatically, one captain per squad, nobody picks', async () => {
  await db.query(`update teams set ready = true where arena_id = $1`, [arena]);
  await db.query(`update arenas set phase = 'shuttle', shuttle_arrive_at = now() + interval '40 seconds' where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  for (const n of [1, 2, 3]) {
    const roles = (await db.query(`select role from players where team_id = $1 and active order by role`, [sq[n].id])).rows.map((r) => r.role);
    assert.deepEqual(roles, ['captain', 'decoder', 'scout']);
  }
  const ov = (await one(`select overlay from arenas where id = $1`, [arena])).overlay;
  assert.ok(ov.flight?.t0 && ov.flight?.t1, 'the cabin view knows when the plane lands');
});

const captain = async (n) => {
  for (const t of sq[n].tokens) if ((await call('player_state', t)).me.role === 'captain') return t;
};

test('the plane: jump only while it is over the campus and within gliding range; land on foot; buggy waits in a parking bay', async () => {
  await db.query(`update arenas set phase = 'roles', roles_deadline = now() where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  const a = await one(`select phase, plane_ax, plane_t0, overlay from arenas where id = $1`, [arena]);
  assert.equal(a.phase, 'play');
  assert.ok(a.overlay.plane?.a && a.overlay.plane?.b, 'the plane path is published');
  const c1 = await captain(1);
  await fails(call('captain_steer', c1, 0.5, 0.5, 0, 0), 'JUMP_FIRST');
  // the plane has just entered the sky far outside the campus
  await fails(call('captain_move', c1, 'fountain'), 'NOT_OVER_CAMPUS');
  // put it right over the fountain (half-way along a path through it)
  await db.query(`update arenas set plane_ax = 0.47 - 0.6, plane_ay = 0.585, plane_bx = 0.47 + 0.6, plane_by = 0.585,
    plane_t0 = now() - interval '27 seconds', plane_t1 = now() + interval '27 seconds' where id = $1`, [arena]);
  await fails(call('captain_move', c1, 'park_se'), 'TOO_FAR_TO_GLIDE');
  const j = await call('captain_move', c1, 'fountain');
  assert.equal(j.jump, true);
  assert.equal((await call('player_state', sq[1].tokens[0])).team.parachute, true);
  await db.query(`update teams set travel_arrive_at = now() - interval '1 second' where id = $1`, [sq[1].id]);
  await db.query('select _tick($1, true)', [arena]);
  const t = await one(`select dropped, vehicle, buggy_x, buggy_y, pos_x, pos_y from teams where id = $1`, [sq[1].id]);
  assert.equal(t.dropped, true);
  assert.equal(t.vehicle, 'none', 'squads land on foot');
  assert.ok((t.buggy_y > 0.82 && t.buggy_y < 0.96) || (t.buggy_x > 0.69 && t.buggy_x < 0.77 && t.buggy_y > 0.36 && t.buggy_y < 0.44), 'the buggy waits in a parking yard');
  assert.ok(Math.abs(t.pos_x - 0.47) < 0.01);
  // squads 2 and 3 never jumped: the plane leaving the campus pushes them out
  await db.query(`update arenas set plane_t0 = now() - interval '50 seconds', plane_t1 = now() + interval '5 seconds' where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  assert.equal(Number((await one(`select count(*) n from teams where arena_id = $1 and number in (2, 3) and state = 'traveling'`, [arena])).n), 2);
});

test('on foot vs buggy: walking is slower; get in only next to your buggy; a buggy cannot drive into a building', async () => {
  const c1 = await captain(1);
  await db.query(`update teams set pos_at = now() - interval '2 seconds' where id = $1`, [sq[1].id]);
  const s0 = await one(`select pos_x, pos_y from teams where id = $1`, [sq[1].id]);
  const r = await call('captain_steer', c1, s0.pos_x + 0.2, s0.pos_y, 0, 0);
  assert.ok(r.x - s0.pos_x < 0.006 * 2 * 1.3 + 0.004, `on foot: ${r.x - s0.pos_x}`);
  await fails(call('captain_vehicle', c1, true), 'BUGGY_TOO_FAR');
  // walk to the bay (teleported for the test) and get in
  await db.query(`update teams set pos_x = buggy_x + 0.003, pos_y = buggy_y, pos_at = now() where id = $1`, [sq[1].id]);
  assert.equal((await call('captain_vehicle', c1, true)).vehicle, 'in');
  assert.equal(Number((await one(`select count(*) n from game_feed where type = 'squad.buggy'`)).n), 1);
  await db.query(`update teams set pos_at = now() - interval '2 seconds' where id = $1`, [sq[1].id]);
  const s1 = await one(`select pos_x, pos_y from teams where id = $1`, [sq[1].id]);
  const r2 = await call('captain_steer', c1, s1.pos_x, s1.pos_y - 0.2, 0, -0.016);
  assert.ok(s1.pos_y - r2.y > 0.03, `driving is fast: ${s1.pos_y - r2.y}`);
  // drive at Hexavarsity: the buggy stops at the wall and the captain gets out
  const b = await one(`select * from buildings where id = 'hexavarsity'`);
  await db.query(`update teams set pos_x = $2, pos_y = $3, pos_at = now() - interval '1 second' where id = $1`, [sq[1].id, (b.x0 + b.x1) / 2, b.y1 + 0.004]);
  const r3 = await call('captain_steer', c1, (b.x0 + b.x1) / 2, b.y1 - 0.01, 0, 0);
  assert.equal(r3.parked, true);
  assert.equal(r3.vehicle, 'parked');
  await db.query(`update teams set pos_at = now() - interval '2 seconds' where id = $1`, [sq[1].id]);
  const r4 = await call('captain_steer', c1, (b.x0 + b.x1) / 2, b.y1 - 0.01, 0, 0);
  assert.ok(r4.y < b.y1, 'on foot you walk in');
  const st = await call('player_state', sq[1].tokens[1]);
  assert.equal(st.team.vehicle, 'parked');
  assert.ok(Math.abs(st.team.buggy[1] - (b.y1 + 0.004)) < 0.002, 'teammates see where the buggy is parked');
});

test('gunfights: in range and in sight, fire rate, magazine, damage, cover, knock-out rewards', async () => {
  await cmd('set_phase', { phase: 2 });
  for (const n of [2, 3]) await db.query(`update teams set dropped = true, state = 'idle', travel_to = null, travel_arrive_at = null where id = $1`, [sq[n].id]);
  await db.query(`update teams set pos_x = 0.40, pos_y = 0.60, pos_at = now(), level = 0, bldg = null, protected_until = null, hp = 100, shield = 0, vehicle = 'parked' where id = $1`, [sq[1].id]);
  await db.query(`update teams set pos_x = 0.43, pos_y = 0.60, pos_at = now() - interval '10 seconds', level = 0, bldg = null, protected_until = null, hp = 9, shield = 0, coins = 90 where id = $1`, [sq[2].id]);
  await db.query(`update teams set pos_x = 0.40, pos_y = 0.75, pos_at = now(), level = 0, bldg = null, protected_until = null where id = $1`, [sq[3].id]);
  const shooter = sq[1].tokens[2];
  await fails(call('squad_fire', shooter, sq[3].id), 'OUT_OF_RANGE');
  let hits = 0; let knocked = false; let tries = 0;
  while (!knocked && tries < 40) {
    tries++;
    await db.query(`update players set shot_at = null, reload_until = null where team_id = $1`, [sq[1].id]);
    const r = await call('squad_fire', shooter, sq[2].id);
    if (r.hit) hits++;
    knocked = r.knocked;
  }
  assert.ok(knocked, 'the target is knocked out at 0 HP');
  await fails(call('squad_fire', shooter, sq[2].id), 'TARGET_DOWN');
  const t1 = await one(`select kills, points, coins from teams where id = $1`, [sq[1].id]);
  assert.equal(t1.kills, 1);
  assert.equal((await one(`select state from teams where id = $1`, [sq[2].id])).state, 'recovery');
  assert.ok(Number((await one(`select count(*) n from game_feed where type = 'squad.knocked'`)).n) >= 1);
  // fire rate is enforced per player
  await db.query(`update teams set pos_x = 0.43, pos_y = 0.62, state = 'idle', hp = 100, protected_until = null where id = $1`, [sq[3].id]);
  await db.query(`update players set shot_at = null, reload_until = null, mag = null where team_id = $1`, [sq[1].id]);
  await call('squad_fire', shooter, sq[3].id);
  await fails(call('squad_fire', shooter, sq[3].id), 'TOO_FAST');
  // another squad member can shoot at the same time
  await call('squad_fire', sq[1].tokens[0], sq[3].id);
  // magazine: after 12 pistol shots, reload
  await db.query(`update players set mag = 1, shot_at = null where team_id = $1`, [sq[1].id]);
  const last = await call('squad_fire', shooter, sq[3].id);
  assert.ok(last.reload_until, 'empty magazine → reload');
  await db.query(`update players set shot_at = null where team_id = $1`, [sq[1].id]);
  await fails(call('squad_fire', shooter, sq[3].id), 'RELOADING');
  // cover: a building between the squads blocks the shot
  const b = await one(`select * from buildings where id = 'hexavarsity'`);
  await db.query(`update players set shot_at = null, reload_until = null where team_id = $1`, [sq[1].id]);
  await db.query(`update teams set pos_x = $2, pos_y = $3 where id = $1`, [sq[1].id, b.x0 - 0.006, (b.y0 + b.y1) / 2]);
  await db.query(`update teams set pos_x = $2, pos_y = $3 where id = $1`, [sq[3].id, b.x0 + 0.03, (b.y0 + b.y1) / 2 + 0.0]);
  await db.query(`update teams set pos_x = $2 where id = $1`, [sq[3].id, Math.min(b.x1 + 0.006, b.x0 + 0.05)]);
  const blocked = await one(`select _blocked($1, $2, $3, $4) b`, [b.x0 - 0.006, (b.y0 + b.y1) / 2, b.x1 + 0.006, (b.y0 + b.y1) / 2]);
  assert.equal(blocked.b, true);
  // the earlier phases are safe
  await cmd('set_phase', { phase: 0 });
  await db.query(`update teams set pos_x = 0.40, pos_y = 0.60 where id = $1`, [sq[1].id]);
  await db.query(`update teams set pos_x = 0.42, pos_y = 0.60 where id = $1`, [sq[3].id]);
  await fails(call('squad_fire', shooter, sq[3].id), 'NO_FIGHTS_YET');
});

test('zone like Free Fire: white circle first, then the wall closes in smoothly; damage grows with the stage', async () => {
  await cmd('set_phase', { phase: 3 });
  await db.query(`update arenas set zone_next_at = now() - interval '1 second' where id = $1 and zone_next_at is not null`, [arena]);
  await db.query(`update arenas set last_tick_at = null where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  const a = await one(`select zone_stage, zone_shrink_from, zone_shrink_until, overlay from arenas where id = $1`, [arena]);
  assert.equal(a.zone_stage, 1);
  assert.ok(a.zone_shrink_until > a.zone_shrink_from, 'the wall is moving');
  assert.ok(a.overlay.zone.prev && a.overlay.zone.shrink_until, 'screens get the start and end circles to animate');
  // half-way: the circle is between the two
  await db.query(`update arenas set zone_shrink_from = now() - interval '20 seconds', zone_shrink_until = now() + interval '20 seconds' where id = $1`, [arena]);
  const z = await one(`select _zone_now($1) now, _zone_circle(event_id, 0) c0, _zone_circle(event_id, 1) c1 from arenas where id = $1`, [arena]);
  assert.ok(z.now[2] < z.c0[2] && z.now[2] > z.c1[2], `radius ${z.now[2]} between ${z.c1[2]} and ${z.c0[2]}`);
  // no new warning while the wall moves
  await db.query(`update arenas set last_tick_at = null where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  assert.equal((await one(`select zone_next_at from arenas where id = $1`, [arena])).zone_next_at, null);
  const ev = (await one(`select event_id from arenas where id = $1`, [arena])).event_id;
  const d = (await one(`select _zone_dmg($1, 1) a, _zone_dmg($1, 3) b, _zone_dmg($1, 5) c`, [ev]));
  assert.ok(d.a < d.b && d.b < d.c, 'damage outside grows every stage');
});

test('positions feed carries what the screens draw: on foot, buggy, parachute, HP, fights', async () => {
  const p = await call('arena_positions', sq[1].tokens[0]);
  const me = p.squads.find((s) => s.n === 1);
  assert.ok(me && 'veh' in me && 'hp' in me && 'chute' in me && 'plane' in me);
  for (const f of ['captain_vehicle(text, boolean)', 'squad_fire(text, uuid)', 'join_flight(text, integer, text, text, boolean, boolean, text)']) {
    assert.equal((await one(`select has_function_privilege('anon', $1, 'execute') ok`, [f])).ok, true, f);
  }
  for (const f of ['_player_state_v5(text)', '_spectator_state_v5(text)', '_br_step(uuid)', '_do_jump(uuid, text, double precision[])', '_auto_roles(uuid)']) {
    assert.equal((await one(`select has_function_privilege('anon', $1, 'execute') ok`, [f])).ok, false, f);
  }
});
