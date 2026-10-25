# Infinite Fighter (HackTX)

Team notes for Claude Code sessions. This file is the plan we started from;
README.md describes what was built, and its measured numbers replace the
(guess) marks below.

A robot fighting game where every move is invented, either by a Claude agent
overnight or by a player, live, with their body. Fighters are Unitree G1
humanoid robots in MuJoCo physics. Phones are the controllers. Every move a
player invents joins the shared library with their name on it.

The world is a mystical fairy tale. The fighters are enchanted clockwork
automatons, woken by fairy magic, dueling inside a glowing fairy ring.

Pitch line: "Every move you invent teaches a real robot how to move."

Tracks: Most Entertaining, Best Pitch, and Meta (Bringing People Closer
Together with AI). For Meta, every shout goes through Muse Voice Transcribe, and
moves are gifts between players: credit popups and Duo Forge (two friends make
one move together, credited to both).

## How it plays
1. Forge (on your phone, anytime, even in line). Prop the phone up, act out a
   move for 5 s, say its name. Kimodo turns the acting into a polished G1 move.
   Agents give it a type, an effect, and stats. Keep or redo. Up to 3
   signature moves per player.
2. Join. The game screen shows a QR code. Both phones scan it and become
   controllers.
3. Fight. Hold to talk and shout a move:
   - A common move ("uppercut") matches the overnight library and plays instantly.
   - Your own signature move plays instantly at 1.5x power.
   - Anything new ("summon the crab king") generates live while your robot
     charges up, then joins the library.
   Tap buttons on the phone for jump, dodge left, dodge right, block.
4. Real physics. Hits push robots. Big moves can tip your own robot over.
   A knockout is a real fall, never an animation.
5. Credit. When anyone uses your move, the screen shows "GORILLA SMASH,
   invented by <nickname>". Phones show usage counts. Leaderboard of the most
   used player-made moves.

Demo moments that must work: the library counter (agent moves + player moves),
a Forge move made by a judge in under 30 s, an instant library hit, a tap
dodge, a signature move landing with a real fall, a live wildcard.

## Look and feel: a mystical fairy tale
- Lore: in an enchanted forest, fairy magic wakes old clockwork automatons and
  they duel inside a fairy ring. That's why robots cast spells.
- Fighters are G1 robots wearing a fairy-tale costume shell: helms, hats,
  hoods, cloaks, wings, antlers, glowing runes. Costume pieces are render-only
  meshes attached to G1 bodies in three.js. They never touch physics.
- Arena: a glowing ring of mushrooms in a moonlit forest clearing, with
  fireflies, drifting fairy dust and soft fog.
- Effects sparkle. Fire is a hearth-fire orb trailing embers, ice is frost
  crystals, lightning is crackling wisp-light, shadow is moonlit smoke,
  physical is a burst of thorns and petals. On a KO the robot really falls
  (physics), then its runes fade and fairy dust drifts up.
- UI looks like an illuminated storybook: parchment panels, gold trim, a serif
  display font. Move cards on the phone look like spell cards.
- In-game type names: Might (physical), Flame (fire), Frost (ice),
  Storm (lightning), Shadow (shadow). Code keeps the ids.
- Assets are original or CC0 only (Kenney, Quaternius). Folklore archetypes
  (knights, witches, sprites, wolves) are fine. No characters or looks from
  existing films, games or books.

## Devices
| Device | Runs |
| --- | --- |
| Game screen (laptop browser) | arena, MuJoCo physics (WASM), rendering, effects, commentator audio |
| Phones (mobile browser, no install) | Forge camera and pose, hold-to-talk mic, move deck, tap buttons |
| GPU server | FastAPI: Kimodo, job queue, speech to text, matching, agents, library, WebSocket rooms |

All traffic goes through the server, because venue Wi-Fi often blocks
device-to-device traffic. The game screen opens a room; the QR code is the join
URL with the room code. Bring a phone hotspot as backup.

## Rules for every Claude Code session
- Hackathon code. Working beats clean. No tests unless asked.
- Only edit the folders your owner told you to. Never edit contract/ once it
  is frozen. If the contract needs to change, stop and say so.
- Unsure about Kimodo? Read its source and docs before guessing:
  https://research.nvidia.com/labs/sil/projects/kimodo/docs/
- Writing Claude agent code? Load the claude-api skill first. Don't guess SDK calls.
- Each folder runs with one command, written in its README.
- Phones never upload video. Only pose landmarks leave the phone.
- Small commits, clear messages, pull before you push.

## Repo layout and owners
```
CLAUDE.md
contract/            write first, then frozen: api.md, ws.md, sim.ts,
                     motion.example.json, constraints.example.json
server/              Vaibhav: Kimodo, job queue, quality checks, speech to text
                     (Muse Voice Transcribe), matching, live wildcards, Forge
                     pipeline, server-side agents, library, WebSocket rooms
agent/               Vaibhav (built by Jerry): overnight Library Builder loop
client/              Sudeep (built by Jerry): game screen, rendering, effects,
                     narrator; client/src/sim/ is the real physics sim
phone/               unassigned: Forge capture, pose landmarks, move deck,
                     hold-to-talk, tap buttons
docs/                Jerry's handoff, Kimodo fact sheet, review findings
library/             written only by server/: moves.jsonl, motions/, forge/
```

## Kimodo
Full sourced notes: docs/kimodo-g1.md. The short version:
- Use `Kimodo-G1-RP-v1` only, and pass `--model` on every call (the default is
  SOMA). Only G1-RP writes the MuJoCo qpos CSV. No retargeting.
- CSV: 36 columns (root xyz, root quat w-first, 29 hinges), 30 fps, no header,
  no fps, no joint names. The joint order matches Menagerie `unitree_g1/g1.xml`
  exactly; the server adds `fps` and `joint_names`.
- Never put a `.` in a prompt, decimals included. Each period starts a new
  segment. Start prompts with "A person".
- Constraints: `fullbody`, `left-hand`/`right-hand`/`left-foot`/`right-foot`,
  `root2d`. Every pose entry needs all 34 local joint rotations plus the pelvis
  position, in Kimodo's frame (Y up). There is no raw hand-target field, so
  Forge needs IK from landmarks to G1 joint angles. 5 working G1 example files
  ship in the Kimodo repo.
- The Forge slider is `--cfg_weight <text> <constraint>` (two floats).
- Post-processing is always off for G1: expect foot skating, joint angles up to
  ~8 deg past limits and feet ~5 cm below the floor. Quality checks need
  tolerances; the sim clamps joint targets.
- `kimodo_gen` reloads the model every call. The server keeps it loaded with
  the Python API and batches prompts.
- Clips under 2 s are untested on G1. Measure early; fallback is to generate
  2 s and trim.
- About 17 GB of VRAM fully on GPU. Keep the text encoder on the GPU;
  `TEXT_ENCODER_DEVICE=cpu` fits in under 3 GB but is slower.
- The text encoder is Meta-Llama-3-8B-Instruct. It's gated on Hugging Face with
  manual approval; people report long waits. Request it first. If it isn't
  approved in time, the HF Space `nvidia/Kimodo` (G1-RP) is the fallback.
- Kimodo knows locomotion, gestures, everyday actions, combat and dance.
  Fantasy words make bad motion. `kimodo_prompt` is always a plain body
  description: "a person steps forward and thrusts both palms out at chest
  height", never "Thunder Palm". Kimodo never sees names or effects.
- Kimodo makes body motion only. Effects come from the client. Hit reactions
  come from physics, never from Kimodo.
- Unknown until measured: seconds per clip (guess: 1 to 3 s), output fps
  (other docs say 30), and whether the CSV joint order matches the MuJoCo
  Menagerie G1.

## Move spec
Every move is a spec plus a motion. Many specs can share one motion.
```json
{
  "id": "mv_0412",
  "name": "Thunder Palm",
  "aliases": ["thunder palm", "lightning push", "shock palm"],
  "type": "lightning",
  "kind": "projectile",
  "effect": "wisp_bolt",
  "kimodo_prompt": "a person steps forward and thrusts both palms out at chest height",
  "hit_joint": "r_hand",
  "duration": 1.2,
  "power": 2,
  "stability": 0.7,
  "originality": 0.42,
  "motion_id": "mo_0099",
  "hit_frame": 18,
  "source": "agent",
  "creator": null,
  "uses": 0
}
```
- `type`: physical | fire | ice | lightning | shadow
- `kind`: melee | projectile | strike (from above) | shockwave | defend
- `effect`: visual tag the client maps to a fairy-tale effect: ember_orb, wisp_bolt,
  frost_crystals, moon_smoke, thorn_burst, fairy_dust, shockwave, none
- `hit_joint`: head | chest | l_hand | r_hand | l_foot | r_foot (the sim maps these to G1 bodies)
- `source`: agent (overnight) | forge (player made) | live (wildcard)
- `duration` 0.8 to 1.5 s. `power` 1 to 3. `stability` and `originality` 0 to 1.
- The server sets `hit_frame` to the frame where `hit_joint` moves fastest.

## Motion format (server to client)
Kimodo's G1 qpos, served as JSON. MuJoCo convention: meters, Z up. Each row is
root position, root quaternion (w, x, y, z), then joint angles in `joint_names`
order. Motions start at the origin; the sim re-bases them onto the fighter.
```json
{ "id": "mo_0099", "fps": 30, "joint_names": ["left_hip_pitch_joint", "..."],
  "qpos": [[0.0, 0.0, 0.79, 1.0, 0.0, 0.0, 0.0, 0.1, "..."]] }
```
This replaces main's joint-positions format. MuJoCo drives the G1 by joint angles.

## Physics (client/src/sim, MuJoCo in the browser)
- Two Unitree G1s from MuJoCo Menagerie. Every character uses the same body;
  characters differ by costume, glow and multipliers.
- Active ragdoll. PD motors track the move's joint angles every step. A hidden
  balance assist (force and torque on the pelvis) keeps the robot upright and
  on its planned root path.
- A hit cuts the assist for a moment, scaled by damage. Moves with low
  stability weaken the assist while they play. Assist off means gravity wins.
- Knockdown: pelvis below 0.4 m for 2 s. KO: HP hits 0, full ragdoll, stays down.
- Outcomes come from rules; physics adds the impulse and the bonus. Pure
  collision detection would make most attacks miss.
  - Fighters start 1.2 m apart. The sim steps a fighter into range and turns it
    to face the opponent before a melee move. A motion's own root travel is
    clipped to 0.3 m.
  - Melee lands at `hit_frame` if in range, unless the defender blocks or is mid-dodge.
  - Projectiles spawn at `hit_joint` on `hit_frame`, fly at 6 m/s, and land at
    the defender's chest unless dodged or blocked.
  - Strike lands 0.6 s after `hit_frame` where the defender stood at cast time.
  - Shockwave hits anything within 1.5 m of the caster and pushes outward.
  - Clean hit: MuJoCo contact between `hit_joint` and the head or chest.
    1.25x damage and a bigger flash.
  - Every hit applies a real impulse at the contact point. That's what makes
    robots stagger and fall.

## Damage and resources (starting values, tune them)
```
damage = base x type_mult(attacker) x weak_mult(defender)
         x (0.75 + 0.5 x originality) x signature x (0.8 + 0.4 x loudness)
```
| Kind | Power 1 | Power 2 | Power 3 |
| --- | --- | --- | --- |
| Melee base | 8 | 12 | 16 |
| Projectile base | 6 | 10 | 14 |
| Strike base | 7 | 11 | 15 |
| Shockwave base | 5 | 8 | 11 |
| Energy cost | 15 | 25 | 40 |
| Cooldown (s) | 0.9 | 1.3 | 1.7 |

- `signature` is 1.5 when a player uses their own Forge move, else 1.
- HP 100. Energy 100, refills 12 per second. Basic actions cost no energy.
- Block cuts incoming damage to 0.3x. Dodge: 0.4 s of no damage, 1.5 s cooldown.
  Hit stun 0.3 s.
- Best of 3 rounds, 60 s each.

## Characters
Five enchanted automatons. Same G1 body; costume, glow and multipliers differ.

| Character | Costume | Deals 2x | Deals 0.5x | Takes 1.5x from |
| --- | --- | --- | --- | --- |
| Sir Bramble, the Thorn Knight | mossy iron armor wrapped in briar roses | physical | fire | shadow |
| Marigold, the Hearth Witch | pointed lantern hat, ember-stitched cloak | fire | physical | ice |
| Flicker, the Storm Sprite | crackling dragonfly wings; cooldowns 0.8x | lightning | ice | physical |
| Rime, the Winter Stag | antlered frost-crystal helm, pale blue glow | ice | lightning | fire |
| Hush, the Moon Wolf | wolf hood, starry night cloak, violet glow | shadow | physical | lightning |

Original characters only. Moves can riff on famous attacks and old fairy tales,
but nothing on the select screen should be someone else's character.

## AI agents
Claude agents use `claude-opus-5-5` with structured outputs for JSON. Set
effort explicitly: `low` on live paths, `high` for overnight work. Check
`stop_reason` for `refusal` before reading content.

| Agent | Lives in | In -> out | When |
| --- | --- | --- | --- |
| Library Builder | agent/ | theme, thin types, existing names -> 50 move specs per call | overnight |
| Choreographer | server/ | move name + what the player acted -> `kimodo_prompt` | Forge, live |
| Effect Designer | server/ | move name -> `type`, `kind`, `effect` | Forge, live |
| Balance Referee | server/ (no LLM) | motion -> `stability`, `originality` | every new move |
| Voice Matcher | server/ (no LLM) | transcript -> move id, under 50 ms | every shout |
| Commentator | server/ | recent fight events -> one short line in a storybook narrator's voice ("And lo, the Thorn Knight falls!"), spoken by TTS on the game screen | fights |
| Rival AI | server/ | fight state -> what to shout | stretch, single player |

Balance Referee: run the motion on a G1 in headless MuJoCo (Python `mujoco`)
with the assist at a fixed low level. `stability` is the share of the clip the
pelvis stays up. `originality` is 1 minus the highest cosine similarity between
this motion's features (downsampled joint angles) and any library motion.

## Voice
- Phone: hold to talk. On release, upload the audio and the loudness (RMS) to
  the server. Don't rely on the browser's Web Speech API on phones; it's flaky
  on iPhone.
- Server: speech to text, then match in order:
  1. The speaker's own signature moves (threshold 0.4).
  2. The library: all-MiniLM-L6-v2 embeddings over names and aliases (threshold 0.5).
  3. Miss: live wildcard. Choreographer and Effect Designer write the spec at
     low effort. The job jumps the GPU queue. The fighter charges and can be hit
     meanwhile. The new move joins the library with `source: "live"` and the
     player as creator.
- Flash the matched move name and type huge over the fighter. A silly match
  reads as a joke, not a bug.

## Forge pipeline
1. Phone: spoken 3-2-1 countdown, then 5 s of recording. MediaPipe Pose runs on
   the phone and outputs 3D world landmarks at 30 fps.
2. Phone: the player says the move name (same hold-to-talk path).
3. Server: pick 3 to 5 keyframes at the extremes of the motion. Scale the
   landmarks to G1 size and map them to G1 body points.
4. Kimodo-G1: text from the Choreographer, full-body keyframe constraints. If
   full-body keyframes are too noisy, use hand and foot targets plus a root path.
5. Quality checks, Effect Designer, Balance Referee, then a card:
   name, type, power, stability, originality.
6. Phone shows a stick-figure preview and the card: Keep or Redo. The slider
   changes the two guidance weights and regenerates.
7. Kept: saved to the library with `source: "forge"` and the player's nickname.
   The landmarks, name and prompt go in `library/forge/{move_id}/`. That's the
   dataset.

Nicknames, no accounts. The phone keeps its move ids in localStorage.

## Overnight Library Builder (agent/)
1. GET `/library/stats` to see which types are thin.
2. Ask Claude for 50 specs in one call. Rotate fairy-tale themes: knights and
   dragons, witches and potions, forest spirits and beasts, winter tales,
   moonlight and night creatures, giants and trolls, enchanted household
   objects played for laughs, plus plain combat (punches, kicks, dodges) so
   common shouts always hit. Pass the existing names for that theme so it
   doesn't repeat. Names sound like spells ("Bramble Bash", "Moonlit Howl");
   `kimodo_prompt` stays a plain body description.
3. Validate the JSON. Drop specs whose name or aliases already exist.
4. Reuse motions: if a `kimodo_prompt` is a near-duplicate (embedding
   similarity over 0.95) of one already generated, point at that motion.
5. POST `/generate` the rest. Poll jobs. Log kept and rejected per hour to
   `agent/log.txt`.
6. Never crash: retry on errors, resume cleanly on restart. Flags:
   `--batches N`, `--batch-size N`.

Start small: generate 20, look at all 20, fix the prompt template, then let it
run. A bad template left running all night gives thousands of bad moves.

Automatic quality checks (server, every clip): the body barely moved, the root
drifted over 1.5 m, any body went more than 5 cm below the floor, a joint broke
its G1 limits, any NaN or missing frames.

## Server endpoints (contract/api.md)
| Endpoint | Sends | Returns |
| --- | --- | --- |
| `GET /health` | nothing | GPU, model loaded, last generation ms, queue length, library size |
| `GET /idle` | nothing | the idle stance motion |
| `POST /generate` | move spec | `{"job": id}` |
| `GET /job/{id}` | nothing | `running`, `done` with the move, or `rejected` with the failed check |
| `POST /voice` | room, player, audio, loudness | transcript and match; also pushed to the game screen |
| `POST /match` | text | library move, or miss with a fallback job (typed backup, debugging) |
| `GET /motion/{id}` | nothing | one motion |
| `GET /library/stats` | nothing | total moves, count per type and per source |
| `POST /forge` | nickname, name, landmarks, slider | `{"job": id}`; done returns the card and preview motion |
| `POST /forge/{job}/keep` | nothing | saves the move to the library |
| `GET /leaderboard` | nothing | most used player-made moves |
| `WS /room/{code}` | room messages | room messages |

Jobs are plain HTTP; poll every 250 ms. The WebSocket is only for room traffic
(contract/ws.md):
- phone to game: `join`, `tap` (jump, dodge_left, dodge_right, block)
- server to game: `play` (player, move), `charge` (player, job, guessed move), `ready` (job done)
- game to phones: `state` (hp, energy, cooldowns), `event` (hit, ko, round)

## Sim interface (contract/sim.ts, Sudeep implements, Jerry calls)
```ts
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Player = 1 | 2;
type MoveType = "physical" | "fire" | "ice" | "lightning" | "shadow";
type Kind = "melee" | "projectile" | "strike" | "shockwave" | "defend";
type Action = "jump" | "dodge_left" | "dodge_right" | "block";

interface Motion { id: string; fps: number; joint_names: string[]; qpos: number[][]; }
interface Move {
  id: string; name: string; type: MoveType; kind: Kind; effect: string;
  power: 1 | 2 | 3; stability: number; originality: number;
  hit_joint: string; hit_frame: number; motion_id: string;
  creator: string | null; signature: boolean;
}
interface FighterState {
  bodies: { name: string; pos: Vec3; quat: Quat }[];  // world space, ready to draw
  hp: number; energy: number; cooldowns: Record<string, number>;
  status: "idle" | "charging" | "acting" | "blocking" | "dodging" | "stunned" | "down" | "ko";
}
type SimEvent =
  | { kind: "hit"; attacker: Player; damage: number; type: MoveType; clean: boolean; point: Vec3 }
  | { kind: "blocked"; defender: Player; point: Vec3 }
  | { kind: "dodged"; defender: Player }
  | { kind: "down"; player: Player }
  | { kind: "ko"; loser: Player }
  | { kind: "round"; winner: Player };

interface Sim {
  init(idle: Motion, characters: [string, string]): Promise<void>;
  canAct(p: Player, move?: Move): boolean;       // status, cooldown, energy
  setCharging(p: Player, on: boolean): void;
  playMove(p: Player, move: Move, motion: Motion, loudness: number): boolean;
  action(p: Player, a: Action): boolean;
  step(dt: number): void;                        // every animation frame
  state(p: Player): FighterState;
  projectiles(): { pos: Vec3; type: MoveType; effect: string; owner: Player }[];
  on(cb: (e: SimEvent) => void): void;
  reset(): void;                                 // new match
}
```
Jerry's code never computes damage or physics. It draws `state().bodies` and
plays effects when events fire.

## Do first, in order
1. Request access to Meta-Llama-3-8B-Instruct on Hugging Face.
2. Kimodo-G1 on the GPU. Time one 1.2 s clip from text only, then with
   constraints. Post both numbers in the group chat.
3. Save a constraints file from Kimodo's web demo into
   contract/constraints.example.json.
4. A Menagerie G1 standing in MuJoCo in the browser, playing back one Kimodo
   G1 CSV. Confirm the joint order matches.
5. Write contract/, freeze it, split up.
6. 20 overnight specs: generate, look at all 20, then start the overnight run.

## Stretch (only after a full match works)
Rival AI, the leaderboard screen, physical push-to-talk arcade buttons (ESP32),
an Isaac Sim slow-motion replay of the winning knockout.
