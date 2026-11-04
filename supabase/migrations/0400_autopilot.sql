-- ════════════════════════════════════════════════════════════════════════════
-- 0400 — Autopilot: one "Start match" runs the whole game by itself
--   boarding → bus ride → role claim → phases 0–4 (zone, airdrops, red zones and
--   Squad 00 moments on a timetable) → finale rounds A–E → results → winner →
--   grand champion. The host can pause, override any step, or take manual control.
-- Runs inside _tick (which every phone, projector and host screen already calls),
-- so no always-on server is needed. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table arenas add column if not exists autopilot boolean not null default false;
alter table arenas add column if not exists auto_step text;
alter table arenas add column if not exists auto_next_at timestamptz;
alter table arenas add column if not exists auto_story int not null default -1;
alter table arenas add column if not exists auto_length text;

-- Squad 00 delivers the finale; the 'reveal' story row tells the autopilot it already happened.

-- Match length presets (written into the event settings when a match starts).
create or replace function _auto_preset(p_length text) returns jsonb language sql immutable as $$
  select case coalesce(p_length, 'standard')
    when 'quick' then jsonb_build_object('auto_pacing', 1, 'phase_schedule', '1,3,5,7', 'finale_minute', 9, 'finale_battles', 1,
      'zone_warning', 25, 'airdrop_interval', 1, 'red_interval', 2, 'mission_time_pct', 70, 'shuttle_seconds', 12, 'roles_seconds', 12,
      'sync_seconds', 90, 'recovery_seconds', 45, 'attack_cooldown', 45, 'protect_seconds', 45, 'boarding_seconds', 12, 'airdrop_window', 90)
    when 'full' then jsonb_build_object('auto_pacing', 1, 'phase_schedule', '3,15,30,45', 'finale_minute', 55, 'finale_battles', 3,
      'zone_warning', 60, 'airdrop_interval', 5, 'red_interval', 6, 'mission_time_pct', 100, 'shuttle_seconds', 20, 'roles_seconds', 15,
      'sync_seconds', 0, 'recovery_seconds', 120, 'attack_cooldown', 90, 'protect_seconds', 120, 'boarding_seconds', 25, 'airdrop_window', 180)
    else jsonb_build_object('auto_pacing', 1, 'phase_schedule', '2,6,11,16', 'finale_minute', 21, 'finale_battles', 2,
      'zone_warning', 40, 'airdrop_interval', 3, 'red_interval', 4, 'mission_time_pct', 85, 'shuttle_seconds', 15, 'roles_seconds', 15,
      'sync_seconds', 120, 'recovery_seconds', 75, 'attack_cooldown', 60, 'protect_seconds', 75, 'boarding_seconds', 18, 'airdrop_window', 120)
  end
$$;

-- Squad 00's lines, one per phase (original story text).
create or replace function _auto_story(p_phase int) returns text[] language sql immutable as $$
  select case p_phase
    when 0 then array['Squad 00: we are already inside', 'Welcome to Operation Siruseri. We have been on this campus longer than you. Find the codes before we find you.']
    when 1 then array['Squad 00: supplies are out there', 'We hid supplies across the campus. Search every building. Crates will fall from the sky — be first.']
    when 2 then array['Squad 00: duels are live', 'From now on, any squad close to you can challenge you. Trust carefully. Even allies can turn.']
    when 3 then array['Squad 00: the circle is closing', 'The safe zone is shrinking toward the centre. Stay inside it, or keep running.']
    else array['Squad 00: everyone ends in Room 14', 'Training Room 14 is where this ends. Make your last points count — the finale is coming.']
  end
$$;

-- Minute (after play starts) at which the autopilot opens the finale: setting, or 5 min after phase 4.
create or replace function _auto_finale_minute(p_ev uuid) returns int
language plpgsql stable as $$
declare v int; v_s text[];
begin
  v := coalesce(_cfg(p_ev, 'finale_minute'), 0);
  if v > 0 then return v; end if;
  v_s := string_to_array(_cfg_text(p_ev, 'phase_schedule'), ',');
  begin v := nullif(trim(v_s[array_length(v_s, 1)]), '')::int; exception when others then v := null; end;
  return coalesce(v, 50) + 5;
end $$;

-- Finale script position, derived from the game state so a manual override never confuses it.
-- Steps (1-based): 1 A entry, 2 B exchange, 3..2+N C battles, 3+N D reveal, 4+N E final code,
--                  5+N lock results, 6+N reveal winner, 7+N grand champion, 8+N done.
create or replace function _auto_fin_pos(p_arena uuid) returns int
language plpgsql stable as $$
declare a arenas; v_n int; v_k int; v_rev boolean; v_pos int;
begin
  select * into a from arenas where id = p_arena;
  v_n := greatest(1, coalesce(_cfg(a.event_id, 'finale_battles'), 2));
  if a.results_locked or a.phase in ('results', 'ended') then
    if not a.winner_revealed then return 5 + v_n; end if;
    if (select count(*) from arenas x where x.event_id = a.event_id and exists (select 1 from teams where arena_id = x.id and ready)) > 1 and not (select grand_revealed from events where id = a.event_id) then
      return 6 + v_n;
    end if;
    return 7 + v_n;
  end if;
  select count(*) into v_k from sync_rounds where arena_id = a.id;
  v_rev := exists (select 1 from story_events where arena_id = a.id and kind = 'reveal');
  v_pos := least(v_k, 2 + v_n);
  if v_k >= 3 + v_n then return 4 + v_n; end if;
  if v_rev and v_pos >= 2 + v_n then return 3 + v_n; end if;
  return v_pos;
end $$;

create or replace function _auto_step_name(p_pos int, p_n int) returns text language sql immutable as $$
  select case when p_pos <= 0 then 'Finale entry round' when p_pos = 1 then 'Exchange round'
    when p_pos <= 1 + p_n then 'Finale battle ' || p_pos when p_pos = 2 + p_n then 'Squad 00 reveal'
    when p_pos = 3 + p_n then 'Final code' when p_pos = 4 + p_n then 'Results locked'
    when p_pos = 5 + p_n then 'Winner reveal' when p_pos = 6 + p_n then 'Grand champion' else 'Match complete' end
$$;

-- What the autopilot does next, for the host console and the projector: {on, step, label, at}.
create or replace function _auto_status(p_arena uuid) returns jsonb
language plpgsql stable as $$
declare a arenas; v_label text; v_at timestamptz; v_n int; v_pos int; v_fm int; r sync_rounds;
begin
  select * into a from arenas where id = p_arena;
  if a.id is null or not a.autopilot then return jsonb_build_object('on', false); end if;
  v_n := greatest(1, coalesce(_cfg(a.event_id, 'finale_battles'), 2));
  v_fm := _auto_finale_minute(a.event_id);
  case
    when a.phase = 'lobby' then v_label := 'Waiting for a ready squad';
    when a.phase = 'boarding' then v_label := 'Bus leaves'; v_at := a.auto_next_at;
    when a.phase = 'shuttle' then v_label := 'Bus arrives'; v_at := a.shuttle_arrive_at;
    when a.phase = 'roles' then v_label := 'Roles lock'; v_at := a.roles_deadline;
    when a.phase = 'play' then
      if a.match_phase < 4 and a.phase_next_at is not null then v_label := 'Phase ' || (a.match_phase + 1); v_at := a.phase_next_at;
      else v_label := 'Finale'; v_at := a.play_started_at + make_interval(mins => v_fm); end if;
    when a.phase in ('finale', 'results') then
      if a.sync_round_id is not null then
        select * into r from sync_rounds where id = a.sync_round_id;
        v_label := 'Round ends'; v_at := r.deadline;
      else
        v_pos := _auto_fin_pos(a.id);
        v_label := _auto_step_name(v_pos, v_n);
        if v_pos < 7 + v_n then v_at := a.auto_next_at; end if;
      end if;
    else v_label := 'Match complete';
  end case;
  return jsonb_build_object('on', true, 'step', a.auto_step, 'label', v_label, 'at', v_at, 'length', a.auto_length, 'paused', a.paused);
end $$;

-- Bring the autopilot in line with whatever state the map is in (start, re-enable, or after a manual override).
create or replace function _auto_resync(p_arena uuid) returns void
language plpgsql as $$
declare a arenas;
begin
  select * into a from arenas where id = p_arena;
  update arenas set auto_step = case
      when a.phase in ('lobby', 'boarding') then 'boarding'
      when a.phase in ('shuttle', 'roles') then 'ride'
      when a.phase = 'play' then 'play'
      when a.phase in ('finale', 'results') then 'fin:' || _auto_fin_pos(a.id)
      else 'done' end,
    auto_next_at = case
      when a.phase = 'boarding' then coalesce(a.auto_next_at, now() + _secs(coalesce(_cfg(a.event_id, 'boarding_seconds'), 18)))
      when a.phase in ('finale', 'results') then now() + interval '10 seconds'
      else null end
  where id = p_arena;
end $$;

-- One autopilot step, called from _tick. Returns true if something changed.
create or replace function _autopilot(p_arena uuid) returns boolean
language plpgsql as $$
declare a arenas; v_ev uuid; v_fam text; v_n int; v_pos int; v_fm int; st text[]; v_open int; v_res boolean := false;
  v_stat jsonb;
begin
  -- close_sync / lock_results force a nested tick: never re-enter
  if coalesce(current_setting('hb.in_auto', true), '') = '1' then return false; end if;
  select * into a from arenas where id = p_arena;
  if a.id is null or not a.autopilot or a.paused or a.phase = 'ended' then return false; end if;
  v_ev := a.event_id;
  perform set_config('hb.in_auto', '1', true);
  begin
    v_fam := case when a.phase in ('lobby', 'boarding') then 'boarding' when a.phase in ('shuttle', 'roles') then 'ride'
                  when a.phase = 'play' then 'play' else 'fin' end;
    if split_part(coalesce(a.auto_step, ''), ':', 1) <> v_fam then
      perform _auto_resync(a.id);
      select * into a from arenas where id = p_arena;
      v_res := true;
    end if;

    if a.phase = 'lobby' then
      if exists (select 1 from teams where arena_id = a.id and ready) then
        perform _host_exec(v_ev, a.id, 'open_boarding', '{}'::jsonb, 'autopilot');
        update arenas set auto_step = 'boarding', auto_next_at = now() + _secs(coalesce(_cfg(v_ev, 'boarding_seconds'), 18)) where id = a.id;
        insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'open_boarding');
        v_res := true;
      end if;

    elsif a.phase = 'boarding' then
      if a.auto_next_at is not null and now() >= a.auto_next_at then
        if exists (select 1 from teams where arena_id = a.id and ready) then
          perform _host_exec(v_ev, a.id, 'drive', '{}'::jsonb, 'autopilot');
          update arenas set auto_step = 'ride', auto_next_at = null where id = a.id;
          insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'drive');
        else
          update arenas set auto_next_at = now() + interval '10 seconds' where id = a.id;
        end if;
        v_res := true;
      end if;

    elsif a.phase = 'play' then
      -- Squad 00 speaks once at the start of every phase; bargains in phases 2 and 3
      if a.match_phase > a.auto_story then
        st := _auto_story(a.match_phase);
        update arenas set auto_story = a.match_phase where id = a.id;
        perform _host_exec(v_ev, a.id, 'story', jsonb_build_object('title', st[1], 'body', st[2]), 'autopilot');
        if a.match_phase in (2, 3) then
          perform _host_exec(v_ev, a.id, 'bargain', jsonb_build_object('title', 'Squad 00 offers a deal',
            'body', case a.match_phase when 2 then 'Take our coins now. All it costs is a little of your squad''s trust.'
                    else 'A bigger offer. Accept, and the threat on this map rises.' end,
            'coins', case a.match_phase when 2 then 60 else 90 end, 'threat', 1,
            'trust', case a.match_phase when 2 then -5 else -10 end, 'minutes', 2), 'autopilot');
        end if;
        v_res := true;
      end if;
      -- the finale starts on the timetable
      v_fm := _auto_finale_minute(v_ev);
      if a.play_started_at is not null and now() >= a.play_started_at + make_interval(mins => v_fm) then
        perform _host_exec(v_ev, a.id, 'begin_finale', '{}'::jsonb, 'autopilot');
        update arenas set auto_step = 'fin:0', auto_next_at = now() + interval '12 seconds', match_phase = 5,
          phase_started_at = now(), phase_next_at = null,
          overlay = overlay || jsonb_build_object('match', jsonb_build_object('phase', 5, 'started_at', now(), 'next_at', null, 'zone_target', 5))
        where id = a.id;
        perform _feed(a.id, 'phase.started', jsonb_build_object('phase', 5));
        insert into audit_log(event_id, arena_id, actor, action) values (v_ev, a.id, 'autopilot', 'begin_finale');
        v_res := true;
      end if;

    elsif a.phase in ('finale', 'results') then
      v_n := greatest(1, coalesce(_cfg(v_ev, 'finale_battles'), 2));
      if a.sync_round_id is not null then
        -- a running round ends early once no squad is still working on it
        select count(*) into v_open from mission_instances where sync_round_id = a.sync_round_id and status = 'active';
        if v_open = 0 then
          perform _host_exec(v_ev, a.id, 'close_sync', '{}'::jsonb, 'autopilot');
          v_res := true;
        end if;
      elsif a.auto_next_at is null then
        -- a round just ended: short break before the next step
        update arenas set auto_next_at = now() + interval '10 seconds' where id = a.id;
        v_res := true;
      elsif now() >= a.auto_next_at then
        v_pos := _auto_fin_pos(a.id);
        if v_pos < 2 + v_n then
          -- rounds: 0 → A entry, 1 → B exchange, 2.. → C battles
          perform _host_exec(v_ev, a.id, 'finale_stage', jsonb_build_object('stage', case when v_pos = 0 then 'A' when v_pos = 1 then 'B' else 'C' end), 'autopilot');
          perform _host_exec(v_ev, a.id, 'launch_sync', jsonb_build_object('kind',
            case when v_pos = 0 then 'finale_entry' when v_pos = 1 then 'finale_exchange' else 'finale_battle' end), 'autopilot');
          update arenas set auto_next_at = null where id = a.id;
        elsif v_pos = 2 + v_n then
          perform _host_exec(v_ev, a.id, 'reveal_squad00', '{}'::jsonb, 'autopilot');
          update arenas set auto_next_at = now() + interval '30 seconds' where id = a.id;
        elsif v_pos = 3 + v_n then
          perform _host_exec(v_ev, a.id, 'finale_stage', jsonb_build_object('stage', 'E'), 'autopilot');
          perform _host_exec(v_ev, a.id, 'launch_sync', jsonb_build_object('kind', 'final_code'), 'autopilot');
          update arenas set auto_next_at = null where id = a.id;
        elsif v_pos = 4 + v_n then
          perform _host_exec(v_ev, a.id, 'lock_results', '{}'::jsonb, 'autopilot');
          update arenas set auto_next_at = now() + interval '15 seconds' where id = a.id;
        elsif v_pos = 5 + v_n then
          perform _host_exec(v_ev, a.id, 'reveal_winner', '{}'::jsonb, 'autopilot');
          update arenas set auto_next_at = now() + interval '20 seconds' where id = a.id;
        elsif v_pos = 6 + v_n then
          -- the grand champion waits until every map of the event has crowned its winner
          -- (maps nobody played on are ignored)
          if not exists (select 1 from arenas x where x.event_id = v_ev and not x.winner_revealed
                         and exists (select 1 from teams where arena_id = x.id and ready)) then
            update events set grand_revealed = true where id = v_ev;
            perform _ping_arena(x.id, 'grand') from arenas x where x.event_id = v_ev;
          end if;
        end if;
        if v_pos < 6 + v_n or (select grand_revealed from events where id = v_ev) then
          insert into audit_log(event_id, arena_id, actor, action, args)
            values (v_ev, a.id, 'autopilot', 'finale_step', jsonb_build_object('step', _auto_step_name(v_pos, v_n)));
          v_res := true;
        end if;
      end if;
      update arenas set auto_step = 'fin:' || _auto_fin_pos(a.id) where id = a.id;
    end if;

    -- publish "what happens next" for every screen
    v_stat := _auto_status(a.id) - 'step';
    update arenas set overlay = overlay || jsonb_build_object('auto', v_stat)
      where id = a.id and overlay -> 'auto' is distinct from v_stat;
    if found then v_res := true; end if;
  exception when others then
    perform set_config('hb.in_auto', '', true);
    if not exists (select 1 from audit_log where arena_id = a.id and actor = 'autopilot' and not ok and at > now() - interval '30 seconds') then
      insert into audit_log(event_id, arena_id, actor, action, ok, error) values (v_ev, a.id, 'autopilot', 'step', false, sqlerrm);
    end if;
    return false;
  end;
  perform set_config('hb.in_auto', '', true);
  if v_res then perform _ping_arena(a.id, 'auto'); end if;
  return v_res;
end $$;


create or replace function _defaults() returns jsonb language sql immutable as $$
select jsonb_build_object(
  'pts_standard', 100, 'pts_hard', 150, 'pts_battle', 125, 'pts_airdrop', 75, 'pts_relay_bonus', 25,
  'pts_relocation', 40, 'pen_recovery', 40, 'finale_max', 300, 'finale_entry_max', 200, 'finale_exchange_max', 200,
  'hp_max', 100, 'hp_respawn', 50, 'dmg_fail', 10, 'dmg_zone', 15, 'shield_max', 60,
  'shuttle_seconds', 10, 'roles_seconds', 15, 'bus_size', 3, 'arena_size', 15,
  'attack_cooldown', 90, 'protect_seconds', 120, 'recovery_seconds', 120, 'zone_warning', 60,
  'airdrop_window', 180, 'airdrop_interval', 0, 'intel_fallback', 90, 'relay_chance', 20, 'hint_cost', 0,
  'alliance_minutes', 10, 'alliance_cost', 10, 'chat_limit', 6, 'drop_seconds', 8, 'visit_missions', 2,
  'zone_auto', 0, 'zone_schedule', '20,40,55,70,85', 'sync_seconds', 0,
  'auto_pacing', 0, 'phase_schedule', '2,12,30,50', 'duel_phase', 2, 'mission_time_pct', 100, 'pin_length', 6,
  -- 0200: open world (distances in thousandths of the campus width)
  'move_speed', 25,          -- run speed: 0.025 campus/s → ~40 s to cross the campus
  'loc_radius', 35,          -- a location's area
  'engage_range', 60,        -- squads this close can duel
  'zone_tick_seconds', 6,    -- outside the safe zone: damage every N seconds
  'zone_tick_damage', 4,     -- … of this much HP (shield absorbs first)
  'red_interval', 0,         -- automatic red zone every N minutes from phase 2 (0 = host only)
  'red_warning', 20,         -- seconds between the red zone warning and the strike
  'red_damage', 30,          -- HP lost by squads inside the red zone when it lands
  'red_radius', 80           -- red zone size
) || jsonb_build_object(   -- (Postgres allows at most 100 arguments per call)
  'reveal_pct', 50,          -- revealing every answer box costs this % of the mission's points
  'boarding_seconds', 18,    -- autopilot: boarding countdown before the bus leaves
  'finale_minute', 0,        -- autopilot: minute the finale starts (0 = 5 min after phase 4)
  'finale_battles', 2        -- autopilot: number of finale battle rounds
) $$;

create or replace function _tick(p_arena uuid, p_force boolean default false) returns boolean
language plpgsql as $$
declare a arenas; r record; tm teams; c float8[]; xy float8[]; v_tick int; v_bucket bigint; v_changed boolean := false; v_sched text[]; v_next int; v_at timestamptz; v_target int;
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
  -- roles → play (Phase 0: Deployment)
  if a.phase = 'roles' and now() >= a.roles_deadline then
    perform _finalize_roles(p_arena);
    update arenas set phase = 'play', play_started_at = now() where id = p_arena;
    perform _feed(p_arena, 'role.assignment.completed', '{}'::jsonb);
    perform _feed(p_arena, 'map.revealed', '{}'::jsonb);
    perform _set_match_phase(p_arena, 0);
    v_changed := true;
  end if;

  select * into a from arenas where id = p_arena;
  if a.phase not in ('play', 'finale') then
    if a.autopilot and _autopilot(p_arena) then v_changed := true; end if;
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

  -- match phase pacing (automatic schedule)
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and a.match_phase < 4 and a.phase_next_at is not null and now() >= a.phase_next_at then
    perform _set_match_phase(p_arena, a.match_phase + 1);
    v_changed := true;
  end if;

  -- zone: phase-driven contraction towards the phase's target stage
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and not a.zone_hold and a.zone_next_at is null and a.zone_stage < 5 then
    v_target := _phase_zone_target(a.match_phase);
    if a.zone_stage < v_target then
      update arenas set zone_next_at = now() + _secs(_cfg(a.event_id, 'zone_warning')) where id = p_arena;
      perform _feed(p_arena, 'zone.warning', jsonb_build_object('stage', a.zone_stage + 1));
      v_changed := true;
    end if;
  end if;

  -- zone: legacy minute schedule (zone_auto), kept for existing events
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' and _cfg(a.event_id, 'zone_auto') = 1 and a.zone_next_at is null and a.zone_stage < 5 and not a.zone_hold then
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

  -- safe zone: squads outside lose HP every few seconds (shield absorbs first)
  select * into a from arenas where id = p_arena;
  if a.phase = 'play' then
    c := _zone_circle(a.event_id, a.zone_stage);
    v_tick := greatest(2, _cfg(a.event_id, 'zone_tick_seconds'));
    v_bucket := floor(extract(epoch from now()) / v_tick)::bigint;
    for tm in select * from teams where arena_id = p_arena and ready and state <> 'recovery'
             and (zone_hit_at is null or zone_hit_at <= now() - _secs(v_tick)) loop
      xy := _team_xy(tm);
      if not _in_circle(c, xy[1], xy[2]) then
        update teams set zone_hit_at = now() where id = tm.id;
        perform _damage(tm.id, _cfg(a.event_id, 'zone_tick_damage'), 'zone_damage', 'zt-' || v_bucket, 'Outside the safe zone');
        perform _ping_team(tm.id, 'zone');
        v_changed := true;
      end if;
    end loop;
  end if;

  -- red zones: strike when the warning runs out; optional automatic red zones from phase 2
  select * into a from arenas where id = p_arena;
  if a.red_at is not null and now() >= a.red_at then
    perform _red_strike(p_arena); v_changed := true;
  elsif a.phase = 'play' and a.red_at is null and a.match_phase >= 2 and _cfg(a.event_id, 'red_interval') > 0
     and coalesce(a.last_red_at, a.phase_started_at, a.play_started_at) < now() - make_interval(mins => _cfg(a.event_id, 'red_interval')) then
    perform _red_spawn(p_arena); v_changed := true;
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

  -- autopilot: Squad 00 moments, finale rounds, results (no-op unless the host started an automatic match)
  select * into a from arenas where id = p_arena;
  if a.autopilot and _autopilot(p_arena) then v_changed := true; end if;

  if v_changed then perform _zone_publish(p_arena); perform _ping_arena(p_arena, 'tick'); end if;
  return v_changed;
end $$;

create or replace function _shift_arena(p_arena uuid, p_delta interval) returns void
language plpgsql as $$
begin
  update arenas set
    shuttle_departed_at = shuttle_departed_at + p_delta, shuttle_arrive_at = shuttle_arrive_at + p_delta,
    roles_deadline = roles_deadline + p_delta, play_started_at = play_started_at + p_delta,
    zone_next_at = zone_next_at + p_delta, last_airdrop_at = last_airdrop_at + p_delta,
    phase_started_at = phase_started_at + p_delta, phase_next_at = phase_next_at + p_delta,
    red_at = red_at + p_delta, last_red_at = last_red_at + p_delta, auto_next_at = auto_next_at + p_delta,
    overlay = case when overlay ? 'match' then jsonb_set(overlay, '{match,next_at}',
      coalesce(to_jsonb((overlay #>> '{match,next_at}')::timestamptz + p_delta), 'null'::jsonb)) else overlay end
  where id = p_arena;
  update mission_instances set deadline = deadline + p_delta, fallback_at = fallback_at + p_delta,
    started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update battles set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update sync_rounds set deadline = deadline + p_delta, started_at = started_at + p_delta where arena_id = p_arena and status = 'active';
  update airdrops set expires_at = expires_at + p_delta, spawned_at = spawned_at + p_delta where arena_id = p_arena and status = 'open';
  update alliances set expires_at = expires_at + p_delta, created_at = created_at + p_delta
    where arena_id = p_arena and status in ('proposed', 'active');
  update story_events set expires_at = expires_at + p_delta where arena_id = p_arena and expires_at > now();
  update teams set zone_hit_at = zone_hit_at + p_delta, travel_started_at = travel_started_at + p_delta, travel_arrive_at = travel_arrive_at + p_delta,
    recovery_deadline = recovery_deadline + p_delta, attack_cooldown_until = attack_cooldown_until + p_delta,
    protected_until = protected_until + p_delta, jammed_until = jammed_until + p_delta, scan_until = scan_until + p_delta
  where arena_id = p_arena;
  perform _zone_publish(p_arena);
end $$;

create or replace function host_command(p_token text, p_arena uuid, p_cmd text, p_args jsonb default '{}'::jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_ids uuid[]; v_id uuid; v_out jsonb := '{}'::jsonb; v_err text; v_res jsonb; v_delta interval; v_logargs jsonb;
  v_all_ok text[] := array['open_boarding','assign_buses','drive','finalize_roles','pause','resume','broadcast','clear_overlay',
    'blackout','countdown','story','bargain','zone_warn','zone_now','zone_cancel','zone_set','spawn_airdrop','begin_finale',
    'finale_stage','launch_sync','close_sync','lock_results','reveal_winner','end_game','reveal_squad00',
    'next_phase','set_phase','hide_rankings','red_zone','red_cancel','start_match','autopilot_on','autopilot_off'];
  v_new text[] := array['set_phase','next_phase','hide_rankings','reset_pin','red_zone','red_cancel'];
begin
  v_ev := _auth_host(p_token);
  p_args := coalesce(p_args, '{}'::jsonb);
  v_logargs := p_args - 'pin';
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
      v_delta := null;
      if p_cmd = 'resume' then
        select now() - paused_at into v_delta from arenas where id = v_id and paused;
      end if;
      -- any number of complete squads (1–15) can play a map; an empty map cannot start
      if p_cmd in ('open_boarding', 'assign_buses', 'drive', 'start_match') and v_id is not null
         and not exists (select 1 from teams where arena_id = v_id and ready) then
        raise exception 'NO_READY_SQUADS';
      end if;
      if p_cmd = any(v_new) then
        v_res := _host_exec_p0(v_ev, v_id, p_cmd, p_args, p_reason);
      elsif p_cmd in ('start_match', 'autopilot_on') then
        -- automatic match: write the length preset, then let the autopilot run every step
        if p_cmd = 'start_match' then
          if coalesce(p_args ->> 'length', 'standard') not in ('quick', 'standard', 'full') then raise exception 'BAD_LENGTH'; end if;
          update events set settings = settings || _auto_preset(p_args ->> 'length') where id = v_ev;
        else
          update events set settings = settings || jsonb_build_object('auto_pacing', 1) where id = v_ev;
        end if;
        update arenas set autopilot = true, auto_length = coalesce(p_args ->> 'length', auto_length, 'standard'),
          auto_story = case when phase in ('lobby', 'boarding', 'shuttle', 'roles') then -1 when phase = 'play' then greatest(auto_story, match_phase) else auto_story end
        where id = v_id;
        perform _auto_resync(v_id);
        if (select phase from arenas where id = v_id) = 'play' then
          perform _set_match_phase(v_id, (select match_phase from arenas where id = v_id));
        end if;
        perform _tick(v_id, true);
        v_res := _auto_status(v_id);
      elsif p_cmd = 'autopilot_off' then
        update arenas set autopilot = false, auto_next_at = null, overlay = overlay - 'auto' where id = v_id;
        v_res := '{}'::jsonb;
      elsif p_cmd = 'clear_overlay' then
        update arenas set overlay = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(overlay) as x(k, v)
          where k in ('match', 'zone', 'world', 'red', 'auto')) where id = v_id;
        v_res := '{}'::jsonb;
      else
        v_res := _host_exec(v_ev, v_id, p_cmd, p_args, p_reason);
      end if;
      -- hooks keeping match phases consistent with the original commands
      if p_cmd = 'resume' and v_delta is not null then
        update arenas set phase_next_at = phase_next_at + v_delta, phase_started_at = phase_started_at + v_delta,
          auto_next_at = auto_next_at + v_delta, last_red_at = last_red_at + v_delta, red_at = red_at + v_delta,
          shuttle_departed_at = shuttle_departed_at + v_delta,
          overlay = case when overlay ? 'match' and overlay #>> '{match,next_at}' is not null then jsonb_set(overlay, '{match,next_at}',
            to_jsonb((overlay #>> '{match,next_at}')::timestamptz + v_delta)) else overlay end
        where id = v_id;
      elsif p_cmd = 'begin_finale' then
        update arenas set match_phase = 5, phase_started_at = now(), phase_next_at = null,
          overlay = overlay || jsonb_build_object('match', jsonb_build_object('phase', 5, 'started_at', now(), 'next_at', null, 'zone_target', 5))
        where id = v_id;
        perform _feed(v_id, 'phase.started', jsonb_build_object('phase', 5));
      elsif p_cmd = 'zone_cancel' then
        update arenas set zone_hold = true where id = v_id;
      elsif p_cmd in ('zone_warn', 'zone_now', 'zone_set') then
        update arenas set zone_hold = false where id = v_id;
      elsif p_cmd = 'reset_arena' then
        update arenas set match_phase = 0, phase_started_at = null, phase_next_at = null, zone_hold = false,
          red_x = null, red_y = null, red_r = null, red_at = null, last_red_at = null,
          autopilot = false, auto_step = null, auto_next_at = null, auto_story = -1, overlay = overlay - 'auto' where id = v_id;
        update teams set zone_hit_at = null, travel_fx = null, travel_fy = null where arena_id = v_id;
      end if;
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), v_res);
      insert into audit_log(event_id, arena_id, actor, action, args, reason) values (v_ev, v_id, 'host', p_cmd, v_logargs, p_reason);
    exception when others then
      v_err := sqlerrm;
      insert into audit_log(event_id, arena_id, actor, action, args, reason, ok, error) values (v_ev, v_id, 'host', p_cmd, v_logargs, p_reason, false, v_err);
      if array_length(v_ids, 1) = 1 then
        return jsonb_build_object('ok', false, 'error', v_err);
      end if;
      v_out := v_out || jsonb_build_object(coalesce(v_id::text, 'event'), jsonb_build_object('error', v_err));
    end;
    if v_id is not null then perform _zone_publish(v_id); perform _ping_arena(v_id, 'host'); end if;
  end loop;
  return jsonb_build_object('ok', true, 'result', v_out);
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
    'arenas', (select coalesce(jsonb_agg((to_jsonb(a) - 'last_tick_at') || jsonb_build_object('auto', _auto_status(a.id)) order by a.number), '[]'::jsonb) from arenas a where a.event_id = v_ev),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'name', t.name, 'arena_id', t.arena_id, 'ready', t.ready, 'roster_locked', t.roster_locked,
        'bus', t.bus, 'hp', t.hp, 'shield', t.shield, 'coins', t.coins, 'points', t.points, 'trust', t.trust,
        'final_points', t.final_points, 'missions', t.missions_completed, 'battles', t.battle_wins,
        'location', t.location_id, 'state', t.state, 'travel_to', t.travel_to, 'pos', to_jsonb(_team_xy(t)),
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
        'host_export', 'spectator_state', 'host_roster', 'captain_steer', 'captain_reveal']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;

