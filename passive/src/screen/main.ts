// The fight screen (the big screen; the players' phones are the other two devices). The real sim from
// ../core (two G1s on SONIC in MuJoCo, with the referee, combat and spells) drawn as the elf and the
// knight in the arena, with a camera that has life in it, effects, the HUD and best-of-3 rounds.
// Driven by the sparring AI or the keyboard for now; phones plug in through window.__screen.
import loadMujoco from "@mujoco/mujoco";
import * as ort from "onnxruntime-web";
import elfUrl from "@elf-assets/elf.glb?url";
import frogUrl from "@elf-assets/frog.glb?url";
import knightUrl from "@elf-assets/knight.glb?url";
import sorceressUrl from "@elf-assets/sorceress.glb?url";
import wizardUrl from "@elf-assets/wizard.glb?url";
import * as THREE from "three";
import { Arena, SPAWNS } from "../core/arena.ts";
import type { ArenaEvent, Who } from "../core/events.ts";
import type { Defense, Fighter, PunchName } from "../core/fighter.ts";
import { ClipSource, LayeredSource, type MotionSource, PlannerSource } from "../core/motion.ts";
import { HttpPlanner } from "../core/planner.ts";
import { SonicPolicy } from "../core/sonic.ts";
import { STYLES, Sparrer } from "../core/spar.ts";
import { type MoveSpec, specFromLibrary } from "../core/spells.ts";
import { World } from "../core/world.ts";
import { GameFx } from "../fx/adapter.ts";
import { buildArena, buildForestArena } from "./arena.ts";
import { Director } from "./camera.ts";
import { Fx, typeColors } from "./fx.ts";
import { Hud, type SpellInfo } from "./hud.ts";
import { type GameEvent, RoomLink, type ServerMotion, type ServerMove, type ServerMsg, roomCode, rowsFromMotion, serverUrl, specFromMove } from "./link.ts";
import { portrait } from "./portrait.ts";
import { Stage } from "./stage.ts";
import { joinQr } from "./joinqr";

const params = new URLSearchParams(location.search);
const boot = document.getElementById("boot")!;
const say = (s: string) => (boot.textContent = s);

/** The two fighters. Names are invented; colours are the HUD's team colours. */
/** Every fighter (?p1=wizard&p2=frog picks; elf vs knight by default). tuck: Fighter.guardTuck. */
const CAST: Record<string, { name: string; title: string; url: string; tuck: number }> = {
  elf: { name: "Sylvara", title: "Warden of the Silverwood", url: elfUrl, tuck: 1 },
  knight: { name: "Sir Aldric", title: "The Iron Oath", url: knightUrl, tuck: 0.35 },
  sorceress: { name: "Morwenna", title: "Mistress of the Hollow Moon", url: sorceressUrl, tuck: 0.7 },
  wizard: { name: "Old Tobias", title: "Keeper of the Leaning Tower", url: wizardUrl, tuck: 0.6 },
  frog: { name: "Bramblehop", title: "Knight of the Lily Pad", url: frogUrl, tuck: 0.8 },
};
const SIDE = [{ hue: 0, color: "#e8806e" }, { hue: -2.45, color: "#7b9cf0" }];
const ROSTER = [params.get("p1") ?? "elf", params.get("p2") ?? "knight"].map((id, i) => {
  const c = id in CAST ? id : i ? "knight" : "elf";
  return { id: c, ...CAST[c], ...SIDE[i] };
});
export const RULES = { roundSeconds: 60, winsNeeded: 2, introS: 2.6, koHoldS: 3.6, victoryS: 6 };

// ---------------------------------------------------------------- the sim (as the rig boots it)
ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
say("Loading MuJoCo…");
const mj = await loadMujoco();
const robotXml = await (await fetch("/g1/g1_29dof.xml")).text();
const meshNames = [...new Set([...robotXml.matchAll(/file="([^"]+\.STL)"/g)].map((m) => m[1]))];
const meshes = new Map<string, Uint8Array>(await Promise.all(meshNames.map(async (n) => [n, new Uint8Array(await (await fetch(`/g1/meshes/${n}`)).arrayBuffer())] as [string, Uint8Array])));
const world = new World(mj, { robotXml, meshes }, SPAWNS.map(([x, y, yaw], i) => ({ prefix: `p${i + 1}_`, x, y, yaw })));
say("Loading SONIC (91 MB)…");
const ep = params.get("ep") ?? "wasm";
const policy = await SonicPolicy.load(ort as never, "/sonic/model_encoder.onnx", "/sonic/model_decoder.onnx", { executionProviders: [ep] });
const planner = new HttpPlanner();
const plannerUp = await planner.alive();
// recorded motion first: /clips, then the physics-checked Kimodo everyday library (tools/kimodo); the planner fills the rest
const clips = await ClipSource.fetch(["/clips", "/clips-everyday"]);
const sources: MotionSource[] = [];
if (clips.size) sources.push(clips);
if (plannerUp) sources.push(new PlannerSource(planner));
const arena = new Arena(world, policy, { names: [ROSTER[0].name, ROSTER[1].name] });
arena.setMotion(sources.length ? new LayeredSource(...sources) : null);
ROSTER.forEach((r, i) => (arena.fighters[i].guardTuck = r.tuck));
ROSTER.forEach((r, i) => (arena.fighters[i].character = r.id)); // each picks its own clips (guard.elf, step.forward.knight...)

// the spellbook: Kimodo spells with their specs (public/clips-kimodo/spells.json); the phones add more
say("Loading the spellbook…");
interface Spell { spec: MoveSpec; qpos: number[][]; fps: number }
const book: Spell[] = [];
try {
  const lib = await (await fetch("/clips-kimodo/spells.json")).json() as (Parameters<typeof specFromLibrary>[0] & { file: string })[];
  for (const e of lib) {
    const c = await (await fetch(`/clips-kimodo/${e.file}`)).json() as { qpos: number[][]; fps: number };
    book.push({ spec: specFromLibrary(e), qpos: c.qpos, fps: c.fps ?? 30 });
  }
} catch (e) { console.warn("no spellbook:", e); }
const known = new Map<string, MoveSpec>(book.map((s) => [s.spec.name, s.spec]));
const fresh = new Set<string>(); // spells cast for the first time ever (the HUD flags them NEW)

// ---------------------------------------------------------------- the view
say("Loading the elf and the knight…");
const stage = new Stage(document.body, world);
await stage.loadCharacters(ROSTER.map((r) => r.url), ROSTER.map((r) => r.hue));
const set = params.get("arena") === "meadow" ? buildArena(stage) : buildForestArena(stage);
const fx = new Fx(arena, set.look, (n) => known.get(n));
stage.scene.add(fx.root);
// ?fx=game: the game's spell effects (src/fx, one look per effect tag) draw the spells and hits instead;
// this screen's own effects keep the channeling aura and the dust of bodies hitting the floor
const gameFx = params.get("fx") === "game" ? new GameFx(world, ROSTER.map((r) => Number.parseInt(r.color.slice(1), 16))) : null;
if (gameFx) {
  stage.scene.add(gameFx.root);
  gameFx.track(() => arena.projectiles(), () => arena.time);
}
const director = new Director(stage.camera);
const icons = await Promise.all(ROSTER.map((r, i) => portrait(r.url, r.hue, i ? "left" : "right", i ? 0x9cb8ff : 0xffb08a)));
const hud = new Hud(document.getElementById("hud")!, ROSTER.map((r, i) => ({ name: r.name, title: r.title, color: r.color, portrait: icons[i] })));
const whiteout = Object.assign(document.createElement("div"), { className: "flashscreen" });
document.body.append(whiteout);
boot.remove();

// ---------------------------------------------------------------- drivers: sparring AI, keyboard
const brains = arena.fighters.map((f, i) => {
  const s = new Sparrer(f, STYLES[(params.get("spar")?.split(",")[i] as keyof typeof STYLES) || (i ? "brawler" : "boxer")] ?? STYLES.boxer, 11 + 17 * i);
  s.spellbook = book; // the sparring AI casts from the same book
  return s;
});
const demo = params.has("demo"); // a scripted bout (see flow): every kind of spell, both AIs off
// ?room: phones play the fighters (see "the room" below); ?fill=ai lets the AI play an empty seat
const online = params.has("room");
const fillAi = params.get("fill") === "ai";
const aiOn = online ? [fillAi, fillAi] : [params.get("ai") !== "0" && !demo, params.get("ai") !== "0" && !demo];
let brainsLive = false;
function syncBrains() { brains.forEach((b, i) => arena.setBrain(i as Who, brainsLive && aiOn[i] ? b : null)); }

/** Casts a spell from the book, or any spec with a clip. Registers it so the HUD and effects know it. */
function cast(i: Who, spec: MoveSpec, qpos: number[][], fps = 30, isNew = false) {
  known.set(spec.name, spec);
  if (isNew) fresh.add(spec.name);
  return arena.fighters[i].cast(spec, qpos, fps);
}

// ---------------------------------------------------------------- rounds
type Phase = "lobby" | "intro" | "fight" | "ko" | "over";
let phase: Phase = online ? "lobby" : "intro", phaseT = 0, clock = RULES.roundSeconds, round = 1;
const wins: [number, number] = [0, 0];
let winner: Who | null = null;
let fightShown = false;
/** Who a scripted shot (ko, victory) is on, and the other one: the camera follows them live. */
let shotOn: [Who, Who] | null = null;

function startRound() {
  for (const step of DEMO) step.done = false;
  arena.reset();
  fx.clear();
  phase = "intro"; phaseT = 0; clock = RULES.roundSeconds; winner = null; fightShown = false;
  brainsLive = false; syncBrains();
  director.cut("intro");
  shotOn = null;
  hud.wins(wins);
  hud.show(`Round ${round}`, round === 3 ? "Final round" : wins[0] + wins[1] === 0 ? `${ROSTER[0].name} vs ${ROSTER[1].name}` : "", 1.7);
  tell({ kind: "round_start", round });
}
function newMatch() { wins[0] = wins[1] = 0; round = 1; queues[0].length = queues[1].length = 0; startRound(); }
/** Online, between matches: both fighters stand in the ring until both phones are seated. */
function toLobby() {
  phase = "lobby"; phaseT = 0; clock = RULES.roundSeconds; winner = null;
  brainsLive = false; syncBrains();
  arena.reset();
  lobbyReady = false; lobbyBanner();
}
/** The lobby banner: who has joined, and once both have, how to start. No auto-start: players forge
 *  their spells on their phones first, then Enter on this screen starts the duel. */
let lobbyReady = false;
function lobbyBanner() {
  const seat = (i: Who) => (seats[i]?.connected ? `${seats[i]!.nickname} joined` : "waiting…");
  if (lobbyReady) hud.show(`${seats[0]?.nickname ?? ROSTER[0].name} vs ${seats[1]?.nickname ?? ROSTER[1].name}`,
    "Forge your spells on your phones, then press Enter to fight", 1e9);
  else hud.show(`Room ${link!.code}`, `${ROSTER[0].name}: ${seat(0)}  ·  ${ROSTER[1].name}: ${seat(1)}`, 1e9);
}

function endRound(w: Who | null, how: "ko" | "time") {
  if (phase !== "fight") return;
  phase = "ko"; phaseT = 0; winner = w;
  if (w !== null) wins[w]++;
  hud.wins(wins);
  tell({ kind: "round", winner: w === null ? null : ((w + 1) as 1 | 2) });
  brainsLive = false; syncBrains();
  if (how === "ko" && w !== null) {
    const loser = arena.fighters[1 - w];
    freeze(220);
    slowmo(0.28, 1.8);
    flash(0.9);
    director.shake(0.9);
    director.cut("ko", { at: world.rootPos(loser.robot), other: world.rootPos(arena.fighters[w].robot) });
    shotOn = [(1 - w) as Who, w];
    hud.show("K.O.", "", 2.4, "ko");
  } else hud.show("Time!", w === null ? "Draw" : `${ROSTER[w].name} wins the round`, 2.4);
}

function flow(dtSim: number, dtReal: number) {
  phaseT += dtReal;
  if (phase === "lobby") {
    // ready once both seats are filled (or one, with the AI filling the other); Enter starts the match
    const seated = seats.filter((s) => s?.connected).length;
    const ready = seated === 2 || (fillAi && seated === 1);
    if (ready !== lobbyReady) { lobbyReady = ready; lobbyBanner(); }
  } else if (phase === "intro") {
    if (phaseT > 1.8 && !fightShown) { fightShown = true; hud.show("Fight!", "", 0.9, "fight"); director.shake(0.25); }
    if (phaseT > RULES.introS) { phase = "fight"; phaseT = 0; brainsLive = true; syncBrains(); }
  } else if (phase === "fight") {
    clock -= dtSim;
    // ?koAt=8: knock the knight out 8 s into each round (to check the KO shot without waiting for one)
    const koAt = Number(params.get("koAt") ?? 0);
    if (koAt && RULES.roundSeconds - clock >= koAt && arena.fighters[1].stance !== "ko") { arena.hp[1] = 0; arena.fighters[1].knockOut(); }
    if (demo) for (const step of DEMO) if (!step.done && RULES.roundSeconds - clock >= step.at) { step.done = true; step.run(); }
    if (clock <= 0) { const [a, b] = arena.hp; endRound(a === b ? null : a > b ? 0 : 1, "time"); }
  } else if (phase === "ko") {
    if (phaseT > RULES.koHoldS) {
      if (winner !== null && wins[winner] >= RULES.winsNeeded) {
        phase = "over"; phaseT = 0;
        const w = arena.fighters[winner];
        director.cut("victory", { at: world.rootPos(w.robot), other: world.rootPos(w.opponent.robot) });
        shotOn = [winner, (1 - winner) as Who];
        hud.show(`${ROSTER[winner].name} wins`, ROSTER[winner].title, RULES.victoryS - 0.5, "victory");
        tell({ kind: "match_end", winner: (winner + 1) as 1 | 2 });
      } else { round++; startRound(); }
    }
  } else if (phase === "over" && phaseT > RULES.victoryS) {
    // a rematch while both phones are still here; otherwise wait for players
    if (online) toLobby(); else newMatch();  // back to the lobby: forge new spells between matches
  }
  hud.clock(phase === "intro" ? RULES.roundSeconds : clock, round);
}

// ---------------------------------------------------------------- game feel: hit-stop, slow motion, flashes
let freezeUntil = 0, slowUntil = 0, slowScale = 1, slowLen = 1;
function freeze(ms: number) { freezeUntil = Math.max(freezeUntil, performance.now() + ms); }
function slowmo(scale: number, seconds: number) { slowScale = scale; slowLen = seconds; slowUntil = performance.now() + seconds * 1000; }
function flash(a: number) { whiteout.style.transition = "none"; whiteout.style.opacity = String(a * 0.22); requestAnimationFrame(() => { whiteout.style.transition = "opacity .18s"; whiteout.style.opacity = "0"; }); }
const timeScale = (now: number) => {
  if (now < freezeUntil) return 0;
  if (now < slowUntil) { const k = 1 - (slowUntil - now) / (slowLen * 1000); return slowScale + (1 - slowScale) * k * k * k; } // eases back to full speed
  return 1;
};

const v3 = new THREE.Vector3();
function onScreen(p: ArrayLike<number>) {
  v3.set(p[0], p[1], p[2]).project(stage.camera);
  return { x: (v3.x * 0.5 + 0.5) * innerWidth, y: (-v3.y * 0.5 + 0.5) * innerHeight, ok: v3.z < 1 };
}

arena.on((e: ArenaEvent) => {
  if (link) publish(e);
  if (gameFx) { gameFx.event(e); if (e.type === "reset") fx.onEvent(e); } else fx.onEvent(e);
  switch (e.type) {
    case "hit": {
      hud.hp(e.defender, e.hp, arena.maxHp);
      const k = Math.min(1.6, e.impulse / 30);
      const big = !e.blocked && (e.knockdown || e.counter || e.clean || e.damage >= 12);
      freeze(e.blocked ? 45 : big ? 95 + 50 * k : 55 + 25 * k);
      director.shake(e.blocked ? 0.12 : Math.min(0.8, 0.16 + 0.32 * k + (e.knockdown ? 0.25 : 0)));
      director.kick(e.dir, e.blocked ? 0.008 : 0.02 + 0.02 * k);
      if (big) director.punch(e.point, e.knockdown ? 0.17 : 0.1);
      if (e.knockdown || e.counter) flash(e.knockdown ? 0.7 : 0.4);
      const s = onScreen(e.point);
      const tags = [e.blocked && "BLOCKED", e.counter && "COUNTER!", e.clean && "CLEAN HIT", e.knockdown && "KNOCKDOWN"].filter(Boolean) as string[];
      const col = e.spellType && e.how ? `#${typeColors(e.spellType).spark.toString(16).padStart(6, "0")}` : "#fff";
      if (s.ok && e.damage >= 0.5) hud.damage(s.x, s.y - innerHeight * 0.08, e.damage, tags, big, col); // above the hit, off the face
      return;
    }
    case "move": {
      const spec = known.get(e.name);
      if (!spec) return; // punches: the body says it
      const info: SpellInfo = { name: spec.name, type: spec.type, kind: spec.kind, power: spec.power, isNew: fresh.has(spec.name) };
      fresh.delete(spec.name);
      hud.callout(e.who, info);
      hud.channel(e.who, null);
      fx.channel(e.who, false);
      stage.chars[e.who]?.setGlow(0);
      return;
    }
    case "release":
      director.shake(e.kind === "projectile" ? 0.1 : 0.06);
      if (e.kind !== "strike") director.punch(e.point, 0.05, 0.06, 0.05, 0.3);
      return;
    case "knockdown": director.shake(0.45); return;
    case "whiff":
      if (e.reason === "dodged") { const s = onScreen(arena.fighters[1 - e.attacker].body.headPos()); if (s.ok) hud.damage(s.x, s.y - 40, 0, ["DODGED"], false); }
      return;
    case "ko": endRound((1 - e.who) as Who, "ko"); return;
    case "reset": arena.fighters.forEach((_, i) => { hud.hp(i as Who, arena.maxHp, arena.maxHp); hud.poise(i as Who, 1); }); return;
    case "spawn": stage.chars[e.who]?.resetSprings(); return;
    default: return;
  }
});
fx.onSlam = (s, at) => { director.shake(0.12 + 0.55 * s); if (s > 0.45) director.punch(at, 0.05 + 0.05 * s); };

// ---------------------------------------------------------------- status tags under the plates
const DEFENSE_LABEL: Record<string, string> = { block: "Block", duck: "Duck", "dodge.left": "Slip", "dodge.right": "Slip", "dodge.back": "Step back", jump: "Jump" };
function tagFor(f: Fighter): string | null {
  switch (f.stance) {
    case "stagger": return f.poise < 0.3 ? "Reeling" : "Staggered";
    case "falling": return null;
    case "down": return "Down!";
    case "rising": return "Getting up";
    case "ko": return "K.O.";
    case "defend": return DEFENSE_LABEL[f.defenseKind() ?? ""] ?? null;
    default: return f.poise < 0.3 ? "Dizzy" : null;
  }
}

// ---------------------------------------------------------------- the game's hooks (phones, round flow)
const P = (p: 1 | 2) => (p - 1) as Who;
const api = {
  arena, hud, director, fx, book,
  /** A player's spoken spell is being generated: the fighter glows and the screen shows their words. */
  channel(p: 1 | 2, words: string | null, type?: string) {
    const i = P(p);
    hud.channel(i, words);
    fx.channel(i, !!words, type);
    stage.chars[i]?.setGlow(words ? 1 : 0);
  },
  /** Plays a spell: spec (name, type, kind, power, hitJoint, hitFrame) and its Kimodo qpos rows. */
  cast: (p: 1 | 2, spec: MoveSpec, qpos: number[][], fps = 30, isNew = false) => cast(P(p), spec, qpos, fps, isNew),
  defend: (p: 1 | 2, kind: Defense) => arena.fighters[P(p)].defend(kind),
  punch: (p: 1 | 2, name: PunchName) => arena.fighters[P(p)].throwPunch(name),
  ai(p: 1 | 2, on: boolean) { aiOn[P(p)] = on; syncBrains(); },
  /** Freezes the fight (the camera keeps breathing): a freeze-frame, or a still to check. */
  pause(on: boolean) { paused = on; },
  newMatch,
  /** The room (null offline): its code, where phones join, who sits where, the link's status, what the narrator said. */
  get room() { return link && { code: link.code, joinUrl: link.joinUrl, status: link.status, seats, narration }; },
  get phase() { return phase; },
  /** Drops the room connection as a network blip would (it reconnects by itself): for tests. */
  dropLink() { link?.drop(); },
  /** A narrator line arrived (the server's Commentator): replace to speak or show it. */
  onNarrate(text: string) { console.info(`narrator: ${text}`); },
};
Object.assign(globalThis, { __screen: api });

// ---------------------------------------------------------------- the room: phones through the game server
// The three devices: two phones and this screen, all through the game server (link.ts). Seated phones
// play the fighters: a shouted move arrives as `play` (or `charge`, then `ready`, for a live wildcard),
// a tap as `tap`. Each fighter has a short queue (QUEUE moves): the move at its head waits up to
// MOVE_WAIT for the fighter to be free (a stagger, another move), then fizzles. A full queue drops its
// oldest library move, never a live wildcard (the move a player just invented and waited for). The screen sends its state 10/s and every event that matters to the phones and narrator.
interface SeatInfo { nickname: string; character?: string; connected: boolean }
const seats: [SeatInfo | null, SeatInfo | null] = [null, null];
const MOVE_WAIT = 2500; // ms
const QUEUE = 2;
interface Queued { spec: MoveSpec; qpos: number[][]; fps: number; isNew: boolean; until: number }
const queues: [Queued[], Queued[]] = [[], []];
const charging: { job: string; until: number }[] = [];
const TAP: Record<string, Defense> = { jump: "jump", dodge_left: "dodge.left", dodge_right: "dodge.right", block: "block" };
const narration: string[] = [];
const link: RoomLink | null = online ? new RoomLink(serverUrl(params), roomCode(params), onRoom, (s) => console.info(`room ${link?.code}: ${s}`)) : null;
if (link) console.info(`room ${link.code}: phones join at ${link.joinUrl}`);
if (link) {
  const qr = joinQr(link.joinUrl);
  setInterval(() => { qr.style.display = phase === "lobby" ? "" : "none"; }, 250);
}

function onRoom(m: ServerMsg) {
  switch (m.type) {
    case "join": {
      const i = P(m.player);
      seats[i] = { nickname: m.nickname, character: m.character, connected: true };
      aiOn[i] = false; syncBrains();
      if (phase === "lobby") lobbyBanner();
      return;
    }
    case "leave": {
      const i = P(m.player);
      if (seats[i]) seats[i]!.connected = false;
      if (fillAi) { aiOn[i] = true; syncBrains(); }
      if (phase === "lobby") lobbyBanner();
      return;
    }
    case "tap": {
      const kind = TAP[m.action];
      if (kind && phase === "fight") arena.fighters[P(m.player)].defend(kind);
      return;
    }
    case "play": return queueMove(P(m.player), m.move, m.motion, false);
    case "charge": {
      console.info(`room: player ${m.player} charging "${m.transcript ?? ""}" (job ${m.job})`);
      charging[P(m.player)] = { job: m.job, until: performance.now() + 15000 };
      api.channel(m.player, m.transcript || m.guess?.name || "…", m.guess?.type);
      return;
    }
    case "ready": {
      console.info(`room: player ${m.player} ready: ${m.move?.name} (${m.move?.source}, job ${m.job}, ${m.motion?.qpos?.length ?? 0} frames)`);
      const i = P(m.player);
      if (charging[i]?.job === m.job) { delete charging[i]; api.channel(m.player, null); }
      return queueMove(i, m.move, m.motion, m.move?.source === "live");
    }
    case "narrate":
      narration.push(m.text);
      api.onNarrate(m.text);
      return;
    default: return;
  }
}

function queueMove(i: Who, move: ServerMove, motion: ServerMotion | null, isNew: boolean) {
  const rows = rowsFromMotion(motion);
  if (!move || !rows) { tell({ kind: "fizzle", player: (i + 1) as 1 | 2, move: move?.name ?? "?", why: "no usable motion" }); return; }
  const q = queues[i];
  if (q.length >= QUEUE) {
    const k = q.findIndex((m) => !m.isNew);
    const dropped = q.splice(k >= 0 ? k : 0, 1)[0];
    tell({ kind: "fizzle", player: (i + 1) as 1 | 2, move: dropped.spec.name, why: "replaced" });
  }
  q.push({ spec: specFromMove(move), ...rows, isNew, until: q.length ? Infinity : performance.now() + MOVE_WAIT });
}

/** Every frame: moves wait for their fighter; a wildcard that never came back stops glowing. */
function serveRoom(now: number) {
  queues.forEach((q, i) => {
    const p = q[0];
    if (!p) return;
    const next = () => { q.shift(); if (q[0]) q[0].until = now + MOVE_WAIT; }; // the next move's wait starts now
    if (phase === "fight" && cast(i as Who, p.spec, p.qpos, p.fps, p.isNew)) return next();
    if (phase === "fight" && arena.fighters[i].stance === "move") p.until = Math.max(p.until, now + MOVE_WAIT); // its own move first
    if (now > p.until) { next(); tell({ kind: "fizzle", player: (i + 1) as 1 | 2, move: p.spec.name, why: phase === "fight" ? "busy" : "not fighting" }); }
  });
  charging.forEach((c, i) => { if (c && now > c.until) { delete charging[i]; api.channel((i + 1) as 1 | 2, null); } });
  if (now - stateAt >= 100) { stateAt = now; publishState(); }
}
let stateAt = 0;

function tell(event: GameEvent) { link?.send({ type: "event", event }); }

/** The sim's events, as the phones and the narrator know them (players 1 and 2). */
function publish(e: ArenaEvent) {
  switch (e.type) {
    case "hit":
      if (e.blocked) tell({ kind: "blocked", defender: (e.defender + 1) as 1 | 2, point: e.point });
      else tell({ kind: "hit", attacker: ((e.attacker ?? 1 - e.defender) + 1) as 1 | 2, defender: (e.defender + 1) as 1 | 2, damage: Math.round(e.damage * 10) / 10, type: e.spellType ?? "physical", clean: !!e.clean, point: e.point, move: e.name });
      return;
    case "whiff": if (e.reason === "dodged") tell({ kind: "dodged", defender: (2 - e.attacker) as 1 | 2 }); return;
    case "knockdown": case "fall": tell({ kind: "down", player: (e.who + 1) as 1 | 2 }); return;
    case "ko": tell({ kind: "ko", loser: (e.who + 1) as 1 | 2 }); return;
    case "move": if (known.has(e.name)) tell({ kind: "cast", player: (e.who + 1) as 1 | 2, move: e.name, new: fresh.has(e.name) }); return;
    default: return;
  }
}

const STATUS: Record<string, string> = { idle: "idle", move: "acting", stagger: "stunned", falling: "down", down: "down", rising: "down", ko: "ko" };
function publishState() {
  if (!link) return;
  const player = (i: Who) => {
    const f = arena.fighters[i];
    const status = charging[i] ? "charging" : f.stance === "defend" ? (f.defenseKind() === "block" ? "blocking" : "dodging") : STATUS[f.stance] ?? "idle";
    return { hp: Math.round(arena.hp[i] * 10) / 10, energy: 100, cooldowns: {}, status, poise: Math.round(f.poise * 100) / 100 };
  };
  const seat = (i: Who) => seats[i] && { nickname: seats[i]!.nickname, character: seats[i]!.character ?? ROSTER[i].id, connected: seats[i]!.connected };
  link.send({ type: "state", phase, round, timer: Math.max(0, Math.round(clock * 10) / 10), wins: { 1: wins[0], 2: wins[1] },
    players: { 1: player(0), 2: player(1) }, seats: { 1: seat(0), 2: seat(1) } });
}

// keyboard: P1 Q W E R spells, A jab, S hook, D block, F slip, Z a "new" spell after channeling;
// P2 U I O P spells, J jab, K hook, L block, ; slip, M the same. 1/2 AI on/off, Enter new match,
// Space pause, H hide the HUD. Using a fighter's keys turns its AI off.
const KEYS: Record<string, [Who, string]> = {
  q: [0, "s0"], w: [0, "s1"], e: [0, "s2"], r: [0, "s3"], a: [0, "punch.leftJab"], s: [0, "punch.rightHook"], d: [0, "block"], f: [0, "dodge.left"], z: [0, "new"],
  u: [1, "s0"], i: [1, "s1"], o: [1, "s2"], p: [1, "s3"], j: [1, "punch.leftJab"], k: [1, "punch.rightHook"], l: [1, "block"], ";": [1, "dodge.right"], m: [1, "new"],
};
let paused = false;
addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
  const key = ev.key.toLowerCase();
  if (key === "1" || key === "2") { const i = Number(key) - 1; aiOn[i] = !aiOn[i]; syncBrains(); return; }
  if (key === "enter") return newMatch();
  if (key === " ") { paused = !paused; ev.preventDefault(); return; }
  if (key === "h") { const h = document.getElementById("hud")!; h.hidden = !h.hidden; return; }
  const k = KEYS[key];
  if (!k || phase !== "fight") return;
  const [i, what] = k;
  if (aiOn[i]) { aiOn[i] = false; syncBrains(); }
  const f = arena.fighters[i];
  if (what.startsWith("s")) { const s = book[Number(what.slice(1))]; if (s) cast(i, s.spec, s.qpos, s.fps); }
  else if (what.startsWith("punch.")) f.throwPunch(what as PunchName);
  else if (what === "new") {
    // what a phone does: the words show while the move generates, then it lands as a brand-new spell
    const base = book.find((s) => s.spec.kind === "strike") ?? book[0];
    if (!base) return;
    api.channel((i + 1) as 1 | 2, "summon the crab king", "lightning");
    setTimeout(() => { api.channel((i + 1) as 1 | 2, null); cast(i, { ...base.spec, name: "The Thunderous Crab King of the Sunken Deep", type: "lightning", power: 3 }, base.qpos, base.fps, true); }, 1600);
  } else f.defend(what as Defense);
});

// ?demo: one spell of each kind in turn (seconds into the round), to check them all on screen
const spell = (name: string) => book.find((b) => b.spec.name === name) ?? book[0];
const castNamed = (i: Who, name: string) => { const b = spell(name); if (b) cast(i, b.spec, b.qpos, b.fps); };
const DEMO: { at: number; done: boolean; run: () => void }[] = ([
  [0.8, () => castNamed(0, "Fireball")],
  [3.6, () => castNamed(1, "Thunder Call")],
  [6.6, () => api.channel(1, "summon the crab king", "lightning")],
  [8.2, () => { api.channel(1, null); const b = spell("Thunder Call"); if (b) cast(0, { ...b.spec, name: "The Thunderous Crab King of the Sunken Deep", power: 3 }, b.qpos, b.fps, true); }],
  [11.4, () => castNamed(1, "Spiral Sphere")],
  [14.4, () => castNamed(0, "Earth Wall")],
  [14.9, () => castNamed(1, "Fireball")],
  [18, () => arena.fighters[0].throwPunch("punch.rightHook")],
] as [number, () => void][]).map(([at, run]) => ({ at, run, done: false }));

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0, busy = false;
async function physics() {
  busy = true;
  try {
    let n = 0;
    while (acc >= 0.02 && n < 3) { await arena.tick(); acc -= 0.02; n++; }
    if (n === 3) acc = Math.min(acc, 0.02); // can't keep up: run slower instead of spiraling
  } catch (e) { console.error(e); } finally { busy = false; }
}

const downish = (f: Fighter) => f.stance === "falling" || f.stance === "down" || f.stance === "rising" || f.stance === "ko";
function frame(now: number) {
  requestAnimationFrame(frame);
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  const scale = paused ? 0 : timeScale(now);
  const dt = real * scale;
  acc += dt;
  if (!busy) void physics();
  flow(dt, paused ? 0 : real);
  if (link) serveRoom(now);
  const [a, b] = arena.fighters;
  const pa = world.rootPos(a.robot), pb = world.rootPos(b.robot);
  stage.sync(dt, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
  fx.update(dt);
  gameFx?.update(real, stage.camera);
  set.update(now / 1000, dt);
  if (shotOn) director.follow(world.rootPos(arena.fighters[shotOn[0]].robot), world.rootPos(arena.fighters[shotOn[1]].robot));
  director.update(real, { pelvis: [pa, pb], down: [downish(a), downish(b)], extras: arena.projectiles().map((p) => p.pos) });
  arena.fighters.forEach((f, i) => {
    hud.hp(i as Who, arena.hp[i], arena.maxHp);
    hud.poise(i as Who, f.poise);
    hud.status(i as Who, tagFor(f));
    const s = onScreen(f.body.headPos());
    hud.anchor(i as Who, s.x, s.y - innerHeight * 0.05);
  });
  hud.update(real);
  stage.render(real);
  if (++frames === Number(params.get("readyAfter") ?? 30)) document.documentElement.dataset.ready = "1"; // for mockups/capture.mjs
}
let frames = 0;
if (online) toLobby(); else startRound();
requestAnimationFrame(frame);
