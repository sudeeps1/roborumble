// Copied from client/src/render/fx/fighters.ts on vaibhav/server (ba9d58b). The rig's adapter.ts builds the
// per-fighter roots this reads (stand-ins posed from MuJoCo). Changed: no constructor parameter property.
// Finds the two RobotViews in stage.world (each root holds one group per G1 body, named by MJCF body name)
// so effects can follow a fighter after the call that started them: charging circles, shields, limb trails,
// afterimages, KO dust. Read-only: never moves anything.
import * as THREE from "three";

export interface FighterRef {
  root: THREE.Object3D;
  bodies: Map<string, THREE.Object3D>;
  list: THREE.Object3D[]; // body groups that have visual meshes
  chest: THREE.Object3D | null; // RobotView's chest anchor (what main.ts calls center())
}

export const LIMBS = ["left_wrist_yaw_link", "right_wrist_yaw_link", "left_ankle_roll_link", "right_ankle_roll_link"];

export class Fighters {
  private refs: FighterRef[] = [];
  private seen = -1; // world child count at the last scan
  private readonly world: THREE.Object3D;

  constructor(world: THREE.Object3D) { this.world = world; }

  private scan() {
    const roots = this.world.children.filter((c) => c.children.some((g) => g.name === "pelvis"));
    this.refs = roots.map((root) => {
      const bodies = new Map<string, THREE.Object3D>();
      for (const g of root.children) if (g.name && !g.name.startsWith("anchor:")) bodies.set(g.name, g);
      const list = [...bodies.values()].filter((g) => g.children.some((c) => (c as THREE.Mesh).isMesh));
      const chest = root.getObjectByName("anchor:chest") ?? bodies.get("torso_link") ?? null;
      return { root, bodies, list: list.length ? list : [...bodies.values()], chest };
    });
  }

  /** Both fighters (rescans only when stage.world's children change). */
  all(): FighterRef[] {
    if (this.world.children.length !== this.seen) {
      this.seen = this.world.children.length;
      this.scan();
    }
    return this.refs;
  }

  /** The fighter whose `body` is nearest to `p` (three.js world), or null if none within `maxDist`. */
  nearest(p: THREE.Vector3, body = "torso_link", maxDist = 1.6): FighterRef | null {
    let best: FighterRef | null = null, bestD = maxDist * maxDist;
    for (const f of this.all()) {
      const g = f.bodies.get(body);
      if (!g) continue;
      const e = g.matrixWorld.elements;
      const dx = e[12] - p.x, dz = e[14] - p.z, dy = body === "pelvis" ? 0 : e[13] - p.y;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /** The other fighter. */
  other(f: FighterRef | null): FighterRef | null {
    for (const x of this.all()) if (x !== f) return x;
    return null;
  }

  /** Chest point (three.js frame), same as RobotView.center(). */
  static chest(f: FighterRef, out: THREE.Vector3): THREE.Vector3 | null {
    return f.chest ? out.setFromMatrixPosition(f.chest.matrixWorld) : null;
  }

  /** World position of a body (three.js frame). */
  static pos(f: FighterRef, body: string, out: THREE.Vector3): THREE.Vector3 | null {
    const g = f.bodies.get(body);
    return g ? out.setFromMatrixPosition(g.matrixWorld) : null;
  }
}
