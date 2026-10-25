// The setting: a meadow at dusk. A soft sandy pad that fades into the grass where the ropes start (no
// ring line), and a loose ring of round trees in the haze. No hard edges: the sky's horizon is the
// fog's colour, so the ground melts into it.
// Compatible with the physics: the ground is flat at z = 0 everywhere a body or the camera can be
// (nothing but the floor within 20 m); the pad's fade starts at the ropes (REFEREE.rope).
import * as THREE from "three";
import { REFEREE } from "../core/arena.ts";
import type { FxLook } from "./fx.ts";
import type { Stage } from "./stage.ts";
import { loadForest, nightSky } from "../arena/forest.ts";

export interface ArenaSet { look: FxLook; update(t: number, dt: number): void }

/** The night forest (characters/public/arena.glb), softly lit: a moonlit key, a violet sky fill, haze. */
export function buildForestArena(stage: Stage): ArenaSet {
  const s = stage.scene;
  nightSky(s, 150); // the viewer's violet sky, stars and fog (its far plane is 220 m)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x2c3a2a, roughness: 1 }));
  floor.receiveShadow = true; // until the forest has loaded
  s.add(floor);
  loadForest().then((g) => { s.add(g); floor.visible = false; }).catch((e) => console.warn("forest not loaded, plain floor:", e));
  stage.hemi.color.setHex(0x8a7ab8);
  stage.hemi.groundColor.setHex(0x34442e);
  stage.hemi.intensity = 0.8;
  stage.key.color.setHex(0xe6dcff);
  stage.key.intensity = 2.1;
  return { look: { dust: 0x9a8f80, stone: 0x5e5648, fist: 0xffe2a8, block: 0xb8e4ff }, update() {} };
}

const C = {
  skyTop: 0x2c2e57, skyGlow: 0xd29fa4, haze: 0x726890,  // the horizon IS the fog colour
  grass: 0x5a755f, pad: 0xae9a7f,
  trunk: 0x5c4a3e, leaves: [0x4f7c6c, 0x5f8c70, 0x6f9676, 0x4b6f6e],
};
// m: solid sand to the ropes, then a fade into the grass (a thrown body lands on grass)
const PAD = { solid: REFEREE.rope, fade: 4.3 };
const TREES = { inner: 24, outer: 34, count: 24 };

function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

/** A radial canvas texture: stops are [radius 0..1, css colour]. */
function radial(stops: [number, string][], size = 512) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [r, c] of stops) grd.addColorStop(r, c);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const css = (hex: number, a = 1) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

export function buildArena(stage: Stage): ArenaSet {
  const s = stage.scene;
  const root = new THREE.Group();
  root.name = "setting";
  s.add(root);
  s.background = new THREE.Color(C.haze);
  s.fog = new THREE.FogExp2(C.haze, 0.03); // clear near the fight, soft by the trees, gone by the horizon

  // sky: a gradient dome; at and below the horizon it is exactly the fog colour
  const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(C.skyTop) }, glow: { value: new THREE.Color(C.skyGlow) }, haze: { value: new THREE.Color(C.haze) } },
    vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 top, glow, haze; varying vec3 vDir;
      void main() {
        float h = vDir.z; // Z up
        vec3 c = mix(haze, glow, smoothstep(0.0, 0.1, h) * 0.55);
        c = mix(c, top, smoothstep(0.06, 0.55, h));
        gl_FragColor = vec4(h <= 0.0 ? haze : c, 1.0);
      }`,
  }));
  sky.renderOrder = -1;
  root.add(sky);

  // ground: grass to the horizon, flat at z = 0 (the physics floor)
  const ground = new THREE.Mesh(new THREE.CircleGeometry(90, 96), new THREE.MeshStandardMaterial({ color: C.grass, roughness: 1 }));
  ground.receiveShadow = true;
  root.add(ground);
  // the pad: sandy in the middle, fading into the grass with no edge
  const pad = new THREE.Mesh(new THREE.CircleGeometry(PAD.fade, 96), new THREE.MeshStandardMaterial({
    roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    map: radial([[0, css(C.pad)], [PAD.solid / PAD.fade, css(C.pad)], [1, css(C.pad, 0)]]),
  }));
  pad.receiveShadow = true;
  pad.renderOrder = -2; // before the effects (dust, sparks don't write depth), after the opaque ground
  root.add(pad);

  // trees: round canopies on short trunks, all around (the camera circles with the fighters)
  const r = rng(7);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.22, 1, 12).rotateX(Math.PI / 2).translate(0, 0, 0.5), new THREE.MeshStandardMaterial({ color: C.trunk, roughness: 1 }), TREES.count);
  const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), TREES.count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < TREES.count; i++) {
    const a = (i / TREES.count) * Math.PI * 2 + r() * 0.45;
    const d = TREES.inner + r() * (TREES.outer - TREES.inner);
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    const size = 1.1 + r() * 0.8, h = 0.7 + r() * 0.7;
    trunks.setMatrixAt(i, m.compose(p.set(x, y, 0), q.identity(), sc.set(1, 1, h + size * 0.5)));
    col.setHex(C.leaves[Math.floor(r() * C.leaves.length)]);
    crowns.setMatrixAt(i, m.compose(p.set(x, y, h + size * 0.9), q.identity(), sc.set(size, size, size * 1.12)));
    crowns.setColorAt(i, col);
  }
  trunks.frustumCulled = crowns.frustumCulled = false; // bounds are per geometry, not per instance
  root.add(trunks, crowns);

  // the light of a meadow at dusk: a soft lavender sky fill, a green bounce, a warm low sun (softer than the rig)
  stage.hemi.color.setHex(0x9a96c8);
  stage.hemi.groundColor.setHex(0x55684f);
  stage.hemi.intensity = 0.75;
  stage.key.color.setHex(0xffd9b8);
  stage.key.intensity = 2.2;

  return { look: { dust: 0xd2bea0, stone: 0x6e6454, fist: 0xffe2a8, block: 0xb8e4ff }, update() {} };
}
