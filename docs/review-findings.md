# Review findings: client/ and agent/

An automated review of `client/` and `agent/` at commit `22b7e0a`: seven read-only reviewers, one per area (game flow and networking, rendering, UI and audio, the mock layer, the Python agent, CLAUDE.md coverage, and a visual check that played the game in a browser). Skeptics then re-checked findings independently, but that step was stopped early: 9 findings were re-checked, 8 confirmed and 1 refuted (dropped from this list). None of these are fixed yet.

50 findings: 10 high, 17 medium, 23 low. Status **confirmed** means a skeptic reproduced or traced it; **unverified** means one reviewer reported it and nobody has checked yet, so read the code before fixing.

Repro scripts and screenshots named in a finding are on Jerry's laptop; ask if you need one. Suggested owner follows [HANDOFF.md](HANDOFF.md): `agent/` → Vaibhav, `client/` → Sudeep.

| # | Severity | Status | Owner | Where | Finding |
| --- | --- | --- | --- | --- | --- |
| 1 | high | confirmed | Sudeep | `client/src/config.ts:15` | [The default join URL in the QR code is localhost or plain http, so phones can't open it or can't use the mic and camera](#1) |
| 2 | high | confirmed | Sudeep | `client/src/game/flow.ts:268` | [A `ready` push with no move ends the charge and marks the job done, so the live wildcard never plays](#2) |
| 3 | high | confirmed | Sudeep | `client/src/game/flow.ts:368` | [The 1.5x signature bonus depends on a `signature` field the CLAUDE.md move spec does not have](#3) |
| 4 | high | unverified | Sudeep | `client/src/game/flow.ts:98` | [If sim.init() rejects, the game sits on the loading page forever with no message](#4) |
| 5 | high | unverified | Sudeep | `client/src/main.ts:261` | [One exception in any frame (e.g. sim.step) freezes the whole game permanently](#5) |
| 6 | high | unverified | Sudeep | `client/src/mock/stubSim.ts:629` | [Root travel and turn from real Kimodo moves are dropped at move end: the robot slides back 0.3 m and snaps up to ~57 deg in 0.12 s](#6) |
| 7 | high | unverified | Vaibhav | `agent/builder.py:262` | [Motion reuse treats left/right (and forward/backward) prompts as duplicates, so moves get a mirrored motion](#7) |
| 8 | high | unverified | Vaibhav | `agent/builder.py:297` | [A spec that POST /generate rejects with a 4xx is retried at the head of the queue forever, blocking everything behind it](#8) |
| 9 | high | unverified | Vaibhav | `agent/builder.py:340` | [One bad job can stall the overnight run: no job timeout, and unknown statuses never leave pending](#9) |
| 10 | high | unverified | Vaibhav | `agent/specs.py:197` | [The name-leak check drops ordinary plain-combat specs (Left Hook, Right Cross, Quick Jab, Head Kick...)](#10) |
| 11 | medium | confirmed | Sudeep | `client/src/game/flow.ts:141` | [Rounds that end on time (including draws) send no `round` event to phones or the Commentator](#11) |
| 12 | medium | confirmed | Sudeep | `client/src/game/flow.ts:159` | [After a round ends on time, attacks already in flight still land and can KO the round winner](#12) |
| 13 | medium | confirmed | Sudeep | `client/src/game/flow.ts:183` | [A phone re-joining mid-fight changes its fighter's look and name, but not the sim's character rules](#13) |
| 14 | medium | confirmed | Sudeep | `client/src/game/flow.ts:267` | [If a job's `charge` arrives after its `ready`, the fighter stays charging for the rest of the round](#14) |
| 15 | medium | confirmed | Sudeep | `client/src/game/flow.ts:316` | [Re-initialising the sim leaves simReady true, so the frame loop keeps calling step/state while init() is still running](#15) |
| 16 | medium | unverified | Sudeep | `client/src/audio/narrator.ts:92` | [Narrator cuts lines in their last second, often the spell name or the credit](#16) |
| 17 | medium | unverified | Sudeep | `client/src/g1/fk.ts:84` | [motionMapper counts a freejoint entry in joint_names as a column, shifting every hinge by one and reading past the row (NaN)](#17) |
| 18 | medium | unverified | Sudeep | `client/src/game/flow.ts:109` | [After a match that ends in a KO, the lobby shows the KO'd robot on the floor and an off-center camera](#18) |
| 19 | medium | unverified | Sudeep | `client/src/mock/sim/clip.ts:50` | [Idle loop wraps from the last frame to the first with no blend, so a real (non-seamless) idle pops every loop](#19) |
| 20 | medium | unverified | Sudeep | `client/src/mock/stubSim.ts:364` | [`down` fires when the pelvis first crosses 0.4 m, not after 2 s below it as CLAUDE.md defines a knockdown](#20) |
| 21 | medium | unverified | Sudeep | `client/src/render/effects.ts:574` | [KOs from strike moves white out the screen during the slow-motion fall](#21) |
| 22 | medium | unverified | Sudeep | `client/src/render/fx/meshes.ts:104` | [The beam shader's pow(1.0 - h, uFade) returns NaN when vUv.y > 1. This, not the MSAA target, caused the whole-frame black frames](#22) |
| 23 | medium | unverified | Sudeep | `client/src/render/stage.ts:76` | [Hand-off notes leave out the fighter layout the renderer and UI assume (P1 at MuJoCo -X facing +X)](#23) |
| 24 | medium | unverified | Sudeep | `client/src/ui/hud.ts:347` | [The K.O. banner covers the move name and "invented by <nickname>" at the KO moment](#24) |
| 25 | medium | unverified | Vaibhav | `agent/builder.py:293` | [A spec is lost if anything other than ServerError escapes the POST (Ctrl-C, SIGTERM, IncompleteRead)](#25) |
| 26 | medium | unverified | Vaibhav | `agent/builder.py:315` | [A waiting spec whose twin has the identical prompt matches itself and is never posted](#26) |
| 27 | medium | unverified | Vaibhav | `agent/builder.py:403` | [--dry-run still POSTs specs left in the saved queue](#27) |
| 28 | low | unverified | Sudeep | `client/README.md:74` | [The README's assumed `state` message leaves out `seats`](#28) |
| 29 | low | unverified | Sudeep | `client/src/game/flow.ts:159` | [Drawn rounds stretch "best of 3" without limit](#29) |
| 30 | low | unverified | Sudeep | `client/src/game/flow.ts:184` | [Nickname truncation splits emoji and leaves broken UTF-16 in the UI and in state pushes](#30) |
| 31 | low | unverified | Sudeep | `client/src/game/flow.ts:253` | [Wildcard shout loudness is lost when the poll beats the `ready` push](#31) |
| 32 | low | unverified | Sudeep | `client/src/game/flow.ts:258` | [A lost job (e.g. 404 after a server restart) leaves the fighter charging and unable to act for 30 s](#32) |
| 33 | low | unverified | Sudeep | `client/src/game/flow.ts:300` | [A sim `round` event that arrives with `ko` ends the round at once, skipping the KO pause](#33) |
| 34 | low | unverified | Sudeep | `client/src/main.ts:108` | [Round-end banner can't tell players apart in a mirror match](#34) |
| 35 | low | unverified | Sudeep | `client/src/main.ts:118` | [`effect: "none"` is never honored; plain-combat moves get a type effect anyway](#35) |
| 36 | low | unverified | Sudeep | `client/src/main.ts:135` | [Captions appear when lines arrive, not when they are spoken; dropped lines still get captioned](#36) |
| 37 | low | unverified | Sudeep | `client/src/main.ts:192` | [KO and knockdown effects are timed from rule events and wall-clock time instead of the physical fall](#37) |
| 38 | low | unverified | Sudeep | `client/src/mock/server.ts:98` | [Mock server narrates moves and adds live moves to the library even when the game ignored or rejected them](#38) |
| 39 | low | unverified | Sudeep | `client/src/mock/stubSim.ts:549` | [Fight outcomes depend on frame rate even though the stub is described as deterministic](#39) |
| 40 | low | unverified | Sudeep | `client/src/mock/stubSim.ts:757` | [A playing defend move reports status "blocking", so a shout during it fizzles with the wrong reason, "not enough energy"](#40) |
| 41 | low | unverified | Sudeep | `client/src/ui/hud.ts:272` | [Live wildcard: the fading "Summoning…" label shows through the new move name](#41) |
| 42 | low | unverified | Sudeep | `client/src/ui/hud.ts:438` | [The other fighter's move flash jumps sideways mid-animation when one flash ends](#42) |
| 43 | low | unverified | Sudeep | `client/src/ui/screens.ts:96` | [Bidi control characters in a nickname reverse the match-end title](#43) |
| 44 | low | unverified | Sudeep | `client/src/ui/style.css:223` | [The narrator caption hides both fighters' feet](#44) |
| 45 | low | unverified | Vaibhav | `agent/README.md:18` | [README step 3 does not generate the dry-run specs that were just reviewed](#45) |
| 46 | low | unverified | Vaibhav | `agent/builder.py:84` | [Batch review files mark in-batch duplicates as kept or rejected](#46) |
| 47 | low | unverified | Vaibhav | `agent/builder.py:85` | [Review.update overwrites dropped-duplicate rows that share the kept spec's name](#47) |
| 48 | low | unverified | Vaibhav | `agent/builder.py:144` | [--library-file: a relative path is silently ignored, and one partial line throws away a paid batch](#48) |
| 49 | low | unverified | Vaibhav | `agent/builder.py:254` | [A near-duplicate of a spec still queued from the previous batch generates a second motion](#49) |
| 50 | low | unverified | Vaibhav | `agent/builder.py:419` | [log.txt counts the same hour again after every restart](#50) |

<a id="1"></a>
## 1. The default join URL in the QR code is localhost or plain http, so phones can't open it or can't use the mic and camera

high · confirmed · Sudeep · `client/src/config.ts:15` · reported by 4 reviewers

**What's wrong:** `JOIN_URL = ... ?? `${location.protocol}//${location.hostname}:8000/phone/?room={code}`` sits directly under the comment "Must be reachable from a phone, so not localhost", yet it is built from the game page's own host, and the README says to open http://localhost:5173. On a LAN IP it is still plain http://. Phone browsers allow getUserMedia (mic and camera) only on secure origins. With the README's remote GPU server (SERVER_URL=http://gpu-box:8000), it points at the laptop instead of the server.

**When it bites:** Verified: opened at localhost, the lobby QR encodes `localhost:8000/phone/?room=PQFR`, which a judge's phone can't load. Opened by LAN IP, the phone page loads over http, so hold-to-talk and Forge capture can't start. Repro: `t_joinurl.mjs`

**Suggested fix:** Derive the default from the server's public https phone URL (or require VITE_JOIN_URL / ?join). Show a visible lobby warning when the join host is localhost or 127.0.0.1, or the scheme is not https.

Also reported as: “QR code points phones at localhost:8000 when the setup follows the README”; “Default QR join URL points phones at localhost (or the laptop's :8000) over plain http”; “The lobby QR code points at localhost by default, so phones can't join”

> Re-check: All three claims are true.

1. **Localhost.** The README says to open http://localhost:5173. The fallback join URL is built from `location.hostname`, so the QR code then encodes `http://localhost:8000/phone/...`. A phone reads localhost as itself, so the page can't load. This breaks the requirement in the comment right above the line: "Must be reachable from a phone, so not localhost".

2. **LAN IP over plain http.** If the game screen is opened by its LAN IP, the QR code is `http://<lan-ip>:8000/phone/...`. That origin is not a secure context, so `navigator.mediaDevices` is undefined. Hold-to-talk and Forge capture can't start. Tap buttons over the WebSocket would still work.

3. **Remote G

<a id="2"></a>
## 2. A `ready` push with no move ends the charge and marks the job done, so the live wildcard never plays

high · confirmed · Sudeep · `client/src/game/flow.ts:268` · reported by 2 reviewers

**What's wrong:** finishJob marks the job done and stops the charge before it knows whether it has a move: `if (this.doneJobs.has(job)) return; this.doneJobs.add(job); if (this.charging.get(p) === job) this.stopCharging(p); ... if (move) void this.play(p, move, motion, loudness);`. stopCharging also ends pollJob, whose loop runs only `while ... this.charging.get(p) === job`. If a later poll result or push does carry the move, the doneJobs check drops it. CLAUDE.md describes `ready` only as "(job done)" and says "Jobs are plain HTTP" (GET /job/{id} returns "done with the move"). A server that pushes `{type:"ready", job}` and expects the client to fetch the job therefore loses every wildcard. The 250 ms poll backstop is cancelled by the same push.

**When it bites:** P1 shouts "summon the crab king". The server sends `charge job_1`, then `{type:"ready", job:"job_1", player:1}`. The charge ring disappears with no fizzle, and the move never plays even though /job/job_1 is done with a move. Verified in mock mode: with the move-less ready injected at 0.15 s, the mock's real result at 2.7 s was dropped as a duplicate. Without the injection, the move played at 2.71 s. Repro: `t_ready_nomove.mjs`

**Suggested fix:** Mark the job done and stop the charge only once a move is in hand. On a `ready` with no move, call GET /job/{id} right away (or keep pollJob running) and play from the result. On `rejected`, stop the charge and fizzle.

Also reported as: “Live wildcard is dropped unless `ready` carries the move (and a `play` sent while charging fizzles)”

> Re-check: The mechanism is real and I reproduced it under realistic timing. In finishJob (client/src/game/flow.ts:266-272), the job is added to doneJobs and the charge is stopped before the code checks whether a move arrived. stopCharging removes the player from `charging`, and pollJob's guards (lines 248 and 250) then exit the poll loop. Any later move for that job, from a poll already in flight or from another push, hits `if (this.doneJobs.has(job)) return` and is dropped. With no move the function does nothing else: no fizzle, no toast, no GET /job.

The client's own contract allows this message shape. contract.ts:75 declares `ReadyMsg { ...; job: string; move?: MoveSpec; ... }`, so `move` is optio

> Re-check: The code behaves exactly as the finding says. When a `ready` arrives without a move, flow.ts:206-208 calls finishJob. finishJob (lines 267-269) adds the job to doneJobs and calls stopCharging before it checks whether it has a move. stopCharging deletes `charging[p]`, so pollJob's loop guard (`this.charging.get(p) === job`, lines 248/250) fails and the 250 ms HTTP backstop exits. Line 271 (`if (move) ...`) then does nothing. Any later source of the move (a poll response already in flight, or a second push that carries the move) hits `if (this.doneJobs.has(job)) return;` and is dropped. Nothing else in client/src calls api.job, so nothing recovers the move. There is also no fizzle or toast: th

<a id="3"></a>
## 3. The 1.5x signature bonus depends on a `signature` field the CLAUDE.md move spec does not have

high · confirmed · Sudeep · `client/src/game/flow.ts:368` · reported by 2 reviewers

**What's wrong:** toSimMove sets `signature: !!s.signature`. The CLAUDE.md "Move spec" (what the server stores and sends as `play (player, move)`) has `source` and `creator` but no `signature`. Only the mock server sets the flag (mock/server.ts:95 `move.signature = spec.source === "forge" && spec.creator === seats[p]?.nickname`), so mock mode hides the gap. The game screen already knows each seat's nickname but never works the flag out itself.

**When it bites:** Pip shouts her own Forge move and the real server sends the library spec `{source:"forge", creator:"Pip", ...}`. The sim receives `signature:false`: 1x damage instead of 1.5x, no "Signature x1.5" badge (hud.ts:251), no narrator signature line. The demo moment "a signature move landing with a real fall" loses its bonus and may not knock the robot down.

**Suggested fix:** Pass the player into toSimMove and use `signature: s.signature ?? (s.source === "forge" && !!s.creator && s.creator === this.seats[p]?.nickname)`.

Also reported as: “Signature 1.5x depends on a server-set `move.signature` that neither CLAUDE.md's move spec nor the README's assumptions mention”

> Re-check: The client gets the signature flag from one place only: `move.signature` on the incoming spec. flow.ts:368 turns a missing field into false, and the HUD badge reads the raw spec the same way (main.ts movePlayed -> hud.flashMove, hud.ts:251). The play message type has no other field for it, and grep finds no other code that works it out.

CLAUDE.md never puts `signature` in the data the server sends:
- The "Move spec" (CLAUDE.md:124-146) has `source` and `creator` but no `signature`. Of all the fields in the sim's `Move`, `signature` is the only one the move spec lacks.
- The play message is described only as `play` (player, move) (CLAUDE.md:319).
- The library specs Jerry's own agent writes 

> Re-check: The client code does what the finding says, and I reproduced it.

1. CLAUDE.md's "Move spec" is the library format the server stores and sends. It has no `signature` field. The spec says the server sends `play (player, move)`, and on the server side "move" always means this spec (`/match` returns a "library move", `/job` returns "done with the move"). Nothing in CLAUDE.md tells the server to add `signature`. Only the sim's `Move` has `signature: boolean`, and Jerry's code is what builds that `Move`.
2. flow.ts:368 turns a missing field into `false` without any warning. The game screen already has everything it needs to work the flag out: the seat nickname from `join`, plus `spec.source` and 

<a id="4"></a>
## 4. If sim.init() rejects, the game sits on the loading page forever with no message

high · unverified · Sudeep · `client/src/game/flow.ts:98` · reported by 2 reviewers

**What's wrong:** startMatch() runs `if (this.needsInit()) this.setPhase("loading"); await this.ensureSim();` with no try/catch, and main.ts:212 calls it as `void flow.startMatch()`. If sim.init rejects, the phase stays "loading" and the "The fairy ring awakens…" page spins forever. Enter is ignored because startMatch only runs from lobby or matchEnd, and Esc only works in matchEnd or roundEnd. The only trace is an unhandled rejection in the console. boot() has the same problem: line 68 `await this.ensureSim()` rejects, main().catch only logs it, and the screen stays on "Waking the automatons…". The dev server log shows this exact path with a real sim at 8:17:35 PM: `[Unhandled rejection] Error: mujoco: joint 'waist_yaw_joint' not in idle motion > Flow.ensureSim > Flow.startMatch > main.ts:212`. Reproduced in mock by making sim.init reject, changing a character in the lobby (so a re-init is needed) and pressing Enter: the phase stayed "loading" and Enter/Esc did nothing. Screenshot: `initfail/stuck-loading.png`

**When it bites:** The real sim is plugged in and the server's idle motion has joint_names that don't match the Menagerie G1 (CLAUDE.md lists the joint order as unknown). Players pick characters and press Enter, and the screen hangs on the loading page with no error. Reloading leads to the same hang.

**Suggested fix:** Catch failures from ensureSim in startMatch and boot. On failure, call screens.showError(err.message), or toast the error and setPhase("lobby"), so the operator can see the problem and retry.

Also reported as: “If sim.init() fails, the game is stuck on the loading screen with no error and no way out”

<a id="5"></a>
## 5. One exception in any frame (e.g. sim.step) freezes the whole game permanently

high · unverified · Sudeep · `client/src/main.ts:261` · reported by 3 reviewers

**What's wrong:** The frame loop only re-arms itself as its very last statement: `const loop = (now) => { ... if (flow.simReady) { sim.step(dt); ... } flow.update(...); ... stage.render(...); requestAnimationFrame(loop); };` (main.ts 234-262). If anything in the body throws (sim.step at line 244, robots[p].update, effects.update, stage.render), `requestAnimationFrame(loop)` never runs and nothing draws again. flow.update (the round clock and the `state` pushes to phones) lives in the same loop, so those stop too. The dev server's own log (scratchpad/vite5180.log, 8:09:42 PM) shows a real MuJoCo sim has already thrown `mjStep: simulation unstable (NaN in qacc)` from main.ts:244. I reproduced it in the running mock by making StubSim.step throw exactly once. 4.5 s later the timer was still at 58.98 (HUD showed "59"), the camera hadn't moved, and pressing a shout key did nothing. Screenshot: `loopdeath/after-one-throw.png`

**When it bites:** The real sim is swapped in as the README describes. A big impulse makes MuJoCo produce NaN once during a fight, so step() throws. The game screen then stays frozen on that frame for the rest of the demo: timer, HUD, effects and phone state all stop. Only a page reload recovers it.

**Suggested fix:** Re-arm first: call requestAnimationFrame(loop) at the top of loop, or wrap the body in try/catch that logs or toasts once. Also guard sim.step on its own so one bad step skips a single frame instead of ending the loop.

Also reported as: “One exception in the frame loop freezes the game for good, and a reload strands both phones in a dead room”; “A single exception anywhere in a frame stops the render loop permanently”

<a id="6"></a>
## 6. Root travel and turn from real Kimodo moves are dropped at move end: the robot slides back 0.3 m and snaps up to ~57 deg in 0.12 s

high · unverified · Sudeep · `client/src/mock/stubSim.ts:629`

**What's wrong:** `endMove` does `f.play = null; this.crossfade(f);`. The crossfade's `from` is the clip's last re-based frame. ClipSampler.rebase (clip.ts L80-95) keeps that frame's root offset (clipped to 0.3 m) and its yaw relative to frame 0. The `to` is the idle at the anchor, so the 0.12 s `mixQpos` blend (BLEND_S) pulls the pelvis back to the anchor and slerps the yaw back. Nothing moves `f.anchor` or `f.yaw` by where the motion ended. Every procedural clip ends with `back(t)`, the exact guard at root (0,0) and yaw 0, so mock mode never shows this. main.ts L49 builds `new StubSim(...)` unconditionally, so this is also the sim on the real-server path. `interrupt()` (knockdown mid-move) has the same problem.

**When it bites:** I ported Kimodo G1-RP example clips to Motion JSON, cut 36-frame (1.2 s) windows and played them through a fresh StubSim at 60 Hz. At move end the pelvis moved 0.30 m back in 8 frames (kx_04 walk-and-wave 0.296 m, kx_01 walk 0.303 m, kx_05 jog 0.298 m with a -57.5 deg yaw snap at 12 deg per frame). mo_cross shifts 0.015 m. Any spec whose prompt says 'steps forward' (like CLAUDE.md's own example) will rubber-band backwards after every cast. For melee the anchor was already held back to make room for the lunge, so the robot visibly springs away from the opponent after landing a hit.

**Suggested fix:** In endMove, and in interrupt when a move is cut, read the clip's re-based root at the frame being left (x, y, yaw). Add it to the fighter: `f.anchor += R(f.yaw)·(x,y)`, `f.yaw += yaw`. Subtract the same offset from the root in the `f.from` crossfade buffer so the pelvis stays put. HOME_RATE and the facing turn in travel() then bring the fighter back smoothly.

<a id="7"></a>
## 7. Motion reuse treats left/right (and forward/backward) prompts as duplicates, so moves get a mirrored motion

high · unverified · Vaibhav · `agent/builder.py:262`

**What's wrong:** Reuse depends only on the MiniLM cosine score of kimodo_prompt: `if motion and sim >= REUSE_SIMILARITY: spec["motion_id"] = motion`, plus the in-batch twin check `twin = next((j for j in generators if pair[j][i] >= REUSE_SIMILARITY), None)` at :261. The index stores only (prompt, motion_id), so hit_joint and side never enter the decision. Measured with the cached all-MiniLM-L6-v2 through PromptIndex.pairwise: 'left foot ... right uppercut' vs 'right foot ... left uppercut' 0.999; 'quick jab with the left hand' vs 'right hand' 0.994; 'snaps the left foot forward' vs 'right' 0.989; 'steps forward and pushes both palms' vs 'steps backward' 0.976; 'throws a right uppercut' vs 'left uppercut' 0.965. All are above 0.95. SYSTEM_PROMPT tells Claude to mix hit joints ('not only right hands'), so mirrored pairs will be common. Also, _kept (:360) indexes the reusing spec's own prompt under the borrowed motion, so reuse can chain further away from the original. Example: p1 vs p3 is 0.949, below the threshold, but p3 still gets p1's motion through p2 (0.993, then 0.962).

**When it bites:** 'Ember Hook' (r_hand, 'a person throws a hook with the right fist at head height') is kept as mo_0007. Later 'Frost Hook' (l_hand, '...left fist...') scores 0.992 and is POSTed with motion_id mo_0007. The robot throws a right hook, but the server picks hit_frame from l_hand, which barely moves, and the sim spawns the projectile and checks clean-hit contact at the idle left hand. The bad pairing stays in the shared library. In-batch twins have the same problem: the second spec waits for the first and inherits its motion.

**Suggested fix:** Store hit_joint (and kind) with each indexed prompt and reuse only when they match. Also require the same direction words (left/right/forward/backward/up/down) in both prompts. Index only prompts that produced their own motion: skip _index_many in _kept when the spec already had motion_id.

<a id="8"></a>
## 8. A spec that POST /generate rejects with a 4xx is retried at the head of the queue forever, blocking everything behind it

high · unverified · Vaibhav · `agent/builder.py:297`

**What's wrong:** Every ServerError from generate() is treated as temporary: `except ServerError as e: ... self.state.queue.insert(0, item); self._server_trouble(e); return`. The item goes back to the front, `_next_postable` returns it first again, and it is retried every 5 s with nothing behind it ever posted. Server.generate also raises ServerError (status None) when the response has no 'job' (server.py:59-61), which ends in the same loop. FastAPI returns 422 for any request body that fails its pydantic model. That is likely for some specs while the contract is unwritten (an effect value the server's enum lacks, alias limits, extra fields).

**When it bites:** Reproduced offline: queue [Pixie Jab (effect fairy_dust, server returns 422), Hook, Cross]. After 50 post_some calls with the back-off cleared, posted == [] and all three were still queued. Overnight, one spec the server won't accept stops all generation, and the log only shows 'server trouble, retrying every 5 s' once a minute.

**Suggested fix:** On a 4xx other than 408/409/429, or a missing job id, mark the spec rejected (count it, update the review file, add its prompt to failed_prompts) instead of putting it back. For temporary errors, put it back at the end of the queue, not the front.

<a id="9"></a>
## 9. One bad job can stall the overnight run: no job timeout, and unknown statuses never leave pending

high · unverified · Vaibhav · `agent/builder.py:340`

**What's wrong:** posted_at is written (:303) but never read. A job that stays 'running' forever (for example, the server's worker thread died) holds a max_pending slot for good. Any status other than done/rejected/running/queued/None is only logged: `elif status not in ("running", "queued", None): log(f"[warn] job ...: unexpected status {status!r}")` (:347-348). The job is never removed and the warning repeats on every 250 ms poll. A non-404 error on one job's GET runs `self._server_trouble(e); return` (:340-341), so jobs later in pending are never polled while that one keeps failing.

**When it bites:** Kimodo runs out of GPU memory and the server marks the job {"status": "error"}, leaves it 'running', or its GET returns 500 because the result can't be serialized. Reproduced with the offline Builder: a job with status 'error' stayed in pending forever and logged a warning on every poll. With pending=[bad (500), good (done)] and max_pending=2, after 20 poll/post cycles only 'bad' had been polled; 'good' never completed and the queued spec was never posted. Six such jobs stop all generation for the rest of the night, and a --batches N run never exits.

**Suggested fix:** Give each pending job a deadline based on posted_at (for example 10 min): re-queue it once, then mark it rejected as 'timeout'. Treat unknown terminal statuses (error, failed) as rejected. On a per-job non-404 HTTP error, count it against that job and `continue` to the next; pause everything only for connection-level errors.

<a id="10"></a>
## 10. The name-leak check drops ordinary plain-combat specs (Left Hook, Right Cross, Quick Jab, Head Kick...)

high · unverified · Vaibhav · `agent/specs.py:197`

**What's wrong:** `leaked = [w for w in re.findall(r"[A-Za-z']+", name) if len(w) > 3 and w.lower() not in PLAIN_WORDS and re.search(rf"\b{re.escape(w)}\b", prompt, re.I)]` drops a spec when any name word longer than 3 letters that isn't in PLAIN_WORDS (:225-230) also appears in the prompt. PLAIN_WORDS lacks left, right, head, quick, straight, overhand, snap, rising and crescent, so plain prompts for the standard combat names are rejected. Running validate() on realistic specs: Left Hook, Right Cross, Left Jab, Quick Jab, Right Uppercut, Head Kick, Straight Right, Overhand Right, Snap Kick, Crescent Kick and Rising Knee all fail with 'kimodo_prompt repeats the name'. Quick Jab and Left Jab fail even with SYSTEM_PROMPT's own Good example ('...throws a quick punch forward with the left hand'), and Right Uppercut fails with Good example #1.

**When it bites:** The plain-combat theme is first in the rotation and appears twice per cycle. It tells Claude to 'use the ordinary name players will shout', and a large share of those specs is then dropped as invalid. Common shouts like 'left hook', 'right cross' and 'head kick' get no library entry of their own, which goes against CLAUDE.md's 'plain combat ... so common shouts always hit'. The Claude tokens spent on those specs are wasted.

**Suggested fix:** Add direction, body-part and common combat modifier words to PLAIN_WORDS (left, right, head, leg, foot, hand, arm, quick, fast, straight, overhand, snap, rising, crescent, ...). Alternatively, skip the leak check for the plain-combat theme and flag only fantasy name words.

<a id="11"></a>
## 11. Rounds that end on time (including draws) send no `round` event to phones or the Commentator

medium · confirmed · Sudeep · `client/src/game/flow.ts:141`

**What's wrong:** CLAUDE.md lists the game-to-phones messages as `event (hit, ko, round)`. endRound sends no event; the only `round` event that ever goes out is the sim's own, forwarded in onSim, and the sim emits it only after a KO. A round decided by the clock goes out silently, and the next thing phones see is `round_start`. A draw (winner null) can't be expressed as `{kind:"round"; winner: Player}` at all.

**When it bites:** A judge's round ends 40 HP to 25 on time. Phones and the server-side Commentator (which only sees the events the game sends) never learn who took the round: no "round won" on the phone, no narration. Confirmed in the t_timeout run: the only events sent were hit, ko and round_start.

**Suggested fix:** In endRound, when reason !== "sim", call `this.event({ kind: "round", winner })`. Add an agreed GameEvent for draws, e.g. `{kind:"round_end", winner:null}`.

> Re-check: The finding holds, with one correction to its wording.

**What the code does.** CLAUDE.md lists the game-to-phones messages as `event (hit, ko, round)`. Flow is the only part of the system that knows when a round runs out of time. The Sim interface has no timer and no round-start call, only `reset()` ("new match").

- `endRound()` (flow.ts:134-151) only calls the local `hooks.roundEnd` (HUD banner and sfx).
- After ROUND_END_MS, `endRound()` sends either `match_end` or, through `nextRound()`, `round_start`. It never sends a round-result event.
- Only three kinds of event leave the client: `round_start` (flow.ts:101, 126), `match_end` (flow.ts:147), and sim events forwarded at flow.ts:295.
- 

<a id="12"></a>
## 12. After a round ends on time, attacks already in flight still land and can KO the round winner

medium · confirmed · Sudeep · `client/src/game/flow.ts:159`

**What's wrong:** `this.endRound(h1 === h2 ? null : h1 > h2 ? 1 : 2, "time")` fixes the winner, but main.ts:243-244 keeps calling sim.step in every phase. Moves, projectiles and strikes already started keep resolving. onSim (293-298) forwards every hit and ko to the HUD and the phones without checking roundOver.

**When it bites:** Verified: P1 at 12 HP, P2 at 10 HP, P2's bolt in flight as the clock hits 0. At 3.20 s P1 wins the round on time. At 3.36 s the bolt hits for 25 and phones get `ko loser=1`, followed by the K.O. banner and slow-motion on the player who just won. Phones received hit and ko but no `round` event, so they conclude P2 won. Repro: `t_timeout.mjs`

**Suggested fix:** Once a round is decided on time, drop hit and ko events in onSim (send them neither to the hooks nor to the phones), or stop stepping the sim until nextRound resets it.

> Re-check: The code path is real, and I reproduced it in the running mock build.

1. When the timer runs out, flow.ts:159 calls `endRound(winner, "time")`. That sets the Flow's private `roundOver` and switches the phase to "roundEnd". Nothing tells the sim. The Sim contract has no way to say "round over"; `reset()` is documented as "new match" and is only called by nextRound() 3 s later.

2. main.ts:243-244 (`if (flow.simReady) { sim.step(dt);`) steps the sim in every phase, so moves already playing keep running. That includes projectiles in flight and pending strikes.

3. The StubSim gates `land()` and `updateStrikes()` on its own `roundOver` flag. Only its internal `knockOut()` sets that flag (stubSi

<a id="13"></a>
## 13. A phone re-joining mid-fight changes its fighter's look and name, but not the sim's character rules

medium · confirmed · Sudeep · `client/src/game/flow.ts:183` · reported by 2 reviewers

**What's wrong:** `join` is handled in every phase, and `const character = CHARACTERS.some((c) => c.id === m.character) ? m.character : prev?.character ?? ...` takes the phone's character whenever one is sent. That fires hooks.seats, which re-costumes the robot and renames the HUD, banners and snapshot seats. sim.init is not called again, so the sim keeps the lobby pick's multipliers.

**When it bites:** Verified: P1 picks Flicker in the lobby. Mid-fight, Pip's phone reconnects (screen lock or Wi-Fi drop) and re-sends `join {player:1, character:"bramble"}`. The robot is re-costumed as Sir Bramble and the plate reads "Sir Bramble, the Thorn Knight", but the sim still applies Flicker's rules (lightning 2x, 0.8x cooldowns). The next rematch quietly re-inits as Bramble. Repro: `t_rejoin.mjs`

**Suggested fix:** Accept m.character only when phase === "lobby" or the seat was empty. Otherwise keep prev.character.

Also reported as: “A phone that rejoins mid-fight changes the fighter's costume and HUD, but not the sim”

> Re-check: The code path works exactly as described.

1. `Flow.onRoom` handles `join` in every phase. At client/src/game/flow.ts:183 it takes `m.character` whenever it names a known character, and only falls back to `prev?.character` when it doesn't. Line 184 writes it into `seats[p]` and line 185 fires `hooks.seats`.
2. `hooks.seats` (client/src/main.ts:92-97) calls `robots[p].setCharacter(...)`. `RobotView.setCharacter` (client/src/render/robot.ts:131-137) disposes the costume and builds a new one, with no phase check. It also calls `hud.setPlayers(...)`.
3. Round banners (`name(p)` = `flow.characterOf(p).name`), the match-end screen, and the 10 Hz `state` snapshot all read `seats`. The snapshot is w

<a id="14"></a>
## 14. If a job's `charge` arrives after its `ready`, the fighter stays charging for the rest of the round

medium · confirmed · Sudeep · `client/src/game/flow.ts:267`

**What's wrong:** startCharging accepts any job, even one already in doneJobs. When pollJob then sees `done`, it calls finishJob, which hits `if (this.doneJobs.has(job)) return;` before `if (this.charging.get(p) === job) this.stopCharging(p)`, and pollJob exits. Nothing clears the charge until endRound or nextRound. A `charge` can land after its `ready` when the server sends them from separate tasks (e.g. a fast job that reuses an existing motion) or sends `charge` again.

**When it bites:** Sequence: `ready {player:1, job:"jx", move}`, then `charge {player:1, job:"jx"}`. Verified: the move itself fizzled ("busy casting"). Twelve seconds later P1 was still "charging" with canAct false and an endless "Summoning..." ring and charge loop, and every shout fizzled. Repro: `t_ready_first.mjs`

**Suggested fix:** In finishJob, clear the charge for `job` before the duplicate check returns. In startCharging, ignore a `charge` whose job is already in doneJobs.

> Re-check: The client-side mechanism is real, and I reproduced it twice.

1. `startCharging` (flow.ts:237-243) sets `charging[p] = job` without checking `doneJobs`.
2. When `pollJob` sees `done`, it runs `return this.finishJob(...)` (line 253). `finishJob` returns early at line 267 (`if (this.doneJobs.has(job)) return;`), before line 269 can call `stopCharging`.
3. Because `pollJob` exits through that `return`, the 30 s `JOB_TIMEOUT_MS` backstop never fires.
4. Nothing else clears the charge until `endRound`, `nextRound` or `toLobby`. The one exception is the player shouting a different wildcard, which gets a new job id.

Meanwhile StubSim refuses both `canAct` and `action` while charging (stubSim.ts:2

<a id="15"></a>
## 15. Re-initialising the sim leaves simReady true, so the frame loop keeps calling step/state while init() is still running

medium · confirmed · Sudeep · `client/src/game/flow.ts:316` · reported by 2 reviewers

**What's wrong:** startMatch sets phase "loading" and awaits `this.sim.init(this.idle!, chars)` when characters changed, but simReady stays true. main.ts:243 (`if (flow.simReady) { sim.step(dt); ... sim.state(p) ... sim.projectiles() }`) keeps driving the sim during an async init. The real MuJoCo WASM init will be async and may rebuild the model and data.

**When it bites:** P2 switches character in the lobby, then Enter. With init made async (800 ms), the loop made 25 step(), 50 state() and 25 projectiles() calls while init() was pending. A real sim stepped half-built can throw, and a throw in the loop freezes the game (next finding). Repro: `t_reinit.mjs`

**Suggested fix:** In ensureSim, set `this.simReady = false` before awaiting sim.init and set it back after; or have the loop skip the sim while flow.phase === "loading".

Also reported as: “init() runs again when the characters change while step()/state() keep running; not documented for the real sim”

> Re-check: The mechanism is real, but the finding needs one correction: nothing goes wrong today. It is a latent race that turns live once Sudeep's sim has an `init` that actually waits on a second call.

What the code does:
- `simReady` starts false (flow.ts:42). It is set true only at flow.ts:318 and never set back to false.
- When the characters changed, `startMatch` sets the phase to "loading" and awaits `ensureSim()`, which awaits `sim.init()`. `simReady` stays true the whole time.
- The frame loop checks only `flow.simReady` (main.ts:243). It does not check `flow.phase`, so it keeps calling `step`, `state` and `projectiles` while `init` is pending.
- The client already treats a pending `init` as 

<a id="16"></a>
## 16. Narrator cuts lines in their last second, often the spell name or the credit

medium · unverified · Sudeep · `client/src/audio/narrator.ts:92`

**What's wrong:** A line counts as stale by when it was queued (`at`), not when it started speaking. `say()` cuts the current line with `if (this.current && now - this.current.at > STALE_MS) this.cut();` (line 92). `check()` does the same with `else if (this.pending && now - line.at > STALE_MS) this.cut();` (line 184), on a timer armed at `cur.at + STALE_MS + 20` (line 127). A line that waited 1.5 to 3 s behind the previous one therefore starts, then gets cut 2 to 3.5 s later as 'old news'. Measured over one full mock match: 4 of 25 lines were cut mid-sentence. 'Sir Bramble unleashes Pip's signature spell, Gorilla Smash!' (4.1 s long) was cut at 3.0 s. 'The fairies write a new page: Gingerbread Avalanche, by Wren!' (4.6 s) was cut at 3.6 s. 'Our tale begins! … faces Hush, the Moon Wolf.' (5.8 s) was cut at 4.8 s. The comment in `say()` promises 'Never cut a line mid-sentence, unless it is already old news'. In practice it spends the airtime and then drops the punchline. This is the production path that speaks the server's Commentator lines.

**When it bites:** During a fast exchange, narrate lines arrive about 2.5 s apart and each takes about 3 to 4 s to say. A signature-move line waits about 2 s, starts speaking, and is cancelled 5 s after it was queued. The audience hears 'Sir Bramble unleashes Pip's signature spell, Gor—' and then the next line. The credit and spell name, which are the pitch's 'invented by <nickname>' moment, are lost.

**Suggested fix:** Decide whether to cut the line being spoken by how long it has been speaking: `now - (cur.started ?? cur.at) > STALE_MS` in say() and check(), with the check timer based on `started`. Keep `at` only for dropping a line that is still waiting. Old lines are then skipped before they start instead of being cut near their end.

<a id="17"></a>
## 17. motionMapper counts a freejoint entry in joint_names as a column, shifting every hinge by one and reading past the row (NaN)

medium · unverified · Sudeep · `client/src/g1/fk.ts:84`

**What's wrong:** `motion.joint_names.forEach((name, i) => { const j = this.joints.get(name); if (j && j.type !== "free") map.push([7 + i, j.qposAdr]); });`. The free-joint name is skipped, but `i` still advances. If the server builds joint_names from MuJoCo's joint list (`[m.joint(i).name for i in range(m.njnt)]` begins with "floating_base_joint") and sends normal 36-value qpos rows, every hinge reads its neighbour's column. The last hinge reads `frame[36]`, which is undefined. No warning comes from here because the name exists in the model; only checkMotion's length warning appears.

**When it bites:** I prepended "floating_base_joint" to a real Kimodo motion's joint_names and left the rows untouched. StubSim produced 490 NaN values on right_wrist_yaw_link over 70 steps, and the rest of the pose was garbled (hip pitch got hip roll's angle, and so on). On screen the right hand disappears. r_hand projectiles spawn at NaN and fly invisibly for 3 s. Melee hit points get NaN z.

**Suggested fix:** Advance the column only for non-free names: `let col = 7; for (const name of joint_names) { const j = this.joints.get(name); if (j?.type === "free") continue; if (j) map.push([col, j.qposAdr]); col++; }`. Optionally also check `row.length - 7` against the count of non-free names.

<a id="18"></a>
## 18. After a match that ends in a KO, the lobby shows the KO'd robot on the floor and an off-center camera

medium · unverified · Sudeep · `client/src/game/flow.ts:109`

**What's wrong:** `toLobby() { this.gen++; this.stopCharging(); this.setPhase("lobby"); }` never calls sim.reset(), and main.ts keeps stepping the sim in the lobby. The loser therefore stays `ko` (StubSim only clears ko in restart()), and the side camera, which follows both chests in stage.render, stays zoomed out and shifted. The lobby layout assumes the fresh framing: screens.ts:39 places the seat plates using fixed `CAM_DIST = 3.67, HEAD_X = 0.592`. Measured after Match end → "Lobby" at 1280×720: P2 was still "ko" 8 s later. The camera was at (0.70, 1.21, 4.72) instead of the fresh (0, 1.26, 3.65). P1's chest was at x=369 px, half hidden behind the left Join page (18–357 px), and P2 lay under the character cards. The seat plates hang over empty forest, and A/D or J/L re-dress robots nobody can see. Screenshots: fresh `melobby/1280-lobby-fresh.png` vs after `melobby/1280-lobby-after-matchend-later.png`; at 1920: `sigko1920/15-lobby-after-esc-pickD.png` and `w1920/84-lobby-after-esc2.png`

**When it bites:** Most matches end on a KO. The operator presses Esc or clicks "Lobby" for the next pair of players. The lobby's centerpiece (two automatons under the seat plates, with the costume swapping live as they pick) stays broken until the next match starts.

**Suggested fix:** In toLobby(), call `if (this.simReady) this.sim.reset();` so both fighters stand at home and the camera reframes. Optionally also clear slowmo/koZoom in main.ts's lobby phase hook.

<a id="19"></a>
## 19. Idle loop wraps from the last frame to the first with no blend, so a real (non-seamless) idle pops every loop

medium · unverified · Sudeep · `client/src/mock/sim/clip.ts:50`

**What's wrong:** `if (loop) f = ((f % n) + n) % n;` with `const i1 = loop ? (i0 + 1) % n : ...` interpolates from frame n-1 straight to frame 0 within one frame. The mock idle is seamless by construction: bake() drops the last frame of a loop and every mod term is 0 at t=0. A Kimodo-generated idle from GET /idle will not be seamless. Its root drifts and its joints end somewhere other than where they started. StubSim.pose() calls `this.idleClip.sample(f.idleT, true, ...)` whenever a fighter isn't acting, which is most of the time on screen.

**When it bites:** I used real Kimodo crops as the idle through StubSim.init and stepped at 60 Hz. At each wrap the pelvis jumped 150-348 mm, the hand 138-320 mm and the yaw up to 18.5 deg, against a median step of 1.5-7.5 mm. The mock idle's worst step is 1.1 mm. These crops are locomotion, so the numbers are an upper bound, but any stance clip twitches at every wrap by however far its last frame is from its first: every 2-5 s for each idle fighter.

**Suggested fix:** Crossfade the seam: over the last ~0.25 s, blend each sampled frame toward the matching frame at the start of the clip. Also re-base each loop's root drift (subtract last-minus-first root xy and yaw, scaled by loop phase). Or play the idle ping-pong.

<a id="20"></a>
## 20. `down` fires when the pelvis first crosses 0.4 m, not after 2 s below it as CLAUDE.md defines a knockdown

medium · unverified · Sudeep · `client/src/mock/stubSim.ts:364`

**What's wrong:** `if (f.fall && !f.fall.downSent && f.pelvisZ < R.DOWN_PELVIS_Z) { ... emit({ kind: "down" ... }) }`. The comment says "CLAUDE.md: knockdown = pelvis below 0.4 m", which drops the spec's "for 2 s". rules.ts L25 reuses the 2 s as how long the stub robot lies there (DOWN_S). Status also becomes "down" at the moment of the hit, before the pelvis is low. main.ts's `down` handler plays a floor-impact effect: dust at the feet, a thud sfx, `stage.shake(0.04)` and a 'Down!' float. Those are tuned to the stub's timing.

**When it bites:** Scripted test: the hit lands at t=0.767, `down` fires at t=1.2 (the first frame below 0.4 m), and the robot gets up at t=4.0, after only 2.32 s below 0.4 m. A real sim that follows CLAUDE.md fires `down` about 2 s after the robot lands, so the shake and thud play while it lies still. If physics or a balance assist brings the robot back up within 2 s, `down` never fires at all. HUD and effects built against the stub will be mistimed or missing.

**Suggested fix:** Accumulate time with pelvisZ < DOWN_PELVIS_Z and emit `down` once it reaches 2 s. Lengthen LIE_END so a stub knockdown reliably meets the 2 s rule. Report status "down" from that point, or document that the stub's event marks the impact so the effects code can be adjusted.

<a id="21"></a>
## 21. KOs from strike moves white out the screen during the slow-motion fall

medium · unverified · Sudeep · `client/src/render/effects.ts:574`

**What's wrong:** strikeImpact() (lines 574-586) stacks several bright effects at once: `paint.flash(x, 0.3, z, 0.8 * ks, P.core, ...)`, `paint.flash(..., WHITE_GOLD, 0.8, ...)`, `paint.burst(fl, x, 0.25, z, 0.9 * ks, P)`, a 2.2·ks groundRing at 1.4 opacity, a 6 m bolt for wisp/fairy, and `this.light(x, 0.5, z, P.light, 5 * ks, 0.4)`. The sim's `hit` event at the same moment adds effects.hit() (main.ts:157), which is another full burst plus a light, and ringFlare on top. Then `ko` sets `slowmo = 1.6`, which scales dt by 0.3 (main.ts 186, 238), so everything stays on screen 3.3× longer under bloom (threshold 0.62, stage.ts:47). I measured mean luminance of the 3D view only (HUD bands excluded), with the defender at 3 HP. Baseline was 0.32. Frostbite Crown KO peaked at 0.60 and stayed more than 0.12 above baseline for about 1.6 s. Stormcaller's Crash KO peaked at 0.64, with 30% of pixels near-white. For comparison, a melee KO peaked at 0.50 and a projectile KO at 0.47. An in-page A/B test showed the bursts are the largest contributor: removing them dropped the frost peak from 0.534 to 0.452. Screenshots: `kocmp/ice-strike-peak.png`, `kocmp/lightning-strike-peak.png`, `frost1280/019-frostko-08.png`

**When it bites:** Any KO with a strike move, such as Frostbite Crown, Stormcaller's Crash or Cinder Comet, or wildcards like Gingerbread Avalanche or Goose That Lays Thunder. The center of the screen turns into a white blob during the slow-motion fall, so the audience never sees the robot topple, which is the moment CLAUDE.md says must be a real, visible fall.

**Suggested fix:** Avoid the double burst: skip or scale down effects.hit()'s burst when a strike impact fires at the same spot. Cut the strike light peak (5·ks) and the burst k. And/or clamp effect brightness during slowmo, or don't stretch impact-flash particles by the slow-motion factor.

<a id="22"></a>
## 22. The beam shader's pow(1.0 - h, uFade) returns NaN when vUv.y > 1. This, not the MSAA target, caused the whole-frame black frames

medium · unverified · Sudeep · `client/src/render/fx/meshes.ts:104`

**What's wrong:** `float vert = pow(1.0 - h, uFade) * smoothstep(0.0, 0.03, h);`: h = vUv.y is exactly 1.0 on the cylinder's top ring, and uFade is a uniform, so the compiler cannot fold the pow. On the demo GPU (ANGLE Metal, Apple M5 Pro), a raw WebGL probe gives NaN for pow(negative, uniform): pow(-1e-6, 1.4) and even pow(-0.5, uE=2.0) are NaN, while the literal pow(-0.5, 2.0) gives 0.25. With a multisampled target, the shader runs at the pixel center even when only some samples are covered, so vUv.y extrapolates slightly above 1 along the top edge and the pixel becomes NaN. `uOpacity * NaN` is still NaN, so this happens even at opacity 0. UnrealBloom's blur chain then smears the NaN over the frame, and OutputPass shows black.

Measured on the live scene in a 4x MSAA HalfFloat target: 435 NaN px with the charging column up, 1083 px with a shockwave wall, 0 with the beams hidden. Across a mock match, 35 of 213 sampled frames had NaN under MSAA, all with a beam visible and none without. The shipped no-MSAA path had 0 NaN, and the HDR max was 305, so there is no half-float overflow. Putting a 4x MSAA composer target back at runtime with a charging column up gives a 100% black canvas (scratchpad/review/msaablack/2-msaa-column.png); once the column is gone the frame is normal again. The comment at stage.ts:43 blames the MSAA target. The current path only avoids the NaN because pixel centers stay inside the triangle.

**When it bites:** Someone restores `samples: 4` to get rid of SMAA's softer edges, or a different GPU's interpolation overshoots 1.0 at the top edge of a beam. Every charging column (live wildcard), shockwave wall, strike pillar and KO column then blacks out the whole canvas for as long as it is up, which means seconds at a time during exactly the demo moments.

**Suggested fix:** `float vert = pow(max(1.0 - h, 0.0), uFade) * smoothstep(0.0, 0.03, h);` (or clamp h). After that the MSAA composer target can come back: no NaN appeared under MSAA with the beams hidden. Fix the stage.ts comment too. While in there, write the negative-base squares as x*x: ring.ts:26 `pow((d - since * 2.6) / 0.4, 2.0)`, lights.ts:81 and sky.ts:140. GLSL leaves pow(x<0, y) undefined, and these only work here because the literal 2.0 gets folded into a multiply.

<a id="23"></a>
## 23. Hand-off notes leave out the fighter layout the renderer and UI assume (P1 at MuJoCo -X facing +X)

medium · unverified · Sudeep · `client/src/render/stage.ts:76`

**What's wrong:** The side camera sets its distance from `gap = Math.abs(a.x - b.x)` and looks along MuJoCo +Y. The HUD corner plates put P1 on the left, the lobby seat plates (screens.ts `HEAD_X`, `--x1`) are fixed left/right, and the viewer places its target at +X. All of these assume the fighters sit on the MuJoCo X axis with P1 at x = -0.6. That is written only in the StubSim header ("Fighters start 1.2 m apart on the MuJoCo X axis, P1 facing +X") and in arena/palette.ts. It is missing from client/README.md "For Sudeep", which covers only body names and coordinate conventions.

**When it bites:** Sudeep's sim puts the fighters on the Y axis: gap is about 0, the camera sees them end-on with one robot hiding the other, and the HUD anchors overlap. Or it puts P1 at +X: P1's corner plate, lobby nameplate and character pick all sit on the opposite side from P1's robot.

**Suggested fix:** Add to README "For Sudeep": fighters on the MuJoCo X axis, P1 at (-0.6, 0) facing +X, P2 at (+0.6, 0) facing -X. Alternatively, have the camera and HUD work out the axis and sides from `state().bodies`.

<a id="24"></a>
## 24. The K.O. banner covers the move name and "invented by <nickname>" at the KO moment

medium · unverified · Sudeep · `client/src/ui/hud.ts:347`

**What's wrong:** On `ko`, main.ts:189 calls `hud.banner("K.O.", undefined, 2200)`. banner() (hud.ts 347-360) shows a 9.5rem title at `top: 40%` (style.css:230). The banner element is appended after `.over` (hud.ts 111-112), so it paints on top of the move flash, and the flash (FLASH_MS 1650) is still showing because KOs land at hit_frame, about 0.3–0.6 s into it. Nothing drops the flash. Measured at 1280×720 during a signature KO: flash name box [333,209,908,272], credit "invented by Pip" [333,303,908,331], K.O. title [492,208,788,331], so they overlap completely for about 1.2 s. Normal KOs do the same (WISP LASH), and "Dodged!"/"Blocked!" float texts also land on the flash. Screenshots: `sigko1920/02-sigko-1.png`, `sigko1280/03-sigko-2.png`, `longnick/1280-hud-longnick-ko.png`, `misc1280/10-dodge-350-1.png`

**When it bites:** This hits the demo moment "a signature move landing with a real fall". Pip shouts Gorilla Smash and it KOs. The red "K.O." sits on top of "GORILLA SMASH / MIGHT / invented by Pip", and neither is readable for the rest of the flash, so the credit CLAUDE.md wants on screen disappears exactly then.

**Suggested fix:** When the K.O. banner shows, fast-drop the active flashes (drop(flash[p], true)) or delay the banner until the flash ends. Alternatively, move the KO banner lower (around top 58%) or put .over above .banner.

<a id="25"></a>
## 25. A spec is lost if anything other than ServerError escapes the POST (Ctrl-C, SIGTERM, IncompleteRead)

medium · unverified · Vaibhav · `agent/builder.py:293`

**What's wrong:** post_some removes the item first (`self.state.queue.remove(item)`), then calls generate() guarded only by `except ServerError` (:297). _on_sigterm raises KeyboardInterrupt anywhere in the main thread. Server._req wraps only URLError, TimeoutError, ConnectionError and JSONDecodeError (server.py:41), so http.client.IncompleteRead (or any HTTPException) and UnicodeDecodeError pass through unwrapped. In each case the item is in neither queue nor pending, and the next save (shutdown() saves at :419) makes the loss permanent. Separately, a POST that times out after 15 s but was accepted by the server gets re-posted, creating a second job and move with the same name.

**When it bites:** Reproduced: with generate() raising KeyboardInterrupt, IncompleteRead or UnicodeDecodeError, the saved state had queue=0 and pending=0. The spec is gone and never generated, despite the docstring's claim that 'a restart resumes where it stopped'. Realistic triggers: `kill <pid>` or Ctrl-C while a POST is in flight, or uvicorn dying mid-response.

**Suggested fix:** Wrap the POST in try/except BaseException that puts the item back before re-raising, or leave the item in the queue marked as posting until it has been saved into pending. Broaden _req's except clause to http.client.HTTPException, OSError and ValueError.

<a id="26"></a>
## 26. A waiting spec whose twin has the identical prompt matches itself and is never posted

medium · unverified · Vaibhav · `agent/builder.py:315`

**What's wrong:** `if wait in self.failed_prompts or not any(p["spec"]["kimodo_prompt"] == wait for p in self.state.queue + self.state.pending):` scans the queue including the waiting item itself. When the waiter's prompt is identical to its twin's (common for a twin at 0.95 or above), the 'twin gone' branch can never fire. Only failed_prompts can release it, and failed_prompts is not saved across restarts (:120) and is not filled when a job is lost twice (:332-333).

**When it bites:** Reproduced: (a) after a restart following the twin's rejection, which happens while pending is full, `_next_postable()` returns None and `finished()` stays False; (b) when the twin's job returns 404 twice, the twin is dropped as 'lost', failed_prompts lacks its prompt, and the waiter is never posted. The spec is never generated and a --batches N run never exits.

**Suggested fix:** Exclude the item itself and other waiters: `not any(p is not item and not p.get("wait_for") and p["spec"]["kimodo_prompt"] == wait for p in ...)`. Also add the prompt to failed_prompts on the lost-twice path.

<a id="27"></a>
## 27. --dry-run still POSTs specs left in the saved queue

medium · unverified · Vaibhav · `agent/builder.py:403`

**What's wrong:** Only make_batch checks dry_run (`if not self.args.dry_run: self.state.queue.append(item)`, :275). run() calls self.post_some() and self.poll_some() unconditionally (:403-404), and post_some has no dry-run guard. The README says --dry-run 'posts nothing' (README.md:15, :42).

**When it bites:** Reproduced: a state file with one queued spec ('Troll Stomp'), run with `--offline --dry-run --batch-size 5`, logged "kept 'Troll Stomp' ... -> mv_0001". Real case: Jerry stops a `--batches 1 --batch-size 20` run with Ctrl-C because the motions look bad, edits SYSTEM_PROMPT, and runs --dry-run to check the new prompt. The dry run sends the leftover specs from the old prompt to the GPU, and they enter the shared library.

**Suggested fix:** Skip post_some and poll_some in dry-run mode, or refuse to start a dry run while the queue or pending list is non-empty.

<a id="28"></a>
## 28. The README's assumed `state` message leaves out `seats`

low · unverified · Sudeep · `client/README.md:74`

**What's wrong:** Every `state` push includes `seats: {1: {nickname, character}, 2: ...}` (contract.ts:81-84, flow.ts:335-337). Characters are picked only on the game screen, and the flow.ts comment says this is how the server's Commentator and the phones learn them. The README's assumed list still says `state {round, timer, wins, players}`.

**When it bites:** The server owner builds the Commentator from the README's contract list, doesn't know about `state.seats`, and narrates with default or missing character names (e.g. "Sir Bramble" when P1 picked Marigold).

**Suggested fix:** Add `seats {nickname, character}` to the README's `state` line and to the contract proposal.

<a id="29"></a>
## 29. Drawn rounds stretch "best of 3" without limit

low · unverified · Sudeep · `client/src/game/flow.ts:159`

**What's wrong:** On time-out with equal HP, `endRound(null, "time")` records no win and the next round starts. The match ends only when `wins[p] >= ROUNDS_TO_WIN`, so draws add extra rounds with no cap, against CLAUDE.md's "Best of 3 rounds, 60 s each".

**When it bites:** Two judges who never land a hit are both at 100 HP after 60 s: "A draw!", then round 4, 5 and so on. The narrator calls round 3 "the final chapter" even though more rounds follow.

**Suggested fix:** After round 3, end the match: pick the player with more round wins, or decide by remaining HP or sudden death.

<a id="30"></a>
## 30. Nickname truncation splits emoji and leaves broken UTF-16 in the UI and in state pushes

low · unverified · Sudeep · `client/src/game/flow.ts:184`

**What's wrong:** `nickname: (m.nickname || prev?.nickname || `Player ${p}`).slice(0, 24)` cuts at 24 UTF-16 code units. An emoji that straddles position 24 leaves a lone high surrogate. Joining with 'ABCDEFGHIJKLMNOPQRSTUVW😀' produced the seat text 'ABCDEFGHIJKLMNOPQRSTUVW\ud83d', which shows as '�' in the lobby seat, the card tag, the HUD plate and the match-end title. A phone or server that counts 24 code points (Python `len`) also gets names with emoji shortened. The broken string goes into every 10 Hz `state` push (`seats[p].nickname`). JSON.stringify escapes it as `\ud83d`, and a Python server that decodes and re-encodes that as UTF-8 raises 'surrogates not allowed'.

**When it bites:** A player names themselves '🔥🔥🔥 DragonSlayer 🔥🔥🔥' (26 UTF-16 units). The game screen shows '🔥🔥🔥 DragonSlayer 🔥�' on the plate and on the match-end screen, and sends the lone surrogate to the server 10 times a second.

**Suggested fix:** Truncate by code points or graphemes, for example `Array.from(nick).slice(0, 24).join("")` (or Intl.Segmenter for grapheme clusters).

<a id="31"></a>
## 31. Wildcard shout loudness is lost when the poll beats the `ready` push

low · unverified · Sudeep · `client/src/game/flow.ts:253`

**What's wrong:** In the assumed contract, `charge` carries no loudness and GET /job has none either, so loudness arrives only on `ready`. When `pollJob` sees done first, it calls `finishJob(p, job, r.move, r.motion)` without loudness, and `play()` falls back to 0.5. The later `ready` is ignored because of `doneJobs`. The mock deliberately avoids this race ("so a /job poll never beats the push").

**When it bites:** The real server marks the job done. A 250 ms poll already in flight returns `done` before the `ready` push arrives, and a full-volume wildcard plays at loudness 0.5 (damage factor 1.0 instead of 1.2).

**Suggested fix:** Put `loudness` on `charge` (store it per job in `startCharging`) and pass the stored value when the poll finishes the job.

<a id="32"></a>
## 32. A lost job (e.g. 404 after a server restart) leaves the fighter charging and unable to act for 30 s

low · unverified · Sudeep · `client/src/game/flow.ts:258`

**What's wrong:** pollJob treats every error, including a 404 for a job the server no longer has, as `catch { /* keep waiting for the push */ }` until JOB_TIMEOUT_MS = 30000. While charging, the sim refuses to act (canAct depends on status), and the phone has no way to cancel.

**When it bites:** The server restarts mid-charge (e.g. uvicorn --reload during the hackathon) and /job/{id} returns 404. Verified: P1 stayed "charging" with canAct false for 30.15 s (timer 59 to 29), half the round, then fizzled "the spell took too long". Repro: `t_job404.mjs`

**Suggested fix:** Have getJson expose the HTTP status. Treat 404 or 410 from /job/{id} as rejected: stop charging and fizzle immediately. Also give up after a few consecutive errors.

<a id="33"></a>
## 33. A sim `round` event that arrives with `ko` ends the round at once, skipping the KO pause

low · unverified · Sudeep · `client/src/game/flow.ts:300`

**What's wrong:** onSim calls `this.endRound(e.winner, "sim")` as soon as `round` arrives, while KO_TO_ROUND_MS (2600 ms) exists to "let the real fall play out". The contract gives no timing for `round`, and a sim that emits it in the same step as `ko` is a natural implementation.

**When it bites:** Verified with a sim emitting ko and round in one batch: the "K.O." banner is replaced in the same tick by "Sir Bramble wins the round", and the KO'd robot is reset 3.0 s after the KO instead of about 5.6 s. Repro: `t_ko_round.mjs`

**Suggested fix:** While a KO timer is pending, hold the sim's round result until the timer fires, or ignore `round` and let the KO timer end the round.

<a id="34"></a>
## 34. Round-end banner can't tell players apart in a mirror match

low · unverified · Sudeep · `client/src/main.ts:108`

**What's wrong:** `hud.banner(winner ? `${name(winner)} wins the round` : "A draw!", …)` uses `name = (p) => flow.characterOf(p).name`, the character name. The lobby lets both players pick the same automaton (pickCharacter has no uniqueness check, and style.css has `.card.sel1.sel2` for that case). In a mirror match the banner says 'Sir Bramble wins the round', which doesn't say which player won.

**When it bites:** Both players pick Sir Bramble. Round 1 ends with the banner 'Sir Bramble wins the round', and the audience can't tell whether Pip or Wren took it.

**Suggested fix:** Use the winner's nickname, or add it when both seats have the same character: `${flow.seats[winner]?.nickname ?? name(winner)} wins the round`.

<a id="35"></a>
## 35. `effect: "none"` is never honored; plain-combat moves get a type effect anyway

low · unverified · Sudeep · `client/src/main.ts:118`

**What's wrong:** `const effect = move.effect && move.effect !== "none" ? move.effect : TYPE_EFFECT[move.type];`, and `effectOf()` in effects.ts:919-920 also maps "none" to the type effect. CLAUDE.md lists `none` as a valid effect tag. Jerry's own agent prompt (agent/specs.py:40) tells Claude "none (a plain body hit)... none suits plain combat".

**When it bites:** The overnight plain-combat moves written so common shouts always hit ("Jab": physical, effect none) play a thorn_burst of petals on screen. The agent's effect choice has no effect.

**Suggested fix:** Treat "none" as no cast flourish (skip `effects.cast` or show a minimal impact). Use the TYPE_EFFECT fallback only for missing or unknown tags.

<a id="36"></a>
## 36. Captions appear when lines arrive, not when they are spoken; dropped lines still get captioned

low · unverified · Sudeep · `client/src/main.ts:135`

**What's wrong:** `narrate(text) { narrator.say(text); hud.caption(text); }` shows the caption right away. Narrator.say may queue the line behind another, drop it when a newer one replaces it, or drop it as stale. hud.ts:334 says the caption is 'shown as a caption while it is spoken'. Its lifetime `Math.min(7500, 2400 + t.length * 60)` starts on arrival. In one mock match, 3 of 25 captions were never spoken at all (for example 'Hush tumbles! Will the Moon Wolf rise again?'). Others started speaking up to 3 s after their caption appeared. 'Alas, Hush is down!' (caption at 48.6 s, voice at 51.3 s) faded out halfway through its own audio.

**When it bites:** A KO line is being spoken when a 'move' line arrives. The caption switches to the move line while the voice is still reading the KO line. If a third line then replaces the move line in the queue, the move line was shown but never spoken, and the third line's caption appears seconds before its audio.

**Suggested fix:** Have Narrator.say accept an onStart callback fired from `u.onstart`, and call hud.caption from it. Show the caption immediately only when speech is unavailable or muted.

<a id="37"></a>
## 37. KO and knockdown effects are timed from rule events and wall-clock time instead of the physical fall

low · unverified · Sudeep · `client/src/main.ts:192`

**What's wrong:** CLAUDE.md says the robot really falls, then its runes fade and fairy dust drifts up. Instead:
- robot.ts:155 `this.koFade = state.status === "ko" ? Math.min(1, this.koFade + dt * 0.6) : 0;` starts dimming the runes on the frame HP reaches 0, while the robot is still upright.
- main.ts:192 `setTimeout(() => effects.ko(robots[loser].feet(), ...), 1200)` waits 1200 ms of real time. The KO slow-mo runs the sim at 0.3x for 1.6 s, so only 0.36 s of sim time has passed by then: the stub's 0.5 s fall is about 45° along, and a real MuJoCo topple takes longer. effects.ko then pins the glow pool and light column at that mid-fall pelvis position (effects.ts:242 `const cx = at.x, cz = at.z`).
- The `down` handler (main.ts:179-181: dust burst, shock ring, `stage.shake(0.04)`) is written as a landing effect. But CLAUDE.md defines a knockdown as the pelvis below 0.4 m for 2 s, and the stub emits `down` the instant the pelvis crosses 0.4 m (stubSim.ts:364), so the mock hides the fact that the real event may arrive 2 s after impact.

**When it bites:** On a KO, the runes are already dimming as the blow lands. Fairy dust and the glow pool start before the robot reaches the floor and sit to one side of where it lands. On a knockdown against the real sim, nothing happens when the robot hits the ground; then, 2 s later, a dust burst and screen shake play on a motionless robot.

**Suggested fix:** Drive the fall effects from the render side. In RobotView, track pelvis height every frame. After a KO, start koFade and call effects.ko when the pelvis first drops below about 0.35 m. Spawn the landing dust and shake when the pelvis crosses that height moving downward, and keep the `down` event for the HUD text only. Place the KO pool and column at the landed pelvis, or have them follow the fighter's pelvis each tick.

<a id="38"></a>
## 38. Mock server narrates moves and adds live moves to the library even when the game ignored or rejected them

low · unverified · Sudeep · `client/src/mock/server.ts:98`

**What's wrong:** Keyboard shouts call `play()` and `wildcard()` regardless of phase. play() bumps `uses` and narrates (signature and live moves always, others 30% of the time). wildcard() later does `playerMade.push(move); addToStats("live", ...); narrate(...)`. Flow drops `play`/`ready` outside the fight phase and fizzles moves the sim rejects. The mock never learns that.

**When it bites:** Verified live. In the lobby, pressing 7 makes the narrator say 'Gorilla Smash! Forged by Pip, and fiercer for it!'. Pressing T shows 'A brand-new spell, born this very moment: Cauldron Cannonball!' and bumps the live count and the leaderboard, though nothing was cast. Mid-fight, a fizzled shout is still announced as cast.

**Suggested fix:** Gate keyboard shouts and wildcards on `fighting()`, which already exists. Only add or narrate a wildcard if the round that started it is still running.

<a id="39"></a>
## 39. Fight outcomes depend on frame rate even though the stub is described as deterministic

low · unverified · Sudeep · `client/src/mock/stubSim.ts:549`

**What's wrong:** step(dt) runs on the raw frame delta. resolveHit fires on the first step where `pl.t >= pl.hitT` and judges range and the clean hit (`nearHeadOrChest`, 0.3 m) on that step's pose, which can be up to dt (50 ms) past hit_frame. P1 is also always resolved before P2 (`this.resolveHit(a); this.resolveHit(b);`). A knockdown from P1's hit cancels P2's same-frame hit through interrupt().

**When it bites:** Same scripted ice mo_hook melee on Rime vs Rime. At 144 Hz it scores 'hit 20 clean'; at 60, 30 and 20 Hz it scores 'hit 16 plain'. A 120/144 Hz laptop panel and a 60 Hz projector give different damage for the same input. KO slow-motion (dt x 0.3) changes outcomes too.

**Suggested fix:** Step the sim internally at a fixed rate (e.g. a 120 Hz accumulator in step()). Or judge the hit on a pose sampled at exactly hitT instead of the current frame's pose.

<a id="40"></a>
## 40. A playing defend move reports status "blocking", so a shout during it fizzles with the wrong reason, "not enough energy"

low · unverified · Sudeep · `client/src/mock/stubSim.ts:757`

**What's wrong:** status() checks `if (f.blocking) return "blocking";` before `if (f.play) return "acting";`. The `blocking` getter (L155-157) is true while a defend move plays. canAct is false because `f.play` is set. flow.whyNot (flow.ts L283-290) only treats acting/charging as busy, so it falls through to its last branch: "not enough energy".

**When it bites:** Verified in the live mock game. P1 presses 5 (Briar Guard, a defend move), then 1 (Bramble Bash) 150 ms later with 87 energy. The HUD shows 'The magic fizzles — not enough energy'.

**Suggested fix:** Make whyNot treat "blocking" as busy. A stronger option: if `!sim.canAct(p)` without a move, say 'busy casting', and only blame cooldown or energy otherwise. Or report "acting" for a playing defend move in the stub.

<a id="41"></a>
## 41. Live wildcard: the fading "Summoning…" label shows through the new move name

low · unverified · Sudeep · `client/src/ui/hud.ts:272`

**What's wrong:** When the job finishes, flow turns charging off first: hud.charging(p, null, false) runs `this.drop(this.charge[p], false)`, which starts a 0.42 s "gone" fade. flashMove then puts the new flash at the same overhead anchor, so for about 0.4 s "SUMMONING… “Teapot Tempest”" and the giant "TEAPOT TEMPEST" (or "Spinning Wheel of Doom") are drawn on top of each other and read as garbled text. Screenshots: `mom1280/010-p1wild-02.png`, `mom1280/029-p2wild-01.png`

**When it bites:** This hits the demo moment "a live wildcard": after T/H in mock or a real `ready` message, the payoff frame shows two layers of text on top of each other.

**Suggested fix:** In flashMove, remove any charge element still fading for that player immediately (add gone-fast or remove it). Alternatively, use drop(..., true) when charging turns off because the move arrived.

<a id="42"></a>
## 42. The other fighter's move flash jumps sideways mid-animation when one flash ends

low · unverified · Sudeep · `client/src/ui/hud.ts:438`

**What's wrong:** While both fighters have a flash, `place()` keeps each one in its own half of the screen (`if (t.kind === "flash" && this.flash[t.p === 1 ? 2 : 1]) { … lo = Math.max(lo, W * 0.5 + 0.4 * rem); }`, lines 472-475). When one flash expires, `drop()` removes it (`if (t.kind === "flash" && !fast) { t.el.remove(); return; }`). On the next frame the remaining flash loses the half-screen limit and snaps to its unclamped position, with no transition. Measured at 1280x720: P2's flash for a 38-character name moved from x=645 to x=501 in one frame, about 960 ms into its 1650 ms life.

**When it bites:** P1 casts, and P2 casts 0.7 s later with a long spell name. When P1's flash times out, P2's giant name jumps 144 px to the left while still fully visible.

**Suggested fix:** Apply the half-screen limit only when a flash is first placed (remember its x), or ease x toward the new target over a few frames instead of snapping.

<a id="43"></a>
## 43. Bidi control characters in a nickname reverse the match-end title

low · unverified · Sudeep · `client/src/ui/screens.ts:96`

**What's wrong:** `v.title.textContent = `${w.nickname} wins the duel!`` puts the phone-supplied nickname and the fixed text in one text node with no bidi isolation. A nickname containing U+202E (RIGHT-TO-LEFT OVERRIDE) or similar controls flips the rest of the sentence. A nickname of 'Bob‮' rendered as 'BOB!LEUD EHT SNIW' on the projector (checked with a screenshot). Server-written captions that contain nicknames have the same problem (hud.caption puts the whole line in one node).

**When it bites:** A prankster joins as 'Bob‮' and wins. The match-end screen reads 'BOB!LEUD EHT SNIW' in giant letters instead of 'Bob wins the duel!'.

**Suggested fix:** Isolate the name: `v.title.replaceChildren(h("bdi", "", w.nickname), " wins the duel!")`, or give name spans `unicode-bidi: isolate`. Also strip U+202A–U+202E and U+2066–U+2069 from nicknames when players join.

<a id="44"></a>
## 44. The narrator caption hides both fighters' feet

low · unverified · Sudeep · `client/src/ui/style.css:223`

**What's wrong:** `.caption { position: absolute; left: 0; right: 0; bottom: 5.7rem; ... }` puts the caption at y≈598–647 px at 1280×720 (≈900–974 at 1920×1080), spanning x≈330–950. The fighters' ankles project to y≈602–624, x 430–837, so every caption hides the feet. That includes the round-start line (on screen about 6–7 s, since it lasts 2.4 s + 60 ms per character) and the KO/down lines, so jumps, stomps, kicks and footwork are covered. Screenshots: `taps/p1-jump-1.png` (P1 mid-jump with its feet hidden), `misc1280/02-block-150-1.png`

**When it bites:** A round starts and the narrator's opening line stays up for about 6 s while players tap jump or dodge. The feet leaving the ground, which is what shows a jump, are hidden behind the parchment.

**Suggested fix:** Move the caption out of the fighters' band, for example to just above the screen edge (bottom ≈0.6rem) with the library ribbon moved to a corner, or to top-center under the timer medallion.

<a id="45"></a>
## 45. README step 3 does not generate the dry-run specs that were just reviewed

low · unverified · Vaibhav · `agent/README.md:18`

**What's wrong:** README says: '3. `./run.sh --batches 1 --batch-size 20` generates those 20 for real.' Dry-run specs are never queued (builder.py:275), and the dry run advanced and saved theme_index (builder.py:198, :277). Step 3 therefore makes a fresh Claude call on the next theme.

**When it bites:** Following CLAUDE.md's 'generate 20, look at all 20, fix the template', Jerry approves 20 plain-combat specs in the dry run. Step 3 then generates 20 different, unreviewed knights-and-dragons specs.

**Suggested fix:** Add a way to queue a reviewed batch (for example `--from-batch N`, reading batches/batch_N_*.json), or correct the README and use `--theme` to fix the theme during the review loop.

<a id="46"></a>
## 46. Batch review files mark in-batch duplicates as kept or rejected

low · unverified · Vaibhav · `agent/builder.py:84`

**What's wrong:** `Review.update()` matches records by `r["spec"]["name"] == name`. A spec dropped as a duplicate of an earlier spec in the same batch keeps its `spec` (`records.append({"spec": spec, "outcome": "dropped: duplicate (...)"})`). When the original is kept or rejected, both records are overwritten, and the duplicate also gets the `move` field that the viewer reads.

**When it bites:** In an offline run of 30 specs, records 20 and 28 (originally "dropped: duplicate") became "kept (mv_0004, mo_0004)" and "kept (mv_0006, mo_0006)". The batch file listed 20 kept while log.txt said 18, and the motion viewer lists those motions twice. This misleads the "look at all 20" review.

**Suggested fix:** Store the record index on each queued item (e.g. `item["rec"] = len(records) - 1`) and update by index, or skip records whose outcome starts with "dropped".

<a id="47"></a>
## 47. Review.update overwrites dropped-duplicate rows that share the kept spec's name

low · unverified · Vaibhav · `agent/builder.py:85`

**What's wrong:** `for r in doc["records"]: if r.get("spec") and r["spec"]["name"] == name: r["outcome"] = outcome` matches every record with that name, including in-batch duplicates recorded as {"spec": spec, "outcome": "dropped: duplicate (...)"} (:242).

**When it bites:** Claude returns 'Uppercut' twice in one batch and the second is dropped as a duplicate. When the first is kept, both rows in batches/batch_NNNN_*.md show 'kept (mv_..., mo_...)', which misleads the 'look at all 20' review.

**Suggested fix:** Store each record's index in its queue item and update by index, or update only rows whose outcome starts with 'queued'.

<a id="48"></a>
## 48. --library-file: a relative path is silently ignored, and one partial line throws away a paid batch

low · unverified · Vaibhav · `agent/builder.py:144`

**What's wrong:** run.sh runs `cd "$(dirname "$0")"` (run.sh:4), so a relative --library-file resolves under agent/. If `Path(self.args.library_file).exists()` is false the file is skipped, and the warning wrongly says 'no --library-file'. The README's example value `library/moves.jsonl` (README.md:46) can never resolve, because the library is at ../library. Also, `[json.loads(line) for line in ...]` (:145) raises on any partial or malformed line. refresh_library() runs right after ask_claude (:221), so the batch Claude just returned is discarded even though calls_this_run was already counted, and at startup (:134) the error is uncaught.

**When it bites:** `./run.sh --library-file library/moves.jsonl` silently runs without the players' Forge move names, so the agent can add a move whose name duplicates a player's signature move. Reproduced: with the file ending mid-append ('{"name": "Thunder Pa'), make_batch raised JSONDecodeError after the Claude call, leaving calls_this_run=1 and queued=0.

**Suggested fix:** Warn when the given file is missing, and either document ../library/moves.jsonl or resolve the path against the caller's $PWD captured in run.sh before the cd. Skip lines that fail json.loads instead of raising.

<a id="49"></a>
## 49. A near-duplicate of a spec still queued from the previous batch generates a second motion

low · unverified · Vaibhav · `agent/builder.py:254`

**What's wrong:** Reuse checks only the index (kept prompts) and earlier generating specs in the same batch (:256-261). The producer deliberately builds batch N+1 while batch N is still queued (:179-182), so a prompt in batch N+1 that duplicates a queued or pending prompt from batch N is marked 'generate'.

**When it bites:** Seen in the offline run: batch 2's 'Pixie Kick' ('a person shifts weight back and snaps the left foot forward at chest height') generated mo_0006, while batch 1's 'Rime Kick' with the identical prompt was still queued (it later produced mo_0004). Each case costs an extra Kimodo generation.

**Suggested fix:** Also compare against the prompts of queued and pending items that will generate, and set wait_for to that prompt, as for an in-batch twin.

<a id="50"></a>
## 50. log.txt counts the same hour again after every restart

low · unverified · Vaibhav · `agent/builder.py:419`

**What's wrong:** shutdown() runs `self.state.save()` and then `self.state.flush_hours(self.log_path, include_current=True)`. The flush removes the current hour only in memory; state.json still has it, so the next run restores those counters and logs them again. log.txt and batches/ always live under agent/ whatever --state says, so runs with different state files write to the same log and reuse the same batch numbers.

**When it bites:** Two offline runs in the same hour on one state file wrote '20:00 (partial) kept 11 ... claude calls 2' and then '20:00 (partial) kept 13 ... claude calls 3'. The second line is cumulative, and a line from a run with a different --state sits between them. Adding up the hour gives 25 kept instead of 14.

**Suggested fix:** Save after flushing (or log only finished hours), and put log.txt and batches/ next to the state file.

## Refuted

- “Sim body poses are matched by exact MJCF name, so prefixed or missing names leave robots frozen at the origin with no warning” (`client/src/render/robot.ts:145`): two skeptics found it can't happen as described.
