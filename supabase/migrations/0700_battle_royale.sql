-- ═══════════════════════════════════════════════════════════════════════════
-- v6 · Battle royale rules
--
--  1. Zone like Free Fire: the white circle shows where the next safe zone will be, a countdown
--     runs, then the gas wall closes in smoothly. Damage outside grows with every stage.
--  2. Buggy and on foot: squads land on foot, walk to a parking yard and collect the buggy with
--     their number. Buggies cannot enter buildings: the captain parks at the door and walks in,
--     climbs the stairs on foot, and walks back to the buggy.
--  3. Live gunfights: every squad member can shoot a rival squad in range and in sight. Damage,
--     fire rate, magazines, reloads, headshots and cover behind buildings. A squad at 0 HP is
--     knocked out (recovery) and the squad that knocked it takes points, coins and loot.
--  4. Airport start: players check in with map number + squad PIN, get a boarding pass, roles are
--     assigned automatically at take-off, the plane flies over the campus, squads jump within
--     gliding range and parachute down.
--
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

alter table arenas add column if not exists zone_shrink_from timestamptz;
alter table arenas add column if not exists zone_shrink_until timestamptz;
alter table arenas add column if not exists plane_ax float8;
alter table arenas add column if not exists plane_ay float8;
alter table arenas add column if not exists plane_bx float8;
alter table arenas add column if not exists plane_by float8;
alter table arenas add column if not exists plane_t0 timestamptz;
alter table arenas add column if not exists plane_t1 timestamptz;
alter table teams add column if not exists vehicle text not null default 'none';
alter table teams add column if not exists buggy_x float8;
alter table teams add column if not exists buggy_y float8;
alter table teams add column if not exists kills int not null default 0;
alter table teams add column if not exists fight_at timestamptz;
alter table players add column if not exists shot_at timestamptz;
alter table players add column if not exists mag int;
alter table players add column if not exists reload_until timestamptz;
do $$ begin
  alter table teams add constraint teams_vehicle_chk check (vehicle in ('none', 'in', 'parked'));
exception when duplicate_object then null; end $$;

-- squads that were already driving around before this upgrade keep driving
do $$ begin
  if not exists (select 1 from app_secrets where key = 'v6_vehicles') then
    update teams set vehicle = 'in' where dropped and vehicle = 'none';
    insert into app_secrets(key, value) values ('v6_vehicles', 'done');
  end if;
end $$;

-- ── settings ────────────────────────────────────────────────────────────────
drop function if exists _defaults_v5();
alter function _defaults() rename to _defaults_v5;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v5() || jsonb_build_object(
    'zone_shrink', 40,          -- seconds the gas wall takes to close in to the white circle
    'zone_tick_seconds', 2,     -- damage outside the zone every 2 s …
    'zone_tick_damage', 2,      -- … of 2 HP × the stage multiplier (1, 1, 2, 3, 5, 8)
    'foot_speed', 6,            -- running on foot (the buggy: move_speed)
    'fire_from_phase', 1,       -- gunfights allowed from match phase 1
    'kill_points', 60, 'kill_coins', 25,
    'glide_range', 300,         -- a parachute glides up to 0.3 of the campus (~480 m)
    'plane_seconds', 55,        -- the plane's pass over the campus
    'drop_seconds', 12,
    'shuttle_seconds', 40,      -- take-off and flight from Chennai airport
    'roles_seconds', 6,         -- "approaching Hexaware": roles shown, get ready to jump
    'br_mode', 1)               -- 1: airport, plane, auto roles, on foot until the buggy; 0: the earlier bus start
$$;
drop function if exists _auto_preset_v5(text);
alter function _auto_preset(text) rename to _auto_preset_v5;
create function _auto_preset(p_length text) returns jsonb
language sql immutable as $$
  select _auto_preset_v5(p_length) || jsonb_build_object('shuttle_seconds', 40, 'roles_seconds', 6,
    'zone_shrink', case p_length when 'quick' then 25 when 'full' then 60 else 40 end)
$$;

-- ── 1. zone ─────────────────────────────────────────────────────────────────
create or replace function _zone_now(p_arena uuid) returns float8[]
language plpgsql stable as $$
declare a arenas; c float8[]; o float8[]; p float8;
begin
  select * into a from arenas where id = p_arena;
  c := _zone_circle(a.event_id, a.zone_stage);
  if a.zone_stage > 0 and a.zone_shrink_until is not null and now() < a.zone_shrink_until then
    o := _zone_circle(a.event_id, a.zone_stage - 1);
    p := least(1, greatest(0, extract(epoch from now() - a.zone_shrink_from) / greatest(1, extract(epoch from a.zone_shrink_until - a.zone_shrink_from))));
    return array[o[1] + (c[1] - o[1]) * p, o[2] + (c[2] - o[2]) * p, o[3] + (c[3] - o[3]) * p];
  end if;
  return c;
end $$;

create or replace function _zone_dmg(p_event uuid, p_stage int) returns int
language sql stable as $$
  select _cfg(p_event, 'zone_tick_damage') * (array[1, 1, 2, 3, 5, 8])[least(5, greatest(0, coalesce(p_stage, 0))) + 1]
$$;

create or replace function _zone_advance(p_arena uuid) returns void
language plpgsql as $$
declare a arenas;
begin
  update arenas set zone_stage = least(5, zone_stage + 1), zone_next_at = null,
    zone_shrink_from = now(), zone_shrink_until = now() + _secs(_cfg(event_id, 'zone_shrink'))
  where id = p_arena returning * into a;
  perform _feed(p_arena, 'zone.collapsed', jsonb_build_object('stage', a.zone_stage));
  perform _apply_zone(p_arena);
end $$;

create or replace function _apply_zone(p_arena uuid) returns void
language plpgsql as $$
declare r record;
begin
  for r in select id from teams where arena_id = p_arena and ready loop perform _ping_team(r.id, 'zone'); end loop;
  perform _zone_publish(p_arena);
end $$;

create or replace function _zone_publish(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; cur float8[]; nxt float8[]; prv float8[];
begin
  select * into a from arenas where id = p_arena;
  if a.id is null then return; end if;
  cur := _zone_circle(a.event_id, a.zone_stage);
  if a.zone_next_at is not null and a.zone_stage < 5 then nxt := _zone_circle(a.event_id, a.zone_stage + 1); end if;
  if a.zone_stage > 0 and a.zone_shrink_until is not null and a.zone_shrink_until > now() then prv := _zone_circle(a.event_id, a.zone_stage - 1); end if;
  update arenas set overlay = (overlay - 'zone' - 'red') || jsonb_build_object(
      'zone', jsonb_build_object('stage', a.zone_stage, 'cur', to_jsonb(cur), 'next', to_jsonb(nxt), 'next_at', a.zone_next_at,
        'prev', to_jsonb(prv), 'shrink_from', case when prv is not null then a.zone_shrink_from end,
        'shrink_until', case when prv is not null then a.zone_shrink_until end,
        'dps', round(_zone_dmg(a.event_id, a.zone_stage)::numeric / greatest(1, _cfg(a.event_id, 'zone_tick_seconds')), 1)),
      'world', jsonb_build_object('speed', _cfg(a.event_id, 'move_speed') / 1000.0, 'foot_speed', _cfg(a.event_id, 'foot_speed') / 1000.0,
        'loc_radius', _cfg(a.event_id, 'loc_radius') / 1000.0, 'engage_range', _cfg(a.event_id, 'engage_range') / 1000.0,
        'glide_range', _cfg(a.event_id, 'glide_range') / 1000.0, 'fire_from_phase', _cfg(a.event_id, 'fire_from_phase')))
    || case when a.red_at is not null then jsonb_build_object('red', jsonb_build_object('x', a.red_x, 'y', a.red_y, 'r', a.red_r, 'at', a.red_at)) else '{}'::jsonb end
  where id = p_arena;
end $$;

-- the game clock: damage from the moving wall, and no new warning while the wall is still moving
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('_tick_core(uuid, boolean)'::regprocedure);
  n := d;
  n := regexp_replace(n, 'c := _zone_circle\(a\.event_id, a\.zone_stage\);(\s*)v_tick := greatest\(2,', 'c := _zone_now(p_arena);\1v_tick := greatest(2,');
  n := replace(n, '_cfg(a.event_id, ''zone_tick_damage'')', '_zone_dmg(a.event_id, a.zone_stage)');
  n := replace(n, 'a.zone_next_at is null and a.zone_stage < 5', 'a.zone_next_at is null and a.zone_stage < 5 and coalesce(a.zone_shrink_until, now()) <= now()');
  if n = d or position('_zone_now(p_arena)' in n) = 0 or position('_zone_dmg(' in n) = 0 or position('zone_shrink_until' in n) = 0 then
    raise exception 'v6: could not patch the game clock (_tick_core)';
  end if;
  execute n;
end $$;

-- ── 2. buggy and on foot ────────────────────────────────────────────────────
create or replace function _team_speed(t teams) returns float8
language sql stable as $$
  select (case when t.vehicle = 'in' or _cfg(t.event_id, 'br_mode') = 0 then _cfg(t.event_id, 'move_speed') else _cfg(t.event_id, 'foot_speed') end) / 1000.0
$$;

-- the parking bay with the squad's number in the parking yard nearest to a point
create or replace function _buggy_bay(p_number int, p_x float8, p_y float8) returns float8[]
language plpgsql immutable as $$
declare l record; i int := (greatest(1, p_number) - 1) % 16;
begin
  select * into l from (values ('park_sw', 0.12, 0.83, 0.42, 0.95), ('park_se', 0.58, 0.83, 0.88, 0.95), ('park_dc', 0.70, 0.37, 0.765, 0.43))
    v(id, x0, y0, x1, y1)
  order by ((x0 + x1) / 2 - p_x) ^ 2 + ((y0 + y1) / 2 - p_y) ^ 2 limit 1;
  return array[l.x0 + (l.x1 - l.x0) * (0.08 + 0.84 * (i % 8) / 7.0), l.y0 + (l.y1 - l.y0) * (case when i < 8 then 0.3 else 0.7 end)];
end $$;

create or replace function _in_building(p_x float8, p_y float8) returns text
language sql stable as $$
  select id from buildings where p_x between x0 and x1 and p_y between y0 and y1 limit 1
$$;

create or replace function captain_steer(p_token text, p_x double precision, p_y double precision, p_vx double precision default 0, p_vy double precision default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; cur float8[]; dt float8; maxd float8; d float8; nx float8; ny float8;
  v_loc text; v_others int; v_ping boolean; b buildings; v_spd float8; v_vx float8; v_vy float8; v_vm float8; v_pick jsonb; v_wall text;
  v_parked boolean := false; v_veh text;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state = 'recovery' then raise exception 'BUSY'; end if;
  if not t.dropped and _cfg(t.event_id, 'br_mode') = 1 then
    if t.state = 'traveling' then raise exception 'BUSY'; end if;
    raise exception 'JUMP_FIRST';
  end if;
  if not t.dropped then t.vehicle := 'in'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  if p_x is null or p_y is null or p_x = 'NaN'::float8 or p_y = 'NaN'::float8 or abs(p_x) = 'Infinity'::float8 or abs(p_y) = 'Infinity'::float8 then raise exception 'BAD_REQUEST'; end if;
  cur := _team_xy(t);
  v_veh := t.vehicle;
  v_spd := _team_speed(t);
  dt := least(4, greatest(0, extract(epoch from now() - coalesce(case when t.state = 'traveling' then now() else t.pos_at end, now() - interval '1 second'))));
  if t.state = 'traveling' then dt := 0.25; end if;
  maxd := v_spd * dt * 1.25 + 0.003;
  nx := greatest(0.02, least(0.98, p_x)); ny := greatest(0.02, least(0.98, p_y));
  d := sqrt((nx - cur[1]) ^ 2 + (ny - cur[2]) ^ 2);
  if d > maxd then nx := cur[1] + (nx - cur[1]) * maxd / d; ny := cur[2] + (ny - cur[2]) * maxd / d; end if;
  if t.level > 0 then
    select * into b from buildings where id = t.bldg;
    if b.id is not null then
      nx := greatest(b.x0 + 0.004, least(b.x1 - 0.004, nx)); ny := greatest(b.y0 + 0.004, least(b.y1 - 0.004, ny));
    end if;
  else
    select bb.id into v_wall from buildings bb
    where nx between bb.x0 and bb.x1 and ny between bb.y0 and bb.y1 and _sealed(t.arena_id, bb.id, 0)
      and not (cur[1] between bb.x0 and bb.x1 and cur[2] between bb.y0 and bb.y1)
    limit 1;
    if v_wall is not null then nx := cur[1]; ny := cur[2]; end if;
    -- a buggy cannot go into a building: the captain parks at the door and gets out
    if v_wall is null and v_veh = 'in' and _in_building(nx, ny) is not null and _in_building(cur[1], cur[2]) is null then
      nx := cur[1]; ny := cur[2]; v_veh := 'parked'; v_parked := true;
    end if;
  end if;
  v_vx := coalesce(p_vx, 0); v_vy := coalesce(p_vy, 0);
  if v_vx = 'NaN'::float8 or v_vy = 'NaN'::float8 or abs(v_vx) = 'Infinity'::float8 or abs(v_vy) = 'Infinity'::float8 then v_vx := 0; v_vy := 0; end if;
  v_vm := sqrt(v_vx ^ 2 + v_vy ^ 2);
  if v_vm > v_spd * 1.1 then v_vx := v_vx * v_spd * 1.1 / v_vm; v_vy := v_vy * v_spd * 1.1 / v_vm; end if;
  if v_wall is not null or v_parked then v_vx := 0; v_vy := 0; end if;
  v_loc := _loc_at3(t.arena_id, t.event_id, nx, ny, t.level, t.bldg);
  if v_loc is distinct from t.location_id then
    update mission_instances set status = 'cancelled'
    where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
  end if;
  v_ping := v_parked or v_loc is distinct from t.location_id or t.last_steer_ping is null or t.last_steer_ping < now() - interval '2 seconds';
  update teams set pos_x = nx, pos_y = ny, pos_at = now(), vel_x = v_vx, vel_y = v_vy, dropped = true, location_id = v_loc,
    state = 'idle', travel_to = null, travel_from = null, travel_started_at = null, travel_arrive_at = null,
    visit_missions = case when v_loc is distinct from t.location_id then 0 else visit_missions end,
    last_steer_ping = case when v_ping then now() else last_steer_ping end,
    vehicle = v_veh,
    buggy_x = case when v_veh = 'in' or v_parked then nx else buggy_x end,
    buggy_y = case when v_veh = 'in' or v_parked then ny else buggy_y end
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
  v_pick := _take_pickups(t.id, nx, ny);
  if v_ping or v_pick is not null then perform _ping_team(t.id, 'move'); end if;
  return jsonb_build_object('x', nx, 'y', ny, 'location', v_loc, 'level', t.level,
    'clamped', abs(nx - p_x) > 0.0005 or abs(ny - p_y) > 0.0005, 'wall', v_wall, 'picked', v_pick,
    'vehicle', v_veh, 'parked', v_parked);
end $$;

-- get in (next to your buggy) or get out (anywhere outdoors)
create or replace function captain_vehicle(p_token text, p_in boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; cur float8[]; v_first boolean;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state in ('recovery', 'traveling') or not t.dropped then raise exception 'BUSY'; end if;
  cur := _team_xy(t);
  if coalesce(p_in, true) then
    if t.vehicle = 'in' then return jsonb_build_object('vehicle', 'in'); end if;
    if t.level > 0 then raise exception 'TAKE_THE_STAIRS'; end if;
    if t.buggy_x is null then
      update teams set buggy_x = (_buggy_bay(t.number, cur[1], cur[2]))[1], buggy_y = (_buggy_bay(t.number, cur[1], cur[2]))[2] where id = t.id
      returning * into t;
    end if;
    if (t.buggy_x - cur[1]) ^ 2 + (t.buggy_y - cur[2]) ^ 2 > 0.009 ^ 2 then raise exception 'BUGGY_TOO_FAR'; end if;
    v_first := t.vehicle = 'none';
    update teams set vehicle = 'in', pos_x = t.buggy_x, pos_y = t.buggy_y, pos_at = now(), vel_x = 0, vel_y = 0 where id = t.id;
    if v_first then perform _feed(t.arena_id, 'squad.buggy', jsonb_build_object('team', t.number)); end if;
  else
    if t.vehicle <> 'in' then return jsonb_build_object('vehicle', t.vehicle); end if;
    update teams set vehicle = 'parked', buggy_x = cur[1], buggy_y = cur[2], vel_x = 0, vel_y = 0, pos_at = now() where id = t.id;
  end if;
  perform _ping_team(t.id, 'vehicle');
  return jsonb_build_object('vehicle', case when coalesce(p_in, true) then 'in' else 'parked' end);
end $$;

-- stairs: on foot only (a buggy is parked where it stands)
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('captain_stairs(text, integer)'::regprocedure);
  n := replace(d, 'if p_dir is null or p_dir not in (-1, 1) then raise exception ''BAD_REQUEST''; end if;',
    'if p_dir is null or p_dir not in (-1, 1) then raise exception ''BAD_REQUEST''; end if;
  if not t.dropped then raise exception ''JUMP_FIRST''; end if;
  if t.vehicle = ''in'' then
    cur := _team_xy(t);
    update teams set vehicle = ''parked'', buggy_x = cur[1], buggy_y = cur[2] where id = t.id;
  end if;');
  if n = d then raise exception 'v6: could not patch captain_stairs'; end if;
  execute n;
end $$;

-- ── 4. airport, flight, jump ────────────────────────────────────────────────
create or replace function _plane_xy(a arenas) returns float8[]
language plpgsql stable as $$
declare p float8;
begin
  if a.plane_t0 is null then return null; end if;
  p := least(1, greatest(0, extract(epoch from now() - a.plane_t0) / greatest(1, extract(epoch from a.plane_t1 - a.plane_t0))));
  return array[a.plane_ax + (a.plane_bx - a.plane_ax) * p, a.plane_ay + (a.plane_by - a.plane_ay) * p, p];
end $$;

create or replace function _plane_launch(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; ang float8 := random() * 2 * pi(); cx float8 := 0.5 + (random() - 0.5) * 0.24; cy float8 := 0.5 + (random() - 0.5) * 0.24;
  dx float8; dy float8; v_secs int;
begin
  select * into a from arenas where id = p_arena;
  dx := cos(ang); dy := sin(ang);
  v_secs := _cfg(a.event_id, 'plane_seconds');
  -- the path is twice the campus width: about a quarter of the pass is spent over open fields each side
  update arenas set plane_ax = cx - dx * 0.95, plane_ay = cy - dy * 0.95, plane_bx = cx + dx * 0.95, plane_by = cy + dy * 0.95,
    plane_t0 = now(), plane_t1 = now() + _secs(v_secs)
  where id = p_arena returning * into a;
  update arenas set overlay = overlay || jsonb_build_object('plane', jsonb_build_object(
    'a', jsonb_build_array(a.plane_ax, a.plane_ay), 'b', jsonb_build_array(a.plane_bx, a.plane_by), 't0', a.plane_t0, 't1', a.plane_t1))
  where id = p_arena;
  perform _feed(p_arena, 'plane.over', '{}'::jsonb);
end $$;

create or replace function _do_jump(p_team uuid, p_loc text, p_from float8[]) returns numeric
language plpgsql as $$
declare t teams; l locations; d float8; v_secs numeric; g float8;
begin
  select * into t from teams where id = p_team for update;
  select * into l from locations where id = p_loc;
  d := sqrt((l.x - p_from[1]) ^ 2 + (l.y - p_from[2]) ^ 2);
  g := greatest(0.05, _cfg(t.event_id, 'glide_range') / 1000.0);
  v_secs := round((_cfg(t.event_id, 'drop_seconds') * (0.6 + 0.6 * least(1, d / g)))::numeric, 1);
  update teams set state = 'traveling', travel_from = location_id, travel_to = l.id, travel_started_at = now(),
    travel_arrive_at = now() + _secs(v_secs), travel_fx = p_from[1], travel_fy = p_from[2],
    pos_x = p_from[1], pos_y = p_from[2], pos_at = now(), vehicle = 'none', buggy_x = null, buggy_y = null
  where id = p_team;
  perform _feed(t.arena_id, 'squad.jumped', jsonb_build_object('team', t.number, 'to', l.id));
  perform _ping_team(p_team, 'move');
  perform _ping_arena(t.arena_id, 'move');
  return v_secs;
end $$;

-- captain_move: before landing it is the jump (from the plane, within gliding range)
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('captain_move(text, text)'::regprocedure);
  n := regexp_replace(d, 'cur := _team_xy\(t\);(\s*)d := sqrt\(\(l\.x - cur\[1\]\) \^ 2 \+ \(l\.y - cur\[2\]\) \^ 2\);', ' if not t.dropped and _cfg(t.event_id, ''br_mode'') = 1 then
    if t.state = ''traveling'' then raise exception ''BUSY''; end if;
    cur := _plane_xy(a);
    if cur is null or cur[3] >= 0.99 then raise exception ''PLANE_GONE''; end if;
    if cur[1] < 0.0 or cur[1] > 1.0 or cur[2] < 0.0 or cur[2] > 1.0 then raise exception ''NOT_OVER_CAMPUS''; end if;
    if sqrt((l.x - cur[1]) ^ 2 + (l.y - cur[2]) ^ 2) > _cfg(t.event_id, ''glide_range'') / 1000.0 then raise exception ''TOO_FAR_TO_GLIDE''; end if;
    v_secs := _do_jump(t.id, l.id, cur);
    return jsonb_build_object(''arrive_at'', now() + _secs(v_secs), ''seconds'', v_secs, ''jump'', true);
  end if;
  cur := _team_xy(t);
  d := sqrt((l.x - cur[1]) ^ 2 + (l.y - cur[2]) ^ 2);');
  n := replace(n, 'v_secs := greatest(1, round((d / (_cfg(t.event_id, ''move_speed'') / 1000.0))::numeric, 1));',
                  'v_secs := greatest(1, round((d / _team_speed(t))::numeric, 1));');
  if n = d or position('_do_jump' in n) = 0 then raise exception 'v6: could not patch captain_move'; end if;
  execute n;
end $$;

-- roles are handed out by the game at take-off: a random squad member becomes captain
create or replace function _auto_roles(p_arena uuid) returns boolean
language plpgsql as $$
declare t record; p record; v_missing text[]; v_any boolean := false;
begin
  if _cfg((select event_id from arenas where id = p_arena), 'br_mode') = 0 then return false; end if;
  for t in select * from teams where arena_id = p_arena and ready loop
    select array_agg(r order by array_position(array['captain', 'scout', 'decoder', 'intel'], r)) into v_missing
    from unnest(array['captain', 'scout', 'decoder', 'intel']) r
    where not exists (select 1 from players where team_id = t.id and active and role = r);
    if v_missing is null then continue; end if;
    for p in select * from players where team_id = t.id and active and role is null order by random() loop
      exit when array_length(v_missing, 1) is null;
      update players set role = v_missing[1] where id = p.id;
      v_missing := v_missing[2:]; v_any := true;
    end loop;
    if v_any then perform _ping_team(t.id, 'roles'); end if;
  end loop;
  return v_any;
end $$;

-- check-in with the map number and the squad PIN (no squad number to type)
create or replace function join_flight(p_event_code text, p_map int, p_pin text, p_name text, p_consent boolean, p_rules boolean, p_existing_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_num int; v_n int; v_any int;
begin
  select id into v_ev from events where code = upper(trim(coalesce(p_event_code, '')));
  if v_ev is null then return join_team(p_event_code, 1, p_pin, p_name, p_consent, p_rules, p_existing_token); end if;
  if (select count(*) from pin_failures where event_id = v_ev and team_number = -p_map and at > now() - interval '5 minutes') >= 30 then
    raise exception 'LOCKED_OUT';
  end if;
  select count(*), min(t.number) into v_n, v_num from teams t join arenas a on a.id = t.arena_id
  where t.event_id = v_ev and a.number = p_map and t.pin_hash = _hash(t.pin_salt || coalesce(p_pin, ''));
  if v_n > 1 then return jsonb_build_object('error', 'PIN_AMBIGUOUS'); end if;
  if v_n = 0 then
    select min(t.number) into v_any from teams t join arenas a on a.id = t.arena_id where t.event_id = v_ev and a.number = p_map;
    if v_any is null then return jsonb_build_object('error', 'BAD_MAP'); end if;
    -- wrong PINs are counted per map (a PIN is checked against all 15 squads at once)
    insert into pin_failures(event_id, team_number) values (v_ev, -p_map);
    return jsonb_build_object('error', 'BAD_PIN');
  end if;
  return join_team(p_event_code, v_num, p_pin, p_name, p_consent, p_rules, p_existing_token);
end $$;

-- ── 3. live gunfights ───────────────────────────────────────────────────────
create or replace function _weapon(p_team uuid) returns jsonb
language sql stable as $$
  select case
    when exists (select 1 from inventory where team_id = p_team and item_id = 'sniper' and qty > 0)
      then '{"id":"sniper","name":"Sniper","dmg":16,"range":0.11,"rate":1700,"mag":5,"reload":2600}'::jsonb
    when exists (select 1 from inventory where team_id = p_team and item_id = 'smg' and qty > 0)
      then '{"id":"smg","name":"SMG","dmg":2,"range":0.04,"rate":260,"mag":30,"reload":2000}'::jsonb
    else '{"id":"pistol","name":"Pistol","dmg":3,"range":0.055,"rate":650,"mag":12,"reload":1600}'::jsonb end
$$;

-- is there a building between two outdoor points? (cover)
drop function if exists _blocked(float8, float8, float8, float8);
create or replace function _blocked(p_ax float8, p_ay float8, p_bx float8, p_by float8) returns boolean
language plpgsql stable as $$
declare b buildings; k int; f float8; px float8; py float8;
begin
  for b in select * from buildings bb
           where greatest(p_ax, p_bx) >= bb.x0 and least(p_ax, p_bx) <= bb.x1 and greatest(p_ay, p_by) >= bb.y0 and least(p_ay, p_by) <= bb.y1 loop
    -- skip the building either squad stands in or against
    continue when (p_ax between b.x0 - 0.002 and b.x1 + 0.002 and p_ay between b.y0 - 0.002 and b.y1 + 0.002)
               or (p_bx between b.x0 - 0.002 and b.x1 + 0.002 and p_by between b.y0 - 0.002 and b.y1 + 0.002);
    for k in 1..15 loop
      f := k / 16.0; px := p_ax + (p_bx - p_ax) * f; py := p_ay + (p_by - p_ay) * f;
      if px between b.x0 and b.x1 and py between b.y0 and b.y1 then return true; end if;
    end loop;
  end loop;
  return false;
end $$;

create or replace function squad_fire(p_token text, p_target uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; d teams; a arenas; w jsonb; me float8[]; you float8[]; dist float8; v_hit boolean; v_crit boolean := false;
  v_dmg int := 0; v_dealt int; v_knock boolean := false; v_mag int; v_rel timestamptz; v_chance float8; v_loot int;
begin
  p := _auth_player(p_token);
  if p.role is null then raise exception 'NO_ROLE'; end if;
  select * into t from teams where id = p.team_id;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' or a.paused then raise exception 'NO_FIGHTS_NOW'; end if;
  if coalesce(a.match_phase, 0) < _cfg(t.event_id, 'fire_from_phase') then raise exception 'NO_FIGHTS_YET'; end if;
  if not t.dropped or t.state in ('recovery', 'traveling') then raise exception 'BUSY'; end if;
  -- lock both squads in a fixed order, so two squads shooting each other never deadlock
  perform 1 from teams where id in (t.id, p_target) order by id for no key update;
  select * into t from teams where id = t.id;
  select * into d from teams where id = p_target;
  if d.id is null or d.arena_id <> t.arena_id or d.id = t.id or not d.ready then raise exception 'BAD_TARGET'; end if;
  if not d.dropped or d.state in ('recovery', 'traveling') then raise exception 'TARGET_DOWN'; end if;
  if d.protected_until is not null and d.protected_until > now() then raise exception 'TARGET_PROTECTED'; end if;
  if exists (select 1 from alliances al where al.status = 'active' and ((al.team_a = t.id and al.team_b = d.id) or (al.team_b = t.id and al.team_a = d.id))) then
    raise exception 'ALLY';
  end if;
  if d.level <> t.level or (t.level > 0 and d.bldg is distinct from t.bldg) then raise exception 'NO_LINE_OF_SIGHT'; end if;
  w := _weapon(t.id);
  me := _team_xy(t); you := _team_xy(d);
  dist := sqrt((me[1] - you[1]) ^ 2 + (me[2] - you[2]) ^ 2);
  if dist > (w ->> 'range')::float8 then raise exception 'OUT_OF_RANGE'; end if;
  if t.level = 0 and _blocked(me[1], me[2], you[1], you[2]) then raise exception 'NO_LINE_OF_SIGHT'; end if;
  -- fire rate and magazine, per player
  if p.reload_until is not null and p.reload_until > now() then raise exception 'RELOADING'; end if;
  if p.shot_at is not null and p.shot_at > now() - make_interval(secs => (w ->> 'rate')::float8 * 0.8 / 1000) then raise exception 'TOO_FAST'; end if;
  v_mag := coalesce(p.mag, (w ->> 'mag')::int);
  if v_mag > (w ->> 'mag')::int then v_mag := (w ->> 'mag')::int; end if;
  v_mag := v_mag - 1;
  if v_mag <= 0 then v_rel := now() + make_interval(secs => (w ->> 'reload')::float8 / 1000); v_mag := (w ->> 'mag')::int; end if;
  update players set shot_at = now(), mag = v_mag, reload_until = v_rel, last_seen_at = now() where id = p.id;
  -- shooting ends your own spawn protection
  update teams set protected_until = null, fight_at = now() where id = t.id and (protected_until is not null or fight_at is null or fight_at < now() - interval '3 seconds');
  -- hit chance: falls with distance, harder against a moving target
  v_chance := 0.88 - 0.4 * dist / (w ->> 'range')::float8
    - case when d.pos_at > now() - interval '1.5 seconds' and (abs(coalesce(d.vel_x, 0)) + abs(coalesce(d.vel_y, 0))) > 0.001 then 0.15 else 0 end
    - case when d.vehicle = 'in' then 0.05 else 0 end;
  v_hit := random() < v_chance;
  if v_hit then
    v_crit := random() < case when w ->> 'id' = 'sniper' then 0.3 else 0.12 end;
    v_dmg := (w ->> 'dmg')::int * case when v_crit then 2 else 1 end;
    v_dealt := _damage(d.id, v_dmg, 'gunfire', 'gf-' || gen_random_uuid()::text, 'Shot by Squad ' || t.number);
    select * into d from teams where id = d.id;
    v_knock := d.state = 'recovery';
    update teams set fight_at = now() where id = d.id;
    if v_knock then
      v_loot := least(40, greatest(0, d.coins / 3));
      if v_loot > 0 then perform _apply(d.id, 'looted', 0, -v_loot, 0, 0, 'loot-' || d.id || '-' || extract(epoch from d.recovery_deadline)::bigint, 'Looted by Squad ' || t.number); end if;
      perform _apply(t.id, 'knockout', _cfg(t.event_id, 'kill_points'), _cfg(t.event_id, 'kill_coins') + v_loot, 0, 0,
        'ko-' || d.id || '-' || extract(epoch from d.recovery_deadline)::bigint, 'Knocked out Squad ' || d.number);
      update teams set kills = kills + 1 where id = t.id;
      perform _feed(a.id, 'squad.knocked', jsonb_build_object('team', d.number, 'by', t.number, 'weapon', w ->> 'id', 'shooter', p.display_name));
      perform _ping_arena(a.id, 'knock');
    end if;
    perform _ping_team(d.id, 'hit');
  end if;
  -- one feed line per pair of squads per half minute
  if not exists (select 1 from game_feed f where f.arena_id = a.id and f.type = 'squad.gunfight' and f.at > now() - interval '30 seconds'
                 and ((f.payload ->> 'a')::int in (t.number, d.number)) and ((f.payload ->> 'b')::int in (t.number, d.number))) then
    perform _feed(a.id, 'squad.gunfight', jsonb_build_object('a', t.number, 'b', d.number, 'location', coalesce(t.location_id, d.location_id)));
  end if;
  return jsonb_build_object('hit', v_hit, 'crit', v_crit, 'dmg', v_dmg, 'knocked', v_knock, 'target_hp', d.hp, 'target_shield', d.shield,
    'weapon', w, 'mag', v_mag, 'reload_until', v_rel, 'from', to_jsonb(me), 'to', to_jsonb(you));
end $$;

-- ── state for the phones and the big screen ─────────────────────────────────
create or replace function _team_extra(t teams) returns jsonb
language sql stable as $$
  select jsonb_build_object('vehicle', t.vehicle, 'kills', t.kills,
    'buggy', case when t.buggy_x is not null and t.vehicle <> 'in' then jsonb_build_array(t.buggy_x, t.buggy_y)
                  when t.dropped and t.vehicle = 'none' and t.state <> 'traveling' then to_jsonb(_buggy_bay(t.number, (_team_xy(t))[1], (_team_xy(t))[2])) end,
    'in_plane', not t.dropped and t.state <> 'traveling', 'parachute', not t.dropped and t.state = 'traveling',
    'weapon', _weapon(t.id), 'fight_at', t.fight_at,
    'land_at', case when not t.dropped and t.state = 'traveling' then t.travel_arrive_at end)
$$;

drop function if exists _player_state_v5(text);
alter function player_state(text) rename to _player_state_v5;
create function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; p players; t teams; a arenas; w jsonb;
begin
  v := _player_state_v5(p_token);
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  select * into a from arenas where id = t.arena_id;
  w := _weapon(t.id);
  v := jsonb_set(v, '{team}', (v -> 'team') || _team_extra(t));
  v := jsonb_set(v, '{me}', (v -> 'me') || jsonb_build_object('mag', coalesce(least(p.mag, (w ->> 'mag')::int), (w ->> 'mag')::int),
    'reload_until', case when p.reload_until > now() then p.reload_until end,
    'seat', lpad(t.number::text, 2, '0') || chr(65 + greatest(0, (select count(*)::int from players q where q.team_id = t.id and q.joined_at < p.joined_at)) % 6)));
  return v;
end $$;

drop function if exists _spectator_state_v5(text);
alter function spectator_state(text) rename to _spectator_state_v5;
create function spectator_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_arena uuid;
begin
  v := _spectator_state_v5(p_token);
  select id into v_arena from arenas where spectator_token = p_token;
  if v_arena is null or v -> 'squads' is null then return v; end if;
  return jsonb_set(v, '{squads}', (select coalesce(jsonb_agg(s || coalesce((select _team_extra(t) from teams t where t.arena_id = v_arena and t.number = (s ->> 'number')::int), '{}'::jsonb)), '[]'::jsonb)
                                   from jsonb_array_elements(v -> 'squads') s));
end $$;

create or replace function arena_positions(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; v_scan boolean;
begin
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  if exists (select 1 from bots where arena_id = t.arena_id) then perform _tick(t.arena_id); end if;
  v_scan := t.scan_until is not null and t.scan_until > now();
  return jsonb_build_object('server_now', now(), 'squads', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', tm.id, 'n', tm.number, 'level', tm.level, 'bldg', tm.bldg, 'state', tm.state,
      'pos', to_jsonb(_team_xy(tm)),
      'age', case when tm.state = 'idle' and tm.pos_at is not null then round(extract(epoch from now() - tm.pos_at)::numeric, 2) end,
      'vel', case when tm.state = 'traveling' and tm.travel_arrive_at > now() and l.id is not null then
               jsonb_build_array((l.x - coalesce(tm.travel_fx, l.x)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)),
                                 (l.y - coalesce(tm.travel_fy, l.y)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)))
             when tm.state = 'idle' and tm.pos_at > now() - interval '3 seconds' and (tm.vel_x <> 0 or tm.vel_y <> 0)
               then jsonb_build_array(tm.vel_x, tm.vel_y) end,
      'hp', tm.hp, 'shield', tm.shield, 'veh', tm.vehicle,
      'buggy', case when tm.buggy_x is not null and tm.vehicle = 'parked' then jsonb_build_array(tm.buggy_x, tm.buggy_y) end,
      'plane', not tm.dropped and tm.state <> 'traveling', 'chute', not tm.dropped and tm.state = 'traveling',
      'land_at', case when not tm.dropped and tm.state = 'traveling' then tm.travel_arrive_at end,
      'fight', tm.fight_at > now() - interval '4 seconds')), '[]'::jsonb)
    from teams tm left join locations l on l.id = tm.travel_to
    where tm.arena_id = t.arena_id and tm.ready
      and (tm.id = t.id or v_scan or tm.location_id = t.location_id or tm.jammed_until is null or tm.jammed_until < now()
           or tm.fight_at > now() - interval '4 seconds'
           or exists (select 1 from alliances al where al.status = 'active'
                      and ((al.team_a = t.id and al.team_b = tm.id) or (al.team_b = t.id and al.team_a = tm.id))))));
end $$;

-- ── the clock: flight, roles, plane, landing, auto-jump ─────────────────────
create or replace function _br_step(p_arena uuid) returns boolean
language plpgsql as $$
declare a arenas; r record; pl float8[]; v_loc text; c float8[]; v_changed boolean := false; xy float8[];
begin
  select * into a from arenas where id = p_arena;
  if a.id is null then return false; end if;
  -- the flight: publish take-off and landing times for the cabin view; roles at take-off
  if a.phase = 'shuttle' and (a.overlay -> 'flight' ->> 't1') is distinct from to_jsonb(a.shuttle_arrive_at) #>> '{}' then
    update arenas set overlay = overlay || jsonb_build_object('flight', jsonb_build_object(
      't0', a.shuttle_arrive_at - _secs(_cfg(a.event_id, 'shuttle_seconds')), 't1', a.shuttle_arrive_at)) where id = p_arena;
    v_changed := true;
  end if;
  if a.phase in ('shuttle', 'roles') then
    if _auto_roles(p_arena) then v_changed := true; end if;
  end if;
  -- a reset map (back in the lobby) forgets the last plane, wall and buggies
  if a.phase in ('lobby', 'boarding') and (a.plane_t0 is not null or a.zone_shrink_until is not null or a.overlay ? 'plane') then
    update arenas set plane_t0 = null, plane_t1 = null, zone_shrink_from = null, zone_shrink_until = null,
      overlay = overlay - 'plane' - 'flight' where id = p_arena;
    update teams set vehicle = 'none', buggy_x = null, buggy_y = null, kills = 0, fight_at = null where arena_id = p_arena;
    v_changed := true;
  end if;
  if a.phase = 'play' and _cfg(a.event_id, 'br_mode') = 1 and (a.plane_t0 is null or a.plane_t1 < a.play_started_at) then
    perform _plane_launch(p_arena); v_changed := true;
    select * into a from arenas where id = p_arena;
  end if;
  if a.phase = 'play' then
    -- landings: the squad stands where its parachute came down; its buggy waits in the nearest parking yard
    for r in select t.id, t.number, l.x, l.y from teams t join locations l on l.id = t.travel_to
             where t.arena_id = p_arena and not t.dropped and t.state = 'traveling' and t.travel_arrive_at <= now() loop
      xy := _buggy_bay(r.number, r.x, r.y);
      update teams set pos_x = r.x + ((r.number * 37) % 9 - 4) * 0.0012, pos_y = r.y + ((r.number * 53) % 9 - 4) * 0.0012, pos_at = now(),
        vel_x = 0, vel_y = 0, vehicle = case when _cfg(a.event_id, 'br_mode') = 1 then 'none' else 'in' end, buggy_x = xy[1], buggy_y = xy[2]
      where id = r.id;
    end loop;
    -- other arrivals (tap-to-run) end where they were going
    update teams t set pos_x = l.x, pos_y = l.y, pos_at = now()
    from locations l where l.id = t.travel_to and t.arena_id = p_arena and t.dropped and t.state = 'traveling' and t.travel_arrive_at <= now();
    -- the plane is about to leave the campus: everyone still on board jumps
    pl := _plane_xy(a);
    if pl is not null and pl[3] >= 0.8 then
      c := _zone_circle(a.event_id, a.zone_stage);
      for r in select id from teams where arena_id = p_arena and ready and not dropped and state = 'idle' loop
        select l.id into v_loc from locations l
        where l.enabled and l.kind not in ('start', 'stairs') and l.level = 0 and _in_circle(c, l.x, l.y)
        order by (l.x - least(0.95, greatest(0.05, pl[1]))) ^ 2 + (l.y - least(0.95, greatest(0.05, pl[2]))) ^ 2 + random() * 0.004 limit 1;
        if v_loc is not null then
          perform _do_jump(r.id, v_loc, array[least(0.98, greatest(0.02, pl[1])), least(0.98, greatest(0.02, pl[2]))]);
          v_changed := true;
        end if;
      end loop;
    end if;
  end if;
  -- the moving zone wall
  if a.zone_shrink_until is not null and a.zone_shrink_until > now() - interval '3 seconds'
     and (a.overlay -> 'zone' ->> 'shrink_until') is null and a.zone_shrink_until > now() then
    perform _zone_publish(p_arena); v_changed := true;
  end if;
  if a.zone_shrink_until is not null and a.zone_shrink_until <= now() and (a.overlay -> 'zone' ->> 'shrink_until') is not null then
    perform _zone_publish(p_arena); v_changed := true;
  end if;
  return v_changed;
end $$;

create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare v boolean; w boolean;
begin
  w := _br_step(p_arena);
  v := _tick_core(p_arena, p_force);
  if _br_step(p_arena) or w then v := true; perform _ping_arena(p_arena, 'tick'); end if;
  if exists (select 1 from bots where arena_id = p_arena) then
    if _bots_step(p_arena) then v := true; end if;
  end if;
  return v;
end $$;

-- ── dummy squads (demo mode) follow the new rules ──
create or replace function _bot_act(p_team uuid) returns void
language plpgsql as $$
declare t teams; b bots; a arenas; mi mission_instances; g locations; bd buildings; lk record;
  tok text; cur float8[]; c float8[]; spd float8; dt float8; stepd float8; tx float8; ty float8; d float8; nx float8; ny float8;
  v_dir int := 0; v_goal text; v_res jsonb; v_target uuid; v_weapon text; v_air uuid; v_danger boolean := false; v_brave boolean;
  v_final boolean := false; v_px float8; v_py float8; v_side int; pl float8[]; w jsonb; v_tok2 text;
begin
  select * into t from teams where id = p_team;
  select * into b from bots where team_id = p_team;
  select * into a from arenas where id = t.arena_id;
  select bp.token into tok from bot_players bp join players p on p.id = bp.player_id
  where bp.team_id = t.id and p.active and p.role = 'captain' limit 1;
  if tok is null then return; end if;
  v_brave := t.number % 3 = 0;
  cur := _team_xy(t);

  -- a lockdown alarm on the place the squad is in: most dummies run, a few gamble and stay
  select k.* into lk from lockdowns k
  where k.arena_id = a.id and not k.sealed and k.seal_at < now() + interval '14 seconds'
    and (k.level is null or k.level = t.level)
    and (k.building = t.bldg or (t.level = 0 and exists (select 1 from buildings bb where bb.id = k.building
         and cur[1] between bb.x0 and bb.x1 and cur[2] between bb.y0 and bb.y1)))
  limit 1;
  v_danger := lk.building is not null and not v_brave;

  -- 1. an open challenge: think for a while, then answer (battles first)
  select * into mi from mission_instances where team_id = t.id and status = 'active'
  order by (kind = 'battle') desc, started_at desc limit 1;
  if mi.id is not null and not (v_danger and mi.kind in ('mission', 'relay', 'airdrop') and mi.sync_round_id is null) then
    if b.think_for is distinct from mi.id then
      update bots set think_for = mi.id, think_ok = random() < b.skill,
        think_until = now() + _secs((case when mi.kind = 'battle' then 9 + random() * 16
                                          when mi.sync_round_id is not null then 12 + random() * 26
                                          when mi.kind = 'recovery' then 8 + random() * 10
                                          else 14 + random() * 24 end)::numeric)
      where team_id = t.id;
      return;
    end if;
    if now() < b.think_until or mi.deadline <= now() then return; end if;
    perform captain_submit(tok, mi.id, _bot_answers(mi, coalesce(b.think_ok, true)), 'bot-' || gen_random_uuid()::text);
    if not coalesce(b.think_ok, true) then
      update bots set think_until = now() + _secs((5 + random() * 9)::numeric), think_ok = random() < 0.6 where team_id = t.id;
    end if;
    return;
  end if;

  if a.phase <> 'play' or t.state in ('recovery', 'traveling') then return; end if;

  -- 2. jump from the plane at different moments, somewhere within gliding range
  if not t.dropped then
    if t.state = 'traveling' then return; end if;
    pl := _plane_xy(a);
    if pl is null or pl[1] not between 0.04 and 0.96 or pl[2] not between 0.04 and 0.96 or random() > 0.14 then return; end if;
    c := _zone_circle(a.event_id, a.zone_stage);
    select l.id into v_goal from locations l
    where l.enabled and l.kind not in ('start', 'stairs') and l.level = 0 and _in_circle(c, l.x, l.y)
      and sqrt((l.x - pl[1]) ^ 2 + (l.y - pl[2]) ^ 2) < _cfg(t.event_id, 'glide_range') / 1000.0 * 0.9
    order by random() limit 1;
    if v_goal is not null then perform captain_move(tok, v_goal); end if;
    update bots set goal = null, done_loc = null, wait_until = null where team_id = t.id;
    return;
  end if;

  -- 3. patch up
  if t.hp <= 55 and exists (select 1 from inventory where team_id = t.id and item_id = 'medkit' and qty > 0) then
    begin perform captain_use_item(tok, 'medkit'); exception when others then null; end;
  end if;

  if b.wait_until is not null and now() < b.wait_until and not v_danger then return; end if;

  -- 4. gunfight: every member shoots at the nearest rival in range and in sight
  if coalesce(a.match_phase, 0) >= _cfg(t.event_id, 'fire_from_phase') then
    w := _weapon(t.id);
    select x.id into v_target from teams x
    where x.arena_id = a.id and x.ready and x.id <> t.id and x.dropped and x.state not in ('recovery', 'traveling')
      and x.level = t.level and (t.level = 0 or x.bldg is not distinct from t.bldg)
      and (x.protected_until is null or x.protected_until < now())
      and sqrt(((_team_xy(x))[1] - cur[1]) ^ 2 + ((_team_xy(x))[2] - cur[2]) ^ 2) <= (w ->> 'range')::float8
      and (t.level > 0 or not _blocked(cur[1], cur[2], (_team_xy(x))[1], (_team_xy(x))[2]))
    order by ((_team_xy(x))[1] - cur[1]) ^ 2 + ((_team_xy(x))[2] - cur[2]) ^ 2 limit 1;
    if v_target is not null then
      for v_tok2 in select bp.token from bot_players bp join players q on q.id = bp.player_id where bp.team_id = t.id and q.active and q.role is not null loop
        if random() < 0.45 then
          begin perform squad_fire(v_tok2, v_target); exception when others then null; end;
        end if;
      end loop;
      -- stand and fight while healthy; low on HP, keep moving
      if t.hp > 35 and not v_danger then return; end if;
    end if;
  end if;

  -- 5. a crate or vault right here
  if not v_danger and t.location_id is not null and b.goal is null then
    select ad.id into v_air from airdrops ad where ad.arena_id = a.id and ad.status = 'open' and ad.location_id = t.location_id
      and not exists (select 1 from mission_instances m where m.team_id = t.id and m.airdrop_id = ad.id) limit 1;
    if v_air is not null then
      begin
        perform captain_claim_airdrop(tok, v_air);
        return;
      exception when others then null;
      end;
    end if;
  end if;

  -- 6. search the place it just reached
  if not v_danger and b.goal is null and t.location_id is not null and t.location_id is distinct from b.done_loc
     and (select kind from locations where id = t.location_id) not in ('start', 'stairs')
     and t.visit_missions < _cfg(t.event_id, 'visit_missions') then
    update bots set done_loc = t.location_id where team_id = t.id;
    begin
      perform captain_explore(tok);
      return;
    exception when others then null;
    end;
  end if;

  -- 7. choose where to go next: inside the (next) safe circle, not sealed, crates and near places first
  c := _zone_circle(a.event_id, least(5, a.zone_stage + case when a.zone_next_at is not null then 1 else 0 end));
  select * into g from locations where id = b.goal;
  if g.id is null or v_danger or (b.goal_at is not null and b.goal_at < now() - interval '100 seconds')
     or not _in_circle(c, g.x, g.y)
     or (g.building is not null and (_sealed(a.id, g.building, g.level) or _sealed(a.id, g.building, 0))) then
    select l.id into v_goal from locations l
    where l.enabled and l.kind not in ('start', 'stairs') and l.id is distinct from t.location_id and l.id is distinct from b.done_loc
      and _in_circle(c, l.x, l.y)
      and (l.building is null or (not _sealed(a.id, l.building, l.level) and not _sealed(a.id, l.building, 0)
           and (v_brave or not exists (select 1 from lockdowns k where k.arena_id = a.id and not k.sealed and k.building = l.building
                                       and (k.level is null or k.level = l.level)))))
      and not (v_danger and l.building is not distinct from lk.building)
    order by (case when exists (select 1 from airdrops ad where ad.arena_id = a.id and ad.status = 'open' and ad.location_id = l.id) then 0.3 else 1 end)
           * (case when l.level > 0 then 1.5 else 1 end)
           * (0.012 + (l.x - cur[1]) ^ 2 + (l.y - cur[2]) ^ 2) * (0.2 + random())
    limit 1;
    if v_goal is null then
      select l.id into v_goal from locations l where l.enabled and l.kind not in ('start', 'stairs') and l.level = 0
      order by (l.x - coalesce(c[1], 0.5)) ^ 2 + (l.y - coalesce(c[2], 0.5)) ^ 2 limit 1;
    end if;
    update bots set goal = v_goal, goal_at = now() where team_id = t.id;
    select * into g from locations where id = v_goal;
    if g.id is null then return; end if;
  end if;

  -- 8. move: stairs first when the place is on another floor; back to the buggy before a long trip
  if t.level = 0 and t.vehicle <> 'in' and t.buggy_x is not null
     and (sqrt((g.x - cur[1]) ^ 2 + (g.y - cur[2]) ^ 2) > 0.08 or (g.building is null and sqrt((g.x - cur[1]) ^ 2 + (g.y - cur[2]) ^ 2) > 0.03))
     and sqrt((t.buggy_x - cur[1]) ^ 2 + (t.buggy_y - cur[2]) ^ 2) < 0.007 then
    begin perform captain_vehicle(tok, true); exception when others then null; end;
    return;
  end if;
  if t.level = 0 and t.vehicle <> 'in' and t.buggy_x is not null
     and (sqrt((g.x - cur[1]) ^ 2 + (g.y - cur[2]) ^ 2) > 0.08 or (g.building is null and sqrt((g.x - cur[1]) ^ 2 + (g.y - cur[2]) ^ 2) > 0.03)) then
    tx := t.buggy_x; ty := t.buggy_y;
  elsif t.level > 0 and (g.level = 0 or g.building is distinct from t.bldg or g.level <> t.level) then
    select * into bd from buildings where id = t.bldg;
    v_dir := case when g.building is not distinct from t.bldg and g.level > t.level then 1 else -1 end;
    tx := bd.stair_x; ty := bd.stair_y;
  elsif t.level = 0 and g.level > 0 then
    select * into bd from buildings where id = g.building;
    v_dir := 1; tx := bd.stair_x; ty := bd.stair_y;
  else
    -- squads spread out a little around a place instead of stacking on one spot
    tx := g.x + ((t.number * 37) % 9 - 4) * 0.0011; ty := g.y + ((t.number * 53) % 9 - 4) * 0.0011;
    v_final := true;
  end if;
  if tx is null then update bots set goal = null where team_id = t.id; return; end if;

  d := sqrt((tx - cur[1]) ^ 2 + (ty - cur[2]) ^ 2);
  if v_dir <> 0 and d < 0.012 then
    begin
      perform captain_stairs(tok, v_dir);
    exception when others then
      update bots set goal = null where team_id = t.id;
    end;
    return;
  end if;
  spd := _team_speed(t);
  dt := least(3.0, greatest(0.3, extract(epoch from now() - coalesce(t.pos_at, now() - interval '1 second'))));
  stepd := spd * dt;
  if d <= stepd then
    v_res := captain_steer(tok, tx, ty, 0, 0);
    if v_final then
      update bots set goal = null, wait_until = now() + _secs((1 + random() * 2)::numeric) where team_id = t.id;
    end if;
    return;
  end if;
  nx := cur[1] + (tx - cur[1]) * stepd / d; ny := cur[2] + (ty - cur[2]) * stepd / d;
  v_res := captain_steer(tok, nx, ny, (tx - cur[1]) / d * spd, (ty - cur[2]) / d * spd);
  if v_res ->> 'wall' is not null then
    -- a sealed building is in the way: slide along it
    v_side := case when t.number % 2 = 0 then 1 else -1 end;
    v_px := -(ty - cur[2]) / d * v_side; v_py := (tx - cur[1]) / d * v_side;
    v_res := captain_steer(tok, cur[1] + v_px * stepd, cur[2] + v_py * stepd, v_px * spd, v_py * spd);
    if v_res ->> 'wall' is not null then
      v_res := captain_steer(tok, cur[1] - v_px * stepd, cur[2] - v_py * stepd, -v_px * spd, -v_py * spd);
    end if;
  end if;
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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer', 'captain_reveal', 'captain_stairs', 'arena_positions',
        'host_fixed_cards', 'card_event', 'demo_create', 'host_extras', 'demo_view', 'demo_status', 'demo_control',
        'demo_pulse', 'demo_end', 'captain_vehicle', 'squad_fire', 'join_flight']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
