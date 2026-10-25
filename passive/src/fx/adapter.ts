// Drives the game screen's spell and hit effects (effects.ts and the rest of this folder, copied from
// client/src/render on vaibhav/server) from the rig's physics: the arena's events, the projectiles in
// flight and the MuJoCo body poses.
//
// Frames: the effects work in three.js's usual frame (Y up); the rig's scene is MuJoCo's (Z up). `root` is a
// group turned a quarter turn about X, so everything the effects add under it lands in the right place.
// The effects follow the fighters (fighters.ts) by reading matrixWorld, so the stand-ins they read live in a
// hierarchy of their own that is never drawn, whose top is turned the other way like the game's stage.world:
// there, world coordinates ARE the effects' frame. One root per fighter, one group per G1 body (named like
// the MJCF, posed from MuJoCo every frame) and the game's chest anchor. (The View has no per-body groups to
// reuse: it draws one mesh per geom, in the Z-up frame.)
//
// Clock: the effects run on the sim clock (arena.time), so pause, slow-mo and a machine that can't keep up
// hold them with the fight. The projectiles and bodies they follow move in the same 20 ms steps.
import * as THREE from "three";
import type { ArenaEvent, Who } from "../core/events.ts";
import type { World } from "../core/world.ts";
import { MOVE_TYPES, TYPE_EFFECT, type Kind, type MoveType, type Player, type Stage } from "./config.ts";
import { Effects, type ProjectileView } from "./effects.ts";

/** A projectile in flight (Arena.projectiles()): MuJoCo world position, spell type and effect, owner (0, 1). */
export interface ShotView { pos: ArrayLike<number>; type: string; effect?: string; owner: number }

const KINDS: readonly string[] = ["melee", "projectile", "strike", "shockwave", "defend"];
/** The game's chest anchor (RobotView "anchor:chest"): front of the chest plate, in torso_link's frame. */
const CHEST = [0.086, 0, 0.2] as const;
/** As the game screen: the KO's fairy dust starts this long after the KO (s), once the body is down. */
const KO_DELAY = 1.2;
/** As the game's sim: a falling body is down (dust, leaves) as its pelvis drops below this (m). */
const DOWN_PELVIS = 0.4;

/** MuJoCo (x, y, z), Z up -> the effects' frame (x, z, -y), Y up. The game's mjToThree. */
export function mjToFx(p: ArrayLike<number>, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p[0], p[2], -p[1]);
}

const moveType = (t: string | undefined): MoveType => ((MOVE_TYPES as string[]).includes(t ?? "") ? (t as MoveType) : "physical");

interface StandIn { bodies: [number, THREE.Object3D][]; chest: THREE.Object3D; pelvis: THREE.Object3D; pelvisId: number }

export class GameFx {
  /** Add it to the rig's scene: the effects' Y-up frame. */
  readonly root = new THREE.Group();
  readonly effects: Effects;
  /** Camera shake (m) for the view to add this frame (the game's stage.shake); decays by itself. */
  shake = 0;
  private readonly world: World;
  private readonly glow: readonly number[];
  private readonly stage = new THREE.Group(); // the game's stage.world: holds the stand-ins, never drawn
  private readonly fighters: StandIn[] = [];
  private readonly cam = { position: new THREE.Vector3() };
  private feed: { projectiles: () => readonly ShotView[]; time: () => number } | null = null;
  private now = 0;    // effect clock (s)
  private simT = NaN; // sim time at the last update
  private readonly falling = [false, false];
  private readonly casting = [0, 0]; // per fighter: its spell's effects id, until the spell is released
  private kos: { who: number; at: number }[] = [];
  private readonly shots: ProjectileView[] = [];
  private readonly list: ProjectileView[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();

  /** `glow`: each fighter's colour (0xRRGGBB), for its KO dust. */
  constructor(world: World, glow: readonly number[]) {
    this.world = world;
    this.glow = glow;
    this.root.name = "game-fx";
    this.root.rotation.x = Math.PI / 2;   // the effects' Y up -> the scene's Z up
    this.stage.rotation.x = -Math.PI / 2; // MuJoCo poses inside the effects' frame
    for (const r of world.robots) {
      const root = new THREE.Group();
      const bodies: [number, THREE.Object3D][] = [];
      for (const [name, id] of r.bodies) {
        const g = new THREE.Group();
        g.name = name;
        root.add(g);
        bodies.push([id, g]);
      }
      const chest = new THREE.Object3D();
      chest.name = "anchor:chest";
      chest.position.set(...CHEST);
      (root.getObjectByName("torso_link") ?? root).add(chest);
      const pelvisId = r.bodies.get("pelvis") ?? bodies[0][0];
      this.fighters.push({ bodies, chest, pelvis: root.getObjectByName("pelvis") ?? root, pelvisId });
      this.stage.add(root);
    }
    const stage: Stage = { scene: this.root, world: this.stage, camera: this.cam, shake: (k) => this.addShake(k) };
    this.effects = new Effects(stage);
  }

  /** Where the projectiles come from (Arena.projectiles()) and the sim clock (arena.time). */
  track(projectiles: () => readonly ShotView[], time: () => number) {
    this.feed = { projectiles, time };
    this.simT = NaN;
  }

  /** Every arena event. */
  event(e: ArenaEvent) {
    switch (e.type) {
      case "cast": { // the clip starts: wind-up now, the release and what follows hitIn s later
        this.pose();
        const type = moveType(e.spellType);
        const effect = e.effect && e.effect !== "none" ? e.effect : TYPE_EFFECT[type];
        const kind = (KINDS.includes(e.kind) ? e.kind : "melee") as Kind;
        const power = Math.min(3, Math.max(1, Math.round(e.power) || 1)) as 1 | 2 | 3;
        const caster = this.center(e.who, this.a);
        // at the defender's chest, over the spot the physics lands it on (where they stood at the cast)
        const target = this.center(1 - e.who, this.b);
        mjToFx(e.target, this.c);
        target.x = this.c.x;
        target.z = this.c.z;
        // the effects' clock stands at the last frame; the sim has run on since (events come mid-physics)
        const lag = this.feed && Number.isFinite(this.simT) ? Math.max(0, this.feed.time() - this.simT) : 0;
        this.casting[e.who] = this.effects.cast({ effect, type, kind, power }, caster, target, e.hitIn + lag);
        break;
      }
      case "release": // it went off: everything the cast set up plays out
        this.casting[e.who] = 0;
        break;
      case "stance": // the move ended before its hit frame (hit, fell, KO'd): the spell fizzled
        if (e.from === "move") this.fizzle(e.who);
        break;
      case "hit": {
        this.pose();
        const at = mjToFx(e.point, this.a);
        if (e.blocked) { this.effects.blocked(at); break; }
        this.effects.hit(at, moveType(e.spellType), !!e.clean, e.damage);
        const strength = Math.min(1.5, Math.max(0.3, e.damage / 14)) * (e.clean ? 1.25 : 1);
        this.addShake(0.012 + 0.03 * strength);
        break;
      }
      case "whiff":
        if (e.reason === "dodged") { this.pose(); this.effects.dodged(this.center(1 - e.attacker, this.a)); }
        break;
      case "knockdown":
      case "fall": // down() when the pelvis gets low (see update), or at "down" at the latest
        this.falling[e.who] = true;
        break;
      case "down":
        if (this.falling[e.who]) this.down(e.who);
        break;
      case "ko":
        this.falling[e.who] = false;
        this.kos.push({ who: e.who, at: this.now + KO_DELAY });
        this.addShake(0.08);
        break;
      case "spawn":
        this.forget(e.who);
        break;
      case "reset":
        this.forget(0);
        this.forget(1);
        break;
      default:
        break;
    }
  }

  /** Every frame, after the physics. dt: wall-clock seconds (the shake decays with it). */
  update(dt: number, camera: THREE.Camera) {
    let step = dt;
    if (this.feed) {
      const t = this.feed.time();
      step = Number.isFinite(this.simT) && t >= this.simT ? Math.min(t - this.simT, 0.1) : 0; // a reset sets it back
      this.simT = t;
    }
    this.now += step;
    this.pose();
    const xp = this.world.data.xpos;
    this.fighters.forEach((f, i) => { if (this.falling[i] && xp[3 * f.pelvisId + 2] < DOWN_PELVIS) this.down(i); });
    for (let k = this.kos.length - 1; k >= 0; k--) {
      const ko = this.kos[k];
      if (this.now < ko.at) continue;
      this.kos.splice(k, 1);
      this.effects.ko(this.feet(ko.who, this.a), this.glow[ko.who] ?? 0xffffff);
    }
    const cam = camera.getWorldPosition(this.c);
    this.cam.position.set(cam.x, cam.z, -cam.y); // the ribbons face it
    if (this.feed) {
      const src = this.feed.projectiles();
      this.list.length = 0;
      for (let i = 0; i < src.length; i++) {
        const q = src[i];
        const v = (this.shots[i] ??= { pos: new THREE.Vector3(), type: "physical", effect: "none", owner: 1 });
        mjToFx(q.pos, v.pos);
        v.type = moveType(q.type);
        v.effect = q.effect ?? "none";
        v.owner = (q.owner + 1) as Player;
        this.list.push(v);
      }
      this.effects.projectiles(this.list);
    }
    this.effects.update(step, this.now);
    this.shake *= Math.exp(-dt * 9);
  }

  private addShake(k: number) { this.shake = Math.min(0.15, this.shake + k); }

  /** The stand-ins to the current MuJoCo body poses. */
  private pose() {
    const d = this.world.data, xp = d.xpos, xq = d.xquat;
    for (const f of this.fighters) {
      for (const [b, g] of f.bodies) {
        g.position.set(xp[3 * b], xp[3 * b + 1], xp[3 * b + 2]);
        g.quaternion.set(xq[4 * b + 1], xq[4 * b + 2], xq[4 * b + 3], xq[4 * b]);
      }
    }
    this.stage.updateMatrixWorld(true);
  }

  /** Fighter i's chest point (the game's RobotView.center()), effects' frame. */
  private center(i: number, out: THREE.Vector3) { return out.setFromMatrixPosition(this.fighters[i].chest.matrixWorld); }

  /** The ground under fighter i's pelvis (the game's RobotView.feet()), effects' frame. */
  private feet(i: number, out: THREE.Vector3) {
    out.setFromMatrixPosition(this.fighters[i].pelvis.matrixWorld);
    out.y = 0.01;
    return out;
  }

  private down(i: number) {
    this.falling[i] = false;
    this.pose();
    this.effects.down(this.feet(i, this.a));
    this.addShake(0.04);
  }

  private fizzle(i: number) {
    this.effects.cancel(this.casting[i]);
    this.casting[i] = 0;
  }

  /** Fighter i starts over (spawn, reset): nothing pending for it carries on. */
  private forget(i: Who) {
    this.fizzle(i);
    this.falling[i] = false;
    this.kos = this.kos.filter((k) => k.who !== i);
  }
}
