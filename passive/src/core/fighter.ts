// One fighter: what it does between moves and how it reacts to the other fighter.
// SONIC balances; a MotionSource (the SONIC planner now, Kimodo clips later) writes the motion it
// follows; short overlays (flinches, guards, slips, ducks) are layered on top of that motion.
//
// Stances and how each one ends (every stance has a time limit, see LIMITS):
//   idle      footwork: hold range, circle, bounce, stay off the ropes
//   stagger   just got hit; SONIC catches its balance              -> idle
//   defend    block / duck / dodge / jump                           -> idle
//   move      a punch (step in, then throw) or a clip from playMove -> idle when it ends
//   falling   lost balance or knocked down                          -> down once it settles
//   down      lying there for a beat                                -> rising
//   rising    staged get-up (onto knees, then stand)                -> idle, untouchable for a moment
//   ko        folds at the knees, then goes limp; down until the arena resets
//
// Motion requests are asynchronous. Each carries a token: an answer is used only if it is still
// the newest request, nothing reset the fighter since it was asked (gen), and the fighter still
// wants it (stillWants). A request that never comes back is dropped after TUNE.askTimeout.
import { type Attack, pushDirection } from "./attacks.ts";
import { BodyMap, type Zone } from "./body.ts";
import type { Combat, HitResult, Impact } from "./combat.ts";
import type { ArenaEvent, Who, WhiffReason } from "./events.ts";
import { DEFAULT_ANGLES, NJ } from "./g1.ts";
import { axisAngleQuat, clamp, dist2, finite3, qmul, tiltOf, yawOf } from "./math.ts";
import type { MotionAsk, MotionClip, MotionName, MotionSource, StrikeWindow } from "./motion.ts";
import { contextFromReference } from "./planner.ts";
import { type Frame, REF_HZ, Reference, copyFrame, mixFrames, poseFrame, resample, sanitizeFrames, waistToHips } from "./reference.ts";
import { RING_RADIUS } from "./scene.ts";
import { SonicController, type SonicPolicy } from "./sonic.ts";
import { type MoveSpec, SPELL, checkSpec } from "./spells.ts";
import type { RobotHandle, World } from "./world.ts";

export type Stance = "idle" | "stagger" | "defend" | "move" | "falling" | "down" | "rising" | "ko";
export type Defense = "block" | "duck" | "dodge.left" | "dodge.right" | "dodge.back" | "jump";
export type PunchName = "punch.leftJab" | "punch.rightJab" | "punch.leftHook" | "punch.rightHook";
export const PUNCHES: readonly PunchName[] = ["punch.leftJab", "punch.rightJab", "punch.leftHook", "punch.rightHook"];
export const DEFENSES: readonly Defense[] = ["block", "duck", "dodge.left", "dodge.right", "dodge.back", "jump"];

/** Every stance change the fighter makes. Anything else is a bug (the stress test counts them). */
export const TRANSITIONS: Record<Stance, readonly Stance[]> = {
  idle: ["stagger", "defend", "move", "falling", "ko"],
  stagger: ["idle", "stagger", "falling", "ko"],
  defend: ["idle", "stagger", "move", "falling", "ko"],
  move: ["idle", "stagger", "defend", "falling", "ko"],
  falling: ["down", "ko"],
  down: ["rising", "ko"],
  rising: ["idle", "ko"],
  ko: [],
};

/** Longest a stance may last before the fighter is forced out of it (s). */
export const LIMITS: Record<Stance, number> = {
  idle: Infinity, stagger: 1.2, defend: 1.6, move: 6, falling: 3, down: 1.6, rising: 22, ko: Infinity,
};

export const TUNE = {
  fallTiltRel: 0.8,   // rad more tilted than the motion it follows = lost balance
  fallTiltAbs: 1.25,  // rad tilted = lost balance, whatever the motion says
  fallDrop: 0.3,      // m lower than the motion's pelvis = lost balance
  downHeight: 0.4,    // m pelvis
  downBeat: 1.1,      // s on the floor before getting up
  upHeight: 0.66,     // m pelvis that counts as standing
  grace: 1.0,         // s untouchable after getting up
  range: [1.1, 1.6] as [number, number],     // preferred distance to the opponent (pelvis to pelvis, m)
  rangeDown: [1.6, 2.4] as [number, number], // ... while the opponent is down
  crowd: 0.85,        // closer than this: step back right away
  // pelvis distance each punch is thrown from (the punch itself lunges in about 0.1 m)
  punchRange: { "punch.leftJab": 0.66, "punch.rightJab": 0.66, "punch.leftHook": 0.72, "punch.rightHook": 0.72 } as Record<PunchName, number>,
  approachTime: 2.4,  // s of stepping in before throwing anyway (time spent waiting on a late plan does not count)
  punchRecover: 0.35, // s after the strike window before footwork takes over again
  knockdownImpulse: 55, knockdownPush: 30, pulse: 0.08, maxImpulse: 150,
  poiseRegen: 0.2, poiseDelay: 2,  // balance comes back at 0.2/s once 2 s pass without a hit
  standHelp: 0.15, retryHelp: 0.3,
  assistAfter: 12,    // s of failed get-up before the full assisted lift
  getupSeed: 1234 as number | null, // planner seed for get-ups (null: a new one each time)
  askTimeout: 4,      // s before a motion request is given up on
  koSlump: 1.2,       // s a KO'd body folds before it goes limp
  maxClip: 5,         // s, longest clip playMove accepts
  reanchor: 0.25,     // m the motion may drift from the body before it is moved back
  blockArc: (110 * Math.PI) / 180, // a block covers strikes coming from within this of where the pelvis points
  // Guard tuck: joint offsets (rad, MuJoCo signs) added to the motion's arms while idle, staggered
  // or defending, eased in and out over `ease` s (see updateOverlays). The planner's guard flares
  // the elbows (0.39 m apart) with the gloves touching (0.09 m) at the nose. Shoulder roll pulls the
  // elbows in to the ribs (~0.30 m apart), shoulder yaw turns the forearms out so the gloves part
  // (~0.21 m), and shoulder pitch lowers them to the chin (~5-7 cm below the head's centre). Uneven
  // left/right because the planner's orthodox stance sits the whole guard to the right of the face.
  // It eases out while blocking, so a block keeps its own arm raise.
  // `joints` is scaled by each fighter's guardTuck strength (a bulky character tucks less), `lower`
  // (the chin height) isn't.
  guardTuck: {
    ease: 0.2,
    joints: { shRollL: -0.35, shRollR: 0.55, shYawL: 0.45, shYawR: -0.15 } as Partial<Record<keyof typeof J, number>>,
    lower: { shPitchL: 0.25, shPitchR: 0.25 } as Partial<Record<keyof typeof J, number>>,
  },
};

// Arms forward and knees soft: what the robot reaches for while it goes down.
const BRACE = DEFAULT_ANGLES.slice();
BRACE[0] = BRACE[6] = -0.6; BRACE[3] = BRACE[9] = 1.1; BRACE[4] = BRACE[10] = -0.5;
BRACE[15] = BRACE[22] = -1.1; BRACE[18] = BRACE[25] = 0.5;
BRACE[16] = 0.35; BRACE[23] = -0.35;

// Knees buckling, arms half up: a knocked-out body folding, not a plank tipping over.
const CRUMPLE = DEFAULT_ANGLES.slice();
CRUMPLE[0] = CRUMPLE[6] = -0.9; CRUMPLE[3] = CRUMPLE[9] = 1.6; CRUMPLE[4] = CRUMPLE[10] = -0.6;
CRUMPLE[14] = 0.3;
CRUMPLE[15] = CRUMPLE[22] = -0.6; CRUMPLE[18] = CRUMPLE[25] = 0.9;

// Joint indices (MuJoCo order) used by overlays. Hip pitch negative and knee positive bend the
// legs; shoulder pitch negative raises the arm forward; elbow negative bends it further.
const J = { hipL: 0, kneeL: 3, ankleL: 4, hipR: 6, kneeR: 9, ankleR: 10, shPitchL: 15, shRollL: 16, shYawL: 17, elbowL: 18, shPitchR: 22, shRollR: 23, shYawR: 24, elbowR: 25 };

/** An overlay: a tilt of the whole reference body and/or joint offsets, shaped attack-hold-release. */
interface Effect { tag: "defense" | "flinch"; t: number; dur: number; attack: number; release: number; tilt?: { axis: number[]; angle: number }; joints?: Float64Array }

function jointOffsets(pairs: [number, number][], scale = 1): Float64Array {
  const j = new Float64Array(NJ);
  for (const [i, v] of pairs) j[i] = v * scale;
  return j;
}

interface Pulse { body: number; local: number[]; force: number[]; left: number }
type Purpose = "footwork" | "approach" | "punch" | "defense" | "stagger" | "getup";
interface AskOpts { move?: [number, number]; speed?: number; facing?: [number, number]; fromRobot?: boolean; stage?: number; seed?: number }
interface Inflight { token: number; purpose: Purpose; stage: number; at: number; onFail: () => void }
/** Stepping in before an attack: s spent stepping, s spent standing waiting for a step plan, whether a step was asked for. */
interface Approach { approachT: number; waitT: number; stepping: boolean }
interface Punch extends Approach { name: PunchName; power: number; phase: "approach" | "throw" }
/** A spell or other server move (spells.ts): its clip, when it hits, and (melee) its step-in. */
interface Spell extends Approach { spec: NonNullable<ReturnType<typeof checkSpec>>; frames: Frame[]; hitT: number; phase: "approach" | "cast"; gap: number }
interface Move { name: string; endT: number; punch: Punch | null; spell?: Spell | null }

const freshRise = () => ({ stage: 0, stageT: 0, tries: 0, fails: 0, failed: false, assist: 0, cap: 0, startT: 0 });

export interface FighterContext {
  index: Who;
  world: World;
  robot: RobotHandle;
  policy: SonicPolicy;
  combat: Combat;
  clock: () => number;
  /** Where events go. */
  emit: (e: ArenaEvent) => void;
  /** Runs a state change, holding events until it's done (the arena's; default: run it as is). */
  batch?: <T>(fn: () => T) => T;
  seed: number;
}

export class Fighter {
  readonly index: Who;
  readonly name: string;
  readonly robot: RobotHandle;
  readonly ctl: SonicController;
  readonly body: BodyMap;
  /** What SONIC follows (the motion with its waist lean moved into the hips). */
  readonly ref: Reference;
  /** The motion as the source wrote it; plans continue from this. */
  readonly raw: Reference;
  stance: Stance = "idle";
  stanceT = 0;
  opponent!: Fighter;
  motion: MotionSource | null = null;
  /** 0..1 balance; hits drain it, it refills when left alone; at 0 the fighter goes down. */
  poise = 1;
  intent = "";
  lastEvent = "";
  /**
   * How far this fighter tucks its elbows in its guard (TUNE.guardTuck.joints): 1 for a slim build,
   * less for a bulky one (armour) so its arms clear its body. Set from the character; 0..1.5.
   */
  guardTuck = 1;
  /** Counts attacks started, so the AI can tell a new attack from one it already reacted to. */
  attackSerial = 0;
  readonly stats = { applied: 0, staleDrops: 0, failedAsks: 0, noMotion: 0, askTimeouts: 0, failsafes: 0, getups: 0, assisted: 0, badTransitions: 0, errors: 0 };
  lastBadTransition = "";

  private world: World;
  private combat: Combat;
  private clock: () => number;
  private emit: (e: ArenaEvent) => void;
  private batch: <T>(fn: () => T) => T;
  /** Bumped by spawn and rollback: anything begun before belongs to a fighter that's gone. */
  private epoch = 0;
  private gen = 0;
  private reqToken = 0;
  private inflight: Inflight | null = null;
  private nextFootworkAt = 0;
  private sawAttack = false;
  private circleDir = 1;
  private seed: number;
  private hist: Frame[] = [];
  private pulses: Pulse[] = [];
  private effects: Effect[] = [];
  /** 0..1, how much of TUNE.guardTuck is on (see updateOverlays). */
  private tuck = 0;
  private lastHitT = -Infinity;
  private graceUntil = 0;
  private staggerFor = 0;
  private defense: { kind: Defense; until: number } | null = null;
  private move: Move | null = null;
  private rise = freshRise();
  private mass = 0;
  /** Sim time at which frame `ref.now` plays. */
  private nowT = 0;
  private lastErrorT = -Infinity;

  constructor(name: string, ctx: FighterContext) {
    this.index = ctx.index;
    this.name = name;
    this.world = ctx.world;
    this.robot = ctx.robot;
    this.combat = ctx.combat;
    this.clock = ctx.clock;
    this.emit = ctx.emit;
    this.batch = ctx.batch ?? ((fn) => fn());
    this.seed = Math.max(1, Math.floor(Math.abs(ctx.seed)) % 2147483646 || 1);
    this.ctl = new SonicController(ctx.world, ctx.robot, ctx.policy);
    this.ref = new Reference(ctx.world.robotQpos(ctx.robot));
    this.raw = new Reference(ctx.world.robotQpos(ctx.robot));
    this.body = new BodyMap(ctx.world, ctx.robot);
    for (const b of ctx.robot.bodyIds) this.mass += ctx.world.model.body_mass[b];
  }

  // ================= public: setup and actions =================

  /** Stands the fighter at (x, y) facing `yaw`, forgetting everything in progress; untouchable for `grace` s. */
  spawn(x: number, y: number, yaw: number, grace = 0) { this.run(() => this.spawnNow(x, y, yaw, grace)); }
  private spawnNow(x: number, y: number, yaw: number, grace: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0; y = 0; }
    if (!Number.isFinite(yaw)) yaw = 0;
    this.gen++; // every pending answer is now stale
    this.epoch++;
    const pose = this.world.placeStanding(this.robot, x, y, yaw, DEFAULT_ANGLES);
    this.ref.replace([pose], this.ref.now);
    this.raw.replace([copyFrame(pose)], this.raw.now);
    this.ctl.active = true; this.ctl.hold = null; this.ctl.stiffness = 1;
    this.ctl.reset();
    this.ctl.worldHeading();
    this.body.invalidate();
    this.combat.disarm(this, "interrupted", true);
    this.pulses = []; this.hist = []; this.effects = []; this.tuck = 0;
    this.inflight = null; this.move = null; this.defense = null;
    this.poise = 1; this.lastHitT = -Infinity;
    this.graceUntil = this.clock() + (Number.isFinite(grace) ? Math.max(0, grace) : 0);
    this.rise = freshRise();
    this.nextFootworkAt = 0;
    this.nowT = this.clock();
    this.forceStance("idle");
    this.intent = "ready";
    this.lastEvent = "";
    this.emit({ type: "spawn", who: this.index });
  }

  /** Standing and in control (can act or be hit). */
  standing() { return this.stance === "idle" || this.stance === "stagger" || this.stance === "defend" || this.stance === "move"; }
  /** Can be hit right now (standing, and not in the grace period after getting up). */
  hittable() { return this.standing() && this.clock() >= this.graceUntil; }
  isBlocking() {
    return (this.stance === "defend" && this.defense?.kind === "block") || (this.stance === "move" && this.move?.spell?.phase === "cast" && this.move.spell.spec.kind === "defend");
  }
  /** Slipping, ducking, stepping back or jumping: a whiff against this fighter counts as dodged. */
  isEvading() { return this.stance === "defend" && !!this.defense && this.defense.kind !== "block"; }
  /**
   * Strikes at this zone miss right now. Dodges are rules, and the body acts them out: a slip or a
   * step back beats anything, a duck beats head shots, a jump beats leg strikes. Blocks don't
   * evade; they soften (receiveHit).
   */
  evades(zone: Zone): boolean {
    if (this.stance !== "defend" || !this.defense) return false;
    switch (this.defense.kind) {
      case "dodge.left": case "dodge.right": case "dodge.back": return true;
      case "duck": return zone === "head";
      case "jump": return zone === "legs";
      default: return false;
    }
  }
  /** In the middle of its own attack (stepping in, winding up, or with a strike still live). */
  isCommitted() { return this.stance === "move" && (!!this.move?.punch || this.combat.pending(this)); }
  /** What its current punch or spell is doing, for the AI: stepping in, or under way. */
  punchPhase(): "approach" | "throw" | null {
    if (this.stance !== "move") return null;
    const sp = this.move?.spell;
    if (sp) return sp.phase === "approach" ? "approach" : "throw";
    return this.move?.punch?.phase ?? null;
  }
  /** The kind of the spell in progress (stepping in or casting), or null. */
  spellKind(): MoveSpec["kind"] | null { return this.stance === "move" ? this.move?.spell?.spec.kind ?? null : null; }
  /** Name of the move or punch in progress. */
  moveName(): string | null { return this.stance === "move" ? this.move?.name ?? null : null; }
  defenseKind(): Defense | null { return this.stance === "defend" ? this.defense?.kind ?? null : null; }
  rootVelocity(): number[] { return this.world.rootVel(this.robot); }
  /** How fast the two pelvises approach each other (m/s, negative when moving apart). */
  closingSpeed(): number {
    const a = this.world.rootPos(this.robot), b = this.world.rootPos(this.opponent.robot);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(d > 1e-6)) return 0;
    const va = this.rootVelocity(), vb = this.opponent.rootVelocity();
    return ((va[0] - vb[0]) * (b[0] - a[0]) + (va[1] - vb[1]) * (b[1] - a[1])) / d;
  }
  distanceTo(o: Fighter) { return dist2(this.world.rootPos(this.robot), this.world.rootPos(o.robot)); }

  /**
   * Throws a punch at the opponent: steps into range with boxing footwork, then throws.
   * Whether it lands is decided by contact (combat.ts), so a dodge or a step back makes it miss.
   */
  throwPunch(name: PunchName, power = 1): boolean { return this.run(() => this.startPunch(name, power)); }
  private startPunch(name: PunchName, power: number): boolean {
    if (!PUNCHES.includes(name) || !(power > 0) || !this.motion || this.stance !== "idle" || !this.opponent.standing()) return false;
    this.gen++; this.inflight = null; // the footwork step that was coming is out of date
    this.setStance("move");
    this.attackSerial++;
    this.move = { name, endT: this.clock() + LIMITS.move - 0.5, punch: { name, power: Math.min(power, 3), phase: "approach", stepping: false, approachT: 0, waitT: 0 } };
    this.intent = `stepping in: ${name.slice(6)}`;
    this.emit({ type: "move", who: this.index, name });
    return true;
  }

  /**
   * Plays a move: a Kimodo-G1 clip, rows of 36-value qpos at `fps`. It is placed where the fighter
   * stands and turned to face the opponent. `strikes` say when which limb can hurt (seconds from
   * the clip's first frame); contact decides whether it does. Back to footwork when it ends.
   */
  playMove(qpos: ArrayLike<number>[], fps = 30, strikes: readonly StrikeWindow[] = [], name = "move"): boolean {
    return this.run(() => this.startMove(qpos, fps, strikes, name));
  }
  private startMove(qpos: ArrayLike<number>[], fps: number, strikes: readonly StrikeWindow[], name: string): boolean {
    if (this.stance !== "idle" && this.stance !== "defend") return false;
    const windows = asWindows(strikes);
    const frames = windows ? this.clipFrames(qpos, fps) : null;
    if (!windows || !frames) return false;
    this.gen++; this.inflight = null; // no footwork or dodge answer may land on top of the move
    this.defense = null;
    this.effects = this.effects.filter((e) => e.tag !== "defense");
    this.setStance("move");
    this.attackSerial++;
    const start = this.startFrame();
    this.raw.splice(frames.map(copyFrame), start, 8);
    this.ref.splice(waistToHips(frames), start, 8);
    const t0 = this.timeOfFrame(start);
    this.combat.arm(this, this.opponent, windows, t0);
    this.move = { name, endT: t0 + (frames.length - 1) / REF_HZ + 0.25, punch: null };
    this.intent = `move: ${name}`;
    this.emit({ type: "move", who: this.index, name });
    return true;
  }

  /**
   * Casts a spell or plays another server move (spells.ts): a Kimodo clip (qpos rows at `fps`) plus
   * what kind of move it is. Its hit is decided by the kind at its hit frame: a melee move steps in
   * first; a projectile flies from the hit joint; a strike lands from above a moment later where the
   * defender stood; a shockwave hits nearby; a defend move (Earth Wall) blocks for the whole move.
   * Works from idle or while defending; false if the spec or the clip can't be used.
   */
  cast(spec: MoveSpec, qpos: ArrayLike<number>[], fps = 30): boolean { return this.run(() => this.startCast(spec, qpos, fps)); }
  private startCast(spec0: MoveSpec, qpos: ArrayLike<number>[], fps: number): boolean {
    if (this.stance !== "idle" && this.stance !== "defend") return false;
    const spec = checkSpec(spec0);
    const frames = spec ? this.clipFrames(qpos, fps) : null;
    if (!spec || !frames) return false;
    const dur = (frames.length - 1) / REF_HZ;
    const hitT = spec.hitFrame >= 0 ? Math.min(dur, spec.hitFrame / fps) : dur * 0.45;
    // a melee move counts its own lunge (how far its root travels toward the opponent by the hit)
    const k = Math.min(frames.length - 1, Math.round(hitT * REF_HZ)), [fx, fy] = this.facingOpponent();
    const lunge = Math.max(0, (frames[k][0] - frames[0][0]) * fx + (frames[k][1] - frames[0][1]) * fy);
    this.gen++; this.inflight = null;
    this.defense = null;
    this.effects = this.effects.filter((e) => e.tag !== "defense");
    this.setStance("move");
    this.attackSerial++;
    const spell: Spell = { spec, frames, hitT, phase: spec.kind === "melee" ? "approach" : "cast", stepping: false, approachT: 0, waitT: 0, gap: SPELL.meleeGap + lunge };
    this.move = { name: spec.name, endT: this.clock() + LIMITS.move - 0.5, punch: null, spell };
    if (spell.phase === "cast") this.castNow(this.move, spell);
    else this.intent = `stepping in: ${spec.name}`;
    this.emit({ type: "move", who: this.index, name: spec.name });
    return true;
  }

  /** Plays the spell's clip now (both fighters' moves started together land on the same tick). */
  private castNow(mv: Move, sp: Spell) {
    sp.phase = "cast";
    this.gen++; this.inflight = null; // drop a stepping-in answer still coming
    const start = this.startFrame();
    this.raw.splice(sp.frames.map(copyFrame), start, 8);
    this.ref.splice(waistToHips(sp.frames.map(copyFrame)), start, 8);
    const t0 = this.timeOfFrame(start);
    const o = this.world.rootPos(this.opponent.robot);
    this.combat.cast(this, this.opponent, sp.spec, t0 + sp.hitT, [o[0], o[1]]);
    mv.endT = t0 + (sp.frames.length - 1) / REF_HZ + 0.1;
    this.intent = `${sp.spec.kind === "defend" ? "raising" : "casting"} ${sp.spec.name}`;
    const s = sp.spec;
    this.emit({ type: "cast", who: this.index, name: s.name, kind: s.kind, spellType: s.type, effect: s.effect, power: s.power, hitIn: Math.max(0, t0 + sp.hitT - this.clock()), target: [o[0], o[1], o[2]] });
  }

  /**
   * Block, duck, dodge (left, right, back) or jump, for `seconds` (defaults per kind).
   * Works from idle, while already defending, or to cancel a punch that is still stepping in.
   * `clip` (Kimodo qpos rows at `fps`) acts it out instead of the built-in motion; the defense then
   * lasts as long as the clip unless `seconds` says otherwise.
   */
  defend(kind: Defense, seconds?: number, clip?: { qpos: ArrayLike<number>[]; fps: number }): boolean {
    return this.run(() => this.startDefense(kind, seconds, clip));
  }
  private startDefense(kind: Defense, seconds: number | undefined, clip: { qpos: ArrayLike<number>[]; fps: number } | undefined): boolean {
    if (!DEFENSES.includes(kind)) return false;
    const cancelling = this.stance === "move" && (this.move?.punch?.phase === "approach" || this.move?.spell?.phase === "approach");
    if (this.stance !== "idle" && this.stance !== "defend" && !cancelling) return false;
    const frames = clip ? this.clipFrames(clip.qpos, clip.fps) : null;
    if (clip && !frames) return false;
    if (cancelling) { this.move = null; this.combat.disarm(this, "interrupted", true); this.cutMotion(); }
    const byKind = kind === "block" ? 0.8 : kind === "duck" ? 0.6 : kind === "jump" ? 0.5 : 0.6;
    const asked = seconds !== undefined && Number.isFinite(seconds) ? seconds : frames ? (frames.length - 1) / REF_HZ : byKind;
    const dur = clamp(asked, 0.2, LIMITS.defend - 0.1);
    const now = this.clock();
    this.defense = { kind, until: now + dur };
    if (this.stance !== "defend") this.setStance("defend");
    else this.stanceT = 0;
    this.gen++; this.inflight = null; // whatever was coming (a step, the previous dodge) is out of date
    // directions are taken from the line to the opponent: that's where the attack comes from
    const [ox, oy] = this.facingOpponent(), f = [ox, oy, 0], left = [-oy, ox, 0];
    this.effects = this.effects.filter((e) => e.tag !== "defense");
    const add = (e: Omit<Effect, "tag" | "t" | "dur">) => this.effects.push({ tag: "defense", t: 0, dur, ...e });
    switch (kind) {
      case "block":
        add({ attack: 0.08, release: 0.15, tilt: { axis: this.tiltAxis(f), angle: 0.08 },
          joints: jointOffsets([[J.shPitchL, -0.35], [J.shPitchR, -0.35], [J.elbowL, -0.45], [J.elbowR, -0.45], [J.shRollL, -0.1], [J.shRollR, 0.1], [J.hipL, -0.1], [J.hipR, -0.1], [J.kneeL, 0.12], [J.kneeR, 0.12]]) });
        break;
      case "duck": // sit down into the legs and fold forward under the punch
        add({ attack: 0.1, release: 0.2, tilt: { axis: this.tiltAxis(f), angle: 0.3 },
          joints: jointOffsets([[J.hipL, -0.6], [J.hipR, -0.6], [J.kneeL, 1.1], [J.kneeR, 1.1], [J.ankleL, -0.5], [J.ankleR, -0.5]]) });
        break;
      case "jump": // tuck the legs; the rules let leg strikes pass under (see evades)
        add({ attack: 0.06, release: 0.15, joints: jointOffsets([[J.hipL, -0.5], [J.hipR, -0.5], [J.kneeL, 0.9], [J.kneeR, 0.9], [J.ankleL, -0.35], [J.ankleR, -0.35]]) });
        break;
      case "dodge.left":
      case "dodge.right": {
        const side = kind === "dodge.left" ? left : [-left[0], -left[1], 0];
        add({ attack: 0.07, release: 0.2, tilt: { axis: this.tiltAxis(side), angle: 0.32 },
          joints: jointOffsets([[J.hipL, -0.12], [J.hipR, -0.12], [J.kneeL, 0.2], [J.kneeR, 0.2]]) });
        break;
      }
      case "dodge.back": // lean away while the feet step back
        add({ attack: 0.07, release: 0.2, tilt: { axis: this.tiltAxis([-f[0], -f[1], 0]), angle: 0.2 } });
        break;
    }
    // The motion itself: the clip handed in, else one from the motion source (Kimodo library),
    // else the overlay acts it out. Dodges also step that way; a cancelled punch stops stepping in.
    const dropPose = () => { for (const e of this.effects) if (e.tag === "defense") e.joints = undefined; }; // the clip has the pose
    if (frames) {
      const start = this.startFrame();
      this.raw.splice(frames.map(copyFrame), start, 8);
      this.ref.splice(waistToHips(frames), start, 8);
      dropPose();
    } else {
      const step = kind === "dodge.left" ? left : kind === "dodge.right" ? [-left[0], -left[1]] : kind === "dodge.back" ? [-f[0], -f[1]] : null;
      this.ask(kind, "defense", step ? { move: [step[0], step[1]], speed: 0.9 } : {}, (got) => {
        if (got && !step) dropPose();
        else if (!got && cancelling) this.ask("guard", "defense", {});
      });
    }
    this.intent = kind;
    this.emit({ type: "defend", who: this.index, kind });
    return true;
  }

  knockOut() { this.run(() => this.koNow()); }
  private koNow() {
    if (this.stance === "ko") return;
    const wasUp = this.standing();
    this.combat.disarm(this, "interrupted", true);
    this.gen++; this.inflight = null;
    this.move = null; this.defense = null; this.effects = [];
    this.assistOff();
    this.setStance("ko");
    // fold at the knees first (see koSlump), then go limp
    this.ctl.active = true; this.ctl.hold = CRUMPLE; this.ctl.stiffness = wasUp ? 0.16 : 0.08;
    this.intent = "knocked out";
    this.emit({ type: "ko", who: this.index });
  }

  /**
   * A hit from combat.ts (contact) or from the rig. Applies the push, then calls `scored` (the
   * arena scores it and reports the hit), then the reaction: a flinch, a stagger or a knockdown.
   * If scoring the hit knocked the fighter out, the KO is the reaction.
   */
  receiveHit(imp: Impact, scored?: (res: HitResult) => void): HitResult { return this.run(() => this.takeHit(imp, scored)); }
  private takeHit(imp: Impact, scored: ((res: HitResult) => void) | undefined): HitResult {
    if (!this.hittable()) return { landed: false, blocked: false, knockdown: false, ignored: this.standing() ? "grace" : this.stance };
    if (!imp || !finite3(imp.point) || !finite3(imp.dir) || !Number.isFinite(imp.impulse) || !Number.isFinite(imp.poise)) {
      return { landed: false, blocked: false, knockdown: false, ignored: "bad impact" };
    }
    const now = this.clock();
    const body = this.robot.bodyIds.includes(imp.body) ? imp.body : this.robot.bodies.get("torso_link")!;
    const dn = Math.hypot(imp.dir[0], imp.dir[1], imp.dir[2]) || 1;
    const dir = [imp.dir[0] / dn, imp.dir[1] / dn, imp.dir[2] / dn];
    // blocked: it met the forearms, or the guard is up and it came from the front and not low.
    // "From the front" is where the strike comes from (the attacker, or against the push for a
    // hit with no attacker) within TUNE.blockArc of the way the pelvis points. The boxing stance
    // turns the pelvis 20-50 deg off the opponent, so a narrow arc let hooks through a raised guard.
    const f = this.facing(), me = this.world.rootPos(this.robot);
    const from = imp.attacker ? (() => { const a = this.world.rootPos(imp.attacker.robot); return [a[0] - me[0], a[1] - me[1]]; })() : [-dir[0], -dir[1]];
    const fromFront = from[0] * f[0] + from[1] * f[1] > Math.cos(TUNE.blockArc) * Math.hypot(from[0], from[1]);
    const blocked = this.isBlocking() && (!!imp.guard || (imp.zone !== "legs" && fromFront));
    let impulse = clamp(imp.impulse, 0, TUNE.maxImpulse) * (blocked ? 0.3 : 1);
    const poiseHit = clamp(imp.poise, 0, 2) * (blocked ? 0.2 : 1) * (imp.counter ? 1.5 : 1);
    this.poise = Math.max(0, this.poise - poiseHit);
    this.lastHitT = now;
    const knockdown = !blocked && (impulse >= TUNE.knockdownImpulse || this.poise <= 0 || !!imp.knockdown);
    if (knockdown) impulse = Math.min(impulse, TUNE.knockdownPush);
    const force = impulse / TUNE.pulse;
    this.pulses.push({ body, local: this.world.toLocal(body, imp.point), force: [dir[0] * force, dir[1] * force, dir[2] * force], left: TUNE.pulse });
    if (this.pulses.length > 6) this.pulses.shift();
    this.lastEvent = `${blocked ? "blocked " : ""}${imp.name} to the ${imp.zone} (${impulse.toFixed(0)} N s)`;
    const res: HitResult = { landed: true, blocked, knockdown };
    const epoch = this.epoch;
    try { scored?.(res); } catch (e) { this.oops(e); }
    if (!this.standing() || this.epoch !== epoch) return res; // scoring it knocked the fighter out, or it was respawned
    const s = clamp(impulse / 30, 0.3, 1.2);
    if (knockdown) {
      this.startFall(true);
    } else if (blocked) {
      this.flinch("torso", dir, s * 0.4);
      if (this.defense) this.defense.until = Math.max(this.defense.until, now + 0.2); // block stun
    } else {
      // A light hit while this fighter's own strike is live is a trade: both land, nobody stops.
      const trade = this.stance === "move" && this.combat.active(this, now) && s < 0.5;
      if (!trade) {
        if (this.stance === "move") { this.combat.disarm(this, "interrupted"); this.move = null; this.cutMotion(); }
        this.defense = null;
        this.effects = this.effects.filter((e) => e.tag !== "defense");
        this.staggerFor = 0.25 + 0.5 * s + 0.3 * (1 - this.poise); // wobblier when nearly out of balance
        this.gen++; this.inflight = null; // the step that was coming is out of date
        this.setStance("stagger");
        this.intent = "staggered";
        this.emit({ type: "stagger", who: this.index, level: s });
        // settle back into the guard from wherever the motion was (a punch, a step)
        this.ask("guard", "stagger", {});
      }
      this.flinch(imp.zone, dir, s);
    }
    return res;
  }

  /** The rig's instant attacks (attacks.ts): a hit from `from` (world xy) with no fist involved. */
  hitInstant(a: Attack, from: ArrayLike<number>, scale = 1, scored?: (imp: Impact, res: HitResult) => void): InstantHit {
    if (!a || typeof a.body !== "string" || !(a.force >= 0) || !(a.duration > 0) || !Array.isArray(a.offset) || a.offset.length < 3 || !a.offset.every(Number.isFinite) || !from || !Number.isFinite(from[0]) || !Number.isFinite(from[1])) {
      return missedInstant("bad attack");
    }
    const body = this.robot.bodies.get(a.body) ?? this.robot.bodies.get("torso_link")!;
    const me = this.world.rootPos(this.robot);
    let fx = me[0] - from[0], fy = me[1] - from[1];
    const d = Math.hypot(fx, fy);
    if (!(d > 1e-6)) { const f = this.facing(); fx = -f[0]; fy = -f[1]; } else { fx /= d; fy /= d; }
    const dir = pushDirection(a.dir, fx, fy);
    const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const point = this.world.pointOn(body, a.offset);
    const zone: Zone = a.body.includes("ankle") || a.body.includes("knee") ? "legs" : a.offset[2] > 0.32 ? "head" : "torso";
    const impulse = a.force * a.duration * (Number.isFinite(scale) ? Math.max(0, scale) : 1);
    const impact: Impact = { attacker: null, name: a.name, zone, body, point, dir: [dir[0] / n, dir[1] / n, dir[2] / n], speed: 5, impulse, poise: impulse / 90, counter: this.isCommitted() };
    const result = this.receiveHit(impact, scored ? (r) => scored(impact, r) : undefined);
    const k = result.landed ? ((result.blocked ? 0.3 : 1) * impulse) / TUNE.pulse : 0;
    return { point, force: [impact.dir[0] * k, impact.dir[1] * k, impact.dir[2] * k], result, impact };
  }

  /** The arena rolled the physics back (or moved this robot): carry on from the pose it is in. */
  afterRestore() { this.run(() => this.restartFromPose()); }

  /**
   * Puts the fighter back at (x, y) after a failure (it left the arena, the physics was reset):
   * standing, untouchable for a moment. A KO'd body is put down there instead and stays KO'd.
   */
  relocate(x: number, y: number, yaw: number) {
    this.run(() => { if (this.stance === "ko") this.relocateKO(x, y, yaw); else this.spawnNow(x, y, yaw, TUNE.grace); });
  }

  private relocateKO(x: number, y: number, yaw: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0; y = 0; }
    if (!Number.isFinite(yaw)) yaw = 0;
    this.gen++; this.inflight = null;
    this.epoch++;
    const pose = this.world.placeStanding(this.robot, x, y, yaw, CRUMPLE); // folded, and it falls limp from there
    this.ref.replace([pose], this.ref.now);
    this.raw.replace([copyFrame(pose)], this.raw.now);
    this.ctl.reset();
    this.ctl.active = false; this.ctl.hold = null;
    this.body.invalidate();
    this.combat.disarm(this, "interrupted", true);
    this.pulses = []; this.hist = []; this.effects = [];
    this.move = null; this.defense = null;
    this.nowT = this.clock();
  }
  private restartFromPose() {
    this.gen++; this.inflight = null;
    this.epoch++;
    this.pulses = []; this.hist = []; this.effects = []; this.tuck = 0;
    this.body.invalidate();
    this.combat.disarm(this, "interrupted", true);
    const pose = this.world.robotQpos(this.robot);
    this.ref.replace([copyFrame(pose)], this.ref.now);
    this.raw.replace([copyFrame(pose)], this.raw.now);
    this.ctl.reset();
    this.ctl.worldHeading();
    this.move = null; this.defense = null;
    this.nowT = this.clock();
    if (this.stance === "ko") { this.ctl.active = false; this.ctl.hold = null; return; }
    this.assistOff();
    this.rise = freshRise();
    // the stance comes from the body the rollback restored, not from before it (a duck or a slip
    // tilts a standing body well past 0.3 rad, so only a real topple counts as down)
    if (pose[2] > TUNE.upHeight && tiltOf([pose[3], pose[4], pose[5], pose[6]]) < TUNE.fallTiltAbs) {
      this.ctl.active = true; this.ctl.hold = null; this.ctl.stiffness = 1;
      this.forceStance("idle");
      this.nextFootworkAt = 0;
      this.intent = "ready";
      return;
    }
    // on the floor or on the way: settle and get up again
    this.ctl.active = true; this.ctl.hold = BRACE; this.ctl.stiffness = 0.3;
    this.forceStance("falling");
  }

  // ================= 50 Hz =================

  async tick() {
    const dt = 1 / REF_HZ;
    this.nowT = this.clock();
    this.stanceT += dt;
    this.run(() => {
      try { this.think(this.nowT, dt); } catch (e) { this.oops(e); }
    });
    try {
      await this.ctl.tick(this.ref);
    } finally {
      this.ref.advance();
      this.raw.advance();
      this.nowT += dt;
    }
  }

  /** Per 5 ms physics step: hit pushes, the get-up lift, then PD. */
  substep(dt: number) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pl = this.pulses[i];
      this.world.applyForce(pl.body, pl.force, this.world.pointOn(pl.body, pl.local));
      if ((pl.left -= dt) <= 1e-9) this.pulses.splice(i, 1);
    }
    if (this.rise.assist > 0 && this.stance === "rising") this.fairyStrings();
    this.ctl.pd();
  }

  private think(now: number, dt: number) {
    this.hist.push(this.world.robotQpos(this.robot));
    if (this.hist.length > 12) this.hist.shift();
    this.body.update(dt);

    const p = this.world.rootPos(this.robot), q = this.world.rootQuat(this.robot);
    if (!finite3(p) || !Number.isFinite(q[0]) || p[2] < -0.3 || p[2] > 2.5 || Math.hypot(p[0], p[1]) > RING_RADIUS + 3) {
      this.failsafe("body left the arena");
      return;
    }
    const tilt = tiltOf(q), h = p[2];
    const v = this.rootVelocity(), speed = Math.hypot(v[0], v[1], v[2]);
    if (now - this.lastHitT > TUNE.poiseDelay) this.poise = Math.min(1, this.poise + TUNE.poiseRegen * dt);

    // a motion request that never came back
    const inf = this.inflight;
    if (inf && now - inf.at > TUNE.askTimeout) {
      this.inflight = null;
      this.stats.askTimeouts++;
      if (this.stillWants(inf.purpose, inf.stage)) inf.onFail();
    }

    if (this.stanceT > LIMITS[this.stance]) this.timeout();

    switch (this.stance) {
      case "idle":
      case "stagger":
      case "defend":
      case "move":
        if (this.lostBalance(tilt, h)) { this.startFall(false); break; }
        if (this.stance === "stagger") { if (this.stanceT > this.staggerFor) this.toIdle(); break; }
        if (this.stance === "defend") { if (now >= (this.defense?.until ?? 0)) this.toIdle(); break; }
        if (this.stance === "move") { this.followMove(dt); break; }
        this.footwork(p);
        break;
      case "falling":
        if (h < TUNE.downHeight && speed < 0.35) this.rise.stageT += dt; else this.rise.stageT = 0;
        if (this.rise.stageT > 0.3) this.toDown();
        break;
      case "down":
        if (this.stanceT > TUNE.downBeat) this.startRise();
        break;
      case "rising":
        this.rising(h, tilt, dt);
        break;
      case "ko":
        if (this.stanceT > TUNE.koSlump && this.ctl.active) { this.ctl.active = false; this.ctl.hold = null; }
        break;
    }
    this.updateOverlays(dt);
  }

  // ================= stance plumbing =================

  /**
   * Runs a state change as one step: events it raises are delivered when it is done, so a
   * listener never sees a half-made change, and anything a listener does (a KO, a reset) can't be
   * undone by the rest of this change.
   */
  private run<T>(fn: () => T): T { return this.batch(fn); }

  private setStance(s: Stance) {
    const from = this.stance;
    if (!TRANSITIONS[from].includes(s)) { this.stats.badTransitions++; this.lastBadTransition = `${from} -> ${s}`; }
    this.stance = s;
    this.stanceT = 0;
    this.emit({ type: "stance", who: this.index, from, to: s });
  }

  /** A reset-level stance change (spawn, rollback): not checked against TRANSITIONS. */
  private forceStance(s: Stance) {
    const from = this.stance;
    this.stance = s;
    this.stanceT = 0;
    if (from !== s) this.emit({ type: "stance", who: this.index, from, to: s });
  }

  private toIdle(reason: WhiffReason = "out of range") {
    if (this.combat.pending(this)) this.combat.disarm(this, reason);
    if (this.inflight && this.inflight.purpose !== "footwork") this.inflight = null; // its answer was for the stance that ended
    this.move = null;
    this.defense = null;
    this.effects = this.effects.filter((e) => e.tag !== "defense");
    this.setStance("idle");
    this.nextFootworkAt = 0;
  }

  /** A stance ran past its limit: leave it the safe way. */
  private timeout() {
    switch (this.stance) {
      case "stagger": case "defend": this.toIdle(); break;
      case "move": this.gen++; this.inflight = null; this.cutMotion(); this.toIdle("interrupted"); break;
      case "falling": this.toDown(); break;
      case "down": this.startRise(); break;
      case "rising": this.failsafe("stuck getting up"); break;
      default: break;
    }
  }

  /** Last resort: stand up right here (or the nearest clear spot), facing the opponent. A KO'd body stays KO'd. */
  private failsafe(what: string) {
    const o = this.world.rootPos(this.opponent.robot);
    const [x, y] = safeSpot(this.world.rootPos(this.robot), o);
    const yaw = finite3(o) ? Math.atan2(o[1] - y, o[0] - x) : 0;
    this.stats.failsafes++;
    this.relocate(x, y, yaw);
    this.emit({ type: "failsafe", who: this.index, what });
  }

  /** Lost balance: tipped or dropped far more than the motion it follows says it should. */
  private lostBalance(tilt: number, h: number): boolean {
    const f = this.ref.current();
    const refTilt = tiltOf([f[3], f[4], f[5], f[6]]);
    // past fallTiltAbs counts only if the motion doesn't ask for it: a deliberate deep bend (a
    // ground slam) tilts the pelvis that far on purpose
    return (tilt > TUNE.fallTiltAbs && tilt > refTilt + 0.35) || tilt - refTilt > TUNE.fallTiltRel || h < f[2] - TUNE.fallDrop;
  }

  private oops(e: unknown) {
    this.stats.errors++;
    const msg = e instanceof Error ? e.message : String(e);
    this.lastEvent = `error: ${msg}`;
    const now = this.clock();
    if (now - this.lastErrorT > 1) { this.lastErrorT = now; this.emit({ type: "failsafe", who: this.index, what: `error: ${msg}` }); }
  }

  // ================= motion requests =================

  /** Sim time at which absolute reference frame `a` plays. */
  private timeOfFrame(a: number) { return this.nowT + (a - this.ref.now) / REF_HZ; }

  /**
   * The frame a move handed in now starts on: two control ticks after the current one, by sim
   * time. Both fighters land on the same tick even when one has already advanced its motion this
   * tick and the other hasn't (a call from inside an event), so moves started together play together.
   */
  private startFrame(): number {
    const t = this.clock() + 2 / REF_HZ;
    return this.ref.now + Math.max(1, Math.round((t - this.nowT) * REF_HZ));
  }

  /**
   * Asks the motion source for `name` and splices the answer in when it comes. One request at a
   * time: a newer request, a stance change that makes it pointless, or a respawn drops the answer.
   * onDone(null) means there is nothing to follow (no source, no such motion, or a failure).
   */
  private ask(name: MotionName, purpose: Purpose, opts: AskOpts, onDone?: (clip: MotionClip | null) => void) {
    const done = (clip: MotionClip | null) => { try { onDone?.(clip); } catch (e) { this.oops(e); } };
    const fail = () => { this.stats.failedAsks++; done(null); };
    if (!this.motion) { done(null); return; }
    const stage = opts.stage ?? 0;
    let context: number[], contextFrame: number;
    if (opts.fromRobot) { context = this.contextFromRobot(); contextFrame = this.ref.now - 5; }
    else { const c = contextFromReference(this.raw); context = c.context; contextFrame = c.genFrame; }
    if (context.length !== 144 || !context.every(Number.isFinite)) { fail(); return; }
    const token = ++this.reqToken, gen = this.gen;
    this.inflight = { token, purpose, stage, at: this.clock(), onFail: fail };
    this.seed = (this.seed * 48271) % 2147483647;
    const msg: MotionAsk = { name, context, contextFrame, startFrame: this.ref.now + 2, facing: opts.facing ?? this.facingOpponent(), move: opts.move, speed: opts.speed, seed: opts.seed ?? this.seed, urgent: purpose !== "footwork" };
    const current = () => gen === this.gen && this.inflight?.token === token;
    let p: Promise<MotionClip | null>;
    try { p = Promise.resolve(this.motion.get(msg)); } catch (e) { p = Promise.reject(e); }
    p.then((clip) => this.run(() => {
      if (!current()) { this.stats.staleDrops++; return; }
      this.inflight = null;
      if (!this.stillWants(purpose, stage)) { this.stats.staleDrops++; return; }
      if (!clip) { this.stats.noMotion++; done(null); return; }
      if (!this.usable(clip)) { fail(); return; }
      const blend = clip.blend !== undefined && Number.isFinite(clip.blend) ? clamp(Math.round(clip.blend), 1, 30) : 8;
      this.raw.splice(clip.frames.map(copyFrame), clip.at, blend);
      this.ref.splice(purpose === "getup" ? clip.frames : waistToHips(clip.frames), clip.at, blend);
      this.stats.applied++;
      done(clip);
    }), (e) => this.run(() => {
      if (!current()) { this.stats.staleDrops++; return; }
      this.inflight = null;
      this.lastEvent = `motion: ${e instanceof Error ? e.message : String(e)}`;
      if (this.stillWants(purpose, stage)) fail(); else this.stats.staleDrops++;
    })).catch((e) => this.oops(e));
  }

  /** A clip we can follow: finite, joints in range, and placed near "now" on the frame clock. */
  private usable(c: MotionClip): boolean {
    if (!c || !Array.isArray(c.frames) || c.frames.length < 1 || c.frames.length > 50 * 20) return false;
    if (!Number.isInteger(c.at) || c.at < this.ref.now - 300 || c.at > this.ref.now + 100) return false;
    if (c.at + c.frames.length <= this.ref.now + 1) return false; // all in the past
    return sanitizeFrames(c.frames, this.robot.lo, this.robot.hi);
  }

  private stillWants(purpose: Purpose, stage: number): boolean {
    switch (purpose) {
      case "footwork": return this.stance === "idle";
      case "approach": return this.stance === "move" && (this.move?.punch?.phase === "approach" || this.move?.spell?.phase === "approach");
      case "punch": return this.stance === "move" && this.move?.punch?.phase === "throw";
      case "defense": return this.stance === "defend";
      case "stagger": return this.stance === "stagger";
      case "getup": return this.stance === "rising" && this.rise.stage === stage && this.rise.cap < 1;
    }
  }

  // ================= footwork =================

  private footwork(me: number[]) {
    const [fx, fy] = this.facingOpponent();
    const dist = this.distanceTo(this.opponent);
    if (!this.motion) { this.holdGuard(me, Math.atan2(fy, fx)); return; }
    const engaged = this.opponent.isCommitted();
    if (engaged && !this.sawAttack) { // it just started: stand and face it now, not after the current step
      this.nextFootworkAt = 0;
      if (this.inflight?.purpose === "footwork") this.inflight = null; // its answer is dropped
    }
    this.sawAttack = engaged;
    if (this.inflight || this.clock() < this.nextFootworkAt) return;
    this.reanchor(me);
    const crowded = dist < TUNE.crowd;
    const oppDown = !this.opponent.standing();
    const [near, far] = oppDown ? TUNE.rangeDown : TUNE.range;
    let name: MotionName = "step", mx = 0, my = 0, speed = 0.35;
    const r = Math.hypot(me[0], me[1]);
    if (engaged && dist > 0.6) {
      // an attack is coming: footwork doesn't run from it (getting away is a defense, defend())
      name = "guard";
      this.intent = "guard up";
    } else if (r > RING_RADIUS - 0.45) {
      // off the ropes: toward the center, sliding along the ropes away from the opponent
      const ix = -me[0] / r, iy = -me[1] / r;
      let tx = -iy, ty = ix;
      if (tx * fx + ty * fy > 0) { tx = -tx; ty = -ty; }
      const k = dist < near ? 1 : 0.4;
      mx = ix + tx * k; my = iy + ty * k;
      speed = dist < near ? 0.6 : 0.45;
      this.intent = "off the ropes";
    } else if (dist < near) {
      mx = -fx; my = -fy; speed = crowded ? 0.7 : 0.4;
      this.intent = "backing off";
    } else if (dist > far + 0.3) {
      mx = fx; my = fy; speed = 0.5;
      this.intent = "closing in";
    } else {
      const roll = this.rand();
      if (roll < 0.3) { name = "guard"; this.intent = "bouncing in place"; }
      else {
        if (roll > 0.85) this.circleDir *= -1;
        mx = -fy * this.circleDir; my = fx * this.circleDir;
        this.intent = this.circleDir > 0 ? "circling left" : "circling right";
      }
    }
    const n = Math.hypot(mx, my);
    if (n > 1e-6) { mx /= n; my /= n; }
    const hold = crowded ? 0.25 : 0.8 + this.rand() * 0.6;
    this.ask(name, "footwork", { move: [mx, my], speed }, () => { this.nextFootworkAt = this.clock() + hold; });
  }

  /**
   * SONIC follows the motion's joints and heading, not its position, so after pushes and
   * collisions the motion drifts away from where the body really is. Plans and clips continue from
   * the motion's position, so move it back (all of it, so its velocities don't jump).
   */
  private reanchor(me: number[]) {
    const f = this.raw.current();
    const dx = me[0] - f[0], dy = me[1] - f[1];
    if (Math.hypot(dx, dy) < TUNE.reanchor) return;
    this.raw.translate(dx, dy);
    this.ref.translate(dx, dy);
  }

  /** No motion source: hold a standing guard facing the opponent. */
  private holdGuard(me: number[], yaw: number) {
    if (this.ref.remaining > 10) return;
    this.easeTo(poseFrame([me[0], me[1], 0.76], [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], DEFAULT_ANGLES), 15);
    this.intent = "guard (no motion source)";
  }

  /**
   * An interrupted punch or clip stops now: the motion eases into a standing guard (0.2 s) instead
   * of playing on. The guard plan asked for next replaces it when it comes.
   */
  private cutMotion(frames = 10) {
    const [fx, fy] = this.facingOpponent(), yaw = Math.atan2(fy, fx);
    const f = this.raw.at(this.raw.now + 1);
    this.easeTo(poseFrame([f[0], f[1], 0.76], [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], DEFAULT_ANGLES), frames);
  }

  /** Replaces the motion after "now" with a blend from where it is to `target` over n frames, then holds it. */
  private easeTo(target: Frame, n: number) {
    const at = this.raw.now + 1, from = copyFrame(this.raw.at(at));
    const frames: Frame[] = [];
    for (let k = 1; k <= n; k++) frames.push(mixFrames(from, target, k / n));
    this.raw.splice(frames.map(copyFrame), at, 1);
    this.ref.splice(waistToHips(frames), at, 1);
  }

  // ================= moves and punches =================

  private followMove(dt: number) {
    const mv = this.move;
    if (!mv) { this.toIdle(); return; }
    const sp = mv.spell;
    if (sp && sp.phase === "approach") {
      if (!this.opponent.standing()) { this.intent = "opponent down"; this.toIdle("interrupted"); return; }
      // the whole approach leaves the clip its full length inside the move's time limit
      if (this.stepIn(sp, dt, sp.gap, LIMITS.move - 0.5 - (sp.frames.length - 1) / REF_HZ)) return;
      this.castNow(mv, sp);
      return;
    }
    if (sp && this.clock() > mv.endT) { this.cutMotion(20); this.toIdle(); return; } // ease back up out of the clip's last pose
    const pu = mv.punch;
    if (pu && pu.phase === "approach") {
      if (!this.opponent.standing()) { this.intent = "opponent down"; this.toIdle("interrupted"); return; }
      // the whole approach leaves the punch's plan (up to 3 s, throwNow) room inside the move's time limit
      if (this.stepIn(pu, dt, TUNE.punchRange[pu.name], LIMITS.move - 3.5)) return;
      this.throwNow(mv, pu);
      return;
    }
    if (this.clock() > mv.endT) this.toIdle();
  }

  /**
   * One tick of stepping in before a punch or a melee spell: true while still on the way, false once
   * within `range` (and not drifting apart: an attack started while separating falls short), out of
   * patience (TUNE.approachTime of actual stepping) or past `maxT` all told. Standing still waiting
   * for a late step plan (a busy planner) doesn't use up the patience. The next step is asked for
   * 0.6 s before the current one runs out, so a plan that takes a few hundred ms arrives in time.
   */
  private stepIn(a: Approach, dt: number, range: number, maxT: number): boolean {
    if (this.inflight && this.ref.remaining === 0) a.waitT += dt; else a.approachT += dt;
    const ready = this.distanceTo(this.opponent) <= range && this.closingSpeed() > -0.15;
    if (ready || a.approachT >= TUNE.approachTime || a.approachT + a.waitT >= maxT) return false;
    if (!this.inflight && (!a.stepping || this.ref.remaining < 30)) {
      a.stepping = true;
      this.ask("step", "approach", { move: this.facingOpponent(), speed: 0.85 });
    }
    return true;
  }

  /** In range (or out of patience): plan the punch and arm its strike when the plan arrives. */
  private throwNow(mv: Move, pu: Punch) {
    pu.phase = "throw";
    this.intent = `throwing ${pu.name.slice(6)}`;
    this.gen++; this.inflight = null; // drop the stepping-in answer if it is still coming
    mv.endT = this.clock() + 3; // the plan has this long to arrive and play
    this.ask(pu.name, "punch", {}, (clip) => {
      if (!clip) { this.toIdle("interrupted"); return; }
      const t0 = this.timeOfFrame(clip.at);
      const strikes = (asWindows(clip.strikes) ?? []).filter((w) => w && Number.isFinite(w.to)).map((w) => ({ ...w, power: w.power * pu.power }));
      this.combat.arm(this, this.opponent, strikes, t0);
      const clipEnd = (clip.frames.length - 1) / REF_HZ;
      const lastStrike = strikes.reduce((m, w) => Math.max(m, w.to), 0);
      mv.endT = t0 + Math.min(clipEnd, lastStrike > 0 ? lastStrike + TUNE.punchRecover : clipEnd);
    });
  }

  /** Checked, cleaned, 50 Hz frames of a clip, placed where this fighter stands facing the opponent; null if unusable. */
  private clipFrames(qpos: ArrayLike<number>[], fps: number): Frame[] | null {
    if (!Array.isArray(qpos) || qpos.length < 2 || !(fps >= 5 && fps <= 1000) || qpos.length / fps > TUNE.maxClip) return null;
    if (qpos.some((r) => !r || r.length < 36)) return null;
    const frames = resample(qpos.map((r) => copyFrame(r)), fps, REF_HZ);
    if (!sanitizeFrames(frames, this.robot.lo, this.robot.hi)) return null;
    return this.placeClip(frames);
  }

  /** A clip turned to face the opponent and moved to where this fighter stands. */
  private placeClip(frames: Frame[]): Frame[] {
    const me = this.world.rootPos(this.robot);
    const f0 = frames[0];
    const f = this.facingOpponent();
    const turn = Math.atan2(f[1], f[0]) - yawOf([f0[3], f0[4], f0[5], f0[6]]);
    const c = Math.cos(turn), s = Math.sin(turn), rot = [Math.cos(turn / 2), 0, 0, Math.sin(turn / 2)];
    const x0 = f0[0], y0 = f0[1];
    return frames.map((fr) => {
      const g = copyFrame(fr);
      const dx = fr[0] - x0, dy = fr[1] - y0;
      g[0] = me[0] + c * dx - s * dy; g[1] = me[1] + s * dx + c * dy;
      const qq = qmul(rot, [fr[3], fr[4], fr[5], fr[6]]);
      g[3] = qq[0]; g[4] = qq[1]; g[5] = qq[2]; g[6] = qq[3];
      return g;
    });
  }

  // ================= falling and getting up =================

  private startFall(knockedDown: boolean) {
    this.combat.disarm(this, "interrupted");
    this.gen++; this.inflight = null;
    this.move = null; this.defense = null;
    this.effects = [];
    this.assistOff();
    this.setStance("falling");
    this.rise.stageT = 0;
    // a stumble reaches out to break the fall; a knockdown folds at the knees
    this.ctl.active = true;
    this.ctl.hold = knockedDown ? CRUMPLE : BRACE;
    this.ctl.stiffness = knockedDown ? 0.16 : 0.3;
    this.intent = knockedDown ? "knocked down" : "going down";
    this.emit({ type: knockedDown ? "knockdown" : "fall", who: this.index });
  }

  private toDown() {
    this.setStance("down");
    this.ctl.hold = this.world.robotQpos(this.robot).slice(7);
    this.ctl.stiffness = 0.12;
    this.intent = "down";
    this.emit({ type: "down", who: this.index });
  }

  private startRise() {
    this.setStance("rising");
    this.gen++; this.inflight = null;
    this.rise = { ...freshRise(), startT: this.clock() };
    this.ctl.hold = null;
    this.ctl.stiffness = 1;
    this.ctl.active = true;
    // the motion restarts from where the body actually is
    const now = this.world.robotQpos(this.robot);
    this.ref.replace([copyFrame(now)], this.ref.now);
    this.raw.replace([copyFrame(now)], this.raw.now);
    this.ctl.reset();
    this.ctl.worldHeading();
    if (!this.motion) { this.startAssist(); return; }
    this.planStage();
  }

  /** Plans the current get-up stage from the pose the robot actually reached. */
  private planStage() {
    const stage = this.rise.stage;
    this.rise.stageT = 0;
    this.intent = stage === 0 ? "getting up: onto knees" : "getting up: standing";
    if (stage === 1) { this.rise.cap = Math.max(this.rise.assist > 0 ? this.rise.cap : 0, TUNE.standHelp); this.rise.assist = Math.max(this.rise.assist, 0.01); }
    this.ask(stage === 0 ? "getup.knees" : "getup.stand", "getup", { fromRobot: true, stage, speed: -1, seed: TUNE.getupSeed ?? undefined }, (clip) => {
      if (!clip) this.rise.failed = true;
    });
  }

  private rising(h: number, tilt: number, dt: number) {
    const r = this.rise, lastStage = r.stage === 1;
    if (h > TUNE.upHeight && tilt < 0.3) { this.risen(); return; } // standing is standing, whichever stage got it there
    if (r.assist > 0) r.assist = Math.min(r.cap, r.assist + dt / 1.2);
    if (r.cap >= 1) return; // the full lift: nothing to plan
    if (this.stanceT > TUNE.assistAfter) { this.startAssist(); return; }
    if (this.inflight) return;
    if (r.failed) { // no get-up motion to follow: try once more, then lift
      r.failed = false;
      if (++r.fails >= 2) this.startAssist(); else this.planStage();
      return;
    }
    r.stageT += dt;
    // onto the next stage once the body is up on its knees
    if (!lastStage && h > 0.16 && tilt < 0.9 && this.ref.remaining < 20 && r.stageT > 0.3) {
      r.stage = 1;
      this.planStage();
      return;
    }
    // fell back flat during the stand-up: start over from the knees
    if (lastStage && h < 0.2 && tilt > 1.0 && r.stageT > 0.6) {
      r.stage = 0;
      this.planStage();
      return;
    }
    // the plan ran out short of the goal: plan again from here, with a bit more help each time,
    // so the body still follows a human get-up instead of levitating
    if (this.ref.remaining === 0 && r.stageT > 0.8) {
      r.tries++;
      r.cap = Math.min(0.95, (r.assist > 0 ? r.cap : 0) + TUNE.retryHelp);
      r.assist = Math.max(r.assist, 0.01);
      this.planStage();
    }
  }

  private risen() {
    const assisted = this.rise.cap >= 1;
    const seconds = this.clock() - this.rise.startT;
    this.assistOff();
    this.poise = 1;
    this.graceUntil = this.clock() + TUNE.grace;
    this.stats.getups++;
    if (assisted) this.stats.assisted++;
    this.toIdle();
    this.intent = "back up";
    this.emit({ type: "getup", who: this.index, seconds, assisted });
  }

  /** Fallback get-up: SONIC tracks a standing guard while invisible strings lift the torso. */
  private startAssist() {
    this.gen++; this.inflight = null;
    this.intent = "lifted up (assist)";
    this.rise.cap = 1;
    this.rise.assist = Math.max(this.rise.assist, 0.01);
    const me = this.world.rootPos(this.robot);
    const [fx, fy] = this.facingOpponent();
    const yaw = Math.atan2(fy, fx);
    const f = poseFrame([me[0], me[1], 0.76], [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], DEFAULT_ANGLES);
    this.ref.replace([f], this.ref.now);
    this.raw.replace([copyFrame(f)], this.raw.now);
  }

  private assistOff() { this.rise.assist = 0; this.rise.cap = 0; }

  private fairyStrings() {
    const w = this.world, torso = this.robot.bodies.get("torso_link")!;
    const p = w.rootPos(this.robot), q = w.rootQuat(this.robot);
    const v = this.rootVelocity();
    const k = this.rise.assist;
    const lift = this.mass * 9.81 * 0.9 * k + 600 * k * (0.76 - p[2]) - 80 * k * v[2];
    w.applyForce(torso, [-60 * k * v[0], -60 * k * v[1], clamp(lift, 0, this.mass * 9.81 * 1.6)], w.bodyPos(torso));
    // upright torque: turn the pelvis' up axis toward world up
    const x = q[1], y = q[2], z = q[3], ww = q[0];
    const up = [2 * (x * z + ww * y), 2 * (y * z - ww * x), 1 - 2 * (x * x + y * y)];
    const ax = [up[1], -up[0]];
    const ang = Math.acos(clamp(up[2], -1, 1));
    const s = Math.hypot(ax[0], ax[1]) || 1;
    const f = w.data.xfrc_applied, cv = w.data.cvel, o = this.robot.bodies.get("pelvis")! * 6;
    const kp = 260 * k, kd = 30 * k;
    f[o + 3] += (kp * ang * ax[0]) / s - kd * cv[o];
    f[o + 4] += (kp * ang * ax[1]) / s - kd * cv[o + 1];
  }

  // ================= overlays =================

  /** Rotation axis that tilts the top of the body toward world direction d (z cross d). */
  private tiltAxis(d: ArrayLike<number>): number[] { return [-d[1], d[0], 0]; }

  private flinch(zone: Zone, dir: number[], s: number) {
    const h = Math.hypot(dir[0], dir[1]) || 1, dh = [dir[0] / h, dir[1] / h, 0];
    this.effects = this.effects.filter((e) => e.tag !== "flinch");
    const add = (e: Omit<Effect, "tag" | "t">) => this.effects.push({ tag: "flinch", t: 0, ...e });
    if (zone === "head") {
      // the head snaps the way it was pushed, hands come up
      add({ dur: 0.45, attack: 0.05, release: 0.35, tilt: { axis: this.tiltAxis(dh), angle: 0.22 * s }, joints: jointOffsets([[J.shPitchL, -0.15], [J.shPitchR, -0.15]], s) });
    } else if (zone === "torso") {
      // folds around the body shot
      add({ dur: 0.5, attack: 0.06, release: 0.38, tilt: { axis: this.tiltAxis(dh), angle: 0.06 * s }, joints: jointOffsets([[J.hipL, -0.3], [J.hipR, -0.3], [J.kneeL, 0.2], [J.kneeR, 0.2]], s) });
    } else {
      // the knees give
      add({ dur: 0.4, attack: 0.05, release: 0.3, joints: jointOffsets([[J.kneeL, 0.3], [J.kneeR, 0.3], [J.hipL, -0.15], [J.hipR, -0.15]], s) });
    }
  }

  private updateOverlays(dt: number) {
    const oj = this.ctl.overlayJoints;
    oj.fill(0);
    let quat = [1, 0, 0, 0];
    const live = this.standing() || this.stance === "rising";
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      if (e.t >= e.dur || !live) { this.effects.splice(i, 1); continue; }
      const w = e.t < e.attack ? e.t / e.attack : e.t > e.dur - e.release ? Math.max(0, (e.dur - e.t) / e.release) : 1;
      if (e.joints) for (let j = 0; j < NJ; j++) oj[j] += e.joints[j] * w;
      if (e.tilt) quat = qmul(axisAngleQuat(e.tilt.axis[0], e.tilt.axis[1], e.tilt.axis[2], e.tilt.angle * w), quat);
    }
    // Guard tuck (TUNE.guardTuck), added on top of the effects: eases in while boxing in place
    // (idle, stagger, and defenses other than a block: a duck or a dodge keeps it), eases out while
    // blocking or once a move starts (punches and clips keep their own arms), off at once on the
    // way down, on the floor, getting up or KO'd.
    const g = TUNE.guardTuck, guarding = this.stance === "idle" || this.stance === "stagger" || this.stance === "defend";
    const on = guarding && !this.isBlocking();
    this.tuck = guarding || this.stance === "move" ? clamp(this.tuck + (on ? dt : -dt) / Math.max(g.ease, dt), 0, 1) : 0;
    if (this.tuck > 0) {
      const strength = Number.isFinite(this.guardTuck) ? clamp(this.guardTuck, 0, 1.5) : 1;
      for (const [k, v] of Object.entries(g.joints)) oj[J[k as keyof typeof J]] += (v ?? 0) * this.tuck * strength;
      for (const [k, v] of Object.entries(g.lower)) oj[J[k as keyof typeof J]] += (v ?? 0) * this.tuck;
    }
    this.ctl.overlayQuat = quat;
  }

  // ================= small helpers =================

  /** Unit xy direction this fighter's pelvis faces. */
  private facing(): number[] {
    const yaw = yawOf(this.world.rootQuat(this.robot));
    return [Math.cos(yaw), Math.sin(yaw), 0];
  }

  /** Unit xy direction toward the opponent (where it faces, if they stand on the same spot). */
  facingOpponent(): [number, number] {
    const me = this.world.rootPos(this.robot), o = this.world.rootPos(this.opponent.robot);
    const dx = o[0] - me[0], dy = o[1] - me[1], d = Math.hypot(dx, dy);
    if (!(d > 1e-6) || !Number.isFinite(d)) { const f = this.facing(); return [f[0], f[1]]; }
    return [dx / d, dy / d];
  }

  /** Planner context from the robot's own last 0.1 s (4 frames at 30 Hz, oldest first). */
  contextFromRobot(): number[] {
    const ctx: number[] = [];
    const n = this.hist.length;
    if (!n) { const q = this.world.robotQpos(this.robot); for (let k = 0; k < 4; k++) ctx.push(...q); return ctx; }
    for (let k = 3; k >= 0; k--) {
      const s = n - 1 - (k * REF_HZ) / 30;
      const i0 = clamp(Math.floor(s), 0, n - 1), i1 = clamp(i0 + 1, 0, n - 1), u = clamp(s - Math.floor(s), 0, 1);
      const a = this.hist[i0], b = this.hist[i1];
      for (let i = 0; i < 36; i++) ctx.push(a[i] + (b[i] - a[i]) * u);
    }
    return ctx;
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  /** State for the HUD and the stress test. */
  debug() {
    return {
      stance: this.stance, t: this.stanceT, intent: this.intent, poise: this.poise,
      inflight: this.inflight ? { purpose: this.inflight.purpose, age: this.clock() - this.inflight.at } : null,
      remaining: this.ref.remaining, effects: this.effects.length, pulses: this.pulses.length,
      move: this.move ? { name: this.move.name, phase: this.move.punch?.phase ?? "clip", endsIn: this.move.endT - this.clock() } : null,
      defense: this.defense ? { kind: this.defense.kind, left: this.defense.until - this.clock() } : null,
      rise: { ...this.rise }, grace: Math.max(0, this.graceUntil - this.clock()),
    };
  }
}

export interface InstantHit { point: number[]; force: number[]; result: HitResult; impact: Impact | null }

/** What hitInstant returns when the attack didn't happen. */
export function missedInstant(why: string): InstantHit {
  return { point: [0, 0, 0], force: [0, 0, 0], result: { landed: false, blocked: false, knockdown: false, ignored: why }, impact: null };
}

/** Strike windows from what a caller passed: none, one, or a list. Null for anything else. */
function asWindows(s: unknown): StrikeWindow[] | null {
  if (s === undefined || s === null) return [];
  if (Array.isArray(s)) return s as StrikeWindow[];
  if (typeof s === "object") return [s as StrikeWindow];
  return null;
}

/** A place to stand a fighter back up: inside the ring and at least `clear` m from the other one. */
export function safeSpot(p: ArrayLike<number>, o: ArrayLike<number>, clear = 0.9): [number, number] {
  const R = RING_RADIUS - 0.4;
  const ox = Number.isFinite(o[0]) ? o[0] : 0, oy = Number.isFinite(o[1]) ? o[1] : 0;
  const px = Number.isFinite(p[0]) ? p[0] : 0, py = Number.isFinite(p[1]) ? p[1] : 0;
  const ok = (x: number, y: number) => Math.hypot(x, y) <= R + 1e-9 && Math.hypot(x - ox, y - oy) >= clear - 1e-9;
  const fit = (x: number, y: number): [number, number] => { const r = Math.hypot(x, y); return r > R ? [(x * R) / r, (y * R) / r] : [x, y]; };
  const here = fit(px, py);
  if (ok(here[0], here[1])) return here;
  const away = Math.atan2(here[1] - oy, here[0] - ox);
  for (let k = 0; k < 16; k++) {
    // straight away from the opponent first, then fanning out both ways
    const a = away + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
    const c = fit(ox + Math.cos(a) * clear, oy + Math.sin(a) * clear);
    if (ok(c[0], c[1])) return c;
  }
  // the opponent is somewhere strange: the far side of the ring from it
  const r = Math.hypot(ox, oy);
  return r > 1e-6 ? fit((-ox / r) * R, (-oy / r) * R) : [R, 0];
}
