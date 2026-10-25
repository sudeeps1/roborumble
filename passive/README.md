# passive/: what happens between moves

Two Unitree G1s in MuJoCo, kept on their feet by NVIDIA's SONIC whole-body controller. Between
moves they do boxer footwork: bouncing, guard up, circling, holding range, staying in the ring.
Hit them and they stagger. Hit them hard and they really fall, lie there for a beat, then get up
via their knees. A KO stays down.

## Run it

```
npm install
npm run setup            # G1 model + meshes (18 MB), SONIC controller (91 MB)
npm run setup:planner    # SONIC kinematic planner (774 MB), once
npm run planner          # terminal 1: planner service on :8787
npm run dev              # terminal 2: open http://localhost:5180
```

Without the planner running, the robots just hold a standing guard, and get-ups fall back to the
assisted lift. `?ep=webgpu` runs SONIC on the GPU instead of wasm.

Rig controls: pick a target, then click an attack (an instant hit) or a thrown punch (the other
robot steps in and really throws it). **Look** switches between human boxers drawn over the
robots (the default), the G1 robots, or both, with the robot see-through. `?look=robot` starts
in robot view. Keys `1`-`7` throw attacks, `K` knocks out,
`R` resets, `Space` pauses, `H` hides the panels. Strength scales every attack. Slow-mo is 0.25x.

Headless checks (Node, no browser):
- `npm run headless -- 300`: one robot standing, shoved at 4 s and 7 s with 300 N.
- `node scripts/fight-check.ts Haymaker`: footwork, a haymaker, the fall and the get-up, printed as a log.

## How it works

| Piece | File | What it does |
| --- | --- | --- |
| Scene | `src/core/scene.ts`, `world.ts` | Two copies of SONIC's own G1 model (`p1_`, `p2_`) on a 0.5-friction floor, 5 ms physics steps |
| SONIC | `src/core/sonic.ts`, `g1.ts` | Runs the encoder (1762 inputs to a 64-number token) and decoder (994 inputs to 29 actions) at 50 Hz, with PD control 4x per tick. Ported from GR00T-WholeBodyControl's deploy code |
| Reference | `src/core/reference.ts` | The motion SONIC follows: 50 Hz frames, crossfaded splices |
| Planner | `src/core/planner.ts`, `planner/server.ts` | SONIC's kinematic planner writes the motion: `idleBoxing`, `walkBoxing`, kneel and stand transitions (about 25 ms per plan on an M4 CPU) |
| Between moves | `src/core/fighter.ts` | The stance machine and footwork brain |
| Attacks | `src/core/attacks.ts` | Force pulses at a body point, tuned on SONIC |
| Rig page | `src/rig/` | three.js view and the control panel |
| Human look | `src/rig/human.ts` | Boxer mannequin (limbs, torso, head, gloves, shorts, shoes) attached to the G1 bodies and sized from its joint positions, so it moves exactly as the physics does |

### Posture
SONIC barely moves the G1's waist pitch. The planner's boxing stance leans the torso forward
about 8° by bending at the waist, so followed literally the robot ends up leaned back 5-12°.
`waistToHips()` (`src/core/reference.ts`) moves that waist bend into the hips: the reference
pelvis tilts forward by the waist angle, plus 3.5°, and both hips fold by the same amount, so the
torso and legs keep their pose. The planner itself still continues from its untouched motion
(`Fighter.raw`). Result: the torso leans 4-10° forward during footwork.

### Stances (`Fighter.stance`)
- **idle:** footwork. About every 1 s the brain picks an action: close in if more than 1.9 m
  away, back off if closer than 1.1 m, steer back to the center near the ring edge, otherwise
  circle or bounce in place. It always faces the opponent.
- **stagger:** for 0.7 s after a hit while still standing. SONIC catches its balance itself.
- **falling:** pelvis tilt over 55° or pelvis below 0.45 m. SONIC lets go, and the joints go soft
  in a brace pose (arms forward, knees bent), so it reaches out instead of flailing.
- **down:** on the floor for 1.1 s.
- **rising:** a staged get-up, each stage planned from the pose the robot actually reached.
  1. Onto its knees: the planner's `kneelTwoLeg`. SONIC does this alone.
  2. Standing up: the planner's `idle`, with invisible help carrying 15% of body weight.
  3. If a stage stalls, it is replanned from the current pose with 30% more help each time.
     The limbs always follow the planner's human get-up motion, never a lift.
  In a sweep over six knockdowns (haymaker, sweep, shove, uppercut, hook, body shot) it stood
  up 6/6 times in 2.7-3.8 s. A full assisted lift remains only as the no-planner fallback.
- **ko:** limp and stays down. **move:** playing a clip handed over by the fight code.

### Thrown punches
The other robot steps into range (pelvis to pelvis about 0.78 m) with `walkBoxing`, then throws a
planner punch: `leftJab`, `rightJab`, `leftHook` or `rightHook`. The hit lands when its fist
comes within 0.3 m of the target's head. Within 0.55 m it counts as a glancing hit at 75%;
anything farther misses. The defender reacts physically, and both go back to footwork.

### Attack tiers (0.1 s pulse at the torso)
300 N is a stagger, and 500 N is about 1 m of stumbling that SONIC recovers from. A hit of
55 N·s or more (force x duration) is a **knockdown**. It delivers a capped 30 N·s shove, and the
fighter goes slack and buckles at the knees. SONIC balances well enough that knocking it over
with raw force alone took 80+ N·s, which launched the body 2 m and flipped it; now it folds and
lands within about 0.5 m.

## Using it from the fight code
```ts
const arena = new Arena(world, [p1, p2]);   // steps both fighters on SONIC's clock
await arena.tick();                          // every 20 ms
p2.hit(attack, attackerRootXY, scale);       // physics reaction; returns contact point and force
p1.playMove(kimodoQposRows, 30);             // re-based onto p1, facing p2; back to footwork after
p1.throwPunch(p2, Mode.leftHook, hookAttack, 1, (hit) => {});  // steps in, punches, lands at the fist
p2.knockOut();
p1.stance;                                   // "idle" | "stagger" | "falling" | "down" | "rising" | "ko" | "move"
```

## Not done yet
- The stand-up still gets light help (15% of body weight). Getting SONIC up from kneeling with no
  help needs better stage targets or a get-up clip it can follow.
- No two-robot body contact tuning. The robots can collide, but hits are force pulses, not fists.
- `playMove` isn't tested with real Kimodo clips yet.

## Sources and licenses
G1 model and meshes are from NVlabs/GR00T-WholeBodyControl `gear_sonic_deploy/g1` (Unitree, BSD-3).
SONIC weights are from huggingface.co/nvidia/GEAR-SONIC (NVIDIA Open Model License). Controller
constants and observation layout are ported from the same repo's Apache-2.0 deploy code. Downloads
are pinned in `scripts/fetch-assets.mjs`.
