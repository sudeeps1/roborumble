// Debug only (`?fakecards` in the viewer URL): a few alpha strand cards laid over the ponytail and the back
// of the head, material "hair_card", with UVs, a strand-alpha texture and `_flow`, skinned by copying the
// nearest hair vertex's weights. Lets the hair_card path (A2C/alphaTest, Kajiya-Kay, AO exclusion, shadows)
// be tested before the real cards ship in elf.glb. Never runs unless the flag is in the URL.
import * as THREE from "three";

let tex: THREE.Texture | null = null;
function strandTexture() {
  if (tex) return tex;
  const W = 64, H = 256;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = 4 + rnd() * (W - 8), w = 0.8 + rnd() * 1.6, len = H * (0.6 + 0.4 * rnd());
    const grd = g.createLinearGradient(0, 0, 0, len);
    const l = 200 + Math.floor(rnd() * 55);
    grd.addColorStop(0, `rgba(${l},${l},${l + 8},1)`);
    grd.addColorStop(0.8, `rgba(${l},${l},${l + 8},0.9)`);
    grd.addColorStop(1, `rgba(${l},${l},${l + 8},0)`);
    g.strokeStyle = grd;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (rnd() - 0.5) * 6, len * 0.3, x + (rnd() - 0.5) * 8, len * 0.7, x + (rnd() - 0.5) * 10, len);
    g.stroke();
  }
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Adds a "hair_card" SkinnedMesh to `scene` (glTF space) if the asset has none. */
export function addDebugCards(scene: THREE.Object3D) {
  let has = false;
  let src: THREE.SkinnedMesh | null = null;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some((x) => x.name === "hair_card")) has = true;
    if (/pony/i.test(m.name) && !src) src = m;
  });
  if (has || !src) return;
  const pony = src as THREE.SkinnedMesh;
  const g0 = pony.geometry;
  const P = g0.getAttribute("position"), N = g0.getAttribute("normal");
  const SI = g0.getAttribute("skinIndex"), SW = g0.getAttribute("skinWeight");
  const tie = new THREE.Vector3(-0.075, 1.33, 0);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], flow: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3();
  const nearest = (v: THREE.Vector3) => {
    let best = 0, bd = 1e9;
    for (let i = 0; i < P.count; i += 3) {
      const dx = P.getX(i) - v.x, dy = P.getY(i) - v.y, dz = P.getZ(i) - v.z;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  };
  const SEG = 5;
  for (let k = 0; k < 70; k++) {
    const i0 = Math.floor(rnd() * P.count);
    p.fromBufferAttribute(P, i0);
    n.fromBufferAttribute(N, i0);
    d.copy(p).sub(tie).normalize().lerp(new THREE.Vector3(0, -1, 0), 0.5);
    d.addScaledVector(n, -d.dot(n)).normalize();
    b.crossVectors(n, d).normalize();
    const len = 0.05 + rnd() * 0.06, w = 0.006 + rnd() * 0.004;
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      for (const side of [-1, 1]) {
        q.copy(p).addScaledVector(d, t * len).addScaledVector(b, side * w * (1 - 0.5 * t)).addScaledVector(n, 0.0025 + 0.002 * t);
        pos.push(q.x, q.y, q.z);
        nrm.push(n.x, n.y, n.z);
        uv.push(side < 0 ? 0 : 1, t);
        flow.push(d.x, d.y, d.z);
        const j = nearest(q);
        si.push(SI.getX(j), SI.getY(j), SI.getZ(j), SI.getW(j));
        sw.push(SW.getX(j), SW.getY(j), SW.getZ(j), SW.getW(j));
      }
      if (s < SEG) {
        const a = base + s * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("_flow", new THREE.Float32BufferAttribute(flow, 3));
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({ name: "hair_card", map: strandTexture(), alphaTest: 0.4, side: THREE.DoubleSide });
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = "HairCards_debug";
  pony.parent!.add(mesh);
  mesh.bind(pony.skeleton, pony.bindMatrix);
  console.info(`[debugcards] added ${70} debug hair cards`);
}
