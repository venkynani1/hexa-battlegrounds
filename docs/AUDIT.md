# Feature audit (before the P0 expansion)

Baseline at commit `0ab97b6`: 21/21 engine tests pass, production build succeeds. Each row was checked against the actual code and the recorded browser play-test, not against file names.

| Feature | Existing | Partially implemented | Missing | Verdict and planned improvement |
|---|---|---|---|---|
| Clean participant map | SVG map with pan/zoom, safe/danger colours, airdrop and battle icons, reachable rings, travel time in the location sheet | Labels: on phones only gates, sports, Fountain and TR14 are named until you zoom in; no collision avoidance; building names overlap node labels; route only highlights a single edge | Location search list, filters (missions/airdrops/encounters), centre on squad, label toggle, visible safe-zone boundary, next-zone preview, short labels | **IMPROVE**: collision-avoiding labels with short/full names by zoom, filter chips, centre-on-squad, searchable list, safe-zone hull and next-zone preview, highlighted route |
| Bus-themed waiting lobby | Lobby roster with 1/4–4/4 and online dots; after boarding, a large "BUS n" card | — | Bus interior, seats, manifest, window scenery, departure board, bus number before boarding, readiness bar | **BUILD** |
| Animated shuttle journey | Server-timed shuttle phase; phone shows an emoji bus crossing a progress bar; projector shows buses sliding right | Duration is configurable (`shuttle_seconds`) but there are no presets; the scene is very plain | Door close, departure countdown, engine sound, road and scenery, destination progress, arrival briefing, Gate 1 countdown scene | **BUILD**: all derived from server timestamps so a refresh resumes at the right point |
| Map phases and zone shrinking | Zone stages 0–5 with collapse stage per location; warn and collapse; damage once per stage and auto-evacuation; reachability to TR14 tested; optional `zone_auto` schedule | No named match phases; duels are open from the first second; no phase-based unlocks | Six named phases with rules, phase-driven contraction, host timeline, pacing presets, mission time scaling | **IMPROVE**: match phases 0–5 with server-side gating, automatic phase pacing with contraction targets, presets, timeline |
| Mission variety | 145 templates from 15 families; every major mission splits clues across Scout, Decoder and Intel | Structures repeat (mostly "combine three facts" or "one fact each") | Requested categories (SQL, logs, git conflict, false-clue, timed clue change, two reward paths…) | **IMPROVE** in P1 |
| Game levels and progression | — | — | Squad levels, badges, abilities | **BUILD** in P1 |
| Pre-generated team PINs | Random 4-digit PINs generated in advance, shown once, CSV download | Default names are "Squad N"; no per-squad QR; PIN reset only by re-importing | Codenames, printable roster with QR codes, host-only PIN reset | **IMPROVE** |
| Import/export squad roster | CSV import (number, name, pin, map) | Weak validation (length only; duplicates in a file silently overwrite) | Roster export after generation, PIN strength and duplicate checks | **IMPROVE** |
| Trial/simulation mode | Offline local server; CLI load test; "Reset map" | — | Trial events, guided walkthrough, simulated squads in the UI, time acceleration, trial/production isolation | **BUILD** |
| Multiplayer interactions | Puzzle duels with cooldowns and protection, airdrop races, cross-team codeword relays with fallback, captain chat (rate limit, block, report), alliances and betrayal, Squad 00 bargains | — | Bounties, control points, convoy events, world events | **KEEP**, extend in P1 |
| Cinematic projector experience | Lobby with join QR, shuttle, role countdown, live map and leaderboard, alerts, transmissions, finale rounds, Squad 00 reveal, podium and confetti | Scenes follow game state only; no host scene switching; rankings always visible during play | Hide rankings, scene override, commentary cues | **IMPROVE**: P0 adds the bus/shuttle scenes, phase banners and ranking hide; the rest is P2 |
| Final comeback mechanics | Finale rounds pay 50–100% of a large pool; deterministic tie-breaks | — | Catch-up missions for trailing squads | **IMPROVE** in P1 |

## Player journey traced
QR (`/join?e=CODE`) → join with squad number + PIN → lobby (`arena.phase = lobby`) → host opens boarding (bus numbers assigned) → DRIVE (`shuttle`, server arrival time) → `roles` (15 s claim, unique index decides races) → `play` (Gate 1, first drop on any drop-zone, missions start on arrival) → zone collapses via host or `zone_auto` → `finale` (all squads moved to TR14, synchronized rounds) → `results` (locked) → reveal.

## Issues found during the audit
- On a 360 px phone most location names are hidden, so captains pick destinations by dot colour.
- Duels can start during the first drop, before squads have read their first clue.
- The shuttle lasts 10 s, which is too short for a cinematic moment, and there is no preset to lengthen it safely.
- A new host cannot practise without a full set of real phones.

## Status after P0 (commit with migration `0100`)
| Feature | Status | What was done |
|---|---|---|
| Clean participant map | **Done** | Collision-free labels (short names when zoomed out, full names when zoomed in or selected); marker shapes by type (buildings ■, amenities ◆, gates ⬡, sports ▲, rooms ●; green = market/healing, violet = airdrop hub); safe-zone boundary with hatched danger and dashed next-zone preview; shortest-route highlight with time and hops, plus "plan first stop"; filter chips (labels, zone, squads, drops); centre-on-squad; crowded-squad clustering; searchable location list. Verified at 360 px. |
| Bus-themed waiting lobby | **Done** | Bus interior with seats filling, departure board, window scenery, manifest dots, readiness, announcement ticker; projector boarding scene with bus cards and seat lights. |
| Animated shuttle journey | **Done** | Doors-closing countdown, road with parallax skyline, streetlights, signs, Gate 1 arch, rotating role briefings; projector convoy. Short/Cinematic presets. Driven by server time. |
| Map phases and zone shrinking | **Done** | Phases 0–5 with server gating (duels from Phase 2), phase-aware mission difficulty, automatic pacing, phase-driven contraction with hold, presets, host timeline. |
| Pre-generated team PINs | **Done** | 6-digit CSPRNG PINs, codenames, buses at creation, printable squad cards with per-squad QR, PIN reset, PINs kept out of audit logs. |
| Import/export squad roster | **Done** | Whole-file validation (duplicates, unknown maps, weak PINs), generated PINs for blank rows, CSV export. |
| Trial/simulation mode | **Done** | Trial events, guided auto-ticking checklist, simulated squads via real RPCs, fast-forward, reset, live-event isolation. |
| Cinematic projector | **Partly** | P0 scenes (boarding, convoy, phase banner, sealed rankings) added; scene switching and commentary cues are P2. |
| Mission variety, progression, abilities, world events, comeback, finale redesign | **Not started** | P1. |
