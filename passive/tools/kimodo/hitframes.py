# Writes meta.hit_frame into punch clips: the frame where the striking hand (meta.hit_limb) is
# furthest forward of where the pelvis started, along the clip's starting heading (MuJoCo FK).
#   ~/kvenv/bin/python tools/kimodo/hitframes.py public/g1/g1_29dof.xml clip.json [...]
import json, math, sys
import mujoco
import numpy as np

xml, files = sys.argv[1], sys.argv[2:]
m = mujoco.MjModel.from_xml_path(xml)
d = mujoco.MjData(m)
HAND = {"l_hand": "left_wrist_yaw_link", "r_hand": "right_wrist_yaw_link"}
for f in files:
    clip = json.load(open(f))
    meta = clip.setdefault("meta", {})
    limb = meta.get("hit_limb") or meta.get("hit_joint")
    if limb not in HAND: print(f, "no hit_limb, skipped"); continue
    body = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, HAND[limb])
    q0 = clip["qpos"][0]
    w, x, y, z = q0[3:7]
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    fwd = np.array([math.cos(yaw), math.sin(yaw), 0.0])
    reach = []
    for row in clip["qpos"]:
        d.qpos[:] = row[: m.nq]
        mujoco.mj_kinematics(m, d)
        reach.append(float(np.dot(d.xpos[body] - np.array(q0[:3]), fwd)))
    k = int(np.argmax(reach))
    meta["hit_frame"] = k
    json.dump(clip, open(f, "w"))
    print(f"{f}: {limb} furthest at frame {k} ({k / clip['fps']:.2f} s, reach {reach[k]:.2f} m; start {reach[0]:.2f} m; key was {meta.get('key')})")
