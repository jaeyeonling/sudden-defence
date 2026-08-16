import * as THREE from 'three';
import { _n, _nm, _v0, fbm3 } from './util-noise.js';

/** Instance accumulation and the vertex-mask painters that weather it. */

// ----------------------------------------------------------------- matrix --
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a matrix without allocating at the call site. */
export function trs(out, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

export function newTrs(x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  return trs(new THREE.Matrix4(), x, y, z, ry, sx, sy, sz, rx, rz);
}

// ------------------------------------------------------------ accumulator --
/**
 * Merges transformed geometries into one indexed BufferGeometry.
 * Attributes: position, normal, uv, color(masks).
 */
export class Accum {
  constructor(name = 'merged') {
    this.name = name;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.verts = 0;
    this.tris = 0;
  }

  get empty() {
    return this.tris === 0;
  }

  /**
   * @param {THREE.BufferGeometry} geo
   * @param {THREE.Matrix4|null} matrix
   * @param {object} opts  { masks:[w,g,ao], paint(x,y,z,nx,ny,nz,out), mulMasks }
   */
  add(geo, matrix = null, opts = null) {
    const pa = geo.getAttribute('position');
    if (!pa) return this;
    let na = geo.getAttribute('normal');
    if (!na) {
      geo.computeVertexNormals();
      na = geo.getAttribute('normal');
    }
    const ua = geo.getAttribute('uv');
    const ca = geo.getAttribute('color');
    const index = geo.getIndex();
    const base = this.verts;
    const masks = opts?.masks ?? null;
    const paint = opts?.paint ?? null;
    const out = paint ? [0, 0, 0] : null;

    if (matrix) _nm.getNormalMatrix(matrix);

    for (let i = 0; i < pa.count; i++) {
      _v0.fromBufferAttribute(pa, i);
      if (matrix) _v0.applyMatrix4(matrix);
      _n.fromBufferAttribute(na, i);
      if (matrix) _n.applyMatrix3(_nm).normalize();
      this.pos.push(_v0.x, _v0.y, _v0.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.uv.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);

      let r = ca ? ca.getX(i) : 0;
      let g = ca ? ca.getY(i) : 0;
      let b = ca ? ca.getZ(i) : 0;
      if (masks) {
        r = Math.max(r, masks[0]);
        g = Math.max(g, masks[1]);
        b = Math.max(b, masks[2]);
      }
      if (paint) {
        out[0] = r;
        out[1] = g;
        out[2] = b;
        paint(_v0.x, _v0.y, _v0.z, _n.x, _n.y, _n.z, out);
        r = out[0];
        g = out[1];
        b = out[2];
      }
      this.col.push(r, g, b);
      this.verts++;
    }

    if (index) {
      const a = index.array;
      for (let i = 0; i < a.length; i++) this.idx.push(base + a[i]);
      this.tris += a.length / 3;
    } else {
      for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
      this.tris += pa.count / 3;
    }
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.name = this.name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(
      this.verts > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1)
    );
    g.computeBoundingSphere();
    g.computeBoundingBox();
    // Free the JS-side scratch: these arrays are megabytes.
    this.pos = this.nrm = this.uv = this.col = this.idx = null;
    return g;
  }
}

// ------------------------------------------------------------ mask helpers --
/** Rewrite a geometry's mask attribute from a callback. Local space. */
export function paintMasks(geo, fn) {
  const pa = geo.getAttribute('position');
  let na = geo.getAttribute('normal');
  if (!na) {
    geo.computeVertexNormals();
    na = geo.getAttribute('normal');
  }
  let ca = geo.getAttribute('color');
  if (!ca) {
    ca = new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3);
    geo.setAttribute('color', ca);
  }
  const out = [0, 0, 0];
  for (let i = 0; i < pa.count; i++) {
    out[0] = ca.getX(i);
    out[1] = ca.getY(i);
    out[2] = ca.getZ(i);
    fn(pa.getX(i), pa.getY(i), pa.getZ(i), na.getX(i), na.getY(i), na.getZ(i), out, i);
    ca.setXYZ(i, out[0], out[1], out[2]);
  }
  ca.needsUpdate = true;
  return geo;
}

/** Uniform mask fill (cheap path for props that don't need spatial variation). */
export function fillMasks(geo, w = 0, g = 0, a = 0) {
  const pa = geo.getAttribute('position');
  const arr = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    arr[i * 3] = w;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/**
 * Wear on convex chamfers, grime on undersides, AO+grime toward the base.
 * Applied to nearly every prop so nothing reads as a clean extruded box.
 */
export function weatherProp(geo, opts = {}) {
  const { base = 0, wear = 0.85, grime = 0.5, down = 0.6, height = 1 } = opts;
  const bb = geo.boundingBox ?? (geo.computeBoundingBox(), geo.boundingBox);
  const lo = bb.min.y;
  const h = Math.max(1e-3, height * (bb.max.y - lo));
  return paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    const up = Math.max(0, ny);
    const dn = Math.max(0, -ny);
    const t = 1 - Math.min(1, (y - lo) / h);
    const n = fbm3(x * 3.1, y * 3.3, z * 3.1, 2);
    out[0] = Math.min(1, out[0] * wear + up * 0.18 * wear * n);
    out[1] = Math.min(1, out[1] + grime * (dn * down + t * t * base) * (0.55 + 0.9 * n));
    out[2] = Math.min(1, out[2] + dn * 0.35 + t * t * base * 0.7);
  });
}

