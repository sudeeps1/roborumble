// Fighters hitting each other. A move arms strike windows: when which limb (a sphere on a fist,
// foot, elbow, knee or the head) can hurt. Each window resolves once, in one of two modes:
//   contact (default): every control tick the limb is tested against the defender's hurt volumes
//     (with a forgiving `reach` margin). A hit needs contact AND a limb moving at strike speed, not
//     away from the body. A blocking defender's forearms are in the way too: meeting them is a
//     blocked hit.
//   rules: at the window's key time the strike lands unless the defender is dodging it or is
//     farther than `rulesReach`. For moves that don't aim (Kimodo clips), where the game's rules
//     decide whether a hit lands and the physics only delivers it.
// Dodges are rules in both modes (Fighter.evades): a strike at a zone the defender is evading misses.
// How hard a hit lands scales with the move's power, the zone hit, the strike's speed, and (in
// contact mode) how square it lands: a glancing hook pushes less than a straight.
// Each tick resolves in two phases: first every window that connects is found, then the hits are
// applied. Two strikes that land in the same tick both land (a trade), whichever was armed first.
import { type Contact, LIMBS, type Limb, type Zone } from "./body.ts";
import type { WhiffReason } from "./events.ts";
import type { Fighter } from "./fighter.ts";
import type { StrikeWindow } from "./motion.ts";
import { type MoveSpec, SPELL, type checkSpec, spellDamage } from "./spells.ts";

type Spec = NonNullable<ReturnType<typeof checkSpec>>;

/** N s pushed into the defender by a power-1 strike arriving at 4 m/s. */
export const ZONE_IMPULSE: Record<Zone, number> = { head: 26, torso: 30, legs: 20 };
/** Balance (poise, 0..1) a power-1 strike at 4 m/s takes away: ~3 clean hooks put a fighter down. */
export const ZONE_POISE: Record<Zone, number> = { head: 0.5, torso: 0.42, legs: 0.35 };
/** Below this strike speed (m/s) a contact is a touch, not a hit. */
export const MIN_HIT_SPEED = 1.0;
export const MAX_POWER = 3;
/** Shortest window (s): one control tick, so every window gets tested at least once. */
const MIN_WINDOW = 0.02;

export type HitMode = "contact" | "rules";

export interface Impact {
  attacker: Fighter | null; // null: a hit from outside (the rig's instant attacks)
  name: string;
  zone: Zone;
  body: number;     // MuJoCo body that takes the push
  point: number[];  // world contact point
  dir: number[];    // world unit push direction
  speed: number;    // closing speed at contact (m/s)
  impulse: number;  // N s before blocking
  poise: number;    // balance damage before blocking
  counter: boolean; // the defender was in the middle of its own attack
  guard?: boolean;  // it met the defender's forearms
  // set for spells and other server moves (spells.ts): the damage comes from the move's rules
  damage?: number;    // before blocking
  knockdown?: boolean; // the rules say this one knocks down
  clean?: boolean;
  how?: string;       // melee, projectile, strike, shockwave
  type?: string;
  effect?: string;
}

export interface HitResult { landed: boolean; blocked: boolean; knockdown: boolean; ignored?: string }

interface Live { attacker: Fighter; target: Fighter; w: StrikeWindow; t0: number; done: boolean; touched: boolean; evaded: boolean; closest: number }
/** A move whose hit is decided by its kind at its hit time (spells.ts). */
interface Cast { attacker: Fighter; target: Fighter; spec: Spec; at: number; spot: number[]; done: boolean }
/** A strike called down from above, landing later. */
interface Strike { attacker: Fighter; target: Fighter; spec: Spec; at: number; spot: number[] }
/** A projectile in flight. */
export interface Projectile { owner: Fighter; target: Fighter; spec: Spec; pos: number[]; vel: number[]; aim: number[]; locked: boolean; missed: boolean; ttl: number; age: number }
interface Hit { attacker: Fighter; name: string; imp: Impact; closest: number }

export class Combat {
  mode: HitMode = "contact";
  /** contact mode: a strike counts this close to a hurt volume (m); hitboxes a bit bigger than the body. */
  reach = 0.05;
  /** rules mode: farther than this from every hurt volume at the key time, it misses (m). */
  rulesReach = 0.45;
  private live: Live[] = [];
  private casts: Cast[] = [];
  private strikes: Strike[] = [];
  private flying: Projectile[] = [];
  /** Attackers whose strike connected this tick, while those hits are being applied. */
  private landing = new Set<Fighter>();
  /** Called for every landed hit, after the push and before the defender's reaction. */
  onHit: (imp: Impact, target: Fighter, res: HitResult) => void = () => {};
  /** closest: nearest the limb got to a hurt volume (m; below 0 it touched, too slowly to hurt). */
  onWhiff: (attacker: Fighter, name: string, reason: WhiffReason, closest: number) => void = () => {};
  /** A spell left its caster at its hit frame (a projectile spawned, a strike was called, a wall rose). */
  onRelease: (caster: Fighter, spec: MoveSpec, point: number[]) => void = () => {};

  /** A move (spells.ts) whose hit resolves by its kind at sim time `at`. `spot`: where the defender stood when it started. */
  cast(attacker: Fighter, target: Fighter, spec: Spec, at: number, spot: number[]) {
    if (!Number.isFinite(at) || attacker === target) return;
    this.casts.push({ attacker, target, spec, at, spot: [spot[0], spot[1]], done: false });
  }

  /** Projectiles in flight (for drawing): where, what, whose. */
  projectiles(): { pos: number[]; type: string; effect: string; owner: Fighter }[] {
    return this.flying.map((p) => ({ pos: [...p.pos], type: p.spec.type, effect: p.spec.effect, owner: p.owner }));
  }

  /** Strike windows of a move that starts at sim time t0 (window times are relative to t0). */
  arm(attacker: Fighter, target: Fighter, windows: readonly StrikeWindow[], t0: number): number {
    if (!Number.isFinite(t0) || attacker === target || !Array.isArray(windows)) return 0;
    let n = 0;
    for (const w of windows) {
      if (!w || !LIMBS.includes(w.limb) || !(w.to > w.from) || !Number.isFinite(w.from) || !Number.isFinite(w.to) || !(w.power > 0)) continue;
      const win: StrikeWindow = { limb: w.limb, from: Math.max(0, w.from), to: Math.min(w.to, 10), power: Math.min(w.power, MAX_POWER), name: String(w.name ?? w.limb) };
      if (!(win.to > win.from)) continue;
      if (win.to - win.from < MIN_WINDOW) win.to = win.from + MIN_WINDOW;
      const key = w.key !== undefined && Number.isFinite(w.key) ? w.key : (win.from + win.to) / 2;
      win.key = Math.min(win.to, Math.max(win.from, key));
      this.live.push({ attacker, target, w: win, t0, done: false, touched: false, evaded: false, closest: Infinity });
      n++;
    }
    return n;
  }

  /** Cancels a fighter's unresolved windows (its move was interrupted or ended). */
  disarm(f: Fighter, reason: WhiffReason, quiet = false) {
    for (const l of this.live) {
      if (l.attacker !== f || l.done) continue;
      l.done = true;
      if (!quiet) this.onWhiff(f, l.w.name, reason === "out of range" && l.evaded ? "dodged" : reason, l.closest);
    }
    this.live = this.live.filter((l) => !l.done);
    // a spell that hasn't left its caster yet fizzles; one already released (in flight, called down) goes on
    for (const c of this.casts) {
      if (c.attacker !== f || c.done) continue;
      c.done = true;
      if (!quiet && c.spec.kind !== "defend") this.onWhiff(f, c.spec.name, reason, Infinity);
    }
    this.casts = this.casts.filter((c) => !c.done);
  }

  /** Forget everything (arena reset). */
  clear() {
    for (const l of this.live) l.done = true;
    for (const c of this.casts) c.done = true;
    this.live = []; this.casts = []; this.strikes = []; this.flying = [];
  }

  /** Has unresolved windows or spells (winding up or live). */
  pending(f: Fighter): boolean { return this.live.some((l) => l.attacker === f && !l.done) || this.casts.some((c) => c.attacker === f && !c.done); }

  /** A window of `f` is live right now (or its strike is landing this very tick). */
  active(f: Fighter, t: number): boolean {
    return this.landing.has(f) || this.live.some((l) => l.attacker === f && !l.done && t >= l.t0 + l.w.from && t <= l.t0 + l.w.to);
  }

  /** Limbs of `f` that can hurt right now (for the hitbox view). */
  liveLimbs(f: Fighter, t: number): Limb[] {
    return this.live.filter((l) => l.attacker === f && !l.done && t >= l.t0 + l.w.from && t <= l.t0 + l.w.to).map((l) => l.w.limb);
  }

  get size() { return this.live.length + this.casts.length + this.strikes.length + this.flying.length; }

  step(t: number, dt = 0.02) {
    const hits: Hit[] = [];
    // phase 1: which windows connect this tick (nothing changes yet)
    for (const l of this.live) {
      if (l.done) continue;
      const a = l.attacker, d = l.target;
      if (!a.standing()) { l.done = true; continue; } // it went down: its strike went with it
      if (t < l.t0 + l.w.from) continue;
      const rules = this.mode === "rules";
      const due = rules && t >= l.t0 + (l.w.key ?? l.w.from);
      if (!d.hittable()) {
        // down or getting up: wait, the window may still close
        if (t > l.t0 + l.w.to) { l.done = true; this.onWhiff(a, l.w.name, l.evaded ? "dodged" : "out of range", l.closest); }
        continue;
      }
      if (!rules && t > l.t0 + l.w.to) { l.done = true; this.onWhiff(a, l.w.name, l.evaded ? "dodged" : "out of range", l.closest); continue; }
      const kind = d.defenseKind();
      if (kind === "dodge.left" || kind === "dodge.right" || kind === "dodge.back") l.evaded = true; // whatever happens, it was dodged
      const st = a.body.strikers[l.w.limb];
      const pos = a.body.limbPos(l.w.limb);
      const near = d.body.nearest(pos, st.r);
      if (near && near.gap < l.closest) l.closest = near.gap;
      if (rules) {
        // resolve at the first tick at or after the key time, even if that's just past the window
        if (!due) continue;
        l.done = true;
        const imp = this.byRules(l, pos, near);
        if (imp) hits.push({ attacker: a, name: l.w.name, imp, closest: l.closest });
        continue;
      }
      const imp = this.byContact(l, pos, near);
      if (imp) { l.done = true; hits.push({ attacker: a, name: l.w.name, imp, closest: l.closest }); }
    }
    this.stepSpells(t, dt, hits);
    // phase 2: apply them. A strike found above lands even if its attacker is hit in this same
    // tick: both connected at once. While they apply, their attackers count as mid-strike, so a
    // light exchange is a trade (Fighter.receiveHit), whichever was armed first.
    for (const h of hits) if (h.imp.attacker) this.landing.add(h.imp.attacker);
    try {
      for (const { attacker, name, imp, closest } of hits) {
        const d = attacker.opponent;
        const res = d.receiveHit(imp, (r) => this.onHit(imp, d, r));
        if (!res.landed) this.onWhiff(attacker, name, "out of range", closest); // went down to an earlier hit this tick
      }
    } finally {
      this.landing.clear();
    }
    this.live = this.live.filter((l) => !l.done);
    this.casts = this.casts.filter((c) => !c.done);
  }

  // ---------------------------------------------------------------- spells (spells.ts)

  private stepSpells(t: number, dt: number, hits: Hit[]) {
    // casts reaching their hit frame
    for (const c of this.casts) {
      if (c.done || t < c.at) continue;
      c.done = true;
      const a = c.attacker, d = c.target, s = c.spec;
      if (!a.standing()) continue; // it went down before the hit frame
      const from = a.body.limbPos(s.hitJoint);
      this.onRelease(a, s, [...from]);
      if (s.kind === "projectile") {
        const aim = chest(d);
        this.flying.push({ owner: a, target: d, spec: s, pos: [...from], vel: scale(unit(sub(aim, from)), SPELL.projectileSpeed), aim, locked: false, missed: false, ttl: 0, age: 0 });
      } else if (s.kind === "strike") {
        this.strikes.push({ attacker: a, target: d, spec: s, at: t + SPELL.strikeDelay, spot: c.spot });
      } else if (s.kind === "melee" || s.kind === "shockwave") {
        const dist = a.distanceTo(d);
        const reach = s.kind === "melee" ? SPELL.meleeRange : SPELL.shockwaveRadius;
        if (!d.hittable() || dist > reach) { this.onWhiff(a, s.name, "out of range", dist - reach); continue; }
        const hit = s.kind === "melee" ? this.meleeHit(a, d, s, from) : this.shockwaveHit(a, d, s);
        if (hit) hits.push({ attacker: a, name: s.name, imp: hit, closest: 0 });
      }
    }
    // strikes landing
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const k = this.strikes[i];
      if (t < k.at) continue;
      this.strikes.splice(i, 1);
      const a = k.attacker, d = k.target;
      if (!d.hittable()) { this.onWhiff(a, k.spec.name, "out of range", Infinity); continue; }
      const p = d.body.headPos();
      const off = Math.hypot(p[0] - k.spot[0], p[1] - k.spot[1]);
      // stepped out from under it, or dodging when it lands
      if (off > SPELL.strikeRadius || d.evades("head")) { this.onWhiff(a, k.spec.name, "dodged", off); continue; }
      const away = unit([p[0] - a.body.limbPos("head")[0], p[1] - a.body.limbPos("head")[1], 0]);
      hits.push({ attacker: a, name: k.spec.name, imp: this.spellImpact(a, d, k.spec, "strike", "head", d.body.hurt[0].body, [p[0], p[1], p[2] + 0.1], unit([0.4 * away[0], 0.4 * away[1], -0.9]), false), closest: 0 });
    }
    // projectiles flying
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const pr = this.flying[i];
      pr.age += dt;
      if (pr.age > SPELL.projectileLife) { this.flying.splice(i, 1); continue; }
      if (pr.missed) {
        if ((pr.ttl -= dt) <= 0) { this.flying.splice(i, 1); continue; }
      } else {
        const d = pr.target, c = chest(d);
        if (dodging(d)) pr.locked = true; // it slipped: the projectile stops following
        if (!pr.locked) pr.aim = c;
        const to = sub(pr.aim, pr.pos), dist = Math.hypot(to[0], to[1], to[2]);
        if (dist <= SPELL.arriveR + SPELL.projectileSpeed * dt) {
          const there = Math.hypot(c[0] - pr.aim[0], c[1] - pr.aim[1], c[2] - pr.aim[2]) < SPELL.dodgeClear;
          if (there && d.hittable() && !d.evades("torso")) {
            const chestVol = d.body.hurt[1];
            hits.push({ attacker: pr.owner, name: pr.spec.name, imp: this.spellImpact(pr.owner, d, pr.spec, "projectile", "torso", chestVol.body, [...c], unit(pr.vel), false), closest: 0 });
            this.flying.splice(i, 1);
            continue;
          }
          if (d.standing()) this.onWhiff(pr.owner, pr.spec.name, "dodged", Math.hypot(c[0] - pr.aim[0], c[1] - pr.aim[1]));
          pr.missed = true; // sails on past and fades
          pr.ttl = 0.4;
        } else if (dist > 1e-6) {
          pr.vel = scale(to, SPELL.projectileSpeed / dist);
        }
      }
      pr.pos = [pr.pos[0] + pr.vel[0] * dt, pr.pos[1] + pr.vel[1] * dt, pr.pos[2] + pr.vel[2] * dt];
    }
  }

  private meleeHit(a: Fighter, d: Fighter, s: Spec, from: number[]): Impact | null {
    const near = d.body.nearest(from, a.body.strikers[s.hitJoint].r);
    const zone = near?.volume.zone ?? "torso";
    if (d.evades(zone)) { this.onWhiff(a, s.name, "dodged", near?.gap ?? Infinity); return null; }
    const head = d.body.headPos(), ch = chest(d);
    const clean = Math.min(dist3(from, head), dist3(from, ch)) <= SPELL.cleanDist;
    const ap = a.body.limbPos("head"), dp = d.body.limbPos("head");
    const away = unit([dp[0] - ap[0], dp[1] - ap[1], 0]);
    const point = near ? surfacePoint(near.point, from, near.volume.r) : ch;
    return this.spellImpact(a, d, s, "melee", zone, near?.volume.body ?? d.body.hurt[1].body, point, unit([away[0], away[1], 0.15]), clean);
  }

  private shockwaveHit(a: Fighter, d: Fighter, s: Spec): Impact | null {
    if (d.evades("legs")) { this.onWhiff(a, s.name, "dodged", 0); return null; } // jumped over it
    const shin = d.body.hurt.find((v) => v.zone === "legs") ?? d.body.hurt[1];
    const ap = a.body.limbPos("head"), dp = d.body.limbPos("head");
    const away = unit([dp[0] - ap[0], dp[1] - ap[1], 0]);
    const [p0] = d.body.segment(shin);
    return this.spellImpact(a, d, s, "shockwave", "legs", shin.body, [...p0], unit([away[0], away[1], 0.35]), false);
  }

  /** A spell hit: damage from the move's rules, a push sized from it. */
  private spellImpact(a: Fighter, d: Fighter, s: Spec, how: string, zone: Zone, body: number, point: number[], dir: number[], clean: boolean): Impact {
    const damage = spellDamage(s.kind, s.power, clean);
    return {
      attacker: a, name: s.name, zone, body, point, dir, speed: 4,
      impulse: 2.2 * damage, poise: damage / 30, counter: d.isCommitted(),
      damage, knockdown: damage >= SPELL.knockdownDamage || (clean && s.power === 3), clean, how, type: s.type, effect: s.effect,
    };
  }

  /** rules mode, at the key time: the hit it makes, or null after reporting the whiff. */
  private byRules(l: Live, pos: number[], near: Contact | null): Impact | null {
    const a = l.attacker, d = l.target;
    // a dodge beats it even if it also took the body out of reach
    if (d.evades(near?.volume.zone ?? "torso")) { this.onWhiff(a, l.w.name, "dodged", near?.gap ?? Infinity); return null; }
    if (!near || near.gap > this.rulesReach) { this.onWhiff(a, l.w.name, l.evaded ? "dodged" : "out of range", near?.gap ?? Infinity); return null; }
    const zone = near.volume.zone;
    const ap = a.body.limbPos("head"), dp = d.body.limbPos("head");
    const away = unit([dp[0] - ap[0], dp[1] - ap[1], 0]);
    let n = [near.point[0] - pos[0], near.point[1] - pos[1], near.point[2] - pos[2]];
    n = Math.hypot(n[0], n[1], n[2]) > 1e-6 ? unit(n) : away;
    const speed = Math.max(2.5, a.body.limbPeak(l.w.limb));
    const s = Math.max(0.6, Math.min(1.6, speed / 4));
    return {
      attacker: a, name: l.w.name, zone, body: near.volume.body,
      point: surface(near.point, n, near.volume.r),
      dir: unit([0.7 * away[0] + 0.3 * n[0], 0.7 * away[1] + 0.3 * n[1], 0.3 * n[2]]),
      speed, impulse: l.w.power * ZONE_IMPULSE[zone] * s, poise: l.w.power * ZONE_POISE[zone] * s,
      counter: d.isCommitted(),
    };
  }

  /** contact mode, every tick of the window: the hit it makes now, or null (no contact yet). */
  private byContact(l: Live, pos: number[], near: Contact | null): Impact | null {
    const a = l.attacker, d = l.target;
    const st = a.body.strikers[l.w.limb];
    let c = near && near.gap < this.reach ? near : null;
    let guard = false;
    if (d.isBlocking()) {
      const g = d.body.touchingGuard(pos, st.r + this.reach);
      if (g && (!c || g.gap <= c.gap + 0.02)) { c = g; guard = true; } // the forearm is in the way
    }
    if (!c) return null;
    if (!guard && d.evades(c.volume.zone)) { l.evaded = true; return null; } // it met a dodge
    const vel = a.body.limbVel(l.w.limb);
    const tv = d.rootVelocity();
    const vr = [vel[0] - tv[0], vel[1] - tv[1], vel[2] - tv[2]];
    const vlen = Math.hypot(vr[0], vr[1], vr[2]);
    let n = [c.point[0] - pos[0], c.point[1] - pos[1], c.point[2] - pos[2]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (nl > 1e-6) n = [n[0] / nl, n[1] / nl, n[2] / nl];
    else { // the limb's center is inside the volume: straight toward the defender
      const dp = d.body.limbPos("head");
      n = unit([dp[0] - pos[0], dp[1] - pos[1], 0]);
    }
    const along = vr[0] * n[0] + vr[1] * n[1] + vr[2] * n[2];
    // A strike that slowed right at contact (a jab at full reach) still lands with its speed;
    // a limb pulling away, or just resting against the body, does not.
    const speed = Math.max(vlen, a.body.limbPeak(l.w.limb));
    if (speed < MIN_HIT_SPEED || (vlen > 0.3 && along < -0.1 * vlen)) { l.touched = true; return null; }
    const align = vlen > 0.3 ? Math.max(0, Math.min(1, along / vlen)) : 0.7; // head-on 1, glancing 0
    // push: along the strike, into the body, and away from the attacker
    const ap = a.body.limbPos("head"), dpos = d.body.limbPos("head");
    const away = unit([dpos[0] - ap[0], dpos[1] - ap[1], 0]);
    const v = vlen > 0.3 ? unit(vr) : n;
    const dir = [0.5 * v[0] + 0.3 * n[0] + 0.4 * away[0], 0.5 * v[1] + 0.3 * n[1] + 0.4 * away[1], 0.5 * v[2] + 0.3 * n[2]];
    dir[2] = Math.max(-0.3, Math.min(0.6, dir[2]));
    const s = Math.max(0.6, Math.min(1.6, speed / 4)) * (0.65 + 0.35 * align);
    const zone = c.volume.zone;
    return {
      attacker: a,
      name: l.w.name,
      zone,
      body: c.volume.body,
      point: surface(c.point, n, c.volume.r),
      dir: unit(dir),
      speed,
      impulse: l.w.power * ZONE_IMPULSE[zone] * s,
      poise: l.w.power * ZONE_POISE[zone] * s,
      counter: d.isCommitted(),
      guard,
    };
  }
}

/** A fighter's chest center (the middle of its chest volume). */
function chest(f: Fighter): number[] {
  const [a, b] = f.body.segment(f.body.hurt[1]);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Slipping or stepping back right now (the dodges that beat anything). */
function dodging(f: Fighter): boolean {
  const k = f.defenseKind();
  return k === "dodge.left" || k === "dodge.right" || k === "dodge.back";
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k];
const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The point on a volume's surface toward `from`, given the closest point on its axis. */
function surfacePoint(axis: number[], from: number[], r: number): number[] {
  const n = unit(sub(from, axis));
  return [axis[0] + n[0] * r, axis[1] + n[1] * r, axis[2] + n[2] * r];
}

/** Where a strike meets a volume: back from its axis point toward the striker by the radius. */
function surface(axisPoint: number[], n: number[], r: number): number[] {
  return [axisPoint[0] - n[0] * r, axisPoint[1] - n[1] * r, axisPoint[2] - n[2] * r];
}

function unit(v: number[]): number[] {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : [1, 0, 0];
}
