// Mossy clearing floor (tiled procedural moss + large-scale vertex tint that darkens into forest floor) and swaying grass.
import * as THREE from "three";
import { RING_RADIUS } from "./palette";
import { between, canvasTexture, clamp, fbm, hsl, lerp, patch, rng, smooth, valueNoise, type Rng } from "./util";

const TILE = 1.7; // meters per moss texture tile

export function buildGround(root: THREE.Object3D, time: { value: number }, anisotropy: number) {
  const { map, bump } = mossTextures();
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
  }
  const mat = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 1.6, roughness: 0.93, metalness: 0, vertexColors: true });
  // anti-tiling: blend the moss with a rotated, larger copy of itself
  patch(mat, "ground", (s) => {
    s.fragmentShader = s.fragmentShader.replace("#include <map_fragment>", /* glsl */ `
      #ifdef USE_MAP
        vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.37 + vec2(0.31, 0.67);
        vec4 sampledDiffuseColor = mix(texture2D(map, vMapUv), texture2D(map, uvB), 0.45);
        diffuseColor *= sampledDiffuseColor;
      #endif`);
  });
  const ground = new THREE.Mesh(groundGeometry(), mat);
  ground.receiveShadow = true;
  ground.name = "arena-ground";
  root.add(ground);

  root.add(buildGrass(time));
}

// ---------- large-scale tint ----------
const tintNoise = valueNoise(5), tintNoise2 = valueNoise(6);

/** Linear multiplier for the moss texture at (x, z): bright clearing, lush ring band, dark forest floor. */
function groundTint(x: number, z: number, out: number[]) {
  const r = Math.hypot(x, z);
  const n = fbm(tintNoise, x * 0.22 + 50, z * 0.22 + 50, 3);
  const n2 = fbm(tintNoise2, x * 0.8 + 9, z * 0.8 - 3, 3);
  const edge = 5.4 + (n - 0.5) * 3.2;
  const clearing = 1 - smooth(edge - 1.4, edge + 2.2, r);
  const patchy = (0.8 + 0.4 * n2) * 0.85;
  let cr = lerp(0.3, 1.0, clearing) * patchy;
  let cg = lerp(0.27, 1.0, clearing) * patchy;
  let cb = lerp(0.34, 1.0, clearing) * patchy;
  // fairy rings grow a band of darker, lusher moss
  const band = Math.exp(-(((r - RING_RADIUS) / 0.42) ** 2));
  cr *= 1 - 0.3 * band; cg *= 1 - 0.05 * band; cb *= 1 - 0.12 * band;
  // trodden dueling floor, a little worn and earthy
  const worn = 1 - smooth(0.6, 2.0, r);
  cr *= 1 + 0.16 * worn; cg *= 1 - 0.02 * worn; cb *= 1 - 0.12 * worn;
  // forest floor drifts toward dark needle litter
  const far = smooth(7, 16, r);
  cr *= 1 + 0.1 * far; cg *= 1 - 0.12 * far; cb *= 1 - 0.05 * far;
  out[0] = cr; out[1] = cg; out[2] = cb;
}

/** Polar disc: dense uniform rings near the fighters, then growing outward to the horizon. */
function groundGeometry(): THREE.BufferGeometry {
  const radii: number[] = [];
  for (let r = 0.12; r < 9; r += 0.12) radii.push(r);
  for (let r = 9; r < 75; r *= 1.12) radii.push(r);
  const segs = 176;
  const nv = 1 + radii.length * segs;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  const tint = [1, 1, 1];
  const put = (i: number, x: number, z: number) => {
    pos[i * 3] = x; pos[i * 3 + 2] = z;
    nor[i * 3 + 1] = 1;
    uv[i * 2] = x / TILE; uv[i * 2 + 1] = -z / TILE;
    groundTint(x, z, tint);
    col[i * 3] = tint[0]; col[i * 3 + 1] = tint[1]; col[i * 3 + 2] = tint[2];
  };
  put(0, 0, 0);
  radii.forEach((r, ri) => {
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2 + ri * 0.013; // slight twist hides the radial grid
      put(1 + ri * segs + j, Math.cos(a) * r, Math.sin(a) * r);
    }
  });
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let j = 0; j < segs; j++) {
      const a = 1 + ri * segs + j, b = 1 + ri * segs + ((j + 1) % segs);
      const c = a + segs, d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ---------- moss texture ----------
function mossTextures() {
  const S = 512;
  const n1 = valueNoise(21), n2 = valueNoise(22), n3 = valueNoise(23);
  const height = new Float32Array(S * S);
  const r = rng(24);
  const strokes: [number, number, number, number, number][] = [];
  for (let i = 0; i < 2600; i++) {
    const x = r() * S, y = r() * S, a = r() * Math.PI * 2, len = between(r, 4, 13);
    strokes.push([x, y, Math.cos(a) * len, Math.sin(a) * len, r()]);
  }
  const drawStrokes = (ctx: CanvasRenderingContext2D, color: (k: number) => string) => {
    ctx.lineCap = "round";
    for (const [x, y, dx, dy, k] of strokes) {
      ctx.strokeStyle = color(k);
      ctx.lineWidth = 1 + k * 1.2;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        if (x + ox < -20 || x + ox > S + 20 || y + oy < -20 || y + oy > S + 20) continue;
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(x + ox + dx * 0.5 + dy * 0.25, y + oy + dy * 0.5 - dx * 0.25, x + ox + dx, y + oy + dy);
        ctx.stroke();
      }
    }
  };

  const map = canvasTexture(S, S, (ctx) => {
    const img = ctx.createImageData(S, S);
    const dark = [26, 50, 30], light = [58, 88, 44], teal = [24, 60, 54], dirt = [64, 52, 38], tips = [102, 128, 60];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const big = fbm(n1, u * 4, v * 4, 4, 4);
        const mid = fbm(n2, u * 16, v * 16, 3, 16);
        const fine = n3(u * 128, v * 128, 128);
        const d = smooth(0.4, 0.3, big) * smooth(0.55, 0.38, mid) * 0.6;
        const t = smooth(0.5, 0.75, big) * 0.65;
        const tip = smooth(0.7, 0.92, fine) * (1 - d) * 0.65;
        const i = (y * S + x) * 4;
        for (let k = 0; k < 3; k++) {
          let c = lerp(dark[k], light[k], mid);
          c = lerp(c, teal[k], t);
          c = lerp(c, dirt[k], d * 0.85);
          c = lerp(c, tips[k], tip);
          img.data[i + k] = clamp(c * (0.88 + 0.24 * fine), 0, 255);
        }
        img.data[i + 3] = 255;
        height[y * S + x] = 0.5 * mid + 0.32 * fine + 0.18 * big - d * 0.25;
      }
    }
    ctx.putImageData(img, 0, 0);
    drawStrokes(ctx, (k) => `rgba(${80 + k * 50 | 0},${112 + k * 40 | 0},${52 + k * 20 | 0},${0.22 + k * 0.25})`);
  });
  const bump = canvasTexture(S, S, (ctx) => {
    const img = ctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = clamp(height[i] * 255, 0, 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    drawStrokes(ctx, (k) => `rgba(255,255,255,${0.15 + k * 0.25})`);
  }, false);
  return { map, bump };
}

// ---------- grass ----------
function tuftGeometry(r: Rng): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], nor: number[] = [], idx: number[] = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const ang = r() * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const h = between(r, 0.5, 1.0), w = between(r, 0.05, 0.085), lean = between(r, 0.15, 0.55);
    const bx = dx * r() * 0.12, bz = dz * r() * 0.12;
    const start = pos.length / 3;
    const rows = 3;
    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const out = lean * t * t * h;
      const cx = bx + dx * out, cz = bz + dz * out, y = h * t * (1 - lean * 0.25 * t);
      const half = (w * (1 - t)) / 2;
      const shade = lerp(0.3, 1.0, t);
      const nx = dx * 0.35, nz = dz * 0.35, ny = 1;
      if (k < rows) {
        pos.push(cx - dz * half, y, cz + dx * half, cx + dz * half, y, cz - dx * half);
        col.push(shade, shade, shade, shade, shade, shade);
        nor.push(nx, ny, nz, nx, ny, nz);
      } else {
        pos.push(cx, y, cz);
        col.push(shade, shade, shade);
        nor.push(nx, ny, nz);
      }
    }
    for (let k = 0; k < rows - 1; k++) {
      const a = start + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const a = start + (rows - 1) * 2;
    idx.push(a, a + 1, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.normalizeNormals();
  return g;
}

function buildGrass(time: { value: number }): THREE.InstancedMesh {
  const r = rng(31);
  const geo = tuftGeometry(r);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  patch(mat, "grass", (s) => {
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        {
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float sway = sin(uTime * 1.6 + ip.x * 0.9 + ip.y * 0.7) * 0.6 + sin(uTime * 2.7 + ip.x * 2.3 - ip.y * 1.1) * 0.3;
          float k = position.y * position.y;
          transformed.x += sway * k * 0.12;
          transformed.z += sway * k * 0.05;
        }`);
    // both faces of a blade take the same (mostly upward) normal, so tufts are lit like the moss around them
    s.fragmentShader = s.fragmentShader.replace("#include <normal_fragment_begin>",
      THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));
  });

  const COUNT = 2300;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < COUNT && tries < COUNT * 20; tries++) {
    const rad = 1.1 + Math.pow(r(), 0.8) * 10;
    const a = r() * Math.PI * 2;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const nearRing = Math.exp(-(((rad - RING_RADIUS) / 0.7) ** 2));
    const edge = Math.exp(-(((rad - 5.5) / 1.8) ** 2));
    const want = 0.12 + 0.75 * nearRing + 0.6 * edge - 0.35 * (1 - smooth(1.4, 2.2, rad));
    if (r() > want) continue;
    let h = between(r, 0.1, 0.26) * (0.7 + 0.5 * edge + 0.3 * nearRing);
    if (rad < 2.1) h *= 0.35; // the dueling floor stays short so feet read
    if (z > 0.6 && rad < RING_RADIUS + 0.6) h = Math.min(h, 0.16);
    p.set(x, 0, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    s.set(h * between(r, 0.9, 1.4), h, h * between(r, 0.9, 1.4));
    mesh.setMatrixAt(n, m.compose(p, q, s));
    hsl(c, between(r, 0.2, 0.36), between(r, 0.35, 0.6), between(r, 0.2, 0.34));
    mesh.setColorAt(n, c);
    n++;
  }
  mesh.count = n;
  mesh.receiveShadow = true;
  mesh.name = "arena-grass";
  return mesh;
}
