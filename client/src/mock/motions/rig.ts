// Keyframe rig for the procedural mock motions: joint-angle keys with easing, leg IK that keeps planted
// feet locked, arm IK that puts a palm on a target at a key, then every frame grounded on the lowest foot
// contact. MuJoCo frame throughout: meters, Z up, the robot starts at the origin facing +X.
import type { Motion, Quat, Vec3 } from "../../contract";
import type { MjJoint, MjModel } from "../../g1/mjcf";
import { Kinematics, axisAngle, conj, mul, rotate, yawQuat, type BodyPoses } from "../../g1/fk";

export const FPS = 30;

/** Short joint names for keyframes. */
export const J = {
  lhp: "left_hip_pitch_joint", lhr: "left_hip_roll_joint", lhy: "left_hip_yaw_joint", lk: "left_knee_joint", lap: "left_ankle_pitch_joint", lar: "left_ankle_roll_joint",
  rhp: "right_hip_pitch_joint", rhr: "right_hip_roll_joint", rhy: "right_hip_yaw_joint", rk: "right_knee_joint", rap: "right_ankle_pitch_joint", rar: "right_ankle_roll_joint",
  wy: "waist_yaw_joint", wr: "waist_roll_joint", wp: "waist_pitch_joint",
  lsp: "left_shoulder_pitch_joint", lsr: "left_shoulder_roll_joint", lsy: "left_shoulder_yaw_joint", le: "left_elbow_joint",
  lwr: "left_wrist_roll_joint", lwp: "left_wrist_pitch_joint", lwy: "left_wrist_yaw_joint",
  rsp: "right_shoulder_pitch_joint", rsr: "right_shoulder_roll_joint", rsy: "right_shoulder_yaw_joint", re: "right_elbow_joint",
  rwr: "right_wrist_roll_joint", rwp: "right_wrist_pitch_joint", rwy: "right_wrist_yaw_joint",
} as const;
export type JointKey = keyof typeof J;
export type Pose = Partial<Record<JointKey, number>>;

/**
 * IK-held foot: ankle over (x, y), toes toward `yaw`, sole flat `z` above the floor (default 0: planted).
 * `heel` > 0 lifts the heel about the toes (rad). A small z gives clean vertical lift-offs and landings.
 */
export interface Foot { x: number; y: number; yaw?: number; heel?: number; z?: number; }
export interface Root { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; }

export type Ease = "linear" | "in" | "in3" | "out" | "out3" | "inOut";
const EASE: Record<Ease, (u: number) => number> = {
  linear: (u) => u,
  in: (u) => u * u,
  in3: (u) => u * u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  out3: (u) => 1 - (1 - u) ** 3,
  inOut: (u) => u * u * (3 - 2 * u),
};

/**
 * One keyframe. Joint angles, root fields and planted feet carry forward from the previous key unless
 * given. `lh`/`rh` are palm targets (world) solved by arm IK at this key only; the solved angles carry on.
 */
export interface Key {
  t: number;            // seconds
  ease?: Ease;          // easing of the segment that ends at this key (default inOut)
  q?: number[];         // start from these joint angles instead of the previous key's (e.g. back to the guard)
  pose?: Pose;
  root?: Partial<Root>;
  lf?: Foot | null;     // null: the leg follows `pose` (kicks); a Foot: leg IK keeps it planted there
  rf?: Foot | null;
  lh?: Vec3;            // palm targets (arm IK at this key)
  rh?: Vec3;
  lkick?: Vec3;         // ankle target for a free leg (position IK at this key; `pose` sets the leg's style)
  rkick?: Vec3;
  lift?: number;        // step height when a planted foot moves 5 cm or more to this key (default 0.05 m)
}

/** Per-frame hook, before leg IK: change the root or foot targets (spins, loops). */
export type FrameMod = (t: number, s: { root: Root; lf: Foot | null; rf: Foot | null; q: number[] }) => void;

export interface Clip { id: string; keys: Key[]; mod?: FrameMod; loop?: boolean; }

type Side = "l" | "r";
interface Chain { adr: number[]; joint: MjJoint[]; body: number[]; tip: number; off: Vec3; }

const SOLE = 0.035;                    // ankle_roll_link origin above the floor with the foot flat
const TOE: Vec3 = [0.12, 0, -SOLE];    // toe contact line, foot frame
// g1.xml foot contact spheres (ankle_roll_link frame), radius 0.005
const CONTACTS: Vec3[] = [[-0.05, 0.025, -0.03], [-0.05, -0.025, -0.03], [0.12, 0.03, -0.03], [0.12, -0.03, -0.03]];
const CONTACT_R = 0.005;
const ROT_W = 0.3;                     // IK: 1 rad of foot orientation error weighs like 0.3 m
const LEG_SEED = [-0.3, 0, 0, 0.6, -0.3, 0]; // hip pitch/roll/yaw, knee, ankle pitch/roll: a bent, neutral leg

export class Rig {
  readonly kin: Kinematics;
  readonly names: string[];   // Motion.joint_names: the model's non-free joints, model order
  private readonly cols: number[];     // qpos index of each name
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly free: number;
  private readonly adrOf = new Map<string, number>();
  private readonly legs: Record<Side, Chain>;
  private readonly arms: Record<Side, Chain>;
  private readonly feet: number[];
  private readonly buf: BodyPoses;
  /** Worst IK miss (m) since the last reset; the dev harness reads it to flag unreachable targets. */
  worst = 0;
  /** Set to get a line for every keyframe target IK can't reach (dev). */
  debug: ((msg: string) => void) | null = null;

  constructor(readonly model: MjModel) {
    this.kin = new Kinematics(model);
    const hinges = model.joints.filter((j) => j.type !== "free");
    this.names = hinges.map((j) => j.name);
    this.cols = hinges.map((j) => j.qposAdr);
    this.lo = new Array(model.nq).fill(-Infinity);
    this.hi = new Array(model.nq).fill(Infinity);
    for (const j of hinges) {
      this.adrOf.set(j.name, j.qposAdr);
      if (j.range) { this.lo[j.qposAdr] = j.range[0]; this.hi[j.qposAdr] = j.range[1]; }
      // the G1 elbow can bend 30 deg past straight (1.57); that reads as a broken arm, so stop just past straight
      if (j.name.endsWith("_elbow_joint")) this.hi[j.qposAdr] = Math.min(this.hi[j.qposAdr], 1.62);
    }
    this.free = model.joints.find((j) => j.type === "free")?.qposAdr ?? 0;
    const chain = (names: string[], tip: string, off: Vec3): Chain => {
      const joint = names.map((n) => {
        const j = model.joints.find((x) => x.name === n);
        if (!j) throw new Error(`mock motions: the model has no joint ${n}`);
        return j;
      });
      return { adr: joint.map((j) => j.qposAdr), joint, body: joint.map((j) => j.body), tip: this.body(tip), off };
    };
    const leg = (s: string) => chain(["hip_pitch", "hip_roll", "hip_yaw", "knee", "ankle_pitch", "ankle_roll"].map((n) => `${s}_${n}_joint`), `${s}_ankle_roll_link`, [0, 0, 0]);
    const arm = (s: string, y: number) => chain(["shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow"].map((n) => `${s}_${n}_joint`), `${s}_wrist_yaw_link`, [0.11, y, 0.01]);
    this.legs = { l: leg("left"), r: leg("right") };
    this.arms = { l: arm("left", -0.01), r: arm("right", 0.01) }; // palm centers (robot.ts hand anchors)
    this.feet = [this.body("left_ankle_roll_link"), this.body("right_ankle_roll_link")];
    this.buf = { pos: new Float64Array(model.bodies.length * 3), quat: new Float64Array(model.bodies.length * 4) };
  }

  body(name: string): number {
    const i = this.kin.bodyIndex(name);
    if (i < 0) throw new Error(`mock motions: the model has no body ${name}`);
    return i;
  }

  adr(k: JointKey): number {
    return this.adrOf.get(J[k]) ?? -1;
  }

  /** Full qpos from a root and joint angles (keys of `pose` override `base`). */
  qpos(root: Root, base: number[], pose?: Pose): number[] {
    const q = base.slice();
    this.setRoot(q, root);
    if (pose) for (const [k, v] of Object.entries(pose) as [JointKey, number][]) {
      const a = this.adr(k);
      if (a >= 0) q[a] = v;
    }
    this.clamp(q);
    return q;
  }

  setRoot(q: number[], r: Root) {
    const quat = mul(mul(yawQuat(r.yaw), axisAngle([0, 1, 0], r.pitch)), axisAngle([1, 0, 0], r.roll));
    q[this.free] = r.x; q[this.free + 1] = r.y; q[this.free + 2] = r.z;
    for (let k = 0; k < 4; k++) q[this.free + 3 + k] = quat[k];
  }

  clamp(q: number[]) {
    for (let i = 0; i < q.length; i++) q[i] = Math.min(this.hi[i], Math.max(this.lo[i], q[i]));
  }

  /** Leg IK: put the foot on its target. Returns the miss (m; orientation counts 0.3 m per rad). */
  plant(q: number[], side: Side, f: Foot, lift = 0): number {
    const t = footTarget(f);
    t.p[2] += lift;
    const ch = this.legs[side];
    const before = ch.adr.map((a) => q[a]);
    // a straight knee is singular: start bent
    if (q[ch.adr[3]] < 0.15) LEG_SEED.forEach((v, i) => (q[ch.adr[i]] = v));
    let err = this.solve(ch, q, t.p, t.q);
    if (err > 1e-3) {
      // stuck: retry from the seed, keep the better answer
      const first = ch.adr.map((a) => q[a]);
      LEG_SEED.forEach((v, i) => (q[ch.adr[i]] = v));
      const err2 = this.solve(ch, q, t.p, t.q, 80);
      if (err2 > err) ch.adr.forEach((a, i) => (q[a] = first[i]));
      else err = err2;
      if (err > 0.02) ch.adr.forEach((a, i) => (q[a] = before[i])); // unreachable: leave the leg alone
    }
    return this.note(err);
  }

  /**
   * Arm IK: palm center to a world point (shoulder pitch/roll/yaw + elbow). The arm's current angles are the
   * style guess: the spare degree of freedom stays near them, so set a rough pose first. Returns the error (m).
   */
  reach(q: number[], side: Side, p: Vec3): number {
    return this.toward(this.arms[side], q, p);
  }

  /** Free-leg IK: ankle (ankle_roll_link origin) to a world point, position only, near the leg's current style. */
  kick(q: number[], side: Side, p: Vec3): number {
    return this.toward(this.legs[side], q, p);
  }

  private toward(ch: Chain, q: number[], p: Vec3): number {
    const e1 = this.solve(ch, q, p, null, 50, ch.adr.map((a) => q[a]));
    const mid = ch.adr.map((a) => q[a]);
    // polish with plain steps; if that can't land (out of reach), keep the near-style compromise
    const e2 = this.solve(ch, q, p, null, 20);
    const moved = ch.adr.reduce((s, a, i) => Math.max(s, Math.abs(q[a] - mid[i])), 0);
    if (e2 > 0.004 || moved > 0.5) {
      ch.adr.forEach((a, i) => (q[a] = mid[i]));
      return this.note(e1);
    }
    return this.note(e2);
  }

  private note(err: number) {
    this.worst = Math.max(this.worst, err);
    return err;
  }

  /** Lift the root so the lowest foot contact touches z = 0. Returns the shift applied. */
  ground(q: number[]): number {
    const P = this.kin.forward(q, this.buf);
    let low = Infinity;
    for (const b of this.feet) {
      const bq = quatAt(P, b);
      for (const c of CONTACTS) low = Math.min(low, P.pos[b * 3 + 2] + rotate(bq, c)[2] - CONTACT_R);
    }
    q[this.free + 2] -= low;
    return -low;
  }

  /** World position of a body (plus a local offset) for a full qpos. */
  point(q: number[], body: number, off: Vec3 = [0, 0, 0]): Vec3 {
    const P = this.kin.forward(q, this.buf);
    const r = rotate(quatAt(P, body), off);
    return [P.pos[body * 3] + r[0], P.pos[body * 3 + 1] + r[1], P.pos[body * 3 + 2] + r[2]];
  }

  /** Motion row: root pos, root quat (w, x, y, z), joint angles in `names` order. */
  row(q: number[]): number[] {
    const out = new Array(7 + this.cols.length);
    for (let k = 0; k < 7; k++) out[k] = q[this.free + k];
    for (let i = 0; i < this.cols.length; i++) out[7 + i] = q[this.cols[i]];
    return out;
  }

  // Damped least squares on a joint chain. Position target, plus orientation when tq is given. With `rest`,
  // also pulls gently toward those angles: (J^T J + (l^2 + r^2) I) d = J^T e + r^2 (rest - q).
  private solve(ch: Chain, q: number[], tp: Vec3, tq: Quat | null, iters = 40, rest?: number[]): number {
    const n = ch.adr.length, m = tq ? 6 : 3;
    const Jm: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    const e = new Array(m).fill(0);
    const R2 = rest ? 4e-3 : 0;
    let err = Infinity, rot = 0;
    for (let it = 0; it < iters; it++) {
      const P = this.kin.forward(q, this.buf);
      const tipQ = quatAt(P, ch.tip);
      const o = rotate(tipQ, ch.off);
      const tip: Vec3 = [P.pos[ch.tip * 3] + o[0], P.pos[ch.tip * 3 + 1] + o[1], P.pos[ch.tip * 3 + 2] + o[2]];
      e[0] = tp[0] - tip[0]; e[1] = tp[1] - tip[1]; e[2] = tp[2] - tip[2];
      err = Math.hypot(e[0], e[1], e[2]);
      if (tq) {
        const d = mul(tq, conj(tipQ));
        const s = d[0] < 0 ? -1 : 1;
        const vn = Math.hypot(d[1], d[2], d[3]);
        const k = vn > 1e-12 ? (2 * Math.atan2(vn, s * d[0])) / vn * s : 2 * s;
        e[3] = d[1] * k * ROT_W; e[4] = d[2] * k * ROT_W; e[5] = d[3] * k * ROT_W;
        rot = Math.hypot(e[3], e[4], e[5]);
      }
      if (err < 2e-5 && rot < 2e-5 && !rest) { rot = 0; break; }
      if (rest && err < 1e-4) break;
      for (let c = 0; c < n; c++) {
        const b = ch.body[c], bq = quatAt(P, b);
        const ax = rotate(bq, ch.joint[c].axis);
        const ao = rotate(bq, ch.joint[c].pos);
        const r: Vec3 = [tip[0] - P.pos[b * 3] - ao[0], tip[1] - P.pos[b * 3 + 1] - ao[1], tip[2] - P.pos[b * 3 + 2] - ao[2]];
        Jm[0][c] = ax[1] * r[2] - ax[2] * r[1];
        Jm[1][c] = ax[2] * r[0] - ax[0] * r[2];
        Jm[2][c] = ax[0] * r[1] - ax[1] * r[0];
        if (tq) { Jm[3][c] = ax[0] * ROT_W; Jm[4][c] = ax[1] * ROT_W; Jm[5][c] = ax[2] * ROT_W; }
      }
      // (J^T J + (l^2 + r^2) I) d = J^T e + r^2 (rest - q), with joints pinned at a limit (and pushed past it) locked
      const locked = new Array(n).fill(false);
      let d: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
          if (locked[i] || locked[j]) return i === j ? 1 : 0;
          let s = i === j ? 1e-3 + R2 : 0;
          for (let r = 0; r < m; r++) s += Jm[r][i] * Jm[r][j];
          return s;
        }));
        const b = Array.from({ length: n }, (_, c) => {
          if (locked[c]) return 0;
          let s = rest ? R2 * (rest[c] - q[ch.adr[c]]) : 0;
          for (let r = 0; r < m; r++) s += Jm[r][c] * e[r];
          return s;
        });
        d = solveLinear(A, b);
        let changed = false;
        for (let c = 0; c < n; c++) {
          const a = ch.adr[c];
          if (!locked[c] && ((q[a] >= this.hi[a] - 1e-9 && d[c] > 0) || (q[a] <= this.lo[a] + 1e-9 && d[c] < 0))) locked[c] = changed = true;
        }
        if (!changed) break;
      }
      for (let c = 0; c < n; c++) {
        const a = ch.adr[c];
        q[a] = Math.min(this.hi[a], Math.max(this.lo[a], q[a] + Math.max(-0.25, Math.min(0.25, d[c]))));
      }
    }
    return Math.max(err, rot); // orientation miss counts too (0.3 m per rad: 1 deg ~ 5 mm)
  }
}

function footTarget(f: Foot): { p: Vec3; q: Quat } {
  const qy = yawQuat(f.yaw ?? 0);
  const z = SOLE + (f.z ?? 0);
  if (!f.heel) return { p: [f.x, f.y, z], q: qy };
  const t = rotate(qy, TOE);
  const toe: Vec3 = [f.x + t[0], f.y + t[1], z + t[2]];
  const q = mul(qy, axisAngle([0, 1, 0], f.heel));
  const b = rotate(q, TOE);
  return { p: [toe[0] - b[0], toe[1] - b[1], toe[2] - b[2]], q };
}

const quatAt = (P: BodyPoses, b: number): Quat => [P.quat[b * 4], P.quat[b * 4 + 1], P.quat[b * 4 + 2], P.quat[b * 4 + 3]];

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpFoot = (a: Foot, b: Foot, u: number): Foot => ({
  x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), yaw: lerp(a.yaw ?? 0, b.yaw ?? 0, u), heel: lerp(a.heel ?? 0, b.heel ?? 0, u), z: lerp(a.z ?? 0, b.z ?? 0, u),
});
// under 5 cm (a pivot on the ball of the foot, a yaw or heel change) the foot shuffles; farther, it steps
const sameSpot = (a: Foot, b: Foot) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;

interface Resolved { t: number; ease: Ease; q: number[]; root: Root; lf: Foot | null; rf: Foot | null; lift: number; }

export interface Built {
  motion: Motion;
  frames: number[][]; // full qpos per frame, model order
  ikErr: number;      // worst IK miss while baking (m): dev check for unreachable targets
}

/**
 * Bakes a clip. Starts from `base` (joint angles, root and feet at t = 0), resolves every key (leg IK for
 * planted feet, arm IK for palm targets), then per frame: eased interpolation, leg IK for feet planted on
 * both sides of the segment, grounding. Loops drop the last frame (it equals the first).
 */
export function bake(rig: Rig, clip: Clip, base: { q: number[]; root: Root; lf: Foot | null; rf: Foot | null }): Built {
  rig.worst = 0;
  const res: Resolved[] = [];
  let cur: Resolved = { t: 0, ease: "inOut", q: base.q.slice(), root: { ...base.root }, lf: base.lf, rf: base.rf, lift: 0.05 };
  const keys = clip.keys[0]?.t === 0 ? clip.keys : [{ t: 0 }, ...clip.keys];
  for (const k of keys) {
    const root = { ...cur.root, ...k.root };
    const q = rig.qpos(root, k.q ?? cur.q, k.pose);
    const lf = k.lf !== undefined ? k.lf : cur.lf;
    const rf = k.rf !== undefined ? k.rf : cur.rf;
    const miss = (what: string, err: number) => err > 0.005 && rig.debug?.(`${clip.id} key t=${k.t.toFixed(3)} ${what} missed by ${(err * 1000).toFixed(0)} mm`);
    if (lf) miss("lf", rig.plant(q, "l", lf));
    else if (k.lkick) miss("lkick", rig.kick(q, "l", k.lkick));
    if (rf) miss("rf", rig.plant(q, "r", rf));
    else if (k.rkick) miss("rkick", rig.kick(q, "r", k.rkick));
    if (k.lh) miss("lh", rig.reach(q, "l", k.lh));
    if (k.rh) miss("rh", rig.reach(q, "r", k.rh));
    cur = { t: k.t, ease: k.ease ?? "inOut", q, root, lf, rf, lift: k.lift ?? 0.05 };
    res.push(cur);
  }

  const T = res[res.length - 1].t;
  const n = clip.loop ? Math.round(T * FPS) : Math.round(T * FPS) + 1;
  const frames: number[][] = [];
  const rows: number[][] = [];
  let seg = 0;
  for (let f = 0; f < n; f++) {
    const t = Math.min(T, f / FPS);
    while (seg < res.length - 2 && t > res[seg + 1].t) seg++;
    const A = res[seg], B = res[Math.min(seg + 1, res.length - 1)];
    const lin = B.t > A.t ? Math.min(1, Math.max(0, (t - A.t) / (B.t - A.t))) : 1;
    const u = EASE[B.ease](lin);
    const q = A.q.map((v, i) => lerp(v, B.q[i], u));
    const root: Root = {
      x: lerp(A.root.x, B.root.x, u), y: lerp(A.root.y, B.root.y, u), z: lerp(A.root.z, B.root.z, u),
      yaw: lerp(A.root.yaw, B.root.yaw, u), pitch: lerp(A.root.pitch, B.root.pitch, u), roll: lerp(A.root.roll, B.root.roll, u),
    };
    const st = {
      root,
      lf: A.lf && B.lf ? lerpFoot(A.lf, B.lf, u) : null,
      rf: A.rf && B.rf ? lerpFoot(A.rf, B.rf, u) : null,
      q,
    };
    clip.mod?.(t, st);
    rig.setRoot(q, st.root);
    // a planted foot that moves between keys steps: lift it on an arc
    for (const [side, foot, a, b] of [["l", st.lf, A.lf, B.lf], ["r", st.rf, A.rf, B.rf]] as const) {
      if (!foot) continue;
      const err = rig.plant(q, side, foot, a && b && !sameSpot(a, b) ? B.lift * Math.sin(Math.PI * u) : 0);
      if (err > 0.005) rig.debug?.(`${clip.id} frame ${f} ${side} foot missed by ${(err * 1000).toFixed(0)} mm`);
    }
    rig.clamp(q);
    rig.ground(q);
    frames.push(q);
    rows.push(rig.row(q));
  }
  return { motion: { id: clip.id, fps: FPS, joint_names: rig.names.slice(), qpos: rows }, frames, ikErr: rig.worst };
}

/** Frame where a body moves fastest (largest step from the previous frame), like the server's hit_frame. */
export function fastestFrame(rig: Rig, frames: number[][], body: number): number {
  let best = 0, bestD = -1;
  let prev = rig.point(frames[0], body);
  for (let f = 1; f < frames.length; f++) {
    const p = rig.point(frames[f], body);
    const d = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    if (d > bestD) { bestD = d; best = f; }
    prev = p;
  }
  return best;
}
