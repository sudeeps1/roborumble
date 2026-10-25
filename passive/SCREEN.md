# The fight screen

The big screen of the three devices (the two players' phones are the others). It runs the real sim
from `src/core/` (two G1s on SONIC in MuJoCo, referee, combat, spells) and draws it as the elf and
the knight in a dusk meadow, with a live camera, spell effects, the HUD and best-of-3 rounds.

## Run it
```
npm start        # planner + dev server, as for the rig
```
Open http://localhost:5180/screen.html (the rig stays at `/`). Without the planner the fighters hold a
standing guard (see README).

URL options:
- `?demo` plays one spell of each kind in turn, with both AIs off: Fireball, Thunder Call, a
  channelled brand-new spell, Spiral Sphere, Earth Wall, Fireball into the wall.
- `?ai=0` starts with both AIs off; `?spar=boxer,brawler` picks their styles.
- `?koAt=8` knocks the knight out 8 s into every round, to see the KO and victory shots.
- `?ep=webgpu` runs SONIC on the GPU.

## Keys
| Key | P1 (Sylvara, elf) | P2 (Sir Aldric, knight) |
| --- | --- | --- |
| Spells (the spellbook's 1st-4th) | Q W E R | U I O P |
| Jab / hook | A / S | J / K |
| Block / slip | D / F | L / ; |
| A brand-new spell after "channeling" (what a phone does) | Z | M |

`1` / `2` turns each AI on or off (pressing a fighter's keys turns its AI off). `Enter` new match,
`Space` pause, `H` hide the HUD.

## Hooks for the phones and the round flow
`window.__screen` (`src/screen/main.ts`):
```ts
__screen.channel(1, "summon the crab king", "lightning"); // words on screen + glow while the move generates
__screen.channel(1, null);                                 // done
__screen.cast(1, spec, qposRows, 30, /* isNew */ true);    // spec: MoveSpec (spells.ts), rows: Kimodo qpos
__screen.defend(2, "dodge.left"); __screen.punch(2, "punch.leftJab");
__screen.ai(1, false); __screen.newMatch();
__screen.pause(true);                                      // freeze the fight (the camera keeps breathing)
```
The HUD and the effects only use a spell's data (name, type, kind, power, new), so any number of spells
work with no art per spell.

## How it's built
| File | What |
| --- | --- |
| `screen.html`, `src/screen/main.ts` | boot (same as the rig), rounds, hit-stop and slow motion, drivers, hooks |
| `src/screen/stage.ts` | renderer, characters over the robots, the light rig that follows the fight, bloom |
| `src/screen/camera.ts` | the camera director (below) |
| `src/screen/fx.ts` | spell effects by type x kind, hit sparks, flashes, dust and stone chips on floor slams |
| `src/screen/hud.ts`, `hud.css` | plates, HP with a damage trail, balance, timer, pips, callouts, damage numbers, banners |
| `src/screen/portrait.ts` | the character icons, rendered from the real models at load |
| `src/screen/arena.ts` | the setting: a dusk meadow (below) |

### The camera
- Stays square to the fighters (lazily, so it swings, never snaps) and frames both plus anything
  flying between them. It leans back toward the arena's best side when they turn far from it.
- Never fully still: a slow handheld drift.
- Trauma shake (amount² of smooth noise) from hits, knockdowns, bodies slamming into the floor, strikes
  and walls. Recoil kicks along a hit's push, zoom punches into big hits.
- Hit-stop: the sim freezes 45-175 ms on a hit (longer for counters, clean hits, knockdowns) while the
  camera keeps shaking. A KO freezes, flashes, then plays in slow motion while the camera drops low and
  close onto the fallen fighter. The winner gets a slow push-in at the end of the match.
- Intro: a crane down from high and wide each round.

### The setting
A meadow at dusk with no hard lines:
- A soft sandy pad, solid out to the ropes (`REFEREE.rope`), that fades into the grass by 4.3 m. It
  marks the ring with no line; a thrown body lands on the grass.
- A loose ring of round trees 24-34 m out, all the way round, since the camera circles with the
  fighters.
- Exponential fog: clear around the fight, hazy by the trees, gone by the horizon. The sky dome's horizon
  is exactly the fog colour, so the ground melts into the sky without a seam.
- Light: a lavender sky fill, a green bounce, a low warm sun, soft-edged shadows.

Compatible with the physics: the ground is flat at z = 0 (the physics floor) everywhere a body or the
camera can be; nothing but the floor stands within 20 m. Numbers come from `src/core/arena.ts`, not copies.

## Look
Kept simple on purpose:
- **Setting:** a soft dusk meadow.
- **Light:** gentle, with lower exposure and bloom than the rig.
- **Effects:** no hard lines. Rings are soft gradients, the strike is a soft beam, Earth Wall is a
  rounded stone, debris is smooth pebbles. Spell lights tint the fighters and never blow them out.
- **HUD:** storybook-soft. Cream and gold trim, coral vs periwinkle pill bars, a moon clock, star pips,
  Cinzel for names and spells, Fredoka for numbers, and a soft shade behind the top band.

## Shortcuts taken
- **Fonts come from Google Fonts at runtime.** Offline at the venue they fall back to Georgia and
  Trebuchet. Put the woff2 files in `public/fonts/` before the demo.
- **The strike warning ring is approximate.** It sits where the defender stands at release, not on the
  exact spot the sim aimed at when the cast started (the sim doesn't report that spot).
- **Projectile visuals are matched by position.** Each frame they are paired with `arena.projectiles()`
  by nearest position, at most 6 at once.
- **Callouts look spells up by name.** Two spells with the same name would show the first one's type.
- **Z / M demo a brand-new spell.** They play Thunder Call's clip under a long made-up name, to show the
  NEW tag and the long-name layout.
- **My own rules.** 60 s rounds and best of 3; change them in `RULES` in `main.ts`.
- **Testing was limited.** I checked it with headless-Chrome captures of the live sim and the type
  check:
  - The captures cover the intro, fights, every spell kind via `?demo`, KO and victory. Exact moments
    were captured by pausing on sim events.
  - Two independent reviews looked for hard lines and harsh light.
  - Camera motion over 20 s of AI fight (5 hits and a knockdown), after the final shake tuning:
    - median rotation 2.6 °/s
    - p99 18 °/s, max 40 °/s
    - fewer than 1 frame in 1000 above 30 °/s
    - zoom punches to 17% tighter

    Before the tuning, the same fight peaked at 120 °/s.

  Frame rate in the browser pane, with the rig also running on this laptop:
  - A small window: a steady 60 fps.
  - 1920x1080 at 1.5x pixel density: 45 fps (p95 frame 33 ms). The physics kept up both times (0.97x
    real time), so the cost is pixels.
  - Screens 1600 px and wider now render at 1x density. In headless Chrome (Metal) at 1920x1080 that runs
    at 57-58 fps, with the physics keeping up. The browser pane itself was hidden, so check it on the real
    TV.
- **No sound.**
- **The mockups and test tools are not committed.** The three mockup directions in `mockups/` were
  stopped after their first build (no judging or refinement), because you picked this look instead. The
  headless capture script (`mockups/capture.mjs`) is there too.

## What can still improve
- **Phones.** Wire them to `__screen.channel` / `cast` / `defend` from the room socket.
- **Spell effects.** Each kind is one generic shape (orb, column, ring, wall, hand glow). Type-specific
  shapes (ice shards, fire swirl, a jagged bolt) would add flavour with no per-spell art.
- **The game's spell effects.** The spells session put the game's spell effects in `src/fx/` (GameFx,
  driven by Arena events, one look per `effect` tag: ember_orb, wisp_bolt, earth_wall, spiral_orb...).
  The rig uses them; `src/rig/render.ts` shows the wiring. This screen keeps its own `fx.ts` for now,
  which ignores the `effect` tag and is tuned soft (no hard lines, no harsh light). Switching to GameFx
  would mean re-checking it for harsh light. The new `cast` event (a spell's clip starts) could also
  wind effects up before `release`.
- **KO camera.** It swings away from the winner but doesn't test for occlusion. A winner standing right
  over the body can still overlap it.
- **HUD writes.** It sets bar widths every frame; diffing would save a little.
