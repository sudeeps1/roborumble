// Costume pieces shared by several characters: eyes, rune rings and glyphs on the limbs, the chest medallion,
// a cheap hanging cloak and a pendulum. All coordinates are relative to the anchor they attach to.
import * as THREE from "three";
import type { Kit } from "./kit";
import { GLYPHS, V, merge, ring, smooth, stroke } from "./geom";

export type Side = "left" | "right";
export const SIDES: Side[] = ["left", "right"];

/** Orient a geometry built in XY (facing +Z) with its local axes mapped to X, Y, Z, then move it to `at`. */
export function basis<T extends THREE.BufferGeometry>(g: T, X: THREE.Vector3, Y: THREE.Vector3, Z: THREE.Vector3, at: THREE.Vector3): T {
  const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(at);
  g.applyMatrix4(m);
  return g;
}

/** A glyph from GLYPHS as a flat ribbon mesh, `size` meters tall. */
export function glyphGeo(name: string, size: number, width = 0.085, withRing = false): THREE.BufferGeometry {
  const lines = (GLYPHS[name] ?? GLYPHS.rose).map((l) => l.map(([x, y]) => [x * size, y * size] as [number, number]));
  if (withRing) lines.push(ring(0.62 * size, 36).map(([x, y]) => [x, y] as [number, number]));
  return stroke(lines, width * size);
}

/** Procedural canvas texture (sRGB), owned by the kit. */
export function canvasTex(k: Kit, w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  draw(cv.getContext("2d")!, w, h);
  const t = k.own(new THREE.CanvasTexture(cv));
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Vertical gradient for emissive maps along uv.y: dark at v=0, bright at v=1. */
export function gradientTex(k: Kit, lo = 0.12, hi = 1, power = 1.6): THREE.CanvasTexture {
  return canvasTex(k, 4, 64, (c, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = 1 - y / (h - 1); // canvas top = v 1 (flipY)
      const g = Math.round(255 * (lo + (hi - lo) * Math.pow(v, power)));
      c.fillStyle = `rgb(${g},${g},${g})`;
      c.fillRect(0, y, w, 1);
    }
  });
}

// ---------- eyes ----------
export interface EyeOpts { x?: number; y?: number; z?: number; w?: number; h?: number; d?: number; slant?: number }

/** Two glowing eyes on the face plate (head anchor frame). They protrude a little so they read in profile. */
export function eyes(k: Kit, mat: THREE.Material, o: EyeOpts = {}): THREE.Mesh {
  const x = o.x ?? 0.052, y = o.y ?? 0.024, z = o.z ?? 0.012, w = o.w ?? 0.0125, h = o.h ?? 0.0085, d = o.d ?? 0.008;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const g = new THREE.SphereGeometry(1, 12, 8);
    g.scale(d, w, h);
    g.rotateX(s * (o.slant ?? 0.25));
    g.translate(x, s * y, z);
    parts.push(g);
  }
  const m = k.mesh(merge(parts), mat, false);
  k.add(k.a.head, m);
  return m;
}

// ---------- limb runes ----------
// Forearm anchor: elbow link frame, +X toward the hand; the forearm's cross-section center is ~(0, 0.002, -0.005) from it.
// Shin anchor: knee link frame, -Z toward the foot; the shin's center is ~(-0.009, 0, 0) from it.
export interface LimbOpts {
  glyph: string;
  ringMat: THREE.Material;
  glyphMat?: THREE.Material;
  forearmRingX?: number;       // ring position along the forearm (anchor frame)
  forearmR?: number;
  shinRingZ?: number;
  shinR?: [number, number];    // x, y radii
  tube?: number;
  glyphSize?: number;
  forearmGlyphR?: number;      // distance of the forearm glyphs from the axis
  shinGlyphY?: number;
  shinGlyphZ?: number;
  rings2?: boolean;            // a second, thinner ring
}

export function limbRunes(k: Kit, o: LimbOpts) {
  const tube = o.tube ?? 0.0045;
  const gs = o.glyphSize ?? 0.032;
  const gmat = o.glyphMat ?? o.ringMat;
  const same = gmat === o.ringMat;

  // forearm: ring(s) around the bone + a glyph on each flat side (+Y face with up toward the elbow, and -Y)
  const fr = o.forearmR ?? 0.047, fx = o.forearmRingX ?? 0.045;
  const fRings: THREE.BufferGeometry[] = [new THREE.TorusGeometry(fr, tube, 6, 32).rotateY(Math.PI / 2).translate(fx, 0.002, -0.005)];
  if (o.rings2) fRings.push(new THREE.TorusGeometry(fr * 1.02, tube * 0.6, 5, 32).rotateY(Math.PI / 2).translate(fx - 0.075, 0.002, -0.005));
  const gr = o.forearmGlyphR ?? 0.046;
  const fGlyphs = [
    basis(glyphGeo(o.glyph, gs), V(0, 0, -1), V(-1, 0, 0), V(0, 1, 0), V(0.0, 0.002 + gr, -0.005)),
    basis(glyphGeo(o.glyph, gs), V(0, 0, 1), V(-1, 0, 0), V(0, -1, 0), V(0.0, 0.002 - gr, -0.005)),
  ];

  // shin: elliptical ring(s) + side glyphs
  const [rx, ry] = o.shinR ?? [0.056, 0.045];
  const sz = o.shinRingZ ?? 0.075, ra = (rx + ry) / 2;
  const sRings: THREE.BufferGeometry[] = [new THREE.TorusGeometry(1, tube / ra, 6, 36).scale(rx, ry, ra).translate(-0.008, 0, sz)];
  if (o.rings2) sRings.push(new THREE.TorusGeometry(1, (tube * 0.6) / ra, 5, 36).scale(rx * 0.86, ry * 0.86, ra).translate(-0.008, 0, sz - 0.17));
  const gy = o.shinGlyphY ?? 0.0405, gz = o.shinGlyphZ ?? -0.01;
  const sGlyphs = [
    basis(glyphGeo(o.glyph, gs), V(-1, 0, 0), V(0, 0, 1), V(0, 1, 0), V(-0.004, gy, gz)),
    basis(glyphGeo(o.glyph, gs), V(1, 0, 0), V(0, 0, 1), V(0, -1, 0), V(-0.004, -gy, gz)),
  ];

  // left and right limbs share geometry (same local frames); one draw call per limb when the materials match
  const parts: [THREE.Object3D, THREE.Object3D, THREE.BufferGeometry[], THREE.BufferGeometry[]][] = [
    [k.a.leftForearm, k.a.rightForearm, fRings, fGlyphs],
    [k.a.leftShin, k.a.rightShin, sRings, sGlyphs],
  ];
  for (const [left, right, rings, glyphs] of parts) {
    const geos: [THREE.BufferGeometry, THREE.Material][] = same ? [[merge([...rings, ...glyphs]), o.ringMat]] : [[merge(rings), o.ringMat], [merge(glyphs), gmat]];
    for (const [g, m] of geos) for (const a of [left, right]) k.add(a, k.mesh(g, m, false));
  }
}

/** Chest medallion: a glyph in a ring on the chest plate, facing +X, with a gem that sticks out (reads in profile). */
export function chestRune(k: Kit, glyph: string, mat: THREE.Material, size = 0.07, gemMat?: THREE.Material, z = 0) {
  const g = basis(glyphGeo(glyph, size * 0.62, 0.09, true), V(0, 1, 0), V(0, 0, 1), V(1, 0, 0), V(0.004, 0, z));
  if (!gemMat) return void k.add(k.a.chest, k.mesh(g, mat, false));
  const gem = new THREE.OctahedronGeometry(0.011, 0).scale(1.1, 0.8, 1.25).translate(0.012, 0, z - size * 0.42);
  if (gemMat === mat) k.add(k.a.chest, k.mesh(merge([g, gem]), mat, false));
  else {
    k.add(k.a.chest, k.mesh(g, mat, false));
    k.add(k.a.chest, k.mesh(gem, gemMat, false));
  }
}

// ---------- cloak ----------
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _d = new THREE.Vector3(), _t = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const DOWN_MJ = new THREE.Vector3(0, 0, -1);
/** three.js world height of the arena floor (flat disc at y = 0); cloth and pendulums rest just above it. */
export const FLOOR_Y = 0.012;
const DOWN = new THREE.Vector3(0, -1, 0);

export interface CloakOpts {
  nu: number;          // columns (around)
  nv: number;          // rows (down)
  pivotV: number;      // rows below this swing with gravity / inertia
  wave?: number;       // ripple amplitude, meters
  drag?: number;       // how far motion blows it back
}

/**
 * Hanging cloth from a rest shape f(u, v): u 0..1 around the body (left front edge -> back -> right front edge),
 * v 0 (collar) .. 1 (hem), in the holder's frame. Each frame the part below `pivotV` swings toward world-down
 * plus a drag from the holder's motion, and ripples. CPU-animated (~250 verts), no shader tricks, shadows just work.
 */
export class Cloak {
  readonly geo: THREE.BufferGeometry;
  private readonly rest: Float32Array;
  private readonly piv: Float32Array;   // per column: rest point at the pivot row
  private readonly out: Float32Array;   // per column: outward horizontal direction (x, y)
  private readonly rowQ: THREE.Quaternion[];
  private readonly rowW: Float32Array;
  private readonly pos: THREE.BufferAttribute;
  private readonly nor: THREE.BufferAttribute;
  private readonly dir = new THREE.Vector3(0, -1, 0); // smoothed hang direction, three.js world
  private readonly vel = new THREE.Vector3();
  private readonly last = new THREE.Vector3();
  private hasLast = false;

  constructor(shape: (u: number, v: number, out: THREE.Vector3) => void, readonly o: CloakOpts) {
    const { nu, nv } = o;
    const n = (nu + 1) * (nv + 1);
    this.rest = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        shape(i / nu, j / nv, p);
        const k = j * (nu + 1) + i;
        this.rest[k * 3] = p.x; this.rest[k * 3 + 1] = p.y; this.rest[k * 3 + 2] = p.z;
        uv[k * 2] = i / nu; uv[k * 2 + 1] = 1 - j / nv;
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = (j + 1) * (nu + 1) + i, c = a + 1, d = b + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const pr = Math.round(o.pivotV * nv);
    this.piv = new Float32Array((nu + 1) * 3);
    this.out = new Float32Array((nu + 1) * 2);
    for (let i = 0; i <= nu; i++) {
      const k = pr * (nu + 1) + i;
      this.piv[i * 3] = this.rest[k * 3]; this.piv[i * 3 + 1] = this.rest[k * 3 + 1]; this.piv[i * 3 + 2] = this.rest[k * 3 + 2];
      const ox = this.rest[k * 3] + 0.03, oy = this.rest[k * 3 + 1]; // outward from a point just behind the spine
      const l = Math.hypot(ox, oy) || 1;
      this.out[i * 2] = ox / l; this.out[i * 2 + 1] = oy / l;
    }
    this.rowQ = Array.from({ length: nv + 1 }, () => new THREE.Quaternion());
    this.rowW = new Float32Array(nv + 1);
    for (let j = 0; j <= nv; j++) this.rowW[j] = smooth(o.pivotV, Math.min(1, o.pivotV + 0.45), j / nv);

    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(this.rest.slice(), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nor = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.nor.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.pos);
    this.geo.setAttribute("normal", this.nor);
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.normals();
    this.geo.computeBoundingSphere();
    this.geo.boundingSphere!.radius *= 1.4;
  }

  /** `holder` is the object the cloak mesh is parented to (its matrixWorld must be current). */
  update(holder: THREE.Object3D, t: number, dt: number, energy = 1) {
    const { nu, nv } = this.o;
    holder.updateWorldMatrix(true, false); // ancestors (stage.world) may not have been rendered yet
    holder.matrixWorld.decompose(_p, _q, _s);
    if (dt > 0) {
      if (this.hasLast) {
        _d.subVectors(_p, this.last).divideScalar(dt);
        if (_d.lengthSq() > 25) _d.setLength(5); // teleports (round reset)
        this.vel.lerp(_d, 1 - Math.exp(-dt * 10));
      }
      this.last.copy(_p);
      this.hasLast = true;
      _t.copy(DOWN).addScaledVector(this.vel, -(this.o.drag ?? 0.22)).normalize();
      this.dir.lerp(_t, 1 - Math.exp(-dt * 6)).normalize();
    }
    // hang direction in the holder's frame, kept behind the legs and below the horizon
    _qi.copy(_q).invert();
    _d.copy(this.dir).applyQuaternion(_qi);
    if (_d.x > 0.12) _d.x = 0.12;
    if (_d.z > -0.3) _d.z = -0.3;
    _d.normalize();
    // lying down: let the cloth stay along the body (it then rests on the floor) instead of bunching at the shoulders
    const upY = holder.matrixWorld.elements[9];
    if (upY < 0.55) _d.lerp(DOWN_MJ, smooth(0.55, 0.15, upY)).normalize();
    _qr.setFromUnitVectors(DOWN_MJ, _d);
    for (let j = 0; j <= nv; j++) this.rowQ[j].identity().slerp(_qr, this.rowW[j]);

    const amp = (this.o.wave ?? 0.012) * energy;
    const w = 2.2 + energy * 0.9;
    const arr = this.pos.array as Float32Array;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, rw = this.rowW[j], q = this.rowQ[j];
      for (let i = 0; i <= nu; i++) {
        const k = (j * (nu + 1) + i) * 3, pi = i * 3;
        _a.set(this.rest[k] - this.piv[pi], this.rest[k + 1] - this.piv[pi + 1], this.rest[k + 2] - this.piv[pi + 2]);
        if (rw > 0) _a.applyQuaternion(q);
        const u = i / nu;
        const ripple = amp * rw * (Math.sin(t * w - v * 7 + u * 9) + 0.5 * Math.sin(t * w * 1.7 + u * 17 - v * 4));
        const back = amp * rw * 0.8 * Math.sin(t * w * 0.6 + u * 4 + 1.3);
        arr[k] = this.piv[pi] + _a.x + ripple * this.out[i * 2] - back;
        arr[k + 1] = this.piv[pi + 1] + _a.y + ripple * this.out[i * 2 + 1];
        arr[k + 2] = this.piv[pi + 2] + _a.z;
      }
    }
    // lie on the floor instead of sinking through it (knockdowns, KOs)
    const e = holder.matrixWorld.elements;
    let inv: number[] | null = null;
    for (let k = 0; k < arr.length; k += 3) {
      const x = arr[k], y = arr[k + 1], z = arr[k + 2];
      if (e[1] * x + e[5] * y + e[9] * z + e[13] >= FLOOR_Y) continue;
      inv ??= _inv.copy(holder.matrixWorld).invert().elements;
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wz = e[2] * x + e[6] * y + e[10] * z + e[14], wy = FLOOR_Y;
      arr[k] = inv[0] * wx + inv[4] * wy + inv[8] * wz + inv[12];
      arr[k + 1] = inv[1] * wx + inv[5] * wy + inv[9] * wz + inv[13];
      arr[k + 2] = inv[2] * wx + inv[6] * wy + inv[10] * wz + inv[14];
    }
    this.normals();
    this.pos.needsUpdate = true;
  }

  /** Current position of grid vertex (i, j) plus `lift` along its normal, into `out` (holder frame). */
  vertex(i: number, j: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const k = (j * (this.o.nu + 1) + i) * 3;
    const p = this.pos.array as Float32Array, n = this.nor.array as Float32Array;
    return out.set(p[k] + n[k] * lift, p[k + 1] + n[k + 1] * lift, p[k + 2] + n[k + 2] * lift);
  }

  private normals() {
    const { nu, nv } = this.o;
    const p = this.pos.array as Float32Array, n = this.nor.array as Float32Array;
    for (let j = 0; j <= nv; j++) {
      const j0 = Math.max(0, j - 1), j1 = Math.min(nv, j + 1);
      for (let i = 0; i <= nu; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(nu, i + 1);
        const ka = (j * (nu + 1) + i1) * 3, kb = (j * (nu + 1) + i0) * 3;
        const kc = (j1 * (nu + 1) + i) * 3, kd = (j0 * (nu + 1) + i) * 3;
        _a.set(p[ka] - p[kb], p[ka + 1] - p[kb + 1], p[ka + 2] - p[kb + 2]); // d/du
        _b.set(p[kc] - p[kd], p[kc + 1] - p[kd + 1], p[kc + 2] - p[kd + 2]); // d/dv
        _n.crossVectors(_b, _a).normalize();
        const k = (j * (nu + 1) + i) * 3;
        n[k] = _n.x; n[k + 1] = _n.y; n[k + 2] = _n.z;
      }
    }
    this.nor.needsUpdate = true;
  }
}

/** Builds outer + lining meshes for a cloak (shared geometry, two materials). */
export function cloakMeshes(k: Kit, c: Cloak, outer: THREE.Material, lining: THREE.Material): [THREE.Mesh, THREE.Mesh] {
  k.own(c.geo);
  const a = k.mesh(c.geo, outer);
  const b = k.mesh(c.geo, lining);
  b.castShadow = false;
  return [a, b];
}

// ---------- pendulum ----------
const _pp = new THREE.Vector3(), _pq = new THREE.Quaternion(), _ps = new THREE.Vector3(), _pd = new THREE.Vector3();
const _pv = new THREE.Vector3();

/** A bob hanging from `pivot` (an Object3D) in world space; orients `swing` (a child of pivot) so its -Z points at the bob. */
export class Pendulum {
  private readonly bob = new THREE.Vector3();
  private readonly prev = new THREE.Vector3();
  private init = false;

  constructor(readonly pivot: THREE.Object3D, readonly swing: THREE.Object3D, readonly len: number, readonly damping = 1.6) {}

  update(dt: number, kick = 0) {
    this.pivot.updateWorldMatrix(true, false);
    this.pivot.matrixWorld.decompose(_pp, _pq, _ps);
    if (!this.init) {
      this.bob.copy(_pp).addScaledVector(DOWN, this.len);
      this.prev.copy(this.bob);
      this.init = true;
    }
    const h = Math.min(dt, 1 / 30);
    if (h > 0) {
      _pv.subVectors(this.bob, this.prev).multiplyScalar(Math.exp(-this.damping * h));
      if (kick) _pv.x += (Math.random() - 0.5) * kick * h;
      this.prev.copy(this.bob);
      this.bob.add(_pv).addScaledVector(DOWN, 9.8 * h * h);
    }
    _pd.subVectors(this.bob, _pp);
    if (_pd.lengthSq() < 1e-8) _pd.copy(DOWN);
    _pd.setLength(this.len);
    this.bob.copy(_pp).add(_pd);
    if (this.bob.y < FLOOR_Y + 0.01) {
      this.bob.y = FLOOR_Y + 0.01;
      _pd.subVectors(this.bob, _pp);
      if (_pd.lengthSq() < 1e-8) _pd.set(1, 0, 0);
    }
    _pd.applyQuaternion(_pq.invert()).normalize();
    this.swing.quaternion.setFromUnitVectors(DOWN_MJ, _pd);
  }
}
