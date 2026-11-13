-- ═══════════════════════════════════════════════════════════════════════════
-- v13 · Online edition: automatic maps — the host presses Start once
--
--  1. host_online_auto(token, length): from then on the game runs itself.
--     Players keep checking in, creating squads, joining with codes and matchmaking.
--     They fill one map at a time (15 squads = 60 players a map).
--  2. A filling map takes off by itself:
--       • as soon as it has 15 squads and every squad is complete (3–4 players), or
--       • when its countdown ends — the countdown starts once the map has 4 players
--         (online_fill_seconds, 3 minutes), and drops to online_full_wait (45 s) when the map
--         has its 15 squads but some are still short. The last few players are never stranded.
--     At take-off small squads on that map are merged (nobody left out); squads over the
--     limit and a last lone player move to the next map, which starts filling at once.
--  3. Every map runs the automatic match on its own. The host can still launch the filling
--     map early (host_online_launch) or pause automatic starts (host_online_auto … false).
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

alter table arenas add column if not exists fill_deadline timestamptz;

drop function if exists _defaults_v12();
alter function _defaults() rename to _defaults_v12;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v12() || jsonb_build_object(
    'online_auto', 0,            -- 1 = maps fill and take off by themselves (host pressed Start once)
    'online_fill_seconds', 180,  -- countdown once a filling map has online_min_players players
    'online_full_wait', 45,      -- countdown once a filling map has all its squads (some still short)
    'online_min_players', 4)     -- a map never takes off with fewer players than this
$$;

create or replace function _online_map_size(p_ev uuid) returns int
language sql stable as $$ select least(15, greatest(1, _cfg(p_ev, 'arena_size'))) $$;

-- a brand-new lobby map (respects "most maps")
create or replace function _online_new_lobby(p_ev uuid) returns uuid
language plpgsql as $$
declare v uuid; n int;
begin
  if (select count(*) from arenas where event_id = p_ev and (autopilot or phase <> 'lobby')) >= _cfg(p_ev, 'online_max_maps') then
    raise exception 'ALL_MAPS_FULL';
  end if;
  select coalesce(max(number), 0) + 1 into n from arenas where event_id = p_ev;
  insert into arenas(event_id, number, name) values (p_ev, n, 'Map ' || n) returning id into v;
  insert into audit_log(event_id, arena_id, actor, action) values (p_ev, v, 'online', 'map_opened');
  return v;
end $$;

-- where a new squad goes: automatic mode = the map that is filling now; otherwise as in v10
drop function if exists _online_arena_v12(uuid);
alter function _online_arena(uuid) rename to _online_arena_v12;
create function _online_arena(p_ev uuid) returns uuid
language plpgsql as $$
declare v uuid;
begin
  if _cfg(p_ev, 'online_auto') <> 1 then return _online_arena_v12(p_ev); end if;
  select a.id into v from arenas a
  where a.event_id = p_ev and a.phase = 'lobby' and not a.autopilot
    and (select count(*) from teams t where t.arena_id = a.id) < _online_map_size(p_ev)
  order by a.number limit 1;
  if v is not null then return v; end if;
  return _online_new_lobby(p_ev);
end $$;

-- matchmaking only fills squads on a map that has not taken off
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('online_join(text, text, text, text, text, text, boolean, text)'::regprocedure);
  if position('not a.autopilot' in d) > 0 then return; end if;
  n := replace(d, 'x.open_squad and a.phase in (''lobby'', ''boarding'')', 'x.open_squad and a.phase = ''lobby'' and not a.autopilot');
  if n = d then raise exception 'v13: could not patch online_join'; end if;
  execute n;
end $$;

-- ── merge small squads on one map (same rules as the whole-event merge in v10) ──
create or replace function _online_seal_map(p_arena uuid) returns jsonb
language plpgsql as $$
declare u record; v record; x record; v_t uuid; v_need int; v_moved int := 0;
begin
  for u in select t.id from teams t where t.arena_id = p_arena order by _online_size(t.id) desc, t.open_squad, t.created_at loop
    continue when _online_size(u.id) not between 1 and 2;
    loop
      exit when _online_size(u.id) >= 3;
      select t.id into v_t from teams t
      where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) between 1 and 2 and _online_size(t.id) <= 4 - _online_size(u.id)
      order by _online_size(t.id) desc, t.created_at limit 1;
      exit when v_t is null;
      for x in select id from players where team_id = v_t and active loop perform _online_move(x.id, u.id); v_moved := v_moved + 1; end loop;
    end loop;
  end loop;
  for u in select t.id from teams t where t.arena_id = p_arena and _online_size(t.id) between 1 and 2 loop
    for x in select id from players where team_id = u.id and active loop
      select t.id into v_t from teams t where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) = 3 order by t.open_squad desc, t.created_at limit 1;
      exit when v_t is null;
      perform _online_move(x.id, v_t); v_moved := v_moved + 1;
    end loop;
  end loop;
  for u in select t.id from teams t where t.arena_id = p_arena and _online_size(t.id) between 1 and 2 loop
    v_need := 3 - _online_size(u.id);
    for v in select t.id from teams t where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) = 4
             order by t.open_squad desc, t.created_at limit v_need loop
      select id into v_t from players where team_id = v.id and active order by joined_at desc limit 1;
      perform _online_move(v_t, u.id); v_moved := v_moved + 1;
    end loop;
  end loop;
  for u in select t.id from teams t where t.arena_id = p_arena and _online_size(t.id) = 1 loop
    select t.id into v_t from teams t where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) = 3 order by t.open_squad desc, t.created_at limit 1;
    if v_t is not null then
      select id into v_t from players where team_id = v_t and active order by joined_at desc limit 1;
      perform _online_move(v_t, u.id); v_moved := v_moved + 1;
    end if;
  end loop;
  delete from teams tm where tm.arena_id = p_arena and not exists (select 1 from players q where q.team_id = tm.id and q.active);
  update teams t set ready = (select count(*) from players q where q.team_id = t.id and q.active) >= 2,
                     roster_locked = (select count(*) from players q where q.team_id = t.id and q.active) >= 4
  where t.arena_id = p_arena;
  return jsonb_build_object('moved', v_moved);
end $$;

-- ── one map takes off ──────────────────────────────────────────────────────
create or replace function _online_launch(p_arena uuid, p_why text) returns jsonb
language plpgsql as $$
declare a arenas; v_ev uuid; v_size int; v_seal jsonb; v_next uuid; t record; k int := 0; v_bus int := 0; v_squads int; v_len text;
begin
  select * into a from arenas where id = p_arena for update;
  if a.id is null or a.autopilot or a.phase <> 'lobby' then return null; end if;
  v_ev := a.event_id; v_size := _online_map_size(v_ev);
  v_seal := _online_seal_map(p_arena);
  -- squads over the limit, and anyone who still cannot play, move to the next map
  for t in select tm.id, tm.ready from teams tm where tm.arena_id = p_arena
           order by tm.ready desc, _online_size(tm.id) desc, tm.created_at loop
    k := k + 1;
    if not t.ready or k > v_size then
      if v_next is null then
        select id into v_next from arenas where event_id = v_ev and phase = 'lobby' and not autopilot and id <> p_arena order by number limit 1;
        if v_next is null then
          begin v_next := _online_new_lobby(v_ev); exception when others then v_next := null; end;
        end if;
      end if;
      if v_next is not null then update teams set arena_id = v_next, bus = null where id = t.id; end if;
    end if;
  end loop;
  select count(*) into v_squads from teams where arena_id = p_arena and ready;
  if v_squads = 0 then return null; end if;
  for t in select id from teams where arena_id = p_arena order by number loop
    update teams set bus = 1 + v_bus / greatest(1, _cfg(v_ev, 'bus_size')) where id = t.id;
    v_bus := v_bus + 1;
  end loop;
  v_len := coalesce(_cfg_text(v_ev, 'online_auto_length'), 'standard');
  update arenas set autopilot = true, auto_length = v_len, auto_story = -1, fill_deadline = null where id = p_arena;
  perform _auto_resync(p_arena);
  perform _tick(p_arena, true);
  insert into audit_log(event_id, arena_id, actor, action, args) values (v_ev, p_arena, 'online', 'map_launched',
    jsonb_build_object('squads', v_squads, 'why', p_why) || v_seal);
  perform _feed(p_arena, 'map.launched', jsonb_build_object('squads', v_squads));
  perform _ping_arena(p_arena, 'phase');
  if v_next is not null then perform _ping_arena(v_next, 'roster'); end if;
  return jsonb_build_object('map', a.number, 'squads', v_squads, 'why', p_why);
end $$;

-- ── the automatic starter (runs from the host console and from phones in the lobby) ──
create or replace function _online_auto_check(p_ev uuid, p_force boolean default false) returns jsonb
language plpgsql as $$
declare a record; v_size int; v_teams int; v_ready int; v_players int; v_out jsonb := '[]'::jsonb; r jsonb;
  v_fill int; v_full int; v_min int;
begin
  if _cfg(p_ev, 'online_auto') <> 1 or _cfg(p_ev, 'online_started') = 1 then return v_out; end if;
  if p_force then perform pg_advisory_xact_lock(hashtext('online:' || p_ev::text));
  elsif not pg_try_advisory_xact_lock(hashtext('online:' || p_ev::text)) then return v_out; end if;
  v_size := _online_map_size(p_ev);
  v_fill := _cfg(p_ev, 'online_fill_seconds'); v_full := _cfg(p_ev, 'online_full_wait'); v_min := _cfg(p_ev, 'online_min_players');
  for a in select id, number, fill_deadline from arenas where event_id = p_ev and phase = 'lobby' and not autopilot order by number loop
    select count(*), count(*) filter (where n >= 3), coalesce(sum(n), 0) into v_teams, v_ready, v_players
      from (select (select count(*) from players q where q.team_id = t.id and q.active) n from teams t where t.arena_id = a.id) s where n > 0;
    continue when v_teams = 0;
    r := null;
    if p_force and v_players >= 2 then
      r := _online_launch(a.id, 'host');
    elsif v_teams >= v_size and v_ready = v_teams then
      r := _online_launch(a.id, 'full');
    elsif a.fill_deadline is not null and now() >= a.fill_deadline then
      if v_players >= v_min then r := _online_launch(a.id, 'countdown');
      else update arenas set fill_deadline = now() + interval '60 seconds' where id = a.id; end if;
    elsif a.fill_deadline is null and (v_players >= v_min or v_teams >= v_size) then
      update arenas set fill_deadline = now() + make_interval(secs => case when v_teams >= v_size then v_full else v_fill end) where id = a.id;
      perform _ping_arena(a.id, 'phase');
    elsif v_teams >= v_size and a.fill_deadline > now() + make_interval(secs => v_full) then
      update arenas set fill_deadline = now() + make_interval(secs => v_full) where id = a.id;
      perform _ping_arena(a.id, 'phase');
    end if;
    if r is not null then v_out := v_out || r; end if;
    exit when p_force and r is not null;   -- "launch now" starts one map
  end loop;
  return v_out;
end $$;

-- ── host: one press ────────────────────────────────────────────────────────
create or replace function host_online_auto(p_token text, p_length text default 'standard', p_on boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  if _cfg(v_ev, 'online') <> 1 then raise exception 'NOT_ONLINE_EVENT'; end if;
  if _cfg(v_ev, 'online_started') = 1 then raise exception 'ALREADY_STARTED'; end if;
  if coalesce(p_length, 'standard') not in ('quick', 'standard', 'full') then raise exception 'BAD_LENGTH'; end if;
  if coalesce(p_on, true) then
    update events set settings = settings || _auto_preset(coalesce(p_length, 'standard'))
      || jsonb_build_object('online_auto', 1, 'online_auto_length', coalesce(p_length, 'standard')) where id = v_ev;
  else
    update events set settings = settings || jsonb_build_object('online_auto', 0) where id = v_ev;
    update arenas set fill_deadline = null where event_id = v_ev and phase = 'lobby' and not autopilot;
  end if;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', case when coalesce(p_on, true) then 'online_auto_on' else 'online_auto_off' end,
    jsonb_build_object('length', p_length));
  perform _online_auto_check(v_ev, false);
  return host_online_summary(p_token);
end $$;

-- launch the filling map now (with whoever is there)
create or replace function host_online_launch(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; r jsonb;
begin
  v_ev := _auth_host(p_token);
  if _cfg(v_ev, 'online_auto') <> 1 then raise exception 'AUTO_OFF'; end if;
  r := _online_auto_check(v_ev, true);
  if jsonb_array_length(r) = 0 then raise exception 'NO_READY_SQUADS'; end if;
  return r -> 0;
end $$;

-- the all-at-once Start (v10) is not used while automatic maps are on
drop function if exists _host_online_start_v12(text, text);
alter function host_online_start(text, text) rename to _host_online_start_v12;
create function host_online_start(p_token text, p_length text default 'standard') returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if _cfg(_auth_host(p_token), 'online_auto') = 1 then raise exception 'AUTO_ON'; end if;
  return _host_online_start_v12(p_token, p_length);
end $$;

-- host summary: runs the automatic starter, and shows each filling map's countdown
drop function if exists _host_online_summary_v12(text);
alter function host_online_summary(text) rename to _host_online_summary_v12;
create function host_online_summary(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v jsonb;
begin
  v_ev := _auth_host(p_token);
  perform _online_auto_check(v_ev, false);
  v := _host_online_summary_v12(p_token);
  v := v || jsonb_build_object('auto', _cfg(v_ev, 'online_auto') = 1, 'auto_length', _cfg_text(v_ev, 'online_auto_length'),
    'map_size', _online_map_size(v_ev), 'fill_seconds', _cfg(v_ev, 'online_fill_seconds'));
  v := jsonb_set(v, '{maps}', (select coalesce(jsonb_agg(m || jsonb_build_object(
      'launched', a.autopilot or a.phase <> 'lobby', 'fill_deadline', a.fill_deadline) order by a.number), '[]'::jsonb)
    from jsonb_array_elements(v -> 'maps') m join arenas a on a.id = (m ->> 'id')::uuid));
  return v;
end $$;

-- phones: which map is filling, how many squads it has, and when it takes off
drop function if exists _player_state_v12(text);
alter function player_state(text) rename to _player_state_v12;
create function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; a arenas; v_ev uuid; v_size int; v_teams int; v_ready int; v_players int;
begin
  v := _player_state_v12(p_token);
  if jsonb_typeof(v -> 'online') <> 'object' then return v; end if;
  select * into a from arenas where id = (v -> 'arena' ->> 'id')::uuid;
  v_ev := a.event_id;
  if _cfg(v_ev, 'online_auto') <> 1 or _cfg(v_ev, 'online_started') = 1 then return v; end if;
  if a.phase = 'lobby' and not a.autopilot then
    v_size := _online_map_size(v_ev);
    select count(*), count(*) filter (where n >= 3), coalesce(sum(n), 0) into v_teams, v_ready, v_players
      from (select (select count(*) from players q where q.team_id = t.id and q.active) n from teams t where t.arena_id = a.id) s where n > 0;
    -- a phone in the lobby nudges the starter when something is due
    if (a.fill_deadline is not null and now() >= a.fill_deadline) or (a.fill_deadline is null and v_players >= _cfg(v_ev, 'online_min_players')) or v_teams >= v_size then
      if jsonb_array_length(_online_auto_check(v_ev, false)) > 0 then
        v := _player_state_v12(p_token);   -- this map may just have taken off
      end if;
      select * into a from arenas where id = (v -> 'arena' ->> 'id')::uuid;
    end if;
  end if;
  v := jsonb_set(v, '{online,auto}', 'true'::jsonb);
  v := jsonb_set(v, '{online,started}', to_jsonb(a.autopilot or a.phase <> 'lobby'));
  if a.phase = 'lobby' and not a.autopilot then
    select count(*), count(*) filter (where n >= 3) into v_teams, v_ready
      from (select (select count(*) from players q where q.team_id = t.id and q.active) n from teams t where t.arena_id = a.id) s where n > 0;
    v := jsonb_set(v, '{online,fill}', jsonb_build_object('map', a.number, 'squads', v_teams, 'ready', v_ready,
      'size', _online_map_size(v_ev), 'deadline', a.fill_deadline));
  end if;
  return v;
end $$;

-- ── permissions ─────────────────────────────────────────────────────────────
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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer', 'captain_reveal', 'captain_stairs', 'arena_positions',
        'host_fixed_cards', 'card_event', 'demo_create', 'host_extras', 'demo_view', 'demo_status', 'demo_control',
        'demo_pulse', 'demo_end', 'captain_vehicle', 'squad_fire', 'join_flight', 'captain_jump', 'captain_lift',
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary', 'host_online_start',
        'host_online_auto', 'host_online_launch']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
