// Spring bone chains (hair, belt flaps). VRM-style: each bone's tail is a particle with inertia,
// gravity (-Z, MuJoCo frame) and a stiffness pull back toward its animated rest direction; lengths are
// preserved and particles are pushed out of capsule colliders. Fixed-size substeps so any dt is stable.
// Parameters from the GLB are per-60 Hz-frame fractions (stiffness, damping) and a gravity scale (x 9.81).
import * as THREE from "three";

export interface SpringDef {
  name: string; bones: string[]; stiffness: number; damping: number; gravity: number; radius: number;
  /** Optional: max swing (rad) of each segment away from its rest direction. Default: hair 0.8, others 1.3. */
  maxAngle?: number;
}

/** Capsule in a bone's local frame (converted from bind-pose MuJoCo coordinates at load). */
export interface Capsule { bone: number; a: THREE.Vector3; b: THREE.Vector3; r: number; name: string }

const H = 1 / 120; // target substep
const MAX_SUB = 12;
const MAX_SPEED = 12; // m/s, guards against teleports
const G = 9.81;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3();
const _s = new THREE.Vector3();

export class SpringChain {
  readonly def: SpringDef;
  readonly anchor: number;          // bone index of the chain's (animated) parent
  readonly bones: number[];         // bone indices, root to tip
  private restPos: THREE.Vector3[]; // bone k head in its parent's frame
  private restRot: THREE.Quaternion[];
  private tailLocal: THREE.Vector3[]; // bone k tail in bone k frame
  private tailDir: THREE.Vector3[];
  private len: number[];
  private scale: THREE.Vector3[];
  private p: THREE.Vector3[];       // p[0] = head of bone 0 (pinned), p[k+1] = tail of bone k
  private v: THREE.Vector3[];
  private rot: THREE.Quaternion[];  // simulated world rotations
  private reach: number[][];        // [particle][collider] push-out distance (shrunk where the rest pose already overlaps)
  private seeded = false;
  private cosMax: number;
  private maxAngle: number;
  private prevAnchor = new THREE.Matrix4();
  private curAnchor = new THREE.Matrix4();
  private aPos0 = new THREE.Vector3(); private aPos1 = new THREE.Vector3();
  private aRot0 = new THREE.Quaternion(); private aRot1 = new THREE.Quaternion();
  /** Rest-pose overlaps found at load (asset diagnostics). */
  readonly restOverlaps: string[] = [];

  constructor(def: SpringDef, anchor: number, bones: number[], restLocal: THREE.Matrix4[], bindWorld: THREE.Matrix4[], colliders: Capsule[]) {
    this.def = def;
    this.maxAngle = def.maxAngle ?? (def.name.startsWith("hair") ? 0.8 : 1.3);
    this.cosMax = Math.cos(this.maxAngle);
    this.anchor = anchor;
    this.bones = bones;
    const n = bones.length;
    this.restPos = []; this.restRot = []; this.tailLocal = []; this.tailDir = []; this.len = []; this.scale = [];
    for (let k = 0; k < n; k++) {
      const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), scl = new THREE.Vector3();
      restLocal[bones[k]].decompose(pos, rot, scl);
      this.restPos.push(pos); this.restRot.push(rot); this.scale.push(scl);
    }
    for (let k = 0; k < n; k++) {
      // tail = next bone's head; last bone: same length as itself along +Y (Blender bone axis)
      const tail = k + 1 < n ? this.restPos[k + 1].clone() : new THREE.Vector3(0, Math.max(this.restPos[k].length(), 0.03), 0);
      this.tailLocal.push(tail);
      this.len.push(tail.length());
      this.tailDir.push(tail.clone().normalize());
    }
    this.p = Array.from({ length: n + 1 }, () => new THREE.Vector3());
    this.v = Array.from({ length: n + 1 }, () => new THREE.Vector3());
    this.rot = Array.from({ length: n }, () => new THREE.Quaternion());

    // rest particles from the bind pose: where a particle already sits inside a collider, shrink that
    // pair's radius to the rest distance so it can't sink deeper (instead of fighting the rest pose)
    this.reach = [];
    const bw = bindWorld;
    const rest: THREE.Vector3[] = [new THREE.Vector3().setFromMatrixPosition(bw[bones[0]])];
    for (let k = 0; k < n; k++) rest.push(this.tailLocal[k].clone().applyMatrix4(bw[bones[k]]));
    for (let i = 0; i <= n; i++) {
      this.reach.push(colliders.map((c) => {
        _ca.copy(c.a).applyMatrix4(bw[c.bone]); _cb.copy(c.b).applyMatrix4(bw[c.bone]);
        const d = distToSegment(rest[i], _ca, _cb);
        const r = c.r + def.radius;
        if (d >= r - 1e-4) return r;
        if (i > 0) this.restOverlaps.push(`${def.name} particle ${i} (${i < n ? "head of bone " + def.bones[i] : "tip"}) sits ${((r - d) * 100).toFixed(1)} cm inside collider ${c.name} (r ${c.r} + ${def.radius}) at rest`);
        return Math.max(0, d - 0.002);
      }));
    }
  }

  reset() { this.seeded = false; }

  /** Advance the chain by dt. W = current root-space bone matrices; the chain's bones are overwritten. */
  step(dt: number, W: THREE.Matrix4[], colliders: Capsule[]) {
    this.curAnchor.copy(W[this.anchor]);
    this.curAnchor.decompose(this.aPos1, this.aRot1, _s);
    if (!this.seeded || this.aPos1.distanceTo(this.aPos0) > 0.75) {
      this.seed(W);
      return;
    }
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0) { this.write(W); return; }
    const nsub = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt / H)));
    const h = dt / nsub;
    const f = h * 60;
    const stiff = 1 - Math.pow(1 - Math.min(this.def.stiffness, 0.99), f);
    const damp = Math.pow(1 - Math.min(this.def.damping, 0.99), f);
    const gz = -G * this.def.gravity * h * h;
    const n = this.bones.length;
    const aPos = _w, aRot = _q2;
    for (let s = 1; s <= nsub; s++) {
      const u = s / nsub;
      aPos.lerpVectors(this.aPos0, this.aPos1, u);
      aRot.slerpQuaternions(this.aRot0, this.aRot1, u);
      // pinned head of bone 0
      this.p[0].copy(this.restPos[0]).applyQuaternion(aRot).add(aPos);
      let parentRot = aRot;
      for (let k = 0; k < n; k++) {
        const head = this.p[k], tail = this.p[k + 1], vel = this.v[k + 1];
        const restRot = this.rot[k].multiplyQuaternions(parentRot, this.restRot[k]); // rest orientation for now
        _t.copy(this.tailLocal[k]).applyQuaternion(restRot).add(head); // where the tail wants to be
        _v.copy(tail); // previous position
        tail.addScaledVector(vel, h * damp);
        tail.z += gz;
        tail.lerp(_t, stiff);
        this.constrain(head, tail, k);
        // swing limit around the rest direction (keeps whippy chains plausible at any frame rate)
        _d.copy(this.tailDir[k]).applyQuaternion(restRot);
        _ca.subVectors(tail, head).divideScalar(this.len[k]);
        if (_ca.dot(_d) < this.cosMax) {
          _cb.crossVectors(_d, _ca);
          if (_cb.lengthSq() < 1e-12) _cb.set(1, 0, 0).cross(_d);
          _q.setFromAxisAngle(_cb.normalize(), this.maxAngle);
          tail.copy(_d).applyQuaternion(_q).multiplyScalar(this.len[k]).add(head);
        }
        for (let c = 0; c < colliders.length; c++) {
          const reach = this.reach[k + 1][c];
          if (reach <= 0) continue;
          const col = colliders[c];
          _ca.copy(col.a).applyMatrix4(W[col.bone]); _cb.copy(col.b).applyMatrix4(W[col.bone]);
          pushOut(tail, _ca, _cb, reach);
        }
        this.constrain(head, tail, k);
        vel.subVectors(tail, _v).divideScalar(h);
        const sp = vel.length();
        if (sp > MAX_SPEED) vel.multiplyScalar(MAX_SPEED / sp);
        // bone rotation = rest rotation swung so its tail points at the particle
        _d.copy(this.tailDir[k]).applyQuaternion(restRot);
        _v.subVectors(tail, head).normalize();
        _q.setFromUnitVectors(_d, _v);
        this.rot[k].premultiply(_q);
        parentRot = this.rot[k];
      }
    }
    this.aPos0.copy(this.aPos1); this.aRot0.copy(this.aRot1);
    this.write(W);
  }

  private constrain(head: THREE.Vector3, tail: THREE.Vector3, k: number) {
    _d.subVectors(tail, head);
    const l = _d.length();
    if (l < 1e-8) { _d.copy(this.tailDir[k]); } else _d.divideScalar(l);
    tail.copy(head).addScaledVector(_d, this.len[k]);
  }

  private seed(W: THREE.Matrix4[]) {
    this.curAnchor.decompose(this.aPos1, this.aRot1, _s);
    let parentRot = this.aRot1.clone();
    this.p[0].copy(this.restPos[0]).applyQuaternion(parentRot).add(this.aPos1);
    for (let k = 0; k < this.bones.length; k++) {
      this.rot[k].multiplyQuaternions(parentRot, this.restRot[k]);
      this.p[k + 1].copy(this.tailLocal[k]).applyQuaternion(this.rot[k]).add(this.p[k]);
      this.v[k + 1].set(0, 0, 0);
      parentRot = this.rot[k];
    }
    this.aPos0.copy(this.aPos1); this.aRot0.copy(this.aRot1);
    this.seeded = true;
    this.write(W);
  }

  private write(W: THREE.Matrix4[]) {
    for (let k = 0; k < this.bones.length; k++) W[this.bones[k]].compose(this.p[k], this.rot[k], this.scale[k]);
  }
}

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  out.subVectors(b, a);
  const l2 = out.lengthSq();
  const t = l2 > 1e-12 ? Math.min(1, Math.max(0, _s.subVectors(p, a).dot(out) / l2)) : 0;
  return out.multiplyScalar(t).add(a);
}
const _c = new THREE.Vector3();
function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  return closestOnSegment(p, a, b, _c).distanceTo(p);
}
function pushOut(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  closestOnSegment(p, a, b, _c);
  _s.subVectors(p, _c);
  const d = _s.length();
  if (d >= r) return;
  if (d < 1e-6) _s.set(0, 0, 1); else _s.divideScalar(d);
  p.copy(_c).addScaledVector(_s, r);
}
