// The night forest arena (characters/public/arena.glb) for the screen and the rig, in the MuJoCo frame
// (Z up). The grass is flattened to the physics floor (z = 0) within 4 m of the ring's centre, easing back
// into the terrain by 5.2 m, so feet and falls match the physics. Clouds are hidden (night sky).
import arenaUrl from "@elf-assets/arena.glb?url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** Turns the forest so its giant stump stands behind the fighters from the default camera (as the viewer). */
export const ARENA_YAW = THREE.MathUtils.degToRad(-20);
const FLAT = 4.0, BLEND = 5.2; // m

export async function loadForest(): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(arenaUrl);
  const root = new THREE.Group();
  root.name = "forest";
  const yup = new THREE.Group(); // glTF Y up -> MuJoCo Z up
  yup.rotation.x = Math.PI / 2;
  gltf.scene.rotation.y = ARENA_YAW;
  yup.add(gltf.scene);
  root.add(yup);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const name = mats[0]?.name ?? "";
    if (/cloud/i.test(name)) { m.visible = false; return; }
    if (/grass/i.test(name)) {
      const p = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const r = Math.hypot(p.getX(i), p.getZ(i));
        if (r < BLEND) p.setY(i, p.getY(i) * THREE.MathUtils.smoothstep(r, FLAT, BLEND));
      }
      p.needsUpdate = true;
      m.geometry.computeVertexNormals();
    }
    m.receiveShadow = true;
    m.castShadow = false;
    for (const mat of mats) {
      const sm = mat as THREE.MeshStandardMaterial;
      sm.color?.multiplyScalar(0.8); // the forest sits darker than the fighters
      sm.roughness = 1;
      sm.metalness = 0;
      sm.envMapIntensity = 0.25;
    }
  });
  return root;
}

/**
 * The night around the forest, as the characters viewer draws it (characters/src/viewer.ts): a near-black
 * violet gradient sky, pink and purple stars on a far sphere (mostly above the horizon, not fogged) and a
 * dark violet fog. MuJoCo frame (Z up). The stars sit `radius` m out: inside the camera's far plane.
 */
export function nightSky(scene: THREE.Scene, radius = 52): THREE.Points {
  const c = document.createElement("canvas");
  c.width = 2; c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#05030b");
  grd.addColorStop(0.6, "#0d0718");
  grd.addColorStop(1, "#1a0f2a");
  g.fillStyle = grd;
  g.fillRect(0, 0, 2, 256);
  const sky = new THREE.CanvasTexture(c);
  sky.colorSpace = THREE.SRGBColorSpace;
  scene.background = sky;
  scene.fog = new THREE.Fog(0x120a1e, 16, 60);
  const stars = starField(radius);
  scene.add(stars);
  return stars;
}

/** The viewer's star field (same seed, colours and spread), Z up. */
function starField(r: number, n = 2400): THREE.Points {
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const pal = [new THREE.Color(0xff4fcf), new THREE.Color(0x9a5cff), new THREE.Color(0xc96bff), new THREE.Color(0xff78b4)];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 * Math.PI;
    const v = Math.asin(rnd() * 1.05 - 0.05); // mostly above the horizon
    pos.set([r * Math.cos(v) * Math.cos(u), r * Math.cos(v) * Math.sin(u), r * Math.sin(v)], i * 3);
    const k = pal[Math.floor(rnd() * pal.length)].clone().multiplyScalar(0.35 + 0.65 * rnd() ** 2);
    col.set([k.r, k.g, k.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.8, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
  pts.name = "stars";
  pts.renderOrder = -1;
  return pts;
}
