-- ═══════════════════════════════════════════════════════════════════════════
-- v9 · Disconnected teammates, a bot that covers them, no leaderboard during the match
--
--  1. A player whose phone or laptop has been silent for away_seconds (60) is "away":
--     • if they were the captain, the first online teammate becomes captain until they return;
--     • a bot covers their role: an online teammate receives that role's clue as a second clue
--       (marked as relayed by the bot), so the squad can still solve every challenge.
--     When the player comes back the bot leaves and their role (and the captaincy) is handed back.
--     Every change is announced in squad chat; phones show who is online, reconnecting or covered.
--  2. Rankings stay hidden during the match: player and projector states carry no leaderboard
--     until the results; then only the winner is shown.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

alter table players add column if not exists away boolean not null default false;
alter table players add column if not exists away_at timestamptz;
alter table players add column if not exists orig_role text;
alter table players add column if not exists role2_bot boolean not null default false;
alter table arenas add column if not exists watch_at timestamptz;

-- squad_chat comes with the online edition; in-person events use it for these notices too
create table if not exists squad_chat (
  id bigserial primary key,
  team_id uuid not null references teams(id) on delete cascade,
  player_id uuid references players(id) on delete set null,
  name text not null,
  kind text not null default 'msg' check (kind in ('msg', 'ping', 'system')),
  body text not null check (char_length(body) between 1 and 240),
  at timestamptz not null default now()
);

drop function if exists _defaults_v8();
alter function _defaults() rename to _defaults_v8;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v8() || jsonb_build_object(
    'away_seconds', 60)        -- silent this long = away: a bot covers the role, captaincy moves on
$$;

create or replace function _sq_note(p_team uuid, p_body text) returns void
language sql as $$
  insert into squad_chat(team_id, name, kind, body) values (p_team, 'Hexa Air', 'system', left(p_body, 240));
  select _ping_team(p_team, 'chat');
$$;

-- give one uncovered role to an online teammate as a bot-relayed second clue
create or replace function _sq_cover(p_team uuid, p_role text, p_gone uuid) returns uuid
language plpgsql as $$
declare v_holder uuid; v_name text; v_gone text;
begin
  if p_role is null or p_role = 'captain' then return null; end if;
  if exists (select 1 from players where team_id = p_team and active and not away and (role = p_role or role2 = p_role)) then return null; end if;
  select id, display_name into v_holder, v_name from players
  where team_id = p_team and active and not away and id <> p_gone and role is not null and role2 is null
  order by (role = 'captain'), joined_at limit 1;
  select display_name into v_gone from players where id = p_gone;
  if v_holder is null then
    perform _sq_note(p_team, '🤖 ' || coalesce(v_gone, 'A teammate') || ' is offline — nobody is free to read the ' || p_role || ' clue');
    return null;
  end if;
  update players set role2 = p_role, role2_bot = true where id = v_holder;
  perform _sq_note(p_team, '🤖 Bot joined for ' || coalesce(v_gone, 'a teammate') || ' — ' || v_name || ' now also sees the ' || p_role || ' clue');
  return v_holder;
end $$;

create or replace function _squad_gone(p_player uuid) returns void
language plpgsql as $$
declare p players; q players; r text; v_r2 text;
begin
  select * into p from players where id = p_player;
  update players set away = true, away_at = now() where id = p_player;
  perform _sq_note(p.team_id, '📶 ' || p.display_name || ' disconnected');
  if p.role = 'captain' then
    select * into q from players where team_id = p.team_id and active and not away and id <> p.id and role is not null
    order by (role2 is not null), joined_at limit 1;
    if q.id is not null then
      r := q.role;
      update players set role = null where id in (p.id, q.id);
      update players set role = 'captain', orig_role = coalesce(orig_role, r) where id = q.id;
      update players set role = r, orig_role = 'captain' where id = p.id;
      perform _sq_note(p.team_id, '⭐ ' || q.display_name || ' is captain while ' || p.display_name || ' is away');
      p.role := r;
      -- the new captain no longer reads their old clue: if they had a bot clue, pass it on
      select role2 into v_r2 from players where id = q.id;
      if v_r2 is not null then
        update players set role2 = null, role2_bot = false where id = q.id;
        perform _sq_cover(p.team_id, v_r2, p.id);
      end if;
    end if;
  end if;
  if p.role2 is not null then
    update players set role2 = null, role2_bot = false where id = p.id;
    perform _sq_cover(p.team_id, p.role2, p.id);
  end if;
  perform _sq_cover(p.team_id, p.role, p.id);
  perform _ping_team(p.team_id, 'roles');
end $$;

create or replace function _squad_back(p_player uuid) returns void
language plpgsql as $$
declare p players; q players; r text;
begin
  select * into p from players where id = p_player;
  update players set away = false, away_at = null where id = p_player;
  -- the bot leaves: whoever was relaying this player's clue stops seeing it
  update players set role2 = null, role2_bot = false where team_id = p.team_id and role2_bot and role2 = p.role;
  if p.orig_role = 'captain' then
    select * into q from players where team_id = p.team_id and active and role = 'captain' and id <> p.id;
    if q.id is not null and q.orig_role is not null then
      r := q.orig_role;
      update players set role = null where id in (p.id, q.id);
      update players set role = 'captain', orig_role = null where id = p.id;
      update players set role = r, orig_role = null where id = q.id;
      -- the old stand-in captain reads their own clue again (drop a bot copy of it)
      update players set role2 = null, role2_bot = false where team_id = p.team_id and role2_bot and role2 = r;
      perform _sq_note(p.team_id, '⭐ ' || p.display_name || ' is back as captain');
    else
      update players set orig_role = null where id = p.id;
    end if;
  end if;
  perform _sq_note(p.team_id, '✅ ' || p.display_name || ' reconnected' || case when p.role is not null then ' — the bot left' else '' end);
  perform _ping_team(p.team_id, 'roles');
end $$;

create or replace function _squad_watch(p_arena uuid) returns boolean
language plpgsql as $$
declare t record; p record; v_any boolean := false; v_away int;
begin
  update arenas set watch_at = now()
  where id = p_arena and phase in ('shuttle', 'roles', 'play', 'finale') and (watch_at is null or watch_at < now() - interval '4 seconds');
  if not found then return false; end if;
  v_away := _cfg((select event_id from arenas where id = p_arena), 'away_seconds');
  for t in select tm.id from teams tm where tm.arena_id = p_arena and tm.ready
           and not exists (select 1 from bots b where b.team_id = tm.id) loop
    for p in select id from players where team_id = t.id and active and away and last_seen_at > now() - interval '20 seconds' loop
      perform _squad_back(p.id); v_any := true;
    end loop;
    for p in select id from players where team_id = t.id and active and not away and last_seen_at < now() - make_interval(secs => v_away) loop
      perform _squad_gone(p.id); v_any := true;
    end loop;
  end loop;
  return v_any;
end $$;

drop function if exists _tick_v9(uuid, boolean);
alter function _tick(uuid, boolean) rename to _tick_v9;
create function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare v boolean;
begin
  v := _tick_v9(p_arena, p_force);
  if _squad_watch(p_arena) then v := true; end if;
  return v;
end $$;

-- ── what phones and the projector see ──────────────────────────────────────
drop function if exists _player_state_v9(text);
alter function player_state(text) rename to _player_state_v9;
create function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; p players; ph text;
begin
  v := _player_state_v9(p_token);
  p := _auth_player(p_token);
  ph := v -> 'arena' ->> 'phase';
  -- squad strip like Free Fire: name, role(s), online / reconnecting / away (bot covering)
  v := v || jsonb_build_object('squad', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', q.display_name, 'me', q.id = p.id, 'role', q.role, 'role2', q.role2, 'bot2', q.role2_bot,
      'status', case when q.away then 'away' when q.last_seen_at > now() - interval '15 seconds' then 'on' else 'weak' end) order by q.joined_at), '[]'::jsonb)
    from players q where q.team_id = p.team_id and q.active));
  v := jsonb_set(v, '{me}', (v -> 'me') || jsonb_build_object('role2', p.role2, 'role2_bot', p.role2_bot));
  v := v || jsonb_build_object('chat_last', (select max(id) from squad_chat where team_id = p.team_id));
  if ph not in ('results', 'ended') then v := v - 'leaderboard'; end if;
  return v;
end $$;

drop function if exists _spectator_state_v9(text);
alter function spectator_state(text) rename to _spectator_state_v9;
create function spectator_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  v := _spectator_state_v9(p_token);
  if v -> 'arena' is not null and (v -> 'arena' ->> 'phase') not in ('results', 'ended') then
    v := v - 'leaderboard';
    if jsonb_typeof(v -> 'squads') = 'array' then
      v := jsonb_set(v, '{squads}', (select coalesce(jsonb_agg(s - 'points' - 'final_points' - 'rank'), '[]'::jsonb) from jsonb_array_elements(v -> 'squads') s));
    end if;
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
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
do $$
declare t text;
begin
  foreach t in array array['squad_chat'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;
