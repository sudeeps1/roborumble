// The motion a robot is trying to follow: frames of 36-value qpos (root pos, root quat w x y z,
// 29 joints in MuJoCo order) at 50 Hz, the SONIC control rate.
// Frames are addressed by an absolute frame clock (`now` advances one per control tick, forever),
// so motion that arrives late (an async plan) still lines up, even if the buffer was trimmed or
// replaced in between. New motion is spliced in with a short crossfade, as SONIC's deploy stack does.
import { NJ } from "./g1.ts";
import { slerp, tiltOf } from "./math.ts";

export const REF_HZ = 50;
const KEEP_BEHIND = 25; // frames kept before "now"

export type Frame = Float64Array; // length 36

export function copyFrame(f: ArrayLike<number>): Frame {
  const out = new Float64Array(36);
  for (let i = 0; i < 36; i++) out[i] = f[i];
  return out;
}

/** Linear blend of two frames (slerp for the root quaternion). */
export function mixFrames(a: Frame, b: Frame, t: number, out: Frame = new Float64Array(36)): Frame {
  for (let i = 0; i < 36; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  const q = slerp([a[3], a[4], a[5], a[6]], [b[3], b[4], b[5], b[6]], t);
  out[3] = q[0]; out[4] = q[1]; out[5] = q[2]; out[6] = q[3];
  return out;
}

/** Makes each root quaternion's sign agree with the one before it, so blends don't spin the long way. */
export function fixQuatSigns(frames: Frame[], prev?: Frame) {
  let p = prev;
  for (const f of frames) {
    if (p && p[3] * f[3] + p[4] * f[4] + p[5] * f[5] + p[6] * f[6] < 0) for (let i = 3; i < 7; i++) f[i] = -f[i];
    p = f;
  }
}

/** Resamples frames from one rate to another (lerp joints and position, slerp the root). */
export function resample(frames: Frame[], fromHz: number, toHz: number = REF_HZ): Frame[] {
  if (frames.length < 2 || fromHz === toHz) return frames.map(copyFrame);
  fixQuatSigns(frames);
  const n = Math.floor(((frames.length - 1) * toHz) / fromHz) + 1;
  const out: Frame[] = [];
  for (let k = 0; k < n; k++) {
    const s = (k * fromHz) / toHz;
    const i0 = Math.min(Math.floor(s), frames.length - 1);
    const i1 = Math.min(i0 + 1, frames.length - 1);
    out.push(mixFrames(frames[i0], frames[i1], s - i0));
  }
  return out;
}

/**
 * Makes incoming motion safe to follow: every value finite, root quaternions unit length,
 * joints inside the robot's limits (Kimodo overshoots them by up to ~8 degrees).
 * Returns false (and leaves the frames alone) if anything is not finite: drop that motion.
 */
export function sanitizeFrames(frames: Frame[], lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
  if (!frames.length) return false;
  for (const f of frames) {
    if (f.length !== 36) return false;
    for (let i = 0; i < 36; i++) if (!Number.isFinite(f[i])) return false;
  }
  for (const f of frames) {
    const n = Math.hypot(f[3], f[4], f[5], f[6]);
    if (n < 1e-6) { f[3] = 1; f[4] = f[5] = f[6] = 0; } else for (let i = 3; i < 7; i++) f[i] /= n;
    for (let j = 0; j < NJ; j++) f[7 + j] = Math.min(hi[j], Math.max(lo[j], f[7 + j]));
  }
  return true;
}

export class Reference {
  private frames: Frame[];
  /** Absolute frame index of frames[0]. */
  private base = 0;
  /** Absolute frame index of "now". Advances once per control tick and never goes back. */
  now = 0;

  constructor(first: ArrayLike<number>) {
    this.frames = [copyFrame(first)];
  }

  get length() { return this.frames.length; }
  /** Frames left to play after the current one (0 = holding the last pose). */
  get remaining() { return Math.max(0, this.frames.length - 1 - (this.now - this.base)); }
  /** Absolute index of the last buffered frame. */
  get end() { return this.base + this.frames.length - 1; }

  /** Frame at absolute index `a` (before the buffer: its first frame; after it: its last). */
  at(a: number): Frame {
    const i = a - this.base;
    return this.frames[i <= 0 ? 0 : i >= this.frames.length ? this.frames.length - 1 : Math.floor(i)];
  }

  current(): Frame { return this.at(this.now); }

  /** Joint velocity (rad/s) of MuJoCo joint j at absolute frame a; zero while holding the last pose. */
  jointVel(a: number, j: number): number {
    if (a >= this.end) return 0;
    const f0 = this.at(a), f1 = this.at(a + 1);
    return (f1[7 + j] - f0[7 + j]) * REF_HZ;
  }

  advance() {
    this.now++;
    const behind = this.now - this.base;
    if (behind > KEEP_BEHIND * 2) {
      const drop = Math.min(behind - KEEP_BEHIND, this.frames.length - 1);
      if (drop > 0) { this.frames.splice(0, drop); this.base += drop; }
    }
  }

  /**
   * Moves every buffered frame by (dx, dy). The motion keeps its shape and its velocities; only
   * where it happens changes. Used to re-anchor a reference that drifted from the body.
   */
  translate(dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    for (const f of this.frames) { f[0] += dx; f[1] += dy; }
  }

  /** Replaces everything with these frames (50 Hz); frames[0] plays at absolute frame `at`. */
  replace(frames: Frame[], at: number = this.now) {
    if (!frames.length) return;
    fixQuatSigns(frames);
    this.frames = frames.map(copyFrame);
    this.base = at;
  }

  /**
   * Splices 50 Hz frames in so frames[0] plays at absolute frame `at`, crossfading from the old
   * motion over `blend` frames. Frames already in the past are dropped.
   */
  splice(frames: Frame[], at: number, blend = 8) {
    let p = at - this.base;
    if (p < 0) { frames = frames.slice(-p); p = 0; }
    if (!frames.length) return;
    // never rewrite what is playing right now
    const minP = this.now - this.base + 1;
    if (p < minP) { frames = frames.slice(minP - p); p = minP; }
    if (!frames.length) return;
    fixQuatSigns(frames, this.at(this.base + p));
    const next: Frame[] = this.frames.slice(0, Math.min(p, this.frames.length));
    while (next.length < p) next.push(copyFrame(this.frames[this.frames.length - 1]));
    for (let k = 0; k < frames.length; k++) {
      if (k < blend) {
        const old = this.frames[Math.min(p + k, this.frames.length - 1)];
        next.push(mixFrames(old, frames[k], (k + 1) / (blend + 1)));
      } else {
        next.push(copyFrame(frames[k]));
      }
    }
    this.frames = next;
  }
}

/** Extra forward pelvis tilt (rad); SONIC tracks the pelvis a few degrees short of the reference. */
export const FORWARD_LEAN = 0.06;
/** waistToHips stops adding pelvis tilt here (rad, 50 deg). */
export const MAX_PELVIS_TILT = 0.87;

/**
 * SONIC holds the G1's waist pitch nearly still, so a reference that leans forward at the waist
 * comes out leaned back. This moves `k` of the waist pitch into the pelvis: the pelvis tilts
 * forward by that angle and both hips fold by it, so the torso and legs keep their world pose.
 */
export function waistToHips(frames: Frame[], k = 1, extra = FORWARD_LEAN): Frame[] {
  const WAIST_PITCH = 7 + 14, HIP_L = 7 + 0, HIP_R = 7 + 6;
  for (const f of frames) {
    // never tip the pelvis past MAX_PELVIS_TILT this way: a motion already bent far over (a ground
    // slam) keeps its waist bend instead of becoming a near-horizontal pelvis SONIC can't hold
    const tilt0 = tiltOf([f[3], f[4], f[5], f[6]]);
    const th = Math.min(k * f[WAIST_PITCH] + extra, Math.max(0, MAX_PELVIS_TILT - tilt0));
    const s = Math.sin(th / 2), c = Math.cos(th / 2);
    // root quat * rotation about the pelvis' own y axis (positive = top forward)
    const w = f[3], x = f[4], y = f[5], z = f[6];
    f[3] = w * c - y * s; f[4] = x * c - z * s; f[5] = y * c + w * s; f[6] = z * c + x * s;
    f[WAIST_PITCH] -= th - extra; // the extra lean is a pelvis tilt the waist doesn't take back
    f[HIP_L] -= th; f[HIP_R] -= th;
  }
  return frames;
}

/** How snapArms exaggerates a move's fast arm motion (see there). */
export interface Snap { s: number; thr: number; sigma: number; gain: number; wrist: number }

/**
 * SONIC smooths fast arm moves: a spell's thrust comes out at about half the clip's hand speed.
 * This exaggerates the arms (shoulders and elbows, wrists by `wrist`) away from the move's first
 * pose by up to (s - 1) where the clip moves them fast (above `thr` of its top arm speed, weight
 * smoothed over `sigma` frames and scaled by `gain`), so the robot's strike comes out closer to the
 * clip's speed. Slow parts and the rest of the body are untouched; joints stay in [lo, hi].
 */
export function snapArms(frames: Frame[], k: Snap, lo: ArrayLike<number>, hi: ArrayLike<number>): Frame[] {
  const n = frames.length;
  if (!(k.s > 1) || n < 3) return frames;
  const sides = [[15, 16, 17, 18, 19, 20, 21], [22, 23, 24, 25, 26, 27, 28]]; // shoulder x3, elbow, wrist x3
  const orig = frames.map((f) => Float64Array.from(f));
  const speed = (js: number[]) => orig.map((_, i) => {
    const a = orig[Math.min(i, n - 2)], b = orig[Math.min(i + 1, n - 1)];
    let s = 0;
    for (const j of js.slice(0, 4)) { const d = (b[7 + j] - a[7 + j]) * REF_HZ; s += d * d; }
    return Math.sqrt(s);
  });
  const v = sides.map(speed), vmax = Math.max(...v[0], ...v[1]), thr = k.thr * vmax;
  if (!(vmax > thr)) return frames;
  sides.forEach((js, side) => {
    const w = smooth(v[side].map((x) => Math.max(0, Math.min(1, (x - thr) / (vmax - thr)))), k.sigma).map((x) => Math.min(1, x * k.gain));
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      js.forEach((j, m) => {
        const e = (k.s - 1) * w[i] * (m < 4 ? 1 : k.wrist);
        const q = orig[i][7 + j] + e * (orig[i][7 + j] - orig[0][7 + j]);
        frames[i][7 + j] = Math.min(hi[j], Math.max(lo[j], q));
      });
    }
  });
  return frames;
}

/** Gaussian smoothing (sigma in samples), renormalized at the ends. */
function smooth(x: number[], sigma: number): number[] {
  if (!(sigma > 0)) return x.slice();
  const R = Math.ceil(sigma * 3), ker: number[] = [];
  for (let d = -R; d <= R; d++) ker.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  return x.map((_, i) => {
    let s = 0, w = 0;
    for (let d = -R; d <= R; d++) { const j = i + d; if (j < 0 || j >= x.length) continue; s += x[j] * ker[d + R]; w += ker[d + R]; }
    return s / w;
  });
}

/** A frame that holds a pose: root at pos/quat, joints given (MuJoCo order). */
export function poseFrame(pos: ArrayLike<number>, quat: ArrayLike<number>, joints: ArrayLike<number>): Frame {
  const f = new Float64Array(36);
  f[0] = pos[0]; f[1] = pos[1]; f[2] = pos[2];
  f[3] = quat[0]; f[4] = quat[1]; f[5] = quat[2]; f[6] = quat[3];
  for (let j = 0; j < NJ; j++) f[7 + j] = joints[j];
  return f;
}
