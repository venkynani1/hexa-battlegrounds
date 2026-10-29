# Trial manual — rehearse the whole match without real players

A **trial event** is a separate event created with **Host → Trial** on the login screen. It has its own code, squads and data, shows a yellow **TRIAL MODE** ribbon on every phone and projector, and starts with the *Quick demo* pacing preset. Trial-only controls (fast-forward, simulated squads, trial reset) are rejected by the server on live events, so a rehearsal can never touch the real game.

## 10-minute walkthrough
1. Open `/host` → **Trial** → event code (e.g. `HEXA26T`), name, password, 1 map → *Create trial event*.
2. **Links & PINs** → *Create 1 squad* and join it from four phones or browser tabs (scan the squad's QR on the roster, enter the PIN). This is your "real" squad.
3. **Trial mode** → *Add simulated squads* (e.g. 3). They join through the normal join path with their own PINs.
4. **Game control** → choose a shuttle length (Short 12 s or Cinematic 30 s) → *Open boarding* → *DRIVE*.
   Phones show the bus interior, doors closing, the road and the arrival briefing; the projector shows the convoy.
5. **Trial mode** → *Start simulated players*. Simulated captains claim roles, drop, move, search, answer missions (80 % correct by default), duel once Phase 2 begins, crack airdrops and answer finale rounds — using the same player and captain calls as phones. Keep this tab open while they play.
6. Watch the checklist tick itself off. Use the buttons beside each step (Next phase, Spawn airdrop, Collapse next stage, Pause/Resume, Begin finale, Launch round, Lock results, Reveal winner) and **⏩ +15 s / +1 min / +3 min** to move the server clock forward.
7. Tick the three manual checks yourself: mission privacy, reconnection, projector readability.
8. *Reset trial to lobby* and run it again, or log out and run the real event.

## What fast-forward does
It moves every server deadline in the trial map earlier by the chosen amount: shuttle and role timers, mission and battle deadlines, codeword backups, recovery, airdrop and alliance expiry, the next match phase and the next zone collapse. Clients follow automatically because they always read server time. It is not a client-side speed-up.

## Pacing presets
| Preset | Phase 1–4 start (min) | Zone warning | Shuttle | Mission timers |
|---|---|---|---|---|
| Quick demo (trial default) | 1, 3, 5, 7 | 30 s | 12 s | 70 % |
| Rehearsal | 2, 7, 13, 19 | 45 s | 20 s | 85 % |
| Full event | 3, 20, 40, 58 | 90 s | 30 s | 100 % |

Apply a preset in **Game control → Match pacing**; fine-tune any value in **Settings**. The finale always starts when the host presses *Begin finale*.

## Rehearsal checklist (auto-detected unless marked manual)
Squads prepared · squad joins 4/4 · bus lobby & boarding · shuttle departs · Gate 1 role claim · map navigation · first mission solved · wrong answer handled · Phase 2 duels unlock · squad duel · airdrop claimed · zone contraction · recovery at 0 HP · pause and resume · captain chat · finale in TR14 · finale round solved · results locked · winner reveal · *(manual)* mission privacy · *(manual)* reconnection · *(manual)* projector check.

## Load rehearsal
For a realistic network test against your real Supabase project, run `npm run loadtest` (see README) with `SQUADS=15` per map.

## Limits
- Simulated players need the host tab that started them to stay open; they read answers from the host view (which only a host can see).
- *Reset trial* keeps squads and players and wipes gameplay. Use *Forget simulated squads* to stop driving old ones.
