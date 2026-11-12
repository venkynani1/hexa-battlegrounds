-- ═══════════════════════════════════════════════════════════════════════════
-- v8 · Online edition (the same game, played from laptops on a Teams call)
--
--  1. Sign-in with a 10-digit employee ID and the company e-mail (both unique per event).
--     Rejoining with the same ID and e-mail restores the player on a new device.
--  2. Three ways into a squad: create one (and share its 4-letter squad code), join with a
--     code, or "find me a squad" (matchmaking fills squads of 4).
--  3. Squads of 4; a squad of 3 is ready to play. At take-off squads of 1–2 are merged
--     (pairs and singles into 3s and 4s, then into squads of 3, then by borrowing one
--     player from squads of 4), so nobody is left behind.
--  4. Maps open by themselves: when every open map is full, the next map is created
--     (up to online_max_maps).
--  5. In a squad of 3 one player also holds the missing role and sees its clue.
--  6. Squad chat (messages and quick pings) and the teammates' e-mails for the Teams
--     call / chat buttons — only ever shown to the player's own squad.
--  7. Attendance export for the host (employee ID, e-mail, name, squad, map, times).
-- Safe to run more than once. In-person events are unchanged (setting online = 0).
-- ═══════════════════════════════════════════════════════════════════════════

alter table teams add column if not exists squad_code text;
alter table teams add column if not exists open_squad boolean not null default false;
alter table players add column if not exists role2 text;
create unique index if not exists teams_code_uniq on teams(event_id, squad_code) where squad_code is not null;

create table if not exists online_members (
  event_id uuid not null references events(id) on delete cascade,
  emp_id text not null check (emp_id ~ '^[0-9]{10}$'),
  email text not null check (char_length(email) between 5 and 120),
  player_id uuid references players(id) on delete set null,
  name text not null,
  first_joined_at timestamptz not null default now(),
  primary key (event_id, emp_id)
);
create unique index if not exists online_members_email_uniq on online_members(event_id, lower(email));
create index if not exists online_members_player_idx on online_members(player_id);

create table if not exists squad_chat (
  id bigserial primary key,
  team_id uuid not null references teams(id) on delete cascade,
  player_id uuid references players(id) on delete set null,
  name text not null,
  kind text not null default 'msg' check (kind in ('msg', 'ping', 'system')),
  body text not null check (char_length(body) between 1 and 240),
  at timestamptz not null default now()
);
create index if not exists squad_chat_team_idx on squad_chat(team_id, id);

do $$
declare t text;
begin
  foreach t in array array['online_members', 'squad_chat'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

drop function if exists _defaults_v7();
alter function _defaults() rename to _defaults_v7;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v7() || jsonb_build_object(
    'online', 0,               -- 1 = online edition (employee ID + e-mail sign-in, matchmaking, auto maps)
    'online_max_maps', 8,      -- how many maps may open by themselves
    'email_domain', '')        -- e.g. 'hexaware.com' (comma-separated); empty = any e-mail
$$;

-- ── helpers ─────────────────────────────────────────────────────────────────
create or replace function _squad_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 4)
$$;

create or replace function _online_size(p_team uuid) returns int
language sql stable as $$ select count(*)::int from players where team_id = p_team and active $$;

-- a map that still accepts squads (not departed, not full); opens a new one when needed
create or replace function _online_arena(p_ev uuid) returns uuid
language plpgsql as $$
declare v_arena uuid; v_size int; v_n int;
begin
  v_size := _cfg(p_ev, 'arena_size');
  select a.id into v_arena from arenas a
  where a.event_id = p_ev and a.phase in ('lobby', 'boarding')
    and (select count(*) from teams t where t.arena_id = a.id) < v_size
  order by a.number limit 1;
  if v_arena is not null then return v_arena; end if;
  select count(*) into v_n from arenas where event_id = p_ev;
  if v_n >= _cfg(p_ev, 'online_max_maps') then raise exception 'ALL_MAPS_FULL'; end if;
  insert into arenas(event_id, number, name)
  values (p_ev, (select coalesce(max(number), 0) + 1 from arenas where event_id = p_ev),
          'Map ' || (select coalesce(max(number), 0) + 1 from arenas where event_id = p_ev))
  returning id into v_arena;
  insert into audit_log(event_id, arena_id, actor, action) values (p_ev, v_arena, 'online', 'map_opened');
  return v_arena;
end $$;

create or replace function _online_new_team(p_ev uuid, p_open boolean) returns teams
language plpgsql as $$
declare v_arena uuid; v_team teams; v_salt text := _new_token(); v_code text; i int := 0;
begin
  v_arena := _online_arena(p_ev);
  loop
    v_code := _squad_code(); i := i + 1;
    exit when not exists (select 1 from teams where event_id = p_ev and squad_code = v_code) or i > 20;
  end loop;
  insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash, squad_code, open_squad)
  values (p_ev, v_arena, (select coalesce(max(number), 0) + 1 from teams where event_id = p_ev), null,
          v_salt, _hash(v_salt || _new_token()), v_code, p_open)
  returning * into v_team;
  perform _add_item(v_team.id, 'pistol', 1);
  perform _add_item(v_team.id, 'medkit', 1);
  return v_team;
end $$;

-- squads of 3 are ready; a squad of 4 is full and locked
create or replace function _online_refresh(p_team uuid) returns void
language plpgsql as $$
declare n int; t teams;
begin
  select * into t from teams where id = p_team;
  if t.id is null then return; end if;
  n := _online_size(p_team);
  if n = 0 then
    delete from teams where id = p_team;
    return;
  end if;
  update teams set ready = n >= 3, roster_locked = n >= 4 where id = p_team;
  if n >= 3 and not t.ready then perform _feed(t.arena_id, 'team.ready', jsonb_build_object('team', t.number)); end if;
  perform _ping_team(p_team, 'roster');
  perform _ping_arena(t.arena_id, 'roster');
end $$;

create or replace function _online_move(p_player uuid, p_team uuid) returns void
language plpgsql as $$
declare v_old uuid;
begin
  select team_id into v_old from players where id = p_player;
  if v_old = p_team then return; end if;
  update players set team_id = p_team, role = null, role2 = null where id = p_player;
  insert into squad_chat(team_id, name, kind, body)
  select p_team, 'Hexa Air', 'system', display_name || ' joined the squad' from players where id = p_player;
  perform _online_refresh(v_old);
  perform _online_refresh(p_team);
end $$;

-- ── sign-in ─────────────────────────────────────────────────────────────────
-- p_mode: 'rejoin' (same ID + e-mail on a new device), 'create', 'join' (with p_code), 'queue'
create or replace function online_join(p_event_code text, p_emp_id text, p_email text, p_name text, p_mode text,
  p_code text default null, p_consent boolean default false, p_existing_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e events; m online_members; p players; t teams; v_token text; v_email text; v_emp text; v_name text;
  v_domains text; v_ok boolean; d text; v_phase text; v_started boolean;
begin
  select * into e from events where code = upper(trim(coalesce(p_event_code, '')));
  if e.id is null then raise exception 'NO_EVENT'; end if;
  if _cfg(e.id, 'online') <> 1 then raise exception 'NOT_ONLINE_EVENT'; end if;
  perform pg_advisory_xact_lock(hashtext('online:' || e.id::text));
  v_started := coalesce(_cfg(e.id, 'online_started'), 0) = 1;   -- the host pressed Start (v10)

  v_emp := regexp_replace(coalesce(p_emp_id, ''), '\s', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  v_name := trim(coalesce(p_name, ''));
  if v_emp !~ '^[0-9]{10}$' then raise exception 'BAD_EMP_ID'; end if;
  if v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_email) > 120 then raise exception 'BAD_EMAIL'; end if;
  v_domains := coalesce(_cfg_text(e.id, 'email_domain'), '');
  if v_domains <> '' then
    v_ok := false;
    foreach d in array string_to_array(replace(lower(v_domains), ' ', ''), ',') loop
      if d <> '' and (v_email like '%@' || d or v_email like '%.' || d) then v_ok := true; end if;
    end loop;
    if not v_ok then raise exception 'EMAIL_DOMAIN'; end if;
  end if;

  if (select count(*) from pin_failures where event_id = e.id and team_number = -1000 and at > now() - interval '5 minutes') >= 40 then
    raise exception 'LOCKED_OUT';
  end if;

  select * into m from online_members where event_id = e.id and emp_id = v_emp;
  if m.emp_id is not null and lower(m.email) <> v_email then
    insert into pin_failures(event_id, team_number) values (e.id, -1000);
    return jsonb_build_object('error', 'EMP_ID_TAKEN');
  end if;
  if m.emp_id is null and exists (select 1 from online_members where event_id = e.id and lower(email) = v_email) then
    return jsonb_build_object('error', 'EMAIL_TAKEN');
  end if;
  if m.player_id is not null then select * into p from players where id = m.player_id and active; end if;

  -- a returning player: new session for this device; optionally switch squads while still at the gate
  if p.id is not null then
    select * into t from teams where id = p.team_id;
    select phase into v_phase from arenas where id = t.arena_id;
    if p_existing_token is not null and p.session_hash = _hash(p_existing_token) then v_token := p_existing_token;
    else v_token := _new_token(); update players set session_hash = _hash(v_token) where id = p.id; end if;
    if coalesce(p_mode, 'rejoin') <> 'rejoin' and v_phase in ('lobby', 'boarding') and not v_started then
      if p_mode = 'join' then
        select * into t from teams where event_id = e.id and squad_code = upper(trim(coalesce(p_code, '')));
        if t.id is null then insert into pin_failures(event_id, team_number) values (e.id, -1000); return jsonb_build_object('error', 'BAD_SQUAD_CODE', 'token', v_token); end if;
        if (select phase from arenas where id = t.arena_id) not in ('lobby', 'boarding') then return jsonb_build_object('error', 'SQUAD_GONE', 'token', v_token); end if;
        if t.id <> p.team_id and _online_size(t.id) >= 4 then return jsonb_build_object('error', 'TEAM_FULL', 'token', v_token); end if;
        perform _online_move(p.id, t.id);
      elsif p_mode = 'create' then
        t := _online_new_team(e.id, false);
        perform _online_move(p.id, t.id);
      elsif p_mode = 'queue' and not (select open_squad from teams where id = p.team_id) then
        select x.* into t from teams x join arenas a on a.id = x.arena_id
        where x.event_id = e.id and x.open_squad and a.phase in ('lobby', 'boarding') and x.id <> p.team_id
          and (select count(*) from players q where q.team_id = x.id and q.active) between 1 and 3
        order by (select count(*) from players q where q.team_id = x.id and q.active) desc, x.created_at limit 1;
        if t.id is null then t := _online_new_team(e.id, true); end if;
        perform _online_move(p.id, t.id);
      end if;
    end if;
    select * into t from teams where id = (select team_id from players where id = p.id);
    return jsonb_build_object('token', v_token, 'team', t.number, 'code', t.squad_code, 'rejoined', true);
  end if;

  if p_mode = 'rejoin' then return jsonb_build_object('error', 'NOT_REGISTERED'); end if;
  if not coalesce(p_consent, false) then raise exception 'CONSENT_REQUIRED'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'BAD_NAME'; end if;

  if p_mode = 'join' then
    select * into t from teams where event_id = e.id and squad_code = upper(trim(coalesce(p_code, '')));
    if t.id is null then
      insert into pin_failures(event_id, team_number) values (e.id, -1000);
      return jsonb_build_object('error', 'BAD_SQUAD_CODE');
    end if;
    if (v_started and not _online_open(t.id)) or (not v_started and (select phase from arenas where id = t.arena_id) not in ('lobby', 'boarding')) then
      return jsonb_build_object('error', 'SQUAD_GONE');
    end if;
    if _online_size(t.id) >= 4 then return jsonb_build_object('error', 'TEAM_FULL'); end if;
  elsif v_started and p_mode = 'create' then
    raise exception 'GAME_STARTED';
  elsif v_started and p_mode = 'queue' then
    -- late player: the fullest squad with a seat that has not landed yet
    select * into t from teams where id = _online_late_team(e.id);
    if t.id is null then raise exception 'NO_OPEN_SEATS'; end if;
  elsif p_mode = 'create' then
    t := _online_new_team(e.id, false);
  elsif p_mode = 'queue' then
    -- fill the fullest open squad first, so squads complete quickly
    select x.* into t from teams x join arenas a on a.id = x.arena_id
    where x.event_id = e.id and x.open_squad and a.phase in ('lobby', 'boarding')
      and (select count(*) from players q where q.team_id = x.id and q.active) between 1 and 3
    order by (select count(*) from players q where q.team_id = x.id and q.active) desc, a.number, x.created_at limit 1;
    if t.id is null then t := _online_new_team(e.id, true); end if;
  else
    raise exception 'BAD_MODE';
  end if;

  if exists (select 1 from players where team_id = t.id and active and lower(display_name) = lower(v_name)) then
    v_name := left(v_name, 36) || ' ' || right(v_emp, 3);
  end if;
  v_token := _new_token();
  insert into players(team_id, display_name, session_hash, consent)
  values (t.id, v_name, _hash(v_token), true) returning * into p;
  if m.emp_id is null then
    insert into online_members(event_id, emp_id, email, player_id, name) values (e.id, v_emp, v_email, p.id, v_name);
  else
    update online_members set player_id = p.id, name = v_name where event_id = e.id and emp_id = v_emp;
  end if;
  insert into squad_chat(team_id, name, kind, body) values (t.id, 'Hexa Air', 'system', v_name || ' checked in');
  perform _feed(t.arena_id, 'player.joined', jsonb_build_object('team', t.number, 'count', _online_size(t.id)));
  if v_started then
    -- a late player takes over a role the squad was covering with a second clue
    update players set role2 = null, role2_bot = false where team_id = t.id and role2 is not null;
    update teams set ready = true, roster_locked = _online_size(t.id) >= 4 where id = t.id;
    insert into squad_chat(team_id, name, kind, body) values (t.id, 'Hexa Air', 'system', '🪂 ' || v_name || ' joined late — welcome!');
    perform _ping_team(t.id, 'roster');
    return jsonb_build_object('token', v_token, 'team', t.number, 'code', t.squad_code, 'rejoined', false, 'late', true);
  end if;
  perform _online_refresh(t.id);
  return jsonb_build_object('token', v_token, 'team', t.number, 'code', t.squad_code, 'rejoined', false);
end $$;

-- ── take-off: nobody is left in a squad of 1 or 2 ───────────────────────────
create or replace function _online_seal(p_arena uuid) returns jsonb
language plpgsql as $$
declare u record; v record; x record; v_t uuid; v_need int; v_moved int := 0; v_left int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('online:' || (select event_id from arenas where id = p_arena)::text));
  -- 1. merge small squads into each other (pair + pair = 4, pair + single = 3, three singles = 3)
  for u in select t.id from teams t where t.arena_id = p_arena order by _online_size(t.id) desc, t.open_squad, t.created_at loop
    continue when _online_size(u.id) not between 1 and 2;
    loop
      exit when _online_size(u.id) >= 3;
      select t.id into v_t from teams t
      where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) between 1 and 2
        and _online_size(t.id) <= 4 - _online_size(u.id)
      order by _online_size(t.id) desc, t.created_at limit 1;
      exit when v_t is null;
      for x in select id from players where team_id = v_t and active loop perform _online_move(x.id, u.id); v_moved := v_moved + 1; end loop;
    end loop;
  end loop;
  -- 2. whoever is still in a squad of 1–2 tops up squads of 3 (matchmade squads first)
  for u in select t.id from teams t where t.arena_id = p_arena and _online_size(t.id) between 1 and 2 loop
    for x in select id from players where team_id = u.id and active loop
      select t.id into v_t from teams t where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) = 3
      order by t.open_squad desc, t.created_at limit 1;
      exit when v_t is null;
      perform _online_move(x.id, v_t); v_moved := v_moved + 1;
    end loop;
  end loop;
  -- 3. still short: borrow one player each from squads of 4 (matchmade squads first)
  for u in select t.id from teams t where t.arena_id = p_arena and _online_size(t.id) between 1 and 2 loop
    v_need := 3 - _online_size(u.id);
    for v in select t.id from teams t where t.arena_id = p_arena and t.id <> u.id and _online_size(t.id) = 4
             order by t.open_squad desc, t.created_at limit v_need loop
      select id into v_t from players where team_id = v.id and active order by joined_at desc limit 1;
      perform _online_move(v_t, u.id); v_moved := v_moved + 1;
    end loop;
    if _online_size(u.id) < 3 then v_left := v_left + _online_size(u.id); end if;
  end loop;
  update teams set roster_locked = true where arena_id = p_arena and ready;
  return jsonb_build_object('moved', v_moved, 'left_out', v_left);
end $$;

drop function if exists _host_exec_v8(uuid, uuid, text, jsonb, text);
alter function _host_exec(uuid, uuid, text, jsonb, text) rename to _host_exec_v8;
create function _host_exec(p_ev uuid, p_arena uuid, p_cmd text, p_args jsonb, p_reason text) returns jsonb
language plpgsql as $$
declare v_seal jsonb;
begin
  if p_cmd = 'drive' and p_arena is not null and _cfg(p_ev, 'online') = 1 then
    v_seal := _online_seal(p_arena);
    if (v_seal ->> 'moved')::int > 0 then
      perform _feed(p_arena, 'online.sealed', v_seal);
    end if;
  end if;
  return _host_exec_v8(p_ev, p_arena, p_cmd, p_args, p_reason);
end $$;

-- ── squads of 3: one player also holds the missing role ─────────────────────
drop function if exists _auto_roles_v8(uuid);
alter function _auto_roles(uuid) rename to _auto_roles_v8;
create function _auto_roles(p_arena uuid) returns boolean
language plpgsql as $$
declare v_any boolean; t record; r text; v_p uuid;
begin
  v_any := _auto_roles_v8(p_arena);
  for t in select tm.id from teams tm where tm.arena_id = p_arena and tm.ready
           and (select count(*) from players q where q.team_id = tm.id and q.active and q.role is not null) = 3
           and (select count(*) from players q where q.team_id = tm.id and q.active) = 3 loop
    select x into r from unnest(array['captain', 'scout', 'decoder', 'intel']) x
    where not exists (select 1 from players q where q.team_id = t.id and q.active and (q.role = x or q.role2 = x)) limit 1;
    continue when r is null;
    select id into v_p from players where team_id = t.id and active and role2 is null
    order by (role = 'captain'), random() limit 1;
    update players set role2 = r where id = v_p;
    insert into squad_chat(team_id, name, kind, body)
    select t.id, 'Hexa Air', 'system', display_name || ' also covers the ' || r || ' role (squad of 3)' from players where id = v_p;
    perform _ping_team(t.id, 'roles');
    v_any := true;
  end loop;
  return v_any;
end $$;

-- ── squad chat ──────────────────────────────────────────────────────────────
create or replace function squad_chat_send(p_token text, p_body text, p_kind text default 'msg') returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; v_body text := trim(coalesce(p_body, '')); v_id bigint;
begin
  p := _auth_player(p_token);
  if coalesce(p_kind, 'msg') not in ('msg', 'ping') then raise exception 'BAD_KIND'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 240 then raise exception 'BAD_MESSAGE'; end if;
  if (select count(*) from squad_chat where player_id = p.id and at > now() - interval '10 seconds') >= 6 then
    raise exception 'SLOW_DOWN';
  end if;
  insert into squad_chat(team_id, player_id, name, kind, body) values (p.team_id, p.id, p.display_name, coalesce(p_kind, 'msg'), v_body)
  returning id into v_id;
  perform _ping_team(p.team_id, 'chat');
  return jsonb_build_object('id', v_id);
end $$;

create or replace function squad_chat(p_token text, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players;
begin
  p := _auth_player(p_token);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'body', c.body, 'at', c.at,
            'me', c.player_id = p.id) order by c.id), '[]'::jsonb)
          from (select * from squad_chat where team_id = p.team_id and id > coalesce(p_after, 0) order by id desc limit 60) c);
end $$;

-- ── what the phone sees (only its own squad's e-mails, for the Teams buttons) ──
drop function if exists _player_state_v8(text);
alter function player_state(text) rename to _player_state_v8;
create function player_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; p players; t teams; v_clues jsonb; v_id uuid;
begin
  v := _player_state_v8(p_token);
  p := _auth_player(p_token);
  if _cfg((select event_id from teams where id = p.team_id), 'online') <> 1 and p.role2 is null then return v; end if;
  select * into t from teams where id = p.team_id;
  if p.role2 is not null then
    v := jsonb_set(v, '{me}', (v -> 'me') || jsonb_build_object('role2', p.role2));
    for v_id in select (v -> k ->> 'id')::uuid from unnest(array['mission', 'battle']) k where jsonb_typeof(v -> k) = 'object' and (v -> k ->> 'id') is not null loop
      select mt.clues into v_clues from mission_instances mi join mission_templates mt on mt.id = mi.template_id where mi.id = v_id;
      if v_clues ? p.role2 then
        if v -> 'mission' ->> 'id' = v_id::text then v := jsonb_set(v, '{mission,clue2}', v_clues -> p.role2);
        else v := jsonb_set(v, '{battle,clue2}', v_clues -> p.role2); end if;
      end if;
    end loop;
  end if;
  if _cfg(t.event_id, 'online') = 1 then
    v := v || jsonb_build_object('online', jsonb_build_object(
      'code', t.squad_code, 'open', t.open_squad,
      'size', _online_size(t.id),
      'squad', (select coalesce(jsonb_agg(jsonb_build_object('name', q.display_name, 'email', m.email, 'me', q.id = p.id,
                  'online', q.last_seen_at > now() - interval '30 seconds', 'role', q.role, 'role2', q.role2) order by q.joined_at), '[]'::jsonb)
                from players q left join online_members m on m.player_id = q.id where q.team_id = t.id and q.active),
      'chat_last', (select max(id) from squad_chat where team_id = t.id)));
  end if;
  return v;
end $$;

-- ── host: attendance export and a quick online summary ──────────────────────
create or replace function host_attendance(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  insert into audit_log(event_id, actor, action) values (v_ev, 'host', 'attendance_export');
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'emp_id', m.emp_id, 'email', m.email, 'name', m.name,
      'squad', t.number, 'squad_name', t.name, 'squad_code', t.squad_code, 'map', a.number,
      'size', (select count(*) from players q where q.team_id = t.id and q.active),
      'role', p.role, 'joined_at', m.first_joined_at, 'last_seen_at', p.last_seen_at,
      'points', t.points) order by a.number, t.number, m.name), '[]'::jsonb)
    from online_members m left join players p on p.id = m.player_id
    left join teams t on t.id = p.team_id left join arenas a on a.id = t.arena_id
    where m.event_id = v_ev);
end $$;

create or replace function host_online_summary(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return jsonb_build_object(
    'players', (select count(*) from online_members where event_id = v_ev),
    'max_maps', _cfg(v_ev, 'online_max_maps'),
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
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
