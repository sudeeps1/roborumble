// Fight rules for the stub sim, straight from CLAUDE.md "Physics", "Damage and resources" and "Characters".
// The real sim (src/sim) owns these for real; this copy only has to produce the same event stream.
import type { Kind, Move, MoveType } from "../../contract";

export const HP_MAX = 100;
export const ENERGY_MAX = 100;
export const ENERGY_REFILL = 12;       // per second
export const STUN_S = 0.3;
export const BLOCK_MULT = 0.3;
export const BLOCK_S = 0.6;            // a block tap holds the guard this long
export const DODGE_S = 0.4;            // invulnerable
export const DODGE_COOLDOWN = 1.5;
export const DODGE_SLIDE = 0.35;       // m, toward the fighter's left/right
export const JUMP_S = 0.45;
export const CLEAN_MULT = 1.25;
export const CLEAN_DIST = 0.3;         // hit joint within this of the defender's head or chest = "contact"
export const MELEE_GAP = 0.75;         // pelvis to pelvis after stepping in
export const MELEE_RANGE = 1.0;        // melee lands when the pelvises are this close at hit_frame
export const PROJECTILE_SPEED = 6;     // m/s
export const STRIKE_DELAY = 0.6;       // s after hit_frame
export const STRIKE_RADIUS = 0.5;      // the defender must still be this close to where they stood at cast time
export const SHOCKWAVE_RADIUS = 1.5;
export const ROOT_TRAVEL_MAX = 0.3;    // a motion's own root travel is clipped to this
export const KNOCKDOWN_DAMAGE = 16;    // stub rule: one hit this big (or a clean power-3 hit, or a signature) knocks down
export const DOWN_S = 2;               // CLAUDE.md: pelvis below 0.4 m for 2 s
export const DOWN_PELVIS_Z = 0.4;
export const KO_TO_ROUND_S = 2;        // `round` follows `ko` after this
export const SELF_TIP_STABILITY = 0.35; // stub rule: a power-3 move below this stability tips its own caster over

const BASE: Record<Exclude<Kind, "defend">, [number, number, number]> = {
  melee: [8, 12, 16],
  projectile: [6, 10, 14],
  strike: [7, 11, 15],
  shockwave: [5, 8, 11],
};
const ENERGY_COST = [15, 25, 40];
const COOLDOWN = [0.9, 1.3, 1.7];

export interface CharacterRules { strong: MoveType; feeble: MoveType; weakTo: MoveType; cooldown: number; }

// Deals 2x / deals 0.5x / takes 1.5x from, per CLAUDE.md "Characters". Ids match config.CHARACTERS.
export const CHARACTER_RULES: Record<string, CharacterRules> = {
  bramble: { strong: "physical", feeble: "fire", weakTo: "shadow", cooldown: 1 },
  marigold: { strong: "fire", feeble: "physical", weakTo: "ice", cooldown: 1 },
  flicker: { strong: "lightning", feeble: "ice", weakTo: "physical", cooldown: 0.8 },
  rime: { strong: "ice", feeble: "lightning", weakTo: "fire", cooldown: 1 },
  hush: { strong: "shadow", feeble: "physical", weakTo: "lightning", cooldown: 1 },
};
export const rulesFor = (id: string): CharacterRules => CHARACTER_RULES[id] ?? CHARACTER_RULES.bramble;

const tier = (power: number) => Math.min(3, Math.max(1, Math.round(power || 1))) - 1;
export const energyCost = (m: Move) => ENERGY_COST[tier(m.power)];
export const cooldownFor = (m: Move, c: CharacterRules) => COOLDOWN[tier(m.power)] * c.cooldown;

/**
 * damage = base x type_mult(attacker) x weak_mult(defender) x (0.75 + 0.5 x originality)
 *          x signature x (0.8 + 0.4 x loudness), then x1.25 clean, x0.3 blocked. Rounded, at least 1.
 */
export function damageFor(m: Move, atk: CharacterRules, def: CharacterRules, loudness: number, clean: boolean, blocked: boolean): number {
  if (m.kind === "defend") return 0;
  const base = BASE[m.kind]?.[tier(m.power)] ?? 8;
  const typeMult = m.type === atk.strong ? 2 : m.type === atk.feeble ? 0.5 : 1;
  const weakMult = m.type === def.weakTo ? 1.5 : 1;
  const orig = 0.75 + 0.5 * clamp01(m.originality);
  const sig = m.signature ? 1.5 : 1;
  const loud = 0.8 + 0.4 * clamp01(loudness);
  const d = base * typeMult * weakMult * orig * sig * loud * (clean ? CLEAN_MULT : 1) * (blocked ? BLOCK_MULT : 1);
  return Math.max(1, Math.round(d));
}

export const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);
