"""Asks Claude for move specs and validates them (CLAUDE.md "Overnight Library Builder" and "Move spec")."""
from __future__ import annotations

import json
import random
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from state import norm

MODEL = "claude-opus-5-5"

MOVE_TYPES = ["physical", "fire", "ice", "lightning", "shadow"]
KINDS = ["melee", "projectile", "strike", "shockwave", "defend"]
EFFECTS = ["ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave", "none"]
HIT_JOINTS = ["head", "chest", "l_hand", "r_hand", "l_foot", "r_foot"]

# Fairy-tale themes from CLAUDE.md, with plain combat mixed in so common shouts ("uppercut") always hit.
THEMES: list[tuple[str, str]] = [
    ("plain combat", "ordinary punches, kicks, knees, elbows, headbutts, sweeps, blocks and dodges, named the way players shout them: jab, uppercut, roundhouse kick"),
    ("knights and dragons", "armor and shields, lances and sword swings, chivalry, a dragon's tail, wings and breath"),
    ("witches and potions", "cauldrons and stirring, brooms, hexes, bubbling potions, black cats, the hearth fire"),
    ("forest spirits and beasts", "dryads and wisps, stags and bears, boars and owls, thorny vines and roots"),
    ("winter tales", "a snow queen, icicles and blizzards, frozen lakes, sleighs, wolves in the snow"),
    ("plain combat", "ordinary punches, kicks, knees, elbows, headbutts, sweeps, blocks and dodges, named the way players shout them: jab, uppercut, roundhouse kick"),
    ("moonlight and night creatures", "howling wolves, bats and owls, ghosts, starlight and midnight"),
    ("giants and trolls", "huge stomps, boulders and clubs, bridges, earthquakes, clumsy brute strength"),
    ("enchanted household objects", "a dancing broom, a teapot, rolling pins, frying pans, a sneezing armchair; played for laughs, but the motions are still real body moves"),
]

SYSTEM_PROMPT = """You design moves for Infinite Fighter, a fighting game set in a mystical fairy tale. Two enchanted clockwork automatons (Unitree G1 humanoid robots, 1.3 m tall, simulated with real physics) duel inside a glowing fairy ring in a moonlit forest. Players shout a move's name and their robot performs it. Every move is a spec plus a body motion that NVIDIA Kimodo generates from the spec's kimodo_prompt.

Fields of a move spec:
- name: sounds like a spell or a storybook attack. Two to four words, vivid and easy to shout ("Bramble Bash", "Moonlit Howl", "Hearthfire Hurl"). For the plain combat theme, use the ordinary name players will shout ("Uppercut", "Spinning Back Kick").
- aliases: 3 to 5 lowercase phrases a player might actually shout for this move: the lowercase name first, then short variations and plain descriptions (for "Thunder Palm": "thunder palm", "lightning push", "shock palm"). Each alias should point clearly at this move; avoid lone generic words like "attack" or "punch".
- type: physical | fire | ice | lightning | shadow (players see them as Might, Flame, Frost, Storm, Shadow).
- kind: melee (a close hit with a limb) | projectile (something flies from a hand or foot to the opponent) | strike (something falls on the opponent from above, called down by the caster) | shockwave (a burst all around the caster, like a stomp or a ground slam) | defend (block, parry, brace or evade; it never hits).
- effect: the visual the game draws. ember_orb (fire), wisp_bolt (lightning), frost_crystals (ice), moon_smoke (shadow), thorn_burst (physical: thorns and petals), fairy_dust (whimsical sparkles, any type), shockwave (a ground ring, for shockwave moves), none (a plain body hit). Usually the effect that matches the type; none suits plain combat.
- kimodo_prompt: the body motion only. Rules below.
- hit_joint: the body part that delivers the hit: r_hand, l_hand, r_foot, l_foot, head (headbutt) or chest (shoulder or body charge). For a projectile, the hand or foot that throws it; for a strike, the hand that calls it down; for a shockwave, the stomping foot or the hand that slams the ground; for defend, the blocking forearm's hand (l_hand or r_hand) or chest.
- duration: seconds, between 0.8 and 1.5. Quick jabs 0.8 to 1.0, big swings and slams 1.3 to 1.5.
- power: 1 (quick and light), 2 (solid), 3 (huge, slow, risky). Only big committed moves get 3; most moves are 1 or 2.

kimodo_prompt rules. This is the most important field: a bad prompt makes a broken motion.
- Kimodo turns plain English into human motion. It was trained on locomotion, gestures, everyday activities, mimed object interactions, videogame combat, dancing and athletics; anything else gives bad results. It never sees the name, type or effect, and fantasy words make bad motion.
- Start with "a person" (a style word is fine: "an angry person", "a sneaky person", "an old person", "a tired person"). Then say what the body does, in present tense.
- Medium detail, one sentence of about 8 to 20 words: the main action plus a couple of specifics (which side, what height, which direction; forward means toward the opponent). Don't itemize every body part; that is too much for the model.
- One action, or two joined with "then" (one after the other) or "while" (at the same time). Never more.
- Never write a period anywhere in the prompt, not even in a number: each period starts a new motion segment. Use words, not decimals.
- Never use names, magic, elements or creatures. Banned: spell, magic, cast, summon, conjure, enchant, fire, flame, ice, frost, lightning, thunder, storm, shadow, moon, dragon, witch, fairy, energy, beam, blast, orb, glow, aura.
- Translate the fantasy into real movement with common verbs (punch, kick, push, shove, swing, stomp, block, duck, lunge, throw, clap, spin, bow, wave, dance). "Hearthfire Hurl" becomes "a person winds the right arm back and throws forward overhand". "Moonlit Howl" becomes "a person tips the head back with arms spread wide, then pushes both palms forward".
- From a standing fighting stance, staying roughly in place. Small steps are fine; no running, long jumps, flips, cartwheels, rolling, lying down or crawling (travel is clipped to 0.3 m, the robot must stay on its feet, and acrobatics come out badly).
- No props and no other people: Kimodo moves one body. Mime instead ("as if swinging a heavy hammer with both hands").
- Match the spec: the hit_joint does the striking at a sensible height; projectiles throw or push toward the opponent; strikes raise the arms high then bring them down; shockwaves stomp or slam the ground; defends block, parry, brace or duck.
Good: "a person steps forward with the left foot and throws a right uppercut"
Good: "a person crouches low, then springs up and pushes both palms forward at chest height"
Good: "an angry person raises both arms overhead, then swings them down hard in front of the body"
Good: "a person gets into a fighting stance and throws a quick punch forward with the left hand"
Bad: "a person casts a fireball" (magic words). Bad: "the knight swings his flaming sword" (not a person, a prop, an element). Bad: "a person does a backflip and rolls away" (acrobatic, travels). Bad: "a person steps 0.5 m forward" (a period).

Variety matters: mix kinds (about half melee, the rest projectile, strike, shockwave and defend), mix hit joints (not only right hands: kicks, knees, headbutts, both hands), and mix powers. Every move should feel different to perform. All names must be brand new."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "moves": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                    "type": {"type": "string", "enum": MOVE_TYPES},
                    "kind": {"type": "string", "enum": KINDS},
                    "effect": {"type": "string", "enum": EFFECTS},
                    "kimodo_prompt": {"type": "string"},
                    "hit_joint": {"type": "string", "enum": HIT_JOINTS},
                    "duration": {"type": "number"},
                    "power": {"type": "integer", "enum": [1, 2, 3]},
                },
                "required": ["name", "aliases", "type", "kind", "effect", "kimodo_prompt", "hit_joint", "duration", "power"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["moves"],
    "additionalProperties": False,
}


def user_prompt(theme: str, about: str, n: int, thin: list[tuple[str, int]], used_names: list[str]) -> str:
    lines = [f"Theme: {theme} ({about}).", "", f"Write {n} new moves for this theme."]
    if thin:
        k = max(1, round(n * 0.4))
        lines.append(f"The library is short on these types, so make at least {k} of the {n} moves one of them: "
                     + ", ".join(f"{t} ({c} so far)" for t, c in thin) + ".")
    if used_names:
        lines.append("Names already used for this theme (do not reuse them or near-copies): " + "; ".join(used_names[-300:]) + ".")
    return "\n".join(lines)


class ClaudeFailure(Exception):
    """A batch Claude couldn't produce (refusal, truncation, unparseable output). The loop logs it and moves on."""


def ask_claude(client: Any, prompt: str, effort: str = "high") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """One Library Builder call: returns (raw move dicts, usage info).

    Streaming (big max_tokens), structured output via output_config.format, server-side refusal fallbacks
    (fallbacks="default" under the server-side-fallback-2026-07-01 beta). Thinking is always on for this model;
    effort is set explicitly (CLAUDE.md: high for overnight work).
    """
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        msg = stream.get_final_message()

    usage = {
        "model": msg.model,
        "input_tokens": msg.usage.input_tokens,
        "output_tokens": msg.usage.output_tokens,
        "cache_read_input_tokens": getattr(msg.usage, "cache_read_input_tokens", None),
        "request_id": getattr(msg, "_request_id", None),
    }
    # Check stop_reason before reading content (CLAUDE.md "AI agents").
    if msg.stop_reason == "refusal":
        details = getattr(msg, "stop_details", None)
        raise ClaudeFailure(f"refusal ({getattr(details, 'category', None)}): {getattr(details, 'explanation', '')}")
    if msg.stop_reason == "max_tokens":
        raise ClaudeFailure("output hit max_tokens before the JSON finished; try a smaller --batch-size")
    # A mid-stream fallback can split the JSON across text blocks, so join every text block in order.
    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ClaudeFailure(f"unparseable JSON ({e}); first 200 chars: {text[:200]!r}") from None
    moves = data.get("moves") if isinstance(data, dict) else None
    if not isinstance(moves, list):
        raise ClaudeFailure("response had no moves list")
    return moves, usage


# ---------- validation ----------
class SpecModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    aliases: list[str]
    type: Literal["physical", "fire", "ice", "lightning", "shadow"]
    kind: Literal["melee", "projectile", "strike", "shockwave", "defend"]
    effect: Literal["ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave", "none"]
    kimodo_prompt: str
    hit_joint: Literal["head", "chest", "l_hand", "r_hand", "l_foot", "r_foot"]
    duration: float
    power: Literal[1, 2, 3]


# "a person", or a style word first ("an angry person"): Kimodo expects the prompt to start with the subject.
PERSON = re.compile(r"^an? (?:[a-z-]+ ){0,2}person\b", re.I)

# Words that make Kimodo produce bad motion (CLAUDE.md: kimodo_prompt is always a plain body description).
BANNED = re.compile(
    r"\b(spells?|magic\w*|cast(s|ing)?|summon\w*|conjur\w*|enchant\w*|fire\w*|flam\w*|ice|icy|frost\w*|lightning|thunder\w*|storm\w*|"
    r"shadow\w*|moon(?!walk)\w*|dragons?|witch\w*|wizards?|fair(y|ies)|potions?|energy|beams?|blasts?|orbs?|glow\w*|auras?|runes?|curses?|hex(es|ed|ing)?|ghosts?|spirits?|wands?)\b",
    re.I,
)


def validate(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """(clean spec, None) or (None, reason it was dropped)."""
    try:
        s = SpecModel.model_validate(raw)
    except ValidationError as e:
        return None, f"schema: {e.errors()[0]['loc']} {e.errors()[0]['msg']}"
    name = re.sub(r"\s+", " ", s.name).strip()
    if not 2 <= len(name) <= 40 or not norm(name):
        return None, "bad name"
    prompt = re.sub(r"\s+", " ", s.kimodo_prompt).strip().rstrip(".").strip()
    if not PERSON.match(prompt):
        return None, "kimodo_prompt does not start with 'a person'"
    if "." in prompt:  # Kimodo splits prompts on every period, decimals included: each piece gets the full duration
        return None, "kimodo_prompt has a period"
    words = len(prompt.split())
    if not 6 <= words <= 26:
        return None, f"kimodo_prompt has {words} words"
    bad = BANNED.search(prompt)
    if bad:
        return None, f"kimodo_prompt uses '{bad.group(0)}'"
    # The move's own fancy name words must not leak into the prompt (plain combat words like "uppercut" are fine).
    leaked = [w for w in re.findall(r"[A-Za-z']+", name) if len(w) > 3 and w.lower() not in PLAIN_WORDS and re.search(rf"\b{re.escape(w)}\b", prompt, re.I)]
    if leaked:
        return None, f"kimodo_prompt repeats the name ('{leaked[0]}')"

    aliases: list[str] = []
    for a in [name.lower(), *s.aliases]:
        a = re.sub(r"\s+", " ", a.lower()).strip(" .!,")
        if a and len(a) <= 40 and norm(a) and norm(a) not in {norm(x) for x in aliases}:
            aliases.append(a)
    if len(aliases) < 2:
        return None, "fewer than 2 aliases"

    return {
        "name": name,
        "aliases": aliases[:6],
        "type": s.type,
        "kind": s.kind,
        "effect": s.effect,
        "kimodo_prompt": prompt,
        "hit_joint": s.hit_joint,
        "duration": round(min(1.5, max(0.8, s.duration)), 2),
        "power": s.power,
        "source": "agent",
        "creator": None,
        "uses": 0,
    }, None


PLAIN_WORDS = {
    "punch", "kick", "jab", "cross", "hook", "uppercut", "knee", "elbow", "headbutt", "sweep", "block", "dodge", "duck",
    "spinning", "back", "front", "side", "roundhouse", "high", "low", "double", "flying", "palm", "strike", "stomp",
    "slam", "push", "shove", "charge", "shoulder", "body", "chop", "hammer", "fist", "spin", "jump", "step", "parry",
    "guard", "brace", "backfist", "haymaker", "lunge", "throw", "toss", "swing", "smash", "clap", "bash", "with", "the",
    # directions, body parts and plain combat modifiers (review finding 10: "Left Hook", "Head Kick", ...)
    "left", "right", "head", "leg", "legs", "foot", "feet", "hand", "hands", "arm", "arms", "knees", "elbows", "fists",
    "quick", "fast", "straight", "overhand", "snap", "rising", "crescent", "axe", "heel", "spin", "reverse", "lead",
    "rear", "forward", "backward", "jumping", "running", "leaping", "sliding", "low", "both", "twin", "triple",
}


# ---------- offline stand-in for Claude ----------
class FakeClaude:
    """For --offline: plausible specs from templates, including a few bad ones to exercise the checks."""

    PARTS = [
        ("Bramble", "physical", "thorn_burst"), ("Hearthfire", "fire", "ember_orb"), ("Wisp", "lightning", "wisp_bolt"),
        ("Rime", "ice", "frost_crystals"), ("Moonlit", "shadow", "moon_smoke"), ("Pixie", "physical", "fairy_dust"),
    ]
    VERBS = [
        ("Bash", "melee", "r_hand", "a person steps forward and swings the right fist in a wide arc at head height"),
        ("Hurl", "projectile", "r_hand", "a person winds the right arm back behind the head and throws forward overhand"),
        ("Stomp", "shockwave", "r_foot", "a person lifts the right knee high and stomps the foot down hard"),
        ("Crash", "strike", "r_hand", "a person raises both arms high overhead, then swings them down hard in front of the body"),
        ("Guard", "defend", "l_hand", "a person raises both forearms in front of the face and braces with knees bent"),
        ("Kick", "melee", "l_foot", "a person shifts weight back and snaps the left foot forward at chest height"),
    ]

    def __init__(self, seed: int = 1):
        self.rng = random.Random(seed)

    def ask(self, n: int) -> list[dict[str, Any]]:
        out = []
        for i in range(n):
            (adj, typ, eff), (verb, kind, joint, prompt) = self.rng.choice(self.PARTS), self.rng.choice(self.VERBS)
            name = f"{adj} {verb}" if self.rng.random() < 0.6 else f"{adj} {verb} {self.rng.randint(2, 999)}"
            spec = {"name": name, "aliases": [name.lower(), f"{verb.lower()} of {adj.lower()}"], "type": typ, "kind": kind,
                    "effect": "shockwave" if kind == "shockwave" else eff, "kimodo_prompt": prompt, "hit_joint": joint,
                    "duration": round(self.rng.uniform(0.7, 1.6), 2), "power": self.rng.choice([1, 2, 2, 3])}
            if i % 9 == 4:
                spec["kimodo_prompt"] = f"a person casts a {adj.lower()} fireball"  # must be caught by validate()
            out.append(spec)
        return out
