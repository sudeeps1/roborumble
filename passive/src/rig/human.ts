// A human boxer drawn over a G1: limbs, torso, head, gloves, shorts and shoes, each attached to
// the G1 body it belongs to, so it moves exactly as the physics does. Segment lengths come from
// the robot's own joint positions in its standing pose; nothing here touches the simulation.
import * as THREE from "three";
import type { RobotHandle, World } from "../core/world.ts";

export interface HumanLook { skin: number; shorts: number; gloves: number; hair: number }

interface Anchor { body: number; obj: THREE.Object3D }

/** A capsule whose radius goes from r0 to r1 along +Y, with a soft bulge in the middle (muscle). */
function limbGeometry(len: number, r0: number, r1: number, bulge = 0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const cap = 6;
  for (let i = 0; i <= cap; i++) { // bottom cap (radius r1 at y = 0)
    const a = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(a) * r1, Math.sin(a) * r1));
  }
  const n = 10;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const r = r1 + (r0 - r1) * t + bulge * Math.sin(Math.PI * t);
    pts.push(new THREE.Vector2(r, t * len));
  }
  for (let i = 0; i <= cap; i++) { // top cap (radius r0 at y = len)
    const a = (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(a) * r0, len + Math.sin(a) * r0));
  }
  const g = new THREE.LatheGeometry(pts, 20);
  g.computeVertexNormals();
  return g;
}

export class Human {
  readonly group = new THREE.Group();
  private anchors: Anchor[] = [];
  private world: World;
  private m4 = new THREE.Matrix4();

  constructor(world: World, robot: RobotHandle, look: HumanLook) {
    this.world = world;
    const skin = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.62 });
    const shorts = new THREE.MeshStandardMaterial({ color: look.shorts, roughness: 0.75 });
    const gloves = new THREE.MeshStandardMaterial({ color: look.gloves, roughness: 0.35, metalness: 0.05 });
    const shoes = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.8 });
    const hair = new THREE.MeshStandardMaterial({ color: look.hair, roughness: 0.9 });
    const B = (name: string) => robot.bodies.get(name)!;
    const P = (name: string) => world.bodyPos(B(name));

    // world point -> local point in a body's frame (bind pose = the robot's current standing pose)
    const local = (body: number, p: number[]) => {
      const x = world.data.xpos, R = world.data.xmat;
      const d = [p[0] - x[body * 3], p[1] - x[body * 3 + 1], p[2] - x[body * 3 + 2]];
      const o = body * 9; // row-major; local = R^T d
      return new THREE.Vector3(
        R[o] * d[0] + R[o + 3] * d[1] + R[o + 6] * d[2],
        R[o + 1] * d[0] + R[o + 4] * d[1] + R[o + 7] * d[2],
        R[o + 2] * d[0] + R[o + 5] * d[1] + R[o + 8] * d[2],
      );
    };
    const anchorOf = (body: number) => {
      let a = this.anchors.find((x) => x.body === body);
      if (!a) {
        a = { body, obj: new THREE.Object3D() };
        a.obj.matrixAutoUpdate = false;
        this.group.add(a.obj);
        this.anchors.push(a);
      }
      return a.obj;
    };
    const add = (body: number, mesh: THREE.Mesh) => { mesh.castShadow = true; anchorOf(body).add(mesh); return mesh; };
    // limb from world point a to world point b, carried by `body`
    const limb = (body: number, a: number[], b: number[], r0: number, r1: number, mat: THREE.Material, bulge = 0) => {
      const la = local(body, a), lb = local(body, b);
      const dir = lb.clone().sub(la);
      const m = add(body, new THREE.Mesh(limbGeometry(dir.length(), r0, r1, bulge), mat));
      m.position.copy(lb); // geometry runs from b (y = 0) up to a (y = len)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate().normalize());
      return m;
    };
    const blob = (body: number, at: THREE.Vector3, r: [number, number, number], mat: THREE.Material) => {
      const m = add(body, new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), mat));
      m.position.copy(at); m.scale.set(r[0], r[1], r[2]);
      return m;
    };

    for (const side of ["left", "right"] as const) {
      const s = side === "left" ? 1 : -1;
      const hip = P(`${side}_hip_pitch_link`), knee = P(`${side}_knee_link`), ankle = P(`${side}_ankle_pitch_link`);
      const sh = P(`${side}_shoulder_pitch_link`), elbow = P(`${side}_elbow_link`), wrist = P(`${side}_wrist_roll_link`);
      const thighBody = B(`${side}_hip_yaw_link`), shinBody = B(`${side}_knee_link`), footBody = B(`${side}_ankle_roll_link`);
      const upperBody = B(`${side}_shoulder_yaw_link`), foreBody = B(`${side}_elbow_link`), handBody = B(`${side}_wrist_yaw_link`);
      // legs: thigh with shorts over the top half, calf bulge, shoe
      limb(thighBody, hip, knee, 0.072, 0.052, skin, 0.008);
      const mid = [hip[0] + (knee[0] - hip[0]) * 0.5, hip[1] + (knee[1] - hip[1]) * 0.5, hip[2] + (knee[2] - hip[2]) * 0.5];
      limb(thighBody, [hip[0], hip[1], hip[2] + 0.03], mid, 0.085, 0.074, shorts);
      limb(shinBody, knee, ankle, 0.05, 0.034, skin, 0.014);
      const shoe = blob(footBody, new THREE.Vector3(0.04, 0, -0.012), [0.12, 0.048, 0.035], shoes);
      shoe.position.z -= 0.004;
      // arms: deltoid, upper arm, forearm, glove
      blob(B(`${side}_shoulder_roll_link`), local(B(`${side}_shoulder_roll_link`), sh), [0.058, 0.055, 0.058], skin);
      limb(upperBody, sh, elbow, 0.047, 0.038, skin, 0.008);
      limb(foreBody, elbow, wrist, 0.038, 0.03, skin, 0.006);
      blob(handBody, new THREE.Vector3(0.075, 0.004 * s, 0), [0.07, 0.062, 0.064], gloves);
      blob(handBody, new THREE.Vector3(0.03, 0, 0), [0.04, 0.045, 0.045], gloves); // cuff
    }

    // torso, carried by torso_link: abdomen, chest, neck, head and hair
    const torso = B("torso_link");
    const shL = local(torso, P("left_shoulder_pitch_link"));
    const shoulderZ = shL.z, halfW = Math.abs(shL.y);
    blob(torso, new THREE.Vector3(0.0, 0, shoulderZ * 0.2), [0.085, halfW * 0.98, 0.11], skin);          // abdomen
    blob(torso, new THREE.Vector3(0.005, 0, shoulderZ * 0.68), [0.095, halfW * 1.22, shoulderZ * 0.42], skin); // chest
    const neckBase = new THREE.Vector3(0.0, 0, shoulderZ + 0.02), neckTop = new THREE.Vector3(0.01, 0, shoulderZ + 0.1);
    const neck = add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.043, neckTop.distanceTo(neckBase), 18), skin));
    neck.position.copy(neckBase.clone().add(neckTop).multiplyScalar(0.5));
    neck.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), neckTop.clone().sub(neckBase).normalize());
    const headC = new THREE.Vector3(0.015, 0, shoulderZ + 0.19);
    blob(torso, headC, [0.088, 0.075, 0.105], skin);
    const cap = blob(torso, headC.clone().add(new THREE.Vector3(-0.012, 0, 0.022)), [0.09, 0.079, 0.094], hair);
    cap.scale.z *= 0.95;
    blob(torso, headC.clone().add(new THREE.Vector3(0.075, 0, -0.035)), [0.02, 0.022, 0.018], skin); // nose
    // hips in shorts, carried by the pelvis
    const pelvis = B("pelvis");
    const hipL = local(pelvis, P("left_hip_pitch_link"));
    blob(pelvis, new THREE.Vector3(-0.005, 0, hipL.z + 0.03), [0.095, Math.abs(hipL.y) + 0.07, 0.09], shorts);
    blob(pelvis, new THREE.Vector3(0, 0, hipL.z + 0.11), [0.085, Math.abs(hipL.y) + 0.045, 0.045], shorts); // waistband
  }

  /** Follows the robot's bodies. */
  sync() {
    const d = this.world.data, x = d.xpos, R = d.xmat;
    for (const { body, obj } of this.anchors) {
      const o = body * 9, t = body * 3;
      this.m4.set(R[o], R[o + 1], R[o + 2], x[t], R[o + 3], R[o + 4], R[o + 5], x[t + 1], R[o + 6], R[o + 7], R[o + 8], x[t + 2], 0, 0, 0, 1);
      obj.matrix.copy(this.m4);
      obj.matrixWorldNeedsUpdate = true;
    }
  }
}
