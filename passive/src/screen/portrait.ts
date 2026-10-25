// Character icons for the HUD, rendered from the real models at load: head and shoulders in the guard,
// turned three-quarters toward the side the plate faces, under a key and a team-coloured rim light.
import { CharacterView } from "@elf/character.ts";
import { G1FK, qaxis, qmul, qrot } from "@elf/fk.ts";
import { makeStudioEnvironment } from "@elf/studio.ts";
import * as THREE from "three";

/** A transparent PNG data URL. side: which way the character looks ("right" for the left plate). */
export async function portrait(url: string, hue: number, side: "left" | "right", rim: number, size = 384): Promise<string> {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(size, size);
  r.setClearColor(0x000000, 0);
  r.toneMapping = THREE.AgXToneMapping;
  r.toneMappingExposure = 1.25;
  const dark = /knight/.test(url); // dark plate armour: give it more light so the icon reads at a glance
  const scene = new THREE.Scene();
  scene.environment = makeStudioEnvironment(r);
  scene.environmentIntensity = 0.6;
  scene.environmentRotation.set(Math.PI / 2, 0, 0);
  const c = await CharacterView.load(url, { hue, castShadow: false });
  scene.add(c.root);
  // the guard from the idle clip, facing the camera (which looks along +Y), turned 35° to the side
  try {
    const clip = await (await fetch("/clips-kimodo/idle_fighting.json")).json() as { qpos: number[][] };
    const yaw = -Math.PI / 2 + (side === "right" ? 0.6 : -0.6);
    const fk = new G1FK();
    for (let f = 6; f <= 30; f++) {
      const row = clip.qpos[f], r0 = clip.qpos[0];
      const yaw0 = Math.atan2(2 * (r0[3] * r0[6] + r0[4] * r0[5]), 1 - 2 * (r0[5] ** 2 + r0[6] ** 2));
      const turn = qaxis([0, 0, 1], yaw - yaw0);
      const p = qrot(turn, [row[0] - r0[0], row[1] - r0[1], 0]);
      c.update(fk.compute(row.slice(7, 36), [p[0], p[1], row[2]], qmul(turn, [row[3], row[4], row[5], row[6]])), 1 / 30);
    }
  } catch { /* no clip: bind pose */ }
  const hp = new THREE.Vector3().setFromMatrixPosition(c.boneMatrix("head") ?? new THREE.Matrix4());
  const sx = side === "right" ? 1 : -1;
  const key = new THREE.DirectionalLight(0xffe2c8, dark ? 5.5 : 3.2);
  key.position.set(hp.x + 1.2 * sx, hp.y - 2.2, hp.z + 1.4);
  key.target.position.copy(hp);
  const back = new THREE.DirectionalLight(rim, 5);
  back.position.set(hp.x - 1.6 * sx, hp.y + 1.8, hp.z + 0.8);
  back.target.position.copy(hp);
  scene.add(key, key.target, back, back.target, new THREE.HemisphereLight(0x8090b0, 0x302018, dark ? 1.6 : 0.7));
  const cam = new THREE.PerspectiveCamera(23, 1, 0.05, 20);
  cam.up.set(0, 0, 1);
  cam.position.set(hp.x, hp.y - 1.55, hp.z + 0.03);
  cam.lookAt(hp.x, hp.y, hp.z - 0.05); // the whole head (the knight's helm rides high) and the shoulders
  r.render(scene, cam);
  const out = r.domElement.toDataURL("image/png");
  c.dispose();
  r.dispose();
  return out;
}
