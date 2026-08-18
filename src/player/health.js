/**
 * Health and the damage-direction model.
 *
 * NO REGENERATION. Damage is permanent for the round; the only thing that
 * restores health is a round reset calling reset(). This is the single largest
 * behavioural departure from the shooter this code came from, and it is what
 * makes trading damage a real decision instead of a temporary inconvenience.
 *
 * Damage arriving from a direction produces an indicator (angle in *view*
 * space, so the HUD can draw it without knowing anything about the player's
 * transform) and a matching camera impulse, so a hit is felt before it is read.
 */

import * as THREE from 'three';
import { HEALTH } from './tuning.js';
import { clamp01, approach, DEG } from './springs.js';
import { datan2, dcos, dsin } from '../core/dmath.js';

export class Health {
  /**
   * Snapshot classification (netcode step 5). Health never regenerates, so the
   * simulation half is small: the number, whether it reached zero, and the two
   * fields that throttle `player:health` emission (a replay that re-emitted on
   * a different tick than the original pass would be a divergence the HUD, not
   * the world, went looking for).
   *
   * `hitFlash`, `indicators` and `effect` are the damage vignette and the
   * directional arrows — screen furniture that happens to be driven by damage.
   */
  static snapshotState = ['value', 'dead', 'lastDamageTime', 'lastPart', '_emitTimer', '_lastEmitHealth'];
  static excludedState = ['ctx', 'rig', 'max', 'hitFlash', 'indicators', 'effect', '_payload', '_statePayload'];

  captureState(out = {}) {
    for (const k of Health.snapshotState) out[k] = this[k];
    return out;
  }

  restoreState(s) {
    for (const k of Health.snapshotState) this[k] = s[k];
  }

  constructor(ctx, rig) {
    this.ctx = ctx;
    this.rig = rig;
    this.max = HEALTH.max;
    this.value = HEALTH.max;
    this.dead = false;
    this.lastDamageTime = -100;
    // Declared here rather than springing into existence on the first hit. The
    // snapshot audit found it missing, which is the mild face of the problem: a
    // field that appears partway through a match cannot be restored by a capture
    // taken before it appeared, and `player:death` reads it.
    this.lastPart = 'torso';
    this.hitFlash = 0;

    /** Direction indicators, oldest first. angle is radians, 0 = straight ahead. */
    this.indicators = [];
    for (let i = 0; i < HEALTH.indicatorMax; i++) {
      this.indicators.push({ active: false, angle: 0, amount: 0, life: 0, worldX: 0, worldY: 0, worldZ: 0 });
    }

    /** 0..1 low-health weight. The HUD reads it; there is no screen treatment. */
    this.effect = 0;

    this._payload = { amount: 0, from: new THREE.Vector3(), health: 0, direction: 0, critical: false };
    this._statePayload = {
      health: HEALTH.max, fraction: 1, low: false, critical: false,
      dead: false,
    };
    this._emitTimer = 0;
    this._lastEmitHealth = HEALTH.max;
  }

  get fraction() {
    return clamp01(this.value / this.max);
  }

  get low() {
    return this.fraction < HEALTH.lowThreshold;
  }

  get critical() {
    return this.fraction < HEALTH.criticalThreshold;
  }

  reset(full = true) {
    if (full) this.value = this.max;
    this.dead = false;
    this.hitFlash = 0;
    this.lastDamageTime = -100;
    for (let k = 0; k < this.indicators.length; k++) this.indicators[k].active = false;
  }

  /* ==================================================================== */

  /**
   * @param {number} amount
   * @param {THREE.Vector3|null} from  world position of the attacker/blast
   * @param {object} opts { yaw, type, part, source }
   *   `part` is the hitbox that was struck ('head' | 'torso' | 'arm' | 'leg');
   *   the caller has already applied its damage scale, we keep it only so the
   *   flinch and the death event can distinguish a headshot.
   */
  damage(amount, from, opts = {}) {
    if (this.dead || amount <= 0) return 0;
    const before = this.value;
    this.value = Math.max(0, this.value - amount);
    // `sim`, not `elapsed`: this is captured state, so an absolute stamp taken
    // off frame time would mean something different after a rewind.
    this.lastDamageTime = this.ctx.time.sim;
    const dealt = before - this.value;
    this.lastPart = opts.part ?? 'torso';

    // ---- direction in view space ---------------------------------------
    let angle = 0;
    if (from) {
      const yaw = opts.yaw ?? this.ctx.camera.rotation.y;
      const dx = from.x - this.ctx.camera.position.x;
      const dz = from.z - this.ctx.camera.position.z;
      // Forward at yaw is (-sin, -cos); right is (cos, -sin).
      const f = -dsin(yaw) * dx - dcos(yaw) * dz;
      const r = dcos(yaw) * dx - dsin(yaw) * dz;
      angle = datan2(r, f);
      this._pushIndicator(angle, dealt, from);
    }

    // ---- felt response --------------------------------------------------
    // Severity saturates at 45 in a 100 HP game where a rifle body shot is ~33
    // and a headshot is lethal — so most hits land in the upper half of the
    // curve and read as heavy, which is the intent at this TTK.
    const severity = clamp01(dealt / 45);
    this.hitFlash = clamp01(this.hitFlash + 0.85 * (0.4 + severity));
    if (this.rig) {
      // Punch the camera away from the hit: pitch up, yaw and roll off-axis.
      const s = 0.6 + severity * 1.9;
      this.rig.addRecoil(
        (1.1 + severity) * DEG * s * 0.7,
        -dsin(angle) * (1.4 * DEG) * s,
        -dsin(angle) * (2.2 * DEG) * s,
        0.008 * s
      );
      this.rig.addTrauma(0.22 * s);
    }

    const p = this._payload;
    p.amount = dealt;
    p.health = this.value;
    p.direction = angle;
    p.critical = this.critical;
    if (from) p.from.copy(from);
    else p.from.set(this.ctx.camera.position.x, this.ctx.camera.position.y, this.ctx.camera.position.z);
    this.ctx.events.emit('damage:taken', p);

    if (this.value <= 0) {
      this.dead = true;
      this.ctx.events.emit('player:death', {
        position: this.ctx.camera.position,
        part: this.lastPart,
        headshot: this.lastPart === 'head',
        source: opts.source ?? null,
      });
      // The shared death event, same shape as Agent's — ARCHITECTURE.md lists
      // `player` as an emitter and fx/audio hang the mist and the bodyfall off
      // it. physics' ragdoll listener early-returns on a skeleton-less actor,
      // so a first-person host passes through it untouched.
      this.ctx.events.emit('actor:death', {
        actor: this,
        point: this.ctx.camera.position,
        impulse: null,
        headshot: this.lastPart === 'head',
      });
      // (allocations on death are fine — it happens once)
    }
    this._emitState(true);
    return dealt;
  }

  heal(amount) {
    this.value = Math.min(this.max, this.value + amount);
  }

  _pushIndicator(angle, amount, from) {
    // Reuse the slot pointing the most similar way, else the oldest.
    let slot = null;
    let oldest = null;
    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) { slot = i; break; }
      if (Math.abs(angle - i.angle) < 0.5) { slot = i; break; }
      if (!oldest || i.life > oldest.life) oldest = i;
    }
    slot = slot ?? oldest ?? this.indicators[0];
    slot.active = true;
    slot.angle = angle;
    slot.amount = Math.max(slot.active ? slot.amount * 0.5 : 0, amount);
    slot.life = 0;
    slot.worldX = from.x; slot.worldY = from.y; slot.worldZ = from.z;
  }

  /* ==================================================================== */

  update(dt) {
    const H = HEALTH;

    // No regeneration pass. Health only ever goes down between resets.
    this.hitFlash = approach(this.hitFlash, 0, 0.22, dt);

    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) continue;
      i.life += dt;
      if (i.life > H.indicatorTime) i.active = false;
    }

    // ---- low-health weight (HUD reads it; no screen treatment) ----------
    const f = this.fraction;
    this.effect = approach(this.effect, clamp01((H.lowThreshold - f) / H.lowThreshold), 0.25, dt);

    this._emitTimer -= dt;
    if (this._emitTimer <= 0) {
      this._emitTimer = 0.1;
      if (Math.abs(this.value - this._lastEmitHealth) > 0.4) this._emitState(false);
    }
  }

  _emitState(force) {
    const s = this._statePayload;
    const wasLow = s.low;
    s.health = this.value;
    s.fraction = this.fraction;
    s.low = this.low;
    s.critical = this.critical;
    s.dead = this.dead;
    this._lastEmitHealth = this.value;
    s.changedLowState = wasLow !== s.low;
    s.forced = !!force;
    this.ctx.events.emit('player:health', s);
  }
}
