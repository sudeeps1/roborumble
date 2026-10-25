# Character build (Blender)

Rebuild the elf with one command (from the repo root, Blender 5.2):

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P characters/blender/build.py
```

That writes `characters/public/elf.glb` (what the game loads) and `characters/public/elf.blend`. A full build takes about a minute.

## How the elf is made

There is no hand modeling. The anatomy comes from Blender Studio's **Human Base Meshes** (v1.4.1, CC0, realistic female body). The first build downloads it (about 50 MB from `mirror.blender.org`) into `characters/blender/cache/` (git-ignored). It is then fitted onto the G1's joints at a fixed bind pose (`g1.py`, `BIND`) and turned into a signed distance field.

The outfit, elf ears, hair, fists and boots are a signed-distance-field sculpt written in Python (numpy) on top of that body:

| File | What it holds |
| --- | --- |
| `fetch_base.py` | Downloads the CC0 base-mesh bundle and extracts the realistic female body and eyes |
| `fit_base.py` | Rotates and scales the base body into the MuJoCo frame and finds its joints. It warps it bone by bone onto the G1 bind pose and flattens the bust into an armored chest |
| `base_body.py` | Fitted mesh → OpenVDB level set → cached dense grids (body 1.5 mm, head 0.6 mm), with body-part labels for skinning |
| `sdf.py` | Shape kit (spheres, ellipsoids, rounded cones, smooth unions...) and the sparse OpenVDB mesher |
| `elf.py` | The `Elf` class and the head: face (base mesh), eyes, lashes traced along the real lid edge, brows, elf ears replacing the human ones |
| `hair_cards.py` | Strand-card hair layered over the solid hair, plus the `_FLOW` strand-direction attribute for the hair shader |
| `elf_hair.py` | Hair cap, bangs, side locks, circlet, ponytail |
| `elf_outfit.py` | Body, outfit (raised "paint" on the skin, so cloth never pokes through), collar, belt flaps, pauldron, rune decals |
| `elf_common.py` | Material and body-part tables, base colors |
| `rig.py` | Skeleton (bones named after G1 bodies) and skin weights |
| `build.py` | Mesh, decimate, paint vertex colors and AO, rig, export |
| `pose.py` | Poses the rig from G1 joint angles (same math as the game runtime) |
| `live.py` | Loads the last build into a running Blender (scene "Elf") |
| `render_previews.py` | Eevee preview renders |

## How it plugs into the physics

Each bone is named after the MuJoCo body that drives it (`pelvis`, `torso_link`, `left_elbow_link`...). The armature node carries `g1_rig` metadata: every driven bone's G1 body pose at the bind pose. At runtime:

```
bone_world = body_now * inverse(body_bind) * bone_bind
```

`neck` and `head` follow `torso_link` (the G1 has no neck joint). `hair_*` and `flap_*` bones are springs that the runtime simulates.

## Useful flags

- `--fast`: half resolution, about 20 s
- `--only Head,Ponytail`: build a subset of pieces
- `--renders DIR [--shots face,front]`: preview renders
- `--out DIR`: write somewhere other than `characters/public`

Pose test renders (guard, jab, kick, hit) into a folder:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b characters/public/elf.blend -P characters/blender/pose.py -- guard,jab,kick /tmp/elf_poses
```

To see it in a running Blender (for example through the Blender MCP), run:

```python
import sys; sys.path.insert(0, "characters/blender"); import live, pose, bpy
live.show(); pose.apply(bpy.data.objects["ElfRig"], pose.POSES["guard"])
```
