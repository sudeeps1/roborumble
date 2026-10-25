# Physics: context and to-do (Sudeep)

Branch `sudeep/physics`, written 2026-10-24 during HackTX. The team restarted the
code from scratch. The concept is still Infinite Fighter (see `origin/v1:CLAUDE.md`).
Nothing in the physics core is built yet. Claude is building the between-moves
rig in `passive/` on this branch.

## The game, from the physics side
Two Unitree G1 robots fight in real physics. Moves come from three places:
- an overnight library of 3,000+ moves
- Forge moves that players act out on their phones
- live wildcards generated on the spot

Phones tap jump, dodge left, dodge right and block. Every move gets a card
(power, stability, originality) from the Balance Referee. Hits push robots, wild
moves can knock over your own robot, and knockouts are real falls.

## Who does what
| Piece | Owner |
| --- | --- |
| Physics core: MuJoCo + SONIC controller in the browser | Sudeep (Claude's `passive/` has a first version; reuse it) |
| Between moves: boxer idle footwork, hit reactions, falls, get-ups, test rig | Claude, in `passive/` |
| Fight rules: whether a hit lands, damage, types, energy, cooldowns, block, dodge, KO | Sudeep |
| Balance Referee: stability, power, originality, hit limb and frame, rejects | Sudeep |
| Kimodo server, job queue, library, Forge pipeline | Vaibhav |
| Rendering, effects, UI, phones | Jerry and the team |

## Decisions and why
- **MuJoCo, running in the game-screen browser.** Use the official WebAssembly
  build `@mujoco/mujoco` (3.17.0 on npm as of Oct 22).
  - Kimodo-G1 outputs MuJoCo joint data in the G1's exact joint order.
  - The GPU server is on AWS, so anything real-time has to stay on the laptop.
- **SONIC drives both robots.** NVIDIA's GEAR-SONIC is a trained whole-body
  controller that follows a reference motion and keeps its balance.
  - It runs in the browser with ONNX Runtime Web; NVIDIA's live demo already does this.
  - Fallback: PD tracking plus a hidden balance assist on the pelvis.
- **SONIC's planner makes the reference motion between moves.** The planner
  (`planner_sonic.onnx`) generates natural motion: boxing idle and footwork,
  punches, and kneel, lie and get-up transitions.
  - At 774 MB it's too big for the browser, so it runs as a small local service.
  - Move it to the GPU box later.
- **No Isaac Sim.** It's Linux or Windows only and needs an RTX GPU, so it would
  stream over venue Wi-Fi. It's also too heavy to set up in 24 h.
- **Physics needs no GPU.** SONIC and MuJoCo both run on the game laptop.
- **Rules decide whether a hit lands; physics delivers the push and the fall.**
  Kimodo moves don't aim at the opponent.

## Your to-do, in order
1. **Settle interfaces with the team in the first hour.**
   - **Motion JSON from the server:** `{fps, frames, joint_pos[T][29] (MuJoCo order), root_pos[T][3], root_quat[T][4] (w,x,y,z)}`.
     That's the Kimodo CSV split into columns.
   - **Referee API:** takes the motion plus the move id. Returns `stability`,
     `power`, `originality`, `hit_joint`, `hit_frame`, and accepted or rejected
     with a reason.
   - **Physics to renderer:** body poses (MJCF body names, MuJoCo world
     coordinates, Z up, quaternions w,x,y,z) plus events: hit, blocked, dodged,
     down, ko.
   - **Suggest to Vaibhav:** the Kimodo server could copy the SONIC demo's
     `POST /api/generate {prompt, duration, diffusion_steps}` and
     `GET /api/health`. Then NVIDIA's demo page works as a free test client via
     `?backend=<server url>`.
2. **Build the physics core**, shared by the game and the referee.
   - MuJoCo with two G1s and one SONIC controller per robot.
   - Physics steps every 5 ms; the controller ticks every 20 ms.
   - Keep the DOM and three.js out of the core, so it also runs headless.
   - Start from the version in Claude's `passive/`.
3. **Build Balance Referee v1** before the overnight library run. If it's late,
   the library saves motions unscored and you score everything in one batch in
   the morning.
   - **Stability:** about 3 runs, one clean and two with small random pushes
     seeded by move id. Score = share of runs still upright 1 s after the move.
   - **Power:** measure on the simulated run, not the raw clip. Find the fastest
     strike into a target sphere where the opponent's head would be. That's the
     logic in your old `hits.py` on the local `referee-hit-detection` branch
     (never pushed). It also gives `hit_joint` and `hit_frame`. For spells, fall
     back to the fastest hand or foot.
   - **Originality:** fingerprint each move (hand and foot paths relative to the
     pelvis, resampled to a fixed length). Score = 1 minus the best match in the
     library. Check mirrored versions too.
   - **Rejects:** frozen clips, wild drift and NaN only. A move the robot can't
     survive stays in, with stability 0.
   - **Where it runs:** Node. `@mujoco/mujoco` runs in Node, and
     `onnxruntime-node` runs SONIC.
   - **Calibrate** the score scales on 20 to 50 real clips.
4. **Fight physics and rules.**
   - Hits are short force pulses on the body part that got hit, sized by damage.
   - Block and dodge windows come from the rules; the body catches up.
   - Knockdown: pelvis below 0.4 m for 2 s. KO: the controller switches off.
   - Damage formula, types and characters, energy, cooldowns, signature bonus.
   - A hidden leash keeps the fighters in range and in the ring.
5. **Live wildcards** play right away with instant power and originality. The full
   stability test runs in the background.

## Facts you'll need

### Kimodo-G1 (verified in `origin/v1:docs/kimodo-g1.md`)
- **Model:** use `Kimodo-G1-RP-v1`.
- **CSV rows:** 36 values each, at 30 fps with no header: root position (0-2),
  root quaternion w,x,y,z (3-6), then 29 hinge angles (7-35) in MuJoCo order.
  That's the same order as Menagerie and Unitree `g1_29dof`.
- **Clean-up needed:**
  - Frame 0 sits 1-7 cm off the origin, so re-base it.
  - The root quaternion flips sign between frames, so align it before blending.
  - Joint angles go up to 7.6° past the limits, so clamp them.
- **Prompts:** no `.` anywhere. Each period starts a new segment.
- **Open risks:** clips under 2 s are untested on G1. It needs about 17 GB of VRAM.
  The Llama 3 text encoder is gated and approval can take days.

### SONIC controller (checked against NVlabs/GR00T-WholeBodyControl, Apache-2.0)
- **Weights:** Hugging Face `nvidia/GEAR-SONIC`, not gated, NVIDIA Open Model License.
  - `model_encoder.onnx` (50 MB), `model_decoder.onnx` (41 MB), `planner_sonic.onnx` (774 MB).
- **Robot model:** `gear_sonic_deploy/g1/g1_29dof_old.xml` with `scene_29dof.xml`.
  Torque motors, with PD computed in code, and a 5 ms timestep (200 Hz).
- **Control loop:** runs at 50 Hz. Each tick runs the encoder (1762 inputs to a
  64-number token), then the decoder (994 inputs to 29 actions). PD runs 4 times
  per tick: `tau = kp*(target - q) - kd*dq`, clipped to the torque limits.
- **Actions to joint targets:**
  `target[mj] = default_angles[mj] + action[isaaclab_to_mujoco[mj]] * action_scale[mj]`.
  Gains, scales, default angles and both joint maps are in
  `gear_sonic_deploy/src/g1/g1_deploy_onnx_ref/include/policy_parameters.hpp`.
- **Encoder input (G1 mode):**
  - [0:4]: mode 0 plus zeros.
  - [4:294]: future joint positions, 10 frames 0.1 s apart. IsaacLab order, absolute angles.
  - [294:584]: future joint velocities.
  - [601:661]: future anchor orientation, 6 numbers per frame.
  - Everything else: zero.
- **Anchor orientation:** compute
  `conj(robot_pelvis_quat) * (heading_fix * ref_root_quat)` as a rotation matrix
  and keep `[R00, R01, R10, R11, R20, R21]`.
  `heading_fix = yaw(robot at start) * inverse(yaw(ref at start))`.
- **Decoder input:** the token (64), then the last 10 ticks, oldest first, of:
  - pelvis angular velocity, in the body frame
  - joint positions minus the default angles, in IsaacLab order
  - joint velocities
  - last raw actions
  - gravity direction, in the body frame
- **Playback rate:** reference motion plays at 50 Hz, so resample Kimodo's 30 fps.
- **Reference implementation:** NVIDIA's live demo
  (https://nvlabs.github.io/GEAR-SONIC/demo.html) runs all of this in a browser.
  It has no license, so treat it as a reference only and port from the Apache-2.0 C++.

### SONIC planner modes (`planner_sonic.onnx`)
| Group | Modes |
| --- | --- |
| Locomotion | idle 0, slowWalk 1, walk 2, run 3 |
| Low to the ground | squat 4, kneelTwoLeg 5, kneelOneLeg 6, lyingFacedown 7, handCrawling 8, elbowCrawling 14 |
| Boxing | idleBoxing 9, walkBoxing 10, leftJab 11, rightJab 12, randomPunches 13, leftHook 15, rightHook 16 |
| Style walks | 17-26 |

- **Input:** the last 4 qpos frames (30 Hz), the mode, movement and facing
  directions, target speed and height.
- **Output:** up to 64 qpos frames at 30 Hz, which play back at 50 Hz.
- **Docs:** `docs/source/references/planner_onnx.md` in the SONIC repo.

## Risks to check early
- **Performance:** two SONIC controllers plus rendering in one browser tab hasn't been measured.
- **Combat clips:** test SONIC on Kimodo kicks, spins and dives early.
- **Get-ups:** they should start from wherever the robot landed (the planner
  bridges from the real pose). Unproven.
- **Planner speed:** unmeasured on CPU (774 MB). It moves to the GPU box later.

## Where things are
- `origin/v1`: Jerry's prototype client (with a kinematic stub sim),
  `docs/HANDOFF.md`, `docs/kimodo-g1.md` and `docs/review-findings.md`. Reference only.
- Local branch `referee-hit-detection` (not pushed): your `server/referee/hits.py`.
- `passive/` on this branch: Claude's between-moves rig, in progress.
