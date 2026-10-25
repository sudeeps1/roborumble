# Every published everyday clip -> G1 body poses per frame (MuJoCo FK), for the character mesh check.
# Root re-based to xy 0 on frame 0; heading kept. Also the guard anchor as the reference pose.
import json, os, sys, mujoco, numpy as np
xml, lib, anchors, out = sys.argv[1:5]
m = mujoco.MjModel.from_xml_path(xml); d = mujoco.MjData(m)
names = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, i) for i in range(1, m.nbody)]
def poses(rows, step):
    fr = []
    x0, y0 = rows[0][0], rows[0][1]
    for r in rows[::step]:
        q = np.array(r[:m.nq], float); q[0] -= x0; q[1] -= y0
        d.qpos[:] = q; mujoco.mj_kinematics(m, d)
        fr.append([round(float(v), 5) for i in range(1, m.nbody) for v in (*d.xpos[i], *d.xquat[i])])
    return fr
idx = json.load(open(os.path.join(lib, "index.json")))
clips = {}
for key, files in idx.items():
    for f in files:
        c = json.load(open(os.path.join(lib, f)))
        step = max(1, round(c.get("fps", 30) / 15))  # ~15 frames a second is plenty for poses
        clips[f.replace(".json", "")] = {"motion": key, "frames": poses(c["qpos"], step)}
a = json.load(open(anchors))
for k in ("guard", "guard.low", "guard.high"):
    if k in a: clips["anchor_" + k] = {"motion": "anchor", "frames": poses([a[k]["qpos"]], 1)}
json.dump({"bodies": names, "clips": clips}, open(out, "w"))
print(len(clips), "clips,", sum(len(c["frames"]) for c in clips.values()), "frames,", len(names), "bodies")
