-- HEXA BATTLEGROUNDS — complete database setup (generated 2026-10-28).
-- Paste into Supabase → SQL Editor → Run. Safe to re-run: it updates functions and content in place.

-- ───────────── 0001_schema.sql ─────────────
-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — schema
-- All tables have RLS enabled and NO policies for anon/authenticated, so the
-- browser can never read or write a table directly. Every read and write goes
-- through SECURITY DEFINER functions in 0002_engine.sql, which check the
-- caller's session token and only return what that role may see.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                       -- short public event code, e.g. HEXA26
  name text not null,
  host_salt text not null,
  host_secret_hash text not null,
  settings jsonb not null default '{}'::jsonb,
  mission_seed int not null default (floor(random() * 1000000))::int,
  grand_revealed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists host_sessions (
  token_hash text primary key,
  event_id uuid not null references events(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists arenas (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  number int not null,
  name text not null,
  phase text not null default 'lobby'
    check (phase in ('lobby','boarding','shuttle','roles','play','finale','results','ended')),
  paused boolean not null default false,
  paused_at timestamptz,
  shuttle_departed_at timestamptz,
  shuttle_arrive_at timestamptz,
  roles_deadline timestamptz,
  play_started_at timestamptz,
  zone_stage int not null default 0,
  zone_next_at timestamptz,
  finale_stage text,
  sync_round_id uuid,
  threat int not null default 0,
  last_airdrop_at timestamptz,
  results_locked boolean not null default false,
  results jsonb,
  winner_revealed boolean not null default false,
  spectator_token text not null default replace(gen_random_uuid()::text, '-', ''),
  overlay jsonb not null default '{}'::jsonb,       -- {broadcast, blackout, countdown}
  last_tick_at timestamptz,
  last_ping_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, number)
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  arena_id uuid not null references arenas(id) on delete cascade,
  number int not null,
  name text not null,
  pin_salt text not null,
  pin_hash text not null,
  ready boolean not null default false,
  roster_locked boolean not null default false,
  bus int,
  hp int not null default 100,
  shield int not null default 0,
  coins int not null default 50,
  points int not null default 0,
  trust int not null default 0,
  final_points int not null default 0,
  missions_completed int not null default 0,
  battle_wins int not null default 0,
  location_id text,
  dropped boolean not null default false,
  state text not null default 'idle' check (state in ('idle','traveling','recovery')),
  travel_from text,
  travel_to text,
  travel_started_at timestamptz,
  travel_arrive_at timestamptz,
  recovery_deadline timestamptz,
  attack_cooldown_until timestamptz,
  protected_until timestamptz,
  jammed_until timestamptz,
  scan_until timestamptz,
  beacon boolean not null default false,
  zone_penalty_stage int not null default 0,
  mission_counter int not null default 0,
  visit_missions int not null default 0,
  bargains jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (event_id, number)
);
create index if not exists teams_arena_idx on teams(arena_id);
create index if not exists teams_location_idx on teams(arena_id, location_id);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role text check (role in ('captain','scout','decoder','intel')),
  session_hash text not null unique,
  active boolean not null default true,
  consent boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
-- one active player per role per team
create unique index if not exists players_role_uniq on players(team_id, role) where active and role is not null;
create index if not exists players_team_idx on players(team_id) where active;

create table if not exists pin_failures (
  id bigserial primary key,
  event_id uuid not null,
  team_number int not null,
  at timestamptz not null default now()
);

-- ── Map (shared editable map; host can enable/disable locations) ───────────────
create table if not exists locations (
  id text primary key,
  name text not null,
  building text,
  floor text,
  x real not null,
  y real not null,
  kind text not null,
  collapse_stage int not null default 99,
  risk int not null default 1,
  reward text,
  tags text[] not null default '{}',
  drop_zone boolean not null default false,
  loot text[] not null default '{}',
  enabled boolean not null default true
);

create table if not exists edges (
  a text not null references locations(id) on delete cascade,
  b text not null references locations(id) on delete cascade,
  seconds int not null check (seconds > 0),
  primary key (a, b)
);

create table if not exists items (
  id text primary key,
  name text not null,
  kind text not null,
  description text not null,
  params jsonb not null default '{}'::jsonb,
  price int not null default 0
);

create table if not exists inventory (
  team_id uuid not null references teams(id) on delete cascade,
  item_id text not null references items(id),
  qty int not null default 0 check (qty >= 0),
  primary key (team_id, item_id)
);

-- ── Content ────────────────────────────────────────────────────────────────────
create table if not exists mission_templates (
  id text primary key,
  version int not null default 1,
  family text not null,
  kind text not null,
  title text not null,
  category text not null,
  difficulty int not null default 1,
  tags text[] not null default '{}',
  objective text not null,
  clues jsonb not null,            -- {scout:{title,body,mono,reveal_seconds}, decoder:{..}, intel:{..}}
  parts jsonb not null,            -- [{label, accept:[normalised strings]}], '{KEY}' = relay key
  relay boolean not null default false,
  attempts int not null default 3,
  time_limit int not null default 180,
  hint text,
  explanation text,
  points int,
  coins int not null default 25,
  status text not null default 'draft' check (status in ('draft','review','approved','published','retired')),
  updated_at timestamptz not null default now()
);
create index if not exists mission_templates_kind_idx on mission_templates(kind, status);

create table if not exists sync_rounds (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  stage text not null,
  kind text not null,
  template_id text not null references mission_templates(id),
  started_at timestamptz not null default now(),
  deadline timestamptz not null,
  max_points int not null,
  status text not null default 'active' check (status in ('active','closed'))
);

create table if not exists battles (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  attacker_id uuid not null references teams(id),
  defender_id uuid not null references teams(id),
  weapon text not null references items(id),
  template_id text not null references mission_templates(id),
  location_id text,
  damage int not null,
  status text not null default 'active' check (status in ('active','resolved')),
  winner_id uuid references teams(id),
  started_at timestamptz not null default now(),
  deadline timestamptz not null,
  resolved_at timestamptz
);
create index if not exists battles_arena_idx on battles(arena_id, status);

create table if not exists airdrops (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  location_id text not null references locations(id),
  tier text not null check (tier in ('common','rare','legendary','mystery','cursed','intel')),
  template_id text not null references mission_templates(id),
  spawned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_by uuid references teams(id),
  claimed_at timestamptz,
  status text not null default 'open' check (status in ('open','claimed','expired'))
);
create index if not exists airdrops_arena_idx on airdrops(arena_id, status);

create table if not exists mission_instances (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  template_id text not null references mission_templates(id),
  template_version int not null,
  kind text not null,
  location_id text,
  battle_id uuid references battles(id),
  airdrop_id uuid references airdrops(id),
  sync_round_id uuid references sync_rounds(id),
  status text not null default 'active' check (status in ('active','solved','failed','expired','cancelled')),
  attempts_left int not null,
  started_at timestamptz not null default now(),
  deadline timestamptz not null,
  solved_at timestamptz,
  points_awarded int not null default 0,
  hint_used boolean not null default false,
  partner_team_id uuid references teams(id),
  relay_key text,
  fallback_at timestamptz,
  created_at timestamptz not null default now()
);
-- a squad has at most one active "main" activity and at most one active battle
create unique index if not exists mi_one_active_main on mission_instances(team_id) where status = 'active' and kind <> 'battle';
create unique index if not exists mi_one_active_battle on mission_instances(team_id) where status = 'active' and kind = 'battle';
create index if not exists mi_arena_active on mission_instances(arena_id, status, deadline);
create index if not exists mi_team_template on mission_instances(team_id, template_id);
create index if not exists mi_partner on mission_instances(partner_team_id) where status = 'active';

create table if not exists submissions (
  id bigserial primary key,
  instance_id uuid not null references mission_instances(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  player_id uuid not null references players(id),
  answer text not null,
  correct boolean not null,
  idem_key text not null unique,
  at timestamptz not null default now()
);

-- Single ledger for every resource change (points, coins, HP, trust).
-- Columns are separate so resources never get confused; (ref, kind) is unique
-- so a reward can never be applied twice.
create table if not exists ledger (
  id bigserial primary key,
  arena_id uuid not null references arenas(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null,
  points int not null default 0,
  coins int not null default 0,
  hp int not null default 0,
  trust int not null default 0,
  ref text,
  reason text,
  actor text not null default 'system',
  at timestamptz not null default now()
);
create unique index if not exists ledger_ref_uniq on ledger(team_id, kind, ref) where ref is not null;

create table if not exists chat_messages (
  id bigserial primary key,
  arena_id uuid not null references arenas(id) on delete cascade,
  from_team uuid not null references teams(id) on delete cascade,
  to_team uuid not null references teams(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 280),
  hidden boolean not null default false,
  reported boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists chat_pair_idx on chat_messages(arena_id, from_team, to_team, at);

create table if not exists chat_blocks (
  team_id uuid not null references teams(id) on delete cascade,
  blocked_team uuid not null references teams(id) on delete cascade,
  primary key (team_id, blocked_team)
);

create table if not exists alliances (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  team_a uuid not null references teams(id) on delete cascade,
  team_b uuid not null references teams(id) on delete cascade,
  proposed_by uuid not null references teams(id),
  status text not null default 'proposed' check (status in ('proposed','active','declined','expired','ended','betrayed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists alliances_arena_idx on alliances(arena_id, status);

create table if not exists story_events (
  id uuid primary key default gen_random_uuid(),
  arena_id uuid not null references arenas(id) on delete cascade,
  kind text not null check (kind in ('transmission','bargain','reveal')),
  title text not null,
  body text not null,
  offer jsonb,                      -- for bargains: {coins, threat, trust}
  expires_at timestamptz,
  at timestamptz not null default now()
);

-- Public, sequenced game feed (safe to show on the projector). Sequence = id.
create table if not exists game_feed (
  id bigserial primary key,
  arena_id uuid not null references arenas(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists game_feed_arena_idx on game_feed(arena_id, id desc);

create table if not exists audit_log (
  id bigserial primary key,
  event_id uuid not null references events(id) on delete cascade,
  arena_id uuid,
  actor text not null,
  action text not null,
  args jsonb,
  reason text,
  ok boolean not null default true,
  error text,
  at timestamptz not null default now()
);

-- ── Lock everything down ───────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['events','host_sessions','arenas','teams','players','pin_failures','locations','edges',
    'items','inventory','mission_templates','sync_rounds','battles','airdrops','mission_instances','submissions',
    'ledger','chat_messages','chat_blocks','alliances','story_events','game_feed','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

-- ───────────── 0002_core.sql ─────────────
-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — core engine (internal functions, not callable by clients)
-- ════════════════════════════════════════════════════════════════════════════

create or replace function _hash(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') $$;

create or replace function _norm(t text) returns text
language sql immutable as $$ select regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g') $$;

create or replace function _new_token() returns text
language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function _secs(n numeric) returns interval
language sql immutable as $$ select make_interval(secs => n::double precision) $$;

-- Default balancing values. Hosts override any key through event settings.
create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 10, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 15,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0
) $$;

create or replace function _cfg(p_event uuid, k text) returns int language sql stable as $$
  select coalesce((select (settings ->> k)::int from events where id = p_event), (_defaults() ->> k)::int)
$$;

create or replace function _cfg_text(p_event uuid, k text) returns text language sql stable as $$
  select coalesce((select settings ->> k from events where id = p_event), _defaults() ->> k)
$$;

-- Realtime: send a tiny "something changed" ping. Payloads never carry game
-- secrets; clients re-fetch their own filtered state through an RPC.
create or replace function _ping(p_topic text, p_kind text default 'state') returns void
language plpgsql as $$
begin
  perform realtime.send(jsonb_build_object('k', p_kind), 'ping', p_topic, false);
exception when others then
  null; -- realtime not available (local tests) — clients fall back to polling
end $$;

-- Arena-wide pings reach every phone on the map, so frequent low-priority kinds are
-- coalesced to at most one per 1.5 s (clients also poll, so nothing is lost).
create or replace function _ping_arena(p_arena uuid, p_kind text default 'state') returns void
language plpgsql as $$
begin
  if p_kind in ('score', 'move', 'roster', 'threat', 'intel') then
    update arenas set last_ping_at = now()
    where id = p_arena and (last_ping_at is null or last_ping_at < now() - interval '1500 milliseconds');
    if not found then return; end if;
  end if;
  perform _ping('arena-' || p_arena::text, p_kind);
end $$;

create or replace function _ping_team(p_team uuid, p_kind text default 'state') returns void
language sql as $$ select _ping('team-' || p_team::text, p_kind) $$;

create or replace function _feed(p_arena uuid, p_type text, p_payload jsonb default '{}'::jsonb) returns void
language sql as $$ insert into game_feed(arena_id, type, payload) values (p_arena, p_type, p_payload) $$;

create or replace function _event_of_arena(p_arena uuid) returns uuid
language sql stable as $$ select event_id from arenas where id = p_arena $$;

-- ── Ledger: the only way resources change ─────────────────────────────────────
-- Returns false (and changes nothing) if this (team, kind, ref) was already applied.
create or replace function _apply(
  p_team uuid, p_kind text, p_points int default 0, p_coins int default 0, p_hp int default 0,
  p_trust int default 0, p_ref text default null, p_reason text default null, p_actor text default 'system'
) returns boolean language plpgsql as $$
declare t teams; v_id bigint; v_max int;
begin
  select * into t from teams where id = p_team for update;
  insert into ledger(arena_id, team_id, kind, points, coins, hp, trust, ref, reason, actor)
  values (t.arena_id, p_team, p_kind, p_points, p_coins, p_hp, p_trust, p_ref, p_reason, p_actor)
  on conflict (team_id, kind, ref) where ref is not null do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  v_max := _cfg(t.event_id, 'hp_max');
  update teams set
    points = points + p_points,
    coins = greatest(0, coins + p_coins),
    hp = least(v_max, greatest(0, hp + p_hp)),
    trust = trust + p_trust
  where id = p_team;
  return true;
end $$;

-- Damage goes through the shield first. Zero HP sends the squad to Recovery.
create or replace function _damage(p_team uuid, p_amount int, p_kind text, p_ref text, p_reason text)
returns int language plpgsql as $$
declare t teams; v_absorb int; v_hp int;
begin
  select * into t from teams where id = p_team for update;
  if t.state = 'recovery' or p_amount <= 0 then return 0; end if;
  v_absorb := least(t.shield, p_amount);
  if v_absorb > 0 then update teams set shield = shield - v_absorb where id = p_team; end if;
  v_hp := p_amount - v_absorb;
  if v_hp > 0 then
    if not _apply(p_team, p_kind, 0, 0, -v_hp, 0, p_ref, p_reason) then return 0; end if;
  end if;
  select * into t from teams where id = p_team;
  if t.hp <= 0 and t.state <> 'recovery' then perform _enter_recovery(p_team); end if;
  return v_hp;
end $$;

create or replace function _add_item(p_team uuid, p_item text, p_qty int default 1) returns void
language sql as $$
  insert into inventory(team_id, item_id, qty) values (p_team, p_item, greatest(0, p_qty))
  on conflict (team_id, item_id) do update set qty = greatest(0, inventory.qty + p_qty)
$$;

-- ── Map helpers ───────────────────────────────────────────────────────────────
create or replace function _is_neighbor(p_a text, p_b text) returns int
language sql stable as $$
  select seconds from edges where (a = p_a and b = p_b) or (a = p_b and b = p_a) limit 1
$$;

-- Nearest location (fewest hops, then shortest travel) that is safe at the given stage.
create or replace function _nearest_safe(p_from text, p_stage int) returns text
language plpgsql stable as $$
declare visited text[]; frontier text[]; nxt text[]; v_hit text; i int;
begin
  if p_from is null then p_from := 'hx_lobby'; end if;
  visited := array[p_from]; frontier := array[p_from];
  for i in 1..20 loop
    select l.id into v_hit from locations l
    where l.id = any(frontier) and l.collapse_stage > p_stage and l.enabled and l.kind <> 'start'
    order by l.collapse_stage desc, l.id limit 1;
    if v_hit is not null then return v_hit; end if;
    select coalesce(array_agg(distinct n), '{}') into nxt from (
      select case when e.a = any(frontier) then e.b else e.a end as n
      from edges e where e.a = any(frontier) or e.b = any(frontier)
    ) s where not (n = any(visited));
    if array_length(nxt, 1) is null then exit; end if;
    visited := visited || nxt; frontier := nxt;
  end loop;
  return 'tr14';
end $$;

-- ── Mission selection & creation ──────────────────────────────────────────────
create or replace function _pick_template(p_team uuid, p_kind text, p_tags text[]) returns text
language plpgsql stable as $$
declare t teams; v_seed int; v text;
begin
  select * into t from teams where id = p_team;
  select mission_seed into v_seed from events where id = t.event_id;
  select mt.id into v from mission_templates mt
  where mt.kind = p_kind and mt.status = 'published'
    and not exists (select 1 from mission_instances mi where mi.team_id = p_team and mi.template_id = mt.id)
  order by (mt.tags && coalesce(p_tags, '{}')) desc, md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
  limit 1;
  if v is null then
    select mt.id into v from mission_templates mt
    where mt.kind = p_kind and mt.status = 'published'
    order by (mt.tags && coalesce(p_tags, '{}')) desc, md5(v_seed::text || p_team::text || mt.id || t.mission_counter::text)
    limit 1;
  end if;
  return v;
end $$;

create or replace function _codeword(p_seed text) returns text language sql immutable as $$
  select (array['FALCON','TIGER','COBRA','RAVEN','VIPER','ORCA','LYNX','MANTIS','HAWK','BISON','JAGUAR',
                'PANTHER','CONDOR','IBIS','OTTER','PUMA','KESTREL','WOLF','GECKO','MARLIN'])
         [1 + abs(hashtext(p_seed)) % 20]
$$;

create or replace function _start_instance(
  p_team uuid, p_template text, p_location text default null, p_battle uuid default null,
  p_airdrop uuid default null, p_sync uuid default null, p_deadline timestamptz default null,
  p_partner uuid default null
) returns uuid language plpgsql as $$
declare t teams; mt mission_templates; v_id uuid; v_partner uuid; v_key text; v_seed int;
begin
  select * into t from teams where id = p_team for update;
  select * into mt from mission_templates where id = p_template;
  if mt.id is null then raise exception 'NO_TEMPLATE'; end if;
  select mission_seed into v_seed from events where id = t.event_id;
  if mt.relay then
    v_partner := p_partner;
    if v_partner is null then
      select x.id into v_partner from teams x
      where x.arena_id = t.arena_id and x.ready and x.id <> t.id
      order by md5(v_seed::text || t.id::text || x.id::text || t.mission_counter::text) limit 1;
    end if;
    v_key := _codeword(v_seed::text || t.id::text || t.mission_counter::text);
  end if;
  insert into mission_instances(arena_id, team_id, template_id, template_version, kind, location_id, battle_id,
    airdrop_id, sync_round_id, attempts_left, deadline, partner_team_id, relay_key, fallback_at)
  values (t.arena_id, t.id, mt.id, mt.version, mt.kind, coalesce(p_location, t.location_id), p_battle, p_airdrop, p_sync,
    mt.attempts, coalesce(p_deadline, now() + _secs(mt.time_limit)), v_partner, v_key,
    case when mt.relay and v_partner is not null then now() + _secs(_cfg(t.event_id, 'intel_fallback'))
         when mt.relay then now() end)
  returning id into v_id;
  update teams set mission_counter = mission_counter + 1,
    visit_missions = visit_missions + case when mt.kind in ('mission', 'relay') then 1 else 0 end
  where id = t.id;
  perform _ping_team(t.id, 'mission');
  if v_partner is not null then perform _ping_team(v_partner, 'intel'); end if;
  return v_id;
end $$;

-- Start an exploration mission at the squad's current location.
create or replace function _start_location_mission(p_team uuid) returns uuid
language plpgsql as $$
declare t teams; l locations; v_kind text := 'mission'; v_tpl text; v_seed int; v_others int;
begin
  select * into t from teams where id = p_team;
  select * into l from locations where id = t.location_id;
  select mission_seed into v_seed from events where id = t.event_id;
  select count(*) into v_others from teams where arena_id = t.arena_id and ready and id <> t.id;
  if v_others > 0 and (
       l.tags && array['social', 'public', 'market']
       or abs(hashtext(v_seed::text || t.id::text || t.mission_counter::text)) % 100 < _cfg(t.event_id, 'relay_chance'))
  then v_kind := 'relay'; end if;
  v_tpl := _pick_template(p_team, v_kind, l.tags || array['any']);
  if v_tpl is null then v_tpl := _pick_template(p_team, 'mission', l.tags || array['any']); end if;
  if v_tpl is null then return null; end if;
  return _start_instance(p_team, v_tpl, t.location_id);
end $$;

-- ── Recovery (zero HP never eliminates) ───────────────────────────────────────
create or replace function _enter_recovery(p_team uuid) returns void
language plpgsql as $$
declare t teams; v_tpl text;
begin
  select * into t from teams where id = p_team for update;
  if t.state = 'recovery' then return; end if;
  update mission_instances set status = 'cancelled' where team_id = p_team and status = 'active' and kind <> 'battle' and sync_round_id is null;
  update teams set state = 'recovery', travel_to = null, travel_arrive_at = null,
    recovery_deadline = now() + _secs(_cfg(t.event_id, 'recovery_seconds'))
  where id = p_team;
  perform _apply(p_team, 'recovery_penalty', -_cfg(t.event_id, 'pen_recovery'), 0, 0, 0, null, 'HP reached zero');
  if not exists (select 1 from mission_instances where team_id = p_team and status = 'active' and kind <> 'battle') then
    v_tpl := _pick_template(p_team, 'recovery', array['any']);
    if v_tpl is not null then
      perform _start_instance(p_team, v_tpl, null, null, null, null, now() + _secs(_cfg(t.event_id, 'recovery_seconds')));
    end if;
  end if;
  perform _feed(t.arena_id, 'recovery.started', jsonb_build_object('team', t.number));
  perform _ping_team(p_team, 'recovery');
end $$;

create or replace function _respawn(p_team uuid, p_reason text) returns void
language plpgsql as $$
declare t teams;
begin
  select * into t from teams where id = p_team for update;
  if t.state <> 'recovery' then return; end if;
  update mission_instances set status = case when status = 'active' then 'expired' else status end
  where team_id = p_team and kind = 'recovery' and status = 'active';
  update teams set state = 'idle', recovery_deadline = null, hp = _cfg(t.event_id, 'hp_respawn'),
    protected_until = now() + _secs(_cfg(t.event_id, 'protect_seconds'))
  where id = p_team;
  perform _feed(t.arena_id, 'recovery.completed', jsonb_build_object('team', t.number, 'how', p_reason));
  perform _ping_team(p_team, 'recovery');
end $$;

-- ── Battles ───────────────────────────────────────────────────────────────────
create or replace function _resolve_battle(p_battle uuid, p_winner uuid) returns void
language plpgsql as $$
declare b battles; v_loser uuid; ta teams; tb teams; v_dealt int := 0; v_ev uuid;
begin
  select * into b from battles where id = p_battle for update;
  if b.status <> 'active' then return; end if;
  v_ev := _event_of_arena(b.arena_id);
  update battles set status = 'resolved', winner_id = p_winner, resolved_at = now() where id = b.id;
  if p_winner is not null then
    v_loser := case when p_winner = b.attacker_id then b.defender_id else b.attacker_id end;
    update mission_instances set status = 'solved', solved_at = now() where battle_id = b.id and team_id = p_winner and status = 'active';
    update mission_instances set status = 'failed' where battle_id = b.id and team_id = v_loser and status = 'active';
    perform _apply(p_winner, 'battle_win', _cfg(v_ev, 'pts_battle'), 20, 0, 0, b.id::text, 'Battle victory');
    update teams set battle_wins = battle_wins + 1 where id = p_winner;
    update mission_instances set points_awarded = _cfg(v_ev, 'pts_battle') where battle_id = b.id and team_id = p_winner;
    v_dealt := _damage(v_loser, b.damage, 'battle_damage', b.id::text, 'Lost a battle');
  else
    update mission_instances set status = 'expired' where battle_id = b.id and status = 'active';
  end if;
  -- cooldowns: attacker can't attack again for a while; both get brief protection
  update teams set attack_cooldown_until = now() + _secs(_cfg(v_ev, 'attack_cooldown')) where id = b.attacker_id;
  update teams set protected_until = now() + _secs(_cfg(v_ev, 'protect_seconds')) where id in (b.attacker_id, b.defender_id);
  select * into ta from teams where id = b.attacker_id;
  select * into tb from teams where id = b.defender_id;
  perform _feed(b.arena_id, 'battle.resolved', jsonb_build_object(
    'attacker', ta.number, 'defender', tb.number, 'weapon', b.weapon,
    'winner', (select number from teams where id = p_winner), 'damage', v_dealt));
  perform _ping_team(b.attacker_id, 'battle');
  perform _ping_team(b.defender_id, 'battle');
end $$;

-- ── Standings (deterministic; ties flagged for a tiebreaker challenge) ────────
create or replace function _standings(p_arena uuid) returns jsonb
language sql stable as $$
  with s as (
    select t.id, t.number, t.name, t.points, t.final_points, t.missions_completed, t.battle_wins, t.arena_id,
      (select number from arenas a where a.id = t.arena_id) as arena_number,
      rank() over (order by t.points desc, t.final_points desc, t.missions_completed desc, t.battle_wins desc) as rnk
    from teams t where t.ready and t.arena_id = p_arena
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', rnk, 'team_id', id, 'number', number, 'name', name, 'points', points, 'final_points', final_points,
    'missions', missions_completed, 'battles', battle_wins, 'arena', arena_number,
    'tie', (select count(*) from s s2 where s2.rnk = s.rnk) > 1
  ) order by rnk, number), '[]'::jsonb) from s
$$;

create or replace function _event_standings(p_event uuid) returns jsonb
language sql stable as $$
  with s as (
    select t.id, t.number, t.name, t.points, t.final_points, t.missions_completed, t.battle_wins,
      (select number from arenas a where a.id = t.arena_id) as arena_number,
      rank() over (order by t.points desc, t.final_points desc, t.missions_completed desc, t.battle_wins desc) as rnk
    from teams t where t.ready and t.event_id = p_event
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rank', rnk, 'team_id', id, 'number', number, 'name', name, 'points', points, 'final_points', final_points,
    'missions', missions_completed, 'battles', battle_wins, 'arena', arena_number,
    'tie', (select count(*) from s s2 where s2.rnk = s.rnk) > 1
  ) order by rnk, number), '[]'::jsonb) from s
$$;

-- ── Zone ──────────────────────────────────────────────────────────────────────
create or replace function _apply_zone(p_arena uuid) returns void
language plpgsql as $$
declare a arenas; t record; v_safe text;
begin
  select * into a from arenas where id = p_arena;
  for t in
    select tm.* from teams tm join locations l on l.id = tm.location_id
    where tm.arena_id = p_arena and tm.ready and l.collapse_stage <= a.zone_stage and tm.state <> 'traveling'
    for update of tm
  loop
    v_safe := _nearest_safe(t.location_id, a.zone_stage);
    if t.state <> 'recovery' and t.zone_penalty_stage < a.zone_stage then
      perform _damage(t.id, _cfg(a.event_id, 'dmg_zone'), 'zone_damage', 'zone-' || a.zone_stage, 'Caught outside the safe zone');
    end if;
    update teams set location_id = v_safe, zone_penalty_stage = greatest(zone_penalty_stage, a.zone_stage), visit_missions = 0
    where id = t.id;
    perform _feed(p_arena, 'zone.relocated', jsonb_build_object('team', t.number, 'to', v_safe));
    perform _ping_team(t.id, 'zone');
  end loop;
  -- squads travelling into a collapsed location are redirected
  for t in
    select tm.* from teams tm join locations l on l.id = tm.travel_to
    where tm.arena_id = p_arena and tm.state = 'traveling' and l.collapse_stage <= a.zone_stage
    for update of tm
  loop
    update teams set travel_to = _nearest_safe(t.travel_to, a.zone_stage) where id = t.id;
    perform _ping_team(t.id, 'zone');
  end loop;
end $$;

create or replace function _zone_advance(p_arena uuid) returns void
language plpgsql as $$
declare a arenas;
begin
  update arenas set zone_stage = least(5, zone_stage + 1), zone_next_at = null where id = p_arena returning * into a;
  perform _feed(p_arena, 'zone.collapsed', jsonb_build_object('stage', a.zone_stage));
  perform _apply_zone(p_arena);
end $$;

-- ── Airdrops ──────────────────────────────────────────────────────────────────
create or replace function _spawn_airdrop(p_arena uuid, p_location text, p_tier text) returns uuid
language plpgsql as $$
declare a arenas; v_loc text := p_location; v_tpl text; v_id uuid; v_tier text := coalesce(p_tier, 'common');
begin
  select * into a from arenas where id = p_arena;
  if v_loc is null then
    select id into v_loc from locations
    where enabled and collapse_stage > a.zone_stage + 1 and kind <> 'start' and id <> 'tr14'
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

-- ── Roles ─────────────────────────────────────────────────────────────────────
create or replace function _finalize_roles(p_arena uuid) returns void
language plpgsql as $$
declare t record; p record; v_missing text[];
begin
  for t in select * from teams where arena_id = p_arena and ready loop
    select array_agg(r) into v_missing from unnest(array['captain', 'scout', 'decoder', 'intel']) r
    where not exists (select 1 from players where team_id = t.id and active and role = r);
    if v_missing is null then continue; end if;
    for p in select * from players where team_id = t.id and active and role is null order by joined_at loop
      exit when array_length(v_missing, 1) is null;
      update players set role = v_missing[1] where id = p.id;
      v_missing := v_missing[2:];
    end loop;
  end loop;
end $$;

-- ── Completion & failure ──────────────────────────────────────────────────────
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
    if mi.hint_used then v_pts := round(v_pts * 0.8); end if;
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
    perform _damage(mi.team_id, _cfg(t.event_id, 'dmg_fail'), 'mission_fail', mi.id::text, 'Mission failed');
  end if;
  perform _feed(t.arena_id, 'mission.failed', jsonb_build_object('team', t.number));
  perform _ping_team(mi.team_id, 'result');
end $$;

-- ── Arrival ───────────────────────────────────────────────────────────────────
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
    travel_arrive_at = null, travel_started_at = null, dropped = true, visit_missions = 0
  where id = p_team;
  -- reward a well-timed escape from a location about to collapse
  if a.zone_next_at is not null and v_from.collapse_stage = a.zone_stage + 1 and v_to.collapse_stage > a.zone_stage + 1 then
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

-- ── The tick: resolves every timer for an arena. Called on reads (rate-limited)
-- and by the host/projector screens, so no always-on server is needed. ────────
create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare a arenas; r record; v_changed boolean := false; v_sched text[]; v_next int; v_at timestamptz;
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
  -- roles → play
  if a.phase = 'roles' and now() >= a.roles_deadline then
    perform _finalize_roles(p_arena);
    update arenas set phase = 'play', play_started_at = now() where id = p_arena;
    perform _feed(p_arena, 'role.assignment.completed', '{}'::jsonb);
    perform _feed(p_arena, 'map.revealed', '{}'::jsonb);
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

  -- zone: automatic schedule (optional) and scheduled collapses
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and _cfg(a.event_id, 'zone_auto') = 1 and a.zone_next_at is null and a.zone_stage < 5 then
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

  if v_changed then perform _ping_arena(p_arena, 'tick'); end if;
  return v_changed;
end $$;

-- ───────────── 0003_player.sql ─────────────
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

-- ───────────── 0004_host.sql ─────────────
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

-- ───────────── 0005_content.sql ─────────────
-- GENERATED by scripts/build-content.mjs — edit content/*.mjs and re-run `npm run content`.
-- Map, item catalogue and the reviewed challenge library (145 templates).

insert into locations(id, name, building, floor, x, y, kind, collapse_stage, risk, reward, tags, drop_zone, loot) values
('sipcot', 'SIPCOT Entrance', null, null, 0.5, 1.07, 'start', 0, 0, 'Shuttle boarding', array['start']::text[], false, array[]::text[]),
('gate_1', 'Gate 1', null, null, 0.5, 0.93, 'gate', 3, 1, 'Access codes', array['gate','access']::text[], false, array['medkit','pistol']::text[]),
('gate_2', 'Gate 2 Checkpoint', null, null, 0.93, 0.5, 'gate', 1, 2, 'Access codes', array['gate','access']::text[], true, array['scanner','smg']::text[]),
('gate_3', 'Gate 3 (Sealed Mystery Zone)', null, null, 0.5, 0.07, 'gate', 1, 3, 'Rare intel', array['gate','access','transmission']::text[], true, array['sniper','jammer']::text[]),
('gate_4', 'Gate 4 (Dark Signal Zone)', null, null, 0.07, 0.5, 'gate', 1, 3, 'Rare intel', array['gate','access','transmission']::text[], true, array['beacon','sniper']::text[]),
('hx_lobby', 'Hexavarsity Lobby', 'hexavarsity', '0', 0.5, 0.74, 'building', 5, 1, 'Learning loot', array['hexavarsity','learning']::text[], true, array['medkit','shield']::text[]),
('hx_help', 'Help Center (B1)', 'hexavarsity', '-1', 0.44, 0.79, 'room', 5, 1, 'Support kits', array['hexavarsity','helpdesk']::text[], false, array['medkit','scanner']::text[]),
('hx_costa', 'Costa Coffee (G)', 'hexavarsity', '0', 0.56, 0.79, 'room', 5, 1, 'Coins', array['costa','coffee']::text[], true, array['medkit','beacon']::text[]),
('hx_tr_wing2', 'Training Rooms 1–13 (F2)', 'hexavarsity', '2', 0.44, 0.69, 'room', 5, 2, 'Weapons', array['hexavarsity','learning']::text[], false, array['smg','shield']::text[]),
('hx_pantry2', 'F2 Pantry', 'hexavarsity', '2', 0.4, 0.73, 'room', 5, 1, 'Healing', array['food','healing']::text[], false, array['medkit']::text[]),
('hx_tr_wing3', 'Training Rooms 15–19 (F3)', 'hexavarsity', '3', 0.56, 0.69, 'room', 5, 2, 'Weapons', array['hexavarsity','learning']::text[], false, array['sniper','shield']::text[]),
('hx_odc', 'ODC (F3)', 'hexavarsity', '3', 0.6, 0.73, 'room', 5, 2, 'Intel', array['office','stg']::text[], false, array['scanner','jammer']::text[]),
('tr14', 'Training Room 14 — Final Battleground', 'hexavarsity', '3', 0.5, 0.65, 'room', 99, 3, 'The finale', array['finale','hexavarsity']::text[], false, array['shield']::text[]),
('eb2_lobby', 'EB2 Entrance', 'eb2', '0', 0.27, 0.74, 'building', 3, 1, 'Mixed', array['office']::text[], true, array['pistol','medkit']::text[]),
('eb2_stg', 'EB2 STG Zone (F1)', 'eb2', '1', 0.22, 0.7, 'room', 3, 2, 'Weapons', array['stg','testing']::text[], false, array['smg','scanner']::text[]),
('eb2_floors', 'EB2 Team Floors', 'eb2', '2–5', 0.22, 0.78, 'room', 3, 1, 'Coins', array['office']::text[], false, array['medkit']::text[]),
('eb2_terrace', 'EB2 Terrace Garden', 'eb2', 'T', 0.17, 0.74, 'room', 2, 2, 'Rare loot', array['terrace','observation']::text[], false, array['sniper','beacon']::text[]),
('eb2_parking', 'EB2 Parking', 'eb2', 'B', 0.3, 0.8, 'room', 2, 1, 'Supplies', array['parking','access']::text[], false, array['extract','medkit']::text[]),
('p2_lobby', 'Phase 2 Entrance', 'phase2', '0', 0.76, 0.84, 'building', 2, 1, 'Mixed', array['phase2']::text[], true, array['pistol']::text[]),
('p2_parking', 'Phase 2 Basement Parking', 'phase2', 'B', 0.82, 0.88, 'room', 2, 1, 'Supplies', array['parking','access']::text[], false, array['extract','medkit']::text[]),
('p2_floors', 'Phase 2 Floors 1–2', 'phase2', '1–2', 0.82, 0.8, 'room', 2, 2, 'Transmissions', array['phase2','transmission']::text[], false, array['scanner','smg']::text[]),
('p2_upper', 'Phase 2 Floors 3–5', 'phase2', '3–5', 0.87, 0.76, 'room', 2, 3, 'High-value loot', array['phase2','transmission']::text[], false, array['sniper','shield','beacon']::text[]),
('rt_lobby', 'Ratan Tata Building', 'rtb', '0', 0.5, 0.22, 'building', 3, 1, 'Mixed', array['office']::text[], true, array['pistol','medkit']::text[]),
('rt_cec', 'CEC Boardroom (G)', 'rtb', '0', 0.44, 0.18, 'room', 3, 2, 'Intel', array['boardroom']::text[], false, array['scanner','jammer']::text[]),
('rt_floors', 'RTB Team Floors', 'rtb', '1–4', 0.56, 0.18, 'room', 3, 1, 'Coins', array['office']::text[], false, array['medkit']::text[]),
('rt_glass', 'Glass Reflection Zone', 'rtb', '4', 0.6, 0.14, 'room', 3, 2, 'Rare loot', array['glass','observation']::text[], false, array['sniper','shield']::text[]),
('rt_parking', 'RTB Parking', 'rtb', 'B', 0.4, 0.14, 'room', 2, 1, 'Supplies', array['parking','access']::text[], false, array['extract']::text[]),
('eb1_lobby', 'EB1 Entrance', 'eb1', '0', 0.75, 0.26, 'building', 2, 1, 'Mixed', array['office']::text[], true, array['pistol','medkit']::text[]),
('eb1_floors', 'EB1 Team Floors', 'eb1', '1–5', 0.8, 0.21, 'room', 2, 1, 'Coins', array['office']::text[], false, array['medkit','scanner']::text[]),
('eb1_terrace', 'EB1 Terrace Garden', 'eb1', 'T', 0.85, 0.25, 'room', 2, 2, 'Rare loot', array['terrace','observation']::text[], false, array['sniper','beacon']::text[]),
('eb1_parking', 'EB1 Parking', 'eb1', 'B', 0.78, 0.31, 'room', 2, 1, 'Supplies', array['parking','access']::text[], false, array['extract']::text[]),
('eb3_lobby', 'EB3 Entrance', 'eb3', '0', 0.22, 0.45, 'building', 3, 1, 'Mixed', array['office']::text[], true, array['pistol','medkit']::text[]),
('eb3_hr', 'EB3 HR Zone (G)', 'eb3', '0', 0.17, 0.41, 'room', 3, 2, 'Trust', array['hr']::text[], false, array['shield','scanner']::text[]),
('eb3_floors', 'EB3 Team Floors', 'eb3', '1–5', 0.17, 0.49, 'room', 3, 1, 'Coins', array['office']::text[], false, array['medkit']::text[]),
('eb3_terrace', 'EB3 Terrace Garden', 'eb3', 'T', 0.13, 0.45, 'room', 2, 2, 'Rare loot', array['terrace','observation']::text[], false, array['sniper','beacon']::text[]),
('eb3_parking', 'EB3 Parking', 'eb3', 'B', 0.26, 0.5, 'room', 2, 1, 'Supplies', array['parking','access']::text[], false, array['extract']::text[]),
('central_steps', 'Central Steps', 'central', '0', 0.47, 0.58, 'hub', 5, 1, 'Approach route', array['public','social']::text[], true, array['medkit']::text[]),
('hexadine', 'Hexadine', 'central', '0', 0.45, 0.47, 'amenity', 4, 1, 'Market', array['market','food']::text[], true, array['medkit','shield']::text[]),
('hexaraunt', 'Hexaraunt (B)', 'central', '-1', 0.4, 0.51, 'amenity', 4, 1, 'Healing', array['food','healing']::text[], false, array['medkit','medkit']::text[]),
('hexacafe', 'Hexacafe (B)', 'central', '-1', 0.53, 0.51, 'amenity', 4, 1, 'Intel market', array['social','coffee']::text[], false, array['scanner','jammer']::text[]),
('fountain', 'Central Fountain', 'central', '0', 0.53, 0.41, 'amenity', 4, 3, 'Airdrops', array['airdrop','public']::text[], true, array['beacon','sniper']::text[]),
('shuttle_court', 'Shuttle Court', 'sports', '0', 0.33, 0.33, 'sports', 1, 2, 'Sports loot', array['sports']::text[], true, array['smg']::text[]),
('pickleball', 'Pickleball Court', 'sports', '0', 0.68, 0.64, 'sports', 1, 2, 'Sports loot', array['sports']::text[], true, array['smg','medkit']::text[]),
('cricket', 'Cricket Ground', 'sports', '0', 0.12, 0.66, 'sports', 1, 2, 'Sports loot', array['sports']::text[], true, array['sniper','pistol']::text[])
on conflict (id) do update set name = excluded.name, building = excluded.building, floor = excluded.floor, x = excluded.x,
  y = excluded.y, kind = excluded.kind, collapse_stage = excluded.collapse_stage, risk = excluded.risk, reward = excluded.reward,
  tags = excluded.tags, drop_zone = excluded.drop_zone, loot = excluded.loot;

insert into edges(a, b, seconds) values
('gate_1', 'hx_lobby', 15),
('gate_1', 'p2_lobby', 20),
('gate_1', 'eb2_lobby', 25),
('hx_lobby', 'hx_costa', 8),
('hx_lobby', 'hx_help', 8),
('hx_lobby', 'hx_tr_wing2', 12),
('hx_tr_wing2', 'hx_pantry2', 6),
('hx_tr_wing2', 'hx_tr_wing3', 10),
('hx_tr_wing3', 'tr14', 6),
('hx_tr_wing3', 'hx_odc', 6),
('tr14', 'hx_odc', 6),
('hx_lobby', 'central_steps', 15),
('hx_lobby', 'pickleball', 15),
('hx_lobby', 'eb2_lobby', 20),
('eb2_lobby', 'eb2_stg', 8),
('eb2_lobby', 'eb2_floors', 10),
('eb2_floors', 'eb2_terrace', 10),
('eb2_lobby', 'eb2_parking', 10),
('eb2_lobby', 'cricket', 25),
('eb2_lobby', 'eb3_lobby', 25),
('p2_lobby', 'p2_parking', 8),
('p2_lobby', 'p2_floors', 10),
('p2_floors', 'p2_upper', 10),
('p2_lobby', 'pickleball', 15),
('p2_lobby', 'gate_2', 25),
('central_steps', 'hexadine', 8),
('central_steps', 'hexacafe', 8),
('hexadine', 'hexaraunt', 6),
('hexacafe', 'hexaraunt', 6),
('hexadine', 'fountain', 10),
('hexacafe', 'fountain', 10),
('central_steps', 'eb3_lobby', 18),
('central_steps', 'pickleball', 15),
('fountain', 'rt_lobby', 15),
('fountain', 'eb1_lobby', 20),
('fountain', 'shuttle_court', 18),
('rt_lobby', 'rt_cec', 8),
('rt_lobby', 'rt_floors', 10),
('rt_floors', 'rt_glass', 10),
('rt_lobby', 'rt_parking', 10),
('rt_lobby', 'eb1_lobby', 15),
('rt_lobby', 'gate_3', 20),
('rt_lobby', 'shuttle_court', 15),
('eb1_lobby', 'eb1_floors', 10),
('eb1_floors', 'eb1_terrace', 10),
('eb1_lobby', 'eb1_parking', 10),
('eb1_lobby', 'gate_2', 25),
('eb3_lobby', 'eb3_hr', 8),
('eb3_lobby', 'eb3_floors', 10),
('eb3_floors', 'eb3_terrace', 10),
('eb3_lobby', 'eb3_parking', 10),
('eb3_lobby', 'gate_4', 20),
('eb3_lobby', 'shuttle_court', 15),
('gate_4', 'cricket', 15)
on conflict (a, b) do update set seconds = excluded.seconds;

insert into items(id, name, kind, description, params, price) values
('pistol', 'Pistol', 'weapon', 'Starts a standard puzzle duel. Never used up.', '{"damage":25,"tag":"duel_pistol","seconds":90,"consumable":false}'::jsonb, 0),
('smg', 'SMG', 'weapon', 'Fast duel: short timer, lower damage. One use.', '{"damage":20,"tag":"duel_smg","seconds":50,"consumable":true}'::jsonb, 40),
('sniper', 'Sniper', 'weapon', 'Hard logic duel: long timer, high damage. One use.', '{"damage":40,"tag":"duel_sniper","seconds":120,"consumable":true}'::jsonb, 60),
('shield', 'Shield', 'defense', 'Absorbs the next 30 damage.', '{"shield":30}'::jsonb, 35),
('medkit', 'Med Kit', 'heal', 'Restores 30 HP (max 100).', '{"heal":30}'::jsonb, 30),
('scanner', 'Intel Scanner', 'intel', 'Reveals every squad position (even jammed) for 60 s.', '{"seconds":60}'::jsonb, 30),
('jammer', 'Signal Jammer', 'stealth', 'Hides your squad from the public map for 120 s.', '{"seconds":120}'::jsonb, 30),
('beacon', 'Airdrop Beacon', 'airdrop', 'Your next airdrop win gives double coins.', '{}'::jsonb, 25),
('extract', 'Emergency Extract', 'move', 'Instantly relocate to the nearest safe zone location.', '{}'::jsonb, 40)
on conflict (id) do update set name = excluded.name, kind = excluded.kind, description = excluded.description,
  params = excluded.params, price = excluded.price;

insert into mission_templates(id, family, kind, title, category, difficulty, tags, objective, clues, parts, relay,
  attempts, time_limit, hint, explanation, points, coins, status) values
('mission-caesar-0', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['transmission','boardroom','any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 98.7 MHz ]  YHKPHUA\n[ 101.3 MHz ]  IUDJYDUB\n[ 91.1 MHz ]  XJHKVNN","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 7\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["RADIANT"]}]'::jsonb, false, 3, 200, 'The answer has 7 letters and starts with R.', '98.7 MHz carries YHKPHUA; shifting back by 7 gives RADIANT.', null, 25, 'published'),
('mission-caesar-1', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['gate','access','transmission']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 94.3 MHz ]  AEKXDEW\n[ 98.7 MHz ]  YKTZOTKR\n[ 88.4 MHz ]  VYUWIH","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 6\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["SENTINEL"]}]'::jsonb, false, 3, 200, 'The answer has 8 letters and starts with S.', '98.7 MHz carries YKTZOTKR; shifting back by 6 gives SENTINEL.', null, 25, 'published'),
('mission-caesar-2', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['transmission','boardroom','any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 107.2 MHz ]  YQXNWRG\n[ 98.7 MHz ]  JSFHSL\n[ 104.9 MHz ]  RJWNINFS","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 5\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["MERIDIAN"]}]'::jsonb, false, 3, 200, 'The answer has 8 letters and starts with M.', '104.9 MHz carries RJWNINFS; shifting back by 5 gives MERIDIAN.', null, 25, 'published'),
('mission-caesar-3', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['gate','access','transmission']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 91.1 MHz ]  ZILQIVB\n[ 107.2 MHz ]  HLREKLD\n[ 98.7 MHz ]  YKILWOO","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 91.1 MHz\nEncryption key: 8\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["RADIANT"]}]'::jsonb, false, 3, 200, 'The answer has 7 letters and starts with R.', '91.1 MHz carries ZILQIVB; shifting back by 8 gives RADIANT.', null, 25, 'published'),
('mission-caesar-4', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['transmission','boardroom','any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 101.3 MHz ]  OJULXW\n[ 91.1 MHz ]  SJGZQF\n[ 104.9 MHz ]  VBIAXK","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 91.1 MHz\nEncryption key: 5\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["NEBULA"]}]'::jsonb, false, 3, 200, 'The answer has 6 letters and starts with N.', '91.1 MHz carries SJGZQF; shifting back by 5 gives NEBULA.', null, 25, 'published'),
('mission-caesar-5', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['gate','access','transmission']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 101.3 MHz ]  PWZQHWV\n[ 98.7 MHz ]  RIFYPE\n[ 91.1 MHz ]  WUDAHKW","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 4\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["NEBULA"]}]'::jsonb, false, 3, 200, 'The answer has 6 letters and starts with N.', '98.7 MHz carries RIFYPE; shifting back by 4 gives NEBULA.', null, 25, 'published'),
('mission-caesar-6', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['transmission','boardroom','any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 94.3 MHz ]  DFXXTE\n[ 101.3 MHz ]  IUDJYDUB\n[ 91.1 MHz ]  NSHJPLY","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 91.1 MHz\nEncryption key: 7\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["GLACIER"]}]'::jsonb, false, 3, 200, 'The answer has 7 letters and starts with G.', '91.1 MHz carries NSHJPLY; shifting back by 7 gives GLACIER.', null, 25, 'published'),
('mission-caesar-7', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['gate','access','transmission']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 91.1 MHz ]  CUBRAVK\n[ 101.3 MHz ]  WUDAHKW\n[ 104.9 MHz ]  OJULXW","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 9\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["FALCON"]}]'::jsonb, false, 3, 200, 'The answer has 6 letters and starts with F.', '104.9 MHz carries OJULXW; shifting back by 9 gives FALCON.', null, 25, 'published'),
('mission-caesar-8', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['transmission','boardroom','any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 98.7 MHz ]  ENACNG\n[ 107.2 MHz ]  UAHZWJ\n[ 101.3 MHz ]  ELOFWLK","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 9\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["VERTEX"]}]'::jsonb, false, 3, 200, 'The answer has 6 letters and starts with V.', '98.7 MHz carries ENACNG; shifting back by 9 gives VERTEX.', null, 25, 'published'),
('mission-caesar-9', 'caesar', 'mission', 'Signal Intercept', 'decoding', 1, array['gate','access','transmission']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 88.4 MHz ]  UXHOZGR\n[ 107.2 MHz ]  QTPRDC\n[ 101.3 MHz ]  JBIYHCR","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 88.4 MHz\nEncryption key: 6\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["ORBITAL"]}]'::jsonb, false, 3, 200, 'The answer has 7 letters and starts with O.', '88.4 MHz carries UXHOZGR; shifting back by 6 gives ORBITAL.', null, 25, 'published'),
('mission-binary-0', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag W:  ○ ○ ● ○ ●\nTag R:  ○ ● ● ● ○\nTag V:  ○ ● ● ● ●\nTag M:  ○ ● ○ ● ●\nTag P:  ● ○ ● ○ ○","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nP → V → M → W → R"}}'::jsonb, '[{"label":"Badge word","accept":["TOKEN"]}]'::jsonb, false, 3, 200, 'It is a 5-letter tech word.', 'P=20=T, V=15=O, M=11=K, W=5=E, R=14=N → TOKEN.', null, 25, 'published'),
('mission-binary-1', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag J:  ○ ○ ○ ● ●\nTag P:  ○ ● ○ ○ ○\nTag M:  ○ ○ ○ ● ●\nTag K:  ○ ○ ○ ○ ●\nTag W:  ○ ○ ● ○ ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nJ → K → M → P → W"}}'::jsonb, '[{"label":"Badge word","accept":["CACHE"]}]'::jsonb, false, 3, 200, 'It is a 5-letter tech word.', 'J=3=C, K=1=A, M=3=C, P=8=H, W=5=E → CACHE.', null, 25, 'published'),
('mission-binary-2', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag F:  ○ ○ ○ ● ●\nTag B:  ○ ● ● ○ ○\nTag V:  ○ ○ ● ● ●\nTag Z:  ○ ● ○ ○ ●\nTag T:  ○ ● ● ● ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nB → T → V → Z → F"}}'::jsonb, '[{"label":"Badge word","accept":["LOGIC"]}]'::jsonb, false, 3, 200, 'It is a 5-letter tech word.', 'B=12=L, T=15=O, V=7=G, Z=9=I, F=3=C → LOGIC.', null, 25, 'published'),
('mission-binary-3', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag W:  ○ ● ● ● ●\nTag H:  ○ ○ ● ○ ●\nTag R:  ○ ○ ● ○ ○\nTag N:  ○ ○ ○ ● ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nN → W → R → H"}}'::jsonb, '[{"label":"Badge word","accept":["CODE"]}]'::jsonb, false, 3, 200, 'It is a 4-letter tech word.', 'N=3=C, W=15=O, R=4=D, H=5=E → CODE.', null, 25, 'published'),
('mission-binary-4', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag T:  ● ● ○ ○ ●\nTag P:  ○ ● ○ ○ ●\nTag K:  ○ ○ ○ ● ○\nTag H:  ○ ○ ○ ○ ●\nTag J:  ● ○ ○ ● ○\nTag Z:  ○ ● ● ● ○","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nK → P → Z → H → J → T"}}'::jsonb, '[{"label":"Badge word","accept":["BINARY"]}]'::jsonb, false, 3, 200, 'It is a 6-letter tech word.', 'K=2=B, P=9=I, Z=14=N, H=1=A, J=18=R, T=25=Y → BINARY.', null, 25, 'published'),
('mission-binary-5', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag V:  ● ● ○ ○ ●\nTag K:  ○ ○ ○ ○ ●\nTag W:  ○ ○ ○ ● ○\nTag T:  ○ ● ○ ○ ●\nTag J:  ● ○ ○ ● ○\nTag D:  ○ ● ● ● ○","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nW → T → D → K → J → V"}}'::jsonb, '[{"label":"Badge word","accept":["BINARY"]}]'::jsonb, false, 3, 200, 'It is a 6-letter tech word.', 'W=2=B, T=9=I, D=14=N, K=1=A, J=18=R, V=25=Y → BINARY.', null, 25, 'published'),
('mission-binary-6', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag J:  ○ ○ ● ○ ●\nTag T:  ● ● ○ ○ ●\nTag X:  ○ ○ ○ ● ○\nTag W:  ● ○ ● ○ ○","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nX → T → W → J"}}'::jsonb, '[{"label":"Badge word","accept":["BYTE"]}]'::jsonb, false, 3, 200, 'It is a 4-letter tech word.', 'X=2=B, T=25=Y, W=20=T, J=5=E → BYTE.', null, 25, 'published'),
('mission-binary-7', 'binary', 'mission', 'Badge Reader', 'tech', 1, array['hexavarsity','learning','phase2','stg','helpdesk']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag H:  ○ ● ○ ● ●\nTag V:  ● ○ ○ ● ●\nTag M:  ● ○ ● ○ ○\nTag R:  ○ ○ ○ ● ●\nTag P:  ○ ○ ○ ○ ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nV → M → P → R → H"}}'::jsonb, '[{"label":"Badge word","accept":["STACK"]}]'::jsonb, false, 3, 200, 'It is a 5-letter tech word.', 'V=19=S, M=20=T, P=1=A, R=3=C, H=11=K → STACK.', null, 25, 'published'),
('mission-grid-0', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | G Y C T N\n2 | T N Y E R\n3 | I R Y R Z\n4 | S H B V X\n5 | V N A T K","mono":true},"decoder":{"title":"Marked coordinates","body":"(3, 1)  (4, 3)  (3, 5)  (1, 2)  (4, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["CRATE"]}]'::jsonb, false, 3, 200, 'The code is a 5-letter word ending in E.', 'Reading (column,row) gives CRATE; reading it as (row,column) gives nonsense (IBZYH).', null, 25, 'published'),
('mission-grid-1', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | D F N R A\n2 | I J U M B\n3 | A W C W L\n4 | U N T G K\n5 | C G K S Z","mono":true},"decoder":{"title":"Marked coordinates","body":"(4, 5)  (1, 2)  (2, 5)  (3, 1)  (5, 1)  (5, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SIGNAL"]}]'::jsonb, false, 3, 200, 'The code is a 6-letter word ending in L.', 'Reading (column,row) gives SIGNAL; reading it as (row,column) gives nonsense (KFBACK).', null, 25, 'published'),
('mission-grid-2', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | L P S T U\n2 | Q B S P A\n3 | P Y O K L\n4 | V H S S N\n5 | F Y M K N","mono":true},"decoder":{"title":"Marked coordinates","body":"(3, 4)  (5, 1)  (1, 3)  (2, 1)  (5, 3)  (2, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SUPPLY"]}]'::jsonb, false, 3, 200, 'The code is a 6-letter word ending in Y.', 'Reading (column,row) gives SUPPLY; reading it as (row,column) gives nonsense (KFSQMS).', null, 25, 'published'),
('mission-grid-3', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | F I R L S\n2 | U K K T O\n3 | L A P J C\n4 | T T G I N\n5 | M A K X Y","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 1)  (2, 1)  (3, 4)  (5, 4)  (2, 5)  (1, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SIGNAL"]}]'::jsonb, false, 3, 200, 'The code is a 6-letter word ending in L.', 'Reading (column,row) gives SIGNAL; reading it as (row,column) gives nonsense (MUJXOR).', null, 25, 'published'),
('mission-grid-4', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | J W E E T\n2 | K C R R T\n3 | D F O T R\n4 | J B O E F\n5 | O A W X Y","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 2)  (1, 5)  (2, 1)  (4, 1)  (4, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["TOWER"]}]'::jsonb, false, 3, 200, 'The code is a 5-letter word ending in R.', 'Reading (column,row) gives TOWER; reading it as (row,column) gives nonsense (ATKJB).', null, 25, 'published'),
('mission-grid-5', 'grid', 'mission', 'Coordinate Drop', 'observation', 2, array['terrace','glass','observation','public']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | O U U E S\n2 | V O I Y P\n3 | M S M E N\n4 | T P R T Y\n5 | L O U J F","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 3)  (2, 1)  (2, 4)  (5, 2)  (1, 5)  (5, 4)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SUPPLY"]}]'::jsonb, false, 3, 200, 'The code is a 6-letter word ending in Y.', 'Reading (column,row) gives SUPPLY; reading it as (row,column) gives nonsense (IVYOSJ).', null, 25, 'published'),
('mission-orders-coffee-0', 'orders', 'mission', 'Barista Rush', 'memory', 1, array['costa','coffee','social']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 12: 1× Croissant, 2× Latte, 3× Mocha\nTable 6: 1× Cookie, 2× Cappuccino\nTable 11: 1× Cold Brew, 2× Cookie, 2× Espresso\nTable 7: 2× Cappuccino, 3× Espresso, 2× Latte","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 12.\nHouse rule today: every Croissant is free."}}'::jsonb, '[{"label":"Total","accept":["66"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 12 with the rule applied totals 66.', null, 25, 'published'),
('mission-orders-coffee-1', 'orders', 'mission', 'Barista Rush', 'memory', 1, array['costa','coffee','social']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 7: 2× Cappuccino, 3× Croissant\nTable 6: 2× Espresso, 3× Cappuccino\nTable 9: 2× Latte, 1× Muffin\nTable 8: 2× Espresso, 2× Croissant","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 8.\nHouse rule today: add 5 coins for takeaway packing (once per order)."}}'::jsonb, '[{"label":"Total","accept":["41"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 8 with the rule applied totals 41.', null, 25, 'published'),
('mission-orders-coffee-2', 'orders', 'mission', 'Barista Rush', 'memory', 1, array['costa','coffee','social']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 6: 3× Espresso, 3× Cappuccino\nTable 3: 2× Cookie, 3× Latte\nTable 8: 2× Cappuccino, 3× Espresso, 3× Muffin\nTable 7: 2× Muffin, 3× Cookie, 3× Latte","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 8.\nCorrection: the Muffin quantity on that slip was written as half. Double it."}}'::jsonb, '[{"label":"Total","accept":["100"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 8 with the rule applied totals 100.', null, 25, 'published'),
('mission-orders-coffee-3', 'orders', 'mission', 'Barista Rush', 'memory', 1, array['costa','coffee','social']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 5: 3× Croissant, 2× Latte, 3× Espresso\nTable 7: 3× Mocha, 3× Espresso, 3× Croissant\nTable 9: 2× Cold Brew, 2× Cappuccino, 1× Espresso\nTable 4: 3× Latte, 3× Cold Brew, 3× Cookie","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 4.\nHouse rule today: every Latte is free."}}'::jsonb, '[{"label":"Total","accept":["54"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 4 with the rule applied totals 54.', null, 25, 'published'),
('mission-orders-coffee-4', 'orders', 'mission', 'Barista Rush', 'memory', 1, array['costa','coffee','social']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 8: 2× Muffin, 2× Cookie, 1× Cold Brew\nTable 2: 3× Croissant, 1× Muffin, 2× Cookie\nTable 3: 3× Cookie, 2× Croissant\nTable 4: 2× Espresso, 1× Cold Brew","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 4.\nHouse rule today: every Espresso is free."}}'::jsonb, '[{"label":"Total","accept":["13"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 4 with the rule applied totals 13.', null, 25, 'published'),
('mission-orders-food-0', 'orders', 'mission', 'Mess Hall Ledger', 'memory', 1, array['food','healing','market']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 7: 1× Idli, 3× Curd Rice, 3× Dosa\nTable 2: 1× Biryani, 2× Vada, 2× Paneer Roll\nTable 12: 1× Juice, 2× Curd Rice, 1× Dosa\nTable 4: 3× Paneer Roll, 3× Curd Rice","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 7.\nHouse rule today: every Curd Rice is free."}}'::jsonb, '[{"label":"Total","accept":["36"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 7 with the rule applied totals 36.', null, 25, 'published'),
('mission-orders-food-1', 'orders', 'mission', 'Mess Hall Ledger', 'memory', 1, array['food','healing','market']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 5: 2× Curd Rice, 1× Juice, 2× Meals\nTable 9: 3× Curd Rice, 1× Juice, 3× Dosa\nTable 2: 3× Biryani, 1× Vada, 1× Paneer Roll\nTable 6: 1× Dosa, 1× Meals","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 9.\nHouse rule today: add 5 coins for takeaway packing (once per order)."}}'::jsonb, '[{"label":"Total","accept":["69"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 9 with the rule applied totals 69.', null, 25, 'published'),
('mission-orders-food-2', 'orders', 'mission', 'Mess Hall Ledger', 'memory', 1, array['food','healing','market']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 8: 3× Curd Rice, 1× Meals, 2× Vada\nTable 7: 1× Dosa, 3× Idli\nTable 9: 3× Meals, 1× Juice\nTable 3: 1× Biryani, 1× Dosa, 1× Idli","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 7.\nHouse rule today: add 5 coins for takeaway packing (once per order)."}}'::jsonb, '[{"label":"Total","accept":["33"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 7 with the rule applied totals 33.', null, 25, 'published'),
('mission-orders-food-3', 'orders', 'mission', 'Mess Hall Ledger', 'memory', 1, array['food','healing','market']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 6: 1× Paneer Roll, 3× Juice\nTable 2: 1× Meals, 2× Dosa\nTable 11: 3× Idli, 2× Paneer Roll, 2× Curd Rice\nTable 4: 2× Curd Rice, 3× Meals, 1× Idli","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 11.\nHouse rule today: add 5 coins for takeaway packing (once per order)."}}'::jsonb, '[{"label":"Total","accept":["65"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 11 with the rule applied totals 65.', null, 25, 'published'),
('mission-orders-food-4', 'orders', 'mission', 'Mess Hall Ledger', 'memory', 1, array['food','healing','market']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 7: 3× Juice, 2× Dosa, 1× Vada\nTable 4: 1× Biryani, 3× Juice\nTable 8: 3× Meals, 1× Vada, 3× Biryani\nTable 11: 1× Dosa, 2× Biryani","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 8.\nCorrection: the Meals quantity on that slip was written as half. Double it."}}'::jsonb, '[{"label":"Total","accept":["149"]}]'::jsonb, false, 3, 200, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 8 with the rule applied totals 149.', null, 25, 'published'),
('mission-triad-0', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many bits are in an IPv6 address?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Which port does plain HTTP use by default?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["403"]},{"label":"Part 2 (Decoder)","accept":["128"]},{"label":"Part 3 (Intel)","accept":["80"]}]'::jsonb, false, 3, 200, 'The three numbers have 3, 3, 2 digits.', 'HTTP status code for "Forbidden"? → 403 | How many bits are in an IPv6 address? → 128 | Which port does plain HTTP use by default? → 80', null, 25, 'published'),
('mission-triad-1', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Which port does HTTPS use by default?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["8"]},{"label":"Part 2 (Decoder)","accept":["443"]},{"label":"Part 3 (Intel)","accept":["403"]}]'::jsonb, false, 3, 200, 'The three numbers have 1, 3, 3 digits.', 'How many bits are in one byte? → 8 | Which port does HTTPS use by default? → 443 | HTTP status code for "Forbidden"? → 403', null, 25, 'published'),
('mission-triad-2', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Binary 1010 equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["8"]},{"label":"Part 2 (Decoder)","accept":["10"]},{"label":"Part 3 (Intel)","accept":["403"]}]'::jsonb, false, 3, 200, 'The three numbers have 1, 2, 3 digits.', 'How many bits are in one byte? → 8 | Binary 1010 equals which decimal number? → 10 | HTTP status code for "Forbidden"? → 403', null, 25, 'published'),
('mission-triad-3', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1111 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Binary 11 equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["15"]},{"label":"Part 2 (Decoder)","accept":["3"]},{"label":"Part 3 (Intel)","accept":["8"]}]'::jsonb, false, 3, 200, 'The three numbers have 2, 1, 1 digits.', 'Binary 1111 equals which decimal number? → 15 | Binary 11 equals which decimal number? → 3 | How many bits are in one byte? → 8', null, 25, 'published'),
('mission-triad-4', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Hexadecimal FF equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"In most programming languages, the index of the first array element is?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many bits are in an IPv4 address?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["255"]},{"label":"Part 2 (Decoder)","accept":["0"]},{"label":"Part 3 (Intel)","accept":["32"]}]'::jsonb, false, 3, 200, 'The three numbers have 3, 1, 2 digits.', 'Hexadecimal FF equals which decimal number? → 255 | In most programming languages, the index of the first array element is? → 0 | How many bits are in an IPv4 address? → 32', null, 25, 'published'),
('mission-triad-5', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1010 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Hexadecimal 10 equals which decimal number?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["10"]},{"label":"Part 2 (Decoder)","accept":["8"]},{"label":"Part 3 (Intel)","accept":["16"]}]'::jsonb, false, 3, 200, 'The three numbers have 2, 1, 2 digits.', 'Binary 1010 equals which decimal number? → 10 | How many bits are in one byte? → 8 | Hexadecimal 10 equals which decimal number? → 16', null, 25, 'published'),
('mission-triad-6', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Binary 1111 equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many layers does the OSI model have?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["403"]},{"label":"Part 2 (Decoder)","accept":["15"]},{"label":"Part 3 (Intel)","accept":["7"]}]'::jsonb, false, 3, 200, 'The three numbers have 3, 2, 1 digits.', 'HTTP status code for "Forbidden"? → 403 | Binary 1111 equals which decimal number? → 15 | How many layers does the OSI model have? → 7', null, 25, 'published'),
('mission-triad-7', 'triad', 'mission', 'Tech Triad', 'tech', 1, array['any','stg','testing','helpdesk','learning','office']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Which port does HTTPS use by default?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Binary 11 equals which decimal number?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["443"]},{"label":"Part 2 (Decoder)","accept":["8"]},{"label":"Part 3 (Intel)","accept":["3"]}]'::jsonb, false, 3, 200, 'The three numbers have 3, 1, 1 digits.', 'Which port does HTTPS use by default? → 443 | How many bits are in one byte? → 8 | Binary 11 equals which decimal number? → 3', null, 25, 'published'),
('mission-rebus-0', 'rebus', 'mission', 'Triple Rebus', 'rebus', 1, array['any','learning','social','office','coffee']::text[], 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.', '{"scout":{"title":"Rebus panel 1","body":"FA\n   TH\n      ER","mono":true},"decoder":{"title":"Rebus panel 2","body":"  MIND\n ──────\n MATTER","mono":true},"intel":{"title":"Rebus panel 3","body":"  STAND\n ───────\n    I","mono":true}}'::jsonb, '[{"label":"Panel 1 (Scout)","accept":["STEPFATHER"]},{"label":"Panel 2 (Decoder)","accept":["MINDOVERMATTER"]},{"label":"Panel 3 (Intel)","accept":["IUNDERSTAND"]}]'::jsonb, false, 3, 200, 'Look at the position of each word: over, under, split, repeated, reversed, going down.', 'STEPFATHER: The letters go down like steps. | MIND OVER MATTER: MIND sits over MATTER. | I UNDERSTAND: I is under STAND.', null, 25, 'published'),
('mission-rebus-1', 'rebus', 'mission', 'Triple Rebus', 'rebus', 1, array['any','learning','social','office','coffee']::text[], 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.', '{"scout":{"title":"Rebus panel 1","body":"  HEAD\n ──────\n HEELS","mono":true},"decoder":{"title":"Rebus panel 2","body":"   MAN\n ───────\n  BOARD","mono":true},"intel":{"title":"Rebus panel 3","body":"T\nO\nU\nC\nH","mono":true}}'::jsonb, '[{"label":"Panel 1 (Scout)","accept":["HEADOVERHEELS"]},{"label":"Panel 2 (Decoder)","accept":["MANOVERBOARD"]},{"label":"Panel 3 (Intel)","accept":["TOUCHDOWN"]}]'::jsonb, false, 3, 200, 'Look at the position of each word: over, under, split, repeated, reversed, going down.', 'HEAD OVER HEELS: HEAD sits over HEELS. | MAN OVERBOARD: MAN is over BOARD. | TOUCHDOWN: TOUCH is written going down.', null, 25, 'published'),
('mission-rebus-2', 'rebus', 'mission', 'Triple Rebus', 'rebus', 1, array['any','learning','social','office','coffee']::text[], 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.', '{"scout":{"title":"Rebus panel 1","body":"BAN     ANA","mono":true},"decoder":{"title":"Rebus panel 2","body":"  STOOD\n ───────\n   MIS","mono":true},"intel":{"title":"Rebus panel 3","body":"CYCLE  CYCLE  CYCLE","mono":true}}'::jsonb, '[{"label":"Panel 1 (Scout)","accept":["BANANASPLIT","SPLITBANANA"]},{"label":"Panel 2 (Decoder)","accept":["MISUNDERSTOOD"]},{"label":"Panel 3 (Intel)","accept":["TRICYCLE","THREECYCLES"]}]'::jsonb, false, 3, 200, 'Look at the position of each word: over, under, split, repeated, reversed, going down.', 'BANANA SPLIT: The word BANANA is split. | MISUNDERSTOOD: MIS is under STOOD. | TRICYCLE: Three cycles.', null, 25, 'published'),
('mission-rebus-3', 'rebus', 'mission', 'Triple Rebus', 'rebus', 1, array['any','learning','social','office','coffee']::text[], 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.', '{"scout":{"title":"Rebus panel 1","body":"DICE    DICE","mono":true},"decoder":{"title":"Rebus panel 2","body":"LE     VEL","mono":true},"intel":{"title":"Rebus panel 3","body":"  WORK\n ──────\n  TIME","mono":true}}'::jsonb, '[{"label":"Panel 1 (Scout)","accept":["PARADISE","PAIROFDICE"]},{"label":"Panel 2 (Decoder)","accept":["SPLITLEVEL"]},{"label":"Panel 3 (Intel)","accept":["WORKOVERTIME","OVERTIMEWORK"]}]'::jsonb, false, 3, 200, 'Look at the position of each word: over, under, split, repeated, reversed, going down.', 'PARADISE: A pair of dice sounds like paradise. | SPLIT LEVEL: LEVEL is split. | WORK OVERTIME: WORK is over TIME.', null, 25, 'published'),
('mission-rebus-4', 'rebus', 'mission', 'Triple Rebus', 'rebus', 1, array['any','learning','social','office','coffee']::text[], 'Each teammate holds one picture-word puzzle. Solve all three and enter each answer in its box.', '{"scout":{"title":"Rebus panel 1","body":"E C N A L G","mono":true},"decoder":{"title":"Rebus panel 2","body":"D\nU\nC\nK","mono":true},"intel":{"title":"Rebus panel 3","body":"HISTORY  HISTORY","mono":true}}'::jsonb, '[{"label":"Panel 1 (Scout)","accept":["BACKWARDGLANCE","BACKWARDSGLANCE"]},{"label":"Panel 2 (Decoder)","accept":["DUCKDOWN"]},{"label":"Panel 3 (Intel)","accept":["HISTORYREPEATSITSELF","HISTORYREPEATS","REPEATEDHISTORY"]}]'::jsonb, false, 3, 200, 'Look at the position of each word: over, under, split, repeated, reversed, going down.', 'BACKWARD GLANCE: GLANCE written backward. | DUCK DOWN: DUCK is written going down. | HISTORY REPEATS ITSELF: HISTORY repeats.', null, 25, 'published'),
('mission-anagram-0', 'anagram', 'mission', 'Corporate Scramble', 'office', 1, array['office','hr','boardroom','parking','social']::text[], 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.', '{"scout":{"title":"Shredded memo strip 1","body":"I E D L N A D E\n\n(One office buzzword, letters scrambled.)","mono":true},"decoder":{"title":"Shredded memo strip 2","body":"E I N I V C O\n\n(One office buzzword, letters scrambled.)","mono":true},"intel":{"title":"Shredded memo strip 3","body":"E V E E R L G A\n\n(One office buzzword, letters scrambled.)","mono":true}}'::jsonb, '[{"label":"Strip 1 (Scout)","accept":["DEADLINE"]},{"label":"Strip 2 (Decoder)","accept":["INVOICE"]},{"label":"Strip 3 (Intel)","accept":["LEVERAGE"]}]'::jsonb, false, 3, 200, 'First letters: D, I, L.', 'DEADLINE, INVOICE, LEVERAGE', null, 25, 'published'),
('mission-anagram-1', 'anagram', 'mission', 'Corporate Scramble', 'office', 1, array['office','hr','boardroom','parking','social']::text[], 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.', '{"scout":{"title":"Shredded memo strip 1","body":"A V E E E L R G\n\n(One office buzzword, letters scrambled.)","mono":true},"decoder":{"title":"Shredded memo strip 2","body":"E E M T I H T S E\n\n(One office buzzword, letters scrambled.)","mono":true},"intel":{"title":"Shredded memo strip 3","body":"I N I C E V O\n\n(One office buzzword, letters scrambled.)","mono":true}}'::jsonb, '[{"label":"Strip 1 (Scout)","accept":["LEVERAGE"]},{"label":"Strip 2 (Decoder)","accept":["TIMESHEET"]},{"label":"Strip 3 (Intel)","accept":["INVOICE"]}]'::jsonb, false, 3, 200, 'First letters: L, T, I.', 'LEVERAGE, TIMESHEET, INVOICE', null, 25, 'published'),
('mission-anagram-2', 'anagram', 'mission', 'Corporate Scramble', 'office', 1, array['office','hr','boardroom','parking','social']::text[], 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.', '{"scout":{"title":"Shredded memo strip 1","body":"O W L O R K W F\n\n(One office buzzword, letters scrambled.)","mono":true},"decoder":{"title":"Shredded memo strip 2","body":"D B A W N I D H T\n\n(One office buzzword, letters scrambled.)","mono":true},"intel":{"title":"Shredded memo strip 3","body":"A P R A P A S L I\n\n(One office buzzword, letters scrambled.)","mono":true}}'::jsonb, '[{"label":"Strip 1 (Scout)","accept":["WORKFLOW"]},{"label":"Strip 2 (Decoder)","accept":["BANDWIDTH"]},{"label":"Strip 3 (Intel)","accept":["APPRAISAL"]}]'::jsonb, false, 3, 200, 'First letters: W, B, A.', 'WORKFLOW, BANDWIDTH, APPRAISAL', null, 25, 'published'),
('mission-anagram-3', 'anagram', 'mission', 'Corporate Scramble', 'office', 1, array['office','hr','boardroom','parking','social']::text[], 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.', '{"scout":{"title":"Shredded memo strip 1","body":"T E N M E G I\n\n(One office buzzword, letters scrambled.)","mono":true},"decoder":{"title":"Shredded memo strip 2","body":"M A R T O R I B S N\n\n(One office buzzword, letters scrambled.)","mono":true},"intel":{"title":"Shredded memo strip 3","body":"W O O W K L R F\n\n(One office buzzword, letters scrambled.)","mono":true}}'::jsonb, '[{"label":"Strip 1 (Scout)","accept":["MEETING"]},{"label":"Strip 2 (Decoder)","accept":["BRAINSTORM"]},{"label":"Strip 3 (Intel)","accept":["WORKFLOW"]}]'::jsonb, false, 3, 200, 'First letters: M, B, W.', 'MEETING, BRAINSTORM, WORKFLOW', null, 25, 'published'),
('mission-anagram-4', 'anagram', 'mission', 'Corporate Scramble', 'office', 1, array['office','hr','boardroom','parking','social']::text[], 'Squad 00 shredded a meeting memo into three strips. Unscramble each strip and enter the buzzwords.', '{"scout":{"title":"Shredded memo strip 1","body":"O M A A D P R\n\n(One office buzzword, letters scrambled.)","mono":true},"decoder":{"title":"Shredded memo strip 2","body":"S G Y Y R N E\n\n(One office buzzword, letters scrambled.)","mono":true},"intel":{"title":"Shredded memo strip 3","body":"N D L E D A I E\n\n(One office buzzword, letters scrambled.)","mono":true}}'::jsonb, '[{"label":"Strip 1 (Scout)","accept":["ROADMAP"]},{"label":"Strip 2 (Decoder)","accept":["SYNERGY"]},{"label":"Strip 3 (Intel)","accept":["DEADLINE"]}]'::jsonb, false, 3, 200, 'First letters: R, S, D.', 'ROADMAP, SYNERGY, DEADLINE', null, 25, 'published'),
('mission-keypad-0', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 3, 7, 9, 5\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: the 2nd and 3rd digits are swapped."}}'::jsonb, '[{"label":"Access code","accept":["9573"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 9753, after the wiring fault 9573.', null, 25, 'published'),
('mission-keypad-1', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 2, 7, 1, 6\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"ODD digits come first (smallest to largest), then EVEN digits (largest to smallest)."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["2761"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 1762, after the wiring fault 2761.', null, 25, 'published'),
('mission-keypad-2', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 3, 6, 4, 1\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["6432"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 6431, after the wiring fault 6432.', null, 25, 'published'),
('mission-keypad-3', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 7, 1, 8, 5\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["8752"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 8751, after the wiring fault 8752.', null, 25, 'published'),
('mission-keypad-4', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 5, 6, 2\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["2659"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 9652, after the wiring fault 2659.', null, 25, 'published'),
('mission-keypad-5', 'keypad', 'mission', 'Worn Keypad', 'decoding', 1, array['gate','access','parking']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 2, 9, 8, 1\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["1280"]}]'::jsonb, false, 3, 200, 'The code has 4 digits.', 'Ordered digits 1289, after the wiring fault 1280.', null, 25, 'published'),
('mission-cricket-0', 'cricket', 'mission', 'Scoreboard Decode', 'sports', 1, array['sports']::text[], 'The sports-zone scoreboard hides a code. Calculate it and enter the number.', '{"scout":{"title":"Ball-by-ball board","body":"Over 1:  Wd  1  1  2  1  •\nOver 2:  1  1  2  •  2  4\nOver 3:  2  1  1  1  Wd  •\nOver 4:  Wd  •  2  •  W  •","mono":true},"decoder":{"title":"League scoring legend","body":"• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run"},"intel":{"title":"Code rule","body":"The code is the total of overs 2 and 3 only."}}'::jsonb, '[{"label":"Code","accept":["16"]}]'::jsonb, false, 3, 200, 'Remember: a wicket subtracts 5 in this league.', 'Overs 2 and 3 total 16.', null, 25, 'published'),
('mission-cricket-1', 'cricket', 'mission', 'Scoreboard Decode', 'sports', 1, array['sports']::text[], 'The sports-zone scoreboard hides a code. Calculate it and enter the number.', '{"scout":{"title":"Ball-by-ball board","body":"Over 1:  2  6  •  Wd  2  6\nOver 2:  2  Wd  6  4  2  6\nOver 3:  2  •  6  6  2  1\nOver 4:  1  2  2  2  6  4","mono":true},"decoder":{"title":"League scoring legend","body":"• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run"},"intel":{"title":"Code rule","body":"The code is the total of overs 1 and 3 only."}}'::jsonb, '[{"label":"Code","accept":["34"]}]'::jsonb, false, 3, 200, 'Remember: a wicket subtracts 5 in this league.', 'Overs 1 and 3 total 34.', null, 25, 'published'),
('mission-cricket-2', 'cricket', 'mission', 'Scoreboard Decode', 'sports', 1, array['sports']::text[], 'The sports-zone scoreboard hides a code. Calculate it and enter the number.', '{"scout":{"title":"Ball-by-ball board","body":"Over 1:  1  •  6  •  6  W\nOver 2:  •  2  2  1  Wd  W\nOver 3:  Wd  2  W  2  2  6\nOver 4:  •  2  •  1  1  W","mono":true},"decoder":{"title":"League scoring legend","body":"• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run"},"intel":{"title":"Code rule","body":"The code is the total of overs 3 and 4 only."}}'::jsonb, '[{"label":"Code","accept":["7"]}]'::jsonb, false, 3, 200, 'Remember: a wicket subtracts 5 in this league.', 'Overs 3 and 4 total 7.', null, 25, 'published'),
('mission-cricket-3', 'cricket', 'mission', 'Scoreboard Decode', 'sports', 1, array['sports']::text[], 'The sports-zone scoreboard hides a code. Calculate it and enter the number.', '{"scout":{"title":"Ball-by-ball board","body":"Over 1:  1  4  4  W  •  6\nOver 2:  •  W  1  1  4  W\nOver 3:  •  W  •  2  Wd  Wd\nOver 4:  •  2  W  4  W  Wd","mono":true},"decoder":{"title":"League scoring legend","body":"• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run"},"intel":{"title":"Code rule","body":"The code is the total of overs 2 and 3 only."}}'::jsonb, '[{"label":"Code","accept":["5"]}]'::jsonb, false, 3, 200, 'Remember: a wicket subtracts 5 in this league.', 'Overs 2 and 3 total -5.', null, 25, 'published'),
('mission-cricket-4', 'cricket', 'mission', 'Scoreboard Decode', 'sports', 1, array['sports']::text[], 'The sports-zone scoreboard hides a code. Calculate it and enter the number.', '{"scout":{"title":"Ball-by-ball board","body":"Over 1:  1  2  W  •  6  1\nOver 2:  •  4  1  •  2  Wd\nOver 3:  4  •  1  •  •  1\nOver 4:  Wd  W  2  W  •  2","mono":true},"decoder":{"title":"League scoring legend","body":"• = dot ball (0)\nNumber = runs scored\nW = wicket: this league DEDUCTS 5 runs\nWd = wide: 1 run"},"intel":{"title":"Code rule","body":"The code is the total of overs 1 and 2 only."}}'::jsonb, '[{"label":"Code","accept":["13"]}]'::jsonb, false, 3, 200, 'Remember: a wicket subtracts 5 in this league.', 'Overs 1 and 2 total 13.', null, 25, 'published'),
('mission-sequence-0', 'sequence', 'mission', 'Pattern Lock', 'logic', 1, array['learning','office','glass','phase2','any']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  3, 5, 8, 13, 21, ?\nBRAVO:  6, 11, 16, 21, 26, ?\nCHARLIE:  3, 7, 15, 31, 63, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number multiplied by 2."},"intel":{"title":"Insider tip","body":"The genuine pattern is ALPHA. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["68"]}]'::jsonb, false, 3, 200, 'Look at the difference (or ratio) between neighbouring numbers.', 'ALPHA continues with 34; converted: 68.', null, 25, 'published'),
('mission-sequence-1', 'sequence', 'mission', 'Pattern Lock', 'logic', 1, array['learning','office','glass','phase2','any']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  5, 9, 13, 17, 21, ?\nBRAVO:  2, 3, 5, 8, 13, ?\nCHARLIE:  4, 8, 16, 32, 64, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number plus 10."},"intel":{"title":"Insider tip","body":"The genuine pattern is BRAVO. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["31"]}]'::jsonb, false, 3, 200, 'Look at the difference (or ratio) between neighbouring numbers.', 'BRAVO continues with 21; converted: 31.', null, 25, 'published'),
('mission-sequence-2', 'sequence', 'mission', 'Pattern Lock', 'logic', 1, array['learning','office','glass','phase2','any']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  4, 8, 16, 32, 64, ?\nBRAVO:  5, 8, 11, 14, 17, ?\nCHARLIE:  4, 9, 19, 39, 79, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number multiplied by 2."},"intel":{"title":"Insider tip","body":"The genuine pattern is CHARLIE. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["318"]}]'::jsonb, false, 3, 200, 'Look at the difference (or ratio) between neighbouring numbers.', 'CHARLIE continues with 159; converted: 318.', null, 25, 'published'),
('mission-sequence-3', 'sequence', 'mission', 'Pattern Lock', 'logic', 1, array['learning','office','glass','phase2','any']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  4, 9, 19, 39, 79, ?\nBRAVO:  4, 9, 16, 25, 36, ?\nCHARLIE:  2, 4, 6, 10, 16, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number minus 1."},"intel":{"title":"Insider tip","body":"The genuine pattern is ALPHA. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["158"]}]'::jsonb, false, 3, 200, 'Look at the difference (or ratio) between neighbouring numbers.', 'ALPHA continues with 159; converted: 158.', null, 25, 'published'),
('mission-sequence-4', 'sequence', 'mission', 'Pattern Lock', 'logic', 1, array['learning','office','glass','phase2','any']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  4, 11, 18, 25, 32, ?\nBRAVO:  4, 8, 16, 32, 64, ?\nCHARLIE:  1, 3, 7, 15, 31, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number plus 10."},"intel":{"title":"Insider tip","body":"The genuine pattern is BRAVO. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["138"]}]'::jsonb, false, 3, 200, 'Look at the difference (or ratio) between neighbouring numbers.', 'BRAVO continues with 128; converted: 138.', null, 25, 'published'),
('mission-memory-0', 'memory', 'mission', 'Flash Memory', 'memory', 2, array['food','healing','costa','learning']::text[], 'A security camera flashed a sequence of objects for a few seconds. Rebuild the code from it.', '{"scout":{"title":"Camera flash (disappears after 20 s!)","body":"📱   🎧   🔋   ☕   📦   🍩   📎","reveal_seconds":20},"decoder":{"title":"Object → letter key","body":"☕ = X    🍩 = I    📎 = J    🖥️ = S    🔑 = W    📦 = F    🎧 = D    📱 = Q    🧾 = R    🔋 = M"},"intel":{"title":"Positions that matter","body":"Use only objects number 5, 6, 7 (counting from the left)."}}'::jsonb, '[{"label":"Letter code","accept":["FIJ"]}]'::jsonb, false, 3, 200, 'Scout: say the objects out loud while they are visible.', 'Positions 5, 6, 7 were 📦 🍩 📎 → FIJ.', null, 25, 'published'),
('mission-memory-1', 'memory', 'mission', 'Flash Memory', 'memory', 2, array['food','healing','costa','learning']::text[], 'A security camera flashed a sequence of objects for a few seconds. Rebuild the code from it.', '{"scout":{"title":"Camera flash (disappears after 20 s!)","body":"📎   🔑   🧾   ☕   🖥️   📦   🎧","reveal_seconds":20},"decoder":{"title":"Object → letter key","body":"☕ = F    🍩 = D    📎 = K    🖥️ = N    🔑 = P    📦 = Y    🎧 = X    📱 = J    🧾 = R    🔋 = T"},"intel":{"title":"Positions that matter","body":"Use only objects number 2, 4, 6 (counting from the left)."}}'::jsonb, '[{"label":"Letter code","accept":["PFY"]}]'::jsonb, false, 3, 200, 'Scout: say the objects out loud while they are visible.', 'Positions 2, 4, 6 were 🔑 ☕ 📦 → PFY.', null, 25, 'published'),
('mission-memory-2', 'memory', 'mission', 'Flash Memory', 'memory', 2, array['food','healing','costa','learning']::text[], 'A security camera flashed a sequence of objects for a few seconds. Rebuild the code from it.', '{"scout":{"title":"Camera flash (disappears after 20 s!)","body":"🔋   🍩   ☕   🔑   🧾   📦   📎","reveal_seconds":20},"decoder":{"title":"Object → letter key","body":"☕ = B    🍩 = O    📎 = X    🖥️ = U    🔑 = I    📦 = N    🎧 = G    📱 = H    🧾 = S    🔋 = L"},"intel":{"title":"Positions that matter","body":"Use only objects number 1, 3, 6 (counting from the left)."}}'::jsonb, '[{"label":"Letter code","accept":["LBN"]}]'::jsonb, false, 3, 200, 'Scout: say the objects out loud while they are visible.', 'Positions 1, 3, 6 were 🔋 ☕ 📦 → LBN.', null, 25, 'published'),
('mission-memory-3', 'memory', 'mission', 'Flash Memory', 'memory', 2, array['food','healing','costa','learning']::text[], 'A security camera flashed a sequence of objects for a few seconds. Rebuild the code from it.', '{"scout":{"title":"Camera flash (disappears after 20 s!)","body":"🔑   🖥️   📱   ☕   📦   🔋   📎","reveal_seconds":20},"decoder":{"title":"Object → letter key","body":"☕ = J    🍩 = Z    📎 = R    🖥️ = D    🔑 = Y    📦 = F    🎧 = G    📱 = C    🧾 = N    🔋 = T"},"intel":{"title":"Positions that matter","body":"Use only objects number 1, 3, 4 (counting from the left)."}}'::jsonb, '[{"label":"Letter code","accept":["YCJ"]}]'::jsonb, false, 3, 200, 'Scout: say the objects out loud while they are visible.', 'Positions 1, 3, 4 were 🔑 📱 ☕ → YCJ.', null, 25, 'published'),
('relay-triad-100', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1111 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Binary 11 equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["15"]},{"label":"Part 2 (Decoder)","accept":["3"]},{"label":"Part 3 (Intel)","accept":["404"]}]'::jsonb, true, 3, 240, 'The three numbers have 2, 1, 3 digits.', 'Binary 1111 equals which decimal number? → 15 | Binary 11 equals which decimal number? → 3 | HTTP status code for "Not Found"? → 404', null, 25, 'published'),
('relay-triad-101', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1111 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Hexadecimal 1A equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["15"]},{"label":"Part 2 (Decoder)","accept":["26"]},{"label":"Part 3 (Intel)","accept":["403"]}]'::jsonb, true, 3, 240, 'The three numbers have 2, 2, 3 digits.', 'Binary 1111 equals which decimal number? → 15 | Hexadecimal 1A equals which decimal number? → 26 | HTTP status code for "Forbidden"? → 403', null, 25, 'published'),
('relay-triad-102', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"In most programming languages, the index of the first array element is?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Which port does plain HTTP use by default?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["404"]},{"label":"Part 2 (Decoder)","accept":["0"]},{"label":"Part 3 (Intel)","accept":["80"]}]'::jsonb, true, 3, 240, 'The three numbers have 3, 1, 2 digits.', 'HTTP status code for "Not Found"? → 404 | In most programming languages, the index of the first array element is? → 0 | Which port does plain HTTP use by default? → 80', null, 25, 'published'),
('relay-triad-103', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 11 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Hexadecimal FF equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many bytes are in one kibibyte (KiB)?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["3"]},{"label":"Part 2 (Decoder)","accept":["255"]},{"label":"Part 3 (Intel)","accept":["1024"]}]'::jsonb, true, 3, 240, 'The three numbers have 1, 3, 4 digits.', 'Binary 11 equals which decimal number? → 3 | Hexadecimal FF equals which decimal number? → 255 | How many bytes are in one kibibyte (KiB)? → 1024', null, 25, 'published'),
('relay-triad-104', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1000 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many characters does a standard SHA-256 hex digest have?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["8"]},{"label":"Part 2 (Decoder)","accept":["64"]},{"label":"Part 3 (Intel)","accept":["404"]}]'::jsonb, true, 3, 240, 'The three numbers have 1, 2, 3 digits.', 'Binary 1000 equals which decimal number? → 8 | How many characters does a standard SHA-256 hex digest have? → 64 | HTTP status code for "Not Found"? → 404', null, 25, 'published'),
('relay-triad-105', 'relay', 'relay', 'Intelligence Exchange', 'tech', 1, array['social','coffee','public','market']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Which port does plain HTTP use by default?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many hexadecimal digits exist (0 to F)?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["404"]},{"label":"Part 2 (Decoder)","accept":["80"]},{"label":"Part 3 (Intel)","accept":["16"]}]'::jsonb, true, 3, 240, 'The three numbers have 3, 2, 2 digits.', 'HTTP status code for "Not Found"? → 404 | Which port does plain HTTP use by default? → 80 | How many hexadecimal digits exist (0 to F)? → 16', null, 25, 'published'),
('mission-bughunt-0', 'bughunt', 'mission', 'Bug Hunt', 'tech', 1, array['stg','testing','office']::text[], 'A test failed in the STG lab. Find the buggy line and the value that fixes it.', '{"scout":{"title":"Source code","body":"1  total = 0\n2  for i in range(1, 5):\n3      total = total + i\n4  print(total)","mono":true},"decoder":{"title":"Test log","body":"Test log: the program printed 10.\nLanguage rule: range(a, b) stops BEFORE b."},"intel":{"title":"Requirement","body":"Spec: add the numbers 1 to 5 and print 15."}}'::jsonb, '[{"label":"Bug line number","accept":["2"]},{"label":"Correct value","accept":["6"]}]'::jsonb, false, 3, 200, 'Compare what the code does with what the requirement says.', 'Line 2 should be range(1, 6).', null, 25, 'published'),
('mission-bughunt-1', 'bughunt', 'mission', 'Bug Hunt', 'tech', 1, array['stg','testing','office']::text[], 'A test failed in the STG lab. Find the buggy line and the value that fixes it.', '{"scout":{"title":"Source code","body":"1  price = 200\n2  discount = 10\n3  final = price - price * discount\n4  print(final)","mono":true},"decoder":{"title":"Test log","body":"Test log: the program printed -1800.\nRule: a percentage must be divided by 100 before multiplying."},"intel":{"title":"Requirement","body":"Spec: apply a 10% discount to 200. Report the bug line and the correct printed value."}}'::jsonb, '[{"label":"Bug line number","accept":["3"]},{"label":"Correct value","accept":["180"]}]'::jsonb, false, 3, 200, 'Compare what the code does with what the requirement says.', 'Line 3 must use discount / 100, giving 180.', null, 25, 'published'),
('mission-bughunt-2', 'bughunt', 'mission', 'Bug Hunt', 'tech', 1, array['stg','testing','office']::text[], 'A test failed in the STG lab. Find the buggy line and the value that fixes it.', '{"scout":{"title":"Source code","body":"1  names = [\"Asha\", \"Ben\", \"Chen\"]\n2  last = names[3]\n3  print(last)","mono":true},"decoder":{"title":"Test log","body":"Test log: crashed with \"index out of range\".\nRule: list positions start at 0."},"intel":{"title":"Requirement","body":"Spec: print the LAST name. Report the bug line and the index that should be used."}}'::jsonb, '[{"label":"Bug line number","accept":["2"]},{"label":"Correct value","accept":["2"]}]'::jsonb, false, 3, 200, 'Compare what the code does with what the requirement says.', 'Index 3 does not exist; the last item is at index 2.', null, 25, 'published'),
('mission-boardroom-0', 'boardroom', 'mission', 'Boardroom Mole', 'logic', 2, array['boardroom']::text[], 'Squad 00 planted a mole in the boardroom. Work out the seating and name the mole.', '{"scout":{"title":"Boardroom seating chart","body":"Round table, seats 1–6 clockwise.\nSeats directly opposite: 1–4, 2–5, 3–6.\nSeat 3: LEGAL\nSeat 5: OPS\nSeats 1, 2, 4, 6: unknown","mono":true},"decoder":{"title":"Seating rules","body":"Remaining guests: CTO, CFO, HR, SALES.\n• CTO sits directly opposite LEGAL.\n• HR sits directly next to OPS.\n• SALES is not in seat 1."},"intel":{"title":"Mole intel","body":"The mole sits directly opposite the CFO. Submit the mole''s role."}}'::jsonb, '[{"label":"Mole''s role","accept":["HR","HUMANRESOURCES"]}]'::jsonb, false, 3, 220, 'Place the CTO first, then HR.', 'CTO 6, HR 4, Sales 2, CFO 1 → opposite seat 1 is seat 4: HR.', null, 25, 'published'),
('mission-boardroom-1', 'boardroom', 'mission', 'Boardroom Mole', 'logic', 2, array['boardroom']::text[], 'Squad 00 planted a mole in the boardroom. Work out the seating and name the mole.', '{"scout":{"title":"Boardroom seating chart","body":"Round table, seats 1–6 clockwise.\nSeats directly opposite: 1–4, 2–5, 3–6.\nSeat 3: LEGAL\nSeat 5: OPS\nSeats 1, 2, 4, 6: unknown","mono":true},"decoder":{"title":"Seating rules","body":"Remaining guests: CTO, CFO, HR, SALES.\n• CTO sits directly opposite LEGAL.\n• HR sits directly next to OPS.\n• SALES is not in seat 1."},"intel":{"title":"Mole intel","body":"The mole sits directly opposite SALES. Submit the mole''s role."}}'::jsonb, '[{"label":"Mole''s role","accept":["OPS","OPERATIONS"]}]'::jsonb, false, 3, 220, 'Place the CTO first, then HR.', 'CTO 6, HR 4, Sales 2, CFO 1 → opposite seat 2 is seat 5: OPS.', null, 25, 'published'),
('mission-hr-0', 'scheduler', 'mission', 'Room Booking Crisis', 'logic', 1, array['hr','office']::text[], 'HR needs a 1-hour room for an urgent team huddle. Find the right booking.', '{"scout":{"title":"Room availability","body":"         9:00   10:00   11:00\nRoom A   free   busy    free\nRoom B   free   busy    free\nRoom C   free   free    busy\nRoom D   busy   free    free","mono":true},"decoder":{"title":"Attendee constraints","body":"• The huddle needs a screen: only Rooms B and D have one.\n• The designer cannot attend at 9:00."},"intel":{"title":"Booking policy","body":"Book the EARLIEST slot that works.\nSubmit as room letter + hour, e.g. A9."}}'::jsonb, '[{"label":"Booking","accept":["D10"]}]'::jsonb, false, 3, 180, 'Rule out 9:00 first.', 'Only B/D have screens, 9:00 is out, B is busy at 10 → D10.', null, 25, 'published'),
('mission-hr-1', 'scheduler', 'mission', 'Room Booking Crisis', 'logic', 1, array['hr','office']::text[], 'HR needs a 1-hour room for an urgent team huddle. Find the right booking.', '{"scout":{"title":"Room availability","body":"         9:00   10:00   11:00\nRoom A   free   free    busy\nRoom B   free   busy    free\nRoom C   busy   free    free\nRoom D   busy   busy    free","mono":true},"decoder":{"title":"Attendee constraints","body":"• The huddle needs a screen: only Rooms B and D have one.\n• The designer cannot attend at 9:00."},"intel":{"title":"Booking policy","body":"Book the EARLIEST slot that works. If two rooms tie, pick Room B (closest to HR).\nSubmit as room letter + hour, e.g. A9."}}'::jsonb, '[{"label":"Booking","accept":["B11"]}]'::jsonb, false, 3, 180, 'Check 10:00 for B and D first.', 'At 10 both B and D are busy; at 11 both are free → tie → B11.', null, 25, 'published'),
('battle-triad-200', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Ctrl + which letter usually means Undo? Give its position in the alphabet (A=1).\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"HTTP status code for \"Internal Server Error\"?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Binary 1010 equals which decimal number?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["26"]},{"label":"Part 2 (Decoder)","accept":["500"]},{"label":"Part 3 (Intel)","accept":["10"]}]'::jsonb, false, 3, 90, 'The three numbers have 2, 3, 2 digits.', 'Ctrl + which letter usually means Undo? Give its position in the alphabet (A=1). → 26 | HTTP status code for "Internal Server Error"? → 500 | Binary 1010 equals which decimal number? → 10', null, 25, 'published'),
('battle-triad-201', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Binary 1000 equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Function key that refreshes most browser pages: F?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"OK\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["8"]},{"label":"Part 2 (Decoder)","accept":["5"]},{"label":"Part 3 (Intel)","accept":["200"]}]'::jsonb, false, 3, 90, 'The three numbers have 1, 1, 3 digits.', 'Binary 1000 equals which decimal number? → 8 | Function key that refreshes most browser pages: F? → 5 | HTTP status code for "OK"? → 200', null, 25, 'published'),
('battle-triad-202', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"How many hexadecimal digits exist (0 to F)?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Binary 1000 equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Function key that refreshes most browser pages: F?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["16"]},{"label":"Part 2 (Decoder)","accept":["8"]},{"label":"Part 3 (Intel)","accept":["5"]}]'::jsonb, false, 3, 90, 'The three numbers have 2, 1, 1 digits.', 'How many hexadecimal digits exist (0 to F)? → 16 | Binary 1000 equals which decimal number? → 8 | Function key that refreshes most browser pages: F? → 5', null, 25, 'published'),
('battle-triad-203', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"Hexadecimal F equals which decimal number?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Function key that refreshes most browser pages: F?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["15"]},{"label":"Part 2 (Decoder)","accept":["5"]},{"label":"Part 3 (Intel)","accept":["403"]}]'::jsonb, false, 3, 90, 'The three numbers have 2, 1, 3 digits.', 'Hexadecimal F equals which decimal number? → 15 | Function key that refreshes most browser pages: F? → 5 | HTTP status code for "Forbidden"? → 403', null, 25, 'published'),
('battle-triad-204', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"How many bytes are in one kibibyte (KiB)?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"In most programming languages, the index of the first array element is?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["1024"]},{"label":"Part 2 (Decoder)","accept":["0"]},{"label":"Part 3 (Intel)","accept":["8"]}]'::jsonb, false, 3, 90, 'The three numbers have 4, 1, 1 digits.', 'How many bytes are in one kibibyte (KiB)? → 1024 | In most programming languages, the index of the first array element is? → 0 | How many bits are in one byte? → 8', null, 25, 'published'),
('battle-triad-205', 'triad', 'battle', 'Tech Triad', 'tech', 1, array['duel_pistol']::text[], 'Each teammate holds one tech question. Collect all three numbers and enter them in order.', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"Forbidden\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"Hexadecimal F equals which decimal number?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Hexadecimal 1A equals which decimal number?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Part 1 (Scout)","accept":["403"]},{"label":"Part 2 (Decoder)","accept":["15"]},{"label":"Part 3 (Intel)","accept":["26"]}]'::jsonb, false, 3, 90, 'The three numbers have 3, 2, 2 digits.', 'HTTP status code for "Forbidden"? → 403 | Hexadecimal F equals which decimal number? → 15 | Hexadecimal 1A equals which decimal number? → 26', null, 25, 'published'),
('battle-keypad-200', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_pistol']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 8, 3, 5\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"ODD digits come first (smallest to largest), then EVEN digits (largest to smallest)."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["8593"]}]'::jsonb, false, 3, 90, 'The code has 4 digits.', 'Ordered digits 3598, after the wiring fault 8593.', null, 25, 'published'),
('battle-keypad-201', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_pistol']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 7, 2, 4, 3\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["2348"]}]'::jsonb, false, 3, 90, 'The code has 4 digits.', 'Ordered digits 2347, after the wiring fault 2348.', null, 25, 'published'),
('battle-keypad-202', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_pistol']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 1, 5, 7, 4\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["1547"]}]'::jsonb, false, 3, 90, 'The code has 4 digits.', 'Ordered digits 7541, after the wiring fault 1547.', null, 25, 'published'),
('battle-keypad-203', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_pistol']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 3, 6, 2\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: the 2nd and 3rd digits are swapped."}}'::jsonb, '[{"label":"Access code","accept":["2639"]}]'::jsonb, false, 3, 90, 'The code has 4 digits.', 'Ordered digits 2369, after the wiring fault 2639.', null, 25, 'published'),
('battle-keypad-300', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 3, 4\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: the 2nd and 3rd digits are swapped."}}'::jsonb, '[{"label":"Access code","accept":["934"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 943, after the wiring fault 934.', null, 25, 'published'),
('battle-keypad-301', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 1, 5, 9\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"ODD digits come first (smallest to largest), then EVEN digits (largest to smallest)."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["951"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 159, after the wiring fault 951.', null, 25, 'published'),
('battle-keypad-302', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 3, 5, 9\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: the 2nd and 3rd digits are swapped."}}'::jsonb, '[{"label":"Access code","accept":["395"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 359, after the wiring fault 395.', null, 25, 'published'),
('battle-keypad-303', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 5, 4, 7\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["755"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 754, after the wiring fault 755.', null, 25, 'published'),
('battle-keypad-304', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 8, 9, 3\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"Enter the code in REVERSE order."}}'::jsonb, '[{"label":"Access code","accept":["389"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 983, after the wiring fault 389.', null, 25, 'published'),
('battle-keypad-305', 'keypad', 'battle', 'Worn Keypad', 'decoding', 1, array['duel_smg']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 2, 3, 4\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["432"]}]'::jsonb, false, 3, 50, 'The code has 3 digits.', 'Ordered digits 234, after the wiring fault 432.', null, 25, 'published'),
('battle-caesar-400', 'caesar', 'battle', 'Signal Intercept', 'decoding', 2, array['duel_sniper']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 107.2 MHz ]  QXARIXW\n[ 88.4 MHz ]  TWGNYFQ\n[ 94.3 MHz ]  FXKBWBTG","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 88.4 MHz\nEncryption key: 5\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["ORBITAL"]}]'::jsonb, false, 3, 120, 'The answer has 7 letters and starts with O.', '88.4 MHz carries TWGNYFQ; shifting back by 5 gives ORBITAL.', null, 25, 'published'),
('battle-caesar-401', 'caesar', 'battle', 'Signal Intercept', 'decoding', 2, array['duel_sniper']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 98.7 MHz ]  OAYBMEE\n[ 101.3 MHz ]  XCRTZVI\n[ 104.9 MHz ]  NITKWV","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 8\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["FALCON"]}]'::jsonb, false, 3, 120, 'The answer has 6 letters and starts with F.', '104.9 MHz carries NITKWV; shifting back by 8 gives FALCON.', null, 25, 'published'),
('battle-caesar-402', 'caesar', 'battle', 'Signal Intercept', 'decoding', 2, array['duel_sniper']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 94.3 MHz ]  KPEGMIV\n[ 91.1 MHz ]  BEOVGNY\n[ 98.7 MHz ]  JSVASFL","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 94.3 MHz\nEncryption key: 4\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["GLACIER"]}]'::jsonb, false, 3, 120, 'The answer has 7 letters and starts with G.', '94.3 MHz carries KPEGMIV; shifting back by 4 gives GLACIER.', null, 25, 'published'),
('battle-caesar-403', 'caesar', 'battle', 'Signal Intercept', 'decoding', 2, array['duel_sniper']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 94.3 MHz ]  DHNAGHZ\n[ 88.4 MHz ]  YDSUAWJ\n[ 107.2 MHz ]  BNWCRWNU","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 107.2 MHz\nEncryption key: 9\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["SENTINEL"]}]'::jsonb, false, 3, 120, 'The answer has 8 letters and starts with S.', '107.2 MHz carries BNWCRWNU; shifting back by 9 gives SENTINEL.', null, 25, 'published'),
('battle-grid-400', 'grid', 'battle', 'Coordinate Drop', 'observation', 2, array['duel_sniper']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | T B P K C\n2 | R H N C C\n3 | R G J U S\n4 | S L D Z A\n5 | D W E S A","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 3)  (3, 1)  (5, 4)  (1, 2)  (4, 1)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SPARK"]}]'::jsonb, false, 3, 120, 'The code is a 5-letter word ending in K.', 'Reading (column,row) gives SPARK; reading it as (row,column) gives nonsense (ERSBS).', null, 25, 'published'),
('battle-grid-401', 'grid', 'battle', 'Coordinate Drop', 'observation', 2, array['duel_sniper']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | L V D G O\n2 | Y I A E U\n3 | R D G J A\n4 | X U B R O\n5 | J M K R A","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 5)  (3, 2)  (4, 5)  (3, 5)  (4, 2)  (1, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["MARKER"]}]'::jsonb, false, 3, 120, 'The code is a 6-letter word ending in R.', 'Reading (column,row) gives MARKER; reading it as (row,column) gives nonsense (UDOAUD).', null, 25, 'published'),
('battle-grid-402', 'grid', 'battle', 'Coordinate Drop', 'observation', 2, array['duel_sniper']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | C L I C T\n2 | K E K Z V\n3 | K R R P T\n4 | O S W E E\n5 | U W F H P","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 1)  (1, 4)  (3, 4)  (5, 4)  (2, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["TOWER"]}]'::jsonb, false, 3, 120, 'The code is a 5-letter word ending in R.', 'Reading (column,row) gives TOWER; reading it as (row,column) gives nonsense (UCPHK).', null, 25, 'published'),
('battle-grid-403', 'grid', 'battle', 'Coordinate Drop', 'observation', 2, array['duel_sniper']::text[], 'A supply crate is marked on a letter grid. Read the drop code from the marked squares.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | D A R T B\n2 | Y T E E M\n3 | D R F I O\n4 | L C S G A\n5 | E A F P I","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 4)  (3, 1)  (2, 5)  (4, 1)  (1, 5)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["CRATE"]}]'::jsonb, false, 3, 120, 'The code is a 5-letter word ending in E.', 'Reading (column,row) gives CRATE; reading it as (row,column) gives nonsense (EDMLB).', null, 25, 'published'),
('recovery-keypad-500', 'keypad', 'recovery', 'Worn Keypad', 'decoding', 1, array['any']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 8, 9, 5\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["986"]}]'::jsonb, false, 5, 120, 'The code has 3 digits.', 'Ordered digits 985, after the wiring fault 986.', null, 25, 'published'),
('recovery-keypad-501', 'keypad', 'recovery', 'Worn Keypad', 'decoding', 1, array['any']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 5, 3\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"ODD digits come first (smallest to largest), then EVEN digits (largest to smallest)."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: the 2nd and 3rd digits are swapped."}}'::jsonb, '[{"label":"Access code","accept":["395"]}]'::jsonb, false, 5, 120, 'The code has 3 digits.', 'Ordered digits 359, after the wiring fault 395.', null, 25, 'published'),
('recovery-keypad-502', 'keypad', 'recovery', 'Worn Keypad', 'decoding', 1, array['any']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 9, 5, 3\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The wiring is faulty: swap the 1st and last digits before entering."}}'::jsonb, '[{"label":"Access code","accept":["359"]}]'::jsonb, false, 5, 120, 'The code has 3 digits.', 'Ordered digits 953, after the wiring fault 359.', null, 25, 'published'),
('recovery-keypad-503', 'keypad', 'recovery', 'Worn Keypad', 'decoding', 1, array['any']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 3, 4, 8\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from LARGEST to SMALLEST digit."},"intel":{"title":"Maintenance report","body":"The panel adds 1 to the LAST digit (9 becomes 0)."}}'::jsonb, '[{"label":"Access code","accept":["844"]}]'::jsonb, false, 5, 120, 'The code has 3 digits.', 'Ordered digits 843, after the wiring fault 844.', null, 25, 'published'),
('recovery-keypad-504', 'keypad', 'recovery', 'Worn Keypad', 'decoding', 1, array['any']::text[], 'Crack the checkpoint keypad. Enter the digits exactly as the panel expects them.', '{"scout":{"title":"Keypad photo","body":"Worn (most-pressed) keys: 5, 6, 8\nEach worn key is used exactly once."},"decoder":{"title":"Guard''s habit","body":"The code was typed from SMALLEST to LARGEST digit."},"intel":{"title":"Maintenance report","body":"Enter the code in REVERSE order."}}'::jsonb, '[{"label":"Access code","accept":["865"]}]'::jsonb, false, 5, 120, 'The code has 3 digits.', 'Ordered digits 568, after the wiring fault 865.', null, 25, 'published'),
('recovery-caesar-500', 'caesar', 'recovery', 'Signal Intercept', 'decoding', 1, array['any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 104.9 MHz ]  LGRIUT\n[ 101.3 MHz ]  CTQJAP","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 6\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["FALCON"]}]'::jsonb, false, 5, 120, 'The answer has 6 letters and starts with F.', '104.9 MHz carries LGRIUT; shifting back by 6 gives FALCON.', null, 25, 'published'),
('recovery-caesar-501', 'caesar', 'recovery', 'Signal Intercept', 'decoding', 1, array['any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 98.7 MHz ]  ALTWLZA\n[ 101.3 MHz ]  XEHYPED","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 7\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["TEMPEST"]}]'::jsonb, false, 5, 120, 'The answer has 7 letters and starts with T.', '98.7 MHz carries ALTWLZA; shifting back by 7 gives TEMPEST.', null, 25, 'published'),
('recovery-caesar-502', 'caesar', 'recovery', 'Signal Intercept', 'decoding', 1, array['any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 98.7 MHz ]  HBYVYH\n[ 107.2 MHz ]  EHRYJQB","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 7\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["AURORA"]}]'::jsonb, false, 5, 120, 'The answer has 6 letters and starts with A.', '98.7 MHz carries HBYVYH; shifting back by 7 gives AURORA.', null, 25, 'published'),
('recovery-caesar-503', 'caesar', 'recovery', 'Signal Intercept', 'decoding', 1, array['any']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 107.2 MHz ]  KPEGMIV\n[ 94.3 MHz ]  CUBRAVK","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 107.2 MHz\nEncryption key: 4\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["GLACIER"]}]'::jsonb, false, 5, 120, 'The answer has 7 letters and starts with G.', '107.2 MHz carries KPEGMIV; shifting back by 4 gives GLACIER.', null, 25, 'published'),
('airdrop-grid-600', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | A K Q Q W\n2 | H M N Y G\n3 | W R M Y T\n4 | O V O J T\n5 | I E R I T","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 3)  (3, 4)  (1, 3)  (2, 5)  (2, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["TOWER"]}]'::jsonb, false, 3, 150, 'The code is a 5-letter word ending in R.', 'Reading (column,row) gives TOWER; reading it as (row,column) gives nonsense (RYQGN).', null, 25, 'published'),
('airdrop-grid-601', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | E W Y D E\n2 | J I C P A\n3 | O R R T L\n4 | P B V N E\n5 | E F Z E I","mono":true},"decoder":{"title":"Marked coordinates","body":"(4, 3)  (1, 3)  (2, 1)  (4, 5)  (2, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["TOWER"]}]'::jsonb, false, 3, 150, 'The code is a 5-letter word ending in R.', 'Reading (column,row) gives TOWER; reading it as (row,column) gives nonsense (VYJEC).', null, 25, 'published'),
('airdrop-grid-602', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | J I H T R\n2 | P V F M T\n3 | E G R O U\n4 | D G L Y Z\n5 | I J V W C","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 3)  (3, 4)  (2, 1)  (1, 4)  (1, 3)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["GLIDE"]}]'::jsonb, false, 3, 150, 'The code is a 5-letter word ending in E.', 'Reading (column,row) gives GLIDE; reading it as (row,column) gives nonsense (FOPTH).', null, 25, 'published'),
('airdrop-grid-603', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | D L S H M\n2 | M A G S L\n3 | X H N N A\n4 | P P L O I\n5 | Y N X V Y","mono":true},"decoder":{"title":"Marked coordinates","body":"(4, 2)  (5, 4)  (3, 2)  (4, 3)  (5, 3)  (2, 1)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SIGNAL"]}]'::jsonb, false, 3, 150, 'The code is a 6-letter word ending in L.', 'Reading (column,row) gives SIGNAL; reading it as (row,column) gives nonsense (PVHLXM).', null, 25, 'published'),
('airdrop-grid-604', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | L L H W J\n2 | T B Y P R\n3 | P Z R A X\n4 | K H U A H\n5 | A A S C X","mono":true},"decoder":{"title":"Marked coordinates","body":"(3, 5)  (3, 4)  (4, 2)  (1, 3)  (2, 1)  (3, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SUPPLY"]}]'::jsonb, false, 3, 150, 'The code is a 6-letter word ending in Y.', 'Reading (column,row) gives SUPPLY; reading it as (row,column) gives nonsense (XAHHTZ).', null, 25, 'published'),
('airdrop-grid-605', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | L D C R B\n2 | A D N D J\n3 | I A V M N\n4 | X S A O R\n5 | H L A O J","mono":true},"decoder":{"title":"Marked coordinates","body":"(4, 1)  (3, 5)  (2, 1)  (3, 4)  (5, 4)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["RADAR"]}]'::jsonb, false, 3, 150, 'The code is a 5-letter word ending in R.', 'Reading (column,row) gives RADAR; reading it as (row,column) gives nonsense (XNAMO).', null, 25, 'published'),
('airdrop-grid-606', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | U W B D T\n2 | K Y L N J\n3 | C H F E R\n4 | A G Y Y T\n5 | R S I O B","mono":true},"decoder":{"title":"Marked coordinates","body":"(5, 4)  (1, 4)  (5, 3)  (2, 4)  (4, 3)  (5, 1)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["TARGET"]}]'::jsonb, false, 3, 150, 'The code is a 6-letter word ending in T.', 'Reading (column,row) gives TARGET; reading it as (row,column) gives nonsense (ODINYR).', null, 25, 'published'),
('airdrop-grid-607', 'grid', 'airdrop', 'Airdrop Lock', 'observation', 2, array['any']::text[], 'The airdrop crate is locked with a grid code. First squad to crack it takes the loot.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5\n1 | N H W N I\n2 | D N J E X\n3 | G J C P Z\n4 | G H I M L\n5 | M M A S S","mono":true},"decoder":{"title":"Marked coordinates","body":"(1, 3)  (5, 4)  (5, 1)  (1, 2)  (4, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["GLIDE"]}]'::jsonb, false, 3, 150, 'The code is a 5-letter word ending in E.', 'Reading (column,row) gives GLIDE; reading it as (row,column) gives nonsense (WSMHH).', null, 25, 'published'),
('finale_entry-caesar-700', 'caesar', 'finale_entry', 'Signal Intercept', 'decoding', 2, array['finale']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 104.9 MHz ]  UMTJSNC\n[ 91.1 MHz ]  FORWOBH\n[ 107.2 MHz ]  XVEBILX","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 5\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["PHOENIX"]}]'::jsonb, false, 4, 180, 'The answer has 7 letters and starts with P.', '104.9 MHz carries UMTJSNC; shifting back by 5 gives PHOENIX.', null, 25, 'published'),
('finale_entry-caesar-701', 'caesar', 'finale_entry', 'Signal Intercept', 'decoding', 2, array['finale']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 101.3 MHz ]  TKHARG\n[ 98.7 MHz ]  VGORGUV\n[ 107.2 MHz ]  IKCCYJ","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 98.7 MHz\nEncryption key: 2\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["TEMPEST"]}]'::jsonb, false, 4, 180, 'The answer has 7 letters and starts with T.', '98.7 MHz carries VGORGUV; shifting back by 2 gives TEMPEST.', null, 25, 'published'),
('finale_entry-caesar-702', 'caesar', 'finale_entry', 'Signal Intercept', 'decoding', 2, array['finale']::text[], 'Squad 00 is broadcasting on several frequencies. Decode the genuine transmission and enter the plain word.', '{"scout":{"title":"Intercepted signals","body":"[ 104.9 MHz ]  CPEJQT\n[ 91.1 MHz ]  ASZPYTI\n[ 94.3 MHz ]  IKCCYJ","mono":true},"decoder":{"title":"Cipher manual","body":"Every letter was pushed FORWARD along the alphabet by the key number.\nTo decode, move each letter BACKWARD by the key.\nWrap around: A moved back 1 becomes Z."},"intel":{"title":"Verified intel","body":"Genuine frequency: 104.9 MHz\nEncryption key: 2\nAll other frequencies are decoys."}}'::jsonb, '[{"label":"Decoded word","accept":["ANCHOR"]}]'::jsonb, false, 4, 180, 'The answer has 6 letters and starts with A.', '104.9 MHz carries CPEJQT; shifting back by 2 gives ANCHOR.', null, 25, 'published'),
('finale_exchange-triad-800', 'relay', 'finale_exchange', 'Intelligence Exchange', 'tech', 1, array['finale']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"Which port does plain HTTP use by default?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many bytes are in one kibibyte (KiB)?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["80"]},{"label":"Part 2 (Decoder)","accept":["1024"]},{"label":"Part 3 (Intel)","accept":["404"]}]'::jsonb, true, 4, 240, 'The three numbers have 2, 4, 3 digits.', 'Which port does plain HTTP use by default? → 80 | How many bytes are in one kibibyte (KiB)? → 1024 | HTTP status code for "Not Found"? → 404', null, 25, 'published'),
('finale_exchange-triad-801', 'relay', 'finale_exchange', 'Intelligence Exchange', 'tech', 1, array['finale']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"HTTP status code for \"OK\"?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"How many layers does the OSI model have?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["200"]},{"label":"Part 2 (Decoder)","accept":["8"]},{"label":"Part 3 (Intel)","accept":["7"]}]'::jsonb, true, 4, 240, 'The three numbers have 3, 1, 1 digits.', 'HTTP status code for "OK"? → 200 | How many bits are in one byte? → 8 | How many layers does the OSI model have? → 7', null, 25, 'published'),
('finale_exchange-triad-802', 'relay', 'finale_exchange', 'Intelligence Exchange', 'tech', 1, array['finale']::text[], 'Another squad''s captain holds your access codeword. Get it through captain comms, then add the three-part tech code from your own squad. If no one helps, your Intel Officer receives a backup copy later (half reward).', '{"scout":{"title":"Code fragment 1 of 3","body":"How many bits are in one byte?\n\nTell your captain the number. It is part 1 of the code."},"decoder":{"title":"Code fragment 2 of 3","body":"HTTP status code for \"Not Found\"?\n\nTell your captain the number. It is part 2 of the code."},"intel":{"title":"Code fragment 3 of 3","body":"Binary 1111 equals which decimal number?\n\nTell your captain the number. It is part 3 of the code."}}'::jsonb, '[{"label":"Partner codeword","accept":["KEY"]},{"label":"Part 1 (Scout)","accept":["8"]},{"label":"Part 2 (Decoder)","accept":["404"]},{"label":"Part 3 (Intel)","accept":["15"]}]'::jsonb, true, 4, 240, 'The three numbers have 1, 3, 2 digits.', 'How many bits are in one byte? → 8 | HTTP status code for "Not Found"? → 404 | Binary 1111 equals which decimal number? → 15', null, 25, 'published'),
('finale_battle-orders-coffee-900', 'orders', 'finale_battle', 'Barista Rush', 'memory', 1, array['finale']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 3: 3× Croissant, 3× Cookie\nTable 6: 2× Croissant, 1× Cookie, 1× Latte\nTable 5: 1× Latte, 2× Croissant, 2× Cold Brew\nTable 9: 2× Latte, 3× Croissant","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 6.\nCorrection: the Cookie quantity on that slip was written as half. Double it."}}'::jsonb, '[{"label":"Total","accept":["42"]}]'::jsonb, false, 3, 150, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 6 with the rule applied totals 42.', null, 25, 'published'),
('finale_battle-orders-food-901', 'orders', 'finale_battle', 'Mess Hall Ledger', 'memory', 1, array['finale']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 2: 2× Dosa, 1× Idli\nTable 7: 1× Meals, 3× Curd Rice\nTable 3: 2× Dosa, 1× Juice\nTable 12: 2× Dosa, 3× Meals","mono":true},"decoder":{"title":"Canteen price board","body":"Biryani — 18\nDosa — 10\nIdli — 6\nMeals — 15\nPaneer Roll — 12\nJuice — 7\nCurd Rice — 9\nVada — 5","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 12.\nHouse rule today: add 5 coins for takeaway packing (once per order)."}}'::jsonb, '[{"label":"Total","accept":["70"]}]'::jsonb, false, 3, 150, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 12 with the rule applied totals 70.', null, 25, 'published'),
('finale_battle-orders-coffee-902', 'orders', 'finale_battle', 'Barista Rush', 'memory', 1, array['finale']::text[], 'Squad 00 swapped the bills. Calculate the correct total for the order your intel points to and enter the number.', '{"scout":{"title":"Order slips on the counter","body":"Table 6: 3× Latte, 1× Mocha, 3× Muffin\nTable 5: 3× Cappuccino, 1× Croissant\nTable 3: 3× Espresso, 2× Latte, 2× Cookie\nTable 11: 2× Muffin, 2× Croissant, 2× Latte","mono":true},"decoder":{"title":"Costa counter price card","body":"Latte — 12\nMocha — 14\nCappuccino — 11\nEspresso — 8\nMuffin — 9\nCookie — 5\nCroissant — 10\nCold Brew — 13","mono":true},"intel":{"title":"Billing intel","body":"Bill Table 11.\nHouse rule today: every Muffin is free."}}'::jsonb, '[{"label":"Total","accept":["44"]}]'::jsonb, false, 3, 150, 'Multiply each quantity by its price, add them, then apply the house rule.', 'Table 11 with the rule applied totals 44.', null, 25, 'published'),
('finale_battle-sequence-900', 'sequence', 'finale_battle', 'Pattern Lock', 'logic', 2, array['finale']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  2, 3, 5, 8, 13, ?\nBRAVO:  1, 4, 9, 16, 25, ?\nCHARLIE:  2, 4, 8, 16, 32, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number minus 1."},"intel":{"title":"Insider tip","body":"The genuine pattern is BRAVO. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["35"]}]'::jsonb, false, 3, 150, 'Look at the difference (or ratio) between neighbouring numbers.', 'BRAVO continues with 36; converted: 35.', null, 25, 'published'),
('finale_battle-sequence-901', 'sequence', 'finale_battle', 'Pattern Lock', 'logic', 2, array['finale']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  6, 13, 20, 27, 34, ?\nBRAVO:  4, 9, 16, 25, 36, ?\nCHARLIE:  1, 3, 4, 7, 11, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number plus 10."},"intel":{"title":"Insider tip","body":"The genuine pattern is BRAVO. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["59"]}]'::jsonb, false, 3, 150, 'Look at the difference (or ratio) between neighbouring numbers.', 'BRAVO continues with 49; converted: 59.', null, 25, 'published'),
('finale_battle-sequence-902', 'sequence', 'finale_battle', 'Pattern Lock', 'logic', 2, array['finale']::text[], 'Only one of the patterns on the lock is real. Find its missing number and convert it into the unlock code.', '{"scout":{"title":"Lock display","body":"ALPHA:  3, 7, 15, 31, 63, ?\nBRAVO:  3, 4, 7, 11, 18, ?\nCHARLIE:  3, 6, 12, 24, 48, ?","mono":true},"decoder":{"title":"Unlock conversion","body":"Submit the missing number minus 1."},"intel":{"title":"Insider tip","body":"The genuine pattern is ALPHA. The other two are decoys."}}'::jsonb, '[{"label":"Unlock code","accept":["126"]}]'::jsonb, false, 3, 150, 'Look at the difference (or ratio) between neighbouring numbers.', 'ALPHA continues with 127; converted: 126.', null, 25, 'published'),
('finale_battle-binary-900', 'binary', 'finale_battle', 'Badge Reader', 'tech', 2, array['finale']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag D:  ○ ○ ● ○ ○\nTag B:  ● ○ ● ○ ●\nTag G:  ○ ● ● ○ ○\nTag F:  ○ ● ● ● ●\nTag J:  ○ ○ ○ ● ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nJ → G → F → B → D"}}'::jsonb, '[{"label":"Badge word","accept":["CLOUD"]}]'::jsonb, false, 3, 150, 'It is a 5-letter tech word.', 'J=3=C, G=12=L, F=15=O, B=21=U, D=4=D → CLOUD.', null, 25, 'published'),
('finale_battle-binary-901', 'binary', 'finale_battle', 'Badge Reader', 'tech', 2, array['finale']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag G:  ● ○ ○ ● ●\nTag R:  ○ ○ ○ ● ●\nTag N:  ○ ● ○ ● ●\nTag K:  ○ ○ ○ ○ ●\nTag B:  ● ○ ● ○ ○","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nG → B → K → R → N"}}'::jsonb, '[{"label":"Badge word","accept":["STACK"]}]'::jsonb, false, 3, 150, 'It is a 5-letter tech word.', 'G=19=S, B=20=T, K=1=A, R=3=C, N=11=K → STACK.', null, 25, 'published'),
('finale_battle-binary-902', 'binary', 'finale_battle', 'Badge Reader', 'tech', 2, array['finale']::text[], 'A stolen access badge flashed its lights. Rebuild the word it encodes.', '{"scout":{"title":"Badge light capture","body":"Tag R:  ○ ○ ● ○ ●\nTag H:  ● ○ ○ ● ○\nTag J:  ○ ● ● ○ ●\nTag W:  ○ ○ ● ○ ●\nTag K:  ○ ○ ● ● ●","mono":true},"decoder":{"title":"Reader protocol","body":"● = 1 and ○ = 0. Each row is a 5-bit binary number.\nBit values from left to right: 16 8 4 2 1.\nThe number is the letter''s position in the alphabet (1 = A, 2 = B … 26 = Z)."},"intel":{"title":"Read order","body":"Read the tags in this order:\nJ → R → H → K → W"}}'::jsonb, '[{"label":"Badge word","accept":["MERGE"]}]'::jsonb, false, 3, 150, 'It is a 5-letter tech word.', 'J=13=M, R=5=E, H=18=R, K=7=G, W=5=E → MERGE.', null, 25, 'published'),
('final_code-grid-1000', 'grid', 'final_code', 'The Final Code', 'observation', 2, array['finale']::text[], 'Squad 00''s master vault. Read the final code from the grid. This is worth the most points of the night.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5 6\n1 | D J U R L F\n2 | E Z N E B S\n3 | V V E A S R\n4 | O O I F Z E\n5 | D S N X C R\n6 | I N W B I G","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 5)  (3, 4)  (6, 3)  (3, 1)  (6, 2)  (6, 4)  (6, 5)  (1, 6)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["SIRUSERI"]}]'::jsonb, false, 4, 240, 'The code is a 8-letter word ending in I.', 'Reading (column,row) gives SIRUSERI; reading it as (row,column) gives nonsense (BAWVNBIF).', null, 25, 'published'),
('final_code-grid-1001', 'grid', 'final_code', 'The Final Code', 'observation', 2, array['finale']::text[], 'Squad 00''s master vault. Read the final code from the grid. This is worth the most points of the night.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5 6\n1 | Z J Z T N O\n2 | H G W R Y M\n3 | N F B Y A F\n4 | O M B Q E X\n5 | K U L F J O\n6 | R P Q L H V","mono":true},"decoder":{"title":"Marked coordinates","body":"(3, 1)  (5, 4)  (4, 2)  (1, 4)  (1, 2)  (6, 5)  (2, 5)  (1, 6)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["ZEROHOUR"]}]'::jsonb, false, 4, 240, 'The code is a 8-letter word ending in R.', 'Reading (column,row) gives ZEROHOUR; reading it as (row,column) gives nonsense (NFMTJHYO).', null, 25, 'published'),
('final_code-grid-1002', 'grid', 'final_code', 'The Final Code', 'observation', 2, array['finale']::text[], 'Squad 00''s master vault. Read the final code from the grid. This is worth the most points of the night.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5 6\n1 | W P N F C J\n2 | V D N U A Z\n3 | G C E F A H\n4 | O P A Y R Z\n5 | U N M X Z X\n6 | J C I U H I","mono":true},"decoder":{"title":"Marked coordinates","body":"(2, 6)  (5, 6)  (3, 4)  (3, 5)  (2, 4)  (3, 6)  (1, 4)  (3, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["CHAMPION"]}]'::jsonb, false, 4, 240, 'The code is a 8-letter word ending in N.', 'Reading (column,row) gives CHAMPION; reading it as (row,column) gives nonsense (ZXFAUHFC).', null, 25, 'published'),
('final_code-grid-1003', 'grid', 'final_code', 'The Final Code', 'observation', 2, array['finale']::text[], 'Squad 00''s master vault. Read the final code from the grid. This is worth the most points of the night.', '{"scout":{"title":"Aerial grid photo","body":"    1 2 3 4 5 6\n1 | Y S O O M K\n2 | L I E E G Z\n3 | A O K S O H\n4 | L F P S E C\n5 | X W X C L E\n6 | A W H I R S","mono":true},"decoder":{"title":"Marked coordinates","body":"(3, 6)  (5, 4)  (1, 5)  (1, 6)  (2, 6)  (1, 3)  (5, 6)  (3, 2)"},"intel":{"title":"Grid convention","body":"Each pair is (COLUMN, ROW).\nColumns run left → right, rows run top → bottom, both starting at 1.\nRead the marked letters in the order listed."}}'::jsonb, '[{"label":"Drop code","accept":["HEXAWARE"]}]'::jsonb, false, 4, 240, 'The code is a 8-letter word ending in E.', 'Reading (column,row) gives HEXAWARE; reading it as (row,column) gives nonsense (HCMKZOEO).', null, 25, 'published')
on conflict (id) do update set family = excluded.family, kind = excluded.kind, title = excluded.title, category = excluded.category,
  difficulty = excluded.difficulty, tags = excluded.tags, objective = excluded.objective, clues = excluded.clues, parts = excluded.parts,
  relay = excluded.relay, attempts = excluded.attempts, time_limit = excluded.time_limit, hint = excluded.hint,
  explanation = excluded.explanation, points = excluded.points, coins = excluded.coins, status = excluded.status,
  version = case when mission_templates.clues is distinct from excluded.clues or mission_templates.parts is distinct from excluded.parts
                 then mission_templates.version + 1 else mission_templates.version end,
  updated_at = now();
