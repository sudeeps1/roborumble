"""Live wildcard specs: a shout that matched nothing becomes a new move.

With Claude credentials, Claude (claude-opus-5-5, effort low) writes the spec using the Library Builder's
own prompt, schema and validation from agent/specs.py, so live moves follow the same rules as overnight
ones. Without credentials, or if Claude is slow or its spec fails validation, keywords pick the type and
kind and a plain body prompt from a fixed list. Those prompts usually already have a motion, so the
fallback plays almost instantly.
"""
from __future__ import annotations

import os
import re
import sys
import traceback
from typing import Any

from . import config

sys.path.insert(0, str(config.ROOT / "agent"))
try:
    import specs as agent_specs  # agent/specs.py
except Exception as e:  # pydantic missing etc.
    print(f"wildcard: agent/specs.py not importable ({e}); keyword specs only")
    agent_specs = None

_client = None


usage = {"claude_calls": 0}


def claude_enabled() -> bool:
    if config.CLAUDE == "off" or agent_specs is None or usage["claude_calls"] >= config.MAX_CLAUDE_CALLS:
        return False
    if config.CLAUDE == "on":
        return True
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic()
    return _client


USER = """A player just shouted "{text}" in the middle of a fight, and no move in the library matched.
Write exactly 1 move for it. Its name is what they shouted, tidied into a short spell-like title that keeps
their words, so it feels like their invention. Aliases include their exact words. Duration 1.0 to 1.4 s."""


def claude_spec(text: str) -> dict[str, Any] | None:
    usage["claude_calls"] += 1
    try:
        msg = _get_client().with_options(timeout=12.0, max_retries=0).beta.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=4000,
            system=[{"type": "text", "text": agent_specs.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": USER.format(text=text[:120])}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": agent_specs.SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if msg.stop_reason in ("refusal", "max_tokens"):
            print(f"wildcard: Claude stop_reason={msg.stop_reason}")
            return None
        import json

        data = json.loads("".join(b.text for b in msg.content if getattr(b, "type", None) == "text"))
        raw = (data.get("moves") or [None])[0]
        spec, why = agent_specs.validate(raw) if raw else (None, "no move")
        if not spec:
            print(f"wildcard: Claude spec dropped: {why}")
        return spec
    except Exception:
        traceback.print_exc()
        return None


# ---------- keyword fallback ----------
TYPE_WORDS = [
    ("fire", r"fire|flame|burn|ember|blaze|dragon|hearth|cinder|lava|sun|pumpkin|cauldron"),
    ("ice", r"ice|frost|snow|freez|winter|cold|blizzard|icicle|glacier"),
    ("lightning", r"lightning|thunder|storm|spark|zap|shock|bolt|electric|wisp"),
    ("shadow", r"shadow|dark|night|moon|ghost|wolf|bat|curse|crow|raven|void|mirror"),
]
KIND_WORDS = [
    ("defend", r"block|shield|guard|ward|duck|protect|parry|wall|barrier"),
    ("projectile", r"ball|throw|blast|shoot|orb|beam|fling|cannon|volley|spit|breath"),
    ("strike", r"rain|meteor|sky|summon|call|bolt from|smite|comet|avalanche"),
    ("shockwave", r"stomp|quake|spin|tornado|wave|howl|roar|slam|smash|pound|crash|shatter|ground|whirl|pirouette"),
]
EFFECT = {"physical": "thorn_burst", "fire": "ember_orb", "ice": "frost_crystals", "lightning": "wisp_bolt", "shadow": "moon_smoke"}
# Plain prompts Kimodo handles (they also appear in the mock library, so they often reuse a motion).
PROMPTS = {
    ("melee", "r_hand"): "a person steps forward and throws a straight right punch at chest height",
    ("melee", "r_foot"): "a person lifts the right knee and snaps a front kick forward",
    ("projectile", "r_hand"): "a person winds up and throws a ball overhand with the right arm",
    ("strike", "r_hand"): "a person raises the right fist overhead and slams it down in front",
    ("shockwave", "r_foot"): "a person lifts the right knee high and stomps the foot down hard",
    ("shockwave", "r_hand"): "a person spins in place once with both arms swinging out wide",
    ("defend", "chest"): "a person raises both forearms in front of the face to guard",
}


def keyword_spec(text: str) -> dict[str, Any]:
    t = text.lower()
    mtype = next((ty for ty, rx in TYPE_WORDS if re.search(rx, t)), "physical")
    kind = next((k for k, rx in KIND_WORDS if re.search(rx, t)), "melee")
    leg = bool(re.search(r"kick|knee|stomp|leg|foot|sweep", t))
    hit = "chest" if kind == "defend" else ("r_foot" if leg or kind == "shockwave" and "stomp" in t else "r_hand")
    prompt = PROMPTS.get((kind, hit)) or PROMPTS[("melee", "r_foot" if leg else "r_hand")]
    name = " ".join(w.capitalize() for w in re.sub(r"[^a-zA-Z' ]+", " ", text).split()[:5]) or "Wild Spell"
    return {
        "name": name, "aliases": [name.lower(), text.lower().strip()[:40]], "type": mtype, "kind": kind,
        "effect": "shockwave" if kind == "shockwave" else ("earth_wall" if re.search(r"wall|earth|stone|rock", t) else "fairy_dust") if kind == "defend" else EFFECT[mtype], "kimodo_prompt": prompt, "hit_joint": hit, "duration": 1.2, "power": 2,
    }


def guess(text: str) -> dict[str, Any]:
    s = keyword_spec(text)
    return {"name": s["name"], "type": s["type"]}
