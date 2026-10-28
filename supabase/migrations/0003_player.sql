-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — player & captain API (called from the browser via RPC)
-- Error messages are short codes; the client maps them to friendly text.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function _auth_player(p_token text) returns players
language plpgsql as $$
declare p players;
begin
  select * into p from players where session_hash = _hash(p_token) and active;
  if p.id is null then raise exception 'AUTH'; end if;
  if p.last_seen_at < now() - interval '8 seconds' then
    update players set last_seen_at = now() where id = p.id;
  end if;
  return p;
end $$;

create or replace function _auth_captain(p_token text) returns players
language plpgsql as $$
declare p players; a arenas;
begin
  p := _auth_player(p_token);
  if p.role is distinct from 'captain' then raise exception 'NOT_CAPTAIN'; end if;
  select ar.* into a from arenas ar join teams t on t.arena_id = ar.id where t.id = p.team_id;
  if a.phase not in ('play', 'finale') then raise exception 'NOT_IN_PLAY'; end if;
  if a.paused then raise exception 'PAUSED'; end if;
  perform _tick(a.id);
  return p;
end $$;

-- Static map + item catalogue (public, no secrets)
create or replace function map_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'locations', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'building', building, 'floor', floor,
       'x', x, 'y', y, 'kind', kind, 'collapse', collapse_stage, 'risk', risk, 'reward', reward, 'tags', tags,
       'drop', drop_zone, 'enabled', enabled) order by id) from locations),
    'edges', (select jsonb_agg(jsonb_build_array(a, b, seconds)) from edges),
    'items', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'description', description,
       'price', price, 'params', params) order by price) from items)
  )
$$;

-- ── Join (registration + team verification in one step) ──────────────────────
create or replace function join_team(
  p_event_code text, p_team_number int, p_pin text, p_name text,
  p_consent boolean, p_rules boolean, p_existing_token text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare e events; t teams; p players; v_token text; v_count int; v_fails int;
begin
  select * into e from events where code = upper(trim(p_event_code));
  if e.id is null then raise exception 'NO_EVENT'; end if;

  -- Rejoin from the same device/session never consumes a new slot
  if p_existing_token is not null and length(p_existing_token) > 0 then
    select pl.* into p from players pl join teams tm on tm.id = pl.team_id
    where pl.session_hash = _hash(p_existing_token) and pl.active and tm.event_id = e.id;
    if p.id is not null then
      select * into t from teams where id = p.team_id;
      return jsonb_build_object('token', p_existing_token, 'team', t.number, 'rejoined', true);
    end if;
  end if;

  if not coalesce(p_consent, false) or not coalesce(p_rules, false) then raise exception 'CONSENT_REQUIRED'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 40 then raise exception 'BAD_NAME'; end if;

  select count(*) into v_fails from pin_failures
  where event_id = e.id and team_number = p_team_number and at > now() - interval '5 minutes';
  if v_fails >= 8 then raise exception 'LOCKED_OUT'; end if;

  select * into t from teams where event_id = e.id and number = p_team_number for update;
  if t.id is null or t.pin_hash <> _hash(t.pin_salt || coalesce(p_pin, '')) then
    -- return (not raise) so the failure record is committed and lockout works
    insert into pin_failures(event_id, team_number) values (e.id, p_team_number);
    return jsonb_build_object('error', 'BAD_PIN');
  end if;
  if t.roster_locked then raise exception 'ROSTER_LOCKED'; end if;

  select count(*) into v_count from players where team_id = t.id and active;
  if v_count >= 4 then raise exception 'TEAM_FULL'; end if;
  if exists (select 1 from players where team_id = t.id and active and lower(display_name) = lower(trim(p_name))) then
    raise exception 'NAME_TAKEN';
  end if;

  v_token := _new_token();
  insert into players(team_id, display_name, session_hash, consent)
  values (t.id, trim(p_name), _hash(v_token), true) returning * into p;

  if v_count + 1 = 4 then
    update teams set ready = true, roster_locked = true where id = t.id;
    perform _feed(t.arena_id, 'team.ready', jsonb_build_object('team', t.number));
  else
    perform _feed(t.arena_id, 'player.joined', jsonb_build_object('team', t.number, 'count', v_count + 1));
  end if;
  perform _ping_team(t.id, 'roster');
  perform _ping_arena(t.arena_id, 'roster');
  return jsonb_build_object('token', v_token, 'team', t.number, 'rejoined', false);
end $$;

-- ── Role claim at Gate 1 (race-safe via unique index) ─────────────────────────
create or replace function claim_role(p_token text, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; a arenas;
begin
  p := _auth_player(p_token);
  if p_role not in ('captain', 'scout', 'decoder', 'intel') then raise exception 'BAD_ROLE'; end if;
  select ar.* into a from arenas ar join teams t on t.arena_id = ar.id where t.id = p.team_id;
  perform _tick(a.id);
  select * into a from arenas where id = a.id;
  if a.phase <> 'roles' or now() >= a.roles_deadline then raise exception 'ROLES_CLOSED'; end if;
  if p.role is not null then raise exception 'ALREADY_HAS_ROLE'; end if;
  begin
    update players set role = p_role where id = p.id and role is null;
  exception when unique_violation then
    raise exception 'ROLE_TAKEN';
  end;
  perform _ping_team(p.team_id, 'roles');
  return jsonb_build_object('role', p_role);
end $$;

-- ── Full player state, filtered for this player's role ───────────────────────
create or replace function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; e events; mi mission_instances; mt mission_templates; v_mission jsonb;
  v_battle jsonb; bi mission_instances; b battles; v_clue jsonb; v_result jsonb; v_comms jsonb; v_out jsonb;
  v_scan boolean; v_hidden boolean; v_board jsonb; v_role_names jsonb; v_parts jsonb;
begin
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  perform _tick(t.arena_id);
  select * into p from players where id = p.id;
  select * into t from teams where id = p.team_id;
  select * into a from arenas where id = t.arena_id;
  select * into e from events where id = t.event_id;
  v_scan := t.scan_until is not null and t.scan_until > now();

  -- active main activity
  select * into mi from mission_instances where team_id = t.id and status = 'active' and kind <> 'battle'
  order by created_at desc limit 1;
  if mi.id is not null then
    select * into mt from mission_templates where id = mi.template_id;
    v_mission := jsonb_build_object(
      'id', mi.id, 'kind', mi.kind, 'title', mt.title, 'objective', mt.objective, 'category', mt.category,
      'difficulty', mt.difficulty, 'deadline', mi.deadline, 'started_at', mi.started_at,
      'attempts_left', mi.attempts_left, 'sync', mi.sync_round_id is not null, 'location', mi.location_id);
    if mt.relay then
      v_mission := v_mission || jsonb_build_object('relay', jsonb_build_object(
        'partner', (select number from teams where id = mi.partner_team_id),
        'fallback_at', mi.fallback_at));
    end if;
    if p.role = 'captain' then
      select jsonb_agg(x -> 'label') into v_parts from jsonb_array_elements(mt.parts) x;
      v_mission := v_mission || jsonb_build_object('parts', v_parts, 'hint_cost', _cfg(e.id, 'hint_cost'),
        'hint', case when mi.hint_used then mt.hint end);
    elsif p.role is not null then
      v_clue := mt.clues -> p.role;
      if (v_clue ? 'reveal_seconds') and now() > mi.started_at + _secs((v_clue ->> 'reveal_seconds')::int) then
        v_clue := v_clue || jsonb_build_object('body', '▒▒▒ SIGNAL LOST ▒▒▒\nThe flash has ended. Tell your captain what you remember.', 'expired', true);
      end if;
      v_mission := v_mission || jsonb_build_object('clue', v_clue);
      if p.role = 'intel' and mt.relay and mi.fallback_at is not null and now() >= mi.fallback_at then
        v_mission := v_mission || jsonb_build_object('relay_backup', mi.relay_key);
      end if;
    end if;
  end if;

  -- active battle
  select * into bi from mission_instances where team_id = t.id and status = 'active' and kind = 'battle' limit 1;
  if bi.id is not null then
    select * into mt from mission_templates where id = bi.template_id;
    select * into b from battles where id = bi.battle_id;
    v_battle := jsonb_build_object('id', bi.id, 'battle_id', b.id, 'title', mt.title, 'objective', mt.objective,
      'deadline', bi.deadline, 'started_at', bi.started_at, 'attempts_left', bi.attempts_left, 'weapon', b.weapon, 'damage', b.damage,
      'attacker', (select number from teams where id = b.attacker_id),
      'defender', (select number from teams where id = b.defender_id),
      'we_attacked', b.attacker_id = t.id);
    if p.role = 'captain' then
      select jsonb_agg(x -> 'label') into v_parts from jsonb_array_elements(mt.parts) x;
      v_battle := v_battle || jsonb_build_object('parts', v_parts);
    elsif p.role is not null then
      v_battle := v_battle || jsonb_build_object('clue', mt.clues -> p.role);
    end if;
  end if;

  -- last finished activity (for the result flash) — never includes answers
  select jsonb_build_object('id', x.id, 'status', x.status, 'kind', x.kind, 'points', x.points_awarded,
    'title', (select title from mission_templates where id = x.template_id), 'at', coalesce(x.solved_at, x.deadline))
  into v_result from mission_instances x
  where x.team_id = t.id and x.status <> 'active' and coalesce(x.solved_at, least(x.deadline, now())) > now() - interval '20 seconds'
  order by coalesce(x.solved_at, x.deadline) desc limit 1;

  -- captain-only comms & codewords this squad holds for others
  if p.role = 'captain' then
    select jsonb_build_object(
      'messages', coalesce((select jsonb_agg(m order by m.at) from (
          select cm.id, cm.body, cm.at, (select number from teams where id = cm.from_team) as from_number,
                 (select number from teams where id = cm.to_team) as to_number, cm.from_team = t.id as mine
          from chat_messages cm where cm.arena_id = t.arena_id and not cm.hidden
            and (cm.from_team = t.id or (cm.to_team = t.id and not exists
                 (select 1 from chat_blocks cb where cb.team_id = t.id and cb.blocked_team = cm.from_team)))
          order by cm.at desc limit 80) m), '[]'::jsonb),
      'blocked', coalesce((select jsonb_agg((select number from teams where id = blocked_team)) from chat_blocks where team_id = t.id), '[]'::jsonb)
    ) into v_comms;
    select coalesce(jsonb_agg(jsonb_build_object('for_team', (select number from teams where id = x.team_id),
      'key', x.relay_key, 'deadline', x.deadline)), '[]'::jsonb)
    into v_out from mission_instances x
    where x.partner_team_id = t.id and x.status = 'active' and x.relay_key is not null;
  end if;

  if a.phase in ('lobby', 'boarding', 'shuttle', 'roles', 'play') then
    select coalesce(jsonb_agg(jsonb_build_object('number', number, 'name', name, 'points', points) order by points desc, number), '[]'::jsonb)
    into v_board from teams where arena_id = a.id and ready;
  end if;

  select jsonb_object_agg(r, (select display_name from players where team_id = t.id and active and role = r))
  into v_role_names from unnest(array['captain', 'scout', 'decoder', 'intel']) r;

  return jsonb_build_object(
    'server_now', now(),
    'event', jsonb_build_object('name', e.name, 'code', e.code),
    'me', jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role),
    'team', jsonb_build_object('id', t.id, 'number', t.number, 'name', t.name, 'hp', t.hp, 'shield', t.shield,
      'coins', t.coins, 'points', t.points, 'trust', t.trust, 'location', t.location_id, 'state', t.state,
      'travel_to', t.travel_to, 'travel_from', t.travel_from, 'travel_started_at', t.travel_started_at,
      'travel_arrive_at', t.travel_arrive_at, 'recovery_deadline', t.recovery_deadline,
      'attack_cooldown_until', t.attack_cooldown_until, 'protected_until', t.protected_until,
      'jammed_until', t.jammed_until, 'scan_until', t.scan_until, 'beacon', t.beacon, 'ready', t.ready,
      'bus', t.bus, 'dropped', t.dropped, 'visit_missions', t.visit_missions,
      'visit_limit', _cfg(e.id, 'visit_missions')),
    'roster', (select coalesce(jsonb_agg(jsonb_build_object('name', display_name, 'role', role,
        'online', last_seen_at > now() - interval '25 seconds', 'me', id = p.id) order by joined_at), '[]'::jsonb)
      from players where team_id = t.id and active),
    'roles', v_role_names,
    'arena', jsonb_build_object('id', a.id, 'number', a.number, 'name', a.name, 'phase', a.phase, 'paused', a.paused,
      'shuttle_departed_at', a.shuttle_departed_at, 'shuttle_arrive_at', a.shuttle_arrive_at,
      'roles_deadline', a.roles_deadline, 'zone_stage', a.zone_stage, 'zone_next_at', a.zone_next_at,
      'finale_stage', a.finale_stage, 'overlay', a.overlay, 'threat', a.threat,
      'results_locked', a.results_locked, 'winner_revealed', a.winner_revealed),
    'mission', v_mission,
    'battle', v_battle,
    'last_result', v_result,
    'squads', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'number', x.number, 'name', x.name, 'hp', x.hp, 'state', x.state,
        'location', case when x.id = t.id or v_scan or x.location_id = t.location_id
                           or x.jammed_until is null or x.jammed_until < now()
                           or exists (select 1 from alliances al where al.status = 'active'
                                      and ((al.team_a = t.id and al.team_b = x.id) or (al.team_b = t.id and al.team_a = x.id)))
                         then x.location_id end,
        'traveling', x.state = 'traveling',
        'protected', x.protected_until > now(),
        'in_battle', exists (select 1 from battles bb where bb.status = 'active' and (bb.attacker_id = x.id or bb.defender_id = x.id)),
        'allied', exists (select 1 from alliances al where al.status = 'active'
                          and ((al.team_a = t.id and al.team_b = x.id) or (al.team_b = t.id and al.team_a = x.id)))
      ) order by x.number), '[]'::jsonb) from teams x where x.arena_id = t.arena_id and x.ready),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'location', location_id, 'tier', tier,
        'expires_at', expires_at)), '[]'::jsonb) from airdrops where arena_id = a.id and status = 'open'),
    'inventory', (select coalesce(jsonb_object_agg(item_id, qty), '{}'::jsonb) from inventory where team_id = t.id and qty > 0),
    'comms', v_comms,
    'codewords', v_out,
    'alliances', (select coalesce(jsonb_agg(jsonb_build_object('id', al.id, 'status', al.status, 'expires_at', al.expires_at,
        'other', (select number from teams where id = case when al.team_a = t.id then al.team_b else al.team_a end),
        'incoming', al.proposed_by <> t.id) order by al.created_at desc), '[]'::jsonb)
      from alliances al where (al.team_a = t.id or al.team_b = t.id) and al.status in ('proposed', 'active')),
    'bargains', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'body', s.body,
        'offer', s.offer, 'expires_at', s.expires_at)), '[]'::jsonb)
      from story_events s where s.arena_id = a.id and s.kind = 'bargain' and coalesce(s.expires_at, now() + interval '1 second') > now()
        and not (t.bargains @> jsonb_build_array(jsonb_build_object('id', s.id::text)))),
    'story', (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'body', body, 'at', at) order by at desc), '[]'::jsonb)
      from (select * from story_events where arena_id = a.id and kind in ('transmission', 'reveal') order by at desc limit 3) s),
    'feed', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'payload', payload, 'at', at) order by id desc), '[]'::jsonb)
      from (select * from game_feed where arena_id = a.id order by id desc limit 12) f),
    'leaderboard', v_board,
    'results', case when a.winner_revealed then a.results end
  );
end $$;

-- ── Captain actions ──────────────────────────────────────────────────────────
create or replace function captain_move(p_token text, p_location text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; l locations; v_secs int;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state <> 'idle' then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  select * into l from locations where id = p_location;
  if l.id is null or l.kind = 'start' or not l.enabled then raise exception 'BAD_LOCATION'; end if;
  if l.id = t.location_id then raise exception 'ALREADY_HERE'; end if;
  if l.collapse_stage <= a.zone_stage then raise exception 'DANGER_ZONE'; end if;
  if not t.dropped and t.location_id = 'gate_1' and l.drop_zone then
    v_secs := _cfg(t.event_id, 'drop_seconds');
  else
    v_secs := _is_neighbor(t.location_id, l.id);
    if v_secs is null then raise exception 'NOT_CONNECTED'; end if;
  end if;
  -- leaving forfeits the current mission without a penalty
  update mission_instances set status = 'cancelled' where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop');
  update teams set state = 'traveling', travel_from = location_id, travel_to = l.id, travel_started_at = now(),
    travel_arrive_at = now() + _secs(v_secs) where id = t.id;
  if t.jammed_until is null or t.jammed_until < now() then
    perform _feed(t.arena_id, 'squad.movement.started', jsonb_build_object('team', t.number, 'from', t.location_id, 'to', l.id));
  end if;
  perform _ping_team(t.id, 'move');
  perform _ping_arena(t.arena_id, 'move');
  return jsonb_build_object('arrive_at', now() + _secs(v_secs), 'seconds', v_secs);
end $$;

create or replace function captain_explore(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; v_id uuid;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  if (select phase from arenas where id = t.arena_id) <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state <> 'idle' then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind <> 'battle') then raise exception 'MISSION_ACTIVE'; end if;
  if t.visit_missions >= _cfg(t.event_id, 'visit_missions') then raise exception 'AREA_EXHAUSTED'; end if;
  v_id := _start_location_mission(t.id);
  if v_id is null then raise exception 'NO_MISSIONS'; end if;
  return jsonb_build_object('instance', v_id);
end $$;

create or replace function captain_submit(p_token text, p_instance uuid, p_answers jsonb, p_idem text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; mi mission_instances; mt mission_templates; s submissions; v_ok boolean := true;
  v_part jsonb; v_given text; v_i int := 0; v_n int; v_pts int := 0; v_raw text;
begin
  p := _auth_captain(p_token);
  if p_idem is null or length(p_idem) < 8 then raise exception 'BAD_REQUEST'; end if;
  select * into s from submissions where idem_key = p_idem;
  if s.id is not null then
    select * into mi from mission_instances where id = s.instance_id;
    return jsonb_build_object('correct', s.correct, 'status', mi.status, 'attempts_left', mi.attempts_left,
      'points', mi.points_awarded, 'replayed', true);
  end if;
  select * into mi from mission_instances where id = p_instance for update;
  if mi.id is null or mi.team_id <> p.team_id then raise exception 'NOT_FOUND'; end if;
  if mi.status <> 'active' then raise exception 'NOT_ACTIVE'; end if;
  if mi.deadline <= now() then perform _fail(mi.id, 'expired'); raise exception 'EXPIRED'; end if;
  select * into mt from mission_templates where id = mi.template_id;
  v_n := jsonb_array_length(mt.parts);
  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> v_n then raise exception 'BAD_ANSWER_FORMAT'; end if;
  for v_part in select value from jsonb_array_elements(mt.parts) loop
    v_given := _norm(p_answers ->> v_i);
    if not exists (select 1 from jsonb_array_elements_text(v_part -> 'accept') acc
                   where (acc = '{KEY}' and v_given = _norm(mi.relay_key)) or (acc <> '{KEY}' and acc = v_given)) then
      v_ok := false;
    end if;
    v_i := v_i + 1;
  end loop;
  select string_agg(value, ' | ') into v_raw from jsonb_array_elements_text(p_answers);
  insert into submissions(instance_id, team_id, player_id, answer, correct, idem_key)
  values (mi.id, mi.team_id, p.id, left(coalesce(v_raw, ''), 300), v_ok, p_idem);
  if v_ok then
    v_pts := _complete(mi.id);
  else
    update mission_instances set attempts_left = attempts_left - 1 where id = mi.id returning * into mi;
    if mi.attempts_left <= 0 then perform _fail(mi.id, 'failed'); end if;
    perform _ping_team(mi.team_id, 'attempt');
  end if;
  select * into mi from mission_instances where id = mi.id;
  return jsonb_build_object('correct', v_ok, 'status', mi.status, 'attempts_left', mi.attempts_left, 'points', mi.points_awarded);
end $$;

create or replace function captain_hint(p_token text, p_instance uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; mi mission_instances; t teams; v_cost int;
begin
  p := _auth_captain(p_token);
  select * into mi from mission_instances where id = p_instance for update;
  if mi.id is null or mi.team_id <> p.team_id or mi.status <> 'active' then raise exception 'NOT_FOUND'; end if;
  if mi.kind = 'battle' then raise exception 'NO_HINTS_IN_BATTLE'; end if;
  if mi.hint_used then return jsonb_build_object('hint', (select hint from mission_templates where id = mi.template_id)); end if;
  select * into t from teams where id = p.team_id;
  v_cost := _cfg(t.event_id, 'hint_cost');
  if t.coins < v_cost then raise exception 'NOT_ENOUGH_COINS'; end if;
  perform _apply(t.id, 'hint', 0, -v_cost, 0, 0, mi.id::text, 'Bought a hint');
  update mission_instances set hint_used = true where id = mi.id;
  perform _ping_team(t.id, 'hint');
  return jsonb_build_object('hint', (select hint from mission_templates where id = mi.template_id));
end $$;

create or replace function captain_use_item(p_token text, p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; it items; v_qty int; v_dest text;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  select * into it from items where id = p_item;
  if it.id is null then raise exception 'BAD_ITEM'; end if;
  if it.kind = 'weapon' then raise exception 'USE_ATTACK'; end if;
  select qty into v_qty from inventory where team_id = t.id and item_id = p_item;
  if coalesce(v_qty, 0) < 1 then raise exception 'NO_ITEM'; end if;
  if t.state = 'recovery' and p_item <> 'medkit' then raise exception 'IN_RECOVERY'; end if;
  case p_item
    when 'medkit' then
      if t.state = 'recovery' then raise exception 'IN_RECOVERY'; end if;
      if t.hp >= _cfg(t.event_id, 'hp_max') then raise exception 'HP_FULL'; end if;
      perform _apply(t.id, 'medkit', 0, 0, (it.params ->> 'heal')::int, 0, null, 'Used a med kit');
    when 'shield' then
      update teams set shield = least(_cfg(t.event_id, 'shield_max'), shield + (it.params ->> 'shield')::int) where id = t.id;
    when 'scanner' then
      update teams set scan_until = now() + _secs((it.params ->> 'seconds')::int) where id = t.id;
    when 'jammer' then
      update teams set jammed_until = now() + _secs((it.params ->> 'seconds')::int) where id = t.id;
    when 'beacon' then
      if t.beacon then raise exception 'ALREADY_ACTIVE'; end if;
      update teams set beacon = true where id = t.id;
    when 'extract' then
      if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
      if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
      v_dest := _nearest_safe(coalesce(t.travel_to, t.location_id), least(5, a.zone_stage + 1));
      update mission_instances set status = 'cancelled' where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop');
      update teams set state = 'idle', location_id = v_dest, travel_to = null, travel_from = null, travel_arrive_at = null,
        dropped = true, visit_missions = 0 where id = t.id;
    else raise exception 'BAD_ITEM';
  end case;
  perform _add_item(t.id, p_item, -1);
  insert into ledger(arena_id, team_id, kind, ref, reason, actor) values (t.arena_id, t.id, 'item_used', null, p_item, 'captain');
  perform _ping_team(t.id, 'item');
  return jsonb_build_object('used', p_item, 'location', v_dest);
end $$;

create or replace function captain_buy(p_token text, p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; l locations; it items;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into l from locations where id = t.location_id;
  if t.state <> 'idle' or not (l.tags && array['market', 'social']) then raise exception 'NO_MARKET_HERE'; end if;
  select * into it from items where id = p_item;
  if it.id is null or it.price <= 0 then raise exception 'BAD_ITEM'; end if;
  if 'social' = any(l.tags) and not ('market' = any(l.tags)) and it.kind not in ('intel', 'stealth', 'airdrop') then raise exception 'NOT_SOLD_HERE'; end if;
  if t.coins < it.price then raise exception 'NOT_ENOUGH_COINS'; end if;
  perform _apply(t.id, 'purchase', 0, -it.price, 0, 0, null, 'Bought ' || it.name);
  perform _add_item(t.id, p_item, 1);
  perform _ping_team(t.id, 'item');
  return jsonb_build_object('bought', p_item);
end $$;

create or replace function captain_attack(p_token text, p_target uuid, p_weapon text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; d teams; a arenas; it items; v_tpl text; v_bid uuid; v_secs int; v_qty int; v_al alliances;
begin
  p := _auth_captain(p_token);
  -- lock both squads in a stable order to avoid deadlocks
  perform 1 from teams where id in (p.team_id, p_target) order by id for update;
  select * into t from teams where id = p.team_id;
  select * into d from teams where id = p_target;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_BATTLES_NOW'; end if;
  if d.id is null or d.arena_id <> t.arena_id or d.id = t.id or not d.ready then raise exception 'BAD_TARGET'; end if;
  if t.state <> 'idle' or d.state <> 'idle' then raise exception 'TARGET_UNAVAILABLE'; end if;
  if t.location_id is distinct from d.location_id then raise exception 'NOT_IN_RANGE'; end if;
  if t.attack_cooldown_until > now() then raise exception 'COOLDOWN'; end if;
  if d.protected_until > now() then raise exception 'TARGET_PROTECTED'; end if;
  if exists (select 1 from battles where status = 'active' and (attacker_id in (t.id, d.id) or defender_id in (t.id, d.id))) then
    raise exception 'ALREADY_IN_BATTLE';
  end if;
  if exists (select 1 from mission_instances where team_id in (t.id, d.id) and status = 'active' and sync_round_id is not null) then
    raise exception 'TARGET_UNAVAILABLE';
  end if;
  select * into it from items where id = p_weapon and kind = 'weapon';
  if it.id is null then raise exception 'BAD_WEAPON'; end if;
  select qty into v_qty from inventory where team_id = t.id and item_id = p_weapon;
  if coalesce(v_qty, 0) < 1 then raise exception 'NO_ITEM'; end if;
  if (it.params ->> 'consumable')::boolean then perform _add_item(t.id, p_weapon, -1); end if;

  -- attacking an ally is a betrayal: alliance breaks, trust falls, threat rises
  select * into v_al from alliances where status = 'active'
    and ((team_a = t.id and team_b = d.id) or (team_a = d.id and team_b = t.id)) for update;
  if v_al.id is not null then
    update alliances set status = 'betrayed' where id = v_al.id;
    perform _apply(t.id, 'betrayal', 0, 0, 0, -20, v_al.id::text, 'Betrayed an ally');
    update arenas set threat = threat + 1 where id = a.id;
    perform _feed(a.id, 'alliance.betrayed', jsonb_build_object('by', t.number, 'victim', d.number));
  end if;

  v_tpl := _pick_template(t.id, 'battle', array[it.params ->> 'tag']);
  if v_tpl is null then raise exception 'NO_TEMPLATE'; end if;
  v_secs := (it.params ->> 'seconds')::int;
  insert into battles(arena_id, attacker_id, defender_id, weapon, template_id, location_id, damage, deadline)
  values (a.id, t.id, d.id, p_weapon, v_tpl, t.location_id, (it.params ->> 'damage')::int, now() + _secs(v_secs))
  returning id into v_bid;
  perform _start_instance(t.id, v_tpl, t.location_id, v_bid, null, null, now() + _secs(v_secs));
  perform _start_instance(d.id, v_tpl, t.location_id, v_bid, null, null, now() + _secs(v_secs));
  -- the battle pauses the clock on any mission the squads were working on
  update mission_instances set deadline = deadline + _secs(v_secs)
  where team_id in (t.id, d.id) and status = 'active' and kind <> 'battle';
  perform _feed(a.id, 'battle.started', jsonb_build_object('attacker', t.number, 'defender', d.number, 'weapon', p_weapon, 'location', t.location_id));
  perform _ping_team(d.id, 'battle');
  perform _ping_arena(a.id, 'battle');
  return jsonb_build_object('battle', v_bid);
end $$;

create or replace function captain_claim_airdrop(p_token text, p_airdrop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; ad airdrops; v_id uuid;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into ad from airdrops where id = p_airdrop;
  if ad.id is null or ad.arena_id <> t.arena_id or ad.status <> 'open' then raise exception 'AIRDROP_GONE'; end if;
  if t.location_id is distinct from ad.location_id or t.state <> 'idle' then raise exception 'NOT_IN_RANGE'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind <> 'battle') then raise exception 'MISSION_ACTIVE'; end if;
  v_id := _start_instance(t.id, ad.template_id, ad.location_id, null, ad.id, null, least(ad.expires_at, now() + interval '150 seconds'));
  perform _feed(t.arena_id, 'airdrop.contested', jsonb_build_object('team', t.number, 'location', ad.location_id));
  perform _ping_arena(t.arena_id, 'airdrop');
  return jsonb_build_object('instance', v_id);
end $$;

create or replace function captain_chat(p_token text, p_to_team int, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; d teams; v_recent int;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id;
  select * into d from teams where arena_id = t.arena_id and number = p_to_team and ready;
  if d.id is null or d.id = t.id then raise exception 'BAD_TARGET'; end if;
  if p_body is null or char_length(trim(p_body)) = 0 or char_length(p_body) > 280 then raise exception 'BAD_MESSAGE'; end if;
  if exists (select 1 from chat_blocks where team_id = d.id and blocked_team = t.id) then raise exception 'BLOCKED'; end if;
  select count(*) into v_recent from chat_messages where from_team = t.id and at > now() - interval '30 seconds';
  if v_recent >= _cfg(t.event_id, 'chat_limit') then raise exception 'SLOW_DOWN'; end if;
  insert into chat_messages(arena_id, from_team, to_team, body) values (t.arena_id, t.id, d.id, trim(p_body));
  perform _ping_team(d.id, 'chat');
  perform _ping_team(t.id, 'chat');
  return jsonb_build_object('sent', true);
end $$;

create or replace function captain_block(p_token text, p_team int, p_block boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; d teams;
begin
  p := _auth_player(p_token);
  if p.role <> 'captain' then raise exception 'NOT_CAPTAIN'; end if;
  select * into t from teams where id = p.team_id;
  select * into d from teams where arena_id = t.arena_id and number = p_team;
  if d.id is null then raise exception 'BAD_TARGET'; end if;
  if p_block then
    insert into chat_blocks values (t.id, d.id) on conflict do nothing;
  else
    delete from chat_blocks where team_id = t.id and blocked_team = d.id;
  end if;
  perform _ping_team(t.id, 'chat');
  return jsonb_build_object('blocked', p_block);
end $$;

create or replace function captain_report(p_token text, p_message bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players;
begin
  p := _auth_player(p_token);
  if p.role <> 'captain' then raise exception 'NOT_CAPTAIN'; end if;
  update chat_messages set reported = true where id = p_message and to_team = p.team_id;
  return jsonb_build_object('reported', found);
end $$;

create or replace function captain_alliance(p_token text, p_action text, p_team int default null, p_alliance uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; d teams; al alliances; v_cost int;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id;
  v_cost := _cfg(t.event_id, 'alliance_cost');
  if p_action = 'propose' then
    select * into d from teams where arena_id = t.arena_id and number = p_team and ready;
    if d.id is null or d.id = t.id then raise exception 'BAD_TARGET'; end if;
    if t.trust < 0 then raise exception 'TRUST_TOO_LOW'; end if;
    if exists (select 1 from alliances where status in ('proposed', 'active')
               and ((team_a = t.id and team_b = d.id) or (team_a = d.id and team_b = t.id))) then raise exception 'ALREADY_PENDING'; end if;
    insert into alliances(arena_id, team_a, team_b, proposed_by, expires_at)
    values (t.arena_id, t.id, d.id, t.id, now() + make_interval(mins => _cfg(t.event_id, 'alliance_minutes')));
    perform _ping_team(d.id, 'alliance');
  elsif p_action in ('accept', 'decline') then
    select * into al from alliances where id = p_alliance and status = 'proposed' and team_b = t.id for update;
    if al.id is null then raise exception 'NOT_FOUND'; end if;
    if p_action = 'decline' then
      update alliances set status = 'declined' where id = al.id;
    else
      if t.coins < v_cost or (select coins from teams where id = al.team_a) < v_cost then raise exception 'NOT_ENOUGH_COINS'; end if;
      update alliances set status = 'active', expires_at = now() + make_interval(mins => _cfg(t.event_id, 'alliance_minutes')) where id = al.id;
      perform _apply(al.team_a, 'alliance', 0, -v_cost, 0, 10, al.id::text, 'Alliance formed');
      perform _apply(al.team_b, 'alliance', 0, -v_cost, 0, 10, al.id::text, 'Alliance formed');
      perform _feed(t.arena_id, 'alliance.created', jsonb_build_object('a', (select number from teams where id = al.team_a), 'b', t.number));
    end if;
    perform _ping_team(al.team_a, 'alliance');
  elsif p_action = 'end' then
    select * into al from alliances where id = p_alliance and status = 'active' and (team_a = t.id or team_b = t.id) for update;
    if al.id is null then raise exception 'NOT_FOUND'; end if;
    update alliances set status = 'ended' where id = al.id;
    perform _ping_team(case when al.team_a = t.id then al.team_b else al.team_a end, 'alliance');
  else
    raise exception 'BAD_REQUEST';
  end if;
  perform _ping_team(t.id, 'alliance');
  return jsonb_build_object('ok', true);
end $$;

create or replace function captain_bargain(p_token text, p_story uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; s story_events;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into s from story_events where id = p_story and arena_id = t.arena_id and kind = 'bargain';
  if s.id is null or (s.expires_at is not null and s.expires_at <= now()) then raise exception 'NOT_FOUND'; end if;
  if t.bargains @> jsonb_build_array(jsonb_build_object('id', s.id::text)) then raise exception 'ALREADY_ANSWERED'; end if;
  update teams set bargains = bargains || jsonb_build_array(jsonb_build_object('id', s.id::text, 'accept', p_accept)) where id = t.id;
  if p_accept then
    perform _apply(t.id, 'bargain', 0, coalesce((s.offer ->> 'coins')::int, 0), 0, coalesce((s.offer ->> 'trust')::int, 0), s.id::text, 'Accepted a Squad 00 bargain');
    update arenas set threat = threat + coalesce((s.offer ->> 'threat')::int, 1) where id = t.arena_id;
    perform _ping_arena(t.arena_id, 'threat');
  end if;
  perform _ping_team(t.id, 'bargain');
  return jsonb_build_object('accepted', p_accept);
end $$;
