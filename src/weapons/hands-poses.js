/**
 * Finger curls per pose, in radians per joint (proximal, middle, distal).
 * These are read straight off reference photos of a firing grip: the little
 * finger curls hardest, the index rides the trigger, the thumb wraps high.
 */
export const HAND_POSES = {
  /** Firing grip on a pistol grip. */
  grip: {
    /**
     * Firing grip on the pistol grip. The three lower fingers wrap ~180 deg of a
     * 31 x 34 mm grip section, which is 2.9-3.2 rad of total flexion — with the
     * MCP carrying the most, because that is the joint that gets the finger round
     * the front strap. The index is the trigger finger and is driven separately
     * by setTrigger(); the value here is its rest pose, taking up the slack on
     * the trigger face.
     */
    fingers: [
      [0.55, 0.72, 0.34],
      [1.15, 1.2, 0.62],
      [1.2, 1.25, 0.65],
      [1.22, 1.28, 0.66],
    ],
    thumb: [0.5, 0.34],
    thumbBase: [0.15, -1.02, -0.62],
  },
  /** Support hand wrapped around a handguard. */
  wrap: {
    fingers: [
      [1.18, 1.05, 0.45],
      [1.26, 1.12, 0.5],
      [1.3, 1.16, 0.55],
      [1.34, 1.2, 0.6],
    ],
    thumb: [0.42, 0.3],
    thumbBase: [0.1, -1.15, -0.35],
  },
  /**
   * C-clamp on a handguard: the modern support grip, and the only one whose
   * knuckle line turns toward the camera.
   *
   * The proximal curls are what decide whether the hand CLOSES. Summed over the
   * three joints each finger has to sweep the arc from the contact clock angle,
   * round the tube, to the far side: for a 47 mm handguard gripped 14 mm off the
   * surface that is 150-165 deg, i.e. 2.6-2.9 rad total. Anything less and the
   * fingertips stop in mid-air short of the far side, which is the "detached grey
   * slabs with daylight between them and the handguard" failure.
   *
   * The little finger curls hardest (it is shortest and has the least tube to
   * cross); the index sits proudest because it is closest to the thumb web.
   */
  clamp: {
    /**
     * SOLVED, per joint, against the rifle's 47 mm handguard.
     *
     * A uniform curl ratio cannot wrap a cylinder: it traces a spiral, so if the
     * middle joint touches, the fingertip stands 20 mm off. These numbers come
     * out of a per-joint bisection that puts the PIP, the DIP and the fingertip
     * all exactly 8.2 mm from the handguard surface — one finger radius, i.e. the
     * glove skin in contact with a 0-1 mm interpenetration the whole way round.
     *
     * The distribution that falls out (MCP ~0.6, PIP ~1.2, DIP ~0.8) is also what
     * a real hand does on a tube: the middle joint carries most of the wrap. And
     * the LONGEST finger curls most, not the little one — the "little finger
     * curls hardest" rule is a tapered-pistol-grip rule and is wrong here.
     */
    fingers: [
      [0.612, 1.059, 0.797],
      [0.731, 1.286, 0.863],
      [0.73, 1.268, 0.808],
      [0.601, 1.105, 0.684],
    ],
    // Thumb laid ACROSS the top of the handguard rather than forward into space.
    // The thumb root sits at the heel of the palm, which on a C-clamp stands ~50
    // mm off a 47 mm tube (unavoidable: a 98 mm palm tangent to a 23.5 mm radius
    // diverges), so a forward-pointing thumb hangs in mid-air. Aimed at the tube
    // it bridges that gap and closes the silhouette.
    thumb: [0.3, 0.24],
    thumbBase: [0.04, 0.76, -0.05],
  },
  /** Two-handed pistol grip: support hand cups the shooting hand. */
  cup: {
    fingers: [
      [1.05, 0.95, 0.4],
      [1.12, 1.0, 0.44],
      [1.16, 1.04, 0.48],
      [1.2, 1.08, 0.52],
    ],
    thumb: [0.28, 0.2],
    thumbBase: [0.0, -1.25, -0.2],
  },
  /** Open hand: mag grab, charging handle, inspect. */
  open: {
    fingers: [
      [0.35, 0.28, 0.14],
      [0.32, 0.26, 0.12],
      [0.34, 0.28, 0.14],
      [0.4, 0.32, 0.16],
    ],
    thumb: [0.12, 0.1],
    thumbBase: [0.1, -0.8, -0.35],
  },
  /** Pinch: holding the charging handle or a magazine by its spine. */
  pinch: {
    fingers: [
      [0.95, 0.85, 0.55],
      [1.0, 0.9, 0.6],
      [0.7, 0.6, 0.35],
      [0.6, 0.5, 0.3],
    ],
    thumb: [0.62, 0.55],
    thumbBase: [0.25, -0.75, -0.7],
  },
};

