"""Infinite Fighter game server. contract/api.md and contract/ws.md describe every endpoint and message.

Run: ./server/run.sh  (mock engine on any laptop; ENGINE=kimodo on the GPU box)
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import numpy as np

from . import config, forge, voice, wildcard
from .engine import make_engine
from .g1 import joint_limits
from .jobs import AGENT, LIVE, Job, JobQueue
from .library import MOVE_TYPES, Library
from .matcher import Matcher
from .narrator import Narrator
from .rooms import Hub

KINDS = {"melee", "projectile", "strike", "shockwave", "defend"}
EFFECTS = {"ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave", "none"}
HIT_JOINTS = {"head", "chest", "l_hand", "r_hand", "l_foot", "r_foot"}
IDLE_PROMPT = "a person stands in a relaxed fighting stance and sways gently while breathing"

engine = make_engine()
library = Library()
matcher = Matcher()
for m in library.all():
    matcher.add(m["id"], m["name"], m.get("aliases") or [])
jobs = JobQueue(engine, library, matcher, joint_limits())
hub = Hub()
narrator = Narrator(lambda code, text: hub.push_game_threadsafe(code, {"type": "narrate", "text": text}))
hub.on_event = narrator.on_event
hub.on_state = narrator.on_state
started = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI):
    hub.loop = asyncio.get_running_loop()
    if not library.has_motion("mo_idle"):
        jobs.submit({"name": "idle", "kimodo_prompt": IDLE_PROMPT, "duration": 3.0, "_motion_only": "mo_idle"}, LIVE)
    yield


app = FastAPI(title="Infinite Fighter server", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
# Every route is served twice: bare (Vite's dev proxy strips /api) and under /api (the built client
# served by this process, or Caddy without a rewrite).
api = APIRouter()


# ---------- library and jobs ----------
@api.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True, "engine": engine.name, "model": config.KIMODO_MODEL if engine.name == "kimodo" else "mock",
        "load_ms": round(getattr(engine, "load_ms", 0)), "last_generation_ms": round(engine.last_ms),
        "queue": jobs.queue_length(), "jobs": jobs.counts, "library": library.stats()["total"],
        "idle_ready": library.has_motion("mo_idle"), "matcher": matcher.backend,
        "stt": config.STT if voice.stt_available() else "none", "claude": wildcard.claude_enabled(),
        "spend": {"claude_calls": wildcard.usage["claude_calls"], "claude_cap": config.MAX_CLAUDE_CALLS,
                  "stt_minutes": round(voice.usage["stt_seconds"] / 60, 2), "stt_cap_minutes": config.MAX_STT_MINUTES},
        "uptime_s": round(time.time() - started),
        "steps": {"agent": config.DIFFUSION_STEPS, "live": config.LIVE_DIFFUSION_STEPS},
    }


@api.get("/idle")
def idle():
    return _motion_file("mo_idle")


@api.get("/motion/{motion_id}")
def motion(motion_id: str):
    return _motion_file(motion_id)


def _motion_file(motion_id: str):
    path = library.motion_path(motion_id)
    if not path:
        raise HTTPException(404, f"no motion {motion_id}" + (" (idle still generating)" if motion_id == "mo_idle" else ""))
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@api.get("/library/stats")
def stats():
    return library.stats()


@api.get("/library/moves")
def library_moves():
    return [{k: m.get(k) for k in ("id", "name", "aliases", "kimodo_prompt", "motion_id", "type", "kind", "source", "creator")}
            for m in library.all()]


@api.get("/leaderboard")
def leaderboard():
    return library.leaderboard()


@api.get("/move/{move_id}")
def get_move(move_id: str):
    m = library.get(move_id)
    if not m:
        raise HTTPException(404, f"no move {move_id}")
    return m


@api.get("/deck")
def deck(nickname: str):
    """A player's own moves (Forge and live), for the phone's move grid."""
    mine = [m for m in library.all() if m.get("creator") == nickname]
    mine.sort(key=lambda m: m.get("created_at") or 0, reverse=True)
    return {"nickname": nickname, "moves": mine}


@api.post("/generate")
async def generate(request: Request):
    try:
        spec = await request.json()
    except Exception:
        raise HTTPException(400, "body must be a JSON move spec")
    spec = _clean_spec(spec)
    job = jobs.submit(spec, AGENT)
    return {"job": job.id}


@api.get("/job/{job_id}")
def job(job_id: str):
    j = jobs.jobs.get(job_id)
    if not j:
        raise HTTPException(404, f"no job {job_id}")
    return j.public()


def _clean_spec(raw: Any, source: str = "agent") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(400, "spec must be an object")
    name = str(raw.get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(400, "spec needs a name")
    motion_id = raw.get("motion_id")
    prompt = " ".join(str(raw.get("kimodo_prompt") or "").replace(".", " ").split())
    if not prompt and not motion_id:
        raise HTTPException(400, "spec needs kimodo_prompt or motion_id")
    if motion_id and not library.has_motion(str(motion_id)):
        raise HTTPException(400, f"unknown motion_id {motion_id}")
    mtype = raw.get("type") if raw.get("type") in MOVE_TYPES else "physical"
    try:
        power = min(3, max(1, int(raw.get("power") or 2)))
        duration = min(10.0, max(0.5, float(raw.get("duration") or 1.2)))
    except (TypeError, ValueError):
        raise HTTPException(400, "power and duration must be numbers")
    aliases = [str(a).lower().strip()[:40] for a in (raw.get("aliases") or []) if str(a).strip()]
    return {
        "name": name, "aliases": list(dict.fromkeys([name.lower(), *aliases]))[:8], "type": mtype,
        "kind": raw.get("kind") if raw.get("kind") in KINDS else "melee",
        "effect": raw.get("effect") if raw.get("effect") in EFFECTS else wildcard.EFFECT[mtype],
        "kimodo_prompt": prompt, "hit_joint": raw.get("hit_joint") if raw.get("hit_joint") in HIT_JOINTS else "r_hand",
        "duration": duration, "power": power,
        "stability": _num01(raw.get("stability")), "originality": _num01(raw.get("originality")),
        "motion_id": motion_id, "source": raw.get("source") if raw.get("source") in ("agent", "forge", "live") else source,
        "creator": (str(raw["creator"])[:16] if raw.get("creator") else None),
    }


def _num01(v: Any) -> float | None:
    try:
        return None if v is None else round(min(1.0, max(0.0, float(v))), 2)
    except (TypeError, ValueError):
        return None


# ---------- shouts: match, play, or a live wildcard ----------
def _motion_json(motion_id: str) -> Any:
    import json

    path = library.motion_path(motion_id)
    return json.loads(path.read_text()) if path else None


def _own_forge_ids(nickname: str | None) -> set[str]:
    if not nickname:
        return set()
    return {m["id"] for m in library.all() if m.get("creator") == nickname and m.get("source") == "forge"}


async def shout(code: str, player: int, text: str, loudness: float) -> dict[str, Any]:
    room = hub.room(code)
    nickname = room.nickname(player)
    own = _own_forge_ids(nickname)
    signature = False
    move_id, score = matcher.best(text, own) if own else (None, 0.0)
    if move_id and score >= config.SIGNATURE_THRESHOLD:
        signature = True
    else:
        move_id, score = matcher.best(text)
        if not (move_id and score >= config.MATCH_THRESHOLD):
            move_id = None
    if move_id:
        move = library.get(move_id)
        move["signature"] = signature
        library.bump(move_id)
        move["uses"] += 1
        await hub.send_game(code, {"type": "play", "player": player, "move": move, "loudness": loudness,
                                   "transcript": text, "motion": _motion_json(move["motion_id"])})
        narrator.on_move(code, player, move, nickname)
        return {"result": "play", "move": move, "score": round(score, 3), "signature": signature}
    return await _wildcard(code, player, text, loudness, nickname)


async def _wildcard(code: str, player: int, text: str, loudness: float, nickname: str | None) -> dict[str, Any]:
    job = jobs.reserve(LIVE)
    charged = asyncio.Event()

    async def send_ready(j: Job) -> None:
        await charged.wait()  # `charge` always goes out before `ready` (review finding 14)
        move = j.move if j.status == "done" else _fallback_move(text)
        if move is None:
            return
        move = dict(move, signature=False)
        library.bump(move["id"])
        await hub.send_game(code, {"type": "ready", "player": player, "job": j.id, "move": move, "loudness": loudness,
                                   "motion": _motion_json(move["motion_id"])})
        narrator.on_move(code, player, move, nickname)

    def on_done(j: Job) -> None:
        if hub.loop:
            asyncio.run_coroutine_threadsafe(send_ready(j), hub.loop)

    await hub.send_game(code, {"type": "charge", "player": player, "job": job.id, "guess": wildcard.guess(text),
                               "transcript": text})
    charged.set()
    spec = await asyncio.to_thread(wildcard.claude_spec, text) if wildcard.claude_enabled() else None
    spec = _clean_spec(spec or wildcard.keyword_spec(text), "live")
    spec.update(source="live", creator=nickname, aliases=list(dict.fromkeys([*spec["aliases"], text.lower().strip()[:40]])))
    jobs.start(job, spec, on_done=on_done)
    return {"result": "charge", "job": job.id, "guess": wildcard.guess(text)}


def _fallback_move(text: str) -> dict[str, Any] | None:
    """A rejected wildcard still does something: the closest library move, whatever the score."""
    move_id, _ = matcher.best(text)
    if not move_id:
        everything = library.all()
        if not everything:
            return None
        move_id = random.choice(everything)["id"]
    return library.get(move_id)


@api.post("/match")
async def match(request: Request):
    """Typed backup and debugging. With room + player, it acts exactly like a shout."""
    body = await request.json()
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    if body.get("room") and body.get("player") in (1, 2):
        return await shout(str(body["room"]), int(body["player"]), text, float(body.get("loudness") or 0.7))
    move_id, score = matcher.best(text)
    hit = bool(move_id and score >= config.MATCH_THRESHOLD)
    return {"hit": hit, "score": round(score, 3), "move": library.get(move_id) if hit else None,
            "guess": None if hit else wildcard.guess(text)}


@api.post("/voice")
async def voice_shout(room: str = Form(...), player: int = Form(...), loudness: float = Form(0.7),
                      transcript: str | None = Form(None), audio: UploadFile | None = File(None)):
    if player not in (1, 2):
        raise HTTPException(400, "player must be 1 or 2")
    text = (transcript or "").strip()
    stt_ms = 0
    if not text:
        if audio is None:
            raise HTTPException(400, "send audio or transcript")
        data = await audio.read()
        t0 = time.time()
        try:
            text = (await asyncio.to_thread(voice.transcribe, data)).strip()
        except voice.SttError as e:
            raise HTTPException(503, str(e))
        stt_ms = round((time.time() - t0) * 1000)
    if len(text) < 3:  # a cough or a stray syllable from the always-on mic
        return JSONResponse({"result": "silence", "transcript": text}, status_code=200)
    out = await shout(room, player, text, max(0.0, min(1.0, loudness)))
    return {"transcript": text, "stt_ms": stt_ms, **out}


# ---------- Forge: a move the player acted out ----------
forge_jobs: dict[str, dict[str, Any]] = {}


@api.post("/forge")
async def forge_start(request: Request):
    body = await request.json()
    nickname = str(body.get("nickname") or "").strip()[:16] or "Player"
    name = str(body.get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(400, "name your spell")
    try:
        p = await asyncio.to_thread(forge.plan, body.get("landmarks") or [], float(body.get("fps") or 30),
                                    name, float(body.get("wild") if body.get("wild") is not None else 0.5))
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"couldn't read the recording: {e}")
    constraints = None
    if p["constraints_rows"] is not None:
        constraints = await asyncio.to_thread(engine.pose_constraints, p["constraints_rows"], p["frame_indices"])
    spec = _clean_spec(p["spec"], "forge")
    spec.update(source="forge", creator=nickname)
    job = jobs.reserve(LIVE)
    forge_jobs[job.id] = {"nickname": nickname, "name": name, "landmarks": body.get("landmarks"), "fps": body.get("fps"),
                          "keyframes": p["frame_indices"], "fit": p["fit"], "kept": None}
    jobs.start(job, spec, constraints=constraints, cfg_weight=p["cfg"], keep=False)
    return {"job": job.id, "fit": p["fit"], "prompt": spec["kimodo_prompt"], "keyframes": p["frame_indices"]}


@api.get("/forge/{job_id}")
def forge_status(job_id: str):
    j = jobs.jobs.get(job_id)
    if not j or job_id not in forge_jobs:
        raise HTTPException(404, f"no forge job {job_id}")
    if j.status != "done":
        return j.public()
    preview = None
    if j.preview is not None and j.preview.joints is not None:
        preview = np.round(j.preview.joints[:, :, :2], 3).tolist()  # Kimodo frame: x = robot's left, y = up
    return {"status": "done", "card": j.move, "preview": preview, "kept": forge_jobs[job_id]["kept"],
            "fit": forge_jobs[job_id]["fit"]}


@api.post("/forge/{job_id}/keep")
def forge_keep(job_id: str):
    j, info = jobs.jobs.get(job_id), forge_jobs.get(job_id)
    if not j or not info or j.status != "done" or j.preview is None:
        raise HTTPException(400, "nothing to keep yet")
    if info["kept"]:
        return library.get(info["kept"])
    motion_id = library.add_motion(j.preview.qpos)
    move = library.add_move(dict(j.move, motion_id=motion_id))
    matcher.add(move["id"], move["name"], move.get("aliases") or [])
    info["kept"] = move["id"]
    out = config.LIBRARY_DIR / "forge" / move["id"]
    out.mkdir(parents=True, exist_ok=True)  # the dataset: real human motion with a text label
    (out / "recording.json").write_text(json.dumps({
        "move_id": move["id"], "name": info["name"], "nickname": info["nickname"], "fps": info["fps"],
        "kimodo_prompt": move["kimodo_prompt"], "keyframes": info["keyframes"], "landmarks": info["landmarks"]}))
    return move


# ---------- rooms ----------
@api.websocket("/room/{code}")
async def room_ws(ws: WebSocket, code: str, role: str = "phone"):
    if role == "game":
        await hub.game_session(ws, code)
    else:
        await hub.phone_session(ws, code)


@api.get("/room/{code}")
def room_info(code: str):
    r = hub.room(code)
    return {"room": r.code, "game_connected": r.game is not None,
            "seats": {p: {"nickname": s.nickname, "character": s.character, "connected": s.ws is not None}
                      for p, s in r.seats.items()}}


app.include_router(api)
app.include_router(api, prefix="/api")

# ---------- static apps (when built) ----------
if config.PHONE_DIR.exists():
    app.mount("/phone", StaticFiles(directory=config.PHONE_DIR, html=True), name="phone")
if config.CLIENT_DIST.exists():
    app.mount("/", StaticFiles(directory=config.CLIENT_DIST, html=True), name="client")
