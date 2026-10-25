// Hush, the Moon Wolf: a wolf-pelt hood (muzzle over the brow, tall ears, fur ruff around the face), a long
// starry night cloak with a crescent moon and twinkling stars, violet runes.
import * as THREE from "three";
import type { Kit } from "./kit";
import { hash } from "./kit";
import { V, aim, clamp, lerp, merge, paint, smooth, surface, sweep, zUp } from "./geom";
import { Cloak, canvasTex, chestRune, cloakMeshes, eyes, limbRunes } from "./parts";

const H = (x: number, y: number, z: number) => V(x - 0.008, y, z - 0.384);
const PELT = 0x45425e, FUR = 0x6e6890, NIGHT = 0x262a6a, LINING = 0x3a2058;

export function hush(k: Kit) {
  const pelt = k.std({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const rune = k.glowMat(1.0);
  const runeLimb = k.glowMat(0.95);
  const eyeMat = k.glowMat(1.6, 0.4);
  const peltEye = k.glowMat(0.9, 0.5);
  const moon = k.glowMat(1.5, 0.5, 0xe8e2ff);

  // ---------- wolf hood ----------
  const c = V(-0.004, 0, 0.405), rx = 0.1, ry = 0.093, rz = 0.113;
  const opening = (tp: number) => 1.08 * smooth(0.82, 1.32, tp);
  const hoodPt = (u: number, tp: number, out = new THREE.Vector3()) => {
    const f = opening(tp);
    const ph = f + u * (Math.PI * 2 - 2 * f);
    const flare = 1 + 0.28 * smooth(1.6, 2.35, tp) * (0.6 + 0.4 * -Math.cos(ph));
    const peak = 0.014 * Math.exp(-(((tp - 0.95) / 0.25) ** 2)) * Math.max(0, Math.cos(ph)) ** 2;
    out.set(c.x + rx * flare * Math.sin(tp) * Math.cos(ph) + peak, c.y + ry * flare * Math.sin(tp) * Math.sin(ph), c.z + rz * Math.cos(tp) - 0.03 * smooth(1.7, 2.35, tp));
    return out.sub(V(0.008, 0, 0.384));
  };
  const hood = paint(surface((u, v, o) => hoodPt(u, 0.04 + v * 2.31, o), 36, 16), PELT);
  // muzzle over the brow, nose, brow ridges
  const muzzle = sweep([H(0.035, 0, 0.494), H(0.075, 0, 0.489), H(0.11, 0, 0.474), H(0.138, 0, 0.461)], (u) => 0.04 * (1 - 0.62 * Math.pow(u, 1.1)), 16, 12);
  muzzle.translate(0, 0, -0.092).scale(1, 1.3, 0.72).translate(0, 0, 0.092);
  const nose = new THREE.SphereGeometry(0.0115, 10, 8);
  nose.scale(1, 1.25, 0.8);
  nose.translate(H(0.144, 0, 0.463).x, 0, H(0, 0, 0.463).z);
  // fangs along the underside of the upper jaw, hanging in front of the brow
  const fangs: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    for (const [x, y, z, len, r] of [[0.124, 0.014, 0.452, 0.021, 0.0042], [0.106, 0.021, 0.455, 0.011, 0.003], [0.092, 0.025, 0.458, 0.01, 0.003], [0.078, 0.028, 0.461, 0.009, 0.0028]] as const) {
      const f = zUp(new THREE.ConeGeometry(r, len, 5));
      f.rotateX(Math.PI);
      f.translate(H(x, s * y, z).x, s * y, H(0, 0, z).z - len / 2 + 0.002);
      fangs.push(f);
    }
  }
  const brows: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const b = new THREE.SphereGeometry(0.014, 8, 6);
    b.scale(1.3, 0.9, 0.6);
    b.translate(H(0.08, s * 0.027, 0.505).x, s * 0.027, H(0, 0, 0.505).z);
    brows.push(b);
  }
  // ears: flattened four-sided pyramids, tilted back and out
  const ears: THREE.BufferGeometry[] = [];
  const inner: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const e = zUp(new THREE.ConeGeometry(0.031, 0.085, 4));
    e.rotateZ(Math.PI / 4);
    e.scale(0.5, 1, 1);
    e.translate(0, 0, 0.0425);
    e.rotateY(-0.42);
    e.rotateX(-s * 0.22);
    e.translate(H(-0.012, s * 0.048, 0.495).x, s * 0.048, H(0, 0, 0.495).z);
    ears.push(e);
    const ie = zUp(new THREE.ConeGeometry(0.018, 0.058, 3));
    ie.scale(0.35, 1, 1);
    ie.translate(0.009, 0, 0.03);
    ie.rotateY(-0.42);
    ie.rotateX(-s * 0.22);
    ie.translate(H(-0.012, s * 0.048, 0.495).x, s * 0.048, H(0, 0, 0.495).z);
    inner.push(ie);
  }
  // fur ruff along the face opening
  const tufts: THREE.BufferGeometry[] = [];
  for (const side of [0, 1]) {
    for (let i = 0; i <= 20; i++) {
      const tp = 0.86 + (i / 20) * 1.46 + (hash(i * 3.1 + side) - 0.5) * 0.04;
      const at = hoodPt(side, tp);
      const inward = hoodPt(side, tp).add(V(0.008, 0, 0.384)).sub(c);
      const out = V(0.5 + hash(i * 1.3) * 0.6, inward.y * 4 + (hash(i * 2.9) - 0.5), inward.z * 3 - 0.4).normalize();
      const len = 0.011 + 0.012 * hash(i + side * 7);
      const tg = zUp(new THREE.ConeGeometry(0.0075, len, 4));
      tg.translate(0, 0, len / 2);
      tufts.push(aim(tg, at, out, i));
    }
  }
  const head = merge([hood, paint(merge([muzzle, ...brows, ...ears]), PELT), paint(nose, 0x111018), paint(merge(inner), 0x6a4a8a), paint(merge(tufts), FUR), paint(merge(fangs), 0xe6dfd0)]);
  k.add(k.a.head, k.mesh(head, pelt));
  const pe: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const g = new THREE.SphereGeometry(0.0055, 8, 6);
    g.scale(1, 1.3, 0.7);
    g.translate(H(0.092, s * 0.026, 0.497).x, s * 0.026, H(0, 0, 0.497).z);
    pe.push(g);
  }
  k.add(k.a.head, k.mesh(merge(pe), peltEye, false));
  eyes(k, eyeMat, { w: 0.0125, h: 0.0075, slant: -0.3 });

  // ---------- starry night cloak ----------
  const cloak = new Cloak((u, v, o) => {
    const top = smooth(0, 0.16, v);
    const arc = lerp(5.0, 3.8, top);
    const th = Math.PI + (u - 0.5) * arc;
    const below = clamp((v - 0.16) / 0.84, 0, 1);
    let z = v < 0.16 ? lerp(0.3, 0.21, Math.sin((v / 0.16) * Math.PI * 0.5)) : lerp(0.21, -0.68, below);
    z += 0.1 * Math.pow(2 * Math.abs(u - 0.5), 2.5) * Math.pow(below, 3); // hem sweeps up toward the front edges
    const ax = lerp(0.07, 0.13, top) + 0.08 * below;
    const ay = lerp(0.086, 0.222, top) + 0.065 * below;
    const cx = -0.01 - 0.02 * top - 0.085 * below * below;
    o.set(cx + ax * Math.cos(th), ay * Math.sin(th), z);
  }, { nu: 18, nv: 16, pivotV: 0.18, wave: 0.012, drag: 0.25 });
  const starTex = canvasTex(k, 512, 512, (g, w, h) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    const dot = (x: number, y: number, r: number, b: number) => {
      g.fillStyle = `rgba(255,255,255,${b})`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    for (let i = 0; i < 190; i++) dot(hash(i * 1.31) * w, (0.1 + 0.88 * hash(i * 2.77)) * h, 1 + 2 * hash(i * 4.1) ** 2, 0.35 + 0.65 * hash(i * 9.3));
    g.strokeStyle = "#fff";
    for (let i = 0; i < 16; i++) { // four-point sparkles
      const x = hash(i * 7.13 + 3) * w, y = (0.15 + 0.8 * hash(i * 3.71 + 1)) * h, r = 5 + 6 * hash(i * 1.9);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x - r, y); g.lineTo(x + r, y);
      g.moveTo(x, y - r); g.lineTo(x, y + r);
      g.stroke();
      dot(x, y, 2.4, 1);
    }
    g.globalAlpha = 0.35; // a constellation
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [x, y] of [[0.2, 0.45], [0.26, 0.38], [0.33, 0.41], [0.38, 0.33], [0.44, 0.36]]) g.lineTo(x * w, y * h);
    g.stroke();
    g.globalAlpha = 1;
    // crescent moon on the back, and a silver hem line
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(w * 0.5, h * 0.36, 34, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(w * 0.5 + 15, h * 0.36 - 9, 30, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "source-over";
    g.fillRect(0, h * 0.965, w, 5);
  });
  const nightTex = canvasTex(k, 64, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#a8b0ff");
    gr.addColorStop(1, "#5a5ab0");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const outer = k.glowEmissive(k.std({ color: NIGHT, map: nightTex, emissive: 0xe0dcff, emissiveMap: starTex, roughness: 0.75, metalness: 0.1, side: THREE.FrontSide }), 1.25, 0.4);
  const lining = k.std({ color: LINING, roughness: 0.85, side: THREE.BackSide });
  const holder = k.add(k.a.body("torso_link"), new THREE.Group());
  holder.add(...cloakMeshes(k, cloak, outer, lining));
  // moonstone clasp at the throat
  const clasp = new THREE.SphereGeometry(0.011, 10, 8);
  clasp.scale(0.6, 1, 1);
  clasp.translate(0.07, 0, 0.29);
  holder.add(k.mesh(clasp, moon, false));

  // twinkling stars riding on the cloak (one Points, fixed buffer)
  const NS = 26;
  const starIdx: [number, number][] = Array.from({ length: NS }, (_, i) => [1 + Math.floor(hash(i * 3.3 + 0.5) * 17), 4 + Math.floor(hash(i * 5.7 + 0.2) * 12)]);
  const sPos = new Float32Array(NS * 3), sCol = new Float32Array(NS * 3);
  const sGeo = k.own(new THREE.BufferGeometry());
  const sPosA = new THREE.BufferAttribute(sPos, 3), sColA = new THREE.BufferAttribute(sCol, 3);
  sPosA.setUsage(THREE.DynamicDrawUsage);
  sColA.setUsage(THREE.DynamicDrawUsage);
  sGeo.setAttribute("position", sPosA);
  sGeo.setAttribute("color", sColA);
  const sprite = canvasTex(k, 64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.18, "rgba(255,255,255,0.7)");
    r.addColorStop(0.5, "rgba(255,255,255,0.08)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(4, h / 2); g.lineTo(w - 4, h / 2);
    g.moveTo(w / 2, 4); g.lineTo(w / 2, h - 4);
    g.stroke();
  });
  const sMat = k.glowColored(new THREE.PointsMaterial({ size: 0.03, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }), 1.8, 0.5, 0xe8e0ff);
  const stars = new THREE.Points(sGeo, sMat);
  stars.frustumCulled = false;
  holder.add(stars);
  const tmp = new THREE.Vector3();

  // ---------- limbs ----------
  const wrap = new THREE.CylinderGeometry(0.04, 0.045, 0.09, 14, 1, true).rotateZ(-Math.PI / 2);
  wrap.translate(0.014, 0.002, -0.005);
  k.own(wrap);
  const wrapMat = k.std({ color: 0x2a2848, roughness: 0.9, side: THREE.DoubleSide });
  for (const fa of [k.a.leftForearm, k.a.rightForearm]) k.add(fa, new THREE.Mesh(wrap, wrapMat));
  limbRunes(k, { glyph: "crescent", ringMat: runeLimb, forearmR: 0.047, forearmRingX: 0.05, tube: 0.0032, glyphSize: 0.036, forearmGlyphR: 0.0465 });
  chestRune(k, "crescent", rune, 0.07, undefined, -0.012);

  return (t: number, dt: number) => {
    cloak.update(holder, t, dt, k.energy);
    for (let i = 0; i < NS; i++) {
      cloak.vertex(starIdx[i][0], starIdx[i][1], 0.006, tmp);
      sPos[i * 3] = tmp.x; sPos[i * 3 + 1] = tmp.y; sPos[i * 3 + 2] = tmp.z;
      const tw = Math.max(0, Math.sin(t * (1.3 + 2.2 * hash(i * 1.7)) + i * 2.1));
      const b = 0.15 + 0.85 * tw * tw * tw;
      sCol[i * 3] = b; sCol[i * 3 + 1] = b; sCol[i * 3 + 2] = b;
    }
    sPosA.needsUpdate = true;
    sColA.needsUpdate = true;
    k.setExtra(outer, 0.85 + 0.15 * Math.sin(t * 1.3));
  };
}
