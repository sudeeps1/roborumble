# agent/: overnight Library Builder

Runs all night next to the game server. Each batch it asks Claude (`claude-opus-5-5`, effort high,
JSON structured output) for move specs, validates them, dedupes them against the server's library,
and POSTs them to `/generate`, where Kimodo turns each `kimodo_prompt` into a G1 motion. Then it
polls the jobs and logs what was kept and rejected. It never crashes, and a restart resumes cleanly
with no duplicate submissions. Server API: `contract/api.md`.

`specs.py` (and `state.py`, which it imports) stay as they are: the builder doesn't use them, but
`server/wildcard.py` imports `specs.py` for the live wildcard rules.

**The one command (overnight, from `agent/`):**

```bash
./run_forever.sh --server http://localhost:8000
```

`./run.sh [flags]` runs the builder once (a dry run, a push, a few batches). On its first run it
creates `.venv` and installs `requirements.txt` (anthropic, pydantic, sentence-transformers); run
`./run.sh --help` once to get that out of the way. `AGENT_PYTHON=/path/to/python` skips the venv
and uses that interpreter (on the GPU box, the server's `/root/venv/bin/python` has everything).
`run_forever.sh` goes through `run.sh`, so both use the same interpreter.

Credentials: `ANTHROPIC_API_KEY` (or `ant auth login`). Never commit or log keys. Without
credentials the builder prints one line and exits with code 3 in under a second.

## 1. Dry run: 20 specs, read every one

```bash
./run.sh --dry-run --batches 1 --batch-size 20 --server <server url>
```

It posts nothing and never touches `state.json`. It reads the server's library (`GET
/library/moves`) to dedupe against it if the server answers, and works without it too. It prints a
numbered table of every kept spec (name, type, kind, effect, joint, power, duration, prompt,
aliases, auto-fixes) and every dropped spec with its reason, and writes `dryrun/dryrun-<UTC>.json`
and `dryrun/latest.json`. Batch 0 is always plain combat.

## 2. Push the 20 and look at all 20 moves

```bash
./run.sh --push dryrun/latest.json --server <server url>
```

It submits the specs without calling Claude, waits for every job, and prints KEPT / REJECTED per
spec with the move id, motion id, stability, originality, the failed check, and any alias that was
stripped. It also writes `batches/push-<UTC>.json`: drop that file on the client's motion viewer
(`client/viewer.html`) to step through every kept move next to a standing opponent. Pushing the
same file twice is safe: names that already exist are dropped.

Jerry's two dry runs (prompt v2, 20 plain combat + 20 witches & potions) push cleanly: 40 of 40
kept on the mock server, with "hook" stripped from Fire Punch and "clap" from Thunder Clap
(generic shouts stay on physical moves).

## 3. Overnight

Only one builder per server: two would race each other for the same new names.

On the GPU box, next to the server (`apt-get install -y tmux` if it's missing):

```bash
tmux new -d -s agent -c /root/roborumble/agent \
  -e ANTHROPIC_API_KEY="$(cat /root/.anthropic_key)" -e SERVER_URL=http://localhost:8000 \
  -e LIBRARY_DIR=/root/library -e AGENT_PYTHON=/root/venv/bin/python \
  ./run_forever.sh
tail -f /root/roborumble/agent/log.txt
```

From a laptop, against the server's HTTPS URL (keep the lid open and the charger in: `caffeinate
-s` only holds on AC power, and closing the lid still sleeps the Mac):

```bash
cd agent && ./run.sh --help > /dev/null       # first time only: builds .venv
caffeinate -is ./run_forever.sh --server https://<pod-id>-8000.proxy.runpod.net
```

The RunPod proxy is behind Cloudflare, which refuses Python's default User-Agent (HTTP 403,
"Error 1010: Access denied"). The agent sends its own User-Agent and, if Cloudflare refuses that
too, curl's. Check the first `SERVER` line in log.txt: it should show the server's health
(`"engine": "kimodo"`). If it says error 1010, stop the loop and start it again with
`AGENT_USER_AGENT=<a User-Agent the proxy accepts>`. While the proxy refuses the agent, it only
backs off: no Claude calls, no specs dropped.

- Watch it: `tail -f log.txt`, or `tmux attach -t agent` (detach with Ctrl-b d).
- Stop it: `tmux kill-session -t agent`, or Ctrl-C. run.py saves its state first.
- Load an edited `prompt.py` without stopping the loop: `pkill -f "python.* run.py"`.
  run_forever.sh restarts it 10 s later and it resumes where it was.
- run_forever.sh restarts run.py whenever it exits: 10 s later, or 60 s later after exit code 3
  (credentials or model problem) or 4 (another run.py holds the state file). Exit code 2 (a bad
  flag) ends the loop. Every restart is a `RESTART` line in log.txt. It refuses `--dry-run`,
  `--push` and `--batches N`, which it would otherwise repeat forever: run those with `./run.sh`.
- Paths in the arguments are relative to `agent/` (the scripts cd there).
- Cost: about 400 output tokens per spec at effort high (Jerry's dry runs), so roughly $0.40 per
  batch of 50. One Claude call runs at a time and takes about 3 minutes, so the loop spends roughly
  $8 to $12 an hour, less when the GPU is the bottleneck. Stop it when the library is big enough.

## Flags (run.py, through run.sh)

| Flag | Default | What |
| --- | --- | --- |
| `--batches N` | 0 | Claude batches to request in this run; 0 = forever. A dry run treats 0 as 1. Refused batches count. |
| `--batch-size N` | 50 | specs per Claude call |
| `--dry-run` | off | post nothing: validate, dedupe, write `--out` plus `dryrun/latest.json`, print the table |
| `--out FILE` | | dry run output (`dryrun/dryrun-<UTC>.json`), or with `--push` the viewer file (`batches/push-<UTC>.json`) |
| `--push FILE` | | POST the specs of a dry-run JSON (or a JSON list of specs) to `/generate`, wait, print results |
| `--theme NAME` | rotation | force one theme; a unique prefix works (`--theme winter`) |
| `--server URL` | `$SERVER_URL` or `http://localhost:8000` | game server (a URL ending in `/api` works too) |
| `--library PATH` | `$LIBRARY_DIR/moves.jsonl` | the server's library file, read only, used only when `GET /library/moves` fails, and by default only for a server on this machine |
| `--state PATH` | `state.json` | agent state (atomic writes) |
| `--log PATH` | `log.txt` | log file |
| `--max-inflight N` | 8 | jobs submitted but unfinished at once |
| `--poll SECONDS` | 1 | time between polls of one job |
| `--fake-llm` | off | canned specs from `fake_specs.json`, no API key or network to Anthropic |
| `--no-fallbacks` | off | don't send the server-side refusal fallback beta |
| `--effort` | high | low, medium, high, xhigh or max |
| `--model` | `claude-opus-5-5` | |

Write flags out in full: run.py refuses abbreviations (`--dry` is an error, exit code 2), so
run_forever.sh can always spot a one-shot flag.

## What one batch does

1. **Library.** `GET /library/moves` at start, before every batch and every 5 minutes. Every
   move's name and aliases go into the duplicate registry (agent, Forge and live moves alike). For
   every agent and live motion, the `kimodo_prompt` that made it (the first move with that
   `motion_id`, not the later moves that reused it) goes into the motion reuse index, so reuse
   can't chain from prompt to prompt away from what the motion shows. Forge motions follow the
   player's acting more than their prompt, so they aren't reused. If the
   request fails, the server's `moves.jsonl` stands in when the server runs on this machine, else
   the last snapshot stays. Names this agent made that the library no longer has (it was reset,
   or `state.json` came from another server) are released so they can be made again.
2. **Theme.** Plain combat on every 4th batch (0, 4, 8, ...), so common shouts like "punch",
   "uppercut", "kick" always match. The other batches rotate through: knights & dragons,
   witches & potions, forest spirits & beasts, winter tales, moonlight & night creatures,
   giants & trolls, enchanted household objects (played for laughs). The rotation index lives
   in state.json.
3. **Request.** `GET /library/stats` finds the thin types. The user message gets the counts per
   kind and per power for this batch (melee 40%, projectile 25%, shockwave 15%, strike 10%, defend
   10%; power 40/40/20; plain combat is 50% melee), the thin types, the names already used in this
   theme plus about 150 recent others, up to 150 claimed shouts, the common shouts (`CORE_SHOUTS`)
   nobody has claimed yet, and the 40 most recent kimodo_prompts, so motions vary from batch to
   batch. The system prompt follows Kimodo's own prompt advice: start with "a person" or a style
   subject, medium detail, one behavior (two at most), combat and dance vocabulary.
4. **Claude call.** One streamed call in a background thread, so job polling continues
   meanwhile. The next batch is requested when fewer than `--max-inflight` specs are queued, so
   the GPU stays busy.
5. **Validate** (`validate.py`):
   - Drops: bad enums or power, names outside 2-40 characters, a prompt that doesn't start with
     "a person" or a style subject Kimodo knows ("an angry person", "a tired person", "a sneaky
     person", "a drunk person", "an old person", "a stealthy person", "a happy person", "a
     childlike person", also sad, scared, injured), a period anywhere inside the prompt (Kimodo
     splits prompts at every `.`, decimals included), fewer than 6 or more than 40 words, banned
     words (magic, elements, creatures, robot, camera, running/rolling/lying down), props, the
     move's own non-body name words in the prompt, and a hit_joint the prompt never moves.
   - Fixes: a trailing period and outer quotes stripped, the subject lowercased with the right
     article ("A angry person" -> "an angry person"), duration clamped to 0.8-1.5, old effect tags
     mapped (fireball, bolt, frost, smoke), effect made to agree with type/kind, hit_joint moved
     hand <-> foot when the prompt only moves the other limb, and its side flipped when the prompt
     strikes only with the other side (support and guard phrases like "pivots on the left foot"
     don't count), aliases normalized with the lowercased name added.
   - Effects: ember_orb (fire), wisp_bolt (lightning), frost_crystals (ice), moon_smoke (shadow),
     none or thorn_burst (physical), fairy_dust (playful, any type; defend moves use only it or
     none), and shockwave, a ring along the ground, for shockwave moves of any type (thorn_burst
     and the type's own effect fit those too).
   - Generic shouts only stay on a move of their own element: a plain shout ("hook", "clap",
     "kick") only on a physical move, "fire punch" only on a fire move. Famous energy-attack
     shouts (hadouken, kamehameha) fit any type. Shouting "hook" never casts a fire spell.
6. **Dedupe** against the library, state.json and earlier specs in the batch. A spec is dropped
   if its name already exists as a name or an alias. Claimed aliases are stripped, and the spec is
   dropped if fewer than 2 aliases remain. Every drop is logged with its reason.
7. **Motion reuse.** If a prompt is more than 0.95 similar to one that already has a motion
   (all-MiniLM-L6-v2 cosine on the CPU, or difflib without sentence-transformers) **and** both
   prompts have the same side, direction, count and extent words in the same order (left, right,
   forward, backward, back, front, up, down, clockwise, counterclockwise, inward, outward, inside,
   outside, once, twice, thrice, double, triple, half, full), the spec is sent with that
   `motion_id` and the server skips Kimodo. So "a left hook" never reuses "a right hook", an
   outside crescent kick never reuses an inside one, and "spins twice" never reuses "spins once"
   (contract/api.md: near-duplicates are the agent's job). If the server refuses the `motion_id`
   (400), the spec is resubmitted once without it.
8. **Submit and poll.** POST `/generate`, poll `GET /job/{id}` round-robin. `/job` answers only
   running, done or rejected; a rejection carries the failed check (`nan_frames`, `barely_moved`,
   `root_drift`, `below_floor`, `joint_limits` or `error: ...`).
   - Rejected names are released so a later batch can try them again; two rejections and the
     name stays blocked.
   - A 404 means the server restarted and forgot the job (checked with `/health`): it is
     resubmitted once, unless the move is already in the library. While the library can't be
     read, the job waits instead.
   - A queued spec whose name is already in the library is never posted again (a crash right
     after a POST, or someone else took the name).
   - A job running more than 15 minutes is logged as a timeout and dropped.

## Never crash, resume cleanly

- `state.json` is rewritten atomically (temp file plus `os.replace`) after every change: batch
  and theme index, names_by_theme, claimed names and aliases, queue, pending jobs, hourly
  counters, fallbacks_disabled.
- On start it polls every pending job before submitting anything or asking Claude for more, so
  nothing is submitted twice. Queued specs that were never submitted are submitted after that.
- **Server down:** exponential backoff (2, 4, 8 s, ... up to 5 min), logged as `SERVER` lines.
  A 404 on `POST /generate` (no such route, e.g. a proxy in front of a stopped pod) counts as down,
  and so does any 403 (the server never sends one; the Cloudflare proxy does).
- **Claude errors:**
  - refusal: skip to the next theme; two or more in a row also wait (30 s, 60 s, ... up to 5 min);
  - max_tokens (or the context window): retry at half the batch size, which then grows back;
  - 400: halve the batch and back off; a 400 about the fallbacks beta retries without it and
    turns fallbacks off in state.json (only if the retry without them gets past the 400);
  - 429: wait for retry-after;
  - 5xx, 408, 409 or connection errors: back off (10 s, 20 s, ... up to 5 min) after the SDK's
    own 5 retries.
- Missing or invalid credentials (or a 403/404 model): one line, `Set ANTHROPIC_API_KEY ...`, and
  exit code 3. This is checked at start with `GET /v1/models/{model}` (no tokens), so it shows
  up at once even while the game server is down. Queued or pending jobs are drained first.
- **Circuit breakers**, so a broken server or template can't burn Claude batches all night:
  - 5 specs in a row refused by `POST /generate` (4xx): back off before each next spec, and no
    new Claude batch until the queue is empty. Check `server_api.py` against `contract/api.md`.
  - 25 jobs in a row rejected with nothing kept: a `PAUSE` line, and no new Claude batch for
    15 minutes, doubling up to 2 hours while it goes on (queued and pending jobs keep going).
- SIGINT, SIGTERM or SIGHUP: save state and exit 0. A second signal exits immediately (after
  saving).
- A lock file (`state.json.lock`) stops two agents from sharing one state file (exit 4).

## log.txt

There is one line per event, also printed:

```
2026-10-25 03:39:28 KEPT     'Mirror Test Charlie' job=job_1792917567_37 id=mv_00013 motion=mo_00010 hit_frame=9 stability=0.67 originality=0.02 (reused motion)
2026-10-25 03:42:31 REJECTED 'Troll Stomp' job=job_1792917745_7_15 check=root_drift reason=the root drifted more than 1.5 m
2026-10-25 03:38:36 DROPPED  'Sword Dance' (batch #1): kimodo_prompt has a prop 'sword': 'a person swings a sword in a wide circle at waist height'
2026-10-25 04:00:00 SUMMARY  2026-10-25 03:00 kept 412 (reused motion 30) rejected 31 dropped 25 errors 0  rejected by check: barely_moved 17, root_drift 12, error: RuntimeError 2  top drop reasons: ...  top errors: none
```

Other kinds: START, RESUME, BATCH, LLM (tokens, cache reads and writes, request id, seconds),
SUBMIT, RESUBMIT, TIMEOUT, ERROR, SERVER, REFUSED, PAUSE, PUSH, INFO, FATAL, STOP, EXIT, and
RESTART (from run_forever.sh). A SUMMARY line is written when the hour rolls over, and a partial
one on exit. It lists every rejection check by name.

## Tuning the prompt template after reading the first 20

Everything Claude is told lives in `prompt.py`. Bump `PROMPT_VERSION` on every edit (it is
logged and saved in each dry-run file). The system prompt is cached, and per-batch content goes
in the user message only. Read every row of the dry-run table and ask:

- **kimodo_prompt:** could a motion-capture actor do this in about a second, empty-handed, on
  the spot? Is the striking limb named, with a side and a height? If prompts drift (props,
  vague verbs, multi-step "then... then..." sequences, travel), add a matching bad -> fix pair
  under "Bad, and the fix" and a good example under "Good".
- **Same motion, many names?** Strengthen the "vary the motions" line, or lower the batch size.
- **name:** shoutable, themed, 1-4 words? If names are long or hard to spell, tighten the name
  rule and show examples.
- **aliases:** would a player actually yell these? Plain combat batches must claim the generic
  shouts. Edit `CORE_SHOUTS` to change what must always match.
- **type/kind/effect/hit_joint:** consistent? Many auto-fix notes for the same thing mean the
  rule in the prompt needs to be clearer.
- **Mix:** the table footer shows kept/asked per kind and power. Adjust `KIND_WEIGHTS` and
  `POWER_WEIGHTS` there. Theme flavor text is in `THEMES`.
- **Drops:** if many drops share one reason, fix the prompt. If a drop is a false positive (a
  good prompt), edit the word lists at the top of `validate.py` (`BANNED_PATTERNS`,
  `PROP_PATTERNS`, `ORDINARY_WORDS`, `STYLE_WORDS`).

Then dry-run again, and after pushing, watch the 20 moves in the viewer. Motion problems (spins
that drift, stomps that fall) also go back into the prompt rules. Only start the overnight run
when all 20 look right: a bad template left running all night gives thousands of bad moves.

## Testing without an API key

`--fake-llm` serves the specs in `fake_specs.json`. The first 20 cover every type, kind, effect,
hit_joint and power, plus invalid and fixable specs. Batch k gets the slice starting at k x batch
size, wrapping around with " II" suffixes. It goes through the same request, response and
validation code; only the network call is replaced. (The old builder's `--offline` is gone: use
`--fake-llm` against the server's mock engine.)

- `FAKE_LLM_DELAY=1` sets the seconds per call.
- `FAKE_LLM_SCRIPT=refusal,max_tokens,...` injects outcomes for the next calls: `ok`, `refusal`,
  `max_tokens`, `bad_json`, `fallback_block`, `bad_request`, `bad_request_fallbacks`,
  `rate_limit`, `connection`, `server_error`, `auth`.

```bash
LIBRARY_DIR=/tmp/lib PORT=8790 ./server/run.sh       # terminal 1, from the repo root: the mock engine
./run.sh --fake-llm --server http://127.0.0.1:8790 --batches 2 --batch-size 6 --state /tmp/s.json --log /tmp/l.txt
./run.sh --fake-llm --dry-run --batches 1 --batch-size 20 --server http://127.0.0.1:8790 --out /tmp/dry.json
```

(The last two run from `agent/`. A dry run also refreshes `dryrun/latest.json`.)

The mock engine never rejects a clip; the rejection paths were tested against a stand-in server.

## Files

| File | What |
| --- | --- |
| `run.py` | the loop, the CLI, state and resume, dry run and push |
| `prompt.py` | system prompt, themes, kind and power mix, `CORE_SHOUTS`, output schema, user message |
| `validate.py` | spec validation and fixes, the duplicate registry, mirror-safe motion reuse |
| `llm.py` | the Claude call (streamed, structured output, refusal fallbacks) and `--fake-llm` |
| `server_api.py` | every HTTP call to the game server (standard library only) |
| `fake_specs.json` | canned Claude output for `--fake-llm` |
| `run.sh` / `run_forever.sh` | one run / the overnight restart loop |
| `specs.py`, `state.py` | not the builder's: the live wildcard rules that `server/wildcard.py` imports |

Output (gitignored): `state.json`, `log.txt`, `dryrun/`, `batches/`.
