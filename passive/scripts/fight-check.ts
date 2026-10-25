// Headless walk-through of the interaction layer, with checks: two fighters on SONIC + the planner.
//   node scripts/fight-check.ts [--quiet]
// Footwork; each punch thrown by P1 at an idle P2; punches into a block, a slip and a duck; the same
// in rules mode; a haymaker knockdown with the fall and the get-up (and the grace after it); a KO.
// Exits 1 if an expectation fails.
import { ATTACKS } from "../src/core/attacks.ts";
import type { ArenaEvent } from "../src/core/events.ts";
import { type Defense, PUNCHES, TUNE } from "../src/core/fighter.ts";
import { tiltOf } from "../src/core/math.ts";
import { PlannerSource } from "../src/core/motion.ts";
import { nodeArena } from "./node-arena.ts";

const quiet = process.argv.includes("--quiet");
const { world, planner, arena } = await nodeArena({ autoKO: false });
if (!planner) { console.log("no planner model: run npm run setup:planner first"); process.exit(1); }
arena.setMotion(new PlannerSource(planner));
arena.reset();
const [p1, p2] = arena.fighters;

let events: ArenaEvent[] = [];
arena.on((e) => {
  events.push(e);
  if (quiet || e.type === "stance" || e.type === "stagger") return;
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
const idleBoth = () => run(10, () => p1.stance === "idle" && p2.stance === "idle");
const fresh = async () => { await idleBoth(); await run(0.5); arena.hp = [100, 100]; p1.poise = p2.poise = 1; events = []; };
const hitsOnP2 = () => events.filter((e): e is Extract<ArenaEvent, { type: "hit" }> => e.type === "hit" && e.defender === 1 && e.attacker === 0);
const show = (label: string) => {
  for (const f of [p1, p2]) {
    const p = world.rootPos(f.robot), tilt = (tiltOf(world.rootQuat(f.robot)) * 180) / Math.PI;
    console.log(`   ${label}: ${f.name} ${f.stance} xy=(${p[0].toFixed(2)},${p[1].toFixed(2)}) z=${p[2].toFixed(2)} tilt=${tilt.toFixed(0)} ${f.intent}`);
  }
};

const t0 = performance.now();
console.log("--- footwork");
await run(5);
show("after 5 s");
expect(p1.stance === "idle" && p2.stance === "idle", "both box in place for 5 s");
expect(p1.distanceTo(p2) > 0.8 && p1.distanceTo(p2) < 2.4, `they keep range (${p1.distanceTo(p2).toFixed(2)} m)`);

console.log("--- undefended punches (contact mode)");
let landed = 0;
for (let k = 0; k < 2; k++) for (const p of PUNCHES) {
  await fresh();
  expect(p1.throwPunch(p), `P1 starts ${p}`);
  await run(5, () => p1.stance !== "move");
  landed += hitsOnP2().length ? 1 : 0;
}
expect(landed >= 5, `at least 5 of 8 undefended punches land (${landed})`);

for (const mode of ["contact", "rules"] as const) {
  arena.combat.mode = mode;
  for (const d of ["block", "dodge.left", "dodge.back"] as Defense[]) {
    console.log(`--- ${mode} mode: P1 right hook, P2 answers with ${d}`);
    await fresh();
    p1.throwPunch("punch.rightHook");
    await run(4, () => p1.punchPhase() === "throw");
    expect(p2.defend(d, 0.9), `P2 ${d}`); // as the punch starts, held long enough to cover it
    await run(4, () => p1.stance !== "move");
    const clean = hitsOnP2().filter((h) => !h.blocked);
    if (d === "block") expect(clean.length === 0, `${mode}: nothing gets through the block`);
    else expect(hitsOnP2().length === 0, `${mode}: the ${d} beats the hook`);
  }
}
arena.combat.mode = "contact";

console.log("--- rules mode: both throw the same straight at once, from inside a mid-tick event");
{
  // a right straight: arm comes up and out, 0.8 s at 30 fps, key at frame 12
  const rows: number[][] = [];
  for (let k = 0; k <= 24; k++) {
    const u = Math.sin(Math.min(1, k / 12) * Math.PI / 2) * (k <= 12 ? 1 : Math.max(0, 1 - (k - 12) / 12));
    const q = [-0.312, 0, 0, 0.669, -0.363, 0, -0.312, 0, 0, 0.669, -0.363, 0, 0, 0, 0, 0.2, 0.2, 0, 0.6, 0, 0, 0, 0.2 - 1.6 * u, -0.2, 0, 0.6 - 0.7 * u, 0, 0, 0];
    rows.push([0, 0, 0.793, 1, 0, 0, 0, ...q]);
  }
  arena.combat.mode = "rules";
  arena.setMotion(null); // no footwork: they stand where they're put
  for (const [power, light] of [[1, false], [0.4, true]] as const) {
    const strike = [{ limb: "r_hand" as const, from: 0.25, to: 0.55, power, name: "straight", key: 0.4 }];
    await fresh();
    p1.spawn(-0.33, 0, 0); p2.spawn(0.33, 0, Math.PI);
    await run(0.6);
    const before = events.length;
    // P2's block ends inside its own tick, after P1 has already ticked: both moves start from there
    let started = false, stagger = 0;
    const off = arena.on((e) => {
      if (e.type === "stagger") stagger++;
      if (started || e.type !== "stance" || e.who !== 1 || e.from !== "defend") return;
      started = true;
      p1.playMove(rows, 30, strike, "straight");
      p2.playMove(rows, 30, strike, "straight");
    });
    p2.defend("block", 0.2);
    await run(2, () => started && p1.stance !== "move" && p2.stance !== "move");
    off();
    const got = events.slice(before).filter((e): e is Extract<ArenaEvent, { type: "hit" }> => e.type === "hit");
    const interrupted = events.slice(before).filter((e) => e.type === "whiff" && e.reason === "interrupted");
    expect(started && got.length === 2 && interrupted.length === 0, `power ${power}: both straights land, neither is cancelled (${got.length} hits, ${interrupted.length} interrupted)`);
    if (light) expect(stagger === 0, `light straights trade: nobody staggers (${stagger})`);
  }
  arena.setMotion(new PlannerSource(planner));
  arena.combat.mode = "contact";
}

console.log("--- haymaker on P2: fall, down, get-up, grace");
await fresh();
arena.hitInstant(1, ATTACKS.find((a) => a.name === "Haymaker")!, 1);
expect(p2.stance === "falling", "a haymaker knocks P2 down");
const down = await run(4, () => p2.stance === "down");
expect(down, "P2 lands and settles");
const up = await run(TUNE.downBeat + 20, () => p2.stance === "idle");
show(up ? "back up" : "NOT up");
expect(up, "P2 gets back up");
const r = arena.hitInstant(1, ATTACKS[0], 1);
expect(!r.result.landed, "P2 can't be hit right after getting up (grace)");
await run(TUNE.grace + 0.1);
const r2 = arena.hitInstant(1, ATTACKS[0], 0.5);
expect(r2.result.landed, "after the grace it can be hit again");

console.log("--- KO");
await run(1);
p2.knockOut();
await run(3);
show("after KO");
expect(p2.stance === "ko" && world.rootPos(p2.robot)[2] < 0.45, "a KO stays down");
expect(!p1.throwPunch("punch.leftJab"), "nobody punches a KO'd fighter");

for (const f of [p1, p2]) expect(f.stats.badTransitions === 0 && f.stats.errors === 0, `${f.name}: no bad transitions or errors`);
expect(arena.stats.errors === 0, "arena: no errors");
console.log(`\n${arena.time.toFixed(1)} s simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s wall`);
if (failures.length) { console.log(`FAILED: ${failures.length}\n  ${failures.join("\n  ")}`); process.exit(1); }
console.log("OK");
process.exit(0);
