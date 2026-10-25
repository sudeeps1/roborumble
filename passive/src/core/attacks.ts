// Simulated attacks for the rig: a short force pulse at a point on the defender's body.
// Strengths are calibrated on SONIC in MuJoCo: a 300 N x 0.1 s shove at the torso is a
// stagger, 500 N a big stagger (about 1 m of stumbling), 800 N knocks it down.
export type Dir = "forward" | "rising" | "left" | "right" | "low";

export interface Attack {
  name: string;
  body: string;                   // body on the defender (unprefixed)
  offset: [number, number, number]; // point in that body's frame
  force: number;                  // N
  duration: number;               // s
  dir: Dir;                       // relative to the attacker -> defender line
}

export const ATTACKS: Attack[] = [
  { name: "Jab", body: "torso_link", offset: [0.06, 0, 0.42], force: 260, duration: 0.07, dir: "forward" },
  { name: "Body shot", body: "torso_link", offset: [0.09, 0, 0.18], force: 420, duration: 0.1, dir: "forward" },
  // a right hook lands on the defender's left (+y) and drives them toward the attacker's left
  { name: "Hook", body: "torso_link", offset: [0.02, 0.08, 0.42], force: 480, duration: 0.08, dir: "left" },
  { name: "Uppercut", body: "torso_link", offset: [0.08, 0, 0.36], force: 650, duration: 0.08, dir: "rising" },
  { name: "Shove", body: "torso_link", offset: [0.08, 0, 0.22], force: 650, duration: 0.14, dir: "forward" },
  { name: "Leg sweep", body: "left_ankle_roll_link", offset: [0.03, 0, 0], force: 420, duration: 0.12, dir: "left" },
  { name: "Haymaker", body: "torso_link", offset: [0.04, -0.06, 0.42], force: 820, duration: 0.1, dir: "right" },
];

/** World push direction for an attack, given the attacker -> defender unit vector (xy). */
export function pushDirection(dir: Dir, fx: number, fy: number): [number, number, number] {
  // the defender's left is the attacker's right
  switch (dir) {
    case "forward": return [fx, fy, 0];
    case "rising": return [0.55 * fx, 0.55 * fy, 0.83];
    case "left": return [0.45 * fx - 0.9 * fy, 0.45 * fy + 0.9 * fx, 0];
    case "right": return [0.45 * fx + 0.9 * fy, 0.45 * fy - 0.9 * fx, 0];
    case "low": return [fx, fy, -0.3];
  }
}
