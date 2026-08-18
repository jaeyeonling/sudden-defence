import * as THREE from 'three';

/**
 * Value noise and fbm — the base layer every other world util builds on.
 *
 * The scratch vectors are exported, which is not how one would design this
 * from scratch. They were module-level singletons when `util.js` was one file,
 * and `util-accum`, `util-cloth` and `util` have always taken turns on the same
 * objects — hard rule 6 says allocate nothing per frame, and this is how that
 * is met. Giving each file its own copies would be tidier and would be a
 * behaviour change, so they stay shared and say so.
 */

// ---------------------------------------------------------------- scratch --
export const _v0 = new THREE.Vector3();
export const _v1 = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _n = new THREE.Vector3();
export const _nm = new THREE.Matrix3();

// ------------------------------------------------------------------ noise --
/** Deterministic 3D value hash in [0,1). No Math.random anywhere. */
export function hash3(x, y, z) {
  let h = Math.imul(Math.round(x * 1013) ^ 0x27d4eb2d, 0x85ebca6b);
  h = Math.imul(h ^ Math.round(y * 1619), 0xc2b2ae35);
  h = Math.imul(h ^ Math.round(z * 31337), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise, period ~1 unit. */
export function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz ? zf : 1 - zf;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? yf : 1 - yf;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? xf : 1 - xf;
        acc += hash3(xi + dx, yi + dy, zi + dz) * wx * wy * wz;
      }
    }
  }
  return acc;
}

export function fbm3(x, y, z, octaves = 3) {
  let a = 0.5;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z) * a;
    norm += a;
    a *= 0.5;
    x *= 2.03;
    y *= 2.01;
    z *= 1.97;
  }
  return sum / norm;
}

