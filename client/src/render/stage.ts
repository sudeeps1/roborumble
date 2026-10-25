// Renderer, camera, bloom, screen shake. Two coordinate frames:
//  - three.js world: Y up (scene root, arena, effects, camera)
//  - MuJoCo world: Z up (stage.world group; robots live here so sim poses apply directly)
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import type { Vec3 } from "../contract";

/** MuJoCo (x, y, z), Z up -> three.js (x, z, -y), Y up. */
export function mjToThree(p: Vec3 | ArrayLike<number>, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p[0], p[2], -p[1]);
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  /** MuJoCo frame: children use MuJoCo coordinates (Z up). */
  readonly world = new THREE.Group();
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;

  private shakeAmt = 0;
  private focus = new THREE.Vector3(0, 0.85, 0);
  private dist = 3.7;
  private readonly basePos = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // r186 dropped PCFSoft; the moonlight's shadow.radius softens edges

    this.world.rotation.x = -Math.PI / 2; // MuJoCo Z up -> three Y up
    this.scene.add(this.world);

    // Anti-aliasing comes from SMAA at the end. Don't use a multisampled composer target: with it, whole frames
    // rendered black for seconds at a time during fights (measured: dozens of blank frames per match, none without).
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Add screen shake; decays on its own. ~0.02 small hit, ~0.08 big hit. */
  shake(amount: number) {
    this.shakeAmt = Math.min(0.15, this.shakeAmt + amount);
  }

  /**
   * Side view that follows the fighters. `a`/`b` are fighter centers in three.js coordinates;
   * `zoomIn` 0..1 pushes the camera closer (KO moments).
   */
  render(dt: number, a: THREE.Vector3, b: THREE.Vector3, zoomIn = 0) {
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const gap = Math.abs(a.x - b.x);
    const want = THREE.MathUtils.clamp(2.9 + gap * 0.75, 3.3, 6.5) * (1 - 0.3 * zoomIn);
    const k = 1 - Math.exp(-dt * 3);
    this.focus.x += (mid.x - this.focus.x) * k;
    this.focus.y += (0.8 + mid.y * 0.15 - this.focus.y) * k;
    this.focus.z += (mid.z * 0.5 - this.focus.z) * k;
    this.dist += (want - this.dist) * k;

    this.basePos.set(this.focus.x, this.focus.y + 0.32, this.focus.z + this.dist);
    this.camera.position.copy(this.basePos);
    if (this.shakeAmt > 0.0005) {
      const s = this.shakeAmt;
      this.camera.position.x += (Math.random() - 0.5) * 2 * s;
      this.camera.position.y += (Math.random() - 0.5) * 2 * s;
      this.shakeAmt *= Math.exp(-dt * 9);
    }
    this.camera.lookAt(this.focus);
    this.composer.render(dt);
  }

  /** three.js world position -> CSS pixels. `visible` is false behind the camera. */
  toScreen(v: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight, visible: p.z < 1 };
  }
}
