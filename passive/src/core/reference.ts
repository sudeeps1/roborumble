// The motion a robot is trying to follow: frames of 36-value qpos (root pos, root quat w x y z,
// 29 joints in MuJoCo order) at 50 Hz, the SONIC control rate. New motion is spliced in with
// a short crossfade, the way SONIC's deploy stack blends planner outputs.
import { NJ } from "./g1.ts";
import { slerp } from "./math.ts";

export const REF_HZ = 50;
const KEEP_BEHIND = 25; // frames kept before the cursor

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

export class Reference {
  private frames: Frame[];
  /** Index of the frame the robot should be at right now. */
  cursor = 0;

  constructor(first: ArrayLike<number>) {
    this.frames = [copyFrame(first)];
  }

  get length() { return this.frames.length; }
  /** Frames left to play after the current one (0 = holding the last pose). */
  get remaining() { return this.frames.length - 1 - this.cursor; }

  frame(i: number): Frame {
    return this.frames[Math.max(0, Math.min(i, this.frames.length - 1))];
  }

  current(): Frame { return this.frame(this.cursor); }

  /** Joint velocity (rad/s) of MuJoCo joint j at frame i; zero while holding the final pose. */
  jointVel(i: number, j: number): number {
    if (i >= this.frames.length - 1) return 0;
    const a = this.frame(i), b = this.frame(i + 1);
    return (b[7 + j] - a[7 + j]) * REF_HZ;
  }

  advance() {
    if (this.cursor < this.frames.length - 1) this.cursor++;
    if (this.cursor > KEEP_BEHIND * 2) {
      const drop = this.cursor - KEEP_BEHIND;
      this.frames.splice(0, drop);
      this.cursor -= drop;
    }
  }

  /** Replaces everything with these frames (50 Hz), starting at the first one. */
  replace(frames: Frame[]) {
    if (!frames.length) return;
    fixQuatSigns(frames);
    this.frames = frames.map(copyFrame);
    this.cursor = 0;
  }

  /**
   * Splices new 50 Hz frames in so that frames[0] lands `delay` frames after the cursor,
   * crossfading from the old motion over `blend` frames.
   */
  splice(frames: Frame[], delay = 0, blend = 8) {
    if (!frames.length) return;
    const start = this.cursor + delay;
    fixQuatSigns(frames, this.frame(start));
    const next: Frame[] = this.frames.slice(0, Math.min(start, this.frames.length));
    while (next.length < start) next.push(copyFrame(this.frame(next.length)));
    for (let k = 0; k < frames.length; k++) {
      const oldIdx = start + k;
      if (k < blend && oldIdx < this.frames.length) {
        next.push(mixFrames(this.frames[oldIdx], frames[k], (k + 1) / (blend + 1)));
      } else if (k < blend) {
        next.push(mixFrames(this.frame(oldIdx), frames[k], (k + 1) / (blend + 1)));
      } else {
        next.push(copyFrame(frames[k]));
      }
    }
    this.frames = next;
  }

  /** The last `n` frames sampled at `hz` ending at the cursor (planner context). */
  history(n: number, hz: number): Frame[] {
    const out: Frame[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const s = this.cursor - (k * REF_HZ) / hz;
      const i0 = Math.floor(s);
      out.push(mixFrames(this.frame(i0), this.frame(i0 + 1), s - i0));
    }
    return out;
  }
}

/** Extra forward pelvis tilt (rad); SONIC tracks the pelvis a few degrees short of the reference. */
export const FORWARD_LEAN = 0.06;

/**
 * SONIC holds the G1's waist pitch nearly still, so a reference that leans forward at the waist
 * comes out leaned back. This moves `k` of the waist pitch into the pelvis: the pelvis tilts
 * forward by that angle and both hips fold by it, so the torso and legs keep their world pose.
 */
export function waistToHips(frames: Frame[], k = 1, extra = FORWARD_LEAN): Frame[] {
  const WAIST_PITCH = 7 + 14, HIP_L = 7 + 0, HIP_R = 7 + 6;
  for (const f of frames) {
    const th = k * f[WAIST_PITCH] + extra;
    const s = Math.sin(th / 2), c = Math.cos(th / 2);
    // root quat * rotation about the pelvis' own y axis (positive = top forward)
    const w = f[3], x = f[4], y = f[5], z = f[6];
    f[3] = w * c - y * s; f[4] = x * c - z * s; f[5] = y * c + w * s; f[6] = z * c + x * s;
    f[WAIST_PITCH] -= th - extra; // the extra lean is a pelvis tilt the waist doesn't take back
    f[HIP_L] -= th; f[HIP_R] -= th;
  }
  return frames;
}

/** A frame that holds a pose: root at pos/quat, joints given (MuJoCo order). */
export function poseFrame(pos: ArrayLike<number>, quat: ArrayLike<number>, joints: ArrayLike<number>): Frame {
  const f = new Float64Array(36);
  f[0] = pos[0]; f[1] = pos[1]; f[2] = pos[2];
  f[3] = quat[0]; f[4] = quat[1]; f[5] = quat[2]; f[6] = quat[3];
  for (let j = 0; j < NJ; j++) f[7 + j] = joints[j];
  return f;
}
