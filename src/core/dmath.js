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
