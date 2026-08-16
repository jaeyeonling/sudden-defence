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
/* atan2                                                                   */
/* ---------------------------------------------------------------------- */
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
