// Draws one G1 from FighterState.bodies: one group per MJCF body, the body's visual meshes inside it.
// Groups live in the MuJoCo frame (add `root` to stage.world), so sim poses apply as-is.
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { FighterState, Status } from "../contract";
import type { CharacterDef } from "../config";
import { parseMjcf, type MjModel } from "../g1/mjcf";
import { buildCostume, type Costume } from "./costumes";

export interface G1Assets {
  model: MjModel;
  geometries: Map<string, THREE.BufferGeometry>; // mesh name -> geometry (shared by both robots)
}

let assetsPromise: Promise<G1Assets> | null = null;

/** Loads /g1/g1.xml and its STL meshes once (public/g1, fetched by scripts/fetch-g1.mjs). */
export function loadG1(base = "/g1/"): Promise<G1Assets> {
  assetsPromise ??= (async () => {
    const res = await fetch(`${base}g1.xml`);
    if (!res.ok) throw new Error(`GET ${base}g1.xml -> ${res.status} (run: node scripts/fetch-g1.mjs)`);
    const model = parseMjcf(await res.text());
    const loader = new STLLoader();
    const geometries = new Map<string, THREE.BufferGeometry>();
    await Promise.all(Object.entries(model.meshes).map(async ([name, file]) => {
      const r = await fetch(base + file);
      if (!r.ok) throw new Error(`GET ${base + file} -> ${r.status}`);
      const g = loader.parse(await r.arrayBuffer());
      g.computeBoundingSphere();
      geometries.set(name, g);
    }));
    return { model, geometries };
  })();
  return assetsPromise;
}

/**
 * Attach points for costume pieces. Each is an Object3D parented to a G1 body group, so it moves with
 * that body. Local axes are the MuJoCo body frame: +X forward (the way the robot faces), +Y the robot's
 * left, +Z up (for limb links, "up" is along the bone toward the parent at rest). Units are meters.
 * Measured from the Menagerie meshes: standing height 1.32 m, head ~0.16 m wide.
 */
export interface CostumeAnchors {
  head: THREE.Object3D;      // head center (torso_link frame); head spans about +-0.08 in X/Y, +-0.1 in Z
  headTop: THREE.Object3D;   // top of the head
  chest: THREE.Object3D;     // front of the chest plate (torso_link), Z is up the spine
  back: THREE.Object3D;      // between the shoulder blades (torso_link)
  pelvis: THREE.Object3D;    // belt line (pelvis body)
  leftShoulder: THREE.Object3D;  rightShoulder: THREE.Object3D;   // shoulder caps
  leftForearm: THREE.Object3D;   rightForearm: THREE.Object3D;    // mid forearm; +X runs toward the hand
  leftHand: THREE.Object3D;      rightHand: THREE.Object3D;       // palm center; +X points out of the fingers
  leftShin: THREE.Object3D;      rightShin: THREE.Object3D;       // mid shin; -Z runs toward the foot
  leftFoot: THREE.Object3D;      rightFoot: THREE.Object3D;       // top of the foot; +X toward the toes
  /** Any G1 body group by MJCF name (e.g. "torso_link", "left_elbow_link"). */
  body(name: string): THREE.Object3D | undefined;
}

const ANCHOR_SPOTS: Record<Exclude<keyof CostumeAnchors, "body">, [string, [number, number, number]]> = {
  head: ["torso_link", [0.008, 0, 0.384]],
  headTop: ["torso_link", [0.008, 0, 0.487]],
  chest: ["torso_link", [0.086, 0, 0.2]],
  back: ["torso_link", [-0.07, 0, 0.21]],
  pelvis: ["pelvis", [0, 0, -0.04]],
  leftShoulder: ["left_shoulder_pitch_link", [0, 0.055, 0]],
  rightShoulder: ["right_shoulder_pitch_link", [0, -0.055, 0]],
  leftForearm: ["left_elbow_link", [0.06, 0, -0.005]],
  rightForearm: ["right_elbow_link", [0.06, 0, -0.005]],
  leftHand: ["left_wrist_yaw_link", [0.11, -0.01, 0.01]],
  rightHand: ["right_wrist_yaw_link", [0.11, 0.01, 0.01]],
  leftShin: ["left_knee_link", [0.02, 0, -0.15]],
  rightShin: ["right_knee_link", [0.02, 0, -0.15]],
  leftFoot: ["left_ankle_roll_link", [0.04, 0, 0.02]],
  rightFoot: ["right_ankle_roll_link", [0.04, 0, 0.02]],
};

const tmp = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

export class RobotView {
  readonly root = new THREE.Group();
  readonly anchors: CostumeAnchors;
  private readonly bodies = new Map<string, THREE.Group>();
  private readonly metal: THREE.MeshStandardMaterial;
  private readonly dark: THREE.MeshStandardMaterial;
  private def: CharacterDef;
  private glow = new THREE.Color();
  private costume: Costume;
  private lastStatus: Status = "idle";
  private flash = 0;   // white hit flash, decays
  private koFade = 0;  // 0 alive .. 1 runes out

  constructor(assets: G1Assets, def: CharacterDef) {
    this.def = def;
    this.metal = new THREE.MeshStandardMaterial({ metalness: 0.65, roughness: 0.42 });
    this.dark = new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.55 });
    this.tint();

    for (const b of assets.model.bodies) {
      const g = new THREE.Group();
      g.name = b.name;
      for (const geom of b.geoms) {
        if (geom.group !== 2 || geom.type !== "mesh" || !geom.mesh) continue; // visual meshes only
        const geo = assets.geometries.get(geom.mesh);
        if (!geo) continue;
        const dark = geom.rgba[0] < 0.4; // Menagerie "black" material
        const mesh = new THREE.Mesh(geo, dark ? this.dark : this.metal);
        mesh.position.set(...geom.pos);
        mesh.quaternion.set(geom.quat[1], geom.quat[2], geom.quat[3], geom.quat[0]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
      }
      this.bodies.set(b.name, g);
      this.root.add(g);
    }
    // Rest pose until the first state arrives: stack bodies on their XML offsets.
    this.restPose(assets.model);

    const spots = {} as Record<string, THREE.Object3D>;
    for (const [key, [bodyName, p]] of Object.entries(ANCHOR_SPOTS)) {
      const o = new THREE.Object3D();
      o.name = `anchor:${key}`;
      o.position.set(...p);
      (this.bodies.get(bodyName) ?? this.root).add(o);
      spots[key] = o;
    }
    this.anchors = { ...(spots as Omit<CostumeAnchors, "body">), body: (n: string) => this.bodies.get(n) };
    this.costume = buildCostume(def, this.anchors);
  }

  setCharacter(def: CharacterDef) {
    if (def.id === this.def.id) return;
    this.def = def;
    this.tint();
    this.costume.dispose();
    this.costume = buildCostume(def, this.anchors);
  }

  get character(): CharacterDef {
    return this.def;
  }

  update(state: FighterState, t: number, dt: number) {
    for (const b of state.bodies) {
      const g = this.bodies.get(b.name);
      if (!g) continue;
      g.position.set(b.pos[0], b.pos[1], b.pos[2]);
      g.quaternion.set(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
    }
    this.root.updateMatrixWorld(true);

    if (state.status === "stunned" && this.lastStatus !== "stunned") this.flash = 1;
    this.lastStatus = state.status;
    this.flash = Math.max(0, this.flash - dt * 5);
    this.koFade = state.status === "ko" ? Math.min(1, this.koFade + dt * 0.6) : 0;

    // The costume's runes carry most of the charging glow; the body only warms a little (more washes pale costumes white).
    let emissive = 0;
    if (state.status === "charging") emissive = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(t * 9));
    else if (state.status === "acting") emissive = 0.06;
    this.metal.emissive.copy(this.glow.setHex(this.def.glow)).lerp(WHITE, this.flash);
    this.metal.emissiveIntensity = Math.max(emissive, this.flash * 1.4) * (1 - this.koFade);
    this.dark.emissive.copy(this.metal.emissive);
    this.dark.emissiveIntensity = this.metal.emissiveIntensity * 0.6;

    this.costume.setRuneFade(1 - this.koFade);
    this.costume.update(t, dt, state.status);
  }

  /** World position (three.js frame) of a G1 body, e.g. "torso_link". */
  bodyPos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const g = this.bodies.get(name);
    return g ? g.getWorldPosition(out) : out.set(0, 0, 0);
  }

  /** Chest height point, three.js frame: what the camera and effects follow. */
  center(out = new THREE.Vector3()): THREE.Vector3 {
    return this.anchors.chest.getWorldPosition(out);
  }

  /** Just above the head, three.js frame: where move names and damage numbers float. */
  overhead(out = new THREE.Vector3()): THREE.Vector3 {
    this.anchors.headTop.getWorldPosition(out);
    return out.setY(Math.max(out.y, 0.3) + 0.25);
  }

  /** Ground point under the pelvis, three.js frame. */
  feet(out = new THREE.Vector3()): THREE.Vector3 {
    this.bodyPos("pelvis", out);
    return out.setY(0.01);
  }

  private tint() {
    const base = new THREE.Color(0xc9c9c9).lerp(new THREE.Color(this.def.color), 0.6);
    this.metal.color.copy(base);
    this.dark.color.copy(base).multiplyScalar(0.28);
  }

  private restPose(model: MjModel) {
    const world: { p: THREE.Vector3; q: THREE.Quaternion }[] = [];
    model.bodies.forEach((b, i) => {
      const q = new THREE.Quaternion(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
      const p = tmp.set(...b.pos).clone();
      if (b.parent >= 0) {
        const par = world[b.parent];
        p.applyQuaternion(par.q).add(par.p);
        q.premultiply(par.q);
      }
      world[i] = { p, q };
      const g = this.bodies.get(b.name)!;
      g.position.copy(p);
      g.quaternion.copy(q);
    });
  }
}
