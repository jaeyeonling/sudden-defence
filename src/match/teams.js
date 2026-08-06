/**
 * TEAMS — the two sides, and everything that has to be told them apart.
 *
 * One table, because a team's identity leaks into four unrelated places (spawn
 * selection, the killfeed, the match bar, and the camo the soldier generator
 * bakes into a bot's fatigues) and the fastest way to end up with a red team
 * that spawns on the blue side is to let each of those own its own idea of what
 * "bravo" means.
 *
 * `variant` is the AI soldier generator's existing build axis, and camo is baked
 * into it (vanguard/arid, irregular/woodland, breacher/urban). Pinning ONE
 * variant per team merges every bot on a side into the same silhouette and the
 * same skinned material set, which is worth having on its own: in a game where a
 * wrong identification costs you the round, a squad that reads as one shape is a
 * feature, and real units wear one uniform for the same reason. `irregular`
 * (woodland) is left unassigned for a third faction or a future mode.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE USED TO CLAIM, AND WHY IT WAS WRONG
 *
 * The variant split was described here as "the whole of friend/foe recognition:
 * no outline shaders, no nameplates, no extra draw calls". It was not, and the
 * claim survived as long as it did because nothing measured it. Staged at 9 m
 * and photographed (`tools/friendfoe.mjs`), wolf grey against tan separated by a
 * chromaticity distance of 0.0123 — against 0.100 for the floor paint two doors
 * away. Camo families cannot carry a team read, because both are calibrated into
 * the same 0.16-0.32 albedo window and that calibration is most of what stops a
 * procedural soldier looking like a toy.
 *
 * `color` is therefore no longer only a HUD colour. `ai` reads it back through
 * `AiSystem._accentFor` and dyes the uniform and paints the helmet and shoulder
 * flashes with it, so the man in the lane and the pip on the match bar are the
 * same blue. See TEAM_MARKER_GAIN in `ai/soldier.js` for why a bright marker was
 * needed rather than a stronger tint. The gate holds it at 0.100.
 */

export const TEAMS = {
  alpha: {
    id: 'alpha',
    name: 'ALPHA',
    /**
     * Cool. Matches `paint_alpha` on the depot floor at their end of the map,
     * the match bar pips, and — since `ai` reads this back — the uniform itself.
     */
    color: 0x2f7ec0,
    variant: 'breacher',
  },
  bravo: {
    id: 'bravo',
    name: 'BRAVO',
    /** Warm. Matches `paint_bravo`. */
    color: 0xc4402a,
    variant: 'vanguard',
  },
};

export const TEAM_IDS = Object.keys(TEAMS);

/** The other side. Two-team game, so this is total. */
export function opposing(team) {
  return team === 'alpha' ? 'bravo' : 'alpha';
}
