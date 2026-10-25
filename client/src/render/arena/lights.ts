// Scene lighting: cool moonlight key (soft shadows, tight around the ring), warm back rim, hemisphere fill, fog,
// and a small procedural environment map (moonlit sky + glow of the ring) so the robots' metal has something to reflect.
import * as THREE from "three";
import type { Stage } from "../stage";
import { FOG, LIGHT, MOON_DIR, SHROOM_COLORS, SKY } from "./palette";
import { hdr } from "./util";

export interface ArenaLights {
  key: THREE.DirectionalLight; rim: THREE.DirectionalLight; hemi: THREE.HemisphereLight;
  /** Bakes the environment map again (its render target is empty after a WebGL context loss). */
  rebuildEnv(): void;
}

export function buildLights(stage: Stage, root: THREE.Object3D): ArenaLights {
  const scene = stage.scene;
  scene.fog = new THREE.FogExp2(FOG.color, FOG.density);
  scene.background = new THREE.Color(FOG.color);

  const hemi = new THREE.HemisphereLight(LIGHT.hemiSky, LIGHT.hemiGround, LIGHT.hemi);

  const key = new THREE.DirectionalLight(LIGHT.key, LIGHT.keyIntensity);
  key.target.position.set(0, 0, -0.4);
  key.position.copy(LIGHT.keyFrom).add(key.target.position);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -3.9; sc.right = 3.9; sc.top = 3.9; sc.bottom = -3.9;
  sc.near = 2; sc.far = 22;
  sc.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  key.shadow.intensity = 0.9;

  const rim = new THREE.DirectionalLight(LIGHT.rim, LIGHT.rimIntensity);
  rim.target.position.set(0, 0.8, 0);
  rim.position.copy(LIGHT.rimFrom);

  root.add(hemi, key, key.target, rim, rim.target);

  scene.environment = envMap(stage.renderer);
  scene.environmentIntensity = LIGHT.env;
  const rebuildEnv = () => {
    scene.environment?.dispose();
    scene.environment = envMap(stage.renderer);
  };
  return { key, rim, hemi, rebuildEnv };
}

/** Bakes a tiny moonlit world into a PMREM once: sky gradient, moon, the key's soft glow, the ring's colored band. */
function envMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const keyDir = LIGHT.keyFrom.clone().normalize();
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 64, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: hdr(SKY.mid, 1.6) },
      uHorizon: { value: hdr(SKY.horizon, 1.5) },
      uGround: { value: hdr(0x16261a, 1.0) },
      uMoonDir: { value: MOON_DIR },
      uMoon: { value: hdr(0xfff1d8, 1) },
      uKeyDir: { value: keyDir },
      uKey: { value: hdr(LIGHT.key, 0.55) },
      uCardDir: { value: new THREE.Vector3(0.3, 0.32, 1).normalize() },
      uCard: { value: hdr(0xb4c2ff, 2.2) },
      uTeal: { value: hdr(SHROOM_COLORS[0], 0.5) },
      uViolet: { value: hdr(SHROOM_COLORS[1], 0.5) },
      uGold: { value: hdr(SHROOM_COLORS[2], 0.45) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uGround, uMoonDir, uMoon, uKeyDir, uKey, uCardDir, uCard, uTeal, uViolet, uGold;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h >= 0.0 ? mix(uHorizon, uZenith, smoothstep(0.0, 0.7, h)) : mix(uHorizon * 0.45, uGround, smoothstep(0.0, -0.3, h));
        float m = dot(d, uMoonDir);
        col += uMoon * (smoothstep(0.9975, 0.9985, m) * 10.0 + pow(max(m, 0.0), 24.0) * 0.6);
        col += uKey * pow(max(dot(d, uKeyDir), 0.0), 5.0);
        // a big soft moonlit card behind the camera (never seen directly): what the robots' metal reflects toward us
        float card = max(dot(d, uCardDir), 0.0);
        col += uCard * smoothstep(0.72, 0.95, card) * (0.6 + 0.4 * smoothstep(-0.1, 0.25, h));
        float az = atan(d.x, -d.z);
        vec3 ring = mix(uTeal, uViolet, 0.5 + 0.5 * sin(az * 3.0));
        ring = mix(ring, uGold, 0.5 + 0.5 * sin(az * 2.0 + 1.7));
        col += ring * exp(-pow((h + 0.06) / 0.08, 2.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  envScene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.02, 0.1, 50);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return rt.texture;
}
