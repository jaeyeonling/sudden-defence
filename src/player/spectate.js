/**
 * SPECTATOR — the camera you get after you die.
 *
 * This lives in `player`, not in `ui`, and the split is worth stating because
 * the obvious reading of "spectate mode" puts the whole thing in the HUD.
 *
 *   the CAMERA is here          — `player` owns the camera transform, full stop.
 *                                 Two systems writing `ctx.camera.position` on
 *                                 the same frame is a race decided by update
 *                                 order, and update order is the dependency
 *                                 graph, which is not where camera authority
 *                                 should be decided.
 *   the OVERLAY is in ui        — `ui/spectate.js`, which reads
 *                                 `player.spectateTarget` and draws a name.
 *
 * Death is final for the round (see ARCHITECTURE.md, "Rounds, not respawns"),
 * so this runs for whole minutes at a time and is the only thing a dead player
 * has to look at. It follows a living team-mate over the shoulder rather than
 * going free-cam: free-cam through walls is a wallhack you hand the player for
 * the price of dying, and in a round game the rest of your team is still in it.
 */

import * as THREE from 'three';
import { dcos, dexp, dsin } from '../core/dmath.js';

/** Metres behind the followed fighter's head. */
const BACK = 2.55;
/** Metres above it. */
const RISE = 0.5;
/** How fast the camera converges on the ideal pose (exponential, per second). */
const FOLLOW = 7.5;
/** Keep the camera this far off any surface it would otherwise clip into. */
const SKIN = 0.22;

export class Spectator {
  constructor(ctx) {
    this.ctx = ctx;
    /** The Combatant being followed, or null. */
    this.target = null;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._settled = false;
  }

  reset() {
    this.target = null;
    this._settled = false;
  }

  /**
   * Living team-mates of `self`, in registration order. Reused array owned by
   * `match` — read it now, do not keep it.
   */
  _allies(match, self) {
    return match?.alliesOf(self) ?? [];
  }

  /** Step to the next (or previous) living team-mate. */
  cycle(match, self, dir = 1) {
    const list = this._allies(match, self);
    if (!list.length) {
      this.target = null;
      return null;
    }
    const at = list.indexOf(this.target);
    const n = list.length;
    // -1 (target gone or never set) steps to 0 for dir=+1, which is what you
    // want: the first cycle after a death picks the first ally, not the last.
    const next = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
    this.target = list[next];
    this._settled = false;
    return this.target;
  }

  /**
   * Place the camera. Returns true if it took the camera this frame.
   *
   * @param {number} dt
   * @param {object} match
   * @param {object} self    the local player's Combatant
   * @param {THREE.Camera} camera
   * @param {object} physics
   */
  /**
   * Pull `point` toward `head` until the segment between them is clear.
   *
   * Mutates `point` in place and returns it. `SKIN` keeps the near plane off the
   * surface — stopping exactly on the hit puts the camera flush against the wall
   * and the frustum still slices into it.
   */
  _pullIn(point, head, physics) {
    if (!physics) return point;
    this._dir.copy(point).sub(head);
    const dist = this._dir.length();
    if (dist <= 1e-4) return point;
    this._dir.multiplyScalar(1 / dist);
    const hit = physics.raycast(
      head.x, head.y, head.z,
      this._dir.x, this._dir.y, this._dir.z,
      dist, physics.MASK.SIGHT
    );
    if (hit.hit) {
      point.copy(head).addScaledVector(this._dir, Math.max(0.2, hit.distance - SKIN));
    }
    return point;
  }

  update(dt, match, self, camera, physics) {
    // Re-target when the current one dies or leaves the roster. Doing it here
    // rather than on a `combatant:death` handler means it also covers a target
    // that was unregistered, and it costs one `.alive` read a frame.
    if (!this.target || !this.target.alive) {
      const list = this._allies(match, self);
      this.target = list.length ? list[0] : null;
      this._settled = false;
    }
    const t = this.target;
    if (!t) return false;

    // ---- ideal pose ------------------------------------------------------
    const head = this._head.copy(t.head);
    const yaw = t.viewYaw;
    // World convention: forward is (-sin, 0, -cos), so BEHIND is (+sin, +cos).
    const bx = dsin(yaw);
    const bz = dcos(yaw);
    const want = this._want.set(head.x + bx * BACK, head.y + RISE, head.z + bz * BACK);

    // ---- do not put the camera inside a wall -----------------------------
    // Trace from the head outward. A chase camera that clips through the crate
    // its subject is hiding behind shows the player the far side of their own
    // cover, which is exactly the information spectating is supposed to deny.
    this._pullIn(want, head, physics);

    // ---- converge --------------------------------------------------------
    if (!this._settled) {
      this._pos.copy(want);
      this._look.copy(head);
      this._settled = true;
    } else {
      const a = 1 - dexp(-FOLLOW * Math.max(dt, 1e-4));
      this._pos.lerp(want, a);
      this._look.lerp(head, a);
    }

    // Clamp the SMOOTHED position too, not only the target it is heading for.
    //
    // Clamping `want` alone constrains where the camera is going and says
    // nothing about where it is: `_pos` lags `want` by the follow time, so the
    // instant a subject steps behind a wall the ideal pose snaps in tight while
    // the actual camera is still out where the wall now is, and it sits inside
    // the geometry for as long as the lerp takes. That is what
    // `shots/play2/07-spectate.png` caught — a concrete slab across the right
    // half of the frame with the spectated body cut in two by it.
    //
    // The trace is the same one, run once more against the position actually
    // handed to the camera, so no frame can be drawn from inside the world.
    this._pullIn(this._pos, head, physics);

    camera.position.copy(this._pos);
    camera.lookAt(this._look);
    camera.updateMatrixWorld();
    return true;
  }
}
