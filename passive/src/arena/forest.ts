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
