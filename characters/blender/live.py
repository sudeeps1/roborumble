# Show the latest built character in a running Blender (Blender MCP bridge or the Text editor):
#   import sys; sys.path.insert(0, "<repo>/characters/blender"); import live; live.show()
# The build itself runs headless (build.py); this only appends its result into a scene named "Elf",
# so your other scenes and the open .blend file are left alone.
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
BLEND = HERE.parent / "public" / "elf.blend"


def show(blend=BLEND, scene_name="Elf"):
    scene = bpy.data.scenes.get(scene_name) or bpy.data.scenes.new(scene_name)
    old = list(scene.objects)
    for ob in old:
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.lights,
                 bpy.data.cameras, bpy.data.worlds):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)
    with bpy.data.libraries.load(str(blend), link=False) as (src, dst):
        dst.objects = list(src.objects)
        dst.worlds = list(src.worlds)
    for ob in dst.objects:
        if ob is not None:
            scene.collection.objects.link(ob)
    if dst.worlds:
        scene.world = dst.worlds[0]
    cams = [o for o in scene.objects if o.type == "CAMERA"]
    if cams:
        scene.camera = cams[0]
    win = bpy.context.window_manager.windows[0]
    win.scene = scene
    for area in win.screen.areas:
        if area.type == "VIEW_3D":
            area.spaces.active.shading.type = "MATERIAL"
    return [o.name for o in scene.objects]
