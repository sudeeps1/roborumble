// Summons: every spell conjures the thing it names ("Summon the Crab King" -> a crab), drawn as a big
// glowing glyph that does the attack by the spell's kind: a projectile charges at the defender, a strike
// drops onto them, a shockwave rises behind the caster, a melee spell looms and lunges, a defense stands
// guard. Timed with the cast event's hitIn so it lands on the hit. World coords are MuJoCo's (z up).
import * as THREE from "three";
import type { Arena } from "../core/arena.ts";

type Motion = "fly" | "walk" | "swim" | "float" | "spin" | "drop";
interface Look { glyph: string; motion: Motion; size: number }

// checked in order: the most visual noun first ("crab king" is a crab, not a crown)
const LEXICON: [string[], Look][] = [
  [["crab"], { glyph: "🦀", motion: "walk", size: 1.6 }],
  [["lobster"], { glyph: "🦞", motion: "walk", size: 1.6 }],
  [["kraken", "octopus", "squid", "tentacle"], { glyph: "🐙", motion: "swim", size: 2.2 }],
  [["dragon", "wyrm", "drake"], { glyph: "🐉", motion: "fly", size: 2.6 }],
  [["phoenix", "firebird"], { glyph: "🐦‍🔥", motion: "fly", size: 1.8 }],
  [["wolf", "howl", "hound", "fang"], { glyph: "🐺", motion: "walk", size: 1.6 }],
  [["bear", "grizzly"], { glyph: "🐻", motion: "walk", size: 1.9 }],
  [["fox"], { glyph: "🦊", motion: "walk", size: 1.4 }],
  [["stag", "deer", "antler", "elk"], { glyph: "🦌", motion: "walk", size: 1.9 }],
  [["unicorn"], { glyph: "🦄", motion: "walk", size: 1.9 }],
  [["horse", "steed", "stallion"], { glyph: "🐎", motion: "walk", size: 1.9 }],
  [["lion"], { glyph: "🦁", motion: "walk", size: 1.8 }],
  [["tiger"], { glyph: "🐯", motion: "walk", size: 1.8 }],
  [["cat", "kitten", "feline"], { glyph: "🐈", motion: "walk", size: 1.3 }],
  [["snake", "serpent", "viper", "cobra", "basilisk"], { glyph: "🐍", motion: "swim", size: 1.9 }],
  [["frog", "toad"], { glyph: "🐸", motion: "walk", size: 1.4 }],
  [["spider", "web"], { glyph: "🕷️", motion: "walk", size: 1.5 }],
  [["bee", "wasp", "hornet", "swarm"], { glyph: "🐝", motion: "fly", size: 1.1 }],
  [["butterfly", "moth"], { glyph: "🦋", motion: "fly", size: 1.2 }],
  [["owl"], { glyph: "🦉", motion: "fly", size: 1.4 }],
  [["eagle", "hawk", "falcon", "talon"], { glyph: "🦅", motion: "fly", size: 1.7 }],
  [["raven", "crow"], { glyph: "🐦‍⬛", motion: "fly", size: 1.4 }],
  [["bat"], { glyph: "🦇", motion: "fly", size: 1.4 }],
  [["shark"], { glyph: "🦈", motion: "swim", size: 2 }],
  [["whale"], { glyph: "🐋", motion: "swim", size: 2.6 }],
  [["fish", "carp", "eel"], { glyph: "🐟", motion: "swim", size: 1.3 }],
  [["turtle", "tortoise", "shell"], { glyph: "🐢", motion: "walk", size: 1.6 }],
  [["boar", "pig", "hog"], { glyph: "🐗", motion: "walk", size: 1.6 }],
  [["goat", "ram"], { glyph: "🐐", motion: "walk", size: 1.5 }],
  [["rabbit", "bunny", "hare"], { glyph: "🐇", motion: "walk", size: 1.2 }],
  [["mouse", "rat"], { glyph: "🐭", motion: "walk", size: 1 }],
  [["chicken", "rooster", "hen"], { glyph: "🐓", motion: "walk", size: 1.3 }],
  [["duck", "goose"], { glyph: "🦆", motion: "walk", size: 1.3 }],
  [["snail", "slug"], { glyph: "🐌", motion: "walk", size: 1.2 }],
  [["ghost", "spirit", "phantom", "specter", "wraith", "spectre"], { glyph: "👻", motion: "float", size: 1.6 }],
  [["skull", "bone", "skeleton"], { glyph: "💀", motion: "float", size: 1.4 }],
  [["giant", "troll", "ogre", "golem", "titan"], { glyph: "👹", motion: "walk", size: 2.6 }],
  [["fairy", "pixie", "sprite"], { glyph: "🧚", motion: "fly", size: 1.2 }],
  [["witch", "hag"], { glyph: "🧙‍♀️", motion: "fly", size: 1.6 }],
  [["wizard", "mage", "sorcerer"], { glyph: "🧙", motion: "float", size: 1.6 }],
  [["teapot", "kettle", "tea"], { glyph: "🫖", motion: "spin", size: 1.4 }],
  [["cup", "mug", "teacup"], { glyph: "☕", motion: "spin", size: 1.2 }],
  [["broom", "broomstick"], { glyph: "🧹", motion: "spin", size: 1.6 }],
  [["cauldron", "potion", "brew", "elixir"], { glyph: "🧪", motion: "spin", size: 1.3 }],
  [["book", "tome", "grimoire", "spellbook"], { glyph: "📖", motion: "float", size: 1.3 }],
  [["candle", "lantern"], { glyph: "🏮", motion: "float", size: 1.3 }],
  [["apple"], { glyph: "🍎", motion: "drop", size: 1.2 }],
  [["mushroom", "toadstool", "fungus", "spore"], { glyph: "🍄", motion: "drop", size: 1.5 }],
  [["anvil", "boulder", "rock", "stone", "earth", "pebble", "mountain"], { glyph: "🪨", motion: "drop", size: 1.7 }],
  [["meteor", "comet"], { glyph: "☄️", motion: "drop", size: 2 }],
  [["sword", "blade", "saber", "sabre"], { glyph: "🗡️", motion: "spin", size: 1.6 }],
  [["axe"], { glyph: "🪓", motion: "spin", size: 1.5 }],
  [["hammer", "mallet"], { glyph: "🔨", motion: "spin", size: 1.6 }],
  [["shield", "wall", "barrier", "ward", "aegis"], { glyph: "🛡️", motion: "float", size: 1.8 }],
  [["bell"], { glyph: "🔔", motion: "spin", size: 1.4 }],
  [["clock"], { glyph: "🕰️", motion: "spin", size: 1.4 }],
  [["key"], { glyph: "🗝️", motion: "spin", size: 1.3 }],
  [["crown", "king", "queen"], { glyph: "👑", motion: "spin", size: 1.3 }],
  [["tree", "oak", "willow", "treant", "forest"], { glyph: "🌳", motion: "drop", size: 2.3 }],
  [["rose", "bramble", "thorn", "briar", "vine"], { glyph: "🌹", motion: "spin", size: 1.4 }],
  [["flower", "petal", "blossom", "bloom", "lily"], { glyph: "🌸", motion: "spin", size: 1.3 }],
  [["leaf", "leaves"], { glyph: "🍃", motion: "fly", size: 1.3 }],
  [["tornado", "whirlwind", "cyclone", "gust", "wind"], { glyph: "🌪️", motion: "spin", size: 2 }],
  [["wave", "tide", "tsunami", "water"], { glyph: "🌊", motion: "swim", size: 2.2 }],
  [["moon", "lunar", "moonlit", "crescent"], { glyph: "🌙", motion: "float", size: 1.6 }],
  [["sun", "solar", "dawn"], { glyph: "☀️", motion: "spin", size: 1.8 }],
  [["star", "starfall", "celestial"], { glyph: "🌟", motion: "spin", size: 1.4 }],
  [["snow", "frost", "ice", "blizzard", "winter", "glacier", "frozen"], { glyph: "❄️", motion: "spin", size: 1.6 }],
  [["lightning", "thunder", "storm", "bolt", "spark", "volt", "shock"], { glyph: "⚡", motion: "drop", size: 1.8 }],
  [["fire", "flame", "ember", "blaze", "inferno", "burn", "fireball", "hearth"], { glyph: "🔥", motion: "fly", size: 1.6 }],
  [["fist", "punch", "uppercut", "hook", "jab", "smash", "pound"], { glyph: "👊", motion: "fly", size: 1.3 }],
  [["kick", "stomp", "tread", "foot"], { glyph: "🦶", motion: "drop", size: 1.4 }],
];
const TYPE_DEFAULT: Record<string, Look> = {
  fire: { glyph: "🔥", motion: "fly", size: 1.6 },
  ice: { glyph: "❄️", motion: "spin", size: 1.6 },
  lightning: { glyph: "⚡", motion: "drop", size: 1.8 },
  shadow: { glyph: "🌙", motion: "float", size: 1.6 },
  physical: { glyph: "👊", motion: "fly", size: 1.3 },
};
const TYPE_COLOR: Record<string, string> = { fire: "#ff7a2a", ice: "#8fdcff", lightning: "#ffe95a", shadow: "#b48cff", physical: "#9cff7a" };

/** What a spell conjures: the first lexicon noun in its name, else its type's default. */
export function summonFor(name: string, type: string): Look {
  const words = name.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).map((w) => w.replace(/'s$|s'$|'/g, ""));
  for (const [keys, look] of LEXICON) {
    if (words.some((w) => keys.some((k) => w === k || (w.length > 3 && (w === k + "s" || w === k + "es"))))) return look;
  }
  return TYPE_DEFAULT[type] ?? TYPE_DEFAULT.physical;
}

const textures = new Map<string, THREE.Texture>();
function glyphTexture(glyph: string, color: string): THREE.Texture {
  const key = glyph + color;
  let t = textures.get(key);
  if (t) return t;
  const c = Object.assign(document.createElement("canvas"), { width: 320, height: 320 });
  const g = c.getContext("2d")!;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = '200px "Apple Color Emoji","Noto Color Emoji","Segoe UI Emoji",sans-serif';
  g.shadowColor = color; g.shadowBlur = 48;
  for (let k = 0; k < 3; k++) g.fillText(glyph, 160, 170); // stacked glow
  g.shadowBlur = 0; g.fillText(glyph, 160, 170);            // the crisp creature on top
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, t);
  return t;
}

interface Live {
  sprite: THREE.Sprite; ring: THREE.Mesh; look: Look; kind: string; t: number; hitIn: number; life: number;
  from: THREE.Vector3; to: THREE.Vector3; size: number;
}

export class Summons {
  private live: Live[] = [];
  private ringTex: THREE.Texture;
  private scene: THREE.Scene;
  private arena: Arena;
  constructor(scene: THREE.Scene, arena: Arena) {
    this.scene = scene; this.arena = arena;
    const c = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const g = c.getContext("2d")!, r = g.createRadialGradient(128, 128, 60, 128, 128, 128);
    r.addColorStop(0, "rgba(255,255,255,0)"); r.addColorStop(0.75, "rgba(255,255,255,0.95)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
    this.ringTex = new THREE.CanvasTexture(c);
  }

  event(e: { type: string; [k: string]: unknown }) {
    try {
      if (e.type === "cast") this.cast(e as never);
      else if (e.type === "reset") this.clear();
    } catch (err) { console.warn("summon", err); }
  }

  private pos(i: number) { const p = this.arena.world.rootPos(this.arena.fighters[i].robot); return new THREE.Vector3(p[0], p[1], 0); }

  private cast(e: { who: number; name: string; kind: string; spellType: string; power: number; hitIn: number }) {
    const look = summonFor(e.name ?? "", e.spellType ?? "physical");
    const color = TYPE_COLOR[e.spellType] ?? "#ffffff";
    const me = this.pos(e.who), op = this.pos(1 - e.who);
    const dir = op.clone().sub(me); dir.z = 0; const d = Math.max(0.3, dir.length()); dir.divideScalar(d);
    const size = look.size * (0.75 + 0.2 * Math.min(3, Math.max(1, e.power ?? 2)));
    let from: THREE.Vector3, to: THREE.Vector3;
    switch (e.kind) {
      case "projectile": from = me.clone().addScaledVector(dir, 0.5).setZ(1.3); to = op.clone().setZ(1.1); break;
      case "strike": from = op.clone().setZ(3.2); to = op.clone().setZ(0.9); break;
      case "shockwave": from = me.clone().addScaledVector(dir, -0.7).setZ(0.2); to = from.clone().setZ(1.9); break;
      case "defend": from = me.clone().addScaledVector(dir, 0.6).setZ(0.3); to = from.clone().setZ(1.1); break;
      default: from = me.clone().addScaledVector(dir, -0.6).setZ(1.7); to = op.clone().setZ(1.2); break; // melee: loom, then lunge
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyphTexture(look.glyph, color), transparent: true, depthWrite: false, opacity: 0 }));
    sprite.position.copy(from); sprite.scale.setScalar(0.01); sprite.renderOrder = 5;
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.ringTex, color: new THREE.Color(color), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.set(e.kind === "strike" ? op.x : from.x, e.kind === "strike" ? op.y : from.y, 0.03); ring.scale.setScalar(size * 1.4);
    this.scene.add(sprite, ring);
    const hitIn = Math.max(0.25, Number.isFinite(e.hitIn) ? e.hitIn : 0.6);
    this.live.push({ sprite, ring, look, kind: e.kind, t: 0, hitIn, life: hitIn + (e.kind === "defend" ? 1.6 : 0.55), from, to, size });
    if (this.live.length > 6) this.remove(this.live[0]);
  }

  update(dt: number) {
    for (const s of [...this.live]) {
      try {
        s.t += dt;
        const { t, hitIn, life, size } = s, sm = s.sprite.material as THREE.SpriteMaterial, rm = s.ring.material as THREE.MeshBasicMaterial;
        if (t >= life) { this.remove(s); continue; }
        const grow = Math.min(1, t / 0.28), pop = grow < 1 ? 1.15 * Math.sin((grow * Math.PI) / 2) : 1; // overshoot as it appears
        const after = Math.max(0, t - hitIn), fade = after > 0 && s.kind !== "defend" ? Math.max(0, 1 - after / (life - hitIn)) : Math.min(1, (life - t) / 0.3);
        // travel: loom/rise first, arrive exactly on the hit
        const a = Math.min(1, t / hitIn);
        const e = s.kind === "melee" ? (a < 0.7 ? 0 : ((a - 0.7) / 0.3) ** 2) : s.kind === "strike" ? a * a : a * a * (3 - 2 * a);
        s.sprite.position.lerpVectors(s.from, s.to, e);
        // personality by motion
        const m = s.look.motion, w = t * 9;
        if (m === "fly") s.sprite.position.z += Math.sin(w) * 0.12;
        else if (m === "walk") { s.sprite.position.z += Math.abs(Math.sin(w)) * 0.15; sm.rotation = Math.sin(w) * 0.15; }
        else if (m === "swim") { s.sprite.position.z += Math.sin(w * 0.7) * 0.18; sm.rotation = Math.sin(w * 0.7) * 0.25; }
        else if (m === "spin") sm.rotation = t * 7;
        else if (m === "float") s.sprite.position.z += Math.sin(t * 3) * 0.1;
        const burst = after > 0 ? 1 + after * 1.6 : 1; // swells as it bursts on the target
        s.sprite.scale.setScalar(size * pop * burst);
        sm.opacity = Math.min(1, grow * 1.5) * fade;
        rm.opacity = 0.85 * Math.min(1, t / 0.2) * fade;
        s.ring.rotation.z = t * 1.5;
      } catch (err) { console.warn("summon", err); this.remove(s); }
    }
  }

  private remove(s: Live) {
    this.scene.remove(s.sprite, s.ring);
    s.sprite.material.dispose(); (s.ring.material as THREE.Material).dispose(); s.ring.geometry.dispose();
    this.live = this.live.filter((x) => x !== s);
  }
  clear() { for (const s of [...this.live]) this.remove(s); }
}
