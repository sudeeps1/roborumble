// MuJoCo world with N G1 robots. Works in the browser and in Node: the caller passes the
// loaded MuJoCo module and the files (robot XML + meshes) as bytes.
import { JOINTS, NJ } from "./g1.ts";
import { buildScene, type RobotSpawn } from "./scene.ts";

// The official bindings are typed loosely; keep our own surface small.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mujoco = any;

export interface RobotHandle {
  prefix: string;
  qposRoot: number;          // qpos index of the free joint (7 values: pos, quat)
  qvelRoot: number;          // qvel index of the free joint (6 values: lin vel world, ang vel body)
  qpos: Int32Array;          // qpos index per joint, MuJoCo order
  qvel: Int32Array;          // qvel index per joint
  actuator: Int32Array;      // actuator id per joint
  lo: Float64Array;          // joint limits (rad), MuJoCo order
  hi: Float64Array;
  bodies: Map<string, number>; // unprefixed body name -> body id
  bodyIds: number[];         // all body ids of this robot
}

export class World {
  readonly mj: Mujoco;
  readonly model: Mujoco;
  readonly data: Mujoco;
  readonly robots: RobotHandle[];
  readonly dt: number;

  constructor(mj: Mujoco, files: { robotXml: string; meshes: Map<string, Uint8Array> }, spawns: RobotSpawn[]) {
    this.mj = mj;
    const fs = mj.FS;
    try { fs.mkdir("/rig"); } catch { /* exists */ }
    try { fs.mkdir("/rig/meshes"); } catch { /* exists */ }
    for (const [name, bytes] of files.meshes) fs.writeFile(`/rig/meshes/${name}`, bytes);
    fs.writeFile("/rig/scene.xml", buildScene(files.robotXml, spawns));
    this.model = mj.MjModel.from_xml_path("/rig/scene.xml");
    this.data = new mj.MjData(this.model);
    this.dt = this.model.opt.timestep;
    this.robots = spawns.map((s) => this.handle(s.prefix));
    mj.mj_forward(this.model, this.data);
  }

  private id(type: string, name: string): number {
    const id = this.mj.mj_name2id(this.model, this.mj.mjtObj[type].value, name);
    if (id < 0) throw new Error(`no ${type} named ${name}`);
    return id;
  }

  private handle(prefix: string): RobotHandle {
    const m = this.model;
    const free = this.id("mjOBJ_JOINT", `${prefix}floating_base_joint`);
    const qpos = new Int32Array(NJ), qvel = new Int32Array(NJ), actuator = new Int32Array(NJ);
    const lo = new Float64Array(NJ), hi = new Float64Array(NJ);
    JOINTS.forEach((j, i) => {
      const jid = this.id("mjOBJ_JOINT", prefix + j);
      qpos[i] = m.jnt_qposadr[jid];
      qvel[i] = m.jnt_dofadr[jid];
      lo[i] = m.jnt_range[jid * 2]; hi[i] = m.jnt_range[jid * 2 + 1];
      if (!(hi[i] > lo[i])) { lo[i] = -Math.PI; hi[i] = Math.PI; }
      actuator[i] = this.id("mjOBJ_ACTUATOR", prefix + j.replace(/_joint$/, ""));
    });
    const bodies = new Map<string, number>();
    const bodyIds: number[] = [];
    for (let b = 1; b < m.nbody; b++) {
      const name: string = this.mj.mj_id2name(m, this.mj.mjtObj.mjOBJ_BODY.value, b) ?? "";
      if (name.startsWith(prefix)) { bodies.set(name.slice(prefix.length), b); bodyIds.push(b); }
    }
    return { prefix, qposRoot: m.jnt_qposadr[free], qvelRoot: m.jnt_dofadr[free], qpos, qvel, actuator, lo, hi, bodies, bodyIds };
  }

  step() {
    this.mj.mj_step(this.model, this.data);
  }

  /** True if any position or velocity is NaN/inf (the sim blew up). */
  unstable(): boolean {
    const q = this.data.qpos, v = this.data.qvel;
    for (let i = 0; i < q.length; i++) if (!Number.isFinite(q[i])) return true;
    for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]) || Math.abs(v[i]) > 1e3) return true;
    return false;
  }

  /** Copies of qpos/qvel, to roll back to if the sim blows up. */
  snapshot(): { qpos: Float64Array; qvel: Float64Array; time: number } {
    return { qpos: Float64Array.from(this.data.qpos), qvel: Float64Array.from(this.data.qvel), time: this.data.time };
  }

  restore(s: { qpos: Float64Array; qvel: Float64Array; time: number }) {
    this.data.qpos.set(s.qpos);
    this.data.qvel.set(s.qvel);
    this.data.qacc_warmstart?.fill?.(0);
    this.data.ctrl.fill(0);
    this.clearForces();
    this.forward();
  }

  /** World linear velocity of a robot's pelvis (free-joint qvel is world-frame for translation). */
  rootVel(r: RobotHandle, out: number[] = [0, 0, 0]): number[] {
    const v = this.data.qvel;
    out[0] = v[r.qvelRoot]; out[1] = v[r.qvelRoot + 1]; out[2] = v[r.qvelRoot + 2];
    return out;
  }

  forward() {
    this.mj.mj_forward(this.model, this.data);
  }

  /** Pelvis position (world). */
  rootPos(r: RobotHandle, out: number[] = [0, 0, 0]): number[] {
    const q = this.data.qpos;
    out[0] = q[r.qposRoot]; out[1] = q[r.qposRoot + 1]; out[2] = q[r.qposRoot + 2];
    return out;
  }

  /** Pelvis orientation (world), w x y z. */
  rootQuat(r: RobotHandle, out: number[] = [1, 0, 0, 0]): number[] {
    const q = this.data.qpos, a = r.qposRoot + 3;
    out[0] = q[a]; out[1] = q[a + 1]; out[2] = q[a + 2]; out[3] = q[a + 3];
    return out;
  }

  /** Full 36-value qpos of one robot (root pos, root quat, 29 joints in MuJoCo order). */
  robotQpos(r: RobotHandle, out: Float64Array = new Float64Array(36)): Float64Array {
    const q = this.data.qpos;
    for (let i = 0; i < 7; i++) out[i] = q[r.qposRoot + i];
    for (let j = 0; j < NJ; j++) out[7 + j] = q[r.qpos[j]];
    return out;
  }

  /** Puts a robot in a pose (36 values) with zero velocity. Call forward() after. */
  setRobotQpos(r: RobotHandle, pose: ArrayLike<number>) {
    const q = this.data.qpos, v = this.data.qvel;
    for (let i = 0; i < 7; i++) q[r.qposRoot + i] = pose[i];
    for (let j = 0; j < NJ; j++) q[r.qpos[j]] = pose[7 + j];
    for (let i = 0; i < 6; i++) v[r.qvelRoot + i] = 0;
    for (let j = 0; j < NJ; j++) v[r.qvel[j]] = 0;
  }

  /**
   * Stands a robot at (x, y) facing `yaw` in the given joint pose (MuJoCo order),
   * with its lowest foot sphere just touching the floor. Velocities are zeroed.
   */
  placeStanding(r: RobotHandle, x: number, y: number, yaw: number, joints: ArrayLike<number>) {
    const pose = new Float64Array(36);
    pose[0] = x; pose[1] = y; pose[2] = 0.793;
    pose[3] = Math.cos(yaw / 2); pose[6] = Math.sin(yaw / 2);
    for (let j = 0; j < NJ; j++) pose[7 + j] = joints[j];
    this.setRobotQpos(r, pose);
    this.forward();
    const m = this.model, gx = this.data.geom_xpos;
    const own = new Set(r.bodyIds);
    let low = Infinity;
    for (let g = 0; g < m.ngeom; g++) {
      if (m.geom_type[g] !== 2 || !own.has(m.geom_bodyid[g])) continue; // foot contact spheres
      low = Math.min(low, gx[g * 3 + 2] - m.geom_size[g * 3]);
    }
    if (Number.isFinite(low)) {
      pose[2] -= low - 0.0005;
      this.setRobotQpos(r, pose);
      this.forward();
    }
    return pose;
  }

  /** Adds a world-frame force (N) at a world point on a body for this step. Cleared by clearForces(). */
  applyForce(body: number, force: ArrayLike<number>, point: ArrayLike<number>) {
    const x = this.data.xipos; // center of mass of each body
    const f = this.data.xfrc_applied, o = body * 6;
    const rx = point[0] - x[body * 3], ry = point[1] - x[body * 3 + 1], rz = point[2] - x[body * 3 + 2];
    f[o] += force[0]; f[o + 1] += force[1]; f[o + 2] += force[2];
    f[o + 3] += ry * force[2] - rz * force[1];
    f[o + 4] += rz * force[0] - rx * force[2];
    f[o + 5] += rx * force[1] - ry * force[0];
  }

  clearForces() {
    this.data.xfrc_applied.fill(0);
  }

  /** World position of a point given in a body's frame. */
  pointOn(body: number, local: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
    const x = this.data.xpos, R = this.data.xmat, o = body * 9, t = body * 3;
    const lx = local[0], ly = local[1], lz = local[2];
    out[0] = x[t] + R[o] * lx + R[o + 1] * ly + R[o + 2] * lz;
    out[1] = x[t + 1] + R[o + 3] * lx + R[o + 4] * ly + R[o + 5] * lz;
    out[2] = x[t + 2] + R[o + 6] * lx + R[o + 7] * ly + R[o + 8] * lz;
    return out;
  }

  /** A world point expressed in a body's frame. */
  toLocal(body: number, p: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
    const x = this.data.xpos, R = this.data.xmat, o = body * 9, t = body * 3;
    const dx = p[0] - x[t], dy = p[1] - x[t + 1], dz = p[2] - x[t + 2];
    out[0] = R[o] * dx + R[o + 3] * dy + R[o + 6] * dz;
    out[1] = R[o + 1] * dx + R[o + 4] * dy + R[o + 7] * dz;
    out[2] = R[o + 2] * dx + R[o + 5] * dy + R[o + 8] * dz;
    return out;
  }

  /** Axis-aligned bounds of a mesh geom's vertices, in its body's frame: [min xyz, max xyz]. */
  meshBounds(geom: number): [number[], number[]] | null {
    const m = this.model;
    const mid = m.geom_dataid[geom];
    if (m.geom_type[geom] !== 7 || mid < 0) return null;
    const va = m.mesh_vertadr[mid], vn = m.mesh_vertnum[mid], V = m.mesh_vert;
    const gp = [m.geom_pos[geom * 3], m.geom_pos[geom * 3 + 1], m.geom_pos[geom * 3 + 2]];
    const gq = [m.geom_quat[geom * 4], m.geom_quat[geom * 4 + 1], m.geom_quat[geom * 4 + 2], m.geom_quat[geom * 4 + 3]];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const w = gq[0], qx = gq[1], qy = gq[2], qz = gq[3];
    for (let i = va; i < va + vn; i++) {
      const vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
      const p = [vx + w * tx + (qy * tz - qz * ty) + gp[0], vy + w * ty + (qz * tx - qx * tz) + gp[1], vz + w * tz + (qx * ty - qy * tx) + gp[2]];
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    }
    return [lo, hi];
  }

  /** Mesh geoms (visual group 1) of a body, by mesh name. */
  meshGeom(body: number, meshName: string): number {
    const m = this.model;
    for (let g = 0; g < m.ngeom; g++) {
      if (m.geom_bodyid[g] !== body || m.geom_type[g] !== 7) continue;
      if (this.mj.mj_id2name(m, this.mj.mjtObj.mjOBJ_MESH.value, m.geom_dataid[g]) === meshName) return g;
    }
    return -1;
  }

  bodyPos(body: number, out: number[] = [0, 0, 0]): number[] {
    const x = this.data.xpos;
    out[0] = x[body * 3]; out[1] = x[body * 3 + 1]; out[2] = x[body * 3 + 2];
    return out;
  }
}
