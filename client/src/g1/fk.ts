// Forward kinematics for an MJCF model, matching MuJoCo's mj_kinematics for hinge/slide/free joints.
// Used by the stub sim and the mock motions. The real sim (src/sim, Sudeep) gets body poses from MuJoCo itself.
import type { Motion, Quat, Vec3 } from "../contract";
import { jointIndex, qpos0, type MjModel } from "./mjcf";

export interface BodyPoses {
  pos: Float64Array;   // 3 per body, world frame
  quat: Float64Array;  // 4 per body (w, x, y, z)
}

export class Kinematics {
  readonly model: MjModel;
  readonly bodyNames: string[];
  private readonly joints: Map<string, MjModel["joints"][number]>;

  constructor(model: MjModel) {
    this.model = model;
    this.bodyNames = model.bodies.map((b) => b.name);
    this.joints = jointIndex(model);
  }

  /** World pose of every body for a qpos in this model's joint order. */
  forward(qpos: ArrayLike<number>, out?: BodyPoses): BodyPoses {
    const nb = this.model.bodies.length;
    const res = out ?? { pos: new Float64Array(nb * 3), quat: new Float64Array(nb * 4) };
    const { pos, quat } = res;
    const p: Vec3 = [0, 0, 0];
    const q: Quat = [1, 0, 0, 0];
    for (let i = 0; i < nb; i++) {
      const b = this.model.bodies[i];
      // body frame = parent * (pos, quat)
      if (b.parent < 0) {
        p[0] = b.pos[0]; p[1] = b.pos[1]; p[2] = b.pos[2];
        q[0] = b.quat[0]; q[1] = b.quat[1]; q[2] = b.quat[2]; q[3] = b.quat[3];
      } else {
        const pp: Vec3 = [pos[b.parent * 3], pos[b.parent * 3 + 1], pos[b.parent * 3 + 2]];
        const pq: Quat = [quat[b.parent * 4], quat[b.parent * 4 + 1], quat[b.parent * 4 + 2], quat[b.parent * 4 + 3]];
        const off = rotate(pq, b.pos);
        p[0] = pp[0] + off[0]; p[1] = pp[1] + off[1]; p[2] = pp[2] + off[2];
        const m = mul(pq, b.quat);
        q[0] = m[0]; q[1] = m[1]; q[2] = m[2]; q[3] = m[3];
      }
      for (const ji of b.joints) {
        const j = this.model.joints[ji];
        const a = j.qposAdr;
        if (j.type === "free") {
          // a free joint's qpos IS the body pose (the XML pos/quat only define qpos0)
          p[0] = qpos[a]; p[1] = qpos[a + 1]; p[2] = qpos[a + 2];
          const n = normalizeQ([qpos[a + 3], qpos[a + 4], qpos[a + 5], qpos[a + 6]]);
          q[0] = n[0]; q[1] = n[1]; q[2] = n[2]; q[3] = n[3];
        } else if (j.type === "hinge") {
          // rotate about the joint axis through the joint anchor (both in the body frame)
          const anchor = add(p, rotate(q, j.pos));
          const r = axisAngle(j.axis, qpos[a]);
          const nq = mul(q, r);
          const back = rotate(nq, j.pos);
          p[0] = anchor[0] - back[0]; p[1] = anchor[1] - back[1]; p[2] = anchor[2] - back[2];
          q[0] = nq[0]; q[1] = nq[1]; q[2] = nq[2]; q[3] = nq[3];
        } else if (j.type === "slide") {
          const d = rotate(q, j.axis);
          p[0] += d[0] * qpos[a]; p[1] += d[1] * qpos[a]; p[2] += d[2] * qpos[a];
        } else if (j.type === "ball") {
          const nq = mul(q, normalizeQ([qpos[a], qpos[a + 1], qpos[a + 2], qpos[a + 3]]));
          q[0] = nq[0]; q[1] = nq[1]; q[2] = nq[2]; q[3] = nq[3];
        }
      }
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      const n = normalizeQ(q);
      quat[i * 4] = n[0]; quat[i * 4 + 1] = n[1]; quat[i * 4 + 2] = n[2]; quat[i * 4 + 3] = n[3];
    }
    return res;
  }

  /**
   * Maps a Motion (joint_names order, per CLAUDE.md: root pos, root quat wxyz, then joint angles) to
   * this model's qpos order. Joints the motion doesn't name stay at `fallback` (default: qpos0).
   */
  motionMapper(motion: Motion, fallback?: number[]): (frame: number[], out?: number[]) => number[] {
    const base = fallback ?? qpos0(this.model);
    const free = this.model.joints.find((j) => j.type === "free");
    const map: [number, number][] = []; // [motion column, model qpos index]
    motion.joint_names.forEach((name, i) => {
      const j = this.joints.get(name);
      if (j && j.type !== "free") map.push([7 + i, j.qposAdr]);
    });
    const missing = motion.joint_names.filter((n) => !this.joints.has(n));
    if (missing.length) console.warn(`motion ${motion.id}: joints not in the model: ${missing.join(", ")}`);
    return (frame, out) => {
      const q = out ?? base.slice();
      if (out) for (let i = 0; i < base.length; i++) q[i] = base[i];
      if (free) for (let k = 0; k < 7; k++) q[free.qposAdr + k] = frame[k];
      for (const [col, adr] of map) q[adr] = frame[col];
      return q;
    };
  }

  /** Named joint angles -> full qpos (root from `root`, everything else from `base`). */
  qposFrom(angles: Record<string, number>, root: { pos: Vec3; quat: Quat }, base?: number[]): number[] {
    const q = (base ?? qpos0(this.model)).slice();
    const free = this.model.joints.find((j) => j.type === "free");
    if (free) q.splice(free.qposAdr, 7, ...root.pos, ...root.quat);
    for (const [name, v] of Object.entries(angles)) {
      const j = this.joints.get(name);
      if (j && j.type !== "free") q[j.qposAdr] = v;
    }
    return q;
  }

  bodyIndex(name: string): number {
    return this.bodyNames.indexOf(name);
  }
}

// ---------- quaternion helpers, MuJoCo order (w, x, y, z) ----------
export function mul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  // v' = q v q*, expanded
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function axisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

export function normalizeQ(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function conj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

/** Rotation about world Z by `yaw` radians. */
export const yawQuat = (yaw: number): Quat => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];

/** Heading (yaw about Z) of a quaternion: the angle of its local +X axis in the XY plane. */
export function yawOf(q: Quat): number {
  const f = rotate(q, [1, 0, 0]);
  return Math.atan2(f[1], f[0]);
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) return normalizeQ([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
