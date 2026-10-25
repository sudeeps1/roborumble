// Headless check of the between-moves layer: two fighters on SONIC + the planner.
// Footwork for 6 s, a haymaker on P2, then watch it fall and get back up.
//   node scripts/fight-check.ts [attackName] [scale]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-node";
import { ATTACKS } from "../src/core/attacks.ts";
import { Arena, Fighter } from "../src/core/fighter.ts";
import { tiltOf } from "../src/core/math.ts";
import { OnnxPlanner } from "../src/core/planner.ts";
import { SonicPolicy } from "../src/core/sonic.ts";
import { World } from "../src/core/world.ts";

const ROOT = join(import.meta.dirname, "..");
const PUB = join(ROOT, "public");
const attackName = process.argv[2] ?? "Haymaker";
const scale = Number(process.argv[3] ?? 1);

const mj = await loadMujoco();
const meshes = new Map<string, Uint8Array>();
for (const f of readdirSync(join(PUB, "g1", "meshes"))) meshes.set(f, readFileSync(join(PUB, "g1", "meshes", f)));
const world = new World(mj, { robotXml: readFileSync(join(PUB, "g1", "g1_29dof.xml"), "utf8"), meshes }, [
  { prefix: "p1_", x: -0.7, y: 0, yaw: 0 }, { prefix: "p2_", x: 0.7, y: 0, yaw: Math.PI },
]);
const policy = await SonicPolicy.load(ort as never, join(PUB, "sonic", "model_encoder.onnx"), join(PUB, "sonic", "model_decoder.onnx"));
const planner = await OnnxPlanner.load(ort as never, join(ROOT, "models", "planner_sonic.onnx"));
const a = new Fighter("P1", world, world.robots[0], policy, 7);
const b = new Fighter("P2", world, world.robots[1], policy, 99);
a.planner = b.planner = planner;
const arena = new Arena(world, [a, b]);
a.spawn(-0.7, 0, 0); b.spawn(0.7, 0, Math.PI);

const attack = ATTACKS.find((x) => x.name === attackName)!;
let last = "";
const t0 = performance.now();
for (let tick = 0; tick < 50 * 22; tick++) {
  if (tick === 50 * 6) {
    const { point } = b.hit(attack, world.rootPos(a.robot), scale);
    console.log(`t=${arena.simTime.toFixed(2)} ${attack.name} x${scale} on P2 at`, point.map((v) => v.toFixed(2)).join(","));
  }
  await arena.tick();
  for (const f of [a, b]) {
    const p = world.rootPos(f.robot), tilt = (tiltOf(world.rootQuat(f.robot)) * 180) / Math.PI;
    const key = `${f.name}:${f.stance}:${f.intent}`;
    if (key !== last && (f === b || tick % 50 === 0)) {
      console.log(`t=${arena.simTime.toFixed(2)} ${f.name} ${f.stance.padEnd(8)} z=${p[2].toFixed(2)} tilt=${tilt.toFixed(0)} xy=(${p[0].toFixed(2)},${p[1].toFixed(2)}) ${f.intent} ${f.lastEvent}`);
      last = key;
    }
  }
}
console.log(`22 s simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s wall`);
