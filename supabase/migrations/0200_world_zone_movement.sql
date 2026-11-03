-- ════════════════════════════════════════════════════════════════════════════
-- 0200 — Open-world movement, circular safe zone, red zones (incremental)
--   • Squads have a real position (x, y on the 0..1 campus). The captain steers
--     with a joystick (captain_steer); the server caps speed, so travel time
--     depends on distance. Tapping a location auto-runs there in a straight line.
--   • Locations are areas (radius loc_radius): inside one you can search, buy, loot.
--   • Safe zone = a circle per stage, shrinking toward Training Room 14 (same
--     circles on every map of an event). Outside it you lose HP every few seconds.
--   • Red zones: a warned bombardment circle; squads inside when it lands take damage.
--   • Duels and airdrops need squads to be within range of each other / the crate.
--   • The host can start with any number (1–15) of complete squads.
--   • Trial mode removed.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table teams add column if not exists pos_x real;
alter table teams add column if not exists pos_y real;
alter table teams add column if not exists pos_at timestamptz;
alter table teams add column if not exists travel_fx real;
alter table teams add column if not exists travel_fy real;
alter table teams add column if not exists zone_hit_at timestamptz;
alter table teams add column if not exists last_steer_ping timestamptz;
alter table arenas add column if not exists red_x real;
alter table arenas add column if not exists red_y real;
alter table arenas add column if not exists red_r real;
alter table arenas add column if not exists red_at timestamptz;
alter table arenas add column if not exists last_red_at timestamptz;
alter table battles add column if not exists x real;
alter table battles add column if not exists y real;

-- ── Settings ──────────────────────────────────────────────────────────────────
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

-- Keep pos in step with location changes made by older code paths (arrival, finale, relocate…).
create or replace function _teams_pos_sync() returns trigger language plpgsql as $$
declare xy float8[];
begin
  if tg_op = 'INSERT' or (new.location_id is distinct from old.location_id
      and new.pos_x is not distinct from old.pos_x and new.pos_y is not distinct from old.pos_y) then
    if new.location_id is not null then
      xy := _loc_xy(new.location_id);
      if xy is not null then new.pos_x := xy[1]; new.pos_y := xy[2]; new.pos_at := now(); end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists teams_pos_sync on teams;
create trigger teams_pos_sync before insert or update on teams for each row execute function _teams_pos_sync();
update teams t set pos_x = l.x, pos_y = l.y, pos_at = now() from locations l where l.id = t.location_id and t.pos_x is null;

-- Safe-zone circle {cx, cy, r} for a stage. Deterministic per event, so every map of
-- an event gets the same circles; each circle lies inside the previous one and
-- always contains Training Room 14.
create or replace function _zone_circle(p_event uuid, p_stage int) returns float8[]
language plpgsql stable as $$
declare radii float8[] := array[0.9, 0.5, 0.36, 0.24, 0.14, 0.035]; tr float8[]; seed int;
  cx float8 := 0.5; cy float8 := 0.5; nx float8; ny float8; ang float8; mag float8; d float8; room float8; k int;
begin
  tr := coalesce(_loc_xy('tr14'), array[0.5, 0.65]);
  select mission_seed into seed from events where id = p_event;
  p_stage := greatest(0, least(5, coalesce(p_stage, 0)));
  for k in 1..p_stage loop
    if k = 5 then cx := tr[1]; cy := tr[2]; exit; end if;
    ang := (abs(hashtext(coalesce(seed, 0)::text || 'zang' || k)) % 3600) / 3600.0 * 2 * pi();
    mag := (abs(hashtext(coalesce(seed, 0)::text || 'zmag' || k)) % 1000) / 1000.0 * 0.45 * radii[k + 1];
    nx := tr[1] + cos(ang) * mag; ny := tr[2] + sin(ang) * mag;
    room := radii[k] - radii[k + 1];
    d := sqrt((nx - cx) ^ 2 + (ny - cy) ^ 2);
    if d > room and d > 0 then nx := cx + (nx - cx) * room / d; ny := cy + (ny - cy) * room / d; end if;
    -- TR14 must stay comfortably inside
    while sqrt((nx - tr[1]) ^ 2 + (ny - tr[2]) ^ 2) > radii[k + 1] * 0.7 loop
      nx := nx + (tr[1] - nx) * 0.3; ny := ny + (tr[2] - ny) * 0.3;
    end loop;
    cx := nx; cy := ny;
  end loop;
  return array[cx, cy, radii[p_stage + 1]];
end $$;

create or replace function _in_circle(c float8[], x float8, y float8) returns boolean language sql immutable as $$
  select c is null or sqrt((x - c[1]) ^ 2 + (y - c[2]) ^ 2) <= c[3]
$$;

-- Nearest enabled location inside the zone of the given stage (prefers locations also inside the next one).
create or replace function _nearest_safe_xy(p_event uuid, p_stage int, p_x float8, p_y float8) returns text
language sql stable as $$
  select id from locations
  where enabled and kind <> 'start' and _in_circle(_zone_circle(p_event, p_stage), x, y)
  order by _in_circle(_zone_circle(p_event, least(5, p_stage + 1)), x, y) desc,
           (x - p_x) ^ 2 + (y - p_y) ^ 2
  limit 1
$$;

-- Public zone/red-zone state for every screen (lives in arenas.overlay, already returned to all clients).
create or replace function _zone_publish(p_arena uuid) returns void language plpgsql as $$
declare a arenas; cur float8[]; nxt float8[];
begin
  select * into a from arenas where id = p_arena;
  if a.id is null then return; end if;
  cur := _zone_circle(a.event_id, a.zone_stage);
  if a.zone_next_at is not null and a.zone_stage < 5 then nxt := _zone_circle(a.event_id, a.zone_stage + 1); end if;
  update arenas set overlay = (overlay - 'zone' - 'red') || jsonb_build_object(
      'zone', jsonb_build_object('stage', a.zone_stage, 'cur', to_jsonb(cur), 'next', to_jsonb(nxt), 'next_at', a.zone_next_at),
      'world', jsonb_build_object('speed', _cfg(a.event_id, 'move_speed') / 1000.0, 'loc_radius', _cfg(a.event_id, 'loc_radius') / 1000.0,
                                  'engage_range', _cfg(a.event_id, 'engage_range') / 1000.0))
    || case when a.red_at is not null then jsonb_build_object('red', jsonb_build_object('x', a.red_x, 'y', a.red_y, 'r', a.red_r, 'at', a.red_at)) else '{}'::jsonb end
  where id = p_arena;
end $$;

-- Location area the point is in (nearest within loc_radius), or null in the open.
create or replace function _loc_at(p_event uuid, p_x float8, p_y float8) returns text language sql stable as $$
  select id from locations
  where enabled and kind <> 'start' and (x - p_x) ^ 2 + (y - p_y) ^ 2 <= (_cfg(p_event, 'loc_radius') / 1000.0) ^ 2
  order by (x - p_x) ^ 2 + (y - p_y) ^ 2 limit 1
$$;

-- ── Zone collapse no longer teleports anyone: squads outside run for it and take damage over time.
create or replace function _apply_zone(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; c float8[]; r teams; xy float8[]; v_out int := 0;
begin
  select * into a from arenas where id = p_arena;
  c := _zone_circle(a.event_id, a.zone_stage);
  for r in select * from teams where arena_id = p_arena and ready loop
    xy := _team_xy(r);
    if not _in_circle(c, xy[1], xy[2]) then v_out := v_out + 1; perform _ping_team(r.id, 'zone'); end if;
  end loop;
  if v_out > 0 then perform _feed(p_arena, 'zone.outside', jsonb_build_object('squads', v_out)); end if;
  perform _zone_publish(p_arena);
end $$;

-- ── Red zone ─────────────────────────────────────────────────────────────────
create or replace function _red_spawn(p_arena uuid, p_x float8 default null, p_y float8 default null) returns jsonb
language plpgsql as $$
declare a arenas; c float8[]; tr float8[]; rr float8; x float8; y float8; i int; ang float8; mag float8;
begin
  select * into a from arenas where id = p_arena for update;
  if a.phase <> 'play' then raise exception 'WRONG_PHASE'; end if;
  if a.red_at is not null then raise exception 'RED_ZONE_ACTIVE'; end if;
  c := _zone_circle(a.event_id, a.zone_stage);
  tr := _loc_xy('tr14');
  rr := _cfg(a.event_id, 'red_radius') / 1000.0;
  if p_x is not null then
    x := greatest(0.04, least(0.96, p_x)); y := greatest(0.04, least(0.96, p_y));
  else
    for i in 1..30 loop
      ang := random() * 2 * pi(); mag := sqrt(random()) * greatest(0.01, c[3] - rr * 0.5);
      x := greatest(0.05, least(0.95, c[1] + cos(ang) * mag)); y := greatest(0.05, least(0.95, c[2] + sin(ang) * mag));
      exit when sqrt((x - tr[1]) ^ 2 + (y - tr[2]) ^ 2) > rr + 0.05; -- never on the finale room
    end loop;
  end if;
  update arenas set red_x = x, red_y = y, red_r = rr, red_at = now() + _secs(_cfg(a.event_id, 'red_warning')) where id = p_arena;
  perform _feed(p_arena, 'redzone.warning', jsonb_build_object('location', _loc_at(a.event_id, x, y)));
  perform _zone_publish(p_arena);
  perform _ping_arena(p_arena, 'redzone');
  return jsonb_build_object('x', x, 'y', y, 'r', rr);
end $$;

create or replace function _red_strike(p_arena uuid) returns void language plpgsql as $$
declare a arenas; r teams; xy float8[]; v_hits int[] := '{}'; v_dmg int; d int;
begin
  select * into a from arenas where id = p_arena for update;
  if a.red_at is null then return; end if;
  v_dmg := _cfg(a.event_id, 'red_damage');
  for r in select * from teams where arena_id = p_arena and ready and state <> 'recovery' loop
    xy := _team_xy(r);
    if sqrt((xy[1] - a.red_x) ^ 2 + (xy[2] - a.red_y) ^ 2) <= a.red_r then
      d := _damage(r.id, v_dmg, 'redzone', 'rz-' || extract(epoch from a.red_at)::bigint, 'Caught in a red zone');
      v_hits := v_hits || r.number;
      perform _ping_team(r.id, 'redzone');
    end if;
  end loop;
  update arenas set red_x = null, red_y = null, red_r = null, red_at = null, last_red_at = now() where id = p_arena;
  perform _feed(p_arena, 'redzone.strike', jsonb_build_object('hits', to_jsonb(v_hits)));
  perform _zone_publish(p_arena);
  perform _ping_arena(p_arena, 'redzone');
end $$;

-- ── Captain steering (joystick) ───────────────────────────────────────────────
create or replace function captain_steer(p_token text, p_x float8, p_y float8) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; cur float8[]; dt float8; maxd float8; d float8; nx float8; ny float8;
  v_loc text; v_others int; v_ping boolean;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state = 'recovery' then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  if p_x is null or p_y is null or p_x = 'NaN'::float8 or p_y = 'NaN'::float8 or abs(p_x) = 'Infinity'::float8 or abs(p_y) = 'Infinity'::float8 then raise exception 'BAD_REQUEST'; end if;
  cur := _team_xy(t);
  -- distance allowed since the last accepted position (capped so idling never banks a teleport)
  dt := least(4, greatest(0, extract(epoch from now() - coalesce(case when t.state = 'traveling' then now() else t.pos_at end, now() - interval '1 second'))));
  if t.state = 'traveling' then dt := 0.25; end if;
  maxd := (_cfg(t.event_id, 'move_speed') / 1000.0) * dt * 1.25 + 0.003;
  nx := greatest(0.035, least(0.965, p_x)); ny := greatest(0.035, least(0.965, p_y));
  d := sqrt((nx - cur[1]) ^ 2 + (ny - cur[2]) ^ 2);
  if d > maxd then nx := cur[1] + (nx - cur[1]) * maxd / d; ny := cur[2] + (ny - cur[2]) * maxd / d; end if;
  v_loc := _loc_at(t.event_id, nx, ny);
  if v_loc is distinct from t.location_id then
    -- leaving an area ends its search (no penalty)
    update mission_instances set status = 'cancelled'
    where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
  end if;
  v_ping := v_loc is distinct from t.location_id or t.last_steer_ping is null or t.last_steer_ping < now() - interval '2 seconds';
  update teams set pos_x = nx, pos_y = ny, pos_at = now(), dropped = true, location_id = v_loc,
    state = 'idle', travel_to = null, travel_from = null, travel_started_at = null, travel_arrive_at = null,
    visit_missions = case when v_loc is distinct from t.location_id then 0 else visit_missions end,
    last_steer_ping = case when v_ping then now() else last_steer_ping end
  where id = t.id;
  if v_loc is not null and v_loc is distinct from t.location_id then
    if t.jammed_until is null or t.jammed_until < now() then
      perform _feed(t.arena_id, 'squad.arrived', jsonb_build_object('team', t.number, 'location', v_loc));
    end if;
    select count(*) into v_others from teams x where x.arena_id = t.arena_id and x.ready and x.id <> t.id and x.location_id = v_loc;
    if v_others > 0 then
      perform _feed(t.arena_id, 'encounter.detected', jsonb_build_object('location', v_loc, 'squads', v_others + 1));
      perform _ping_arena(t.arena_id, 'encounter');
    end if;
  end if;
  if v_ping then perform _ping_team(t.id, 'move'); end if;
  return jsonb_build_object('x', nx, 'y', ny, 'location', v_loc, 'clamped', d > maxd);
end $$;

create or replace function _respawn(p_team uuid, p_reason text) returns void
language plpgsql as $$
declare t teams; a arenas; xy float8[]; v_safe text;
begin
  select * into t from teams where id = p_team for update;
  if t.state <> 'recovery' then return; end if;
  update mission_instances set status = case when status = 'active' then 'expired' else status end
  where team_id = p_team and kind = 'recovery' and status = 'active';
  update teams set state = 'idle', recovery_deadline = null, hp = _cfg(t.event_id, 'hp_respawn'),
    protected_until = now() + _secs(_cfg(t.event_id, 'protect_seconds'))
  where id = p_team;
  select * into a from arenas where id = t.arena_id;
  xy := _team_xy(t);
  if a.phase = 'play' and not _in_circle(_zone_circle(a.event_id, a.zone_stage), xy[1], xy[2]) then
    v_safe := _nearest_safe_xy(a.event_id, a.zone_stage, xy[1], xy[2]);
    if v_safe is not null then
      update teams set location_id = v_safe, pos_x = (_loc_xy(v_safe))[1], pos_y = (_loc_xy(v_safe))[2], pos_at = now(), visit_missions = 0
      where id = p_team;
    end if;
  end if;
  perform _feed(t.arena_id, 'recovery.completed', jsonb_build_object('team', t.number, 'how', p_reason));
  perform _ping_team(p_team, 'recovery');
end $$;

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
    travel_arrive_at = null, travel_started_at = null, travel_fx = null, travel_fy = null, dropped = true, visit_missions = 0
  where id = p_team;
  -- reward a well-timed escape from a location about to collapse
  if a.zone_next_at is not null and a.zone_stage < 5 and t.travel_fx is not null
     and not _in_circle(_zone_circle(a.event_id, a.zone_stage + 1), t.travel_fx, t.travel_fy)
     and _in_circle(_zone_circle(a.event_id, a.zone_stage + 1), v_to.x, v_to.y) then
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

create or replace function _spawn_airdrop(p_arena uuid, p_location text, p_tier text) returns uuid
language plpgsql as $$
declare a arenas; v_loc text := p_location; v_tpl text; v_id uuid; v_tier text := coalesce(p_tier, 'common');
begin
  select * into a from arenas where id = p_arena;
  if v_loc is null then
    select id into v_loc from locations
    where enabled and kind <> 'start' and id <> 'tr14' and _in_circle(_zone_circle(a.event_id, least(5, a.zone_stage + 1)), x, y)
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

create or replace function _shift_arena(p_arena uuid, p_delta interval) returns void
language plpgsql as $$
begin
  update arenas set
    shuttle_departed_at = shuttle_departed_at + p_delta, shuttle_arrive_at = shuttle_arrive_at + p_delta,
    roles_deadline = roles_deadline + p_delta, play_started_at = play_started_at + p_delta,
    zone_next_at = zone_next_at + p_delta, last_airdrop_at = last_airdrop_at + p_delta,
    phase_started_at = phase_started_at + p_delta, phase_next_at = phase_next_at + p_delta,
    red_at = red_at + p_delta, last_red_at = last_red_at + p_delta,
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
  update teams set zone_hit_at = zone_hit_at + p_delta, travel_started_at = travel_started_at + p_delta, travel_arrive_at = travel_arrive_at + p_delta,
    recovery_deadline = recovery_deadline + p_delta, attack_cooldown_until = attack_cooldown_until + p_delta,
    protected_until = protected_until + p_delta, jammed_until = jammed_until + p_delta, scan_until = scan_until + p_delta
  where arena_id = p_arena;
  perform _zone_publish(p_arena);
end $$;

create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare a arenas; r record; tm teams; c float8[]; xy float8[]; v_tick int; v_bucket bigint; v_changed boolean := false; v_sched text[]; v_next int; v_at timestamptz; v_target int;
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

  -- safe zone: squads outside lose HP every few seconds (shield absorbs first)
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' then
    c := _zone_circle(a.event_id, a.zone_stage);
    v_tick := greatest(2, _cfg(a.event_id, 'zone_tick_seconds'));
    v_bucket := floor(extract(epoch from now()) / v_tick)::bigint;
    for tm in select * from teams where arena_id = p_arena and ready and state <> 'recovery'
             and (zone_hit_at is null or zone_hit_at <= now() - _secs(v_tick)) loop
      xy := _team_xy(tm);
      if not _in_circle(c, xy[1], xy[2]) then
        update teams set zone_hit_at = now() where id = tm.id;
        perform _damage(tm.id, _cfg(a.event_id, 'zone_tick_damage'), 'zone_damage', 'zt-' || v_bucket, 'Outside the safe zone');
        perform _ping_team(tm.id, 'zone');
        v_changed := true;
      end if;
    end loop;
  end if;

  -- red zones: strike when the warning runs out; optional automatic red zones from phase 2
  select * into a from arenas where id = p_arena;
  if a.red_at is not null and now() >= a.red_at then
    perform _red_strike(p_arena); v_changed := true;
  elsif a.phase = 'play' and a.red_at is null and a.match_phase >= 2 and _cfg(a.event_id, 'red_interval') > 0
     and coalesce(a.last_red_at, a.phase_started_at, a.play_started_at) < now() - make_interval(mins => _cfg(a.event_id, 'red_interval')) then
    perform _red_spawn(p_arena); v_changed := true;
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

  if v_changed then perform _zone_publish(p_arena); perform _ping_arena(p_arena, 'tick'); end if;
  return v_changed;
end $$;

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
      'duel_phase', _cfg(a.event_id, 'duel_phase'), 'zone_target', _phase_zone_target(p_phase)))
  where id = p_arena;
  if a.match_phase is distinct from p_phase or a.phase_started_at is null then
    perform _feed(p_arena, 'phase.started', jsonb_build_object('phase', p_phase));
  end if;
  perform _zone_publish(p_arena);
  perform _ping_arena(p_arena, 'phase');
end $$;

create or replace function captain_move(p_token text, p_location text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; l locations; v_secs numeric; cur float8[]; d float8;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state = 'recovery' then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  select * into l from locations where id = p_location;
  if l.id is null or l.kind = 'start' or not l.enabled then raise exception 'BAD_LOCATION'; end if;
  if l.id = t.location_id and t.state = 'idle' then raise exception 'ALREADY_HERE'; end if;
  cur := _team_xy(t);
  d := sqrt((l.x - cur[1]) ^ 2 + (l.y - cur[2]) ^ 2);
  if not t.dropped then
    v_secs := _cfg(t.event_id, 'drop_seconds');           -- parachute from the bus: same time anywhere
  else
    v_secs := greatest(1, round((d / (_cfg(t.event_id, 'move_speed') / 1000.0))::numeric, 1));
  end if;
  -- leaving forfeits the current search without a penalty
  update mission_instances set status = 'cancelled'
  where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
  update teams set state = 'traveling', travel_from = location_id, travel_to = l.id, travel_started_at = now(),
    travel_arrive_at = now() + _secs(v_secs), travel_fx = cur[1], travel_fy = cur[2],
    pos_x = cur[1], pos_y = cur[2], pos_at = now()
  where id = t.id;
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
  if t.location_id is null then raise exception 'NOT_AT_LOCATION'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind <> 'battle') then raise exception 'MISSION_ACTIVE'; end if;
  if t.visit_missions >= _cfg(t.event_id, 'visit_missions') then raise exception 'AREA_EXHAUSTED'; end if;
  v_id := _start_location_mission(t.id);
  if v_id is null then raise exception 'NO_MISSIONS'; end if;
  return jsonb_build_object('instance', v_id);
end $$;

create or replace function captain_buy(p_token text, p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; l locations; it items;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into l from locations where id = t.location_id;
  if t.state <> 'idle' or l.id is null or not (l.tags && array['market', 'social']) then raise exception 'NO_MARKET_HERE'; end if;
  select * into it from items where id = p_item;
  if it.id is null or it.price <= 0 then raise exception 'BAD_ITEM'; end if;
  if 'social' = any(l.tags) and not ('market' = any(l.tags)) and it.kind not in ('intel', 'stealth', 'airdrop') then raise exception 'NOT_SOLD_HERE'; end if;
  if t.coins < it.price then raise exception 'NOT_ENOUGH_COINS'; end if;
  perform _apply(t.id, 'purchase', 0, -it.price, 0, 0, null, 'Bought ' || it.name);
  perform _add_item(t.id, p_item, 1);
  perform _ping_team(t.id, 'item');
  return jsonb_build_object('bought', p_item);
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
      v_dest := _nearest_safe_xy(a.event_id, least(5, a.zone_stage + 1), (_team_xy(t))[1], (_team_xy(t))[2]);
      update mission_instances set status = 'cancelled' where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop');
      update teams set state = 'idle', location_id = v_dest, pos_x = (_loc_xy(v_dest))[1], pos_y = (_loc_xy(v_dest))[2], pos_at = now(),
        travel_to = null, travel_from = null, travel_arrive_at = null, travel_fx = null, travel_fy = null,
        dropped = true, visit_missions = 0 where id = t.id;
    else raise exception 'BAD_ITEM';
  end case;
  perform _add_item(t.id, p_item, -1);
  insert into ledger(arena_id, team_id, kind, ref, reason, actor) values (t.arena_id, t.id, 'item_used', null, p_item, 'captain');
  perform _ping_team(t.id, 'item');
  return jsonb_build_object('used', p_item, 'location', v_dest);
end $$;

create or replace function captain_attack(p_token text, p_target uuid, p_weapon text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_txy float8[]; v_dxy float8[]; p players; t teams; d teams; a arenas; it items; v_tpl text; v_bid uuid; v_secs int; v_qty int; v_al alliances;
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
  v_txy := _team_xy(t); v_dxy := _team_xy(d);
  if sqrt((v_txy[1] - v_dxy[1]) ^ 2 + (v_txy[2] - v_dxy[2]) ^ 2) > _cfg(t.event_id, 'engage_range') / 1000.0 then raise exception 'NOT_IN_RANGE'; end if;
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
  insert into battles(arena_id, attacker_id, defender_id, weapon, template_id, location_id, x, y, damage, deadline)
  values (a.id, t.id, d.id, p_weapon, v_tpl, coalesce(t.location_id, d.location_id), (v_txy[1] + v_dxy[1]) / 2, (v_txy[2] + v_dxy[2]) / 2, (it.params ->> 'damage')::int, now() + _secs(v_secs))
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
        'pos', case when t.jammed_until is null or t.jammed_until < now() then to_jsonb(_team_xy(t)) end,
        'travel_to', case when t.jammed_until is null or t.jammed_until < now() then t.travel_to end,
        'travel_from', case when t.jammed_until is null or t.jammed_until < now() then t.travel_from end,
        'travel_started_at', t.travel_started_at, 'travel_arrive_at', t.travel_arrive_at,
        'in_battle', exists (select 1 from battles b where b.status = 'active' and (b.attacker_id = t.id or b.defender_id = t.id)),
        'sync_solved', case when sr.id is not null then exists (select 1 from mission_instances mi where mi.sync_round_id = sr.id and mi.team_id = t.id and mi.status = 'solved') end
      ) order by t.number), '[]'::jsonb) from teams t where t.arena_id = a.id),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('location', location_id, 'tier', tier, 'expires_at', expires_at)), '[]'::jsonb)
      from airdrops where arena_id = a.id and status = 'open'),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object('attacker', (select number from teams where id = b.attacker_id),
        'defender', (select number from teams where id = b.defender_id), 'weapon', b.weapon, 'location', b.location_id, 'x', b.x, 'y', b.y, 'deadline', b.deadline)), '[]'::jsonb)
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
        'location', t.location_id, 'state', t.state, 'travel_to', t.travel_to, 'pos', to_jsonb(_team_xy(t)),
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

create or replace function _host_exec_p0(p_ev uuid, p_arena uuid, p_cmd text, p_args jsonb, p_reason text) returns jsonb
language plpgsql as $$
declare a arenas; e events; t teams; v_delta interval; v_pin text; v_salt text; v_out jsonb := '[]'::jsonb; i int; j int;
begin
  select * into e from events where id = p_ev;
  if p_arena is not null then select * into a from arenas where id = p_arena; end if;


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
  when 'red_zone' then
    return _red_spawn(a.id, (p_args ->> 'x')::float8, (p_args ->> 'y')::float8);
  when 'red_cancel' then
    update arenas set red_x = null, red_y = null, red_r = null, red_at = null where id = a.id;
    perform _zone_publish(a.id);
  else
    raise exception 'UNKNOWN_COMMAND';
  end case;
  return '{}'::jsonb;
end $$;

create or replace function host_command(p_token text, p_arena uuid, p_cmd text, p_args jsonb default '{}'::jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_ids uuid[]; v_id uuid; v_out jsonb := '{}'::jsonb; v_err text; v_res jsonb; v_delta interval; v_logargs jsonb;
  v_all_ok text[] := array['open_boarding','assign_buses','drive','finalize_roles','pause','resume','broadcast','clear_overlay',
    'blackout','countdown','story','bargain','zone_warn','zone_now','zone_cancel','zone_set','spawn_airdrop','begin_finale',
    'finale_stage','launch_sync','close_sync','lock_results','reveal_winner','end_game','reveal_squad00',
    'next_phase','set_phase','hide_rankings','red_zone','red_cancel'];
  v_new text[] := array['set_phase','next_phase','hide_rankings','reset_pin','red_zone','red_cancel'];
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
      -- any number of complete squads (1–15) can play a map; an empty map cannot start
      if p_cmd in ('open_boarding', 'assign_buses', 'drive') and v_id is not null
         and not exists (select 1 from teams where arena_id = v_id and ready) then
        raise exception 'NO_READY_SQUADS';
      end if;
      if p_cmd = any(v_new) then
        v_res := _host_exec_p0(v_ev, v_id, p_cmd, p_args, p_reason);
      elsif p_cmd = 'clear_overlay' then
        update arenas set overlay = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(overlay) as x(k, v)
          where k in ('match', 'zone', 'world', 'red')) where id = v_id;
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
        update arenas set match_phase = 0, phase_started_at = null, phase_next_at = null, zone_hold = false,
          red_x = null, red_y = null, red_r = null, red_at = null, last_red_at = null where id = v_id;
        update teams set zone_hit_at = null, travel_fx = null, travel_fy = null where arena_id = v_id;
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
    if v_id is not null then perform _zone_publish(v_id); perform _ping_arena(v_id, 'host'); end if;
  end loop;
  return jsonb_build_object('ok', true, 'result', v_out);
end $$;

-- Trial mode removed
drop function if exists host_create_trial(text, text, text, int);
drop function if exists host_trial_status(text);
update arenas set overlay = overlay - 'trial' where overlay ? 'trial';
do $$ declare r record; begin for r in select id from arenas loop perform _zone_publish(r.id); end loop; end $$;

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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
