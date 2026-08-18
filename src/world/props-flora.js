import * as THREE from 'three';
import { mergeSimple } from './kit-openings.js';
import { dsin } from '../core/dmath.js';
import { fillMasks } from './util-accum.js';
import { PB, mat } from './props-base.js';

/** Palms, shrubs, weeds, planters — and the signage that shares their poles. */

// ============================================================== vegetation ==
export function palmTree(rng, h = 5.2) {
  const p = new PB();
  const segs = 9;
  const lean = rng.range(-0.1, 0.1);
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const r = 0.19 * (1 - t * 0.42);
    const y = t * h;
    const x = dsin(t * 2.2 + lean * 4) * lean * h * 0.4;
    p.cyl(r, h / segs + 0.02, x, y + h / segs / 2, 0, {
      radial: 9,
      taper: 0.92,
      grime: 0.3 + t * 0.2,
      wear: 1,
    });
    // ring scars where old fronds broke off
    p.cyl(r * 1.13, 0.045, x, y + h / segs * 0.75, 0, { radial: 9, wear: 1, grime: 0.4 });
  }
  const topX = dsin(2.2 + lean * 4) * lean * h * 0.4;
  const g = p.build();
  g.userData = { topX, topY: h };
  return g;
}

/** One palm frond: leaflets along a curved spine, foliage-textured quads. */
export function palmFrond(rng, len = 2.6) {
  const list = [];
  const n = 13;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const x = t * len;
    const droop = -t * t * len * 0.42;
    const lw = (0.42 + dsin(t * Math.PI) * 0.55) * (1 - t * 0.35);
    for (const side of [-1, 1]) {
      const q = new THREE.PlaneGeometry(lw, 0.16, 1, 1);
      q.translate(lw / 2, 0, 0);
      const m = mat(x, droop, 0, 0, 0, 0);
      const rot = new THREE.Matrix4().makeRotationZ(-0.5 - t * 0.5);
      const yaw = new THREE.Matrix4().makeRotationY(side * (1.15 - t * 0.35));
      q.applyMatrix4(rot);
      q.applyMatrix4(yaw);
      q.applyMatrix4(m);
      fillMasks(q, 0.2, 0.25, 0);
      list.push(q);
    }
  }
  // spine
  const spine = new THREE.PlaneGeometry(len, 0.05, 6, 1);
  const pa = spine.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i) + len / 2;
    pa.setXYZ(i, x, pa.getY(i) - ((x / len) ** 2) * len * 0.42, pa.getZ(i));
  }
  spine.computeVertexNormals();
  fillMasks(spine, 0.2, 0.3, 0);
  list.push(spine);
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

export function shrub(rng, s = 0.8) {
  const list = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const q = new THREE.PlaneGeometry(s * rng.range(0.7, 1.15), s * rng.range(0.6, 1.0), 1, 1);
    const m = mat(
      rng.range(-s * 0.2, s * 0.2),
      s * rng.range(0.28, 0.6),
      rng.range(-s * 0.2, s * 0.2),
      rng.float() * Math.PI,
      rng.range(-0.4, 0.4),
      rng.range(-0.3, 0.3)
    );
    q.applyMatrix4(m);
    fillMasks(q, 0.2, 0.35, 0.2);
    list.push(q);
  }
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

export function weedTuft(rng) {
  const list = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const q = new THREE.PlaneGeometry(rng.range(0.18, 0.34), rng.range(0.14, 0.3), 1, 1);
    q.applyMatrix4(
      mat(rng.range(-0.06, 0.06), rng.range(0.07, 0.17), rng.range(-0.06, 0.06), rng.float() * 3.14, rng.range(-0.5, 0.5), 0)
    );
    fillMasks(q, 0.2, 0.5, 0.3);
    list.push(q);
  }
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

export function planter(_rng) {
  const p = new PB();
  p.cyl(0.34, 0.42, 0, 0.21, 0, { radial: 14, taper: 0.78, grime: 0.4 });
  p.cyl(0.36, 0.05, 0, 0.42, 0, { radial: 14, wear: 1 });
  p.cyl(0.3, 0.06, 0, 0.4, 0, { radial: 12, grime: 0.9 });
  return p.build();
}

// ================================================================= signage ==
export function signBoard(rng, w = 1.5, h = 0.5) {
  const p = new PB();
  p.box(w, h, 0.05, 0, 0, 0, { bevel: 0.008, grime: 0.25 });
  p.box(w + 0.05, 0.045, 0.07, 0, h / 2, 0, { bevel: 0.006, wear: 1 });
  p.box(w + 0.05, 0.045, 0.07, 0, -h / 2, 0, { bevel: 0.006, wear: 1 });
  for (const sx of [-1, 1]) p.box(0.03, 0.24, 0.12, sx * (w / 2 - 0.12), 0, -0.08, { grime: 0.5 });
  return p.build();
}

export function signHanging(rng, w = 0.9, h = 0.62) {
  const p = new PB();
  p.box(w, h, 0.04, 0, -h / 2 - 0.12, 0, { bevel: 0.006, grime: 0.3 });
  p.cyl(0.014, 0.14, -w / 2 + 0.08, -0.06, 0, { radial: 6, wear: 1 });
  p.cyl(0.014, 0.14, w / 2 - 0.08, -0.06, 0, { radial: 6, wear: 1 });
  p.cyl(0.018, w + 0.14, 0, 0, 0, { radial: 6, rz: Math.PI / 2, wear: 1, grime: 0.4 });
  return p.build();
}

