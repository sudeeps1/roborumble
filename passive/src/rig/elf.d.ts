// Types for the character skins (../characters/src/character.ts), reached through the @elf alias in
// vite.config.ts. Declared here so this project's type check doesn't crawl the other package.
declare module "@elf/character.ts" {
  import type * as THREE from "three";
  export interface BodyPoseIn { pos: ArrayLike<number>; quat: ArrayLike<number> }
  export type BodyInput = ReadonlyArray<BodyPoseIn & { name: string }> | Map<string, BodyPoseIn>;
  export class CharacterView {
    /** MuJoCo-frame group (meters, Z up). */
    readonly root: THREE.Group;
    readonly warnings: string[];
    static load(url: string, opts?: { hue?: number; castShadow?: boolean }): Promise<CharacterView>;
    update(bodies: BodyInput, dt: number): void;
    setGlow(level: number): void;
    hitFlash(): void;
    resetSprings(): void;
    dispose(): void;
  }
}

declare module "@elf/studio.ts" {
  import type * as THREE from "three";
  export function makeStudioEnvironment(renderer: THREE.WebGLRenderer, stage?: THREE.Vector3): THREE.Texture;
}

declare module "@elf-assets/*?url" {
  const url: string;
  export default url;
}
