"""Persistent state for the Library Builder: survives restarts, so a crash or Ctrl-C resumes cleanly.

Everything lives in one JSON file (agent/state.json), written atomically after every change.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent


def norm(text: str) -> str:
    """Normalize a name or alias for duplicate checks: lowercase, letters/digits/spaces only."""
    text = text.lower().replace("'", "").replace("’", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def hour_key(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%d %H:00", time.localtime(ts if ts is not None else time.time()))


@dataclass
class State:
    path: Path
    theme_index: int = 0
    batch_counter: int = 0
    claude_calls: int = 0  # successful Claude calls so far (what --batches counts)
    theme_names: dict[str, list[str]] = field(default_factory=dict)  # names the agent already got kept, per theme
    names: set[str] = field(default_factory=set)       # normalized names + aliases the agent has added
    prompts: list[dict[str, str]] = field(default_factory=list)  # [{prompt, motion_id}] for motion reuse
    queue: list[dict[str, Any]] = field(default_factory=list)    # specs ready to POST /generate
    pending: list[dict[str, Any]] = field(default_factory=list)  # posted, waiting on GET /job
    hours: dict[str, dict[str, Any]] = field(default_factory=dict)  # per-hour counters, flushed to log.txt
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    # ---------- persistence ----------
    @classmethod
    def load(cls, path: Path) -> "State":
        st = cls(path=path)
        if path.exists():
            raw = json.loads(path.read_text())
            st.theme_index = raw.get("theme_index", 0)
            st.batch_counter = raw.get("batch_counter", 0)
            st.claude_calls = raw.get("claude_calls", 0)
            st.theme_names = raw.get("theme_names", {})
            st.names = set(raw.get("names", []))
            st.prompts = raw.get("prompts", [])
            st.queue = raw.get("queue", [])
            st.pending = raw.get("pending", [])
            st.hours = raw.get("hours", {})
        return st

    def save(self) -> None:
        with self.lock:
            data = {
                "theme_index": self.theme_index,
                "batch_counter": self.batch_counter,
                "claude_calls": self.claude_calls,
                "theme_names": self.theme_names,
                "names": sorted(self.names),
                "prompts": self.prompts,
                "queue": self.queue,
                "pending": self.pending,
                "hours": self.hours,
            }
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1))
            os.replace(tmp, self.path)

    # ---------- hourly counters (agent/log.txt) ----------
    def count(self, key: str, n: int = 1, reason: str | None = None) -> None:
        with self.lock:
            h = self.hours.setdefault(hour_key(), {"kept": 0, "rejected": 0, "reused": 0, "dupes": 0, "invalid": 0, "calls": 0, "reasons": {}})
            h[key] = h.get(key, 0) + n
            if reason:
                h["reasons"][reason] = h["reasons"].get(reason, 0) + n

    def flush_hours(self, log_path: Path, include_current: bool = False) -> None:
        """Append finished hours to log.txt (and the current one, marked partial, on exit)."""
        with self.lock:
            now = hour_key()
            lines = []
            for key in sorted(self.hours):
                if key == now and not include_current:
                    continue
                h = self.hours.pop(key)
                reasons = ", ".join(f"{k} {v}" for k, v in sorted(h["reasons"].items(), key=lambda kv: -kv[1])[:6])
                partial = " (partial)" if key == now else ""
                lines.append(
                    f"{key}{partial}  kept {h['kept']}  rejected {h['rejected']}  reused motions {h['reused']}  "
                    f"dropped dupes {h['dupes']}  dropped invalid {h['invalid']}  claude calls {h['calls']}"
                    + (f"  | {reasons}" if reasons else "")
                )
            if lines:
                with log_path.open("a") as f:
                    f.write("\n".join(lines) + "\n")


DIRECTION = re.compile(r"\b(left|right|forwards?|backwards?|back|up(?:ward)?|down(?:ward)?|both|sideways|behind|overhead)\b", re.I)


def directions(prompt: str) -> frozenset[str]:
    """Side and direction words. Mirrored prompts ('left hook' vs 'right hook') embed almost identically,
    so motion reuse also requires these to match (review finding 7)."""
    return frozenset(w.lower().rstrip("s").replace("ward", "") for w in DIRECTION.findall(prompt))


def same_directions(a: str, b: str) -> bool:
    return directions(a) == directions(b)


class PromptIndex:
    """Finds near-duplicate kimodo_prompts (embedding cosine similarity) so specs can share a motion.

    Uses all-MiniLM-L6-v2 (the same model the server's Voice Matcher uses). Falls back to a strict
    lexical comparison if sentence-transformers isn't installed, so the loop never stops over it.
    """

    MODEL = "sentence-transformers/all-MiniLM-L6-v2"

    def __init__(self, use_embeddings: bool = True):
        self.items: list[tuple[str, str]] = []  # (prompt, motion_id)
        self.vecs = None
        self.model = None
        self.lexical = not use_embeddings
        if use_embeddings:
            try:
                from sentence_transformers import SentenceTransformer  # heavy import, keep it lazy

                self.model = SentenceTransformer(self.MODEL)
            except Exception as e:  # missing package, no network for the first download, ...
                print(f"[warn] embeddings unavailable ({e.__class__.__name__}: {e}); using lexical near-duplicate check")
                self.lexical = True

    def _embed(self, texts: list[str]):
        return self.model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, batch_size=64)

    def add_many(self, pairs: list[tuple[str, str]]) -> None:
        pairs = [(p, m) for p, m in pairs if p and m]
        if not pairs:
            return
        self.items.extend(pairs)
        if not self.lexical:
            import numpy as np

            v = self._embed([p for p, _ in pairs])
            self.vecs = v if self.vecs is None else np.vstack([self.vecs, v])

    def nearest_many(self, prompts: list[str]) -> list[tuple[float, str | None]]:
        """For each prompt: (similarity, motion_id) of the closest known prompt, or (0, None)."""
        if not self.items or not prompts:
            return [(0.0, None)] * len(prompts)
        if self.lexical:
            from difflib import SequenceMatcher

            out = []
            for q in prompts:
                scored = [(SequenceMatcher(None, norm(q), norm(p)).ratio(), m) for p, m in self.items if same_directions(q, p)]
                out.append(max(scored, key=lambda x: x[0]) if scored else (0.0, None))
            return out
        sims = self._embed(prompts) @ self.vecs.T
        out = []
        for q, row in zip(prompts, sims):
            best = (0.0, None)
            for k in row.argsort()[::-1][:25]:  # closest first; skip mirrored ones
                if same_directions(q, self.items[int(k)][0]):
                    best = (float(row[k]), self.items[int(k)][1])
                    break
            out.append(best)
        return out

    def pairwise(self, prompts: list[str]) -> list[list[float]]:
        """Similarity matrix between prompts (for near-duplicates inside one batch)."""
        if not prompts:
            return []
        if self.lexical:
            from difflib import SequenceMatcher

            n = [norm(p) for p in prompts]
            return [[SequenceMatcher(None, a, b).ratio() for b in n] for a in n]
        v = self._embed(prompts)
        return (v @ v.T).tolist()
