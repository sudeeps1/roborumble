# Using the GPU (Kimodo) without touching the GPU box

The game server runs on a RunPod RTX 4090 with Kimodo loaded. Everyone uses it over HTTPS; only Vaibhav
SSHes into the box. Endpoints and message shapes: `contract/api.md`, `contract/ws.md`.

**Server:** `https://kr2vjwse2bhd6t-8000.proxy.runpod.net` (if the pod restarts, Vaibhav posts the new link)

## Run the game screen against real Kimodo motions

```
cd client
printf 'SERVER_URL=https://kr2vjwse2bhd6t-8000.proxy.runpod.net\nVITE_JOIN_URL=https://kr2vjwse2bhd6t-8000.proxy.runpod.net/phone/?room={code}\n' > .env.local
npm install && npm run dev
```
Open the localhost link with `?room=TEST`. Phones (or a second browser tab) join at
`https://kr2vjwse2bhd6t-8000.proxy.runpod.net/phone/?room=TEST` and can type spells, so no mic is needed.

## Get motions for the physics sim

```
S=https://kr2vjwse2bhd6t-8000.proxy.runpod.net
curl -s $S/health                         # engine "kimodo", library size, queue
curl -s $S/library/moves | head -c 600    # every move: id, name, type, kind, motion_id
curl -s $S/idle > idle.json               # the idle stance
curl -s $S/motion/mo_00001 > hook.json    # any motion: {id, fps: 30, joint_names (29), qpos: [[36 numbers] per frame]}
```
qpos rows are Kimodo's G1 CSV as-is: MuJoCo axes (Z up, +X forward), root xyz, root quaternion w-first,
then 29 hinge angles in the order of `joint_names` (= Menagerie `unitree_g1/g1.xml`). Frame 0 is near the
origin, not on it; the root quaternion sign can flip between frames; hinges can be ~8 deg past the joint
limits. See `docs/kimodo-g1.md` section 1.

## Natural character animations (clips)

Non-attack animations made by Kimodo on the GPU: idles (one per character, with a personality), steps,
dodges, jump, block, hit reactions, stagger, fall, get up, charge-up, taunt, entrance, victory, defeat.
They are motions only (same format as above), never moves, so nobody can cast them.

```
curl -s $S/clips                      # [{name, prompt, duration, motion_id, status}]
curl -s $S/clip/idle_hush > idle_hush.json
curl -s $S/clip/get_up > get_up.json
```
Ready now: idle_fighting, idle_breathe, idle_bramble, idle_marigold, idle_flicker, idle_rime, idle_hush,
step_forward, step_back, dodge_left, dodge_right, jump, block, hit_head, hit_body, stagger, fall_back,
get_up, charge_up, taunt, entrance, victory, defeat (list in `server/clips.json`).

Need another one, or a better version? Ask Kimodo for it (about 1 s, same name overwrites):
```
curl -s -X POST $S/clip -H 'Content-Type: application/json' \
  -d '{"name": "idle_hush", "prompt": "a stealthy person crouches low and sways slowly side to side", "duration": 4}'
```
Prompt tips: start with "a person" (styles work: "an old person", "a childlike person", "a stealthy
person", "a tired person", "a happy person"…), describe body movement only, no periods. Idles don't loop
seamlessly: crossfade the end into the start in the sim.

## Generate a new motion (about 1 s)

```
JOB=$(curl -s -X POST $S/generate -H 'Content-Type: application/json' -d '{
  "name": "Test Kick", "kimodo_prompt": "a person pivots and swings a high right roundhouse kick",
  "type": "physical", "kind": "melee", "hit_joint": "r_foot", "duration": 1.2, "power": 2}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["job"])')
curl -s $S/job/$JOB          # {"status":"done","move":{..., "motion_id": "mo_000NN", "hit_frame": ...}}
```
`kimodo_prompt` rules: start with "a person", plain body movement only, never a `.` in it.
Every generated move joins the shared library, so keep test names obviously test-like.

## Please don't
- Run big loops of `/generate` (the GPU is shared with the overnight agent and live games).
- Install Kimodo locally: it needs a 24 GB NVIDIA GPU and gated Llama access.
