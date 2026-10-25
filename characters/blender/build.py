# Builds a character GLB from its SDF sculpt, rigged to the G1 skeleton.
#   headless: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P characters/blender/build.py -- [--fast] [--renders DIR]
#   or through the Blender MCP's background mode (execute_blender_code_for_cli), then live.show() in the GUI
# Flags: --fast (half resolution), --only Head,Body (subset of pieces), --plain (grey debug material),
#        --renders DIR (Eevee previews), --shots face,front (subset of preview shots), --out DIR (default characters/public)
# Output: characters/public/elf.glb (+ characters/public/elf.blend for poking at it in Blender).
import json
import sys
import time
from pathlib import Path

import bpy
import bmesh
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402
import sdf  # noqa: E402
import importlib  # noqa: E402
from elf import Elf, MATS, M, PARTS, P_, COLORS  # noqa: E402
from rig import Rig  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in argv
# --char NAME: module characters/blender/NAME.py with a `Character` class (an Elf subclass); default: the elf
CHAR = argv[argv.index("--char") + 1] if "--char" in argv else "elf"
ONLY = argv[argv.index("--only") + 1].split(",") if "--only" in argv else None
PLAIN = "--plain" in argv   # debug: grey material, no vertex colors
RENDERS = Path(argv[argv.index("--renders") + 1]) if "--renders" in argv else None
OUT = Path(argv[argv.index("--out") + 1]) if "--out" in argv else HERE.parent / "public"
SHOTS = argv[argv.index("--shots") + 1].split(",") if "--shots" in argv else None
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


# ---------------------------------------------------------------- scene setup
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
WIN = None
VIEW_LAYER = scene.view_layers[0]


def ctx():
    """Context override for operators (needed when called from the MCP bridge timer)."""
    if not WIN:
        return {}
    area = next((a for a in WIN.screen.areas if a.type == "VIEW_3D"), WIN.screen.areas[0])
    return dict(window=WIN, area=area, scene=scene, view_layer=VIEW_LAYER)
W = g1.fk(g1.BIND)
elf = getattr(importlib.import_module(CHAR), "Character", Elf)(W)
if hasattr(elf, "colors"):
    COLORS = {**COLORS, **elf.colors}
USE_CARDS = getattr(elf, "hair_cards", True)

# ---------------------------------------------------------------- sculpt
q = 2.0 if FAST else 1.0
log("building sdf")
head_node = elf.head()
hair_cap, tie_ring = elf.hair()
head_all = sdf.union(head_node, hair_cap, k=0.003) if hair_cap is not None else head_node
head_all, gem = elf.circlet(head_all)
head_all = sdf.union(*[n for n in (head_all, gem, tie_ring) if n is not None], k=0.0)
collar = elf.collar()
body_node = elf.outfit(elf.body())
if collar is not None:
    body_node = sdf.union(body_node, collar, k=0.006)
pony_node, pony_pts = elf.ponytail()
flaps = elf.flaps() or {}
pauldron = elf.pauldron()
runes = elf.runes()
everything = sdf.union(*[n for n in (body_node, head_all, pony_node, pauldron) if n is not None],
                       *[f[0] for f in flaps.values()])

pieces = {}  # name -> dict(node, h, clip, target faces, kind)
pieces["Body"] = dict(node=body_node, h=0.0021 * q, clip=("below", 1.175), faces=30000)
pieces["Head"] = dict(node=head_all, h=0.00072 * q, clip=("above", getattr(elf, "head_clip", 1.015)), faces=20000,
                      lo=elf.H(-0.16, -0.16, -0.23), hi=elf.H(0.14, 0.16, 0.17))
for name, node, pc in (("Ponytail", pony_node, dict(h=0.0011 * q, faces=6000)),
                       ("Pauldron", pauldron, dict(h=0.0008 * q, faces=5000)),
                       ("Runes", runes, dict(h=0.00045 * q, faces=8000))):
    if node is not None:
        pieces[name] = dict(node=node, **pc)
# a character can add more rigid or spring pieces: {name: dict(node=, h=, faces=, bone= or chain=)}
EXTRA = elf.extra_pieces() if hasattr(elf, "extra_pieces") else {}
for name, spec in EXTRA.items():
    pieces[name] = dict(node=spec["node"], h=spec.get("h", 0.0009) * q, faces=spec.get("faces", 4000))
for name, (node, root, length, *_d) in flaps.items():
    pieces[f"Flap_{name}"] = dict(node=node, h=0.0009 * q, faces=1800)


def make_mesh(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], [tuple(reversed(f)) for f in faces])
    me.validate()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


def bm_clip(ob, mode, z):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1),
                                 clear_inner=(mode == "above"), clear_outer=(mode == "below"))
    bm.to_mesh(ob.data)
    bm.free()


def protect_borders(ob, node):
    """Vertex group on vertices where the face material changes, so decimation keeps borders crisp."""
    me = ob.data
    nf = len(me.polygons)
    cen = np.zeros(nf * 3)
    me.polygons.foreach_get("center", cen)
    _, fm, _ = node.tags(cen.reshape(-1, 3).astype(sdf.F), 0.01)
    fm = fm.astype(int)
    lt = np.zeros(nf, int)
    me.polygons.foreach_get("loop_total", lt)
    lv = np.zeros(len(me.loops), int)
    me.loops.foreach_get("vertex_index", lv)
    fol = np.repeat(np.arange(nf), lt)
    nv = len(me.vertices)
    vmin = np.full(nv, 1 << 20)
    vmax = np.full(nv, -1)
    np.minimum.at(vmin, lv, fm[fol])
    np.maximum.at(vmax, lv, fm[fol])
    border = vmin != vmax
    for _ in range(BORDER_RINGS):
        fb = np.zeros(nf, bool)
        np.logical_or.at(fb, fol, border[lv])
        border = np.zeros(nv, bool)
        border[lv[fb[fol]]] = True
    vg = ob.vertex_groups.new(name="_border")
    vg.add(np.nonzero(border)[0].tolist(), 1.0, "REPLACE")
    return vg


BORDER_RINGS = 0
BORDER_FACTOR = 6.0


def decimate(ob, target, node=None):
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if tris <= target:
        return
    vg = protect_borders(ob, node) if node is not None else None
    mod = ob.modifiers.new("dec", "DECIMATE")
    mod.ratio = target / tris
    mod.use_collapse_triangulate = True
    if vg is not None:
        mod.vertex_group = vg.name
        mod.invert_vertex_group = True
        mod.vertex_group_factor = BORDER_FACTOR
    dg = VIEW_LAYER.depsgraph
    dg.update()
    new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.remove(mod)
    ob.data = new
    bpy.data.meshes.remove(old)
    if vg is not None:
        ob.vertex_groups.remove(ob.vertex_groups["_border"])


def clean(ob):
    """Drop tiny floating islands (hair groove crumbs etc.)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    islands = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, isl = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop()
            isl.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        islands.append(isl)
    islands.sort(key=len, reverse=True)
    drop = [v for isl in islands if len(isl) < 60 for v in isl]
    bmesh.ops.delete(bm, geom=drop, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    return len(islands)


objs = {}
if ONLY:
    pieces = {k: v for k, v in pieces.items() if k in ONLY}
for name, pc in pieces.items():
    log(f"meshing {name} at {pc['h'] * 1000:.2f} mm")
    v, f = sdf.mesh(pc["node"], pc["h"], lo=pc.get("lo"), hi=pc.get("hi"), log=log)
    ob = make_mesh(name, v, f)
    if "clip" in pc:
        bm_clip(ob, *pc["clip"])
    n_isl = clean(ob)
    decimate(ob, pc["faces"] if not FAST else pc["faces"] // 2, pc["node"] if name == "Body" else None)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    objs[name] = ob
    log(f"  {name}: {len(ob.data.polygons)} faces, {n_isl} islands")

# eyes: UV spheres with a generated iris texture, poles along the gaze
def iris_image():
    w, h = 512, 256
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    U, Vv = np.meshgrid(u, v)
    th = ((1 - Vv) if TOP_V > 0.5 else Vv) * 180.0   # degrees from the front pole
    rng = np.random.default_rng(3)
    fib = np.interp(U * 180, np.arange(181), rng.random(181))
    fib2 = np.interp(U * 61, np.arange(62), rng.random(62))
    col = np.zeros((h, w, 3))
    sclera = np.array([0.78, 0.74, 0.72]) - 0.16 * np.clip((th - 40) / 90, 0, 1)[..., None]
    col[:] = sclera
    t = np.clip((th - 10.0) / (29.0 - 10.0), 0, 1)[..., None]
    inner, mid, outer = np.array([0.55, 0.62, 0.30]), np.array([0.14, 0.42, 0.24]), np.array([0.03, 0.14, 0.09])
    iris = np.where(t < 0.35, inner + (mid - inner) * (t / 0.35), mid + (outer - mid) * ((t - 0.35) / 0.65))
    iris = iris * (0.78 + 0.32 * fib[..., None] * (0.6 + 0.4 * fib2[..., None]))
    iris_mask = (th < 29.0)[..., None]
    col = np.where(iris_mask, iris, col)
    limbal = np.clip(1 - np.abs(th - 28.0) / 2.5, 0, 1)[..., None]
    col = col * (1 - 0.7 * limbal)
    pupil = np.clip((10.5 - th) / 0.8, 0, 1)[..., None]
    col = col * (1 - pupil) + np.array([0.01, 0.015, 0.012]) * pupil
    img = bpy.data.images.new("elf_iris", w, h, alpha=False)
    px = np.concatenate([col ** 2.2, np.ones((h, w, 1))], -1)  # linear
    img.pixels = px.astype(np.float32).ravel()
    img.file_format = "PNG"
    img.pack()
    return img


def pole_v():
    """Which way the UV sphere's v runs: v at the +Z pole."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=1, calc_uvs=True)
    best = max((l for f in bm.faces for l in f.loops), key=lambda l: l.vert.co.z)
    v = best[uv].uv.y
    bm.free()
    return v


TOP_V = pole_v()

for s in (1, -1):
    E, R = elf.eyes[s]
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=24, radius=elf.eye_r, calc_uvs=True)
    me = bpy.data.meshes.new("eye")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Eye_L" if s > 0 else "Eye_R", me)
    scene.collection.objects.link(ob)
    # sphere pole (+Z) -> gaze (+x of the eye frame)
    zc = R[:, 0]
    xc = -R[:, 2]
    yc = np.cross(zc, xc)
    M4 = np.eye(4)
    M4[:3, 0], M4[:3, 1], M4[:3, 2], M4[:3, 3] = xc, yc, zc, E
    import mathutils
    me.transform(mathutils.Matrix(M4.tolist()))
    for poly in me.polygons:
        poly.use_smooth = True
    objs[ob.name] = ob

# ---------------------------------------------------------------- tags, colors, AO
def srgb2lin(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


BASE = np.array([srgb2lin(COLORS[n]) for n in MATS])


def mesh_arrays(ob):
    me = ob.data
    n = len(me.vertices)
    co = np.zeros(n * 3)
    me.vertices.foreach_get("co", co)
    nor = np.zeros(n * 3)
    me.vertices.foreach_get("normal", nor)
    return co.reshape(-1, 3), nor.reshape(-1, 3)


def ambient_occlusion(P, N):
    occ = np.zeros(len(P))
    tot = 0.0
    sca = 1.0
    for i in range(5):
        hh = 0.003 + 0.007 * i
        d = everything.eval((P + N * hh).astype(sdf.F), 0.03)
        occ += np.clip((hh - d) / hh, 0, 1) * sca
        tot += sca
        sca *= 0.75
    return np.clip(1 - occ / tot * 1.1, 0, 1)


def blush(P):
    """Warm skin tint on cheeks, nose, ear tips, knuckles, elbows, knees."""
    t = np.zeros(len(P))
    spots = [(elf.H(0.058, 0.044, -0.020), 0.022, 0.55), (elf.H(0.058, -0.044, -0.020), 0.022, 0.55),
             (elf.H(0.093, 0, -0.020), 0.011, 0.45)]
    for s in (1, -1):
        spots.append((elf.H(-0.012, s * 0.064, -0.004) + 0.07 * np.array([-0.42, s * 0.66, 0.62]), 0.03, 0.6))
        Wm = W[elf.side(s, "wrist_yaw_link")]
        spots.append((Wm[:3, 3] + Wm[:3, :3] @ np.array([0.062, s * 0.004, 0]), 0.02, 0.6))
        spots.append((W[elf.side(s, "elbow_link")][:3, 3], 0.03, 0.4))
    for c, r, a in spots:
        d = np.linalg.norm(P - c, axis=1)
        t = np.maximum(t, a * np.clip(1 - d / r, 0, 1) ** 1.5)
    return t


def paint(ob, kind):
    me = ob.data
    P, N = mesh_arrays(ob)
    nf = len(me.polygons)
    cen = np.zeros(nf * 3)
    me.polygons.foreach_get("center", cen)
    cen = cen.reshape(-1, 3)
    if kind == "eye":
        fmat = np.full(nf, -1)
    else:
        node = pieces[ob.name]["node"]
        _, fmat, _ = node.tags(cen.astype(sdf.F), 0.01)
        fmat = fmat.astype(int)
    # per-vertex shading terms
    ao = ambient_occlusion(P, N) if kind != "eye" else np.ones(len(P))
    noise = sdf.fbm(P.astype(sdf.F), 60, 3)
    fine = sdf.fbm(P.astype(sdf.F), 400, 2)
    bl = blush(P)
    # corner colors
    loops_v = np.zeros(len(me.loops), int)
    me.loops.foreach_get("vertex_index", loops_v)
    loop_face = np.zeros(len(me.loops), int)
    for poly in me.polygons:
        loop_face[poly.loop_start:poly.loop_start + poly.loop_total] = poly.index
    vm = loops_v
    fm = fmat[loop_face]
    col = np.ones((len(me.loops), 3))
    if kind != "eye":
        col = BASE[np.clip(fm, 0, None)].copy()
        v = vm
        var = 1 + 0.07 * noise[v] + 0.03 * fine[v]
        is_skin = fm == M["skin"]
        warm = srgb2lin((226, 150, 140))
        col[is_skin] = col[is_skin] * (1 - bl[v][is_skin, None] * 0.35) + warm * bl[v][is_skin, None] * 0.35
        if hasattr(elf, "brow_weight") and elf.eyes:
            bw = elf.brow_weight(P)[v] * is_skin * (P[v, 2] > 1.15)
            col = col * (1 - bw[:, None] * 0.95) + BASE[M["brow"]] * bw[:, None] * 0.95
        if hasattr(elf, "lip_weight"):
            lw = elf.lip_weight(P)[v] * is_skin * (P[v, 2] > 1.1)
            col = col * (1 - lw[:, None] * 0.9) + BASE[M["lips"]] * lw[:, None] * 0.9
        hair = fm == M["hair"]
        var[hair] = 1 + 0.10 * noise[v][hair] + 0.05 * fine[v][hair]
        cloth = np.isin(fm, [M["tunic"], M["legging"], M["wrap"], M["leather"], M["leather_dark"], M["boot"],
                             M["leather_green"]])
        var[cloth] = 1 + 0.12 * noise[v][cloth] + 0.08 * fine[v][cloth]
        col = col * var[:, None]
        occl = ao[v] ** 1.2
        floor_ = np.where(np.isin(fm, [M["skin"], M["lips"]]), 0.55, 0.35)   # skin scatters light into its creases
        col = col * (floor_ + (1 - floor_) * occl)[:, None]
        glow = np.isin(fm, [M["gem"], M["rune"]])
        col[glow] = BASE[fm[glow]]
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    rgba = np.concatenate([col, np.ones((len(col), 1))], 1).astype(np.float32)
    attr.data.foreach_set("color", rgba.ravel())
    me.color_attributes.active_color = attr
    # material slots
    used = sorted(set(fmat.tolist())) if kind != "eye" else []
    return fmat, used


# ---------------------------------------------------------------- materials
SHADE = {  # roughness, metallic, extra
    "skin": (0.55, 0.0, {}), "lips": (0.4, 0.0, {}), "hair": (0.38, 0.0, {"sheen": 0.15}),
    "brow": (0.5, 0.0, {}), "lash": (0.6, 0.0, {}), "tunic": (0.85, 0.0, {"sheen": 0.08}),
    "leather": (0.62, 0.0, {"coat": 0.08}), "leather_dark": (0.6, 0.0, {"coat": 0.1}),
    "gold": (0.28, 1.0, {}), "gem": (0.08, 0.0, {"emit": 3.0, "coat": 1.0}), "rune": (0.4, 0.0, {"emit": 2.0}),
    "wrap": (0.9, 0.0, {"sheen": 0.15}), "legging": (0.75, 0.0, {}), "boot": (0.62, 0.0, {"coat": 0.08}),
    "mouth": (0.6, 0.0, {}), "leather_green": (0.58, 0.0, {"coat": 0.1}), "eye": (0.12, 0.0, {"coat": 1.0}),
}
MAT_OBJS = {}


def material(name):
    if name in MAT_OBJS:
        return MAT_OBJS[name]
    mt = bpy.data.materials.new(name)
    mt.use_nodes = True
    nt = mt.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    rough, metal, extra = SHADE[name]
    if PLAIN:
        bsdf.inputs["Base Color"].default_value = (0.6, 0.6, 0.6, 1)
        MAT_OBJS[name] = mt
        return mt
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if name == "eye":
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.get("elf_iris") or iris_image()
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        ca = nt.nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        nt.links.new(ca.outputs["Color"], bsdf.inputs["Base Color"])
    if "sheen" in extra:
        bsdf.inputs["Sheen Weight"].default_value = extra["sheen"]
    if "coat" in extra:
        bsdf.inputs["Coat Weight"].default_value = extra["coat"]
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    if "emit" in extra:
        c = BASE[M[name]]
        bsdf.inputs["Emission Color"].default_value = (*c, 1)
        bsdf.inputs["Emission Strength"].default_value = extra["emit"]
    MAT_OBJS[name] = mt
    return mt


# --- hair cards: hair_cards.py owns these objects (UV'd strand cards with their own material) ---
import hair_cards  # noqa: E402
CARDS = hair_cards.build(elf, scene, pony_pts, log) if USE_CARDS and (not ONLY or any(n.startswith("Hair") for n in ONLY)) else {}
# --- end hair cards ---

log("painting")
for name, ob in objs.items():
    kind = "eye" if name.startswith("Eye") else "piece"
    fmat, used = paint(ob, kind)
    me = ob.data
    if kind == "eye":
        me.materials.append(material("eye"))
        continue
    slot = {}
    for m in used:
        slot[m] = len(me.materials)
        me.materials.append(material(MATS[m]))
    idx = np.array([slot[m] for m in fmat], dtype=np.int32)
    me.polygons.foreach_set("material_index", idx)
    me.update()
    # strand direction for the hair shader (hair_cards.flow owns the field); exported as glTF attribute _FLOW
    fl = hair_cards.flow(elf, mesh_arrays(ob)[0], name) if USE_CARDS else None
    if fl is not None:
        at = me.attributes.new("_FLOW", "FLOAT_VECTOR", "POINT")
        at.data.foreach_set("vector", np.asarray(fl, np.float32).ravel())

# ---------------------------------------------------------------- rig
log("rigging")
rig = Rig(W, elf)
pony_names, pony_joints = rig.add_chain("hair", "head", pony_pts, 5) if pony_pts is not None else ([], [])
flap_chains = {}
for name, (node, root, length, *d_opt) in flaps.items():
    # chain straight down the flap's long axis (matches leaf_plate in elf.py); other characters pass a direction
    dirs = {"front": (0.12, 0, -1), "back": (-0.16, 0, -1), "left": (0.06, 0.30, -1), "right": (0.06, -0.30, -1)}
    d = np.asarray(d_opt[0] if d_opt else dirs[name], float)
    d /= np.linalg.norm(d)
    pts = [root + d * length * t for t in np.linspace(0, 1, 6)]
    flap_chains[name] = rig.add_chain(f"flap_{name}", "pelvis", pts, 2)

RIG_NAME = CHAR.capitalize() + "Rig"
arm_data = bpy.data.armatures.new(RIG_NAME)
arm_ob = bpy.data.objects.new(RIG_NAME, arm_data)
scene.collection.objects.link(arm_ob)
VIEW_LAYER.objects.active = arm_ob
with bpy.context.temp_override(**ctx()):
    bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for bn, (parent, head, tail, body) in rig.bones.items():
    b = arm_data.edit_bones.new(bn)
    b.head, b.tail = head.tolist(), tail.tolist()
    if np.linalg.norm(tail - head) < 1e-3:
        b.tail = (head + np.array([0, 0, 0.01])).tolist()
    b.use_deform = True
    eb[bn] = b
for bn, (parent, *_rest) in rig.bones.items():
    if parent:
        eb[bn].parent = eb[parent]
with bpy.context.temp_override(**ctx()):
    bpy.ops.object.mode_set(mode="OBJECT")


def weights_for(ob):
    P, _ = mesh_arrays(ob)
    name = ob.name
    nv = len(P)
    if name in CARDS:
        return hair_cards.weights(name, P, rig, pony_joints, pony_names)
    if name in ("Head", "Eye_L", "Eye_R"):
        return rig.spine_weights(P)
    if name in EXTRA:
        if EXTRA[name].get("weights") == "skirt":
            # skirt: pelvis at the waist, sliding onto both thighs (by side) toward the hem
            t = np.clip((0.86 - P[:, 2]) / 0.55, 0, 1) ** 0.8
            side = 0.5 + 0.5 * np.tanh(P[:, 1] / 0.07)
            return {"pelvis": 1 - 0.75 * t, "left_hip_yaw_link": 0.75 * t * side,
                    "right_hip_yaw_link": 0.75 * t * (1 - side)}
        return {EXTRA[name].get("bone", "torso_link"): np.ones(nv)}
    if name == "Pauldron":
        return {"left_shoulder_roll_link": np.ones(nv)}
    if name == "Runes":
        out = {}
        for s in (1, -1):
            m = (P[:, 1] > 0) if s > 0 else (P[:, 1] <= 0)
            for bn, w in rig.arm_weights(P, s).items():
                out.setdefault(bn, np.zeros(nv))[m] += w[m]
        return out
    if name == "Ponytail":
        return rig.chain_param_weights(P, pony_joints, pony_names, [0.02, 0.025, 0.03, 0.03])
    if name.startswith("Flap_"):
        fname = name[5:]
        names, joints = flap_chains[fname]
        return rig.chain_param_weights(P, joints, names, [0.03])
    # main body: by part label
    _, _, part = pieces[name]["node"].tags(P.astype(sdf.F), 0.01)
    out = {}

    def acc(wd, mask):
        for b, w in wd.items():
            arr = out.setdefault(b, np.zeros(nv))
            arr[mask] += w[mask] if np.ndim(w) else w

    acc(rig.spine_weights(P), part == P_["spine"])
    for s, a, l in ((1, "l_arm", "l_leg"), (-1, "r_arm", "r_leg")):
        acc(rig.arm_weights(P, s), part == P_[a])
        acc(rig.leg_weights(P, s), part == P_[l])
    return out


def smooth_weights(ob, wd, iters=6, alpha=0.5):
    me = ob.data
    nv = len(me.vertices)
    ev = np.zeros(len(me.edges) * 2, int)
    me.edges.foreach_get("vertices", ev)
    ev = ev.reshape(-1, 2)
    deg = np.bincount(ev.ravel(), minlength=nv).astype(float)
    deg[deg == 0] = 1
    names = list(wd)
    Wm = np.stack([wd[n] for n in names], 1)
    for _ in range(iters):
        acc = np.zeros_like(Wm)
        np.add.at(acc, ev[:, 0], Wm[ev[:, 1]])
        np.add.at(acc, ev[:, 1], Wm[ev[:, 0]])
        Wm = (1 - alpha) * Wm + alpha * acc / deg[:, None]
    return {n: Wm[:, i] for i, n in enumerate(names)}


def apply_weights(ob, wd):
    names = [n for n in wd if wd[n].max() > 1e-4]
    Wm = np.stack([wd[n] for n in names], 1)
    # keep the 4 biggest influences, renormalize
    idx = np.argsort(-Wm, 1)[:, :4]
    top = np.take_along_axis(Wm, idx, 1)
    top[top < 0.01] = 0
    top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
    groups = {n: ob.vertex_groups.new(name=n) for n in names}
    for vi in range(len(Wm)):
        for j in range(top.shape[1]):
            w = top[vi, j]
            if w > 0:
                groups[names[idx[vi, j]]].add([vi], float(w), "REPLACE")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = arm_ob
    ob.parent = arm_ob


objs.update(CARDS)
for name, ob in objs.items():
    wd = weights_for(ob)
    if name == "Body":
        wd = smooth_weights(ob, wd, iters=8)
    elif name in ("Ponytail", "Skirt") or name.startswith("Flap_"):
        wd = smooth_weights(ob, wd, iters=3)
    apply_weights(ob, wd)
    log(f"  weights {name}: {len(wd)} bones")

# runtime metadata: which G1 body drives each bone and that body's bind pose (MuJoCo frame)
meta = {"version": 1, "frame": "mujoco", "bind_angles": g1.BIND, "bones": {}, "springs": []}
for bn, (parent, head, tail, body) in rig.bones.items():
    if body:
        Mb = W[body]
        meta["bones"][bn] = {"body": body, "pos": Mb[:3, 3].round(6).tolist(), "quat": g1.mat_quat(Mb[:3, :3]).round(6).tolist()}
spring_params = {"hair": dict(stiffness=0.18, damping=0.26, gravity=0.6, radius=0.02),
                 "flap_front": dict(stiffness=0.25, damping=0.2, gravity=0.5, radius=0.01),
                 "flap_back": dict(stiffness=0.25, damping=0.2, gravity=0.5, radius=0.01),
                 "flap_left": dict(stiffness=0.3, damping=0.2, gravity=0.5, radius=0.01),
                 "flap_right": dict(stiffness=0.3, damping=0.2, gravity=0.5, radius=0.01)}
for sp in rig.springs:
    meta["springs"].append({**sp, **spring_params.get(sp["name"], dict(stiffness=0.25, damping=0.22, gravity=0.5, radius=0.01))})
# collision capsules the springs stay out of (bone, local head/tail along the bone, radius)
# Thigh capsules are slimmer than the thigh itself so the side flaps start clear of them at rest; the inner
# "lap" capsules catch the front flap when a knee comes up.
meta["colliders"] = [
    {"bone": "torso_link", "a": [-0.01, 0, 0.88], "b": [-0.012, 0, 1.06], "r": 0.100},
    {"bone": "pelvis", "a": [-0.01, -0.04, 0.775], "b": [-0.01, 0.04, 0.775], "r": 0.085},
    {"bone": "head", "a": [0.0, 0, 1.22], "b": [-0.01, 0, 1.25], "r": 0.095},
] + [c for s, y in (("left", 1), ("right", -1)) for c in (
    {"bone": f"{s}_hip_yaw_link", "a": [0.0, y * 0.104, 0.66], "b": [0.004, y * 0.116, 0.38], "r": 0.050},
    {"bone": f"{s}_hip_yaw_link", "a": [0.012, y * 0.070, 0.66], "b": [0.016, y * 0.090, 0.42], "r": 0.040})]
arm_ob["g1_rig"] = json.dumps(meta)

# ---------------------------------------------------------------- export
OUT.mkdir(parents=True, exist_ok=True)
for ob in scene.objects:
    ob.select_set(ob.name in objs or ob == arm_ob, view_layer=VIEW_LAYER)
VIEW_LAYER.objects.active = arm_ob
glb = OUT / f"{CHAR}.glb"
with bpy.context.temp_override(**ctx()):
  bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True,
                          export_skins=True, export_animations=False, export_extras=True,
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_attributes=True,
                          export_apply=False, export_def_bones=False, export_rest_position_armature=True)
log(f"wrote {glb} ({glb.stat().st_size / 1e6:.1f} MB)")
with bpy.context.temp_override(**ctx()):
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / f"{CHAR}.blend"), copy=True)

# ---------------------------------------------------------------- previews
if RENDERS:
    import render_previews
    with bpy.context.temp_override(**ctx()):
        render_previews.render(scene, RENDERS, log, names=SHOTS)
log("done")
