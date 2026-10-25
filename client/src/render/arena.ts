// The arena: a glowing ring of mushrooms in a moonlit forest clearing, with fireflies, drifting fairy dust and soft fog.
// Owns all scene lighting, the sky/background, fog and the environment map. Pieces live in ./arena/.
import * as THREE from "three";
import type { Stage } from "./stage";
import { buildForest } from "./arena/forest";
import { buildGround } from "./arena/ground";
import { buildLights } from "./arena/lights";
import { buildFairyDust, buildFireflies, buildMist, type ParticleUniforms } from "./arena/particles";
import { buildRing } from "./arena/ring";
import { buildSky } from "./arena/sky";

export { RING_RADIUS } from "./arena/palette";
/** Optional: ripple of light around the fairy ring from a hit/KO point, e.g. ringFlare(at, 1) on a big hit. */
export { ringFlare } from "./arena/ring";

export interface Arena {
  update(t: number, dt: number): void;
}

/** Builds the arena into stage.scene (three.js frame, Y up). Owns all scene lighting and fog. */
export function buildArena(stage: Stage): Arena {
  const root = new THREE.Group();
  root.name = "arena";
  stage.scene.add(root);

  // shared uniforms: one write per frame drives every animated material
  const u: ParticleUniforms = { time: { value: 0 }, pixelRatio: { value: stage.renderer.getPixelRatio() }, pxScale: { value: 600 } };

  buildLights(stage, root);
  buildSky(root, u.time, u.pixelRatio);
  buildGround(root, u.time, Math.min(8, stage.renderer.capabilities.getMaxAnisotropy()));
  buildForest(root, u.time);
  buildRing(root, u.time);
  buildMist(root, u.time);
  buildFireflies(root, u);
  buildFairyDust(root, u);

  const buf = new THREE.Vector2();
  return {
    update(t: number) {
      u.time.value = t;
      u.pixelRatio.value = stage.renderer.getPixelRatio();
      stage.renderer.getDrawingBufferSize(buf);
      u.pxScale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov) / 2));
    },
  };
}
