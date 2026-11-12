-- ═══════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS · fresh start for the event
--   1. Deletes EVERY event, map, squad, player and score in this database (in-person, online, demos).
--   2. Creates the in-person event  HEXAOFFLINE  ("Hexaoffline") with 2 maps and 30 fixed squad cards
--      (squads 1–15 on Map 1, 16–30 on Map 2) — the PINs and QR codes match the printed cards.
--   3. Creates the online event  HEXAONLINE  (employee ID + company e-mail sign-in, maps open by themselves).
-- Run it ONCE in Supabase → SQL Editor, AFTER RUN-ME-IN-SUPABASE.sql (v9).
-- TEMPLATE: the real values are in the private copy (2-HEXA-FRESH-START-PRIVATE.sql) — run that one.
-- The printed squad cards match only with the exact private values.
-- ═══════════════════════════════════════════════════════════════════════════
begin;
delete from events;
delete from pin_failures;
insert into app_secrets(key, value) values ('card_pepper', 'PUT-CARD-SECRET-HERE')
  on conflict (key) do update set value = excluded.value;
do $$
declare t text; c jsonb;
begin
  t := host_create_event('HEXAOFFLINE', 'Hexaoffline', 'PUT-OFFLINE-HOST-PASSWORD-HERE', 2) ->> 'token';
  c := host_fixed_cards(t, 'HexaSummit-3379');
  if jsonb_array_length(c -> 'squads') <> 30 then raise exception 'expected 30 squad cards, got %', jsonb_array_length(c -> 'squads'); end if;
  t := host_create_event('HEXAONLINE', 'Hexa Online', 'HexaRaptor-7913', 1) ->> 'token';
  perform host_settings(t, '{"online": 1, "online_max_maps": 8, "email_domain": "hexaware.com"}'::jsonb);
  raise notice 'Done: HEXAOFFLINE (2 maps, 30 squads) and HEXAONLINE are ready.';
end $$;
commit;
select e.code as event, a.number as map, count(t.id) as squads
from events e join arenas a on a.event_id = e.id left join teams t on t.arena_id = a.id
group by e.code, a.number order by e.code, a.number;
