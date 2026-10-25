// Moonlit forest around the clearing: firs and round trees (trunks + layered canopies), bushes and mossy rocks.
// Everything is instanced. Trees keep out of a cone straight behind the fighters so the moon and the far
// treelines stay visible from the default camera; they crowd in behind-left, behind-right and at the sides.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { CAM, RING_RADIUS } from "./palette";
import { between, hsl, patch, rng, valueNoise, type Rng } from "./util";

const jn = valueNoise(41);

/** Position-based jitter (same input position -> same offset), so shared vertices move together. */
function jitter(g: THREE.BufferGeometry, amt: number, freq: number) {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = jn(x * freq + 13.1 + y * 0.7, z * freq + y * freq * 1.3) - 0.5;
    const k = 1 + n * amt;
    p.setXYZ(i, x * k, y + n * amt * 0.25, z * k);
  }
}

/** Merge parts, weld coincident vertices, jitter, smooth normals, base at y=0 and height 1. */
function soft(parts: THREE.BufferGeometry[], amt: number, freq: number): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute("normal");
    n.deleteAttribute("uv");
    return n;
  });
  const g = mergeVertices(mergeGeometries(flat)!, 1e-4);
  jitter(g, amt, freq);
  g.computeVertexNormals();
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(0, -b.min.y, 0);
  const sc = 1 / (b.max.y - b.min.y);
  g.scale(sc, sc, sc);
  return g;
}

function firGeometry(): THREE.BufferGeometry {
  const layers: [number, number, number][] = [[0, 0.3, 1], [0.13, 0.28, 0.88], [0.26, 0.26, 0.75], [0.39, 0.24, 0.62], [0.51, 0.22, 0.49], [0.62, 0.2, 0.37], [0.72, 0.18, 0.26], [0.8, 0.2, 0.15]];
  const parts = layers.map(([y0, h, r], i) => {
    const c = new THREE.ConeGeometry(r, h, 12, 1, false).toNonIndexed();
    // droop the skirt: each layer's rim hangs below its middle, in six heavier branch tips
    const p = c.getAttribute("position") as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k);
      if (p.getY(k) < -h / 2 + 1e-4 && Math.hypot(x, z) > r * 0.5) {
        const a = Math.atan2(z, x);
        const tip = 0.5 + 0.5 * Math.cos(a * 6);
        p.setXYZ(k, x * (1 + 0.12 * tip), p.getY(k) - h * (0.22 + 0.2 * tip), z * (1 + 0.12 * tip));
      }
    }
    c.rotateY(i * 0.83);
    c.translate(0, y0 + h / 2, 0);
    return c;
  });
  return soft(parts, 0.2, 3.2);
}

function blobGeometry(blobs: [number, number, number, number][], amt: number): THREE.BufferGeometry {
  return soft(blobs.map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z)), amt, 3.5);
}

function trunkGeometry(): THREE.BufferGeometry {
  const pts = ([[1.7, 0], [1.1, 0.03], [0.86, 0.12], [0.7, 0.45], [0.55, 1]] as const).map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 7);
}

interface Tree { x: number; z: number; h: number; kind: "fir" | "round"; }

/** Azimuth (deg) of a ground point seen from the default camera; 0 = straight behind the fighters. */
const azimuth = (x: number, z: number) => Math.abs(Math.atan2(x, CAM.z - z)) * 180 / Math.PI;

export function buildForest(root: THREE.Object3D, time: { value: number }) {
  const r = rng(51);
  const trees: Tree[] = [];
  const near = (x: number, z: number, d: number) => trees.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < d * d);
  for (let i = 0; i < 30000 && trees.length < 230; i++) {
    const x = between(r, -32, 32), z = between(r, -36, 2.5);
    const rad = Math.hypot(x, z);
    if (rad < 5.8 || rad > 34) continue;
    const az = azimuth(x, z);
    if (az < 15) continue;
    if (az < 22 && r() > (az - 15) / 7) continue;
    if (near(x, z, 1.3 + rad * 0.07)) continue;
    const kind = r() < 0.72 ? "fir" : "round";
    let h = between(r, 5.5, 10.5) * (1 + rad * 0.012);
    if (az < 22) h *= 0.75;
    trees.push({ x, z, h, kind });
  }

  const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, flatShading: true });
  const leaves = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  // slow canopy sway, stronger toward the treetops (canopy geometry is unit height)
  patch(leaves, "leaves", (s) => {
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        {
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float w = sin(uTime * 0.55 + ip.x * 0.31 + ip.y * 0.17) + 0.35 * sin(uTime * 1.31 + ip.x * 0.9 - ip.y * 0.4);
          float k = position.y * position.y;
          transformed.x += w * k * 0.03;
          transformed.z += w * k * 0.015;
        }`);
  });
  const firs = trees.filter((t) => t.kind === "fir"), rounds = trees.filter((t) => t.kind === "round");
  const trunkMesh = new THREE.InstancedMesh(trunkGeometry(), bark, trees.length);
  const firMesh = new THREE.InstancedMesh(firGeometry(), leaves, firs.length);
  const roundMesh = new THREE.InstancedMesh(
    blobGeometry([[0, 0.5, 0, 0.5], [0.34, 0.42, 0.12, 0.38], [-0.32, 0.46, -0.1, 0.4], [0.05, 0.78, -0.12, 0.36], [-0.1, 0.36, 0.32, 0.33], [0.12, 0.3, -0.3, 0.3]], 0.25),
    leaves, rounds.length,
  );

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const c = new THREE.Color();
  let fi = 0, ri = 0;
  trees.forEach((t, i) => {
    const lean = between(r, -0.04, 0.04);
    e.set(lean, r() * Math.PI * 2, between(r, -0.04, 0.04));
    q.setFromEuler(e);
    const trunkR = t.h * between(r, 0.022, 0.032);
    const clear = t.kind === "fir" ? between(r, 0.5, 1.3) : between(r, 1.6, 2.6);
    const trunkH = t.kind === "fir" ? clear + (t.h - clear) * 0.55 : clear + 1.2;
    p.set(t.x, -0.05, t.z);
    s.set(trunkR, trunkH, trunkR);
    trunkMesh.setMatrixAt(i, m.compose(p, q, s));
    hsl(c, between(r, 0.05, 0.1), between(r, 0.12, 0.25), between(r, 0.07, 0.12));
    trunkMesh.setColorAt(i, c);

    p.set(t.x, clear, t.z);
    const ch = t.h - clear;
    if (t.kind === "fir") {
      const cr = t.h * between(r, 0.17, 0.23);
      s.set(cr, ch, cr * between(r, 0.85, 1.15));
      firMesh.setMatrixAt(fi, m.compose(p, q, s));
      hsl(c, between(r, 0.42, 0.5), between(r, 0.25, 0.4), between(r, 0.08, 0.13));
      firMesh.setColorAt(fi++, c);
    } else {
      const cr = t.h * between(r, 0.24, 0.3);
      s.set(cr * 1.4, ch, cr * 1.4 * between(r, 0.85, 1.15));
      roundMesh.setMatrixAt(ri, m.compose(p, q, s));
      hsl(c, between(r, 0.36, 0.44), between(r, 0.2, 0.35), between(r, 0.08, 0.13));
      roundMesh.setColorAt(ri++, c);
    }
  });
  for (const mesh of [trunkMesh, firMesh, roundMesh]) {
    mesh.name = "arena-trees";
    root.add(mesh);
  }

  root.add(buildBushes(r), buildRocks(r));
}

function buildBushes(r: Rng): THREE.InstancedMesh {
  const geo = blobGeometry([[0, 0.42, 0, 0.45], [0.42, 0.32, 0.1, 0.36], [-0.4, 0.3, -0.05, 0.38], [0.1, 0.3, 0.38, 0.3], [-0.12, 0.28, -0.4, 0.32]], 0.3);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const COUNT = 130;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  let n = 0;
  for (let i = 0; i < 5000 && n < COUNT; i++) {
    const a = r() * Math.PI * 2, rad = between(r, 4.3, 11);
    const x = Math.sin(a) * rad, z = -Math.cos(a) * rad;
    if (z > 1.5 && Math.abs(x) < 6.5) continue; // nothing between the camera and the fighters
    const az = azimuth(x, z);
    // behind the fighters bushes stay under the eye line, so the far vista stays open
    let h = az < 22 ? between(r, 0.35, 0.85) : between(r, 0.5, 1.5);
    if (rad < 5) h *= 0.7;
    p.set(x, -0.05, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    const w = h * between(r, 1.0, 1.6);
    s.set(w, h, w * between(r, 0.8, 1.2));
    mesh.setMatrixAt(n, m.compose(p, q, s));
    hsl(c, between(r, 0.3, 0.45), between(r, 0.25, 0.45), between(r, 0.1, 0.17));
    mesh.setColorAt(n++, c);
  }
  mesh.count = n;
  mesh.name = "arena-bushes";
  return mesh;
}

function buildRocks(r: Rng): THREE.InstancedMesh {
  const geo = new THREE.DodecahedronGeometry(1, 1);
  jitter(geo, 0.35, 1.7);
  geo.translate(0, 0.35, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true });
  const spots: [number, number, number][] = [[-3.6, -2.2, 0.32], [-3.9, -1.5, 0.18], [3.8, -2.6, 0.38], [4.3, -1.9, 0.2], [-1.6, -4.4, 0.26], [2.2, -4.6, 0.22], [-5.2, 0.6, 0.4], [5.4, 0.2, 0.34], [0.6, -4.9, 0.16], [-4.6, -3.6, 0.5]];
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const c = new THREE.Color();
  spots.forEach(([x, z, k], i) => {
    // keep clear of the ring itself
    const rad = Math.hypot(x, z);
    const push = rad < RING_RADIUS + 0.7 ? (RING_RADIUS + 0.7) / rad : 1;
    e.set(between(r, -0.2, 0.2), r() * Math.PI * 2, between(r, -0.2, 0.2));
    q.setFromEuler(e);
    p.set(x * push, -k * 0.25, z * push);
    s.set(k * between(r, 1.1, 1.6), k * between(r, 0.6, 0.9), k * between(r, 1.0, 1.4));
    mesh.setMatrixAt(i, m.compose(p, q, s));
    hsl(c, between(r, 0.22, 0.36), between(r, 0.12, 0.25), between(r, 0.16, 0.24));
    mesh.setColorAt(i, c);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "arena-rocks";
  return mesh;
}
