# Arena: the low-poly "magic forest" floating island brought into the cast's look: graded colors (style.grade),
# matte finish, painterly breakup and baked ambient occlusion in COLOR_0, with a cleared, level fight pad.
# Built in the MuJoCo convention (Z up, fighters along X at the origin), so the glTF's Y-up export lines up with the
# viewer's worldGroup when loaded at the scene root.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P characters/blender/arena_build.py -- FOREST.fbx
# Output: characters/public/arena.glb (+ arena.blend)
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sdf  # noqa: E402
import style  # noqa: E402

FOREST = Path(sys.argv[sys.argv.index("--") + 1])
OUT = HERE.parent / "public" / "arena.glb"
TMP = HERE / "cache" / "arena_tex"
TMP.mkdir(parents=True, exist_ok=True)
GROUND = ("Tierra1", "Tierra2", "GRASS")
log = lambda *a: print("[arena]", *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def import_joined(path, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for o in scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.name = name
    return ob


forest = import_joined(FOREST, "Forest")
fme = forest.data
log(f"forest: {len(fme.vertices)} verts, materials {[m.name for m in fme.materials]}")


def arrays(me):
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


# ---------------------------------------------------------------- find a flat, open grass spot for the fight
co = arrays(fme)
fmat = np.array([p.material_index for p in fme.polygons])
gnd_idx = {i for i, m in enumerate(fme.materials) if m and m.name in GROUND}
sky_idx = {i for i, m in enumerate(fme.materials) if m and "cloud" in m.name.lower()}
polys = [list(p.vertices) for p in fme.polygons]
gbvh = BVHTree.FromPolygons(co.tolist(), [q for q, m in zip(polys, fmat) if m in gnd_idx])
hard = {i for i, m in enumerate(fme.materials) if m and m.name in ("Big Tree", "Rock")}     # trunks, canopies, rocks
obvh = BVHTree.FromPolygons(co.tolist(), [q for q, m in zip(polys, fmat) if m in hard])
gco = co[np.isin(fmat[np.repeat(np.arange(len(polys)), [len(q) for q in polys])], list(gnd_idx))] if False else co
cx, cy = np.median(co[:, 0]), np.median(co[:, 1])
top = co[:, 2].max() + 5
step = 0.5
gx = np.arange(cx - 14, cx + 14 + 1e-6, step)
gy = np.arange(cy - 14, cy + 14 + 1e-6, step)
H = np.full((len(gx), len(gy)), np.nan)
G = np.zeros((len(gx), len(gy)), bool)
for i, x in enumerate(gx):
    for j, y in enumerate(gy):
        hit = gbvh.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)))[0]
        if hit is None:
            continue
        H[i, j] = hit.z
        ob_ = obvh.ray_cast(Vector((x, y, hit.z + 3.0)), Vector((0, 0, -1)), 2.95)[0]   # rock/trunk/bush in the way
        G[i, j] = ob_ is None
best, spot = np.inf, None
r = int(3.0 / step)
for i in range(r, len(gx) - r):
    for j in range(r, len(gy) - r):
        ii, jj = np.mgrid[-r:r + 1, -r:r + 1]
        disk = ii ** 2 + jj ** 2 <= r * r
        g = G[i - r:i + r + 1, j - r:j + r + 1][disk]
        h = H[i - r:i + r + 1, j - r:j + r + 1][disk]
        if g.mean() < 0.97 or np.isnan(h).any():
            continue
        score = np.ptp(h) + 0.02 * np.hypot(gx[i] - cx, gy[j] - cy)
        if score < best:
            best, spot = score, (gx[i], gy[j], float(np.median(h)))
if spot is None:
    spot = (cx, cy, float(np.nanmax(H)))
    log("no fully open spot; using the island top")
log(f"fight spot {np.round(spot, 2)} (flatness score {best:.3f})")
fme.transform(np.array([[1, 0, 0, -spot[0]], [0, 1, 0, -spot[1]], [0, 0, 1, -spot[2]], [0, 0, 0, 1]]).T.tolist()
              if False else __import__("mathutils").Matrix.Translation((-spot[0], -spot[1], -spot[2])))
fme.update()

# ---------------------------------------------------------------- clear and level the fight pad
import bmesh  # noqa: E402
bm = bmesh.new()
bm.from_mesh(fme)
gnames = {i for i, m in enumerate(fme.materials) if m and m.name in GROUND}
kill = [f for f in bm.faces if f.material_index not in gnames and not (fme.materials[f.material_index] and
        "cloud" in fme.materials[f.material_index].name.lower())
        and np.hypot(*f.calc_center_median()[:2]) < 4.5 and f.calc_center_median()[2] < 6]
bmesh.ops.delete(bm, geom=kill, context="FACES")
for v in bm.verts:                                                    # level ground: the G1 feet stand at z = 0
    d = np.hypot(v.co.x, v.co.y)
    if d < 6.0 and abs(v.co.z) < 1.5 and any(f.material_index in gnames for f in v.link_faces):
        t = np.clip((d - 3.5) / 2.5, 0, 1)
        v.co.z *= t * t * (3 - 2 * t)
bm.to_mesh(fme)
bm.free()
fme.update()
log(f"fight pad: removed {len(kill)} faces of trees/rocks, leveled r < 3.5 m")

# ---------------------------------------------------------------- look: graded colors, breakup, AO, matte
def base_color(m):
    if not m or not m.use_nodes:
        return np.array([0.8, 0.8, 0.8])
    b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    return np.array(b.inputs["Base Color"].default_value[:3]) if b else np.array([0.8, 0.8, 0.8])


def textured(m):
    return m and m.use_nodes and any(n.type == "TEX_IMAGE" and n.image for n in m.node_tree.nodes)


def lin2srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, None), 1 / 2.4) - 0.055)


def srgb2lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def ao(me, P, N, dist, n=12):
    tree = BVHTree.FromPolygons(P.tolist(), [list(p.vertices) for p in me.polygons])
    rng = np.random.default_rng(5)
    dirs = rng.normal(size=(n, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    out = np.ones(len(P))
    for vi in range(len(P)):
        nv = N[vi]
        o = Vector(P[vi] + nv * 0.01)
        hit = tot = 0.0
        for d in dirs:
            c = d @ nv
            if c < 0:
                d, c = -d, -c
            if c < 0.05:
                continue
            loc, _n, _i, dd = tree.ray_cast(o, Vector(d), dist)
            tot += c
            if loc is not None:
                hit += c * (1 - dd / dist) ** 0.5
        out[vi] = 1 - hit / max(tot, 1e-6)
    return out


def style_mesh(ob, ao_dist, freq):
    me = ob.data
    P = arrays(me)
    N = np.zeros(len(P) * 3)
    me.vertices.foreach_get("normal", N)
    N = N.reshape(-1, 3)
    occ = ao(me, P, N, ao_dist)
    noise = sdf.fbm(P.astype(sdf.F), freq, 3)
    fine = sdf.fbm(P.astype(sdf.F), freq * 8, 2)
    lv = np.zeros(len(me.loops), int)
    me.loops.foreach_get("vertex_index", lv)
    lf = np.zeros(len(me.loops), int)
    for p in me.polygons:
        lf[p.loop_start:p.loop_start + p.loop_total] = p.index
    pm = np.array([p.material_index for p in me.polygons])[lf]
    col = np.ones((len(lv), 3))
    for mi, m in enumerate(me.materials):
        k = pm == mi
        if not k.any():
            continue
        if textured(m):
            c = np.ones(3)                                   # the (graded) texture carries the color
        else:
            c = srgb2lin(style.grade(lin2srgb(base_color(m))[None, None, :], vibrance=0.25, sat_cap=0.70)[0, 0])
        col[k] = c
        if m and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "BSDF_PRINCIPLED":
                    if not textured(m):
                        n.inputs["Base Color"].default_value = (1, 1, 1, 1)
                    n.inputs["Roughness"].default_value = max(0.75, n.inputs["Roughness"].default_value)
                    n.inputs["Metallic"].default_value = 0.0
                    for key in ("Emission Strength",):
                        if key in n.inputs:
                            n.inputs[key].default_value = 0.0
                if n.type == "TEX_IMAGE" and n.image and n.image.name not in DONE:
                    stylize(n.image)
                if n.type == "VERTEX_COLOR":
                    pass
            # show COLOR_0 in Blender too (the glTF exporter multiplies it in either way)
            b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if b and not textured(m) and not b.inputs["Base Color"].is_linked:
                vc = m.node_tree.nodes.new("ShaderNodeVertexColor")
                vc.layer_name = "Col"
                m.node_tree.links.new(vc.outputs["Color"], b.inputs["Base Color"])
    cloud = np.array([bool(me.materials[i]) and "cloud" in me.materials[i].name.lower() for i in pm])
    var = 1 + 0.16 * noise[lv] + 0.06 * fine[lv]
    gm = np.array([bool(me.materials[i]) and me.materials[i].name in GROUND for i in pm])
    col[gm] *= (1 + 0.10 * np.stack([noise[lv], 0.4 * noise[lv], -0.6 * noise[lv]], 1))[gm]   # sun-warm / cool patches
    occl = 0.45 + 0.55 * occ[lv] ** 1.3
    shade = np.where(cloud, 1.0, var * occl)
    col = np.clip(col * shade[:, None], 0, 1)
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    attr.data.foreach_set("color", np.concatenate([col, np.ones((len(col), 1))], 1).astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    log(f"{ob.name}: AO mean {occ.mean():.2f}")


DONE = set()


def stylize(img):
    if not img.has_data:
        for d in (FOREST.parent.parent / "textures",):
            cand = [f for f in d.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png")
                    and "spec" not in f.name.lower() and "ao" not in f.name.lower()] if d.exists() else []
            for f in cand:
                if (("atlas" in f.name.lower()) == ("file" in img.name.lower() or "atlas" in img.name.lower())):
                    img.filepath = str(f)
                    img.reload()
                    break
            if img.has_data:
                break
    if not img.has_data:
        log(f"texture {img.name} missing")
        return
    style.stylize_image(img)
    path = TMP / (img.name.replace(" ", "_") + ".jpg")
    img.file_format = "JPEG"
    img.save(filepath=str(path), quality=88)
    img.filepath_raw = str(path)
    img.reload()
    DONE.add(img.name)


for p in forest.data.polygons:
    p.use_smooth = False                                          # low-poly facets read as painted planes
style_mesh(forest, 2.0, 0.35)

for ob in scene.objects:
    ob.select_set(ob is forest)
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=True, export_vertex_color="ACTIVE", export_image_format="JPEG",
                          export_animations=False, export_lights=False, export_cameras=False)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / "arena.blend"), copy=True)
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
