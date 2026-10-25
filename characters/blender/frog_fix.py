# Post-pass on the built frog (run after frog_build.py, on characters/public/frog.blend):
#   Blender -b characters/public/frog.blend --python-exit-code 1 -P characters/blender/frog_fix.py
# 1. head + arms: the blue trouser key caught shaded skin -> force skin family + graded skin teal
# 2. shirt (torso, blue) -> team green 'tunic' so P2 hue-rotates to crimson
# 3. leg wraps -> one matching 'wrap' colour on both shins, darker lower band
import pathlib
import bpy
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "public" / "frog.glb"
arm_ob = next(o for o in bpy.data.objects if o.type == "ARMATURE")
frog = next(o for o in bpy.data.objects if o.type == "MESH" and o.parent == arm_ob)
me = frog.data
FAMS = [m.name.split(".")[0] for m in me.materials]
print("FAMS", FAMS)
MI = {n: i for i, n in enumerate(FAMS)}
if "wrap" not in MI:
    raise RuntimeError("no wrap material")
bh = {b.name: np.array(b.head_local) for b in arm_ob.data.bones}
z_sh = bh["left_shoulder_pitch_link"][2]
z_neck = bh["neck"][2]
z_waist = bh["torso_link"][2]
z_knee = bh["left_knee_link"][2]
z_ank = bh["left_ankle_pitch_link"][2]
print(f"z sh {z_sh:.3f} neck {z_neck:.3f} waist {z_waist:.3f} knee {z_knee:.3f} ank {z_ank:.3f}")

nv = len(me.vertices)
co = np.zeros(nv * 3)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
gname = {g.index: g.name for g in frog.vertex_groups}
dom = np.empty(nv, object)
for v in me.vertices:
    best, bw = "", -1
    for g in v.groups:
        if g.weight > bw:
            best, bw = gname[g.group], g.weight
    dom[v.index] = best
is_arm = np.array(["shoulder" in d or "elbow" in d or "wrist" in d for d in dom])
is_shin = np.array(["knee" in d or "ankle" in d for d in dom])
is_trunk = np.array([d in ("pelvis", "torso_link") for d in dom])

ca = me.color_attributes["Col"]
nl = len(me.loops)
col = np.zeros(nl * 4, np.float32)
ca.data.foreach_get("color", col)
col = col.reshape(-1, 4)
lv = np.zeros(nl, np.int64)
me.loops.foreach_get("vertex_index", lv)
npoly = len(me.polygons)
pm = np.zeros(npoly, np.int64)
me.polygons.foreach_get("material_index", pm)
ls = np.zeros(npoly, np.int64)
me.polygons.foreach_get("loop_start", ls)
lt = np.zeros(npoly, np.int64)
me.polygons.foreach_get("loop_total", lt)
pv = lv[ls]                       # first vertex of each face
fc = np.zeros(npoly * 3)
me.polygons.foreach_get("center", fc)
fc = fc.reshape(-1, 3)
lface = np.repeat(np.arange(npoly), lt)


def lin(c):
    c = np.asarray(c, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


lum = col[:, :3] @ np.array([0.2126, 0.7152, 0.0722])
r, g, b = col[:, 0], col[:, 1], col[:, 2]
# skin teal sampled from the cheeks / face (skin faces between neck and head top, teal: g > b)
lz = co[lv, 2]
skin_l = (pm[lface] == MI["skin"]) & (lz > z_neck) & (g > b * 1.05) & (lum > 0.08)
SK = np.median(col[skin_l, :3], 0) if skin_l.sum() > 50 else lin((64, 140, 128))
print("skin", SK, int(skin_l.sum()))
skin_lum = SK @ np.array([0.2126, 0.7152, 0.0722])

# 1. head (above shoulders) and arms: blue-ish loops -> skin teal; legging faces there -> skin
blue = (b > g * 1.0) & (b > r + 0.02) & (lum > 0.015) & (lum < 0.45)
is_headb = np.array([d in ("neck", "head") for d in dom])
head_v = is_headb | (co[:, 2] > z_neck + 0.03)
region = head_v[lv] | is_arm[lv]
fix = region & blue
shade = np.clip(lum[fix] / max(skin_lum, 1e-4), 0.7, 1.15)
crown = np.clip((lz[fix] - (z_neck + 0.12)) / 0.15, 0, 1)
col[fix, :3] = SK[None] * (shade * (1 - 0.12 * crown))[:, None]
fpoly_head = (head_v[pv] | is_arm[pv]) & (pm == MI["legging"])
pm[fpoly_head] = MI["skin"]
print("head/arm loops recoloured", int(fix.sum()), "faces", int(fpoly_head.sum()))

# 2. shirt: blue torso faces between waist and shoulders -> team green tunic
GRN = lin((24, 80, 54))
tl = is_trunk[lv] & ~head_v[lv] & (lz > z_waist - 0.01) & (lz < z_neck + 0.03)
shirt_l = tl & (((b > g * 0.98) & (b > r + 0.02)) | (pm[lface] == MI["legging"])) & (lum > 0.01) & (lum < 0.5)
cnt = np.bincount(lface[shirt_l], minlength=npoly)
shirt_f = (cnt * 2 >= lt) & (pm != MI["gold"])
med = np.median(lum[shirt_l]) if shirt_l.sum() else 0.1
sh = np.clip(lum[shirt_l] / max(med, 1e-4), 0.6, 1.15)
up = np.clip((lz[shirt_l] - z_waist) / max(z_sh - z_waist, 0.1), 0, 1)
col[shirt_l, :3] = GRN[None] * (sh * (0.85 + 0.25 * up))[:, None]
pm[shirt_f] = MI["tunic"]
print("shirt faces", int(shirt_f.sum()))

# 3. leg wraps: non-skin, non-trouser faces on the shins between ankle and knee -> one wrap colour
WR = lin((168, 142, 104))
wrap_f = (is_shin[pv] & (fc[:, 2] > z_ank + 0.015) & (fc[:, 2] < z_knee - 0.02)
          & (pm != MI["skin"]) & (pm != MI["legging"]))
wrap_l = wrap_f[lface]
medw = np.median(lum[wrap_l]) if wrap_l.sum() else 0.1
sw = np.clip(lum[wrap_l] / max(medw, 1e-4), 0.75, 1.2)
band = np.where(lz[wrap_l] < z_ank + 0.06, 0.72, 1.0)
col[wrap_l, :3] = WR[None] * (sw * band)[:, None]
pm[wrap_f] = MI["wrap"]
print("wrap faces", int(wrap_f.sum()))

# 4. back-staff flap behind the hips: leather faces weighted to a thigh -> pin to the pelvis so it never swims
is_leg = np.array(["hip" in d or "knee" in d for d in dom])
flap_f = ((pm == MI["leather"]) | (pm == MI["leather_dark"])) & is_leg[pv] & (fc[:, 2] > z_knee + 0.12)
fv = np.unique(lv[flap_f[lface]])
pel = frog.vertex_groups["pelvis"]
for vi in fv:
    for gname_ in [gname[g.group] for g in me.vertices[vi].groups]:
        frog.vertex_groups[gname_].remove([int(vi)])
    pel.add([int(vi)], 1.0, "REPLACE")
print("flap verts pinned to pelvis", len(fv))

ca.data.foreach_set("color", col.ravel())
me.polygons.foreach_set("material_index", pm.astype(np.int32))
me.update()

bpy.ops.object.select_all(action="DESELECT")
for ob in bpy.context.scene.objects:
    if ob in (arm_ob, frog):
        ob.select_set(True)
bpy.context.view_layer.objects.active = arm_ob
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", use_selection=True, export_yup=True,
                          export_skins=True, export_animations=False, export_extras=True,
                          export_vertex_color="ACTIVE", export_image_format="JPEG", export_jpeg_quality=85,
                          export_apply=False, export_def_bones=False, export_rest_position_armature=True)
bpy.ops.wm.save_as_mainfile(filepath=str(HERE.parent / "public" / "frog.blend"), copy=True)
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")
