/**
 * Every number that defines how the player feels, in one place.
 *
 * Movement vocabulary is stand / crouch / jump — no sprint, slide, mantle,
 * lean or prone. The remaining numbers descend from a Modern Warfare-calibrated
 * set (authored in inches at 20 units = 1 ft) but the speeds have been re-tuned
 * for a game with no sprint key; see STANCE.
 *
 *   run               6.00 m/s
 *   crouch walk       3.05 m/s
 *   jump apex         0.60 m   (with -20.6 m/s^2 gravity)
 *
 * Gravity comes from UNITS.gravity (-20.6 m/s^2) so the jump arc matches the
 * rest of the game's physics rather than a private constant.
 */

import { UNITS } from '../core/config.js';
import { DEG } from './springs.js';

export const GRAVITY = UNITS.gravity; // negative
export const JUMP_APEX = 0.6;
/** v = sqrt(2 g h) — solved from the apex so tuning the apex is meaningful. */
export const JUMP_SPEED = Math.sqrt(2 * Math.abs(GRAVITY) * JUMP_APEX);

/**
 * Two stances. That is the entire posture vocabulary.
 *
 * Base speed is 6.0 m/s, not the 4.57 this movement code was tuned at. That
 * number was a *walk* in a game where sprint (7.0) covered ground — with sprint
 * deleted, the walk has to do both jobs or the map feels like wading. 6.0 sits
 * just under the old sprint, so pushing an angle still reads as committing.
 */
export const STANCE = {
  stand: {
    name: 'stand',
    height: UNITS.playerHeight, // 1.78
    eye: UNITS.playerHeight - UNITS.eyeOffset, // 1.66
    speed: 6.0,
    stepHeight: 0.42,
    strideLength: 1.48,
  },
  crouch: {
    name: 'crouch',
    height: UNITS.playerCrouchHeight, // 1.12
    eye: UNITS.playerCrouchHeight - 0.1, // 1.02
    speed: 3.05,
    stepHeight: 0.3,
    strideLength: 1.05,
  },
};

export const MOVE = {
  /** Directional scaling — you are slower sideways and slower still backwards. */
  strafeScale: 0.92,
  backScale: 0.8,

  /**
   * Ground response. 92 m/s^2 reaches base run speed in 50 ms — effectively
   * instant, which is what makes CoD feel "tight". Deceleration is deliberately
   * lower so there is a short slide-off tail instead of a dead stop.
   */
  groundAccel: 92,
  groundDecel: 52,
  /** Extra braking when the stick is released entirely. */
  stopDecel: 30,
  /** Air control: a quarter of ground authority, and it cannot add speed. */
  airAccelScale: 0.25,
  airSpeedCap: 3.4,
  terminalSpeed: 55,

  /** Grace windows that hide input/timing error. */
  coyoteTime: 0.09,
  jumpBuffer: 0.13,
  jumpCooldown: 0.28,




  /** Stance transition time constants (seconds to 63 %). */
  stanceTau: {
    standCrouch: 0.062,
    crouchStand: 0.072,
  },
};

export const CAMERA = {
  /**
   * View bob. Figure-eight (1:2 Lissajous) locked to the footstep cadence, so
   * the eye is at a horizontal extreme exactly when a foot lands. Amplitudes
   * are metres at base run speed — deliberately small; anything larger reads as
   * nausea rather than weight.
   */
  bob: {
    ampX: 0.0165,
    ampY: 0.0115,
    ampZ: 0.006,
    roll: 0.42 * DEG,
    pitch: 0.16 * DEG,
    speedExp: 0.85,
    speedCap: 1.55,
    airFade: 0.11, // tau to fade bob out in the air
  },

  /** Per-footstep vertical micro-shift, on top of the bob. */
  step: {
    impulse: 0.085, // m/s injected into the landing spring
    freq: 5.4,
    damping: 0.62,
  },

  land: {
    /** Fall speed at which a landing starts to register at all. */
    minSpeed: 2.2,
    /** Fall speed that produces a full-strength dip. */
    fullSpeed: 12.5,
    dipImpulse: 2.35, // m/s into the dip spring
    pitch: 3.4 * DEG,
    roll: 0.9 * DEG,
    freq: 3.05,
    damping: 0.52,
    trauma: 0.34,
    /** Hard landings cost health (CoD only damages above ~14 m/s). */
    damageSpeed: 15.0,
    damagePerSpeed: 7.0,
  },

  /** Lean-into-the-turn. Small; it is felt, not seen. */
  roll: {
    strafe: 1.05 * DEG,
    yawRate: 0.055, // radians of roll per radian/second of yaw
    yawRateMax: 1.5 * DEG,
    tau: 0.11,
    air: 0.9 * DEG,
  },

  recoil: {
    freq: 9.5,
    damping: 0.5,
    residualTau: 0.28,
    residualShare: 0.34,
    /** Positional punch (camera pushed back along view) uses a stiffer spring. */
    punchFreq: 12,
    punchDamping: 0.62,
  },

  shake: {
    decay: 1.85,
    rot: 1.35, // degrees at trauma = 1
    pos: 0.022,
    freq: 22,
  },

  breath: {
    /** Resting respiration ~14/min while idle. */
    freqA: 0.235,
    freqB: 0.155,
    amp: 0.0021, // radians
    posAmp: 0.0035, // metres
    moveDamp: 0.78,
  },

  fov: {
    /** Multipliers on config.fov. The only one left: a hair wider in the air,
     *  which sells the jump without touching the horizontal FOV that aim
     *  muscle memory is built on. */
    air: 1.015,
    moveTau: 0.13,
  },

  wallPad: 0.09,
  pitchLimit: 88 * DEG,
};

/**
 * No regeneration. Damage is permanent for the round — that is what makes a
 * won duel worth something and a chipped opponent worth pushing. Health is
 * restored only by a round reset.
 */
export const HEALTH = {
  max: 100,
  lowThreshold: 0.36,
  criticalThreshold: 0.18,
  /** Directional damage indicators live this long. */
  indicatorTime: 1.8,
  indicatorMax: 4,


};

export const FOOTSTEP = {
  /** Foot is offset laterally from the capsule centre so FX/audio pan. */
  lateral: 0.13,
  /** Surface probe length below the foot. */
  probe: 0.9,
  /** A step is only "running" (louder, dustier) above this speed. */
  runSpeed: 5.4,
  /** Landing suppresses the next step so you do not get a double transient. */
  landHold: 0.12,
};
