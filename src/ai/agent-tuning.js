/**
 * The numbers a bot is tuned by: how often it may trace, the ranges that switch
 * its posture, where it aims, the capsules it is hit on, and where its muzzle
 * sits.
 *
 * Split out of `agent.js` because that file is 2,300 lines of state machine and
 * these are the only lines in it anyone edits to change how the AI feels. The
 * machine did not move and cannot — every concern in it reads the same
 * blackboard — but the dials no longer live behind it.
 */

/**
 * Line-of-sight rays a bot may spend per tick looking for enemies.
 *
 * Two, not "all of them". The cheap range+cone filter usually leaves one or two
 * candidates anyway; the budget only bites in the pathological case of a whole
 * enemy team standing in one doorway, and there the cost of being a tick late
 * to the second man is far lower than the cost of sixteen bots each traversing
 * the BVH eight times every tick.
 */
export const LOS_PER_TICK = 2;

/**
 * The engagement envelope, in metres — how far from its target a bot wants to
 * fight from.
 *
 * These are the numbers that decide whether the AI plays the map or stands in
 * its own spawn, and the inherited values (7 to 30 m) did the latter. They were
 * tuned for a 120 m outdoor street where 30 m is mid-range; this depot is 36 m
 * deep, so "take cover 30 m from the enemy" resolves to "do not leave home".
 *
 * Measured, before the change: both teams held at an average of 31 m and traded
 * at a 0.032 rad cone — a ~1 m spread circle against a 0.35 m torso, roughly a
 * 3 % hit chance per round. Whichever side happened to edge forward won every
 * run 4-0, not because it was better but because it was the only one shooting
 * at anything it could hit.
 *
 * CLOSE is a little over the width of the centre hall's mouth and FAR is half
 * the map's long axis, so the band lands on the contested middle. Bots now have
 * to come out of their spawn court to satisfy it, which is the whole point of
 * building the map around one.
 */
export const ENGAGE_CLOSE = 4;
export const ENGAGE_FAR = 18;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * How far BELOW the head a bot aims, in metres. This one number is the bot
 * difficulty model, and it is a taste decision — change it here, nowhere else.
 *
 *  -0.05  the old value: the head plus five centimetres, biased toward the TOP
 *         edge of a 0.115 m head capsule. Every clean hit is lethal.
 *   0.28  neck and upper chest (shipped). A headshot is possible but is
 *         produced by wobble, by the target moving and by burst climb rather
 *         than by intent.
 *   0.38  mid chest. Measured at 0 headshots in 29 hits — too far. A headshot
 *         should be rare, not unreachable.
 *   0.60  belly. Noticeably softer; bots need most of a burst.
 *
 * `lastKnown` holds the target's HEAD (perception stores `seen.head`, and
 * `Combatant.head` is documented as the point bots shoot at), so this is a drop
 * from the head, not a rise from the feet. The comment here used to claim it
 * aimed at the chest while the code read `t.y + 0.05`.
 *
 * WHY IT MOVED, and how much of that is solid. Against a stationary player at
 * the shipped tempo, with the old aim point: 237 rounds fired, 100 landed, and
 * 84 of those 100 hit the HEAD. A head hit is 132 damage against 100 health
 * (`tools/hitbox.mjs` asserts it), so five rounds in six that connected were an
 * instant kill — a coin flip on who saw whom first rather than a difficulty
 * setting. Player movement does not soften that: it lowers the hit rate, not
 * the share of hits that land on the head, because the aim POINT is unmoved.
 *
 * At 0.28 the same measurement gives 1-3 % of damage on the head, and of actual
 * killing blows 10 of 50 were headshots — one death in five, the rest to
 * sustained torso fire.
 *
 * WHAT IS NOT SOLID, stated because the numbers above invite more precision
 * than they carry: the rig used for them is unstable. Whether the bots find a
 * stationary player at all varies enormously between runs — 63 rounds fired in
 * one, 630 in the next, and two runs produced no engagement whatsoever. Counts
 * of `damage:dealt` also over-report, because a penetrating round raises it more
 * than once (749 "hits" from 342 shots in one run), which is why the killing-blow
 * figure above is quoted from `combatant:death` instead. The 84 % -> 1-3 % shift
 * is an order-of-magnitude result and survives all of that. The choice between
 * 0.28 and 0.38 does not, and was made on feel.
 *
 * The rest of the difficulty model is elsewhere and was left alone: reaction
 * time and the perception cone in `_sense`, the burst pattern and cooldowns
 * below, and the wobble term applied right after this.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const AIM_DROP = 0.28;


export const HITBOXES = [
  ['head', 'Head', 'HeadTop', 0.098, 4.0],
  ['torso', 'Spine1', 'Neck', 0.185, 1.0],
  ['torso', 'Hips', 'Spine1', 0.175, 0.9],
  ['arm', 'UpperArmR', 'HandR', 0.072, 0.65],
  ['arm', 'UpperArmL', 'HandL', 0.072, 0.65],
  ['leg', 'UpLegR', 'FootR', 0.105, 0.7],
  ['leg', 'UpLegL', 'FootL', 0.105, 0.7],
];

/**
 * THE HAND-AUTHORED RAGDOLL SPEC IS GONE, and this note is what it left behind.
 *
 * A 22-row `DOLL` table lived here — per-bone radius, mass fraction, parent,
 * cone and twist — with a comment arguing that deriving our own spec "instead
 * of letting physics infer one from all 25 bones also gets the capsule radii
 * right, which is the difference between a body and a pancake."
 *
 * Nothing ever read it. It arrived in the port (8c43d0d) alongside
 * `createRagdollFromSkeleton`, which is what `_makeRagdoll` actually calls, and
 * that path runs `specFromSkeleton` with the UNIFORM `radiusRatio: 0.42`,
 * `cone: 74`, `twist: 38` handed to it below — precisely the inference the
 * comment said to avoid. So the table was dead on arrival and the argument was
 * describing a decision this repository never made.
 *
 * Recorded rather than silently deleted because the tradeoff is real and
 * unmeasured here: nothing gates ragdoll POSE quality. `crossengine` proves the
 * bones agree bit-for-bit across engines and `profile` proves they cost
 * nothing, and both would be just as green on a pancake. If corpses ever start
 * reading wrong, this is the knob, and the numbers are in the history.
 */

/**
 * Where a bot's round leaves it, in the agent's own yaw frame, metres.
 *
 * MEASURED, and measured twice — the first pass rotated into the wrong frame and
 * reported the muzzle wandering half a metre, which was an artefact of the
 * rotation and not anything the animator does. Fitting both candidate frames in
 * one run and taking the tighter (residual p50 0.335 m against 0.502 m) gives
 * `dx = right*cos + forward*sin`, `dz = -right*sin + forward*cos`, and in that
 * frame the weapon is very nearly a fixed mount:
 *
 *   right    p10 -0.1254  p50 -0.0867  p90 -0.0155   (spread 0.11 m)
 *   forward  p10  0.6164  p50  0.6321  p90  0.6475   (spread 0.03 m)
 *   up       crouch  p10 0.9790  p50 0.9965  p90 1.0196   (10.3% of samples)
 *            stand   p10 0.9887  p50 1.1655  p90 1.2330
 *
 * n = 5862-6300 over 900 live ticks. Medians, not means: the distributions are
 * skewed and a mean chases the tails. `crouch` is simulation state, so splitting
 * the one axis that actually moves costs nothing.
 */
export const MUZZLE = { right: -0.0867, forward: 0.6321, upStand: 1.1655, upCrouch: 0.9965 };
