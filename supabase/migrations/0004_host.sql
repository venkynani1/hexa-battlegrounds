-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — host control API and read-only projector API
-- ════════════════════════════════════════════════════════════════════════════

create or replace function _auth_host(p_token text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select event_id into v from host_sessions where token_hash = _hash(p_token) and expires_at > now();
  if v is null then raise exception 'HOST_AUTH'; end if;
  return v;
end $$;

create or replace function host_create_event(p_code text, p_name text, p_secret text, p_arenas int default 2) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := upper(trim(p_code)); v_salt text := _new_token(); v_ev uuid; v_token text := _new_token(); i int;
begin
  if v_code !~ '^[A-Z0-9]{3,12}$' then raise exception 'BAD_CODE'; end if;
  if p_secret is null or length(p_secret) < 6 then raise exception 'WEAK_SECRET'; end if;
  if p_arenas < 1 or p_arenas > 6 then raise exception 'BAD_ARENAS'; end if;
  if exists (select 1 from events where code = v_code) then raise exception 'CODE_TAKEN'; end if;
  insert into events(code, name, host_salt, host_secret_hash)
  values (v_code, coalesce(nullif(trim(p_name), ''), 'Hexa Battlegrounds'), v_salt, _hash(v_salt || p_secret))
  returning id into v_ev;
  for i in 1..p_arenas loop
    insert into arenas(event_id, number, name) values (v_ev, i, 'Map ' || i);
  end loop;
  insert into host_sessions(token_hash, event_id) values (_hash(v_token), v_ev);
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'create_event', jsonb_build_object('code', v_code, 'arenas', p_arenas));
  return jsonb_build_object('event_id', v_ev, 'token', v_token, 'code', v_code);
end $$;

create or replace function host_login(p_code text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e events; v_token text := _new_token(); v_fails int;
begin
  select * into e from events where code = upper(trim(p_code));
  if e.id is null then raise exception 'HOST_AUTH'; end if;
  select count(*) into v_fails from audit_log where event_id = e.id and action = 'login_failed' and at > now() - interval '10 minutes';
  if v_fails >= 10 then raise exception 'LOCKED_OUT'; end if;
  if e.host_secret_hash <> _hash(e.host_salt || coalesce(p_secret, '')) then
    insert into audit_log(event_id, actor, action, ok) values (e.id, 'anonymous', 'login_failed', false);
    return jsonb_build_object('error', 'HOST_AUTH');
  end if;
  insert into host_sessions(token_hash, event_id) values (_hash(v_token), e.id);
  insert into audit_log(event_id, actor, action) values (e.id, 'host', 'login');
  return jsonb_build_object('event_id', e.id, 'token', v_token, 'code', e.code);
end $$;

-- Create N squads with random 4-digit PINs. PINs are returned ONCE (stored hashed).
create or replace function host_generate_teams(p_token text, p_count int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_start int; v_out jsonb := '[]'::jsonb; i int; v_pin text; v_salt text; v_arena uuid; v_size int; v_existing int;
begin
  v_ev := _auth_host(p_token);
  if p_count < 1 or p_count > 120 then raise exception 'BAD_COUNT'; end if;
  v_size := _cfg(v_ev, 'arena_size');
  select coalesce(max(number), 0) into v_start from teams where event_id = v_ev;
  for i in 1..p_count loop
    v_pin := lpad((floor(random() * 10000))::int::text, 4, '0');
    v_salt := _new_token();
    -- fill arenas in order, up to arena_size squads each
    select a.id into v_arena from arenas a
    where a.event_id = v_ev and a.phase = 'lobby'
      and (select count(*) from teams t where t.arena_id = a.id) < v_size
    order by a.number limit 1;
    if v_arena is null then raise exception 'ALL_MAPS_FULL'; end if;
    insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
    values (v_ev, v_arena, v_start + i, 'Squad ' || (v_start + i), v_salt, _hash(v_salt || v_pin));
    perform _add_item((select id from teams where event_id = v_ev and number = v_start + i), 'pistol', 1);
    perform _add_item((select id from teams where event_id = v_ev and number = v_start + i), 'medkit', 1);
    v_out := v_out || jsonb_build_object('number', v_start + i, 'pin', v_pin,
      'map', (select number from arenas where id = v_arena));
  end loop;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'generate_teams', jsonb_build_object('count', p_count));
  return v_out;
end $$;

-- Import organiser-approved squads: [{number, name, pin, map}]
create or replace function host_import_teams(p_token text, p_teams jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; r jsonb; v_salt text; v_arena uuid; v_size int; v_n int := 0; v_team uuid;
begin
  v_ev := _auth_host(p_token);
  v_size := _cfg(v_ev, 'arena_size');
  for r in select * from jsonb_array_elements(p_teams) loop
    if (r ->> 'number') is null or (r ->> 'pin') is null or length(r ->> 'pin') < 4 then raise exception 'BAD_ROW'; end if;
    v_arena := null;
    if (r ->> 'map') is not null then
      select id into v_arena from arenas where event_id = v_ev and number = (r ->> 'map')::int;
    end if;
    if v_arena is null then
      select a.id into v_arena from arenas a where a.event_id = v_ev and a.phase = 'lobby'
        and (select count(*) from teams t where t.arena_id = a.id) < v_size order by a.number limit 1;
    end if;
    if v_arena is null then raise exception 'ALL_MAPS_FULL'; end if;
    v_salt := _new_token();
    insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
    values (v_ev, v_arena, (r ->> 'number')::int, coalesce(nullif(r ->> 'name', ''), 'Squad ' || (r ->> 'number')), v_salt, _hash(v_salt || (r ->> 'pin')))
    on conflict (event_id, number) do update set name = excluded.name, pin_salt = excluded.pin_salt, pin_hash = excluded.pin_hash,
      arena_id = case when (select phase from arenas where id = teams.arena_id) = 'lobby' then excluded.arena_id else teams.arena_id end
    returning id into v_team;
    if not exists (select 1 from inventory where team_id = v_team) then
      perform _add_item(v_team, 'pistol', 1);
      perform _add_item(v_team, 'medkit', 1);
    end if;
    v_n := v_n + 1;
  end loop;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'import_teams', jsonb_build_object('count', v_n));
  return jsonb_build_object('imported', v_n);
end $$;

create or replace function host_overview(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; e events; r record;
begin
  v_ev := _auth_host(p_token);
  for r in select id from arenas where event_id = v_ev loop perform _tick(r.id); end loop;
  select * into e from events where id = v_ev;
  return jsonb_build_object(
    'server_now', now(),
    'event', jsonb_build_object('id', e.id, 'code', e.code, 'name', e.name, 'settings', _defaults() || e.settings,
      'grand_revealed', e.grand_revealed, 'seed', e.mission_seed),
    'arenas', (select coalesce(jsonb_agg(to_jsonb(a) - 'last_tick_at' order by a.number), '[]'::jsonb) from arenas a where a.event_id = v_ev),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'name', t.name, 'arena_id', t.arena_id, 'ready', t.ready, 'roster_locked', t.roster_locked,
        'bus', t.bus, 'hp', t.hp, 'shield', t.shield, 'coins', t.coins, 'points', t.points, 'trust', t.trust,
        'final_points', t.final_points, 'missions', t.missions_completed, 'battles', t.battle_wins,
        'location', t.location_id, 'state', t.state, 'travel_to', t.travel_to,
        'jammed', t.jammed_until > now(), 'protected', t.protected_until > now(),
        'players', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role,
            'online', p.last_seen_at > now() - interval '25 seconds') order by p.joined_at), '[]'::jsonb)
          from players p where p.team_id = t.id and p.active),
        'inventory', (select coalesce(jsonb_object_agg(item_id, qty), '{}'::jsonb) from inventory where team_id = t.id and qty > 0),
        'activity', (select jsonb_build_object('id', mi.id, 'kind', mi.kind, 'title', mt.title, 'template', mt.id,
            'attempts_left', mi.attempts_left, 'deadline', mi.deadline, 'hint_used', mi.hint_used,
            'answer', mt.parts, 'relay_key', mi.relay_key, 'explanation', mt.explanation)
          from mission_instances mi join mission_templates mt on mt.id = mi.template_id
          where mi.team_id = t.id and mi.status = 'active' order by (mi.kind = 'battle') desc, mi.created_at desc limit 1)
      ) order by t.number), '[]'::jsonb) from teams t where t.event_id = v_ev),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'arena_id', b.arena_id, 'weapon', b.weapon,
        'attacker', (select number from teams where id = b.attacker_id), 'defender', (select number from teams where id = b.defender_id),
        'deadline', b.deadline)), '[]'::jsonb) from battles b join arenas a on a.id = b.arena_id where a.event_id = v_ev and b.status = 'active'),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'arena_id', d.arena_id, 'location', d.location_id,
        'tier', d.tier, 'status', d.status, 'expires_at', d.expires_at)), '[]'::jsonb)
      from airdrops d join arenas a on a.id = d.arena_id where a.event_id = v_ev and d.status = 'open'),
    'sync_rounds', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'arena_id', s.arena_id, 'stage', s.stage,
        'kind', s.kind, 'deadline', s.deadline, 'status', s.status,
        'solved', (select count(*) from mission_instances where sync_round_id = s.id and status = 'solved'),
        'total', (select count(*) from mission_instances where sync_round_id = s.id))), '[]'::jsonb)
      from sync_rounds s join arenas a on a.id = s.arena_id where a.event_id = v_ev and s.started_at > now() - interval '30 minutes'),
    'reports', (select count(*) from chat_messages c join arenas a on a.id = c.arena_id where a.event_id = v_ev and c.reported and not c.hidden),
    'metrics', jsonb_build_object(
      'players_online', (select count(*) from players p join teams t on t.id = p.team_id where t.event_id = v_ev and p.active and p.last_seen_at > now() - interval '25 seconds'),
      'players_total', (select count(*) from players p join teams t on t.id = p.team_id where t.event_id = v_ev and p.active),
      'squads_ready', (select count(*) from teams where event_id = v_ev and ready),
      'submissions_5m', (select count(*) from submissions s join teams t on t.id = s.team_id where t.event_id = v_ev and s.at > now() - interval '5 minutes'),
      'wrong_5m', (select count(*) from submissions s join teams t on t.id = s.team_id where t.event_id = v_ev and not s.correct and s.at > now() - interval '5 minutes'),
      'missions_solved', (select count(*) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.status = 'solved'),
      'missions_failed', (select count(*) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.status in ('failed', 'expired')),
      'host_errors', (select count(*) from audit_log where event_id = v_ev and not ok and action <> 'login_failed')),
    'feed', (select coalesce(jsonb_agg(jsonb_build_object('arena_id', f.arena_id, 'type', f.type, 'payload', f.payload, 'at', f.at) order by f.id desc), '[]'::jsonb)
      from (select g.* from game_feed g join arenas a on a.id = g.arena_id where a.event_id = v_ev order by g.id desc limit 40) f)
  );
end $$;

-- One entry point for every host command. Every call is audited (including failures).
create or replace function host_command(p_token text, p_arena uuid, p_cmd text, p_args jsonb default '{}'::jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_ids uuid[]; v_id uuid; v_out jsonb := '{}'::jsonb; v_err text;
  v_all_ok text[] := array['open_boarding','assign_buses','drive','finalize_roles','pause','resume','broadcast','clear_overlay',
    'blackout','countdown','story','bargain','zone_warn','zone_now','zone_cancel','zone_set','spawn_airdrop','begin_finale',
    'finale_stage','launch_sync','close_sync','lock_results','reveal_winner','end_game','reveal_squad00'];
begin
  v_ev := _auth_host(p_token);
  p_args := coalesce(p_args, '{}'::jsonb);
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
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), _host_exec(v_ev, v_id, p_cmd, p_args, p_reason));
      insert into audit_log(event_id, arena_id, actor, action, args, reason) values (v_ev, v_id, 'host', p_cmd, p_args, p_reason);
    exception when others then
      v_err := sqlerrm;
      insert into audit_log(event_id, arena_id, actor, action, args, reason, ok, error) values (v_ev, v_id, 'host', p_cmd, p_args, p_reason, false, v_err);
      if array_length(v_ids, 1) = 1 then
        return jsonb_build_object('ok', false, 'error', v_err);
      end if;
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), jsonb_build_object('error', v_err));
    end;
    if v_id is not null then perform _ping_arena(v_id, 'host'); end if;
  end loop;
  return jsonb_build_object('ok', true, 'result', v_out);
end $$;

create or replace function _host_exec(p_ev uuid, p_arena uuid, p_cmd text, p_args jsonb, p_reason text) returns jsonb
language plpgsql as $$
declare a arenas; t teams; r record; v_n int := 0; v_delta interval; v_tpl text; v_round uuid; v_kind text; v_seed int;
  v_secs int; v_max int; v_teams uuid[]; i int; v_idx int; v_res jsonb; v_role text; p players; v_other uuid;
begin
  if p_arena is not null then select * into a from arenas where id = p_arena for update; end if;
  select mission_seed into v_seed from events where id = p_ev;

  case p_cmd
  -- ── lobby / shuttle ──
  when 'open_boarding', 'assign_buses' then
    if a.phase not in ('lobby', 'boarding') then raise exception 'WRONG_PHASE'; end if;
    for r in select id, row_number() over (order by number) as rn from teams where arena_id = a.id and ready loop
      update teams set bus = 1 + ((r.rn - 1) / _cfg(p_ev, 'bus_size'))::int where id = r.id;
      v_n := v_n + 1;
    end loop;
    update arenas set phase = 'boarding' where id = a.id;
    perform _feed(a.id, 'shuttle.assigned', jsonb_build_object('squads', v_n));
    return jsonb_build_object('boarded', v_n);
  when 'drive' then
    if a.phase <> 'boarding' then raise exception 'WRONG_PHASE'; end if;
    update arenas set phase = 'shuttle', shuttle_departed_at = now(),
      shuttle_arrive_at = now() + _secs(_cfg(p_ev, 'shuttle_seconds')) where id = a.id;
    perform _feed(a.id, 'shuttle.departed', '{}'::jsonb);
  when 'finalize_roles' then
    if a.phase = 'shuttle' then update arenas set shuttle_arrive_at = now() where id = a.id; perform _tick(a.id, true); end if;
    update arenas set roles_deadline = now() where id = a.id and phase = 'roles';
    perform _tick(a.id, true);
  when 'set_role' then
    select * into p from players where id = (p_args ->> 'player_id')::uuid;
    select * into t from teams where id = p.team_id and event_id = p_ev;
    if t.id is null then raise exception 'NOT_FOUND'; end if;
    v_role := p_args ->> 'role';
    if v_role not in ('captain', 'scout', 'decoder', 'intel') then raise exception 'BAD_ROLE'; end if;
    select id into v_other from players where team_id = t.id and active and role = v_role and id <> p.id;
    update players set role = null where id = v_other;
    update players set role = v_role where id = p.id;
    if v_other is not null then update players set role = p.role where id = v_other; end if;
    perform _ping_team(t.id, 'roles');
  when 'remove_player' then
    select * into p from players where id = (p_args ->> 'player_id')::uuid;
    select * into t from teams where id = p.team_id and event_id = p_ev for update;
    if t.id is null then raise exception 'NOT_FOUND'; end if;
    update players set active = false, role = null, session_hash = 'revoked-' || id::text where id = p.id;
    -- the vacancy is filled by a replacement who joins with the squad PIN and inherits the role
    update teams set roster_locked = false where id = t.id;
    if (select phase from arenas where id = t.arena_id) in ('lobby', 'boarding') then
      update teams set ready = false where id = t.id;
    end if;
    perform _ping_team(t.id, 'roster');
  when 'reopen_team' then
    update teams set roster_locked = false where id = (p_args ->> 'team_id')::uuid and event_id = p_ev;
  when 'lock_team' then
    update teams set roster_locked = true, ready = (select count(*) = 4 from players where team_id = teams.id and active)
    where id = (p_args ->> 'team_id')::uuid and event_id = p_ev;
  when 'fill_roles' then
    -- give a replacement player the role nobody holds
    perform _finalize_roles((select arena_id from teams where id = (p_args ->> 'team_id')::uuid and event_id = p_ev));

  -- ── game flow ──
  when 'pause' then
    if a.paused then return '{}'::jsonb; end if;
    update arenas set paused = true, paused_at = now() where id = a.id;
    perform _feed(a.id, 'game.paused', '{}'::jsonb);
  when 'resume' then
    if not a.paused then return '{}'::jsonb; end if;
    v_delta := now() - a.paused_at;
    update arenas set paused = false, paused_at = null,
      shuttle_arrive_at = shuttle_arrive_at + v_delta, roles_deadline = roles_deadline + v_delta,
      play_started_at = play_started_at + v_delta, zone_next_at = zone_next_at + v_delta,
      last_airdrop_at = last_airdrop_at + v_delta
    where id = a.id;
    update mission_instances set deadline = deadline + v_delta, fallback_at = fallback_at + v_delta,
      started_at = started_at + v_delta where arena_id = a.id and status = 'active';
    update battles set deadline = deadline + v_delta where arena_id = a.id and status = 'active';
    update sync_rounds set deadline = deadline + v_delta, started_at = started_at + v_delta where arena_id = a.id and status = 'active';
    update airdrops set expires_at = expires_at + v_delta where arena_id = a.id and status = 'open';
    update teams set travel_arrive_at = travel_arrive_at + v_delta, recovery_deadline = recovery_deadline + v_delta,
      attack_cooldown_until = attack_cooldown_until + v_delta, protected_until = protected_until + v_delta,
      jammed_until = jammed_until + v_delta, scan_until = scan_until + v_delta
    where arena_id = a.id;
    perform _feed(a.id, 'game.resumed', '{}'::jsonb);
  when 'broadcast' then
    update arenas set overlay = overlay || jsonb_build_object('broadcast', jsonb_build_object(
      'text', left(p_args ->> 'text', 280), 'tone', coalesce(p_args ->> 'tone', 'info'), 'at', now())) where id = a.id;
    perform _feed(a.id, 'story.broadcast', jsonb_build_object('text', left(p_args ->> 'text', 280)));
  when 'clear_overlay' then
    update arenas set overlay = '{}'::jsonb where id = a.id;
  when 'blackout' then
    update arenas set overlay = overlay || jsonb_build_object('blackout', coalesce((p_args ->> 'on')::boolean, true)) where id = a.id;
  when 'countdown' then
    update arenas set overlay = overlay || jsonb_build_object('countdown', jsonb_build_object(
      'until', now() + _secs(coalesce((p_args ->> 'seconds')::int, 10)), 'label', coalesce(p_args ->> 'label', ''))) where id = a.id;
  when 'story' then
    insert into story_events(arena_id, kind, title, body) values (a.id, 'transmission',
      coalesce(p_args ->> 'title', 'Squad 00 transmission'), coalesce(p_args ->> 'body', ''));
    perform _feed(a.id, 'squad00.transmission', jsonb_build_object('title', p_args ->> 'title'));
  when 'bargain' then
    insert into story_events(arena_id, kind, title, body, offer, expires_at) values (a.id, 'bargain',
      coalesce(p_args ->> 'title', 'Squad 00 offers a deal'), coalesce(p_args ->> 'body', ''),
      jsonb_build_object('coins', coalesce((p_args ->> 'coins')::int, 60), 'threat', coalesce((p_args ->> 'threat')::int, 1),
                         'trust', coalesce((p_args ->> 'trust')::int, -5)),
      now() + make_interval(mins => coalesce((p_args ->> 'minutes')::int, 3)));
    perform _feed(a.id, 'squad00.bargain', '{}'::jsonb);

  -- ── map & zone ──
  when 'zone_warn' then
    if a.zone_stage >= 5 then raise exception 'ZONE_FINAL'; end if;
    update arenas set zone_next_at = now() + _secs(coalesce((p_args ->> 'seconds')::int, _cfg(p_ev, 'zone_warning'))) where id = a.id;
    perform _feed(a.id, 'zone.warning', jsonb_build_object('stage', a.zone_stage + 1));
  when 'zone_now' then
    if a.zone_stage >= 5 then raise exception 'ZONE_FINAL'; end if;
    perform _zone_advance(a.id);
  when 'zone_cancel' then
    update arenas set zone_next_at = null where id = a.id;
    perform _feed(a.id, 'zone.cancelled', '{}'::jsonb);
  when 'zone_set' then
    update arenas set zone_stage = greatest(0, least(5, (p_args ->> 'stage')::int)), zone_next_at = null where id = a.id;
    perform _apply_zone(a.id);
    perform _feed(a.id, 'zone.collapsed', jsonb_build_object('stage', (p_args ->> 'stage')::int));
  when 'set_location' then
    if p_args ->> 'location' in ('tr14', 'gate_1', 'hx_lobby') and not coalesce((p_args ->> 'enabled')::boolean, true) then
      raise exception 'LOCATION_REQUIRED';
    end if;
    update locations set enabled = coalesce((p_args ->> 'enabled')::boolean, true) where id = p_args ->> 'location';
  when 'spawn_airdrop' then
    return jsonb_build_object('airdrop', _spawn_airdrop(a.id, nullif(p_args ->> 'location', ''), coalesce(p_args ->> 'tier', 'common')));
  when 'relocate' then
    select * into t from teams where id = (p_args ->> 'team_id')::uuid and event_id = p_ev for update;
    if t.id is null or not exists (select 1 from locations where id = p_args ->> 'location') then raise exception 'NOT_FOUND'; end if;
    update teams set location_id = p_args ->> 'location', state = case when state = 'traveling' then 'idle' else state end,
      travel_to = null, travel_from = null, travel_arrive_at = null, dropped = true, visit_missions = 0 where id = t.id;
    perform _ping_team(t.id, 'move');

  -- ── squads, scoring & missions ──
  when 'adjust' then
    if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
    select * into t from teams where id = (p_args ->> 'team_id')::uuid and event_id = p_ev;
    if t.id is null then raise exception 'NOT_FOUND'; end if;
    perform _apply(t.id, 'host_adjust', coalesce((p_args ->> 'points')::int, 0), coalesce((p_args ->> 'coins')::int, 0),
      coalesce((p_args ->> 'hp')::int, 0), coalesce((p_args ->> 'trust')::int, 0), null, p_reason, 'host');
    if coalesce((p_args ->> 'final_points')::int, 0) <> 0 then
      update teams set final_points = final_points + (p_args ->> 'final_points')::int where id = t.id;
    end if;
    if (p_args ->> 'item') is not null then perform _add_item(t.id, p_args ->> 'item', coalesce((p_args ->> 'qty')::int, 1)); end if;
    select * into t from teams where id = t.id;
    if t.hp <= 0 then perform _enter_recovery(t.id); end if;
    perform _ping_team(t.id, 'score');
  when 'respawn' then
    perform _respawn((p_args ->> 'team_id')::uuid, 'host');
  when 'reveal_hint' then
    update mission_instances set hint_used = true where id = (p_args ->> 'instance_id')::uuid;
    perform _ping_team((select team_id from mission_instances where id = (p_args ->> 'instance_id')::uuid), 'hint');
  when 'cancel_instance' then
    update mission_instances mi set status = 'cancelled' from teams t2
    where mi.id = (p_args ->> 'instance_id')::uuid and mi.team_id = t2.id and t2.event_id = p_ev and mi.status = 'active'
      and mi.kind <> 'battle';
    perform _ping_team((select team_id from mission_instances where id = (p_args ->> 'instance_id')::uuid), 'mission');
  when 'assign_mission' then
    select * into t from teams where id = (p_args ->> 'team_id')::uuid and event_id = p_ev;
    if t.id is null then raise exception 'NOT_FOUND'; end if;
    if not exists (select 1 from mission_templates where id = p_args ->> 'template_id' and status in ('approved', 'published')) then
      raise exception 'TEMPLATE_NOT_APPROVED';
    end if;
    update mission_instances set status = 'cancelled' where team_id = t.id and status = 'active' and kind <> 'battle';
    return jsonb_build_object('instance', _start_instance(t.id, p_args ->> 'template_id'));
  when 'end_battle' then
    perform _resolve_battle((p_args ->> 'battle_id')::uuid, nullif(p_args ->> 'winner_id', '')::uuid);
  when 'hide_message' then
    update chat_messages c set hidden = true from arenas ar
    where c.id = (p_args ->> 'message_id')::bigint and ar.id = c.arena_id and ar.event_id = p_ev;

  -- ── finale ──
  when 'begin_finale' then
    if a.phase <> 'play' then raise exception 'WRONG_PHASE'; end if;
    for r in select id from battles where arena_id = a.id and status = 'active' loop perform _resolve_battle(r.id, null); end loop;
    update mission_instances set status = 'cancelled' where arena_id = a.id and status = 'active';
    update teams set state = 'idle', recovery_deadline = null, hp = greatest(hp, _cfg(p_ev, 'hp_respawn'))
      where arena_id = a.id and state = 'recovery';
    update teams set location_id = 'tr14', state = 'idle', travel_to = null, travel_from = null, travel_arrive_at = null
      where arena_id = a.id and ready;
    update airdrops set status = 'expired' where arena_id = a.id and status = 'open';
    update arenas set phase = 'finale', zone_stage = 5, zone_next_at = null, finale_stage = 'A' where id = a.id;
    perform _feed(a.id, 'final.started', '{}'::jsonb);
  when 'finale_stage' then
    if a.phase <> 'finale' then raise exception 'WRONG_PHASE'; end if;
    if p_args ->> 'stage' not in ('A', 'B', 'C', 'D', 'E', 'F') then raise exception 'BAD_STAGE'; end if;
    update arenas set finale_stage = p_args ->> 'stage' where id = a.id;
    perform _feed(a.id, 'final.stage', jsonb_build_object('stage', p_args ->> 'stage'));
  when 'reveal_squad00' then
    update arenas set finale_stage = 'D' where id = a.id and phase = 'finale';
    insert into story_events(arena_id, kind, title, body) values (a.id, 'reveal', 'The truth about Squad 00', 'See the main screen.');
    perform _feed(a.id, 'squad00.revealed', '{}'::jsonb);
  when 'launch_sync' then
    if a.phase <> 'finale' then raise exception 'WRONG_PHASE'; end if;
    v_kind := coalesce(p_args ->> 'kind', 'finale_battle');
    if v_kind not in ('finale_entry', 'finale_exchange', 'finale_battle', 'final_code') then raise exception 'BAD_KIND'; end if;
    -- identical template for every arena: chosen by event seed and how many rounds of this kind already ran
    select count(*) into v_idx from sync_rounds where arena_id = a.id and kind = v_kind;
    v_tpl := p_args ->> 'template_id';
    if v_tpl is null then
      select id into v_tpl from mission_templates where kind = v_kind and status = 'published'
      order by md5(v_seed::text || id) offset (v_idx % greatest(1, (select count(*) from mission_templates where kind = v_kind and status = 'published'))::int) limit 1;
    end if;
    if v_tpl is null then raise exception 'NO_TEMPLATE'; end if;
    v_secs := coalesce((p_args ->> 'seconds')::int, nullif(_cfg(p_ev, 'sync_seconds'), 0), (select time_limit from mission_templates where id = v_tpl));
    v_max := case v_kind when 'finale_entry' then _cfg(p_ev, 'finale_entry_max') when 'finale_exchange' then _cfg(p_ev, 'finale_exchange_max')
                         else _cfg(p_ev, 'finale_max') end;
    update sync_rounds set status = 'closed' where arena_id = a.id and status = 'active';
    update mission_instances set status = 'cancelled' where arena_id = a.id and status = 'active';
    insert into sync_rounds(arena_id, stage, kind, template_id, deadline, max_points)
    values (a.id, coalesce(a.finale_stage, 'C'), v_kind, v_tpl, now() + _secs(v_secs), v_max) returning id into v_round;
    update arenas set sync_round_id = v_round where id = a.id;
    select array_agg(id order by number) into v_teams from teams where arena_id = a.id and ready;
    for i in 1..coalesce(array_length(v_teams, 1), 0) loop
      -- exchange rounds pair each squad with the next one (cyclic), so nobody depends on a single holdout
      perform _start_instance(v_teams[i], v_tpl, 'tr14', null, null, v_round, now() + _secs(v_secs),
        case when array_length(v_teams, 1) > 1 then v_teams[1 + (i % array_length(v_teams, 1))] end);
    end loop;
    perform _feed(a.id, 'sync.started', jsonb_build_object('kind', v_kind, 'seconds', v_secs));
    return jsonb_build_object('round', v_round, 'template', v_tpl);
  when 'close_sync' then
    update sync_rounds set deadline = now() where arena_id = a.id and status = 'active';
    update mission_instances set deadline = now() where arena_id = a.id and status = 'active' and sync_round_id is not null;
    perform _tick(a.id, true);
  when 'lock_results' then
    update sync_rounds set deadline = now() where arena_id = a.id and status = 'active';
    perform _tick(a.id, true);
    v_res := _standings(a.id);
    update arenas set results = v_res, results_locked = true, phase = 'results', finale_stage = 'F' where id = a.id;
    perform _feed(a.id, 'results.locked', '{}'::jsonb);
    return jsonb_build_object('standings', v_res);
  when 'unlock_results' then
    update arenas set results_locked = false, winner_revealed = false, phase = 'finale' where id = a.id;
  when 'reveal_winner' then
    if not a.results_locked then raise exception 'LOCK_RESULTS_FIRST'; end if;
    update arenas set winner_revealed = true where id = a.id;
    perform _feed(a.id, 'winner.revealed', jsonb_build_object('team', a.results -> 0 -> 'number'));
  when 'reveal_grand' then
    if exists (select 1 from arenas where event_id = p_ev and not results_locked) then raise exception 'LOCK_ALL_MAPS_FIRST'; end if;
    update events set grand_revealed = true where id = p_ev;
    for r in select id from arenas where event_id = p_ev loop perform _ping_arena(r.id, 'grand'); end loop;
  when 'end_game' then
    update arenas set phase = 'ended' where id = a.id;
  when 'revoke_spectator' then
    update arenas set spectator_token = replace(gen_random_uuid()::text, '-', '') where id = a.id;
    perform _ping_arena(a.id, 'revoked');
  when 'reset_arena' then
    -- rehearsal helper: wipes gameplay but keeps squads & players
    if coalesce(p_args ->> 'confirm', '') <> 'RESET' then raise exception 'CONFIRM_REQUIRED'; end if;
    delete from submissions s using mission_instances mi where s.instance_id = mi.id and mi.arena_id = a.id;
    delete from mission_instances where arena_id = a.id;
    delete from battles where arena_id = a.id;
    delete from airdrops where arena_id = a.id;
    delete from sync_rounds where arena_id = a.id;
    delete from chat_messages where arena_id = a.id;
    delete from alliances where arena_id = a.id;
    delete from story_events where arena_id = a.id;
    delete from game_feed where arena_id = a.id;
    delete from ledger where arena_id = a.id;
    delete from inventory where team_id in (select id from teams where arena_id = a.id);
    update teams set hp = 100, shield = 0, coins = 50, points = 0, trust = 0, final_points = 0, missions_completed = 0,
      battle_wins = 0, location_id = null, dropped = false, state = 'idle', travel_from = null, travel_to = null,
      travel_arrive_at = null, recovery_deadline = null, attack_cooldown_until = null, protected_until = null,
      jammed_until = null, scan_until = null, beacon = false, zone_penalty_stage = 0, mission_counter = 0,
      visit_missions = 0, bargains = '[]'::jsonb, bus = null
    where arena_id = a.id;
    for r in select id from teams where arena_id = a.id loop
      perform _add_item(r.id, 'pistol', 1); perform _add_item(r.id, 'medkit', 1);
    end loop;
    update players set role = null where team_id in (select id from teams where arena_id = a.id);
    update arenas set phase = 'lobby', paused = false, paused_at = null, shuttle_departed_at = null, shuttle_arrive_at = null,
      roles_deadline = null, play_started_at = null, zone_stage = 0, zone_next_at = null, finale_stage = null,
      sync_round_id = null, threat = 0, last_airdrop_at = null, results_locked = false, results = null,
      winner_revealed = false, overlay = '{}'::jsonb where id = a.id;
    update events set grand_revealed = false where id = p_ev;
  else
    raise exception 'UNKNOWN_COMMAND';
  end case;
  return '{}'::jsonb;
end $$;

create or replace function host_settings(p_token text, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; k text;
begin
  v_ev := _auth_host(p_token);
  for k in select jsonb_object_keys(p_settings) loop
    if not (_defaults() ? k) then raise exception 'UNKNOWN_SETTING: %', k; end if;
  end loop;
  update events set settings = settings || p_settings where id = v_ev;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'settings', p_settings);
  return (select _defaults() || settings from events where id = v_ev);
end $$;

create or replace function host_missions(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _auth_host(p_token);
  return (select coalesce(jsonb_agg(to_jsonb(m) order by m.kind, m.id), '[]'::jsonb) from mission_templates m);
end $$;

create or replace function host_save_mission(p_token text, p_mission jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; m jsonb := p_mission; v_parts jsonb; v_role text;
begin
  v_ev := _auth_host(p_token);
  if coalesce(m ->> 'id', '') !~ '^[a-z0-9_-]{3,60}$' then raise exception 'BAD_ID'; end if;
  foreach v_role in array array['scout', 'decoder', 'intel'] loop
    if coalesce(m -> 'clues' -> v_role ->> 'body', '') = '' then raise exception 'MISSING_CLUE: %', v_role; end if;
  end loop;
  -- normalise every accepted answer exactly as the validator will
  select jsonb_agg(jsonb_build_object('label', coalesce(pt ->> 'label', 'Answer'),
    'accept', (select jsonb_agg(case when acc = '{KEY}' then acc else _norm(acc) end) from jsonb_array_elements_text(pt -> 'accept') acc)))
  into v_parts from jsonb_array_elements(m -> 'parts') pt;
  if v_parts is null or exists (select 1 from jsonb_array_elements(v_parts) pt where jsonb_array_length(coalesce(pt -> 'accept', '[]')) = 0
     or exists (select 1 from jsonb_array_elements_text(pt -> 'accept') acc where acc = '')) then
    raise exception 'MISSING_ANSWER';
  end if;
  insert into mission_templates(id, family, kind, title, category, difficulty, tags, objective, clues, parts, relay,
    attempts, time_limit, hint, explanation, points, coins, status)
  values (m ->> 'id', coalesce(m ->> 'family', 'custom'), coalesce(m ->> 'kind', 'mission'), m ->> 'title',
    coalesce(m ->> 'category', 'custom'), coalesce((m ->> 'difficulty')::int, 1),
    coalesce((select array_agg(x) from jsonb_array_elements_text(m -> 'tags') x), array['any']),
    m ->> 'objective', m -> 'clues', v_parts, coalesce((m ->> 'relay')::boolean, false),
    coalesce((m ->> 'attempts')::int, 3), coalesce((m ->> 'time_limit')::int, 180), m ->> 'hint', m ->> 'explanation',
    nullif(m ->> 'points', '')::int, coalesce((m ->> 'coins')::int, 25), coalesce(m ->> 'status', 'draft'))
  on conflict (id) do update set
    family = excluded.family, kind = excluded.kind, title = excluded.title, category = excluded.category,
    difficulty = excluded.difficulty, tags = excluded.tags, objective = excluded.objective, clues = excluded.clues,
    parts = excluded.parts, relay = excluded.relay, attempts = excluded.attempts, time_limit = excluded.time_limit,
    hint = excluded.hint, explanation = excluded.explanation, points = excluded.points, coins = excluded.coins,
    status = excluded.status, version = mission_templates.version + 1, updated_at = now();
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'save_mission', jsonb_build_object('id', m ->> 'id', 'status', m ->> 'status'));
  return (select to_jsonb(mt) from mission_templates mt where id = m ->> 'id');
end $$;

create or replace function host_test_answer(p_token text, p_template text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mt mission_templates; v_part jsonb; v_i int := 0; v_ok boolean := true;
begin
  perform _auth_host(p_token);
  select * into mt from mission_templates where id = p_template;
  if mt.id is null then raise exception 'NOT_FOUND'; end if;
  for v_part in select value from jsonb_array_elements(mt.parts) loop
    if not exists (select 1 from jsonb_array_elements_text(v_part -> 'accept') acc
                   where acc = '{KEY}' or acc = _norm(p_answers ->> v_i)) then v_ok := false; end if;
    v_i := v_i + 1;
  end loop;
  return jsonb_build_object('correct', v_ok);
end $$;

create or replace function host_chat_log(p_token text, p_arena uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'from', (select number from teams where id = c.from_team),
      'to', (select number from teams where id = c.to_team), 'body', c.body, 'at', c.at, 'hidden', c.hidden, 'reported', c.reported)
    order by c.id desc), '[]'::jsonb)
    from (select * from chat_messages where arena_id = p_arena and arena_id in (select id from arenas where event_id = v_ev)
          order by id desc limit 200) c);
end $$;

create or replace function host_audit(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return jsonb_build_object(
    'audit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc), '[]'::jsonb)
              from (select * from audit_log where event_id = v_ev order by id desc limit 200) x),
    'ledger', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'team', t.number, 'kind', l.kind, 'points', l.points,
                 'coins', l.coins, 'hp', l.hp, 'trust', l.trust, 'reason', l.reason, 'actor', l.actor) order by l.id desc), '[]'::jsonb)
               from (select * from ledger where arena_id in (select id from arenas where event_id = v_ev) order by id desc limit 300) l
               join teams t on t.id = l.team_id));
end $$;

-- Full event export (results, ledger, audit) for the post-event summary
create or replace function host_export(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return jsonb_build_object(
    'event', (select jsonb_build_object('code', code, 'name', name, 'settings', _defaults() || settings) from events where id = v_ev),
    'grand_standings', _event_standings(v_ev),
    'arenas', (select jsonb_agg(jsonb_build_object('number', number, 'name', name, 'standings', _standings(id), 'threat', threat) order by number)
               from arenas where event_id = v_ev),
    'ledger', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'team', t.number, 'kind', l.kind, 'points', l.points,
                 'coins', l.coins, 'hp', l.hp, 'trust', l.trust, 'reason', l.reason, 'actor', l.actor) order by l.id), '[]'::jsonb)
               from ledger l join teams t on t.id = l.team_id where t.event_id = v_ev),
    'audit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from audit_log x where x.event_id = v_ev),
    'aggregates', jsonb_build_object(
      'missions_solved', (select count(*) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.status = 'solved'),
      'missions_failed', (select count(*) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.status in ('failed', 'expired')),
      'avg_solve_seconds', (select round(avg(extract(epoch from mi.solved_at - mi.started_at))) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.status = 'solved'),
      'hints_used', (select count(*) from mission_instances mi join teams t on t.id = mi.team_id where t.event_id = v_ev and mi.hint_used),
      'battles', (select count(*) from battles b join arenas a on a.id = b.arena_id where a.event_id = v_ev),
      'airdrops_claimed', (select count(*) from airdrops d join arenas a on a.id = d.arena_id where a.event_id = v_ev and d.status = 'claimed'),
      'messages', (select count(*) from chat_messages c join arenas a on a.id = c.arena_id where a.event_id = v_ev),
      'recoveries', (select count(*) from ledger l join teams t on t.id = l.team_id where t.event_id = v_ev and l.kind = 'recovery_penalty'))
  );
end $$;

-- ── Projector / spectator (read-only, public data only) ──────────────────────
create or replace function spectator_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a arenas; e events; sr sync_rounds; v_recap jsonb; v_show_scores boolean;
begin
  select * into a from arenas where spectator_token = p_token;
  if a.id is null or p_token is null or length(p_token) < 16 then raise exception 'SPECTATOR_AUTH'; end if;
  perform _tick(a.id);
  select * into a from arenas where id = a.id;
  select * into e from events where id = a.event_id;
  select * into sr from sync_rounds where id = a.sync_round_id;
  v_show_scores := a.phase in ('lobby', 'boarding', 'shuttle', 'roles', 'play');
  if a.phase in ('finale', 'results', 'ended') and coalesce(a.finale_stage, 'A') >= 'D' then
    v_recap := jsonb_build_object(
      'bargains_accepted', (select count(*) from teams t, jsonb_array_elements(t.bargains) b where t.arena_id = a.id and (b ->> 'accept')::boolean),
      'bargains_refused', (select count(*) from teams t, jsonb_array_elements(t.bargains) b where t.arena_id = a.id and not (b ->> 'accept')::boolean),
      'betrayals', (select count(*) from alliances where arena_id = a.id and status = 'betrayed'),
      'alliances', (select count(*) from alliances where arena_id = a.id and status in ('active', 'ended', 'expired', 'betrayed') and expires_at > created_at and status <> 'expired'),
      'codewords_shared', (select count(*) from ledger where arena_id = a.id and kind = 'relay_assist'),
      'battles', (select count(*) from battles where arena_id = a.id),
      'threat', a.threat);
  end if;
  return jsonb_build_object(
    'server_now', now(),
    'event', jsonb_build_object('name', e.name, 'code', e.code, 'grand_revealed', e.grand_revealed),
    'arena', jsonb_build_object('id', a.id, 'number', a.number, 'name', a.name, 'phase', a.phase, 'paused', a.paused,
      'shuttle_departed_at', a.shuttle_departed_at, 'shuttle_arrive_at', a.shuttle_arrive_at, 'roles_deadline', a.roles_deadline,
      'zone_stage', a.zone_stage, 'zone_next_at', a.zone_next_at, 'finale_stage', a.finale_stage, 'threat', a.threat,
      'overlay', a.overlay, 'results_locked', a.results_locked, 'winner_revealed', a.winner_revealed),
    'squads', (select coalesce(jsonb_agg(jsonb_build_object('number', t.number, 'name', t.name, 'ready', t.ready, 'bus', t.bus,
        'players', (select count(*) from players where team_id = t.id and active),
        'hp', t.hp, 'state', t.state,
        'points', case when v_show_scores then t.points end,
        'location', case when t.jammed_until is null or t.jammed_until < now() then t.location_id end,
        'travel_to', case when t.jammed_until is null or t.jammed_until < now() then t.travel_to end,
        'travel_from', case when t.jammed_until is null or t.jammed_until < now() then t.travel_from end,
        'travel_started_at', t.travel_started_at, 'travel_arrive_at', t.travel_arrive_at,
        'in_battle', exists (select 1 from battles b where b.status = 'active' and (b.attacker_id = t.id or b.defender_id = t.id)),
        'sync_solved', case when sr.id is not null then exists (select 1 from mission_instances mi where mi.sync_round_id = sr.id and mi.team_id = t.id and mi.status = 'solved') end
      ) order by t.number), '[]'::jsonb) from teams t where t.arena_id = a.id),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('location', location_id, 'tier', tier, 'expires_at', expires_at)), '[]'::jsonb)
      from airdrops where arena_id = a.id and status = 'open'),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('attacker', (select number from teams where id = b.attacker_id),
        'defender', (select number from teams where id = b.defender_id), 'weapon', b.weapon, 'location', b.location_id, 'deadline', b.deadline)), '[]'::jsonb)
      from battles b where b.arena_id = a.id and b.status = 'active'),
    'sync', case when sr.id is not null then jsonb_build_object('kind', sr.kind, 'stage', sr.stage, 'deadline', sr.deadline,
      'title', (select title from mission_templates where id = sr.template_id),
      'solved', (select count(*) from mission_instances where sync_round_id = sr.id and status = 'solved'),
      'total', (select count(*) from mission_instances where sync_round_id = sr.id)) end,
    'story', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'title', title, 'body', body, 'at', at) order by at desc), '[]'::jsonb)
      from (select * from story_events where arena_id = a.id order by at desc limit 3) s),
    'feed', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'type', type, 'payload', payload, 'at', at) order by id desc), '[]'::jsonb)
      from (select * from game_feed where arena_id = a.id order by id desc limit 30) f),
    'recap', v_recap,
    'results', case when a.winner_revealed then a.results end,
    'grand', case when e.grand_revealed then _event_standings(e.id) end
  );
end $$;

-- ── Permissions: only the API is callable from the browser ───────────────────
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
        'host_export', 'spectator_state']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
