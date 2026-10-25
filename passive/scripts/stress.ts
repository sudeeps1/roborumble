// Randomized stress test of everything between moves and between fighters. Both fighters spar
// (random styles), and the test fires random actions at random times: instant hits, punches,
// defenses, clips (good and broken), KOs, resets, teleports into each other, NaN and huge-velocity
// injections, bad arguments, the motion source going offline, and both hit modes. The motion
// source itself drops, delays, hangs, throws and corrupts answers. Invariants are checked every
// tick; any violation is printed and the run fails.
//   node scripts/stress.ts [simSeconds=180] [seed=1] [--fight]
// --fight: no random actions and a well-behaved planner, just the two sparring AIs (a fight log).
import { ATTACKS } from "../src/core/attacks.ts";
import { DEFENSES, type Defense, type Fighter, LIMITS, PUNCHES, type PunchName, TUNE } from "../src/core/fighter.ts";
import type { ArenaEvent, Who } from "../src/core/events.ts";
import { DEFAULT_ANGLES } from "../src/core/g1.ts";
import { Rng, finite3 } from "../src/core/math.ts";
import { ClipSource, LayeredSource, type MotionAsk, type MotionClip, type MotionSource, PlannerSource, type StrikeWindow, rowsFromJson, strikeFromHit } from "../src/core/motion.ts";
import { STYLES, Sparrer } from "../src/core/spar.ts";
import { type MoveSpec, specFromLibrary } from "../src/core/spells.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeArena } from "./node-arena.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FIGHT = process.argv.includes("--fight");
const SECONDS = Number(args[0] ?? 180);
const SEED = Number(args[1] ?? 1);
const rng = new Rng(SEED);

/** A motion source that misbehaves in every way a network service or a bad clip can. */
class ChaosSource implements MotionSource {
  inner: MotionSource;
  counts = { ok: 0, nul: 0, reject: 0, throwSync: 0, hang: 0, corrupt: 0 };
  constructor(inner: MotionSource) { this.inner = inner; }
  get(ask: MotionAsk): Promise<MotionClip | null> {
    const r = rng.next();
    if (r < 0.01) { this.counts.throwSync++; throw new Error("chaos: sync throw"); }
    if (r < 0.02) { this.counts.hang++; return new Promise(() => {}); } // never answers
    return (async () => {
      if (rng.next() < 0.3) await new Promise((res) => setTimeout(res, rng.next() * 250));
      if (r < 0.06) { this.counts.reject++; throw new Error("chaos: planner down"); }
      if (r < 0.09) { this.counts.nul++; return null; }
      const clip = await this.inner.get(ask);
      if (!clip || r > 0.15) { this.counts.ok++; return clip; }
      this.counts.corrupt++;
      switch (rng.int() % 7) {
        case 0: clip.frames[clip.frames.length >> 1][7 + 9] = Number.NaN; break;
        case 1: clip.at += 100000; break;
        case 2: clip.frames = []; break;
        case 3: clip.at = Number.NaN; break;
        case 4: clip.strikes = [{ limb: "tail" as never, from: Number.NaN, to: 1, power: 5, name: "x" }, { limb: "r_hand", from: 0.2, to: 0.1, power: 1, name: "backwards" }]; break;
        case 5: for (const f of clip.frames) { f[3] = 0; f[4] = 0; f[5] = 0; f[6] = 0; } break; // fixed up by sanitize
        case 6: for (const f of clip.frames) for (let j = 7; j < 36; j++) f[j] += 5; break;  // clamped to limits
      }
      return clip;
    })();
  }
}

/** A front kick: right leg up and out, 1.2 s at 30 fps, standing at the origin facing +X. */
function kickClip(): number[][] {
  const rows: number[][] = [];
  for (let k = 0; k <= 36; k++) {
    const t = k / 30, u = t < 0.5 ? t / 0.5 : t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.5);
    const s = u * u * (3 - 2 * u);
    const q = DEFAULT_ANGLES.slice();
    q[6] = -0.312 - 1.1 * s; q[9] = 0.669 - 0.45 * s; q[10] = -0.363 + 0.2 * s; // right hip, knee, ankle
    q[15] = 0.2 - 0.6 * s; q[22] = 0.2 - 0.4 * s; // arms up for balance
    rows.push([0.02 * s, 0, 0.793, 1, 0, 0, 0, ...q]);
  }
  return rows;
}
const KICK = kickClip();

// Vaibhav's Kimodo spells (public/clips-kimodo), cast at random, plus broken specs
const SPELL_DIR = join(import.meta.dirname, "..", "public", "clips-kimodo");
const SPELLS = (JSON.parse(readFileSync(join(SPELL_DIR, "spells.json"), "utf8")) as Record<string, unknown>[]).map((e) => {
  const c = JSON.parse(readFileSync(join(SPELL_DIR, String(e.file)), "utf8"));
  return { spec: specFromLibrary(e as never), qpos: c.qpos as number[][], fps: c.fps as number };
});
const BAD_SPECS: MoveSpec[] = [
  { name: "no kind", kind: "teleport" as never },
  { name: "nan frame", kind: "projectile", hitFrame: Number.NaN, power: Number.POSITIVE_INFINITY, hitJoint: "tail" as never },
  { name: "late frame", kind: "strike", hitFrame: 1e6, power: -3 },
  { name: "melee", kind: "melee", hitFrame: 0, power: 3 },
  { name: "wave", kind: "shockwave", power: 2 },
];

/** Synthetic clip library standing in for Kimodo clips (logic coverage, not realism). */
function syntheticClips(): ClipSource {
  const stand = (k: number, f: (t: number, q: number[]) => void, z = 0.793, quat = [1, 0, 0, 0], x = (t: number) => 0) => {
    const rows: number[][] = [];
    for (let i = 0; i <= k; i++) { const t = i / 30, q = DEFAULT_ANGLES.slice(); f(t, q); rows.push([x(t), 0, z, ...quat, ...q]); }
    return rows;
  };
  const up = (t: number, q: number[]) => { q[15] = q[22] = -0.6; q[18] = q[25] = -0.3; void t; };
  const lying = [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0]; // pitched back 90 deg: face up
  const getup: number[][] = [];
  for (let i = 0; i <= 60; i++) { // face up to standing in 2 s (crude, for the stage logic only)
    const u = i / 60, a = (-Math.PI / 2) * (1 - u);
    const q = DEFAULT_ANGLES.slice(); q[0] = q[6] = -1.2 * (1 - u) - 0.312 * u; q[3] = q[9] = 1.8 * (1 - u) + 0.669 * u;
    getup.push([0, 0, 0.15 + 0.64 * u, Math.cos(a / 2), 0, Math.sin(a / 2), 0, ...q]);
  }
  void lying;
  return new ClipSource({
    guard: [{ fps: 30, qpos: stand(30, (t, q) => { q[3] = q[9] = 0.669 + 0.08 * Math.sin(t * 12); }) }],
    block: [{ fps: 30, qpos: stand(24, up) }],
    duck: [{ fps: 30, qpos: stand(18, (t, q) => { q[0] = q[6] = -0.9; q[3] = q[9] = 1.5; q[4] = q[10] = -0.8; void t; }, 0.62) }],
    "step.forward": [{ fps: 30, qpos: stand(30, () => {}, 0.793, [1, 0, 0, 0], (t) => 0.3 * t) }],
    "getup.knees": [{ fps: 30, qpos: getup }],
  });
}
const CLIPS = syntheticClips();
const KICK_STRIKE: StrikeWindow[] = [{ limb: "r_foot", from: 0.35, to: 0.8, power: 1, name: "front kick", key: 0.55 }];
const KICK_JSON = { fps: 30, root_pos: KICK.map((r) => r.slice(0, 3)), root_quat: KICK.map((r) => r.slice(3, 7)), joint_pos: KICK.map((r) => r.slice(7)) };
const BROKEN_CLIPS: [unknown, number][] = [
  [KICK.map((r, i) => (i === 10 ? r.map(() => Number.NaN) : r)), 30], // NaN row
  [KICK.map((r) => r.slice(0, 20)), 30],                            // short rows
  [KICK, 0],                                                        // fps 0
  [[KICK[0]], 30],                                                  // one frame
  [Array.from({ length: 1000 }, () => KICK[0]), 30],                // 33 s, too long
  [[], 30],
  ["not a clip", 30],
];

const { world, planner, arena } = await nodeArena({ names: ["A", "B"], seeds: [SEED * 7 + 1, SEED * 13 + 5] });
if (!planner) { console.log("no planner model: run npm run setup:planner"); process.exit(1); }
const HANG: MotionSource = { get: () => new Promise(() => {}) };
const chaos: MotionSource & { counts?: object } = FIGHT ? new PlannerSource(planner) : new ChaosSource(new PlannerSource(planner));
arena.setMotion(chaos);
arena.reset();
const [A, B] = arena.fighters;
const styles = Object.values(STYLES);
const brains = arena.fighters.map((f, i) => new Sparrer(f, styles[i % styles.length], SEED * 31 + i));
arena.setBrain(0, brains[0]); arena.setBrain(1, brains[1]);

// ---------- invariants ----------
const problems: string[] = [];
const fail = (msg: string) => { if (problems.length < 60) problems.push(`t=${arena.time.toFixed(2)} ${msg}`); };
process.on("unhandledRejection", (r) => fail(`unhandled rejection: ${r instanceof Error ? r.stack : r}`));

const count: Record<string, number> = {};
const pendingDown: (number | null)[] = [null, null];
const pendingUp: (number | null)[] = [null, null];
const lastGetup = [-Infinity, -Infinity];
const lastApplied = [0, 0], lastAppliedT = [0, 0];
arena.on((e: ArenaEvent) => {
  const key = e.type === "whiff" ? `whiff:${e.reason}` : e.type === "hit" ? `hit:${e.attacker === null ? "rig" : "fist"}${e.blocked ? ":blocked" : ""}` : e.type;
  count[key] = (count[key] ?? 0) + 1;
  switch (e.type) {
    case "hit": {
      const d = arena.fighters[e.defender];
      if (!["idle", "stagger", "defend", "move"].includes(e.stance)) fail(`hit landed on ${d.name} while ${e.stance}`);
      if (arena.time - lastGetup[e.defender] < TUNE.grace - 0.021) fail(`hit on ${d.name} ${(arena.time - lastGetup[e.defender]).toFixed(2)} s after getting up (grace ${TUNE.grace})`);
      if (!finite3(e.point) || !finite3(e.dir) || !Number.isFinite(e.damage)) fail(`non-finite hit ${JSON.stringify(e)}`);
      break;
    }
    case "knockdown": case "fall": pendingDown[e.who] = arena.time; break;
    case "down": pendingDown[e.who] = null; pendingUp[e.who] = arena.time; break;
    case "getup": pendingUp[e.who] = null; lastGetup[e.who] = arena.time; break;
    case "ko": pendingDown[e.who] = pendingUp[e.who] = null; break;
    case "spawn": pendingDown[e.who] = pendingUp[e.who] = null; lastGetup[e.who] = -Infinity; break;
    case "failsafe":
      if (e.who === null) { pendingDown.fill(null); pendingUp.fill(null); } else { pendingDown[e.who] = pendingUp[e.who] = null; }
      break;
  }
});

// stance events form an unbroken chain per fighter, ending at the stance the fighter is in
const lastTo: (string | null)[] = [null, null];
arena.on((e) => {
  if (e.type !== "stance") return;
  if (lastTo[e.who] !== null && e.from !== lastTo[e.who]) fail(`${arena.fighters[e.who].name} stance chain broken: was ${lastTo[e.who]}, then ${e.from} -> ${e.to}`);
  lastTo[e.who] = e.to;
});

// a KO ends only with a fresh spawn (a reset), and is reported once
const leftKO = [false, false], koCount = [0, 0];
arena.on((e) => {
  if (e.type === "stance" && e.from === "ko") leftKO[e.who] = true;
  if (e.type === "spawn") { leftKO[e.who] = false; koCount[e.who] = 0; }
  if (e.type === "ko" && ++koCount[e.who] > 1) fail(`${arena.fighters[e.who].name} reported KO twice`);
});

// listeners that act on events, the way game code will: they must always see a settled fighter
let poked = 0;
if (!FIGHT) arena.on((e) => {
  if (e.type === "stance") {
    const f = arena.fighters[e.who];
    const r = rng.next();
    if (r < 0.02) { poked++; f.defend(pick(DEFENSES)); }
    else if (r < 0.025) { poked++; f.opponent.throwPunch(pick(PUNCHES)); }
    else if (r < 0.026) { poked++; f.knockOut(); }
  }
  if (e.type === "hit" && rng.next() < 0.01) { poked++; reset(); }
});

function check() {
  for (const f of arena.fighters) {
    const i = f.index;
    const p = world.rootPos(f.robot);
    if (!finite3(p)) fail(`${f.name} root not finite`);
    if (f.stanceT > LIMITS[f.stance] + 1e-6) fail(`${f.name} ${f.stance} for ${f.stanceT.toFixed(2)} s (limit ${LIMITS[f.stance]})`);
    if (f.stats.badTransitions) { fail(`${f.name} bad transition ${f.lastBadTransition}`); f.stats.badTransitions = 0; }
    if (leftKO[i]) { fail(`${f.name} left KO without a reset`); leftKO[i] = false; }
    if (lastTo[i] !== null && lastTo[i] !== f.stance) { fail(`${f.name} is ${f.stance} but its last stance event said ${lastTo[i]}`); lastTo[i] = f.stance; }
    if (f.stats.errors) { fail(`${f.name} error: ${f.lastEvent}`); f.stats.errors = 0; }
    const d = f.debug();
    if (d.inflight && d.inflight.age > TUNE.askTimeout + 0.03) fail(`${f.name} request stuck ${d.inflight.age.toFixed(2)} s`);
    if (d.pulses > 6 || d.effects > 2) fail(`${f.name} piling up: ${d.pulses} pulses, ${d.effects} effects`);
    if (!(f.poise >= 0 && f.poise <= 1)) fail(`${f.name} poise ${f.poise}`);
    if (!(arena.hp[i] >= 0 && arena.hp[i] <= arena.maxHp)) fail(`${f.name} hp ${arena.hp[i]}`);
    if (pendingDown[i] !== null && arena.time - pendingDown[i]! > LIMITS.falling + 0.1) { fail(`${f.name} fell but never went down`); pendingDown[i] = null; }
    if (pendingUp[i] !== null && arena.time - pendingUp[i]! > TUNE.downBeat + LIMITS.rising + 0.6) { fail(`${f.name} down but never got up`); pendingUp[i] = null; }
    if (f.stance === "ko" && f.stanceT > TUNE.koSlump + 0.1 && f.ctl.active) fail(`${f.name} KO but the controller is still on`);
    // footwork keeps getting motion while idle (the chaos source fails ~15% of asks)
    if (f.stats.applied !== lastApplied[i] || f.stance !== "idle" || !f.motion || f.motion === HANG) { lastApplied[i] = f.stats.applied; lastAppliedT[i] = arena.time; }
    else if (arena.time - lastAppliedT[i] > 10) { fail(`${f.name} idle with no new motion for 10 s`); lastAppliedT[i] = arena.time; }
  }
  if (arena.combat.size > 12) fail(`strike windows piling up: ${arena.combat.size}`);
  if (arena.stats.errors) { fail(`arena error: ${arena.lastError}`); arena.stats.errors = 0; }
}

// ---------- random actions ----------
const actions: Record<string, number> = {};
const did = (k: string) => { actions[k] = (actions[k] ?? 0) + 1; };
let koAt = -1;
let offlineUntil = -1;
const pick = <T>(xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(rng.next() * xs.length))];
const someone = (): Fighter => pick(arena.fighters);
const reset = () => arena.reset(); // "spawn" events clear what the checks expect

function act() {
  const r = rng.next();
  if (r < 0.006) { did("instant"); arena.hitInstant(pick([0, 1] as Who[]), pick(ATTACKS), rng.range(0.3, 2.2)); }
  else if (r < 0.016) {
    did("punch");
    const bad = rng.next() < 0.1;
    someone().throwPunch(bad ? ("punch.flying" as PunchName) : pick(PUNCHES), bad ? pick([Number.NaN, -1, 0, 1e9]) : rng.range(0.5, 1.6));
  } else if (r < 0.026) {
    did("defend");
    const bad = rng.next() < 0.1;
    const withClip = rng.next() < 0.15 ? (rng.next() < 0.7 ? { qpos: KICK, fps: 30 } : { qpos: pick(BROKEN_CLIPS)[0] as number[][], fps: 30 }) : undefined;
    someone().defend(bad ? ("teleport" as Defense) : pick(DEFENSES), pick([undefined, rng.range(0.1, 2), Number.NaN, 0, 50]), withClip);
  } else if (r < 0.030) {
    did("playMove");
    const f = someone();
    if (rng.next() < 0.3) f.playMove(KICK, 30, KICK_STRIKE, "front kick");
    else if (rng.next() < 0.5) { const m = rowsFromJson(KICK_JSON); if (!m) fail("rowsFromJson rejected a good clip"); else f.playMove(m.qpos, m.fps, [strikeFromHit({ joint: "r_foot", frame: 16 }, 30, 1, "json kick")!], "json kick"); }
    else { const [rows, fps] = pick(BROKEN_CLIPS); f.playMove(rows as number[][], fps, [{ limb: "nose" as never, from: 0, to: Number.NaN, power: 1, name: "bad" }]); }
  } else if (r < 0.0306) { did("knockOut"); someone().knockOut(); }
  else if (r < 0.0310) { did("reset"); reset(); }
  else if (r < 0.0313) { // stand one fighter right inside the other
    did("teleport");
    const f = someone(), o = world.rootPos(f.opponent.robot);
    f.spawn(o[0] + rng.range(-0.1, 0.1), o[1] + rng.range(-0.1, 0.1), rng.range(-3, 3));
  } else if (r < 0.0315) { did("nan"); world.data.qvel[Math.floor(rng.next() * world.data.qvel.length)] = Number.NaN; }
  else if (r < 0.0317) { did("huge"); world.data.qvel[Math.floor(rng.next() * world.data.qvel.length)] = 1e6; }
  else if (r < 0.0320) { did("offline"); offlineUntil = arena.time + rng.range(2, 8); arena.setMotion(null); }
  else if (r < 0.0323) { did("mode"); arena.combat.mode = arena.combat.mode === "contact" ? "rules" : "contact"; }
  else if (r < 0.0327) {
    did("brains");
    const i = pick([0, 1] as Who[]);
    arena.setBrain(i, rng.next() < 0.2 ? null : new Sparrer(arena.fighters[i], pick(styles), rng.int()));
  } else if (r < 0.0329) { did("spawnNaN"); const f = someone(); f.spawn(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN); }
  else if (r < 0.0331) { did("hangAll"); offlineUntil = arena.time + rng.range(5, 9); arena.setMotion(HANG); } // every request hangs
  else if (r < 0.0334) { did("clips"); offlineUntil = arena.time + rng.range(10, 25); arena.setMotion(new LayeredSource(CLIPS, chaos)); } // a clip library in front of the planner
  else if (r < 0.0414) { // a spell: real ones, sometimes a broken spec or clip
    did("cast");
    const sp = pick(SPELLS), f = someone(), q = rng.next();
    if (q < 0.75) f.cast(sp.spec, sp.qpos, sp.fps);
    else if (q < 0.9) f.cast(pick(BAD_SPECS), sp.qpos, sp.fps);
    else f.cast(sp.spec, pick(BROKEN_CLIPS)[0] as number[][], pick([30, 0, Number.NaN]));
  }
}

// ---------- run ----------
const t0 = performance.now();
let lastReport = 0;
while (arena.time < SECONDS) {
  if (!FIGHT) act();
  if (offlineUntil > 0 && arena.time > offlineUntil) { offlineUntil = -1; arena.setMotion(chaos); }
  const ko = arena.fighters.some((f) => f.stance === "ko");
  if (ko && koAt < 0) koAt = arena.time;
  if (!ko) koAt = -1;
  if (ko && arena.time - koAt > 3) { reset(); koAt = -1; }
  await arena.tick();
  check();
  if (arena.time - lastReport >= 30) {
    lastReport = arena.time;
    console.log(`t=${arena.time.toFixed(0)} s  ${A.name}:${A.stance} ${B.name}:${B.stance}  hp ${arena.hp.map((h) => h.toFixed(0)).join("/")}  problems ${problems.length}`);
  }
}

const wall = (performance.now() - t0) / 1000;
console.log(`\n${SECONDS} s simulated in ${wall.toFixed(0)} s wall (seed ${SEED})`);
console.log("actions ", JSON.stringify(actions), `listener pokes ${poked}`);
console.log("events  ", JSON.stringify(count));
if (chaos.counts) console.log("chaos   ", JSON.stringify(chaos.counts));
for (const f of arena.fighters) console.log(`${f.name} stats`, JSON.stringify(f.stats));
console.log("arena   ", JSON.stringify(arena.stats));
if (problems.length) {
  console.log(`\nFAILED: ${problems.length} problem(s)`);
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
console.log("\nOK: no invariant broken");
process.exit(0);
