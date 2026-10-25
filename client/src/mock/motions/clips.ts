// The mock motion clips: a fighting-stance idle loop and the moves, all starting and ending in the guard.
// Robot at the origin facing +X; the opponent stands about 0.6-0.7 m ahead (head ~1.2 m, chest ~1.0 m).
// Palm/ankle targets are world points (meters); joint values in `pose` set the style IK starts from.
import type { Vec3 } from "../../contract";
import { FPS, type Clip, type Foot, type Key, type Pose, type Rig, type Root } from "./rig";

// ---------- the guard: lead left foot, hands up in front of the chin ----------
const ROOT: Root = { x: 0, y: 0, z: 0.745, yaw: 0, pitch: 0, roll: 0 };
const LF: Foot = { x: 0.11, y: 0.115, yaw: -0.1 };
const RF: Foot = { x: -0.13, y: -0.12, yaw: -0.45 };
const GUARD_POSE: Pose = {
  wy: -0.3, wr: 0, wp: 0.1,
  lsp: -0.5, lsr: 0.1, lsy: 0, le: -0.8, lwr: 0, lwp: 0.35, lwy: 0,
  rsp: -0.5, rsr: -0.1, rsy: 0.4, re: -0.8, rwr: 0, rwp: 0.35, rwy: 0,
};
const L_GUARD: Vec3 = [0.29, 0.05, 1.12];
const R_GUARD: Vec3 = [0.22, -0.07, 1.09];

export interface Base { q: number[]; root: Root; lf: Foot | null; rf: Foot | null; }

/** The guard as a full qpos (feet planted, palms by the chin). Every clip starts and ends here. */
export function guard(rig: Rig): Base {
  const q = rig.qpos(ROOT, new Array(rig.model.nq).fill(0), GUARD_POSE);
  rig.plant(q, "l", LF);
  rig.plant(q, "r", RF);
  rig.reach(q, "l", L_GUARD);
  rig.reach(q, "r", R_GUARD);
  return { q, root: { ...ROOT }, lf: LF, rf: RF };
}

const TAU = Math.PI * 2;
const F = (n: number) => n / FPS; // frame-aligned key times

/** The same foot turned to `yaw` on the ball of the foot: the toes stay put while the heel lifts and swings. */
function onBall(f: Foot, yaw: number, heel: number): Foot {
  const toe = 0.12, y0 = f.yaw ?? 0;
  return { x: f.x + toe * (Math.cos(y0) - Math.cos(yaw)), y: f.y + toe * (Math.sin(y0) - Math.sin(yaw)), yaw, heel };
}

export function clips(rig: Rig, g: Base): Clip[] {
  /** Back to the exact guard. */
  const back = (t: number, extra: Partial<Key> = {}): Key => ({ t, q: g.q, root: { ...ROOT }, lf: LF, rf: RF, ...extra });
  const adr = (k: keyof Pose) => rig.adr(k);

  // Seamless 2 s loop: two breathing bobs, one side-to-side weight shift, hands bob a beat behind.
  // Every term is 0 at t = 0, so frame 0 is exactly the guard the moves start and end in.
  const wave = (w: number, lag: number) => Math.sin(w - lag) + Math.sin(lag);
  const idle: Clip = {
    id: "mo_idle",
    loop: true,
    keys: [{ t: 0 }, { t: 2, ease: "linear" }],
    mod: (t, s) => {
      const w = (TAU * t) / 2;
      const breath = 0.5 - 0.5 * Math.cos(2 * w);
      s.root.z -= 0.016 * breath;
      s.root.y += 0.016 * Math.sin(w);
      s.root.x += 0.006 * Math.sin(2 * w);
      s.q[adr("wp")] += 0.03 * breath;
      s.q[adr("wy")] += 0.05 * Math.sin(w);
      s.q[adr("wr")] -= 0.03 * Math.sin(w);
      s.q[adr("lsp")] += 0.05 * wave(2 * w, 0.6);
      s.q[adr("rsp")] += 0.05 * wave(2 * w, 0.9);
      s.q[adr("le")] -= 0.06 * wave(2 * w, 0.6);
      s.q[adr("re")] -= 0.06 * wave(2 * w, 0.9);
    },
  };

  // Lead-hand jab: tiny load, snap the left arm straight at the face, recover.
  const jab: Clip = {
    id: "mo_jab",
    keys: [
      { t: F(3), pose: { wy: -0.36, wp: 0.12 }, root: { z: 0.735 } },
      { t: F(7), ease: "in", pose: { wy: -0.62, wp: 0.22, lwp: 0 }, root: { x: 0.05, z: 0.73 }, lh: [0.6, 0.02, 1.16] },
      { t: F(9), ease: "linear" },
      back(0.8),
    ],
  };

  // Rear-hand cross: load the hips, rotate through, rear heel turns up, right arm straight to the face.
  const cross: Clip = {
    id: "mo_cross",
    keys: [
      { t: F(4), pose: { wy: -0.42, wp: 0.12 }, root: { x: -0.02, z: 0.735 } },
      { t: F(9), ease: "in", pose: { wy: 0.45, wp: 0.22, rwp: 0, rsy: 0 }, root: { x: 0.07, z: 0.725 }, rf: onBall(RF, -0.15, 0.35), rh: [0.6, -0.01, 1.15] },
      { t: F(12), ease: "linear" },
      back(0.9),
    ],
  };

  // Right uppercut: dip and drop the fist, drive up through the legs, fist rises to the chin.
  const uppercut: Clip = {
    id: "mo_uppercut",
    keys: [
      { t: F(6), pose: { wy: -0.5, wr: 0.15, wp: 0.2, rsp: 0, rsr: -0.15, rsy: 0, re: 0, rwp: 0 }, root: { z: 0.69 }, rh: [0.2, -0.12, 0.84] },
      { t: F(11), ease: "in", pose: { wy: 0.35, wr: -0.05, wp: -0.05, rsp: -1.2, rsr: -0.1, re: 0 }, root: { x: 0.05, z: 0.75 }, rf: onBall(RF, -0.2, 0.3), rh: [0.48, -0.02, 1.2] },
      { t: F(14), ease: "linear" },
      back(1.0),
    ],
  };

  // Left hook: elbow comes up and out, hips snap right, the fist sweeps across at head height.
  const hook: Clip = {
    id: "mo_hook",
    keys: [
      { t: F(5), pose: { wy: -0.05, wp: 0.12, lsp: -0.6, lsr: 1.2, lsy: 0, le: 0, lwp: 0 }, root: { z: 0.73 }, lh: [0.15, 0.32, 1.12] },
      { t: F(10), ease: "in3", pose: { wy: -0.75, wp: 0.2, lsp: -1.4, lsr: 0.6, lsy: -0.8, le: 0 }, root: { x: 0.04, z: 0.725 }, lf: onBall(LF, -0.4, 0.2), lh: [0.56, -0.01, 1.17] },
      { t: F(13), ease: "linear" },
      back(1.0),
    ],
  };

  // Right front kick: chamber the knee, snap the leg out to the stomach, re-chamber, step back down.
  const frontKick: Clip = {
    id: "mo_front_kick",
    keys: [
      { t: F(4), rf: { ...RF, z: 0.06 }, pose: { wy: -0.2 }, root: { x: 0.03, y: 0.04, z: 0.74 } },
      { t: F(8), rf: null, pose: { rhp: -1.6, rhr: -0.05, rhy: 0, rk: 1.9, rap: 0.2, rar: 0, wy: -0.1, wp: -0.05 }, root: { x: 0.06, y: 0.07, z: 0.735 } },
      { t: F(12), ease: "in", pose: { rhp: -1.8, rk: 0.1, rap: -0.3, wp: -0.12 }, root: { x: 0.04, pitch: -0.1 }, rkick: [0.66, -0.05, 0.82] },
      { t: F(14), ease: "linear" },
      { t: F(19), pose: { rhp: -1.5, rk: 1.8, rap: 0.2, wp: 0 }, root: { pitch: 0 } },
      { t: F(24), rf: { ...RF, z: 0.06 }, root: { x: 0.02, y: 0.02, z: 0.74 } },
      { t: F(27), rf: RF, root: { x: 0, y: 0, z: 0.745 } },
      back(1.1),
    ],
  };

  // Right roundhouse: pivot on the left foot, hips turn over, the shin whips around into the ribs.
  const roundKick: Clip = {
    id: "mo_round_kick",
    keys: [
      { t: F(4), rf: { ...RF, z: 0.06 }, lf: { ...LF, yaw: LF.yaw! + 0.2 }, root: { x: 0.02, y: 0.04, yaw: 0.2 } },
      { t: F(9), rf: null, lf: { ...LF, yaw: LF.yaw! + 0.85 }, pose: { rhp: -1.3, rhr: -0.8, rhy: 0, rk: 2.1, rap: 0.3, rar: 0, wy: 0, rsp: 0.4, rsr: -0.4, re: 0.6 }, root: { x: 0.05, y: 0.1, z: 0.74, yaw: 0.85 } },
      { t: F(14), ease: "in", lf: { ...LF, yaw: LF.yaw! + 1.7 }, pose: { rhp: 0, rhr: -1.85, rk: 0.45, rap: 0.4, wr: 0.15, rsp: 0.6, rsr: -0.5, re: 1.0 }, root: { x: 0.05, y: 0.12, yaw: 1.7, roll: -0.3 }, rkick: [0.64, -0.03, 0.88] },
      { t: F(16), ease: "linear" },
      // snap the shin back while the hip is still up, then bring the folded leg down
      { t: F(19), lf: { ...LF, yaw: LF.yaw! + 1.4 }, pose: { rhp: -0.4, rhr: -1.5, rk: 2.0 }, root: { yaw: 1.4, roll: -0.2 } },
      { t: F(23), lf: { ...LF, yaw: LF.yaw! + 0.6 }, pose: { rhp: -0.9, rhr: -0.45, rk: 1.7, wr: 0 }, root: { x: 0.04, y: 0.08, yaw: 0.6, roll: 0 } },
      { t: F(26), rf: { ...RF, z: 0.06 }, lf: { ...LF, yaw: LF.yaw! + 0.15 }, root: { x: 0.02, y: 0.03, yaw: 0.15 } },
      { t: F(29), rf: RF, lf: LF, root: { x: 0, y: 0, z: 0.745, yaw: 0 } },
      back(1.3),
    ],
  };

  // Right knee: grab the head with both hands, drive the knee up into the stomach, pull down.
  const knee: Clip = {
    id: "mo_knee",
    keys: [
      { t: F(5), pose: { wy: -0.1, wp: 0.15, lwp: 0, rwp: 0, rsy: 0 }, root: { x: 0.03, z: 0.735 }, lh: [0.42, 0.08, 1.15], rh: [0.42, -0.06, 1.15] },
      { t: F(7), rf: { ...RF, z: 0.06 }, root: { x: 0.05, y: 0.03 } },
      { t: F(11), ease: "in", rf: null, pose: { rhp: -1.7, rhr: 0.05, rhy: 0, rk: 2.1, rap: 0.4, rar: 0, wp: -0.05 }, root: { x: 0.1, y: 0.06, z: 0.75, pitch: -0.08 }, lh: [0.32, 0.06, 0.95], rh: [0.32, -0.06, 0.95] },
      { t: F(14), ease: "linear" },
      { t: F(20), rf: { ...RF, z: 0.06 }, root: { x: 0.03, y: 0.02, z: 0.745, pitch: 0 } },
      { t: F(23), rf: RF, root: { x: 0, y: 0 } },
      back(1.0),
    ],
  };

  // Two-palm thrust (projectile cast): gather both hands low at the sides, then shove both palms out.
  const palmThrust: Clip = {
    id: "mo_palm_thrust",
    keys: [
      { t: F(9), pose: { wy: -0.5, wp: 0.0, lsp: 0.2, lsr: 0.4, lsy: 0, le: 0.6, lwp: -0.6, rsp: 0.2, rsr: -0.4, rsy: 0, re: 0.6, rwp: -0.6 }, root: { z: 0.7 }, lh: [0.08, 0.2, 0.8], rh: [0.0, -0.22, 0.8] },
      { t: F(14), ease: "in", pose: { wy: 0, wp: 0.2, lsp: -1.5, lsr: 0.1, le: 1.2, lwp: -1.0, rsp: -1.5, rsr: -0.1, re: 1.2, rwp: -1.0 }, root: { x: 0.06, z: 0.72 }, lh: [0.53, 0.07, 1.02], rh: [0.53, -0.07, 1.02] },
      { t: F(22), ease: "linear" },
      back(1.2),
    ],
  };

  // One-hand throw (projectile cast): cock the right hand back high, whip it over the shoulder, follow through.
  const toss: Clip = {
    id: "mo_throw",
    keys: [
      { t: F(10), pose: { wy: -0.8, wp: -0.1, wr: 0.1, rsp: -0.6, rsr: -1.4, rsy: 0, re: 0, rwp: 0, lsp: -1.4, lsr: 0.2, le: 1.3, lwp: 0 }, root: { x: -0.04, z: 0.735 }, rh: [-0.15, -0.28, 1.28], lh: [0.4, 0.15, 1.15] },
      { t: F(15), ease: "in", pose: { wy: 0.5, wp: 0.3, wr: -0.05, rsp: -1.8, rsr: -0.2, re: 1.2, lsp: 0.2, lsr: 0.3, le: 0.8 }, root: { x: 0.07, z: 0.72 }, rf: onBall(RF, -0.2, 0.4), rh: [0.45, -0.05, 1.18], lh: [0.02, 0.3, 0.85] },
      { t: F(19), ease: "out", pose: { wy: 0.6, wp: 0.35 }, rh: [0.38, 0.12, 0.85] },
      back(1.1),
    ],
  };

  // Two-hand overhead slam (strike cast): rise up with the hands joined overhead, slam them down in front.
  const slam: Clip = {
    id: "mo_overhead_slam",
    keys: [
      { t: F(12), pose: { wy: 0, wp: -0.15, lsp: -2.8, lsr: 0.2, lsy: 0, le: 1.2, lwp: 0, rsp: -2.8, rsr: -0.2, rsy: 0, re: 1.2, rwp: 0 }, root: { z: 0.76 }, lh: [0.05, 0.03, 1.48], rh: [0.05, -0.03, 1.48] },
      { t: F(18), ease: "in3", pose: { wp: 0.5, lsp: -1.0, rsp: -1.0, le: 1.4, re: 1.4 }, root: { x: 0.05, z: 0.65, pitch: 0.2 }, rf: { ...RF, heel: 0.5 }, lh: [0.5, 0.03, 0.62], rh: [0.5, -0.03, 0.62] },
      { t: F(24), ease: "linear" },
      back(1.3),
    ],
  };

  // Summon (strike cast): arms rise slowly out to the sky, hold, then sweep down hard.
  const summon: Clip = {
    id: "mo_summon",
    keys: [
      { t: F(12), pose: { wy: 0, wp: -0.2, lsp: -2.4, lsr: 0.6, lsy: 0, le: 1.5, lwp: 0, rsp: -2.4, rsr: -0.6, rsy: 0, re: 1.5, rwp: 0 }, root: { z: 0.77 }, lh: [0.12, 0.19, 1.51], rh: [0.12, -0.19, 1.51] },
      { t: F(18), ease: "out", pose: { wp: -0.25 }, lh: [0.1, 0.2, 1.52], rh: [0.1, -0.2, 1.52] },
      { t: F(24), ease: "in", pose: { wp: 0.35, lsp: -0.6, lsr: 0.5, rsp: -0.6, rsr: -0.5 }, root: { x: 0.04, z: 0.68 }, lh: [0.4, 0.33, 0.66], rh: [0.4, -0.33, 0.66] },
      { t: F(30), ease: "linear" },
      back(1.4),
    ],
  };

  // Stomp (shockwave): lift the right knee high with the fists up, slam the foot down into a squat.
  const stomp: Clip = {
    id: "mo_stomp",
    keys: [
      { t: F(4), rf: { ...RF, z: 0.06 }, root: { x: 0.04, y: 0.05 } },
      { t: F(11), rf: null, pose: { rhp: -1.3, rhr: -0.15, rhy: 0, rk: 1.7, rap: 0.1, rar: 0, wy: 0, wp: 0, lsp: -0.8, lsr: 0.9, le: 0, rsp: -0.8, rsr: -0.9, re: 0, rsy: 0 }, root: { x: 0.06, y: 0.07, z: 0.75 }, lh: [0.2, 0.3, 1.2], rh: [0.2, -0.3, 1.2] },
      { t: F(14), ease: "out", root: { z: 0.755 } },
      { t: F(17), ease: "in3", rf: { x: -0.02, y: -0.16, yaw: -0.3 }, pose: { wp: 0.25, lsp: -0.4, lsr: 0.5, rsp: -0.4, rsr: -0.5 }, root: { x: 0.0, y: -0.01, z: 0.68 }, lh: [0.25, 0.25, 0.75], rh: [0.2, -0.27, 0.75] },
      { t: F(23), ease: "linear" },
      back(1.1),
    ],
  };

  // Spin (shockwave): arms out, pelvis over the left foot, one full turn on it, land back in the guard.
  const PIVOT: Foot = { x: LF.x, y: LF.y, yaw: LF.yaw };
  const ARMS_OUT: Pose = { lsp: 0, lsr: 1.45, lsy: 0, le: 1.4, lwp: 0, rsp: 0, rsr: -1.45, rsy: 0, re: 1.4, rwp: 0, wy: 0, wp: 0, wr: 0 };
  const spin: Clip = {
    id: "mo_spin",
    keys: [
      { t: F(3), rf: { ...RF, z: 0.06 }, root: { x: 0.04, y: 0.04 } },
      { t: F(7), rf: null, lf: PIVOT, pose: { ...ARMS_OUT, rhp: -0.6, rhr: 0.1, rhy: 0, rk: 1.6, rap: 0.2, rar: 0 }, root: { x: LF.x, y: LF.y, z: 0.735 } },
      { t: F(25), ease: "inOut", lf: { ...PIVOT, yaw: PIVOT.yaw! + TAU }, root: { yaw: TAU } },
      { t: F(30), rf: { ...RF, yaw: RF.yaw! + TAU, z: 0.06 }, lf: { ...LF, yaw: LF.yaw! + TAU }, pose: { lsp: -0.4, lsr: 0.7, le: 0.4, rsp: -0.4, rsr: -0.7, re: 0.4, wy: -0.15 }, root: { x: 0.04, y: 0.04, z: 0.74 } },
      { t: F(33), rf: { ...RF, yaw: RF.yaw! + TAU }, root: { x: 0, y: 0, z: 0.745 } },
      back(1.3, { root: { ...ROOT, yaw: TAU }, lf: { ...LF, yaw: LF.yaw! + TAU }, rf: { ...RF, yaw: RF.yaw! + TAU } }),
    ],
  };

  // Block (defend): forearms snap up crossed in front of the face, brace, then relax back.
  const block: Clip = {
    id: "mo_block",
    keys: [
      { t: F(4), ease: "out", pose: { wy: -0.1, wp: 0.2, lsp: -1.2, lsr: -0.2, lsy: -0.6, le: -0.4, lwp: 0, rsp: -1.2, rsr: 0.2, rsy: 0.6, re: -0.4, rwp: 0 }, root: { x: -0.02, z: 0.725 }, lh: [0.24, -0.06, 1.24], rh: [0.24, 0.06, 1.2] },
      { t: F(8), ease: "out", root: { x: -0.035, z: 0.72 } },
      { t: F(20), ease: "linear", root: { x: -0.03 } },
      back(0.9),
    ],
  };

  // Crouch (defend): duck under with the guard kept up, then come back up.
  const crouch: Clip = {
    id: "mo_crouch",
    keys: [
      { t: F(6), pose: { wp: 0.45, wy: -0.2 }, root: { x: -0.02, z: 0.55, pitch: 0.15 }, rf: { ...RF, heel: 0.6 } },
      { t: F(16), ease: "linear", root: { z: 0.545 } },
      back(0.9),
    ],
  };

  // Crab (live wildcard): wide squat, pincers up, scuttle left and back snapping, then a double pinch.
  const PINCERS: Pose = { wy: 0, wp: 0.05, lsp: -0.2, lsr: 1.35, lsy: 1.4, le: -0.3, lwp: 0.6, rsp: -0.2, rsr: -1.35, rsy: -1.4, re: -0.3, rwp: 0.6 };
  const snap = (l: number, r: number): Pose => ({ lwp: 0.6 + l, le: -0.3 - 0.3 * l, rwp: 0.6 + r, re: -0.3 - 0.3 * r });
  const CL: Foot = { x: 0.04, y: 0.22, yaw: 0.4 }, CR: Foot = { x: -0.04, y: -0.22, yaw: -0.4 };
  const crab: Clip = {
    id: "mo_crab",
    keys: [
      { t: F(5), lf: CL, pose: { ...PINCERS }, root: { y: 0.03, z: 0.68 } },
      { t: F(9), rf: CR, root: { y: 0, z: 0.63 } },
      // sideways steps with a little forward drift, a bounce and a hip wiggle so it reads from the side camera too
      { t: F(14), rf: { ...CR, x: CR.x + 0.03, y: -0.1 }, pose: { wr: -0.15, ...snap(-0.7, 0.4) }, root: { x: 0.02, y: 0.07, z: 0.6, yaw: 0.3 }, lift: 0.05 },
      { t: F(19), lf: { ...CL, x: CL.x + 0.06, y: 0.34 }, pose: { wr: 0.15, ...snap(0.4, -0.7) }, root: { x: 0.05, y: 0.13, z: 0.65, yaw: -0.3 }, lift: 0.05 },
      { t: F(24), lf: { ...CL, x: CL.x + 0.03 }, pose: { wr: -0.15, ...snap(-0.7, 0.4) }, root: { x: 0.03, y: 0.07, z: 0.6, yaw: 0.3 }, lift: 0.05 },
      { t: F(29), rf: CR, pose: { wr: 0.15, ...snap(0.4, -0.7) }, root: { x: 0, y: 0, z: 0.65, yaw: -0.25 }, lift: 0.05 },
      { t: F(32), pose: { wr: 0, ...snap(0, 0) }, root: { yaw: 0, z: 0.63 } },
      { t: F(36), ease: "in3", pose: { wp: 0.2, lsp: -1.3, lsr: 0.3, lsy: 0, le: 0.9, lwp: 0.2, rsp: -1.3, rsr: -0.3, rsy: 0, re: 0.9, rwp: 0.2 }, root: { x: 0.04 }, lh: [0.45, 0.12, 1.05], rh: [0.45, -0.12, 1.05] },
      { t: F(38), ease: "linear" },
      { t: F(41), lf: LF, root: { x: 0.02, y: 0.02, z: 0.7 } },
      back(1.5),
    ],
  };

  return [idle, jab, cross, uppercut, hook, frontKick, roundKick, knee, palmThrust, toss, slam, summon, stomp, spin, block, crouch, crab];
}
