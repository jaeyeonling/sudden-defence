import * as THREE from 'three';

/**
 * Shared vocabulary for every hand-held surface — the weapon table and the arm
 * table both build on these, so they live apart from both rather than in one of
 * them importing the other.
 */

/** Shared base for every weapon surface. */
export const BASE = {
  uvMode: 'triplanar',
  localSpace: true,
  vertexMasks: true,
  /**
   * No dust / rain streak / ground splash: all three are driven by world Y, which
   * is meaningless for something parented to the camera.
   *
   * Cavity grime (weather.w) is the exception and it is now the single most
   * valuable texture layer on the gun. It is driven by the surface's OWN height
   * channel in object space (see shader.js: `cav = 1 - owHeightS`), so it cannot
   * swim, and it both darkens the valleys of the moulding stipple / anodising
   * grain and adds AO to them. 0.4 -> 0.62: with the exposure recalibration below
   * making the gun diffuse-dominant, this is what turns a smooth dark panel into a
   * surface with grime living in its pores.
   */
  weather: [0, 0, 0, 0.62],
  // low amplitude, because the macro layer is the one thing sampled in world
  // space and would otherwise crawl across the gun as the player moves
  macro: [0.55, 0.05, 0.07, 0.06],
  aoStrength: 1,
};

export const c = (r, g, b) => new THREE.Color(r, g, b);
