# Kimodo G1 fact sheet

This sheet is for Infinite Fighter and is checked against CLAUDE.md on idea branch `v1` (commit `f8285a7`). Kimodo source is pinned to commit `e1c219c` (main, 2026-10-15) and Menagerie to `ac6b2b0`. Line numbers refer to those commits. Compiled 2026-10-24.

- **confirmed**: a verifier re-checked it against the cited source. *(corrected)* means the original claim was refuted and this is the verifier's corrected version.
- **unverifiable**: one researcher reported it with a quote, but no verifier re-checked it. Treat it as likely, not settled.

## What this changes in CLAUDE.md (v1)

1. Only `Kimodo-G1-RP-v1` gets a CSV from `kimodo_gen`. G1-SEED writes only an NPZ, so convert it with `kimodo_convert out.npz out.csv`. Use G1-RP. **confirmed** · [generate.py L378-391][gen-csv]
2. Pass `--model` on every G1 call, because the default model is SOMA. **confirmed** · [registry.py][reg]
3. The two guidance weights go in `--cfg_weight <text> <constraint>`. `--cfg_type separated` on its own raises a ValueError. **confirmed** · [generate.py][gen]
4. `--no-postprocess` is ignored for G1. Post-processing is always off, so expect foot skating and approximate constraint hits. **confirmed** · [generate.py L325-338][gen-post]
5. fps is 30, which settles that question. The CSV carries no fps and no joint names, so the server must add `fps: 30` and the `joint_names` list in section 1. **confirmed** · [config.yaml][hf-rp-cfg], [mujoco.py L329-344][mj-csv]
6. The CSV joint order matches Menagerie `unitree_g1/g1.xml` exactly (not `g1_with_hands.xml`), so a CSV row is a Menagerie qpos as-is. **confirmed** · [Menagerie g1.xml][mxml]
7. "Motions start at the origin" is only approximately true: the frame-0 pelvis is 1.2-7.2 cm off. Re-base on the frame-0 root x, y. The quaternion sign can flip, so align hemispheres before blending. **confirmed** · [examples][ex], [geometry.py][geom]
8. The constraints schema is documented on the docs site, and 5 working G1 files ship in the repo. Copy one into `contract/constraints.example.json`.
   - Full-body keyframes are given as 34 local joint rotations plus the pelvis position, and Kimodo constrains the resulting FK positions.
   - There is no field for a raw hand or foot target, so Forge needs IK or retargeting to G1 joint rotations.

   **confirmed** · [constraints docs][w-cons], [examples][ex]
9. The quality checks need tolerances. CSV angles are not clamped: 7 of the 8 official examples exceed Menagerie limits, by up to 7.6°. A jog example's feet reach -4.76 cm, close to the 5 cm floor check. **confirmed** · [mujoco.py L431-544][mj-clamp], [examples][ex]
10. A `kimodo_prompt` must contain no `.` at all, decimals included. Each period starts a new segment that gets the full `--duration`. **confirmed** · [generate.py L131-149][gen-split]
11. 0.8-1.5 s moves are untested on G1. They are below the demo's 2 s minimum, and no G1 evaluation is published at any length. Measure early. **confirmed** · [demo/config.py][democfg], [tech report p.13][report]
12. "Kimodo knows ... combat" is true of the training data. Both G1 model cards leave combat out of their "best at" list, so test combat prompts on G1-RP early. **confirmed** · [G1-RP card][hf-rp]
13. The 1-3 s per-clip guess may be optimistic. The only published figure is 2-5 s per prompt on an RTX 3090. **unverifiable** · [tech report p.5][report]
14. Llama 3 access needs manual approval. GitHub issues report week-long waits and rejections, and there is no official fallback encoder. **unverifiable** · [HF API][hf-llama], [#13][i13], [#16][i16]

## 1. G1 output format

### CSV layout

| Columns | Content |
|---|---|
| 0-2 | Root (pelvis) translation `x, y, z` in meters. This is the raw, non-smoothed pelvis trajectory (`root_positions`). |
| 3-6 | Root quaternion `w, x, y, z` |
| 7-35 | 29 hinge angles in radians, in the joint order below |

- Each frame is one row of 36 comma-separated values, in MuJoCo axes (Z up, +X forward). **confirmed** · [output_formats.md L44-51][d-of], [mujoco.py L483-544][mj-qpos]
- There is no header row and no fps or time column. Rows are written by `np.savetxt(path, qpos, delimiter=",")` in numpy's default `%.18e` format, e.g. `7.900000000000000355e-01`, so parsers must accept scientific notation. **confirmed** · [mujoco.py L329-344][mj-csv], [motion_io.py][mio]
- Units are meters and radians. Both Kimodo's and Menagerie's g1.xml declare `<compiler angle="radian">`. **confirmed** · [Kimodo g1.xml][kxml], [Menagerie g1.xml][mxml]
- Kimodo works internally in Y-up, +Z forward (right-handed). The exporter maps MuJoCo `(x, y, z)` = Kimodo `(z, x, y)`. Kimodo +X, the character's left at heading 0, becomes MuJoCo +Y. **confirmed** · [mujoco.py L27-80][mj-axes]
- Joint values are raw hinge angles (`mujoco_rest_zero=False`, the CLI default), and that is the correct convention for MuJoCo.
  - Kimodo's own `mujoco_load.py` copies each row straight into `data.qpos` of its bundled g1.xml at 30 fps.
  - A verifier replayed all 8 official G1-RP examples through MuJoCo forward kinematics. Raw rows reproduce Kimodo's joint positions with a mean error of 1.5-2.8 mm (max 1.2-5.1 cm at the wrists, from the 1-DoF projection).
  - Rest-zero rows were off by 2.4-3.1 cm on average, up to about 12 cm. Do not use `--mujoco-rest-zero`.
  - Comments in Kimodo's code (mujoco.py L203-205, g1_rig.py L171) describe the rest-zero convention. The default is the one that matches.

  **confirmed** · [mujoco_load.py][mjload], [mujoco.py L167-213][mj-rest], [g1_rig.py][g1rig]
- The Kimodo T-pose exports as q ≈ 0 except for four joints: the knees at -0.1749 rad (below the knee's -0.08727 lower limit), left_shoulder_roll at +0.2793 and right_shoulder_roll at -0.2793. This only matters when hand-authoring poses in Kimodo's frame. **confirmed** · [mujoco.py L167-213][mj-rest]
- The root quaternion is w-first (`root_quat_w_first=True`), the same order as a MuJoCo freejoint, and the pelvis body has no quat offset. Its sign is not canonical:
  - `matrix_to_quaternion` picks the largest-magnitude candidate, so w < 0 on some frames (33 of 181 in example 05).
  - Adjacent frames flip sign when yaw crosses -90°: -89° gives `(0.7133, 0, 0, -0.7009)` and -91° gives `(-0.7009, 0, 0, 0.7133)`.
  - Writing qpos directly is fine. For slerp or blending, negate q when the dot product is negative.

  **confirmed** · [mujoco.py L483-544][mj-qpos], [geometry.py L144-187][geom]
- Frame 0 starts near the origin, not exactly at it. Across the 8 G1-RP examples, the frame-0 pelvis is 1.2-7.2 cm from the origin horizontally (at most 5.5 cm per axis), at a height of 0.737-0.798 m. The docs promise (0, 0) canonicalization only for training, and nothing enforces it at inference. **confirmed** · [constraints.md L28-31][d-cons], [examples][ex]
- At frame 0 the robot faces about +X in MuJoCo, within ~3° in the examples. `first_heading_angle` defaults to 0 (Kimodo +Z = MuJoCo +X), but it is a learned conditioning input, so the result is approximate. `kimodo_gen` and the demo never pass it; only the Python API can. **confirmed** · [kimodo_model.py][km], [config.yaml][hf-rp-cfg]
- Heading is θ = atan2(Δz, −Δx), where Δ = right_hip − left_hip in Kimodo space, and it is stored as `[cos θ, sin θ]`. θ equals MuJoCo yaw about +Z, measured from +X. **confirmed** · [feature_utils.py L110-125][feat], [kimodo_motionrep.py][rep]
- An upright G1 pelvis sits at about 0.74-0.80 m. The XML pelvis is at z = 0.793, and Menagerie's `stand` key uses 0.79 with straight legs. The docs' "~0.9 m" and "0.96 m" fit the SOMA (human) examples, not G1. **confirmed** *(corrected)* · [Kimodo g1.xml][kxml], [Menagerie g1.xml L347][mxml], [constraints.md][d-cons]
- Floor contact in the examples: the lowest Menagerie foot-sphere bottom is between -1.9 and +1.4 cm at frame 0. Over a whole clip it reaches -4.76 cm in 05_root_path (jogging) and -1.1 to -3.1 cm in the others. **confirmed** · [examples][ex], [Menagerie g1.xml][mxml]
- Joint angles are not clamped: `to_qpos` writes them as computed.
  - Clamping exists only in `project_to_real_robot_rotations` (wrapped by `apply_g1_real_robot_projection`). Only the demo calls it, behind a "Real robot rotations" checkbox that is off by default.
  - 7 of the 8 examples have frames outside Menagerie ranges; only 07_text_terrain is clean.
  - The worst cases are left_ankle_pitch up to 7.6° (example 03), right_ankle_roll 6.4° (04) and waist_roll 4.5° (01).

  **confirmed** · [mujoco.py L431-544][mj-clamp], [demo/generation.py L194-201][demogen]

### fps

- Both G1 models output 30 fps. Their config.yaml files are byte-identical and say `fps: 30`. Both model cards say "Motions are at 30 frames per second", and the tech report says "generates motions at 30 fps". Neither the CSV nor the NPZ stores the rate. **confirmed** · [G1-RP config.yaml][hf-rp-cfg], [G1-SEED config.yaml][hf-seed-cfg], [G1-RP card][hf-rp]

### Joint order

CSV columns 7-35 follow the document order of the `<joint>` elements in Kimodo's `g1skel34/xml/g1.xml`; the `<freejoint name="floating_base_joint"/>` is skipped. This is the 29-DoF G1, with 3 waist joints and 3 wrist joints per arm.

Menagerie `unitree_g1/g1.xml` (model `g1_29dof_rev_1_0`) matches it exactly: same names, order, axes, ranges and body pos/quat, with nq = 36. `floating_base_joint` occupies qpos[0:7], `left_hip_pitch_joint` is qpos[7] and `right_wrist_yaw_joint` is qpos[35].

In the list below, entry i is CSV column 7 + i. It can be pasted straight into the Motion JSON's `joint_names`:

```json
[
  "left_hip_pitch_joint",
  "left_hip_roll_joint",
  "left_hip_yaw_joint",
  "left_knee_joint",
  "left_ankle_pitch_joint",
  "left_ankle_roll_joint",
  "right_hip_pitch_joint",
  "right_hip_roll_joint",
  "right_hip_yaw_joint",
  "right_knee_joint",
  "right_ankle_pitch_joint",
  "right_ankle_roll_joint",
  "waist_yaw_joint",
  "waist_roll_joint",
  "waist_pitch_joint",
  "left_shoulder_pitch_joint",
  "left_shoulder_roll_joint",
  "left_shoulder_yaw_joint",
  "left_elbow_joint",
  "left_wrist_roll_joint",
  "left_wrist_pitch_joint",
  "left_wrist_yaw_joint",
  "right_shoulder_pitch_joint",
  "right_shoulder_roll_joint",
  "right_shoulder_yaw_joint",
  "right_elbow_joint",
  "right_wrist_roll_joint",
  "right_wrist_pitch_joint",
  "right_wrist_yaw_joint"
]
```

**confirmed** (I listed the joints in both XMLs at the pinned commits again for this sheet; the order is identical) · [mujoco.py L102-151][mj-order], [Kimodo g1.xml][kxml], [Menagerie g1.xml][mxml]

- Do not use Menagerie `g1_with_hands.xml`. It has 43 hinges, and 7 hand joints after `left_wrist_yaw_joint` shift the right-arm columns. **confirmed** · [g1_with_hands.xml][mhands]
- Unitree's `g1_29dof.xml` has the same hinge order; its base is declared as `<joint type="free">`. The docs link the whole `unitree_robots/g1` folder, which also contains `g1_23dof.xml`, and that file does not match. **confirmed** · [g1_29dof.xml][unitree], [skeleton.md L4][d-skel]

### NPZ (always written alongside)

- The NPZ uses Kimodo's frame (Y up), with J = 34 joints for G1. The documented keys are:
  - `posed_joints [T,J,3]`
  - `global_rot_mats [T,J,3,3]`
  - `local_rot_mats [T,J,3,3]`
  - `foot_contacts [T,4]`: left heel, left toe, right heel, right toe
  - `smooth_root_pos [T,3]`
  - `root_positions [T,3]`
  - `global_root_heading [T,2]`

  The source suggests an 8th key, `posed_joints_norootpos`, but that was read from the code, not run. **confirmed** · [output_formats.md L7-24][d-of], [kimodo_motionrep.py][rep]
- The internal G1Skeleton34 has the pelvis, the 29 hinges, and 4 joints Kimodo adds: `left_toe_base`, `right_toe_base`, `left_hand_roll_skel` and `right_hand_roll_skel`. The docs mention only the toes. The CSV drops all four extras. **confirmed** · [definitions.py L286-335][defs], [skeleton.md][d-skel]

### Which files get written

- `kimodo_gen` writes the CSV only when the resolved model is exactly `kimodo-g1-rp`. `Kimodo-G1-SEED-v1` resolves to `kimodo-g1-seed` and gets only an NPZ, even though the docs say "Kimodo-G1 models" get a CSV. The fix is `kimodo_convert out.npz out.csv`. It requires J = 34 and uses the same converter, with no resampling. **confirmed** · [generate.py L378-391][gen-csv], [registry.py][reg], [motion_convert_lib.py][conv]
- File naming with `--output test`:
  - One sample writes `test.npz` (plus `test.csv` for G1-RP) and creates no folder.
  - N samples go into a folder: `test/test_00.npz`, `test/test_00.csv` (G1-RP only), and so on.
  - The default stem is `output`.

  **confirmed** · [cli.md L51-54][d-cli], [generate.py][gen]
- `--save_example_dir` writes a folder the demo can load: `<output>_example/`, or `<output>_examples/<stem>_example_NN/` for several samples. It holds `motion.npz` and `meta.json`, plus `constraints.json` only if a constraints file was used. BVH export is SOMA-only and AMASS is SMPL-X-only; the demo exports G1 as NPZ or CSV. **confirmed** · [generate.py L438-498][gen-ex], [output_formats.md][d-of], [export_results.md][d-export]

## 2. CLI and flags

Kimodo installs four commands:
- `kimodo_gen`, equivalent to `python -m kimodo.scripts.generate`.
- `kimodo_demo`, a web UI at http://localhost:7860. `SERVER_PORT` changes the port; on a remote machine, reach it through SSH port forwarding.
- `kimodo_convert`, for format conversion.
- `kimodo_textencoder`, a shared text-encoder server.

**confirmed** · [pyproject.toml][pyproj], [cli.md][d-cli], [launching][w-launch], [demo/config.py][democfg]

The complete `kimodo_gen` flag list:

| Flag | Default | Notes |
|---|---|---|
| `prompt` (positional) | none | Split on every `.` into sequential segments. Optional when `--input_folder` is used. |
| `--model` | `kimodo-soma-rp` (= Kimodo-SOMA-RP-v1.2) | Required for G1. |
| `--duration` | `"5.0"` | Seconds, applied to each segment. A space-separated string gives each segment its own value. |
| `--num_samples` | `1` | Variations of the same prompt, generated in one batch. |
| `--diffusion_steps` | `100` | Number of denoising steps. |
| `--num_transition_frames` | `5` | Blend frames between segments. |
| `--constraints` | none | Path to the constraints JSON. |
| `--output` | `output` | Output file stem. |
| `--save_example_dir` | off | Writes a folder the demo can load. |
| `--bvh`, `--bvh_standard_tpose` | off | BVH export; `--bvh` is SOMA-only. |
| `--no-postprocess` | off | Ignored for G1. |
| `--seed` | `None` | Integer. |
| `--input_folder` | none | Folder with `meta.json` and an optional `constraints.json`. |
| `--cfg_type` | model default (`separated`) | `nocfg`, `regular` or `separated`. |
| `--cfg_weight` | model default `[2.0, 2.0]` | 1 float for regular, or 2 floats for separated (text, then constraint). |

All rows **confirmed** · [generate.py][gen], [cfg.py][cfgpy], [cli.md][d-cli]

- Model names are case-insensitive. `Kimodo-G1-RP-v1`, `kimodo-g1-rp`, `G1-RP` and `g1` all resolve to `kimodo-g1-rp`. `Kimodo-G1-SEED-v1`, `kimodo-g1-seed` and `G1-SEED` resolve to `kimodo-g1-seed`. The docs contradict themselves on the default (SOMA v1 or v1.2); the code resolves it to v1.2. `kimodo_demo` takes its own `--model` flag. **confirmed** · [registry.py][reg], [cli.md][d-cli]
- Forge slider: `kimodo_gen "<prompt>" --model Kimodo-G1-RP-v1 --constraints c.json --cfg_type separated --cfg_weight <text> <constraint>`.
  - Passing two floats to `--cfg_weight` alone also selects separated guidance.
  - Put the prompt before `--cfg_weight`. Its `nargs="*"` swallows a trailing prompt and fails with "invalid float value".
  - The formula is `uncond + w_text·(text − uncond) + w_constraint·(constraint − uncond)`.
  - Precedence: CLI flags first, then a meta.json `cfg` block (via `--input_folder`), then the model defaults (separated, [2.0, 2.0]).
  - The G1 examples use text 1.0 / constraint 2.0 (02), 2.0 / 1.0 (03), and 2.0 / 2.0 for the other six.

  **confirmed** · [generate.py][gen], [cfg.py L94-129][cfgpy], [examples][ex]
- Post-processing (foot-skate cleanup and constraint optimization) is forced off for any resolved model name containing `g1`. **confirmed** · [generate.py L325-338][gen-post], [limitations.md][d-lim]
- Prompt splitting example: `"a person steps 0.5 m forward and punches"` at `--duration 1.2` becomes `["a person steps 0.", "5 m forward and punches."]`, 36 + 36 frames. A trailing period alone adds no segment. Prompts read from a meta.json are not split. **confirmed** · [generate.py L131-149][gen-split]
- The CLI always calls `model(..., multi_prompt=True)` and reloads the model on every run. `--num_samples` only gives variations of one prompt. To batch independent prompts, use the Python API with a list of prompts and `multi_prompt=False`, optionally with a separate constraint list per sample. **confirmed** · [generate.py][gen], [model API][w-api], [kimodo_model.py][km]
- Python API for a server that keeps the model loaded:
  - Call `load_model(...)` once. It accepts `text_encoder=` to reuse an existing encoder.
  - Then call `model(prompts, num_frames, num_denoising_steps, multi_prompt=False, constraint_lst=[], cfg_weight=[2.0, 2.0], num_samples=None, cfg_type=None, return_numpy=False, first_heading_angle=None, num_transition_frames=5, post_processing=False, ...)`.
  - Get CSV rows from `MujocoQposConverter(model.skeleton).dict_to_qpos(output, device)`. You can call it yourself on SEED output; `kimodo_convert`'s NPZ-to-CSV path only checks for 34 joints.
  - The keyword is `prompts`. The docs' `model(prompt=...)` example raises a TypeError.

  **confirmed** · [model API][w-api], [generate.py L378-391][gen-csv], [load_model.py][lm]
- `load_constraints_lst` accepts either a JSON path or a list of dicts. **unverifiable** · [constraints.py][cons]
- Environment variables:
  - `TEXT_ENCODER_DEVICE`, e.g. `cpu`.
  - `TEXT_ENCODER_MODE`: `auto` (default; tries the server, then loads locally), `api` or `local`.
  - `TEXT_ENCODER_URL`: defaults to `http://127.0.0.1:9550/`.
  - `TEXT_ENCODER`: `llm2vec` is the only option.
  - `CHECKPOINT_DIR`: checkpoint folders named by display name.
  - `LOCAL_CACHE=true`: tries the Hugging Face cache first and still downloads on a miss. It covers the Kimodo checkpoint only, not LLM2Vec.
  - `HUGGINGFACE_CACHE_DIR` and `TEXT_ENCODERS_DIR`.

  `kimodo_textencoder` is a Gradio server bound to `0.0.0.0:9550` (`GRADIO_SERVER_NAME` and `GRADIO_SERVER_PORT` change it). Keep it running when making many CLI calls. The Docker equivalents are `docker compose up text-encoder` and `docker compose exec demo kimodo_gen ...`. **confirmed** · [load_model.py][lm], [llm2vec_wrapper.py][l2v], [run_text_encoder_server.py][txtsrv], [quick start][w-quick], [docker-compose.yaml][compose]
- `kimodo_convert INPUT OUTPUT` infers formats from the file extensions. `--from` (`amass`, `kimodo`, `soma-bvh`, `g1-csv`) and `--to` override them, and `--source-fps` sets the input rate. Converting to NPZ writes 30 Hz and resamples only if the source rate differs; a CSV is assumed to be 30 Hz. Leave `--mujoco-rest-zero` off, which matches how `kimodo_gen` writes CSVs. **confirmed** · [motion_convert.md][d-conv], [motion_convert.py][convpy]
- `--input_folder` meta.json needs either `text` and `duration`, or `texts` and `durations`. `num_samples`, `seed`, `diffusion_steps` and `cfg {enabled, text_weight, constraint_weight}` are optional. An explicit `--constraints` overrides the folder's `constraints.json`. **confirmed** · [meta.py][meta], [generate.py][gen]
- In the demo, "Save Constraints" writes JSON to a path on the server, and Exports offers G1 motion as NPZ or CSV. **confirmed** · [export_results.md][d-export], [demo/ui.py][demoui]

## 3. Constraints file schema

- The schema is documented on the docs site (user_guide/constraints). The README does not cover it, so CLAUDE.md is literally right about the README. Five working G1 files ship in `kimodo/assets/demo/examples/kimodo-g1-rp/`: `02_multi_text_ee_constraint`, `03_full_body_keyframes`, `04_ee_constraint`, `05_root_path` and `06_root_waypoints`. Their keys and key order match what `get_save_info` writes; whether they were saved from the demo is not documented. **confirmed** · [constraints docs][w-cons], [README][readme], [examples][ex]
- The file is a JSON array of objects. Each object has:
  - `type`: one of `root2d`, `fullbody`, `left-hand`, `right-hand`, `left-foot`, `right-foot` or `end-effector`.
  - `frame_indices`: 0-based integer frames within the generated clip (30 fps for G1). They need not be sorted (example 04 uses `[129, 93, 0]`), and frame 0 does not need a constraint.

  **confirmed** · [constraints.md][d-cons], [constraints.py][cons]
- Constraints use Kimodo's frame, not MuJoCo's: Y up, XZ ground plane, meters, measured from a canonical origin. At that origin the smoothed root is at XZ (0, 0) on frame 0 and heading 0 faces +Z. Convert with Kimodo `(x, y, z)` = MuJoCo `(y, z, x)`. For example, 0.3 m along MuJoCo +X is `smooth_root_2d: [0.0, 0.3]`. **confirmed** · [constraints.md L21-36][d-cons], [mujoco.py L27-80][mj-axes]

Fields (T is the number of constrained frames):

| Field | Shape | Meaning |
|---|---|---|
| `smooth_root_2d` | `[T, 2]` | Smoothed root `[x, z]` on the ground, in meters from the canonical origin. |
| `root_positions` | `[T, 3]` | Pelvis `[x, y, z]`. y is the absolute hip height: 0.738-0.790 m upright in the G1 examples, 0.569 crouched and 0.306 while setting a box down. Do not copy the docs' 0.96 m. |
| `global_root_heading` | `[T, 2]` | `[cos θ, sin θ]`, not radians. θ = 0 faces Kimodo +Z (MuJoCo +X) and θ = π/2 faces Kimodo +X (MuJoCo +Y), so θ equals MuJoCo yaw. The pair is not in the same `[x, z]` order as `smooth_root_2d`. |
| `local_joints_rot` | `[T, 34, 3]` | Axis-angle local rotations in radians, relative to the skeleton's rest pose, in G1Skeleton34 order (below). |
| `joint_names` | list | `end-effector` type only. |

**confirmed** · [constraints.md][d-cons], [feature_utils.py][feat], [examples][ex]

Constraint types:

| `type` | Required | Optional | What Kimodo constrains |
|---|---|---|---|
| `root2d` | `smooth_root_2d` | `global_root_heading` | Waypoints, or a dense path when every frame is listed. |
| `fullbody` | `local_joints_rot`, `root_positions` | `smooth_root_2d` | Joint positions from FK, smooth root 2D, pelvis height and heading. The rotations themselves are not constrained. |
| `left-hand`, `right-hand` | same as `fullbody` | `smooth_root_2d` | Positions of `<side>_wrist_yaw_skel` and `<side>_hand_roll_skel`, rotation of `<side>_wrist_yaw_skel`, plus root XZ, pelvis height and heading. |
| `left-foot`, `right-foot` | same as `fullbody` | `smooth_root_2d` | Positions of `<side>_ankle_roll_skel` and `<side>_toe_base`, rotation of `<side>_ankle_roll_skel`, plus root XZ, pelvis height and heading. |
| `end-effector` | same as `fullbody`, plus `joint_names` | `smooth_root_2d` | Names must come from `LeftFoot`, `RightFoot`, `LeftHand`, `RightHand` and `Hips`; pelvis rotation is constrained only via `Hips`. The user guide's `["left_hand"]` raises a ValueError, so use the shorthand types. |

**confirmed** · [constraints.md L55-80][d-cons], [constraints.py][cons], [base.py L135-173][base]

- Validation:
  - An unknown `type` or a missing required key raises a KeyError.
  - Per-frame arrays must have exactly `len(frame_indices)` rows, or an AssertionError is raised.
  - `local_joints_rot` must have exactly 34 joints for G1 (ValueError otherwise; only SOMA 30↔77 is converted automatically).
  - Out-of-range `frame_indices` are silently dropped on the CLI path (`crop_move`). A 1.2 s clip accepts only frames 0-35.

  **confirmed** *(corrected)* · [constraints.py][cons], [kimodo_model.py L160-178][km-crop]
- No field takes a raw world-space hand or foot target. Every `fullbody` and hand/foot entry needs a complete 34-joint pose, and hand/foot entries also pin root XZ, pelvis height and the hip-derived heading on their frames. So Forge needs IK or retargeting from landmarks to G1 joint rotations. In Python, `FullBodyConstraintSet(skeleton, frame_indices, global_joints_positions, global_joints_rots, ...)` conditions on global positions and ignores the rotations. It still needs a G1-consistent 34-joint pose. **confirmed** · [constraints.py][cons]
- A route from a MuJoCo pose to a constraint exists in the code, but the docs never describe it for this purpose. `MujocoQposConverter.qpos_to_motion_dict` turns `(T, 36)` qpos rows into a Kimodo motion dict (`posed_joints`, `global_rot_mats`, `local_rot_mats`, `root_positions`, ...). `get_save_info` then writes `matrix_to_axis_angle(global_rots_to_local_rots(...))`. Re-base the pose to the canonical origin and heading first. The documented ways to make a constraints file are the demo's "Save Constraints" button or writing it by hand from the format guide. **confirmed** *(corrected)* · [mujoco.py L249-327][mj-inv], [constraints.py][cons], [cli.md][d-cli]
- Usage guidance:
  - Keep each constraint type under 20 constrained frames (dense root paths excepted). Forge's 3-5 keyframes fit.
  - A dense path should cover the whole clip. The demo adds first and last waypoints because "Kimodo is only trained on full-sequence paths".
  - Avoid constraints that contradict the text or each other; they cause artifacts or get ignored. Tune the CFG weights instead.
  - Foot-contact constraints were trained but are not exposed in the demo or the Python API.

  **confirmed** · [limitations.md][d-lim], [demo constraints.md][d-dcons], [key-concepts constraints.md][d-kcons]
- Example files:
  - 03 is a `fullbody` constraint at frames `[59, 106, 148]` for "A person walking forward picks up something off the ground" (5.0 s, text 2.0 / constraint 1.0), with shapes `(3,34,3)`, `(3,3)` and `(3,2)`.
  - 05 is a 181-frame dense `root2d` path for a 181-frame clip.
  - 06 has `root2d` waypoints at `[0, 87, 169, 240]` for a 241-frame clip.

  **confirmed** · [examples][ex]

G1Skeleton34 order for `local_joints_rot`. This differs from the CSV order, and every name ends in `_skel` except the two toe bases:

```
0      pelvis_skel
1-7    left_hip_pitch_skel, left_hip_roll_skel, left_hip_yaw_skel, left_knee_skel, left_ankle_pitch_skel, left_ankle_roll_skel, left_toe_base
8-14   right_hip_pitch_skel, right_hip_roll_skel, right_hip_yaw_skel, right_knee_skel, right_ankle_pitch_skel, right_ankle_roll_skel, right_toe_base
15-17  waist_yaw_skel, waist_roll_skel, waist_pitch_skel
18-25  left_shoulder_pitch_skel, left_shoulder_roll_skel, left_shoulder_yaw_skel, left_elbow_skel, left_wrist_roll_skel, left_wrist_pitch_skel, left_wrist_yaw_skel, left_hand_roll_skel
26-33  right_shoulder_pitch_skel, right_shoulder_roll_skel, right_shoulder_yaw_skel, right_elbow_skel, right_wrist_roll_skel, right_wrist_pitch_skel, right_wrist_yaw_skel, right_hand_roll_skel
```

**confirmed** (listed from the pinned file again for this sheet) · [definitions.py L286-335][defs]

## 4. Prompt-writing guidance

- Start with "A person…". Stylized subjects like "An old person…", "A drunk person…" or "A zombie…" also work; the tech report says the model "expects the prompt to start with the subject". **confirmed** · [limitations.md][d-lim], [tech report p.4][report]
- Describe one behavior, or two at most. Join two with "then" (in sequence) or "while" (at the same time). The report shows this for the SOMA-trained model and notes that separate prompts can work better for sequences. **confirmed** · [limitations.md][d-lim], [tech report pp.3-4][report]
- Use a medium level of detail. "A person walks." is too vague, and a description of every body part is "too much for the model to handle". For length, SEED descriptions have a median of 16 words (p10 9, p90 23), and 0.8-1.5 s segments a median of 12 (p10 7, p90 19). CLAUDE.md's 12-word example fits. **confirmed** · [limitations.md][d-lim], [SEED-Timeline-Annotations][hf-ann]
- Stay inside the training categories: locomotion, gestures, everyday activities, common object interactions, videogame combat and dancing (the report adds athletics). Styles include tired, angry, happy, sad, scared, drunk, injured, stealthy, old and childlike. Anything outside these "will likely give bad results"; the docs' example is a baseball swing. These lists describe the full ~700 h Rigplay dataset. **confirmed** · [limitations.md][d-lim], [tech report p.6][report]
- Combat quality on G1 is unconfirmed.
  - Both G1 model cards say "best at locomotion, gestures, dancing, and everyday activities". Every SOMA card checked also lists combat.
  - G1-RP was trained on ~560 h versus 700 h for SOMA-RP, and which clips were dropped is not documented.
  - The open SEED data behind G1-SEED has almost no fighting. "punch" appears in 50 of 142,220 descriptions. "kick" appears in 838, but about half are kicking objects (mostly trash) and a third are dance kicks; none are fighting kicks. "jab", "uppercut" and "martial" never appear.
  - Use G1-RP and check combat moves by eye.

  **confirmed** · [G1-RP card][hf-rp], [G1-SEED card][hf-seed], [SOMA-RP card][hf-soma], [SEED-Timeline-Annotations][hf-ann]
- Never put a `.` in a prompt, decimals included (see section 2). Casing does not matter: `sanitize_text` collapses whitespace, trims, applies `str.capitalize()` and adds a final period if one is missing. "A person throws a Left Jab, then a right Uppercut" becomes "A person throws a left jab, then a right uppercut." In the Python API, `0.5` also becomes `0. 5`. **confirmed** · [sanitize.py][san], [generate.py L131-149][gen-split]
- In a multi-prompt sequence, each prompt must make sense on its own. "Then the person stops" lacks context. **confirmed** · [limitations.md][d-lim]
- Acrobatics are weak. The project lead says Kimodo "doesn't excel at acrobatics" but was trained on basic flips and cartwheels. His advice is to keep the defaults (100 steps, text CFG 2.0), try several seeds, and rephrase. **confirmed** · [issue #29][i29]
- Known model limits are foot skating, imperfect text following, no cartoon or physically implausible motion, and no awareness of objects in the scene. The card's advice to use "neutral, physical terms" is about avoiding stereotypes, not about motion quality. **confirmed** · [G1-RP card][hf-rp]

Good example prompts, all from official G1 material or the training data:
- "A person walking forward quickly stumbles but maintains their balance" (repo 01; paper Fig. 3)
- "A person walks diagonally to the left and waves at someone on their right" (04)
- "A person picks up an object from low on their left side and places it up high" (08)
- "A person walking forward picks up something off the ground" (03)
- "A person is walking while carrying a small object in their left hand" (06)
- "A person walks forward while carrying a box", then "A person sets a box down onto the ground" (02, a two-prompt sequence)
- From the G1 row of paper Fig. 3:
  - "A person lifts, moves, and places a medium-heavy object from front to back at medium height."
  - "A person gets up off the ground from laying down"
  - "A person begins walking up the stairs"
- Fighting text from the SEED training data: "A person gets into a fighting stance and starts shadowboxing by throwing multiple punches forward with both hands."

**confirmed** · [examples][ex], [tech report Fig. 3-4][report], [SEED-Timeline-Annotations][hf-ann]

## 5. Durations and performance

### Durations

- The maximum is 10 s per prompt (300 frames at 30 fps), and training clips were cropped to 10 s. The CLI default is 5.0 s. **confirmed** · [G1-RP card][hf-rp], [limitations.md][d-lim], [tech report pp.5, 10][report]
- Frames per segment = `int(duration × 30)`, truncated.
  - The game's durations in 0.1 s steps from 0.8 to 1.5 s are all exact: 24, 27, 30, 33, 36, 39, 42 and 45 frames.
  - Truncation loses a frame at 4.1 s (122) and 8.2 s (245), but not at 2.3 s (69).
  - N sentences give N × `int(d × 30)` frames in total.
  - The demo rounds instead of truncating, so 1.19 s gives 35 frames in the CLI and 36 in the demo.

  **confirmed** *(corrected)* · [generate.py L131-149][gen-split], [demo/ui.py][demoui]
- Minimum duration:
  - No minimum is documented or enforced for the CLI, the API or the model.
  - The demo UI clamps prompts to 2-10 s (`MIN_DURATION = 2.0` at demo/config.py L32-36; default 6.0).
  - Constrained generation was evaluated only at 3-9 s, and the benchmark's constrained cases run 3.0-10.0 s.
  - The text-only benchmark cases (`timeline_single`) go down to 0.467 s, and 819 of them fall between 0.8 and 1.5 s. Results are published only for the SOMA models.
  - No G1 evaluation has been published at any length.

  **confirmed** *(corrected)* · [demo/config.py][democfg], [UI overview][w-ui], [tech report p.13][report], [benchmark dataset][hf-bench], [benchmark results][w-bench]
- Short actions do appear in the training data. SEED timeline segments (G1-SEED's training set) have a median length of 2.0 s; 14.5% are 1.0 s or shorter and 35.4% are 1.5 s or shorter. G1-RP's segment lengths are not published. This suggests, but does not prove, that short moves are within distribution. **confirmed** · [SEED-Timeline-Annotations][hf-ann], [tech report p.7][report]
- In multi-prompt generation, the 5 blend frames replace the last 5 frames of the earlier segment. The later segment keeps its full frame count, and the total is the sum of the segments. According to the docs, the later prompt still spends part of its time transitioning. **confirmed** *(corrected)* · [kimodo_model.py L187-355][km-multi], [limitations.md][d-lim]

### Performance

- The only published speed is 2-5 s per single-prompt motion on an RTX 3090, "depending on the specified duration". The report does not say how many steps, which CFG mode, or whether text encoding and model loading are included. It describes Kimodo as an offline, batched authoring tool. **unverifiable** · [tech report p.5][report]
- Open PR #54 measured 3.32 s for 1 sample and 23.0 s for 8 samples, on a V100 with SOMA-RP-v1.2, a 5 s clip, 100 steps and separated CFG, excluding text encoding. **unverifiable** · [PR #54][pr54]
- Separated CFG runs 3 batched denoiser passes per step, regular runs 2 and nocfg runs 1. Sampling uses 100 DDIM steps by default, out of 1000 base steps. The docs describe 50-100 steps as faster with slightly lower quality, and 100-200 as higher quality but slower. **unverifiable** · [cfg.py L94-129][cfgpy], [configuration.md][d-cfg]
- VRAM is about 17 GB fully on GPU, mostly for the text encoder. `TEXT_ENCODER_DEVICE=cpu` brings it under 3 GB at "slightly slower" speed, and is advised for cards under 16 GB. Issue #27 reports a 16 GB card running out of memory without it. **unverifiable** · [quick start][w-quick], [issue #27][i27]
- The model card lists test hardware as the RTX 3090, 4090 and 5090, A100, L40S, L4, RTX 6000 Ada and RTX A6000. Open issue #53 reports failures on RTX 50-series cards. **unverifiable** · [G1-RP card][hf-rp], [issue #53][i53]
- The model has 282M parameters (a two-stage transformer with 16 layers, 8 heads and latent size 1024) in a 1.13 GB `model.safetensors`. **unverifiable** · [G1-RP card][hf-rp], [tech report p.10][report]

## 6. Models and licenses

- Use `Kimodo-G1-RP-v1`, NVIDIA's default recommendation. It was trained on the proprietary Bones Rigplay dataset retargeted to the 34-joint G1: ~560 h according to its card, out of 700 h for the full dataset. `Kimodo-G1-SEED-v1` was trained on the public BONES-SEED dataset (288 h), is "less capable", and is mainly for benchmark comparisons. **unverifiable** · [quick start][w-quick], [G1-RP card][hf-rp], [G1-SEED card][hf-seed]
- Both G1 models exist only as v1 (released 2026-03-16); only SOMA has v1.1 and v1.2. The Hugging Face repos `nvidia/Kimodo-G1-RP-v1` and `nvidia/Kimodo-G1-SEED-v1` are not gated and download automatically on first use. **unverifiable** · [G1-RP card][hf-rp], [quick start][w-quick]
- The two G1 config.yaml files are byte-identical, with `cfg_type: separated`, `G1Skeleton34`, `fps: 30` and `input_first_heading_angle: true`. **confirmed** · [G1-RP config.yaml][hf-rp-cfg], [G1-SEED config.yaml][hf-seed-cfg]
- The text encoder is LLM2Vec: `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` plus the `-mntp-supervised` PEFT adapter. Both are MIT-licensed and ungated, and run in bfloat16 with 4096-d embeddings.
  - Their base model, `meta-llama/Meta-Llama-3-8B-Instruct`, is gated with manual approval under the `llama3` license. You need approved access plus a Hugging Face token (`hf auth login` or `~/.cache/huggingface/token`).
  - The maintainer says there is no supported alternative encoder (#16).
  - Users report week-long waits (#13) and rejections (#16, #39).

  **unverifiable** · [load_model.py][lm], [installation][w-install], [HF API][hf-llama], [#13][i13], [#16][i16], [#39][i39]
- G1 training data was retargeted with NVIDIA's Newton-based SOMA retargeter. NVIDIA tracks Kimodo G1 motions with learned physics policies (ProtoMotions on a real G1, GEAR-SONIC in simulation), not raw PD control. No G1-specific quality numbers are published. **unverifiable** · [project page][proj], [tech report][report]
- The Hugging Face Space `nvidia/Kimodo` runs on an L40S and serves the demo for SOMA-RP-v1 and G1-RP-v1. Its Docker setup runs `kimodo_textencoder` (internal, port 9550) next to `kimodo_demo` (port 7860), which makes it a useful reference layout for a GPU server. **unverifiable** · [HF Space][hf-space]

Licenses:
- The code is Apache-2.0, and so is the HF Space. The checkpoints are licensed separately. **unverifiable** · [project info][w-info], [README][readme]
- Both G1 checkpoints use the NVIDIA Open Model License and are marked "ready for commercial use".
  - Commercial use and derivative models are allowed.
  - NVIDIA claims no ownership of outputs, and generated motions count as outputs, not Derivative Models.
  - Redistributing the weights requires a copy of the agreement and a Notice file reading "Licensed by NVIDIA Corporation under the NVIDIA Open Model License".
  - Use must follow NVIDIA's Trustworthy AI terms, and circumventing guardrails terminates the license.

  **unverifiable** · [G1 LICENSE][hf-lic], [NVIDIA Open Model License][nv-oml]
- Other licenses:
  - Kimodo-SMPLX-RP-v1 is gated under an NVIDIA R&D license; we don't use it.
  - The Llama 3 weights carry Meta's `llama3` license, which no researcher read.
  - The bundled unitree_mujoco G1 assets and Menagerie's G1 are BSD-3-Clause.
  - The raw BONES-SEED dataset is gated to academic users or companies under $1M in revenue. That matters only if you download the dataset.

  **unverifiable** · [quick start][w-quick], [ATTRIBUTIONS][attr], [Menagerie G1 README][mreadme], [BONES-SEED][hf-bones]

## 7. Open questions

1. How long does a 0.8-1.5 s G1 clip take on the demo GPU? Compare text-only vs constrained, 100 vs 50 steps, and separated vs nocfg. Also time text encoding and the per-call model load (`kimodo_gen` reloads every run) against a long-running Python process.
2. Clips under 2 s are untested on G1. One fallback is to generate 2 s or more and trim.
3. How good is combat on G1-RP? Test punch, kick, palm strike, block and dodge by eye, along with the Choreographer's prompt template. Whether combat clips were dropped from G1-RP's ~560 h is not documented.
4. What range of the two CFG weights (the Forge slider) is useful? The defaults are [2.0, 2.0] and the G1 examples use 1.0-2.0. Extremes such as 0 or above 3 are untested.
5. How often do real outputs exceed Menagerie joint limits or sink below the floor? Set the quality-check tolerances from measured outputs, and clamp joint targets in the sim regardless.
6. Can PD tracking plus the balance assist in MuJoCo hold Kimodo G1 motions? NVIDIA uses learned tracking policies instead.
7. There is no documented path from MediaPipe landmarks to G1 constraints. One untested candidate: landmarks → G1 qpos via IK → `qpos_to_motion_dict` → `get_save_info`. End-effector accuracy on G1 is not published.
8. Would a `root2d` constraint at frame 0 (`smooth_root_2d [0, 0]`, heading `[1, 0]`) reduce the frame-0 drift? Untested.
9. Can it run offline at the venue? `LOCAL_CACHE` and `CHECKPOINT_DIR` cover the Kimodo checkpoint, but it is not documented whether LLM2Vec/Llama loads with no network.
10. How long will Llama 3 approval take? It is manual, and there is no official fallback encoder.
11. Does Kimodo run on RTX 50-series cards? Issue #53 is still open, so check the demo GPU model early.
12. If G1-SEED is ever used, confirm that `kimodo_convert out.npz out.csv` works end to end. It is unknown whether the RP-only CSV gate changes after `e1c219c`.
13. Can the HF Space give a constraints JSON to the browser? "Save Constraints" writes to a server path, though the repo examples already cover the contract file.
14. Does the NPZ really have the 8th key, `posed_joints_norootpos`? This was read from the source but not run.

[gen]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/generate.py
[gen-csv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/generate.py#L378-L391
[gen-split]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/generate.py#L131-L149
[gen-post]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/generate.py#L325-L338
[gen-ex]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/generate.py#L438-L498
[mj-axes]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L27-L80
[mj-order]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L102-L151
[mj-rest]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L167-L213
[mj-inv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L249-L327
[mj-csv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L329-L344
[mj-clamp]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L431-L544
[mj-qpos]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/mujoco.py#L483-L544
[mjload]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/mujoco_load.py
[g1rig]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/viz/g1_rig.py#L166-L174
[geom]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/geometry.py#L144-L187
[reg]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/registry.py
[lm]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/load_model.py
[km]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/kimodo_model.py
[km-crop]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/kimodo_model.py#L160-L178
[km-multi]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/kimodo_model.py#L187-L355
[cfgpy]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/cfg.py#L94-L129
[cons]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/constraints.py
[base]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/skeleton/base.py#L135-L173
[defs]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/skeleton/definitions.py#L286-L335
[feat]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/motion_rep/feature_utils.py#L110-L125
[rep]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/motion_rep/reps/kimodo_motionrep.py#L186-L257
[conv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/motion_convert_lib.py#L118-L139
[convpy]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/motion_convert.py
[mio]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/exports/motion_io.py#L213-L233
[san]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/sanitize.py#L6-L62
[meta]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/meta.py
[demogen]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/demo/generation.py#L194-L201
[democfg]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/demo/config.py
[demoui]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/demo/ui.py
[txtsrv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/scripts/run_text_encoder_server.py
[l2v]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/model/llm2vec/llm2vec_wrapper.py
[pyproj]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/pyproject.toml
[compose]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docker-compose.yaml
[readme]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/README.md
[attr]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/ATTRIBUTIONS.MD
[kxml]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/assets/skeletons/g1skel34/xml/g1.xml
[ex]: https://github.com/nv-tlabs/kimodo/tree/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/kimodo/assets/demo/examples/kimodo-g1-rp
[d-of]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/user_guide/output_formats.md
[d-cli]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/user_guide/cli.md
[d-cons]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/user_guide/constraints.md
[d-conv]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/user_guide/motion_convert.md
[d-cfg]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/user_guide/configuration.md#L32-L35
[d-lim]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/key_concepts/limitations.md
[d-kcons]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/key_concepts/constraints.md
[d-skel]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/key_concepts/skeleton.md
[d-dcons]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/interactive_demo/constraints.md
[d-export]: https://github.com/nv-tlabs/kimodo/blob/e1c219c99b4b94ba48be1fb6a1cbc64ecee4c954/docs/source/interactive_demo/export_results.md
[w-cons]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/user_guide/constraints.html
[w-quick]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/getting_started/quick_start.html
[w-install]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/getting_started/installation.html
[w-api]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/api_reference/model.html
[w-ui]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/interactive_demo/ui_overview.html
[w-launch]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/interactive_demo/launching.html
[w-bench]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/benchmark/results.html
[w-info]: https://research.nvidia.com/labs/sil/projects/kimodo/docs/project_info.html
[proj]: https://research.nvidia.com/labs/sil/projects/kimodo/
[report]: https://research.nvidia.com/labs/sil/projects/kimodo/assets/kimodo_tech_report.pdf
[hf-rp]: https://huggingface.co/nvidia/Kimodo-G1-RP-v1
[hf-seed]: https://huggingface.co/nvidia/Kimodo-G1-SEED-v1
[hf-rp-cfg]: https://huggingface.co/nvidia/Kimodo-G1-RP-v1/resolve/main/config.yaml
[hf-seed-cfg]: https://huggingface.co/nvidia/Kimodo-G1-SEED-v1/resolve/main/config.yaml
[hf-soma]: https://huggingface.co/nvidia/Kimodo-SOMA-RP-v1/raw/main/README.md
[hf-lic]: https://huggingface.co/nvidia/Kimodo-G1-RP-v1/raw/main/LICENSE
[nv-oml]: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
[hf-llama]: https://huggingface.co/api/models/meta-llama/Meta-Llama-3-8B-Instruct
[hf-ann]: https://huggingface.co/datasets/nvidia/SEED-Timeline-Annotations
[hf-bench]: https://huggingface.co/datasets/nvidia/Kimodo-Motion-Gen-Benchmark
[hf-space]: https://huggingface.co/spaces/nvidia/Kimodo
[hf-bones]: https://huggingface.co/api/datasets/bones-studio/seed
[i13]: https://github.com/nv-tlabs/kimodo/issues/13
[i16]: https://github.com/nv-tlabs/kimodo/issues/16
[i27]: https://github.com/nv-tlabs/kimodo/issues/27
[i29]: https://github.com/nv-tlabs/kimodo/issues/29
[i39]: https://github.com/nv-tlabs/kimodo/issues/39
[i53]: https://github.com/nv-tlabs/kimodo/issues/53
[pr54]: https://github.com/nv-tlabs/kimodo/pull/54
[mxml]: https://github.com/google-deepmind/mujoco_menagerie/blob/ac6b2b09983786f3036cab1000221017fa2193b4/unitree_g1/g1.xml
[mhands]: https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/main/unitree_g1/g1_with_hands.xml
[mreadme]: https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/main/unitree_g1/README.md
[unitree]: https://raw.githubusercontent.com/unitreerobotics/unitree_mujoco/main/unitree_robots/g1/g1_29dof.xml