// What a robot does between moves: boxer footwork with the guard up, getting hit, falling,
// lying there for a beat, getting back up, and staying down on a KO.
// SONIC does the balancing; the SONIC planner writes the motion it follows.
import { type Attack, pushDirection } from "./attacks.ts";
import { DEFAULT_ANGLES } from "./g1.ts";
import { clamp, qmul, qrot, tiltOf, yawOf, yawQuat } from "./math.ts";
import { Mode, type PlanBackend, applyPlan, contextFromReference, planFrames } from "./planner.ts";
import { type Frame, REF_HZ, Reference, copyFrame, poseFrame, resample } from "./reference.ts";
import { RING_RADIUS } from "./scene.ts";
import { SonicController, type SonicPolicy } from "./sonic.ts";
import type { RobotHandle, World } from "./world.ts";

export type Stance = "idle" | "stagger" | "falling" | "down" | "rising" | "ko" | "move";

// Arms forward and knees soft: what the robot reaches for while it goes down.
const BRACE = DEFAULT_ANGLES.slice();
BRACE[0] = BRACE[6] = -0.6; BRACE[3] = BRACE[9] = 1.1; BRACE[4] = BRACE[10] = -0.5;
BRACE[15] = BRACE[22] = -1.1; BRACE[18] = BRACE[25] = 0.5;
BRACE[16] = 0.35; BRACE[23] = -0.35;

const FALL_TILT = 0.95;      // rad (~55 deg) past which SONIC can't save it
const FALL_HEIGHT = 0.45;    // m, pelvis
const DOWN_HEIGHT = 0.4;
const DOWN_BEAT = 1.1;       // s on the floor before getting up
const STAGGER_S = 0.7;
const UP_HEIGHT = 0.66;
const RANGE = [1.1, 1.6];    // preferred distance to the opponent (m)

// Getting up in stages, each planned from the pose the robot actually reached. SONIC gets itself
// from the floor onto its knees; for the stand-up it follows the planner with light invisible help
// (one big "stand up" plan straight from the floor is too fast for it to follow on its own).
const RISE = [
  { label: "onto knees", mode: Mode.kneelTwoLeg, height: 0.3, reach: 0.21 },
  { label: "standing up", mode: Mode.idle, height: -1, reach: UP_HEIGHT },
];
const STAND_HELP = 0.6; // max share of body weight the strings carry during the planned stand-up

interface Pulse { body: number; local: number[]; force: number[]; left: number }

export class Fighter {
  readonly name: string;
  readonly ctl: SonicController;
  readonly ref: Reference;
  stance: Stance = "idle";
  opponent: Fighter | null = null;
  planner: PlanBackend | null = null;
  /** What the footwork brain is doing, for the HUD. */
  intent = "";
  lastEvent = "";

  private world: World;
  readonly robot: RobotHandle;
  private pulses: Pulse[] = [];
  private stanceT = 0;
  private lowT = 0;
  private planInFlight = false;
  private nextPlanAt = 0;
  private t = 0;
  private circleDir = 1;
  private hist: Frame[] = [];
  private riseTries = 0;
  private riseStage = 0;
  private stageTries = 0;
  private stageT = 0;
  private assist = 0;          // 0..1 "fairy strings" lift (share of body weight)
  private assistCap = 1;
  private mass = 0;
  private seed: number;

  constructor(name: string, world: World, robot: RobotHandle, policy: SonicPolicy, seed = 1) {
    this.name = name;
    this.world = world;
    this.robot = robot;
    this.seed = seed;
    this.ctl = new SonicController(world, robot, policy);
    this.ref = new Reference(world.robotQpos(robot));
    for (const b of robot.bodyIds) this.mass += world.model.body_mass[b];
  }

  // ---------- control ----------

  spawn(x: number, y: number, yaw: number) {
    const pose = this.world.placeStanding(this.robot, x, y, yaw, DEFAULT_ANGLES);
    this.ref.replace([pose]);
    this.ctl.active = true; this.ctl.hold = null; this.ctl.stiffness = 1;
    this.ctl.reset();
    this.ctl.worldHeading();
    this.pulses = []; this.hist = [];
    this.setStance("idle");
    this.nextPlanAt = 0; this.planInFlight = false; this.riseTries = 0; this.assist = 0;
  }

  /** Lands an attack thrown from `from` (world xy). Returns the contact point and push (world). */
  hit(a: Attack, from: ArrayLike<number>, scale = 1): { point: number[]; force: number[] } {
    const body = this.robot.bodies.get(a.body) ?? this.robot.bodies.get("torso_link")!;
    const me = this.world.rootPos(this.robot);
    let fx = me[0] - from[0], fy = me[1] - from[1];
    const d = Math.hypot(fx, fy) || 1; fx /= d; fy /= d;
    const dir = pushDirection(a.dir, fx, fy);
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const f = a.force * scale;
    this.pulses.push({ body, local: a.offset, force: [(dir[0] / n) * f, (dir[1] / n) * f, (dir[2] / n) * f], left: a.duration });
    if (this.stance === "idle") this.setStance("stagger");
    this.lastEvent = `${a.name} (${Math.round(f)} N)`;
    return { point: this.pointOn(body, a.offset), force: this.pulses[this.pulses.length - 1].force };
  }

  /**
   * Hands the robot a move (e.g. a Kimodo-G1 clip: rows of 36-value qpos at `fps`).
   * The clip is re-based so it starts where the robot stands, facing the opponent, and blended in.
   * When it ends the robot goes back to footwork. Falls during the move are handled as usual.
   */
  playMove(qpos: ArrayLike<number>[], fps = 30) {
    if (this.stance === "ko" || this.stance === "down" || this.stance === "falling" || this.stance === "rising") return false;
    const frames = resample(qpos.map((r) => copyFrame(r)), fps, REF_HZ);
    const now = this.world.rootPos(this.robot);
    const f0 = frames[0], turn = this.faceYaw(this.world.robotQpos(this.robot)) - yawOf([f0[3], f0[4], f0[5], f0[6]]);
    const c = Math.cos(turn), sn = Math.sin(turn), rot = yawQuat(turn);
    const x0 = f0[0], y0 = f0[1];
    for (const f of frames) {
      const dx = f[0] - x0, dy = f[1] - y0;
      f[0] = now[0] + c * dx - sn * dy;
      f[1] = now[1] + sn * dx + c * dy;
      const q = qmul(rot, [f[3], f[4], f[5], f[6]]);
      f[3] = q[0]; f[4] = q[1]; f[5] = q[2]; f[6] = q[3];
    }
    this.ref.splice(frames, 1, 8);
    this.setStance("move");
    this.intent = "playing a move";
    return true;
  }

  knockOut() {
    this.ctl.active = false;
    this.setStance("ko");
  }

  private setStance(s: Stance) {
    this.stance = s;
    this.stanceT = 0;
    this.lowT = 0;
  }

  private pointOn(body: number, local: ArrayLike<number>): number[] {
    const d = this.world.data, q = [d.xquat[body * 4], d.xquat[body * 4 + 1], d.xquat[body * 4 + 2], d.xquat[body * 4 + 3]];
    const p = qrot(q, local);
    return [p[0] + d.xpos[body * 3], p[1] + d.xpos[body * 3 + 1], p[2] + d.xpos[body * 3 + 2]];
  }

  // ---------- 50 Hz ----------

  async tick() {
    const dt = 1 / REF_HZ;
    this.t += dt; this.stanceT += dt;
    this.hist.push(this.world.robotQpos(this.robot));
    if (this.hist.length > 12) this.hist.shift();

    const p = this.world.rootPos(this.robot), q = this.world.rootQuat(this.robot);
    const tilt = tiltOf(q), h = p[2];
    const v = this.world.data.qvel, vo = this.robot.qvelRoot;
    const speed = Math.hypot(v[vo], v[vo + 1], v[vo + 2]);

    switch (this.stance) {
      case "idle":
      case "stagger":
        if (tilt > FALL_TILT || h < FALL_HEIGHT) { this.startFall(); break; }
        if (this.stance === "stagger" && this.stanceT > STAGGER_S) this.setStance("idle");
        this.footwork(p);
        break;
      case "falling":
        if (h < DOWN_HEIGHT && speed < 0.35) this.lowT += dt; else this.lowT = 0;
        if (this.lowT > 0.3 || this.stanceT > 3) { this.setStance("down"); this.ctl.hold = this.world.robotQpos(this.robot).slice(7); this.ctl.stiffness = 0.12; }
        break;
      case "down":
        if (this.stanceT > DOWN_BEAT) this.startRise();
        break;
      case "rising":
        this.rising(h, tilt);
        break;
      case "move":
        if (tilt > FALL_TILT || h < FALL_HEIGHT) { this.startFall(); break; }
        if (this.ref.remaining === 0) { this.setStance("idle"); this.nextPlanAt = 0; }
        break;
      case "ko":
        break;
    }

    await this.ctl.tick(this.ref);
    this.ref.advance();
  }

  /** Per 5 ms physics step: hit pulses, the fallback lift, then PD. */
  substep(dt: number) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pl = this.pulses[i];
      this.world.applyForce(pl.body, pl.force, this.pointOn(pl.body, pl.local));
      if ((pl.left -= dt) <= 0) this.pulses.splice(i, 1);
    }
    if (this.assist > 0) this.fairyStrings();
    this.ctl.pd();
  }

  // ---------- footwork ----------

  private footwork(me: number[]) {
    const opp = this.opponent ? this.world.rootPos(this.opponent.robot) : [me[0] + 1, me[1], 0];
    let fx = opp[0] - me[0], fy = opp[1] - me[1];
    const dist = Math.hypot(fx, fy) || 1; fx /= dist; fy /= dist;
    if (!this.planner) { this.holdGuard(me, Math.atan2(fy, fx)); return; }
    if (this.planInFlight || this.t < this.nextPlanAt || this.stance === "stagger") return;

    // Boxer footwork: hold range, circle, never leave the ring.
    let mode: number = Mode.walkBoxing, mx = 0, my = 0, speed = 0.35;
    const r = Math.hypot(me[0], me[1]);
    if (r > RING_RADIUS - 0.45) { mx = -me[0] / r; my = -me[1] / r; this.intent = "back to center"; }
    else if (dist > RANGE[1] + 0.3) { mx = fx; my = fy; speed = 0.5; this.intent = "closing in"; }
    else if (dist < RANGE[0]) { mx = -fx; my = -fy; this.intent = "backing off"; }
    else {
      const roll = this.rand();
      if (roll < 0.3) { mode = Mode.idleBoxing; this.intent = "bouncing in place"; }
      else {
        if (roll > 0.85) this.circleDir *= -1;
        mx = -fy * this.circleDir; my = fx * this.circleDir;
        this.intent = this.circleDir > 0 ? "circling left" : "circling right";
      }
    }
    this.requestPlan(mode, [mx, my, 0], [fx, fy, 0], speed, 0.8 + this.rand() * 0.6);
  }

  private requestPlan(mode: number, movement: number[], facing: number[], speed: number, holdFor: number) {
    if (!this.planner) return;
    const { context, genFrame } = contextFromReference(this.ref);
    this.planInFlight = true;
    const stance = this.stance;
    this.planner.plan({ context, mode, movement, facing, speed, seed: (this.seed = (this.seed * 48271) % 2147483647) })
      .then((flat) => {
        if (this.stance !== stance && !(stance === "stagger" && this.stance === "idle")) return;
        applyPlan(this.ref, flat, genFrame);
      })
      .catch((e) => { this.lastEvent = `planner: ${e.message ?? e}`; })
      .finally(() => { this.planInFlight = false; this.nextPlanAt = this.t + holdFor; });
  }

  /** No planner: hold a standing guard facing the opponent. */
  private holdGuard(me: number[], yaw: number) {
    if (this.ref.remaining > 10) return;
    const f = poseFrame([me[0], me[1], 0.76], [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], DEFAULT_ANGLES);
    this.ref.splice([f], 1, 8);
    this.intent = "guard (no planner)";
  }

  // ---------- falling and getting up ----------

  private startFall() {
    this.setStance("falling");
    this.ctl.hold = BRACE;      // reach out instead of flailing
    this.ctl.stiffness = 0.3;
    this.intent = "going down";
  }

  private startRise() {
    this.setStance("rising");
    this.riseTries++;
    this.ctl.hold = null;
    this.ctl.stiffness = 1;
    this.assist = 0;
    // The reference restarts from where the robot actually is.
    const now = this.world.robotQpos(this.robot);
    this.ref.replace([copyFrame(now)]);
    this.ctl.reset();
    this.ctl.worldHeading();
    if (!this.planner || this.riseTries > 2) { this.startAssist(this.faceYaw(now)); return; }
    this.riseStage = 0;
    this.stageTries = 0;
    void this.planStage();
  }

  /** Plans the current get-up stage from the robot's actual pose. */
  private async planStage() {
    if (!this.planner) return;
    const st = RISE[this.riseStage];
    const yaw = this.faceYaw(this.world.robotQpos(this.robot));
    this.planInFlight = true;
    this.stageT = 0;
    this.intent = `getting up: ${st.label}`;
    if (this.riseStage === RISE.length - 1) { this.assistCap = STAND_HELP; this.assist = Math.max(this.assist, 0.01); }
    try {
      const flat = await this.planner.plan({ context: this.contextFromRobot(), mode: st.mode, height: st.height, movement: [0, 0, 0], facing: [Math.cos(yaw), Math.sin(yaw), 0], speed: -1 });
      if (this.stance !== "rising") return;
      // plan frame 0 sits 3 planner frames (0.1 s) behind "now"
      const frames = planFrames(flat).slice(5);
      if (frames.length) this.ref.replace(frames);
    } catch (e) {
      this.lastEvent = `planner: ${(e as Error).message}`;
      this.startAssist(yaw);
    } finally {
      this.planInFlight = false;
    }
  }

  private rising(h: number, tilt: number) {
    const last = this.riseStage === RISE.length - 1;
    if (h > UP_HEIGHT && tilt < 0.3 && (last || this.assist > 0)) {
      this.assist = 0;
      this.assistCap = 1;
      this.riseTries = 0;
      this.setStance("idle");
      this.nextPlanAt = 0;
      this.intent = "back up";
      return;
    }
    if (this.assist > 0) this.assist = Math.min(this.assistCap, this.assist + 1 / (REF_HZ * 1.2));
    if (this.assistCap === 1 && this.assist > 0) return; // fallback lift: nothing else to do
    if (this.planInFlight) return;
    this.stageT += 1 / REF_HZ;
    const st = RISE[this.riseStage];
    // next stage once the body has (nearly) reached this one's height
    if (!last && h > st.reach - 0.05 && tilt < 0.9 && this.ref.remaining < 20) {
      this.riseStage++;
      this.stageTries = 0;
      void this.planStage();
      return;
    }
    // plan ran out without getting there: try this stage again from where it is now
    if (this.ref.remaining === 0 && this.stageT > 0.8) {
      if (++this.stageTries > 2) {
        if (this.riseStage > 0) { this.riseStage--; this.stageTries = 0; void this.planStage(); }
        else this.startAssist(this.faceYaw(this.world.robotQpos(this.robot)));
      } else void this.planStage();
    }
    if (this.stanceT > 14) this.startAssist(this.faceYaw(this.world.robotQpos(this.robot)));
  }

  private faceYaw(now: ArrayLike<number>): number {
    if (!this.opponent) return yawOf([now[3], now[4], now[5], now[6]]);
    const o = this.world.rootPos(this.opponent.robot);
    return Math.atan2(o[1] - now[1], o[0] - now[0]);
  }

  /** Planner context from the robot's own last 0.1 s (4 frames at 30 Hz, oldest first). */
  contextFromRobot(): number[] {
    const ctx: number[] = [];
    const n = this.hist.length;
    for (let k = 3; k >= 0; k--) {
      const s = n - 1 - (k * REF_HZ) / 30;
      const i0 = clamp(Math.floor(s), 0, n - 1), i1 = clamp(i0 + 1, 0, n - 1), u = s - Math.floor(s);
      const a = this.hist[i0], b = this.hist[i1];
      for (let i = 0; i < 36; i++) ctx.push(a[i] + (b[i] - a[i]) * u);
    }
    return ctx;
  }

  /** Fallback get-up: SONIC tracks a standing guard while invisible strings lift the torso. */
  private startAssist(yaw: number) {
    this.intent = "lifted up (assist)";
    this.assistCap = 1;
    const me = this.world.rootPos(this.robot);
    this.ref.replace([poseFrame([me[0], me[1], 0.76], [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], DEFAULT_ANGLES)]);
    this.assist = 0.01;
  }

  private fairyStrings() {
    const w = this.world, torso = this.robot.bodies.get("torso_link")!;
    const p = w.rootPos(this.robot), q = w.rootQuat(this.robot);
    const v = w.data.qvel, vo = this.robot.qvelRoot;
    const k = this.assist;
    const lift = this.mass * 9.81 * 0.9 * k + 600 * k * (0.76 - p[2]) - 80 * k * v[vo + 2];
    w.applyForce(torso, [-60 * k * v[vo], -60 * k * v[vo + 1], Math.max(0, lift)], w.bodyPos(torso));
    // upright torque: rotate the pelvis' up axis toward world up
    const up = qrot(q, [0, 0, 1]);
    const ax = [up[1], -up[0], 0]; // up x worldZ
    const ang = Math.acos(clamp(up[2], -1, 1));
    const s = Math.hypot(ax[0], ax[1]) || 1;
    const f = w.data.xfrc_applied, cv = w.data.cvel, o = this.robot.bodies.get("pelvis")! * 6;
    const kp = 260 * k, kd = 30 * k;
    f[o + 3] += (kp * ang * ax[0]) / s - kd * cv[o];     // cvel: angular velocity first
    f[o + 4] += (kp * ang * ax[1]) / s - kd * cv[o + 1];
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }
}

/** Wraps the two fighters around one world and steps them on SONIC's clock. */
export class Arena {
  readonly world: World;
  readonly fighters: Fighter[];
  simTime = 0;

  constructor(world: World, fighters: Fighter[]) {
    this.world = world;
    this.fighters = fighters;
    if (fighters.length === 2) { fighters[0].opponent = fighters[1]; fighters[1].opponent = fighters[0]; }
  }

  /** One 20 ms control tick: every fighter thinks, then 4 physics steps. */
  async tick() {
    for (const f of this.fighters) await f.tick();
    const dt = this.world.dt;
    for (let s = 0; s < 4; s++) {
      this.world.clearForces();
      for (const f of this.fighters) f.substep(dt);
      this.world.step();
      this.simTime += dt;
    }
  }
}

