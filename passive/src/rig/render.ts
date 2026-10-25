// three.js view of the MuJoCo world. Works in MuJoCo coordinates (Z up, meters).
// Draws the robots' visual meshes (geom group 1) straight from the compiled model.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LIMBS, type Limb, type Volume } from "../core/body.ts";
import type { Combat } from "../core/combat.ts";
import type { Fighter } from "../core/fighter.ts";
import { RING_RADIUS } from "../core/scene.ts";
import type { RobotHandle, World } from "../core/world.ts";
import { Human, type HumanLook } from "./human.ts";
import { RiggedHuman } from "./humanRig.ts";

export type Look = "human" | "robot" | "both";

interface Flash { mesh: THREE.Mesh; arrow: THREE.ArrowHelper; age: number }
interface Box { fighter: Fighter; vol?: Volume; limb?: Limb; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }

const ZONE_COLOR = { head: 0xff4d4d, torso: 0xffa94d, legs: 0xffe14d } as const;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private geoms: { id: number; obj: THREE.Mesh }[] = [];
  private m4 = new THREE.Matrix4();
  private flashes: Flash[] = [];
  private world: World;
  private humans: { group: THREE.Object3D; sync(): void }[] = [];
  private robotMats: THREE.MeshStandardMaterial[] = [];
  private boxes: Box[] = [];
  private hitboxes: { combat: Combat; time: () => number } | null = null;
  private va = [0, 0, 0]; private vb = [0, 0, 0];
  private up = new THREE.Vector3(0, 1, 0); private dv = new THREE.Vector3();

  /** humanModel: the rigged glTF from scripts/rig_human.py; without it the humans are mannequins. */
  constructor(container: HTMLElement, world: World, tints: number[], looks: HumanLook[], humanModel: THREE.Object3D | null = null) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x101217);
    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 60);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0.4, -4.6, 1.9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.75);
    this.controls.enableDamping = true;
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x30281f, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2.5, -3, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -4; sc.right = sc.top = 4; sc.near = 1; sc.far = 15;
    this.scene.add(sun);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(RING_RADIUS + 1.2, 96), new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.95 }));
    floor.receiveShadow = true;
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(RING_RADIUS - 0.03, RING_RADIUS + 0.03, 128), new THREE.MeshBasicMaterial({ color: 0xf0a63c }));
    ring.position.z = 0.002;
    this.scene.add(ring);
    const grid = new THREE.PolarGridHelper(RING_RADIUS, 8, 6, 64, 0x3a404c, 0x3a404c);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.001;
    this.scene.add(grid);

    this.buildRobots(tints);
    this.humans = world.robots.map((r, i) => {
      if (!humanModel) return new Human(world, r, looks[i]);
      const h = new RiggedHuman(humanModel, world, r, looks[i]);
      return { group: h.root, sync: () => h.sync() };
    });
    for (const h of this.humans) this.scene.add(h.group);
    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  private buildRobots(tints: number[]) {
    const m = this.world.model;
    const meshGeo = new Map<number, THREE.BufferGeometry>();
    const owner = new Map<number, number>();
    this.world.robots.forEach((r: RobotHandle, i) => r.bodyIds.forEach((b) => owner.set(b, i)));
    const mats = tints.map((c) => [
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.6, metalness: 0.2 }),
    ]);
    this.robotMats = mats.flat();
    for (let g = 0; g < m.ngeom; g++) {
      if (m.geom_group[g] !== 1 || m.geom_type[g] !== 7) continue; // visual meshes only
      const robot = owner.get(m.geom_bodyid[g]);
      if (robot === undefined) continue;
      const mid = m.geom_dataid[g];
      let geo = meshGeo.get(mid);
      if (!geo) {
        const va = m.mesh_vertadr[mid], vn = m.mesh_vertnum[mid];
        const fa = m.mesh_faceadr[mid], fn = m.mesh_facenum[mid];
        geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(m.mesh_vert.subarray(va * 3, (va + vn) * 3)), 3));
        geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.mesh_face.subarray(fa * 3, (fa + fn) * 3)), 1));
        geo.computeVertexNormals();
        meshGeo.set(mid, geo);
      }
      const dark = m.geom_rgba[g * 4] < 0.4; // the XML marks dark parts with rgba 0.2
      const obj = new THREE.Mesh(geo, mats[robot][dark ? 1 : 0]);
      obj.castShadow = true;
      obj.matrixAutoUpdate = false;
      this.scene.add(obj);
      this.geoms.push({ id: g, obj });
    }
  }

  /** Human boxers, the G1 robots, or the humans over a see-through robot. */
  setLook(look: Look) {
    for (const { obj } of this.geoms) obj.visible = look !== "human";
    for (const h of this.humans) h.group.visible = look !== "robot";
    for (const m of this.robotMats) {
      m.transparent = look === "both";
      m.opacity = look === "both" ? 0.22 : 1;
      m.depthWrite = look !== "both";
    }
  }

  /**
   * Shows what the combat code sees: hurt volumes (head red, torso orange, legs yellow), forearm
   * guards (blue), and striking limbs (white, magenta while a strike window is live).
   */
  showHitboxes(fighters: readonly Fighter[] | null, combat?: Combat, time?: () => number) {
    for (const b of this.boxes) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mat.dispose(); }
    this.boxes = [];
    this.hitboxes = fighters && combat && time ? { combat, time } : null;
    if (!fighters || !this.hitboxes) return;
    const add = (fighter: Fighter, geo: THREE.BufferGeometry, color: number, opacity: number, part: { vol?: Volume; limb?: Limb }) => {
      const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity, depthTest: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      this.boxes.push({ fighter, mesh, mat, ...part });
    };
    for (const f of fighters) {
      for (const v of f.body.hurt) add(f, new THREE.CapsuleGeometry(v.r, Math.max(1e-4, Math.hypot(v.b[0] - v.a[0], v.b[1] - v.a[1], v.b[2] - v.a[2])), 4, 12), ZONE_COLOR[v.zone], 0.4, { vol: v });
      for (const v of f.body.guard) add(f, new THREE.CapsuleGeometry(v.r, Math.max(1e-4, Math.hypot(v.b[0] - v.a[0], v.b[1] - v.a[1], v.b[2] - v.a[2])), 3, 8), 0x4dd2ff, 0.35, { vol: v });
      for (const l of LIMBS) add(f, new THREE.SphereGeometry(f.body.strikers[l].r, 10, 8), 0xffffff, 0.25, { limb: l });
    }
  }

  private syncHitboxes() {
    if (!this.hitboxes) return;
    const t = this.hitboxes.time();
    const live = new Map<Fighter, Limb[]>();
    for (const b of this.boxes) {
      const f = b.fighter;
      if (b.vol) {
        const [a, c] = f.body.segment(b.vol, this.va, this.vb);
        b.mesh.position.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2);
        this.dv.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        if (this.dv.lengthSq() > 1e-10) b.mesh.quaternion.setFromUnitVectors(this.up, this.dv.normalize());
      } else if (b.limb) {
        if (!live.has(f)) live.set(f, this.hitboxes.combat.liveLimbs(f, t));
        const s = f.body.strikers[b.limb];
        const p = this.world.pointOn(s.body, s.local, this.va);
        b.mesh.position.set(p[0], p[1], p[2]);
        const on = live.get(f)!.includes(b.limb);
        b.mat.color.setHex(on ? 0xff3df0 : 0xffffff);
        b.mat.opacity = on ? 0.9 : 0.25;
      }
    }
  }

  /** Copies geom poses from MuJoCo into the scene. */
  sync() {
    for (const h of this.humans) h.sync();
    this.syncHitboxes();
    const d = this.world.data, p = d.geom_xpos, R = d.geom_xmat;
    for (const { id, obj } of this.geoms) {
      const o = id * 9, t = id * 3;
      this.m4.set(R[o], R[o + 1], R[o + 2], p[t], R[o + 3], R[o + 4], R[o + 5], p[t + 1], R[o + 6], R[o + 7], R[o + 8], p[t + 2], 0, 0, 0, 1);
      obj.matrix.copy(this.m4);
      obj.matrixWorldNeedsUpdate = true;
    }
  }

  /** Marks a hit: a flash at the contact point and an arrow along the push. */
  flash(point: ArrayLike<number>, dir: ArrayLike<number>, color = 0xff5a3c) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.set(point[0], point[1], point[2]);
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    const arrow = new THREE.ArrowHelper(d, new THREE.Vector3(point[0], point[1], point[2]).addScaledVector(d, -0.45), 0.4, color, 0.12, 0.07);
    this.scene.add(mesh, arrow);
    this.flashes.push({ mesh, arrow, age: 0 });
  }

  render(dt: number, focus?: ArrayLike<number>) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      const k = 1 - f.age / 0.5;
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, k);
      f.mesh.scale.setScalar(1 + f.age * 4);
      if (k <= 0) {
        this.scene.remove(f.mesh, f.arrow);
        f.mesh.geometry.dispose();
        this.flashes.splice(i, 1);
      }
    }
    if (focus) {
      const t = this.controls.target, k = 1 - Math.exp(-dt * 2);
      t.x += (focus[0] - t.x) * k; t.y += (focus[1] - t.y) * k;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
