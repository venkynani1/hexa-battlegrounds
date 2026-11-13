-- ════════════════════════════════════════════════════════════════════════════
-- HEXA BATTLEGROUNDS × OPERATION SIRUSERI — ONE-FILE DATABASE UPGRADE (v12)
--
-- Supabase → SQL Editor → New query → paste this whole file → Run. That's all.
--   • Works on a brand-new project and on every earlier version (setup, upgrade 1/2/3, half-run upgrades).
--   • Keeps every event, squad, PIN and score. Everything runs in ONE transaction: all or nothing.
--   • It downloads the full script (1202 KB, too big to paste) from GitHub, checks its
--     SHA-256 fingerprint so nothing else can run, then executes it.
-- Expected result: "Success. No rows returned" and a notice: Hexa Battlegrounds database is up to date (v12).
-- If your project blocks outbound HTTP, run supabase/full/hexa-battlegrounds-v12.sql instead
-- (psql, or: DATABASE_URL="<POSTGRES_URL_NON_POOLING>" npm run db:setup).
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists http with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $hexa$
declare
  v_url text := 'https://raw.githubusercontent.com/venkynani1/hexa-battlegrounds/9dd571caa8fc8115c50e9ad18006fbc9ff080361/supabase/full/hexa-battlegrounds-v12.sql';
  v_sha text := 'b237d5accdd3582149b8fac35e6fecc6af3875254420fc4c081c4e07c6001b4b';
  v_status int;
  v_sql text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '120');
  select r.status, r.content into v_status, v_sql from extensions.http_get(v_url) r;
  if v_status is distinct from 200 then
    raise exception 'Could not download the upgrade (HTTP %) from %', v_status, v_url;
  end if;
  if encode(extensions.digest(convert_to(v_sql, 'UTF8'), 'sha256'), 'hex') <> v_sha then
    raise exception 'The downloaded file does not match the expected fingerprint. Get the latest RUN-ME-IN-SUPABASE.sql from GitHub and try again.';
  end if;
  execute v_sql;
  raise notice 'Hexa Battlegrounds database is up to date (v12).';
end
$hexa$;
