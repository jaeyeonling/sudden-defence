/**
 * Where a weapon's shots-to-kill actually steps — solved, not sampled.
 *
 * `tools/ballistics.mjs` has always printed shots-to-kill on a fixed grid of
 * 5 / 15 / 25 / 35 m. That grid answers "how lethal is this gun over there" and
 * it cannot answer the question the weapon table is actually tuned against,
 * which is "where does the four-round band CLOSE" — the MPX-9's band closes at
 * 15.8 m and the grid puts 15 on one side of it and 25 on the other, so the one
 * number the balance argument turns on was never visible in the output.
 *
 * It does not need to be sampled. Damage falloff is closed-form:
 *
 *     dmg(d) = damage * (1 - (1 - dropoff) * min(1, d / falloffRange)^2)
 *
 * so the largest distance at which `k` rounds still kill is the `d` where
 * `dmg(d) * mult == hp / k`, and that inverts directly.
 *
 * Kept in its own file because two tools need it and they must not drift:
 * `ballistics.mjs` reports the bands, and `botfight.mjs` scores the map's
 * measured engagement distances against them. A copy in each is a copy that
 * disagrees the first time the falloff model changes.
 */

/** The damage model physics applies, reproduced exactly. */
export function damageAt(def, d) {
  const range = def.falloffRange ?? def.maxRange;
  const r01 = Math.min(1, d / range);
  return def.damage * (1 - (1 - def.dropoff) * r01 * r01);
}

/**
 * The furthest distance at which `shots` rounds still kill.
 *
 * One consequence worth knowing before reading the output: with 100 HP and a
 * head multiplier of 4, the FOUR-round torso band and the one-tap head range are
 * the same distance, always. Both ask for 25 damage on the round. They are not
 * two facts that happen to agree — they are one fact, and a weapon change that
 * moves either moves both.
 *
 * @param mult 4 for a headshot, 1 for a torso hit.
 * @returns {number|null} metres, `Infinity` if the band never closes on any
 *   distance (the damage floor alone is enough), or `null` if the band is
 *   already shut at the muzzle.
 */
export function bandEdge(def, shots, { hp = 100, mult = 1 } = {}) {
  const need = hp / shots / mult; // damage per round required
  if (def.damage < need) return null; // cannot do it even point blank
  const range = def.falloffRange ?? def.maxRange;
  // r01^2 = (1 - need/damage) / (1 - dropoff)
  const denom = 1 - def.dropoff;
  // A weapon with no falloff at all never loses the band.
  if (denom <= 0) return Infinity;
  const r2 = (1 - need / def.damage) / denom;
  // Past `falloffRange` the curve is clamped, so if the band survives to the
  // clamp it survives everywhere the trace reaches.
  if (r2 >= 1) return Infinity;
  return range * Math.sqrt(r2);
}

/**
 * The full ladder: `[{ shots, to }]` from the fewest rounds upward, `to` being
 * the distance at which that many stops being enough.
 */
export function stkBands(def, { hp = 100, mult = 1, maxShots = 12 } = {}) {
  const out = [];
  for (let k = 1; k <= maxShots; k++) {
    const to = bandEdge(def, k, { hp, mult });
    if (to === null) continue; // k rounds never kills, even at the muzzle
    out.push({ shots: k, to });
    if (to === Infinity) break; // everything beyond is dominated
  }
  return out;
}

/** `4 shots to 15.8 m · 5 to 21.9 m · 6 to 26.5 m · 7 everywhere` */
export function formatBands(bands) {
  return bands
    .map((b, i) =>
      `${b.shots}${i === 0 ? ' shots' : ''} ` +
      (b.to === Infinity ? 'everywhere' : `to ${b.to.toFixed(1)} m`)
    )
    .join(' · ');
}
