# Online edition

## v13 · Automatic maps (recommended for the event)
1. Host console → event `HEXAONLINE` → Online tab → choose the length → **▶ Start — automatic maps**. That is the only button.
2. Players keep checking in (employee ID + e-mail), create squads, join with codes or use matchmaking.
   They fill **one map at a time** (15 squads ≈ 60 players).
3. A map **takes off by itself** when it has 15 complete squads, or when its countdown ends:
   3 minutes once the map has 4 players, cut to 45 seconds once all 15 squads are there.
   Small squads on that map are merged at take-off; extra players move to the next map, which starts filling at once.
4. Every match runs on its own (automatic match). The host console shows each map's countdown and has
   **Launch now** (start the filling map early) and **Pause automatic starts**.
5. Live test (13 Nov 2026, Neon): 300 players arriving over 2 minutes → 6 maps launched by themselves,
   nobody left in a lobby, p95 0.35 s, while 120 in-person players played at the same time.

The one-wave Start (everyone takes off together) is still under "Or start everyone at once".


The same game, played from laptops by people on a Microsoft Teams call. It runs as a **second website**
(its own Vercel project and its own free Supabase database) built from this same repository with
`VITE_EDITION=online`. The in-person site is unchanged.

## How players join
1. The host pastes the online join link (Host console → **Players & attendance**) into the Teams call chat.
2. Each player enters the **event code**, their **10-digit employee ID**, their **company e-mail** (the one they use in Teams) and a display name, then picks:
   - **Find me a squad** — matchmaking fills the fullest open squad first, so squads complete quickly.
   - **Create a squad** — gets a 4-letter **squad code** and an invite link to share with up to 3 friends.
   - **Join with a code** — a friend's squad code (or the invite link, which fills it in).
3. Anyone who switches laptop or closes the browser chooses **Rejoin with your ID** — same ID and e-mail, same squad.
   An employee ID can be checked in only once per event, with one e-mail.
4. Before take-off a player can **Change squad** (join a code, matchmaking, or a new squad).

## Squad size and the start (v10)
- Before the start everyone waits in the **lobby** with their squad. Nothing moves until the host presses
  **Start online game** (Host console → Players & attendance).
- A squad of **4** is full; a squad of **3** is ready. At Start, squads of 1–2 are merged across the whole event:
  pairs and singles become 3s and 4s; a lone player tops up a squad of 3 or borrows from a squad of 4. As a last
  resort one squad of 2 plays and the bot covers its two missing roles. Only a single player alone in the whole
  event cannot play. Everyone moved sees a note in squad chat.
- In squads of 2 and 3 the missing roles go to players as a second clue (never to the captain in a squad of 3).

## Maps
- At Start the squads are dealt out evenly over as many maps as needed (15 squads = 60 players a map, up to
  **Most maps**), and every map takes off together with the automatic match (Quick, Standard or Full).
- **Late players** (after Start) choose *Find me a squad* and fill an open seat in a squad that has not landed yet.
  New squads cannot be created after Start. Returning players (Rejoin with your ID) always get their squad back.
- Projector links for each map are in **Players & attendance** — share your screen into the Teams call.

## Talking
- **Teams squad call** and **Teams group chat** buttons open Microsoft Teams with the teammates already filled
  in (Teams deep links). E-mails are shown only to the player's own squad.
- **Squad chat** (the 💬 Squad button on every screen): messages and quick pings
  (Come to me, I have my clue, Need help, Got it, Wait, Enemy near).

## Laptop controls
`W A S D` / arrows move · `R` walk/run · `Space` or `E` the big action button (JUMP, OPEN BOX, GET IN…) · hold `F` to fire.
The on-screen joystick and buttons still work.

## Attendance
Host console → **Players & attendance** → **⬇ Attendance (CSV)**: employee ID, name, e-mail, map, squad, squad code,
squad size, role, points, first check-in and last seen. Opens in Excel with leading zeros kept.

## Settings
- **Allowed e-mail domains** (e.g. `hexaware.com`): blocks personal e-mail addresses.
- **Most maps**: the ceiling for maps that open by themselves.

## Capacity
200 players = about 50 squads = 4 maps, all in one free Supabase project of its own. A local load test
(`ONLINE=1 PLAYERS=200 MINUTES=2 npm run loadtest`) ran 200 players on 4 auto-opened maps at about
240 requests per second with no server errors. Run the same command against the real online database
(`SUPABASE_URL=… SUPABASE_KEY=<anon key>`) a few days before the event. Supabase Free allows about 200 live
Realtime connections; above that phones fall back to polling automatically.
