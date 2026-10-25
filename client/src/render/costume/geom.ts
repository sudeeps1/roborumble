// Procedural geometry for costume pieces. Costume space is a MuJoCo body frame: +X forward, +Y left, +Z up, meters.
// Build-time only (allocations are fine here); nothing in this file runs per frame.
import * as THREE from "three";

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const lerp = THREE.MathUtils.lerp;
export const clamp = THREE.MathUtils.clamp;
export const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

/** three.js primitives are Y-up; this turns +Y into +Z. */
export function zUp<T extends THREE.BufferGeometry>(g: T): T {
  g.rotateX(Math.PI / 2);
  return g;
}

/** Point a geometry built along +Z so that +Z runs along `dir`, then move it to `at`. */
export function aim<T extends THREE.BufferGeometry>(g: T, at: THREE.Vector3, dir: THREE.Vector3, spin = 0): T {
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), dir.clone().normalize());
  if (spin) q.multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), spin));
  g.applyMatrix4(new THREE.Matrix4().compose(at, q, V(1, 1, 1)));
  return g;
}

/**
 * Tapered tube along a smooth curve through `pts`; radius r(u), u = 0 at the first point .. 1 at the last.
 * uv.x runs around, uv.y runs along the tube from v0 to v1 (for gradient emissive maps). Same winding as TubeGeometry.
 */
export function sweep(pts: THREE.Vector3[], r: (u: number) => number, segs = 16, radial = 8, v0 = 0, v1 = 1, capStart = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const frames = curve.computeFrenetFrames(segs, false);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const P = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    curve.getPointAt(u, P);
    const N = frames.normals[i], B = frames.binormals[i];
    const rad = r(u);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const s = Math.sin(a), c = -Math.cos(a);
      n.set(c * N.x + s * B.x, c * N.y + s * B.y, c * N.z + s * B.z).normalize();
      nor.push(n.x, n.y, n.z);
      pos.push(P.x + rad * n.x, P.y + rad * n.y, P.z + rad * n.z);
      uv.push(j / radial, lerp(v0, v1, u));
    }
  }
  for (let i = 1; i <= segs; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1), b = (radial + 1) * i + (j - 1), c = (radial + 1) * i + j, d = (radial + 1) * (i - 1) + j;
      idx.push(a, b, d, b, c, d);
    }
  }
  if (capStart) {
    const t = curve.getTangentAt(0);
    const center = pos.length / 3;
    const p0 = curve.getPointAt(0);
    pos.push(p0.x, p0.y, p0.z);
    nor.push(-t.x, -t.y, -t.z);
    uv.push(0.5, v0);
    for (let j = 0; j < radial; j++) idx.push(center, j + 1, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Parametric surface grid: f(u, v, out) for u, v in [0, 1]. Normals are recomputed from the triangles.
 * Front faces point along dP/dv x dP/du.
 */
export function surface(f: (u: number, v: number, out: THREE.Vector3) => void, nu: number, nv: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      f(i / nu, j / nv, p);
      pos.push(p.x, p.y, p.z);
      uv.push(i / nu, 1 - j / nv);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = (j + 1) * (nu + 1) + i, c = a + 1, d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Flat ribbons along 2D polylines (a glyph), in the XY plane facing +Z. Width in the same units as the points. */
export function stroke(lines: [number, number][][], width: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const h = width / 2;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [x0, y0] = line[i], [x1, y1] = line[i + 1];
      let dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // extend each segment by half a width so joints overlap instead of cracking
      const ax = x0 - dx * h * 0.8, ay = y0 - dy * h * 0.8, bx = x1 + dx * h * 0.8, by = y1 + dy * h * 0.8;
      const nx = -dy * h, ny = dx * h;
      const o = pos.length / 3;
      pos.push(ax + nx, ay + ny, 0, ax - nx, ay - ny, 0, bx + nx, by + ny, 0, bx - nx, by - ny, 0);
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length);
  for (let i = 2; i < n.length; i += 3) n[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  return g;
}

/** Merge geometries (position/normal/uv, plus color if any has it; missing colors become white). Disposes the inputs. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const withColor = geos.some((g) => g.getAttribute("color"));
  let nv = 0, ni = 0;
  for (const g of geos) {
    const c = g.getAttribute("position").count;
    nv += c;
    ni += g.index ? g.index.count : c;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = withColor ? new Float32Array(nv * 3).fill(1) : null;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.getAttribute("position"), n = g.getAttribute("normal"), t = g.getAttribute("uv"), c = g.getAttribute("color");
    for (let i = 0; i < p.count; i++) {
      const k = vo + i;
      pos[k * 3] = p.getX(i); pos[k * 3 + 1] = p.getY(i); pos[k * 3 + 2] = p.getZ(i);
      if (n) { nor[k * 3] = n.getX(i); nor[k * 3 + 1] = n.getY(i); nor[k * 3 + 2] = n.getZ(i); }
      if (t) { uv[k * 2] = t.getX(i); uv[k * 2 + 1] = t.getY(i); }
      if (col && c) { col[k * 3] = c.getX(i); col[k * 3 + 1] = c.getY(i); col[k * 3 + 2] = c.getZ(i); }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < p.count; i++) idx[io++] = vo + i;
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Solid vertex color (so it can be merged with other colored parts into one draw call). */
export function paint<T extends THREE.BufferGeometry>(g: T, hex: number): T {
  const c = new THREE.Color(hex);
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

/** Vertex colors blending `base` to `moss` on up-facing surfaces, broken up by noise ("mossy iron"). */
export function mossify<T extends THREE.BufferGeometry>(g: T, base: number, moss: number, amount = 1, bias = 0): T {
  const cb = new THREE.Color(base), cm = new THREE.Color(moss), c = new THREE.Color();
  const p = g.getAttribute("position"), n = g.getAttribute("normal");
  const a = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const noise = Math.sin(x * 91 + y * 37) * Math.sin(y * 73 - z * 59) * Math.sin(z * 83 + x * 29);
    const k = clamp((n ? n.getZ(i) : 0) * 0.9 + noise * 0.9 - 0.15 + bias, 0, 1) * amount;
    c.copy(cb).lerp(cm, k);
    a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

/** Flat leaf/petal outline in the XY plane, base at the origin pointing along +Y, `w` half-width at the widest. */
export function leafShape(len: number, w: number, tipCurl = 0): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(w * 1.1, len * 0.25, w * 0.9, len * 0.7, tipCurl, len);
  s.bezierCurveTo(-w * 0.9, len * 0.7, -w * 1.1, len * 0.25, 0, 0);
  return s;
}

/** Flat shape -> geometry with uvs normalised to its bounding box. */
export function shapeGeo(shape: THREE.Shape, curveSegs = 8): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape, curveSegs);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const uv = g.getAttribute("uv");
  const p = g.getAttribute("position");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) - bb.min.x) / (bb.max.x - bb.min.x || 1), (p.getY(i) - bb.min.y) / (bb.max.y - bb.min.y || 1));
  return g;
}

/** Hexagonal crystal along +Z: prism of radius r and height h with a pointed tip. Use with flatShading. */
export function crystal(r: number, h: number, tip = r * 2.2, sides = 6): THREE.BufferGeometry {
  const pts = [new THREE.Vector2(0, -r * 0.5), new THREE.Vector2(r * 0.8, 0), new THREE.Vector2(r, h * 0.15), new THREE.Vector2(r * 0.92, h), new THREE.Vector2(0, h + tip)];
  return zUp(new THREE.LatheGeometry(pts, sides));
}

/** A small rose bloom facing +Z, ~`size` across. */
export function rose(size = 0.04): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const petal = (ring: number, count: number, tilt: number, len: number, rot: number) => {
    for (let i = 0; i < count; i++) {
      const a = rot + (i / count) * Math.PI * 2;
      const g = new THREE.SphereGeometry(1, 7, 5);
      g.scale(len, len * 0.8, len * 0.32);
      g.translate(len * 0.55, 0, 0);
      g.rotateY(-tilt);
      g.translate(ring, 0, 0);
      g.rotateZ(a);
      parts.push(g);
    }
  };
  const s = size / 0.04;
  petal(0.009 * s, 5, 1.05, 0.0125 * s, 0);
  petal(0.006 * s, 4, 0.7, 0.0095 * s, 0.6);
  petal(0.003 * s, 3, 0.35, 0.007 * s, 1.3);
  const bud = new THREE.SphereGeometry(0.0055 * s, 8, 6);
  bud.scale(1, 1, 1.25);
  bud.translate(0, 0, 0.004 * s);
  parts.push(bud);
  return merge(parts);
}

/** Small cone spikes (thorns) along a curve, sticking out sideways at a different angle each, leaning toward the tip. */
export function thornsAlong(curvePts: THREE.Vector3[], count: number, len: number, rad: number, seed = 1, u0 = 0.08, u1 = 0.95): THREE.BufferGeometry[] {
  const curve = new THREE.CatmullRomCurve3(curvePts, false, "centripetal");
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const u = lerp(u0, u1, (i + 0.5) / count);
    const p = curve.getPointAt(u), t = curve.getTangentAt(u);
    // a direction perpendicular to the tangent, rotating around it
    const a = seed * 2.4 + i * 2.2;
    const ref = Math.abs(t.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0);
    const n1 = ref.clone().cross(t).normalize(), n2 = t.clone().cross(n1).normalize();
    const d = n1.multiplyScalar(Math.cos(a)).add(n2.multiplyScalar(Math.sin(a))).addScaledVector(t, 0.35).normalize();
    const g = zUp(new THREE.ConeGeometry(rad, len, 5, 1));
    g.translate(0, 0, len / 2);
    out.push(aim(g, p, d));
  }
  return out;
}

/** Points on a curve (for placing things along a path). */
export function curvePoint(pts: THREE.Vector3[], u: number): THREE.Vector3 {
  return new THREE.CatmullRomCurve3(pts, false, "centripetal").getPointAt(u);
}

// ---------- glyph polylines (unit size, centered) ----------
type Line = [number, number][];
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16): Line =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

export const GLYPHS: Record<string, Line[]> = {
  rose: [
    Array.from({ length: 28 }, (_, i) => {
      const s = i / 27, a = s * Math.PI * 2.7 + 0.4, r = 0.06 + 0.36 * s;
      return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
    }),
    [[0.1, -0.42], [0.0, -0.5]],
    [[-0.32, -0.12], [-0.46, -0.2]],
  ],
  flame: [
    [[0, -0.46], [0.24, -0.36], [0.33, -0.12], [0.24, 0.1], [0.1, 0.22], [0.16, 0.48], [-0.08, 0.3], [-0.26, 0.1], [-0.33, -0.12], [-0.24, -0.36], [0, -0.46]],
    [[0, -0.3], [0.1, -0.16], [0.06, 0.02], [-0.06, -0.08], [-0.1, -0.2], [0, -0.3]],
  ],
  bolt: [[[0.16, 0.5], [-0.14, 0.04], [0.12, 0.04], [-0.16, -0.5]]],
  snowflake: (() => {
    const lines: Line[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 2;
      const c = Math.cos(a), s = Math.sin(a);
      lines.push([[-0.48 * c, -0.48 * s], [0.48 * c, 0.48 * s]]);
      for (const sign of [1, -1]) {
        const bx = sign * 0.3 * c, by = sign * 0.3 * s;
        for (const side of [1, -1]) {
          const b = a + side * 0.75 + (sign < 0 ? Math.PI : 0);
          lines.push([[bx, by], [bx + 0.16 * Math.cos(b), by + 0.16 * Math.sin(b)]]);
        }
      }
    }
    return lines;
  })(),
  crescent: [
    [...arc(0, 0, 0.44, 0.7, Math.PI * 2 - 0.7, 20), ...arc(0.2, 0, 0.36, Math.PI * 2 - 1.05, 1.05, 16), [0.44 * Math.cos(0.7), 0.44 * Math.sin(0.7)]],
    [[0.27, -0.13], [0.27, 0.13]], [[0.14, 0], [0.4, 0]],
  ],
};

/** Circle polyline for medallion rims. */
export const ring = (r: number, n = 28): Line => arc(0, 0, r, 0, Math.PI * 2, n);
