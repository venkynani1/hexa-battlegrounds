-- ═══════════════════════════════════════════════════════════════════════════
-- v16 · One big map, Free Fire style loot, and louder comms
--
--  1. One map for everyone: a map can now hold up to 40 squads (160 players). The host chooses
--     "Everyone on one map" at event creation (arena_size 35, one map) or "60 players a map".
--  2. Guns with ammo: Pistol (never runs dry), SMG (light ammo), Shotgun (shells), Assault Rifle and
--     Sniper (rifle ammo). Guns and ammo boxes lie around campus; a squad picks the gun it fires with
--     (squad_equip). A gun with no ammo left is skipped automatically, so nobody is ever stuck.
--  3. Armour: vests and helmets, levels 1–3 (vest cuts every gunshot by 10/20/30 %, helmet by 5/10/15 %).
--     Higher levels are rarer and lie inside buildings.
--  4. More medkits and shields scattered over the map, plus Signal Jammers (hide your squad from rivals).
--     All loot scales with the number of squads on the map.
--  5. Eliminations: knocking out a squad is worth 100 points + 40 coins, and drops a death box
--     (ammo, a med kit and their vest) where they fell.
--  6. Captains: an "All captains" broadcast channel (one message per 45 s per squad).
-- Run once (bundled in the full install).
-- ═══════════════════════════════════════════════════════════════════════════

alter table teams add column if not exists vest_lvl int not null default 0;
alter table teams add column if not exists helmet_lvl int not null default 0;
alter table teams add column if not exists weapon_sel text;
alter table pickups drop constraint if exists pickups_kind_check;
alter table pickups add constraint pickups_kind_check check (kind in ('medkit', 'shield', 'coins',
  'ammo_light', 'ammo_rifle', 'ammo_shell', 'gun_smg', 'gun_shotgun', 'gun_ar', 'gun_sniper',
  'vest1', 'vest2', 'vest3', 'helmet1', 'helmet2', 'helmet3', 'jammer'));

insert into items(id, name, kind, description, params, price) values
('shotgun', 'Shotgun', 'weapon', 'Close range, two shells, huge damage.', '{"tag":"duel_smg","damage":35,"seconds":50,"consumable":false}'::jsonb, 45),
('ar', 'Assault Rifle', 'weapon', 'All-rounder: long range, 30-round magazine.', '{"tag":"duel_smg","damage":25,"seconds":60,"consumable":false}'::jsonb, 55),
('ammo_light', 'Light ammo', 'ammo', 'For the SMG.', '{}'::jsonb, 10),
('ammo_rifle', 'Rifle ammo', 'ammo', 'For the Assault Rifle and the Sniper.', '{}'::jsonb, 12),
('ammo_shell', 'Shotgun shells', 'ammo', 'For the Shotgun.', '{}'::jsonb, 10)
on conflict (id) do update set name = excluded.name, kind = excluded.kind, description = excluded.description, params = excluded.params, price = excluded.price;
-- guns picked up in the field are kept (duels used to use them up)
update items set params = params || '{"consumable": false}'::jsonb where id in ('smg', 'sniper');

drop function if exists _defaults_v15();
alter function _defaults() rename to _defaults_v15;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v15() || jsonb_build_object(
    'kill_points', 100, 'kill_coins', 40,   -- knocking out a squad
    'pickup_medkit', 24, 'pickup_shield', 12, -- per 15 squads; scaled up on bigger maps
    'ammo_cap', 300,                          -- most rounds of one ammo type a squad can carry
    'loot_ammo_light', 14, 'loot_ammo_rifle', 14, 'loot_ammo_shell', 8,
    'loot_gun_smg', 5, 'loot_gun_shotgun', 4, 'loot_gun_ar', 5, 'loot_gun_sniper', 2,
    'loot_vest1', 6, 'loot_vest2', 4, 'loot_vest3', 2, 'loot_helmet1', 6, 'loot_helmet2', 4, 'loot_helmet3', 2,
    'loot_jammer', 3)
$$;

-- ── 1. one big map ───────────────────────────────────────────────────────────
create or replace function _online_map_size(p_ev uuid) returns int
language sql stable as $$ select least(40, greatest(1, _cfg(p_ev, 'arena_size'))) $$;
do $$
declare f record; src text; out text;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%least(15, greatest(1, _cfg(v_ev, ''arena_size'')))%' loop
    src := pg_get_functiondef(f.sig);
    out := replace(src, 'least(15, greatest(1, _cfg(v_ev, ''arena_size'')))', 'least(40, greatest(1, _cfg(v_ev, ''arena_size'')))');
    execute out;
  end loop;
end $$;

-- ── 2. guns ──────────────────────────────────────────────────────────────────
create or replace function _gun(p_id text) returns jsonb
language sql immutable as $$
  select case p_id
    when 'smg' then '{"id":"smg","name":"SMG","dmg":2,"range":0.04,"rate":260,"mag":30,"reload":2000,"ammo":"ammo_light"}'::jsonb
    when 'shotgun' then '{"id":"shotgun","name":"Shotgun","dmg":9,"range":0.028,"rate":950,"mag":2,"reload":2300,"ammo":"ammo_shell"}'::jsonb
    when 'ar' then '{"id":"ar","name":"Assault Rifle","dmg":4,"range":0.075,"rate":420,"mag":30,"reload":2300,"ammo":"ammo_rifle"}'::jsonb
    when 'sniper' then '{"id":"sniper","name":"Sniper","dmg":16,"range":0.11,"rate":1700,"mag":5,"reload":2600,"ammo":"ammo_rifle"}'::jsonb
    else '{"id":"pistol","name":"Pistol","dmg":3,"range":0.055,"rate":650,"mag":12,"reload":1600,"ammo":null}'::jsonb end
$$;

-- can this squad fire this gun right now? (owns it, and has rounds for it; the pistol always works)
create or replace function _has_gun(p_team uuid, p_gun text) returns boolean
language sql stable as $$
  select p_gun = 'pistol' or (
    exists (select 1 from inventory where team_id = p_team and item_id = p_gun and qty > 0)
    and coalesce((select qty from inventory where team_id = p_team and item_id = _gun(p_gun) ->> 'ammo'), 0) > 0)
$$;

-- the gun the squad fires with: its choice if it can, else the best gun it has rounds for
create or replace function _weapon(p_team uuid) returns jsonb
language sql stable as $$
  select coalesce(
    (select _gun(t.weapon_sel) from teams t where t.id = p_team and t.weapon_sel is not null and _has_gun(p_team, t.weapon_sel)),
    (select _gun(g) from unnest(array['ar', 'smg', 'shotgun', 'sniper']) with ordinality u(g, o) where _has_gun(p_team, g) order by o limit 1),
    _gun('pistol'))
$$;

create or replace function squad_equip(p_token text, p_gun text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams;
begin
  p := _auth_player(p_token);
  if p.role is null then raise exception 'NO_ROLE'; end if;
  if coalesce(p_gun, '') not in ('pistol', 'smg', 'shotgun', 'ar', 'sniper') then raise exception 'BAD_ITEM'; end if;
  select * into t from teams where id = p.team_id;
  if p_gun <> 'pistol' and not exists (select 1 from inventory where team_id = t.id and item_id = p_gun and qty > 0) then raise exception 'NO_ITEM'; end if;
  if not _has_gun(t.id, p_gun) then raise exception 'NO_AMMO'; end if;
  update teams set weapon_sel = p_gun where id = t.id;
  update players set mag = null, reload_until = null where team_id = t.id; -- fresh magazine for the new gun
  perform _ping_team(t.id, 'item');
  return jsonb_build_object('weapon', _weapon(t.id));
end $$;

-- every shot uses one round of the gun's ammo; a knockout drops a death box
drop function if exists _squad_fire_v15(text, uuid);
alter function squad_fire(text, uuid) rename to _squad_fire_v15;
create function squad_fire(p_token text, p_target uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; r jsonb; w jsonb; v_left int; d teams; xy float8[]; k text;
begin
  p := _auth_player(p_token);
  w := _weapon(p.team_id);
  r := _squad_fire_v15(p_token, p_target);
  if w ->> 'ammo' is not null then
    perform _add_item(p.team_id, w ->> 'ammo', -1);
    select qty into v_left from inventory where team_id = p.team_id and item_id = w ->> 'ammo';
    r := r || jsonb_build_object('ammo_left', coalesce(v_left, 0));
    if coalesce(v_left, 0) <= 0 then r := r || jsonb_build_object('out_of_ammo', true, 'weapon', _weapon(p.team_id)); end if;
  end if;
  if coalesce((r ->> 'knocked')::boolean, false) then
    select * into d from teams where id = p_target;
    xy := _team_xy(d);
    foreach k in array array['ammo_rifle', 'ammo_light', 'medkit'] || case when d.vest_lvl > 0 then array['vest' || d.vest_lvl] else array[]::text[] end loop
      insert into pickups(arena_id, kind, x, y, level, bldg)
      values (d.arena_id, k, greatest(0.02, least(0.98, xy[1] + (random() - 0.5) * 0.006)), greatest(0.02, least(0.98, xy[2] + (random() - 0.5) * 0.006)), d.level, d.bldg);
    end loop;
    perform _ping_arena(d.arena_id, 'pickup');
    r := r || jsonb_build_object('elimination', jsonb_build_object('points', _cfg(d.event_id, 'kill_points'), 'coins', _cfg(d.event_id, 'kill_coins')));
  end if;
  return r;
end $$;

-- a gun from an airdrop, the shop or a duel comes with a starter magazine's worth of rounds
create or replace function _gun_starter_ammo() returns trigger
language plpgsql as $$
declare v_ammo text; v_have int;
begin
  if new.item_id in ('smg', 'shotgun', 'ar', 'sniper') and new.qty > 0 and (tg_op = 'INSERT' or coalesce(old.qty, 0) = 0) then
    v_ammo := _gun(new.item_id) ->> 'ammo';
    select qty into v_have from inventory where team_id = new.team_id and item_id = v_ammo;
    if coalesce(v_have, 0) = 0 then
      insert into inventory(team_id, item_id, qty) values (new.team_id, v_ammo, case new.item_id when 'shotgun' then 10 when 'sniper' then 10 else 30 end)
      on conflict (team_id, item_id) do update set qty = excluded.qty;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists inventory_gun_ammo on inventory;
create trigger inventory_gun_ammo after insert or update of qty on inventory for each row execute function _gun_starter_ammo();

-- ── 3. armour: cuts gunfire damage (vest 10/20/30 %, helmet 5/10/15 %) ─────────
drop function if exists _damage_v15(uuid, int, text, text, text);
alter function _damage(uuid, int, text, text, text) rename to _damage_v15;
create function _damage(p_team uuid, p_amount int, p_kind text, p_ref text, p_reason text) returns int
language plpgsql as $$
declare v_v int; v_h int; v_amt int := p_amount;
begin
  if p_kind = 'gunfire' and p_amount > 0 then
    select vest_lvl, helmet_lvl into v_v, v_h from teams where id = p_team;
    v_amt := greatest(1, round(p_amount * (1 - (least(3, coalesce(v_v, 0)) * 10 + least(3, coalesce(v_h, 0)) * 5) / 100.0))::int);
  end if;
  return _damage_v15(p_team, v_amt, p_kind, p_ref, p_reason);
end $$;

-- ── 4. loot on the ground ─────────────────────────────────────────────────────
-- the old pickup code only takes the three original kinds
do $$
declare src text; out text;
begin
  src := pg_get_functiondef('_take_pickups(uuid, double precision, double precision)'::regprocedure);
  if position('''medkit'', ''shield'', ''coins''' in src) > 0 then return; end if;
  out := regexp_replace(src, 'taken_at\s+is\s+null\s+and\s+level\s*=\s*t\.level',
    'taken_at is null and kind in (''medkit'', ''shield'', ''coins'') and level = t.level');
  if out = src then raise exception 'pickup patch did not apply'; end if;
  execute out;
end $$;

drop function if exists _take_pickups_v15(uuid, double precision, double precision);
alter function _take_pickups(uuid, double precision, double precision) rename to _take_pickups_v15;
create function _take_pickups(p_team uuid, p_x double precision, p_y double precision) returns jsonb
language plpgsql as $$
declare t teams; pk pickups; v_out jsonb := '[]'::jsonb; v_old jsonb; g text; v_lvl int; v_have int; v_cap int; v_ammo text; v_n int;
begin
  select * into t from teams where id = p_team;
  v_cap := _cfg(t.event_id, 'ammo_cap');
  for pk in select * from pickups where arena_id = t.arena_id and taken_at is null and level = t.level
              and kind not in ('medkit', 'shield', 'coins')
              and (x - p_x) ^ 2 + (y - p_y) ^ 2 <= 0.013 ^ 2 for update skip locked loop
    if pk.kind like 'gun\_%' then
      g := substring(pk.kind from 5); v_ammo := _gun(g) ->> 'ammo';
      v_n := case g when 'shotgun' then 10 when 'sniper' then 10 else 60 end;
      if not exists (select 1 from inventory where team_id = t.id and item_id = g and qty > 0) then
        perform _add_item(t.id, g, 1);
        if t.weapon_sel is null or t.weapon_sel = 'pistol' then update teams set weapon_sel = g where id = t.id; end if;
      else
        select coalesce(qty, 0) into v_have from inventory where team_id = t.id and item_id = v_ammo;
        if coalesce(v_have, 0) >= v_cap then continue; end if; -- already have it and full of rounds: leave it for others
      end if;
      select coalesce(qty, 0) into v_have from inventory where team_id = t.id and item_id = v_ammo;
      perform _add_item(t.id, v_ammo, least(v_n, v_cap - coalesce(v_have, 0)));
    elsif pk.kind like 'ammo\_%' then
      select coalesce(qty, 0) into v_have from inventory where team_id = t.id and item_id = pk.kind;
      if coalesce(v_have, 0) >= v_cap then continue; end if;
      perform _add_item(t.id, pk.kind, least(case pk.kind when 'ammo_shell' then 10 else 40 end, v_cap - coalesce(v_have, 0)));
    elsif pk.kind like 'vest_' then
      v_lvl := right(pk.kind, 1)::int;
      if v_lvl <= t.vest_lvl then continue; end if;
      update teams set vest_lvl = v_lvl where id = t.id;
    elsif pk.kind like 'helmet_' then
      v_lvl := right(pk.kind, 1)::int;
      if v_lvl <= t.helmet_lvl then continue; end if;
      update teams set helmet_lvl = v_lvl where id = t.id;
    elsif pk.kind = 'jammer' then
      select coalesce(qty, 0) into v_have from inventory where team_id = t.id and item_id = 'jammer';
      if coalesce(v_have, 0) >= 2 then continue; end if;
      perform _add_item(t.id, 'jammer', 1);
    else continue;
    end if;
    update pickups set taken_by = t.id, taken_at = now() where id = pk.id;
    v_out := v_out || jsonb_build_array(pk.kind);
  end loop;
  v_old := _take_pickups_v15(p_team, p_x, p_y);
  if v_old is not null then v_out := v_out || v_old; end if;
  if jsonb_array_length(v_out) = 0 then return null; end if;
  if v_old is null then perform _ping_arena(t.arena_id, 'pickup'); end if;
  return v_out;
end $$;

-- spawn: the original three kinds, then everything else; all scaled by how many squads are on the map
drop function if exists _spawn_pickups_v15(uuid);
alter function _spawn_pickups(uuid) rename to _spawn_pickups_v15;
create function _spawn_pickups(p_arena uuid) returns int
language plpgsql as $$
declare a arenas; v_n int; k text; v_want int; v_have int; v_try int; v_scale float8; l locations; b buildings;
  ang float8; rad float8; px float8; py float8; v_inside boolean;
begin
  v_n := _spawn_pickups_v15(p_arena);
  select * into a from arenas where id = p_arena;
  v_scale := greatest(1.0, (select count(*) from teams where arena_id = p_arena and ready) / 15.0);
  foreach k in array array['medkit', 'shield', 'ammo_light', 'ammo_rifle', 'ammo_shell', 'gun_smg', 'gun_shotgun', 'gun_ar', 'gun_sniper',
                           'vest1', 'vest2', 'vest3', 'helmet1', 'helmet2', 'helmet3', 'jammer'] loop
    v_want := round(coalesce(_cfg(a.event_id, case when k in ('medkit', 'shield') then 'pickup_' || k else 'loot_' || k end), 0) * v_scale);
    select count(*) into v_have from pickups where arena_id = p_arena and taken_at is null and kind = k;
    v_inside := k in ('vest3', 'helmet3', 'gun_sniper', 'vest2', 'helmet2');
    v_try := 0;
    while v_have < v_want and v_try < v_want * 3 loop
      v_try := v_try + 1;
      select * into l from locations loc where loc.enabled and loc.kind not in ('start', 'stairs')
        and (not v_inside or loc.level > 0 or loc.building is not null)
        and not (loc.building is not null and _sealed(p_arena, loc.building, loc.level))
      order by random() limit 1;
      exit when l.id is null;
      ang := random() * 2 * pi(); rad := 0.006 + random() * 0.016;
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
  return v_n;
end $$;

-- ── what the phones see ───────────────────────────────────────────────────────
create or replace function _team_extra(t teams) returns jsonb
language sql stable as $$
  select jsonb_build_object('vehicle', t.vehicle, 'kills', t.kills,
    'buggy', case when t.buggy_x is not null and t.vehicle <> 'in' then jsonb_build_array(t.buggy_x, t.buggy_y)
                  when t.dropped and t.vehicle = 'none' then to_jsonb(_buggy_bay(t.number, (_team_xy(t))[1], (_team_xy(t))[2])) end,
    'in_plane', not t.dropped and t.jump_at is null and t.state <> 'traveling',
    'parachute', not t.dropped and (t.jump_at is not null or t.state = 'traveling'),
    'jump_at', t.jump_at,
    'land_at', case when t.jump_at is not null then t.land_at when not t.dropped and t.state = 'traveling' then t.travel_arrive_at end,
    'weapon', _weapon(t.id), 'fight_at', t.fight_at,
    'armor', jsonb_build_object('vest', t.vest_lvl, 'helmet', t.helmet_lvl),
    'weapon_sel', t.weapon_sel,
    'jammed_until', case when t.jammed_until > now() then t.jammed_until end)
$$;

-- a new match starts clean: no armour, back to the pistol
create or replace function _loadout_reset() returns trigger
language plpgsql as $$
begin
  if new.phase in ('lobby', 'boarding') and old.phase is distinct from new.phase then
    update teams set vest_lvl = 0, helmet_lvl = 0, weapon_sel = null where arena_id = new.id;
    delete from inventory i using teams t where t.id = i.team_id and t.arena_id = new.id
      and i.item_id in ('ammo_light', 'ammo_rifle', 'ammo_shell', 'shotgun', 'ar');
  end if;
  return new;
end $$;
drop trigger if exists arenas_loadout_reset on arenas;
create trigger arenas_loadout_reset after update of phase on arenas for each row execute function _loadout_reset();

-- ── 6. captains: "All captains" broadcast (to squad 0) ──────────────────────────
drop function if exists _captain_chat_v15(text, int, text);
alter function captain_chat(text, int, text) rename to _captain_chat_v15;
-- broadcast copies have their own limit; they do not count against direct messages
do $$
declare src text; out text;
begin
  src := pg_get_functiondef('_captain_chat_v15(text, int, text)'::regprocedure);
  out := regexp_replace(src, 'from_team\s*=\s*t\.id\s+and\s+at\s*>', 'from_team = t.id and body not like ''📢 %'' and at >');
  if out = src then raise exception 'chat patch did not apply'; end if;
  execute out;
end $$;
create function captain_chat(p_token text, p_to_team int, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; v_body text := trim(coalesce(p_body, '')); v_n int;
begin
  if coalesce(p_to_team, -1) <> 0 then return _captain_chat_v15(p_token, p_to_team, p_body); end if;
  p := _auth_captain(p_token);
  select * into t from teams where id = p.team_id;
  if char_length(v_body) = 0 or char_length(v_body) > 270 then raise exception 'BAD_MESSAGE'; end if;
  if exists (select 1 from chat_messages where from_team = t.id and body like '📢 %' and at > now() - interval '45 seconds') then
    raise exception 'SLOW_DOWN';
  end if;
  insert into chat_messages(arena_id, from_team, to_team, body)
  select t.arena_id, t.id, d.id, '📢 ' || v_body from teams d
  where d.arena_id = t.arena_id and d.ready and d.id <> t.id
    and not exists (select 1 from chat_blocks where team_id = d.id and blocked_team = t.id);
  get diagnostics v_n = row_count;
  perform _ping_arena(t.arena_id, 'chat');
  return jsonb_build_object('sent', true, 'to', v_n);
end $$;

-- the sender keeps one copy of each broadcast in its own list (the other copies are for the recipients)
do $$
declare f record; src text; out text; v_n int := 0;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%(cm.from_team = t.id or (cm.to_team = t.id%' loop
    src := pg_get_functiondef(f.sig);
    out := replace(src, '(cm.from_team = t.id or (cm.to_team = t.id',
      '((cm.from_team = t.id and not (cm.body like ''📢 %'' and exists (select 1 from chat_messages c2 where c2.from_team = cm.from_team and c2.body = cm.body and c2.at = cm.at and c2.id < cm.id))) or (cm.to_team = t.id');
    execute out; v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'comms patch did not apply'; end if;
end $$;

-- execute rights (adds squad_equip)
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
        'host_online_auto', 'host_online_launch', 'online_event_info', 'online_join_segue', 'squad_equip']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
