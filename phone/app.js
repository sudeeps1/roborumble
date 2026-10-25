// Infinite Fighter phone page: join a room, keep the mic listening, cast spells, keep a spellbook.
// Talks to the game server on the same origin (contract/api.md, contract/ws.md). ?server=https://... overrides it.
(() => {
  const qs = new URLSearchParams(location.search);
  const API = (qs.get("server") || "").replace(/\/$/, "");
  const WS_BASE = API ? API.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const TYPE = { physical: "Might", fire: "Flame", ice: "Frost", lightning: "Storm", shadow: "Shadow" };
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let phoneId = store.get("if_phone_id", null);
  if (!phoneId) { phoneId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("if_phone_id", phoneId); }
  let nick = "", room = "", player = null, ws = null, retry = 0, cooldowns = {}, left = false;
  let book = [];                       // moves shown in the spellbook
  let micOn = true, listener = null, micState = "off";
  let held = false;  // hold to talk: the orb records exactly while it is held, so crowd noise never casts
  let stt = "none";                    // server speech to text; fetched before the join tap (iPhones need the mic started inside the tap)
  (function health(tries) {            // retry: one dropped answer would leave iPhones on the browser's own (flaky) recognition
    fetch(`${API}/health`).then((r) => r.json()).then((h) => { stt = h.stt || "none"; })
      .catch(() => tries > 1 && setTimeout(() => health(tries - 1), 1500));
  })(6);

  // ---------- join ----------
  $("nick").value = store.get("if_nick", "");
  $("room").value = (qs.get("room") || store.get("if_room", "")).toUpperCase();
  if (!$("nick").value) $("nick").focus();
  $("room").oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  for (const id of ["nick", "room"]) $(id).onkeydown = (e) => { if (e.key === "Enter") $("joinBtn").click(); };

  $("joinBtn").onclick = () => {
    nick = $("nick").value.trim().slice(0, 16);
    room = $("room").value.trim().toUpperCase();
    if (!nick) return toast("Enter your name, brave one");
    if (!room) return toast("Enter the room code from the big screen");
    store.set("if_nick", nick); store.set("if_room", room);
    $("join").classList.add("hidden"); $("play").classList.remove("hidden");
    $("who").textContent = nick; $("roomCode").textContent = room;
    book = store.get(`if_book_${nick}`, []);
    left = false; full = false; gameUp = null; joinedAt = Date.now(); lastState = 0; lastMe = null; lastTimer = null; breakFrom = breakUntil = 0;
    renderBook(); connect(); refreshDeck();
    startListening();   // synchronously inside the tap: browsers only allow the mic from a gesture
  };
  $("leave").onclick = () => {
    if (!confirmLeave()) return;
    left = true; clearTimeout(reconnectT); drop(); listener?.stop(); listener = null; player = null;
    $("play").classList.add("hidden"); $("join").classList.remove("hidden");
  };
  let leaveArmed = 0;
  function confirmLeave() { // tap twice instead of a confirm() popup
    if (Date.now() - leaveArmed < 3000) return true;
    leaveArmed = Date.now(); toast("Tap the room again to leave"); return false;
  }

  // ---------- room socket ----------
  // Venue Wi-Fi can leave a socket "open" with nothing getting through: taps then sit in its buffer and land
  // seconds later in a burst. So: ping every 2 s, treat 6.5 s of silence as dead, drop it and reconnect.
  let lastMsg = 0, lastPing = 0, probeAt = 0, openedAt = 0, reconnectT = 0, lastTick = Date.now();
  const joinMsg = () => {
    const seat = player || store.get(`if_seat_${room}`, null);  // after a server restart, ask for the same robot back
    return JSON.stringify({ type: "join", nickname: nick, phone_id: phoneId, ...(seat === 1 || seat === 2 ? { player: seat } : {}) });
  };
  function connect() {
    clearTimeout(reconnectT);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch {} }
    setConn("connecting", retry ? "Reconnecting…" : "Joining…");
    const sock = ws = new WebSocket(`${WS_BASE}/room/${encodeURIComponent(room)}?role=phone`);
    openedAt = Date.now(); probeAt = 0;
    sock.onopen = () => { lastMsg = Date.now(); sock.send(joinMsg()); };
    sock.onmessage = (ev) => {
      if (sock !== ws) return;
      lastMsg = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "joined") { player = m.player; retry = 0; full = false; store.set(`if_seat_${room}`, player); setConn("on", `Player ${player} · in the ring`); checkGame(); }
      else if (m.type === "full") {
        player = null; full = true; setConn("bad", "Room is full: both seats are taken"); renderWaiting();
        setTimeout(() => sock === ws && sock.readyState === 1 && sock.send(joinMsg()), 5000);  // a seat frees up when a phone leaves
      }
      else if (m.type === "state") onState(m);
      else if (m.type === "event") onEvent(m.event || {});
    };
    sock.onclose = () => { if (sock === ws) { ws = null; reconnect(); } };
  }
  function drop() { // stop waiting on a socket whose close handshake may never finish
    const sock = ws; ws = null;
    if (sock) { sock.onopen = sock.onmessage = sock.onclose = null; try { sock.close(); } catch {} }
    reconnect();
  }
  function reconnect() {
    if (left) return;
    setConn("connecting", "Reconnecting…");
    clearTimeout(reconnectT);
    reconnectT = setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
  }
  function probe() { if (ws?.readyState === 1) { probeAt = Date.now(); ws.send('{"type":"ping"}'); } }
  setInterval(() => {
    const now = Date.now(), slept = now - lastTick > 3000;  // timers stop while the phone is locked
    lastTick = now;
    if (!ws || left) return;
    if (ws.readyState === 0 && now - openedAt > 6000) return drop();  // the handshake never finished
    if (ws.readyState !== 1) return;
    if (slept) return probe();
    const asked = probeAt && lastMsg < probeAt;  // a probe ping is waiting for its pong
    if (asked ? now - probeAt > 2500 : now - lastMsg > 6500) return drop();
    if (now - lastPing > 2000) { lastPing = now; ws.send('{"type":"ping"}'); }
  }, 500);
  // only send taps on a link that's answering: in a fight, state arrives 10 times a second
  const linkFresh = () => {
    const now = Date.now();
    if (ws?.readyState !== 1) return false;
    return now - lastMsg < 1500 || (now - lastState > 6000 && now - lastMsg < 4000);
  };
  addEventListener("online", probe);
  function setConn(kind, text) { $("dot").className = `dot ${kind}`; $("seat").textContent = text; }

  // Is the big screen in this room? The server doesn't tell phones when it leaves, so ask (GET /room/{code}).
  let gameUp = null, gameCheckAt = 0, joinedAt = 0, warmed = false, full = false;
  async function checkGame() {
    gameCheckAt = Date.now();
    try {
      const r = await (await fetch(`${API}/room/${encodeURIComponent(room)}`)).json();
      if (!left && r.room === room) { gameUp = !!r.game_connected; renderWaiting(); }
    } catch {}
  }
  function renderWaiting() {
    const down = ws?.readyState !== 1 || !player;
    const text = full ? "Both seats are taken. You'll get one as soon as a player leaves; you can still forge meanwhile."
      : down ? `${retry ? "Reconnecting to" : "Joining"} room ${room}…`
      : gameUp === false ? `No big screen in room ${room} right now. Hang on if it's reloading; if it shows a different code, scan its QR again.`
      : "Waiting for the duel to begin on the big screen… you can still cast and forge.";
    $("waiting").classList.toggle("gone", !down && gameUp === false);
    if ($("waiting").textContent !== text) $("waiting").textContent = text;
  }

  let lastState = 0, lastMe = null, lastTimer = null, tickedAt = 0, breakFrom = 0, breakUntil = 0;
  function onState(s) {
    const me = s.players?.[player] || s.players?.[String(player)];
    lastState = Date.now(); lastMe = me || null; gameUp = true;
    if (lastTimer !== null && s.timer < lastTimer) tickedAt = lastState;  // the round clock is running: a fight is on
    lastTimer = s.timer ?? null;
    $("duel").classList.remove("hidden"); $("waiting").classList.add("hidden");
    $("round").textContent = `Round ${s.round ?? 1}`;
    const t = Math.max(0, Math.ceil(s.timer ?? 0));
    $("timer").textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    const w = s.wins || {};
    if (player) $("wins").textContent = `★ ${w[player] ?? w[String(player)] ?? 0} – ${w[3 - player] ?? w[String(3 - player)] ?? 0}`;
    if (!me) return;
    const hp = Math.max(0, Math.min(100, me.hp ?? 100)), en = Math.max(0, Math.min(100, me.energy ?? 100));
    $("hp").style.width = `${hp}%`; $("hpN").textContent = Math.round(hp);
    $("en").style.width = `${en}%`; $("enN").textContent = Math.round(en);
    cooldowns = me.cooldowns || {};
    document.querySelectorAll(".spell").forEach((el) => {
      const cd = cooldowns[el.dataset.id] || 0;
      el.classList.toggle("cooling", cd > 0);
      el.dataset.cd = cd > 0 ? `${cd.toFixed(1)}s` : "";
    });
  }
  setInterval(() => { // no state for a while: the match ended or the big screen went away
    const now = Date.now();
    if (lastState && now - lastState > 4000) { $("duel").classList.add("hidden"); $("waiting").classList.remove("hidden"); lastState = 0; checkGame(); }
    if (left || !room || now - lastState < 4000) return;
    renderWaiting();
    if (now - gameCheckAt > 3000) checkGame();
    // between fights: fetch the Forge's body tracker now (~9 MB) so the first Forge tap doesn't wait on it
    if (!warmed && now - joinedAt > 3000 && window.IF_warmForge) { warmed = true; window.IF_warmForge(); }
  }, 1000);
  function onEvent(e) {
    const now = Date.now();
    if (e.kind === "round_start") { breakFrom = breakUntil = 0; }  // the screen holds shouts through the intro and casts them at "Fight!"
    else if (e.kind === "ko") { breakFrom = now + 2600; breakUntil = Infinity; }    // the round ends once the fall plays out
    else if (e.kind === "round" || e.kind === "match_end") { breakFrom = now; breakUntil = Infinity; }
    if (e.kind === "ko" && e.loser === player) { toast("Your automaton fell! Next round…"); buzz(200); }
    else if (e.kind === "down" && e.player === player) { toast("You're down! Get up!"); buzz(120); }
    else if (e.kind === "hit" && e.attacker === player) buzz(25);
    else if (e.kind === "match_end") toast(e.winner === player ? "Victory! You are champion of the ring ✦" : "The tale ends… rematch?");
    else if (e.kind === "round_start") toast(`Round ${e.round}! Shout your spells`);
    else if (e.kind === "fizzle" && e.player === player) {
      const why = { busy: "Your robot was busy too long. Shout it again!", "not fighting": "Between rounds. Shout it again when the round starts!", replaced: "A newer spell took its place." }[e.why] || "It couldn't play. Shout it again!";
      show(`<b>${esc(e.move)}</b> didn't cast<span class="say">${why}</span>`);
    }
  }
  // A library move the game screen can't play right now is dropped there without a word back to the phone,
  // so judge from the latest state (contract: canAct checks status, cooldown and energy).
  const COST = { 1: 15, 2: 25, 3: 40 };
  function whyNot(move) {
    const now = Date.now();
    if (ws?.readyState !== 1 || now - lastMsg > 3500) return null;  // our own link is down: can't tell
    if (now - lastState > 1500) return gameUp === false ? "The big screen isn't connected, so your robot can't move." : "The duel hasn't started yet. It's in your spellbook for the fight.";
    const stopped = (lastTimer !== null && lastTimer <= 0) || (now >= breakFrom && now < breakUntil && now - tickedAt > 1500);
    if (stopped) return "Between rounds. Shout it again when the round starts!";
    if (!lastMe) return null;
    const st = lastMe.status, cd = lastMe.cooldowns?.[move.id] || 0;
    // status: the screen queues a move behind a cast, a stagger, a dodge or a charge; it says so with a fizzle event if it gives up
    if (cd > 0.15) return `Still cooling down (${cd.toFixed(1)} s).`;
    if ((lastMe.energy ?? 100) < (COST[move.power] || 25)) return "Not enough energy. Let it refill a moment.";
    return null;
  }

  // ---------- casting ----------
  const inflight = new Set();  // start times of shouts still waiting on the server
  async function cast(text, loudness, audio) {
    if (!player) return toast(ws?.readyState === 1 ? "No free seat in this room" : "Still joining the room…");
    // during a Wi-Fi stall, don't pile up shouts that would all fire late in a burst
    if (inflight.size && Date.now() - Math.min(...inflight) > 4000) return show(`<b>Slow connection…</b><span class="say">Still waiting on your last spell. Try again in a moment.</span>`);
    const fd = new FormData();
    fd.append("room", room); fd.append("player", String(player)); fd.append("loudness", String(loudness ?? 0.75));
    if (audio) fd.append("audio", audio, "shout.wav"); else fd.append("transcript", text);
    if (text) show(`Casting <b>${esc(text)}</b>…`);
    const t0 = Date.now(), ctl = new AbortController(), stop = setTimeout(() => ctl.abort(), 12000);
    inflight.add(t0);
    try {
      const r = await fetch(`${API}/voice`, { method: "POST", body: fd, signal: ctl.signal });
      const out = await r.json().catch(() => ({}));
      if (audio && r.status === 503) { // server voice is off or its budget is used up: use the phone's own
        stt = "none"; listener?.stop(); listener = null; setMic("blocked");
        $("micSub").textContent = "Tap once to switch to your phone's own voice recognition";
        return;
      }
      if (!r.ok) throw new Error(out.detail || `server said ${r.status}`);
      onResult(out);
    } catch (err) {
      const msg = err.name === "AbortError" ? "The server took too long. Check your connection." : err.message === "Failed to fetch" || err.name === "TypeError" ? "Can't reach the server. Check your connection." : err.message || err;
      show(`<b>The spell fizzled</b><span class="say">${esc(msg)}</span>`);
    } finally {
      clearTimeout(stop); inflight.delete(t0);
    }
  }
  function onResult(out) {
    if (out.result === "silence") return;
    const said = out.transcript ? `<span class="say">heard “${esc(out.transcript)}”</span>` : "";
    if (out.result === "play") {
      const why = whyNot(out.move);
      if (why) show(`<b>${esc(out.move.name)}</b> didn't cast<span class="say">${why}</span>${said}`);
      else { show(`${out.signature ? "✦ Your signature! " : ""}Cast <b>${esc(out.move.name)}</b>${said}`, true); buzz(40); }
      remember(out.move);
    } else if (out.result === "charge") {
      show(`<span class="spin"></span>Summoning a brand-new spell: <b>${esc(out.guess?.name || "…")}</b>${said}`);
      waitForJob(out.job);
    }
  }
  async function waitForJob(job) {
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      try {
        const r = await (await fetch(`${API}/job/${job}`)).json();
        if (r.status === "done" && r.move) {
          remember(r.move);
          show(`✦ New spell invented: <b>${esc(r.move.name)}</b><span class="say">It's in your spellbook. Shout it again any time.</span>`, true);
          buzz(60); return refreshDeck();
        }
        if (r.status === "rejected") return show(`<b>That spell fizzled</b><span class="say">Your robot used the closest known move instead.</span>`);
      } catch {}
    }
  }
  $("book").onclick = (e) => {
    const card = e.target.closest(".spell");
    if (!card) return;
    card.classList.add("pressed"); setTimeout(() => card.classList.remove("pressed"), 250);
    cast(card.dataset.name, 0.8);
  };
  $("typeForm").onsubmit = (e) => {
    e.preventDefault();
    const t = $("typed").value.trim();
    if (t.length < 3) return toast("Type at least 3 letters");
    $("typed").value = ""; $("typed").blur();
    cast(t, 0.8);
  };
  // on touch-down, not on release: a dodge window is 0.4 s and a click waits for the finger to lift
  document.querySelectorAll("[data-tap]").forEach((b) => b.onpointerdown = () => {
    if (!player) return toast("Not in the ring yet");
    if (!linkFresh()) { probe(); return toast("Connection hiccup… reconnecting"); }  // never queue a stale dodge
    if (gameUp === false && Date.now() - lastState > 1500) return toast("The big screen isn't connected");
    ws.send(JSON.stringify({ type: "tap", action: b.dataset.tap }));
    b.classList.add("pressed"); setTimeout(() => b.classList.remove("pressed"), 200);
    buzz(30);
  });

  // ---------- spellbook ----------
  // Everyone's starting spells: every game shows them, after your own forged and invented moves.
  const GENERAL = [
    ["Fireball", "fire", "projectile", 3], ["Thunder Call", "lightning", "strike", 3], ["Spiral Sphere", "ice", "melee", 3],
    ["Earth Wall", "physical", "defend", 2], ["Uppercut", "physical", "melee", 2], ["Right Hook", "physical", "melee", 2],
    ["Roundhouse Kick", "physical", "melee", 2], ["Front Kick", "physical", "melee", 2],
  ].map(([name, type, kind, power]) => ({ id: `general:${name}`, name, type, kind, power, creator: null }));
  function remember(move) {
    if (!move?.id) return;
    book = [move, ...book.filter((m) => m.id !== move.id)].slice(0, 40);
    store.set(`if_book_${nick}`, book);
    renderBook();
  }
  async function refreshDeck() {
    try {
      const d = await (await fetch(`${API}/deck?nickname=${encodeURIComponent(nick)}`)).json();
      const mine = d.moves || [];
      const fresh = new Map(mine.map((m) => [m.id, m]));
      // keep the order players know (recent first), update stats from the server, add any new inventions
      const merged = book.map((m) => fresh.get(m.id) || m);
      const known = new Set(merged.map((m) => m.id));
      book = [...mine.filter((m) => !known.has(m.id)), ...merged].slice(0, 40);
      store.set(`if_book_${nick}`, book);
      renderBook();
    } catch {}
  }
  function renderBook() {
    const own = book.filter((m) => m.creator === nick);
    const list = [...own, ...GENERAL.filter((g) => !own.some((m) => m.name.toLowerCase() === g.name.toLowerCase()))];
    $("bookCount").textContent = list.length ? `· ${list.length}` : "";
    $("book").innerHTML = list.length ? list.map((m) => {
      const mine = m.creator === nick;
      const who = mine ? (m.source === "forge" ? "✦ Forged by you · 1.5× power" : "✦ Invented by you") : m.creator ? `by ${esc(m.creator)}` : "from the library";
      return `<button class="spell${mine ? " mine" : ""}" data-id="${esc(m.id)}" data-name="${esc(m.name)}" style="--tc:var(--t-${esc(m.type || "physical")})">
        <div class="nm">${esc(m.name)}</div>
        <div class="ty">${TYPE[m.type] || "Might"} · ${esc(m.kind || "melee")} · ${"✶".repeat(m.power ?? 2)}</div>
        <div class="meta">${who}${m.uses ? ` · cast ${m.uses}×` : ""}</div></button>`;
    }).join("") : `<div class="empty">No spells yet. Shout one, type one, or forge one. Anything you invent lands here.</div>`;
  }

  // ---------- always-on mic ----------
  const MIC = {
    starting: ["Starting the mic…", "Allow the microphone if your phone asks"],
    on: ["Hold to shout a spell", "Hold the orb, shout, then let go"],
    hot: ["Listening…", "Let go to cast"],
    off: ["Mic off", "Tap to listen again"],
    blocked: ["Mic blocked", "Tap to try again, or allow it in your browser settings"],
    denied: ["Mic blocked", "Allow it in your browser settings, then tap here to reload"],
    asleep: ["Mic asleep", "Tap to wake it up"],
    none: ["No voice on this browser", "Type spells or tap your spellbook instead (Chrome or Safari have voice)"],
  };
  function setMic(state) {
    micState = state;
    const el = $("mic");
    el.classList.toggle("on", state === "on" || state === "hot" || state === "starting");
    el.classList.toggle("hot", state === "hot");
    el.classList.toggle("off", state === "off" || state === "blocked" || state === "denied" || state === "asleep" || state === "none");
    el.setAttribute("aria-pressed", String(micOn));
    $("micLabel").textContent = MIC[state][0]; $("micSub").textContent = MIC[state][1];
  }
  const orb = $("mic");
  const asleep = () => micState === "denied" || micState === "blocked" || micState === "asleep" || micState === "none" || !listener;
  // A tap starts or wakes the mic: iPhones only let a page start audio on a tap, not on a press.
  orb.onclick = () => {
    if (micState === "denied") return location.reload();  // the browser only asks again after a reload
    if (asleep()) { micOn = true; startListening(); }
  };
  // Holding the orb records; letting go sends it.
  orb.addEventListener("pointerdown", (e) => {
    if (asleep() || !listener.release) return;  // the tap above wakes it; the browser's own recognition listens by itself
    e.preventDefault(); orb.setPointerCapture?.(e.pointerId);
    micOn = true; held = true; setMic("hot");
  });
  const letGo = () => {
    listener?.resume?.();  // letting go is a tap too, so this keeps the phone's audio awake
    if (!held) return;
    held = false;
    if (listener?.release?.() === 0) return setMic("asleep");  // nothing came in: one tap wakes the mic
    setMic("on");
  };
  orb.addEventListener("pointerup", letGo);
  orb.addEventListener("pointercancel", letGo);

  function startListening() {
    setMic("starting");
    try {
      listener?.stop();  // release the old mic and audio context (iPhones only allow a few)
      listener = stt !== "none" ? vadListener() : speechListener();
      if (!listener) setMic("none");
    } catch (err) {
      console.warn(err);
      setMic("blocked");
    }
  }
  // After "Don't Allow", iPhone Safari refuses again without asking until the page reloads.
  const HOW_TO_ALLOW = /iPhone|iPad/.test(navigator.userAgent)
    ? "Mic blocked. Tap aA in the address bar › Website Settings › Microphone › Allow, then tap the mic to reload."
    : "Mic blocked. Tap the icon left of the address › Permissions › Microphone › Allow, then tap the mic to reload.";
  function micError(err, askedAt) {
    console.warn(err);
    if (err?.name !== "NotAllowedError" && err?.name !== "SecurityError") return setMic("blocked");
    if (Date.now() - askedAt > 700) return setMic("blocked");  // the player just said no: one more tap asks again
    setMic("denied"); toast(HOW_TO_ALLOW, 8000);              // refused without asking: only settings + reload help
  }
  // iPhones silence the mic when the phone locks, an app takes the audio or a call comes in, and the page
  // doesn't always get it back. Check it's still delivering audio; if not, say so (a tap restarts it).
  setInterval(() => {
    if (!micOn || !listener || document.hidden || window.IF_forging || (micState !== "on" && micState !== "hot")) return;
    if (listener.alive()) return;
    listener.wake();
    setTimeout(() => { if (micOn && listener && !window.IF_forging && (micState === "on" || micState === "hot") && !listener.alive()) setMic("asleep"); }, 1500);
  }, 2500);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !player) return;
    probe();  // the room socket may have died while the phone was locked
    if (micOn && !window.IF_forging) listener?.wake();
  });

  // Server transcribes (Muse / Whisper): record each shout as 16 kHz WAV, cut by loudness.
  function vadListener() {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();  // inside the tap, so iOS lets it run
    let paused = false, stopped = false, stream = null, track = null, lastAudio = Date.now();
    const askedAt = Date.now();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((s) => {
      if (stopped) return s.getTracks().forEach((t) => t.stop());
      stream = s; track = s.getAudioTracks()[0]; lastAudio = Date.now();
      const src = ctx.createMediaStreamSource(s);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const sr = ctx.sampleRate, frameMs = (2048 / sr) * 1000;
      let floor = 0.01, speaking = false, chunks = [], pre = [], silentMs = 0, spokenMs = 0, peak = 0;
      node.onaudioprocess = (e) => {
        lastAudio = Date.now();
        if (paused) return;
        const x = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
        const rms = Math.sqrt(sum / x.length);
        if (held) { if (!speaking) { speaking = true; chunks = [...pre]; peak = 0; } chunks.push(x); peak = Math.max(peak, rms); return; }
        if (speaking) { pre = []; }
        speaking = false;
        pre.push(x); if (pre.length > 6) pre.shift();
        return;
      };
      src.connect(node); node.connect(ctx.destination);
      setMic("on");
    }).catch((err) => { if (!stopped) micError(err, askedAt); });
    return {
      pause: () => { paused = true; },
      // let go of the orb: send what was said while it was held (a quick tap sends nothing)
      release: () => {
        const c = chunks; chunks = []; speaking = false;
        if (c.length * frameMs > 350 && !window.IF_forging) cast("", Math.min(1, peak * 6), wav(c, sr));
        return c.length;
      },
      resume: () => { paused = false; ctx.resume(); },
      stop: () => { stopped = paused = true; stream?.getTracks().forEach((t) => t.stop()); try { ctx.close().catch(() => {}); } catch {} },
      wake: () => { if (ctx.state !== "running") ctx.resume().catch(() => {}); },
      alive: () => ctx.state === "running" && Date.now() - lastAudio < 2500 && (!track || (track.readyState === "live" && !track.muted)),
    };
  }

  // No server STT: the browser's own speech recognition, restarted whenever it stops.
  function speechListener() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let running = false, wanted = true;
    const rec = new SR();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onstart = () => { running = true; if (micOn) setMic("on"); };
    rec.onspeechstart = () => setMic("hot");
    rec.onspeechend = () => { if (micOn) setMic("on"); };
    rec.onresult = (e) => {
      if (micOn) setMic("on");
      const r = e.results[e.results.length - 1];
      const text = r?.[0]?.transcript?.trim();
      if (r?.isFinal && text && text.length > 2 && !window.IF_forging) cast(text, 0.75);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { wanted = false; setMic("blocked"); }
    };
    rec.onend = () => {
      running = false;
      if (wanted && micOn) setTimeout(() => { try { rec.start(); } catch {} }, 250);
    };
    rec.start();
    return {
      pause: () => { wanted = false; if (running) try { rec.stop(); } catch {} },
      resume: () => { wanted = true; if (!running) try { rec.start(); } catch {} },
      stop: () => { wanted = false; try { rec.abort(); } catch {} },
      wake: () => { if (wanted && !running) try { rec.start(); } catch {} },
      alive: () => true,
    };
  }

  function wav(chunks, sr) {
    const len = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(len);
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = sr / 16000, n = Math.floor(len / ratio), pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = all[Math.floor(i * ratio)]; pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff; }
    const buf = new ArrayBuffer(44 + pcm.length * 2), d = new DataView(buf);
    const w = (p, s) => [...s].forEach((ch, i) => d.setUint8(p + i, ch.charCodeAt(0)));
    w(0, "RIFF"); d.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 16000, true);
    d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, "data"); d.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---------- for forge.js ----------
  window.IF = { API, get nick() { return nick; }, remember, toast, refreshDeck,
    pauseMic: () => listener?.pause(), resumeMic: () => { if (micOn) listener?.resume(); } };

  // ---------- helpers ----------
  function show(html, flash) {
    const el = $("heard");
    el.innerHTML = html;
    if (flash) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }
  let toastT;
  function toast(t, ms = 2800) {
    const el = $("toast"); el.textContent = t; el.classList.add("show"); el.classList.toggle("long", t.length > 60);
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), ms);
  }
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
