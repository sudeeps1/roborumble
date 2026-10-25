# Pose the built rig from G1 joint angles inside Blender, with the same math the game runtime uses:
#   bone_world = body_now @ inverse(body_bind) @ bone_bind
# Works headless or in a live Blender (no edit mode needed):
#   import pose; pose.apply(bpy.data.objects["ElfRig"], pose.POSES["guard"])
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import g1  # noqa: E402

# Test poses as G1 joint angles (radians). Signs: shoulder pitch < 0 raises the arm forward, left shoulder
# roll > 0 swings it out, elbow 0 = forearm horizontal (+1.57 hangs straight), knee > 0 bends.
_LEGS_BENT = {"left_hip_pitch_joint": -0.32, "left_knee_joint": 0.62, "left_ankle_pitch_joint": -0.30,
              "right_hip_pitch_joint": -0.32, "right_knee_joint": 0.62, "right_ankle_pitch_joint": -0.30}
_GUARD_ARMS = {"left_shoulder_pitch_joint": -0.55, "left_shoulder_roll_joint": 0.18, "left_elbow_joint": -0.75,
               "right_shoulder_pitch_joint": -0.45, "right_shoulder_roll_joint": -0.18, "right_elbow_joint": -0.85,
               "left_wrist_pitch_joint": -0.2, "right_wrist_pitch_joint": -0.2}
POSES = {
    "bind": dict(g1.BIND),
    "guard": {**_LEGS_BENT, **_GUARD_ARMS, "waist_yaw_joint": 0.15},
    "jab": {**_LEGS_BENT, **_GUARD_ARMS, "waist_yaw_joint": -0.35,
            "left_shoulder_pitch_joint": -1.50, "left_shoulder_roll_joint": 0.05, "left_elbow_joint": 1.35,
            "left_shoulder_yaw_joint": 0.3},
    "kick": {**_GUARD_ARMS, "right_hip_pitch_joint": -1.35, "right_knee_joint": 0.35, "right_ankle_pitch_joint": 0.2,
             "left_hip_pitch_joint": -0.15, "left_knee_joint": 0.3, "left_ankle_pitch_joint": -0.15,
             "waist_pitch_joint": 0.15},
    "hit": {**_LEGS_BENT, "waist_pitch_joint": -0.4, "waist_roll_joint": 0.25,
            "left_shoulder_pitch_joint": 0.3, "left_shoulder_roll_joint": 0.9, "left_elbow_joint": 0.6,
            "right_shoulder_pitch_joint": -0.8, "right_shoulder_roll_joint": -0.5, "right_elbow_joint": 0.2},
}


def _mat(pos, quat):
    M = np.eye(4)
    M[:3, :3] = g1.quat_mat(quat)
    M[:3, 3] = pos
    return M


def body_poses(angles):
    """FK with the pelvis lowered so the lowest foot touches the floor."""
    W = g1.fk(angles)
    sole = min((W[f] @ np.array([x, 0, -0.035, 1]))[2] for f in ("left_ankle_roll_link", "right_ankle_roll_link")
               for x in (-0.05, 0.12))
    return g1.fk(angles, root_pos=(0, 0, 0.793 - sole))


def apply(arm_ob, angles):
    import mathutils
    meta = json.loads(arm_ob["g1_rig"])
    W = body_poses(angles)
    target = {}   # armature-space matrix per bone
    for pb in arm_ob.pose.bones:   # parents come before children
        bone = pb.bone
        bind = np.array(bone.matrix_local)
        info = meta["bones"].get(pb.name)
        if info:
            body_bind = _mat(info["pos"], info["quat"])
            target[pb.name] = W[info["body"]] @ np.linalg.inv(body_bind) @ bind
        elif bone.parent:
            # spring bones ride rigidly on their parent here
            pbind = np.array(bone.parent.matrix_local)
            target[pb.name] = target[bone.parent.name] @ np.linalg.inv(pbind) @ bind
        else:
            target[pb.name] = bind
        if bone.parent:
            pbind = np.array(bone.parent.matrix_local)
            basis = np.linalg.inv(bind) @ pbind @ np.linalg.inv(target[bone.parent.name]) @ target[pb.name]
        else:
            basis = np.linalg.inv(bind) @ target[pb.name]
        pb.matrix_basis = mathutils.Matrix(basis.tolist())


if __name__ == "__main__":
    # Blender -b characters/public/elf.blend -P characters/blender/pose.py -- guard,jab,kick OUT_DIR
    import bpy

    import render_previews

    names, out = sys.argv[sys.argv.index("--") + 1].split(","), Path(sys.argv[sys.argv.index("--") + 2])
    scene = bpy.context.scene
    arm = bpy.data.objects["ElfRig"]
    for i, nm in enumerate(names):
        apply(arm, POSES[nm])
        bpy.context.view_layer.update()
        shots = {f"{nm}_34": ((2.0, 1.4, 1.0), (0.05, 0, 0.65), 50, (700, 900)),
                 f"{nm}_side": ((0.3, 2.6, 0.9), (0.1, 0, 0.62), 50, (700, 900))}
        if i == 0:
            render_previews.render(scene, out, shots=shots)   # adds lights, floor and camera once
            continue
        cam = scene.camera
        for shot, (loc, tgt, lens, res) in shots.items():
            cam.location = loc
            render_previews._look(cam, tgt)
            cam.data.lens = lens
            scene.render.resolution_x, scene.render.resolution_y = res
            scene.render.filepath = str(out / f"{shot}.png")
            bpy.ops.render.render(write_still=True)
