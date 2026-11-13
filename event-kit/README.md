# Event kit — Hexaoffline + Hexa Online

## Event day setup (13 Nov 2026): game data on Neon
Both websites now keep their game data in their **own free Neon database** (Vercel → Storage, region
Singapore, env prefix `NEON`). Supabase is still connected, but only carries the live messages between phones.
- In-person site → Neon `hexa-offline-db`; online site → Neon `hexa-online-db`. Each already holds
  HEXAOFFLINE (2 maps, the same 30 printed cards and PINs) and HEXAONLINE; host password unchanged.
- Live test, both games at once: 120 in-person + 180 online players for 3 minutes, **0 server errors**,
  p95 ≈ 0.33 s measured from outside India (most of that is the network round trip).
- **Switch back to Supabase** (emergency only): Vercel → project → Settings → Environment Variables →
  delete `VITE_API_RPC` → Deployments → Redeploy. Note that Supabase holds its own copy of the events,
  not the games played on Neon.
- The Supabase steps below are kept for reference; they are **not needed** while `VITE_API_RPC=1`.


Run these in **Supabase → SQL Editor → New query**, in this order.

| Step | File | What it does |
| --- | --- | --- |
| 1 | `1-RUN-ME-IN-SUPABASE.sql` (this folder) | Updates the database to v9 for both websites. Safe to run again. |
| 2 | `2-HEXA-FRESH-START-PRIVATE.sql` (the private copy shared with the host, **not** in this repo) | **Deletes every game**, then creates HEXAOFFLINE (2 maps, 30 fixed squad cards) and HEXAONLINE. Run **once**. |

`2-HEXA-FRESH-START-TEMPLATE.sql` here is the same script with the host passwords and the card secret
replaced by placeholders, for reference only. This repository is public, so the real values stay out of it.

Expected result of step 2: 3 rows — HEXAOFFLINE map 1 (15 squads), HEXAOFFLINE map 2 (15 squads), HEXAONLINE map 1 (0).

## Check after running
- In-person host console: https://hexa-battlegrounds.vercel.app/host — event `HEXAOFFLINE`
- Online host console: https://hexa-battlegrounds-online.vercel.app/host — event `HEXAONLINE`
- Scan one printed squad card and check in with its PIN.

## Player guides
- Online: https://claude.ai/artifact/7QBtq6Mnj8YoUXuZYQgXHy
- In-person: https://claude.ai/artifact/28GX6akbhSxXa2BEwxVMSC

The squad-card PDF (it lists every squad PIN) is also kept out of this public repository.
