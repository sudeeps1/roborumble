"""Speech to text for POST /voice.

STT=muse  Meta Muse Voice Transcribe, file endpoint (POST https://api.meta.ai/v1/asr/transcribe, Bearer
          auth, multipart "request" JSON + "audio" WAV, mono 16-bit PCM at 16 or 24 kHz). Tested live:
          a 0.56 s "uppercut" WAV came back as "uppercut.".
STT=whisper  faster-whisper on the GPU box.
STT=none  the phone sends its own transcript (typed or browser speech recognition).

Phones should send WAV (mono, 16 kHz, 16-bit). Anything else is converted with ffmpeg when it's installed.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from typing import Any

from . import config

MUSE_FILE_FIELD = os.environ.get("MUSE_FILE_FIELD", "audio")
MUSE_MODEL = "muse-voice-transcribe-1.0"
_whisper = None


class SttError(Exception):
    pass


def is_wav(data: bytes) -> bool:
    return data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def to_wav16k(data: bytes) -> bytes:
    if is_wav(data):
        return data
    if not shutil.which("ffmpeg"):
        raise SttError("audio is not WAV and ffmpeg is not installed; send mono 16 kHz 16-bit WAV")
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in"), os.path.join(d, "out.wav")
        with open(src, "wb") as f:
            f.write(data)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", dst],
                       check=True, timeout=10)
        with open(dst, "rb") as f:
            return f.read()


usage = {"stt_seconds": 0.0}


def stt_available() -> bool:
    return config.STT != "none" and usage["stt_seconds"] < config.MAX_STT_MINUTES * 60


def transcribe(data: bytes, hint_words: list[str] | None = None) -> str:
    if config.STT == "muse":
        if not stt_available():
            raise SttError("voice budget used up for this server run; phones switch to their own speech recognition")
        wav = to_wav16k(data)
        if len(wav) > 16000 * 2 * 6 + 44:  # longer than 6 s is noise, not a spell: don't pay for it
            raise SttError("clip too long")
        usage["stt_seconds"] += (len(wav) - 44) / (16000 * 2)
        return _muse(wav)
    if config.STT == "whisper":
        return _whisper_text(data, hint_words)
    raise SttError("STT is off on this server; send `transcript` with the request")


def _muse(wav: bytes) -> str:
    import httpx

    if not config.MUSE_API_KEY:
        raise SttError("MUSE_API_KEY is not set")
    url = config.MUSE_URL or "https://api.meta.ai/v1/asr/transcribe"
    # Verified against the live API: a JSON "request" part (model + audioEncoding) and an "audio" part.
    # The response is {"sessionId", "transcript": "uppercut.", "audioDurationMs", "turns"}.
    request = json.dumps({"model": MUSE_MODEL, "audioEncoding": "WAV"})
    r = httpx.post(url, headers={"Authorization": f"Bearer {config.MUSE_API_KEY}"},
                   files={"request": (None, request, "application/json"), MUSE_FILE_FIELD: ("shout.wav", wav, "audio/wav")},
                   timeout=10.0)
    if r.status_code >= 400:
        raise SttError(f"Muse {r.status_code}: {r.text[:200]}")
    return _muse_text(r.json())


def _muse_text(body: Any) -> str:
    """Pull the transcript out of whatever shape comes back: text, transcript, or a list of turns."""
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        for k in ("text", "transcript"):
            if isinstance(body.get(k), str):
                return body[k]
        for k in ("turns", "segments", "results", "utterances"):
            if isinstance(body.get(k), list):
                return " ".join(_muse_text(t) for t in body[k]).strip()
        if isinstance(body.get("data"), (dict, list)):
            return _muse_text(body["data"])
    if isinstance(body, list):
        return " ".join(_muse_text(t) for t in body).strip()
    return ""


def _whisper_text(data: bytes, hint_words: list[str] | None) -> str:
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel(config.WHISPER_MODEL, device="auto", compute_type="auto")
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(data)
        f.flush()
        prompt = ", ".join(hint_words[:60]) if hint_words else None
        segs, _ = _whisper.transcribe(f.name, language="en", beam_size=1, initial_prompt=prompt, vad_filter=True)
        return " ".join(s.text for s in segs).strip()
