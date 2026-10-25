// Headless check of the physics core in Node: one G1 on SONIC holding a standing reference,
// shoved at t = 4 s and t = 7 s. Prints pelvis height and tilt so you can see it stay up.
//   node scripts/headless.ts [pushNewtons]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-node";
import { DEFAULT_ANGLES } from "../src/core/g1.ts";
import { tiltOf } from "../src/core/math.ts";
import { Reference } from "../src/core/reference.ts";
import { SUBSTEPS, SonicController, SonicPolicy } from "../src/core/sonic.ts";
import { World } from "../src/core/world.ts";

const PUB = join(import.meta.dirname, "..", "public");
const push = Number(process.argv[2] ?? 120);

const mj = await loadMujoco();
const meshes = new Map<string, Uint8Array>();
for (const f of readdirSync(join(PUB, "g1", "meshes"))) meshes.set(f, readFileSync(join(PUB, "g1", "meshes", f)));
const world = new World(mj, { robotXml: readFileSync(join(PUB, "g1", "g1_29dof.xml"), "utf8"), meshes }, [{ prefix: "p1_", x: 0, y: 0, yaw: 0 }]);
const robot = world.robots[0];
const policy = await SonicPolicy.load(ort as never, join(PUB, "sonic", "model_encoder.onnx"), join(PUB, "sonic", "model_decoder.onnx"));
const ctl = new SonicController(world, robot, policy);

const stand = world.placeStanding(robot, 0, 0, 0, DEFAULT_ANGLES);
const ref = new Reference(stand);
ctl.reset();
ctl.alignHeading(ref);

const torso = robot.bodies.get("torso_link")!;
let t = 0;
const t0 = performance.now();
for (let tick = 0; tick < 50 * 10; tick++) {
  await ctl.tick(ref);
  for (let s = 0; s < SUBSTEPS; s++) {
    world.clearForces();
    const pushing = (t >= 4 && t < 4.1) || (t >= 7 && t < 7.1);
    if (pushing) {
      const dir = t < 5 ? [push, 0, 0] : [0, push, 0];
      world.applyForce(torso, dir, world.bodyPos(torso));
    }
    ctl.pd();
    world.step();
    t += world.dt;
  }
  ref.advance();
  if (tick % 25 === 0) {
    const p = world.rootPos(robot), q = world.rootQuat(robot);
    console.log(`t=${t.toFixed(2)}s pelvis z=${p[2].toFixed(3)} xy=(${p[0].toFixed(2)}, ${p[1].toFixed(2)}) tilt=${((tiltOf(q) * 180) / Math.PI).toFixed(1)}deg`);
  }
}
console.log(`10 s simulated in ${((performance.now() - t0) / 1000).toFixed(2)} s wall`);
