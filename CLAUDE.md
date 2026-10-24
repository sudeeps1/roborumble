# Voice Fighter (HackTX, 24-hour hackathon)

Two-player fighting game controlled entirely by voice. Every move is generated
live by NVIDIA Kimodo (text-to-motion diffusion) from what the player says.
There is NO pre-made move library. The only pre-made animation is an idle stance loop.

## How a round works
1. Calling phase. P1 holds A and says a move. As soon as P1 lets go, P1's move
   starts generating. Then P2 holds L and says theirs, which starts generating too.
   Who calls first alternates every round (calling second lets you counter).
2. Fighters sit in the idle loop with a "charging" glow until both moves are ready.
3. Both moves play at the same time. Hits are checked every frame.
   A dodge works for free: if the defender's head moves, the punch aimed at it misses.
4. Damage, HP update, next round. First to 0 HP loses.

## Rules for every Claude Code session
- Hackathon code. Working beats clean. No tests unless asked.
- Only edit the folder your owner told you to. Never edit contract/.
  If the contract needs to change, stop and say so.
- The server sends joint POSITIONS per frame. The client never touches rotations.
- Each folder runs with one command, written in its README.
- Unsure about Kimodo's API? Read its source and docs before guessing:
  https://research.nvidia.com/labs/sil/projects/kimodo/docs/
- Small commits, clear messages, pull before you push.

## Repo layout
```
CLAUDE.md
contract/
  motion.example.json   fake move so the client can start now
  api.md                endpoints below
server/
  kimodo_service/       Vaibhav: Kimodo on the GPU, constraints, FK, job queue, cache
  referee/              Sudeep: prompt building, hit limb, damage, /move endpoint
client/                 Jerry: Vite + TypeScript + three.js
```

## Motion format
Meters, Y up. Attacker starts at the origin facing +X. The client places it in the world.
```json
{
  "prompt": "a fighter throws a spinning back kick",
  "fps": 30,
  "parents": [-1, 0, 1, 2],
  "named": {"head": 3, "chest": 2, "l_hand": 0, "r_hand": 0, "l_foot": 0, "r_foot": 0},
  "frames": [[[0.0, 0.9, 0.0], [0.0, 1.1, 0.0]]],
  "hit": {"joint": "r_foot", "frame": 18},
  "damage_base": 12
}
```
`hit` is null for non-attacks (block, dodge, taunt). Real joint indices get filled in once Kimodo runs.

## Endpoints
| Endpoint | Sends | Returns |
| --- | --- | --- |
| `GET /idle` | nothing | the one idle stance loop, loaded at game start |
| `POST /move` | `player`, `text`, `loudness` (0 to 1), `target` (defender head position in attacker frame) | `{"job": "<id>"}` |
| `GET /job/{id}` | nothing | `{"status": "running"}` or `{"status": "done", "motion": {...}}` |
| `GET /health` | nothing | GPU name, model loaded, last generation time in ms |

Client polls `/job` every 250 ms. Plain HTTP, no WebSockets.

## Speed rules (latency is the whole game)
- Clips are 1 to 1.5 seconds. Never longer.
- Model and text encoder stay loaded on the GPU. Never move the text encoder to CPU.
- Cache by normalized prompt text. A repeated move costs nothing.
- One GPU job at a time, in the order received.
- Hit reactions are done in client code (knockback, flash, shake), never generated.
