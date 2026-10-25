// Small helpers shared by the arena pieces: seeded random, tileable value noise, canvas textures, GLSL snippets.
import * as THREE from "three";

export type Rng = () => number;

/** Seeded PRNG (mulberry32): the arena is laid out the same on every load. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: Rng, a: number, b: number) => a + (b - a) * r();
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export type Noise2 = (x: number, y: number, period?: number) => number;

/** 2D value noise in 0..1. With `period` the lattice wraps, so noise(x, y, p) tiles every p units. */
export function valueNoise(seed: number): Noise2 {
  const r = rng(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = r(); }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const lat = (x: number, y: number) => vals[perm[perm[x & 255] + (y & 255)]];
  return (x, y, period = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = lat(x0, y0), b = lat(x1, y0), c = lat(x0, y1), d = lat(x1, y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Fractal value noise in 0..1. Tiles every `period` units when period is an integer. */
export function fbm(n: Noise2, x: number, y: number, octaves: number, period = 256) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += amp * n(x * f, y * f, period * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

/** Draws into a fresh canvas and wraps it as a texture. `srgb` for color maps, false for data (bump, masks). */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** White radial glow, alpha falls off to 0 at the edge. Shared by light pools and halos. */
export function glowTexture(size = 128, falloff = 2): THREE.CanvasTexture {
  return canvasTexture(size, size, (ctx) => {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
        const d = Math.min(1, Math.hypot(dx, dy));
        const a = Math.pow(1 - d, falloff) * (1 - d * d * 0.2);
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, false);
}

/** Linear-space THREE.Color from an sRGB hex, scaled (values above 1 bloom). */
export const hdr = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

/** Shared GLSL: hash + 1D/2D value noise. */
export const GLSL_NOISE = /* glsl */ `
float aHash(float n) { return fract(sin(n) * 43758.5453123); }
float aHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float aNoise(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(aHash(i), aHash(i + 1.0), f); }
float aNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = aHash2(i), b = aHash2(i + vec2(1.0, 0.0)), c = aHash2(i + vec2(0.0, 1.0)), d = aHash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float aFbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * aNoise2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
`;

/** Tag a patched built-in material so three never shares its program with an unpatched one. */
export function patch(m: THREE.Material, key: string, fn: (s: THREE.WebGLProgramParametersWithUniforms) => void) {
  m.onBeforeCompile = fn;
  m.customProgramCacheKey = () => `arena-${key}`;
}

/** HSL given in sRGB terms (how colors are usually picked), stored linear. */
export const hsl = (c: THREE.Color, h: number, s: number, l: number) => c.setHSL(h, s, l, THREE.SRGBColorSpace);
