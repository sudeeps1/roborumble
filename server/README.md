# server/: the game server

FastAPI on port 8000: Kimodo jobs, the move library, shout matching, live wildcards, the narrator and the
room WebSockets. Endpoints and messages: `contract/api.md`, `contract/ws.md`.

```
./server/run.sh                 # mock engine: fake G1 motions, runs on any laptop
ENGINE=kimodo ./server/run.sh   # real Kimodo, on the GPU box
```

The mock engine lets the client, agent and phones run against the real API before Kimodo works.

## Settings (environment variables)

| Variable | Default | |
| --- | --- | --- |
| `ENGINE` | `mock` | `kimodo` loads `Kimodo-G1-RP-v1` once at startup |
| `DIFFUSION_STEPS` | 50 | overnight jobs (Kimodo's default is 100) |
| `LIVE_DIFFUSION_STEPS` | 30 | wildcards and Forge: speed first |
| `BATCH_SIZE` | 8 | overnight prompts per Kimodo call |
| `MIN_GEN_SECONDS` | 0 | if sub-2 s G1 clips look bad, set 2.0: clips get at least this long |
| `MATCH_THRESHOLD` / `SIGNATURE_THRESHOLD` | 0.5 / 0.4 | shout matching |
| `STT` | `none` | `muse` (needs `MUSE_API_KEY`), `whisper` (needs faster-whisper), or `none` (phones send `transcript`) |
| `CLAUDE` | `auto` | wildcard specs by Claude when `ANTHROPIC_API_KEY` is set; `off` forces keyword specs |
| `LIBRARY_DIR` | `library/` | moves.jsonl, motions/, uses.json |
| `PORT` | 8000 | |

`pip install sentence-transformers` turns on embedding matching (all-MiniLM-L6-v2). Without it, matching is fuzzy text.

## GPU box setup (Ubuntu, NVIDIA GPU with 24 GB or more)

1. Hugging Face: request access to `meta-llama/Meta-Llama-3-8B-Instruct` (manual approval), make a read
   token, then `hf auth login`.
2. Python 3.10 + PyTorch with CUDA, then Kimodo:
   ```
   conda create -n kimodo python=3.10 -y && conda activate kimodo
   pip install torch --index-url https://download.pytorch.org/whl/cu124
   pip install "kimodo[all] @ git+https://github.com/nv-tlabs/kimodo.git"
   pip install -r server/requirements.txt sentence-transformers
   ```
3. Time one clip before anything else, and post the number:
   ```
   time kimodo_gen "A person steps forward and throws a right hook" --model Kimodo-G1-RP-v1 --duration 1.2 --output hook
   ```
4. `ENGINE=kimodo ./server/run.sh`, then `curl localhost:8000/health` (`load_ms`, `last_generation_ms`).
5. Overnight library: `cd agent && SERVER_URL=http://localhost:8000 ./run.sh --dry-run --batch-size 20` first
   (agent/README.md).

## HTTPS (phones need it for the mic and camera)

Point the domain at the box and run Caddy with `server/Caddyfile` (`sudo caddy run --config server/Caddyfile`).
It gets a certificate on its own and forwards everything, WebSockets included, to :8000. The server
serves `client/dist` at `/` and `phone/dist` at `/phone/` when they're built.

## Muse Voice Transcribe

`STT=muse MUSE_API_KEY=...` sends each shout as WAV to `https://api.meta.ai/v1/asr/transcribe`. The field
names and response shape aren't confirmed by official docs yet (see `voice.py`): check the first real call
in the server log and adjust `MUSE_FILE_FIELD` or `_muse_text()`. Phones should record mono 16 kHz 16-bit
WAV; other formats need ffmpeg on the box.

## Files

| File | |
| --- | --- |
| `app.py` | routes, shouts (match, play, wildcard), static apps |
| `engine.py` | `KimodoEngine` and `MockEngine` |
| `jobs.py` | the GPU queue: one worker, live before overnight, overnight batched, motion reuse |
| `library.py` | moves.jsonl, motions, uses, stats, originality |
| `motion.py` | quality checks, hit_frame, motion features, stability estimate |
| `matcher.py` | shout to move: embeddings or fuzzy |
| `wildcard.py` | live specs: Claude with agent/specs.py rules, keyword fallback |
| `narrator.py` | storybook narrator lines |
| `rooms.py` | room WebSockets |
| `voice.py` | speech to text |
| `g1.py` | joint order, hit joints, joint limits |

## Not built yet

Forge (`POST /forge`, pose fitting to Kimodo constraints) and Duo Forge. `engine.py` already passes
constraints through, but `load_constraints_lst`'s signature is unverified.
