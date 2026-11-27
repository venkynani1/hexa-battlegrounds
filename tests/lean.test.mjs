// 0995: lean polling — same game state, a fraction of the bytes (free-tier budget for 130 phones).
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
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const lean = async (tok, have) => (await db.query(`select player_state(p_token => $1, p_have => $2::jsonb) as r`, [tok, JSON.stringify(have)])).rows[0].r;

let captain, scout;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const host = (await call('host_create_event', 'LEAN1', 'Lean', 'leanpass1234', 1)).token;
  await call('host_settings', host, { online: 1, arena_size: 35, online_max_maps: 1, game_minutes: 60 });
  const toks = [];
  for (let i = 0; i < 12; i++) { const id = String(9200000000 + i); toks.push((await call('online_join', 'LEAN1', id, `n${id}@x.com`, `N${i}`, 'queue', null, true, null)).token); }
  await call('host_online_start', host, '60');
  const [a] = await all(`select a.id from arenas a join events e on e.id = a.event_id where e.code = 'LEAN1' and a.phase <> 'lobby'`);
  await db.query(`update players p set role = r.role from (select id, (array['captain','scout','decoder','intel'])[row_number() over (partition by team_id order by joined_at)] as role
    from players where team_id in (select id from teams where arena_id = $1)) r where r.id = p.id`, [a.id]);
  await db.query(`update teams set dropped = true, pos_x = 0.4123456789, pos_y = 0.5987654321, pos_at = now() where arena_id = $1`, [a.id]);
  await db.query(`update arenas set phase = 'play' where id = $1`, [a.id]);
  await call('_spawn_pickups', a.id);
  for (const t of toks) {
    const s = await call('player_state', t);
    if (s.me?.role === 'captain' && !captain) captain = t;
    if (s.me?.role === 'scout' && !scout) scout = t;
  }
  assert.ok(captain && scout);
});

test('a first lean call carries the full state plus section hashes', async () => {
  const full = await call('player_state', captain);
  const l = await lean(captain, {});
  for (const k of Object.keys(full)) assert.ok(k in l, `${k} present`);
  assert.equal(typeof l.h.pickups, 'string');
  assert.ok(l.pickups.length > 0 && l.pickups.length < full.pickups.length, 'only loot around the squad');
  assert.ok(l.pickups.every((p) => (p.x - 0.4123) ** 2 + (p.y - 0.5988) ** 2 <= 0.0901));
  const me = l.squads.find((q) => q.id === full.team.id);
  assert.deepEqual(me.pos, [0.4123, 0.5988], 'coordinates rounded to 4 decimals');
});

test('a repeat call leaves out what the phone already holds, and is much smaller', async () => {
  const l1 = await lean(captain, {});
  const l2 = await lean(captain, l1.h);
  for (const k of ['pickups', 'roster', 'event', 'roles']) assert.ok(!(k in l2), `${k} omitted`);
  for (const k of ['team', 'arena', 'squads', 'me', 'server_now']) assert.ok(k in l2, `${k} always sent`);
  assert.ok(JSON.stringify(l2).length < JSON.stringify(l1).length / 2);
  // a change brings the section back
  await db.query(`update pickups set taken_at = now() where id = $1`, [l1.pickups[0].id]);
  const l3 = await lean(captain, l1.h);
  assert.equal(l3.pickups.length, l1.pickups.length - 1);
});

test('teammates get the rivals feed inside player_state; the captain does not', async () => {
  const c = await lean(captain, {});
  const s = await lean(scout, {});
  assert.ok(!('rivals' in c));
  assert.ok(Array.isArray(s.rivals) && s.rivals.length >= 3);
  const r = s.rivals[0];
  assert.ok(Array.isArray(r.pos) && r.id);
  assert.ok(!Object.values(r).includes(null), 'no empty fields on the wire');
});

test('arena_positions is rounded and stays callable by phones; the raw one is not', async () => {
  const p = await call('arena_positions', captain);
  assert.ok(p.squads.every((q) => String(q.pos[0]).length <= 6));
  const priv = await all(`select has_function_privilege('anon', '_arena_positions_v16(text)', 'execute') a, has_function_privilege('anon', 'arena_positions(text)', 'execute') b, has_function_privilege('anon', 'player_state(text,jsonb)', 'execute') c`);
  assert.deepEqual(priv[0], { a: false, b: true, c: true });
});
