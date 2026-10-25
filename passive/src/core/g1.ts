// Unitree G1 (29 DoF) constants for the SONIC controller.
// Gains, action scales, default pose and joint maps are ported from
// NVlabs/GR00T-WholeBodyControl gear_sonic_deploy/.../policy_parameters.hpp (Apache-2.0).
// Torque limits come from that repo's sim config (motor_effort_limit_list).
//
// Two joint orders exist:
//   MuJoCo order: the XML's tree order, also Kimodo-G1's CSV order. Everything outside sonic.ts uses it.
//   IsaacLab order: what the SONIC networks read and write.

export const NJ = 29;

export const JOINTS = [
  "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
  "left_ankle_pitch_joint", "left_ankle_roll_joint",
  "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint", "right_knee_joint",
  "right_ankle_pitch_joint", "right_ankle_roll_joint",
  "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint",
  "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint", "left_elbow_joint",
  "left_wrist_roll_joint", "left_wrist_pitch_joint", "left_wrist_yaw_joint",
  "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint", "right_elbow_joint",
  "right_wrist_roll_joint", "right_wrist_pitch_joint", "right_wrist_yaw_joint",
] as const;

// IL_OF_MJ[mj] = IsaacLab index of MuJoCo joint mj (isaaclab_to_mujoco in the C++).
export const IL_OF_MJ = [0, 3, 6, 9, 13, 17, 1, 4, 7, 10, 14, 18, 2, 5, 8, 11, 15, 19, 21, 23, 25, 27, 12, 16, 20, 22, 24, 26, 28];
// MJ_OF_IL[il] = MuJoCo index of IsaacLab joint il (mujoco_to_isaaclab in the C++).
export const MJ_OF_IL = [0, 6, 12, 1, 7, 13, 2, 8, 14, 3, 9, 15, 22, 4, 10, 16, 23, 5, 11, 17, 24, 18, 25, 19, 26, 20, 27, 21, 28];

// Standing pose SONIC was trained around (MuJoCo order).
export const DEFAULT_ANGLES = [
  -0.312, 0, 0, 0.669, -0.363, 0,
  -0.312, 0, 0, 0.669, -0.363, 0,
  0, 0, 0,
  0.2, 0.2, 0, 0.6, 0, 0, 0,
  0.2, -0.2, 0, 0.6, 0, 0, 0,
];

// Motor types: armature (kg m^2) and effort limit used for the action scale.
const MOTOR = {
  m5020: { armature: 0.003609725, effort: 25 },
  m7520_14: { armature: 0.01017752, effort: 88 },
  m7520_22: { armature: 0.025101925, effort: 139 },
  m4010: { armature: 0.00425, effort: 5 },
};
type MotorName = keyof typeof MOTOR;

// [motor, gain multiplier] per MuJoCo joint. Ankles and waist roll/pitch run at 2x gains.
const JOINT_MOTORS: [MotorName, number][] = [
  ["m7520_22", 1], ["m7520_22", 1], ["m7520_14", 1], ["m7520_22", 1], ["m5020", 2], ["m5020", 2],
  ["m7520_22", 1], ["m7520_22", 1], ["m7520_14", 1], ["m7520_22", 1], ["m5020", 2], ["m5020", 2],
  ["m7520_14", 1], ["m5020", 2], ["m5020", 2],
  ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m4010", 1], ["m4010", 1],
  ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m5020", 1], ["m4010", 1], ["m4010", 1],
];

const OMEGA = 10 * 2 * Math.PI; // 10 Hz natural frequency
const ZETA = 2;

export const KP = JOINT_MOTORS.map(([m, k]) => k * MOTOR[m].armature * OMEGA * OMEGA);
export const KD = JOINT_MOTORS.map(([m, k]) => k * 2 * ZETA * MOTOR[m].armature * OMEGA);
// action_scale = 0.25 * effort_limit / stiffness (the base stiffness, before the 2x).
export const ACTION_SCALE = JOINT_MOTORS.map(([m]) => (0.25 * MOTOR[m].effort) / (MOTOR[m].armature * OMEGA * OMEGA));

// PD torques are clipped to these (Nm, MuJoCo order).
export const TORQUE_LIMIT = [
  88, 88, 88, 139, 50, 50,
  88, 88, 88, 139, 50, 50,
  88, 50, 50,
  25, 25, 25, 25, 25, 5, 5,
  25, 25, 25, 25, 25, 5, 5,
];

export const STAND_HEIGHT = 0.793; // pelvis height in the XML
