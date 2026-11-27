-- 0995 · Lean wire format, so one full event (130 phones, 2 h) stays well inside the free tiers
-- (Vercel Hobby: 1M function calls / 10 GB origin transfer a month; Neon Free: 5 GB network transfer a month).
--  * player_state(p_token, p_have): sections the phone already has (same md5) are left out; 'h' carries the hashes.
--    Non-captains also get the rivals feed inside it, so they no longer poll arena_positions separately.
--  * coordinates are rounded to 4 decimals (≈ 5 cm on campus) and empty fields dropped from the positions feed.

create or replace function _lean_xy(j jsonb, p int default 4) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'array' and jsonb_array_length(j) = 2
              and jsonb_typeof(j -> 0) = 'number' and jsonb_typeof(j -> 1) = 'number'
         then jsonb_build_array(round((j ->> 0)::numeric, p), round((j ->> 1)::numeric, p)) else j end $$;

-- positions feed: rounded, nulls dropped
create or replace function _lean_rivals(j jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(
           jsonb_strip_nulls(s)
           || case when jsonb_typeof(s -> 'pos') = 'array' then jsonb_build_object('pos', _lean_xy(s -> 'pos')) else '{}'::jsonb end
           || case when jsonb_typeof(s -> 'vel') = 'array' then jsonb_build_object('vel', _lean_xy(s -> 'vel', 6)) else '{}'::jsonb end
           || case when jsonb_typeof(s -> 'buggy') = 'array' then jsonb_build_object('buggy', _lean_xy(s -> 'buggy')) else '{}'::jsonb end
           order by o), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) with ordinality as e(s, o) $$;

do $$ begin
  if to_regprocedure('_arena_positions_v16(text)') is null then
    alter function arena_positions(text) rename to _arena_positions_v16;
  end if;
end $$;
revoke all on function _arena_positions_v16(text) from public;
do $$ begin execute 'revoke all on function _arena_positions_v16(text) from anon'; exception when undefined_object then null; end $$;

create or replace function arena_positions(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  v := _arena_positions_v16(p_token);
  if jsonb_typeof(v -> 'squads') = 'array' then v := jsonb_set(v, '{squads}', _lean_rivals(v -> 'squads')); end if;
  return v;
end $$;

create or replace function player_state(p_token text, p_have jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; k text; hk text; h jsonb := '{}'::jsonb; r jsonb; mx float8; my float8;
begin
  v := player_state(p_token);
  if jsonb_typeof(v) <> 'object' then return v; end if;
  -- rounded coordinates (squads keep their nulls: the phone tells "unknown" from "absent")
  if jsonb_typeof(v -> 'squads') = 'array' then
    v := jsonb_set(v, '{squads}', (select coalesce(jsonb_agg(
           case when jsonb_typeof(s -> 'pos') = 'array' then jsonb_set(s, '{pos}', _lean_xy(s -> 'pos')) else s end
           || case when jsonb_typeof(s -> 'vel') = 'array' then jsonb_build_object('vel', _lean_xy(s -> 'vel', 6)) else '{}'::jsonb end
           order by o), '[]'::jsonb)
         from jsonb_array_elements(v -> 'squads') with ordinality as e(s, o)));
  end if;
  if jsonb_typeof(v -> 'pickups') = 'array' then
    -- only loot around the squad (the 3D view draws loot up to ~0.17 of the map away; 0.3 leaves room to drive)
    select (s -> 'pos' ->> 0)::float8, (s -> 'pos' ->> 1)::float8 into mx, my
      from jsonb_array_elements(coalesce(v -> 'squads', '[]'::jsonb)) s
     where s ->> 'id' = v -> 'team' ->> 'id' and jsonb_typeof(s -> 'pos') = 'array' limit 1;
    v := jsonb_set(v, '{pickups}', (select coalesce(jsonb_agg(
           x || jsonb_build_object('x', round((x ->> 'x')::numeric, 4), 'y', round((x ->> 'y')::numeric, 4)) order by o), '[]'::jsonb)
         from jsonb_array_elements(v -> 'pickups') with ordinality as e(x, o)
         where mx is null or ((x ->> 'x')::float8 - mx) ^ 2 + ((x ->> 'y')::float8 - my) ^ 2 <= 0.09));
  end if;
  -- teammates read rivals from here (one call instead of two); the captain still polls arena_positions faster
  if v -> 'arena' ->> 'phase' = 'play' and coalesce(v -> 'me' ->> 'role', '') <> 'captain' then
    begin
      r := arena_positions(p_token);
      v := v || jsonb_build_object('rivals', r -> 'squads');
    exception when others then null;
    end;
  end if;
  -- leave out what the phone already holds
  foreach k in array array['pickups', 'feed', 'story', 'leaderboard', 'roles', 'roster', 'alliances', 'bargains',
                           'codewords', 'comms', 'airdrops', 'inventory', 'event', 'results', 'last_result', 'mission',
                           'battle', 'online', 'squad', 'chat_last'] loop
    if v ? k then
      hk := left(md5(coalesce((v -> k)::text, 'null')), 10);
      h := h || jsonb_build_object(k, hk);
      if jsonb_typeof(p_have) = 'object' and p_have ->> k = hk then v := v - k; end if;
    end if;
  end loop;
  return v || jsonb_build_object('h', h);
end $$;

grant execute on function player_state(text, jsonb) to anon;
grant execute on function arena_positions(text) to anon;
revoke all on function _lean_xy(jsonb, int) from public;
revoke all on function _lean_rivals(jsonb) from public;
