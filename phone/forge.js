// The Forge: act out a move on camera, name it, and Kimodo turns it into a robot move.
// MediaPipe Pose Landmarker runs in the browser and gives 33 body points per frame; we send the 3D "world"
// landmarks (meters, hip-centered) to POST /forge. contract/api.md has the endpoints.
const MP = "0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const RECORD_MS = 4000;
const TYPE = { physical: "Might", fire: "Flame", ice: "Frost", lightning: "Storm", shadow: "Shadow" };
// MediaPipe skeleton for the camera overlay
const MP_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
// G1Skeleton34 (Kimodo posed_joints) for the preview
const G1_BONES = [[18, 26], [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [0, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19], [19, 20], [20, 21], [21, 22], [22, 23], [23, 24], [24, 25],
  [17, 26], [26, 27], [27, 28], [28, 29], [29, 30], [30, 31], [31, 32], [32, 33]];

const $ = (id) => document.getElementById(id);
const IF = () => window.IF;
let landmarker = null, stream = null, raf = 0, recording = null, recorded = null, job = null, previewRaf = 0;

$("forgeOpen").onclick = openForge;
$("forgeClose").onclick = closeForge;
$("recBtn").onclick = record;
$("redoRec").onclick = () => step("record");
$("redoAll").onclick = async () => { recorded = null; step("record"); await startCamera(); };
$("forgeBtn").onclick = forgeIt;
$("keepBtn").onclick = keep;

async function openForge() {
  window.IF_forging = true;
  IF().pauseMic?.();
  $("forge").classList.remove("hidden");
  recorded = null;
  step("record");
  await startCamera();
}

async function startCamera() {
  $("recBtn").disabled = true;
  hint("Waking the forge…");
  try {
    if (!landmarker) {
      const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}`);
      const files = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numPoses: 1 });
      landmarker = await vision.PoseLandmarker.createFromOptions(files, opts("GPU"))
        .catch(() => vision.PoseLandmarker.createFromOptions(files, opts("CPU")));
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      $("cam").srcObject = stream;
    }
    await $("cam").play();
    if ($("forge").classList.contains("hidden")) return closeForge(); // closed while loading
    $("recBtn").disabled = false;
    hint("Prop your phone up and step back until your whole body glows.");
    loop();
  } catch (err) {
    hint(`The forge can't see you: ${err.message || err}. Allow the camera, then close and reopen the forge.`);
  }
}

function closeForge() {
  cancelAnimationFrame(raf); cancelAnimationFrame(previewRaf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null; recording = null;
  $("forge").classList.add("hidden");
  window.IF_forging = false;
  IF().resumeMic?.();
}

function step(which) {
  for (const s of ["record", "name", "result"]) $(`step${s[0].toUpperCase()}${s.slice(1)}`).classList.toggle("hidden", s !== which);
  if (which === "record") { $("cam").style.visibility = "visible"; $("skel").classList.add("mirror"); $("count").textContent = ""; cancelAnimationFrame(previewRaf); if (stream) loop(); }
}

// ---------- camera + skeleton ----------
function loop() {
  cancelAnimationFrame(raf);
  const video = $("cam"), canvas = $("skel"), ctx = canvas.getContext("2d");
  $("skel").classList.add("mirror");
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!landmarker || video.readyState < 2) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const now = performance.now();
    let res;
    try { res = landmarker.detectForVideo(video, now); }
    catch (err) { console.warn("pose detect failed", err); switchToCpu(); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts = res.landmarks?.[0], world = res.worldLandmarks?.[0];
    const seen = (ids) => pts && ids.every((i) => (pts[i].visibility ?? 1) > 0.5);
    const full = seen([11, 12, 15, 16, 23, 24, 27, 28]), upper = seen([11, 12, 15, 16]);
    document.querySelector(".stage").classList.toggle("ready", !!full);
    $("recBtn").disabled = !!recording;
    if (!recording && !$("stepRecord").classList.contains("hidden")) hint(full ? "✓ I can see all of you. Tap Record, then strike your pose!"
      : upper ? "Step back a little. I can't see your legs (recording still works)."
      : pts ? "Step back so your arms and body are in view." : "I can't see you yet. Point the camera at yourself.");
    if (pts) drawPose(ctx, pts, canvas.width, canvas.height, full ? "#7ee0a3" : "#f5d77e");
    if (recording && world && upper) recording.frames.push(world.map((p) => [round(p.x), round(p.y), round(p.z)]));
  };
  tick();
}

let switching = false;
async function switchToCpu() {
  if (switching) return;
  switching = true;
  try {
    const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}`);
    const files = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP}/wasm`);
    landmarker = await vision.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate: "CPU" }, runningMode: "VIDEO", numPoses: 1 });
  } catch (err) { hint(`Body tracking failed on this phone: ${err.message || err}`); }
  switching = false;
}

function drawPose(ctx, pts, w, h, color) {
  ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 14;
  for (const [a, b] of MP_BONES) {
    ctx.beginPath(); ctx.moveTo(pts[a].x * w, pts[a].y * h); ctx.lineTo(pts[b].x * w, pts[b].y * h); ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of [0, 15, 16, 27, 28]) { ctx.beginPath(); ctx.arc(pts[i].x * w, pts[i].y * h, 7, 0, 7); ctx.fill(); }
}

// ---------- recording ----------
async function record() {
  $("recBtn").disabled = true;
  for (const n of ["5", "4", "3", "2", "1"]) {
    if ($("forge").classList.contains("hidden")) return;
    $("count").className = "count"; $("count").textContent = n; say(n); await sleep(900);
  }
  $("count").textContent = "GO!"; say("Go!");
  recording = { frames: [], start: performance.now() };
  await sleep(350);
  const end = recording.start + RECORD_MS;
  while (performance.now() < end) {
    $("count").className = "count rec";
    $("count").textContent = `● Recording ${((end - performance.now()) / 1000).toFixed(1)}s`;
    await sleep(100);
  }
  const r = recording; recording = null;
  if ($("forge").classList.contains("hidden")) return;
  $("count").className = "count"; $("count").textContent = "";
  const secs = (performance.now() - r.start) / 1000;
  if (r.frames.length < 20) { hint("The forge lost sight of you. Step back so your whole body fits, then try again."); $("recBtn").disabled = false; return; }
  recorded = { landmarks: r.frames, fps: Math.round((r.frames.length / secs) * 10) / 10 };
  hint(`Captured ${r.frames.length} frames of your move. Now give it a name worthy of legend.`);
  step("name");
  $("spellName").focus();
}

// ---------- forging ----------
async function forgeIt() {
  const name = $("spellName").value.trim();
  if (!name) return IF().toast("Name your spell first");
  if (!recorded) return step("record");
  $("forgeBtn").disabled = true;
  hint("Kimodo is forging your move…");
  try {
    const r = await fetch(`${IF().API}/forge`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: IF().nick, name, wild: Number($("wild").value), fps: recorded.fps, landmarks: recorded.landmarks }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.detail || r.status);
    job = out.job;
    let s;
    for (let i = 0; i < 120; i++) {
      await sleep(400);
      s = await (await fetch(`${IF().API}/forge/${job}`)).json();
      if (s.status !== "running") break;
    }
    if (s?.status !== "done") throw new Error(s?.check ? `the forge fizzled (${s.check})` : "the forge took too long");
    showResult(s, out);
  } catch (err) {
    hint(`Hmm… ${err.message || err}. Try again?`);
  } finally {
    $("forgeBtn").disabled = false;
  }
}

function showResult(s, started) {
  const c = s.card;
  $("fcard").style.setProperty("--tc", `var(--t-${c.type})`);
  $("fcard").innerHTML = `<div class="nm">${esc(c.name)}</div>
    <div class="ty">${TYPE[c.type] || "Might"} · ${esc(c.kind)} · ${esc(c.effect).replace("_", " ")}</div>
    <div class="stats"><div><b>${c.power}</b>Power</div><div><b>${Math.round((c.stability ?? 0) * 10)}</b>Stability</div><div><b>${Math.round((c.originality ?? 0) * 100)}%</b>Original</div></div>
    <div class="how">${started.fit === "on" ? "Kimodo followed your 4 key poses and made them bigger." : "Made from your spell's name."}</div>`;
  hint("Your robot performing your move:");
  step("result");
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  $("cam").style.visibility = "hidden";
  if (s.preview?.length) playPreview(s.preview, c.type);
}

function playPreview(frames, type) {
  const canvas = $("skel"), ctx = canvas.getContext("2d");
  canvas.classList.remove("mirror");
  canvas.width = 480; canvas.height = 640;
  const xs = frames.flat().map((p) => p[0]), ys = frames.flat().map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys);
  const scale = Math.min(340 / Math.max(maxY, 1), 380 / Math.max(maxX - minX, 0.5));
  const cx = 240 - ((minX + maxX) / 2) * scale, floor = 560;
  const color = getComputedStyle(document.documentElement).getPropertyValue(`--t-${type}`).trim() || "#f5d77e";
  let f = 0, last = 0;
  const tick = (t) => {
    previewRaf = requestAnimationFrame(tick);
    if (t - last < 33) return;
    last = t;
    const P = frames[f];
    ctx.fillStyle = "#0d1024"; ctx.fillRect(0, 0, 480, 640);
    ctx.strokeStyle = "rgba(201,162,74,.5)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(240, floor + 8, 170, 26, 0, 0, 7); ctx.stroke();
    ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 18;
    for (const [a, b] of G1_BONES) {
      ctx.beginPath(); ctx.moveTo(cx + P[a][0] * scale, floor - P[a][1] * scale); ctx.lineTo(cx + P[b][0] * scale, floor - P[b][1] * scale); ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.fillStyle = "#f3e6c4";
    const hx = (P[18][0] + P[26][0]) / 2, hy = (P[18][1] + P[26][1]) / 2; ctx.beginPath(); ctx.arc(cx + hx * scale, floor - hy * scale - 0.16 * scale, 0.09 * scale, 0, 7); ctx.fill();
    f = (f + 1) % frames.length;
    if (f === 0) last = t + 500; // a beat before it loops
  };
  previewRaf = requestAnimationFrame(tick);
}

async function keep() {
  $("keepBtn").disabled = true;
  try {
    const r = await fetch(`${IF().API}/forge/${job}/keep`, { method: "POST" });
    const move = await r.json();
    if (!r.ok) throw new Error(move.detail || r.status);
    IF().remember(move);
    IF().toast(`✦ ${move.name} joins your spellbook. Shout it in battle!`);
    closeForge();
    IF().refreshDeck();
  } catch (err) {
    hint(`Couldn't keep it: ${err.message || err}`);
  } finally {
    $("keepBtn").disabled = false;
  }
}

// ---------- helpers ----------
function hint(t) { $("fhint").textContent = t; }
function say(t) { try { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(t), { rate: 1.1 })); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v) => Math.round(v * 1000) / 1000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ?debug: load a recording without a camera (testing the forge flow)
if (new URLSearchParams(location.search).has("debug")) window.IF_forgeDebug = { load(rec) { recorded = rec; $("forge").classList.remove("hidden"); window.IF_forging = true; step("name"); } };
