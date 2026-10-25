// Procedural G1 motions in the server's Motion format (CLAUDE.md "Motion format"), standing in for Kimodo.
// Keyframed joint angles with easing (motions/clips.ts), leg IK for planted feet, every frame grounded
// (motions/rig.ts). Rows: root pos, root quat (w, x, y, z), joint angles in joint_names order; 30 fps.
import type { Motion } from "../contract";
import type { MjModel } from "../g1/mjcf";
import { Rig, bake, fastestFrame } from "./motions/rig";
import { clips, guard } from "./motions/clips";

/** Every mock motion id, with the joint that strikes (null = no strike). The fake move library maps onto these. */
export const MOTION_HIT_JOINT = {
  mo_jab: "l_hand",
  mo_cross: "r_hand",
  mo_uppercut: "r_hand",
  mo_hook: "l_hand",
  mo_front_kick: "r_foot",
  mo_round_kick: "r_foot",
  mo_knee: "r_foot",
  mo_palm_thrust: "r_hand",   // projectile cast (both palms)
  mo_throw: "r_hand",         // projectile cast (one hand)
  mo_overhead_slam: "r_hand", // strike cast
  mo_summon: "r_hand",        // strike cast (arms raised)
  mo_stomp: "r_foot",         // shockwave
  mo_spin: "l_hand",          // shockwave
  mo_block: null,             // defend
  mo_crouch: null,            // defend (duck)
  mo_crab: "r_hand",          // silly live wildcard dance
} as const satisfies Record<string, string | null>;
export type MotionId = keyof typeof MOTION_HIT_JOINT;

export interface MockMotions {
  idle: Motion;                     // id "mo_idle", seamless loop
  byId: Map<string, Motion>;        // includes idle and every MotionId
  hitFrame: Map<string, number>;    // frame where the hit joint moves fastest (0 for no-strike motions)
}

/** CLAUDE.md hit_joint -> the G1 body tracked for hit_frame. */
export const HIT_BODY: Record<string, string> = {
  r_hand: "right_wrist_yaw_link", l_hand: "left_wrist_yaw_link",
  r_foot: "right_ankle_roll_link", l_foot: "left_ankle_roll_link",
  head: "torso_link", chest: "torso_link",
};

export function makeMotions(model: MjModel): MockMotions {
  const rig = new Rig(model);
  const base = guard(rig);
  const byId = new Map<string, Motion>();
  const hitFrame = new Map<string, number>();
  for (const clip of clips(rig, base)) {
    const { motion, frames } = bake(rig, clip, base);
    const joint = (MOTION_HIT_JOINT as Record<string, string | null>)[clip.id] ?? null;
    byId.set(clip.id, motion);
    hitFrame.set(clip.id, joint ? fastestFrame(rig, frames, rig.body(HIT_BODY[joint])) : 0);
  }
  // Every id must exist: anything without a clip holds the guard for a second.
  for (const id of ["mo_idle", ...Object.keys(MOTION_HIT_JOINT)]) {
    if (byId.has(id)) continue;
    byId.set(id, bake(rig, { id, keys: [{ t: 0 }, { t: 1 }] }, base).motion);
    hitFrame.set(id, 0);
  }
  return { idle: byId.get("mo_idle")!, byId, hitFrame };
}
