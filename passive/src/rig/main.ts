// The passive rig: two G1s on SONIC in MuJoCo with boxer footwork between moves. They throw real
// punches at each other (a hit is fist contact), block, slip, duck, stagger, fall and get back
// up. Instant attacks test the reactions; a sparring AI can drive either fighter.
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-web";
import { Arena } from "../core/arena.ts";
import { ATTACKS } from "../core/attacks.ts";
import type { ArenaEvent, Who } from "../core/events.ts";
import type { Defense, Fighter, PunchName } from "../core/fighter.ts";
import { tiltOf } from "../core/math.ts";
import { ClipSource, LayeredSource, type MotionSource, PlannerSource } from "../core/motion.ts";
import { HttpPlanner } from "../core/planner.ts";
import { SonicPolicy } from "../core/sonic.ts";
import { STYLES, Sparrer } from "../core/spar.ts";
import { World } from "../core/world.ts";
import elfUrl from "@elf-assets/elf.glb?url";
import knightUrl from "@elf-assets/knight.glb?url";
import { loadHumanModel } from "./humanRig.ts";
import { type Look, View } from "./render.ts";

const boot = document.getElementById("boot")!;
const panel = document.getElementById("panel")!;
const status = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const say = (s: string) => (boot.textContent = s);
const params = new URLSearchParams(location.search);

// ORT finds its wasm next to its own module (onnxruntime-web is excluded from pre-bundling).
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);

say("Loading MuJoCo…");
const mj = await loadMujoco();
const robotXml = await (await fetch("/g1/g1_29dof.xml")).text();
const meshNames = [...new Set([...robotXml.matchAll(/file="([^"]+\.STL)"/g)].map((m) => m[1]))];
const meshes = new Map<string, Uint8Array>(
  await Promise.all(meshNames.map(async (n) => [n, new Uint8Array(await (await fetch(`/g1/meshes/${n}`)).arrayBuffer())] as [string, Uint8Array])),
);
const world = new World(mj, { robotXml, meshes }, [
  { prefix: "p1_", x: -0.7, y: 0, yaw: 0 },
  { prefix: "p2_", x: 0.7, y: 0, yaw: Math.PI },
]);

say("Loading SONIC (91 MB)…");
const ep = params.get("ep") ?? "wasm"; // ?ep=webgpu to try the GPU
const policy = await SonicPolicy.load(ort as never, "/sonic/model_encoder.onnx", "/sonic/model_decoder.onnx", { executionProviders: [ep] });
const planner = new HttpPlanner();
const plannerUp = await planner.alive();
const clips = await ClipSource.fetch("/clips"); // Kimodo clips, when there are any (see README)
const sources: MotionSource[] = [];
if (clips.size) sources.push(clips);
if (plannerUp) sources.push(new PlannerSource(planner));

// Who fights: one character per fighter from ../characters (?p1=elf&p2=knight is the default).
const CHARACTERS: Record<string, string> = { elf: elfUrl, knight: knightUrl };
// How far each one tucks its elbows in its guard (Fighter.guardTuck). Tuned so the elbows touch the
// ribs about equally: at full tuck a third of the knight's elbow armour pressed into his
// breastplate (10% for the elf); at 0.35 it's 9%.
const GUARD_TUCK: Record<string, number> = { elf: 1, knight: 0.35 };
const picks = [params.get("p1") ?? "elf", params.get("p2") ?? "knight"].map((c) => (c in CHARACTERS ? c : "elf"));
const title = (c: string) => c[0].toUpperCase() + c.slice(1);
const NAMES: [string, string] = picks[0] === picks[1] ? [`${title(picks[0])} 1`, `${title(picks[1])} 2`] : [title(picks[0]), title(picks[1])];
const arena = new Arena(world, policy, { names: NAMES });
arena.setMotion(sources.length ? new LayeredSource(...sources) : null);
picks.forEach((c, i) => (arena.fighters[i].guardTuck = GUARD_TUCK[c] ?? 1));
arena.reset();

say("Loading the human model…");
const humanModel = await loadHumanModel("/human/human_rigged.glb"); // see README: Human model
const view = new View(document.body, world, [0xf0a63c, 0x6c8cff], [
  { skin: 0xd8a07c, shorts: 0xf0a63c, gloves: 0xc1272d, hair: 0x2a1c12 },
  { skin: 0x8a5a3c, shorts: 0x3d5afe, gloves: 0x1f4fd1, hair: 0x101010 },
], humanModel);
say(`Loading the ${picks[0]} and the ${picks[1]}…`);
const chars = await view.loadCharacters(picks.map((c) => CHARACTERS[c])); // ../characters, rigged to the G1
const startLook = (params.get("look") as Look) ?? (chars ? "character" : "human");
view.setLook(startLook);
boot.remove();

// ---------- event log and hit flashes ----------
const log: string[] = [];
const who = (i: Who | null) => (i === null ? "Rig" : NAMES[i]);
const short = (name: string) => name.replace(/^punch\./, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
function describe(e: ArenaEvent): string | null {
  switch (e.type) {
    case "hit": return `${who(e.attacker)}: ${short(e.name)} to the ${e.zone}${e.blocked ? ", blocked" : ""}${e.counter ? ", counter" : ""}${e.knockdown ? ", KNOCKDOWN" : ""} (−${e.damage.toFixed(0)} HP)`;
    case "whiff": return e.reason === "interrupted" ? null : `${who(e.attacker)}: ${short(e.name)} ${e.reason === "dodged" ? "dodged" : "missed"}`;
    case "fall": return `${who(e.who)} loses balance`;
    case "down": return `${who(e.who)} is down`;
    case "getup": return `${who(e.who)} is up (${e.seconds.toFixed(1)} s${e.assisted ? ", assisted" : ""})`;
    case "ko": return `${who(e.who)} is KNOCKED OUT`;
    case "defend": return `${who(e.who)}: ${e.kind.replace("dodge.", "slip ").replace("slip back", "step back")}`;
    case "move": return `${who(e.who)}: ${short(e.name)}`;
    case "clinch": return "Clinch: the referee separates them";
    case "failsafe": return `Failsafe (${who(e.who)}): ${e.what}`;
    default: return null; // stance changes, staggers: too chatty for the log
  }
}
arena.on((e) => {
  if (e.type === "spawn") view.charSpawned(e.who);
  if (e.type === "hit") {
    view.charFlash(e.defender);
    const k = Math.min(1, e.impulse / 40);
    view.flash(e.point, [e.dir[0] * k, e.dir[1] * k, e.dir[2] * k], e.blocked ? 0x4dd2ff : e.attacker === null ? 0xff5a3c : 0xffd24a);
  }
  const line = describe(e);
  if (!line) return;
  log.unshift(`${arena.time.toFixed(1).padStart(5)}  ${line}`);
  log.length = Math.min(log.length, 12);
  logEl.textContent = log.join("\n");
});

// ---------- controls ----------
let target: Who = 1;
let strength = 1;
let timeScale = 1;
let paused = false;
const attacker = () => arena.fighters[1 - target];

function button(label: string, onClick: () => void, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = onClick;
  return b;
}
function group(title: string, ...els: HTMLElement[]) {
  const h = document.createElement("h2"); h.textContent = title;
  const row = document.createElement("div"); row.className = "row"; row.append(...els);
  panel.append(h, row);
  return row;
}

const h1 = document.createElement("h1"); h1.textContent = "Between moves: rig";
panel.append(h1);
const tButtons = NAMES.map((n, i) => button(n, () => setTarget(i as Who), i === target ? "on" : ""));
function setTarget(i: Who) { target = i; tButtons.forEach((b, k) => b.classList.toggle("on", k === i)); }
group("Target (gets hit, defends)", ...tButtons);

const instant = (name: string) => arena.hitInstant(target, ATTACKS.find((x) => x.name === name)!, strength);
group("Instant hits on the target", ...ATTACKS.map((a) => button(a.name, () => instant(a.name))));

const PUNCH_KEYS: [PunchName, string][] = [["punch.leftJab", "Left jab"], ["punch.rightJab", "Right jab"], ["punch.leftHook", "Left hook"], ["punch.rightHook", "Right hook"]];
const punch = (p: PunchName) => attacker().throwPunch(p, strength);
group("Thrown at the target (lands on contact)", ...PUNCH_KEYS.map(([p, label]) => button(label, () => punch(p))));

const DEFENSE_KEYS: [Defense, string][] = [["block", "Block"], ["duck", "Duck"], ["dodge.left", "Slip left"], ["dodge.right", "Slip right"], ["dodge.back", "Step back"], ["jump", "Jump"]];
const defend = (d: Defense) => arena.fighters[target].defend(d);
group("Target defends", ...DEFENSE_KEYS.map(([d, label]) => button(label, () => defend(d))));

// sparring AI: off, boxer, brawler, turtle (?spar=boxer,brawler starts with them on)
const STYLE_NAMES = ["off", "boxer", "brawler", "turtle"] as const;
const styleOf = [0, 0];
const sparButtons = NAMES.map((n, i) => button(`${n}: off`, () => setSpar(i as Who, (styleOf[i] + 1) % STYLE_NAMES.length)));
function setSpar(i: Who, s: number) {
  styleOf[i] = s;
  const name = STYLE_NAMES[s];
  arena.setBrain(i, name === "off" ? null : new Sparrer(arena.fighters[i], STYLES[name], 11 + 17 * i));
  sparButtons[i].textContent = `${NAMES[i]}: ${name}`;
  sparButtons[i].classList.toggle("on", name !== "off");
}
group("Sparring AI", ...sparButtons);
(params.get("spar") ?? "").split(",").forEach((s, i) => { const k = STYLE_NAMES.indexOf(s as never); if (k > 0 && i < 2) setSpar(i as Who, k); });

const reset = () => { arena.reset(); log.length = 0; logEl.textContent = ""; };
group("Match", button("KO target", () => arena.fighters[target].knockOut()), button("Reset", reset));

const slider = document.createElement("label");
slider.innerHTML = `Strength <input type="range" min="0.4" max="2" step="0.1" value="1"> <span>1.0x</span>`;
const input = slider.querySelector("input")!, out = slider.querySelector("span")!;
input.oninput = () => { strength = Number(input.value); out.textContent = `${strength.toFixed(1)}x`; };
panel.append(slider);

const looks: Look[] = chars ? ["character", "human", "robot", "both"] : ["human", "robot", "both"];
const lookLabel = (l: Look) => (l === "character" ? `${NAMES[0]} vs ${NAMES[1]}` : l[0].toUpperCase() + l.slice(1));
const lookButtons = looks.map((l) => button(lookLabel(l), () => setLook(l), l === startLook ? "on" : ""));
function setLook(l: Look) { view.setLook(l); lookButtons.forEach((b, i) => b.classList.toggle("on", looks[i] === l)); }
group("Look", ...lookButtons);

let boxes = params.has("hitboxes");
const boxButton = button("Hitboxes", () => setBoxes(!boxes), boxes ? "on" : "");
function setBoxes(on: boolean) { boxes = on; boxButton.classList.toggle("on", on); view.showHitboxes(on ? arena.fighters : null, arena.combat, () => arena.time); }
setBoxes(boxes);
const slow = button("Slow-mo", () => { timeScale = timeScale === 1 ? 0.25 : 1; slow.classList.toggle("on", timeScale !== 1); });
const pause = button("Pause", () => { paused = !paused; pause.classList.toggle("on", paused); });
group("View and time", boxButton, slow, pause);

const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = (plannerUp ? "Planner: on." : "Planner offline: run `npm run planner` and reload for footwork, punches and natural get-ups.") +
  (clips.size ? ` Clips: ${clips.size} motions.` : "") +
  " Keys: 1-7 hits, J/L jabs, U/O hooks, B block, N duck, arrows slip/step back/jump, T target, K KO, R reset, X hitboxes, Space pause, H hide.";
panel.append(hint);
panel.hidden = false;
status.hidden = false;
logEl.hidden = false;

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const i = Number(e.key) - 1;
  const k = e.key.toLowerCase();
  if (i >= 0 && i < ATTACKS.length) instant(ATTACKS[i].name);
  else if (k === "j") punch("punch.leftJab");
  else if (k === "l") punch("punch.rightJab");
  else if (k === "u") punch("punch.leftHook");
  else if (k === "o") punch("punch.rightHook");
  else if (k === "b") defend("block");
  else if (k === "n") defend("duck");
  else if (e.key === "ArrowLeft") defend("dodge.left");
  else if (e.key === "ArrowRight") defend("dodge.right");
  else if (e.key === "ArrowDown") defend("dodge.back");
  else if (e.key === "ArrowUp") defend("jump");
  else if (k === "t") setTarget((1 - target) as Who);
  else if (k === "k") arena.fighters[target].knockOut();
  else if (k === "r") reset();
  else if (k === "x") setBoxes(!boxes);
  else if (e.key === " ") pause.click();
  else if (k === "h") { panel.hidden = !panel.hidden; status.hidden = panel.hidden; logEl.hidden = panel.hidden; }
  else return;
  e.preventDefault();
});

// ---------- loop ----------
let last = performance.now(), acc = 0, busy = false, tickMs = 0, fpsT = 0, frames = 0, fps = 0, koSince = -1;

async function physics() {
  busy = true;
  try {
    let n = 0;
    while (acc >= 0.02 && n < 3) {
      const a = performance.now();
      await arena.tick();
      tickMs = tickMs * 0.95 + (performance.now() - a) * 0.05;
      acc -= 0.02; n++;
    }
    if (n === 3) acc = Math.min(acc, 0.02); // can't keep up: run slower instead of spiraling
    // with an AI fighting, start the next bout a few seconds after a KO
    const ko = arena.fighters.some((f) => f.stance === "ko");
    if (!ko) koSince = -1;
    else if (koSince < 0) koSince = arena.time;
    else if (arena.brains.some(Boolean) && arena.time - koSince > 6) reset();
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

function line(f: Fighter, i: number) {
  const p = world.rootPos(f.robot), tilt = (tiltOf(world.rootQuat(f.robot)) * 180) / Math.PI;
  return `${f.name.padEnd(9)} ${f.stance.padEnd(8)} HP ${arena.hp[i].toFixed(0).padStart(3)}  poise ${f.poise.toFixed(2)}\n` +
    `  z ${p[2].toFixed(2)} m  tilt ${tilt.toFixed(0).padStart(3)}°  ${f.intent}\n  ${f.lastEvent}`;
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) acc += dt * timeScale;
  if (!busy) void physics();
  view.sync();
  const a = world.rootPos(arena.fighters[0].robot), b = world.rootPos(arena.fighters[1].robot);
  view.render(dt, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  status.textContent = `${line(arena.fighters[0], 0)}\n\n${line(arena.fighters[1], 1)}\n\n` +
    `apart ${arena.distance().toFixed(2)} m · sim ${arena.time.toFixed(1)} s · ${fps.toFixed(0)} fps · tick ${tickMs.toFixed(1)} ms · SONIC on ${ep}`;
}
requestAnimationFrame(frame);
// debug handle for the console (and for tuning): __rig.arena, __rig.view
Object.assign(globalThis, { __rig: { arena, view } });
