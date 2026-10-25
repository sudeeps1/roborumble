// Checks Vaibhav's Kimodo spells (public/clips-kimodo) in the physics, against the move rules (spells.ts):
// each one undefended, then against a dodge, a block and Earth Wall. Every caster must stay on its feet.
//   node scripts/spell-check.ts [--quiet]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArenaEvent } from "../src/core/events.ts";
import type { Defense, Fighter } from "../src/core/fighter.ts";
import { PlannerSource } from "../src/core/motion.ts";
import { type MoveSpec, specFromLibrary } from "../src/core/spells.ts";
import { nodeArena } from "./node-arena.ts";

const DIR = join(import.meta.dirname, "..", "public", "clips-kimodo");
const library = JSON.parse(readFileSync(join(DIR, "spells.json"), "utf8")) as { name: string; file: string }[];
const SPELLS = new Map<string, { spec: MoveSpec; qpos: number[][]; fps: number }>();
for (const e of library) {
  const clip = JSON.parse(readFileSync(join(DIR, e.file), "utf8"));
  SPELLS.set(e.name, { spec: specFromLibrary(e), qpos: clip.qpos, fps: clip.fps });
}

const quiet = process.argv.includes("--quiet");
const { world, planner, arena } = await nodeArena({ autoKO: false });
if (!planner) { console.log("no planner model: run npm run setup:planner first"); process.exit(1); }
arena.setMotion(new PlannerSource(planner));
arena.reset();
const [p1, p2] = arena.fighters;

let events: ArenaEvent[] = [];
arena.on((e) => {
  events.push(e);
  if (quiet || e.type === "stance" || e.type === "stagger" || e.type === "spawn") return;
  const { type, ...rest } = e as ArenaEvent & Record<string, unknown>;
  const detail = Object.entries(rest).filter(([k]) => k !== "point" && k !== "dir").map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : v}`).join(" ");
  console.log(`t=${arena.time.toFixed(2).padStart(6)} ${type.padEnd(9)} ${detail}`);
});

const failures: string[] = [];
const expect = (ok: boolean, what: string) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`); if (!ok) failures.push(what); };
const run = async (seconds: number, until?: () => boolean) => {
  for (let i = 0; i < seconds * 50; i++) { await arena.tick(); if (until?.()) return true; }
  return false;
};
const fresh = async () => {
  await run(10, () => p1.stance === "idle" && p2.stance === "idle");
  await run(0.6);
  arena.hp = [100, 100]; p1.poise = p2.poise = 1; events = [];
};
const cast = (f: Fighter, name: string) => { const s = SPELLS.get(name)!; return f.cast(s.spec, s.qpos, s.fps); };
const hits = () => events.filter((e): e is Extract<ArenaEvent, { type: "hit" }> => e.type === "hit" && e.attacker === 0);
const whiffs = () => events.filter((e): e is Extract<ArenaEvent, { type: "whiff" }> => e.type === "whiff" && e.attacker === 0);
const fell = (f: Fighter) => events.some((e) => (e.type === "fall" || e.type === "knockdown") && e.who === f.index);
/** Waits for P1's spell to finish (and anything it sent to land). */
const settle = async () => { await run(6, () => p1.stance !== "move" && arena.projectiles().length === 0); await run(1); };
/** P2 answers with `d` the moment P1's spell is released. */
const answerOnRelease = (d: Defense | "Earth Wall", seconds = 1.2) => arena.on((e) => {
  if (e.type !== "release" || e.who !== 0) return;
  if (d === "Earth Wall") cast(p2, "Earth Wall"); else p2.defend(d, seconds);
});

const t0 = performance.now();
console.log("--- every spell against an idle opponent");
for (const name of SPELLS.keys()) {
  await fresh();
  expect(cast(p1, name), `P1 casts ${name}`);
  await settle();
  const spec = SPELLS.get(name)!.spec;
  if (spec.kind === "defend") expect(hits().length === 0 && whiffs().length === 0, `${name}: defend move, nothing to hit`);
  else {
    const h = hits();
    expect(h.length === 1 && h[0].how === spec.kind, `${name}: lands as a ${spec.kind} (${h.map((x) => `${x.damage.toFixed(0)} dmg${x.clean ? " clean" : ""}${x.knockdown ? " knockdown" : ""}`).join(", ") || whiffs().map((w) => w.reason).join(", ") || "nothing"})`);
  }
  expect(!fell(p1), `${name}: the caster stays on its feet`);
}

console.log("--- Fireball against a slip, a block and Earth Wall");
for (const d of ["dodge.left", "block", "Earth Wall"] as const) {
  await fresh();
  const off = answerOnRelease(d === "Earth Wall" ? d : d);
  if (d === "Earth Wall") { cast(p2, "Earth Wall"); await run(1.0); } // the wall goes up first
  cast(p1, "Fireball");
  await settle();
  off();
  const h = hits(), w = whiffs();
  if (d === "dodge.left") expect(h.length === 0 && w.some((x) => x.reason === "dodged"), `fireball vs slip: dodged (${w.map((x) => x.reason).join(", ") || h.length + " hits"})`);
  else expect(h.length === 1 && h[0].blocked, `fireball vs ${d}: blocked (${h.map((x) => (x.blocked ? "blocked" : "clean through") + ` ${x.damage.toFixed(1)} dmg`).join(", ") || w.map((x) => x.reason).join(", ")})`);
}

console.log("--- Thunder Call against stepping out from under it");
{
  await fresh();
  const off = answerOnRelease("dodge.back", 1.4);
  cast(p1, "Thunder Call");
  await settle();
  off();
  expect(hits().length === 0 && whiffs().some((x) => x.reason === "dodged"), `thunder vs step back: dodged (${whiffs().map((x) => x.reason).join(", ") || hits().length + " hits"})`);
}

console.log("--- Spiral Sphere: steps in from range; against a block");
{
  await fresh();
  const d0 = p1.distanceTo(p2);
  cast(p1, "Spiral Sphere");
  await settle();
  const h = hits();
  expect(h.length === 1, `spiral sphere from ${d0.toFixed(2)} m: steps in and lands (${h.map((x) => `${x.damage.toFixed(0)} dmg${x.clean ? " clean" : ""}`).join(", ") || whiffs().map((w) => `${w.reason} ${w.closest.toFixed(2)}`).join(", ")})`);
  await fresh();
  cast(p1, "Spiral Sphere");
  await run(4, () => p1.punchPhase() === "throw"); // stepped in, the spell is starting
  p2.defend("block", 1.5);
  await settle();
  expect(hits().length === 1 && hits()[0].blocked, `spiral sphere vs block: blocked (${hits().map((x) => (x.blocked ? "blocked" : "clean through")).join(", ") || whiffs().map((w) => w.reason).join(", ")})`);
}

console.log("--- both cast at once");
{
  await fresh();
  cast(p1, "Fireball"); cast(p2, "Fireball");
  await settle(); await run(1);
  const both = events.filter((e) => e.type === "hit");
  expect(both.length === 2, `two fireballs cross: both land (${both.length})`);
}

for (const f of [p1, p2]) expect(f.stats.badTransitions === 0 && f.stats.errors === 0, `${f.name}: no bad transitions or errors`);
expect(arena.stats.errors === 0, "arena: no errors");
const ps = world.rootPos(p1.robot);
console.log(`\n${arena.time.toFixed(1)} s simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s wall (P1 at ${ps[0].toFixed(2)}, ${ps[1].toFixed(2)})`);
if (failures.length) { console.log(`FAILED: ${failures.length}\n  ${failures.join("\n  ")}`); process.exit(1); }
console.log("OK");
process.exit(0);
