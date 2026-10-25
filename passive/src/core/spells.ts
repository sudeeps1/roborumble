// Spells and other server moves: what kind of move it is decides how its hit lands. The rules match
// the game screen's stub sim (client/src/mock/sim/rules.ts on vaibhav/server), so the physics produces
// the same outcomes the game expects:
//   melee      steps in, then lands at the hit frame if the pelvises are within meleeRange
//   projectile leaves the hit joint at the hit frame and flies at projectileSpeed toward the chest;
//              it lands unless the defender dodges out of its path
//   strike     called down at the hit frame, lands strikeDelay later where the defender stood when the
//              move started (they must still be within strikeRadius)
//   shockwave  hits everything within shockwaveRadius at the hit frame; a jump clears it
//   defend     the caster blocks for the whole move (Earth Wall)
// Dodges beat everything aimed at the dodging zone, blocks take blockMult of the damage.
import { LIMBS, type Limb } from "./body.ts";

export type MoveKind = "melee" | "projectile" | "strike" | "shockwave" | "defend";
export const MOVE_KINDS: readonly MoveKind[] = ["melee", "projectile", "strike", "shockwave", "defend"];

/** A move from the server or the spell library: what it is and when it hits. */
export interface MoveSpec {
  name: string;
  kind: MoveKind;
  /** physical, fire, ice, lightning, shadow: for effects and the game's type rules */
  type?: string;
  /** which visual effect the game screen draws (ember_orb, wisp_bolt, earth_wall, spiral_orb, ...) */
  effect?: string;
  /** 1..3 */
  power?: number;
  /** where a melee hit or a projectile comes from (default r_hand) */
  hitJoint?: Limb;
  /** frame of the clip (at its fps) where it hits; default 45% of the way through */
  hitFrame?: number;
  stability?: number;
}

export const SPELL = {
  meleeGap: 0.75,        // m pelvis to pelvis to step in to before a melee move
  meleeRange: 1.0,       // m pelvis to pelvis at the hit frame for a melee move to land
  cleanDist: 0.3,        // m: a melee hit joint this close to the head or chest is a clean hit
  projectileSpeed: 6,    // m/s
  arriveR: 0.12,         // m: a projectile lands this close to its aim point
  dodgeClear: 0.3,       // m: the chest this far from the aim point means the defender slipped it
  projectileLife: 3,     // s
  strikeDelay: 0.6,      // s after the hit frame
  strikeRadius: 0.5,     // m from where the defender stood when the move started
  shockwaveRadius: 1.5,  // m pelvis to pelvis
  knockdownDamage: 16,   // a hit this big knocks down (or a clean power-3 hit)
  launch: 4.5,           // N s per point of damage a knockdown throws its target with (back and up: about 1.4 m for 20)
  launchLift: 0.35,      // upward part of a launch's push (a strike from above folds its target instead)
  blockMult: 0.3,
  cleanMult: 1.25,
};

/** Damage before blocking, by kind and power (1, 2, 3). */
export const BASE_DAMAGE: Record<Exclude<MoveKind, "defend">, [number, number, number]> = {
  melee: [8, 12, 16],
  projectile: [6, 10, 14],
  strike: [7, 11, 15],
  shockwave: [5, 8, 11],
};

export function spellDamage(kind: MoveKind, power: number, clean: boolean): number {
  if (kind === "defend") return 0;
  const tier = Math.min(3, Math.max(1, Math.round(Number.isFinite(power) ? power : 2))) - 1;
  return BASE_DAMAGE[kind][tier] * (clean ? SPELL.cleanMult : 1);
}

/** A checked copy of a spec (sane defaults, unknown fields dropped), or null if it can't be a move. */
export function checkSpec(s: MoveSpec | null | undefined): Required<Omit<MoveSpec, "stability">> & { stability: number } | null {
  if (!s || typeof s !== "object" || !MOVE_KINDS.includes(s.kind)) return null;
  const power = Number.isFinite(s.power) ? Math.min(3, Math.max(1, Math.round(s.power!))) : 2;
  return {
    name: String(s.name ?? s.kind),
    kind: s.kind,
    type: String(s.type ?? "physical"),
    effect: String(s.effect ?? "none"),
    power,
    hitJoint: LIMBS.includes(s.hitJoint as Limb) ? (s.hitJoint as Limb) : "r_hand",
    hitFrame: Number.isFinite(s.hitFrame) && s.hitFrame! >= 0 ? s.hitFrame! : -1,
    stability: Number.isFinite(s.stability) ? s.stability! : 1,
  };
}

/** The spell library's spells.json entry -> a MoveSpec. */
export function specFromLibrary(e: { name?: string; kind?: string; type?: string; effect?: string; power?: number; hit_joint?: string; hit_frame?: number; stability?: number }): MoveSpec {
  return { name: e.name ?? "spell", kind: e.kind as MoveKind, type: e.type, effect: e.effect, power: e.power, hitJoint: e.hit_joint as Limb, hitFrame: e.hit_frame, stability: e.stability };
}
