# Visual upgrade: implementation report (branch `visual-upgrade`)

Status: **first production pass done and verified in rendered screenshots; not every goal in the brief is
complete.** The "Not done yet" section below lists what remains. Gameplay, network protocol and database are
untouched: no file under `supabase/`, `api/`, `src/lib/`, `scripts/`, `tests/` or `content/` changed.

## Phase A: audit (baseline = live version e297e2b)
| Area | Finding |
|---|---|
| Renderer | WebGLRenderer with ACES tone mapping and PCF soft shadows, but no post-processing, no quality presets, no adaptive resolution. "Low end" was guessed only from CPU cores (≤ 4). |
| Reflections | Indoor `RoomEnvironment` at 0.16 intensity, so glass could not reflect the sky; facade glass was painted into a colour map with one roughness value. |
| Characters | Captain built from 12 separate capsule meshes rotated by hand (sin-wave legs and arms); free-fall and parachute poses set by overwriting arm rotations. No skeleton, no blending, no LOD. |
| VFX | Each shot allocated 2–3 new geometries and materials (tracer, flash, spark). Geometries were disposed, **materials leaked**. Geometry count rose during a match (e.g. 371 → 421 on phone). |
| Other renderers | Boarding and flight scenes rendered at up to 2× DPR with MSAA on every device. |
| HUD | Already battle-royale structured (minimap, squad strip, compass, kill feed, hurt arc, action cluster). Needed finish, not a rebuild. |
| Metrics (headless, software renderer) | Draw calls 80–555, triangles 79k–110k depending on view and moment. Software-rendered FPS is not representative of phones. |

## Phase B: art direction
`docs/VISUAL_SPEC.md`: "Siruseri Ops, golden-hour esports", with a readability-first palette, a glow-means-look-here rule,
preset table, HUD hierarchy, character spec, and the asset policy (all original, generated in code).

## Phase C: what was built
| System | Files | What it does |
|---|---|---|
| Quality presets | `src/three/quality.ts` | Low / Balanced / High chosen from GPU name, cores, memory, pointer type; Settings → Graphics and Show frame rate; frame-time monitor; adaptive render scale on p90 frame time (−8% / +5% steps, ≥ 0.75 effective px); disposal helper. Flight and boarding scenes follow the preset. |
| Post-processing | `world.ts` | HDR (half-float) composer, selective bloom by threshold 1.15, so only emissive effects glow (VFX, zone base, flashes), not lit walls. Bloom buffer 40% (Balanced) / 50% (High); off on Low. |
| Reflections | `world.ts` | Baked outdoor sky/sun/ground environment (PMREM). Facades now have a matching roughness/metalness map: glass is smooth and reflective, walls are matte. Lit offices, ceiling strips and pane sheen. |
| Characters | `src/three/rig.ts`, `people.ts` | Original skinned character: 17 bones, shared geometry (2 materials), squad-colour jersey, number plate, backpack, rifle. Clips: idle, walk, run, jump, free-fall, parachute, knocked, cross-faded 0.2–0.35 s; stride speed matched to ground speed; upper-body aim + recoil layer; rifle low-ready / shouldered / stowed in the air. LOD: low-poly proxy beyond 70 m with no skinning work. |
| VFX | `src/three/vfx.ts` | Pooled tracers and muzzle flashes (no per-shot allocation), two particle layers (additive glow, soft dust/smoke) at one draw call each: impact sparks, miss puffs, landing dust ring, loot sparkle in tier colour, knocked/revived pulse, airdrop signal smoke. Density follows the preset; reduced motion caps it. |
| Zone | `vfx.ts` | Animated energy-wall shader: scan bands, cell shimmer, glowing base; ~6 m cells at any radius. |
| Trees | `world.ts` | Height-shaded crowns (fake AO); decor density per preset. |
| HUD | `styles.css`, `PlayWorld.tsx` | Segmented health bar with a red damage trail, low-health vignette (pulses below 15 HP), consistent glass panels, ringed action buttons with press feedback. |
| Cinematic moments | `world.ts`, `Celebrate.tsx`, `Screen.tsx` | Camera shake on your own landing and when you take damage; winner reveal with light rays, trophy entrance and confetti in the winning squad's colour (phones), rays added to the projector reveal. All off with reduced motion. |
| Tooling | `src/dev/Lab.tsx` | Dev-only `/lab` page (not in production builds) to render every motion, effect and the zone wall for visual checks. |

## Phases D–E: verification
- `npm test`: **95 / 95 pass** (engine, world, battle royale, online, automatic maps, disconnects).
- TypeScript clean; production build succeeds.
- Multiplayer regression on the upgraded branch, through the same API function the live sites use:
  - 150 online players with automatic maps: 3 maps launched by themselves, 0 left in a lobby, 0 errors, p95 28 ms;
  - 120 in-person players: 0 errors, p95 20 ms.
- Rendered checks (headless Chromium, software WebGL): phone portrait, landscape and desktop over a demo match on
  Low (auto-detected), a desktop run on High, a phone on Balanced with the frame-rate readout, Settings, and the
  `/lab` renders of all motions, effects and the zone wall. Issues these checks found were fixed: rifle pointing up,
  a visor band that read as a black bar, over-strong bloom, smoke that glowed, a mound-like landing puff,
  pixelation from an over-eager resolution scaler, and the scaler ignoring frames slower than 250 ms.

### Metrics (same demo setup, headless software renderer)
| View | Draw calls (before → after) | Triangles | Geometries during match |
|---|---|---|---|
| Phone, auto preset | 80–328 → 57–91 | 79–100k → 81–85k | 371→421 before, 349→365 after |
| Landscape | 163–314 → 313–489 | 82–88k → 84–96k | 476→505 before, 431→500 after |
| Desktop | 298–555 → 135–342 | 84–109k → 81–86k | 467→496 before, 458→477 after |
| Desktop, High preset | – → 171–196 | – → 536–554k (shadow pass included) | – |

Each capture is a different moment of a live bot match, so ranges overlap; they show no regression in draw calls.
**Frame rates from this sandbox's software renderer (1–9 fps for both versions) say nothing about phones.**
Real-device numbers still need measuring (see below).

## Not done yet (honest gap list against the brief)
1. **Campus geometry rebuild**: interiors, lifts, crates, vehicles, roads and landscaping are the same models; only
   facades/glass, trees and the zone wall changed. No new architecture detail or instanced landscaping set yet.
2. **Cinematic sequences**: the boarding/plane flyover and jump keep the existing scenes; no new camera rails for
   the plane, deployment or airdrop arrival. Shake and the winner reveal are new.
3. **Environmental audio**: unchanged (existing synthesized effects). No ambient campus soundscape or positional audio yet.
4. **Asset pipeline**: textures are generated canvases, not an atlas or KTX2/Basis compressed set; no glTF assets.
5. **Buildings LOD and instancing** beyond the existing batching; draw calls in landscape can still reach ~490.
6. **Real-device testing**: not possible from this sandbox. Needs a midrange Android (e.g. Snapdragon 6-series or
   Mali-G57/G68), an iPhone and a Teams laptop, each with Settings → Show frame rate on.
7. **Deployment**: the branch is committed locally. GitHub sign-in for this session expired, so it could not be
   pushed or given a Vercel preview yet. The live sites are unchanged.
