# Host manual

## Crew
| Person | Device | Screen |
|---|---|---|
| Host | laptop | `/host` — runs the game |
| Co-host (recommended) | laptop or tablet | `/host` (same event code + password) — squads, disputes, chat moderation |
| Projector operator, one per map | PC on the projector | `/screen/<token>` from Host → Links. Click **Enable sound & fullscreen** once. |

## Before the event
1. **Create the event** at `/host` → Create event. Pick the number of maps: 1 map per 60 players.
2. **Create squads** in Links & PINs: *Create N squads* (random PINs) or paste an organiser CSV (`number,name,pin,map`). Download/print the PIN sheet immediately — PINs are stored hashed and cannot be shown again (re-import a squad to reset its PIN).
3. **Distribute** squad number + PIN privately to each squad (email, slip of paper). Show the join QR on the projector; it contains only the event code.
4. **Tune** Settings if needed (timers, points, `zone_auto`).
5. **Review content** in Missions. Edit or add missions; only *published* (or *approved*, for manual assignment) missions are used live. Every edit creates a new version; running missions keep the version they started with.

## Rehearsal checklist (day before)
- [ ] Open the Supabase dashboard (wakes a paused free project) and the Vercel URL.
- [ ] `npm run loadtest` against the real project with `SQUADS=15 MINUTES=3` → p95 under 500 ms, no unexpected rejections.
- [ ] On venue Wi-Fi: join with at least 4 real phones (1 Android, 1 iPhone) as one squad; play a full loop: roles → drop → mission → battle → airdrop → finale round.
- [ ] Projector: fullscreen, sound on, readable from the back row, correct map.
- [ ] Test **Pause/Resume**, **Broadcast**, **Countdown**, **Blackout**, a **Squad 00 transmission**, **Zone warning**.
- [ ] Test a disconnect: close a phone browser, reopen `/play` — it must resume the same role.
- [ ] Reset the rehearsal map: Game control → **Reset map** (type `RESET`) — squads and players stay, gameplay is wiped. Or create a fresh event code for the real game.
- [ ] Print the PIN sheet and keep a spare laptop logged into `/host`.

## Running the game
Follow the run-sheet in [GAME_DESIGN.md](GAME_DESIGN.md#120-minute-run-sheet-per-map-parallel-maps-run-the-same-sheet). Typical sequence per map (or *All maps*):
1. **Open boarding** (assigns buses; incomplete squads stay in the lobby — fix them in Squads first).
2. **DRIVE** → 10 s shuttle → Gate 1 role claim (15 s) → map revealed.
3. During play: airdrops (Map & zone), transmissions and bargains (Suspense), zone warnings (Map & zone or automatic).
4. **Begin finale** → set stage and **Launch round** for A, B, C (repeat C as you like), **Reveal Squad 00** for D, launch E.
5. **Lock results** → **Reveal winner** on each map → **Reveal grand champion**.
6. Logs → **Export event summary** (results, ledger, audit, aggregate analytics).

## Incident playbook
| Situation | Do this |
|---|---|
| Player's browser closed / phone locked | Reopen the same browser → `/play`. Session is on the device; role, clues and timers are preserved. |
| Player switched phones / cleared data | Squads → Manage → **Remove** the old player → **Reopen roster** → the player joins again with the PIN → **Auto-fill empty roles** (or set the role). |
| Captain is unreachable | Squads → Manage → change roles (swap Captain with a teammate). Takes effect immediately. |
| Squad short of players before launch | Reopen roster and let a replacement join, or move players between squads by re-importing. Incomplete squads are not boarded. |
| A puzzle is broken or disputed | Squads → Manage → **Cancel** (no penalty) and **Assign an equivalent challenge**, or **Reveal hint**. Compensate with an **adjustment** (reason required, audited). Retire the template in Missions. |
| Squad stuck somewhere | Squads → Manage → **Relocate** (or Respawn if in recovery). |
| Projector frozen / disconnected | Reload the page. Gameplay is unaffected; it re-syncs to the latest state. |
| Projector link leaked | Links → **Revoke**, open the new link. |
| Host laptop dies | Log in from any device with the event code + password. Nothing is lost; timers keep running. Pause first if you need time. |
| Wi-Fi drops | **Pause** the map(s). Phones reconnect automatically when back; **Resume** shifts every timer by the pause length. |
| Abusive captain chat | Logs → chat moderation → **Hide**. Reported messages are highlighted. |
| "Server not configured" on the home page | Env vars missing in Vercel → add the Supabase integration or `VITE_SUPABASE_*` → redeploy. |
| Everything is slow / failing | Supabase dashboard → check the project isn't paused and usage limits. Switch phones to the venue Wi-Fi or mobile data. |

## Backup and recovery
- All state lives in Supabase Postgres; there is no in-memory server to lose. A page refresh or a client crash never loses progress.
- Supabase Free does not include point-in-time recovery: use **Logs → Export event summary** at milestones (end of play, after the reveal) to keep a JSON copy of standings, ledger and audit log.
- The ledger plus audit log reconstruct every score change. Disputes are resolved with audited adjustments, never by editing tables.
- To restart a map after an aborted run: Game control → **Reset map** (keeps squads/players) or create a new event code.

## Known limitations and backlog
- **Realtime:** public pings only (no data). If Realtime is blocked by the network, the game still works by polling (2–8 s).
- **Capacity:** designed for ≤ 60 players per map and ≤ 3 maps on the free tier (≈ 200 Realtime connections). For more, upgrade Supabase or run a second free project per extra map pair.
- **Registration** is one step (name + squad number + PIN + consent). There is no separate pre-registration form or employee ID field (not collected by design).
- **Map** is stylised and editable (`content/map.mjs`), not geographically accurate; it needs approval against a real campus plan. There is no in-app drag-and-drop map editor; host can enable/disable locations live.
- **Encounters** are one-on-one duels (one battle per squad at a time). Multi-squad free-for-alls happen in airdrop races and finale rounds.
- **Content:** text/visual puzzles only. Audio and licensed movie challenges are not included (noise, copyright); add them via the mission editor with properly licensed assets.
- **Trading** items between squads is negotiated in chat but not yet an in-app transaction (host can transfer with an audited adjustment).
- **Alliances** are pairwise.
- Backlog ideas: drag-and-drop map editor, item trading, multi-squad battles, per-map mission pools, CSV export of standings, PWA install prompt, i18n (Tamil/Telugu/Hindi copy).
