// v14: Mavericks (employee ID) vs Segue (name, e-mail, college) sign-in; squad-code joining for any event.
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
let seg; let mav;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  seg = (await call('host_create_event', 'SEG26', 'Segue campus', 'segpass123', 1)).token;
  await call('host_settings', seg, { online: 1, segue: 1 });
  mav = (await call('host_create_event', 'MAV26', 'Mavericks', 'mavpass123', 1)).token;
  await call('host_settings', mav, { online: 1 });
});

test('the join page learns the audience without signing in', async () => {
  const s = await call('online_event_info', 'seg26');
  assert.equal(s.segue, true); assert.equal(s.online, true); assert.equal(s.name, 'Segue campus');
  assert.equal((await call('online_event_info', 'MAV26')).segue, false);
  assert.equal(await call('online_event_info', 'NOPE'), null);
});

test('Segue: name, e-mail and college; create a squad, friends join with its code, others use matchmaking', async () => {
  const a = await call('online_join_segue', 'SEG26', 'Asha@College.edu', 'Asha', 'PSG College of Technology', 'create', null, true, null);
  assert.match(a.code, /^[A-Z2-9]{4}$/);
  const b = await call('online_join_segue', 'SEG26', 'ben@college.edu', 'Ben', 'PSG College of Technology', 'join', a.code, true, null);
  assert.equal(b.team, a.team);
  const q = await call('online_join_segue', 'SEG26', 'chitra@other.edu', 'Chitra', 'SSN College', 'queue', null, true, null);
  assert.ok(q.token);
  await fails(call('online_join_segue', 'SEG26', 'd@x.edu', 'D', '', 'queue', null, true, null), 'BAD_COLLEGE');
  await fails(call('online_join_segue', 'SEG26', 'not-an-email', 'D', 'SSN', 'queue', null, true, null), 'BAD_EMAIL');
  // rejoin from another device with the same e-mail lands in the same squad
  const again = await call('online_join_segue', 'SEG26', 'asha@college.edu', 'Asha', 'PSG College of Technology', 'rejoin', null, true, null);
  assert.equal(again.rejoined, true); assert.equal(again.code, a.code);
});

test('the two sign-ins cannot be mixed up', async () => {
  await fails(call('online_join', 'SEG26', '1234567890', 'x@college.edu', 'X', 'queue', null, true, null), 'USE_SEGUE_SIGNIN');
  await fails(call('online_join_segue', 'MAV26', 'x@hexaware.com', 'X', 'Somewhere', 'queue', null, true, null), 'NOT_SEGUE_EVENT');
  const m = await call('online_join', 'MAV26', '1234567890', 'x@hexaware.com', 'X', 'create', null, true, null);
  assert.ok(m.code, 'Mavericks still sign in with employee ID');
});

test('attendance shows college for Segue (no internal key) and employee ID for Mavericks', async () => {
  const s = await call('host_attendance', seg);
  assert.equal(s.length, 3);
  assert.ok(s.every((r) => r.college && !('emp_id' in r) && r.email), JSON.stringify(s));
  const m = await call('host_attendance', mav);
  assert.equal(m[0].emp_id, '1234567890');
  assert.equal((await call('host_online_summary', seg)).segue, true);
});
