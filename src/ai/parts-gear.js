import { emptyMesh, ribbon, boxRound, appendMesh, computeNormals, displace, warp } from './geo.js';
import { dcos, dsin } from '../core/dmath.js';
import { bendY, place } from './parts.js';

/** Load-bearing kit: plates, pouches, webbing, sling, belt. */

/* ================================================================== */
/* Load-bearing gear                                                  */
/* ================================================================== */

/** One plate: a curved slab with a soft edge. */
function plate(hx, hy, hz, y, z, tilt, radius) {
  const m = boxRound(hx, hy, hz, { n: 3.6, seg: 22, rows: 11, roundY: 0.24 });
  // taper: a real plate narrows toward the waist and wraps in at the bottom
  warp(m, (v) => {
    const t = Math.max(0, -v.y / hy);
    v.x *= 1 - 0.20 * t * t;
    v.z *= 1 - 0.35 * t * t;
  });
  computeNormals(m);
  place(m, 0, y, z, tilt, 0, 0);
  bendY(m, radius, z);
  computeNormals(m);
  return m;
}

/** A pouch: rounded box with a lid, a pull tab and compression stitching. */
export function pouch(nz, o) {
  const out = emptyMesh();
  const hx = o.hx ?? 0.038, hy = o.hy ?? 0.055, hz = o.hz ?? 0.030;
  const body = boxRound(hx, hy, hz, { n: 5.5, seg: 18, rows: 8, roundY: 0.18 });
  computeNormals(body);
  displace(body, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 3) * 0.0022);
  appendMesh(out, body);
  // lid
  const lid = boxRound(hx * 1.03, 0.010, hz * 0.98, { n: 5.5, seg: 18, rows: 4, roundY: 0.5 });
  place(lid, 0, hy - 0.004, (o.lidTilt ? hz * 0.35 : 0) + hz * 0.10, (o.lidTilt ?? 0) - 0.18, 0, 0);
  computeNormals(lid);
  appendMesh(out, lid);
  // pull tab
  const tab = ribbon(
    [
      [0, hy + 0.004, hz * 0.7],
      [0, hy - 0.010, hz * 1.16],
      [0, hy - 0.034, hz * 1.10],
    ],
    0.014,
    0.004,
    { seg: 5, up: [1, 0, 0] }
  );
  computeNormals(tab);
  appendMesh(out, tab);
  place(out, o.x ?? 0, o.y ?? 0, o.z ?? 0, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
  if (o.bend) bendY(out, o.bend, o.z ?? 0);
  computeNormals(out);
  return out;
}

/** Plate carrier: front & back plates, cummerbund, shoulder straps, buckles. */
export function plateCarrier(nz, _p = {}) {
  const out = emptyMesh();
  const front = plate(0.152, 0.140, 0.030, 1.298, 0.126, -0.05, 0.20);
  displace(front, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0026);
  appendMesh(out, front);
  const back = plate(0.154, 0.148, 0.026, 1.300, -0.116, 0.05, 0.21);
  displace(back, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0026);
  appendMesh(out, back);

  // cummerbund wrapping the waist
  const cb = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    cb.push([dsin(a) * 0.168, 1.152 + dcos(a * 2) * 0.005, dcos(a) * 0.121 - 0.004]);
  }
  const band = ribbon(cb, 0.100, 0.022, { seg: 8, up: [0, 1, 0], upright: true });
  computeNormals(band);
  displace(band, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.002);
  appendMesh(out, band);

  // shoulder straps
  for (const side of [-1, 1]) {
    const pts = [
      [side * 0.082, 1.418, 0.144],
      [side * 0.100, 1.468, 0.040],
      [side * 0.104, 1.462, -0.036],
      [side * 0.092, 1.418, -0.120],
    ];
    const s = ribbon(pts, 0.076, 0.030, { seg: 8, up: [0, 1, 0] });
    computeNormals(s);
    displace(s, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.002);
    appendMesh(out, s);
  }
  return out;
}

/** Webbing: drag handle, elastic retention, admin panel loops. */
export function carrierWebbing() {
  const out = emptyMesh();
  // PALS rows across the front plate
  for (let r = 0; r < 2; r++) {
    const y = 1.322 + r * 0.046;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const x = (t - 0.5) * 0.150;
      pts.push([x, y, 0.150 - (x * x) / 0.20]);
    }
    const row = ribbon(pts, 0.013, 0.0035, { seg: 5, up: [0, 1, 0], upright: true });
    computeNormals(row);
    appendMesh(out, row);
  }
  // drag handle on the back
  const drag = ribbon(
    [
      [-0.052, 1.432, -0.132],
      [-0.022, 1.458, -0.152],
      [0.022, 1.458, -0.152],
      [0.052, 1.432, -0.132],
    ],
    0.028,
    0.010,
    { seg: 6, up: [0, 1, 0], upright: true }
  );
  computeNormals(drag);
  appendMesh(out, drag);
  return out;
}

/** Two-point sling routed across the chest. */
export function sling(gripPoint, stockPoint) {
  const pts = [
    [stockPoint[0], stockPoint[1] + 0.02, stockPoint[2]],
    [-0.130, 1.395, -0.010],
    [-0.120, 1.430, -0.090],
    [0.020, 1.430, -0.118],
    [0.120, 1.330, -0.070],
    [0.150, 1.250, 0.040],
    [0.110, 1.235, 0.135],
    [gripPoint[0] + 0.02, gripPoint[1] + 0.03, gripPoint[2] + 0.02],
  ];
  const m = ribbon(pts, 0.032, 0.009, { seg: 6, up: [0, 1, 0] });
  computeNormals(m);
  return m;
}

/** Belt with a buckle and a holster. */
export function belt(nz) {
  const out = emptyMesh();
  const pts = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([dsin(a) * 0.158, 0.902, dcos(a) * 0.113 - 0.008]);
  }
  const b = ribbon(pts, 0.056, 0.018, { seg: 7, up: [0, 1, 0], upright: true });
  computeNormals(b);
  displace(b, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 2) * 0.0018);
  appendMesh(out, b);
  return out;
}

/** Dump pouch / canteen hanging off the belt at the back. */
export function hipPouch(nz, side) {
  const m = pouch(nz, {
    hx: 0.048, hy: 0.062, hz: 0.038,
    x: side * 0.142, y: 0.878, z: -0.070,
    rz: side * 0.12, ry: side * 0.5,
  });
  return m;
}

