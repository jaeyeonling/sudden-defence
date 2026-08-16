import * as THREE from 'three';
import { datan2, dcos, dsin, hypot2 } from '../core/dmath.js';
import { fillMasks, paintMasks } from './util-accum.js';
import { fbm3 } from './util-noise.js';
import { chamferBox, polyPrism, rockGeometry, warpGeometry } from './util.js';
import { PB, autoEdgeWear } from './props-base.js';

/** Rubble, spall, litter — what a fight and a decade leave on the floor. */

// ================================================================== debris ==
export function brickChunk(rng) {
  const g = rockGeometry(rng, 0.22, 0, 0.55);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    out[0] = 0.5 + fbm3(x * 9, y * 9, z * 9, 2) * 0.5;
    out[1] = 0.4 + Math.max(0, -ny) * 0.4;
    out[2] = 0.25;
  });
  return g;
}

export function slabShard(rng) {
  const p = new PB();
  const w = rng.range(0.5, 0.95);
  const d = rng.range(0.35, 0.7);
  const pts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = 0.5 * (0.6 + fbm3(dcos(t) * 3 + 2, dsin(t) * 3, 5, 2) * 0.8);
    pts.push([dcos(t) * rr * w, dsin(t) * rr * d]);
  }
  const g = polyPrism(pts, rng.range(0.07, 0.13));
  autoEdgeWear(g, 0.02, 1);
  p.geo(g, 0, 0, 0, { autoWear: false, grime: 0.4 });
  // rebar sticking out, bent
  const bars = rng.int(2, 4);
  for (let i = 0; i < bars; i++) {
    const a = rng.float() * Math.PI * 2;
    p.cyl(0.008, rng.range(0.3, 0.7), dcos(a) * w * 0.3, 0.06, dsin(a) * d * 0.3, {
      radial: 5,
      rz: rng.range(-1.4, 1.4),
      rx: rng.range(-1.2, 1.2),
      grime: 0.5,
    });
  }
  return p.build();
}

export function rebarBundle(rng) {
  const p = new PB();
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    p.cyl(0.009, rng.range(1.4, 2.6), rng.range(-0.08, 0.08), 0.012 + i * 0.019, rng.range(-0.06, 0.06), {
      radial: 5,
      rx: Math.PI / 2,
      ry: rng.range(-0.12, 0.12),
      grime: 0.55,
    });
  }
  return p.build();
}

export function plank(rng) {
  const g = chamferBox(rng.range(0.9, 2.1), 0.035, rng.range(0.12, 0.2), 0.005);
  autoEdgeWear(g, 0.012, 1);
  warpGeometry(g, 0.012, 1.4, rng.float() * 9);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    out[1] = Math.min(1, out[1] + 0.3 + Math.max(0, -ny) * 0.4);
  });
  return g;
}

/**
 * The swept fillet of dust and grit that piles against anything left standing
 * on a street. Unit radius (put() scales it), 2.5 cm proud at the object and
 * feathering to nothing at the rim, with a jagged outline so it never reads as
 * a disc. Grime mask driven hard at the centre so the material's own cavity
 * grime darkens the contact line.
 */
export function dustSkirt(_rng) {
  const RAD = 4;
  const SEG = 26;
  const g = new THREE.CylinderGeometry(1, 1, 0, SEG, RAD);
  const pa = g.getAttribute('position');
  const col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const z = pa.getZ(i);
    const d = Math.min(1, hypot2(x, z));
    const a = datan2(z, x);
    // ragged outline: the rim wanders +/-22%
    const wob = 0.86 + 0.28 * fbm3(dcos(a) * 2.2, dsin(a) * 2.2, 3.1, 3);
    const dd = d * wob;
    pa.setX(i, x * wob);
    pa.setZ(i, z * wob);
    // (1-d)^2 profile: steep against the object, flat at the edge
    const t = Math.max(0, 1 - dd);
    pa.setY(i, t * t * 0.021 + (fbm3(x * 6, z * 6, 9.4, 3) - 0.5) * 0.004 * (1 - dd));
    col[i * 3] = 0.05;
    col[i * 3 + 1] = 0.35 + 0.6 * t;
    col[i * 3 + 2] = 0.3 + 0.55 * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function litterPaper(rng) {
  const g = new THREE.PlaneGeometry(rng.range(0.1, 0.22), rng.range(0.1, 0.28), 2, 2);
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    pa.setZ(i, (fbm3(pa.getX(i) * 20, pa.getY(i) * 20, 3, 2) - 0.5) * 0.035);
  }
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  fillMasks(g, 0.3, 0.5, 0.2);
  return g;
}

export function bottle(_rng) {
  const p = new PB();
  p.cyl(0.038, 0.17, 0, 0.085, 0, { radial: 10, grime: 0.3 });
  p.cyl(0.02, 0.08, 0, 0.2, 0, { radial: 8, taper: 0.8 });
  return p.build();
}

export function can(_rng) {
  const g = new THREE.CylinderGeometry(0.033, 0.033, 0.115, 10, 1);
  autoEdgeWear(g, 0.01, 1);
  // crushed
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i);
    pa.setX(i, pa.getX(i) * (1 - Math.abs(y) * 1.2));
  }
  g.computeVertexNormals();
  g.rotateZ(1.4);
  g.translate(0, 0.033, 0);
  return g;
}

