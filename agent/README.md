# agent/ — overnight Library Builder

Claude writes fairy-tale move specs in batches; the server turns each one into a G1 motion with Kimodo.
The loop never stops on errors and resumes where it left off after a crash or Ctrl-C.

```
./run.sh                      # run forever (creates .venv on the first run)
```

Needs Python 3.10+, Claude credentials (`ANTHROPIC_API_KEY`, or an `ant auth login` profile) and the
game server (`SERVER_URL`, default `http://localhost:8000`).

## First night: start small (CLAUDE.md)

1. `./run.sh --dry-run --batch-size 20` asks Claude for 20 specs, checks them, and posts nothing.
   Read `batches/batch_0001_*.md`: every spec, and why any were dropped.
2. Fix the prompt template (`SYSTEM_PROMPT` in `specs.py`) and repeat until all 20 look right.
3. `./run.sh --batches 1 --batch-size 20` generates those 20 for real. Watch all 20 motions before going on.
4. `nohup ./run.sh > run.out 2>&1 &` for the night. `log.txt` gets one line per hour.

A bad template left running all night gives thousands of bad moves.

## What one batch does

1. `GET /library/stats` → the two thinnest types get at least 40% of the batch.
2. One Claude call for `--batch-size` specs on the next theme. The themes rotate: plain combat, knights and dragons, witches and potions, forest spirits and beasts, winter tales, plain combat again, moonlight and night creatures, giants and trolls, enchanted household objects. The call includes the names already kept for that theme.
3. Validate each spec. Drop it if any field is outside the spec, if `kimodo_prompt` doesn't start with "a person" (or "an angry person" and the like), if it contains a period (Kimodo splits prompts on every `.`, decimals included), if it runs over 26 words, if it uses fantasy words (spell, fire, moon…), or if it repeats the move's name.
4. Drop specs whose name or any alias already exists in the library, in this agent's history, or earlier in the batch.
5. If a `kimodo_prompt` is a near-duplicate (all-MiniLM-L6-v2 cosine over 0.95) of one already generated, the spec gets that `motion_id`. A near-duplicate of an earlier spec in the same batch waits for that spec's motion.
6. `POST /generate` with at most `--max-pending` jobs in flight, then poll `GET /job/{id}` every 250 ms.
7. Record kept and rejected per hour in `log.txt`. The batch file in `batches/` shows each spec's outcome.

The next Claude call starts while the previous batch is still generating, so the GPU doesn't wait on Claude.

## Flags

| Flag | Default | |
| --- | --- | --- |
| `--batches N` | forever (1 with `--dry-run`) | Claude calls to make this run, then finish their jobs and exit |
| `--batch-size N` | 50 | specs per Claude call |
| `--server URL` | `$SERVER_URL` or `http://localhost:8000` | game server |
| `--dry-run` | off | check specs, don't POST /generate |
| `--theme NAME` | rotate | one theme only, e.g. `--theme "winter tales"` |
| `--max-pending N` | 6 | jobs in flight |
| `--effort` | high | Claude effort (CLAUDE.md: high overnight) |
| `--library-file PATH` | | `library/moves.jsonl`, if the server has no `GET /library/moves` |
| `--offline` | off | fake Claude and the server, to test the loop without keys or a GPU |
| `--no-embeddings` | off | strict text comparison instead of sentence-transformers |
| `--state PATH` | `state.json` | where queued specs, jobs in flight and counters are saved |

## Files

- `builder.py`: the loop, the CLI, and resuming.
- `specs.py`: prompt template, themes, JSON schema, the Claude call, and spec validation.
- `server.py`: the HTTP client, plus a fake server for `--offline`.
- `state.py`: saved state, hourly counters, and the near-duplicate prompt index.
- Output (gitignored): `log.txt`, `batches/`, `state.json`, `errors.log`.

## Claude call

`claude-opus-5-5` with streaming, structured output (`output_config.format` JSON schema) and effort `high`.
Thinking is always on for this model. The code checks `stop_reason` for `refusal` before reading the content.
Refusal fallbacks are on: `fallbacks="default"` under the `server-side-fallback-2026-07-01` beta. If a safety classifier declines a batch, the API retries it on Anthropic's recommended fallback model. To turn that off, remove those two arguments in `specs.ask_claude`.

## What the server needs (contract)

- `GET /library/stats` gives total moves and counts per type and per source.
- `POST /generate` takes a move spec and returns `{"job": id}`. **If the spec already has `motion_id`, reuse that motion and skip Kimodo.**
- `GET /job/{id}` returns `{"status": "running"}`, `{"status": "done", "move": {...}}`, or `{"status": "rejected", "check": "root_drift"}`.
- **Proposed:** `GET /library/moves` gives every move's `name`, `aliases`, `kimodo_prompt` and `motion_id`. Without it, the duplicate checks only see moves this agent made (or `--library-file`).
