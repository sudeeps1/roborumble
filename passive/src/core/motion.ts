// Where a fighter's motion comes from. Today: the SONIC kinematic planner. Later: Kimodo clips.
// The Fighter only asks for a named motion; a MotionSource answers with 50 Hz frames placed in the
// world and on the reference frame clock. LayeredSource tries clips first and falls back to the
// planner per motion, so clips can replace planner motions one at a time.
import { LIMBS, type Limb } from "./body.ts";
import { qconj, qmul, qrot, twistZ, yawOf, yawQuat } from "./math.ts";
import { Mode, type PlanBackend, planFrames } from "./planner.ts";
import { type Frame, REF_HZ, copyFrame, resample } from "./reference.ts";

export type MotionName =
  | "guard" // stand in guard, bouncing
  | "step" // boxer footwork in `move`'s direction
  | "getup.knees" | "getup.stand"
  | "punch.leftJab" | "punch.rightJab" | "punch.leftHook" | "punch.rightHook"
  | "dodge.left" | "dodge.right" | "dodge.back"
  | "block" | "duck" | "jump";

/** Every name a MotionSource may be asked for (a clip library can provide any of them). */
export const MOTION_NAMES: MotionName[] = [
  "guard", "step", "getup.knees", "getup.stand",
  "punch.leftJab", "punch.rightJab", "punch.leftHook", "punch.rightHook",
  "dodge.left", "dodge.right", "dodge.back", "block", "duck", "jump",
];

/**
 * When a limb of a move can hurt someone, in seconds from the move's first frame. `key` is when
 * the strike is meant to land (the server's hit frame); rules mode resolves it then. Default: mid-window.
 */
export interface StrikeWindow { limb: Limb; from: number; to: number; power: number; name: string; key?: number }

export interface MotionAsk {
  name: MotionName;
  /** 4 frames x 36 at 30 Hz, world frame (planner context) */
  context: number[];
  /** absolute reference frame of context[0] */
  contextFrame: number;
  /** absolute reference frame new motion should start at (clips use this) */
  startFrame: number;
  facing: [number, number];
  move?: [number, number];
  speed?: number;
  seed?: number;
}

export interface MotionClip {
  frames: Frame[]; // 50 Hz, world frame
  at: number; // absolute reference frame of frames[0]
  strikes?: StrikeWindow[];
  source: string;
  blend?: number; // crossfade frames into it (default 8)
}

export interface MotionSource {
  /** null: this source has nothing for that motion. Throws only on transport errors. */
  get(ask: MotionAsk): Promise<MotionClip | null>;
}

// Default strike windows for planner punches (measured on SONIC: a jab's fist meets a target in
// range 0.2-0.4 s after the plan starts, a hook's 0.5-0.6 s; contact needs real speed, so wide is fine).
const PUNCH: Record<string, { limb: Limb; from: number; to: number; power: number; key: number }> = {
  "punch.leftJab": { limb: "l_hand", from: 0.12, to: 0.85, power: 0.6, key: 0.32 },
  "punch.rightJab": { limb: "r_hand", from: 0.12, to: 0.85, power: 0.75, key: 0.32 },
  "punch.leftHook": { limb: "l_hand", from: 0.15, to: 0.95, power: 1.0, key: 0.56 },
  "punch.rightHook": { limb: "r_hand", from: 0.15, to: 0.95, power: 1.1, key: 0.56 },
};

export function defaultStrikes(name: MotionName): StrikeWindow[] | undefined {
  const p = PUNCH[name];
  return p ? [{ ...p, name: name.slice(6) }] : undefined;
}

/**
 * A strike window from the server's motion format (`hit: {joint, frame}` at `fps`): the limb can
 * land from a little before the key frame to a little after it. Null for an unknown joint.
 */
export function strikeFromHit(hit: { joint: string; frame: number } | null | undefined, fps: number, power = 1, name = "strike", before = 0.25, after = 0.2): StrikeWindow | null {
  if (!hit || !LIMBS.includes(hit.joint as Limb) || !Number.isFinite(hit.frame) || !(fps > 0)) return null;
  const t = hit.frame / fps;
  return { limb: hit.joint as Limb, from: Math.max(0, t - before), to: t + after, power, name, key: t };
}

/** How far a planner punch lunges: it steps toward the opponent at this speed while it punches (m/s). */
export const PUNCH_LUNGE = { speed: 0.2 };

/** Motion from the SONIC kinematic planner. */
export class PlannerSource implements MotionSource {
  private backend: PlanBackend;
  constructor(backend: PlanBackend) { this.backend = backend; }

  async get(ask: MotionAsk): Promise<MotionClip | null> {
    const f: [number, number, number] = [ask.facing[0], ask.facing[1], 0];
    const mv: [number, number, number] = ask.move ? [ask.move[0], ask.move[1], 0] : [0, 0, 0];
    let mode: number, movement = mv, speed = ask.speed ?? -1, height = -1;
    switch (ask.name) {
      case "guard": mode = Mode.idleBoxing; movement = [0, 0, 0]; break;
      case "step": mode = Mode.walkBoxing; break;
      case "getup.knees": mode = Mode.kneelTwoLeg; height = 0.3; movement = [0, 0, 0]; break;
      case "getup.stand": mode = Mode.idle; movement = [0, 0, 0]; break;
      case "punch.leftJab": mode = Mode.leftJab; [movement, speed] = lunge(f); break;
      case "punch.rightJab": mode = Mode.rightJab; [movement, speed] = lunge(f); break;
      case "punch.leftHook": mode = Mode.leftHook; [movement, speed] = lunge(f); break;
      case "punch.rightHook": mode = Mode.rightHook; [movement, speed] = lunge(f); break;
      case "dodge.left": case "dodge.right": case "dodge.back": mode = Mode.walkBoxing; speed = ask.speed ?? 0.9; break;
      default: return null; // block, duck and jump are acted out with overlays
    }
    const flat = await this.backend.plan({ context: ask.context, mode, movement, facing: f, speed, height, seed: ask.seed });
    const frames = planFrames(flat);
    if (!frames.length) return null;
    return { frames, at: ask.contextFrame, strikes: defaultStrikes(ask.name), source: "planner" };
  }
}

function lunge(f: [number, number, number]): [[number, number, number], number] {
  return PUNCH_LUNGE.speed > 0 ? [f, PUNCH_LUNGE.speed] : [[0, 0, 0], -1];
}

/**
 * qpos rows (36 values: root position, root quaternion w x y z, 29 joints in MuJoCo order) from the
 * motion JSON proposed for the server: {fps, joint_pos[T][29], root_pos[T][3], root_quat[T][4]}.
 * Null if the shapes don't line up.
 */
export function rowsFromJson(m: { fps?: number; joint_pos?: number[][]; root_pos?: number[][]; root_quat?: number[][] }): { qpos: number[][]; fps: number } | null {
  const j = m?.joint_pos, p = m?.root_pos, q = m?.root_quat;
  if (!Array.isArray(j) || !Array.isArray(p) || !Array.isArray(q) || j.length < 2 || p.length !== j.length || q.length !== j.length) return null;
  const qpos: number[][] = [];
  for (let t = 0; t < j.length; t++) {
    if (j[t]?.length !== 29 || p[t]?.length !== 3 || q[t]?.length !== 4) return null;
    qpos.push([...p[t], ...q[t], ...j[t]]);
  }
  return { qpos, fps: Number(m.fps) > 0 ? Number(m.fps) : 30 };
}

/** A recorded clip: rows of 36-value qpos (Kimodo-G1 CSV rows) at `fps`, plus optional strikes. */
export interface ClipData { fps: number; qpos: number[][]; strikes?: StrikeWindow[]; loop?: boolean }

/**
 * Motion from recorded clips (Kimodo). Each name maps to one or more variants. A clip is turned
 * to face `facing` and moved to where the body is, then plays from `startFrame`.
 * "step" picks step.forward/back/left/right by the move direction relative to facing.
 * Get-up clips are different: they keep the heading the body landed with, and the variant whose
 * first frame lies the way the body lies (face up, face down, on a side) is picked.
 */
export class ClipSource implements MotionSource {
  private clips: Map<string, ClipData[]>;
  constructor(clips: Record<string, ClipData[]>) {
    this.clips = new Map(Object.entries(clips).filter(([, v]) => v.length));
  }

  /** Loads /clips/index.json: {"guard": ["guard_a.json", ...], ...} (missing index = no clips). */
  static async fetch(base = "/clips"): Promise<ClipSource> {
    try {
      const res = await fetch(`${base}/index.json`);
      if (!res.ok) return new ClipSource({});
      const index = (await res.json()) as Record<string, string[]>;
      const out: Record<string, ClipData[]> = {};
      for (const [name, files] of Object.entries(index)) {
        out[name] = (await Promise.all(files.map(async (f) => {
          try { return (await (await fetch(`${base}/${f}`)).json()) as ClipData; } catch { return null; }
        }))).filter((c): c is ClipData => !!c && Array.isArray(c.qpos) && c.qpos.length > 1);
      }
      return new ClipSource(out);
    } catch {
      return new ClipSource({});
    }
  }

  has(name: string) { return this.clips.has(name); }
  get size() { return this.clips.size; }

  async get(ask: MotionAsk): Promise<MotionClip | null> {
    let key: string = ask.name;
    if (ask.name === "step" && ask.move) {
      const rel = Math.atan2(ask.move[1], ask.move[0]) - Math.atan2(ask.facing[1], ask.facing[0]);
      const a = Math.atan2(Math.sin(rel), Math.cos(rel));
      key = Math.abs(a) < Math.PI / 4 ? "step.forward" : Math.abs(a) > (3 * Math.PI) / 4 ? "step.back" : a > 0 ? "step.left" : "step.right";
    }
    const variants = this.clips.get(key);
    if (!variants) return null;
    const ctxEnd = ask.context.slice(36 * 3, 36 * 4);
    const qNow = [ctxEnd[3], ctxEnd[4], ctxEnd[5], ctxEnd[6]];
    const getup = ask.name.startsWith("getup");
    const clip = getup ? closestStart(variants, qNow, ask.seed ?? 0) : variants[Math.abs(ask.seed ?? 0) % variants.length];
    if (!(clip.fps > 0)) return null;
    let frames = resample(clip.qpos.map((r) => copyFrame(r)), clip.fps, REF_HZ);
    if (!frames.length) return null;
    // place: first frame's root at the body's current xy, its heading turned to `facing`
    // (a get-up keeps the heading the body has)
    const f0 = frames[0];
    const q0 = [f0[3], f0[4], f0[5], f0[6]];
    const turn = getup ? twistZ(qmul(qNow, qconj(q0))) : Math.atan2(ask.facing[1], ask.facing[0]) - yawOf(q0);
    const c = Math.cos(turn), s = Math.sin(turn), rot = yawQuat(turn);
    const x0 = f0[0], y0 = f0[1];
    frames = frames.map((f) => {
      const g = copyFrame(f);
      const dx = f[0] - x0, dy = f[1] - y0;
      g[0] = ctxEnd[0] + c * dx - s * dy;
      g[1] = ctxEnd[1] + s * dx + c * dy;
      const q = qmul(rot, [f[3], f[4], f[5], f[6]]);
      g[3] = q[0]; g[4] = q[1]; g[5] = q[2]; g[6] = q[3];
      return g;
    });
    return { frames, at: ask.startFrame, strikes: clip.strikes ?? defaultStrikes(ask.name), source: `clip:${key}`, blend: getup ? 15 : 8 };
  }
}

/** The variant whose first frame has gravity pointing the same way in the body as `q` does. */
function closestStart(variants: ClipData[], q: number[], seed: number): ClipData {
  const g = (qq: number[]) => qrot(qconj(qq), [0, 0, -1]);
  const gn = g(q);
  const scored = variants.map((v) => {
    const r = v.qpos[0];
    const gv = r && r.length >= 7 ? g([r[3], r[4], r[5], r[6]]) : [0, 0, -1];
    return { v, s: gn[0] * gv[0] + gn[1] * gv[1] + gn[2] * gv[2] };
  }).sort((a, b) => b.s - a.s);
  const near = scored.filter((x) => x.s > scored[0].s - 0.05);
  return near[Math.abs(seed) % near.length].v;
}

/** Tries each source in order; the first one with an answer wins. */
export class LayeredSource implements MotionSource {
  private sources: MotionSource[];
  constructor(...sources: MotionSource[]) { this.sources = sources; }
  async get(ask: MotionAsk): Promise<MotionClip | null> {
    let lastError: unknown = null;
    for (const s of this.sources) {
      try {
        const clip = await s.get(ask);
        if (clip) return clip;
      } catch (e) { lastError = e; }
    }
    if (lastError) throw lastError;
    return null;
  }
}

/** For tests: a source whose answers can be delayed or made to fail. */
export class FlakySource implements MotionSource {
  private inner: MotionSource; private failRate: number; private maxDelayMs: number; private rnd: () => number;
  constructor(inner: MotionSource, failRate: number, maxDelayMs: number, rnd: () => number) {
    this.inner = inner; this.failRate = failRate; this.maxDelayMs = maxDelayMs; this.rnd = rnd;
  }
  async get(ask: MotionAsk): Promise<MotionClip | null> {
    const roll = this.rnd();
    if (this.maxDelayMs > 0) await new Promise((r) => setTimeout(r, this.rnd() * this.maxDelayMs));
    if (roll < this.failRate * 0.5) throw new Error("injected planner failure");
    if (roll < this.failRate) return null;
    return this.inner.get(ask);
  }
}

