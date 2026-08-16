import * as THREE from 'three';
import { datan2, dcos, dsin } from '../core/dmath.js';
import { _n, _v0, _v1, _v2, fbm3 } from './util-noise.js';
import { paintMasks } from './util-accum.js';


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

// ------------------------------------------------------------ wall panels --
/**
 * Rectangular hole spec for wallPanel:
 *   { x, y, w, h, arch?:0..1, sill?:number, ragged?:number }
 * x/y is the hole centre in panel space (panel spans -w/2..w/2, 0..h).
 */
export function holePath(o, rng) {
  const p = new THREE.Path();
  const x0 = o.x - o.w / 2;
  const x1 = o.x + o.w / 2;
  const y0 = o.y - o.h / 2;
  const y1 = o.y + o.h / 2;
  if (o.ragged) {
    // Blown-out opening: irregular polygon around the nominal rect.
    const n = 18;
    const R = o.ragged;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      // square-ish superellipse so it still reads as a window hole
      const c = dcos(t);
      const s = dsin(t);
      const k = 1 / Math.max(Math.abs(c), Math.abs(s)) ** 0.85;
      const j = 1 + (rng ? rng.range(-R, R) : 0);
      pts.push([cx + c * k * rx * j, cy + s * k * ry * j]);
    }
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    p.closePath();
    return p;
  }
  if (o.arch > 0) {
    const r = (o.w / 2) * o.arch;
    const yA = y1 - r;
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, yA);
    // pointed-ish arch: two quadratics meeting at the apex reads Levantine
    p.quadraticCurveTo(x1, y1, o.x, y1);
    p.quadraticCurveTo(x0, y1, x0, yA);
    p.lineTo(x0, y0);
  } else {
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, y1);
    p.lineTo(x0, y1);
  }
  p.closePath();
  return p;
}

/**
 * A wall panel: a slab of real thickness with real holes, extruded so every
 * opening has depth and a chamfered reveal.
 *
 * @param {number} w   panel width  (x, centred)
 * @param {number} h   panel height (y, from 0 up)
 * @param {number} t   thickness    (z, from 0 to t)
 * @param {Array}  holes
 * @param {object} opts { bevel, top:'flat'|'ragged', raggedAmp, rng, jag }
 */
export function wallPanel(w, h, t, holes = [], opts = {}) {
  const { bevel = 0.02, rng = null, top = 'flat', raggedAmp = 0.5, jag = 0 } = opts;
  const shape = new THREE.Shape();
  const x0 = -w / 2;
  const x1 = w / 2;
  shape.moveTo(x0, 0);
  shape.lineTo(x1, 0);
  if (top === 'ragged') {
    // A partially collapsed wall: stepped, broken masonry silhouette.
    const steps = Math.max(4, Math.round(w / 0.55));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const x = x1 - (i / steps) * w;
      const f = i / steps;
      const drop = raggedAmp * h * (0.25 + 0.75 * fbm3(x * 0.6 + 11, 3.1, 2.7, 3)) * (0.35 + f);
      pts.push([x, Math.max(0.4, h - drop)]);
    }
    shape.lineTo(x1, pts[0][1]);
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const nx = i < pts.length - 1 ? pts[i + 1][0] : x0;
      shape.lineTo(x, y);
      shape.lineTo(nx, y + (rng ? rng.range(-0.12, 0.12) : 0));
    }
    shape.lineTo(x0, pts[pts.length - 1][1]);
  } else {
    shape.lineTo(x1, h);
    if (jag > 0) {
      const steps = Math.max(3, Math.round(w / 1.2));
      for (let i = steps - 1; i >= 1; i--) {
        const x = x0 + (i / steps) * w;
        shape.lineTo(x, h + (fbm3(x * 1.7, 5.5, 1.3, 2) - 0.5) * jag);
      }
    }
    shape.lineTo(x0, h);
  }
  shape.lineTo(x0, 0);
  for (const o of holes) shape.holes.push(holePath(o, rng));

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.02, t - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: opts.curveSegments ?? 6,
    steps: 1,
  });
  if (bevel > 0) geo.translate(0, 0, bevel);
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  // Masks: reveals (normals in the panel plane) get crevice grime + AO, the
  // bottom of the wall gets the dirt splash, chamfers get wear.
  paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    const face = Math.abs(nz);
    const reveal = 1 - face;
    const n = fbm3(x * 2.3, y * 2.1, z * 2.7, 2);
    out[0] = Math.min(1, reveal * 0.55 * (0.4 + n) + Math.max(0, ny) * 0.3);
    out[1] = Math.min(1, reveal * 0.42 * (0.5 + n) + Math.max(0, -ny) * 0.55);
    out[2] = Math.min(1, reveal * 0.4 + Math.max(0, -ny) * 0.4);
  });
  return geo;
}

/**
 * A rain-runoff stain, as geometry.
 *
 * Every sill, ledge, bracket, balcony slab and AC unit sheds water, and the
 * 0.6-1.8 m dark run below it is one of the loudest signals that a building has
 * stood outside for thirty years. It cannot be done with the facade's own vertex
 * masks: `wallPanel` is an extruded shape, so its front face only has vertices
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

/**
 * The solid rectangles left once the holes are cut — used for collision, so a
 * doorway is a real gap in the collision hull and not a triangle soup query.
 * Returns [{x, y, w, h}] in panel space.
 */
export function solidSlabs(w, h, holes) {
  // Split into vertical bands at every hole edge, then within each band into
  // horizontal runs between holes that overlap that band.
  const xs = new Set([-w / 2, w / 2]);
  for (const o of holes) {
    xs.add(Math.max(-w / 2, o.x - o.w / 2));
    xs.add(Math.min(w / 2, o.x + o.w / 2));
  }
  const cuts = [...xs].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const bx0 = cuts[i];
    const bx1 = cuts[i + 1];
    if (bx1 - bx0 < 1e-4) continue;
    const mid = (bx0 + bx1) / 2;
    const spans = holes
      .filter((o) => mid > o.x - o.w / 2 && mid < o.x + o.w / 2)
      .map((o) => [Math.max(0, o.y - o.h / 2), Math.min(h, o.y + o.h / 2)])
      .sort((a, b) => a[0] - b[0]);
    let y = 0;
    for (const [s0, s1] of spans) {
      if (s0 > y) out.push({ x: (bx0 + bx1) / 2, y: (y + s0) / 2, w: bx1 - bx0, h: s0 - y });
      y = Math.max(y, s1);
    }
    if (y < h) out.push({ x: (bx0 + bx1) / 2, y: (y + h) / 2, w: bx1 - bx0, h: h - y });
  }
  return out;
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

/**
 * A drift berm: a ridge of blown sand or swept rubble piled against a wall.
 *
 * Runs along local +X for `len`, `w` deep in Z with the TALL edge at z=0 (put
 * that edge against the wall) feathering to nothing at z=w. The crest wanders and
 * dips along its length and the toe is scalloped, so it never reads as an
 * extruded triangle. This is the single cheapest fix for the hard geometric line
 * where a wall meets the ground — the thing that otherwise looks like a
 * Z-fighting seam in every wide shot.
 */
export function driftBerm(rng, len, w, h, opts = {}) {
  const nx = Math.max(4, Math.round(len / 0.55));
  const nz = opts.nz ?? 4;
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const seed = rng.float() * 30;
  for (let i = 0; i <= nx; i++) {
    const u = i / nx;
    const x = (u - 0.5) * len;
    // crest height wanders, and the ends taper into the ground
    const taper = Math.min(1, Math.min(u, 1 - u) * 6);
    const wob = 0.45 + fbm3(x * 0.7 + seed, 2.1, seed, 3) * 1.1;
    const ch = h * wob * taper;
    const cw = w * (0.6 + fbm3(x * 0.5 + seed + 7, 5.3, 1.9, 2) * 0.85);
    for (let j = 0; j <= nz; j++) {
      const v = j / nz;
      // cosine section: steep at the wall, long feathered toe out into the road
      const y = ch * dcos((v * Math.PI) / 2) ** 1.7;
      const rip = fbm3(x * 2.3 + seed, v * 3.1, 8.4, 2) - 0.5;
      pos.push(x, Math.max(0, y + rip * h * 0.22 * (1 - v)), v * cw);
      nrm.push(0, 1, 0);
      uv.push(x * 0.5, v * cw * 0.5);
    }
  }
  const row = nz + 1;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
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


export function disposeAll(list) {
  for (const g of list) g?.dispose?.();
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

