// Scores candidate Kimodo clips for the everyday motions the way the game uses them, headless on
// SONIC + MuJoCo. Each candidate replaces only its own motion (LayeredSource(ClipSource({[motion]:
// [clip]}), PlannerSource)), and P1 plays it through the fighter's public API (footwork, defend,
// throwPunch, knockdowns and get-ups) against P2. Contact hit mode throughout.
//   node scripts/clip-check.ts <dirs or files...> [--motion <key>[,<key>...]] [--baseline]
//        [--out report.json] [--shard i/n] [--trials N] [--quiet]
// Candidates: ClipData JSONs ({fps, qpos, ...}) whose meta.motion (or motion) names their key (kgen
// output DIR/<job>/s<k>.json; directories are searched recursively), or a library index.json
// ({"guard": ["a.json"], ...}, e.g. public/clips-kimodo/index.json; spell.* keys are skipped).
// --motion keeps only those keys ("punch.*" works). --baseline adds today's planner-only behaviour
// for each motion (no clip). --shard i/n (1-based) scores every n-th candidate from the i-th, so n
// processes can split a batch. --trials N: punches are thrown N times (default 4, at punchRange
// -5..+5 cm); steps are taken twice; get-ups take ceil(N/4) knockdowns each way.
//
// On a shared box run it with ORT_THREADS=2 (scripts/node-arena.ts) and at most 3 processes.
//
// Scenarios (P1 is tested; P2 stands still unless it attacks or boxes, as said):
//   guard    7 s boxing in place 1.4 m from P2, footwork steps turned into guards (the first 1 s
//            settles): falls, pelvis bob (std of pelvis z), share of ticks with both gloves at
//            guard height (head z -0.30..+0.05 and in front of the chest), planted-foot slide,
//            the clip's raw loop seam (end vs start) and the biggest per-frame joint jump in the
//            reference P1 follows, tracking error (FK of that reference vs physics: head and
//            hands, root-relative, cm).
//   step.*   one footwork step that way after 1.5 s of guard: pelvis travel the intended way
//            (want 0.15-0.45 m), sideways error, heading change against the line to P2 (want
//            < 15 deg), falls, gloves up at the end.
//   dodge.*, duck   defend(kind) as P2's planner jab (a hook for duck) is timed to land 0.3 s
//            later (calibrated undefended): head travel the intended way at 0.2/0.3/0.45 s
//            (sideways in P1's frame / away from P2 / down; want >= 0.18 m by 0.3 s); did the
//            punch miss (the game's result) and by how much (the fist's closest gap; over 0.05 m
//            it misses even without the dodge rule); falls; back in guard 2.5 s after.
//   block    defend("block") against a jab and a hook timed the same way: both gloves in front of
//            the face within 0.15 s and for >= 0.6 s; every hit blocked; falls.
//   jump     defend("jump"): both feet >= 0.06 m up for >= 0.12 s, shins clear of a sweep at
//            0.06 m (lowest shin point >= 0.10 m), lands upright.
//   punch.*  throwPunch as in a fight, N times: P2 boxes on the planner, P1 steps in from 1.4 m to
//            its punch range (TUNE.punchRange, -5..+5 cm across the trials) and throws: land rate,
//            fist peak speed, impact time vs the strike key, falls, back in guard 1 s after the move;
//            and from the clip itself (FK), how far the fist travels forward (a jab that starts
//            extended only "lands" because the splice snaps the arm out).
//   getup.*  knockdowns from the front (lands face up) and from behind (face down), then the
//            get-up with the candidate answering: up without the full lift, seconds, most help,
//            re-falls within 2 s, and whether the clip was used at all (a get-up clip only plays
//            when its first frame lies the way the body lies).
// Gates (pass): never falls (get-ups: no re-fall) and the motion's main threshold. guard: gloves up
// >= 60% and bob <= 4 cm; step: travel >= 0.12 m (each trial) and heading < 30 deg; dodge/duck:
// >= 0.18 m by 0.3 s and the punch missed; block: up by 0.2 s, held >= 0.5 s, nothing clean;
// jump: airborne >= 0.12 s; punch: lands at least half the time and the clip's fist travels
// >= 0.15 m; get-up: up without the full lift in every trial that used the clip (at least one).
// Score (0..100, to rank candidates of one motion; a candidate that falls scores at most 20):
//   guard  40 gloves + 20 bob (1 within 1-3 cm, 0 at 0 and 6 cm) + 15 slide (0 at 5 cm/s)
//          + 15 tracking (1 at 3 cm, 0 at 15 cm) + 10 smooth (0 at a 10 deg joint jump per frame)
//   step   40 travel (1 within 0.15-0.45 m, 0 at 0.05 and 0.7 m) + 20 straight (0 when the
//          sideways error equals the travel) + 20 heading (0 at 30 deg) + 20 gloves up at the end
//   dodge  35 travel by 0.3 s (1 at 0.25 m) + 10 travel by 0.2 s (1 at 0.12 m) + 25 missed
//          + 15 clear miss + 15 back in guard
//   block  30 up time (1 at 0.1 s, 0 at 0.35 s) + 30 held (1 at 0.8 s) + 40 share blocked
//   jump   40 airborne (1 at 0.25 s) + 20 sweep clear + 20 height (1 at 0.12 m) + 20 lands upright
//   punch  (50 land rate + 20 fist speed (1 at 4 m/s) + 15 timing (0 at 0.3 s off the key)
//          + 15 back in guard) x (0.5 + 0.5 thrown); thrown: 0 at 0.05 m of clip fist travel, 1 at 0.25 m
//   getup  50 success + 25 speed (1 at 3 s, 0 at 12 s) + 15 little help (0 at a 0.95 lift)
//          + 10 no re-fall
// Output: a console line per candidate and, with --out, JSON [{file, motion, job, sample, pass,
// score, metrics, notes, seconds}] (seconds: wall time for that candidate).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { ATTACKS } from "../src/core/attacks.ts";
import type { ArenaEvent } from "../src/core/events.ts";
import { type Defense, type Fighter, type PunchName, TUNE } from "../src/core/fighter.ts";
import { qconj, qrot, tiltOf, wrapPi, yawOf } from "../src/core/math.ts";
import { type ClipData, ClipSource, LayeredSource, type MotionAsk, type MotionClip, type MotionSource, PlannerSource, type StrikeWindow } from "../src/core/motion.ts";
import type { Frame } from "../src/core/reference.ts";
import { nodeArena } from "./node-arena.ts";

// ---------- arguments and candidates ----------
const argv = process.argv.slice(2);
const VALUED = new Set(["--motion", "--out", "--shard", "--trials"]);
const opt = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const paths = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const QUIET = argv.includes("--quiet");
const TRIALS = Math.max(1, Math.round(Number(opt("--trials", "4")) || 4));
const OUT = opt("--out");
const want = opt("--motion").split(",").map((s) => s.trim()).filter(Boolean);
const [shardI, shardN] = (opt("--shard", "1/1").split("/").map(Number) as [number, number]);

const MOTIONS = ["guard", "step.forward", "step.back", "step.left", "step.right", "dodge.left", "dodge.right", "dodge.back", "duck", "block", "jump",
  "punch.leftJab", "punch.rightJab", "punch.leftHook", "punch.rightHook", "getup.knees", "getup.stand"];
type Scenario = "guard" | "step" | "dodge" | "block" | "jump" | "punch" | "getup";
const scenarioOf = (m: string): Scenario | null =>
  m === "guard" || m.startsWith("guard.") ? "guard" : m.startsWith("step.") && MOTIONS.includes(m) ? "step"
    : m.startsWith("dodge.") && MOTIONS.includes(m) || m === "duck" ? "dodge" : m === "block" ? "block" : m === "jump" ? "jump"
      : m.startsWith("punch.") && MOTIONS.includes(m) ? "punch" : m === "getup.knees" || m === "getup.stand" ? "getup" : null;
const wanted = (m: string) => !want.length || want.some((k) => k === m || (k.endsWith("*") && m.startsWith(k.slice(0, -1))));

interface Cand { file: string; motion: string; job: string; sample: string; data: ClipData | null }
const cands: Cand[] = [];
const skipped: string[] = [];
const rel = (f: string) => relative(process.cwd(), f) || f;
const walk = (p: string, out: string[]) => {
  const st = statSync(p);
  if (st.isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f), out);
  else if (p.endsWith(".json")) out.push(p);
};
const files: string[] = [];
for (const p of paths) { try { walk(p, files); } catch { skipped.push(`${p}: not found`); } }
const read = (f: string): unknown => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
for (const f of files) {
  const j = read(f) as Record<string, unknown> | undefined;
  if (!j || typeof j !== "object") { skipped.push(`${rel(f)}: not JSON`); continue; }
  if (Array.isArray(j.qpos)) {
    const meta = (j.meta ?? {}) as Record<string, unknown>;
    const motion = String(meta.motion ?? j.motion ?? "");
    if (!motion) continue; // a clip of a library listed by its index, or not a candidate
    cands.push({ file: rel(f), motion, job: String(meta.job ?? basename(dirname(f))), sample: String(meta.sample ?? basename(f, ".json")), data: j as unknown as ClipData });
  } else if (!Array.isArray(j) && Object.values(j).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string"))) {
    for (const [key, list] of Object.entries(j as Record<string, string[]>)) {
      if (key.startsWith("spell.")) continue;
      for (const c of list) {
        const d = read(join(dirname(f), c)) as ClipData | undefined;
        if (d && Array.isArray(d.qpos)) cands.push({ file: rel(join(dirname(f), c)), motion: key, job: "library", sample: basename(c, ".json"), data: d });
        else skipped.push(`${key}: ${c} unreadable`);
      }
    }
  }
}
const seen = new Set<string>();
let todo = cands.filter((c) => { const k = `${c.file}|${c.motion}`; if (seen.has(k)) return false; seen.add(k); return true; });
for (const c of todo) if (!scenarioOf(c.motion)) skipped.push(`${c.motion} (${c.file}): no scenario for it`);
todo = todo.filter((c) => scenarioOf(c.motion) && wanted(c.motion));
if (argv.includes("--baseline")) {
  const ms = want.length ? MOTIONS.filter(wanted) : todo.length ? [...new Set(todo.map((c) => (c.motion.startsWith("guard") ? "guard" : c.motion)))] : MOTIONS;
  for (const m of ms) todo.push({ file: "(planner)", motion: m, job: "baseline", sample: "planner", data: null });
}
todo.sort((a, b) => (a.motion === b.motion ? (a.file < b.file ? -1 : 1) : a.motion < b.motion ? -1 : 1));
if (shardN > 1) todo = todo.filter((_, i) => i % shardN === (shardI - 1) % shardN);
if (!todo.length) {
  console.log("nothing to score: pass clip files, directories or an index.json, and/or --baseline");
  if (skipped.length) console.log(`skipped:\n  ${skipped.join("\n  ")}`);
  process.exit(1);
}

// ---------- the arena ----------
const { mj, world, planner, arena } = await nodeArena({ autoKO: false });
if (!planner) { console.log("no planner model: run npm run setup:planner first"); process.exit(1); }
const PLANNER = new PlannerSource(planner);
const [p1, p2] = arena.fighters;
type Ev = ArenaEvent & { t: number };
let log: Ev[] = [];
arena.on((e) => log.push({ ...e, t: arena.time } as Ev));
const run = async (s: number, each?: () => boolean | void) => {
  for (let i = 0, n = Math.round(s * 50); i < n; i++) { await arena.tick(); if (each?.()) return true; }
  return false;
};

/** P1's source: logs every answer, turns footwork steps into guards, or into one step a given way. */
interface Answer { name: string; source: string; at: number; t0: number; n: number; strikes?: StrikeWindow[] }
class Director implements MotionSource {
  inner: MotionSource; step: number | null = null; answers: Answer[] = [];
  constructor(inner: MotionSource) { this.inner = inner; }
  async get(ask: MotionAsk): Promise<MotionClip | null> {
    let a: MotionAsk = { ...ask, who: 0 };
    if (!ask.urgent && (ask.name === "step" || ask.name === "guard")) {
      if (this.step !== null) {
        const y = Math.atan2(ask.facing[1], ask.facing[0]) + this.step;
        a = { ...a, name: "step", move: [Math.cos(y), Math.sin(y)], speed: 0.45 };
        this.step = null;
      } else if (ask.name === "step") a = { ...a, name: "guard", move: undefined };
    }
    const c = await this.inner.get(a);
    if (c) this.answers.push({ name: a.name, source: c.source, at: c.at, t0: arena.time + (c.at - p1.ref.now) / 50, n: c.frames.length, strikes: c.strikes });
    return c;
  }
}
const sourceFor = (c: Cand): MotionSource =>
  c.data ? new LayeredSource(new ClipSource({ [c.motion.startsWith("guard") ? "guard" : c.motion]: [c.data] }), PLANNER) : PLANNER;

/** Both fighters stood d apart facing each other, P1 on `src`, P2 on `src2` (null: stands still). */
async function setup(d: number, src: MotionSource, src2: MotionSource | null, settle: number) {
  arena.reset();
  arena.combat.mode = "contact";
  p1.spawn(-d / 2, 0, 0); p2.spawn(d / 2, 0, Math.PI);
  p1.motion = src; p2.motion = src2;
  await run(settle);
  arena.hp = [100, 100]; p1.poise = p2.poise = 1;
  log = [];
}

// ---------- measuring ----------
const limb = (f: Fighter, l: keyof Fighter["body"]["strikers"]) => { const s = f.body.strikers[l]; return world.pointOn(s.body, s.local); };
const head = (f: Fighter) => f.body.headPos();
const chest = (f: Fighter) => { const [a, b] = f.body.segment(f.body.hurt[1]); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; };
const fellNow = (who: 0 | 1, since = -1) => log.some((e) => (e.type === "fall" || e.type === "knockdown") && e.who === who && e.t >= since);
/** Both gloves at guard height (head z -0.30..+0.05) and in front of the chest. */
function glovesUp(f: Fighter): boolean {
  const h = head(f), c = chest(f), [fx, fy] = f.facingOpponent();
  for (const l of ["l_hand", "r_hand"] as const) {
    const p = limb(f, l);
    if (p[2] < h[2] - 0.3 || p[2] > h[2] + 0.05 || (p[0] - c[0]) * fx + (p[1] - c[1]) * fy < 0.05) return false;
  }
  return true;
}
/** Each glove relative to the head: [up, forward (toward P2), left] for the left glove, then the right. */
function gloveOffsets(f: Fighter): number[] {
  const h = head(f), [fx, fy] = f.facingOpponent(), out: number[] = [];
  for (const l of ["l_hand", "r_hand"] as const) {
    const p = limb(f, l), dx = p[0] - h[0], dy = p[1] - h[1];
    out.push(p[2] - h[2], dx * fx + dy * fy, -dx * fy + dy * fx);
  }
  return out;
}
/** Both gloves in front of the face (a block): -0.15..+0.12 m of head height, 0.02-0.40 m in front, within 0.22 m sideways. */
const gloves2Face = (g: number[]) => [0, 3].every((k) => g[k] >= -0.15 && g[k] <= 0.12 && g[k + 1] >= 0.02 && g[k + 1] <= 0.4 && Math.abs(g[k + 2]) <= 0.22);
const tilt = (f: Fighter) => tiltOf(world.rootQuat(f.robot));
const yawNow = (f: Fighter) => yawOf(world.rootQuat(f.robot));
const bearing = (f: Fighter) => { const [x, y] = f.facingOpponent(); return Math.atan2(y, x); };
const lin = (x: number, x0: number, x1: number) => Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
const band = (x: number, z0: number, a: number, b: number, z1: number) => (x < a ? lin(x, z0, a) : x > b ? 1 - lin(x, b, z1) : 1);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// tracking: forward kinematics of the reference on a scratch copy of the world
const ghost = new mj.MjData(world.model);
const pointIn = (d: { xpos: Float64Array; xmat: Float64Array }, body: number, l: ArrayLike<number>) => {
  const x = d.xpos, R = d.xmat, o = body * 9, t = body * 3;
  return [x[t] + R[o] * l[0] + R[o + 1] * l[1] + R[o + 2] * l[2], x[t + 1] + R[o + 3] * l[0] + R[o + 4] * l[1] + R[o + 5] * l[2], x[t + 2] + R[o + 6] * l[0] + R[o + 7] * l[1] + R[o + 8] * l[2]];
};
/** Head and gloves relative to the pelvis, turned to its heading. */
function keyPoints(f: Fighter, d: { xpos: Float64Array; xmat: Float64Array }, root: ArrayLike<number>, yaw: number): number[][] {
  const h = f.body.hurt[0], s = f.body.strikers;
  const c = Math.cos(-yaw), sn = Math.sin(-yaw);
  return [pointIn(d, h.body, h.a), pointIn(d, s.l_hand.body, s.l_hand.local), pointIn(d, s.r_hand.body, s.r_hand.local)].map((p) => {
    const dx = p[0] - root[0], dy = p[1] - root[1];
    return [c * dx - sn * dy, sn * dx + c * dy, p[2] - root[2]];
  });
}
/** Mean distance (m) between where the reference puts head and gloves and where the body has them. */
function trackingError(f: Fighter): number {
  const fr: Frame = f.ref.current(), r = f.robot;
  ghost.qpos.set(world.data.qpos);
  for (let i = 0; i < 7; i++) ghost.qpos[r.qposRoot + i] = fr[i];
  for (let j = 0; j < 29; j++) ghost.qpos[r.qpos[j]] = fr[7 + j];
  mj.mj_kinematics(world.model, ghost);
  const want = keyPoints(f, ghost, fr, yawOf([fr[3], fr[4], fr[5], fr[6]]));
  const got = keyPoints(f, world.data, world.rootPos(r), yawNow(f));
  return mean(want.map((w, k) => Math.hypot(w[0] - got[k][0], w[1] - got[k][1], w[2] - got[k][2])));
}

/**
 * The punching fist in the clip itself (FK of its rows, relative to the pelvis, along its heading):
 * where it starts, how far forward it gets, and how far it travels forward from the start. A clip
 * whose arm starts extended "lands" only because the splice snaps the arm out.
 */
function clipFist(data: ClipData, hand: "l_hand" | "r_hand") {
  const r = p1.robot, s = p1.body.strikers[hand], fwd: number[] = [];
  for (const row of data.qpos) {
    ghost.qpos.set(world.data.qpos);
    for (let i = 0; i < 7; i++) ghost.qpos[r.qposRoot + i] = row[i];
    for (let j = 0; j < 29; j++) ghost.qpos[r.qpos[j]] = row[7 + j];
    mj.mj_kinematics(world.model, ghost);
    const p = pointIn(ghost, s.body, s.local), y = yawOf([row[3], row[4], row[5], row[6]]);
    fwd.push((p[0] - row[0]) * Math.cos(y) + (p[1] - row[1]) * Math.sin(y));
  }
  const max = Math.max(...fwd);
  return { start: fwd[0], reach: max, travel: max - fwd[0], peakS: fwd.indexOf(max) / (data.fps || 30) };
}

interface Result { pass: boolean; score: number; metrics: Record<string, unknown>; notes: string[]; line: string }
const fallCap = (score: number, fell: boolean) => (fell ? Math.min(20, score) : score);

// ---------- scenarios ----------
async function guard(c: Cand): Promise<Result> {
  const dir = new Director(sourceFor(c));
  await setup(1.4, dir, null, 1.0);
  const z: number[] = [], track: number[] = [];
  let up = 0, n = 0, slide = 0, jump = 0;
  const feet0 = [limb(p1, "l_foot")[2], limb(p1, "r_foot")[2]];
  let prevFeet = [limb(p1, "l_foot"), limb(p1, "r_foot")], prev = Float64Array.from(p1.raw.current());
  await run(6, () => {
    n++;
    z.push(world.rootPos(p1.robot)[2]);
    if (glovesUp(p1)) up++;
    const feet = [limb(p1, "l_foot"), limb(p1, "r_foot")];
    feet.forEach((p, k) => { if (p[2] < feet0[k] + 0.02 && prevFeet[k][2] < feet0[k] + 0.02) slide += Math.hypot(p[0] - prevFeet[k][0], p[1] - prevFeet[k][1]); });
    prevFeet = feet;
    const cur = p1.raw.current();
    for (let j = 7; j < 36; j++) jump = Math.max(jump, Math.abs(cur[j] - prev[j]));
    prev = Float64Array.from(cur);
    if (n % 5 === 0) track.push(trackingError(p1));
  });
  const fell = fellNow(0) || !p1.standing();
  let seam = NaN;
  if (c.data) {
    const q = c.data.qpos, a = q[0], b = q[q.length - 1];
    seam = 0;
    for (let j = 7; j < 36; j++) seam = Math.max(seam, Math.abs(b[j] - a[j]));
  }
  const bob = std(z), frac = up / Math.max(1, n), slideCm = (slide / 6) * 100, trackCm = mean(track) * 100, jumpDeg = (jump * 180) / Math.PI;
  const clipAsks = dir.answers.filter((a) => a.source.startsWith("clip")).length;
  const notes: string[] = [];
  if (c.data && !clipAsks) notes.push("the clip was never used");
  const score = 40 * frac + 20 * band(bob, 0, 0.01, 0.03, 0.06) + 15 * (1 - lin(slideCm, 0, 5)) + 15 * (1 - lin(trackCm, 3, 15)) + 10 * (1 - lin(jumpDeg, 0, 10));
  return {
    pass: !fell && frac >= 0.6 && bob <= 0.04, score: fallCap(score, fell), notes,
    metrics: { fell, bobCm: r3(bob * 100), glovesUp: r3(frac), slideCmPerS: r3(slideCm), trackCm: r3(trackCm), refJumpDeg: r3(jumpDeg), seamRad: r3(seam), guardAsks: dir.answers.length, clipAsks },
    line: `bob ${(bob * 100).toFixed(1)} cm, gloves up ${(frac * 100).toFixed(0)}%, slide ${slideCm.toFixed(1)} cm/s, track ${trackCm.toFixed(1)} cm, jump ${jumpDeg.toFixed(1)} deg${c.data ? `, seam ${seam.toFixed(2)} rad` : ""}${fell ? ", FELL" : ""}`,
  };
}

const STEP_ANGLE: Record<string, number> = { "step.forward": 0, "step.back": Math.PI, "step.left": Math.PI / 2, "step.right": -Math.PI / 2 };
async function step(c: Cand): Promise<Result> {
  const trials: { along: number; side: number; heading: number; hands: number; fell: boolean; clipS: number; source: string }[] = [];
  for (let k = 0; k < 2; k++) {
    const dir = new Director(sourceFor(c));
    await setup(1.4, dir, null, 1.5);
    dir.step = STEP_ANGLE[c.motion];
    let ans: Answer | undefined;
    await run(3, () => !!(ans = dir.answers.find((a) => a.name === "step")));
    if (!ans) continue;
    const b0 = bearing(p1), u = [Math.cos(b0 + STEP_ANGLE[c.motion]), Math.sin(b0 + STEP_ANGLE[c.motion])];
    const p0 = world.rootPos(p1.robot), off0 = wrapPi(yawNow(p1) - b0), t0 = arena.time;
    const win = Math.min(2.5, Math.max(1.6, ans.n / 50 + 0.4));
    let up = 0, n = 0;
    await run(win, () => { if (arena.time > t0 + win - 0.2) { n++; if (glovesUp(p1)) up++; } });
    const p = world.rootPos(p1.robot), dx = p[0] - p0[0], dy = p[1] - p0[1];
    trials.push({
      along: dx * u[0] + dy * u[1], side: Math.abs(-dx * u[1] + dy * u[0]),
      heading: (Math.abs(wrapPi(wrapPi(yawNow(p1) - bearing(p1)) - off0)) * 180) / Math.PI,
      hands: up / Math.max(1, n), fell: fellNow(0) || !p1.standing(), clipS: ans.n / 50, source: ans.source,
    });
  }
  if (!trials.length) return { pass: false, score: 0, metrics: {}, notes: ["no step was asked for in 3 s"], line: "no step" };
  const along = mean(trials.map((t) => t.along)), side = mean(trials.map((t) => t.side)), heading = Math.max(...trials.map((t) => t.heading));
  const hands = mean(trials.map((t) => t.hands)), fell = trials.some((t) => t.fell);
  const notes: string[] = [];
  if (c.data && !trials.every((t) => t.source.startsWith("clip"))) notes.push(`the step came from ${trials.map((t) => t.source).join(", ")}`);
  const score = 40 * band(along, 0.05, 0.15, 0.45, 0.7) + 20 * (1 - lin(side, 0, Math.max(0.05, Math.abs(along)))) + 20 * (1 - lin(heading, 0, 30)) + 20 * hands;
  return {
    pass: !fell && Math.min(...trials.map((t) => t.along)) >= 0.12 && heading < 30, score: fallCap(score, fell), notes,
    metrics: { fell, along: r3(along), side: r3(side), headingDeg: r3(heading), glovesUpEnd: r3(hands), trials: trials.map((t) => ({ ...t, along: r3(t.along), side: r3(t.side), heading: r3(t.heading) })) },
    line: `travel ${trials.map((t) => t.along.toFixed(2)).join("/")} m (side ${side.toFixed(2)}), heading ${heading.toFixed(0)} deg, gloves up ${(hands * 100).toFixed(0)}%${fell ? ", FELL" : ""}`,
  };
}

/** s from P2's punch being armed to it landing on a standing P1 (undefended), per punch; measured once. */
const LAND = new Map<PunchName, number>();
async function landTime(punch: PunchName): Promise<number> {
  if (LAND.has(punch)) return LAND.get(punch)!;
  const ts: number[] = [];
  for (let k = 0; k < 2; k++) {
    await setup(TUNE.punchRange[punch], new Director(PLANNER), null, 0.8);
    const armed = await throwAt(punch);
    if (armed < 0) continue;
    await run(2, () => log.some((e) => e.type === "hit" && e.attacker === 1));
    const hit = log.find((e) => e.type === "hit" && e.attacker === 1);
    if (hit) ts.push(hit.t - armed);
  }
  const v = ts.length ? mean(ts) : punch.includes("Hook") ? 0.55 : 0.3;
  LAND.set(punch, v);
  if (!QUIET) console.log(`  (calibrated: P2's ${punch.slice(6)} lands ${v.toFixed(2)} s after it is armed, ${ts.length}/2 landed)`);
  return v;
}
/** P2 throws `punch` at P1 now; resolves to the sim time its strike was armed (-1: never). */
async function throwAt(punch: PunchName): Promise<number> {
  p2.motion = PLANNER;
  if (!p2.throwPunch(punch)) return -1;
  const ok = await run(3, () => arena.combat.pending(p2));
  return ok ? arena.time : -1;
}

const DODGE_PUNCH: Record<string, PunchName> = { "dodge.left": "punch.leftJab", "dodge.right": "punch.leftJab", "dodge.back": "punch.leftJab", duck: "punch.rightHook", block: "punch.leftJab" };
/** P1 defends with `kind` as P2's punch is timed to land 0.3 s later; head travel, hits, guard after. */
async function defendAgainst(c: Cand, kind: Defense, punch: PunchName) {
  const lead = await landTime(punch);
  const dir = new Director(sourceFor(c));
  await setup(TUNE.punchRange[punch], dir, null, 0.8);
  const armed = await throwAt(punch);
  if (armed < 0) return null;
  await run(1, () => arena.time >= armed + lead - 0.3 - 1e-6);
  const h0 = head(p1), b = bearing(p1), f = [Math.cos(b), Math.sin(b)], l = [-f[1], f[0]];
  const ok = p1.defend(kind), tD = arena.time;
  const rows: { t: number; fwd: number; left: number; up: number; face: boolean; gloves: number[]; stance: string }[] = [];
  await run(2.5, () => {
    const h = head(p1), dx = h[0] - h0[0], dy = h[1] - h0[1];
    const g = gloveOffsets(p1);
    rows.push({ t: arena.time - tD, fwd: dx * f[0] + dy * f[1], left: dx * l[0] + dy * l[1], up: h[2] - h0[2], face: gloves2Face(g), gloves: g, stance: p1.stance });
  });
  const hits = log.filter((e): e is Extract<Ev, { type: "hit" }> => e.type === "hit" && e.attacker === 1);
  const whiffs = log.filter((e): e is Extract<Ev, { type: "whiff" }> => e.type === "whiff" && e.attacker === 1);
  const answer = dir.answers.find((a) => a.name === kind);
  const defLen = rows.find((r) => r.stance !== "defend")?.t ?? 2.5;
  return { ok, rows, hits, whiffs, answer, defLen, fell: fellNow(0) || !p1.standing(), back: p1.stance === "idle" && glovesUp(p1) && tilt(p1) < 0.3 };
}

async function dodge(c: Cand): Promise<Result> {
  const kind = c.motion as Defense, punch = DODGE_PUNCH[kind];
  const r = await defendAgainst(c, kind, punch);
  if (!r) return { pass: false, score: 0, metrics: {}, notes: ["P2's punch never armed"], line: "no punch" };
  const way = (x: (typeof r.rows)[0]) => (kind === "dodge.left" ? x.left : kind === "dodge.right" ? -x.left : kind === "dodge.back" ? -x.fwd : -x.up);
  const at = (t: number) => { const row = r.rows.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m), r.rows[0]); return way(row); };
  const m02 = at(0.2), m03 = at(0.3), m045 = at(0.45);
  const missed = r.hits.length === 0;
  const closest = r.whiffs.length ? Math.min(...r.whiffs.map((w) => w.closest)) : missed ? 9 : -1;
  const clear = missed && closest > arena.combat.reach;
  const notes: string[] = [];
  if (!r.ok) notes.push("defend() refused");
  if (c.data && !r.answer?.source.startsWith("clip")) notes.push(`the ${kind} came from ${r.answer?.source ?? "nothing (overlay)"}`);
  const score = 35 * lin(m03, 0, 0.25) + 10 * lin(m02, 0, 0.12) + 25 * (missed ? 1 : 0) + 15 * (clear ? 1 : 0) + 15 * (r.back ? 1 : 0);
  return {
    pass: !r.fell && m03 >= 0.18 && missed, score: fallCap(score, r.fell), notes,
    metrics: { fell: r.fell, at02: r3(m02), at03: r3(m03), at045: r3(m045), missed, closest: r3(closest), clearMiss: clear, defenseS: r3(r.defLen), backInGuard: r.back, punch, source: r.answer?.source ?? "overlay" },
    line: `head ${m02.toFixed(2)}/${m03.toFixed(2)}/${m045.toFixed(2)} m at 0.2/0.3/0.45 s, ${punch.slice(6)} ${missed ? `missed (closest ${closest.toFixed(2)} m)` : `LANDED (${r.hits.map((h) => h.zone).join(",")})`}, defense ${r.defLen.toFixed(2)} s, ${r.back ? "back in guard" : "not back in guard"}${r.fell ? ", FELL" : ""}`,
  };
}

async function block(c: Cand): Promise<Result> {
  const runs = [];
  for (const punch of ["punch.leftJab", "punch.rightHook"] as PunchName[]) {
    const r = await defendAgainst(c, "block", punch);
    if (!r) continue;
    const first = r.rows.find((x) => x.face)?.t ?? Infinity;
    let held = 0, cur = 0;
    for (const x of r.rows) { if (x.t < first) continue; cur = x.face ? cur + 0.02 : 0; held = Math.max(held, cur); }
    const at = (t: number) => r.rows.reduce((m, x) => (Math.abs(x.t - t) < Math.abs(m.t - t) ? x : m), r.rows[0]).gloves.map(r3);
    const clean = r.hits.filter((h) => !h.blocked).length;
    const forearm = r.hits.filter((h) => p1.body.guard.some((v) => { const [a, b] = p1.body.segment(v); return segDist(h.point, a, b) < 0.1; })).length;
    runs.push({ punch, first, held, clean, hits: r.hits.length, forearm, fell: r.fell, source: r.answer?.source ?? "overlay", glovesAt: Object.fromEntries([0, 0.1, 0.2, 0.4, 0.6].map((t) => [t, at(t)])) });
  }
  if (!runs.length) return { pass: false, score: 0, metrics: {}, notes: ["P2's punches never armed"], line: "no punch" };
  const first = Math.max(...runs.map((x) => x.first)), held = Math.min(...runs.map((x) => x.held));
  const fell = runs.some((x) => x.fell), blockedShare = runs.filter((x) => !x.clean).length / runs.length;
  const notes: string[] = [];
  if (c.data && !runs.every((x) => x.source.startsWith("clip"))) notes.push(`the block came from ${runs.map((x) => x.source).join(", ")}`);
  const score = 30 * (1 - lin(first, 0.1, 0.35)) + 30 * lin(held, 0, 0.8) + 40 * blockedShare;
  return {
    pass: !fell && first <= 0.2 && held >= 0.5 && blockedShare === 1, score: fallCap(score, fell), notes,
    metrics: { fell, upS: Number.isFinite(first) ? r3(first) : null, heldS: r3(held), blockedShare, runs },
    line: `gloves up at ${Number.isFinite(first) ? first.toFixed(2) : "never"} s, held ${held.toFixed(2)} s, ${runs.map((x) => `${x.punch.slice(6)} ${x.clean ? "CLEAN" : x.hits ? `blocked${x.forearm ? " (forearm)" : ""}` : "missed"}`).join(", ")}${fell ? ", FELL" : ""}`,
  };
}
function segDist(p: ArrayLike<number>, a: number[], b: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, t = L > 0 ? Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / L)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

async function jump(c: Cand): Promise<Result> {
  const dir = new Director(sourceFor(c));
  await setup(1.4, dir, null, 1.0);
  const f0 = Math.max(limb(p1, "l_foot")[2], limb(p1, "r_foot")[2]);
  const legs = p1.body.hurt.filter((v) => v.zone === "legs");
  const ok = p1.defend("jump"), tD = arena.time;
  let air = 0, cur = 0, peak = 0, shin = -1, evadedInAir = false;
  await run(2.5, () => {
    const lift = Math.min(limb(p1, "l_foot")[2], limb(p1, "r_foot")[2]) - f0;
    peak = Math.max(peak, lift);
    cur = lift >= 0.06 ? cur + 0.02 : 0;
    air = Math.max(air, cur);
    if (lift >= 0.06 && p1.evades("legs")) evadedInAir = true;
    let low = Infinity;
    for (const v of legs) { const [a, b] = p1.body.segment(v); low = Math.min(low, a[2] - v.r, b[2] - v.r); }
    shin = Math.max(shin, low);
  });
  await run(1);
  const fell = fellNow(0) || !p1.standing(), upright = !fell && tilt(p1) < 0.3;
  const answer = dir.answers.find((a) => a.name === "jump");
  const notes: string[] = [];
  if (!ok) notes.push("defend() refused");
  if (c.data && !answer?.source.startsWith("clip")) notes.push(`the jump came from ${answer?.source ?? "nothing (overlay)"}`);
  const sweep = shin >= 0.1;
  const score = 40 * lin(air, 0, 0.25) + 20 * (sweep ? 1 : 0) + 20 * lin(peak, 0, 0.12) + 20 * (upright ? 1 : 0);
  return {
    pass: !fell && air >= 0.12, score: fallCap(score, fell), notes,
    metrics: { fell, airborneS: r3(air), peakLift: r3(peak), lowestShin: r3(shin), sweepClear: sweep, ruleEvadesInAir: evadedInAir, upright, sinceStart: r3(arena.time - tD), source: answer?.source ?? "overlay" },
    line: `airborne ${air.toFixed(2)} s, feet up ${peak.toFixed(2)} m, lowest shin ${shin.toFixed(2)} m (sweep ${sweep ? "clear" : "hits"}), ${upright ? "lands upright" : "NOT upright"}${fell ? ", FELL" : ""}`,
  };
}

async function punch(c: Cand): Promise<Result> {
  const name = c.motion as PunchName, hand = name.includes("left") ? "l_hand" : "r_hand";
  const trials = [];
  for (let k = 0; k < TRIALS; k++) {
    const off = TRIALS === 1 ? 0 : -0.05 + (0.1 * k) / (TRIALS - 1);
    // as in a fight: P2 boxes on the planner, P1 steps in from 1.4 m to its punch range (+off) and throws
    const dir = new Director(sourceFor(c)), range0 = TUNE.punchRange[name];
    await setup(1.4, dir, PLANNER, 0.8);
    TUNE.punchRange[name] = range0 + off;
    if (!p1.throwPunch(name)) { TUNE.punchRange[name] = range0; trials.push({ off, landed: false, refused: true }); continue; }
    let peak = 0;
    await run(6, () => {
      if (dir.answers.some((a) => a.name === name)) peak = Math.max(peak, p1.body.limbPeak(hand));
      return p1.stance !== "move";
    });
    const ans = dir.answers.find((a) => a.name === name);
    const hit = log.find((e): e is Extract<Ev, { type: "hit" }> => e.type === "hit" && e.attacker === 0);
    const key = ans?.strikes?.[0]?.key ?? NaN;
    await run(1);
    TUNE.punchRange[name] = range0;
    trials.push({ off: r3(off), landed: !!hit, zone: hit?.zone, damage: hit ? r3(hit.damage) : 0, peak: r3(peak), late: hit && ans ? r3(hit.t - ans.t0 - key) : null, back: p1.stance === "idle" && glovesUp(p1), fell: fellNow(0) || !p1.standing(), source: ans?.source ?? "none" });
  }
  const real = trials.filter((t) => !("refused" in t));
  const rate = real.filter((t) => t.landed).length / Math.max(1, TRIALS);
  const peak = mean(real.map((t) => ("peak" in t ? t.peak ?? 0 : 0)));
  const lates = real.map((t) => ("late" in t ? t.late : null)).filter((x): x is number => x !== null && Number.isFinite(x));
  const late = lates.length ? mean(lates.map(Math.abs)) : NaN;
  const back = real.filter((t) => "back" in t && t.back).length / Math.max(1, TRIALS);
  const fell = real.some((t) => "fell" in t && t.fell);
  const notes: string[] = [];
  if (c.data && !real.every((t) => "source" in t && String(t.source).startsWith("clip"))) notes.push("not every punch came from the clip");
  if (real.length < TRIALS) notes.push(`${TRIALS - real.length} throwPunch refused`);
  const fist = c.data ? clipFist(c.data, hand) : null;
  if (fist && fist.travel < 0.15) notes.push(`the clip's fist travels only ${fist.travel.toFixed(2)} m forward (starts ${fist.start.toFixed(2)} m out): any landing comes from the splice`);
  const thrown = fist ? lin(fist.travel, 0.05, 0.25) : 1;
  const score = (50 * rate + 20 * lin(peak, 0, 4) + 15 * (Number.isFinite(late) ? 1 - lin(late, 0, 0.3) : 0) + 15 * back) * (0.5 + 0.5 * thrown);
  return {
    pass: !fell && rate >= 0.5 && (!fist || fist.travel >= 0.15), score: fallCap(score, fell), notes,
    metrics: { fell, landRate: r3(rate), landed: `${real.filter((t) => t.landed).length}/${TRIALS}`, fistPeak: r3(peak), offKeyS: Number.isFinite(late) ? r3(late) : null, backInGuard: r3(back), clipFist: fist && { start: r3(fist.start), reach: r3(fist.reach), travel: r3(fist.travel), peakS: r3(fist.peakS) }, trials },
    line: `lands ${real.filter((t) => t.landed).length}/${TRIALS}, fist peak ${peak.toFixed(1)} m/s, ${Number.isFinite(late) ? `${late.toFixed(2)} s off the key` : "no impact"}, back in guard ${(back * 100).toFixed(0)}%${fist ? `, clip fist ${fist.start.toFixed(2)}->${fist.reach.toFixed(2)} m` : ""}${fell ? ", FELL" : ""}`,
  };
}

const lies = (q: ArrayLike<number>) => { const g = qrot(qconj(q), [0, 0, -1]); return g[0] < -0.6 ? "face up" : g[0] > 0.6 ? "face down" : Math.abs(g[1]) > 0.6 ? "side" : "upright-ish"; };
async function getup(c: Cand): Promise<Result> {
  const shove = ATTACKS.find((a) => a.name === "Shove")!;
  const per = Math.max(1, Math.ceil(TRIALS / 4));
  type Trial = { from: string; knockedDown: boolean; down: false } | { from: string; lay: string; down: true; up: boolean; assisted: boolean; seconds: number; help: number; refall: boolean; used: number; usedNames: string };
  const trials: Trial[] = [];
  for (const from of ["front", "behind"] as const) for (let k = 0; k < per; k++) {
    const dir = new Director(sourceFor(c));
    await setup(2.6, dir, null, 1.0);
    const me = world.rootPos(p1.robot);
    const res = from === "front" ? arena.hitInstant(0, shove, 1.3) : p1.hitInstant(shove, [me[0] - 1, me[1]], 1.3);
    let lay = "";
    const down = await run(6, () => { if (log.some((e) => e.type === "down" && e.who === 0)) { lay = lies(world.rootQuat(p1.robot)); return true; } });
    if (!down) { trials.push({ from, knockedDown: res.result.knockdown, down: false }); continue; }
    let help = 0;
    const t0 = arena.time;
    await run(25, () => { if (p1.stance === "rising") help = Math.max(help, p1.debug().rise.cap); return p1.stance === "idle" || p1.stance === "ko"; });
    const gu = log.find((e): e is Extract<Ev, { type: "getup" }> => e.type === "getup" && e.who === 0);
    const tUp = arena.time;
    await run(2);
    const used = dir.answers.filter((a) => a.source.startsWith("clip:getup")).map((a) => a.name);
    trials.push({ from, lay, down: true, up: !!gu && !gu.assisted, assisted: !!gu?.assisted, seconds: gu ? r3(gu.seconds) : r3(arena.time - t0), help: r3(help), refall: fellNow(0, tUp + 0.01), used: used.length, usedNames: [...new Set(used)].join(",") });
  }
  const real = trials.filter((t): t is Extract<Trial, { down: true }> => t.down);
  const judged = c.data ? real.filter((t) => t.used > 0) : real;
  const notes: string[] = [];
  if (real.length < trials.length) notes.push(`${trials.length - real.length} knockdown(s) never settled`);
  const start = c.data ? lies(c.data.qpos[0].slice(3, 7)) : "";
  if (c.data && !judged.length) notes.push(`the clip was never used (it starts ${start}; landed ${real.map((t) => t.lay).join(", ")})`);
  const ok = judged.filter((t) => t.up), refall = judged.some((t) => t.refall);
  const secs = ok.length ? mean(ok.map((t) => t.seconds)) : NaN, help = judged.length ? Math.max(...judged.map((t) => t.help)) : 1;
  const share = judged.length ? ok.length / judged.length : 0;
  const score = 50 * share + 25 * (Number.isFinite(secs) ? 1 - lin(secs, 3, 12) : 0) + 15 * (1 - lin(help, 0, 0.95)) + 10 * (refall ? 0 : 1);
  return {
    pass: judged.length > 0 && share === 1 && !refall, score: judged.length ? score : 0, notes,
    metrics: { startsLying: start || null, upShare: r3(share), seconds: Number.isFinite(secs) ? r3(secs) : null, mostHelp: r3(help), refall, trials },
    line: `${real.map((t) => `${t.from}->${t.lay}: ${t.up ? `up ${t.seconds.toFixed(1)} s` : t.assisted ? "LIFTED" : "NOT up"} help ${t.help.toFixed(2)}${t.used ? ` clip x${t.used}` : " (planner)"}${t.refall ? " RE-FELL" : ""}`).join("; ")}`,
  };
}

// ---------- run ----------
const SCENARIOS: Record<Scenario, (c: Cand) => Promise<Result>> = { guard, step, dodge, block, jump, punch, getup };
const report: { file: string; motion: string; job: string; sample: string; pass: boolean; score: number; metrics: Record<string, unknown>; notes: string[]; seconds: number }[] = [];
const T0 = performance.now();
console.log(`scoring ${todo.length} candidate(s)${shardN > 1 ? ` (shard ${shardI}/${shardN})` : ""}, trials ${TRIALS}`);
for (const c of todo) {
  const t = performance.now();
  let r: Result;
  try { r = await SCENARIOS[scenarioOf(c.motion)!](c); } catch (e) { r = { pass: false, score: 0, metrics: {}, notes: [`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`], line: "error" }; }
  const errs = p1.stats.errors + p2.stats.errors + arena.stats.errors;
  if (errs) r.notes.push(`sim errors so far: ${errs} (${p1.lastEvent || arena.lastError})`);
  const seconds = (performance.now() - t) / 1000;
  report.push({ file: c.file, motion: c.motion, job: c.job, sample: c.sample, pass: r.pass, score: Math.round(r.score * 10) / 10, metrics: r.metrics, notes: r.notes, seconds: Math.round(seconds * 10) / 10 });
  console.log(`${r.pass ? "pass" : "FAIL"} ${r.score.toFixed(0).padStart(3)}  ${c.motion.padEnd(16)} ${`${c.job}/${c.sample}`.padEnd(28)} ${r.line}${r.notes.length ? `  <- ${r.notes.join("; ")}` : ""}  [${seconds.toFixed(0)} s]`);
}
// best per motion
const byMotion = new Map<string, typeof report>();
for (const r of report) byMotion.set(r.motion, [...(byMotion.get(r.motion) ?? []), r]);
if (report.length > 1) {
  console.log("\nbest per motion:");
  for (const [m, rs] of [...byMotion].sort()) {
    const best = [...rs].sort((a, b) => Number(b.pass) - Number(a.pass) || b.score - a.score)[0];
    const base = rs.find((r) => r.job === "baseline");
    console.log(`  ${m.padEnd(16)} ${best.pass ? "pass" : "FAIL"} ${best.score.toFixed(0).padStart(3)} ${best.job}/${best.sample}${base && base !== best ? `  (planner ${base.score.toFixed(0)}${base.pass ? " pass" : " FAIL"})` : ""}  of ${rs.length}`);
  }
}
const perMotion = [...byMotion].map(([m, rs]) => `${m} ${(rs.reduce((s, r) => s + r.seconds, 0) / rs.length).toFixed(1)}`).join(", ");
console.log(`\n${report.length} scored in ${((performance.now() - T0) / 1000).toFixed(0)} s wall (s per candidate: ${perMotion})`);
if (skipped.length && !QUIET) console.log(`skipped:\n  ${skipped.join("\n  ")}`);
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log(`wrote ${OUT}`); }
process.exit(0);
