# Contact sheet: the built character in a battery of poses (pose.STRESS by default) from the front, the left
# side and behind-right, Eevee, tiled into one PNG: PER_ROW poses per row, each a front | side | back-3/4 triple,
# read left to right, top to bottom in pose order.
#   Blender -b characters/public/NAME.blend -P characters/blender/contact.py -- OUT.png [pose,pose,...] [tile_px]
import sys
from pathlib import Path

import bpy
import mathutils
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pose  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
out = Path(args[0])
names = args[1].split(",") if len(args) > 1 and args[1] else pose.STRESS
tile = int(args[2]) if len(args) > 2 else 300
PER_ROW = 4
scene = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        continue
scene.view_settings.view_transform = "AgX"
world = bpy.data.worlds.new("cs")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.20, 0.21, 0.24, 1)
scene.world = world


def look(ob, target):
    ob.rotation_euler = (mathutils.Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


for nm, loc, e in (("key", (2.0, 1.4, 2.4), 500), ("fill", (1.0, -2.2, 1.2), 200), ("rim", (-2.0, 0.6, 2.0), 300)):
    ld = bpy.data.lights.new(nm, "AREA")
    ld.energy, ld.size = e, 1.5
    lo = bpy.data.objects.new(nm, ld)
    lo.location = loc
    look(lo, (0, 0, 0.8))
    scene.collection.objects.link(lo)
cd = bpy.data.cameras.new("cs")
cd.type = "ORTHO"
cd.ortho_scale = 2.1
cam = bpy.data.objects.new("cs", cd)
scene.collection.objects.link(cam)
scene.camera = cam
VIEWS = [((4, 0, 0.9), (0, 0, 0.9)), ((0.1, 4, 0.9), (0.1, 0, 0.9)), ((-2.9, -2.9, 1.2), (0, 0, 0.9))]
w, h = tile * 3 // 4, tile
scene.render.resolution_x, scene.render.resolution_y = w, h
tmp = out.parent / (out.stem + "_tiles")
tmp.mkdir(parents=True, exist_ok=True)
rows = -(-len(names) // PER_ROW)
sheet = np.full((h * rows, w * len(VIEWS) * PER_ROW, 4), 0.1, np.float32)
for r, nm in enumerate(names):
    pose.apply(arm, pose.POSES[nm])
    bpy.context.view_layer.update()
    for c, (loc, tgt) in enumerate(VIEWS):
        cam.location = loc
        look(cam, tgt)
        f = tmp / f"{r:02d}_{nm}_{c}.png"
        scene.render.filepath = str(f)
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(str(f))
        px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
        bpy.data.images.remove(img)
        y0 = (rows - 1 - r // PER_ROW) * h            # image rows are bottom-up
        x0 = ((r % PER_ROW) * len(VIEWS) + c) * w
        sheet[y0:y0 + h, x0:x0 + w] = px
        sheet[y0:y0 + h, x0:x0 + (4 if c == 0 else 1)] = (0, 0, 0, 1)   # thick line between poses
    sheet[(rows - 1 - r // PER_ROW) * h, :] = (0, 0, 0, 1)
im = bpy.data.images.new("sheet", sheet.shape[1], sheet.shape[0])
im.pixels = sheet.ravel()
im.filepath_raw = str(out)
im.file_format = "PNG"
im.save()
print("contact sheet ->", out, "rows:", ",".join(names))
