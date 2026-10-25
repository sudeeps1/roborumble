# tools/kimodo

Everyday fighter motion from Kimodo, kept only when it works in the physics. The loop:
prompts and keyframes (`everyday*.json`, poses from `anchors.json`) -> `kgen.py` on the GPU box ->
`scripts/clip-check.ts` plays every candidate through the fighter the way the game does and scores
it -> `select.ts` keeps the best passing ones that aren't clearly worse than the planner ->
`public/clips-everyday/` (index.json + clips + report.md), which the rig loads.

## Pipeline
The one command, from the laptop (it only runs ssh/rsync; generation and physics run on the hosts):
```
tools/kimodo/run-all.sh ubuntu@44.198.171.168 [more GPU hosts...]   # --help for the options
```
It merges `everyday.json` + `everyday_chars.json`, syncs passive/ to each GPU host, checks it (CUDA, cached
weights, a kgen dry run), runs kgen shard i/n on host i in parallel, gathers the clips on the scoring
host (the first host; `--score-host`), scores them there with clip-check in 6 shards together with a
frozen copy of the published library (a run can't make a motion worse) and the planner baseline, runs
`select.ts` (guard top 2, get-ups top 2 per lying pose, other motions the best one: `--keep`/`--variants`;
`--lenient dodge.back` by default), then backs up `public/clips-everyday/` to `tools/kimodo/out/RUN/prev` and publishes the new library
(refused if the laptop's library changed meanwhile; `--no-publish` stages it in `tools/kimodo/out/RUN/pub`).
Jobs run detached on the hosts, so a dropped ssh only stops the waiting: rerun with `--run RUN --from score|select`
(don't edit run-all.sh while it runs: bash reads it as it goes). kgen's `--shard` is 0-based, clip-check's 1-based.
Smoke test without the text encoder: `--no-text --only guard.a,punch_rightJab.a --samples 2 --shards 3 --no-current`.
select.ts sets each punch's `meta.hit_frame` from when its fist really landed in the physics, so
hitframes.py (kinematic: furthest reach) is not part of it.

The steps by hand, on the GPU box (`ubuntu@44.198.171.168`, A10G; one GPU job at a time through `~/gpu`, a flock wrapper):
```
BOXDIR=rr/gen tools/kimodo/sync-box.sh ubuntu@44.198.171.168 --setup      # copy passive/ there (first time --setup)
ssh ubuntu@44.198.171.168 'cd ~/rr/gen && ~/gpu ~/kvenv/bin/python tools/kimodo/kgen.py tools/kimodo/everyday.json --out ~/gen/runN'
ssh ubuntu@44.198.171.168 'cd ~/rr/gen && tools/kimodo/score-box.sh ~/gen/runN 3'   # clip-check in shards; ORT_THREADS=1-2, <= 3-4 sims (1.8 GB each)
node tools/kimodo/select.ts OUT ~/gen/runN/score.json --baseline ~/gen/runN/score/baseline.json --keep 2 --variants 2 --lenient dodge.back
```
select.ts sets each punch's `meta.hit_frame` to when its fist really arrived in the scoring runs.
(`hitframes.py` sets it to the furthest reach instead, by kinematics only: for a punch clip that
was never scored.)
then copy OUT to `public/clips-everyday/`. ~0.4-1 s of GPU per sample; scoring 5-40 s per candidate.
- **Characters:** a job with `meta.character` (and motion `step.forward.knight`) is scored under its
  base key and published as `<key>.<character>`; ClipSource prefers it for that fighter.
- **What doesn't work (2026-10-25):** Kimodo dodges and step-backs barely move the head/body in physics
  (SONIC ignores Kimodo's root shift; only a waist bend or real steps move it), and its jumps don't
  leave the ground. Those stay on the planner unless a candidate passes.

## kgen

Batch Kimodo-G1 generator. Runs on the GPU box, loads Kimodo-G1-RP-v1 and its LLM2Vec text encoder once,
and generates many candidate clips per everyday motion in GPU batches. The clips are physics-checked and picked elsewhere.

```
BOXDIR=rr/<you> tools/kimodo/sync-box.sh ubuntu@44.198.171.168 --setup      # first time; later without --setup
ssh ubuntu@44.198.171.168 'cd ~/rr/<you> && ~/gpu ~/kvenv/bin/python tools/kimodo/kgen.py JOBS.json --out OUTDIR'
    [--shard i/n] [--dry-run] [--only id1,id2]      # the interface
    [--tf32] [--batch N] [--no-text]                # extras
```

- `~/gpu` is a flock wrapper: one GPU job at a time on the box. The text encoder alone is ~16 GB, so two loads on the A10G would collide. `--dry-run` and `test_roundtrip.py` don't touch the GPU and don't need it.
- `--dry-run` loads no model. It validates the file, resolves anchors and offsets, writes `OUTDIR/<id>/constraints.json` and prints one line per job. It deletes nothing, but it does rewrite constraints.json, so give it a fresh OUTDIR. It warns when a job folder already holds clips.
- `--only a,b` picks jobs by id. `--shard i/n` runs the jobs whose index in the file is `i` mod `n`. Shards are for separate GPUs; two on one A10G don't fit.
- `--tf32` makes denoiser matmuls 1.46x faster on the A10G. Against fp32 the drift is a median 0.1 deg per hinge (max ~2 deg) and 0.03 cm at the root. Off by default.
- `--batch N` caps samples per denoiser batch (default 64, at most 4096 frames per batch). On OOM a batch halves itself and retries. The retry runs after the failed batch's tensors are freed, so a batch that OOMs at 64 goes through as 2 x 32 (measured under a 1.9 GB memory cap).
- `--no-text` is for debugging. It loads no text encoder and sends empty prompts, which is exactly Kimodo's unconditional branch. The result is constraint-only generation.
- Downloads are off: kgen sets `HF_HUB_OFFLINE=1`, `LOCAL_CACHE=true` and `TEXT_ENCODER_MODE=local` unless the environment already sets them. Everything comes from the HF cache, including the gated Llama-3-8B under LLM2Vec. `TEXT_ENCODER_MODE=api` reuses a running `kimodo_textencoder` instead.
- Speed on the A10G at 100 steps: about 0.9 s per sample for 0.8-1.0 s clips and 1.7-2.3 s for 3-4 s clips. That is nearly flat in batch size, because the GPU is already compute-bound at batch 4 (fp32 sgemm). Loading takes 1.3 s for the denoiser and about 100 s for the text encoder. 61 prompts encode in 7 s, each distinct prompt once. Run1 made 81 jobs x 8 = 648 clips in 762 s, peaking at 16.3 GB.

### JOBS.json

```json
{
  "anchors": "anchors.json",
  "defaults": {"samples": 8, "steps": 100, "cfg": [2.0, 2.0]},
  "jobs": [{
    "id": "step_forward.a",
    "motion": "step.forward",
    "prompt": "A person in a boxing stance takes a quick short step forward",
    "duration": 0.9,
    "samples": 8, "seed": 100, "cfg": [2.0, 2.0], "steps": 100,
    "keyframes": [{"t": 0, "anchor": "guard"}, {"t": "end", "anchor": "guard", "offset": [0.3, 0.0, 0.0]}],
    "root": [[0, 0, 0], ["end", 0.3, 0]],
    "meta": {}
  }]
}
```

- `anchors` is a path relative to JOBS.json (or an inline object): `{"<name>": {"qpos": [36 numbers], "note": "..."}}`. Each qpos is MuJoCo `root xyz, root quat wxyz, 29 hinges` (Menagerie/CSV order), with the pelvis xy at the origin and facing +X. kgen warns when an anchor's Kimodo heading (from the hip line, so lying poses work) is more than 5 deg off, or its xy more than 2 cm off. `kgen.rebase(qpos)` re-bases a pose.
- `id` must be unique and folder-safe; it becomes the output folder. `motion` is the ClipSource key the clip is a candidate for.
- `prompt` must not contain a `.`, because Kimodo splits on periods. kgen warns if it is outside 7-19 words or doesn't start with "A person".
- `duration` is in seconds; frames = `int(duration*30)`, ignoring float fuzz, so 4.1 s gives 123. The allowed range is 8-300 frames.
- `samples`, `seed`, `cfg` ([text, constraint] weights, separated CFG) and `steps` override `defaults`.
- Seeds: sample k uses `seed + k`, and the default seed is crc32(id). The start noise is drawn per sample from that seed, so a job gives the same clips alone or in any batch; measured diff 4e-6, the output rounding.
- `keyframes` become one Kimodo `fullbody` constraint. `t` is in seconds (rounded to a frame) or `"end"` (the last frame). A frame outside the clip is an error: Kimodo would drop it silently.
  - `offset [dx, dy, dyaw]` (m, m, rad, MuJoCo axes) turns the anchor about its own pelvis by dyaw, then shifts it.
  - A keyframe constrains all 34 Kimodo joint positions, the pelvis height, the smoothed root xz and the heading on its frame.
  - With a keyframe at t=0, its hip heading is passed as Kimodo's `first_heading_angle`; otherwise that is 0 (+X).
- `root` holds `[t, x, y]` waypoints (MuJoCo ground, m) and becomes one `root2d` constraint. It constrains Kimodo's smoothed root, so the pelvis sways a few cm around it. Kimodo (x, z) = MuJoCo (y, x).
- `meta` is copied into every output's meta; `meta.loop` is also copied to the top-level `loop`.
- One bad job (validation, constraint load, generation or write error) fails alone and the rest run on. The exit code is 1 if any job failed.

### Output

- `OUTDIR/<id>/s<k>.json` is a ClipData: `{"fps": 30, "qpos": [[36]...], "meta": {...}, "loop"?}`.
  - `qpos` holds Kimodo's G1 CSV rows (`MujocoQposConverter.dict_to_qpos`) as-is, unclamped and not re-based (frame 0 sits 0.1-1.5 cm off the origin), rounded to 1e-6. Only quaternion sign flips between frames are removed.
  - `meta` carries job.meta plus `job, motion, prompt, sample, seed, cfg, steps, duration, frames, gen_ms` (its share of the batch wall time), `batch, model`, and `text: "off"` under `--no-text`.
- `OUTDIR/<id>/constraints.json` holds the constraints the job ran with, in Kimodo's own save format (`get_save_info`). `kimodo_gen --constraints` and the Kimodo demo load it.
- `OUTDIR/manifest_<i>of<n>.json` is a list of `{job, motion, file, sample}` with `file` relative to OUTDIR. It is rewritten after every batch. **Readers glob `manifest_*.json`**, so shards never collide.
- **Reruns replace jobs.** In a real run (not `--dry-run`), once the model has loaded, kgen does two things for each job it picks:
  - It deletes the job's old `s<k>.json` files and `constraints.json`. It does this even if the rerun then fails, so a failed job is left with no clips. Other files in the folder stay.
  - It drops the job's rows from every `manifest_*.json` in OUTDIR, including manifests written under another `--shard` spec. Each job is then listed once, by its latest run.
  - This matters because `scripts/clip-check.ts` (and so `score-box.sh` and `select.ts`) scores every clip on disk, not just the manifest rows; the files on disk and the manifests now always agree.
  - `--only a,b` reruns a few jobs and leaves the others alone.
  - Clips of jobs that are no longer in the jobs file are not deleted. kgen only warns about them, so use a fresh `runN` folder per version of the jobs file.
- Progress lines are `[kgen] job <id> <k>/<n> <ms>`, then a summary line, then one line per failed job.

### Keyframe pose: why not `qpos_to_motion_dict`

`Rig.local_rots` builds Kimodo local rotations from qpos using the converter's own tables (rest quats, hinge axes, joint map), with one change.
- **The change:** a hinge turns after its body's rest quat (`L = Q R(axis, q)`, MuJoCo's order). Kimodo's `qpos_to_motion_dict` turns it before (`R(axis, q) Q`).
- **Why it matters:** wherever a body has a rest quat (hip roll 10 deg, shoulder pitch 16 deg), the converter's pose is 2-4 cm off MuJoCo FK at the hands and 2.5 cm at the feet. The new pose matches MuJoCo FK exactly.
- **Which one the model knows:** Kimodo-G1's own outputs follow MuJoCo's order. On the 8 bundled G1 examples the residual is 0.3-0.9 deg in MuJoCo's order against 1-2.2 deg in the converter's.
- **A/B with the same seeds:** keyframe hits at the hands improved 1.1-1.7 cm. Kimodo's CSV export of a keyframe hit exactly comes back within 0.56 cm (hinges within 1.5 deg, worst at shoulder pitch).

### Tests

```
~/kvenv/bin/python tools/kimodo/test_roundtrip.py                          # must pass; CPU only
~/kvenv/bin/python tools/kimodo/test_roundtrip.py --check OUTDIR JOBS.json  # check a kgen run
```

- **Round trip:** qpos goes to the saved fullbody JSON, through Kimodo's loader and FK, and is compared with MuJoCo FK. The poses are idle_fighting rows, get_up rows (lying, 97 deg tilt; 45 deg) and a turned/shifted anchor. Pelvis, hands, feet and head land within 0.00 cm on Kimodo's g1.xml and within 0.54 cm on the sim's g1_29dof.xml, whose torso pivot sits 1 cm higher.
- **dyaw = +90:** gives Kimodo heading +90 = MuJoCo yaw +90 (facing +Y), and the offsets land at the expected Kimodo (x, z).
- **Validation:** out-of-range frames, a period in the prompt, an unknown anchor and a bad offset are all rejected.
- **`--check`:** every manifest row must load as ClipData: shape `(int(d*30), 36)`, finite values, unit quats without flips, and the meta keys. It then prints per-keyframe pelvis/hands/feet/head errors against the anchor (sim FK) and the root-waypoint misses.
