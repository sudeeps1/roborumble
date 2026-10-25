// three.js view of the MuJoCo world. Works in MuJoCo coordinates (Z up, meters).
// Draws the robots' visual meshes (geom group 1) straight from the compiled model.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RING_RADIUS } from "../core/scene.ts";
import type { RobotHandle, World } from "../core/world.ts";

interface Flash { mesh: THREE.Mesh; arrow: THREE.ArrowHelper; age: number }

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private geoms: { id: number; obj: THREE.Mesh }[] = [];
  private m4 = new THREE.Matrix4();
  private flashes: Flash[] = [];
  private world: World;

  constructor(container: HTMLElement, world: World, tints: number[]) {
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

  /** Copies geom poses from MuJoCo into the scene. */
  sync() {
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
