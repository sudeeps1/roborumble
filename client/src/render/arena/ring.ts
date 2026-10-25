// The fairy ring: clusters of glowing mushrooms around the duel, colored pools of light on the moss beneath them,
// and a faint shimmering circle on the ground. Caps glow in teal, violet and warm gold; a slow wave of light runs
// around the ring. Front arc (toward the camera) holds only small mushrooms so nothing hides the fighters.
import * as THREE from "three";
import { RING_RADIUS, SHROOM_COLORS, SHROOM_WEIGHTS } from "./palette";
import { GLSL_NOISE, between, canvasTexture, glowTexture, lerp, patch, rng, smooth, type Rng } from "./util";

interface Shroom {
  x: number; z: number;
  h: number;           // total height
  capR: number; capH: number; stemR: number;
  tilt: number; tiltDir: number;
  color: THREE.Color;  // linear glow color
  glow: number;
}

// Ripple of light around the ring from an impact point (ringFlare). Shared by caps, stems, halos and the ring line.
const flare = { uFlareAt: { value: 0 }, uFlareT0: { value: -100 }, uFlareK: { value: 0 } };
let flareClock: { value: number } = { value: 0 };
const FLARE_GLSL = /* glsl */ `
uniform float uFlareAt, uFlareT0, uFlareK;
float ringRipple(float ang, float now) {
  float since = now - uFlareT0;
  if (since < 0.0 || since > 3.0) return 0.0;
  float d = abs(mod(ang - uFlareAt + 3.14159265, 6.2831853) - 3.14159265);
  return uFlareK * exp(-pow((d - since * 2.6) / 0.4, 2.0)) * exp(-since * 1.1);
}`;

/** Sends a ripple of light around the fairy ring from the point nearest `at` (three.js world). strength ~0.5..1.5. */
export function ringFlare(at: THREE.Vector3, strength = 1) {
  flare.uFlareAt.value = Math.atan2(at.x, -at.z);
  flare.uFlareT0.value = flareClock.value;
  flare.uFlareK.value = strength;
}

/** Tallest mushroom allowed at a ring point: tiny in front, tall behind (but not right behind a fighter). */
function maxHeight(x: number, z: number) {
  if (z > 0.8) return 0.17;
  if (z > -0.9) return lerp(0.17, 0.42, smooth(0.8, -0.9, z));
  // the fighters' bodies cover the ring around x = +-1; the gap between them (x ~ 0) is where moves fly
  const ax = Math.abs(x);
  const flank = smooth(1.35, 1.75, ax); // back-left / back-right: the big ones
  return lerp(ax < 0.55 ? 0.3 : 0.24, 0.8, flank);
}

function pickColor(r: Rng): number {
  let u = r();
  for (let i = 0; i < SHROOM_COLORS.length; i++) {
    u -= SHROOM_WEIGHTS[i];
    if (u <= 0) return SHROOM_COLORS[i];
  }
  return SHROOM_COLORS[0];
}

function layout(): Shroom[] {
  const r = rng(77);
  const out: Shroom[] = [];
  const hsl = { h: 0, s: 0, l: 0 };
  const make = (x: number, z: number, h: number, base: THREE.Color, glow: number) => {
    const small = h < 0.12;
    const capR = h * between(r, 0.36, 0.56) * (small ? 1.25 : 1);
    const c = base.clone();
    c.getHSL(hsl);
    c.setHSL(hsl.h + between(r, -0.025, 0.025), hsl.s, hsl.l * between(r, 0.9, 1.08));
    out.push({
      x, z, h, capR,
      capH: capR * between(r, 0.42, 0.85),
      stemR: h * between(r, 0.06, 0.1) * (small ? 1.5 : 1),
      tilt: between(r, 0, 0.2), tiltDir: r() * Math.PI * 2,
      color: c, glow,
    });
  };
  // clusters
  for (let a = r() * 0.2; a < Math.PI * 2; a += between(r, 0.13, 0.3)) {
    const R = RING_RADIUS + between(r, -0.1, 0.1);
    const x = Math.sin(a) * R, z = -Math.cos(a) * R;
    const top = maxHeight(x, z);
    const base = new THREE.Color(pickColor(r));
    const lead = top * between(r, 0.6, 1);
    const glow = between(r, 0.85, 1.25);
    make(x, z, lead, base, glow);
    const followers = Math.floor(between(r, 0, 4.99));
    for (let k = 0; k < followers; k++) {
      const fa = a + between(r, -0.09, 0.09), fr = R + between(r, -0.18, 0.18);
      const fx = Math.sin(fa) * fr, fz = -Math.cos(fa) * fr;
      make(fx, fz, Math.min(maxHeight(fx, fz), lead * between(r, 0.25, 0.7)), base, glow * between(r, 0.8, 1.1));
    }
  }
  // a near-continuous dotted circle of tiny ones between the clusters, so the ring reads as a ring
  for (let a = 0; a < Math.PI * 2; a += between(r, 0.035, 0.07)) {
    if (r() < 0.25) continue;
    const R = RING_RADIUS + between(r, -0.13, 0.13);
    make(Math.sin(a) * R, -Math.cos(a) * R, between(r, 0.025, 0.075), new THREE.Color(pickColor(r)), between(r, 0.7, 1.2));
  }
  return out;
}

function stemGeometry(): THREE.BufferGeometry {
  const pts = ([[1.3, 0], [1.0, 0.07], [0.9, 0.4], [0.82, 0.85], [0.9, 1]] as const).map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 8);
  const p = g.getAttribute("position");
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) col.fill(lerp(0.3, 1, Math.pow(p.getY(i), 1.5)), i * 3, i * 3 + 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

function capGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.getAttribute("position");
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    // bell flare at the rim
    const flare = 1 + 0.12 * smooth(0.3, 0, y);
    p.setXYZ(i, p.getX(i) * flare, y - 0.06 * smooth(0.2, 0, y), p.getZ(i) * flare);
    col.fill(lerp(0.8, 1.05, y), i * 3, i * 3 + 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Cap emissive map: soft gradient, brighter rim, pale spots (sphere UVs: v=1 at the top, v=0 at the rim). */
function capTexture(): THREE.CanvasTexture {
  const W = 256, H = 64;
  return canvasTexture(W, H, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#d8d8d8");
    g.addColorStop(0.55, "#b4b4b4");
    g.addColorStop(0.85, "#c8c8c8");
    g.addColorStop(1, "#f0f0f0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const r = rng(91);
    for (let i = 0; i < 22; i++) {
      const y = between(r, 0.18, 0.78) * H;
      const theta = (y / H) * Math.PI / 2; // 0 at the top
      const ry = between(r, 2.2, 5.5);
      const rx = ry / Math.max(0.25, Math.sin(theta)) * (W / (H * 4));
      const x = r() * W;
      ctx.fillStyle = "#ffffff";
      for (const ox of [-W, 0, W]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

/** MeshStandardMaterial whose emissive is tinted per instance (instanceColor x vertex color) and pulses. */
function glowMaterial(key: string, opts: THREE.MeshStandardMaterialParameters, glow: number, spots: boolean, time: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ ...opts, emissive: 0xffffff, vertexColors: true });
  patch(m, key, (s) => {
    s.uniforms.uTime = time;
    s.uniforms.uGlow = { value: glow };
    Object.assign(s.uniforms, flare);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nvarying float vPulse;\n${FLARE_GLSL}`)
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        {
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float ang = atan(ip.x, -ip.y);
          float wave = sin(ang * 2.0 - uTime * 0.9);
          vPulse = 0.84 + 0.16 * wave + 0.05 * sin(uTime * 2.3 + ip.x * 9.1 + ip.y * 5.7) + ringRipple(ang, uTime) * 1.1;
        }`);
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uGlow;\nvarying float vPulse;")
      .replace("#include <emissivemap_fragment>", /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vColor.rgb * uGlow * vPulse;
        ${spots ? "totalEmissiveRadiance = mix(totalEmissiveRadiance, vec3(1.0, 0.96, 0.88) * 1.15, smoothstep(0.97, 1.0, emissiveColor.g) * 0.7);" : ""}`);
  });
  return m;
}

export function buildRing(root: THREE.Object3D, time: { value: number }) {
  flareClock = time;
  const shrooms = layout();
  const n = shrooms.length;
  const stems = new THREE.InstancedMesh(stemGeometry(), glowMaterial("stem", { color: 0xd9d2c4, roughness: 0.6, metalness: 0 }, 0.32, false, time), n);
  const caps = new THREE.InstancedMesh(capGeometry(), glowMaterial("cap", { color: 0x9a9a9a, roughness: 0.38, metalness: 0, emissiveMap: capTexture() }, 0.95, true, time), n);
  const pools = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowTexture(128, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    n,
  );

  const m = new THREE.Matrix4(), tilt = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const axis = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const stemCol = new THREE.Color(), white = new THREE.Color(1, 1, 1), poolCol = new THREE.Color();
  const r = rng(78);
  shrooms.forEach((sh, i) => {
    axis.set(Math.cos(sh.tiltDir), 0, Math.sin(sh.tiltDir));
    q.setFromAxisAngle(axis, sh.tilt);
    const spin = new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2);
    q.multiply(spin);
    const stemH = sh.h - sh.capH * 0.55;
    // stem: base on the ground, tilted
    p.set(sh.x, -0.01, sh.z);
    s.set(sh.stemR, stemH, sh.stemR);
    stems.setMatrixAt(i, m.compose(p, q, s));
    // cap: on top of the tilted stem
    tilt.makeRotationFromQuaternion(q);
    const top = new THREE.Vector3(0, stemH * 0.97, 0).applyMatrix4(tilt);
    p.set(sh.x + top.x, top.y - 0.01, sh.z + top.z);
    s.set(sh.capR, sh.capH, sh.capR);
    caps.setMatrixAt(i, m.compose(p, q, s));
    caps.setColorAt(i, sh.color.clone().multiplyScalar(sh.glow));
    stemCol.copy(sh.color).lerp(white, 0.55).multiplyScalar(sh.glow);
    stems.setColorAt(i, stemCol);
    // light pool on the moss, scaled with the cap
    const size = Math.min(2.0, Math.max(0.22, sh.capR * 5 + sh.h));
    m.makeScale(size, 1, size).setPosition(sh.x, 0.006, sh.z);
    pools.setMatrixAt(i, m);
    poolCol.copy(sh.color).multiplyScalar(sh.glow * lerp(0.1, 0.32, Math.min(1, sh.h / 0.6)));
    pools.setColorAt(i, poolCol);
  });
  stems.castShadow = caps.castShadow = true;
  stems.receiveShadow = caps.receiveShadow = true;
  stems.name = "arena-shroom-stems";
  caps.name = "arena-shroom-caps";
  pools.name = "arena-shroom-light";
  pools.renderOrder = -1;
  root.add(stems, caps, pools);
  root.add(halos(shrooms, caps, time));
  root.add(ringLine(time));
}

/** Soft colored glow around every cap: camera-facing quads at the cap centers (behind the cap's front face). */
function halos(shrooms: Shroom[], caps: THREE.InstancedMesh, time: { value: number }): THREE.InstancedMesh {
  const n = shrooms.length;
  const geo = new THREE.PlaneGeometry(2, 2);
  const data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  geo.setAttribute("aHalo", data);
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
    uniforms: { uTime: time, ...flare },
    vertexShader: /* glsl */ `
      attribute vec4 aHalo; // rgb glow (linear), size (m)
      uniform float uTime;
      ${FLARE_GLSL}
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        vec3 c = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ang = atan(c.x, -c.z);
        float pulse = 0.84 + 0.16 * sin(ang * 2.0 - uTime * 0.9) + 0.05 * sin(uTime * 2.3 + c.x * 9.1 + c.z * 5.7);
        float rip = ringRipple(ang, uTime);
        vCol = aHalo.rgb * (pulse + rip * 2.2);
        vec4 mv = modelViewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * aHalo.w * (1.0 + rip * 0.6);
        gl_Position = projectionMatrix * mv;
        vUv = position.xy;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying vec2 vUv;
      void main() {
        float d = length(vUv);
        if (d > 1.0) discard;
        float g = (1.0 - d) * (1.0 - d);
        gl_FragColor = vec4(vCol * g, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }), n);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  shrooms.forEach((sh, i) => {
    caps.getMatrixAt(i, m);
    m.decompose(p, q, s);
    m.makeTranslation(p.x, p.y + sh.capH * 0.35, p.z);
    mesh.setMatrixAt(i, m);
    const k = sh.glow * lerp(0.1, 0.2, Math.min(1, sh.h / 0.5));
    data.setXYZW(i, sh.color.r * k, sh.color.g * k, sh.color.b * k, sh.capR * 2.4 + 0.03);
  });
  mesh.frustumCulled = false;
  mesh.name = "arena-shroom-halos";
  return mesh;
}

/** Faint shimmering circle on the ground along the ring. */
function ringLine(time: { value: number }): THREE.Mesh {
  const W = 0.5;
  const geo = new THREE.RingGeometry(RING_RADIUS - W, RING_RADIUS + W, 256, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: time,
      ...flare,
      uR: { value: RING_RADIUS },
      uA: { value: new THREE.Color(SHROOM_COLORS[0]) },
      uB: { value: new THREE.Color(SHROOM_COLORS[1]) },
      uC: { value: new THREE.Color(SHROOM_COLORS[2]) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() { vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uR;
      uniform vec3 uA, uB, uC;
      varying vec2 vXZ;
      ${GLSL_NOISE}
      ${FLARE_GLSL}
      void main() {
        float r = length(vXZ);
        float a = atan(vXZ.x, -vXZ.y);
        float d = r - uR - 0.06 * (aNoise(a * 9.0) - 0.5);
        float line = exp(-d * d / 0.0009) * 0.5 + exp(-d * d / 0.02) * 0.12;
        float sparkle = pow(aNoise(a * 140.0 - uTime * 3.0), 12.0) * exp(-d * d / 0.004) * 1.4;
        float wave = 0.65 + 0.35 * sin(a * 2.0 - uTime * 0.9);
        vec3 hue = mix(uA, uB, aNoise(a * 2.5 + 3.0));
        hue = mix(hue, uC, smoothstep(0.55, 0.85, aNoise(a * 3.7 + 11.0)));
        float rip = ringRipple(a, uTime);
        gl_FragColor = vec4(hue * (line * (wave + rip * 3.0) + sparkle + exp(-d * d / 0.05) * rip * 0.35), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.008;
  mesh.renderOrder = -1;
  mesh.name = "arena-ring-line";
  return mesh;
}
