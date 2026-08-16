/**
 * First-person arms.
 *
 * Two bones per arm, solved analytically from the hand (which is the thing the
 * animation drives — the hands are welded to the weapon, the elbows follow).
 * That is the same order of operations a real animator uses and it means the
 * hands can never slide off the grip.
 *
 * Anatomy is deliberate: a hand is 190 mm wrist-to-fingertip and 88 mm across
 * the knuckles, the fingers taper and *separate*, the knuckles are lumps, the
 * glove has a padded back, a palm patch, seams down the finger sides and a
 * velcro wrist strap, and the sleeve is a tapered tube with real fold rings and
 * a rolled cuff. That list is the difference between a hand and a grey sausage.
 *
 * Hand-local space: -Z along the fingers, +Y out of the back of the hand,
 * +X toward the thumb (a right hand; the left is mirrored).
 */

import * as THREE from 'three';
import { L_UPPER, L_FORE, THUMB, buildFinger, buildGlove, buildThumb, buildSleeve } from './hands-geometry.js';
import { HAND_POSES } from './hands-poses.js';

/* -------------------------------------------------------------------------- */
/*  arm rig                                                                   */
/* -------------------------------------------------------------------------- */

const _t = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
// contact-fit scratch (build time only, but the no-allocation rule holds anyway)
const _fitInv = new THREE.Matrix4();
const _fitP = new THREE.Vector3();
const _fitD = new THREE.Vector3();
const _fitAxis = new THREE.Vector3();
const _fitAx0 = new THREE.Vector3();
const _fitM = new THREE.Matrix4();

/**
 * Orient a bone whose geometry runs along its local -Z so that -Z points along
 * `dir`, with local +Y rolled toward `up`.
 *
 * This deliberately does NOT use Object3D.lookAt(): for non-camera objects
 * lookAt aims local **+Z** at the target (so a -Z bone would point backwards),
 * and it interprets the target in WORLD space, which is wrong here because
 * every joint position is authored in the rig's local space.
 */
function aimBone(quat, dir, up) {
  _bz.copy(dir).multiplyScalar(-1).normalize(); // local +Z is opposite the bone
  _by.copy(up);
  _by.addScaledVector(_bz, -_by.dot(_bz));
  if (_by.lengthSq() < 1e-9) {
    // Degenerate roll reference: pick any axis that is not parallel to the bone.
    _by.set(0, 1, 0).addScaledVector(_bz, -_bz.y);
    if (_by.lengthSq() < 1e-9) _by.set(1, 0, 0).addScaledVector(_bz, -_bz.x);
  }
  _by.normalize();
  _bx.crossVectors(_by, _bz).normalize();
  _bm.makeBasis(_bx, _by, _bz);
  return quat.setFromRotationMatrix(_bm);
}

/**
 * One arm: shoulder -> upper -> fore -> hand, solved from the hand target.
 * All positions are expressed in the arm root's parent space (the viewmodel
 * rig's space), which is what makes the maths trivial.
 */
export class Arm {
  constructor(side, materials, opts = {}) {
    this.side = side; // -1 left, +1 right
    this.scale = opts.scale ?? 1;
    this.l1 = (opts.upper ?? L_UPPER) * this.scale;
    this.l2 = (opts.fore ?? L_FORE) * this.scale;

    this.root = new THREE.Object3D();
    this.root.name = side < 0 ? 'arm-left' : 'arm-right';
    /** Kept so `bakeSurfaceMasks` can classify a mesh by which surface it wears. */
    this._mats = materials;

    this.shoulder = new THREE.Vector3(
      side * (opts.shoulderX ?? 0.19),
      opts.shoulderY ?? -0.19,
      opts.shoulderZ ?? 0.12
    );
    /**
     * Elbow swing direction, in the ARM ROOT's space (= the viewmodel rig's
     * space), NOT in hand space.
     *
     * Expressing the pole in hand space is the intuitive choice and it is wrong:
     * the support hand is rolled palm-up on the handguard, so its local "down"
     * points at the sky and the elbow swings UP — straight through the near
     * plane, filling half the screen with forearm. Elbows go down and outboard,
     * always, exactly as they do on a real shooter.
     */
    this.pole = new THREE.Vector3(side * 0.46, -0.86, 0.22).normalize();

    // Bones. Geometry extends along -Z from each joint.
    /**
     * Sleeve radii.
     *
     * MEASURED, twice. At 78 mm across the elbow / 54 mm at the wrist the
     * support forearm rendered as a 160 px-wide smooth tube crossing the lower
     * third of every hipfire frame — "a huge untextured tan tube", and the single
     * most-cited defect in the whole build. The width is not the only problem
     * (see the material and the mask bake) but it is a third of it: the support
     * forearm's closest approach to the eye is ~0.38 m, so every millimetre of
     * radius is 2.6 px of screen at 1080p.
     *
     * A real combat shirt over a forearm is 68 mm at the elbow tapering to 48 mm
     * at the wrist, and that is what these are now: 0.034/0.024. The shooting
     * arm keeps a fuller upper sleeve (it is almost entirely out of frame) so the
     * two arms still read as the same garment.
     *
     * Fold counts go UP, not down: with the tube narrower the folds are what
     * carry the silhouette, and each one is a crease the mask bake fills with
     * grime and a crown it rubs dust onto.
     */
    this.upper = buildSleeve(materials.sleeve, this.l1, 0.044 * this.scale, 0.036 * this.scale, {
      folds: 5,
      elbowPad: true,
    });
    this.fore = buildSleeve(materials.sleeve, this.l2, 0.034 * this.scale, 0.024 * this.scale, {
      folds: 7,
      cuff: true,
    });
    this.upperPivot = new THREE.Object3D();
    this.forePivot = new THREE.Object3D();
    this.upperPivot.add(this.upper);
    this.forePivot.add(this.fore);
    this.root.add(this.upperPivot);
    this.root.add(this.forePivot);

    // Hand.
    this.hand = new THREE.Object3D();
    this.hand.name = side < 0 ? 'hand-left' : 'hand-right';
    this.handInner = new THREE.Object3D();
    /**
     * CHIRALITY. The basis built by handBasis is right-handed with X = Y cross Z,
     * so for a hand whose fingers run along -Z and whose palm faces -Y, +X points
     * AWAY from the thumb on a right hand and TOWARD it on a left hand. The
     * geometry below puts the thumb at +X, which makes the authored mesh a LEFT
     * hand — so it is the RIGHT arm that needs the mirror, not the left.
     *
     * With this the wrong way round the shooting hand was a left hand on the
     * right side of the grip: the index (which setTrigger drives) came out at the
     * bottom-rear of the grip instead of on the trigger, and no choice of target
     * frame could fix it, because putting the thumb at the top of the grip forced
     * the fingers to wrap backwards around the back strap.
     */
    this.handInner.scale.x = side < 0 ? 1 : -1;
    this.hand.add(this.handInner);
    this.glove = buildGlove(materials, { scale: this.scale });
    this.handInner.add(this.glove);
    this.root.add(this.hand);

    // Fingers: index is separate so it can work the trigger.
    const fingerSpecs = [
      { x: 0.0298, len: [0.045, 0.028, 0.022], r: [0.0102, 0.0096, 0.0086, 0.0062] }, // index
      { x: 0.0102, len: [0.049, 0.031, 0.023], r: [0.0104, 0.0098, 0.0088, 0.0064] },
      { x: -0.0104, len: [0.046, 0.029, 0.022], r: [0.01, 0.0094, 0.0084, 0.006] },
      { x: -0.0298, len: [0.038, 0.024, 0.02], r: [0.0092, 0.0086, 0.0078, 0.0056] },
    ];
    this.fingers = [];
    // Per-segment dimensions, kept so `fitToCylinder` can walk the chain without
    // re-deriving them.
    this._segRadius = fingerSpecs.map((s) => s.r.map((v) => v * this.scale));
    this._segLength = fingerSpecs.map((s) => s.len.map((v) => v * this.scale));
    for (let i = 0; i < 4; i++) {
      const sp = fingerSpecs[i];
      const f = buildFinger(materials, {
        lengths: sp.len.map((v) => v * this.scale),
        radii: sp.r.map((v) => v * this.scale),
        curl: [0, 0, 0],
      });
      // The metacarpophalangeal joints sit on the PALMAR half of the hand, not on
      // its centre line. 3.5 mm dorsal put every finger's axis 10 mm further from
      // whatever the hand was gripping than the palm's own contact surface, so a
      // palm placed flush on a handguard still left the fingers hovering 8-14 mm
      // clear of it — the daylight the critique measured. -6 mm puts the finger
      // axis 8 mm off the palm's contact plane, which is one finger radius.
      f.root.position.set(sp.x * this.scale, -0.006 * this.scale, -0.096 * this.scale);
      // fingers fan out very slightly
      f.root.rotation.y = -sp.x * 2.2;
      this.glove.add(f.root);
      this.fingers.push(f);
    }
    this.thumb = buildThumb(materials, this.scale, THUMB);
    // The carpometacarpal joint is palmar and a little further into the hand than
    // the old placement: a thumb rooted on the hand's centre plane rotates in the
    // plane of the back of the hand, which is why the old one read as a spur.
    this.thumb.root.position.set(0.037 * this.scale, -0.009 * this.scale, -0.04 * this.scale);
    this.thumb.root.rotation.set(0.2, -0.95, -0.5);
    this.glove.add(this.thumb.root);

    // Same rule as the weapon: receive the world sun shadow, cast nothing.
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });

    /**
     * Per-weapon pose overrides, written by `fitToCylinder`. `setPose` looks here
     * first, so a pose solved against one weapon's handguard cannot leak onto
     * another's — and, critically, a clip that swaps the support hand to 'open'
     * and back to 'clamp' restores the FITTED clamp, not the authored one.
     */
    this.poses = {};

    this.setPose(opts.pose ?? 'wrap');
  }

  /**
   * BUILD-TIME CONTACT SOLVE: clamp every fingertip onto a cylinder.
   *
   * The authored `clamp` curls were derived analytically from a 47 mm tube and
   * one nominal contact clock angle, and on paper they put the PIP, DIP and tip
   * all 8.2 mm off the surface. On screen they did not: in hero, detail, weapon
   * and ads the distal segments visibly stood clear of the handguard, because the
   * analytic solve ignored (a) the 0.88 Y-scale on the finger capsules, (b) the
   * -6 mm palmar offset of the MCP row, (c) the fan-out rotation on each finger
   * root and (d) the fact that the four fingers start at four different X, so
   * they meet the cylinder at four different clock angles.
   *
   * Rather than push more algebra at it, MEASURE it: pose the hand, walk the real
   * transform chain to each fingertip's contact patch, and search the distal
   * joint's own rotation for the value that lands the patch on the surface. That
   * is a raycast against the collision profile in all but name, and it is exact
   * by construction because it uses the same matrices the renderer will.
   *
   * The thumb is fitted the same way but wraps to the OPPOSITE side of the tube:
   * a C-clamp whose thumb is on the same side as the fingers is a fist held next
   * to the gun, not a grip on it.
   *
   * @param {THREE.Vector3}  handPos    wrist target, arm-root space
   * @param {THREE.Quaternion} handQuat wrist orientation
   * @param {number[]} axisPoint  a point on the cylinder axis, arm-root space
   * @param {number[]} axisDir    the cylinder axis direction
   * @param {number}   radius     cylinder radius
   * @param {object}   opts       { clearance, poseName }
   * @returns {THREE.Vector3[]}   contact points, arm-root space (for baked AO)
   */
  fitToCylinder(handPos, handQuat, axisPoint, axisDir, radius, opts = {}) {
    const clearance = opts.clearance ?? 0.001;
    const poseName = opts.poseName ?? this.pose;
    const base = this.poses[poseName] ?? HAND_POSES[poseName] ?? HAND_POSES.clamp;

    this.hand.position.copy(handPos);
    this.hand.quaternion.copy(handQuat);
    this.root.updateMatrixWorld(true);
    // Everything is measured in the ARM ROOT's space, so the result is
    // independent of wherever the rig happens to be this frame.
    _fitInv.copy(this.root.matrixWorld).invert();
    _fitAxis.set(axisDir[0], axisDir[1], axisDir[2]).normalize();
    const ax0 = _fitAx0.set(axisPoint[0], axisPoint[1], axisPoint[2]);

    /** Signed distance from a joint-local point to the cylinder surface. */
    const gapAt = (joint, lx, ly, lz, out) => {
      joint.updateWorldMatrix(true, true);
      _fitP.set(lx, ly, lz).applyMatrix4(joint.matrixWorld).applyMatrix4(_fitInv);
      if (out) out.copy(_fitP);
      _fitD.copy(_fitP).sub(ax0);
      _fitD.addScaledVector(_fitAxis, -_fitD.dot(_fitAxis));
      return _fitD.length() - radius;
    };

    /**
     * Scan a joint's flexion for the angle that puts `local` on the surface.
     *
     * A scan, not a bisection: the gap is not monotonic in curl (past ~110 deg
     * the tip starts coming back OUT the far side of the tube), so a bisection
     * can converge on the wrong root. 40 samples over the anatomical range is
     * 2.5 deg of resolution, which is 0.4 mm at the fingertip.
     */
    const fitJoint = (joint, local, lo, hi, standoff = 0) => {
      let best = joint.rotation.x;
      let bestCost = Infinity;
      for (let i = 0; i <= 48; i++) {
        const a = lo + ((hi - lo) * i) / 48;
        joint.rotation.x = a;
        const g = gapAt(joint, local[0], local[1], local[2]) - standoff;
        // Target: on the surface, up to `clearance` proud, at most 1.5 mm buried.
        const cost = Math.abs(g - clearance * 0.5) + (g < -0.0015 ? (-g - 0.0015) * 8 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = a;
        }
      }
      joint.rotation.x = best;
      return best;
    };

    /**
     * Wrap all three joints, PROXIMAL FIRST.
     *
     * Fitting only the distal joint cannot wrap a cylinder: if the MCP and PIP
     * are authored for a different contact clock angle the finger traces the
     * wrong spiral, and the distal joint is then asked to close a gap it is 22 mm
     * long and physically cannot reach. Solving the chain outward — each joint
     * placing the NEXT joint's origin one finger-radius off the surface, then the
     * distal joint placing the actual contact patch on it — is what a finger does,
     * and it is stable because each stage only has one degree of freedom.
     */
    const fingers = [];
    const contacts = [];
    for (let i = 0; i < 4; i++) {
      const f = this.fingers[i];
      const curl = base.fingers[i].slice();
      for (let j = 0; j < 3; j++) f.joints[j].rotation.x = -curl[j];
      const rr = this._segRadius?.[i] ?? [0.01, 0.0094, 0.0084, 0.006];
      const ll = this._segLength?.[i] ?? [0.046, 0.029, 0.022];
      for (let j = 0; j < 2; j++) {
        // The next joint's origin sits ON the finger's own axis, so it wants to
        // be one segment-radius clear of the surface, not on it.
        const a = fitJoint(f.joints[j], [0, 0, -ll[j]], -1.75, -0.05, rr[j + 1] * 0.92);
        curl[j] = -a;
      }
      // The fingertip grip patch: palmar side, one radius below the axis, half
      // way along the distal segment — the same numbers as the `tip` blob in
      // buildFinger, so the mask and the mesh agree.
      const local = [0, -rr[3] * 1.05, -ll[2] * 0.5];
      const a2 = fitJoint(f.joints[2], local, -1.95, -0.1, 0);
      curl[2] = -a2;
      fingers.push(curl);
      const p = new THREE.Vector3();
      gapAt(f.joints[2], local[0], local[1], local[2], p);
      contacts.push(p);
    }

    /**
     * ---- thumb: over the top and down the FAR side --------------------------
     *
     * THE THUMB BASE IS SOLVED TOO, and it has to be.
     *
     * MEASURED on the shipped build by walking the real transform chain: the four
     * fingertips landed 0.4-0.7 mm off the handguard — a genuine grip — and the
     * THUMB TIP was 13.5 mm clear of it. The thumb is the part of the support hand
     * that lies across the top of the handguard and therefore the part the camera
     * sees most of in the hipfire pose, so that 13.5 mm was most of "fingers do not
     * wrap the grip, they float beside it with a visible gap".
     *
     * The cause is that the two flexion joints were being fitted against a base
     * rotation that was AUTHORED, not solved. The thumb's carpometacarpal joint is
     * a saddle with two useful degrees of freedom and the authored abduction was
     * aimed for a different contact clock angle; with the metacarpal pointing past
     * the tube, 68 mm of thumb flexing on two hinges cannot reach it, and the scan
     * just parks both joints at their limits.
     *
     * So the base's Y (abduction — the axis that swings the thumb across the palm)
     * is scanned first, coarsely, for the value that brings the tip closest, and
     * only then are the two flexion joints fitted. One extra degree of freedom,
     * 24 samples, build time only.
     */
    const thumbBase = (base.thumbBase ?? [0, 0, 0]).slice();
    const thumb = (base.thumb ?? [0.3, 0.24]).slice();
    this.thumb.root.rotation.fromArray(thumbBase);
    this.thumb.joints[0].rotation.x = -thumb[0];
    this.thumb.joints[1].rotation.x = -thumb[1];
    const tr = THUMB.r2 * this.scale;
    const tlen = THUMB.l1 * this.scale;
    const tLocal = [0, -tr * 1.05, -tlen * 0.55];
    {
      // Mid-flex the two hinges while the base is searched, so the scan measures
      // where a naturally curled thumb would land rather than where a straight
      // one would.
      this.thumb.joints[0].rotation.x = -0.55;
      this.thumb.joints[1].rotation.x = -0.45;
      const y0 = thumbBase[1];
      const z0 = thumbBase[2];
      let bestY = y0;
      let bestZ = z0;
      let bestCost = Infinity;
      // Two axes, not one. MEASURED: scanning abduction alone still left the tip
      // 13.2 mm clear, because from a metacarpal root sitting 40-55 mm off a 54 mm
      // tube a 68 mm thumb only reaches if it is aimed at the surface in BOTH the
      // across-the-palm and the up-off-the-palm sense. 21 x 15 samples, build time.
      for (let i = 0; i <= 20; i++) {
        const yy = y0 - 1.3 + (2.6 * i) / 20;
        for (let k = 0; k <= 14; k++) {
          const zz = z0 - 0.9 + (1.8 * k) / 14;
          this.thumb.root.rotation.y = yy;
          this.thumb.root.rotation.z = zz;
          const g = gapAt(this.thumb.joints[1], tLocal[0], tLocal[1], tLocal[2]);
          // Prefer just-touching; punish burying much harder than standing off, and
          // add a small pull toward the authored pose so the solve stays plausible.
          const cost =
            Math.abs(g - clearance) +
            (g < -0.002 ? (-g - 0.002) * 10 : 0) +
            (Math.abs(yy - y0) + Math.abs(zz - z0)) * 0.0009;
          if (cost < bestCost) {
            bestCost = cost;
            bestY = yy;
            bestZ = zz;
          }
        }
      }
      this.thumb.root.rotation.y = bestY;
      this.thumb.root.rotation.z = bestZ;
      thumbBase[1] = bestY;
      thumbBase[2] = bestZ;
    }
    const a0 = fitJoint(
      this.thumb.joints[0],
      [0, 0, -THUMB.l0 * this.scale],
      -1.45,
      -0.02,
      THUMB.r1 * this.scale
    );
    thumb[0] = -a0;
    const a1 = fitJoint(this.thumb.joints[1], tLocal, -1.6, -0.05, 0);
    thumb[1] = -a1;
    const tp = new THREE.Vector3();
    gapAt(this.thumb.joints[1], tLocal[0], tLocal[1], tLocal[2], tp);
    contacts.push(tp);

    this.poses[poseName] = { fingers, thumb, thumbBase };
    this.pose = poseName;
    return contacts;
  }

  /**
   * BAKE CURVATURE MASKS ON THE WHOLE LIMB.
   *
   * This is the fix for "a huge UNTEXTURED tan tube" and "a rounded mitten of
   * stacked extruded ring segments".
   *
   * Every weapon mesh has had wear/grime/AO vertex masks baked since the first
   * build (see Viewmodel.addWeapon) — the arms never did. Their `color`
   * attribute was absent, so the shader read vColor = (0,0,0) and the wear,
   * grime and cavity-AO layers of `sleeve`, `glove`, `glove_pad` and
   * `glove_seam` were ALL switched off. Every one of those materials carries a
   * carefully tuned wear amplitude, a grime colour and an AO term that had
   * literally no effect on a single pixel: the arm was a flat albedo under a
   * smooth specular lobe, which is exactly what "untextured tube" means.
   *
   * Amplitudes are per surface class, because cloth, moulded TPR and a stitched
   * seam weather in completely different ways:
   *   cloth   broad, soft. The exponent stays LOW (1.6) so the mask spreads off
   *           the fold crease and dusts the whole crown — on fabric the dirt is
   *           not confined to the outer millimetre the way it is on a chamfer.
   *   pads    harder: a TPR knuckle cap polishes on its dome and collects grime
   *           in the flex gap around it, so wear is high and tight.
   *   seams   a proud sewn edge is the FIRST thing to go pale, so it takes the
   *           most wear of anything on the hand at the tightest exponent.
   *
   * @param {(geo: THREE.BufferGeometry, o: object) => void} bake   materials.bakeMasks
   * @param {(geo: THREE.BufferGeometry, o: object) => void} shape  mask re-shaper
   * @param {object} rng
   */
  bakeSurfaceMasks(bake, shape, rng = null) {
    if (!bake) return this;
    const m = this._mats ?? {};
    const CLOTH = { wearAmp: 0.5, wearExp: 1.6, grimeAmp: 1.0, grimeExp: 1.15, aoAmp: 0.9, aoExp: 1.1 };
    const SLEEVE = { wearAmp: 0.62, wearExp: 1.5, grimeAmp: 1.0, grimeExp: 1.0, aoAmp: 0.95, aoExp: 1.0 };
    const PAD = { wearAmp: 0.85, wearExp: 2.2, grimeAmp: 0.95, grimeExp: 1.4, aoAmp: 1.0, aoExp: 1.2 };
    const SEAM = { wearAmp: 1.0, wearExp: 2.6, grimeAmp: 0.7, grimeExp: 1.6, aoAmp: 0.8, aoExp: 1.2 };
    const done = new Set();
    this.root.traverse((o) => {
      if (!o.isMesh || done.has(o.geometry)) return;
      done.add(o.geometry);
      const prof =
        o.material === m.sleeve ? SLEEVE
          : o.material === m.pad ? PAD
            : o.material === m.seam ? SEAM
              : CLOTH;
      // A lower edge threshold than the weapon's 0.16: the limb is all lathes and
      // blobs, so its creases are gentle and a hard-edge threshold finds nothing.
      bake(o.geometry, { wear: 1, grime: 1, ao: 1, edgeThreshold: 0.09, rng });
      shape(o.geometry, prof);
    });
    return this;
  }

  /**
   * Bake a contact-AO gradient into the GLOVE side of each contact.
   *
   * Geometric contact alone does not read as contact: two surfaces can be 0.5 mm
   * apart and still look like two floating objects, because nothing in the
   * lighting says they occlude each other. The cheap, correct cue is ambient
   * occlusion in the crevice — so the glove gets the same 0.55 multiply over a
   * 12 mm falloff that the handguard gets (see Viewmodel.addWeapon).
   *
   * The mask goes in vColor.b, which `materials/shader.js` uses as
   * `orm.r *= 1.0 - vColor.b * wear[2]`. The glove geometry carries no colour
   * attribute today, so the shader sees (0,0,0) — wear and grime OFF. Writing
   * (0, 0, ao) preserves that exactly and only lights up the AO term.
   *
   * @param {THREE.Vector3[]} contacts  contact points in arm-root space
   */
  bakeContactAO(contacts, radius = 0.012, peak = 0.9) {
    if (!contacts?.length) return this;
    this.root.updateMatrixWorld(true);
    _fitInv.copy(this.root.matrixWorld).invert();
    const r2 = radius * radius;
    this.glove.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      let col = geo.getAttribute('color');
      if (!col || col.itemSize !== 3) {
        col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
        geo.setAttribute('color', col);
      }
      _fitM.multiplyMatrices(_fitInv, o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        _fitP.fromBufferAttribute(pos, i).applyMatrix4(_fitM);
        let closest = Infinity;
        for (const c of contacts) {
          const d2 = _fitP.distanceToSquared(c);
          if (d2 < closest) closest = d2;
        }
        if (closest > r2) continue;
        const t = 1 - Math.sqrt(closest) / radius;
        // smootherstep so the gradient has no visible terminator
        const s = t * t * t * (t * (t * 6 - 15) + 10);
        col.array[i * 3 + 2] = Math.max(col.array[i * 3 + 2], peak * s);
      }
      col.needsUpdate = true;
    });
    return this;
  }

  /** Static finger poses. The trigger finger is driven separately. */
  setPose(name) {
    const P = this.poses?.[name] ?? HAND_POSES[name] ?? HAND_POSES.wrap;
    for (let i = 0; i < 4; i++) {
      const curl = P.fingers[i];
      for (let j = 0; j < 3; j++) this.fingers[i].joints[j].rotation.x = -curl[j];
    }
    this.thumb.joints[0].rotation.x = -P.thumb[0];
    this.thumb.joints[1].rotation.x = -P.thumb[1];
    if (P.thumbBase) this.thumb.root.rotation.fromArray(P.thumbBase);
    this.pose = name;
    return this;
  }

  /** Trigger-finger curl, 0 = off the trigger, 1 = fully pressed. */
  setTrigger(t) {
    const f = this.fingers[0];
    // Rest pose matches HAND_POSES.grip.fingers[0]: the finger is already ON the
    // trigger with the slack taken up, not standing off it straight.
    f.joints[0].rotation.x = -(0.55 + t * 0.3);
    f.joints[1].rotation.x = -(0.72 + t * 0.42);
    f.joints[2].rotation.x = -(0.34 + t * 0.3);
  }

  /**
   * Solve the two-bone chain so the hand lands exactly on `targetPos` with
   * orientation `targetQuat`, elbow swung toward the pole.
   */
  solve(targetPos, targetQuat) {
    this.hand.position.copy(targetPos);
    this.hand.quaternion.copy(targetQuat);

    _t.copy(targetPos).sub(this.shoulder);
    let d = _t.length();
    const maxD = (this.l1 + this.l2) * 0.995;
    const minD = Math.abs(this.l1 - this.l2) * 1.05 + 1e-4;
    if (d > maxD) {
      _t.multiplyScalar(maxD / d);
      d = maxD;
    } else if (d < minD) {
      if (d < 1e-5) _t.set(0, 0, -minD);
      else _t.multiplyScalar(minD / d);
      d = minD;
    }
    _dir.copy(_t).divideScalar(d);

    // Circle of possible elbow positions; pick the point toward the pole.
    const a = (this.l1 * this.l1 - this.l2 * this.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.l1 * this.l1 - a * a));
    _pole.copy(this.pole);
    _perp.copy(_pole).addScaledVector(_dir, -_pole.dot(_dir));
    if (_perp.lengthSq() < 1e-8) {
      _perp.set(this.side, -1, 0).addScaledVector(_dir, 0);
      _perp.addScaledVector(_dir, -_perp.dot(_dir));
    }
    _perp.normalize();
    _elbow.copy(this.shoulder).addScaledVector(_dir, a).addScaledVector(_perp, h);

    // Upper arm: shoulder -> elbow. The elbow pad sits on the bone's +Y, which
    // must end up on the OUTSIDE of the bend — that is the pole side.
    this.upperPivot.position.copy(this.shoulder);
    _hp.copy(_elbow).sub(this.shoulder);
    if (_hp.lengthSq() > 1e-12) aimBone(this.upperPivot.quaternion, _hp, _perp);

    // Forearm: elbow -> wrist, rolled with the back of the hand so the cuff and
    // the wrist line up with the glove.
    this.forePivot.position.copy(_elbow);
    _up.set(0, 1, 0).applyQuaternion(targetQuat);
    _hp.copy(targetPos).sub(_elbow);
    if (_hp.lengthSq() > 1e-12) aimBone(this.forePivot.quaternion, _hp, _up);
    return this;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
  }
}

