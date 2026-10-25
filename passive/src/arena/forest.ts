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

/**
 * Magic around the forest, from three asset packs in public/props/: the rune-carved standing stones
 * (magic_stones.fbx) glowing violet back left of the ring, the fairy-land pieces (lanterns, sigil
 * stone, fountain, fairy house, glowing flowers) scattered outside it, and the windmill with its trees
 * far back in the fog. Nothing comes within PROP_CLEAR m of the ring's centre. MuJoCo frame (Z up).
 */
const PROP_CLEAR = 5.0; // m
export async function loadMagicProps(forest?: THREE.Object3D): Promise<THREE.Group> {
  const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
  const tex = new THREE.TextureLoader();
  const t = (url: string, srgb = true) => { const x = tex.load(url); if (srgb) x.colorSpace = THREE.SRGBColorSpace; return x; };
  const root = new THREE.Group();
  root.name = "magic-props";
  const yup = new THREE.Group(); // the packs are Y up (like arena.glb): this is the forest's own frame
  yup.rotation.x = Math.PI / 2;
  root.add(yup);
  const glowing = (map: THREE.Texture, emissive: THREE.Texture, strength: number) => new THREE.MeshStandardMaterial({
    map, emissiveMap: emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: strength, roughness: 0.9, metalness: 0,
  });
  const [stones, fairy, mill] = await Promise.all([
    new FBXLoader().loadAsync("/props/stones/magic_stones.fbx"),
    new FBXLoader().loadAsync("/props/fairy/Fairyforest.fbx"),
    new GLTFLoader().loadAsync("/props/windmill/windmill.glb"),
  ]);
  // the rune stones: runes glowing, the pack's ground disc dropped
  const stoneMat = glowing(t("/props/stones/Magic_Stones_BaseColor.png"), t("/props/stones/Magic_Stones_Emission.png"), 1.4);
  stoneMat.emissive.setHex(0xb48cff); // the runes glow violet
  stoneMat.normalMap = t("/props/stones/Magic_Stones_Normal.png", false);
  stones.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if ((Array.isArray(m.material) ? m.material[0] : m.material)?.name === "G") { m.visible = false; return; }
    m.material = stoneMat; m.castShadow = true; m.receiveShadow = true;
  });
  const sb = new THREE.Box3().setFromObject(stones), sc = sb.getCenter(new THREE.Vector3());
  const ring = new THREE.Group();
  ring.add(stones);
  stones.position.set(-sc.x, -sb.min.y, -sc.z);
  ring.scale.setScalar(0.006); // a 3 m cluster of rune stones, back left of the ring
  ring.position.set(-5.2, 0, -5.4);
  yup.add(ring);
  // fairy land: a hand-picked set of pieces on chosen spots behind and beside the ring, plus small
  // grass, reed and flower clumps scattered over the grass; each one set down on the forest's terrain
  // (a downward ray), and a spot is skipped when the ray meets a tree, a rock or the stump instead
  const fairyMat = glowing(t("/props/fairy/T_Fairy_A.png"), t("/props/fairy/T_Fairy_E.png"), 1.6);
  fairy.scale.setScalar(0.01);
  fairy.updateMatrixWorld(true);
  const piece = (name: string): THREE.Object3D | null => {
    const src = fairy.getObjectByName(name) as THREE.Mesh | undefined;
    if (!src?.isMesh) return null;
    const m = new THREE.Mesh(src.geometry, fairyMat);
    m.applyMatrix4(src.matrixWorld);
    const b = new THREE.Box3().setFromObject(m), c = b.getCenter(new THREE.Vector3());
    m.position.x -= c.x; m.position.z -= c.z; m.position.y -= b.min.y;
    m.castShadow = true;
    const g = new THREE.Group(); g.add(m);
    return g;
  };
  forest?.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const placed: { x: number; z: number; r: number }[] = [];
  /** Sets a piece down at (x, z) of the forest's frame; false when the spot is not open grass or is taken. */
  const put = (name: string, x: number, z: number, scale: number, rot: number, room: number): boolean => {
    if (Math.hypot(x, z) < PROP_CLEAR || placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + room)) return false;
    let y = 0;
    if (forest) {
      ray.set(new THREE.Vector3(x, -z, 40), new THREE.Vector3(0, 0, -1)); // the forest's frame (Y up) -> MuJoCo (Z up)
      const hit = ray.intersectObject(forest, true).find((h) => (h.object as THREE.Mesh).visible);
      if (!hit) return false;
      const mat = (Array.isArray((hit.object as THREE.Mesh).material) ? ((hit.object as THREE.Mesh).material as THREE.Material[])[0] : (hit.object as THREE.Mesh).material as THREE.Material);
      if (!/grass/i.test(mat?.name ?? "")) return false;
      y = hit.point.z;
    }
    const g = piece(name);
    if (!g) return false;
    g.position.set(x, y - 0.03, z); g.rotation.y = rot; g.scale.setScalar(scale);
    yup.add(g);
    placed.push({ x, z, r: room });
    return true;
  };
  // the big pieces, behind (-z) and to the sides of the ring, never on the camera's side (+z)
  const BIG: [string, number, number, number][] = [ // name, angle (deg, 0 = +x, -90 = straight behind), radius m, scale
    ["Acorn_streetlight", -40, 6.5, 0.55], ["Acorn_streetlight", -140, 6.5, 0.55], ["Sigil_stone", -90, 7.5, 0.6],
    ["Lutin_house_5", -15, 7.5, 0.8], ["Lutin_house_3", -165, 7.5, 0.8], ["Wishing_well", -115, 8.5, 0.6],
    ["Lutin_house_1", 5, 8, 0.8], ["Lutin_house_4", 175, 8, 0.8], ["Dandelion_1", -60, 9, 0.6], ["blue_lilly_1", -125, 6.2, 0.6],
    ["blue_lilly_3", -55, 6.2, 0.6], ["Fairy_house", -100, 11, 0.6], ["Dandelion_2", -150, 10, 0.6], ["Light_1", 20, 6.2, 0.9], ["Light_3", 160, 6.2, 0.9],
  ];
  for (const [n, a, r, sc] of BIG) {
    const rad = THREE.MathUtils.degToRad(a);
    for (const dr of [0, 0.8, -0.6, 1.6]) if (put(n, Math.cos(rad) * (r + dr), Math.sin(rad) * (r + dr), sc, rad + Math.PI / 2, 1.2)) break;
  }
  // small clumps all round (grass, reeds, flowers), seeded so every load looks the same
  const SMALL = ["High_grass_1", "High_grass_2", "High_grass_3", "Reed_1", "Reed_3", "Purpelbell_1", "LionSun_1", "Red_horn_1", "HightPrincess_1", "popflower_1", "PaleHorn_1"];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0, n = 0; k < 600 && n < 140; k++) {
    const a = rnd() * Math.PI * 2, r = 5.2 + rnd() * 8;
    const name = SMALL[Math.floor(rnd() * SMALL.length)];
    const sc = name.startsWith("High_grass") ? 0.18 + 0.1 * rnd() : name.startsWith("popflower") ? 0.25 : 0.45 + 0.3 * rnd();
    if (put(name, Math.cos(a) * r, Math.sin(a) * r, sc, rnd() * Math.PI * 2, 0.35)) n++;
  }
  // the windmill and its trees, far back behind the fighters, in the fog
  mill.scene.scale.setScalar(0.7);
  mill.scene.position.set(18, -0.3, -32); // a far silhouette, half in the fog
  mill.scene.rotation.y = -0.6;
  yup.add(mill.scene);
  return root;
}
