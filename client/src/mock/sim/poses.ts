// Procedural pose layers the stub sim puts on top of the playing motion: block guard, charge stance,
// hit stagger, limp body for falls, knee crouch. Angles were picked by eye on the Menagerie G1.
import type { MjModel } from "../../g1/mjcf";

type Angles = Record<string, number>;

// Forearms crossed in an X in front of the face (distinct from the motions' fists-up idle guard).
const BLOCK: Angles = {
  waist_yaw_joint: 0, waist_roll_joint: 0, waist_pitch_joint: -0.05,
  left_shoulder_pitch_joint: -1.35, left_shoulder_roll_joint: -0.3, left_shoulder_yaw_joint: -0.75, left_elbow_joint: -0.3,
  right_shoulder_pitch_joint: -1.35, right_shoulder_roll_joint: 0.3, right_shoulder_yaw_joint: 0.75, right_elbow_joint: -0.3,
  left_wrist_roll_joint: 0, left_wrist_pitch_joint: 0, left_wrist_yaw_joint: 0,
  right_wrist_roll_joint: 0, right_wrist_pitch_joint: 0, right_wrist_yaw_joint: 0,
};
// Both arms raised overhead, chest open: summoning while a live wildcard generates (reads well in profile).
const CHARGE: Angles = {
  waist_yaw_joint: 0, waist_roll_joint: 0, waist_pitch_joint: -0.12,
  left_shoulder_pitch_joint: -2.5, left_shoulder_roll_joint: 0.45, left_shoulder_yaw_joint: 0, left_elbow_joint: 0.55,
  right_shoulder_pitch_joint: -2.5, right_shoulder_roll_joint: -0.45, right_shoulder_yaw_joint: 0, right_elbow_joint: 0.55,
  left_wrist_roll_joint: 0, left_wrist_pitch_joint: 0, left_wrist_yaw_joint: 0,
  right_wrist_roll_joint: 0, right_wrist_pitch_joint: 0, right_wrist_yaw_joint: 0,
};
// Knocked flat: arms flung wide, knees a little bent, torso straight.
const LIMP: Angles = {
  waist_yaw_joint: 0, waist_roll_joint: 0, waist_pitch_joint: 0,
  left_shoulder_pitch_joint: -0.9, left_shoulder_roll_joint: 1.3, left_shoulder_yaw_joint: 0, left_elbow_joint: 1.2,
  right_shoulder_pitch_joint: -0.9, right_shoulder_roll_joint: -1.3, right_shoulder_yaw_joint: 0, right_elbow_joint: 1.2,
  left_wrist_roll_joint: 0, left_wrist_pitch_joint: 0, left_wrist_yaw_joint: 0,
  right_wrist_roll_joint: 0, right_wrist_pitch_joint: 0, right_wrist_yaw_joint: 0,
  left_hip_pitch_joint: -0.35, left_knee_joint: 0.7, left_ankle_pitch_joint: -0.2, left_hip_roll_joint: 0.1, left_hip_yaw_joint: 0, left_ankle_roll_joint: 0,
  right_hip_pitch_joint: -0.25, right_knee_joint: 0.5, right_ankle_pitch_joint: -0.2, right_hip_roll_joint: -0.1, right_hip_yaw_joint: 0, right_ankle_roll_joint: 0,
};
// Toppled onto a side: arms reach forward (not out sideways into the floor), knees drawn up.
const LIMP_SIDE: Angles = {
  waist_yaw_joint: 0, waist_roll_joint: 0, waist_pitch_joint: 0.15,
  left_shoulder_pitch_joint: -0.9, left_shoulder_roll_joint: 0.15, left_shoulder_yaw_joint: 0, left_elbow_joint: 0.9,
  right_shoulder_pitch_joint: -0.7, right_shoulder_roll_joint: -0.15, right_shoulder_yaw_joint: 0, right_elbow_joint: 1.1,
  left_hip_pitch_joint: -0.7, left_knee_joint: 1.1, left_ankle_pitch_joint: -0.3, left_hip_roll_joint: 0, left_hip_yaw_joint: 0, left_ankle_roll_joint: 0,
  right_hip_pitch_joint: -0.4, right_knee_joint: 0.8, right_ankle_pitch_joint: -0.3, right_hip_roll_joint: 0, right_hip_yaw_joint: 0, right_ankle_roll_joint: 0,
};
// Added (scaled by the stagger envelope): torso and arms thrown back.
const STAGGER: Angles = {
  waist_pitch_joint: -0.3,
  left_shoulder_pitch_joint: 0.6, right_shoulder_pitch_joint: 0.6,
  left_shoulder_roll_joint: 0.25, right_shoulder_roll_joint: -0.25,
  left_elbow_joint: -0.35, right_elbow_joint: -0.35,
};

type Compiled = [number, number][]; // [qpos index, value]

export class PoseKit {
  readonly block: Compiled;
  readonly charge: Compiled;
  readonly limp: Compiled;
  readonly limpSide: Compiled;
  readonly stagger: Compiled;
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly hips: number[];
  private readonly knees: number[];
  private readonly ankles: number[];

  constructor(model: MjModel) {
    const adr = new Map(model.joints.filter((j) => j.type !== "free").map((j) => [j.name, j.qposAdr]));
    const compile = (a: Angles): Compiled => Object.entries(a).flatMap(([n, v]) => (adr.has(n) ? [[adr.get(n)!, v] as [number, number]] : []));
    this.block = compile(BLOCK);
    this.charge = compile(CHARGE);
    this.limp = compile(LIMP);
    this.limpSide = compile(LIMP_SIDE);
    this.stagger = compile(STAGGER);
    this.lo = new Array(model.nq).fill(-Infinity);
    this.hi = new Array(model.nq).fill(Infinity);
    for (const j of model.joints) if (j.type === "hinge" && j.range) { this.lo[j.qposAdr] = j.range[0]; this.hi[j.qposAdr] = j.range[1]; }
    const pick = (...names: string[]) => names.map((n) => adr.get(n)).filter((v): v is number => v != null);
    this.hips = pick("left_hip_pitch_joint", "right_hip_pitch_joint");
    this.knees = pick("left_knee_joint", "right_knee_joint");
    this.ankles = pick("left_ankle_pitch_joint", "right_ankle_pitch_joint");
  }

  /** Move the listed joints toward the pose by w (0..1). */
  blend(q: number[], pose: Compiled, w: number) {
    for (const [a, v] of pose) q[a] += (v - q[a]) * w;
  }

  /** Add the pose's offsets scaled by w. */
  add(q: number[], pose: Compiled, w: number) {
    for (const [a, v] of pose) q[a] += v * w;
  }

  /** Bend both knees by 2a with the hips and ankles compensating, so the feet stay flat (rad). */
  crouch(q: number[], a: number) {
    if (!a) return;
    for (const i of this.hips) q[i] -= a;
    for (const i of this.knees) q[i] += 2 * a;
    for (const i of this.ankles) q[i] -= a;
  }

  clamp(q: number[]) {
    for (let i = 0; i < q.length; i++) {
      const v = q[i];
      if (v < this.lo[i]) q[i] = this.lo[i];
      else if (v > this.hi[i]) q[i] = this.hi[i];
    }
  }
}
