-- HEXA BATTLEGROUNDS database setup — PART 1 OF 4.
-- Supabase → SQL Editor → New query → paste → Run. Run the parts in order. Safe to re-run.

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

