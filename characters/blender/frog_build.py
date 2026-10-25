# Frog wizard: an AI-generated single-mesh statue (staffs, pedestal) cleaned up, refit onto the G1 bind pose,
# recolored to the shared palette and rigged to the G1 bones like the elf and knight.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P characters/blender/frog_build.py -- SRC_DIR
# SRC_DIR: the unzipped frog folder (source/pool2738.glb). Output: characters/public/frog.glb (1K JPEG textures).
# Source frame (after glTF import): Z up, frog faces -Y, its left is +X, soles at z~0.083 on a round pedestal.
import json
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import g1  # noqa: E402
from fit_base import bone_map, seg_dist  # noqa: E402
from rig import Rig  # noqa: E402
from style import matte, stylize_image  # noqa: E402

SRC = Path(sys.argv[sys.argv.index("--") + 1])
OUT = HERE.parent / "public" / "frog.glb"
TEX = 1024
TRIS = 50000
log = lambda *a: print("[frog]", *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=str(SRC / "source" / "pool2738.glb"))
frog = next(o for o in scene.objects if o.type == "MESH")
frog.data.transform(frog.matrix_world)
frog.parent = None
frog.matrix_world = np.eye(4).tolist()
frog.name = "Frog"
me = frog.data
src_mat = me.materials[0]

# ---------------------------------------------------------------- cut away pedestal, staffs
co = np.zeros(len(me.vertices) * 3)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
FLOOR = 0.083                                                         # sandal soles; pedestal top is below


def capsule_d(P, a, b):
    return seg_dist(P, np.asarray(a, float), np.asarray(b, float))[0]


kill = (co[:, 2] < FLOOR) | (co[:, 2] > 0.81)                         # pedestal, staff tops above the head
# front staff (frog's right hand): straight shaft, thinner radius where the fingers wrap it
s0, sd = np.array([-0.149, -0.049, 0.12]), np.array([-0.0596, -0.0667, 1.0])
ax = lambda z: s0 + sd * (z - 0.12)
d = capsule_d(co, ax(0.0), ax(1.05))
hand = (co[:, 2] > 0.43) & (co[:, 2] < 0.57)
kill |= (d < 0.030) & ~hand
kill |= (d < 0.0185) & hand
# back staff: crooked branch across the back
pts = [(-0.165, 0.058, 0.20), (-0.144, 0.058, 0.27), (0.124, 0.105, 0.72), (0.161, 0.10, 0.78), (0.19, 0.118, 0.90)]
for a, b in zip(pts[:-1], pts[1:]):
    kill |= capsule_d(co, a, b) < 0.022
# the strap that tied the staff on (left shoulder -> back of the right thigh), its loose ends and the bedroll
BST = [(-0.165, 0.058, 0.20), (-0.140, 0.058, 0.26), (-0.100, 0.068, 0.32), (-0.045, 0.082, 0.40),
       (0.005, 0.094, 0.50), (0.050, 0.103, 0.58), (0.071, 0.104, 0.62), (0.114, 0.105, 0.70),
       (0.134, 0.104, 0.74), (0.156, 0.104, 0.78), (0.171, 0.106, 0.82)]
for a, b in zip(BST[:-1], BST[1:]):
    kill |= (capsule_d(co, a, b) < 0.034) & (co[:, 1] > 0.02)
PACK = [(0.120, 0.066, 0.44), (0.120, 0.066, 0.64), (0.110, 0.055, 0.69), (0.095, 0.030, 0.70)]
for a, b in zip(PACK[:-1], PACK[1:]):
    kill |= (capsule_d(co, a, b) < 0.030) & (co[:, 1] > 0.035)
inbox = lambda lo, hi: np.all((co >= lo) & (co <= hi), 1)
kill |= inbox((0.07, -0.105, 0.37), (0.17, 0.012, 0.49))               # pouch (and the hand resting on it)
kill |= inbox((-0.135, -0.05, 0.40), (-0.055, 0.008, 0.505))           # scroll case at the right hip
kill |= np.linalg.norm(co - np.array([-0.175, -0.08, 0.50]), axis=1) < 0.042   # old staff grip (right fist)
log(f"cutting {kill.sum()} of {len(co)} verts")
bm = bmesh.new()
bm.from_mesh(me)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.where(kill)[0]], context="VERTS")
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
# drop leftover crumbs (pedestal bumps, staff rings): keep only big connected pieces
bm.verts.ensure_lookup_table()
seen = np.zeros(len(bm.verts), bool)
drop = []
for v in bm.verts:
    if seen[v.index]:
        continue
    comp, st = [], [v]
    seen[v.index] = True
    while st:
        u = st.pop()
        comp.append(u)
        for e in u.link_edges:
            w = e.other_vert(u)
            if not seen[w.index]:
                seen[w.index] = True
                st.append(w)
    if len(comp) < 400:
        drop += comp
bmesh.ops.delete(bm, geom=drop, context="VERTS")
bmesh.ops.holes_fill(bm, edges=bm.edges, sides=40)
bm.to_mesh(me)
bm.free()
me.update()
log(f"cleaned: {len(me.vertices)} verts, {len(me.polygons)} faces (dropped {len(drop)} crumb verts)")
dec = frog.modifiers.new("dec", "DECIMATE")
ntri = sum(len(p.vertices) - 2 for p in me.polygons)
dec.ratio = min(1.0, TRIS / ntri)
bpy.context.view_layer.objects.active = frog
frog.select_set(True)
bpy.ops.object.modifier_apply(modifier="dec")
co = np.zeros(len(me.vertices) * 3)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
log(f"decimated: {len(co)} verts, {len(me.polygons)} faces")

# ---------------------------------------------------------------- landmarks (source frame, from slices + views)
J = {
    "pelvis": (0.010, 0.015, 0.40), "waist": (0.012, 0.010, 0.47), "chest": (0.015, 0.010, 0.56),
    "neck": (0.015, 0.000, 0.655), "top": (0.018, -0.030, 0.80),
    "l_clav": (0.045, 0.005, 0.625), "r_clav": (-0.035, 0.010, 0.625),
    "l_shoulder": (0.100, 0.010, 0.615), "l_elbow": (0.190, 0.020, 0.535), "l_wrist": (0.160, -0.025, 0.495),
    "l_hand": (0.125, -0.075, 0.470),
    "r_shoulder": (-0.085, 0.020, 0.620), "r_elbow": (-0.165, 0.040, 0.555), "r_wrist": (-0.175, -0.035, 0.515),
    "r_hand": (-0.175, -0.090, 0.500),
    "l_hip": (0.065, -0.015, 0.40), "l_knee": (0.088, -0.048, 0.27), "l_ankle": (0.100, -0.052, 0.125),
    "l_toe": (0.068, -0.122, 0.090),
    "r_hip": (-0.045, 0.035, 0.40), "r_knee": (-0.057, 0.066, 0.27), "r_ankle": (-0.078, 0.090, 0.125),
    "r_toe": (-0.125, 0.018, 0.090),
}
J = {k: np.array(v, float) for k, v in J.items()}
SK = 1.5
cx, cy = (J["l_hip"][0] + J["r_hip"][0]) / 2, (J["l_hip"][1] + J["r_hip"][1]) / 2


def tm(p):
    p = np.asarray(p, float)
    return np.stack([-(p[..., 1] - cy) * SK, (p[..., 0] - cx) * SK, (p[..., 2] - FLOOR) * SK], -1)


P = tm(co)
S = {k: tm(v) for k, v in J.items()}

W = g1.fk(g1.BIND)
p = lambda nm: W[nm][:3, 3]
# torso: remap height so the hips land on the G1 hips and the shoulders on the G1 shoulders; head keeps its size
zh, zs = S["l_hip"][2], S["l_shoulder"][2]
Zh, Zs = p("left_hip_pitch_link")[2], p("left_shoulder_roll_link")[2]
zmap = lambda z: Zh + (z - zh) * (Zs - Zh) / (zs - zh)
T = {k: v.copy() for k, v in S.items()}
for k in ("pelvis", "waist", "chest", "l_clav", "r_clav"):
    T[k][2] = zmap(S[k][2])
for k in ("neck", "top"):
    T[k][2] = S[k][2] + (Zs - zs)
for k in ("pelvis", "waist", "chest", "neck", "top", "l_clav", "r_clav"):
    T[k][:2] = S[k][:2] * np.array([0.5, 1.0])                         # pull the torso over the G1 root
for s, n in ((1, "l"), (-1, "r")):
    side = "left_" if s > 0 else "right_"
    T[n + "_shoulder"] = p(side + "shoulder_roll_link")
    T[n + "_elbow"] = p(side + "elbow_link")
    T[n + "_wrist"] = p(side + "wrist_yaw_link")
    T[n + "_hand"] = T[n + "_wrist"] + W[side + "wrist_yaw_link"][:3, :3] @ np.array(
        [np.linalg.norm(S[n + "_hand"] - S[n + "_wrist"]), 0, 0])
    T[n + "_hip"] = np.array([0.0, s * 0.100, p(side + "hip_pitch_link")[2] - 0.004])
    T[n + "_knee"] = p(side + "knee_link")
    T[n + "_ankle"] = p(side + "ankle_pitch_link") + np.array([0, 0, 0.004])
    toe = S[n + "_toe"] - S[n + "_ankle"]
    T[n + "_toe"] = T[n + "_ankle"] + np.array([np.linalg.norm(toe[:2]), 0, toe[2]])   # feet point straight ahead

B = [("pelvis", "pelvis", "waist", 0.12), ("spine", "waist", "chest", 0.11), ("chest", "chest", "neck", 0.11),
     ("head", "neck", "top", 0.13)]
for n in ("l", "r"):
    B += [(n + "_clav", n + "_clav", n + "_shoulder", 0.06), (n + "_upper", n + "_shoulder", n + "_elbow", 0.05),
          (n + "_fore", n + "_elbow", n + "_wrist", 0.04), (n + "_hand", n + "_wrist", n + "_hand", 0.035),
          (n + "_thigh", n + "_hip", n + "_knee", 0.07), (n + "_shin", n + "_knee", n + "_ankle", 0.055),
          (n + "_foot", n + "_ankle", n + "_toe", 0.045)]
maps = [bone_map(S[a], S[b], T[a], T[b]) for _, a, b, _ in B]
D = np.stack([seg_dist(P, S[a], S[b])[0] / r for _, a, b, r in B], 1)
Wt = 1.0 / (D ** 6 + 1e-6)
Pmid = (S["l_hip"][1] + S["r_hip"][1]) / 2
for i, (nm, *_r) in enumerate(B):
    if nm.startswith("l_"):
        Wt[P[:, 1] < 0.02, i] = 0
    if nm.startswith("r_"):
        Wt[P[:, 1] > -0.02, i] = 0
    if nm in ("l_upper", "l_fore", "l_hand"):                          # left hand rests on the pouch: cut it free
        Wt[P[:, 2] < (0.455 - FLOOR) * SK, i] = 0
Wt /= np.maximum(Wt.sum(1, keepdims=True), 1e-12)
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
# cut free what the warp tore apart (hand fused to the hip): drop faces whose edges stretched a lot
src_len = np.linalg.norm(P[ev[:, 0]] - P[ev[:, 1]], axis=1)
fit_len = np.linalg.norm(fitted[ev[:, 0]] - fitted[ev[:, 1]], axis=1)
bad_e = (fit_len > 2.2 * src_len + 0.006)
me.vertices.foreach_set("co", fitted.ravel())
me.update()
# the statue's forearms and hands (staff grip, hand on the pouch) are rebuilt procedurally: drop them
bnames = [b[0] for b in B]
fore = np.zeros(len(P), bool)
for n in ("l", "r"):
    fore |= (Wt[:, bnames.index(n + "_fore")] + Wt[:, bnames.index(n + "_hand")]) > 0.4
bm = bmesh.new()
bm.from_mesh(me)
bm.edges.ensure_lookup_table()
bm.verts.ensure_lookup_table()
bad_f = {f for i in np.where(bad_e)[0] for f in bm.edges[i].link_faces}
bad_f |= {f for i in np.where(fore)[0] for f in bm.verts[i].link_faces}
bmesh.ops.delete(bm, geom=list(bad_f), context="FACES_ONLY")
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context="VERTS")
bm.to_mesh(me)
bm.free()
me.update()
log(f"cut {len(bad_f)} torn / forearm faces")
fist_mat = bpy.data.materials.new("frog_fist")


def blob(bmx, c, radii, R, seg=14):
    """Add an ellipsoid (radii along R's columns) to a bmesh; the voxel remesh fuses all blobs into one skin."""
    g = bmesh.ops.create_uvsphere(bmx, u_segments=seg, v_segments=max(6, seg * 2 // 3), radius=1.0)
    for v in g["verts"]:
        v.co = (np.asarray(c) + R @ (np.array(v.co) * np.asarray(radii))).tolist()


def tube(bmx, a, b, ra, rb, R=np.eye(3)):
    a, b = np.asarray(a, float), np.asarray(b, float)
    n = max(2, int(np.linalg.norm(b - a) / 0.005) + 1)
    for t in np.linspace(0, 1, n):
        r = ra + (rb - ra) * t
        blob(bmx, a + (b - a) * t, (r, r, r), R, seg=12)


fists = []
ARMS = []
for n, side, s in (("l", "left_", 1), ("r", "right_", -1)):
    abm = bmesh.new()
    R = W[side + "wrist_yaw_link"][:3, :3]
    xa, ya, za = R[:, 0], R[:, 1], R[:, 2]
    wr = T[n + "_wrist"]
    tube(abm, T[n + "_elbow"] + (wr - T[n + "_elbow"]) * 0.0, wr, 0.034, 0.024)         # forearm plugs the sleeve
    bmesh.ops.triangulate(abm, faces=abm.faces)
    ARMS.append((np.array([v.co for v in abm.verts]), np.array([[v.index for v in f.verts] for f in abm.faces])))
    abm.free()
    fm = bpy.data.meshes.new("hand_" + n)
    fbm = bmesh.new()
    blob(fbm, wr + xa * 0.004, (0.026, 0.022, 0.024), R)                                  # wrist
    pc = wr + xa * 0.036
    blob(fbm, pc, (0.032, 0.016, 0.030), R)                                               # palm
    pn = -s * ya                                                                           # palm faces the body
    for a in (-0.62, -0.2, 0.22, 0.62):
        d = np.cos(a) * xa + np.sin(a) * za
        b0 = pc + d * 0.020
        b1 = b0 + d * 0.030
        d2 = d * np.cos(0.45) + pn * np.sin(0.45)
        b2 = b1 + d2 * 0.022
        tube(fbm, b0, b1, 0.0095, 0.0085)
        tube(fbm, b1, b2, 0.0085, 0.0085)
        blob(fbm, b2 + d2 * 0.004, (0.0135, 0.0135, 0.0135), np.eye(3))                  # sticky pad
    fbm.to_mesh(fm)
    fbm.free()
    fo = bpy.data.objects.new("hand_" + n, fm)
    scene.collection.objects.link(fo)
    fm.materials.append(fist_mat)
    fists.append(fo)
me = frog.data
for poly in me.polygons:
    poly.use_smooth = True
fitted = np.zeros(len(me.vertices) * 3)
me.vertices.foreach_get("co", fitted)
fitted = fitted.reshape(-1, 3)
ev = np.zeros(len(me.edges) * 2, int)
me.edges.foreach_get("vertices", ev)
ev = ev.reshape(-1, 2)
deg = np.maximum(np.bincount(ev.ravel(), minlength=len(fitted)), 1).astype(float)
log(f"fitted to the G1 bind pose, height {fitted[:, 2].max():.3f} m")

# ---------------------------------------------------------------- textures: 1K, shared palette
TMP = HERE / "cache" / "frog_tex"
TMP.mkdir(parents=True, exist_ok=True)


def bake_jpeg(img, name, q=86):
    """Write the edited 1K pixels to a JPEG and point the image at it, so the exporter embeds that."""
    path = TMP / (name + ".jpg")
    img.file_format = "JPEG"
    img.save(filepath=str(path), quality=q)
    img.filepath_raw = str(path)
    img.source = "FILE"
    img.reload()
    return img


def tex_of(socket_name):
    """The image feeding a Principled input in the imported material (through Separate Color if needed)."""
    bsdf = next(n for n in src_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node = bsdf.inputs[socket_name].links[0].from_node
    while node.type != "TEX_IMAGE":
        node = next(i for i in node.inputs if i.is_linked).links[0].from_node
    return node.image


def lin(c):
    return np.asarray(c, float) / 255                                 # image pixels are sRGB-encoded


def recolor(img):
    a = np.array(img.pixels[:], np.float32).reshape(TEX, TEX, 4)
    rgb = a[..., :3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    lum = (rgb * np.array([0.2126, 0.7152, 0.0722])).sum(-1)
    warm = (r > b) & (r >= g * 0.95)
    teal = ~warm & (sat > 0.12)
    hue = np.degrees(np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)) % 360
    blue = (hue > 186) & (hue < 240)
    cls = [
        (teal & (lum > 0.30) & ~blue, (64, 140, 128)),                  # frog skin
        (teal & ((lum <= 0.30) & (b >= g) | blue), (56, 88, 120)),      # trousers: slate blue, not frog teal
        (teal & (lum <= 0.30) & (b < g), (40, 104, 72)),                # shirt
        (warm & (sat > 0.45) & (mx > 0.62), (232, 180, 70)),            # buckles, trims
        (warm & (sat > 0.25) & (mx <= 0.62) & (mx > 0.22), (112, 66, 38)),  # vest leather
        (warm & (sat > 0.2) & (mx <= 0.22), (70, 42, 26)),              # dark trims
        (warm & (sat <= 0.25) & (lum > 0.35), (214, 196, 160)),         # wraps, sock cloth
    ]
    out = rgb.copy()
    global CLS
    CLS = np.full(rgb.shape[:2], -1, np.int8)
    for k, (mask, _c) in enumerate(cls):
        CLS[mask & (CLS < 0)] = k
    for mask, col in cls:
        col = np.array(col, float) / 255
        ref = (col * np.array([0.2126, 0.7152, 0.0722])).sum()
        shade = np.clip(lum / max(ref, 1e-4), 0.55, 1.1)[..., None]
        tgt = np.clip(col * shade, 0, 1)
        w = (mask * 0.95)[..., None]
        out = out * (1 - w) + tgt * w
    a[..., :3] = out
    img.pixels = a.ravel().tolist()
    return img


def gray_image(name, chan_px):
    img = bpy.data.images.new(name, TEX, TEX)
    a = np.ones((TEX, TEX, 4), np.float32)
    a[..., :3] = chan_px[..., None]
    img.pixels = a.ravel().tolist()
    return img


base = tex_of("Base Color")
base.scale(TEX, TEX)
base = stylize_image(recolor(base), flatten=False, lift=0.0, gamma=1.0, vibrance=0.25, sat_cap=0.85, warm=0.0)
PX_BASE = np.array(base.pixels[:], np.float32).reshape(TEX, TEX, 4)[..., :3].copy()
mr = tex_of("Roughness")
mr.scale(TEX, TEX)
mrp = np.array(mr.pixels[:], np.float32).reshape(TEX, TEX, 4)
rough = gray_image("frog_rough", mrp[..., 1])
metal = gray_image("frog_metal", mrp[..., 2])
matte(rough, metal, rough_floor=0.72, metal_scale=0.15)
nrm = tex_of("Normal")
nrm.scale(TEX, TEX)
base = bake_jpeg(base, "frog_base")
rough, metal, nrm = bake_jpeg(rough, "frog_rough"), bake_jpeg(metal, "frog_metal"), bake_jpeg(nrm, "frog_normal", 90)
for img in (metal, rough, nrm):
    img.colorspace_settings.name = "Non-Color"
# ---------------------------------------------------------------- bake the texture into vertex colors, then
# voxel-remesh everything (statue + procedural arms/hands) into one watertight skin and carry the colors over
FAMS = ["skin", "legging", "tunic", "gold", "leather", "leather_dark", "wrap"]
SKIN = np.array((64, 140, 128), float) / 255
px = PX_BASE
nl = len(me.loops)
uv = np.zeros(nl * 2, np.float32)
me.uv_layers.active.data.foreach_get("uv", uv)
uv = uv.reshape(-1, 2)
lv = np.zeros(nl, np.int64)
me.loops.foreach_get("vertex_index", lv)
pmat = np.zeros(len(me.polygons), np.int64)
me.polygons.foreach_get("material_index", pmat)
ltot = np.zeros(len(me.polygons), np.int64)
me.polygons.foreach_get("loop_total", ltot)
lmat = np.repeat(pmat, ltot)
ix = np.clip((uv[:, 0] % 1.0) * TEX, 0, TEX - 1).astype(int)
iy = np.clip((uv[:, 1] % 1.0) * TEX, 0, TEX - 1).astype(int)
lcol = px[iy, ix].astype(float)
lcls = CLS[iy, ix].astype(int)
lcls[lcls < 0] = 4
nv = len(me.vertices)
vcol = np.zeros((nv, 3))
np.add.at(vcol, lv, lcol)
vcol /= np.maximum(np.bincount(lv, minlength=nv), 1)[:, None]
vcls = np.zeros(nv, int)
vcls[lv] = lcls
old_co = np.zeros(nv * 3)
me.vertices.foreach_get("co", old_co)
old_co = old_co.reshape(-1, 3)
bm = bmesh.new()
bm.from_mesh(me)
nb0 = sum(e.is_boundary for e in bm.edges)
bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)    # seal tears (no new verts)
bmesh.ops.triangulate(bm, faces=bm.faces)
log(f"hole fill: {nb0} -> {sum(e.is_boundary for e in bm.edges)} boundary edges")
bm.to_mesh(me)
bm.free()
me.update()
Ts = np.zeros(len(me.polygons) * 3, np.int64)
me.polygons.foreach_get("vertices", Ts)
Ts = Ts.reshape(-1, 3)
Vh, Th = [], []
for Va, Ta in ARMS:
    Th.append(Ta + sum(len(v) for v in Vh))
    Vh.append(Va)
for fo in fists:
    fme = fo.data
    fme.calc_loop_triangles()
    t_ = np.zeros(len(fme.loop_triangles) * 3, np.int64)
    fme.loop_triangles.foreach_get("vertices", t_)
    c_ = np.zeros(len(fme.vertices) * 3)
    fme.vertices.foreach_get("co", c_)
    Th.append(t_.reshape(-1, 3) + sum(len(v) for v in Vh))
    Vh.append(c_.reshape(-1, 3))
Vh, Th = np.concatenate(Vh), np.concatenate(Th)
log("procedural forearms + frog hands")
import frog_geo  # noqa: E402
Va, Ta = frog_geo.soup_skin(Vh, Th)
log(f"  hands: {len(Va)} verts")
V = np.concatenate([old_co, Va])
Tn = np.concatenate([Ts, Ta + len(old_co)])
extra = Vh
old_co = np.concatenate([old_co, extra])
vcol = np.concatenate([vcol, np.tile(SKIN * 0.92, (len(extra), 1))])
vcls = np.concatenate([vcls, np.zeros(len(extra), int)])
for fo in fists:
    bpy.data.objects.remove(fo)
nme = bpy.data.meshes.new("Frog")
nme.from_pydata(V.tolist(), [], Tn.tolist())
nme.validate()
frog.data = nme
me = nme
bpy.context.view_layer.objects.active = frog
for ob in scene.objects:
    ob.select_set(ob == frog)
ntri = len(me.polygons)
dec = frog.modifiers.new("dec", "DECIMATE")
dec.ratio = min(1.0, TRIS / ntri)
bpy.ops.object.modifier_apply(modifier="dec")
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.triangulate(bm, faces=bm.faces)
bm.to_mesh(me)
bm.free()
fitted = np.zeros(len(me.vertices) * 3)
me.vertices.foreach_get("co", fitted)
fitted = fitted.reshape(-1, 3)
log(f"remeshed: {len(fitted)} verts, {len(me.polygons)} tris (from {ntri})")
from mathutils.kdtree import KDTree  # noqa: E402
kd = KDTree(len(old_co))
for i, c in enumerate(old_co):
    kd.insert(c, i)
kd.balance()
ncol = np.zeros((len(fitted), 3))
ncls = np.zeros(len(fitted), int)
for i, c in enumerate(fitted):
    hits = kd.find_n(c, 4)
    ws = np.array([1.0 / (h[2] + 1e-4) for h in hits])
    ids = [h[1] for h in hits]
    ncol[i] = (vcol[ids] * ws[:, None]).sum(0) / ws.sum()
    ncls[i] = vcls[ids[0]]
lin_ = np.where(ncol <= 0.04045, ncol / 12.92, ((ncol + 0.055) / 1.055) ** 2.4)
for mt in list(me.materials):
    pass
me.materials.clear()
for nm in FAMS:
    mt = bpy.data.materials.new(nm)
    mt.use_nodes = True
    nt = mt.node_tree
    cn = nt.nodes.new("ShaderNodeVertexColor")
    cn.layer_name = "Col"
    bs = nt.nodes["Principled BSDF"]
    nt.links.new(cn.outputs["Color"], bs.inputs["Base Color"])
    bs.inputs["Roughness"].default_value = {"skin": 0.5, "gold": 0.45}.get(nm, 0.78)
    me.materials.append(mt)
tri = np.zeros(len(me.polygons) * 3, np.int64)
me.polygons.foreach_get("vertices", tri)
tri = tri.reshape(-1, 3)
c3 = ncls[tri]
fcls = np.where(c3[:, 1] == c3[:, 2], c3[:, 1], c3[:, 0])
me.polygons.foreach_set("material_index", fcls.astype(np.int32))
me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
lv = np.zeros(len(me.loops), np.int64)
me.loops.foreach_get("vertex_index", lv)
ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
ca.data.foreach_set("color", np.concatenate([lin_[lv], np.ones((len(lv), 1))], 1).astype(np.float32).ravel())
me.color_attributes.active_color = ca
me.update()
ev = np.zeros(len(me.edges) * 2, int)
me.edges.foreach_get("vertices", ev)
ev = ev.reshape(-1, 2)
deg = np.maximum(np.bincount(ev.ravel(), minlength=len(fitted)), 1).astype(float)

# ---------------------------------------------------------------- rig to the G1 like the elf
rig = Rig(W, None)
arm_data = bpy.data.armatures.new("FrogRig")
arm_ob = bpy.data.objects.new("FrogRig", arm_data)
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
groups = {n: frog.vertex_groups.new(name=n) for n in names}
for vi in range(len(Wm)):
    for j in range(4):
        if top[vi, j] > 0:
            groups[names[idx[vi, j]]].add([vi], float(top[vi, j]), "REPLACE")
mod = frog.modifiers.new("Armature", "ARMATURE")
mod.object = arm_ob
frog.parent = arm_ob

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
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / "frog.blend"), copy=True)
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")

# post-pass (frog_fix.py, also runnable alone on frog.blend): head/arm skin cleanup, team-green 'tunic' shirt,
# matching 'wrap' leg wraps, back-staff hip flap pinned to the pelvis; re-exports frog.glb + frog.blend
try:
    _fx = HERE / "frog_fix.py"
    exec(compile(_fx.read_text(), str(_fx), "exec"), {"__file__": str(_fx), "__name__": "frog_fix"})
except Exception as _e:  # noqa: BLE001
    log(f"frog_fix failed, shipping the base build: {_e}")
