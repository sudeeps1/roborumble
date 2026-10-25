// Where a fighter can be hit (hurt volumes) and what it hits with (strikers), sized from the G1's
// own meshes and joint positions. Strikers carry a velocity, measured every control tick.
import { dist3, pointSegment } from "./math.ts";
import type { RobotHandle, World } from "./world.ts";

export type Zone = "head" | "torso" | "legs";
export type Limb = "l_hand" | "r_hand" | "l_foot" | "r_foot" | "l_elbow" | "r_elbow" | "l_knee" | "r_knee" | "head";
export const LIMBS: Limb[] = ["l_hand", "r_hand", "l_foot", "r_foot", "l_elbow", "r_elbow", "l_knee", "r_knee", "head"];

/** A capsule (a sphere when a == b) fixed to a body, in that body's frame. */
export interface Volume { zone: Zone; name: string; body: number; a: number[]; b: number[]; r: number }
export interface Striker { limb: Limb; body: number; local: number[]; r: number }

export interface Contact { volume: Volume; gap: number; point: number[] }

/** Ticks of speed history kept per limb (0.16 s at 50 Hz). */
export const PEAK_TICKS = 8;

export class BodyMap {
  readonly hurt: Volume[] = [];
  /** Forearms: they stop a punch when the fighter is blocking, and are not a target otherwise. */
  readonly guard: Volume[] = [];
  readonly strikers = {} as Record<Limb, Striker>;
  private world: World;
  private pos = {} as Record<Limb, number[]>;
  private prev = {} as Record<Limb, number[]>;
  private vel = {} as Record<Limb, number[]>;
  private speeds = {} as Record<Limb, number[]>; // last PEAK_TICKS speeds, newest last
  private fresh = false;
  private wa = [0, 0, 0]; private wb = [0, 0, 0]; private cp = [0, 0, 0];

  constructor(world: World, robot: RobotHandle) {
    this.world = world;
    const B = (n: string) => robot.bodies.get(n)!;
    const torso = B("torso_link"), pelvis = B("pelvis");

    // head and torso from their meshes
    const headG = world.meshGeom(torso, "head_link"), torsoG = world.meshGeom(torso, "torso_link");
    const hb = headG >= 0 ? world.meshBounds(headG) : null;
    const headC = hb ? hb[0].map((v, k) => (v + hb[1][k]) / 2) : [0.01, 0, 0.43];
    const headR = hb ? Math.max(0.09, 0.42 * Math.max(hb[1][0] - hb[0][0], hb[1][1] - hb[0][1], hb[1][2] - hb[0][2])) : 0.11;
    this.hurt.push({ zone: "head", name: "head", body: torso, a: headC, b: headC, r: headR });
    const tb = torsoG >= 0 ? world.meshBounds(torsoG) : null;
    const tr = tb ? Math.max(0.09, 0.5 * Math.min(tb[1][0] - tb[0][0], tb[1][1] - tb[0][1])) : 0.11;
    const tz0 = tb ? tb[0][2] + tr * 0.6 : 0.06, tz1 = tb ? Math.min(tb[1][2], headC[2] - headR) - tr * 0.5 : 0.3;
    const tx = tb ? (tb[0][0] + tb[1][0]) / 2 : 0.01;
    this.hurt.push({ zone: "torso", name: "chest", body: torso, a: [tx, 0, tz0], b: [tx, 0, Math.max(tz0, tz1)], r: tr });
    const pg = world.meshGeom(pelvis, "pelvis");
    const pb = pg >= 0 ? world.meshBounds(pg) : null;
    const pc = pb ? pb[0].map((v, k) => (v + pb[1][k]) / 2) : [0, 0, -0.04];
    this.hurt.push({ zone: "torso", name: "pelvis", body: pelvis, a: pc, b: pc, r: 0.11 });

    // legs: thigh (hip -> knee) and shin (knee -> ankle), carried by the thigh and shin bodies
    for (const side of ["left", "right"] as const) {
      const thigh = B(`${side}_hip_yaw_link`), shin = B(`${side}_knee_link`);
      const hip = world.bodyPos(B(`${side}_hip_pitch_link`)), knee = world.bodyPos(shin), ankle = world.bodyPos(B(`${side}_ankle_pitch_link`));
      this.hurt.push({ zone: "legs", name: `${side} thigh`, body: thigh, a: world.toLocal(thigh, hip), b: world.toLocal(thigh, knee), r: 0.065 });
      this.hurt.push({ zone: "legs", name: `${side} shin`, body: shin, a: [0, 0, 0], b: world.toLocal(shin, ankle), r: 0.05 });
    }

    // strikers: fists from the rubber-hand meshes, feet from the foot contact spheres
    for (const [s, side] of [["l", "left"], ["r", "right"]] as const) {
      const wrist = B(`${side}_wrist_yaw_link`);
      const hg = world.meshGeom(wrist, `${side}_rubber_hand`);
      const hbx = hg >= 0 ? world.meshBounds(hg) : null;
      const fist = hbx ? hbx[0].map((v, k) => (v + hbx[1][k]) / 2) : [0.08, 0, 0];
      this.strikers[`${s}_hand`] = { limb: `${s}_hand`, body: wrist, local: fist, r: 0.055 };
      this.strikers[`${s}_foot`] = { limb: `${s}_foot`, body: B(`${side}_ankle_roll_link`), local: [0.035, 0, -0.015], r: 0.06 };
      this.strikers[`${s}_elbow`] = { limb: `${s}_elbow`, body: B(`${side}_elbow_link`), local: [0, 0, 0], r: 0.05 };
      this.strikers[`${s}_knee`] = { limb: `${s}_knee`, body: B(`${side}_knee_link`), local: [0.03, 0, 0], r: 0.06 };
      // forearm: elbow to fist, carried by the elbow link (the wrist joints barely move it)
      const elbow = B(`${side}_elbow_link`);
      this.guard.push({ zone: "torso", name: `${side} forearm`, body: elbow, a: [0, 0, 0], b: world.toLocal(elbow, world.pointOn(wrist, fist)), r: 0.05 });
    }
    this.strikers.head = { limb: "head", body: torso, local: headC, r: headR * 0.9 };
    for (const l of LIMBS) { this.pos[l] = [0, 0, 0]; this.prev[l] = [0, 0, 0]; this.vel[l] = [0, 0, 0]; this.speeds[l] = []; }
    this.update(0);
  }

  /** Call once per control tick (dt = tick length) after physics has moved. */
  update(dt: number) {
    for (const l of LIMBS) {
      const s = this.strikers[l], p = this.pos[l], q = this.prev[l], v = this.vel[l];
      q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
      this.world.pointOn(s.body, s.local, p);
      if (this.fresh && dt > 0) { v[0] = (p[0] - q[0]) / dt; v[1] = (p[1] - q[1]) / dt; v[2] = (p[2] - q[2]) / dt; }
      else { v[0] = v[1] = v[2] = 0; }
      const sp = this.speeds[l];
      if (!this.fresh || !(dt > 0)) sp.length = 0;
      sp.push(Math.hypot(v[0], v[1], v[2]));
      if (sp.length > PEAK_TICKS) sp.shift();
    }
    this.fresh = dt > 0;
  }

  /** After a teleport the last position is meaningless: don't read a huge velocity from it. */
  invalidate() { this.fresh = false; }

  limbPos(l: Limb): number[] { return this.pos[l]; }
  limbVel(l: Limb): number[] { return this.vel[l]; }
  /** Fastest the limb moved in the last PEAK_TICKS ticks: a strike's speed, even if it slowed at the end. */
  limbPeak(l: Limb): number { const sp = this.speeds[l]; let m = 0; for (const x of sp) if (x > m) m = x; return m; }

  /** World endpoints of a hurt volume. */
  segment(v: Volume, a: number[] = [0, 0, 0], b: number[] = [0, 0, 0]): [number[], number[]] {
    this.world.pointOn(v.body, v.a, a);
    this.world.pointOn(v.body, v.b, b);
    return [a, b];
  }

  /** The hurt volume a sphere (center c, radius r) overlaps most, or null. */
  touching(c: ArrayLike<number>, r: number): Contact | null {
    return this.closest(this.hurt, c, r, true);
  }

  /** The hurt volume nearest a sphere, touching or not (gap > 0 when apart). */
  nearest(c: ArrayLike<number>, r: number): Contact | null {
    return this.closest(this.hurt, c, r, false);
  }

  /** Smallest gap between a sphere and any hurt volume (m, negative when they overlap). */
  gapTo(c: ArrayLike<number>, r: number): number {
    let best = Infinity;
    for (const v of this.hurt) {
      this.segment(v, this.wa, this.wb);
      const d = pointSegment(c, this.wa, this.wb, this.cp) - v.r - r;
      if (d < best) best = d;
    }
    return best;
  }

  /** The forearm a sphere overlaps, or null. */
  touchingGuard(c: ArrayLike<number>, r: number): Contact | null {
    return this.closest(this.guard, c, r, true);
  }

  private closest(vols: Volume[], c: ArrayLike<number>, r: number, touchingOnly: boolean): Contact | null {
    let best: Contact | null = null;
    for (const v of vols) {
      this.segment(v, this.wa, this.wb);
      const d = pointSegment(c, this.wa, this.wb, this.cp) - v.r - r;
      if ((d < 0 || !touchingOnly) && (!best || d < best.gap)) best = { volume: v, gap: d, point: [this.cp[0], this.cp[1], this.cp[2]] };
    }
    return best;
  }

  /** Center of the head, world. */
  headPos(out: number[] = [0, 0, 0]): number[] {
    const h = this.hurt[0];
    return this.world.pointOn(h.body, h.a, out);
  }

  /** Distance between this body's head and a point (for the AI and range checks). */
  headDistance(p: ArrayLike<number>): number {
    return dist3(this.headPos(this.wa), p);
  }
}
