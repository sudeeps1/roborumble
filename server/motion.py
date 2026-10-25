"""Checks and measurements on a generated clip: quality checks, hit_frame, originality features.

Tolerances come from docs/kimodo-g1.md: real G1-RP output goes up to 7.6 deg past joint limits and feet
reach -4.8 cm, and that's normal.
"""
from __future__ import annotations

import math

import numpy as np

from .engine import Generated
from .g1 import HIT_JOINT_HINGES, HIT_JOINT_SKEL

MIN_TRAVEL = 0.8          # rad, summed range of all hinges: below this the body barely moved
MAX_ROOT_DRIFT = 1.5      # m, horizontal, from frame 0
MIN_FOOT_Y = -0.08        # m, Kimodo frame (Y up)
LIMIT_SLACK = math.radians(12)


def quality_check(g: Generated, limits: dict[int, tuple[float, float]]) -> str | None:
    """Name of the first failed check, or None."""
    q = g.qpos
    if q.ndim != 2 or q.shape[0] < 2 or not np.isfinite(q).all() or (g.joints is not None and not np.isfinite(g.joints).all()):
        return "nan_frames"
    hinges = q[:, 7:]
    if float((hinges.max(0) - hinges.min(0)).sum()) < MIN_TRAVEL:
        return "barely_moved"
    drift = np.linalg.norm(q[:, :2] - q[0, :2], axis=1).max()
    if drift > MAX_ROOT_DRIFT:
        return "root_drift"
    if g.joints is not None and float(g.joints[..., 1].min()) < MIN_FOOT_Y:
        return "below_floor"
    for col, (lo, hi) in limits.items():
        v = hinges[:, col]
        if v.min() < lo - LIMIT_SLACK or v.max() > hi + LIMIT_SLACK:
            return "joint_limits"
    return None


FK_BODIES = {"r_hand": "right_wrist_yaw_link", "l_hand": "left_wrist_yaw_link", "r_foot": "right_ankle_roll_link",
             "l_foot": "left_ankle_roll_link", "chest": "torso_link", "head": "torso_link"}
_fk = None


def _fk_model():
    """MuJoCo G1 for forward kinematics, or None (laptop without mujoco)."""
    global _fk
    if _fk is None:
        try:
            import mujoco

            from .g1 import find_xml

            m = mujoco.MjModel.from_xml_path(str(find_xml()))
            ids = {k: mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, n) for k, n in FK_BODIES.items()}
            ids["pelvis"] = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "pelvis")
            _fk = (mujoco, m, mujoco.MjData(m), ids)
        except Exception:
            _fk = False
    return _fk or None


def track(qpos: np.ndarray, joint: str) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """World positions (MuJoCo: Z up) of `joint` and the pelvis per frame, and the pelvis forward axis at frame 0."""
    fk = _fk_model()
    if fk is None:
        return None
    mujoco, m, d, ids = fk
    pts, pel = np.zeros((len(qpos), 3)), np.zeros((len(qpos), 3))
    fwd = np.array([1.0, 0, 0])
    for t, row in enumerate(qpos):
        d.qpos[:] = row
        mujoco.mj_kinematics(m, d)
        pts[t], pel[t] = d.xpos[ids[joint]], d.xpos[ids["pelvis"]]
        if t == 0:
            fwd = d.xmat[ids["pelvis"]].reshape(3, 3)[:, 0].copy()
    fwd[2] = 0
    return pts, pel, fwd / (np.linalg.norm(fwd) or 1)


def hit_frame(g: Generated, hit_joint: str, kind: str = "melee", effect: str = "") -> int:
    """The frame the move connects. Punches and projectiles: when the limb is reaching out in front (90% of
    its farthest reach), else its fastest push forward. Strikes from above, shockwaves and ground slams: its
    fastest drop. Anything else: its fastest movement."""
    T = g.qpos.shape[0]
    if T < 3:
        return 0
    tr = track(g.qpos, hit_joint if hit_joint in FK_BODIES else "r_hand")
    if tr is not None:
        pts, pel, fwd = tr
        rel = pts - pel
        if kind in ("melee", "projectile"):
            # Not the fastest frame: Kimodo clips often open with a quick swing up from the hip, which put
            # the hit (and its sparks) at the attacker's hip before the punch was thrown.
            reach = rel @ fwd
            if reach.max() - reach[0] > 0.05:
                return int(np.argmax(reach >= reach[0] + 0.9 * (reach.max() - reach[0])))
            score = np.diff(rel, axis=0) @ fwd  # barely reaches forward (hooks, elbows): fastest push
        elif kind in ("strike", "shockwave") or effect == "earth_wall":
            score = -np.diff(pts[:, 2])
        else:
            score = np.linalg.norm(np.diff(rel, axis=0), axis=1)
        score = np.convolve(score, np.ones(3) / 3, mode="same")  # one jittery frame shouldn't win
        return int(score.argmax()) + 1
    if g.joints is not None and hit_joint in HIT_JOINT_SKEL:
        p = g.joints[:, HIT_JOINT_SKEL[hit_joint]]
        # relative to the pelvis, so walking forward doesn't count as striking
        p = p - g.joints[:, 0]
        speed = np.linalg.norm(np.diff(p, axis=0), axis=1)
    else:
        cols = [7 + c for c in HIT_JOINT_HINGES.get(hit_joint, HIT_JOINT_HINGES["r_hand"])]
        speed = np.abs(np.diff(g.qpos[:, cols], axis=0)).sum(1)
    return int(speed.argmax()) + 1


def features(qpos: np.ndarray, n: int = 16) -> np.ndarray:
    """Unit vector describing the clip's shape: hinge angles resampled to n frames, plus root motion."""
    T = qpos.shape[0]
    idx = np.linspace(0, T - 1, n)
    lo = np.floor(idx).astype(int)
    hi = np.minimum(lo + 1, T - 1)
    w = (idx - lo)[:, None]
    rows = qpos[lo] * (1 - w) + qpos[hi] * w
    root = rows[:, :3] - rows[0, :3]
    v = np.concatenate([rows[:, 7:].ravel(), 2.0 * root.ravel()])
    v = v - v.mean()
    norm = np.linalg.norm(v)
    return v / norm if norm > 1e-9 else v


def stability_guess(qpos: np.ndarray) -> float:
    """Placeholder until the Balance Referee runs moves in MuJoCo: big root travel, crouching and
    one-legged poses read as risky."""
    drift = float(np.linalg.norm(qpos[:, :2] - qpos[0, :2], axis=1).max())
    dip = float(max(0.0, 0.79 - qpos[:, 2].min()))
    legs = float(np.abs(qpos[:, [7 + 0, 7 + 6]]).max())  # hip pitch
    s = 1.0 - 0.35 * min(drift / 1.0, 1) - 0.35 * min(dip / 0.4, 1) - 0.3 * min(legs / 1.5, 1)
    return round(max(0.1, min(1.0, s)), 2)
