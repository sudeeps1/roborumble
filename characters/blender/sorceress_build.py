# Sorceress: an AI-generated (Tripo) hooded dark-fantasy sorceress refit onto the G1 bind pose, staff removed,
# micro-relief and filigree softened to the cast's detail level,
# cloak hem trimmed to the knee and pulled in, recolored to the elf/knight palette, rigged to the G1 bones.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P characters/blender/sorceress_build.py -- SRC.fbx
# SRC.fbx: the unzipped tripo_convert_*.fbx (textures in the .fbm folder next to it).
# Output: characters/public/sorceress.glb (1K JPEG textures, ~50k triangles).
# The source has no armature: joint landmarks below were read off cross-sections of the raw mesh
# (raw frame: meters, Z up, she faces -Y, her left is +X, body centerline x ~ 0.078).
import json
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402
import style  # noqa: E402
from fit_base import bone_map, seg_dist  # noqa: E402
from rig import Rig  # noqa: E402

SRC = Path(sys.argv[sys.argv.index("--") + 1])
FBM = SRC.with_suffix(".fbm")
OUT = HERE.parent / "public" / "sorceress.glb"
TEX = 1024
TRIS = 60000
log = lambda *a: print("[sorceress]", *a, flush=True)
A = lambda *v: np.array(v, float)

# ---------------------------------------------------------------- raw landmarks (raw mesh frame)
CX, CY = 0.078, -0.045
R = {
    "pelvis": A(CX, -0.045, 0.50), "waist": A(CX, -0.050, 0.58), "chest": A(CX, -0.050, 0.68),
    "neck": A(0.072, -0.040, 0.80), "top": A(0.068, -0.030, 0.94),
    # legs: left leg steps forward
    "r_hip": A(0.036, -0.030, 0.48), "r_knee": A(0.033, 0.010, 0.27), "r_ankle": A(0.040, 0.030, 0.085),
    "r_toe": A(0.022, -0.060, 0.010), "r_heel": A(0.040, 0.050, 0.0),
    "l_hip": A(0.120, -0.055, 0.48), "l_knee": A(0.124, -0.125, 0.28), "l_ankle": A(0.122, -0.140, 0.085),
    "l_toe": A(0.128, -0.235, 0.010), "l_heel": A(0.122, -0.120, 0.0),
    # left arm hangs relaxed; right arm bent, fist around the (removed) staff
    "l_clav": A(0.105, -0.045, 0.765), "l_shoulder": A(0.170, -0.045, 0.755), "l_elbow": A(0.240, -0.045, 0.635),
    "l_wrist": A(0.290, -0.055, 0.540), "l_hand": A(0.325, -0.060, 0.460),
    "r_clav": A(0.050, -0.045, 0.765), "r_shoulder": A(-0.015, -0.045, 0.755), "r_elbow": A(-0.080, -0.050, 0.570),
    "r_wrist": A(-0.115, -0.165, 0.625), "r_hand": A(-0.147, -0.223, 0.655),
}
STAFF0, STAFF_D = A(-0.013, -0.0715, 0.0), A(-0.185, -0.192, 1.0)   # shaft axis: p(z) = STAFF0 + z * STAFF_D
HEM_Z = 0.31                                                         # cloak hem cut (just above the knee)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.fbx(filepath=str(SRC))
ob = next(o for o in scene.objects if o.type == "MESH")
ob.data.transform(ob.matrix_world)
ob.parent = None
ob.matrix_world = np.eye(4).tolist()
ob.name = "Sorceress"
me = ob.data


def verts():
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def delete_verts(mask):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(mask)[0]], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()


co = verts()
log(f"{len(co)} verts, {len(me.polygons)} faces, height {co[:, 2].max():.3f}")

# ---------------------------------------------------------------- remove the staff, trim the hem
axis = STAFF0 + co[:, 2:3] * STAFF_D
staff = (np.hypot(co[:, 0] - axis[:, 0], co[:, 1] - axis[:, 1]) < 0.0125) & (co[:, 2] < 0.70)
staff |= (co[:, 2] > 0.69) & (co[:, 0] < -0.095) & (co[:, 1] < -0.17)                 # head ornament
legd = np.full(len(co), np.inf)
for n in ("l", "r"):
    for a, b in ((R[n + "_knee"], R[n + "_ankle"]), (R[n + "_ankle"], R[n + "_toe"]), (R[n + "_ankle"], R[n + "_heel"])):
        legd = np.minimum(legd, seg_dist(co, a, b)[0])
hem = (co[:, 2] < HEM_Z) & (legd > 0.05)
delete_verts(staff | hem)
log(f"removed {staff.sum()} staff + {hem.sum()} hem verts")

# drop the floating crumbs the cuts left (staff rings etc.)
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")
parts = [o for o in scene.objects if o.type == "MESH"]
for o in parts:
    if len(o.data.vertices) < 1500:
        bpy.data.objects.remove(o, do_unlink=True)
parts = [o for o in scene.objects if o.type == "MESH"]
for o in scene.objects:
    o.select_set(o in parts)
bpy.context.view_layer.objects.active = max(parts, key=lambda o: len(o.data.vertices))
bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
ob.name = "Sorceress"
me = ob.data
log(f"kept {len(parts)} parts, {len(me.polygons)} faces")

dec = ob.modifiers.new("dec", "DECIMATE")
dec.ratio = TRIS / max(len(me.polygons), 1)
bpy.ops.object.modifier_apply(modifier="dec")
me = ob.data
co = verts()
log(f"decimated: {len(co)} verts, {len(me.polygons)} faces")

# ---------------------------------------------------------------- smooth out the sculpted micro-relief
def taubin(co, iters, wv, lam=0.5, mu=-0.53):
    """Volume-keeping Laplacian smoothing (Taubin lambda|mu). Open-boundary verts (the cut hem, sleeve rims) only
    follow their boundary neighbors, so ragged cut edges straighten without the rim shrinking inward."""
    ev = np.zeros(len(me.edges) * 2, int)
    me.edges.foreach_get("vertices", ev)
    ev = ev.reshape(-1, 2)
    le = np.zeros(len(me.loops), int)
    me.loops.foreach_get("edge_index", le)
    eb = np.bincount(le, minlength=len(ev)) == 1
    vb = np.zeros(len(co), bool)
    vb[ev[eb].ravel()] = True
    dst = np.concatenate([ev[:, 0], ev[:, 1]])
    src = np.concatenate([ev[:, 1], ev[:, 0]])
    ok = ~vb[dst] | np.concatenate([eb, eb])
    dst, src = dst[ok], src[ok]
    dg = np.maximum(np.bincount(dst, minlength=len(co)), 1)[:, None]
    for _ in range(iters):
        for f in (lam, mu):
            acc_ = np.zeros_like(co)
            np.add.at(acc_, dst, co[src])
            co = co + f * wv[:, None] * (acc_ / dg - co)
    log(f"taubin x{iters}: {vb.sum()} boundary verts")
    return co


HEAD_C = A(0.070, -0.045, 0.860)
wv = np.clip((np.linalg.norm(co - HEAD_C, axis=1) - 0.050) / 0.025, 0.12, 1)        # keep the face
for n in ("l", "r"):
    wv = np.minimum(wv, np.clip((seg_dist(co, R[n + "_wrist"], R[n + "_hand"])[0] - 0.022) / 0.02, 0.12, 1))
co = taubin(co, 8, wv)                   # light pass: soften the sculpted relief, keep the folds
me.vertices.foreach_set("co", co.ravel())
me.update()
if me.has_custom_normals:                                             # the FBX carried the sculpt's normals
    bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
    log("cleared custom normals")

# ---------------------------------------------------------------- pull the cloak in toward the body
armd = np.full(len(co), np.inf)
for n in ("l", "r"):
    for a, b in ((R[n + "_elbow"], R[n + "_wrist"]), (R[n + "_wrist"], R[n + "_hand"])):
        armd = np.minimum(armd, seg_dist(co, a, b)[0])
legd = np.full(len(co), np.inf)
for n in ("l", "r"):
    for a, b in ((R[n + "_hip"], R[n + "_knee"]), (R[n + "_knee"], R[n + "_ankle"])):
        legd = np.minimum(legd, seg_dist(co, a, b)[0])
# region labels in 3D (0 cloak/hood, 1 dress body, 2 boots), later rasterized into UV space for the recolor
legd2 = np.full(len(co), np.inf)
for n in ("l", "r"):
    for a, b in ((R[n + "_hip"], R[n + "_knee"]), (R[n + "_knee"], R[n + "_ankle"]), (R[n + "_ankle"], R[n + "_toe"]),
                 (R[n + "_ankle"], R[n + "_heel"])):
        legd2 = np.minimum(legd2, seg_dist(co, a, b)[0])
rad = np.hypot(co[:, 0] - CX, co[:, 1] - CY)
CAT = np.zeros(len(co), int)
CAT[(rad < 0.095) & (co[:, 2] > 0.30) & (co[:, 2] < 0.76) & (armd > 0.05)] = 1
CAT[(legd2 < 0.05) & (co[:, 2] < 0.37)] = 2
# boot cuff flaps stick out at the knee: clamp them onto the leg
for n in ("l", "r"):
    a, b = R[n + "_hip"] + (R[n + "_knee"] - R[n + "_hip"]) * 0.5, R[n + "_ankle"]
    ab = b - a
    tt = np.clip(((co - a) @ ab) / (ab @ ab), 0, 1)
    q = a + tt[:, None] * ab
    dd = np.linalg.norm(co - q, axis=1)
    flap = (co[:, 2] > 0.20) & (co[:, 2] < 0.36) & (dd > 0.036) & (dd < 0.08)
    co[flap] = q[flap] + (co[flap] - q[flap]) * (0.036 / dd[flap])[:, None]
z = co[:, 2]
k = np.interp(z, [HEM_Z, 0.45, 0.64], [0.42, 0.62, 1.0])             # how much of the flare survives
free = np.clip((armd - 0.06) / 0.04, 0, 1) * np.clip((legd - 0.055) / 0.03, 0, 1)
k = 1 - (1 - k) * free
dx, dy = co[:, 0] - CX, co[:, 1] - CY
r = np.hypot(dx, dy)
r0 = 0.11
rn = np.where(r > r0, r0 + (r - r0) * k, r)
co[:, 0] = CX + dx * rn / np.maximum(r, 1e-6)
co[:, 1] = CY + dy * rn / np.maximum(r, 1e-6)
log("cloak pulled in")

# ---------------------------------------------------------------- raw frame -> MuJoCo frame, fit to the G1 bind pose
SK = 1.30 / R["top"][2]


def tm(p):
    p = np.asarray(p, float)
    return np.stack([-(p[..., 1] - CY) * SK, (p[..., 0] - CX) * SK, p[..., 2] * SK], -1)


P = tm(co)
S = {k_: tm(v) for k_, v in R.items()}
W = g1.fk(g1.BIND)
p = lambda nm: W[nm][:3, 3]
lift = p("left_shoulder_roll_link")[2] - (S["l_shoulder"][2] + S["r_shoulder"][2]) / 2
dh = p("left_hip_pitch_link")[2] - 0.004 - (S["l_hip"][2] + S["r_hip"][2]) / 2
T = {k_: v.copy() for k_, v in S.items()}
zh, zs = (S["l_hip"][2] + S["r_hip"][2]) / 2, S["l_shoulder"][2]
for k_ in ("pelvis", "waist", "chest", "neck", "top"):
    T[k_] = S[k_] + A(0, 0, float(np.interp(S[k_][2], [zh, zs], [dh, lift])))
for s, n in ((1, "l"), (-1, "r")):
    side = "left_" if s > 0 else "right_"
    T[n + "_clav"] = S[n + "_clav"] + A(0, 0, lift)
    T[n + "_shoulder"] = p(side + "shoulder_roll_link")
    T[n + "_elbow"] = p(side + "elbow_link")
    T[n + "_wrist"] = p(side + "wrist_yaw_link")
    T[n + "_hand"] = T[n + "_wrist"] + W[side + "wrist_yaw_link"][:3, :3] @ A(
        np.linalg.norm(S[n + "_hand"] - S[n + "_wrist"]), 0, 0)
    T[n + "_hip"] = A(0.0, s * 0.100, p(side + "hip_pitch_link")[2] - 0.004)
    T[n + "_knee"] = p(side + "knee_link")
    # high heels: the toe sits ~10 cm below the ankle, so raise the ankle target until the toe meets the floor
    drop = S[n + "_ankle"][2] - S[n + "_toe"][2]
    T[n + "_ankle"] = p(side + "ankle_pitch_link") + A(0, 0, max(0.004, drop - p(side + "ankle_pitch_link")[2]))
    T[n + "_toe"] = T[n + "_ankle"] + (S[n + "_toe"] - S[n + "_ankle"]) * A(1, 0, 1)
for k_ in sorted(S):
    log(f"  {k_:11s} src {np.round(S[k_], 3)}  tgt {np.round(T[k_], 3)}")

B = [("pelvis", "pelvis", "waist", 0.12), ("spine", "waist", "chest", 0.11), ("chest", "chest", "neck", 0.11),
     ("head", "neck", "top", 0.09)]
for n in ("l", "r"):
    B += [(n + "_clav", n + "_clav", n + "_shoulder", 0.06), (n + "_upper", n + "_shoulder", n + "_elbow", 0.05),
          (n + "_fore", n + "_elbow", n + "_wrist", 0.045), (n + "_hand", n + "_wrist", n + "_hand", 0.035),
          (n + "_thigh", n + "_hip", n + "_knee", 0.08), (n + "_shin", n + "_knee", n + "_ankle", 0.055),
          (n + "_foot", n + "_ankle", n + "_toe", 0.045)]
maps = [bone_map(S[a], S[b], T[a], T[b]) for _, a, b, _ in B]
D = np.stack([seg_dist(P, S[a], S[b])[0] / r_ for _, a, b, r_ in B], 1)
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
for _ in range(10):
    acc_ = np.zeros_like(Wt)
    np.add.at(acc_, ev[:, 0], Wt[ev[:, 1]])
    np.add.at(acc_, ev[:, 1], Wt[ev[:, 0]])
    Wt = 0.5 * Wt + 0.5 * acc_ / deg[:, None]
fitted = np.zeros_like(P)
for i, (Am, t) in enumerate(maps):
    fitted += Wt[:, i:i + 1] * (P @ Am.T + t)
fitted[:, 2] -= fitted[:, 2].min()                                    # heels on the floor
me.vertices.foreach_set("co", fitted.ravel())
me.update()
for poly in me.polygons:
    poly.use_smooth = True
log(f"fitted to the G1 bind pose, height {fitted[:, 2].max():.3f}")

# ---------------------------------------------------------------- textures: 1K, painted, royal violet + gold
TMP = HERE / "cache" / "sorceress_tex"
TMP.mkdir(parents=True, exist_ok=True)


def find_tex(key):
    return next(f for f in FBM.iterdir() if key in f.name.lower())


def load(key):
    img = bpy.data.images.load(str(find_tex(key)))
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


def px(img):
    return np.array(img.pixels[:], np.float32).reshape(TEX, TEX, 4)


VIOLET = A(78, 52, 128) / 255
MIDNIGHT = A(32, 34, 58) / 255
GOLD = A(232, 180, 70) / 255
TEAL = A(40, 230, 170) / 255


CLOAK = A(62, 40, 104) / 255
DRESS = A(30, 28, 48) / 255
LEATHER = A(40, 34, 44) / 255
SKIN = A(238, 196, 170) / 255


def region_map():
    """Rasterize the per-vertex region labels into a TEX x TEX map through the UVs (splat + dilate)."""
    me.calc_loop_triangles()
    lt = np.zeros(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", lt)
    ll = np.zeros(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("loops", ll)
    uv = np.zeros(len(me.loops) * 2)
    me.uv_layers[0].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)[ll].reshape(-1, 3, 2)
    c = np.max(CAT[lt.reshape(-1, 3)], 1)
    g = np.array([(i, j) for i in range(9) for j in range(9 - i)], float) / 8
    bc = np.stack([g[:, 0], g[:, 1], 1 - g[:, 0] - g[:, 1]], 1)
    pts = np.einsum("sk,tkd->tsd", bc, uv)
    ix = np.clip((pts * TEX).astype(int), 0, TEX - 1)
    m = np.full((TEX, TEX), -1)
    m[ix[..., 1].ravel(), ix[..., 0].ravel()] = np.repeat(c, len(bc))
    for _ in range(6):
        hole = m < 0
        if not hole.any():
            break
        for sh in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            r_ = np.roll(m, sh, (0, 1))
            fill = hole & (r_ >= 0) & (m < 0)
            m[fill] = r_[fill]
    m[m < 0] = 0
    return m


def recolor(base, metal, rough):
    a = px(base)
    rgb = a[..., :3].astype(float)
    m = px(metal)[..., 0]
    reg = region_map()
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    lum = (rgb * A(0.2126, 0.7152, 0.0722)).sum(-1)
    warm = rgb[..., 0] >= rgb[..., 2] - 0.02
    skin = (lum > 0.33) & (m < 0.35) & warm & (reg != 2)
    gem = (sat > 0.35) & (rgb[..., 2] > rgb[..., 0]) & (lum > 0.22) & ~skin
    lo, hi = np.percentile(lum[~skin], [5, 95])
    ln = np.clip((lum - lo) / max(hi - lo, 1e-3), 0, 1)[..., None]
    hp = lum - style._blur(lum[..., None], 6)[..., 0]                  # raised, bright embroidery
    cloth = ~skin & ~gem
    trim = cloth & ((m > 0.45) | (hp > np.percentile(hp[cloth], 92)) | (lum > np.percentile(lum[cloth], 97)))
    purple = rgb[..., 2] > rgb[..., 0] + 0.02                           # violet inner lining
    shade = 0.78 + 0.44 * ln
    out = np.where((reg == 1)[..., None] | purple[..., None], DRESS * shade, CLOAK * shade)
    out = np.where((reg == 2)[..., None], LEATHER * (0.8 + 0.5 * ln), out)
    out[trim] = (GOLD * (0.8 + 0.3 * ln))[trim]
    out[gem] = (TEAL * (0.8 + 0.3 * ln))[gem]
    out[skin] = (SKIN * (0.8 + 0.25 * ln))[skin]
    a[..., :3] = np.clip(out, 0, 1)
    base.pixels = a.ravel().tolist()
    r = px(rough)
    r[reg == 2, :3] = 0.6
    r[trim, :3] = np.minimum(r[trim, :3], 0.5)
    rough.pixels = r.ravel().tolist()
    log(f"recolor: skin {skin.mean():.2f} trim {trim.mean():.2f} gem {gem.mean():.2f} dress {(reg == 1).mean():.2f} "
        f"boots {(reg == 2).mean():.2f}")
    emis = np.zeros_like(a)
    emis[..., 3] = 1
    emis[gem, :3] = TEAL
    return base, emis


metal = load("metallic")
rough = load("roughness")
nrm = load("normal")
style.matte(rough, metal)
base, emis_px = recolor(load("basecolor"), metal, rough)
style.stylize_image(base, lift=0.0, gamma=1.0)
# detail downscale to the cast's level: fine filigree and texture noise at about half contrast (broad shapes and
# the trim stay), sculpted relief in the normal map at 40%
_a = px(base)
_a[..., :3] = _a[..., :3] * 0.55 + style._blur(_a[..., :3], 3) * 0.45
base.pixels.foreach_set(_a.ravel())
_n = px(nrm)
_n[..., :3] = _n[..., :3] * 0.4 + np.array([0.5, 0.5, 1.0], np.float32) * 0.6
nrm.pixels.foreach_set(_n.ravel())
emis = bpy.data.images.new("sorceress_emis", TEX, TEX)
emis.pixels = emis_px.ravel().tolist()
base = bake_jpeg(base, "base", 94)
metal, rough, nrm = bake_jpeg(metal, "metal"), bake_jpeg(rough, "rough"), bake_jpeg(nrm, "normal", 90)
emis = bake_jpeg(emis, "emis", 80)
for img in (metal, rough, nrm):
    img.colorspace_settings.name = "Non-Color"
mat = bpy.data.materials.new("sorceress")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
tb, tr, tmtl, tn, te = (nt.nodes.new("ShaderNodeTexImage") for _ in range(5))
tb.image, tr.image, tmtl.image, tn.image, te.image = base, rough, metal, nrm, emis
nt.links.new(tb.outputs["Color"], bsdf.inputs["Base Color"])
nt.links.new(tr.outputs["Color"], bsdf.inputs["Roughness"])
nt.links.new(tmtl.outputs["Color"], bsdf.inputs["Metallic"])
# no emission: the runtime drops the emissive map and would make her glow white
nm_node = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(tn.outputs["Color"], nm_node.inputs["Color"])
nt.links.new(nm_node.outputs["Normal"], bsdf.inputs["Normal"])
me.materials.clear()
me.materials.append(mat)
# white vertex colors: the runtime's materials multiply by COLOR_0
ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
ca.data.foreach_set("color", np.ones(len(me.loops) * 4, np.float32))
me.color_attributes.active_color = ca

# ---------------------------------------------------------------- rig to the G1 like the elf
rig = Rig(W, None)
arm_data = bpy.data.armatures.new("SorceressRig")
arm_ob = bpy.data.objects.new("SorceressRig", arm_data)
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

# body-part labels from the fitted joint chains. The cloak/robe is wide: anything that is not clearly arm or
# leg goes to the spine chain (pelvis/torso), and leg-labeled cloth above the knee rides the thighs.
chains = {"spine": ([T["pelvis"] - [0, 0, 0.06], T["waist"], T["chest"], T["neck"], T["top"]], 0.16)}
for n, s in (("l", 1), ("r", -1)):
    chains[n + "_arm"] = ([T[n + "_shoulder"], T[n + "_elbow"], T[n + "_wrist"], T[n + "_hand"]], 0.06)
    chains[n + "_leg"] = ([T[n + "_hip"], T[n + "_knee"], T[n + "_ankle"], T[n + "_toe"]], 0.07)
best = np.full(len(fitted), np.inf)
lab = np.empty(len(fitted), object)
for part, (pts, r_) in chains.items():
    dmin = np.full(len(fitted), np.inf)
    for a, b in zip(pts[:-1], pts[1:]):
        dmin = np.minimum(dmin, seg_dist(fitted, np.asarray(a), np.asarray(b))[0])
    better = dmin / r_ < best
    best[better] = (dmin / r_)[better]
    lab[better] = part
wd = {}


def acc(d, mask):
    for b, w in d.items():
        wd.setdefault(b, np.zeros(len(fitted)))[mask] += w[mask]


acc(rig.spine_weights(fitted), lab == "spine")
for n, s in (("l", 1), ("r", -1)):
    acc(rig.arm_weights(fitted, s), lab == n + "_arm")
    lw = rig.leg_weights(fitted, s)
    # cloth hanging off the thigh (far from the leg axis) shares weight with the pelvis so kicks don't tear it
    far = np.clip((best - 0.8) / 0.6, 0, 1) * (fitted[:, 2] > T[n + "_knee"][2] + 0.05)
    side = "left_" if s > 0 else "right_"
    for bn in list(lw):
        if bn != "pelvis":
            moved = lw[bn] * far * 0.5
            lw[bn] = lw[bn] - moved
            lw["pelvis"] = lw["pelvis"] + moved
    acc(lw, lab == n + "_leg")
names = list(wd)
Wm = np.stack([wd[n] for n in names], 1)
for _ in range(8):
    a2 = np.zeros_like(Wm)
    np.add.at(a2, ev[:, 0], Wm[ev[:, 1]])
    np.add.at(a2, ev[:, 1], Wm[ev[:, 0]])
    Wm = 0.5 * Wm + 0.5 * a2 / deg[:, None]
idx = np.argsort(-Wm, 1)[:, :4]
top = np.take_along_axis(Wm, idx, 1)
top[top < 0.01] = 0
top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
groups = {n: ob.vertex_groups.new(name=n) for n in names}
for vi in range(len(Wm)):
    for j in range(4):
        if top[vi, j] > 0:
            groups[names[idx[vi, j]]].add([vi], float(top[vi, j]), "REPLACE")
mod = ob.modifiers.new("Armature", "ARMATURE")
mod.object = arm_ob
ob.parent = arm_ob

meta = {"version": 1, "frame": "mujoco", "bind_angles": g1.BIND, "bones": {}, "springs": [], "colliders": []}
for bn, (parent, head, tail, body) in rig.bones.items():
    if body:
        Mb = W[body]
        meta["bones"][bn] = {"body": body, "pos": Mb[:3, 3].round(6).tolist(), "quat": g1.mat_quat(Mb[:3, :3]).round(6).tolist()}
arm_ob["g1_rig"] = json.dumps(meta)

for o in scene.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = arm_ob
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", use_selection=True, export_yup=True,
                          export_skins=True, export_animations=False, export_extras=True,
                          export_vertex_color="ACTIVE", export_image_format="JPEG", export_jpeg_quality=92,
                          export_apply=False, export_def_bones=False, export_rest_position_armature=True)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / "sorceress.blend"), copy=True)
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB), {len(me.polygons)} faces")
