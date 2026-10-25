// SONIC kinematic planner: turns "box in place", "step left while facing him", "get up from
// here" into whole-body G1 motion (30 Hz qpos). Interface per GR00T-WholeBodyControl
// docs/source/references/planner_onnx.md. The 774 MB model runs in planner/server.ts (Node);
// the browser talks to it over HTTP.
import { type Frame, REF_HZ, type Reference, resample } from "./reference.ts";

export const PLAN_HZ = 30;
export const LOOK_AHEAD = 2; // reference frames between "now" and the plan's first frame

export const Mode = {
  idle: 0, slowWalk: 1, walk: 2, run: 3, squat: 4, kneelTwoLeg: 5, kneelOneLeg: 6, lyingFacedown: 7,
  handCrawling: 8, idleBoxing: 9, walkBoxing: 10, leftJab: 11, rightJab: 12, randomPunches: 13,
  elbowCrawling: 14, leftHook: 15, rightHook: 16,
} as const;

export interface PlanRequest {
  context: number[];   // 4 frames x 36 at 30 Hz, world frame
  mode: number;
  movement: number[];  // world xy(z) direction, zero = stay
  facing: number[];    // world direction the torso should face
  speed?: number;      // m/s, <= 0 uses the mode's default
  height?: number;     // pelvis height for squat/kneel/lying, < 0 disables
  seed?: number;
}

export interface PlanBackend {
  plan(req: PlanRequest): Promise<Float32Array>; // n x 36 at 30 Hz
}

/** Runs the planner ONNX in-process (Node: onnxruntime-node). */
export class OnnxPlanner implements PlanBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: any; private session: any;
  private busy: Promise<unknown> = Promise.resolve();

  private constructor(ort: unknown, session: unknown) { this.ort = ort; this.session = session; }

  static async load(ort: { InferenceSession: { create(p: string, o?: object): Promise<unknown> } }, modelPath: string, threads = 8) {
    return new OnnxPlanner(ort, await ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads }));
  }

  plan(req: PlanRequest): Promise<Float32Array> {
    const job = this.busy.then(() => this.run(req));
    this.busy = job.catch(() => undefined);
    return job;
  }

  private async run(req: PlanRequest): Promise<Float32Array> {
    const T = (type: string, data: unknown, dims: number[]) => new this.ort.Tensor(type, data, dims);
    const i64 = (v: number[]) => BigInt64Array.from(v.map((x) => BigInt(Math.round(x))));
    const out = await this.session.run({
      context_mujoco_qpos: T("float32", Float32Array.from(req.context), [1, 4, 36]),
      target_vel: T("float32", new Float32Array([req.speed ?? -1]), [1]),
      mode: T("int64", i64([req.mode]), [1]),
      movement_direction: T("float32", Float32Array.from(req.movement.slice(0, 3).concat([0, 0, 0]).slice(0, 3)), [1, 3]),
      facing_direction: T("float32", Float32Array.from(req.facing.slice(0, 3).concat([0, 0, 0]).slice(0, 3)), [1, 3]),
      height: T("float32", new Float32Array([req.height ?? -1]), [1]),
      random_seed: T("int64", i64([req.seed ?? 1234]), [1]),
      has_specific_target: T("int64", i64([0]), [1, 1]),
      specific_target_positions: T("float32", new Float32Array(12), [1, 4, 3]),
      specific_target_headings: T("float32", new Float32Array(4), [1, 4]),
      allowed_pred_num_tokens: T("int64", i64(Array(11).fill(1)), [1, 11]),
    });
    const n = Number(out.num_pred_frames.data[0]);
    return (out.mujoco_qpos.data as Float32Array).slice(0, n * 36);
  }
}

/** Calls planner/server.ts (through the Vite proxy at /planner). */
export class HttpPlanner implements PlanBackend {
  private base: string;
  constructor(base = "/planner") { this.base = base; }

  async plan(req: PlanRequest): Promise<Float32Array> {
    // a stuck planner must not stall a fighter: give up after 2.5 s and let the caller fall back
    const res = await fetch(`${this.base}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`planner ${res.status}`);
    return Float32Array.from((await res.json()).frames as number[]);
  }

  async alive(): Promise<boolean> {
    try { return (await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  }
}

/**
 * The planner's context: 4 frames at 30 Hz starting LOOK_AHEAD frames after "now".
 * genFrame is the absolute reference frame the plan's first frame belongs at.
 */
export function contextFromReference(ref: Reference): { context: number[]; genFrame: number } {
  const genFrame = ref.now + LOOK_AHEAD;
  const context: number[] = [];
  for (let n = 0; n < 4; n++) {
    const s = genFrame + (n * REF_HZ) / PLAN_HZ;
    const i0 = Math.floor(s), u = s - i0;
    const a = ref.at(i0), b = ref.at(i0 + 1);
    for (let i = 0; i < 36; i++) context.push(a[i] + (b[i] - a[i]) * u);
  }
  return { context, genFrame };
}

/** 30 Hz planner output -> 50 Hz reference frames. */
export function planFrames(flat: Float32Array): Frame[] {
  const frames: Frame[] = [];
  for (let k = 0; k + 36 <= flat.length; k += 36) frames.push(Float64Array.from(flat.subarray(k, k + 36)));
  return resample(frames, PLAN_HZ, REF_HZ);
}

/** Splices a plan made from contextFromReference() into the reference, as SONIC's deploy stack does. */
export function applyPlan(ref: Reference, flat: Float32Array, genFrame: number, transform?: (f: Frame[]) => Frame[]) {
  let frames = planFrames(flat);
  if (transform) frames = transform(frames);
  ref.splice(frames, genFrame, 8);
}
