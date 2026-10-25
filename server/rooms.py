"""Room WebSockets: one game screen and up to two phones per room code. contract/ws.md has the messages.

The server relays phone joins and taps to the game, pushes play/charge/ready/narrate to the game, and
relays the game's state and event messages to the phones.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import WebSocket, WebSocketDisconnect


@dataclass
class Seat:
    player: int
    nickname: str
    character: str | None
    phone_id: str
    ws: WebSocket | None = None


@dataclass
class Room:
    code: str
    game: WebSocket | None = None
    seats: dict[int, Seat] = field(default_factory=dict)
    last_state: dict[str, Any] | None = None
    touched: float = field(default_factory=time.time)

    def nickname(self, player: int) -> str | None:
        s = self.seats.get(player)
        return s.nickname if s else None


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.on_event: Callable[[str, dict[str, Any]], None] | None = None   # game events, for the narrator
        self.on_state: Callable[[str, dict[str, Any]], None] | None = None

    def room(self, code: str) -> Room:
        code = code.upper()[:8]
        r = self.rooms.get(code)
        if r is None:
            r = self.rooms[code] = Room(code)
        r.touched = time.time()
        return r

    # ---------- sending ----------
    async def send_game(self, code: str, msg: dict[str, Any]) -> bool:
        r = self.rooms.get(code.upper())
        if not r or not r.game:
            return False
        try:
            await r.game.send_text(json.dumps(msg))
            return True
        except Exception:
            return False

    async def send_phones(self, code: str, msg: dict[str, Any], player: int | None = None) -> None:
        r = self.rooms.get(code.upper())
        if not r:
            return
        text = json.dumps(msg)
        for s in list(r.seats.values()):
            if s.ws and (player is None or s.player == player):
                try:
                    await s.ws.send_text(text)
                except Exception:
                    pass

    def push_game_threadsafe(self, code: str, msg: dict[str, Any]) -> None:
        """From the GPU worker thread."""
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.send_game(code, msg), self.loop)

    def push_phone_threadsafe(self, code: str, msg: dict[str, Any], player: int | None = None) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.send_phones(code, msg, player), self.loop)

    # ---------- sessions ----------
    async def game_session(self, ws: WebSocket, code: str) -> None:
        await ws.accept()
        r = self.room(code)
        if r.game:
            try:
                await r.game.close()
            except Exception:
                pass
        r.game = ws
        # tell the (re)connected screen who is already seated
        for s in r.seats.values():
            await ws.send_text(json.dumps({"type": "join", "player": s.player, "nickname": s.nickname,
                                           **({"character": s.character} if s.character else {})}))
        try:
            while True:
                msg = _parse(await ws.receive_text())
                if not msg:
                    continue
                t = msg.get("type")
                if t == "state":
                    r.last_state = msg
                    await self.send_phones(r.code, msg)
                    if self.on_state:
                        self.on_state(r.code, msg)
                elif t == "event":
                    await self.send_phones(r.code, msg)
                    if self.on_event and isinstance(msg.get("event"), dict):
                        self.on_event(r.code, msg["event"])
        except WebSocketDisconnect:
            pass
        finally:
            if r.game is ws:
                r.game = None

    async def phone_session(self, ws: WebSocket, code: str) -> None:
        await ws.accept()
        r = self.room(code)
        seat: Seat | None = None
        try:
            while True:
                msg = _parse(await ws.receive_text())
                if not msg:
                    continue
                t = msg.get("type")
                if t == "join":
                    seat = self._seat(r, msg, ws)
                    if not seat:
                        await ws.send_text(json.dumps({"type": "full", "room": r.code}))
                        continue
                    await ws.send_text(json.dumps({"type": "joined", "room": r.code, "player": seat.player,
                                                   "nickname": seat.nickname}))
                    await self.send_game(r.code, {"type": "join", "player": seat.player, "nickname": seat.nickname,
                                                  **({"character": seat.character} if seat.character else {})})
                    if r.last_state:
                        await ws.send_text(json.dumps(r.last_state))
                elif t == "tap" and seat and msg.get("action") in ("jump", "dodge_left", "dodge_right", "block"):
                    await self.send_game(r.code, {"type": "tap", "player": seat.player, "action": msg["action"]})
                elif t == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
        except WebSocketDisconnect:
            pass
        finally:
            if seat and seat.ws is ws:
                seat.ws = None
                await self.send_game(r.code, {"type": "leave", "player": seat.player})

    @staticmethod
    def _seat(r: Room, msg: dict[str, Any], ws: WebSocket) -> Seat | None:
        phone_id = str(msg.get("phone_id") or msg.get("nickname") or id(ws))[:64]
        nickname = _nickname(msg.get("nickname")) or "Player"
        character = msg.get("character") if isinstance(msg.get("character"), str) else None
        # the same phone coming back gets its old seat
        for s in r.seats.values():
            if s.phone_id == phone_id:
                s.ws, s.nickname = ws, nickname
                s.character = character or s.character
                return s
        want = msg.get("player") if msg.get("player") in (1, 2) else None
        free = [p for p in (1, 2) if p not in r.seats or r.seats[p].ws is None]
        if not free:
            return None
        p = want if want in free else free[0]
        r.seats[p] = Seat(p, nickname, character, phone_id, ws)
        return r.seats[p]


def _parse(text: str) -> dict[str, Any] | None:
    try:
        m = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    return m if isinstance(m, dict) and isinstance(m.get("type"), str) else None


def _nickname(n: Any) -> str:
    if not isinstance(n, str):
        return ""
    # drop control and bidi characters, keep whole code points (review findings 30 and 43)
    cleaned = "".join(ch for ch in n if ch.isprintable() and not (0x202A <= ord(ch) <= 0x202E or 0x2066 <= ord(ch) <= 0x2069))
    return cleaned.strip()[:16]
