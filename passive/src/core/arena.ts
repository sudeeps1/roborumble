// Two fighters in one MuJoCo world. The arena owns the clock, the combat between the fighters,
// the event stream, hit damage and HP, the referee's housekeeping (soft ropes, keeping the bodies
// apart, breaking clinches, a leash that keeps them in range), and the recovery when the physics
// blows up. tick() never throws: errors are counted, reported as failsafe events, and the fight
// goes on.
import type { Attack } from "./attacks.ts";
import { Combat, type HitResult, type Impact } from "./combat.ts";
import type { ArenaEvent, ArenaListener, Who } from "./events.ts";
import { Fighter, type InstantHit, missedInstant } from "./fighter.ts";
import type { MotionSource } from "./motion.ts";
import { SPELL } from "./spells.ts";
import { RING_RADIUS } from "./scene.ts";
import { SUBSTEPS, type SonicPolicy } from "./sonic.ts";
import type { World } from "./world.ts";

/** Where the fighters start: x, y, yaw. */
export const SPAWNS: readonly (readonly [number, number, number])[] = [[-0.7, 0, 0], [0.7, 0, Math.PI]];

/** HP lost per N s of impulse, by zone. A power-1 head hook at 4 m/s takes ~19 of 100. */
export const DAMAGE = { head: 0.72, torso: 0.55, legs: 0.35, blocked: 0.12, counter: 1.25 };

export const REFEREE = {
  rope: RING_RADIUS + 0.25,   // m: past this the ropes push back
  ropeK: 900, ropeD: 150,     // N/m, N s/m
  apart: 0.42, apartK: 1500,  // pelvises closer than this get pushed apart (m, N/m)
  clinch: 0.45, clinchT: 1,   // standing that close for that long is a clinch; the referee separates them
  breakForce: 120,            // N, the referee's push while breaking a clinch
  leash: 3.4, leashK: 60,     // m, N/m: farther apart than this, a gentle pull together
};

/** Something that drives a fighter: the sparring AI, a player's phone, the game's round flow. */
export interface Brain { think(t: number, dt: number): void }

export interface ArenaOptions { names?: [string, string]; seeds?: [number, number]; hp?: number; autoKO?: boolean }

export class Arena {
  readonly world: World;
  readonly combat = new Combat();
  readonly fighters: [Fighter, Fighter];
  readonly brains: [Brain | null, Brain | null] = [null, null];
  /** Sim time (s) of the next tick. */
  time = 0;
  ticks = 0;
  readonly maxHp: number;
  hp: [number, number];
  /** KO a fighter when its HP reaches 0. Off: the game decides and calls knockOut(). */
  autoKO: boolean;
  readonly stats = { restores: 0, respawns: 0, errors: 0, clinches: 0, ropeTicks: 0, hits: 0, whiffs: 0 };
  lastError = "";
  private listeners: ArenaListener[] = [];
  private queue: ArenaEvent[] = [];
  private depth = 0;
  private delivering = false;
  private snap: ReturnType<World["snapshot"]> | null = null;
  private lastRestoreT = -Infinity;
  private clinchFor = 0;
  private inClinch = false;
  private forces: { body: number; f: number[] }[] = [];
  private busy = false;
  private resetPending = false;

  constructor(world: World, policy: SonicPolicy, opts: ArenaOptions = {}) {
    if (world.robots.length < 2) throw new Error("the arena needs a world with two robots");
    this.world = world;
    this.maxHp = opts.hp ?? 100;
    this.hp = [this.maxHp, this.maxHp];
    this.autoKO = opts.autoKO ?? true;
    const names = opts.names ?? ["P1", "P2"];
    const seeds = opts.seeds ?? [7, 99];
    const emit = (e: ArenaEvent) => this.emit(e);
    const batch = <T>(fn: () => T): T => this.batch(fn);
    const make = (i: Who) => new Fighter(names[i], { index: i, world, robot: world.robots[i], policy, combat: this.combat, clock: () => this.time, emit, batch, seed: seeds[i] });
    this.fighters = [make(0), make(1)];
    this.fighters[0].opponent = this.fighters[1];
    this.fighters[1].opponent = this.fighters[0];
    this.combat.onHit = (imp, target, res) => this.scoreHit(imp, target, res);
    this.combat.onWhiff = (a, name, reason, closest) => { this.stats.whiffs++; this.emit({ type: "whiff", attacker: a.index, name, reason, closest: Number.isFinite(closest) ? closest : 9 }); };
    this.combat.onRelease = (a, spec, point) => this.emit({ type: "release", who: a.index, name: spec.name, kind: spec.kind, spellType: spec.type ?? "physical", effect: spec.effect ?? "none", point });
  }

  /** Where both fighters get their motion (null: hold a standing guard, assisted get-ups). */
  setMotion(src: MotionSource | null) { for (const f of this.fighters) f.motion = src; }

  setBrain(i: Who, b: Brain | null) { this.brains[i] = b; }

  /** Subscribe to events; returns the unsubscribe function. */
  on(cb: ArenaListener): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }

  /**
   * Runs a state change as one step: events raised inside are delivered when the outermost change
   * is done, in order. Listeners never run in the middle of a change, so whatever they do (a KO, a
   * reset, a new punch) starts from a settled state.
   */
  batch<T>(fn: () => T): T {
    this.depth++;
    try { return fn(); } finally { if (--this.depth === 0) this.deliver(); }
  }

  private emit(e: ArenaEvent) {
    this.queue.push(e);
    if (this.depth === 0) this.deliver();
  }

  private deliver() {
    if (this.delivering) return; // a listener's own events join the loop below, in order
    this.delivering = true;
    try {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        for (const l of this.listeners) {
          try { l(e); } catch (err) { this.stats.errors++; this.lastError = `listener: ${err instanceof Error ? err.message : String(err)}`; }
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  /** New match: both fighters back on their marks, full HP. Called mid-tick, it waits for the tick to end. */
  reset() {
    if (this.busy) { this.resetPending = true; return; }
    this.resetPending = false;
    this.batch(() => {
      this.combat.clear();
      SPAWNS.forEach(([x, y, yaw], i) => this.fighters[i].spawn(x, y, yaw));
      this.hp = [this.maxHp, this.maxHp];
      this.clinchFor = 0; this.inClinch = false;
      this.forces = [];
      this.world.clearForces();
      this.snap = this.world.snapshot();
      this.emit({ type: "reset" });
    });
  }

  /** Projectiles in flight, for drawing (the game's Sim.projectiles()). */
  projectiles(): { pos: number[]; type: string; effect: string; owner: Who }[] {
    return this.combat.projectiles().map((p) => ({ pos: p.pos, type: p.type, effect: p.effect, owner: p.owner.index }));
  }

  /** Pelvis-to-pelvis distance (m). */
  distance() {
    const a = this.world.rootPos(this.fighters[0].robot), b = this.world.rootPos(this.fighters[1].robot);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /** The rig's instant attacks: `attack` lands on fighter `target`, thrown from the other one. */
  hitInstant(target: Who, attack: Attack, scale = 1): InstantHit {
    if (target !== 0 && target !== 1) return missedInstant("no such fighter");
    const d = this.fighters[target];
    return this.batch(() => d.hitInstant(attack, this.world.rootPos(d.opponent.robot), scale, (imp, res) => this.scoreHit(imp, d, res)));
  }

  private scoreHit(imp: Impact, target: Fighter, res: HitResult) {
    if (!res.landed) return;
    this.stats.hits++;
    const i = target.index;
    // a spell's damage comes from its move rules (spells.ts); a fist's from how hard it landed
    const damage = imp.damage !== undefined
      ? imp.damage * (res.blocked ? SPELL.blockMult : 1)
      : Math.max(0, imp.impulse) * DAMAGE[imp.zone] * (res.blocked ? DAMAGE.blocked : 1) * (imp.counter ? DAMAGE.counter : 1);
    this.hp[i] = Math.max(0, this.hp[i] - (Number.isFinite(damage) ? damage : 0));
    this.emit({ type: "hit", attacker: imp.attacker?.index ?? null, defender: i, name: imp.name, zone: imp.zone, point: imp.point, dir: imp.dir, impulse: imp.impulse, damage, hp: this.hp[i], blocked: res.blocked, counter: imp.counter, knockdown: res.knockdown, stance: target.stance, how: imp.how, spellType: imp.type, effect: imp.effect, clean: imp.clean });
    if (this.autoKO && this.hp[i] <= 0 && target.stance !== "ko") target.knockOut();
  }

  /** One 20 ms control tick: brains, fighters, combat, referee, then 4 physics steps. Never throws. */
  async tick() {
    if (this.busy) return; // a caller didn't await the last tick: never run two at once
    this.busy = true;
    try {
      const dt = SUBSTEPS * this.world.dt;
      for (const b of this.brains) if (b) { try { b.think(this.time, dt); } catch (e) { this.error(e, "brain"); } }
      for (const f of this.fighters) { try { await f.tick(); } catch (e) { this.error(e, f.name); } }
      try { this.batch(() => this.combat.step(this.time)); } catch (e) { this.error(e, "combat"); }
      try { this.referee(dt); } catch (e) { this.error(e, "referee"); this.forces = []; }
      const t0 = this.world.data.time;
      try {
        for (let s = 0; s < SUBSTEPS; s++) {
          this.world.clearForces();
          for (const f of this.fighters) f.substep(this.world.dt);
          for (const { body, f } of this.forces) this.world.applyForce(body, f, this.world.bodyPos(body));
          this.world.step();
        }
      } catch (e) { this.error(e, "physics"); }
      this.time += dt;
      this.ticks++;
      // MuJoCo resets its data itself when the simulation goes unstable (time drops back to 0)
      if (this.world.unstable() || this.world.data.time < t0) this.batch(() => this.recover());
      else if (this.ticks % 25 === 0) this.snap = this.world.snapshot();
    } catch (e) {
      this.error(e, "tick");
    } finally {
      this.busy = false;
    }
    if (this.resetPending) this.reset();
  }

  /** Forces the referee adds this tick (applied on every physics step). */
  private referee(dt: number) {
    this.forces = [];
    const [a, b] = this.fighters;
    const pelvis = (f: Fighter) => f.robot.bodies.get("pelvis")!;
    // soft ropes
    for (const f of this.fighters) {
      const p = this.world.rootPos(f.robot), v = f.rootVelocity();
      const r = Math.hypot(p[0], p[1]);
      if (r > REFEREE.rope && Number.isFinite(r)) {
        const nx = p[0] / r, ny = p[1] / r;
        const F = Math.min(600, REFEREE.ropeK * (r - REFEREE.rope) + REFEREE.ropeD * Math.max(0, v[0] * nx + v[1] * ny));
        this.forces.push({ body: pelvis(f), f: [-nx * F, -ny * F, 0] });
        this.stats.ropeTicks++;
      }
    }
    const pa = this.world.rootPos(a.robot), pb = this.world.rootPos(b.robot);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], d = Math.hypot(dx, dy);
    if (!Number.isFinite(d)) return;
    const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0;
    const apart = (F: number) => this.forces.push({ body: pelvis(a), f: [-ux * F, -uy * F, 0] }, { body: pelvis(b), f: [ux * F, uy * F, 0] });
    // bodies pressed together: push the pelvises apart
    if (d < REFEREE.apart) apart(Math.min(400, REFEREE.apartK * (REFEREE.apart - d)));
    // standing chest to chest for a while is a clinch: the referee breaks it up
    if (d < REFEREE.clinch && a.standing() && b.standing()) {
      this.clinchFor += dt;
      if (!this.inClinch && this.clinchFor > REFEREE.clinchT) { this.inClinch = true; this.stats.clinches++; this.emit({ type: "clinch", a: 0, b: 1 }); }
      if (this.inClinch) apart(REFEREE.breakForce);
    } else if (d > REFEREE.clinch + 0.2 || !a.standing() || !b.standing()) {
      this.clinchFor = 0; this.inClinch = false;
    }
    // leash: too far apart, a gentle pull together (footwork does most of the work)
    if (d > REFEREE.leash && a.standing() && b.standing()) apart(-Math.min(80, REFEREE.leashK * (d - REFEREE.leash)));
  }

  /** The physics blew up: roll back to the last good snapshot, or stand both fighters back up. */
  private recover() {
    this.stats.restores++;
    const again = this.time - this.lastRestoreT < 1; // it blew up again right after a rollback
    this.lastRestoreT = this.time;
    let ok = false;
    if (this.snap && !again) {
      this.world.restore(this.snap);
      ok = !this.world.unstable();
    }
    this.combat.clear();
    this.forces = [];
    if (ok) {
      for (const f of this.fighters) f.afterRestore();
      this.emit({ type: "failsafe", who: null, what: "physics blew up: rolled back" });
      return;
    }
    // no usable snapshot: both back on their marks (the fight and HP carry on)
    this.stats.respawns++;
    this.world.data.qvel.fill(0);
    this.world.data.qacc_warmstart?.fill?.(0);
    this.world.clearForces();
    SPAWNS.forEach(([x, y, yaw], i) => this.fighters[i].relocate(x, y, yaw)); // a KO'd body stays KO'd
    this.world.forward();
    this.snap = this.world.snapshot();
    this.emit({ type: "failsafe", who: null, what: "physics blew up: both fighters respawned" });
  }

  private error(e: unknown, where: string) {
    this.stats.errors++;
    const msg = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    if (msg !== this.lastError) this.emit({ type: "failsafe", who: null, what: msg });
    this.lastError = msg;
  }

  /** A snapshot of everything the HUD shows. */
  summary() {
    return {
      time: this.time,
      distance: this.distance(),
      hp: [...this.hp],
      fighters: this.fighters.map((f) => ({ name: f.name, ...f.debug(), stats: { ...f.stats } })),
      stats: { ...this.stats },
      lastError: this.lastError,
    };
  }
}
