// What the game's effects (effects.ts, styles.ts) need from its config.ts, contract.ts and render/stage.ts on
// vaibhav/server, copied as is.
import type * as THREE from "three";

export type Player = 1 | 2;
export type MoveType = "physical" | "fire" | "ice" | "lightning" | "shadow";
export type Kind = "melee" | "projectile" | "strike" | "shockwave" | "defend";
export type Effect = "ember_orb" | "wisp_bolt" | "frost_crystals" | "moon_smoke" | "thorn_burst" | "fairy_dust" | "shockwave" | "earth_wall" | "spiral_orb" | "none";

export const MOVE_TYPES: MoveType[] = ["physical", "fire", "ice", "lightning", "shadow"];
export const TYPE_COLOR: Record<MoveType, number> = { physical: 0xff7aa2, fire: 0xff8a2a, ice: 0x8fe3ff, lightning: 0xfff07a, shadow: 0xa98bff };
// Effect used when a move's `effect` is missing or unknown.
export const TYPE_EFFECT: Record<MoveType, Effect> = { physical: "thorn_burst", fire: "ember_orb", ice: "frost_crystals", lightning: "wisp_bolt", shadow: "moon_smoke" };
export const KNOWN_EFFECTS: Effect[] = ["ember_orb", "wisp_bolt", "frost_crystals", "moon_smoke", "thorn_burst", "fairy_dust", "shockwave", "earth_wall", "spiral_orb", "none"];

/** The part of the game's Stage the effects use. All of it is in the effects' frame: three.js, Y up. */
export interface Stage {
  /** where the effects add their meshes */
  scene: THREE.Object3D;
  /** holds one root per fighter whose children are body groups named by MJCF body (fighters.ts) */
  world: THREE.Object3D;
  /** ribbons face this */
  camera: { position: THREE.Vector3 };
  /** screen shake: ~0.02 small hit, ~0.08 big hit; decays on its own */
  shake(amount: number): void;
}
