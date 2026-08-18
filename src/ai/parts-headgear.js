import { emptyMesh, loft, tube, ribbon, ellipsoid, boxRound, superEllipse, ellipseProfile, appendMesh, computeNormals, displace, warp } from './geo.js';
import { datan2, dcos, dsin } from '../core/dmath.js';
import { bendY, place } from './parts.js';

/** Helmet, goggles, chin strap, head scarf. */

/* ================================================================== */
/* Helmet                                                             */
/* ================================================================== */

/**
 * High-cut ballistic helmet with a scalloped ear cut, a brim lip, side rails
 * and an NVG shroud. `base` is the Head bone position.
 */
export function helmet(nz, base, _p = {}) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const cy = by + 0.100; // shell centre (just above the brow)
  const rx = 0.121, ry = 0.158, rz = 0.135;

  // --- shell: revolved dome, bottom edge scalloped per angle
  const seg = 26, rows = 12;
  const rings = [];
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    // t 0 = brim, 1 = crown
    const phi = (0.5 + 0.5 * t) * Math.PI; // 90..180 deg
    const y = -dcos(phi) * ry;
    const s = dsin(phi);
    const pts = ellipseProfile(rx * Math.max(0.08, s), rz * Math.max(0.08, s), seg);
    rings.push({ pts, o: [bx, cy + y, bz - 0.006], t });
  }
  const shell = loft(rings, { capStart: false, capEnd: false });
  computeNormals(shell);
  // scallop: raise the rim over the ears, drop it at the front and back
  warp(shell, (v) => {
    const dy = v.y - cy;
    if (dy > 0.012) return;
    const ang = datan2(v.x - bx, v.z - bz);
    const side = Math.abs(dsin(ang));
    const lift = side ** 2 * 0.042 - Math.max(0, dcos(ang)) * 0.010;
    const k = Math.min(1, Math.max(0, (0.012 - dy) / 0.06));
    v.y += lift * k;
  });
  computeNormals(shell);
  displace(shell, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 3) * 0.0016);
  appendMesh(out, shell);

  // --- brim lip: a thin band following the rim
  const lipPts = [];
  const nLip = 30;
  for (let i = 0; i <= nLip; i++) {
    const a = (i / nLip) * Math.PI * 2;
    const sx = dsin(a), sz = dcos(a);
    const side = Math.abs(sx);
    const lift = side ** 2 * 0.042 - Math.max(0, sz) * 0.010;
    lipPts.push([bx + sx * rx * 0.955, cy + lift - 0.001, bz - 0.004 + sz * rz * 0.955]);
  }
  const lip = ribbon(lipPts, 0.011, 0.006, { seg: 6, up: [0, 1, 0], upright: true });
  computeNormals(lip);
  appendMesh(out, lip);

  return out;
}

/** Side rails, NVG shroud and rear counterweight pouch — the helmet hardware. */
export function helmetHardware(nz, base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const cy = by + 0.100;

  // NVG shroud on the brow
  const shroud = boxRound(0.030, 0.012, 0.022, { n: 4, seg: 12, rows: 5, roundY: 0.5 });
  place(shroud, bx, cy + 0.062, bz + 0.120, -0.50, 0, 0);
  appendMesh(out, shroud);
  const lug = boxRound(0.009, 0.016, 0.007, { n: 4, seg: 8, rows: 4, roundY: 0.4 });
  place(lug, bx, cy + 0.086, bz + 0.126, -0.50, 0, 0);
  appendMesh(out, lug);

  // ARC rails: a slotted strip down each side
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const a = (-0.55 + t * 1.1) * side;
      pts.push([
        bx + side * 0.114 * dcos(a * 0.6),
        cy + 0.052 + dsin(t * Math.PI) * 0.016,
        bz - 0.004 + dsin(a) * 0.118,
      ]);
    }
    const rail = ribbon(pts, 0.016, 0.009, { seg: 6, up: [0, 1, 0], upright: true });
    computeNormals(rail);
    appendMesh(out, rail);
  }

  // rear counterweight pouch
  const cw = boxRound(0.058, 0.034, 0.026, { n: 4, seg: 14, rows: 6, roundY: 0.5 });
  place(cw, bx, cy + 0.075, bz - 0.128, 0.28, 0, 0);
  computeNormals(cw);
  displace(cw, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 2) * 0.002);
  appendMesh(out, cw);
  return out;
}

/** Chin strap + nape pad. */
export function chinStrap(base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  const cy = by + 0.100;
  for (const side of [-1, 1]) {
    const pts = [
      [bx + side * 0.104, cy + 0.004, bz + 0.036],
      [bx + side * 0.086, cy - 0.058, bz + 0.056],
      [bx + side * 0.048, cy - 0.104, bz + 0.062],
      [bx + side * 0.014, cy - 0.118, bz + 0.054],
    ];
    const s = ribbon(pts, 0.016, 0.005, { seg: 6, up: [0, 0, 1] });
    computeNormals(s);
    appendMesh(out, s);
    const rear = [
      [bx + side * 0.106, cy + 0.000, bz - 0.024],
      [bx + side * 0.090, cy - 0.058, bz - 0.058],
      [bx + side * 0.040, cy - 0.078, bz - 0.082],
    ];
    const r = ribbon(rear, 0.014, 0.005, { seg: 6, up: [0, 1, 0] });
    computeNormals(r);
    appendMesh(out, r);
  }
  return out;
}

/** Goggles: pushed up on the shell, or pulled down over the eyes. */
export function goggles(base, down = false) {
  if (down) return gogglesDown(base);
  const frame = boxRound(0.082, 0.026, 0.024, { n: 3.2, seg: 20, rows: 6, roundY: 0.5 });
  const bx = base[0], by = base[1], bz = base[2];
  place(frame, bx, by + 0.176, bz + 0.098, -0.95, 0, 0);
  bendY(frame, 0.15, 0);
  computeNormals(frame);
  const strap = ribbon(
    [
      [bx - 0.098, by + 0.176, bz + 0.078],
      [bx - 0.118, by + 0.198, bz - 0.020],
      [bx - 0.072, by + 0.226, bz - 0.116],
      [bx + 0.072, by + 0.226, bz - 0.116],
      [bx + 0.118, by + 0.198, bz - 0.020],
      [bx + 0.098, by + 0.176, bz + 0.078],
    ],
    0.024,
    0.007,
    { seg: 6, up: [0, 1, 0], upright: true }
  );
  computeNormals(strap);
  return { frame, strap };
}

function gogglesDown(base) {
  const bx = base[0], by = base[1], bz = base[2];
  const frame = boxRound(0.078, 0.028, 0.026, { n: 3.2, seg: 20, rows: 6, roundY: 0.5 });
  place(frame, bx, by + 0.098, bz + 0.072, -0.10, 0, 0);
  bendY(frame, 0.115, 0);
  computeNormals(frame);
  const strap = ribbon(
    [
      [bx - 0.084, by + 0.100, bz + 0.058],
      [bx - 0.106, by + 0.108, bz - 0.030],
      [bx - 0.062, by + 0.116, bz - 0.108],
      [bx + 0.062, by + 0.116, bz - 0.108],
      [bx + 0.106, by + 0.108, bz - 0.030],
      [bx + 0.084, by + 0.100, bz + 0.058],
    ],
    0.026,
    0.008,
    { seg: 6, up: [0, 1, 0], upright: true }
  );
  computeNormals(strap);
  return { frame, strap, down: true };
}

/** Goggle lens — a curved slab of smoked glass. */
export function goggleLens(base, down = false) {
  if (down) {
    const bx = base[0], by = base[1], bz = base[2];
    const lens = boxRound(0.071, 0.020, 0.008, { n: 3.0, seg: 18, rows: 5, roundY: 0.6 });
    place(lens, bx, by + 0.098, bz + 0.090, -0.10, 0, 0);
    bendY(lens, 0.105, 0);
    computeNormals(lens);
    return lens;
  }
  const lens = boxRound(0.074, 0.019, 0.008, { n: 3.0, seg: 18, rows: 5, roundY: 0.6 });
  const bx = base[0], by = base[1], bz = base[2];
  place(lens, bx, by + 0.176, bz + 0.115, -0.95, 0, 0);
  bendY(lens, 0.14, 0);
  computeNormals(lens);
  return lens;
}

/**
 * Wrapped head scarf for the un-helmeted variant: a skull-hugging dome with a
 * rolled brim and a tail hanging off the back, so the silhouette reads as a
 * fighter in a shemagh rather than a bald mannequin.
 */
export function headScarf(nz, base) {
  const out = emptyMesh();
  const bx = base[0], by = base[1], bz = base[2];
  // The skull crown sits at +0.244 in head-local space, so the dome has to reach
  // +0.250 or the bare scalp pokes through the top of the wrap — which is exactly
  // what it looked like: a pink patch on the crown at every distance.
  const dome = ellipsoid(0.102, 0.146, 0.112, { seg: 22, rows: 12, v0: 0.34, v1: 1 });
  computeNormals(dome);
  place(dome, bx, by + 0.104, bz - 0.008);
  displace(dome, (x, y, z) => {
    const f = nz.fbm3(x * 26, y * 22, z * 26, 3);
    return f * 0.006 + dsin(y * 70 + f * 4) * 0.0022;
  });
  appendMesh(out, dome);
  // rolled brim
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push([bx + dsin(a) * 0.099, by + 0.118 - Math.max(0, dcos(a)) * 0.012, bz - 0.008 + dcos(a) * 0.109]);
  }
  const brim = ribbon(pts, 0.030, 0.016, { seg: 7, up: [0, 1, 0], upright: true });
  computeNormals(brim);
  appendMesh(out, brim);
  // tail down the back
  const tail = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    tail.push([
      bx + 0.028 * t,
      by + 0.115 - t * 0.20,
      bz - 0.085 - dsin(t * 2.2) * 0.03,
    ]);
  }
  const tl = tube(tail, (t) => superEllipse(0.052 - t * 0.012, 0.020 + t * 0.006, 3, 12), {
    capStart: false,
    capEnd: true,
  });
  computeNormals(tl);
  displace(tl, (x, y, z) => nz.fbm3(x * 30, y * 26, z * 30, 3) * 0.006);
  appendMesh(out, tl);
  return out;
}

