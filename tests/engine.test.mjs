// Engine tests: runs the real migrations in an embedded Postgres (PGlite) and plays the game.
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let db;
const MIG = new URL(process.env.SQL_DIR || '../supabase/migrations/', import.meta.url);

async function call(fn, ...args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query(`select ${fn}(${ph}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  const out = r.rows[0].r;
  // some functions return {error} instead of raising so that audit/lockout rows are committed
  if (out && typeof out === 'object' && out.error && out.ok === undefined) throw new Error(out.error);
  return out;
}
async function fails(promise, code) {
  await assert.rejects(promise, (e) => { assert.match(e.message, new RegExp(code)); return true; });
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const tickNow = (arenaId) => db.query('update arenas set last_tick_at = null where id = $1', [arenaId]);
const idem = () => 'k' + Math.random().toString(36).slice(2) + Date.now();

// answers come straight from the database: the test is the only client allowed to see them
async function answersFor(instanceId) {
  const r = await one(`select mt.parts, mi.relay_key from mission_instances mi join mission_templates mt on mt.id = mi.template_id where mi.id = $1`, [instanceId]);
  return r.parts.map((p) => (p.accept[0] === '{KEY}' ? r.relay_key : p.accept[0]));
}

let host, ev, arena1, arena2;
const squads = {}; // number -> {tokens:{role:token}, id}

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;`);
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  }
});

test('content library loaded and every template has three role clues', async () => {
  const r = await one(`select count(*)::int n from mission_templates where status = 'published'`);
  assert.ok(r.n > 100);
  const bad = await all(`select id from mission_templates where not (clues ? 'scout' and clues ? 'decoder' and clues ? 'intel')`);
  assert.equal(bad.length, 0);
  const unreachable = await one(`select count(*)::int n from locations l where kind <> 'start' and _nearest_safe(l.id, 4) is null`);
  assert.equal(unreachable.n, 0);
  // every location can reach TR14
  const notr14 = await all(`select id from locations where kind <> 'start' and _nearest_safe(id, 5) <> 'tr14'`);
  assert.deepEqual(notr14, []);
});

test('host creates event; squads fill Map 1 (15) then overflow to Map 2', async () => {
  host = await call('host_create_event', 'HEXA26', 'Hexa Battlegrounds', 'supersecret', 2);
  ev = host.event_id;
  await fails(call('host_create_event', 'HEXA26', 'x', 'supersecret', 2), 'CODE_TAKEN');
  await fails(call('host_login', 'HEXA26', 'wrong'), 'HOST_AUTH');
  const login = await call('host_login', 'hexa26', 'supersecret');
  assert.ok(login.token);
  const pins = await call('host_generate_teams', host.token, 17);
  assert.equal(pins.length, 17);
  assert.equal(pins.filter((p) => p.map === 1).length, 15);
  assert.equal(pins.filter((p) => p.map === 2).length, 2);
  const arenas = await all(`select id, number from arenas where event_id = $1 order by number`, [ev]);
  arena1 = arenas[0].id; arena2 = arenas[1].id;
  for (const p of pins) squads[p.number] = { pin: p.pin, tokens: [] };
  const pinRow = await one(`select pin_hash from teams where number = 1`);
  assert.notEqual(pinRow.pin_hash, pins[0].pin, 'PIN must be stored hashed');
});

test('joining: exactly four distinct players, PIN checks, rejoin does not consume a slot', async () => {
  await fails(call('join_team', 'HEXA26', 1, '9999x', 'Eve', true, true, null), 'BAD_PIN');
  await fails(call('join_team', 'HEXA26', 1, squads[1].pin, 'Eve', false, true, null), 'CONSENT_REQUIRED');
  for (const n of [1, 2, 3, 16]) {
    for (const name of ['Asha', 'Ben', 'Chen', 'Divya']) {
      const r = await call('join_team', 'HEXA26', n, squads[n].pin, `${name}${n}`, true, true, null);
      squads[n].tokens.push(r.token);
    }
    squads[n].id = (await one(`select id from teams where event_id = $1 and number = $2`, [ev, n])).id;
  }
  const t1 = await one(`select ready, roster_locked from teams where number = 1`);
  assert.equal(t1.ready, true); assert.equal(t1.roster_locked, true);
  await fails(call('join_team', 'HEXA26', 1, squads[1].pin, 'Extra', true, true, null), 'ROSTER_LOCKED');
  const re = await call('join_team', 'HEXA26', 1, null, null, null, null, squads[1].tokens[0]);
  assert.equal(re.rejoined, true);
  assert.equal((await one(`select count(*)::int n from players p join teams t on t.id = p.team_id where t.number = 1`)).n, 4);
  // squad 4 has only one player → not ready
  await call('join_team', 'HEXA26', 4, squads[4].pin, 'Solo', true, true, null);
  assert.equal((await one(`select ready from teams where number = 4`)).ready, false);
});

test('PIN brute force is locked out', async () => {
  for (let i = 0; i < 8; i++) await fails(call('join_team', 'HEXA26', 5, '0000z', 'X', true, true, null), 'BAD_PIN');
  await fails(call('join_team', 'HEXA26', 5, squads[5].pin, 'X', true, true, null), 'LOCKED_OUT');
});

test('shuttle → Gate 1 → race-safe role claims → auto-fill', async () => {
  const r = await call('host_command', host.token, arena1, 'open_boarding', {}, null);
  assert.equal(r.ok, true);
  const buses = await all(`select number, bus from teams where arena_id = $1 and ready order by number`, [arena1]);
  assert.deepEqual(buses.map((b) => b.bus), [1, 1, 1]);
  await call('host_command', host.token, arena1, 'drive', {}, null);
  let s = await call('player_state', squads[1].tokens[0]);
  assert.equal(s.arena.phase, 'shuttle');
  await db.query(`update arenas set shuttle_arrive_at = now() - interval '1 second', last_tick_at = null where id = $1`, [arena1]);
  s = await call('player_state', squads[1].tokens[0]);
  assert.equal(s.arena.phase, 'roles');
  assert.equal(s.team.location, 'gate_1');

  const [p0, p1, p2] = squads[1].tokens;
  await call('claim_role', p0, 'captain');
  await fails(call('claim_role', p1, 'captain'), 'ROLE_TAKEN');
  await fails(call('claim_role', p0, 'scout'), 'ALREADY_HAS_ROLE');
  await call('claim_role', p1, 'scout');
  await call('claim_role', p2, 'decoder');
  // squads 2 and 3: only captain claimed; the rest auto-assigned when the timer ends
  await call('claim_role', squads[2].tokens[0], 'captain');
  await call('claim_role', squads[3].tokens[0], 'captain');
  await db.query(`update arenas set roles_deadline = now() - interval '1 second', last_tick_at = null where id = $1`, [arena1]);
  s = await call('player_state', squads[1].tokens[3]);
  assert.equal(s.arena.phase, 'play');
  assert.equal(s.me.role, 'intel');
  for (const n of [1, 2, 3]) {
    const roles = await all(`select role from players where team_id = $1 and active order by role`, [squads[n].id]);
    assert.deepEqual(roles.map((r) => r.role), ['captain', 'decoder', 'intel', 'scout']);
    const rows = await all(`select p.role from players p where p.team_id = $1 order by joined_at`, [squads[n].id]);
    squads[n].byRole = {};
    const toks = squads[n].tokens;
    rows.forEach((row, i) => { squads[n].byRole[row.role] = toks[i]; });
  }
});

test('only the captain can act; teammates get distinct clues and nobody gets answers', async () => {
  const sq = squads[1].byRole;
  await fails(call('captain_move', sq.scout, 'fountain'), 'NOT_CAPTAIN');
  await fails(call('captain_move', sq.captain, 'tr14'), 'NOT_CONNECTED');
  const mv = await call('captain_move', sq.captain, 'fountain');
  assert.ok(mv.seconds > 0);
  await fails(call('captain_move', sq.captain, 'hexadine'), 'BUSY');
  await db.query(`update teams set travel_arrive_at = now() - interval '1 second' where id = $1`, [squads[1].id]);
  await tickNow(arena1);
  const cap = await call('player_state', sq.captain);
  assert.equal(cap.team.location, 'fountain');
  assert.ok(cap.mission, 'arriving starts a mission');
  assert.ok(cap.mission.parts.length >= 1);
  assert.equal(cap.mission.clue, undefined, 'captain must not see teammate clues');
  const clues = {};
  for (const role of ['scout', 'decoder', 'intel']) {
    const st = await call('player_state', sq[role]);
    assert.ok(st.mission.clue.body);
    assert.equal(st.mission.parts, undefined);
    clues[role] = st.mission.clue.body;
    const answers = await answersFor(st.mission.id);
    const text = JSON.stringify(st);
    for (const a of answers) if (a && a.length > 3 && !/^\d+$/.test(a)) assert.ok(!text.includes(`"${a}"`), `${role} state leaks answer ${a}`);
  }
  assert.notEqual(clues.scout, clues.decoder);
  assert.notEqual(clues.decoder, clues.intel);
  squads[1].mission = cap.mission.id;
});

test('submission: wrong answers cost attempts, correct answer scores once (idempotent)', async () => {
  const sq = squads[1].byRole;
  const id = squads[1].mission;
  const parts = (await answersFor(id)).length;
  const before = await one(`select points, coins from teams where id = $1`, [squads[1].id]);
  await fails(call('captain_submit', sq.scout, id, Array(parts).fill('x'), idem()), 'NOT_CAPTAIN');
  const wrong = await call('captain_submit', sq.captain, id, Array(parts).fill('definitely wrong'), idem());
  assert.equal(wrong.correct, false);
  assert.equal(wrong.attempts_left, 2);
  const key = idem();
  const ok = await call('captain_submit', sq.captain, id, await answersFor(id), key);
  assert.equal(ok.correct, true);
  assert.equal(ok.status, 'solved');
  const replay = await call('captain_submit', sq.captain, id, await answersFor(id), key);
  assert.equal(replay.replayed, true);
  await fails(call('captain_submit', sq.captain, id, await answersFor(id), idem()), 'NOT_ACTIVE');
  const after = await one(`select points, coins, missions_completed from teams where id = $1`, [squads[1].id]);
  assert.ok(after.points - before.points >= 100);
  assert.equal(after.missions_completed, 1);
  const ledger = await all(`select * from ledger where team_id = $1 and kind = 'mission'`, [squads[1].id]);
  assert.equal(ledger.length, 1, 'reward applied exactly once');
  // forged rewards cannot be re-applied through the ledger
  assert.equal((await one(`select _apply($1, 'mission', 999, 0, 0, 0, $2, 'forged') as r`, [squads[1].id, id])).r, false);
});

test('explore limit per visit keeps squads moving', async () => {
  const sq = squads[1].byRole;
  const r = await call('captain_explore', sq.captain);
  assert.ok(r.instance);
  await db.query(`update mission_instances set status = 'cancelled' where id = $1`, [r.instance]);
  await fails(call('captain_explore', sq.captain), 'AREA_EXHAUSTED');
});

test('battle: squads at the same location duel; damage, rewards, cooldowns', async () => {
  const a = squads[1].byRole; const b = squads[2].byRole;
  await db.query(`update teams set location_id = 'fountain', dropped = true, state = 'idle' where id = $1`, [squads[2].id]);
  await db.query(`update mission_instances set status = 'cancelled' where team_id in ($1, $2) and status = 'active'`, [squads[1].id, squads[2].id]);
  await db.query(`delete from inventory where team_id = $1 and item_id = 'sniper'`, [squads[1].id]);
  // Phase 0/1: duels are locked server-side; host advances to Phase 2 (First Contact)
  await fails(call('captain_attack', a.captain, squads[2].id, 'pistol'), 'DUELS_LOCKED');
  assert.equal((await one(`select count(*)::int n from inventory where team_id = $1 and item_id = 'pistol' and qty = 1`, [squads[1].id])).n, 1, 'locked duel consumes nothing');
  const ph = await call('host_command', host.token, arena1, 'set_phase', { phase: 2 }, null);
  assert.equal(ph.ok, true);
  await call('host_command', host.token, arena1, 'zone_cancel', {}, null); // keep this test focused on battles
  await fails(call('captain_attack', a.captain, squads[2].id, 'sniper'), 'NO_ITEM');
  const bt = await call('captain_attack', a.captain, squads[2].id, 'pistol');
  assert.ok(bt.battle);
  await fails(call('captain_attack', a.captain, squads[2].id, 'pistol'), 'ALREADY_IN_BATTLE|COOLDOWN');
  const sb = await call('player_state', b.scout);
  assert.ok(sb.battle.clue, 'defender teammates get battle clues');
  const cb = await call('player_state', b.captain);
  const hpBefore = (await one(`select hp from teams where id = $1`, [squads[1].id])).hp;
  const res = await call('captain_submit', b.captain, cb.battle.id, await answersFor(cb.battle.id), idem());
  assert.equal(res.correct, true);
  const battle = await one(`select * from battles where id = $1`, [bt.battle]);
  assert.equal(battle.status, 'resolved');
  assert.equal(battle.winner_id, squads[2].id);
  const loser = await one(`select hp, attack_cooldown_until > now() as cd from teams where id = $1`, [squads[1].id]);
  assert.equal(loser.hp, hpBefore - 25);
  assert.equal(loser.cd, true);
  assert.equal((await one(`select battle_wins from teams where id = $1`, [squads[2].id])).battle_wins, 1);
  const ca = await call('player_state', a.captain);
  assert.equal(ca.battle, null);
  // the attacker's late correct answer cannot steal the result
  const inst = await one(`select id, status from mission_instances where battle_id = $1 and team_id = $2`, [bt.battle, squads[1].id]);
  assert.equal(inst.status, 'failed');
});

test('zero HP → recovery, never elimination; recovery respawns at 50 HP', async () => {
  const sq = squads[3].byRole;
  await db.query(`update teams set location_id = 'hexadine', dropped = true where id = $1`, [squads[3].id]);
  await db.query(`select _damage($1, 500, 'test', 'kill-1', 'test')`, [squads[3].id]);
  let s = await call('player_state', sq.captain);
  assert.equal(s.team.state, 'recovery');
  assert.equal(s.mission.kind, 'recovery');
  await fails(call('captain_move', sq.captain, 'fountain'), 'BUSY');
  const r = await call('captain_submit', sq.captain, s.mission.id, await answersFor(s.mission.id), idem());
  assert.equal(r.correct, true);
  s = await call('player_state', sq.captain);
  assert.equal(s.team.state, 'idle');
  assert.equal(s.team.hp, 50);
  const pen = await one(`select points from ledger where team_id = $1 and kind = 'recovery_penalty'`, [squads[3].id]);
  assert.equal(pen.points, -40);
});

test('recovery timeout is bounded (squad respawns anyway)', async () => {
  await db.query(`select _damage($1, 500, 'test', 'kill-2', 'test')`, [squads[3].id]);
  await db.query(`update teams set recovery_deadline = now() - interval '1 second' where id = $1`, [squads[3].id]);
  await tickNow(arena1);
  const s = await call('player_state', squads[3].byRole.scout);
  assert.equal(s.team.state, 'idle');
  assert.equal(s.team.hp, 50);
});

test('airdrop: two squads race, first correct answer wins, the other gets a consolation', async () => {
  const r = await call('host_command', host.token, arena1, 'spawn_airdrop', { location: 'hexadine', tier: 'legendary' }, null);
  const adId = r.result[arena1].airdrop;
  await db.query(`update teams set location_id = 'hexadine', state = 'idle' where id in ($1, $2)`, [squads[2].id, squads[3].id]);
  await db.query(`update mission_instances set status = 'cancelled' where team_id in ($1, $2) and status = 'active'`, [squads[2].id, squads[3].id]);
  const c2 = await call('captain_claim_airdrop', squads[2].byRole.captain, adId);
  const c3 = await call('captain_claim_airdrop', squads[3].byRole.captain, adId);
  await call('captain_submit', squads[3].byRole.captain, c3.instance, await answersFor(c3.instance), idem());
  const ad = await one(`select status, claimed_by from airdrops where id = $1`, [adId]);
  assert.equal(ad.status, 'claimed');
  assert.equal(ad.claimed_by, squads[3].id);
  const other = await one(`select status from mission_instances where id = $1`, [c2.instance]);
  assert.equal(other.status, 'cancelled');
  const inv = await one(`select qty from inventory where team_id = $1 and item_id = 'sniper'`, [squads[3].id]);
  assert.ok(inv.qty >= 1);
});

test('cross-team relay: partner holds the codeword; intel gets a backup after the timeout', async () => {
  const sq = squads[1].byRole;
  await db.query(`update mission_instances set status = 'cancelled' where team_id = $1 and status = 'active'`, [squads[1].id]);
  await db.query(`update teams set state = 'idle', attack_cooldown_until = null where id = $1`, [squads[1].id]);
  const tpl = (await one(`select id from mission_templates where kind = 'relay' limit 1`)).id;
  const r = await call('host_command', host.token, arena1, 'assign_mission', { team_id: squads[1].id, template_id: tpl }, null);
  const inst = r.result[arena1].instance;
  const mi = await one(`select * from mission_instances where id = $1`, [inst]);
  const partner = Object.values(squads).find((s) => s.id === mi.partner_team_id);
  const ps = await call('player_state', partner.byRole.captain);
  assert.ok(ps.codewords.some((c) => c.key === mi.relay_key), 'partner captain holds the codeword');
  let intel = await call('player_state', sq.intel);
  assert.equal(intel.mission.relay_backup, undefined);
  await db.query(`update mission_instances set fallback_at = now() - interval '1 second' where id = $1`, [inst]);
  intel = await call('player_state', sq.intel);
  assert.equal(intel.mission.relay_backup, mi.relay_key);
  const before = (await one(`select points from teams where id = $1`, [squads[1].id])).points;
  await call('captain_submit', sq.captain, inst, await answersFor(inst), idem());
  const after = (await one(`select points from teams where id = $1`, [squads[1].id])).points;
  assert.equal(after - before, 50, 'fallback path pays half');
});

test('cross-team chat is captain-only and rate-limited; block works', async () => {
  await fails(call('captain_chat', squads[1].byRole.scout, 2, 'hi'), 'NOT_CAPTAIN');
  await call('captain_chat', squads[1].byRole.captain, 2, 'Need your codeword?');
  let s = await call('player_state', squads[2].byRole.captain);
  assert.ok(s.comms.messages.some((m) => m.body === 'Need your codeword?'));
  const scout = await call('player_state', squads[2].byRole.scout);
  assert.equal(scout.comms, null);
  await call('captain_block', squads[2].byRole.captain, 1, true);
  await fails(call('captain_chat', squads[1].byRole.captain, 2, 'hello?'), 'BLOCKED');
  for (let i = 0; i < 5; i++) await call('captain_chat', squads[1].byRole.captain, 3, `m${i}`);
  await fails(call('captain_chat', squads[1].byRole.captain, 3, 'spam'), 'SLOW_DOWN');
});

test('alliances need both captains; attacking an ally is a betrayal', async () => {
  const a = squads[2].byRole; const b = squads[3].byRole;
  await call('captain_alliance', a.captain, 'propose', 3, null);
  const s = await call('player_state', b.captain);
  const al = s.alliances.find((x) => x.incoming);
  await call('captain_alliance', b.captain, 'accept', null, al.id);
  assert.equal((await one(`select status from alliances where id = $1`, [al.id])).status, 'active');
  await db.query(`update teams set location_id = 'hexadine', state = 'idle', protected_until = null, attack_cooldown_until = null where id in ($1, $2)`, [squads[2].id, squads[3].id]);
  await db.query(`update mission_instances set status = 'cancelled' where team_id in ($1, $2) and status = 'active'`, [squads[2].id, squads[3].id]);
  const trustBefore = (await one(`select trust from teams where id = $1`, [squads[2].id])).trust;
  await call('captain_attack', a.captain, squads[3].id, 'pistol');
  assert.equal((await one(`select status from alliances where id = $1`, [al.id])).status, 'betrayed');
  assert.equal((await one(`select trust from teams where id = $1`, [squads[2].id])).trust, trustBefore - 20);
  // let the battle time out as a draw
  await db.query(`update battles set deadline = now() - interval '1 second' where status = 'active'`);
  await tickNow(arena1);
  await call('player_state', a.scout);
  assert.equal((await one(`select count(*)::int n from battles where status = 'active'`)).n, 0);
});

test('pause freezes timers and resume shifts every deadline', async () => {
  const sq = squads[1].byRole;
  await db.query(`update teams set state = 'idle', location_id = 'fountain', visit_missions = 0 where id = $1`, [squads[1].id]);
  await db.query(`update mission_instances set status = 'cancelled' where team_id = $1 and status = 'active'`, [squads[1].id]);
  const r = await call('captain_explore', sq.captain);
  const d0 = (await one(`select deadline from mission_instances where id = $1`, [r.instance])).deadline;
  await call('host_command', host.token, arena1, 'pause', {}, null);
  await fails(call('captain_explore', sq.captain), 'PAUSED');
  await db.query(`update arenas set paused_at = paused_at - interval '30 seconds' where id = $1`, [arena1]);
  await call('host_command', host.token, arena1, 'resume', {}, null);
  const d1 = (await one(`select deadline from mission_instances where id = $1`, [r.instance])).deadline;
  assert.ok(new Date(d1) - new Date(d0) >= 29000);
});

test('zone collapses relocate squads safely; stage 5 leaves only TR14', async () => {
  await db.query(`update teams set location_id = 'cricket', state = 'idle' where id = $1`, [squads[1].id]);
  await call('host_command', host.token, arena1, 'zone_now', {}, null);
  let t = await one(`select location_id, hp from teams where id = $1`, [squads[1].id]);
  const loc = await one(`select collapse_stage from locations where id = $1`, [t.location_id]);
  assert.ok(loc.collapse_stage > 1);
  await fails(call('captain_move', squads[1].byRole.captain, 'pickleball'), 'DANGER_ZONE');
  for (let i = 0; i < 4; i++) await call('host_command', host.token, arena1, 'zone_now', {}, null);
  const locs = await all(`select distinct location_id from teams where arena_id = $1 and ready`, [arena1]);
  assert.deepEqual(locs.map((l) => l.location_id), ['tr14']);
  const z = await call('host_command', host.token, arena1, 'zone_now', {}, null);
  assert.equal(z.ok, false);
});

test('manual score changes require a reason and are audited', async () => {
  const bad = await call('host_command', host.token, arena1, 'adjust', { team_id: squads[2].id, points: 50 }, null);
  assert.equal(bad.ok, false);
  const ok = await call('host_command', host.token, arena1, 'adjust', { team_id: squads[2].id, points: 50 }, 'Dispute resolved in favour');
  assert.equal(ok.ok, true);
  const audit = await one(`select * from audit_log where action = 'adjust' and ok order by id desc limit 1`);
  assert.equal(audit.reason, 'Dispute resolved in favour');
  const failed = await one(`select count(*)::int n from audit_log where action = 'adjust' and not ok`);
  assert.equal(failed.n, 1);
});

test('finale: synchronized rounds for all squads, deterministic results, gated reveal', async () => {
  await call('host_command', host.token, arena1, 'begin_finale', {}, null);
  const r = await call('host_command', host.token, arena1, 'launch_sync', { kind: 'finale_entry' }, null);
  const round = r.result[arena1].round;
  const insts = await all(`select id, team_id from mission_instances where sync_round_id = $1`, [round]);
  assert.equal(insts.length, 3, 'every squad plays at once');
  // spectator sees progress but not scores during the finale
  const spec = (await one(`select spectator_token from arenas where id = $1`, [arena1])).spectator_token;
  let sv = await call('spectator_state', spec);
  assert.equal(sv.sync.total, 3);
  assert.equal(sv.squads[0].points, null);
  const capByTeam = Object.fromEntries(Object.values(squads).filter((s) => s.byRole).map((s) => [s.id, s.byRole.captain]));
  for (const i of insts.slice(0, 2)) {
    const res = await call('captain_submit', capByTeam[i.team_id], i.id, await answersFor(i.id), idem());
    assert.equal(res.correct, true);
    assert.ok(res.points >= 100 && res.points <= 200);
  }
  // exchange round pairs squads cyclically
  const ex = await call('host_command', host.token, arena1, 'launch_sync', { kind: 'finale_exchange' }, null);
  const exi = await all(`select team_id, partner_team_id from mission_instances where sync_round_id = $1`, [ex.result[arena1].round]);
  assert.ok(exi.every((x) => x.partner_team_id && x.partner_team_id !== x.team_id));
  await call('host_command', host.token, arena1, 'reveal_squad00', {}, null);
  sv = await call('spectator_state', spec);
  assert.ok(sv.recap && typeof sv.recap.betrayals === 'number');
  assert.equal(sv.recap.betrayals, 1);
  const lock0 = await call('host_command', host.token, arena1, 'reveal_winner', {}, null);
  assert.equal(lock0.ok, false, 'cannot reveal before locking');
  const locked = await call('host_command', host.token, arena1, 'lock_results', {}, null);
  const st = locked.result[arena1].standings;
  for (let i = 1; i < st.length; i++) assert.ok(st[i - 1].points >= st[i].points);
  sv = await call('spectator_state', spec);
  assert.equal(sv.results, null, 'standings stay hidden until the reveal');
  await call('host_command', host.token, arena1, 'reveal_winner', {}, null);
  sv = await call('spectator_state', spec);
  assert.equal(sv.results[0].number, st[0].number);
  const g = await call('host_command', host.token, null, 'reveal_grand', {}, null);
  assert.equal(g.ok, false, 'grand reveal waits for every map');
});

test('security: browser roles cannot read tables or call internals; spectators cannot act', async () => {
  await db.exec(`set role anon`);
  try {
    await fails(db.query(`select * from teams`), 'permission denied');
    await fails(db.query(`select * from mission_templates`), 'permission denied');
    await fails(db.query(`select _apply('00000000-0000-0000-0000-000000000000', 'x', 1)`), 'permission denied');
    await fails(db.query(`update teams set points = 99999`), 'permission denied');
    const ok = await db.query(`select map_data() is not null as ok`);
    assert.equal(ok.rows[0].ok, true);
  } finally {
    await db.exec(`reset role`);
  }
  const spec = (await one(`select spectator_token from arenas where id = $1`, [arena1])).spectator_token;
  await fails(call('host_overview', spec), 'HOST_AUTH');
  await fails(call('player_state', spec), 'AUTH');
  await fails(call('spectator_state', 'not-a-real-token-123456'), 'SPECTATOR_AUTH');
  await call('host_command', host.token, arena1, 'revoke_spectator', {}, null);
  await fails(call('spectator_state', spec), 'SPECTATOR_AUTH');
  // a captain cannot submit for another squad's mission
  const other = await one(`select id from mission_instances where team_id = $1 limit 1`, [squads[2].id]);
  await fails(call('captain_submit', squads[1].byRole.captain, other.id, ['x'], idem()), 'NOT_FOUND|NOT_IN_PLAY');
});

test('rehearsal reset returns a map to the lobby without losing squads', async () => {
  const r = await call('host_command', host.token, arena1, 'reset_arena', { confirm: 'RESET' }, null);
  assert.equal(r.ok, true);
  const a = await one(`select phase from arenas where id = $1`, [arena1]);
  assert.equal(a.phase, 'lobby');
  assert.equal((await one(`select count(*)::int n from players p join teams t on t.id = p.team_id where t.arena_id = $1`, [arena1])).n, 13);
  assert.equal((await one(`select sum(points)::int n from teams where arena_id = $1`, [arena1])).n, 0);
});
