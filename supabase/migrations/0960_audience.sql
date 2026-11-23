-- ═══════════════════════════════════════════════════════════════════════════
-- v14 · Who is playing: Mavericks (employees) or Segue (campus), and squad-code joining in person
--
--  The host picks the audience when creating an event:
--    • Mavericks — players sign in with employee ID, company e-mail and name (as in v8);
--    • Segue     — players sign in with name, e-mail and college; no employee ID.
--  Both editions (in person and online) now use the same joining: create a squad and share its code,
--  join with a squad code, or "find me a squad". No printed cards or PINs are needed.
--  Segue players get an internal 10-digit key derived from their e-mail, so rejoining on another
--  device, matchmaking, squads and attendance all work exactly as for employees.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

alter table online_members add column if not exists college text;

drop function if exists _defaults_v13();
alter function _defaults() rename to _defaults_v13;
create function _defaults() returns jsonb
language sql immutable as $$
  select _defaults_v13() || jsonb_build_object(
    'segue', 0)   -- 1 = Segue (campus) event: name + e-mail + college, no employee ID
$$;

-- stable key for a Segue player: same e-mail → same 10 digits (fits the online_members key)
create or replace function _segue_key(p_email text) returns text
language sql immutable as $$
  select lpad((abs(hashtextextended(lower(trim(coalesce(p_email, ''))), 2026)) % 10000000000)::text, 10, '0')
$$;

-- what the join page needs to know before anyone signs in (no personal data)
create or replace function online_event_info(p_event_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e events;
begin
  select * into e from events where code = upper(trim(coalesce(p_event_code, '')));
  if e.id is null then return null; end if;
  return jsonb_build_object('code', e.code, 'name', e.name,
    'online', _cfg(e.id, 'online') = 1, 'segue', _cfg(e.id, 'segue') = 1,
    'email_domain', nullif(_cfg_text(e.id, 'email_domain'), ''));
end $$;

-- Segue sign-in: name, e-mail, college
create or replace function online_join_segue(p_event_code text, p_email text, p_name text, p_college text, p_mode text,
  p_code text default null, p_consent boolean default false, p_existing_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e events; r jsonb; v_college text; v_key text;
begin
  select * into e from events where code = upper(trim(coalesce(p_event_code, '')));
  if e.id is null then raise exception 'NO_EVENT'; end if;
  if _cfg(e.id, 'segue') <> 1 then raise exception 'NOT_SEGUE_EVENT'; end if;
  v_college := regexp_replace(trim(coalesce(p_college, '')), '\s+', ' ', 'g');
  if coalesce(p_mode, '') <> 'rejoin' and (char_length(v_college) < 2 or char_length(v_college) > 80) then raise exception 'BAD_COLLEGE'; end if;
  v_key := _segue_key(p_email);
  r := online_join(p_event_code, v_key, p_email, p_name, p_mode, p_code, p_consent, p_existing_token);
  if r ->> 'error' is null and char_length(v_college) between 2 and 80 then
    update online_members set college = v_college where event_id = e.id and emp_id = v_key;
  end if;
  return r;
end $$;

-- employees cannot sign in to a Segue event with an employee ID (and vice versa, above)
drop function if exists _online_join_v13(text, text, text, text, text, text, boolean, text);
alter function online_join(text, text, text, text, text, text, boolean, text) rename to _online_join_v13;
create function online_join(p_event_code text, p_emp_id text, p_email text, p_name text, p_mode text,
  p_code text default null, p_consent boolean default false, p_existing_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e events;
begin
  select * into e from events where code = upper(trim(coalesce(p_event_code, '')));
  if e.id is not null and _cfg(e.id, 'segue') = 1 and coalesce(p_emp_id, '') <> _segue_key(p_email) then
    raise exception 'USE_SEGUE_SIGNIN';
  end if;
  return _online_join_v13(p_event_code, p_emp_id, p_email, p_name, p_mode, p_code, p_consent, p_existing_token);
end $$;

-- attendance: college for Segue, no internal key shown
drop function if exists _host_attendance_v13(text);
alter function host_attendance(text) rename to _host_attendance_v13;
create function host_attendance(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v jsonb; v_segue boolean;
begin
  v_ev := _auth_host(p_token);
  v := _host_attendance_v13(p_token);
  v_segue := _cfg(v_ev, 'segue') = 1;
  return (select coalesce(jsonb_agg(
      case when v_segue then (r - 'emp_id') || jsonb_build_object('college', m.college) else r end
      order by ord), '[]'::jsonb)
    from jsonb_array_elements(v) with ordinality x(r, ord)
    left join online_members m on m.event_id = v_ev and m.emp_id = r ->> 'emp_id');
end $$;

drop function if exists _host_online_summary_v13(text);
alter function host_online_summary(text) rename to _host_online_summary_v13;
create function host_online_summary(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ev uuid;
begin
  v_ev := _auth_host(p_token);
  return _host_online_summary_v13(p_token) || jsonb_build_object('segue', _cfg(v_ev, 'segue') = 1);
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
        'online_join', 'squad_chat_send', 'squad_chat', 'host_attendance', 'host_online_summary', 'host_online_start',
        'host_online_auto', 'host_online_launch', 'online_event_info', 'online_join_segue']) then
      begin
        execute format('grant execute on function %s to anon, authenticated', f.sig);
      exception when undefined_object then null;
      end;
    end if;
  end loop;
end $$;
