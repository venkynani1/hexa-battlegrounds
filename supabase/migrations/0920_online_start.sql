-- ═══════════════════════════════════════════════════════════════════════════
-- v10 · Online edition: the host starts the game; maps are assigned at the start
--
--  1. Before the start every online squad waits in one lobby (Map 1). Nobody is on a map yet.
--  2. host_online_start(token, length): one press
--     • merges every small squad across the whole event (nobody left out),
--     • spreads the squads evenly over as many maps as needed (15 squads = 60 players a map),
--     • starts the automatic match on every map at the same moment.
--  3. Leftovers: pairs and singles are merged into 3s and 4s; a lone player tops up a squad of 3,
--     or borrows from a squad of 4 (or of 3). As a last resort a squad of 2 plays, and the bot
--     covers its two missing roles. Only a single player in the whole event cannot play.
--  4. Late players (after the start) can fill an open seat in any squad that has not landed yet;
--     new squads cannot be created once the game has started.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists _defaults_v9();
alter function _defaults() rename to _defaults_v9;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v9() || jsonb_build_object(
    'online_started', 0)     -- set by host_online_start; before it, squads wait in the lobby
$$;

-- before the start every squad goes to Map 1 (the lobby); after it, no new squads
create or replace function _online_arena(p_ev uuid) returns uuid
language plpgsql as $$
declare v_arena uuid;
begin
  if _cfg(p_ev, 'online_started') = 1 then raise exception 'GAME_STARTED'; end if;
  select id into v_arena from arenas where event_id = p_ev order by number limit 1;
  if v_arena is null then
    insert into arenas(event_id, number, name) values (p_ev, 1, 'Map 1') returning id into v_arena;
  end if;
  return v_arena;
end $$;

-- a squad you can still join: before the start any squad; after it, one that has not landed
create or replace function _online_open(p_team uuid) returns boolean
language sql stable as $$
  select exists (select 1 from teams t join arenas a on a.id = t.arena_id
    where t.id = p_team and (a.phase in ('lobby', 'boarding', 'shuttle', 'roles') or (a.phase = 'play' and not t.dropped and t.jump_at is null)))
$$;

-- after the start: put a late player in the fullest squad that still has a seat and has not landed
create or replace function _online_late_team(p_ev uuid) returns uuid
language sql stable as $$
  select t.id from teams t join arenas a on a.id = t.arena_id
  where t.event_id = p_ev and t.ready and _online_open(t.id)
    and (select count(*) from players q where q.team_id = t.id and q.active) < 4
  order by (select count(*) from players q where q.team_id = t.id and q.active) desc, a.number, t.number limit 1
$$;

-- ── merge small squads over the whole event ────────────────────────────────
create or replace function _online_seal_event(p_ev uuid) returns jsonb
language plpgsql as $$
declare u record; v record; x record; v_t uuid; v_need int; v_moved int := 0; v_left int := 0;
begin
  -- 1. small squads merge with each other (pair + pair = 4, pair + single = 3, three singles = 3)
  for u in select t.id from teams t where t.event_id = p_ev order by _online_size(t.id) desc, t.open_squad, t.created_at loop
    continue when _online_size(u.id) not between 1 and 2;
    loop
      exit when _online_size(u.id) >= 3;
      select t.id into v_t from teams t
      where t.event_id = p_ev and t.id <> u.id and _online_size(t.id) between 1 and 2 and _online_size(t.id) <= 4 - _online_size(u.id)
      order by _online_size(t.id) desc, t.created_at limit 1;
      exit when v_t is null;
      for x in select id from players where team_id = v_t and active loop perform _online_move(x.id, u.id); v_moved := v_moved + 1; end loop;
    end loop;
  end loop;
  -- 2. what is left (at most one small squad) tops up squads of 3, matchmade squads first
  for u in select t.id from teams t where t.event_id = p_ev and _online_size(t.id) between 1 and 2 loop
    for x in select id from players where team_id = u.id and active loop
      select t.id into v_t from teams t where t.event_id = p_ev and t.id <> u.id and _online_size(t.id) = 3 order by t.open_squad desc, t.created_at limit 1;
      exit when v_t is null;
      perform _online_move(x.id, v_t); v_moved := v_moved + 1;
    end loop;
  end loop;
  -- 3. still short: borrow one player each from squads of 4
  for u in select t.id from teams t where t.event_id = p_ev and _online_size(t.id) between 1 and 2 loop
    v_need := 3 - _online_size(u.id);
    for v in select t.id from teams t where t.event_id = p_ev and t.id <> u.id and _online_size(t.id) = 4
             order by t.open_squad desc, t.created_at limit v_need loop
      select id into v_t from players where team_id = v.id and active order by joined_at desc limit 1;
      perform _online_move(v_t, u.id); v_moved := v_moved + 1;
    end loop;
  end loop;
  -- 4. a lone player borrows from a squad of 3 (two squads of 2, the bot covers the rest)
  for u in select t.id from teams t where t.event_id = p_ev and _online_size(t.id) = 1 loop
    select t.id into v_t from teams t where t.event_id = p_ev and t.id <> u.id and _online_size(t.id) = 3 order by t.open_squad desc, t.created_at limit 1;
    if v_t is not null then
      select id into v_t from players where team_id = v_t and active order by joined_at desc limit 1;
      perform _online_move(v_t, u.id); v_moved := v_moved + 1;
    end if;
  end loop;
  for u in select t.id from teams t where t.event_id = p_ev and _online_size(t.id) = 1 loop v_left := v_left + 1; end loop;
  update teams t set ready = (select count(*) from players q where q.team_id = t.id and q.active) >= 2,
                     roster_locked = (select count(*) from players q where q.team_id = t.id and q.active) >= 4
  where t.event_id = p_ev;
  return jsonb_build_object('moved', v_moved, 'left_out', v_left);
end $$;

-- the per-map seal at take-off also allows a last squad of 2 (bot-covered)
create or replace function _online_seal(p_arena uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  v := jsonb_build_object('moved', 0, 'left_out', 0);
  update teams t set ready = true where t.arena_id = p_arena and (select count(*) from players q where q.team_id = t.id and q.active) >= 2;
  return v;
end $$;

-- ── squads of 2 and 3: every missing role goes to someone as a second clue ─────
create or replace function _auto_roles(p_arena uuid) returns boolean
language plpgsql as $$
declare v_any boolean; t record; r text; v_p uuid;
begin
  v_any := _auto_roles_v8(p_arena);
  for t in select tm.id from teams tm where tm.arena_id = p_arena and tm.ready
           and not exists (select 1 from players q where q.team_id = tm.id and q.active and q.role is null)
           and (select count(*) from players q where q.team_id = tm.id and q.active and not q.away) between 1 and 3 loop
    for r in select x from unnest(array['scout', 'decoder', 'intel', 'captain']) x
             where not exists (select 1 from players q where q.team_id = t.id and q.active and (q.role = x or q.role2 = x)) loop
      continue when r = 'captain';
      select id into v_p from players where team_id = t.id and active and not away and role2 is null
      order by (role = 'captain'), random() limit 1;
      exit when v_p is null;
      update players set role2 = r, role2_bot = (select count(*) from players q where q.team_id = t.id and q.active) < 3 where id = v_p;
      insert into squad_chat(team_id, name, kind, body)
      select t.id, 'Hexa Air', 'system', display_name || ' also covers the ' || r || ' role' from players where id = v_p;
      perform _ping_team(t.id, 'roles');
      v_any := true;
    end loop;
  end loop;
  return v_any;
end $$;

-- ── the host's one button ──────────────────────────────────────────────────
create or replace function host_online_start(p_token text, p_length text default 'standard') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_seal jsonb; v_squads int; v_maps int; v_size int; v_max int; i int; v_arena uuid; t record; k int := 0;
  v_ids uuid[]; v_res jsonb := '[]'::jsonb; a record; v_bus int;
begin
  v_ev := _auth_host(p_token);
  if _cfg(v_ev, 'online') <> 1 then raise exception 'NOT_ONLINE_EVENT'; end if;
  if _cfg(v_ev, 'online_started') = 1 then raise exception 'ALREADY_STARTED'; end if;
  if coalesce(p_length, 'standard') not in ('quick', 'standard', 'full') then raise exception 'BAD_LENGTH'; end if;
  perform pg_advisory_xact_lock(hashtext('online:' || v_ev::text));
  v_seal := _online_seal_event(v_ev);
  delete from teams tm where tm.event_id = v_ev and not exists (select 1 from players q where q.team_id = tm.id and q.active);
  select count(*) into v_squads from teams where event_id = v_ev and ready;
  if v_squads = 0 then raise exception 'NO_READY_SQUADS'; end if;
  v_size := least(15, greatest(1, _cfg(v_ev, 'arena_size')));
  v_max := _cfg(v_ev, 'online_max_maps');
  v_maps := least(greatest(1, ceil(v_squads::numeric / v_size)::int), v_max);
  if v_squads > v_maps * v_size then raise exception 'TOO_MANY_SQUADS: % squads need more than % maps — raise "Most maps"', v_squads, v_max; end if;
  for i in 1..v_maps loop
    if not exists (select 1 from arenas where event_id = v_ev and number = i) then
      insert into arenas(event_id, number, name) values (v_ev, i, 'Map ' || i);
    end if;
  end loop;
  select array_agg(id order by number) into v_ids from arenas where event_id = v_ev and number <= v_maps;
  -- deal the squads out like cards so every map gets the same number (friends' squads stay whole)
  for t in select id from teams where event_id = v_ev and ready order by random() loop
    update teams set arena_id = v_ids[1 + (k % v_maps)] where id = t.id;
    k := k + 1;
  end loop;
  -- squads that cannot play (a single player in the whole event) wait in Map 1
  update teams set arena_id = v_ids[1] where event_id = v_ev and not ready;
  -- seat numbers and buses per map
  for a in select id from arenas where event_id = v_ev and number <= v_maps loop
    v_bus := 0;
    for t in select id from teams where arena_id = a.id order by number loop
      update teams set bus = 1 + v_bus / greatest(1, _cfg(v_ev, 'bus_size')) where id = t.id;
      v_bus := v_bus + 1;
    end loop;
  end loop;
  update events set settings = settings || '{"online_started": 1}'::jsonb where id = v_ev;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'online_start',
    jsonb_build_object('squads', v_squads, 'maps', v_maps, 'length', p_length) || v_seal);
  for i in 1..v_maps loop
    v_res := v_res || jsonb_build_object('map', i, 'start', host_command(p_token, v_ids[i], 'start_match', jsonb_build_object('length', coalesce(p_length, 'standard')), 'online start'));
  end loop;
  return jsonb_build_object('squads', v_squads, 'maps', v_maps, 'merged', v_seal -> 'moved', 'left_out', v_seal -> 'left_out', 'started', v_res);
end $$;

-- the lobby needs to know whether the game has started (phones show "map assigned at the start")
drop function if exists _player_state_v10(text);
alter function player_state(text) rename to _player_state_v10;
create function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  v := _player_state_v10(p_token);
  if jsonb_typeof(v -> 'online') = 'object' then
    v := jsonb_set(v, '{online,started}', to_jsonb(_cfg((select event_id from players p join teams t on t.id = p.team_id where p.session_hash = _hash(p_token)), 'online_started') = 1));
  end if;
  return v;
end $$;

create or replace function host_online_summary(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_sq int; v_size int;
begin
  v_ev := _auth_host(p_token);
  select count(*) into v_sq from teams t where t.event_id = v_ev and exists (select 1 from players q where q.team_id = t.id and q.active);
  v_size := least(15, greatest(1, _cfg(v_ev, 'arena_size')));
  return jsonb_build_object(
    'players', (select count(*) from online_members where event_id = v_ev),
    'started', _cfg(v_ev, 'online_started') = 1,
    'max_maps', _cfg(v_ev, 'online_max_maps'),
    'squads', v_sq,
    'full', (select count(*) from teams t where t.event_id = v_ev and (select count(*) from players q where q.team_id = t.id and q.active) = 4),
    'three', (select count(*) from teams t where t.event_id = v_ev and (select count(*) from players q where q.team_id = t.id and q.active) = 3),
    'short', (select count(*) from teams t where t.event_id = v_ev and (select count(*) from players q where q.team_id = t.id and q.active) between 1 and 2),
    'maps_needed', greatest(1, ceil(greatest(v_sq, 1)::numeric / v_size)::int),
    'maps', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'number', a.number, 'phase', a.phase,
        'squads', (select count(*) from teams t where t.arena_id = a.id),
        'ready', (select count(*) from teams t where t.arena_id = a.id and t.ready),
        'full', (select count(*) from teams t where t.arena_id = a.id and (select count(*) from players q where q.team_id = t.id and q.active) = 4),
        'short', (select count(*) from teams t where t.arena_id = a.id and (select count(*) from players q where q.team_id = t.id and q.active) between 1 and 2),
        'players', (select count(*) from players q join teams t on t.id = q.team_id where t.arena_id = a.id and q.active)) order by a.number), '[]'::jsonb)
      from arenas a where a.event_id = v_ev));
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
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary', 'host_online_start']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
