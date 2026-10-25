// The fight camera. A broadcast-style side view that stays square to the two fighters and keeps both
// (and anything flying between them) in frame, with life in it:
//   - a handheld drift that never fully settles
//   - trauma shake (amount² of smooth noise) from hits, falls, slams and spells
//   - recoil kicks along a hit's push, and zoom punches into an impact
//   - shots: a crane-down intro, a low orbit onto a knockout, a slow push onto the winner
// Works in the MuJoCo frame (meters, Z up) and only reads positions; it never touches the sim.
import * as THREE from "three";

export type Shot = "fight" | "intro" | "ko" | "victory";

/** What the camera frames each frame (MuJoCo world). */
export interface Framing {
  pelvis: [ArrayLike<number>, ArrayLike<number>];
  /** Fighter on the floor (falling, down, ko): framed lower and given more room. */
  down: [boolean, boolean];
  /** Projectiles, a raised wall, ...: kept in frame while they last. */
  extras: ArrayLike<number>[];
}

export const CAMERA = {
  fov: 30,                         // deg, vertical
  margin: 1.0,                     // m kept in frame past each pelvis along the fighters' line
  minDist: 4.7, maxDist: 8,        // m from the framed centre (4.7: a standing fighter plus the HUD band fit)
  height: 0.95, heightPerM: 0.07,  // camera height: base + per metre of distance
  lookZ: 0.98, lookZDown: 0.6,     // aim height, standing / someone on the floor
  azimuthLag: 0.9,                 // s: how lazily it swings to stay square to the fighters
  homeAzimuth: -Math.PI / 2,       // the arena's best side (camera on -Y, looking +Y)
  homePull: 0.35,                  // 0..1: how much it leans back toward home when the fighters turn away from it
  zoomOutLag: 0.22, zoomInLag: 0.85, centreLag: 0.3,
  handheld: { pos: 0.022, rot: 0.004, hz: 0.21 },
  shake: { decay: 1.6, pos: 0.05, rot: 0.017, roll: 0.02, hz: 11, max: 1 }, // lively but easy to watch: slower, smaller jolts
};

// ---------------------------------------------------------------- noise
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
/** Smooth 1D value noise in [-1, 1]. */
function noise(t: number, seed: number) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return (hash(i + seed * 57.3) * (1 - u) + hash(i + 1 + seed * 57.3) * u) * 2 - 1;
}
const fbm = (t: number, seed: number) => noise(t, seed) * 0.7 + noise(t * 2.3, seed + 9) * 0.3;

const damp = (a: number, b: number, lag: number, dt: number) => b + (a - b) * Math.exp(-dt / Math.max(1e-4, lag));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const dampAngle = (a: number, b: number, lag: number, dt: number) => a + wrap(b - a) * (1 - Math.exp(-dt / Math.max(1e-4, lag)));
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

interface Pose { az: number; dist: number; height: number; centre: THREE.Vector3; lookZ: number; fov: number }

export class Director {
  readonly camera: THREE.PerspectiveCamera;
  shot: Shot = "fight";
  private az = CAMERA.homeAzimuth;
  private dist = 4.2;
  private centre = new THREE.Vector3(0, 0, 0);
  private lookZ = CAMERA.lookZ;
  private t = 0;
  private trauma = 0;
  private kickV = new THREE.Vector3();
  private kickP = new THREE.Vector3();
  private punches: { at: THREE.Vector3; amount: number; t0: number; attack: number; hold: number; release: number }[] = [];
  // scripted shots blend from the pose at the cut to their target
  private cutT = 0;
  private from: Pose | null = null;
  private subject: { at: THREE.Vector3; other: THREE.Vector3 } | null = null;
  private v = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    camera.up.set(0, 0, 1);
    camera.fov = CAMERA.fov;
  }

  /** Adds shake: ~0.15 a jab, 0.35 a hook or a body hitting the floor, 0.6 a knockdown, 0.9 a KO. */
  shake(amount: number) { this.trauma = Math.min(CAMERA.shake.max, this.trauma + amount); }

  /** A recoil along a hit's push (MuJoCo direction), in metres of camera travel. */
  kick(dir: ArrayLike<number>, amount: number) {
    this.kickV.x += dir[0] * amount * 9; this.kickV.y += dir[1] * amount * 9; this.kickV.z += dir[2] * amount * 4;
  }

  /** A quick zoom into a point: amount 0.1 = 10% tighter. */
  punch(at: ArrayLike<number>, amount: number, attack = 0.05, hold = 0.06, release = 0.45) {
    this.punches.push({ at: new THREE.Vector3(at[0], at[1], at[2]), amount, t0: this.t, attack, hold, release });
  }

  /** Cuts (with a blend) to a scripted shot. ko/victory: `at` is the loser / winner, `other` the opponent. */
  cut(shot: Shot, subject?: { at: ArrayLike<number>; other: ArrayLike<number> }) {
    this.from = this.pose();
    this.cutT = this.t;
    this.shot = shot;
    this.subject = subject ? { at: new THREE.Vector3(subject.at[0], subject.at[1], subject.at[2]), other: new THREE.Vector3(subject.other[0], subject.other[1], subject.other[2]) } : null;
    if (shot === "intro") this.from = { az: CAMERA.homeAzimuth + 0.9, dist: 8.5, height: 3.4, centre: new THREE.Vector3(0, 0, 0), lookZ: 0.8, fov: CAMERA.fov + 6 };
  }

  /** Keeps a scripted shot on its fighters as they move: the fallen one (ko), the winner (victory). */
  follow(at: ArrayLike<number>, other: ArrayLike<number>) {
    if (!this.subject) return;
    this.subject.at.lerp(this.v.set(at[0], at[1], at[2]), 0.12);
    this.subject.other.set(other[0], other[1], other[2]);
  }

  private pose(): Pose { return { az: this.az, dist: this.dist, height: this.camera.position.z, centre: this.centre.clone(), lookZ: this.lookZ, fov: this.camera.fov }; }

  /** dt: real seconds (the camera keeps moving through hit-stop and slow motion). */
  update(dt: number, f: Framing) {
    this.t += dt;
    const fight = this.fightPose(dt, f);
    let p = fight;
    const since = this.t - this.cutT;
    if (this.shot === "intro") {
      const k = ease(since / 2.8);
      p = this.blend(this.from!, fight, k, 1 - Math.sin(k * Math.PI) * 0.15);
      if (k >= 1) this.shot = "fight";
    } else if ((this.shot === "ko" || this.shot === "victory") && this.subject) {
      p = this.blend(this.from!, this.subjectPose(), ease(since / (this.shot === "ko" ? 0.9 : 1.6)));
    } else if (this.from && since < 0.8) {
      p = this.blend(this.from, fight, ease(since / 0.8)); // back to the fight from a scripted shot
    } else this.from = null;
    this.apply(p, dt);
  }

  /** Square to the fighters, wide enough for both and for whatever flies between them. */
  private fightPose(dt: number, f: Framing): Pose {
    const [a, b] = f.pelvis;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const sep = Math.hypot(dx, dy);
    if (sep > 0.35) {
      dx /= sep; dy /= sep;
      // the side of the fighters' line the camera is already on (no flip when they cross)
      const n1 = Math.atan2(-dx, dy), n2 = wrap(n1 + Math.PI);
      let want = Math.abs(wrap(n1 - this.az)) < Math.abs(wrap(n2 - this.az)) ? n1 : n2;
      // lean back toward the arena's best side when the fighters have turned far from it
      want = wrap(want + wrap(CAMERA.homeAzimuth - want) * CAMERA.homePull * ease((Math.abs(wrap(CAMERA.homeAzimuth - want)) - 0.5) / 1.2));
      if (!f.down[0] && !f.down[1]) this.az = dampAngle(this.az, want, CAMERA.azimuthLag, dt);
    }
    // the framed span: both pelvises plus extras, measured along the screen's horizontal
    const rx = -Math.sin(this.az), ry = Math.cos(this.az); // screen-right in the world (camera looks along -[cos az, sin az])
    let lo = Infinity, hi = -Infinity, cx = 0, cy = 0;
    const take = (p: ArrayLike<number>, w = 1) => { const s = p[0] * rx + p[1] * ry; lo = Math.min(lo, s - CAMERA.margin * w); hi = Math.max(hi, s + CAMERA.margin * w); };
    take(a, f.down[0] ? 1.35 : 1); take(b, f.down[1] ? 1.35 : 1);
    for (const e of f.extras) take(e, 0.45);
    cx = (a[0] + b[0]) / 2; cy = (a[1] + b[1]) / 2;
    // shift the centre along screen-right to the middle of the span
    const mid = (lo + hi) / 2, cur = cx * rx + cy * ry;
    cx += (mid - cur) * rx; cy += (mid - cur) * ry;
    const halfW = (hi - lo) / 2;
    const tanH = Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * this.camera.aspect;
    const want = THREE.MathUtils.clamp(halfW / tanH, CAMERA.minDist, CAMERA.maxDist);
    this.dist = damp(this.dist, want, want > this.dist ? CAMERA.zoomOutLag : CAMERA.zoomInLag, dt);
    this.centre.x = damp(this.centre.x, cx, CAMERA.centreLag, dt);
    this.centre.y = damp(this.centre.y, cy, CAMERA.centreLag, dt);
    this.lookZ = damp(this.lookZ, f.down[0] && f.down[1] ? CAMERA.lookZDown : f.down[0] || f.down[1] ? (CAMERA.lookZ + CAMERA.lookZDown) / 2 : CAMERA.lookZ, 0.5, dt);
    return { az: this.az, dist: this.dist, height: CAMERA.height + CAMERA.heightPerM * this.dist, centre: this.centre.clone(), lookZ: this.lookZ, fov: CAMERA.fov };
  }

  /** KO: low and close on the fallen fighter, turned a little toward the winner. Victory: a push onto the winner. */
  private subjectPose(): Pose {
    const s = this.subject!, since = this.t - this.cutT;
    const toOther = Math.atan2(s.other.y - s.at.y, s.other.x - s.at.x);
    if (this.shot === "ko") {
      // from the side it was on, swung 35° toward the winner (who ends up behind the fallen one), drifting on
      const az0 = this.from?.az ?? this.az;
      const right = (s.other.x - s.at.x) * -Math.sin(az0) + (s.other.y - s.at.y) * Math.cos(az0);
      // increasing azimuth moves the camera toward screen-right; swing away from the winner so the winner
      // stands behind the fallen fighter instead of between it and the camera
      const sgn = right >= 0 ? -1 : 1;
      return { az: wrap(az0 + sgn * (0.6 + since * 0.05)), dist: 3.6, height: 0.7, centre: s.at.clone().setZ(0), lookZ: 0.6, fov: 34 }; // the winner's head clears the HUD
    }
    // victory: in front of the winner, slightly low (heroic), slowly pushing in; aimed where the body is
    // (a winner still getting up off the floor, after a round that ran out of time, is low)
    const facing = toOther; // the winner faces the loser
    const lookZ = Math.min(1.22, Math.max(0.45, s.at.z + 0.45));
    return { az: wrap(facing + 0.55), dist: Math.max(2.1, 2.8 - since * 0.08), height: 0.55 + 0.38 * lookZ, centre: s.at.clone().setZ(0), lookZ, fov: 30 };
  }

  private blend(a: Pose, b: Pose, k: number, arc = 1): Pose {
    return {
      az: a.az + wrap(b.az - a.az) * k,
      dist: (a.dist + (b.dist - a.dist) * k) * arc,
      height: a.height + (b.height - a.height) * k,
      centre: a.centre.clone().lerp(b.centre, k),
      lookZ: a.lookZ + (b.lookZ - a.lookZ) * k,
      fov: a.fov + (b.fov - a.fov) * k,
    };
  }

  private apply(p: Pose, dt: number) {
    const cam = this.camera, t = this.t;
    // zoom punches: tighter field of view and a lean toward the impact
    let zoom = 0;
    const lean = this.v.set(0, 0, 0);
    this.punches = this.punches.filter((q) => {
      const s = t - q.t0, end = q.attack + q.hold + q.release;
      if (s > end) return false;
      const k = s < q.attack ? s / q.attack : s < q.attack + q.hold ? 1 : 1 - ease((s - q.attack - q.hold) / q.release);
      zoom = Math.max(zoom, q.amount * k);
      lean.addScaledVector(q.at.clone().sub(p.centre).setZ(q.at.z - p.lookZ), 0.25 * k * Math.min(1, q.amount * 4));
      return true;
    });
    // recoil kick: a damped spring back to rest
    this.kickV.addScaledVector(this.kickP, -160 * dt).multiplyScalar(Math.exp(-dt * 14));
    this.kickP.addScaledVector(this.kickV, dt);

    const h = CAMERA.handheld, s = CAMERA.shake;
    const sh = this.trauma * this.trauma;
    this.trauma = Math.max(0, this.trauma - s.decay * dt);
    const ht = t * h.hz, st = t * s.hz;
    const ox = Math.cos(p.az), oy = Math.sin(p.az);
    cam.position.set(
      p.centre.x + ox * p.dist + fbm(ht, 1) * h.pos + noise(st, 4) * s.pos * sh + this.kickP.x,
      p.centre.y + oy * p.dist + fbm(ht, 2) * h.pos + noise(st, 5) * s.pos * sh + this.kickP.y,
      p.height + fbm(ht, 3) * h.pos * 0.6 + noise(st, 6) * s.pos * 0.6 * sh + this.kickP.z,
    );
    this.look.set(p.centre.x + lean.x, p.centre.y + lean.y, p.lookZ + lean.z);
    cam.up.set(0, 0, 1);
    cam.lookAt(this.look);
    // rotational shake and drift in the camera's own frame (yaw, pitch, roll)
    cam.rotateY(fbm(ht + 7, 7) * h.rot + noise(st, 8) * s.rot * sh);
    cam.rotateX(fbm(ht + 9, 9) * h.rot + noise(st, 10) * s.rot * sh);
    cam.rotateZ(fbm(ht * 0.7, 11) * h.rot * 0.8 + noise(st, 12) * s.roll * sh);
    const fov = p.fov * (1 - zoom);
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
}
