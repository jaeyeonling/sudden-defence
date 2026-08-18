import * as THREE from 'three';
import { datan2, dcos, dsin } from '../core/dmath.js';
import { _n, _v0, _v1, _v2, fbm3 } from './util-noise.js';

/**
 * WORLD — geometry toolkit.
 *
 * Everything in the level is built here from primitives: chamfered boxes,
 * extruded wall panels with real openings, prisms, cloth grids, tubes and
 * noise-deformed rocks. Nothing is loaded; nothing is a single plane.
 *
 * Two conventions that the rest of src/world/ relies on:
 *
 *  1. Every geometry carries a `color` attribute used as a *mask*, matching the
 *     materials contract: r = edge wear, g = grime, b = extra AO. Builders
 *     author these analytically (chamfer strips get wear, undersides and
 *     reveals get grime + AO) because curvature detection cannot know that the
 *     bottom of a wall is where the wind piles dust.
 *  2. Geometry is authored in local space and merged with a matrix, so the
 *     whole level collapses into a handful of draw calls.
 */

/**
 * Hard-surface geometry. Noise is in `util-noise.js`, instancing and mask
 * painting in `util-accum.js`, and soft goods in `util-cloth.js`; this file
 * kept the name because it holds what the seven consumers reach for most.
 */

// -------------------------------------------------------------- chamfered --
/**
 * A chamfered box. Real edges catch a specular highlight and give the vertex
 * masks somewhere to put edge wear; a stock BoxGeometry cannot.
 */
export function chamferBox(sx, sy, sz, bevel = 0.012) {
  const h = [sx * 0.5, sy * 0.5, sz * 0.5];
  const b = Math.max(0.0005, Math.min(bevel, Math.min(sx, sy, sz) * 0.4));
  // vertex(cornerIndex, faceAxis) -> position
  const signs = [];
  for (let i = 0; i < 8; i++) signs.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
  const vert = (ci, axis) => {
    const s = signs[ci];
    const p = [0, 0, 0];
    for (let a = 0; a < 3; a++) p[a] = s[a] * (a === axis ? h[a] : h[a] - b);
    return p;
  };

  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];

  const addPoly = (pts, wear, grime) => {
    // Orient outward: the box is centred on the origin, so the centroid tells
    // us which way is out.
    _v0.set(pts[0][0], pts[0][1], pts[0][2]);
    _v1.set(pts[1][0], pts[1][1], pts[1][2]);
    _v2.set(pts[2][0], pts[2][1], pts[2][2]);
    _n.copy(_v1).sub(_v0).cross(_v2.clone().sub(_v0));
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= pts.length;
    cy /= pts.length;
    cz /= pts.length;
    if (_n.x * cx + _n.y * cy + _n.z * cz < 0) pts = pts.slice().reverse();
    _v0.set(pts[0][0], pts[0][1], pts[0][2]);
    _v1.set(pts[1][0], pts[1][1], pts[1][2]);
    _v2.set(pts[2][0], pts[2][1], pts[2][2]);
    _n.copy(_v1).sub(_v0).cross(_v2.clone().sub(_v0)).normalize();
    for (let t = 1; t < pts.length - 1; t++) {
      const tri = [pts[0], pts[t], pts[t + 1]];
      for (const p of tri) {
        pos.push(p[0], p[1], p[2]);
        nrm.push(_n.x, _n.y, _n.z);
        // Planar-ish uv off the dominant axis so mesh-uv materials still work.
        const ax = Math.abs(_n.x) > Math.abs(_n.y) ? (Math.abs(_n.x) > Math.abs(_n.z) ? 0 : 2) : Math.abs(_n.y) > Math.abs(_n.z) ? 1 : 2;
        uv.push(ax === 0 ? p[2] : p[0], ax === 1 ? p[2] : p[1]);
        const gr = _n.y < -0.5 ? grime + 0.35 : grime;
        col.push(wear, Math.min(1, gr), _n.y < -0.4 ? 0.35 : 0);
      }
    }
  };

  // 6 faces
  for (let axis = 0; axis < 3; axis++) {
    for (const sa of [-1, 1]) {
      const corners = [];
      for (let ci = 0; ci < 8; ci++) if (signs[ci][axis] === sa) corners.push(ci);
      // order the four corners around the face
      const a1 = (axis + 1) % 3;
      const a2 = (axis + 2) % 3;
      corners.sort((p, q) => {
        const ap = datan2(signs[p][a2], signs[p][a1]);
        const aq = datan2(signs[q][a2], signs[q][a1]);
        return ap - aq;
      });
      addPoly(corners.map((ci) => vert(ci, axis)), 0.06, 0.0);
    }
  }
  // 12 edge strips
  for (let a = 0; a < 3; a++) {
    for (let bx = a + 1; bx < 3; bx++) {
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const cs = [];
          for (let ci = 0; ci < 8; ci++) if (signs[ci][a] === sa && signs[ci][bx] === sb) cs.push(ci);
          addPoly([vert(cs[0], a), vert(cs[0], bx), vert(cs[1], bx), vert(cs[1], a)], 1.0, 0.0);
        }
      }
    }
  }
  // 8 corner triangles
  for (let ci = 0; ci < 8; ci++) addPoly([vert(ci, 0), vert(ci, 1), vert(ci, 2)], 1.0, 0.0);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * A plain unit box: 12 triangles instead of the 44 a chamfered one costs.
 * Used for members thin enough that a 4 mm chamfer is invisible — window frame
 * rails, shutter slats, balusters, grille bars — of which the level has tens of
 * thousands, and which otherwise dominate the triangle budget.
 */
export function plainBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const pa = g.getAttribute('position');
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A single quad in the XY plane — window glass, thin panels. */
export function quad(w = 1, h = 1) {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  const pa = g.getAttribute('position');
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  return g;
}

/**
 * A rain-runoff stain, as geometry.
 *
 * Every sill, ledge, bracket, balcony slab and AC unit sheds water, and the
 * 0.6-1.8 m dark run below it is one of the loudest signals that a building has
 * stood outside for thirty years. It cannot be done with the facade's own vertex
 * masks: an extruded facade shape's front face only has vertices
 * on the outline and the hole rims — there is nowhere to put a mask halfway down
 * a wall.
 *
 * So this is a separate strip merged into the SAME material batch as the wall,
 * sitting a centimetre proud of it, whose vertex GRIME mask fades to zero at
 * every edge. Same texture, same tiling, same lighting — only the grime term
 * differs — so it reads as a stain in the render rather than as a decal stuck on
 * top of it.
 *
 * Authored in XY: x centred on the source, y running DOWN from 0 to -len.
 *
 * @param {object} rng
 * @param {number} width  strip width in metres (typically the sill width)
 * @param {number} len    how far the run carries, 0.6-1.8 m
 * @param {object} opts   { amount, cols, rows, wander }
 */
export function runoffStreak(rng, width, len, opts = {}) {
  const { amount = 0.9, cols = 5, rows = 7, wander = 0.35 } = opts;
  const seed = rng ? rng.float() * 40 : 0;
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  // Runs concentrate toward the middle of a sill and drift as they fall.
  for (let j = 0; j <= rows; j++) {
    const v = j / rows; // 0 at the source, 1 at the tail
    const drift = (fbm3(seed + v * 2.3, 4.1, 1.7, 2) - 0.5) * wander * width * v;
    // the run narrows as it dries out, but never to a point
    const wj = width * (1 - v * 0.42) * (0.85 + 0.3 * fbm3(seed + 9, v * 3.1, 2.2, 2));
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      pos.push((u - 0.5) * wj + drift, -v * len, 0);
      nrm.push(0, 0, 1);
      uv.push(u, v);
      // Feathered on all four edges: a hard-edged strip is a painted stripe.
      const side = dsin(Math.PI * u) ** 0.8;
      const head = Math.min(1, v / 0.10);
      const tail = 1 - v * v;
      const broken = 0.55 + 0.75 * fbm3(seed + u * 4.3, v * 5.7, 3.3, 2);
      const g = Math.min(1, amount * side * head * tail * broken);
      col.push(0, g, g * 0.45);
    }
  }
  const row = cols + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * row + i;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// -------------------------------------------------------------- primitives --
/** Convex/simple polygon extruded along +Y. pts = [[x,z], ...] CCW. */
export function polyPrism(pts, height, opts = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: !!opts.bevel,
    bevelThickness: opts.bevel ?? 0,
    bevelSize: opts.bevel ?? 0,
    bevelSegments: 1,
    steps: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

/** Flat irregular patch on the XZ plane — sand drifts, oil stains, render patches. */
export function patchGeometry(rng, radius, opts = {}) {
  const { lobes = 9, wobble = 0.45, sag = 0.0 } = opts;
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  pos.push(0, 0, 0);
  nrm.push(0, 1, 0);
  uv.push(0, 0);
  const rs = [];
  for (let i = 0; i < lobes; i++) rs.push(radius * (1 - wobble + rng.float() * wobble * 2));
  for (let i = 0; i < lobes; i++) {
    const t = (i / lobes) * Math.PI * 2;
    const r = rs[i];
    pos.push(dcos(t) * r, -sag, dsin(t) * r);
    nrm.push(0, 1, 0);
    uv.push(dcos(t), dsin(t));
  }
  for (let i = 0; i < lobes; i++) idx.push(0, 1 + i, 1 + ((i + 1) % lobes));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Noise-deformed rock / masonry chunk. */
export function rockGeometry(rng, size = 0.3, detail = 1, squash = 0.7) {
  const g = new THREE.IcosahedronGeometry(size * 0.5, detail);
  const pa = g.getAttribute('position');
  const seed = rng.float() * 40;
  for (let i = 0; i < pa.count; i++) {
    _v0.fromBufferAttribute(pa, i);
    const n = fbm3(_v0.x * 7 + seed, _v0.y * 7 + seed, _v0.z * 7 + seed, 2);
    const f = 0.62 + n * 0.72;
    // faceted, not blobby: quantise the radius a little
    _v0.multiplyScalar(f);
    _v0.y *= squash;
    pa.setXYZ(i, _v0.x, _v0.y, _v0.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Bend a geometry's vertices around Y so long thin objects aren't perfect. */
export function warpGeometry(geo, amp = 0.02, freq = 1.1, seed = 0) {
  const pa = geo.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    _v0.fromBufferAttribute(pa, i);
    const t = fbm3(_v0.x * freq + seed, _v0.y * freq + seed * 1.7, _v0.z * freq + seed * 2.3, 2) - 0.5;
    const t2 = fbm3(_v0.z * freq + seed * 3.1, _v0.y * freq, _v0.x * freq, 2) - 0.5;
    pa.setXYZ(i, _v0.x + t * amp, _v0.y + t2 * amp * 0.5, _v0.z + t2 * amp);
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}
