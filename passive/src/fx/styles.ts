// Copied from client/src/render/fx/styles.ts on vaibhav/server (ba9d58b). Changed: imports, no constructor
// parameter properties (this package compiles with erasableSyntaxOnly).
// The look of each fairy-tale flavor: palettes, impact bursts, flight trails and projectile heads.
// Fire is a hearth-fire orb trailing embers, ice is frost crystals, lightning is crackling wisp-light,
// shadow is moonlit smoke, physical is thorns and petals, fairy_dust is glitter (CLAUDE.md "Look and feel").
import * as THREE from "three";
import { TYPE_COLOR, type MoveType } from "./config.ts";
import { SPR } from "./textures.ts";
import { F_FLUTTER, F_FRAME, F_GROUND, F_TWINKLE, type Particles, type PSpec } from "./particles.ts";
import type { Ribbons } from "./ribbons.ts";

export type Flavor = "ember" | "wisp" | "frost" | "smoke" | "thorn" | "fairy";
/**
 * Linear HDR colors: core blooms white-hot, glow is the body color, accent is the secondary material.
 * rune is glow normalized to the same brightness for every flavor (rune circles, rings, walls, shields).
 */
export interface Pal { core: THREE.Color; glow: THREE.Color; accent: THREE.Color; light: THREE.Color; rune: THREE.Color; }

const EFFECT_FLAVOR: Record<string, Flavor> = {
  ember_orb: "ember", wisp_bolt: "wisp", frost_crystals: "frost", moon_smoke: "smoke", thorn_burst: "thorn", fairy_dust: "fairy",
};
export const TYPE_FLAVOR: Record<MoveType, Flavor> = { physical: "thorn", fire: "ember", ice: "frost", lightning: "wisp", shadow: "smoke" };

/** Particle flavor for an effect tag. shockwave, none and unknown tags take the move type's flavor. */
export function flavorOf(effect: string, type: MoveType): Flavor {
  return EFFECT_FLAVOR[effect] ?? TYPE_FLAVOR[type] ?? "fairy";
}

const pals = new Map<string, Pal>();
export function palette(fl: Flavor, type: MoveType): Pal {
  const key = fl === "fairy" ? `fairy:${type}` : fl;
  let p = pals.get(key);
  if (!p) {
    const q = makePal(fl, type);
    const g = q.glow, m = Math.max(g.r, g.g, g.b) || 1;
    p = { ...q, rune: g.clone().multiplyScalar(1.5 / m) };
    pals.set(key, p);
  }
  return p;
}

/** Type color in linear HDR, for things that should read as the move's type (rings, shields). */
export function typeGlow(type: MoveType, k = 2.2): THREE.Color {
  return new THREE.Color(TYPE_COLOR[type] ?? 0xffffff).multiplyScalar(k);
}

function makePal(fl: Flavor, type: MoveType): Omit<Pal, "rune"> {
  const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
  switch (fl) {
    case "ember": return { core: C(4.6, 2.5, 0.85), glow: C(2.7, 0.75, 0.1), accent: C(1.3, 0.16, 0.03), light: new THREE.Color(0xff9a40) };
    case "wisp": return { core: C(4.2, 4.1, 3.2), glow: C(2.6, 2.25, 0.55), accent: C(1.3, 1.8, 3.4), light: new THREE.Color(0xfff2b0) };
    case "frost": return { core: C(3.0, 3.9, 4.6), glow: C(0.6, 1.8, 3.1), accent: C(1.8, 2.6, 3.3), light: new THREE.Color(0xa8ecff) };
    case "smoke": return { core: C(3.0, 2.8, 4.0), glow: C(1.15, 0.5, 2.6), accent: C(0.38, 0.3, 0.62), light: new THREE.Color(0xb48cff) };
    case "thorn": return { core: C(3.9, 2.3, 2.7), glow: C(2.7, 0.5, 1.05), accent: C(0.5, 1.25, 0.35), light: new THREE.Color(0xff8ab0) };
    case "fairy": return { core: C(3.9, 3.5, 2.5), glow: typeGlow(type, 2.4), accent: C(2.9, 2.1, 0.75), light: new THREE.Color(TYPE_COLOR[type] ?? 0xffffff) };
  }
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

const PINK = new THREE.Color(1.35, 0.55, 0.78), PINK_END = new THREE.Color(0.95, 0.32, 0.52);
const THORN = new THREE.Color(1.8, 0.36, 0.62), THORN_END = new THREE.Color(0.5, 0.1, 0.2);
const MIST = new THREE.Color(0.75, 1.0, 1.3), MIST_END = new THREE.Color(0.22, 0.42, 0.8);
const ICE = new THREE.Color(1.1, 1.65, 2.2), ICE_END = new THREE.Color(0.35, 0.8, 1.4);
const NIGHT = new THREE.Color(0.07, 0.05, 0.13);
const SOOT = new THREE.Color(0.09, 0.06, 0.05), SOOT_END = new THREE.Color(0.03, 0.03, 0.03);
const GLITTER = [new THREE.Color(2.9, 2.2, 0.9), new THREE.Color(2.7, 1.2, 2.1), new THREE.Color(1.2, 2.4, 3.1), new THREE.Color(2.6, 2.6, 2.8)];
const LEAVES = [new THREE.Color(0.5, 1.15, 0.32), new THREE.Color(0.95, 1.05, 0.3), new THREE.Color(1.3, 0.75, 0.22)];

export function setc(s: PSpec, a: THREE.Color, ka: number, b: THREE.Color = a, kb = ka) {
  s.r0 = a.r * ka; s.g0 = a.g * ka; s.b0 = a.b * ka;
  s.r1 = b.r * kb; s.g1 = b.g * kb; s.b1 = b.b * kb;
}

export class Painter {
  private readonly d = new THREE.Vector3();
  private readonly ta = new THREE.Vector3();
  private readonly tb = new THREE.Vector3();
  // current trail segment
  private x0 = 0; private y0 = 0; private z0 = 0; private x1 = 0; private y1 = 0; private z1 = 0;
  private dt = 0; private rate = 1;

  readonly ps: Particles;
  readonly rib: Ribbons;

  constructor(ps: Particles, rib: Ribbons) { this.ps = ps; this.rib = rib; }

  /** Random unit vector, squashed toward the camera plane (XY) so bursts read from the side camera. */
  rdir(flat = 0.55): THREE.Vector3 {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    return this.d.set(r * Math.cos(a), u, r * Math.sin(a) * flat).normalize();
  }

  private at(s: PSpec, x: number, y: number, z: number, j: number) {
    s.x = x + (Math.random() - 0.5) * 2 * j;
    s.y = y + (Math.random() - 0.5) * 2 * j;
    s.z = z + (Math.random() - 0.5) * 2 * j;
  }

  private vel(s: PSpec, sp: number, flat = 0.55, up = 0) {
    const d = this.rdir(flat);
    s.vx = d.x * sp; s.vy = d.y * sp + up; s.vz = d.z * sp;
  }

  // ---------- generic pieces ----------
  flash(x: number, y: number, z: number, size: number, c: THREE.Color, k = 1, life = 0.16) {
    const s = this.ps.reset();
    s.x = x; s.y = y; s.z = z;
    s.sprite = SPR.Flare; s.life = life; s.size0 = size * 0.55; s.size1 = size;
    setc(s, c, k, c, k * 0.4); s.fadeOut = 0; s.rot = Math.random() * 6.28;
    this.ps.emit();
  }

  ring(x: number, y: number, z: number, size: number, c: THREE.Color, k = 1, life = 0.3, alpha = 0.9) {
    const s = this.ps.reset();
    s.x = x; s.y = y; s.z = z;
    s.sprite = SPR.Ring; s.life = life; s.size0 = size * 0.15; s.size1 = size;
    setc(s, c, k); s.alpha = alpha; s.fadeOut = 0.15;
    this.ps.emit();
  }

  starburst(x: number, y: number, z: number, size: number, c: THREE.Color, k = 1, life = 0.32) {
    const s = this.ps.reset();
    s.x = x; s.y = y; s.z = z;
    s.sprite = SPR.Burst; s.life = life; s.size0 = size * 0.35; s.size1 = size;
    setc(s, c, k, c, k * 0.6); s.fadeOut = 0.25; s.rot = Math.random() * 6.28; s.spin = rand(-1.5, 1.5);
    this.ps.emit();
  }

  /** One-frame sprite: the head of something that moves every frame. */
  one(sprite: number, x: number, y: number, z: number, size: number, c: THREE.Color, k: number, alpha: number, rot = 0, blend = 0) {
    const s = this.ps.reset();
    s.x = x; s.y = y; s.z = z;
    s.sprite = sprite; s.size0 = s.size1 = size; setc(s, c, k); s.alpha = alpha; s.rot = rot; s.blend = blend;
    s.flags = F_FRAME; s.fadeOut = 1; s.life = 1;
    this.ps.emit();
  }

  /** Motes converging on a point (casting wind-up). */
  gather(x: number, y: number, z: number, P: Pal, dt: number, rate: number, radius = 0.6) {
    const n = Math.floor(rate * dt + Math.random());
    for (let i = 0; i < n; i++) {
      const d = this.rdir(0.8), r = radius * rand(0.7, 1.1), T = rand(0.25, 0.4);
      const s = this.ps.reset();
      s.x = x + d.x * r; s.y = y + d.y * r; s.z = z + d.z * r;
      s.vx = -d.x * r / T; s.vy = -d.y * r / T; s.vz = -d.z * r / T;
      s.life = T; s.sprite = SPR.Spark; s.size0 = rand(0.035, 0.05); s.size1 = 0.02;
      setc(s, P.glow, 1, P.core, 1); s.fadeIn = 0.4; s.fadeOut = 0.8; s.stretch = 0.12;
      this.ps.emit();
    }
  }

  // ---------- impact bursts ----------
  /** Type-themed burst at a point. k ~ 0.25 (puff) .. 1 (normal hit) .. 1.6 (huge clean hit). */
  burst(fl: Flavor, x: number, y: number, z: number, k: number, P: Pal) {
    switch (fl) {
      case "ember": return this.emberBurst(x, y, z, k, P);
      case "wisp": return this.wispBurst(x, y, z, k, P);
      case "frost": return this.frostBurst(x, y, z, k, P);
      case "smoke": return this.smokeBurst(x, y, z, k, P);
      case "thorn": return this.thornBurst(x, y, z, k, P);
      case "fairy": return this.fairyBurst(x, y, z, k, P);
    }
  }

  private emberBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    // rolling fireball
    for (let i = 0, n = Math.round(6 + 4 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05 * sk); this.vel(s, rand(0.5, 1.4) * sk, 0.6, 0.35);
      s.sprite = SPR.Smoke; s.life = rand(0.45, 0.7); s.size0 = 0.12 * sk; s.size1 = rand(0.35, 0.5) * sk;
      setc(s, P.core, 0.32, P.accent, 0.6); s.alpha = 0.85; s.fadeOut = 0.25; s.drag = 3.5; s.grav = 2;
      s.rot = rand(0, 6.28); s.spin = rand(-2.5, 2.5);
      ps.emit();
    }
    // flame tongues licking outward
    for (let i = 0, n = Math.round(6 + 6 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.04); this.vel(s, rand(1.5, 3) * sk, 0.5, 0.6);
      s.sprite = SPR.Flame; s.stretch = 0.0001; s.size0 = rand(0.2, 0.3) * sk; s.size1 = 0.06; s.life = rand(0.25, 0.4);
      setc(s, P.core, 0.6, P.glow, 0.7); s.drag = 4; s.grav = 2.5; s.fadeOut = 0.3;
      ps.emit();
    }
    // embers drifting up
    for (let i = 0, n = Math.round(18 + 26 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.06); this.vel(s, rand(1.0, 3.8) * sk, 0.55, 0.8);
      s.sprite = SPR.Spark; s.size0 = rand(0.04, 0.07); s.size1 = s.size0 * 0.35; s.life = rand(0.8, 1.6);
      setc(s, P.core, 0.9, P.accent, 1.5); s.drag = 2.2; s.grav = 1.4; s.wobble = 3.5; s.flicker = 0.5; s.stretch = 0.06; s.fadeOut = 0.45;
      ps.emit();
    }
    for (let i = 0, n = Math.round(5 + 8 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.03); this.vel(s, rand(4, 7) * sk);
      s.sprite = SPR.Streak; s.size0 = s.size1 = 0.06; s.stretch = 0.2; s.life = rand(0.2, 0.35);
      setc(s, P.core, 1, P.glow, 0.8); s.drag = 3; s.grav = -5;
      ps.emit();
    }
    for (let i = 0, n = Math.round(3 + 3 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y + 0.1, z, 0.1); this.vel(s, 0.3, 0.6, rand(0.4, 0.8));
      s.sprite = SPR.Smoke; s.blend = 0.85; setc(s, SOOT, 1, SOOT_END, 1); s.size0 = 0.2 * sk; s.size1 = 0.65 * sk;
      s.life = rand(1.1, 1.6); s.alpha = 0.5; s.fadeIn = 0.25; s.rot = rand(0, 6.28); s.spin = rand(-0.8, 0.8);
      ps.emit();
    }
  }

  private wispBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    this.ta.set(x, y, z);
    for (let i = 0, n = Math.round(2 + 3 * k); i < n; i++) {
      const d = this.rdir(0.35);
      this.tb.copy(this.ta).addScaledVector(d, rand(0.3, 0.7) * k);
      this.rib.bolt(this.ta, this.tb, rand(0.16, 0.26), 0.05 * sk, P.glow.r, P.glow.g, P.glow.b, { jag: 0.3, branches: 2 });
    }
    for (let i = 0, n = Math.round(20 + 28 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.03); this.vel(s, rand(2.5, 8) * sk);
      s.sprite = SPR.Streak; s.size0 = s.size1 = rand(0.025, 0.04); s.stretch = 0.35; s.life = rand(0.18, 0.42);
      setc(s, P.core, 1, P.glow, 1); s.drag = 1.6; s.grav = -7; s.flags = F_GROUND;
      ps.emit();
    }
    for (let i = 0, n = Math.round(4 + 5 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.5, 1.2));
      s.sprite = SPR.Dot; s.size0 = 0.1 * sk; s.size1 = 0.22 * sk; s.life = rand(0.35, 0.5);
      setc(s, P.accent, 0.8); s.alpha = 0.5; s.drag = 3;
      ps.emit();
    }
    // crackling motes that linger after the flash
    for (let i = 0, n = Math.round(8 + 10 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.12 * k); this.vel(s, rand(0.3, 1.4));
      s.sprite = i % 2 ? SPR.Star4 : SPR.Spark; s.size0 = s.size1 = rand(0.05, 0.09); s.flags = F_TWINKLE; s.flicker = rand(25, 40);
      setc(s, i % 3 ? P.glow : P.accent, 1.1); s.drag = 2.5; s.grav = -0.6; s.life = rand(0.5, 0.9); s.rot = rand(0, 6.28);
      ps.emit();
    }
  }

  private frostBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    for (let i = 0, n = Math.round(9 + 12 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.04); this.vel(s, rand(2.2, 5.5) * sk);
      s.sprite = SPR.Shard; s.stretch = 0.0001; s.size0 = s.size1 = rand(0.12, 0.2) * (0.7 + 0.3 * k);
      s.life = rand(0.5, 0.9); setc(s, ICE, 1, ICE_END, 1); s.blend = 0.75; s.drag = 2.6; s.grav = -6;
      s.flags = F_GROUND; s.fadeOut = 0.6;
      ps.emit();
    }
    for (let i = 0, n = Math.round(4 + 6 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.5, 1.6));
      s.sprite = SPR.Crystal; s.size0 = s.size1 = rand(0.12, 0.2); s.life = rand(0.9, 1.5);
      setc(s, P.core, 0.45, P.glow, 0.45); s.blend = 0.3; s.drag = 2.2; s.grav = -0.5; s.rot = rand(0, 6.28); s.spin = rand(-3, 3); s.fadeIn = 0.05;
      ps.emit();
    }
    for (let i = 0, n = Math.round(3 + 4 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.06); this.vel(s, rand(0.3, 0.9));
      s.sprite = SPR.Smoke; s.blend = 0.4; setc(s, MIST, 0.8, MIST_END, 1); s.size0 = 0.18 * sk; s.size1 = 0.6 * sk;
      s.drag = 2; s.life = rand(0.7, 1.0); s.alpha = 0.4; s.rot = rand(0, 6.28); s.spin = rand(-1, 1);
      ps.emit();
    }
    for (let i = 0, n = Math.round(12 + 14 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.8, 2.6) * sk);
      s.sprite = SPR.Dot; s.size0 = s.size1 = rand(0.018, 0.032); s.flags = F_TWINKLE; s.flicker = rand(10, 20);
      s.drag = 1.8; s.grav = -1; s.life = rand(0.7, 1.3); setc(s, P.core, 1);
      ps.emit();
    }
  }

  private smokeBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    // dark heart of the smoke, then moonlit billows around it
    for (let i = 0, n = Math.round(4 + 4 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.3, 0.9) * sk, 0.7);
      s.sprite = SPR.Smoke; s.blend = 0.92; setc(s, NIGHT, 1, NIGHT, 0.6);
      s.size0 = 0.15 * sk; s.size1 = rand(0.45, 0.65) * sk; s.drag = 2.4; s.grav = 0.2;
      s.rot = rand(0, 6.28); s.spin = rand(-1, 1); s.life = rand(1.0, 1.5); s.alpha = 0.7; s.fadeIn = 0.05; s.fadeOut = 0.3;
      ps.emit();
    }
    for (let i = 0, n = Math.round(9 + 6 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.08); this.vel(s, rand(0.6, 2.0) * sk, 0.7);
      s.sprite = SPR.Smoke; s.blend = 0.8; setc(s, P.accent, 1.7, P.accent, 0.6);
      s.size0 = 0.16 * sk; s.size1 = rand(0.55, 0.8) * sk; s.drag = 2.6; s.grav = 0.3;
      s.rot = rand(0, 6.28); s.spin = rand(-1.2, 1.2); s.life = rand(1.1, 1.7); s.alpha = 0.8; s.fadeIn = 0.06; s.fadeOut = 0.3;
      ps.emit();
    }
    for (let i = 0; i < 3; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.04); this.vel(s, 0.3);
      s.sprite = SPR.Dot; setc(s, P.glow, 0.8); s.size0 = 0.15 * sk; s.size1 = 0.35 * sk; s.life = 0.35; s.alpha = 0.4;
      ps.emit();
    }
    for (let i = 0, n = Math.round(7 + 8 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.08); this.vel(s, rand(0.4, 2.0));
      s.sprite = SPR.Star4; s.size0 = s.size1 = rand(0.06, 0.1); s.flags = F_TWINKLE; s.flicker = rand(12, 20);
      setc(s, P.core, 1); s.drag = 2; s.life = rand(0.6, 1.1); s.rot = rand(0, 1);
      ps.emit();
    }
    const s = ps.reset();
    s.x = x; s.y = y; s.z = z; s.sprite = SPR.Crescent; s.size0 = 0.3 * sk; s.size1 = 0.42 * sk; s.spin = 1.5; s.rot = rand(0, 6.28);
    s.life = 0.45; setc(s, P.core, 1); s.alpha = 0.8; s.fadeOut = 0.3;
    ps.emit();
  }

  private thornBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    for (let i = 0, n = Math.round(8 + 10 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.03); this.vel(s, rand(2.8, 6.2) * sk, 0.5);
      s.sprite = SPR.Thorn; s.stretch = 0.0001; s.size0 = s.size1 = rand(0.16, 0.26) * (0.7 + 0.3 * k);
      s.life = rand(0.4, 0.7); setc(s, THORN, 1, THORN_END, 1); s.blend = 0.6; s.drag = 4.2; s.grav = -3; s.fadeOut = 0.55;
      ps.emit();
    }
    for (let i = 0, n = Math.round(9 + 12 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.8, 2.8) * sk);
      s.sprite = SPR.Petal; s.flags = F_FLUTTER | F_GROUND; s.flutter = rand(6, 12); s.size0 = s.size1 = rand(0.08, 0.12);
      s.life = rand(1.2, 2.0); setc(s, PINK, 1, PINK_END, 1); s.blend = 0.85; s.drag = 2.2; s.grav = -1.1; s.wobble = 2.5;
      s.rot = rand(0, 6.28); s.spin = rand(-4, 4); s.fadeIn = 0.04; s.fadeOut = 0.6;
      ps.emit();
    }
    for (let i = 0, n = Math.round(2 + 3 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.8, 2.2) * sk);
      s.sprite = SPR.Leaf; s.flags = F_FLUTTER | F_GROUND; s.flutter = rand(5, 9); s.size0 = s.size1 = rand(0.07, 0.1);
      s.life = rand(1.2, 1.8); setc(s, P.accent, 1); s.blend = 0.9; s.drag = 2; s.grav = -1.3; s.wobble = 2;
      s.rot = rand(0, 6.28); s.spin = rand(-3, 3); s.fadeOut = 0.6;
      ps.emit();
    }
    for (let i = 0, n = Math.round(5 + 6 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.06); this.vel(s, rand(1, 3) * sk);
      s.sprite = SPR.Star4; s.size0 = s.size1 = rand(0.06, 0.09); s.flags = F_TWINKLE; s.flicker = rand(12, 20);
      setc(s, P.glow, 1.2); s.drag = 2.5; s.life = rand(0.5, 0.9);
      ps.emit();
    }
  }

  private fairyBurst(x: number, y: number, z: number, k: number, P: Pal) {
    const ps = this.ps, sk = Math.sqrt(k);
    for (let i = 0, n = Math.round(22 + 26 * k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.05); this.vel(s, rand(0.8, 3.4) * sk);
      const star = Math.random() < 0.55;
      s.sprite = star ? SPR.Star4 : SPR.Dot; s.size0 = s.size1 = star ? rand(0.045, 0.08) : rand(0.025, 0.04);
      setc(s, i % 4 === 3 ? P.glow : GLITTER[i % 3], 1); s.flags = F_TWINKLE; s.flicker = rand(12, 22);
      s.drag = 2.4; s.grav = -0.5; s.life = rand(0.8, 1.5); s.rot = rand(0, 6.28); s.spin = rand(-3, 3);
      ps.emit();
    }
    for (let i = 0, n = 2 + Math.round(k); i < n; i++) {
      const s = ps.reset();
      this.at(s, x, y, z, 0.12 * k);
      s.sprite = SPR.Star8; s.size0 = 0.05; s.size1 = rand(0.16, 0.26) * k; s.life = 0.4; setc(s, P.core, 1);
      s.spin = rand(-2, 2); s.fadeOut = 0.2;
      ps.emit();
    }
  }

  // ---------- flight trails ----------
  private n(rate: number) {
    return Math.floor(rate * this.dt * this.rate + Math.random());
  }

  private seg(s: PSpec, j: number) {
    const t = Math.random();
    s.x = this.x0 + (this.x1 - this.x0) * t + (Math.random() - 0.5) * 2 * j;
    s.y = this.y0 + (this.y1 - this.y0) * t + (Math.random() - 0.5) * 2 * j;
    s.z = this.z0 + (this.z1 - this.z0) * t + (Math.random() - 0.5) * 2 * j;
  }

  /** Trail for something that moved from (x0..) to (x1..) this frame with velocity v. `k` scales the density. */
  trail(fl: Flavor, P: Pal, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    vx: number, vy: number, vz: number, dt: number, k = 1) {
    this.x0 = x0; this.y0 = y0; this.z0 = z0; this.x1 = x1; this.y1 = y1; this.z1 = z1;
    this.dt = dt; this.rate = k;
    const ps = this.ps;
    // soft glow motes along the path (the smooth streak itself is a ribbon, see Ribbons.open)
    for (let i = 0, n = this.n(30); i < n; i++) {
      const s = ps.reset();
      this.seg(s, 0.03);
      s.sprite = SPR.Dot; s.size0 = 0.16; s.size1 = 0.04; s.life = 0.3;
      setc(s, P.glow, 0.8); s.alpha = 0.3; s.fadeOut = 0;
      ps.emit();
    }
    switch (fl) {
      case "ember":
        for (let i = 0, n = this.n(80); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.04);
          s.vx = -vx * 0.12 + rand(-0.3, 0.3); s.vy = -vy * 0.12 + rand(0.4, 1.0); s.vz = -vz * 0.12 + rand(-0.3, 0.3);
          s.sprite = SPR.Flame; s.stretch = 0.0001; s.size0 = rand(0.11, 0.16); s.size1 = 0.04; s.life = rand(0.16, 0.28);
          setc(s, P.glow, 0.75, P.accent, 0.9); s.alpha = 0.85; s.fadeOut = 0.3;
          ps.emit();
        }
        for (let i = 0, n = this.n(50); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05); this.vel(s, rand(0.2, 0.6), 0.6, 0.4);
          s.sprite = SPR.Spark; s.size0 = rand(0.03, 0.05); s.size1 = s.size0 * 0.3; s.life = rand(0.5, 1.0);
          setc(s, P.core, 1, P.accent, 1.3); s.grav = 1.2; s.wobble = 3; s.drag = 1.2; s.flicker = 0.5; s.stretch = 0.04;
          ps.emit();
        }
        for (let i = 0, n = this.n(8); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05); s.vy = rand(0.2, 0.5);
          s.sprite = SPR.Smoke; s.blend = 0.85; setc(s, SOOT, 1, SOOT_END, 1); s.size0 = 0.12; s.size1 = 0.4;
          s.life = rand(0.8, 1.2); s.alpha = 0.4; s.fadeIn = 0.2; s.rot = rand(0, 6.28); s.spin = rand(-1, 1);
          ps.emit();
        }
        break;
      case "wisp":
        for (let i = 0, n = this.n(70); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.02); this.vel(s, rand(0.6, 2.0));
          s.vx -= vx * 0.15; s.vy -= vy * 0.15; s.vz -= vz * 0.15;
          s.sprite = SPR.Streak; s.size0 = s.size1 = 0.03; s.stretch = 0.3; s.life = rand(0.15, 0.3);
          setc(s, P.core, 1, P.glow, 1); s.drag = 2; s.grav = -3;
          ps.emit();
        }
        break;
      case "frost":
        for (let i = 0, n = this.n(24); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05); this.vel(s, rand(0.1, 0.35));
          s.sprite = SPR.Crystal; s.size0 = s.size1 = rand(0.06, 0.1); s.grav = -0.5; s.drag = 1;
          s.rot = rand(0, 6.28); s.spin = rand(-3, 3); s.life = rand(0.6, 1.0); setc(s, P.core, 0.9, P.glow, 0.6);
          ps.emit();
        }
        for (let i = 0, n = this.n(60); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05); this.vel(s, rand(0.1, 0.4));
          s.sprite = SPR.Dot; s.size0 = s.size1 = 0.022; s.flags = F_TWINKLE; s.flicker = rand(10, 20);
          s.grav = -0.8; s.life = rand(0.4, 0.8); setc(s, P.accent, 1);
          ps.emit();
        }
        for (let i = 0, n = this.n(14); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.03);
          s.sprite = SPR.Smoke; s.blend = 0.35; setc(s, MIST, 0.8, MIST_END, 1); s.size0 = 0.1; s.size1 = 0.32;
          s.life = 0.5; s.alpha = 0.3; s.rot = rand(0, 6.28); s.spin = rand(-1, 1);
          ps.emit();
        }
        break;
      case "smoke":
        for (let i = 0, n = this.n(45); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.04); this.vel(s, rand(0.05, 0.25));
          s.vx -= vx * 0.08; s.vy -= vy * 0.08; s.vz -= vz * 0.08;
          s.sprite = SPR.Smoke; s.blend = 0.65; setc(s, P.accent, 1.4, P.accent, 0.4); s.size0 = 0.12; s.size1 = 0.42;
          s.grav = 0.15; s.rot = rand(0, 6.28); s.spin = rand(-1, 1); s.life = rand(0.6, 0.95); s.alpha = 0.7; s.fadeIn = 0.1;
          ps.emit();
        }
        for (let i = 0, n = this.n(14); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.06);
          s.sprite = SPR.Star4; s.size0 = s.size1 = rand(0.05, 0.08); s.flags = F_TWINKLE; s.flicker = rand(12, 20);
          setc(s, P.core, 1); s.life = rand(0.4, 0.7);
          ps.emit();
        }
        break;
      case "thorn":
        for (let i = 0, n = this.n(26); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.04); this.vel(s, rand(0.2, 0.6));
          s.vx -= vx * 0.1; s.vy -= vy * 0.1; s.vz -= vz * 0.1;
          s.sprite = SPR.Petal; s.flags = F_FLUTTER; s.flutter = rand(6, 12); s.size0 = s.size1 = rand(0.055, 0.08);
          s.grav = -0.8; s.wobble = 2; s.drag = 1; s.life = rand(0.8, 1.3); setc(s, PINK, 1, PINK_END, 1); s.blend = 0.85;
          s.rot = rand(0, 6.28); s.spin = rand(-4, 4);
          ps.emit();
        }
        for (let i = 0, n = this.n(6); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.04); this.vel(s, rand(0.2, 0.5));
          s.sprite = SPR.Leaf; s.flags = F_FLUTTER; s.flutter = rand(5, 9); s.size0 = s.size1 = rand(0.06, 0.09);
          s.grav = -0.9; s.wobble = 2; s.life = rand(0.8, 1.2); setc(s, LEAVES[i % 3], 1); s.blend = 0.9;
          s.rot = rand(0, 6.28); s.spin = rand(-3, 3);
          ps.emit();
        }
        for (let i = 0, n = this.n(16); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05);
          s.sprite = SPR.Star4; s.size0 = s.size1 = rand(0.05, 0.08); s.flags = F_TWINKLE; s.flicker = rand(12, 20);
          setc(s, P.glow, 1.2); s.life = rand(0.4, 0.7);
          ps.emit();
        }
        break;
      case "fairy":
        for (let i = 0, n = this.n(90); i < n; i++) {
          const s = ps.reset();
          this.seg(s, 0.05); this.vel(s, rand(0.1, 0.5));
          const star = Math.random() < 0.5;
          s.sprite = star ? SPR.Star4 : SPR.Dot; s.size0 = s.size1 = star ? rand(0.04, 0.07) : rand(0.02, 0.035);
          setc(s, GLITTER[i % 4], 1); s.flags = F_TWINKLE; s.flicker = rand(12, 22); s.grav = -0.4; s.drag = 1;
          s.life = rand(0.6, 1.1); s.rot = rand(0, 6.28);
          ps.emit();
        }
        break;
    }
  }

  // ---------- projectile heads (one-frame sprites, redrawn every frame) ----------
  head(fl: Flavor, P: Pal, x: number, y: number, z: number, age: number, dt: number, shock: boolean) {
    if (shock) {
      this.one(SPR.Ring, x, y, z, 0.42 + 0.06 * Math.sin(age * 25), P.glow, 0.8, 0.9);
      this.one(SPR.Ring, x, y, z, 0.26, P.core, 0.5, 0.8);
      this.one(SPR.Dot, x, y, z, 0.6, P.glow, 0.5, 0.25);
      return;
    }
    switch (fl) {
      case "ember": // a hearth-fire orb: hot core inside rolling flame
        this.one(SPR.Dot, x, y, z, 0.5, P.glow, 0.4, 0.3);
        this.one(SPR.Smoke, x, y, z, 0.28, P.glow, 0.55, 0.9, age * 4);
        this.one(SPR.Smoke, x, y, z, 0.2, P.core, 0.32, 0.9, -age * 5.3);
        this.one(SPR.Spark, x, y, z, 0.16, P.core, 0.9, 1);
        break;
      case "wisp": { // crackling wisp-light: jittery core and arcs
        const jx = (Math.random() - 0.5) * 0.03, jy = (Math.random() - 0.5) * 0.03;
        this.one(SPR.Dot, x, y, z, 0.5, P.glow, 0.4, 0.3);
        this.one(SPR.Dot, x, y, z, 0.85, P.accent, 0.4, 0.1);
        this.one(SPR.Star4, x + jx, y + jy, z, 0.34, P.core, 0.8, 1, Math.random() * 0.4);
        if (Math.random() < dt * 45) {
          this.ta.set(x, y, z);
          for (let i = 0; i < 3; i++) {
            const d = this.rdir(0.4);
            this.tb.copy(this.ta).addScaledVector(d, rand(0.16, 0.34));
            const c = i ? P.accent : P.glow;
            this.rib.bolt(this.ta, this.tb, 0.08, 0.028, c.r, c.g, c.b, { jag: 0.35, branches: 0, rejit: 0.03, segs: 6 });
          }
        }
        break;
      }
      case "frost": // a cluster of frost crystals spinning around a cold heart
        this.one(SPR.Dot, x, y, z, 0.5, P.glow, 0.35, 0.3);
        for (let i = 0; i < 5; i++) {
          const a = age * 6 + i * 1.2566;
          this.one(SPR.Shard, x + Math.cos(a) * 0.13, y + Math.sin(a) * 0.13, z, 0.15, ICE, 0.9, 1, a, 0.7);
        }
        this.one(SPR.Crystal, x, y, z, 0.22, P.core, 0.55, 1, age * 3);
        break;
      case "smoke": // a pale moon wrapped in night smoke
        this.one(SPR.Smoke, x, y, z, 0.42, P.accent, 1.2, 0.7, age * 3, 0.6);
        this.one(SPR.Dot, x, y, z, 0.5, P.glow, 0.35, 0.3);
        this.one(SPR.Crescent, x, y, z, 0.3, P.core, 0.75, 1, age * 2.5);
        break;
      case "thorn": // a spinning bramble seed
        this.one(SPR.Dot, x, y, z, 0.45, P.glow, 0.35, 0.3);
        for (let i = 0; i < 6; i++) {
          const a = age * 11 + i * 1.0472;
          this.one(SPR.Thorn, x + Math.cos(a) * 0.1, y + Math.sin(a) * 0.1, z, 0.2, THORN, 1, 1, a, 0.6);
        }
        this.one(SPR.Petal, x, y, z, 0.13, PINK, 1, 1, age * 4, 0.7);
        break;
      case "fairy": // a twinkling star in a cloud of glitter
        this.one(SPR.Dot, x, y, z, 0.5, P.glow, 0.35, 0.3);
        this.one(SPR.Star8, x, y, z, 0.38, P.core, 0.7, 1, age * 1.5);
        this.one(SPR.Star4, x, y, z, 0.5, P.accent, 0.6, 0.5, -age * 2);
        break;
    }
  }

  // ---------- ground pieces ----------
  /** Moonlit dust kicked along the ground in a ring. */
  dust(x: number, z: number, k: number, radius = 0.3) {
    const ps = this.ps;
    for (let i = 0, n = Math.round(10 + 8 * k); i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = radius * rand(0.5, 1.2), sp = rand(0.6, 1.5) * k;
      const s = ps.reset();
      s.x = x + Math.cos(a) * r; s.y = rand(0.05, 0.15); s.z = z + Math.sin(a) * r * 0.7;
      s.vx = Math.cos(a) * sp; s.vy = rand(0.15, 0.45); s.vz = Math.sin(a) * sp * 0.7;
      s.sprite = SPR.Smoke; s.blend = 0.8; s.r0 = 0.42; s.g0 = 0.42; s.b0 = 0.5; s.r1 = 0.22; s.g1 = 0.22; s.b1 = 0.28;
      s.size0 = 0.12 * k; s.size1 = rand(0.4, 0.6) * k; s.drag = 2.5; s.grav = -0.2; s.life = rand(0.9, 1.4);
      s.alpha = 0.55; s.fadeIn = 0.05; s.rot = rand(0, 6.28); s.spin = rand(-1, 1);
      ps.emit();
    }
  }

  /** Flavor bits flung outward along the ground from a shockwave center. */
  ringOut(fl: Flavor, P: Pal, cx: number, cz: number, n: number, speed: number) {
    const ps = this.ps;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.12, 0.12), c = Math.cos(a), sn = Math.sin(a), sp = speed * rand(0.75, 1.2);
      const s = ps.reset();
      s.x = cx + c * 0.3; s.y = rand(0.05, 0.3); s.z = cz + sn * 0.3;
      s.vx = c * sp; s.vy = rand(0.2, 1.2); s.vz = sn * sp; s.drag = 2.2;
      s.rot = rand(0, 6.28);
      switch (fl) {
        case "ember":
          s.sprite = SPR.Spark; s.size0 = rand(0.035, 0.055); s.size1 = 0.015; setc(s, P.core, 1, P.accent, 1.3);
          s.grav = 1; s.flicker = 0.5; s.wobble = 2; s.stretch = 0.08; s.life = rand(0.6, 1.0);
          break;
        case "wisp":
          s.sprite = SPR.Streak; s.size0 = s.size1 = 0.035; s.stretch = 0.25; setc(s, P.core, 1, P.glow, 1);
          s.grav = -4; s.life = rand(0.3, 0.5);
          break;
        case "frost":
          s.sprite = i % 3 ? SPR.Shard : SPR.Crystal; s.size0 = s.size1 = rand(0.08, 0.13); s.stretch = i % 3 ? 0.0001 : 0;
          s.spin = i % 3 ? 0 : rand(-3, 3); setc(s, ICE, 0.9, ICE_END, 0.8); s.blend = 0.6; s.grav = -3; s.life = rand(0.5, 0.8);
          break;
        case "smoke":
          s.sprite = SPR.Smoke; s.size0 = 0.15; s.size1 = rand(0.4, 0.6); s.blend = 0.7; setc(s, P.accent, 1.5, P.accent, 0.4);
          s.alpha = 0.7; s.spin = rand(-1, 1); s.life = rand(0.7, 1.1); s.vy *= 0.4;
          break;
        case "thorn":
          if (i % 2) {
            s.sprite = SPR.Thorn; s.stretch = 0.0001; s.size0 = s.size1 = rand(0.12, 0.18); setc(s, THORN, 1, THORN_END, 1);
            s.blend = 0.55; s.grav = -3; s.life = rand(0.35, 0.55);
          } else {
            s.sprite = SPR.Petal; s.flags = F_FLUTTER | F_GROUND; s.flutter = rand(6, 12); s.size0 = s.size1 = rand(0.06, 0.09);
            setc(s, PINK, 1, PINK_END, 1); s.blend = 0.85; s.grav = -1.1; s.wobble = 2; s.spin = rand(-4, 4); s.life = rand(1.0, 1.6);
          }
          break;
        case "fairy":
          s.sprite = SPR.Star4; s.size0 = s.size1 = rand(0.05, 0.08); setc(s, GLITTER[i % 4], 1); s.flags = F_TWINKLE;
          s.flicker = rand(12, 22); s.grav = -0.5; s.life = rand(0.7, 1.2);
          break;
      }
      ps.emit();
    }
  }

  /** Motes streaking up from a point (calling a strike down from the sky). */
  rise(x: number, y: number, z: number, P: Pal, dt: number, rate: number) {
    for (let i = 0, n = Math.floor(rate * dt + Math.random()); i < n; i++) {
      const s = this.ps.reset();
      this.at(s, x, y, z, 0.08);
      s.vx = rand(-0.3, 0.3); s.vy = rand(3, 5.5); s.vz = rand(-0.2, 0.2);
      s.sprite = SPR.Streak; s.size0 = s.size1 = 0.04; s.stretch = 0.2; s.life = rand(0.3, 0.5);
      setc(s, P.core, 1, P.glow, 1); s.fadeOut = 0.3;
      this.ps.emit();
    }
  }

  leaves(x: number, y: number, z: number, n: number, up: number) {
    const ps = this.ps;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = rand(0.4, 1.2);
      const s = ps.reset();
      s.x = x + Math.cos(a) * 0.15; s.y = y; s.z = z + Math.sin(a) * 0.1;
      s.vx = Math.cos(a) * sp; s.vy = up * rand(0.6, 1.1); s.vz = Math.sin(a) * sp * 0.6;
      s.sprite = SPR.Leaf; s.flags = F_FLUTTER | F_GROUND; s.flutter = rand(5, 10); s.size0 = s.size1 = rand(0.07, 0.1);
      s.grav = -2.6; s.drag = 1; s.wobble = 2; s.life = rand(1.3, 2.0); setc(s, LEAVES[i % 3], 1); s.blend = 0.9;
      s.rot = rand(0, 6.28); s.spin = rand(-4, 4); s.fadeOut = 0.7;
      ps.emit();
    }
  }
}
