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
  let nick = "", room = "", player = null, ws = null, retry = 0, cooldowns = {};
  let book = [];          // moves shown in the spellbook
  let micOn = true, listener = null;

  // ---------- join ----------
  $("nick").value = store.get("if_nick", "");
  $("room").value = (qs.get("room") || store.get("if_room", "")).toUpperCase();
  if (!$("nick").value) $("nick").focus();
  $("joinBtn").onclick = async () => {
    nick = $("nick").value.trim().slice(0, 16);
    room = $("room").value.trim().toUpperCase();
    if (!nick || !room) return toast("Enter your name and the room code");
    store.set("if_nick", nick); store.set("if_room", room);
    $("join").classList.add("hidden"); $("play").classList.remove("hidden");
    $("who").textContent = nick; $("roomCode").textContent = room;
    book = store.get(`if_book_${nick}`, []);
    renderBook(); connect(); refreshDeck();
    await startListening();   // must start from this tap (browsers need a gesture for the mic)
  };

  // ---------- room socket ----------
  function connect() {
    ws = new WebSocket(`${WS_BASE}/room/${encodeURIComponent(room)}?role=phone`);
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: "join", nickname: nick, phone_id: phoneId })); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "joined") { player = m.player; $("seat").textContent = `Player ${player} · in the ring`; }
      else if (m.type === "full") { $("seat").textContent = "Room is full: watching"; }
      else if (m.type === "state") onState(m);
      else if (m.type === "event") onEvent(m.event || {});
    };
    ws.onclose = () => { $("seat").textContent = "Reconnecting…"; setTimeout(connect, Math.min(5000, 400 * 2 ** retry++)); };
  }
  setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20000);

  function onState(s) {
    const me = s.players?.[player] || s.players?.[String(player)];
    if (!me) return;
    $("hp").style.width = `${Math.max(0, Math.min(100, me.hp))}%`;
    $("en").style.width = `${Math.max(0, Math.min(100, me.energy))}%`;
    cooldowns = me.cooldowns || {};
    document.querySelectorAll(".spell").forEach((el) => el.classList.toggle("cooling", (cooldowns[el.dataset.id] || 0) > 0));
  }
  function onEvent(e) {
    if (e.kind === "ko" && e.loser === player) toast("Your automaton fell! Next round…");
    if (e.kind === "match_end") toast(e.winner === player ? "Victory! You are champion of the ring ✦" : "The tale ends… rematch?");
    if (e.kind === "round_start") toast(`Round ${e.round}! Shout your spells`);
  }

  // ---------- casting ----------
  async function cast(text, loudness, audio) {
    if (!player) return toast("Still joining the room…");
    const fd = new FormData();
    fd.append("room", room); fd.append("player", String(player)); fd.append("loudness", String(loudness ?? 0.75));
    if (audio) fd.append("audio", audio, "shout.wav"); else fd.append("transcript", text);
    try {
      const r = await fetch(`${API}/voice`, { method: "POST", body: fd });
      const out = await r.json();
      if (!r.ok) throw new Error(out.detail || r.status);
      onResult(out);
    } catch (err) { show(`<b>Hmm…</b><span class="say">${esc(String(err.message || err))}</span>`); }
  }
  function onResult(out) {
    if (out.result === "silence") return;
    const said = out.transcript ? `<span class="say">“${esc(out.transcript)}”</span>` : "";
    if (out.result === "play") {
      show(`${out.signature ? "✦ Signature! " : ""}Cast <b>${esc(out.move.name)}</b>${said}`);
      remember(out.move);
    } else if (out.result === "charge") {
      show(`Summoning <b>${esc(out.guess?.name || "a new spell")}</b>…${said}`);
      waitForJob(out.job);
    }
  }
  async function waitForJob(job) {
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      try {
        const r = await (await fetch(`${API}/job/${job}`)).json();
        if (r.status === "done" && r.move) { remember(r.move); toast(`New spell invented: ${r.move.name} ✦`); return refreshDeck(); }
        if (r.status === "rejected") return toast("That spell fizzled… it borrowed a known move instead");
      } catch {}
    }
  }
  $("book").onclick = (e) => {
    const card = e.target.closest(".spell");
    if (card) cast(card.dataset.name, 0.8);
  };
  document.querySelectorAll("[data-tap]").forEach((b) => b.onclick = () => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "tap", action: b.dataset.tap }));
    navigator.vibrate?.(30);
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
      const ids = new Set(mine.map((m) => m.id));
      book = [...mine, ...book.filter((m) => !ids.has(m.id))].slice(0, 40);
      store.set(`if_book_${nick}`, book);
      renderBook();
    } catch {}
  }
  function renderBook() {
    $("bookCount").textContent = book.length ? `· ${book.length}` : "";
    $("book").innerHTML = book.length ? book.map((m) => {
      const mine = m.creator === nick;
      const star = mine ? `<span class="star" title="Invented by you">✦</span>` : "";
      const who = mine ? "Invented by you" : m.creator ? `by ${esc(m.creator)}` : "from the library";
      return `<button class="spell" data-id="${esc(m.id)}" data-name="${esc(m.name)}" style="--tc:var(--t-${esc(m.type || "physical")})">
        ${star}<div class="nm">${esc(m.name)}</div>
        <div class="ty">${TYPE[m.type] || "Might"} · ${esc(m.kind || "melee")} · power ${m.power ?? 2}</div>
        <div class="meta">${who}${m.uses ? ` · cast ${m.uses}×` : ""}</div></button>`;
    }).join("") : `<div class="empty">No spells yet. Shout one! Anything you invent lands here.</div>`;
  }

  // ---------- always-on mic ----------
  $("mic").onclick = () => {
    micOn = !micOn;
    $("mic").classList.toggle("on", micOn); $("mic").classList.toggle("off", !micOn);
    $("mic").setAttribute("aria-pressed", String(micOn));
    $("micLabel").textContent = micOn ? "Listening… shout a spell!" : "Mic off: tap to listen";
    micOn ? listener?.resume() : listener?.pause();
  };

  async function startListening() {
    let stt = "none";
    try { stt = (await (await fetch(`${API}/health`)).json()).stt || "none"; } catch {}
    try {
      listener = stt !== "none" ? await vadListener() : speechListener() || await vadListener(true);
    } catch (err) {
      $("micLabel").textContent = "No mic access: tap spells instead";
      $("mic").classList.add("off");
      console.warn(err);
    }
  }

  // Server transcribes (Muse / Whisper): record each shout as 16 kHz WAV, cut by loudness.
  async function vadListener(noStt) {
    if (noStt) { $("micLabel").textContent = "Voice not available here: tap spells"; return null; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const sr = ctx.sampleRate, frameMs = (2048 / sr) * 1000;
    let floor = 0.01, speaking = false, chunks = [], pre = [], silentMs = 0, spokenMs = 0, peak = 0, paused = false;
    node.onaudioprocess = (e) => {
      if (paused) return;
      const x = new Float32Array(e.inputBuffer.getChannelData(0));
      let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      const rms = Math.sqrt(s / x.length);
      const loud = rms > Math.max(0.025, floor * 3.2);
      if (!speaking) {
        floor = 0.95 * floor + 0.05 * rms;
        pre.push(x); if (pre.length > 6) pre.shift();
        if (loud) { speaking = true; chunks = [...pre]; silentMs = 0; spokenMs = 0; peak = rms; $("mic").classList.add("hot"); }
        return;
      }
      chunks.push(x); spokenMs += frameMs; peak = Math.max(peak, rms);
      silentMs = loud ? 0 : silentMs + frameMs;
      if (silentMs > 550 || spokenMs > 4000) {
        speaking = false; $("mic").classList.remove("hot");
        if (spokenMs - silentMs > 250) cast("", Math.min(1, peak * 6), wav(chunks, sr));
        chunks = [];
      }
    };
    src.connect(node); node.connect(ctx.destination);
    return { pause: () => { paused = true; }, resume: () => { paused = false; ctx.resume(); } };
  }

  // No server STT: the browser's own speech recognition, restarted whenever it stops.
  function speechListener() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    let running = false, wanted = true;
    const rec = new SR();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onstart = () => { running = true; };
    rec.onspeechstart = () => $("mic").classList.add("hot");
    rec.onresult = (e) => {
      $("mic").classList.remove("hot");
      const r = e.results[e.results.length - 1];
      const text = r?.[0]?.transcript?.trim();
      if (r?.isFinal && text && text.length > 2) cast(text, 0.75);
    };
    rec.onerror = (e) => { if (e.error === "not-allowed") { wanted = false; $("micLabel").textContent = "Mic blocked: allow it in settings"; } };
    rec.onend = () => { running = false; $("mic").classList.remove("hot"); if (wanted && micOn) setTimeout(() => { try { rec.start(); } catch {} }, 250); };
    rec.start();
    return { pause: () => { wanted = false; if (running) rec.stop(); }, resume: () => { wanted = true; if (!running) try { rec.start(); } catch {} } };
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

  // ---------- helpers ----------
  function show(html) { $("heard").innerHTML = html; }
  let toastT;
  function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
