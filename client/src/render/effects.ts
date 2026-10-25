// Fairy-tale effects keyed by a move's `effect` tag and `type` (CLAUDE.md "Look and feel"):
// ember_orb, wisp_bolt, frost_crystals, moon_smoke, thorn_burst, fairy_dust, shockwave, none.
// All positions are three.js world coordinates (Y up).
// Draw calls: one for every particle (fx/particles), one for bolts and limb trails (fx/ribbons), plus a few
// pooled meshes while they're active (fx/meshes: rune circles, light columns, swooshes, falling strikes).
// Two persistent point lights flash on impacts; lights are never added or removed at runtime.
import * as THREE from "three";
import { KNOWN_EFFECTS, TYPE_EFFECT } from "../config";
import type { Effect, Kind, MoveType, Player } from "../contract";
import type { Stage } from "./stage";
import { SPR, buildTextures, type FxTextures } from "./fx/textures";
import { F_FLUTTER, F_GROUND, F_ORBIT, F_TWINKLE, Particles } from "./fx/particles";
import { Ribbons } from "./fx/ribbons";
import { SWOOSH_ARC, beamPool, decalPool, fallGeometries, fallPool, swooshPool, type FallShape, type Pool, type Slot } from "./fx/meshes";
import { Fighters, LIMBS, type FighterRef } from "./fx/fighters";
import { Painter, TYPE_FLAVOR, flavorOf, palette, rand, setc, type Flavor, type Pal } from "./fx/styles";

export interface ProjectileView {
  pos: THREE.Vector3;
  type: MoveType;
  effect: string;
  owner: Player;
}

export interface CastInfo {
  effect: string;
  type: MoveType;
  kind: Kind;
  power: 1 | 2 | 3;
  clean?: boolean;
}

interface Job {
  start: number;
  dur: number;
  begun: boolean;
  begin?: () => void;
  tick?: (k: number, dt: number) => void;
  end?: () => void;
}

interface Tracked {
  on: boolean; seen: boolean; owner: Player;
  x: number; y: number; z: number; px: number; py: number; pz: number; vx: number; vy: number; vz: number;
  fl: Flavor; pal: Pal; shock: boolean; age: number; trail: number;
}

interface Charge {
  on: boolean; k: number; x: number; z: number; glow: THREE.Color; ref: FighterRef | null;
  outer: Slot | null; inner: Slot | null; column: Slot | null; spin: number;
}

interface Flash { light: THREE.PointLight; t: number; dur: number; peak: number; }

const PLAYERS = [1, 2] as const;
const MAX_TRACKED = 12;
const WHITE_GOLD = new THREE.Color(3.2, 2.7, 1.8);
const SHIELD = new THREE.Color(1.5, 2.0, 2.9);
const SHIELD_LIGHT = new THREE.Color(0xcfe6ff);
const GHOST = new THREE.Color(1.0, 1.55, 2.3);
const DUST = new THREE.Color(0.75, 0.68, 0.55);
const LEAF_COLORS = [new THREE.Color(0.5, 1.15, 0.3), new THREE.Color(0.95, 1.05, 0.3), new THREE.Color(1.3, 0.75, 0.22)];
const FALL_SHAPE: Record<Flavor, FallShape> = { ember: "meteor", frost: "icicle", smoke: "shard", thorn: "spear", wisp: "none", fairy: "none" };
const FALL_COLOR: Record<Flavor, THREE.Color> = {
  ember: new THREE.Color(2.6, 1.0, 0.25), frost: new THREE.Color(0.6, 1.05, 1.5), smoke: new THREE.Color(1.0, 0.9, 1.6),
  thorn: new THREE.Color(1.1, 0.28, 0.5), wisp: new THREE.Color(4, 4, 3), fairy: new THREE.Color(4, 3.6, 2.4),
};
const DOWN = new THREE.Vector3(0, -1, 0);
const EARTH_GLOW = new THREE.Color(1.9, 1.15, 0.45);
const EARTH_LIGHT = new THREE.Color(0xffc27a);

const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const easeOutBack = (k: number) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2;

export class Effects {
  private readonly stage: Stage;
  private readonly tex: FxTextures;
  private readonly ps: Particles;
  private readonly rib: Ribbons;
  private readonly paint: Painter;
  private readonly decals: Pool;
  private readonly beams: Pool;
  private readonly swooshes: Pool;
  private readonly falls: Pool;
  private readonly fallGeo: ReturnType<typeof fallGeometries>;
  private readonly fighters: Fighters;
  private readonly flashes: Flash[] = [];
  private readonly tracked: Tracked[] = [];
  private readonly charges: Record<Player, Charge>;
  private readonly jobs: Job[] = [];
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private now = 0; // effect clock: advances with the (slow-motion scaled) dt
  private warm = 3; // first frames draw one invisible copy of everything so shaders compile during loading

  constructor(stage: Stage) {
    this.stage = stage;
    this.tex = buildTextures();
    this.ps = new Particles(6000, this.tex.atlas);
    this.rib = new Ribbons();
    this.paint = new Painter(this.ps, this.rib);
    const root = new THREE.Group();
    root.name = "effects";
    stage.scene.add(root);
    root.add(this.ps.mesh, this.rib.mesh);
    this.decals = decalPool(root, 16, this.tex.runeCircle);
    this.beams = beamPool(root, 6);
    this.swooshes = swooshPool(root, 6);
    this.fallGeo = fallGeometries();
    this.falls = fallPool(root, 4, this.fallGeo.icicle);
    this.fighters = new Fighters(stage.world);
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 6, 2);
      light.position.set(0, 1, 0);
      root.add(light);
      this.flashes.push({ light, t: 1, dur: 1, peak: 0 });
    }
    for (let i = 0; i < MAX_TRACKED; i++) {
      this.tracked.push({ on: false, seen: false, owner: 1, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, fl: "fairy", pal: palette("fairy", "physical"), shock: false, age: 0, trail: -1 });
    }
    const charge = (): Charge => ({ on: false, k: 0, x: 0, z: 0, glow: new THREE.Color(), ref: null, outer: null, inner: null, column: null, spin: 0 });
    this.charges = { 1: charge(), 2: charge() };
  }

  /** A landed hit at `point`. Bigger and brighter when `clean`; scale with damage (~5..30). */
  hit(point: THREE.Vector3, type: MoveType, clean: boolean, damage: number): void {
    const fl = TYPE_FLAVOR[type] ?? "fairy", P = palette(fl, type);
    const d = THREE.MathUtils.clamp(((damage || 10) - 5) / 25, 0, 1);
    const k = (0.6 + 0.9 * d) * (clean ? 1.25 : 1);
    const { x, y, z } = point;
    this.paint.flash(x, y, z, 0.18 + 0.2 * k, WHITE_GOLD, 0.8, 0.1);
    this.paint.flash(x, y, z, 0.35 * k, P.glow, 0.2, 0.18);
    this.paint.ring(x, y, z, 0.45 + 0.3 * k, WHITE_GOLD, 0.5, 0.26, 0.75);
    if (clean) {
      this.paint.starburst(x, y, z, 0.55 + 0.35 * k, WHITE_GOLD, 0.5, 0.3);
      this.paint.ring(x, y, z, 0.7 + 0.4 * k, P.glow, 0.5, 0.4, 0.7);
    }
    this.paint.burst(fl, x, y, z, k, P);
    this.light(x, y, z, P.light, 0.6 + 0.9 * k, 0.22);
  }

  /** A blocked hit at `point` (defender's guard): a shield-like sparkle, no damage. */
  blocked(point: THREE.Vector3): void {
    const { x, y, z } = point;
    const def = this.fighters.nearest(point);
    const att = this.fighters.other(def);
    const dir = att && Fighters.pos(att, "torso_link", this.v) ? Math.sign(this.v.x - x) : 0;
    const yaw = Math.atan2(dir * 0.62, 0.78);
    const s = this.decal(this.tex.runeRing, x, y, z, 0.5, SHIELD);
    if (s) {
      this.run(0, 0.42, {
        tick: (k) => {
          s.mesh.rotation.set(0, yaw, k * 2.2);
          s.mesh.scale.setScalar(0.5 + 0.28 * easeOut(Math.min(1, k * 3)));
          s.u.uOpacity.value = 1.3 * (1 - k) ** 1.5;
        },
        end: () => this.decals.free(s),
      });
    }
    this.paint.flash(x, y, z, 0.55, SHIELD, 1, 0.12);
    this.paint.ring(x, y, z, 0.75, SHIELD, 1, 0.3, 0.8);
    for (let i = 0; i < 20; i++) {
      const p = this.ps.reset();
      p.x = x; p.y = y; p.z = z;
      const out = dir ? dir * rand(0.8, 4) : rand(-3, 3);
      p.vx = out + rand(-1.2, 1.2); p.vy = rand(0.3, 3.8); p.vz = rand(-1.2, 1.2);
      p.sprite = SPR.Streak; p.size0 = p.size1 = 0.035; p.stretch = 0.3; p.life = rand(0.2, 0.42);
      setc(p, WHITE_GOLD, 1.1, SHIELD, 0.8); p.grav = -7; p.drag = 1.5;
      this.ps.emit();
    }
    for (let i = 0; i < 8; i++) {
      const p = this.ps.reset();
      const a = Math.random() * Math.PI * 2, r = rand(0.15, 0.3);
      p.x = x + Math.cos(yaw) * Math.cos(a) * r; p.y = y + Math.sin(a) * r; p.z = z - Math.sin(yaw) * Math.cos(a) * r;
      p.sprite = SPR.Star4; p.size0 = p.size1 = rand(0.06, 0.1); p.flags = F_TWINKLE; p.flicker = rand(14, 22);
      setc(p, SHIELD, 1.2); p.life = rand(0.3, 0.5);
      this.ps.emit();
    }
    this.light(x, y, z, SHIELD_LIGHT, 2.2, 0.2);
  }

  /** The defender dodged; `at` is the defender's chest. */
  dodged(at: THREE.Vector3): void {
    const f = this.fighters.nearest(at);
    // afterimage: a ghost of the fighter in soft moonlight where they stood
    if (f) {
      for (const b of f.list) {
        this.v.setFromMatrixPosition(b.matrixWorld);
        for (let i = 0; i < 2; i++) {
          const p = this.ps.reset();
          p.x = this.v.x + rand(-0.04, 0.04); p.y = this.v.y + rand(-0.04, 0.04); p.z = this.v.z + rand(-0.04, 0.04);
          p.vx = rand(-0.15, 0.15); p.vy = rand(0, 0.25); p.vz = rand(-0.1, 0.1);
          p.sprite = SPR.Dot; p.size0 = rand(0.14, 0.2); p.size1 = p.size0 * 1.3; setc(p, GHOST, 1);
          p.alpha = 0.6; p.life = rand(0.45, 0.6); p.fadeOut = 0;
          this.ps.emit();
        }
      }
    } else {
      for (let i = 0; i < 40; i++) {
        const p = this.ps.reset();
        p.x = at.x + rand(-0.12, 0.12); p.y = rand(0.1, at.y + 0.35); p.z = at.z + rand(-0.08, 0.08);
        p.sprite = SPR.Dot; p.size0 = 0.13; p.size1 = 0.17; setc(p, GHOST, 1); p.alpha = 0.35; p.life = rand(0.4, 0.55); p.fadeOut = 0;
        this.ps.emit();
      }
    }
    // leaf whirl spiraling up around the body
    for (let i = 0; i < 16; i++) {
      const p = this.ps.reset();
      p.flags = F_ORBIT | F_FLUTTER;
      p.ocx = at.x; p.ocz = at.z; p.oang = rand(0, Math.PI * 2); p.orad = rand(0.26, 0.42); p.ow = rand(7, 10); p.odr = 0.35;
      p.y = rand(0.15, at.y + 0.3); p.vy = rand(0.3, 0.9);
      p.sprite = SPR.Leaf; p.flutter = rand(6, 10); p.size0 = p.size1 = rand(0.07, 0.1); p.rot = rand(0, 6.28); p.spin = rand(-4, 4);
      setc(p, LEAF_COLORS[i % 3], 1);
      p.blend = 0.9; p.life = rand(0.7, 1.0); p.fadeIn = 0.1; p.fadeOut = 0.5;
      this.ps.emit();
    }
    // wind swirls wrapping the body
    this.swirl(at.x, 0.5, at.z, 0.42, 1, 0.42);
    this.swirl(at.x, Math.max(0.7, at.y), at.z, 0.36, -1, 0.36);
  }

  /** A knockdown: the robot is on the ground at `at` (ground point). */
  down(at: THREE.Vector3): void {
    this.paint.dust(at.x, at.z, 1.1, 0.35);
    this.paint.leaves(at.x, 0.12, at.z, 10, 2.6);
    const s = this.decal(this.tex.shockRing, at.x, 0.02, at.z, 0.5, DUST);
    if (s) {
      this.run(0, 0.5, {
        tick: (k) => {
          s.mesh.scale.setScalar(0.5 + 1.4 * easeOut(k));
          s.u.uOpacity.value = 0.7 * (1 - k);
        },
        end: () => this.decals.free(s),
      });
    }
  }

  /** KO: after the real fall, fairy dust drifts up from `at` (ground point) in the loser's `glow` color. */
  ko(at: THREE.Vector3, glow: number): void {
    const c = new THREE.Color(glow);
    const mote = c.clone().multiplyScalar(2.2);
    const bright = c.clone().lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(2.6);
    const f = this.fighters.nearest(at, "pelvis", 1.2);
    const cx = at.x, cz = at.z;
    const pool = this.decal(this.tex.glowDisc, cx, 0.02, cz, 1.9, c.clone().multiplyScalar(1.1));
    let col: Slot | null = null;
    this.run(0, 3.4, {
      begin: () => {
        col = this.beams.get();
        if (col) {
          col.mesh.position.set(cx, 0, cz);
          col.mesh.scale.set(0.5, 2.6, 0.5);
          (col.u.uColor.value as THREE.Color).copy(c).multiplyScalar(0.6);
          col.u.uStripes.value = 0.6;
          col.u.uFade.value = 1.2;
        }
      },
      tick: (k) => {
        const env = Math.sin(Math.PI * Math.min(1, k * 1.15));
        if (pool) pool.u.uOpacity.value = 0.55 * env;
        if (col) {
          col.u.uOpacity.value = 0.18 * env;
          col.u.uTime.value = this.now;
        }
      },
      end: () => {
        if (pool) this.decals.free(pool);
        if (col) this.beams.free(col);
      },
    });
    this.run(0, 3.2, {
      tick: (k, dt) => {
        const n = Math.floor(dt * 90 * (1 - 0.55 * k) + Math.random());
        for (let i = 0; i < n; i++) {
          if (f && f.list.length) this.v.setFromMatrixPosition(f.list[(Math.random() * f.list.length) | 0].matrixWorld);
          else {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.55;
            this.v.set(cx + Math.cos(a) * r, rand(0.05, 0.3), cz + Math.sin(a) * r * 0.6);
          }
          const p = this.ps.reset();
          p.x = this.v.x + rand(-0.07, 0.07); p.y = this.v.y + rand(-0.04, 0.08); p.z = this.v.z + rand(-0.07, 0.07);
          p.vx = rand(-0.06, 0.06); p.vy = rand(0.22, 0.55); p.vz = rand(-0.05, 0.05); p.wobble = 0.5;
          const star = Math.random() < 0.35;
          p.sprite = star ? SPR.Star4 : SPR.Dot; p.size0 = p.size1 = star ? rand(0.07, 0.12) : rand(0.035, 0.07);
          setc(p, Math.random() < 0.3 ? bright : mote, 1); p.alpha = 0.95;
          p.flags = F_TWINKLE; p.flicker = rand(4, 11); p.life = rand(1.8, 3.0); p.fadeIn = 0.15; p.fadeOut = 0.55;
          p.rot = rand(0, 6.28);
          this.ps.emit();
        }
      },
    });
    this.light(cx, 0.4, cz, c, 1.5, 1.5);
  }

  /**
   * A move just started playing. `caster` and `target` are chest points; `delay` is the seconds until the
   * move's hit_frame. Projectiles themselves are drawn from projectiles(); this is the flourish around them:
   * melee trails, a strike's telegraph at the target that lands ~0.6 s after `delay`, a shockwave ring, etc.
   * `live()` is asked on the hit frame: false (the caster was knocked down first, so the sim dropped the move)
   * skips the release, the shockwave and the strike's impact, which would otherwise flash for a move that did nothing.
   */
  cast(move: CastInfo, caster: THREE.Vector3, target: THREE.Vector3, delay: number, live: () => boolean = () => true): void {
    const effect = effectOf(move.effect, move.type);
    const fl = flavorOf(effect, move.type), P = palette(fl, move.type);
    const ks = 0.75 + 0.25 * THREE.MathUtils.clamp(move.power || 1, 1, 3); // 1 .. 1.5
    const ref = this.fighters.nearest(caster);
    const dir = Math.sign(target.x - caster.x) || 1;
    const d = Math.max(0, Number.isFinite(delay) ? delay : 0.4);
    const c = caster.clone(), t = target.clone();
    // two signature effects that replace the kind's usual flourish
    if (move.effect === "earth_wall") return this.castEarthWall(ks, ref, c, dir, d);
    if (move.effect === "spiral_orb") return this.castSpiralOrb(P, ks, ref, c, dir, d);
    switch (move.kind) {
      case "projectile": return this.castProjectile(P, ks, ref, c, t, dir, d, live);
      case "strike": return this.castStrike(fl, P, ks, ref, c, t, dir, d, live);
      case "shockwave": return this.castShockwave(fl, P, ks, ref, c, d, live);
      case "defend": return this.castDefend(P, ks, ref, c, dir, d);
      default: return this.castMelee(fl, P, ks, ref, c, dir, d);
    }
  }

  /** Charging glow on/off for a fighter (a live wildcard is generating). `at` is the ground under them. */
  charging(p: Player, at: THREE.Vector3, on: boolean, glow: number): void {
    const c = this.charges[p];
    if (!c) return;
    if (on) {
      c.glow.set(glow);
      c.x = at.x;
      c.z = at.z;
      c.ref = this.fighters.nearest(at, "pelvis", 1.2);
      c.outer ??= this.decal(this.tex.runeCircle, at.x, 0.025, at.z, 1, c.glow);
      c.inner ??= this.decal(this.tex.runeRing, at.x, 0.03, at.z, 1, c.glow);
      if (!c.column) {
        c.column = this.beams.get();
        if (c.column) {
          c.column.u.uStripes.value = 1;
          c.column.u.uFade.value = 1.4;
          c.column.u.uOpacity.value = 0;
        }
      }
      c.on = true;
    } else if (c.on) {
      c.on = false;
      // release: a puff of motes shooting up
      const col = c.glow.clone().multiplyScalar(2.5);
      for (let i = 0; i < 24; i++) {
        const q = this.ps.reset();
        const a = Math.random() * Math.PI * 2, r = rand(0.2, 0.7);
        q.x = c.x + Math.cos(a) * r; q.y = rand(0.05, 0.3); q.z = c.z + Math.sin(a) * r;
        q.vx = Math.cos(a) * 0.3; q.vy = rand(1.5, 3.2); q.vz = Math.sin(a) * 0.3; q.drag = 1.5;
        q.sprite = i % 3 ? SPR.Spark : SPR.Star4; q.size0 = q.size1 = rand(0.035, 0.07); setc(q, i % 4 ? col : WHITE_GOLD, 1);
        q.stretch = i % 3 ? 0.1 : 0; q.life = rand(0.5, 0.9);
        this.ps.emit();
      }
    }
  }

  /** Every frame: the sim's current projectiles. Match them frame to frame yourself (no ids). */
  projectiles(list: ProjectileView[]): void {
    for (const t of this.tracked) t.seen = false;
    for (const q of list) {
      let best: Tracked | null = null, bestD = 0.9 * 0.9;
      for (const t of this.tracked) {
        if (!t.on || t.seen || t.owner !== q.owner) continue;
        const dx = t.x - q.pos.x, dy = t.y - q.pos.y, dz = t.z - q.pos.z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bestD) { bestD = dd; best = t; }
      }
      if (best) {
        best.seen = true;
        best.x = q.pos.x; best.y = q.pos.y; best.z = q.pos.z;
      } else this.spawnProjectile(q);
    }
    for (const t of this.tracked) {
      if (!t.on || t.seen) continue;
      t.on = false;
      this.rib.close(t.trail);
      this.paint.burst(t.fl, t.x, t.y, t.z, 0.2, t.pal);
    }
  }

  /** Every frame. main.ts passes real time, even during the KO slow motion (see there). */
  update(dt: number, _t: number): void {
    this.now += dt;
    this.ps.step(dt);
    this.tickJobs(dt);
    this.tickCharges(dt);
    this.tickProjectiles(dt);
    this.ps.upload();
    this.rib.update(dt, this.stage.camera.position);
    this.tickLights(dt);
    if (this.warm > 0) this.warmUp(--this.warm > 0);
  }

  /** Draw an invisible copy of each effect material (same render path as gameplay) so no shader compiles mid-fight. */
  private warmUp(on: boolean) {
    if (on) {
      this.ps.mesh.visible = true;
      this.rib.mesh.visible = true;
    }
    for (const pool of [this.decals, this.beams, this.swooshes, this.falls]) {
      const s = pool.slots[pool.slots.length - 1];
      if (s.busy) continue;
      s.mesh.visible = on;
      if (s.u.uOpacity) s.u.uOpacity.value = 0;
      s.mesh.position.set(0, on ? -50 : 0, 0);
    }
  }

  // ---------- casts ----------
  private castMelee(fl: Flavor, P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, dir: number, d: number) {
    // limb trails around the hit frame; only fast-moving limbs light up
    if (ref) {
      this.run(Math.max(0, d - 0.32), 0, {
        begin: () => {
          const pelvis = ref.bodies.get("pelvis") ?? null;
          for (const n of LIMBS) {
            const b = ref.bodies.get(n);
            if (b) this.rib.trail(b, 0.55, 0.11 * ks, P.glow.r, P.glow.g, P.glow.b, 1.6, pelvis);
          }
        },
      });
    }
    // a crescent swoosh in front of the caster that peaks on the hit frame
    let sw: Slot | null = null;
    const variant = Math.floor(Math.random() * 3);
    const R = 0.5 * Math.sqrt(ks);
    this.run(Math.max(0, d - 0.1), 0.4, {
      begin: () => {
        sw = this.swooshes.get();
        if (!sw) return;
        const c = (ref && Fighters.chest(ref, this.v)) || this.v.copy(caster);
        sw.mesh.position.set(c.x + dir * 0.14, c.y + (variant === 1 ? -0.05 : 0.04), c.z + 0.05);
        // slash (clockwise from overhead), uppercut (counter-clockwise from low), wide swing
        const a0 = variant === 0 ? 1.85 : variant === 1 ? -1.2 : 1.1;
        sw.mesh.rotation.set(0, 0, dir * a0);
        sw.mesh.scale.set(dir * R, variant === 1 ? R : -R, R);
        (sw.u.uColor.value as THREE.Color).copy(P.glow).multiplyScalar(0.75);
        sw.u.uTail.value = 0.75;
        sw.u.uHead.value = 0;
        sw.u.uOpacity.value = 1;
      },
      tick: (k) => {
        if (!sw) return;
        sw.u.uHead.value = Math.min(1.3, (k / 0.45) * 1.3);
        sw.u.uOpacity.value = k < 0.45 ? 1 : 1 - (k - 0.45) / 0.55;
      },
      end: () => {
        if (sw) this.swooshes.free(sw);
      },
    });
    // sparkle where the arc ends, on the hit frame
    this.run(d, 0, {
      begin: () => {
        if (!sw) return;
        sw.mesh.updateMatrixWorld();
        const e = sw.mesh.localToWorld(this.w.set(Math.cos(SWOOSH_ARC) * 0.85, Math.sin(SWOOSH_ARC) * 0.85, 0));
        this.paint.burst(fl, e.x, e.y, e.z, 0.3 * ks, P);
        this.paint.flash(e.x, e.y, e.z, 0.35 * ks, P.core, 0.7, 0.12);
      },
    });
  }

  private castProjectile(P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, target: THREE.Vector3, dir: number, d: number, live: () => boolean) {
    // wind-up: motes gather in front of the caster until the hit frame
    this.run(0, d, {
      tick: (k, dt) => {
        const c = this.castPoint(ref, caster, dir, 0.3, this.v);
        this.paint.gather(c.x, c.y, c.z, P, dt, 55 * ks, 0.55);
        this.paint.one(SPR.Dot, c.x, c.y, c.z, 0.12 + 0.35 * k, P.glow, 1, 0.55 * k);
        this.paint.one(SPR.Spark, c.x, c.y, c.z, 0.06 + 0.12 * k, P.core, 1, k);
      },
    });
    // release flash at the casting hand
    this.run(d, 0, {
      begin: () => {
        if (!live()) return;
        const h = this.limbToward(ref, target, this.v) ?? this.castPoint(ref, caster, dir, 0.35, this.v);
        this.paint.flash(h.x, h.y, h.z, 0.55 * ks, P.core, 0.8, 0.14);
        this.paint.ring(h.x, h.y, h.z, 0.6 * ks, P.glow, 1, 0.25, 0.8);
        this.light(h.x, h.y, h.z, P.light, 2.5 * ks, 0.25);
      },
    });
  }

  private castStrike(fl: Flavor, P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, target: THREE.Vector3, dir: number, d: number, live: () => boolean) {
    const land = d + 0.6, gx = target.x, gz = target.z;
    let cancelAt = -1; // effect-clock time the caster lost the move (knocked down before the hit frame)
    const fadeOut = () => (cancelAt < 0 ? 1 : Math.max(0, 1 - (this.now - cancelAt) / 0.2));
    // telegraph: a rune circle draws itself at the target and tightens until the strike lands; a thin pillar marks it
    let a: Slot | null = null, b: Slot | null = null, beam: Slot | null = null;
    this.run(0, land, {
      begin: () => {
        a = this.decal(this.tex.runeCircle, gx, 0.021, gz, 1.2, P.rune);
        b = this.decal(this.tex.runeRing, gx, 0.024, gz, 0.75, P.rune);
        beam = this.beams.get();
        if (beam) {
          beam.mesh.position.set(gx, 0, gz);
          (beam.u.uColor.value as THREE.Color).copy(P.rune);
          beam.u.uStripes.value = 1;
          beam.u.uFade.value = 0.6;
          beam.u.uOpacity.value = 0;
        }
      },
      tick: (k) => {
        const t = k * land;
        const pulse = 0.75 + 0.25 * Math.sin(this.now * (9 + 16 * k));
        const fadeIn = Math.min(1, t / 0.15) * fadeOut();
        if (a) {
          a.mesh.rotation.set(-Math.PI / 2, 0, this.now * 1.2);
          a.mesh.scale.setScalar((1.25 - 0.3 * k) * Math.sqrt(ks));
          a.u.uReveal.value = Math.min(1, t / 0.35);
          a.u.uOpacity.value = 0.7 * pulse * fadeIn;
        }
        if (b) {
          b.mesh.rotation.set(-Math.PI / 2, 0, -this.now * 2.2);
          b.mesh.scale.setScalar((0.8 - 0.25 * k) * Math.sqrt(ks));
          b.u.uOpacity.value = 0.7 * pulse * fadeIn;
        }
        if (beam) {
          const r = 0.06 + 0.06 * (1 - k);
          beam.mesh.scale.set(r, 7, r);
          beam.u.uOpacity.value = 0.4 * k * pulse * fadeOut();
          beam.u.uTime.value = this.now;
        }
      },
      end: () => {
        if (a) this.decals.free(a);
        if (b) this.decals.free(b);
        if (beam) this.beams.free(beam);
      },
    });
    // the caster calls it down: light streaks up from their hands
    this.run(Math.max(0, d - 0.25), 0.3, {
      tick: (_k, dt) => {
        const c = this.castPoint(ref, caster, dir, 0.05, this.v);
        this.paint.rise(c.x, c.y + 0.35, c.z, P, dt, 60);
      },
    });
    // something falls from above: ember meteor, icicle, moon shard, thorn spear, or a falling star
    const fallDur = Math.min(0.6, land);
    const sx = gx - dir * 0.9, sy = 3.6;
    const shape = FALL_SHAPE[fl];
    let m: Slot | null = null;
    let lx = sx, ly = sy, lz = gz, spin = 0;
    this.run(land - fallDur, fallDur, {
      begin: () => {
        if (!live()) cancelAt = this.now; // the sim never queued the strike: no fall, no impact
        if (shape === "none" || cancelAt >= 0) return;
        m = this.falls.get();
        if (!m) return;
        m.mesh.geometry = this.fallGeo[shape];
        (m.mesh.material as THREE.MeshBasicMaterial).color.copy(FALL_COLOR[fl]);
        this.v.set(gx - sx, 0.05 - sy, 0).normalize();
        m.mesh.quaternion.setFromUnitVectors(DOWN, this.v);
        m.mesh.position.set(sx, sy, gz);
      },
      tick: (k, dt) => {
        if (cancelAt >= 0) return;
        const e = Math.pow(k, 1.4);
        const x = sx + (gx - sx) * e, y = sy + (0.05 - sy) * e, z = gz;
        const inv = dt > 0 ? 1 / dt : 0;
        if (m) {
          m.mesh.position.set(x, y, z);
          if (shape === "meteor" || shape === "shard") {
            spin += dt * 9;
            this.v.set(gx - sx, 0.05 - sy, 0).normalize();
            m.mesh.quaternion.setFromUnitVectors(DOWN, this.v);
            m.mesh.rotateY(spin);
          }
        }
        this.paint.trail(fl, P, lx, ly, lz, x, y, z, (x - lx) * inv, (y - ly) * inv, (z - lz) * inv, dt, 1.4);
        if (shape === "none") {
          this.paint.one(SPR.Star8, x, y, z, 0.6, P.core, 0.7, 1, this.now * 3);
          this.paint.one(SPR.Dot, x, y, z, 0.6, P.glow, 0.5, 0.35);
        } else this.paint.one(SPR.Dot, x, y + 0.12, z, 0.5, P.glow, 0.45, 0.3);
        lx = x; ly = y; lz = z;
      },
      end: () => {
        if (m) this.falls.free(m);
        if (cancelAt < 0) this.strikeImpact(fl, P, ks, gx, gz);
      },
    });
  }

  private strikeImpact(fl: Flavor, P: Pal, ks: number, x: number, z: number) {
    this.paint.flash(x, 0.3, z, 0.8 * ks, P.core, 0.45, 0.2);
    this.paint.flash(x, 0.3, z, 0.45 * ks, WHITE_GOLD, 0.8, 0.12);
    this.paint.burst(fl, x, 0.25, z, 0.9 * ks, P);
    this.paint.dust(x, z, ks, 0.3);
    if (fl === "wisp" || fl === "fairy") {
      this.v.set(x + 0.3, 6, z);
      this.w.set(x, 0.02, z);
      this.rib.bolt(this.v, this.w, 0.3, 0.13, P.glow.r, P.glow.g, P.glow.b, { jag: 0.1, branches: 2, segs: 22, core: 2 });
    }
    this.groundRing(x, z, 2.2 * ks, P.rune, 0.45);
    this.light(x, 0.5, z, P.light, 5 * ks, 0.4);
    this.stage.shake(0.025 * ks);
  }

  private castShockwave(fl: Flavor, P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, d: number, live: () => boolean) {
    // wind-up: a rune circle under the caster and gathering motes
    let rc: Slot | null = null;
    const wind = d + 0.3;
    this.run(0, wind, {
      begin: () => { rc = this.decal(this.tex.runeCircle, caster.x, 0.022, caster.z, 1.3, P.rune); },
      tick: (k, dt) => {
        const t = k * wind;
        const g = this.groundOf(ref, caster, this.v);
        if (rc) {
          rc.mesh.position.set(g.x, 0.022, g.z);
          rc.mesh.rotation.set(-Math.PI / 2, 0, this.now * 1.6);
          rc.u.uReveal.value = Math.min(1, t / 0.3);
          rc.u.uOpacity.value = 0.7 * (t < d ? Math.min(1, t / 0.15) : 1.3 * (1 - (t - d) / 0.3));
        }
        if (t < d) this.paint.gather(g.x, 0.85, g.z, P, dt, 45 * ks, 0.75);
      },
      end: () => {
        if (rc) this.decals.free(rc);
      },
    });
    // the wave: ground ring, a translucent wall racing out to 1.5 m, flavor bits flung outward
    let ring: Slot | null = null, wall: Slot | null = null, cx = caster.x, cz = caster.z;
    this.run(d, 0.5, {
      begin: () => {
        if (!live()) return; // knocked down before the hit frame: the sim dropped the wave
        const g = this.groundOf(ref, caster, this.v);
        cx = g.x; cz = g.z;
        ring = this.decal(this.tex.shockRing, cx, 0.03, cz, 0.3, P.rune);
        wall = this.beams.get();
        if (wall) {
          wall.mesh.position.set(cx, 0, cz);
          (wall.u.uColor.value as THREE.Color).copy(P.rune).multiplyScalar(0.7);
          wall.u.uStripes.value = 0;
          wall.u.uFade.value = 1.6;
        }
        this.paint.flash(cx, 0.3, cz, 0.6 * ks, P.core, 0.45, 0.16);
        this.paint.ringOut(fl, P, cx, cz, Math.round(26 + 10 * ks), 3.2);
        this.paint.dust(cx, cz, 1.2 * ks, 0.4);
        if (fl === "wisp") {
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + rand(-0.4, 0.4);
            this.v.set(cx, 0.05, cz);
            this.w.set(cx + Math.cos(a) * 1.4, 0.05, cz + Math.sin(a) * 1.4);
            this.rib.bolt(this.v, this.w, 0.26, 0.035, P.rune.r, P.rune.g, P.rune.b, { jag: 0.25, branches: 1, core: 1.1 });
          }
        }
        this.light(cx, 0.4, cz, P.light, 2 * ks, 0.35);
        this.stage.shake(0.03 * ks);
      },
      tick: (k) => {
        const e = 1 - (1 - k) ** 2.2;
        const r = 0.15 + 1.45 * e;
        if (ring) {
          ring.mesh.scale.setScalar((r * 2) / 0.9);
          ring.u.uOpacity.value = 1.1 * (1 - k) ** 1.2;
        }
        if (wall) {
          wall.mesh.scale.set(r, 0.45 * (1 - 0.5 * k) * Math.sqrt(ks), r);
          wall.u.uOpacity.value = 0.45 * (1 - k) ** 1.5;
        }
      },
      end: () => {
        if (ring) this.decals.free(ring);
        if (wall) this.beams.free(wall);
      },
    });
  }

  private castDefend(P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, dir: number, d: number) {
    const dur = Math.max(1.0, d + 0.8);
    const yaw = Math.atan2(dir * 0.62, 0.78); // faces the attacker, turned toward the side camera
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let a: Slot | null = null, b: Slot | null = null;
    this.run(0, dur, {
      begin: () => {
        a = this.decal(this.tex.runeCircle, caster.x, caster.y, caster.z, 0.01, P.rune);
        b = this.decal(this.tex.runeRing, caster.x, caster.y, caster.z, 0.01, P.rune);
        const c = this.castPoint(ref, caster, dir, 0.34, this.v);
        this.paint.flash(c.x, c.y, c.z, 0.6, P.core, 0.4, 0.16);
      },
      tick: (k, dt) => {
        const t = k * dur;
        const c = this.castPoint(ref, caster, dir, 0.34, this.v);
        const pop = t < 0.2 ? easeOutBack(t / 0.2) : 1;
        const fade = t > dur - 0.25 ? Math.max(0, (dur - t) / 0.25) : 1;
        const R = 0.85 * Math.cbrt(ks) * pop;
        if (a) {
          a.mesh.position.copy(c);
          a.mesh.rotation.set(0, yaw, this.now * 1.4);
          a.mesh.scale.setScalar(Math.max(0.01, R));
          a.u.uOpacity.value = (0.42 + 0.08 * Math.sin(this.now * 11)) * fade;
        }
        if (b) {
          b.mesh.position.set(c.x - rz * 0.02, c.y, c.z + rx * 0.02);
          b.mesh.rotation.set(0, yaw, -this.now * 2.4);
          b.mesh.scale.setScalar(Math.max(0.01, R * 0.6));
          b.u.uOpacity.value = 0.3 * fade;
        }
        // sparkles running around the rim
        for (let i = 0, n = Math.floor(dt * 40 * fade + Math.random()); i < n; i++) {
          const ang = Math.random() * Math.PI * 2, rr = R * 0.47;
          const p = this.ps.reset();
          p.x = c.x + rx * Math.cos(ang) * rr; p.y = c.y + Math.sin(ang) * rr; p.z = c.z + rz * Math.cos(ang) * rr;
          p.vy = rand(0.05, 0.3);
          p.sprite = SPR.Star4; p.size0 = p.size1 = rand(0.05, 0.08); p.flags = F_TWINKLE; p.flicker = rand(14, 22);
          setc(p, P.core, 1); p.life = rand(0.3, 0.5); p.rot = rand(0, 1);
          this.ps.emit();
        }
      },
      end: () => {
        if (a) this.decals.free(a);
        if (b) this.decals.free(b);
      },
    });
  }

  // ---------- helpers ----------
  private spawnProjectile(q: ProjectileView) {
    const t = this.tracked.find((x) => !x.on);
    if (!t) return;
    const effect = effectOf(q.effect, q.type);
    t.on = true; t.seen = true; t.owner = q.owner; t.age = 0;
    t.x = t.px = q.pos.x; t.y = t.py = q.pos.y; t.z = t.pz = q.pos.z;
    t.vx = t.vy = t.vz = 0;
    t.shock = effect === "shockwave";
    t.fl = flavorOf(effect, q.type);
    t.pal = palette(t.fl, q.type);
    const g = t.pal.glow;
    t.trail = this.rib.open(t.fl === "smoke" ? 0.2 : 0.15, g.r * 0.7, g.g * 0.7, g.b * 0.7, t.fl === "smoke" ? 0.15 : 0.5);
    this.rib.push(t.trail, t.x, t.y, t.z);
    this.paint.flash(t.x, t.y, t.z, 0.4, t.pal.core, 0.5, 0.12);
    this.paint.ring(t.x, t.y, t.z, 0.45, t.pal.glow, 0.7, 0.22, 0.7);
    this.paint.burst(t.fl, t.x, t.y, t.z, 0.15, t.pal);
  }

  private tickProjectiles(dt: number) {
    const inv = dt > 0 ? 1 / dt : 0;
    for (const t of this.tracked) {
      if (!t.on) continue;
      t.age += dt;
      if (inv) {
        t.vx += ((t.x - t.px) * inv - t.vx) * 0.5;
        t.vy += ((t.y - t.py) * inv - t.vy) * 0.5;
        t.vz += ((t.z - t.pz) * inv - t.vz) * 0.5;
      }
      this.rib.push(t.trail, t.x, t.y, t.z);
      this.paint.trail(t.fl, t.pal, t.px, t.py, t.pz, t.x, t.y, t.z, t.vx, t.vy, t.vz, dt);
      this.paint.head(t.fl, t.pal, t.x, t.y, t.z, t.age, dt, t.shock);
      t.px = t.x; t.py = t.y; t.pz = t.z;
    }
  }

  private tickCharges(dt: number) {
    for (const p of PLAYERS) {
      const c = this.charges[p];
      c.k = c.on ? Math.min(1, c.k + dt * 3.5) : Math.max(0, c.k - dt * 3);
      if (!c.on && c.k <= 0) {
        if (c.outer) { this.decals.free(c.outer); c.outer = null; }
        if (c.inner) { this.decals.free(c.inner); c.inner = null; }
        if (c.column) { this.beams.free(c.column); c.column = null; }
        continue;
      }
      if (c.ref) {
        const pel = Fighters.pos(c.ref, "pelvis", this.v);
        if (pel) { c.x = pel.x; c.z = pel.z; }
      }
      c.spin += dt;
      const e = easeOut(c.k);
      const pulse = 0.85 + 0.15 * Math.sin(this.now * 7);
      if (c.outer) {
        c.outer.mesh.position.set(c.x, 0.025, c.z);
        c.outer.mesh.rotation.set(-Math.PI / 2, 0, c.spin * 0.8);
        c.outer.mesh.scale.setScalar(1.4 * (0.5 + 0.5 * e));
        (c.outer.u.uColor.value as THREE.Color).copy(c.glow).multiplyScalar(1.7);
        c.outer.u.uOpacity.value = e * pulse;
      }
      if (c.inner) {
        c.inner.mesh.position.set(c.x, 0.03, c.z);
        c.inner.mesh.rotation.set(-Math.PI / 2, 0, -c.spin * 1.6);
        c.inner.mesh.scale.setScalar(0.85 * (0.5 + 0.5 * e));
        (c.inner.u.uColor.value as THREE.Color).copy(c.glow).multiplyScalar(2);
        c.inner.u.uOpacity.value = e;
      }
      if (c.column) {
        c.column.mesh.position.set(c.x, 0, c.z);
        c.column.mesh.scale.set(0.45, 2.1 * e, 0.45);
        (c.column.u.uColor.value as THREE.Color).copy(c.glow).multiplyScalar(0.9);
        c.column.u.uOpacity.value = 0.4 * e;
        c.column.u.uTime.value = this.now;
      }
      if (!c.on) continue;
      // motes spiraling up around the fighter
      for (let i = 0, n = Math.floor(dt * 45 * e + Math.random()); i < n; i++) {
        const q = this.ps.reset();
        q.flags = F_ORBIT | F_TWINKLE;
        q.ocx = c.x; q.ocz = c.z; q.oang = rand(0, Math.PI * 2); q.orad = rand(0.3, 0.8); q.ow = rand(1.4, 2.4); q.odr = -0.12;
        q.y = rand(0.03, 0.15); q.vy = rand(0.5, 1.2);
        const star = Math.random() < 0.2;
        q.sprite = star ? SPR.Star4 : SPR.Spark; q.size0 = q.size1 = star ? rand(0.06, 0.09) : rand(0.035, 0.055);
        setc(q, c.glow, star ? 3.2 : 2.6); q.flicker = rand(8, 16); q.life = rand(0.9, 1.6); q.fadeIn = 0.1; q.fadeOut = 0.5;
        this.ps.emit();
      }
    }
  }

  private tickLights(dt: number) {
    for (const f of this.flashes) {
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      f.light.intensity = f.peak * (1 - k) * (1 - k);
    }
    // an idle light rides along with the first projectile, so robots catch its glow as it passes
    const f = this.flashes[1];
    if (f.t >= f.dur) {
      const t = this.tracked.find((x) => x.on);
      if (t) {
        f.light.position.set(t.x, t.y, t.z);
        f.light.color.copy(t.pal.light);
        f.light.intensity = 1.2;
      }
    }
  }

  // ---------- signature effects ----------
  /** earth_wall: hands glow while the seal is held, then on the hit frame stone slabs burst out of the ground
   *  between the fighters, hold, and sink back. */
  private castEarthWall(ks: number, ref: FighterRef | null, caster: THREE.Vector3, dir: number, d: number) {
    // the seal: an earthy glow gathering between the hands until the slam
    this.run(0, d, {
      tick: (k, dt) => {
        const c = this.castPoint(ref, caster, dir, 0.1, this.v);
        this.paint.one(SPR.Dot, c.x, c.y, c.z, 0.1 + 0.25 * k, EARTH_GLOW, 1, 0.5 * k);
        this.paint.one(SPR.Star4, c.x, c.y, c.z, 0.05 + 0.12 * k, WHITE_GOLD, 1, k, this.now * 4);
        for (let i = 0, n = Math.floor(dt * 30 * k + Math.random()); i < n; i++) {
          const p = this.ps.reset();
          const a = Math.random() * Math.PI * 2, r = rand(0.25, 0.5);
          p.x = c.x + Math.cos(a) * r; p.y = c.y + Math.sin(a) * r * 0.6; p.z = c.z + rand(-0.15, 0.15);
          p.vx = -Math.cos(a) * r * 3; p.vy = -Math.sin(a) * r * 1.8; p.drag = 2;
          p.sprite = SPR.Spark; p.size0 = 0.05; p.size1 = 0.015; setc(p, EARTH_GLOW, 1); p.life = rand(0.25, 0.4);
          this.ps.emit();
        }
      },
    });
    const g = this.groundOf(ref, caster, new THREE.Vector3());
    const wx = g.x + dir * 0.62, wz = g.z;
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a6650, roughness: 0.95, metalness: 0.02, flatShading: true,
      emissive: 0x4a2e12, emissiveIntensity: 0.35 });
    const group = new THREE.Group();
    group.name = "earth-wall";
    const slabs: { m: THREE.Mesh; h: number; delay: number }[] = [];
    const n = 7, ux = Math.sin(0.65) * dir, uz = Math.cos(0.65); // the wall line, turned ~37 deg toward the camera
    for (let i = 0; i < n; i++) {
      const mid = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2); // tallest in the middle
      const h = (0.75 + 0.6 * mid + rand(0, 0.2)) * Math.sqrt(ks), wdt = rand(0.24, 0.34);
      const geo = new THREE.BoxGeometry(rand(0.3, 0.42), h, wdt, 2, 4, 2);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) { // rough-hewn: nudge every vertex, taper the top
        const y = pos.getY(v) / h + 0.5;
        pos.setXYZ(v, pos.getX(v) * (1 - 0.35 * y) + rand(-0.03, 0.03), pos.getY(v) + rand(-0.03, 0.03), pos.getZ(v) * (1 - 0.3 * y) + rand(-0.03, 0.03));
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      const o = (i - (n - 1) / 2) * 0.24;
      m.position.set(wx + ux * o + rand(-0.04, 0.04), -h / 2 - 0.05, wz + uz * o);
      m.rotation.set(rand(-0.12, 0.12), 0.65 * dir + rand(-0.25, 0.25), dir * rand(0.04, 0.16));
      group.add(m);
      slabs.push({ m, h, delay: Math.abs(i - (n - 1) / 2) * 0.05 + rand(0, 0.03) });
    }
    const rise = 0.32, hold = 1.7, sink = 0.45, total = rise + 0.2 + hold + sink;
    this.run(d, total, {
      begin: () => {
        this.stage.scene.add(group);
        this.paint.dust(wx, wz, 1.4 * ks, 0.6);
        this.groundRing(wx, wz, 1.8 * ks, EARTH_GLOW, 0.5);
        this.paint.flash(wx, 0.2, wz, 0.9 * ks, EARTH_GLOW, 0.6, 0.2);
        this.light(wx, 0.6, wz, EARTH_LIGHT, 2.4 * ks, 0.35);
        for (let i = 0; i < 70; i++) { // rubble thrown up as the stone breaks the ground
          const p = this.ps.reset();
          const o = rand(-0.85, 0.85); p.x = wx + ux * o + rand(-0.15, 0.15); p.y = 0.05; p.z = wz + uz * o;
          p.vx = dir * rand(-0.6, 1.4); p.vy = rand(1.5, 4); p.vz = rand(-0.8, 0.8); p.grav = -9; p.flags = F_GROUND;
          p.sprite = i % 3 ? SPR.Dot : SPR.Spark; p.size0 = p.size1 = rand(0.025, 0.06); p.blend = 1;
          setc(p, i % 4 ? DUST : EARTH_GLOW, 1); p.life = rand(0.6, 1.1);
          this.ps.emit();
        }
      },
      tick: (k, dt) => {
        const t = k * total;
        for (const s of slabs) {
          const up = THREE.MathUtils.clamp((t - s.delay) / rise, 0, 1);
          const down = THREE.MathUtils.clamp((t - rise - 0.2 - hold) / sink, 0, 1);
          s.m.position.y = -s.h / 2 - 0.05 + s.h * (up < 1 ? easeOutBack(up) : 1) - s.h * down * down;
        }
        if (t < rise + 0.1 || t > total - sink) { // dust skirts the base while the stone moves
          for (let i = 0, n = Math.floor(dt * 90 + Math.random()); i < n; i++) {
            const p = this.ps.reset();
            const o = rand(-0.9, 0.9); p.x = wx + ux * o + rand(-0.2, 0.2); p.y = 0.04; p.z = wz + uz * o;
            p.vx = rand(-0.5, 0.5); p.vy = rand(0.2, 0.7); p.vz = rand(-0.4, 0.4); p.drag = 1.5;
            p.sprite = SPR.Dot; p.size0 = 0.08; p.size1 = 0.25; p.blend = 1; setc(p, DUST, 0.6); p.life = rand(0.5, 0.9);
            this.ps.emit();
          }
        }
      },
      end: () => {
        this.stage.scene.remove(group);
        for (const s of slabs) s.m.geometry.dispose();
        mat.dispose();
      },
    });
  }

  /** spiral_orb: a spinning sphere of energy forms in the right palm and grows until the hit frame, then
   *  bursts outward in a spiral. */
  private castSpiralOrb(P: Pal, ks: number, ref: FighterRef | null, caster: THREE.Vector3, dir: number, d: number) {
    const palm = (out: THREE.Vector3) => {
      const b = ref?.bodies.get("right_wrist_yaw_link");
      if (b) out.setFromMatrixPosition(b.matrixWorld);
      else this.castPoint(ref, caster, dir, 0.3, out);
      out.x += dir * 0.09;
      return out;
    };
    let spin = 0;
    this.run(0, d + 0.06, {
      tick: (k, dt) => {
        const h = palm(this.v);
        const R = (0.08 + 0.13 * Math.min(1, k * 1.3)) * Math.sqrt(ks);
        spin += dt * 20;
        this.paint.one(SPR.Dot, h.x, h.y, h.z, R * 2.8, P.glow, 1, 0.5);
        this.paint.one(SPR.Dot, h.x, h.y, h.z, R * 1.5, P.core, 1, 0.8);
        this.paint.one(SPR.Star8, h.x, h.y, h.z, R * 2.2, WHITE_GOLD, 1, 0.7, spin);
        for (let i = 0, n = Math.floor(dt * 260 + Math.random()); i < n; i++) { // motes racing around 3 tilted rings
          const ring = i % 3, tilt = ring * 1.05 + 0.3, a = spin * (1 + ring * 0.35) + Math.random() * Math.PI * 2;
          const cx = Math.cos(a) * R, sy = Math.sin(a) * R;
          const p = this.ps.reset();
          p.x = h.x + cx; p.y = h.y + sy * Math.cos(tilt); p.z = h.z + sy * Math.sin(tilt);
          const s = 16 * R;
          p.vx = -Math.sin(a) * s; p.vy = Math.cos(a) * s * Math.cos(tilt); p.vz = Math.cos(a) * s * Math.sin(tilt); p.drag = 5;
          p.sprite = SPR.Spark; p.size0 = 0.045; p.size1 = 0.01; p.stretch = 0.12;
          setc(p, i % 2 ? P.core : P.glow, 1); p.life = rand(0.1, 0.22);
          this.ps.emit();
        }
      },
    });
    this.run(d, 0, {
      begin: () => {
        const h = palm(this.v);
        this.paint.flash(h.x, h.y, h.z, 0.3, WHITE_GOLD, 0.35, 0.1);
        this.paint.flash(h.x, h.y, h.z, 0.5, P.glow, 0.25, 0.2);
        this.paint.ring(h.x, h.y, h.z, 0.9, P.glow, 0.8, 0.35, 0.8);
        this.paint.starburst(h.x, h.y, h.z, 0.45, P.glow, 0.5, 0.24);
        for (let i = 0; i < 100; i++) { // the spiral: particles leave along a swirling cone toward the opponent
          const a = i * 0.42, sp = rand(2.2, 5.5), r = rand(0.6, 1.4);
          const p = this.ps.reset();
          p.x = h.x; p.y = h.y; p.z = h.z;
          p.vx = dir * sp; p.vy = Math.cos(a) * sp * 0.45 * r; p.vz = Math.sin(a) * sp * 0.45 * r; p.drag = 3.2;
          p.sprite = i % 4 ? SPR.Spark : SPR.Star4; p.size0 = rand(0.03, 0.07); p.size1 = 0.01; p.stretch = 0.15;
          setc(p, i % 5 ? P.glow : P.core, 0.8); p.life = rand(0.3, 0.55);
          this.ps.emit();
        }
        this.light(h.x, h.y, h.z, P.light, 1.8, 0.3);
      },
    });
  }

  private light(x: number, y: number, z: number, c: THREE.Color, peak: number, dur: number) {
    // A NaN light position turns every lit pixel NaN (black, and the bloom spreads it) until the light is reused.
    if (!Number.isFinite(x + y + z + peak + dur)) return;
    let f = this.flashes[0];
    for (const g of this.flashes) if (g.t / g.dur > f.t / f.dur) f = g;
    f.light.position.set(x, y, z);
    f.light.color.copy(c);
    f.t = 0;
    f.dur = dur;
    f.peak = peak;
  }

  private run(delay: number, dur: number, j: Pick<Job, "begin" | "tick" | "end">) {
    this.jobs.push({ start: this.now + Math.max(0, delay), dur: Math.max(1e-4, dur), begun: false, ...j });
  }

  private tickJobs(dt: number) {
    const jobs = this.jobs;
    let w = 0;
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (this.now < j.start) { jobs[w++] = j; continue; }
      if (!j.begun) { j.begun = true; j.begin?.(); }
      const k = (this.now - j.start) / j.dur;
      if (k >= 1) {
        j.tick?.(1, dt);
        j.end?.();
        continue;
      }
      j.tick?.(k, dt);
      jobs[w++] = j;
    }
    jobs.length = w;
  }

  private decal(map: THREE.Texture, x: number, y: number, z: number, size: number, color: THREE.Color): Slot | null {
    const s = this.decals.get();
    if (!s) return null;
    s.u.uMap.value = map;
    (s.u.uColor.value as THREE.Color).copy(color);
    s.u.uOpacity.value = 0;
    s.u.uReveal.value = 1;
    s.mesh.position.set(x, y, z);
    s.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    s.mesh.scale.setScalar(size);
    return s;
  }

  /** An expanding soft ring on the ground. */
  private groundRing(x: number, z: number, size: number, color: THREE.Color, dur: number) {
    const s = this.decal(this.tex.shockRing, x, 0.03, z, 0.3, color);
    if (!s) return;
    this.run(0, dur, {
      tick: (k) => {
        s.mesh.scale.setScalar(0.3 + (size - 0.3) * easeOut(k));
        s.u.uOpacity.value = 1.4 * (1 - k);
      },
      end: () => this.decals.free(s),
    });
  }

  /** A flat wind swoosh circling a fighter (dodges). */
  private swirl(x: number, y: number, z: number, radius: number, sense: 1 | -1, dur: number) {
    const s = this.swooshes.get();
    if (!s) return;
    s.mesh.position.set(x, y, z);
    s.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    s.mesh.scale.set(radius, radius * sense, radius);
    (s.u.uColor.value as THREE.Color).copy(GHOST).multiplyScalar(0.9);
    s.u.uTail.value = 0.9;
    s.u.uHead.value = 0;
    s.u.uOpacity.value = 1;
    this.run(0, dur, {
      tick: (k) => {
        s.u.uHead.value = Math.min(1.3, (k / 0.6) * 1.3);
        s.u.uOpacity.value = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      },
      end: () => this.swooshes.free(s),
    });
  }

  /** Chest of the fighter (or `fallback`) pushed `fwd` meters toward the opponent. */
  private castPoint(ref: FighterRef | null, fallback: THREE.Vector3, dir: number, fwd: number, out: THREE.Vector3): THREE.Vector3 {
    if (!(ref && Fighters.chest(ref, out))) out.copy(fallback);
    out.x += dir * fwd;
    return out;
  }

  private groundOf(ref: FighterRef | null, fallback: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (!(ref && Fighters.pos(ref, "pelvis", out))) out.copy(fallback);
    out.y = 0;
    return out;
  }

  /** The hand or foot of `ref` closest to `target` (the limb that just struck or cast). */
  private limbToward(ref: FighterRef | null, target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null {
    if (!ref) return null;
    let best = Infinity, found = false;
    for (const n of LIMBS) {
      const b = ref.bodies.get(n);
      if (!b) continue;
      this.w.setFromMatrixPosition(b.matrixWorld);
      const dd = this.w.distanceToSquared(target);
      if (dd < best) { best = dd; out.copy(this.w); found = true; }
    }
    return found ? out : null;
  }
}

function effectOf(effect: string, type: MoveType): Effect {
  return (KNOWN_EFFECTS as string[]).includes(effect) && effect !== "none" ? (effect as Effect) : TYPE_EFFECT[type] ?? "fairy_dust";
}
