// Procedural test motions for the viewer, as G1 joint-angle curves (no physics).
// Output is the G1 pose in the FIGHTER frame (origin on the floor under the fighter, facing +X);
// the viewer moves it into the arena. Planted feet are solved with a small leg IK so they stay put.
//
// G1 sign conventions (checked against g1_kinematics.json):
//   elbow 0 = forearm horizontal forward (upper arm hanging), +1.57 = straight down, negative = deeper bend
//   shoulder pitch negative = arm raised forward; left shoulder roll + = arm out (right: -)
//   left shoulder yaw - = fist toward the centerline (right: +); knee + bends; hip pitch - = thigh forward
//   waist pitch + = lean forward; yaw + = turn left (counter-clockwise from above)
import { JOINTS, JOINT_INDEX, G1FK, LEG_JOINTS, solveLegIK, qeuler, qmul, qconj, qrot, qaxis, STAND_HEIGHT, type Quat, type Vec3, type Side } from "./fk.ts";

// ---------------------------------------------------------------- channels
const ROOT_CH = ["px", "py", "pz", "yaw", "pitch", "roll"];
const FOOT_CH = ["lfx", "lfy", "lfz", "lfyaw", "rfx", "rfy", "rfz", "rfyaw", "lik", "rik"];
const JOINT_CH = JOINTS.map((j) => j.replace(/_joint$/, ""));
export const CHANNELS = [...ROOT_CH, ...FOOT_CH, ...JOINT_CH];
const NCH = CHANNELS.length;
const CH: Record<string, number> = Object.fromEntries(CHANNELS.map((c, i) => [c, i]));
const J0 = ROOT_CH.length + FOOT_CH.length; // first joint channel

type Key = { t: number } & Record<string, number>;
export interface MotionDef {
  name: string;
  label: string;
  duration: number;
  loop?: boolean;
  /** Time (s) the strike lands, or the hit is taken. */
  impact?: number;
  keys: Key[];
  /** Fixed channel values for the whole motion (overrides guard and keys). */
  fixed?: Record<string, number>;
}

/** Bind angles of the asset (filled from the GLB's g1_rig.bind_angles by the viewer; defaults = blender/g1.py BIND). */
export const BIND_ANGLES: Record<string, number> = {
  left_shoulder_roll_joint: 0.3, right_shoulder_roll_joint: -0.3,
  left_elbow_joint: 0.85, right_elbow_joint: 0.85,
};

// Ankle-roll body height when standing flat (straight legs, pelvis at 0.793).
const ANKLE_Z = (() => {
  const b = new G1FK().compute(new Float64Array(29));
  return b.find((x) => x.name === "left_ankle_roll_link")!.pos[2];
})();

// ---------------------------------------------------------------- guard (boxing idle with bounce)
const BOUNCE_HZ = 1.7;

/** Fills `out` with the guard pose at clock time t. legQ = last IK leg solution (keeps leg blends seamless). */
function guard(t: number, out: Float64Array, legQ: Record<Side, number[]>) {
  const w = 2 * Math.PI * BOUNCE_HZ * t;
  const b = Math.sin(w), b2 = Math.sin(w + 0.9);
  const set = (c: string, v: number) => { out[CH[c]] = v; };
  set("px", -0.02 + 0.006 * Math.sin(w * 0.5)); set("py", 0.004 * Math.sin(w * 0.5 + 1)); set("pz", 0.712 + 0.011 * b);
  set("yaw", -0.38 + 0.02 * Math.sin(w * 0.5)); set("pitch", 0.05); set("roll", 0);
  set("lfx", 0.13); set("lfy", 0.105); set("lfz", 0); set("lfyaw", -0.28);
  set("rfx", -0.15); set("rfy", -0.14); set("rfz", 0); set("rfyaw", -0.55);
  set("lik", 1); set("rik", 1);
  for (let k = J0; k < NCH; k++) out[k] = 0;
  set("waist_yaw", 0.24 + 0.02 * b2); set("waist_roll", 0); set("waist_pitch", 0.12 + 0.015 * b);
  // lead (left) hand higher and further out, rear (right) hand at the chin
  set("left_shoulder_pitch", -0.95 + 0.04 * b2); set("left_shoulder_roll", 0.16); set("left_shoulder_yaw", -0.1); set("left_elbow", -0.32 - 0.04 * b2);
  set("right_shoulder_pitch", -0.72 + 0.035 * b); set("right_shoulder_roll", -0.16); set("right_shoulder_yaw", 0.18); set("right_elbow", -0.55 - 0.03 * b);
  set("left_wrist_roll", -0.25); set("right_wrist_roll", 0.25);
  set("left_wrist_pitch", 0.1); set("right_wrist_pitch", 0.1);
  for (const side of ["left", "right"] as Side[]) LEG_JOINTS[side].forEach((j, k) => { out[J0 + j] = legQ[side][k]; });
}

// ---------------------------------------------------------------- motions
const hold = (t: number, k: Omit<Key, "t">): Key => ({ ...k, t }) as Key;

const JAB_OUT = {
  left_shoulder_pitch: -1.62, left_shoulder_roll: 0.1, left_shoulder_yaw: -0.2, left_elbow: 1.4, left_wrist_roll: -0.9,
  waist_yaw: -0.02, yaw: -0.45, px: 0.03, pz: 0.705,
};
const CROSS_OUT = {
  right_shoulder_pitch: -1.62, right_shoulder_roll: -0.05, right_shoulder_yaw: 0.3, right_elbow: 1.42, right_wrist_roll: 0.9,
  left_shoulder_pitch: -0.95, left_elbow: -0.8,
  waist_yaw: 0.45, yaw: 0.02, px: 0.05, pz: 0.7, rfyaw: -0.15,
};
const KICK_OUT = {
  rik: 0, right_hip_pitch: -1.5, right_hip_roll: 0, right_hip_yaw: 0, right_knee: 0.12, right_ankle_pitch: -0.45,
  waist_pitch: -0.2, pitch: -0.1, pz: 0.765, px: 0.0, py: 0.06, yaw: 0.0,
  left_shoulder_pitch: -0.9, right_shoulder_pitch: -0.7, right_elbow: -0.6,
};

export const MOTIONS: Record<string, MotionDef> = {
  guard: { name: "guard", label: "Guard idle", duration: 1 / BOUNCE_HZ, loop: true, keys: [] },
  jab: {
    name: "jab", label: "Jab (lead)", duration: 0.55, impact: 0.15,
    keys: [
      { t: 0.06, left_shoulder_pitch: -1.15, left_elbow: -0.4, waist_yaw: 0.16 },
      hold(0.15, JAB_OUT),
      hold(0.21, JAB_OUT),
      { t: 0.4, left_shoulder_pitch: -1.05, left_elbow: -0.55, left_wrist_roll: -0.3 },
    ],
  },
  cross: {
    name: "cross", label: "Cross (rear)", duration: 0.68, impact: 0.2,
    keys: [
      { t: 0.08, right_shoulder_pitch: -1.0, right_elbow: -0.5, waist_yaw: 0.3, yaw: -0.42 },
      hold(0.2, CROSS_OUT),
      hold(0.28, CROSS_OUT),
      { t: 0.5, right_shoulder_pitch: -0.9, right_elbow: -0.7, right_wrist_roll: 0.3, waist_yaw: 0.26, yaw: -0.32, rfyaw: -0.5 },
    ],
  },
  front_kick: {
    name: "front_kick", label: "Front kick", duration: 0.95, impact: 0.42,
    keys: [
      { t: 0.12, rik: 0, right_hip_pitch: -0.75, right_hip_roll: 0, right_hip_yaw: 0, right_knee: 1.35, right_ankle_pitch: 0.25, py: 0.06, px: -0.01, yaw: -0.15, pz: 0.73 },
      { t: 0.28, rik: 0, right_hip_pitch: -1.55, right_knee: 2.0, right_ankle_pitch: 0.35, waist_pitch: 0.02, yaw: 0.0, pz: 0.75 },
      hold(0.42, KICK_OUT),
      hold(0.5, KICK_OUT),
      { t: 0.65, rik: 0, right_hip_pitch: -1.3, right_knee: 1.8, right_ankle_pitch: 0.3, waist_pitch: 0.05, pitch: 0.0, py: 0.05 },
      { t: 0.82, rik: 1 },
    ],
  },
  hit: {
    name: "hit", label: "Hit recoil", duration: 0.85, impact: 0.0,
    keys: [
      {
        t: 0.07, waist_pitch: -0.34, waist_roll: 0.08, waist_yaw: 0.4, pitch: -0.12, px: -0.05, pz: 0.7,
        left_shoulder_pitch: -0.45, left_shoulder_roll: 0.5, left_elbow: 0.25, right_shoulder_pitch: -0.35, right_shoulder_roll: -0.55, right_elbow: 0.35,
      },
      { t: 0.2, px: -0.09, rfx: -0.25, rfz: 0.05, waist_pitch: -0.22, pitch: -0.08 },
      {
        t: 0.34, rfz: 0, rfx: -0.25, px: -0.085, pz: 0.69, waist_pitch: 0.06, pitch: 0.03, waist_yaw: 0.3,
        left_shoulder_pitch: -0.85, left_shoulder_roll: 0.25, left_elbow: -0.35, right_shoulder_pitch: -0.75, right_shoulder_roll: -0.25, right_elbow: -0.45,
      },
      { t: 0.58, rfx: -0.2, rfz: 0.04, px: -0.05 },
    ],
  },
  bind: {
    name: "bind", label: "Bind pose (rest)", duration: 1, loop: true, keys: [],
    fixed: { px: 0, py: 0, pz: STAND_HEIGHT, yaw: 0, pitch: 0, roll: 0, lik: 0, rik: 0 },
  },
};
export const MOTION_NAMES = Object.keys(MOTIONS);

// per-motion, per-channel key lists (only keys that set the channel)
const TRACKS = new Map<MotionDef, { t: number[]; v: number[] }[]>();
function tracks(m: MotionDef) {
  let tr = TRACKS.get(m);
  if (!tr) {
    tr = CHANNELS.map((c) => {
      const ks = m.keys.filter((k) => c in k);
      return { t: ks.map((k) => k.t), v: ks.map((k) => k[c]) };
    });
    TRACKS.set(m, tr);
  }
  return tr;
}

const ease = (x: number) => x * x * (3 - 2 * x);

/** Motion channels at time t: keys interpolated, with the live guard pose as the start and end key. */
function sampleMotion(m: MotionDef, t: number, g: Float64Array, out: Float64Array) {
  const tr = tracks(m);
  for (let c = 0; c < NCH; c++) {
    const { t: kt, v: kv } = tr[c];
    if (kt.length === 0) { out[c] = g[c]; continue; }
    let t0 = 0, v0 = g[c], t1 = m.duration, v1 = g[c];
    for (let i = 0; i < kt.length; i++) {
      if (kt[i] <= t) { t0 = kt[i]; v0 = kv[i]; } else { t1 = kt[i]; v1 = kv[i]; break; }
    }
    if (m.loop && t0 === kt[kt.length - 1]) { t1 = m.duration; v1 = kv[0]; }
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
    out[c] = v0 + (v1 - v0) * ease(u);
  }
  if (m.name === "bind") {
    for (let k = J0; k < NCH; k++) out[k] = 0;
    for (const [j, a] of Object.entries(BIND_ANGLES)) if (j in JOINT_INDEX) out[J0 + JOINT_INDEX[j]] = a;
  }
  if (m.fixed) for (const [c, v] of Object.entries(m.fixed)) out[CH[c]] = v;
}

// ---------------------------------------------------------------- animator
export interface FighterPose { q: Float64Array; rootPos: Vec3; rootQuat: Quat }

export class Animator {
  motion: MotionDef = MOTIONS.guard;
  t = 0;
  clock = Math.random() * 10;
  /** Called once per motion when its impact time passes. */
  onImpact: ((m: MotionDef) => void) | null = null;
  /** Called when a one-shot motion ends (and the animator returns to the guard). */
  onEnd: ((m: MotionDef) => void) | null = null;
  readonly pose: FighterPose = { q: new Float64Array(29), rootPos: [0, 0, 0.75], rootQuat: [1, 0, 0, 0] };
  private g = new Float64Array(NCH);
  private ch = new Float64Array(NCH);
  private from = new Float64Array(NCH);
  private fade = 1;
  private fadeDur = 0.15;
  private impactDone = false;
  private legQ: Record<Side, number[]> = { left: [-0.3, 0, 0, 0.6, -0.3, 0], right: [-0.3, 0, 0, 0.6, -0.3, 0] };
  /** Max IK residual of the last update (m), for debugging unreachable foot targets. */
  ikError = 0;

  play(name: string, fade = 0.12) {
    const m = MOTIONS[name];
    if (!m) throw new Error(`unknown motion ${name}`);
    this.from.set(this.ch);
    this.fade = fade > 0 ? 0 : 1;
    this.fadeDur = Math.max(fade, 1e-3);
    this.motion = m;
    this.t = 0;
    this.impactDone = false;
  }

  update(dt: number): FighterPose {
    this.clock += dt;
    this.t += dt;
    const m = this.motion;
    if (!m.loop && m.impact !== undefined && !this.impactDone && this.t >= m.impact) {
      this.impactDone = true;
      this.onImpact?.(m);
    }
    if (!m.loop && this.t >= m.duration) {
      this.motion = MOTIONS.guard;
      this.t = 0;
      this.onEnd?.(m);
    } else if (m.loop) this.t %= m.duration;

    guard(this.clock, this.g, this.legQ);
    if (this.motion === MOTIONS.guard) this.ch.set(this.g);
    else sampleMotion(this.motion, this.t, this.g, this.ch);
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeDur);
      const u = ease(this.fade);
      for (let c = 0; c < NCH; c++) this.ch[c] = this.from[c] + (this.ch[c] - this.from[c]) * u;
    }
    return this.solve();
  }

  private solve(): FighterPose {
    const c = this.ch, P = this.pose;
    P.rootPos[0] = c[CH.px]; P.rootPos[1] = c[CH.py]; P.rootPos[2] = c[CH.pz];
    const rq = qeuler(c[CH.yaw], c[CH.pitch], c[CH.roll]);
    P.rootQuat[0] = rq[0]; P.rootQuat[1] = rq[1]; P.rootQuat[2] = rq[2]; P.rootQuat[3] = rq[3];
    for (let j = 0; j < 29; j++) P.q[j] = c[J0 + j];
    const inv = qconj(rq);
    this.ikError = 0;
    for (const side of ["left", "right"] as Side[]) {
      const s = side === "left" ? "l" : "r";
      const w = Math.min(1, Math.max(0, c[CH[s + "ik"]]));
      if (w <= 0) continue;
      const target: Vec3 = [c[CH[s + "fx"]] - P.rootPos[0], c[CH[s + "fy"]] - P.rootPos[1], ANKLE_Z + c[CH[s + "fz"]] - P.rootPos[2]];
      const tp = qrot(inv, target);
      const tq = qmul(inv, qaxis([0, 0, 1], c[CH[s + "fyaw"]]));
      const err = solveLegIK(side, tp, tq, this.legQ[side], 6);
      this.ikError = Math.max(this.ikError, err);
      LEG_JOINTS[side].forEach((j, k) => { P.q[j] = P.q[j] + (this.legQ[side][k] - P.q[j]) * w; });
    }
    return P;
  }
}

/** Place a fighter-frame pose in the arena: world = T(x, y) * Rz(yaw) * pose. */
export function placePose(p: FighterPose, x: number, y: number, yaw: number): { rootPos: Vec3; rootQuat: Quat } {
  const qz = qaxis([0, 0, 1], yaw);
  const r = qrot(qz, p.rootPos);
  return { rootPos: [r[0] + x, r[1] + y, r[2]], rootQuat: qmul(qz, p.rootQuat) };
}
