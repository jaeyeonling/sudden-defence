import * as THREE from 'three';
import { paintMasks } from './util-accum.js';
import { sackGeometry } from './util-cloth.js';
import { fbm3 } from './util-noise.js';
import { rockGeometry, warpGeometry } from './util.js';
import { PB, autoEdgeWear } from './props-base.js';

/** Things that hold things: crates, boxes, drums, cans, sandbags, barriers. */

// ============================================================== containers ==
export function crate(rng, s = 0.62, slats = true) {
  const p = new PB();
  p.box(s, s * 0.85, s * 0.92, 0, 0, 0, { bevel: 0.012, grime: 0.12 });
  if (slats) {
    // plank slats standing proud of the body, with one board sprung loose
    const n = 3;
    for (let i = 0; i < n; i++) {
      const y = -s * 0.32 + (i / (n - 1)) * s * 0.64;
      const loose = rng.float() < 0.18;
      p.box(s * 1.01, s * 0.14, 0.016, 0, y, s * 0.46, {
        bevel: 0.004,
        rz: loose ? rng.range(-0.12, 0.12) : 0,
        wear: 1,
      });
      p.box(s * 1.01, s * 0.14, 0.016, 0, y, -s * 0.46, { bevel: 0.004 });
      p.box(0.016, s * 0.14, s * 0.94, s * 0.5, y, 0, { bevel: 0.004 });
      p.box(0.016, s * 0.14, s * 0.94, -s * 0.5, y, 0, { bevel: 0.004 });
    }
    // corner posts
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        p.box(0.05, s * 0.86, 0.05, sx * (s * 0.48), 0, sz * (s * 0.44), { bevel: 0.006 });
    // lid boards with real gaps: the top face is what the player looks down on,
    // and one unbroken panel there is what makes a crate read as a solid block
    const lid = 4;
    for (let i = 0; i < lid; i++) {
      const z = -s * 0.46 + ((i + 0.5) / lid) * s * 0.92;
      p.box(s * 1.0, 0.02, (s * 0.92) / lid - 0.012, 0, s * 0.425 + 0.012, z, {
        bevel: 0.004,
        rz: rng.range(-0.006, 0.006),
        wear: 1,
      });
    }
    // a cross batten and a couple of nail heads' worth of relief
    p.box(s * 1.02, 0.022, 0.055, 0, s * 0.44, s * 0.2, { bevel: 0.004, wear: 1 });
  }
  const g = p.build();
  g.translate(0, s * 0.425, 0);
  return g;
}

export function cardboardBox(rng, s = 0.45) {
  const p = new PB();
  const h = s * rng.range(0.6, 0.9);
  p.box(s, h, s * rng.range(0.8, 1.1), 0, 0, 0, { bevel: 0.006, grime: 0.25 });
  // flaps, one folded up
  p.box(s * 0.48, 0.012, s * 0.9, -s * 0.25, h / 2 + 0.006, 0, { bevel: 0.003, wear: 1 });
  p.box(s * 0.48, 0.012, s * 0.9, s * 0.25, h / 2 + 0.09, 0, { bevel: 0.003, rz: -0.9 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

export function barrel(rng, r = 0.29, h = 0.88, ribs = 3) {
  const p = new PB();
  p.cyl(r, h, 0, 0, 0, { radial: 16, grime: 0.15 });
  for (let i = 0; i < ribs; i++) {
    const y = -h / 2 + ((i + 1) / (ribs + 1)) * h;
    p.cyl(r * 1.045, h * 0.055, 0, y, 0, { radial: 16, wear: 1, grime: 0.3 });
  }
  p.cyl(r * 1.02, 0.03, 0, h / 2 - 0.015, 0, { radial: 16, wear: 1 });
  p.cyl(r * 1.02, 0.03, 0, -h / 2 + 0.015, 0, { radial: 16, wear: 1, grime: 0.5 });
  // bung
  p.cyl(0.05, 0.02, r * 0.45, h / 2 + 0.008, 0, { radial: 8, wear: 1 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  warpGeometry(g, 0.008, 2.2, rng.float() * 10);
  return g;
}

export function gasBottle(_rng) {
  const p = new PB();
  const h = 0.58;
  p.cyl(0.155, h, 0, 0, 0, { radial: 14, grime: 0.2 });
  p.cyl(0.15, 0.06, 0, h / 2 + 0.02, 0, { radial: 14, taper: 0.75, wear: 1 });
  p.cyl(0.032, 0.09, 0, h / 2 + 0.09, 0, { radial: 8, wear: 1 });
  p.cyl(0.075, 0.035, 0, h / 2 + 0.14, 0, { radial: 10, wear: 1 });
  p.cyl(0.16, 0.02, 0, -h / 2 + 0.01, 0, { radial: 14, grime: 0.6 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

export function bucket(_rng) {
  const p = new PB();
  p.cyl(0.145, 0.28, 0, 0, 0, { radial: 14, taper: 1.24, grime: 0.4, open: true });
  p.cyl(0.145, 0.02, 0, -0.13, 0, { radial: 14, grime: 0.6 });
  p.cyl(0.185, 0.018, 0, 0.14, 0, { radial: 14, wear: 1 });
  const g = p.build();
  g.translate(0, 0.14, 0);
  return g;
}

export function jerryCan(_rng) {
  const p = new PB();
  p.box(0.34, 0.44, 0.17, 0, 0, 0, { bevel: 0.02, grime: 0.2 });
  p.box(0.3, 0.06, 0.05, 0, 0.24, 0, { bevel: 0.01, wear: 1 });
  p.cyl(0.035, 0.05, 0.11, 0.25, 0, { radial: 8, wear: 1 });
  const g = p.build();
  g.translate(0, 0.22, 0);
  return g;
}

// ================================================================== cover ==
/**
 * A filled bag: ~0.5 m long, 0.17 m tall once it has settled under its stack.
 * Three genuinely different silhouettes, because a wall built from one bag is a
 * lattice of identical lozenges no matter how it is stacked.
 */
export function sandbag(rng, i = 0) {
  const dims = [
    [0.49, 0.175, 0.33],
    [0.45, 0.16, 0.35],
    [0.47, 0.15, 0.3],
  ][i % 3];
  const g = sackGeometry(rng, dims[0], dims[1], dims[2], {
    variant: i % 3,
    box: 4.6 - (i % 3) * 0.5,
    lump: 1.2,
  });
  const bb = g.boundingBox;
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const n = fbm3(x * 12, y * 12, z * 12, 2);
    // creases and the underside of the bag: where dust and shadow collect
    const crease = Math.max(0, 1 - Math.abs(ny) * 3.2);
    const low = Math.max(0, 1 - (y - bb.min.y) / (dims[1] * 0.55));
    // the tied ends are the darkest part of a bag, and they are what draws the
    // seam between one bag and the next in a stack
    const end = Math.max(0, Math.abs(x) / (dims[0] * 0.5) - 0.62) / 0.38;
    // Bags weather hard: sun-bleached on top, filthy where they touch.
    out[0] = 0.3 + n * 0.45 + Math.max(0, ny) * 0.2;
    // Keep the hessian pale: bags are only filthy where they touch, and burying
    // the weave under grime is what makes sandbags read as beanbags.
    out[1] = 0.16 + Math.max(0, -ny) * 0.45 + n * 0.14 + low * low * 0.3 + end * 0.25;
    out[2] = 0.1 + Math.max(0, -ny) * 0.45 + crease * 0.22 + low * low * 0.35 + end * end * 0.5;
  });
  g.translate(0, dims[1] * 0.5, 0);
  return g;
}

export function jerseyBarrier(_rng) {
  // Proper jersey profile: wide splayed foot, sloped face, narrow top.
  const prof = [
    [-0.3, 0],
    [0.3, 0],
    [0.3, 0.09],
    [0.16, 0.24],
    [0.09, 0.72],
    [0.09, 0.92],
    [-0.09, 0.92],
    [-0.09, 0.72],
    [-0.16, 0.24],
    [-0.3, 0.09],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(prof[0][0], prof[0][1]);
  for (let i = 1; i < prof.length; i++) shape.lineTo(prof[i][0], prof[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 1.9,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 1,
    steps: 1,
  });
  g.translate(0, 0, -0.95);
  g.computeVertexNormals();
  autoEdgeWear(g, 0.035, 1);
  const p = new PB();
  p.geo(g, 0, 0, 0, { autoWear: false, grime: 0.15 });
  // lifting eyes and a scuffed reflector
  p.cyl(0.035, 0.1, 0, 0.95, -0.55, { radial: 8, rx: Math.PI / 2, wear: 1 });
  p.cyl(0.035, 0.1, 0, 0.95, 0.55, { radial: 8, rx: Math.PI / 2, wear: 1 });
  const out = p.build();
  paintMasks(out, (x, y, z, nx, ny, nz, o) => {
    o[1] = Math.min(1, o[1] + Math.max(0, 1 - y / 0.35) ** 2 * 0.6 + Math.max(0, -ny) * 0.4);
    o[2] = Math.min(1, o[2] + Math.max(0, 1 - y / 0.3) ** 2 * 0.45);
  });
  return out;
}

export function concreteBlock(rng, w = 1.2, h = 0.9, d = 0.8) {
  const p = new PB();
  p.box(w, h, d, 0, 0, 0, { bevel: 0.03, grime: 0.2 });
  // chipped corner
  const chip = rockGeometry(rng, 0.34, 0, 0.8);
  p.geo(chip, w / 2 - 0.06, h / 2 - 0.05, d / 2 - 0.08, { grime: 0.4 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

