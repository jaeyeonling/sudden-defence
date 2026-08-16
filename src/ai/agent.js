/**
 * AI — one enemy: body, senses, brain, gun.
 *
 * PERCEPTION is deliberately imperfect. A target has to be inside a 100 degree
 * cone, in line of sight through the physics BVH, and then *stay* there for a
 * reaction delay that scales with angle off-centre and distance before the
 * agent acknowledges it. Gunshots and footsteps arrive as events and only give
 * a direction, which becomes a "last known position" that decays — so enemies
 * search where you were, not where you are.
 *
 * BEHAVIOUR is a small state machine:
 *   idle / patrol -> alert -> combat -> suppressed -> flank -> retreat -> dead
 * Combat runs a peek-and-shoot loop from a scored cover point, with the squad
 * handing out permission to peek so they never all lean out at once, plus
 * suppressing fire, grenades and repositioning when the player stops moving.
 *
 * DAMAGE is per-bone: capsule colliders for head, chest, pelvis, arms and legs
 * are pushed into `physics` every frame, so a headshot is a headshot because of
 * where the round landed, not because of a random roll. Death hands the live
 * skeleton to the ragdoll solver with the bullet's impulse.
 */

import * as THREE from 'three';
import { RIG } from './rig.js';
import { Animator } from './animator.js';
import { datan2, dcos, dquatFromEuler, dsin, hypot2, hypot3 } from '../core/dmath.js';

const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  COMBAT: 'combat',
  SUPPRESSED: 'suppressed',
  FLANK: 'flank',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

export { STATE };

/**
 * Convert a WORLD yaw into an AI yaw.
 *
 * Two conventions live in this codebase and both are internally consistent,
 * which is precisely why the mismatch is invisible until something walks into a
 * wall:
 *
 *   world / player / weapons   forward = (-sin y, 0, -cos y)   yaw 0 faces -Z
 *   ai (everything below)      forward = ( sin y, 0,  cos y)   yaw 0 faces +Z
 *
 * They differ by exactly PI. `world.spawnPoints[].yaw` is authored in the world
 * convention — it has to be, the player reads the same table — so handing it to
 * an Agent unconverted spawns the entire roster facing its own back wall. Which
 * is what happened: the first bot-vs-bot run was a 4-0 sweep, because both teams
 * started with their backs to the map and the fight was decided by which side
 * turned around first.
 *
 * It lives HERE rather than in `ai/index.js` because there are now two places
 * that hand a world spawn to a bot — the garrison at boot and the round reset —
 * and a conversion that only one of them remembers to apply is a bug that shows
 * up in round 2 and not in round 1.
 */
export const aiYaw = (worldYaw) => worldYaw + Math.PI;

/**
 * Line-of-sight rays a bot may spend per tick looking for enemies.
 *
 * Two, not "all of them". The cheap range+cone filter usually leaves one or two
 * candidates anyway; the budget only bites in the pathological case of a whole
 * enemy team standing in one doorway, and there the cost of being a tick late
 * to the second man is far lower than the cost of sixteen bots each traversing
 * the BVH eight times every tick.
 */
const LOS_PER_TICK = 2;

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
const ENGAGE_CLOSE = 4;
const ENGAGE_FAR = 18;

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
const AIM_DROP = 0.28;


const HITBOXES = [
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
const MUZZLE = { right: -0.0867, forward: 0.6321, upStand: 1.1655, upCrouch: 0.9965 };

let _nextId = 1;

export class Agent {
  /**
   * Snapshot classification (netcode step 5). The largest object in the game,
   * and the one where "does this rewind" has the most interesting answers.
   *
   * TWO POINTERS AND A THIRD THAT LOOKS LIKE ONE.
   *   `target` is a Combatant and captures as its id.
   *   `cover` is a point owned by `CoverMap` and captures as its INDEX, because
   *   the points are baked with the level and their order is what makes an index
   *   a name. `CoverMap` restores the claim flags; this restores who is standing
   *   where, and the two have to agree or a bot holds cover nobody claimed.
   *   `squad`, `combatant`, `controller`, `colliders` and `ragdoll` all look
   *   like state and are excluded because something else owns them — the squad
   *   list, the match roster, `physics.characters`, `physics.colliders` and
   *   `physics.ragdolls` respectively. Capturing from both ends restores twice,
   *   and the second write wins for reasons nobody picked.
   *
   * `group` is the rendered transform. `position` is the simulated one, and the
   * group is copied from it — excluding the group and keeping the position is
   * the whole distinction this work is about.
   *
   * The perception block (`awareness`, `lastKnown`, `lastKnownAge`,
   * `suppression`, `reactionTimer`, `alertness`) is the most snapshot-critical
   * state here: `botfight` measured a bot in combat having any intent to fire
   * only 6-13% of the time, and every one of those numbers gates it.
   */
  static snapshotState = [
    'rng',
    // body / motion
    'position', 'yaw', 'targetYaw', 'velocity', 'grounded', 'speed', 'crouch',
    // life
    'health', 'alive', 'frozen', 'aliveTime', 'deadTime',
    // FSM
    'state', 'stateTime',
    // perception
    'awareness', 'hasTarget', 'targetVisible', 'target',
    'lastKnown', 'lastKnownAge', 'lastSeenAge', 'searchPoint',
    'suppression', 'reactionTimer', 'alertness',
    // gunplay
    'burstLeft', 'fireCooldown', 'burstCooldown', 'ammo', 'spread',
    'aimTarget', 'aimWeight', 'wantFire', 'huntAt',
    'peekSide', 'peeking', 'peekTimer', 'grenadeCooldown', 'hasGrenade',
    // navigation
    'path', 'pathLen', 'pathIndex', 'repathTimer', 'pathPending', '_pendingDest',
    'moveTarget', 'hasMoveTarget', 'desiredSpeed',
    'cover', 'coverPos', 'patrolIndex', 'patrolFails',
    'noGoalTime', 'noMoveTime', '_progressFrom',
    'huntTimer', 'hunting', 'holdTime', 'holdD0', 'holdSuppress',
    'stuckTimer', 'stuckCount', 'vaultCooldown',
    'clip', 'vaultFrom', 'vaultTo', 'vaultT',
    // the pose timelines — they decide which bone a round lands on
    'animator',
  ];
  static excludedState = [
    // wiring and identity
    'ai', 'ctx', 'id', 'isAgent', 'team', 'variantName', 'def', 'scale',
    // owned elsewhere
    'squad', 'combatant', 'controller', 'colliders', 'ragdoll', 'phys',
    // presentation. `lodIrrelevant` stays: it only gates shadows now.
    'bones', 'skeleton', 'mesh', 'group', 'skinnedMesh',
    'lodIrrelevant',
    // tuning, constant for the life of the agent
    'mass', 'height', 'radius', 'maxHealth', 'eyeHeight', 'viewRange', 'viewCos',
    'weaponRange', 'fireRate', 'magSize', 'weaponDamage', 'patrolPoints',
    // scratch
    '_cand', '_v', '_v2', '_v3', '_eye', '_dir', '_steer',
    '_boneA', '_boneB', '_muzzleDir', '_muzzleOrigin',
  ];

  captureState(out = {}) {
    const v3 = (v) => [v.x, v.y, v.z];
    out.rng = this.rng.captureState(out.rng);
    out.target = this.target ? this.target.id : null;
    // Index, not pointer. `-1` also covers "the point is not in the map any
    // more", which cannot happen today and would be silent if it did.
    // POSITION, not index. The index was documented here as the safe encoding
    // ("-1 covers 'not in the map any more'") and inside one process it is —
    // but `crossengine.mjs` caught its limit: the cover bake does not order
    // `points` identically across processes, so an index is a pointer wearing a
    // number. The position IS the point's identity: the bake derives everything
    // else from it, and an exact triple either finds the same piece of cover or
    // honestly fails to.
    out.cover = this.cover ? [this.cover.x, this.cover.y, this.cover.z] : null;

    out.animator = this.animator.captureState(out.animator);

    for (const k of Agent.snapshotState) {
      if (k === 'rng' || k === 'target' || k === 'cover' || k === 'animator') continue;
      const v = this[k];
      if (v && v.isVector3) out[k] = v3(v);
      else if (Array.isArray(v)) out[k] = v.map((e) => (e && e.isVector3 ? v3(e) : e));
      else out[k] = v;
    }
    return out;
  }

  /** `byCombatantId` resolves `target` — see the pointer note above. */
  restoreState(s, byCombatantId) {
    this.rng.restoreState(s.rng);
    this.target = s.target === null ? null : (byCombatantId?.get(s.target) ?? null);
    // Exact match only. A nearest-point fallback would resolve to a PLAUSIBLE
    // wrong object — the §2.1 failure shape — where a miss is at least loud.
    this.cover = s.cover === null || s.cover === undefined || typeof s.cover === 'number'
      ? null
      : (this.ai.cover.points.find(
          (pt) => pt.x === s.cover[0] && pt.y === s.cover[1] && pt.z === s.cover[2]
        ) ?? null);
    this.animator.restoreState(s.animator);

    for (const k of Agent.snapshotState) {
      if (k === 'rng' || k === 'target' || k === 'cover' || k === 'animator') continue;
      const cur = this[k];
      const v = s[k];
      // `vaultFrom`/`vaultTo` are null when no vault is in flight, so neither
      // side of this can assume the other is a vector: writing into a null
      // throws, and assigning the raw triple would leave a plain array where a
      // Vector3 belongs and break the lerp on the next tick instead of here.
      if (v === null || v === undefined) this[k] = v;
      else if (cur && cur.isVector3) cur.set(v[0], v[1], v[2]);
      else if (cur === null && Array.isArray(v) && v.length === 3 && typeof v[0] === 'number') {
        this[k] = new THREE.Vector3(v[0], v[1], v[2]);
      } else if (Array.isArray(cur)) {
        cur.length = 0;
        for (const e of v) cur.push(Array.isArray(e) ? new THREE.Vector3(e[0], e[1], e[2]) : e);
      } else this[k] = v;
    }
  }

  constructor(ai, opts = {}) {
    this.ai = ai;
    this.ctx = ai.ctx;
    this.id = _nextId++;
    // Simulation, and the largest population of them: perception timing, burst
    // cadence, reaction jitter and cover choice all draw from here.
    this.rng = ai.rng.fork({ snapshot: true });
    this.variantName = opts.variant ?? 'vanguard';
    const def = ai.variant(this.variantName);
    this.def = def;
    this.scale = def.variant.scale ?? 1;

    /* ---------------- body ---------------- */
    const { bones, skeleton, root } = RIG.createSkeleton();
    this.bones = bones;
    this.skeleton = skeleton;
    this.mesh = new THREE.SkinnedMesh(def.geometry, def.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.userData.agent = this;
    this.group = new THREE.Group();
    this.group.name = `enemy${this.id}`;
    this.group.add(root);
    this.group.add(this.mesh);
    this.mesh.bind(skeleton);
    this.group.scale.setScalar(this.scale);
    ai.root.add(this.group);

    /** Physics looks for these when it adopts the skeleton on death. */
    this.skinnedMesh = this.mesh;
    this.mass = 82 * this.scale;

    this.position = new THREE.Vector3().copy(opts.position ?? new THREE.Vector3());
    this.yaw = opts.yaw ?? 0;
    this.targetYaw = this.yaw;
    this.group.position.copy(this.position);
    // `dquatFromEuler`, not `.rotation.y =`. The Euler proxy converts through
    // THREE's setFromEuler, which is native sin/cos — and this quaternion is
    // the ROOT of every bone's matrixWorld, so its bits reach everything the
    // pose feeds, ragdoll birth included. The bake gets away with native trig
    // because walls sit at right angles, where every engine's sin/cos agree;
    // a bot's yaw is an arbitrary angle, which is exactly where they do not.
    dquatFromEuler(this.group.quaternion, 0, this.yaw, 0, 'XYZ');
    // The bones' world matrices are derived from the group's, so the group has
    // to be current before anything reads them — including the very first
    // animator pass and a same-frame ragdoll hand-off.
    this.group.updateMatrixWorld(true);

    this.animator = new Animator(RIG, bones, {
      weapon: def.weapon,
      // No `rng`. `Animator` assigns `opts.rng` to a field and never reads it
      // again — the fork that used to be here fed nothing, and drew a u32 off a
      // simulation stream to do it. `Animator` still accepts one (`?? null`) so
      // this is a deletion, not a signature change.
      scale: this.scale,
      probe: (x, z, fromY, out) => this.ai.probeGround(x, z, fromY, out),
    });

    /* ---------------- physics ---------------- */
    const phys = this.ctx.peek('physics');
    this.phys = phys;
    this.height = 1.78 * this.scale;
    this.radius = 0.34 * this.scale;
    this.controller = phys
      ? phys.createCharacter({
        id: `agent#${this.id}`,
        radius: this.radius,
        height: this.height,
        position: this.position,
        stepHeight: 0.42,
        slopeLimit: 48,
      })
      : null;
    this.velocity = new THREE.Vector3();
    this.grounded = true;

    this.colliders = [];
    if (phys) {
      for (const [part, a, b, r, dmg] of HITBOXES) {
        const c = phys.addCollider({
          shape: 'capsule',
          layer: phys.LAYER.ACTOR,
          surface: 'flesh',
          owner: this,
          part,
          radius: r * this.scale,
          damageScale: dmg,
        });
        c.userData = { a, b };
        this.colliders.push(c);
      }
    }

    /* ---------------- stats ---------------- */
    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.squad = opts.squad ?? null;
    /** Lets `match` and `ai.populate` tell a bot from the local player. */
    this.isAgent = true;
    /** 'alpha' | 'bravo'. `match` is the authority; this is a cached copy. */
    this.team = opts.team ?? 'bravo';
    /** Set by `ai` immediately after construction via match.register(). */
    this.combatant = null;
    /**
     * Freeze time. Set every frame by `AiSystem.update` from `match.frozen`, so
     * this file never has to know that a round system exists.
     */
    this.frozen = false;

    /* ---------------- perception ---------------- */
    this.eyeHeight = RIG.eyeHeight * this.scale;
    this.viewRange = 58;
    this.viewCos = dcos((100 * Math.PI) / 180 / 2);
    this.awareness = 0; // 0..1 build-up before the target is acknowledged
    this.hasTarget = false;
    this.targetVisible = false;
    /** The enemy Combatant we are engaging, not a position. Null when none. */
    this.target = null;
    /** Scratch for _sense: flat [combatant, distance] pairs. */
    this._cand = [];
    this.lastKnown = new THREE.Vector3();
    this.lastKnownAge = Infinity;
    /** Seconds since an enemy was last SEEN. Ears never touch this. */
    this.lastSeenAge = Infinity;
    this.searchPoint = new THREE.Vector3();
    this.suppression = 0;
    this.reactionTimer = 0;
    this.alertness = 0;

    /* ---------------- combat ---------------- */
    this.weaponRange = 60;
    this.fireRate = this.variantName === 'irregular' ? 8.2 : 10.5;
    this.burstLeft = 0;
    this.fireCooldown = 0;
    this.burstCooldown = this.rng.range(0.4, 1.4);
    this.magSize = 30;
    this.ammo = this.magSize;
    /**
     * ═══ THE OTHER HALF OF BOT DIFFICULTY, and the larger one ═══
     *
     * 0.026, tightened from 0.032 on the same "make them harder" request that
     * moved `weaponDamage`. Damage turned out to be the small lever and this is
     * the big one, which `tools/threat.mjs` is what established:
     *
     *   spread   hit % at 9 / 14 / 20 m     seconds to kill a stationary player
     *   0.032        38 / 19 / 10                 3.0 / 6.1 / 11.8
     *   0.026        51 / 27 / 15                 2.3 / 4.3 /  8.0
     *
     * A bot at the old value needed twelve seconds to kill a target that was
     * standing still at 20 m. Raising damage from 17 to 24 lifted its damage per
     * second by 40 % and left that curve looking much the same, because what
     * bounds it is how often a round arrives, not what the round does.
     *
     * Applied as a GAUSSIAN on the direction vector (see `_fireRound`), not as
     * the uniform disc the player's weapons use, and squashed to 0.8 vertically.
     * That matters: a Gaussian is far denser at the centre, so the nominal
     * radius understates how often bots land the middle.
     *
     * WHY THIS AXIS AND NOT MORE DAMAGE. Damage is capped at 24 by the one-tap
     * cliff — the head multiplier is 4, so 25 kills from full on any round that
     * strays onto the head, which `threat.mjs` now gates. Spread has no such
     * cliff and moves the opposite way: the aim point is 0.28 m BELOW the head
     * (`AIM_DROP`), so a tighter cone concentrates rounds on the upper chest and
     * makes head hits RARER. More dangerous, less random.
     *
     * WHAT IT DID TO BOT VS BOT, since they fight under the same number.
     * Four matchsims at 0.026 gave 2-2, 4-0, 1-4 and 0-5 — spread across both
     * sides with a draw among them, so no side is favoured — against six at
     * 0.032 giving 3-2, 2-2, 2-3, 4-0, 1-1, 3-2. Mean winning margin 3.0 versus
     * 1.17, and more rounds decided by elimination than by the clock.
     *
     * Small samples, and the direction is what the mechanism predicts rather
     * than a surprise: with no respawns, first blood already compounds, and
     * raising lethality makes it compound faster. Rounds ending in a fight
     * instead of a timeout is the good half of that. Worth watching if it is
     * pushed further; four matches is not a finding.
     */
    this.spread = 0.026;
    /**
     * ═══ BOT DIFFICULTY — the most consequential number in the game ═══
     *
     * 25, raised from 17 on request. Four rounds to kill you, which is exactly
     * what the player's own M4A1 needs to kill a bot: neither side carries a
     * lethality cushion any more, and the player's edge has to come from aim,
     * cover and positioning instead of from a longer health bar.
     *
     * Stated as damage rather than as aim error, deliberately: a bot that
     * misses is boring and a bot that hits softly is not.
     *
     * MEASURED, because this number had no instrument until it was changed.
     * `tools/threat.mjs` parks a live player in the open and times how long two
     * bots need to kill it — a floor, not a fight, so read it comparatively:
     *
     *              9 m           14 m
     *   17 dmg   0.10 s        0.50 s     (first hit -> death)
     *   25 dmg   see the tool
     *
     * The thing that measurement changed about this decision: at the ranges this
     * map produces, bots were ALREADY lethal — a stationary player died in under
     * a second either way. Damage is therefore the smaller half of "harder". The
     * bigger half is hit rate against a player who is MOVING, which is `spread`
     * (0.032 rad) and the reaction curve in `_sense`, and neither was touched
     * because `threat.mjs` uses a stationary target and cannot see them. Tuning
     * a number no harness can read is how every defect in this file got here.
     *
     * The other two knobs pull in different directions — `reactionTimer` (how
     * long before it shoots at all) and the burst timing in `_shoot`. Raise this
     * and lower the reaction time and you get a game about winning the first
     * exchange; do the reverse and you get one about trading and repositioning.
     *
     * Range falloff is applied at the fire site to the same curve the player's
     * rifle uses — see `AiSystem.onAgentFire`.
     */
    this.weaponDamage = 24;
    this.aimTarget = new THREE.Vector3();
    /** Where the quiet-round hunt believes the nearest enemy is. Drives facing
     *  while the hunt is holding still — see the facing block in `_move`. */
    this.huntAt = new THREE.Vector3();
    // `aimActual` used to live here. Assigned once at construction and read
    // nowhere in `src/` — the fifth dead field this work has turned up, found
    // the same way as the others: by having to say whether it rewinds.
    this.aimWeight = 0;
    this.wantFire = false;
    this.peekSide = 0;
    this.peeking = false;
    this.peekTimer = this.rng.range(0.5, 2.5);
    this.grenadeCooldown = this.rng.range(9, 22);
    this.hasGrenade = true;

    /* ---------------- navigation ---------------- */
    this.path = [];
    this.pathLen = 0;
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.moveTarget = new THREE.Vector3().copy(this.position);
    this.hasMoveTarget = false;
    this.desiredSpeed = 0;
    this.speed = 0;
    this.crouch = false;
    this.cover = null;
    this.coverPos = new THREE.Vector3();
    this.patrolPoints = opts.patrol ?? null;
    this.patrolIndex = 0;
    /** consecutive patrol waypoints this bot could not route to; see STATE.PATROL */
    this.patrolFails = 0;
    /** seconds spent wanting to move with nowhere to go; see _ensureGoal */
    this.noGoalTime = 0;
    /** seconds spent wanting to move without covering ground; see _ensureGoal */
    this.noMoveTime = 0;
    /** where the last real displacement was measured from */
    this._progressFrom = new THREE.Vector3();
    /** re-aim interval for the quiet-round hunt in PATROL (see that state) */
    this.huntTimer = 0;
    /** PATROL is converging on an enemy rather than walking its route. Drives
     *  the searching pace, which has to be re-asserted every frame. */
    this.hunting = false;
    /**
     * Mutual-pursuit hold-off bookkeeping (see the hold rule in PATROL).
     *
     * `holdTime` is how long this bot has been standing still waiting for a
     * lower-id enemy to close, and `holdD0` is how far away that enemy was when
     * the wait started. Holding is only correct while somebody is actually
     * closing, and nothing was checking that.
     */
    this.holdTime = 0;
    this.holdD0 = Infinity;
    /** Seconds left of "press regardless of id", after a hold went nowhere. */
    this.holdSuppress = 0;
    /** Seconds since this bot was last stood up by a round reset. */
    this.aliveTime = 0;
    this.stuckTimer = 0;
    /** Consecutive failed unstick attempts — escalates `_unstick`. */
    this.stuckCount = 0;
    this.vaultCooldown = 0;
    /** a path request the frame budget pushed to the next frame */
    this.pathPending = false;
    this._pendingDest = new THREE.Vector3();

    /* ---------------- LOD ---------------- */
    /** set by AiSystem._updateRelevance — gates SHADOWS only, never the pose */
    this.lodIrrelevant = false;

    /* ---------------- scratch ---------------- */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._steer = new THREE.Vector3();
    this._boneA = new THREE.Vector3();
    this._boneB = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();
    this._muzzleOrigin = new THREE.Vector3();

    this.clip = 'idle';

    // Death and vault state, declared here rather than on the first death and
    // the first vault. The snapshot audit reported all five absent, and these
    // are the sharp version of that problem rather than the mild one: a capture
    // taken before a bot had ever vaulted could not restore a vault in progress,
    // so a replay would drop the bot mid-ledge. `respawn` already writes
    // `deadTime = undefined`, which keeps the key — it was only ever missing on
    // an agent that had not yet died once.
    // `vaultTo` null means no vault is in flight, and that is now the ONLY
    // thing `_driveVault` asks — see the note there. `reset()` already disarmed
    // a vault mid-flight by writing null here, so this is the encoding the file
    // was already using, made load-bearing on purpose rather than by accident.
    this.deadTime = undefined;
    this.vaultT = undefined;
    this.vaultFrom = null;
    this.vaultTo = null;
    /** Owned by `physics.ragdolls`; this is the back-reference. */
    this.ragdoll = null;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  get eye() {
    return this._eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /**
   * SIMULATION. Runs on `ai`'s fixed tick, never on the render frame.
   *
   * Everything here decides what the bot IS: timers, perception, the state
   * machine, movement, fire control. It sees a fixed `dt` whatever the frame
   * rate is doing, which is the difference between a bot that plays the same on
   * a fast machine and a slow one — and the precondition for a server ever
   * running this loop authoritatively.
   *
   * Presentation lives in `present()`.
   */
  simulate(dt, _ctx) {
    if (!this.alive) return;
    this.stateTime += dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.55);
    this.fireCooldown -= dt;
    this.burstCooldown -= dt;
    this.grenadeCooldown -= dt;
    this.peekTimer -= dt;
    this.repathTimer -= dt;
    this.vaultCooldown -= dt;
    if (this.lastKnownAge < 1e6) this.lastKnownAge += dt;
    // Seconds since this bot last SAW an enemy, as opposed to last learned
    // anything about one.
    //
    // `lastKnownAge` is reset by ears as well as eyes — `_onHeard` pulls it down
    // to 0.35 for any footstep inside its loudness radius — and using it to
    // decide whether the round has gone quiet makes two survivors who can hear
    // each other permanently "well informed". `tools/converge.mjs` traced the
    // consequence: a pair seeded 12 s stale, so hunting at t=0, was disarmed by
    // the first footstep four seconds later and did not hunt again until t=28,
    // spending the interval wandering to bearings at ALERT's 1.5 m/s.
    //
    // Hearing gives a direction, not a position. It is exactly the situation the
    // hunt exists for, so it must not be what cancels it.
    if (this.lastSeenAge < 1e6) this.lastSeenAge += dt;
    this.aliveTime += dt;

    // `hunting` is decided HERE, not inside the PATROL case.
    //
    // It used to be computed in PATROL, which meant it was only ever true while
    // the bot was already in PATROL — and the two things that consume it are
    // both outside: `_onHeard` (which must not drag a hunting bot into ALERT)
    // and ALERT's own exit. So a bot that got into ALERT could never learn that
    // it ought to be hunting, and ALERT is a state footsteps keep resetting.
    //
    // `tools/converge.mjs` traced the result exactly: two bots 44 m apart closed
    // to 32.2 m in twelve seconds and then held that gap for the remaining
    // SEVENTY-THREE, both in ALERT the whole time, each walking to the other's
    // noise bearing at 1.5 m/s and neither ever seeing anything. The gap did not
    // move by more than 0.6 m after t=12.
    //
    //   stale  had contact, lost it nine seconds ago — the endgame case
    //   dry    nobody has seen anything and the round is half a minute old
    //
    // `hasTarget` vetoes both: a bot that can see its enemy is fighting, not
    // searching, and letting COMBAT read as hunting would suppress ALERT for the
    // one bot that has no use for it.
    // KNOWN INTERACTION WITH `TEMPO.live`, left as it is on purpose.
    //
    // `aliveTime` is reset every round, so at any tempo with `live <= 30` the
    // second clause can never become true inside a round and the dry-round
    // convergence is unreachable: a bot that never sees anybody never hunts.
    // That sounds like a defect and was treated as one — the threshold was
    // rewritten to scale with the round length and measured over 40 rounds at
    // live = 45 and 3 at live = 28. It did not pay: rounds over 20 s quiet went
    // 3/13 -> 2/30, but worst-case quiet rose 25.5 -> 31.6 s, median quiet went
    // 4.4 -> 9.5 s, and eliminations fell 35% -> 25%, all inside the noise of
    // those sample sizes. At the shipped live = 120 the scaled form is a no-op
    // by construction, so there was nothing to gain and a behaviour change to
    // lose. Reverted.
    //
    // The reading that makes the constant defensible: on a very short round,
    // patrolling the WHOLE round is not a failure to converge, it is the cover
    // discipline this threshold exists to protect (see the 5-0-in-22.7 s rout
    // that arming from the bell produced). Change it only with a measurement
    // that beats the numbers above, not on the argument that 30 > live.
    this.hunting =
      !this.hasTarget &&
      ((Number.isFinite(this.lastSeenAge) && this.lastSeenAge > 9) || this.aliveTime > 30);

    // a path the frame budget deferred: ask again before anything else does
    if (this.pathPending) this._goTo(this._pendingDest);

    // Perception keeps running through freeze time on purpose. A bot that spent
    // the freeze blind would step into the round with zero awareness and lose
    // the opening duel to a player who spent it watching a doorway — which is
    // the wrong asymmetry, since the player is not blindfolded either. What
    // freeze takes away is the ability to act, not to look.
    this._sense(dt);
    if (this.frozen) {
      this._hold();
    } else {
      this._think(dt);
      this._ensureGoal(dt);
      this._move(dt);
      this._shoot(dt);
    }
    // Root motion is simulation: a vault MOVES the body, and driving it from the
    // render frame would make how far a bot travels depend on frame rate.
    this._driveVault(dt);
    // The pose and the hitboxes welded to it, in that order, after everything
    // above has decided where the body is and what it is doing. Once presentation
    // — but a hit capsule on an animated bone means the pose decides which bone a
    // round lands on, and that rewinds with the world.
    this._drive(dt);
    this.syncHitboxes();
  }

  /**
   * THE POSE IS SIMULATION and there is no `present()` any more. It read as
   * presentation only for as long as nothing consumed it, but `syncHitboxes`
   * welds the hit capsules to the animated bones, so the pose decides where
   * damage lands. `simulate()` drives it on the tick; this note stays because
   * "the animator is presentation" was load-bearing in three prior commit
   * messages, and whoever greps for it should find the reversal, not silence.
   */

  /**
   * Freeze time: stand still, hold fire, keep the FSM where it is.
   *
   * Movement intent is cleared rather than merely ignored. A bot that kept a
   * claimed cover point and a solved path across the freeze would break for it
   * on the first live frame, having decided where to go before the round it is
   * going there for existed.
   */
  _hold() {
    this.wantFire = false;
    this.burstLeft = 0;
    this.hasMoveTarget = false;
    this.path.length = 0;
    this.pathLen = 0;
    this.pathIndex = 0;
    this.pathPending = false;
    this.velocity.x = 0;
    this.velocity.z = 0;
    this.speed = 0;
    this.crouch = false;
  }

  /* ================================================================== */
  /* perception                                                         */
  /* ================================================================== */

  /**
   * Look for enemies.
   *
   * The version this came from asked `ai.playerPosition()`: there was exactly
   * one thing in the level worth shooting and its address was hardcoded. In a
   * team game the question becomes "which of several", and answering it honestly
   * costs one line-of-sight ray per candidate per bot per tick — sixteen bots
   * against eight enemies is 128 BVH traversals a tick, most of them
   * re-confirming something that has not moved since the last one.
   *
   * So the work is staged. Range and view cone first: pure arithmetic, no rays,
   * and it rejects most of the roster on a map this size. Then a small fixed ray
   * budget spent on the nearest survivors, current target first. The result is
   * that a bot can be a tick late noticing a SECOND enemy but is never late
   * noticing the one it is already fighting — which is the right way round. You
   * lose a duel to the man in front of you, not to the man behind him.
   */
  _sense(dt) {
    // A target that died stops being a target the same frame. Nothing else in
    // the FSM checks, and a bot holding an angle on a corpse is the loudest
    // possible tell that the AI is not really playing.
    if (this.target && !this.target.alive) {
      this.target = null;
      this.hasTarget = false;
      this.awareness = 0;
    }

    const enemies = this.ai.enemiesOf(this);
    if (!enemies.length) {
      this.targetVisible = false;
      this.awareness = Math.max(0, this.awareness - dt * 0.35);
      return;
    }

    const eye = this.eye;
    // Peripheral vision widens once alerted.
    const cone = this.hasTarget ? -0.2 : this.viewCos - this.alertness * 0.25;
    const fx = dsin(this.yaw);
    const fz = dcos(this.yaw);

    // ---- cheap pass: who is even plausible? ----
    // Flat [combatant, distance] pairs in a reused array: one allocation at
    // construction, none per tick.
    const cand = this._cand;
    cand.length = 0;
    for (let i = 0; i < enemies.length; i++) {
      const c = enemies[i];
      const h = c.simHead;
      const dx = h.x - eye.x;
      const dy = h.y - eye.y;
      const dz = h.z - eye.z;
      const dist = hypot3(dx, dy, dz);
      if (dist > this.viewRange) continue;
      // Inside 4.5 m you notice someone regardless of where you were looking.
      if (dist >= 4.5) {
        const inv = 1 / (dist || 1e-6);
        if ((fx * dx + fz * dz) * inv <= cone) continue;
      }
      cand.push(c, dist);
    }

    // ---- expensive pass: rays, nearest first, current target first of all ----
    let seen = null;
    let seenDist = Infinity;
    for (let n = 0; n < LOS_PER_TICK; n++) {
      let bi = -1;
      let bd = Infinity;
      for (let i = 0; i < cand.length; i += 2) {
        if (cand[i] === null) continue;
        if (n === 0 && this.target && cand[i] === this.target) { bi = i; break; }
        if (cand[i + 1] < bd) { bd = cand[i + 1]; bi = i; }
      }
      if (bi < 0) break;
      const c = cand[bi];
      const d = cand[bi + 1];
      cand[bi] = null; // probed
      if (this.phys && !this.phys.lineOfSight(eye, c.simHead, this.phys.MASK.SIGHT)) continue;
      if (d < seenDist) {
        seen = c;
        seenDist = d;
      }
    }

    this.targetVisible = !!seen;

    if (seen) {
      // reaction: fast head-on and close, slow at the edge of vision
      const rate = 1 / Math.max(0.12, 0.16 + seenDist * 0.0075 + (1 - this.alertness) * 0.28);
      this.awareness = Math.min(1, this.awareness + dt * rate);
      this.lastKnown.copy(seen.simHead);
      this.lastKnownAge = 0;
      // The only place `lastSeenAge` is reset. See `update` for why the hunt
      // needs a clock that ears cannot touch.
      this.lastSeenAge = 0;
      this.alertness = 1;
      if (this.awareness >= 1) {
        this.hasTarget = true;
        this.target = seen;
      }
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35);
      if (this.hasTarget && this.lastKnownAge > 6.5) {
        this.hasTarget = false;
        this.target = null;
      }
    }
  }

  /** A gunshot or footstep heard from `pos` with a given loudness (metres). */
  hear(pos, loudness) {
    if (!this.alive) return;
    const d = this.position.distanceTo(pos);
    if (d > loudness) return;
    const strength = 1 - d / loudness;
    this.alertness = Math.max(this.alertness, Math.min(1, 0.35 + strength));
    if (this.lastKnownAge > 1.2 || strength > 0.6) {
      this.lastKnown.copy(pos);
      this.lastKnownAge = Math.min(this.lastKnownAge, 0.35);
    }
    // hearing alone never grants a target; it turns the head and the body
    this.awareness = Math.min(0.85, this.awareness + strength * 0.5);
    // A HUNTING bot is not pulled out by a noise.
    //
    // ALERT walks to a bearing; the hunt walks to the enemy. Swapping the second
    // for the first is a downgrade, and because footsteps arrive continuously it
    // is a downgrade that repeats: two survivors inside earshot oscillated
    // PATROL -> ALERT -> PATROL for a whole round, each chasing the other's
    // noise, and `tools/converge.mjs` caught them 31.6 m apart after 40 s with
    // `lastSeen` never rising above 1.1 s — permanently well-informed and
    // permanently unable to close.
    //
    // The noise still lands: `lastKnown` is updated above and that is what
    // eventually feeds COMBAT. Only the state change is suppressed.
    if (!this.hunting && (this.state === STATE.IDLE || this.state === STATE.PATROL)) {
      this._setState(STATE.ALERT);
    }
  }

  /** Rounds cracking past raise suppression, which drives the flinch + duck. */
  suppress(amount) {
    if (!this.alive) return;
    this.suppression = Math.min(1.6, this.suppression + amount);
    this.alertness = 1;
  }

  /* ================================================================== */
  /* behaviour                                                          */
  /* ================================================================== */

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    if (s !== STATE.COMBAT && s !== STATE.SUPPRESSED) this.peeking = false;
  }

  _think(dt) {
    switch (this.state) {
      case STATE.IDLE:
        this.desiredSpeed = 0;
        this.crouch = false;
        if (this.hasTarget) this._enterCombat();
        else if (this.patrolPoints && this.stateTime > 2.5) this._setState(STATE.PATROL);
        break;

      case STATE.PATROL: {
        this.crouch = false;
        // The hunt's pace has to be re-asserted every frame, not set once.
        //
        // `desiredSpeed = 3.2` used to live inside the `huntTimer <= 0` branch,
        // which fires for one frame every 2.5-4 s — and this line, at the top of
        // PATROL, put it straight back to 1.35 on the very next frame. So the
        // "searching pace" the comment below describes was a single frame of
        // 3.2 m/s followed by three seconds of strolling, and the whole
        // convergence ran at patrol speed. Over the 12.5 m gap `botfight` was
        // failing on, that is 9 s of walking instead of 4.
        // (`hunting` itself is decided once per tick in `update` — see there for
        // why it cannot live in this case block.)
        // Two ways in, and they are not the same situation.
        //
        // `stale`: this bot HAD contact and lost it nine seconds ago. That is
        // the endgame case — go and re-find them.
        //
        // `dry`: nobody on this bot's side has ever seen anything and the round
        // is half a minute old. That is the stalled-round case, and it needs its
        // own condition because `lastKnownAge` starts at Infinity, which passes
        // any "> n" test. Arming on that alone meant every bot hunted from the
        // opening bell: `botfight` produced a 5-0 rout in 22.7 s with the losing
        // side dealing ZERO damage, because both teams sprinted at each other in
        // straight lines and the first side to resolve line of sight shot five
        // men standing in the open. A patrol is what puts bots in cover before
        // contact; it has to be allowed to happen first.
        //
        // 30 s is comfortably past the ordinary time-to-contact on this map
        // (measured 27-50 s to a full elimination, so first contact lands well
        // inside it) and comfortably short of a 45 s round's end.
        this.desiredSpeed = this.hunting ? 3.2 : 1.35;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // Converge once the round goes quiet.
        //
        // A patrol route is a loop, and two survivors on disjoint loops never
        // meet: measured in botfight, the last alpha and the last bravo ended
        // 22 m apart with no line of sight, 66 s since either had seen anything,
        // both walking their own circuit at 1.35 m/s until the clock ran out.
        // Roughly one round in five died that way, which is also most of why
        // matchsim rounds were ending on `time` rather than on elimination.
        //
        // So after fifteen seconds of nobody seeing anybody, head for the
        // nearest living enemy instead of the next waypoint, and move at a
        // searching pace rather than a strolling one. This is not omniscience:
        // it only steers, and the bot still has to acquire the target through
        // the ordinary perception cone before it can shoot. It also cannot
        // trigger during a firefight, because `lastKnownAge` is small then.
        // 9 s, not 15.
        //
        // ALERT gives up walking to `lastKnown` at `lastKnownAge > 8` and drops
        // to PATROL, and PATROL used to wait until 15 before it went looking. In
        // the seven seconds between, a bot that had just lost a fight had no
        // plan at all: it resumed a patrol route made of ITS OWN TEAM'S SPAWN
        // POINTS, which does not merely fail to find the enemy, it walks away
        // from them.
        //
        // Caught by `tools/botfight.mjs` when the map gained the cover that
        // stops the two spawn courts seeing each other: 5-a-side stopped
        // reaching elimination inside 110 s, and the dump showed the last two
        // men 12.5 m apart with no line of sight — one in ALERT at
        // lastKnownAge 10.3, sitting in the gap, the other in PATROL at 29.1
        // hunting correctly. Nine puts the hunt one second past the moment ALERT
        // declares its own information stale, so the two thresholds are adjacent
        // by construction rather than by luck.
        //
        // It still cannot fire during a firefight: nine seconds without anyone
        // seeing anyone is not a firefight, and this only steers — the bot has
        // to acquire through the ordinary perception cone before it can shoot.
        if (this.hunting) {
          // The nearest enemy is needed EVERY hunting frame, not only when the
          // re-aim timer fires: the hold-off rule below has to be evaluated
          // continuously or the two bots spend most of each 2.5-4 s interval
          // with no opinion about which of them is pressing.
          let best = null;
          let bestD = Infinity;
          for (const en of this.ai.enemiesOf(this)) {
            const d = this.position.distanceTo(en.position);
            if (d < bestD) { bestD = d; best = en; }
          }
          if (best) this.huntAt.copy(best.position);

          this.huntTimer -= dt;
          if (this.huntTimer <= 0) {
            this.huntTimer = this.rng.range(2.5, 4);
            // Try the enemy, then points short of them.
            //
            // `_goTo` returns false when A* finds no route, and the destination
            // being unreachable does not make the ENEMY unreachable — it usually
            // means the one cell they are standing in is cut off. That happens
            // for real: they may be on a container roof, or on one of the small
            // nav islands the edge validation in `nav.js` correctly severs from
            // the floor (`tools/reach.mjs` counts 55 of them, mostly wall and
            // container tops).
            //
            // Walking to a point a few metres short is almost as good — the
            // whole purpose is to close the distance until perception can do its
            // job — so step back along the line and try again before giving up.
            //
            // Giving up must NOT fall through to the patrol block below. That is
            // what it used to do, and a patrol route on this map is made of the
            // bot's OWN spawn points: a failed solve sent the hunter home. It is
            // how `tools/converge.mjs` caught a pair that started 20 m apart and
            // finished 29.3 m apart, the presser walking briskly in the wrong
            // direction the entire time. Standing still is worse than closing
            // and far better than retreating.
            if (best) {
              let sent = this._goTo(best.position);
              for (const back of [2, 4, 6]) {
                if (sent) break;
                const dx = this.position.x - best.position.x;
                const dz = this.position.z - best.position.z;
                const len = hypot2(dx, dz) || 1;
                if (len <= back) break;
                this._v2.set(
                  best.position.x + (dx / len) * back,
                  this.position.y,
                  best.position.z + (dz / len) * back
                );
                sent = this._goTo(this._v2);
              }
              // Nothing solved from here — so the problem is HERE.
              //
              // A* failing for every destination including points 2, 4 and 6 m
              // short of the enemy does not mean the enemy is unreachable, it
              // means this bot is standing somewhere the graph cannot leave. The
              // fix above (hold rather than fall through to a patrol waypoint,
              // which on this map means walking home) turned that into a
              // permanent freeze: no move target, so `speed` is 0, and the stuck
              // detector only arms at `speed > 0.5` — a bot too stuck to move is
              // by definition not "stuck".
              //
              // `tools/converge.mjs` traced fifty seconds of it, both survivors
              // reading `patrol hunting=true moving=false 0.0`, one of them
              // standing in the footprint of the 0.8 m mid crate at (3.1, 0).
              //
              // `_unstick` is the right escalation because it acts on the body
              // rather than on the route, and its last step snaps to a cell the
              // nav grid has certified — which is exactly what a bot that cannot
              // path from where it stands needs.
              if (!sent) this._unstick();
              break;
            }
          }

          // Close in, one at a time.
          //
          // Two bots both hunting each other both re-path to the other's LIVE
          // position every 2.5-4 s, and with a container between them that locks
          // into an orbit: each walks to where the other just was, they pass on
          // opposite sides of the same piece of cover, and the phase never
          // breaks. `tools/converge.mjs` reproduces it exactly — after 40 s the
          // pair is 9.4 m apart, both `hunting`, both `moving`, neither has ever
          // seen the other.
          //
          // Mutual pursuit needs an asymmetry and the bots have no way to
          // negotiate one, so it is taken from the id: the higher id stops and
          // holds while the lower closes. A stationary target is one a
          // pathfinder can actually reach, and no phase lock survives one of the
          // two standing still.
          //
          // AT ANY RANGE, not inside 12 m. The first version had that limit and
          // it fixed the small orbit (two men circling one container) while
          // leaving the large one: with the centre of the map blocked, two bots
          // on opposite diagonals each route around the middle, both pick the
          // same way round, and they chase each other along a ring at equal
          // speed. `tools/converge.mjs` traced a pair holding 32.2 m for 73
          // consecutive seconds that way — never closing, never separating,
          // both `hunting`, both `moving`.
          //
          // This cannot deadlock the whole roster: for any pair the lower id
          // presses, so the globally lowest id always presses somebody. And the
          // id is arbitrary but STABLE and identical on both sides of the
          // comparison, which is the entire requirement — both bots reach the
          // same conclusion about which of them moves, without talking. It also
          // happens to be reasonable behaviour: one man holds the angle while
          // the other pushes it.
          // ...but only while somebody is actually closing.
          //
          // "For any pair the lower id presses, so the globally lowest id always
          // presses somebody" assumes the presser CAN press. It cannot always:
          // a bot wedged against the centre block fails A* for the enemy and for
          // every fallback point short of it, holds position by the rule above
          // this one, and then every other bot on the map — all of whom have the
          // wedged bot as their nearest enemy — holds waiting for it. `botfight`
          // caught the whole roster frozen that way: four survivors, all
          // `hunt=true moving=false spd 0`, the lowest id standing at (2.0, -0.8)
          // inside the block's footprint and 2.2 m from an enemy it could not
          // see. Nobody moved for the remaining 79 s.
          //
          // A deadlock needs a liveness condition, not a better tie-break. So
          // the hold is conditional on progress: wait, but if the gap has not
          // closed by a metre in HOLD_PATIENCE seconds, conclude the presser is
          // not coming and press instead. HOLD_RELEASE is long enough to cross
          // the map at searching pace so the two do not just swap roles and
          // deadlock again one interval later.
          //
          // This is deliberately a property of the WAITER rather than a repair
          // for the wedge itself. The wedge is one way a presser stalls; a bot
          // that dies, gets suppressed, or picks a route around the long side is
          // another, and a rule that only survives the failure it was written
          // for is not a rule.
          const HOLD_PATIENCE = 6;
          const HOLD_PROGRESS = 1.0;
          const HOLD_RELEASE = 20;
          // MEASURED ASYMMETRY, left in place. `_nextId` is a creation counter,
          // so which side presses is correlated with team: on the standard
          // 5-a-side roster the ids come out alpha [1,2,3,8,9] against bravo
          // [4,5,6,7,10] and alpha closes on 17 of 25 cross-team pairs (68%),
          // not the even split "arbitrary but stable" implies. Holding an angle
          // is an advantage, so that is a small standing handicap.
          //
          // Replacing the id with a hash was tried and is NOT a fix: with five
          // fixed ids a side, every deterministic rank bakes in some fixed
          // lopsided split, and the hash landed on 20% — further from even than
          // the ids it replaced. A real fix has to balance by construction (rank
          // within team, alternating which side wins by index) rather than hope
          // a scramble spreads five numbers evenly.
          //
          // Not done, because the harm is undemonstrated, and the second
          // measurement argues against the reasoning as well as the size:
          //
          //   20 botfights            alpha  7 / bravo 13        n.s.
          //   40 rounds, matchsim     alpha 24 / bravo 14 / 2 draws
          //     --noplayer            p ~ 0.14 on the 38 decided — n.s.
          //
          // "Holding an angle is an advantage" predicts the side that holds more
          // wins more. Alpha presses 68% of pairs and took 24 of 38, so the only
          // two samples there are point the other way and neither reaches
          // significance. The asymmetry is real; the handicap is not evidenced.
          // `tools/botfight.mjs` reports `pressShare` every run so the number is
          // visible rather than argued about. Change this with a measurement,
          // not a hunch — and measure the win rate, not just the split.
          const other = best?.host;
          this.holdSuppress = Math.max(0, this.holdSuppress - dt);
          if (other && this.id > other.id && this.holdSuppress <= 0) {
            // Re-baseline on progress; do not snapshot it once.
            //
            // The first version set `holdD0` when the hold began and never moved
            // it, so the release test — "has the gap closed by a metre" — went
            // false forever the moment the presser closed one metre at ANY point.
            // A single metre bought unlimited patience. `tools/converge.mjs`
            // caught it on lane-vs-lane: the presser walked in from far out,
            // stalled at 6.8 m, and the holder stood still for the remaining 40 s
            // because the metre it was owed had been paid long before.
            //
            // Sliding the window makes this what it was meant to be — a watchdog
            // on CONTINUING progress, not on progress ever having happened.
            if (bestD < this.holdD0 - HOLD_PROGRESS) {
              this.holdD0 = bestD;
              this.holdTime = 0;
            } else if (this.holdTime <= 0) {
              this.holdD0 = bestD;
            }
            this.holdTime += dt;
            if (this.holdTime > HOLD_PATIENCE) {
              // Nobody is coming. Take over the press and do not re-enter the
              // hold for a while, or the pair alternates who waits.
              this.holdTime = 0;
              this.holdD0 = Infinity;
              this.holdSuppress = HOLD_RELEASE;
              // Re-path on the next tick, and BREAK rather than falling through.
              // The hunt solve lives earlier in this same case block, so it has
              // already run for this frame; falling through instead would reach
              // the patrol-waypoint block below with `hasMoveTarget` false and
              // take a waypoint — and a patrol route on this map is made of this
              // bot's own spawn points, so the frame it finally decides to press
              // is the frame it would set off home.
              this.huntTimer = 0;
              break;
            } else {
              this.desiredSpeed = 0;
              this.hasMoveTarget = false;
              break;
            }
          } else {
            this.holdTime = 0;
            this.holdD0 = Infinity;
          }
        }

        // a route point whose path is still queued is not a route point reached:
        // taking the next one here would walk the patrol index forward for free
        if (this.pathPending) break;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.1) {
          const p = this.patrolPoints?.[this.patrolIndex % this.patrolPoints.length];
          if (p) {
            this.patrolIndex++;
            if (this._goTo(p)) this.patrolFails = 0;
            // A route this bot cannot walk is not a route. There are three patrol
            // points, so a bot whose whole circuit is unreachable re-solves the
            // same three every three frames, for ever, with `desiredSpeed` set
            // and `hasMoveTarget` false — it stands where it is at a walking
            // pace it never uses. Measured once at 111 s motionless, which from
            // the player's side is a statue.
            //
            // After a full unsuccessful lap, go somewhere the grid says is
            // actually connected. That is worse cover discipline than the
            // authored route and better than not playing.
            else if (++this.patrolFails >= this.patrolPoints.length) {
              this.patrolFails = 0;
              const spot = this.ai.grid?.randomMainPoint(this.rng, this._pendingDest);
              if (spot) this._goTo(spot);
            }
          } else this._setState(STATE.IDLE);
        }
        break;
      }

      case STATE.ALERT: {
        this.crouch = false;
        this.desiredSpeed = 1.5;
        if (this.hasTarget) {
          this._enterCombat();
          break;
        }
        // move to the last known position, then look around
        if (this.lastKnownAge < 8 && !this.hasMoveTarget) this._goTo(this.lastKnown);
        // Leave when the INFORMATION goes stale, not only when the clock runs
        // out. ALERT means "I know roughly where somebody was and I am acting on
        // it"; past `lastKnownAge > 9` that is no longer true, and sitting here
        // until `stateTime > 12` is a bot standing over a cold trail because a
        // separate timer has not finished. Worse, `_onHeard` re-enters ALERT and
        // resets `stateTime`, so two survivors who can hear each other but not
        // see each other could hold this state indefinitely — which is what
        // `botfight` kept catching as a 1-v-2 at the 110 s bell.
        //
        // PATROL is where the hunt lives (see that state), so this hands them
        // straight to the code that goes and looks.
        // `|| this.hunting` is the one that matters when the two survivors can
        // hear each other: footsteps hold `lastKnownAge` near zero and re-enter
        // ALERT from PATROL, so neither of the other two conditions can ever
        // fire and the bot investigates bearings until the round ends.
        if (this.stateTime > 12 || this.lastKnownAge > 9 || this.hunting) {
          this._setState(this.patrolPoints ? STATE.PATROL : STATE.IDLE);
        }
        break;
      }

      case STATE.COMBAT:
        this._combat(dt);
        break;

      case STATE.SUPPRESSED:
        this.crouch = true;
        this.desiredSpeed = 0;
        this.wantFire = false;
        this.peeking = false;
        if (this.suppression < 0.45) this._setState(STATE.COMBAT);
        break;

      case STATE.FLANK: {
        this.crouch = false;
        this.desiredSpeed = 4.4;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2 || this.stateTime > 7) {
          this._setState(STATE.COMBAT);
          this.cover = null;
        }
        if (this.suppression > 1.0) this._setState(STATE.COMBAT);
        break;
      }

      case STATE.RETREAT: {
        this.crouch = false;
        this.desiredSpeed = 4.6;
        this.wantFire = false;
        if (!this.hasMoveTarget || this.position.distanceTo(this.moveTarget) < 1.2) {
          this._setState(STATE.COMBAT);
        }
        if (this.health > 45 && this.stateTime > 4) this._setState(STATE.COMBAT);
        // Retreat is a burst, not a condition.
        //
        // The two exits above are "I got where I was going" and "I have
        // recovered", and in a round-based game the second one can never fire:
        // health regen was removed with the respawn loop, so a bot that breaks
        // contact below 45 HP stays below it for the rest of the round. If it
        // also fails to reach its destination — snagged on a crate, or handed a
        // point the character controller cannot quite stand on — it runs at 4.6
        // m/s forever. Measured in botfight: one run in six ended with a bravo
        // survivor 39 s into a retreat, no target, while two alphas patrolled
        // past it; that is most of why rounds were expiring on the clock rather
        // than on elimination.
        //
        // Eight seconds at 4.6 m/s is 37 m, which crosses the whole 48x36 hall.
        // Anything longer is not a retreat, it is a bot that has stopped
        // playing, and the right thing is to put it back in the fight.
        if (this.stateTime > 8) this._setState(STATE.COMBAT);
        break;
      }
    }

    if (this.suppression > 1.15 && this.state === STATE.COMBAT && this.cover) {
      this._setState(STATE.SUPPRESSED);
    }
  }

  _enterCombat() {
    this._setState(STATE.COMBAT);
    this.cover = null;
    this.repathTimer = 0;
  }

  _combat(dt) {
    const target = this.hasTarget ? this.lastKnown : this.lastKnownAge < 5 ? this.lastKnown : null;
    if (!target) {
      this._setState(STATE.ALERT);
      return;
    }
    const sq = this.squad;
    const dist = this.position.distanceTo(target);

    // wounded and outgunned: fall back
    if (this.health < 34 && this.stateTime > 1.5 && this.rng.float() < dt * 0.5) {
      const away = this._v
        .copy(this.position)
        .sub(target)
        .setY(0)
        .normalize()
        .multiplyScalar(9)
        .add(this.position);
      if (this._goTo(away)) {
        this._setState(STATE.RETREAT);
        return;
      }
    }

    // no cover yet, or the current one no longer protects: find one
    if (!this.cover || this.repathTimer <= 0) {
      const pick = this.ai.cover?.pick(this.position, target, {
        id: this.id,
        squad: sq?.members,
        minRange: ENGAGE_CLOSE,
        maxRange: ENGAGE_FAR,
        maxTravel: this.cover ? 10 : 22,
      });
      this.repathTimer = this.rng.range(2.2, 4.5);
      if (pick && pick !== this.cover) {
        this.cover = pick;
        this.coverPos.set(pick.x, pick.y, pick.z);
        this._goTo(this.coverPos);
      }
    }

    // A cover point we cannot actually reach must not mute the agent for ever.
    // `_goTo` fails outright when A* finds no route (which happens for a cover
    // point across an unwalkable seam), and a path can also run out short of the
    // point. The branch below reads "has cover, not standing in it" as "walk,
    // weapon down, hold fire", so without this the agent stands in the open with
    // the player in plain sight and never pulls the trigger.
    if (
      this.cover &&
      !this.hasMoveTarget &&
      !this.pathPending && // still queued behind the frame's A* budget
      this.position.distanceTo(this.coverPos) > 0.85
    ) {
      this.cover = null;
      this.ai.cover?.release(this.id);
      this.repathTimer = Math.min(this.repathTimer, 0.6);
    }

    const atCover = this.cover
      ? this.position.distanceTo(this.coverPos) < 0.85
      : false;

    if (this.cover && !atCover) {
      // moving into position: run, weapon down, no shooting
      this.desiredSpeed = 4.3;
      this.crouch = false;
      this.wantFire = false;
      // `peeking` is only recomputed in the other branch, so leaving it alone
      // here leaves a stale `true` on a bot that is sprinting with its weapon
      // down. Nothing acted on it, but it reads as a contradiction to anything
      // that looks — `tools/botfight.mjs` dumped `peeking=true visible=true
      // wantFire=false` and it took reading both branches to see that the flag
      // was simply out of date rather than the fire condition being broken.
      this.peeking = false;
      this.aimWeight = 0.35;
    } else {
      this.desiredSpeed = 0;
      this.hasMoveTarget = false;
      // peek-and-shoot, gated by the squad so they alternate
      const allowed = !sq || sq.requestPeek(this, dt);
      if (this.peekTimer <= 0) {
        this.peeking = allowed && this.targetVisible !== false;
        this.peekTimer = this.peeking ? this.rng.range(1.1, 2.4) : this.rng.range(0.7, 1.8);
        if (this.peeking && this.cover) {
          this.peekSide = this.ai.cover.peekOffset(this.cover, target, this.eyeHeight, this._v2);
          this.coverPos.copy(this._v2);
        }
      }
      this.crouch = this.cover ? !this.cover.high || !this.peeking : false;
      this.aimWeight = this.peeking ? 1 : 0.55;
      this.wantFire = this.peeking && this.targetVisible && this.hasTarget && dist < this.weaponRange;
      /**
       * Suppressing fire at a spot the bot has ACQUIRED and momentarily cannot
       * see. Not at a noise.
       *
       * The `hasTarget` gate is the whole scope of it, and the comment here used
       * to read "even without a clean shot", which describes something broader
       * than what runs. A bot that only HEARD an enemy has a fresh `lastKnown`
       * and `awareness` still climbing, so `hasTarget` is false and neither this
       * nor `wantFire` above ever fires — measured in `tools/botfight.mjs`, that
       * state is 29-35 % of all COMBAT time, with `lastKnownAge` a median 1.3 s
       * and `awareness` a median 0.11.
       *
       * Which is to say: for a third of a firefight a bot was holding a position
       * it believed an enemy was at, with the weapon silent. Widened on request.
       *
       * WHAT THAT STATE ACTUALLY IS, since "no target" sounds like the bot knows
       * nothing: `_sense` drops the target and zeroes `awareness` the frame its
       * man dies, while `lastKnown` keeps being refreshed by the gunfire around
       * it. So it is a bot whose opponent just went down or broke contact,
       * standing in a firefight it can still hear. Putting rounds into that is
       * what a person would do, and it is the difference between cover that is
       * safe and cover that is merely cover.
       *
       * TWO RATES, not one. An acquired target the bot has momentarily lost
       * sight of is a better guess than a noise, so it keeps the original 0.35
       * and the unacquired case gets 0.2. Both still require a fresh belief
       * (`lastKnownAge < 2.2`) and the bot to be leaning out, so this adds
       * volume to a peek that was already happening rather than a new behaviour.
       *
       * WATCH THE TEAM KILLS. Blind fire toward a believed position is the one
       * change here that can put a round through a team-mate crossing the line;
       * `tools/botfight.mjs` fails on any team kill and is the check. Ten fights
       * after the change: zero.
       *
       * ── AND IT IS NOT THE DIFFICULTY CHANGE IT WAS EXPECTED TO BE ──────────
       *
       * Measured after the fact, and kept because it makes the code match the
       * intent its comment always described, not because it moved a number.
       *
       * The choice to widen this rested on a breakdown of why a bot holds fire
       * that said "no target" was a third of the cause. That breakdown was a
       * PRIORITY CHAIN — `if (!hasTarget) ... else if (moving) ... else if
       * (!peeking)` — so every sample that was target-less AND not peeking
       * landed wholly in the first bucket. It read like independent causes and
       * was not. Counted independently, across three fights:
       *
       *     not peeking 70-92% · no sight 66-78% · repositioning 27-37%
       *     no target 23-36% · stale belief 12-21%      (they overlap)
       *     blocked by the target gate ALONE: 2-6%
       *
       * Two to six per cent, at a 0.2 rate, is about one per cent of combat
       * time. Ten botfights before and after are indistinguishable, which is
       * exactly what that arithmetic predicts.
       *
       * THE BOTTLENECK IS `peeking` AND `targetVisible`. A bot is silent
       * overwhelmingly because it is behind cover, not because it does not know
       * where the enemy is. Anything that wants bots meaningfully more dangerous
       * has to touch the peek rotation or the cover discipline in `_combat`, and
       * that changes what the game feels like rather than how hard it is.
       */
      if (!this.wantFire && this.peeking && this.lastKnownAge < 2.2) {
        this.wantFire = this.rng.float() < (this.hasTarget ? 0.35 : 0.2);
      }
    }

    // flank when the player has been static and we have friends shooting
    if (
      sq &&
      this.stateTime > 4 &&
      this.grenadeCooldown < 0 === false &&
      sq.canFlank(this) &&
      this.rng.float() < dt * 0.25
    ) {
      const side = this.rng.float() < 0.5 ? 1 : -1;
      const perp = this._v.copy(target).sub(this.position).setY(0).normalize();
      const flank = this._v2
        .set(-perp.z * side, 0, perp.x * side)
        .multiplyScalar(this.rng.range(8, 15))
        .add(this.position)
        .addScaledVector(perp, 4);
      if (this._goTo(flank)) {
        this.cover = null;
        this.ai.cover?.release(this.id);
        this._setState(STATE.FLANK);
        sq.claimFlank(this);
        return;
      }
    }

    // grenade when the player is pinned and we have line of fire
    if (
      this.hasGrenade &&
      this.grenadeCooldown <= 0 &&
      dist > 8 &&
      dist < 26 &&
      this.lastKnownAge < 1.5 &&
      (!sq || sq.requestGrenade(this))
    ) {
      this._throwGrenade(target);
    }
  }

  /* ================================================================== */
  /* movement                                                           */
  /* ================================================================== */

  _goTo(dest) {
    const grid = this.ai.grid;
    if (!grid) {
      this.moveTarget.copy(dest);
      this.hasMoveTarget = true;
      return true;
    }
    const n = this.ai.requestPath(this.position, dest, this.path);
    if (n < 0) {
      // The frame's A* budget is spent. Hold the destination and retry on the
      // next frame instead of failing outright: `_combat` reads a failed _goTo as
      // "that cover point is unreachable" and drops it.
      this._pendingDest.copy(dest);
      this.pathPending = true;
      return false;
    }
    this.pathPending = false;
    if (n === 0) {
      this.hasMoveTarget = false;
      return false;
    }
    this.pathLen = n;
    this.pathIndex = 0;
    this.moveTarget.copy(this.path[n - 1]);
    this.hasMoveTarget = true;
    return true;
  }

  /**
   * Liveness: wanting to move is not the same as having somewhere to go.
   *
   * Every state sets `desiredSpeed` from what it intends, and `_move` turns that
   * into velocity only when there is a waypoint. When a state sets a speed and
   * fails to produce a destination, the two disagree and NOTHING NOTICES: the
   * bot stands at `speed` 0, and the unstick machinery in `_move` cannot help
   * because it only arms on `lastMoveBlocked && speed > 0.5` — a bot that never
   * starts moving is never blocked.
   *
   * Measured with `tools/botfight.mjs`, which now records the state at the worst
   * moment rather than only its length. Every long stall had the same signature
   * and none of the short ones did:
   *
   *   11.2 s patrol   speed 0     desired 3.2  moveTarget false  stuckCount 0
   *   11.9 s patrol   speed 0.36  desired 3.2  moveTarget true   stuckCount 0
   *   57.6 s combat   speed 0     desired 3.2  moveTarget false  stuckCount 0
   *    1.5 s combat   speed 4.3   desired 4.3  blocked true      stuckCount 2
   *
   * The last row is the unstick path working as intended on a bot genuinely
   * shoving at geometry. The first three never reach it.
   *
   * A guard here rather than a repair in each state, because the states that can
   * produce it are not a closed set — PATROL with an unroutable circuit was one,
   * ALERT solving to a stale last-known position is another, and the next one
   * will be written by somebody who never reads this file. The contradiction is
   * what is checkable, and it is checkable in one place.
   *
   * It cannot fire on a deliberate hold: holding an angle (see the mutual-pursuit
   * rule in PATROL) and shooting from cover both set `desiredSpeed = 0`, so they
   * never enter the count.
   */
  _ensureGoal(dt) {
    if (this.desiredSpeed <= 0.1) {
      this.noGoalTime = 0;
      this.noMoveTime = 0;
      this._progressFrom.copy(this.position);
      // Holding on purpose is not being stuck, so the escalation history goes
      // too. This and the displacement branch below are the only two places
      // `stuckCount` is cleared now — both of them mean "this bot is fine".
      this.stuckCount = 0;
      return;
    }

    // (1) Wants a speed and has nowhere to go.
    if (!this.hasMoveTarget && !this.pathPending) this.noGoalTime += dt;
    else this.noGoalTime = 0;

    // (2) Wants a speed, HAS somewhere to go, and is not getting anywhere.
    //
    // Checked on displacement rather than on any of the flags, because the flags
    // are what keep being wrong. A first version of this rescued only case (1)
    // and the gate still caught a 13.6 s stall; the obvious next suspect was A*
    // budget starvation, since `pathPending` skips the check — measured, and it
    // was not that either (`pathsDeferred` is 2 per run against a budget of 8 a
    // frame). Rather than keep guessing at mechanisms, this asserts the outcome:
    // a bot that asked to move and has not moved is broken, whatever the reason,
    // and the recovery is the same in every case.
    if (this.position.distanceTo(this._progressFrom) > 0.35) {
      this._progressFrom.copy(this.position);
      this.noMoveTime = 0;
      // Covered ground: whatever had it wedged is behind it.
      this.stuckCount = 0;
    } else this.noMoveTime += dt;

    // 1.5 s for a missing goal — a frame or two between "I want to move" and
    // "here is the path" is normal. 3 s for no progress, which is generous: a
    // squadmate stepping across a doorway costs a fraction of a second, and the
    // local avoidance in `_move` resolves head-on pairs deterministically.
    if (this.noGoalTime < 1.5 && this.noMoveTime < 3) return;
    this.noGoalTime = 0;
    this.noMoveTime = 0;
    this._progressFrom.copy(this.position);
    // Both halves of the recovery: `_unstick` acts on the body (it side-steps),
    // `randomMainPoint` acts on the plan. Re-solving to the same destination is
    // what `_unstick`'s own doc comment records as a loop rather than a fix.
    const grid = this.ai.grid;

    // NO BODY TELEPORT HERE, and it was tried twice.
    //
    // A bot stranded on a crate cannot be re-planned off it: every route from a
    // one-cell island fails at the first step, so the recovery below picks a new
    // destination, fails, and picks another for as long as the round lasts.
    // `tools/botfight.mjs` caught one at 20.9 s. The obvious answer was to pick
    // the body up and put it back on the floor, and that answer is wrong.
    //
    // It took `tools/converge.mjs` from 10/10 to 3/10. `grid.nearest` resolves a
    // bot standing in a doorway or a gap behind a crate to a pocket cell often
    // enough to matter, so healthy bots were being lifted out of staged trials
    // mid-run. Raising the bar to four consecutive failed recoveries did not fix
    // it — the false positives are not rare, they are just quiet.
    //
    // The real fix was upstream and is in `_tryVault`: a landing outside the
    // played region is no longer accepted, so a bot does not get onto the crate
    // in the first place. Displacing a body is the most invasive thing this file
    // could do, and it turned out not to be needed at all.
    this._unstick();
    const spot = grid?.randomMainPoint(this.rng, this._pendingDest);
    if (spot) this._goTo(spot);
  }

  _move(dt) {
    const wp = this.hasMoveTarget && this.pathIndex < this.pathLen ? this.path[this.pathIndex] : null;
    this._steer.set(0, 0, 0);
    let want = 0;

    if (wp) {
      const to = this._v.copy(wp).sub(this.position);
      to.y = 0;
      const d = to.length();
      if (d < (this.pathIndex === this.pathLen - 1 ? 0.45 : 0.75)) {
        this.pathIndex++;
        if (this.pathIndex >= this.pathLen) this.hasMoveTarget = false;
      } else {
        to.multiplyScalar(1 / d);
        this._steer.copy(to);
        want = this.desiredSpeed;
      }
    }

    // local avoidance: push off squadmates and steer around them
    const others = this.ai.agents;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      const rr = (this.radius + o.radius + 0.42) ** 2;
      if (d2 > rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (1 - d / Math.sqrt(rr)) * 1.5;
      this._steer.x += (dx / d) * push;
      this._steer.z += (dz / d) * push;
      // tangential bias breaks head-on deadlocks deterministically
      this._steer.x += (-dz / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      this._steer.z += (dx / d) * push * 0.35 * (this.id % 2 ? 1 : -1);
      if (want === 0) want = this.desiredSpeed * 0.35;
    }

    if (this._steer.lengthSq() > 1e-6) this._steer.normalize();

    // speed: ease toward the request so starts and stops have weight
    const targetSpeed = want * (this.crouch ? 0.42 : 1) * (1 - this.suppression * 0.25);
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 7);
    if (this.speed < 0.05) this.speed = 0;

    // facing: look where we are going, or at the threat when engaged
    const engaged =
      this.state === STATE.COMBAT || this.state === STATE.SUPPRESSED || this.hasTarget;
    if (engaged && this.lastKnownAge < 8) {
      this.targetYaw = datan2(this.lastKnown.x - this.position.x, this.lastKnown.z - this.position.z);
    } else if (this.speed > 0.2) {
      this.targetYaw = datan2(this._steer.x, this._steer.z);
    } else if (this.hunting) {
      // A hunting bot that has stopped still has to look somewhere.
      //
      // Facing is "where I am going, or at the threat when engaged", and a bot
      // holding for its partner to close (see PATROL) is neither: it kept the
      // yaw it happened to stop with. `tools/converge.mjs` caught the endpoint
      // of that — the two survivors 1.1 m apart, both hunting, neither with a
      // target, because perception needs the body inside a 100 degree cone and
      // both men were facing away. The presser has the same problem the moment
      // it arrives and its path empties.
      //
      // This is the same information the hunt already acts on by walking there,
      // so it grants nothing new: perception still needs line of sight and the
      // reaction delay before any of it becomes a target.
      this.targetYaw = datan2(this.huntAt.x - this.position.x, this.huntAt.z - this.position.z);
    }
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // a big turn while standing still becomes a real turn-in-place step
    if (Math.abs(dy) > 0.9 && this.speed < 0.3) this.animator.turn(dy > 0 ? 1 : -1);
    const turnRate = this.speed > 0.3 ? 6.5 : 3.4;
    this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, dy));

    /* integrate through the character controller */
    const c = this.controller;
    if (c) {
      const g = this.phys.gravity;
      this.velocity.y += g * dt;
      const vx = this._steer.x * this.speed;
      const vz = this._steer.z * this.speed;
      c.setHeight?.(this.crouch ? 1.16 * this.scale : this.height);
      c.move(vx * dt, this.velocity.y * dt, vz * dt);
      this.position.copy(c.position);
      this.grounded = c.grounded;
      if (c.grounded && this.velocity.y < 0) this.velocity.y = 0;

      // blocked by something low: vault it
      if (c.lastMoveBlocked && this.speed > 1.5 && this.vaultCooldown <= 0 && this.grounded) {
        this._tryVault();
      }
      if (c.lastMoveBlocked && this.speed > 0.5) {
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.1) {
          this.stuckTimer = 0;
          this.repathTimer = 0;
          this._unstick();
        }
      } else {
        this.stuckTimer = 0;
        // `stuckCount` is NOT cleared here, and it used to be.
        //
        // It is the ESCALATION counter: `_unstick` side-steps on 1 and 2 and
        // only reaches for the last resort — putting the body on the nearest
        // grid cell — at 3. Clearing it in this branch made 3 unreachable for
        // exactly the bots that needed it, because this branch is where a bot
        // with speed 0 lands, and a bot that cannot move is the one whose
        // side-steps are failing. `_ensureGoal` raised it to 1 every 1.5 s and
        // the next tick put it back to 0; measured over a 34.5 s stall,
        // `stuckCount` never passed 1 and `snapUnsticks` stayed at 0.
        //
        // Cleared on PROGRESS instead — see `_ensureGoal`, which already owns
        // the displacement test. Not shoving is not the same as being fine.
      }
    } else {
      this.position.x += this._steer.x * this.speed * dt;
      this.position.z += this._steer.z * this.speed * dt;
    }
  }

  /**
   * Get off the wall.
   *
   * This used to be `if (this.hasMoveTarget) this._goTo(this.moveTarget)` — a
   * re-solve to the same destination. A* is deterministic and the level does not
   * move, so it returns the same path, the bot walks into the same corner, and
   * 1.1 s later it re-solves again. It is a loop, not a recovery, and it never
   * once freed anybody.
   *
   * `tools/converge.mjs` caught the end state: a bot pinned at x = -10.0 against
   * the partition wall whose face is at -9.7 — 0.1 m INSIDE it, given the 0.4 m
   * capsule — asking for 3.2 m/s for fifty consecutive seconds and not moving a
   * measurable distance. Its path was fine. Its body was wedged, and no amount
   * of re-pathing addresses a body.
   *
   * So escalate instead:
   *
   *   1. Sidestep. Aim 3 m along the blocking surface, alternating side per
   *      attempt so a bot that picks the wrong way gets the other one next time.
   *      This is what frees an ordinary corner snag.
   *   2. Back off. Aim 2.5 m straight back the way we came.
   *   3. Snap to the grid. After three failed attempts, place the body on the
   *      nearest walkable cell centre. That is a correction of at most one cell
   *      (0.8 m) onto a spot the nav grid has already certified as standable —
   *      not a teleport, and the only step that is guaranteed to terminate. A
   *      bot frozen in a wall for the rest of the round is a worse artefact than
   *      a bot that pops half a metre sideways once.
   */
  _unstick() {
    this.stuckCount = (this.stuckCount ?? 0) + 1;
    const fwd = this._v.set(dsin(this.yaw), 0, dcos(this.yaw));
    const side = this.stuckCount % 2 ? 1 : -1;
    const tries = [
      [-fwd.z * side, fwd.x * side, 3.0],
      [fwd.z * side, -fwd.x * side, 3.0],
      [-fwd.x, -fwd.z, 2.5],
    ];
    for (const [ox, oz, dist] of tries) {
      this._v2.set(
        this.position.x + ox * dist,
        this.position.y,
        this.position.z + oz * dist
      );
      if (this._goTo(this._v2)) return true;
    }

    const grid = this.ai.grid;
    if (this.stuckCount >= 3 && grid) {
      const i = grid.nearest(this.position.x, this.position.z, this.position.y);
      if (i >= 0) {
        const ix = i % grid.nx;
        const iz = (i / grid.nx) | 0;
        this.position.x = grid.worldX(ix);
        this.position.z = grid.worldZ(iz);
        // Through the controller, not by writing `position` alone: the capsule
        // is what the world collides with and what drives the mesh, so moving
        // the field by itself leaves the body in the wall it is being freed
        // from — the same mistake `tools/legibility.mjs` documents for staging.
        this.controller?.teleport(this.position.x, this.position.y, this.position.z);
        // Counted, because this is the one recovery a player could SEE — a body
        // moving up to 0.8 m without walking. It is a safety net and it should
        // fire almost never; if `tools/botfight.mjs` starts reporting a busy
        // counter, the thing to fix is whatever is wedging bots, not this.
        this.ai.snapUnsticks = (this.ai.snapUnsticks ?? 0) + 1;
        this.stuckCount = 0;
        return true;
      }
    }
    return false;
  }

  _tryVault() {
    const phys = this.phys;
    const fwd = this._v.set(dsin(this.yaw), 0, dcos(this.yaw));
    const low = phys.raycast(
      this.position.x, this.position.y + 0.35, this.position.z,
      fwd.x, 0, fwd.z, 0.85, phys.MASK.WORLD
    );
    if (!low.hit) return;
    // The chest probe has to cover the whole move, plus the capsule's own width.
    //
    // It used to be a flat 1.1 m against a landing spot 1.5 m ahead, so anything
    // standing between 1.1 and 1.5 m was invisible to the test that exists to
    // find it — and the vault is a teleport (lerp from `vaultFrom` to `vaultTo`,
    // no collision), so an obstacle in that band is not bumped into, it is
    // passed through.
    //
    // The centre of `world/warehouse.js` builds exactly that shape on purpose:
    // the 0.84 m mid crate is flush against the 2.7 m block, at x 2.3..3.1
    // against a block face at 2.3. A bot at x 3.5 facing -X finds a ledge at
    // 0.4 m (the crate), a clear chest line to 2.4 m (the crate is below chest
    // and the block starts at 2.3) — and a landing spot at x 2.0, which is
    // 0.3 m INSIDE the block. `tools/botfight.mjs` reported the consequence as a
    // stalemate: a survivor at (0.1, -0.8) at floor height, inside a solid
    // block, invisible to every line-of-sight test and unable to solve a route
    // out, with the rest of the roster converging on it forever.
    //
    // REACH + radius, not REACH: the bot has to FIT at the landing spot, and a
    // probe that stops exactly at the centre of where the capsule will stand
    // clears a wall the capsule's front half is already in.
    const REACH = 1.5;
    const high = phys.raycastAny(
      this.position.x, this.position.y + 1.25, this.position.z,
      fwd.x, 0, fwd.z, REACH + this.radius, phys.MASK.WORLD
    );
    if (high) return; // a wall, not a ledge
    // landing spot on the other side
    const lx = this.position.x + fwd.x * REACH;
    const lz = this.position.z + fwd.z * REACH;
    const y = this.ai.groundAt(lx, lz, this.position.y + 2.2);
    if (!Number.isFinite(y) || Math.abs(y - this.position.y) > 1.3) return;

    // Land where the game is played, or do not land.
    //
    // This is a FAIRNESS rule before it is a stability one. The player's whole
    // movement vocabulary is stand / crouch / jump — `player/mantle.js` was
    // deleted on purpose — and the jump apex is 0.60 m against a step height of
    // 0.42. A bot's chest probe reaches 1.25 m, so without this a bot can stand
    // on a 1.2 m crate that the player cannot follow it onto, on a mirror-
    // symmetric map whose symmetry `tools/symmetry.mjs` gates to 0 m. (The 2.6 m
    // container roofs are out of reach for both; the "mantle-height roof" in
    // `world/warehouse.js` is a phrase inherited from a game that had a mantle.)
    //
    // It is also what stops the stall this was found through. A crate top is its
    // own connected region, so a bot that vaults onto one can path nowhere, and
    // `_ensureGoal` then has to teleport it back down — measured at 20.9 s
    // motionless before that existed. Better not to go up at all.
    //
    // The nav grid already answers exactly this question, so ask it rather than
    // inventing a height rule that would have to be kept in step with the map.
    const grid = this.ai.grid;
    if (grid) {
      // THE LANDING'S OWN CELL, not the nearest one to it.
      //
      // This asked `nearest(lx, lz, y)`, whose ring search reaches eight cells —
      // 6.4 m — before giving up. So a landing on top of a container could be
      // accepted on the strength of a floor cell three metres away, which is the
      // exact outcome the check exists to prevent: a bot on a one-cell island,
      // failing every path request for the rest of the round.
      //
      // It was strict by accident until now. The pockets and one-way cells that
      // used to litter the map were what `nearest` found FIRST, and those fail
      // `inMainComponent`, so the loose radius never got exercised. Removing
      // them (see the orphan pass in `nav.js`) took the accident away and vault
      // acceptance went from 8 of 836 staged poses to 24 — a change nobody asked
      // for, arriving through a nav fix, which is how the loose test showed up.
      //
      // Asking about the cell the body will actually stand in needs no radius
      // and no height rule of its own: `walkable` and the floor sample already
      // encode both.
      // One ring, and a height tolerance — `nearest` already takes both. A
      // landing lands somewhere between cell centres, so demanding its exact
      // cell rejects perfectly good vaults on a rounding accident (measured: 4
      // of 836 against the shipped 8). One ring is 0.8 m, about a body radius,
      // which is the distance a landing may legitimately be off by. Eight rings
      // is not a tolerance, it is a different question.
      const cell = grid.nearest(lx, lz, y, 1, grid.maxStep);
      if (cell < 0 || !grid.inMainComponent(cell)) return;
    }
    this.vaultCooldown = 2.5;
    this.animator.vault(0.8);
    this.vaultFrom = (this.vaultFrom ?? new THREE.Vector3()).copy(this.position);
    this.vaultTo = (this.vaultTo ?? new THREE.Vector3()).set(lx, y, lz);
    this.vaultT = 0;
  }

  /* ================================================================== */
  /* shooting                                                           */
  /* ================================================================== */

  _shoot(dt) {
    // where the gun is pointing: lead toward the target with human error
    const t = this.hasTarget || this.lastKnownAge < 3 ? this.lastKnown : null;
    if (t) {
      // Aim at the CHEST. `AIM_DROP` is the whole of the bot difficulty model
      // that lives in this file — see its definition.
      this._v.set(t.x, t.y - AIM_DROP, t.z);
      const dist = this.position.distanceTo(this._v);
      // `time.sim`, NOT `time.elapsed`. This wobble is where a bot's rounds
      // actually go, and `elapsed` advances once per frame — so phasing on it
      // made every bot's aim a function of the display rate. `perceive --deep`
      // measured it parting one tick into a fixed-seed span on all seven bots at
      // once, which is what led here.
      const wobbleT = this.ctx.time.sim * 1.7 + this.id;
      const wob = 0.012 + this.suppression * 0.05;
      this._v.x += dsin(wobbleT) * wob * dist * 0.12;
      this._v.y += dsin(wobbleT * 1.7 + 1.1) * wob * dist * 0.08;
      this._v.z += dcos(wobbleT * 0.8) * wob * dist * 0.12;
      this.aimTarget.lerp(this._v, Math.min(1, dt * 6));
    } else {
      const fwd = this._v.set(dsin(this.yaw), 0, dcos(this.yaw));
      this._v2
        .copy(this.position)
        .addScaledVector(fwd, 12)
        .setY(this.position.y + this.eyeHeight - 0.1);
      this.aimTarget.lerp(this._v2, Math.min(1, dt * 3));
    }

    // `this.vaulting`, not the animator's: a bot's trigger discipline must not
    // depend on the frame rate its pose happens to be evaluated at. The
    // `animator.reloading` half of this is the same shape of coupling and is
    // deliberately left alone — reload timing is animator-driven for bots, and
    // moving it is a separate change with its own measurements.
    if (!this.wantFire || this.animator.reloading || this.vaulting) return;
    if (this.ammo <= 0) {
      this.animator.reload(this.variantName === 'irregular' ? 2.9 : 2.35);
      this.ai.emitReload(this);
      this.ammo = this.magSize;
      return;
    }
    if (this.burstLeft <= 0) {
      if (this.burstCooldown > 0) return;
      this.burstLeft = this.rng.int(3, 7);
      this.burstCooldown = this.rng.range(0.45, 1.35) + this.suppression * 0.5;
    }
    if (this.fireCooldown > 0) return;
    this.fireCooldown = 1 / this.fireRate;
    this.burstLeft--;
    this.ammo--;
    this._fireRound();
  }

  _fireRound() {
    const an = this.animator;
    // MUZZLE FROM THE SIMULATION, NOT FROM THE DRAWN POSE.
    //
    // This read `an.muzzleWorld` / `an.muzzleDir`, so every bot round left the
    // animated weapon bone. The animator is not in the snapshot and
    // `AiSystem._updateRelevance` throttles it to one evaluation in three
    // whenever the camera cannot see the actor — so where a bullet started
    // depended on whether anyone was looking. Same defect `710c630` fixed on the
    // player side, where the camera WAS the aim.
    //
    // Aiming at `aimTarget` is close to a no-op: the animator's aim IK was
    // already pointing the bore at the same place, 0.07 degrees off the line at
    // the median over 822 aimed samples. What changes is that the ray starts
    // somewhere the simulation knows.
    const o = this._muzzleOrigin;
    const cy = dcos(this.yaw), sy = dsin(this.yaw);
    o.set(
      this.position.x + MUZZLE.right * cy + MUZZLE.forward * sy,
      this.position.y + (this.crouch ? MUZZLE.upCrouch : MUZZLE.upStand),
      this.position.z - MUZZLE.right * sy + MUZZLE.forward * cy
    );
    const origin = o;
    const dir = this._muzzleDir.copy(this.aimTarget).sub(o);
    // No aim point yet (a scatter harness, or a bot that has not acquired):
    // fall back to the facing the simulation already has.
    if (dir.lengthSq() < 1e-8) dir.set(sy, 0, cy);
    dir.normalize();
    // cone of fire: worse when suppressed, better the longer we have been aiming
    const spread = this.spread * (1 + this.suppression * 1.5);
    dir.x += this.rng.gauss() * spread;
    dir.y += this.rng.gauss() * spread * 0.8;
    dir.z += this.rng.gauss() * spread;
    dir.normalize();
    an.fire(1);
    this.ai.onAgentFire(this, origin, dir);
  }

  _throwGrenade(target) {
    this.grenadeCooldown = this.rng.range(16, 34);
    this.hasGrenade = false;
    const from = this._v.copy(this.animator.muzzleWorld);
    this.ai.throwGrenade(this, from, target);
  }

  /* ================================================================== */
  /* damage                                                             */
  /* ================================================================== */

  /**
   * Take a hit.
   *
   * The signature is `(amount, from, opts)` to match PlayerSystem's, because
   * `match.Combatant` calls one method on both and there is no reason for a bot
   * and a player to disagree about how you tell them they have been shot. The
   * upstream order was `(amount, part, point, dir)`; the arguments are the same
   * ones, they just travel in the options bag now.
   *
   * NOTE: named `applyDamage`, not `damage` — the weapon's damage value is a
   * field on this object and a method of the same name would be shadowed by it.
   *
   * @param amount        post-falloff damage, part scale already applied
   * @param from          world position of the shooter, or null
   * @param opts.part     'head' | 'torso' | 'arm' | 'leg'
   * @param opts.point    world impact point
   * @param opts.dir      incident direction (unit)
   * @param opts.source   whoever fired
   */
  applyDamage(amount, from, opts = {}) {
    if (!this.alive) return 0;
    const part = opts.part ?? 'torso';
    const dir = opts.dir ?? null;
    // `from` is a position or null. Check it rather than trust it: this method
    // is called from four places and one of them spent a milestone passing a
    // part name here, which propagated all the way into a physics raycast
    // before anything complained. A wrong type should stop at the door.
    const fromVec = from && typeof from.x === 'number' ? from : null;
    const point = opts.point ?? fromVec ?? this.eye;
    const before = this.health;
    this.health -= amount;
    this.alertness = 1;
    this.suppression = Math.min(1.6, this.suppression + 0.35);
    // knowing where it came from
    if (dir) {
      this._v.copy(point).addScaledVector(dir, -14);
      if (this.lastKnownAge > 0.5) {
        this.lastKnown.copy(this._v);
        this.lastKnownAge = 0.4;
      }
    }
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);

    if (this.health <= 0) {
      this.die(point, dir, amount);
      return before;
    }
    // hit reaction by region, with the side the round came from
    const side = dir ? Math.sign(dir.x * dcos(this.yaw) - dir.z * dsin(this.yaw)) || 1 : 1;
    const region =
      part === 'head' ? 'head'
        : part === 'arm' ? (this._sideOf(point) < 0 ? 'armR' : 'armL')
          : part === 'leg' ? (this._sideOf(point) < 0 ? 'legR' : 'legL')
            : 'torso';
    this.animator.hit(region, side, Math.min(1.4, 0.5 + amount / 45));
    if (part === 'leg') this.speed *= 0.4;
    return before - this.health;
  }

  /** Which side of the body a world point is on: <0 right, >0 left. */
  _sideOf(p) {
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    return dx * dcos(this.yaw) - dz * dsin(this.yaw);
  }

  die(point, dir, amount = 30) {
    if (!this.alive) return;
    this.alive = false;
    this.state = STATE.DEAD;
    this.wantFire = false;
    this.animator.enabled = false;
    this.ai.cover?.release(this.id);
    if (this.controller) this.phys.removeCharacter(this.controller);
    this.controller = null;
    // DISABLE, do not remove. In round play this body comes back in twenty
    // seconds: rebuilding seven capsules per bot per round is pure churn, and
    // worse, `match` holds these collider references for the whole match under
    // `rig: 'host'`. Freeing them here would leave the respawned bot with a
    // registration pointing at colliders physics no longer owns — a fighter you
    // can see and cannot hit.
    for (const c of this.colliders) c.enabled = false;

    // Impulse is N·s, and the ragdoll turns it into a velocity change on the
    // particles it lands near: a 5.56 round carries ~4 N·s, so anything in the
    // hundreds launches the body across the street instead of dropping it.
    this.group.updateMatrixWorld(true);
    const impulse = this._v2
      .copy(dir ?? this._v.set(0, 0, 1))
      .normalize()
      .multiplyScalar(Math.min(5.5, 1.5 + amount * 0.02));
    const hitPoint = point ?? this._v.copy(this.position).setY(this.position.y + 1.2);

    // Own the hand-off: build the capsule spec from the *live* animated pose,
    // hand it to the solver and let it drive the skeleton from here. Setting
    // __ragdoll stops physics creating a second one off our death event.
    const rd = this._makeRagdoll(impulse, hitPoint);
    if (rd) {
      this.__ragdoll = rd;
      this.ragdoll = rd;
    }
    this.ctx.events.emit('actor:death', {
      actor: this,
      point: hitPoint,
      impulse,
      headshot: false,
    });
    this.deadTime = 0;
  }

  /**
   * Hand the live pose to the ragdoll solver. `physics` derives the capsule
   * chain from the skeleton itself, so the doll starts exactly in the pose the
   * animator left — the death has no pop. `radiusRatio` fattens the capsules
   * (its default is thin enough that a settled body reads as a pancake).
   */
  _makeRagdoll(impulse, point) {
    const phys = this.phys;
    if (!phys) return null;
    // Fat capsules that start half-buried in the floor tunnel straight through
    // it: the contact normal flips once a bone's axis is on the far side. Lift
    // the pose clear of the ground for the one frame it takes to build the doll,
    // then put the group back — the body drops the 15 cm invisibly.
    const lift = 0.15 * this.scale;
    this.group.position.y += lift;
    this.group.updateMatrixWorld(true);
    const rd = phys.createRagdollFromSkeleton(this.mesh, {
      actor: this,
      mass: this.mass,
      radiusRatio: 0.42,
      cone: 74,
      twist: 38,
      iterations: 8,
      velocity: { x: this.velocity.x * 0.6, y: 0, z: this.velocity.z * 0.6 },
    });
    this.group.position.y -= lift;
    this.group.updateMatrixWorld(true);
    if (!rd) return null;
    if (impulse && point) {
      // wide radius: a tight one dumps all of it into whichever light bone is
      // nearest and whips the limb across the street
      rd.applyImpulse(point.x, point.y, point.z, impulse.x, impulse.y, impulse.z, 0.85);
    }
    if (this.ai.debugLog) {
      console.info(
        `[ai] ragdoll ${rd.boneCount} bones / ${rd.particleCount} particles, ` +
          `mask=${rd.mask} tris=${rd.world?.triCount}`
      );
    }
    return rd;
  }

  /* ================================================================== */
  /* drive the visual                                                   */
  /* ================================================================== */

  /** Root motion for a vault. Simulation — see the call site in `simulate`. */
  /**
   * Root motion for a vault. Simulation, and now OWNED by the simulation.
   *
   * This used to gate on `animator.vaulting`, which made the drawn pose decide
   * where a bot ended up. The animator is presentation: it is not in the
   * snapshot, and `AiSystem._updateRelevance` throttles it to one evaluation in
   * three whenever the CAMERA cannot see the actor. So a vault's arc depended on
   * whether anyone was looking, and a rewind that restored every simulation
   * field still landed the bot somewhere else — the replay gate measured 127
   * diverging leaves, and holding every agent at full animation rate (`--nolod`)
   * halved it.
   *
   * `vaultTo` is the state and its own disarm: non-null means a vault is in
   * flight, and `reset()` already used it that way. The animator still plays the
   * clip, and it no longer decides anything.
   */
  _driveVault(dt) {
    if (!this.vaultTo) return;
    this.vaultT += dt / 0.8;
    const t = Math.min(1, this.vaultT);
    this.position.lerpVectors(this.vaultFrom, this.vaultTo, t);
    this.position.y += dsin(t * Math.PI) * 0.42;
    this.controller?.teleport(this.position.x, this.position.y, this.position.z);
    if (t >= 1) this.vaultTo = null;
  }

  /** Mid-vault, per the simulation. Not `animator.vaulting` — see `_driveVault`. */
  get vaulting() {
    return this.vaultTo !== null && this.vaultTo !== undefined;
  }

  _drive(dt) {
    this.group.position.copy(this.position);
    // Same substitution as `reset` — see the note there.
    dquatFromEuler(this.group.quaternion, 0, this.yaw, 0, 'XYZ');
    this.group.updateMatrixWorld(true);

    const moving = this.speed > 0.25;
    let clip;
    if (this.crouch) clip = moving ? 'crouchWalk' : 'crouchIdle';
    else if (this.speed > 2.6) clip = 'run';
    else if (moving) clip = 'walk';
    else clip = this.health < 35 ? 'hurtIdle' : 'idle';
    this.clip = clip;

    const an = this.animator;
    an.setState({
      clip,
      speed: this.speed,
      crouch: this.crouch,
      aimTarget: this.aimTarget,
      lookTarget: this.hasTarget || this.lastKnownAge < 4 ? this.lastKnown : this.aimTarget,
      aimWeight: this.aimWeight,
      suppress: Math.min(1, this.suppression * 0.8),
    });

    // Full rate, every tick, no animation LOD. The one-evaluation-in-three
    // skip that lived here was keyed to the CAMERA, and the pose stopped being
    // presentation the moment it moved onto the tick: `syncHitboxes` welds the
    // hit capsules to these bones and `MASK.BULLET` contains ACTOR, so the skip
    // made WHICH BONE A ROUND LANDS ON a function of where somebody was
    // looking. `crossengine.mjs` measured the consequence — two processes of
    // the SAME engine, same injected state, same commands, 25 leaves apart —
    // noise that made the netcode architecture question unanswerable.
    //
    // What the skip bought was measured before it was removed: 15.9 µs per
    // evaluation, and the frustum typically excludes ONE bot of seven
    // (p10=p50=p90=1 over 600 live ticks). The half of LOD that pays — dropping
    // invisible actors from the shadow cascades — is untouched and still
    // camera-keyed in `_updateRelevance`, because pixels belong to the frame.
    //
    // `time.sim`, not `time.elapsed`. The note that used to sit here said
    // `elapsed` was "simulation time, advanced on the tick, carried by every
    // rewind harness" — it is none of those things. `Engine.step` advances it
    // once per FRAME by that frame's delta, before the fixed loop, so it is
    // frame time wearing a simulation name, and this line was the stated
    // justification for feeding it to a pose that decides where rounds land.
    // `time.sim` is `tick * FIXED_DT`: exact per step, and it rewinds with the
    // tick every snapshot already carries.
    an.update(dt, this.ctx.time.sim);
  }

  /** Push the hit capsules onto the animated skeleton. */
  syncHitboxes() {
    if (!this.alive) return;
    const an = this.animator;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const { a, b } = c.userData;
      an.bonePos(a, this._boneA);
      an.bonePos(b, this._boneB);
      c.setSegment(
        this._boneA.x, this._boneA.y, this._boneA.z,
        this._boneB.x, this._boneB.y, this._boneB.z
      );
    }
  }

  /**
   * Put this bot back on its feet for a new round.
   *
   * This exists because the alternative is a per-round allocation bomb. A bot's
   * body is a procedurally generated skinned mesh with its own baked cloth
   * textures and a 25-bone skeleton; building one is the most expensive thing
   * this subsystem does, and building sixteen of them at every round transition
   * would put a visible freeze exactly where the game is meant to feel crisp.
   * The bodies are permanent; only their state is round-scoped.
   *
   * The rule for what belongs here: anything death touched, plus anything the
   * FSM accumulated. Anything derived from the body itself — mesh, skeleton,
   * variant, hitbox capsules — is left alone on purpose.
   */
  /**
   * The Combatant contract's round-reset entry point — `match` calls this, and
   * calls the identically-named method on the player, without knowing which is
   * which.
   *
   * `point.yaw` arrives in the WORLD convention because it came off
   * `world.spawnPoints`, so the conversion happens here, at the boundary, and
   * `reset()` below continues to speak the AI convention like the rest of the
   * file. See `aiYaw`.
   *
   * @param {{position: THREE.Vector3, yaw: number}} point
   */
  respawn(point) {
    if (!point?.position) return this;
    return this.reset(point.position, aiYaw(point.yaw ?? 0));
  }

  /**
   * This bot's facing in the WORLD convention, for anything outside `ai` that
   * needs it (`Combatant.viewYaw`). `aiYaw` is its own inverse — it is a shift
   * of PI, and two of those is a full turn.
   */
  get worldYaw() {
    return aiYaw(this.yaw);
  }

  reset(position, yaw = 0, opts = {}) {
    // ---- undo death ----
    if (this.ragdoll) {
      this.phys?.removeRagdoll(this.ragdoll);
      this.ragdoll = null;
      this.__ragdoll = null;
    }
    this.alive = true;
    this.health = this.maxHealth;
    this.animator.enabled = true;
    this.animator.reset?.();
    this.group.visible = true;
    for (const c of this.colliders) c.enabled = true;

    // ---- place ----
    this.position.copy(position);
    this.yaw = yaw;
    this.targetYaw = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    if (!this.controller) {
      this.controller = this.phys?.createCharacter({
        radius: this.radius,
        height: this.height,
        position: this.position,
        stepHeight: 0.42,
        slopeLimit: 48,
      }) ?? null;
    } else {
      this.controller.teleport(position.x, position.y, position.z);
    }
    this.grounded = true;

    // ---- forget the last round ----
    // Perception state especially: a bot that remembers where it last saw
    // someone will walk to that spot at the start of the next round, which
    // reads as psychic rather than as memory.
    this.target = null;
    this.hasTarget = false;
    this.targetVisible = false;
    this.awareness = 0;
    this.alertness = 0;
    this.suppression = 0;
    this.lastKnownAge = Infinity;
    /** Seconds since an enemy was last SEEN. Ears never touch this. */
    this.lastSeenAge = Infinity;
    this.reactionTimer = 0;
    this.deadTime = undefined;

    this.ammo = this.magSize;
    this.wantFire = false;
    this.burstLeft = 0;
    this.burstCooldown = 0;
    this.fireCooldown = 0;
    this.hasGrenade = true;
    this.grenadeCooldown = this.rng.range(6, 20);

    this.ai.cover?.release(this.id);
    this.cover = null;
    this.peeking = false;
    this.peekSide = 0;
    this.peekTimer = this.rng.range(0.5, 2.5);

    this.path.length = 0;
    this.pathLen = 0;
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.pathPending = false;
    this.hasMoveTarget = false;
    this.moveTarget.copy(this.position);
    this.stuckTimer = 0;
    this.crouch = false;
    this.vaultCooldown = 0;
    this.vaultT = 0;
    // BOTH ends, not just the far one. `_drive` guarded on `vaultFrom` while
    // dereferencing `vaultTo`, so an agent reset at a round boundary while still
    // mid-vault kept a stale `vaultFrom`, walked through the guard and threw
    // inside `lerpVectors`. It reproduced in two matchsim runs out of three and
    // in no botfight run at all, because it needs a reset to happen — one round
    // never resets anything.
    this.vaultFrom = null;
    this.vaultTo = null;

    if (opts.team) this.team = opts.team;
    if (opts.patrol) {
      this.patrolPoints = opts.patrol;
      this.patrolIndex = 0;
    }
    this.patrolFails = 0;
    this.noGoalTime = 0;
    this.noMoveTime = 0;
    this._progressFrom.copy(position);
    this.huntTimer = 0;
    this.hunting = false;
    // Agents are pooled across rounds, so anything that accumulates has to be
    // cleared here or a bot starts round 2 already halfway through a hold.
    this.holdTime = 0;
    this.holdD0 = Infinity;
    this.holdSuppress = 0;
    this.aliveTime = 0;
    this.stateTime = 0;
    this.state = STATE.IDLE;
    return this;
  }

  dispose() {
    if (this.controller) this.phys?.removeCharacter(this.controller);
    for (const c of this.colliders) this.phys?.removeCollider(c);
    this.colliders.length = 0;
    if (this.ragdoll) this.phys?.removeRagdoll(this.ragdoll);
    this.group.parent?.remove(this.group);
  }
}
