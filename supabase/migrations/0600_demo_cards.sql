-- ═══════════════════════════════════════════════════════════════════════════
-- v5 · Fixed squad cards + Demo mode with dummy squads
--
--  1. Fixed squad cards: the same PIN and the same QR code for every squad number, every time
--     the host creates an event with the same host password. PINs are derived on the server
--     from the host password and a secret that never leaves the database; only hashes are stored.
--  2. Demo mode: one call creates an event full of dummy squads (4 dummy players each) that
--     drop, drive, search, solve, fight, grab crates, run from lockdowns and play the finale.
--     The dummies use exactly the same captain actions as real phones, so every game rule applies.
--     A host can open any dummy player's phone view, or take a squad over.
--
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

alter table events add column if not exists demo boolean not null default false;
alter table events add column if not exists card_set text;
alter table teams add column if not exists is_bot boolean not null default false;
create index if not exists events_card_set_idx on events(card_set) where card_set is not null;

create table if not exists app_secrets (
  key text primary key,
  value text not null
);
create table if not exists bots (
  team_id uuid primary key references teams(id) on delete cascade,
  arena_id uuid not null references arenas(id) on delete cascade,
  manual boolean not null default false,     -- a person took this squad over
  skill real not null default 0.75,          -- chance of a right answer on the first try
  goal text,                                 -- location the squad is driving to
  goal_at timestamptz,
  done_loc text,                             -- last place it searched
  wait_until timestamptz,
  think_for uuid,                            -- mission instance being "solved"
  think_until timestamptz,
  think_ok boolean
);
create index if not exists bots_arena_idx on bots(arena_id);
create table if not exists bot_players (
  player_id uuid primary key references players(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  idx int not null,                          -- 1 captain · 2 scout · 3 decoder · 4 intel
  token text not null
);
create index if not exists bot_players_team_idx on bot_players(team_id);
create table if not exists bot_clock (
  arena_id uuid primary key references arenas(id) on delete cascade,
  at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['app_secrets', 'bots', 'bot_players', 'bot_clock'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

-- ── 1. Fixed squad cards ────────────────────────────────────────────────────
create or replace function _card_secret() returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select value into v from app_secrets where key = 'card_pepper';
  if v is null then
    insert into app_secrets(key, value) values ('card_pepper', _new_token() || _new_token()) on conflict (key) do nothing;
    select value into v from app_secrets where key = 'card_pepper';
  end if;
  return v;
end $$;

create or replace function _card_pin(p_secret text, p_number int) returns text
language plpgsql security definer set search_path = public as $$
declare v text; i int := 0; h text;
begin
  loop
    h := _hash(_card_secret() || '|pin|' || coalesce(p_secret, '') || '|' || p_number || '|' || i);
    v := lpad(((('x' || substr(h, 1, 12))::bit(48)::bigint) % 1000000)::text, 6, '0');
    exit when not _weak_pin(v) or i >= 20;
    i := i + 1;
  end loop;
  return v;
end $$;

-- Creates (or re-keys) squads 1..15 on Map 1, 16..30 on Map 2, … with the host's fixed PINs.
-- Players who already joined stay in their squads. Returns the cards for printing.
create or replace function host_fixed_cards(p_token text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; e events; ar arenas; t teams; i int; v_num int; v_pin text; v_salt text; v_size int; v_set text;
  v_out jsonb := '[]'::jsonb; v_new int := 0;
begin
  v_ev := _auth_host(p_token);
  select * into e from events where id = v_ev;
  if e.host_secret_hash <> _hash(e.host_salt || coalesce(p_secret, '')) then
    insert into audit_log(event_id, actor, action, ok) values (v_ev, 'host', 'fixed_cards_denied', false);
    return jsonb_build_object('error', 'HOST_AUTH');
  end if;
  v_size := least(15, greatest(1, _cfg(v_ev, 'arena_size')));
  v_set := substr(_hash(_card_secret() || '|set|' || p_secret), 1, 10);
  for ar in select * from arenas where event_id = v_ev order by number loop
    for i in 1..v_size loop
      v_num := (ar.number - 1) * v_size + i;
      v_pin := _card_pin(p_secret, v_num);
      v_salt := _new_token();
      select * into t from teams where event_id = v_ev and number = v_num;
      if t.id is null then
        continue when ar.phase <> 'lobby';
        insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash)
        values (v_ev, ar.id, v_num, null, v_salt, _hash(v_salt || v_pin)) returning * into t;
        perform _add_item(t.id, 'pistol', 1);
        perform _add_item(t.id, 'medkit', 1);
        v_new := v_new + 1;
      else
        update teams set pin_salt = v_salt, pin_hash = _hash(v_salt || v_pin) where id = t.id;
      end if;
      v_out := v_out || jsonb_build_object('number', v_num, 'name', t.name, 'pin', v_pin, 'bus', t.bus,
        'map', (select number from arenas where id = t.arena_id));
    end loop;
  end loop;
  update events set card_set = v_set where id = v_ev;
  insert into audit_log(event_id, actor, action, args) values (v_ev, 'host', 'fixed_cards', jsonb_build_object('created', v_new, 'set', v_set));
  return jsonb_build_object('set', v_set, 'created', v_new, 'squads', v_out);
end $$;

-- A fixed card's QR code carries only the card-set id and the squad number (no secrets).
-- This finds the event those cards currently belong to: the newest one that uses the set.
create or replace function card_event(p_set text) returns jsonb
language sql stable security definer set search_path = public as $$
  select (select jsonb_build_object('code', code, 'name', name) from events
          where card_set = lower(left(coalesce(p_set, ''), 20)) and not demo order by created_at desc limit 1)
$$;

-- ── 2. Demo mode ────────────────────────────────────────────────────────────
create or replace function _demo_purge(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from events where id = p_event and demo) then return; end if;
  update arenas set sync_round_id = null where event_id = p_event;
  delete from submissions where team_id in (select id from teams where event_id = p_event);
  delete from mission_instances where arena_id in (select id from arenas where event_id = p_event);
  delete from battles where arena_id in (select id from arenas where event_id = p_event);
  delete from airdrops where arena_id in (select id from arenas where event_id = p_event);
  delete from alliances where arena_id in (select id from arenas where event_id = p_event);
  delete from events where id = p_event;
exception when others then
  null; -- never block a new demo because an old one would not delete
end $$;

create or replace function demo_create(p_maps int default 1, p_squads int default 15, p_length text default 'quick') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_maps int := least(3, greatest(1, coalesce(p_maps, 1))); v_squads int := least(15, greatest(2, coalesce(p_squads, 15)));
  v_len text := case when p_length in ('quick', 'standard', 'full') then p_length else 'quick' end;
  v_code text; v_secret text := _new_token(); v_res jsonb; v_ev uuid; v_host text; ar arenas; t teams; r record;
  i int; k int; v_tok text; v_pid uuid; v_salt text; v_n int := 0;
  v_names text[] := array['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Isha', 'Arjun', 'Sana', 'Dev', 'Kavya', 'Nikhil', 'Priya',
    'Rahul', 'Tara', 'Imran', 'Neha', 'Sanjay', 'Lakshmi', 'Farhan', 'Pooja', 'Karthik', 'Divya', 'Aditya', 'Riya', 'Manoj', 'Sneha', 'Varun', 'Anjali',
    'Harish', 'Nisha', 'Gautam', 'Swathi', 'Naveen', 'Deepa', 'Suresh', 'Keerthi', 'Ajay', 'Bhavna', 'Yash', 'Shreya', 'Pranav', 'Aisha', 'Kiran', 'Maya',
    'Rishi', 'Tanvi', 'Siddharth', 'Nandini', 'Vivek', 'Asha', 'Abhinav', 'Ritu', 'Mohan', 'Gayathri', 'Tarun', 'Leela', 'Ashwin', 'Revathi'];
begin
  for r in select id from events where demo and created_at < now() - interval '3 hours' loop
    perform _demo_purge(r.id);
  end loop;
  if (select count(*) from events where demo and created_at > now() - interval '20 minutes') >= 6 then raise exception 'DEMO_BUSY'; end if;
  loop
    v_code := 'DEMO' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
    exit when not exists (select 1 from events where code = v_code);
  end loop;
  v_res := host_create_event(v_code, 'Demo match · Operation Siruseri', v_secret, v_maps);
  v_ev := (v_res ->> 'event_id')::uuid; v_host := v_res ->> 'token';
  update events set demo = true where id = v_ev;
  for ar in select * from arenas where event_id = v_ev order by number loop
    for i in 1..v_squads loop
      v_n := v_n + 1; v_salt := _new_token();
      insert into teams(event_id, arena_id, number, name, pin_salt, pin_hash, is_bot, ready, roster_locked)
      values (v_ev, ar.id, v_n, null, v_salt, _hash(v_salt || _new_token()), true, true, true) returning * into t;
      perform _add_item(t.id, 'pistol', 1);
      perform _add_item(t.id, 'medkit', 1);
      insert into bots(team_id, arena_id, skill) values (t.id, ar.id, 0.4 + random() * 0.45);
      for k in 1..4 loop
        v_tok := _new_token();
        insert into players(team_id, display_name, session_hash, consent)
        values (t.id, v_names[1 + ((v_n - 1) * 4 + k - 1) % array_length(v_names, 1)], _hash(v_tok), true) returning id into v_pid;
        insert into bot_players(player_id, team_id, idx, token) values (v_pid, t.id, k, v_tok);
      end loop;
    end loop;
  end loop;
  perform host_command(v_host, null, 'start_match', jsonb_build_object('length', v_len), null);
  return jsonb_build_object('token', v_host, 'code', v_code, 'event_id', v_ev, 'maps', v_maps, 'squads', v_squads, 'length', v_len);
end $$;

-- Everything the demo control room needs: maps, projector links and the dummy squads.
create or replace function host_extras(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; e events;
begin
  v_ev := _auth_host(p_token);
  select * into e from events where id = v_ev;
  return jsonb_build_object('demo', e.demo, 'card_set', e.card_set, 'code', e.code,
    'maps', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'number', a.number, 'name', a.name, 'phase', a.phase,
        'spectator_token', a.spectator_token) order by a.number), '[]'::jsonb) from arenas a where a.event_id = v_ev),
    'bots', (select coalesce(jsonb_agg(jsonb_build_object('number', t.number, 'name', t.name, 'manual', b.manual,
        'map', (select number from arenas where id = t.arena_id), 'points', t.points + t.final_points, 'hp', t.hp) order by t.number), '[]'::jsonb)
      from bots b join teams t on t.id = b.team_id where t.event_id = v_ev));
end $$;

-- The phone view of one dummy player (demo events only).
create or replace function demo_view(p_token text, p_team int, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_tok text; v_idx int := array_position(array['captain', 'scout', 'decoder', 'intel'], p_role);
begin
  v_ev := _auth_host(p_token);
  if not exists (select 1 from events where id = v_ev and demo) then raise exception 'NOT_DEMO'; end if;
  if v_idx is null then raise exception 'BAD_ROLE'; end if;
  -- the player who holds the role, or (before roles are claimed) the one who is going to claim it
  select bp.token into v_tok from bot_players bp join players p on p.id = bp.player_id join teams t on t.id = bp.team_id
  where t.event_id = v_ev and t.number = p_team and p.active
  order by (p.role = p_role) desc nulls last, (p.role is null and bp.idx = v_idx) desc, bp.idx limit 1;
  if v_tok is null then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('token', v_tok);
end $$;

-- Is this phone watching a dummy squad? (Shown as a banner on the phone view.)
create or replace function demo_status(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; b bots;
begin
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  select * into b from bots where team_id = t.id;
  return jsonb_build_object('demo', (select demo from events where id = t.event_id), 'bot', b.team_id is not null and not b.manual,
    'manual', coalesce(b.manual, false), 'can_control', b.team_id is not null, 'squad', t.number);
end $$;

-- Take a dummy squad over (or hand it back).
create or replace function demo_control(p_token text, p_manual boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players;
begin
  p := _auth_player(p_token);
  update bots set manual = coalesce(p_manual, false), goal = null, think_for = null where team_id = p.team_id;
  if not found then raise exception 'NOT_DEMO'; end if;
  perform _ping_team(p.team_id, 'demo');
  return jsonb_build_object('manual', coalesce(p_manual, false));
end $$;

-- Keeps the demo's clock running from the control room, and ends it.
create or replace function demo_pulse(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; r record;
begin
  v_ev := _auth_host(p_token);
  if not exists (select 1 from events where id = v_ev and demo) then raise exception 'NOT_DEMO'; end if;
  for r in select id from arenas where event_id = v_ev loop perform _tick(r.id); end loop;
  return jsonb_build_object('ok', true);
end $$;

create or replace function demo_end(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  if not exists (select 1 from events where id = v_ev and demo) then raise exception 'NOT_DEMO'; end if;
  perform _demo_purge(v_ev);
  return jsonb_build_object('ok', true);
end $$;

-- ── 3. The dummy squads' brain ──────────────────────────────────────────────
create or replace function _bot_answers(mi mission_instances, p_ok boolean) returns jsonb
language plpgsql as $$
declare v jsonb := '[]'::jsonb; part jsonb; acc text;
begin
  for part in select value from jsonb_array_elements((select parts from mission_templates where id = mi.template_id)) loop
    acc := part -> 'accept' ->> 0;
    if acc = '{KEY}' then acc := coalesce(mi.relay_key, '?'); end if;
    v := v || to_jsonb(case when p_ok then coalesce(acc, '?') else 'not sure' end);
  end loop;
  return v;
end $$;

create or replace function _bot_act(p_team uuid) returns void
language plpgsql as $$
declare t teams; b bots; a arenas; mi mission_instances; g locations; bd buildings; lk record;
  tok text; cur float8[]; c float8[]; spd float8; dt float8; stepd float8; tx float8; ty float8; d float8; nx float8; ny float8;
  v_dir int := 0; v_goal text; v_res jsonb; v_target uuid; v_weapon text; v_air uuid; v_danger boolean := false; v_brave boolean;
  v_final boolean := false; v_px float8; v_py float8; v_side int;
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

  -- 2. parachute in
  if not t.dropped then
    c := _zone_circle(a.event_id, a.zone_stage);
    select l.id into v_goal from locations l
    where l.enabled and l.kind not in ('start', 'stairs') and l.level = 0 and _in_circle(c, l.x, l.y)
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

  -- 4. pick a fight with a squad in range (the game itself refuses it before duels unlock)
  if not v_danger and (t.attack_cooldown_until is null or t.attack_cooldown_until < now()) and random() < 0.10 then
    select x.id into v_target from teams x
    where x.arena_id = a.id and x.ready and x.id <> t.id and x.state = 'idle' and x.dropped and x.level = t.level
      and (x.protected_until is null or x.protected_until < now())
      and sqrt((coalesce(x.pos_x, 0) - cur[1]) ^ 2 + (coalesce(x.pos_y, 0) - cur[2]) ^ 2) <= _cfg(t.event_id, 'engage_range') / 1000.0
    order by random() limit 1;
    if v_target is not null then
      select i.id into v_weapon from inventory inv join items i on i.id = inv.item_id
      where inv.team_id = t.id and inv.qty > 0 and i.kind = 'weapon' order by (i.params ->> 'damage')::int desc limit 1;
      if v_weapon is not null then
        begin
          perform captain_attack(tok, v_target, v_weapon);
          return;
        exception when others then null;
        end;
      end if;
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

  -- 8. drive: straight to the place, or to the stairwell first when it is on another floor
  if t.level > 0 and (g.level = 0 or g.building is distinct from t.bldg or g.level <> t.level) then
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
  spd := _cfg(t.event_id, 'move_speed') / 1000.0;
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

create or replace function _bots_step(p_arena uuid) returns boolean
language plpgsql as $$
declare a arenas; r record; v_at timestamptz; v_role text;
begin
  if not pg_try_advisory_xact_lock(hashtext('bots' || p_arena::text)) then return false; end if;
  select at into v_at from bot_clock where arena_id = p_arena;
  if v_at is not null and v_at > now() - interval '900 milliseconds' then return false; end if;
  insert into bot_clock(arena_id, at) values (p_arena, now()) on conflict (arena_id) do update set at = excluded.at;
  select * into a from arenas where id = p_arena;
  if a.id is null or a.paused or a.phase not in ('roles', 'play', 'finale') then return false; end if;

  -- dummy players look connected
  update players set last_seen_at = now()
  where team_id in (select team_id from bots where arena_id = p_arena) and active and last_seen_at < now() - interval '10 seconds';

  if a.phase = 'roles' then
    -- each dummy claims "its" role, a few at a time, like people tapping at different speeds
    for r in select p.id, p.team_id, bp.idx from players p join bot_players bp on bp.player_id = p.id
             join bots b on b.team_id = p.team_id
             where b.arena_id = p_arena and not b.manual and p.active and p.role is null and random() < 0.4 loop
      v_role := (array['captain', 'scout', 'decoder', 'intel'])[r.idx];
      begin
        update players set role = v_role where id = r.id and role is null
          and not exists (select 1 from players q where q.team_id = r.team_id and q.active and q.role = v_role);
        if found then perform _ping_team(r.team_id, 'roles'); end if;
      exception when others then null;
      end;
    end loop;
    return true;
  end if;

  for r in select b.team_id from bots b join teams t on t.id = b.team_id
           where b.arena_id = p_arena and not b.manual and t.ready order by random() loop
    begin
      perform _bot_act(r.team_id);
    exception when others then
      null; -- a refused action (cooldown, sealed door, round just closed…) is part of the game
    end;
  end loop;
  return true;
end $$;

-- The game clock now also moves the dummy squads. The original clock keeps its body and is
-- simply wrapped, so nothing changes for events without dummies.
drop function if exists _tick_core(uuid, boolean);
alter function _tick(uuid, boolean) rename to _tick_core;
create function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare v boolean;
begin
  v := _tick_core(p_arena, p_force);
  if exists (select 1 from bots where arena_id = p_arena) then
    if _bots_step(p_arena) then v := true; end if;
  end if;
  return v;
end $$;

-- Positions for smooth movement: now also reports how old each position is, so screens can
-- place a squad exactly where it is between updates. Keeps a dummy match ticking too.
create or replace function arena_positions(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p players; t teams; v_scan boolean;
begin
  p := _auth_player(p_token);
  select * into t from teams where id = p.team_id;
  if exists (select 1 from bots where arena_id = t.arena_id) then perform _tick(t.arena_id); end if;
  v_scan := t.scan_until is not null and t.scan_until > now();
  return jsonb_build_object('server_now', now(), 'squads', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', tm.id, 'level', tm.level, 'bldg', tm.bldg, 'state', tm.state,
      'pos', to_jsonb(_team_xy(tm)),
      'age', case when tm.state = 'idle' and tm.pos_at is not null then round(extract(epoch from now() - tm.pos_at)::numeric, 2) end,
      'vel', case when tm.state = 'traveling' and tm.travel_arrive_at > now() and l.id is not null then
               jsonb_build_array((l.x - coalesce(tm.travel_fx, l.x)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)),
                                 (l.y - coalesce(tm.travel_fy, l.y)) / greatest(0.2, extract(epoch from tm.travel_arrive_at - tm.travel_started_at)))
             when tm.state = 'idle' and tm.pos_at > now() - interval '3 seconds' and (tm.vel_x <> 0 or tm.vel_y <> 0)
               then jsonb_build_array(tm.vel_x, tm.vel_y) end)), '[]'::jsonb)
    from teams tm left join locations l on l.id = tm.travel_to
    where tm.arena_id = t.arena_id and tm.ready
      and (tm.id = t.id or v_scan or tm.location_id = t.location_id or tm.jammed_until is null or tm.jammed_until < now()
           or exists (select 1 from alliances al where al.status = 'active'
                      and ((al.team_a = t.id and al.team_b = tm.id) or (al.team_b = t.id and al.team_a = tm.id))))));
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
        'demo_pulse', 'demo_end']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
