import * as THREE from 'three';
import { dcos, dsin, hypot2 } from '../core/dmath.js';
import { paintMasks } from './util-accum.js';
import { rockGeometry } from './util.js';
import { IDENT, LL } from './kit-base.js';

// ================================================================== damage ==
/**
 * Bullet pocks: a shallow crater with a chipped rim. Instanced by the caller.
 * Origin on the wall face, opening toward +Z.
 *
 * This used to be a solid `ConeGeometry` rotated to point along +Z, i.e. a
 * CONVEX spike sticking r*1.3 straight OUT of the render — the opposite of a
 * crater. At the sizes the callers use (radius up to 8 cm) every burst read as a
 * cluster of dark faceted heptagonal lumps glued onto the plaster, which is the
 * "rows of dark dots" artifact the critics kept flagging on the facades and the
 * concrete barrier.
 *
 * We cannot cut a real hole: the wall behind is opaque geometry at z = 0, so any
 * vertex pushed to z < 0 simply disappears. A crater therefore has to be built
 * the way a decal artist builds one — the floor sits ~flush with the wall and the
 * RIM is raised, so the shading gradient reads as a depression. Nothing ever
 * breaks the silhouette by more than a couple of millimetres.
 *
 * The rng is drawn exactly 16 times, matching the old implementation, because
 * `registerProps` shares one stream with the whole level build: changing the
 * draw count here silently re-rolls every window state and roof prop downstream.
 */
export function pockGeometry(rng, r = 0.05) {
  const SEG = 8;
  // (radius factor, height factor) — floor, bowl wall, rim crest, outer skirt.
  const RINGS = [
    [0.0, 0.010],
    [0.42, 0.024],
    [0.8, 0.075],
    [1.0, 0.004],
  ];
  // chipped rim: per-segment radius and crest-height jitter. 8 + 8 = 16 draws.
  const jr = [];
  const jz = [];
  for (let s = 0; s < SEG; s++) jr.push(1 + (rng.float() - 0.5) * 0.42);
  for (let s = 0; s < SEG; s++) jz.push(0.62 + rng.float() * 0.76);

  const pos = [];
  const idx = [];
  // ring 0 is the single centre vertex; rings 1..3 are full circles.
  pos.push(0, 0, RINGS[0][1] * r);
  for (let k = 1; k < RINGS.length; k++) {
    const [rf, zf] = RINGS[k];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      // Only the two outer rings are chipped; the bowl stays smooth so the
      // floor does not poke through the wall.
      const rj = k >= 2 ? jr[s] : 1;
      const zj = k === 2 ? jz[s] : 1;
      pos.push(dcos(a) * rf * r * rj, dsin(a) * rf * r * rj, zf * r * zj);
    }
  }
  const ringStart = (k) => 1 + (k - 1) * SEG;
  for (let s = 0; s < SEG; s++) {
    const n = (s + 1) % SEG;
    idx.push(0, ringStart(1) + s, ringStart(1) + n); // floor fan
  }
  for (let k = 1; k < RINGS.length - 1; k++) {
    const a0 = ringStart(k);
    const b0 = ringStart(k + 1);
    for (let s = 0; s < SEG; s++) {
      const n = (s + 1) % SEG;
      idx.push(a0 + s, b0 + s, b0 + n, a0 + s, b0 + n, a0 + n);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    // Wear (exposed substrate) and AO are strongest in the crater floor; the
    // raised rim is cleaner and catches light, which is what sells the depth.
    const t = Math.min(1, hypot2(x, y) / (r * 0.8));
    out[0] = 0.9 - 0.35 * t;
    out[1] = 0.62 - 0.3 * t;
    out[2] = 0.9 - 0.55 * t;
  });
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}


/** Rubble mound: a low pile of masonry chunks and dust. */
export function rubbleMound(A, rng, x, y, z, radius, count, opts = {}) {
  const key = opts.key ?? 'concrete';
  for (let i = 0; i < count; i++) {
    const a = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(rng.float()) * radius;
    const s = rng.range(0.09, 0.3) * (1 - rr / radius / 1.6);
    const g = rockGeometry(rng, s, 0, 0.75);
    A.addOnce(
      key,
      g,
      LL(
        IDENT,
        x + dcos(a) * rr,
        y + s * 0.3 + Math.max(0, (1 - rr / radius) * radius * 0.3),
        z + dsin(a) * rr,
        rng.float() * 6.28,
        1,
        1,
        1,
        rng.range(-0.4, 0.4),
        rng.range(-0.4, 0.4)
      ),
      { masks: [0.3, 0.75, 0.45] }
    );
  }
  A.box(A.surfaceOf(key), x, y + radius * 0.14, z, radius * 1.5, radius * 0.34, radius * 1.5);
}

