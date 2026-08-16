import * as THREE from 'three';
import { box, blob, latheZ, dome, ring, mergeAll } from './geometry.js';
import { dsin } from '../core/dmath.js';

/**
 * What the arm is BUILT from, as opposed to how it is posed: glove shell,
 * fingers, thumb, sleeve, and the bone lengths they are cut to.
 *
 * Pure builders — each returns a merged BufferGeometry and none of them touch
 * the rig. `Arm` consumes this file; nothing here consumes `Arm`, which is why
 * the lengths live down here rather than up with the solver that also reads
 * them.
 */

/**
 * Humerus and forearm+wrist lengths, in metres.
 *
 * A large adult is 300 / 272 mm, and those were the values here. They do not
 * work, and no viewmodel in the genre uses them: once the weapon is far enough
 * from the eye for the magazine and the muzzle to be in frame at all (300 mm —
 * see defs.js), the support hand is 515 mm downrange of a shoulder that has to
 * stay BEHIND the eye, and 572 mm of arm reaches that at 99.5% extension. The
 * two-bone solve then clamps, the elbow locks dead straight, and the arm reads
 * as a broomstick with the hand sliding off the handguard.
 *
 * The obvious alternative — blading the shoulder forward — was measured and is
 * worse: at shoulderZ -0.075 the 89 mm forearm sleeve crosses the frame
 * diagonally and occludes the barrel and muzzle outright, which is exactly what
 * the warning in viewmodel.js predicted.
 *
 * So the bones are cheated 10% long (330 / 300, reach 630 mm). That takes the
 * same target to 91% extension, which leaves a visible elbow bend, and it pushes
 * the elbow FURTHER out of frame rather than into it, because a longer chain
 * between fixed endpoints bends more.
 */
export const L_UPPER = 0.33;
export const L_FORE = 0.3;

/* -------------------------------------------------------------------------- */
/*  geometry                                                                  */
/* -------------------------------------------------------------------------- */

/** One finger segment: a tapered, chamfered capsule with a joint crease. */
export function segment(len, r0, r1) {
  const g = latheZ(
    [
      [0, 0],
      [0, r0 * 0.86],
      [r0 * 0.5, r0],
      [len * 0.42, r0 * 0.99],
      [len * 0.55, r1 * 1.04],
      [len - r1 * 0.7, r1],
      [len - r1 * 0.2, r1 * 0.8],
      [len, r1 * 0.35],
      [len, 0],
    ],
    12
  );
  g.scale(1, 0.88, 1); // fingers are wider than they are deep
  g.rotateY(Math.PI); // extend along -Z
  return g;
}

/** Padded segment cover on the dorsal side (glove reinforcement). */
export function segmentPad(len, r) {
  const g = blob(r * 1.55, r * 0.55, len * 0.78, r * 0.25, 2);
  g.translate(0, r * 0.78, -len * 0.46);
  return g;
}

/**
 * Stitched seam down the OUTBOARD side of a finger segment.
 *
 * A glove is sewn from a palm panel and a dorsal panel, and the seam between
 * them runs down the side of every finger. It matters far out of proportion to
 * its size: at 40 px across the whole hand the four fingers merge into one
 * paddle, and the only thing that still separates them is a light line at each
 * boundary. A 1.5 mm strip at 1.4x the shell albedo (see `glove_seam` in
 * materials.js) survives to about 3 px, which is one pixel of separation per
 * finger — enough.
 *
 * @param {number} sx  +1 outboard on the thumb side, -1 on the little-finger side
 */
export function segmentSeam(len, r0, r1, sx) {
  const g = box(0.0015, (r0 + r1) * 0.34, len * 0.86, 0.0003, 1);
  // The finger capsule is scaled to 0.88 in Y, so its side wall sits at r in X.
  g.translate(sx * (r0 + r1) * 0.49, r0 * 0.1, -len * 0.47);
  return g;
}

/**
 * Build one finger as three nested groups so it can curl.
 * @returns {{root: THREE.Object3D, joints: THREE.Object3D[]}}
 */
export function buildFinger(materials, spec) {
  const { lengths, radii, curl, seamSide } = spec;
  const root = new THREE.Object3D();
  const joints = [];
  let parent = root;
  for (let i = 0; i < 3; i++) {
    const j = new THREE.Object3D();
    j.rotation.x = -curl[i];
    parent.add(j);
    const geo = mergeAll([segment(lengths[i], radii[i], radii[i + 1])]);
    const mesh = new THREE.Mesh(geo, materials.glove);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    j.add(mesh);
    // Sewn seams down BOTH flanks. One seam per finger leaves three boundaries
    // out of five unmarked; seaming both sides puts a light line at every
    // boundary, which is the whole point of the exercise. Two segments only —
    // the distal phalanx is 22 mm long and a seam on it is sub-pixel.
    if (i < 2) {
      const seams = mergeAll(
        (seamSide ?? 0) === 0
          ? [
              segmentSeam(lengths[i], radii[i], radii[i + 1], 1),
              segmentSeam(lengths[i], radii[i], radii[i + 1], -1),
            ]
          : [segmentSeam(lengths[i], radii[i], radii[i + 1], seamSide)]
      );
      j.add(new THREE.Mesh(seams, materials.seam ?? materials.glove));
    }
    if (i < 2) {
      const pad = new THREE.Mesh(segmentPad(lengths[i], radii[i]), materials.pad);
      j.add(pad);
    } else {
      // fingertip grip patch on the palm side
      const tip = blob(radii[i] * 1.5, radii[i] * 0.5, lengths[i] * 0.7, radii[i] * 0.2, 2);
      tip.translate(0, -radii[i] * 0.72, -lengths[i] * 0.45);
      j.add(new THREE.Mesh(tip, materials.pad));
    }
    const next = new THREE.Object3D();
    next.position.z = -lengths[i];
    j.add(next);
    parent = next;
    joints.push(j);
  }
  return { root, joints };
}

/**
 * Glove: palm, thumb web, knuckle plate, wrist strap.
 * Fingers are added as children so they can be posed per-weapon.
 */
export function buildGlove(materials, opts = {}) {
  const scale = opts.scale ?? 1;
  const w = 0.088 * scale;
  const h = 0.032 * scale;
  const palmLen = 0.098 * scale;
  const root = new THREE.Object3D();

  const shell = [];
  /**
   * Palm. Built as two overlapping blocks rather than one, because a single
   * 88 x 98 mm slab is exactly what the support hand presents to the camera in a
   * C-clamp and it reads as a brick. A hand is ~88 mm across the knuckles and
   * ~72 mm across the wrist, so the taper is real and it is the difference
   * between a hand silhouette and a paddle.
   */
  const palm = blob(w, h, palmLen * 0.62, 0.012 * scale, 3);
  palm.translate(0, 0, -palmLen * 0.66);
  shell.push(palm);
  const palmRear = blob(w * 0.83, h * 0.96, palmLen * 0.52, 0.012 * scale, 3);
  palmRear.translate(0, -h * 0.01, -palmLen * 0.26);
  shell.push(palmRear);
  // Thenar (thumb muscle) and the heel of the hand.
  const thenar = blob(w * 0.42, h * 0.92, palmLen * 0.6, 0.014 * scale, 3);
  thenar.translate(w * 0.3, -h * 0.06, -palmLen * 0.3);
  shell.push(thenar);
  const heel = blob(w * 0.92, h * 0.86, 0.03 * scale, 0.012 * scale, 3);
  heel.translate(0, -h * 0.04, -0.012 * scale);
  shell.push(heel);
  // Knuckle lumps.
  for (let i = 0; i < 4; i++) {
    const x = w * (0.34 - i * 0.225);
    const k = dome(0.0072 * scale, 10, 0.62);
    k.rotateX(-Math.PI / 2);
    k.translate(x, h * 0.42, -palmLen * 0.94);
    shell.push(k);
  }
  const glove = new THREE.Mesh(mergeAll(shell), materials.glove);
  root.add(glove);

  /**
   * Dorsal armour. This used to be ONE 81 x 41 mm slab across the knuckles plus a
   * second across the back, and since the support hand presents its dorsal side
   * straight at the camera that is precisely what the critique saw: "detached grey
   * slabs". A real glove's knuckle guard is four separate moulded caps with
   * flex gaps between them, and those three gaps are the entire read — they give
   * the silhouette four lobes instead of one rectangle.
   */
  /**
   * COVERAGE BUDGET: the caps plus everything else on the dorsum must not exceed
   * 55% of the back of the hand.
   *
   * The previous set was four caps at 19.6% x 40% of the palm footprint (= 31%),
   * a back panel at 72% x 30% (= 22%) and three tendon ridges — call it 57%, and
   * because they all sat at the same height (h*0.45-0.48) with the same material
   * they merged into ONE continuous shelf across the whole dorsum. That shelf is
   * the "stack of slabs" read, and no amount of retinting fixes it: what the eye
   * is objecting to is that the back of the hand has no soft glove left on it.
   *
   * Now: four caps at 17% x 30% (= 20.4%) over the knuckles only, and one small
   * metacarpal panel at 44% x 22% (= 9.7%) with a clear 12% gap of bare shell
   * between it and the caps. Total 30% — well inside budget, and there is
   * visibly more glove than armour. The tendon ridges are gone entirely; the
   * shell's own knuckle lumps already break that surface up, and the ridges were
   * the thing bridging the caps into the panel.
   */
  const pads = [];
  for (let i = 0; i < 4; i++) {
    const x = w * (0.335 - i * 0.223);
    const cap = blob(w * 0.17, h * 0.3, palmLen * 0.3, 0.005 * scale, 3);
    // outboard caps sit slightly lower, following the knuckle arch
    const drop = Math.abs(i - 1.5) > 1 ? h * 0.055 : 0;
    cap.translate(x, h * 0.46 - drop, -palmLen * 0.82);
    pads.push(cap);
  }
  const backPanel = blob(w * 0.44, h * 0.17, palmLen * 0.22, 0.005 * scale, 3);
  backPanel.translate(0, h * 0.44, -palmLen * 0.4);
  pads.push(backPanel);
  // Palm grip patch.
  const patch = blob(w * 0.82, h * 0.18, palmLen * 0.66, 0.006 * scale, 3);
  patch.translate(0, -h * 0.52, -palmLen * 0.48);
  pads.push(patch);
  root.add(new THREE.Mesh(mergeAll(pads), materials.pad));

  // Seams down the sides of the hand.
  const seams = [];
  for (const sx of [-1, 1]) {
    const s = box(0.0016 * scale, h * 0.5, palmLen * 0.8, 0.0004, 1);
    s.translate(sx * w * 0.5, 0, -palmLen * 0.5);
    seams.push(s);
  }
  root.add(new THREE.Mesh(mergeAll(seams), materials.pad));

  // Wrist cuff + strap + a small steel keeper.
  const cuff = latheZ(
    [
      [0, w * 0.44],
      [0.004 * scale, w * 0.47],
      [0.03 * scale, w * 0.46],
      [0.034 * scale, w * 0.42],
    ],
    16
  );
  cuff.scale(1, 0.82, 1);
  const cuffMesh = new THREE.Mesh(cuff, materials.glove);
  cuffMesh.position.z = 0.004 * scale;
  root.add(cuffMesh);
  const strap = latheZ(
    [
      [0, w * 0.47],
      [0.0022, w * 0.5],
      [0.009 * scale, w * 0.5],
      [0.0112 * scale, w * 0.47],
    ],
    16
  );
  strap.scale(1, 0.82, 1);
  const strapMesh = new THREE.Mesh(strap, materials.pad);
  strapMesh.position.z = 0.02 * scale;
  root.add(strapMesh);

  return root;
}

/**
 * Thumb: two segments on the +X side, angled across the grip.
 *
 * THE PROXIMAL SEGMENT IS THE METACARPAL AS WELL AS THE PROXIMAL PHALANX, and
 * that is why it is 50 mm rather than 38.
 *
 * MEASURED: with a 38 + 30 mm thumb the C-clamp solve (Arm.fitToCylinder) left
 * the tip 13.2 mm clear of the handguard no matter how the base was aimed —
 * scanning abduction alone, then abduction AND rotation in a 21 x 15 grid, moved
 * it by 1 mm. It is not an aiming problem, it is a reach problem: the thumb root
 * sits at the heel of the palm, the palm on a C-clamp stands 29 mm off a 54 mm
 * tube (unavoidable — a 98 mm palm tangent to a 27 mm radius diverges), and 68 mm
 * of thumb simply does not get there.
 *
 * A real hand does not have that problem because the thumb column starts at the
 * CARPOMETACARPAL joint, deep in the wrist, and the visible thumb from the web to
 * the tip is 75-85 mm. This rig has no metacarpal segment at all, so the proximal
 * one absorbs it: 50 + 32 = 82 mm, which reaches with 10 mm of flexion in hand.
 */
export function buildThumb(materials, scale = 1, spec = THUMB) {
  const root = new THREE.Object3D();
  const j1 = new THREE.Object3D();
  root.add(j1);
  const s1 = new THREE.Mesh(segment(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale), materials.glove);
  j1.add(s1);
  j1.add(new THREE.Mesh(segmentPad(spec.l0 * scale, spec.r0 * scale), materials.pad));
  // Seams down both flanks, as on the fingers — the thumb is the widest single
  // digit on screen in the support grip and a bare capsule reads as a sausage.
  j1.add(
    new THREE.Mesh(
      mergeAll([
        segmentSeam(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale, 1),
        segmentSeam(spec.l0 * scale, spec.r0 * scale, spec.r1 * scale, -1),
      ]),
      materials.seam ?? materials.glove
    )
  );
  const j2 = new THREE.Object3D();
  j2.position.z = -spec.l0 * scale;
  j1.add(j2);
  const s2 = new THREE.Mesh(segment(spec.l1 * scale, spec.r1 * scale, spec.r2 * scale), materials.glove);
  j2.add(s2);
  // Grip patch on the PALMAR side of the pad, matching the fingers, and a small
  // dorsal nail plate.
  const pad = blob(spec.r2 * 1.6 * scale, spec.r2 * 0.55 * scale, spec.l1 * 0.66 * scale, 0.0012, 2);
  pad.translate(0, -spec.r2 * 0.78 * scale, -spec.l1 * 0.45 * scale);
  j2.add(new THREE.Mesh(pad, materials.pad));
  const nail = blob(0.011 * scale, 0.0035 * scale, 0.016 * scale, 0.0012, 2);
  nail.translate(0, spec.r2 * scale, -0.016 * scale);
  j2.add(new THREE.Mesh(nail, materials.pad));
  return { root, joints: [j1, j2] };
}

/** Thumb dimensions, shared by the mesh and the contact solve. */
export const THUMB = { l0: 0.05, l1: 0.032, r0: 0.0115, r1: 0.0102, r2: 0.0078 };

/**
 * Tapered sleeve with fold rings, an elbow pad and a rolled cuff.
 * Both ends are CLOSED — an open lathe reads as a length of pipe, which is
 * exactly the "grey sausage" failure this rig has to avoid.
 */
export function buildSleeve(material, len, r0, r1, opts = {}) {
  const parts = [];
  /**
   * SEGMENT COUNT. The support forearm's closest approach to the eye is ~0.38 m
   * and it is ~120 px wide, so a 20-gon puts a facet sagitta of 0.7 px on the
   * silhouette — countable, and countable facets are exactly what the critique
   * measured. 32 takes it to 0.28 px, under the AA threshold.
   */
  const SEG = 32;
  /**
   * The shell profile is no longer a smooth cone. A sleeved forearm has three
   * things a cone does not: the fabric is loose so it bells slightly behind the
   * elbow, it is pulled tight over the muscle belly a third of the way down, and
   * it bunches again at the cuff. Those three inflections are what make the
   * silhouette read as cloth over a limb rather than as pipe.
   */
  const shell = latheZ(
    [
      [0, 0],
      [0, r0 * 0.55],
      [-0.004, r0 * 0.82],
      [-0.006, r0 * 0.98],
      [0.004, r0],
      [len * 0.16, r0 * 1.03],
      [len * 0.34, r0 * 0.9],
      [len * 0.52, (r0 + r1) * 0.5],
      [len * 0.72, r1 * 1.1],
      [len - 0.016, r1 * 1.0],
      [len - 0.005, r1 * 1.07],
      [len, r1 * 0.98],
      [len + 0.003, r1 * 0.8],
      [len + 0.004, 0],
    ],
    SEG
  );
  parts.push(shell);
  // Joint mass at the far end so the two bones read as one limb.
  const joint = latheZ(
    [
      [len - r1 * 1.1, 0],
      [len - r1 * 0.9, r1 * 0.75],
      [len - r1 * 0.2, r1 * 1.04],
      [len + r1 * 0.5, r1 * 0.9],
      [len + r1 * 0.8, r1 * 0.4],
      [len + r1 * 0.85, 0],
    ],
    20
  );
  joint.scale(1, 0.94, 1);
  parts.push(joint);
  /**
   * Fold rings. These are not decoration: they are the only concave creases on
   * the whole limb, and the curvature mask bake (Arm.bakeSurfaceMasks) turns
   * every one of them into a grime line with a dust-rubbed crown either side.
   * That is what puts texture on a surface whose albedo is 0.013 linear.
   *
   * Ellipticity and a per-fold radius jitter matter as much as the count: eight
   * identical circular rings equally spaced read as a hose, which is the failure
   * this is here to avoid.
   */
  const folds = opts.folds ?? 3;
  for (let i = 0; i < folds; i++) {
    const t = 0.14 + (i / Math.max(1, folds - 1)) * 0.7;
    // deterministic wobble, so captures stay byte-identical
    const j = dsin(i * 2.399 + 0.7) * 0.5 + dsin(i * 5.13) * 0.25;
    const r = (r0 + (r1 - r0) * t) * (1 + j * 0.06);
    const f = ring(r * 0.985, r * (0.085 + j * 0.03), 24, 6);
    f.rotateX(Math.PI / 2);
    f.rotateY(j * 0.12);
    f.scale(1, 0.93, 1);
    f.translate(0, 0, len * t + j * 0.004);
    parts.push(f);
  }
  /**
   * Two longitudinal wrinkle ridges down the inboard and outboard flanks. A
   * tube's silhouette is a straight line; a sleeve's is not, and these are the
   * cheapest thing that breaks it. They sit just proud of the shell so they
   * catch the key on their crown and shade the shell beside them.
   */
  for (const sx of [-1, 1]) {
    const w = latheZ(
      [
        [len * 0.2, 0],
        [len * 0.3, r0 * 0.16],
        [len * 0.55, r0 * 0.2],
        [len * 0.78, r0 * 0.13],
        [len * 0.86, 0],
      ],
      10
    );
    w.scale(1, 0.5, 1);
    w.rotateZ(sx * 0.4);
    w.translate(sx * (r0 + r1) * 0.46, -(r0 + r1) * 0.1, 0);
    parts.push(w);
  }
  if (opts.elbowPad) {
    const pad = blob(r0 * 1.5, r0 * 0.6, len * 0.3, r0 * 0.3, 3);
    pad.translate(0, r0 * 0.75, len * 0.12);
    parts.push(pad);
  }
  if (opts.cuff) {
    // Rolled, stitched cuff: two proud bands with a seam channel between them,
    // which is what a combat-shirt cuff actually looks like and gives the wrist
    // a hard terminator so the sleeve does not appear to melt into the glove.
    const cuff = latheZ(
      [
        [len - 0.032, r1 * 1.02],
        [len - 0.029, r1 * 1.17],
        [len - 0.019, r1 * 1.16],
        [len - 0.016, r1 * 1.08],
        [len - 0.012, r1 * 1.08],
        [len - 0.009, r1 * 1.18],
        [len - 0.003, r1 * 1.17],
        [len, r1 * 1.02],
      ],
      SEG
    );
    parts.push(cuff);
  }
  const g = mergeAll(parts);
  g.rotateY(Math.PI); // extend along -Z, like the bones
  return new THREE.Mesh(g, material);
}

