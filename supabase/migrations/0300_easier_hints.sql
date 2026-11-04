-- ════════════════════════════════════════════════════════════════════════════
-- 0300 — Easier help: free hints, and "reveal answer" with a points penalty
--   • The hint (a nudge) is now free and no longer cuts the reward.
--   • captain_reveal(token, instance, part): shows the captain the answer for one box
--     and immediately deducts points: reveal_pct % of the mission's points, split
--     across its boxes (default 50 %, so revealing every box still leaves half).
--   • Allowed in missions, relays (not the partner's codeword) and recovery;
--     never in duels, airdrop races or finale rounds.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table mission_instances add column if not exists revealed jsonb not null default '{}'::jsonb;

create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 10, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 0,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0,
  'auto_pacing', 0, 'phase_schedule', '2,12,30,50', 'duel_phase', 2, 'mission_time_pct', 100, 'pin_length', 6,
  -- 0200: open world (distances in thousandths of the campus width)
  'move_speed', 25,          -- run speed: 0.025 campus/s → ~40 s to cross the campus
  'loc_radius', 35,          -- a location's area
  'engage_range', 60,        -- squads this close can duel
  'zone_tick_seconds', 6,    -- outside the safe zone: damage every N seconds
  'zone_tick_damage', 4,     -- … of this much HP (shield absorbs first)
  'red_interval', 0,         -- automatic red zone every N minutes from phase 2 (0 = host only)
  'red_warning', 20,         -- seconds between the red zone warning and the strike
  'red_damage', 30,          -- HP lost by squads inside the red zone when it lands
  'red_radius', 80           -- red zone size
) || jsonb_build_object(   -- (Postgres allows at most 100 arguments per call)
  'reveal_pct', 50           -- revealing every answer box costs this % of the mission's points
) $$;

-- ── Geometry helpers ─────────────────────────────────────────────────────────
create or replace function _loc_xy(p_loc text) returns float8[] language sql stable as $$
  select array[x::float8, y::float8] from locations where id = p_loc
$$;

-- Current position, interpolating an auto-run by server time.
create or replace function _team_xy(t teams) returns float8[] language plpgsql stable as $$
declare d float8[]; p float8;
begin
  if t.state = 'traveling' and t.travel_to is not null and t.travel_arrive_at is not null then
    d := _loc_xy(t.travel_to);
    if t.travel_fx is not null and d is not null then
      p := least(1, greatest(0, extract(epoch from now() - t.travel_started_at)
             / greatest(0.001, extract(epoch from t.travel_arrive_at - t.travel_started_at))));
      return array[t.travel_fx + (d[1] - t.travel_fx) * p, t.travel_fy + (d[2] - t.travel_fy) * p];
    end if;
  end if;
  if t.pos_x is not null then return array[t.pos_x::float8, t.pos_y::float8]; end if;
  return coalesce(_loc_xy(t.location_id), array[0.5, 0.93]);
end $$;

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

-- Points one revealed box costs for this instance (0 = reveal not allowed here).
create or replace function _reveal_cost(mi mission_instances) returns int
language plpgsql stable as $$
declare mt mission_templates; v_ev uuid; v_base int; v_n int;
begin
  if mi.kind not in ('mission', 'relay', 'recovery') or mi.sync_round_id is not null or mi.airdrop_id is not null then return 0; end if;
  select * into mt from mission_templates where id = mi.template_id;
  select event_id into v_ev from teams where id = mi.team_id;
  v_base := coalesce(mt.points, case when mt.difficulty >= 2 then _cfg(v_ev, 'pts_hard') else _cfg(v_ev, 'pts_standard') end);
  select count(*) into v_n from jsonb_array_elements(mt.parts) x where not (x -> 'accept') ? '{KEY}';
  if v_n = 0 then return 0; end if;
  return greatest(5, ceil(v_base * _cfg(v_ev, 'reveal_pct') / 100.0 / v_n))::int;
end $$;

create or replace function captain_reveal(p_token text, p_instance uuid, p_part int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; mi mission_instances; mt mission_templates; v_part jsonb; v_cost int; v_ans text;
begin
  p := _auth_captain(p_token);
  select * into mi from mission_instances where id = p_instance for update;
  if mi.id is null or mi.team_id <> p.team_id or mi.status <> 'active' then raise exception 'NOT_FOUND'; end if;
  v_cost := _reveal_cost(mi);
  if v_cost = 0 then raise exception 'NO_REVEAL_HERE'; end if;
  select * into mt from mission_templates where id = mi.template_id;
  v_part := mt.parts -> p_part;
  if v_part is null or (v_part -> 'accept') ? '{KEY}' then raise exception 'NO_REVEAL_HERE'; end if;
  v_ans := v_part -> 'accept' ->> 0;
  if mi.revealed ? p_part::text then return jsonb_build_object('part', p_part, 'answer', v_ans, 'cost', 0); end if;
  perform _apply(mi.team_id, 'reveal', -v_cost, 0, 0, 0, mi.id::text || ':' || p_part, 'Revealed an answer');
  update mission_instances set revealed = revealed || jsonb_build_object(p_part::text, v_ans) where id = mi.id;
  perform _ping_team(mi.team_id, 'hint');
  return jsonb_build_object('part', p_part, 'answer', v_ans, 'cost', v_cost);
end $$;

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
        'hint', case when mi.hint_used then mt.hint end, 'revealed', mi.revealed, 'reveal_cost', _reveal_cost(mi),
        'revealable', (select jsonb_agg(not (x -> 'accept') ? '{KEY}') from jsonb_array_elements(mt.parts) x));
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
      'visit_limit', _cfg(e.id, 'visit_missions'), 'pos', to_jsonb(_team_xy(t)), 'travel_from_xy', case when t.travel_fx is not null then jsonb_build_array(t.travel_fx, t.travel_fy) end),
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
        'pos', case when x.id = t.id or v_scan or x.location_id = t.location_id
                           or x.jammed_until is null or x.jammed_until < now()
                           or exists (select 1 from alliances al where al.status = 'active'
                                      and ((al.team_a = t.id and al.team_b = x.id) or (al.team_b = t.id and al.team_a = x.id)))
                         then to_jsonb(_team_xy(x)) end,
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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer', 'captain_reveal']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
