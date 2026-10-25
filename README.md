# Infinite Fighter

A fairy-tale robot fighting game where every move is invented. Two Unitree G1 humanoids duel in an
enchanted arena, and players use their phones as controllers: shout a move, or act one out on camera,
and NVIDIA Kimodo turns it into real G1 joint motion in about a second. A Claude agent invented the
first few hundred moves; every move a player invents joins the shared library with their name on it.

Built at HackTX 2026 for Most Entertaining, Best Pitch and Meta (Muse Voice Transcribe).

## How it plays

1. **Join.** The game screen shows a QR code. Each player scans it and their phone becomes the
   controller: a website, no app.
2. **Shout a move.** Hold to talk. Meta's Muse Voice Transcribe turns the shout into text and the
   server matches it against the move library (573 moves) in milliseconds, so "uppercut" or "Frost
   Giant's Tread" plays at once. Anything new ("summon the crab king") is a live wildcard: Claude writes
   the move, Kimodo generates the motion while the robot charges up, and the move joins the library
   credited to the player.
3. **Forge a move.** Act a move out in front of your phone for 5 seconds. MediaPipe tracks your pose on
   the phone (only landmarks leave it, never video), the server fits a G1 to your poses, and Kimodo
   turns them into a polished move with your poses as keyframes. Name it, keep it, fight with it.
4. **Credit.** When anyone uses your move, the screen shows who invented it, and the most-used player
   moves top the leaderboard.

## How it works

```
phone/  (controller website)  --HTTPS + WebSocket-->  server/  (FastAPI on an RTX 4090)
  hold to talk, Forge camera,                           Kimodo-G1 motion, job queue, quality checks,
  spell deck, dodge/block taps                          Muse speech to text, move matching, Claude
                                                        live wildcards, Forge, library, rooms, narrator
passive/  THE GAME SCREEN: MuJoCo physics, arena,   <--WebSocket rooms--+
          effects, HUD (and the simulator rig)                       |
client/   earlier game screen, stub sim (testing)     agent/  Claude Library Builder: writes moves,
characters/  elf skin drawn over the G1                       validates and dedupes them, POSTs them
                                                              to the server for Kimodo
```

- **Kimodo** (`Kimodo-G1-RP-v1`) generates Unitree G1 joint trajectories from text, plus full-body
  keyframe constraints for the Forge. One live move takes about 1 s on an RTX 4090, 10 batched about
  5 s. Every move is a real G1 trajectory: 36 numbers per frame at 30 fps, the format MuJoCo poses
  the robot with.
- **Claude** (`claude-opus-5-5`, structured outputs) writes move specs. In one run the agent wrote 250
  moves in 15 minutes and 203 made it into the library (most of the rest were names we already had).
  Live wildcards are written at low effort while the robot charges up. Kimodo only ever sees a plain
  body description ("a person steps forward and thrusts both palms out"); names and effects stay on
  the spec.
- **Quality checks** on every motion (barely moved, drifted away, sank into the floor, broke joint
  limits, NaN frames), and a hit frame from forward kinematics: when the fist or foot reaches out.
- **Muse Voice Transcribe** (Meta) hears every shout; matching uses all-MiniLM-L6-v2 embeddings.
- **MuJoCo** runs the G1s in `passive/`: NVIDIA's SONIC controller keeps them balanced, and a punch only
  lands if the fist reaches the other body.

## Repo

| Folder | What | Who |
| --- | --- | --- |
| `server/` | Game server: Kimodo, jobs, library, matching, voice, Forge, rooms | Vaibhav |
| `phone/` | Phone controller website, served by the server at `/phone` | Vaibhav |
| `agent/` | Overnight Claude Library Builder | Jerry |
| `passive/` | **The game:** the fight screen (MuJoCo physics, night forest arena, HUD, rounds, phones via the server's rooms) at `/`, and the simulator rig at `/rig.html` | Sudeep |
| `client/` | The earlier game screen with a stub sim, kept for testing | Jerry |
| `characters/` | Elf skin drawn over the G1 | Sudeep |
| `contract/` | HTTP API and WebSocket messages between the parts | everyone |
| `docs/` | Kimodo notes, GPU setup, spell videos | |

## Run it

Each folder runs with one command; its README has the details.

```bash
./server/run.sh                          # game server on :8000 with the mock engine (any laptop)
ENGINE=kimodo ./server/run.sh            # real Kimodo on a GPU box (server/setup_pod.sh installs it)
cd passive && npm start                  # THE GAME: open http://localhost:5180/?room (rig: /rig.html; setup: passive/README.md)
                                         # phones join at <server>/phone/?room=CODE
cd client && npm install && npm run dev  # the earlier game screen with a stub sim (testing only)
cd agent && ./run.sh --batches 1         # Library Builder (needs ANTHROPIC_API_KEY)
```
