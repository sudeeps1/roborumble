# Downloads Blender Studio's CC0 "Human Base Meshes" bundle (v1.4.1, ~50 MB, official Blender mirror) into
# characters/blender/cache/ and extracts the realistic female body + eyes to cache/hbm_female.npz.
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P characters/blender/fetch_base.py
# build.py runs this automatically when the cache is missing. License: CC0 (blender.org/download/demo-files).
import subprocess
import sys
import zipfile
from pathlib import Path

import bpy
import bmesh
import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
URL = "https://mirror.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip"
ZIP = CACHE / "human-base-meshes-bundle-v1.4.1.zip"
BLEND = CACHE / "human-base-meshes-bundle-v1.4.1" / "human_base_meshes_bundle.blend"
OUT = CACHE / "hbm_female.npz"
NAMES = {"GEO-body_female_realistic": "body", "GEO-body_female_realistic.eye.L": "eyeL",
         "GEO-body_female_realistic.eye.R": "eyeR"}


def fetch():
    CACHE.mkdir(exist_ok=True)
    if not BLEND.exists():
        if not ZIP.exists():
            print("downloading", URL)
            subprocess.run(["curl", "-L", "--fail", "-s", "-o", str(ZIP), URL], check=True)
        with zipfile.ZipFile(ZIP) as z:
            z.extract("human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend", CACHE)


def extract(level=2):
    """Realistic female body at multires level `level` (~170k verts), triangulated, world space, + eyes."""
    with bpy.data.libraries.load(str(BLEND), link=False) as (a, b):
        b.objects = [n for n in a.objects if n in NAMES]
    scene = bpy.context.scene
    res = {}
    for ob in b.objects:
        scene.collection.objects.link(ob)
        for m in ob.modifiers:
            if m.type == "MULTIRES":
                m.levels = level
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in b.objects:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        me.transform(ob.matrix_world)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.to_mesh(me)
        bm.free()
        key = NAMES[ob.name]
        res[key + "_co"] = np.array([v.co[:] for v in me.vertices])
        res[key + "_tri"] = np.array([p.vertices[:] for p in me.polygons])
        if ".sculpt_face_set" in me.attributes:
            res[key + "_fs"] = np.array([d.value for d in me.attributes[".sculpt_face_set"].data])
        scene.collection.objects.unlink(ob)
    np.savez_compressed(OUT, **res)
    print("extracted", {k: v.shape for k, v in res.items()})


if __name__ == "__main__":
    fetch()
    extract()
