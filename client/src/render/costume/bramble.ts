// Sir Bramble, the Thorn Knight: mossy iron helm with a crest of hooked thorns, iron pauldrons wrapped in briar
// roses, vambraces and greaves, rose-pink runes.
import * as THREE from "three";
import type { Kit } from "./kit";
import { V, aim, clamp, curvePoint, leafShape, merge, mossify, paint, rose, shapeGeo, surface, sweep, thornsAlong } from "./geom";
import { SIDES, basis, chestRune, limbRunes } from "./parts";

const IRON = 0x878e84, MOSS = 0x6f9636, VINE = 0x3a5a22, THORN = 0x6e3a22, LEAF = 0x4f8f30;
// torso-frame point -> head anchor frame (head anchor sits at torso (0.008, 0, 0.384))
const H = (x: number, y: number, z: number) => V(x - 0.008, y, z - 0.384);

/** A rose-thorn: wide base, hooked tip. `n` = out of the surface, `b` = the way it hooks. */
function hookedThorn(base: THREE.Vector3, n: THREE.Vector3, b: THREE.Vector3, len: number, rad: number): THREE.BufferGeometry {
  const p = (out: number, back: number) => base.clone().addScaledVector(n, out * len).addScaledVector(b, back * len);
  return sweep([p(-0.08, 0), p(0.5, 0.12), p(0.85, 0.42), p(0.92, 0.78)], (u) => rad * Math.pow(1 - u, 1.5) + 0.0006, 10, 7);
}

function leafAt(at: THREE.Vector3, dir: THREE.Vector3, nrm: THREE.Vector3, len = 0.032, w = 0.011): THREE.BufferGeometry {
  const d = dir.clone().projectOnPlane(nrm).normalize();
  return paint(basis(shapeGeo(leafShape(len, w, len * 0.1)), d.clone().cross(nrm).normalize(), d, nrm, at), LEAF);
}

export function bramble(k: Kit) {
  const iron = k.std({ color: 0xffffff, vertexColors: true, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide });
  const plant = k.std({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.7, side: THREE.DoubleSide });
  const roseMat = k.glowEmissive(k.std({ color: 0xd01a46, roughness: 0.45, emissive: 0xff3d6a }), 0.3, 0.6);
  const rune = k.glowMat(1.0);
  const runeLimb = k.glowMat(0.95);
  const slit = k.glowMat(1.35, 0.6);

  // ---------- helm: a barrel helm with a beaked visor ----------
  // profile (radius, torso z) from the rim up to the crown; the surface is this lathe, 12% deeper front-to-back,
  // with the lower front pushed out into a beak
  const prof: [number, number][] = [[0.074, 0.318], [0.077, 0.335], [0.08, 0.38], [0.081, 0.42], [0.078, 0.452], [0.069, 0.478], [0.052, 0.498], [0.03, 0.508], [0, 0.512]];
  const profAt = (v: number): [number, number] => {
    const f = clamp(v, 0, 1) * (prof.length - 1), i = Math.min(prof.length - 2, Math.floor(f)), t = f - i;
    return [prof[i][0] + (prof[i + 1][0] - prof[i][0]) * t, prof[i][1] + (prof[i + 1][1] - prof[i][1]) * t];
  };
  const vAtZ = (z: number) => {
    for (let i = 0; i + 1 < prof.length; i++) if (z <= prof[i + 1][1]) return (i + (z - prof[i][1]) / (prof[i + 1][1] - prof[i][1])) / (prof.length - 1);
    return 1;
  };
  const helmPt = (th: number, v: number, lift = 0, out = new THREE.Vector3()) => {
    const [r0, z] = profAt(v);
    const r = r0 + lift;
    let x = r * Math.cos(th) * 1.12;
    const y = r * Math.sin(th);
    const front = Math.max(0, Math.cos(th));
    x += Math.exp(-(((z - 0.358) / 0.034) ** 2)) * Math.pow(front, 12) * 0.036; // beak
    x += Math.pow(front, 40) * 0.004 * (z < 0.47 ? 1 : 0); // keel down the face
    return out.set(x + 0.01 - 0.008, y, z - 0.384); // head anchor frame
  };
  const helmGeo = surface((u, v, o) => helmPt(Math.PI - u * Math.PI * 2, v, 0, o), 40, 18);
  mossify(helmGeo, IRON, MOSS, 1, 0.12);
  k.add(k.a.head, k.mesh(helmGeo, iron));

  // eye slit: a glowing band wrapping the front, a brow ridge above it, a rolled rim, breaths on the beak
  const band = (z: number, half: number, lift: number) => Array.from({ length: 25 }, (_, i) => helmPt(-half + (2 * half * i) / 24, vAtZ(z), lift));
  k.add(k.a.head, k.mesh(sweep(band(0.405, 0.92, 0.0015), () => 0.0048, 40, 6), slit, false));
  const helmBits: THREE.BufferGeometry[] = [mossify(merge([
    sweep(band(0.42, 1.3, 0.002), () => 0.006, 40, 6),
    sweep(band(0.326, 3.14, 0.002), () => 0.006, 60, 6),
  ]), IRON, MOSS, 0.5)];
  for (const s of [-1, 1]) for (const dz of [0, 1, 2]) {
    const b = new THREE.BoxGeometry(0.004, 0.011, 0.003);
    const th = s * (0.28 + dz * 0.06);
    const at = helmPt(th, vAtZ(0.376 - dz * 0.013), 0.0004);
    b.rotateZ(th);
    b.translate(at.x, at.y, at.z);
    helmBits.push(paint(b, 0x0a0a0a));
  }
  k.add(k.a.head, k.mesh(merge(helmBits), iron));

  // crest: a briar vine along the top of the helm with big hooked thorns standing out of it, leaves and roses
  const ridgeAt = (a: number, lift: number) => H(0.012 - (0.081 + lift) * 1.1 * Math.sin(a), 0, 0.43 + (0.081 + lift) * Math.cos(a));
  const crestParts: THREE.BufferGeometry[] = [];
  const ridge = Array.from({ length: 13 }, (_, i) => ridgeAt(-0.75 + (i / 12) * 2.15, 0.004));
  crestParts.push(paint(sweep(ridge, (u) => 0.0075 - 0.002 * u, 40, 7), VINE));
  const twist = Array.from({ length: 25 }, (_, i) => {
    const s = i / 24, a = -0.7 + s * 2.05;
    return ridgeAt(a, 0.005 + 0.004 * Math.cos(s * Math.PI * 7)).add(V(0, 0.009 * Math.sin(s * Math.PI * 7), 0));
  });
  crestParts.push(paint(sweep(twist, () => 0.0032, 60, 5), VINE));
  const thornA = [-0.5, -0.12, 0.26, 0.64, 1.0];
  const thornL = [0.05, 0.072, 0.082, 0.07, 0.048];
  thornA.forEach((a, i) => {
    const base = ridgeAt(a, 0.006);
    const n = V(-Math.sin(a) * 1.1, 0, Math.cos(a)).normalize();
    const b = V(-Math.cos(a) * 1.1, 0, -Math.sin(a)).normalize();
    crestParts.push(paint(hookedThorn(base, n, b, thornL[i], 0.016), THORN));
  });
  for (const t of thornsAlong(ridge, 9, 0.014, 0.003, 3)) crestParts.push(paint(t, THORN));
  for (const [a, s, ang] of [[-0.35, 1, 0.6], [0.45, -1, -0.5], [0.85, 1, 2.6], [0.1, -1, 2.2]] as const) {
    const at = ridgeAt(a, 0.003).add(V(0, s * 0.016, 0));
    const nrm = V(-Math.sin(a) * 0.6, s * 0.8, Math.cos(a) * 0.6).normalize();
    crestParts.push(leafAt(at, V(Math.cos(ang), 0, Math.sin(ang)), nrm, 0.034, 0.012));
  }
  k.add(k.a.head, k.mesh(merge(crestParts), plant));
  const roses: THREE.BufferGeometry[] = [];
  for (const [a, s, sz] of [[-0.62, 1, 0.04], [0.05, -1, 0.036], [0.95, 1, 0.034], [-0.62, -1, 0.032]] as const) {
    const nrm = V(-Math.sin(a) * 0.7, s * 0.75, Math.cos(a) * 0.6).normalize();
    roses.push(aim(rose(sz), ridgeAt(a, 0.0).addScaledVector(nrm, 0.012), nrm, a * 3));
  }
  k.add(k.a.head, k.mesh(merge(roses), roseMat));

  // ---------- pauldrons (built for the left shoulder, mirrored for the right) ----------
  // level frame: the shoulder_pitch link is rolled ~16 deg; the group undoes that. Origin = shoulder anchor.
  const c = V(0, -0.012, -0.026);
  const rx = 0.088, ry = 0.08, rz = 0.074;
  const thetaMax = (phi: number) => 1.0 + 0.85 * (0.5 + 0.5 * Math.cos(phi));
  const domePt = (phi: number, th: number, grow = 1, out = new THREE.Vector3()) =>
    out.set(c.x + rx * grow * Math.sin(th) * Math.sin(phi), c.y + ry * grow * Math.sin(th) * Math.cos(phi), c.z + rz * grow * Math.cos(th));
  const domeN = (phi: number, th: number) => domePt(phi, th).sub(c).normalize();
  const plateParts: THREE.BufferGeometry[] = [surface((u, v, o) => {
    const phi = Math.PI - u * Math.PI * 2;
    domePt(phi, v * thetaMax(phi), 1, o);
  }, 32, 10)];
  const rimPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const phi = Math.PI - (i / 40) * Math.PI * 2;
    rimPts.push(domePt(phi, thetaMax(phi), 1.015));
  }
  plateParts.push(sweep(rimPts, () => 0.0048, 80, 6));
  const lame = surface((u, v, o) => {
    const phi = 1.25 - u * 2.5;
    domePt(phi, thetaMax(phi) - 0.12 + v * 0.38, 1.1, o);
    o.z -= 0.012;
  }, 20, 4);
  plateParts.push(lame);
  const lameRim: THREE.Vector3[] = [];
  for (let i = 0; i <= 20; i++) {
    const phi = 1.25 - (i / 20) * 2.5;
    lameRim.push(domePt(phi, thetaMax(phi) + 0.27, 1.12).add(V(0, 0, -0.012)));
  }
  plateParts.push(sweep(lameRim, () => 0.0042, 30, 5));
  const rib: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) rib.push(domePt(0, (i / 10) * 1.75, 1.02));
  plateParts.push(sweep(rib, () => 0.0045, 20, 5));
  const plateGeo = mossify(merge(plateParts), IRON, MOSS, 1, 0.15);

  // briar vine spiralling over the dome (staying on it), thorns, leaves, roses on top and outside
  const pv: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const s = i / 16, phi = -2.4 + 4.4 * s;
    pv.push(domePt(phi, Math.min(0.3 + 1.2 * s, thetaMax(phi) - 0.18), 1.07));
  }
  const pParts: THREE.BufferGeometry[] = [paint(sweep(pv, () => 0.0055, 50, 6), VINE)];
  for (const t of thornsAlong(pv, 12, 0.013, 0.003, 7)) pParts.push(paint(t, THORN));
  for (const [phi, th, ang] of [[0.95, 0.8, 0.5], [-1.0, 1.1, 2.2], [0.25, 1.35, -0.6], [-2.0, 0.55, 1.4], [1.7, 1.0, 2.8]] as const) {
    pParts.push(leafAt(domePt(phi, th, 1.09), V(Math.cos(ang), 0.3, Math.sin(ang)), domeN(phi, th)));
  }
  const roseGeo = merge([
    aim(rose(0.046), domePt(0.3, 0.75, 1.13), domeN(0.3, 0.75), 0.7),
    aim(rose(0.034), domePt(-1.9, 0.6, 1.12), domeN(-1.9, 0.6), 2.1),
    aim(rose(0.03), domePt(1.4, 1.2, 1.12), domeN(1.4, 1.2), 1.2),
  ]);
  const vineGeo = merge(pParts);
  k.own(plateGeo); k.own(vineGeo); k.own(roseGeo);
  for (const side of SIDES) {
    const g = new THREE.Group();
    const roll = 0.2795;
    g.rotation.x = side === "left" ? -roll : roll;
    if (side === "right") g.scale.y = -1;
    const pm = new THREE.Mesh(plateGeo, iron);
    pm.castShadow = pm.receiveShadow = true;
    const vm = new THREE.Mesh(vineGeo, plant);
    vm.castShadow = true;
    g.add(pm, vm, new THREE.Mesh(roseGeo, roseMat));
    k.add(side === "left" ? k.a.leftShoulder : k.a.rightShoulder, g);
  }

  // ---------- vambraces and greaves ----------
  const vamb = new THREE.CylinderGeometry(0.041, 0.046, 0.1, 18, 1, true).rotateZ(-Math.PI / 2);
  const cuff = new THREE.TorusGeometry(0.047, 0.0055, 6, 24).rotateY(Math.PI / 2);
  cuff.translate(-0.05, 0, 0);
  const vambGeo = mossify(merge([vamb, cuff]), IRON, MOSS, 0.6);
  vambGeo.translate(0.016, 0.002, -0.005);
  k.own(vambGeo);
  for (const fa of [k.a.leftForearm, k.a.rightForearm]) {
    const m = new THREE.Mesh(vambGeo, iron);
    m.castShadow = true;
    k.add(fa, m);
  }
  // greave: a front shell over the shin, plus a knee cop (shin anchor = knee link (0.02, 0, -0.15))
  const greave = surface((u, v, o) => {
    const psi = -1.95 + 3.9 * u;
    const z = -0.04 - 0.23 * v;
    const rxs = 0.058 - 0.017 * v, rys = 0.047 - 0.014 * v;
    o.set(0.012 + rxs * Math.cos(psi) + 0.005 * Math.cos(psi) ** 12 - 0.02, rys * Math.sin(psi), z + 0.15);
  }, 18, 8);
  const knee = surface((u, v, o) => {
    const th = v * 1.25, ph = u * Math.PI * 2;
    o.set(0.06 + 0.036 * Math.cos(th) - 0.02, 0.042 * Math.sin(th) * Math.cos(ph), -0.005 + 0.04 * Math.sin(th) * Math.sin(ph) + 0.15);
  }, 16, 6);
  const greaveGeo = mossify(merge([greave, knee]), IRON, MOSS, 0.8);
  k.own(greaveGeo);
  for (const sh of [k.a.leftShin, k.a.rightShin]) {
    const m = new THREE.Mesh(greaveGeo, iron);
    m.castShadow = true;
    k.add(sh, m);
  }

  // ---------- sword belt and tassets: layered plates on each thigh (hip_yaw link, so they move with the leg) ----------
  const belt = new THREE.TorusGeometry(1, 0.11, 6, 40);
  belt.scale(0.069, 0.077, 0.12);
  belt.translate(0, 0, -0.024);
  const buckle = new THREE.BoxGeometry(0.012, 0.03, 0.026);
  buckle.translate(0.071, 0, -0.024);
  const tongue = new THREE.BoxGeometry(0.01, 0.022, 0.05);
  tongue.rotateX(0.12);
  tongue.translate(0.066, -0.028, -0.052);
  k.add(k.a.pelvis, k.mesh(merge([paint(belt, 0x3a2416), paint(buckle, 0xb08a3a), paint(tongue, 0x3a2416)]), plant));
  const lames: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const top = 0.085 - i * 0.055, bot = top - 0.068, r0 = 0.067 - i * 0.002;
    lames.push(surface((u, v, o) => {
      const psi = -1.75 + 3.5 * u;
      const r = r0 + 0.007 * v;
      o.set(-0.002 + r * 1.05 * Math.cos(psi), r * Math.sin(psi), top + (bot - top) * v);
    }, 16, 3));
    const edge = Array.from({ length: 17 }, (_, j) => {
      const psi = -1.75 + (3.5 * j) / 16, r = r0 + 0.008;
      return V(-0.002 + r * 1.05 * Math.cos(psi), r * Math.sin(psi), bot);
    });
    lames.push(sweep(edge, () => 0.0035, 24, 5));
  }
  const tassetGeo = k.own(mossify(merge(lames), IRON, MOSS, 1, 0.1));
  for (const leg of ["left_hip_yaw_link", "right_hip_yaw_link"]) {
    const m = new THREE.Mesh(tassetGeo, iron);
    m.castShadow = true;
    k.add(k.a.body(leg), m);
  }

  limbRunes(k, { glyph: "rose", ringMat: runeLimb, forearmR: 0.0475, forearmRingX: 0.05, shinR: [0.063, 0.05], shinRingZ: 0.088, forearmGlyphR: 0.0475, shinGlyphY: 0.0425, shinGlyphZ: 0.0, tube: 0.0032, glyphSize: 0.034 });

  // ---------- chest: rose medallion and a briar sash across the torso ----------
  chestRune(k, "rose", rune, 0.072, rune, 0.005);
  const sash = [V(0.055, 0.097, 0.275), V(0.086, 0.04, 0.2), V(0.088, -0.01, 0.13), V(0.077, -0.07, 0.05), V(0.04, -0.103, 0.0), V(-0.03, -0.098, 0.02), V(-0.072, -0.04, 0.1), V(-0.078, 0.04, 0.2), V(-0.05, 0.097, 0.27), V(0.0, 0.114, 0.295), V(0.055, 0.097, 0.275)]
    .map((p) => p.sub(V(0.086, 0, 0.2)));
  const sashParts: THREE.BufferGeometry[] = [paint(sweep(sash, () => 0.006, 70, 6), VINE)];
  for (const t of thornsAlong(sash, 18, 0.013, 0.003, 11)) sashParts.push(paint(t, THORN));
  for (const u of [0.18, 0.3, 0.52, 0.62, 0.85]) {
    const at = curvePoint(sash, u);
    const nrm = V(at.x + 0.086 > 0 ? 1 : -1, 0, 0.3).normalize();
    sashParts.push(leafAt(at.addScaledVector(nrm, 0.005), V(0, Math.sin(u * 20), 1), nrm));
  }
  k.add(k.a.chest, k.mesh(merge(sashParts), plant));
  const sashRose = aim(rose(0.04), curvePoint(sash, 0.07).add(V(0.009, 0, 0)), V(1, 0.5, 0.3).normalize(), 0.3);
  const backRose = aim(rose(0.036), curvePoint(sash, 0.7).add(V(-0.009, 0, 0)), V(-1, 0.2, 0.2).normalize(), 1.1);
  k.add(k.a.chest, k.mesh(merge([sashRose, backRose]), roseMat));
}
