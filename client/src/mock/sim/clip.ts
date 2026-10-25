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
  private readonly c: number[];
  private readonly d: number[];
  /** Frames of the crossfade that hides a looped clip's seam; 0 when the clip already loops cleanly. */
  private readonly seam: number;
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
    this.c = fallback.slice();
    this.d = fallback.slice();
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
    // Kimodo idles don't loop: the last frame is somewhere else than the first, and wrapping straight from one
    // to the other makes an idle fighter twitch every few seconds. Crossfade over ~0.4 s unless it already loops.
    const last = motion.qpos[this.frames - 1] ?? r0;
    let gap = Math.hypot((last[0] ?? 0) - this.x0, (last[1] ?? 0) - this.y0) / 0.02; // 2 cm of root drift = 1
    for (let i = 7; i < Math.min(r0.length, last.length); i++) gap = Math.max(gap, Math.abs(last[i] - r0[i]) / 0.05); // ~3 deg
    this.seam = this.frames >= 8 && gap > 1 ? Math.min(Math.round(0.4 * this.fps), Math.floor((this.frames - 1) / 3)) : 0;
  }

  /** Full local qpos at time t (seconds). loop wraps (idle, seam crossfaded), otherwise holds the last frame. */
  sample(t: number, loop: boolean, out: number[]) {
    const n = this.frames, nb = this.seam;
    let f = t * this.fps;
    if (!loop || !nb) return this.at(loop ? ((f % n) + n) % n : Math.min(n - 1, Math.max(0, f)), loop, out);
    // Play frames [0, L) where L = n - 1 - nb; over the first nb frames, fade from the clip's tail (f + L) into its
    // head (f). Continuous at the wrap (f -> L is the tail's start) and where the fade ends (f = nb is the head).
    const L = n - 1 - nb;
    f = ((f % L) + L) % L;
    if (f >= nb) return this.at(f, false, out);
    this.at(f + L, false, this.c);
    this.at(f, false, this.d);
    const u = f / nb, w = u * u * (3 - 2 * u);
    const r = this.free;
    for (let i = 0; i < out.length; i++) out[i] = this.c[i] + (this.d[i] - this.c[i]) * w;
    const s = this.c[r + 3] * this.d[r + 3] + this.c[r + 4] * this.d[r + 4] + this.c[r + 5] * this.d[r + 5] + this.c[r + 6] * this.d[r + 6] < 0 ? -1 : 1;
    let len = 0;
    for (let k = 3; k < 7; k++) {
      out[r + k] = this.c[r + k] + (s * this.d[r + k] - this.c[r + k]) * w;
      len += out[r + k] * out[r + k];
    }
    len = Math.sqrt(len) || 1;
    for (let k = 3; k < 7; k++) out[r + k] /= len;
  }

  /** qpos at fractional frame f (already wrapped or clamped). */
  private at(f: number, loop: boolean, out: number[]) {
    const n = this.frames;
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
