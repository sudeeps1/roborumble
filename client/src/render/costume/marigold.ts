// Marigold, the Hearth Witch: a tall crooked hat with a lantern swinging from its tip, an ember-stitched cloak
// with a ragged hem and a high collar, orange runes.
import * as THREE from "three";
import type { Kit } from "./kit";
import { hash } from "./kit";
import { V, clamp, lerp, merge, paint, smooth, stroke, surface, sweep, zUp } from "./geom";
import { Cloak, Pendulum, basis, canvasTex, chestRune, cloakMeshes, eyes, limbRunes } from "./parts";

const H = (x: number, y: number, z: number) => V(x - 0.008, y, z - 0.384);
const HAT = 0x4a1830, BAND = 0xc08a2a, CLOAK = 0x8c3020, LINING = 0x7a4a1c;

export function marigold(k: Kit) {
  const hatMat = k.std({ color: HAT, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const bandMat = k.std({ color: BAND, roughness: 0.5, metalness: 0.4 });
  const ironMat = k.std({ color: 0x2a2420, roughness: 0.5, metalness: 0.6 });
  const patchMat = k.std({ color: 0xffffff, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const rune = k.glowMat(1.0);
  const runeLimb = k.glowMat(0.95);
  const stitch = k.glowMat(0.95, 0.7);
  const eyeMat = k.glowMat(1.5, 0.4);
  const lanternGlow = k.glowMat(2.4, 0.35, 0xffb050);
  const flame = k.glowMat(4.0, 0.3, 0xffe0a0);

  // ---------- hat: drooping brim, crooked cone, band with ember stitches ----------
  const hat = new THREE.Group();
  hat.position.copy(H(0.004, 0, 0.452));
  hat.rotation.y = -0.12; // tipped back a little
  k.add(k.a.head, hat);
  const r0 = 0.079, r1 = 0.19;
  const brimZ = (a: number, t: number) => -0.024 * t * t + 0.009 * Math.sin(3 * a + 0.6) * Math.pow(t, 1.5) + 0.012 * Math.max(0, Math.cos(a)) * t * t;
  const brim = surface((u, v, o) => {
    const a = u * Math.PI * 2, r = lerp(r0, r1, v);
    o.set(r * Math.cos(a), r * Math.sin(a), brimZ(a, v));
  }, 48, 6);
  const brimEdge = Array.from({ length: 49 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    return V(r1 * Math.cos(a), r1 * Math.sin(a), brimZ(a, 1));
  });
  const conePts = [V(0, 0, -0.004), V(-0.004, 0, 0.1), V(-0.028, 0, 0.2), V(-0.07, 0, 0.27), V(-0.125, 0, 0.3), V(-0.17, 0, 0.285)];
  const coneR = (u: number) => 0.081 * Math.pow(1 - u, 0.92) * (1 + 0.035 * Math.sin(u * 23)) + 0.0025;
  const cone = sweep(conePts, coneR, 30, 18);
  k.add(hat, k.mesh(merge([brim, sweep(brimEdge, () => 0.004, 96, 5), cone]), hatMat));
  // band + buckle
  const band = zUp(new THREE.CylinderGeometry(0.0805, 0.083, 0.024, 28, 1, true));
  band.translate(0, 0, 0.011);
  const buckle = new THREE.TorusGeometry(0.012, 0.0028, 4, 4);
  buckle.rotateZ(Math.PI / 4);
  basis(buckle, V(0, 1, 0), V(0, 0, 1), V(1, 0, 0), V(0.085, 0, 0.011));
  k.add(hat, k.mesh(merge([band, buckle]), bandMat));

  // ember stitches: dashes around the band, plus a stitched patch on each side of the cone
  const st: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.17;
    if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.25) continue; // buckle
    const d = new THREE.BoxGeometry(0.0022, 0.009, 0.0025);
    d.rotateZ(a);
    d.translate(0.0842 * Math.cos(a), 0.0842 * Math.sin(a), 0.011 + (i % 2 ? 0.004 : -0.004));
    st.push(d);
  }
  const coneCurve = new THREE.CatmullRomCurve3(conePts, false, "centripetal");
  const patches: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const u = s > 0 ? 0.36 : 0.5;
    const c = coneCurve.getPointAt(u), T = coneCurve.getTangentAt(u);
    const n = V(0, s, 0);
    const X = T.clone().cross(n).normalize();
    const q = 0.017;
    const lines: [number, number][][] = [];
    for (const [x0, y0, x1, y1] of [[-q, -q, q, -q], [q, -q, q, q], [q, q, -q, q], [-q, q, -q, -q]]) {
      for (let j = 0; j < 4; j++) {
        const t0 = j / 4 + 0.05, t1 = j / 4 + 0.17;
        lines.push([[lerp(x0, x1, t0), lerp(y0, y1, t0)], [lerp(x0, x1, t1), lerp(y0, y1, t1)]]);
      }
    }
    lines.push([[-0.008, -0.008], [0.008, 0.008]], [[-0.008, 0.008], [0.008, -0.008]]);
    st.push(basis(stroke(lines, 0.0026), X, T, n, c.clone().addScaledVector(n, coneR(u) + 0.0035)));
    patches.push(paint(basis(new THREE.PlaneGeometry(0.036, 0.036), X, T, n, c.clone().addScaledVector(n, coneR(u) + 0.0018)), s > 0 ? 0x8a6a30 : 0x2f5a6a));
  }
  k.add(hat, k.mesh(merge(st), stitch, false));
  k.add(hat, k.mesh(merge(patches), patchMat));

  // lantern on a cord from the curled tip
  const tip = new THREE.Object3D();
  tip.position.copy(conePts[conePts.length - 1]).add(V(-0.004, 0, -0.006));
  hat.add(tip);
  const swing = new THREE.Group();
  tip.add(swing);
  const cordLen = 0.055;
  const cord = zUp(new THREE.CylinderGeometry(0.0012, 0.0012, cordLen, 4, 1, true));
  cord.translate(0, 0, -cordLen / 2);
  const hook = new THREE.TorusGeometry(0.006, 0.0014, 4, 10);
  hook.rotateX(Math.PI / 2);
  hook.translate(0, 0, -cordLen - 0.004);
  const capTop = zUp(new THREE.ConeGeometry(0.019, 0.016, 6));
  capTop.translate(0, 0, -cordLen - 0.017);
  const floor = zUp(new THREE.CylinderGeometry(0.018, 0.016, 0.006, 6));
  floor.translate(0, 0, -cordLen - 0.064);
  const bars: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const b = zUp(new THREE.CylinderGeometry(0.0016, 0.0016, 0.04, 4));
    b.translate(0.0158 * Math.cos(a), 0.0158 * Math.sin(a), -cordLen - 0.044);
    bars.push(b);
  }
  k.add(swing, k.mesh(merge([cord, hook, capTop, floor, ...bars]), ironMat, false));
  const glass = zUp(new THREE.CylinderGeometry(0.0145, 0.0145, 0.038, 6));
  glass.translate(0, 0, -cordLen - 0.044);
  k.add(swing, k.mesh(glass, lanternGlow, false));
  const core = new THREE.SphereGeometry(0.0075, 8, 6);
  core.scale(1, 1, 1.5);
  const coreMesh = k.mesh(core, flame, false);
  coreMesh.position.z = -cordLen - 0.046;
  k.add(swing, coreMesh);
  const pendulum = new Pendulum(tip, swing, cordLen + 0.04, 1.4);

  // ---------- eyes ----------
  eyes(k, eyeMat, { w: 0.011, h: 0.0075, slant: -0.25 });

  // ---------- cloak: collar to just above the knee, ragged hem, ember stitches ----------
  const hemZ = -0.4;
  const cloak = new Cloak((u, v, o) => {
    const top = smooth(0, 0.2, v);
    const arc = lerp(5.1, 3.75, top);
    const th = Math.PI + (u - 0.5) * arc;
    const below = clamp((v - 0.2) / 0.8, 0, 1);
    let z = v < 0.2 ? lerp(0.302, 0.21, Math.sin((v / 0.2) * Math.PI * 0.5)) : lerp(0.21, hemZ, below);
    if (below > 0.85) z += 0.05 * ((below - 0.85) / 0.15) * (Math.abs(((u * 6.5) % 1) - 0.5) * 2) * (0.6 + 0.6 * hash(Math.floor(u * 6.5))); // ragged hem
    const ax = lerp(0.068, 0.128, top) + 0.06 * below;
    const ay = lerp(0.084, 0.218, top) + 0.045 * below;
    const cx = -0.008 - 0.022 * top - 0.06 * below * below;
    o.set(cx + ax * Math.cos(th), ay * Math.sin(th), z);
  }, { nu: 18, nv: 14, pivotV: 0.22, wave: 0.01, drag: 0.22 });
  const emberTex = canvasTex(k, 256, 256, (c, w, h) => {
    c.fillStyle = "#000";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#fff";
    c.lineCap = "round";
    c.lineWidth = 5;
    c.setLineDash([10, 9]);
    for (const x of [0.03, 0.27, 0.5, 0.73, 0.97]) { // dashed seams down the cloak
      c.beginPath();
      c.moveTo(x * w, h * 0.06);
      c.lineTo(x * w + (x - 0.5) * 18, h * 0.86);
      c.stroke();
    }
    c.setLineDash([]);
    c.lineWidth = 4;
    c.beginPath(); // zigzag hem stitch
    for (let i = 0; i <= 32; i++) c.lineTo((i / 32) * w, h * 0.82 + (i % 2 ? 7 : -7));
    c.stroke();
    c.beginPath(); // collar stitch
    for (let i = 0; i <= 24; i++) c.lineTo((i / 24) * w, h * 0.09 + (i % 2 ? 4 : -4));
    c.stroke();
    for (const [px, py] of [[0.38, 0.4], [0.62, 0.6], [0.15, 0.62]]) { // cross-stitched patches
      c.lineWidth = 3;
      c.setLineDash([6, 5]);
      c.strokeRect(px * w - 16, py * h - 16, 32, 32);
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(px * w - 8, py * h - 8); c.lineTo(px * w + 8, py * h + 8);
      c.moveTo(px * w + 8, py * h - 8); c.lineTo(px * w - 8, py * h + 8);
      c.stroke();
    }
    for (let i = 0; i < 70; i++) { // embers smouldering near the hem
      const x = hash(i * 3.1) * w, y = h * (0.6 + 0.4 * Math.pow(hash(i * 7.7), 0.6));
      const g = Math.round(120 + 135 * hash(i * 1.3));
      c.fillStyle = `rgb(${g},${g},${g})`;
      c.beginPath();
      c.arc(x, y, 1.2 + 2.2 * hash(i * 5.9), 0, Math.PI * 2);
      c.fill();
    }
  });
  const clothTex = canvasTex(k, 128, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#e0d8d0");
    g.addColorStop(0.75, "#c8bcb0");
    g.addColorStop(1, "#6a5a50"); // scorched hem
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 9; i++) {
      c.fillStyle = `rgba(0,0,0,${0.06 + 0.06 * hash(i)})`;
      c.fillRect((i / 9) * w, 0, w / 18, h); // folds
    }
    for (const [px, py, col] of [[0.38, 0.4, "#c09050"], [0.62, 0.6, "#5a7a8a"], [0.15, 0.62, "#8a6a30"]] as const) {
      c.fillStyle = col;
      c.fillRect(px * w - 8, py * h - 8, 16, 16);
    }
  });
  const outer = k.glowEmissive(k.std({ color: CLOAK, map: clothTex, emissive: 0xff9a40, emissiveMap: emberTex, roughness: 0.9, side: THREE.FrontSide }), 0.85, 0.6);
  const lining = k.std({ color: LINING, roughness: 0.9, side: THREE.BackSide });
  const holder = k.add(k.a.body("torso_link"), new THREE.Group());
  holder.add(...cloakMeshes(k, cloak, outer, lining));
  // high collar flaring up behind the head
  const collar = surface((u, v, o) => {
    const th = Math.PI + (u - 0.5) * 3.5;
    const r = lerp(0.07, 0.13, Math.pow(v, 1.4));
    const tri = 1 - Math.abs(((u * 5) % 1) * 2 - 1); // five points along the top edge
    o.set(-0.006 + r * Math.cos(th), r * 1.12 * Math.sin(th), 0.296 + v * 0.07 + 0.03 * v * v * tri);
  }, 30, 4);
  holder.add(k.mesh(collar, k.std({ color: CLOAK, roughness: 0.9, side: THREE.DoubleSide })));
  // brooch: an ember gem at the throat
  const brooch = new THREE.OctahedronGeometry(0.012, 0);
  brooch.scale(0.8, 1, 1.3);
  brooch.translate(0.068, 0, 0.292);
  holder.add(k.mesh(brooch, rune, false));

  // ---------- limbs: cloth wraps on the forearms, runes ----------
  const wrap = new THREE.CylinderGeometry(0.04, 0.044, 0.085, 14, 1, true).rotateZ(-Math.PI / 2);
  wrap.translate(0.012, 0.002, -0.005);
  k.own(wrap);
  const wrapMat = k.std({ color: 0x5a2a22, roughness: 0.95, side: THREE.DoubleSide });
  for (const fa of [k.a.leftForearm, k.a.rightForearm]) {
    const m = new THREE.Mesh(wrap, wrapMat);
    m.castShadow = true;
    k.add(fa, m);
  }
  limbRunes(k, { glyph: "flame", ringMat: runeLimb, forearmR: 0.046, forearmRingX: 0.045, tube: 0.0032, glyphSize: 0.034, forearmGlyphR: 0.0455, rings2: true });
  chestRune(k, "flame", rune, 0.068, undefined, -0.01);

  return (t: number, dt: number) => {
    cloak.update(holder, t, dt, k.energy);
    pendulum.update(dt, k.charging ? 6 : 0);
    // lantern flicker: two noisy sines
    const f = 0.82 + 0.12 * Math.sin(t * 13.7) + 0.08 * Math.sin(t * 31.1 + 1.3) + 0.06 * (hash(Math.floor(t * 20)) - 0.5);
    k.setExtra(lanternGlow, f);
    k.setExtra(flame, f * 1.05);
    coreMesh.scale.set(1, 1, 0.85 + 0.25 * f);
    k.setExtra(outer, 0.75 + 0.2 * Math.sin(t * 2.1) + 0.1 * Math.sin(t * 5.3 + 2)); // embers breathe
    k.setExtra(stitch, 0.85 + 0.15 * Math.sin(t * 3.3 + 1));
  };
}
