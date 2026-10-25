// Local copy of the contract until contract/ exists. When contract/sim.ts lands, import from it instead.
//
// Part 1 is contract/sim.ts copied verbatim from CLAUDE.md.
// Part 2 (HTTP + room messages) is OUR ASSUMPTION of contract/api.md and contract/ws.md, which aren't
// written yet. Everything assumed is marked ASSUMED; src/net/ is the only place that parses it.

// ---------- Part 1: contract/sim.ts (from CLAUDE.md) ----------
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Player = 1 | 2;
export type MoveType = "physical" | "fire" | "ice" | "lightning" | "shadow";
export type Kind = "melee" | "projectile" | "strike" | "shockwave" | "defend";
export type Action = "jump" | "dodge_left" | "dodge_right" | "block";

export interface Motion { id: string; fps: number; joint_names: string[]; qpos: number[][]; }
export interface Move {
  id: string; name: string; type: MoveType; kind: Kind; effect: string;
  power: 1 | 2 | 3; stability: number; originality: number;
  hit_joint: string; hit_frame: number; motion_id: string;
  creator: string | null; signature: boolean;
}
export interface FighterState {
  bodies: { name: string; pos: Vec3; quat: Quat }[];  // world space, ready to draw
  hp: number; energy: number; cooldowns: Record<string, number>;
  status: "idle" | "charging" | "acting" | "blocking" | "dodging" | "stunned" | "down" | "ko";
}
export type SimEvent =
  | { kind: "hit"; attacker: Player; damage: number; type: MoveType; clean: boolean; point: Vec3 }
  | { kind: "blocked"; defender: Player; point: Vec3 }
  | { kind: "dodged"; defender: Player }
  | { kind: "down"; player: Player }
  | { kind: "ko"; loser: Player }
  | { kind: "round"; winner: Player };

export interface Sim {
  init(idle: Motion, characters: [string, string]): Promise<void>;
  canAct(p: Player, move?: Move): boolean;       // status, cooldown, energy
  setCharging(p: Player, on: boolean): void;
  playMove(p: Player, move: Move, motion: Motion, loudness: number): boolean;
  action(p: Player, a: Action): boolean;
  step(dt: number): void;                        // every animation frame
  state(p: Player): FighterState;
  projectiles(): { pos: Vec3; type: MoveType; effect: string; owner: Player }[];
  on(cb: (e: SimEvent) => void): void;
  reset(): void;                                 // new match
}

// ---------- Part 2: HTTP + room messages (ASSUMED) ----------
export type Status = FighterState["status"];
export type Source = "agent" | "forge" | "live";
export type Effect = "ember_orb" | "wisp_bolt" | "frost_crystals" | "moon_smoke" | "thorn_burst" | "fairy_dust" | "shockwave" | "none";
export const MOVE_TYPES: MoveType[] = ["physical", "fire", "ice", "lightning", "shadow"];

// The full move spec from CLAUDE.md. `play` may carry these extra fields alongside the sim's Move.
export interface MoveSpec extends Move {
  aliases?: string[];
  kimodo_prompt?: string;
  duration?: number;
  source?: Source;
  uses?: number;
}

// GET /library/stats (ASSUMED key names; net/api.ts tolerates a few spellings)
export interface LibraryStats { total: number; by_type: Partial<Record<MoveType, number>>; by_source: Partial<Record<Source, number>>; }
// GET /leaderboard (ASSUMED)
export interface LeaderboardEntry { id: string; name: string; creator: string; uses: number; type?: MoveType; }

// Room messages. All JSON objects with a `type` field. (ASSUMED until contract/ws.md)
// phone -> game, relayed by the server:
export interface JoinMsg { type: "join"; player?: Player; nickname?: string; character?: string; }
export interface TapMsg { type: "tap"; player: Player; action: Action; }
// server -> game:
export interface PlayMsg { type: "play"; player: Player; move: MoveSpec; loudness?: number; motion?: Motion; transcript?: string; }
export interface ChargeMsg { type: "charge"; player: Player; job: string; guess?: { name: string; type?: MoveType } | null; transcript?: string; }
export interface ReadyMsg { type: "ready"; player?: Player; job: string; move?: MoveSpec; motion?: Motion; loudness?: number; }
export interface NarrateMsg { type: "narrate"; text: string; } // NOT in CLAUDE.md: Commentator lines need a way to reach the game screen
export interface LeaveMsg { type: "leave"; player: Player; }
export type RoomIn = JoinMsg | TapMsg | PlayMsg | ChargeMsg | ReadyMsg | NarrateMsg | LeaveMsg;
// game -> phones, relayed by the server:
export interface PlayerSnapshot { hp: number; energy: number; cooldowns: Record<string, number>; status: Status; }
export interface StateMsg {
  type: "state"; round: number; timer: number; wins: Record<Player, number>; players: Record<Player, PlayerSnapshot>;
  seats: Record<Player, { nickname: string; character: string }>; // characters are picked on the game screen's lobby
}
export type GameEvent = SimEvent | { kind: "round_start"; round: number } | { kind: "match_end"; winner: Player };
export interface EventMsg { type: "event"; event: GameEvent; }
export type RoomOut = StateMsg | EventMsg;
