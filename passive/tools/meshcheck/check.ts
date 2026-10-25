// Character mesh check: poses every everyday clip (poses.json: G1 body poses per frame from MuJoCo
// FK, tools/meshcheck/fkposes.py) on a character's skinned mesh and measures, per frame:
//   armIn   deepest arm vertex inside the body (torso, waist, head), cm; inside = behind the nearest
//           body triangle, with that triangle's normal turned to face away from the body's axis
//   armNear arm vertices within 1 cm of the body surface (touching or through)
//   legIn   deepest left-leg vertex inside the right leg (and the other way), cm
//   floor   lowest vertex below the floor, cm (feet through the ground)
// ?char=elf: measure every clip, result in window.__result. ?char=elf&clip=X&frame=N: draw that frame.
import * as THREE from "three";
import { CharacterView } from "@elf/character.ts";
import elf from "@elf-assets/elf.glb?url";
import knight from "@elf-assets/knight.glb?url";
import sorceress from "@elf-assets/sorceress.glb?url";
import wizard from "@elf-assets/wizard.glb?url";
import frog from "@elf-assets/frog.glb?url";

const URLS: Record<string, string> = { elf, knight, sorceress, wizard, frog };
const q = new URLSearchParams(location.search);
const who = q.get("char") ?? "elf";
const data = await (await fetch("./poses.json")).json() as { bodies: string[]; clips: Record<string, { motion: string; frames: number[][] }> };
const c = await CharacterView.load(URLS[who]);
const bodiesAt = (f: number[]) => data.bodies.map((name, i) => ({ name, pos: f.slice(7 * i, 7 * i + 3), quat: f.slice(7 * i + 3, 7 * i + 7) }));
const ARM = /^(left|right)_(shoulder_(roll|yaw)|elbow|wrist_(roll|pitch|yaw))_link$/;
const BODY = /^(torso_link|waist_(yaw|roll)_link|pelvis)$/;
const LEG = /^(left|right)_(hip_(pitch|roll|yaw)|knee|ankle_(pitch|roll))_link$/;

interface Part { pts: THREE.Vector3[]; side: string }
function skinned() {
  c.root.updateMatrixWorld(true);
  const arm: THREE.Vector3[] = [], body: THREE.Triangle[] = [], legs: Record<string, { pts: THREE.Vector3[]; tris: THREE.Triangle[] }> = { left: { pts: [], tris: [] }, right: { pts: [], tris: [] } };
  let floor = Infinity;
  c.root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.visible) return;
    const g = m.geometry, si = g.getAttribute("skinIndex"), sw = g.getAttribute("skinWeight");
    if (!si || !sw) return;
    m.skeleton.update();
    const names: string[] = [];
    const bone = (k: number) => { let b = 0, w = -1; for (let j = 0; j < 4; j++) if (sw.getComponent(k, j) > w) { w = sw.getComponent(k, j); b = si.getComponent(k, j); } return m.skeleton.bones[b]?.name ?? ""; };
    const at: THREE.Vector3[] = [];
    for (let k = 0; k < si.count; k++) {
      names[k] = bone(k);
      const p = m.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(m.matrixWorld);
      at[k] = p;
      if (p.z < floor) floor = p.z;
      if (ARM.test(names[k])) arm.push(p);
      const lg = LEG.exec(names[k]);
      if (lg) legs[lg[1]].pts.push(p);
    }
    const idx = g.index, n = (idx ? idx.count : si.count) / 3;
    for (let t = 0; t < n; t++) {
      const a = idx ? idx.getX(3 * t) : 3 * t, b = idx ? idx.getX(3 * t + 1) : 3 * t + 1, d = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
      if (BODY.test(names[a]) && BODY.test(names[b]) && BODY.test(names[d])) body.push(new THREE.Triangle(at[a], at[b], at[d]));
      for (const s of ["left", "right"]) { const re = new RegExp(`^${s}_(hip_(pitch|roll|yaw)|knee|ankle_(pitch|roll))_link$`); if (re.test(names[a]) && re.test(names[b]) && re.test(names[d])) legs[s].tris.push(new THREE.Triangle(at[a], at[b], at[d])); }
    }
  });
  return { arm, body, legs, floor };
}

/** Deepest point (cm) of `pts` behind `tris` (normals turned away from the axis a->b), and how many are within 1 cm. */
function depth(pts: THREE.Vector3[], tris: THREE.Triangle[], a: THREE.Vector3, b: THREE.Vector3) {
  const cell = 0.04, grid = new Map<string, THREE.Triangle[]>(), key = (x: number, y: number, z: number) => `${x},${y},${z}`, box = new THREE.Box3();
  for (const t of tris) {
    box.makeEmpty().expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
    for (let x = Math.floor(box.min.x / cell); x <= Math.floor(box.max.x / cell); x++)
      for (let y = Math.floor(box.min.y / cell); y <= Math.floor(box.max.y / cell); y++)
        for (let z = Math.floor(box.min.z / cell); z <= Math.floor(box.max.z / cell); z++) (grid.get(key(x, y, z)) ?? grid.set(key(x, y, z), []).get(key(x, y, z))!).push(t);
  }
  const cp = new THREE.Vector3(), nrm = new THREE.Vector3(), ax = new THREE.Line3(a, b), onAx = new THREE.Vector3(), out = new THREE.Vector3();
  let deepest = 0, near = 0;
  for (const p of pts) {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
    let best = Infinity, bestT: THREE.Triangle | null = null, bestP = new THREE.Vector3();
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
      for (const t of grid.get(key(x, y, z)) ?? []) { t.closestPointToPoint(p, cp); const dd = cp.distanceToSquared(p); if (dd < best) { best = dd; bestT = t; bestP.copy(cp); } }
    }
    if (!bestT) continue;
    const dist = Math.sqrt(best);
    if (dist < 0.01) near++;
    bestT.getNormal(nrm);
    ax.closestPointToPoint(bestP, true, onAx);
    if (nrm.dot(out.subVectors(bestP, onAx)) < 0) nrm.negate(); // face away from the body's axis
    const signed = nrm.dot(out.subVectors(p, bestP));
    if (signed < 0 && dist < 0.12) deepest = Math.max(deepest, dist * 100);
  }
  return { deepest, near };
}

const pos = (f: number[], name: string) => { const i = data.bodies.indexOf(name); return new THREE.Vector3(f[7 * i], f[7 * i + 1], f[7 * i + 2]); };
function measure(f: number[]) {
  c.update(bodiesAt(f), 1 / 15);
  const s = skinned();
  const pel = pos(f, "pelvis"), tor = pos(f, "torso_link");
  const up = tor.clone().sub(pel).normalize(), top = tor.clone().addScaledVector(up, 0.45);
  const a = depth(s.arm, s.body, pel, top);
  const legAxis = (side: string) => [pos(f, `${side}_hip_pitch_link`), pos(f, `${side}_ankle_roll_link`)] as const;
  const [rl0, rl1] = legAxis("right"), [ll0, ll1] = legAxis("left");
  const l1 = depth(s.legs.left.pts, s.legs.right.tris, rl0, rl1), l2 = depth(s.legs.right.pts, s.legs.left.tris, ll0, ll1);
  return { armIn: +a.deepest.toFixed(1), armNear: a.near, legIn: +Math.max(l1.deepest, l2.deepest).toFixed(1), floor: +Math.max(0, -s.floor * 100).toFixed(1) };
}

const shotClip = q.get("clip");
if (shotClip) {
  const f = data.clips[shotClip].frames[Number(q.get("frame") ?? 0)];
  for (let k = 0; k < 8; k++) c.update(bodiesAt(f), 1 / 15); // let the hair and cloth springs settle
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(640, 640); document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x30343c);
  const g = new THREE.Group(); g.rotation.x = -Math.PI / 2; g.add(c.root); scene.add(g);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2)); const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(2, 4, 3); scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 0x556070, transparent: true, opacity: 0.6 })); floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const pel = pos(f, "pelvis"), view = q.get("view") ?? "front";
  // MuJoCo (x, y, z) -> three (x, z, -y); the clip faces +X
  const target = new THREE.Vector3(pel.x, Math.max(0.55, pel.z), -pel.y);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
  const dir = view === "side" ? new THREE.Vector3(0.15, 0.1, 1) : new THREE.Vector3(1, 0.15, 0.35);
  cam.position.copy(target).addScaledVector(dir.normalize(), 3.1); cam.lookAt(target);
  renderer.render(scene, cam);
  (window as unknown as { __shot: boolean }).__shot = true;
} else {
  const t0 = performance.now(), out: Record<string, unknown> = {};
  for (const [name, clip] of Object.entries(data.clips)) {
    let worst = { armIn: 0, armNear: 0, legIn: 0, floor: 0 }, at = { armIn: 0, armNear: 0, legIn: 0, floor: 0 };
    clip.frames.forEach((f, i) => {
      const r = measure(f);
      for (const k of Object.keys(worst) as (keyof typeof worst)[]) if (r[k] > worst[k]) { worst[k] = r[k]; at[k] = i; }
    });
    out[name] = { motion: clip.motion, frames: clip.frames.length, worst, at };
  }
  (window as unknown as { __result: unknown }).__result = { char: who, seconds: (performance.now() - t0) / 1000, clips: out };
}
