# Quick Eevee turnaround renders of the built character (for checking the sculpt, not for the game).
import math
from pathlib import Path

import bpy
import mathutils


def _look(cam, target):
    d = mathutils.Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render(scene, out_dir: Path, log=print, shots=None, names=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.16, 0.17, 0.2, 1)
    bg.inputs["Strength"].default_value = 0.9
    scene.world = world

    def light(name, kind, loc, energy, color, size=1.0):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind == "AREA":
            ld.size = size
        ob = bpy.data.objects.new(name, ld)
        ob.location = loc
        scene.collection.objects.link(ob)
        _look(ob, (0, 0, 0.9))
        return ob

    light("key", "AREA", (1.6, 1.2, 2.0), 260, (1.0, 0.93, 0.85), 1.2)
    light("fill", "AREA", (1.2, -1.8, 1.2), 90, (0.75, 0.85, 1.0), 2.0)
    light("rim", "AREA", (-1.8, -0.4, 1.9), 220, (0.7, 0.95, 1.0), 1.0)
    # floor
    me = bpy.data.meshes.new("floor")
    me.from_pydata([(-3, -3, -0.001), (3, -3, -0.001), (3, 3, -0.001), (-3, 3, -0.001)], [], [(0, 1, 2, 3)])
    floor = bpy.data.objects.new("floor", me)
    scene.collection.objects.link(floor)
    fm = bpy.data.materials.new("floor")
    fm.use_nodes = True
    fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.08, 0.085, 0.09, 1)
    floor.data.materials.append(fm)

    cam_d = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_d)
    scene.collection.objects.link(cam)
    scene.camera = cam
    shots = shots or {
        "front": ((2.6, 0.0, 0.85), (0, 0, 0.68), 50, (900, 1200)),
        "three_quarter": ((2.0, 1.6, 1.0), (0, 0, 0.68), 50, (900, 1200)),
        "back": ((-2.2, -1.2, 1.0), (0, 0, 0.7), 50, (900, 1200)),
        "face": ((0.62, 0.30, 1.27), (0.02, 0, 1.225), 85, (900, 900)),
        "face_front": ((0.7, 0.0, 1.25), (0.02, 0, 1.22), 85, (900, 900)),
        "face_side": ((0.12, 0.7, 1.26), (0.0, 0, 1.23), 85, (900, 900)),
        "hair_back": ((-0.75, -0.35, 1.30), (-0.05, 0, 1.18), 70, (900, 900)),
        "torso": ((0.95, 0.45, 1.05), (0.02, 0, 0.95), 70, (900, 900)),
        "hands": ((0.75, 0.0, 0.80), (0.10, 0, 0.78), 70, (1000, 700)),
        "legs": ((1.1, 0.55, 0.35), (0.0, 0, 0.28), 60, (900, 900)),
    }
    if names:
        shots = {k: v for k, v in shots.items() if k in names}
    for name, (loc, tgt, lens, res) in shots.items():
        cam.location = loc
        _look(cam, tgt)
        cam_d.lens = lens
        scene.render.resolution_x, scene.render.resolution_y = res
        scene.render.filepath = str(out_dir / f"{name}.png")
        bpy.ops.render.render(write_still=True)
        log(f"  render {name}")
