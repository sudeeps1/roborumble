// The fight screen's renderer. The scene is the MuJoCo frame (meters, Z up), drawn as is; the elf and
// the knight from ../characters are skinned over the simulated G1s (body poses in, no retargeting) and
// lit like their viewer: a warm key, cool fill and rims, the studio environment, AgX tone mapping and
// bloom. The arena module adds the set and its own mood lights.
import { CharacterView } from "@elf/character.ts";
import { makeStudioEnvironment } from "@elf/studio.ts";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { World } from "../core/world.ts";

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 220);
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** The key light: the only shadow caster. Arenas may recolour it. */
  readonly key = new THREE.DirectionalLight(0xffe2c6, 2.5);
  readonly rims: THREE.DirectionalLight[] = [];
  readonly hemi = new THREE.HemisphereLight(0x2a2c44, 0x4a3a2c, 0.55);
  chars: CharacterView[] = [];
  private world: World;
  private bodies: Map<string, { pos: ArrayLike<number>; quat: ArrayLike<number> }>[] = [];

  constructor(container: HTMLElement, world: World) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.id = "stage";
    container.prepend(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b0d12);
    // the characters' materials are made for their studio environment (authored Y up; this scene is Z up)
    this.scene.environment = makeStudioEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.5;
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -4.6, 1.4);
    this.camera.lookAt(0, 0, 0.9);

    // the characters' light: warm key from camera-right and above (follows the fight, see sync), a cool
    // low fill, two cool rims from behind, a faint warm bounce from the floor
    const key = this.key;
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 0.5, far: 16 });
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.018;
    this.scene.add(key, key.target);
    for (const [color, intensity] of [[0xb8c8ff, 0.7], [0x9fbcff, 1.7], [0xb8b0ff, 1.3]] as const) {
      const l = new THREE.DirectionalLight(color, intensity);
      this.scene.add(l, l.target);
      this.rims.push(l);
    }
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.hemi);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.32, 0.6, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
      this.bloom.resolution.set(innerWidth / 2, innerHeight / 2);
    });
  }

  /** One character per robot (GLBs rigged bone-for-bone to the G1). P2 gets the other team's hue. */
  async loadCharacters(urls: string[], hues: number[]) {
    this.chars = await Promise.all(urls.map((u, i) => CharacterView.load(u, { hue: hues[i] ?? 0 })));
    for (const c of this.chars) {
      for (const w of c.warnings) console.warn("character:", w);
      this.scene.add(c.root);
    }
    this.bodies = this.world.robots.map(() => new Map());
  }

  /**
   * Drives the characters from the MuJoCo body poses. dt drives hair, flaps, glow and hit flashes, so
   * pass the scaled time (0 in a hit-stop freezes them with the fight).
   */
  sync(dt: number, focus: ArrayLike<number>) {
    const d = this.world.data, xp = d.xpos, xq = d.xquat;
    this.world.robots.forEach((r, i) => {
      const m = this.bodies[i];
      if (!m || !this.chars[i]) return;
      for (const [name, b] of r.bodies) m.set(name, { pos: xp.subarray(3 * b, 3 * b + 3), quat: xq.subarray(4 * b, 4 * b + 4) });
      this.chars[i].update(m, dt);
    });
    // the light rig rides along with the fighters so they stay lit wherever they are in the ring
    const cam = this.camera.position, fx = focus[0], fy = focus[1];
    const ax = cam.x - fx, ay = cam.y - fy, al = Math.hypot(ax, ay) || 1;
    const ux = ax / al, uy = ay / al, rx = -uy, ry = ux; // toward the camera, and screen-right
    const place = (l: THREE.DirectionalLight, toCam: number, right: number, z: number) => {
      l.position.set(fx + ux * toCam + rx * right, fy + uy * toCam + ry * right, z);
      l.target.position.set(fx, fy, 0.9);
    };
    place(this.key, 3.2, 2.2, 5.5);
    place(this.rims[0], 2.6, -3.0, 1.5);
    place(this.rims[1], -3.2, -2.6, 2.6);
    place(this.rims[2], -2.6, 2.8, 2.2);
  }

  render(dt: number) { this.composer.render(dt); }
}
