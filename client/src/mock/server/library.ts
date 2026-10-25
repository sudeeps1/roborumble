// The mock server's move library: overnight-agent spells, player-made Forge moves, live wildcard templates.
// Every spec carries every CLAUDE.md "Move spec" field. Names sound like spells; kimodo_prompt stays a
// plain body description (Kimodo never sees names or effects).
import type { Effect, Kind, MoveSpec, MoveType, Source } from "../../contract";
import { MOTION_HIT_JOINT, type MockMotions, type MotionId } from "../motions";

export interface Seed {
  name: string;
  aliases: string[];
  type: MoveType;
  kind: Kind;
  effect: Effect;
  motion: MotionId;
  power: 1 | 2 | 3;
  stability: number;
  originality: number;
  prompt: string;
  uses?: number;
}

const s = (name: string, type: MoveType, kind: Kind, effect: Effect, motion: MotionId, power: 1 | 2 | 3, stability: number, originality: number, aliases: string[], prompt: string, uses = 0): Seed =>
  ({ name, type, kind, effect, motion, power, stability, originality, aliases: [name.toLowerCase(), ...aliases], prompt, uses });

// Overnight Library Builder output (source "agent"). Order matters: the keyboard maps onto the first twelve.
export const AGENT_SEEDS: Seed[] = [
  // P1 keys 1-6
  s("Bramble Bash", "physical", "melee", "thorn_burst", "mo_cross", 2, 0.82, 0.42, ["thorn punch", "briar punch"], "a person steps forward and throws a straight right punch at chest height", 214),
  s("Hearthfire Orb", "fire", "projectile", "ember_orb", "mo_throw", 2, 0.86, 0.55, ["fireball", "hearth fire"], "a person winds up and throws a ball overhand with the right arm", 388),
  s("Frostbite Crown", "ice", "strike", "frost_crystals", "mo_summon", 3, 0.7, 0.63, ["ice crown", "icicle rain"], "a person raises both arms high overhead and then pulls them down sharply", 97),
  s("Giant's Stomp", "physical", "shockwave", "shockwave", "mo_stomp", 3, 0.3, 0.58, ["giant stomp", "earthquake stomp"], "a person lifts the right knee high and stomps the foot down hard", 156),
  s("Briar Guard", "physical", "defend", "thorn_burst", "mo_block", 1, 0.95, 0.3, ["thorn shield", "block"], "a person raises both forearms in front of the face to guard", 73),
  s("Pixie Uppercut", "physical", "melee", "fairy_dust", "mo_uppercut", 3, 0.62, 0.47, ["uppercut", "fairy uppercut"], "a person dips the knees and drives a rising right uppercut", 302),
  // P2 keys U I O P [ ]
  s("Wisp Lash", "lightning", "melee", "wisp_bolt", "mo_hook", 1, 0.85, 0.51, ["lightning hook", "spark slap"], "a person swings a quick left hook at head height", 121),
  s("Will-o'-Wisp Volley", "lightning", "projectile", "wisp_bolt", "mo_palm_thrust", 2, 0.8, 0.6, ["wisp volley", "thunder palm", "lightning blast"], "a person steps forward and thrusts both palms out at chest height", 265),
  s("Stormcaller's Crash", "lightning", "strike", "wisp_bolt", "mo_overhead_slam", 2, 0.66, 0.57, ["storm crash", "thunderbolt"], "a person raises the right fist overhead and slams it down in front", 88),
  s("Moonlit Howl", "shadow", "shockwave", "moon_smoke", "mo_spin", 2, 0.55, 0.66, ["wolf howl", "moon howl"], "a person spins in place once with both arms swinging out wide", 143),
  s("Moonveil Ward", "shadow", "defend", "moon_smoke", "mo_crouch", 1, 0.9, 0.35, ["moon ward", "duck"], "a person crouches low and covers the head with both arms", 52),
  s("Nightshade Kick", "shadow", "melee", "moon_smoke", "mo_round_kick", 3, 0.5, 0.62, ["roundhouse", "shadow kick"], "a person pivots and swings a high right roundhouse kick", 199),
  // the rest of the sample
  s("Thistle Jab", "physical", "melee", "thorn_burst", "mo_jab", 1, 0.9, 0.38, ["jab", "quick punch"], "a person snaps a fast left jab forward at head height", 431),
  s("Kelpie Kick", "ice", "melee", "frost_crystals", "mo_front_kick", 2, 0.7, 0.52, ["front kick", "frost kick"], "a person lifts the right knee and snaps a front kick forward", 167),
  s("Ember Hook", "fire", "melee", "ember_orb", "mo_hook", 2, 0.8, 0.49, ["fire hook", "flaming hook"], "a person swings a wide left hook at head height", 110),
  s("Cinder Comet", "fire", "strike", "ember_orb", "mo_overhead_slam", 3, 0.6, 0.61, ["meteor", "fire rain"], "a person raises the right fist overhead and slams it down in front", 64),
  s("Icicle Volley", "ice", "projectile", "frost_crystals", "mo_throw", 1, 0.85, 0.45, ["snowball", "ice shard"], "a person winds up and throws a ball overhand with the right arm", 233),
  s("Toadstool Knee", "physical", "melee", "thorn_burst", "mo_knee", 1, 0.75, 0.44, ["knee strike", "flying knee"], "a person grabs forward with both hands and drives the right knee up", 92),
  s("Crow's Curse", "shadow", "projectile", "moon_smoke", "mo_palm_thrust", 2, 0.8, 0.59, ["dark bolt", "shadow ball"], "a person steps forward and thrusts both palms out at chest height", 140),
  s("Fairy Ring Burst", "lightning", "shockwave", "fairy_dust", "mo_stomp", 1, 0.78, 0.5, ["fairy ring", "spark stomp"], "a person lifts the right knee high and stomps the foot down hard", 81),
];

/** Each fake phone's own Forge move (signature: true when its creator shouts it). */
export const SIGNATURE_SEEDS: [Seed, Seed] = [
  s("Gorilla Smash", "physical", "melee", "thorn_burst", "mo_overhead_slam", 2, 0.55, 0.88, ["gorilla", "big smash"], "a person raises both fists overhead and smashes them down in front", 41),
  s("Moonbeam Pirouette", "shadow", "shockwave", "moon_smoke", "mo_spin", 2, 0.6, 0.9, ["moonbeam", "pirouette"], "a person spins on one foot with both arms stretched out wide", 33),
];

/** Forge moves other players made earlier (the leaderboard, and anyone may use them). */
export const FORGE_SEEDS: [string, Seed][] = [
  ["Juno", s("Grandpa's Soup Ladle", "physical", "melee", "thorn_burst", "mo_hook", 2, 0.75, 0.81, ["soup ladle", "ladle"], "a person swings the left arm in a wide scooping hook", 63)],
  ["Theo", s("Sleepy Dragon Yawn", "fire", "shockwave", "ember_orb", "mo_summon", 2, 0.7, 0.77, ["dragon yawn", "sleepy dragon"], "a person stretches both arms up overhead and then drops them out wide", 29)],
  ["Mags", s("Teacup Tornado", "lightning", "shockwave", "fairy_dust", "mo_spin", 1, 0.65, 0.84, ["teacup", "tornado"], "a person spins in place with one hand on the hip and the other arm out", 18)],
  ["Bea", s("Snow Owl Swoop", "ice", "melee", "frost_crystals", "mo_front_kick", 2, 0.72, 0.79, ["owl swoop", "snow owl"], "a person hops forward and snaps a front kick", 12)],
];

/** Live wildcards: shouts that miss the library and generate on the spot. */
export const WILDCARD_SEEDS: Seed[] = [
  s("Summon the Crab King", "physical", "melee", "thorn_burst", "mo_crab", 2, 0.6, 0.94, ["crab king"], "a person scuttles sideways with both arms raised like claws and pinches forward"),
  s("Teapot Tempest", "lightning", "shockwave", "fairy_dust", "mo_spin", 2, 0.55, 0.9, ["teapot"], "a person spins in place with one arm bent on the hip and the other arm out"),
  s("Grandmother's Broom Sweep", "physical", "melee", "thorn_burst", "mo_round_kick", 2, 0.5, 0.88, ["broom sweep"], "a person sweeps the right leg around in a wide arc"),
  s("Goose That Lays Thunder", "lightning", "strike", "wisp_bolt", "mo_summon", 3, 0.6, 0.95, ["thunder goose"], "a person flaps both arms like wings and then raises them overhead"),
  s("Cauldron Cannonball", "fire", "projectile", "ember_orb", "mo_palm_thrust", 2, 0.75, 0.9, ["cauldron"], "a person crouches and then pushes both palms forward hard"),
  s("Pumpkin Carriage Crash", "fire", "shockwave", "ember_orb", "mo_stomp", 3, 0.45, 0.92, ["pumpkin carriage"], "a person jumps up and lands stomping with both feet"),
  s("Gingerbread Avalanche", "ice", "strike", "frost_crystals", "mo_overhead_slam", 2, 0.65, 0.89, ["gingerbread"], "a person raises both fists overhead and slams them down"),
  s("Mirror Mirror Flash", "shadow", "projectile", "moon_smoke", "mo_throw", 2, 0.8, 0.87, ["mirror mirror"], "a person winds up and flings the right arm forward"),
  s("Seven-League Kick", "physical", "melee", "fairy_dust", "mo_front_kick", 3, 0.55, 0.86, ["seven league"], "a person takes a long step and snaps a front kick"),
  s("Spinning Wheel of Doom", "shadow", "shockwave", "moon_smoke", "mo_spin", 2, 0.5, 0.91, ["spinning wheel"], "a person spins twice with both arms stretched out"),
];

/** A full spec from a seed. hit_joint comes from the motion, hit_frame and duration from the baked clip. */
export function specFrom(seed: Seed, id: string, motions: MockMotions, source: Source, creator: string | null, signature = false): MoveSpec {
  const motion = motions.byId.get(seed.motion);
  const frames = motion?.qpos.length ?? 36;
  const fps = motion?.fps || 30;
  return {
    id,
    name: seed.name,
    aliases: seed.aliases.slice(),
    type: seed.type,
    kind: seed.kind,
    effect: seed.effect,
    kimodo_prompt: seed.prompt,
    hit_joint: MOTION_HIT_JOINT[seed.motion] ?? "chest",
    duration: Math.round(Math.min(1.5, Math.max(0.8, (frames - 1) / fps)) * 100) / 100,
    power: seed.power,
    stability: seed.stability,
    originality: seed.originality,
    motion_id: seed.motion,
    hit_frame: motions.hitFrame.get(seed.motion) ?? 0,
    source,
    creator,
    uses: seed.uses ?? 0,
    signature,
  };
}
