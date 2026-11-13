// v13: automatic maps — the host presses Start once; maps fill and take off by themselves.
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
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
let n = 0;
const join = (ev, mode, code = null) => { const id = String(7000000000 + ++n); return call('online_join', ev, id, `a${id}@x.com`, `P${n}`, mode, code, true, null); };
const maps = async (ev) => all(`select a.number, a.phase, a.autopilot, a.fill_deadline,
    (select count(*)::int from teams t where t.arena_id = a.id) squads,
    (select count(*)::int from players p join teams t on t.id = p.team_id where t.arena_id = a.id and p.active) players
  from arenas a join events e on e.id = a.event_id where e.code = $1 order by a.number`, [ev]);
const due = (ev) => db.query(`update arenas a set fill_deadline = now() - interval '1 second' from events e where e.id = a.event_id and e.code = $1 and a.fill_deadline is not null and not a.autopilot`, [ev]);

let host;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  host = (await call('host_create_event', 'AUTO1', 'Auto', 'autopass123', 1)).token;
  await call('host_settings', host, { online: 1, arena_size: 3 });   // 3 squads a map keeps the test small
});

test('players can check in before the host presses Start; nothing takes off', async () => {
  for (let i = 0; i < 8; i++) await join('AUTO1', 'queue');
  await call('host_online_summary', host);
  const m = await maps('AUTO1');
  assert.equal(m.length, 1); assert.equal(m[0].autopilot, false); assert.equal(m[0].players, 8);
});

test('one press: a map with 4+ players gets a countdown, then takes off by itself', async () => {
  const s = await call('host_online_auto', host, 'quick', true);
  assert.equal(s.auto, true);
  let m = await maps('AUTO1');
  assert.ok(m[0].fill_deadline, 'countdown started');
  await fails(call('host_online_start', host, 'quick'), 'AUTO_ON');
  await due('AUTO1');
  await call('host_online_summary', host);
  m = await maps('AUTO1');
  assert.equal(m[0].autopilot, true, 'Map 1 took off');
  assert.notEqual(m[0].phase, 'lobby');
  assert.equal(m[0].players, 8);
});

test('new players go to the next map, which fills while Map 1 plays; a full map takes off at once', async () => {
  const a = await join('AUTO1', 'create');
  assert.ok(a.code);
  for (let i = 0; i < 3; i++) await join('AUTO1', 'join', a.code);
  for (let i = 0; i < 8; i++) await join('AUTO1', 'queue');   // squads 2 and 3 on Map 2 → 3 complete squads = full
  const st = await call('player_state', a.token);
  assert.equal(st.arena.number, 2);
  let m = await maps('AUTO1');
  assert.equal(m[1].number, 2);
  await call('host_online_summary', host);
  m = await maps('AUTO1');
  assert.equal(m[1].autopilot, true, 'Map 2 took off when it was full: ' + JSON.stringify(m));
  assert.equal(m[1].players, 12);
});

test('phones in the lobby see the filling map and its countdown, and can start it themselves', async () => {
  const p = await join('AUTO1', 'queue');
  for (let i = 0; i < 6; i++) await join('AUTO1', 'queue');   // 7 players: a squad of 4 + a squad of 3 on Map 3
  let st = await call('player_state', p.token);
  assert.equal(st.online.auto, true); assert.equal(st.online.started, false);
  assert.equal(st.online.fill.map, 3); assert.ok(st.online.fill.deadline);
  await due('AUTO1');
  st = await call('player_state', p.token);                   // no host console needed
  assert.equal(st.online.started, true);
  assert.notEqual(st.arena.phase, 'lobby');
});

test('the host can launch the filling map early; small squads are merged and nobody is left out', async () => {
  for (let i = 0; i < 2; i++) await join('AUTO1', 'create');  // two single players
  await join('AUTO1', 'queue'); await join('AUTO1', 'queue'); await join('AUTO1', 'queue');
  const r = await call('host_online_launch', host);
  assert.equal(r.why, 'host');
  const m = await maps('AUTO1');
  const four = m.find((x) => x.number === 4);
  assert.equal(four.autopilot, true);
  const sizes = await all(`select (select count(*)::int from players p where p.team_id = t.id and p.active) n from teams t join arenas a on a.id = t.arena_id where a.number = 4 and a.event_id = (select id from events where code = 'AUTO1')`);
  assert.ok(sizes.every((x) => x.n >= 2), JSON.stringify(sizes));
  assert.equal(sizes.reduce((s, x) => s + x.n, 0), 5);
});

test('a lobby with too many squads before Start: the first map takes 3, the rest move to the next map', async () => {
  const h = (await call('host_create_event', 'AUTO2', 'Auto 2', 'autopass123', 1)).token;
  await call('host_settings', h, { online: 1, arena_size: 3 });
  for (let i = 0; i < 20; i++) await join('AUTO2', 'queue');  // 5 squads of 4 in the lobby
  await call('host_online_auto', h, 'quick', true);
  const m = await maps('AUTO2');
  assert.equal(m[0].autopilot, true); assert.equal(m[0].squads, 3);
  assert.equal(m[1].autopilot, false); assert.equal(m[1].squads, 2);
  assert.ok(m[1].fill_deadline, 'the next map counts down');
});

test('the last few players are never stranded: 4 players start a countdown and take off', async () => {
  const h = (await call('host_create_event', 'AUTO3', 'Auto 3', 'autopass123', 1)).token;
  await call('host_settings', h, { online: 1, arena_size: 3 });
  await call('host_online_auto', h, 'quick', true);
  for (let i = 0; i < 5; i++) await join('AUTO3', i === 4 ? 'create' : 'queue');   // a squad of 4 + a lone player
  await call('host_online_summary', h);
  assert.ok((await maps('AUTO3'))[0].fill_deadline);
  await due('AUTO3');
  await call('host_online_summary', h);
  const m = await maps('AUTO3');
  assert.equal(m[0].autopilot, true); assert.equal(m[0].players, 5);
  const sizes = await all(`select (select count(*)::int from players p where p.team_id = t.id and p.active) n from teams t join arenas a on a.id = t.arena_id where a.event_id = (select id from events where code = 'AUTO3')`);
  assert.ok(sizes.every((x) => x.n >= 2), 'the lone player was merged: ' + JSON.stringify(sizes));
});

test('pausing automatic starts stops the countdown', async () => {
  const h = (await call('host_login', 'AUTO2', 'autopass123')).token;
  await call('host_online_auto', h, 'quick', false);
  const m = await maps('AUTO2');
  assert.equal(m[1].fill_deadline, null);
});
