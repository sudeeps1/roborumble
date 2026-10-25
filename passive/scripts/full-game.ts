// A full game through all three devices, with pretend phones. The real screen (the game page in headless
// Chrome: the real physics and rendering) opens a room on the game server, two phone bots
// (scripts/phone-bot.ts) take the seats and shout moves until the match ends. Then it checks:
//   - the match ran to a winner, and every round that started also ended
//   - shouts reached the screen and played (a "cast" event), or fizzled with a reason
//   - live wildcards were channelled and then played
//   - state reached the phones the whole time (no gap over 1 s), and the page logged no errors
// It prints a report and exits 1 if a check fails. Wildcard moves the bots invented are retired from the
// library afterwards, so tests don't fill it up.
//   node scripts/full-game.ts [--screen http://localhost:5180/] [--server URL] [--wild 1] [--shots DIR] [--fill] [--params fx=game] [--chaos]
// --chaos: 10 s into round 1 the screen loses its connection to the server; 8 s into round 2 a phone
// drops off for 3 s. The match must carry on, and the phone must get its seat back.
// --video match.mp4 records the screen (HUD and all) from the lobby to the victory, in real time, 1920x1080
// unless --size says otherwise; --every 3.5 makes the bots shout at a more human pace.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER, PhoneBot, libraryNames } from "./phone-bot.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SCREEN = arg("screen", "http://localhost:5180/")!;
const SERVER = arg("server", DEFAULT_SERVER)!.replace(/\/+$/, "");
const WILD = Number(arg("wild", "1"));
const SHOTS = arg("shots");
const ONE_BOT = process.argv.includes("--fill"); // one phone; the AI plays the other seat
const EXTRA = arg("params", ""); // more screen URL options, e.g. fx=game
const CHAOS = process.argv.includes("--chaos");
let screenDropped = false;
const TIMEOUT = Number(arg("timeout", "540")) * 1000;
const VIDEO = arg("video");
const [W, H] = arg("size", VIDEO ? "1920x1080" : "1280x720")!.split("x").map(Number);
const EVERY = Number(arg("every", "2.4"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// none of these match the library (checked with a dry-run POST /match), so each one is a live wildcard
const WILD_PHRASES = ["grandmas casserole meteor", "banana peel tsunami", "invisible accordion ambush"];

const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = `T${Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(Math.random() * 23)]).join("")}`;

// ---------------------------------------------------------------- the screen, in headless Chrome
const port = 9700 + (process.pid % 200);
const profile = mkdtempSync(join(tmpdir(), "fg-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  "--hide-scrollbars", "--no-first-run", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch { /* gone */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ } };
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

let page: { send: (method: string, params?: object) => Promise<any> } | null = null;
const pageErrors: string[] = [];
const pageInfo: string[] = [];
async function openScreen(url: string) {
  let target: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(150); }
  }
  if (!target) throw new Error("headless Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
    if (msg.method === "Page.screencastFrame") onFrame(msg.params);
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a: any) => a.value ?? a.description).join(" ");
      if (msg.params.type === "error") pageErrors.push(text);
      else if (msg.params.type === "info") pageInfo.push(text);
    }
  };
  const send = (method: string, params = {}) => new Promise<any>((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  page = { send };
}
const evaluate = async (expr: string) => (await page!.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
// ---------------------------------------------------------------- the video: screencast frames, then ffmpeg
const frames: { file: string; t: number }[] = [];
let frameDir = "";
let recording = false;
function onFrame(f: { data: string; sessionId: number; metadata: { timestamp: number } }) {
  void page!.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  if (!recording) return;
  const file = join(frameDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
}
async function startVideo() {
  if (!VIDEO || recording) return;
  frameDir = mkdtempSync(join(tmpdir(), "fgv-"));
  recording = true;
  await page!.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  log(`recording ${W}x${H}`);
}
/** Every frame for as long as it was on screen, then a steady 30 fps H.264. */
async function stopVideo() {
  if (!recording) return;
  recording = false;
  await page!.send("Page.stopScreencast");
  if (frames.length < 2) { log("no video frames"); return; }
  const list = join(frameDir, "frames.txt");
  const lines = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}`);
  lines.push(`file '${frames[frames.length - 1].file}'`); // the concat demuxer wants the last one twice
  writeFileSync(list, lines.join("\n"));
  const span = frames[frames.length - 1].t - frames[0].t;
  log(`encoding ${frames.length} frames (${span.toFixed(0)} s, ${(frames.length / span).toFixed(1)} fps captured)`);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,format=yuv420p",
    "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", VIDEO!], { stdio: "inherit" });
  rmSync(frameDir, { recursive: true, force: true });
  log(r.status === 0 ? `video: ${VIDEO}` : `ffmpeg failed (${r.status})`);
}

let shotN = 0;
async function shot(name: string) {
  if (!SHOTS || !page) return;
  log(`screenshot ${name}`);
  const r = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
  if (r.result?.data) writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}.jpg`), Buffer.from(r.result.data, "base64"));
}

// ---------------------------------------------------------------- the game
const check: { ok: boolean; what: string }[] = [];
const expect = (ok: boolean, what: string) => check.push({ ok, what });
let bots: PhoneBot[] = [];

try {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const health = await (await fetch(`${SERVER}/health`)).json() as Record<string, any>;
  log(`server ${SERVER}: ${health.engine} ${health.model ?? ""}, library ${health.library}, matcher ${health.matcher}`);
  const screenUrl = `${SCREEN}?room=${code}&server=${encodeURIComponent(SERVER)}${ONE_BOT ? "&fill=ai" : ""}${EXTRA ? `&${EXTRA}` : ""}`;
  log(`screen ${screenUrl}`);
  await openScreen(screenUrl);
  // the screen boots (MuJoCo, SONIC, the characters) and joins the room as the game
  for (let i = 0; ; i++) {
    const room = await (await fetch(`${SERVER}/room/${code}`)).json() as { game_connected: boolean };
    if (room.game_connected) break;
    if (i > 240) throw new Error("the screen never joined the room");
    await sleep(500);
  }
  log(`room ${code}: the screen is in`);
  const names = await libraryNames(SERVER);
  const wild = WILD_PHRASES.slice(0, Math.max(0, WILD));
  const mk = (n: number) => new PhoneBot({ server: SERVER, room: code, nickname: `test-bot-${n}`, names, every: EVERY, wild: n === 1 ? wild : [], taps: 0.25, seed: 1000 * n + (t0 % 997), log });
  bots = ONE_BOT ? [mk(1)] : [mk(1), mk(2)];
  for (const b of bots) await b.start();
  await startVideo();
  await shot("lobby");

  // until the match ends
  const seen = new Set<string>();
  let ended = false;
  while (!ended) {
    if (Date.now() - t0 > TIMEOUT) throw new Error("the match didn't end in time");
    await sleep(250);
    for (const e of bots[0].events) {
      const k = `${e.at}:${JSON.stringify(e.event)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const ev = e.event;
      if (ev.kind === "round_start") {
        log(`round ${ev.round}`);
        if (CHAOS && ev.round === 1) setTimeout(() => { log("chaos: the screen loses its connection"); void evaluate("__screen.dropLink?.()"); screenDropped = true; }, 10000);
        if (CHAOS && ev.round === 2) setTimeout(() => void bots[bots.length - 1].blip(3000), 8000);
        await sleep(1500); await shot(`round${ev.round}`);
      }
      else if (ev.kind === "ko") { log(`K.O.: player ${ev.loser} is out`); await shot("ko"); }
      else if (ev.kind === "round") log(`round to ${ev.winner ? `player ${ev.winner}` : "nobody (draw)"}`);
      else if (ev.kind === "down") log(`player ${ev.player} is down`);
      else if (ev.kind === "fizzle") log(`fizzle: player ${ev.player} ${ev.move} (${ev.why})`);
      else if (ev.kind === "cast" && ev.new) { log(`new spell played: ${ev.move}`); await shot("wildcard"); }
      else if (ev.kind === "match_end") { log(`match over: player ${ev.winner} wins`); await sleep(2500); await shot("victory"); if (VIDEO) await sleep(3000); ended = true; }
    }
  }

  // ---------------------------------------------------------------- what happened
  const ev = bots[0].events.map((e) => e.event);
  const kinds = (k: string) => ev.filter((e) => e.kind === k);
  // (a recording waits past the end, long enough for the rematch's first round to start: not counted)
  const endAt = ev.findIndex((e) => e.kind === "match_end");
  const inMatch = endAt >= 0 ? ev.slice(0, endAt + 1) : ev;
  const starts = inMatch.filter((e) => e.kind === "round_start").length, ends = inMatch.filter((e) => e.kind === "round").length;
  expect(kinds("match_end").length === 1, `the match ended with a winner (player ${kinds("match_end")[0]?.winner})`);
  expect(starts >= 2 && starts === ends, `every round that started ended (${starts} started, ${ends} ended)`);
  // shouts -> casts: each library shout the server answered with "play" should play or fizzle on the screen
  for (const b of bots) {
    const p = b.player!;
    const casts = kinds("cast").filter((e) => e.player === p).length;
    const fizz = kinds("fizzle").filter((e) => e.player === p);
    const plays = b.shouts.filter((s) => s.result === "play").length;
    const charges = b.shouts.filter((s) => s.result === "charge").length;
    const errors = b.shouts.filter((s) => s.error);
    log(`player ${p} (${b.o.nickname}): ${b.shouts.length} shouts (${plays} library, ${charges} wildcards, ${errors.length} errors), ${casts} played, ${fizz.length} fizzled${fizz.length ? ` (${[...new Set(fizz.map((f) => f.why))].join(", ")})` : ""}, ${b.taps} taps (${b.defending} states defending), ${b.states} states, longest gap ${b.maxStateGap} ms at ${((b.maxStateGapAt - t0) / 1000).toFixed(1)}s`);
    if (b.taps >= 10) expect(b.defending > 0, `player ${p}: taps turned into defenses (${b.defending} states blocking or dodging)`);
    expect(errors.length === 0, `player ${p}: every shout was answered (${errors.map((e) => e.error).join("; ") || "no errors"})`);
    expect(plays + charges > 0 && casts + fizz.length >= Math.floor(0.8 * (plays + charges)) - 2, `player ${p}: shouts reached the screen (${plays + charges} matched, ${casts} played, ${fizz.length} fizzled)`);
    expect(b.maxStateGap < (CHAOS ? 4000 : 1000), `player ${p}: state kept coming (longest gap ${b.maxStateGap} ms${CHAOS ? ", the screen reconnecting included" : ""})`);
  }
  const wildShouts = bots.flatMap((b) => b.shouts.filter((s) => s.wild));
  if (wildShouts.length) {
    const newCasts = kinds("cast").filter((e) => e.new).length;
    const charged = wildShouts.filter((s) => s.result === "charge").length;
    for (const l of pageInfo.filter((l) => l.startsWith("room: player"))) log(`screen ${l}`);
    expect(newCasts === charged, `every live wildcard was made and played as new (${wildShouts.length} shouted, ${charged} charged, ${newCasts} played as new)`);
  }
  if (CHAOS) {
    const b = bots[bots.length - 1];
    expect(screenDropped, "chaos: the screen's connection was dropped mid-round");
    expect(b.rejoins.length >= 1 && b.rejoins.every((p) => p === b.player), `chaos: the phone that dropped got its seat back (${b.rejoins.join(", ") || "never rejoined"})`);
  }
  const hits = kinds("hit"), blocks = kinds("blocked").length, dodges = kinds("dodged").length;
  log(`fight: ${hits.length} hits (${Math.round(hits.reduce((a, h) => a + h.damage, 0))} damage), ${blocks} blocked, ${dodges} dodged, ${kinds("down").length} downs, ${kinds("ko").length} KOs`);
  const narration = (await evaluate("JSON.stringify(__screen.room?.narration ?? [])")) as string;
  const lines = JSON.parse(narration ?? "[]") as string[];
  log(`narrator: ${lines.length} lines${lines.length ? `, e.g. "${lines[0]}"` : ""}`);
  expect(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(" | ")}` : ""}`);
} catch (e) {
  expect(false, `ran to the end: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await stopVideo().catch((e) => log(`video: ${e}`));
  for (const b of bots) b.stop();
  // the bots' live wildcards leave the library again
  for (const b of bots) {
    try {
      const deck = await (await fetch(`${SERVER}/deck?nickname=${encodeURIComponent(b.o.nickname)}`)).json() as { moves: { id: string; created_at?: number; source?: string }[] };
      for (const m of deck.moves.filter((m) => m.source === "live" && (m.created_at ?? 0) * 1000 >= t0 - 5000)) {
        await fetch(`${SERVER}/move/${m.id}/retire`, { method: "POST" });
        log(`retired test wildcard ${m.id}`);
      }
    } catch { /* best effort */ }
  }
}

console.log("\n" + check.map((c) => `${c.ok ? "  ok  " : "  FAIL"} ${c.what}`).join("\n"));
const failed = check.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${check.length} checks passed (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed ? 1 : 0);
