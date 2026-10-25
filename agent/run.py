#!/usr/bin/env python3
"""Overnight Library Builder for Infinite Fighter (agent/). See README.md.

Loop: ask Claude for a batch of move specs -> validate + dedupe against the server's library
(GET /library/moves) -> POST /generate (Kimodo turns each kimodo_prompt into a G1 motion) -> poll
the jobs -> log kept / rejected. State lives in state.json (atomic writes after every change), so
a restart resumes the pending jobs first and never submits a spec twice. Never crashes: every
batch and network call is wrapped, logged and backed off. Server API: contract/api.md.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
import traceback
import urllib.parse
from collections import Counter
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import prompt as P  # noqa: E402
from llm import FakeAnthropic, LLMError, SpecWriter, make_client  # noqa: E402
from server_api import GameServer, ServerDown, ServerHTTPError, check_key, short  # noqa: E402
from validate import (TYPES, Drop, PromptIndex, Registry, key, norm_text, post_body, raw_name,  # noqa: E402
                      validate_spec)

REPO = os.path.normpath(os.path.join(HERE, ".."))
# The server's moves.jsonl ($LIBRARY_DIR, default <repo>/library; a relative LIBRARY_DIR is relative to
# the repo, like server/run.sh's). Read only, and only when GET /library/moves fails.
DEFAULT_LIBRARY = os.path.normpath(os.path.join(REPO, os.environ.get("LIBRARY_DIR") or "library", "moves.jsonl"))
DEFAULT_STATE = os.path.join(HERE, "state.json")
DEFAULT_LOG = os.path.join(HERE, "log.txt")
DRYRUN_DIR = os.path.join(HERE, "dryrun")
BATCHES_DIR = os.path.join(HERE, "batches")
LIBRARY_REFRESH = 300  # seconds between library re-reads (it is also re-read before every batch)
FIXTURE = os.path.join(HERE, "fake_specs.json")
JOB_TIMEOUT = 15 * 60
BACKOFF_CAP = 300
TRANSIENT = {408, 425, 429, 502, 503, 504}  # server HTTP statuses that mean "try again later"
# Circuit breakers, so a broken server or template can't burn Claude batches all night:
REFUSED_SLOWDOWN = 5      # this many specs refused (4xx) in a row -> back off before each next one
REJECTED_PAUSE = 25       # this many jobs rejected in a row with nothing kept -> pause Claude ...
REJECTED_PAUSE_SECONDS = 15 * 60  # ... for this long, doubling while it goes on (queued and
REJECTED_PAUSE_MAX = 2 * 3600     # pending jobs keep going)


# --------------------------------------------------------------------------- small helpers

def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def utc_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt(x):
    return f"{x:.2f}" if isinstance(x, float) else str(x)


def is_local(url):
    return (urllib.parse.urlparse(url).hostname or "").lower() in ("localhost", "127.0.0.1", "::1", "0.0.0.0")


def write_json_atomic(path, data):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Log:
    """One timestamped line per event, appended to log.txt and printed."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        except OSError:
            pass

    def __call__(self, kind, msg):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {kind:<8} " + " ".join(str(msg).split("\n"))
        with self.lock:
            try:
                print(line, flush=True)
            except (OSError, ValueError):  # the terminal went away (closed tmux pane); keep the file log
                pass
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError as e:
                print(f"(could not write {self.path}: {e})", file=sys.stderr, flush=True)

    def traceback(self):
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(traceback.format_exc())
        except OSError:
            pass


def new_counter():
    return {"kept": 0, "reused": 0, "rejected": 0, "dropped": 0, "errors": 0,
            "reject_reasons": {}, "drop_reasons": {}, "error_reasons": {}}


def new_state():
    return {
        "version": 1,
        "created": utc_iso(),
        "batch_index": 0,          # next batch number (plain combat when % 4 == 0)
        "theme_index": 0,          # rotation over the non-plain themes
        "size_cap": None,          # batch size after a max_tokens / bad request halving
        "fallbacks_disabled": False,
        "names_by_theme": {},      # theme -> [names]
        "claimed": {},             # name key -> {name, aliases, theme, status}: every agent name/alias
        "recent_names": [],
        "recent_prompts": [],      # last kimodo_prompts accepted, listed in the request for variety
        "reject_counts": {},       # name key -> times rejected (2 strikes and the name stays blocked)
        "kept_by_type": {},
        "queue": [],               # validated, not yet submitted: {spec, theme, batch, notes}
        "pending": [],             # submitted: {spec, job, submitted_at, resubmits, theme, batch}
        "hour": None,
        "hourly": {},              # "YYYY-MM-DD HH:00" -> counters
        "totals": {},
    }


def load_state(path, log, persist):
    if not os.path.exists(path):
        return new_state()
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
        if not isinstance(st, dict):
            raise ValueError("not a JSON object")
    except (OSError, ValueError) as e:
        if not persist:
            log("ERROR", f"state file {path} is unreadable ({e}); this dry run starts from a fresh state")
            return new_state()
        bad = f"{path}.corrupt-{int(time.time())}"
        try:
            os.replace(path, bad)
        except OSError:
            pass
        log("ERROR", f"state file {path} is unreadable ({e}); moved it to {bad} and started fresh")
        return new_state()
    base = new_state()
    base.update(st)
    return base


def thin_types(counts):
    total = sum(counts.values())
    if total < 20:
        return []
    top = max(counts.values())
    return sorted((t for t in TYPES if counts.get(t, 0) < 0.6 * top), key=lambda t: counts.get(t, 0))


def acquire_lock(state_path):
    """One agent per state file: two would submit the same queue twice."""
    try:
        import fcntl
    except ImportError:
        return None
    os.makedirs(os.path.dirname(os.path.abspath(state_path)), exist_ok=True)
    f = open(state_path + ".lock", "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(f"Another run.py is already using {state_path}. Stop it first, or pass a different --state.",
              flush=True)
        sys.exit(4)
    return f


class Fetch(threading.Thread):
    """One Claude batch call in the background, so job polling continues meanwhile."""

    def __init__(self, writer, plan, use_fallbacks):
        super().__init__(daemon=True)
        self.writer = writer
        self.plan = plan
        self.use_fallbacks = use_fallbacks
        self.result = None
        self.error = None
        self.fallbacks_rejected = None

    def run(self):
        try:
            try:
                self.result = self.writer.write(self.plan["text"], self.use_fallbacks)
            except LLMError as e:
                if e.kind != "fallbacks" or not self.use_fallbacks:
                    raise
                # A 400 that names the fallbacks field or the beta header: retry once without them.
                try:
                    self.result = self.writer.write(self.plan["text"], False)
                except LLMError as e2:
                    if e2.kind not in ("fallbacks", "bad_request"):
                        self.fallbacks_rejected = e.message  # the 400 went away without them
                    raise  # (the same 400 without fallbacks means they were not the problem)
                self.fallbacks_rejected = e.message
        except LLMError as e:
            if e.kind == "fallbacks":
                e.kind = "bad_request"
            self.error = e
        except BaseException as e:  # never let the thread die silently
            self.error = LLMError("retry", f"{type(e).__name__}: {e}")


# --------------------------------------------------------------------------- the agent

class Agent:
    def __init__(self, args, log):
        self.args = args
        self.log = log
        self.persist = not args.dry_run
        self.state = load_state(args.state, log, self.persist)
        self.index = PromptIndex(log)  # motion reuse: only motions the server's library has
        self.registry = Registry()
        self.lib_moves = []
        self.lib_source = None         # "server" (GET /library/moves) | "file" | None (not read yet)
        self.lib_names = {}            # name key -> library move
        self.lib_by_type = Counter()
        self.lib_checked = 0.0
        self.lib_failing = False
        self.server = None if args.dry_run else GameServer(args.server)
        self.reader = self.server or GameServer(args.server)  # a dry run only reads the library
        # The moves.jsonl fallback is the server's own file only when the server runs on this machine.
        self.library_file = args.library if args.library_explicit or is_local(args.server) else None
        self.writer = None
        self.fetch = None
        self.batches_done = 0
        self.stop_signal = None
        self.llm_next_ok = 0.0
        self.llm_fails = 0
        self.llm_fatal = None
        self.server_next_ok = 0.0
        self.server_fails = 0
        self.refused_streak = 0    # specs the server refused (4xx) in a row
        self.rejected_streak = 0   # jobs rejected in a row with nothing kept
        self.refusals = 0          # Claude refusals in a row
        self.stats_warned = False
        self.next_poll = {}
        self.resume_jobs = {p["job"] for p in self.state["pending"]}
        self.push_order = []
        self.outcomes = {}
        self.push_notes = {}
        self.dry_specs, self.dry_drops, self.dry_batches = [], [], []
        self.refresh_library(force=True)

    # ---- state ---------------------------------------------------------------------------

    def save(self):
        if not self.persist:
            return
        try:
            write_json_atomic(self.args.state, self.state)
        except OSError as e:
            self.log("ERROR", f"could not save {self.args.state}: {e}")

    def roll_hour(self):
        if not self.persist:
            return
        hour = time.strftime("%Y-%m-%d %H:00")
        cur = self.state.get("hour")
        if cur == hour:
            return
        if cur:
            self.summary(cur)
        self.state["hour"] = hour
        hourly = self.state["hourly"]
        for k in sorted(hourly)[:-48]:
            del hourly[k]
        self.save()

    def count(self, kind, reason=None):
        if not self.persist:
            return
        self.roll_hour()
        h = self.state["hourly"].setdefault(self.state["hour"], new_counter())
        h[kind] = h.get(kind, 0) + 1
        bucket = {"rejected": "reject_reasons", "dropped": "drop_reasons", "errors": "error_reasons"}.get(kind)
        if reason and bucket:
            h.setdefault(bucket, {})
            h[bucket][reason] = h[bucket].get(reason, 0) + 1
        t = self.state["totals"]
        t[kind] = t.get(kind, 0) + 1

    def summary(self, hour, partial=False):
        c = self.state["hourly"].get(hour) or new_counter()

        def top(d, n=3):
            return ", ".join(f"{k} {v}" for k, v in Counter(d or {}).most_common(n)) or "none"

        self.log("SUMMARY", f"{hour} kept {c.get('kept', 0)} (reused motion {c.get('reused', 0)}) rejected "
                            f"{c.get('rejected', 0)} dropped {c.get('dropped', 0)} errors {c.get('errors', 0)}  "
                            f"rejected by check: {top(c.get('reject_reasons'), 12)}  top drop reasons: "
                            f"{top(c.get('drop_reasons'))}  top errors: {top(c.get('error_reasons'))}"
                 + ("  (hour so far)" if partial else ""))

    # ---- library file and dedupe -----------------------------------------------------------

    def refresh_library(self, force=False):
        """Seed dedupe and motion reuse from the server's library: GET /library/moves, or the
        server's moves.jsonl (read only) when that request fails and the file is on this machine.
        If both fail, the last snapshot stays. Returns True when a fresh snapshot was read."""
        self.lib_checked = time.time()
        moves, source, why = None, None, None
        try:
            moves, source = self.reader.moves(), "server"
        except (ServerDown, ServerHTTPError) as e:
            why = short(str(e), 200)
        if moves is None and self.library_file:
            moves = self.read_library_file(self.library_file)
            source = "file" if moves is not None else None
        if why and not self.lib_failing:
            if source == "file":
                then = f"reading {self.library_file} until it works"
            elif self.lib_moves:
                then = f"keeping the last library snapshot ({len(self.lib_moves)} moves) until it works"
            else:
                then = "dedupe sees only this agent's own names until it works"
            self.log("INFO", f"GET /library/moves failed ({why}); {then}")
        elif not why and self.lib_failing:
            self.log("INFO", f"GET /library/moves works again ({len(moves)} moves)")
        self.lib_failing = bool(why)
        if moves is None:
            return False
        self.set_library(moves, source)
        return True

    def read_library_file(self, path):
        """moves.jsonl, one move per line (a JSON list works too), or None if it can't be read."""
        if not os.path.exists(path):
            return None
        moves = []
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
            if text.lstrip().startswith("["):
                moves = [m for m in json.loads(text) if isinstance(m, dict)]
            else:
                for line in text.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue  # a half-written last line
                    if isinstance(m, dict):
                        moves.append(m)
        except (OSError, ValueError) as e:
            self.log("ERROR", f"could not read the library file {path}: {e}")
            return None
        return moves

    def set_library(self, moves, source):
        by_id = {}
        for m in moves:
            if m.get("name"):
                by_id[str(m.get("id") or m.get("name"))] = m
        self.lib_moves = list(by_id.values())
        self.lib_names = {key(str(m.get("name"))): m for m in self.lib_moves}
        self.lib_source = source
        self.lib_by_type = Counter(m.get("type") for m in self.lib_moves if m.get("type") in TYPES)
        if source == "server":
            self.forget_lost_moves()
        # Motion reuse points only at motions the library has right now, and only through the prompt
        # that made each motion: the first move with a motion_id generated it (the library is in
        # creation order), later ones reused it. Indexing the reusers' prompts too would let reuse
        # chain away from what the motion shows (p3 gets p1's motion through p2, though p3 vs p1 is
        # under 0.95). Forge motions follow the player's acting more than their prompt, so only agent
        # and live motions are reused.
        self.index.reset()
        made = set()
        for m in self.lib_moves:
            mid = m.get("motion_id")
            if not mid or mid in made:
                continue
            made.add(mid)
            if m.get("source") != "forge" and m.get("kimodo_prompt"):
                self.index.add(m["kimodo_prompt"], mid)
        self.rebuild_registry()

    def forget_lost_moves(self):
        """Release the names of moves this agent got kept that the server's library no longer has
        (the library was reset, or this state file came from another server), so they can be made
        again."""
        have = {key(str(m.get("name"))) for m in self.lib_moves}
        lost = [c for k, c in self.state["claimed"].items() if c.get("status") == "kept" and k not in have]
        if not lost:
            return
        for c in lost:
            self.release({"name": c["name"], "aliases": c.get("aliases") or [], "kimodo_prompt": None},
                         c.get("theme"), strike=False)
        self.save()
        self.log("INFO", f"{len(lost)} moves this agent made are not in the server's library any more (e.g. "
                         f"{', '.join(repr(c['name']) for c in lost[:5])}); their names are free again")

    def library_desc(self):
        if self.lib_source == "server":
            return f"{len(self.lib_moves)} moves from GET {self.args.server}/library/moves"
        if self.lib_source == "file":
            return f"{len(self.lib_moves)} moves from {self.library_file}"
        return "none (GET /library/moves failed)" if self.lib_failing else "not read yet"

    def rebuild_registry(self):
        r = Registry()
        for m in self.lib_moves:
            r.claim(str(m.get("name")), m.get("aliases") if isinstance(m.get("aliases"), list) else [])
        for c in self.state["claimed"].values():
            r.claim(c["name"], c.get("aliases") or [])
        self.registry = r

    def claim(self, spec, theme, status):
        self.state["claimed"][key(spec["name"])] = {"name": spec["name"], "aliases": spec["aliases"],
                                                   "theme": theme, "status": status}
        self.registry.claim(spec["name"], spec["aliases"])
        names = self.state["names_by_theme"].setdefault(theme, [])
        if spec["name"] not in names:
            names.append(spec["name"])
        recent = self.state["recent_names"]
        recent.append(spec["name"])
        del recent[:-300]
        prompts = self.state.setdefault("recent_prompts", [])
        prompts.append(spec["kimodo_prompt"])
        del prompts[:-200]

    def set_status(self, spec, status):
        c = self.state["claimed"].get(key(spec["name"]))
        if c:
            c["status"] = status

    def release(self, spec, theme, strike=True):
        """Free a name that never made it into the library, so a later batch may try it again.
        Two rejections and the name stays blocked."""
        nk = key(spec["name"])
        if strike:
            self.state["reject_counts"][nk] = self.state["reject_counts"].get(nk, 0) + 1
            if self.state["reject_counts"][nk] >= 2:
                self.set_status(spec, "blocked")
                return
        self.state["claimed"].pop(nk, None)
        names = self.state["names_by_theme"].get(theme) or []
        if spec["name"] in names:
            names.remove(spec["name"])
        self.state["recent_names"] = [n for n in self.state["recent_names"] if n != spec["name"]]
        self.state["recent_prompts"] = [p for p in self.state.get("recent_prompts", []) if p != spec["kimodo_prompt"]]
        self.registry.release(spec["name"], spec["aliases"])

    def outcome(self, spec, status, **kw):
        if self.args.push:
            self.outcomes[key(spec["name"])] = dict(kw, name=spec["name"], status=status, spec=spec)

    # ---- planning and Claude -----------------------------------------------------------------

    def batch_size(self):
        cap = self.state.get("size_cap")
        return max(1, min(self.args.batch_size, cap)) if cap else self.args.batch_size

    def type_counts(self):
        if self.server is not None:
            try:
                stats = self.server.stats()
                self.server_ok()
                if stats.get("by_type"):
                    return {t: int(stats["by_type"].get(t, 0)) for t in TYPES}, "server"
            except ServerHTTPError as e:
                self.server_ok()  # it answered, just not with stats
                if not self.stats_warned:
                    self.log("INFO", f"GET /library/stats failed ({e}); using local type counts")
                    self.stats_warned = True
            # ServerDown propagates: the caller backs off instead of generating for a dead server.
        base = Counter(self.lib_by_type) if self.lib_moves else Counter(self.state["kept_by_type"])
        for item in self.state["queue"] + self.state["pending"]:
            base[item["spec"]["type"]] += 1
        return {t: base.get(t, 0) for t in TYPES}, ("library" if self.lib_source == "server" else "local")

    def plan_batch(self):
        st = self.state
        b = st["batch_index"]
        if self.args.theme:
            theme = self.args.theme
        elif b % 4 == 0:
            theme = P.PLAIN
        else:
            theme = P.OTHER_THEMES[st["theme_index"] % len(P.OTHER_THEMES)]
        size = self.batch_size()
        counts, src = self.type_counts()
        thin = thin_types(counts)
        theme_names = st["names_by_theme"].get(theme, [])[-400:]
        seen = {key(n) for n in theme_names}
        pool = [str(m.get("name")) for m in self.lib_moves[-150:]] + st["recent_names"][-150:]
        others = []
        for n in reversed(pool):
            k = key(n)
            if k and k not in seen:
                seen.add(k)
                others.append(n)
            if len(others) >= 150:
                break
        others.reverse()
        claimed = sorted(self.registry.aliases, key=lambda a: (len(a.split()), len(a), a))[:150]
        unclaimed = [s for s in P.CORE_SHOUTS if not self.registry.taken(s)]
        kinds = P.split_counts(size, P.KIND_WEIGHTS_PLAIN if theme == P.PLAIN else P.KIND_WEIGHTS)
        powers = P.split_counts(size, P.POWER_WEIGHTS)
        recent, seen_p = [], set()
        pool = [m.get("kimodo_prompt") for m in self.lib_moves[-P.RECENT_PROMPTS:]] + \
            st.get("recent_prompts", [])[-P.RECENT_PROMPTS:]
        for p in reversed(pool):
            if isinstance(p, str) and norm_text(p) and norm_text(p) not in seen_p:
                seen_p.add(norm_text(p))
                recent.append(p)
            if len(recent) >= P.RECENT_PROMPTS:
                break
        recent.reverse()
        text = P.build_user_message(theme, size, kinds, powers, thin, counts, theme_names, others, claimed,
                                    unclaimed, recent)
        return {"batch": b, "theme": theme, "size": size, "text": text, "thin": thin, "types_from": src,
                "kinds": kinds, "powers": powers}

    def get_writer(self):
        if self.writer is None:
            client = make_client(FIXTURE if self.args.fake_llm else None)
            self.writer = SpecWriter(client, self.args.model, self.args.effort, P.SYSTEM_PROMPT, P.SCHEMA)
        return self.writer

    def start_fetch(self):
        self.refresh_library()
        plan = self.plan_batch()
        writer = self.get_writer()
        if isinstance(writer.client, FakeAnthropic):
            writer.client.batch_no = plan["batch"]
        use_fb = not self.args.no_fallbacks and not self.state.get("fallbacks_disabled")
        self.log("BATCH", f"#{plan['batch']} theme={plan['theme']!r}: asking {self.args.model}"
                          f"{' (fake)' if self.args.fake_llm else ''} effort={self.args.effort} prompt={P.PROMPT_VERSION}"
                          f" for {plan['size']} specs; thin types: {', '.join(plan['thin']) or 'none'}"
                          f" ({plan['types_from']} counts)")
        self.fetch = Fetch(writer, plan, use_fb)
        self.fetch.start()

    def log_llm(self, plan, info, got, outcome):
        u = info.get("usage") or {}
        self.log("LLM", f"#{plan['batch']} {outcome} got={got} model={info.get('model')} {info.get('seconds')}s "
                        f"in={u.get('input_tokens')} out={u.get('output_tokens')} "
                        f"cache_read={u.get('cache_read_input_tokens')} cache_write={u.get('cache_creation_input_tokens')} "
                        f"request_id={info.get('request_id')}"
                 + (" (served by a fallback model)" if info.get("fallback") else ""))

    def finish_fetch(self):
        f, self.fetch = self.fetch, None
        plan = f.plan
        if f.fallbacks_rejected:
            self.state["fallbacks_disabled"] = True
            self.log("INFO", f"the API refused server-side fallbacks ({short(f.fallbacks_rejected)}); retried "
                             "without them and turned them off"
                     + (" (fallbacks_disabled in state.json)" if self.persist else " for this run"))
            self.save()
        if f.error is not None:
            self.on_llm_error(f.error, plan)
            return
        moves, info = f.result
        self.llm_fails = 0
        self.refusals = 0
        self.log_llm(plan, info, len(moves), "ok")
        accepted, dropped = self.take_specs(moves, plan)
        cap = self.state.get("size_cap")
        if cap:
            cap = int(cap * 1.5) + 1
            self.state["size_cap"] = None if cap >= self.args.batch_size else cap
        self.log("BATCH", f"#{plan['batch']} theme={plan['theme']!r}: {len(accepted)} of {len(moves)} specs kept, "
                          f"{len(dropped)} dropped" + (f"; queue {len(self.state['queue'])}" if self.persist else ""))
        if not self.persist:
            self.dry_batches.append({"batch": plan["batch"], "theme": plan["theme"], "asked": plan["size"],
                                     "got": len(moves), "kept": len(accepted), "dropped": len(dropped),
                                     "kinds_asked": plan["kinds"], "powers_asked": plan["powers"],
                                     "thin_types": plan["thin"], "llm": info})
            self.dry_specs.extend(accepted)
            self.dry_drops.extend(dict(d, batch=plan["batch"]) for d in dropped)
        self.advance(plan)
        self.save()

    def advance(self, plan):
        self.state["batch_index"] = plan["batch"] + 1
        if not self.args.theme and plan["theme"] != P.PLAIN:
            self.state["theme_index"] += 1
        self.batches_done += 1

    def on_llm_error(self, e, plan):
        if e.info:
            self.log_llm(plan, e.info, None, e.kind)
        if e.kind == "fatal":
            self.llm_fatal = e.message
            self.log("FATAL", e.message)
        elif e.kind == "refusal":
            self.refusals += 1
            self.log("REFUSED", f"#{plan['batch']} theme={plan['theme']!r} refused ({e.message}); skipping to the next theme")
            self.advance(plan)
            self.save()
            if self.refusals >= 2:  # refused again and again: slow down instead of spinning through the themes
                wait = min(BACKOFF_CAP, 30 * 2 ** (self.refusals - 2))
                self.llm_next_ok = time.time() + wait
                self.log("INFO", f"{self.refusals} refusals in a row; next Claude call in {wait}s")
        elif e.kind == "truncated":
            if plan["size"] <= 1:
                self.backoff_llm(e)
            else:
                self.halve(plan, f"#{plan['batch']} {e.message}")
        elif e.kind == "bad_request":
            self.halve(plan, f"#{plan['batch']} bad request")
            self.backoff_llm(e)
        elif e.kind == "rate_limit":
            self.llm_next_ok = time.time() + (e.wait or 60)
            self.log("ERROR", f"#{plan['batch']} rate limited; waiting {e.wait or 60:.0f}s")
        else:
            self.backoff_llm(e)

    def halve(self, plan, why):
        new = max(1, plan["size"] // 2)
        self.state["size_cap"] = new
        self.log("INFO", f"{why}: batch size {plan['size']} -> {new}")
        self.save()

    def backoff_llm(self, e):
        self.llm_fails += 1
        wait = min(BACKOFF_CAP, 10 * 2 ** (self.llm_fails - 1))
        self.llm_next_ok = time.time() + wait
        self.log("ERROR", f"Claude call failed ({e.kind}): {short(e.message, 300)}; retrying in {wait}s")

    def take_specs(self, moves, plan):
        accepted, dropped = [], []
        for raw in moves:
            try:
                spec, notes = validate_spec(raw)
                spec, stripped = self.registry.check(spec)
            except Drop as d:
                dropped.append({"name": raw_name(raw), "code": d.code, "reason": d.detail, "raw": raw})
                if self.persist:
                    self.log("DROPPED", f"{raw_name(raw)!r} (batch #{plan['batch']}): {d.detail}")
                    self.count("dropped", d.code)
                continue
            if stripped:
                notes.append("stripped claimed aliases: " + ", ".join(stripped))
            item = {"spec": spec, "theme": plan["theme"], "batch": plan["batch"], "notes": notes}
            self.claim(spec, plan["theme"], "queued")
            if self.persist:  # queue it together with its claim, so no save can catch one without the other
                self.state["queue"].append(item)
            accepted.append(item)
        return accepted, dropped

    # ---- server jobs ---------------------------------------------------------------------------

    def submit_some(self):
        """Submit queued specs up to --max-inflight. Returns True if it talked to the server."""
        st = self.state
        talked = False
        while st["queue"] and len(st["pending"]) < self.args.max_inflight and not self.stop_signal:
            item = st["queue"][0]
            spec = dict(item["spec"])
            have = self.lib_names.get(key(spec["name"]))
            if have is not None:
                # Already in the library: posted just before a crash, before state.json had the job,
                # or another move took the name meanwhile. Never post a name twice.
                st["queue"].pop(0)
                self.set_status(spec, "kept")
                self.count("dropped", "already in library")
                self.save()
                self.log("DROPPED", f"{spec['name']!r}: already in the library as {have.get('id')}; not submitted again")
                self.outcome(spec, "dropped", reason=f"already in the library as {have.get('id')}")
                continue
            reuse = ""
            if item.get("no_reuse"):
                spec.pop("motion_id", None)
            elif "motion_id" not in spec:
                mid, score, other = self.index.best(spec["kimodo_prompt"])
                if mid:
                    spec["motion_id"] = mid
                    reuse = f" reusing motion {mid} (similarity {score:.2f} to {other!r})"
            try:
                talked = True
                job = self.server.generate(post_body(spec))
            except ServerHTTPError as e:
                if e.status in TRANSIENT or e.status in (200, 404):  # 200: no job id; 404: no such route there
                    raise ServerDown(f"POST /generate: {e}") from None
                if e.status >= 500:
                    # Retry a spec the server chokes on a few times, then drop it so it can't
                    # block the rest of the queue all night.
                    item["errors_5xx"] = item.get("errors_5xx", 0) + 1
                    if item["errors_5xx"] < 3:
                        self.save()
                        raise ServerDown(f"POST /generate {spec['name']!r}: {e}") from None
                    st["queue"].pop(0)
                    self.count("errors", f"server {e.status}")
                    self.release(item["spec"], item["theme"], strike=False)
                    self.save()
                    self.log("ERROR", f"{spec['name']!r}: POST /generate failed 3 times ({e}); dropped")
                    self.outcome(spec, "error", reason=str(e))
                    continue
                if spec.get("motion_id") and not item.get("no_reuse"):
                    item["no_reuse"] = True
                    self.save()
                    self.log("RESUBMIT", f"{spec['name']!r}: server refused motion_id {spec['motion_id']} "
                                         f"({e.status}); resubmitting without it")
                    continue
                st["queue"].pop(0)
                if e.status == 409:
                    self.set_status(spec, "kept")
                    self.count("dropped", "server duplicate")
                    self.save()
                    self.log("DROPPED", f"{spec['name']!r}: the server already has it (409): {short(e.body)}")
                    self.outcome(spec, "refused", reason=f"{e.status} {short(e.body)}")
                    continue
                self.count("errors", f"refused {e.status}")
                self.release(item["spec"], item["theme"])
                self.save()
                self.log("ERROR", f"{spec['name']!r}: server refused the spec ({e.status}): {short(e.body, 300)}")
                self.outcome(spec, "refused", reason=f"{e.status} {short(e.body)}")
                self.refused_streak += 1
                if self.refused_streak >= REFUSED_SLOWDOWN:
                    # Every spec refused: the request shape is probably wrong (check contract/api.md
                    # against server_api.py). Slow down so the queue can't drain into new Claude batches.
                    raise ServerDown(f"the server refused {self.refused_streak} specs in a row (last: HTTP "
                                     f"{e.status}); check server_api.py against contract/api.md")
                continue
            self.refused_streak = 0
            st["queue"].pop(0)
            st["pending"].append({"spec": spec, "job": job, "submitted_at": time.time(),
                                  "resubmits": item.get("resubmits", 0), "theme": item["theme"],
                                  "batch": item.get("batch"), "no_reuse": bool(item.get("no_reuse"))})
            self.set_status(spec, "pending")
            self.next_poll[job] = time.time() + self.args.poll
            self.save()  # right after the POST, so a crash can't submit it twice
            self.log("SUBMIT", f"{spec['name']!r} job={job}{reuse}")
        return talked

    def poll_due(self):
        """Poll pending jobs round-robin, about once per --poll seconds each."""
        now = time.time()
        due = [p for p in self.state["pending"] if self.next_poll.get(p["job"], 0) <= now]
        due.sort(key=lambda p: self.next_poll.get(p["job"], 0))
        talked = False
        for p in due[: max(1, self.args.max_inflight)]:
            if self.stop_signal:
                break
            talked = True
            try:
                res = self.server.job(p["job"])
            except ServerHTTPError as e:
                if e.status in TRANSIENT:
                    raise ServerDown(f"GET /job/{p['job']}: {e}") from None
                if e.status >= 500:
                    p["errors_5xx"] = p.get("errors_5xx", 0) + 1
                    if p["errors_5xx"] < 5:
                        raise ServerDown(f"GET /job/{p['job']}: {e}") from None
                    self.log("ERROR", f"{p['spec']['name']!r}: GET /job/{p['job']} failed 5 times ({e}); "
                                      "treating the job as lost")
                res = {"status": "unknown", "why": f"HTTP {e.status}"}  # a 4xx, or 5 server errors
            self.resume_jobs.discard(p["job"])
            status = res["status"]
            if status == "running":
                if time.time() - p["submitted_at"] > JOB_TIMEOUT:
                    self.on_timeout(p)
                else:
                    self.next_poll[p["job"]] = time.time() + self.args.poll
            elif status == "done":
                self.on_done(p, res.get("move") or {})
            elif status == "rejected":
                self.on_rejected(p, res)
            else:
                self.on_lost(p, res.get("why") or "404")
        return talked

    def drop_pending(self, p):
        self.state["pending"] = [q for q in self.state["pending"] if q["job"] != p["job"]]
        self.next_poll.pop(p["job"], None)

    def record_kept(self, p, move, how=""):
        spec = p["spec"]
        mid = move.get("motion_id")
        prompt = move.get("kimodo_prompt") or spec["kimodo_prompt"]
        reused = bool(spec.get("motion_id") and spec.get("motion_id") == mid)
        if mid and not reused:  # only the prompt that made a motion points at it (see set_library)
            self.index.add(prompt, mid)
        self.set_status(spec, "kept")
        self.rejected_streak = 0
        kt = self.state["kept_by_type"]
        kt[spec["type"]] = kt.get(spec["type"], 0) + 1
        self.drop_pending(p)
        self.count("kept")
        if reused:
            self.count("reused")
        self.save()
        self.log("KEPT", f"{spec['name']!r} job={p['job']} id={move.get('id')} motion={mid} "
                         f"hit_frame={move.get('hit_frame')} stability={fmt(move.get('stability'))} "
                         f"originality={fmt(move.get('originality'))}{' (reused motion)' if reused else ''}{how}")
        self.outcome(spec, "kept", job=p["job"], move_id=move.get("id"), motion_id=mid,
                     hit_frame=move.get("hit_frame"), stability=move.get("stability"),
                     originality=move.get("originality"), reused=reused)

    def on_done(self, p, move):
        self.record_kept(p, move)

    def on_rejected(self, p, res):
        spec = p["spec"]
        check = res.get("check") or ""          # contract/api.md: nan_frames, barely_moved, ... or "error: ..."
        reason = res.get("reason") or "rejected"
        self.drop_pending(p)
        if spec.get("motion_id") and not p.get("no_reuse") and "motion" in check.lower():
            item = {"spec": {k: v for k, v in spec.items() if k != "motion_id"}, "theme": p["theme"],
                    "batch": p.get("batch"), "resubmits": p.get("resubmits", 0), "no_reuse": True}
            self.state["queue"].insert(0, item)
            self.set_status(spec, "queued")
            self.save()
            self.log("RESUBMIT", f"{spec['name']!r} job={p['job']} was rejected with reused motion "
                                 f"{spec['motion_id']} ({short(reason)}); resubmitting without motion_id")
            return
        self.count("rejected", check_key(check))
        self.release(spec, p["theme"])
        self.save()
        self.log("REJECTED", f"{spec['name']!r} job={p['job']} check={check or '-'} reason={short(reason, 300)}")
        self.outcome(spec, "rejected", job=p["job"], reason=f"{check}: {reason}" if check else reason)
        self.rejected_streak += 1
        if self.rejected_streak % REJECTED_PAUSE == 0 and not self.args.push:
            # Nothing passes the server's checks: the template or the server is broken. Stop paying
            # for new batches for a while; the queued and pending jobs keep going.
            pause = min(REJECTED_PAUSE_MAX, REJECTED_PAUSE_SECONDS * 2 ** (self.rejected_streak // REJECTED_PAUSE - 1))
            self.llm_next_ok = max(self.llm_next_ok, time.time() + pause)
            self.log("PAUSE", f"{self.rejected_streak} jobs rejected in a row and none kept: no new Claude batches "
                              f"for {pause // 60} min. Read the REJECTED lines and fix prompt.py or the server.")

    def on_lost(self, p, why="404"):
        spec = p["spec"]
        if not self.refresh_library():
            # Can't tell whether the move made it into the library before the server forgot the job,
            # and a blind resubmit could add it twice: keep the job pending and look again later.
            raise ServerDown(f"the server forgot job {p['job']} ({spec['name']!r}) and its library can't be read")
        found = next((m for m in self.lib_moves if key(str(m.get("name"))) == key(spec["name"])), None)
        if found:
            self.record_kept(p, found, " (the server lost the job, but the move is in the library)")
            return
        self.drop_pending(p)
        if p.get("resubmits", 0) < 1:
            self.state["queue"].insert(0, {"spec": spec, "theme": p["theme"], "batch": p.get("batch"),
                                           "resubmits": p.get("resubmits", 0) + 1,
                                           "no_reuse": bool(p.get("no_reuse"))})
            self.set_status(spec, "queued")
            self.save()
            self.log("RESUBMIT", f"{spec['name']!r}: the server lost job {p['job']} ({why}"
                                 f"{', restarted?' if why == '404' else ''}); resubmitting once")
            return
        self.count("errors", "job lost")
        self.release(spec, p["theme"], strike=False)
        self.save()
        self.log("ERROR", f"{spec['name']!r}: job {p['job']} lost again ({why}); giving up on it")
        self.outcome(spec, "lost", job=p["job"], reason=f"lost twice ({why})")

    def on_timeout(self, p):
        spec = p["spec"]
        self.drop_pending(p)
        self.count("errors", "timeout")
        self.release(spec, p["theme"], strike=False)
        self.save()
        self.log("TIMEOUT", f"{spec['name']!r} job={p['job']} still running after {JOB_TIMEOUT // 60} min; dropped")
        self.outcome(spec, "timeout", job=p["job"], reason=f"running > {JOB_TIMEOUT // 60} min")

    def server_failed(self, e):
        self.server_fails += 1
        wait = min(BACKOFF_CAP, 2 ** self.server_fails)
        self.server_next_ok = time.time() + wait
        self.log("SERVER", f"{e}; retrying in {wait}s ({len(self.state['pending'])} pending, "
                           f"{len(self.state['queue'])} queued)")

    def server_ok(self):
        if self.server_fails:
            self.log("SERVER", f"reachable again at {self.args.server}")
        self.server_fails = 0

    # ---- main loops ------------------------------------------------------------------------------

    def should_fetch(self):
        if self.fetch is not None or self.llm_fatal or self.args.push or self.stop_signal:
            return False
        if self.args.batches and self.batches_done >= self.args.batches:
            return False
        if self.resume_jobs or len(self.state["queue"]) >= self.args.max_inflight:
            return False
        if time.time() < self.llm_next_ok:
            return False
        if self.server is not None:
            if time.time() < self.server_next_ok:
                return False
            # While the server is failing and there is work, the job polls probe it; with no work,
            # the /library/stats call at the start of the next batch is the probe.
            if self.server_fails and (self.state["queue"] or self.state["pending"]):
                return False
        return True

    def finished(self):
        if self.fetch is not None or self.state["queue"] or self.state["pending"]:
            return False
        if self.args.push or self.llm_fatal:
            return True
        return bool(self.args.batches) and self.batches_done >= self.args.batches

    def tick(self):
        self.roll_hour()
        if self.fetch is not None and not self.fetch.is_alive():
            self.finish_fetch()
        if (self.state["pending"] or self.state["queue"]) and time.time() >= self.server_next_ok:
            try:
                talked = self.poll_due()
                if not self.resume_jobs:
                    talked = self.submit_some() or talked
                if talked:
                    self.server_ok()
            except ServerDown as e:
                self.server_failed(e)
        if time.time() - self.lib_checked > LIBRARY_REFRESH and time.time() >= self.server_next_ok:
            self.refresh_library()
        if self.should_fetch():
            try:
                self.start_fetch()
            except ServerDown as e:
                self.server_failed(e)
            except LLMError as e:
                self.on_llm_error(e, {"batch": self.state["batch_index"], "theme": "?", "size": self.batch_size()})

    def check_health(self):
        try:
            h = self.server.health()
            self.log("SERVER", f"{self.args.server} health: {short(h, 200)}")
            if self.server.ua:
                self.log("INFO", f"the proxy in front of the server refused the first User-Agent (Cloudflare "
                                 f"error 1010); using {self.server.user_agent!r}")
            if isinstance(h, dict) and h.get("engine") == "mock":
                self.log("INFO", "this server runs the mock engine: its motions are fake (fine for tests)")
        except (ServerDown, ServerHTTPError) as e:
            self.log("SERVER", f"health check failed ({e}); will keep retrying")

    def preflight(self):
        """Missing or bad Anthropic credentials (or an unknown --model) end the run with code 3 right
        away, instead of after the game server comes up. GET /v1/models costs no tokens."""
        try:
            self.get_writer().check_access()
        except LLMError as e:
            if e.kind == "fatal":
                self.llm_fatal = e.message
                self.log("FATAL", e.message)
            else:  # network trouble and the like: the batch calls retry on their own
                self.log("INFO", f"could not check Anthropic access yet ({short(e.message, 200)}); continuing")

    def run(self):
        st = self.state
        self.log("START", f"run.py {' '.join(sys.argv[1:])} | batch #{st['batch_index']} | {len(st['pending'])} pending, "
                          f"{len(st['queue'])} queued | library: {self.library_desc()}")
        if st["pending"]:
            self.log("RESUME", f"polling {len(st['pending'])} pending jobs before submitting or asking Claude for more")
        if not self.args.push:
            self.preflight()
            if self.llm_fatal and (st["pending"] or st["queue"]):
                self.log("INFO", "finishing the queued and pending jobs before exiting")
        self.check_health()
        while not self.stop_signal:
            try:
                self.tick()
            except Exception as e:  # never crash
                self.log("ERROR", f"unexpected {type(e).__name__}: {e} (traceback in the log file)")
                self.log.traceback()
                time.sleep(5)
            if self.finished():
                break
            time.sleep(0.2)
        return self.shutdown()

    def shutdown(self):
        self.save()
        if self.stop_signal:
            self.log("STOP", f"got {self.stop_signal}: state saved, exiting")
        if self.persist and self.state.get("hour"):
            self.summary(self.state["hour"], partial=True)
        code = 0 if self.stop_signal or not self.llm_fatal else 3
        self.log("EXIT", f"code {code}: {len(self.state['pending'])} pending, {len(self.state['queue'])} queued, "
                         f"totals {json.dumps(self.state.get('totals') or {})}")
        return code

    def run_push(self):
        path = self.args.push
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            items = data.get("specs") if isinstance(data, dict) else data
            if not isinstance(items, list):
                raise ValueError("expected a dry run JSON with a 'specs' list, or a JSON list of specs")
        except (OSError, ValueError) as e:
            self.log("ERROR", f"--push {path}: {e}")
            return 2
        queued = 0
        for raw in items:
            theme = raw.get("theme") if isinstance(raw, dict) and isinstance(raw.get("theme"), str) \
                and raw["theme"] in P.THEMES else "pushed"
            name = raw_name(raw)
            self.push_order.append(key(name) or name)
            try:
                spec, notes = validate_spec(raw)
                spec, stripped = self.registry.check(spec)
            except Drop as d:
                self.count("dropped", d.code)
                self.outcomes[key(name) or name] = {"name": name, "status": "dropped", "reason": d.detail,
                                                    "spec": raw if isinstance(raw, dict) else None}
                self.log("DROPPED", f"{name!r} (push): {d.detail}")
                continue
            if stripped:
                notes.append("stripped claimed aliases: " + ", ".join(stripped))
            self.push_order[-1] = key(spec["name"])
            self.push_notes[key(spec["name"])] = notes
            self.claim(spec, theme, "queued")
            self.state["queue"].append({"spec": spec, "theme": theme, "batch": None, "notes": notes})
            queued += 1
        self.save()
        self.log("PUSH", f"{len(items)} specs from {path}: {queued} queued, {len(items) - queued} dropped")
        code = self.run()
        print(f"\nPush results ({len(self.push_order)} specs from {path}):")
        records = []
        for i, k in enumerate(self.push_order, 1):
            o = self.outcomes.get(k) or {"name": k, "status": "unfinished (still queued or pending; rerun to resume)"}
            line = f"{i:>3}. {o['name'][:32]:<32} {o['status'].upper():<9}"
            if o.get("job"):
                line += f" job={o['job']}"
            if o["status"] == "kept":
                line += (f" move={o.get('move_id')} motion={o.get('motion_id')} stability={fmt(o.get('stability'))}"
                         f" originality={fmt(o.get('originality'))}" + (" (reused motion)" if o.get("reused") else ""))
            elif o.get("reason"):
                line += f" {short(o['reason'], 120)}"
            print(line)
            for n in self.push_notes.get(k) or []:
                print(f"     note: {n}")
            records.append(push_record(o, self.push_notes.get(k)))
        self.write_push_results(path, records)
        return code

    def write_push_results(self, path, records):
        """The push results as a batch file for the client's motion viewer (client/viewer.html):
        drop it on the page to step through every kept move next to a standing opponent."""
        if not records:
            return
        out = self.args.out or os.path.join(BATCHES_DIR, f"push-{utc_stamp()}.json")
        try:
            write_json_atomic(out, {"created_at": utc_iso(), "pushed": path, "server": self.args.server,
                                    "prompt_version": P.PROMPT_VERSION, "records": records})
        except OSError as e:
            self.log("ERROR", f"could not write {out}: {e}")
            return
        kept = sum(1 for r in records if r.get("move"))
        print(f"\nWrote {out}: drop it on the client's motion viewer (client/viewer.html) to watch the {kept} kept moves.")
        self.log("PUSH", f"wrote {out} ({kept} kept moves, for the motion viewer)")

    def run_dry(self):
        target = self.args.batches or 1
        failures = 0
        self.preflight()
        while not self.stop_signal and self.batches_done < target and not self.llm_fatal:
            if self.fetch is None:
                if time.time() < self.llm_next_ok:
                    time.sleep(0.2)
                    continue
                try:
                    self.start_fetch()
                except LLMError as e:
                    self.on_llm_error(e, {"batch": self.state["batch_index"], "theme": "?", "size": self.batch_size()})
                    continue
            if self.fetch.is_alive():
                time.sleep(0.2)
                continue
            before = self.batches_done
            self.finish_fetch()
            if self.batches_done == before:
                failures += 1
                if failures >= 6 and not self.llm_fatal:
                    self.log("ERROR", "dry run: giving up after 6 failed Claude calls")
                    break
        if self.llm_fatal:
            return 3
        if not self.dry_batches:
            self.log("DRYRUN", "no batch finished; nothing written")
            return 0 if self.stop_signal else 1
        self.write_dry()
        return 0

    def write_dry(self):
        out = self.args.out or os.path.join(DRYRUN_DIR, f"dryrun-{utc_stamp()}.json")
        specs = []
        for it in self.dry_specs:
            s = dict(it["spec"])
            mid, score, other = self.index.best(s["kimodo_prompt"])
            it["reuse"] = f"motion {mid} (similarity {score:.2f} to {other!r})" if mid else None
            s["theme"] = it["theme"]
            s["notes"] = it["notes"]
            specs.append(s)
        doc = {"created_at": utc_iso(), "prompt_version": P.PROMPT_VERSION, "model": self.args.model,
               "effort": self.args.effort, "fake_llm": bool(self.args.fake_llm), "library": self.library_desc(),
               "batches": self.dry_batches, "specs": specs, "dropped": self.dry_drops}
        write_json_atomic(out, doc)
        latest = os.path.join(DRYRUN_DIR, "latest.json")
        if os.path.abspath(out) != os.path.abspath(latest):
            write_json_atomic(latest, doc)
        print_table(self.dry_specs, self.dry_drops, self.dry_batches)
        print(f"\nWrote {out}" + (f" and {latest}" if os.path.abspath(out) != os.path.abspath(latest) else ""))
        rel = os.path.relpath(out, HERE)
        print(f"Push them once the server is up:  ./run.sh --push {out if rel.startswith('..') else rel} --server <url>")
        self.log("DRYRUN", f"wrote {out}: {len(self.dry_specs)} specs, {len(self.dry_drops)} dropped "
                           f"(prompt {P.PROMPT_VERSION})")


def push_record(o, notes=None):
    """One record of a push results file, in the shape client/src/viewer.ts reads ({spec, move})."""
    rec = {"spec": o.get("spec"), "status": o["status"], "job": o.get("job"), "notes": notes or [],
           "reason": o.get("reason"), "move": None}
    if o["status"] == "kept":
        rec["move"] = {"id": o.get("move_id"), "motion_id": o.get("motion_id"), "hit_frame": o.get("hit_frame"),
                       "stability": o.get("stability"), "originality": o.get("originality")}
    return rec


def print_table(items, drops, batches):
    print()
    for b in batches:
        info = b.get("llm") or {}
        print(f"Batch #{b['batch']} theme {b['theme']!r}: asked {b['asked']}, got {b['got']}, kept {b['kept']}, "
              f"dropped {b['dropped']}  ({info.get('model')}, {info.get('seconds')}s, request {info.get('request_id')})")
    print(f"\n{'#':>3}  {'NAME':<30} {'TYPE':<9} {'KIND':<10} {'EFFECT':<14} {'JOINT':<6} PWR  DUR")
    for i, it in enumerate(items, 1):
        s = it["spec"]
        print(f"{i:>3}. {s['name']:<30} {s['type']:<9} {s['kind']:<10} {s['effect']:<14} {s['hit_joint']:<6} "
              f"{s['power']:<4} {s['duration']:.2f}s")
        print(f"     prompt : {s['kimodo_prompt']}")
        print(f"     aliases: {', '.join(s['aliases'])}")
        if it.get("reuse"):
            print(f"     reuse  : {it['reuse']}")
        for n in it.get("notes") or []:
            print(f"     note   : {n}")
    if drops:
        print(f"\nDropped ({len(drops)}):")
        for i, d in enumerate(drops, 1):
            print(f"{i:>3}. {d['name'][:30]:<30} [{d['code']}] {d['reason']}")
    specs = [it["spec"] for it in items]
    asked_k, asked_p = Counter(), Counter()
    for b in batches:
        asked_k.update(b.get("kinds_asked") or {})
        asked_p.update({int(k): v for k, v in (b.get("powers_asked") or {}).items()})
    kinds, powers, types = Counter(s["kind"] for s in specs), Counter(s["power"] for s in specs), Counter(s["type"] for s in specs)
    print("\nKinds (kept/asked): " + ", ".join(f"{k} {kinds[k]}/{asked_k[k]}" for k in P.KIND_WEIGHTS))
    print("Power (kept/asked): " + ", ".join(f"{p}: {powers[p]}/{asked_p[p]}" for p in (1, 2, 3)))
    print("Types: " + ", ".join(f"{t} {types[t]}" for t in TYPES))


# --------------------------------------------------------------------------- CLI

def resolve_theme(ap, name):
    if not name:
        return None
    n = name.strip().lower()
    exact = [t for t in P.THEMES if t == n]
    hits = exact or [t for t in P.THEMES if t.startswith(n)] or [t for t in P.THEMES if n in t]
    if len(hits) != 1:
        ap.error(f"--theme {name!r} matches {len(hits)} themes; pick one of: " + "; ".join(P.THEMES))
    return hits[0]


def parse_args(argv=None):
    # allow_abbrev=False: run_forever.sh refuses the one-shot flags by their full names, so an
    # abbreviation like --dry would slip past it and repeat a paid dry run every 10 s all night.
    ap = argparse.ArgumentParser(
        description="Overnight Library Builder: asks Claude for move specs, validates and dedupes them, and "
                    "generates them on the game server. See README.md.", allow_abbrev=False)
    ap.add_argument("--batches", type=int, default=0,
                    help="Claude batches to request this run; 0 = forever (default). A dry run treats 0 as 1.")
    ap.add_argument("--batch-size", type=int, default=50, help="specs per Claude call (default 50)")
    ap.add_argument("--dry-run", action="store_true",
                    help="post nothing: validate and dedupe (against the server's library when it answers), write "
                         "the specs and the drop report to --out and print every spec")
    ap.add_argument("--out", help="dry run output file (default agent/dryrun/dryrun-<UTC>.json; always also "
                                  "copied to agent/dryrun/latest.json); with --push, the results file for the "
                                  "client's motion viewer (default agent/batches/push-<UTC>.json)")
    ap.add_argument("--push", metavar="FILE",
                    help="POST the specs of a dry run JSON to /generate without calling Claude, then wait for them")
    ap.add_argument("--theme", help="force one theme (full name or a unique prefix, e.g. 'winter')")
    ap.add_argument("--server", default=os.environ.get("SERVER_URL", "http://localhost:8000"),
                    help="game server URL (default $SERVER_URL or http://localhost:8000)")
    ap.add_argument("--library", default=None,
                    help="the server's moves.jsonl, read only, used only when GET /library/moves fails (default "
                         "$LIBRARY_DIR/moves.jsonl or ../library/moves.jsonl, and then only for a server on this machine)")
    ap.add_argument("--state", default=DEFAULT_STATE, help="state file (default agent/state.json)")
    ap.add_argument("--log", default=DEFAULT_LOG, help="log file (default agent/log.txt)")
    ap.add_argument("--max-inflight", type=int, default=8, help="jobs submitted but unfinished at once (default 8)")
    ap.add_argument("--poll", type=float, default=1.0, help="seconds between polls of one job (default 1)")
    ap.add_argument("--fake-llm", action="store_true", help="canned specs from fake_specs.json, no API key needed")
    ap.add_argument("--no-fallbacks", action="store_true", help="do not send the server-side refusal fallbacks beta")
    ap.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--model", default="claude-opus-5-5")
    args = ap.parse_args(argv)
    if args.batch_size < 1 or args.max_inflight < 1 or args.poll <= 0 or args.batches < 0:
        ap.error("--batch-size and --max-inflight must be >= 1, --poll > 0, --batches >= 0")
    if args.dry_run and args.push:
        ap.error("--dry-run and --push don't mix: dry run first, then --push its file")
    args.theme = resolve_theme(ap, args.theme)
    args.library_explicit = bool(args.library)
    args.library = args.library or DEFAULT_LIBRARY
    for attr in ("library", "state", "log", "out", "push"):
        if getattr(args, attr):
            setattr(args, attr, os.path.abspath(getattr(args, attr)))
    return args


def install_signals(agent):
    def handler(signum, frame):
        if agent.stop_signal:  # second signal: save and leave right now
            try:
                agent.save()
            finally:
                os._exit(0)
        agent.stop_signal = signal.Signals(signum).name

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), handler)


def main(argv=None):
    args = parse_args(argv)
    log = Log(args.log)
    _lock = None if args.dry_run else acquire_lock(args.state)  # noqa: F841 (held until exit)
    agent = Agent(args, log)
    install_signals(agent)
    try:
        if args.dry_run:
            return agent.run_dry()
        if args.push:
            return agent.run_push()
        return agent.run()
    except Exception as e:  # last resort: log, save, let run_forever.sh restart us
        log("CRASH", f"{type(e).__name__}: {e} (traceback in the log file)")
        log.traceback()
        agent.save()
        return 1


if __name__ == "__main__":
    sys.exit(main())
