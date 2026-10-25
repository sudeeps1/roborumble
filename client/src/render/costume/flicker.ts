// Flicker, the Storm Sprite: two pairs of dragonfly wings that flutter and crackle with wisp-light, a circlet with
// curling antennae, leaf ears and a leafy collar, yellow runes.
import * as THREE from "three";
import type { Kit } from "./kit";
import { hash } from "./kit";
import { V, leafShape, merge, paint, shapeGeo, sweep } from "./geom";
import { SIDES, basis, canvasTex, chestRune, eyes, limbRunes } from "./parts";

const H = (x: number, y: number, z: number) => V(x - 0.008, y, z - 0.384);
const GOLD = 0xc9a448, LEAF = 0x86b83c, LEAF2 = 0x5f9a2e;

// wing outline in canvas space (512 x 128): root at the left, leading edge on top
function wingPath(c: CanvasRenderingContext2D) {
  c.beginPath();
  c.moveTo(6, 66);
  c.bezierCurveTo(60, 30, 300, 12, 468, 26);
  c.bezierCurveTo(514, 30, 516, 82, 470, 90);
  c.bezierCurveTo(330, 114, 120, 106, 6, 72);
  c.closePath();
}
// y of the n-th longitudinal vein at canvas x (0 = leading edge); runs per frame for the crackle, so no allocations
const VEIN_FRAC = [0.0, 0.3, 0.55, 0.8];
const veinY = (n: number, x: number) => {
  const t = x / 512;
  const lead = 66 - 44 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5) + 6 * t * t;
  const trail = 72 + 32 * Math.sin(Math.min(1, t * 1.05) * Math.PI * 0.62);
  return lead + (trail - lead) * VEIN_FRAC[n] * (0.25 + 0.75 * Math.min(1, t * 3));
};

export function flicker(k: Kit) {
  const goldMat = k.std({ color: GOLD, roughness: 0.3, metalness: 0.85 });
  const leafMat = k.std({ color: 0xffffff, vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  const antMat = k.std({ color: 0x5a4a22, roughness: 0.5, metalness: 0.5 });
  const rune = k.glowMat(1.0);
  const runeLimb = k.glowMat(0.95);
  const bulb = k.glowMat(2.0, 0.6);
  const gem = k.glowMat(1.6, 0.6);
  const eyeMat = k.glowMat(1.4, 0.4);

  // ---------- circlet, gem, antennae, leaf ears ----------
  const circ = new THREE.TorusGeometry(1, 0.05, 6, 48);
  circ.scale(0.07, 0.061, 0.07);
  circ.rotateY(0.18); // lower at the brow
  circ.translate(H(0.006, 0, 0.437).x, 0, H(0, 0, 0.437).z);
  const setting = new THREE.TorusGeometry(0.009, 0.0022, 5, 12);
  basis(setting, V(0, 1, 0), V(0, 0, 1), V(1, 0, 0), H(0.078, 0, 0.424));
  k.add(k.a.head, k.mesh(merge([circ, setting]), goldMat));
  const gemGeo = new THREE.OctahedronGeometry(0.0085, 0);
  gemGeo.scale(0.7, 0.8, 1.2);
  gemGeo.translate(H(0.082, 0, 0.424).x, 0, H(0, 0, 0.424).z);
  k.add(k.a.head, k.mesh(gemGeo, gem, false));

  const antennae: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.copy(H(0.045, s * 0.034, 0.468));
    k.add(k.a.head, pivot);
    const pts = [V(0, 0, 0), V(0.032, s * 0.014, 0.06), V(0.042, s * 0.03, 0.13), V(0.02, s * 0.045, 0.185), V(-0.018, s * 0.05, 0.198), V(-0.036, s * 0.046, 0.18)];
    pivot.add(k.mesh(sweep(pts, (u) => 0.0036 - 0.0016 * u, 28, 5), antMat));
    const b = new THREE.SphereGeometry(0.0085, 10, 8);
    b.translate(pts[5].x, pts[5].y, pts[5].z);
    pivot.add(k.mesh(b, bulb, false));
    antennae.push(pivot);
  }
  const leaves: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const dir = V(-0.75, s * 0.3, 0.6).normalize();
    const n = V(0.15, s, 0.25).normalize();
    const d = dir.clone().projectOnPlane(n).normalize();
    leaves.push(paint(basis(shapeGeo(leafShape(0.085, 0.022, -0.008)), d.clone().cross(n).normalize(), d, n, H(-0.012, s * 0.06, 0.41)), LEAF));
  }
  k.add(k.a.head, k.mesh(merge(leaves), leafMat));
  eyes(k, eyeMat, { w: 0.0125, h: 0.0095, slant: 0.1 });

  // ---------- leafy collar around the neck ----------
  const collar: THREE.BufferGeometry[] = [];
  const nl = 14;
  for (let i = 0; i < nl; i++) {
    const a = Math.PI + ((i - (nl - 1) / 2) / ((nl - 1) / 2)) * 2.5; // around the back, open at the throat
    const base = V(-0.006 + 0.066 * Math.cos(a), 0.084 * Math.sin(a), 0.29 - (i % 2) * 0.006);
    const out = V(Math.cos(a), Math.sin(a) * 1.15, 0).normalize();
    const dir = out.clone().multiplyScalar(0.75).add(V(0, 0, 0.7)).normalize();
    const n = out.clone().multiplyScalar(-0.6).add(V(0, 0, 0.8)).normalize().projectOnPlane(dir).normalize();
    const len = (0.062 + 0.02 * Math.cos(a - Math.PI)) * (i % 2 ? 0.85 : 1);
    collar.push(paint(basis(shapeGeo(leafShape(len, 0.021, 0.005)), dir.clone().cross(n).normalize(), dir, n, base.sub(V(0.086, 0, 0.2))), i % 2 ? LEAF : LEAF2));
  }
  k.add(k.a.chest, k.mesh(merge(collar), leafMat));

  // ---------- leaf belt (front and back only, the hips are busy) ----------
  const belt: THREE.BufferGeometry[] = [];
  const vine = new THREE.TorusGeometry(1, 0.06, 5, 36);
  vine.scale(0.066, 0.074, 0.066);
  vine.translate(0, 0, -0.02);
  belt.push(paint(vine, 0x4a6a22));
  for (const [a, len] of [[-0.55, 0.05], [-0.18, 0.062], [0.18, 0.058], [0.55, 0.048], [Math.PI - 0.5, 0.05], [Math.PI - 0.15, 0.06], [Math.PI + 0.2, 0.055], [Math.PI + 0.55, 0.045]] as const) {
    const out = V(Math.cos(a), Math.sin(a) * 1.1, 0).normalize();
    const dir = out.clone().multiplyScalar(0.25).add(V(0, 0, -1)).normalize();
    const n = out.clone().projectOnPlane(dir).normalize();
    belt.push(paint(basis(shapeGeo(leafShape(len, 0.017, 0.003)), dir.clone().cross(n).normalize(), dir, n, V(0.068 * Math.cos(a), 0.076 * Math.sin(a), -0.018)), Math.round(a * 10) % 2 ? LEAF : LEAF2));
  }
  k.add(k.a.pelvis, k.mesh(merge(belt), leafMat));
  const buckleGem = new THREE.OctahedronGeometry(0.008, 0);
  buckleGem.scale(0.7, 1, 1);
  buckleGem.translate(0.074, 0, -0.02);
  k.add(k.a.pelvis, k.mesh(buckleGem, gem, false));

  // ---------- dragonfly wings ----------
  const wingTex = canvasTex(k, 512, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    wingPath(c);
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, "rgba(160,240,255,0.6)");
    g.addColorStop(0.5, "rgba(190,225,255,0.4)");
    g.addColorStop(1, "rgba(230,200,255,0.32)");
    c.fillStyle = g;
    c.fill();
    c.save();
    wingPath(c);
    c.clip();
    const ir = c.createLinearGradient(0, 0, w * 0.6, h);
    ir.addColorStop(0, "rgba(120,255,220,0.0)");
    ir.addColorStop(0.45, "rgba(110,255,210,0.3)");
    ir.addColorStop(0.7, "rgba(255,140,230,0.26)");
    ir.addColorStop(1, "rgba(255,150,230,0.0)");
    c.fillStyle = ir;
    c.fillRect(0, 0, w, h);
    c.fillStyle = "rgba(70,50,20,0.9)"; // pterostigma
    c.fillRect(408, veinY(0, 420) - 1, 34, 9);
    c.restore();
    c.strokeStyle = "rgba(255,255,230,0.9)";
    c.lineWidth = 2;
    wingPath(c);
    c.stroke();
  });
  const veinTex = canvasTex(k, 512, 128, (c, w, h) => {
    c.fillStyle = "#000";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#fff";
    c.lineCap = "round";
    for (let n = 0; n < 4; n++) {
      c.lineWidth = n === 0 ? 5 : 3;
      c.beginPath();
      for (let x = 6; x <= 470; x += 8) c.lineTo(x, veinY(n, x));
      c.stroke();
    }
    c.lineWidth = 1.6;
    for (let x = 30, i = 0; x < 460; x += 9 + 9 * hash(i * 0.71), i++) { // cross veins
      for (let n = 0; n < 3; n++) {
        const j = (hash(x * 0.37 + n) - 0.5) * 10;
        c.beginPath();
        c.moveTo(x + j, veinY(n, x + j));
        c.lineTo(x + j + 4, veinY(n + 1, x + j + 4));
        c.stroke();
      }
    }
    c.lineWidth = 3;
    wingPath(c);
    c.stroke();
  });
  const wingMat = k.glowEmissive(k.std({
    map: wingTex, emissiveMap: veinTex, emissive: k.def.glow, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, roughness: 0.25, metalness: 0.2, alphaTest: 0.01,
  }), 0.7, 0.45);
  const L = 0.42, W = 0.105;
  const wingGeo = new THREE.PlaneGeometry(L, W);
  wingGeo.translate(L / 2, 0, 0);
  k.own(wingGeo);
  // root, length direction (elevation, spread), leading edge "up"; built for the left side and mirrored in y
  const wingDefs = [
    { root: V(-0.008, 0.026, 0.035), elev: 0.42, spread: 0.42, up: 1, scale: 1.0, phase: 0 },
    { root: V(-0.008, 0.024, -0.012), elev: -0.28, spread: 0.5, up: -1, scale: 0.9, phase: 1.9 },
  ];
  interface Wing { pivot: THREE.Group; base: THREE.Quaternion; phase: number }
  const wings: Wing[] = [];
  for (const side of SIDES) {
    const s = side === "left" ? 1 : -1;
    for (const d of wingDefs) {
      const Ld = V(-Math.cos(d.elev) * Math.cos(d.spread), s * Math.cos(d.elev) * Math.sin(d.spread), Math.sin(d.elev)).normalize();
      const up = V(0.25, 0, d.up).projectOnPlane(Ld).normalize();
      const N = Ld.clone().cross(up).normalize();
      const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Ld, up, N));
      const pivot = new THREE.Group();
      pivot.position.set(d.root.x, s * d.root.y, d.root.z);
      pivot.quaternion.copy(base);
      const m = new THREE.Mesh(wingGeo, wingMat);
      m.scale.set(d.scale, d.scale * (d.up > 0 ? 1 : -1.08), 1); // hind wings: leading edge at the bottom
      m.renderOrder = 2;
      pivot.add(m);
      k.add(k.a.back, pivot);
      wings.push({ pivot, base, phase: d.phase + (s > 0 ? 0 : 0.35) });
    }
  }

  // crackle: short jagged ribbons of wisp-light along the wing veins (one mesh, fixed pool, no allocations per frame)
  const MAX_ARCS = 6, SEG = 7, MAXQ = MAX_ARCS * SEG;
  const arcPos = new Float32Array(MAXQ * 4 * 3);
  const arcIdx: number[] = [];
  for (let q = 0; q < MAXQ; q++) arcIdx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2);
  const arcGeo = k.own(new THREE.BufferGeometry());
  const arcAttr = new THREE.BufferAttribute(arcPos, 3);
  arcAttr.setUsage(THREE.DynamicDrawUsage);
  arcGeo.setAttribute("position", arcAttr);
  arcGeo.setIndex(arcIdx);
  arcGeo.setDrawRange(0, 0);
  const arcMat = k.glowMat(3.2, 0.4, 0xfff2b0, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const arcs = new THREE.Mesh(arcGeo, arcMat);
  arcs.frustumCulled = false;
  arcs.renderOrder = 3;
  k.add(k.a.back, arcs);
  const pool = Array.from({ length: MAX_ARCS }, () => ({ life: 0, wing: 0, c0: 0, c1: 0, vein: 0 }));
  const xs = new Float32Array(SEG + 1), ys = new Float32Array(SEG + 1);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), p = new THREE.Vector3();
  const AX_Z = new THREE.Vector3(0, 0, 1), AX_Y = new THREE.Vector3(0, 1, 0);
  const HALF_W = 0.0022;
  let spawnAcc = 0;
  const put = (wg: Wing, x: number, y: number, at: number) => {
    p.set(x, y, 0.003).applyQuaternion(wg.pivot.quaternion).add(wg.pivot.position);
    arcPos[at] = p.x; arcPos[at + 1] = p.y; arcPos[at + 2] = p.z;
  };

  // ---------- limbs and chest ----------
  limbRunes(k, { glyph: "bolt", ringMat: runeLimb, forearmR: 0.043, forearmRingX: 0.05, tube: 0.003, glyphSize: 0.036, rings2: true });
  chestRune(k, "bolt", rune, 0.07, gem, -0.005);

  return (t: number, dt: number) => {
    const charging = k.charging;
    const e = k.energy;
    const w = (charging ? 11 : 5 + e) * Math.PI * 2;
    for (let wi = 0; wi < wings.length; wi++) {
      const wg = wings[wi];
      const ph = t * w + wg.phase;
      const sweepA = (charging ? 0.1 : 0.05) * Math.sin(ph);
      const flapA = (charging ? 0.42 : 0.2 * e) * Math.sin(ph + 1.2);
      qa.setFromAxisAngle(AX_Z, sweepA);
      qb.setFromAxisAngle(AX_Y, flapA);
      wg.pivot.quaternion.copy(wg.base).multiply(qa).multiply(qb);
    }
    for (let i = 0; i < antennae.length; i++) {
      const a = antennae[i];
      const j = charging ? 0.05 * Math.sin(t * 37 + i) : 0;
      a.rotation.set(0.07 * Math.sin(t * 3.1 + i * 2) + j, 0.06 * Math.sin(t * 2.3 + i) - 0.03, 0.04 * Math.sin(t * 1.7 + i * 3));
    }
    k.setExtra(bulb, 0.85 + 0.15 * Math.sin(t * 4.2) + (charging ? 0.5 * hash(Math.floor(t * 30)) : 0));

    // crackle: canvas-space paths along the veins, re-jittered every frame, mapped into the anchor frame
    if (dt > 0) {
      spawnAcc += dt * (charging ? 30 : k.status === "acting" ? 9 : 2.5);
      for (let ai = 0; ai < MAX_ARCS; ai++) {
        const a = pool[ai];
        a.life -= dt;
        if (a.life <= 0 && spawnAcc >= 1) {
          spawnAcc -= 1;
          a.life = 0.05 + 0.08 * Math.random();
          a.wing = Math.floor(Math.random() * wings.length);
          a.c0 = 10 + 50 * Math.random();
          a.c1 = Math.min(470, a.c0 + 120 + 280 * Math.random());
          a.vein = Math.floor(Math.random() * 3);
        }
      }
      spawnAcc = Math.min(spawnAcc, 1);
    }
    let q = 0;
    const lit = k.fade > 0.05;
    for (let ai = 0; ai < MAX_ARCS; ai++) {
      const a = pool[ai];
      if (a.life <= 0 || !lit) continue;
      const wg = wings[a.wing];
      const ms = wg.pivot.children[0].scale;
      for (let i = 0; i <= SEG; i++) {
        const cx = a.c0 + ((a.c1 - a.c0) * i) / SEG;
        const cy = veinY(a.vein, cx) + (i > 0 && i < SEG ? (Math.random() - 0.5) * 30 : 0);
        xs[i] = (cx / 512) * L * ms.x;
        ys[i] = (0.5 - cy / 128) * W * ms.y;
      }
      for (let i = 0; i < SEG; i++, q++) {
        let dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
        const len = Math.hypot(dx, dy) || 1;
        dx = (-dy / len) * HALF_W * (1 + 0.6 * (1 - i / SEG));
        dy = ((xs[i + 1] - xs[i]) / len) * HALF_W * (1 + 0.6 * (1 - i / SEG));
        const o = q * 12;
        put(wg, xs[i] + dx, ys[i] + dy, o);
        put(wg, xs[i] - dx, ys[i] - dy, o + 3);
        put(wg, xs[i + 1] + dx, ys[i + 1] + dy, o + 6);
        put(wg, xs[i + 1] - dx, ys[i + 1] - dy, o + 9);
      }
    }
    arcGeo.setDrawRange(0, q * 6);
    if (q > 0) arcAttr.needsUpdate = true;
  };
}
