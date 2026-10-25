# data/: the spell library snapshot

`library-snapshot/` is the game server's move library as it was at HackTX, Oct 25 2026, 11:30 CDT:
668 moves (the Claude agent's, the live wildcards players invented, and the showcase spells).

- `moves.jsonl`: one move spec per line (name, aliases, type, kind, effect, power, hit frame, creator, ...)
- `motions/`: each motion's Unitree G1 joint trajectory (36 numbers per frame, 30 fps), made by Kimodo
- `uses.json`, `clips.json`: use counts, and the server's everyday animation clips

The Forge's raw pose recordings are left out: they are people's body movement.

## Run the game with it

```bash
LIBRARY_DIR=data/library-snapshot ./server/run.sh            # any laptop: every library move plays its real motion
LIBRARY_DIR=data/library-snapshot ENGINE=kimodo ./server/run.sh  # GPU box: new shouts and the Forge make new moves too
```

The server copies new moves into `LIBRARY_DIR`, so copy the snapshot first if you want to keep it clean.

## How it ran at HackTX

- Game server: FastAPI on a RunPod RTX 4090, `https://kr2vjwse2bhd6t-8000.proxy.runpod.net` (`/health` for status).
  Keys are never in the repo: the server reads them from `/root/.muse_key` and `/root/.anthropic_key`.
- Phones: `<server>/phone/?room=CODE`, or scan the QR code on the big screen.
- Big screen (the physics fight screen): `cd passive && npm install && npm run setup && npm run dev`, then
  `http://localhost:5180/?room=CODE` in Chrome. `&script` plays the pitch video's fixed one-round fight after
  Enter; `&fill=ai` lets one phone play the AI. Open the big screen in Chrome only, one screen per room code.
