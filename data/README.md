# data/: the spell library snapshot

`library-snapshot/` is the game server's spell library at the end of HackTX 2026: **594 spells**
(565 from the Claude Library Builder, 25 forged by players, 4 invented live by shouting) and 586 motion files.
Retired moves (crowd chatter the always-on mic picked up during testing) are left out.

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

- Game server: FastAPI on a RunPod RTX 4090 (shut down after the event; `server/setup_pod.sh` rebuilds one).
  Keys are never in the repo: the server reads them from `/root/.muse_key` and `/root/.anthropic_key`.
- Phones: `<server>/phone/?room=CODE`, or scan the QR code on the big screen.
- Big screen (the physics fight screen): `cd passive && npm install && npm run setup && npm run dev`, then
  `http://localhost:5180/?room=CODE` in Chrome. `&script` plays the pitch video's fixed one-round fight after
  Enter; `&fill=ai` lets one phone play the AI. Open the big screen in Chrome only, one screen per room code.
