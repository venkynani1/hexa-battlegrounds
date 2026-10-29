# Game design

## Pillars
1. **Every player matters.** Major missions split indispensable facts across Scout, Decoder and Intel Officer; only the Captain can submit. Nobody can solve alone, nobody is a spectator.
2. **Nobody is eliminated.** 0 HP means Recovery (a short squad puzzle) and a respawn at 50 HP. The worst case is bounded by a timer.
3. **Nobody waits.** Arriving anywhere instantly starts a location mission; after a mission the Captain can search again or move. Battles pause mission clocks instead of wasting them.
4. **The campus closes in.** Five zone stages funnel every squad to Training Room 14 for a finale that all squads play at the same time.
5. **Choices are remembered.** Bargains, betrayals and shared codewords feed the public Squad 00 threat meter and the final reveal.

## Roles
| Role | Receives | Can act |
|---|---|---|
| ★ Captain | objective, timer, attempts, answer boxes, hints | submit, move, search, attack, claim airdrops, buy/use items, chat with other captains, alliances, bargains |
| ◉ Scout | visual evidence: grids, sequences, intercepted signals, slips, keypads | talk to the captain |
| ⌬ Decoder | the rules: cipher manuals, conversions, legends, price boards | talk to the captain |
| ◈ Intel Officer | constraints: which line is real, read order, house rules, codeword backups | talk to the captain |

Roles are claimed at Gate 1 (first tap wins, enforced by the database), then auto-filled.

## Core loop (per squad, runs in parallel for every squad)
Choose destination → travel (6–25 s, first drop 8 s) → arrive (encounter check, mission starts) → each teammate reads their clue → squad talks → captain submits (3 attempts) → reward (points, coins, location loot) or failure (−10 HP) → search again (2 missions per visit) or move. Leaving a location forfeits its mission without penalty.

## Challenge library (145 reviewed templates, generated from fixed seeds)
| Family | Scout | Decoder | Intel | Where |
|---|---|---|---|---|
| Signal Intercept (Caesar) | 3 intercepted lines | how the cipher works | real frequency + key | gates, transmissions, boardroom |
| Badge Reader (5-bit binary) | light rows with tags | binary → letter rule | tag read order | Hexavarsity, Phase 2, STG |
| Coordinate Drop | letter grid | coordinate list | (column, row) convention | terraces, glass zone, fountain, airdrops, final code |
| Barista Rush / Mess Hall | order slips | price board | which table + house rule | Costa, Hexadine, Hexaraunt |
| Tech Triad | question 1 | question 2 | question 3 | STG, help desk, offices |
| Triple Rebus | rebus 1 | rebus 2 | rebus 3 | anywhere (e.g. FA/TH/ER = STEPFATHER) |
| Corporate Scramble | anagram 1 | anagram 2 | anagram 3 | HR, boardroom, offices |
| Worn Keypad | worn keys | typing habit | wiring fault | gates, parking |
| Scoreboard Decode | ball-by-ball board | league scoring | which overs | sports courts |
| Pattern Lock | three sequences | conversion | which is genuine | learning, glass |
| Flash Memory | 7 objects, visible 20 s | object→letter key | positions that matter | Costa, food, learning |
| Bug Hunt / Boardroom Mole / Room Booking | code / seating / calendar | test log / rules / constraints | spec / question / policy | STG, CEC Boardroom, EB3 HR |
| Intelligence Exchange (relay) | tech question | tech question | tech question **+ backup codeword after 90 s** | Hexacafe, Fountain, markets |

Answers are computed by the generator, not hand-typed, and normalised (case, spaces, punctuation ignored). Each squad gets a deterministic variant (event seed + squad + counter), preferring templates tagged for the current location and never repeating one for the same squad. Audio challenges are deliberately excluded (noisy room); every challenge is text/visual and works with screen readers.

## Resources (never mixed)
| Resource | Purpose | Earned | Spent / lost |
|---|---|---|---|
| **Battle Points** | ranking only | missions 100 / hard 150, battle win 125, airdrop 75, codeword assist 25, zone escape 40, finale rounds up to 200–300 | recovery −40 |
| **Coins** | buy items, hints, alliances | missions 25, airdrops 40–100, bargains | hints 15, items 25–60, alliance 10 |
| **HP** (max 100) | survival state | med kit +30, respawn 50 | failed mission −10, battle 20–40, zone 15 (once per stage) |
| **Trust** | social access | alliances +10, cooperation +5, sharing codewords +10 | betrayal −20, bargains −5/−10; below 0 = no new alliances |

## Items
| Item | Effect | Price |
|---|---|---|
| Pistol | standard duel, 90 s, 25 dmg, never used up (every squad starts with one) | — |
| SMG | fast 3-digit keypad duel, 50 s, 20 dmg, one use | 40 |
| Sniper | hard logic duel, 120 s, 40 dmg, one use | 60 |
| Shield | absorbs the next 30 damage (max 60) | 35 |
| Med Kit | +30 HP (every squad starts with one) | 30 |
| Intel Scanner | see every squad, even jammed, for 60 s | 30 |
| Signal Jammer | hidden from the public map and feed for 120 s | 30 |
| Airdrop Beacon | next airdrop win pays double coins | 25 |
| Emergency Extract | instant move to the nearest safe location | 40 |

Markets: Hexadine sells everything; Hexacafe sells intel items. Locations drop their own loot on mission success.

## Encounters and battles
Two squads idle at the same location see **ENEMY SQUAD DETECTED** with Engage / Ally / Message. Engaging spends a weapon and starts the same puzzle for both squads with role-split clues; the first correct captain wins (125 points, 20 coins), the loser takes the weapon's damage (shield first). Timeout = draw, no damage.
Anti-griefing: one battle per squad at a time; attacker cooldown 90 s; both squads protected 120 s afterwards and after any respawn; no attacks on travelling or recovering squads or during finale rounds; mission clocks pause during battles.

## Airdrops
Tiers: common (40 coins + med kit), rare (60 + shield), legendary (100 + sniper + shield), mystery (20–120 + random gear), intel (30 + 120 s scan), cursed (double points but −20 HP). Host-triggered or automatic (`airdrop_interval`). Squads at the location race the same grid lock; the first correct answer wins atomically, everyone else gets 15 coins and is released.

## Cross-team intelligence (anti-deadlock)
Relay missions need a **codeword held by another squad's captain**, plus the squad's own three-part code. Primary path: captain chat (the holder sees "Squad 7 needs FALCON — Send"). Sharing pays the helper 25 points and 10 trust. Fallback: after 90 s the requesting squad's Intel Officer receives the codeword automatically and the mission pays half. No squad can ever be blocked by another squad's silence; the outcome is logged.

## Alliances and Squad 00
Alliances need both captains, cost 10 coins each, last 10 minutes, give +10 trust and permanent mutual map visibility. Attacking an ally is allowed but is a **betrayal**: alliance broken, −20 trust, threat +1, announced on the projector.
**Squad 00** is the engine's fictional antagonist. The host sends scripted transmissions and timed **bargains** (coins now, minus trust, plus threat). Squad 00 never touches Battle Points. In finale stage D the projector replays recorded choices (bargains accepted/refused, betrayals, codewords shared) and delivers one of three endings based on the final threat level.

## Match phases and zone
The match runs through six named phases. The current phase, its rules and the time to the next one are shown on every phone and on the projector; the server enforces the rules.

| Phase | Theme | What changes | Zone stage it contracts to |
|---|---|---|---|
| 0 Deployment | Arrival and reconnaissance | Starts when role claims close. Intro (standard-difficulty) missions. **Duels locked.** | 0 — whole campus |
| 1 Exploration | Explore and collect | Standard missions, first airdrops. Duels still locked. | 0 |
| 2 First Contact | Competition begins | **Puzzle duels unlock** (setting `duel_phase`). First contraction announced. | 1 |
| 3 Conflict & Intelligence | Risk versus reward | Mission picker prefers hard missions (150 points). Two contractions. | 3 |
| 4 Final Convergence | High-stakes comeback | Only Hexavarsity stays safe; last chance for points before the finale. | 4 |
| 5 Training Room 14 | Final showdown | Started only by *Begin finale*; synchronized rounds A–F. | 5 |

Phases advance automatically on the `phase_schedule` (minutes after play starts) when `auto_pacing` = 1, or manually with *Next phase*. Whenever the zone is below the current phase's target, the server announces the next contraction `zone_warning` seconds ahead (orange dashed **next-zone preview** on every map), then collapses it. *Cancel zone* holds contraction until the host acts again.

| Stage | Dangerous | Safe |
|---|---|---|
| 0 | — | whole campus |
| 1 | gates 2–4, sports courts | everything else |
| 2 | EB1, Phase 2, terraces, parking | central + EB2/EB3/RTB cores + Hexavarsity |
| 3 | EB2, EB3, RTB, Gate 1 | central amenities + Hexavarsity |
| 4 | central amenities | Hexavarsity + central steps |
| 5 | everything but TR14 | **Training Room 14** |

Squads still outside a collapsing area take `dmg_zone` (15) damage **once per stage** and are evacuated along the map graph to the nearest safe location; reaching safety before the collapse earns 40 points. 0 HP means Recovery, never elimination. TR14 never closes and every location has a route to it (tested). The safe zone is drawn as a glowing boundary around the safe locations with the danger area hatched.

### Pacing presets
| Preset | Phases 1–4 start (min) | Zone warning | Shuttle | Mission timers | Typical length |
|---|---|---|---|---|---|
| Quick demo | 1, 3, 5, 7 | 30 s | 12 s | 70 % | 8–12 min |
| Rehearsal | 2, 7, 13, 19 | 45 s | 20 s | 85 % | 20–30 min |
| Full event | 3, 20, 40, 58 | 90 s | 30 s | 100 % | 60–90 min |

## Finale (all squads simultaneously)
| Stage | Round | Max points |
|---|---|---|
| A Entry Lock | hard Signal Intercept | 200 |
| B Intelligence Exchange | relay round; squads paired cyclically, Intel backup after 90 s | 200 |
| C Simultaneous Battle | 1–3 rounds (orders, sequences, binary) | 300 each |
| D Squad 00 Revealed | cinematic recap from recorded data | — |
| E The Final Code | 8-letter grid code | 300 |
| F Champion | lock → reveal | — |

Round score = max × (0.5 + 0.5 × time remaining ÷ round length), so early solvers gain, but anyone who solves earns at least half. With ~3,800 possible finale points spread over 5–6 rounds versus typical 800–1,500 earned in play, comebacks are real without making earlier play meaningless.
**Ranking:** total points → finale points → missions completed → battle wins. A tie after all four is flagged on the host console and projector for a tiebreaker round. Never random.

## 120-minute run-sheet (per map; parallel maps run the same sheet)
| Time | Phase | Host action |
|---|---|---|
| −20 → 0 | Registration | Players join with squad number + PIN; projector shows join QR and readiness |
| 0:00 | Boarding & shuttle | Open boarding → DRIVE (10 s ride) |
| 0:02 | Gate 1 | Role claim (15 s) + reveal |
| 0:03 | Free play | Squads drop and run missions |
| 0:15 | Story | Transmission "SIGNAL ACQUIRED", first rare airdrop at the Fountain |
| 0:20 | Zone 1 | Warn 60 s → collapse |
| 0:30 | Story | Bargain "Fast cash" |
| 0:40 | Zone 2 | + legendary airdrop |
| 0:50 | Story | Transmission "I SEE YOU", bargain "The shortcut" |
| 0:55 | Zone 3 | Central campus only |
| 1:05 | Zone 4 | Hexavarsity only; transmission "LAST CALL" |
| 1:15 | Finale | Begin finale → A (3 min) → B (4 min) → C ×2 (2.5 min each) |
| 1:35 | Stage D | Reveal Squad 00 (~1 min) |
| 1:38 | Stage E | Final code (4 min) |
| 1:45 | Stage F | Lock results → reveal winner per map → grand champion |
| 1:50 | Close | Export event summary |

`zone_auto = 1` with `zone_schedule = 20,40,55,70,85` automates the zone timeline. All values are starting points — tune them after the rehearsal in Host → Settings.

## Arrival experience
- **Bus lobby:** after joining, each phone shows its squad's bus interior: departure board (bus `HBX-nn`, destination, squad codename, map, status), four seats filling as teammates join, live online dots, readiness bar and host announcements on a ticker. Roles are claimed at Gate 1, so seats show "Role at Gate 1" until then.
- **Shuttle:** doors close (about 3 s countdown), the bus drives a stylised road past signs and streetlights to the Gate 1 arch, while phones rotate through the four role briefings. The projector shows the whole convoy. Duration is a setting (Short 12 s / Cinematic 30 s). All motion is computed from server departure and arrival times, so a refresh resumes at the same moment and no phone arrives early.
