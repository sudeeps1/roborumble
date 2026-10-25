# client/ — the game screen

Arena, rendering, effects and commentator audio for Infinite Fighter (Jerry). `src/sim/` is Sudeep's
MuJoCo sim; nothing here touches it.

```
npm install && npm run mock     # no server needed: fake server + both phones on the keyboard
npm install && npm run dev      # the real thing: needs the FastAPI server
```

Needs Node 20.19+ or 22.12+ (Vite 8); Node 22 LTS is safest. Ubuntu's apt `nodejs` is too old: use nvm or NodeSource.

Open http://localhost:5173. The first run downloads the Unitree G1 model and meshes from MuJoCo Menagerie
(pinned commit) into `public/g1/`. Fonts are self-hosted (`src/ui/fonts/`), so nothing loads from Google.

## Setup

| Setting | How | Default |
| --- | --- | --- |
| Server | `SERVER_URL=http://gpu-box:8000 npm run dev` (or put it in `client/.env.local`) | `http://localhost:8000` |
| Phone join URL in the QR code | `VITE_JOIN_URL=https://.../phone/?room={code}` or `?join=` | dev: `http://<this host>:8000/phone/?room={code}`; a build: `<its own origin>/phone/?room={code}` |
| Room code | `?room=ABCD` | random, then written into the address bar |
| Mock mode | `npm run mock` or `?mock` | off |

The browser calls `/api/*` and Vite forwards to the server, including the room WebSocket
(`/api/room/{code}?role=game`). There's no CORS to set up, and phones can reach the dev server because it listens on all interfaces.

The room code stays in the address bar (`?room=KVWF`), so reloading the game screen, or reopening a crashed
tab, comes back to the same room: the server keeps both phones' seats and they reappear in the lobby. If a
second game screen opens the same room, the first one steps aside with a "Take the room back" button instead
of the two fighting over it. With teammates sharing one server, give each game screen its own `?room=`.

## Keys

- **Enter**: start the duel (once both phones joined) / rematch. **Esc**: back to the lobby (also mid-fight;
  the room and the seats stay).
- Lobby: **A / D** pick P1's character, **J / L** pick P2's. **M**: all sound on/off. **V**: the narrator's
  voice on/off (captions stay), for talking over the fight during a pitch.
- Mock mode adds keys for the fake phones. They're listed in the lobby's help box.

## At the venue

- Open the game with a fixed room, e.g. `http://localhost:5173/?room=FAIR`, so the QR code never changes.
- `npm run dev` reloads the page whenever Vite restarts (an edit to `.env.local` or `vite.config.ts`). The room
  survives that, but a build has no dev reloads at all: `npm run build && npx vite preview --port 5173` (same
  `/api` proxy and `SERVER_URL`). Put `VITE_JOIN_URL` in `.env.local` before building: the build bakes it in.
- Stage the tap dodge against a strike (a "rain", "meteor" or "summon" move). With the stub sim a strike lands
  0.6 s after its hit frame, so a dodge tapped 0.5 to 0.8 s after the cast avoids it. Melee hits and projectiles
  land on the hit frame (often 0.3 s in), before anyone can react to the move's name.

## Motion viewer

`/viewer.html?ids=mo_0001,mo_0002` plays motions from the server next to a standing opponent, so you can
judge reach. Drop an `agent/batches/batch_NNNN_*.json` file on the page to step through a batch's kept
moves (for "generate 20, look at all 20"). `?mock` shows the mock motions. Keys: ←/→, space, `,` `.`, 1/2/3.

## Code map

| File | What |
| --- | --- |
| `src/main.ts` | wires everything; the frame loop; keyboard |
| `src/game/flow.ts` | lobby → best of 3 × 60 s → match end; room messages → sim calls; pushes `state`/`event` to phones |
| `src/contract.ts` | local copy of `contract/sim.ts` (verbatim from CLAUDE.md) + the room/HTTP shapes we assume |
| `src/net/` | HTTP API (motion cache, job polling) and the room WebSocket (auto-reconnect) |
| `src/g1/` | MJCF reader + forward kinematics (matches MuJoCo to 1e-15 m) |
| `src/render/stage.ts` | renderer, side camera that follows the fighters, bloom, shake |
| `src/render/robot.ts` | draws a G1 from `FighterState.bodies`; costume anchor points |
| `src/render/costumes.ts` | the five fairy-tale costume shells (render only) |
| `src/render/arena.ts` | the fairy ring in a moonlit forest clearing |
| `src/render/effects.ts` | ember_orb, wisp_bolt, frost_crystals, moon_smoke, thorn_burst, fairy_dust, shockwave |
| `src/ui/` | storybook HUD and screens (lobby with QR code, match end) |
| `src/audio/` | narrator TTS + synthesized sound effects |
| `src/mock/` | fake server + phones, procedural G1 motions, and `StubSim` (kinematic stand-in for `src/sim`) |
| `src/viewer.ts` | the motion viewer |

## For Sudeep: plugging in the real sim

- Replace `new StubSim(assets.model)` in `src/main.ts` with the real sim. It only needs to implement
  `Sim` from `contract/sim.ts`.
- The same G1 model is served at `/g1/g1.xml` (meshes in `/g1/assets/`), so MuJoCo WASM can load it from there.
- `FighterState.bodies` must use the MJCF body names (`pelvis`, `torso_link`, `left_elbow_link`…), in MuJoCo
  world coordinates (Z up, meters, quaternion w-x-y-z). The renderer converts to three.js itself.
- `reset()` is called at the start of every round as well as every match (the contract has no per-round reset),
  and when Esc goes back to the lobby.
- The game screen survives a bad frame from the sim: a body with a NaN pose keeps its last good pose, a NaN hit
  point falls back to the defender's chest, and an exception in `step()` is logged (once per 600 frames)
  without stopping the loop. Check the console for `frame failed`.
- A live wildcard whose fighter can't act when it's `ready` (down, stunned, mid-move, between rounds) casts as soon
  as `canAct()` allows, for up to 8 s of fight time, so `canAct()` should turn true again once a fighter is up.
- Stub rule worth copying: a signature move that lands always knocks down (`src/mock/stubSim.ts`). Without it, a
  judge's physical Forge move often deals less than a knockdown.

## Assumed until contract/ exists

HTTP: `GET /idle`, `GET /motion/{id}`, `GET /library/stats`, `GET /leaderboard`, `GET /job/{id}`.
Room messages, all JSON with a `type` field:

- phone → game: `join {player?, nickname, character}`, `tap {player, action}`, `leave {player}`
- server → game: `play {player, move, loudness, motion?}`, `charge {player, job, guess}`, `ready {player, job, move}`,
  `narrate {text}` (Commentator lines; not in CLAUDE.md yet)
- game → phones: `state {round, timer, wins, players, seats}` 10×/s, `event {event}` (sim events + round_start, match_end)
