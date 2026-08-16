import * as THREE from 'three';
import { emptyMesh, loft, tube, ribbon, boxRound, superEllipse, ellipseProfile, appendMesh, computeNormals, displace, transformMesh } from './geo.js';
import { dcos, dsin } from '../core/dmath.js';
import { bendY, place } from './parts.js';

/** Knees, boots, gloves. */

/** Knee pad: a curved cap with two elastic straps. */
export function kneePad(nz, knee, _side) {
  const out = emptyMesh();
  const cap = boxRound(0.064, 0.080, 0.026, { n: 4.5, seg: 18, rows: 9, roundY: 0.42 });
  place(cap, 0, 0, 0.052, 0, 0, 0);
  bendY(cap, 0.075, 0.052);
  computeNormals(cap);
  displace(cap, (x, y, z) => nz.fbm3(x * 60, y * 60, z * 60, 3) * 0.0018);
  appendMesh(out, cap);
  for (const dy of [-0.056, 0.052]) {
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pts.push([dsin(a) * 0.066, dy, dcos(a) * 0.058 + 0.006]);
    }
    const s = ribbon(pts, 0.016, 0.006, { seg: 6, up: [0, 1, 0], upright: true });
    computeNormals(s);
    appendMesh(out, s);
  }
  place(out, knee[0], knee[1] + 0.012, knee[2] + 0.004, 0.06, 0, 0);
  computeNormals(out);
  return out;
}

/* ================================================================== */
/* Boots, gloves                                                      */
/* ================================================================== */

/** Boot: sole, upper, ankle cuff, tongue and laces. `ankle` = FootR/L bone. */
export function boot(nz, ankle, _side) {
  const out = emptyMesh();
  const ax = ankle[0], ay = ankle[1], az = ankle[2];
  // upper: lofted sections front to back
  const S = [
    [-0.078, 0.036, 0.030, 0.052],
    [-0.052, 0.044, 0.038, 0.062],
    [-0.016, 0.048, 0.044, 0.058],
    [0.030, 0.049, 0.046, 0.048],
    [0.076, 0.046, 0.042, 0.038],
    [0.112, 0.040, 0.034, 0.030],
    [0.134, 0.028, 0.022, 0.024],
  ];
  const seg = 18;
  const rings = S.map(([z, hx, hy, cy]) => ({
    pts: superEllipse(hx, hy, 2.8, seg),
    o: [ax, ay - 0.088 + cy, az + z],
    q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
  }));
  const upper = loft(rings, { capStart: true, capEnd: true });
  computeNormals(upper);
  displace(upper, (x, y, z) => nz.fbm3(x * 44, y * 44, z * 44, 3) * 0.0022);
  appendMesh(out, upper);

  // ankle cuff up the shin
  const cuff = tube(
    [
      [ax, ay + 0.010, az - 0.004],
      [ax, ay + 0.070, az - 0.002],
      [ax, ay + 0.125, az + 0.002],
    ],
    (t) => ellipseProfile(0.056 - 0.004 * t, 0.050 - 0.002 * t, 16),
    { capStart: false, capEnd: false }
  );
  computeNormals(cuff);
  displace(cuff, (x, y, z) => nz.fbm3(x * 44, y * 44, z * 44, 3) * 0.0025);
  appendMesh(out, cuff);
  return out;
}

/** Boot sole + heel block, rubber. */
export function bootSole(ankle) {
  const S = [
    [-0.082, 0.033, 0.018],
    [-0.055, 0.043, 0.020],
    [-0.020, 0.047, 0.014],
    [0.030, 0.049, 0.013],
    [0.080, 0.046, 0.013],
    [0.118, 0.038, 0.013],
    [0.140, 0.024, 0.012],
  ];
  const ax = ankle[0], ay = ankle[1], az = ankle[2];
  const rings = S.map(([z, hx, hy]) => ({
    pts: superEllipse(hx, hy, 3.6, 16),
    o: [ax, ay - 0.088 + hy + 0.001, az + z],
    q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
  }));
  const m = loft(rings, { capStart: true, capEnd: true });
  computeNormals(m);
  // heel block
  const heel = boxRound(0.036, 0.011, 0.030, { n: 4, seg: 12, rows: 4, roundY: 0.4 });
  place(heel, ax, ay - 0.082, az - 0.056);
  appendMesh(m, heel);
  computeNormals(m);
  return m;
}

/** Laces: cross-over ribbons up the boot tongue. */
export function bootLaces(ankle) {
  const out = emptyMesh();
  const ax = ankle[0], ay = ankle[1], az = ankle[2];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const z = az + 0.088 - t * 0.076;
    const y = ay - 0.028 + t * 0.070;
    const w = 0.030 - t * 0.004;
    const s = ribbon(
      [
        [ax - w, y - 0.006, z + 0.006],
        [ax, y + 0.004, z],
        [ax + w, y - 0.006, z + 0.006],
      ],
      0.008,
      0.004,
      { seg: 5, up: [0, 1, 0] }
    );
    computeNormals(s);
    appendMesh(out, s);
  }
  return out;
}

/**
 * Gloved hand curled around a grip. `wrist` is the hand bone position, `dir`
 * the direction the fingers wrap about, `axis` the grip axis.
 */
export function glove(nz, wrist, gripAxis, palmNormal, side) {
  const out = emptyMesh();
  const W = new THREE.Vector3(...wrist);
  const A = new THREE.Vector3(...gripAxis).normalize(); // along the grip
  const N = new THREE.Vector3(...palmNormal).normalize(); // out of the palm
  const S = new THREE.Vector3().crossVectors(A, N).normalize(); // across the hand

  // palm block
  const palm = boxRound(0.030, 0.048, 0.022, { n: 3.2, seg: 16, rows: 7, roundY: 0.4 });
  const m = new THREE.Matrix4().makeBasis(S, A, N);
  const pos = W.clone().addScaledVector(A, 0.030).addScaledVector(N, -0.006);
  m.setPosition(pos);
  computeNormals(palm);
  transformMesh(palm, m);
  appendMesh(out, palm);

  // finger mass: a tube curling around the grip axis
  for (let f = 0; f < 4; f++) {
    const t = f / 3;
    const pts = [];
    const startY = 0.052 - t * 0.030;
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const ang = u * 2.2;
      const r = 0.030 - u * 0.004;
      const p = W.clone()
        .addScaledVector(A, startY - 0.004 + dsin(ang) * r * 0.55)
        .addScaledVector(N, -0.020 - (1 - dcos(ang)) * r * 0.9)
        .addScaledVector(S, side * (0.020 - t * 0.019));
      pts.push([p.x, p.y, p.z]);
    }
    const fin = tube(pts, (u) => ellipseProfile(0.0115 - u * 0.002, 0.0105 - u * 0.002, 10), {
      capStart: true,
      capEnd: true,
    });
    computeNormals(fin);
    appendMesh(out, fin);
  }
  // thumb across the top
  const tp = [];
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    const p = W.clone()
      .addScaledVector(A, 0.030 + u * 0.036)
      .addScaledVector(N, 0.006 - u * 0.026)
      .addScaledVector(S, side * (-0.026 - u * 0.004));
    tp.push([p.x, p.y, p.z]);
  }
  const thumb = tube(tp, (u) => ellipseProfile(0.014 - u * 0.003, 0.013 - u * 0.003, 10), {
    capStart: true,
    capEnd: true,
  });
  computeNormals(thumb);
  appendMesh(out, thumb);

  computeNormals(out);
  displace(out, (x, y, z) => nz.fbm3(x * 90, y * 90, z * 90, 3) * 0.0012);
  return out;
}

/** Knuckle guard on the back of the glove. */
export function knuckleGuard(wrist, gripAxis, palmNormal) {
  const W = new THREE.Vector3(...wrist);
  const A = new THREE.Vector3(...gripAxis).normalize();
  const N = new THREE.Vector3(...palmNormal).normalize();
  const S = new THREE.Vector3().crossVectors(A, N).normalize();
  const g = boxRound(0.026, 0.024, 0.007, { n: 3.4, seg: 14, rows: 5, roundY: 0.5 });
  const m = new THREE.Matrix4().makeBasis(S, A, N);
  m.setPosition(W.clone().addScaledVector(A, 0.050).addScaledVector(N, 0.020));
  computeNormals(g);
  transformMesh(g, m);
  return g;
}

