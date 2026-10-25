# passive/: what happens between moves, and between fighters

Two Unitree G1s in MuJoCo, kept on their feet by NVIDIA's SONIC whole-body controller. Between
moves they do boxer footwork: bouncing, guard up, circling, holding range, staying off the ropes.
They throw real punches at each other, and a punch lands only if the fist actually reaches the
other body. They block, slip, duck, step back and jump. A hit makes them flinch and stagger. Enough
hits, or one big one, really knock them down: they lie there for a beat, then get up via their
knees. A KO stays down. A sparring AI can drive either fighter.

## Run it

```
npm install
npm run setup            # once: G1 model + meshes (18 MB), SONIC controller (91 MB)
npm run setup:planner    # once: SONIC kinematic planner (774 MB)
npm start                # the planner, then the dev server: the game at http://localhost:5180, this rig at /rig.html
```

`npm start` starts the planner (port 8787, or `PLANNER_PORT`), waits until it answers, then starts
the rig. A planner that's already running on that port is reused. Ctrl-C stops both. To run them
separately: `npm run planner` in one terminal and `npm run dev` in another.

Without the planner, the robots just hold a standing guard, can't throw planner punches, and
get-ups fall back to the assisted lift. `npm start` says so and starts the rig anyway.
`?ep=webgpu` runs SONIC on the GPU instead of wasm.

### Rig controls
- **Target** picks who gets hit and who defends (the elf or the knight). The other fighter throws.
- **Instant hits** are force pulses on the target, with no fist involved: jab, body shot, hook,
  uppercut, shove, leg sweep and haymaker.
- **Thrown at the target:** the other fighter steps into range and throws a planner punch. It
  lands only on contact.
- **Target defends:** block, duck, slip left or right, step back, jump.
- **Sparring AI:** each button cycles that fighter through off, boxer, brawler and turtle. With
  an AI on, a new bout starts 6 s after a KO.
- **Hitboxes** shows what the combat code sees. Head is red, torso orange, legs yellow,
  forearm guards blue. Striking limbs are white, and turn magenta while a strike can land.
- **Look** switches between the characters (elf vs knight, the default, see below), human boxers
  over the robots, the G1 robots, or the humans over a see-through robot.
- Strength scales every hit. Slow-mo runs at 0.25x.

The right side shows HP, balance (poise) and what each fighter is doing, with an event log
below it.

URL options: `?spar=boxer,brawler` starts both AIs, `?hitboxes` starts with hitboxes on,
`?look=robot` starts in robot view.

Keys:
| Key | Action |
| --- | --- |
| `1`-`7` | Instant hits |
| `J` / `L` | Left / right jab |
| `U` / `O` | Left / right hook |
| `B` / `N` | Block / duck |
| `←` / `→` | Slip left / right |
| `↓` / `↑` | Step back / jump |
| `T` | Switch target |
| `K` | KO the target |
| `R` | Reset |
| `X` | Hitboxes |
| `Space` | Pause |
| `H` | Hide the panels |

### Effects (the game screen's)
Spells, hits, blocks, dodges, knockdowns and KOs are drawn with the game screen's own effects and
bloom. `src/fx/` is a copy of `client/src/render/effects.ts` and `client/src/render/fx/` from
`vaibhav/server` (ba9d58b), changed only where the rig needs it (marked in each file's header).
`src/fx/adapter.ts` drives them from the arena:
- `cast` starts a spell's wind-up and schedules its release `hitIn` s later. A spell that fizzles
  before its hit frame (the caster is hit, falls or is KO'd) cancels what hasn't happened yet.
- `arena.projectiles()` feeds the orbs in flight. A `hit` gets the game's burst, a blocked hit its
  shield sparkle, a `whiff` dodge its afterimage.
- A knockdown or fall raises dust when the pelvis drops below 0.4 m. A KO's fairy dust comes 1.2 s
  later.
- The effects run on the sim clock, so Pause and Slow-mo hold them.

The effects are Y-up three.js. They sit under a group turned a quarter turn, and they follow
invisible per-body stand-ins posed from MuJoCo. Knobs: `BLOOM` in `src/rig/render.ts` (the game
uses strength 0.85, radius 0.55, threshold 0.62). Tone mapping and exposure stay per look
(`View.setLook`). The game uses ACES at 1.05, the character look AgX at 1.15, and the other looks
none, so bright effects there clip a little.

### Headless checks (Node, no browser)
- `npm run fight-check`: footwork, each punch, punches into a block and dodges in both hit
  modes, a knockdown with the get-up and its grace period, a KO. It prints a pass/fail line per
  expectation and exits 1 on any failure. About 50 s of fight in 15 s.
- `npm run stress -- 300 1`: 300 s of randomized abuse with seed 1. Both AIs spar while the
  test fires random actions:
  - instant hits, punches, defenses, good and broken clips
  - KOs, resets, teleporting one fighter into the other
  - NaN and huge-velocity injections, bad arguments
  - the motion source going offline or hanging
  - a synthetic clip library standing in for Kimodo clips
  - switching hit modes

  The motion source also drops, delays, hangs, throws and corrupts its answers. Invariants are
  checked every tick:
  - every stance ends within its time limit
  - only legal stance changes
  - no request is stuck
  - nothing piles up
  - hits only land on hittable fighters, never inside the grace period after a get-up
  - every fall is followed by a get-up
  - each fighter's stance events form an unbroken chain
  - listeners that punch, defend, KO or reset in response to events can't break anything
  - no errors and no unhandled rejections

  Add `--fight` to just watch the two AIs fight with a well-behaved planner.
- `npm run headless -- 300`: one robot standing, shoved at 4 s and 7 s with 300 N.

## Characters: elf vs knight (the default look)
The rig draws characters from `../characters` over the robots: the elf for the first fighter, the
knight for the second. Both are skinned meshes rigged bone-for-bone to the G1, so they follow the
simulated bodies exactly (MuJoCo body poses in, no retargeting). A hit flashes the character that
took it, and the elf's hair and belt flaps are spring-simulated. `?p1=knight&p2=elf` (any of `elf`,
`knight` for either) picks who fights; the fighters are named after them in the log.

Both ride the same robot skeleton, but the knight's armour is much bulkier. So each character sets
its fighter's guard tuck (`GUARD_TUCK` in `src/rig/main.ts`, `Fighter.guardTuck`): how far the
elbows tuck in. The elf tucks fully (1) and the knight 0.35, which leaves the elbows touching the
ribs about equally (10% and 9% of the elbow mesh, averaged over footwork). At full tuck, a third of
the knight's elbow armour pressed into his breastplate. The gloves stay at chin height for both.
`view.armClearance(i)` measures this, with `__rig` as the console handle.
`vite.config.ts` reaches `../characters/src` and the GLBs in `../characters/public` through the
`@elf` aliases, with one shared three.js. If a character can't load, the rig falls back to the
human look. `?look=human`, `?look=robot` or `?look=both` pick another look.

## Human model (optional)
The Human look uses a rigged human if `public/human/human_rigged.glb` exists. Without it, the
rig draws simple mannequins. To make it from a static human mesh (an FBX standing in an A-pose,
like the one in Sudeep's `human.zip`), run this once (needs Blender):

```
npm run rig:human -- path/to/Human.fbx public/human/human_rigged.glb
```

`scripts/rig_human.py` finds the joints from the mesh, builds 15 bones (hips, torso, head, and
thighs, shins, feet, upper arms, forearms and hands on both sides), and skins the mesh with
Blender's automatic weights. `src/rig/humanRig.ts` drives it from the robot:
- **Limbs** point along the G1 segments (shoulder to elbow, hip to knee, ...) and are twisted
  by the G1 elbow and knee hinges, so the A-pose versus robot rest pose doesn't matter.
- **Pelvis, torso, head and feet** copy the G1 body orientations.
- **Size:** the body is scaled to the robot's hip height.

The model file is gitignored because its license isn't known. Don't commit it unless that's cleared.

## How it works

| Piece | File | What it does |
| --- | --- | --- |
| Scene | `src/core/scene.ts`, `world.ts` | Two copies of SONIC's own G1 model (`p1_`, `p2_`) on a 0.5-friction floor, 5 ms physics steps, snapshots for rollback |
| SONIC | `src/core/sonic.ts`, `g1.ts` | Runs the encoder (1762 inputs to a 64-number token) and decoder (994 inputs to 29 actions) at 50 Hz, with PD control 4x per tick. Overlays add a lean and joint offsets on top of the motion. Ported from GR00T-WholeBodyControl's deploy code |
| Reference | `src/core/reference.ts` | The motion SONIC follows: 50 Hz frames on an absolute frame clock, crossfaded splices, input cleaning |
| Motion sources | `src/core/motion.ts`, `planner.ts`, `planner/server.ts` | Where motion comes from: the SONIC planner now (about 25 ms per plan on an M4 CPU), Kimodo clips later, per motion |
| Fighter | `src/core/fighter.ts` | The stance machine: footwork, punches, defenses, hit reactions, falls, get-ups, failsafes |
| Body map | `src/core/body.ts` | Hurt volumes (head, chest, pelvis, legs), forearm guards and striking limbs, sized from the G1 meshes |
| Combat | `src/core/combat.ts` | Strike windows, contact or rules hit tests, impact strength |
| Arena | `src/core/arena.ts` | Owns both fighters, the clock, damage and HP, the referee (ropes, spacing, clinches), rollback and the event stream |
| Sparring AI | `src/core/spar.ts` | Punches and answers attacks through the same calls a player or the game makes |
| Events | `src/core/events.ts` | Everything the game layer hears about |
| Instant attacks | `src/core/attacks.ts` | Force pulses at a body point, tuned on SONIC |
| Rig page | `src/rig/` | three.js view, hitbox overlay, control panel, event log |

### Posture
SONIC barely moves the G1's waist pitch. The planner's boxing stance leans the torso forward
about 8° by bending at the waist, so followed literally the robot ends up leaned back 5-12°.
`waistToHips()` (`src/core/reference.ts`) moves that waist bend into the hips: the reference
pelvis tilts forward by the waist angle, plus 3.5°, and both hips fold by the same amount, so the
torso and legs keep their pose. The planner itself still continues from its untouched motion
(`Fighter.raw`). Result: the torso leans 4-10° forward during footwork.

### Stances (`Fighter.stance`)
Every stance has a time limit (`LIMITS`). Running past it means something went wrong, and the
fighter leaves the safe way.

| Stance | What happens | Ends | Limit |
| --- | --- | --- | --- |
| `idle` | Footwork (below) | Any action, a hit, a fall | none |
| `stagger` | Just got hit. A flinch plays, the motion settles back into the guard, and SONIC catches the balance | idle after 0.25-1.15 s, longer when low on balance | 1.2 s |
| `defend` | Block, duck, slip, step back or jump | idle | 1.6 s |
| `move` | A punch (step in, then throw) or a clip from `playMove` | idle when it ends | 6 s |
| `falling` | Lost balance or knocked down. A stumble reaches out (brace pose); a knockdown buckles at the knees | down once still below 0.4 m | 3 s |
| `down` | On the floor for a beat | rising after 1.1 s | 1.6 s |
| `rising` | Staged get-up (below) | idle, then untouchable for 1 s | 22 s, then a respawn on the spot |
| `ko` | Folds at the knees for 1.2 s, then goes limp | arena reset | none |

Only the changes in `TRANSITIONS` happen. The stress test counts any other one as a bug.

**Lost balance** means one of these:
- more than 46° more tilt than the motion being followed
- more than 72° of tilt in any case
- 0.3 m lower than the motion's pelvis

This is relative to the motion, so a deliberate duck or a Kimodo dive isn't a fall.

### Footwork
About every second the fighter picks a step, always facing the opponent:
- Off the ropes when near the edge, sliding along them away from the opponent.
- Back off when closer than 1.1 m.
- Close in when farther than 1.9 m.
- Otherwise circle or bounce in place.

While the opponent is down, it keeps 1.6-2.4 m away. While the opponent attacks, it holds its
ground with the guard up. Running from a punch is a defense, so it's left to `defend`.

### Punches and hits
`throwPunch(name)` has three phases:
1. **Step in.** The fighter steps into range with `walkBoxing`: pelvis to pelvis 0.66 m for
   jabs, 0.72 m for hooks.
2. **Wait for the right moment.** It throws only when the two aren't drifting apart. A punch
   thrown while separating falls short.
3. **Throw.** It throws a planner punch (`leftJab`, `rightJab`, `leftHook`, `rightHook`) that
   lunges about 0.1 m.

The punch arms a **strike window** (`StrikeWindow`): which limb can hurt, from when to when, its
power, and a key time when the strike is meant to land.

`Combat` resolves each window once, in one of two modes:
- **`contact`** (default): every tick the striking limb's sphere is tested against the
  defender's hurt volumes, with a 5 cm margin. A hit needs contact and a limb moving at least
  1 m/s, not away from the body. The speed is the peak over the last 0.16 s, so a jab that slows
  at full reach still counts. Against a guard that holds its ground, 15 of 16 punches land; a
  miss reports how close it got.
- **`rules`:** at the key time the strike lands unless the defender evades it or is more than
  0.45 m away. It resolves at the first tick at or after the key time, even one just past the
  window's end. Use it for moves that don't aim, like Kimodo clips, where the game's rules decide.

Each tick resolves in two phases: every window that connects is found first, then the hits are
applied. Two strikes that land in the same tick both land, whichever was started first. Moves
handed in together (`playMove`, or `defend` with a clip) start on the same tick for both
fighters, two ticks after the call, even when the call comes from inside an event.

Impact strength:
- **Push:** power × zone (head 26, torso 30, legs 20 N·s) × strike speed / 4 m/s. Glancing hits
  push less.
- **Balance damage:** head 0.5, torso 0.42, legs 0.35 per power-1 hit. Balance refills at 0.2/s
  after 2 s without a hit. About 3 clean hooks, or a counter and two jabs, knock a fighter down.
- **Knockdown:** balance at 0, or one hit of 55 N·s or more. It delivers a capped 30 N·s shove,
  and the body buckles at the knees.
- **Counters** (hitting a fighter mid-attack) take 1.5x balance and do 1.25x damage.
- **Trades:** a light hit (under 15 N·s) while the hit fighter's own strike is live doesn't stop
  its strike. Anything heavier interrupts it, and the interrupted move eases into a guard at once
  instead of playing on.
- **Blocks:**
  - A block stops hits that reach the forearms, or that come from the front and aren't low.
    "From the front" means the attacker is within 110° of where the pelvis points. The boxing
    stance turns the pelvis 20-50° off the opponent, so a narrower arc let hooks past a raised guard.
  - A blocked hit pushes 0.3x, takes 0.2x balance and does 0.12x damage.
- **Dodges** are rules in both modes, and the body acts them out, measured from the line to the
  opponent. From a standstill, a slip moves the head 12-22 cm sideways and a duck drops it about
  15 cm.
  - A slip or a step back evades everything while it lasts.
  - A duck evades head shots.
  - A jump evades leg strikes.
- **Grace:** a fighter that just got up can't be hit for 1 s.

HP is 100 per fighter. Damage per N·s of push is head 0.72, torso 0.55, legs 0.35. A clean jab
takes 5-8, a hook 10-16. With `autoKO`, the default, a fighter at 0 HP is knocked out. Turn it off
to make that call in the game rules instead.

### Getting up
A staged get-up, each stage planned from the pose the robot actually reached:
1. **Onto its knees:** the planner's `kneelTwoLeg`. SONIC does this alone.
2. **Standing up:** the planner's `idle`, with invisible help carrying 15% of body weight.
3. **If a stage stalls,** it is replanned from the current pose with 30% more help each time.
   If it falls flat during the stand-up, it starts over from the knees.

The limbs follow the planner's human get-up motion, not a lift. In a sweep of 20 knockdowns
(haymakers, shoves, sweeps, uppercuts, hooks, body shots), all 20 got up without the full lift,
in 2.4-6 s (median about 4 s).

A full assisted lift is the fallback in these cases:
- there's no motion source
- two plans in a row failed
- 12 s have gone by

### The referee (`Arena`)
- **Soft ropes** 0.25 m outside the ring push the pelvis back in.
- **Pelvises closer than 0.42 m** get pushed apart.
- **Clinch:** standing within 0.45 m of each other for 1 s. It's reported, and the referee breaks
  it up.
- **Leash:** a gentle pull together when the fighters are more than 3.4 m apart.

### Nothing gets stuck
- **Motion requests are asynchronous.** Each one carries a token. An answer is used only if all
  of these hold:
  - it is still the newest request
  - nothing reset the fighter since
  - the fighter still wants it (right stance, right get-up stage)
  - it is usable: finite, joints clamped to their limits, placed near "now", not too long

  A request that never comes back is dropped after 4 s, and the fighter carries on.
- **Every call that takes outside input refuses bad input** and returns `false` (or a miss)
  instead of throwing: unknown names, NaN power or times, broken or too-long clips, unknown
  limbs, strikes that aren't a list, bad instant attacks.
- **`Arena.tick()` never throws.** Errors are counted and reported as `failsafe` events.
- **If the physics blows up** (NaN, or MuJoCo resetting itself), it rolls back to the last
  snapshot (every 0.5 s). If it blows up again within a second, both fighters are respawned.
- **A body that leaves the arena, or a get-up stuck for 22 s,** is stood back up on the spot, or
  the nearest clear spot. A KO'd body is put back down there instead and stays KO'd.
- **After a rollback,** each fighter's stance comes from the body that was restored: standing
  means idle, anything else falls and gets up again.
- **Motion drift:** SONIC follows the motion's joints and heading, not its position. After pushes,
  the motion is moved back under the body before the next footwork plan.

## Using it from the fight code
```ts
const arena = new Arena(world, policy, { names: ["P1", "P2"], hp: 100, autoKO: true });
arena.setMotion(new LayeredSource(await ClipSource.fetch("/clips"), new PlannerSource(new HttpPlanner())));
arena.reset();
arena.on((e) => { /* hit, whiff, stagger, knockdown, fall, down, getup, ko, defend, move, stance, spawn, reset, clinch, failsafe */ });
// Events arrive after the change that caused them is complete, in order. A hit comes before the
// reaction it causes (stagger, knockdown or ko); hit.stance is the stance it landed in. Listeners
// may act right away: they always see a settled fighter.
await arena.tick();                                  // every 20 ms (sim time = arena.time)

const [p1, p2] = arena.fighters;
p1.throwPunch("punch.leftHook", 1.2);                // steps in, throws, lands on contact
p2.defend("block");                                  // or duck, dodge.left, dodge.right, dodge.back, jump
p2.defend("block", 1.0, { qpos: kimodoRows, fps: 30 });  // the same defense acted out by a clip
p1.playMove(kimodoRows, 30, [strikeFromHit(motion.hit, 30, power, "spinning kick")!], "spinning kick");
arena.hitInstant(1, ATTACKS[6], 1);                  // a force pulse with no fist (tests, wild moves)
p2.knockOut();
arena.combat.mode = "rules";                         // when the rules, not contact, decide hits
arena.setBrain(1, new Sparrer(p2, STYLES.boxer, 7)); // or your own Brain: think(t, dt)
p1.stance; p1.poise; arena.hp; p1.isBlocking(); p1.isCommitted(); p1.punchPhase();
```
- `playMove` re-bases the clip onto the fighter, facing the opponent, and goes back to footwork
  when it ends.
- `rowsFromJson({fps, joint_pos, root_pos, root_quat})` turns the proposed server JSON into rows.

Every action returns `false` when it isn't allowed right now:
- a punch only starts from idle, against a standing opponent
- a defense works from idle, while defending, or to cancel a punch that is still stepping in
- a clip plays from idle or while defending

### Kimodo motions
The fighter asks for motions by name (`MotionName`):
- `guard`
- `step`
- `getup.knees` and `getup.stand`
- the four punches
- `dodge.left`, `dodge.right` and `dodge.back`
- `block`, `duck` and `jump`

`LayeredSource` tries clips first and falls back to the planner, so Kimodo clips can replace
planner motions one at a time. Put JSON clips in `public/clips/`, with an index:

```
public/clips/index.json    {"block": ["block_a.json"], "getup.knees": ["getup_face_down.json", "getup_face_up.json"], ...}
public/clips/block_a.json  {"fps": 30, "qpos": [[36 values], ...], "strikes": [...optional...]}
```

- **Placement:** clips are turned to face the opponent and moved to where the fighter stands.
- **Get-up clips** keep the heading the body landed with. The variant whose first frame lies the
  way the body lies (face up, face down, on a side) is picked automatically. They are spliced
  with a longer crossfade.
- **One-clip get-ups:** a clip that goes all the way to standing can sit under `getup.knees`
  alone. Standing up from any stage counts as up.
- **Step clips:** `step` picks `step.forward`, `step.back`, `step.left` or `step.right` by
  direction. Footwork lets a step clip finish before asking for the next.
- **Per character:** `<key>.<character>` (`guard.elf`, `step.forward.knight`) wins for a fighter
  whose `character` matches; the rig sets it from `?p1`/`?p2`.
- **The everyday library:** `public/clips-everyday/` (the rig loads it after `public/clips/`) holds
  Kimodo clips picked by physics scores; how they're made: `tools/kimodo/README.md`.

### Spells and other server moves
A spell is data, not code: a spec (`MoveSpec` in `src/core/spells.ts`) plus its Kimodo clip.
`fighter.cast(spec, qpos, fps)` plays it. Its `kind` decides how the hit lands, by the same rules as
the game screen's stub sim:

| Kind | How it lands | Beaten by |
| --- | --- | --- |
| `melee` | Steps in to 0.75 m (counting the clip's own lunge), then lands if the pelvises are within 1 m at the hit frame. Clean if the hit joint is within 0.3 m of the head or chest | a dodge (at the zone it reaches), a block |
| `projectile` | Leaves the hit joint at the hit frame, flies at 6 m/s toward the chest, homing until the defender dodges | a slip or step back, a block, Earth Wall |
| `strike` | Called down at the hit frame, lands 0.6 s later if the defender is still within 0.5 m of where they stood when the move started | stepping away, a dodge when it lands, a block |
| `shockwave` | Hits a defender within 1.5 m at the hit frame | a jump, a block |
| `defend` | The caster blocks for the whole move (Earth Wall) | nothing to beat |

- **Damage:** by kind and power 1/2/3: melee 8/12/16, projectile 6/10/14, strike 7/11/15,
  shockwave 5/8/11. A clean hit does 1.25x, a blocked one 0.3x.
- **Knockdown:** any hit of 16 or more, or a clean power-3 hit. The push is sized from the damage.
- **Interruptions:** a spell whose caster is hit or falls before its hit frame fizzles. A
  projectile already in flight, or a strike already called, still arrives.
- **Events:**
  - `release` fires at the hit frame (draw the effect: the orb leaves the hands, the bolt is
    called, the wall rises).
  - Hits carry `how`, `spellType`, `effect` and `clean`.
  - A miss is a `whiff` with reason `dodged` or `out of range`.
- **Projectiles:** `arena.projectiles()` lists the ones in flight for drawing (the game's
  `Sim.projectiles()`).
- **Library entries:** `specFromLibrary(entry)` turns a `spells.json` entry (`name, kind, type,
  effect, power, hit_joint, hit_frame, file`) into a spec. Vaibhav's four are in `public/clips-kimodo/`.
- **Deep bends:** clips that bend far over (Earth Wall slams the ground) are safe to play. The
  posture fix never tilts the pelvis past 50°, and losing balance is judged against the clip's own
  lean.

**Checking a library of spells:**
```
npm run spell-batch -- path/to/spells.json --runs 3 --out report.json
```
It plays every spell on the robots, headless, against a standing opponent, and prints one line
per spell:
- `stability`: the share of runs still upright 1 s after the move. Runs 2..N add a small seeded
  shove during the move.
- the caster's worst tilt
- whether it lands, and for how much
- anything that tips its own caster over or can't land

About 4 s per spell per run. `npm run spell-check` checks Vaibhav's four in detail: each one
undefended, against a slip, a block and Earth Wall, and two fireballs crossing.

### Tuning knobs
| Knob | What it sets |
| --- | --- |
| `TUNE` (`fighter.ts`) | Ranges, fall thresholds, get-up help, grace, timeouts, the guard tuck, the block arc |
| `Fighter.guardTuck` | How far this fighter tucks its elbows (per character: elf 1, knight 0.35) |
| `LIMITS` (`fighter.ts`) | Stance time limits |
| `ZONE_IMPULSE`, `ZONE_POISE`, `MIN_HIT_SPEED` (`combat.ts`) | Hit strength |
| `DAMAGE`, `REFEREE` (`arena.ts`) | HP damage and the referee |
| `STYLES` (`spar.ts`) | AI personalities |
| `PUNCH_LUNGE` (`motion.ts`) | How far a planner punch steps in |

## Not done yet
- The stand-up still gets light help (15% of body weight). A Kimodo get-up clip may let SONIC
  do it alone.
- `playMove` and the clip library are tested with a synthetic kick, not real Kimodo clips yet.
- Two robots tangled on the floor are only separated by the referee's push. A clinch while
  standing is broken up.

## Sources and licenses
G1 model and meshes are from NVlabs/GR00T-WholeBodyControl `gear_sonic_deploy/g1` (Unitree, BSD-3).
SONIC weights are from huggingface.co/nvidia/GEAR-SONIC (NVIDIA Open Model License). Controller
constants and observation layout are ported from the same repo's Apache-2.0 deploy code. Downloads
are pinned in `scripts/fetch-assets.mjs`.
