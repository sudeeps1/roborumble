// Rime, the Winter Stag: a faceted frost-crystal helm with great branching ice antlers, a snowy fur mantle,
// frost-crystal spikes on the shoulders, drifting frost motes, pale blue runes.
import * as THREE from "three";
import type { Kit } from "./kit";
import { hash } from "./kit";
import { V, aim, crystal, merge, surface, sweep, zUp } from "./geom";
import { SIDES, canvasTex, chestRune, eyes, gradientTex, limbRunes } from "./parts";

const H = (x: number, y: number, z: number) => V(x - 0.008, y, z - 0.384);

export function rime(k: Kit) {
  const grad = gradientTex(k, 0.08, 1, 2.2);
  const ice = k.glowEmissive(k.std({ color: 0x8cc4ea, roughness: 0.12, metalness: 0.2, flatShading: true, emissive: k.def.glow, emissiveMap: grad }), 1.05, 0.7);
  const iceHelm = k.glowEmissive(k.std({ color: 0x7aa8d0, roughness: 0.2, metalness: 0.45, flatShading: true, emissive: k.def.glow }), 0.07, 0.6);
  const frost = k.glowEmissive(k.std({ color: 0x9ad0f2, roughness: 0.1, metalness: 0.15, flatShading: true, emissive: k.def.glow, emissiveMap: grad }), 0.95, 0.7);
  const fur = k.std({ color: 0xc9d6e6, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const rune = k.glowMat(1.0);
  const runeLimb = k.glowMat(0.95);
  const eyeMat = k.glowMat(1.6, 0.4);

  // ---------- faceted ice helm ----------
  const prof = [[0.074, 0.405], [0.079, 0.438], [0.072, 0.468], [0.054, 0.492], [0.028, 0.506], [0.0, 0.511]];
  const cap = zUp(new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 11));
  cap.scale(1.1, 1, 1);
  cap.translate(0.01 - 0.008, 0, -0.384);
  k.add(k.a.head, k.mesh(cap, iceHelm));
  // widow's-peak brow point and a ring of small crown shards
  const shards: THREE.BufferGeometry[] = [];
  const brow = crystal(0.011, 0.02, 0.022, 4);
  brow.scale(1, 1.6, 1);
  shards.push(aim(brow, H(0.088, 0, 0.452), V(0.25, 0, -1).normalize()));
  for (let i = 0; i < 9; i++) {
    const a = ((i - 4) / 4) * 2.5; // around the crown, front at 0
    if (Math.abs(Math.abs(a) - 1.5) < 0.3) continue; // leave room for the antlers
    const at = H(0.01 + 0.07 * 1.1 * Math.cos(a), 0.066 * Math.sin(a), 0.468 + 0.012 * Math.cos(a));
    const len = 0.022 + 0.022 * Math.pow(Math.cos(a * 0.5), 4);
    shards.push(aim(crystal(0.0065, len, 0.013, 5), at, V(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 1).normalize(), i));
  }
  k.add(k.a.head, k.mesh(merge(shards), frost));
  eyes(k, eyeMat, { w: 0.013, h: 0.007, slant: -0.35 });

  // ---------- antlers: a main beam and four tines each, faceted ice that glows toward the tips ----------
  const antler: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const P = (x: number, y: number, z: number) => H(x, s * y, z);
    const beam = [P(0.0, 0.058, 0.452), P(-0.014, 0.085, 0.51), P(-0.04, 0.122, 0.588), P(-0.058, 0.152, 0.668), P(-0.058, 0.166, 0.748), P(-0.034, 0.172, 0.816)];
    antler.push(sweep(beam, (u) => 0.0135 * (1 - u * 0.72), 22, 6, 0, 1));
    const tine = (pts: THREE.Vector3[], r: number, v0: number) => antler.push(sweep(pts, (u) => r * (1 - u) + 0.0012, 10, 5, v0, 1));
    tine([P(-0.01, 0.08, 0.5), P(0.03, 0.094, 0.522), P(0.068, 0.1, 0.562), P(0.084, 0.102, 0.605)], 0.0085, 0.15);
    tine([P(-0.048, 0.137, 0.628), P(-0.002, 0.15, 0.668), P(0.024, 0.156, 0.725)], 0.0075, 0.5);
    tine([P(-0.06, 0.16, 0.71), P(-0.1, 0.17, 0.75), P(-0.122, 0.176, 0.803)], 0.007, 0.7);
    tine([P(-0.056, 0.168, 0.775), P(-0.082, 0.174, 0.812), P(-0.088, 0.178, 0.85)], 0.0055, 0.85);
    // little crystals budding off the beam
    for (const [u, dx, dz, len] of [[0.3, 0.6, 0.6, 0.026], [0.62, -0.7, 0.4, 0.022], [0.45, 0.2, 0.9, 0.018]] as const) {
      const at = new THREE.CatmullRomCurve3(beam, false, "centripetal").getPointAt(u);
      antler.push(aim(crystal(0.005, len, 0.011, 5), at, V(dx, s * 0.5, dz).normalize(), u * 9));
    }
  }
  k.add(k.a.head, k.mesh(merge(antler), ice));

  // ---------- snowy fur mantle over the shoulders ----------
  const mantle = surface((u, v, o) => {
    const th = Math.PI + (u - 0.5) * (Math.PI * 2 - 0.5);
    const ax = 0.072 + 0.07 * v, ay = 0.09 + 0.11 * v;
    let z = 0.318 - 0.045 * v - 0.16 * Math.pow(Math.max(0, v - 0.6), 1.2);
    if (v > 0.8) z -= 0.014 * ((v - 0.8) / 0.2) * (Math.abs(((u * 17) % 1) - 0.5) * 2) * (0.6 + 0.8 * hash(Math.floor(u * 17)));
    const bump = 1 + 0.05 * Math.sin(u * 61) * Math.sin(v * 9 + u * 13) + 0.02 * Math.sin(u * 137 + v * 3);
    o.set(-0.006 + ax * bump * Math.cos(th), ay * bump * Math.sin(th), z);
  }, 40, 6);
  // fur tufts along the lower edge
  const tufts: THREE.BufferGeometry[] = [mantle];
  for (let i = 0; i < 34; i++) {
    const u = (i + 0.5 * hash(i * 2.3)) / 34;
    const th = Math.PI + (u - 0.5) * (Math.PI * 2 - 0.5);
    const at = V(-0.006 + 0.138 * Math.cos(th), 0.196 * Math.sin(th), 0.222 + 0.01 * hash(i * 5.1));
    const out = V(Math.cos(th), Math.sin(th) * 1.3, 0).normalize();
    const len = 0.03 + 0.022 * hash(i * 7.7);
    const tf = zUp(new THREE.ConeGeometry(0.013, len, 5));
    tf.translate(0, 0, len / 2);
    tufts.push(aim(tf, at, out.multiplyScalar(0.45).add(V(0, 0, -1)).normalize(), i));
  }
  const mantleMesh = k.mesh(merge(tufts), fur);
  k.add(k.a.body("torso_link"), mantleMesh);

  // ---------- frost-crystal spikes on the shoulders (left built, right mirrored) ----------
  const spikes: THREE.BufferGeometry[] = [];
  const base = new THREE.SphereGeometry(0.048, 7, 4, 0, Math.PI * 2, 0, 1.25);
  base.rotateX(Math.PI / 2);
  base.scale(1.05, 1, 0.75);
  base.translate(0, -0.006, -0.012);
  spikes.push(base);
  for (const [dx, dy, dz, len, r] of [[0.0, 0.55, 1, 0.13, 0.014], [0.15, 1, 0.45, 0.085, 0.011], [-0.55, 0.35, 1, 0.105, 0.012], [0.45, 0.4, 0.9, 0.07, 0.01], [0.05, 1, -0.1, 0.05, 0.008], [-0.3, 0.85, 0.35, 0.06, 0.009]] as const) {
    const dir = V(dx, dy, dz).normalize();
    spikes.push(aim(crystal(r, len, r * 2.4, 6), V(0, 0.012, 0.012).addScaledVector(dir, 0.02), dir, len * 40));
  }
  const spikeGeo = k.own(merge(spikes));
  for (const side of SIDES) {
    const g = new THREE.Group();
    g.rotation.x = side === "left" ? -0.2795 : 0.2795;
    if (side === "right") g.scale.y = -1;
    const m = new THREE.Mesh(spikeGeo, frost);
    m.castShadow = true;
    g.add(m);
    k.add(side === "left" ? k.a.leftShoulder : k.a.rightShoulder, g);
  }

  // ---------- crystal cuffs, runes ----------
  const cuff = new THREE.CylinderGeometry(0.041, 0.046, 0.07, 6, 1, true).rotateZ(-Math.PI / 2);
  cuff.translate(0.022, 0.002, -0.005);
  k.own(cuff);
  for (const fa of [k.a.leftForearm, k.a.rightForearm]) k.add(fa, new THREE.Mesh(cuff, iceHelm));
  limbRunes(k, { glyph: "snowflake", ringMat: runeLimb, forearmR: 0.049, forearmRingX: 0.062, tube: 0.0032, glyphSize: 0.036, forearmGlyphR: 0.05 });
  chestRune(k, "snowflake", rune, 0.072, frost, -0.004);

  // ---------- frost motes drifting up around the antlers (one Points, fixed buffer) ----------
  const N = 18;
  const motePos = new Float32Array(N * 3), moteCol = new Float32Array(N * 3);
  const seeds = Array.from({ length: N }, (_, i) => [hash(i * 1.7), hash(i * 3.3), hash(i * 5.1), hash(i * 7.9)]);
  const moteGeo = k.own(new THREE.BufferGeometry());
  const moteAttr = new THREE.BufferAttribute(motePos, 3);
  moteAttr.setUsage(THREE.DynamicDrawUsage);
  moteGeo.setAttribute("position", moteAttr);
  const moteColAttr = new THREE.BufferAttribute(moteCol, 3);
  moteColAttr.setUsage(THREE.DynamicDrawUsage);
  moteGeo.setAttribute("color", moteColAttr);
  const sprite = canvasTex(k, 32, 32, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const moteMat = k.glowColored(new THREE.PointsMaterial({ size: 0.014, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }), 1.6, 0.6, 0xd8f6ff);
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  k.add(k.a.head, motes);

  return (t: number) => {
    for (let i = 0; i < N; i++) {
      const sd = seeds[i], a = sd[0], b = sd[1], c = sd[2], d = sd[3];
      const life = (t * (0.12 + 0.1 * a) + d) % 1;
      const ang = b * Math.PI * 2 + t * 0.4 * (c - 0.5);
      const r = 0.06 + 0.13 * c;
      motePos[i * 3] = -0.03 + r * Math.cos(ang) * 0.7;
      motePos[i * 3 + 1] = r * Math.sin(ang) * 1.3;
      motePos[i * 3 + 2] = -0.05 + life * 0.5;
      const fadeInOut = Math.sin(life * Math.PI) ** 2; // fade in, drift up, fade out
      moteCol[i * 3] = moteCol[i * 3 + 1] = moteCol[i * 3 + 2] = fadeInOut;
    }
    moteAttr.needsUpdate = true;
    moteColAttr.needsUpdate = true;
    k.setExtra(ice, 0.9 + 0.1 * Math.sin(t * 1.7));
  };
}
