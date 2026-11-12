// v8: online edition — employee ID + e-mail sign-in, squad codes, matchmaking, squads of 3 and 4,
// maps that open by themselves, merging small squads at take-off, squad chat, attendance.
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
let host; let ev; let n = 0;
const emp = () => String(9000000000 + ++n);
const join = (mode, code = null, name = null) => { const id = emp(); return call('online_join', 'ONL26', id, `p${id}@hexaware.com`, name || `Player ${n}`, mode, code, true, null).then((r) => ({ ...r, emp: id })); };
const sizes = async (arena) => (await all(`select (select count(*)::int from players p where p.team_id = t.id and p.active) n from teams t where t.arena_id = $1 order by 1 desc`, [arena])).map((r) => r.n);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const c = await call('host_create_event', 'ONL26', 'Online', 'onlinepass', 1);
  host = c.token; ev = c.event_id;
});

test('in-person events refuse the online sign-in', async () => {
  await fails(call('online_join', 'ONL26', '1234567890', 'a@hexaware.com', 'A', 'queue', null, true, null), 'NOT_ONLINE_EVENT');
  await call('host_settings', host, { online: 1, arena_size: 4, online_max_maps: 3, email_domain: 'hexaware.com' });
});

test('sign-in checks the employee ID and the company e-mail', async () => {
  await fails(call('online_join', 'ONL26', '12345', 'a@hexaware.com', 'A', 'queue', null, true, null), 'BAD_EMP_ID');
  await fails(call('online_join', 'ONL26', '1234567890', 'not-an-email', 'A', 'queue', null, true, null), 'BAD_EMAIL');
  await fails(call('online_join', 'ONL26', '1234567890', 'a@gmail.com', 'A', 'queue', null, true, null), 'EMAIL_DOMAIN');
  await fails(call('online_join', 'ONL26', '1234567890', 'a@hexaware.com', 'A', 'queue', null, false, null), 'CONSENT_REQUIRED');
});

let A; let arena1;
test('create a squad and share its code; friends join with it; a 5th is refused', async () => {
  A = await join('create', null, 'Asha');
  assert.match(A.code, /^[A-Z2-9]{4}$/);
  const b = await join('join', A.code.toLowerCase(), 'Ben'); assert.equal(b.team, A.team);
  assert.equal((await join('join', 'ZZZZ')).error, 'BAD_SQUAD_CODE');
  await join('join', A.code); await join('join', A.code);
  assert.equal((await join('join', A.code)).error, 'TEAM_FULL');
  const t = await one(`select * from teams where event_id = $1 and squad_code = $2`, [ev, A.code]);
  assert.equal(t.ready, true); assert.equal(t.roster_locked, true);
  arena1 = t.arena_id;
});

test('the same employee ID needs the same e-mail; rejoining moves the session to the new device', async () => {
  const r = await call('online_join', 'ONL26', A.emp, 'someone.else@hexaware.com', 'X', 'rejoin', null, true, null);
  assert.equal(r.error, 'EMP_ID_TAKEN');
  assert.equal((await call('online_join', 'ONL26', '1111111111', `p${A.emp}@hexaware.com`, 'X', 'queue', null, true, null)).error, 'EMAIL_TAKEN');
  const again = await call('online_join', 'ONL26', A.emp, `P${A.emp}@HEXAWARE.com`, 'Asha', 'rejoin', null, true, null);
  assert.equal(again.rejoined, true); assert.equal(again.code, A.code);
  await fails(call('player_state', A.token), 'AUTH');
  A.token = again.token;
  assert.equal((await call('player_state', A.token)).online.size, 4);
  assert.equal((await call('online_join', 'ONL26', '2222222222', 'new@hexaware.com', 'X', 'rejoin', null, true, null)).error, 'NOT_REGISTERED');
});

test('matchmaking fills squads of 4; a full map opens the next map by itself', async () => {
  const q = []; for (let i = 0; i < 6; i++) q.push(await join('queue'));
  assert.deepEqual(await sizes(arena1), [4, 4, 2]);
  assert.equal(q[0].team, q[3].team); assert.notEqual(q[3].team, q[4].team);
  const solo = await join('create');  // 4th squad on map 1 (arena_size 4)
  assert.deepEqual(await sizes(arena1), [4, 4, 2, 1]);
  const next = await join('create');
  const a2 = (await one(`select arena_id from teams where event_id = $1 and number = $2`, [ev, next.team])).arena_id;
  assert.notEqual(a2, arena1);
  assert.equal((await one(`select count(*)::int n from arenas where event_id = $1`, [ev])).n, 2);
  // matchmaking tops up the half-full open squad on map 1 first, then opens squads on map 2
  for (let i = 0; i < 8; i++) await join('queue');
  assert.deepEqual(await sizes(arena1), [4, 4, 4, 1]);
  assert.deepEqual(await sizes(a2), [4, 2, 1]);
  globalThis.a2 = a2; globalThis.solo = solo;
});

test('at take-off small squads are merged: a single borrows from squads of 4 (4,4,4,1 → 4,3,3,3) and 2 + 1 → 3', async () => {
  const r1 = await call('_online_seal', arena1);
  assert.deepEqual(await sizes(arena1), [4, 3, 3, 3]);
  assert.equal(r1.left_out, 0);
  const r2 = await call('_online_seal', globalThis.a2);
  assert.deepEqual(await sizes(globalThis.a2), [4, 3]);
  assert.equal(r2.left_out, 0);
  assert.equal((await one(`select count(*)::int n from teams t where t.event_id = $1 and not t.ready`, [ev])).n, 0, 'every squad left is ready');
  // the merged player was told in squad chat
  const st = await call('player_state', globalThis.solo.token);
  const chat = await call('squad_chat', globalThis.solo.token, 0);
  assert.ok(chat.some((c) => c.kind === 'system'));
  assert.equal(st.online.size, 3);
});

test('a full event refuses new squads once every map is full and the map limit is reached', async () => {
  await call('host_settings', host, { online_max_maps: 2 });
  let made = 0; let err = '';
  for (let i = 0; i < 6 && !err; i++) { try { await join('create'); made++; } catch (e) { err = String(e.message); } }
  assert.match(err, /ALL_MAPS_FULL/); assert.ok(made <= 2, `made ${made}`);
  await call('host_settings', host, { online_max_maps: 3 });
});

test('squad chat: messages and pings stay inside the squad; e-mails only go to teammates', async () => {
  const st = await call('player_state', A.token);
  assert.equal(st.online.squad.length, 4);
  assert.ok(st.online.squad.every((m) => /@hexaware\.com$/.test(m.email)));
  await call('squad_chat_send', A.token, 'Clue says 4-7-1', 'msg');
  await call('squad_chat_send', A.token, '📍 Come to EB1', 'ping');
  const c = await call('squad_chat', A.token, 0);
  assert.ok(c.some((m) => m.body === 'Clue says 4-7-1' && m.me));
  const other = await call('squad_chat', globalThis.solo.token, 0);
  assert.ok(!other.some((m) => m.body === 'Clue says 4-7-1'));
  const os = await call('player_state', globalThis.solo.token);
  assert.ok(!JSON.stringify(os).includes(`p${A.emp}@`), 'no other squad’s e-mails');
  await fails(call('squad_chat_send', A.token, '', 'msg'), 'BAD_MESSAGE');
  for (let i = 0; i < 4; i++) await call('squad_chat_send', A.token, 'spam ' + i, 'msg');
  await fails(call('squad_chat_send', A.token, 'too fast', 'msg'), 'SLOW_DOWN');
});

test('a squad of 3: the missing role goes to one player as a second role', async () => {
  const a2 = globalThis.a2;
  await db.query(`update arenas set phase = 'play' where id = $1`, [a2]);
  await db.query(`select _auto_roles($1)`, [a2]);
  const rows = await all(`select p.team_id, p.role, p.role2 from players p join teams t on t.id = p.team_id where t.arena_id = $1 and t.ready and p.active`, [a2]);
  const byTeam = {}; for (const r of rows) (byTeam[r.team_id] ||= []).push(r);
  for (const ps of Object.values(byTeam).filter((ps) => ps.length === 3)) {
    const covered = new Set(ps.flatMap((p) => [p.role, p.role2]).filter(Boolean));
    assert.equal(covered.size, 4, 'all four roles are covered');
    assert.equal(ps.filter((p) => p.role2).length, 1);
    assert.ok(!ps.some((p) => p.role === 'captain' && p.role2), 'the captain is not given a second role');
  }
  const holder = await one(`select p.id from players p join teams t on t.id = p.team_id where t.arena_id = $1 and p.role2 is not null limit 1`, [a2]);
  assert.ok(holder);
});

test('switching squads at the gate: from matchmaking to a friend’s code', async () => {
  const friend = await join('create', null, 'Friend');
  const me = await join('queue', null, 'Mover');
  const moved = await call('online_join', 'ONL26', me.emp, `p${me.emp}@hexaware.com`, 'Mover', 'join', friend.code, true, me.token);
  assert.equal(moved.code, friend.code); assert.equal(moved.token, me.token, 'same device keeps its session');
  assert.equal((await call('player_state', me.token)).online.size, 2);
});

test('host: attendance export and online summary', async () => {
  const att = await call('host_attendance', host);
  assert.ok(att.length >= 20, String(att.length));
  assert.ok(att.every((r) => /^[0-9]{10}$/.test(r.emp_id) && r.email && r.map));
  const sum = await call('host_online_summary', host);
  assert.equal(sum.players, att.length);
  assert.ok(sum.maps.length >= 2);
  // take-off through the host command seals the map first (map 1 now has the 2-player switch squad)
  await call('host_command', host, arena1, 'open_boarding', {}, null);
  await call('host_command', host, arena1, 'drive', {}, null);
  const s1 = await sizes(arena1);
  assert.ok(s1.every((x) => x >= 3), JSON.stringify(s1));
});
