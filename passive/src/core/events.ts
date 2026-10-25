// What the physics reports to the game layer (rules, effects, commentator).
import type { Zone } from "./body.ts";

export type Who = 0 | 1; // fighter index in the arena

export type WhiffReason = "out of range" | "dodged" | "interrupted";

export type ArenaEvent =
  // stance: the defender's stance when it landed (the reaction comes after: see the events that follow)
  | { type: "hit"; attacker: Who | null; defender: Who; name: string; zone: Zone; point: number[]; dir: number[]; impulse: number; damage: number; hp: number; blocked: boolean; counter: boolean; knockdown: boolean; stance: string }
  | { type: "whiff"; attacker: Who; name: string; reason: WhiffReason; closest: number } // closest: m it missed by (below 0: touched, too slow to hurt)
  | { type: "stagger"; who: Who; level: number }
  | { type: "knockdown"; who: Who }  // a blow put it down
  | { type: "fall"; who: Who }       // lost balance without a knockdown blow (sweep, shove, bad move)
  | { type: "down"; who: Who }       // on the floor and settled
  | { type: "getup"; who: Who; seconds: number; assisted: boolean }
  | { type: "ko"; who: Who }
  | { type: "defend"; who: Who; kind: string }
  | { type: "move"; who: Who; name: string }
  | { type: "stance"; who: Who; from: string; to: string }
  | { type: "spawn"; who: Who }       // stood up fresh (reset, failsafe, rollback respawn): nothing from before carries on
  | { type: "reset" }                 // new match: both on their marks, full HP
  | { type: "clinch"; a: Who; b: Who } // bodies pressed together; the arena pushes them apart
  | { type: "failsafe"; who: Who | null; what: string }; // something went wrong and was recovered

export type ArenaListener = (e: ArenaEvent) => void;
