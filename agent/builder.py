#!/usr/bin/env python3
"""Overnight Library Builder (CLAUDE.md "Overnight Library Builder (agent/)").

Loop: GET /library/stats to find thin types -> ask Claude for move specs for the next fairy-tale theme ->
validate -> drop specs whose name or aliases already exist -> reuse the motion of any near-duplicate
kimodo_prompt (similarity over 0.95) -> POST /generate -> poll jobs -> log kept/rejected per hour to log.txt.

Never crashes: errors are logged and retried with backoff. State (queued specs, in-flight jobs, counters)
is saved after every change, so a restart resumes where it stopped.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from server import FakeServer, Server, ServerError, thin_types
from specs import MODEL, THEMES, ClaudeFailure, FakeClaude, ask_claude, user_prompt, validate
from state import HERE, PromptIndex, State, norm, same_directions

REUSE_SIMILARITY = 0.95  # CLAUDE.md: near-duplicate kimodo_prompts share a motion
JOB_TIMEOUT = 600        # s: a job still running after this is re-posted once, then rejected
POLL_ERROR_LIMIT = 5     # HTTP errors polling one job before it counts as rejected
POLL_S = 0.25            # CLAUDE.md: poll jobs every 250 ms
SPEC_KEYS = ["name", "aliases", "type", "kind", "effect", "kimodo_prompt", "hit_joint", "duration", "power", "source", "creator", "uses", "motion_id"]


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Overnight Library Builder: Claude writes move specs, the server generates their motions.")
    p.add_argument("--batches", type=int, default=0, help="Claude calls to make, then finish their jobs and exit (default: run forever; 1 with --dry-run)")
    p.add_argument("--batch-size", type=int, default=50, help="move specs per Claude call (default 50)")
    p.add_argument("--server", default=os.environ.get("SERVER_URL", "http://localhost:8000"), help="game server base URL (default $SERVER_URL or http://localhost:8000)")
    p.add_argument("--theme", help="use only this theme instead of rotating (e.g. 'winter tales')")
    p.add_argument("--dry-run", action="store_true", help="ask Claude and check the specs but don't POST /generate; read batches/*.md")
    p.add_argument("--offline", action="store_true", help="fake Claude and the server, to test the loop without keys or a GPU")
    p.add_argument("--fake-claude", action="store_true", help="fake Claude but talk to the real server (test the server without Claude keys)")
    p.add_argument("--max-pending", type=int, default=6, help="jobs in flight at once (default 6)")
    p.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"], help="Claude effort (CLAUDE.md: high overnight)")
    p.add_argument("--library-file", help="library/moves.jsonl to read existing moves from if the server has no GET /library/moves")
    p.add_argument("--state", default=str(HERE / "state.json"), help="state file (default agent/state.json)")
    p.add_argument("--no-embeddings", action="store_true", help="skip sentence-transformers; use a strict text comparison for motion reuse")
    a = p.parse_args()
    if a.dry_run and a.batches == 0:
        a.batches = 1
    if a.theme and a.theme not in {t for t, _ in THEMES}:
        p.error(f"unknown theme {a.theme!r}; pick one of: " + ", ".join(sorted({t for t, _ in THEMES})))
    return a


class Review:
    """batches/batch_NNNN_<theme>.json + .md: every spec Claude wrote and what happened to it."""

    def __init__(self, folder: Path):
        self.folder = folder
        folder.mkdir(exist_ok=True)
        self.cache: dict[int, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def _path(self, batch: int, theme: str) -> Path:
        return self.folder / f"batch_{batch:04d}_{re.sub(r'[^a-z0-9]+', '_', theme.lower()).strip('_')}"

    def write(self, batch: int, theme: str, info: dict[str, Any], records: list[dict[str, Any]]) -> None:
        with self.lock:
            self.cache[batch] = {"batch": batch, "theme": theme, **info, "records": records}
            self._flush(batch)

    def update(self, batch: int, name: str, outcome: str, **extra: Any) -> None:
        with self.lock:
            doc = self.cache.get(batch)
            if doc is None:
                found = sorted(self.folder.glob(f"batch_{batch:04d}_*.json"))
                if not found:
                    return
                doc = self.cache[batch] = json.loads(found[0].read_text())
            for r in doc["records"]:
                if r.get("spec") and r["spec"]["name"] == name:
                    r["outcome"] = outcome
                    r.update(extra)
            self._flush(batch)

    def _flush(self, batch: int) -> None:
        doc = self.cache[batch]
        base = self._path(batch, doc["theme"])
        base.with_suffix(".json").write_text(json.dumps(doc, indent=1))
        lines = [f"# Batch {batch}: {doc['theme']}", "", f"{doc.get('when', '')} - {doc.get('model', '')} - {len(doc['records'])} specs", ""]
        lines += ["| # | outcome | name | type / kind / effect | power | hit | dur | kimodo_prompt | aliases |", "|---|---|---|---|---|---|---|---|---|"]
        for i, r in enumerate(doc["records"], 1):
            s = r.get("spec") or r.get("raw") or {}
            cell = lambda v: str(v).replace("|", "/")
            lines.append(f"| {i} | {cell(r.get('outcome', ''))} | {cell(s.get('name', ''))} | {s.get('type', '')} / {s.get('kind', '')} / {s.get('effect', '')} | "
                         f"{s.get('power', '')} | {s.get('hit_joint', '')} | {s.get('duration', '')} | {cell(s.get('kimodo_prompt', ''))} | {cell(', '.join(s.get('aliases', [])))} |")
        base.with_suffix(".md").write_text("\n".join(lines) + "\n")


class Builder:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.state = State.load(Path(args.state))
        self.log_path = HERE / "log.txt"
        self.review = Review(HERE / "batches")
        self.server: Server | FakeServer = FakeServer() if args.offline else Server(args.server)
        self.fake = FakeClaude() if args.offline or args.fake_claude else None
        self.claude = None
        if not self.fake:
            import anthropic  # credentials: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile

            self.claude = anthropic.Anthropic(max_retries=4)
        self.index = PromptIndex(use_embeddings=not (args.no_embeddings or args.offline))
        self.indexed: set[tuple[str, str]] = set()
        self.prompt_motion: dict[str, str] = {}   # kimodo_prompt -> motion_id, for in-batch near-duplicates waiting on a motion
        self.failed_prompts: set[str] = set()
        self.library_keys: set[str] = set()
        self.library_warned = False
        self.calls_this_run = 0
        self.producer_done = threading.Event()
        self.stop = threading.Event()
        self.server_down_until = 0.0
        self.last_server_warn = 0.0

    # ---------- startup ----------
    def startup(self) -> None:
        self.state.flush_hours(self.log_path)  # hours a previous run never flushed (e.g. killed)
        with self.state.lock:
            self._index_many([(p["prompt"], p["motion_id"]) for p in self.state.prompts])
        self.refresh_library()
        log(f"Library Builder ({'offline' if self.args.offline else self.args.server}, model {MODEL}, effort {self.args.effort}): "
            f"{len(self.state.queue)} queued, {len(self.state.pending)} in flight, {self.state.claude_calls} Claude calls so far")

    def refresh_library(self) -> None:
        moves = None
        try:
            moves = self.server.moves()
        except ServerError as e:
            log(f"[warn] couldn't list the library: {e}")
        if moves is None and self.args.library_file and Path(self.args.library_file).exists():
            moves = [json.loads(line) for line in Path(self.args.library_file).read_text().splitlines() if line.strip()]
        if moves is None:
            if not self.library_warned:
                log("[warn] no GET /library/moves and no --library-file: duplicate checks only cover moves this agent made")
                self.library_warned = True
            return
        keys: set[str] = set()
        pairs = []
        for m in moves:
            keys.add(norm(str(m.get("name", ""))))
            keys.update(norm(str(a)) for a in m.get("aliases") or [])
            if m.get("kimodo_prompt") and m.get("motion_id"):
                pairs.append((str(m["kimodo_prompt"]), str(m["motion_id"])))
        keys.discard("")
        with self.state.lock:
            self.library_keys = keys
            self._index_many(pairs)

    def _index_many(self, pairs: list[tuple[str, str]]) -> None:
        fresh = list(dict.fromkeys(p for p in pairs if p not in self.indexed))
        self.indexed.update(fresh)
        self.index.add_many(fresh)
        for prompt, motion in fresh:
            self.prompt_motion[prompt] = motion

    # ---------- producer: Claude -> checked specs -> queue ----------
    def producer(self) -> None:
        backoff = 5.0
        try:
            while not self.stop.is_set():
                if self.args.batches and self.calls_this_run >= self.args.batches:
                    break
                with self.state.lock:
                    backlog = len(self.state.queue) + len(self.state.pending)
                # Stay about one batch ahead so the GPU never waits on a Claude call.
                if backlog > max(self.args.batch_size, self.args.max_pending * 2):
                    self.stop.wait(1.0)
                    continue
                try:
                    self.make_batch()
                    backoff = 5.0
                except Exception as e:  # never crash: log, back off, try again
                    self._error("batch failed", e)
                    self.stop.wait(backoff)
                    backoff = min(backoff * 2, 600)
        finally:
            self.producer_done.set()

    def next_theme(self) -> tuple[str, str]:
        if self.args.theme:
            return next(t for t in THEMES if t[0] == self.args.theme)
        with self.state.lock:
            t = THEMES[self.state.theme_index % len(THEMES)]
            self.state.theme_index += 1
            return t

    def make_batch(self) -> None:
        theme, about = self.next_theme()
        try:
            stats = self.server.stats()
        except ServerError as e:
            log(f"[warn] no library stats ({e}); not steering toward thin types this batch")
            stats = {"by_type": {}}
        thin = thin_types(stats) if stats.get("by_type") else []
        with self.state.lock:
            used = list(self.state.theme_names.get(theme, []))
        n = self.args.batch_size
        prompt = user_prompt(theme, about, n, thin, used)
        log(f"asking Claude for {n} '{theme}' moves" + (f" (thin: {', '.join(t for t, _ in thin)})" if thin else ""))
        t0 = time.time()
        if self.fake:
            raw, usage = self.fake.ask(n), {"model": "fake"}
        else:
            raw, usage = ask_claude(self.claude, prompt, self.args.effort)
        self.calls_this_run += 1
        self.state.count("calls")
        self.refresh_library()

        with self.state.lock:
            self.state.claude_calls += 1
            self.state.batch_counter += 1
            batch = self.state.batch_counter
            inflight = {norm(k) for item in self.state.queue + self.state.pending for k in [item["spec"]["name"], *item["spec"]["aliases"]]}
            taken = self.library_keys | self.state.names | inflight
            records: list[dict[str, Any]] = []
            counts = {"queued": 0, "invalid": 0, "dupes": 0, "reused": 0}
            fresh: list[dict[str, Any]] = []  # passed validation and duplicate checks, in order
            for r in raw:
                spec, why = validate(r)
                if spec is None:
                    records.append({"raw": r, "outcome": f"dropped: {why}"})
                    counts["invalid"] += 1
                    self.state.count("invalid", reason=why.split(":")[0].split("(")[0].strip()[:40])
                    continue
                keys = {norm(spec["name"]), *(norm(a) for a in spec["aliases"])}
                clash = keys & taken
                if clash:
                    records.append({"spec": spec, "outcome": f"dropped: duplicate ({sorted(clash)[0]})"})
                    counts["dupes"] += 1
                    self.state.count("dupes")
                    continue
                taken |= keys
                rec = {"spec": spec, "outcome": ""}
                records.append(rec)
                fresh.append(rec)

            # Motion reuse: a near-duplicate of a known prompt shares its motion; a near-duplicate of an
            # earlier spec in this batch waits for that spec's motion.
            prompts = [r["spec"]["kimodo_prompt"] for r in fresh]
            nearest = self.index.nearest_many(prompts)
            pair = self.index.pairwise(prompts)
            generators: list[int] = []  # indices in `fresh` that will generate a new motion
            for i, rec in enumerate(fresh):
                spec = rec["spec"]
                item: dict[str, Any] = {"spec": spec, "theme": theme, "batch": batch}
                sim, motion = nearest[i]
                twin = next((j for j in generators if pair[j][i] >= REUSE_SIMILARITY and same_directions(prompts[j], prompts[i])), None)
                if motion and sim >= REUSE_SIMILARITY:
                    spec["motion_id"] = motion
                    plan = f"reuse {motion} (similarity {sim:.2f})"
                    counts["reused"] += 1
                elif twin is not None:
                    item["wait_for"] = fresh[twin]["spec"]["kimodo_prompt"]
                    plan = f"reuse the motion of '{fresh[twin]['spec']['name']}'"
                    counts["reused"] += 1
                else:
                    plan = "generate"
                    generators.append(i)
                rec["outcome"] = f"dry run: would {plan}" if self.args.dry_run else f"queued: {plan}"
                counts["queued"] += 1
                if not self.args.dry_run:
                    self.state.queue.append(item)
            self.state.save()
        self.review.write(batch, theme, {"when": time.strftime("%Y-%m-%d %H:%M"), "model": usage.get("model"), "usage": usage, "prompt": prompt}, records)
        log(f"batch {batch} '{theme}': {len(raw)} specs in {time.time() - t0:.0f}s -> {counts['queued']} {'ok (dry run)' if self.args.dry_run else 'queued'}, "
            f"{counts['reused']} reusing motions, {counts['dupes']} duplicates, {counts['invalid']} invalid  (batches/batch_{batch:04d}_*.md)")

    # ---------- main loop: queue -> POST /generate -> poll ----------
    def post_some(self) -> None:
        if time.time() < self.server_down_until:
            return
        while True:
            with self.state.lock:
                if len(self.state.pending) >= self.args.max_pending:
                    return
                item = self._next_postable()
                if item is None:
                    return
                self.state.queue.remove(item)
            payload = {k: item["spec"][k] for k in SPEC_KEYS if k in item["spec"]}
            try:
                job = self.server.generate(payload)
            except ServerError as e:
                if e.status == -1 or (e.status is not None and 400 <= e.status < 500 and e.status not in (408, 409, 429)):
                    # the server will never take this spec: drop it, keep going (review finding 8)
                    self._rejected({**item, "job": None}, f"POST /generate {e.status if e.status != -1 else 'no job'}", pending=False)
                    continue
                with self.state.lock:
                    self.state.queue.append(item)  # temporary trouble: back of the line, not the front
                self._server_trouble(e)
                return
            with self.state.lock:
                self.state.pending.append({**item, "job": job, "posted_at": time.time()})
                self.state.save()

    def _next_postable(self) -> dict[str, Any] | None:
        for item in self.state.queue:
            wait = item.get("wait_for")
            if not wait:
                return item
            if wait in self.prompt_motion:  # its twin finished: share the motion
                item["spec"]["motion_id"] = self.prompt_motion[wait]
                item.pop("wait_for")
                return item
            if wait in self.failed_prompts or not any(p["spec"]["kimodo_prompt"] == wait for p in self.state.queue + self.state.pending):
                item.pop("wait_for")  # twin rejected or gone: generate our own
                return item
        return None

    def poll_some(self) -> None:
        with self.state.lock:
            pending = list(self.state.pending)
        for p in pending:
            if time.time() < self.server_down_until:
                return
            if time.time() - p.get("posted_at", time.time()) > JOB_TIMEOUT:  # review finding 9
                with self.state.lock:
                    self.state.pending.remove(p)
                    if not p.get("retried"):
                        self.state.queue.append({k: v for k, v in p.items() if k not in ("job", "posted_at", "poll_errors")} | {"retried": True})
                    self.state.save()
                if p.get("retried"):
                    self._rejected(p, "timeout", pending=False)
                else:
                    log(f"[warn] job {p['job']} ran over {JOB_TIMEOUT} s; posting '{p['spec']['name']}' once more")
                continue
            try:
                r = self.server.job(p["job"])
            except ServerError as e:
                if e.status is not None and e.status != 404:  # this job's problem, not the server's: count it, poll the rest
                    p["poll_errors"] = p.get("poll_errors", 0) + 1
                    if p["poll_errors"] >= POLL_ERROR_LIMIT:
                        self._rejected(p, f"poll error {e.status}")
                    continue
                if e.status == 404:  # the server lost the job (restart?): try the spec once more
                    with self.state.lock:
                        self.state.pending.remove(p)
                        if p.get("retried"):
                            self.state.count("rejected", reason="job lost")
                        else:
                            self.state.queue.insert(0, {k: v for k, v in p.items() if k not in ("job", "posted_at")} | {"retried": True})
                        self.state.save()
                    if p.get("retried"):
                        self.review.update(p["batch"], p["spec"]["name"], "lost: the server forgot the job twice")
                    continue
                self._server_trouble(e)
                return
            status = (r or {}).get("status")
            if status == "done":
                self._kept(p, r)
            elif status == "rejected":
                self._rejected(p, str(r.get("check") or r.get("reason") or r.get("error") or "rejected"))
            elif status not in ("running", "queued", None):  # error, failed, ...: terminal, count it as rejected
                self._rejected(p, f"status {status}")

    def _kept(self, p: dict[str, Any], r: dict[str, Any]) -> None:
        spec = p["spec"]
        move = r.get("move") or {}
        motion = str(move.get("motion_id") or r.get("motion_id") or spec.get("motion_id") or "")
        with self.state.lock:
            self.state.pending.remove(p)
            self.state.names.update({norm(spec["name"]), *(norm(a) for a in spec["aliases"])})
            self.state.theme_names.setdefault(p["theme"], []).append(spec["name"])
            if motion and not spec.get("motion_id"):  # only prompts that made their own motion (no reuse chains)
                self.state.prompts.append({"prompt": spec["kimodo_prompt"], "motion_id": motion})
                self._index_many([(spec["kimodo_prompt"], motion)])
            self.state.count("kept")
            if spec.get("motion_id"):
                self.state.count("reused")
            self.state.save()
        self.review.update(p["batch"], spec["name"], f"kept ({move.get('id', '?')}, {motion or 'no motion id'})",
                           move={k: move.get(k) for k in ("id", "motion_id", "hit_frame", "stability", "originality") if k in move})
        log(f"kept '{spec['name']}' ({spec['type']}/{spec['kind']}) -> {move.get('id', '?')}")

    def _rejected(self, p: dict[str, Any], check: str, pending: bool = True) -> None:
        spec = p["spec"]
        with self.state.lock:
            if pending and p in self.state.pending:
                self.state.pending.remove(p)
            self.failed_prompts.add(spec["kimodo_prompt"])
            self.state.count("rejected", reason=check[:40])
            self.state.save()
        self.review.update(p["batch"], spec["name"], f"rejected: {check}")
        log(f"rejected '{spec['name']}': {check}")

    def _server_trouble(self, e: Exception) -> None:
        self.server_down_until = time.time() + 5
        if time.time() - self.last_server_warn > 60:
            log(f"[warn] server trouble, retrying every 5 s: {e}")
            self.last_server_warn = time.time()

    def _error(self, what: str, e: Exception) -> None:
        if isinstance(e, ClaudeFailure):
            log(f"[warn] {what}: {e}")
        else:
            log(f"[error] {what}: {e.__class__.__name__}: {e}")
            with (HERE / "errors.log").open("a") as f:
                f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {what}\n{traceback.format_exc()}\n")

    def finished(self) -> bool:
        with self.state.lock:
            return self.producer_done.is_set() and not self.state.queue and not self.state.pending

    def run(self) -> None:
        self.startup()
        threading.Thread(target=self.producer, name="producer", daemon=True).start()
        backoff = 1.0
        while True:
            try:
                self.post_some()
                self.poll_some()
                self.state.flush_hours(self.log_path)
                if self.finished():
                    break
                time.sleep(POLL_S)
                backoff = 1.0
            except KeyboardInterrupt:
                raise
            except Exception as e:  # never crash
                self._error("main loop", e)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)

    def shutdown(self, reason: str) -> None:
        self.stop.set()
        self.state.save()
        self.state.flush_hours(self.log_path, include_current=True)
        with self.state.lock:
            log(f"{reason}: {len(self.state.queue)} specs queued and {len(self.state.pending)} jobs in flight saved to {Path(self.args.state).name}; "
                f"run again to resume. Hourly totals in log.txt.")


def _on_sigterm(*_: Any) -> None:
    raise KeyboardInterrupt


def main() -> None:
    args = parse_args()
    builder = Builder(args)
    signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        builder.run()
        builder.shutdown("done")
    except KeyboardInterrupt:
        builder.shutdown("stopped")
        sys.exit(130)


if __name__ == "__main__":
    main()
