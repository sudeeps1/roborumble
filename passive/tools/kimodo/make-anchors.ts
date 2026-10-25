// Anchor poses for Kimodo everyday-motion generation, taken from the game's own physics, and a
// checker for the generation job list (everyday.json, read by kgen.py).
//   node tools/kimodo/make-anchors.ts [--out tools/kimodo/anchors.json] [--trials 12]   GPU box only: runs physics
//   node tools/kimodo/make-anchors.ts --check [tools/kimodo/everyday.json]               JSON only, no physics
// Every anchor is a 36-value MuJoCo qpos re-based to pelvis xy (0, 0) and hip heading 0 (Kimodo's
// heading: right hip -> left hip is +Y, so the pelvis faces +X), z kept.
//   guard (+ .low/.high)  the planner's idleBoxing as the fighter follows it (fighter.raw: before
//                         waistToHips and before the guard-tuck overlay), a mid-bounce frame, feet planted
//   guard.up              guard.high with its waist pitch moved into the pelvis (the planner's guard tips
//                         the pelvis back): the same upper body on an upright pelvis, so a get-up that
//                         ends on it clears the fighter's standing test (z > 0.66, tilt < 0.3 rad)
//   lying.back/.front     real knockdown poses at the moment the stance becomes "down"
//   kneel                 the body when the fighter asks for getup.stand (physics, after the planner's
//                         getup.knees): what a getup.stand clip really starts from
//   punch.*.hit           the planner punch's frame of furthest reach, for mid-clip keyframes
//   block, duck           synthetic: guard + the fighter's own block/duck overlay offsets, re-floored
//   dodge.left/.right/.back  synthetic: guard leaning like the fighter's dodge overlay (and further, so
//                         the head is ~0.25 m out of the way), feet kept where the guard has them;
//                         info.offset is where its pelvis sits from the guard's: key it with that offset
// --rec FILE caches the physics recordings (a cache without kneels gets them added).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NJ } from "../../src/core/g1.ts";
import { axisAngleQuat, qmul, qrot, tiltOf, wrapPi, yawQuat } from "../../src/core/math.ts";

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const r3 = (v: number) => Math.round(v * 1e3) / 1e3;

/** Kimodo's heading of a root quaternion: from the hip axis (body +Y = left), so it's defined lying down too. */
function hipHeading(q: ArrayLike<number>) { const l = qrot(q, [0, 1, 0]); return Math.atan2(-l[0], l[1]); }

/** qpos moved to xy (0, 0) and turned to hip heading 0; also returns where it was. */
function rebase(qp: ArrayLike<number>) {
  const out = Array.from(qp).slice(0, 36), th = hipHeading([qp[3], qp[4], qp[5], qp[6]]);
  const q = qmul(yawQuat(-th), [qp[3], qp[4], qp[5], qp[6]]);
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  out[0] = 0; out[1] = 0; out[3] = q[0] / n; out[4] = q[1] / n; out[5] = q[2] / n; out[6] = q[3] / n;
  return { qpos: out, x: qp[0], y: qp[1], th };
}

/** Where pose b's pelvis is in pose a's re-based frame: [dx, dy, dyaw]. */
function relOffset(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] {
  const ta = hipHeading([a[3], a[4], a[5], a[6]]), tb = hipHeading([b[3], b[4], b[5], b[6]]);
  const dx = b[0] - a[0], dy = b[1] - a[1], c = Math.cos(ta), s = Math.sin(ta);
  return [c * dx + s * dy, -s * dx + c * dy, wrapPi(tb - ta)];
}

// ================= --check: the job list =================

/** Every motion the fighter asks a source for (ClipSource splits "step" by direction), plus character guards. */
const REQUIRED = ["guard", "step.forward", "step.back", "step.left", "step.right", "getup.knees", "getup.stand",
  "punch.leftJab", "punch.rightJab", "punch.leftHook", "punch.rightHook", "dodge.left", "dodge.right", "dodge.back", "block", "duck", "jump"];
const KNOWN = new Set([...REQUIRED, "guard.elf", "guard.knight"]);

function check(path: string): number {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  const anchorsPath = resolve(dirname(path), spec.anchors ?? "anchors.json");
  const anchors: Record<string, { qpos: number[]; info?: { offset?: number[] } }> = existsSync(anchorsPath) ? JSON.parse(readFileSync(anchorsPath, "utf8")) : {};
  const errors: string[] = [], warns: string[] = [];
  const err = (id: string, m: string) => errors.push(`${id}: ${m}`), warn = (id: string, m: string) => warns.push(`${id}: ${m}`);
  if (!existsSync(anchorsPath)) errors.push(`anchors file missing: ${anchorsPath}`);
  for (const [k, a] of Object.entries(anchors)) if (!Array.isArray(a?.qpos) || a.qpos.length !== 36 || !a.qpos.every(Number.isFinite)) err(`anchor ${k}`, "qpos is not 36 finite numbers");
  const D = spec.defaults ?? {};
  const ids = new Set<string>(), seeds = new Map<number, string>(), perMotion = new Map<string, number>();
  let samples = 0, frames = 0;
  for (const j of spec.jobs ?? []) {
    const id = String(j.id ?? "?");
    if (ids.has(id)) err(id, "duplicate id"); ids.add(id);
    if (!KNOWN.has(j.motion)) warn(id, `motion ${j.motion} isn't one the fighter asks for`);
    perMotion.set(j.motion, (perMotion.get(j.motion) ?? 0) + 1);
    const p = String(j.prompt ?? ""), words = p.trim().split(/\s+/).filter(Boolean);
    if (p.includes(".")) err(id, "prompt has a '.' (Kimodo splits on it)");
    if (words.length < 7 || words.length > 19) err(id, `prompt has ${words.length} words (7-19)`);
    if (!/^A person /.test(p)) err(id, "prompt must start with 'A person'");
    if ((p.match(/\b(then|while)\b/g) ?? []).length > 1) warn(id, "more than two behaviours (then/while used twice)");
    const dur = Number(j.duration);
    if (!(dur >= 0.6 && dur <= 5)) err(id, `duration ${j.duration} not in 0.6-5 s`);
    const nf = Math.floor(dur * 30 + 1e-9);
    if (Math.abs(dur * 30 - Math.round(dur * 30)) > 1e-6 || Math.floor(dur * 30) !== nf) warn(id, `duration*30 = ${dur * 30} isn't a whole frame count (Kimodo truncates)`);
    const n = j.samples ?? D.samples, seed = j.seed ?? D.seed, cfg = j.cfg ?? D.cfg;
    if (!(Number.isInteger(n) && n >= 1 && n <= 32)) err(id, `samples ${n}`);
    if (!Number.isInteger(seed)) err(id, `seed ${seed}`);
    else { for (let s = seed; s < seed + (n || 1); s++) { if (seeds.has(s)) { err(id, `seed ${s} also used by ${seeds.get(s)}`); break; } seeds.set(s, id); } }
    if (!Array.isArray(cfg) || cfg.length !== 2 || !cfg.every((v: unknown) => typeof v === "number" && v >= 0 && v <= 10)) err(id, `cfg ${JSON.stringify(cfg)}`);
    const kfs = j.keyframes ?? [];
    if (!Array.isArray(kfs)) err(id, "keyframes not a list");
    const kfFrames = new Set<number>();
    // kgen's frame of t: "end" is the last frame, seconds round to the nearest 30 fps frame
    const frameOf = (t: unknown) => (t === "end" ? nf - 1 : Math.round(Number(t) * 30));
    const inClip = (t: unknown) => { const f = frameOf(t); return Number.isFinite(f) && f >= 0 && f <= nf - 1; };
    for (const k of Array.isArray(kfs) ? kfs : []) {
      if (!inClip(k.t)) err(id, `keyframe t ${k.t} is frame ${frameOf(k.t)}, outside the clip's 0..${nf - 1} (use "end")`);
      if (!anchors[k.anchor]) err(id, `no anchor ${k.anchor}`);
      if (k.offset !== undefined && !(Array.isArray(k.offset) && k.offset.length === 3 && k.offset.every(Number.isFinite) && Math.hypot(k.offset[0], k.offset[1]) < 1.5 && Math.abs(k.offset[2]) <= Math.PI)) err(id, `bad offset ${JSON.stringify(k.offset)}`);
      const f = frameOf(k.t);
      if (kfFrames.has(f)) err(id, `two keyframes on frame ${f}`); kfFrames.add(f);
      // a dodge anchor's pelvis sits off its feet: keyed without its info.offset, the feet would jump
      const ao = anchors[k.anchor]?.info?.offset, ko = k.offset ?? [0, 0, 0];
      if (String(k.anchor).startsWith("dodge.") && ao && Math.hypot(ko[0] - ao[0], ko[1] - ao[1]) > 0.03) warn(id, `${k.anchor} keyed at offset ${JSON.stringify(ko)}, its footprint wants ${JSON.stringify(ao)}`);
    }
    if (kfs.length && frameOf(kfs[0].t) !== 0) warn(id, "first keyframe isn't at t=0");
    if (kfs.length > 20) err(id, "over 20 keyframes");
    const rootFrames = new Set<number>();
    for (const w of j.root ?? []) {
      if (!Array.isArray(w) || w.length !== 3 || !inClip(w[0]) || !Number.isFinite(w[1]) || !Number.isFinite(w[2])) { err(id, `bad root waypoint ${JSON.stringify(w)}`); continue; }
      if (rootFrames.has(frameOf(w[0]))) err(id, `two root waypoints on frame ${frameOf(w[0])}`); rootFrames.add(frameOf(w[0]));
    }
    // a root waypoint and a keyframe on the same frame must agree on where the pelvis is
    for (const w of j.root ?? []) for (const k of kfs) if (frameOf(w[0]) === frameOf(k.t)) {
      const o = k.offset ?? [0, 0, 0];
      if (Math.hypot(o[0] - w[1], o[1] - w[2]) > 0.02) err(id, `root waypoint ${JSON.stringify(w)} disagrees with the ${k.anchor} keyframe offset`);
    }
    if (j.meta?.loop) {
      const a = kfs[0], b = kfs[kfs.length - 1];
      if (!a || !b || a.anchor !== b.anchor || b.t !== "end" || (b.offset ?? [0, 0, 0]).some((v: number) => Math.abs(v) > 1e-9)) err(id, "loop must start and end on the same anchor with no offset");
    }
    if (j.motion.startsWith("punch.") && !["l_hand", "r_hand"].includes(j.meta?.hit_limb)) err(id, "punch without meta.hit_limb");
    // ClipSource builds the strike from hit_limb + hit_frame (30 fps frames); without it the clip gets the planner's window
    if (j.motion.startsWith("punch.") && !(Number.isInteger(j.meta?.hit_frame) && j.meta.hit_frame > 0 && j.meta.hit_frame < nf)) err(id, `punch meta.hit_frame ${j.meta?.hit_frame} must be a frame inside the clip`);
    // a get-up that ends keyed on a pose must end clear of the fighter's standing test (z > 0.66, tilt < 0.3 rad), or it reads as half up
    const last = kfs[kfs.length - 1];
    if (j.motion.startsWith("getup") && last?.t === "end" && anchors[last.anchor]) {
      const q = anchors[last.anchor].qpos, tl = tiltOf([q[3], q[4], q[5], q[6]]);
      if (!(q[2] > 0.68 && tl < 0.25)) err(id, `ends on ${last.anchor} (pelvis z ${q[2].toFixed(3)}, tilt ${(tl * 57.3).toFixed(1)} deg): too close to the standing test (z > 0.66, tilt < 17 deg)`);
    }
    if (["block", "duck", "jump"].includes(j.motion) || j.motion.startsWith("dodge.")) {
      if (!(j.meta?.active > 0 && j.meta.active <= dur)) err(id, `meta.active ${j.meta?.active} must be in (0, duration]`);
    }
    samples += n || 0; frames += (n || 0) * nf;
  }
  for (const m of REQUIRED) if (!perMotion.get(m)) err(m, "no job for this motion");
  for (const w of warns) console.log(`  warn  ${w}`);
  for (const e of errors) console.log(`  FAIL  ${e}`);
  const counts = [...perMotion].map(([m, c]) => `${m} ${c}`).join(", ");
  console.log(`${ids.size} jobs, ${samples} samples, ${(frames / 30).toFixed(0)} s of motion; anchors: ${Object.keys(anchors).length}\n  ${counts}`);
  console.log(errors.length ? `FAILED: ${errors.length} errors` : "OK");
  return errors.length ? 1 : 0;
}

if (args.includes("--check")) {
  const p = args.find((a) => a.endsWith(".json")) ?? join(HERE, "everyday.json");
  process.exit(check(p));
}

// ================= anchors (physics: run on the GPU box) =================

const OUT = opt("--out", join(HERE, "anchors.json"));
const TRIALS = Math.max(2, Number(opt("--trials", "12")));
const { nodeArena } = await import("../../scripts/node-arena.ts");
const { PlannerSource } = await import("../../src/core/motion.ts");
const { BodyMap } = await import("../../src/core/body.ts");
const { ATTACKS } = await import("../../src/core/attacks.ts");
const { mixFrames, copyFrame } = await import("../../src/core/reference.ts");
type MotionSource = import("../../src/core/motion.ts").MotionSource;
type ArenaEvent = import("../../src/core/events.ts").ArenaEvent;

const { world, planner, arena } = await nodeArena({ autoKO: false });
if (!planner) { console.log("no planner model: run npm run setup:planner first"); process.exit(1); }
const plannerSrc = new PlannerSource(planner);
const [p1, p2] = arena.fighters;
const run = async (seconds: number, until?: () => boolean) => {
  for (let i = 0; i < seconds * 50; i++) { await arena.tick(); if (until?.()) return true; }
  return false;
};
const t0 = performance.now();

// --- the physics part (--rec FILE: reuse/save its recordings, to iterate on the rest without the sim)
interface GFrame { raw: number[]; opp: number }
interface Down { how: string; down: number[]; up: number[] | null; upT: number; downT: number; face: number }
const REC = opt("--rec", "");
let rec: GFrame[][] = [[], []], downs: Down[] = [], kneels: number[][] | null = null;
/**
 * Knocks P2 down TRIALS times, hard from the front (lands on its back) and from behind (face down),
 * and lets the planner get it up. Records the pose when the stance becomes "down", when it's up,
 * and when the fighter asks for getup.stand (the body up on its knees, physics).
 */
async function knockdowns() {
  const out: Down[] = [], kn: number[][] = [];
  arena.setMotion({ get: (a) => { if (a.name === "getup.stand") kn.push(Array.from(world.robotQpos(p2.robot))); return plannerSrc.get(a); } });
  const atk = (n: string) => ATTACKS.find((a) => a.name === n)!;
  const FRONT: [string, number][] = [["Shove", 1], ["Haymaker", 1], ["Jab", 3.5], ["Uppercut", 1.2], ["Body shot", 2], ["Hook", 1.8]];
  for (let t = 0; t < TRIALS; t++) {
    const behind = t % 2 === 1, [name, scale] = FRONT[Math.floor(t / 2) % FRONT.length];
    arena.reset();
    await run(1.2 + (t % 5) * 0.13);
    let down: number[] | null = null, up: number[] | null = null, downT = 0, upT = 0;
    const off = arena.on((e: ArenaEvent) => {
      if (e.type === "down" && e.who === 1 && !down) { down = Array.from(world.robotQpos(p2.robot)); downT = arena.time; }
      if (e.type === "getup" && e.who === 1 && down && !up) { up = Array.from(world.robotQpos(p2.robot)); upT = arena.time; }
    });
    if (!behind) arena.hitInstant(1, atk(name), scale);
    else {
      // the push comes from a point behind P2 (no fighter there): it drives P2 forward, onto its face
      const a = atk(name), me = world.rootPos(p2.robot), o = world.rootPos(p1.robot);
      const d = Math.hypot(o[0] - me[0], o[1] - me[1]) || 1;
      p2.hitInstant({ ...a, offset: [-a.offset[0], a.offset[1], a.offset[2]] }, [me[0] - (o[0] - me[0]) / d, me[1] - (o[1] - me[1]) / d], scale);
    }
    const fell = p2.stance === "falling";
    await run(5, () => !!down);
    await run(16, () => !!up);
    off();
    const how = `${name} x${scale} from ${behind ? "behind" : "the front"}`;
    if (!down) { console.log(`  trial ${t}: ${how}: ${fell ? "fell but never settled" : "no knockdown"} (stance ${p2.stance})`); continue; }
    const dq = down as number[];
    const fwd = qrot([dq[3], dq[4], dq[5], dq[6]], [1, 0, 0]);
    out.push({ how, down: dq, up, upT: up ? upT - downT : -1, downT, face: fwd[2] });
    console.log(`  trial ${t}: ${how}: down, chest ${fwd[2] > 0.5 ? "up" : fwd[2] < -0.5 ? "down" : "sideways"} (${fwd[2].toFixed(2)}), pelvis z ${dq[2].toFixed(2)}; ${up ? `up after ${(upT - downT).toFixed(1)} s` : "not up in 16 s"}; ${kn.length} kneels so far`);
  }
  return { downs: out, kneels: kn };
}
if (REC && existsSync(REC)) {
  ({ rec, downs, kneels = null } = JSON.parse(readFileSync(REC, "utf8")));
  if (!kneels) { // an older cache: the knockdowns again for the kneels only (the lying poses stay the cached ones)
    console.log("cache has no kneels: knockdown trials for them");
    kneels = (await knockdowns()).kneels;
    writeFileSync(REC, JSON.stringify({ rec, downs, kneels }));
  }
} else {
  // --- 1. guard: both fighters box in place (footwork steps answered with the guard), raw recorded
  const guardOnly: MotionSource = { get: (a) => plannerSrc.get({ ...a, name: a.name === "step" ? "guard" : a.name, move: undefined }) };
  arena.setMotion(guardOnly);
  arena.reset();
  await run(2.5);
  for (let k = 0; k < 8 * 50; k++) {
    await arena.tick();
    for (const f of [p1, p2]) {
      const me = world.rootPos(f.robot), o = world.rootPos(f.opponent.robot);
      rec[f.index].push({ raw: Array.from(f.raw.current()), opp: Math.atan2(o[1] - me[1], o[0] - me[0]) });
    }
  }
  const guardStats = [p1, p2].map((f) => ({ stance: f.stance, stats: { ...f.stats } }));
  console.log(`guard: recorded ${rec[0].length} frames x 2 (${guardStats.map((g) => `${g.stance} applied=${g.stats.applied}`).join(", ")})`);

  // --- 2. knockdowns: hit P2 hard from the front (lands on its back) and from behind (face down)
  ({ downs, kneels } = await knockdowns());
  if (REC) writeFileSync(REC, JSON.stringify({ rec, downs, kneels }));
}
const simWall = (performance.now() - t0) / 1000;

// ================= FK on robot 0 (the sim is over) =================

const R = world.robots[0], body = new BodyMap(world, R), m = world.model;
const B = (n: string) => R.bodies.get(n)!;
const own = new Set(R.bodyIds);
const footGeoms: Record<"l" | "r", number[]> = { l: [], r: [] };
for (let g = 0; g < m.ngeom; g++) {
  if (m.geom_type[g] !== 2 || !own.has(m.geom_bodyid[g])) continue;
  if (m.geom_bodyid[g] === B("left_ankle_roll_link")) footGeoms.l.push(g);
  if (m.geom_bodyid[g] === B("right_ankle_roll_link")) footGeoms.r.push(g);
}
function fk(q: ArrayLike<number>) {
  world.setRobotQpos(R, q); world.forward();
  const gx = world.data.geom_xpos;
  const foot = (s: "l" | "r") => footGeoms[s].map((g) => gx[g * 3 + 2] - m.geom_size[g * 3]);
  const fl = foot("l"), fr = foot("r");
  let minBody = Infinity;
  for (const b of R.bodyIds) minBody = Math.min(minBody, world.data.xpos[b * 3 + 2]);
  const torso = B("torso_link");
  return {
    footL: [Math.min(...fl), Math.max(...fl)], footR: [Math.min(...fr), Math.max(...fr)], footMin: Math.min(...fl, ...fr),
    head: world.pointOn(torso, body.strikers.head.local),
    handL: world.pointOn(B("left_wrist_yaw_link"), body.strikers.l_hand.local), handR: world.pointOn(B("right_wrist_yaw_link"), body.strikers.r_hand.local),
    kneeL: world.bodyPos(B("left_knee_link"))[2], kneeR: world.bodyPos(B("right_knee_link"))[2], minBody,
  };
}
/** Deepest penetration of robot 0's collision geoms into the floor (m, <= 0; 0 = clear), from MuJoCo's own contacts. */
function floorGap(q: ArrayLike<number>) {
  world.setRobotQpos(R, q); world.forward();
  const d = world.data;
  let min = 0;
  for (let i = 0; i < d.ncon; i++) {
    const c = d.contact.get(i);
    if (!c) continue;
    const b1 = m.geom_bodyid[c.geom1], b2 = m.geom_bodyid[c.geom2], dist = c.dist;
    c.delete?.();
    if ((own.has(b1) && b2 === 0) || (own.has(b2) && b1 === 0)) min = Math.min(min, dist);
  }
  return min;
}

// ================= pick the guard =================

const all = rec.flatMap((r, who) => r.map((g, i) => ({ who, i, g, rb: rebase(g.raw) })));
const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const jointMed = Array.from({ length: NJ }, (_, j) => med(all.map((a) => a.rb.qpos[7 + j])));
const zMed = med(all.map((a) => a.rb.qpos[2]));
const zs = all.map((a) => a.rb.qpos[2]);
const facing = all.map((a) => wrapPi(a.g.opp - a.rb.th));
const facingMean = Math.atan2(facing.reduce((s, v) => s + Math.sin(v), 0), facing.reduce((s, v) => s + Math.cos(v), 0));
const chestOff = all.map((a) => wrapPi(a.g.opp - a.rb.th - a.rb.qpos[7 + 12]));
const scored = all.map((a) => {
  const f = fk(a.rb.qpos);
  const planted = f.footL[0] < 0.015 && f.footR[0] < 0.015 && f.footL[1] - f.footL[0] < 0.03 && f.footR[1] - f.footR[0] < 0.03;
  let jd = 0;
  for (let j = 0; j < NJ; j++) jd += (a.rb.qpos[7 + j] - jointMed[j]) ** 2;
  return { ...a, f, planted, score: Math.abs(a.rb.qpos[2] - zMed) / 0.005 + Math.sqrt(jd) / 0.05 };
});
const planted = scored.filter((s) => s.planted);
console.log(`guard: ${planted.length}/${scored.length} frames with both feet planted; pelvis z ${Math.min(...zs).toFixed(3)}-${Math.max(...zs).toFixed(3)} (median ${zMed.toFixed(3)}); opponent at ${(facingMean * 57.3).toFixed(0)} deg from the pelvis heading (chest ${(med(chestOff) * 57.3).toFixed(0)} deg)`);
const pool = planted.length ? planted : scored;
const best = pool.reduce((a, b) => (b.score < a.score ? b : a));
const low = pool.reduce((a, b) => (b.rb.qpos[2] < a.rb.qpos[2] ? b : a));
const high = pool.reduce((a, b) => (b.rb.qpos[2] > a.rb.qpos[2] ? b : a));

interface Anchor { qpos: number[]; note: string; info?: Record<string, unknown> }
const anchors: Record<string, Anchor> = {};
const facingInfo = { facing: r3(facingMean), facingNote: "rad, direction to the opponent in this frame (CCW from +X): the planner holds the pelvis this far off the opponent line" };
anchors.guard = { qpos: best.rb.qpos, note: `planner idleBoxing guard (fighter.raw, no guard tuck), P${best.who + 1} frame ${best.i}, mid-bounce (z ${best.rb.qpos[2].toFixed(3)}, median ${zMed.toFixed(3)}), both feet planted`, info: { ...facingInfo } };
anchors["guard.low"] = { qpos: low.rb.qpos, note: `guard bounce low (z ${low.rb.qpos[2].toFixed(3)}), P${low.who + 1} frame ${low.i}`, info: { ...facingInfo } };
anchors["guard.high"] = { qpos: high.rb.qpos, note: `guard bounce high (z ${high.rb.qpos[2].toFixed(3)}), P${high.who + 1} frame ${high.i}`, info: { ...facingInfo } };
const G = anchors.guard.qpos, gf = fk(G);

// ================= lying poses =================

function pickSet(list: Down[], tag: string, max = 3) {
  if (!list.length) return;
  const jd = (a: number[], b: number[]) => { let s = 0; for (let j = 7; j < 36; j++) s += (a[j] - b[j]) ** 2; return Math.sqrt(s); };
  const rb = list.map((d) => ({ d, q: rebase(d.down).qpos }));
  // medoid first, then the ones far from everything picked (a different way of landing)
  const order = rb.map((a) => ({ a, s: rb.reduce((t, b) => t + jd(a.q, b.q), 0) })).sort((x, y) => x.s - y.s).map((x) => x.a);
  const chosen = [order[0]];
  for (const c of order.slice(1)) if (chosen.length < max && chosen.every((p) => jd(p.q, c.q) > 1.2)) chosen.push(c);
  chosen.forEach((c, k) => {
    const key = k ? `${tag}.${k + 1}` : tag;
    const info: Record<string, unknown> = { from: c.d.how, chestUp: r3(c.d.face), spread: r3(Math.max(...rb.map((b) => jd(b.q, c.q)))) };
    if (c.d.up) { const o = relOffset(c.d.down, c.d.up); info.plannerGetup = { seconds: r3(c.d.upT), offset: o.map(r3), note: "where the planner's staged get-up ended (standing pelvis) in this pose's frame" }; }
    anchors[key] = { qpos: c.q, note: `knockdown (${c.d.how}), pose when the stance became down; ${rb.length} ${tag} samples, joint spread up to ${info.spread} rad`, info };
  });
}
pickSet(downs.filter((d) => d.face > 0.5), "lying.back");
pickSet(downs.filter((d) => d.face < -0.5), "lying.front");
const side = downs.filter((d) => Math.abs(d.face) <= 0.5);
if (side.length) console.log(`  ${side.length} knockdowns landed on a side (not used): ${side.map((s) => s.how).join("; ")}`);

// ================= kneel: the body when the fighter asks for getup.stand =================
// (physics: what a getup.stand clip starts from in the game); the medoid of the clean ones

const kneelOk = (q: ArrayLike<number>) => { const f = fk(q), t = tiltOf([q[3], q[4], q[5], q[6]]); return { f, t, ok: t < 0.45 && f.kneeL < 0.15 && f.kneeR < 0.15 && q[2] > 0.25 && q[2] < 0.55 }; };
const kn = (kneels ?? []).map((q) => ({ q: rebase(q).qpos, ...kneelOk(q) }));
const cleanK = kn.filter((k) => k.ok);
console.log(`kneel: ${kn.length} getup.stand asks recorded, ${cleanK.length} clean kneels (pelvis z ${kn.map((k) => k.q[2].toFixed(2)).join(" ")}, tilt ${kn.map((k) => (k.t * 57.3).toFixed(0)).join(" ")} deg)`);
if (cleanK.length) {
  const jd = (a: number[], b: number[]) => { let s = 0; for (let j = 7; j < 36; j++) s += (a[j] - b[j]) ** 2; return Math.sqrt(s); };
  const med0 = cleanK.reduce((best, a) => { const s = cleanK.reduce((t, b) => t + jd(a.q, b.q), 0); return s < best.s ? { a, s } : best; }, { a: cleanK[0], s: Infinity }).a;
  anchors.kneel = { qpos: med0.q, note: `physics: the body when the fighter asked for getup.stand after the planner's getup.knees (medoid of ${cleanK.length} clean kneels of ${kn.length})`,
    info: { pelvisZ: r3(med0.q[2]), kneesZ: [r3(med0.f.kneeL), r3(med0.f.kneeR)], spread: r3(Math.max(...cleanK.map((b) => jd(b.q, med0.q)))) } };
}

// fallback: the planner's getup.knees end pose, lifted out of the floor (its toes plan 2-4 cm into it)
const ctx4 = (q: ArrayLike<number>) => { const c: number[] = []; for (let k = 0; k < 4; k++) c.push(...Array.from(q).slice(0, 36)); return c; };
for (const [from, q] of [["lying.back", anchors["lying.back"]?.qpos], ["lying.front", anchors["lying.front"]?.qpos], ["guard", G]] as const) {
  if (!q || anchors.kneel) continue;
  const clip = await plannerSrc.get({ name: "getup.knees", context: ctx4(q), contextFrame: 0, startFrame: 0, facing: [1, 0], speed: -1, seed: 1234, urgent: true });
  if (!clip?.frames.length) continue;
  const last = Array.from(clip.frames[clip.frames.length - 1]), f = fk(last), tilt = tiltOf([last[3], last[4], last[5], last[6]]);
  const ok = tilt < 0.45 && f.kneeL < 0.12 && f.kneeR < 0.12 && last[2] > 0.2 && last[2] < 0.6;
  console.log(`kneel from ${from}: ${clip.frames.length} frames, pelvis z ${last[2].toFixed(2)}, tilt ${(tilt * 57.3).toFixed(0)} deg, knees z ${f.kneeL.toFixed(2)}/${f.kneeR.toFixed(2)} ${ok ? "clean" : "not clean"}`);
  if (!ok) continue;
  const q2 = rebase(last).qpos, lift = -floorGap(q2);
  q2[2] += lift;
  anchors.kneel = { qpos: q2, note: `planner getup.knees (kneelTwoLeg, height 0.3) end pose, planned from ${from}, lifted ${(lift * 100).toFixed(1)} cm out of the floor`, info: { pelvisZ: r3(q2[2]), kneesZ: [r3(f.kneeL + lift), r3(f.kneeR + lift)] } };
}

// ================= punches: the planner's frame of furthest reach =================

const PUNCH_SET = [["punch.leftJab", "handL"], ["punch.rightJab", "handR"], ["punch.leftHook", "handL"], ["punch.rightHook", "handR"]] as const;
const gseq = rec[best.who];
const ci = Math.min(best.i, gseq.length - 8);
const ctxFrom = (i: number) => { const c: number[] = []; for (let n = 0; n < 4; n++) { const s = i + (n * 50) / 30, a = Math.floor(s); c.push(...mixFrames(copyFrame(gseq[a].raw), copyFrame(gseq[a + 1].raw), s - a)); } return c; };
for (const [name, hand] of PUNCH_SET) {
  let bestP: { reach: number; k: number; frames: number[][]; seed: number } | null = null;
  for (const seed of [1234, 7, 99]) {
    const clip = await plannerSrc.get({ name, context: ctxFrom(ci), contextFrame: 0, startFrame: 0, facing: [Math.cos(gseq[ci].opp), Math.sin(gseq[ci].opp)], seed, urgent: true });
    if (!clip?.frames.length) continue;
    const frames = clip.frames.map((f) => Array.from(f)), f0 = frames[0], th = gseq[ci].opp;
    let reach = -Infinity, k = 0;
    for (let i = 5; i < frames.length && i < 50; i++) { // the first second
      const h = fk(frames[i])[hand];
      const r = (h[0] - f0[0]) * Math.cos(th) + (h[1] - f0[1]) * Math.sin(th);
      if (r > reach) { reach = r; k = i; }
    }
    if (!bestP || reach > bestP.reach) bestP = { reach, k, frames, seed };
  }
  if (!bestP) { console.log(`${name}: no plan`); continue; }
  const f0 = bestP.frames[0], hit = bestP.frames[bestP.k], end = bestP.frames[Math.min(bestP.frames.length - 1, bestP.k + 20)];
  const off = relOffset(f0, hit), endOff = relOffset(f0, end), hf = fk(hit), h = hf[hand];
  // the fist's speed over the last two frames into the key frame
  const hb = fk(bestP.frames[Math.max(0, bestP.k - 2)])[hand], v = Math.hypot(h[0] - hb[0], h[1] - hb[1], h[2] - hb[2]) * 25;
  const info = { key: r3(bestP.k / 50), offset: off.map(r3), endOffset: endOff.map(r3), reach: r3(bestP.reach), fistMinusHeadZ: r3(h[2] - hf.head[2]), speedIn: r3(v), planFrames: bestP.frames.length, seed: bestP.seed };
  anchors[`${name}.hit`] = { qpos: rebase(hit).qpos, note: `planner ${name} at its furthest reach (${bestP.reach.toFixed(2)} m from the start pelvis toward the opponent) ${info.key} s into the plan, fist moving ${v.toFixed(1)} m/s; use as a keyframe at t=key with offset`, info };
  console.log(`${name}: reach ${bestP.reach.toFixed(2)} m at ${info.key} s, fist ${v.toFixed(1)} m/s, pelvis offset at key ${off.map((x) => x.toFixed(2))}, +0.4 s ${endOff.map((x) => x.toFixed(2))}`);
}

// ================= synthetic block and duck: guard + the fighter's own overlay offsets =================
// The upper body takes the overlay's offsets, the pelvis drops (and tilts forward), and the legs are
// solved so all 8 foot spheres stay where the guard has them: same stance, feet flat and planted.

const J = { waistPitch: 14, shPitchL: 15, shRollL: 16, elbowL: 18, shPitchR: 22, shRollR: 23, elbowR: 25 };
const LEG = [0, 1, 3, 4, 5, 6, 7, 9, 10, 11]; // hip pitch/roll, knee, ankle pitch/roll, both legs
const soleGeoms = [...footGeoms.l, ...footGeoms.r];
function soles(q: ArrayLike<number>) {
  world.setRobotQpos(R, q); world.forward();
  const gx = world.data.geom_xpos;
  return soleGeoms.flatMap((g) => [gx[g * 3], gx[g * 3 + 1], gx[g * 3 + 2]]);
}
function solve(A: number[][], b: number[]): number[] { // Gaussian elimination, partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
const guardSoles = soles(G);
/**
 * Damped least squares on the leg joints: the soles back onto the guard's. Height counts fully and
 * the footprint's xy at `xyW` (a deep duck may slide a foot a little). Returns the weighted rms miss (m).
 */
function plantFeet(q: number[], xyW = 1, target = guardSoles): number {
  let rms = 0;
  const w = (i: number) => (i % 3 === 2 ? 1 : xyW);
  for (let it = 0; it < 40; it++) {
    const s0 = soles(q), r = s0.map((v, i) => (v - target[i]) * w(i));
    rms = Math.sqrt(r.reduce((t, v) => t + v * v, 0) / soleGeoms.length);
    if (rms < 2e-4) break;
    const cols = LEG.map((j) => { const qq = q.slice(); qq[7 + j] += 1e-4; return soles(qq).map((v, i) => ((v - s0[i]) / 1e-4) * w(i)); });
    const A = cols.map((ca, a) => cols.map((cb, b) => ca.reduce((t, v, i) => t + v * cb[i], 0) + (a === b ? 2e-3 : 0)));
    const dx = solve(A, cols.map((c) => -c.reduce((t, v, i) => t + v * r[i], 0)));
    LEG.forEach((j, k) => { q[7 + j] = Math.min(R.hi[j], Math.max(R.lo[j], q[7 + j] + Math.max(-0.2, Math.min(0.2, dx[k])))); });
  }
  return rms;
}
function synth(offsets: [number, number][], drop: number, pitch: number, xyW = 1) {
  const q = G.slice();
  for (const [j, v] of offsets) q[7 + j] = Math.min(R.hi[j], Math.max(R.lo[j], q[7 + j] + v));
  q[2] -= drop;
  // tilt the pelvis forward about its own y axis (keeps the hip heading)
  const t = qmul([q[3], q[4], q[5], q[6]], [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0]);
  q[3] = t[0]; q[4] = t[1]; q[5] = t[2]; q[6] = t[3];
  const miss = plantFeet(q, xyW);
  q[2] += gf.footMin - fk(q).footMin; // what the legs can't reach (ankle limits) lifts a heel, never sinks a toe
  const f = fk(q);
  return { q, miss, f, headDrop: gf.head[2] - f.head[2] };
}
function keep(key: string, s: ReturnType<typeof synth>, note: string) {
  const f = s.f;
  const slide = Math.sqrt(soles(s.q).reduce((t, v, i) => (i % 3 === 2 ? t : t + (v - guardSoles[i]) ** 2), 0) / soleGeoms.length);
  anchors[key] = { qpos: s.q, note, info: { headDrop: r3(s.headDrop), soleMiss: r3(s.miss), footSlide: r3(slide), fistsMinusHeadZ: [r3(f.handL[2] - f.head[2]), r3(f.handR[2] - f.head[2])], fistsAheadOfHead: [r3(f.handL[0] - f.head[0]), r3(f.handR[0] - f.head[0])] } };
  console.log(`${key}: head drop ${s.headDrop.toFixed(3)} m, soles off the guard's by ${(s.miss * 1000).toFixed(1)} mm rms (feet ${f.footL.map((v) => v.toFixed(3))}/${f.footR.map((v) => v.toFixed(3))}), fists ${(f.handL[2] - f.head[2]).toFixed(2)}/${(f.handR[2] - f.head[2]).toFixed(2)} m vs head, ${(f.handL[0] - f.head[0]).toFixed(2)}/${(f.handR[0] - f.head[0]).toFixed(2)} m ahead of it`);
}
// block: TUNE's block overlay on the arms, its forward tilt (0.08) in the waist, knees soft (2 cm lower)
const BLOCK_ARMS: [number, number][] = [[J.shPitchL, -0.35], [J.shPitchR, -0.35], [J.elbowL, -0.45], [J.elbowR, -0.45], [J.shRollL, -0.1], [J.shRollR, 0.1], [J.waistPitch, 0.08]];
keep("block", synth(BLOCK_ARMS, 0.02, 0), "synthetic: guard + the fighter's block overlay (forearms up), knees soft, legs solved to keep the guard's footprint; mid-clip keyframe for block");
// duck: sit into the legs and fold forward until the head is ~0.24 m lower (the planner-era duck: 0.22),
// the least drop that gets there at whichever forward tilt keeps the feet best; the shoulders lift
// with the fold so the gloves stay up by the face, and the feet may slide a little
let duck: ReturnType<typeof synth> | null = null;
for (const pitch of [0.2, 0.3, 0.4, 0.5, 0.6]) {
  for (let d = 0; d <= 0.3; d += 0.01) {
    const s = synth([[J.waistPitch, 0.12], [J.shPitchL, -0.6 * (pitch + 0.12)], [J.shPitchR, -0.6 * (pitch + 0.12)]], d, pitch, 0.3);
    if (s.headDrop < 0.24) continue;
    console.log(`  duck try: pelvis tilt +${pitch} rad, drop ${d.toFixed(2)} m: soles miss ${(s.miss * 1000).toFixed(1)} mm`);
    if (!duck || s.miss < duck.miss - 0.002) duck = s;
    break;
  }
}
if (duck) keep("duck", duck, "synthetic: guard sitting into the legs and folding forward (pelvis tilt + waist), head ~0.24 m lower, legs solved to keep the guard's footprint; mid-clip keyframe at the bottom of a duck");

// ================= synthetic dodges: guard leaning out of the way, feet where the guard has them =================
// The fighter's dodge overlay tilts the whole body 0.32 rad to the side (0.2 back) on soft knees. Here
// the waist bends that way, the pelvis tilts (up to the overlay's angle) and shifts that way until the
// head is DODGE_HEAD out of the way. Of the poses that keep the feet where the guard has them (soles
// within 12 mm rms), the one that shifts the pelvis least wins: moving the body's mass is what SONIC
// is slow at, and clip-check wants the head 0.18 m out by 0.3 s. Idealized clips (guard -> anchor by
// 0.2 s, held) through clip-check: head 0.25 m out with a 0.16 m shift and a straight waist: 0.12 m
// by 0.3 s; least shift, waist bent: 0.25 m -> 0.17-0.19, 0.30 -> 0.20-0.21 (back 0.16), 0.35 ->
// 0.22-0.23 (back 0.18), nobody falls. The pose is then re-based like every anchor; info.offset
// [dx, dy, dyaw] says where its pelvis was, which is the keyframe's offset.
const DODGE_HEAD = Number(opt("--dodge-head", "0.35"));
function lean(axis: number[], angle: number, shift: [number, number], drop: number, joints: [number, number][]) {
  const q = G.slice();
  for (const [j, v] of joints) q[7 + j] = Math.min(R.hi[j], Math.max(R.lo[j], q[7 + j] + v));
  q[0] += shift[0]; q[1] += shift[1]; q[2] -= drop;
  const t = qmul(axisAngleQuat(axis[0], axis[1], axis[2], angle), [q[3], q[4], q[5], q[6]]); // about a world axis
  q[3] = t[0]; q[4] = t[1]; q[5] = t[2]; q[6] = t[3];
  const miss = plantFeet(q);
  q[2] += gf.footMin - fk(q).footMin;
  const f = fk(q);
  return { q, miss, f, headDrop: gf.head[2] - f.head[2], head: [f.head[0] - gf.head[0], f.head[1] - gf.head[1]], shift };
}
const DODGES = [
  // name, way the head goes (xy), tilt axis + angle (world), the waist joint that bends with it (+ = toward `way`)
  ["dodge.left", [0, 1], [1, 0, 0], -0.32, 13, -1], ["dodge.right", [0, -1], [1, 0, 0], 0.32, 13, 1], ["dodge.back", [-1, 0], [0, 1, 0], -0.2, 14, -1],
] as const;
for (const [key, way, axis, angle0, wj, wsign] of DODGES) {
  let pick: ReturnType<typeof lean> | null = null, bend = 0, angle: number = angle0;
  const better = (l: ReturnType<typeof lean>) => !pick || (l.miss < 0.012 ? pick.miss >= 0.012 || Math.hypot(...l.shift) < Math.hypot(...pick.shift) - 1e-9 : l.miss < pick.miss);
  for (const a of [angle0, angle0 * 0.6, angle0 * 0.3, 0]) {
    for (let k = 0; k <= 0.8 + 1e-9; k += 0.05) { // up to the joint's limit
      if (wsign * k + G[7 + wj] > R.hi[wj] - 0.03 || wsign * k + G[7 + wj] < R.lo[wj] + 0.03) break;
      for (let s = 0; s <= 0.2 + 1e-9; s += 0.01) {
        const l = lean([...axis], a, [way[0] * s, way[1] * s], key === "dodge.back" ? 0.02 : 0.03, [[wj, wsign * k]]);
        if (l.head[0] * way[0] + l.head[1] * way[1] < DODGE_HEAD) continue;
        if (better(l)) { pick = l; bend = r3(k); angle = a; }
        break;
      }
    }
  }
  if (!pick) { console.log(`${key}: no lean gets the head ${DODGE_HEAD} m out of the way`); continue; }
  const off = [r3(pick.q[0]), r3(pick.q[1]), r3(hipHeading([pick.q[3], pick.q[4], pick.q[5], pick.q[6]]))];
  const away = pick.head[0] * way[0] + pick.head[1] * way[1];
  keep(key, pick, `synthetic: guard leaning ${key.slice(6)} (extra pelvis tilt ${Math.abs(angle).toFixed(2)} rad, the fighter's overlay tilts ${Math.abs(angle0)}; pelvis shifted ${Math.hypot(off[0], off[1]).toFixed(2)} m, waist bent ${bend} rad), head ${away.toFixed(2)} m out of the way, feet kept where the guard has them; key it with offset info.offset (where its pelvis sits from the guard's)`);
  anchors[key].qpos = rebase(pick.q).qpos; // offset's dyaw turns it back about its pelvis, its xy puts the pelvis back
  anchors[key].info = { ...anchors[key].info, offset: off, headAway: r3(away), headDrop: r3(pick.headDrop), waistBend: bend, pelvisTilt: r3(Math.abs(angle)) };
}

// ================= guard.up: the get-ups' end pose =================
// The planner's guard tips the pelvis ~12-15 deg BACK and pitches the waist 0.3-0.36 rad forward
// (waistToHips undoes that for SONIC on the guard path, but get-up clips skip it). guard.up is
// guard.high (the bounce's top) with that pitch moved out of the waist into the pelvis (top forward),
// arms, head and feet where they are, so a get-up keyed to end on it clears the fighter's standing
// test (pelvis z > 0.66, tilt < 0.3 rad) with room to spare.
{
  const H = anchors["guard.high"].qpos, hSoles = soles(H);
  let best: { q: number[]; tilt: number; miss: number; th: number } | null = null;
  for (let th = 0.04; th <= 0.3 + 1e-9; th += 0.02) {
    const q = H.slice(), wp = 7 + J.waistPitch;
    if (q[wp] - th < R.lo[J.waistPitch] + 0.02) break;
    q[wp] -= th;
    const t = qmul([q[3], q[4], q[5], q[6]], [Math.cos(th / 2), 0, Math.sin(th / 2), 0]); // about its own y: top forward
    q[3] = t[0]; q[4] = t[1]; q[5] = t[2]; q[6] = t[3];
    const miss = plantFeet(q, 1, hSoles);
    q[2] += fk(H).footMin - fk(q).footMin;
    const tilt = tiltOf([q[3], q[4], q[5], q[6]]);
    if (!best || tilt < best.tilt) best = { q, tilt, miss, th };
  }
  if (best) {
    const f = fk(best.q), fh = fk(H);
    anchors["guard.up"] = { qpos: best.q, note: `guard.high with ${best.th.toFixed(2)} rad of waist pitch moved into the pelvis (pelvis tilt ${(best.tilt * 57.3).toFixed(1)} deg), legs solved to keep its footprint; the end pose for get-ups`,
      info: { soleMiss: r3(best.miss), headMoved: r3(Math.hypot(f.head[0] - fh.head[0], f.head[1] - fh.head[1], f.head[2] - fh.head[2])), fistsMinusHeadZ: [r3(f.handL[2] - f.head[2]), r3(f.handR[2] - f.head[2])] } };
    console.log(`guard.up: pelvis tilt ${(best.tilt * 57.3).toFixed(1)} deg (guard.high ${(tiltOf([H[3], H[4], H[5], H[6]]) * 57.3).toFixed(1)}), z ${best.q[2].toFixed(3)}, waist pitch -${best.th.toFixed(2)}, soles off by ${(best.miss * 1000).toFixed(1)} mm, head moved ${(Math.hypot(f.head[0] - fh.head[0], f.head[1] - fh.head[1], f.head[2] - fh.head[2]) * 100).toFixed(1)} cm`);
  }
}

// ================= check every anchor, write =================

const issues: string[] = [];
for (const [k, a] of Object.entries(anchors)) {
  const q = a.qpos;
  const n = Math.hypot(q[3], q[4], q[5], q[6]);
  if (Math.abs(n - 1) > 1e-6) { for (let i = 3; i < 7; i++) q[i] /= n; }
  let over = 0;
  for (let j = 0; j < NJ; j++) {
    const v = q[7 + j], c = Math.min(R.hi[j], Math.max(R.lo[j], v));
    if (c !== v) { over = Math.max(over, Math.abs(c - v)); q[7 + j] = c; }
  }
  if (over > 0.02) issues.push(`${k}: joints past the limits by up to ${over.toFixed(3)} rad (clamped)`);
  if (Math.abs(q[0]) > 1e-9 || Math.abs(q[1]) > 1e-9 || Math.abs(hipHeading([q[3], q[4], q[5], q[6]])) > 1e-6) issues.push(`${k}: not re-based`);
  const f = fk(q), tilt = tiltOf([q[3], q[4], q[5], q[6]]);
  const standing = k.startsWith("guard") || k === "block" || k === "duck" || k.startsWith("dodge.");
  if (standing && (Math.abs(f.footL[0]) > 0.015 || Math.abs(f.footR[0]) > 0.015)) issues.push(`${k}: feet not on the floor (${f.footL[0].toFixed(3)}, ${f.footR[0].toFixed(3)})`);
  if (standing && tilt > (k === "duck" || k.startsWith("dodge.") ? 0.7 : 0.4)) issues.push(`${k}: tilted ${(tilt * 57.3).toFixed(0)} deg`);
  if (k === "guard.up" && !(q[2] > 0.68 && tilt < 0.2)) issues.push(`${k}: pelvis z ${q[2].toFixed(3)}, tilt ${(tilt * 57.3).toFixed(1)} deg: not clear of the fighter's standing test`);
  if (k.startsWith("lying") && (q[2] > 0.35 || f.minBody < -0.04)) issues.push(`${k}: pelvis z ${q[2].toFixed(2)}, lowest body ${f.minBody.toFixed(2)}`);
  // every anchor, whatever it is: no collision geom more than 1 cm into the floor (MuJoCo's contacts)
  const gap = floorGap(q);
  if (gap < -0.01) issues.push(`${k}: ${(-gap * 100).toFixed(1)} cm into the floor`);
  a.info = { ...(a.info ?? {}), pelvisZ: r3(q[2]), tiltDeg: Math.round(tilt * 57.3), feetZ: [r3(f.footL[0]), r3(f.footR[0])], headZ: r3(f.head[2]), floorGap: r3(gap) };
  a.qpos = q.map(r5);
}
for (const i of issues) console.log(`  FAIL  ${i}`);
if (!anchors["lying.back"]) issues.push("no lying.back sample");
if (!anchors["lying.front"]) issues.push("no lying.front sample");
// one line per number list
writeFileSync(OUT, `${JSON.stringify(anchors, null, 1).replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, l: string) => `[${l.split(/,\s+/).join(", ")}]`)}\n`);
console.log(`\n${Object.keys(anchors).length} anchors -> ${OUT}: ${Object.keys(anchors).join(", ")}\nsim ${simWall.toFixed(0)} s wall, total ${((performance.now() - t0) / 1000).toFixed(0)} s; ${issues.length ? `${issues.length} issues` : "all checks pass"}`);
process.exit(issues.length ? 1 : 0);
