// A sparring partner: throws punches and answers the other fighter's attacks, using only the
// fighter's public actions (throwPunch, defend), the way the game layer or a player would.
// For the rig (a fight with nobody at the keys) and the stress test (random but plausible play).
import type { Brain } from "./arena.ts";
import type { Defense, Fighter, PunchName } from "./fighter.ts";
import { Rng } from "./math.ts";

export interface SparStyle {
  aggression: number;                          // punches started per second while free (about)
  defense: number;                             // chance to answer an incoming attack
  reaction: [number, number];                  // s from seeing the attack to answering it
  combo: number;                               // chance a punch is followed by another at once
  counter: number;                             // chance to punch right back after defending
  defenses: Partial<Record<Defense, number>>;  // weights
  punches: Partial<Record<PunchName, number>>; // weights
}

export const STYLES: Record<"boxer" | "brawler" | "turtle", SparStyle> = {
  boxer: {
    aggression: 0.6, defense: 0.6, reaction: [0.1, 0.3], combo: 0.35, counter: 0.5,
    defenses: { block: 4, "dodge.left": 2, "dodge.right": 2, duck: 1, "dodge.back": 1 },
    punches: { "punch.leftJab": 4, "punch.rightJab": 2, "punch.leftHook": 2, "punch.rightHook": 2 },
  },
  brawler: {
    aggression: 1.1, defense: 0.25, reaction: [0.2, 0.45], combo: 0.5, counter: 0.3,
    defenses: { block: 3, "dodge.back": 1 },
    punches: { "punch.leftHook": 3, "punch.rightHook": 4, "punch.rightJab": 2, "punch.leftJab": 1 },
  },
  turtle: {
    aggression: 0.25, defense: 0.9, reaction: [0.06, 0.2], combo: 0.1, counter: 0.6,
    defenses: { block: 5, duck: 2, "dodge.left": 1, "dodge.right": 1 },
    punches: { "punch.leftJab": 3, "punch.rightJab": 1 },
  },
};

function weighted<T extends string>(rng: Rng, w: Partial<Record<T, number>>): T | null {
  const items = Object.entries(w).filter(([, v]) => (v as number) > 0) as [T, number][];
  const total = items.reduce((s, [, v]) => s + v, 0);
  if (!(total > 0)) return null;
  let r = rng.next() * total;
  for (const [k, v] of items) { if ((r -= v) <= 0) return k; }
  return items[items.length - 1][0];
}

export class Sparrer implements Brain {
  readonly me: Fighter;
  style: SparStyle;
  enabled = true;
  private rng: Rng;
  private seen = 0;   // the opponent's attackSerial already decided on
  private answer: { at: number; kind: Defense; serial: number } | null = null;
  private combo = 0;  // punches left in the current combo
  private nextAt = 0;
  private was = "idle";

  constructor(me: Fighter, style: SparStyle = STYLES.boxer, seed = 1) {
    this.me = me;
    this.style = style;
    this.rng = new Rng(seed);
  }

  think(t: number, dt: number) {
    if (!this.enabled) return;
    const me = this.me, op = me.opponent;
    const was = this.was;
    this.was = me.stance;
    if (me.stance === "ko" || op.stance === "ko") { this.answer = null; this.combo = 0; return; }

    // An attack is coming once the opponent actually throws (a punch past its step-in, or a clip):
    // decide now whether and how to answer it, and act after a human-ish reaction time.
    const throwing = op.stance === "move" && op.punchPhase() !== "approach";
    if (throwing && op.attackSerial !== this.seen) {
      this.seen = op.attackSerial;
      const kind = weighted(this.rng, this.style.defenses);
      if (kind && this.rng.next() < this.style.defense) this.answer = { at: t + this.rng.range(this.style.reaction[0], this.style.reaction[1]), kind, serial: op.attackSerial };
    }
    if (this.answer && t >= this.answer.at) {
      const a = this.answer;
      this.answer = null;
      // only if that same attack is still coming (a cancelled step-in can be dropped too)
      if (op.attackSerial === a.serial && op.stance === "move" && me.defend(a.kind)) { this.combo = 0; return; }
    }

    // after a defense, maybe punch straight back
    if (was === "defend" && me.stance === "idle" && this.rng.next() < this.style.counter) { this.combo = 1; this.nextAt = t; }

    if (me.stance !== "idle" || !op.hittable() || t < this.nextAt || this.answer) return;
    if (this.combo > 0 || this.rng.next() < this.style.aggression * dt) {
      const p = weighted(this.rng, this.style.punches);
      if (p && me.throwPunch(p, this.rng.range(0.85, 1.15))) {
        this.combo = this.combo > 0 ? this.combo - 1 : this.rng.next() < this.style.combo ? 1 + (this.rng.next() < 0.35 ? 1 : 0) : 0;
        this.nextAt = t + (this.combo > 0 ? 0 : this.rng.range(0.4, 1.2));
      }
    }
  }
}
