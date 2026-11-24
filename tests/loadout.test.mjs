// v16: one big map, Free Fire style loot (guns + ammo, armour, jammers, scaled medkits), eliminations, comms.
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
let n = 0;
const tokens = [];
const join = async (ev) => { const id = String(9100000000 + ++n); const r = await call('online_join', ev, id, `l${id}@x.com`, `L${n}`, 'queue', null, true, null); tokens.push(r.token); return r; };

let host, arena, teams;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
});

test('one map for everyone: 120 players start together on a single map', async () => {
  host = (await call('host_create_event', 'BIG1', 'Big', 'bigpass1234', 1)).token;
  await call('host_settings', host, { online: 1, arena_size: 35, online_max_maps: 1, game_minutes: 60 });
  for (let i = 0; i < 120; i++) await join('BIG1');
  const r = await call('host_online_start', host, '60');
  assert.equal(r.maps, 1);
  assert.equal(r.squads, 30);
  const maps = await all(`select a.id, (select count(*)::int from teams t where t.arena_id = a.id and t.ready) n from arenas a join events e on e.id = a.event_id where e.code = 'BIG1' and a.phase <> 'lobby'`);
  assert.equal(maps.length, 1); assert.equal(maps[0].n, 30);
  arena = maps[0].id;
  teams = (await all(`select id, number from teams where arena_id = $1 and ready order by number`, [arena]));
  // roles as they are dealt at take-off: one captain, scout, decoder, intel per squad
  await db.query(`update players p set role = r.role from (select id, (array['captain','scout','decoder','intel'])[row_number() over (partition by team_id order by joined_at)] as role
    from players where team_id in (select id from teams where arena_id = $1)) r where r.id = p.id`, [arena]);
  const st = (await one(`select settings from events where code = 'BIG1'`)).settings;
  assert.equal(st.finale_minute, 38, 'the 1-hour preset applies');
});

test('loot is scattered and scales with the squads on the map', async () => {
  await call('_spawn_pickups', arena);
  const c = Object.fromEntries((await all(`select kind, count(*)::int n from pickups where arena_id = $1 and taken_at is null group by kind`, [arena])).map((r) => [r.kind, r.n]));
  assert.equal(c.medkit, 48, '24 per 15 squads × 2');
  for (const k of ['ammo_light', 'ammo_rifle', 'ammo_shell', 'gun_smg', 'gun_shotgun', 'gun_ar', 'gun_sniper', 'vest1', 'vest3', 'helmet2', 'jammer']) assert.ok(c[k] > 0, `${k} on the map`);
  const up = await one(`select count(*)::int n from pickups where arena_id = $1 and kind = 'vest3' and level = 0 and bldg is null and not exists (select 1 from buildings b where x between b.x0 and b.x1 and y between b.y0 and b.y1)`, [arena]);
  assert.ok(up.n <= 2, 'level-3 vests lie in or by buildings');
});

test('pick up guns, ammo, armour and a jammer by walking over them', async () => {
  const t = teams[0].id;
  await db.query(`update teams set pos_x = 0.5, pos_y = 0.5, level = 0, bldg = null where id = $1`, [t]);
  for (const k of ['gun_ar', 'vest2', 'helmet1', 'jammer', 'ammo_shell']) await db.query(`insert into pickups(arena_id, kind, x, y, level) values ($1, $2, 0.5, 0.501, 0)`, [arena, k]);
  const got = await call('_take_pickups', t, 0.5, 0.5);
  assert.deepEqual([...got].sort(), ['ammo_shell', 'gun_ar', 'helmet1', 'jammer', 'vest2']);
  const tm = await one(`select vest_lvl, helmet_lvl, weapon_sel from teams where id = $1`, [t]);
  assert.deepEqual(tm, { vest_lvl: 2, helmet_lvl: 1, weapon_sel: 'ar' });
  const inv = Object.fromEntries((await all(`select item_id, qty from inventory where team_id = $1`, [t])).map((r) => [r.item_id, r.qty]));
  assert.equal(inv.ar, 1); assert.ok(inv.ammo_rifle >= 60); assert.equal(inv.jammer, 1); assert.equal(inv.ammo_shell, 10);
  assert.equal((await call('_weapon', t)).id, 'ar');
  // a worse vest is left for someone else
  await db.query(`insert into pickups(arena_id, kind, x, y, level) values ($1, 'vest1', 0.5, 0.5, 0)`, [arena]);
  assert.equal(await call('_take_pickups', t, 0.5, 0.5), null);
});

test('armour cuts gunfire damage, not zone damage', async () => {
  const t = teams[1].id;
  await db.query(`update teams set vest_lvl = 3, helmet_lvl = 3, hp = 100, shield = 0, state = 'idle' where id = $1`, [t]);
  await call('_damage', t, 10, 'gunfire', 'g1', 'test');
  assert.equal((await one(`select hp from teams where id = $1`, [t])).hp, 94, '10 × 0.55 → 6');
  await call('_damage', t, 10, 'zone', 'z1', 'test');
  assert.equal((await one(`select hp from teams where id = $1`, [t])).hp, 84);
});

test('shots use ammo; an empty gun falls back to the pistol; a knockout pays 100 and drops a death box', async () => {
  const [A, B] = [teams[0], teams[2]];
  await db.query(`update arenas set phase = 'play', match_phase = 2, paused = false where id = $1`, [arena]);
  await db.query(`update teams set dropped = true, state = 'idle', level = 0, bldg = null, protected_until = null, pos_at = now() - interval '5 seconds', vel_x = 0, vel_y = 0 where id in ($1, $2)`, [A.id, B.id]);
  await db.query(`update teams set pos_x = 0.30, pos_y = 0.62 where id = $1`, [A.id]);
  await db.query(`update teams set pos_x = 0.31, pos_y = 0.62, hp = 3, shield = 0, vest_lvl = 0, helmet_lvl = 0 where id = $1`, [B.id]);
  // find a token that belongs to team A
  let myTok = null;
  for (const k of tokens) { const r = await one(`select p.team_id from players p where p.session_hash = _hash($1)`, [k]); if (r?.team_id === A.id) { myTok = k; break; } }
  assert.ok(myTok);
  const before = (await one(`select qty from inventory where team_id = $1 and item_id = 'ammo_rifle'`, [A.id])).qty;
  let r; let k = 0;
  do { await db.query(`update players set shot_at = null, reload_until = null where team_id = $1`, [A.id]); r = await call('squad_fire', myTok, B.id); k++; } while (!r.knocked && k < 40);
  assert.equal(r.knocked, true, 'knocked out');
  assert.equal(r.elimination.points, 100);
  const after = (await one(`select qty from inventory where team_id = $1 and item_id = 'ammo_rifle'`, [A.id])).qty;
  assert.equal(before - after, k, 'one round per shot');
  const box = await all(`select kind from pickups where arena_id = $1 and taken_at is null and abs(x - 0.31) < 0.01 and abs(y - 0.62) < 0.01 and kind in ('ammo_rifle','ammo_light','medkit')`, [arena]);
  assert.ok(box.length >= 3, 'death box on the ground');
  assert.ok((await one(`select points from teams where id = $1`, [A.id])).points >= 100);
  // empty the rifle ammo: the squad fires the pistol
  await db.query(`update inventory set qty = 0 where team_id = $1 and item_id = 'ammo_rifle'`, [A.id]);
  assert.equal((await call('_weapon', A.id)).id, 'pistol');
  await fails(call('squad_equip', myTok, 'ar'), 'NO_AMMO');
  assert.equal((await call('squad_equip', myTok, 'pistol')).weapon.id, 'pistol');
});

test('captains: All captains broadcast (rate-limited) and squad chat', async () => {
  const capTeam = teams[3];
  let capTok = null;
  for (const k of tokens) { const r = await one(`select p.team_id, p.role from players p where p.session_hash = _hash($1)`, [k]); if (r?.team_id === capTeam.id && r.role === 'captain') { capTok = k; break; } }
  const r = await call('captain_chat', capTok, 0, 'Truce until the final circle?');
  assert.equal(r.to, 29);
  const got = await one(`select count(*)::int n from chat_messages where from_team = $1 and body = '📢 Truce until the final circle?'`, [capTeam.id]);
  assert.equal(got.n, 29);
  await fails(call('captain_chat', capTok, 0, 'again'), 'SLOW_DOWN');
  assert.equal((await call('captain_chat', capTok, teams[4].number, 'Ally?')).sent, true, 'direct message still works');
  await call('squad_chat_send', capTok, 'Push to Hexavarsity', 'msg');
  const sc = await call('squad_chat', capTok, 0);
  assert.equal(sc.at(-1).body, 'Push to Hexavarsity');
});

test('the sender sees one copy of its broadcast; recipients see it once each', async () => {
  const capTeam = teams[3];
  let capTok = null; let otherTok = null;
  for (const k of tokens) {
    const r = await one(`select p.team_id, p.role from players p where p.session_hash = _hash($1)`, [k]);
    if (r?.team_id === capTeam.id && r.role === 'captain') capTok = k;
    if (r?.team_id === teams[5].id && r.role === 'captain') otherTok = k;
  }
  const mine = (await call('player_state', capTok)).comms.messages.filter((m) => m.body.startsWith('📢'));
  assert.equal(mine.length, 1);
  const theirs = (await call('player_state', otherTok)).comms.messages.filter((m) => m.body.startsWith('📢'));
  assert.equal(theirs.length, 1); assert.equal(theirs[0].from_number, capTeam.number);
});
