// Samples a Motion at any time into a full qpos (model order), re-based to the fighter's local frame:
// frame-0 root xy at the origin, frame-0 heading turned to +X, root travel clipped (CLAUDE.md "Physics").
import type { Motion } from "../../contract";
import type { Kinematics } from "../../g1/fk";
import { ROOT_TRAVEL_MAX } from "./rules";

export class ClipSampler {
  readonly motion: Motion;
  readonly fps: number;
  readonly frames: number;
  /** Seconds from the first to the last frame (at least 0.5 s, so a one-frame motion still holds a pose). */
  readonly dur: number;
  private readonly map: (frame: number[], out?: number[]) => number[];
  private readonly a: number[];
  private readonly b: number[];
  private readonly x0: number;
  private readonly y0: number;
  private readonly hc: number; // cos/sin of minus the frame-0 heading
  private readonly hs: number;
  private readonly hq: [number, number, number, number]; // quaternion of minus the frame-0 heading
  private readonly free: number;

  constructor(kin: Kinematics, motion: Motion, fallback: number[]) {
    this.motion = motion;
    this.fps = motion.fps > 0 ? motion.fps : 30;
    this.frames = motion.qpos.length;
    this.dur = Math.max(0.5, (this.frames - 1) / this.fps);
    this.map = kin.motionMapper(motion, fallback);
    this.a = fallback.slice();
    this.b = fallback.slice();
    this.free = kin.model.joints.find((j) => j.type === "free")?.qposAdr ?? 0;
    const r0 = motion.qpos[0];
    this.x0 = r0[0] ?? 0;
    this.y0 = r0[1] ?? 0;
    // heading of the frame-0 root quat (its local +X in the XY plane)
    const [w, x, y, z] = [r0[3] ?? 1, r0[4] ?? 0, r0[5] ?? 0, r0[6] ?? 0];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    this.hc = Math.cos(-yaw);
    this.hs = Math.sin(-yaw);
    this.hq = [Math.cos(-yaw / 2), 0, 0, Math.sin(-yaw / 2)];
  }

  /** Full local qpos at time t (seconds). loop wraps (idle), otherwise holds the last frame. */
  sample(t: number, loop: boolean, out: number[]) {
    const n = this.frames;
    let f = t * this.fps;
    if (loop) f = ((f % n) + n) % n;
    else f = Math.min(n - 1, Math.max(0, f));
    const i0 = Math.floor(f);
    const i1 = loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
    const u = f - i0;
    this.map(this.motion.qpos[i0], this.a);
    this.map(this.motion.qpos[i1], this.b);
    this.rebase(this.a);
    this.rebase(this.b);
    const r = this.free;
    for (let i = 0; i < out.length; i++) out[i] = this.a[i] + (this.b[i] - this.a[i]) * u;
    // root quat: normalized lerp along the short way (frames are close together)
    const d = this.a[r + 3] * this.b[r + 3] + this.a[r + 4] * this.b[r + 4] + this.a[r + 5] * this.b[r + 5] + this.a[r + 6] * this.b[r + 6];
    const s = d < 0 ? -1 : 1;
    let len = 0;
    for (let k = 3; k < 7; k++) {
      out[r + k] = this.a[r + k] + (s * this.b[r + k] - this.a[r + k]) * u;
      len += out[r + k] * out[r + k];
    }
    len = Math.sqrt(len) || 1;
    for (let k = 3; k < 7; k++) out[r + k] /= len;
  }

  /** Forward root travel (local +X, after clipping) at time t: how far the motion itself lunges. */
  travelAt(t: number): number {
    const row = this.motion.qpos[Math.min(this.frames - 1, Math.max(0, Math.round(t * this.fps)))];
    const dx = (row[0] ?? 0) - this.x0, dy = (row[1] ?? 0) - this.y0;
    let lx = this.hc * dx - this.hs * dy, ly = this.hs * dx + this.hc * dy;
    const m = Math.hypot(lx, ly);
    if (m > ROOT_TRAVEL_MAX) { lx *= ROOT_TRAVEL_MAX / m; ly *= ROOT_TRAVEL_MAX / m; }
    return lx;
  }

  private rebase(q: number[]) {
    const r = this.free;
    const dx = q[r] - this.x0, dy = q[r + 1] - this.y0;
    let lx = this.hc * dx - this.hs * dy, ly = this.hs * dx + this.hc * dy;
    const m = Math.hypot(lx, ly);
    if (m > ROOT_TRAVEL_MAX) { lx *= ROOT_TRAVEL_MAX / m; ly *= ROOT_TRAVEL_MAX / m; }
    q[r] = lx;
    q[r + 1] = ly;
    // q_root = heading^-1 * q_root
    const [hw, , , hz] = this.hq;
    const w = q[r + 3], x = q[r + 4], y = q[r + 5], z = q[r + 6];
    q[r + 3] = hw * w - hz * z;
    q[r + 4] = hw * x - hz * y;
    q[r + 5] = hw * y + hz * x;
    q[r + 6] = hw * z + hz * w;
  }
}
