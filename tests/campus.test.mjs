// Campus v4: floors and stairs, smooth-movement velocity, loot on the ground, HP loss for
// failing, and the Collapsing Campus (lockdown alarms, ejection, vaults, final lockdown).
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
const cmd = async (tok, arena, c, args = {}) => call('host_command', tok, arena, c, args, null);
const tick = (id) => db.query('select _tick($1, true)', [id]);

let ev; let arena; const sq = {};
const at = (id, x, y, extra = '') => db.query(`update teams set pos_x = $2, pos_y = $3, pos_at = now() - interval '2 seconds', state = 'idle', travel_to = null${extra} where id = $1`, [id, x, y]);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  ev = await call('host_create_event', 'CAMPUS', 'Campus', 'campuspass', 1);
  await db.query(`update events set settings = settings || '{"br_mode": 0}'::jsonb`); // earlier start: bus + role claims
  arena = (await one(`select id from arenas where event_id = $1`, [ev.event_id])).id;
  const pins = await call('host_generate_teams', ev.token, 3);
  for (const p of pins) {
    const toks = [];
    for (const n of ['A', 'B', 'C', 'D']) toks.push((await call('join_team', 'CAMPUS', p.number, p.pin, `${p.number}${n}`, true, true, null)).token);
    sq[p.number] = { id: (await one(`select id from teams where event_id = $1 and number = $2`, [ev.event_id, p.number])).id, toks };
  }
  await cmd(ev.token, arena, 'open_boarding');
  await cmd(ev.token, arena, 'drive');
  await cmd(ev.token, arena, 'finalize_roles');
  await db.query('update arenas set last_tick_at = null where id = $1', [arena]);
  await cmd(ev.token, arena, 'finalize_roles');
  for (const n of [1, 2, 3]) {
    for (const t of sq[n].toks) {
      const st = await call('player_state', t);
      if (st.me.role === 'captain') sq[n].cap = t; else sq[n].mate = t;
    }
  }
  await cmd(ev.token, arena, 'zone_cancel');
});

test('map data: buildings with floors, rooms upstairs, Training Room 14 on the top floor', async () => {
  const m = await call('map_data');
  const hx = m.buildings.find((b) => b.id === 'hexavarsity');
  assert.equal(hx.floors, 4);
  assert.equal(m.buildings.find((b) => b.id === 'phase2').floors, 5);
  const tr = m.locations.find((l) => l.id === 'tr14');
  assert.equal(tr.level, 3);
  assert.equal(tr.building, 'hexavarsity');
  assert.ok(m.locations.filter((l) => l.level > 0).length >= 30, 'plenty of rooms upstairs');
  assert.ok(m.locations.some((l) => l.kind === 'parking') && m.locations.some((l) => l.id === 'fountain'));
  assert.equal(m.locations.find((l) => l.id === 'eb2_parking').enabled, false, 'retired places are switched off');
});

test('stairs: climb floor by floor; upstairs rooms are found on their own floor only', async () => {
  const hx = await one(`select * from buildings where id = 'hexavarsity'`);
  const s1 = sq[1];
  await at(s1.id, 0.2, 0.2, ", location_id = null, dropped = true");
  await fails(call('captain_stairs', s1.cap, 1), 'NOT_AT_STAIRS');
  await fails(call('captain_stairs', s1.mate, 1), 'NOT_CAPTAIN');
  await at(s1.id, hx.stair_x, hx.stair_y);
  await fails(call('captain_stairs', s1.cap, -1), 'NO_FLOOR');
  let r;
  for (let f = 1; f <= 3; f++) { r = await call('captain_stairs', s1.cap, 1); assert.equal(r.level, f); }
  await fails(call('captain_stairs', s1.cap, 1), 'NO_FLOOR');
  const tr = await one(`select x, y from locations where id = 'tr14'`);
  // walk to Training Room 14 on floor 3
  await at(s1.id, tr.x + 0.01, tr.y);
  const st = await call('captain_steer', s1.cap, tr.x, tr.y);
  assert.equal(st.location, 'tr14');
  assert.equal(st.level, 3);
  // upstairs the floor's walls keep you inside the building
  await at(s1.id, hx.x1 - 0.01, tr.y);
  const out = await call('captain_steer', s1.cap, hx.x1 + 0.02, tr.y);
  assert.ok(out.x <= hx.x1, 'cannot walk off the third floor');
  // the same spot on the ground floor is not Training Room 14
  const loc0 = await one(`select _loc_at3($1, $2, $3, $4, 0, null) as l`, [arena, ev.event_id, tr.x, tr.y]);
  assert.notEqual(loc0.l, 'tr14');
  const mate = await call('player_state', s1.mate);
  assert.equal(mate.team.level, 3);
  assert.equal(mate.team.bldg, 'hexavarsity');
  // tap-to-run never crosses floors
  await fails(call('captain_move', s1.cap, 'fountain'), 'TAKE_THE_STAIRS');
  // back down
  await at(s1.id, hx.stair_x, hx.stair_y);
  for (let f = 2; f >= 0; f--) assert.equal((await call('captain_stairs', s1.cap, -1)).level, f);
  assert.equal((await one(`select bldg from teams where id = $1`, [s1.id])).bldg, null);
});

test('smooth movement: the joystick velocity reaches teammates and rivals (capped)', async () => {
  await at(sq[1].id, 0.3, 0.6, ", location_id = null");
  await at(sq[2].id, 0.32, 0.6, ", location_id = null");
  const r = await call('captain_steer', sq[1].cap, 0.3, 0.6, 0.01, -0.005);
  assert.ok(r.x !== undefined);
  const mine = await call('player_state', sq[1].mate);
  const me = mine.squads.find((x) => x.number === 1);
  assert.deepEqual(me.vel.map((v) => Math.round(v * 1000)), [10, -5]);
  const pos = await call('arena_positions', sq[2].mate);
  const other = pos.squads.find((x) => x.id === sq[1].id);
  assert.ok(other && other.vel, 'rivals get the velocity too');
  assert.ok(pos.squads.find((x) => x.id === sq[2].id), 'own squad is included (teammates fall back to it)');
  await call('captain_steer', sq[1].cap, 0.3, 0.6, 5, 5); // absurd speed is capped
  const v = (await one(`select vel_x, vel_y from teams where id = $1`, [sq[1].id]));
  assert.ok(Math.hypot(v.vel_x, v.vel_y) <= 0.016 * 1.1 + 1e-6);
});

test('loot on the ground: drive over a med kit to pick it up', async () => {
  const n0 = (await one(`select count(*)::int n from pickups where arena_id = $1 and taken_at is null`, [arena])).n;
  assert.ok(n0 >= 30, `${n0} pickups at the start`);
  await db.query(`delete from pickups where arena_id = $1 and level = 0 and x between 0.55 and 0.65 and y between 0.85 and 0.95`, [arena]);
  await db.query(`insert into pickups(arena_id, kind, x, y, level) values ($1, 'medkit', 0.6, 0.9, 0), ($1, 'shield', 0.605, 0.9, 0), ($1, 'coins', 0.6, 0.91, 0)`, [arena]);
  await db.query(`delete from inventory where team_id = $1 and item_id = 'medkit'`, [sq[3].id]);
  await db.query(`update teams set shield = 0 where id = $1`, [sq[3].id]);
  const c0 = (await one(`select coins from teams where id = $1`, [sq[3].id])).coins;
  await at(sq[3].id, 0.59, 0.9, ", location_id = null, level = 0, bldg = null");
  const r = await call('captain_steer', sq[3].cap, 0.6, 0.9);
  assert.deepEqual([...r.picked].sort(), ['coins', 'medkit', 'shield']);
  assert.equal((await one(`select qty from inventory where team_id = $1 and item_id = 'medkit'`, [sq[3].id])).qty, 1);
  const t = await one(`select shield, coins from teams where id = $1`, [sq[3].id]);
  assert.equal(t.shield, 20);
  assert.equal(t.coins, c0 + 15);
  const again = await call('captain_steer', sq[3].cap, 0.6, 0.9);
  assert.equal(again.picked, null, 'each pickup is taken once');
  const st = await call('player_state', sq[3].mate);
  assert.ok(Array.isArray(st.pickups) && st.pickups.length > 0);
});

test('failing hurts: wrong answers and unsolved challenges cost HP', async () => {
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  await db.query(`update teams set hp = 100, shield = 0, location_id = 'fountain', state = 'idle', visit_missions = 0, level = 0, bldg = null where id = $1`, [sq[2].id]);
  const ex = await call('captain_explore', sq[2].cap);
  const parts = (await call('player_state', sq[2].cap)).mission.parts;
  const wrong = parts.map(() => 'zzzz');
  await call('captain_submit', sq[2].cap, ex.instance, wrong, 'idem-wrong-1');
  assert.equal((await one(`select hp from teams where id = $1`, [sq[2].id])).hp, 95, '−5 for a wrong answer');
  await call('captain_submit', sq[2].cap, ex.instance, wrong, 'idem-wrong-2');
  await call('captain_submit', sq[2].cap, ex.instance, wrong, 'idem-wrong-3');
  // 2 wrong (−10) and then failed (−20)
  assert.equal((await one(`select hp from teams where id = $1`, [sq[2].id])).hp, 70);
  // running out of time also costs HP
  await db.query(`update teams set hp = 100, visit_missions = 0 where id = $1`, [sq[2].id]);
  const ex2 = await call('captain_explore', sq[2].cap);
  await db.query(`update mission_instances set deadline = now() - interval '1 second' where id = $1`, [ex2.instance]);
  await tick(arena);
  assert.equal((await one(`select hp from teams where id = $1`, [sq[2].id])).hp, 80);
});

test('lockdown: alarm and countdown, a vault inside, then everyone inside is thrown out and hurt', async () => {
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  const p2 = await one(`select * from buildings where id = 'phase2'`);
  // squad 1 inside Phase 2 on the ground floor, squad 3 upstairs on floor 2
  await db.query(`update teams set hp = 100, shield = 0, level = 0, bldg = null, location_id = null where id in ($1, $2)`, [sq[1].id, sq[3].id]);
  await at(sq[1].id, (p2.x0 + p2.x1) / 2, (p2.y0 + p2.y1) / 2);
  await db.query(`update teams set level = 2, bldg = 'phase2', pos_x = $2, pos_y = $3 where id = $1`, [sq[3].id, p2.x0 + 0.02, p2.y0 + 0.02]);
  const r = await cmd(ev.token, arena, 'lock_building', { building: 'phase2' });
  assert.equal(r.ok, true, JSON.stringify(r));
  let a = await one(`select overlay from arenas where id = $1`, [arena]);
  assert.equal(a.overlay.lock.length, 1);
  assert.equal(a.overlay.lock[0].sealed, false);
  const vault = await one(`select l.building from airdrops ad join locations l on l.id = ad.location_id where ad.arena_id = $1 and ad.tier = 'vault' and ad.status = 'open' and l.building = 'phase2'`, [arena]);
  assert.ok(vault, 'a vault opened inside the doomed building');
  const feed = await call('player_state', sq[2].mate);
  assert.ok(feed.feed.some((f) => f.type === 'lockdown.warning'));
  // countdown ends
  await db.query(`update lockdowns set seal_at = now() - interval '1 second' where arena_id = $1`, [arena]);
  await tick(arena);
  const t1 = await one(`select hp, level, bldg, pos_x, pos_y from teams where id = $1`, [sq[1].id]);
  const t3 = await one(`select hp, level, bldg, pos_x, pos_y from teams where id = $1`, [sq[3].id]);
  for (const t of [t1, t3]) {
    assert.equal(t.hp, 70, 'caught inside: −30');
    assert.equal(t.level, 0);
    assert.equal(t.bldg, null);
    assert.ok(Math.abs(t.pos_y - p2.door_y) < 1e-6, 'thrown out through the front door');
  }
  a = await one(`select overlay from arenas where id = $1`, [arena]);
  assert.equal(a.overlay.lock[0].sealed, true);
  assert.equal(a.overlay.lock[0].caught, 2);
  assert.equal((await one(`select count(*)::int n from airdrops ad join locations l on l.id = ad.location_id where ad.arena_id = $1 and ad.status = 'open' and l.building = 'phase2'`, [arena])).n, 0, 'the vault is gone');
  // the sealed building is now a wall, and its rooms are closed
  await at(sq[1].id, p2.x0 - 0.01, (p2.y0 + p2.y1) / 2, ", location_id = null");
  const w = await call('captain_steer', sq[1].cap, p2.x0 + 0.003, (p2.y0 + p2.y1) / 2);
  assert.equal(w.wall, 'phase2');
  assert.ok(w.x < p2.x0);
  await fails(call('captain_move', sq[1].cap, 'p2_lobby'), 'SEALED');
  await at(sq[1].id, p2.stair_x, p2.stair_y);
  await fails(call('captain_stairs', sq[1].cap, 1), 'SEALED');
  // the host can lift every lockdown
  await cmd(ev.token, arena, 'unlock_all');
  assert.equal((await one(`select count(*)::int n from lockdowns where arena_id = $1`, [arena])).n, 0);
});

test('vault crates pay more than legendary airdrops', async () => {
  await db.query(`update mission_instances set status = 'cancelled' where status = 'active'`);
  const id = (await one(`select _spawn_vault($1, 'hexadine', now() + interval '5 minutes') as id`, [arena])).id;
  await db.query(`update teams set location_id = 'hexadine', state = 'idle', level = 0, bldg = null, beacon = false where id = $1`, [sq[2].id]);
  const before = await one(`select points, coins from teams where id = $1`, [sq[2].id]);
  const c = await call('captain_claim_airdrop', sq[2].cap, id);
  const tpl = await one(`select mt.parts from mission_instances mi join mission_templates mt on mt.id = mi.template_id where mi.id = $1`, [c.instance]);
  const answers = tpl.parts.map((p) => p.accept[0]);
  const res = await call('captain_submit', sq[2].cap, c.instance, answers, 'idem-vault-1');
  assert.equal(res.correct, true);
  const after = await one(`select points, coins from teams where id = $1`, [sq[2].id]);
  assert.equal(after.coins - before.coins, 120);
  assert.equal(after.points - before.points, 150, 'double airdrop points');
  assert.ok((await one(`select qty from inventory where team_id = $1 and item_id = 'sniper'`, [sq[2].id])).qty >= 1);
});

test('final lockdown: only Hexavarsity stays open', async () => {
  await cmd(ev.token, arena, 'begin_finale');
  const r = await cmd(ev.token, arena, 'final_lockdown');
  assert.equal(r.ok, true, JSON.stringify(r));
  const open = (await db.query(`select id from buildings b where not exists (select 1 from lockdowns l where l.arena_id = $1 and l.building = b.id and l.level is null and l.sealed)`, [arena])).rows.map((x) => x.id);
  assert.deepEqual(open, ['hexavarsity']);
  const spec = await one(`select spectator_token from arenas where id = $1`, [arena]);
  const s = await call('spectator_state', spec.spectator_token);
  assert.equal(s.arena.finale_stage, 'D');
  assert.ok(s.recap && s.recap.sealed >= 9, 'projector recap counts the sealed buildings');
});
