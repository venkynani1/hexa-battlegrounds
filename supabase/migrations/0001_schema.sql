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
