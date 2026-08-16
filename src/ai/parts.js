/**
 * AI — body & clothing parts for the procedural soldier.
 *
 * Each function returns a mesh record in the actor's bind space (metres, feet
 * on y = 0, facing +Z, character's right at -X). `soldier.js` decides which
 * parts a variant wears and hands them to the CharacterBuilder along with the
 * bones they bind to.
 */

import * as THREE from 'three';
import { computeNormals, warp, transformMesh } from './geo.js';
import { dcos, dsin } from '../core/dmath.js';

/**
 * The three transforms every other parts file uses. They stay here; the rest
 * moved out by body region — `parts-body`, `-head`, `-headgear`, `-gear`,
 * `-extremities`. Only `bendY` and `place` cross those files; measured,
 * nothing else does.
 */

/** Cylindrical wrap about the Y axis — bends flat slabs around the torso. */
export function bendY(mesh, radius, centreZ = 0) {
  return warp(mesh, (v) => {
    const r = radius + (v.z - centreZ);
    const a = v.x / radius;
    v.x = dsin(a) * r;
    v.z = centreZ + dcos(a) * r - radius;
  });
}

/** Mirror across X (right <-> left) and fix the winding. */
export function mirrorX(mesh) {
  const out = { p: mesh.p.slice(), n: mesh.n.slice(), uv: mesh.uv.slice(), i: mesh.i.slice() };
  for (let i = 0; i < out.p.length; i += 3) out.p[i] = -out.p[i];
  for (let i = 0; i < out.n.length; i += 3) out.n[i] = -out.n[i];
  for (let t = 0; t < out.i.length; t += 3) {
    const tmp = out.i[t + 1];
    out.i[t + 1] = out.i[t + 2];
    out.i[t + 2] = tmp;
  }
  return out;
}

export function place(mesh, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz)
  );
  computeNormals(mesh);
  return transformMesh(mesh, m);
}
