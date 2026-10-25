// G1 forward kinematics from g1_kinematics.json (port of blender/g1.py).
// MuJoCo frame: meters, Z up, robot faces +X at spawn, left = +Y. Quaternions are [w, x, y, z].
// body world = parent world * T(pos) * R(quat) * R(axis, angle). Pelvis is the free root.
// Plain math, no three.js, so the same code can run headless.
import kin from "./g1_kinematics.json";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // w, x, y, z
export interface BodyPose { name: string; pos: Vec3; quat: Quat }

interface KinJoint { name: string; axis: number[]; range: number[] | null }
interface KinBody { name: string; parent: number; pos: number[]; quat: number[]; joint: KinJoint | null }

export const BODIES: KinBody[] = (kin as { bodies: KinBody[] }).bodies;
export const BODY_NAMES: string[] = BODIES.map((b) => b.name);
export const BODY_INDEX: Record<string, number> = Object.fromEntries(BODY_NAMES.map((n, i) => [n, i]));
/** The 29 hinge joints in MuJoCo qpos order (same as Kimodo / Unitree g1_29dof). */
export const JOINTS: string[] = BODIES.filter((b) => b.joint).map((b) => b.joint!.name);
export const JOINT_INDEX: Record<string, number> = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
export const JOINT_RANGE: [number, number][] = BODIES.filter((b) => b.joint).map(
  (b) => (b.joint!.range ?? [-Math.PI, Math.PI]) as [number, number],
);
/** For each body, the index into JOINTS of its hinge (or -1 for the root). */
const BODY_JOINT: number[] = BODIES.map((b) => (b.joint ? JOINT_INDEX[b.joint.name] : -1));
export const STAND_HEIGHT = BODIES[0].pos[2]; // 0.793, pelvis height with straight legs

// ---------------------------------------------------------------- quaternion helpers (w, x, y, z)
export function qmul(a: ArrayLike<number>, b: ArrayLike<number>, out: number[] | Quat = [0, 0, 0, 0]): Quat {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out as Quat;
}
export function qconj(q: ArrayLike<number>): Quat { return [q[0], -q[1], -q[2], -q[3]]; }
export function qnorm(q: number[] | Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  return q as Quat;
}
/** Rotate v by unit quaternion q. */
export function qrot(q: ArrayLike<number>, v: ArrayLike<number>, out: number[] | Vec3 = [0, 0, 0]): Vec3 {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out as Vec3;
}
export function qaxis(axis: ArrayLike<number>, angle: number, out: number[] | Quat = [0, 0, 0, 0]): Quat {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / n;
  out[0] = Math.cos(angle / 2); out[1] = axis[0] * s; out[2] = axis[1] * s; out[3] = axis[2] * s;
  return out as Quat;
}
/** Z-Y-X (yaw, pitch, roll) Euler to quaternion: R = Rz(yaw) * Ry(pitch) * Rx(roll). */
export function qeuler(yaw: number, pitch: number, roll: number): Quat {
  const qz = qaxis([0, 0, 1], yaw), qy = qaxis([0, 1, 0], pitch), qx = qaxis([1, 0, 0], roll);
  return qmul(qmul(qz, qy), qx);
}
/** Rotation vector (axis * angle) of q. */
export function qlog(q: ArrayLike<number>): Vec3 {
  let w = q[0], x = q[1], y = q[2], z = q[3];
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [2 * x, 2 * y, 2 * z];
  const a = (2 * Math.atan2(s, w)) / s;
  return [x * a, y * a, z * a];
}

// ---------------------------------------------------------------- full-body FK
/** Reusable FK: compute() overwrites and returns the same BodyPose array (tree order, BODY_NAMES). */
export class G1FK {
  readonly out: BodyPose[] = BODIES.map((b) => ({ name: b.name, pos: [0, 0, 0] as Vec3, quat: [1, 0, 0, 0] as Quat }));
  private tmpQ: Quat = [1, 0, 0, 0];
  private tmpV: Vec3 = [0, 0, 0];

  /** q: 29 hinge angles (MuJoCo order) or {jointName: rad}. rootPos/rootQuat: pelvis world pose. */
  compute(q: ArrayLike<number> | Record<string, number>, rootPos: ArrayLike<number> = [0, 0, STAND_HEIGHT], rootQuat: ArrayLike<number> = [1, 0, 0, 0]): BodyPose[] {
    const byName = !(typeof (q as ArrayLike<number>).length === "number");
    for (let i = 0; i < BODIES.length; i++) {
      const b = BODIES[i], o = this.out[i];
      if (b.parent < 0) {
        o.pos[0] = rootPos[0]; o.pos[1] = rootPos[1]; o.pos[2] = rootPos[2];
        o.quat[0] = rootQuat[0]; o.quat[1] = rootQuat[1]; o.quat[2] = rootQuat[2]; o.quat[3] = rootQuat[3];
        qnorm(o.quat);
        continue;
      }
      const p = this.out[b.parent];
      qrot(p.quat, b.pos, this.tmpV);
      o.pos[0] = p.pos[0] + this.tmpV[0]; o.pos[1] = p.pos[1] + this.tmpV[1]; o.pos[2] = p.pos[2] + this.tmpV[2];
      qmul(p.quat, b.quat, o.quat);
      const ji = BODY_JOINT[i];
      if (ji >= 0) {
        const a = byName ? ((q as Record<string, number>)[b.joint!.name] ?? 0) : ((q as ArrayLike<number>)[ji] ?? 0);
        if (a !== 0) {
          qaxis(b.joint!.axis, a, this.tmpQ);
          qmul(o.quat, this.tmpQ, o.quat);
        }
      }
      qnorm(o.quat);
    }
    return this.out;
  }
}

/** One-shot FK (allocates). */
export function fk(q: ArrayLike<number> | Record<string, number>, rootPos?: ArrayLike<number>, rootQuat?: ArrayLike<number>): BodyPose[] {
  return new G1FK().compute(q, rootPos, rootQuat).map((b) => ({ name: b.name, pos: [...b.pos] as Vec3, quat: [...b.quat] as Quat }));
}

// ---------------------------------------------------------------- leg chain (for IK)
export const LEG_BODIES = {
  left: ["left_hip_pitch_link", "left_hip_roll_link", "left_hip_yaw_link", "left_knee_link", "left_ankle_pitch_link", "left_ankle_roll_link"],
  right: ["right_hip_pitch_link", "right_hip_roll_link", "right_hip_yaw_link", "right_knee_link", "right_ankle_pitch_link", "right_ankle_roll_link"],
};
export type Side = keyof typeof LEG_BODIES;
export const LEG_JOINTS: Record<Side, number[]> = {
  left: LEG_BODIES.left.map((n) => BODY_JOINT[BODY_INDEX[n]]),
  right: LEG_BODIES.right.map((n) => BODY_JOINT[BODY_INDEX[n]]),
};

/** Ankle-roll pose in the PELVIS frame for 6 leg angles, plus joint world axes/origins (for the Jacobian). */
export function legFK(side: Side, q6: ArrayLike<number>, axes?: Vec3[], origins?: Vec3[]): { pos: Vec3; quat: Quat } {
  let pos: Vec3 = [0, 0, 0];
  let quat: Quat = [1, 0, 0, 0];
  const names = LEG_BODIES[side];
  const tq: Quat = [1, 0, 0, 0];
  for (let k = 0; k < names.length; k++) {
    const b = BODIES[BODY_INDEX[names[k]]];
    const d = qrot(quat, b.pos);
    pos = [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]];
    quat = qmul(quat, b.quat);
    if (axes) axes[k] = qrot(quat, b.joint!.axis);
    if (origins) origins[k] = [pos[0], pos[1], pos[2]];
    quat = qnorm(qmul(quat, qaxis(b.joint!.axis, q6[k], tq)));
  }
  return { pos, quat };
}

/**
 * Damped-least-squares leg IK in the pelvis frame. Solves the 6 leg joints so the ankle_roll_link
 * reaches (targetPos, targetQuat). q6 is the warm start and is overwritten with the answer.
 */
export function solveLegIK(side: Side, targetPos: Vec3, targetQuat: Quat, q6: number[], iters = 8): number {
  const W_ROT = 0.25; // meters per radian of orientation error
  const lam2 = 0.03 * 0.03;
  const axes: Vec3[] = new Array(6), origins: Vec3[] = new Array(6);
  const J = new Float64Array(36), A = new Float64Array(36), e = new Float64Array(6), x = new Float64Array(6);
  const ranges = LEG_JOINTS[side].map((j) => JOINT_RANGE[j]);
  let err = 0;
  for (let it = 0; it < iters; it++) {
    const cur = legFK(side, q6, axes, origins);
    const dq = qlog(qmul(targetQuat, qconj(cur.quat)));
    e[0] = targetPos[0] - cur.pos[0]; e[1] = targetPos[1] - cur.pos[1]; e[2] = targetPos[2] - cur.pos[2];
    e[3] = dq[0] * W_ROT; e[4] = dq[1] * W_ROT; e[5] = dq[2] * W_ROT;
    err = Math.hypot(e[0], e[1], e[2], e[3], e[4], e[5]);
    if (err < 2e-4) break;
    // J column k = [a x (p_end - o); a]
    for (let k = 0; k < 6; k++) {
      const a = axes[k], o = origins[k];
      const rx = cur.pos[0] - o[0], ry = cur.pos[1] - o[1], rz = cur.pos[2] - o[2];
      J[0 * 6 + k] = a[1] * rz - a[2] * ry;
      J[1 * 6 + k] = a[2] * rx - a[0] * rz;
      J[2 * 6 + k] = a[0] * ry - a[1] * rx;
      J[3 * 6 + k] = a[0] * W_ROT; J[4 * 6 + k] = a[1] * W_ROT; J[5 * 6 + k] = a[2] * W_ROT;
    }
    // A = J J^T + lam^2 I ; solve A x = e ; dq = J^T x
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
      let s = r === c ? lam2 : 0;
      for (let k = 0; k < 6; k++) s += J[r * 6 + k] * J[c * 6 + k];
      A[r * 6 + c] = s;
    }
    x.set(e);
    solve6(A, x);
    for (let k = 0; k < 6; k++) {
      let s = 0;
      for (let r = 0; r < 6; r++) s += J[r * 6 + k] * x[r];
      const [lo, hi] = ranges[k];
      q6[k] = Math.min(hi, Math.max(lo, q6[k] + s));
    }
  }
  return err;
}

/** In-place Gaussian elimination with partial pivoting for a 6x6 system. */
function solve6(A: Float64Array, b: Float64Array) {
  const n = 6;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    const d = A[c * n + c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
    b[r] = s / (A[r * n + r] || 1e-12);
  }
}
