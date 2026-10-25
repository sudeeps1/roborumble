# Auto-rigs a static human mesh (A-pose, standing) for the rig's Human look, headless in Blender:
#   npm run rig:human -- path/to/Human.fbx public/human/human_rigged.glb [render_dir]
# Bones sit at joints found from cross-sections of the mesh; skin weights are Blender's automatic
# weights. With a render_dir it also renders a test pose so you can check the skinning.
import sys, math, bpy
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
renders = argv[2] if len(argv) > 2 else None
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)
ob = [o for o in bpy.data.objects if o.type == "MESH"][0]
ob.name = "Human"
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Face -Y (Blender's front; left hand at +X), feet centered at the origin, soles at z = 0.
me = ob.data
for v in me.vertices:
    v.co.x, v.co.y = -v.co.x, -v.co.y
xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
z0 = min(v.co.z for v in me.vertices)
feet = [v.co for v in me.vertices if v.co.z - z0 < 0.03]
cx = sum(p.x for p in feet) / len(feet); cy = sum(p.y for p in feet) / len(feet)
for v in me.vertices:
    v.co.x -= cx; v.co.y -= cy; v.co.z -= z0
me.update()
V = [v.co.copy() for v in me.vertices]
H = max(p.z for p in V)
print("height", round(H, 3))

def band(z, side=0, tol=0.012):
    pts = [p for p in V if abs(p.z - z) < tol * H and (side == 0 or (p.x * side) > 0.01)]
    return pts

def centroid(pts):
    n = len(pts)
    return Vector((sum(p.x for p in pts) / n, sum(p.y for p in pts) / n, sum(p.z for p in pts) / n))

def torso_centroid(z):
    # the torso only: points near the middle, so the arms don't pull it sideways
    pts = [p for p in band(z) if abs(p.x) < 0.11 * H]
    return centroid(pts)

j = {}
hip_z, knee_z, ankle_z = 0.515 * H, 0.285 * H, 0.05 * H
for side, s in (("L", 1), ("R", -1)):
    thigh = centroid([p for p in band(0.44 * H, s) if abs(p.x) < 0.16 * H])
    j[f"hip_{side}"] = Vector((thigh.x * 0.92, thigh.y, hip_z))
    knee = centroid([p for p in band(knee_z, s) if abs(p.x) < 0.16 * H])
    j[f"knee_{side}"] = Vector((knee.x, knee.y, knee_z))
    ank = centroid([p for p in band(ankle_z + 0.02 * H, s) if abs(p.x) < 0.16 * H])
    j[f"ankle_{side}"] = Vector((ank.x, ank.y + 0.012 * H, ankle_z))
    foot = [p for p in V if p.z < 0.035 * H and p.x * s > 0.01]
    toe = min(foot, key=lambda p: p.y)  # most forward (-Y)
    j[f"toe_{side}"] = Vector((ank.x * 0.6 + toe.x * 0.4, toe.y, 0.02 * H))
    # arm: points outside the torso between hip and shoulder height; fit its axis
    sh = Vector((s * 0.098 * H, torso_centroid(0.80 * H).y, 0.815 * H))
    arm = [p for p in V if p.x * s > 0.13 * H and 0.36 * H < p.z < 0.79 * H]
    c = centroid(arm)
    # principal direction by power iteration on the covariance
    cov = Matrix(((0, 0, 0), (0, 0, 0), (0, 0, 0)))
    for p in arm:
        d = p - c
        for a in range(3):
            for b in range(3):
                cov[a][b] += d[a] * d[b]
    axis = Vector((0.2 * s, 0.0, -1.0)).normalized()
    for _ in range(50):
        axis = (cov @ axis).normalized()
    if axis.z > 0: axis = -axis
    tip = max(arm, key=lambda p: (p - sh).dot(axis))
    reach = (tip - sh).dot(axis)
    j[f"shoulder_{side}"] = sh
    j[f"elbow_{side}"] = sh + axis * (reach * 0.42) + Vector((0, 0.01 * H, 0))
    j[f"wrist_{side}"] = sh + axis * (reach * 0.76)
    j[f"fingers_{side}"] = sh + axis * reach

hips_c = torso_centroid(hip_z)
j["hips"] = Vector((0, hips_c.y, hip_z))
j["waist"] = Vector((0, torso_centroid(0.60 * H).y, 0.60 * H))
j["neck"] = Vector((0, torso_centroid(0.86 * H).y, 0.865 * H))
j["top"] = Vector((0, torso_centroid(0.95 * H).y, H))
for k, v in j.items():
    print(f"{k:12s} {v.x:+.3f} {v.y:+.3f} {v.z:+.3f}")

# armature
arm_data = bpy.data.armatures.new("Rig")
rig = bpy.data.objects.new("Rig", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
def bone(name, head, tail, parent=None):
    b = eb.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = eb[parent]
    return b
bone("hips", j["hips"], j["waist"])
bone("torso", j["waist"], j["neck"], "hips")
bone("head", j["neck"], j["top"], "torso")
for side in ("L", "R"):
    bone(f"thigh_{side}", j[f"hip_{side}"], j[f"knee_{side}"], "hips")
    bone(f"shin_{side}", j[f"knee_{side}"], j[f"ankle_{side}"], f"thigh_{side}")
    bone(f"foot_{side}", j[f"ankle_{side}"], j[f"toe_{side}"], f"shin_{side}")
    bone(f"upperarm_{side}", j[f"shoulder_{side}"], j[f"elbow_{side}"], "torso")
    bone(f"forearm_{side}", j[f"elbow_{side}"], j[f"wrist_{side}"], f"upperarm_{side}")
    bone(f"hand_{side}", j[f"wrist_{side}"], j[f"fingers_{side}"], f"forearm_{side}")
bpy.ops.object.mode_set(mode="OBJECT")

# skin with automatic weights
bpy.ops.object.select_all(action="DESELECT")
ob.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
unweighted = sum(1 for v in me.vertices if not any(g.weight > 1e-4 for g in v.groups))
print("vertex groups", len(ob.vertex_groups), "unweighted vertices", unweighted, "of", len(me.vertices))
if unweighted > 0:
    # give stragglers to their nearest bone
    groups = {g.name: g for g in ob.vertex_groups}
    segs = [(b.name, rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local) for b in arm_data.bones]
    def seg_d(p, a, b):
        ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
        return (a + ab * t - p).length
    for v in me.vertices:
        if not any(g.weight > 1e-4 for g in v.groups):
            name = min(segs, key=lambda s: seg_d(v.co, s[1], s[2]))[0]
            groups.setdefault(name, ob.vertex_groups.new(name=name)).add([v.index], 1.0, "REPLACE")

# test pose: bend left elbow and knee, raise right arm, then render
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
pb = rig.pose.bones
pb["forearm_L"].rotation_mode = "XYZ"; pb["forearm_L"].rotation_euler = (math.radians(-80), 0, 0)
pb["upperarm_R"].rotation_mode = "XYZ"; pb["upperarm_R"].rotation_euler = (math.radians(-70), 0, 0)
pb["shin_L"].rotation_mode = "XYZ"; pb["shin_L"].rotation_euler = (math.radians(70), 0, 0)
pb["thigh_L"].rotation_mode = "XYZ"; pb["thigh_L"].rotation_euler = (math.radians(-40), 0, 0)
bpy.ops.object.mode_set(mode="OBJECT")
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = 500, 700
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam); scene.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = H * 1.1
for name, loc, rot in [("pose_front", (0, -5, H / 2), (math.pi / 2, 0, 0)), ("pose_side", (5, 0, H / 2), (math.pi / 2, 0, math.pi / 2))]:
    if renders is None:
        break
    cam.location = loc; cam.rotation_euler = rot
    scene.render.filepath = f"{renders}/{name}.png"
    bpy.ops.render.render(write_still=True)
# back to rest pose for export
for b in pb:
    b.rotation_mode = "QUATERNION"; b.rotation_quaternion = (1, 0, 0, 0); b.location = (0, 0, 0)
bpy.data.objects.remove(cam)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_skins=True, export_animations=False, export_yup=True, use_selection=False)
print("exported", dst)
