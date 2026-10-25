"""The storybook narrator: one short line per big moment, sent to the game as `narrate` messages.

Template lines (instant and free). Pacing: at most one line every 2.5 s, except KOs, knockdowns, round
starts and match ends, which always speak.
"""
from __future__ import annotations

import random
import time
from typing import Any

CHAR_NAMES = {"bramble": "Sir Bramble", "marigold": "Marigold", "flicker": "Flicker", "rime": "Rime", "hush": "Hush"}
ALWAYS = {"ko", "down", "round_start", "match_end"}
GAP = 2.5

LINES = {
    "round_start": ["Round {round}! The fairy ring glows, and the duel begins anew.",
                    "Once more into the ring, round {round}!", "Round {round}. The forest holds its breath."],
    "hit_clean": ["A clean strike from {a}! The whole forest felt that one.", "And lo, {a} lands it true!",
                  "Right on the mark! {d} reels beneath the moon."],
    "hit_big": ["{a} hits like a falling oak!", "Oh, that one will be sung about, {a}!"],
    "blocked": ["{d} turns it aside!", "A wall of thorns could not have guarded better, {d}."],
    "dodged": ["{d} slips away like mist!", "Nimble as a sprite, {d} dodges!"],
    "down": ["{p} topples into the clover!", "Down goes {p}! Will the automaton rise?"],
    "ko": ["And lo, {p} falls! The tale of this round is written.", "{p}'s runes go dark. It's over!"],
    "round": ["Round to {p}!", "{p} takes the round, and the fireflies cheer."],
    "match_end": ["And so ends the tale. {p} is the champion of the fairy ring!",
                  "Hear ye! {p} wins the duel, and they lived victoriously ever after."],
    "signature": ["{nick}'s own invention, {move}! Straight from their imagination!",
                  "{move}, forged by {nick} themself!"],
    "credit": ["{move}, a spell first dreamed up by {creator}!", "Borrowed magic: {move}, invented by {creator}!"],
    "live": ["A brand-new spell is born: {move}!", "No book holds this one. {move}, conjured on the spot!"],
}


class Narrator:
    def __init__(self, send) -> None:
        self.send = send  # send(code, text), thread-safe
        self.last: dict[str, float] = {}
        self.chars: dict[str, dict[int, str]] = {}

    def on_state(self, code: str, state: dict[str, Any]) -> None:
        seats = state.get("seats") or {}
        names = {}
        for p in (1, 2):
            s = seats.get(str(p)) or seats.get(p) or {}
            names[p] = CHAR_NAMES.get(s.get("character"), s.get("nickname") or f"Player {p}")
        self.chars[code] = names

    def _name(self, code: str, p: Any) -> str:
        try:
            return self.chars.get(code, {}).get(int(p)) or f"Player {p}"
        except (TypeError, ValueError):
            return "the automaton"

    def _say(self, code: str, key: str, force: bool = False, **kw: Any) -> None:
        now = time.time()
        if not force and now - self.last.get(code, 0) < GAP:
            return
        self.last[code] = now
        try:
            self.send(code, random.choice(LINES[key]).format(**kw))
        except (KeyError, IndexError):
            pass

    def on_event(self, code: str, e: dict[str, Any]) -> None:
        k = e.get("kind")
        other = lambda p: 2 if p == 1 else 1  # noqa: E731
        if k == "round_start":
            self._say(code, "round_start", True, round=e.get("round", 1))
        elif k == "hit":
            a = e.get("attacker")
            key = "hit_clean" if e.get("clean") else "hit_big" if (e.get("damage") or 0) >= 15 else None
            if key:
                self._say(code, key, a=self._name(code, a), d=self._name(code, other(a)))
        elif k == "blocked":
            self._say(code, "blocked", d=self._name(code, e.get("defender")))
        elif k == "dodged":
            self._say(code, "dodged", d=self._name(code, e.get("defender")))
        elif k == "down":
            self._say(code, "down", True, p=self._name(code, e.get("player")))
        elif k == "ko":
            self._say(code, "ko", True, p=self._name(code, e.get("loser")))
        elif k == "round":
            self._say(code, "round", p=self._name(code, e.get("winner")))
        elif k == "match_end":
            self._say(code, "match_end", True, p=self._name(code, e.get("winner")))

    def on_move(self, code: str, player: int, move: dict[str, Any], nickname: str | None) -> None:
        name = move.get("name", "a mystery spell")
        if move.get("signature"):
            self._say(code, "signature", nick=nickname or self._name(code, player), move=name)
        elif move.get("source") == "live":
            self._say(code, "live", move=name)
        elif move.get("creator"):
            self._say(code, "credit", move=name, creator=move["creator"])
