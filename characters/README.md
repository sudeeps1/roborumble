# characters: elf skin for the G1

The elf is a skinned mesh drawn over each Unitree G1 in place of the robot meshes. Physics sends
G1 body poses; `CharacterView` turns them into a skinned, lit, glowing elf with spring hair and belt flaps.

## Run the viewer

```
cd characters && npm install && npm run dev
```

Open http://localhost:5190. You get two elves 1.2 m apart in a boxing guard, driven by procedural
G1 joint curves (`src/anims.ts` → `src/fk.ts` → `CharacterView`). Use the panel to play motions
(guard, jab, cross, front kick, hit recoil, bind pose) per fighter, run "Auto exchange", drag the
charging glow, change speed, and toggle the G1 skeleton overlay (yellow lines between MuJoCo body
origins) to check that the skin follows the robot. "Bind pose" makes BodyNow equal BodyBind, so the
mesh should match the asset exactly.

`npm run check` type-checks.

## Use it from game code

```ts
import * as THREE from "three";
import { CharacterView } from "./characters/src/character.ts";

// The renderer's MuJoCo-frame group: meters, Z up. In a Y-up three.js scene:
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

const p1 = await CharacterView.load("/elf.glb");
const p2 = await CharacterView.load("/elf.glb", { hue: -2.45 }); // team colour (tunic, runes, gem)
world.add(p1.root, p2.root); // leave root at identity; positions come from the body poses

// every animation frame, from physics:
p1.update(bodies1, dt);
p2.update(bodies2, dt);
```

`bodies` is the physics → renderer body-pose interface, one entry per G1 body:

```ts
type Bodies =
  | { name: string; pos: [x, y, z]; quat: [w, x, y, z] }[]
  | Map<string, { pos: [x, y, z]; quat: [w, x, y, z] }>;
```

- Names are MJCF body names (`pelvis`, `torso_link`, `left_elbow_link`, ...; the 30 bodies in
  `src/g1_kinematics.json`). Extra bodies are ignored. A missing body leaves its bone at rest
  relative to its parent.
- Positions and quaternions are MuJoCo **world** coordinates (meters, Z up, the robot faces +X at
  spawn, left = +Y). Both fighters' roots stay at the origin; the body poses carry where they are.
- From MuJoCo WASM: for body id `i`, `pos = data.xpos.slice(3*i, 3*i+3)` and
  `quat = data.xquat.slice(4*i, 4*i+4)` (MuJoCo quats are already w, x, y, z).
- Call `update` every rendered frame with the real frame `dt`, even if physics did not step: `dt`
  drives the spring bones, the glow pulse and the hit flash.

Other calls:

| Call | What it does |
| --- | --- |
| `setGlow(level)` | 0..1, runes and forehead gem pulse brighter (the "charging" state) |
| `hitFlash()` | short rim-lit flash on the whole body |
| `resetSprings()` | restart hair and flaps from the current pose (they also reset on a jump of more than 0.75 m) |
| `boneMatrix(name)` | MuJoCo-frame matrix of a bone, e.g. `right_wrist_yaw_link` for hit sparks |
| `warnings` | asset problems found at load (also logged by the viewer) |
| `dispose()` | removes the elf and frees its materials |

No G1 joint angles? `src/fk.ts` has `G1FK`, which turns 29 joint angles (MuJoCo qpos order) plus a
root pose into this body list.

## How it works

- `src/character.ts`: loads the GLB once per URL and clones it per fighter (SkeletonUtils, one
  shared skeleton per fighter). The glTF scene sits in a group rotated +90° about X, so `root` is in
  the MuJoCo frame. Each bone with a driving body gets
  `BoneWorld = BodyNow * inverse(BodyBind) * BoneBind`, and then `local = inverse(ParentWorld) * BoneWorld`.
  BodyBind comes from `ElfRig.userData.g1_rig.bones`. `neck` and `head` follow `torso_link`.
- `src/springs.ts`: hair and belt-flap chains. Each bone tail is a particle with inertia, gravity
  (-Z), a pull back toward its animated rest direction and a swing limit. Lengths are kept and
  particles are pushed out of the rig's capsule colliders (torso, pelvis, head, thighs). It uses
  fixed-size substeps (1/120 s, dt clamped to 0.1 s), so it is stable at any frame rate. Where a
  particle already sits inside a collider in the rest pose, that pair's radius shrinks to the rest
  distance.
- `src/materials.ts`: replaces glTF materials by name with `MeshPhysicalMaterial`. Base colour
  comes from the vertex colours. Surface detail without UVs: triplanar mapping in bind-pose object
  space (pre-skinning position and normal as varyings, so it sticks to the skin), a shared macro
  layer (wrinkles, blotches) plus a per-family micro layer (pores, leather grain, twill/knit/linen
  weave, hammered gold) that fades out with pixel footprint; each drives normal, albedo and
  roughness, and convex curvature adds edge wear. Skin and lips: per-channel wrap diffuse (red
  scatters furthest), dual-lobe specular, backlit translucency on thin shells (ears, fingers). Hair:
  Kajiya-Kay (shifted white primary, hair-tinted secondary) along the skinned `_flow` attribute when
  the asset has it, sheen otherwise. `hair_card`: alpha cutout with alphaToCoverage (alphaTest on
  low quality), double sided. Eyes: darker limbal ring, lid shading, wet clearcoat. Runes and gem
  are emissive (`setGlow`) and write a bloom mask into alpha. Every material gets the hit-flash rim
  and an optional team hue.
- `src/detail.ts`: procedural, tileable detail textures (seeded noise, ~0.3 s once at startup,
  generated while the GLB downloads). `src/geomprep.ts`: per-geometry attributes computed at load:
  `_curv` (mean curvature), `_thin` (shell thickness for translucency), and `_flow` normalized and
  converted from Blender Z-up when it arrives unconverted (Blender's exporter writes custom
  attributes raw). `src/studio.ts`: procedural HDR studio environment (softboxes matching the
  lights) for reflections and catchlights.
- `src/fk.ts`: G1 forward kinematics (a port of `blender/g1.py`) and a small damped-least-squares
  leg IK used by the test motions.
- `src/anims.ts`: test motions as keyed joint-angle curves, with planted feet solved by IK.
- `src/viewer.ts`: the viewer. Warm soft-shadow key, cool fill and two cool rims, the studio environment,
  blurred contact shadows, then an MSAA half-float composer: GTAO (half res) -> bloom on emissive only (reads
  the alpha mask) -> AgX output with a light vignette and split-tone grade. The Quality buttons (or `Q`, or
  `?q=low`) switch micro detail, GTAO, A2C hair cards, shadow map size and pixel ratio. `window.viewer` is a
  debug handle with `play`, `pause`, `step`, `bench`, `setQuality` and the passes. Debug URL flags:
  `?fakeflow` synthesizes a hair `_flow` (in Z-up, to exercise the axis fix) and `?fakecards` adds test hair
  cards, so the hair paths can be checked before the asset ships them.

## The asset

`public/elf.glb` is generated by the Blender scripts in `characters/blender/` (see that folder for
the build). The runtime reads everything it needs from the GLB: bone names, `g1_rig` bind data,
springs and colliders. A rebuilt GLB needs no code changes as long as the bone names and the
`g1_rig` format stay the same.

Dev-only: `SHOT_DIR=/some/dir npm run dev` lets `viewer.shot("name")` in the console save canvas
PNGs there.
