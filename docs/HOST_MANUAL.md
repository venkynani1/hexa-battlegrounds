# Host manual

## Crew
| Person | Device | Screen |
|---|---|---|
| Host | laptop | `/host` — runs the game |
| Co-host (recommended) | laptop or tablet | `/host` (same event code + password) — squads, disputes, chat moderation |
| Projector operator, one per map | PC on the projector | `/screen/<token>` from Host → Links. Click **Enable sound & fullscreen** once. |

## Before the event (days ahead)
1. **Create the event** at `/host` → Create event, with 1 map per 60 players.
2. **Links & PINs → Create squads**: codenames, buses and 6-digit PINs are generated. Click **Print squad cards** (one card per squad with its own QR code that pre-fills the squad number, plus the PIN) or **Download CSV**. PINs are stored hashed and shown only in this browser session; **Issue new PIN** on any card replaces one securely.
   Or paste an organiser CSV (`number,name,pin,map`; leave PIN empty to generate one). The whole file is validated first.
3. **Game control → Match pacing**: pick *Full event* (or tune in Settings) and a shuttle length.
4. Rehearse in a separate event (for example `HEXA26T`) with a few real phones; *Reset map* returns it to the lobby.
5. On event day just log in with the same code and password: squads, PINs and settings are already there.

## Earlier notes
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
- [ ] Test **Pause/Resume**, **Broadcast**, **Countdown**, **Blackout**, a **lockdown alarm** (Suspense → Collapsing Campus), **Zone warning**.
- [ ] Test a disconnect: close a phone browser, reopen `/play` — it must resume the same role.
- [ ] Walk the 3D world with the captain's joystick, call a **red zone**, shrink the zone and check that phones outside lose HP.
- [ ] Reset the rehearsal map: Game control → **Reset map** (type `RESET`) — squads and players stay, gameplay is wiped. Or create a fresh event code for the real game.
- [ ] Print the PIN sheet and keep a spare laptop logged into `/host`.

## Automatic match (recommended)
Game control → **Automatic match**: pick a length and press **▶ START MATCH** once (on *All maps* it starts every map).

| Length | Play time | Finale | Total |
|---|---|---|---|
| Quick | phases at 1, 3, 5, 7 min · finale at 9 min | 1 battle round | ≈ 15 min |
| Standard | phases at 2, 6, 11, 16 min · finale at 21 min | 2 battle rounds | ≈ 35 min |
| Full | phases at 3, 15, 30, 45 min · finale at 55 min | 3 battle rounds | ≈ 75 min |

After that nothing needs a button: boarding at the gate → take-off and flight (roles handed out automatically) → the plane crosses the campus and squads jump → Phases 0–4 (zone shrinks, airdrops, red zones from Phase 2, loot on the ground, and from Phase 1 a lockdown alarm every few minutes that seals floors and buildings one by one) → finale in Training Room 14 (entry round A, exchange round B, battle round(s) C, Final Lockdown D, final code E). Each finale round ends early once every squad has finished it, with a 10 s break before the next → results lock → winner reveal → grand champion when every map has its winner.

- The panel shows what happens next and when (also shown on the projector and phones).
- **Pause** freezes everything, including the autopilot's countdown. **Resume** carries on.
- Any manual button still works (Drive early, Next phase, Begin finale, Launch round, Lock results…). The autopilot follows from the new state.
- **Manual control** switches the autopilot off for that map. **Start match** again hands it back from wherever the match is.
- The autopilot runs inside the game's own clock, which every phone, the projector and this console keep ticking. Keep at least the projector or this page open during the match.
- Reset map turns the autopilot off.

## The start: airport, flight, jump (v6)
- **Check-in:** players scan the QR (or open `/join`) and check in at "Chennai International Airport" with the **map number** and the **squad PIN** — no squad number to type. Their phone then shows a **boarding pass** (passenger, flight HX 26‹map›, seat, gate).
- **Roles** are handed out by the game at take-off (one random captain per squad, then scout, decoder, intel). Nobody picks.
- **Flight:** phones and the big screen show the plane taking off from Chennai and flying along OMR to Siruseri.
- **Jump:** the plane crosses the campus in a straight line (about 55 s). The captain picks a landing spot inside the dashed **gliding circle** and presses **JUMP**; the squad parachutes down. When the plane is about to leave, everyone still on board is dropped automatically.
- **On foot:** squads land on foot and walk to the nearest parking yard, where the buggy with their number waits (**GET IN**). Buggies cannot enter buildings — the captain parks at the door and walks in through the front entrance. Inside, the captain sees the building **in first person** (drag to look, joystick to walk, ▲▼ at the stairs); teammates watch the captain from behind.
- **Gunfights** start in Phase 1: every squad member has a **FIRE** button when a rival is in range and nothing blocks the shot. Pistol (12 rounds), SMG (fast, short range), Sniper (slow, long range, headshots). At 0 HP a squad is knocked out into Recovery (never eliminated); the squad that knocked it gets points, coins and part of its coins.
- **Zone (Free Fire style):** the white circle shows the next safe zone, a countdown runs, then the blue gas wall closes in smoothly. Damage outside grows every stage (1 → 8 HP every 2 s).
- To run the earlier bus start instead (role claims, no plane), set `br_mode` to 0 in Settings.

## Fixed squad cards (same PINs and QR codes every time)
- Tick **Create the squads with my fixed squad cards** when you create an event, or open **Links & PINs → Fixed squad cards** and type the host password.
- Squads 1–15 are Map 1, 16–30 Map 2, 31–45 Map 3. Each squad's PIN and QR code are the same in every event you create **with the same host password on the same database**. Print the cards once and reuse them.
- The QR code holds no secrets: it opens the newest event that uses your cards and fills in the squad number. Players still type the PIN.
- A different host password gives a different card set. **Issue new PIN** on one squad overrides its fixed PIN for this event only.

## Demo mode (no players needed)
- Open `/demo` (or **Watch a demo match** on the home page), pick 1–3 maps and a length, press **Start the demo match**.
- Every map gets 15 dummy squads of 4 dummy players. They drop, drive, search, answer (sometimes wrongly), fight, open crates and vaults, run from lockdowns and play the finale, using the same rules as real phones.
- The big screen is the projector view. The phone on the right is the screen of any dummy player you pick (squad + role). On a Captain's phone, **Take control** lets you drive and answer yourself; **Hand back** returns it to the dummy.
- **Host console** opens the normal console for the demo match. Keep the demo page open: it keeps the match clock ticking. Demos are deleted after a few hours or with **End demo**.

## Load test
`SUPABASE_URL=… SUPABASE_KEY=<anon key> MAPS=3 MINUTES=5 npm run loadtest` simulates 180 phones (polling, positions feed, captains steering 3 times a second, searching and answering) and prints response times. Target: p95 under 500 ms and no server errors.

## Collapsing Campus (lockdowns)
Suspense → **Collapsing Campus**:
- **Sound the next alarm now** — the next building/floor on the collapse order gets a countdown (`lock_warning`, default 45 s) and a vault opens inside.
- Pick a building (and optionally one floor) → **Alarm (with countdown)** or **Seal now** (squads inside take `lock_damage` immediately).
- **Lift all lockdowns** reopens everything on the map. **Top up med kits & loot** refills the ground loot.
- Automatic alarms start in Phase 1 every `lock_interval` seconds (0 = host only). Hexavarsity never seals; finale stage D seals everything else.

## Floors, stairs and loot (what players see)
Squads are buggies. Rooms are on different floors; the captain drives onto a green ⇅ STAIRS ring and uses ▲ ▼ to climb. Med kits, shield packs and coin stacks lie around (also upstairs); driving over them picks them up. Wrong answers cost 5 HP, unsolved challenges 20 HP.

## Running the game — phases
Each map card shows the current **match phase** with *◀ / Next phase ▶* and *Hide rankings*. With automatic pacing the phases advance on the timeline shown in Match pacing; the zone contracts by itself toward each phase's target (*Cancel* holds it). Duels are locked until Phase 2. *Hide rankings* seals the leaderboard on the projector and on phones without changing any score.

## Running the game by hand
Follow the run-sheet in [GAME_DESIGN.md](GAME_DESIGN.md#120-minute-run-sheet-per-map-parallel-maps-run-the-same-sheet). Typical sequence per map (or *All maps*):
1. **Open boarding** (assigns buses). You can start with any number of complete squads from 1 to 15; incomplete squads stay in the lobby. An empty map is refused.
2. **DRIVE** → take-off and flight (40 s, roles assigned at take-off) → 6 s approach → the plane crosses the campus, squads jump (anyone still on board is dropped automatically when it leaves).
3. During play: airdrops and **red zones** (Map & zone), **lockdown alarms** and loot top-ups (Suspense → Collapsing Campus), zone warnings (Map & zone or automatic). The safe zone is a shrinking circle; squads outside lose HP over time and are never teleported. Red zones give phones a 20 s warning, then hit squads still inside for 30 HP.
4. **Begin finale** → set stage and **Launch round** for A, B, C (repeat C as you like), **Final lockdown** for D, launch E.
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
- **Not yet built (P1/P2 of the expansion brief):** new mission categories and structures, squad levels and badges, tactical role abilities, bounties/control points/world events, comeback missions, finale redesign, host scene switching and commentary cues.
- **Fog of war** is not implemented; every squad sees the whole map (other squads' positions follow the existing visibility rules).
- **Simulated players** run in the host's browser tab and stop if it is closed.
- **Realtime:** public pings only (no data). If Realtime is blocked by the network, the game still works by polling (2–8 s).
- **Capacity:** designed for ≤ 60 players per map and ≤ 3 maps on the free tier (≈ 200 Realtime connections). For more, upgrade Supabase or run a second free project per extra map pair.
- **Registration** is one step (name + squad number + PIN + consent). There is no separate pre-registration form or employee ID field (not collected by design).
- **Map** is stylised and editable (`content/map.mjs`), not geographically accurate; it needs approval against a real campus plan. There is no in-app drag-and-drop map editor; host can enable/disable locations live.
- **Gunfights** are live: any squad member can hold FIRE at a rival in range and in sight. Multi-squad free-for-alls also happen in airdrop races and finale rounds.
- **Content:** text/visual puzzles only. Audio and licensed movie challenges are not included (noise, copyright); add them via the mission editor with properly licensed assets.
- **Trading** items between squads is negotiated in chat but not yet an in-app transaction (host can transfer with an audited adjustment).
- **Alliances** are pairwise.
- Backlog ideas: drag-and-drop map editor, item trading, multi-squad battles, per-map mission pools, CSV export of standings, PWA install prompt, i18n (Tamil/Telugu/Hindi copy).
