// Procedural, tileable micro-detail textures for the elf, generated once at startup (seeded, no files).
// Every texture is RGBA8, linear data, sampled triplanar in bind-pose object space (see materials.ts):
//   R, G  tangent-space normal x, y (0.5 = flat), derived from a height field with wrap-around differences
//   B     albedo modulation, 0.5 = neutral (lower = cavity/darker, higher = scuffed/lighter)
//   A     roughness modulation, 0.5 = neutral
// One "macro" texture (wrinkles, undulation, blotches at ~5-20 mm) is shared by every material; each
// material family has its own "micro" texture (pores, grain, weave) at 0.5-3 mm.
import * as THREE from "three";

export type MicroKind = "skin" | "lips" | "leather" | "boot" | "twill" | "knit" | "linen" | "gold";

/** Meters covered by one tile of each texture. Feature sizes follow the 1.32 m character. */
export const TILE: Record<MicroKind | "macro", number> = {
  skin: 0.025,   // pores ~0.6 mm apart, micro-relief cells ~1.8 mm
  lips: 0.02,    // vertical lip lines ~0.7 mm apart
  leather: 0.06, // pebble grain ~2 mm
  boot: 0.08,    // grain ~1.7 mm + creases ~6.5 mm apart
  twill: 0.016,  // 16 threads, 1 mm pitch, 2/2 twill
  knit: 0.016,   // jersey stitches ~1 x 0.8 mm
  linen: 0.032,  // coarse plain weave, 1.6 mm pitch
  gold: 0.035,   // hammer dents ~2.2 mm
  macro: 0.18,   // wrinkles and blotches 5-20 mm
};

let N = 512; // current texture size (set per texture by sized())
let MASK = N - 1;

// ---------------------------------------------------------------- hashing + periodic noise
function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const mod = (a: number, p: number) => ((a % p) + p) % p;
const fade5 = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// gradient + permutation tables (seeded, fixed): no trig or integer hashing in the hot loops
const PERM = new Uint8Array(512);
const GRAD = new Float32Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(hash(i, 0, 1234) * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) { const a = (i / 256) * 6.283185307 + 0.37; GRAD[i * 2] = Math.cos(a); GRAD[i * 2 + 1] = Math.sin(a); }
}
const h8 = (x: number, y: number, s: number) => PERM[PERM[PERM[s & 255] + (x & 255)] + (y & 255)];

/** Periodic 2D gradient noise, roughly [-0.7, 0.7]. (x, y) in lattice units, periods in lattice cells (<= 256 tile cleanly). */
function gnoise(x: number, y: number, px: number, py: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  let x0 = xi % px; if (x0 < 0) x0 += px;
  let y0 = yi % py; if (y0 < 0) y0 += py;
  const x1 = x0 + 1 === px ? 0 : x0 + 1, y1 = y0 + 1 === py ? 0 : y0 + 1;
  let g = h8(x0, y0, s) * 2;
  const a = GRAD[g] * fx + GRAD[g + 1] * fy;
  g = h8(x1, y0, s) * 2;
  const b = GRAD[g] * (fx - 1) + GRAD[g + 1] * fy;
  g = h8(x0, y1, s) * 2;
  const c = GRAD[g] * fx + GRAD[g + 1] * (fy - 1);
  g = h8(x1, y1, s) * 2;
  const d = GRAD[g] * (fx - 1) + GRAD[g + 1] * (fy - 1);
  const u = fade5(fx), v = fade5(fy);
  const ab = a + (b - a) * u;
  return ab + (c + (d - c) * u - ab) * v;
}

/** Periodic fBm over uv in [0,1): base period in cells per tile. */
function fbm(u: number, v: number, period: number, oct: number, s: number, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let i = 0; i < oct; i++) {
    sum += amp * gnoise(u * p, v * p, p, p, s + i * 101);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Periodic Worley noise: cells per tile C, jitter in [0,1]. Returns a sampler writing F1, F2 (cell units) and the nearest cell hash into W. */
const W = { f1: 0, f2: 0, id: 0 };
function worleyFn(C: number, s: number, jitter = 1) {
  const pts = new Float32Array(C * C * 3);
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    const i = (y * C + x) * 3;
    pts[i] = 0.5 + (hash(x, y, s) - 0.5) * jitter;
    pts[i + 1] = 0.5 + (hash(x, y, s + 7) - 0.5) * jitter;
    pts[i + 2] = hash(x, y, s + 13);
  }
  return (u: number, v: number) => {
    const x = u * C, y = v * C;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 1e9, f2 = 1e9, id = 0;
    for (let j = -1; j <= 1; j++) {
      const cy = yi + j;
      let hy = cy % C; if (hy < 0) hy += C;
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i;
        let hx = cx % C; if (hx < 0) hx += C;
        const o = (hy * C + hx) * 3;
        const dx = cx + pts[o] - x, dy = cy + pts[o + 1] - y;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; id = pts[o + 2]; }
        else if (d < f2) f2 = d;
      }
    }
    W.f1 = Math.sqrt(f1); W.f2 = Math.sqrt(f2); W.id = id;
    return W;
  };
}

// ---------------------------------------------------------------- field helpers
type F = Float32Array;
const field = () => new Float32Array(N * N);
function each(f: (u: number, v: number, i: number) => void) {
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) f((x + 0.5) / N, (y + 0.5) / N, i);
}

/** Thin wrapped line segments (scratches). Adds a 0..1 groove mask into `out`. */
function scratches(out: F, count: number, s: number, lenMin: number, lenMax: number, widthPx: number) {
  for (let k = 0; k < count; k++) {
    const x0 = hash(k, 1, s) * N, y0 = hash(k, 2, s) * N;
    const ang = hash(k, 3, s) * Math.PI;
    const len = (lenMin + (lenMax - lenMin) * hash(k, 4, s)) * N;
    const w = widthPx * (N / 512) * (0.6 + 0.8 * hash(k, 5, s)) + 0.35;
    const depth = 0.4 + 0.6 * hash(k, 6, s);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const steps = Math.ceil(len);
    const r = Math.ceil(w + 1);
    for (let t = 0; t <= steps; t++) {
      // taper at both ends
      const tt = t / steps, taper = Math.sin(Math.PI * tt);
      const cx = x0 + dx * (t - steps / 2), cy = y0 + dy * (t - steps / 2);
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        const px = Math.floor(cx) + ox, py = Math.floor(cy) + oy;
        // distance from pixel center to the line through (cx, cy) along (dx, dy)
        const qx = px + 0.5 - cx, qy = py + 0.5 - cy;
        const d = Math.abs(qx * dy - qy * dx);
        const m = Math.max(0, 1 - d / w) * depth * taper;
        const i = (py & MASK) * N + (px & MASK);
        if (m > out[i]) out[i] = m;
      }
    }
  }
}

/** Pack height (texel units) + albedo + roughness into RGBA8 with a wrap-around normal. */
function pack(h: F, alb: F, rough: F, bump: number): THREE.DataTexture {
  bump *= N / 512; // slopes independent of texture size
  const data = new Uint8Array(N * N * 4);
  for (let y = 0, i = 0; y < N; y++) {
    const ym = ((y - 1) & MASK) * N, yp = ((y + 1) & MASK) * N, yc = y * N;
    for (let x = 0; x < N; x++, i++) {
      const dhx = (h[yc + ((x + 1) & MASK)] - h[yc + ((x - 1) & MASK)]) * 0.5 * bump;
      const dhy = (h[yp + x] - h[ym + x]) * 0.5 * bump;
      const inv = 1 / Math.sqrt(dhx * dhx + dhy * dhy + 1);
      data[i * 4] = Math.round((-dhx * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((-dhy * inv * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, alb[i])) * 255);
      data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, rough[i])) * 255);
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- generators
function genSkin() {
  const h = field(), a = field(), r = field();
  const wPore = worleyFn(42, 11, 0.9), wNet = worleyFn(14, 23, 1), wNet2 = worleyFn(40, 37, 1);
  each((u, v, i) => {
    // pores: small pits on a jittered grid, some cells empty, varying size
    let w = wPore(u, v);
    const pr = 0.13 + 0.12 * w.id;
    const pore = w.id < 0.2 ? 0 : Math.pow(smooth(pr, 0, w.f1), 1.5);
    // micro-relief network: shallow grooves along cell borders (the skin's polygonal mesh)
    w = wNet(u, v);
    const groove = 1 - smooth(0, 0.11, w.f2 - w.f1);
    const plate = w.id;
    w = wNet2(u, v);
    const groove2 = (1 - smooth(0, 0.08, w.f2 - w.f1)) * 0.35;
    const bumps = fbm(u, v, 5, 4, 3);
    const oil = fbm(u, v, 3, 3, 9);
    h[i] = 2.2 * bumps + 0.4 * plate - 1.6 * groove - 0.6 * groove2 - 3.2 * pore;
    a[i] = 0.5 - 0.42 * pore - 0.18 * groove - 0.05 * groove2 + 0.04 * bumps;
    r[i] = 0.5 + 0.22 * pore + 0.12 * groove + 0.28 * oil;
  });
  return pack(h, a, r, 0.55);
}

function genLips() {
  const h = field(), a = field(), r = field();
  const wFine = worleyFn(30, 17, 1);
  each((u, v, i) => {
    // vertical lines (constant u), wavy and broken
    const uu = u + 0.012 * gnoise(v * 4, u * 4, 4, 4, 5) + 0.004 * gnoise(v * 16, u * 3, 16, 3, 6);
    const cells = 28;
    const c = uu * cells;
    const id = Math.floor(c);
    const d = Math.abs(c - id - 0.5) * 2; // 0 at line center... 1 at line
    const breakup = smooth(-0.2, 0.4, gnoise(v * 6, mod(id, cells) * 0.37, 6, 1e6, 8));
    const line = Math.pow(smooth(0.72, 1.0, d), 2) * breakup;
    const w = wFine(u, v);
    const fine = 1 - smooth(0, 0.1, w.f2 - w.f1);
    const n = fbm(u, v, 6, 3, 2);
    h[i] = 1.5 * n - 2.5 * line - 0.5 * fine;
    a[i] = 0.5 - 0.2 * line - 0.05 * fine;
    r[i] = 0.5 + 0.2 * line + 0.2 * fbm(u, v, 4, 2, 21);
  });
  return pack(h, a, r, 0.6);
}

function genLeather(boot: boolean) {
  const h = field(), a = field(), r = field(), scr = field();
  const wGrain = worleyFn(boot ? 48 : 28, boot ? 5 : 4, 1), wSub = worleyFn(80, 19, 1);
  scratches(scr, boot ? 70 : 55, boot ? 41 : 31, 0.03, 0.2, 1.4);
  each((u, v, i) => {
    let w = wGrain(u, v);
    const pebble = smooth(0, 0.34, w.f2 - w.f1) * (0.75 + 0.25 * w.id);
    w = wSub(u, v);
    const sub = smooth(0, 0.25, w.f2 - w.f1);
    const scuffN = fbm(u, v, 4, 4, boot ? 61 : 51);
    const scuff = smooth(0.08, 0.38, scuffN);
    const s = scr[i];
    let crease = 0;
    if (boot) {
      // horizontal ankle creases: wavy rows with fading strength along their length
      const rows = 12;
      const vv = v + 0.012 * gnoise(u * 4, 0.5, 4, 4, 71) + 0.004 * gnoise(u * 16, 0.5, 16, 4, 72);
      const c = vv * rows, id = Math.floor(c), f = c - id - 0.5;
      const rid = mod(id, rows);
      const str = smooth(-0.15, 0.35, gnoise(u * 3, rid * 1.7, 3, 1e6, 73)) * (0.5 + 0.5 * hash(rid, 0, 74));
      crease = Math.exp(-(f * f) / (0.06 * 0.06)) * str;
      const bulge = Math.cos(f * Math.PI) * 0.5 * str;
      h[i] = 1.5 * pebble + 0.4 * sub - 1.6 * s - 0.4 * scuff - 3.0 * crease + 1.2 * bulge;
    } else {
      h[i] = 1.6 * pebble + 0.45 * sub - 1.6 * s - 0.4 * scuff;
    }
    a[i] = 0.5 + 0.1 * (pebble - 0.6) + 0.22 * s + 0.12 * scuff - 0.15 * crease;
    r[i] = 0.5 + 0.25 * scuff + 0.25 * s - 0.08 * pebble + 0.1 * fbm(u, v, 8, 2, 77) + 0.1 * crease;
  });
  return pack(h, a, r, 0.75);
}

function genTwill() {
  const h = field(), a = field(), r = field();
  const T = 16;
  each((u, v, i) => {
    const tu = u * T, tv = v * T;
    const ci = Math.floor(tu), cj = Math.floor(tv);
    const fu = tu - ci, fv = tv - cj;
    const k = mod(cj - ci, 4);
    const warpUp = k < 2;
    const warpW = 0.82 + 0.18 * hash(ci & 15, 0, 3);
    const weftW = 0.82 + 0.18 * hash(cj & 15, 1, 3);
    let hh: number, slub: number;
    if (warpUp) {
      const along = (k + fv) / 2;
      const across = Math.abs(fu - 0.5) * 2 / warpW;
      const prof = Math.sqrt(Math.max(0, 1 - across * across));
      const fiber = gnoise(tu * 8, tv * 2 + tu * 2, T * 8, T * 2, 7) * 0.12;
      hh = prof * (0.75 + 0.25 * Math.sin(Math.PI * along)) + fiber * prof;
      slub = hash(ci & 15, 2, 9);
    } else {
      const m = mod(ci - cj, 4); // 1 or 2 for weft floats
      const along = (m - 1 + fu) / 2;
      const across = Math.abs(fv - 0.5) * 2 / weftW;
      const prof = Math.sqrt(Math.max(0, 1 - across * across));
      const fiber = gnoise(tu * 2 + tv * 2, tv * 8, T * 2, T * 8, 8) * 0.12;
      hh = prof * (0.7 + 0.25 * Math.sin(Math.PI * along)) + fiber * prof;
      slub = hash(cj & 15, 3, 9);
    }
    const n = fbm(u, v, 4, 3, 12);
    h[i] = 9 * hh + 1.5 * n;
    a[i] = 0.5 + 0.22 * (hh - 0.6) + 0.06 * (slub - 0.5) + 0.04 * n;
    r[i] = 0.5 + 0.18 * (0.6 - hh) + 0.08 * n;
  });
  return pack(h, a, r, 0.32);
}

function genKnit() {
  const h = field(), a = field(), r = field();
  const CW = 16, CH = 20;
  const leg = (x: number, y: number, cx: number, cy: number, ang: number) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = x - cx, dy = y - cy;
    const ex = (dx * c - dy * s) / 0.24, ey = (dx * s + dy * c) / 0.66;
    const d = ex * ex + ey * ey;
    return d < 1 ? Math.sqrt(1 - d) : 0;
  };
  each((u, v, i) => {
    const tu = u * CW, tv = v * CH;
    const ci = Math.floor(tu), cj = Math.floor(tv);
    const fu = tu - ci, fv = tv - cj;
    let hh = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const y = fv - dj;
      hh = Math.max(hh, leg(fu, y, 0.29, 0.5, 0.42), leg(fu, y, 0.71, 0.5, -0.42));
    }
    const fiber = gnoise(tu * 6, tv * 6, CW * 6, CH * 6, 4) * 0.1;
    const n = fbm(u, v, 4, 3, 14);
    h[i] = 7 * hh + 1.2 * fiber * hh + 1.2 * n;
    a[i] = 0.5 + 0.2 * (hh - 0.55) + 0.03 * (hash(ci, cj, 5) - 0.5) + 0.04 * n;
    r[i] = 0.5 + 0.15 * (0.55 - hh) + 0.06 * n;
  });
  return pack(h, a, r, 0.35);
}

function genLinen() {
  const h = field(), a = field(), r = field();
  const T = 20;
  const thread = (t: number, along: number, s: number) => {
    // distance-based profile with slubs (thickness varies along the thread) and waviness
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      const id = Math.floor(t) + d;
      const wid = mod(id, T);
      const center = id + 0.5 + 0.09 * gnoise(along * 0.8, wid * 3.1, T * 0.8, 1e6, s);
      const slub = 0.75 + 0.45 * Math.max(0, gnoise(along * 0.5, wid * 5.3, T * 0.5, 1e6, s + 1)) + 0.15 * hash(wid, 0, s + 2);
      const half = 0.34 * slub;
      const x = Math.abs(t - center) / half;
      if (x < 1) best = Math.max(best, Math.sqrt(1 - x * x) * (0.85 + 0.3 * hash(wid, 1, s + 3)));
    }
    return best;
  };
  each((u, v, i) => {
    const tu = u * T, tv = v * T;
    const ci = Math.floor(tu), cj = Math.floor(tv);
    const warpUp = ((ci + cj) & 1) === 0;
    const warp = thread(tu, tv, 31);
    const weft = thread(tv, tu, 47);
    const fu = tu - ci, fv = tv - cj;
    const wa = warp * (warpUp ? 0.8 + 0.2 * Math.sin(Math.PI * fv) : 0.45);
    const we = weft * (!warpUp ? 0.8 + 0.2 * Math.sin(Math.PI * fu) : 0.45);
    const hh = Math.max(wa, we);
    const hole = 1 - smooth(0, 0.25, Math.max(warp, weft));
    const fiber = gnoise(tu * 5, tv * 5, T * 5, T * 5, 6) * 0.1;
    const n = fbm(u, v, 3, 3, 16);
    h[i] = 6 * hh + 1.5 * fiber + 1.0 * n;
    a[i] = 0.5 + 0.2 * (hh - 0.5) - 0.25 * hole + 0.08 * (fbm(u, v, 6, 2, 18)) + 0.05 * n;
    r[i] = 0.5 + 0.15 * (0.5 - hh) + 0.1 * n;
  });
  return pack(h, a, r, 0.4);
}

function genGold() {
  const h = field(), a = field(), r = field(), scr = field();
  const wDent = worleyFn(16, 81, 0.85);
  scratches(scr, 40, 91, 0.02, 0.12, 0.9);
  each((u, v, i) => {
    const w = wDent(u, v);
    const dent = w.f1 * w.f1 * (0.8 + 0.4 * w.id); // concave facets, ridges at cell borders
    const ridge = 1 - smooth(0, 0.12, w.f2 - w.f1);
    const brush = gnoise(u * 128, v * 6, 128, 6, 83) * 0.6 + gnoise(u * 64, v * 3, 64, 3, 84) * 0.4;
    const s = scr[i];
    h[i] = 9 * dent + 0.25 * brush - 1.0 * s;
    a[i] = 0.5 + 0.08 * ridge - 0.05 * w.id + 0.05 * s;
    r[i] = 0.5 - 0.12 * (1 - ridge) * (1 - dent) + 0.22 * ridge + 0.22 * brush + 0.25 * s;
  });
  return pack(h, a, r, 0.6);
}

function genMacro() {
  const h = field(), a = field(), r = field();
  each((u, v, i) => {
    const und = fbm(u, v, 3, 5, 201);
    // creases: ridged noise, two orientations
    const c1 = 1 - Math.abs(fbm(u, v, 5, 3, 211));
    const c2 = 1 - Math.abs(gnoise(u * 9 + 0.3 * gnoise(u * 3, v * 3, 3, 3, 214), v * 3, 9, 3, 213));
    const crease = Math.pow(c1, 10) * 0.7 + Math.pow(c2, 14) * 0.5;
    h[i] = 4 * und - 2.2 * crease;
    a[i] = 0.5 + 0.5 * fbm(u, v, 4, 4, 221) - 0.12 * crease;
    r[i] = 0.5 + 0.5 * fbm(u, v, 5, 3, 231) + 0.08 * crease;
  });
  return pack(h, a, r, 1.2);
}

// ---------------------------------------------------------------- cache
let cache: (Record<MicroKind, THREE.DataTexture> & { macro: THREE.DataTexture }) | null = null;

/** All detail textures, generated on first call (~100-250 ms) and shared by every character. */
export function detailTextures() {
  if (cache) return cache;
  const t0 = performance.now();
  const times: string[] = [];
  const timed = <T,>(name: string, size: number, f: () => T): T => {
    const t = performance.now();
    N = size; MASK = size - 1;
    const r = f();
    times.push(`${name} ${(performance.now() - t).toFixed(0)}`);
    return r;
  };
  cache = {
    skin: timed("skin", 512, genSkin),
    lips: timed("lips", 256, genLips),
    leather: timed("leather", 512, () => genLeather(false)),
    boot: timed("boot", 512, () => genLeather(true)),
    twill: timed("twill", 512, genTwill),
    knit: timed("knit", 512, genKnit),
    linen: timed("linen", 256, genLinen),
    gold: timed("gold", 256, genGold),
    macro: timed("macro", 256, genMacro),
  };
  for (const [k, t] of Object.entries(cache)) t.name = `elf_detail_${k}`;
  console.info(`[detail] generated ${Object.keys(cache).length} detail textures in ${(performance.now() - t0).toFixed(0)} ms (${times.join(", ")})`);
  return cache;
}
