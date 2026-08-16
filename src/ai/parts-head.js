import { emptyMesh, loft, ribbon, ellipsoid, boxRound, superEllipse, appendMesh, computeNormals, displace, warp } from './geo.js';
import { dcos, dexp, dsin } from '../core/dmath.js';
import { bendY, place } from './parts.js';

/** Skull, face, and what is worn on the face. */

/* ================================================================== */
/* Head                                                              */
/* ================================================================== */

/** Skull + jaw, lofted from anatomical sections. `base` = Head bone position. */
export function headMesh(nz, base, p = {}) {
  const w = p.wide ?? 1;
  const S = [
    [0.000, 0.038 * w, 0.050, 0.020, 2.6],
    [0.020, 0.056 * w, 0.068, 0.014, 2.6],
    [0.044, 0.068 * w, 0.076, 0.007, 2.5],
    [0.070, 0.077 * w, 0.083, 0.001, 2.4],
    [0.095, 0.084 * w, 0.088, -0.002, 2.4],
    [0.119, 0.086 * w, 0.090, -0.005, 2.4],
    [0.146, 0.083 * w, 0.089, -0.009, 2.4],
    [0.176, 0.076 * w, 0.082, -0.012, 2.4],
    [0.205, 0.062 * w, 0.066, -0.014, 2.4],
    [0.230, 0.038 * w, 0.041, -0.014, 2.4],
    [0.244, 0.012 * w, 0.013, -0.014, 2.4],
  ];
  const seg = 24;
  const rings = S.map(([y, hx, hz, zo, n]) => ({
    pts: superEllipse(hx, hz, n, seg),
    o: [base[0], base[1] + y, base[2] + zo],
  }));
  const m = loft(rings, { capStart: true, capEnd: false });
  computeNormals(m);

  const bx = base[0], by = base[1], bz = base[2];
  // features, all in head-local coordinates
  warp(m, (v) => {
    const x = v.x - bx, y = v.y - by, z = v.z - bz;
    const front = Math.max(0, z / 0.09);
    // brow ridge
    const brow = dexp(-((y - 0.113) ** 2) / 0.00016) * front * dexp(-(x * x) / 0.006);
    // eye sockets
    const socket =
      dexp(-((Math.abs(x) - 0.033) ** 2) / 0.00035) *
      dexp(-((y - 0.098) ** 2) / 0.00022) * front;
    // cheekbone
    const cheek =
      dexp(-((Math.abs(x) - 0.055) ** 2) / 0.0009) *
      dexp(-((y - 0.070) ** 2) / 0.0007) * Math.max(0, z / 0.06);
    // temple flattening
    const temple = dexp(-((y - 0.150) ** 2) / 0.0016) * dexp(-((Math.abs(x) - 0.082) ** 2) / 0.0006);
    // chin
    const chin = dexp(-(y * y) / 0.00035) * front;
    // occiput
    const occ = dexp(-((y - 0.165) ** 2) / 0.0018) * Math.max(0, -z / 0.09);
    const scale = 1 + 0.05 * brow - 0.10 * socket + 0.05 * cheek - 0.06 * temple;
    v.x = bx + x * (1 - 0.05 * socket - 0.05 * temple);
    v.y = by + y;
    v.z = bz + z * scale + 0.006 * brow + 0.004 * chin + 0.008 * occ * -1;
  });
  computeNormals(m);
  displace(m, (x, y, z) => nz.fbm3(x * 70, y * 70, z * 70, 3) * 0.0012);
  return m;
}

/** Nose wedge + nostrils. */
export function nose(nz, base) {
  const bx = base[0], by = base[1], bz = base[2];
  const S = [
    [0.118, 0.075, 0.009, 0.010],
    [0.104, 0.084, 0.011, 0.016],
    [0.088, 0.093, 0.014, 0.020],
    [0.074, 0.100, 0.017, 0.021],
    [0.064, 0.100, 0.020, 0.018],
    [0.058, 0.092, 0.019, 0.012],
  ];
  const rings = S.map(([y, z, hx, hz]) => ({
    pts: superEllipse(hx, hz, 2.2, 12),
    o: [bx, by + y, bz + z],
  }));
  const m = loft(rings, { capStart: false, capEnd: true });
  computeNormals(m);
  return m;
}

/** Ear: a folded flattened ellipsoid. */
export function ear(nz, base, side) {
  const m = ellipsoid(0.010, 0.030, 0.020, { seg: 12, rows: 9 });
  computeNormals(m);
  warp(m, (v) => {
    v.z += v.y * 0.25;
    v.x += Math.abs(v.y) * 0.10;
  });
  place(m, base[0] + side * 0.083, base[1] + 0.098, base[2] - 0.008, 0.1, side * 0.25, 0);
  return m;
}

/** Eyeball: a small dark glossy sphere set into the socket. */
export function eyeball(base, side) {
  const m = ellipsoid(0.0125, 0.0125, 0.0125, { seg: 12, rows: 8 });
  computeNormals(m);
  place(m, base[0] + side * 0.032, base[1] + 0.0975, base[2] + 0.0665);
  return m;
}

/**
 * Balaclava / shemagh wrap over the lower face and neck.
 *
 * The wrap is not just a dome: the thing that makes a covered face read as a
 * FACE at 35 m is the hem seam along the eye line plus the bridge fold over the
 * nose. Without them the lower head is one smooth value and the figure has no
 * legible facing direction — which is exactly the "featureless void" note. Both
 * are built as geometry (a rolled hem ribbon and a centre-front seam) so they
 * survive to whatever mip the diffuse ends up at.
 */
export function faceWrap(nz, base, _p = {}) {
  const bx = base[0], by = base[1], bz = base[2];
  const S = [
    [-0.075, 0.062, 0.062, -0.010, 2.6],
    [-0.040, 0.070, 0.072, -0.006, 2.6],
    [-0.010, 0.080, 0.084, 0.004, 2.5],
    [0.014, 0.070, 0.082, 0.014, 2.5],
    [0.038, 0.078, 0.086, 0.008, 2.5],
    [0.060, 0.086, 0.092, 0.002, 2.4],
    [0.076, 0.090, 0.094, -0.002, 2.4],
    [0.086, 0.090, 0.093, -0.006, 2.4],
  ];
  const seg = 22;
  const rings = S.map(([y, hx, hz, zo, n]) => ({
    pts: superEllipse(hx, hz, n, seg),
    o: [bx, by + y, bz + zo],
  }));
  const m = loft(rings, { capStart: false, capEnd: false });
  computeNormals(m);
  // cut the front open above the eye line by pulling the top ring back
  displace(m, (x, y, z) => {
    const fold = nz.fbm3(x * 30, y * 24, z * 30, 3);
    const wrap = dsin(y * 90 + fold * 4) * 0.5 + 0.5;
    return fold * 0.005 + wrap * 0.0035;
  });

  const out = emptyMesh();
  appendMesh(out, m);

  // --- rolled hem along the eye line -----------------------------------
  // A wrap's top edge is a doubled-over hem: 8 mm of roll that catches the key
  // light and draws the horizontal line under the eyes.
  const hem = [];
  const nHem = 26;
  for (let i = 0; i <= nHem; i++) {
    const a = (i / nHem) * Math.PI * 2;
    const sx = dsin(a), sz = dcos(a);
    // the hem rides higher over the cheeks and dips at the bridge of the nose
    const y = 0.086 + Math.max(0, sz) * 0.006 - dexp(-(sx * sx) / 0.06) * Math.max(0, sz) * 0.010;
    hem.push([bx + sx * 0.092, by + y, bz + sz * 0.096 - 0.004]);
  }
  const roll = ribbon(hem, 0.015, 0.008, { seg: 6, up: [0, 1, 0], upright: true });
  computeNormals(roll);
  appendMesh(out, roll);

  // --- centre-front seam from the chin to the hem ------------------------
  const seam = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    seam.push([bx, by + 0.082 - t * 0.086, bz + 0.088 - t * 0.020]);
  }
  const sm = ribbon(seam, 0.009, 0.004, { seg: 5, up: [1, 0, 0] });
  computeNormals(sm);
  appendMesh(out, sm);

  // --- bridge fold over the nose ----------------------------------------
  const bridge = ribbon(
    [
      [bx - 0.042, by + 0.070, bz + 0.070],
      [bx, by + 0.078, bz + 0.092],
      [bx + 0.042, by + 0.070, bz + 0.070],
    ],
    0.013,
    0.005,
    { seg: 6, up: [0, 1, 0] }
  );
  computeNormals(bridge);
  appendMesh(out, bridge);

  computeNormals(out);
  return out;
}

/**
 * Wrap-around dark shooting glasses for the un-helmeted fighter: a curved lens
 * plus two thin temples. This is the whole of variant #2's facing cue — a dark
 * horizontal band at the eye line, which is the one feature that survives to
 * 35 m on a bare head.
 */
export function sunglasses(base) {
  const bx = base[0], by = base[1], bz = base[2];
  const lens = boxRound(0.072, 0.0155, 0.006, { n: 3.0, seg: 18, rows: 5, roundY: 0.6 });
  place(lens, bx, by + 0.100, bz + 0.080, -0.06, 0, 0);
  bendY(lens, 0.098, 0);
  computeNormals(lens);
  const frame = emptyMesh();
  for (const side of [-1, 1]) {
    const arm = ribbon(
      [
        [bx + side * 0.070, by + 0.104, bz + 0.062],
        [bx + side * 0.083, by + 0.104, bz + 0.010],
        [bx + side * 0.080, by + 0.100, bz - 0.030],
      ],
      0.008,
      0.004,
      { seg: 5, up: [0, 1, 0], upright: true }
    );
    computeNormals(arm);
    appendMesh(frame, arm);
  }
  computeNormals(frame);
  return { lens, frame };
}

