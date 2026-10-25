// A rigged human (glTF from scripts/rig_human.py) driven by a G1's simulated pose.
// Limbs point along the G1's own segments (shoulder->elbow, hip->knee, ...), twisted by the G1's
// elbow and knee hinges, so it doesn't matter that the human was modeled in an A-pose and the
// robot stands with bent arms. Pelvis, torso and feet copy the G1 body orientations.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { RobotHandle, World } from "../core/world.ts";

export interface RigLook { skin: number; shorts: number; gloves: number }

export async function loadHumanModel(url: string): Promise<THREE.Object3D | null> {
  try {
    return (await new GLTFLoader().loadAsync(url)).scene;
  } catch {
    return null; // not set up: the rig falls back to the mannequin
  }
}

type Kind = "upright" | "foot" | "limb" | "follow";
interface Drive {
  bone: THREE.Bone;
  kind: Kind;
  body?: number;            // upright/foot: G1 body whose axes we copy
  from?: number; to?: number; // limb: G1 bodies whose origins give the segment
  hinge?: number;           // limb: G1 body whose y axis is the elbow/knee hinge
  hingeSign?: number;
  follow?: Drive;           // follow: reuse another drive's frame (hands follow forearms)
  offset: THREE.Quaternion; // frame^-1 * bind world rotation
  frame: THREE.Quaternion;  // this tick's G1 frame
  world: THREE.Quaternion;  // this tick's bone world rotation
}


/** Rotation whose +Y axis is d and +X axis is a (made orthogonal to d). */
function frameQuat(d: THREE.Vector3, a: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const y = d.clone().normalize();
  const x = a.clone().addScaledVector(y, -a.dot(y));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export class RiggedHuman {
  readonly root = new THREE.Group();
  private world: World;
  private robot: RobotHandle;
  private drives: Drive[] = [];
  private hips!: THREE.Bone;
  private hipsParentInv = new THREE.Matrix4();
  private hipsParentQ = new THREE.Quaternion();
  private hipL: number; private hipR: number;
  private v1 = new THREE.Vector3(); private v2 = new THREE.Vector3(); private v3 = new THREE.Vector3();

  constructor(template: THREE.Object3D, world: World, robot: RobotHandle, look: RigLook) {
    this.world = world;
    this.robot = robot;
    const model = cloneSkinned(template);
    this.root.add(model);
    this.root.rotation.x = Math.PI / 2; // glTF is Y-up, the sim is Z-up
    const bones: Record<string, THREE.Bone> = {};
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.geometry = m.geometry.clone(); // clones share geometry; each fighter gets its own colors
        m.castShadow = true; m.frustumCulled = false; paint(m, look);
      }
    });
    this.hips = bones.hips;
    const B = (n: string) => robot.bodies.get(n)!;
    this.hipL = B("left_hip_pitch_link"); this.hipR = B("right_hip_pitch_link");

    // Size the human to the robot (hip height), and stand it where the robot stands.
    this.root.updateMatrixWorld(true);
    const hipZ = (world.bodyPos(this.hipL)[2] + world.bodyPos(this.hipR)[2]) / 2;
    const hipsW = this.hips.getWorldPosition(new THREE.Vector3());
    this.root.scale.setScalar(hipZ / hipsW.z);
    this.root.updateMatrixWorld(true);

    // Bind frames, in the human's own rest pose (facing -Y after the Z-up turn, left = +X).
    const fwd = new THREE.Vector3(0, -1, 0), left = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 0, 1);
    const head = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
    const bindQ = (b: THREE.Bone) => b.getWorldQuaternion(new THREE.Quaternion());
    const make = (bone: THREE.Bone, kind: Kind, dh: THREE.Vector3, ah: THREE.Vector3, extra: Partial<Drive>): Drive => {
      const offset = frameQuat(dh, ah, new THREE.Quaternion()).invert().multiply(bindQ(bone));
      const d: Drive = { bone, kind, offset, frame: new THREE.Quaternion(), world: new THREE.Quaternion(), ...extra };
      this.drives.push(d);
      return d;
    };
    make(bones.hips, "upright", up, left, { body: B("pelvis") });
    make(bones.torso, "upright", up, left, { body: B("torso_link") });
    make(bones.head, "upright", up, left, { body: B("torso_link") });
    for (const [s, g] of [["L", "left"], ["R", "right"]] as const) {
      const hip = head(bones[`thigh_${s}`]), knee = head(bones[`shin_${s}`]), ankle = head(bones[`foot_${s}`]);
      const legA = new THREE.Vector3().crossVectors(knee.clone().sub(hip), fwd.clone().negate()); // knee bends the shin back
      make(bones[`thigh_${s}`], "limb", knee.clone().sub(hip), legA, { from: B(`${g}_hip_pitch_link`), to: B(`${g}_knee_link`), hinge: B(`${g}_knee_link`) });
      make(bones[`shin_${s}`], "limb", ankle.clone().sub(knee), legA, { from: B(`${g}_knee_link`), to: B(`${g}_ankle_pitch_link`), hinge: B(`${g}_knee_link`) });
      make(bones[`foot_${s}`], "foot", fwd, left, { body: B(`${g}_ankle_roll_link`) });
      const sh = head(bones[`upperarm_${s}`]), el = head(bones[`forearm_${s}`]), wr = head(bones[`hand_${s}`]);
      const armA = new THREE.Vector3().crossVectors(el.clone().sub(sh), fwd); // elbow bends the forearm forward
      make(bones[`upperarm_${s}`], "limb", el.clone().sub(sh), armA, { from: B(`${g}_shoulder_pitch_link`), to: B(`${g}_elbow_link`), hinge: B(`${g}_elbow_link`) });
      const fore = make(bones[`forearm_${s}`], "limb", wr.clone().sub(el), armA, { from: B(`${g}_elbow_link`), to: B(`${g}_wrist_roll_link`), hinge: B(`${g}_elbow_link`) });
      // the hand keeps its rest angle to the forearm (G1 hands barely move)
      const hand = bones[`hand_${s}`];
      const handOffset = frameQuat(wr.clone().sub(el), armA, new THREE.Quaternion()).invert().multiply(bindQ(hand));
      this.drives.push({ bone: hand, kind: "follow", follow: fore, offset: handOffset, frame: new THREE.Quaternion(), world: new THREE.Quaternion() });
    }
    // hinge signs: the G1 stands with knees and elbows bent, so cross(upper, lower) is well defined
    for (const d of this.drives) {
      if (d.kind !== "limb" || d.hinge === undefined) continue;
      const lower = this.drives.find((x) => x.kind === "limb" && x.from === d.to) ?? d;
      const upper = this.drives.find((x) => x.kind === "limb" && x.to === d.from) ?? d;
      const a = this.segment(upper.from!, upper.to!, new THREE.Vector3()), b = this.segment(lower.from!, lower.to!, new THREE.Vector3());
      const flex = new THREE.Vector3().crossVectors(a, b);
      d.hingeSign = flex.dot(this.axis(d.hinge, 1, new THREE.Vector3())) >= 0 ? 1 : -1;
    }
    this.hips.parent!.updateMatrixWorld(true);
    this.hipsParentInv.copy(this.hips.parent!.matrixWorld).invert();
    this.hips.parent!.getWorldQuaternion(this.hipsParentQ);
    // feet on the floor: lower the whole body by how far the soles sit above the robot's
    this.sync();
    this.root.updateMatrixWorld(true);
    const footL = head(bones.foot_L).z, g1Ankle = world.bodyPos(B("left_ankle_pitch_link"))[2];
    this.lift = g1Ankle - footL;
    this.sync();
  }

  private lift = 0;

  private segment(a: number, b: number, out: THREE.Vector3) {
    const x = this.world.data.xpos;
    return out.set(x[b * 3] - x[a * 3], x[b * 3 + 1] - x[a * 3 + 1], x[b * 3 + 2] - x[a * 3 + 2]);
  }

  /** Column `col` of a body's rotation (0 = x, 1 = y, 2 = z), in world. */
  private axis(body: number, col: number, out: THREE.Vector3) {
    const R = this.world.data.xmat, o = body * 9;
    return out.set(R[o + col], R[o + 3 + col], R[o + 6 + col]);
  }

  sync() {
    const parentW = new Map<THREE.Object3D, THREE.Quaternion>();
    parentW.set(this.hips.parent!, this.hipsParentQ);
    for (const d of this.drives) {
      switch (d.kind) {
        case "upright": frameQuat(this.axis(d.body!, 2, this.v1), this.axis(d.body!, 1, this.v2), d.frame); break;
        case "foot": frameQuat(this.axis(d.body!, 0, this.v1), this.axis(d.body!, 1, this.v2), d.frame); break;
        case "limb": frameQuat(this.segment(d.from!, d.to!, this.v1), this.axis(d.hinge!, 1, this.v2).multiplyScalar(d.hingeSign!), d.frame); break;
        case "follow": d.frame.copy(d.follow!.frame); break;
      }
      d.world.copy(d.frame).multiply(d.offset);
      const pw = parentW.get(d.bone.parent!) ?? d.bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      d.bone.quaternion.copy(pw).invert().multiply(d.world);
      parentW.set(d.bone, d.world);
    }
    // hips sit between the robot's hip joints
    const a = this.world.bodyPos(this.hipL), b = this.world.bodyPos(this.hipR);
    this.v3.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + this.lift).applyMatrix4(this.hipsParentInv);
    this.hips.position.copy(this.v3);
  }
}

/** Skin everywhere, shorts on the hips, gloves on the hands, dark shoes: by each vertex's main bone. */
function paint(mesh: THREE.SkinnedMesh, look: RigLook) {
  const g = mesh.geometry;
  const idx = g.getAttribute("skinIndex"), wgt = g.getAttribute("skinWeight");
  const bones = mesh.skeleton.bones.map((b) => b.name);
  const pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const skin = new THREE.Color(look.skin), shorts = new THREE.Color(look.shorts), gloves = new THREE.Color(look.gloves), shoe = new THREE.Color(0x24262b);
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < pos.count; i++) { ymin = Math.min(ymin, pos.getY(i)); ymax = Math.max(ymax, pos.getY(i)); }
  const H = ymax - ymin;
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (wgt.getComponent(i, k) > bw) { bw = wgt.getComponent(i, k); best = idx.getComponent(i, k); }
    const name = bones[best] ?? "";
    const h = (pos.getY(i) - ymin) / H;
    let c = skin;
    if (name.startsWith("hand")) c = gloves;
    else if (name.startsWith("foot")) c = shoe;
    else if (h > 0.42 && h < 0.6 && !name.startsWith("upperarm") && !name.startsWith("forearm")) c = shorts;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02 });
}

