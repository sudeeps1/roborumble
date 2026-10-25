# Handoff: client/ and agent/

Jerry built the game screen (`client/`) and the overnight Library Builder (`agent/`) on `v1`. The rest of
that work is split between Sudeep (`client/`) and Vaibhav (`agent/` and the server side). CLAUDE.md's
owners table still lists Jerry for both folders.

Also in `docs/`: [review-findings.md](review-findings.md) (50 review findings, none fixed yet) and
[kimodo-g1.md](kimodo-g1.md) (sourced notes on Kimodo's G1 output, CLI and constraints).

## Run it

```
cd client && npm install && npm run mock     # whole match, no server: fake phones on the keyboard
cd agent && ./run.sh --offline --batches 1    # Library Builder test: fake Claude + fake server
```

- Mock keys: Enter starts, Space toggles autoplay. P1: `1`-`6` moves, `7` signature, `T` live wildcard, `W A S D` taps.
  P2: `U I O P [ ]`, `Y`, `H`, arrow keys. Lobby: `A`/`D` and `J`/`L` pick characters. `M` mutes.
- Against the real server: `SERVER_URL=http://<gpu-box>:8000 npm run dev`. The browser calls `/api/*` and Vite
  forwards it, including the room WebSocket.
- `client/viewer.html` plays generated motions next to a standing opponent. Drop an `agent/batches/*.json` on it to review a batch.
- `?debug` puts `window.__game = {stage, sim, robots, flow, effects, hud}` on the page.

## Status

- **Tested** (headless Chrome, real GPU): a full best-of-3 mock match with every sim event, live wildcards, signature moves,
  taps, the narrator and the library counter. The G1 forward kinematics match MuJoCo to 1e-15 m. The agent's offline loop
  works, including kill and resume, duplicate dropping, and motion reuse with real all-MiniLM-L6-v2 embeddings.
- **Never tested**: a real Claude call (no API key on Jerry's laptop), the real server, the real sim, real Kimodo motions, phones.
- **Black frames**: whole frames rendered black during fights until the multisampled composer target was removed
  from `client/src/render/stage.ts` (0 black frames in 240 afterwards). One reviewer thinks the real cause is a NaN from `pow()` in
  the beam shader (`client/src/render/fx/meshes.ts:104`); unverified. If black frames come back, look there first.

## Contract the code assumes

Nothing below is in `contract/` yet. The client parses all of it in `client/src/net/` and `client/src/contract.ts`; the agent in `agent/server.py`.

HTTP:
- `GET /idle`, `GET /motion/{id}` → `{id, fps, joint_names, qpos}`. The Kimodo CSV has neither fps nor joint names, so the server adds them.
- `GET /library/stats` → `{total, by_type, by_source}`. `GET /leaderboard` → `[{id, name, creator, uses, type}]`.
- `GET /job/{id}` → `{status: "running"}`, `{status: "done", move}` or `{status: "rejected", check}`.
- `POST /generate` with a spec that already has `motion_id`: reuse that motion and skip Kimodo. The agent relies on this.
- New: `GET /library/moves` → every move's `name`, `aliases`, `kimodo_prompt` and `motion_id`, for the agent's duplicate checks.

Room, `WS /room/{code}?role=game`, JSON with a `type` field:
- phone → game: `join {player?, nickname, character}`, `tap {player, action}`, `leave {player}`
- server → game: `play {player, move, loudness, motion?}`, `charge {player, job, guess}`, `ready {player, job, move}`,
  and new, `narrate {text}` for Commentator lines
- game → phones: `state {round, timer, wins, players, seats}` 10 times a second (`seats` carries the characters picked in the lobby),
  `event {event}` (sim events plus `round_start` and `match_end`)
- `move.signature`: CLAUDE.md's move spec has no such field. The server should set it when the speaker matched one of their own Forge moves.
- Character ids passed to `sim.init()`: `bramble`, `marigold`, `flicker`, `rime`, `hush` (`client/src/config.ts`).

## Vaibhav

1. Write `contract/api.md` and `contract/ws.md` from the list above, or change it. Note that `ready` must carry the
   move: today a `ready` without one silently drops the wildcard (confirmed, see the review).
2. Serve `phone/` over https and run the client with `VITE_JOIN_URL=https://<phone app>/?room={code}`. Phone
   browsers only allow the mic and camera on https pages, and the QR code's default (the laptop's `:8000` over http) can't work (confirmed).
3. First real Library Builder run, on the GPU box with `ANTHROPIC_API_KEY` (steps in `agent/README.md`):
   - `./run.sh --dry-run --batch-size 20`, then read `agent/batches/*.md`.
   - Fix `SYSTEM_PROMPT` in `agent/specs.py` until all 20 specs look right.
   - `./run.sh --batches 1 --batch-size 20` and watch all 20 motions in the viewer. Then start the overnight run.
4. `agent/` fixes from the review. The four high ones:
   - mirrored moves (left vs right) can share a motion
   - a 4xx from `POST /generate` is retried forever
   - no job timeout
   - the name check drops plain-combat names like "Left Hook"
5. Kimodo, from [kimodo-g1.md](kimodo-g1.md) ("What this changes in CLAUDE.md"):
   - Use `Kimodo-G1-RP-v1`; only RP writes the CSV. Pass `--model` on every call.
   - The Forge slider is `--cfg_weight <text> <constraint>`.
   - `kimodo_gen` reloads the model on every call, so keep it loaded with the Python API.
   - Never put a `.` in a prompt.
   - Clips under 2 s have never been tested on G1.
   - The quality checks need tolerances: joint limits are exceeded by up to 7.6° and feet go down to -4.8 cm.
   - Constraints need full 34-joint poses, so Forge needs IK.

## Sudeep

1. Swap the real sim in for `new StubSim(assets.model)` in `client/src/main.ts`. The same G1 is served at
   `/g1/g1.xml` (meshes in `/g1/assets/`, fetched by `client/scripts/fetch-g1.mjs`). `FighterState.bodies` uses MJCF body names,
   MuJoCo world coordinates (Z up, meters) and quaternions w-x-y-z. Fighters start at x = -0.6 (P1, facing +X) and +0.6.
2. Settle the round rules in `client/src/game/flow.ts`:
   - `reset()` is called at every round start.
   - On a 60 s timeout the client picks the winner by HP, and phones and the Commentator get no `round` event (confirmed).
   - `init()` runs again when the characters change between matches while `step()`/`state()` keep running (confirmed).
3. Real Kimodo data in the sim ([kimodo-g1.md](kimodo-g1.md), section 1):
   - The root quaternion flips sign between frames, so align before blending.
   - Frame 0 starts 1-7 cm off the origin, so re-base.
   - Joint angles go up to 7.6° past the limits, so clamp the targets.
4. `client/` fixes from the review, starting with the confirmed ones:
   - a `ready` without a move drops the wildcard
   - the signature bonus depends on a field the server may not send
   - a late `charge` leaves a fighter charging
   - attacks already in flight still land after a timeout
   - no `round` event on a timeout
   - the sim is re-initialized while it's still being stepped
   - a phone rejoining mid-fight changes the look but not the sim
   - the QR join URL (shared with Vaibhav's item 2)

   Then the rest by severity. `client/src/mock/` only matters until the real sim lands.
