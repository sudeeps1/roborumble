# tools/kimodo

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
- `--dry-run` loads no model. It validates the file, resolves anchors and offsets, writes `OUTDIR/<id>/constraints.json` and prints one line per job.
- `--only a,b` picks jobs by id. `--shard i/n` runs the jobs whose index in the file is `i` mod `n`. Shards are for separate GPUs; two on one A10G don't fit.
- `--tf32` makes denoiser matmuls 1.46x faster on the A10G. Against fp32 the drift is a median 0.1 deg per hinge (max ~2 deg) and 0.03 cm at the root. Off by default.
- `--batch N` caps samples per denoiser batch (default 64, at most 4096 frames per batch). On OOM a batch halves itself and retries.
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
- `OUTDIR/manifest_<i>of<n>.json` is a list of `{job, motion, file, sample}` with `file` relative to OUTDIR. It is rewritten after every batch, and rerunning a job replaces its rows. **Readers glob `manifest_*.json`**, so shards never collide.
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
