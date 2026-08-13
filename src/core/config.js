/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

/**
 * `aoScale` — the resolution GTAO runs at, as a fraction of the render buffer.
 *
 * Half everywhere except `ultra`, because AO turned out to be the single most
 * expensive thing in the frame by a wide margin. Measured per feature at `q=high`
 * with `tools/abperf.mjs`, five pairs all agreeing on direction:
 *
 *   gtao off ............ -12.9 ms    <- more than a third of the frame
 *   volumetrics off .....  -4.7 ms
 *   ssr off .............  -3.6 ms     <- taken: `high` now ships ssr off, see
 *                                         the note on that key. Re-measured at
 *                                         -2.4 ms on a quiet machine.
 *   taa / motionBlur / bloom off ..... inside the noise
 *
 * It is 3 slices x 8 steps per pixel plus a temporal resolve and a two-pass blur,
 * all at full render resolution — 3024x1964 at DPR 2. Half resolution recovers
 * -7.3 ms of that 12.9 without turning the effect off, taking `q=high` from
 * 28.5 ms to 21.1 ms: 35 fps to 47 fps. The pixel cost is a diffuse softening of
 * the AO term — mean delta 0.8-1.8/255 across the nine gate shots, with no halo
 * at silhouettes, and the two captures are indistinguishable side by side.
 *
 * `ultra` keeps full resolution on purpose. Its job is to spend the frame, and
 * leaving one tier at maximum keeps this judgement checkable rather than merely
 * asserted.
 *
 * `low` has `gtao: false`, so its value is inert and kept only for uniformity.
 *
 * `shadowDistance` — 140 m and 200 m on a 48x36 m map, and MEASURED AS FINE.
 *
 * These numbers are inherited from a 120x120 m outdoor map and look obviously
 * wrong here: the hall's 3D diagonal is 60.3 m, so `ultra` spreads four cascades
 * over more than three times the distance that contains any geometry, and
 * `csm.js` splits with `lambda = 0.86`, which puts the first cascade at ~0.1-5.4 m
 * at f=140 against ~0.1-2.6 m at f=61. Twice the near-field texel density, for
 * free. It reads as a two-way win, so it was measured both ways and it is
 * neither:
 *
 *   cost .... `abperf --a="q=high" --b="q=high&q.shadowDistance=61"`, 4 pairs:
 *             +0.3 / -0.1 / 0 / 0 -> UNRESOLVED. Not cheaper, not dearer.
 *   pixels .. `sd200` vs `sd61`, magnified 2x at crate edges and doorway
 *             shadows (`tools/cropcmp.mjs`): no sharpening anywhere. What the
 *             diff actually is, is a uniform darkening of ~3/255 over 99.4 % of
 *             `boot.png` — a global shift, the shape auto-exposure absorbs, not
 *             a shadow-edge change.
 *
 * So the cascades are not where the shadow quality is decided here, and tying the
 * range to `world.bounds` (the tidy version of this change) would buy nothing
 * while adding a world->render coupling. Left alone deliberately. If the map ever
 * grows outdoors, re-measure rather than reasoning from the ratio again.
 */
export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    aoScale: 1.0,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    aoScale: 0.5,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    aoScale: 0.5,
    /**
     * OFF at the DEFAULT tier, and this is the one preset value here decided by
     * looking at the picture rather than by reasoning about the effect.
     *
     * Cost, re-measured on a quiet box — the earlier attempt sat UNRESOLVED
     * because a security agent was pinning a core through it:
     *
     *     abperf q=high vs q=high&q.ssr=0     -2.4 ms, 5/5 pairs agree
     *
     * That is 13 % of a 17.9 ms frame. What it buys, across the eleven baseline
     * shots, is a mean per-channel delta of 2.0/255. Two shots carry nearly all
     * of it — the spawn bays, 5.5-5.8 over 91-94 % of their pixels — and stacked
     * one above the other those two are indistinguishable: same floor, same
     * paint stripes, same weapon. Nothing in the frame is legibly different.
     *
     * For scale, the same comparison for volumetrics is 4.7 ms for a mean delta
     * of 24.7. Volumetrics costs twice as much and does twelve times as much,
     * and it stays. SSR is about six times worse per unit of picture, and in a
     * mode where the frame rate is the aim assist, 13 % is not a rounding error.
     *
     * `ultra` keeps it, so the effect is one flag away and the comparison stays
     * runnable. Re-derive with the two commands above before turning it back on.
     */
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    aoScale: 1.0,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  /**
   * `high`, not `ultra`, and this is a measurement rather than a taste.
   *
   * With `aoScale` in place the gap between the two tiers is 29.8 ms against
   * 21.1 ms — 34 fps against 47 — and essentially ALL of it is AO resolution,
   * which the two side-by-side captures could not be told apart on. Before
   * `aoScale` existed the same two tiers measured 29.6 and 28.5: a 4096 shadow
   * map instead of 2048, 200 m of shadow distance instead of 140, and double the
   * particle and decal budgets together bought 1.1 ms of frame time on a 48x36 m
   * map. Ultra's extras were never where the money went.
   *
   * A round-based shooter is decided by whether you saw someone first, so a
   * third of the frame rate is not a fair price for an AO buffer nobody can
   * resolve. `?q=ultra` is one query parameter away for anyone who wants it, and
   * `tools/baseline.mjs` pins its own tier so the pixel gate does not move when
   * this line does.
   */
  quality: 'high',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
  /**
   * Master rng seed, or `undefined` to draw one from `Math.random()` at boot.
   *
   * Separate from `deterministic` on purpose. That flag also suppresses
   * `ai.populate`, so before this existed the only reproducible world was an
   * empty one — and every measurement harness that compared two invocations was
   * silently comparing two different scenarios. See `Engine`'s constructor.
   */
  seed: undefined,
};

/**
 * Per-feature overrides on top of a preset, for attributing cost to ONE feature.
 *
 * The presets move five or six things at once, which makes them useless for the
 * question "what does GTAO cost". Measured across the four tiers the frame is
 * 29.6 / 28.5 / 17.9 / 3.8 ms: ultra to high is 1.1 ms despite doubling the shadow
 * map and adding 60 m of shadow distance, while medium to low is 14 ms and turns
 * off four passes at once. The bundles say the cost lives in the post chain and
 * refuse to say which part of it.
 *
 * An unknown key throws rather than being ignored — a typo that silently measures
 * nothing is worse than no measurement, because it comes back as a confident
 * "that feature is free".
 */
export function applyQualityOverrides(q, entries) {
  const applied = {};
  for (const [key, raw] of entries) {
    if (!(key in q)) throw new Error(`unknown quality key "${key}"`);
    const before = q[key];
    const value = typeof before === 'boolean'
      ? (raw === '1' || raw === 'true')
      : Number(raw);
    if (typeof before === 'number' && !Number.isFinite(value)) {
      throw new Error(`quality key "${key}" needs a number, got "${raw}"`);
    }
    q[key] = value;
    applied[key] = value;
  }
  return applied;
}

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
