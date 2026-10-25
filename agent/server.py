"""Talks to the game server (CLAUDE.md "Server endpoints"). Standard library only.

Endpoints used: GET /library/stats, POST /generate, GET /job/{id}, and GET /library/moves (NOT in CLAUDE.md
yet: the agent needs every existing name, alias, kimodo_prompt and motion_id to drop duplicates and reuse
motions; without it, it falls back to --library-file or to its own history).
"""
from __future__ import annotations

import itertools
import json
import random
import time
import urllib.error
import urllib.request
from typing import Any

MOVE_TYPES = ["physical", "fire", "ice", "lightning", "shadow"]


class ServerError(Exception):
    def __init__(self, msg: str, status: int | None = None):
        super().__init__(msg)
        self.status = status


class Server:
    def __init__(self, base: str, timeout: float = 15.0):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def _req(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise ServerError(f"{method} {path} -> {e.code} {detail}", e.code) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            raise ServerError(f"{method} {path} failed: {e}") from None

    def stats(self) -> dict[str, Any]:
        return normalize_stats(self._req("GET", "/library/stats"))

    def moves(self) -> list[dict[str, Any]] | None:
        """Every library move, or None if the server doesn't have the endpoint."""
        try:
            r = self._req("GET", "/library/moves")
        except ServerError as e:
            if e.status in (404, 405, 501):
                return None
            raise
        return r if isinstance(r, list) else (r or {}).get("moves")

    def generate(self, spec: dict[str, Any]) -> str:
        r = self._req("POST", "/generate", spec)
        job = (r or {}).get("job")
        if not job:
            raise ServerError(f"POST /generate returned no job: {r}", -1)  # -1: permanent, don't retry
        return str(job)

    def job(self, job_id: str) -> dict[str, Any]:
        return self._req("GET", f"/job/{job_id}")


def normalize_stats(raw: Any) -> dict[str, Any]:
    """The stats shape isn't in a contract yet; accept a few spellings."""
    r = raw if isinstance(raw, dict) else {}
    by_type = next((r[k] for k in ("by_type", "per_type", "types", "type") if isinstance(r.get(k), dict)), {})
    by_source = next((r[k] for k in ("by_source", "per_source", "sources", "source") if isinstance(r.get(k), dict)), {})
    total = r.get("total") or r.get("total_moves") or sum(v for v in by_source.values() if isinstance(v, (int, float)))
    return {"total": int(total or 0), "by_type": by_type, "by_source": by_source}


def thin_types(stats: dict[str, Any], k: int = 2) -> list[tuple[str, int]]:
    """The k move types with the fewest moves (ties broken by CLAUDE.md order)."""
    counts = [(t, int(stats.get("by_type", {}).get(t, 0) or 0)) for t in MOVE_TYPES]
    return sorted(counts, key=lambda tc: tc[1])[:k]


class FakeServer:
    """In-process stand-in for --offline runs: jobs finish after ~1 s, some get rejected like the real checks."""

    CHECKS = ["barely_moved", "root_drift", "below_floor", "joint_limits", "nan_frames"]

    def __init__(self, reject_rate: float = 0.15, seed: int = 7):
        self.rng = random.Random(seed)
        self.reject_rate = reject_rate
        self.library: list[dict[str, Any]] = []
        self.jobs: dict[str, dict[str, Any]] = {}
        self.ids = itertools.count(1)

    def stats(self) -> dict[str, Any]:
        by_type = {t: 0 for t in MOVE_TYPES}
        by_source: dict[str, int] = {}
        for m in self.library:
            by_type[m["type"]] += 1
            by_source[m["source"]] = by_source.get(m["source"], 0) + 1
        return {"total": len(self.library), "by_type": by_type, "by_source": by_source}

    def moves(self) -> list[dict[str, Any]]:
        return list(self.library)

    def generate(self, spec: dict[str, Any]) -> str:
        n = next(self.ids)
        job = f"job_{n:05d}"
        reuse = bool(spec.get("motion_id"))
        self.jobs[job] = {"spec": dict(spec), "ready": time.time() + (0.05 if reuse else self.rng.uniform(0.3, 1.2)), "n": n, "reuse": reuse}
        return job

    def job(self, job_id: str) -> dict[str, Any]:
        j = self.jobs.get(job_id)
        if j is None:
            raise ServerError(f"GET /job/{job_id} -> 404", 404)
        if time.time() < j["ready"]:
            return {"status": "running"}
        if "result" not in j:
            if not j["reuse"] and self.rng.random() < self.reject_rate:
                j["result"] = {"status": "rejected", "check": self.rng.choice(self.CHECKS)}
            else:
                move = dict(j["spec"], id=f"mv_{j['n']:04d}", motion_id=j["spec"].get("motion_id") or f"mo_{j['n']:04d}",
                            hit_frame=18, stability=round(self.rng.uniform(0.5, 1), 2), originality=round(self.rng.uniform(0.2, 0.9), 2))
                self.library.append(move)
                j["result"] = {"status": "done", "move": move}
        return j["result"]
