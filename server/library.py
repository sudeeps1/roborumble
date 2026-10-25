"""The move library on disk: library/moves.jsonl (one move per line, append-only),
library/motions/{id}.json, and library/uses.json (play counts, rewritten every few seconds).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import config
from .g1 import JOINT_NAMES
from .motion import features

MOVE_TYPES = ["physical", "fire", "ice", "lightning", "shadow"]
STORED = ["id", "name", "aliases", "type", "kind", "effect", "kimodo_prompt", "hit_joint", "duration", "power",
          "stability", "originality", "motion_id", "hit_frame", "source", "creator", "created_at"]


def norm_prompt(p: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", re.sub(r"\s+", " ", p.lower())).strip()


class Library:
    def __init__(self, root: Path = config.LIBRARY_DIR):
        self.root = root
        self.motions_dir = root / "motions"
        self.motions_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.moves: dict[str, dict[str, Any]] = {}
        self.uses: dict[str, int] = {}
        self.by_prompt: dict[str, str] = {}         # normalized kimodo_prompt -> motion_id
        self.feat_ids: list[str] = []                # motion ids with features, for originality
        self.feats: list[np.ndarray] = []
        self._uses_dirty = False
        self._next_move = 1
        self._next_motion = 1
        self._load()
        threading.Thread(target=self._flush_loop, daemon=True).start()

    # ---------- loading ----------
    def _load(self) -> None:
        path = self.root / "moves.jsonl"
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a half-written last line after a crash
                if isinstance(m, dict) and m.get("id"):
                    self.moves[m["id"]] = m
        up = self.root / "uses.json"
        if up.exists():
            try:
                self.uses = {k: int(v) for k, v in json.loads(up.read_text()).items()}
            except (json.JSONDecodeError, ValueError):
                pass
        for m in self.moves.values():
            self._next_move = max(self._next_move, _num(m["id"]) + 1)
            if m.get("kimodo_prompt") and m.get("motion_id"):
                self.by_prompt.setdefault(norm_prompt(m["kimodo_prompt"]), m["motion_id"])
        for f in self.motions_dir.glob("mo_[0-9]*.json"):
            self._next_motion = max(self._next_motion, _num(f.stem) + 1)
            try:
                q = np.asarray(json.loads(f.read_text())["qpos"], dtype=float)
                self.feat_ids.append(f.stem)
                self.feats.append(features(q))
            except Exception:
                pass

    # ---------- motions ----------
    def add_motion(self, qpos: np.ndarray, motion_id: str | None = None) -> str:
        with self.lock:
            if motion_id is None:
                motion_id = f"mo_{self._next_motion:05d}"
                self._next_motion += 1
            body = {"id": motion_id, "fps": config.FPS, "joint_names": JOINT_NAMES,
                    "qpos": np.round(qpos, 5).tolist()}
            tmp = self.motions_dir / f".{motion_id}.tmp"
            tmp.write_text(json.dumps(body, separators=(",", ":")))
            os.replace(tmp, self.motions_dir / f"{motion_id}.json")
            if not motion_id.startswith(("mo_idle", "clip_")):
                self.feat_ids.append(motion_id)
                self.feats.append(features(qpos))
            return motion_id

    def motion_path(self, motion_id: str) -> Path | None:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", motion_id):
            return None
        p = self.motions_dir / f"{motion_id}.json"
        return p if p.exists() else None

    def has_motion(self, motion_id: str) -> bool:
        return self.motion_path(motion_id) is not None

    def originality(self, qpos: np.ndarray, exclude: str | None = None) -> float:
        """1 minus the highest cosine similarity to any other motion in the library."""
        with self.lock:
            if not self.feats:
                return 1.0
            f = features(qpos)
            mat = np.stack(self.feats)
            sims = mat @ f
            if exclude in self.feat_ids:
                sims[self.feat_ids.index(exclude)] = -1
            best = float(sims.max()) if sims.size else 0.0
        return round(float(np.clip(1.0 - best, 0.0, 1.0)), 2)

    # ---------- moves ----------
    def add_move(self, move: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            move = {k: move.get(k) for k in STORED}
            move["id"] = f"mv_{self._next_move:05d}"
            self._next_move += 1
            move["created_at"] = int(time.time())
            self.moves[move["id"]] = move
            if move.get("kimodo_prompt"):
                self.by_prompt.setdefault(norm_prompt(move["kimodo_prompt"]), move["motion_id"])
            with open(self.root / "moves.jsonl", "a") as f:
                f.write(json.dumps(move) + "\n")
                f.flush()
                os.fsync(f.fileno())
            return self.public(move)

    def public(self, move: dict[str, Any]) -> dict[str, Any]:
        out = dict(move)
        out["uses"] = self.uses.get(move["id"], 0)
        out["signature"] = False
        return out

    def get(self, move_id: str) -> dict[str, Any] | None:
        m = self.moves.get(move_id)
        return self.public(m) if m else None

    def motion_for_prompt(self, prompt: str) -> str | None:
        mid = self.by_prompt.get(norm_prompt(prompt))
        return mid if mid and self.has_motion(mid) else None

    def bump(self, move_id: str) -> None:
        with self.lock:
            self.uses[move_id] = self.uses.get(move_id, 0) + 1
            self._uses_dirty = True

    def all(self) -> list[dict[str, Any]]:
        with self.lock:
            return [self.public(m) for m in self.moves.values()]

    def stats(self) -> dict[str, Any]:
        with self.lock:
            by_type = {t: 0 for t in MOVE_TYPES}
            by_source: dict[str, int] = {"agent": 0, "forge": 0, "live": 0}
            for m in self.moves.values():
                by_type[m.get("type", "physical")] = by_type.get(m.get("type", "physical"), 0) + 1
                by_source[m.get("source") or "agent"] = by_source.get(m.get("source") or "agent", 0) + 1
            return {"total": len(self.moves), "by_type": by_type, "by_source": by_source}

    def leaderboard(self, n: int = 10) -> list[dict[str, Any]]:
        with self.lock:
            made = [m for m in self.moves.values() if m.get("creator") and m.get("source") in ("forge", "live")]
            made.sort(key=lambda m: self.uses.get(m["id"], 0), reverse=True)
            return [{"id": m["id"], "name": m["name"], "creator": m["creator"], "uses": self.uses.get(m["id"], 0),
                     "type": m.get("type")} for m in made[:n]]

    def _flush_loop(self) -> None:
        while True:
            time.sleep(3)
            with self.lock:
                if not self._uses_dirty:
                    continue
                data = json.dumps(self.uses)
                self._uses_dirty = False
            tmp = self.root / ".uses.tmp"
            tmp.write_text(data)
            os.replace(tmp, self.root / "uses.json")


def _num(s: str) -> int:
    m = re.search(r"(\d+)$", s)
    return int(m.group(1)) if m else 0
