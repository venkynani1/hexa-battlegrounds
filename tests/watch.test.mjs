// v9: a disconnected teammate is covered by a bot (their clue goes to an online teammate),
// the captaincy moves on and comes back; no leaderboard during the match.
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
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
let host; let arena; let team; const tok = {};
const watch = async () => { await db.query(`update arenas set watch_at = null where id = $1`, [arena]); return call('_squad_watch', arena); };
const roles = async () => Object.fromEntries((await all(`select display_name n, role, role2, role2_bot, away from players where team_id = $1`, [team])).map((r) => [r.n, r]));

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  host = (await call('host_create_event', 'WAT26', 'Watch', 'watchpass', 1)).token;
  const cards = await call('host_fixed_cards', host, 'watchpass');
  arena = (await call('host_overview', host)).arenas[0].id;
  for (const n of ['Asha', 'Ben', 'Chen', 'Dev']) tok[n] = (await call('join_flight', 'WAT26', 1, cards.squads[0].pin, n, true, true, null)).token;
  team = (await one(`select team_id from players where display_name = 'Asha'`)).team_id;
  await call('claim_role', tok.Asha, 'captain').catch(() => {});
  await db.query(`update arenas set phase = 'play', play_started_at = now() where id = $1`, [arena]);
  await db.query(`update players set role = null where team_id = $1`, [team]);
  for (const [n, r] of [['Asha', 'captain'], ['Ben', 'scout'], ['Chen', 'decoder'], ['Dev', 'intel']]) await db.query(`update players set role = $1, last_seen_at = now() where display_name = $2`, [r, n]);
});

test('a teammate offline for a minute: a bot covers their clue; when they return it leaves', async () => {
  await db.query(`update players set last_seen_at = now() - interval '70 seconds' where display_name = 'Dev'`);
  assert.equal(await watch(), true);
  let r = await roles();
  assert.equal(r.Dev.away, true);
  const holder = Object.values(r).find((x) => x.role2 === 'intel');
  assert.ok(holder && holder.role2_bot && holder.role !== 'captain', JSON.stringify(r));
  const st = await call('player_state', tok.Ben);
  const dev = st.squad.find((m) => m.name === 'Dev');
  assert.equal(dev.status, 'away');
  const chat = await call('squad_chat', tok.Ben, 0);
  assert.ok(chat.some((m) => /Bot joined for Dev/.test(m.body)));
  await db.query(`update players set last_seen_at = now() where display_name = 'Dev'`);
  await watch();
  r = await roles();
  assert.equal(r.Dev.away, false); assert.equal(r.Dev.role, 'intel');
  assert.ok(!Object.values(r).some((x) => x.role2), 'the bot left');
});

test('the captain disconnects: an online teammate becomes captain; the captain gets it back on return', async () => {
  await db.query(`update players set last_seen_at = now() - interval '70 seconds' where display_name = 'Asha'`);
  await watch();
  let r = await roles();
  assert.equal(r.Asha.away, true);
  const cap = Object.entries(r).find(([, x]) => x.role === 'captain');
  assert.ok(cap && cap[0] !== 'Asha');
  const covered = new Set(Object.values(r).filter((x) => !x.away).flatMap((x) => [x.role, x.role2]).filter(Boolean));
  assert.equal(covered.size, 4, 'all four roles covered by online players: ' + JSON.stringify(r));
  // the stand-in captain can act as captain
  const st = await call('player_state', tok[cap[0]]);
  assert.equal(st.me.role, 'captain');
  await db.query(`update players set last_seen_at = now() where display_name = 'Asha'`);
  await watch();
  r = await roles();
  assert.equal(r.Asha.role, 'captain'); assert.equal(r.Asha.away, false);
  assert.deepEqual(['Ben', 'Chen', 'Dev'].map((n) => r[n].role).sort(), ['decoder', 'intel', 'scout']);
  assert.ok(!Object.values(r).some((x) => x.role2));
});

test('two players away at once in a squad of 4: both roles are still covered', async () => {
  await db.query(`update players set last_seen_at = now() - interval '70 seconds' where display_name in ('Chen', 'Dev')`);
  await watch();
  const r = await roles();
  const covered = new Set(Object.values(r).filter((x) => !x.away).flatMap((x) => [x.role, x.role2]).filter(Boolean));
  assert.equal(covered.size, 4, JSON.stringify(r));
  await db.query(`update players set last_seen_at = now() where display_name in ('Chen', 'Dev')`);
  await watch();
  assert.ok(!Object.values(await roles()).some((x) => x.role2 || x.away));
});

test('no leaderboard on phones or the projector during the match', async () => {
  const st = await call('player_state', tok.Ben);
  assert.equal(st.leaderboard, undefined);
  const spec = (await one(`select spectator_token from arenas where id = $1`, [arena])).spectator_token;
  const sv = await call('spectator_state', spec);
  assert.equal(sv.leaderboard, undefined);
  assert.ok((sv.squads || []).every((q) => q.points === undefined));
});

test('demo squads (bots) are never flagged as away', async () => {
  const d = await call('demo_create', 1, 3, 'quick');
  const a = (await one(`select id from arenas where event_id = $1`, [d.event_id])).id;
  await db.query(`update arenas set phase = 'play' where id = $1`, [a]);
  await db.query(`update players set last_seen_at = now() - interval '10 minutes' where team_id in (select id from teams where arena_id = $1)`, [a]);
  await db.query(`update arenas set watch_at = null where id = $1`, [a]);
  await call('_squad_watch', a);
  assert.equal(Number((await one(`select count(*) n from players p join teams t on t.id = p.team_id where t.arena_id = $1 and p.away`, [a])).n), 0);
});
