import * as THREE from 'three';
import { dcos, dcosh, dexp, dsin, hypot3 } from '../core/dmath.js';
import { _v0, fbm3 } from './util-noise.js';

/** Soft goods: hanging cloth, catenary cable, sacks, and the tubes they drape over. */

/**
 * Hanging / draped cloth.
 *
 * Cloth is NOT a plane. A zero-thickness quad reads as rigid glass the instant
 * you see it edge-on — the edge goes to nothing, the front and the back are the
 * same surface, and no amount of texture rescues it. So this builds a real
 * double shell: a deformed mid-surface, offset ±half-thickness along its own
 * normal, closed by a rim strip that thickens into a rolled hem at the free
 * edges. 2 mm of thickness and a 6 mm hem bead is the whole difference between
 * fabric and a pane of coloured glass.
 *
 * Deformation is catenary sag + wind ripple + sharp triangle-wave creases
 * (a sine reads as jelly; cloth creases), with an optional frayed bottom edge.
 * Crease troughs and the hem get baked AO/grime so the surface is never flat.
 */
export function clothGeometry(w, h, opts = {}) {
  const {
    segX = 10,
    segY = 8,
    sag = 0.12,
    wrinkle = 0.03,
    twist = 0.0,
    rng = null,
    bulge = 0.0,
    /**
     * Cut a spanwise slice [u0,u1] out of the cloth while keeping the parent's
     * catenary, so an awning can be built from alternating colour strips that
     * still share one continuous surface.
     */
    uRange = null,
    seed: seedIn = null,
    /** Cloth gauge in metres: canvas ~2 mm, a rug or tarp ~3 mm. */
    thickness = 0.0022,
    /** Rolled-hem strength at the free edges (0 = raw cut edge). */
    hem = 1,
    /** Ragged / scalloped bottom edge amplitude, in metres. */
    fray = 0.0,
    /**
     * Which way the cloth bellies. Sag and bulge push toward -z by default;
     * `bow: -1` flips them, which is what a rug hung flat on a facade needs so
     * it bows out into the street instead of through the wall behind it.
     */
    bow = 1,
  } = opts;
  const u0 = uRange ? uRange[0] : 0;
  const u1 = uRange ? uRange[1] : 1;
  const sw = w * (u1 - u0); // slice width
  const nx = segX + 1;
  const ny = segY + 1;
  const nv = nx * ny;
  const seed = seedIn ?? (rng ? rng.float() * 30 : 0);

  const P = new Float32Array(nv * 3);
  const N = new Float32Array(nv * 3);
  const UV = new Float32Array(nv * 2);
  const HT = new Float32Array(nv); // half thickness per vertex
  const AO = new Float32Array(nv); // crease occlusion per vertex

  // triangle wave in -1..1: creases have corners, sines do not
  const tri = (t) => {
    const f = ((t % 1) + 1) % 1;
    return f < 0.5 ? f * 4 - 1 : 3 - f * 4;
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const uu = i / segX; // 0..1 across this slice
      const u = u0 + uu * (u1 - u0); // 0..1 across the parent cloth
      const v = j / segY; // 0 = bottom hem, 1 = the line it hangs from
      let x = (u - 0.5) * w;
      let y = (v - 0.5) * h;
      // catenary along the top edge, released as it descends
      const cat = dcosh((u - 0.5) * 2.2) - 1;
      let z = -cat * sag * (1 - v * 0.35);
      z += dsin(v * 7.1 + u * 3.3 + seed) * wrinkle * (0.4 + u * (1 - u) * 3);
      z += dsin(u * 11.3 + seed * 2) * wrinkle * 0.5 * v;
      // folds: sharp, and deepest where the cloth hangs loose at the bottom
      const cr = tri(u * 2.6 + v * 1.15 + seed * 0.37);
      z += cr * wrinkle * 0.85 * (0.4 + 0.6 * (1 - v));
      z -= bulge * dsin(u * Math.PI) * dsin(v * Math.PI);
      z *= bow;
      y -= cat * sag * 0.5;
      x += twist * (v - 0.5) * dsin(u * 4 + seed);
      if (j === 0 && fray > 0) {
        // scalloped / frayed hem: the bottom edge is never a ruled line
        y -= fray * (0.3 + 0.7 * Math.abs(dsin(u * 8.7 + seed * 1.7)));
        x += fray * 0.35 * dsin(u * 15.3 + seed);
      }
      P[k * 3] = x;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = z;
      UV[k * 2] = uu;
      UV[k * 2 + 1] = v;
      // the hem: a rolled bead at the bottom, a narrower one at the other edges
      const dBottom = v * h;
      const dTop = (1 - v) * h;
      const dSide = Math.min(uu, 1 - uu) * sw;
      const band = Math.max(
        Math.max(0, 1 - dBottom / 0.045),
        0.55 * Math.max(0, 1 - Math.min(dTop, dSide) / 0.03)
      );
      HT[k] = thickness * 0.5 * (1 + hem * 2.8 * band * band);
      AO[k] = Math.max(0, -cr) * 0.4 + band * 0.3;
    }
  }

  // mid-surface normals from grid tangents
  const tu = [0, 0, 0];
  const tv = [0, 0, 0];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const i0 = i > 0 ? i - 1 : i;
      const i1 = i < nx - 1 ? i + 1 : i;
      const j0 = j > 0 ? j - 1 : j;
      const j1 = j < ny - 1 ? j + 1 : j;
      for (let c = 0; c < 3; c++) {
        tu[c] = P[(j * nx + i1) * 3 + c] - P[(j * nx + i0) * 3 + c];
        tv[c] = P[(j1 * nx + i) * 3 + c] - P[(j0 * nx + i) * 3 + c];
      }
      const nxv = tu[1] * tv[2] - tu[2] * tv[1];
      const nyv = tu[2] * tv[0] - tu[0] * tv[2];
      const nzv = tu[0] * tv[1] - tu[1] * tv[0];
      const l = hypot3(nxv, nyv, nzv) || 1;
      N[k * 3] = nxv / l;
      N[k * 3 + 1] = nyv / l;
      N[k * 3 + 2] = nzv / l;
    }
  }

  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  const push = (px, py, pz, nx2, ny2, nz2, u2, v2, wear, grime, ao) => {
    pos.push(px, py, pz);
    nrm.push(nx2, ny2, nz2);
    uv.push(u2, v2);
    col.push(wear, grime, ao);
    return pos.length / 3 - 1;
  };

  // --- the two shells ---
  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1;
    const base = pos.length / 3;
    for (let k = 0; k < nv; k++) {
      const o = HT[k] * sign;
      // the back of a hanging cloth is dustier and never gets sun
      const grime = s === 0 ? AO[k] * 0.5 : 0.28 + AO[k] * 0.5;
      push(
        P[k * 3] + N[k * 3] * o,
        P[k * 3 + 1] + N[k * 3 + 1] * o,
        P[k * 3 + 2] + N[k * 3 + 2] * o,
        N[k * 3] * sign,
        N[k * 3 + 1] * sign,
        N[k * 3 + 2] * sign,
        UV[k * 2],
        UV[k * 2 + 1],
        AO[k] * 0.5,
        grime,
        AO[k] * (s === 0 ? 1 : 1.3)
      );
    }
    for (let j = 0; j < segY; j++) {
      for (let i = 0; i < segX; i++) {
        const a = base + j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        if (sign > 0) idx.push(a, b, d, a, d, c);
        else idx.push(a, d, b, a, c, d);
      }
    }
  }

  // --- rim strip: the hem, which is what gives the edge a silhouette ---
  const loop = [];
  for (let i = 0; i < nx - 1; i++) loop.push(i);
  for (let j = 0; j < ny - 1; j++) loop.push(j * nx + (nx - 1));
  for (let i = nx - 1; i > 0; i--) loop.push((ny - 1) * nx + i);
  for (let j = ny - 1; j > 0; j--) loop.push(j * nx);
  for (let e = 0; e < loop.length; e++) {
    const ka = loop[e];
    const kb = loop[(e + 1) % loop.length];
    const ax = P[ka * 3];
    const ay = P[ka * 3 + 1];
    const az = P[ka * 3 + 2];
    const bx = P[kb * 3];
    const by = P[kb * 3 + 1];
    const bz = P[kb * 3 + 2];
    // outward = edge x normal (the rim faces away from the cloth)
    const ex = bx - ax;
    const ey = by - ay;
    const ez = bz - az;
    const mnx = (N[ka * 3] + N[kb * 3]) * 0.5;
    const mny = (N[ka * 3 + 1] + N[kb * 3 + 1]) * 0.5;
    const mnz = (N[ka * 3 + 2] + N[kb * 3 + 2]) * 0.5;
    let ox = ey * mnz - ez * mny;
    let oy = ez * mnx - ex * mnz;
    let oz = ex * mny - ey * mnx;
    const ol = hypot3(ox, oy, oz) || 1;
    ox /= ol;
    oy /= ol;
    oz /= ol;
    const q = [];
    for (const [k, sgn] of [
      [ka, 1],
      [ka, -1],
      [kb, -1],
      [kb, 1],
    ]) {
      const o = HT[k] * sgn;
      q.push(
        push(
          P[k * 3] + N[k * 3] * o,
          P[k * 3 + 1] + N[k * 3 + 1] * o,
          P[k * 3 + 2] + N[k * 3 + 2] * o,
          ox,
          oy,
          oz,
          UV[k * 2],
          UV[k * 2 + 1],
          0.45,
          0.3 + AO[k] * 0.4,
          Math.min(1, AO[k] + 0.2)
        )
      );
    }
    idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
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

/** Sagging cable / rope / wire between two points, as a thin tube. */
export function catenaryTube(from, to, sagAmt, radius, opts = {}) {
  const { seg = 12, radial = 4, jitter = 0 } = opts;
  const pts = [];
  const K = dcosh(1.5) - 1;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    // normalised catenary droop: 0 at the ends, 1 at mid-span
    const droop = (dcosh(1.5) - dcosh((t - 0.5) * 3)) / K;
    pts.push(
      new THREE.Vector3(
        from[0] + (to[0] - from[0]) * t + (jitter ? (fbm3(i * 3.1, 1.2, 4.4, 2) - 0.5) * jitter : 0),
        from[1] + (to[1] - from[1]) * t - sagAmt * droop,
        from[2] + (to[2] - from[2]) * t + (jitter ? (fbm3(i * 2.7, 8.2, 1.4, 2) - 0.5) * jitter : 0)
      )
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, seg, radius, radial, false);
  g.computeBoundingBox();
  return g;
}

/**
 * A sack / sandbag.
 *
 * The failure mode this exists to avoid: a squashed sphere with pinched ends is
 * a lozenge, and a wall of lozenges reads as bread rolls or ravioli, not cover.
 * A filled sandbag is a rounded BOX — flat where it is compressed against its
 * neighbours, square-ish shoulders, ears bulging at the four corners, a sewn
 * seam ridge over the top and a tied, folded neck at one end.
 *
 * So the base shape is an Lp-ball (`box` 2 = sphere, 4 = nearly a brick) rather
 * than an ellipsoid, and each of the three variants has a different silhouette:
 *   0  plump, evenly filled, seam across the crown
 *   1  slumped: one end fat, the middle sagging, top dished
 *   2  half-empty: a flat folded end and a deep crease across the waist
 *
 * w/h/d are the FULL dimensions of the finished bag, in metres — a filled
 * sandbag is about 0.5 x 0.17 x 0.3, and getting that wrong makes every piece
 * of cover in the level read at the wrong scale.
 */
export function sackGeometry(rng, w = 0.5, h = 0.17, d = 0.3, opts = {}) {
  const { variant = 0, box = 3.1, lump = 1 } = opts;
  const g = new THREE.SphereGeometry(0.5, 20, 12);
  const pa = g.getAttribute('position');
  const seed = rng.float() * 50;
  for (let i = 0; i < pa.count; i++) {
    _v0.fromBufferAttribute(pa, i);
    // unit direction -> Lp ball: the boxy silhouette of a filled bag
    let ux = _v0.x * 2;
    let uy = _v0.y * 2;
    let uz = _v0.z * 2;
    const p = box;
    const q =
      Math.abs(ux) ** p + Math.abs(uy) ** p + Math.abs(uz) ** p;
    const f = q > 1e-6 ? 1 / q ** (1 / p) : 1;
    ux *= f;
    uy *= f;
    uz *= f;
    // the top of a bag under load is flatter than the bottom
    const flat = uy > 0 ? 1 - uy * uy * 0.2 : 1;
    const n = fbm3(ux * 3.4 + seed, uy * 3.4 + seed, uz * 3.4 + seed, 3) - 0.5;
    const n2 = fbm3(ux * 9 + seed * 2, uy * 8 + seed, uz * 9 + seed * 3, 2) - 0.5;
    let x = ux * w * 0.5 * (1 + n * 0.09 * lump);
    let z = uz * d * 0.5 * flat * (1 + n * 0.26 * lump + n2 * 0.11 * lump);
    let y = uy * h * 0.5 * (1 + n * 0.24 * lump + n2 * 0.1 * lump);
    const t = x / (w * 0.5); // -1..1 along the bag
    // Tied, folded ends. A bag is gathered and FLATTENED at the seams, not
    // pinched to a point: pinched ends are what make a stack read as ravioli.
    const neck = Math.max(0, Math.abs(t) - 0.7) / 0.3;
    z *= 1 - neck * neck * 0.3;
    y *= 1 - neck * neck * 0.55;
    // the sewn end seam stands out as a small flat lip
    if (neck > 0.55) y += Math.sign(uy) * h * 0.02 * (neck - 0.55) * 2;
    // the sewn seam runs the length of the crown on every bag
    if (uy > 0.15) y += h * 0.05 * dexp(-((z / (d * 0.42)) ** 2) * 6) * (1 - neck * 0.8);
    if (variant === 0) {
      z *= 1 + 0.06 * dcos(t * 2.6);
    } else if (variant === 1) {
      // slumped: fat at -x, sagging waist, dished top
      x += w * 0.04 * t;
      const fatter = 1 + 0.13 * (0.5 - t);
      z *= fatter;
      y *= fatter * (1 - 0.16 * dexp(-((t / 0.32) ** 2)));
      if (uy > 0.3) y -= h * 0.05 * dexp(-((t / 0.45) ** 2));
    } else {
      // half-empty: crease across the waist, flat folded end at +x
      const crease = dexp(-(((t - 0.1) / 0.16) ** 2));
      z *= 1 - crease * 0.2;
      y *= 1 - crease * 0.26;
      if (t > 0.5) {
        y *= 1 - (t - 0.5) * 0.5;
        z *= 1 + (t - 0.5) * 0.22;
      }
    }
    pa.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** Straight tube along +Y, capped. Pipes, poles, rebar, palm trunks. */
export function tubeY(radius, height, opts = {}) {
  const { radial = 8, taper = 1, open = false, seg = 1 } = opts;
  const g = new THREE.CylinderGeometry(radius * taper, radius, height, radial, seg, open);
  g.translate(0, height / 2, 0);
  g.computeBoundingBox();
  return g;
}

