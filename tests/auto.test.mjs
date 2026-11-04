// Autopilot tests: one "Start match" runs boarding → bus → roles → phases → finale rounds → results
// → winner by itself; pause freezes it, a manual override never confuses it, and the host can take over.
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
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const cmd = async (tok, arena, c, args = {}, reason = null) => call('host_command', tok, arena, c, args, reason);
const tick = (id) => one('select _tick($1, true)', [id]);
const A = (id) => one('select * from arenas where id = $1', [id]);

async function setup(code, squads, maps = 1) {
  const ev = await call('host_create_event', code, code, 'autopass1', maps);
  const arenas = (await db.query(`select id from arenas where event_id = $1 order by number`, [ev.event_id])).rows.map((r) => r.id);
  const pins = squads ? await call('host_generate_teams', ev.token, squads) : [];
  for (const p of pins) {
    for (const n of ['A', 'B', 'C', 'D']) await call('join_team', code, p.number, p.pin, `${p.number}${n}`, true, true, null);
  }
  return { ev, arenas };
}

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
});

test('start_match refuses an empty map and an unknown length', async () => {
  const { ev, arenas } = await setup('AUTOE', 0);
  const r = await cmd(ev.token, arenas[0], 'start_match', { length: 'quick' });
  assert.equal(r.ok, false);
  assert.match(r.error, /NO_READY_SQUADS/);
  const { ev: ev2, arenas: a2 } = await setup('AUTOL', 2);
  const r2 = await cmd(ev2.token, a2[0], 'start_match', { length: 'forever' });
  assert.match(r2.error, /BAD_LENGTH/);
});

test('one Start runs the whole match and declares the winner', async () => {
  const { ev, arenas: [id] } = await setup('AUTO1', 3);
  const r = await cmd(ev.token, id, 'start_match', { length: 'quick' });
  assert.equal(r.ok, true);
  let a = await A(id);
  assert.equal(a.autopilot, true);
  assert.equal(a.phase, 'boarding');
  assert.equal(r.result[id].label, 'Bus leaves');
  const s = (await one('select settings from events where id = $1', [ev.event_id])).settings;
  assert.equal(s.phase_schedule, '1,3,5,7');
  assert.equal(s.finale_battles, 1);

  // bus leaves, arrives, roles lock — no host input
  await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [id]);
  await tick(id);
  assert.equal((await A(id)).phase, 'shuttle');
  await db.query(`update arenas set shuttle_arrive_at = now() - interval '1 second' where id = $1`, [id]);
  await tick(id);
  assert.equal((await A(id)).phase, 'roles');
  await db.query(`update arenas set roles_deadline = now() - interval '1 second' where id = $1`, [id]);
  await tick(id);
  a = await A(id);
  assert.equal(a.phase, 'play');
  assert.equal(a.auto_step, 'play');
  assert.ok(a.phase_next_at, 'phases are on a timetable');
  assert.equal(a.overlay.auto.label, 'Phase 1');
  const stories = async () => (await one(`select count(*) filter (where kind = 'transmission')::int t, count(*) filter (where kind = 'bargain')::int b from story_events where arena_id = $1`, [id]));
  assert.deepEqual(await stories(), { t: 1, b: 0 });

  // phases advance on their own; Squad 00 speaks once per phase and bargains in phases 2 and 3
  for (let ph = 1; ph <= 4; ph++) {
    await db.query(`update arenas set phase_next_at = now() - interval '1 second' where id = $1`, [id]);
    await tick(id);
    await tick(id);
    assert.equal((await A(id)).match_phase, ph);
  }
  assert.deepEqual(await stories(), { t: 5, b: 2 });
  assert.equal((await A(id)).overlay.auto.label, 'Finale');

  // the finale opens on the timetable
  await db.query(`update arenas set play_started_at = now() - interval '10 minutes' where id = $1`, [id]);
  await tick(id);
  a = await A(id);
  assert.equal(a.phase, 'finale');
  assert.equal(a.match_phase, 5);
  assert.equal(a.overlay.auto.label, 'Finale entry round');

  // rounds run back to back; a round ends early once no squad is still working on it
  const kinds = [];
  for (let i = 0; i < 40 && !(await A(id)).winner_revealed; i++) {
    a = await A(id);
    if (a.sync_round_id) {
      const round = await one('select kind from sync_rounds where id = $1', [a.sync_round_id]);
      if (kinds[kinds.length - 1] !== round.kind) kinds.push(round.kind);
      // everyone finishes (here: runs out of attempts) → the autopilot closes the round without waiting
      await db.query(`update mission_instances set status = 'failed' where sync_round_id = $1 and status = 'active'`, [a.sync_round_id]);
    } else {
      await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1 and auto_next_at is not null`, [id]);
    }
    await tick(id);
  }
  assert.deepEqual(kinds, ['finale_entry', 'finale_exchange', 'finale_battle', 'final_code']);
  a = await A(id);
  assert.ok(await one(`select 1 from story_events where arena_id = $1 and kind = 'reveal'`, [id]), 'Squad 00 was revealed');
  assert.equal(a.phase, 'results');
  assert.equal(a.results_locked, true);
  assert.equal(a.winner_revealed, true);
  assert.equal(a.overlay.auto.label, 'Match complete');
  const log = (await db.query(`select action from audit_log where arena_id = $1 and actor = 'autopilot' and not ok`, [id])).rows;
  assert.deepEqual(log, [], 'no autopilot errors');
});

test('pause freezes the autopilot; resume keeps its countdown', async () => {
  const { ev, arenas: [id] } = await setup('AUTO2', 2);
  await cmd(ev.token, id, 'start_match', { length: 'standard' });
  const before = (await A(id)).auto_next_at;
  await cmd(ev.token, id, 'pause');
  await db.query(`update arenas set paused_at = paused_at - interval '5 minutes', auto_next_at = auto_next_at - interval '1 hour' where id = $1`, [id]);
  await tick(id);
  assert.equal((await A(id)).phase, 'boarding', 'nothing moves while paused');
  await db.query(`update arenas set auto_next_at = $2 where id = $1`, [id, before]);
  await cmd(ev.token, id, 'resume');
  const after = (await A(id)).auto_next_at;
  assert.ok(new Date(after) - new Date(before) >= 299_000, 'countdown shifted by the pause');
});

test('manual override and taking control', async () => {
  const { ev, arenas: [id] } = await setup('AUTO3', 2);
  await cmd(ev.token, id, 'start_match', { length: 'quick' });
  // the host drives early and finalizes roles by hand: the autopilot follows
  await cmd(ev.token, id, 'drive');
  await cmd(ev.token, id, 'finalize_roles');
  await db.query('update arenas set last_tick_at = null where id = $1', [id]);
  await cmd(ev.token, id, 'finalize_roles');
  await tick(id);
  let a = await A(id);
  assert.equal(a.phase, 'play');
  assert.equal(a.auto_step, 'play');
  // the host opens the finale early: the autopilot picks up from there
  await cmd(ev.token, id, 'begin_finale');
  await tick(id);
  a = await A(id);
  assert.equal(a.auto_step, 'fin:0');
  await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [id]);
  await tick(id);
  a = await A(id);
  assert.ok(a.sync_round_id, 'first finale round launched automatically');
  // take manual control: nothing else happens on its own
  await cmd(ev.token, id, 'autopilot_off');
  await db.query(`update mission_instances set status = 'failed' where sync_round_id = $1`, [a.sync_round_id]);
  await tick(id);
  a = await A(id);
  assert.equal(a.autopilot, false);
  assert.ok(a.sync_round_id, 'round stays open for the host');
  assert.equal(a.overlay.auto, undefined);
  // and hand it back
  await cmd(ev.token, id, 'autopilot_on');
  await tick(id);
  assert.equal((await A(id)).sync_round_id, null);
  const ov = await call('host_overview', ev.token);
  assert.equal(ov.arenas[0].auto.on, true);
});

test('two maps (and an empty third): the grand champion is revealed after both winners', async () => {
  const { ev, arenas: all } = await setup('AUTO4', 4, 3);
  const arenas = all.slice(0, 2);
  // put two squads on each map
  const teams = (await db.query(`select id from teams where event_id = $1 order by number`, [ev.event_id])).rows;
  await db.query(`update teams set arena_id = $2 where id = any($1::uuid[])`, [[teams[2].id, teams[3].id], arenas[1]]);
  await db.query(`update teams set arena_id = $1 where event_id = $2 and arena_id = $3`, [arenas[0], ev.event_id, all[2]]);
  const st = await cmd(ev.token, null, 'start_match', { length: 'quick' });
  assert.match(st.result[all[2]].error, /NO_READY_SQUADS/, 'the empty map is skipped');
  for (const id of arenas) {
    await cmd(ev.token, id, 'drive');
    await cmd(ev.token, id, 'finalize_roles');
    await db.query('update arenas set last_tick_at = null where id = $1', [id]);
    await cmd(ev.token, id, 'finalize_roles');
    await cmd(ev.token, id, 'begin_finale');
  }
  const run = async (id) => {
    for (let i = 0; i < 40 && !(await A(id)).winner_revealed; i++) {
      const a = await A(id);
      if (a.sync_round_id) await db.query(`update mission_instances set status = 'failed' where sync_round_id = $1 and status = 'active'`, [a.sync_round_id]);
      else await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1 and auto_next_at is not null`, [id]);
      await tick(id);
    }
  };
  await run(arenas[0]);
  await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [arenas[0]]);
  await tick(arenas[0]);
  assert.equal((await one('select grand_revealed from events where id = $1', [ev.event_id])).grand_revealed, false, 'waits for map 2');
  await run(arenas[1]);
  await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [arenas[1]]);
  await tick(arenas[1]);
  assert.equal((await one('select grand_revealed from events where id = $1', [ev.event_id])).grand_revealed, true);
  assert.equal((await A(arenas[1])).overlay.auto.label, 'Match complete');
});
