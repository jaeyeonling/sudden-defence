import * as THREE from 'three';
import { loft, tube, ellipsoid, superEllipse, ellipseProfile, computeNormals, displace, warp } from './geo.js';
import { dexp, dsin } from '../core/dmath.js';
import { place } from './parts.js';

/** Torso, pelvis, collar, limbs. */

/* ================================================================== */
/* Torso                                                              */
/* ================================================================== */

/**
 * The jacket shell: lofted horizontal sections from the hem to the neck with a
 * real spinal curve, a deeper chest than back, and layered fold noise. This is
 * the silhouette everything else hangs on.
 */
export function jacketTorso(nz, p = {}) {
  const flare = p.flare ?? 1;
  const bulk = p.bulk ?? 1;
  // y, half-width, half-depth, z offset, corner exponent
  const S = [
    [0.865, 0.150 * flare, 0.107 * flare, -0.004, 3.0],
    [0.925, 0.156, 0.110, -0.008, 3.0],
    [0.985, 0.152, 0.105, -0.012, 3.1],
    [1.055, 0.146, 0.100, -0.014, 3.2],
    [1.120, 0.150, 0.104, -0.010, 3.2],
    [1.185, 0.161, 0.112, -0.004, 3.1],
    [1.250, 0.172 * bulk, 0.113 * bulk, 0.002, 3.0],
    [1.310, 0.184 * bulk, 0.117 * bulk, 0.005, 2.9],
    [1.365, 0.195 * bulk, 0.118 * bulk, 0.004, 2.8],
    [1.418, 0.198, 0.111, -0.002, 2.7],
    [1.452, 0.152, 0.096, -0.008, 2.6],
    [1.482, 0.098, 0.080, -0.010, 2.4],
    [1.505, 0.070, 0.066, -0.010, 2.3],
  ];
  const seg = 26;
  const rings = S.map(([y, hx, hz, zo, n]) => ({
    pts: superEllipse(hx, hz, n, seg),
    o: [0, y, zo],
  }));
  const m = loft(rings, { capStart: true, capEnd: false });
  computeNormals(m);

  // chest deeper at the front than the back, shoulders squared off
  warp(m, (v) => {
    const t = Math.max(0, Math.min(1, (v.y - 1.1) / 0.3));
    if (v.z > 0) v.z += 0.016 * t;
    else v.z -= 0.006 * t;
    // trapezius slope
    if (v.y > 1.40) v.y -= 0.02 * Math.min(1, Math.abs(v.x) / 0.18) ** 2;
  });
  computeNormals(m);

  // cloth folds: horizontal creases at the waist, vertical pull from the plate
  displace(m, (x, y, z, _nx, _ny, _nz2) => {
    const fold = nz.fbm3(x * 22, y * 15, z * 22, 3);
    const crease = dsin(y * 38 + fold * 3.4) * 0.5 + 0.5;
    const waist = dexp(-((y - 1.06) ** 2) / 0.006);
    const gather = dexp(-((y - 0.93) ** 2) / 0.004);
    return (
      fold * 0.0026 +
      crease * (waist * 0.0022 + gather * 0.0018) +
      nz.fbm3(x * 46, y * 46, z * 46, 2) * 0.0007
    );
  });
  return m;
}

/** Pelvis / seat block so the hips read solid between jacket hem and trousers. */
export function pelvis(nz) {
  const seg = 22;
  const rings = [
    [0.845, 0.140, 0.100],
    [0.885, 0.148, 0.106],
    [0.935, 0.152, 0.108],
    [0.985, 0.150, 0.104],
    [1.030, 0.144, 0.098],
  ].map(([y, hx, hz]) => ({ pts: superEllipse(hx, hz, 3.0, seg), o: [0, y, -0.006] }));
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 26, y * 20, z * 26, 3) * 0.004);
  return m;
}

/** Collar: a short stand-up band around the neck. */
export function collar(nz) {
  const seg = 22;
  const rings = [
    [1.435, 0.108, 0.092],
    [1.470, 0.090, 0.082],
    [1.500, 0.082, 0.076],
    [1.516, 0.086, 0.080],
  ].map(([y, hx, hz]) => ({ pts: superEllipse(hx, hz, 2.6, seg), o: [0, y, -0.006] }));
  const m = loft(rings, { capStart: false, capEnd: true });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 40, y * 30, z * 40, 2) * 0.003);
  return m;
}

/* ================================================================== */
/* Limbs                                                              */
/* ================================================================== */

/**
 * Sleeve / trouser leg: a tube down a 3-point bone chain with an elliptical
 * cross-section that is wider than deep, plus fold noise at the joints.
 *
 * CLOTH FOLDS (`opts.crease`) — isotropic fbm on a tube gives a lumpy tube, not
 * cloth. Real sleeves and trousers crease in bands that run *around* the limb,
 * they bunch where the limb bends, and they gather at the cuff where the fabric
 * is stopped by a hem. So the crease field is parameterised by arc length `s`
 * down the bone chain, not by world position:
 *
 *   - transverse bands at 5-7 cm, ridged so each one is a sharp line with a soft
 *     valley either side (that is what a pressed crease looks like in light);
 *   - a x2.4 gather inside the elbow / behind the knee (`s` near the joint, on
 *     the bend side), which is the single most legible fold on a walking figure;
 *   - a x1.8 gather at the cuff, where the fabric stacks on the boot or glove.
 *
 * `opts.bend` is the direction the joint folds toward in bind space (default
 * -Z, i.e. behind the knee / inside the elbow for a figure facing +Z).
 */
export function limbTube(nz, a, b, c, radii, opts = {}) {
  const pts = [];
  const N = opts.rings ?? 11;
  const segs = opts.seg ?? 14;
  // sample the two-segment path with a smooth blend around the joint
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), C = new THREE.Vector3(...c);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    if (t <= 0.5) tmp.lerpVectors(A, B, t * 2);
    else tmp.lerpVectors(B, C, (t - 0.5) * 2);
    // round the corner slightly so the knee/elbow is not a crease
    if (t > 0.34 && t < 0.66) {
      const k = 1 - Math.abs(t - 0.5) / 0.16;
      tmp.lerp(new THREE.Vector3().addVectors(A, C).multiplyScalar(0.5), 0.06 * k);
    }
    pts.push([tmp.x, tmp.y, tmp.z]);
  }
  const flat = opts.flat ?? 0.88;
  const m = tube(
    pts,
    (t) => {
      const r = radiusAt(radii, t);
      return ellipseProfile(r, r * flat, segs);
    },
    { capStart: opts.capStart ?? false, capEnd: opts.capEnd ?? false, up: opts.up ?? [0, 0, 1] }
  );
  computeNormals(m);
  const amp = opts.fold ?? 0.0016;
  const crease = opts.crease ?? 0;
  if (crease > 0) {
    // arc-length parameterisation of the two-segment chain
    const AB = new THREE.Vector3().subVectors(B, A);
    const BC = new THREE.Vector3().subVectors(C, B);
    const lAB = AB.length(), lBC = BC.length();
    const uAB = AB.clone().divideScalar(Math.max(1e-5, lAB));
    const uBC = BC.clone().divideScalar(Math.max(1e-5, lBC));
    const total = lAB + lBC;
    const bend = new THREE.Vector3(...(opts.bend ?? [0, 0, -1])).normalize();
    const q = new THREE.Vector3();
    displace(m, (x, y, z, nx, ny, nzc) => {
      // distance along the chain, and how far out along the bend axis we are
      const tAB = Math.max(0, Math.min(lAB, q.set(x, y, z).sub(A).dot(uAB)));
      const tBC = Math.max(0, Math.min(lBC, q.set(x, y, z).sub(B).dot(uBC)));
      const s = tAB < lAB - 1e-4 ? tAB : lAB + tBC;
      const u = s / total;
      // transverse crease bands: ridged, 5.5 cm, jittered so they are not a
      // corduroy ripple
      const jit = nz.fbm3(x * 6, y * 5, z * 6, 2) - 0.5;
      const band = Math.abs(dsin((s / 0.055 + jit * 0.9) * Math.PI));
      const ridged = 1 - band ** 0.65;
      // where the cloth actually bunches
      const joint = dexp(-((u - 0.5) ** 2) / 0.012);
      const cuff = dexp(-((u - 0.94) ** 2) / 0.004);
      const inner = Math.max(0, bend.x * nx + bend.y * ny + bend.z * nzc);
      const gather = 1 + joint * (0.6 + 1.8 * inner) + cuff * 0.8;
      // broad fold field on top, so the limb is never a clean cylinder
      const broad = nz.fbm3(x * 9, y * 7 + u * 3.1, z * 9, 3) - 0.5;
      return crease * (ridged * gather * 0.9 + broad * 1.1);
    });
    computeNormals(m);
  }
  displace(m, (x, y, z) => {
    const f = nz.fbm3(x * 11, y * 9, z * 11, 3);
    const fine = nz.fbm3(x * 34, y * 30, z * 34, 2);
    return f * amp + fine * amp * 0.3;
  });
  return m;
}

function radiusAt(radii, t) {
  const n = radii.length - 1;
  const s = t * n;
  const i = Math.min(n - 1, Math.floor(s));
  const f = s - i;
  return radii[i] + (radii[i + 1] - radii[i]) * f;
}

/** Deltoid cap so the shoulder is round rather than a tube end. */
export function shoulderCap(nz, shoulder, side) {
  const m = ellipsoid(0.052, 0.064, 0.056, { seg: 18, rows: 12 });
  computeNormals(m);
  warp(m, (v) => {
    v.y *= 1.0;
    if (v.y < 0) v.x *= 0.9;
  });
  place(m, shoulder[0] + side * 0.012, shoulder[1] - 0.008, shoulder[2], 0, 0, -side * 0.12);
  displace(m, (x, y, z) => nz.fbm3(x * 30, y * 30, z * 30, 3) * 0.004);
  return m;
}

