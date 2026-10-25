// Minimal MJCF reader: just enough of MuJoCo's XML to draw the Menagerie G1 and run kinematics on it.
// Handles <default> classes, childclass, body pos/quat, hinge/slide/free joints, mesh/primitive geoms,
// materials and keyframes. MuJoCo conventions throughout: meters, Z up, quaternions (w, x, y, z).
import type { Quat, Vec3 } from "../contract";

export type Rgba = [number, number, number, number];

export interface MjGeom {
  type: string;          // "mesh" | "sphere" | "capsule" | "cylinder" | "box" | ...
  mesh?: string;         // mesh name (key into MjModel.meshes)
  pos: Vec3;
  quat: Quat;
  size: number[];
  rgba: Rgba;
  group: number;         // 2 = visual, 3 = collision in the Menagerie G1
  className: string;
}

export interface MjJoint {
  name: string;
  type: "hinge" | "slide" | "ball" | "free";
  axis: Vec3;
  pos: Vec3;
  range: [number, number] | null;
  body: number;          // index into MjModel.bodies
  qposAdr: number;       // first qpos index of this joint
}

export interface MjBody {
  name: string;
  parent: number;        // -1 for bodies attached to the world
  pos: Vec3;
  quat: Quat;
  joints: number[];      // indices into MjModel.joints, in XML order
  geoms: MjGeom[];
  sites: { name: string; pos: Vec3 }[];
}

export interface MjModel {
  bodies: MjBody[];      // depth-first XML order, parents before children (same order MuJoCo uses)
  joints: MjJoint[];     // XML order = qpos order
  nq: number;
  meshes: Record<string, string>;  // mesh name -> file path relative to the XML (meshdir applied)
  keyframes: Record<string, number[]>;
}

type Attrs = Record<string, string>;
interface DefaultClass { name: string; parent: DefaultClass | null; tags: Record<string, Attrs>; }

const nums = (s: string | undefined): number[] | undefined => (s == null ? undefined : s.trim().split(/\s+/).map(Number));
const vec3 = (s: string | undefined, d: Vec3): Vec3 => (nums(s) as Vec3 | undefined) ?? d;

export function parseMjcf(xmlText: string): MjModel {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error(`MJCF parse error: ${err.textContent}`);
  const root = doc.documentElement;
  const compiler = child(root, "compiler");
  if (compiler?.getAttribute("angle") === "degree") console.warn("mjcf: angle=degree is not supported; ranges will be off");
  const meshdir = compiler?.getAttribute("meshdir") ?? "";

  // <default> tree
  const classes = new Map<string, DefaultClass>();
  const readDefault = (el: Element, parent: DefaultClass | null) => {
    const name = el.getAttribute("class") ?? "main";
    const cls: DefaultClass = { name, parent, tags: {} };
    for (const c of Array.from(el.children)) if (c.tagName !== "default") cls.tags[c.tagName] = attrs(c);
    classes.set(name, cls);
    for (const c of Array.from(el.children)) if (c.tagName === "default") readDefault(c, cls);
  };
  for (const d of children(root, "default")) readDefault(d, null);
  // attribute lookup: element, then its class chain, then MuJoCo's built-in default
  const resolve = (el: Element, tag: string, cls: string, key: string): string | undefined => {
    const own = el.getAttribute(key);
    if (own != null) return own;
    for (let c = classes.get(cls) ?? null; c; c = c.parent) {
      const v = c.tags[tag]?.[key];
      if (v != null) return v;
    }
    return undefined;
  };

  const materials: Record<string, Rgba> = {};
  const meshes: Record<string, string> = {};
  for (const asset of children(root, "asset")) {
    for (const m of children(asset, "material")) materials[m.getAttribute("name")!] = (nums(m.getAttribute("rgba") ?? undefined) as Rgba) ?? [1, 1, 1, 1];
    for (const m of children(asset, "mesh")) {
      const file = m.getAttribute("file")!;
      const name = m.getAttribute("name") ?? file.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
      meshes[name] = meshdir ? `${meshdir}/${file}` : file;
    }
  }

  const model: MjModel = { bodies: [], joints: [], nq: 0, meshes, keyframes: {} };

  const readBody = (el: Element, parent: number, inherited: string) => {
    const cls = el.getAttribute("childclass") ?? inherited;
    const quat = bodyQuat(el);
    const body: MjBody = { name: el.getAttribute("name") ?? `body${model.bodies.length}`, parent, pos: vec3(el.getAttribute("pos") ?? undefined, [0, 0, 0]), quat, joints: [], geoms: [], sites: [] };
    const index = model.bodies.push(body) - 1;

    for (const c of Array.from(el.children)) {
      const tag = c.tagName;
      if (tag === "freejoint" || tag === "joint") {
        const jc = c.getAttribute("class") ?? cls;
        const type = (tag === "freejoint" ? "free" : resolve(c, "joint", jc, "type") ?? "hinge") as MjJoint["type"];
        const range = nums(resolve(c, "joint", jc, "range"));
        const joint: MjJoint = {
          name: c.getAttribute("name") ?? `joint${model.joints.length}`,
          type,
          axis: normalize(vec3(resolve(c, "joint", jc, "axis"), [0, 0, 1])),
          pos: vec3(resolve(c, "joint", jc, "pos"), [0, 0, 0]),
          range: range && range.length === 2 ? [range[0], range[1]] : null,
          body: index,
          qposAdr: model.nq,
        };
        model.nq += type === "free" ? 7 : type === "ball" ? 4 : 1;
        body.joints.push(model.joints.push(joint) - 1);
      } else if (tag === "geom") {
        const gc = c.getAttribute("class") ?? cls;
        const material = resolve(c, "geom", gc, "material");
        const rgba = nums(resolve(c, "geom", gc, "rgba")) as Rgba | undefined;
        const meshName = resolve(c, "geom", gc, "mesh");
        body.geoms.push({
          type: resolve(c, "geom", gc, "type") ?? (meshName ? "mesh" : "sphere"),
          mesh: meshName,
          pos: vec3(resolve(c, "geom", gc, "pos"), [0, 0, 0]),
          quat: geomQuat(c),
          size: nums(resolve(c, "geom", gc, "size")) ?? [],
          // MuJoCo: an explicit rgba overrides the material's color
          rgba: rgba ?? (material ? materials[material] : undefined) ?? [0.5, 0.5, 0.5, 1],
          group: Number(resolve(c, "geom", gc, "group") ?? 0),
          className: gc,
        });
      } else if (tag === "site") {
        body.sites.push({ name: c.getAttribute("name") ?? "", pos: vec3(c.getAttribute("pos") ?? undefined, [0, 0, 0]) });
      } else if (tag === "body") {
        readBody(c, index, cls);
      }
    }
  };
  for (const wb of children(root, "worldbody")) for (const b of children(wb, "body")) readBody(b, -1, "main");

  for (const kf of children(root, "keyframe")) {
    for (const k of children(kf, "key")) {
      const q = nums(k.getAttribute("qpos") ?? undefined);
      if (q) model.keyframes[k.getAttribute("name") ?? `key${Object.keys(model.keyframes).length}`] = q;
    }
  }
  return model;
}

/** Index of each joint name, for mapping a Motion's joint_names onto this model. */
export function jointIndex(model: MjModel): Map<string, MjJoint> {
  return new Map(model.joints.map((j) => [j.name, j]));
}

/** qpos for the model's default pose (all joints 0, body pos/quat as in the XML). */
export function qpos0(model: MjModel): number[] {
  const q = new Array(model.nq).fill(0);
  for (const j of model.joints) {
    if (j.type === "free") {
      const b = model.bodies[j.body];
      q.splice(j.qposAdr, 7, ...b.pos, ...b.quat);
    } else if (j.type === "ball") q[j.qposAdr] = 1;
  }
  return q;
}

function bodyQuat(el: Element): Quat {
  const q = nums(el.getAttribute("quat") ?? undefined);
  if (q) return normalizeQuat(q as Quat);
  if (el.getAttribute("euler") || el.getAttribute("axisangle") || el.getAttribute("xyaxes") || el.getAttribute("zaxis")) {
    console.warn(`mjcf: only quat orientations are supported (body ${el.getAttribute("name")})`);
  }
  return [1, 0, 0, 0];
}
const geomQuat = bodyQuat;

function attrs(el: Element): Attrs {
  const out: Attrs = {};
  for (const a of Array.from(el.attributes)) out[a.name] = a.value;
  return out;
}
const children = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.tagName === tag);
const child = (el: Element, tag: string) => children(el, tag)[0] ?? null;

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
