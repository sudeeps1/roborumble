// Shared plumbing for costume builders: tracks everything a costume adds (for dispose), owns the glow
// materials (runes, eyes, lanterns...) and turns the fighter's status into a rune brightness level.
import * as THREE from "three";
import type { Status } from "../../contract";
import type { CharacterDef } from "../../config";
import type { CostumeAnchors } from "../robot";

type Disposable = { dispose(): void };
type Colored = THREE.Material & { color: THREE.Color };

interface GlowEntry {
  mat: THREE.Material;
  basic: Colored | null;                  // unlit materials: drive color
  std: THREE.MeshStandardMaterial | null; // lit materials: drive emissiveIntensity
  unit: THREE.Color;    // glow color scaled to luminance 1 (unlit only)
  strength: number;     // luminance (unlit) or emissiveIntensity (lit) at level 1
  react: number;        // 0 ignores status, 1 follows the rune level fully
  phase: number;        // idle shimmer phase
  extra: number;        // per-frame multiplier set by the builder (flicker, crackle)
}

export const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Cheap deterministic hash in [0, 1). */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export class Kit {
  /** def.glow (linear). */
  readonly glow: THREE.Color;
  /** 1 lit .. 0 dark (KO). */
  fade = 1;
  /** Rune brightness from status: ~1 idle, pulsing 0.8..3 charging, flickering when stunned, dim when down. */
  level = 1;
  status: Status = "idle";
  t = 0;
  private readonly owned = new Set<Disposable>();
  private readonly roots: THREE.Object3D[] = [];
  private readonly glows: GlowEntry[] = [];
  private readonly byMat = new Map<THREE.Material, GlowEntry>();

  constructor(readonly def: CharacterDef, readonly a: CostumeAnchors) {
    this.glow = new THREE.Color(def.glow);
  }

  /** Track a geometry / material / texture so dispose() frees it. */
  own<T extends Disposable>(x: T): T {
    this.owned.add(x);
    return x;
  }

  /** Attach to an anchor or body group; removed on dispose(). */
  add<T extends THREE.Object3D>(parent: THREE.Object3D | undefined, obj: T): T {
    if (!parent) return obj;
    parent.add(obj);
    this.roots.push(obj);
    return obj;
  }

  /** A mesh whose geometry and material are owned by this costume. */
  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true): THREE.Mesh {
    this.own(geo);
    this.own(mat);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = shadow;
    return m;
  }

  /** Lit costume material. */
  std(p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.own(new THREE.MeshStandardMaterial(p));
  }

  /** Unlit glow material at luminance `strength` (blooms above ~0.62). `hex` defaults to the character glow. */
  glowMat(strength = 1.4, react = 1, hex?: number, p: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
    const m = this.own(new THREE.MeshBasicMaterial({ toneMapped: true, ...p }));
    this.register(m, m, null, strength, react, hex);
    return m;
  }

  /** Register any color-driven material (lines, points) as a glow. */
  glowColored<T extends Colored>(m: T, strength = 1.4, react = 1, hex?: number): T {
    this.own(m);
    this.register(m, m, null, strength, react, hex);
    return m;
  }

  /** Register a lit material's emissive as a glow (emissiveIntensity = strength at level 1). */
  glowEmissive(m: THREE.MeshStandardMaterial, strength: number, react = 1): THREE.MeshStandardMaterial {
    this.own(m);
    this.register(m, null, m, strength, react);
    return m;
  }

  /** Per-frame multiplier for one glow material (flicker, crackle). */
  setExtra(m: THREE.Material, v: number) {
    const e = this.byMat.get(m);
    if (e) e.extra = v;
  }

  get charging() {
    return this.status === "charging";
  }

  /** How animated cloth/wings should be: 1 idle, more while acting or charging. */
  get energy() {
    const s = this.status;
    return s === "charging" ? 2.2 : s === "acting" ? 1.8 : s === "dodging" ? 1.8 : s === "stunned" ? 1.5 : s === "ko" || s === "down" ? 0.4 : 1;
  }

  update(t: number, dt: number, status: Status) {
    this.t = t;
    this.status = status;
    let target: number;
    switch (status) {
      case "charging": target = 1.9 + 1.1 * Math.sin(t * 11); break;
      case "acting": target = 1.45; break;
      case "blocking": target = 1.2; break;
      case "dodging": target = 1.3; break;
      case "stunned": target = hash(Math.floor(t * 22)) > 0.42 ? 1.8 : 0.12; break;
      case "down": target = 0.5; break;
      case "ko": target = 0.8; break;
      default: target = 1;
    }
    const snap = status === "stunned" || status === "charging";
    this.level = snap ? target : this.level + (target - this.level) * Math.min(1, dt * 10);
    this.apply();
  }

  setFade(k: number) {
    this.fade = THREE.MathUtils.clamp(k, 0, 1);
    this.apply();
  }

  apply() {
    const idle = this.status === "idle" || this.status === "blocking" || this.status === "dodging";
    for (let i = 0; i < this.glows.length; i++) {
      const e = this.glows[i];
      const shimmer = idle ? 1 + 0.14 * Math.sin(this.t * 2.4 + e.phase) : 1;
      const v = Math.max(0, e.strength * (1 + (this.level - 1) * e.react) * shimmer * e.extra * this.fade);
      if (e.basic) e.basic.color.copy(e.unit).multiplyScalar(v);
      else if (e.std) e.std.emissiveIntensity = v;
    }
  }

  dispose() {
    for (const r of this.roots) r.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.roots.length = 0;
    this.owned.clear();
    this.glows.length = 0;
    this.byMat.clear();
  }

  private register(m: THREE.Material, basic: Colored | null, std: THREE.MeshStandardMaterial | null, strength: number, react: number, hex?: number) {
    const c = new THREE.Color(hex ?? this.def.glow);
    const unit = c.clone().multiplyScalar(1 / Math.max(0.05, luminance(c)));
    const e: GlowEntry = { mat: m, basic, std, unit, strength, react, phase: this.glows.length * 1.7, extra: 1 };
    this.glows.push(e);
    this.byMat.set(m, e);
  }
}
