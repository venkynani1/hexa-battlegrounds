// v5: fixed squad cards (same PINs and QR codes every time) and demo mode with dummy squads.
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
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
});

test('fixed cards: the same host password gives the same PINs and card set in every event', async () => {
  const a = await call('host_create_event', 'CARDA', 'First', 'same-password', 3);
  const b = await call('host_create_event', 'CARDB', 'Second', 'same-password', 3);
  const ca = await call('host_fixed_cards', a.token, 'same-password');
  const cb = await call('host_fixed_cards', b.token, 'same-password');
  assert.equal(ca.squads.length, 45);
  assert.equal(ca.created, 45);
  assert.equal(ca.set, cb.set);
  assert.deepEqual(ca.squads.map((s) => s.pin), cb.squads.map((s) => s.pin));
  assert.deepEqual([ca.squads[0].map, ca.squads[14].map, ca.squads[15].map, ca.squads[44].map], [1, 1, 2, 3]);
  for (const s of ca.squads) assert.match(s.pin, /^\d{6}$/);
  assert.ok(new Set(ca.squads.map((s) => s.pin)).size >= 44, 'PINs differ from squad to squad');
  // asking again changes nothing
  const again = await call('host_fixed_cards', a.token, 'same-password');
  assert.equal(again.created, 0);
  assert.deepEqual(again.squads.map((s) => s.pin), ca.squads.map((s) => s.pin));
});

test('fixed cards: the PIN lets players in, a different password gives different cards, a wrong one is refused', async () => {
  const a = await call('host_login', 'CARDA', 'same-password');
  const cards = await call('host_fixed_cards', a.token, 'same-password');
  const j = await call('join_team', 'CARDA', 7, cards.squads[6].pin, 'Asha', true, true, null);
  assert.ok(j.token);
  assert.equal((await call('join_team', 'CARDA', 8, cards.squads[6].pin, 'Ben', true, true, null)).error, 'BAD_PIN');
  assert.equal((await call('host_fixed_cards', a.token, 'not-the-password')).error, 'HOST_AUTH');
  const c = await call('host_create_event', 'CARDC', 'Other host', 'another-password', 1);
  const cc = await call('host_fixed_cards', c.token, 'another-password');
  assert.notEqual(cc.set, cards.set);
  assert.notDeepEqual(cc.squads.map((s) => s.pin), cards.squads.slice(0, 15).map((s) => s.pin));
  // a squad that already has players keeps them when the cards are applied again
  await call('host_fixed_cards', a.token, 'same-password');
  assert.equal(Number((await one(`select count(*) n from players p join teams t on t.id = p.team_id join events e on e.id = t.event_id where e.code = 'CARDA' and t.number = 7`)).n), 1);
});

test('fixed cards: the QR code finds the newest event that uses the card set; nothing secret is stored or logged', async () => {
  const a = await call('host_login', 'CARDA', 'same-password');
  const set = (await call('host_extras', a.token)).card_set;
  assert.equal((await call('card_event', set)).code, 'CARDB');
  assert.equal(await call('card_event', 'ffffffffff'), null);
  const cards = await call('host_fixed_cards', a.token, 'same-password');
  const dump = JSON.stringify(await all(`select args from audit_log`)) + JSON.stringify(await all(`select pin_hash, pin_salt from teams`));
  assert.ok(!dump.includes(cards.squads[0].pin + '"'), 'no PIN in the audit log');
  assert.ok(!dump.includes('same-password'));
});

let demo; let arena; const squads = {};
// run the game clock as if `secs` seconds passed between ticks
async function run(ticks, secs = 3) {
  for (let i = 0; i < ticks; i++) {
    await db.query(`update bot_clock set at = at - make_interval(secs => $2) where arena_id = $1`, [arena, secs]);
    await db.query(`update teams set pos_at = pos_at - make_interval(secs => $2) where arena_id = $1 and pos_at is not null`, [arena, secs]);
    await db.query(`update bots set think_until = think_until - make_interval(secs => $2), wait_until = wait_until - make_interval(secs => $2) where arena_id = $1`, [arena, secs * 4]);
    await db.query(`update teams set travel_arrive_at = now() where arena_id = $1 and state = 'traveling'`, [arena]);
    await db.query(`update arenas set last_tick_at = null where id = $1`, [arena]);
    await db.query('select _tick($1, true)', [arena]);
  }
}

test('demo: one call creates a match of dummy squads and starts it', async () => {
  demo = await call('demo_create', 1, 6, 'quick');
  assert.match(demo.code, /^DEMO[A-Z0-9]{4}$/);
  const x = await call('host_extras', demo.token);
  assert.equal(x.demo, true);
  assert.equal(x.bots.length, 6);
  assert.equal(x.maps.length, 1);
  arena = x.maps[0].id;
  const t = await all(`select t.id, t.number, t.is_bot, t.ready, (select count(*) from players p where p.team_id = t.id) n from teams t where t.arena_id = $1 order by number`, [arena]);
  assert.ok(t.every((r) => r.is_bot && r.ready && Number(r.n) === 4));
  for (const r of t) squads[r.number] = r.id;
  assert.equal((await one(`select autopilot from arenas where id = $1`, [arena])).autopilot, true);
  await fails(call('demo_view', (await call('host_login', 'CARDA', 'same-password')).token, 1, 'captain'), 'NOT_DEMO');
});

test('demo: the game hands out roles at take-off, dummies jump from the plane and a host can open any dummy phone', async () => {
  await db.query(`update arenas set phase = 'shuttle', shuttle_arrive_at = now() + interval '30 seconds' where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  assert.equal(Number((await one(`select count(*) n from players p join teams t on t.id = p.team_id where t.arena_id = $1 and p.role is not null`, [arena])).n), 24);
  assert.equal(Number((await one(`select count(*) n from players p join teams t on t.id = p.team_id where t.arena_id = $1 and p.role = 'captain'`, [arena])).n), 6);
  await db.query(`update arenas set phase = 'roles', roles_deadline = now() + interval '30 seconds', shuttle_arrive_at = now() where id = $1`, [arena]);
  await db.query(`update arenas set roles_deadline = now(), last_tick_at = null where id = $1`, [arena]);
  await db.query('select _tick($1, true)', [arena]);
  assert.equal((await one(`select phase from arenas where id = $1`, [arena])).phase, 'play');
  await db.query(`update arenas set zone_hold = true where id = $1`, [arena]);
  for (const role of ['captain', 'scout', 'decoder', 'intel']) {
    const v = await call('demo_view', demo.token, 2, role);
    const st = await call('player_state', v.token);
    assert.equal(st.me.role, role);
    assert.equal(st.team.number, 2);
    const ds = await call('demo_status', v.token);
    assert.deepEqual([ds.demo, ds.bot, ds.manual, ds.squad], [true, true, false, 2]);
  }
  // the plane is over the campus: dummies jump at different moments and land on foot
  const pl = await one(`select plane_t0, plane_t1 from arenas where id = $1`, [arena]);
  assert.ok(pl.plane_t0 && pl.plane_t1, 'the plane took off');
  await db.query(`update arenas set plane_t0 = now() - interval '24 seconds', plane_t1 = now() + interval '31 seconds' where id = $1`, [arena]);
  await run(30);
  assert.equal(Number((await one(`select count(*) n from teams where arena_id = $1 and dropped`, [arena])).n), 6);
  const landed = await all(`select vehicle, buggy_x from teams where arena_id = $1`, [arena]);
  assert.ok(landed.every((r) => r.buggy_x !== null), 'every squad has a buggy waiting in a parking yard');
});

test('demo: dummies drive, search, solve challenges and score through the normal game rules', async () => {
  await run(120);
  const r = await one(`select sum(missions_completed) solved, sum(points) pts, count(*) filter (where dropped) dropped from teams where arena_id = $1`, [arena]);
  assert.equal(Number(r.dropped), 6);
  assert.ok(Number(r.solved) >= 6, `missions solved: ${r.solved}`);
  assert.ok(Number(r.pts) > 0);
  const sub = await one(`select count(*) n, count(*) filter (where correct) ok from submissions s join teams t on t.id = s.team_id where t.arena_id = $1`, [arena]);
  assert.ok(Number(sub.ok) >= 6 && Number(sub.n) >= Number(sub.ok), 'answers go through captain_submit');
  const moved = await one(`select count(distinct location_id) n from mission_instances where arena_id = $1`, [arena]);
  assert.ok(Number(moved.n) >= 4, 'squads spread over several places');
  assert.ok(Number((await one(`select count(*) n from teams where arena_id = $1 and vehicle <> 'none'`, [arena])).n) >= 3, 'dummies walked to their buggies and drove off');
});

test('demo: a squad can be taken over (its dummy stops) and handed back', async () => {
  const cap = (await call('demo_view', demo.token, 3, 'captain')).token;
  assert.equal((await call('demo_control', cap, true)).manual, true);
  assert.equal((await call('demo_status', cap)).bot, false);
  await db.query(`update mission_instances set status = 'cancelled' where team_id = $1 and status = 'active'`, [squads[3]]);
  const before = await one(`select pos_x, pos_y, mission_counter from teams where id = $1`, [squads[3]]);
  await run(15);
  const after = await one(`select pos_x, pos_y, mission_counter from teams where id = $1`, [squads[3]]);
  assert.deepEqual(after, before, 'a squad under manual control is left alone');
  // the person now drives with the normal captain action
  const mv = await call('captain_steer', cap, Number(before.pos_x) + 0.004, Number(before.pos_y), 0, 0);
  assert.ok(Math.abs(mv.x - Number(before.pos_x)) > 0.001);
  await call('demo_control', cap, false);
  assert.equal((await call('demo_status', cap)).bot, true);
  // a real player's phone is never treated as a demo
  const real = await call('join_team', 'CARDA', 9, (await call('host_fixed_cards', (await call('host_login', 'CARDA', 'same-password')).token, 'same-password')).squads[8].pin, 'Chen', true, true, null);
  const rs = await call('demo_status', real.token);
  assert.deepEqual([rs.demo, rs.bot, rs.can_control], [false, false, false]);
  await fails(call('demo_control', real.token, true), 'NOT_DEMO');
});

test('demo: dummies get into gunfights, knock squads out, and the finale plays to a result', async () => {
  await db.query(`select host_command($1, $2, 'set_phase', '{"phase": 3}'::jsonb, null)`, [demo.token, arena]);
  await db.query(`update teams set pos_x = 0.47 + (number % 3) * 0.004, pos_y = 0.585 + (number % 2) * 0.004, pos_at = now(), level = 0, bldg = null, location_id = 'fountain', state = 'idle',
    protected_until = null, hp = 40, shield = 0, vehicle = 'parked', buggy_x = 0.47, buggy_y = 0.585 where arena_id = $1`, [arena]);
  await db.query(`update mission_instances set status = 'cancelled' where arena_id = $1 and status = 'active'`, [arena]);
  await db.query(`update bots set goal = null, done_loc = 'fountain', wait_until = null, think_for = null where arena_id = $1`, [arena]);
  for (let i = 0; i < 40; i++) {
    await db.query(`update players set shot_at = null, reload_until = null where team_id in (select id from teams where arena_id = $1)`, [arena]);
    await run(1);
    if (Number((await one(`select coalesce(sum(kills), 0) k from teams where arena_id = $1`, [arena])).k) >= 1) break;
  }
  assert.ok(Number((await one(`select count(*) n from game_feed where arena_id = $1 and type = 'squad.gunfight'`, [arena])).n) >= 1, 'a gunfight broke out');
  assert.ok(Number((await one(`select coalesce(sum(kills), 0) k from teams where arena_id = $1`, [arena])).k) >= 1, 'a squad was knocked out');
  assert.ok(Number((await one(`select count(*) n from game_feed where arena_id = $1 and type = 'squad.knocked'`, [arena])).n) >= 1);
  await db.query(`select host_command($1, $2, 'begin_finale', '{}'::jsonb, null)`, [demo.token, arena]);
  await db.query(`select host_command($1, $2, 'launch_sync', '{"kind": "finale_battle"}'::jsonb, null)`, [demo.token, arena]);
  await run(40);
  const f = await one(`select count(*) filter (where status = 'solved') ok, count(*) n from mission_instances where arena_id = $1 and sync_round_id is not null`, [arena]);
  assert.ok(Number(f.n) >= 4, `finale rounds: ${f.n}`);
  assert.ok(Number(f.ok) >= 2, `finale answers: ${f.ok}`);
  assert.ok(Number((await one(`select sum(final_points) p from teams where arena_id = $1`, [arena])).p) > 0);
});

test('demo: ending it deletes the whole event; real events are untouched', async () => {
  const before = Number((await one(`select count(*) n from events where not demo`)).n);
  await fails(call('demo_end', (await call('host_login', 'CARDA', 'same-password')).token), 'NOT_DEMO');
  await call('demo_end', demo.token);
  assert.equal(Number((await one(`select count(*) n from events where demo`)).n), 0);
  assert.equal(Number((await one(`select count(*) n from bots`)).n), 0);
  assert.equal(Number((await one(`select count(*) n from bot_players`)).n), 0);
  assert.equal(Number((await one(`select count(*) n from events where not demo`)).n), before);
  await fails(call('host_extras', demo.token), 'HOST_AUTH');
});

test('permissions: the browser can call only the public actions, and cannot read the new tables', async () => {
  for (const f of ['host_fixed_cards(text, text)', 'card_event(text)', 'demo_create(int, int, text)', 'host_extras(text)', 'demo_view(text, int, text)',
    'demo_status(text)', 'demo_control(text, boolean)', 'demo_pulse(text)', 'demo_end(text)', 'arena_positions(text)']) {
    assert.equal((await one(`select has_function_privilege('anon', $1, 'execute') ok`, [f])).ok, true, f);
  }
  for (const f of ['_card_secret()', '_card_pin(text, int)', '_bot_act(uuid)', '_bots_step(uuid)', '_tick(uuid, boolean)', '_tick_core(uuid, boolean)', '_demo_purge(uuid)']) {
    assert.equal((await one(`select has_function_privilege('anon', $1, 'execute') ok`, [f])).ok, false, f);
  }
  for (const t of ['app_secrets', 'bots', 'bot_players', 'bot_clock']) {
    assert.equal((await one(`select has_table_privilege('anon', $1, 'select') ok`, [t])).ok, false, t);
  }
});
