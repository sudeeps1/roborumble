// CharacterView: the elf skin drawn over one G1. Feed it MuJoCo body poses every frame.
//
//   const elf = await CharacterView.load("/elf.glb");
//   worldGroup.add(elf.root);            // worldGroup = MuJoCo frame (rotation.x = -PI/2 in a Y-up scene)
//   elf.update(bodies, dt);              // bodies: [{name, pos:[x,y,z], quat:[w,x,y,z]}] or Map, MuJoCo world
//
// Driving math, per bone with a driving body:  BoneWorld = BodyNow * inverse(BodyBind) * BoneBind
// (all in root space = MuJoCo frame). Bones get local = inverse(ParentWorld) * BoneWorld, so three's
// normal matrixWorld update and skinning do the rest. Spring bones (hair, flaps) are simulated.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { upgradeMaterials, type MaterialSet } from "./materials.ts";
import { detailTextures } from "./detail.ts";
import { addDebugCards } from "./debugcards.ts";
import { SpringChain, type Capsule, type SpringDef } from "./springs.ts";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // w, x, y, z
export interface BodyPoseIn { pos: ArrayLike<number>; quat: ArrayLike<number> }
export type BodyInput = ReadonlyArray<BodyPoseIn & { name: string }> | Map<string, BodyPoseIn>;

export interface RigMeta {
  version: number;
  frame: "mujoco";
  bind_angles: Record<string, number>;
  bones: Record<string, { body: string; pos: Vec3; quat: Quat }>;
  springs: SpringDef[];
  colliders: { bone: string; a: Vec3; b: Vec3; r: number }[];
}

export interface CharacterOptions {
  /** Team hue rotation (radians) for tunic, wrap, green leather, runes and gem. */
  hue?: number;
  castShadow?: boolean;
}

interface BoneRec {
  bone: THREE.Bone;
  name: string;
  parent: number;          // index into bones, or -1 (parent is a non-bone node)
  parentFixed: THREE.Matrix4 | null; // root-space matrix of a non-bone parent (constant)
  parentFixedInv: THREE.Matrix4 | null;
  body: BodyRec | null;    // driving body
  offset: THREE.Matrix4;   // inverse(BodyBind) * BoneBind
  restLocal: THREE.Matrix4;
  spring: boolean;
}
interface BodyRec { name: string; now: THREE.Matrix4; bind: THREE.Matrix4; stamp: number }

const templates = new Map<string, Promise<GLTF>>();
const loader = new GLTFLoader();

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);

export class CharacterView {
  /** MuJoCo-frame group (meters, Z up). Add it to a group that maps MuJoCo to your world. */
  readonly root = new THREE.Group();
  readonly meta: RigMeta;
  readonly materials: MaterialSet;
  /** Problems found in the asset at load (rest-pose collider overlaps, missing bones, ...). */
  readonly warnings: string[] = [];

  private bones: BoneRec[] = [];
  private boneIndex = new Map<string, number>();
  private bodies = new Map<string, BodyRec>();
  private world: THREE.Matrix4[] = [];      // current root-space bone matrices
  private bindWorld: THREE.Matrix4[] = [];
  private inv: THREE.Matrix4[] = [];
  private springs: SpringChain[] = [];
  private colliders: Capsule[] = [];
  private stamp = 0;
  private time = 0;
  private glowTarget = 0;
  private glowNow = 0;
  private flashT = 0;
  private meshes: THREE.SkinnedMesh[] = [];

  static async load(url: string, opts: CharacterOptions = {}): Promise<CharacterView> {
    let p = templates.get(url);
    if (!p) {
      p = loader.loadAsync(url);
      templates.set(url, p);
      // generate the procedural detail textures while the GLB downloads
      await new Promise((r) => setTimeout(r, 0));
      detailTextures();
    }
    const gltf = await p;
    return new CharacterView(gltf.scene, opts);
  }

  private constructor(template: THREE.Object3D, opts: CharacterOptions) {
    const scene = SkeletonUtils.clone(template);
    const rig = scene.getObjectByName("ElfRig");
    if (!rig) throw new Error("elf.glb: no ElfRig node");
    const raw = rig.userData.g1_rig;
    this.meta = (typeof raw === "string" ? JSON.parse(raw) : raw) as RigMeta;
    if (!this.meta?.bones) throw new Error("elf.glb: ElfRig.userData.g1_rig missing");

    // glTF Y-up -> MuJoCo Z-up: glTF (x, y, z) = MuJoCo (x, z, -y) => rotate +90 deg about X
    const yup = new THREE.Group();
    yup.name = "gltf_yup";
    yup.rotation.x = Math.PI / 2;
    yup.add(scene);
    this.root.add(yup);
    this.root.name = "CharacterView";
    this.root.updateMatrixWorld(true);
    const rootInv = this.root.matrixWorld.clone().invert();

    // bones in hierarchy order
    const order: THREE.Bone[] = [];
    rig.traverse((o) => { if ((o as THREE.Bone).isBone) order.push(o as THREE.Bone); });
    order.forEach((b, i) => this.boneIndex.set(b.name, i));
    for (const b of order) {
      const bindWorld = rootInv.clone().multiply(b.matrixWorld);
      const parentIsBone = (b.parent as THREE.Bone | null)?.isBone === true;
      const parent = parentIsBone ? this.boneIndex.get(b.parent!.name)! : -1;
      const parentFixed = parentIsBone ? null : rootInv.clone().multiply(b.parent!.matrixWorld);
      const info = this.meta.bones[b.name];
      let body: BodyRec | null = null;
      const offset = new THREE.Matrix4();
      if (info) {
        body = this.bodies.get(info.body) ?? null;
        if (!body) {
          const bind = new THREE.Matrix4().compose(
            _p.set(info.pos[0], info.pos[1], info.pos[2]),
            _q.set(info.quat[1], info.quat[2], info.quat[3], info.quat[0]).normalize(), _one);
          body = { name: info.body, now: bind.clone(), bind, stamp: -1 };
          this.bodies.set(info.body, body);
        }
        offset.copy(body.bind).invert().multiply(bindWorld);
      }
      const restLocal = (parentIsBone ? this.bindWorld[parent].clone().invert() : parentFixed!.clone().invert()).multiply(bindWorld);
      this.bones.push({ bone: b, name: b.name, parent, parentFixed, parentFixedInv: parentFixed ? parentFixed.clone().invert() : null, body, offset, restLocal, spring: false });
      this.bindWorld.push(bindWorld);
      this.world.push(bindWorld.clone());
      this.inv.push(new THREE.Matrix4());
      b.matrixAutoUpdate = false;
    }
    for (const name of Object.keys(this.meta.bones)) if (!this.boneIndex.has(name)) this.warnings.push(`g1_rig.bones has ${name} but the skeleton has no such bone`);

    // colliders: bind-pose MuJoCo points -> bone local
    for (const c of this.meta.colliders ?? []) {
      const bi = this.boneIndex.get(c.bone);
      if (bi === undefined) { this.warnings.push(`collider bone ${c.bone} not found`); continue; }
      const inv = this.bindWorld[bi].clone().invert();
      this.colliders.push({
        bone: bi, r: c.r, name: c.bone,
        a: new THREE.Vector3(...c.a).applyMatrix4(inv),
        b: new THREE.Vector3(...c.b).applyMatrix4(inv),
      });
    }
    // spring chains
    for (const s of this.meta.springs ?? []) {
      const idx = s.bones.map((n) => this.boneIndex.get(n));
      if (idx.some((i) => i === undefined)) { this.warnings.push(`spring ${s.name}: missing bones`); continue; }
      const first = this.bones[idx[0]!];
      if (first.parent < 0) { this.warnings.push(`spring ${s.name}: root bone has no bone parent`); continue; }
      for (const i of idx) this.bones[i!].spring = true;
      const chain = new SpringChain(s, first.parent, idx as number[], this.bones.map((b) => b.restLocal), this.bindWorld, this.colliders);
      this.warnings.push(...chain.restOverlaps);
      this.springs.push(chain);
    }
    for (const b of this.bones) if (!b.body && !b.spring) this.warnings.push(`bone ${b.name} has no driving body and is not a spring (follows its parent)`);

    // materials, one skeleton for all skinned meshes, shadows, no culling (bones move away from the mesh origin)
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("fakecards")) addDebugCards(scene);
    this.materials = upgradeMaterials(scene, { hue: opts.hue });
    let shared: THREE.Skeleton | null = null;
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = opts.castShadow ?? true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if (!m.isSkinnedMesh) return;
      this.meshes.push(m);
      if (!shared) { shared = m.skeleton; return; }
      const sb = shared.bones, mb = m.skeleton.bones;
      if (sb.length === mb.length && sb.every((b, i) => b === mb[i])) {
        m.skeleton.dispose();
        m.bind(shared, m.bindMatrix.clone());
      }
    });

    this.applyLocals();
  }

  /**
   * bodies: MuJoCo world poses of the G1 bodies (MJCF names, meters, Z up, quat [w,x,y,z]).
   * Missing bodies keep their bone at rest relative to the parent. dt drives springs and effects.
   */
  update(bodies: BodyInput, dt: number) {
    const stamp = ++this.stamp;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    const ingest = (name: string, b: BodyPoseIn) => {
      const rec = this.bodies.get(name);
      if (!rec) return;
      const p = b.pos, q = b.quat;
      rec.now.compose(_p.set(p[0], p[1], p[2]), _q.set(q[1], q[2], q[3], q[0]).normalize(), _one);
      rec.stamp = stamp;
    };
    if (bodies instanceof Map) bodies.forEach((b, name) => ingest(name, b));
    else for (let i = 0; i < bodies.length; i++) ingest(bodies[i].name, bodies[i]);

    const W = this.world;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      if (b.spring) continue;
      if (b.body && b.body.stamp === stamp) W[i].multiplyMatrices(b.body.now, b.offset);
      else W[i].multiplyMatrices(b.parent >= 0 ? W[b.parent] : b.parentFixed!, b.restLocal);
    }
    for (const s of this.springs) s.step(dt, W, this.colliders);
    this.applyLocals();
    this.updateEffects(dt);
  }

  private applyLocals() {
    const W = this.world;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      this.inv[i].copy(W[i]).invert();
      const local = b.bone.matrix;
      if (b.parent >= 0) local.multiplyMatrices(this.inv[b.parent], W[i]);
      else local.multiplyMatrices(b.parentFixedInv!, W[i]);
      b.bone.matrixWorldNeedsUpdate = true;
    }
  }

  /** Root-space (MuJoCo) matrix of a bone, e.g. "right_wrist_yaw_link" for hit sparks. */
  boneMatrix(name: string): THREE.Matrix4 | null {
    const i = this.boneIndex.get(name);
    return i === undefined ? null : this.world[i];
  }

  /** 0..1: runes and gem pulse brighter (the "charging" state). */
  setGlow(level: number) { this.glowTarget = Math.min(1, Math.max(0, level)); }

  /** Short rim-lit flash on the whole body. */
  hitFlash() { this.flashT = 1; }

  /** Restart spring chains from the current pose (after a teleport or round reset). */
  resetSprings() { for (const s of this.springs) s.reset(); }

  private updateEffects(dt: number) {
    this.glowNow += (this.glowTarget - this.glowNow) * (1 - Math.exp(-dt * 10));
    const pulse = this.glowNow * (0.7 + 0.3 * Math.sin(this.time * 2 * Math.PI * 2.2));
    for (const g of this.materials.glow) g.mat.emissiveIntensity = g.base + g.gain * pulse;
    this.flashT = Math.max(0, this.flashT - dt / 0.28);
    this.materials.uniforms.flash.value = this.flashT * this.flashT * 1.1;
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of this.materials.all) m.dispose();
    const seen = new Set<THREE.Skeleton>();
    for (const m of this.meshes) if (!seen.has(m.skeleton)) { seen.add(m.skeleton); m.skeleton.dispose(); }
    this.springs = [];
  }
}
