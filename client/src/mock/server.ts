// Fakes the FastAPI server and both phones in the browser (MOCK mode), same interfaces as src/net.
// Two fake phones (Pip, Wren) join on their own; the keyboard shouts moves and taps for them, Space lets
// them fight on their own (autoplay). Library stats tick up like the overnight agent is running, live
// wildcards charge then arrive, and game events are narrated through storybookLine().
import { MOVE_TYPES, type Action, type GameEvent, type LeaderboardEntry, type LibraryStats, type MoveSpec, type MoveType, type Player, type RoomIn, type RoomOut, type StateMsg } from "../contract";
import { characterById } from "../config";
import type { MjModel } from "../g1/mjcf";
import type { Api, JobResult } from "../net/api";
import type { Room, RoomStatus } from "../net/room";
import { storybookLine, type NarrationContext } from "../audio/narrator";
import { makeMotions } from "./motions";
import { StubSim } from "./stubSim";
import { AGENT_SEEDS, FORGE_SEEDS, SIGNATURE_SEEDS, WILDCARD_SEEDS, specFrom, type Seed } from "./server/library";

export interface MockBackend {
  api: Api;
  room: Room;
  /** Keyboard help lines shown in the lobby. */
  help: string[];
}

const PHONES: Record<Player, { nickname: string; character: string }> = { 1: { nickname: "Pip", character: "bramble" }, 2: { nickname: "Wren", character: "hush" } };
const SHOUT_KEYS: Record<Player, string[]> = {
  1: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"],
  2: ["KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight"],
};
const TAP_KEYS: Record<string, [Player, Action]> = {
  KeyW: [1, "jump"], KeyA: [1, "dodge_left"], KeyS: [1, "block"], KeyD: [1, "dodge_right"],
  ArrowUp: [2, "jump"], ArrowLeft: [2, "dodge_left"], ArrowDown: [2, "block"], ArrowRight: [2, "dodge_right"],
};
const SIGNATURE_KEYS: Record<string, Player> = { Digit7: 1, KeyY: 2 };
const WILDCARD_KEYS: Record<string, Player> = { KeyT: 1, KeyH: 2 };
const ENERGY_COST = [15, 25, 40];
const INTRO_MS = 1900;        // flow's "Round N" banner; shouts before it are ignored
const ALWAYS_NARRATE = new Set(["ko", "down", "round_start", "match_end"]);

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const clone = (m: MoveSpec): MoveSpec => ({ ...m, aliases: m.aliases?.slice() });

export function mockBackend(model: MjModel, code: string): MockBackend {
  const motions = makeMotions(model);
  const msgCbs: ((m: RoomIn) => void)[] = [];
  const statusCbs: ((s: RoomStatus) => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };
  const emit = (m: RoomIn) => msgCbs.forEach((cb) => cb(m));

  // ---------- the library ----------
  let nextId = 412;
  const newId = (prefix: string) => `${prefix}_${String(nextId++).padStart(4, "0")}`;
  const agent = AGENT_SEEDS.map((sd) => specFrom(sd, newId("mv"), motions, "agent", null));
  const keyMoves: Record<Player, MoveSpec[]> = { 1: agent.slice(0, 6), 2: agent.slice(6, 12) };
  const signatures: Record<Player, MoveSpec> = {
    1: specFrom(SIGNATURE_SEEDS[0], newId("mv"), motions, "forge", PHONES[1].nickname),
    2: specFrom(SIGNATURE_SEEDS[1], newId("mv"), motions, "forge", PHONES[2].nickname),
  };
  const playerMade: MoveSpec[] = [signatures[1], signatures[2], ...FORGE_SEEDS.map(([nick, sd]) => specFrom(sd, newId("mv"), motions, "forge", nick))];
  const stats: LibraryStats = {
    total: 1321,
    by_type: { physical: 412, fire: 231, ice: 224, lightning: 236, shadow: 218 },
    by_source: { agent: 1284, forge: 37, live: 0 },
  };
  const addToStats = (source: "agent" | "forge" | "live", type: MoveType) => {
    stats.total++;
    stats.by_source[source] = (stats.by_source[source] ?? 0) + 1;
    stats.by_type[type] = (stats.by_type[type] ?? 0) + 1;
  };
  // The overnight agent keeps adding moves, mostly to the thinnest type (CLAUDE.md: it asks for thin types).
  const agentTick = () => {
    const thin = [...MOVE_TYPES].sort((a, b) => (stats.by_type[a] ?? 0) - (stats.by_type[b] ?? 0))[0];
    addToStats("agent", Math.random() < 0.6 ? thin : pick(MOVE_TYPES));
    later(rand(15000, 30000), agentTick);
  };
  later(rand(15000, 30000), agentTick);
  const forgeTick = () => { addToStats("forge", pick(MOVE_TYPES)); later(rand(45000, 90000), forgeTick); };
  later(rand(45000, 90000), forgeTick);

  // ---------- fake phones ----------
  const seats: Record<Player, { nickname: string; character: string } | null> = { 1: null, 2: null };
  const join = (p: Player) => {
    seats[p] = { ...PHONES[p] };
    emit({ type: "join", player: p, nickname: PHONES[p].nickname, character: PHONES[p].character });
  };
  later(50, () => statusCbs.forEach((cb) => cb("open")));
  later(600, () => join(1));
  later(1100, () => join(2));

  const play = (p: Player, spec: MoveSpec, transcript?: string) => {
    spec.uses = (spec.uses ?? 0) + 1;
    const move = clone(spec);
    move.signature = spec.source === "forge" && spec.creator === seats[p]?.nickname;
    const loudness = Math.round(rand(0.4, 1) * 100) / 100;
    emit({ type: "play", player: p, move, loudness, transcript: transcript ?? `${pick(spec.aliases?.length ? spec.aliases : [spec.name.toLowerCase()])}!` });
    if (move.signature || move.source === "live" || Math.random() < 0.3) narrate({ kind: "move", player: p, move });
    autoDefend(other(p), move);
  };

  // Live wildcards: `charge` now, `ready` ~2.5 s later with a freshly minted move; /job/{id} agrees.
  const jobs = new Map<string, { player: Player; move: MoveSpec | null }>();
  const pendingJob: Record<Player, string | null> = { 1: null, 2: null };
  let jobN = 0;
  const wildcard = (p: Player) => {
    if (pendingJob[p]) return;
    const seed: Seed = pick(WILDCARD_SEEDS);
    const job = `job_${++jobN}`;
    const shout = seed.aliases[0];
    pendingJob[p] = job;
    jobs.set(job, { player: p, move: null });
    emit({ type: "charge", player: p, job, guess: { name: seed.name, type: seed.type }, transcript: `${shout}!` });
    later(rand(2200, 2900), () => {
      const power = pick([1, 2, 2, 2, 3, 3] as const);
      const fresh: Seed = { ...seed, power, stability: Math.round(rand(0.4, 0.9) * 100) / 100, originality: Math.round(rand(0.75, 0.97) * 100) / 100, uses: 0 };
      const move = specFrom(fresh, newId("mv"), motions, "live", seats[p]?.nickname ?? PHONES[p].nickname);
      move.uses = 1;
      jobs.set(job, { player: p, move });
      pendingJob[p] = null;
      playerMade.push(move);
      addToStats("live", move.type);
      // flips the job to done and pushes `ready` in the same tick, so a /job poll never beats the push
      emit({ type: "ready", player: p, job, move: clone(move), loudness: Math.round(rand(0.6, 1) * 100) / 100 });
      narrate({ kind: "move", player: p, move });
    });
  };

  const tap = (p: Player, action: Action) => emit({ type: "tap", player: p, action });

  // ---------- autoplay (Space) ----------
  let autoplay = false;
  let lastState: StateMsg | null = null;
  let lastStateAt = 0;
  let fightFrom = Infinity; // ms timestamp when shouts start counting
  const nextAct: Record<Player, number> = { 1: 0, 2: 0 };
  const badge = autoplayBadge();
  const fighting = () => performance.now() - lastStateAt < 500 && performance.now() >= fightFrom;
  const affordable = (p: Player, m: MoveSpec) => {
    const s = lastState?.players[p];
    return !s || (s.energy >= ENERGY_COST[m.power - 1] && !((s.cooldowns[m.id] ?? 0) > 0));
  };
  const statusOf = (p: Player) => lastState?.players[p]?.status;
  const free = (p: Player) => {
    const st = statusOf(p);
    return !st || st === "idle" || st === "blocking";
  };
  const autoAct = (p: Player) => {
    if (!free(p)) return;
    const foe = statusOf(other(p));
    const r = Math.random();
    // nobody swings at a fighter lying in the clover: gather a wildcard or wait
    if (foe === "down" || foe === "ko") return void (r < 0.3 && !pendingJob[p] && foe === "down" && wildcard(p));
    if (r < 0.08) return tap(p, pick(["jump", "dodge_left", "dodge_right", "block"] as const));
    if (r < 0.15 && !pendingJob[p]) return wildcard(p);
    if (r < 0.25 && affordable(p, signatures[p])) return play(p, signatures[p]);
    const pool = r < 0.33 ? playerMade.filter((m) => m !== signatures[1] && m !== signatures[2]) : r < 0.85 ? keyMoves[p] : agent;
    const options = pool.filter((m) => affordable(p, m) && m.kind !== "defend");
    if (options.length) play(p, pick(options));
  };
  // The other phone often reacts to an incoming attack, timed to the impact: block, a defend spell, dodge,
  // or jump a shockwave. It holds its own next shout until the attack is over.
  const autoDefend = (d: Player, m: MoveSpec) => {
    if (!autoplay || m.kind === "defend" || !free(d) || Math.random() > 0.5) return;
    const hit = (m.hit_frame || 15) / 30;
    const impact = hit + (m.kind === "projectile" ? 0.16 : m.kind === "strike" ? 0.6 : 0);
    nextAct[d] = Math.max(nextAct[d], performance.now() + (impact + 0.5) * 1000);
    const r = Math.random();
    const ward = keyMoves[d].find((x) => x.kind === "defend" && affordable(d, x));
    if (m.kind === "shockwave" && r < 0.35) later(Math.max(0, impact - 0.15) * 1000, () => tap(d, "jump"));
    else if (r < 0.15 && ward) later(Math.max(0.05, impact - 0.35) * 1000, () => play(d, ward));
    else if (r < 0.6) later(Math.max(0.05, impact - rand(0.15, 0.45)) * 1000, () => tap(d, "block"));
    else later(Math.max(0.05, impact - rand(0.05, 0.3)) * 1000, () => tap(d, Math.random() < 0.5 ? "dodge_left" : "dodge_right"));
  };
  const autoTimer = setInterval(() => {
    if (!autoplay || !fighting()) return;
    const now = performance.now();
    for (const p of [1, 2] as const) {
      if (now < nextAct[p]) continue;
      nextAct[p] = now + rand(1400, 3000);
      autoAct(p);
    }
  }, 100);

  // ---------- keyboard ----------
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const c = e.code;
    if (c === "Enter" || c === "Escape" || c === "KeyM") return; // main.ts owns these
    if (c === "Space") {
      e.preventDefault();
      autoplay = !autoplay;
      nextAct[1] = performance.now() + 300;
      nextAct[2] = performance.now() + 1000;
      badge.show(autoplay);
      return;
    }
    for (const p of [1, 2] as const) {
      const i = SHOUT_KEYS[p].indexOf(c);
      if (i >= 0) return play(p, keyMoves[p][i]);
    }
    if (c in SIGNATURE_KEYS) return play(SIGNATURE_KEYS[c], signatures[SIGNATURE_KEYS[c]]);
    if (c in WILDCARD_KEYS) return wildcard(WILDCARD_KEYS[c]);
    const t = TAP_KEYS[c];
    if (t) {
      if (c.startsWith("Arrow")) e.preventDefault();
      tap(t[0], t[1]);
    }
  };
  addEventListener("keydown", onKey);

  // ---------- narration (the server-side Commentator, offline) ----------
  let pending: { text: string; big: boolean } | null = null; // a line waiting out its "server" latency
  const context = (): NarrationContext => {
    // Characters are picked in the game screen's lobby: the game's `state` push carries them (like the real
    // server would see). Before the first push, StubSim's init() knows them; else the join-time picks.
    const chars = lastState?.seats
      ? [lastState.seats[1].character, lastState.seats[2].character]
      : StubSim.lastCharacters ?? [seats[1]?.character ?? PHONES[1].character, seats[2]?.character ?? PHONES[2].character];
    const c1 = characterById(chars[0]), c2 = characterById(chars[1]);
    return {
      names: { 1: c1.name, 2: c2.name },
      titles: { 1: c1.title, 2: c2.title },
      nicknames: { 1: seats[1]?.nickname ?? "Player 1", 2: seats[2]?.nickname ?? "Player 2" },
    };
  };
  const narrate = (e: GameEvent | { kind: "move"; player: Player; move: MoveSpec }) => {
    let text: string | null = null;
    try { text = storybookLine(e, context()); } catch (err) { console.warn("mock: storybookLine failed", err); }
    if (!text) return; // storybookLine paces itself (quiet after big moments, always speaks for the must-say ones)
    const big = ALWAYS_NARRATE.has(e.kind);
    if (pending) { // a KO arriving with its hit replaces the hit's line instead of talking over it
      if (big || !pending.big) pending = { text, big };
      return;
    }
    pending = { text, big };
    later(250, () => { // a beat of "server" latency
      const line = pending;
      pending = null;
      if (line) emit({ type: "narrate", text: line.text });
    });
  };
  const onEvent = (e: GameEvent) => {
    if (e.kind === "round_start") {
      fightFrom = performance.now() + INTRO_MS;
      nextAct[1] = fightFrom + rand(900, 1500); // after the "Fight!" banner, and not both on the same frame
      nextAct[2] = fightFrom + rand(1300, 2200);
    } else if (e.kind === "ko" || e.kind === "match_end") fightFrom = Infinity;
    narrate(e);
  };

  // ---------- the interfaces ----------
  const api: Api = {
    idle: async () => motions.idle,
    motion: async (id) => {
      const m = motions.byId.get(id);
      if (!m) throw new Error(`mock: unknown motion ${id}`);
      return m;
    },
    stats: async () => structuredClone(stats),
    leaderboard: async (): Promise<LeaderboardEntry[]> =>
      playerMade
        .filter((m) => m.creator)
        .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))
        .slice(0, 8)
        .map((m) => ({ id: m.id, name: m.name, creator: m.creator!, uses: m.uses ?? 0, type: m.type })),
    job: async (id): Promise<JobResult> => {
      const j = jobs.get(id);
      if (!j) throw new Error(`mock: unknown job ${id}`);
      return j.move ? { status: "done", move: clone(j.move) } : { status: "running" };
    },
  };

  const room: Room = {
    code,
    onMessage: (cb) => void msgCbs.push(cb),
    onStatus: (cb) => void statusCbs.push(cb),
    send: (m: RoomOut) => {
      if (m.type === "state") {
        lastState = m;
        lastStateAt = performance.now();
      } else if (m.type === "event") onEvent(m.event);
    },
    close: () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      clearInterval(autoTimer);
      removeEventListener("keydown", onKey);
      badge.remove();
      statusCbs.forEach((cb) => cb("closed"));
    },
  };

  return {
    api,
    room,
    // The lobby's help box fits about three short lines. W/↑ jump, A D/← → dodge, S/↓ block.
    help: [
      "Mock phones · Space: autoplay",
      "Pip: 1-6, 7 own, T wild, WASD",
      "Wren: UIOP [ ], Y own, H wild, arrows",
    ],
  };
}

const other = (p: Player): Player => (p === 1 ? 2 : 1);

/** Small pill in the corner while autoplay is on (mock mode only). */
function autoplayBadge() {
  let el: HTMLDivElement | null = null;
  return {
    show(on: boolean) {
      if (!el) {
        el = document.createElement("div");
        el.textContent = "Autoplay · Space to stop";
        el.style.cssText = "position:fixed;left:14px;bottom:12px;z-index:60;pointer-events:none;padding:4px 12px;border-radius:999px;"
          + "font:600 12px Cinzel,Georgia,serif;letter-spacing:.08em;color:#f3e6c4;background:rgba(24,18,10,.72);border:1px solid rgba(201,162,74,.8);"
          + "box-shadow:0 0 12px rgba(201,162,74,.35);transition:opacity .25s;opacity:0";
        document.body.appendChild(el);
      }
      el.style.opacity = on ? "1" : "0";
    },
    remove() {
      el?.remove();
      el = null;
    },
  };
}
