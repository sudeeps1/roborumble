// The passive rig: two G1s on SONIC in MuJoCo, boxer footwork between moves, and buttons that
// throw simulated attacks so you can watch them stagger, fall and get back up.
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-web";
import { ATTACKS } from "../core/attacks.ts";
import { Arena, Fighter } from "../core/fighter.ts";
import { tiltOf } from "../core/math.ts";
import { HttpPlanner, Mode } from "../core/planner.ts";
import { SonicPolicy } from "../core/sonic.ts";
import { World } from "../core/world.ts";
import { View } from "./render.ts";

const boot = document.getElementById("boot")!;
const panel = document.getElementById("panel")!;
const status = document.getElementById("status")!;
const say = (s: string) => (boot.textContent = s);

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
const ep = new URLSearchParams(location.search).get("ep") ?? "wasm"; // ?ep=webgpu to try the GPU
const policy = await SonicPolicy.load(ort as never, "/sonic/model_encoder.onnx", "/sonic/model_decoder.onnx", { executionProviders: [ep] });
const planner = new HttpPlanner();
const plannerUp = await planner.alive();

const you = new Fighter("You", world, world.robots[0], policy, 7);
const opp = new Fighter("Opponent", world, world.robots[1], policy, 99);
if (plannerUp) you.planner = opp.planner = planner;
const arena = new Arena(world, [you, opp]);
const reset = () => { you.spawn(-0.7, 0, 0); opp.spawn(0.7, 0, Math.PI); };
reset();

const view = new View(document.body, world, [0xf0a63c, 0x6c8cff]);
boot.remove();

// ---------- controls ----------
let target: Fighter = opp;
let strength = 1;
let timeScale = 1;
let paused = false;

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

const attack = (f: Fighter, name: string) => {
  const a = ATTACKS.find((x) => x.name === name)!;
  const from = world.rootPos((f === you ? opp : you).robot);
  const { point, force } = f.hit(a, from, strength);
  view.flash(point, force);
};

const h1 = document.createElement("h1"); h1.textContent = "Between moves: rig";
panel.append(h1);
const tYou = button("You (orange)", () => setTarget(you));
const tOpp = button("Opponent (blue)", () => setTarget(opp), "on");
function setTarget(f: Fighter) { target = f; tYou.classList.toggle("on", f === you); tOpp.classList.toggle("on", f === opp); }
group("Hit", tYou, tOpp);
group("Attacks", ...ATTACKS.map((a) => button(a.name, () => attack(target, a.name))));

// Real punches: the other robot steps in and throws one with the planner; the hit lands at the fist.
const punch = (mode: number, name: string) => {
  const attacker = target === you ? opp : you;
  attacker.throwPunch(target, mode, ATTACKS.find((x) => x.name === name)!, strength, (hit) => { if (hit) view.flash(hit.point, hit.force, 0xffd24a); });
};
group("Thrown punches (the other robot steps in)",
  button("Left jab", () => punch(Mode.leftJab, "Jab")),
  button("Right jab", () => punch(Mode.rightJab, "Jab")),
  button("Left hook", () => punch(Mode.leftHook, "Hook")),
  button("Right hook", () => punch(Mode.rightHook, "Hook")),
);
const flurry = () => ["Jab", "Body shot", "Hook"].forEach((n, i) => setTimeout(() => attack(target, n), i * 280));
group("Combos", button("Jab, body, hook", flurry), button("KO", () => target.knockOut()));

const slider = document.createElement("label");
slider.innerHTML = `Strength <input type="range" min="0.4" max="2" step="0.1" value="1"> <span>1.0x</span>`;
const input = slider.querySelector("input")!, out = slider.querySelector("span")!;
input.oninput = () => { strength = Number(input.value); out.textContent = `${strength.toFixed(1)}x`; };
panel.append(slider);

const slow = button("Slow-mo", () => { timeScale = timeScale === 1 ? 0.25 : 1; slow.classList.toggle("on", timeScale !== 1); });
const pause = button("Pause", () => { paused = !paused; pause.classList.toggle("on", paused); });
group("Time", slow, pause, button("Reset", reset));
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = plannerUp ? "Planner: on (boxer footwork, planned get-ups)" : "Planner offline: run `npm run planner` and reload for footwork and natural get-ups.";
panel.append(hint);
panel.hidden = false;
status.hidden = false;

// keyboard: 1-7 attacks on the selected target, K knock out, R reset, Space pause
addEventListener("keydown", (e) => {
  const i = Number(e.key) - 1;
  if (i >= 0 && i < ATTACKS.length) attack(target, ATTACKS[i].name);
  else if (e.key === "k") target.knockOut();
  else if (e.key === "r") reset();
  else if (e.key === " ") pause.click();
});

// ---------- loop ----------
let last = performance.now(), acc = 0, busy = false, tickMs = 0, ticks = 0, fpsT = 0, frames = 0, fps = 0;

async function physics() {
  busy = true;
  let n = 0;
  while (acc >= 0.02 && n < 3) {
    const a = performance.now();
    await arena.tick();
    tickMs = tickMs * 0.95 + (performance.now() - a) * 0.05;
    acc -= 0.02; n++; ticks++;
  }
  if (n === 3) acc = Math.min(acc, 0.02); // can't keep up: run slower instead of spiraling
  busy = false;
}

function line(f: Fighter) {
  const p = world.rootPos(f.robot), tilt = (tiltOf(world.rootQuat(f.robot)) * 180) / Math.PI;
  return `${f.name.padEnd(9)} ${f.stance.padEnd(8)} z ${p[2].toFixed(2)} m  tilt ${tilt.toFixed(0).padStart(3)}°\n  ${f.intent}\n  ${f.lastEvent}`;
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) acc += dt * timeScale;
  if (!busy) void physics();
  view.sync();
  const a = world.rootPos(you.robot), b = world.rootPos(opp.robot);
  view.render(dt, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  status.textContent = `${line(you)}\n\n${line(opp)}\n\nsim ${arena.simTime.toFixed(1)} s · ${fps.toFixed(0)} fps · tick ${tickMs.toFixed(1)} ms · SONIC on ${ep}`;
}
requestAnimationFrame(frame);
