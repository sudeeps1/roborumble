# Server HTTP API

Implemented in `server/app.py`. Every route is served both bare and under `/api` (the client calls
`/api/...`; Vite's dev proxy strips the prefix, a built client served by the server keeps it).

JSON everywhere except `POST /voice` (multipart). Jobs are plain HTTP; poll every 250 ms.

| Endpoint | Sends | Returns |
| --- | --- | --- |
| `GET /health` | nothing | `{ok, engine, model, load_ms, last_generation_ms, queue, jobs:{done,rejected,reused}, library, idle_ready, matcher, stt, claude, uptime_s, steps}` |
| `GET /idle` | nothing | the idle stance Motion (404 for a few seconds after a fresh start, while it generates) |
| `GET /motion/{id}` | nothing | one Motion. Immutable, cache forever. |
| `POST /generate` | a move spec | `{"job": id}`. 400 if the spec has no name, no `kimodo_prompt` and no `motion_id`, or an unknown `motion_id`. |
| `GET /job/{id}` | nothing | `{"status": "running"}`, `{"status": "done", "move": Move}` or `{"status": "rejected", "check": name}`. Never any other status. 404 for an unknown id. |
| `GET /library/stats` | nothing | `{total, by_type: {physical, fire, ice, lightning, shadow}, by_source: {agent, forge, live}}` |
| `GET /library/moves` | nothing | every move: `[{id, name, aliases, kimodo_prompt, motion_id, type, kind, source, creator}]` (the agent's duplicate checks) |
| `GET /move/{id}` | nothing | one Move |
| `GET /leaderboard` | nothing | `[{id, name, creator, uses, type}]`, player-made moves (forge and live) by uses |
| `GET /deck?nickname=N` | nothing | `{nickname, moves: [Move]}`, that player's own moves, newest first (the phone's grid) |
| `POST /voice` | multipart: `room`, `player` (1 or 2), `loudness` (0..1), and `audio` (WAV, mono, 16 kHz, 16-bit) or `transcript` | `{transcript, stt_ms, result: "play", move, score, signature}` or `{transcript, stt_ms, result: "charge", job, guess}`. The same result is pushed to the game screen over the room WebSocket. `{"result": "silence"}` when nothing was heard. 503 if the server can't transcribe (send `transcript` instead). |
| `POST /match` | `{text}` or `{text, room, player, loudness}` | Without a room: `{hit, score, move, guess}` (debugging). With a room and player: exactly like a shout (typed backup). |
| `GET /room/{code}` | nothing | `{room, game_connected, seats}` |
| `GET /clips` | nothing | `[{name, prompt, duration, motion_id, status}]`, character animations that aren't moves |
| `GET /clip/{name}` | nothing | one clip's Motion (e.g. `idle_hush`, `get_up`, `victory`) |
| `POST /clip` | `{name, prompt, duration}` | `{job, clip}`; makes or remakes a clip (motion only, never a move) |
| `POST /forge` | `{nickname, name, landmarks: [T][33][3], fps, wild: 0..1}` | `{job, fit, prompt, keyframes}` |
| `GET /forge/{job}` | nothing | `running`, `rejected`, or `{status: "done", card, preview: [T][34][2], fit, kept}` |
| `POST /forge/{job}/keep` | nothing | the saved Move (source `forge`) |
| `WS /room/{code}?role=game\|phone` | contract/ws.md | contract/ws.md |

## Motion
```json
{ "id": "mo_00099", "fps": 30, "joint_names": ["left_hip_pitch_joint", "...29 names"],
  "qpos": [[x, y, z, qw, qx, qy, qz, "...29 hinge angles"], "...one row per frame"] }
```
Rows are Kimodo's G1 CSV as-is: MuJoCo axes (Z up, +X forward), meters and radians, root quaternion
w-first. Frame 0 is near the origin but not exactly on it, the quaternion sign can flip between frames,
and hinges can be up to ~8 deg past the joint limits (docs/kimodo-g1.md). The sim re-bases and clamps.

## Move
Everything in CLAUDE.md's move spec, plus `uses` (play count) and `signature`.
```json
{ "id": "mv_00412", "name": "Thunder Palm", "aliases": ["thunder palm", "shock palm"], "type": "lightning",
  "kind": "projectile", "effect": "wisp_bolt", "kimodo_prompt": "a person steps forward and thrusts both palms out at chest height",
  "hit_joint": "r_hand", "duration": 1.2, "power": 2, "stability": 0.7, "originality": 0.42,
  "motion_id": "mo_00099", "hit_frame": 18, "source": "agent", "creator": null, "created_at": 1792890000,
  "uses": 12, "signature": false }
```
- `signature` is true only in a `play` push, when the shouting player matched one of their own Forge moves.
- Server-filled fields: `hit_frame` (frame where `hit_joint` moves fastest), `originality` (1 minus the
  closest motion's similarity), `stability` (an estimate until the Balance Referee runs moves in physics),
  `duration` (actual clip length).

## POST /generate rules
- A spec with `motion_id` reuses that motion and skips Kimodo; it finishes at once.
- A spec whose `kimodo_prompt` exactly matches an earlier one (case and punctuation ignored) also reuses.
  Near-duplicates are the agent's job, so left/right mirrors never share a motion.
- Periods are stripped from `kimodo_prompt` (Kimodo splits prompts on them).
- Quality checks reject: `nan_frames`, `barely_moved`, `root_drift` (> 1.5 m), `below_floor`, `joint_limits`
  (> 12 deg past a limit), or `error: ...` if Kimodo threw.
