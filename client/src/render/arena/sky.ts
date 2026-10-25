// Night sky: gradient dome, twinkling stars, a big moon with a halo, and layered far treelines.
// Dome, stars and moon are drawn camera-relative (position + cameraPosition), so they sit at infinity.
import * as THREE from "three";
import { FOG, MOON, MOON_DIR, SKY } from "./palette";
import { GLSL_NOISE, between, hdr, hsl, rng } from "./util";

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
}`;

export function buildSky(root: THREE.Object3D, time: { value: number }, pixelRatio: { value: number }) {
  // ---------- dome ----------
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(150, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: hdr(SKY.zenith) },
        uMid: { value: hdr(SKY.mid) },
        uHorizon: { value: hdr(SKY.horizon) },
        uBelow: { value: hdr(SKY.below) },
        uMoonDir: { value: MOON_DIR },
        uMoonGlow: { value: hdr(SKY.moonGlow) },
        uTime: time,
      },
      vertexShader: SKY_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uMid, uHorizon, uBelow, uMoonDir, uMoonGlow;
        uniform float uTime;
        varying vec3 vDir;
        ${GLSL_NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
          col = mix(col, uZenith, smoothstep(0.18, 0.75, h));
          col = mix(uBelow, col, smoothstep(-0.06, 0.0, h));
          float m = max(dot(d, uMoonDir), 0.0);
          col += uMoonGlow * (pow(m, 120.0) * 0.3 + pow(m, 18.0) * 0.08 + pow(m, 4.0) * 0.025);
          // thin moonlit cloud wisps drifting low over the treeline
          vec2 cp = d.xz / (h + 0.09) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
          float cl = aFbm2(cp * vec2(0.55, 1.6));
          cl = smoothstep(0.55, 0.86, cl) * smoothstep(0.015, 0.09, h) * (1.0 - smoothstep(0.22, 0.5, h));
          col = mix(col, mix(uMid * 2.0, uMoonGlow * 0.5, pow(m, 10.0)), cl * 0.35);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.name = "arena-sky";
  root.add(dome);

  // ---------- stars ----------
  const r = rng(11);
  const N = 1500;
  const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), col = new Float32Array(N * 3);
  const tmp = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0, n = 0; n < N && i < N * 4; i++) {
    const y = between(r, Math.sin(0.02), Math.sin(1.2));
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(1 - y * y);
    tmp.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
    if (tmp.dot(MOON_DIR) > Math.cos(MOON.angularRadius * 2.2)) continue; // keep the moon's face clear
    tmp.multiplyScalar(140).toArray(pos, n * 3);
    const big = r() < 0.06;
    size[n] = big ? between(r, 2.4, 3.4) : between(r, 1.1, 2.1);
    phase[n] = r();
    hsl(c, between(r, 0.55, 0.68), between(r, 0.2, 0.6), 0.8);
    if (r() < 0.15) hsl(c, between(r, 0.08, 0.13), 0.5, 0.8);
    c.multiplyScalar(big ? 1.7 : between(r, 0.5, 1.1));
    c.toArray(col, n * 3);
    n++;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  starGeo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  starGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
    uniforms: { uTime: time, uPixelRatio: pixelRatio },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 color;
      uniform float uTime, uPixelRatio;
      varying vec3 vCol;
      void main() {
        float tw = 0.65 + 0.35 * sin(uTime * (1.3 + aPhase * 2.7) + aPhase * 40.0);
        float lowFade = smoothstep(0.01, 0.12, normalize(position).y);
        vCol = color * tw * lowFade;
        gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = 1.0 - smoothstep(0.2, 1.0, d);
        gl_FragColor = vec4(vCol, a);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }));
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  stars.name = "arena-stars";
  root.add(stars);

  // ---------- moon + halo ----------
  const dist = 120;
  const half = dist * Math.tan(MOON.angularRadius);
  const at = MOON_DIR.clone().multiplyScalar(dist);
  const moonVert = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * vec4(wp.xyz + cameraPosition, 1.0);
    }`;
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(half * 9, half * 9), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: hdr(SKY.moonGlow) } },
    vertexShader: moonVert,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0) * 4.5; // in moon radii
        float g = exp(-(r - 1.0) * 2.2) * 0.3 + exp(-(r - 1.0) * 0.6) * 0.06;
        g *= smoothstep(4.5, 3.0, r) * step(0.98, r);
        float ring = exp(-pow((r - 2.4) / 0.3, 2.0)) * 0.035;
        gl_FragColor = vec4(uColor * (g + ring), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }));
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: hdr(MOON.color, MOON.intensity) } },
    vertexShader: moonVert,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float aa = fwidth(r) * 1.5;
        float disc = 1.0 - smoothstep(1.0 - aa, 1.0, r);
        if (disc <= 0.0) discard;
        float z = sqrt(max(0.0, 1.0 - r * r));
        vec2 sp = p / (0.6 + 0.4 * z); // fake sphere wrap
        float maria = smoothstep(0.48, 0.72, aFbm2(sp * 1.6 + vec2(4.2, 1.3)));
        float fine = aFbm2(sp * 7.0 + 9.0);
        float shade = 1.0 - 0.34 * maria - 0.12 * fine;
        float limb = 0.7 + 0.3 * sqrt(z);
        gl_FragColor = vec4(uColor * shade * limb, disc);
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
  for (const [m, order] of [[halo, -8], [moon, -7]] as const) {
    m.position.copy(at);
    m.lookAt(0, 0, 0);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.name = m === moon ? "arena-moon" : "arena-moon-halo";
    root.add(m);
  }

  // ---------- far treelines on hills (opaque bands in the world, parallax against the moon) ----------
  const fog = hdr(FOG.color);
  const bands = [
    { radius: 92, top: 10, hill: 3.2, amp: 2.2, treeH: 3.6, density: 34, seed: 3.1, dark: 0.8 },
    { radius: 64, top: 7.5, hill: 2.0, amp: 1.6, treeH: 3.4, density: 26, seed: 7.7, dark: 0.62 },
    { radius: 42, top: 5.5, hill: 0.9, amp: 1.1, treeH: 3.0, density: 19, seed: 1.9, dark: 0.42 },
  ];
  for (const b of bands) {
    const h = b.top + 6;
    const geo = new THREE.CylinderGeometry(b.radius, b.radius, h, 200, 1, true, Math.PI * 0.5, Math.PI);
    geo.translate(0, h / 2 - 6, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: fog.clone().multiplyScalar(b.dark) },
        uMist: { value: fog.clone().multiplyScalar(1.12) },
        uRim: { value: hdr(SKY.moonGlow, 0.045) },
        uHill: { value: b.hill }, uAmp: { value: b.amp }, uTreeH: { value: b.treeH }, uDensity: { value: b.density }, uSeed: { value: b.seed },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uMist, uRim;
        uniform float uHill, uAmp, uTreeH, uDensity, uSeed;
        varying vec3 vPos;
        ${GLSL_NOISE}
        float firs(float a, float dens, float seed, float h) {
          float c = a * dens + seed;
          float i = floor(c), f = fract(c);
          float th = h * (0.35 + 0.65 * aHash(i * 1.73 + seed));
          float w = 0.75 + 0.5 * aHash(i * 3.1 + seed);
          float tri = 1.0 - abs(f - 0.5) * 2.0 * w;
          tri += 0.05 * (fract(f * 7.0) - 0.5); // ragged branch tips
          return th * max(0.0, tri);
        }
        void main() {
          float a = atan(vPos.x, -vPos.z);
          float hill = uHill + uAmp * ((aNoise(a * 2.2 + uSeed) - 0.5) * 2.0 + (aNoise(a * 6.5 + uSeed * 3.0) - 0.5) * 0.6);
          float top = hill + max(firs(a, uDensity, uSeed, uTreeH), firs(a, uDensity * 1.37, uSeed * 2.1 + 0.4, uTreeH * 0.85));
          float aa = fwidth(vPos.y) * 1.2;
          float alpha = 1.0 - smoothstep(top - aa, top + aa, vPos.y);
          if (alpha <= 0.001) discard;
          float mist = 1.0 - smoothstep(-2.0, hill + 1.2, vPos.y);
          vec3 col = mix(uColor, uMist, mist * 0.9);
          col += uRim * (1.0 - smoothstep(0.0, 0.35, top - vPos.y));
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      fog: false,
    });
    const band = new THREE.Mesh(geo, mat);
    band.renderOrder = -6;
    band.name = "arena-far-treeline";
    root.add(band);
  }
}
