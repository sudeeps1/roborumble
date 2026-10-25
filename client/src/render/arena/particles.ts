// Atmosphere: blinking fireflies wandering the clearing edge, fairy dust rising around the ring, slow ground mist.
// One draw call each; all motion happens in the vertex shaders from uTime (no per-frame CPU work).
import * as THREE from "three";
import { FOG, RING_RADIUS } from "./palette";
import { between, canvasTexture, fbm, hsl, rng, valueNoise } from "./util";

export interface ParticleUniforms {
  time: { value: number };
  pixelRatio: { value: number };
  /** Drawing-buffer height / (2 tan(fov/2)): world size -> pixels at distance 1. */
  pxScale: { value: number };
}

const POINT_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float core = exp(-d * 9.0);
  float halo = exp(-d * 3.0) * 0.4;
  gl_FragColor = vec4(vCol * (core + halo), vAlpha);
}`;

const FOG_FADE = /* glsl */ `float fogFade(float dist) { float f = ${FOG.density.toFixed(4)} * dist; return exp(-f * f); }`;

function pointsMaterial(u: ParticleUniforms, vertexShader: string) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: u.time, uPixelRatio: u.pixelRatio, uPxScale: u.pxScale },
    vertexShader,
    fragmentShader: POINT_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

export function buildFireflies(root: THREE.Object3D, u: ParticleUniforms) {
  const r = rng(61);
  const N = 80;
  const pos = new Float32Array(N * 3), data = new Float32Array(N * 4), col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N;) {
    const ring = i < 26;
    const a = r() * Math.PI * 2;
    const rad = ring ? between(r, 2.0, 4.2) : between(r, 4.2, 11);
    const x = Math.sin(a) * rad, z = -Math.cos(a) * rad;
    if (z > 1.2) continue;                                   // never between the camera and the fighters
    if (Math.abs(x) < 1.7 && z > -1.3) continue;             // keep the fighters' space clean
    pos.set([x, ring ? between(r, 0.25, 1.3) : between(r, 0.4, 2.8), z], i * 3);
    data.set([r(), between(r, 0.15, 0.35), between(r, 0.6, 1.4), between(r, 0.06, 0.1)], i * 4);
    hsl(c, between(r, 0.14, 0.2), 0.95, 0.6).multiplyScalar(between(r, 1.6, 2.4));
    c.toArray(col, i * 3);
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, pointsMaterial(u, /* glsl */ `
    attribute vec4 aData; // phase, wander speed, blink rate, size (m)
    attribute vec3 color;
    uniform float uTime, uPixelRatio, uPxScale;
    varying vec3 vCol;
    varying float vAlpha;
    ${FOG_FADE}
    void main() {
      float ph = aData.x * 6.2831;
      float t = uTime * aData.y + ph;
      vec3 p = position + vec3(
        sin(t * 0.71 + ph * 3.0) * 0.7 + sin(t * 1.63) * 0.22,
        sin(t * 0.53 + ph) * 0.3 + sin(t * 1.9 + ph * 2.0) * 0.08,
        cos(t * 0.61 + ph * 5.0) * 0.7 + cos(t * 1.27) * 0.22);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float dist = -mv.z;
      // slow pulses with long dark gaps, plus a faint ember glow between flashes
      float blink = pow(max(0.0, sin(uTime * aData.z + ph * 7.0)), 5.0);
      vAlpha = (0.1 + 0.9 * blink) * fogFade(dist) * smoothstep(0.6, 1.4, dist);
      vCol = color;
      gl_PointSize = clamp(aData.w * uPxScale / max(dist, 0.1), 1.5 * uPixelRatio, 18.0 * uPixelRatio);
    }`));
  pts.frustumCulled = false;
  pts.name = "arena-fireflies";
  root.add(pts);
}

export function buildFairyDust(root: THREE.Object3D, u: ParticleUniforms) {
  const r = rng(62);
  const N = 300;
  const pos = new Float32Array(N * 3), data = new Float32Array(N * 4), col = new Float32Array(N * 3);
  const palette = [0xffe6a0, 0xffb8e8, 0x9ff6ff, 0xc9a8ff, 0xffffff];
  const c = new THREE.Color();
  for (let i = 0; i < N;) {
    // around the back and the sides of the ring; the front arc is too close to the camera
    const a = between(r, -2.05, 2.05);
    const rad = RING_RADIUS + between(r, -0.45, 0.65);
    pos.set([a, rad, 0], i * 3); // angle, radius (packed; the shader orbits them)
    data.set([r(), between(r, 0.035, 0.08), between(r, 0.016, 0.032), between(r, 1.2, 2.2)], i * 4);
    c.set(palette[Math.floor(r() * palette.length)]).multiplyScalar(between(r, 1.5, 2.6));
    c.toArray(col, i * 3);
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, pointsMaterial(u, /* glsl */ `
    attribute vec4 aData; // phase, rise speed, size (m), rise height (m)
    attribute vec3 color;
    uniform float uTime, uPixelRatio, uPxScale;
    varying vec3 vCol;
    varying float vAlpha;
    ${FOG_FADE}
    void main() {
      float ph = aData.x * 6.2831;
      float life = fract(aData.x + uTime * aData.y);
      // sway around the home angle (never orbit into the front arc, between the camera and the fighters)
      float ang = position.x + sin(uTime * 0.07 + ph) * 0.22 + sin(uTime * 0.4 + ph * 2.0) * 0.05;
      float rad = position.y + sin(uTime * 0.8 + ph * 3.0) * 0.1;
      vec3 p = vec3(sin(ang) * rad, 0.03 + life * aData.w, -cos(ang) * rad);
      p.x += sin(uTime * 1.3 + ph * 5.0) * 0.06;
      p.z += cos(uTime * 1.1 + ph * 4.0) * 0.06;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float dist = -mv.z;
      float fade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.55, 1.0, life));
      float sparkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (5.0 + aData.x * 6.0) + ph * 9.0), 4.0);
      vAlpha = fade * sparkle * fogFade(dist);
      vCol = color;
      gl_PointSize = clamp(aData.z * uPxScale / max(dist, 0.1), 1.0 * uPixelRatio, 7.0 * uPixelRatio);
    }`));
  pts.frustumCulled = false;
  pts.name = "arena-fairy-dust";
  root.add(pts);
}

/** Low drifting mist: a few big camera-facing (+Z) sheets behind the fighters, one instanced draw. */
export function buildMist(root: THREE.Object3D, time: { value: number }) {
  const noise = valueNoise(71);
  const tex = canvasTexture(256, 128, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = fbm(noise, x / w * 6, y / h * 3, 5, 6);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, false);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

  const r = rng(72);
  // [z, x, width, height, opacity]
  const sheets: [number, number, number, number, number][] = [];
  for (let z = -1.6; z > -20; z -= between(r, 1.0, 2.2)) {
    const far = Math.min(1, -z / 18);
    sheets.push([z, between(r, -3, 3), between(r, 7, 12) + far * 10, between(r, 0.6, 1.1) + far * 1.4, (0.13 + far * 0.17) * between(r, 0.8, 1.2)]);
  }
  sheets.sort((a, b) => a[0] - b[0]); // far first
  const n = sheets.length;
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
    uniforms: { uTime: time, uNoise: { value: tex }, uColor: { value: new THREE.Color(0x626aae) } },
    vertexShader: /* glsl */ `
      attribute vec4 aMist; // speed, phase, opacity, width (m)
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vMist;
      varying float vScroll;
      void main() {
        vUv = uv;
        vMist = aMist.xzw;
        vScroll = uTime * aMist.x + aMist.y;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uNoise;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying vec3 vMist;
      varying float vScroll;
      void main() {
        float rep = vMist.z / 6.0;
        float n = texture2D(uNoise, vec2(vUv.x * rep + vScroll, vUv.y * 0.6 + 0.2)).r;
        float n2 = texture2D(uNoise, vec2(vUv.x * rep * 1.9 - vScroll * 0.6 + 0.37, vUv.y * 1.1 + 0.5)).r;
        float m = n * 0.6 + n2 * 0.4;
        float vert = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.25, 1.0, vUv.y));
        float edge = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.75, 1.0, vUv.x));
        float a = smoothstep(0.3, 0.8, m) * vert * edge * vMist.y;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
  }), n);
  const m = new THREE.Matrix4();
  sheets.forEach(([z, x, w, h, o], i) => {
    m.makeScale(w, h, 1).setPosition(x, -0.05, z);
    mesh.setMatrixAt(i, m);
    inst.setXYZW(i, between(r, 0.006, 0.016) * (r() < 0.5 ? -1 : 1), r() * 10, o, w);
  });
  geo.setAttribute("aMist", inst);
  mesh.frustumCulled = false;
  mesh.name = "arena-mist";
  root.add(mesh);
}
