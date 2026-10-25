// The parts of ../characters the fight screen uses beyond src/rig/elf.d.ts (declarations of the same
// module merge): the icon renderer poses a character with the G1 forward kinematics and frames its head.
declare module "@elf/character.ts" {
  import type * as THREE from "three";
  interface CharacterView {
    /** Root-space (MuJoCo) matrix of a bone, e.g. "head". */
    boneMatrix(name: string): THREE.Matrix4 | null;
  }
}

declare module "@elf/fk.ts" {
  export type Vec3 = [number, number, number];
  export type Quat = [number, number, number, number];
  export interface BodyPose { name: string; pos: Vec3; quat: Quat }
  export class G1FK {
    compute(q: ArrayLike<number>, rootPos?: ArrayLike<number>, rootQuat?: ArrayLike<number>): BodyPose[];
  }
  export function qaxis(axis: ArrayLike<number>, angle: number): Quat;
  export function qmul(a: ArrayLike<number>, b: ArrayLike<number>): Quat;
  export function qrot(q: ArrayLike<number>, v: ArrayLike<number>): Vec3;
}
