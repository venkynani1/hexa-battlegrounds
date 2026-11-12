-- ═══════════════════════════════════════════════════════════════════════════
-- v12 · The game clock runs in the database, once a second (Supabase Cron / pg_cron)
--
-- Before: every phone's request could run the clock for its map, inside the same transaction
-- that then built the phone's state — so a slow tick held its map's squads locked while other
-- requests waited (on the small free server this queued everything).
-- Now: a background job ticks every active map once a second, each map in its own short
-- transaction. While that job is alive, phones' requests never tick: they only read.
-- If pg_cron is not available (local tests), requests keep ticking as before.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron is not available here — phones keep running the clock (fine for tests)';
end $$;

create table if not exists tick_heartbeat (id int primary key default 1, at timestamptz not null default now());
alter table tick_heartbeat enable row level security;
revoke all on table tick_heartbeat from anon, authenticated;

-- one map's tick, never failing the job
create or replace function _tick_safe(p_arena uuid) returns void
language plpgsql as $$
begin
  perform set_config('hexa.cron', '1', true);
  perform _tick(p_arena);
exception when others then
  raise warning 'tick % failed: %', p_arena, sqlerrm;
end $$;

create or replace procedure hexa_tick_all()
language plpgsql as $$
declare r record; v_ids uuid[];
begin
  insert into tick_heartbeat(id, at) values (1, now()) on conflict (id) do update set at = excluded.at;
  commit;
  -- maps that are running, or that someone looked at in the last 10 minutes
  select array_agg(a.id) into v_ids from arenas a
  where a.phase <> 'ended' and (a.autopilot or a.phase <> 'lobby')
    and (a.last_tick_at is null or a.last_tick_at > now() - interval '10 minutes'
         or exists (select 1 from teams t join players p on p.team_id = t.id where t.arena_id = a.id and p.last_seen_at > now() - interval '10 minutes'));
  if v_ids is null then return; end if;
  for i in 1 .. array_length(v_ids, 1) loop
    perform _tick_safe(v_ids[i]);
    commit;
  end loop;
end $$;

-- requests stop ticking while the background clock is alive (heartbeat in the last 3 s)
create or replace function _cron_alive() returns boolean
language sql stable as $$ select exists (select 1 from tick_heartbeat where id = 1 and at > now() - interval '3 seconds') $$;

do $$
declare d text; n text;
begin
  d := pg_get_functiondef('_tick(uuid, boolean)'::regprocedure);
  if position('_cron_alive()' in d) > 0 then return; end if;
  n := regexp_replace(d, 'begin\s+if not p_force and exists \(select 1 from arenas where id = p_arena and last_tick_at',
    'begin
  if not p_force and current_setting(''hexa.cron'', true) is distinct from ''1'' and _cron_alive() then return false; end if;
  if not p_force and exists (select 1 from arenas where id = p_arena and last_tick_at');
  if n = d then raise exception 'v12: could not patch _tick'; end if;
  execute n;
end $$;

-- schedule the job (every second); harmless to re-run
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'hexa-tick';
    perform cron.schedule('hexa-tick', '1 seconds', 'call hexa_tick_all()');
    raise notice 'Game clock scheduled: hexa-tick every second';
  end if;
exception when others then
  raise notice 'could not schedule the game clock (%); phones keep running it', sqlerrm;
end $$;
