// NVIDIA GEAR-SONIC whole-body controller for one G1.
// Observation layout follows gear_sonic_deploy (Apache-2.0) with the release observation_config.yaml:
//   encoder (1762, "g1" mode): mode id, 10 future joint positions + velocities 0.1 s apart,
//     10 future anchor orientations; everything else zero.
//   decoder (994): 64-d token + the last 10 ticks of pelvis angular velocity, joint positions
//     (minus the default pose), joint velocities, raw actions, and gravity in the pelvis frame.
// Runs at 50 Hz. PD torques are recomputed every 5 ms physics step.
import { ACTION_SCALE, DEFAULT_ANGLES, IL_OF_MJ, KD, KP, MJ_OF_IL, NJ, TORQUE_LIMIT } from "./g1.ts";
import { qconj, qmul, qrot, rot6d, yawOf, yawQuat } from "./math.ts";
import { REF_HZ, type Reference } from "./reference.ts";
import type { RobotHandle, World } from "./world.ts";

export const CONTROL_HZ = 50;
export const SUBSTEPS = 4; // 4 x 5 ms physics steps per 20 ms tick

const HIST = 10;
const ENC_DIM = 1762;
const DEC_DIM = 994;
const FUTURE = 10;
const FUTURE_STEP = 5; // ticks between future frames (0.1 s)

/** The parts of onnxruntime-web / onnxruntime-node we use (same API in both). */
export interface OrtLike {
  InferenceSession: { create(model: string | Uint8Array, options?: object): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

/** The two SONIC networks, shared by every robot. Calls are serialized (one session run at a time). */
export class SonicPolicy {
  private queue: Promise<unknown> = Promise.resolve();
  private ort: OrtLike;
  private encoder: OrtSession;
  private decoder: OrtSession;

  private constructor(ort: OrtLike, encoder: OrtSession, decoder: OrtSession) {
    this.ort = ort;
    this.encoder = encoder;
    this.decoder = decoder;
  }

  static async load(ort: OrtLike, encoder: string | Uint8Array, decoder: string | Uint8Array, options: object = {}) {
    const [e, d] = await Promise.all([ort.InferenceSession.create(encoder, options), ort.InferenceSession.create(decoder, options)]);
    return new SonicPolicy(ort, e, d);
  }

  private run(s: OrtSession, obs: Float32Array): Promise<Float32Array> {
    const job = this.queue.then(async () => {
      const out = await s.run({ [s.inputNames[0]]: new this.ort.Tensor("float32", obs, [1, obs.length]) });
      return out[s.outputNames[0]].data as Float32Array;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  encode(obs: Float32Array) { return this.run(this.encoder, obs); }
  decode(obs: Float32Array) { return this.run(this.decoder, obs); }
}

export class SonicController {
  /** Joint targets for the PD loop (MuJoCo order). */
  readonly target = new Float64Array(NJ);
  /** 1 = SONIC's gains; lower makes the robot soft (falling, KO). */
  stiffness = 1;
  /** When false the PD loop goes limp-damped and the networks are skipped. */
  active = true;
  /** When set, SONIC is skipped and the PD loop holds this pose (MuJoCo order) at `stiffness`. */
  hold: ArrayLike<number> | null = null;
  /** Yaw correction applied to the reference (identity: reference is in world frame). */
  headingFix: number[] = [1, 0, 0, 0];

  private hAng = new Float32Array(HIST * 3);
  private hQ = new Float32Array(HIST * NJ);
  private hDq = new Float32Array(HIST * NJ);
  private hAct = new Float32Array(HIST * NJ);
  private hGrav = new Float32Array(HIST * 3);
  private lastAction = new Float32Array(NJ); // IsaacLab order
  private enc = new Float32Array(ENC_DIM);
  private dec = new Float32Array(DEC_DIM);
  private tq = [1, 0, 0, 0];
  private tmp = [0, 0, 0, 0];
  private tmp2 = [0, 0, 0, 0];
  private g = [0, 0, 0];
  private world: World;
  private policy: SonicPolicy;
  readonly robot: RobotHandle;

  constructor(world: World, robot: RobotHandle, policy: SonicPolicy) {
    this.world = world;
    this.robot = robot;
    this.policy = policy;
    for (let j = 0; j < NJ; j++) this.target[j] = DEFAULT_ANGLES[j];
  }

  /** Clears history to the current state. Call after teleporting the robot or switching control on. */
  reset() {
    this.lastAction.fill(0);
    for (let k = 0; k < HIST; k++) this.pushState();
    const q = this.world.data.qpos;
    for (let j = 0; j < NJ; j++) this.target[j] = q[this.robot.qpos[j]];
  }

  /** Rotates the reference about Z so its heading at `frame` matches the robot's current heading. */
  alignHeading(ref: Reference) {
    const f = ref.current();
    const robotYaw = yawOf(this.world.rootQuat(this.robot, this.tq));
    const refYaw = yawOf([f[3], f[4], f[5], f[6]]);
    this.headingFix = yawQuat(robotYaw - refYaw);
  }

  /** Reference stays in world coordinates (planner output is already placed in the world). */
  worldHeading() {
    this.headingFix = [1, 0, 0, 0];
  }

  private pushState() {
    const d = this.world.data, r = this.robot;
    const q = d.qpos, v = d.qvel;
    this.hAng.copyWithin(0, 3); this.hGrav.copyWithin(0, 3);
    this.hQ.copyWithin(0, NJ); this.hDq.copyWithin(0, NJ); this.hAct.copyWithin(0, NJ);
    const o3 = (HIST - 1) * 3, oj = (HIST - 1) * NJ;
    // free-joint angular velocity is already in the pelvis frame (like the IMU gyro)
    this.hAng[o3] = v[r.qvelRoot + 3]; this.hAng[o3 + 1] = v[r.qvelRoot + 4]; this.hAng[o3 + 2] = v[r.qvelRoot + 5];
    const quat = this.world.rootQuat(r, this.tq);
    qrot(qconj(quat, this.tmp), [0, 0, -1], this.g);
    this.hGrav[o3] = this.g[0]; this.hGrav[o3 + 1] = this.g[1]; this.hGrav[o3 + 2] = this.g[2];
    for (let il = 0; il < NJ; il++) {
      const mj = MJ_OF_IL[il];
      this.hQ[oj + il] = q[r.qpos[mj]] - DEFAULT_ANGLES[mj];
      this.hDq[oj + il] = v[r.qvel[mj]];
      this.hAct[oj + il] = this.lastAction[il];
    }
  }

  private buildEncoder(ref: Reference) {
    const e = this.enc;
    e.fill(0); // mode id 0 ("g1") and every observation g1 mode doesn't use
    const base = this.world.rootQuat(this.robot, this.tq);
    const baseInv = qconj(base, this.tmp2);
    for (let k = 0; k < FUTURE; k++) {
      const fi = ref.cursor + k * FUTURE_STEP * (REF_HZ / CONTROL_HZ);
      const f = ref.frame(fi);
      for (let il = 0; il < NJ; il++) {
        const mj = MJ_OF_IL[il];
        e[4 + k * NJ + il] = f[7 + mj];
        e[294 + k * NJ + il] = ref.jointVel(fi, mj);
      }
      const refRoot = qmul(this.headingFix, [f[3], f[4], f[5], f[6]], this.tmp);
      rot6d(qmul(baseInv, refRoot, [0, 0, 0, 0]), e, 601 + k * 6);
    }
  }

  private buildDecoder(token: Float32Array) {
    const d = this.dec;
    d.set(token, 0);
    d.set(this.hAng, 64);
    d.set(this.hQ, 94);
    d.set(this.hDq, 384);
    d.set(this.hAct, 674);
    d.set(this.hGrav, 964);
  }

  /** One 50 Hz control tick: observe, run SONIC, update the PD targets. */
  async tick(ref: Reference) {
    this.pushState();
    if (!this.active || this.hold) return;
    this.buildEncoder(ref);
    const token = await this.policy.encode(this.enc);
    this.buildDecoder(token);
    const action = await this.policy.decode(this.dec);
    for (let il = 0; il < NJ; il++) this.lastAction[il] = action[il];
    for (let mj = 0; mj < NJ; mj++) {
      this.target[mj] = DEFAULT_ANGLES[mj] + action[IL_OF_MJ[mj]] * ACTION_SCALE[mj];
    }
  }

  /** PD torques for this physics step. Inactive: joints go limp with light damping. */
  pd() {
    const d = this.world.data, r = this.robot;
    const q = d.qpos, v = d.qvel, ctrl = d.ctrl;
    const goal = this.hold ?? this.target;
    for (let j = 0; j < NJ; j++) {
      let tau: number;
      if (this.active) {
        tau = this.stiffness * KP[j] * (goal[j] - q[r.qpos[j]]) - KD[j] * v[r.qvel[j]];
      } else {
        tau = -0.5 * KD[j] * v[r.qvel[j]];
      }
      const lim = TORQUE_LIMIT[j];
      ctrl[r.actuator[j]] = tau > lim ? lim : tau < -lim ? -lim : tau;
    }
  }
}
