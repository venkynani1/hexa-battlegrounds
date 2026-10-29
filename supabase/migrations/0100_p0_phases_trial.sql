-- ════════════════════════════════════════════════════════════════════════════
-- P0 expansion (incremental; earlier migrations are unchanged)
--   • Six named match phases with server-side gating and automatic pacing
--   • Phase-driven zone contraction (warning → collapse) with a host hold
--   • Mission time scaling (pacing presets) and phase-aware mission difficulty
--   • Trial events: fast-forward, simulated squads, reset — rejected on live events
--   • Squad prep: 6-digit PINs from strong randomness, codenames, bus numbers at
--     creation, host-only PIN reset, validated CSV import, roster export
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table events add column if not exists is_trial boolean not null default false;
alter table arenas add column if not exists match_phase int not null default 0;
alter table arenas add column if not exists phase_started_at timestamptz;
alter table arenas add column if not exists phase_next_at timestamptz;
alter table arenas add column if not exists zone_hold boolean not null default false;

-- ── Settings: new keys (host_settings only accepts keys listed here) ─────────
create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 10, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 15,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0,
  -- P0
  'auto_pacing', 0,                 -- 1 = phases advance on the schedule below
  'phase_schedule', '2,12,30,50',   -- minutes after play starts at which phases 1, 2, 3, 4 begin
  'duel_phase', 2,                  -- puzzle duels unlock in this phase (First Contact)
  'mission_time_pct', 100,          -- scales every mission timer (pacing presets)
  'pin_length', 6                   -- digits in generated squad PINs
) $$;

-- Zone stage each match phase contracts towards (phase 5 = finale sets stage 5 itself).
create or replace function _phase_zone_target(p_phase int) returns int language sql immutable as $$
  select (array[0, 0, 1, 3, 4, 5])[least(5, greatest(0, p_phase)) + 1]
$$;

-- Strong-random numeric PIN (gen_random_uuid uses the OS CSPRNG).
create or replace function _new_pin(p_len int) returns text language plpgsql volatile as $$
declare v text := '';
begin
  p_len := least(8, greatest(4, coalesce(p_len, 6)));
  while length(v) < p_len loop
    v := v || ((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint) % 10)::text;
  end loop;
  return v;
end $$;

create or replace function _weak_pin(p text) returns boolean language sql immutable as $$
  select p !~ '^[0-9]{4,8}$'
      or p ~ '^(.)\1+$'
      or position(p in '01234567890') > 0
      or position(p in '98765432109') > 0
$$;

-- ── Match phases ──────────────────────────────────────────────────────────────
-- Authoritative state lives in arenas.match_phase; a public mirror goes into
-- arenas.overlay.match, which player_state and spectator_state already return.
create or replace function _set_match_phase(p_arena uuid, p_phase int) returns void
language plpgsql as $$
declare a arenas; e events; v_next timestamptz; v_sched text[]; v_min int;
begin
  select * into a from arenas where id = p_arena for update;
  select * into e from events where id = a.event_id;
  p_phase := greatest(0, least(5, p_phase));
  if p_phase < 4 and _cfg(a.event_id, 'auto_pacing') = 1 and a.play_started_at is not null then
    v_sched := string_to_array(_cfg_text(a.event_id, 'phase_schedule'), ',');
    begin
      v_min := nullif(trim(v_sched[p_phase + 1]), '')::int;
    exception when others then v_min := null;
    end;
    if v_min is not null then v_next := greatest(now() + interval '5 seconds', a.play_started_at + make_interval(mins => v_min)); end if;
  end if;
  update arenas set match_phase = p_phase, phase_started_at = now(), phase_next_at = v_next, zone_hold = false,
    overlay = overlay || jsonb_build_object('match', jsonb_build_object(
      'phase', p_phase, 'started_at', now(), 'next_at', v_next,
      'duel_phase', _cfg(a.event_id, 'duel_phase'), 'zone_target', _phase_zone_target(p_phase)),
      'trial', e.is_trial)
  where id = p_arena;
  if a.match_phase is distinct from p_phase or a.phase_started_at is null then
    perform _feed(p_arena, 'phase.started', jsonb_build_object('phase', p_phase));
  end if;
  perform _ping_arena(p_arena, 'phase');
end $$;

-- Duels are only allowed from the configured phase (default: Phase 2 — First Contact).
create or replace function _battles_phase_guard() returns trigger language plpgsql as $$
declare a arenas;
begin
  select * into a from arenas where id = new.arena_id;
  if a.match_phase < _cfg(a.event_id, 'duel_phase') then raise exception 'DUELS_LOCKED'; end if;
  return new;
end $$;
drop trigger if exists battles_phase_guard on battles;
create trigger battles_phase_guard before insert on battles for each row execute function _battles_phase_guard();

-- ── Squad defaults: codename and provisional bus at creation ─────────────────
create or replace function _teams_defaults() returns trigger language plpgsql as $$
declare v_n int;
begin
  if new.name is null or new.name = '' or new.name = 'Squad ' || new.number then
    new.name := (array['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima',
      'Mike','November','Oscar','Papa','Quebec','Romeo','Sierra','Tango','Uniform','Victor','Whiskey','Xray','Yankee','Zulu'])
      [1 + (new.number - 1) % 26] || '-' || lpad(new.number::text, 2, '0');
  end if;
  if new.bus is null then
    select count(*) into v_n from teams where arena_id = new.arena_id;
    new.bus := 1 + v_n / greatest(1, _cfg(new.event_id, 'bus_size'));
  end if;
  return new;
end $$;
drop trigger if exists teams_defaults on teams;
create trigger teams_defaults before insert on teams for each row execute function _teams_defaults();

-- ── Mission picking: phase-aware difficulty ───────────────────────────────────
create or replace function _pick_template(p_team uuid, p_kind text, p_tags text[]) returns text
language plpgsql stable as $$
declare t teams; v_seed int; v text; v_phase int;
begin
  select * into t from teams where id = p_team;
  select mission_seed into v_seed from events where id = t.event_id;
  select match_phase into v_phase from arenas where id = t.arena_id;
  select mt.id into v from mission_templates mt
  where mt.kind = p_kind and mt.status = 'published'
    and not exists (select 1 from mission_instances mi where mi.team_id = p_team and mi.template_id = mt.id)
  order by (mt.tags && coalesce(p_tags, '{}')) desc,
    (case when coalesce(v_phase, 0) <= 1 then mt.difficulty <= 1 when v_phase >= 3 then mt.difficulty >= 2 else true end) desc,
    md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
  limit 1;
  if v is null then
    select mt.id into v from mission_templates mt
    where mt.kind = p_kind and mt.status = 'published'
    order by (mt.tags && coalesce(p_tags, '{}')) desc, md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
    limit 1;
  end if;
  return v;
end $$;

-- ── Mission start: timers scale with mission_time_pct ─────────────────────────
create or replace function _start_instance(
  p_team uuid, p_template text, p_location text default null, p_battle uuid default null,
  p_airdrop uuid default null, p_sync uuid default null, p_deadline timestamptz default null,
  p_partner uuid default null
) returns uuid language plpgsql as $$
declare t teams; mt mission_templates; v_id uuid; v_partner uuid; v_key text; v_seed int; v_pct int;
begin
  select * into t from teams where id = p_team for update;
  select * into mt from mission_templates where id = p_template;
  if mt.id is null then raise exception 'NO_TEMPLATE'; end if;
  select mission_seed into v_seed from events where id = t.event_id;
  v_pct := greatest(20, least(300, _cfg(t.event_id, 'mission_time_pct')));
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
    mt.attempts, coalesce(p_deadline, now() + _secs(mt.time_limit * v_pct / 100.0)), v_partner, v_key,
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

-- ── Shift every timer in an arena (resume uses +pause; trial fast-forward uses −N) ──
create or replace function _shift_arena(p_arena uuid, p_delta interval) returns void
language plpgsql as $$
begin
  update arenas set
    shuttle_departed_at = shuttle_departed_at + p_delta, shuttle_arrive_at = shuttle_arrive_at + p_delta,
    roles_deadline = roles_deadline + p_delta, play_started_at = play_started_at + p_delta,
    zone_next_at = zone_next_at + p_delta, last_airdrop_at = last_airdrop_at + p_delta,
    phase_started_at = phase_started_at + p_delta, phase_next_at = phase_next_at + p_delta,
    overlay = case when overlay ? 'match' then jsonb_set(overlay, '{match,next_at}',
      coalesce(to_jsonb((overlay #>> '{match,next_at}')::timestamptz + p_delta), 'null'::jsonb)) else overlay end
  where id = p_arena;
  update mission_instances set deadline = deadline + p_delta, fallback_at = fallback_at + p_delta,
    started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update battles set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update sync_rounds set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update airdrops set expires_at = expires_at + p_delta, spawned_at = spawned_at + p_delta where arena_id = p_arena and status = 'open';
  update alliances set expires_at = expires_at + p_delta, created_at = created_at + p_delta
    where arena_id = p_arena and status in ('proposed', 'active');
  update story_events set expires_at = expires_at + p_delta where arena_id = p_arena and expires_at > now();
  update teams set travel_started_at = travel_started_at + p_delta, travel_arrive_at = travel_arrive_at + p_delta,
    recovery_deadline = recovery_deadline + p_delta, attack_cooldown_until = attack_cooldown_until + p_delta,
    protected_until = protected_until + p_delta, jammed_until = jammed_until + p_delta, scan_until = scan_until + p_delta
  where arena_id = p_arena;
end $$;

-- ── Tick: adds match phase pacing and phase-driven zone contraction ──────────
create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare a arenas; r record; v_changed boolean := false; v_sched text[]; v_next int; v_at timestamptz; v_target int;
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
  -- roles → play (Phase 0: Deployment)
  if a.phase = 'roles' and now() >= a.roles_deadline then
    perform _finalize_roles(p_arena);
    update arenas set phase = 'play', play_started_at = now() where id = p_arena;
    perform _feed(p_arena, 'role.assignment.completed', '{}'::jsonb);
    perform _feed(p_arena, 'map.revealed', '{}'::jsonb);
    perform _set_match_phase(p_arena, 0);
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

  -- match phase pacing (automatic schedule)
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and a.match_phase < 4 and a.phase_next_at is not null and now() >= a.phase_next_at then
    perform _set_match_phase(p_arena, a.match_phase + 1);
    v_changed := true;
  end if;

  -- zone: phase-driven contraction towards the phase's target stage
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and not a.zone_hold and a.zone_next_at is null and a.zone_stage < 5 then
    v_target := _phase_zone_target(a.match_phase);
    if a.zone_stage < v_target then
      update arenas set zone_next_at = now() + _secs(_cfg(a.event_id, 'zone_warning')) where id = p_arena;
      perform _feed(p_arena, 'zone.warning', jsonb_build_object('stage', a.zone_stage + 1));
      v_changed := true;
    end if;
  end if;

  -- zone: legacy minute schedule (zone_auto), kept for existing events
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and _cfg(a.event_id, 'zone_auto') = 1 and a.zone_next_at is null and a.zone_stage < 5 and not a.zone_hold then
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

-- ── Squad preparation ─────────────────────────────────────────────────────────
create or replace function host_generate_teams(p_token text, p_count int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_start int; v_out jsonb := '[]'::jsonb; i int; v_pin text; v_salt text; v_arena uuid; v_size int; v_team teams;
begin
  v_ev := _auth_host(p_token);
  if p_count < 1 or p_count > 120 then raise exception 'BAD_COUNT'; end if;
  v_size := _cfg(v_ev, 'arena_size');
  select coalesce(max(number), 0) into v_start from teams where event_id = v_ev;
  for i in 1..p_count loop
    v_pin := _new_pin(_cfg(v_ev, 'pin_length'));
    v_salt := _new_token();
    select a.id into v_arena from arenas a
    where a.event_id = v_ev and a.phase = 'lobby'
      and (select count(*) from teams t where t.arena_id = a.id) < v_size
    order by a.number limit 1;
    if v_arena is null then raise exception 'ALL_MAPS_FULL'; end if;
    insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
    values (v_ev, v_arena, v_start + i, null, v_salt, _hash(v_salt || v_pin)) returning * into v_team;
    perform _add_item(v_team.id, 'pistol', 1);
    perform _add_item(v_team.id, 'medkit', 1);
    v_out := v_out || jsonb_build_object('number', v_team.number, 'name', v_team.name, 'pin', v_pin, 'bus', v_team.bus,
      'map', (select number from arenas where id = v_arena));
  end loop;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'generate_teams', jsonb_build_object('count', p_count));
  return v_out;
end $$;

-- Import organiser-approved squads: [{number, name, pin?, map?}]. Missing PINs are generated and returned once.
create or replace function host_import_teams(p_token text, p_teams jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; r jsonb; v_salt text; v_arena uuid; v_size int; v_n int := 0; v_team teams; v_row int := 0;
  v_seen int[] := '{}'; v_num int; v_pin text; v_out jsonb := '[]'::jsonb; v_generated boolean;
begin
  v_ev := _auth_host(p_token);
  v_size := _cfg(v_ev, 'arena_size');
  if jsonb_typeof(p_teams) <> 'array' or jsonb_array_length(p_teams) = 0 then raise exception 'BAD_ROW: the file has no squads'; end if;
  if jsonb_array_length(p_teams) > 120 then raise exception 'BAD_ROW: at most 120 squads per import'; end if;
  -- validate everything before writing anything
  for r in select * from jsonb_array_elements(p_teams) loop
    v_row := v_row + 1;
    if coalesce(r ->> 'number', '') !~ '^[0-9]{1,3}$' or (r ->> 'number')::int < 1 then
      raise exception 'BAD_ROW: row % — squad number must be 1–999', v_row;
    end if;
    v_num := (r ->> 'number')::int;
    if v_num = any(v_seen) then raise exception 'BAD_ROW: row % — squad % appears twice', v_row, v_num; end if;
    v_seen := v_seen || v_num;
    if coalesce(r ->> 'pin', '') <> '' and _weak_pin(r ->> 'pin') then
      raise exception 'BAD_ROW: row % — PIN for squad % must be 4–8 digits and not a repeated or sequential pattern', v_row, v_num;
    end if;
    if coalesce(r ->> 'map', '') <> '' and not exists (select 1 from arenas where event_id = v_ev and number::text = r ->> 'map') then
      raise exception 'BAD_ROW: row % — map % does not exist', v_row, r ->> 'map';
    end if;
    if length(coalesce(r ->> 'name', '')) > 40 then raise exception 'BAD_ROW: row % — name longer than 40 characters', v_row; end if;
  end loop;
  for r in select * from jsonb_array_elements(p_teams) loop
    v_arena := null;
    if coalesce(r ->> 'map', '') <> '' then
      select id into v_arena from arenas where event_id = v_ev and number::text = r ->> 'map';
    end if;
    if v_arena is null then
      select arena_id into v_arena from teams where event_id = v_ev and number = (r ->> 'number')::int;
    end if;
    if v_arena is null then
      select a.id into v_arena from arenas a where a.event_id = v_ev and a.phase = 'lobby'
        and (select count(*) from teams t where t.arena_id = a.id) < v_size order by a.number limit 1;
    end if;
    if v_arena is null then raise exception 'ALL_MAPS_FULL'; end if;
    v_generated := coalesce(r ->> 'pin', '') = '';
    v_pin := case when v_generated then _new_pin(_cfg(v_ev, 'pin_length')) else r ->> 'pin' end;
    v_salt := _new_token();
    insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
    values (v_ev, v_arena, (r ->> 'number')::int, nullif(trim(r ->> 'name'), ''), v_salt, _hash(v_salt || v_pin))
    on conflict (event_id, number) do update set
      name = coalesce(nullif(trim(r ->> 'name'), ''), teams.name),
      pin_salt = excluded.pin_salt, pin_hash = excluded.pin_hash,
      arena_id = case when (select phase from arenas where id = teams.arena_id) = 'lobby' then excluded.arena_id else teams.arena_id end
    returning * into v_team;
    if not exists (select 1 from inventory where team_id = v_team.id) then
      perform _add_item(v_team.id, 'pistol', 1);
      perform _add_item(v_team.id, 'medkit', 1);
    end if;
    v_out := v_out || jsonb_build_object('number', v_team.number, 'name', v_team.name,
      'map', (select number from arenas where id = v_team.arena_id), 'pin', case when v_generated then v_pin end);
    v_n := v_n + 1;
  end loop;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'import_teams', jsonb_build_object('count', v_n));
  return jsonb_build_object('imported', v_n, 'squads', v_out);
end $$;

-- Roster for printing/export (never includes PINs or player sessions).
create or replace function host_roster(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return (select coalesce(jsonb_agg(jsonb_build_object('team_id', t.id, 'map', a.number, 'number', t.number, 'name', t.name,
      'bus', t.bus, 'ready', t.ready, 'players', (select count(*) from players p where p.team_id = t.id and p.active))
    order by a.number, t.number), '[]'::jsonb)
    from teams t join arenas a on a.id = t.arena_id where t.event_id = v_ev);
end $$;

-- ── Trial events ─────────────────────────────────────────────────────────────
create or replace function host_create_trial(p_code text, p_name text, p_secret text, p_arenas int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  r := host_create_event(p_code, 'TRIAL · ' || coalesce(nullif(trim(p_name), ''), 'Rehearsal'), p_secret, p_arenas);
  update events set is_trial = true, settings = settings || jsonb_build_object(
    'auto_pacing', 1, 'phase_schedule', '1,3,5,7', 'zone_warning', 30, 'shuttle_seconds', 12, 'roles_seconds', 12,
    'recovery_seconds', 45, 'airdrop_interval', 2, 'intel_fallback', 45, 'attack_cooldown', 45, 'protect_seconds', 45,
    'mission_time_pct', 70, 'airdrop_window', 90)
  where id = (r ->> 'event_id')::uuid;
  insert into audit_log(event_id, actor, action) values ((r ->> 'event_id')::uuid, 'host', 'create_trial');
  return r || jsonb_build_object('trial', true);
end $$;

-- Rehearsal progress: which parts of the game have actually been exercised.
create or replace function host_trial_status(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; e events;
begin
  v_ev := _auth_host(p_token);
  select * into e from events where id = v_ev;
  return jsonb_build_object(
    'is_trial', e.is_trial,
    'steps', jsonb_build_object(
      'squads', exists (select 1 from teams where event_id = v_ev),
      'joined', exists (select 1 from teams where event_id = v_ev and ready),
      'boarding', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'shuttle.assigned'),
      'shuttle', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'shuttle.departed'),
      'roles', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'role.assignment.completed'),
      'movement', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'squad.arrived'),
      'mission', exists (select 1 from mission_instances mi join arenas a on a.id = mi.arena_id where a.event_id = v_ev and mi.status = 'solved' and mi.kind in ('mission', 'relay')),
      'wrong_answer', exists (select 1 from submissions s join teams t on t.id = s.team_id where t.event_id = v_ev and not s.correct),
      'phase2', exists (select 1 from arenas where event_id = v_ev and match_phase >= 2),
      'battle', exists (select 1 from battles b join arenas a on a.id = b.arena_id where a.event_id = v_ev and b.status = 'resolved'),
      'airdrop', exists (select 1 from airdrops d join arenas a on a.id = d.arena_id where a.event_id = v_ev and d.status = 'claimed'),
      'zone', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'zone.collapsed'),
      'recovery', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'recovery.started'),
      'pause', exists (select 1 from audit_log where event_id = v_ev and action = 'resume' and ok),
      'chat', exists (select 1 from chat_messages c join arenas a on a.id = c.arena_id where a.event_id = v_ev),
      'finale', exists (select 1 from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev and g.type = 'final.started'),
      'finale_round', exists (select 1 from mission_instances mi join arenas a on a.id = mi.arena_id where a.event_id = v_ev and mi.sync_round_id is not null and mi.status = 'solved'),
      'results', exists (select 1 from arenas where event_id = v_ev and results_locked),
      'winner', exists (select 1 from arenas where event_id = v_ev and winner_revealed)
    ));
end $$;

-- New host commands. Everything else is delegated to the original _host_exec.
create or replace function _host_exec_p0(p_ev uuid, p_arena uuid, p_cmd text, p_args jsonb, p_reason text) returns jsonb
language plpgsql as $$
declare a arenas; e events; t teams; v_delta interval; v_pin text; v_salt text; v_out jsonb := '[]'::jsonb; i int; j int;
  v_tokens jsonb; v_num int; v_size int; v_count int; v_names text[] := array['Ava','Ben','Cleo','Dev','Esha','Finn','Gia','Hari','Ivy','Jai','Kai','Lia','Mo','Nia','Om','Pia'];
begin
  select * into e from events where id = p_ev;
  if p_arena is not null then select * into a from arenas where id = p_arena; end if;

  if p_cmd in ('trial_skip', 'trial_bots', 'trial_reset') and not e.is_trial then raise exception 'TRIAL_ONLY'; end if;

  case p_cmd
  when 'set_phase', 'next_phase' then
    if a.phase <> 'play' then raise exception 'WRONG_PHASE'; end if;
    i := case when p_cmd = 'next_phase' then a.match_phase + 1 else (p_args ->> 'phase')::int end;
    if i is null or i < 0 or i > 4 then raise exception 'BAD_PHASE'; end if;
    perform _set_match_phase(a.id, i);
    perform _tick(a.id, true);
    return jsonb_build_object('phase', i);
  when 'hide_rankings' then
    update arenas set overlay = overlay || jsonb_build_object('hide_rankings', coalesce((p_args ->> 'on')::boolean, true)) where id = a.id;
  when 'reset_pin' then
    select * into t from teams where id = (p_args ->> 'team_id')::uuid and event_id = p_ev for update;
    if t.id is null then raise exception 'NOT_FOUND'; end if;
    v_pin := _new_pin(_cfg(p_ev, 'pin_length'));
    v_salt := _new_token();
    update teams set pin_salt = v_salt, pin_hash = _hash(v_salt || v_pin) where id = t.id;
    delete from pin_failures where event_id = p_ev and team_number = t.number;
    return jsonb_build_object('number', t.number, 'name', t.name, 'pin', v_pin);
  when 'trial_skip' then
    if a.paused then raise exception 'PAUSED'; end if;
    v_count := greatest(1, least(600, coalesce((p_args ->> 'seconds')::int, 30)));
    perform _shift_arena(a.id, -_secs(v_count));
    perform _tick(a.id, true);
    return jsonb_build_object('skipped', v_count);
  when 'trial_reset' then
    perform _host_exec(p_ev, a.id, 'reset_arena', '{"confirm":"RESET"}'::jsonb, p_reason);
    update arenas set match_phase = 0, phase_started_at = null, phase_next_at = null, zone_hold = false where id = a.id;
  when 'trial_bots' then
    -- Simulated squads join through the real join_team path; the host browser then plays them
    -- through the same player/captain RPCs as real phones.
    if a.phase <> 'lobby' then raise exception 'WRONG_PHASE'; end if;
    v_size := _cfg(p_ev, 'arena_size');
    v_count := greatest(1, least(coalesce((p_args ->> 'count')::int, 3), v_size - (select count(*) from teams where arena_id = a.id)::int));
    if v_count < 1 or (select count(*) from teams where arena_id = a.id) >= v_size then raise exception 'ALL_MAPS_FULL'; end if;
    for i in 1..v_count loop
      select coalesce(max(number), 0) + 1 into v_num from teams where event_id = p_ev;
      v_pin := _new_pin(6); v_salt := _new_token();
      insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
      values (p_ev, a.id, v_num, 'Bot-' || lpad(v_num::text, 2, '0'), v_salt, _hash(v_salt || v_pin)) returning * into t;
      perform _add_item(t.id, 'pistol', 1); perform _add_item(t.id, 'medkit', 1);
      v_tokens := '[]'::jsonb;
      for j in 1..4 loop
        v_tokens := v_tokens || to_jsonb((join_team(e.code, v_num, v_pin, v_names[1 + ((v_num * 4 + j) % 16)] || ' ' || j, true, true, null)) ->> 'token');
      end loop;
      v_out := v_out || jsonb_build_object('team_id', t.id, 'number', v_num, 'tokens', v_tokens);
    end loop;
    return jsonb_build_object('bots', v_out);
  else
    raise exception 'UNKNOWN_COMMAND';
  end case;
  return '{}'::jsonb;
end $$;

-- host_command: same contract; routes new commands, adds phase hooks around existing ones.
create or replace function host_command(p_token text, p_arena uuid, p_cmd text, p_args jsonb default '{}'::jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_ids uuid[]; v_id uuid; v_out jsonb := '{}'::jsonb; v_err text; v_res jsonb; v_delta interval; v_logargs jsonb;
  v_all_ok text[] := array['open_boarding','assign_buses','drive','finalize_roles','pause','resume','broadcast','clear_overlay',
    'blackout','countdown','story','bargain','zone_warn','zone_now','zone_cancel','zone_set','spawn_airdrop','begin_finale',
    'finale_stage','launch_sync','close_sync','lock_results','reveal_winner','end_game','reveal_squad00',
    'next_phase','set_phase','hide_rankings','trial_skip','trial_reset'];
  v_new text[] := array['set_phase','next_phase','hide_rankings','reset_pin','trial_skip','trial_bots','trial_reset'];
begin
  v_ev := _auth_host(p_token);
  p_args := coalesce(p_args, '{}'::jsonb);
  v_logargs := p_args - 'pin';
  if p_arena is null then
    if p_cmd = any(v_all_ok) then
      select array_agg(id order by number) into v_ids from arenas where event_id = v_ev;
    else
      v_ids := array[null::uuid];
    end if;
  else
    if not exists (select 1 from arenas where id = p_arena and event_id = v_ev) then raise exception 'BAD_ARENA'; end if;
    v_ids := array[p_arena];
  end if;
  foreach v_id in array v_ids loop
    begin
      v_delta := null;
      if p_cmd = 'resume' then
        select now() - paused_at into v_delta from arenas where id = v_id and paused;
      end if;
      if p_cmd = any(v_new) then
        v_res := _host_exec_p0(v_ev, v_id, p_cmd, p_args, p_reason);
      elsif p_cmd = 'clear_overlay' then
        update arenas set overlay = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(overlay) as x(k, v)
          where k in ('match', 'trial')) where id = v_id;
        v_res := '{}'::jsonb;
      else
        v_res := _host_exec(v_ev, v_id, p_cmd, p_args, p_reason);
      end if;
      -- hooks keeping match phases consistent with the original commands
      if p_cmd = 'resume' and v_delta is not null then
        update arenas set phase_next_at = phase_next_at + v_delta, phase_started_at = phase_started_at + v_delta,
          shuttle_departed_at = shuttle_departed_at + v_delta,
          overlay = case when overlay ? 'match' and overlay #>> '{match,next_at}' is not null then jsonb_set(overlay, '{match,next_at}',
            to_jsonb((overlay #>> '{match,next_at}')::timestamptz + v_delta)) else overlay end
        where id = v_id;
      elsif p_cmd = 'begin_finale' then
        update arenas set match_phase = 5, phase_started_at = now(), phase_next_at = null,
          overlay = overlay || jsonb_build_object('match', jsonb_build_object('phase', 5, 'started_at', now(), 'next_at', null, 'zone_target', 5))
        where id = v_id;
        perform _feed(v_id, 'phase.started', jsonb_build_object('phase', 5));
      elsif p_cmd = 'zone_cancel' then
        update arenas set zone_hold = true where id = v_id;
      elsif p_cmd in ('zone_warn', 'zone_now', 'zone_set') then
        update arenas set zone_hold = false where id = v_id;
      elsif p_cmd = 'reset_arena' then
        update arenas set match_phase = 0, phase_started_at = null, phase_next_at = null, zone_hold = false where id = v_id;
      end if;
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), v_res);
      insert into audit_log(event_id, arena_id, actor, action, args, reason) values (v_ev, v_id, 'host', p_cmd, v_logargs, p_reason);
    exception when others then
      v_err := sqlerrm;
      insert into audit_log(event_id, arena_id, actor, action, args, reason, ok, error) values (v_ev, v_id, 'host', p_cmd, v_logargs, p_reason, false, v_err);
      if array_length(v_ids, 1) = 1 then
        return jsonb_build_object('ok', false, 'error', v_err);
      end if;
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), jsonb_build_object('error', v_err));
    end;
    if v_id is not null then perform _ping_arena(v_id, 'host'); end if;
  end loop;
  return jsonb_build_object('ok', true, 'result', v_out);
end $$;

-- Existing arenas: mirror their phase into the public overlay; existing squads get bus numbers.
update arenas a set overlay = a.overlay || jsonb_build_object('match', jsonb_build_object('phase', a.match_phase,
  'started_at', a.phase_started_at, 'next_at', a.phase_next_at, 'duel_phase', 2, 'zone_target', _phase_zone_target(a.match_phase)))
where a.phase in ('play', 'finale') and not (a.overlay ? 'match');
update teams t set bus = s.bus from (
  select id, 1 + ((row_number() over (partition by arena_id order by number)) - 1)::int / 3 as bus from teams
) s where t.id = s.id and t.bus is null;

-- ── Permissions: re-apply the browser whitelist (new functions default to PUBLIC) ──
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public', f.sig);
    begin
      execute format('revoke all on function %s from anon, authenticated', f.sig);
    exception when undefined_object then null;
    end;
    if f.proname = any(array['map_data', 'join_team', 'claim_role', 'player_state', 'captain_move', 'captain_explore',
        'captain_submit', 'captain_hint', 'captain_use_item', 'captain_buy', 'captain_attack', 'captain_claim_airdrop',
        'captain_chat', 'captain_block', 'captain_report', 'captain_alliance', 'captain_bargain',
        'host_create_event', 'host_login', 'host_generate_teams', 'host_import_teams', 'host_overview', 'host_command',
        'host_settings', 'host_missions', 'host_save_mission', 'host_test_answer', 'host_chat_log', 'host_audit',
        'host_export', 'spectator_state', 'host_roster', 'host_create_trial', 'host_trial_status']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
