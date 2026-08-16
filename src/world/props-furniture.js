import * as THREE from 'three';
import { datan2, dcos, dexp, dsin, hypot2 } from '../core/dmath.js';
import { fillMasks, paintMasks } from './util-accum.js';
import { fbm3 } from './util-noise.js';
import { chamferBox } from './util.js';
import { PB, autoEdgeWear } from './props-base.js';

/** Yard and interior furniture, and the fixtures bolted to a building. */

/**
 * A tyre. A smooth torus is the giveaway: real rubber has a tread band with
 * discrete blocks and grooves, a shoulder radius, and raised lettering on the
 * sidewall. The tread count is deliberately low (14 blocks) so it resolves as
 * blocks at 3 m instead of aliasing into a hum like a 34-cycle ripple does.
 */
export function tyre(rng, r = 0.33) {
  const BLOCKS = 17;
  // 5 columns per block (block x3 / shoulder / groove). At 3 columns the groove
  // was a third of the pitch and the crown read as a ring of beads rather than
  // as tread; the extra segments also kill the faceting on the shoulder.
  const radial = BLOCKS * 5;
  const HW = r * 0.3; // half the section width
  // A real tyre section: flat-ish sidewalls at the widest point, a distinct
  // shoulder, a flat crown, and a bead that leaves a proper hole in the middle.
  // Revolving this instead of a circle is the difference between a tyre and an
  // inflatable ring.
  const prof = [
    [0.52, 0.45],
    [0.66, 0.88],
    [0.82, 1.0],
    [0.94, 0.92],
    [0.995, 0.62],
    [1.0, 0.35],
    [1.0, -0.35],
    [0.995, -0.62],
    [0.94, -0.92],
    [0.82, -1.0],
    [0.66, -0.88],
    [0.52, -0.45],
    [0.5, -0.18],
    [0.505, 0.18],
    [0.52, 0.45],
  ].map(([pr, py]) => new THREE.Vector2(pr * r, py * HW));
  const g = new THREE.LatheGeometry(prof, radial);
  const pa = g.getAttribute('position');
  const stagger = rng.float() * 6.28;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const y = pa.getY(i);
    const z = pa.getZ(i);
    const a = datan2(z, x);
    const rr = hypot2(x, z);
    // tread blocks: a square wave round the crown, split by a centre groove
    const ph = (a * BLOCKS) / (Math.PI * 2) + stagger;
    const blkT = ((ph % 1) + 1) % 1;
    // A block that occupies 62% of the pitch with a chamfered leading and
    // trailing edge. A square pulse over 3 coarse columns made the crown read as
    // a ring of beads; a real tread block has a sloped shoulder into the groove.
    const blk = Math.max(0, Math.min(1, blkT / 0.075, (0.62 - blkT) / 0.075));
    const centre = dexp(-((y / (HW * 0.22)) ** 2) * 3); // circumferential groove
    const treadBand = Math.max(0, (rr / r - 0.9) / 0.1) * Math.max(0, 1 - Math.abs(y) / (HW * 0.72));
    // 9 mm of tread relief: enough to read as blocks at 3 m, not a monster truck
    const grow = treadBand * (blk * 0.0062 - 0.0018 - centre * 0.0045) * (r / 0.33);
    const f = 1 + grow / Math.max(1e-4, rr);
    // sidewall lettering / brand ring relief, pushed along the sidewall normal
    const band = dexp(-(((rr / r - 0.76) / 0.11) ** 2));
    const letter = band * ((dsin(a * 23 + stagger * 3) > 0.4 ? 0.006 : 0) + 0.0022) * (r / 0.33);
    pa.setXYZ(i, x * f, y * 0.94 + Math.sign(y) * letter, z * f);
  }
  g.computeVertexNormals();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const rr = hypot2(x, z);
    const crown = Math.min(1, Math.max(0, (rr / r - 0.88) / 0.12));
    const hole = Math.max(0, 1 - (rr / r - 0.5) / 0.12); // inside the bead
    const n = fbm3(x * 9, y * 9, z * 9, 2);
    // the crown is scrubbed clean-ish, the sidewalls and grooves hold dust
    out[0] = 0.25 + crown * 0.4 + n * 0.25;
    out[1] = 0.3 + (1 - crown) * 0.35 + Math.max(0, -ny) * 0.3;
    out[2] = 0.12 + (1 - crown) * 0.25 + Math.max(0, -ny) * 0.3 + hole * 0.5;
  });
  g.translate(0, HW * 0.95, 0);
  return g;
}

export function pallet(rng) {
  const p = new PB();
  const w = 1.16;
  const d = 0.98;
  for (let i = 0; i < 3; i++) {
    const z = -d / 2 + 0.06 + (i / 2) * (d - 0.12);
    p.box(w, 0.075, 0.11, 0, 0.04, z, { bevel: 0.006, grime: 0.3 });
  }
  const boards = 6;
  for (let i = 0; i < boards; i++) {
    const z = -d / 2 + 0.05 + (i / (boards - 1)) * (d - 0.1);
    p.box(w, 0.018, 0.1, 0, 0.088, z, { bevel: 0.004, rz: rng.range(-0.004, 0.004) });
  }
  for (let i = 0; i < 3; i++) {
    const z = -d / 2 + 0.06 + (i / 2) * (d - 0.12);
    p.box(w, 0.018, 0.1, 0, -0.008, z, { bevel: 0.004 });
  }
  return p.build();
}

// ============================================================== furniture ==
export function table(rng, w = 1.5, h = 0.78, d = 0.8) {
  const p = new PB();
  p.box(w, 0.045, d, 0, h - 0.02, 0, { bevel: 0.008, wear: 1 });
  p.box(w - 0.1, 0.05, d - 0.1, 0, h - 0.075, 0, { bevel: 0.006, grime: 0.3 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      p.box(0.07, h - 0.1, 0.07, sx * (w / 2 - 0.09), (h - 0.1) / 2, sz * (d / 2 - 0.09), {
        bevel: 0.005,
        grime: 0.25,
      });
  return p.build();
}

export function stall(rng, w = 2.3) {
  // Market stall: trestle table, back board, cloth over the top, poles.
  const p = new PB();
  const h = 0.84;
  const d = 1.05;
  p.box(w, 0.05, d, 0, h, 0, { bevel: 0.008 });
  p.box(w - 0.06, 0.09, d - 0.08, 0, h - 0.07, 0, { bevel: 0.006, grime: 0.35 });
  for (const sx of [-1, 1]) {
    p.box(0.08, h - 0.05, 0.08, sx * (w / 2 - 0.1), (h - 0.05) / 2, d / 2 - 0.1, { grime: 0.3 });
    p.box(0.08, h - 0.05, 0.08, sx * (w / 2 - 0.1), (h - 0.05) / 2, -d / 2 + 0.1, { grime: 0.3 });
    // corner posts carrying the canopy
    p.box(0.06, 2.0, 0.06, sx * (w / 2 - 0.05), 1.0, -d / 2 + 0.06, { grime: 0.2 });
    p.box(0.06, 2.0, 0.06, sx * (w / 2 - 0.05), 1.0, d / 2 - 0.06, { grime: 0.2 });
  }
  p.box(w, 0.06, 0.06, 0, 1.98, -d / 2 + 0.06, {});
  p.box(w, 0.06, 0.06, 0, 1.98, d / 2 - 0.06, {});
  // shelf under the table
  p.box(w - 0.3, 0.03, d - 0.3, 0, 0.24, 0, { bevel: 0.004, grime: 0.45 });
  return p.build();
}

export function shelfUnit(rng, w = 1.1, h = 1.9, d = 0.35) {
  const p = new PB();
  for (const sx of [-1, 1]) p.box(0.05, h, d, sx * (w / 2 - 0.025), h / 2, 0, { grime: 0.2 });
  const n = 4;
  for (let i = 0; i < n; i++) {
    const y = 0.22 + (i / (n - 1)) * (h - 0.4);
    p.box(w - 0.06, 0.03, d, 0, y, 0, { bevel: 0.005, grime: 0.25 });
  }
  p.box(w, 0.03, 0.02, 0, h - 0.02, -d / 2 + 0.01, {});
  return p.build();
}

export function mattress(_rng) {
  const g = chamferBox(1.85, 0.16, 0.85, 0.05);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const n = fbm3(x * 3 + 4, y * 3, z * 3, 2);
    out[0] = 0.2;
    out[1] = 0.45 + n * 0.4;
    out[2] = Math.max(0, -ny) * 0.4;
  });
  // sag in the middle
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const y = pa.getY(i);
    const z = pa.getZ(i);
    if (y > 0) pa.setY(i, y - 0.035 * dcos((x / 1.85) * Math.PI) * dcos((z / 0.85) * Math.PI));
  }
  g.computeVertexNormals();
  g.translate(0, 0.08, 0);
  return g;
}

export function chair(_rng) {
  const p = new PB();
  const sh = 0.46;
  p.box(0.42, 0.04, 0.4, 0, sh, 0, { bevel: 0.006, wear: 1 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      p.box(0.04, sh, 0.04, sx * 0.18, sh / 2, sz * 0.17, { grime: 0.2 });
  p.box(0.42, 0.5, 0.035, 0, sh + 0.27, -0.18, { bevel: 0.005, rx: -0.08 });
  p.box(0.42, 0.06, 0.05, 0, sh + 0.48, -0.2, { bevel: 0.005 });
  return p.build();
}

export function cabinet(rng, w = 0.9, h = 1.15, d = 0.44) {
  const p = new PB();
  p.box(w, h, d, 0, h / 2, 0, { bevel: 0.01, grime: 0.2 });
  for (const sx of [-1, 1]) {
    p.box(w / 2 - 0.03, h - 0.12, 0.03, sx * (w / 4), h / 2, d / 2 + 0.01, { bevel: 0.005, wear: 1 });
    p.box(0.03, 0.1, 0.03, sx * 0.06, h / 2, d / 2 + 0.03, { wear: 1 });
  }
  p.box(w + 0.04, 0.04, d + 0.04, 0, h + 0.02, 0, { bevel: 0.008, wear: 1, grime: 0.3 });
  return p.build();
}

// ================================================================ services ==
export function acUnit(_rng) {
  const p = new PB();
  const w = 0.78;
  const h = 0.55;
  const d = 0.34;
  p.box(w, h, d, 0, 0, 0, { bevel: 0.012, grime: 0.35 });
  // louvre grille on the face
  for (let i = 0; i < 7; i++) {
    p.box(w - 0.1, 0.035, 0.02, 0, -h / 2 + 0.08 + i * 0.06, d / 2 + 0.005, {
      bevel: 0.003,
      rx: 0.35,
      wear: 1,
    });
  }
  // fan ring
  p.cyl(0.19, 0.03, 0, 0.02, d / 2 + 0.02, { radial: 16, rx: Math.PI / 2, wear: 1 });
  // wall brackets
  for (const sx of [-1, 1]) {
    p.box(0.05, 0.05, 0.5, sx * (w / 2 - 0.05), -h / 2 + 0.03, -d / 2 - 0.16, { grime: 0.5 });
    p.box(0.05, 0.34, 0.05, sx * (w / 2 - 0.05), -h / 2 - 0.14, -d / 2 - 0.36, { grime: 0.5, rz: 0.5 });
  }
  // condensate drip stain hanger
  p.cyl(0.012, 0.5, w / 2 - 0.12, -h / 2 - 0.24, 0, { radial: 6, grime: 0.6 });
  const g = p.build();
  return g;
}

export function satDish(_rng) {
  const p = new PB();
  const dish = new THREE.SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, 0.55);
  dish.scale(1, 0.42, 1);
  dish.rotateX(-2.1);
  autoEdgeWear(dish, 0.03, 0.8);
  p.geo(dish, 0, 0.55, 0.1, { autoWear: false, grime: 0.3 });
  p.cyl(0.03, 0.5, 0, 0.4, -0.12, { radial: 8, rx: 0.5, wear: 1 });
  p.cyl(0.045, 0.55, 0, 0.27, -0.22, { radial: 8, grime: 0.4 });
  p.box(0.24, 0.03, 0.24, 0, 0.02, -0.22, { bevel: 0.005, grime: 0.6 });
  p.cyl(0.028, 0.16, 0, 0.62, 0.34, { radial: 6, rx: 1.1, wear: 1 });
  return p.build();
}

export function waterTank(_rng) {
  const p = new PB();
  p.cyl(0.55, 1.0, 0, 0.5, 0, { radial: 18, grime: 0.3 });
  p.cyl(0.56, 0.05, 0, 0.99, 0, { radial: 18, wear: 1 });
  p.cyl(0.18, 0.09, 0.16, 1.05, 0, { radial: 12, wear: 1 });
  p.cyl(0.03, 0.5, -0.5, 0.2, 0, { radial: 6, grime: 0.5, rz: 0.3 });
  // cradle
  for (const sz of [-1, 1]) p.box(1.2, 0.09, 0.09, 0, 0.045, sz * 0.36, { grime: 0.5 });
  return p.build();
}

export function roofVent(_rng) {
  const p = new PB();
  p.box(0.5, 0.3, 0.5, 0, 0.15, 0, { bevel: 0.01, grime: 0.4 });
  p.cyl(0.17, 0.36, 0, 0.48, 0, { radial: 12, grime: 0.3 });
  p.cyl(0.24, 0.06, 0, 0.68, 0, { radial: 12, wear: 1 });
  p.cyl(0.2, 0.05, 0, 0.74, 0, { radial: 12, taper: 0.3, wear: 1 });
  return p.build();
}

export function streetLamp(rng, h = 5.4) {
  const p = new PB();
  p.cyl(0.13, 0.35, 0, 0.17, 0, { radial: 12, grime: 0.6 });
  p.cyl(0.075, h, 0, h / 2, 0, { radial: 10, taper: 0.7, grime: 0.25 });
  // Curved arm made of short segments, with a diagonal stay back to the post.
  // The stay matters: without it the head is a box floating a metre off the
  // column, and the moment the column is occluded by a roofline the whole lamp
  // reads as a detached prop hanging in the sky.
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const a = t * 1.35;
    p.cyl(0.055, 0.44, dsin(a) * 0.62 * (0.4 + t), h - 0.1 + dcos(a) * 0.34 * t, 0, {
      radial: 8,
      rz: -a,
      grime: 0.3,
    });
  }
  p.cyl(0.028, 0.95, 0.32, h - 0.42, 0, { radial: 6, rz: -0.72, grime: 0.4 });
  p.box(0.1, 0.16, 0.1, 0.05, h - 0.72, 0, { bevel: 0.01, grime: 0.45 });
  p.box(0.5, 0.13, 0.28, 0.86, h + 0.06, 0, { bevel: 0.02, rz: -0.16, grime: 0.35 });
  p.box(0.42, 0.06, 0.22, 0.88, h - 0.02, 0, { bevel: 0.01, rz: -0.16, wear: 1 });
  return p.build();
}

/** The lamp's diffuser, kept separate so it can use a glassy material. */
export function lampGlass() {
  const g = chamferBox(0.4, 0.05, 0.2, 0.01);
  fillMasks(g, 0.2, 0.1, 0);
  return g;
}

