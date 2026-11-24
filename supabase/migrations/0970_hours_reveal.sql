-- ═══════════════════════════════════════════════════════════════════════════
-- v15 · Game length in hours, and the winner is revealed only by the host
--
--  • Three event lengths chosen when the event is created: 1 h, 1½ h and 2 h ('60', '90', '120').
--    Each one stretches the whole match: mission phases, zone collapse, airdrops, red zones,
--    lockdown alarms, recovery and attack timers, and the number of finale battles.
--      60 → phases at 3, 11, 20, 29 min · finale at 38 · 3 finale battles  (≈ 60 min door to door)
--      90 → phases at 3, 17, 32, 47 min · finale at 66 · 3 finale battles  (≈ 90 min)
--     120 → phases at 4, 23, 44, 65 min · finale at 92 · 4 finale battles  (≈ 120 min)
--  • Host-run events (the one Start button) stop at "Results locked". Nothing about the result reaches
--    phones or the projector until the host presses Reveal winner (and, with several maps, Reveal grand
--    champion). Demos keep revealing by themselves ('auto_reveal' = 1 is the default for them).
-- Run once (bundled in the full install).
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists _defaults_v14();
alter function _defaults() rename to _defaults_v14;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v14() || jsonb_build_object(
    'auto_reveal', 1,   -- 1 = the autopilot reveals the winner; host-run events set 0 (host presses Reveal)
    'game_minutes', 0)  -- length chosen at event creation: 60, 90 or 120 (0 = not chosen)
$$;

-- ── lengths ────────────────────────────────────────────────────────────────
drop function if exists _auto_preset_v14(text);
alter function _auto_preset(text) rename to _auto_preset_v14;
create function _auto_preset(p_length text) returns jsonb
language sql immutable as $$
  select case p_length
    when '60' then _auto_preset_v14('full') || jsonb_build_object(
      'phase_schedule', '3,11,20,29', 'finale_minute', 38, 'finale_battles', 3, 'zone_shrink', 50,
      'zone_warning', 50, 'airdrop_interval', 4, 'red_interval', 5, 'lock_interval', 170, 'lock_warning', 45,
      'recovery_seconds', 100, 'attack_cooldown', 75, 'protect_seconds', 100, 'boarding_seconds', 30, 'pickup_respawn', 75, 'game_minutes', 60)
    when '90' then _auto_preset_v14('full') || jsonb_build_object(
      'phase_schedule', '3,17,32,47', 'finale_minute', 66, 'finale_battles', 3, 'zone_shrink', 70,
      'zone_warning', 60, 'airdrop_interval', 5, 'red_interval', 6, 'lock_interval', 230, 'lock_warning', 50,
      'recovery_seconds', 120, 'attack_cooldown', 90, 'protect_seconds', 120, 'boarding_seconds', 30, 'pickup_respawn', 90, 'game_minutes', 90)
    when '120' then _auto_preset_v14('full') || jsonb_build_object(
      'phase_schedule', '4,23,44,65', 'finale_minute', 92, 'finale_battles', 4, 'zone_shrink', 90,
      'zone_warning', 75, 'airdrop_interval', 6, 'red_interval', 7, 'lock_interval', 290, 'lock_warning', 55,
      'recovery_seconds', 130, 'attack_cooldown', 100, 'protect_seconds', 130, 'boarding_seconds', 35, 'pickup_respawn', 100, 'game_minutes', 120)
    else _auto_preset_v14(p_length)
  end
$$;

-- ── one Start: accepts the hour lengths; host-run matches wait for the host's reveal ───────────────
drop function if exists _host_online_auto_v14(text, text, boolean);
alter function host_online_auto(text, text, boolean) rename to _host_online_auto_v14;
create function host_online_auto(p_token text, p_length text default 'standard', p_on boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_len text := coalesce(nullif(p_length, ''), 'standard'); v_hours boolean;
begin
  v_ev := _auth_host(p_token);
  v_hours := v_len in ('60', '90', '120');
  if coalesce(p_on, true) then
    -- the reveal belongs to the host; set before anything can take off
    update events set settings = settings || jsonb_build_object('auto_reveal', 0) where id = v_ev;
  end if;
  perform _host_online_auto_v14(p_token, case when v_hours then 'full' else v_len end, p_on);
  if v_hours and coalesce(p_on, true) then
    update events set settings = settings || _auto_preset(v_len) || jsonb_build_object('online_auto_length', v_len) where id = v_ev;
  end if;
  return host_online_summary(p_token);
end $$;

drop function if exists _host_online_start_v14(text, text);
alter function host_online_start(text, text) rename to _host_online_start_v14;
create function host_online_start(p_token text, p_length text default 'standard') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_len text := coalesce(nullif(p_length, ''), 'standard'); r jsonb;
begin
  v_ev := _auth_host(p_token);
  update events set settings = settings || jsonb_build_object('auto_reveal', 0) where id = v_ev;
  r := _host_online_start_v14(p_token, case when v_len in ('60', '90', '120') then 'full' else v_len end);
  if v_len in ('60', '90', '120') then
    update events set settings = settings || _auto_preset(v_len) where id = v_ev;
  end if;
  return r;
end $$;

-- ── the autopilot: reveal steps only when auto_reveal = 1 ─────────────────────────────────────────
do $$
declare src text; out text;
begin
  src := pg_get_functiondef('_autopilot(uuid)'::regprocedure);
  if position('auto_reveal' in src) > 0 then return; end if; -- already patched
  out := regexp_replace(src, 'elsif\s+v_pos\s*=\s*5\s*\+\s*v_n\s+then',
    'elsif v_pos = 5 + v_n and _cfg(v_ev, ''auto_reveal'') = 1 then');
  out := regexp_replace(out, 'elsif\s+v_pos\s*=\s*6\s*\+\s*v_n\s+then',
    'elsif v_pos = 6 + v_n and _cfg(v_ev, ''auto_reveal'') = 1 then');
  out := regexp_replace(out, 'if\s+v_pos\s*<\s*6\s*\+\s*v_n\s+or',
    'if (v_pos < 5 + v_n or _cfg(v_ev, ''auto_reveal'') = 1) or');
  if out = src or (length(out) - length(replace(out, 'auto_reveal', ''))) / length('auto_reveal') <> 3 then
    raise exception 'autopilot patch did not apply cleanly';
  end if;
  execute out;
end $$;

-- what the screens say comes next once results are locked
create or replace function _auto_step_name(p_pos int, p_n int) returns text language sql immutable as $$
  select case when p_pos <= 0 then 'Finale entry round' when p_pos = 1 then 'Exchange round'
    when p_pos <= 1 + p_n then 'Finale battle ' || p_pos when p_pos = 2 + p_n then 'Final lockdown'
    when p_pos = 3 + p_n then 'Final code' when p_pos = 4 + p_n then 'Results locked'
    when p_pos = 5 + p_n then 'Winner reveal by the host' when p_pos = 6 + p_n then 'Grand champion' else 'Match complete' end
$$;

-- execute rights (same list as before; new wrappers replace old names)
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
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary', 'host_online_start',
        'host_online_auto', 'host_online_launch', 'online_event_info', 'online_join_segue']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
