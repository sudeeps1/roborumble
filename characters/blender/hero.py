# Cycles "hero" render of the built character in a fighting pose (for pitch slides / checking the final look).
#   /Applications/Blender.app/Contents/MacOS/Blender -b characters/public/elf.blend -P characters/blender/hero.py -- OUT.png [pose] [samples]
import math
import sys
from pathlib import Path

import bpy
import mathutils

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pose  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out = Path(args[0])
pose_name = args[1] if len(args) > 1 else "guard"
samples = int(args[2]) if len(args) > 2 else 96

scene = bpy.context.scene
pose.apply(next(o for o in bpy.data.objects if o.type == "ARMATURE"), pose.POSES[pose_name])

scene.render.engine = "CYCLES"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception:
    pass
scene.cycles.samples = samples
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.render.resolution_x, scene.render.resolution_y = 1200, 1500
scene.render.film_transparent = False

# world: dark teal-to-navy gradient so the silver hair and gold read
world = bpy.data.worlds.new("hero")
world.use_nodes = True
nt = world.node_tree
bg = nt.nodes["Background"]
grad = nt.nodes.new("ShaderNodeTexGradient")
coord = nt.nodes.new("ShaderNodeTexCoord")
mapn = nt.nodes.new("ShaderNodeMapping")
mapn.inputs["Rotation"].default_value = (0, math.radians(-90), 0)
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.010, 0.016, 0.026, 1)
ramp.color_ramp.elements[1].color = (0.035, 0.075, 0.085, 1)
nt.links.new(coord.outputs["Generated"], mapn.inputs["Vector"])
nt.links.new(mapn.outputs["Vector"], grad.inputs["Vector"])
nt.links.new(grad.outputs["Color"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0
scene.world = world


def light(name, loc, energy, color, size, target=(0, 0, 0.85)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy, ld.color, ld.size = energy, color, size
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    ob.rotation_euler = (mathutils.Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(ob)


light("key", (1.7, 1.3, 2.1), 320, (1.0, 0.90, 0.78), 1.0)
light("fill", (1.6, -1.9, 1.0), 60, (0.55, 0.75, 1.0), 2.5)
light("rim_l", (-1.6, 1.4, 1.8), 380, (0.45, 1.0, 0.85), 0.6)
light("rim_r", (-1.5, -1.5, 1.6), 300, (0.6, 0.8, 1.0), 0.6)

# ground disc with a soft falloff
me = bpy.data.meshes.new("ground")
n = 64
verts = [(0, 0, 0)] + [(3 * math.cos(a), 3 * math.sin(a), 0) for a in [i * 2 * math.pi / n for i in range(n)]]
me.from_pydata(verts, [], [(0, i, i % n + 1) for i in range(1, n + 1)])
ground = bpy.data.objects.new("ground", me)
scene.collection.objects.link(ground)
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
b = gm.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.02, 0.025, 0.03, 1)
b.inputs["Roughness"].default_value = 0.35
ground.data.materials.append(gm)

cam_d = bpy.data.cameras.new("hero")
cam_d.lens = 70
cam_d.dof.use_dof = True
cam_d.dof.aperture_fstop = 4.0
cam = bpy.data.objects.new("hero", cam_d)
scene.collection.objects.link(cam)
cam.location = (2.55, 1.35, 1.05)
target = mathutils.Vector((0.03, 0.0, 0.70))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_d.dof.focus_distance = (target - cam.location).length - 0.1
scene.camera = cam

scene.render.filepath = str(out)
bpy.ops.render.render(write_still=True)
print("hero render ->", out)
