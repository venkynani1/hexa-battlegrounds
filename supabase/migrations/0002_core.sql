-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — core engine (internal functions, not callable by clients)
-- ════════════════════════════════════════════════════════════════════════════

create or replace function _hash(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $$;

create or replace function _norm(t text) returns text
language sql immutable as $$ select regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g') $$;

create or replace function _new_token() returns text
language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function _secs(n numeric) returns interval
language sql immutable as $$ select make_interval(secs => n::double precision) $$;

-- Default balancing values. Hosts override any key through event settings.
create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 10, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 15,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0
) $$;

create or replace function _cfg(p_event uuid, k text) returns int language sql stable as $$
  select coalesce((select (settings ->> k)::int from events where id = p_event), (_defaults() ->> k)::int)
$$;

create or replace function _cfg_text(p_event uuid, k text) returns text language sql stable as $$
  select coalesce((select settings ->> k from events where id = p_event), _defaults() ->> k)
$$;

-- Realtime: send a tiny "something changed" ping. Payloads never carry game
-- secrets; clients re-fetch their own filtered state through an RPC.
create or replace function _ping(p_topic text, p_kind text default 'state') returns void
language plpgsql as $$
begin
  perform realtime.send(jsonb_build_object('k', p_kind), 'ping', p_topic, false);
exception when others then
  null; -- realtime not available (local tests) — clients fall back to polling
end $$;

-- Arena-wide pings reach every phone on the map, so frequent low-priority kinds are
-- coalesced to at most one per 1.5 s (clients also poll, so nothing is lost).
create or replace function _ping_arena(p_arena uuid, p_kind text default 'state') returns void
language plpgsql as $$
begin
  if p_kind in ('score', 'move', 'roster', 'threat', 'intel') then
    update arenas set last_ping_at = now()
    where id = p_arena and (last_ping_at is null or last_ping_at < now() - interval '1500 milliseconds');
    if not found then return; end if;
  end if;
  perform _ping('arena-' || p_arena::text, p_kind);
end $$;

create or replace function _ping_team(p_team uuid, p_kind text default 'state') returns void
language sql as $$ select _ping('team-' || p_team::text, p_kind) $$;

create or replace function _feed(p_arena uuid, p_type text, p_payload jsonb default '{}'::jsonb) returns void
language sql as $$ insert into game_feed(arena_id, type, payload) values (p_arena, p_type, p_payload) $$;

create or replace function _event_of_arena(p_arena uuid) returns uuid
language sql stable as $$ select event_id from arenas where id = p_arena $$;

-- ── Ledger: the only way resources change ─────────────────────────────────────
-- Returns false (and changes nothing) if this (team, kind, ref) was already applied.
create or replace function _apply(
  p_team uuid, p_kind text, p_points int default 0, p_coins int default 0, p_hp int default 0,
  p_trust int default 0, p_ref text default null, p_reason text default null, p_actor text default 'system'
) returns boolean language plpgsql as $$
declare t teams; v_id bigint; v_max int;
begin
  select * into t from teams where id = p_team for update;
  insert into ledger(arena_id, team_id, kind, points, coins, hp, trust, ref, reason, actor)
  values (t.arena_id, p_team, p_kind, p_points, p_coins, p_hp, p_trust, p_ref, p_reason, p_actor)
  on conflict (team_id, kind, ref) where ref is not null do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  v_max := _cfg(t.event_id, 'hp_max');
  update teams set
    points = points + p_points,
    coins = greatest(0, coins + p_coins),
    hp = least(v_max, greatest(0, hp + p_hp)),
    trust = trust + p_trust
  where id = p_team;
  return true;
end $$;

-- Damage goes through the shield first. Zero HP sends the squad to Recovery.
create or replace function _damage(p_team uuid, p_amount int, p_kind text, p_ref text, p_reason text)
returns int language plpgsql as $$
declare t teams; v_absorb int; v_hp int;
begin
  select * into t from teams where id = p_team for update;
  if t.state = 'recovery' or p_amount <= 0 then return 0; end if;
  v_absorb := least(t.shield, p_amount);
  if v_absorb > 0 then update teams set shield = shield - v_absorb where id = p_team; end if;
  v_hp := p_amount - v_absorb;
  if v_hp > 0 then
    if not _apply(p_team, p_kind, 0, 0, -v_hp, 0, p_ref, p_reason) then return 0; end if;
  end if;
  select * into t from teams where id = p_team;
  if t.hp <= 0 and t.state <> 'recovery' then perform _enter_recovery(p_team); end if;
  return v_hp;
end $$;

create or replace function _add_item(p_team uuid, p_item text, p_qty int default 1) returns void
language sql as $$
  insert into inventory(team_id, item_id, qty) values (p_team, p_item, greatest(0, p_qty))
  on conflict (team_id, item_id) do update set qty = greatest(0, inventory.qty + p_qty)
$$;

-- ── Map helpers ───────────────────────────────────────────────────────────────
create or replace function _is_neighbor(p_a text, p_b text) returns int
language sql stable as $$
  select seconds from edges where (a = p_a and b = p_b) or (a = p_b and b = p_a) limit 1
$$;

-- Nearest location (fewest hops, then shortest travel) that is safe at the given stage.
create or replace function _nearest_safe(p_from text, p_stage int) returns text
language plpgsql stable as $$
declare visited text[]; frontier text[]; nxt text[]; v_hit text; i int;
begin
  if p_from is null then p_from := 'hx_lobby'; end if;
  visited := array[p_from]; frontier := array[p_from];
  for i in 1..20 loop
    select l.id into v_hit from locations l
    where l.id = any(frontier) and l.collapse_stage > p_stage and l.enabled and l.kind <> 'start'
    order by l.collapse_stage desc, l.id limit 1;
    if v_hit is not null then return v_hit; end if;
    select coalesce(array_agg(distinct n), '{}') into nxt from (
      select case when e.a = any(frontier) then e.b else e.a end as n
      from edges e where e.a = any(frontier) or e.b = any(frontier)
    ) s where not (n = any(visited));
    if array_length(nxt, 1) is null then exit; end if;
    visited := visited || nxt; frontier := nxt;
  end loop;
  return 'tr14';
end $$;

-- ── Mission selection & creation ──────────────────────────────────────────────
create or replace function _pick_template(p_team uuid, p_kind text, p_tags text[]) returns text
language plpgsql stable as $$
declare t teams; v_seed int; v text;
begin
  select * into t from teams where id = p_team;
  select mission_seed into v_seed from events where id = t.event_id;
  select mt.id into v from mission_templates mt
  where mt.kind = p_kind and mt.status = 'published'
    and not exists (select 1 from mission_instances mi where mi.team_id = p_team and mi.template_id = mt.id)
  order by (mt.tags && coalesce(p_tags, '{}')) desc, md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
  limit 1;
  if v is null then
    select mt.id into v from mission_templates mt
    where mt.kind = p_kind and mt.status = 'published'
    order by (mt.tags && coalesce(p_tags, '{}')) desc, md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
    limit 1;
  end if;
  return v;
end $$;

create or replace function _codeword(p_seed text) returns text language sql immutable as $$
  select (array['FALCON','TIGER','COBRA','RAVEN','VIPER','ORCA','LYNX','MANTIS','HAWK','BISON','JAGUAR',
                'PANTHER','CONDOR','IBIS','OTTER','PUMA','KESTREL','WOLF','GECKO','MARLIN'])
         [1 + abs(hashtext(p_seed)) % 20]
$$;

create or replace function _start_instance(
  p_team uuid, p_template text, p_location text default null, p_battle uuid default null,
  p_airdrop uuid default null, p_sync uuid default null, p_deadline timestamptz default null,
  p_partner uuid default null
) returns uuid language plpgsql as $$
declare t teams; mt mission_templates; v_id uuid; v_partner uuid; v_key text; v_seed int;
begin
  select * into t from teams where id = p_team for update;
  select * into mt from mission_templates where id = p_template;
  if mt.id is null then raise exception 'NO_TEMPLATE'; end if;
  select mission_seed into v_seed from events where id = t.event_id;
  if mt.relay then
    v_partner := p_partner;
    if v_partner is null then
      select x.id into v_partner from teams x
      where x.arena_id = t.arena_id and x.ready and x.id <> t.id
      order by md5(v_seed::text || t.id::text || x.id::text || t.mission_counter::text) limit 1;
    end if;
    v_key := _codeword(v_seed::text || t.id::text || t.mission_counter::text);
  end if;
  insert into mission_instances(arena_id, team_id, template_id, template_version, kind, location_id, battle_id,
    airdrop_id, sync_round_id, attempts_left, deadline, partner_team_id, relay_key, fallback_at)
  values (t.arena_id, t.id, mt.id, mt.version, mt.kind, coalesce(p_location, t.location_id), p_battle, p_airdrop, p_sync,
    mt.attempts, coalesce(p_deadline, now() + _secs(mt.time_limit)), v_partner, v_key,
    case when mt.relay and v_partner is not null then now() + _secs(_cfg(t.event_id, 'intel_fallback'))
         when mt.relay then now() end)
  returning id into v_id;
  update teams set mission_counter = mission_counter + 1,
    visit_missions = visit_missions + case when mt.kind in ('mission', 'relay') then 1 else 0 end
  where id = t.id;
  perform _ping_team(t.id, 'mission');
  if v_partner is not null then perform _ping_team(v_partner, 'intel'); end if;
  return v_id;
end $$;

-- Start an exploration mission at the squad's current location.
create or replace function _start_location_mission(p_team uuid) returns uuid
language plpgsql as $$
declare t teams; l locations; v_kind text := 'mission'; v_tpl text; v_seed int; v_others int;
begin
  select * into t from teams where id = p_team;
  select * into l from locations where id = t.location_id;
  select mission_seed into v_seed from events where id = t.event_id;
  select count(*) into v_others from teams where arena_id = t.arena_id and ready and id <> t.id;
  if v_others > 0 and (
       l.tags && array['social', 'public', 'market']
       or abs(hashtext(v_seed::text || t.id::text || t.mission_counter::text)) % 100 < _cfg(t.event_id, 'relay_chance'))
  then v_kind := 'relay'; end if;
  v_tpl := _pick_template(p_team, v_kind, l.tags || array['any']);
  if v_tpl is null then v_tpl := _pick_template(p_team, 'mission', l.tags || array['any']); end if;
  if v_tpl is null then return null; end if;
  return _start_instance(p_team, v_tpl, t.location_id);
end $$;

-- ── Recovery (zero HP never eliminates) ───────────────────────────────────────
create or replace function _enter_recovery(p_team uuid) returns void
language plpgsql as $$
declare t teams; v_tpl text;
begin
  select * into t from teams where id = p_team for update;
  if t.state = 'recovery' then return; end if;
  update mission_instances set status = 'cancelled' where team_id = p_team and status = 'active' and kind <> 'battle' and sync_round_id is null;
  update teams set state = 'recovery', travel_to = null, travel_arrive_at = null,
    recovery_deadline = now() + _secs(_cfg(t.event_id, 'recovery_seconds'))
  where id = p_team;
  perform _apply(p_team, 'recovery_penalty', -_cfg(t.event_id, 'pen_recovery'), 0, 0, 0, null, 'HP reached zero');
  if not exists (select 1 from mission_instances where team_id = p_team and status = 'active' and kind <> 'battle') then
    v_tpl := _pick_template(p_team, 'recovery', array['any']);
    if v_tpl is not null then
      perform _start_instance(p_team, v_tpl, null, null, null, null, now() + _secs(_cfg(t.event_id, 'recovery_seconds')));
    end if;
  end if;
  perform _feed(t.arena_id, 'recovery.started', jsonb_build_object('team', t.number));
  perform _ping_team(p_team, 'recovery');
end $$;

create or replace function _respawn(p_team uuid, p_reason text) returns void
language plpgsql as $$
declare t teams;
begin
  select * into t from teams where id = p_team for update;
  if t.state <> 'recovery' then return; end if;
  update mission_instances set status = case when status = 'active' then 'expired' else status end
  where team_id = p_team and kind = 'recovery' and status = 'active';
  update teams set state = 'idle', recovery_deadline = null, hp = _cfg(t.event_id, 'hp_respawn'),
    protected_until = now() + _secs(_cfg(t.event_id, 'protect_seconds'))
  where id = p_team;
  perform _feed(t.arena_id, 'recovery.completed', jsonb_build_object('team', t.number, 'how', p_reason));
  perform _ping_team(p_team, 'recovery');
end $$;

-- ── Battles ───────────────────────────────────────────────────────────────────
create or replace function _resolve_battle(p_battle uuid, p_winner uuid) returns void
language plpgsql as $$
declare b battles; v_loser uuid; ta teams; tb teams; v_dealt int := 0; v_ev uuid;
begin
  select * into b from battles where id = p_battle for update;
  if b.status <> 'active' then return; end if;
  v_ev := _event_of_arena(b.arena_id);
  update battles set status = 'resolved', winner_id = p_winner, resolved_at = now() where id = b.id;
  if p_winner is not null then
    v_loser := case when p_winner = b.attacker_id then b.defender_id else b.attacker_id end;
    update mission_instances set status = 'solved', solved_at = now() where battle_id = b.id and team_id = p_winner and status = 'active';
    update mission_instances set status = 'failed' where battle_id = b.id and team_id = v_loser and status = 'active';
    perform _apply(p_winner, 'battle_win', _cfg(v_ev, 'pts_battle'), 20, 0, 0, b.id::text, 'Battle victory');
    update teams set battle_wins = battle_wins + 1 where id = p_winner;
    update mission_instances set points_awarded = _cfg(v_ev, 'pts_battle') where battle_id = b.id and team_id = p_winner;
    v_dealt := _damage(v_loser, b.damage, 'battle_damage', b.id::text, 'Lost a battle');
  else
    update mission_instances set status = 'expired' where battle_id = b.id and status = 'active';
  end if;
  -- cooldowns: attacker can't attack again for a while; both get brief protection
  update teams set attack_cooldown_until = now() + _secs(_cfg(v_ev, 'attack_cooldown')) where id = b.attacker_id;
  update teams set protected_until = now() + _secs(_cfg(v_ev, 'protect_seconds')) where id in (b.attacker_id, b.defender_id);
  select * into ta from teams where id = b.attacker_id;
  select * into tb from teams where id = b.defender_id;
  perform _feed(b.arena_id, 'battle.resolved', jsonb_build_object(
    'attacker', ta.number, 'defender', tb.number, 'weapon', b.weapon,
    'winner', (select number from teams where id = p_winner), 'damage', v_dealt));
  perform _ping_team(b.attacker_id, 'battle');
  perform _ping_team(b.defender_id, 'battle');
end $$;

-- ── Standings (deterministic; ties flagged for a tiebreaker challenge) ────────
create or replace function _standings(p_arena uuid) returns jsonb
language sql stable as $$
  with s as (
    select t.id, t.number, t.name, t.points, t.final_points, t.missions_completed, t.battle_wins, t.arena_id,
      (select number from arenas a where a.id = t.arena_id) as arena_number,
      rank() over (order by t.points desc, t.final_points desc, t.missions_completed desc, t.battle_wins desc) as rnk
    from teams t where t.ready and t.arena_id = p_arena
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', rnk, 'team_id', id, 'number', number, 'name', name, 'points', points, 'final_points', final_points,
    'missions', missions_completed, 'battles', battle_wins, 'arena', arena_number,
    'tie', (select count(*) from s s2 where s2.rnk = s.rnk) > 1
  ) order by rnk, number), '[]'::jsonb) from s
$$;

create or replace function _event_standings(p_event uuid) returns jsonb
language sql stable as $$
  with s as (
    select t.id, t.number, t.name, t.points, t.final_points, t.missions_completed, t.battle_wins,
      (select number from arenas a where a.id = t.arena_id) as arena_number,
      rank() over (order by t.points desc, t.final_points desc, t.missions_completed desc, t.battle_wins desc) as rnk
    from teams t where t.ready and t.event_id = p_event
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', rnk, 'team_id', id, 'number', number, 'name', name, 'points', points, 'final_points', final_points,
    'missions', missions_completed, 'battles', battle_wins, 'arena', arena_number,
    'tie', (select count(*) from s s2 where s2.rnk = s.rnk) > 1
  ) order by rnk, number), '[]'::jsonb) from s
$$;

-- ── Zone ──────────────────────────────────────────────────────────────────────
create or replace function _apply_zone(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; t record; v_safe text;
begin
  select * into a from arenas where id = p_arena;
  for t in
    select tm.* from teams tm join locations l on l.id = tm.location_id
    where tm.arena_id = p_arena and tm.ready and l.collapse_stage <= a.zone_stage and tm.state <> 'traveling'
    for update of tm
  loop
    v_safe := _nearest_safe(t.location_id, a.zone_stage);
    if t.state <> 'recovery' and t.zone_penalty_stage < a.zone_stage then
      perform _damage(t.id, _cfg(a.event_id, 'dmg_zone'), 'zone_damage', 'zone-' || a.zone_stage, 'Caught outside the safe zone');
    end if;
    update teams set location_id = v_safe, zone_penalty_stage = greatest(zone_penalty_stage, a.zone_stage), visit_missions = 0
    where id = t.id;
    perform _feed(p_arena, 'zone.relocated', jsonb_build_object('team', t.number, 'to', v_safe));
    perform _ping_team(t.id, 'zone');
  end loop;
  -- squads travelling into a collapsed location are redirected
  for t in
    select tm.* from teams tm join locations l on l.id = tm.travel_to
    where tm.arena_id = p_arena and tm.state = 'traveling' and l.collapse_stage <= a.zone_stage
    for update of tm
  loop
    update teams set travel_to = _nearest_safe(t.travel_to, a.zone_stage) where id = t.id;
    perform _ping_team(t.id, 'zone');
  end loop;
end $$;

create or replace function _zone_advance(p_arena uuid) returns void
language plpgsql as $$
declare a arenas;
begin
  update arenas set zone_stage = least(5, zone_stage + 1), zone_next_at = null where id = p_arena returning * into a;
  perform _feed(p_arena, 'zone.collapsed', jsonb_build_object('stage', a.zone_stage));
  perform _apply_zone(p_arena);
end $$;

-- ── Airdrops ──────────────────────────────────────────────────────────────────
create or replace function _spawn_airdrop(p_arena uuid, p_location text, p_tier text) returns uuid
language plpgsql as $$
declare a arenas; v_loc text := p_location; v_tpl text; v_id uuid; v_tier text := coalesce(p_tier, 'common');
begin
  select * into a from arenas where id = p_arena;
  if v_loc is null then
    select id into v_loc from locations
    where enabled and collapse_stage > a.zone_stage + 1 and kind <> 'start' and id <> 'tr14'
    order by (tags && array['airdrop', 'public']) desc, random() limit 1;
    if v_loc is null then v_loc := 'tr14'; end if;
  end if;
  select id into v_tpl from mission_templates where kind = 'airdrop' and status = 'published'
  and id not in (select template_id from airdrops where arena_id = p_arena)
  order by random() limit 1;
  if v_tpl is null then
    select id into v_tpl from mission_templates where kind = 'airdrop' and status = 'published' order by random() limit 1;
  end if;
  if v_tpl is null then raise exception 'NO_AIRDROP_TEMPLATE'; end if;
  insert into airdrops(arena_id, location_id, tier, template_id, expires_at)
  values (p_arena, v_loc, v_tier, v_tpl, now() + _secs(_cfg(a.event_id, 'airdrop_window')))
  returning id into v_id;
  update arenas set last_airdrop_at = now() where id = p_arena;
  perform _feed(p_arena, 'airdrop.spawned', jsonb_build_object('location', v_loc, 'tier', v_tier));
  return v_id;
end $$;

-- ── Roles ─────────────────────────────────────────────────────────────────────
create or replace function _finalize_roles(p_arena uuid) returns void
language plpgsql as $$
declare t record; p record; v_missing text[];
begin
  for t in select * from teams where arena_id = p_arena and ready loop
    select array_agg(r) into v_missing from unnest(array['captain', 'scout', 'decoder', 'intel']) r
    where not exists (select 1 from players where team_id = t.id and active and role = r);
    if v_missing is null then continue; end if;
    for p in select * from players where team_id = t.id and active and role is null order by joined_at loop
      exit when array_length(v_missing, 1) is null;
      update players set role = v_missing[1] where id = p.id;
      v_missing := v_missing[2:];
    end loop;
  end loop;
end $$;

-- ── Completion & failure ──────────────────────────────────────────────────────
create or replace function _complete(p_instance uuid) returns int
language plpgsql as $$
declare mi mission_instances; mt mission_templates; t teams; l locations; sr sync_rounds;
  v_ev uuid; v_pts int := 0; v_coins int := 0; v_item text; v_won boolean; ad airdrops; v_total numeric; v_left numeric;
begin
  select * into mi from mission_instances where id = p_instance for update;
  if mi.status <> 'active' then return 0; end if;
  select * into mt from mission_templates where id = mi.template_id;
  select * into t from teams where id = mi.team_id;
  v_ev := t.event_id;
  update mission_instances set status = 'solved', solved_at = now() where id = mi.id;

  if mi.kind = 'battle' then
    perform 1 from battles where id = mi.battle_id for update;
    if exists (select 1 from battles where id = mi.battle_id and status = 'active') then
      perform _resolve_battle(mi.battle_id, mi.team_id);
      return _cfg(v_ev, 'pts_battle');
    end if;
    update mission_instances set status = 'failed' where id = mi.id;
    return 0;
  elsif mi.kind = 'recovery' then
    perform _respawn(mi.team_id, 'solved');
    return 0;
  elsif mi.sync_round_id is not null then
    select * into sr from sync_rounds where id = mi.sync_round_id;
    v_total := greatest(1, extract(epoch from sr.deadline - sr.started_at));
    v_left := greatest(0, extract(epoch from sr.deadline - now()));
    v_pts := round(sr.max_points * (0.5 + 0.5 * v_left / v_total));
    if mt.relay and mi.fallback_at is not null and now() >= mi.fallback_at then v_pts := v_pts / 2; end if;
    if mi.hint_used then v_pts := round(v_pts * 0.8); end if;
    perform _apply(mi.team_id, 'finale', v_pts, 0, 0, 0, mi.id::text, mt.title);
    update teams set final_points = final_points + v_pts where id = mi.team_id;
  elsif mi.kind = 'airdrop' then
    update airdrops set claimed_by = mi.team_id, claimed_at = now(), status = 'claimed'
    where id = mi.airdrop_id and claimed_by is null and status = 'open'
    returning * into ad;
    v_won := ad.id is not null;
    if v_won then
      v_pts := _cfg(v_ev, 'pts_airdrop');
      v_coins := case ad.tier when 'common' then 40 when 'rare' then 60 when 'legendary' then 100
                   when 'mystery' then 20 + abs(hashtext(ad.id::text)) % 101 when 'cursed' then 0 else 30 end;
      if ad.tier = 'cursed' then v_pts := v_pts * 2; end if;
      if t.beacon then v_coins := v_coins * 2; update teams set beacon = false where id = t.id; end if;
      perform _apply(mi.team_id, 'airdrop', v_pts, v_coins, 0, 0, ad.id::text, ad.tier || ' airdrop');
      if ad.tier = 'cursed' then perform _damage(mi.team_id, 20, 'curse', ad.id::text, 'Cursed airdrop'); end if;
      if ad.tier = 'intel' then update teams set scan_until = now() + interval '120 seconds' where id = t.id; end if;
      v_item := case ad.tier when 'legendary' then 'sniper' when 'rare' then 'shield' when 'common' then 'medkit'
                  when 'mystery' then (array['smg', 'jammer', 'scanner', 'extract'])[1 + abs(hashtext(ad.id::text || 'i')) % 4] else null end;
      if v_item is not null then perform _add_item(mi.team_id, v_item, 1); end if;
      if ad.tier = 'legendary' then perform _add_item(mi.team_id, 'shield', 1); end if;
      perform _feed(t.arena_id, 'airdrop.claimed', jsonb_build_object('team', t.number, 'tier', ad.tier, 'location', ad.location_id));
      -- everyone else racing for this crate gets a consolation and is released
      update mission_instances set status = 'cancelled' where airdrop_id = mi.airdrop_id and status = 'active' and id <> mi.id;
      perform _ping_arena(t.arena_id, 'airdrop');
    else
      perform _apply(mi.team_id, 'airdrop_consolation', 0, 15, 0, 0, mi.id::text, 'Airdrop already taken');
    end if;
  else
    -- normal location mission or relay
    v_pts := coalesce(mt.points, case when mt.difficulty >= 2 then _cfg(v_ev, 'pts_hard') else _cfg(v_ev, 'pts_standard') end);
    v_coins := mt.coins;
    if mi.hint_used then v_pts := round(v_pts * 0.8); end if;
    if mt.relay then
      if mi.fallback_at is not null and now() >= mi.fallback_at then
        v_pts := v_pts / 2;
      elsif mi.partner_team_id is not null then
        perform _apply(mi.partner_team_id, 'relay_assist', _cfg(v_ev, 'pts_relay_bonus'), 0, 0, 10, mi.id::text, 'Shared a codeword');
        perform _apply(mi.team_id, 'relay_trust', 0, 0, 0, 5, mi.id::text, 'Cooperated');
        perform _feed(t.arena_id, 'intel.shared', jsonb_build_object('from', (select number from teams where id = mi.partner_team_id), 'to', t.number));
        perform _ping_team(mi.partner_team_id, 'intel');
      end if;
    end if;
    perform _apply(mi.team_id, 'mission', v_pts, v_coins, 0, 0, mi.id::text, mt.title);
    update teams set missions_completed = missions_completed + 1 where id = mi.team_id;
    select * into l from locations where id = mi.location_id;
    if l.id is not null and array_length(l.loot, 1) > 0 then
      v_item := l.loot[1 + abs(hashtext(mi.id::text)) % array_length(l.loot, 1)];
      perform _add_item(mi.team_id, v_item, 1);
    end if;
  end if;

  update mission_instances set points_awarded = v_pts where id = mi.id;
  perform _feed(t.arena_id, 'mission.completed', jsonb_build_object('team', t.number, 'title', mt.title, 'points', v_pts, 'item', v_item));
  perform _ping_team(mi.team_id, 'result');
  perform _ping_arena(t.arena_id, 'score');
  return v_pts;
end $$;

create or replace function _fail(p_instance uuid, p_status text default 'failed') returns void
language plpgsql as $$
declare mi mission_instances; t teams; b battles;
begin
  select * into mi from mission_instances where id = p_instance for update;
  if mi.status <> 'active' then return; end if;
  update mission_instances set status = p_status where id = mi.id;
  select * into t from teams where id = mi.team_id;
  if mi.kind = 'battle' then
    select * into b from battles where id = mi.battle_id;
    if not exists (select 1 from mission_instances where battle_id = mi.battle_id and status = 'active') then
      perform _resolve_battle(mi.battle_id, null);
    end if;
  elsif mi.kind = 'recovery' then
    perform _respawn(mi.team_id, 'bounded');
  elsif mi.sync_round_id is null and mi.kind in ('mission', 'relay') then
    perform _damage(mi.team_id, _cfg(t.event_id, 'dmg_fail'), 'mission_fail', mi.id::text, 'Mission failed');
  end if;
  perform _feed(t.arena_id, 'mission.failed', jsonb_build_object('team', t.number));
  perform _ping_team(mi.team_id, 'result');
end $$;

-- ── Arrival ───────────────────────────────────────────────────────────────────
create or replace function _arrive(p_team uuid) returns void
language plpgsql as $$
declare t teams; a arenas; v_from locations; v_to locations; v_count int;
begin
  select * into t from teams where id = p_team for update;
  if t.state <> 'traveling' then return; end if;
  select * into a from arenas where id = t.arena_id;
  select * into v_from from locations where id = t.travel_from;
  select * into v_to from locations where id = t.travel_to;
  update teams set state = 'idle', location_id = travel_to, travel_to = null, travel_from = null,
    travel_arrive_at = null, travel_started_at = null, dropped = true, visit_missions = 0
  where id = p_team;
  -- reward a well-timed escape from a location about to collapse
  if a.zone_next_at is not null and v_from.collapse_stage = a.zone_stage + 1 and v_to.collapse_stage > a.zone_stage + 1 then
    perform _apply(p_team, 'relocation', _cfg(a.event_id, 'pts_relocation'), 0, 0, 0, 'reloc-' || (a.zone_stage + 1), 'Reached safety before the zone collapsed');
  end if;
  if t.jammed_until is null or t.jammed_until < now() then
    perform _feed(t.arena_id, 'squad.arrived', jsonb_build_object('team', t.number, 'location', v_to.id));
  end if;
  select count(*) into v_count from teams where arena_id = t.arena_id and location_id = v_to.id and id <> t.id and ready;
  if v_count > 0 then
    perform _feed(t.arena_id, 'encounter.detected', jsonb_build_object('location', v_to.id, 'squads', v_count + 1));
    perform _ping('arena-' || t.arena_id::text, 'encounter');
  end if;
  if a.phase = 'play' and not exists (select 1 from mission_instances where team_id = p_team and status = 'active' and kind <> 'battle') then
    perform _start_location_mission(p_team);
  end if;
  perform _ping_team(p_team, 'arrived');
end $$;

-- ── The tick: resolves every timer for an arena. Called on reads (rate-limited)
-- and by the host/projector screens, so no always-on server is needed. ────────
create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare a arenas; r record; v_changed boolean := false; v_sched text[]; v_next int; v_at timestamptz;
begin
  if not pg_try_advisory_xact_lock(hashtext('tick' || p_arena::text)) then return false; end if;
  select * into a from arenas where id = p_arena;
  if a.id is null or a.paused then return false; end if;
  if not p_force and a.last_tick_at is not null and a.last_tick_at > now() - interval '800 milliseconds' then return false; end if;
  update arenas set last_tick_at = now() where id = p_arena;

  -- shuttle → roles
  if a.phase = 'shuttle' and now() >= a.shuttle_arrive_at then
    update arenas set phase = 'roles', roles_deadline = now() + _secs(_cfg(a.event_id, 'roles_seconds')) where id = p_arena;
    update teams set location_id = 'gate_1', state = 'idle' where arena_id = p_arena and ready;
    perform _feed(p_arena, 'shuttle.arrived', '{}'::jsonb);
    v_changed := true;
  end if;

  select * into a from arenas where id = p_arena;
  -- roles → play
  if a.phase = 'roles' and now() >= a.roles_deadline then
    perform _finalize_roles(p_arena);
    update arenas set phase = 'play', play_started_at = now() where id = p_arena;
    perform _feed(p_arena, 'role.assignment.completed', '{}'::jsonb);
    perform _feed(p_arena, 'map.revealed', '{}'::jsonb);
    v_changed := true;
  end if;

  select * into a from arenas where id = p_arena;
  if a.phase not in ('play', 'finale') then
    if v_changed then perform _ping_arena(p_arena, 'phase'); end if;
    return v_changed;
  end if;

  -- travel arrivals
  for r in select id from teams where arena_id = p_arena and state = 'traveling' and travel_arrive_at <= now() loop
    perform _arrive(r.id); v_changed := true;
  end loop;

  -- battles past deadline → draw
  for r in select id from battles where arena_id = p_arena and status = 'active' and deadline <= now() loop
    perform _resolve_battle(r.id, null); v_changed := true;
  end loop;

  -- expired activities
  for r in select id, kind, sync_round_id from mission_instances
           where arena_id = p_arena and status = 'active' and deadline <= now() and kind <> 'battle' loop
    perform _fail(r.id, 'expired'); v_changed := true;
  end loop;

  -- recovery timeout → bounded respawn
  for r in select id from teams where arena_id = p_arena and state = 'recovery' and recovery_deadline <= now() loop
    perform _respawn(r.id, 'timeout'); v_changed := true;
  end loop;

  -- synchronized rounds
  for r in select id from sync_rounds where arena_id = p_arena and status = 'active' and deadline <= now() loop
    update sync_rounds set status = 'closed' where id = r.id;
    update arenas set sync_round_id = null where id = p_arena and sync_round_id = r.id;
    perform _feed(p_arena, 'sync.closed', '{}'::jsonb);
    v_changed := true;
  end loop;

  -- zone: automatic schedule (optional) and scheduled collapses
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and _cfg(a.event_id, 'zone_auto') = 1 and a.zone_next_at is null and a.zone_stage < 5 then
    v_sched := string_to_array(_cfg_text(a.event_id, 'zone_schedule'), ',');
    v_next := trim(v_sched[a.zone_stage + 1])::int;
    if v_next is not null then
      v_at := a.play_started_at + make_interval(mins => v_next);
      if now() >= v_at - _secs(_cfg(a.event_id, 'zone_warning')) then
        update arenas set zone_next_at = greatest(v_at, now() + interval '10 seconds') where id = p_arena;
        perform _feed(p_arena, 'zone.warning', jsonb_build_object('stage', a.zone_stage + 1));
        v_changed := true;
      end if;
    end if;
  end if;
  select * into a from arenas where id = p_arena;
  if a.zone_next_at is not null and now() >= a.zone_next_at then
    perform _zone_advance(p_arena); v_changed := true;
  end if;

  -- automatic airdrops (optional)
  if a.phase = 'play' and _cfg(a.event_id, 'airdrop_interval') > 0
     and coalesce(a.last_airdrop_at, a.play_started_at) < now() - make_interval(mins => _cfg(a.event_id, 'airdrop_interval')) then
    perform _spawn_airdrop(p_arena, null, (array['common', 'common', 'rare', 'mystery', 'intel', 'cursed', 'legendary'])[1 + floor(random() * 7)::int]);
    v_changed := true;
  end if;

  -- airdrop & alliance expiry
  update airdrops set status = 'expired' where arena_id = p_arena and status = 'open' and expires_at <= now();
  if found then v_changed := true; end if;
  update mission_instances mi set status = 'cancelled' from airdrops ad
  where mi.airdrop_id = ad.id and ad.status = 'expired' and mi.status = 'active';
  update alliances set status = 'expired' where arena_id = p_arena and status = 'proposed' and created_at < now() - interval '2 minutes';
  update alliances set status = 'ended' where arena_id = p_arena and status = 'active' and expires_at <= now();

  if v_changed then perform _ping_arena(p_arena, 'tick'); end if;
  return v_changed;
end $$;
