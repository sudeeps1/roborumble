"""Unitree G1 facts the server needs. Sources: docs/kimodo-g1.md sections 1 and 3."""
from __future__ import annotations

import re
from pathlib import Path

from . import config

# CSV columns 7..35, in order. Matches Menagerie unitree_g1/g1.xml exactly.
JOINT_NAMES = [
    "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
    "left_ankle_pitch_joint", "left_ankle_roll_joint",
    "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint", "right_knee_joint",
    "right_ankle_pitch_joint", "right_ankle_roll_joint",
    "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint",
    "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint", "left_elbow_joint",
    "left_wrist_roll_joint", "left_wrist_pitch_joint", "left_wrist_yaw_joint",
    "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint", "right_elbow_joint",
    "right_wrist_roll_joint", "right_wrist_pitch_joint", "right_wrist_yaw_joint",
]
NQ = 7 + len(JOINT_NAMES)  # 36

# G1Skeleton34 indices (Kimodo's posed_joints) used to find hit_frame. The skeleton has no head joint,
# so head and chest use the top of the waist.
HIT_JOINT_SKEL = {"r_hand": 33, "l_hand": 25, "r_foot": 14, "l_foot": 7, "head": 17, "chest": 17}
# Without posed_joints (mock engine), hit_frame comes from these hinge columns instead.
HIT_JOINT_HINGES = {
    "r_hand": [22, 23, 24, 25], "l_hand": [15, 16, 17, 18],
    "r_foot": [6, 7, 8, 9], "l_foot": [0, 1, 2, 3],
    "head": [12, 13, 14], "chest": [12, 13, 14],
}

# Upright pelvis height and the T-pose knee bend Kimodo exports (docs/kimodo-g1.md section 1).
PELVIS_Z = 0.79


def find_xml() -> Path | None:
    """The G1 MJCF: G1_XML, Kimodo's bundled copy, or the client's Menagerie download."""
    import os

    if os.environ.get("G1_XML"):
        return Path(os.environ["G1_XML"])
    try:
        import importlib.util

        spec = importlib.util.find_spec("kimodo")
        if spec and spec.origin:
            p = Path(spec.origin).parent / "assets" / "skeletons" / "g1skel34" / "xml" / "g1.xml"
            if p.exists():
                return p
    except Exception:
        pass
    p = config.ROOT / "client" / "public" / "g1" / "g1.xml"
    return p if p.exists() else None


def joint_limits() -> dict[int, tuple[float, float]]:
    """Hinge column (0..28) -> (lo, hi) in radians, or {} when no XML is around."""
    path = find_xml()
    if not path:
        return {}
    xml = path.read_text()
    out: dict[int, tuple[float, float]] = {}
    for m in re.finditer(r"<joint\b[^>]*>", xml):
        tag = m.group(0)
        name = re.search(r'name="([^"]+)"', tag)
        rng = re.search(r'range="([^"]+)"', tag)
        if name and rng and name.group(1) in JOINT_NAMES:
            lo, hi = (float(x) for x in rng.group(1).split())
            out[JOINT_NAMES.index(name.group(1))] = (lo, hi)
    return out
