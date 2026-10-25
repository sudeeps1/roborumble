// Placeholder arena until a mockup direction is picked: a dark stone floor flat at z = 0 (the physics
// floor), the ring line at the ropes, fog. Nothing tall anywhere a body can fall.
import * as THREE from "three";
import { REFEREE } from "../core/arena.ts";
import { RING_RADIUS } from "../core/scene.ts";
import type { FxLook } from "./fx.ts";
import type { Stage } from "./stage.ts";

export interface ArenaSet { look: FxLook; update(t: number, dt: number): void }

export function buildArena(stage: Stage): ArenaSet {
  const s = stage.scene;
  s.background = new THREE.Color(0x1d1f2e);
  s.fog = new THREE.Fog(0x1d1f2e, 8, 26);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 96), new THREE.MeshStandardMaterial({ color: 0x3a3634, roughness: 0.95 }));
  floor.receiveShadow = true;
  s.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(REFEREE.rope - 0.04, REFEREE.rope + 0.04, 160), new THREE.MeshBasicMaterial({ color: 0xe8cf94 }));
  ring.position.z = 0.003;
  s.add(ring);
  const inner = new THREE.Mesh(new THREE.RingGeometry(RING_RADIUS - 0.01, RING_RADIUS + 0.01, 160), new THREE.MeshBasicMaterial({ color: 0x7a6a50 }));
  inner.position.z = 0.002;
  s.add(inner);
  return { look: { dust: 0x8a7a66, stone: 0x6e6255, fist: 0xffe2a8, block: 0xb8e4ff }, update() {} };
}
