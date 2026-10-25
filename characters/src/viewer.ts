// Viewer: two elves ~1.2 m apart driven by procedural G1 motions (anims.ts -> fk.ts -> CharacterView).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";
import { CharacterView } from "./character.ts";
import { setElfQuality } from "./materials.ts";
import { makeStudioEnvironment } from "./studio.ts";
import { G1FK, BODIES, type BodyPose } from "./fk.ts";
import { Animator, MOTIONS, MOTION_NAMES, BIND_ANGLES, placePose } from "./anims.ts";

const GAP = 1.2; // pelvis-to-pelvis distance (m)

// ---------------------------------------------------------------- renderer, scene, camera
type Quality = "high" | "low";
let quality: Quality = new URLSearchParams(location.search).get("q") === "low" ? "low" : "high";
const pixelRatio = () => Math.min(window.devicePixelRatio, quality === "high" ? 1.5 : 1);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r186 PCF: 5 Vogel taps x hardware 2x2, soft via shadow.radius
renderer.info.autoReset = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// studio HDR environment (softboxes matching the key / rim lights) for reflections, catchlights and ambient
const envTex = makeStudioEnvironment(renderer);
scene.environment = envTex;
scene.environmentIntensity = 0.5;
scene.background = (() => {
  const c = document.createElement("canvas");
  c.width = 2; c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#030406");
  grd.addColorStop(0.55, "#0b0f17");
  grd.addColorStop(1, "#121824");
  g.fillStyle = grd;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
scene.fog = new THREE.Fog(0x0e121b, 5, 13);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.05, 60);
camera.position.set(GAP / 2 + 0.2, 1.25, 3.9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(GAP / 2, 0.82, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 0.6;
controls.maxDistance = 9;
controls.update();

// MuJoCo frame (Z up) inside the Y-up three.js scene
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

// ---------------------------------------------------------------- lights
// Warm key (~4800 K softbox, soft PCF shadow) from camera-right, cool low fill from camera-left, two cool
// rims from behind. Ratios roughly key 1 : fill 0.18 : rims 0.6-0.75, plus the studio environment.
const key = new THREE.DirectionalLight(0xffdcbc, 3.1);
key.position.set(GAP / 2 + 2.4, 4.0, 3.0);
key.target.position.set(GAP / 2, 0.8, 0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1.9, right: 1.9, top: 2.0, bottom: -1.4, near: 1, far: 11 });
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.018;
key.shadow.radius = 3.5;
scene.add(key, key.target);

const fill = new THREE.DirectionalLight(0xa9c0ff, 0.55);
fill.position.set(GAP / 2 - 3.0, 1.5, 2.6);
fill.target.position.set(GAP / 2, 0.9, 0);
scene.add(fill, fill.target);

const rimA = new THREE.DirectionalLight(0x86b4ff, 2.3);
rimA.position.set(-2.6, 2.6, -3.2);
rimA.target.position.set(GAP / 2, 0.9, 0);
const rimB = new THREE.DirectionalLight(0xa6a0ff, 1.8);
rimB.position.set(GAP + 2.8, 2.2, -2.6);
rimB.target.position.set(GAP / 2, 0.9, 0);
scene.add(rimA, rimA.target, rimB, rimB.target);
// faint warm bounce from the floor so undersides are not pure environment
const bounce = new THREE.HemisphereLight(0x000000, 0x3a2a1e, 0.35);
scene.add(bounce);

// ---------------------------------------------------------------- ground + arena ring
const groundTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(256, 256, 10, 256, 256, 256);
  grd.addColorStop(0, "#262a33");
  grd.addColorStop(0.35, "#171a21");
  grd.addColorStop(0.75, "#0c0f15");
  grd.addColorStop(1, "#07090d");
  g.fillStyle = grd;
  g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(7, 96).rotateX(-Math.PI / 2),
  // explicit envMap so envMapIntensity applies (scene.environment uses scene.environmentIntensity): no grazing glare
  new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.9, metalness: 0.0, envMap: envTex, envMapIntensity: 0.05 }),
);
ground.position.set(GAP / 2, 0, 0);
ground.receiveShadow = true;
scene.add(ground);
const ring = new THREE.Mesh(
  new THREE.RingGeometry(1.9, 1.93, 128).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.75, 1.0).multiplyScalar(0.9), transparent: true, opacity: 0.7, depthWrite: false }),
);
ring.position.set(GAP / 2, 0.002, 0);
scene.add(ring);

// ---------------------------------------------------------------- contact shadows (three.js webgl_shadow_contact technique)
const contact = (() => {
  const W = 4.2, D = 3.2, HEIGHT = 0.45, RES = 1024;
  const group = new THREE.Group();
  group.position.set(GAP / 2, 0.003, 0);
  scene.add(group);
  const rt = new THREE.WebGLRenderTarget(RES, RES * (D / W));
  const rtBlur = new THREE.WebGLRenderTarget(RES, RES * (D / W));
  rt.texture.generateMipmaps = rtBlur.texture.generateMipmaps = false;
  const geo = new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2);
  const plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: rt.texture, opacity: 0.85, transparent: true, depthWrite: false }));
  plane.renderOrder = 1;
  plane.scale.y = -1;
  group.add(plane);
  const blurPlane = new THREE.Mesh(geo);
  blurPlane.visible = false;
  group.add(blurPlane);
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, D / 2, -D / 2, 0, HEIGHT);
  cam.rotation.x = Math.PI / 2;
  group.add(cam);
  const depthMat = new THREE.MeshDepthMaterial();
  const darkness = { value: 1.6 };
  depthMat.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = darkness;
    shader.fragmentShader = "uniform float darkness;\n" + shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 1.6 ) * darkness );",
    );
  };
  depthMat.depthTest = false;
  depthMat.depthWrite = false;
  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  hBlur.depthTest = vBlur.depthTest = false;
  const blur = (amount: number) => {
    blurPlane.visible = true;
    blurPlane.material = hBlur;
    hBlur.uniforms.tDiffuse.value = rt.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(rtBlur);
    renderer.render(blurPlane, cam);
    blurPlane.material = vBlur;
    vBlur.uniforms.tDiffuse.value = rtBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(rt);
    renderer.render(blurPlane, cam);
    blurPlane.visible = false;
  };
  return {
    render(hide: THREE.Object3D[]) {
      const bg = scene.background, fog = scene.fog;
      scene.background = null; scene.fog = null;
      const vis = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      plane.visible = false;
      scene.overrideMaterial = depthMat;
      const clearAlpha = renderer.getClearAlpha();
      renderer.setClearAlpha(0);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      scene.overrideMaterial = null;
      blur(1.2);
      blur(0.45);
      renderer.setRenderTarget(null);
      renderer.setClearAlpha(clearAlpha);
      hide.forEach((o, i) => (o.visible = vis[i]));
      plane.visible = true;
      scene.background = bg; scene.fog = fog;
    },
  };
})();

// ---------------------------------------------------------------- post
// MSAA half-float target (alphaToCoverage hair cards need it). Passes:
//   RenderPass -> GTAO (half res, character/ground contact AO) -> bloom (emissive only) -> output (AgX + grade)
// Selective bloom: elf materials write alpha = 1 + emissive mask (materials.ts); the high-pass reads it.
const size = new THREE.Vector2();
renderer.getDrawingBufferSize(size);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(Math.max(size.x, 2), Math.max(size.y, 2), { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));

const AO_SCALE = 0.5;
const gtao = new GTAOPass(scene, camera, Math.max(2, size.x * AO_SCALE), Math.max(2, size.y * AO_SCALE));
gtao.updateGtaoMaterial({ radius: 0.28, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, radiusExponent: 1, rings: 2, samples: 12 });
gtao.blendIntensity = 0.9;
// keep the bloom mask in alpha: the AO blend multiplies colour only
gtao.blendMaterial.blendSrcAlpha = THREE.ZeroFactor;
gtao.blendMaterial.blendDstAlpha = THREE.OneFactor;
{
  const base = gtao.setSize.bind(gtao);
  gtao.setSize = (w: number, h: number) => base(Math.max(2, Math.round(w * AO_SCALE)), Math.max(2, Math.round(h * AO_SCALE)));
  // hair cards are alpha-cut quads; keep them out of the AO normal/depth pass
  const g = gtao as unknown as { _overrideVisibility(): void; _visibilityCache: THREE.Object3D[] };
  const ov = g._overrideVisibility.bind(gtao);
  g._overrideVisibility = () => {
    ov();
    scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; g._visibilityCache.push(o); } });
  };
}
composer.addPass(gtao);

const bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(size.x, 2), Math.max(size.y, 2)), 0.45, 0.3, 0.04);
bloom.materialHighPassFilter.fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D( tDiffuse, vUv );
    vec3 c = texel.rgb * clamp( texel.a - 1.0, 0.0, 1.0 ); // emissive mask from the elf materials
    float v = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    gl_FragColor = vec4( c * smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v ), 1.0 );
  }`;
(bloom.highPassUniforms as Record<string, THREE.IUniform>).smoothWidth.value = 0.25;
bloom.materialHighPassFilter.needsUpdate = true;
composer.addPass(bloom);

// output: vignette before AgX, gentle split-tone + saturation after, dither after sRGB
const output = new OutputPass();
output.uniforms.uVignette = { value: 0.28 };
output.uniforms.uSat = { value: 1.04 };
output.material.fragmentShader = output.material.fragmentShader
  .replace("uniform sampler2D tDiffuse;", "uniform sampler2D tDiffuse;\n\t\tuniform float uVignette;\n\t\tuniform float uSat;")
  .replace("gl_FragColor = texture2D( tDiffuse, vUv );", `gl_FragColor = texture2D( tDiffuse, vUv );
			gl_FragColor.a = 1.0;
			vec2 vq = ( vUv - 0.5 ) * vec2( 1.25, 1.0 );
			gl_FragColor.rgb *= clamp( 1.0 - uVignette * dot( vq, vq ) * 2.0, 0.0, 1.0 );`)
  .replace("#ifdef SRGB_TRANSFER", `{
				float lum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
				gl_FragColor.rgb = max( mix( vec3( lum ), gl_FragColor.rgb, uSat ), 0.0 );
				gl_FragColor.rgb *= mix( vec3( 0.975, 0.99, 1.035 ), vec3( 1.025, 1.0, 0.975 ), smoothstep( 0.04, 0.5, lum ) );
			}
			#ifdef SRGB_TRANSFER`)
  .replace(/}\s*$/, `	gl_FragColor.rgb += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
		}`);
composer.addPass(output);

let aoWanted = true;
function applyQuality(q: Quality) {
  quality = q;
  setElfQuality(q, true);
  gtao.enabled = q === "high" && aoWanted;
  const ms = q === "high" ? 2048 : 1024;
  if (key.shadow.mapSize.x !== ms) {
    key.shadow.mapSize.set(ms, ms);
    key.shadow.map?.dispose();
    key.shadow.map = null;
  }
  key.shadow.radius = q === "high" ? 3.5 : 2;
  renderer.setPixelRatio(pixelRatio());
  lastW = lastH = 0; // force fitToWindow to resize the composer at the new pixel ratio
  document.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((b) => b.classList.toggle("on", b.dataset.quality === q));
}

// ---------------------------------------------------------------- skeleton overlay (G1 body origins)
function makeSkeletonOverlay() {
  const segs = BODIES.filter((b) => b.parent >= 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs.length * 6), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }));
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BODIES.length * 3), 3));
  const pts = new THREE.Points(pgeo, new THREE.PointsMaterial({ color: 0xff5a36, size: 5, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
  const g = new THREE.Group();
  g.add(lines, pts);
  g.renderOrder = 999;
  lines.renderOrder = pts.renderOrder = 999;
  lines.frustumCulled = pts.frustumCulled = false;
  return {
    group: g,
    update(bodies: BodyPose[]) {
      const lp = geo.attributes.position as THREE.BufferAttribute;
      let k = 0;
      for (let i = 0; i < BODIES.length; i++) {
        const p = BODIES[i].parent;
        if (p < 0) continue;
        const a = bodies[p].pos, b = bodies[i].pos;
        lp.setXYZ(k++, a[0], a[1], a[2]);
        lp.setXYZ(k++, b[0], b[1], b[2]);
      }
      lp.needsUpdate = true;
      const pp = pgeo.attributes.position as THREE.BufferAttribute;
      bodies.forEach((b, i) => pp.setXYZ(i, b.pos[0], b.pos[1], b.pos[2]));
      pp.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- fighters
interface Fighter {
  name: string;
  elf: CharacterView;
  anim: Animator;
  fk: G1FK;
  x: number;
  yaw: number;
  skel: ReturnType<typeof makeSkeletonOverlay>;
  bodies: BodyPose[];
}

const boot = document.getElementById("boot")!;
let fighters: Fighter[] = [];

async function main() {
  const [e1, e2] = await Promise.all([
    CharacterView.load("/elf.glb"),
    CharacterView.load("/elf.glb", { hue: -2.45 }),
  ]);
  Object.assign(BIND_ANGLES, e1.meta.bind_angles);
  for (const w of e1.warnings) console.warn("[elf.glb]", w);
  const mk = (name: string, elf: CharacterView, x: number, yaw: number): Fighter => {
    world.add(elf.root);
    const skel = makeSkeletonOverlay();
    skel.group.visible = false;
    world.add(skel.group);
    return { name, elf, anim: new Animator(), fk: new G1FK(), x, yaw, skel, bodies: [] };
  };
  fighters = [mk("P1", e1, 0, 0), mk("P2", e2, GAP, Math.PI)];
  applyQuality(quality);
  setupUI();
  boot.remove();
  document.getElementById("panel")!.hidden = false;
  document.getElementById("stats")!.hidden = false;
  renderer.setAnimationLoop(() => frame());
}

// ---------------------------------------------------------------- UI
let speed = 1;
let exchange = false;
let exchangeT = 0;
let exchangeAttacker = 0;
let exchangePhase: "charge" | "fight" | "rest" = "rest";
let glowLevel = 0;

function play(f: Fighter, motion: string) {
  f.anim.play(motion);
  if (motion === "hit") f.elf.hitFlash();
}

function setupUI() {
  const rows = [document.getElementById("m1")!, document.getElementById("m2")!, document.getElementById("mb")!];
  rows.forEach((row, ri) => {
    for (const name of MOTION_NAMES) {
      const b = document.createElement("button");
      b.textContent = MOTIONS[name].label.replace(/ \(.*\)/, "");
      b.title = MOTIONS[name].label;
      b.onclick = () => {
        exchange = false;
        exBtn.classList.remove("on");
        const targets = ri === 2 ? fighters : [fighters[ri]];
        targets.forEach((f) => play(f, name));
      };
      row.appendChild(b);
    }
  });
  const exBtn = document.getElementById("exchange")!;
  exBtn.onclick = () => {
    exchange = !exchange;
    exBtn.classList.toggle("on", exchange);
    exchangeT = 0;
    exchangePhase = "rest";
    if (!exchange) setGlow(+(document.getElementById("glow") as HTMLInputElement).value);
  };
  document.getElementById("flash")!.onclick = () => fighters.forEach((f) => f.elf.hitFlash());
  const glow = document.getElementById("glow") as HTMLInputElement;
  glow.oninput = () => setGlow(+glow.value);
  const sp = document.getElementById("speed") as HTMLInputElement;
  sp.oninput = () => (speed = +sp.value);
  const skel = document.getElementById("skel") as HTMLInputElement;
  skel.onchange = () => fighters.forEach((f) => (f.skel.group.visible = skel.checked));
  const skin = document.getElementById("skin") as HTMLInputElement;
  skin.onchange = () => fighters.forEach((f) => (f.elf.root.visible = skin.checked));
  const bl = document.getElementById("bloom") as HTMLInputElement;
  bl.onchange = () => (bloom.enabled = bl.checked);
  addQualityUI(bl.parentElement!);
  // impacts: whoever gets hit recoils (only in exchange mode, so manual testing stays manual)
  fighters.forEach((f, i) => {
    f.anim.onImpact = (m) => {
      if (!exchange || m.name === "hit") return;
      play(fighters[1 - i], "hit");
    };
  });
}

// quality buttons + AO toggle, inserted after the bloom checkbox (keys: Q toggles quality)
function addQualityUI(after: HTMLElement) {
  const row = document.createElement("div");
  row.className = "row";
  row.style.margin = "6px 0 2px";
  const lab = document.createElement("span");
  lab.textContent = "Quality";
  lab.style.cssText = "color: var(--dim); align-self: center; margin-right: 4px";
  row.appendChild(lab);
  for (const q of ["high", "low"] as Quality[]) {
    const b = document.createElement("button");
    b.textContent = q === "high" ? "High" : "Low";
    b.dataset.quality = q;
    b.title = q === "high" ? "Micro detail, GTAO, A2C hair, 2048 shadows, 1.5x pixels" : "Macro detail only, no AO, alphaTest hair, 1024 shadows, 1x pixels";
    b.onclick = () => applyQuality(q);
    b.classList.toggle("on", q === quality);
    row.appendChild(b);
  }
  const ao = document.createElement("label");
  ao.innerHTML = `<input type="checkbox" checked /> Ambient occlusion`;
  const aoBox = ao.querySelector("input")!;
  aoBox.onchange = () => { aoWanted = aoBox.checked; gtao.enabled = aoWanted && quality === "high"; };
  after.after(row, ao);
  window.addEventListener("keydown", (e) => {
    if (e.key === "q" && !(e.target instanceof HTMLInputElement)) applyQuality(quality === "high" ? "low" : "high");
  });
}

function setGlow(v: number) {
  glowLevel = v;
  fighters.forEach((f) => f.elf.setGlow(v));
}

function stepExchange(dt: number) {
  if (!exchange) return;
  exchangeT += dt;
  if (exchangePhase === "rest" && exchangeT > 0.9) {
    exchangePhase = "charge"; exchangeT = 0;
    fighters.forEach((f) => f.elf.setGlow(1));
  } else if (exchangePhase === "charge" && exchangeT > 1.1) {
    exchangePhase = "fight"; exchangeT = 0;
    fighters.forEach((f) => f.elf.setGlow(glowLevel));
    const attacks = ["jab", "cross", "front_kick"];
    play(fighters[exchangeAttacker], attacks[Math.floor(Math.random() * attacks.length)]);
  } else if (exchangePhase === "fight" && exchangeT > 1.4) {
    exchangePhase = "rest"; exchangeT = 0;
    exchangeAttacker = 1 - exchangeAttacker;
  }
}

// ---------------------------------------------------------------- loop
const timer = new THREE.Timer();
timer.connect(document); // no giant dt after the tab was hidden
const stats = document.getElementById("stats")!;
let fpsFrames = 0, fpsTime = 0, fps = 0, cpuMs = 0;

let paused = false;
function frame(fixedDt?: number) {
  timer.update();
  const realDt = timer.getDelta();
  if (paused && fixedDt === undefined) { composer.render(); return; }
  const rawDt = fixedDt ?? Math.min(realDt, 0.1);
  renderer.info.reset();
  fitToWindow();
  const t0 = performance.now();
  const dt = rawDt * speed;
  stepExchange(dt);
  for (const f of fighters) {
    const pose = f.anim.update(dt);
    const placed = placePose(pose, f.x, 0, f.yaw);
    f.bodies = f.fk.compute(pose.q, placed.rootPos, placed.rootQuat);
    f.elf.update(f.bodies, dt);
    if (f.skel.group.visible) f.skel.update(f.bodies);
  }
  controls.update();
  cpuMs = cpuMs * 0.9 + (performance.now() - t0) * 0.1;
  contact.render([ground, ring, ...fighters.map((f) => f.skel.group)]);
  composer.render();

  fpsFrames++;
  fpsTime += rawDt;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0; fpsTime = 0;
    const info = renderer.info.render;
    stats.textContent =
      `${fps.toFixed(0)} fps\n` +
      `cpu  ${cpuMs.toFixed(2)} ms (anim+fk+skin)\n` +
      `draw ${info.calls} calls, ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      fighters.map((f) => `${f.name}  ${f.anim.motion.name.padEnd(10)} ik ${(f.anim.ikError * 1000).toFixed(1)}mm`).join("\n");
  }
}

// the pane can start at 0x0; resize whenever the window size changes (zero-size targets break the composer)
let lastW = 0, lastH = 0;
function fitToWindow() {
  const w = Math.max(window.innerWidth, 2), h = Math.max(window.innerHeight, 2);
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
}
window.addEventListener("resize", fitToWindow);

// debug handle for the console / automated checks
Object.assign(window, {
  viewer: {
    get fighters() { return fighters; }, scene, camera, controls, renderer, composer, bloom, gtao, output, frame,
    lights: { key, fill, rimA, rimB, bounce },
    get quality() { return quality; },
    setQuality: (q: Quality) => applyQuality(q),
    play: (i: number, m: string) => play(fighters[i], m),
    /** Freeze the loop; step(dt) then advances deterministically (for screenshots). */
    pause(on = true) { paused = on; },
    step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) frame(dt); },
    /** Render and POST the canvas to the dev server (only when started with SHOT_DIR). */
    async shot(name: string) {
      composer.render();
      const url = renderer.domElement.toDataURL("image/png");
      return (await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: "POST", body: url })).text();
    },
    /** Render n frames synchronously (gl.finish each) and return ms/frame, works even when the tab is throttled. */
    bench(n = 30) {
      const gl = renderer.getContext();
      frame(); gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { frame(); gl.finish(); }
      return (performance.now() - t0) / n;
    },
  },
});

main().catch((e) => {
  boot.textContent = `Failed to load: ${e?.message ?? e}`;
  console.error(e);
});
