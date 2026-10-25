"""Every HTTP call the Library Builder makes to the game server (server/app.py, contract/api.md).
Standard library only (urllib). Routes are bare; a --server URL ending in /api works too, because
the server serves every route under both.

  GET  /health          -> {ok, engine, model, queue, jobs, library, ...}, logged once at start
  GET  /library/stats   -> {total, by_type: {physical, fire, ice, lightning, shadow}, by_source: {agent, forge, live}}
  GET  /library/moves   -> [{id, name, aliases, kimodo_prompt, motion_id, type, kind, source, creator}]
  POST /generate        a move spec, plus motion_id to reuse that motion and skip Kimodo -> {"job": id};
                        400 for an unknown motion_id or a spec with no name and no kimodo_prompt
  GET  /job/{id}        -> {"status": "running"} | {"status": "done", "move": Move}
                         | {"status": "rejected", "check": name}; 404 for an unknown id (the server restarted)
"""
from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.parse
import urllib.request

# The server's quality checks (contract/api.md "POST /generate rules"), in the words the log uses.
# A check can also be "error: <ExceptionType>: <message>" when Kimodo or the server threw.
CHECKS = {
    "nan_frames": "NaN or missing frames",
    "barely_moved": "the body barely moved",
    "root_drift": "the root drifted more than 1.5 m",
    "below_floor": "a body part went below the floor",
    "joint_limits": "a joint went more than 12 deg past its limit",
    "unknown_motion_id": "the reused motion is gone",
}


def short(x, n=160):
    s = x if isinstance(x, str) else json.dumps(x, default=str)
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 3] + "..."


def check_key(check):
    """The bucket a rejection is counted under in the hourly summary: the check's name, or
    'error: <ExceptionType>' (the message varies, so it is left out)."""
    check = (check or "").strip()
    if check.startswith("error"):
        m = re.match(r"error:\s*([A-Za-z_][\w.]*)", check)
        return f"error: {m.group(1)}" if m else "error"
    return check or "rejected"


def check_reason(check):
    check = (check or "").strip()
    if check.startswith("error"):
        return "the generation threw " + (check[len("error:"):].strip() or "an error")
    return CHECKS.get(check, "rejected")


class ServerDown(Exception):
    """The server could not be reached or sent garbage (refused, timeout, DNS, reset, not JSON)."""


class ServerHTTPError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {short(body)}")


class GameServer:
    def __init__(self, base_url, timeout=10.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        host = urllib.parse.urlparse(self.base).hostname or ""
        # Never send localhost traffic through an HTTP proxy from the environment.
        handlers = [urllib.request.ProxyHandler({})] if host in ("localhost", "127.0.0.1", "::1") else []
        self.opener = urllib.request.build_opener(*handlers)

    def _call(self, method, path, body=None, timeout=None):
        # RunPod's HTTPS proxy answers 403 to urllib's default "Python-urllib/3.x" user agent.
        headers = {"Accept": "application/json", "User-Agent": "InfiniteFighterAgent/1.0"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            try:
                raw = e.read()
            except Exception:
                raw = b""
            raise ServerHTTPError(e.code, _parse(raw)) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
            raise ServerDown(f"{method} {self.base}{path}: {getattr(e, 'reason', None) or e}") from None
        if not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ServerDown(f"{method} {self.base}{path}: response is not JSON: {raw[:120]!r}") from None

    def health(self):
        return self._call("GET", "/health")

    def stats(self):
        return normalize_stats(self._call("GET", "/library/stats"))

    def moves(self):
        """Every move in the library. It grows all night, so this call gets a longer timeout."""
        data = self._call("GET", "/library/moves", timeout=max(self.timeout, 60.0))
        if not isinstance(data, list):
            raise ServerDown(f"GET {self.base}/library/moves: expected a JSON list, got {short(data, 80)}")
        return [m for m in data if isinstance(m, dict)]

    def generate(self, spec):
        data = self._call("POST", "/generate", spec)
        job = data.get("job") if isinstance(data, dict) else None
        if not job:
            raise ServerHTTPError(200, f"no job id in /generate response: {short(data)}")
        return str(job)

    def job(self, job_id):
        try:
            data = self._call("GET", "/job/" + urllib.parse.quote(str(job_id), safe=""))
        except ServerHTTPError as e:
            if e.status != 404:
                raise
            # A 404 means the server restarted and forgot the job, unless the server itself is gone
            # (a proxy in front of a stopped pod can answer 404 too): then it is just down.
            try:
                h = self.health()
            except (ServerDown, ServerHTTPError) as e2:
                raise ServerDown(f"GET /job/{job_id} -> 404, and /health failed too ({e2})") from None
            if not (isinstance(h, dict) and h.get("ok")):
                raise ServerDown(f"GET /job/{job_id} -> 404, and /health answered {short(h, 80)}")
            return {"status": "unknown"}
        return normalize_job(data)


def _parse(raw):
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace")


def normalize_job(data):
    """running | done (+ move) | rejected (+ check, reason). contract/api.md: /job never reports any
    other status; anything else counts as still running, and the 15 minute timeout catches it."""
    if not isinstance(data, dict):
        return {"status": "running"}
    status = str(data.get("status") or "").strip().lower()
    if status == "done":
        move = data.get("move")
        return {"status": "done", "move": move if isinstance(move, dict) else {}}
    if status == "rejected":
        check = short(str(data.get("check") or ""), 200)
        return {"status": "rejected", "check": check, "reason": check_reason(check)}
    return {"status": "running"}


def normalize_stats(data):
    """{total, by_type, by_source} with int counts (contract/api.md)."""
    out = {"total": None, "by_type": {}, "by_source": {}}
    if not isinstance(data, dict):
        return out
    for k in ("by_type", "by_source"):
        v = data.get(k)
        if isinstance(v, dict):
            out[k] = {str(t): int(n) for t, n in v.items() if isinstance(n, (int, float)) and not isinstance(n, bool)}
    total = data.get("total")
    if isinstance(total, (int, float)) and not isinstance(total, bool):
        out["total"] = int(total)
    elif out["by_type"]:
        out["total"] = sum(out["by_type"].values())
    return out
