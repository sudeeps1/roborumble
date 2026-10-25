"""Forge: a move the player acted out on their phone becomes a Kimodo move.

Phone sends MediaPipe Pose world landmarks (33 points per frame, meters, hip-centered). Here:
1. find the active part of the clip and pick up to 4 keyframes (start, wind-up, peak extension, finish)
2. turn each keyframe into a G1 pose: rotate the landmarks into the robot's frame (forward, left, up),
   scale to G1 size, and solve for the 29 joint angles + pelvis rotation with least squares on MuJoCo FK
3. exaggerate the poses (the Go wild slider) and hand them to Kimodo as full-body keyframe constraints,
   with a plain body-motion prompt, so Kimodo fills in a smooth, bigger version of the move.

Without MuJoCo (a laptop running the mock engine) step 2 is skipped and the move is text-only.
"""
from __future__ import annotations

import re
from typing import Any

import numpy as np

from . import wildcard
from .g1 import JOINT_NAMES, find_xml

# MediaPipe Pose landmark -> G1 body whose origin sits at that joint, and how much it matters.
PAIRS = [
    ("left_shoulder_pitch_link", 11, 0.6), ("right_shoulder_pitch_link", 12, 0.6),
    ("left_elbow_link", 13, 1.0), ("right_elbow_link", 14, 1.0),
    ("left_wrist_yaw_link", 15, 2.0), ("right_wrist_yaw_link", 16, 2.0),
    ("left_hip_pitch_link", 23, 0.5), ("right_hip_pitch_link", 24, 0.5),
    ("left_knee_link", 25, 1.0), ("right_knee_link", 26, 1.0),
    ("left_ankle_roll_link", 27, 1.5), ("right_ankle_roll_link", 28, 1.5),
]
NEUTRAL = np.zeros(29)
NEUTRAL[[3, 9]] = 0.3      # soft knees
NEUTRAL[[4, 10]] = -0.15
LIMBS = {"r_hand": 16, "l_hand": 15, "r_foot": 28, "l_foot": 27}


class Fitter:
    """G1 inverse kinematics on MuJoCo forward kinematics."""

    def __init__(self) -> None:
        import mujoco

        self.mj = mujoco
        path = find_xml()
        if not path:
            raise RuntimeError("no G1 xml")
        self.m = mujoco.MjModel.from_xml_path(str(path))
        self.d = mujoco.MjData(self.m)
        self.body = {n: mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, n) for n, _, _ in PAIRS}
        jids = [mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, n) for n in JOINT_NAMES]
        self.lo = np.array([self.m.jnt_range[j][0] for j in jids])
        self.hi = np.array([self.m.jnt_range[j][1] for j in jids])
        self.foot = [self.body["left_ankle_roll_link"], self.body["right_ankle_roll_link"]]
        # G1 hip-centre to shoulder-centre distance, for scaling the player to robot size
        p = self._fk(np.zeros(3), NEUTRAL)
        self.torso = float(np.linalg.norm(self._mid(p, "shoulder") - self._mid(p, "hip")))

    def _fk(self, rotvec: np.ndarray, q: np.ndarray) -> dict[str, np.ndarray]:
        from scipy.spatial.transform import Rotation

        x, y, z, w = Rotation.from_rotvec(rotvec).as_quat()
        self.d.qpos[:3] = (0, 0, 0.79)
        self.d.qpos[3:7] = (w, x, y, z)
        self.d.qpos[7:] = q
        self.mj.mj_kinematics(self.m, self.d)
        return {n: self.d.xpos[i].copy() for n, i in self.body.items()}

    @staticmethod
    def _mid(p: dict[str, np.ndarray], part: str) -> np.ndarray:
        if part == "hip":
            return (p["left_hip_pitch_link"] + p["right_hip_pitch_link"]) / 2
        return (p["left_shoulder_pitch_link"] + p["right_shoulder_pitch_link"]) / 2

    def fit(self, targets: dict[str, np.ndarray], x0: np.ndarray | None) -> np.ndarray:
        """targets: G1 body -> position relative to the hip centre. Returns a 36-number qpos row."""
        from scipy.optimize import least_squares
        from scipy.spatial.transform import Rotation

        weights = {n: w for n, _, w in PAIRS}

        def residual(x: np.ndarray) -> np.ndarray:
            p = self._fk(x[:3], x[3:])
            hip = self._mid(p, "hip")
            r = [weights[n] * ((p[n] - hip) - t) for n, t in targets.items()]
            r.append(0.08 * (x[3:] - NEUTRAL))  # stay near a natural stance when the camera is unsure
            return np.concatenate(r)

        lo = np.concatenate([[-np.pi] * 3, self.lo])
        hi = np.concatenate([[np.pi] * 3, self.hi])
        start = np.concatenate([np.zeros(3), NEUTRAL]) if x0 is None else x0
        sol = least_squares(residual, np.clip(start, lo + 1e-6, hi - 1e-6), bounds=(lo, hi), max_nfev=80)
        x = sol.x
        # stand the robot on the floor: lowest ankle about 7 cm up
        p = self._fk(x[:3], x[3:])
        lift = 0.075 - min(p["left_ankle_roll_link"][2], p["right_ankle_roll_link"][2])
        qx, qy, qz, qw = Rotation.from_rotvec(x[:3]).as_quat()
        return np.concatenate([[0, 0, 0.79 + lift, qw, qx, qy, qz], x[3:]]), x

    def exaggerate(self, row: np.ndarray, k: float) -> np.ndarray:
        out = row.copy()
        out[7:] = np.clip(NEUTRAL + k * (row[7:] - NEUTRAL), self.lo, self.hi)
        return out


_fitter: Fitter | None = None
_fitter_error: str | None = None


def fitter() -> Fitter | None:
    global _fitter, _fitter_error
    if _fitter is None and _fitter_error is None:
        try:
            _fitter = Fitter()
        except Exception as e:  # mujoco or scipy missing (laptop), or no xml
            _fitter_error = f"{type(e).__name__}: {e}"
            print(f"forge: pose fitting off ({_fitter_error}); Forge moves are text-only")
    return _fitter


# ---------- analysing the recording ----------
def body_frame(lm: np.ndarray) -> np.ndarray:
    """Rows: the player's forward, left and up, found from the data (works whatever MediaPipe's axes are)."""
    hips, shoulders = (lm[:, 23] + lm[:, 24]) / 2, (lm[:, 11] + lm[:, 12]) / 2
    up = (shoulders - hips).mean(0)
    up /= np.linalg.norm(up)
    left = (lm[:, 23] - lm[:, 24]).mean(0)
    left -= up * (left @ up)
    left /= np.linalg.norm(left)
    fwd = np.cross(left, up)
    return np.stack([fwd, left, up])


def active_span(lm: np.ndarray) -> tuple[int, int]:
    ends = lm[:, [15, 16, 27, 28]]
    speed = np.linalg.norm(np.diff(ends, axis=0), axis=2).sum(1)
    speed = np.convolve(speed, np.ones(5) / 5, mode="same")
    if speed.max() <= 1e-6:
        return 0, len(lm) - 1
    on = np.where(speed > 0.25 * speed.max())[0]
    return max(0, int(on[0]) - 3), min(len(lm) - 1, int(on[-1]) + 4)


def describe(lm: np.ndarray, R: np.ndarray) -> tuple[str, str]:
    """(plain body-motion phrase for Kimodo, hit_joint) from which limb travelled most and where."""
    hips = (lm[:, 23] + lm[:, 24]) / 2
    travel = {k: float(np.linalg.norm(np.diff(lm[:, i], axis=0), axis=1).sum()) for k, i in LIMBS.items()}
    hit = max(travel, key=travel.get)
    i = LIMBS[hit]
    rel = (lm[:, i] - hips) @ R.T  # forward, left, up
    peak = rel[np.linalg.norm(rel, axis=1).argmax()]
    side = "right" if hit.startswith("r") else "left"
    both = hit.endswith("hand") and travel["l_hand" if side == "right" else "r_hand"] > 0.6 * travel[hit]
    if hit.endswith("foot"):
        phrase = f"kicks the {side} leg forward hard" if peak[0] > 0.2 else f"lifts the {side} knee high and stomps down hard"
    elif peak[2] > 0.55:
        phrase = "raises both arms high overhead and then swings them down hard in front" if both else \
            f"raises the {side} arm high overhead and then slams it down in front"
    elif peak[0] > 0.3:
        phrase = "winds up and thrusts both palms forward hard at chest height" if both else \
            f"winds up and throws the {side} arm forward hard"
    else:
        phrase = "swings both arms out wide and spins the upper body" if both else f"swings the {side} arm in a wide arc"
    return f"a person {phrase} with big powerful movements", hit


# describe()'s phrases -> the kind of move they look like
MOTION_KIND = [("shockwave", r"stomps down|swings them down hard|spins"), ("strike", r"slams it down"),
               ("projectile", r"thrusts both palms")]


def plan(landmarks: list, fps: float, name: str, wild: float) -> dict[str, Any]:
    """Everything the job needs: spec, constraints (or None), cfg weights."""
    lm = np.asarray(landmarks, dtype=float)
    if lm.ndim != 3 or lm.shape[1] < 33 or lm.shape[0] < 8:
        raise ValueError("need at least 8 frames of 33 landmarks")
    lm = lm[:, :33, :3]
    R = body_frame(lm)
    a, b = active_span(lm)
    seg = lm[a:b + 1]
    seconds = float(np.clip(len(seg) / max(fps, 1), 1.0, 2.5))
    frames = int(seconds * 30)
    prompt, hit = describe(seg, R)

    spec = wildcard.keyword_spec(name)
    if not any(re.search(rx, name.lower()) for _, rx in wildcard.KIND_WORDS):
        # the name says nothing about the kind of move: go by what the player acted
        spec["kind"] = next((k for k, rx in MOTION_KIND if re.search(rx, prompt)), "melee")
        spec["effect"] = "shockwave" if spec["kind"] == "shockwave" else wildcard.EFFECT[spec["type"]]
    spec.update(name=_title(name), kimodo_prompt=prompt, hit_joint=spec["hit_joint"] if spec["kind"] == "defend" else hit,
                duration=round(seconds, 2), power=3 if wild > 0.66 else 2)
    if spec["name"].lower() not in spec["aliases"]:
        spec["aliases"].insert(0, spec["name"].lower())
    w = float(np.clip(wild, 0, 1))
    cfg = (round(1.5 + 1.5 * w, 2), round(3.0 - 2.0 * w, 2))  # follow my acting [1.5, 3] <-> go wild [3, 1]

    f = fitter()
    if f is None:
        return {"spec": spec, "constraints_rows": None, "frame_indices": None, "cfg": cfg, "fit": "off"}

    # keyframes: wind-up, peak extension, two more spread across the move
    hips = (seg[:, 23] + seg[:, 24]) / 2
    ext = np.linalg.norm(seg[:, LIMBS[hit]] - hips, axis=1)
    L = len(seg) - 1
    picks = sorted({int(round(L * 0.1)), int(ext.argmin()), int(ext.argmax()), int(round(L * 0.9))})
    picks = [p for i, p in enumerate(picks) if i == 0 or p - picks[i - 1] >= 4][:4]
    scale = f.torso / float(np.median(np.linalg.norm((seg[:, 11] + seg[:, 12]) / 2 - hips, axis=1)))
    rows, x0 = [], None
    for p in picks:
        rel = (seg[p] - hips[p]) @ R.T * scale
        row, x0 = f.fit({body: rel[i] for body, i, _ in PAIRS}, x0)
        rows.append(f.exaggerate(row, 1.0 + 0.45 * w))
    idx = [int(round(p / max(L, 1) * (frames - 1))) for p in picks]
    return {"spec": spec, "constraints_rows": np.stack(rows), "frame_indices": idx, "cfg": cfg, "fit": "on"}


def _title(name: str) -> str:
    words = re.sub(r"[^A-Za-z0-9' ]+", " ", name).split()[:5]
    return " ".join(w.capitalize() for w in words) or "Nameless Spell"
