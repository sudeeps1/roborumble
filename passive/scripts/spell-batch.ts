// Batch-checks a spell library on the robots, headless: for every spell, can the robot perform it
// without falling, and does it land on a standing opponent? With --runs N, runs 2..N add a small
// seeded shove during the move, and `stability` is the share of runs still upright 1 s after it.
//   node scripts/spell-batch.ts [spells.json] [--runs 3] [--out report.json]
// spells.json: entries like public/clips-kimodo/spells.json ({name, kind, type, effect, power,
// hit_joint, hit_frame, file}); `file` is a ClipData JSON ({fps, qpos}) next to it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArenaEvent } from "../src/core/events.ts";
import { tiltOf } from "../src/core/math.ts";
import { PlannerSource } from "../src/core/motion.ts";
import { specFromLibrary } from "../src/core/spells.ts";
import { nodeArena } from "./node-arena.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const libPath = args.find((a) => a.endsWith(".json") && args[args.indexOf(a) - 1] !== "--out") ?? join(import.meta.dirname, "..", "public", "clips-kimodo", "spells.json");
const RUNS = Math.max(1, Number(opt("--runs", "1")));
const OUT = opt("--out", "");
const library = JSON.parse(readFileSync(libPath, "utf8")) as Record<string, unknown>[];

const { world, planner, arena } = await nodeArena({ autoKO: false });
if (!planner) { console.log("no planner model: run npm run setup:planner first"); process.exit(1); }
const motion = new PlannerSource(planner);
const [p1, p2] = arena.fighters;
let events: ArenaEvent[] = [];
arena.on((e) => events.push(e));
const run = async (seconds: number, until?: () => boolean) => {
  for (let i = 0; i < seconds * 50; i++) { await arena.tick(); if (until?.()) return true; }
  return false;
};

interface Row { name: string; kind: string; ok: boolean; problem: string; standsUp: boolean; stability: number; maxTilt: number; lands: string; damage: number }
const rows: Row[] = [];
const t0 = performance.now();
for (const e of library) {
  const name = String(e.name ?? e.file);
  let qpos: number[][] = [], fps = 30;
  try { const c = JSON.parse(readFileSync(join(dirname(libPath), String(e.file)), "utf8")); qpos = c.qpos; fps = c.fps ?? 30; } catch { /* reported below */ }
  const spec = specFromLibrary(e as never);
  let upright = 0, maxTilt = 0, lands = "", damage = 0, problem = "";
  for (let r = 0; r < RUNS; r++) {
    arena.reset();
    p1.motion = motion; p2.motion = null; // the opponent stands still in its guard
    await run(0.6);
    events = [];
    if (!p1.cast(spec, qpos, fps)) { problem = "rejected (bad spec or clip)"; break; }
    // runs after the first: a small shove somewhere in the move, the same every time for a spell
    const shoveAt = r > 0 ? 0.3 + ((r * 0.37 + name.length * 0.11) % 1) * 1.4 : -1;
    const dir = r % 2 ? 1 : -1;
    let t = 0, tilt = 0;
    while (t < 8 && (p1.stance === "move" || arena.projectiles().length)) {
      if (shoveAt > 0 && Math.abs(t - shoveAt) < 0.01) arena.hitInstant(0, { name: "shove", body: "torso_link", offset: [0, 0, 0.2], force: 150, duration: 0.1, dir: dir > 0 ? "left" : "right" }, 1);
      await arena.tick(); t += 0.02;
      tilt = Math.max(tilt, tiltOf(world.rootQuat(p1.robot)));
    }
    await run(1); // still up 1 s later?
    const fell = events.some((x) => (x.type === "fall" || x.type === "knockdown") && x.who === 0) || !p1.standing();
    if (!fell) upright++;
    maxTilt = Math.max(maxTilt, tilt);
    if (r === 0) {
      const hit = events.find((x): x is Extract<ArenaEvent, { type: "hit" }> => x.type === "hit" && x.attacker === 0);
      const whiff = events.find((x): x is Extract<ArenaEvent, { type: "whiff" }> => x.type === "whiff" && x.attacker === 0);
      lands = spec.kind === "defend" ? "defend" : hit ? `hit${hit.clean ? " clean" : ""}${hit.knockdown ? " knockdown" : ""}` : whiff ? `miss (${whiff.reason})` : "nothing";
      damage = hit?.damage ?? 0;
    }
  }
  const standsUp = !problem && upright === RUNS;
  const ok = standsUp && (spec.kind === "defend" || lands.startsWith("hit"));
  if (!problem && !standsUp) problem = "tips its caster over";
  else if (!problem && !ok) problem = `doesn't land: ${lands}`;
  rows.push({ name, kind: spec.kind, ok, problem, standsUp, stability: problem.startsWith("rejected") ? 0 : upright / RUNS, maxTilt: maxTilt * 57.3, lands, damage });
  const r = rows[rows.length - 1];
  console.log(`${r.ok ? "ok  " : "BAD "} ${name.padEnd(22)} ${r.kind.padEnd(10)} stability ${r.stability.toFixed(2)}  max tilt ${r.maxTilt.toFixed(0).padStart(3)}°  ${r.lands}${r.damage ? ` ${r.damage.toFixed(0)} dmg` : ""}${r.problem ? `  <- ${r.problem}` : ""}`);
}
const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length} spells, ${rows.length - bad.length} ok, ${bad.length} need attention; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
process.exit(0);
