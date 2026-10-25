// Arena tunables in one place: colors (sRGB hex), light levels, layout. three.js frame (Y up).
import * as THREE from "three";

/** Radius of the fairy ring (mushrooms), meters around the origin. Fighters start at x = +-0.6. */
export const RING_RADIUS = 2.7;

/** Default camera spot (stage.ts: ~1.27 m up, ~3.8 m out on +Z). Layout keeps sightlines from here open. */
export const CAM = new THREE.Vector3(0, 1.27, 3.8);

export const FOG = { color: 0x141a3c, density: 0.045 };

export const SKY = {
  zenith: 0x020310,
  mid: 0x080d30,
  horizon: 0x1a2258, // the fogged world fades toward this
  below: 0x0b0e24,
  moonGlow: 0x5d6fd0,
};

// The moon hangs behind the fighters, a little right of center, just above the far treeline.
const MOON_AZ = THREE.MathUtils.degToRad(6.6);
const MOON_EL = THREE.MathUtils.degToRad(6.9);
export const MOON_DIR = new THREE.Vector3(Math.sin(MOON_AZ) * Math.cos(MOON_EL), Math.sin(MOON_EL), -Math.cos(MOON_AZ) * Math.cos(MOON_EL));
export const MOON = { color: 0xfff1d6, intensity: 0.92, angularRadius: THREE.MathUtils.degToRad(2.45) };

export const LIGHT = {
  hemiSky: 0x6f80d8, hemiGround: 0x1a2a20, hemi: 0.35,
  key: 0xbccbff, keyIntensity: 2.2, keyFrom: new THREE.Vector3(2.2, 7.5, 6.2),
  rim: 0xffcfa6, rimIntensity: 1.3, rimFrom: new THREE.Vector3(0.6, 3.6, -7),
  env: 0.8,
};

// Glowing mushroom caps (sRGB). Teal, violet, warm gold.
export const SHROOM_COLORS = [0x22e8c4, 0x9a66ff, 0xffb444];
export const SHROOM_WEIGHTS = [0.4, 0.34, 0.26];
