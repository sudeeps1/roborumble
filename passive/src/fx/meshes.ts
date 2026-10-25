// Copied from client/src/render/fx/meshes.ts on vaibhav/server (ba9d58b); only the imports changed.
// Small pools of reusable effect meshes. Each slot owns its material (uniforms differ per slot) but slots of
// one pool share the shader, so nothing recompiles at runtime. Inactive slots are invisible (no draw call).
import * as THREE from "three";
import { premultBlend } from "./particles.ts";

export interface Slot {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  busy: boolean;
}

export class Pool {
  readonly slots: Slot[] = [];
  constructor(scene: THREE.Object3D, n: number, make: () => THREE.Mesh) {
    for (let i = 0; i < n; i++) {
      const mesh = make();
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.slots.push({ mesh, u: (mesh.material as THREE.ShaderMaterial).uniforms ?? {}, busy: false });
    }
  }
  get(): Slot | null {
    const s = this.slots.find((x) => !x.busy);
    if (!s) return null;
    s.busy = true;
    s.mesh.visible = true;
    s.mesh.position.set(0, 0, 0);
    s.mesh.rotation.set(0, 0, 0);
    s.mesh.scale.set(1, 1, 1);
    return s;
  }
  free(s: Slot) {
    s.busy = false;
    s.mesh.visible = false;
  }
  freeAll() {
    for (const s of this.slots) this.free(s);
  }
}

// ---------- decals: textured quads (flat on the ground or standing up), optional radial reveal ----------
const decalVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const decalFrag = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = uOpacity;
  if (uReveal < 1.0) {
    vec2 c = vUv - 0.5;
    float ang = atan(c.y, c.x) / 6.2831853 + 0.5;
    a *= 1.0 - smoothstep(uReveal - 0.04, uReveal, ang);
  }
  gl_FragColor = vec4(uColor * t.rgb * a, 0.0);
}`;

export function decalPool(scene: THREE.Object3D, n: number, map: THREE.Texture): Pool {
  const geo = new THREE.PlaneGeometry(1, 1);
  return new Pool(scene, n, () => {
    const m = new THREE.ShaderMaterial({
      vertexShader: decalVert, fragmentShader: decalFrag, side: THREE.DoubleSide,
      uniforms: { uMap: { value: map }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 1 }, uReveal: { value: 1 } },
    });
    premultBlend(m);
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 5;
    return mesh;
  });
}

// ---------- beams: open cylinders, base at y=0, height 1, radius 1. Rim-lit, fading upward ----------
const beamVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uStripes;
uniform float uFade;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float h = vUv.y;
  float vert = pow(1.0 - h, uFade) * smoothstep(0.0, 0.03, h);
  float st = 1.0;
  if (uStripes > 0.0) st = mix(1.0, 0.45 + 0.55 * sin(vUv.x * 6.2831853 * 7.0 + h * 9.0 - uTime * 5.0), uStripes);
  float a = uOpacity * vert * mix(0.3, 1.0, rim * rim) * max(st, 0.0);
  gl_FragColor = vec4(uColor * a, 0.0);
}`;

export function beamPool(scene: THREE.Object3D, n: number): Pool {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
  geo.translate(0, 0.5, 0);
  return new Pool(scene, n, () => {
    const m = new THREE.ShaderMaterial({
      vertexShader: beamVert, fragmentShader: beamFrag, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 1 }, uTime: { value: 0 }, uStripes: { value: 0 }, uFade: { value: 1.5 } },
    });
    premultBlend(m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 6;
    return mesh;
  });
}

// ---------- swoosh: a crescent arc that sweeps along its length (u) and fades behind the head ----------
const swooshFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uHead;
uniform float uTail;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float u = vUv.x, v = vUv.y;
  if (u > uHead) discard;
  float trail = smoothstep(uHead - uTail, uHead, u);
  float thick = 1.0 - trail * 0.7;              // crescent: thick at the head, thin behind
  float body = smoothstep(thick, thick + 0.3, v) * (1.0 - smoothstep(0.95, 1.0, v));
  float tip = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(uHead - 0.04, uHead, u) * 0.5);
  float a = uOpacity * trail * body * tip;
  float edge = smoothstep(0.82, 0.96, v) * (1.0 - smoothstep(0.96, 1.0, v));
  vec3 c = (uColor * (0.35 + 0.65 * v) + vec3(1.5, 1.45, 1.3) * edge * trail) * a;
  gl_FragColor = vec4(c, 0.0);
}`;

/** Unit arc in the local XY plane: angle 0..ARC as u goes 0..1, radius 0.55..1 as v goes 0..1. */
export const SWOOSH_ARC = 2.5;
export function swooshPool(scene: THREE.Object3D, n: number): Pool {
  const N = 40;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, a = u * SWOOSH_ARC;
    for (const [r, v] of [[0.55, 0], [1, 1]] as const) {
      pos.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      uv.push(u, v);
    }
    if (i < N) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return new Pool(scene, n, () => {
    const m = new THREE.ShaderMaterial({
      vertexShader: decalVert, fragmentShader: swooshFrag, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uHead: { value: 0 }, uTail: { value: 0.7 }, uOpacity: { value: 1 } },
    });
    premultBlend(m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 7;
    return mesh;
  });
}

// ---------- falling strike objects ----------
export type FallShape = "icicle" | "spear" | "meteor" | "shard" | "none";

export function fallGeometries(): Record<Exclude<FallShape, "none">, THREE.BufferGeometry> {
  const icicle = new THREE.ConeGeometry(0.1, 0.75, 7);
  icicle.rotateX(Math.PI); // tip down
  const spear = new THREE.ConeGeometry(0.055, 1.1, 5);
  spear.rotateX(Math.PI);
  const meteor = new THREE.IcosahedronGeometry(0.13, 1);
  const shard = new THREE.OctahedronGeometry(0.15, 0);
  shard.scale(0.55, 1.9, 0.55);
  return { icicle, spear, meteor, shard };
}

export function fallPool(scene: THREE.Object3D, n: number, geo: THREE.BufferGeometry): Pool {
  return new Pool(scene, n, () => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 4;
    return mesh;
  });
}
