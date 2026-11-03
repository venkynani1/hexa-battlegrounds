# Design audit — Apple design, mobile-native and design-engineering review

Reviewed against Emil Kowalski's skills ([github.com/emilkowalski/skills](https://github.com/emilkowalski/skills), MIT):
`apple-design` (response, direct manipulation, interruptibility, materials, reduced motion, typography, the eight principles),
`mobile-native` (viewport, tap highlight, hover on touch, 100vh, safe areas, input zoom, tap delay) and
`emil-design-eng` (easing, durations, press feedback, no `transition: all`, never `scale(0)`).

Scope: phone player app (lobby, shuttle, world HUD, missions), projector, host console. Checked in Chromium at 390 × 844 with touch emulation.

## Fixed in this release

| Before | After | Why |
|---|---|---|
| Map was a flat 2D SVG with tap-to-hop between graph nodes | Full-screen 3D campus (three.js) with a floating joystick that moves the squad 1:1 under the thumb, and tap-to-travel on location rings | apple-design §1–2: direct manipulation and continuous feedback; the squad moves on screen on the same frame as the thumb, the server only caps speed |
| Joystick appeared at a fixed spot | Floating joystick: it appears wherever the thumb lands in the bottom-left zone, with pointer capture | Respects the grab point (§2); works for every hand size and grip |
| Auto-run could not be interrupted | Grabbing the joystick during an auto-run takes over immediately | §3 interruptibility: never lock out input during a transition |
| Movement had no physical cost | Travel time = distance ÷ speed, enforced server-side; idle never banks a teleport | Spatial consistency and fairness; the world behaves like a place |
| `.btn:hover` and table-row hover applied on touch screens (sticky hover after a tap) | Hover gated by `@media (hover: hover) and (pointer: fine)` | mobile-native: hover states stick on touch devices |
| No `touch-action` on controls; long-press selected button text | `touch-action: manipulation` on all controls; `user-select: none` + `-webkit-touch-callout: none` on buttons, tabs, HUD actions; `touch-action: none` on the joystick, 3D canvas and Fruit Slash | Removes the double-tap-zoom delay and accidental selection; gestures never scroll the page |
| `:active` scale 0.98 on buttons, none on tabs | `scale(0.97)` on buttons, `0.96` on tabs, `0.94` on round HUD actions | emil-design-eng: press feedback on pointer-down, a perceptible but subtle squash |
| Small buttons at 28–34 px tall; round HUD buttons 40 px | Minimum 32 px (xs), 40 px (sm), 44 px for every HUD button | Comfortable touch targets (44 pt guideline) |
| Viewport without `interactive-widget` | `interactive-widget=resizes-content`, plus `apple-mobile-web-app-capable` / status-bar meta | The keyboard resizes the layout instead of covering answer boxes; full-screen home-screen launch |
| Top bar and toasts ignored the notch | `env(safe-area-inset-top/left/right)` on the top bar, toasts and HUD corners | Content never sits under the notch or rounded corners |
| Sheets and modals used `85vh` / `90vh` | `dvh` with `vh` fallback; `overscroll-behavior: contain` on sheets and modals | The 100vh bug on mobile browsers; scrolling a sheet never scrolls the page behind it |
| Sheet entered with a 40 px fade-slide, `ease-out`, 200 ms | Slides from the bottom edge with the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` in 280 ms; fades instead under reduced motion | Enter along the path it came from (§7); drawer easing feels physical |
| Mixed easing (`ease-out`, `linear`) on UI transitions | Tokens `--ease-out`, `--ease-in-out`, `--ease-drawer`; HP bar and leaderboard at 300 ms ease-out; kill feed 220 ms | emil-design-eng: UI motion under 300 ms with a strong ease-out |
| Translucent HUD with no fallback | `prefers-reduced-transparency: reduce` turns the HUD, top bar, tab bar and panels solid; `prefers-contrast: more` strengthens borders and muted text | §12 and §14: materials must stay legible for everyone |
| Pulsing mission card and bobbing 3D figures always animated | Disabled under reduced motion (the 3D world also stops walk cycles, zone wall scrolling and camera drift) | §14: reduced motion means gentler, not missing, feedback |
| Numbers (timers, points, zone countdown) used proportional digits | `font-variant-numeric: tabular-nums` on timers, stats, chips and HUD readouts | Counting numbers no longer jitter sideways |
| Very large display text (`.mega`) used 0.06 em tracking | 0.01 em on large display text; small all-caps labels keep their positive tracking | §15: tracking is size-specific |
| The bus lobby showed seat cards only | A 3D bus with each player seated (name tag, role colour, “you” ring), plus a compact seat list for screen readers | Familiarity and delight (§16): the squad literally sees itself on the bus |
| Zone collapse teleported squads | Squads keep control: an on-screen arrow points to the safe circle, HP drains while outside | Agency (§16.2): never take control away from the player |
| Alerts competed with the kill feed | Kill feed moved to the left under the squad card; centre alerts reserved for zone/red-zone danger | Grouping & hierarchy: the most urgent thing is the most obvious |

## Kept on purpose

| Item | Reason |
|---|---|
| Dark theme only (`color-scheme: dark`, one `theme-color`) | The game is a night-ops esports experience shown on a projector; a light theme would break the brand. |
| Rajdhani all-caps headings with positive tracking | Uppercase labels need positive tracking for legibility; the brand relies on them. |
| Sound + vibration on game events | Fired on the same state change as the visual (§13 harmony); reserved for meaningful events (mission start, hit, airdrop, zone). Sound is opt-in and has a volume control. |
| CSS keyframes for non-gesture effects (pulse, ticker, confetti) | They are not grabbable, so springs add nothing; all respect reduced motion. |

## Backlog (not done yet)

- Momentum projection on the joystick release (coast a few pixels) — deliberately off: squads should stop exactly where the captain lets go.
- Spring-based sheet drag-to-dismiss (Vaul-style) — sheets currently close by tap or backdrop.
- Test on real low-end Android hardware with the 3D world; the scene caps pixel ratio at 1.5 on ≤4-core devices and pauses rendering in background tabs.
