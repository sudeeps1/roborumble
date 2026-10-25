# Knight: a game-ready mesh (Mixamo-rigged FBX + PBR textures) refit onto the G1 bind pose, recolored to the
# elf's palette (green-enamel steel, gold trim, leather) and re-rigged to the G1 bones like the elf.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P characters/blender/knight_build.py -- SRC_DIR
# SRC_DIR: the unzipped "medieval-knight-sculpture-game-ready" folder (source/Dwarf Idle.fbx, textures/).
# Output: characters/public/knight.glb (1K JPEG textures, so it stays a few MB).
import json
import sys
from pathlib import Path

import bpy
import mathutils
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402
from fit_base import bone_map, seg_dist  # noqa: E402
from rig import Rig  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:]
SRC = Path(ARGS[0])
VARIANT = ARGS[1] if len(ARGS) > 1 else "knight"     # knight | king (same armor, royal palette + crown)
OUT = HERE.parent / "public" / f"{VARIANT}.glb"
import style  # noqa: E402
TEX = 1024
log = lambda *a: print("[knight]", *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.fbx(filepath=str(SRC / "source" / "Dwarf Idle.fbx"))
src_arm = next(o for o in scene.objects if o.type == "ARMATURE")
src_arm.data.pose_position = "REST"
J = {b.name.split(":")[-1]: np.array(src_arm.matrix_world @ b.head_local) for b in src_arm.data.bones}

# ---------------------------------------------------------------- one mesh, world space, bind pose
meshes = [o for o in scene.objects if o.type == "MESH"]
for ob in meshes:
    ob.modifiers.clear()
    ob.data.transform(ob.matrix_world)
    ob.parent = None
    ob.matrix_world = np.eye(4).tolist()
for ob in scene.objects:
    ob.select_set(ob in meshes)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
knight = bpy.context.view_layer.objects.active
knight.name = "Knight"
bpy.data.objects.remove(src_arm, do_unlink=True)
knight.vertex_groups.clear()
me = knight.data
co = np.zeros(len(me.vertices) * 3)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
log(f"{len(co)} verts, {len(me.polygons)} faces, height {co[:, 2].max():.3f}")

# ---------------------------------------------------------------- source frame -> MuJoCo frame
H = J["HeadTop_End"][2]
SK = 1.30 / H
cx, cy = 0.0, (J["LeftLeg"][1] + J["RightLeg"][1]) / 2


def tm(p):
    p = np.asarray(p, float)
    return np.stack([-(p[..., 1] - cy) * SK, (p[..., 0] - cx) * SK, p[..., 2] * SK], -1)


P = tm(co)
S = {
    "pelvis": tm(J["Hips"]), "waist": tm(J["Spine"]), "chest": tm(J["Spine2"]), "neck": tm(J["Neck"]),
    "top": tm(J["HeadTop_End"]),
}
for s, L in ((1, "Left"), (-1, "Right")):
    n = "l" if s > 0 else "r"
    S[n + "_hip"], S[n + "_knee"], S[n + "_ankle"] = tm(J[L + "UpLeg"]), tm(J[L + "Leg"]), tm(J[L + "Foot"])
    S[n + "_toe"] = tm(J[L + "ToeBase"])
    S[n + "_shoulder"], S[n + "_elbow"], S[n + "_wrist"] = tm(J[L + "Arm"]), tm(J[L + "ForeArm"]), tm(J[L + "Hand"])
    S[n + "_hand"] = tm(J[L + "HandMiddle4"])
    S[n + "_clav"] = tm(J[L + "Shoulder"])

W = g1.fk(g1.BIND)
p = lambda nm: W[nm][:3, 3]
lift = p("left_shoulder_roll_link")[2] - S["l_shoulder"][2]          # raise the torso top to the G1 shoulders
T = {k: v.copy() for k, v in S.items()}
for k in ("chest", "neck", "top"):
    T[k] = S[k] + np.array([0, 0, lift * (0.6 if k == "chest" else 1.0)])
for s, n in ((1, "l"), (-1, "r")):
    side = "left_" if s > 0 else "right_"
    T[n + "_clav"] = S[n + "_clav"] + np.array([0, 0, lift])
    T[n + "_shoulder"] = p(side + "shoulder_roll_link")
    T[n + "_elbow"] = p(side + "elbow_link")
    T[n + "_wrist"] = p(side + "wrist_yaw_link")
    T[n + "_hand"] = T[n + "_wrist"] + W[side + "wrist_yaw_link"][:3, :3] @ np.array(
        [np.linalg.norm(S[n + "_hand"] - S[n + "_wrist"]), 0, 0])
    T[n + "_hip"] = np.array([0.0, s * 0.100, p(side + "hip_pitch_link")[2] - 0.004])
    T[n + "_knee"] = p(side + "knee_link")
    T[n + "_ankle"] = p(side + "ankle_pitch_link") + np.array([0, 0, 0.004])
    T[n + "_toe"] = T[n + "_ankle"] + (S[n + "_toe"] - S[n + "_ankle"]) * np.array([1, 0, 1])

B = [("pelvis", "pelvis", "waist", 0.12), ("spine", "waist", "chest", 0.11), ("chest", "chest", "neck", 0.11),
     ("head", "neck", "top", 0.09)]
for n in ("l", "r"):
    B += [(n + "_clav", n + "_clav", n + "_shoulder", 0.06), (n + "_upper", n + "_shoulder", n + "_elbow", 0.05),
          (n + "_fore", n + "_elbow", n + "_wrist", 0.04), (n + "_hand", n + "_wrist", n + "_hand", 0.035),
          (n + "_thigh", n + "_hip", n + "_knee", 0.07), (n + "_shin", n + "_knee", n + "_ankle", 0.055),
          (n + "_foot", n + "_ankle", n + "_toe", 0.045)]
maps = [bone_map(S[a], S[b], T[a], T[b]) for _, a, b, _ in B]
D = np.stack([seg_dist(P, S[a], S[b])[0] / r for _, a, b, r in B], 1)
Wt = 1.0 / (D ** 6 + 1e-6)
for i, (nm, *_r) in enumerate(B):
    if nm.startswith("l_"):
        Wt[P[:, 1] < 0.02, i] = 0
    if nm.startswith("r_"):
        Wt[P[:, 1] > -0.02, i] = 0
Wt /= Wt.sum(1, keepdims=True)
ev = np.zeros(len(me.edges) * 2, int)
me.edges.foreach_get("vertices", ev)
ev = ev.reshape(-1, 2)
deg = np.maximum(np.bincount(ev.ravel(), minlength=len(P)), 1).astype(float)
for _ in range(8):
    acc = np.zeros_like(Wt)
    np.add.at(acc, ev[:, 0], Wt[ev[:, 1]])
    np.add.at(acc, ev[:, 1], Wt[ev[:, 0]])
    Wt = 0.5 * Wt + 0.5 * acc / deg[:, None]
fitted = np.zeros_like(P)
for i, (A, t) in enumerate(maps):
    fitted += Wt[:, i:i + 1] * (P @ A.T + t)
fitted[:, 2] -= fitted[:, 2].min()                                    # soles on the floor
me.vertices.foreach_set("co", fitted.ravel())
me.update()
for poly in me.polygons:
    poly.use_smooth = True
log("fitted to the G1 bind pose")

# ---------------------------------------------------------------- textures: 1K, elf palette
TMP = HERE / "cache" / "knight_tex"
TMP.mkdir(parents=True, exist_ok=True)


def load(name):
    img = bpy.data.images.load(str(SRC / "textures" / name))
    img.scale(TEX, TEX)
    return img


def bake_jpeg(img, name, q=86):
    """Write the edited 1K pixels to a JPEG and point the image at it, so the exporter embeds that."""
    path = TMP / (name + ".jpg")
    img.file_format = "JPEG"
    img.save(filepath=str(path), quality=q)
    img.filepath_raw = str(path)
    img.reload()
    return img


def recolor(img, metal):
    a = np.array(img.pixels[:]).reshape(TEX, TEX, 4)
    rgb = a[..., :3]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    m = np.array(metal.pixels[:]).reshape(TEX, TEX, 4)[..., 0]
    grey = (sat < 0.18) & (mx > 0.12)
    bronze = (sat > 0.22) & (rgb[..., 0] > rgb[..., 2]) & (mx > 0.30)
    if VARIANT == "king":
        green = np.array([0.40, 0.035, 0.06])                          # crimson enamel
        gold = np.array([0.98, 0.66, 0.16])
    else:
        green = np.array([0.05, 0.36, 0.15])                           # vivid emerald enamel
        gold = np.array([0.98, 0.64, 0.14])
    lum = rgb.mean(-1, keepdims=True)
    enamel = green * (0.45 + 1.4 * lum)
    k = (0.66 * grey * np.clip(0.4 + 0.6 * m, 0, 1))[..., None]
    rgb = rgb * (1 - k) + enamel * k
    g = (0.75 * bronze)[..., None]
    rgb = rgb * (1 - g) + gold * (0.35 + 0.9 * lum) * g
    a[..., :3] = style.grade(style.paint_flatten(np.clip(rgb, 0, 1)), vibrance=0.45, sat_cap=0.8)
    img.pixels = a.ravel().tolist()
    return img


mats = {}
for i, mt in enumerate(me.materials):
    tid = {"blinn1": "ID01", "blinn2": "ID02", "blinn3": "ID03"}.get(mt.name, "ID0%d" % (i + 1))
    new = bpy.data.materials.new(f"{VARIANT}_{tid.lower()}")
    new.use_nodes = True
    nt = new.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    metal = load(f"{tid}_Metallic.png")
    base = recolor(load(f"{tid}_Base_color.png"), metal)
    rough = load(f"{tid}_Roughness.png")
    nrm = load(f"{tid}_Normal_DirectX.png")
    # DirectX -> OpenGL normal map: flip green
    px = np.array(nrm.pixels[:]).reshape(-1, 4)
    px[:, 1] = 1 - px[:, 1]
    nrm.pixels = px.ravel().tolist()
    style.matte(rough, metal, rough_floor=0.58, metal_scale=0.5)     # matte finish, shared with the other fighters
    base = bake_jpeg(base, f"{VARIANT}_{tid}_base")
    metal, rough, nrm = (bake_jpeg(metal, f"{VARIANT}_{tid}_metal"), bake_jpeg(rough, f"{VARIANT}_{tid}_rough"),
                         bake_jpeg(nrm, f"{VARIANT}_{tid}_normal", 90))
    for img in (metal, rough, nrm):
        img.colorspace_settings.name = "Non-Color"
    tb, tr, tmtl, tn = (nt.nodes.new("ShaderNodeTexImage") for _ in range(4))
    tb.image, tr.image, tmtl.image, tn.image = base, rough, metal, nrm
    nt.links.new(tb.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tr.outputs["Color"], bsdf.inputs["Roughness"])
    nt.links.new(tmtl.outputs["Color"], bsdf.inputs["Metallic"])
    nm_node = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm_node.inputs["Color"])
    nt.links.new(nm_node.outputs["Normal"], bsdf.inputs["Normal"])
    me.materials[i] = new
n_before = len(me.vertices)
if VARIANT == "king":
    import bmesh
    v = fitted
    hx, hy = T["top"][0], T["top"][1]
    zc = T["top"][2] - 0.035                     # just above the brow of the helmet (the crest sticks up past it)
    near = (np.abs(v[:, 2] - zc) < 0.006) & (np.hypot(v[:, 0] - hx, v[:, 1] - hy) < 0.15)
    ring = v[near]
    cx_, cy_ = ring[:, 0].mean(), ring[:, 1].mean()
    rad = np.percentile(np.hypot(ring[:, 0] - cx_, ring[:, 1] - cy_), 90) + 0.004
    bm = bmesh.new()
    seg = 48
    lo_r = [bm.verts.new((cx_ + rad * np.cos(t), cy_ + rad * np.sin(t), zc - 0.012)) for t in np.linspace(0, 2 * np.pi, seg, endpoint=False)]
    hi_r = []
    for i, t in enumerate(np.linspace(0, 2 * np.pi, seg, endpoint=False)):
        spike = 0.030 if i % 6 == 0 else 0.012 + 0.004 * np.cos(i * np.pi / 3)
        hi_r.append(bm.verts.new((cx_ + (rad + 0.002) * np.cos(t), cy_ + (rad + 0.002) * np.sin(t), zc + spike)))
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((lo_r[i], lo_r[j], hi_r[j], hi_r[i]))
    gems = []
    for i in range(0, seg, 6):
        t = 2 * np.pi * i / seg
        res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.0055)
        for vv in res["verts"]:
            vv.co += mathutils.Vector((cx_ + (rad + 0.003) * np.cos(t), cy_ + (rad + 0.003) * np.sin(t), zc + 0.002))
        gems += res["verts"]
    crown_me = bpy.data.meshes.new("crown")
    bm.to_mesh(crown_me)
    bm.free()
    crown = bpy.data.objects.new("Crown", crown_me)
    scene.collection.objects.link(crown)
    for mt_name in ("gold", "gem"):
        mt = bpy.data.materials.new(mt_name)
        mt.use_nodes = True
        b_ = mt.node_tree.nodes["Principled BSDF"]
        b_.inputs["Metallic"].default_value = 1.0 if mt_name == "gold" else 0.0
        b_.inputs["Roughness"].default_value = 0.4 if mt_name == "gold" else 0.1
        crown_me.materials.append(mt)
    gem_ids = set()
    nv_ring = 2 * seg
    for poly in crown_me.polygons:
        poly.material_index = 1 if min(poly.vertices) >= nv_ring else 0
    for ob in scene.objects:
        ob.select_set(ob in (knight, crown))
    bpy.context.view_layer.objects.active = knight
    bpy.ops.object.join()
    me = knight.data
    fitted = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", fitted)
    fitted = fitted.reshape(-1, 3)
    ev = np.zeros(len(me.edges) * 2, int)
    me.edges.foreach_get("vertices", ev)
    ev = ev.reshape(-1, 2)
    deg = np.maximum(np.bincount(ev.ravel(), minlength=len(fitted)), 1).astype(float)
# white vertex colors: the runtime's materials multiply by COLOR_0
ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
cols = np.ones((len(me.loops), 4), np.float32)
if VARIANT == "king":
    lv = np.zeros(len(me.loops), int)
    me.loops.foreach_get("vertex_index", lv)
    crown_v = lv >= n_before
    gem_v = lv >= n_before + 96
    cols[crown_v, :3] = [0.80, 0.48, 0.10]       # gold (linear)
    cols[gem_v, :3] = [0.05, 0.70, 0.30]         # emerald
ca.data.foreach_set("color", cols.ravel())
me.color_attributes.active_color = ca

# ---------------------------------------------------------------- rig to the G1 like the elf
rig = Rig(W, None)
arm_data = bpy.data.armatures.new(VARIANT.capitalize() + "Rig")
arm_ob = bpy.data.objects.new(VARIANT.capitalize() + "Rig", arm_data)
scene.collection.objects.link(arm_ob)
bpy.context.view_layer.objects.active = arm_ob
bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for bn, (parent, head, tail, body) in rig.bones.items():
    b = arm_data.edit_bones.new(bn)
    b.head, b.tail = head.tolist(), tail.tolist()
    eb[bn] = b
for bn, (parent, *_r) in rig.bones.items():
    if parent:
        eb[bn].parent = eb[parent]
bpy.ops.object.mode_set(mode="OBJECT")

# body-part labels from the fitted joint chains, then the elf's chain weights
chains = {"spine": ([T["pelvis"] - [0, 0, 0.06], T["waist"], T["chest"], T["neck"], T["top"]], 0.13)}
for n, s in (("l", 1), ("r", -1)):
    chains[n + "_arm"] = ([T[n + "_shoulder"], T[n + "_elbow"], T[n + "_wrist"], T[n + "_hand"]], 0.055)
    chains[n + "_leg"] = ([T[n + "_hip"], T[n + "_knee"], T[n + "_ankle"], T[n + "_toe"]], 0.08)
best = np.full(len(fitted), np.inf)
lab = np.empty(len(fitted), object)
for part, (pts, r) in chains.items():
    dmin = np.full(len(fitted), np.inf)
    for a, b in zip(pts[:-1], pts[1:]):
        dmin = np.minimum(dmin, seg_dist(fitted, np.asarray(a), np.asarray(b))[0])
    better = dmin / r < best
    best[better] = (dmin / r)[better]
    lab[better] = part
wd = {}


def acc(d, mask):
    for b, w in d.items():
        wd.setdefault(b, np.zeros(len(fitted)))[mask] += w[mask]


acc(rig.spine_weights(fitted), lab == "spine")
for n, s in (("l", 1), ("r", -1)):
    acc(rig.arm_weights(fitted, s), lab == n + "_arm")
    acc(rig.leg_weights(fitted, s), lab == n + "_leg")
names = list(wd)
Wm = np.stack([wd[n] for n in names], 1)
for _ in range(6):
    a2 = np.zeros_like(Wm)
    np.add.at(a2, ev[:, 0], Wm[ev[:, 1]])
    np.add.at(a2, ev[:, 1], Wm[ev[:, 0]])
    Wm = 0.5 * Wm + 0.5 * a2 / deg[:, None]
idx = np.argsort(-Wm, 1)[:, :4]
top = np.take_along_axis(Wm, idx, 1)
top[top < 0.01] = 0
top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
groups = {n: knight.vertex_groups.new(name=n) for n in names}
for vi in range(len(Wm)):
    for j in range(4):
        if top[vi, j] > 0:
            groups[names[idx[vi, j]]].add([vi], float(top[vi, j]), "REPLACE")
mod = knight.modifiers.new("Armature", "ARMATURE")
mod.object = arm_ob
knight.parent = arm_ob

meta = {"version": 1, "frame": "mujoco", "bind_angles": g1.BIND, "bones": {}, "springs": [], "colliders": []}
for bn, (parent, head, tail, body) in rig.bones.items():
    if body:
        Mb = W[body]
        meta["bones"][bn] = {"body": body, "pos": Mb[:3, 3].round(6).tolist(), "quat": g1.mat_quat(Mb[:3, :3]).round(6).tolist()}
arm_ob["g1_rig"] = json.dumps(meta)

for ob in scene.objects:
    ob.select_set(True)
bpy.context.view_layer.objects.active = arm_ob
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", use_selection=True, export_yup=True,
                          export_skins=True, export_animations=False, export_extras=True,
                          export_vertex_color="ACTIVE", export_image_format="JPEG", export_jpeg_quality=85,
                          export_apply=False, export_def_bones=False, export_rest_position_armature=True)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / f"{VARIANT}.blend"), copy=True)
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
