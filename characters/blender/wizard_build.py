# Wizard: a rigged low-poly "poly art" model (3ds Max biped, palette texture) brought into the shared style:
# staff removed, smooth-subdivided for rounder semi-real forms, palette turned into graded vertex colors with
# the same material families as the elf (skin, hair, tunic, leather, gold...), fitted onto the G1 bind pose
# from its own skeleton and rigged to the G1 bones like the knight.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P characters/blender/wizard_build.py -- WIZARD.fbx
# The palette PNG (med_people_pal.png) must sit next to the FBX. Output: characters/public/wizard.glb
import json
import sys
from pathlib import Path

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402
import sdf  # noqa: E402
import style  # noqa: E402
from fit_base import bone_map, seg_dist  # noqa: E402
from rig import Rig  # noqa: E402

SRC = Path(sys.argv[sys.argv.index("--") + 1])
OUT = HERE.parent / "public" / "wizard.glb"
SUBDIV = 2
log = lambda *a: print("[wizard]", *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.fbx(filepath=str(SRC))
src_arm = next(o for o in scene.objects if o.type == "ARMATURE")
src_arm.data.pose_position = "REST"
src_arm.animation_data_clear()
J = {b.name.replace("bip ", ""): np.array(src_arm.matrix_world @ b.head_local) for b in src_arm.data.bones}

pal_img = bpy.data.images.load(str(SRC.parent / "med_people_pal.png"))
PW, PH = pal_img.size
PAL = np.array(pal_img.pixels[:], np.float32).reshape(PH, PW, 4)[..., :3]      # row 0 = bottom (v = 0)

# ---------------------------------------------------------------- meshes: drop the staff, subdivide, bake to world
for ob in [o for o in scene.objects if o.type == "MESH" and "staff" in o.name.lower()]:
    bpy.data.objects.remove(ob, do_unlink=True)
meshes = [o for o in scene.objects if o.type == "MESH"]
for ob in meshes:
    m = ob.modifiers.new("subd", "SUBSURF")
    m.levels = m.render_levels = SUBDIV
    m.uv_smooth = "NONE"                          # keep every sub-face inside its palette cell
dg = bpy.context.evaluated_depsgraph_get()
V, Fc, UVc, FAM, OBJ = [], [], [], [], []
head_top = 0.0
vbase = 0


# palette cell (sRGB 0-255) -> (material family, color in the cast's palette; see elf_common.COLORS). The robe is
# authored in the elf's team green because the runtime hue-rotates "tunic" to crimson for player 2.
CURATE = {
    (39, 70, 80): ("tunic", (32, 90, 60)), (26, 44, 63): ("legging", (34, 38, 56)), (53, 95, 97): ("tunic", (32, 90, 60)),
    (251, 206, 189): ("skin", (228, 180, 152)), (252, 218, 205): ("skin", (232, 188, 162)),
    (250, 200, 181): ("skin", (224, 174, 146)), (251, 187, 172): ("skin", (214, 156, 132)),
    (250, 182, 165): ("skin", (208, 148, 124)), (212, 140, 114): ("skin", (52, 34, 30)),
    (35, 35, 35): ("leather_dark", (70, 42, 26)), (10, 10, 10): ("leather_dark", (50, 32, 22)),
    (3, 3, 3): ("leather_dark", (40, 27, 20)),
    (203, 106, 106): ("leather", (176, 128, 58)),            # salmon trim -> ochre embroidery
    (201, 139, 115): ("leather", (112, 66, 38)),
    (243, 243, 243): ("hair", (206, 202, 192)), (206, 206, 206): ("hair", (172, 168, 160)),
    (156, 156, 156): ("hair", (154, 150, 144)),
}
CK = np.array(list(CURATE), float)


def curate(rgb):
    return CURATE[tuple(CK[np.argmin(((CK - np.asarray(rgb) * 255) ** 2).sum(1))].astype(int))]


for ob in meshes:
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    me.transform(ob.matrix_world)
    co = np.array([v.co[:] for v in me.vertices])
    co = np.stack([co[:, 0], -co[:, 2], co[:, 1]], 1)       # the importer leaves meshes Y-up; bones are Z-up
    if "head" in ob.name:
        head_top = co[:, 2].max()
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        cu = np.array([uv[li].uv[:] for li in poly.loop_indices])
        u, v = cu.mean(0)
        fam = curate(PAL[min(int(v * PH), PH - 1), min(int(u * PW), PW - 1)])
        V_idx = [vbase + vi for vi in poly.vertices]
        Fc.append(V_idx)
        UVc.append(cu)
        FAM.append(fam)
        OBJ.append(ob.name)
    V.append(co)
    vbase += len(co)
V = np.concatenate(V)
log(f"{len(V)} verts, {len(Fc)} faces after subdivision; head top {head_top:.3f}")
fams, counts = np.unique([f[0] for f in FAM], return_counts=True)
log("families", dict(zip(fams.tolist(), counts.tolist())))
for ob in list(scene.objects):
    bpy.data.objects.remove(ob, do_unlink=True)

# ---------------------------------------------------------------- fit onto the G1 bind pose (as in knight_build)
SK = 1.33 / head_top                    # head (not the hat) lands at the G1's head height
cy = (J["L Calf"][1] + J["R Calf"][1]) / 2


def tm(p):
    p = np.asarray(p, float)
    return np.stack([-(p[..., 1] - cy) * SK, p[..., 0] * SK, p[..., 2] * SK], -1)


P = tm(V)
S = {"pelvis": tm(J["Pelvis"]), "waist": tm(J["Spine"]), "chest": tm(J["Spine1"]), "neck": tm(J["Neck"]),
     "top": tm(J["Head"]) + np.array([0, 0, (head_top - J["Head"][2]) * SK])}
for s, L in ((1, "L"), (-1, "R")):
    n = "l" if s > 0 else "r"
    S[n + "_hip"], S[n + "_knee"], S[n + "_ankle"] = tm(J[L + " Thigh"]), tm(J[L + " Calf"]), tm(J[L + " Foot"])
    S[n + "_toe"] = tm(J[L + " Toe0"])
    S[n + "_clav"] = tm(J[L + " Clavicle"])
    S[n + "_shoulder"], S[n + "_elbow"], S[n + "_wrist"] = tm(J[L + " UpperArm"]), tm(J[L + " Forearm"]), tm(J[L + " Hand"])
    S[n + "_hand"] = tm(J[L + " Finger11"])
W = g1.fk(g1.BIND)
p = lambda nm: W[nm][:3, 3]
lift = p("left_shoulder_roll_link")[2] - S["l_shoulder"][2]
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
    B += [(n + "_clav", n + "_clav", n + "_shoulder", 0.06), (n + "_upper", n + "_shoulder", n + "_elbow", 0.045),
          (n + "_fore", n + "_elbow", n + "_wrist", 0.04), (n + "_hand", n + "_wrist", n + "_hand", 0.035),
          (n + "_thigh", n + "_hip", n + "_knee", 0.07), (n + "_shin", n + "_knee", n + "_ankle", 0.055),
          (n + "_foot", n + "_ankle", n + "_toe", 0.045)]
maps = [bone_map(S[a], S[b], T[a], T[b]) for _, a, b, _ in B]
for i, (nm, a, *_r) in enumerate(B):           # the poly-art hands are oversized: shrink them about the wrist
    if nm.endswith("_hand"):
        A_ = maps[i][0] * 0.76
        maps[i] = (A_, T[a] - A_ @ S[a])
D = np.stack([seg_dist(P, S[a], S[b])[0] / r for _, a, b, r in B], 1)
Wt = 1.0 / (D ** 6 + 1e-6)
for i, (nm, *_r) in enumerate(B):
    if nm.startswith("l_"):
        Wt[P[:, 1] < 0.02, i] = 0
    if nm.startswith("r_"):
        Wt[P[:, 1] > -0.02, i] = 0
Wt /= Wt.sum(1, keepdims=True)
edges = np.array([(f[i], f[(i + 1) % len(f)]) for f in Fc for i in range(len(f))])
deg = np.maximum(np.bincount(edges.ravel(), minlength=len(P)), 1).astype(float)
for _ in range(8):
    acc_ = np.zeros_like(Wt)
    np.add.at(acc_, edges[:, 0], Wt[edges[:, 1]])
    np.add.at(acc_, edges[:, 1], Wt[edges[:, 0]])
    Wt = 0.5 * Wt + 0.5 * acc_ / deg[:, None]
fitted = np.zeros_like(P)
for i, (A, t) in enumerate(maps):
    fitted += Wt[:, i:i + 1] * (P @ A.T + t)
fitted[:, 2] -= fitted[:, 2].min()
log("fitted to the G1 bind pose; height", round(fitted[:, 2].max(), 3))
for fi, f in enumerate(Fc):                    # pale slippers -> leather boots like the rest of the cast
    if FAM[fi][0] in ("skin", "hair") and fitted[f, 2].mean() < 0.16:
        FAM[fi] = ("leather", (96, 58, 34))

# ---------------------------------------------------------------- mesh, graded palette colors, family materials
me = bpy.data.meshes.new("Wizard")
me.from_pydata(fitted.tolist(), [], Fc)
me.validate()
me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
names = ["skin", "hair", "tunic", "legging", "leather", "leather_dark"]
for nm in names:
    mt = bpy.data.materials.new(nm)
    mt.use_nodes = True
    nt = mt.node_tree
    cn = nt.nodes.new("ShaderNodeVertexColor")
    cn.layer_name = "Col"
    bs = nt.nodes["Principled BSDF"]
    nt.links.new(cn.outputs["Color"], bs.inputs["Base Color"])
    bs.inputs["Roughness"].default_value = {"skin": 0.55, "hair": 0.45, "tunic": 0.85}.get(nm, 0.62)
    me.materials.append(mt)
me.polygons.foreach_set("material_index", np.array([names.index(f[0]) for f in FAM], np.int32))
corner_v = np.concatenate([np.asarray(f) for f in Fc])
corner_f = np.repeat(np.arange(len(Fc)), [len(f) for f in Fc])
fam_c = np.array([FAM[f][0] for f in corner_f])
C = np.array([FAM[f][1] for f in corner_f], float) / 255
C = np.where(C <= 0.04045, C / 12.92, ((C + 0.055) / 1.055) ** 2.4)                 # sRGB -> linear
# ambient occlusion: short hemisphere rays against the fitted mesh
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
me.update()
Nv = np.zeros(len(fitted) * 3)
me.vertices.foreach_get("normal", Nv)
Nv = Nv.reshape(-1, 3)
bvh = BVHTree.FromPolygons(fitted.tolist(), Fc)
rng = np.random.default_rng(3)
dirs = rng.normal(size=(24, 3))
dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
ao = np.zeros(len(fitted))
for vi in range(len(fitted)):
    n = Nv[vi]
    o = Vector(fitted[vi] + n * 0.002)
    hit = tot = 0.0
    for d in dirs:
        c = d @ n
        if c <= 0.05:
            d, c = -d, -c
            if c <= 0.05:
                continue
        loc, _n, _i, dist = bvh.ray_cast(o, Vector(d), 0.10)
        tot += c
        if loc is not None:
            hit += c * (1 - dist / 0.10) ** 0.5
    ao[vi] = 1 - hit / max(tot, 1e-6)
log("ao done; mean", round(ao.mean(), 3))
noise = sdf.fbm(fitted.astype(sdf.F), 60, 3)
fine = sdf.fbm(fitted.astype(sdf.F), 400, 2)
v = corner_v
var = 1 + 0.07 * noise[v] + 0.03 * fine[v]
hair_ = fam_c == "hair"
var[hair_] = 1 + 0.10 * noise[v][hair_] + 0.05 * fine[v][hair_]
cloth = np.isin(fam_c, ["tunic", "legging", "leather", "leather_dark"])
var[cloth] = 1 + 0.12 * noise[v][cloth] + 0.08 * fine[v][cloth]
z = fitted[v, 2]
var *= 0.86 + 0.14 * np.clip(z / 0.9, 0, 1)                    # robes darken toward the hem, like the elf
C = C * var[:, None]
floor_ = np.where(fam_c == "skin", 0.55, 0.35)
C = C * (floor_ + (1 - floor_) * ao[v] ** 1.2)[:, None]
ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
ca.data.foreach_set("color", np.concatenate([C, np.ones((len(C), 1))], 1).astype(np.float32).ravel())
me.color_attributes.active_color = ca
wiz = bpy.data.objects.new("Wizard", me)
scene.collection.objects.link(wiz)

# ---------------------------------------------------------------- rig to the G1 like the elf
rig = Rig(W, None)
arm_data = bpy.data.armatures.new("WizardRig")
arm_ob = bpy.data.objects.new("WizardRig", arm_data)
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
bones = list(wd)
Wm = np.stack([wd[n] for n in bones], 1)
for _ in range(6):
    a2 = np.zeros_like(Wm)
    np.add.at(a2, edges[:, 0], Wm[edges[:, 1]])
    np.add.at(a2, edges[:, 1], Wm[edges[:, 0]])
    Wm = 0.5 * Wm + 0.5 * a2 / deg[:, None]
idx = np.argsort(-Wm, 1)[:, :4]
top = np.take_along_axis(Wm, idx, 1)
top[top < 0.01] = 0
top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
groups = {n: wiz.vertex_groups.new(name=n) for n in bones}
for vi in range(len(Wm)):
    for j in range(4):
        if top[vi, j] > 0:
            groups[bones[idx[vi, j]]].add([vi], float(top[vi, j]), "REPLACE")
mod = wiz.modifiers.new("Armature", "ARMATURE")
mod.object = arm_ob
wiz.parent = arm_ob
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
                          export_vertex_color="ACTIVE", export_apply=False, export_def_bones=False,
                          export_rest_position_armature=True)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / "wizard.blend"), copy=True)
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
