import { dcos, dexp } from '../core/dmath.js';
/**
 * Scalar maths + spring integrators used by the player controller.
 *
 * Everything here is allocation-free after construction and framerate
 * independent: the springs sub-step internally so a 8 ms physics tick and a
 * 33 ms hitch produce the same visible motion.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/** C2-continuous ease — used for rooted mantle curves where velocity must not pop. */
export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function easeOutCubic(t) {
  t = clamp01(t);
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutSine(t) {
  return 0.5 - 0.5 * dcos(clamp01(t) * Math.PI);
}

/**
 * Exponential approach with a real time constant. `tau` is the 63 % time, so
 * "reach it in about a tenth of a second" is tau = 0.1 / 2.3.
 */
export function approach(current, target, tau, dt) {
  if (tau <= 1e-6) return target;
  return target + (current - target) * dexp(-dt / tau);
}

/** Constant-rate move, for things that must not have an asymptotic tail. */
export function moveToward(current, target, rate, dt) {
  const d = target - current;
  const step = rate * dt;
  if (d > step) return current + step;
  if (d < -step) return current - step;
  return target;
}

/** Shortest signed angular difference, radians. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic value noise in 1D — camera shake without touching any RNG. */
export function hashNoise(x, seed = 0) {
  const xi = Math.floor(x);
  const f = x - xi;
  const h = (i) => {
    let n = (i | 0) ^ (seed * 374761393);
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    n ^= n >>> 15;
    return ((n >>> 0) / 4294967296) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(xi) * (1 - u) + h(xi + 1) * u;
}

const MAX_SUB_DT = 1 / 360;

/**
 * Damped harmonic oscillator, driven by frequency (Hz) and damping ratio.
 *   zeta < 1  under-damped, overshoots — good for punchy recoil
 *   zeta = 1  critically damped, fastest non-overshooting — good for FOV/ADS
 * `impulse()` injects velocity (the physical way to kick a spring), `set()`
 * displaces it instantly.
 */
export class Spring {
  /**
   * Snapshot classification. `freq` and `damping` are tuning and never move;
   * `value`, `velocity` and `target` are the integrator and do. A spring that
   * rewound its constants would restore a different spring.
   */
  static snapshotState = ['value', 'velocity', 'target'];
  static excludedState = ['freq', 'damping'];

  captureState(out = {}) {
    out.value = this.value;
    out.velocity = this.velocity;
    out.target = this.target;
    return out;
  }

  restoreState(s) {
    this.value = s.value;
    this.velocity = s.velocity;
    this.target = s.target;
  }

  constructor(freq = 8, damping = 0.7, value = 0) {
    this.freq = freq;
    this.damping = damping;
    this.value = value;
    this.velocity = 0;
    this.target = 0;
  }

  reset(value = 0) {
    this.value = value;
    this.velocity = 0;
    return this;
  }

  impulse(v) {
    this.velocity += v;
    return this;
  }

  set(v) {
    this.value = v;
    return this;
  }

  step(dt) {
    if (dt <= 0) return this.value;
    const w = TAU * this.freq;
    const k = w * w;
    const c = 2 * this.damping * w;
    // Sub-step so a stiff spring stays stable through a dropped frame.
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-7 && guard++ < 24) {
      const h = remaining > MAX_SUB_DT ? MAX_SUB_DT : remaining;
      remaining -= h;
      const a = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    // Kill denormal ringing so idle frames are bit-stable for capture.
    if (Math.abs(this.value - this.target) < 1e-7 && Math.abs(this.velocity) < 1e-6) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * Three-layer response: a fast under-damped spring, a slow exponential
 * residual, and a CLIMB that holds while you keep firing.
 *
 * The first two were here from the start and they make one shot feel right:
 * recoil rises instantly, snaps most of the way back, then settles — a single
 * spring can only do two of those three.
 *
 * The third exists because the first two cannot make a SPRAY feel like
 * anything. Both recover continuously, so at 800 rpm each shot arrives into a
 * channel that has already given most of the last one back, and the sum reaches
 * equilibrium after about three rounds. Measured (`tools/kick.mjs`): the M4A1
 * peaked at 1.18 degrees of view climb over ten rounds — and at 1.18 degrees
 * over twenty-eight. The magazine did not exist as a shape.
 *
 * Meanwhile `defs.js` described a "hard vertical for the first five rounds",
 * a spray "you are meant to let go" of, and `ballistics` reported 15.4 degrees
 * of climb for the same weapon — because it sums the pattern ARRAY, which is
 * the impulses fired into this object, not what this object did with them. The
 * design, the documentation and the gate all agreed with each other about a
 * pattern that the player was never subject to.
 *
 * `climb` takes its share of every kick and does not decay at all until
 * `climbDelay` has passed with no new one. Set that longer than the fastest
 * cyclic interval in the game and holding the trigger accumulates, releasing it
 * recovers — which is the whole pull-down mechanic, and the reason a spray can
 * be learned rather than merely endured.
 */
export class RecoilAxis {
  /** Snapshot classification. The `*Share`/`*Tau` fields are tuning. */
  static snapshotState = ['spring', 'residual', 'climb', 'sinceKick', 'value'];
  static excludedState = ['residualTau', 'residualShare', 'climbTau', 'climbShare', 'climbDelay'];

  captureState(out = {}) {
    out.spring = this.spring.captureState(out.spring);
    out.residual = this.residual;
    out.climb = this.climb;
    out.sinceKick = this.sinceKick;
    out.value = this.value;
    return out;
  }

  restoreState(s) {
    this.spring.restoreState(s.spring);
    this.residual = s.residual;
    this.climb = s.climb;
    this.sinceKick = s.sinceKick;
    this.value = s.value;
  }

  constructor(freq = 9.5, damping = 0.52, residualTau = 0.3, residualShare = 0.34, climb = null) {
    this.spring = new Spring(freq, damping, 0);
    this.residual = 0;
    this.residualTau = residualTau;
    this.residualShare = residualShare;
    // Absent climb tuning means "no climb", so every existing axis — the roll
    // channels, the unused kick channels — keeps its two-layer behaviour.
    this.climb = 0;
    this.climbShare = climb?.share ?? 0;
    this.climbTau = climb?.tau ?? 0.3;
    this.climbDelay = climb?.delay ?? 0.1;
    this.sinceKick = 1e3;
    this.value = 0;
  }

  reset() {
    this.spring.reset(0);
    this.residual = 0;
    this.climb = 0;
    this.sinceKick = 1e3;
    this.value = 0;
  }

  /**
   * `amount` is an angle in radians (or metres for a positional axis).
   *
   * `share` overrides how much of it is held. Landing, damage and the jump kick
   * all arrive through the same axis and pass 0: they are one-off disturbances,
   * and a landing that left two degrees of permanent climb would be a recoil
   * pattern you paid for by walking off a crate.
   */
  kick(amount, share = this.climbShare) {
    const held = amount * share;
    const transient = amount - held;
    // A displacement kick reads snappier than a velocity kick for recoil.
    this.spring.value += transient * (1 - this.residualShare);
    this.residual += transient * this.residualShare;
    this.climb += held;
    this.sinceKick = 0;
  }

  step(dt) {
    this.spring.step(dt);
    this.residual = approach(this.residual, 0, this.residualTau, dt);
    this.sinceKick += dt;
    // Held, not decaying, until the trigger has actually been off for a moment.
    if (this.sinceKick >= this.climbDelay) {
      this.climb = approach(this.climb, 0, this.climbTau, dt);
    }
    this.value = this.spring.value + this.residual + this.climb;
    return this.value;
  }
}
