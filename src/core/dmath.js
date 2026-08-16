/**
 * Deterministic spellings of math the spec leaves implementation-approximated.
 *
 * IEEE 754 pins `+`, `-`, `*`, `/` and `sqrt` to a correctly-rounded result, so
 * any expression built from only those five produces the same bits on every
 * engine. `Math.hypot` is NOT on that list — it is "implementation-approximated"
 * like the transcendentals, and V8/SpiderMonkey/JSC genuinely disagree on it.
 * `tools/crossengine.mjs` measured the consequence: with a pinned seed and a
 * clean control, the ONE leaf chromium and firefox disagreed on after 1200
 * driven ticks traced back through `speed` to a distance, i.e. to `hypot`.
 *
 * `hypot(x, y)` IS `sqrt(x*x + y*y)` up to two things:
 *
 *   overflow/underflow   `hypot` rescales so `hypot(1e200, 1e200)` is finite
 *                        where the naive square overflows to Infinity. Game
 *                        coordinates live within ±1e3 and speeds within ±1e2;
 *                        squares of those are nowhere near 1.8e308, so the
 *                        protection buys nothing here.
 *   the last bit         the naive spelling can be off by one ulp from the
 *                        infinitely-precise result where `hypot` (on SOME
 *                        engines) is closer. Determinism does not want "closer",
 *                        it wants THE SAME, and sqrt-of-squares is the same
 *                        everywhere by specification.
 *
 * These exist for the SIMULATION — the six subsystems whose state rewinds, plus
 * the level bake that feeds them. Presentation (`fx`, `render`, `ui`, `audio`,
 * `materials`) keeps calling `Math.hypot`: nothing there feeds captured state,
 * and a decal's distance check has no determinism contract to honour.
 */

/** `Math.hypot(x, y)`, spelled so every engine returns the same bits. */
export const hypot2 = (x, y) => Math.sqrt(x * x + y * y);

/** `Math.hypot(x, y, z)`, spelled so every engine returns the same bits. */
export const hypot3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** `Math.hypot(x, y, z, w)` — quaternion norms. Same argument. */
export const hypot4 = (x, y, z, w) => Math.sqrt(x * x + y * y + z * z + w * w);

/* ---------------------------------------------------------------------- */
/* exp / acos                                                              */
/* ---------------------------------------------------------------------- */
/*
 * Convicted by the measurement AFTER `sin`/`cos` were substituted and the
 * divergence did not move a single leaf — which acquitted them (V8's own
 * sin/cos are fdlibm-descended, and this span's inputs never hit a differing
 * bit on the other engines either) and pointed at the transcendentals still
 * running native in the diverging paths:
 *
 *   `exp`    `springs.approach` — the player's recoil springs, which are the
 *            exact leaves firefox diverges on (`recoilPitch.residual`,
 *            `aimForward[1]`, and the health those recoiling shots produce) —
 *            plus rigid-body damping and the ai suppression curves.
 *   `acos`   `ragdoll.js:442` — the `cone` angle whose sin/cos feed the
 *            Rodrigues rotation. webkit's corpse particles diverge with the
 *            same-engine control clean; the INPUT to the rotation differs, not
 *            the rotation.
 *
 * Both are fdlibm ports, pinned operations only, same contract as the rest of
 * this file. `dacos`'s upper branch needs one genuine bit operation — fdlibm
 * zeroes the low word of a double — done through an explicit-endianness
 * DataView, which is deterministic on every platform by specification.
 */
const EXP_P1 = 1.66666666666666019037e-01;
const EXP_P2 = -2.77777777770155933842e-03;
const EXP_P3 = 6.61375632143793436117e-05;
const EXP_P4 = -1.65339022054652515390e-06;
const EXP_P5 = 4.13813679705723846039e-08;
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;

const _bits = new DataView(new ArrayBuffer(8));
/** 2^k for integer k in the normal range, built by exponent surgery — exact. */
const pow2 = (k) => {
  _bits.setUint32(0, (1023 + k) << 20, false);
  _bits.setUint32(4, 0, false);
  return _bits.getFloat64(0, false);
};

/** fdlibm `exp(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const dexp = (x) => {
  if (Number.isNaN(x)) return NaN;
  if (x > 7.09782712893383973096e+02) return Infinity;
  if (x < -7.45133219101941108420e+02) return 0;
  let hi = 0, lo = 0, k = 0;
  const ax = x < 0 ? -x : x;
  if (ax > 0.5 * LN2_HI) {
    if (ax < 1.5 * LN2_HI) {
      k = x > 0 ? 1 : -1;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    } else {
      // fdlibm's `(int)` cast truncates toward zero — `Math.floor` here was one
      // octave off for every negative argument past 1.5·ln2.
      k = (INV_LN2 * x + (x > 0 ? 0.5 : -0.5)) | 0;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (ax < 3.725290298461914e-09) {
    return 1 + x; // 2^-28
  }
  const t = x * x;
  const c = x - t * (EXP_P1 + t * (EXP_P2 + t * (EXP_P3 + t * (EXP_P4 + t * EXP_P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  // 2^k scaling: subnormal results (k < -1021) go through two exact steps.
  if (k >= -1021) return y * pow2(k);
  return y * pow2(k + 1000) * pow2(-1000);
};

const PS0 = 1.66666666666666657415e-01;
const PS1 = -3.25565818622400915405e-01;
const PS2 = 2.01212532134862925881e-01;
const PS3 = -4.00555345006794114027e-02;
const PS4 = 7.91534994289814532176e-04;
const PS5 = 3.47933107596021167570e-05;
const QS1 = -2.40339491173441421878e+00;
const QS2 = 2.02094576023350569471e+00;
const QS3 = -6.88283971605453293030e-01;
const QS4 = 7.70381505559019352791e-02;
const PIO2_HI = 1.57079632679489655800e+00;
const PIO2_LO = 6.12323399573676603587e-17;

const acosR = (z) => {
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  return p / q;
};

/** A double with its low 32 bits zeroed — fdlibm's high-half split, exactly. */
const hiHalf = (x) => {
  _bits.setFloat64(0, x, false);
  _bits.setUint32(4, 0, false);
  return _bits.getFloat64(0, false);
};

/** fdlibm `acos(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const dacos = (x) => {
  if (Number.isNaN(x)) return NaN;
  if (x === 1) return 0;
  if (x === -1) return Math.PI + 2.0 * PIO2_LO;
  if (x > 1 || x < -1) return NaN;
  const ax = x < 0 ? -x : x;
  if (ax < 0.5) {
    if (ax < 1.1102230246251565e-16) return PIO2_HI + PIO2_LO; // 2^-53: acos(x) == π/2
    return PIO2_HI - (x - (PIO2_LO - x * acosR(x * x)));
  }
  if (x < 0) {
    const z = (1.0 + x) * 0.5;
    const s = Math.sqrt(z);
    const w = acosR(z) * s - PIO2_LO;
    return Math.PI - 2.0 * (s + w);
  }
  const z = (1.0 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = hiHalf(s);
  const c = (z - df * df) / (s + df);
  const w = acosR(z) * s + c;
  return 2.0 * (df + w);
};

/* ---------------------------------------------------------------------- */
/* log / pow                                                               */
/* ---------------------------------------------------------------------- */
/*
 * The last natives in the measured paths. After `exp`/`acos` went in, firefox
 * and webkit collapsed onto the SAME fifteen leaves — recoil springs, the
 * health they produce, and their downstream — and the only transcendental left
 * on that path is `Math.pow`: the view-kick curve (`pow(t, 0.72)`), the
 * speed-to-bob mapping, and the explosion damage falloff
 * (`pow(1 - d/r, 1.6)`), which is a grenade landing near the player.
 *
 * `dpow` is `dexp(y · dlog(x))` rather than a full fdlibm pow port. That
 * compounds to a couple of ulp instead of one, which behaviour gates cannot
 * see, and it is deterministic BY CONSTRUCTION, which is the property under
 * contract. The trade is documented: every call site this project has raises a
 * POSITIVE base to a real power; the special cases below cover the standard
 * identities and refuse (NaN) the negative-base-integer-exponent corner a full
 * port would honour, so a future caller who needs it finds a loud answer, not
 * a wrong one.
 */
const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;
const SQRT2 = 1.41421356237309514547;

/** fdlibm `log(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const dlog = (x) => {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  // frexp by bit surgery: x = m · 2^k with m in [1, 2)
  _bits.setFloat64(0, x, false);
  let hx = _bits.getUint32(0, false);
  let k = (hx >>> 20) - 1023;
  if (k === -1023) {
    // subnormal: renormalize through an exact 2^54 multiply
    _bits.setFloat64(0, x * 18014398509481984.0, false);
    hx = _bits.getUint32(0, false);
    k = (hx >>> 20) - 1023 - 54;
  }
  _bits.setUint32(0, (hx & 0x000fffff) | 0x3ff00000, false);
  let m = _bits.getFloat64(0, false);
  // fold [√2, 2) down so f = m − 1 stays small on both sides of 1
  if (m > SQRT2) { m *= 0.5; k += 1; }
  const f = m - 1.0;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t1 + t2;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
};

/**
 * `cosh(x)` as its exp definition — deterministic by construction.
 *
 * Convicted through the level BAKE, by the longest chain of this hunt. Seed 1's
 * corpses diverged cross-engine on QUIET-FALL ticks with every operation in the
 * ragdoll solver pinned — which forced the conclusion that the solver's INPUT
 * differed. The one input the state dump does not carry is the static world's
 * triangle soup, and the bake shapes tarps and cables with `Math.cosh`
 * catenaries. An engine-flavoured last bit in a triangle is invisible to every
 * captured leaf until a corpse lands on it.
 */
export const dcosh = (x) => {
  const e = dexp(x < 0 ? x : -x); // exp of the negative half avoids overflow order issues
  return (1 / e + e) * 0.5;
};

/**
 * `tan(x)` as the sin/cos ratio — ~2 ulp, deterministic by construction.
 *
 * Substituted at the player's spread cone (`weapons/index.js`), which is the
 * OTHER HALF of the seam the `gauss()` conviction closed: the bot half of
 * "where does a scattered round go" ran `log` inside Box–Muller, the player
 * half runs `tan` on the cone radius, and the span that convicted the first
 * never fired the second only because its constant command holds the trigger
 * up. fdlibm's own tan kernel would buy the last ulp back; the consumer adds
 * centimetres of deliberate scatter, so it would buy nothing measurable.
 */
export const dtan = (x) => dsin(x) / dcos(x);

/* ---------------------------------------------------------------------- */
/* quaternion construction                                                 */
/* ---------------------------------------------------------------------- */
/*
 * The door the call-site substitutions could not close. With every
 * `Math.sin`-family call in OUR code on dmath, the 3600-tick span still
 * diverged — bit-identical residue across five substitution generations — and
 * the trail traced it to a grenade whose throw origin is a POSED BONE.
 * `Quaternion.setFromEuler` and `setFromAxisAngle` run `Math.sin`/`Math.cos`
 * INSIDE three.js, so every bone the animator writes was still asking the
 * engine's libm which way the hand points.
 *
 * These are three.js's own formulas with the trig routed through dmath. They
 * take any object with a `set(x, y, z, w)` — dmath stays ignorant of THREE.
 * Euler orders cover what the simulation uses (XYZ everywhere today, YXZ for
 * the camera convention should it ever construct here); an unknown order
 * throws rather than guessing, loud over wrong.
 */
export const dquatFromEuler = (q, x, y, z, order = 'XYZ') => {
  const c1 = dcos(x / 2), s1 = dsin(x / 2);
  const c2 = dcos(y / 2), s2 = dsin(y / 2);
  const c3 = dcos(z / 2), s3 = dsin(z / 2);
  if (order === 'XYZ') {
    q.set(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3
    );
    return q;
  }
  if (order === 'YXZ') {
    q.set(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3
    );
    return q;
  }
  throw new Error(`dquatFromEuler: unsupported order "${order}"`);
};

/** `Quaternion.setFromAxisAngle` with dmath trig. Axis must be unit length. */
export const dquatFromAxisAngle = (q, axis, angle) => {
  const h = angle / 2;
  const s = dsin(h);
  q.set(axis.x * s, axis.y * s, axis.z * s, dcos(h));
  return q;
};

/** Deterministic `pow` for positive bases: `dexp(y · dlog(x))` + identities. */
export const dpow = (x, y) => {
  if (y === 0) return 1;
  if (x === 1) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN; // see the header note — loud, not wrong
  return dexp(y * dlog(x));
};
/*
 * `Math.atan2` has no cheap respelling — it is genuinely transcendental — so
 * this is the expensive kind of substitution the header distinguishes from
 * `hypot`: a fixed IMPLEMENTATION, ported so that every engine runs the same
 * arithmetic instead of its own libm.
 *
 * It is a port of fdlibm's `atan`/`atan2` (Sun Microsystems, the reference
 * most libms descend from): argument reduction onto [0, 7/16) against stored
 * high/low parts of atan(0.5), atan(1), atan(1.5), atan(inf), then an 11-term
 * odd polynomial. Every operation is `+ - * /` and comparison — all pinned by
 * IEEE 754 — so the result is bit-identical on every engine BY CONSTRUCTION,
 * and within ~1 ulp of the true value, which is the same accuracy class as the
 * libms it replaces. Behaviour gates cannot tell the difference; engines can.
 *
 * Why it exists: with the seed pinned and `hypot` respelled, the ONLY leaves
 * chromium and webkit disagreed on after 1200 driven ticks were `targetYaw` on
 * two agents — `Math.atan2(dx, dz)` in `agent._move`. V8 and SpiderMonkey
 * already agreed; JSC's atan2 is the odd one out, and this removes the vote.
 *
 * The reductions and constants are fdlibm's verbatim. Do not "simplify" the
 * `hi - ((poly - lo) - x)` shape: the high/low split of the table constants is
 * where the last bit of accuracy lives, and reassociating it changes the bits.
 */
const AT0 = 3.33333333333329318027e-01;
const AT1 = -1.99999999998764832476e-01;
const AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01;
const AT4 = 9.09088713343650656196e-02;
const AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02;
const AT7 = -5.83357013379057348645e-02;
const AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02;
const AT10 = 1.62858201153657823623e-02;
const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const PI_LO = 1.2246467991473531772e-16;

/** fdlibm `atan(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const datan = (x) => {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0 || Object.is(x, -0);
  let ax = neg ? -x : x;
  let id;
  if (ax >= 7.37869762948382064634e+19) {
    // 2^66: beyond this the polynomial's tail underflows out of the answer.
    const z = ATAN_HI[3] + 7.52316384526264005e-37;
    return neg ? -z : z;
  }
  if (ax < 0.4375) {
    if (ax < 3.725290298461914e-09) return x; // 2^-28: atan(x) == x to the bit
    id = -1;
  } else if (ax < 0.6875) { id = 0; ax = (2.0 * ax - 1.0) / (2.0 + ax); }
  else if (ax < 1.1875) { id = 1; ax = (ax - 1.0) / (ax + 1.0); }
  else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1.0 + 1.5 * ax); }
  else { id = 3; ax = -1.0 / ax; }
  const z = ax * ax;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r : r;
};

/* ---------------------------------------------------------------------- */
/* sin / cos                                                               */
/* ---------------------------------------------------------------------- */
/*
 * Convicted the same way `atan2` was, one measurement later. With the seed
 * pinned, the control clean and `hypot`/`atan2` already substituted, a
 * 3600-tick three-engine span (two deaths, a grenade in flight) left exactly
 * two families of divergence: the player hit differently on firefox (through
 * the bot aim wobble — `Math.sin(wobbleT)`), and corpse particles adrift on
 * webkit (through the ragdoll's Rodrigues rotation — `Math.cos(cone)`,
 * `Math.sin(cone)`). Damage falloff was read and cleared: pure pinned
 * arithmetic. Both remaining paths run the engine's own `sin`/`cos`.
 *
 * Same construction as `datan2`: fdlibm's kernels, verbatim constants, pinned
 * operations only. Argument reduction is Cody-Waite against a three-part π/2 —
 * fdlibm runs the later stages conditionally, for speed; this runs all three
 * every time, which is never less accurate and keeps the control flow flat.
 * The three-part reduction is exact for |x| well past 2^20; beyond that
 * accuracy degrades but DETERMINISM does not — every engine still runs the
 * same arithmetic. Simulation angles live within a few hundred radians.
 */
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** fdlibm __kernel_sin on [-π/4, π/4]; `y` is the reduction's low word. */
const ksin = (x, y, iy) => {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
};

/** fdlibm __kernel_cos on [-π/4, π/4]. */
const kcos = (x, y) => {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const ax = x < 0 ? -x : x;
  if (ax < 0.3) {
    const hz = 0.5 * z;
    const w = 1.0 - hz;
    return w + (((1.0 - w) - hz) + (z * r - x * y));
  }
  // fdlibm's qx: |x|/4 via an exponent decrement — x/4 is exact in binary — or
  // the constant 0.28125 once |x| passes 0.78125. Guards the 1-0.5z
  // cancellation.
  const qx = ax > 0.78125 ? 0.28125 : 0.25 * ax;
  const hz = 0.5 * z - qx;
  const a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
};

/** Cody-Waite reduction: writes y0/y1 into `out`, returns the octant n. */
const rempio2 = (x, out) => {
  const t = x < 0 ? -x : x;
  const n = Math.floor(t * INV_PIO2 + 0.5);
  const fn = n;
  // All three stages, unconditionally — see the header note.
  let r = t - fn * PIO2_1;
  let w = fn * PIO2_1T;
  let y0 = r - w;
  let tt = r;
  w = fn * PIO2_2;
  r = tt - w;
  w = fn * PIO2_2T - ((tt - r) - w);
  y0 = r - w;
  tt = r;
  w = fn * PIO2_3;
  r = tt - w;
  w = fn * PIO2_3T - ((tt - r) - w);
  y0 = r - w;
  const y1 = (r - y0) - w;
  if (x < 0) { out.y0 = -y0; out.y1 = -y1; return -n; }
  out.y0 = y0;
  out.y1 = y1;
  return n;
};
const _rp = { y0: 0, y1: 0 };

/** fdlibm `sin(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const dsin = (x) => {
  if (Number.isNaN(x) || x === Infinity || x === -Infinity) return NaN;
  const ax = x < 0 ? -x : x;
  if (ax <= Math.PI / 4) {
    if (ax < 7.450580596923828e-9) return x; // 2^-27: sin(x) == x to the bit
    return ksin(x, 0, 0);
  }
  const n = rempio2(x, _rp) & 3;
  if (n === 0) return ksin(_rp.y0, _rp.y1, 1);
  if (n === 1) return kcos(_rp.y0, _rp.y1);
  if (n === 2) return -ksin(_rp.y0, _rp.y1, 1);
  return -kcos(_rp.y0, _rp.y1);
};

/** fdlibm `cos(x)`. Bit-identical on every engine; ~1 ulp of the true value. */
export const dcos = (x) => {
  if (Number.isNaN(x) || x === Infinity || x === -Infinity) return NaN;
  const ax = x < 0 ? -x : x;
  if (ax <= Math.PI / 4) {
    if (ax < 7.450580596923828e-9) return 1;
    return kcos(x, 0);
  }
  const n = rempio2(x, _rp) & 3;
  if (n === 0) return kcos(_rp.y0, _rp.y1);
  if (n === 1) return -ksin(_rp.y0, _rp.y1, 1);
  if (n === 2) return -kcos(_rp.y0, _rp.y1);
  return ksin(_rp.y0, _rp.y1, 1);
};

/** fdlibm `atan2(y, x)`. Drop-in for `Math.atan2`, bit-identical everywhere. */
export const datan2 = (y, x) => {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const xNeg = x < 0 || Object.is(x, -0);
  const yNeg = y < 0 || Object.is(y, -0);
  if (x === 1.0) return datan(y);
  if (y === 0) return xNeg ? (yNeg ? -Math.PI : Math.PI) : y;
  if (x === 0) return yNeg ? -Math.PI / 2 : Math.PI / 2;
  if (x === Infinity) {
    if (y === Infinity) return yNeg ? -Math.PI / 4 : Math.PI / 4;
    return yNeg ? -0 : 0;
  }
  if (x === -Infinity) {
    if (y === Infinity || y === -Infinity) return yNeg ? -3 * Math.PI / 4 : 3 * Math.PI / 4;
    return yNeg ? -Math.PI : Math.PI;
  }
  if (y === Infinity || y === -Infinity) return yNeg ? -Math.PI / 2 : Math.PI / 2;
  const z = datan(Math.abs(y / x));
  if (!xNeg) return yNeg ? -z : z;
  return yNeg ? (z - PI_LO) - Math.PI : Math.PI - (z - PI_LO);
};
