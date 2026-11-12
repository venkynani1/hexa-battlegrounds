-- ═══════════════════════════════════════════════════════════════════════════
-- v11 · Capacity for a full event on the free database (2 in-person + 3–4 online maps)
--
-- A live test on the free Supabase server showed requests queueing behind each other:
--  • the clock now runs at most every 0.8 s per map and only one request runs it (see 0910);
--  • map-wide "refresh" pings are coalesced: 'tick' at most every 5 s, other kinds every 2 s
--    ('phase' stays immediate), and they no longer write to the map's row, so a ping never
--    waits for the clock. Phones still poll, so nothing is missed.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists arena_pings (
  arena_id uuid not null,
  kind text not null,
  at timestamptz not null default now(),
  primary key (arena_id, kind)
);
alter table arena_pings enable row level security;
revoke all on table arena_pings from anon, authenticated;

create or replace function _ping_arena(p_arena uuid, p_kind text default 'state') returns void
language plpgsql as $$
declare v_gap interval; v_key text;
begin
  if p_kind not in ('phase', 'finale', 'results', 'paused') then
    v_gap := case when p_kind = 'tick' then interval '5 seconds' else interval '2 seconds' end;
    v_key := case when p_kind = 'tick' then 'tick' else 'any' end;
    if not pg_try_advisory_xact_lock(hashtext('ping-' || v_key || p_arena::text)) then return; end if;
    if exists (select 1 from arena_pings where arena_id = p_arena and kind = v_key and at > now() - v_gap) then return; end if;
    insert into arena_pings(arena_id, kind, at) values (p_arena, v_key, now())
    on conflict (arena_id, kind) do update set at = excluded.at;
  end if;
  perform _ping('arena-' || p_arena::text, p_kind);
end $$;
