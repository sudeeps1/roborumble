// Stand-in for Sudeep's sim (src/sim) so the game screen runs before it lands. Kinematic and deterministic:
// motions play back as-is (re-based onto each fighter, crossfaded), outcomes come from the CLAUDE.md rules
// (sim/rules.ts), hits push and stagger, knockdowns and KOs tip the posed robot over onto the floor.
// No physics engine, but the same Sim interface and the same event stream the real sim will produce.
// Fighters start 1.2 m apart on the MuJoCo X axis, P1 facing +X, P2 facing -X.
import type { Action, FighterState, Kind, Motion, Move, MoveType, Player, Quat, Sim, SimEvent, Status, Vec3 } from "../contract";
import { FIGHTER_GAP, TYPE_EFFECT } from "../config";
import { Kinematics, slerp, type BodyPoses } from "../g1/fk";
import { qpos0, type MjModel } from "../g1/mjcf";
import { ClipSampler } from "./sim/clip";
import { PoseKit } from "./sim/poses";
import * as R from "./sim/rules";

const BLEND_S = 0.12;        // crossfade between idle and moves
const APPROACH_S = 0.2;      // melee step-in
const HOME_RATE = 2.2;       // 1/s, easing back to the start spot
const KB_DECAY = 9;          // 1/s, knockback slide
const MIN_GAP = 0.5;         // anchors never closer than this
const MIN_PELVIS_GAP = 0.5;  // nor the bodies (pelvis to pelvis)
const STAGGER_S = 0.5;
const DODGE_SLIDE_S = 0.22;
const DODGE_LEAN_S = 0.45;
const DODGE_HOLD_S = 0.6;    // stay on the side line this long, then drift back to center
const JUMP_PRE = 0.07, JUMP_AIR = 0.3, JUMP_H = 0.22;
const FALL_S = 0.5, BOUNCE_S = 0.16, GETUP_S = 0.7;
const LIE_END = FALL_S + R.DOWN_S;
const FALL_END = LIE_END + GETUP_S;
const FALL_ANGLE = 1.53;     // ~88 deg: flat on the floor
const ARRIVE_R = 0.12;       // a projectile lands this close to the chest center
const DODGE_CLEAR = 0.3;     // a defender this far from where the projectile was aimed has side-stepped it

// Points that can touch the floor: body, local offset, radius. Feet are g1.xml's foot contact spheres.
const CONTACTS: [string, number, number, number, number][] = [
  ["left_ankle_roll_link", -0.05, 0.025, -0.03, 0.005], ["left_ankle_roll_link", -0.05, -0.025, -0.03, 0.005],
  ["left_ankle_roll_link", 0.12, 0.03, -0.03, 0.005], ["left_ankle_roll_link", 0.12, -0.03, -0.03, 0.005],
  ["right_ankle_roll_link", -0.05, 0.025, -0.03, 0.005], ["right_ankle_roll_link", -0.05, -0.025, -0.03, 0.005],
  ["right_ankle_roll_link", 0.12, 0.03, -0.03, 0.005], ["right_ankle_roll_link", 0.12, -0.03, -0.03, 0.005],
  ["left_knee_link", 0.02, 0, 0, 0.05], ["right_knee_link", 0.02, 0, 0, 0.05],
  ["pelvis", 0, 0, -0.03, 0.09],
  ["torso_link", -0.02, 0, 0.12, 0.09], ["torso_link", -0.02, 0, 0.26, 0.1], ["torso_link", 0.01, 0, 0.39, 0.09],
  ["left_shoulder_roll_link", 0, 0, -0.03, 0.05], ["right_shoulder_roll_link", 0, 0, -0.03, 0.05],
  ["left_elbow_link", 0, 0, 0, 0.045], ["right_elbow_link", 0, 0, 0, 0.045],
  ["left_wrist_yaw_link", 0.08, 0, 0, 0.04], ["right_wrist_yaw_link", 0.08, 0, 0, 0.04],
];

// CLAUDE.md hit_joint -> G1 body + point in its frame (palm centers match robot.ts's hand anchors).
const HIT_POINTS: Record<string, [string, Vec3]> = {
  head: ["torso_link", [0.008, 0, 0.384]],
  chest: ["torso_link", [0.03, 0, 0.22]],
  l_hand: ["left_wrist_yaw_link", [0.11, -0.01, 0.01]],
  r_hand: ["right_wrist_yaw_link", [0.11, 0.01, 0.01]],
  l_foot: ["left_ankle_roll_link", [0.04, 0, -0.01]],
  r_foot: ["right_ankle_roll_link", [0.04, 0, -0.01]],
};

type BodyPoint = [number, Vec3]; // body index, local offset
type HitHow = Exclude<Kind, "defend">;

interface Playing {
  move: Move;
  clip: ClipSampler;
  t: number;
  hitT: number;
  hitDone: boolean;
  loudness: number;
  approach: { t: number; x: number; y: number; gap: number } | null; // melee step-in from (x, y) to `gap` from the defender
  spot: [number, number]; // where the defender stood at cast time (strikes)
}

interface Fall { t: number; side: number; ko: boolean; downSent: boolean; } // side: 0 = flat on its back, +-1 = onto its local +-Y side

interface Projectile {
  active: boolean;
  owner: Player;
  move: Move;
  loudness: number;
  pos: Vec3;
  vel: Vec3;
  target: Vec3;   // the defender's chest; stops tracking once they dodge, so a side-step really makes it miss
  locked: boolean;
  missed: boolean;
  ttl: number;
  age: number;
  view: { pos: Vec3; type: MoveType; effect: string; owner: Player };
}

interface Strike { owner: Player; move: Move; loudness: number; t: number; spot: [number, number]; }

class Fighter {
  rules = R.rulesFor("bramble");
  readonly home: [number, number];
  readonly anchor: [number, number] = [0, 0]; // floor point the fighter's local frame sits on
  yaw: number;
  readonly kb: [number, number] = [0, 0];
  hp = R.HP_MAX;
  energy = R.ENERGY_MAX;
  readonly cooldowns: Record<string, number> = {};
  charging = false;
  play: Playing | null = null;
  idleT = 0;
  stun = 0;
  stagT = -1;
  stagAmt = 0;
  invuln = 0;
  dodgeT = -1;
  dodgeSide = 0;
  readonly dodgeFrom: [number, number] = [0, 0];
  readonly dodgeTo: [number, number] = [0, 0];
  block = 0;
  jumpT = -1;
  fall: Fall | null = null;
  ko = false;
  wGuard = 0;
  wCharge = 0;
  blendT = 1;
  pelvisZ = 0.75;
  // pose buffers, reused every step
  readonly base: number[];
  readonly from: number[];
  readonly target: number[];
  readonly posed: number[];
  readonly world: number[];
  readonly poses: BodyPoses;
  readonly bodies: FighterState["bodies"];
  readonly state: FighterState;

  constructor(readonly p: Player, nq: number, names: string[]) {
    this.home = [p === 1 ? -FIGHTER_GAP / 2 : FIGHTER_GAP / 2, 0];
    this.yaw = p === 1 ? 0 : Math.PI;
    this.base = new Array(nq).fill(0);
    this.from = new Array(nq).fill(0);
    this.target = new Array(nq).fill(0);
    this.posed = new Array(nq).fill(0);
    this.world = new Array(nq).fill(0);
    this.poses = { pos: new Float64Array(names.length * 3), quat: new Float64Array(names.length * 4) };
    this.bodies = names.map((name) => ({ name, pos: [0, 0, 0] as Vec3, quat: [1, 0, 0, 0] as Quat }));
    this.state = { bodies: this.bodies, hp: R.HP_MAX, energy: R.ENERGY_MAX, cooldowns: this.cooldowns, status: "idle" };
  }

  restart() {
    this.anchor[0] = this.home[0]; this.anchor[1] = this.home[1];
    this.yaw = this.p === 1 ? 0 : Math.PI;
    this.kb[0] = this.kb[1] = 0;
    this.hp = R.HP_MAX;
    this.energy = R.ENERGY_MAX;
    for (const k in this.cooldowns) delete this.cooldowns[k];
    this.charging = false;
    this.play = null;
    this.idleT = this.p === 1 ? 0 : 0.95; // out of step, so the two idles don't breathe in sync
    this.stun = 0; this.stagT = -1; this.invuln = 0; this.dodgeT = -1; this.block = 0; this.jumpT = -1;
    this.fall = null; this.ko = false;
    this.wGuard = 0; this.wCharge = 0; this.blendT = 1;
  }

  get blocking() {
    return this.block > 0 || this.play?.move.kind === "defend";
  }
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const toward = (v: number, goal: number, step: number) => (v < goal ? Math.min(goal, v + step) : Math.max(goal, v - step));
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const other = (p: Player): Player => (p === 1 ? 2 : 1);

export class StubSim implements Sim {
  /** Characters of the last init() (the mock server's narration reads them: lobby picks never reach the server). */
  static lastCharacters: [string, string] | null = null;
  private readonly kin: Kinematics;
  private readonly kit: PoseKit;
  private readonly free: number;
  private readonly fallback: number[];
  private idleClip: ClipSampler;
  private readonly clips = new WeakMap<Motion, ClipSampler>();
  private cbs: ((e: SimEvent) => void)[] = [];
  private readonly f: Record<Player, Fighter>;
  private readonly pool: Projectile[] = [];
  private readonly projView: Projectile["view"][] = [];
  private strikes: Strike[] = [];
  private queue: SimEvent[] = [];
  private pendingRound: { winner: Player; t: number } | null = null;
  private roundOver = false;
  private time = 0;
  private readonly contacts: [number, number, number, number, number][];
  private readonly hitPoints: Record<string, BodyPoint>;
  private readonly torso: number;
  private readonly pelvis: number;
  private readonly scratch: BodyPoses;
  private readonly tmp: Vec3 = [0, 0, 0];
  private readonly tmp2: Vec3 = [0, 0, 0];

  constructor(model: MjModel) {
    this.kin = new Kinematics(model);
    this.kit = new PoseKit(model);
    this.free = model.joints.find((j) => j.type === "free")?.qposAdr ?? 0;
    this.fallback = (model.keyframes.stand ?? qpos0(model)).slice();
    const names = this.kin.bodyNames;
    this.f = { 1: new Fighter(1, model.nq, names), 2: new Fighter(2, model.nq, names) };
    this.scratch = { pos: new Float64Array(names.length * 3), quat: new Float64Array(names.length * 4) };
    this.torso = Math.max(0, this.kin.bodyIndex("torso_link"));
    this.pelvis = Math.max(0, this.kin.bodyIndex("pelvis"));
    this.contacts = CONTACTS.flatMap(([b, x, y, z, r]) => {
      const i = this.kin.bodyIndex(b);
      return i < 0 ? [] : [[i, x, y, z, r] as [number, number, number, number, number]];
    });
    this.hitPoints = {};
    for (const [k, [b, off]] of Object.entries(HIT_POINTS)) this.hitPoints[k] = [Math.max(0, this.kin.bodyIndex(b)), off];
    for (let i = 0; i < 8; i++) {
      const pos: Vec3 = [0, 0, 0];
      this.pool.push({ active: false, owner: 1, move: null as unknown as Move, loudness: 0.5, pos, vel: [0, 0, 0], target: [0, 0, 0], locked: false, missed: false, ttl: 0, age: 0, view: { pos, type: "physical", effect: "none", owner: 1 } });
    }
    // Until init(): stand in the model's "stand" keyframe so state() is always drawable.
    const hinges = model.joints.filter((j) => j.type !== "free");
    const stand: Motion = { id: "stub_stand", fps: 30, joint_names: hinges.map((j) => j.name), qpos: [[0, 0, this.fallback[this.free + 2] || 0.79, 1, 0, 0, 0, ...hinges.map((j) => this.fallback[j.qposAdr] ?? 0)]] };
    this.idleClip = new ClipSampler(this.kin, stand, this.fallback);
    this.reset();
  }

  async init(idle: Motion, characters: [string, string]) {
    StubSim.lastCharacters = [characters[0], characters[1]];
    this.idleClip = this.sampler(idle);
    this.f[1].rules = R.rulesFor(characters[0]);
    this.f[2].rules = R.rulesFor(characters[1]);
    this.reset();
  }

  canAct(p: Player, move?: Move): boolean {
    const f = this.f[p];
    if (!f || f.ko || f.fall || f.stun > 0 || f.play || f.charging || f.invuln > 0) return false;
    if (!move) return true;
    return !((f.cooldowns[move.id] ?? 0) > 0) && f.energy >= R.energyCost(move);
  }

  setCharging(p: Player, on: boolean) {
    const f = this.f[p];
    if (f) f.charging = on;
  }

  playMove(p: Player, move: Move, motion: Motion, loudness: number): boolean {
    if (!this.canAct(p, move) || !motion?.qpos?.length) return false;
    const f = this.f[p], o = this.f[other(p)];
    const clip = this.sampler(motion);
    f.energy -= R.energyCost(move);
    f.cooldowns[move.id] = R.cooldownFor(move, f.rules);
    f.block = 0;
    const hitT = Math.min(clip.dur, move.hit_frame > 0 ? move.hit_frame / clip.fps : clip.dur * 0.45);
    f.play = { move, clip, t: 0, hitT, hitDone: move.kind === "defend", loudness: R.clamp01(loudness), approach: null, spot: [o.anchor[0], o.anchor[1]] };
    if (move.kind === "melee") {
      // step in so the pelvises are MELEE_GAP apart when the hit lands, counting the motion's own lunge
      const gap = Math.max(MIN_GAP + 0.05, R.MELEE_GAP + clip.travelAt(hitT));
      if (this.anchorDist(f, o) > gap + 0.02) f.play.approach = { t: 0, x: f.anchor[0], y: f.anchor[1], gap };
    }
    this.crossfade(f);
    return true;
  }

  action(p: Player, a: Action): boolean {
    const f = this.f[p];
    if (!f || f.ko || f.fall || f.stun > 0 || f.play || f.charging || f.invuln > 0) return false;
    if (a === "block") {
      f.block = R.BLOCK_S;
      return true;
    }
    if (a === "jump") {
      if (f.jumpT >= 0) return false;
      f.jumpT = 0;
      f.block = 0;
      return true;
    }
    if (a === "dodge_left" || a === "dodge_right") {
      if ((f.cooldowns.dodge ?? 0) > 0) return false;
      const side = a === "dodge_left" ? 1 : -1; // the fighter's left is its local +Y
      f.dodgeSide = side;
      f.dodgeT = 0;
      f.invuln = R.DODGE_S;
      f.cooldowns.dodge = R.DODGE_COOLDOWN * f.rules.cooldown;
      f.block = 0;
      f.dodgeFrom[0] = f.anchor[0]; f.dodgeFrom[1] = f.anchor[1];
      f.dodgeTo[0] = f.anchor[0] - Math.sin(f.yaw) * side * R.DODGE_SLIDE;
      f.dodgeTo[1] = f.anchor[1] + Math.cos(f.yaw) * side * R.DODGE_SLIDE;
      return true;
    }
    return false;
  }

  step(dt: number) {
    if (!(dt > 0)) return;
    dt = Math.min(0.1, dt);
    this.time += dt;
    const a = this.f[1], b = this.f[2];
    this.tick(a, dt); this.tick(b, dt);
    this.travel(a, b, dt); this.travel(b, a, dt);
    this.separate();
    this.pose(a); this.pose(b);
    this.resolveHit(a); this.resolveHit(b);
    this.updateProjectiles(dt);
    this.updateStrikes(dt);
    this.endMove(a); this.endMove(b);
    this.checkDown(a); this.checkDown(b);
    if (this.pendingRound && (this.pendingRound.t -= dt) <= 0) {
      const winner = this.pendingRound.winner;
      this.pendingRound = null;
      this.emit({ kind: "round", winner });
    }
    this.flush();
  }

  state(p: Player): FighterState {
    const f = this.f[p];
    const s = f.state;
    s.hp = f.hp;
    s.energy = Math.round(f.energy * 10) / 10;
    s.status = this.status(f);
    return s;
  }

  projectiles() {
    return this.projView;
  }

  on(cb: (e: SimEvent) => void) {
    this.cbs.push(cb);
  }

  reset() {
    this.f[1].restart();
    this.f[2].restart();
    for (const pr of this.pool) pr.active = false;
    this.projView.length = 0;
    this.strikes = [];
    this.queue = [];
    this.pendingRound = null;
    this.roundOver = false;
    this.pose(this.f[1]);
    this.pose(this.f[2]);
  }

  // ---------- per step ----------
  private tick(f: Fighter, dt: number) {
    f.energy = Math.min(R.ENERGY_MAX, f.energy + R.ENERGY_REFILL * dt);
    for (const k in f.cooldowns) {
      const v = f.cooldowns[k] - dt;
      if (v <= 0) delete f.cooldowns[k];
      else f.cooldowns[k] = v;
    }
    f.stun = Math.max(0, f.stun - dt);
    if (f.stagT >= 0 && (f.stagT += dt) > STAGGER_S) f.stagT = -1;
    f.invuln = Math.max(0, f.invuln - dt);
    if (f.dodgeT >= 0 && (f.dodgeT += dt) > DODGE_HOLD_S) f.dodgeT = -1;
    f.block = Math.max(0, f.block - dt);
    if (f.jumpT >= 0 && (f.jumpT += dt) > R.JUMP_S) f.jumpT = -1;
    if (f.fall) {
      f.fall.t += dt;
      if (!f.fall.ko && f.fall.t >= FALL_END) f.fall = null;
    }
    if (f.play) f.play.t += dt;
    else f.idleT += dt;
    f.blendT = Math.min(1, f.blendT + dt / BLEND_S);
    f.wGuard = toward(f.wGuard, f.block > 0 ? 1 : 0, dt / (f.block > 0 ? 0.08 : 0.15));
    f.wCharge = toward(f.wCharge, f.charging && !f.play && !f.fall && !f.ko ? 1 : 0, dt / 0.2);
  }

  /** CLAUDE.md: knockdown = pelvis below 0.4 m. `down` goes out as the falling body crosses it. */
  private checkDown(f: Fighter) {
    if (f.fall && !f.fall.downSent && f.pelvisZ < R.DOWN_PELVIS_Z) {
      f.fall.downSent = true;
      this.emit({ kind: "down", player: f.p });
    }
  }

  /** Facing, melee step-in, dodge slide, knockback, drifting home. */
  private travel(f: Fighter, o: Fighter, dt: number) {
    if (!f.fall && !f.ko) {
      const want = Math.atan2(o.anchor[1] - f.anchor[1], o.anchor[0] - f.anchor[0]);
      f.yaw = wrapPi(f.yaw + wrapPi(want - f.yaw) * (1 - Math.exp(-dt * 10)));
    }
    f.anchor[0] += f.kb[0] * dt;
    f.anchor[1] += f.kb[1] * dt;
    const decay = Math.exp(-dt * KB_DECAY);
    f.kb[0] *= decay;
    f.kb[1] *= decay;
    const ap = f.play?.approach;
    if (ap) {
      if (ap.t < 1) {
        ap.t = Math.min(1, ap.t + dt / APPROACH_S);
        const dx = f.anchor[0] - o.anchor[0], dy = f.anchor[1] - o.anchor[1];
        const d = Math.hypot(dx, dy) || 1;
        const tx = o.anchor[0] + (dx / d) * ap.gap, ty = o.anchor[1] + (dy / d) * ap.gap;
        const u = smooth(ap.t);
        f.anchor[0] = ap.x + (tx - ap.x) * u;
        f.anchor[1] = ap.y + (ty - ap.y) * u;
      }
      return; // hold the spot until the move ends
    }
    if (f.dodgeT >= 0) {
      if (f.dodgeT < DODGE_SLIDE_S) {
        const u = 1 - (1 - f.dodgeT / DODGE_SLIDE_S) ** 2;
        f.anchor[0] = f.dodgeFrom[0] + (f.dodgeTo[0] - f.dodgeFrom[0]) * u;
        f.anchor[1] = f.dodgeFrom[1] + (f.dodgeTo[1] - f.dodgeFrom[1]) * u;
      }
      return;
    }
    if (f.ko || f.fall) return;
    const k = 1 - Math.exp(-dt * HOME_RATE);
    f.anchor[0] += (f.home[0] - f.anchor[0]) * k;
    f.anchor[1] += (f.home[1] - f.anchor[1]) * k;
  }

  /** Keeps the fighters in the ring and out of each other (anchors, and last step's standing pelvises). */
  private separate() {
    const fa = this.f[1], fb = this.f[2], a = fa.anchor, b = fb.anchor;
    a[0] = Math.min(2.4, Math.max(-2.4, a[0])); a[1] = Math.min(1.5, Math.max(-1.5, a[1]));
    b[0] = Math.min(2.4, Math.max(-2.4, b[0])); b[1] = Math.min(1.5, Math.max(-1.5, b[1]));
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const d = Math.hypot(dx, dy);
    let push = d < MIN_GAP ? (MIN_GAP - d) / 2 : 0;
    if (!fa.fall && !fb.fall) { // motions lunge on their own: ease overlapping bodies apart
      const pa = fa.bodies[this.pelvis].pos, pb = fb.bodies[this.pelvis].pos;
      const pd = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (pd < MIN_PELVIS_GAP) push = Math.max(push, Math.min(0.02, (MIN_PELVIS_GAP - pd) / 2));
    }
    if (push <= 0) return;
    const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0;
    a[0] -= ux * push; a[1] -= uy * push;
    b[0] += ux * push; b[1] += uy * push;
  }

  /** Builds this step's world pose: motion (crossfaded) + procedural layers, tilted, placed, grounded, FK. */
  private pose(f: Fighter) {
    const kit = this.kit, r = this.free;
    if (f.play) f.play.clip.sample(Math.min(f.play.t, f.play.clip.dur), false, f.target);
    else this.idleClip.sample(f.idleT, true, f.target);
    if (f.blendT < 1) mixQpos(f.from, f.target, smooth(f.blendT), f.base, r);
    else for (let i = 0; i < f.base.length; i++) f.base[i] = f.target[i];

    const q = f.posed;
    for (let i = 0; i < q.length; i++) q[i] = f.base[i];
    let pitch = 0, roll = 0, crouch = 0, tuck = 0, zoff = 0, pivX = -0.06, pivY = 0;
    if (f.wGuard > 0) {
      const w = smooth(f.wGuard);
      kit.blend(q, kit.block, w);
      crouch += 0.12 * w;
      pitch -= 0.07 * w;
    }
    if (f.wCharge > 0) {
      const w = smooth(f.wCharge);
      kit.blend(q, kit.charge, w);
      crouch += (0.1 + 0.05 * Math.sin(this.time * 7 + f.p)) * w;
    }
    if (f.stagT >= 0) {
      const u = f.stagT / STAGGER_S;
      const e = f.stagAmt * (u < 0.18 ? u / 0.18 : (1 - (u - 0.18) / 0.82) ** 2);
      kit.add(q, kit.stagger, e);
      pitch -= 0.24 * e;
    }
    if (f.dodgeT >= 0 && f.dodgeT < DODGE_LEAN_S) {
      const e = Math.sin((Math.PI * f.dodgeT) / DODGE_LEAN_S);
      crouch += 0.32 * e;
      roll -= f.dodgeSide * 0.16 * e;
    }
    if (f.jumpT >= 0) {
      const t = f.jumpT;
      if (t < JUMP_PRE) crouch += 0.28 * smooth(t / JUMP_PRE);
      else if (t < JUMP_PRE + JUMP_AIR) {
        const u = (t - JUMP_PRE) / JUMP_AIR;
        zoff = JUMP_H * 4 * u * (1 - u);
        tuck = 0.5 * Math.sin(Math.PI * u);
        crouch += 0.28 * Math.max(0, 1 - u * 5);
      } else crouch += 0.28 * Math.sin(Math.PI * Math.min(1, (t - JUMP_PRE - JUMP_AIR) / (R.JUMP_S - JUMP_PRE - JUMP_AIR)));
    }
    const fa = this.fallAngle(f);
    if (fa > 0) {
      const side = f.fall?.side ?? 0;
      kit.blend(q, side ? kit.limpSide : kit.limp, Math.min(1, (fa / FALL_ANGLE) * 1.3));
      if (side) { roll -= side * fa; pivX = 0; pivY = side * 0.17; } // topples onto a side
      else pitch -= fa;                                               // flat on its back
    }
    kit.crouch(q, crouch + tuck);
    kit.clamp(q);

    // Keep the motion's own height above the floor (its hops), plus our hop; everything else rests on the floor.
    const baseLow = this.lowest(this.kin.forward(f.base, this.scratch));
    this.place(f, q, pitch, roll, pivX, pivY);
    this.kin.forward(f.world, f.poses);
    const lift = Math.max(0, baseLow) + zoff + 0.75 * (1 - Math.cos(tuck)) - this.lowest(f.poses);
    const P = f.poses;
    for (let i = 0; i < f.bodies.length; i++) {
      const b = f.bodies[i];
      b.pos[0] = P.pos[i * 3]; b.pos[1] = P.pos[i * 3 + 1]; b.pos[2] = P.pos[i * 3 + 2] + lift;
      b.quat[0] = P.quat[i * 4]; b.quat[1] = P.quat[i * 4 + 1]; b.quat[2] = P.quat[i * 4 + 2]; b.quat[3] = P.quat[i * 4 + 3];
    }
    f.pelvisZ = f.bodies[this.pelvis].pos[2];
  }

  /** Root: tilt (pitch about local Y, roll about local X) around a floor pivot, then yaw and the anchor. */
  private place(f: Fighter, q: number[], pitch: number, roll: number, pivX: number, pivY: number) {
    const r = this.free, w = f.world;
    for (let i = 0; i < q.length; i++) w[i] = q[i];
    const cy = Math.cos(pitch / 2), sy = Math.sin(pitch / 2), cx = Math.cos(roll / 2), sx = Math.sin(roll / 2);
    const tw = cy * cx, tx = cy * sx, ty = sy * cx, tz = -sy * sx; // R_y(pitch) * R_x(roll)
    const px = q[r] + pivX, py = q[r + 1] + pivY;
    const v = rot(tw, tx, ty, tz, q[r] - px, q[r + 1] - py, q[r + 2], this.tmp);
    const lx = px + v[0], ly = py + v[1], lz = v[2];
    const qw = q[r + 3], qx = q[r + 4], qy = q[r + 5], qz = q[r + 6];
    const aw = tw * qw - tx * qx - ty * qy - tz * qz;
    const ax = tw * qx + tx * qw + ty * qz - tz * qy;
    const ay = tw * qy - tx * qz + ty * qw + tz * qx;
    const az = tw * qz + tx * qy - ty * qx + tz * qw;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
    w[r] = f.anchor[0] + c * lx - s * ly;
    w[r + 1] = f.anchor[1] + s * lx + c * ly;
    w[r + 2] = lz;
    const hw = Math.cos(f.yaw / 2), hz = Math.sin(f.yaw / 2); // (hw, 0, 0, hz) * a
    w[r + 3] = hw * aw - hz * az;
    w[r + 4] = hw * ax - hz * ay;
    w[r + 5] = hw * ay + hz * ax;
    w[r + 6] = hw * az + hz * aw;
  }

  /** Lowest point of the body (contact spheres) for a set of body poses. */
  private lowest(P: BodyPoses): number {
    let low = Infinity;
    for (const [b, x, y, z, rad] of this.contacts) {
      const qw = P.quat[b * 4], qx = P.quat[b * 4 + 1], qy = P.quat[b * 4 + 2], qz = P.quat[b * 4 + 3];
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      const h = P.pos[b * 3 + 2] + z + qw * tz + (qx * ty - qy * tx) - rad;
      if (h < low) low = h;
    }
    return low === Infinity ? 0 : low;
  }

  private fallAngle(f: Fighter): number {
    const fl = f.fall;
    if (!fl) return 0;
    const t = fl.t;
    if (t < FALL_S) return FALL_ANGLE * (t / FALL_S) ** 2; // gravity-ish: slow start, fast landing
    if (t < FALL_S + BOUNCE_S) return FALL_ANGLE - 0.07 * Math.sin((Math.PI * (t - FALL_S)) / BOUNCE_S);
    if (fl.ko || t < LIE_END) return FALL_ANGLE;
    return FALL_ANGLE * (1 - smooth((t - LIE_END) / GETUP_S));
  }

  private crossfade(f: Fighter) {
    for (let i = 0; i < f.base.length; i++) f.from[i] = f.base[i];
    f.blendT = 0;
  }

  // ---------- outcomes ----------
  private resolveHit(f: Fighter) {
    const pl = f.play;
    if (!pl || pl.hitDone || pl.t < pl.hitT) return;
    pl.hitDone = true;
    const o = this.f[other(f.p)], m = pl.move;
    switch (m.kind) {
      case "melee":
        if (this.pelvisDist(f, o) <= R.MELEE_RANGE) this.land(f, o, m, pl.loudness, "melee", this.point(f, this.hitPoint(m.hit_joint), this.tmp2));
        break;
      case "projectile":
        this.spawn(f, m, pl.loudness);
        break;
      case "strike":
        this.strikes.push({ owner: f.p, move: m, loudness: pl.loudness, t: R.STRIKE_DELAY, spot: pl.spot });
        break;
      case "shockwave":
        if (this.anchorDist(f, o) <= R.SHOCKWAVE_RADIUS) this.land(f, o, m, pl.loudness, "shockwave", null);
        break;
    }
  }

  /** Applies one attack to the defender. Returns false when it found nothing to hit (dodged, down, round over). */
  private land(att: Fighter, def: Fighter, move: Move, loudness: number, how: HitHow, at: Vec3 | null): boolean {
    if (this.roundOver || def.ko || def.fall) return false; // stub rule: a fighter on the floor can't be hit
    const airborne = def.jumpT >= JUMP_PRE && def.jumpT < JUMP_PRE + JUMP_AIR;
    if (def.invuln > 0 || (how === "shockwave" && airborne)) {
      this.emit({ kind: "dodged", defender: def.p });
      return false;
    }
    const blocked = def.blocking;
    const clean = !blocked && how === "melee" && !!at && this.nearHeadOrChest(def, at);
    const dmg = R.damageFor(move, att.rules, def.rules, loudness, clean, blocked);
    def.hp = Math.max(0, def.hp - dmg);
    const point = this.contactPoint(att, def, how, at, blocked);
    let dx = def.anchor[0] - att.anchor[0], dy = def.anchor[1] - att.anchor[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    let push: number;
    if (blocked) {
      this.emit({ kind: "blocked", defender: def.p, point });
      push = 0.05;
    } else {
      this.emit({ kind: "hit", attacker: att.p, damage: dmg, type: move.type, clean, point });
      def.stun = R.STUN_S;
      def.stagT = 0;
      def.stagAmt = Math.min(1, 0.35 + dmg / 30);
      push = Math.min(0.45, how === "shockwave" ? 0.12 + dmg * 0.012 : 0.05 + dmg * 0.008);
    }
    if (def.hp <= 0) this.knockOut(def, att);
    // stub rule: a signature move that lands always knocks down ("a signature move landing with a real fall"
    // is a CLAUDE.md demo moment; a judge's Forge move often deals well under KNOCKDOWN_DAMAGE)
    else if (!blocked && (dmg >= R.KNOCKDOWN_DAMAGE || (clean && move.power === 3) || move.signature)) {
      this.knockDown(def, false);
      push = Math.max(push, 0.3);
    }
    def.kb[0] += dx * push * KB_DECAY;
    def.kb[1] += dy * push * KB_DECAY;
    return true;
  }

  private knockDown(f: Fighter, side: boolean) {
    // side falls go toward world +Y, away from the camera, so they never hide the other fighter
    f.fall = { t: 0, side: side ? (Math.cos(f.yaw) >= 0 ? 1 : -1) : 0, ko: false, downSent: false };
    this.interrupt(f);
  }

  private knockOut(def: Fighter, att: Fighter) {
    def.ko = true;
    def.fall = { t: 0, side: 0, ko: true, downSent: true };
    this.interrupt(def);
    this.roundOver = true;
    this.emit({ kind: "ko", loser: def.p });
    this.pendingRound = { winner: att.p, t: R.KO_TO_ROUND_S };
  }

  private interrupt(f: Fighter) {
    if (f.play) this.crossfade(f);
    f.play = null;
    f.block = 0; f.jumpT = -1; f.dodgeT = -1; f.invuln = 0; f.stun = 0; f.stagT = -1;
  }

  private endMove(f: Fighter) {
    const pl = f.play;
    if (!pl || pl.t < pl.clip.dur) return;
    f.play = null;
    this.crossfade(f);
    // stub rule for "big moves can tip your own robot over"
    if (pl.move.power === 3 && pl.move.stability < R.SELF_TIP_STABILITY && !f.fall && !f.ko) this.knockDown(f, true);
  }

  private spawn(f: Fighter, move: Move, loudness: number) {
    const pr = this.pool.find((x) => !x.active);
    if (!pr) return;
    this.point(f, this.hitPoint(move.hit_joint), pr.pos);
    pr.active = true;
    pr.owner = f.p;
    pr.move = move;
    pr.loudness = loudness;
    pr.missed = false;
    pr.locked = false;
    this.point(this.f[other(f.p)], this.hitPoints.chest, pr.target);
    pr.ttl = 0;
    pr.age = 0;
    pr.vel[0] = Math.cos(f.yaw) * R.PROJECTILE_SPEED; pr.vel[1] = Math.sin(f.yaw) * R.PROJECTILE_SPEED; pr.vel[2] = 0;
    pr.view.owner = f.p;
    pr.view.type = move.type;
    pr.view.effect = move.effect && move.effect !== "none" ? move.effect : TYPE_EFFECT[move.type] ?? "none";
  }

  private updateProjectiles(dt: number) {
    for (const pr of this.pool) {
      if (!pr.active) continue;
      pr.age += dt;
      if (!pr.missed) {
        const def = this.f[other(pr.owner)];
        const c = this.point(def, this.hitPoints.chest, this.tmp);
        if (def.invuln > 0) pr.locked = true;
        if (!pr.locked) { pr.target[0] = c[0]; pr.target[1] = c[1]; pr.target[2] = c[2]; }
        const dx = pr.target[0] - pr.pos[0], dy = pr.target[1] - pr.pos[1], dz = pr.target[2] - pr.pos[2];
        const d = Math.hypot(dx, dy, dz);
        if (d <= ARRIVE_R + R.PROJECTILE_SPEED * dt) {
          const k = d > ARRIVE_R ? (d - ARRIVE_R) / d : 0;
          pr.pos[0] += dx * k; pr.pos[1] += dy * k; pr.pos[2] += dz * k;
          const there = Math.hypot(c[0] - pr.target[0], c[1] - pr.target[1], c[2] - pr.target[2]) < DODGE_CLEAR;
          if (there && this.land(this.f[pr.owner], def, pr.move, pr.loudness, "projectile", pr.pos)) { pr.active = false; continue; }
          if (!there && !this.roundOver && !def.ko && !def.fall) this.emit({ kind: "dodged", defender: def.p }); // slid out of its path
          pr.missed = true; // dodged, or nobody to hit: sail on past and fade
          pr.ttl = 0.4;
        } else if (d > 1e-6) {
          pr.vel[0] = (dx / d) * R.PROJECTILE_SPEED; pr.vel[1] = (dy / d) * R.PROJECTILE_SPEED; pr.vel[2] = (dz / d) * R.PROJECTILE_SPEED;
        }
      } else if ((pr.ttl -= dt) <= 0) {
        pr.active = false;
        continue;
      }
      pr.pos[0] += pr.vel[0] * dt; pr.pos[1] += pr.vel[1] * dt; pr.pos[2] += pr.vel[2] * dt;
      if (pr.age > 3) pr.active = false;
    }
    this.projView.length = 0;
    for (const pr of this.pool) if (pr.active) this.projView.push(pr.view);
  }

  private updateStrikes(dt: number) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if ((s.t -= dt) > 0) continue;
      this.strikes.splice(i, 1);
      const att = this.f[s.owner], def = this.f[other(s.owner)];
      if (this.roundOver || def.ko || def.fall) continue;
      if (Math.hypot(def.anchor[0] - s.spot[0], def.anchor[1] - s.spot[1]) > R.STRIKE_RADIUS) {
        this.emit({ kind: "dodged", defender: def.p }); // stepped out from under it
        continue;
      }
      this.land(att, def, s.move, s.loudness, "strike", null);
    }
  }

  // ---------- geometry ----------
  private hitPoint(joint: string): BodyPoint {
    const hp = this.hitPoints[joint];
    if (hp) return hp;
    const i = this.kin.bodyIndex(joint); // also accept a G1 body name
    return i >= 0 ? (this.hitPoints[joint] = [i, [0, 0, 0]]) : this.hitPoints.chest;
  }

  /** World position of a point on one of the fighter's bodies (this step's pose). */
  private point(f: Fighter, [b, off]: BodyPoint, out: Vec3): Vec3 {
    const body = f.bodies[b];
    const v = rot(body.quat[0], body.quat[1], body.quat[2], body.quat[3], off[0], off[1], off[2], out);
    v[0] += body.pos[0]; v[1] += body.pos[1]; v[2] += body.pos[2];
    return v;
  }

  private nearHeadOrChest(def: Fighter, at: Vec3): boolean {
    const near = (bp: BodyPoint) => {
      const c = this.point(def, bp, this.tmp);
      return Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) <= R.CLEAN_DIST;
    };
    return near(this.hitPoints.head) || near(this.hitPoints.chest);
  }

  /** Where the effect plays: on the defender's front at the hit's height (or the guard, or the head for strikes). */
  private contactPoint(att: Fighter, def: Fighter, how: HitHow, at: Vec3 | null, blocked: boolean): Vec3 {
    if (how === "projectile" && at && !blocked) return [at[0], at[1], at[2]];
    const t = def.bodies[this.torso].pos, pv = def.bodies[this.pelvis].pos;
    const head = this.point(def, this.hitPoints.head, this.tmp);
    if (how === "strike" && !blocked) return [head[0], head[1], head[2] + 0.1];
    let h = blocked ? head[2] - 0.08 : how === "shockwave" ? 0.5 : at ? at[2] : t[2] + 0.25;
    h = Math.min(head[2], Math.max(pv[2] - 0.15, h));
    const ap = att.bodies[this.pelvis].pos;
    let dx = ap[0] - t[0], dy = ap[1] - t[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const r = blocked ? 0.22 : 0.12;
    return [t[0] + dx * r, t[1] + dy * r, h];
  }

  private pelvisDist(a: Fighter, b: Fighter) {
    const p = a.bodies[this.pelvis].pos, q = b.bodies[this.pelvis].pos;
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  }

  private anchorDist(a: Fighter, b: Fighter) {
    return Math.hypot(a.anchor[0] - b.anchor[0], a.anchor[1] - b.anchor[1]);
  }

  // ---------- misc ----------
  private status(f: Fighter): Status {
    if (f.ko) return "ko";
    if (f.fall) return "down";
    if (f.stun > 0) return "stunned";
    if (f.invuln > 0) return "dodging";
    if (f.blocking) return "blocking";
    if (f.charging) return "charging";
    if (f.play) return "acting";
    return "idle";
  }

  private sampler(m: Motion): ClipSampler {
    let c = this.clips.get(m);
    if (!c) this.clips.set(m, (c = new ClipSampler(this.kin, m, this.fallback)));
    return c;
  }

  private emit(e: SimEvent) {
    this.queue.push(e);
  }

  // Events go out after the step, so listeners never see a half-updated sim.
  private flush() {
    if (!this.queue.length) return;
    const q = this.queue;
    this.queue = [];
    for (const e of q) for (const cb of this.cbs) {
      try { cb(e); } catch (err) { console.error("sim event listener failed", err); }
    }
  }
}

/** Rotates v by the unit quaternion (w, x, y, z) into out. */
function rot(w: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Vec3): Vec3 {
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** The crossfade: out = lerp(a, b, u) for joints and root position, slerp for the root quaternion. */
function mixQpos(a: number[], b: number[], u: number, out: number[], r: number) {
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * u;
  const q = slerp([a[r + 3], a[r + 4], a[r + 5], a[r + 6]], [b[r + 3], b[r + 4], b[r + 5], b[r + 6]], u);
  for (let k = 0; k < 4; k++) out[r + 3 + k] = q[k];
}
