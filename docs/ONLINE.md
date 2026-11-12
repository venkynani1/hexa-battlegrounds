# Online edition (v8)

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

## Squad size
- A squad of **4** is full. A squad of **3** is ready to play.
- When the host presses **Take-off** on a map, squads of 1–2 are merged automatically:
  pairs and singles are combined into 3s and 4s; whoever is still alone tops up a squad of 3; if needed one
  player is borrowed from a squad of 4 (matchmade squads first). Everyone moved sees a note in squad chat.
- In a squad of 3 one player (never the captain) also holds the missing role and sees **both clues**.

## Maps
- The event starts with one map. When every open map has 15 squads, the next map opens by itself, up to
  **Most maps** (default 8, set in **Players & attendance**). About 200 players fill 4 maps.
- Each map is started by the host as usual (or with the automatic match). A map that has taken off accepts no
  new squads; late players go to the next map.
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
