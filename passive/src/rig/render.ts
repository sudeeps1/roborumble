// three.js view of the MuJoCo world. Works in MuJoCo coordinates (Z up, meters).
// Draws the robots' visual meshes (geom group 1) straight from the compiled model. Spells, hits, dodges,
// knockdowns and KOs get the game screen's effects (../fx), and the frame gets the game's bloom.
import { CharacterView } from "@elf/character.ts";
import { makeStudioEnvironment } from "@elf/studio.ts";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { LIMBS, type Limb, type Volume } from "../core/body.ts";
import type { Combat } from "../core/combat.ts";
import type { ArenaEvent } from "../core/events.ts";
import type { Fighter } from "../core/fighter.ts";
import { RING_RADIUS } from "../core/scene.ts";
import type { RobotHandle, World } from "../core/world.ts";
import { GameFx, type ShotView } from "../fx/adapter.ts";
import { Human, type HumanLook } from "./human.ts";
import { RiggedHuman } from "./humanRig.ts";

export type Look = "character" | "human" | "robot" | "both";

interface Flash { mesh: THREE.Mesh; arrow: THREE.ArrowHelper; age: number }
interface Box { fighter: Fighter; vol?: Volume; limb?: Limb; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }

const ZONE_COLOR = { head: 0xff4d4d, torso: 0xffa94d, legs: 0xffe14d } as const;
/**
 * The game screen's bloom (client/src/render/stage.ts on vaibhav/server). It reads the scene before tone
 * mapping, so the threshold is in linear light: the effects' HDR colours (2..5) clear it easily; a brightly
 * lit surface can just reach it (raise the threshold if the characters start to glow). Its first level is
 * at half the drawing buffer's resolution (UnrealBloomPass does that itself).
 */
export const BLOOM = { strength: 0.85, radius: 0.55, threshold: 0.62 };

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Render -> bloom -> tone mapping and sRGB (the renderer's, so each look keeps its own) -> SMAA. */
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** The game screen's effects, driven by the arena (spellEvent, trackSpells). */
  readonly fx: GameFx;
  private shakeOff = new THREE.Vector3();
  private geoms: { id: number; obj: THREE.Mesh }[] = [];
  private m4 = new THREE.Matrix4();
  private flashes: Flash[] = [];
  private world: World;
  private humans: { group: THREE.Object3D; sync(): void }[] = [];
  private robotMats: THREE.MeshStandardMaterial[] = [];
  /** Character skins over the robots (../characters: elf, knight), once loadCharacters() has run. */
  private chars: CharacterView[] = [];
  private charBodies: Map<string, { pos: ArrayLike<number>; quat: ArrayLike<number> }>[] = [];
  private studio: THREE.Texture | null = null;
  private hemi = new THREE.HemisphereLight(0xdfe6ff, 0x30281f, 1.1);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private studioLights = new THREE.Group();
  private floorMat = new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.95 });
  private look: Look = "human";
  private boxes: Box[] = [];
  private hitboxes: { combat: Combat; time: () => number } | null = null;
  private va = [0, 0, 0]; private vb = [0, 0, 0];
  private up = new THREE.Vector3(0, 1, 0); private dv = new THREE.Vector3();

  /** humanModel: the rigged glTF from scripts/rig_human.py; without it the humans are mannequins. */
  constructor(container: HTMLElement, world: World, tints: number[], looks: HumanLook[], humanModel: THREE.Object3D | null = null) {
    this.world = world;
    // no MSAA on the canvas: everything goes through the composer, and SMAA at its end does the edges
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
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

    this.scene.add(this.hemi);
    const sun = this.sun;
    sun.position.set(2.5, -3, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -4; sc.right = sc.top = 4; sc.near = 1; sc.far = 15;
    this.scene.add(sun);
    // the characters' studio rig (their viewer's): a cool fill from camera-left and two cool rims
    // from behind, so dark armour and hair read against the background. On in the character look.
    for (const [color, intensity, x, y, z] of [[0xa9c0ff, 0.55, -3.0, -2.6, 1.5], [0x86b4ff, 2.3, -2.6, 3.2, 2.6], [0xa6a0ff, 1.8, 2.8, 2.6, 2.2]]) {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.set(x, y, z);
      l.target.position.set(0, 0, 0.9);
      this.studioLights.add(l, l.target);
    }
    this.studioLights.visible = false;
    this.scene.add(this.studioLights);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(RING_RADIUS + 1.2, 96), this.floorMat);
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
    this.fx = new GameFx(world, tints);
    this.scene.add(this.fx.root);

    // the game screen's post (stage.ts there), with the game's bloom numbers (BLOOM). Tone mapping happens
    // in the OutputPass, after the bloom, with whatever setLook put on the renderer.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());
    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
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

  /**
   * Loads one character skin per robot (GLBs from ../characters, rigged bone-for-bone to the G1:
   * the elf, the knight). The second fighter gets the other team's colours. False if one can't load.
   */
  async loadCharacters(urls: string[]): Promise<boolean> {
    try {
      this.chars = await Promise.all(this.world.robots.map((_, i) => CharacterView.load(urls[i], { hue: i ? -2.45 : 0 })));
    } catch (e) {
      console.warn("character skins not loaded:", e);
      return false;
    }
    for (const c of this.chars) {
      for (const w of c.warnings) console.warn("character:", w);
      c.root.visible = this.look === "character";
      this.scene.add(c.root);
    }
    this.charBodies = this.world.robots.map(() => new Map());
    this.studio = makeStudioEnvironment(this.renderer);
    return true;
  }

  get hasCharacters() { return this.chars.length > 0; }

  /**
   * Debug: how close character i's elbows (mesh within 7 cm of the elbow joint) come to its ribs
   * (torso surface at least 10 cm below the shoulders, so shoulder caps and pauldrons that ride on
   * the arm don't count), from the skinned mesh in the current pose. Per side:
   * the smallest distance from an arm vertex to the nearest torso triangle (m, capped at 5 cm;
   * about 0 = touching or crossing into it), and how many arm vertices are within 1 cm of it.
   */
  armClearance(i: number): Record<"left" | "right", { min: number; close: number; of: number }> | null {
    const c = this.chars[i], robot = this.world.robots[i];
    if (!c || !robot) return null;
    const TORSO = /^(torso_link|waist_(yaw|roll)_link)$/;
    const B = (n: string) => this.world.bodyPos(robot.bodies.get(n)!);
    const shoulder = { left: B("left_shoulder_pitch_link"), right: B("right_shoulder_pitch_link") };
    const elbow = { left: B("left_elbow_link"), right: B("right_elbow_link") };
    const ribsTop = Math.min(shoulder.left[2], shoulder.right[2]) - 0.1; // below the armpits: the ribs, not the shoulder caps
    const arm: Record<"left" | "right", THREE.Vector3[]> = { left: [], right: [] };
    const tris: THREE.Triangle[] = [];
    c.root.updateMatrixWorld(true);
    c.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const g = m.geometry, si = g.getAttribute("skinIndex"), sw = g.getAttribute("skinWeight");
      if (!si || !sw) return;
      m.skeleton.update();
      const bone = (k: number) => { let b = 0, w = -1; for (let j = 0; j < 4; j++) if (sw.getComponent(k, j) > w) { w = sw.getComponent(k, j); b = si.getComponent(k, j); } return m.skeleton.bones[b]?.name ?? ""; };
      const cache = new Map<number, THREE.Vector3>();
      const at = (k: number) => { let p = cache.get(k); if (!p) { p = m.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(m.matrixWorld); cache.set(k, p); } return p; };
      for (let k = 0; k < si.count; k++) {
        const side = /^(left|right)_(shoulder_(roll|yaw)|elbow)_link$/.exec(bone(k))?.[1] as "left" | "right" | undefined;
        if (!side) continue;
        const p = at(k), el = elbow[side];
        if (Math.hypot(p.x - el[0], p.y - el[1], p.z - el[2]) <= 0.07) arm[side].push(p); // around the elbow
      }
      const idx = g.index, nTri = (idx ? idx.count : si.count) / 3;
      for (let t = 0; t < nTri; t++) {
        const a = idx ? idx.getX(3 * t) : 3 * t, b = idx ? idx.getX(3 * t + 1) : 3 * t + 1, d = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
        if (!(TORSO.test(bone(a)) && TORSO.test(bone(b)) && TORSO.test(bone(d)))) continue;
        const ta = at(a), tb = at(b), td = at(d);
        if (Math.max(ta.z, tb.z, td.z) < ribsTop) tris.push(new THREE.Triangle(ta, tb, td));
      }
    });
    // spatial hash: each torso triangle goes in every 5 cm cell its bounds touch, so a point only
    // needs its own cell and the next ones (anything farther than ~5 cm is simply "clear")
    const cell = 0.05, grid = new Map<string, THREE.Triangle[]>(), key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const box = new THREE.Box3();
    for (const t of tris) {
      box.makeEmpty().expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
      for (let x = Math.floor(box.min.x / cell); x <= Math.floor(box.max.x / cell); x++)
        for (let y = Math.floor(box.min.y / cell); y <= Math.floor(box.max.y / cell); y++)
          for (let z = Math.floor(box.min.z / cell); z <= Math.floor(box.max.z / cell); z++) {
            const k = key(x, y, z);
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
          }
    }
    const q = new THREE.Vector3();
    const measure = (pts: THREE.Vector3[]) => {
      let min = cell, close = 0;
      for (let pi = 0; pi < pts.length; pi += 2) {
        const p = pts[pi];
        let best = Infinity, signed = cell;
        const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
        const seen = new Set<THREE.Triangle>();
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const t of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            t.closestPointToPoint(p, q);
            const d = p.distanceTo(q);
            if (d < best) { best = d; signed = d; } // (unsigned: these meshes' linings and shells make normals unreliable)
          }
        }
        if (signed < min) min = signed;
        if (signed < 0.01) close++;
      }
      return { min, close, of: Math.ceil(pts.length / 2) };
    };
    return { left: measure(arm.left), right: measure(arm.right) };
  }

  /** The rim-lit flash on fighter i's character (on a hit). */
  charFlash(i: number) { this.chars[i]?.hitFlash(); }

  /** Fighter i was teleported (spawn, reset): its hair and flaps start over from the new pose. */
  charSpawned(i: number) { this.chars[i]?.resetSprings(); }

  /** The characters (elf, knight), human boxers, the G1 robots, or the humans over a see-through robot. */
  setLook(look: Look) {
    if (look === "character" && !this.chars.length) look = "human";
    this.look = look;
    for (const c of this.chars) c.root.visible = look === "character";
    // the characters' materials are made for their studio light: filmic tone mapping and a soft
    // environment (authored Y-up; this scene is Z-up, so it's turned a quarter turn about X)
    const chars = look === "character";
    this.renderer.toneMapping = chars ? THREE.AgXToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = chars ? 1.15 : 1;
    this.scene.environment = chars ? this.studio : null;
    // their light: a warm key (the sun), cool fill and rims, and only a faint warm bounce from the floor
    this.studioLights.visible = chars;
    this.sun.color.setHex(chars ? 0xffdcbc : 0xffffff);
    this.sun.intensity = chars ? 3.1 : 2.2;
    this.hemi.color.setHex(chars ? 0x000000 : 0xdfe6ff);
    this.hemi.groundColor.setHex(chars ? 0x3a2a1e : 0x30281f);
    this.hemi.intensity = chars ? 0.35 : 1.1;
    this.hemi.position.set(0, chars ? 0 : 1, chars ? 1 : 0); // Z is up here (the robot looks keep their old light)
    // the floor barely reflects the studio, so it stays dark and the fighters stand out
    this.floorMat.envMap = chars ? this.studio : null;
    this.floorMat.envMapIntensity = 0.05;
    this.floorMat.needsUpdate = true;
    this.scene.environmentIntensity = 0.5;
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    for (const { obj } of this.geoms) obj.visible = look === "robot" || look === "both";
    for (const h of this.humans) h.group.visible = look === "human" || look === "both";
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

  /** Drives each character from its robot's MuJoCo body poses. */
  private syncCharacters(dt: number) {
    if (!this.chars.length || this.look !== "character") return;
    const d = this.world.data, xp = d.xpos, xq = d.xquat;
    this.world.robots.forEach((r, i) => {
      const m = this.charBodies[i];
      for (const [name, b] of r.bodies) m.set(name, { pos: xp.subarray(3 * b, 3 * b + 3), quat: xq.subarray(4 * b, 4 * b + 4) });
      this.chars[i].update(m, dt);
    });
  }

  // ---------------------------------------------------------------- spells and hits: the game's effects

  /**
   * Where the spells come from: the projectiles in flight (Arena.projectiles()) and the sim clock. The
   * effects run on the sim clock, so pause and slow-mo hold them with the fight.
   */
  trackSpells(projectiles: () => readonly ShotView[], time: () => number) { this.fx.track(projectiles, time); }

  /**
   * The game's effects for the arena's events (call it for every event): a cast's wind-up and release,
   * hits, blocks, dodges, knockdowns, KOs. A spell that fizzles before its hit frame takes its effects along.
   */
  spellEvent(e: ArenaEvent) { this.fx.event(e); }

  render(dt: number, focus?: ArrayLike<number>) {
    this.syncCharacters(dt);
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
    this.fx.update(dt, this.camera);
    // the game's screen shake: this frame only, across the screen, so the orbit controls never see it
    const s = this.fx.shake;
    if (s > 0.0005) this.shakeOff.set((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, 0).applyQuaternion(this.camera.quaternion);
    else this.shakeOff.set(0, 0, 0);
    this.camera.position.add(this.shakeOff);
    this.composer.render(dt);
    this.camera.position.sub(this.shakeOff);
  }
}
