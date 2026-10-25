# Notes for Vaibhav: server/ before judging

A read-only pass over server/ and contract/ for Jerry, ordered by what breaks first at the venue; nothing is applied.
Repros ran against your server in mock mode on a laptop (uvicorn 0.54, websockets 17.3), with fake phones and game
screens that copy the reconnect rules of phone/app.js and client/src/net/room.ts. Each diff applies on its own
(`patch -p1` from the repo root); all of them together passed the same repros. phone/ and client/ change tonight too.

## Before judging (no code)
- Don't run the demo on `?room=TEST` (docs/GPU_ACCESS.md:15 sends everyone there): two screens on one code knocked
  each other off every second (9 reconnects each in 10 s, taps split 10/10). Tonight's client/src/net/room.ts asks
  GET /room/{code} after a clean close, so keep closing a replaced screen with 1000 and keep `game_connected`.
- Don't restart the server while judges play (item 6). Back up the library now and hourly, from the Mac:
  `ssh root@<ip> -p <port> 'tar czf - -C /root library' > backups/library-$(date +%H%M).tgz`
- Before judging, pause the overnight agent or restart once with `BATCH_SIZE=2 bash server/start_pod.sh`: the
  worker can't preempt a running 8-prompt batch, so a Forge or a wildcard waits for all of it (jobs.py:100-116).
- If the pod dies: `LIBRARY_DIR=<backup> STT=muse MUSE_API_KEY=... ./server/run.sh` on the laptop (library moves keep
  their Kimodo motions), `cloudflared tunnel --url http://localhost:8000` for HTTPS (phones need it for the mic and
  camera; it also beats Wi-Fi that blocks device-to-device traffic), then open the game with
  `?join=https://<tunnel>/phone/?room={code}`.

## 1. Crowd chatter becomes moves
The always-on mic (phone/app.js vadListener; CLAUDE.md says hold-to-talk) uploads anything loud, and every 3+
character transcript that misses the library becomes a live wildcard: a charge on the big screen, a Kimodo job, a
Claude call once the key is on, and a permanent move in that player's name. app.py:299 is the only filter, and a
player can have any number of wildcards going (app.py:227-253). Repro: "what", "yeah okay" and "oh my god" from P1
gave three charges, and "What" and "Yeah Okay" landed on the leaderboard as Ana's moves. After the patch: all three
are silence, "summon the crab king" still charges, and a second new shout 50 ms later, while it generates, is silence.
```diff
--- a/server/app.py
+++ b/server/app.py
@@ -26,3 +26,3 @@
 from .library import MOVE_TYPES, Library
-from .matcher import Matcher
+from .matcher import Matcher, clean
 from .narrator import Narrator
@@ -226,4 +226,13 @@
 
+CHATTER = set("what yeah yes no ok okay oh ah uh um hmm hey hi hello wow nice cool god huh lets let's come".split())
+charging: dict[tuple[str, int], Job] = {}  # (room, player) -> their live wildcard job
+
+
 async def _wildcard(code: str, player: int, text: str, loudness: float, nickname: str | None) -> dict[str, Any]:
+    words = [w for w in clean(text).split() if w not in CHATTER]
+    busy = charging.get((hub.room(code).code, player))
+    if sum(map(len, words)) < 4 or len(words) > 8 or (busy and busy.status == "running"):
+        return {"result": "silence", "transcript": text}  # crowd noise, or this player is already charging
     job = jobs.reserve(LIVE)
+    charging[(hub.room(code).code, player)] = job
     charged = asyncio.Event()
```

## 2. One Muse error turns off a phone's server voice for the rest of the session
Any Muse 4xx/5xx (a 429 under load, a blip) becomes a 503 (voice.py:83-84, app.py:296-297), and on a 503
phone/app.js cast() drops server STT for good and falls back to the browser's recognition, which CLAUDE.md calls
flaky on iPhone. The 60-minute budget (config.py:45, "~$0.18 per hour") does the same to every phone once spent,
and the always-on mic spends it on noise (item 6 raises it to 600). Repro with a local stand-in for api.meta.ai
that fails once: shout 1 got 503 "Muse 500", shout 2 got 200. After the patch: 502, then 200.
```diff
--- a/server/app.py
+++ b/server/app.py
@@ -295,3 +295,5 @@
             text = (await asyncio.to_thread(voice.transcribe, data)).strip()
-        except voice.SttError as e:
+        except voice.SttHiccup as e:  # this shout fizzles; the phone keeps using Muse
+            raise HTTPException(502, str(e))
+        except voice.SttError as e:  # off or out of budget: the phone switches for good
             raise HTTPException(503, str(e))
--- a/server/voice.py
+++ b/server/voice.py
@@ -27,2 +27,6 @@
 class SttError(Exception):
+    pass
+
+
+class SttHiccup(SttError):  # Muse failed this once
     pass
@@ -83,3 +87,3 @@
     if r.status_code >= 400:
-        raise SttError(f"Muse {r.status_code}: {r.text[:200]}")
+        raise SttHiccup(f"Muse {r.status_code}: {r.text[:200]}")
     return _muse_text(r.json())
```

## 3. A judge's own Forge move swallows library hits, at 1.5x
Own moves are tried first at 0.4 (app.py:206-214), so they beat exact library names. With the pod's
all-MiniLM-L6-v2 (run offline through server/matcher.py's clean()), a forged "Flame Fist" takes "fireball" (0.52),
"thunder palm" (0.49), "kick" (0.49) and "roundhouse kick" (0.43), and "Upper Smash" takes "uppercut" (0.54).
Repro on the mock's fuzzy matcher: Ana owns Upper Smash, and "uppercut" and "thunder palm" both played it as her
signature although both are exact library names (0.99). After the patch (her move wins only within 0.1 of the
best library score): Uppercut and Thunder Palm play, and "upper smash" is still her signature.
```diff
--- a/server/app.py
+++ b/server/app.py
@@ -206,10 +206,10 @@
     own = _own_forge_ids(nickname)
-    signature = False
-    move_id, score = matcher.best(text, own) if own else (None, 0.0)
-    if move_id and score >= config.SIGNATURE_THRESHOLD:
-        signature = True
-    else:
-        move_id, score = matcher.best(text)
-        if not (move_id and score >= config.MATCH_THRESHOLD):
-            move_id = None
+    move_id, score = matcher.best(text)
+    if score < config.MATCH_THRESHOLD:
+        move_id, score = None, 0.0
+    own_id, own_score = matcher.best(text, own) if own else (None, 0.0)
+    # their own Forge move wins when it fits about as well as the best library move, not whenever it is >= 0.4
+    signature = bool(own_id and own_score >= config.SIGNATURE_THRESHOLD and own_score + 0.1 >= score)
+    if signature:
+        move_id, score = own_id, own_score
     if move_id:
```
Signature goes by exact nickname (app.py:200): another phone named Ana got 1.5x on her move (store the phone_id
with Forge moves if that matters).

## 4. No big screen in the room, but shouts still "cast"
When the game tab crashes or the laptop sleeps, /voice still answers `play` and counts a use, and a miss still
starts a wildcard and adds a move: app.py:215-224 ignores send_game's False. Repro: game closed, "uppercut" got
200 play and its uses went 0 to 1; two misses gave two charges and two new live moves. Patch, right after
`room = hub.room(code)` in shout() (app.py:204), then a `no_game` line in phone/app.js onResult():
```python
    if room.game is None:  # the big screen left: nothing would play
        return {"result": "no_game", "room": room.code}
```
Also one line each in game_session: `await self.send_phones(r.code, {"type": "game", "connected": True})` after
`r.game = ws` (rooms.py:95), and the same with False after `r.game = None` (rooms.py:119). Phones then learn at
once that the big screen left, instead of tonight's GET /room/{code} polling in app.js.

## 5. A Wi-Fi blip hands the seat to whoever joins in that moment
rooms.py:165 frees a seat the instant its socket closes, though ws.md:10 and ws.md:28 say it waits for the same
phone_id. A phone that blips mid-fight loses its robot and gets `full` when it comes back, and tonight's
phone/app.js re-sends join every 5 s while full, so a waiting phone takes the seat in any outage. Repro: Ana (P1)
dropped for ~0.4 s while Cat joined: Cat got P1, Ana got `full`. After the patch (20 s grace for the same
phone_id): Ana got P1 back and Cat `full`, and when Ana left for good, Cat got P1 about 22 s later.
```diff
--- a/server/rooms.py
+++ b/server/rooms.py
@@ -15,2 +15,3 @@
 
+SEAT_GRACE_S = 20.0  # a dropped phone keeps its seat this long (Wi-Fi blip, lock screen), then anyone can sit
 
@@ -23,2 +24,3 @@
     ws: WebSocket | None = None
+    away_since: float = 0.0
 
@@ -149,3 +151,3 @@
             if seat and seat.ws is ws:
-                seat.ws = None
+                seat.ws, seat.away_since = None, time.time()
                 await self.send_game(r.code, {"type": "leave", "player": seat.player})
@@ -164,3 +166,4 @@
         want = msg.get("player") if msg.get("player") in (1, 2) else None
-        free = [p for p in (1, 2) if p not in r.seats or r.seats[p].ws is None]
+        free = [p for p in (1, 2) if p not in r.seats
+                or (r.seats[p].ws is None and time.time() - r.seats[p].away_since > SEAT_GRACE_S)]
         if not free:
```
After a restart, seats go to whoever reconnects first (repro: Ana P1 became P2); tonight's phone change sends
`player` in join, which rooms.py:164-168 already honors (same repro: no swap).

## 6. A restart takes everything down for ~2 min; a pod stop deletes the library
Kimodo loads at import (app.py:36, engine.py:80-91), before uvicorn opens the port, so phones, the /phone page and
the game all get errors for the ~2 min start_pod.sh:12 mentions, and every room is lost. The patch loads it in a
thread, so a restart costs seconds (checked with a fake 3 s engine: the server is up at once, generate() waits,
and a failed load rejects jobs with "Kimodo failed to load"). The matcher still re-embeds the library at import
(~25 s for 6000 moves with the real model, on a Mac).
```diff
--- a/server/engine.py
+++ b/server/engine.py
@@ -164,3 +164,26 @@
 
+class LazyKimodo:  # loads in a thread: after a restart, rooms, /phone and matching are back in seconds
+    name, inner = "kimodo", None
+    load_ms = property(lambda self: self.inner.load_ms if self.inner else 0.0)  # /health: 0 = still loading
+    last_ms = property(lambda self: self.inner.last_ms if self.inner else 0.0)
+
+    def __init__(self) -> None:
+        import threading
+        self.ready = threading.Event()
+        threading.Thread(target=self._load, daemon=True).start()
+
+    def _load(self) -> None:
+        try:
+            self.inner = KimodoEngine()
+        finally:
+            self.ready.set()
+
+    def __getattr__(self, attr):  # generate() and pose_constraints() wait for the model
+        self.ready.wait()
+        if self.inner is None:
+            raise RuntimeError("Kimodo failed to load, see the log")
+        return getattr(self.inner, attr)
+
+
 def make_engine():
-    return KimodoEngine() if config.ENGINE == "kimodo" else MockEngine()
+    return LazyKimodo() if config.ENGINE == "kimodo" else MockEngine()
```
LIBRARY_DIR, the venv and the 16 GB Llama cache live under /root, the container disk, which RunPod clears when the
pod is stopped or edited; /workspace survives a stop ([RunPod storage docs](https://docs.runpod.io/pods/storage/types)).
Check `df -h /workspace`, run `mv /root/library /workspace/` (consider `HF_HOME=/workspace/hf` too), and change
start_pod.sh as below (fine under its `set -e`). The ping flags drop dead sockets in 20 s instead of 40 (a frozen
phone took 38.6 s at the defaults):
```bash
LIB=/root/library; [ -d /workspace/library ] && LIB=/workspace/library
export ENGINE=kimodo LIBRARY_DIR=${LIBRARY_DIR:-$LIB} MAX_STT_MINUTES=${MAX_STT_MINUTES:-600}
# and on the uvicorn line: --ws-ping-interval 10 --ws-ping-timeout 10
```

## 7. The narrator calls every re-cast "brand-new" and skips credits
on_move picks the "live" line for any live move (narrator.py:93-94), so re-casting a wildcard always says "A
brand-new spell is born" and a friend using it never credits the inventor; live and signature lines also obey the
2.5 s pacing, so a wildcard right after "Round 1!" can go unspoken. Repro: Ana re-cast hers, then Ben used it: "A
brand-new spell is born: Summon The Crab King!" twice. Fix: pass `new=j.status == "done"` from send_ready (app.py:240)
and use "live" only when new; otherwise "credit" when `move["creator"] != nickname`; pass `True` (force) for live
and signature. After: Ben's use says "Summon The Crab King, a spell first dreamed up by Ana!", Ana's says nothing.

## 8. Smaller ones
- Room codes over 8 characters: room() keeps 8 (rooms.py:47), send_game/send_phones look up the whole code
  (rooms.py:56, 66). With `?room=HACKTX2026`, joins and taps work but every play, charge and ready is lost (repro).
  Use `code.upper()[:8]` in both.
- A (re)connecting game screen gets `join` for gone phones too (rooms.py:96-99; repro: join:2:Ben, no leave), so
  its lobby shows them joined: also send `leave` for seats whose `ws is None`. A phone joining later gets the last
  match's final state (rooms.py:140-141): only send last_state when it's under ~2 s old.
- /idle and /clip/{name} are remade in place (POST /clip overwrites) but sent `immutable` for a year (app.py:97),
  so a browser with the old clip never refetches (repro: new ETag, same header). Send `no-cache` for those two.
- POST /generate accepts a second "Uppercut" (repro: mv_00006); shouts then always get the older one. The agent
  already treats 409 as "server duplicate" (agent/run.py:714), so 409 an agent spec whose name exists.
- If the pod serves client/dist (it's in the repo now), its 35 STLs (19.7 MB) go out uncompressed:
  `app.add_middleware(GZipMiddleware, minimum_size=1024)` takes client/dist from 20.7 to 9.0 MB, 304s intact. The
  "/" mount 404s /phone with no slash. `Cache-Control: no-cache` on /phone (a StaticFiles subclass) gets tonight's
  ?v= bumps to phones that loaded the page earlier.
- server/README.md still says phone/dist and "Not built yet: Forge". wildcard.py imports agent/specs.py, which the
  rewritten agent keeps only for you (agent/README.md:9-10): live specs follow it, not the new prompt.py.

## Contract lines to update (contract/ is yours)
ws.md: a dropped seat waits 20 s for its phone_id; server to phone `{"type":"game","connected":bool}`; a replaced
game screen is closed with 1000 and GET /room/{code} then shows `game_connected`. api.md: /voice `no_game`; 502 =
Muse failed this shout, 503 = STT off or out of budget; /generate 409 for duplicates; /idle and /clip no-cache.

## Turning Claude on
/health says `"claude": false` (no key on the pod), so wildcards use keyword specs: one of 7 stock prompts
(wildcard.py:97-105) that usually already have a motion, so they play at once with a stock motion. The narrator is
templates only (narrator.py has no Claude path); a key changes nothing there.
- Put the key in /root/.anthropic_key and run `bash server/start_pod.sh`: a restart, so before judging, and after
  item 1, or crowd noise spends the cap.
- The request is right: wildcard.claude_spec() through anthropic 2.3.0 into a local stub sent POST /v1/messages
  with `anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: "default"`, effort `low`, a `json_schema`
  format and a cached system prompt, matching the current API docs; the schema uses only supported keywords and
  validate() took a sample answer. Not run against the real API.
- Cost on claude-opus-5-5 ($4/M input, $20/M output, $5/M cache writes, $0.20/M cache reads): the 5,508-character
  system prompt (~1.5-2K tokens, cached) plus one spec and low-effort thinking (a few hundred output tokens) is
  about 1-2 cents per wildcard, so the 150-call cap (config.py:44) is about $1.50-3 per server run. It resets on
  restart and counts timeouts and failures. The overnight agent's calls on the same key have no cap.
- A Claude spec has its own kimodo_prompt, so it runs Kimodo (about 1 s on the 4090, plus any agent batch ahead)
  instead of a stock motion. 12 s timeout, no retries, then the keyword spec.

## Checked, fine
- CORS (any origin, no credentials), HTTPS for phones (RunPod's proxy), matching (3-5 ms at 1000-6000 moves).
- uvicorn's keepalive is on (20 s/20 s): a frozen phone's seat was freed after 38.6 s, and the other phone's 10 Hz
  state never stalled (longest gap 152 ms). No other accept-then-close path makes clients reconnect in a loop.
