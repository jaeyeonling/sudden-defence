/**
 * Camera feel — and, kept deliberately separate from it, the AIM.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO VALUES, NOT ONE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This rig produces two transforms and they are not the same transform:
 *
 *   AIM     `aimOrigin` / `aimForward` / `aimPitch` / `aimYaw`
 *           Stepped in `stepAim()`, on the FIXED TICK. Command angles plus the
 *           recoil pattern, nothing else. This is what rounds fly along.
 *
 *   CAMERA  `eyePosition` / `rotation`
 *           Composed in `update()`, on the RENDERED FRAME. The aim plus every
 *           presentation channel below plus render interpolation. This is what
 *           the player looks through.
 *
 * `weapons.tryFire()` used to read the composed camera, which meant bob, breath
 * sway and trauma shake all steered live rounds — not as a decision anybody
 * made, but because the camera was the only transform in the building. Measured
 * at 20 m against a 0.2 m torso half-width and a 0.137 m rifle cone: breath
 * moved the impact 0.042 m, bob up to 0.087 m, and trauma shake at full
 * amplitude 0.47 m — three and a half times the weapon's own cone, so an
 * explosion took a gun's accuracy away more completely than its spread model
 * ever could. All three are presentation now.
 *
 * The other half of the reason is netcode. A shot that is a function of the
 * rendered frame cannot be stamped with a tick or replayed from a command, and
 * the recoil springs were integrated with the frame dt, so the same magazine
 * climbed differently at 60 and 144 fps. `stepAim` runs at the fixed rate, so
 * the aim is a pure function of the command stream. See `core/command.js`.
 *
 * WHAT IS STILL FRAME-RATE OWNED, on purpose: bob, breath, shake, the roll
 * channels, the positional springs (dip/step/punch) and FOV. None of them touch
 * a bullet, all of them want to be as smooth as the display is.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything a modern shooter does to make a floating pair of eyes read as a
 * body, layered so no single effect ever dominates:
 *
 *   eye height        stance-smoothed, so crouching is a movement not a cut
 *   view bob          1:2 Lissajous (figure-eight) locked to footstep cadence
 *   step micro-shift  a per-footfall vertical spring on top of the bob
 *   landing impact    dip + pitch + roll from the actual impact speed
 *   strafe / turn roll a degree of bank into the direction of travel
 *   breathing sway    two detuned sines, a constant idle wobble
 *   recoil            spring-damper impulse channel owned by the camera
 *   kick              a second, independent channel the weapon system pushes
 *   trauma shake      noise-driven, decays, used by explosions and heavy hits
 *   FOV               fixed, bar a hair of widening on a fall
 *
 * Position offsets are built in the *yaw* basis (not the full view basis) so
 * looking up does not turn vertical bob into forward/backward lurch.
 */

import * as THREE from 'three';
import { CAMERA, MOVE, STANCE } from './tuning.js';
import {
  Spring, RecoilAxis, clamp, clamp01, approach, hashNoise, DEG,
} from './springs.js';

export class CameraRig {
  /**
   * Snapshot classification (netcode step 5).
   *
   * This is the object the split in `710c630` was for, and it is the reason the
   * classification has to nest rather than run per subsystem: `player.rig` is
   * ONE field and only a third of it rewinds. The eight below are exactly what
   * `stepAim` writes on the fixed tick — the smoothed eye height (it sets the
   * ray's origin), the two recoil axes (they bend the ray), and the four aim
   * outputs `weapons` reads.
   *
   * Everything else is composed per rendered frame and must NOT be restored.
   * Bob, breath and trauma were measured putting 0.042 / 0.087 / 0.47 m of
   * error on a 20 m shot before the split — shake alone being 3.4x the rifle's
   * own cone. Capturing them would not merely be wasteful, it would restore a
   * presentation channel into the aim and quietly re-couple the two.
   *
   * `recoilRoll` is excluded with the other roll channels for the reason the
   * split recorded: rotation about the view axis does not move `forward`.
   */
  static snapshotState = [
    'eye', 'crouchBlend', 'recoilPitch', 'recoilYaw',
    'aimPitch', 'aimYaw', 'aimOrigin', 'aimForward',
  ];
  static excludedState = [
    'ctx', 'baseFov', 'fov', 'fovMove',
    'bobPhase', 'bobWeight', 'bobRoll', 'bobPitch', 'bobOffset',
    'dip', 'step', 'punch', 'kickPitch', 'kickYaw', 'kickRoll',
    'recoilRoll', 'strafeRoll', 'turnRoll', 'airRoll',
    'trauma', 'shakeTime', 'breathPhase',
    'viewKick', 'offset', 'eyePosition', 'rotation', 'forward', '_fwd', '_right',
  ];

  captureState(out = {}) {
    out.eye = this.eye;
    out.crouchBlend = this.crouchBlend;
    out.recoilPitch = this.recoilPitch.captureState(out.recoilPitch);
    out.recoilYaw = this.recoilYaw.captureState(out.recoilYaw);
    out.aimPitch = this.aimPitch;
    out.aimYaw = this.aimYaw;
    out.aimOrigin = [this.aimOrigin.x, this.aimOrigin.y, this.aimOrigin.z];
    out.aimForward = [this.aimForward.x, this.aimForward.y, this.aimForward.z];
    return out;
  }

  restoreState(s) {
    this.eye = s.eye;
    this.crouchBlend = s.crouchBlend;
    this.recoilPitch.restoreState(s.recoilPitch);
    this.recoilYaw.restoreState(s.recoilYaw);
    this.aimPitch = s.aimPitch;
    this.aimYaw = s.aimYaw;
    this.aimOrigin.set(s.aimOrigin[0], s.aimOrigin[1], s.aimOrigin[2]);
    this.aimForward.set(s.aimForward[0], s.aimForward[1], s.aimForward[2]);
  }

  constructor(ctx) {
    this.ctx = ctx;
    const C = CAMERA;

    // ---- smoothed stance -------------------------------------------------
    this.eye = 1.66;
    this.crouchBlend = 0;

    // ---- bob -------------------------------------------------------------
    this.bobPhase = 0;
    this.bobWeight = 0;
    this.bobRoll = 0;
    this.bobPitch = 0;

    // ---- springs ---------------------------------------------------------
    this.dip = new Spring(C.land.freq, C.land.damping, 0); // landing
    this.step = new Spring(C.step.freq, C.step.damping, 0); // footfall
    this.recoilPitch = new RecoilAxis(C.recoil.freq, C.recoil.damping, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilYaw = new RecoilAxis(C.recoil.freq * 1.08, C.recoil.damping + 0.06, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilRoll = new RecoilAxis(C.recoil.freq * 0.86, C.recoil.damping + 0.1, C.recoil.residualTau, 0.24);
    this.punch = new Spring(C.recoil.punchFreq, C.recoil.punchDamping, 0);
    /**
     * Second, independent channel, and PRESENTATION ONLY.
     *
     * It has no callers. The comment here used to say `weapons` pushes into it;
     * `weapons` pushes into `addRecoil`, and `addKick` is reachable from
     * `player.addKick` and invoked by nothing in the tree. Left in place because
     * it is a documented seam and the split above gives it a meaning it did not
     * have: a channel that shakes the view without moving the round. Anything
     * that should move the round belongs in `stepAim`, on the tick.
     */
    this.kickPitch = new RecoilAxis(11, 0.58, 0.22, 0.28);
    this.kickYaw = new RecoilAxis(11.5, 0.6, 0.22, 0.28);
    this.kickRoll = new RecoilAxis(9, 0.62, 0.22, 0.22);

    // ---- rolls -----------------------------------------------------------
    this.strafeRoll = 0;
    this.turnRoll = 0;
    this.airRoll = 0;

    // ---- shake -----------------------------------------------------------
    this.trauma = 0;
    this.shakeTime = 0;

    // ---- breathing -------------------------------------------------------
    this.breathPhase = 0;

    // ---- fov -------------------------------------------------------------
    this.baseFov = ctx.config.fov;
    this.fov = this.baseFov;
    this.fovMove = 1;

    // ---- AIM: the simulation half, stepped on the fixed tick -------------
    // Read by `weapons` through `player.aimOrigin` / `player.aimForward`.
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.aimOrigin = new THREE.Vector3();
    this.aimForward = new THREE.Vector3(0, 0, -1);

    // ---- outputs (read by weapons for counter-motion) --------------------
    this.viewKick = { pitch: 0, yaw: 0, roll: 0, punch: 0 };
    this.bobOffset = new THREE.Vector3();
    this.offset = new THREE.Vector3();
    this.eyePosition = new THREE.Vector3();
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ');
    this.forward = new THREE.Vector3(0, 0, -1);

    // scratch
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  reset(eye) {
    this.eye = eye;
    this.bobPhase = 0;
    this.bobWeight = 0;
    this.dip.reset(0);
    this.step.reset(0);
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.recoilRoll.reset();
    this.kickPitch.reset();
    this.kickYaw.reset();
    this.kickRoll.reset();
    this.punch.reset(0);
    this.trauma = 0;
    this.strafeRoll = 0;
    this.turnRoll = 0;
    this.fovMove = 1;
  }

  /* ==================================================================== */
  /* impulses — the public feel API                                       */
  /* ==================================================================== */

  /** Camera-owned recoil. Angles in radians; `punch` in metres. */
  addRecoil(pitch = 0, yaw = 0, roll = 0, punch = 0) {
    this.recoilPitch.kick(pitch);
    this.recoilYaw.kick(yaw);
    this.recoilRoll.kick(roll);
    if (punch) this.punch.impulse(-punch * 14);
  }

  /** Weapon-driven kick — a separate channel so the two never fight. */
  addKick(pitch = 0, yaw = 0, roll = 0) {
    this.kickPitch.kick(pitch);
    this.kickYaw.kick(yaw);
    this.kickRoll.kick(roll);
  }

  addTrauma(a) {
    this.trauma = clamp01(this.trauma + a);
  }

  onLand(speed) {
    const L = CAMERA.land;
    const t = clamp01((speed - L.minSpeed) / (L.fullSpeed - L.minSpeed));
    if (t <= 0) return 0;
    // Perceptual curve: a 3 m/s landing should still be felt a little.
    const mag = Math.pow(t, 0.72);
    this.dip.impulse(-L.dipImpulse * mag);
    this.recoilPitch.kick(L.pitch * mag);
    this.recoilRoll.kick(L.roll * mag);
    this.addTrauma(L.trauma * mag * mag);
    return mag;
  }

  onFootstep(running, stance) {
    const S = CAMERA.step;
    const amp = stance === 'crouch' ? S.impulse * 0.55 : S.impulse;
    this.step.impulse(-amp);
  }

  /* ==================================================================== */
  /* per-tick simulation — the AIM                                        */
  /* ==================================================================== */

  /**
   * Advance the half of this rig that a bullet is allowed to see.
   *
   * Called from `player.fixedUpdate`, at the fixed rate, ALWAYS — including
   * when control is disabled. A harness that teleports the player, freezes it
   * and fires still needs a direction, and before the aim moved off the camera
   * it got one for free because the camera was composed regardless.
   * `tools/ballistics.mjs` fires 960 rounds that way.
   *
   * Eye height rides along rather than staying with the camera. It is not a
   * presentation detail — it decides what you can see over and where the round
   * leaves from — and a smoothing integrated on the frame would put the muzzle
   * at a different height than the tick during every crouch transition. At 20 m
   * the ~0.3 m of stance travel is 0.3 m of vertical miss, which is more than a
   * torso half-width.
   *
   * @param {number} h  fixed step, seconds
   * @param {import('./movement.js').Movement} m
   */
  stepAim(h, m) {
    // ---- stance / eye height --------------------------------------------
    const targetEye = m.eyeHeight;
    const growing = targetEye > this.eye;
    const tau = growing ? MOVE.stanceTau.crouchStand : MOVE.stanceTau.standCrouch;
    this.eye = approach(this.eye, targetEye, tau, h);
    this.crouchBlend = clamp01(1 - (this.eye - 1.0) / 0.66);

    // ---- recoil, the only channel that steers a round --------------------
    // Roll is NOT here and does not need to be: a rotation about the view axis
    // leaves the forward vector untouched, so `recoilRoll` is presentation by
    // construction rather than by choice. It steps with the camera.
    this.recoilPitch.step(h);
    this.recoilYaw.step(h);

    this.aimPitch = clamp(
      m.pitch + this.recoilPitch.value, -CAMERA.pitchLimit, CAMERA.pitchLimit
    );
    this.aimYaw = m.yaw + this.recoilYaw.value;

    // The SIMULATION eye: this tick's position, not the interpolated render
    // position and none of the presentation offsets. The camera is drawn from
    // somewhere between the last two ticks, so a round leaves from up to one
    // tick ahead of what is on screen — 4 cm at 5 m/s and 120 Hz. That is the
    // correct direction for the error to point: the shot belongs to the tick.
    this.aimOrigin.set(m.position.x, m.position.y + this.eye, m.position.z);

    // Forward for a YXZ euler with roll dropped. Written out rather than routed
    // through a quaternion because this runs every tick and allocates nothing.
    const cp = Math.cos(this.aimPitch);
    this.aimForward.set(
      -Math.sin(this.aimYaw) * cp,
      Math.sin(this.aimPitch),
      -Math.cos(this.aimYaw) * cp
    );
  }

  /* ==================================================================== */
  /* per-frame composition                                                */
  /* ==================================================================== */

  /**
   * @param {number} dt
   * @param {import('./movement.js').Movement} m
   * @param {object} health  { fraction, low }
   */
  update(dt, m, health) {
    const C = CAMERA;
    const cfg = this.ctx.config;

    // Eye height and the two aim-bearing recoil axes are NOT stepped here —
    // they belong to `stepAim` and the tick. See the header.

    // ---- yaw basis -------------------------------------------------------
    const sy = Math.sin(m.yaw), cy = Math.cos(m.yaw);
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);

    // ---- bob -------------------------------------------------------------
    this._updateBob(dt, m);

    // ---- springs ---------------------------------------------------------
    this.dip.step(dt);
    this.step.step(dt);
    this.punch.step(dt);
    this.recoilRoll.step(dt);
    this.kickPitch.step(dt);
    this.kickYaw.step(dt);
    this.kickRoll.step(dt);

    // ---- rolls -----------------------------------------------------------
    const R = C.roll;
    const strafeTarget = -m.cmd.moveX * R.strafe * (m.grounded ? 1 : 0.45);
    this.strafeRoll = approach(this.strafeRoll, strafeTarget, R.tau, dt);
    const turnTarget = clamp(m.yawRate * R.yawRate, -R.yawRateMax, R.yawRateMax);
    this.turnRoll = approach(this.turnRoll, turnTarget, R.tau * 1.4, dt);
    const airTarget = m.grounded ? 0 : clamp(-m.velocity.y * 0.02, -1, 1) * R.air;
    this.airRoll = approach(this.airRoll, airTarget, 0.22, dt);

    // ---- trauma shake ----------------------------------------------------
    const S = C.shake;
    this.trauma = Math.max(0, this.trauma - S.decay * dt);
    const shake = this.trauma * this.trauma;
    this.shakeTime += dt * S.freq;
    let shakePitch = 0, shakeYaw = 0, shakeRoll = 0, shakeX = 0, shakeY = 0;
    if (shake > 1e-4) {
      shakePitch = hashNoise(this.shakeTime, 11) * shake * S.rot * DEG;
      shakeYaw = hashNoise(this.shakeTime + 31.7, 23) * shake * S.rot * DEG;
      shakeRoll = hashNoise(this.shakeTime + 57.1, 37) * shake * S.rot * 0.7 * DEG;
      shakeX = hashNoise(this.shakeTime * 0.8 + 13.3, 41) * shake * S.pos;
      shakeY = hashNoise(this.shakeTime * 0.8 + 71.9, 53) * shake * S.pos;
    }

    // ---- breathing sway --------------------------------------------------
    const B = C.breath;
    const moveFactor = clamp01(m.horizontalSpeed / 2.2);
    // Sway is a constant idle wobble, not a wound/suppression readout: with no
    // ADS there is no scope to magnify hold error, and a camera that gets less
    // steady as you lose health punishes the player twice for one mistake.
    let amp = B.amp;
    amp *= 1 - B.moveDamp * moveFactor;
    this.breathPhase += dt;
    const bA = Math.sin(this.breathPhase * Math.PI * 2 * B.freqA);
    const bB = Math.sin(this.breathPhase * Math.PI * 2 * B.freqB + 1.7);
    const breathPitch = (bA * 0.7 + bB * 0.3) * amp;
    const breathYaw = (bB * 0.75 - bA * 0.25) * amp * 1.15;
    const breathPos = (bA * 0.6 + bB * 0.4) * B.posAmp * (1 - 0.8 * moveFactor);

    // ---- assemble position ----------------------------------------------
    const base = m.sampleRender(this.ctx.time.alpha);
    const bobX = this.bobOffset.x;
    const bobY = this.bobOffset.y;
    const bobZ = this.bobOffset.z;

    const lateral = bobX + shakeX;
    const vertical = bobY + this.dip.value + this.step.value + shakeY + breathPos;
    const forward = bobZ + this.punch.value;

    this.offset.set(0, 0, 0);
    this.offset.addScaledVector(this._right, lateral);
    this.offset.addScaledVector(this._fwd, forward);
    this.offset.y += vertical;

    this.eyePosition.set(
      base.x + this.offset.x,
      base.y + this.eye + this.offset.y,
      base.z + this.offset.z
    );

    // ---- assemble rotation ----------------------------------------------
    // Built ON TOP of the tick's aim, not alongside it. `aimPitch` already
    // carries `m.pitch` and the recoil spring; everything added here is a
    // presentation channel that deliberately does not reach the round.
    const pitch = clamp(
      this.aimPitch + this.kickPitch.value + breathPitch + this.bobPitch + shakePitch,
      -CAMERA.pitchLimit,
      CAMERA.pitchLimit
    );
    const yaw = this.aimYaw + this.kickYaw.value + breathYaw + shakeYaw;
    const roll =
      this.strafeRoll + this.turnRoll + this.airRoll +
      this.bobRoll + this.recoilRoll.value + this.kickRoll.value + shakeRoll;

    this.rotation.set(pitch, yaw, roll);

    // ---- FOV -------------------------------------------------------------
    // FOV is constant except for a hair of widening on a fall. Aim is built on
    // a fixed horizontal FOV; anything that breathes it moves every sightline
    // the player has memorised.
    const F = C.fov;
    const moveTarget = !m.grounded && m.velocity.y < -6 ? F.air : 1;
    this.fovMove = approach(this.fovMove, moveTarget, F.moveTau, dt);
    this.baseFov = cfg.fov;
    this.fov = this.baseFov * this.fovMove;

    // ---- publish the kick channel for the viewmodel ----------------------
    this.viewKick.pitch = this.recoilPitch.value + this.kickPitch.value;
    this.viewKick.yaw = this.recoilYaw.value + this.kickYaw.value;
    this.viewKick.roll = this.recoilRoll.value + this.kickRoll.value;
    this.viewKick.punch = this.punch.value;
  }

  _updateBob(dt, m) {
    const B = CAMERA.bob;
    const speed = m.horizontalSpeed;

    // Phase comes from the movement machine's gait accumulator (pi per footfall)
    // rather than being integrated here, so the bob can never drift out of sync
    // with the footstep events after a jump or a stance change. The +pi/2 offset
    // puts the horizontal extreme exactly on the footfall.
    this.bobPhase = m.stepPhase + Math.PI * 0.5;

    // Weight: speed-scaled but sub-linear, faded out entirely in the air.
    // Normalised against base run speed so a full-speed run is weight 1.
    let w = Math.min(B.speedCap, Math.pow(speed / STANCE.stand.speed, B.speedExp));
    if (!m.grounded) w = 0;
    this.bobWeight = approach(this.bobWeight, w, B.airFade, dt);

    const th = this.bobPhase;
    const wt = this.bobWeight;
    this.bobOffset.set(
      Math.sin(th) * B.ampX * wt,
      Math.sin(th * 2) * B.ampY * wt,
      Math.cos(th * 2) * B.ampZ * wt
    );
    this.bobRoll = -Math.sin(th) * B.roll * wt;
    this.bobPitch = Math.cos(th * 2) * B.pitch * wt;
  }

  /** Write the composed transform onto the engine camera. */
  applyTo(camera) {
    camera.position.copy(this.eyePosition);
    camera.rotation.set(this.rotation.x, this.rotation.y, this.rotation.z);
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }
}
