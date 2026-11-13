-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS — v12 PATCH (small, no download). Run on a database that is already at v11.
-- Supabase → SQL Editor → New query → paste ALL of this → Run.
-- Expected: "Success. No rows returned" and notices ending with "v12 patch done".
-- Safe to run more than once. Keeps every event, squad, PIN and score.
-- ════════════════════════════════════════════════════════════════════════════
set statement_timeout = 0;

-- 1 · shooting never deadlocks: lock both squads in a fixed order
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('squad_fire(text, uuid)'::regprocedure);
  if position('for no key update' in d) > 0 then raise notice 'squad_fire: already patched'; return; end if;
  n := regexp_replace(d, '(\s*select \* into d from teams where id = p_target;)',
    ' perform 1 from teams where id in (t.id, p_target) order by id for no key update; select * into t from teams where id = t.id;\1');
  if n = d then raise notice 'squad_fire: pattern not found, left as is'; return; end if;
  execute n;
  raise notice 'squad_fire: patched';
end $$;

-- 2 · the background game clock
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  raise notice 'pg_cron: enabled';
exception when others then
  raise notice 'pg_cron could not be enabled (%) — turn it on in Database → Extensions → pg_cron, then run this again', sqlerrm;
end $$;

create table if not exists tick_heartbeat (id int primary key default 1, at timestamptz not null default now());
alter table tick_heartbeat enable row level security;
revoke all on table tick_heartbeat from anon, authenticated;

create or replace function _tick_safe(p_arena uuid) returns void
language plpgsql as $$
begin
  perform set_config('hexa.cron', '1', true);
  perform _tick(p_arena);
exception when others then
  raise warning 'tick % failed: %', p_arena, sqlerrm;
end $$;

do $$ begin if exists (select 1 from pg_proc where proname = 'hexa_tick_all' and prokind = 'p') then drop procedure hexa_tick_all(); end if; end $$;
create or replace function hexa_tick_all() returns void
language plpgsql as $$
declare v_ids uuid[];
begin
  insert into tick_heartbeat(id, at) values (1, now()) on conflict (id) do update set at = excluded.at;
  select array_agg(a.id) into v_ids from arenas a
  where a.phase <> 'ended' and (a.autopilot or a.phase <> 'lobby')
    and (a.last_tick_at is null or a.last_tick_at > now() - interval '10 minutes'
         or exists (select 1 from teams t join players p on p.team_id = t.id where t.arena_id = a.id and p.last_seen_at > now() - interval '10 minutes'));
  if v_ids is null then return; end if;
  for i in 1 .. array_length(v_ids, 1) loop
    perform _tick_safe(v_ids[i]);
  end loop;
end $$;

create or replace function _cron_alive() returns boolean
language sql stable as $$ select exists (select 1 from tick_heartbeat where id = 1 and at > now() - interval '3 seconds') $$;

do $$
begin
  execute 'revoke all on function _tick_safe(uuid) from public, anon, authenticated';
  execute 'revoke all on function _cron_alive() from public, anon, authenticated';
  execute 'revoke all on function hexa_tick_all() from public, anon, authenticated';
exception when others then null;
end $$;

-- 3 · phones stop running the clock while the background clock is alive
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('_tick(uuid, boolean)'::regprocedure);
  if position('_cron_alive()' in d) > 0 then raise notice '_tick: already patched'; return; end if;
  n := regexp_replace(d, 'begin\s+if not p_force and exists \(select 1 from arenas where id = p_arena and last_tick_at',
    'begin
  if not p_force and current_setting(''hexa.cron'', true) is distinct from ''1'' and _cron_alive() then return false; end if;
  if not p_force and exists (select 1 from arenas where id = p_arena and last_tick_at');
  if n = d then raise notice '_tick: pattern not found, left as is (game still works, phones keep the clock)'; return; end if;
  execute n;
  raise notice '_tick: patched';
end $$;

-- 4 · schedule the clock every second
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'clock NOT scheduled: pg_cron is off'; return;
  end if;
  execute $c$select cron.unschedule(jobid) from cron.job where jobname = 'hexa-tick'$c$;
  execute $c$select cron.schedule('hexa-tick', '1 seconds', 'select hexa_tick_all()')$c$;
  raise notice 'clock scheduled: hexa-tick every second';
exception when others then
  raise notice 'clock NOT scheduled (%)', sqlerrm;
end $$;

do $$ begin raise notice 'v12 patch done'; end $$;
