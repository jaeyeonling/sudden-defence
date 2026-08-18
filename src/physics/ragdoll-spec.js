/**
 * Bone specs for a ragdoll: the hand-authored humanoid, and the one derived
 * from whatever skeleton a dead actor happens to carry.
 */

import * as THREE from 'three';
import { hypot3 } from '../core/dmath.js';

export const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Default humanoid rig                                                */
/* ------------------------------------------------------------------ */

/**
 * A 15-capsule humanoid sized from a total height, in the actor's local frame
 * (feet at y = 0, +Z forward). Proportions are the standard 7.5-head figure.
 */
export function humanoidSpec(height = 1.8, scaleMass = 82) {
  const h = height;
  const M = scaleMass;
  const y = (f) => h * f;
  const b = (name, hx, hy, hz, tx, ty, tz, r, m, parent, cone, twist) => ({
    name,
    head: [hx, hy, hz],
    tail: [tx, ty, tz],
    radius: r * h,
    mass: m * M,
    parent,
    cone: cone * DEG,
    twist: twist * DEG,
  });
  const sh = h * 0.105; // half shoulder width
  const hip = h * 0.055;
  return [
    /* 0 */ b('pelvis', 0, y(0.53), 0, 0, y(0.63), 0, 0.085, 0.14, -1, 0, 0),
    /* 1 */ b('spine', 0, y(0.63), 0, 0, y(0.74), 0, 0.082, 0.12, 0, 22, 18),
    /* 2 */ b('chest', 0, y(0.74), 0, 0, y(0.83), 0, 0.088, 0.19, 1, 20, 15),
    /* 3 */ b('neck', 0, y(0.83), 0, 0, y(0.875), 0, 0.042, 0.02, 2, 30, 25),
    /* 4 */ b('head', 0, y(0.875), 0, 0, y(0.97), 0.01, 0.062, 0.07, 3, 42, 30),
    /* 5 */ b('upperArmL', -sh, y(0.815), 0, -sh - h * 0.015, y(0.65), 0, 0.045, 0.027, 2, 85, 60),
    /* 6 */ b('forearmL', -sh - h * 0.015, y(0.65), 0, -sh - h * 0.02, y(0.50), 0, 0.037, 0.018, 5, 80, 45),
    /* 7 */ b('handL', -sh - h * 0.02, y(0.50), 0, -sh - h * 0.02, y(0.44), 0, 0.032, 0.006, 6, 55, 40),
    /* 8 */ b('upperArmR', sh, y(0.815), 0, sh + h * 0.015, y(0.65), 0, 0.045, 0.027, 2, 85, 60),
    /* 9 */ b('forearmR', sh + h * 0.015, y(0.65), 0, sh + h * 0.02, y(0.50), 0, 0.037, 0.018, 8, 80, 45),
    /*10 */ b('handR', sh + h * 0.02, y(0.50), 0, sh + h * 0.02, y(0.44), 0, 0.032, 0.006, 9, 55, 40),
    /*11 */ b('thighL', -hip, y(0.53), 0, -hip * 1.05, y(0.29), 0, 0.062, 0.10, 0, 75, 35),
    /*12 */ b('shinL', -hip * 1.05, y(0.29), 0, -hip * 1.05, y(0.055), 0, 0.048, 0.045, 11, 70, 20),
    /*13 */ b('thighR', hip, y(0.53), 0, hip * 1.05, y(0.29), 0, 0.062, 0.10, 0, 75, 35),
    /*14 */ b('shinR', hip * 1.05, y(0.29), 0, hip * 1.05, y(0.055), 0, 0.048, 0.045, 13, 70, 20),
  ];
}

/* ------------------------------------------------------------------ */

export const MAX_PARTICLE_STEP = 0.35; // metres per fixed step, anti-explosion clamp
export const SLEEP_MOTION = 0.0022;
export const SLEEP_TIME = 0.6;


/**
 * Build a bone spec from an existing THREE.Skeleton by walking parent/child
 * links. Bones with no children get a short stub along their local +Y.
 * Returns { spec, boneMap } ready for `new Ragdoll(...).adoptSkeleton(...)`.
 */
export function specFromSkeleton(skeleton, opts = {}) {
  const bones = skeleton.bones;
  const spec = [];
  const boneMap = [];
  const indexOf = new Map();
  const v = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const totalMass = opts.mass ?? 82;

  for (let i = 0; i < bones.length; i++) indexOf.set(bones[i], i);

  const specIndexOfBone = new Map();
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    bone.updateWorldMatrix(true, false);
    v.setFromMatrixPosition(bone.matrixWorld);
    const childBone = bone.children.find((c) => c.isBone);
    if (childBone) {
      childBone.updateWorldMatrix(true, false);
      v2.setFromMatrixPosition(childBone.matrixWorld);
    } else {
      v2.copy(v).addScaledVector(
        new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())),
        opts.stubLength ?? 0.08
      );
    }
    const len = v.distanceTo(v2);
    if (len < 1e-4) continue;
    const si = spec.length;
    specIndexOfBone.set(bone, si);
    const parentSpec =
      bone.parent && specIndexOfBone.has(bone.parent) ? specIndexOfBone.get(bone.parent) : -1;
    spec.push({
      name: bone.name || `bone${i}`,
      head: [v.x, v.y, v.z],
      tail: [v2.x, v2.y, v2.z],
      radius: Math.max(0.025, len * (opts.radiusRatio ?? 0.32)),
      mass: 1,
      parent: parentSpec,
      cone: (opts.cone ?? 70) * DEG,
      twist: (opts.twist ?? 35) * DEG,
    });
    boneMap[si] = bone;
  }
  // distribute mass by bone volume
  let vol = 0;
  for (const s of spec) {
    const l = hypot3(s.tail[0] - s.head[0], s.tail[1] - s.head[1], s.tail[2] - s.head[2]);
    s.mass = Math.PI * s.radius * s.radius * l;
    vol += s.mass;
  }
  if (vol > 0) for (const s of spec) s.mass = Math.max(0.4, (s.mass / vol) * totalMass);

  return { spec, boneMap };
}

