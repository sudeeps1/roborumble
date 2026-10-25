# G1 forward kinematics from src/g1_kinematics.json (MuJoCo frame: meters, Z up, robot faces +X, left is +Y).
import json
from pathlib import Path

import numpy as np

KIN = json.loads((Path(__file__).resolve().parent.parent / "src" / "g1_kinematics.json").read_text())["bodies"]
NAMES = [b["name"] for b in KIN]


def quat_mat(q):
    w, x, y, z = q
    n = (w * w + x * x + y * y + z * z) ** 0.5
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def axis_angle(axis, a):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    return quat_mat([np.cos(a / 2), *(axis * np.sin(a / 2))])


def mat_quat(R):
    """Rotation matrix -> [w, x, y, z]."""
    t = R[0, 0] + R[1, 1] + R[2, 2]
    if t > 0:
        s = 0.5 / np.sqrt(t + 1)
        q = [0.25 / s, (R[2, 1] - R[1, 2]) * s, (R[0, 2] - R[2, 0]) * s, (R[1, 0] - R[0, 1]) * s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2 * np.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2])
        q = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = 2 * np.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2])
        q = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    else:
        s = 2 * np.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1])
        q = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def fk(angles=None, root_pos=(0, 0, 0.793)):
    """angles: {joint_name: radians}. Returns {body_name: 4x4 world matrix}."""
    angles = angles or {}
    out = {}
    for b in KIN:
        M = np.eye(4)
        M[:3, :3] = quat_mat(b["quat"])
        M[:3, 3] = b["pos"] if b["parent"] >= 0 else root_pos
        j = b["joint"]
        if j and j["name"] in angles:
            J = np.eye(4)
            J[:3, :3] = axis_angle(j["axis"], angles[j["name"]])
            M = M @ J
        out[b["name"]] = out[KIN[b["parent"]]["name"]] @ M if b["parent"] >= 0 else M
    return out


# The pose the character is modeled and skinned in: arms out ~20 degrees with soft elbows, legs straight.
# Any pose works for the runtime (it re-derives offsets), this one just keeps shoulders and elbows mid-range.
BIND = {
    "left_shoulder_roll_joint": 0.30, "right_shoulder_roll_joint": -0.30,
    "left_elbow_joint": 0.85, "right_elbow_joint": 0.85,
    "left_shoulder_yaw_joint": 0.0, "right_shoulder_yaw_joint": 0.0,
}
