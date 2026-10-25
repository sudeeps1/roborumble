// Quaternion helpers. Quaternions are [w, x, y, z], the MuJoCo convention.
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function qmul(a: ArrayLike<number>, b: ArrayLike<number>, out: number[] = [0, 0, 0, 0]): number[] {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3];
  const bw = b[0], bx = b[1], by = b[2], bz = b[3];
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out;
}

export function qconj(q: ArrayLike<number>, out: number[] = [0, 0, 0, 0]): number[] {
  out[0] = q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = -q[3];
  return out;
}

export function qnormalize(q: number[]): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  return q;
}

/** Rotates v by unit quaternion q. */
export function qrot(q: ArrayLike<number>, v: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}

/** Yaw angle (rotation about world Z) of q. */
export function yawOf(q: ArrayLike<number>): number {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export function yawQuat(yaw: number, out: number[] = [0, 0, 0, 0]): number[] {
  out[0] = Math.cos(yaw / 2); out[1] = 0; out[2] = 0; out[3] = Math.sin(yaw / 2);
  return out;
}

/** First two columns of q's rotation matrix, flattened row by row: [R00, R01, R10, R11, R20, R21]. */
export function rot6d(q: ArrayLike<number>, out: Float32Array, o: number) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  out[o + 0] = 1 - 2 * (y * y + z * z);
  out[o + 1] = 2 * (x * y - w * z);
  out[o + 2] = 2 * (x * y + w * z);
  out[o + 3] = 1 - 2 * (x * x + z * z);
  out[o + 4] = 2 * (x * z - w * y);
  out[o + 5] = 2 * (y * z + w * x);
}

export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: number[] = [0, 0, 0, 0]): number[] {
  let bw = b[0], bx = b[1], by = b[2], bz = b[3];
  let d = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (d < 0) { d = -d; bw = -bw; bx = -bx; by = -by; bz = -bz; }
  let ka = 1 - t, kb = t;
  if (d < 0.9995) {
    const th = Math.acos(d), s = Math.sin(th);
    ka = Math.sin((1 - t) * th) / s;
    kb = Math.sin(t * th) / s;
  }
  out[0] = ka * a[0] + kb * bw; out[1] = ka * a[1] + kb * bx;
  out[2] = ka * a[2] + kb * by; out[3] = ka * a[3] + kb * bz;
  return qnormalize(out);
}

/** Angle of the twist about world Z in q (swing-twist split): the yaw that best explains q. */
export function twistZ(q: ArrayLike<number>): number {
  return 2 * Math.atan2(q[3], q[0]);
}

/** Angle (rad) between the body's up axis and world up. 0 = upright. */
export function tiltOf(q: ArrayLike<number>): number {
  const x = q[1], y = q[2];
  const upz = 1 - 2 * (x * x + y * y);
  return Math.acos(Math.max(-1, Math.min(1, upz)));
}

export const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** v limited to [lo, hi]; NaN comes out as lo, so a bad number can't slip through a bound. */
export const clamp = (v: number, lo: number, hi: number) => (v > hi ? hi : v >= lo ? v : lo);

/** Unit quaternion for a rotation of `angle` rad about axis (ax, ay, az) (any length > 0). */
export function axisAngleQuat(ax: number, ay: number, az: number, angle: number, out: number[] = [1, 0, 0, 0]): number[] {
  const n = Math.hypot(ax, ay, az);
  if (n < 1e-9 || angle === 0) { out[0] = 1; out[1] = out[2] = out[3] = 0; return out; }
  const s = Math.sin(angle / 2) / n;
  out[0] = Math.cos(angle / 2); out[1] = ax * s; out[2] = ay * s; out[3] = az * s;
  return out;
}

export const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const dist2 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const finite3 = (v: ArrayLike<number>) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** Distance from point p to segment a-b, and the closest point on the segment (into `out`). */
export function pointSegment(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, out: number[] = [0, 0, 0]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-12 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = a[0] + abx * t; out[1] = a[1] + aby * t; out[2] = a[2] + abz * t;
  return Math.hypot(p[0] - out[0], p[1] - out[1], p[2] - out[2]);
}

/** Small deterministic RNG (Park-Miller), so fights replay the same from a seed. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = Math.max(1, Math.floor(Math.abs(seed)) % 2147483646 || 1); }
  next(): number { this.s = (this.s * 16807) % 2147483647; return (this.s - 1) / 2147483646; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  pick<T>(xs: readonly T[]): T { return xs[Math.min(xs.length - 1, Math.floor(this.next() * xs.length))]; }
  int(): number { this.next(); return this.s; }
}
