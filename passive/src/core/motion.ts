// Where a fighter's motion comes from. Today: the SONIC kinematic planner. Later: Kimodo clips.
// The Fighter only asks for a named motion; a MotionSource answers with 50 Hz frames placed in the
// world and on the reference frame clock. LayeredSource tries clips first and falls back to the
// planner per motion, so clips can replace planner motions one at a time.
import { LIMBS, type Limb } from "./body.ts";
import { qconj, qmul, qrot, twistZ, wrapPi, yawOf, yawQuat } from "./math.ts";
import { Mode, type PlanBackend, planFrames } from "./planner.ts";
import { type Frame, REF_HZ, copyFrame, fixQuatSigns, mixFrames, resample } from "./reference.ts";

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
  /** plan ahead of footwork (attacks, defenses, get-ups); the planner serves these first */
  urgent?: boolean;
  /** which fighter asks (0, 1), filled by the fighter's view of a source that tells fighters apart (forAsker) */
  who?: number;
  /** that fighter's character (rig: "elf", "knight"); a clip library prefers "guard.<character>" */
  character?: string;
}

export interface MotionClip {
  frames: Frame[]; // 50 Hz, world frame
  at: number; // absolute reference frame of frames[0]
  strikes?: StrikeWindow[];
  source: string;
  blend?: number; // crossfade frames into it (default 8)
  /** s from frames[0] that a defense acted out by this clip lasts (recorded clips set it; the planner doesn't) */
  active?: number;
}

/** Who is asking: a Fighter (its index and character). */
export interface Asker { readonly index: number; readonly character?: string }

export interface MotionSource {
  /** null: this source has nothing for that motion. Throws only on transport errors. */
  get(ask: MotionAsk): Promise<MotionClip | null>;
  /**
   * A view of this source for one fighter, for sources that keep per-fighter state (a clip library:
   * one guard variant and loop phase each). The Fighter asks through it; its asks carry who and character.
   */
  forAsker?(a: Asker): MotionSource;
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
    const flat = await this.backend.plan({ context: ask.context, mode, movement, facing: f, speed, height, seed: ask.seed, urgent: ask.urgent });
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

/**
 * A recorded clip: rows of 36-value qpos (Kimodo-G1 CSV rows) at `fps`, plus optional metadata.
 * Each field may also sit in `meta` (kgen writes the job's meta there); the top level wins.
 *   strikes  when which limb can hurt, s from the untrimmed first row
 *   hit      {joint, frame}: the strike's key row (untrimmed, at fps), used when there are no
 *            strikes (meta.hit_limb or meta.hit_joint + meta.hit_frame say the same; frame < 0: none)
 *   loop     it loops (guard): each fighter plays on from where its loop is now (see ClipSource)
 *   active   s a defense acted out by it lasts, from its first played row (default: its length - 0.2 s)
 *   trim     [startSec, endSec]: only that part plays (strikes, hit and active follow the cut)
 *   blend    s of crossfade into it (default 0.16, get-ups 0.3)
 */
export interface ClipData {
  fps: number; qpos: number[][]; strikes?: StrikeWindow[]; loop?: boolean;
  hit?: { joint: string; frame: number } | null; active?: number; trim?: [number, number]; blend?: number;
  meta?: Record<string, unknown>;
}

/** A clip made ready to play: trimmed 50 Hz frames, its metadata, and for a loop one seamless cycle. */
interface Prepared {
  frames: Frame[]; fps: number; strikes?: StrikeWindow[]; hit: { joint: string; frame: number } | null;
  active?: number; blend?: number; cycle: Frame[] | null; cycleYaw: number;
}

const PREPARED = new WeakMap<ClipData, Prepared | null>();
/** s of crossfade at a loop's seam, and s of a loop served per ask (the next ask plays on from there). */
export const LOOP = { seam: 0.2, ahead: 2.4 };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A clip's trimmed 50 Hz frames and metadata (cached per clip); null if it can't be played. */
function prepare(c: ClipData): Prepared | null {
  if (PREPARED.has(c)) return PREPARED.get(c)!;
  let out: Prepared | null = null;
  try { out = prepareNow(c); } catch { out = null; }
  PREPARED.set(c, out);
  return out;
}

function prepareNow(c: ClipData): Prepared | null {
  const m = (c.meta && typeof c.meta === "object" ? c.meta : {}) as Record<string, unknown>;
  const fps = num(c.fps) ?? num(m.fps) ?? 0;
  if (!(fps > 0) || !Array.isArray(c.qpos) || c.qpos.length < 2 || c.qpos.some((r) => !r || r.length < 36)) return null;
  const trim = (Array.isArray(c.trim) ? c.trim : m.trim) as unknown;
  let i0 = 0, i1 = c.qpos.length - 1;
  if (Array.isArray(trim) && trim.length === 2 && num(trim[0]) !== undefined && num(trim[1]) !== undefined && trim[1] > trim[0]) {
    i0 = Math.max(0, Math.min(c.qpos.length - 2, Math.round(trim[0] * fps)));
    i1 = Math.max(i0 + 1, Math.min(c.qpos.length - 1, Math.round(trim[1] * fps)));
  }
  const shift = i0 / fps;
  const frames = resample(c.qpos.slice(i0, i1 + 1).map((r) => copyFrame(r)), fps, REF_HZ);
  if (frames.length < 2) return null;
  const st = (Array.isArray(c.strikes) ? c.strikes : Array.isArray(m.strikes) ? m.strikes : null) as StrikeWindow[] | null;
  const strikes = st ? st.filter((w) => w && num(w.from) !== undefined && num(w.to) !== undefined && w.to - shift > 0)
    .map((w) => ({ ...w, from: Math.max(0, w.from - shift), to: w.to - shift, key: num(w.key) !== undefined ? w.key! - shift : undefined })) : undefined;
  let hit = (c.hit ?? m.hit ?? null) as { joint: string; frame: number } | null;
  const hj = m.hit_limb ?? m.hit_joint, hf = num(m.hit_frame);
  if (!hit && typeof hj === "string" && hf !== undefined) hit = { joint: hj, frame: hf };
  hit = hit && typeof hit.joint === "string" && num(hit.frame) !== undefined && hit.frame >= 0 ? { joint: hit.joint, frame: hit.frame - i0 } : null;
  const active = num(c.active) ?? num(m.active), blend = num(c.blend) ?? num(m.blend);
  const loop = c.loop ?? m.loop === true;
  const cycle = loop && frames.length >= 20 ? loopCycle(frames) : null;
  let sx = 0, sy = 0;
  if (cycle) for (const f of cycle) { const y = yawOf([f[3], f[4], f[5], f[6]]); sx += Math.cos(y); sy += Math.sin(y); }
  return { frames, fps, strikes, hit, active: active !== undefined && active > 0 ? active : undefined, blend: blend !== undefined && blend > 0 ? blend : undefined, cycle, cycleYaw: Math.atan2(sy, sx) };
}

/**
 * One cycle of a looping clip that plays on seamlessly: its net drift (xy and heading over the
 * cycle) is taken out so a cycle ends where it began, and when its last and first poses differ its
 * last LOOP.seam s are crossfaded into its first ones (the cycle is that much shorter).
 */
function loopCycle(frames: Frame[]): Frame[] {
  const n = frames.length, B = Math.max(1, Math.min(Math.round(LOOP.seam * REF_HZ), Math.floor(n / 4)));
  const a = frames[0], z = frames[n - 1];
  let jump = Math.abs(z[2] - a[2]) * 5; // 2 cm of pelvis height counts like 0.1 rad
  for (let j = 7; j < 36; j++) jump = Math.max(jump, Math.abs(z[j] - a[j]));
  const L = jump > 0.05 ? n - B : n - 1; // a clip that already closes: its last frame is its first again
  const e = frames[L];
  const dYaw = wrapPi(yawOf([e[3], e[4], e[5], e[6]]) - yawOf([a[3], a[4], a[5], a[6]])), dx = e[0] - a[0], dy = e[1] - a[1];
  const out = frames.map((f, i) => {
    const k = i / L, c = Math.cos(-dYaw * k), s = Math.sin(-dYaw * k), g = copyFrame(f);
    const rx = f[0] - a[0] - dx * k, ry = f[1] - a[1] - dy * k;
    g[0] = a[0] + c * rx - s * ry; g[1] = a[1] + s * rx + c * ry;
    const q = qmul(yawQuat(-dYaw * k), [f[3], f[4], f[5], f[6]]);
    g[3] = q[0]; g[4] = q[1]; g[5] = q[2]; g[6] = q[3];
    return g;
  });
  fixQuatSigns(out);
  const cycle = out.slice(0, L);
  if (L === n - B) for (let k = 0; k < B; k++) cycle[k] = mixFrames(out[L + k], out[k], (k + 1) / (B + 1));
  return cycle;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Motion from recorded clips (Kimodo). Each name maps to one or more variants. A clip is turned
 * to face `facing` and moved to where the body is, then plays from `startFrame`.
 * "step" picks step.forward/back/left/right by the move direction relative to facing.
 * "guard" prefers "guard.<character>" when the library has one for the asking fighter's character.
 * A looping clip (guard) plays on: each fighter keeps one variant for good, and its loop runs on
 * the reference frame clock, so a new ask continues where the loop is now (LOOP.ahead s at a time).
 * Get-up clips are different: they keep the heading the body landed with, and the variant whose
 * first frame lies the way the body lies (face up, face down, on a side) is picked; none if no
 * variant lies within 60 degrees of it (a face-up get-up never plays face down).
 */
export class ClipSource implements MotionSource {
  private clips: Map<string, ClipData[]>;
  /** fighter|key -> its guard variant, and the frame its loop started on */
  private picks = new Map<string, number>();
  private anchors = new Map<string, number>();
  constructor(clips: Record<string, ClipData[]>) {
    this.clips = new Map(Object.entries(clips).filter(([, v]) => v.length));
  }

  /**
   * Loads clip libraries: each base has an index.json, {"guard": ["guard_a.json", ...], ...}
   * (missing index = no clips there). With several bases, the first one that has a motion supplies
   * all of its variants.
   */
  static async fetch(base: string | string[] = "/clips"): Promise<ClipSource> {
    const out: Record<string, ClipData[]> = {};
    for (const b of Array.isArray(base) ? base : [base]) {
      try {
        const res = await fetch(`${b}/index.json`);
        if (!res.ok) continue;
        const index = (await res.json()) as Record<string, string[]>;
        for (const [name, files] of Object.entries(index)) {
          if (out[name]?.length || !Array.isArray(files)) continue;
          out[name] = (await Promise.all(files.map(async (f) => {
            try { return (await (await fetch(`${b}/${f}`)).json()) as ClipData; } catch { return null; }
          }))).filter((c): c is ClipData => !!c && Array.isArray(c.qpos) && c.qpos.length > 1);
        }
      } catch { /* no clips there */ }
    }
    return new ClipSource(out);
  }

  has(name: string) { return this.clips.has(name); }
  get size() { return this.clips.size; }

  forAsker(a: Asker): MotionSource {
    return { get: (ask) => this.get({ ...ask, who: ask.who ?? a.index, character: ask.character ?? a.character }) };
  }

  async get(ask: MotionAsk): Promise<MotionClip | null> {
    let key: string = ask.name;
    if (ask.name === "step" && ask.move) {
      const rel = Math.atan2(ask.move[1], ask.move[0]) - Math.atan2(ask.facing[1], ask.facing[0]);
      const a = Math.atan2(Math.sin(rel), Math.cos(rel));
      key = Math.abs(a) < Math.PI / 4 ? "step.forward" : Math.abs(a) > (3 * Math.PI) / 4 ? "step.back" : a > 0 ? "step.left" : "step.right";
    }
    if (ask.name === "guard" && ask.character && this.clips.has(`guard.${ask.character}`)) key = `guard.${ask.character}`;
    const variants = this.clips.get(key);
    if (!variants) return null;
    const ctxEnd = ask.context.slice(36 * 3, 36 * 4);
    const qNow = [ctxEnd[3], ctxEnd[4], ctxEnd[5], ctxEnd[6]];
    const getup = ask.name.startsWith("getup");
    const clip = getup ? closestStart(variants, qNow, ask.seed ?? 0) : this.pick(key, variants, ask);
    const p = clip ? prepare(clip) : null;
    if (!p) return null;
    let frames: Frame[], yaw0: number, origin: ArrayLike<number> = ctxEnd;
    if (p.cycle) {
      // a loop plays on from where it is now on this fighter's frame clock, from where the body is
      const id = `${ask.who ?? -1}|${key}`, L = p.cycle.length;
      if (!this.anchors.has(id)) this.anchors.set(id, ask.startFrame);
      const k = mod(ask.startFrame - this.anchors.get(id)!, L);
      frames = [];
      for (let j = 0; j < Math.round(LOOP.ahead * REF_HZ); j++) frames.push(copyFrame(p.cycle[(k + j) % L]));
      yaw0 = p.cycleYaw;
      const n = Math.max(0, Math.min(3, Math.round(((ask.startFrame - ask.contextFrame) * 30) / REF_HZ)));
      origin = ask.context.slice(36 * n, 36 * n + 2);
    } else {
      frames = p.frames.map(copyFrame);
      yaw0 = yawOf([frames[0][3], frames[0][4], frames[0][5], frames[0][6]]);
    }
    // place: first frame's root at the body's current xy, its heading turned to `facing`
    // (a get-up keeps the heading the body has)
    const f0 = frames[0];
    const q0 = [f0[3], f0[4], f0[5], f0[6]];
    const turn = getup ? twistZ(qmul(qNow, qconj(q0))) : Math.atan2(ask.facing[1], ask.facing[0]) - yaw0;
    const c = Math.cos(turn), s = Math.sin(turn), rot = yawQuat(turn);
    const x0 = f0[0], y0 = f0[1];
    frames = frames.map((f) => {
      const g = copyFrame(f);
      const dx = f[0] - x0, dy = f[1] - y0;
      g[0] = origin[0] + c * dx - s * dy;
      g[1] = origin[1] + s * dx + c * dy;
      const q = qmul(rot, [f[3], f[4], f[5], f[6]]);
      g[3] = q[0]; g[4] = q[1]; g[5] = q[2]; g[6] = q[3];
      return g;
    });
    const pu = PUNCH[ask.name];
    const strikes = p.strikes ?? (p.hit ? [strikeFromHit(p.hit, p.fps, pu?.power ?? 1, pu ? ask.name.slice(6) : key)].filter((w): w is StrikeWindow => !!w) : undefined);
    const dur = (frames.length - 1) / REF_HZ;
    return {
      frames, at: ask.startFrame, strikes: strikes?.length ? strikes : defaultStrikes(ask.name), source: `clip:${key}`,
      blend: p.blend !== undefined ? Math.max(1, Math.min(30, Math.round(p.blend * REF_HZ))) : getup ? 15 : 8,
      active: Math.min(dur, p.active ?? Math.max(0.2, dur - 0.2)),
    };
  }

  /** A variant for this ask: by seed, except a guard (or any loop), which sticks per fighter once picked. */
  private pick(key: string, variants: ClipData[], ask: MotionAsk): ClipData {
    const seed = Math.abs(ask.seed ?? 0);
    if (variants.length === 1) return variants[0];
    if (!key.startsWith("guard") && !variants.some((v) => v.loop || v.meta?.loop === true)) return variants[seed % variants.length];
    const id = `${ask.who ?? -1}|${key}`;
    let i = this.picks.get(id);
    if (i === undefined) { i = seed % variants.length; this.picks.set(id, i); }
    return variants[i];
  }
}

/**
 * The variant whose first frame has gravity pointing the same way in the body as `q` does; null
 * when none is within 60 degrees of it.
 */
function closestStart(variants: ClipData[], q: number[], seed: number): ClipData | null {
  const g = (qq: number[]) => qrot(qconj(qq), [0, 0, -1]);
  const gn = g(q);
  const scored = variants.map((v) => {
    const t = prepare(v), r = t ? t.frames[0] : v.qpos[0];
    const gv = r && r.length >= 7 ? g([r[3], r[4], r[5], r[6]]) : [0, 0, -1];
    return { v, s: gn[0] * gv[0] + gn[1] * gv[1] + gn[2] * gv[2] };
  }).sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 0.5) return null;
  const near = scored.filter((x) => x.s > scored[0].s - 0.05);
  return near[Math.abs(seed) % near.length].v;
}

/** Tries each source in order; the first one with an answer wins. */
export class LayeredSource implements MotionSource {
  private sources: MotionSource[];
  constructor(...sources: MotionSource[]) { this.sources = sources; }
  /** The same layers, each seen by one fighter where it keeps per-fighter state (itself if none does). */
  forAsker(a: Asker): MotionSource {
    return this.sources.some((s) => s.forAsker) ? new LayeredSource(...this.sources.map((s) => s.forAsker?.(a) ?? s)) : this;
  }
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

