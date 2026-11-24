// v15: event length in hours (1 h / 1.5 h / 2 h) and a host-only winner reveal.
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
const A = (id) => one('select * from arenas where id = $1', [id]);
const tick = (id) => one('select _tick($1, true)', [id]);
let n = 0;
const join = (ev, mode, code = null) => { const id = String(8000000000 + ++n); return call('online_join', ev, id, `h${id}@x.com`, `H${n}`, mode, code, true, null); };

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
});

test('hour presets stretch the whole match', async () => {
  const p60 = await call('_auto_preset', '60'); const p90 = await call('_auto_preset', '90'); const p120 = await call('_auto_preset', '120');
  assert.equal(p60.finale_minute, 38); assert.equal(p90.finale_minute, 66); assert.equal(p120.finale_minute, 92);
  assert.equal(p120.finale_battles, 4);
  assert.ok(p60.lock_interval < p90.lock_interval && p90.lock_interval < p120.lock_interval);
  assert.equal(p60.auto_pacing, 1, 'keeps everything else from the full preset');
  assert.equal((await call('_auto_preset', 'quick')).finale_minute, 9, 'old lengths unchanged');
});

test('one Start with 90 minutes: settings follow, reveal belongs to the host', async () => {
  const host = (await call('host_create_event', 'HRS1', 'Hours', 'hourspass123', 1)).token;
  await call('host_settings', host, { online: 1, arena_size: 3 });
  for (let i = 0; i < 8; i++) await join('HRS1', 'queue');
  const s = await call('host_online_auto', host, '90', true);
  assert.equal(s.auto, true);
  const st = (await one(`select settings from events where code = 'HRS1'`)).settings;
  assert.equal(st.finale_minute, 66); assert.equal(st.phase_schedule, '3,17,32,47');
  assert.equal(st.online_auto_length, '90'); assert.equal(st.auto_reveal, 0); assert.equal(st.game_minutes, 90);
});

test('autopilot stops at Results locked until the host reveals', async () => {
  const ev = await call('host_create_event', 'HRS2', 'Hours 2', 'hourspass123', 1);
  const [{ id }] = (await db.query('select id from arenas where event_id = $1', [ev.event_id])).rows;
  const pins = await call('host_generate_teams', ev.token, 3);
  let tok = null;
  for (const p of pins) for (const k of ['A', 'B', 'C', 'D']) { const j = await call('join_team', 'HRS2', p.number, p.pin, `${p.number}${k}`, true, true, null); tok = tok || j.token; }
  await call('host_command', ev.token, id, 'start_match', { length: 'quick' }, null);
  await call('host_settings', ev.token, { auto_reveal: 0 });
  // fast-forward to the finale and through it
  await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [id]); await tick(id);
  await db.query(`update arenas set shuttle_arrive_at = now() - interval '1 second' where id = $1`, [id]); await tick(id);
  await db.query(`update arenas set roles_deadline = now() - interval '1 second' where id = $1`, [id]); await tick(id);
  await db.query(`update arenas set play_started_at = now() - interval '30 minutes', phase_next_at = now() - interval '1 second' where id = $1`, [id]);
  for (let i = 0; i < 80 && !(await A(id)).results_locked; i++) {
    const a = await A(id);
    if (a.sync_round_id) await db.query(`update mission_instances set status = 'failed' where sync_round_id = $1 and status = 'active'`, [a.sync_round_id]);
    await db.query(`update arenas set auto_next_at = now() - interval '1 second', phase_next_at = case when phase = 'play' then now() - interval '1 second' else phase_next_at end where id = $1 and (auto_next_at is not null or phase = 'play')`, [id]);
    await tick(id);
  }
  let a = await A(id);
  assert.equal(a.results_locked, true, 'reached results');
  for (let i = 0; i < 5; i++) { await db.query(`update arenas set auto_next_at = now() - interval '1 second' where id = $1`, [id]); await tick(id); }
  a = await A(id);
  assert.equal(a.winner_revealed, false, 'the autopilot did not reveal');
  const ps = await call('player_state', tok);
  assert.equal(ps.results ?? null, null, 'phones get no result before the reveal');
  const r = await call('host_command', ev.token, id, 'reveal_winner', {}, null);
  assert.equal(r.ok, true);
  assert.equal((await A(id)).winner_revealed, true);
  const log = (await db.query(`select error from audit_log where arena_id = $1 and actor = 'autopilot' and not ok`, [id])).rows;
  assert.deepEqual(log, [], 'no autopilot errors');
});
