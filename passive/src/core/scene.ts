// Builds one MuJoCo scene with N copies of the SONIC G1 model.
// Every robot's names get a prefix ("p1_pelvis", "p1_left_knee_joint", ...); meshes and
// default classes are shared. Sensors are dropped: the sim reads qpos/qvel directly.

export interface RobotSpawn {
  prefix: string;     // e.g. "p1_"
  x: number;
  y: number;
  yaw: number;        // radians, 0 faces +X
}

export const RING_RADIUS = 2.2; // m, the arena floor the fighters stay on

/** The first <tag>...</tag> block, matching nested blocks of the same tag (defaults nest). */
function section(xml: string, tag: string): string {
  const open = xml.indexOf(`<${tag}`);
  if (open < 0) throw new Error(`robot xml has no <${tag}>`);
  const re = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, "g");
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0].startsWith("</")) depth--;
    else if (m[1] !== "/") depth++;
    if (depth === 0) return xml.slice(open, m.index + m[0].length);
  }
  throw new Error(`robot xml: unclosed <${tag}>`);
}

function inner(block: string, tag: string): string {
  return block.slice(block.indexOf(">") + 1, block.lastIndexOf(`</${tag}>`));
}

/** robotXml: the contents of g1_29dof.xml (meshdir="meshes"). */
export function buildScene(robotXml: string, robots: RobotSpawn[]): string {
  const defaults = section(robotXml, "default");
  const assets = section(robotXml, "asset");
  const body = inner(section(robotXml, "worldbody"), "worldbody");
  const actuators = inner(section(robotXml, "actuator"), "actuator");

  const robotBodies = robots.map(({ prefix, x, y, yaw }) => {
    const named = body.replace(/\bname="([^"]+)"/g, `name="${prefix}$1"`);
    const quat = `${Math.cos(yaw / 2)} 0 0 ${Math.sin(yaw / 2)}`;
    // the pelvis is the only top-level body: move it to the spawn point
    return named.replace(/<body name="([^"]+)" pos="[^"]*"/, `<body name="$1" pos="${x} ${y} 0.793" quat="${quat}"`);
  });
  const robotActuators = robots.map(({ prefix }) =>
    actuators.replace(/\bname="([^"]+)"/g, `name="${prefix}$1"`).replace(/\bjoint="([^"]+)"/g, `joint="${prefix}$1"`),
  );

  // SONIC's sim scene sets the default geom friction to 0.5; keep it so the controller sees the floor it was tested on.
  const defaultsWithFriction = defaults.replace("<default>", `<default>\n    <geom friction="0.5"/>`);

  return `<mujoco model="passive_rig">
  <compiler angle="radian" meshdir="meshes"/>
  <option timestep="0.005"/>
  <size memory="64M"/>
  ${defaultsWithFriction}
  ${assets}
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" rgba="0.3 0.3 0.35 1"/>
    ${robotBodies.join("\n")}
  </worldbody>
  <actuator>
    ${robotActuators.join("\n")}
  </actuator>
</mujoco>`;
}
