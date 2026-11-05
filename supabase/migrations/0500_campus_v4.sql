-- ════════════════════════════════════════════════════════════════════════════
-- 0500 — Operation Siruseri v4: a vast multi-storey campus and the Collapsing Campus
--   • Buildings with floors: rooms live on a storey (locations.level); squads climb the
--     stairwell (captain_stairs) to reach them. Training Room 14 is on Hexavarsity's top floor.
--   • Smooth movement: the captain's joystick velocity is stored with the position, so every
--     screen can glide squads between updates (teammates also get a direct realtime feed).
--   • Medkits, shields and coin stacks lie around the map; drive over them to pick them up.
--   • Failing challenges hurts: wrong answers and failed or expired challenges cost HP.
--   • Collapsing Campus (replaces Squad 00): floors and buildings seal one by one after an
--     alarm and a countdown. Squads caught inside take damage and are thrown out. Each
--     lockdown opens a vault crate inside the doomed building. In the finale every building
--     except Hexavarsity seals: Training Room 14 is the last open room.
-- Safe to re-run; keeps every event, squad and score.
-- ════════════════════════════════════════════════════════════════════════════

alter table locations add column if not exists level int not null default 0;

create table if not exists buildings (
  id text primary key,
  name text not null,
  x0 real not null, y0 real not null, x1 real not null, y1 real not null,
  floors int not null default 1,
  stair_x real, stair_y real, door_x real, door_y real,
  style text
);

alter table teams add column if not exists level int not null default 0;
alter table teams add column if not exists bldg text;
alter table teams add column if not exists vel_x real not null default 0;
alter table teams add column if not exists vel_y real not null default 0;
alter table arenas add column if not exists last_lock_at timestamptz;
alter table arenas add column if not exists last_pickup_at timestamptz;

create table if not exists pickups (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  kind text not null check (kind in ('medkit', 'shield', 'coins')),
  x real not null, y real not null,
  level int not null default 0,
  bldg text,
  taken_by uuid references teams(id) on delete set null,
  taken_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists pickups_open_idx on pickups(arena_id) where taken_at is null;

create table if not exists lockdowns (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  building text not null,
  level int,                          -- null = the whole building
  seal_at timestamptz not null,
  sealed boolean not null default false,
  sealed_at timestamptz,
  caught int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists lockdowns_arena_idx on lockdowns(arena_id);

alter table airdrops drop constraint if exists airdrops_tier_check;
alter table airdrops add constraint airdrops_tier_check check (tier in ('common','rare','legendary','mystery','cursed','intel','vault'));

do $$
declare t text;
begin
  foreach t in array array['buildings', 'pickups', 'lockdowns'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

-- the campus got three times bigger: world-scale settings fall back to the new defaults
update events set settings = settings - 'move_speed' - 'loc_radius' - 'engage_range' where settings ?| array['move_speed', 'loc_radius', 'engage_range'];

-- ── A squad's storey follows the place it is in (arrivals, respawns, extracts, finale…) ──
create or replace function _teams_level_sync() returns trigger language plpgsql as $$
declare l locations;
begin
  if new.location_id is not null and new.location_id is distinct from old.location_id then
    select * into l from locations where id = new.location_id;
    if l.id is not null and l.kind <> 'start' then
      new.level := coalesce(l.level, 0);
      new.bldg := case when coalesce(l.level, 0) > 0 then l.building end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists teams_level_sync on teams;
create trigger teams_level_sync before update of location_id on teams for each row execute function _teams_level_sync();

create or replace function _sealed(p_arena uuid, p_bldg text, p_level int) returns boolean language sql stable as $$
  select p_bldg is not null and exists (select 1 from lockdowns where arena_id = p_arena and building = p_bldg and sealed
                                        and (level is null or level = p_level))
$$;

-- ── Places ─────────────────────────────────────────────────────────────────────
-- The place a squad is standing in: same storey, same building upstairs, never a sealed area.
create or replace function _loc_at3(p_arena uuid, p_event uuid, p_x float8, p_y float8, p_level int, p_bldg text) returns text
language sql stable as $$
  select l.id from locations l
  where l.enabled and l.kind <> 'start' and l.level = coalesce(p_level, 0)
    and (coalesce(p_level, 0) = 0 or l.building = p_bldg)
    and (l.x - p_x) ^ 2 + (l.y - p_y) ^ 2 <= (_cfg(p_event, 'loc_radius') / 1000.0) ^ 2
    and not (l.building is not null and _sealed(p_arena, l.building, l.level))
  order by (l.x - p_x) ^ 2 + (l.y - p_y) ^ 2 limit 1
$$;

-- legacy two-coordinate lookup (ground floor only)
create or replace function _loc_at(p_event uuid, p_x float8, p_y float8) returns text language sql stable as $$
  select id from locations
  where enabled and kind not in ('start', 'stairs') and level = 0 and (x - p_x) ^ 2 + (y - p_y) ^ 2 <= (_cfg(p_event, 'loc_radius') / 1000.0) ^ 2
  order by (x - p_x) ^ 2 + (y - p_y) ^ 2 limit 1
$$;

-- respawns and extracts always land on open ground
create or replace function _nearest_safe_xy(p_event uuid, p_stage int, p_x float8, p_y float8) returns text
language sql stable as $$
  select id from locations
  where enabled and kind not in ('start', 'stairs') and level = 0 and _in_circle(_zone_circle(p_event, p_stage), x, y)
  order by _in_circle(_zone_circle(p_event, least(5, p_stage + 1)), x, y) desc,
           (x - p_x) ^ 2 + (y - p_y) ^ 2
  limit 1
$$;

-- ── Collapsing Campus ──────────────────────────────────────────────────────────


-- Order in which the campus collapses: farthest from Training Room 14 first; tall buildings
-- lose their top floors before the whole building goes. Hexavarsity never seals.
create or replace function _lock_targets() returns table(building text, level int) language plpgsql stable as $$
declare tr float8[]; b buildings;
begin
  tr := coalesce(_loc_xy('tr14'), array[0.47, 0.65]);
  for b in select * from buildings where id <> 'hexavarsity'
           order by ((x0 + x1) / 2 - tr[1]) ^ 2 + ((y0 + y1) / 2 - tr[2]) ^ 2 desc, id loop
    if b.floors >= 4 then building := b.id; level := b.floors - 1; return next; end if;
    if b.floors >= 5 then building := b.id; level := b.floors - 2; return next; end if;
    building := b.id; level := null; return next;
  end loop;
end $$;

create or replace function _lock_publish(p_arena uuid) returns void language plpgsql as $$
begin
  update arenas set overlay = overlay || jsonb_build_object('lock', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'b', l.building, 'n', b.name, 'l', l.level, 'at', l.seal_at, 'sealed', l.sealed, 'caught', l.caught)
                       order by l.created_at)
      from lockdowns l join buildings b on b.id = l.building where l.arena_id = p_arena), '[]'::jsonb))
  where id = p_arena;
end $$;

-- A locked vault crate (legendary-plus loot) inside a room; it disappears when the area seals.
create or replace function _spawn_vault(p_arena uuid, p_location text, p_expires timestamptz) returns uuid
language plpgsql as $$
declare v_tpl text; v_id uuid;
begin
  select id into v_tpl from mission_templates where kind = 'airdrop' and status = 'published'
    and id not in (select template_id from airdrops where arena_id = p_arena) order by random() limit 1;
  if v_tpl is null then
    select id into v_tpl from mission_templates where kind = 'airdrop' and status = 'published' order by random() limit 1;
  end if;
  if v_tpl is null then return null; end if;
  insert into airdrops(arena_id, location_id, tier, template_id, expires_at) values (p_arena, p_location, 'vault', v_tpl, p_expires)
  returning id into v_id;
  perform _feed(p_arena, 'vault.opened', jsonb_build_object('location', p_location));
  return v_id;
end $$;

-- Sound the alarm on the next floor/building (or a chosen one). It seals after lock_warning seconds.
create or replace function _lock_next(p_arena uuid, p_building text default null, p_level int default null) returns uuid
language plpgsql as $$
declare a arenas; v_b text; v_l int; v_id uuid; bb buildings; v_room text; v_warn int;
begin
  select * into a from arenas where id = p_arena;
  if p_building is not null then
    v_b := p_building; v_l := p_level;
  else
    select t.building, t.level into v_b, v_l from _lock_targets() t
    where not exists (select 1 from lockdowns l where l.arena_id = p_arena and l.building = t.building
                      and (l.level is null or l.level is not distinct from t.level))
    limit 1;
  end if;
  if v_b is null then return null; end if;
  if v_b = 'hexavarsity' then raise exception 'HEXAVARSITY_NEVER_SEALS'; end if;
  select * into bb from buildings where id = v_b;
  if bb.id is null then raise exception 'BAD_BUILDING'; end if;
  if v_l is not null and (v_l < 0 or v_l >= bb.floors) then raise exception 'NO_FLOOR'; end if;
  if exists (select 1 from lockdowns l where l.arena_id = p_arena and l.building = v_b and (l.level is null or l.level is not distinct from v_l)) then
    return null;
  end if;
  v_warn := greatest(10, _cfg(a.event_id, 'lock_warning'));
  insert into lockdowns(arena_id, building, level, seal_at) values (p_arena, v_b, v_l, now() + _secs(v_warn)) returning id into v_id;
  update arenas set last_lock_at = now() where id = p_arena;
  -- risk and reward: a vault opens inside the doomed area
  select l.id into v_room from locations l
  where l.enabled and l.building = v_b and l.kind not in ('stairs', 'start') and (v_l is null or l.level = v_l)
    and not exists (select 1 from airdrops ad where ad.arena_id = p_arena and ad.location_id = l.id and ad.status = 'open')
  order by l.level desc, random() limit 1;
  if v_room is not null then perform _spawn_vault(p_arena, v_room, now() + _secs(v_warn)); end if;
  perform _feed(p_arena, 'lockdown.warning', jsonb_build_object('building', v_b, 'name', bb.name, 'level', v_l, 'seconds', v_warn, 'vault', v_room));
  perform _lock_publish(p_arena);
  return v_id;
end $$;

-- Doors shut: everyone inside takes damage and is thrown out through the front door.
create or replace function _lock_seal(p_lock uuid) returns void
language plpgsql as $$
declare l lockdowns; a arenas; b buildings; tm teams; xy float8[]; v_inside boolean; v_heading boolean; v_nums int[] := '{}';
begin
  select * into l from lockdowns where id = p_lock for update;
  if l.id is null or l.sealed then return; end if;
  select * into a from arenas where id = l.arena_id;
  select * into b from buildings where id = l.building;
  update lockdowns set sealed = true, sealed_at = now() where id = l.id;
  for tm in select * from teams where arena_id = l.arena_id and ready loop
    xy := _team_xy(tm);
    if l.level is null then
      v_inside := (tm.level > 0 and tm.bldg = b.id) or (tm.level = 0 and tm.state <> 'traveling' and xy[1] between b.x0 and b.x1 and xy[2] between b.y0 and b.y1);
      v_heading := tm.state = 'traveling' and exists (select 1 from locations where id = tm.travel_to and building = b.id);
    else
      v_inside := tm.level = l.level and tm.bldg = b.id;
      v_heading := tm.state = 'traveling' and exists (select 1 from locations where id = tm.travel_to and building = b.id and level = l.level);
    end if;
    if v_inside then
      update mission_instances set status = 'cancelled'
      where team_id = tm.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
      update teams set level = 0, bldg = null, pos_x = b.door_x, pos_y = b.door_y, pos_at = now(), vel_x = 0, vel_y = 0,
        location_id = null, visit_missions = 0
      where id = tm.id;
      perform _damage(tm.id, _cfg(a.event_id, 'lock_damage'), 'lockdown', l.id::text, 'Caught inside a lockdown');
      v_nums := v_nums || tm.number;
      perform _ping_team(tm.id, 'lockdown');
    elsif v_heading then
      -- running toward a door that just shut: stop where you are
      update teams set state = 'idle', pos_x = xy[1], pos_y = xy[2], pos_at = now(), vel_x = 0, vel_y = 0,
        travel_to = null, travel_from = null, travel_started_at = null, travel_arrive_at = null, travel_fx = null, travel_fy = null
      where id = tm.id;
      perform _ping_team(tm.id, 'lockdown');
    end if;
  end loop;
  update lockdowns set caught = coalesce(array_length(v_nums, 1), 0) where id = l.id;
  delete from pickups where arena_id = l.arena_id and taken_at is null
    and ((bldg = b.id and (l.level is null or level = l.level))
         or (l.level is null and level = 0 and x between b.x0 and b.x1 and y between b.y0 and b.y1));
  update airdrops set status = 'expired' where arena_id = l.arena_id and status = 'open'
    and location_id in (select id from locations where building = b.id and (l.level is null or level = l.level));
  update mission_instances mi set status = 'cancelled' from airdrops ad
  where mi.airdrop_id = ad.id and ad.status = 'expired' and mi.status = 'active';
  perform _feed(l.arena_id, 'lockdown.sealed', jsonb_build_object('building', b.id, 'name', b.name, 'level', l.level, 'caught', to_jsonb(v_nums)));
  perform _lock_publish(l.arena_id);
end $$;

-- Finale: every building except Hexavarsity seals at once. Training Room 14 is the last open room.
create or replace function _final_lockdown(p_arena uuid) returns void
language plpgsql as $$
declare r record;
begin
  for r in select id from buildings where id <> 'hexavarsity' loop
    if not exists (select 1 from lockdowns where arena_id = p_arena and building = r.id and level is null) then
      insert into lockdowns(arena_id, building, level, seal_at) values (p_arena, r.id, null, now());
    end if;
  end loop;
  for r in select id from lockdowns where arena_id = p_arena and not sealed loop
    perform _lock_seal(r.id);
  end loop;
  update arenas set finale_stage = 'D' where id = p_arena and phase = 'finale';
  if not exists (select 1 from story_events where arena_id = p_arena and kind = 'reveal') then
    insert into story_events(arena_id, kind, title, body) values (p_arena, 'reveal', 'Final lockdown',
      'Every building on campus is sealed except Hexavarsity. Training Room 14 is the last open room.');
  end if;
  perform _feed(p_arena, 'lockdown.final', '{}'::jsonb);
  perform _lock_publish(p_arena);
end $$;

-- ── Loot on the ground ─────────────────────────────────────────────────────────
create or replace function _spawn_pickups(p_arena uuid) returns int
language plpgsql as $$
declare a arenas; k text; v_want int; v_have int; v_n int := 0; l locations; b buildings; ang float8; rad float8; px float8; py float8; v_try int;
begin
  select * into a from arenas where id = p_arena;
  foreach k in array array['medkit', 'shield', 'coins'] loop
    v_want := coalesce(_cfg(a.event_id, 'pickup_' || k), 0);
    select count(*) into v_have from pickups where arena_id = p_arena and taken_at is null and kind = k;
    v_try := 0;
    while v_have < v_want and v_try < v_want * 3 loop
      v_try := v_try + 1;
      select * into l from locations loc where loc.enabled and loc.kind not in ('start', 'stairs')
        and not (loc.building is not null and _sealed(p_arena, loc.building, loc.level))
      order by random() limit 1;
      exit when l.id is null;
      ang := random() * 2 * pi(); rad := 0.008 + random() * 0.014;
      px := l.x + cos(ang) * rad; py := l.y + sin(ang) * rad;
      if l.level > 0 then
        select * into b from buildings where id = l.building;
        px := greatest(b.x0 + 0.006, least(b.x1 - 0.006, px)); py := greatest(b.y0 + 0.006, least(b.y1 - 0.006, py));
      end if;
      insert into pickups(arena_id, kind, x, y, level, bldg)
      values (p_arena, k, greatest(0.02, least(0.98, px)), greatest(0.02, least(0.98, py)), l.level, case when l.level > 0 then l.building end);
      v_have := v_have + 1; v_n := v_n + 1;
    end loop;
  end loop;
  update arenas set last_pickup_at = now() where id = p_arena;
  return v_n;
end $$;

-- Driving over loot picks it up (called by captain_steer). Returns the kinds taken, or null.
create or replace function _take_pickups(p_team uuid, p_x float8, p_y float8) returns jsonb
language plpgsql as $$
declare t teams; pk pickups; v_out jsonb := '[]'::jsonb; v_med int;
begin
  select * into t from teams where id = p_team;
  for pk in select * from pickups where arena_id = t.arena_id and taken_at is null and level = t.level
              and (x - p_x) ^ 2 + (y - p_y) ^ 2 <= 0.013 ^ 2 for update skip locked loop
    select coalesce(qty, 0) into v_med from inventory where team_id = t.id and item_id = 'medkit';
    if pk.kind = 'medkit' and coalesce(v_med, 0) >= 5 then continue; end if;
    if pk.kind = 'shield' and t.shield >= _cfg(t.event_id, 'shield_max') then continue; end if;
    update pickups set taken_by = t.id, taken_at = now() where id = pk.id;
    if pk.kind = 'medkit' then
      perform _add_item(t.id, 'medkit', 1);
    elsif pk.kind = 'shield' then
      update teams set shield = least(_cfg(t.event_id, 'shield_max'), shield + 20) where id = t.id returning * into t;
    else
      perform _apply(t.id, 'pickup', 0, 15, 0, 0, pk.id::text, 'Picked up a coin stack');
    end if;
    v_out := v_out || jsonb_build_array(pk.kind);
  end loop;
  if jsonb_array_length(v_out) = 0 then return null; end if;
  perform _ping_arena(t.arena_id, 'pickup');
  return v_out;
end $$;

-- ── Stairs ─────────────────────────────────────────────────────────────────────
create or replace function captain_stairs(p_token text, p_dir int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; b buildings; cur float8[]; v_new int; v_loc text;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state in ('recovery', 'traveling') then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  if p_dir is null or p_dir not in (-1, 1) then raise exception 'BAD_REQUEST'; end if;
  cur := _team_xy(t);
  if t.level > 0 then
    select * into b from buildings where id = t.bldg;
  else
    select * into b from buildings where floors > 1 order by (stair_x - cur[1]) ^ 2 + (stair_y - cur[2]) ^ 2 limit 1;
  end if;
  if b.id is null or (b.stair_x - cur[1]) ^ 2 + (b.stair_y - cur[2]) ^ 2 > 0.018 ^ 2 then raise exception 'NOT_AT_STAIRS'; end if;
  v_new := t.level + p_dir;
  if v_new < 0 or v_new >= b.floors then raise exception 'NO_FLOOR'; end if;
  if _sealed(t.arena_id, b.id, v_new) then raise exception 'SEALED'; end if;
  update mission_instances set status = 'cancelled'
  where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
  v_loc := _loc_at3(t.arena_id, t.event_id, b.stair_x, b.stair_y, v_new, b.id);
  update teams set level = v_new, bldg = case when v_new > 0 then b.id end, pos_x = b.stair_x, pos_y = b.stair_y, pos_at = now(),
    vel_x = 0, vel_y = 0, location_id = v_loc, visit_missions = 0, dropped = true, state = 'idle'
  where id = t.id;
  perform _ping_team(t.id, 'stairs');
  return jsonb_build_object('level', v_new, 'building', b.id, 'location', v_loc, 'x', b.stair_x, 'y', b.stair_y);
end $$;

-- ── Positions only (cheap, for smooth rival movement between full refreshes) ──
create or replace function arena_positions(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; v_scan boolean;
begin
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  v_scan := t.scan_until is not null and t.scan_until > now();
  return jsonb_build_object('server_now', now(), 'squads', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', tm.id, 'level', tm.level, 'bldg', tm.bldg, 'state', tm.state,
      'pos', to_jsonb(_team_xy(tm)),
      'vel', case when tm.state = 'traveling' and tm.travel_arrive_at > now() and l.id is not null then
               jsonb_build_array((l.x - coalesce(tm.travel_fx, l.x)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)),
                                 (l.y - coalesce(tm.travel_fy, l.y)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)))
             when tm.state = 'idle' and tm.pos_at > now() - interval '1500 milliseconds' then jsonb_build_array(tm.vel_x, tm.vel_y) end)), '[]'::jsonb)
    from teams tm left join locations l on l.id = tm.travel_to
    where tm.arena_id = t.arena_id and tm.ready
      and (tm.id = t.id or v_scan or tm.location_id = t.location_id or tm.jammed_until is null or tm.jammed_until < now()
           or exists (select 1 from alliances al where al.status = 'active'
                      and ((al.team_a = t.id and al.team_b = tm.id) or (al.team_b = t.id and al.team_a = tm.id))))));
end $$;

create or replace function _spawn_start_vaults(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; r record;
begin
  select * into a from arenas where id = p_arena;
  for r in select l.id from locations l
           where l.enabled and l.level >= 2 and l.kind = 'room' and l.building <> 'hexavarsity'
           order by random() limit greatest(0, coalesce(_cfg(a.event_id, 'vaults'), 2)) loop
    perform _spawn_vault(p_arena, r.id, now() + interval '40 minutes');
  end loop;
end $$;

create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 20, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 0,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0,
  'auto_pacing', 0, 'phase_schedule', '2,12,30,50', 'duel_phase', 2, 'mission_time_pct', 100, 'pin_length', 6,
  -- 0200: open world (distances in thousandths of the campus width)
  'move_speed', 16,          -- run speed: 0.025 campus/s → ~40 s to cross the campus
  'loc_radius', 18,          -- a location's area
  'engage_range', 40,        -- squads this close can duel
  'zone_tick_seconds', 6,    -- outside the safe zone: damage every N seconds
  'zone_tick_damage', 4,     -- … of this much HP (shield absorbs first)
  'red_interval', 0,         -- automatic red zone every N minutes from phase 2 (0 = host only)
  'red_warning', 20,         -- seconds between the red zone warning and the strike
  'red_damage', 30,          -- HP lost by squads inside the red zone when it lands
  'red_radius', 80           -- red zone size
) || jsonb_build_object(   -- (Postgres allows at most 100 arguments per call)
  'reveal_pct', 50,          -- revealing every answer box costs this % of the mission's points
  'boarding_seconds', 18,    -- autopilot: boarding countdown before the bus leaves
  'finale_minute', 0,        -- autopilot: minute the finale starts (0 = 5 min after phase 4)
  'finale_battles', 2,        -- autopilot: number of finale battle rounds
  -- 0500: vast campus, floors, loot on the ground, Collapsing Campus
  'dmg_wrong', 5,             -- a wrong answer costs this much HP
  'dmg_airdrop_fail', 10,     -- failing a crate or vault costs this much HP
  'lock_interval', 150,       -- seconds between lockdown alarms from phase 1 (0 = host only)
  'lock_warning', 45,         -- alarm → doors shut
  'lock_damage', 30,          -- HP lost by squads caught inside
  'pickup_medkit', 16,        -- med kits lying around each map
  'pickup_shield', 8,         -- shield packs lying around each map
  'pickup_coins', 12,         -- coin stacks lying around each map
  'pickup_respawn', 75,       -- seconds between loot top-ups
  'vaults', 2                 -- locked vault crates on upper floors at the start
) $$;

create or replace function _auto_preset(p_length text) returns jsonb language sql immutable as $$
  select case coalesce(p_length, 'standard')
    when 'quick' then jsonb_build_object('auto_pacing', 1, 'phase_schedule', '1,3,5,7', 'finale_minute', 9, 'finale_battles', 1,
      'zone_warning', 25, 'airdrop_interval', 1, 'red_interval', 2, 'mission_time_pct', 70, 'shuttle_seconds', 12, 'roles_seconds', 12,
      'sync_seconds', 90, 'recovery_seconds', 45, 'attack_cooldown', 45, 'protect_seconds', 45, 'boarding_seconds', 12, 'airdrop_window', 90, 'lock_interval', 55, 'lock_warning', 30, 'pickup_respawn', 45)
    when 'full' then jsonb_build_object('auto_pacing', 1, 'phase_schedule', '3,15,30,45', 'finale_minute', 55, 'finale_battles', 3,
      'zone_warning', 60, 'airdrop_interval', 5, 'red_interval', 6, 'mission_time_pct', 100, 'shuttle_seconds', 20, 'roles_seconds', 15,
      'sync_seconds', 0, 'recovery_seconds', 120, 'attack_cooldown', 90, 'protect_seconds', 120, 'boarding_seconds', 25, 'airdrop_window', 180, 'lock_interval', 210, 'lock_warning', 50, 'pickup_respawn', 90)
    else jsonb_build_object('auto_pacing', 1, 'phase_schedule', '2,6,11,16', 'finale_minute', 21, 'finale_battles', 2,
      'zone_warning', 40, 'airdrop_interval', 3, 'red_interval', 4, 'mission_time_pct', 85, 'shuttle_seconds', 15, 'roles_seconds', 15,
      'sync_seconds', 120, 'recovery_seconds', 75, 'attack_cooldown', 60, 'protect_seconds', 75, 'boarding_seconds', 18, 'airdrop_window', 120, 'lock_interval', 100, 'lock_warning', 40, 'pickup_respawn', 60)
  end
$$;

create or replace function _auto_step_name(p_pos int, p_n int) returns text language sql immutable as $$
  select case when p_pos <= 0 then 'Finale entry round' when p_pos = 1 then 'Exchange round'
    when p_pos <= 1 + p_n then 'Finale battle ' || p_pos when p_pos = 2 + p_n then 'Final lockdown'
    when p_pos = 3 + p_n then 'Final code' when p_pos = 4 + p_n then 'Results locked'
    when p_pos = 5 + p_n then 'Winner reveal' when p_pos = 6 + p_n then 'Grand champion' else 'Match complete' end
$$;

create or replace function _autopilot(p_arena uuid) returns boolean
language plpgsql as $$
declare a arenas; v_ev uuid; v_fam text; v_n int; v_pos int; v_fm int; v_open int; v_res boolean := false;
  v_stat jsonb;
begin
  -- close_sync / lock_results force a nested tick: never re-enter
  if coalesce(current_setting('hb.in_auto', true), '') = '1' then return false; end if;
  select * into a from arenas where id = p_arena;
  if a.id is null or not a.autopilot or a.paused or a.phase = 'ended' then return false; end if;
  v_ev := a.event_id;
  perform set_config('hb.in_auto', '1', true);
  begin
    v_fam := case when a.phase in ('lobby', 'boarding') then 'boarding' when a.phase in ('shuttle', 'roles') then 'ride'
                  when a.phase = 'play' then 'play' else 'fin' end;
    if split_part(coalesce(a.auto_step, ''), ':', 1) <> v_fam then
      perform _auto_resync(a.id);
      select * into a from arenas where id = p_arena;
      v_res := true;
    end if;

    if a.phase = 'lobby' then
      if exists (select 1 from teams where arena_id = a.id and ready) then
        perform _host_exec(v_ev, a.id, 'open_boarding', '{}'::jsonb, 'autopilot');
        update arenas set auto_step = 'boarding', auto_next_at = now() + _secs(coalesce(_cfg(v_ev, 'boarding_seconds'), 18)) where id = a.id;
        insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'open_boarding');
        v_res := true;
      end if;

    elsif a.phase = 'boarding' then
      if a.auto_next_at is not null and now() >= a.auto_next_at then
        if exists (select 1 from teams where arena_id = a.id and ready) then
          perform _host_exec(v_ev, a.id, 'drive', '{}'::jsonb, 'autopilot');
          update arenas set auto_step = 'ride', auto_next_at = null where id = a.id;
          insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'drive');
        else
          update arenas set auto_next_at = now() + interval '10 seconds' where id = a.id;
        end if;
        v_res := true;
      end if;

    elsif a.phase = 'play' then
      -- the finale starts on the timetable
      v_fm := _auto_finale_minute(v_ev);
      if a.play_started_at is not null and now() >= a.play_started_at + make_interval(mins => v_fm) then
        perform _host_exec(v_ev, a.id, 'begin_finale', '{}'::jsonb, 'autopilot');
        update arenas set auto_step = 'fin:0', auto_next_at = now() + interval '12 seconds', match_phase = 5,
          phase_started_at = now(), phase_next_at = null,
          overlay = overlay || jsonb_build_object('match', jsonb_build_object('phase', 5, 'started_at', now(), 'next_at', null, 'zone_target', 5))
        where id = a.id;
        perform _feed(a.id, 'phase.started', jsonb_build_object('phase', 5));
        insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'begin_finale');
        v_res := true;
      end if;

    elsif a.phase in ('finale', 'results') then
      v_n := greatest(1, coalesce(_cfg(v_ev, 'finale_battles'), 2));
      if a.sync_round_id is not null then
        -- a running round ends early once no squad is still working on it
        select count(*) into v_open from mission_instances where sync_round_id = a.sync_round_id and status = 'active';
        if v_open = 0 then
          perform _host_exec(v_ev, a.id, 'close_sync', '{}'::jsonb, 'autopilot');
          v_res := true;
        end if;
      elsif a.auto_next_at is null then
        -- a round just ended: short break before the next step
        update arenas set auto_next_at = now() + interval '10 seconds' where id = a.id;
        v_res := true;
      elsif now() >= a.auto_next_at then
        v_pos := _auto_fin_pos(a.id);
        if v_pos < 2 + v_n then
          -- rounds: 0 → A entry, 1 → B exchange, 2.. → C battles
          perform _host_exec(v_ev, a.id, 'finale_stage', jsonb_build_object('stage', case when v_pos = 0 then 'A' when v_pos = 1 then 'B' else 'C' end), 'autopilot');
          perform _host_exec(v_ev, a.id, 'launch_sync', jsonb_build_object('kind',
            case when v_pos = 0 then 'finale_entry' when v_pos = 1 then 'finale_exchange' else 'finale_battle' end), 'autopilot');
          update arenas set auto_next_at = null where id = a.id;
        elsif v_pos = 2 + v_n then
          perform _final_lockdown(a.id);
          update arenas set auto_next_at = now() + interval '30 seconds' where id = a.id;
        elsif v_pos = 3 + v_n then
          perform _host_exec(v_ev, a.id, 'finale_stage', jsonb_build_object('stage', 'E'), 'autopilot');
          perform _host_exec(v_ev, a.id, 'launch_sync', jsonb_build_object('kind', 'final_code'), 'autopilot');
          update arenas set auto_next_at = null where id = a.id;
        elsif v_pos = 4 + v_n then
          perform _host_exec(v_ev, a.id, 'lock_results', '{}'::jsonb, 'autopilot');
          update arenas set auto_next_at = now() + interval '15 seconds' where id = a.id;
        elsif v_pos = 5 + v_n then
          perform _host_exec(v_ev, a.id, 'reveal_winner', '{}'::jsonb, 'autopilot');
          update arenas set auto_next_at = now() + interval '20 seconds' where id = a.id;
        elsif v_pos = 6 + v_n then
          -- the grand champion waits until every map of the event has crowned its winner
          -- (maps nobody played on are ignored)
          if not exists (select 1 from arenas x where x.event_id = v_ev and not x.winner_revealed
                         and exists (select 1 from teams where arena_id = x.id and ready)) then
            update events set grand_revealed = true where id = v_ev;
            perform _ping_arena(x.id, 'grand') from arenas x where x.event_id = v_ev;
          end if;
        end if;
        if v_pos < 6 + v_n or (select grand_revealed from events where id = v_ev) then
          insert into audit_log(event_id, arena_id, actor, action, args)
            values (v_ev, a.id, 'autopilot', 'finale_step', jsonb_build_object('step', _auto_step_name(v_pos, v_n)));
          v_res := true;
        end if;
      end if;
      update arenas set auto_step = 'fin:' || _auto_fin_pos(a.id) where id = a.id;
    end if;

    -- publish "what happens next" for every screen
    v_stat := _auto_status(a.id) - 'step';
    update arenas set overlay = overlay || jsonb_build_object('auto', v_stat)
      where id = a.id and overlay -> 'auto' is distinct from v_stat;
    if found then v_res := true; end if;
  exception when others then
    perform set_config('hb.in_auto', '', true);
    if not exists (select 1 from audit_log where arena_id = a.id and actor = 'autopilot' and not ok and at > now() - interval '30 seconds') then
      insert into audit_log(event_id, arena_id, actor, action, ok, error) values (v_ev, a.id, 'autopilot', 'step', false, sqlerrm);
    end if;
    return false;
  end;
  perform set_config('hb.in_auto', '', true);
  if v_res then perform _ping_arena(a.id, 'auto'); end if;
  return v_res;
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
    perform _spawn_pickups(p_arena);
    perform _spawn_start_vaults(p_arena);
    v_changed := true;
  end if;

  select * into a from arenas where id = p_arena;
  if a.phase not in ('play', 'finale') then
    if a.autopilot and _autopilot(p_arena) then v_changed := true; end if;
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

  -- Collapsing Campus: doors shut when the countdown ends; the next alarm follows the timetable
  for r in select id from lockdowns where arena_id = p_arena and not sealed and seal_at <= now() loop
    perform _lock_seal(r.id); v_changed := true;
  end loop;
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and a.match_phase >= 1 and _cfg(a.event_id, 'lock_interval') > 0
     and coalesce(a.last_lock_at, a.phase_started_at, a.play_started_at) < now() - _secs(_cfg(a.event_id, 'lock_interval')) then
    if _lock_next(p_arena) is not null then v_changed := true; else update arenas set last_lock_at = now() where id = p_arena; end if;
  end if;
  -- loot on the ground tops up every so often
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and (a.last_pickup_at is null or a.last_pickup_at < now() - _secs(greatest(20, _cfg(a.event_id, 'pickup_respawn')))) then
    if _spawn_pickups(p_arena) > 0 then v_changed := true; end if;
  end if;

  -- autopilot: finale rounds, final lockdown, results (no-op unless the host started an automatic match)
  select * into a from arenas where id = p_arena;
  if a.autopilot and _autopilot(p_arena) then v_changed := true; end if;

  if v_changed then perform _zone_publish(p_arena); perform _ping_arena(p_arena, 'tick'); end if;
  return v_changed;
end $$;

create or replace function _shift_arena(p_arena uuid, p_delta interval) returns void
language plpgsql as $$
begin
  update arenas set
    shuttle_departed_at = shuttle_departed_at + p_delta, shuttle_arrive_at = shuttle_arrive_at + p_delta,
    roles_deadline = roles_deadline + p_delta, play_started_at = play_started_at + p_delta,
    zone_next_at = zone_next_at + p_delta, last_airdrop_at = last_airdrop_at + p_delta,
    phase_started_at = phase_started_at + p_delta, phase_next_at = phase_next_at + p_delta,
    red_at = red_at + p_delta, last_red_at = last_red_at + p_delta, auto_next_at = auto_next_at + p_delta,
    last_lock_at = last_lock_at + p_delta, last_pickup_at = last_pickup_at + p_delta,
    overlay = case when overlay ? 'match' then jsonb_set(overlay, '{match,next_at}',
      coalesce(to_jsonb((overlay #>> '{match,next_at}')::timestamptz + p_delta), 'null'::jsonb)) else overlay end
  where id = p_arena;
  update mission_instances set deadline = deadline + p_delta, fallback_at = fallback_at + p_delta,
    started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update battles set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update sync_rounds set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update airdrops set expires_at = expires_at + p_delta, spawned_at = spawned_at + p_delta where arena_id = p_arena and status = 'open';
  update lockdowns set seal_at = seal_at + p_delta where arena_id = p_arena and not sealed;
  update alliances set expires_at = expires_at + p_delta, created_at = created_at + p_delta
    where arena_id = p_arena and status in ('proposed', 'active');
  update story_events set expires_at = expires_at + p_delta where arena_id = p_arena and expires_at > now();
  update teams set zone_hit_at = zone_hit_at + p_delta, travel_started_at = travel_started_at + p_delta, travel_arrive_at = travel_arrive_at + p_delta,
    recovery_deadline = recovery_deadline + p_delta, attack_cooldown_until = attack_cooldown_until + p_delta,
    protected_until = protected_until + p_delta, jammed_until = jammed_until + p_delta, scan_until = scan_until + p_delta
  where arena_id = p_arena;
  perform _zone_publish(p_arena);
end $$;

create or replace function host_command(p_token text, p_arena uuid, p_cmd text, p_args jsonb default '{}'::jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_ids uuid[]; v_id uuid; v_out jsonb := '{}'::jsonb; v_err text; v_res jsonb; v_delta interval; v_logargs jsonb;
  v_all_ok text[] := array['open_boarding','assign_buses','drive','finalize_roles','pause','resume','broadcast','clear_overlay',
    'blackout','countdown','story','bargain','zone_warn','zone_now','zone_cancel','zone_set','spawn_airdrop','begin_finale',
    'finale_stage','launch_sync','close_sync','lock_results','reveal_winner','end_game','reveal_squad00',
    'next_phase','set_phase','hide_rankings','red_zone','red_cancel','start_match','autopilot_on','autopilot_off',
    'lock_next','lock_building','unlock_all','final_lockdown','spawn_loot'];
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
      if p_cmd in ('open_boarding', 'assign_buses', 'drive', 'start_match') and v_id is not null
         and not exists (select 1 from teams where arena_id = v_id and ready) then
        raise exception 'NO_READY_SQUADS';
      end if;
      if p_cmd = any(v_new) then
        v_res := _host_exec_p0(v_ev, v_id, p_cmd, p_args, p_reason);
      elsif p_cmd in ('start_match', 'autopilot_on') then
        -- automatic match: write the length preset, then let the autopilot run every step
        if p_cmd = 'start_match' then
          if coalesce(p_args ->> 'length', 'standard') not in ('quick', 'standard', 'full') then raise exception 'BAD_LENGTH'; end if;
          update events set settings = settings || _auto_preset(p_args ->> 'length') where id = v_ev;
        else
          update events set settings = settings || jsonb_build_object('auto_pacing', 1) where id = v_ev;
        end if;
        update arenas set autopilot = true, auto_length = coalesce(p_args ->> 'length', auto_length, 'standard'),
          auto_story = case when phase in ('lobby', 'boarding', 'shuttle', 'roles') then -1 when phase = 'play' then greatest(auto_story, match_phase) else auto_story end
        where id = v_id;
        perform _auto_resync(v_id);
        if (select phase from arenas where id = v_id) = 'play' then
          perform _set_match_phase(v_id, (select match_phase from arenas where id = v_id));
        end if;
        perform _tick(v_id, true);
        v_res := _auto_status(v_id);
      elsif p_cmd in ('lock_next', 'lock_building') then
        if (select phase from arenas where id = v_id) not in ('play', 'finale') then raise exception 'WRONG_PHASE'; end if;
        v_res := jsonb_build_object('lockdown', _lock_next(v_id, case when p_cmd = 'lock_building' then p_args ->> 'building' end,
                                                         case when p_cmd = 'lock_building' then (p_args ->> 'level')::int end));
        if v_res ->> 'lockdown' is null then raise exception 'NOTHING_LEFT_TO_SEAL'; end if;
        if coalesce((p_args ->> 'now')::boolean, false) then perform _lock_seal((v_res ->> 'lockdown')::uuid); end if;
      elsif p_cmd = 'unlock_all' then
        delete from lockdowns where arena_id = v_id;
        perform _lock_publish(v_id);
        perform _feed(v_id, 'lockdown.lifted', '{}'::jsonb);
        v_res := '{}'::jsonb;
      elsif p_cmd = 'final_lockdown' then
        if (select phase from arenas where id = v_id) <> 'finale' then raise exception 'WRONG_PHASE'; end if;
        perform _final_lockdown(v_id);
        v_res := '{}'::jsonb;
      elsif p_cmd = 'spawn_loot' then
        if (select phase from arenas where id = v_id) <> 'play' then raise exception 'WRONG_PHASE'; end if;
        v_res := jsonb_build_object('spawned', _spawn_pickups(v_id));
      elsif p_cmd = 'autopilot_off' then
        update arenas set autopilot = false, auto_next_at = null, overlay = overlay - 'auto' where id = v_id;
        v_res := '{}'::jsonb;
      elsif p_cmd = 'clear_overlay' then
        update arenas set overlay = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(overlay) as x(k, v)
          where k in ('match', 'zone', 'world', 'red', 'auto', 'lock')) where id = v_id;
        v_res := '{}'::jsonb;
      else
        v_res := _host_exec(v_ev, v_id, p_cmd, p_args, p_reason);
      end if;
      -- hooks keeping match phases consistent with the original commands
      if p_cmd = 'resume' and v_delta is not null then
        update lockdowns set seal_at = seal_at + v_delta where arena_id = v_id and not sealed;
        perform _lock_publish(v_id);
        update arenas set phase_next_at = phase_next_at + v_delta, phase_started_at = phase_started_at + v_delta,
          auto_next_at = auto_next_at + v_delta, last_red_at = last_red_at + v_delta, red_at = red_at + v_delta,
          last_lock_at = last_lock_at + v_delta, last_pickup_at = last_pickup_at + v_delta,
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
          red_x = null, red_y = null, red_r = null, red_at = null, last_red_at = null,
          autopilot = false, auto_step = null, auto_next_at = null, auto_story = -1, last_lock_at = null, last_pickup_at = null,
          overlay = overlay - 'auto' - 'lock' where id = v_id;
        update teams set zone_hit_at = null, travel_fx = null, travel_fy = null, level = 0, bldg = null, vel_x = 0, vel_y = 0 where arena_id = v_id;
        delete from lockdowns where arena_id = v_id;
        delete from pickups where arena_id = v_id;
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

drop function if exists captain_steer(text, double precision, double precision);
create or replace function captain_steer(p_token text, p_x float8, p_y float8, p_vx float8 default 0, p_vy float8 default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; a arenas; cur float8[]; dt float8; maxd float8; d float8; nx float8; ny float8;
  v_loc text; v_others int; v_ping boolean; b buildings; v_spd float8; v_vx float8; v_vy float8; v_vm float8; v_pick jsonb; v_wall text;
begin
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id for update;
  select * into a from arenas where id = t.arena_id;
  if a.phase <> 'play' then raise exception 'NO_MOVES_NOW'; end if;
  if t.state = 'recovery' then raise exception 'BUSY'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind = 'battle') then raise exception 'IN_BATTLE'; end if;
  if p_x is null or p_y is null or p_x = 'NaN'::float8 or p_y = 'NaN'::float8 or abs(p_x) = 'Infinity'::float8 or abs(p_y) = 'Infinity'::float8 then raise exception 'BAD_REQUEST'; end if;
  cur := _team_xy(t);
  v_spd := _cfg(t.event_id, 'move_speed') / 1000.0;
  -- distance allowed since the last accepted position (capped so idling never banks a teleport)
  dt := least(4, greatest(0, extract(epoch from now() - coalesce(case when t.state = 'traveling' then now() else t.pos_at end, now() - interval '1 second'))));
  if t.state = 'traveling' then dt := 0.25; end if;
  maxd := v_spd * dt * 1.25 + 0.003;
  nx := greatest(0.02, least(0.98, p_x)); ny := greatest(0.02, least(0.98, p_y));
  d := sqrt((nx - cur[1]) ^ 2 + (ny - cur[2]) ^ 2);
  if d > maxd then nx := cur[1] + (nx - cur[1]) * maxd / d; ny := cur[2] + (ny - cur[2]) * maxd / d; end if;
  if t.level > 0 then
    -- upstairs: the floor's walls keep you inside the building
    select * into b from buildings where id = t.bldg;
    if b.id is not null then
      nx := greatest(b.x0 + 0.004, least(b.x1 - 0.004, nx)); ny := greatest(b.y0 + 0.004, least(b.y1 - 0.004, ny));
    end if;
  else
    -- a sealed building is a solid block (you can always walk out of one)
    select bb.id into v_wall from buildings bb
    where nx between bb.x0 and bb.x1 and ny between bb.y0 and bb.y1 and _sealed(t.arena_id, bb.id, 0)
      and not (cur[1] between bb.x0 and bb.x1 and cur[2] between bb.y0 and bb.y1)
    limit 1;
    if v_wall is not null then nx := cur[1]; ny := cur[2]; end if;
  end if;
  -- velocity, for smooth movement on every other screen (capped at running speed)
  v_vx := coalesce(p_vx, 0); v_vy := coalesce(p_vy, 0);
  if v_vx = 'NaN'::float8 or v_vy = 'NaN'::float8 or abs(v_vx) = 'Infinity'::float8 or abs(v_vy) = 'Infinity'::float8 then v_vx := 0; v_vy := 0; end if;
  v_vm := sqrt(v_vx ^ 2 + v_vy ^ 2);
  if v_vm > v_spd * 1.1 then v_vx := v_vx * v_spd * 1.1 / v_vm; v_vy := v_vy * v_spd * 1.1 / v_vm; end if;
  if v_wall is not null then v_vx := 0; v_vy := 0; end if;
  v_loc := _loc_at3(t.arena_id, t.event_id, nx, ny, t.level, t.bldg);
  if v_loc is distinct from t.location_id then
    -- leaving an area ends its search (no penalty)
    update mission_instances set status = 'cancelled'
    where team_id = t.id and status = 'active' and kind in ('mission', 'relay', 'airdrop') and sync_round_id is null;
  end if;
  v_ping := v_loc is distinct from t.location_id or t.last_steer_ping is null or t.last_steer_ping < now() - interval '2 seconds';
  update teams set pos_x = nx, pos_y = ny, pos_at = now(), vel_x = v_vx, vel_y = v_vy, dropped = true, location_id = v_loc,
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
  v_pick := _take_pickups(t.id, nx, ny);
  if v_ping or v_pick is not null then perform _ping_team(t.id, 'move'); end if;
  return jsonb_build_object('x', nx, 'y', ny, 'location', v_loc, 'level', t.level,
    'clamped', abs(nx - p_x) > 0.0005 or abs(ny - p_y) > 0.0005, 'wall', v_wall, 'picked', v_pick);
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
  if l.kind <> 'stairs' and l.building is not null and _sealed(t.arena_id, l.building, l.level) then raise exception 'SEALED'; end if;
  if l.kind = 'stairs' and _sealed(t.arena_id, l.building, 0) then raise exception 'SEALED'; end if;
  -- floors: tap-to-run stays on your storey; upper floors are reached by the stairs
  if not t.dropped and l.level > 0 then raise exception 'DROP_OUTSIDE'; end if;
  if t.dropped and (l.level <> t.level or (l.level > 0 and l.building is distinct from t.bldg)) then raise exception 'TAKE_THE_STAIRS'; end if;
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
  if (select kind from locations where id = t.location_id) = 'stairs' then raise exception 'NOTHING_HERE'; end if;
  if exists (select 1 from mission_instances where team_id = t.id and status = 'active' and kind <> 'battle') then raise exception 'MISSION_ACTIVE'; end if;
  if t.visit_missions >= _cfg(t.event_id, 'visit_missions') then raise exception 'AREA_EXHAUSTED'; end if;
  v_id := _start_location_mission(t.id);
  if v_id is null then raise exception 'NO_MISSIONS'; end if;
  return jsonb_build_object('instance', v_id);
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
    perform _damage(mi.team_id, _cfg(t.event_id, 'dmg_fail'), 'mission_fail', mi.id::text, 'Challenge not solved');
  elsif mi.sync_round_id is null and mi.kind = 'airdrop' and p_status in ('failed', 'expired') then
    perform _damage(mi.team_id, _cfg(t.event_id, 'dmg_airdrop_fail'), 'airdrop_fail', mi.id::text, 'Crate not cracked');
  end if;
  perform _feed(t.arena_id, 'mission.failed', jsonb_build_object('team', t.number));
  perform _ping_team(mi.team_id, 'result');
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
    if mi.attempts_left > 0 and mi.sync_round_id is null and mi.kind in ('mission', 'relay', 'airdrop') then
      perform _damage(mi.team_id, _cfg((select event_id from teams where id = mi.team_id), 'dmg_wrong'), 'wrong_answer',
        mi.id::text || ':' || mi.attempts_left, 'Wrong answer');
    end if;
    if mi.attempts_left <= 0 then perform _fail(mi.id, 'failed'); end if;
    perform _ping_team(mi.team_id, 'attempt');
  end if;
  select * into mi from mission_instances where id = mi.id;
  return jsonb_build_object('correct', v_ok, 'status', mi.status, 'attempts_left', mi.attempts_left, 'points', mi.points_awarded);
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
      v_coins := case ad.tier when 'common' then 40 when 'rare' then 60 when 'legendary' then 100 when 'vault' then 120
                   when 'mystery' then 20 + abs(hashtext(ad.id::text)) % 101 when 'cursed' then 0 else 30 end;
      if ad.tier in ('cursed', 'vault') then v_pts := v_pts * 2; end if;
      if t.beacon then v_coins := v_coins * 2; update teams set beacon = false where id = t.id; end if;
      perform _apply(mi.team_id, 'airdrop', v_pts, v_coins, 0, 0, ad.id::text, ad.tier || ' airdrop');
      if ad.tier = 'cursed' then perform _damage(mi.team_id, 20, 'curse', ad.id::text, 'Cursed airdrop'); end if;
      if ad.tier = 'intel' then update teams set scan_until = now() + interval '120 seconds' where id = t.id; end if;
      v_item := case ad.tier when 'legendary' then 'sniper' when 'vault' then 'sniper' when 'rare' then 'shield' when 'common' then 'medkit'
                  when 'mystery' then (array['smg', 'jammer', 'scanner', 'extract'])[1 + abs(hashtext(ad.id::text || 'i')) % 4] else null end;
      if v_item is not null then perform _add_item(mi.team_id, v_item, 1); end if;
      if ad.tier in ('legendary', 'vault') then perform _add_item(mi.team_id, 'shield', 1); end if;
      if ad.tier = 'vault' then perform _add_item(mi.team_id, 'medkit', 2); end if;
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
      'visit_limit', _cfg(e.id, 'visit_missions'), 'pos', to_jsonb(_team_xy(t)), 'level', t.level, 'bldg', t.bldg, 'travel_from_xy', case when t.travel_fx is not null then jsonb_build_array(t.travel_fx, t.travel_fy) end),
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
        'traveling', x.state = 'traveling', 'level', x.level, 'bldg', x.bldg,
        'vel', case when x.state = 'idle' and x.pos_at > now() - interval '1500 milliseconds' then jsonb_build_array(x.vel_x, x.vel_y) end,
        'protected', x.protected_until > now(),
        'in_battle', exists (select 1 from battles bb where bb.status = 'active' and (bb.attacker_id = x.id or bb.defender_id = x.id)),
        'allied', exists (select 1 from alliances al where al.status = 'active'
                          and ((al.team_a = t.id and al.team_b = x.id) or (al.team_b = t.id and al.team_a = x.id)))
      ) order by x.number), '[]'::jsonb) from teams x where x.arena_id = t.arena_id and x.ready),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'location', location_id, 'tier', tier,
        'expires_at', expires_at)), '[]'::jsonb) from airdrops where arena_id = a.id and status = 'open'),
    'pickups', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'k', kind, 'x', x, 'y', y, 'l', level)), '[]'::jsonb)
      from pickups where arena_id = a.id and taken_at is null),
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
      'threat', a.threat,
      'sealed', (select count(*) from lockdowns where arena_id = a.id and sealed),
      'caught', (select count(*) from ledger where arena_id = a.id and kind = 'lockdown'),
      'vaults', (select count(*) from airdrops where arena_id = a.id and tier = 'vault' and status = 'claimed'),
      'loot', (select count(*) from pickups where arena_id = a.id and taken_at is not null));
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
        'pos', case when t.jammed_until is null or t.jammed_until < now() then to_jsonb(_team_xy(t)) end, 'level', t.level, 'bldg', t.bldg,
        'vel', case when t.state = 'idle' and t.pos_at > now() - interval '1500 milliseconds' then jsonb_build_array(t.vel_x, t.vel_y) end,
        'travel_to', case when t.jammed_until is null or t.jammed_until < now() then t.travel_to end,
        'travel_from', case when t.jammed_until is null or t.jammed_until < now() then t.travel_from end,
        'travel_started_at', t.travel_started_at, 'travel_arrive_at', t.travel_arrive_at,
        'in_battle', exists (select 1 from battles b where b.status = 'active' and (b.attacker_id = t.id or b.defender_id = t.id)),
        'sync_solved', case when sr.id is not null then exists (select 1 from mission_instances mi where mi.sync_round_id = sr.id and mi.team_id = t.id and mi.status = 'solved') end
      ) order by t.number), '[]'::jsonb) from teams t where t.arena_id = a.id),
    'airdrops', (select coalesce(jsonb_agg(jsonb_build_object('location', location_id, 'tier', tier, 'expires_at', expires_at)), '[]'::jsonb)
      from airdrops where arena_id = a.id and status = 'open'),
    'pickups', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'k', kind, 'x', x, 'y', y, 'l', level)), '[]'::jsonb)
      from pickups where arena_id = a.id and taken_at is null),
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

create or replace function map_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'locations', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'building', building, 'floor', floor, 'level', level,
       'x', x, 'y', y, 'kind', kind, 'collapse', collapse_stage, 'risk', risk, 'reward', reward, 'tags', tags,
       'drop', drop_zone, 'enabled', enabled) order by id) from locations),
    'buildings', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'x0', x0, 'y0', y0, 'x1', x1, 'y1', y1,
       'floors', floors, 'stairs', jsonb_build_array(stair_x, stair_y), 'door', jsonb_build_array(door_x, door_y), 'style', style) order by id), '[]'::jsonb) from buildings),
    'edges', (select jsonb_agg(jsonb_build_array(a, b, seconds)) from edges),
    'items', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'description', description,
       'price', price, 'params', params) order by price) from items)
  )
$$;

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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer', 'captain_reveal', 'captain_stairs', 'arena_positions']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
