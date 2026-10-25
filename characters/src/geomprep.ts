// One-time per-geometry vertex attributes the elf shaders read (computed at load, shared by clones):
//   _curv  mean curvature (1/m, + convex) from the 1-ring: drives edge wear and curvature-aware skin scattering
//   _thin  0..1 thin-shell weight (ears, fingers) from a local opposite-surface search: drives translucency
//   _flow  hair strand direction (from the asset): normalized, and converted to glTF Y-up if it came as Blender Z-up
import * as THREE from "three";

const done = new WeakSet<THREE.BufferGeometry>();
const flowDone = new WeakSet<THREE.BufferGeometry>();
const thinDone = new WeakSet<THREE.BufferGeometry>();

/** Adds `_curv` (always). Positions and normals are bind pose (mesh space). */
export function ensureCurvature(g: THREE.BufferGeometry) {
  if (done.has(g) || g.getAttribute("_curv")) { done.add(g); return; }
  done.add(g);
  const P = g.getAttribute("position") as THREE.BufferAttribute;
  const Nn = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const n = P.count;
  const curv = new Float32Array(n);
  if (!Nn) { g.setAttribute("_curv", new THREE.BufferAttribute(curv, 1)); return; }
  const p = P.array as ArrayLike<number>, nn = Nn.array as ArrayLike<number>;
  const sum = new Float32Array(n), cnt = new Float32Array(n);
  // weld split vertices (UV/colour seams) by position so curvature is continuous across them
  const key = new Map<string, number>();
  const weld = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
    const w = key.get(k);
    if (w === undefined) { key.set(k, i); weld[i] = i; } else weld[i] = w;
  }
  const edge = (a: number, b: number) => {
    const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-12) return;
    const k = ((nn[a * 3] - nn[b * 3]) * dx + (nn[a * 3 + 1] - nn[b * 3 + 1]) * dy + (nn[a * 3 + 2] - nn[b * 3 + 2]) * dz) / l2;
    const wa = weld[a], wb = weld[b];
    sum[wa] += k; cnt[wa]++;
    sum[wb] += k; cnt[wb]++;
  };
  const idx = g.getIndex();
  if (idx) {
    const ia = idx.array;
    for (let t = 0; t + 2 < ia.length; t += 3) { edge(ia[t], ia[t + 1]); edge(ia[t + 1], ia[t + 2]); edge(ia[t + 2], ia[t]); }
  } else {
    for (let t = 0; t + 2 < n; t += 3) { edge(t, t + 1); edge(t + 1, t + 2); edge(t + 2, t); }
  }
  for (let i = 0; i < n; i++) {
    const w = weld[i];
    curv[i] = cnt[w] > 0 ? Math.max(-2000, Math.min(2000, sum[w] / cnt[w])) : 0;
  }
  g.setAttribute("_curv", new THREE.BufferAttribute(curv, 1));
}

/**
 * Adds `_thin`: for each vertex, the distance to the opposite surface straight behind it (along -normal),
 * found among nearby vertices whose normals face the other way. 1 for <= 4 mm (ear shells), 0 beyond ~2 cm.
 */
export function ensureThickness(g: THREE.BufferGeometry) {
  if (thinDone.has(g) || g.getAttribute("_thin")) { thinDone.add(g); return; }
  thinDone.add(g);
  const P = g.getAttribute("position") as THREE.BufferAttribute;
  const Nn = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const n = P.count;
  const thin = new Float32Array(n);
  if (!Nn) { g.setAttribute("_thin", new THREE.BufferAttribute(thin, 1)); return; }
  const p = P.array as ArrayLike<number>, nn = Nn.array as ArrayLike<number>;
  const CELL = 0.008, R = 0.022, NEAR = 0.004, FAR = 0.02;
  const grid = new Map<number, number[]>();
  const ck = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  for (let i = 0; i < n; i++) {
    const k = ck(Math.floor(p[i * 3] / CELL), Math.floor(p[i * 3 + 1] / CELL), Math.floor(p[i * 3 + 2] / CELL));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const r = Math.ceil(R / CELL);
  for (let i = 0; i < n; i++) {
    const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2];
    const nx = nn[i * 3], ny = nn[i * 3 + 1], nz = nn[i * 3 + 2];
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), cz = Math.floor(pz / CELL);
    let best = 1e9;
    for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const a = grid.get(ck(cx + dx, cy + dy, cz + dz));
      if (!a) continue;
      for (const j of a) {
        const qx = p[j * 3] - px, qy = p[j * 3 + 1] - py, qz = p[j * 3 + 2] - pz;
        const along = -(qx * nx + qy * ny + qz * nz); // depth behind this vertex
        if (along <= 0.0008 || along > R) continue;
        const nd = nx * nn[j * 3] + ny * nn[j * 3 + 1] + nz * nn[j * 3 + 2];
        if (nd > -0.35) continue; // must face the other way (back side of the shell)
        const lat2 = qx * qx + qy * qy + qz * qz - along * along;
        const lim = 0.5 * along + 0.002;
        if (lat2 > lim * lim) continue;
        if (along < best) best = along;
      }
    }
    thin[i] = best > FAR ? 0 : 1 - Math.min(1, Math.max(0, (best - NEAR) / (FAR - NEAR)));
  }
  // light smoothing over the 1-ring so the weight has no speckles
  const idx = g.getIndex();
  if (idx) {
    const acc = new Float32Array(n), c = new Float32Array(n);
    const ia = idx.array;
    for (let t = 0; t + 2 < ia.length; t += 3) {
      const a = ia[t], b = ia[t + 1], d = ia[t + 2];
      acc[a] += thin[b] + thin[d]; c[a] += 2;
      acc[b] += thin[a] + thin[d]; c[b] += 2;
      acc[d] += thin[a] + thin[b]; c[d] += 2;
    }
    for (let i = 0; i < n; i++) if (c[i]) thin[i] = 0.5 * thin[i] + 0.5 * acc[i] / c[i];
  }
  g.setAttribute("_thin", new THREE.BufferAttribute(thin, 1));
}

export type FlowSpace = "y-up" | "z-up (converted)" | "none";

/**
 * Normalizes `_flow` and fixes its axis convention. Blender's glTF exporter converts POSITION and NORMAL
 * to Y-up but writes custom attributes raw, so a flow authored in Blender/MuJoCo space arrives Z-up.
 * A strand direction must lie in the surface, so the convention with the smaller |flow . normal| wins.
 */
export function ensureFlow(g: THREE.BufferGeometry): FlowSpace {
  const F = g.getAttribute("_flow") as THREE.BufferAttribute | undefined;
  if (!F) return "none";
  if (flowDone.has(g)) return (g.userData.flowSpace as FlowSpace) ?? "y-up";
  flowDone.add(g);
  const Nn = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const n = F.count;
  const f = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { f[i * 3] = F.getX(i); f[i * 3 + 1] = F.getY(i); f[i * 3 + 2] = F.getZ(i); }
  let space: FlowSpace = "y-up";
  if (Nn) {
    let dy = 0, dz = 0, m = 0;
    const step = Math.max(1, Math.floor(n / 4000));
    for (let i = 0; i < n; i += step) {
      const x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) continue;
      const nx = Nn.getX(i), ny = Nn.getY(i), nz = Nn.getZ(i);
      dy += Math.abs(x * nx + y * ny + z * nz) / l;
      dz += Math.abs(x * nx + z * ny - y * nz) / l; // Z-up (x, y, z) -> Y-up (x, z, -y)
      m++;
    }
    if (m > 0 && dz < dy * 0.8) space = "z-up (converted)";
  }
  for (let i = 0; i < n; i++) {
    let x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2];
    if (space !== "y-up") { const t = y; y = z; z = -t; }
    const l = Math.hypot(x, y, z);
    if (l > 1e-6) { x /= l; y /= l; z /= l; } else { x = y = z = 0; }
    f[i * 3] = x; f[i * 3 + 1] = y; f[i * 3 + 2] = z;
  }
  g.setAttribute("_flow", new THREE.BufferAttribute(f, 3));
  g.userData.flowSpace = space;
  return space;
}

/** Zero `_flow` so a mesh without strand data can share a flow-shaded material (shader falls back per pixel). */
export function ensureZeroFlow(g: THREE.BufferGeometry) {
  if (!g.getAttribute("_flow")) g.setAttribute("_flow", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3), 3));
}

/**
 * Debug only (`?fakeflow` in the viewer URL): a rough strand field for testing the hair shader before the
 * asset ships `_flow`. Top hair runs toward the ponytail tie, lower hair and the ponytail hang down.
 * Written in Blender Z-up on purpose so the axis detection in ensureFlow is exercised too.
 */
export function synthFlow(g: THREE.BufferGeometry, ponytail: boolean) {
  if (g.getAttribute("_flow")) return;
  const P = g.getAttribute("position"), Nn = g.getAttribute("normal");
  if (!Nn) return;
  const tie = new THREE.Vector3(-0.075, 1.33, 0);
  const f = new Float32Array(P.count * 3);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3(), down = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    p.fromBufferAttribute(P, i);
    n.fromBufferAttribute(Nn, i);
    down.set(0, -1, 0);
    if (ponytail) d.copy(p).sub(tie).normalize().lerp(down, 0.5);
    else {
      const w = Math.min(1, Math.max(0, (p.y - 1.17) / 0.07));
      d.copy(tie).sub(p).normalize().multiplyScalar(w).add(down.multiplyScalar(1 - w));
    }
    d.addScaledVector(n, -d.dot(n)).normalize();
    f[i * 3] = d.x; f[i * 3 + 1] = -d.z; f[i * 3 + 2] = d.y; // Y-up -> Z-up
  }
  g.setAttribute("_flow", new THREE.BufferAttribute(f, 3));
}
