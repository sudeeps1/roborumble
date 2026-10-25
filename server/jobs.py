"""The GPU job queue: one worker thread, live and Forge jobs before overnight jobs, overnight jobs batched.

A job ends "done" (with the new move) or "rejected" (with the failed check). /job never reports any
other status than running, done or rejected.
"""
from __future__ import annotations

import itertools
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from . import config
from .engine import Generated, Request
from .library import Library
from .matcher import Matcher
from .motion import hit_frame, quality_check, stability_guess

LIVE, AGENT = 0, 1


@dataclass
class Job:
    id: str
    spec: dict[str, Any]
    priority: int
    frames: int
    constraints: list[dict[str, Any]] | None = None
    cfg_weight: tuple[float, float] | None = None
    status: str = "running"
    move: dict[str, Any] | None = None
    check: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    on_done: Callable[["Job"], None] | None = None
    preview: Generated | None = None  # Forge keeps the clip until Keep

    def public(self) -> dict[str, Any]:
        if self.status == "done":
            return {"status": "done", "move": self.move}
        if self.status == "rejected":
            return {"status": "rejected", "check": self.check}
        return {"status": "running"}


class JobQueue:
    def __init__(self, engine, library: Library, matcher: Matcher, limits: dict[int, tuple[float, float]]):
        self.engine = engine
        self.library = library
        self.matcher = matcher
        self.limits = limits
        self.jobs: dict[str, Job] = {}
        self.pending: list[tuple[int, int, Job]] = []
        self.cv = threading.Condition()
        self.seq = itertools.count()
        self.ids = itertools.count(1)
        self.counts = {"done": 0, "rejected": 0, "reused": 0}
        threading.Thread(target=self._worker, daemon=True, name="gpu-worker").start()

    # ---------- submitting ----------
    def new_id(self) -> str:
        return f"job_{int(time.time())}_{next(self.ids)}"

    def reserve(self, priority: int = LIVE) -> Job:
        """A job id that /job already answers ("running") before its spec exists, e.g. while Claude writes
        a wildcard spec. Finish with start()."""
        job = Job(id=self.new_id(), spec={}, priority=priority, frames=0)
        self.jobs[job.id] = job
        return job

    def submit(self, spec: dict[str, Any], priority: int = AGENT, on_done=None,
               constraints=None, cfg_weight=None, keep: bool = True) -> Job:
        return self.start(self.reserve(priority), spec, on_done, constraints, cfg_weight, keep)

    def start(self, job: Job, spec: dict[str, Any], on_done=None, constraints=None, cfg_weight=None,
              keep: bool = True) -> Job:
        seconds = max(float(spec.get("duration") or 1.2), config.MIN_GEN_SECONDS)
        job.spec, job.frames = spec, max(6, int(seconds * config.FPS))
        job.constraints, job.cfg_weight, job.on_done = constraints, cfg_weight, on_done
        job.spec["_keep"] = keep
        reuse = None if spec.get("_motion_only") else spec.get("motion_id") or (
            None if constraints else self.library.motion_for_prompt(spec.get("kimodo_prompt", "")))
        if reuse:
            self._reuse(job, reuse)
            return job
        with self.cv:
            self.pending.append((job.priority, next(self.seq), job))
            self.cv.notify()
        return job

    def queue_length(self) -> int:
        with self.cv:
            return len(self.pending)

    # ---------- the worker ----------
    def _take(self) -> list[Job]:
        with self.cv:
            while not self.pending:
                self.cv.wait()
            self.pending.sort(key=lambda t: (t[0], t[1]))
            first = self.pending.pop(0)[2]
            batch = [first]
            if first.priority == AGENT and not first.constraints:
                rest = []
                for t in self.pending:
                    j = t[2]
                    if len(batch) < config.BATCH_SIZE and j.priority == AGENT and not j.constraints and j.frames == first.frames:
                        batch.append(j)
                    else:
                        rest.append(t)
                self.pending = rest
            return batch

    def _worker(self) -> None:
        while True:
            batch = self._take()
            steps = config.LIVE_DIFFUSION_STEPS if batch[0].priority == LIVE else config.DIFFUSION_STEPS
            try:
                gens = self.engine.generate(
                    [Request(j.spec["kimodo_prompt"], j.frames, j.constraints, j.cfg_weight) for j in batch], steps)
            except Exception as e:
                traceback.print_exc()
                for j in batch:
                    self._reject(j, f"error: {type(e).__name__}: {str(e)[:160]}")
                continue
            for j, g in zip(batch, gens):
                try:
                    self._finish(j, g)
                except Exception as e:
                    traceback.print_exc()
                    self._reject(j, f"error: {type(e).__name__}: {str(e)[:160]}")

    # ---------- outcomes ----------
    def _finish(self, job: Job, g: Generated) -> None:
        if job.spec.get("_motion_only"):  # the idle stance: a motion, not a move, and it's supposed to be still
            self.library.add_motion(g.qpos, job.spec["_motion_only"])
            job.move = None
            self._done(job)
            return
        bad = quality_check(g, self.limits)
        if bad:
            self._reject(job, bad)
            return
        spec = job.spec
        originality = spec.get("originality")
        if originality is None:
            originality = self.library.originality(g.qpos)
        fields = dict(
            hit_frame=hit_frame(g, spec.get("hit_joint", "r_hand")),
            originality=originality,
            stability=spec.get("stability") if spec.get("stability") is not None else stability_guess(g.qpos),
            duration=round(g.qpos.shape[0] / config.FPS, 2),
        )
        if not spec.get("_keep", True):  # Forge preview: nothing saved until the player taps Keep
            job.preview = g
            job.move = dict(spec, **fields, id=None, motion_id=None, uses=0, signature=False)
            job.move.pop("_keep", None)
            self._done(job)
            return
        motion_id = self.library.add_motion(g.qpos)
        self._save(job, motion_id, fields)

    def _reuse(self, job: Job, motion_id: str) -> None:
        path = self.library.motion_path(motion_id)
        if not path:
            self._reject(job, "unknown_motion_id")
            return
        import json

        q = np.asarray(json.loads(path.read_text())["qpos"], dtype=float)
        g = Generated(qpos=q, joints=None)
        spec = job.spec
        fields = dict(
            hit_frame=hit_frame(g, spec.get("hit_joint", "r_hand")),
            originality=spec.get("originality") if spec.get("originality") is not None else self.library.originality(q, exclude=motion_id),
            stability=spec.get("stability") if spec.get("stability") is not None else stability_guess(q),
            duration=round(q.shape[0] / config.FPS, 2),
        )
        self.counts["reused"] += 1
        self._save(job, motion_id, fields)

    def _save(self, job: Job, motion_id: str, fields: dict[str, Any]) -> None:
        spec = {k: v for k, v in job.spec.items() if not k.startswith("_")}
        move = self.library.add_move(dict(spec, **fields, motion_id=motion_id))
        self.matcher.add(move["id"], move["name"], move.get("aliases") or [])
        job.move = move
        self._done(job)

    def _done(self, job: Job) -> None:
        job.status = "done"
        job.finished = time.time()
        self.counts["done"] += 1
        self._notify(job)

    def _reject(self, job: Job, check: str) -> None:
        job.status = "rejected"
        job.check = check
        job.finished = time.time()
        self.counts["rejected"] += 1
        print(f"job {job.id} rejected: {check} ({job.spec.get('name')!r})")
        self._notify(job)

    @staticmethod
    def _notify(job: Job) -> None:
        if job.on_done:
            try:
                job.on_done(job)
            except Exception:
                traceback.print_exc()
