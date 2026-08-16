/**
 * The movement state machine.
 *
 * Runs at the fixed 120 Hz step so the feel is framerate-independent and
 * reproducible in capture mode. Collision is *entirely* delegated to
 * `physics.createCharacter()` — this file only ever owns velocity and asks the
 * controller to resolve a displacement.
 *
 * States: stand · crouch · jump · fall
 *
 * That is the whole vocabulary, deliberately. No sprint, no slide, no mantle,
 * no lean, no prone — movement is a flat skill floor so that duels are decided
 * by aim and positioning rather than by movement tech. Everything here is
 * interruptible; nothing waits on an animation.
 */

import * as THREE from 'three';
import { BTN } from '../core/command.js';
import { STANCE, MOVE, GRAVITY, JUMP_SPEED, FOOTSTEP } from './tuning.js';
import { clamp, clamp01 } from './springs.js';
import { dcos, dsin, hypot2, hypot3 } from '../core/dmath.js';

export const STATES = ['stand', 'crouch', 'jump', 'fall'];

export class Movement {
  /**
   * Snapshot classification (netcode step 5).
   *
   * THE FOOTSTEP ACCUMULATORS ARE SIMULATION. `_stepDistance`, `_bobDistance`,
   * `_bobPhase`, `_footLeft`, `_footHold` and `stepEvent` look like they exist
   * to play a sound, and the sound is the least of what they do: every step
   * emits `player:footstep`, and `ai/index.js` turns that into
   * `agent.hear(position, running ? 24 : 11)`. The distance counter decides WHEN
   * a bot notices the player. Filing it under presentation because its other
   * consumer is the mixer would drop the player's audibility out of the
   * snapshot, and the bot that heard nothing would be a bot the replay invented.
   *
   * `character` and `cmd` are excluded because they are owned elsewhere — the
   * capsule by `physics`, the command by the ring in `core/command.js`. Both
   * rewind; neither rewinds from here.
   *
   * `renderPosition` is the interpolated draw pose, and interpolation is a
   * function of `alpha`, which a replay does not have.
   */
  static snapshotState = [
    'state', 'prevState', 'stateTime', 'stance', 'stanceWant',
    'grounded', 'wasGrounded', 'airTime', 'groundTime',
    'speed', 'horizontalSpeed', 'blocked', 'jumped',
    'yaw', 'pitch', 'yawRate', 'controlEnabled',
    '_coyote', '_jumpBuffer', '_jumpCooldown', '_prevVy',
    '_stepDistance', '_bobDistance', '_bobPhase', '_footLeft', '_footHold',
    'position', 'prevPosition', 'velocity',
    'landEvent', 'stepEvent',
  ];
  static excludedState = [
    'ctx', 'player', 'physics', 'character', 'cmd',
    'renderPosition', '_fwd', '_right', '_wish',
  ];

  captureState(out = {}) {
    for (const k of Movement.snapshotState) {
      const v = this[k];
      if (v && v.isVector3) out[k] = [v.x, v.y, v.z];
      else if (v && typeof v === 'object') out[k] = { ...v };
      else out[k] = v;
    }
    return out;
  }

  restoreState(s) {
    for (const k of Movement.snapshotState) {
      const cur = this[k];
      const v = s[k];
      if (cur && cur.isVector3) cur.set(v[0], v[1], v[2]);
      else if (cur && typeof cur === 'object' && v && typeof v === 'object') Object.assign(cur, v);
      else this[k] = v;
    }
  }

  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.physics = null;
    this.character = null;

    // ---- authored state ------------------------------------------------
    this.state = 'stand';
    this.prevState = 'stand';
    this.stateTime = 0;
    this.stance = 'stand'; // physical stance: stand | crouch
    this.stanceWant = 'stand';
    this.grounded = true;
    this.wasGrounded = true;
    this.airTime = 0;
    this.groundTime = 0;
    this.speed = 0;
    this.horizontalSpeed = 0;
    this.blocked = false;

    // ---- yaw/pitch are owned here so movement and camera never disagree --
    this.yaw = 0;
    this.pitch = 0;
    this.yawRate = 0;

    // ---- externally driven ---------------------------------------------
    this.controlEnabled = true;

    // ---- timers --------------------------------------------------------
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpCooldown = 0;
    this._stepDistance = 0;
    this._bobDistance = 0;
    this._bobPhase = 0;
    this._footLeft = false;
    this._footHold = 0;

    /** One-shot flag consumed (and cleared) by PlayerSystem each frame. */
    this.jumped = false;

    // ---- input snapshot (one tick's command, unpacked) ------------------
    this.cmd = {
      moveX: 0, moveY: 0,
      jump: false, jumpHeld: false,
      crouchPressed: false, crouchHeld: false,
    };

    // ---- interpolation for the camera ----------------------------------
    this.prevPosition = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.renderPosition = new THREE.Vector3();

    // ---- events / outputs ----------------------------------------------
    /** Set on the step we land; consumed by PlayerSystem. */
    this.landEvent = { pending: false, speed: 0, surface: 'concrete' };
    this.stepEvent = { pending: false, running: false, surface: 'concrete', x: 0, y: 0, z: 0, left: false };

    // scratch
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._prevVy = 0;
  }

  /* ==================================================================== */
  /* setup                                                                */
  /* ==================================================================== */

  init(physics, spawn) {
    this.physics = physics;
    this.character = physics.createCharacter({
      id: 'player',
      owner: this.player,
      radius: 0.32,
      height: STANCE.stand.height,
      stepHeight: STANCE.stand.stepHeight,
      slopeLimit: 48 * (Math.PI / 180),
      snapDistance: 0.34,
    });
    if (spawn) {
      this.character.teleport(spawn.x, spawn.y, spawn.z);
    }
    this.position.set(this.character.position.x, this.character.position.y, this.character.position.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    return this.character;
  }

  dispose() {
    if (this.character && this.physics) this.physics.removeCharacter(this.character);
    this.character = null;
  }

  get stanceDef() {
    return STANCE[this.stance];
  }

  /** Eye height for the *current* stance, before camera smoothing. */
  get eyeHeight() {
    return STANCE[this.stance].eye;
  }

  /* ==================================================================== */
  /* input                                                                */
  /* ==================================================================== */

  /**
   * Unpack this tick's command. Called once per fixed step, from
   * `PlayerSystem.fixedUpdate`, with `ctx.commands.current`.
   *
   * There is no frame guard and no previous-held state any more: the stream
   * (`core/command.js`) already guarantees exactly one command per tick and
   * already turned presses into one-tick pulses. This method is a decode, not a
   * sampler, which is what makes the source swappable — a command that arrived
   * over a wire unpacks through the identical path.
   *
   * A null command means the engine has not ticked yet. Treat it as neutral
   * rather than as "keep doing whatever you were doing".
   */
  applyCommand(cmd) {
    const c = this.cmd;
    if (!this.controlEnabled || !cmd) {
      c.moveX = 0; c.moveY = 0;
      c.jump = false; c.jumpHeld = false;
      c.crouchPressed = false; c.crouchHeld = false;
      return;
    }

    c.moveX = cmd.moveX;
    c.moveY = cmd.moveY;

    c.jump = (cmd.edge & BTN.jump) !== 0;
    c.jumpHeld = (cmd.held & BTN.jump) !== 0;
    // Crouch is HOLD, not toggle: you duck behind a crate for the length of a
    // peek and stand the moment you release. A toggle costs a keypress on the
    // way out of cover, which is exactly the moment you cannot spare one.
    c.crouchPressed = (cmd.edge & BTN.crouch) !== 0;
    c.crouchHeld = (cmd.held & BTN.crouch) !== 0;

    if (c.jump) this._jumpBuffer = MOVE.jumpBuffer;
  }

  /* ==================================================================== */
  /* the fixed step                                                       */
  /* ==================================================================== */

  step(h) {
    const c = this.character;
    if (!c) return;
    const cmd = this.cmd;

    this.prevPosition.copy(this.position);
    this.stateTime += h;
    this._tickTimers(h);

    // Basis for this step.
    const sy = dsin(this.yaw), cy = dcos(this.yaw);
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);

    // ---- wish direction, with directional speed weighting ---------------
    const mx = cmd.moveX;
    const my = cmd.moveY;
    const rawInput = hypot2(mx, my);
    const sx = mx * MOVE.strafeScale;
    const sz = my >= 0 ? my : my * MOVE.backScale;
    let wishLen = hypot2(sx, sz);
    const wish = this._wish;
    if (wishLen > 1e-5) {
      wish.set(
        this._fwd.x * sz + this._right.x * sx,
        0,
        this._fwd.z * sz + this._right.z * sx
      );
      const l = hypot2(wish.x, wish.z);
      wish.x /= l; wish.z /= l;
      if (wishLen > 1) wishLen = 1;
    } else {
      wish.set(0, 0, 0);
      wishLen = 0;
    }

    // ---- discrete decisions, in priority order --------------------------
    this._updateStance(cmd);
    const jumped = this._updateJump(cmd);

    // ---- integrate velocity ---------------------------------------------
    const v = this.velocity;
    if (c.grounded && !jumped) {
      this._accelerateGround(h, wish, wishLen, rawInput);
    } else {
      this._accelerateAir(h, wish, wishLen);
    }

    if (c.grounded && !jumped && v.y < 0) v.y = 0;
    v.y += GRAVITY * h;
    if (v.y < -MOVE.terminalSpeed) v.y = -MOVE.terminalSpeed;

    // ---- resolve ---------------------------------------------------------
    this._prevVy = v.y;
    c.velocity.x = v.x; c.velocity.y = v.y; c.velocity.z = v.z;
    const travelled = c.move(v.x * h, v.y * h, v.z * h);
    v.x = c.velocity.x; v.y = c.velocity.y; v.z = c.velocity.z;
    this.blocked = c.lastMoveBlocked;

    this.wasGrounded = this.grounded;
    this.grounded = c.grounded;
    this.position.set(c.position.x, c.position.y, c.position.z);

    if (c.touchingCeiling && v.y > 0) v.y = 0;

    // ---- post-move bookkeeping ------------------------------------------
    this._postMove(h, travelled);
    this._resolveState();
    this._publish();
  }

  _tickTimers(h) {
    this._jumpBuffer = Math.max(0, this._jumpBuffer - h);
    this._jumpCooldown = Math.max(0, this._jumpCooldown - h);
    this._footHold = Math.max(0, this._footHold - h);
    if (this.grounded) {
      this._coyote = MOVE.coyoteTime;
      this.groundTime += h;
      this.airTime = 0;
    } else {
      this._coyote = Math.max(0, this._coyote - h);
      this.airTime += h;
      this.groundTime = 0;
    }
  }

  /* ==================================================================== */
  /* stance                                                               */
  /* ==================================================================== */

  _updateStance(cmd) {
    const c = this.character;
    // Hold to crouch. Jumping overrides it for the step, because you cannot
    // jump out of a duck without standing first.
    this.stanceWant = cmd.crouchHeld && !cmd.jump ? 'crouch' : 'stand';

    if (this.stanceWant === this.stance) return;
    const target = STANCE[this.stanceWant];
    if (target.height <= this.stanceDef.height) {
      // Shrinking always succeeds.
      c.height = target.height;
      c.stepHeight = target.stepHeight;
      this.stance = this.stanceWant;
    } else if (c.canFit(target.height)) {
      c.height = target.height;
      c.stepHeight = target.stepHeight;
      this.stance = this.stanceWant;
    }
    // else: blocked by a ceiling — keep asking every step until it clears.
  }

  /* ==================================================================== */
  /* jump                                                                 */
  /* ==================================================================== */

  _updateJump(_cmd) {
    if (this._jumpBuffer <= 0) return false;
    if (this._jumpCooldown > 0) return false;
    const c = this.character;
    if (!c.grounded && this._coyote <= 0) return false;

    // You stand up before you jump; if a ceiling forbids it, you do not jump.
    if (this.stance !== 'stand') {
      if (!c.canFit(STANCE.stand.height)) return false;
      c.height = STANCE.stand.height;
      c.stepHeight = STANCE.stand.stepHeight;
      this.stance = 'stand';
      this.stanceWant = 'stand';
    }
    this._doJump();
    return true;
  }

  _doJump() {
    const v = this.velocity;
    v.y = JUMP_SPEED;
    this._jumpBuffer = 0;
    this._jumpCooldown = MOVE.jumpCooldown;
    this._coyote = 0;
    this.grounded = false;
    this.character.grounded = false;
    this.jumped = true;
    this._setState('jump');
  }

  /* ==================================================================== */
  /* acceleration                                                         */
  /* ==================================================================== */

  /**
   * One number, straight off the stance. No sprint multiplier, no ADS penalty,
   * no lean penalty — with hipfire-only combat, movement speed is a property of
   * your stance and nothing else, which is what makes enemy speed readable.
   */
  targetSpeed() {
    return STANCE[this.stance].speed;
  }

  _accelerateGround(h, wish, wishLen, rawInput) {
    const v = this.velocity;
    const speed = this.targetSpeed() * wishLen;

    let tx = wish.x * speed;
    let tz = wish.z * speed;

    // Walk along the ground plane rather than into it, so slopes do not steal
    // speed and ramps do not launch you.
    const gn = this.character.groundNormal;
    if (gn.y > 0.1 && gn.y < 0.999 && (tx !== 0 || tz !== 0)) {
      const d = tx * gn.x + tz * gn.z;
      const px = tx - gn.x * d;
      const pz = tz - gn.z * d;
      const l = hypot2(px, pz);
      if (l > 1e-5) {
        const want = hypot2(tx, tz);
        tx = (px / l) * want;
        tz = (pz / l) * want;
      }
    }

    const dx = tx - v.x;
    const dz = tz - v.z;
    const dl = hypot2(dx, dz);
    if (dl < 1e-6) return;

    const cur = hypot2(v.x, v.z);
    let rate;
    if (rawInput < 0.02) rate = MOVE.stopDecel;
    else if (speed < cur * 0.92) rate = MOVE.groundDecel;
    else rate = MOVE.groundAccel;
    // Rough ground (sand, dirt) responds a little more sluggishly.
    rate *= clamp(this.character.groundFriction + 0.08, 0.75, 1.05);

    const step = rate * h;
    if (dl <= step) {
      v.x = tx; v.z = tz;
    } else {
      const s = step / dl;
      v.x += dx * s;
      v.z += dz * s;
    }
  }

  /**
   * Air control: a quarter of ground authority, and it may only add speed along
   * the wish direction up to `airSpeedCap`. Existing momentum (a slide-cancel
   * launch, say) is preserved — you can steer it but not amplify it.
   */
  _accelerateAir(h, wish, wishLen) {
    if (wishLen < 1e-4) return;
    const v = this.velocity;
    const cap = MOVE.airSpeedCap * wishLen;
    const along = v.x * wish.x + v.z * wish.z;
    const add = cap - along;
    if (add <= 0) return;
    const accel = MOVE.groundAccel * MOVE.airAccelScale * wishLen * h;
    const gain = accel < add ? accel : add;
    v.x += wish.x * gain;
    v.z += wish.z * gain;
  }

  /* ==================================================================== */
  /* post-move                                                            */
  /* ==================================================================== */

  _postMove(_h, _travelled) {
    const c = this.character;
    const v = this.velocity;
    this.speed = hypot3(v.x, v.y, v.z);
    this.horizontalSpeed = hypot2(v.x, v.z);

    // ---- landing ---------------------------------------------------------
    if (this.grounded && !this.wasGrounded) {
      const impact = Math.max(c.landingSpeed, -Math.min(0, this._prevVy));
      this.landEvent.pending = true;
      this.landEvent.speed = impact;
      this.landEvent.surface = c.groundSurfaceName;
      this._footHold = FOOTSTEP.landHold;
      this._stepDistance = 0;
    }

    // ---- footstep cadence -------------------------------------------------
    const dx = this.position.x - this.prevPosition.x;
    const dz = this.position.z - this.prevPosition.z;
    const moved = hypot2(dx, dz);
    if (this.grounded) {
      this._stepDistance += moved;
      this._bobDistance += moved;
      const stride = STANCE[this.stance].strideLength;
      // One footfall = pi of bob phase, so the camera's horizontal extreme and
      // the footstep event are the same event by construction.
      this._bobPhase += (moved / stride) * Math.PI;
      if (this._bobPhase > Math.PI * 4) this._bobPhase -= Math.PI * 4;
      if (this._stepDistance >= stride && this.horizontalSpeed > 0.55 && this._footHold <= 0) {
        this._stepDistance -= stride;
        this._footLeft = !this._footLeft;
        this._emitFootstep();
      }
    } else {
      this._bobDistance += moved * 0.25;
      if (!this.grounded) this._stepDistance = STANCE[this.stance].strideLength * 0.55;
    }

  }

  _emitFootstep() {
    const c = this.character;
    const phys = this.physics;
    const e = this.stepEvent;
    const lateral = this._footLeft ? -FOOTSTEP.lateral : FOOTSTEP.lateral;
    const fx = c.position.x + this._right.x * lateral;
    const fz = c.position.z + this._right.z * lateral;

    // Query the surface *under the foot*, not under the capsule centre — a step
    // that lands half on a kerb should sound like the kerb.
    let y = c.position.y;
    let surface = c.groundSurfaceName;
    if (phys) {
      const hit = phys.raycast(fx, c.position.y + 0.35, fz, 0, -1, 0, FOOTSTEP.probe, phys.MASK.WORLD);
      if (hit.hit) {
        y = hit.point.y;
        surface = hit.surface;
      }
    }
    e.pending = true;
    e.running = this.horizontalSpeed >= FOOTSTEP.runSpeed;
    e.surface = surface;
    e.x = fx; e.y = y; e.z = fz;
    e.left = this._footLeft;
  }

  /* ==================================================================== */
  /* state resolution                                                     */
  /* ==================================================================== */

  _resolveState() {
    let next;
    if (!this.grounded) next = this.velocity.y > 0.35 ? 'jump' : 'fall';
    else if (this.stance === 'crouch') next = 'crouch';
    else next = 'stand';
    this._setState(next);
  }

  _setState(next) {
    if (next === this.state) return;
    this.prevState = this.state;
    this.state = next;
    this.stateTime = 0;
  }

  _publish() {
    const c = this.character;
    this.position.set(c.position.x, c.position.y, c.position.z);
    const v = this.velocity;
    this.speed = hypot3(v.x, v.y, v.z);
    this.horizontalSpeed = hypot2(v.x, v.z);
  }

  /** Interpolated feet position for rendering. */
  sampleRender(alpha) {
    this.renderPosition.lerpVectors(this.prevPosition, this.position, clamp01(alpha));
    return this.renderPosition;
  }

  /* ==================================================================== */
  /* external control                                                     */
  /* ==================================================================== */

  teleport(x, y, z) {
    if (!this.character) return;
    this.stance = 'stand';
    this.stanceWant = 'stand';
    this.character.height = STANCE.stand.height;
    this.character.stepHeight = STANCE.stand.stepHeight;
    this.character.teleport(x, y, z);
    this.velocity.set(0, 0, 0);
    this.position.set(this.character.position.x, this.character.position.y, this.character.position.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.grounded = this.character.grounded;
    this.wasGrounded = this.grounded;
    this._stepDistance = 0;
    this._bobDistance = 0;
    this._bobPhase = 0;
    this._footHold = 0;
    this._jumpBuffer = 0;
    this.landEvent.pending = false;
    this.stepEvent.pending = false;
    this._setState('stand');
  }

  get bobDistance() {
    return this._bobDistance;
  }

  /** Radians of gait phase; pi per footfall. Drives the camera's figure-eight. */
  get stepPhase() {
    return this._bobPhase;
  }
}
