# The fight screen

The big screen of the three devices (the two players' phones are the others). It runs the real sim
from `src/core/` (two G1s on SONIC in MuJoCo, referee, combat, spells) and draws it as the elf and
the knight in a dusk meadow, with a live camera, spell effects, the HUD and best-of-3 rounds.

## Run it
```
npm start        # planner + dev server, as for the rig
```
Open http://localhost:5180: the fight screen is the default page (the rig is at `/rig.html`; `/screen.html` redirects here). Without the planner the fighters hold a
standing guard (see README).

URL options:
- `?demo` plays one spell of each kind in turn, with both AIs off: Fireball, Thunder Call, a
  channelled brand-new spell, Spiral Sphere, Earth Wall, Fireball into the wall.
- `?ai=0` starts with both AIs off; `?spar=boxer,brawler` picks their styles.
- `?fx=game` draws spells and hits with the game's spell effects (`src/fx`, one look per `effect` tag)
  instead of this screen's softer ones.
- `?room`, `?fill=ai`, `?server=`: the three devices (below).
- `?koAt=8` knocks the knight out 8 s into every round, to see the KO and victory shots.
- `?ep=webgpu` runs SONIC on the GPU.

## The three devices
Two phones and this screen, all through the team's game server (FastAPI on the GPU box, `server/` and
`phone/` on `vaibhav/server`). Venue Wi-Fi often blocks device-to-device traffic, so nothing talks
directly.

```
 phone 1 ─┐  join, tap (room WebSocket)                         ┌─> join, leave, tap, play, charge, ready, narrate
          ├─ shout (POST /voice: speech to text, then match) ──> │   game server ──────────────────> screen
 phone 2 ─┘                                                      └─< state 10/s, event <────────── (physics, view)
```

- **Screen:** open `/?room` (a fresh code) or `/?room=ABCD`. It joins the room as the game. The
  console prints the phones' join link, `<server>/phone/?room=ABCD`, which is also in `__screen.room`.
  The fighters stand in the ring until both seats are taken. Then a best-of-3 match starts, and when it
  ends, a rematch follows while both phones are still there.
- **Options:**
  - `?fill=ai` lets the AI play an empty seat, so one phone can play the AI.
  - `?server=URL` picks another game server. The default is `VITE_GAME_SERVER`, else the team's GPU
    server.
- **Phones:** the phone page the game server already serves, at `<server>/phone/?room=ABCD`. A phone
  takes a seat (seat 1 is Sylvara, seat 2 Sir Aldric), shouts spells (hold to talk, or typed) and taps
  block, dodge left, dodge right and jump.
- **The server** turns a shout into a move:
  - a library move: `play`, with its motion inline;
  - something new: `charge` now, `ready` with the new motion once Kimodo has made it (a second or two).

  It speaks narrator lines from the screen's events.

What the screen does with each message (`src/screen/link.ts`, "the room" in `main.ts`):

| Message | The screen |
| --- | --- |
| `join` / `leave` | Seats the phone. Its fighter's AI goes off; with `?fill=ai` the AI takes over again on `leave`. |
| `tap` | The fighter defends: block, dodge left or right, or jump (during a fight). |
| `play` | The move joins its fighter's queue (two deep) and is cast as soon as the fighter is free. Once the fighter's own move has ended, the move at the head gets 2.5 s to start, or it fizzles and the phones are told. A full queue drops its oldest library move (fizzle "replaced"), never a live wildcard. Motion joints are mapped by name if the server ever names them differently. |
| `charge` | The fighter glows and the player's words show until `ready` arrives (or for 15 s at most). |
| `ready` | Like `play`; a live wildcard is flagged NEW on screen. |
| `narrate` | Kept in `__screen.room.narration` and passed to `__screen.onNarrate` (not spoken yet). |

What it sends:
- **State, 10 times a second:**
  - `round`, `timer` (seconds left), `wins {1, 2}`, `phase`;
  - `players {1, 2: {hp, energy, cooldowns, status, poise}}`;
  - `seats {1, 2: {nickname, character, connected}}`.
- **Events:**
  - `hit`, `blocked`, `dodged`, `down`, `ko`, `round`, `round_start` and `match_end`, as in
    contract/ws.md;
  - plus `cast {player, move, new}` (a shouted move started playing) and `fizzle {player, move, why}`;
  - `hit` also carries `defender` and `move`.

  `phase`, `poise`, `connected`, `cast`, `fizzle` and the extra `hit` fields are additions to the
  contract. The phone page ignores what it doesn't know.

### Testing it without people
- `node scripts/phone-bot.ts --room ABCD` is a pretend phone. It takes a seat, shouts library moves every
  ~2.5 s through `POST /match` (the server treats it exactly like a voice shout, minus speech to text),
  sometimes defends when the other side casts, and logs what comes back.
- `node scripts/full-game.ts --screen http://localhost:5180/` runs a whole match through all
  three devices: the real screen in headless Chrome, two bots, the real game server. It checks that the
  match ends with a winner, every round that starts ends, shouts get played or fizzle with a reason,
  live wildcards channel and then play, state keeps coming, taps become defenses, and the page logs no
  errors. Options:
  - `--wild N` adds live wildcards.
  - `--fill` plays one bot against the AI.
  - `--chaos` drops the screen's connection mid-round, and then a phone's for 3 s. The match must carry
    on, and the phone must get its seat back.
  - `--params fx=game` runs the screen with the game's spell effects.
  - `--shots DIR` saves screenshots.

  Wildcards the bots invented are retired from the library afterwards.

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
| `index.html`, `src/screen/main.ts` | boot (same as the rig), rounds, hit-stop and slow motion, drivers, hooks |
| `src/screen/stage.ts` | renderer, characters over the robots, the light rig that follows the fight, bloom |
| `src/screen/camera.ts` | the camera director (below) |
| `src/screen/fx.ts` | spell effects by type x kind, hit sparks, flashes, dust and stone chips on floor slams |
| `src/screen/hud.ts`, `hud.css` | plates, HP with a damage trail, balance, timer, pips, callouts, damage numbers, banners |
| `src/screen/portrait.ts` | the character icons, rendered from the real models at load |
| `src/screen/arena.ts` | the setting: a dusk meadow (below) |
| `src/screen/link.ts` | the room connection to the game server, and server moves and motions turned into what the sim plays |
| `scripts/phone-bot.ts`, `scripts/full-game.ts` | a pretend phone, and a whole match through all three devices (above) |

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
- **Some data the server sends isn't used yet.**
  - A move's `loudness` and the `signature` bonus (1.5x for your own Forge move) don't change damage;
    the sim's damage rules don't take them yet.
  - The phones get `energy: 100` and no cooldowns, because the sim has neither.
- **Not on screen yet (UI comes later).**
  - Narrator lines aren't spoken.
  - The join link is only in the console and in `__screen.room`; the lobby banner shows the room code.
  - With the fighters close together, both spell callouts can stack, and the K.O. banner can cover
    them.
- **The tests use the team's live server.** A test match bumps the usage counts of the library moves
  the bots shout, which feed the leaderboard. Each wildcard costs one Claude call and a Kimodo
  generation; the bots' wildcards are retired afterwards.
- **A double K.O. can happen.** A move already on its way can still land after the round has ended. It
  doesn't change who won the round.
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
- **A join screen.** Show the QR code and the join link in the lobby, and the players' nicknames on the
  plates.
- **Speak the narrator's lines** (`__screen.onNarrate`), with speech synthesis or audio from the server.
- **Loudness and signature in the damage rules** (the sim's side): the server already sends both with
  every move.
- **A local game server for offline tests.** The tests use the team's live server; a local mock would
  make them free and repeatable without touching the shared library's counts.
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
