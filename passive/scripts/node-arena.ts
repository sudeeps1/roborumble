// Shared setup for the headless scripts: the two-robot world, SONIC and the planner, in Node.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-node";
import { Arena, type ArenaOptions } from "../src/core/arena.ts";
import { OnnxPlanner } from "../src/core/planner.ts";
import { SonicPolicy } from "../src/core/sonic.ts";
import { World } from "../src/core/world.ts";

const ROOT = join(import.meta.dirname, "..");
const PUB = join(ROOT, "public");

export async function nodeArena(opts: ArenaOptions = {}) {
  const mj = await loadMujoco();
  const meshes = new Map<string, Uint8Array>();
  for (const f of readdirSync(join(PUB, "g1", "meshes"))) meshes.set(f, readFileSync(join(PUB, "g1", "meshes", f)));
  const world = new World(mj, { robotXml: readFileSync(join(PUB, "g1", "g1_29dof.xml"), "utf8"), meshes }, [
    { prefix: "p1_", x: -0.7, y: 0, yaw: 0 }, { prefix: "p2_", x: 0.7, y: 0, yaw: Math.PI },
  ]);
  // ORT_THREADS=n caps each ONNX session's threads (several sims sharing a box: 1-2 each); unset: ONNX's defaults
  const threads = Math.max(0, Math.round(Number(process.env.ORT_THREADS) || 0));
  const policy = await SonicPolicy.load(ort as never, join(PUB, "sonic", "model_encoder.onnx"), join(PUB, "sonic", "model_decoder.onnx"), threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {});
  const plannerPath = join(ROOT, "models", "planner_sonic.onnx");
  const planner = existsSync(plannerPath) ? await (threads ? OnnxPlanner.load(ort as never, plannerPath, threads) : OnnxPlanner.load(ort as never, plannerPath)) : null;
  const arena = new Arena(world, policy, opts);
  return { mj, world, policy, planner, arena };
}
