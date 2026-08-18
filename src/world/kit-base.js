import * as THREE from 'three';
import { datan2 } from '../core/dmath.js';
import { chamferBox, plainBox, quad } from './util.js';

/**
 * WORLD — the modular building kit.
 *
 * Panel space for every facade element: x along the wall (centred), y up from
 * the floor line, z from 0 at the OUTER face to +t at the inner face. The
 * caller supplies `pm`, the matrix that puts panel space into level space, and
 * every element composes onto it — so a window knows how deep its own reveal is
 * and can put a sill, a frame, shutters and a grille at the right depth without
 * the caller doing trigonometry.
 */

/**
 * The shared vocabulary: panel-space placement, the cached unit boxes every
 * element scales, and the two helpers that read a panel matrix back out.
 *
 * Everything the kit builds sits on these, which is why they are here rather
 * than in whichever file happened to need them first.
 */

const _m = new THREE.Matrix4();
const _mm = new THREE.Matrix4();
/** Shared identity for elements authored straight in level space. */
export const IDENT = new THREE.Matrix4();

/** local -> level matrix, composed onto the panel matrix. */
function L(pm, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _mm.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  _mm.scale(new THREE.Vector3(sx, sy, sz));
  _mm.setPosition(x, y, z);
  return _m.copy(pm).multiply(_mm);
}

// A tiny allocation-light path for the common case (no rotation).
/**
 * Compose scratch, shared with `kit-openings.js` rather than duplicated there.
 *
 * These were one set of objects when the kit was one file, and `LL` and the
 * opening builders have always taken turns on them. Giving openings its own
 * copies would be tidier and would be a BEHAVIOUR CHANGE — the interleaving
 * that exists today is the interleaving the capture baseline was taken under.
 */
export const _e = new THREE.Euler(0, 0, 0, 'YXZ');
export const _q = new THREE.Quaternion();
export const _p = new THREE.Vector3();
export const _s = new THREE.Vector3();
function LL(pm, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  _mm.compose(_p, _q, _s);
  return _m.copy(pm).multiply(_mm);
}

export const BOX = (A) => A.cache('box:0.012', () => chamferBox(1, 1, 1, 0.012));
export const BOX_FINE = (A) => A.cache('box:0.004', () => chamferBox(1, 1, 1, 0.004));
export const BOX_SOFT = (A) => A.cache('box:0.03', () => chamferBox(1, 1, 1, 0.03));
/** 12-tri box for thin members (see util.plainBox). */
export const BOX_THIN = (A) => A.cache('box:plain', () => plainBox());
/** Single quad for glass panes. */
export const PANE = (A) => A.cache('pane', () => quad(1, 1));

/** Merge a unit chamfer box scaled to a slab. */
export function slab(A, key, pm, x, y, z, sx, sy, sz, opts = null, ry = 0) {
  A.add(key, BOX(A), LL(pm, x, y, z, ry, sx, sy, sz), opts);
}


// --------------------------------------------------------------- utilities --
const _wp = [0, 0, 0];
/** Transform a panel-space point to level space (returns a shared triple). */
export function worldOf(pm, x, y, z) {
  _p.set(x, y, z).applyMatrix4(pm);
  _wp[0] = _p.x;
  _wp[1] = _p.y;
  _wp[2] = _p.z;
  return _wp;
}

/** Extract the Y rotation baked into a panel matrix. */
export function ryOf(pm) {
  const e = pm.elements;
  return datan2(e[8], e[10]);
}

export { L, LL };

