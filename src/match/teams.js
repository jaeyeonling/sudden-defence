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
 * variant per team is the whole of friend/foe recognition: no outline shaders,
 * no nameplates, no extra draw calls, and it merges every bot on a side into the
 * same skinned material set.
 *
 * The cost is that a team looks uniform instead of varied, and that is the
 * correct trade. In a game where a wrong identification costs you the round, a
 * squad that reads as one silhouette in one colour is a feature — real units
 * wear the same uniform for the same reason. `irregular` (woodland) is left
 * unassigned and available for a third faction or a future mode.
 */

export const TEAMS = {
  alpha: {
    id: 'alpha',
    name: 'ALPHA',
    /** Cool. Matches `paint_alpha` on the depot floor at their end of the map. */
    color: 0x2f7ec0,
    camo: 'urban',
    variant: 'breacher',
  },
  bravo: {
    id: 'bravo',
    name: 'BRAVO',
    /** Warm. Matches `paint_bravo`. */
    color: 0xc4402a,
    camo: 'arid',
    variant: 'vanguard',
  },
};

export const TEAM_IDS = Object.keys(TEAMS);

/** The other side. Two-team game, so this is total. */
export function opposing(team) {
  return team === 'alpha' ? 'bravo' : 'alpha';
}
