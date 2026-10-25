"""Every setting, from environment variables. The README lists them."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


LIBRARY_DIR = Path(_env("LIBRARY_DIR", str(ROOT / "library")))

# "mock" makes fake motions on any laptop; "kimodo" loads the real model on the GPU box.
ENGINE = _env("ENGINE", "mock")
KIMODO_MODEL = _env("KIMODO_MODEL", "Kimodo-G1-RP-v1")
DIFFUSION_STEPS = int(_env("DIFFUSION_STEPS", "50"))          # overnight / agent jobs
LIVE_DIFFUSION_STEPS = int(_env("LIVE_DIFFUSION_STEPS", "30"))  # live wildcards and Forge: speed first
BATCH_SIZE = int(_env("BATCH_SIZE", "8"))                     # agent prompts per Kimodo call
FPS = 30
# Clips under 2 s are untested on G1 (docs/kimodo-g1.md). If short clips look bad, set this to e.g. 2.0:
# every clip is generated at least this long, and the move's duration grows to match.
MIN_GEN_SECONDS = float(_env("MIN_GEN_SECONDS", "0"))

MATCH_THRESHOLD = float(_env("MATCH_THRESHOLD", "0.5"))
SIGNATURE_THRESHOLD = float(_env("SIGNATURE_THRESHOLD", "0.4"))
EMBEDDINGS = _env("EMBEDDINGS", "auto")  # auto | off

# Speech to text for POST /voice: "muse" (Meta Muse Voice Transcribe), "whisper" (local), or "none"
# (phones send their own transcript).
STT = _env("STT", "none")
MUSE_API_KEY = _env("MUSE_API_KEY", "")
MUSE_URL = _env("MUSE_URL", "")
WHISPER_MODEL = _env("WHISPER_MODEL", "small.en")

# Claude for live wildcard specs and the narrator. Off without credentials; keyword fallbacks take over.
CLAUDE = _env("CLAUDE", "auto")  # auto | off
CLAUDE_MODEL = "claude-opus-5-5"

# Static apps served by this process (Caddy can serve them instead in production).
CLIENT_DIST = Path(_env("CLIENT_DIST", str(ROOT / "client" / "dist")))
PHONE_DIR = Path(_env("PHONE_DIR", str(ROOT / "phone")))  # plain HTML/JS, no build step
