# Voice Fighter (HackTX, 24-hour hackathon)

Two-player fighting game controlled entirely by voice. Every move is generated
live by NVIDIA Kimodo (text-to-motion diffusion) from what the player says.
There is NO pre-made move library. The only generated animation made ahead of
time is one idle stance loop.

## How a round works
1. Calling phase. P1 holds A and says a move. As soon as P1 lets go, P1's move
   starts generating. Then P2 holds L and says theirs, which starts generating too.
   Who calls first alternates every round (calling second lets you counter).
2. Fighters idle with a "charging" glow until both moves are ready.
3. Both moves play at the same time. The sim checks hits every frame.
   A dodge works for free: if the defender's head moves, the punch aimed at it misses.
4. Damage, physics reactions, HP update, next round. First to 0 HP loses.

## Rules for every Claude Code session
- Hackathon code. Working beats clean. No tests unless asked.
- Only edit the folder your owner told you to. Never edit contract/.
  If the contract needs to change, stop and say so.
- The server sends joint POSITIONS per frame. Nobody on the client touches rotations.
- Each folder runs with one command, written in its README.
- Unsure about Kimodo's API? Read its source and docs before guessing:
  https://research.nvidia.com/labs/sil/projects/kimodo/docs/
- Small commits, clear messages, pull before you push.

## Repo layout and owners
```
CLAUDE.md
contract/
  motion.example.json   fake move so the client can start now
  api.md                server endpoints below
  sim.ts                the Sim interface below (types only)
server/                 Vaibhav: Kimodo, constraints, FK, job queue, cache,
                        prompt template, hit-limb rules, /move
client/
  src/sim/              Sudeep: motion playback, physics, hit detection,
                        damage, idle sway, hit reactions, KO ragdoll
  everything else       Jerry: voice, round flow, rendering, effects, UI
```

## Motion format (server to client)
Meters, Y up. Attacker starts at the origin facing +X. The sim places it in the world.
```json
{
  "prompt": "a fighter throws a spinning back kick",
  "fps": 30,
  "type": "attack",
  "parents": [-1, 0, 1, 2],
  "named": {"head": 3, "chest": 2, "l_hand": 0, "r_hand": 0, "l_foot": 0, "r_foot": 0},
  "frames": [[[0.0, 0.9, 0.0], [0.0, 1.1, 0.0]]],
  "hit": {"joint": "r_foot", "frame": 18}
}
```
`type` is "attack", "defend", or "other". `hit` is null when there's no strike.

## Server endpoints
| Endpoint | Sends | Returns |
| --- | --- | --- |
| `GET /idle` | nothing | the idle stance loop, loaded at game start |
| `POST /move` | `player`, `text`, `target` (defender head position in attacker frame) | `{"job": "<id>"}` |
| `GET /job/{id}` | nothing | `{"status": "running"}` or `{"status": "done", "motion": {...}}` |
| `GET /health` | nothing | GPU name, model loaded, last generation time in ms |

Client polls `/job` every 250 ms. Plain HTTP, no WebSockets.

## Sim interface (Sudeep implements, Jerry calls)
```ts
type Vec3 = [number, number, number];
type Player = 1 | 2;
type Status = "idle" | "charging" | "acting" | "hit" | "ko";

interface FighterState { pose: Vec3[]; parents: number[]; hp: number; status: Status; }

type SimEvent =
  | { kind: "hit"; attacker: Player; damage: number; point: Vec3 }
  | { kind: "ko"; loser: Player }
  | { kind: "movesDone" };

interface Sim {
  init(idle: Motion): void;
  setCharging(p: Player, on: boolean): void;
  playMoves(m1: Motion, m2: Motion, loudness: [number, number]): void;
  step(dt: number): void;              // called every animation frame
  state(p: Player): FighterState;      // world-space pose, ready to draw
  on(cb: (e: SimEvent) => void): void;
  reset(): void;                       // new match
}
```
Jerry's code never computes damage or physics. It draws `state().pose` and plays
effects (flash, shake, sound) when events fire.

## Speed rules (latency is the whole game)
- Clips are 1 to 1.5 seconds. Never longer.
- Model and text encoder stay loaded on the GPU. Never move the text encoder to CPU.
- Cache by normalized prompt text. A repeated move costs nothing.
- One GPU job at a time, in the order received.
- Hit reactions come from the sim's physics, never from Kimodo.
