// Fairy-tale costume shells for the five characters (CLAUDE.md "Characters" / "Look and feel").
// Render-only meshes attached to G1 body groups through CostumeAnchors. They never touch physics.
// One builder per character lives in ./costume/; the Kit tracks what each adds and drives the glows.
import type { Status } from "../contract";
import type { CharacterDef, CharacterId } from "../config";
import type { CostumeAnchors } from "./robot";
import { Kit } from "./costume/kit";
import { bramble } from "./costume/bramble";
import { marigold } from "./costume/marigold";
import { flicker } from "./costume/flicker";
import { rime } from "./costume/rime";
import { hush } from "./costume/hush";

export interface Costume {
  /** Every frame. `status` is the fighter's sim status (charging, stunned, ko, ...). */
  update(t: number, dt: number, status: Status): void;
  /** 1 = runes fully lit, 0 = dark. Driven from 1 to 0 over ~1.7 s after a KO. */
  setRuneFade(k: number): void;
  /** Remove everything this costume added (character change). */
  dispose(): void;
}

/** A builder adds its pieces through the kit and may return a per-frame animation step. */
export type CostumeBuilder = (k: Kit) => ((t: number, dt: number) => void) | void;

export const COSTUME_BUILDERS: Record<CharacterId, CostumeBuilder> = { bramble, marigold, flicker, rime, hush };

export function buildCostume(def: CharacterDef, anchors: CostumeAnchors): Costume {
  const kit = new Kit(def, anchors);
  let animate: ((t: number, dt: number) => void) | void;
  try {
    animate = (COSTUME_BUILDERS[def.id] ?? bramble)(kit);
  } catch (e) {
    // a broken costume must never take the fight down: drop it and keep the bare robot
    console.error(`costume ${def.id} failed to build`, e);
    kit.dispose();
  }
  let dead = false;
  return {
    update(t, dt, status) {
      if (dead) return;
      kit.update(t, dt, status);
      if (animate) animate(t, dt);
    },
    setRuneFade(k) {
      if (!dead) kit.setFade(k);
    },
    dispose() {
      dead = true;
      kit.dispose();
    },
  };
}
