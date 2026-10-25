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

/** Angle (rad) between the body's up axis and world up. 0 = upright. */
export function tiltOf(q: ArrayLike<number>): number {
  const x = q[1], y = q[2];
  const upz = 1 - 2 * (x * x + y * y);
  return Math.acos(Math.max(-1, Math.min(1, upz)));
}

export const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
