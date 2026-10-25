"""Motion generators. KimodoEngine runs the real model on the GPU box; MockEngine fakes plausible G1
motions anywhere, so the client, agent and phones can be built before Kimodo works.

Only the job worker thread calls generate(), one call at a time.
"""
from __future__ import annotations

import hashlib
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import config
from .g1 import NQ, PELVIS_Z


@dataclass
class Generated:
    qpos: np.ndarray            # (T, 36) MuJoCo qpos rows, Z up
    joints: np.ndarray | None   # (T, 34, 3) Kimodo posed_joints, Y up; None from the mock


@dataclass
class Request:
    prompt: str
    frames: int
    constraints: list[dict[str, Any]] | None = None  # Kimodo constraint dicts (Forge)
    cfg_weight: tuple[float, float] | None = None     # (text, constraint)


class MockEngine:
    name = "mock"

    def __init__(self) -> None:
        self.last_ms = 0.0

    def pose_constraints(self, rows: np.ndarray, frame_indices: list[int]) -> list[dict[str, Any]]:
        return [{"type": "fullbody", "frame_indices": list(frame_indices), "mock": True}]

    def generate(self, reqs: list[Request], steps: int) -> list[Generated]:
        t0 = time.time()
        out = [self._one(r) for r in reqs]
        time.sleep(0.4 + 0.1 * len(reqs))  # feel like a GPU, a little
        self.last_ms = (time.time() - t0) * 1000
        return out

    @staticmethod
    def _one(r: Request) -> Generated:
        h = int(hashlib.sha1(r.prompt.encode()).hexdigest(), 16)
        rng = np.random.default_rng(h % (2**32))
        T = r.frames
        q = np.zeros((T, NQ))
        q[:, 2] = PELVIS_Z
        q[:, 3] = 1.0  # identity quaternion, w first
        kick = any(w in r.prompt.lower() for w in ("kick", "knee", "stomp", "leg"))
        amp = rng.uniform(0.6, 1.4)
        for t in range(T):
            s = math.sin(math.pi * t / max(T - 1, 1)) ** 2  # 0 -> 1 -> 0, fastest a quarter of the way in
            q[t, 0] = 0.15 * s  # lean in and back
            q[t, 7 + 3] = q[t, 7 + 9] = 0.25          # soft knees
            q[t, 7 + 4] = q[t, 7 + 10] = -0.15
            if kick:
                q[t, 7 + 6] = -1.2 * amp * s          # right hip pitch
                q[t, 7 + 9] = 0.25 + 0.6 * s           # right knee
            else:
                q[t, 7 + 22] = -1.3 * amp * s          # right shoulder pitch
                q[t, 7 + 25] = 1.0 - 0.9 * s           # right elbow extends
            q[t, 7 + 15] = -0.4                        # left guard up
            q[t, 7 + 18] = 1.2
            q[t, 7 + 12] = 0.3 * amp * s * (1 if h % 2 else -1)  # waist yaw
        return Generated(qpos=q, joints=None)


class KimodoEngine:
    name = "kimodo"

    def __init__(self) -> None:
        import torch
        from kimodo.exports.mujoco import MujocoQposConverter
        from kimodo.model.load_model import load_model

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        t0 = time.time()
        self.model = load_model(config.KIMODO_MODEL, device=self.device)
        self.converter = MujocoQposConverter(self.model.skeleton)
        self.load_ms = (time.time() - t0) * 1000
        self.last_ms = 0.0

    def pose_constraints(self, rows: np.ndarray, frame_indices: list[int]) -> list[dict[str, Any]]:
        """G1 qpos keyframes (K, 36) -> one Kimodo `fullbody` constraint dict (Kimodo frame, axis-angle)."""
        from kimodo.geometry import matrix_to_axis_angle

        # The converter smooths the root over time, which fails on a handful of isolated frames, so convert a
        # dense clip interpolated between the keyframes and read the keyframes back out of it.
        rows = np.asarray(rows, dtype=np.float64).copy()
        for i in range(1, len(rows)):  # same quaternion hemisphere before interpolating
            if rows[i, 3:7] @ rows[i - 1, 3:7] < 0:
                rows[i, 3:7] *= -1
        idx = np.asarray(frame_indices)
        n = max(int(idx.max()) + 1, 36)
        dense = np.stack([np.interp(np.arange(n), idx, rows[:, c]) for c in range(rows.shape[1])], axis=1)
        dense[:, 3:7] /= np.linalg.norm(dense[:, 3:7], axis=1, keepdims=True)
        qpos = self.torch.tensor(dense.astype(np.float32), device=self.device)  # skeleton lives on the GPU
        md = self.converter.qpos_to_motion_dict(qpos, 30)
        rots, root = md["local_rot_mats"], md["root_positions"]
        if rots.dim() == 5:
            rots, root = rots[0], root[0]
        rots, root = rots[idx], root[idx]
        return [{"type": "fullbody", "frame_indices": [int(i) for i in frame_indices],
                 "local_joints_rot": matrix_to_axis_angle(rots).float().cpu().tolist(),
                 "root_positions": root.float().cpu().tolist()}]

    def generate(self, reqs: list[Request], steps: int) -> list[Generated]:
        if any(r.constraints for r in reqs):  # constrained clips go one at a time, the way kimodo_gen runs them
            out = []
            for r in reqs:
                out += self._generate([r], steps)
            return out
        return self._generate(reqs, steps)

    def _generate(self, reqs: list[Request], steps: int) -> list[Generated]:
        t0 = time.time()
        frames = [r.frames for r in reqs]
        cfg = next((list(r.cfg_weight) for r in reqs if r.cfg_weight), [2.0, 2.0])
        kwargs: dict[str, Any] = dict(
            prompts=[r.prompt for r in reqs],
            num_frames=frames[0] if len(set(frames)) == 1 else frames,
            num_denoising_steps=steps,
            multi_prompt=False,
            cfg_weight=cfg,
            post_processing=False,  # always off for G1 anyway
        )
        if reqs[0].constraints:
            # kimodo_gen's path: one prompt as a one-segment multi-prompt, a flat constraint list
            from kimodo.constraints import load_constraints_lst

            kwargs.update(multi_prompt=True, num_frames=[frames[0]], num_samples=1, cfg_type="separated",
                          constraint_lst=load_constraints_lst(reqs[0].constraints, self.model.skeleton, device=self.device))
        with self.torch.inference_mode():
            out = self.model(**kwargs)
            qpos = np.asarray(self.converter.dict_to_qpos(out, self.device))
        joints = out.get("posed_joints") if isinstance(out, dict) else None
        joints = None if joints is None else _np(joints)
        if qpos.ndim == 2:
            qpos = qpos[None]
        if joints is not None and joints.ndim == 3:
            joints = joints[None]
        self.last_ms = (time.time() - t0) * 1000
        return [
            Generated(qpos=qpos[i, : frames[i]], joints=None if joints is None else joints[i, : frames[i]])
            for i in range(len(reqs))
        ]


def _np(x: Any) -> np.ndarray:
    if hasattr(x, "detach"):
        x = x.detach().float().cpu().numpy()
    return np.asarray(x)


def make_engine():
    return KimodoEngine() if config.ENGINE == "kimodo" else MockEngine()
