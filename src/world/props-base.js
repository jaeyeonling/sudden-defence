import * as THREE from 'three';
import { mergeSimple } from './kit-openings.js';
import { fillMasks, paintMasks } from './util-accum.js';
import { chamferBox } from './util.js';

/**
 * The prop vocabulary: scratch transforms, the material shorthand, the edge-wear
 * pass, and `PB` — the builder every prop is assembled through.
 *
 * Down here rather than in `props.js` because `registerProps` calls all forty
 * builders and all forty need these; leaving them together would make the
 * category files import from the file that imports them.
 */

/**
 * WORLD — the prop library.
 *
 * Every prop is a small assembly of chamfered boxes, tubes, cloth grids and
 * noise-deformed rocks, merged into ONE geometry and registered as an
 * InstancedMesh prototype. Placement (rotation/scale/tint variation) lives in
 * dressing.js — this file only decides what things look like.
 *
 * Mask convention as everywhere else: r = edge wear, g = grime, b = extra AO,
 * multiplied per instance by instanceColor so no two crates weather alike.
 */

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

export function mat(x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}

/** Generic convex-edge detector: verts near two or more bounding faces. */
export function autoEdgeWear(geo, margin = 0.02, amount = 1) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  return paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    let near = 0;
    if (sx > margin * 3 && (x - bb.min.x < margin || bb.max.x - x < margin)) near++;
    if (sy > margin * 3 && (y - bb.min.y < margin || bb.max.y - y < margin)) near++;
    if (sz > margin * 3 && (z - bb.min.z < margin || bb.max.z - z < margin)) near++;
    if (near >= 2) out[0] = Math.max(out[0], amount);
  });
}

/** Part accumulator for one prop. */
export class PB {
  constructor() {
    this.list = [];
  }

  _push(g, wear, grime, ao) {
    if (!g.getAttribute('color')) fillMasks(g, 0.2, 0, 0);
    if (wear !== 1 || grime > 0 || ao > 0) {
      const c = g.getAttribute('color');
      for (let i = 0; i < c.count; i++) {
        c.setXYZ(
          i,
          Math.min(1, c.getX(i) * wear),
          Math.min(1, Math.max(c.getY(i), grime)),
          Math.min(1, Math.max(c.getZ(i), ao))
        );
      }
    }
    this.list.push(g);
    return g;
  }

  box(sx, sy, sz, x = 0, y = 0, z = 0, o = {}) {
    const g = chamferBox(sx, sy, sz, o.bevel ?? 0.008);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  cyl(r, h, x = 0, y = 0, z = 0, o = {}) {
    const g = new THREE.CylinderGeometry(
      (o.taper ?? 1) * r,
      r,
      h,
      o.radial ?? 12,
      o.seg ?? 1,
      o.open ?? false
    );
    autoEdgeWear(g, o.margin ?? Math.min(r, h) * 0.12, 0.9);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  geo(g, x = 0, y = 0, z = 0, o = {}) {
    if (o.autoWear !== false && !g.getAttribute('color')) autoEdgeWear(g, o.margin ?? 0.02);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0, o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  build() {
    const g = mergeSimple(this.list);
    for (const p of this.list) p.dispose();
    this.list.length = 0;
    return g;
  }
}

