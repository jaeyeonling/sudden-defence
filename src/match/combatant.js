/**
 * COMBATANT — the one thing the player and a bot both are.
 *
 * The shooter this code came from had no such type, and that single omission
 * shaped everything downstream: bots carried seven bone capsules with a 4x head
 * multiplier, the player carried one featureless capsule, and "bot shoots
 * player" was therefore a bespoke line-segment distance test living in the AI
 * subsystem rather than a bullet trace. The player could not be headshot,
 * because there was nothing on the player to headshot.
 *
 * A Combatant is deliberately NOT a character. It does not move anything, own
 * health, or step. It is an identity (id, team) plus a hitbox rig plus a damage
 * inlet, and it delegates every one of those to a `host` — PlayerSystem today,
 * an AI Agent in M4. Both ends of a firefight then look identical to physics,
 * to fx, and to the killfeed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE TORSO IS A BOX AND THE HEAD IS A SPHERE
 *
 * The obvious build is capsules everywhere, and it is wrong. A capsule's
 * spherical cap bulges above its segment by its own radius, so a torso capsule
 * topping out at the collarbone still has 17 cm of geometry sitting up around
 * the ears. A horizontal round at eye height then enters the torso cap BEFORE it
 * enters the head — closer to the shooter, because it is fatter — and physics,
 * which honestly reports the closest hit, calls a clean headshot a body shot.
 *
 * Shoulders are flat. A box has a flat top at exactly the height you ask for,
 * which both removes the overlap and is the better silhouette anyway. Heads are
 * round, so the head is a sphere. Limbs really are capsules.
 */

import * as THREE from 'three';
import { dcos, dsin } from '../core/dmath.js';

/**
 * The rig, in fractions of the CURRENT stance height, feet at 0.
 *
 * Fractions rather than metres so crouching rescales for free: a crouch
 * compresses the legs and drops the head, which is exactly what multiplying
 * every station by a smaller height does.
 *
 * `damageScale` multiplies the round's damage at this station. These four
 * numbers are most of the game's lethality, so they are worth stating plainly
 * against the rifle (33 damage, 100 HP):
 *
 *   head  4.00 -> 132  one round, at any range the dropoff still allows
 *   torso 1.00 ->  33  four rounds
 *   arm   0.75 ->  25  four rounds, and you feel the difference
 *   leg   0.70 ->  23  five rounds
 *
 * That headshot number is the deliberate one. A one-tap head is what makes
 * holding an angle worth the risk, and it is the single loudest statement this
 * file makes about what the game is. Final balance is M7's job; the shape of it
 * is here.
 */
export const HITBOXES = [
  {
    part: 'head',
    damageScale: 4.0,
    shape: 'sphere',
    /** Centre height, and radius in metres (a head does not scale with stance). */
    y: 0.925,
    r: 0.115,
  },
  {
    part: 'torso',
    damageScale: 1.0,
    shape: 'box',
    y0: 0.44,
    y1: 0.86,
    /** Half shoulder width and half chest depth, metres. */
    hx: 0.2,
    hz: 0.115,
  },
  {
    part: 'arm',
    damageScale: 0.75,
    shape: 'capsule',
    y0: 0.5,
    y1: 0.855,
    r: 0.062,
    /** Mirrored: one instance at +x, one at -x, in the host's local frame. */
    x: 0.245,
  },
  /**
   * Legs. The offset and the radius are chosen so the two capsules OVERLAP
   * across the centreline (0.085 apart, 0.095 fat), which is the one number
   * here that was tuned against a test rather than against anatomy.
   *
   * The anatomically honest build — 0.095 apart, 0.085 fat — leaves a 2 cm slot
   * straight down the middle, and `tools/hitbox.mjs` threaded it on the first
   * run: a round aimed at the centre of a standing target's legs passed clean
   * through and dealt nothing. Real thighs do meet at the hip, and a gap that
   * runs the FULL length of the leg is a bug however defensible it looks in a
   * diagram. Overlapping costs nothing: physics takes the closest hit, and both
   * capsules are the same part at the same damage scale.
   */
  {
    part: 'leg',
    damageScale: 0.7,
    shape: 'capsule',
    y0: 0.05,
    y1: 0.46,
    r: 0.095,
    x: 0.085,
  },
];

/** Head centre as a fraction of stance height — `combatant.head` uses it too. */
export const HEAD_FRACTION = HITBOXES[0].y;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

let _nextId = 1;

/**
 * A registered fighter. Created by `match.register()`, never by hand.
 *
 * The `host` contract is small on purpose, so an AI Agent can satisfy it
 * without inheriting anything:
 *
 *   host.position       Vector3, bottom of the capsule, INTERPOLATED
 *   host.yaw            radians
 *   host.height         metres, current stance
 *   host.dead           boolean  (or `alive`, for hosts that phrase it that way)
 *   host.applyDamage(amount, fromVec3|null, opts)   opts: { part, source, type }
 *   host.isPlayer       optional, defaults false
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO KINDS OF RIG
 *
 * `rig: 'fractions'` (the default) builds the stance-relative rig below. It is
 * for hosts with no skeleton — the local player, who is a capsule and a camera.
 *
 * `rig: 'host'` adopts colliders the host already owns and leaves them alone.
 * A bot has a real animated skeleton, and capsules welded to its bones are
 * strictly better than anything derived from a height: an arm raised to aim is
 * a hitbox raised to aim. Forcing the player's approximation onto something that
 * has the real thing would be a downgrade dressed up as consistency.
 *
 * What matters is that both end up as `owner`-tagged colliders carrying a
 * `part` and a `damageScale`, because that is all the bullet trace reads.
 */
export class Combatant {
  /**
   * Snapshot classification (netcode step 5).
   *
   * Health is absent on purpose and is not an omission: `alive` is a getter that
   * asks the host (`health.dead` for the player, `alive` for a bot), so the
   * number itself rewinds under `player` or under the agent that owns it.
   * Capturing it here as well would restore it twice.
   *
   * `_lastAttacker` IS A POINTER TO ANOTHER COMBATANT, and this is the hazard
   * §2.1 of the handoff names. Stored raw, a restore would not restore it — it
   * would alias whatever object the pointer still happened to reach, which after
   * a pool reuse is a different fighter with the same address. It goes out as
   * `id` and comes back through a lookup, and `restoreState` takes that lookup
   * as an argument rather than reaching for the roster itself.
   */
  static snapshotState = [
    'kills', 'deaths', 'damageDealt',
    '_dead', '_lastAttacker', '_lastPart', '_lastHeadshot',
  ];
  static excludedState = [
    'id', 'host', 'team', 'name', 'isPlayer', 'rig', 'colliders', '_physics', '_head', '_simHead',
  ];

  captureState(out = {}) {
    out.kills = this.kills;
    out.deaths = this.deaths;
    out.damageDealt = this.damageDealt;
    out._dead = this._dead;
    out._lastAttacker = this._lastAttacker ? this._lastAttacker.id : null;
    out._lastPart = this._lastPart;
    out._lastHeadshot = this._lastHeadshot;
    return out;
  }

  /** `byId` maps a combatant id back to its instance — see `_lastAttacker`. */
  restoreState(s, byId) {
    this.kills = s.kills;
    this.deaths = s.deaths;
    this.damageDealt = s.damageDealt;
    this._dead = s._dead;
    this._lastAttacker = s._lastAttacker === null ? null : (byId?.get(s._lastAttacker) ?? null);
    this._lastPart = s._lastPart;
    this._lastHeadshot = s._lastHeadshot;
  }

  constructor(host, opts = {}) {
    this.id = _nextId++;
    this.host = host;
    this.team = opts.team ?? null;
    this.name = opts.name ?? `combatant-${this.id}`;
    this.isPlayer = !!(opts.isPlayer ?? host.isPlayer);
    /** 'fractions' builds the rig below; 'host' adopts what the host already has. */
    this.rig = opts.rig ?? 'fractions';

    /** Scoreboard counters. `match` owns the reset; nothing else writes them. */
    this.kills = 0;
    this.deaths = 0;
    this.damageDealt = 0;

    this.colliders = [];
    this._physics = null;
    /** Set by `match` on the alive->dead edge so a death is counted once. */
    this._dead = false;
    /** Last round that landed on this fighter — kill attribution reads these. */
    this._lastAttacker = null;
    this._lastPart = 'torso';
    this._lastHeadshot = false;
    /** Reused by the `head` getter — this is read every AI perception tick. */
    this._head = new THREE.Vector3();
    /** Reused by `simHead`. Separate from `_head`; see that getter. */
    this._simHead = new THREE.Vector3();
  }

  /**
   * Hosts disagree about which way round to say this: the player has `dead`
   * (health owns it), a bot has `alive` (its FSM owns it). Accept both rather
   * than make one of them carry a field it would never otherwise have.
   */
  get alive() {
    const h = this.host;
    return typeof h.dead === 'boolean' ? !h.dead : h.alive !== false;
  }

  /**
   * Feet, interpolated. Deliberately NOT the fixed-step position: hitboxes and
   * the point bots aim at have to agree with the thing on screen, and at 8 m/s
   * one frame of lag is 13 cm — enough to turn a centred shot into a miss.
   */
  get position() {
    return this.host.position;
  }

  get velocity() {
    return this.host.velocity;
  }

  get height() {
    return this.host.height ?? 1.78;
  }

  /**
   * Where to aim. Bots shoot at this, so it must be the same point the head
   * hitbox is built around — aiming somewhere the head is not is the classic
   * way to end up with bots that "miss" a target they are looking straight at.
   */
  get head() {
    const p = this.position;
    return this._head.set(p.x, p.y + this.height * HEAD_FRACTION, p.z);
  }

  /** EXPERIMENT: feet as the fixed step left them. */
  get simPosition() {
    return this.host.feetPosition ?? this.host.position;
  }

  /** EXPERIMENT: `head`, off the fixed-step feet. */
  get simHead() {
    const p = this.simPosition;
    return this._simHead.set(p.x, p.y + this.height * HEAD_FRACTION, p.z);
  }

  /**
   * Facing, in the WORLD convention, whichever convention the host speaks.
   *
   * A bot's `yaw` is in the AI convention (see ARCHITECTURE.md, "Two yaw
   * conventions") and differs from the player's by PI. Anything outside the AI
   * that wants to know which way a fighter is looking — the spectator camera is
   * the first — would otherwise have to ask what kind of host it has, which is
   * exactly the question the Combatant type exists to make unnecessary.
   */
  get viewYaw() {
    const h = this.host;
    return h.worldYaw ?? h.yaw ?? 0;
  }

  /* ==================================================================== */
  /* hitboxes                                                             */
  /* ==================================================================== */

  /**
   * Build the rig on `layer` (PLAYER for the local player, ACTOR for bots).
   * Called once at registration.
   */
  buildHitboxes(physics, layer) {
    this._physics = physics;
    if (this.rig === 'host') {
      // Adopt, do not own: the host built these against its own skeleton and
      // keeps them in step with its animation. dispose() must not free them.
      this.colliders = this.host.colliders ?? [];
      return this.colliders;
    }
    for (const spec of HITBOXES) {
      // Anything with a lateral offset exists twice; everything else once.
      const sides = spec.x ? [-1, 1] : [0];
      for (const side of sides) {
        this.colliders.push(physics.addCollider({
          shape: spec.shape,
          layer,
          surface: 'flesh',
          owner: this.host,
          part: spec.part,
          damageScale: spec.damageScale,
          radius: spec.r ?? 0.1,
          hx: spec.hx ?? 0.1,
          hy: 0.1,
          hz: spec.hz ?? 0.1,
          userData: { spec, side },
        }));
      }
    }
    this.syncHitboxes();
    return this.colliders;
  }

  /**
   * Place the rig from the host's transform. Call once per rendered frame,
   * AFTER the host has written its interpolated position — a rig placed from
   * the fixed-step position lags the thing you can see by up to one frame,
   * which at 8 m/s is 13 cm of "I shot exactly where he was".
   */
  syncHitboxes() {
    // A host-owned rig is driven by the host's bone transforms, which it writes
    // on its own tick. Touching it here would fight the animator.
    if (this.rig === 'host' || !this.colliders.length) return;
    // The FIXED-STEP feet, not the drawn ones. This rig belongs to the local
    // player, who renders in first person: no screen shows this body, so the
    // "hitboxes must agree with the thing on screen" argument protects nothing
    // here — while the interpolated pose made where a bot's round LANDS (and
    // the `bullet:impact` every nearby bot hears) a function of the frame
    // rate, which `perceive.mjs` caught at sub-millimetre and flaky. Bots
    // already aim at the fixed-step head (`simHead`); the hitbox now agrees
    // with the aim by construction. Online, what a remote shooter saw is lag
    // compensation's job, not this getter's.
    const p = this.simPosition;
    const h = this.height;
    const yaw = this.host.yaw ?? 0;
    // Local +x (the host's right) in world space. Forward at yaw is
    // (-sin, 0, -cos), so right = cross(forward, up) = (cos, 0, -sin) — which is
    // also exactly where a THREE rotation of `yaw` about +Y sends local +x, so
    // the box quaternion below and these offsets agree by construction.
    const rx = dcos(yaw);
    const rz = -dsin(yaw);
    const live = this.alive;

    for (const c of this.colliders) {
      const { spec, side } = c.userData;
      c.enabled = live;
      if (!live) continue;
      const lateral = side * (spec.x ?? 0);
      const ox = rx * lateral;
      const oz = rz * lateral;

      if (spec.shape === 'sphere') {
        c.setSphere(p.x, p.y + h * spec.y, p.z, spec.r);
      } else if (spec.shape === 'box') {
        const y0 = h * spec.y0;
        const y1 = h * spec.y1;
        c.hy = (y1 - y0) * 0.5;
        _pos.set(p.x + ox, p.y + (y0 + y1) * 0.5, p.z + oz);
        _q.setFromAxisAngle(_up, yaw);
        c.setMatrix(_m.compose(_pos, _q, _scale));
      } else {
        c.setSegment(
          p.x + ox, p.y + h * spec.y0, p.z + oz,
          p.x + ox, p.y + h * spec.y1, p.z + oz,
          spec.r
        );
      }
    }
  }

  /* ==================================================================== */

  /**
   * Take a hit. `part` has already had its damage scale applied by physics
   * (the scale lives on the collider), so this only forwards.
   */
  applyDamage(amount, part, source, from) {
    if (!this.alive || amount <= 0) return 0;
    return this.host.applyDamage(amount, from ?? null, {
      type: 'bullet',
      part: part ?? 'torso',
      source: source ?? null,
    }) ?? 0;
  }

  /**
   * Put this fighter back on their feet for a new round.
   *
   * Both hosts implement `respawn(point)` taking a `{ position, yaw }` in the
   * WORLD yaw convention — `player.respawn` natively, `Agent.respawn` as a thin
   * wrapper that converts to the AI convention before calling its own `reset()`.
   * Putting the conversion on the host rather than here is what keeps this file
   * from having to know that two conventions exist.
   *
   * Score counters are deliberately NOT touched: kills and deaths accumulate
   * across a match, which is what a scoreboard shows.
   */
  respawn(point) {
    this._dead = false;
    this._lastAttacker = null;
    this._lastPart = 'torso';
    this._lastHeadshot = false;
    this.host.respawn?.(point);
    // Place the rig now rather than waiting for lateUpdate: between here and
    // there sits the rest of the frame, and a fighter standing at spawn with
    // hitboxes still at the place they died is shootable in two places at once.
    this.syncHitboxes();
    return this;
  }

  dispose() {
    // Only free what we built. A host-owned rig outlives its registration —
    // bots are pooled and re-registered every round, and freeing their
    // colliders here would leave the pooled body unhittable when it came back.
    if (this.rig !== 'host') {
      for (const c of this.colliders) this._physics?.removeCollider(c);
    }
    this.colliders = [];
  }
}
