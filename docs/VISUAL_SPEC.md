# Visual specification: Hexa Battlegrounds × Operation Siruseri

## Art direction: "Siruseri Ops, golden-hour esports"
A clean, readable stylised-realistic look (Free Fire / Fortnite readability, not photo-realism) so 60 squads and
their clues stay legible on a 6-inch phone in a noisy hall or a Teams call.

| Pillar | Rule |
|---|---|
| Readability first | Squad colour + number on every character, parachute and buggy; outlines/rings never hidden by effects. Gameplay information (zone, targets, loot tier) always wins over decoration. |
| Warm sun, cool shade | Key light warm (#fff0d6), sky/ambient cool blue; ACES Filmic tone mapping; long soft shadows. |
| Hexaware accents | Cyan/teal (#1fb6c9 → #7fd0ff) for friendly UI, glass and signage; amber (#ffc23d) for objectives and loot; red (#ff4d5e) only for danger (zone, lockdowns, damage). |
| Glow means "look here" | Only emissive things bloom (selective bloom by HDR threshold 0.92): lamps, beacons, tracers, zone wall, loot glow, VFX. Never the sky or white walls. |
| Motion with meaning | Every animation reflects real game state that the server already decided (landing, hit, loot opened, winner). Animations never change scores or positions. |

## Quality presets (Settings → Graphics; default "Auto")
| | Low | Balanced | High |
|---|---|---|---|
| Target | old / low-RAM phones | mid-range Android, iPhones, laptops | desktops |
| Pixel-ratio ceiling | 1.0 | 1.5 | 2.0 |
| Adaptive resolution floor | 60% | 65% | 70% |
| Frame budget (p90) | 33 ms | 22 ms | 17 ms |
| MSAA | off | off | on |
| Shadows | off | 1024² PCF soft | 2048² PCF soft |
| Bloom | off | 40% buffer | 50% buffer |
| Particles | 35% | 70% | 100% |
| Fog far | 1000 m | 1350 m | 1500 m |

Auto picks from GPU name (WEBGL_debug_renderer_info), cores, device memory and pointer type. Adaptive resolution
steps the render scale down 8% when the 90th-percentile frame time is >115% of budget, and back up 5% after three
calm seconds, at most once a second, and never below 0.75 real pixels per CSS pixel (so it never turns blocky). Reduced motion (Settings → Motion, or the OS setting) disables camera shake,
bobbing, flashes and confetti; every audio cue already has an on-screen equivalent.

## Assets and licensing
All geometry, textures and sounds are **original and generated in code** (three.js primitives, merged and instanced
geometry, canvas-drawn textures, Web Audio synthesis). Nothing is downloaded from asset stores, so there is nothing
to license and nothing to go missing at runtime. Characters are code-built skinned meshes with a real skeleton and
keyframed animation clips.

## Characters
- Skeleton: hips, spine, chest, neck, head, upper/lower arms, hands, upper/lower legs, feet (16 bones).
- Clips: idle, walk, run, jump, free-fall, parachute hang, aim/fire (upper body), knocked; cross-faded 0.15–0.25 s.
- Identification: squad-colour jersey, number on the back, ground ring (own = pulsing cyan), name tag.
- LOD: full skinned rig within 60 m; beyond that a 2-draw-call low-poly proxy; beyond 220 m a coloured marker.

## HUD hierarchy (phone, portrait and landscape)
1. Top-left minimap with zone; top-centre zone timer/stage; top-right map, bag, settings.
2. Left: squad strip (number, name, role, HP, status: online / weak / away + bot).
3. Bottom-right: action cluster (FIRE largest, then JUMP/ACTION, RUN, med kit); bottom-left joystick.
4. Mission card slides up from the bottom; chat is a floating button with unread badge.
Danger states tint the screen edges (zone damage, low HP) and are paired with text and haptics where available.
