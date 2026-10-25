// Camera-facing ribbons in one draw call: crackling lightning bolts and swoosh trails behind fast limbs.
// Geometry is rebuilt on the CPU every frame into fixed buffers (no allocations).
import * as THREE from "three";
import { premultBlend } from "./particles";

const MAX_V = 6000;
const MAX_PTS = 24;      // points per strip
const MAX_BOLTS = 40;
const MAX_TRAILS = 16;
const TRAIL_LEN = 16;

const vert = /* glsl */ `
attribute vec4 aCol;
attribute vec2 aUv;
attribute float aCore;
varying vec4 vCol;
varying vec2 vUv;
varying float vCore;
void main() {
  vCol = aCol; vUv = aUv; vCore = aCore;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
varying vec4 vCol;
varying vec2 vUv;
varying float vCore;
void main() {
  float d = abs(vUv.y);
  float glow = (1.0 - d) * (1.0 - d);
  float core = 1.0 - smoothstep(0.0, 0.3, d);
  vec3 c = (vCol.rgb * glow + vec3(core * vCore)) * vCol.a;
  gl_FragColor = vec4(c, 0.0);
}`;

interface Bolt {
  on: boolean;
  a: THREE.Vector3; b: THREE.Vector3;
  age: number; life: number;
  jag: number; width: number; segs: number;
  r: number; g: number; bl: number; core: number;
  rejit: number; timer: number;
  branches: number;
  pts: Float32Array;   // main strip, then branch strips; xyz
  counts: Int32Array;  // points per strip
  strips: number;
}

interface Trail {
  on: boolean;
  src: THREE.Object3D | null; // null: fed by push()
  rel: THREE.Object3D | null; // speed is measured relative to this (the pelvis), so walking doesn't light limbs
  relLast: THREE.Vector3;
  closed: boolean;
  core: number;
  hist: Float32Array; // xyz + speed per sample, newest first
  count: number;
  age: number; life: number; // samples while age < life, then the tail shrinks away
  width: number;
  r: number; g: number; b: number;
  minSpeed: number;
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const side = new THREE.Vector3(), tan = new THREE.Vector3(), view = new THREE.Vector3();

export class Ribbons {
  readonly mesh: THREE.Mesh;
  private readonly pos = new Float32Array(MAX_V * 3);
  private readonly col = new Float32Array(MAX_V * 4);
  private readonly uv = new Float32Array(MAX_V * 2);
  private readonly core = new Float32Array(MAX_V);
  private readonly idx = new Uint16Array((MAX_V / 2) * 6);
  private readonly geo = new THREE.BufferGeometry();
  private nv = 0;
  private ni = 0;
  private readonly attrs: [THREE.BufferAttribute, number][];
  private readonly bolts: Bolt[] = [];
  private readonly trails: Trail[] = [];
  private readonly stripPts = new Float32Array(MAX_PTS * 3);
  private readonly stripW = new Float32Array(MAX_PTS);
  private readonly stripA = new Float32Array(MAX_PTS);

  constructor() {
    const g = this.geo;
    const dyn = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", dyn(this.pos, 3));
    g.setAttribute("aCol", dyn(this.col, 4));
    g.setAttribute("aUv", dyn(this.uv, 2));
    g.setAttribute("aCore", dyn(this.core, 1));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.attrs = ([["position", 3], ["aCol", 4], ["aUv", 2], ["aCore", 1]] as const).map(([n, k]) => [g.getAttribute(n) as THREE.BufferAttribute, k]);
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
    premultBlend(mat);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({
        on: false, a: new THREE.Vector3(), b: new THREE.Vector3(), age: 0, life: 0, jag: 0, width: 0, segs: 0,
        r: 0, g: 0, bl: 0, core: 0, rejit: 0, timer: 0, branches: 0,
        pts: new Float32Array(MAX_PTS * 3 * 3), counts: new Int32Array(3), strips: 0,
      });
    }
    for (let i = 0; i < MAX_TRAILS; i++) {
      this.trails.push({ on: false, src: null, rel: null, relLast: new THREE.Vector3(), closed: false, core: 0.9, hist: new Float32Array(TRAIL_LEN * 4), count: 0, age: 0, life: 0, width: 0, r: 0, g: 0, b: 0, minSpeed: 0 });
    }
  }

  /**
   * A jagged bolt from `a` to `b` that re-crackles every `rejit` seconds. Color is linear HDR.
   */
  bolt(a: THREE.Vector3, b: THREE.Vector3, life: number, width: number, r: number, g: number, bl: number,
    opts: { jag?: number; branches?: number; rejit?: number; core?: number; segs?: number } = {}) {
    const bo = this.bolts.find((x) => !x.on) ?? this.bolts.reduce((m, x) => (x.age / x.life > m.age / m.life ? x : m));
    bo.on = true;
    bo.a.copy(a); bo.b.copy(b);
    bo.age = 0; bo.life = life; bo.width = width;
    bo.r = r; bo.g = g; bo.bl = bl;
    bo.jag = opts.jag ?? 0.16;
    bo.branches = opts.branches ?? 1;
    bo.rejit = opts.rejit ?? 0.045;
    bo.core = opts.core ?? 1.6;
    bo.segs = Math.min(MAX_PTS - 1, opts.segs ?? Math.max(4, Math.round(a.distanceTo(b) / 0.06)));
    bo.timer = 0;
    this.jitter(bo);
  }

  /**
   * Trail behind `src` (a robot body group) for `life` seconds. Brightness follows the body's speed relative
   * to `rel` (e.g. the pelvis), so only real swings light up, not the whole robot stepping in.
   */
  trail(src: THREE.Object3D, life: number, width: number, r: number, g: number, b: number, minSpeed = 1.2, rel: THREE.Object3D | null = null) {
    const tr = this.trails.find((x) => !x.on) ?? this.trails[0];
    tr.on = true;
    tr.src = src;
    tr.rel = rel;
    tr.closed = false;
    tr.core = 0.9;
    tr.count = 0;
    tr.age = 0;
    tr.life = life;
    tr.width = width;
    tr.r = r; tr.g = g; tr.b = b;
    tr.minSpeed = minSpeed;
  }

  /** A trail fed by push() every frame (projectiles, falling things). Returns a handle for push/close. */
  open(width: number, r: number, g: number, b: number, core = 0.6): number {
    let i = this.trails.findIndex((x) => !x.on);
    if (i < 0) i = 0;
    const tr = this.trails[i];
    tr.on = true; tr.src = null; tr.rel = null; tr.closed = false; tr.core = core;
    tr.count = 0; tr.age = 0; tr.life = Infinity; tr.width = width;
    tr.r = r; tr.g = g; tr.b = b; tr.minSpeed = 0;
    return i;
  }

  push(i: number, x: number, y: number, z: number) {
    const tr = this.trails[i];
    if (!tr?.on || tr.src || tr.closed) return;
    const H = tr.hist;
    H.copyWithin(4, 0, (TRAIL_LEN - 1) * 4);
    H[0] = x; H[1] = y; H[2] = z; H[3] = 0;
    tr.count = Math.min(TRAIL_LEN, tr.count + 1);
  }

  /** Stop feeding a push() trail; its tail shrinks away. */
  close(i: number) {
    const tr = this.trails[i];
    if (tr && !tr.src) tr.closed = true;
  }

  clear() {
    for (const b of this.bolts) b.on = false;
    for (const t of this.trails) t.on = false;
  }

  private jitter(bo: Bolt) {
    const { a, b } = bo;
    const len = a.distanceTo(b);
    tan.subVectors(b, a).normalize();
    // offsets perpendicular to the bolt; mostly in the camera plane (XY) so the side view sees the zigzag
    tmpA.set(-tan.y, tan.x, 0);
    if (tmpA.lengthSq() < 1e-4) tmpA.set(1, 0, 0);
    tmpA.normalize();
    tmpB.crossVectors(tan, tmpA).normalize();
    const n = bo.segs;
    const P = bo.pts;
    let off1 = 0, off2 = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const env = Math.sin(Math.PI * t); // pinned ends
      off1 = off1 * 0.35 + (Math.random() - 0.5) * 2 * bo.jag * len * 0.5;
      off2 = off2 * 0.35 + (Math.random() - 0.5) * bo.jag * len * 0.3;
      P[i * 3] = a.x + (b.x - a.x) * t + (tmpA.x * off1 + tmpB.x * off2) * env;
      P[i * 3 + 1] = a.y + (b.y - a.y) * t + (tmpA.y * off1 + tmpB.y * off2) * env;
      P[i * 3 + 2] = a.z + (b.z - a.z) * t + (tmpA.z * off1 + tmpB.z * off2) * env;
    }
    bo.counts[0] = n + 1;
    bo.strips = 1;
    // forks: short side bolts from interior points
    for (let k = 0; k < bo.branches && bo.strips < 3; k++) {
      if (Math.random() < 0.3) continue;
      const from = 1 + Math.floor(Math.random() * (n - 2));
      const m = Math.max(3, Math.floor(n * 0.45));
      const base = bo.strips * MAX_PTS * 3;
      const sx = P[from * 3], sy = P[from * 3 + 1], sz = P[from * 3 + 2];
      const ang = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.6);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      tmpC.set(tan.x * ca + tmpA.x * sa, tan.y * ca + tmpA.y * sa, tan.z * ca + tmpA.z * sa).multiplyScalar(Math.min(0.7, len * (0.25 + Math.random() * 0.2)) / m);
      let x = sx, y = sy, z = sz;
      for (let i = 0; i < m; i++) {
        P[base + i * 3] = x; P[base + i * 3 + 1] = y; P[base + i * 3 + 2] = z;
        const j = Math.min(len, 1.5);
        x += tmpC.x + (Math.random() - 0.5) * j * 0.05;
        y += tmpC.y + (Math.random() - 0.5) * j * 0.05;
        z += tmpC.z + (Math.random() - 0.5) * j * 0.02;
      }
      bo.counts[bo.strips++] = m;
    }
  }

  update(dt: number, cam: THREE.Vector3) {
    this.nv = 0;
    this.ni = 0;
    for (const bo of this.bolts) {
      if (!bo.on) continue;
      bo.age += dt;
      if (bo.age >= bo.life) { bo.on = false; continue; }
      bo.timer += dt;
      if (bo.timer >= bo.rejit) { bo.timer = 0; this.jitter(bo); }
      const k = bo.age / bo.life;
      const flick = 0.55 + 0.45 * Math.random();
      const alpha = (1 - k * k) * flick;
      for (let s = 0; s < bo.strips; s++) {
        const cnt = bo.counts[s];
        const base = s * MAX_PTS * 3;
        const wMul = s === 0 ? 1 : 0.6;
        for (let i = 0; i < cnt; i++) {
          this.stripPts[i * 3] = bo.pts[base + i * 3];
          this.stripPts[i * 3 + 1] = bo.pts[base + i * 3 + 1];
          this.stripPts[i * 3 + 2] = bo.pts[base + i * 3 + 2];
          const taper = s === 0 ? 1 : 1 - i / cnt;
          this.stripW[i] = bo.width * wMul * (0.4 + 0.6 * taper);
          this.stripA[i] = alpha * (s === 0 ? 1 : 0.75 * taper + 0.25);
        }
        this.strip(cnt, cam, bo.r, bo.g, bo.bl, s === 0 ? bo.core : bo.core * 0.7);
      }
    }
    for (const tr of this.trails) {
      if (!tr.on) continue;
      tr.age += dt;
      const H = tr.hist;
      if (!tr.src) {
        if (tr.closed) {
          tr.count = Math.max(0, tr.count - 2);
          if (tr.count < 2) { tr.on = false; continue; }
        }
      } else if (tr.age < tr.life) {
        tr.src.getWorldPosition(tmpA);
        let speed = 0;
        if (tr.rel) {
          // limb position relative to the pelvis; its change is the swing speed
          tr.rel.getWorldPosition(tmpB);
          tmpB.subVectors(tmpA, tmpB);
          if (tr.count > 0 && dt > 0) speed = tmpB.distanceTo(tr.relLast) / dt;
          tr.relLast.copy(tmpB);
        } else if (tr.count > 0 && dt > 0) speed = Math.hypot(tmpA.x - H[0], tmpA.y - H[1], tmpA.z - H[2]) / dt;
        H.copyWithin(4, 0, (TRAIL_LEN - 1) * 4);
        H[0] = tmpA.x; H[1] = tmpA.y; H[2] = tmpA.z; H[3] = speed;
        tr.count = Math.min(TRAIL_LEN, tr.count + 1);
      } else {
        // shrink the tail away
        tr.count = Math.max(0, tr.count - 2);
        if (tr.count < 2) { tr.on = false; continue; }
      }
      const cnt = tr.count;
      if (cnt < 2) continue;
      let any = false;
      for (let i = 0; i < cnt; i++) {
        this.stripPts[i * 3] = H[i * 4]; this.stripPts[i * 3 + 1] = H[i * 4 + 1]; this.stripPts[i * 3 + 2] = H[i * 4 + 2];
        const sp = tr.minSpeed > 0 ? Math.min(1, Math.max(0, (H[i * 4 + 3] - tr.minSpeed) / (tr.minSpeed * 2.5))) : 1;
        const f = 1 - i / (cnt - 1);
        this.stripW[i] = tr.width * (0.25 + 0.75 * f);
        this.stripA[i] = sp * f;
        if (sp > 0) any = true;
      }
      if (any) this.strip(cnt, cam, tr.r, tr.g, tr.b, tr.core);
    }
    const g = this.geo;
    g.setDrawRange(0, this.ni);
    this.mesh.visible = this.ni > 0;
    if (!this.ni) return;
    for (const [a, k] of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.nv * k);
      a.needsUpdate = true;
    }
    const ix = g.getIndex()!;
    ix.clearUpdateRanges();
    ix.addUpdateRange(0, this.ni);
    ix.needsUpdate = true;
  }

  /** Billboard the polyline in stripPts/stripW/stripA into the buffers. */
  private strip(cnt: number, cam: THREE.Vector3, r: number, g: number, b: number, core: number) {
    if (cnt < 2 || this.nv + cnt * 2 > MAX_V) return;
    const P = this.stripPts;
    const v0 = this.nv;
    for (let i = 0; i < cnt; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(cnt - 1, i + 1);
      tan.set(P[i1 * 3] - P[i0 * 3], P[i1 * 3 + 1] - P[i0 * 3 + 1], P[i1 * 3 + 2] - P[i0 * 3 + 2]);
      view.set(cam.x - P[i * 3], cam.y - P[i * 3 + 1], cam.z - P[i * 3 + 2]);
      side.crossVectors(tan, view);
      const l = side.length();
      if (l < 1e-6) side.set(0, 1, 0); else side.multiplyScalar(1 / l);
      const w = this.stripW[i] * 0.5;
      const a = this.stripA[i];
      for (let s = 0; s < 2; s++) {
        const v = this.nv++;
        const sg = s ? 1 : -1;
        this.pos[v * 3] = P[i * 3] + side.x * w * sg;
        this.pos[v * 3 + 1] = P[i * 3 + 1] + side.y * w * sg;
        this.pos[v * 3 + 2] = P[i * 3 + 2] + side.z * w * sg;
        this.col[v * 4] = r; this.col[v * 4 + 1] = g; this.col[v * 4 + 2] = b; this.col[v * 4 + 3] = a;
        this.uv[v * 2] = i / (cnt - 1); this.uv[v * 2 + 1] = sg;
        this.core[v] = core;
      }
    }
    for (let i = 0; i < cnt - 1; i++) {
      const a = v0 + i * 2;
      this.idx[this.ni++] = a; this.idx[this.ni++] = a + 1; this.idx[this.ni++] = a + 2;
      this.idx[this.ni++] = a + 1; this.idx[this.ni++] = a + 3; this.idx[this.ni++] = a + 2;
    }
  }
}
