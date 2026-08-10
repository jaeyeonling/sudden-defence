/**
 * SPAWN ASSIGNMENT — where each fighter stands when a round begins.
 *
 * The map authors three spawn points per team (`world.spawnsFor`), and a team
 * fields more fighters than that, so somebody has to spread five people over
 * three anchors without stacking them inside each other or posting one of them
 * inside a wall. That is the whole job.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE SCATTER IS DETERMINISTIC AND NOT RANDOM
 *
 * `ai/index.js` scatters its garrison with `rng.range()`, which is right for a
 * one-time garrison: it draws from `ctx.rng`, so a capture still reproduces, and
 * a little asymmetry at boot looks alive.
 *
 * A round reset is a different problem. It happens five to nine times a match,
 * always at the same anchors, and if the offsets are drawn fresh each time then
 * two fighters can land 15 cm apart in round 4 having been 2 m apart in round 3
 * — and the character controller resolves that by shoving one of them somewhere
 * neither of them chose. Slot index in, offset out, no state: the same fighter
 * count always produces the same formation, and the formation is spread by
 * construction rather than by luck.
 *
 * The offsets come off a golden-angle spiral, which is the cheapest way to get
 * points that stay far apart at every count rather than only on average.
 */

import * as THREE from 'three';

/** ~137.5 degrees. Consecutive slots never line up, at any count. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Metres between rings of the spiral. Two fighters are never closer than this. */
const RING_STEP = 1.15;

/**
 * How far above an authored spawn the floor probe starts.
 *
 * 1.5 m, matching `player._resolveSpawn`, and for the same reason: the
 * warehouse ceiling is 6 m and the upstream "+6 m of clearance" convention put
 * the probe inside the roof slab, which reported the roof as the floor. See
 * ARCHITECTURE.md, "Interior probes".
 */
const PROBE_UP = 1.5;

/** A scattered point is rejected if its floor differs from the anchor's by more. */
const STEP_TOLERANCE = 0.45;

export class SpawnAssigner {
  /**
   * Snapshot classification (netcode step 5). Nothing rewinds.
   *
   * Both fields are output scratch, not memory: `_pool` is reusable slot objects
   * that `assign()` overwrites from scratch on every call, and `_byTeam` is the
   * returned Map, cleared at the top of the same call. Who gets which seat is
   * decided by registration order, which the comment on `assign` already
   * establishes is stable across a match — so the assignment is a pure function
   * of the roster and needs no state to reproduce.
   */
  static snapshotState = [];
  static excludedState = ['world', 'physics', '_pool', '_byTeam'];

  captureState(out = {}) { return out; }
  restoreState() {}

  constructor(world, physics) {
    this.world = world;
    this.physics = physics;
    /**
     * One reusable point per slot index, grown on demand. `assign()` runs at
     * every round transition and hands these straight to hosts, which copy from
     * them — so they must not be retained by the caller, and they never are.
     */
    this._pool = [];
    this._byTeam = new Map();
  }

  _slot(i) {
    let s = this._pool[i];
    if (!s) {
      s = { position: new THREE.Vector3(), yaw: 0, tag: '' };
      this._pool[i] = s;
    }
    return s;
  }

  /**
   * Place every combatant in `list`. Mutates nothing on them — returns a Map of
   * combatant -> { position, yaw, tag }, whose values are pooled and only valid
   * until the next call.
   *
   * Fighters are dealt round-robin across their team's anchors, so a team of
   * five on three anchors goes 2/2/1 rather than 3/1/1. Whoever holds a given
   * seat is decided by registration order, which is stable across a match: the
   * player keeps the same starting position round to round, and so does each
   * bot. Rotating them would be a design decision, not a technical one, and the
   * stable version is the one you can learn a map from.
   */
  assign(list) {
    const out = this._byTeam;
    out.clear();
    if (!this.world) return out;

    /** Per-team running index, so slots are dealt in order within each side. */
    const seat = new Map();
    let slotId = 0;

    for (const c of list) {
      const anchors = this.world.spawnsFor(c.team);
      if (!anchors?.length) continue;
      const n = seat.get(c.team) ?? 0;
      seat.set(c.team, n + 1);

      const anchor = anchors[n % anchors.length];
      // Ring index: how many fighters already share this anchor.
      const ring = Math.floor(n / anchors.length);
      const s = this._slot(slotId++);
      this._place(s, anchor, ring, n);
      out.set(c, s);
    }
    return out;
  }

  /**
   * Resolve one seat: spiral offset, floor drop, fall back toward the anchor if
   * the offset landed somewhere the anchor's floor does not reach.
   */
  _place(slot, anchor, ring, seatIndex) {
    const a = anchor.position;
    slot.yaw = anchor.yaw ?? 0;
    slot.tag = anchor.tag ?? '';

    const baseY = this._floor(a.x, a.z, a.y);

    if (ring === 0) {
      slot.position.set(a.x, baseY, a.z);
      return slot;
    }

    // Try the full offset, then progressively shorter ones. A spawn point that
    // failed to find floor is a fighter dropped through the world, so the last
    // fallback is always the anchor itself — which physics already validated.
    const angle = seatIndex * GOLDEN_ANGLE;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    for (let r = ring * RING_STEP; r > 0.2; r -= 0.35) {
      const x = a.x + dx * r;
      const z = a.z + dz * r;
      const y = this._floor(x, z, a.y);
      if (Number.isFinite(y) && Math.abs(y - baseY) <= STEP_TOLERANCE) {
        slot.position.set(x, y, z);
        return slot;
      }
    }
    slot.position.set(a.x, baseY, a.z);
    return slot;
  }

  /** Floor Y under (x, z), probed from just above the authored spawn height. */
  _floor(x, z, fromY) {
    const gy = this.physics?.groundHeight(x, z, fromY + PROBE_UP);
    return Number.isFinite(gy) ? gy + 0.03 : fromY;
  }
}
