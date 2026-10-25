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
  let stt = "none";                    // server speech to text; fetched before the join tap (iPhones need the mic started inside the tap)
  fetch(`${API}/health`).then((r) => r.json()).then((h) => { stt = h.stt || "none"; }).catch(() => {});

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
    left = false;
    renderBook(); connect(); refreshDeck();
    startListening();   // synchronously inside the tap: browsers only allow the mic from a gesture
  };
  $("leave").onclick = () => {
    if (!confirmLeave()) return;
    left = true; ws?.close(); listener?.pause(); player = null;
    $("play").classList.add("hidden"); $("join").classList.remove("hidden");
  };
  let leaveArmed = 0;
  function confirmLeave() { // tap twice instead of a confirm() popup
    if (Date.now() - leaveArmed < 3000) return true;
    leaveArmed = Date.now(); toast("Tap the room again to leave"); return false;
  }

  // ---------- room socket ----------
  function connect() {
    setConn("connecting", "Joining…");
    ws = new WebSocket(`${WS_BASE}/room/${encodeURIComponent(room)}?role=phone`);
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: "join", nickname: nick, phone_id: phoneId })); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "joined") { player = m.player; setConn("on", `Player ${player} · in the ring`); }
      else if (m.type === "full") { player = null; setConn("bad", "Room is full: both seats are taken"); }
      else if (m.type === "state") onState(m);
      else if (m.type === "event") onEvent(m.event || {});
    };
    ws.onclose = () => {
      if (left) return;
      setConn("connecting", "Reconnecting…");
      setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
    };
  }
  setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20000);
  function setConn(kind, text) { $("dot").className = `dot ${kind}`; $("seat").textContent = text; }

  let lastState = 0;
  function onState(s) {
    const me = s.players?.[player] || s.players?.[String(player)];
    lastState = Date.now();
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
    if (lastState && Date.now() - lastState > 4000) { $("duel").classList.add("hidden"); $("waiting").classList.remove("hidden"); lastState = 0; }
  }, 1000);
  function onEvent(e) {
    if (e.kind === "ko" && e.loser === player) { toast("Your automaton fell! Next round…"); buzz(200); }
    else if (e.kind === "down" && e.player === player) { toast("You're down! Get up!"); buzz(120); }
    else if (e.kind === "hit" && e.attacker === player) buzz(25);
    else if (e.kind === "match_end") toast(e.winner === player ? "Victory! You are champion of the ring ✦" : "The tale ends… rematch?");
    else if (e.kind === "round_start") toast(`Round ${e.round}! Shout your spells`);
  }

  // ---------- casting ----------
  async function cast(text, loudness, audio) {
    if (!player) return toast(ws?.readyState === 1 ? "No free seat in this room" : "Still joining the room…");
    const fd = new FormData();
    fd.append("room", room); fd.append("player", String(player)); fd.append("loudness", String(loudness ?? 0.75));
    if (audio) fd.append("audio", audio, "shout.wav"); else fd.append("transcript", text);
    if (text) show(`Casting <b>${esc(text)}</b>…`);
    try {
      const r = await fetch(`${API}/voice`, { method: "POST", body: fd });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.detail || `server said ${r.status}`);
      onResult(out);
    } catch (err) {
      show(`<b>The spell fizzled</b><span class="say">${esc(err.message === "Failed to fetch" ? "Can't reach the server. Check your connection." : err.message || err)}</span>`);
    }
  }
  function onResult(out) {
    if (out.result === "silence") return;
    const said = out.transcript ? `<span class="say">heard “${esc(out.transcript)}”</span>` : "";
    if (out.result === "play") {
      show(`${out.signature ? "✦ Your signature! " : ""}Cast <b>${esc(out.move.name)}</b>${said}`, true);
      remember(out.move); buzz(40);
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
  document.querySelectorAll("[data-tap]").forEach((b) => b.onclick = () => {
    if (ws?.readyState !== 1 || !player) return toast("Not in the ring yet");
    ws.send(JSON.stringify({ type: "tap", action: b.dataset.tap }));
    b.classList.add("pressed"); setTimeout(() => b.classList.remove("pressed"), 200);
    buzz(30);
  });

  // ---------- spellbook ----------
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
    $("bookCount").textContent = book.length ? `· ${book.length}` : "";
    $("book").innerHTML = book.length ? book.map((m) => {
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
    on: ["Listening… shout a spell!", "Tap to turn the mic off"],
    hot: ["I hear you…", "Keep going!"],
    off: ["Mic off", "Tap to listen again"],
    blocked: ["Mic blocked", "Tap to try again, or allow it in your browser settings"],
    none: ["No voice on this browser", "Type spells or tap your spellbook instead (Chrome or Safari have voice)"],
  };
  function setMic(state) {
    micState = state;
    const el = $("mic");
    el.classList.toggle("on", state === "on" || state === "hot" || state === "starting");
    el.classList.toggle("hot", state === "hot");
    el.classList.toggle("off", state === "off" || state === "blocked" || state === "none");
    el.setAttribute("aria-pressed", String(micOn));
    $("micLabel").textContent = MIC[state][0]; $("micSub").textContent = MIC[state][1];
  }
  $("mic").onclick = () => {
    if (micState === "blocked" || micState === "none" || !listener) { micOn = true; return startListening(); }
    micOn = !micOn;
    micOn ? listener.resume() : listener.pause();
    setMic(micOn ? "on" : "off");
  };

  function startListening() {
    setMic("starting");
    try {
      listener?.pause();
      listener = stt !== "none" ? vadListener() : speechListener();
      if (!listener) setMic("none");
    } catch (err) {
      console.warn(err);
      setMic("blocked");
    }
  }

  // Server transcribes (Muse / Whisper): record each shout as 16 kHz WAV, cut by loudness.
  function vadListener() {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();  // inside the tap, so iOS lets it run
    let paused = false, stream = null;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((s) => {
      stream = s;
      const src = ctx.createMediaStreamSource(s);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const sr = ctx.sampleRate, frameMs = (2048 / sr) * 1000;
      let floor = 0.01, speaking = false, chunks = [], pre = [], silentMs = 0, spokenMs = 0, peak = 0;
      node.onaudioprocess = (e) => {
        if (paused) return;
        const x = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
        const rms = Math.sqrt(sum / x.length);
        const loud = rms > Math.max(0.025, floor * 3.2);
        if (!speaking) {
          floor = 0.95 * floor + 0.05 * rms;
          pre.push(x); if (pre.length > 6) pre.shift();
          if (loud) { speaking = true; chunks = [...pre]; silentMs = 0; spokenMs = 0; peak = rms; setMic("hot"); }
          return;
        }
        chunks.push(x); spokenMs += frameMs; peak = Math.max(peak, rms);
        silentMs = loud ? 0 : silentMs + frameMs;
        if (silentMs > 550 || spokenMs > 4000) {
          speaking = false; setMic(micOn ? "on" : "off");
          if (spokenMs - silentMs > 250 && !window.IF_forging) cast("", Math.min(1, peak * 6), wav(chunks, sr));
          chunks = [];
        }
      };
      src.connect(node); node.connect(ctx.destination);
      setMic("on");
    }).catch((err) => { console.warn(err); setMic("blocked"); });
    return {
      pause: () => { paused = true; },
      resume: () => { paused = false; ctx.resume(); },
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
  function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2800); }
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
