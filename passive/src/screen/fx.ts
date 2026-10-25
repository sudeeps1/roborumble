// Effects on the fight screen, driven only by the sim's events and positions. Nothing is per spell: a
// spell looks like its TYPE (fire, ice, lightning, shadow, physical) doing its KIND (projectile,
// strike, shockwave, defend, melee), so a library of 500+ spells needs no art. Also: hit sparks and
// flashes, dust and stone chips where a body hits the floor, the aura of a fighter channeling a spell.
// Everything is pooled; nothing is allocated per frame. MuJoCo frame (meters, Z up).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Arena } from "../core/arena.ts";
import type { ArenaEvent, Who } from "../core/events.ts";
import { LIMBS, type Limb } from "../core/body.ts";
import type { MoveSpec } from "../core/spells.ts";

/** Per spell type: white-hot core, glow, sparks. The HUD uses the same table. */
export const TYPE_COLORS: Record<string, { core: number; glow: number; spark: number }> = {
  fire: { core: 0xfff0c8, glow: 0xff5a14, spark: 0xffa040 },
  ice: { core: 0xf2ffff, glow: 0x38d0ff, spark: 0xb8f2ff },
  lightning: { core: 0xfff2c8, glow: 0xffd84a, spark: 0xfff4b0 }, // a warm core: never clipped white
  shadow: { core: 0xf2dcff, glow: 0x8f3dff, spark: 0xc49aff },
  physical: { core: 0xfff4e2, glow: 0xffb35a, spark: 0xffd9a0 },
};
export const typeColors = (t: string | undefined) => TYPE_COLORS[t ?? ""] ?? TYPE_COLORS.physical;

/** Colours the arena hands in: its dust and its stone. */
export interface FxLook { dust: number; stone: number; fist: number; block: number }

const FX = {
  sparks: 700, motes: 260, chips: 160, dust: 40, rings: 12, flashes: 10, lights: 3, shots: 6, trail: 12,
  strikeDelay: 0.6,     // s from release to landing (spells.ts SPELL.strikeDelay)
  strikeColumn: 0.38,   // s the column stays
  wall: [0.24, 1.15, 1.05] as const, // m: thick, wide, tall (rounded)
  wallAhead: 1.05,      // m in front of the caster at most (halfway to the opponent when closer)
  wallLife: 1.3,        // s
};

const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function softTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.3, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/** A soft band at 86% of the radius, fading both ways: ground rings without a hard line. */
function ringTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,255,255,0)");
  grd.addColorStop(0.6, "rgba(255,255,255,0)");
  grd.addColorStop(0.78, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.86, "rgba(255,255,255,1)");
  grd.addColorStop(0.93, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(cv);
}

/** A vertical beam: bright down the middle, soft at the sides, fading out toward the top. */
function beamTexture() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 256;
  const g = cv.getContext("2d")!;
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, "rgba(255,255,255,0)"); h.addColorStop(0.5, "rgba(255,255,255,1)"); h.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = "destination-in";
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, "rgba(255,255,255,0)"); v.addColorStop(0.5, "rgba(255,255,255,0.9)"); v.addColorStop(0.92, "rgba(255,255,255,1)"); v.addColorStop(1, "rgba(255,255,255,0.4)");
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  return new THREE.CanvasTexture(cv);
}

/** A pool of additive points: sparks and embers with velocity, drag, gravity, fading colour. */
class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array; private col: Float32Array;
  private vel: Float32Array; private base: Float32Array;
  private life: Float32Array; private max: Float32Array; private grav: Float32Array; private drag: Float32Array;
  private next = 0;
  constructor(n: number, size: number, map: THREE.Texture) {
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3); this.base = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.grav = new Float32Array(n); this.drag = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
  }
  emit(p: ArrayLike<number>, v: ArrayLike<number>, color: number, life: number, grav = 1, drag = 1.5, bright = 1) {
    const i = this.next; this.next = (this.next + 1) % this.life.length;
    const k = i * 3;
    this.pos[k] = p[0]; this.pos[k + 1] = p[1]; this.pos[k + 2] = p[2];
    this.vel[k] = v[0]; this.vel[k + 1] = v[1]; this.vel[k + 2] = v[2];
    _c.setHex(color).multiplyScalar(bright);
    this.base[k] = _c.r; this.base[k + 1] = _c.g; this.base[k + 2] = _c.b;
    this.life[i] = life; this.max[i] = life; this.grav[i] = grav; this.drag[i] = drag;
  }
  /** A burst around direction `dir` (unit), cone `spread` (0 = laser, 1 = hemisphere). */
  burst(p: ArrayLike<number>, dir: ArrayLike<number>, n: number, color: number, speed: number, spread: number, life = 0.45, grav = 1) {
    for (let j = 0; j < n; j++) {
      _v.set(dir[0] + rand(-spread, spread), dir[1] + rand(-spread, spread), dir[2] + rand(-spread, spread)).normalize().multiplyScalar(speed * rand(0.35, 1));
      this.emit(p, [_v.x, _v.y, _v.z], color, life * rand(0.6, 1.2), grav, 2.2, rand(0.7, 1.4));
    }
  }
  update(dt: number) {
    if (dt <= 0) return;
    for (let i = 0; i < this.life.length; i++) {
      const k = i * 3;
      if (this.life[i] <= 0) { this.col[k] = this.col[k + 1] = this.col[k + 2] = 0; continue; }
      this.life[i] -= dt;
      const f = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= f; this.vel[k + 1] *= f; this.vel[k + 2] = this.vel[k + 2] * f - 9.8 * this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 2] < 0.005 && this.vel[k + 2] < 0) { this.pos[k + 2] = 0.005; this.vel[k + 2] *= -0.3; }
      const a = Math.max(0, this.life[i] / this.max[i]);
      const fade = a * a;
      this.col[k] = this.base[k] * fade; this.col[k + 1] = this.base[k + 1] * fade; this.col[k + 2] = this.base[k + 2] * fade;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
  clear() { this.life.fill(0); }
}

/** Stone chips: tumbling, bouncing on the floor, sinking away. One instanced mesh. */
class Chips {
  readonly mesh: THREE.InstancedMesh;
  private p: Float32Array; private v: Float32Array; private r: Float32Array; private w: Float32Array;
  private size: Float32Array; private life: Float32Array; private next = 0;
  constructor(n: number, color: number) {
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color, roughness: 1 }), n); // smooth pebbles, no facets
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3); this.r = new Float32Array(n * 4); this.w = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
  }
  /** n chips thrown up and out from p (along `out` if given). */
  spray(p: ArrayLike<number>, n: number, speed: number, out?: ArrayLike<number>, size = 0.03) {
    for (let j = 0; j < n; j++) {
      const i = this.next; this.next = (this.next + 1) % this.life.length;
      const a = Math.random() * Math.PI * 2, s = speed * rand(0.4, 1);
      const ox = out ? out[0] * 0.7 : 0, oy = out ? out[1] * 0.7 : 0;
      this.p.set([p[0] + rand(-0.08, 0.08), p[1] + rand(-0.08, 0.08), Math.max(0.02, p[2])], i * 3);
      this.v.set([(Math.cos(a) * 0.6 + ox) * s, (Math.sin(a) * 0.6 + oy) * s, rand(0.6, 1.3) * s], i * 3);
      _q.setFromAxisAngle(_v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(), rand(0, 6));
      this.r.set([_q.x, _q.y, _q.z, _q.w], i * 4);
      this.w.set([rand(-14, 14), rand(-14, 14), rand(-14, 14)], i * 3);
      this.size[i] = size * rand(0.5, 1.5);
      this.life[i] = rand(0.9, 1.4);
    }
  }
  update(dt: number) {
    if (dt <= 0) return;
    const dq = new THREE.Quaternion();
    for (let i = 0; i < this.life.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      this.v[k + 2] -= 9.8 * dt;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      const rest = this.size[i] * 0.6;
      if (this.p[k + 2] < rest) {
        this.p[k + 2] = rest;
        if (this.v[k + 2] < 0) this.v[k + 2] *= -0.35;
        this.v[k] *= 0.7; this.v[k + 1] *= 0.7;
        this.w[k] *= 0.6; this.w[k + 1] *= 0.6; this.w[k + 2] *= 0.6;
      }
      _q.set(this.r[i * 4], this.r[i * 4 + 1], this.r[i * 4 + 2], this.r[i * 4 + 3]);
      dq.setFromAxisAngle(_v.set(this.w[k], this.w[k + 1], this.w[k + 2]), 1).identity();
      const wl = Math.hypot(this.w[k], this.w[k + 1], this.w[k + 2]);
      if (wl > 1e-3) { dq.setFromAxisAngle(_v.set(this.w[k] / wl, this.w[k + 1] / wl, this.w[k + 2] / wl), wl * dt); _q.premultiply(dq); }
      this.r.set([_q.x, _q.y, _q.z, _q.w], i * 4);
      const s = this.size[i] * Math.min(1, this.life[i] / 0.4); // shrink away at the end
      this.mesh.setMatrixAt(i, _m.compose(_v.set(this.p[k], this.p[k + 1], this.p[k + 2]), _q, _s.setScalar(Math.max(0, s))));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.life.fill(0); for (let i = 0; i < this.life.length; i++) this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); this.mesh.instanceMatrix.needsUpdate = true; }
}

interface Puff { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; grow: number; alpha: number }
interface Ring { m: THREE.Mesh; mat: THREE.MeshBasicMaterial; r0: number; r1: number; life: number; max: number; pulse: boolean }
interface Flash { s: THREE.Sprite; life: number; max: number; size: number }
interface Glow { l: THREE.PointLight; life: number; max: number; peak: number }
interface Shot { core: THREE.Sprite; halo: THREE.Sprite; trail: THREE.Sprite[]; hist: THREE.Vector3[]; live: boolean; type: string; owner: Who }
interface Strike { ring: Ring | null; spot: THREE.Vector3; at: number; type: string; landed: boolean; column: [THREE.Sprite, THREE.Sprite] | null; colT: number }
interface Wall { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; t: number; base: THREE.Vector3 }
interface HandOrb { core: THREE.Sprite; halo: THREE.Sprite; on: boolean; type: string; limb: Limb; level: number }

export class Fx {
  readonly root = new THREE.Group();
  private arena: Arena;
  private look: FxLook;
  private tex = softTexture();
  private beam = beamTexture();
  private sparks: Particles;
  private motes: Particles;
  private chips: Chips;
  private puffs: Puff[] = [];
  private rings: Ring[] = [];
  private flashes: Flash[] = [];
  private glows: Glow[] = [];
  private shots: Shot[] = [];
  private strikes: Strike[] = [];
  private walls: Wall[] = [];
  private orbs: HandOrb[] = [];
  private auras: { ring: Ring; level: number; type: string }[] = [];
  private spells: (name: string) => MoveSpec | undefined;
  private t = 0;
  /** Floor slams the camera should feel: strength 0..1. */
  onSlam: (strength: number, at: number[]) => void = () => {};
  // floor-impact watch: per fighter, per body: last height, last vertical speed, cooldown
  private watch: { body: number; floor: number; weight: number; z: number; vz: number; cool: number }[][] = [];
  private lastSimT = -1;

  constructor(arena: Arena, look: FxLook, spells: (name: string) => MoveSpec | undefined) {
    this.arena = arena;
    this.look = look;
    this.spells = spells;
    this.root.name = "fx";
    this.sparks = new Particles(FX.sparks, 0.035, this.tex);
    this.motes = new Particles(FX.motes, 0.07, this.tex);
    this.chips = new Chips(FX.chips, look.stone);
    this.root.add(this.sparks.points, this.motes.points, this.chips.mesh);
    const sprite = (blending: THREE.Blending, opacity = 1) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, opacity, blending, depthWrite: false, toneMapped: blending !== THREE.AdditiveBlending }));
      s.visible = false;
      this.root.add(s);
      return s;
    };
    for (let i = 0; i < FX.dust; i++) {
      const s = sprite(THREE.NormalBlending);
      s.material.color.setHex(look.dust);
      this.puffs.push({ s, v: new THREE.Vector3(), life: 0, max: 1, grow: 1, alpha: 0.5 });
    }
    const ringGeo = new THREE.CircleGeometry(1, 64), ringTex = ringTexture();
    for (let i = 0; i < FX.rings; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(ringGeo, mat);
      m.visible = false;
      m.renderOrder = 2;
      this.root.add(m);
      this.rings.push({ m, mat, r0: 0, r1: 1, life: 0, max: 1, pulse: false });
    }
    for (let i = 0; i < FX.flashes; i++) this.flashes.push({ s: sprite(THREE.AdditiveBlending), life: 0, max: 1, size: 1 });
    for (let i = 0; i < FX.lights; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 3.5, 1.2); // soft falloff: a tint on the fighters, never a hot spot
      l.visible = false;
      this.root.add(l);
      this.glows.push({ l, life: 0, max: 1, peak: 1 });
    }
    for (let i = 0; i < FX.shots; i++) {
      const trail = Array.from({ length: FX.trail }, () => sprite(THREE.AdditiveBlending));
      this.shots.push({ core: sprite(THREE.AdditiveBlending), halo: sprite(THREE.AdditiveBlending), trail, hist: [], live: false, type: "physical", owner: 0 });
    }
    for (let i = 0; i < 2; i++) {
      this.orbs.push({ core: sprite(THREE.AdditiveBlending), halo: sprite(THREE.AdditiveBlending), on: false, type: "physical", limb: "r_hand", level: 0 });
      const ring = this.rings.pop()!; // two rings kept for the channeling auras
      this.auras.push({ ring, level: 0, type: "physical" });
      const mat = new THREE.MeshStandardMaterial({ color: look.stone, roughness: 0.95, emissive: 0x000000, transparent: true });
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(...FX.wall, 4, 0.12).translate(0, 0, FX.wall[2] / 2), mat);
      mesh.visible = false;
      mesh.castShadow = true;
      this.root.add(mesh);
      this.walls.push({ mesh, mat, t: -1, base: new THREE.Vector3() });
    }
    this.watch = arena.fighters.map((f) => (
      [["pelvis", 0.32, 1], ["torso_link", 0.34, 0.9], ["left_knee_link", 0.12, 0.45], ["right_knee_link", 0.12, 0.45], ["left_wrist_yaw_link", 0.09, 0.25], ["right_wrist_yaw_link", 0.09, 0.25]] as const
    ).map(([n, floor, weight]) => ({ body: f.robot.bodies.get(n)!, floor, weight, z: 1, vz: 0, cool: 0 })));
  }

  // ---------------------------------------------------------------- building blocks

  private puff(p: ArrayLike<number>, n: number, spread: number, size = 0.5, up = 0.25) {
    for (let j = 0; j < n; j++) {
      const q = this.puffs.find((x) => x.life <= 0) ?? this.puffs[j % this.puffs.length];
      const a = Math.random() * Math.PI * 2;
      q.s.position.set(p[0] + Math.cos(a) * spread * 0.3, p[1] + Math.sin(a) * spread * 0.3, Math.max(0.06, p[2]));
      q.v.set(Math.cos(a) * spread * rand(0.6, 1.4), Math.sin(a) * spread * rand(0.6, 1.4), up * rand(0.5, 1.5));
      q.life = q.max = rand(0.9, 1.6);
      q.grow = size * rand(0.7, 1.3);
      q.alpha = rand(0.28, 0.45);
      q.s.scale.setScalar(size * 0.3);
      q.s.visible = true;
    }
  }

  private ring(c: ArrayLike<number>, color: number, r0: number, r1: number, life: number, opacity = 1) {
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.m.position.set(c[0], c[1], 0.012);
    r.mat.color.setHex(color);
    r.mat.opacity = opacity;
    r.r0 = r0; r.r1 = r1; r.life = r.max = life; r.pulse = false;
    r.m.scale.setScalar(r0);
    r.m.visible = true;
    return r;
  }

  private flash(p: ArrayLike<number>, color: number, size: number, life = 0.18) {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.s.position.set(p[0], p[1], p[2]);
    f.s.material.color.setHex(color);
    f.life = f.max = life; f.size = size;
    f.s.visible = true;
  }

  private light(p: ArrayLike<number>, color: number, peak: number, life = 0.25) {
    const g = this.glows.reduce((a, b) => (a.life < b.life ? a : b));
    g.l.position.set(p[0], p[1], Math.max(0.3, p[2]) + 0.45); // lifted off the body so nothing near it blows out
    g.l.color.setHex(color);
    g.life = g.max = life; g.peak = peak;
    g.l.visible = true;
  }

  private limbPos(i: Who, limb: Limb) { return this.arena.fighters[i].body.limbPos(limb); }
  private pelvis(i: Who) { return this.arena.world.rootPos(this.arena.fighters[i].robot); }

  // ---------------------------------------------------------------- the game's calls

  /** A fighter is channeling (its spoken spell is being generated): aura on the floor, rising motes. */
  channel(i: Who, on: boolean, type?: string) {
    this.auras[i].level = on ? 1 : 0;
    if (type) this.auras[i].type = type;
  }

  /** Everything the sim reports. */
  onEvent(e: ArenaEvent) {
    switch (e.type) {
      case "hit": return this.hit(e);
      case "release": return this.release(e.who, e.kind, e.spellType, e.point);
      case "move": {
        const spec = this.spells(e.name);
        if (!spec) return;
        const o = this.orbs[e.who];
        // a server move may name a joint the sim doesn't strike with ("chest"): the sim uses the right hand then
        o.on = true; o.type = spec.type ?? "physical"; o.limb = LIMBS.includes(spec.hitJoint as Limb) ? spec.hitJoint! : "r_hand"; o.level = 0;
        return;
      }
      case "stance":
        if (e.from === "move") this.orbs[e.who].on = false;
        return;
      case "ko": {
        const p = this.pelvis(e.who);
        for (let j = 0; j < 40; j++) this.motes.emit([p[0] + rand(-0.6, 0.6), p[1] + rand(-0.6, 0.6), 0.05], [rand(-0.1, 0.1), rand(-0.1, 0.1), rand(0.3, 0.9)], this.look.fist, rand(1.5, 3), -0.02, 0.4, 0.6);
        return;
      }
      case "reset": return this.clear();
      default: return;
    }
  }

  private hit(e: Extract<ArenaEvent, { type: "hit" }>) {
    const spell = !!e.spellType && e.how !== undefined;
    const col = spell ? typeColors(e.spellType) : null;
    const k = Math.min(1.6, e.impulse / 30);
    const dir = [-e.dir[0], -e.dir[1], -e.dir[2] + 0.25]; // sparks fly back toward the attacker and up
    if (e.blocked) {
      this.sparks.burst(e.point, dir, 14, this.look.block, 2.6, 0.8, 0.3);
      this.flash(e.point, this.look.block, 0.32, 0.12);
      return;
    }
    const spark = col ? col.spark : this.look.fist;
    this.sparks.burst(e.point, dir, Math.round(18 + 30 * k), spark, 3.2 + 2 * k, 0.7, 0.5);
    this.sparks.burst(e.point, e.dir, Math.round(8 + 12 * k), spark, 2.2, 0.5, 0.4); // spray through
    this.flash(e.point, col ? col.glow : 0xffe8c8, 0.32 + 0.3 * k, 0.16);
    this.flash(e.point, col ? col.core : 0xfff2d0, 0.16 + 0.12 * k, 0.09);
    if (col) this.light(e.point, col.glow, 0.9 + 1.2 * k, 0.3);
    if (e.counter || e.clean) this.ring([e.point[0], e.point[1]], col ? col.glow : this.look.fist, 0.2, 1.4, 0.35, 0.7);
    if (e.how === "strike") this.landStrike(e.defender, e.point);
  }

  private release(who: Who, kind: string, type: string, point: number[]) {
    const col = typeColors(type);
    this.orbs[who].on = false;
    this.flash(point, col.glow, 0.45, 0.2);
    this.light(point, col.glow, 1.2, 0.3);
    this.sparks.burst(point, [0, 0, 1], 24, col.spark, 2.4, 1, 0.5, 0.3);
    const foe = (1 - who) as Who;
    if (kind === "strike") {
      // where the defender stands now: the sim aimed it at their spot when the cast started (close enough)
      const p = this.pelvis(foe);
      const s = this.strikes.find((x) => x.landed) ?? this.strikes[this.strikes.length] ?? null;
      const ring = this.ring([p[0], p[1]], col.glow, 0.55, 0.55, FX.strikeDelay + 0.1, 0.9);
      ring.pulse = true;
      const strike: Strike = { ring, spot: new THREE.Vector3(p[0], p[1], 0), at: this.t + FX.strikeDelay, type, landed: false, column: null, colT: 0 };
      if (s) Object.assign(s, strike); else this.strikes.push(strike);
    } else if (kind === "shockwave") {
      const p = this.pelvis(who);
      this.ring([p[0], p[1]], col.glow, 0.3, 1.9, 0.5, 1);
      this.ring([p[0], p[1]], col.spark, 0.2, 1.4, 0.4, 0.6);
      this.puff([p[0], p[1], 0.05], 10, 1.4, 0.7, 0.15);
      this.onSlam(0.55, [p[0], p[1], 0]);
    } else if (kind === "defend") {
      const w = this.walls[who];
      const p = this.pelvis(who), o = this.pelvis(foe);
      const dx = o[0] - p[0], dy = o[1] - p[1], d = Math.hypot(dx, dy) || 1;
      const ahead = Math.min(FX.wallAhead, Math.max(0.55, d * 0.5)); // between them, never past the opponent
      w.base.set(p[0] + (dx / d) * ahead, p[1] + (dy / d) * ahead, 0);
      w.mesh.rotation.set(0, 0, Math.atan2(dy, dx));
      const stone = type === "physical";
      w.mat.color.setHex(stone ? this.look.stone : col.glow);
      w.mat.emissive.setHex(stone ? 0x000000 : col.glow);
      w.mat.emissiveIntensity = stone ? 0 : 1.6;
      w.mat.opacity = stone ? 1 : 0.55;
      w.mat.depthWrite = stone;
      w.t = 0;
      w.mesh.visible = true;
      this.puff([w.base.x, w.base.y, 0.05], 6, 0.8, 0.6, 0.3);
      this.onSlam(0.35, [w.base.x, w.base.y, 0]);
    }
  }

  private landStrike(foe: Who, at: ArrayLike<number> | null) {
    const s = this.strikes.find((x) => !x.landed);
    if (!s) return;
    if (at) s.spot.set(at[0], at[1], 0);
    this.drop(s);
  }

  private drop(s: Strike) {
    s.landed = true;
    if (s.ring) s.ring.life = 0;
    const col = typeColors(s.type);
    // a soft column of the spell's colour from the sky, a ground ring, sparks and dust (stone chips are for bodies hitting the floor)
    if (!s.column) {
      const beam = (o: number) => {
        const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.beam, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
        b.center.set(0.5, 0); // stands on the ground
        this.root.add(b);
        return b;
      };
      s.column = [beam(0.35), beam(0.2)];
    }
    s.column[0].material.color.setHex(col.core);
    s.column[1].material.color.setHex(col.glow);
    for (const b of s.column) { b.position.copy(s.spot); b.visible = true; }
    s.colT = FX.strikeColumn;
    this.ring([s.spot.x, s.spot.y], col.glow, 0.2, 1.6, 0.45, 1);
    this.sparks.burst([s.spot.x, s.spot.y, 0.05], [0, 0, 1], 50, col.spark, 4, 0.9, 0.6);
    this.light([s.spot.x, s.spot.y, 1.2], col.glow, 1.5, 0.35); // gentle: the fighter under it must not wash out
    this.puff([s.spot.x, s.spot.y, 0.05], 8, 1.1, 0.6, 0.2);
    this.onSlam(0.6, [s.spot.x, s.spot.y, 0]);
  }

  /** Projectiles in flight this frame (Arena.projectiles()). */
  private syncShots(list: readonly { pos: number[]; type: string; owner: Who }[]) {
    for (const s of this.shots) s.live = false;
    for (const p of list) {
      let best: Shot | null = null, bd = 0.6;
      for (const s of this.shots) {
        if (s.live || !s.hist.length) continue;
        const d = s.hist[0].distanceTo(_v.set(p.pos[0], p.pos[1], p.pos[2]));
        if (d < bd) { bd = d; best = s; }
      }
      best ??= this.shots.find((s) => !s.live && !s.hist.length) ?? null;
      if (!best) continue;
      best.live = true;
      best.type = p.type; best.owner = p.owner;
      best.hist.unshift(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]));
      if (best.hist.length > FX.trail) best.hist.length = FX.trail;
    }
    for (const s of this.shots) {
      if (!s.live) { s.hist.length = 0; s.core.visible = s.halo.visible = false; for (const t of s.trail) t.visible = false; continue; }
      const col = typeColors(s.type), h = s.hist[0];
      const flick = 1 + Math.sin(this.t * 40 + s.owner) * 0.08;
      s.core.position.copy(h); s.core.scale.setScalar(0.2 * flick); s.core.material.color.setHex(col.core); s.core.visible = true;
      s.halo.position.copy(h); s.halo.scale.setScalar(0.62 * flick); s.halo.material.color.setHex(col.glow); s.halo.visible = true;
      s.trail.forEach((t, j) => {
        const q = s.hist[j + 1];
        t.visible = !!q;
        if (!q) return;
        const a = 1 - (j + 1) / FX.trail;
        t.position.copy(q);
        t.scale.setScalar(0.42 * a + 0.05);
        t.material.color.setHex(col.glow);
        t.material.opacity = 0.75 * a;
      });
      if (Math.random() < 0.7) this.sparks.emit([h.x, h.y, h.z], [rand(-0.4, 0.4), rand(-0.4, 0.4), rand(0, 0.6)], col.spark, rand(0.2, 0.45), 0.3, 1);
    }
  }

  /** dt: sim-scaled seconds (0 freezes with a hit-stop). */
  update(dt: number) {
    this.t += dt;
    this.syncShots(this.arena.projectiles());
    this.sparks.update(dt);
    this.motes.update(dt);
    this.chips.update(dt);
    for (const q of this.puffs) {
      if (q.life <= 0) continue;
      q.life -= dt;
      if (q.life <= 0) { q.s.visible = false; continue; }
      const a = q.life / q.max;
      q.v.multiplyScalar(Math.exp(-2.4 * dt));
      q.s.position.addScaledVector(q.v, dt);
      q.s.scale.setScalar(q.grow * (1.15 - a * 0.85));
      q.s.material.opacity = q.alpha * Math.min(1, a * 1.6);
    }
    for (const r of this.rings) {
      if (r.life <= 0) { r.m.visible = false; continue; }
      r.life -= dt;
      const a = Math.max(0, r.life / r.max);
      if (r.pulse) { r.m.scale.setScalar(r.r0 * (1 + 0.08 * Math.sin(this.t * 22))); r.mat.opacity = 0.5 + 0.4 * Math.sin(this.t * 22); }
      else { r.m.scale.setScalar(r.r0 + (r.r1 - r.r0) * (1 - a * a)); r.mat.opacity = a; }
    }
    for (const f of this.flashes) {
      if (f.life <= 0) { f.s.visible = false; continue; }
      f.life -= dt;
      const a = Math.max(0, f.life / f.max);
      f.s.scale.setScalar(f.size * (1.4 - 0.4 * a));
      f.s.material.opacity = a;
    }
    for (const g of this.glows) {
      if (g.life <= 0) { g.l.visible = false; g.l.intensity = 0; continue; }
      g.life -= dt;
      g.l.intensity = g.peak * Math.max(0, g.life / g.max) ** 2;
    }
    // strikes: land on time even when the sim reports a dodge (the column still comes down)
    for (const s of this.strikes) {
      if (!s.landed && this.t >= s.at + 0.05) this.drop(s);
      if (s.column && s.colT > 0) {
        s.colT -= dt;
        const a = Math.max(0, s.colT / FX.strikeColumn);
        const w = 0.6 + 0.6 * a;
        s.column[0].scale.set(0.14 * w, 6, 1); s.column[1].scale.set(0.9 * w, 6, 1);
        s.column[0].material.opacity = 0.35 * a; s.column[1].material.opacity = 0.2 * a;
        for (const b of s.column) b.visible = a > 0;
      }
    }
    for (const w of this.walls) {
      if (w.t < 0) continue;
      w.t += dt;
      const rise = Math.min(1, w.t / 0.14), fade = 1 - Math.max(0, (w.t - FX.wallLife + 0.3) / 0.3);
      w.mesh.position.set(w.base.x, w.base.y, -FX.wall[2] * (1 - rise));
      w.mesh.scale.set(1, 1, 1);
      if (w.mat.depthWrite) w.mesh.position.z -= FX.wall[2] * (1 - fade); // stone sinks back down
      else w.mat.opacity = 0.55 * fade;
      if (w.t >= FX.wallLife) { w.t = -1; w.mesh.visible = false; }
    }
    this.orbs.forEach((o, i) => {
      o.level += ((o.on ? 1 : 0) - o.level) * (1 - Math.exp(-dt * 10));
      const vis = o.level > 0.02;
      o.core.visible = o.halo.visible = vis;
      if (!vis) return;
      const p = this.limbPos(i as Who, o.limb), col = typeColors(o.type);
      const fl = 1 + 0.12 * Math.sin(this.t * 31 + i * 2);
      o.core.position.set(p[0], p[1], p[2]); o.core.scale.setScalar(0.09 * o.level * fl); o.core.material.color.setHex(col.core);
      o.halo.position.set(p[0], p[1], p[2]); o.halo.scale.setScalar(0.24 * o.level * fl); o.halo.material.opacity = 0.7; o.halo.material.color.setHex(col.glow);
      if (dt > 0 && Math.random() < 0.6) this.sparks.emit(p, [rand(-0.3, 0.3), rand(-0.3, 0.3), rand(0.2, 0.8)], col.spark, rand(0.2, 0.5), -0.1, 1, 0.9);
    });
    this.auras.forEach((a, i) => {
      const r = a.ring;
      const on = a.level > 0;
      r.m.visible = on;
      if (!on) return;
      const p = this.pelvis(i as Who), col = typeColors(a.type);
      r.m.position.set(p[0], p[1], 0.014);
      r.m.scale.setScalar(0.62 + 0.05 * Math.sin(this.t * 6));
      r.mat.color.setHex(col.glow);
      r.mat.opacity = 0.55 + 0.25 * Math.sin(this.t * 6);
      if (dt > 0 && Math.random() < 0.8) {
        const ang = Math.random() * Math.PI * 2;
        this.motes.emit([p[0] + Math.cos(ang) * 0.55, p[1] + Math.sin(ang) * 0.55, 0.05], [0, 0, rand(0.5, 1.2)], col.spark, rand(0.8, 1.4), -0.03, 0.6, 0.8);
      }
    });
    this.watchFloor();
  }

  /** Bodies slamming into the floor: dust, chips, and a call to shake the camera. */
  private watchFloor() {
    const now = this.arena.time;
    const dt = now - this.lastSimT;
    this.lastSimT = now;
    if (dt <= 0 || dt > 0.2) return;
    const xp = this.arena.world.data.xpos;
    this.watch.forEach((list) => {
      for (const w of list) {
        const z = xp[w.body * 3 + 2];
        const vz = (z - w.z) / dt;
        w.cool = Math.max(0, w.cool - dt);
        // was coming down fast, now near the floor and stopped
        if (w.cool === 0 && w.vz < -1.1 && z < w.floor && vz > w.vz * 0.35) {
          const s = Math.min(1, (-w.vz - 0.8) / 2.6) * w.weight;
          const p = [xp[w.body * 3], xp[w.body * 3 + 1], 0.04];
          if (s > 0.08) {
            this.puff(p, Math.round(3 + 7 * s), 0.5 + 0.7 * s, 0.45 + 0.4 * s, 0.25);
            this.chips.spray(p, Math.round(3 + 9 * s), 1.4 + 1.8 * s);
            this.onSlam(s, p);
          }
          w.cool = 0.35;
        }
        w.vz = vz; w.z = z;
      }
    });
  }

  clear() {
    this.sparks.clear(); this.motes.clear(); this.chips.clear();
    for (const q of this.puffs) { q.life = 0; q.s.visible = false; }
    for (const r of this.rings) r.life = 0;
    for (const s of this.strikes) { s.landed = true; if (s.column) for (const b of s.column) b.visible = false; s.colT = 0; }
    for (const w of this.walls) { w.t = -1; w.mesh.visible = false; }
    for (const o of this.orbs) { o.on = false; o.level = 0; }
  }
}
