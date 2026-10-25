// The fight screen (the big screen; the players' phones are the other two devices). The real sim from
// ../core (two G1s on SONIC in MuJoCo, with the referee, combat and spells) drawn as the elf and the
// knight in the arena, with a camera that has life in it, effects, the HUD and best-of-3 rounds.
// Driven by the sparring AI or the keyboard for now; phones plug in through window.__screen.
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-web";
import elfUrl from "@elf-assets/elf.glb?url";
import knightUrl from "@elf-assets/knight.glb?url";
import * as THREE from "three";
import { Arena, SPAWNS } from "../core/arena.ts";
import type { ArenaEvent, Who } from "../core/events.ts";
import type { Defense, Fighter, PunchName } from "../core/fighter.ts";
import { ClipSource, LayeredSource, type MotionSource, PlannerSource } from "../core/motion.ts";
import { HttpPlanner } from "../core/planner.ts";
import { SonicPolicy } from "../core/sonic.ts";
import { STYLES, Sparrer } from "../core/spar.ts";
import { type MoveSpec, specFromLibrary } from "../core/spells.ts";
import { World } from "../core/world.ts";
import { buildArena } from "./arena.ts";
import { Director } from "./camera.ts";
import { Fx, typeColors } from "./fx.ts";
import { Hud, type SpellInfo } from "./hud.ts";
import { portrait } from "./portrait.ts";
import { Stage } from "./stage.ts";

const params = new URLSearchParams(location.search);
const boot = document.getElementById("boot")!;
const say = (s: string) => (boot.textContent = s);

/** The two fighters. Names are invented; colours are the HUD's team colours. */
const ROSTER = [
  { id: "elf", name: "Sylvara", title: "Warden of the Silverwood", url: elfUrl, hue: 0, tuck: 1, color: "#e8806e" },
  { id: "knight", name: "Sir Aldric", title: "The Iron Oath", url: knightUrl, hue: -2.45, tuck: 0.35, color: "#7b9cf0" },
] as const;
export const RULES = { roundSeconds: 60, winsNeeded: 2, introS: 2.6, koHoldS: 3.6, victoryS: 6 };

// ---------------------------------------------------------------- the sim (as the rig boots it)
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
say("Loading MuJoCo…");
const mj = await loadMujoco();
const robotXml = await (await fetch("/g1/g1_29dof.xml")).text();
const meshNames = [...new Set([...robotXml.matchAll(/file="([^"]+\.STL)"/g)].map((m) => m[1]))];
const meshes = new Map<string, Uint8Array>(await Promise.all(meshNames.map(async (n) => [n, new Uint8Array(await (await fetch(`/g1/meshes/${n}`)).arrayBuffer())] as [string, Uint8Array])));
const world = new World(mj, { robotXml, meshes }, SPAWNS.map(([x, y, yaw], i) => ({ prefix: `p${i + 1}_`, x, y, yaw })));
say("Loading SONIC (91 MB)…");
const ep = params.get("ep") ?? "wasm";
const policy = await SonicPolicy.load(ort as never, "/sonic/model_encoder.onnx", "/sonic/model_decoder.onnx", { executionProviders: [ep] });
const planner = new HttpPlanner();
const plannerUp = await planner.alive();
const clips = await ClipSource.fetch("/clips");
const sources: MotionSource[] = [];
if (clips.size) sources.push(clips);
if (plannerUp) sources.push(new PlannerSource(planner));
const arena = new Arena(world, policy, { names: [ROSTER[0].name, ROSTER[1].name] });
arena.setMotion(sources.length ? new LayeredSource(...sources) : null);
ROSTER.forEach((r, i) => (arena.fighters[i].guardTuck = r.tuck));

// the spellbook: Kimodo spells with their specs (public/clips-kimodo/spells.json); the phones add more
say("Loading the spellbook…");
interface Spell { spec: MoveSpec; qpos: number[][]; fps: number }
const book: Spell[] = [];
try {
  const lib = await (await fetch("/clips-kimodo/spells.json")).json() as (Parameters<typeof specFromLibrary>[0] & { file: string })[];
  for (const e of lib) {
    const c = await (await fetch(`/clips-kimodo/${e.file}`)).json() as { qpos: number[][]; fps: number };
    book.push({ spec: specFromLibrary(e), qpos: c.qpos, fps: c.fps ?? 30 });
  }
} catch (e) { console.warn("no spellbook:", e); }
const known = new Map<string, MoveSpec>(book.map((s) => [s.spec.name, s.spec]));
const fresh = new Set<string>(); // spells cast for the first time ever (the HUD flags them NEW)

// ---------------------------------------------------------------- the view
say("Loading the elf and the knight…");
const stage = new Stage(document.body, world);
await stage.loadCharacters(ROSTER.map((r) => r.url), ROSTER.map((r) => r.hue));
const set = buildArena(stage);
const fx = new Fx(arena, set.look, (n) => known.get(n));
stage.scene.add(fx.root);
const director = new Director(stage.camera);
const icons = await Promise.all(ROSTER.map((r, i) => portrait(r.url, r.hue, i ? "left" : "right", i ? 0x9cb8ff : 0xffb08a)));
const hud = new Hud(document.getElementById("hud")!, ROSTER.map((r, i) => ({ name: r.name, title: r.title, color: r.color, portrait: icons[i] })));
const whiteout = Object.assign(document.createElement("div"), { className: "flashscreen" });
document.body.append(whiteout);
boot.remove();

// ---------------------------------------------------------------- drivers: sparring AI, keyboard
const brains = arena.fighters.map((f, i) => {
  const s = new Sparrer(f, STYLES[(params.get("spar")?.split(",")[i] as keyof typeof STYLES) || (i ? "brawler" : "boxer")] ?? STYLES.boxer, 11 + 17 * i);
  s.spellbook = book; // the sparring AI casts from the same book
  return s;
});
const demo = params.has("demo"); // a scripted bout (see flow): every kind of spell, both AIs off
const aiOn = [params.get("ai") !== "0" && !demo, params.get("ai") !== "0" && !demo];
let brainsLive = false;
function syncBrains() { brains.forEach((b, i) => arena.setBrain(i as Who, brainsLive && aiOn[i] ? b : null)); }

/** Casts a spell from the book, or any spec with a clip. Registers it so the HUD and effects know it. */
function cast(i: Who, spec: MoveSpec, qpos: number[][], fps = 30, isNew = false) {
  known.set(spec.name, spec);
  if (isNew) fresh.add(spec.name);
  return arena.fighters[i].cast(spec, qpos, fps);
}

// ---------------------------------------------------------------- rounds
type Phase = "intro" | "fight" | "ko" | "over";
let phase: Phase = "intro", phaseT = 0, clock = RULES.roundSeconds, round = 1;
const wins: [number, number] = [0, 0];
let winner: Who | null = null;
let fightShown = false;

function startRound() {
  for (const step of DEMO) step.done = false;
  arena.reset();
  fx.clear();
  phase = "intro"; phaseT = 0; clock = RULES.roundSeconds; winner = null; fightShown = false;
  brainsLive = false; syncBrains();
  director.cut("intro");
  hud.wins(wins);
  hud.show(`Round ${round}`, round === 3 ? "Final round" : wins[0] + wins[1] === 0 ? `${ROSTER[0].name} vs ${ROSTER[1].name}` : "", 1.7);
}
function newMatch() { wins[0] = wins[1] = 0; round = 1; startRound(); }

function endRound(w: Who | null, how: "ko" | "time") {
  if (phase !== "fight") return;
  phase = "ko"; phaseT = 0; winner = w;
  if (w !== null) wins[w]++;
  hud.wins(wins);
  brainsLive = false; syncBrains();
  if (how === "ko" && w !== null) {
    const loser = arena.fighters[1 - w];
    freeze(220);
    slowmo(0.28, 1.8);
    flash(0.9);
    director.shake(0.9);
    director.cut("ko", { at: world.rootPos(loser.robot), other: world.rootPos(arena.fighters[w].robot) });
    hud.show("K.O.", "", 2.4, "ko");
  } else hud.show("Time!", w === null ? "Draw" : `${ROSTER[w].name} wins the round`, 2.4);
}

function flow(dtSim: number, dtReal: number) {
  phaseT += dtReal;
  if (phase === "intro") {
    if (phaseT > 1.8 && !fightShown) { fightShown = true; hud.show("Fight!", "", 0.9, "fight"); director.shake(0.25); }
    if (phaseT > RULES.introS) { phase = "fight"; phaseT = 0; brainsLive = true; syncBrains(); }
  } else if (phase === "fight") {
    clock -= dtSim;
    // ?koAt=8: knock the knight out 8 s into each round (to check the KO shot without waiting for one)
    const koAt = Number(params.get("koAt") ?? 0);
    if (koAt && RULES.roundSeconds - clock >= koAt && arena.fighters[1].stance !== "ko") { arena.hp[1] = 0; arena.fighters[1].knockOut(); }
    if (demo) for (const step of DEMO) if (!step.done && RULES.roundSeconds - clock >= step.at) { step.done = true; step.run(); }
    if (clock <= 0) { const [a, b] = arena.hp; endRound(a === b ? null : a > b ? 0 : 1, "time"); }
  } else if (phase === "ko") {
    if (phaseT > RULES.koHoldS) {
      if (winner !== null && wins[winner] >= RULES.winsNeeded) {
        phase = "over"; phaseT = 0;
        const w = arena.fighters[winner];
        director.cut("victory", { at: world.rootPos(w.robot), other: world.rootPos(w.opponent.robot) });
        hud.show(`${ROSTER[winner].name} wins`, ROSTER[winner].title, RULES.victoryS - 0.5, "victory");
      } else { round++; startRound(); }
    }
  } else if (phase === "over" && phaseT > RULES.victoryS) newMatch();
  hud.clock(phase === "intro" ? RULES.roundSeconds : clock, round);
}

// ---------------------------------------------------------------- game feel: hit-stop, slow motion, flashes
let freezeUntil = 0, slowUntil = 0, slowScale = 1, slowLen = 1;
function freeze(ms: number) { freezeUntil = Math.max(freezeUntil, performance.now() + ms); }
function slowmo(scale: number, seconds: number) { slowScale = scale; slowLen = seconds; slowUntil = performance.now() + seconds * 1000; }
function flash(a: number) { whiteout.style.transition = "none"; whiteout.style.opacity = String(a * 0.22); requestAnimationFrame(() => { whiteout.style.transition = "opacity .18s"; whiteout.style.opacity = "0"; }); }
const timeScale = (now: number) => {
  if (now < freezeUntil) return 0;
  if (now < slowUntil) { const k = 1 - (slowUntil - now) / (slowLen * 1000); return slowScale + (1 - slowScale) * k * k * k; } // eases back to full speed
  return 1;
};

const v3 = new THREE.Vector3();
function onScreen(p: ArrayLike<number>) {
  v3.set(p[0], p[1], p[2]).project(stage.camera);
  return { x: (v3.x * 0.5 + 0.5) * innerWidth, y: (-v3.y * 0.5 + 0.5) * innerHeight, ok: v3.z < 1 };
}

arena.on((e: ArenaEvent) => {
  fx.onEvent(e);
  switch (e.type) {
    case "hit": {
      hud.hp(e.defender, e.hp, arena.maxHp);
      const k = Math.min(1.6, e.impulse / 30);
      const big = !e.blocked && (e.knockdown || e.counter || e.clean || e.damage >= 12);
      freeze(e.blocked ? 45 : big ? 95 + 50 * k : 55 + 25 * k);
      director.shake(e.blocked ? 0.12 : Math.min(0.8, 0.16 + 0.32 * k + (e.knockdown ? 0.25 : 0)));
      director.kick(e.dir, e.blocked ? 0.008 : 0.02 + 0.02 * k);
      if (big) director.punch(e.point, e.knockdown ? 0.17 : 0.1);
      if (e.knockdown || e.counter) flash(e.knockdown ? 0.7 : 0.4);
      const s = onScreen(e.point);
      const tags = [e.blocked && "BLOCKED", e.counter && "COUNTER!", e.clean && "CLEAN HIT", e.knockdown && "KNOCKDOWN"].filter(Boolean) as string[];
      const col = e.spellType && e.how ? `#${typeColors(e.spellType).spark.toString(16).padStart(6, "0")}` : "#fff";
      if (s.ok && e.damage >= 0.5) hud.damage(s.x, s.y - innerHeight * 0.08, e.damage, tags, big, col); // above the hit, off the face
      return;
    }
    case "move": {
      const spec = known.get(e.name);
      if (!spec) return; // punches: the body says it
      const info: SpellInfo = { name: spec.name, type: spec.type, kind: spec.kind, power: spec.power, isNew: fresh.has(spec.name) };
      fresh.delete(spec.name);
      hud.callout(e.who, info);
      hud.channel(e.who, null);
      fx.channel(e.who, false);
      stage.chars[e.who]?.setGlow(0);
      return;
    }
    case "release":
      director.shake(e.kind === "projectile" ? 0.1 : 0.06);
      if (e.kind !== "strike") director.punch(e.point, 0.05, 0.06, 0.05, 0.3);
      return;
    case "knockdown": director.shake(0.45); return;
    case "whiff":
      if (e.reason === "dodged") { const s = onScreen(arena.fighters[1 - e.attacker].body.headPos()); if (s.ok) hud.damage(s.x, s.y - 40, 0, ["DODGED"], false); }
      return;
    case "ko": endRound((1 - e.who) as Who, "ko"); return;
    case "reset": arena.fighters.forEach((_, i) => { hud.hp(i as Who, arena.maxHp, arena.maxHp); hud.poise(i as Who, 1); }); return;
    case "spawn": stage.chars[e.who]?.resetSprings(); return;
    default: return;
  }
});
fx.onSlam = (s, at) => { director.shake(0.12 + 0.55 * s); if (s > 0.45) director.punch(at, 0.05 + 0.05 * s); };

// ---------------------------------------------------------------- status tags under the plates
const DEFENSE_LABEL: Record<string, string> = { block: "Block", duck: "Duck", "dodge.left": "Slip", "dodge.right": "Slip", "dodge.back": "Step back", jump: "Jump" };
function tagFor(f: Fighter): string | null {
  switch (f.stance) {
    case "stagger": return f.poise < 0.3 ? "Reeling" : "Staggered";
    case "falling": return null;
    case "down": return "Down!";
    case "rising": return "Getting up";
    case "ko": return "K.O.";
    case "defend": return DEFENSE_LABEL[f.defenseKind() ?? ""] ?? null;
    default: return f.poise < 0.3 ? "Dizzy" : null;
  }
}

// ---------------------------------------------------------------- the game's hooks (phones, round flow)
const P = (p: 1 | 2) => (p - 1) as Who;
const api = {
  arena, hud, director, fx, book,
  /** A player's spoken spell is being generated: the fighter glows and the screen shows their words. */
  channel(p: 1 | 2, words: string | null, type?: string) {
    const i = P(p);
    hud.channel(i, words);
    fx.channel(i, !!words, type);
    stage.chars[i]?.setGlow(words ? 1 : 0);
  },
  /** Plays a spell: spec (name, type, kind, power, hitJoint, hitFrame) and its Kimodo qpos rows. */
  cast: (p: 1 | 2, spec: MoveSpec, qpos: number[][], fps = 30, isNew = false) => cast(P(p), spec, qpos, fps, isNew),
  defend: (p: 1 | 2, kind: Defense) => arena.fighters[P(p)].defend(kind),
  punch: (p: 1 | 2, name: PunchName) => arena.fighters[P(p)].throwPunch(name),
  ai(p: 1 | 2, on: boolean) { aiOn[P(p)] = on; syncBrains(); },
  /** Freezes the fight (the camera keeps breathing): a freeze-frame, or a still to check. */
  pause(on: boolean) { paused = on; },
  newMatch,
};
Object.assign(globalThis, { __screen: api });

// keyboard: P1 Q W E R spells, A jab, S hook, D block, F slip, Z a "new" spell after channeling;
// P2 U I O P spells, J jab, K hook, L block, ; slip, M the same. 1/2 AI on/off, Enter new match,
// Space pause, H hide the HUD. Using a fighter's keys turns its AI off.
const KEYS: Record<string, [Who, string]> = {
  q: [0, "s0"], w: [0, "s1"], e: [0, "s2"], r: [0, "s3"], a: [0, "punch.leftJab"], s: [0, "punch.rightHook"], d: [0, "block"], f: [0, "dodge.left"], z: [0, "new"],
  u: [1, "s0"], i: [1, "s1"], o: [1, "s2"], p: [1, "s3"], j: [1, "punch.leftJab"], k: [1, "punch.rightHook"], l: [1, "block"], ";": [1, "dodge.right"], m: [1, "new"],
};
let paused = false;
addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
  const key = ev.key.toLowerCase();
  if (key === "1" || key === "2") { const i = Number(key) - 1; aiOn[i] = !aiOn[i]; syncBrains(); return; }
  if (key === "enter") return newMatch();
  if (key === " ") { paused = !paused; ev.preventDefault(); return; }
  if (key === "h") { const h = document.getElementById("hud")!; h.hidden = !h.hidden; return; }
  const k = KEYS[key];
  if (!k || phase !== "fight") return;
  const [i, what] = k;
  if (aiOn[i]) { aiOn[i] = false; syncBrains(); }
  const f = arena.fighters[i];
  if (what.startsWith("s")) { const s = book[Number(what.slice(1))]; if (s) cast(i, s.spec, s.qpos, s.fps); }
  else if (what.startsWith("punch.")) f.throwPunch(what as PunchName);
  else if (what === "new") {
    // what a phone does: the words show while the move generates, then it lands as a brand-new spell
    const base = book.find((s) => s.spec.kind === "strike") ?? book[0];
    if (!base) return;
    api.channel((i + 1) as 1 | 2, "summon the crab king", "lightning");
    setTimeout(() => { api.channel((i + 1) as 1 | 2, null); cast(i, { ...base.spec, name: "The Thunderous Crab King of the Sunken Deep", type: "lightning", power: 3 }, base.qpos, base.fps, true); }, 1600);
  } else f.defend(what as Defense);
});

// ?demo: one spell of each kind in turn (seconds into the round), to check them all on screen
const spell = (name: string) => book.find((b) => b.spec.name === name) ?? book[0];
const castNamed = (i: Who, name: string) => { const b = spell(name); if (b) cast(i, b.spec, b.qpos, b.fps); };
const DEMO: { at: number; done: boolean; run: () => void }[] = ([
  [0.8, () => castNamed(0, "Fireball")],
  [3.6, () => castNamed(1, "Thunder Call")],
  [6.6, () => api.channel(1, "summon the crab king", "lightning")],
  [8.2, () => { api.channel(1, null); const b = spell("Thunder Call"); if (b) cast(0, { ...b.spec, name: "The Thunderous Crab King of the Sunken Deep", power: 3 }, b.qpos, b.fps, true); }],
  [11.4, () => castNamed(1, "Spiral Sphere")],
  [14.4, () => castNamed(0, "Earth Wall")],
  [14.9, () => castNamed(1, "Fireball")],
  [18, () => arena.fighters[0].throwPunch("punch.rightHook")],
] as [number, () => void][]).map(([at, run]) => ({ at, run, done: false }));

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0, busy = false;
async function physics() {
  busy = true;
  try {
    let n = 0;
    while (acc >= 0.02 && n < 3) { await arena.tick(); acc -= 0.02; n++; }
    if (n === 3) acc = Math.min(acc, 0.02); // can't keep up: run slower instead of spiraling
  } catch (e) { console.error(e); } finally { busy = false; }
}

const downish = (f: Fighter) => f.stance === "falling" || f.stance === "down" || f.stance === "rising" || f.stance === "ko";
function frame(now: number) {
  requestAnimationFrame(frame);
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  const scale = paused ? 0 : timeScale(now);
  const dt = real * scale;
  acc += dt;
  if (!busy) void physics();
  flow(dt, paused ? 0 : real);
  const [a, b] = arena.fighters;
  const pa = world.rootPos(a.robot), pb = world.rootPos(b.robot);
  stage.sync(dt, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
  fx.update(dt);
  set.update(now / 1000, dt);
  director.update(real, { pelvis: [pa, pb], down: [downish(a), downish(b)], extras: arena.projectiles().map((p) => p.pos) });
  arena.fighters.forEach((f, i) => {
    hud.hp(i as Who, arena.hp[i], arena.maxHp);
    hud.poise(i as Who, f.poise);
    hud.status(i as Who, tagFor(f));
    const s = onScreen(f.body.headPos());
    hud.anchor(i as Who, s.x, s.y - innerHeight * 0.05);
  });
  hud.update(real);
  stage.render(real);
  if (++frames === Number(params.get("readyAfter") ?? 30)) document.documentElement.dataset.ready = "1"; // for mockups/capture.mjs
}
let frames = 0;
startRound();
requestAnimationFrame(frame);
