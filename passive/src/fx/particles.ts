// Copied from client/src/render/fx/particles.ts on vaibhav/server (ba9d58b); only the imports changed.
// One pooled particle system: camera-facing instanced quads, one draw call for every particle effect.
// Premultiplied blending lets additive glows (blend 0) and solid petals/smoke (blend 1) share the draw call.
// Usage: const s = ps.reset(); s.x = ...; ps.emit();  (s is a shared template, no allocations)
import * as THREE from "three";
import { ATLAS_GRID } from "./textures.ts";

export const F_ORBIT = 1;   // x/z orbit around (ocx, ocz); y still integrates vy
export const F_FLUTTER = 2; // petal/leaf flip: sprite width oscillates
export const F_TWINKLE = 4; // alpha pulses at `flicker` rad/s
export const F_GROUND = 8;  // stops at the ground instead of falling through
export const F_FRAME = 16;  // lives for exactly one rendered frame (heads of moving things)

export interface PSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size0: number; size1: number;
  r0: number; g0: number; b0: number; // linear color, may exceed 1 (HDR, blooms)
  r1: number; g1: number; b1: number; // color at end of life
  alpha: number;
  fadeIn: number;  // fraction of life spent fading in (0 = pop)
  fadeOut: number; // fraction of life where fade-out starts (0 = fade from the start)
  drag: number;    // 1/s
  grav: number;    // m/s^2 added to vy (negative falls, positive rises)
  rot: number; spin: number;
  stretch: number; // >0: align the sprite's +X with velocity; length grows with speed
  sprite: number;
  blend: number;   // 0 additive .. 1 normal
  flicker: number; // F_TWINKLE: rate in rad/s; otherwise random flicker amount 0..1
  wobble: number;  // turbulence, m/s^2
  flutter: number; // F_FLUTTER rate, rad/s
  flags: number;
  ocx: number; ocz: number; oang: number; orad: number; ow: number; odr: number; // orbit
}

const DEFAULTS: PSpec = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
  r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1, alpha: 1, fadeIn: 0, fadeOut: 0.4,
  drag: 0, grav: 0, rot: 0, spin: 0, stretch: 0, sprite: 0, blend: 0, flicker: 0, wobble: 0, flutter: 0, flags: 0,
  ocx: 0, ocz: 0, oang: 0, orad: 0, ow: 0, odr: 0,
};

const KEYS = Object.keys(DEFAULTS) as (keyof PSpec)[];

const vert = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute vec4 iPrm; // size, rotation, stretch, frame
attribute vec2 iMisc; // blend, squash
uniform float uGrid;
varying vec2 vUv;
varying vec4 vCol;
varying float vBlend;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy;
  float size = iPrm.x;
  vec2 c;
  if (iPrm.z > 0.0) {
    vec2 v = (modelViewMatrix * vec4(iVel, 0.0)).xy;
    float len = length(v);
    vec2 dir = len > 1e-5 ? v / len : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    c = dir * corner.x * size * (1.0 + iPrm.z * len) * iMisc.y + perp * corner.y * size;
  } else {
    float s = sin(iPrm.y), k = cos(iPrm.y);
    vec2 q = corner * size * vec2(iMisc.y, 1.0);
    c = vec2(k * q.x - s * q.y, s * q.x + k * q.y);
  }
  mv.xy += c;
  gl_Position = projectionMatrix * mv;
  float col = mod(iPrm.w, uGrid), row = floor(iPrm.w / uGrid);
  vUv = vec2((col + corner.x + 0.5) / uGrid, 1.0 - (row + 0.5 - corner.y) / uGrid);
  vCol = iCol;
  vBlend = iMisc.x;
}`;

const frag = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vCol;
varying float vBlend;
void main() {
  vec4 t = texture2D(uMap, vUv); // premultiplied
  float a = t.a * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * t.rgb * vCol.a, a * vBlend);
}`;

/** Premultiplied "over": src.rgb + dst.rgb * (1 - src.a). src.a = 0 is pure additive. */
export function premultBlend(m: THREE.Material) {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.transparent = true;
  m.depthWrite = false;
}

export class Particles {
  readonly mesh: THREE.Mesh;
  readonly s: PSpec = { ...DEFAULTS };
  n = 0;
  readonly cap: number;

  private readonly f: Record<keyof PSpec, Float32Array>;
  private readonly fa: Float32Array[]; // f's arrays in KEYS order
  private readonly age: Float32Array;
  private readonly ph: Float32Array;
  private readonly dir: Float32Array; // last non-zero velocity (stretch direction)
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aPrm: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  private readonly attrs: [THREE.InstancedBufferAttribute, number][];

  constructor(cap: number, atlas: THREE.Texture) {
    this.cap = cap;
    const f = {} as Record<keyof PSpec, Float32Array>;
    for (const k of KEYS) f[k] = new Float32Array(cap);
    this.f = f;
    this.fa = KEYS.map((k) => f[k]);
    this.age = new Float32Array(cap);
    this.ph = new Float32Array(cap);
    this.dir = new Float32Array(cap * 3);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = inst(3); this.aVel = inst(3); this.aCol = inst(4); this.aPrm = inst(4); this.aMisc = inst(2);
    geo.setAttribute("iPos", this.aPos);
    geo.setAttribute("iVel", this.aVel);
    geo.setAttribute("iCol", this.aCol);
    geo.setAttribute("iPrm", this.aPrm);
    geo.setAttribute("iMisc", this.aMisc);
    geo.instanceCount = 0;
    this.geo = geo;
    this.attrs = [[this.aPos, 3], [this.aVel, 3], [this.aCol, 4], [this.aPrm, 4], [this.aMisc, 2]];

    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { uMap: { value: atlas }, uGrid: { value: ATLAS_GRID } } });
    premultBlend(mat);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /** Reset the shared template to defaults and return it. */
  reset(): PSpec {
    Object.assign(this.s, DEFAULTS);
    return this.s;
  }

  /** Spawn one particle from the template. Silently drops when full. */
  emit() {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const s = this.s, fa = this.fa;
    for (let k = 0; k < KEYS.length; k++) fa[k][i] = s[KEYS[k]];
    this.age[i] = 0;
    this.ph[i] = Math.random() * Math.PI * 2;
    const sp = Math.hypot(s.vx, s.vy, s.vz);
    if (sp > 0) { this.dir[i * 3] = s.vx / sp; this.dir[i * 3 + 1] = s.vy / sp; this.dir[i * 3 + 2] = s.vz / sp; }
    else { this.dir[i * 3] = 1; this.dir[i * 3 + 1] = 0; this.dir[i * 3 + 2] = 0; }
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    const fa = this.fa;
    for (let k = 0; k < fa.length; k++) fa[k][i] = fa[k][last];
    this.age[i] = this.age[last];
    this.ph[i] = this.ph[last];
    this.dir[i * 3] = this.dir[last * 3]; this.dir[i * 3 + 1] = this.dir[last * 3 + 1]; this.dir[i * 3 + 2] = this.dir[last * 3 + 2];
  }

  /** Age and move everything; kills expired particles. */
  step(dt: number) {
    const f = this.f, age = this.age, ph = this.ph;
    const { x, y, z, vx, vy, vz, life, drag, grav, rot, spin, wobble, flags, ocx, ocz, oang, orad, ow, odr } = f;
    for (let i = 0; i < this.n; i++) {
      age[i] += dt;
      if (age[i] >= life[i] || flags[i] & F_FRAME) { this.kill(i); i--; continue; }
      if (drag[i] > 0) {
        const d = Math.exp(-drag[i] * dt);
        vx[i] *= d; vy[i] *= d; vz[i] *= d;
      }
      vy[i] += grav[i] * dt;
      const w = wobble[i];
      if (w > 0) {
        const a = age[i], p = ph[i];
        vx[i] += Math.sin(a * 5.3 + p) * w * dt;
        vy[i] += Math.sin(a * 3.7 + p * 2.1) * w * 0.5 * dt;
        vz[i] += Math.cos(a * 4.1 + p * 1.3) * w * dt;
      }
      const fl = flags[i];
      if (fl & F_ORBIT) {
        oang[i] += ow[i] * dt;
        orad[i] = Math.max(0, orad[i] + odr[i] * dt);
        ocx[i] += vx[i] * dt; ocz[i] += vz[i] * dt;
        x[i] = ocx[i] + Math.cos(oang[i]) * orad[i];
        z[i] = ocz[i] + Math.sin(oang[i]) * orad[i];
        y[i] += vy[i] * dt;
      } else {
        x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
      }
      if (fl & F_GROUND && y[i] < 0.012) {
        y[i] = 0.012;
        if (vy[i] < 0) vy[i] *= -0.25;
        vx[i] *= 0.7; vz[i] *= 0.7;
      }
      rot[i] += spin[i] * dt;
    }
  }

  /** Write the live particles into the GPU buffers. Call once per frame after step() and any emits. */
  upload() {
    const n = this.n;
    this.mesh.visible = n > 0;
    this.geo.instanceCount = n;
    if (!n) return;
    const f = this.f, age = this.age, ph = this.ph, dir = this.dir;
    const P = this.aPos.array as Float32Array, V = this.aVel.array as Float32Array, C = this.aCol.array as Float32Array;
    const R = this.aPrm.array as Float32Array, M = this.aMisc.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const t = age[i] / f.life[i];
      const e = 1 - (1 - t) * (1 - t);
      let a = f.alpha[i];
      const fi = f.fadeIn[i], fo = f.fadeOut[i];
      if (fi > 0 && t < fi) a *= t / fi;
      if (t > fo) { const u = (t - fo) / (1 - fo); a *= 1 - u * u * (3 - 2 * u); }
      const fl = f.flags[i];
      const fk = f.flicker[i];
      if (fl & F_TWINKLE) a *= 0.35 + 0.65 * Math.abs(Math.sin(age[i] * fk + ph[i]));
      else if (fk > 0) a *= 1 - fk * Math.random();
      let sq = 1;
      if (fl & F_FLUTTER) sq = 0.18 + 0.82 * Math.abs(Math.cos(age[i] * f.flutter[i] + ph[i]));

      const i3 = i * 3, i4 = i * 4, i2 = i * 2;
      P[i3] = f.x[i]; P[i3 + 1] = f.y[i]; P[i3 + 2] = f.z[i];
      const vx = f.vx[i], vy = f.vy[i], vz = f.vz[i];
      const sp2 = vx * vx + vy * vy + vz * vz;
      if (sp2 > 0.0025) {
        const sp = Math.sqrt(sp2);
        dir[i3] = vx / sp; dir[i3 + 1] = vy / sp; dir[i3 + 2] = vz / sp;
        V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
      } else {
        // keep the last heading so slow thorns/shards don't snap sideways
        V[i3] = dir[i3] * 0.05; V[i3 + 1] = dir[i3 + 1] * 0.05; V[i3 + 2] = dir[i3 + 2] * 0.05;
      }
      C[i4] = f.r0[i] + (f.r1[i] - f.r0[i]) * t;
      C[i4 + 1] = f.g0[i] + (f.g1[i] - f.g0[i]) * t;
      C[i4 + 2] = f.b0[i] + (f.b1[i] - f.b0[i]) * t;
      C[i4 + 3] = a;
      R[i4] = f.size0[i] + (f.size1[i] - f.size0[i]) * e;
      R[i4 + 1] = f.rot[i];
      R[i4 + 2] = f.stretch[i];
      R[i4 + 3] = f.sprite[i];
      M[i2] = f.blend[i];
      M[i2 + 1] = sq;
    }
    for (const [a, k] of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * k);
      a.needsUpdate = true;
    }
  }

  clear() {
    this.n = 0;
  }
}
