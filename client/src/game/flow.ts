// Match flow for the game screen: lobby -> best of 3 rounds (60 s each) -> match end.
// Turns room messages into sim calls. Never computes damage or physics; the sim does (CLAUDE.md).
import { CHARACTERS, DEFAULT_CHARACTERS, POLL_MS, ROUNDS_TO_WIN, ROUND_SECONDS, STATE_PUSH_MS, STATS_POLL_MS, characterById, type CharacterId } from "../config";
import type { GameEvent, LeaderboardEntry, LibraryStats, Motion, Move, MoveSpec, Player, RoomIn, Sim, SimEvent, StateMsg } from "../contract";
import type { Api } from "../net/api";
import type { Room } from "../net/room";

export type Phase = "loading" | "lobby" | "intro" | "fight" | "roundEnd" | "matchEnd";
export interface SeatState { nickname: string; character: CharacterId; connected: boolean; }
export type Seats = Record<Player, SeatState | null>;

export interface FlowHooks {
  phase(phase: Phase): void;
  seats(seats: Seats, joined: Player | null): void;
  roundStart(round: number, wins: Record<Player, number>): void;
  fightStart(): void;
  roundEnd(winner: Player | null, reason: "ko" | "time" | "sim", wins: Record<Player, number>): void;
  matchEnd(winner: Player, wins: Record<Player, number>): void;
  movePlayed(p: Player, move: MoveSpec, motion: Motion): void;
  fizzle(p: Player, why: string): void;
  charging(p: Player, guess: string | null, on: boolean): void;
  simEvent(e: SimEvent): void;
  narrate(text: string): void;
  stats(s: LibraryStats): void;
  leaderboard(l: LeaderboardEntry[]): void;
  toast(text: string): void;
}

const INTRO_MS = 1800;      // "Round N" banner before inputs count
const KO_TO_ROUND_MS = 2600; // let the real fall play out before the round ends
const ROUND_END_MS = 3000;
const JOB_TIMEOUT_MS = 30000;

export const other = (p: Player): Player => (p === 1 ? 2 : 1);

export class Flow {
  phase: Phase = "loading";
  round = 0;
  wins: Record<Player, number> = { 1: 0, 2: 0 };
  timer = ROUND_SECONDS;
  seats: Seats = { 1: null, 2: null };
  simReady = false;

  private idle: Motion | null = null;
  private simCharacters = "";
  private roundOver = false;
  private gen = 0; // bumped on every round/match change so late async work is dropped
  private lastPush = 0;
  private charging = new Map<Player, string>(); // player -> job id
  private doneJobs = new Set<string>();          // jobs already played (the push and the poll can both arrive)
  private lastTick = -1;

  constructor(private sim: Sim, private api: Api, private room: Room, private hooks: FlowHooks) {
    room.onMessage((m) => this.onRoom(m));
    sim.on((e) => this.onSim(e));
  }

  /** Load the idle motion (retrying until the server answers), warm up the sim, open the lobby. */
  async boot() {
    for (let attempt = 0; !this.idle; attempt++) {
      try {
        this.idle = await this.api.idle();
      } catch (e) {
        if (attempt % 4 === 0) this.hooks.toast(`Waiting for the server (${(e as Error).message})…`);
        await sleep(1500);
      }
    }
    await this.ensureSim();
    this.setPhase("lobby");
    this.pollStats();
    this.pollLeaderboard();
  }

  // ---------- lobby ----------
  canStart() {
    return !!(this.seats[1] && this.seats[2]);
  }

  pickCharacter(p: Player, id: CharacterId) {
    const seat = this.seats[p];
    if (!seat || this.phase !== "lobby") return;
    seat.character = id;
    this.hooks.seats(this.seats, null);
  }

  cycleCharacter(p: Player, dir: 1 | -1) {
    const seat = this.seats[p];
    if (!seat) return;
    const i = CHARACTERS.findIndex((c) => c.id === seat.character);
    this.pickCharacter(p, CHARACTERS[(i + dir + CHARACTERS.length) % CHARACTERS.length].id);
  }

  async startMatch() {
    if (this.phase !== "lobby" && this.phase !== "matchEnd") return;
    if (!this.canStart()) return this.hooks.toast("Waiting for two players to join");
    this.gen++;
    if (this.needsInit()) this.setPhase("loading");
    await this.ensureSim();
    this.wins = { 1: 0, 2: 0 };
    this.round = 0;
    this.event({ kind: "round_start", round: 1 });
    this.nextRound();
  }

  rematch() {
    if (this.phase === "matchEnd") void this.startMatch();
  }

  toLobby() {
    this.gen++;
    this.stopCharging();
    this.setPhase("lobby");
  }

  // ---------- rounds ----------
  private nextRound() {
    const gen = ++this.gen;
    this.round++;
    this.roundOver = false;
    this.timer = ROUND_SECONDS;
    this.lastTick = -1;
    this.stopCharging();
    this.sim.reset(); // contract has no per-round reset; reset() puts both fighters back at full HP
    this.setPhase("intro");
    this.hooks.roundStart(this.round, this.wins);
    if (this.round > 1) this.event({ kind: "round_start", round: this.round });
    setTimeout(() => {
      if (gen !== this.gen) return;
      this.setPhase("fight");
      this.hooks.fightStart();
    }, INTRO_MS);
  }

  private endRound(winner: Player | null, reason: "ko" | "time" | "sim") {
    if (this.roundOver || (this.phase !== "fight" && this.phase !== "intro")) return;
    this.roundOver = true;
    const gen = ++this.gen;
    if (winner) this.wins[winner]++;
    this.stopCharging();
    this.setPhase("roundEnd");
    this.hooks.roundEnd(winner, reason, this.wins);
    setTimeout(() => {
      if (gen !== this.gen) return;
      const champ = ([1, 2] as const).find((p) => this.wins[p] >= ROUNDS_TO_WIN);
      if (champ) {
        this.setPhase("matchEnd");
        this.event({ kind: "match_end", winner: champ });
        this.hooks.matchEnd(champ, this.wins);
      } else this.nextRound();
    }, ROUND_END_MS);
  }

  /** Every frame, real (unscaled) seconds. */
  update(dt: number, now: number) {
    if (this.phase === "fight" && !this.roundOver) {
      this.timer = Math.max(0, this.timer - dt);
      if (this.timer <= 0) {
        const h1 = this.sim.state(1).hp, h2 = this.sim.state(2).hp;
        this.endRound(h1 === h2 ? null : h1 > h2 ? 1 : 2, "time");
      }
    }
    if (this.simReady && this.phase !== "lobby" && this.phase !== "loading" && now - this.lastPush >= STATE_PUSH_MS) {
      this.lastPush = now;
      this.room.send(this.snapshot());
    }
  }

  /** Whole seconds left when the last-10-seconds tick should sound, else -1. */
  tickSecond(): number {
    const s = Math.ceil(this.timer);
    if (this.phase !== "fight" || s > 10 || s === this.lastTick) return -1;
    this.lastTick = s;
    return s;
  }

  // ---------- room messages ----------
  private onRoom(m: RoomIn) {
    switch (m.type) {
      case "join": {
        const p = m.player ?? ([1, 2] as const).find((q) => !this.seats[q] || !this.seats[q]!.connected);
        if (!p) return this.hooks.toast("The room is full");
        const prev = this.seats[p];
        const character = CHARACTERS.some((c) => c.id === m.character) ? (m.character as CharacterId) : prev?.character ?? DEFAULT_CHARACTERS[p];
        this.seats[p] = { nickname: (m.nickname || prev?.nickname || `Player ${p}`).slice(0, 24), character, connected: true };
        this.hooks.seats(this.seats, p);
        break;
      }
      case "leave": {
        const seat = this.seats[m.player];
        if (seat) {
          seat.connected = false;
          this.hooks.seats(this.seats, null);
        }
        break;
      }
      case "tap":
        if (this.phase === "fight" && (m.player === 1 || m.player === 2)) this.sim.action(m.player, m.action);
        break;
      case "play":
        void this.play(m.player, m.move, m.motion, m.loudness);
        break;
      case "charge":
        this.startCharging(m.player, m.job, m.guess?.name ?? null);
        break;
      case "ready": {
        const p = m.player ?? [...this.charging].find(([, job]) => job === m.job)?.[0];
        if (!p) return;
        this.finishJob(p, m.job, m.move, m.motion, m.loudness);
        break;
      }
      case "narrate":
        if (m.text) this.hooks.narrate(m.text);
        break;
    }
  }

  private async play(p: Player, spec: MoveSpec, motion?: Motion, loudness?: number) {
    if (this.phase !== "fight" || (p !== 1 && p !== 2) || !spec) return;
    const gen = this.gen;
    let mo = motion;
    try {
      mo ??= await this.api.motion(spec.motion_id);
    } catch (e) {
      this.hooks.toast(`Couldn't load the motion for ${spec.name}: ${(e as Error).message}`);
      return;
    }
    if (gen !== this.gen || this.phase !== "fight") return;
    const move = toSimMove(spec);
    const vol = clamp01(loudness ?? 0.5);
    if (!this.sim.canAct(p, move) || !this.sim.playMove(p, move, mo, vol)) {
      this.hooks.fizzle(p, this.whyNot(p, move));
      return;
    }
    this.hooks.movePlayed(p, spec, mo);
  }

  private startCharging(p: Player, job: string, guess: string | null) {
    if (this.phase !== "fight" || (p !== 1 && p !== 2)) return;
    this.charging.set(p, job);
    this.sim.setCharging(p, true);
    this.hooks.charging(p, guess, true);
    void this.pollJob(p, job, this.gen);
  }

  // The server pushes `ready`, but jobs are plain HTTP too (CLAUDE.md): poll as a backstop.
  private async pollJob(p: Player, job: string, gen: number) {
    const started = performance.now();
    while (gen === this.gen && this.charging.get(p) === job) {
      await sleep(POLL_MS);
      if (gen !== this.gen || this.charging.get(p) !== job) return;
      try {
        const r = await this.api.job(job);
        if (r.status === "done" && r.move) return this.finishJob(p, job, r.move, r.motion);
        if (r.status === "rejected") {
          this.stopCharging(p);
          return this.hooks.fizzle(p, `the spell fizzled${r.check ? ` (${r.check})` : ""}`);
        }
      } catch { /* keep waiting for the push */ }
      if (performance.now() - started > JOB_TIMEOUT_MS) {
        this.stopCharging(p);
        return this.hooks.fizzle(p, "the spell took too long");
      }
    }
  }

  private finishJob(p: Player, job: string, move?: MoveSpec, motion?: Motion, loudness?: number) {
    if (this.doneJobs.has(job)) return;
    this.doneJobs.add(job);
    if (this.charging.get(p) === job) this.stopCharging(p);
    // a `ready` for a job we never saw a `charge` for still plays: the move is what matters
    if (move) void this.play(p, move, motion, loudness);
  }

  private stopCharging(p?: Player) {
    for (const q of p ? [p] : ([1, 2] as const)) {
      if (!this.charging.has(q)) continue;
      this.charging.delete(q);
      if (this.simReady) this.sim.setCharging(q, false);
      this.hooks.charging(q, null, false);
    }
  }

  private whyNot(p: Player, move: Move): string {
    const s = this.sim.state(p);
    if (s.status === "stunned" || s.status === "down" || s.status === "ko") return "too dazed to cast";
    if (s.status === "dodging") return "mid-dodge";
    if ((s.cooldowns[move.id] ?? 0) > 0) return "still cooling down";
    if (s.status === "acting" || s.status === "charging") return "busy casting";
    return "not enough energy";
  }

  // ---------- sim events ----------
  private onSim(e: SimEvent) {
    this.hooks.simEvent(e);
    this.event(e);
    if (e.kind === "ko") {
      const gen = this.gen;
      setTimeout(() => gen === this.gen && this.endRound(other(e.loser), "ko"), KO_TO_ROUND_MS);
    } else if (e.kind === "round") {
      this.endRound(e.winner, "sim");
    }
  }

  // ---------- helpers ----------
  private chosenCharacters(): [string, string] {
    return [this.seats[1]?.character ?? DEFAULT_CHARACTERS[1], this.seats[2]?.character ?? DEFAULT_CHARACTERS[2]];
  }

  private needsInit() {
    return !this.simReady || this.chosenCharacters().join("+") !== this.simCharacters;
  }

  private async ensureSim() {
    if (!this.needsInit()) return;
    const chars = this.chosenCharacters();
    await this.sim.init(this.idle!, chars);
    this.simCharacters = chars.join("+");
    this.simReady = true;
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.hooks.phase(p);
  }

  private event(event: GameEvent) {
    this.room.send({ type: "event", event });
  }

  private snapshot(): StateMsg {
    const snap = (p: Player) => {
      const s = this.sim.state(p);
      return { hp: s.hp, energy: s.energy, cooldowns: s.cooldowns, status: s.status };
    };
    // seats: lobby character picks happen on this screen, so the server (Commentator) and phones learn them here
    const seat = (p: Player) => ({ nickname: this.seats[p]?.nickname ?? `Player ${p}`, character: this.characterOf(p).id });
    return { type: "state", round: this.round, timer: Math.ceil(this.timer), wins: { ...this.wins }, players: { 1: snap(1), 2: snap(2) }, seats: { 1: seat(1), 2: seat(2) } };
  }

  private async pollStats() {
    for (;;) {
      try { this.hooks.stats(await this.api.stats()); } catch { /* server busy; try again */ }
      await sleep(STATS_POLL_MS);
    }
  }

  private async pollLeaderboard() {
    for (;;) {
      if (this.phase === "lobby" || this.phase === "matchEnd") {
        try { this.hooks.leaderboard(await this.api.leaderboard()); } catch { /* optional endpoint */ }
      }
      await sleep(30000);
    }
  }

  characterOf(p: Player) {
    return characterById(this.seats[p]?.character ?? DEFAULT_CHARACTERS[p]);
  }
}

/** The sim's Move from a spec that may be missing optional fields. */
export function toSimMove(s: MoveSpec): Move {
  return {
    id: s.id, name: s.name, type: s.type, kind: s.kind, effect: s.effect ?? "none",
    power: (Math.min(3, Math.max(1, Math.round(s.power ?? 1))) as 1 | 2 | 3),
    stability: s.stability ?? 1, originality: s.originality ?? 0.5,
    hit_joint: s.hit_joint ?? "r_hand", hit_frame: s.hit_frame ?? 0, motion_id: s.motion_id,
    creator: s.creator ?? null, signature: !!s.signature,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5));
