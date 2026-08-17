/**
 * PLAYER — movement state machine, camera feel, health.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   movement.js   the state machine: stand/crouch/jump/fall. 120 Hz, fully
 *                 interruptible. No sprint, slide, mantle, lean or prone.
 *   camera.js     bob, landing dip, step shift, strafe/turn roll, breathing
 *                 sway, recoil + weapon kick channels, trauma shake.
 *   health.js     health (no regen), damage direction, hit flinch.
 *   tuning.js     every number that defines how the player feels.
 *   springs.js    spring/damper + easing maths.
 *
 * Collision is *never* computed here — everything goes through
 * `physics.createCharacter()` capsule sweeps.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const p = ctx.get('player')`
 * ────────────────────────────────────────────────────────────────────────────
 * TRANSFORM
 *   p.position        Vector3, FEET (bottom of the capsule), interpolated
 *   p.eyePosition     Vector3, the composed camera position
 *   p.velocity        Vector3, m/s
 *   p.forward         Vector3, unit view forward
 *   p.yaw / p.pitch   radians (yaw is the movement basis, camera adds feel)
 *   p.speed / p.horizontalSpeed
 *   p.character       the physics CharacterController (read-only)
 *   p.height          capsule height of the current stance
 *   p.combatant       the `match` Combatant — team, hitboxes, score
 *   p.team            'alpha' | 'bravo'
 *
 * The player is hit through the ordinary bullet trace: `match` builds the same
 * head/torso/arm/leg rig on it that a bot gets, on LAYER.PLAYER, and that layer
 * is in MASK.BULLET. There is no separate "shoot the player" code path, and
 * there is no hitbox owned by this file any more.
 *
 * STATE
 *   p.state           'stand'|'crouch'|'jump'|'fall'
 *   p.stance          'stand'|'crouch'
 *   p.grounded  p.airborne
 *
 * There is no ADS. Accuracy lives in the weapon's spread model, not in a
 * sight picture, so nothing here blends a zoom.
 *
 * CAMERA FEEL (for `weapons`, `fx`, `ai`)
 *   p.addRecoil(pitch, yaw, roll, punch)   camera-owned recoil impulse (radians)
 *   p.addKick(pitch, yaw, roll)            independent weapon kick channel
 *   p.addTrauma(a)                         0..1 noise shake (explosions, hits)
 *   p.viewKick                             { pitch, yaw, roll, punch } this frame
 *   p.cameraRig                            the rig, if you need the raw springs
 *
 * HEALTH
 *   p.health  p.maxHealth  p.healthFraction  p.lowHealth  p.dead
 *   p.damageIndicators
 *   p.applyDamage(amount, fromVector3, opts)   p.heal(a)
 *   Health never regenerates; only respawn() restores it.
 *
 * CONTROL
 *   p.setControlEnabled(bool)     shot harness / cutscenes
 *   p.teleport(eyePosition, rotationEulerOrYaw)
 *   p.respawn(index)
 *   p.debugState(name)            'crouch'|'hurt'|'critical'|'air'|'reset'
 *
 * EVENTS EMITTED
 *   player:state      { stance, state, grounded, speed, health, ... }
 *   player:land       { velocity, surface, position }
 *   player:footstep   { position, surface, running, left, speed, stance }
 *   damage:taken      { amount, from, health, direction }
 *   player:health     { health, fraction, low, critical, dead }
 *   player:jump       { position }
 *   player:death      { position, part, headshot, source }
 *   player:respawn    { position } — the round-scoped reset. `weapons` refills
 *                     on it, because the rules table says respawn clears ammo
 *                     and ammo does not live here.
 *
 * OVER THE 800-LINE LIMIT as a subsystem entry point: the line count is API
 * area, not depth. See ARCHITECTURE.md, "File size".
 */

import * as THREE from 'three';
import { Movement } from './movement.js';
import { CameraRig } from './camera.js';
import { Health } from './health.js';
import { Spectator } from './spectate.js';
import { STANCE, CAMERA, HEALTH, FOOTSTEP, JUMP_SPEED } from './tuning.js';
import { clamp, clamp01, DEG } from './springs.js';
import { dpow } from '../core/dmath.js';

/**
 * How far ABOVE an authored spawn point the ground probe starts.
 *
 * This must stay well under the interior ceiling height. The upstream outdoor
 * map used +6 m as a "clear of any doorstep" margin; the warehouse ceiling is
 * exactly 6 m, so that probe started inside the roof slab, reported the roof as
 * the floor, and the character controller then extruded the capsule out onto
 * the roof — the player spawned on top of the building, shooting at sky.
 *
 * Spawns are authored at floor level, so a metre and a half is already generous.
 */
const SPAWN_PROBE_UP = 1.5;

/** Feet Y for an authored spawn: drop onto whatever physics says is under it. */
function groundFeetY(physics, position) {
  const gy = physics.groundHeight(position.x, position.z, position.y + SPAWN_PROBE_UP);
  return Number.isFinite(gy) ? gy + 0.03 : position.y + 0.2;
}

export class PlayerSystem {
  static id = 'player';
  static deps = ['physics', 'world', 'render', 'match'];

  /**
   * Snapshot classification (netcode step 5). Every own field appears in
   * exactly one list; `tools/replay.mjs` fails on one in neither, one in both,
   * and one that no longer exists on the instance.
   *
   * Two entries are worth their explanation:
   *
   * `combatant` is excluded and is NOT presentation — it is health, score and
   * hitboxes, and it rewinds. It is excluded HERE because `match` owns the
   * roster and captures it there. Capturing it from both sides would restore it
   * twice, and the second restore would win for reasons nobody chose.
   *
   * `_lookFrame` is excluded because it is keyed to `time.frame`, not to a tick.
   * It stops `_consumeLook` running twice inside one rendered frame; a replay
   * drives ticks with no frames at all, so restoring a frame index would be
   * restoring an answer to a question the replay never asks.
   */
  static snapshotState = ['movement', 'rig', 'health', 'controlEnabled'];
  static excludedState = [
    'isPlayer', 'combatant', 'ctx', 'physics', 'match', 'spectator',
    '_lookFrame', '_prev', '_offEvents', '_tmp',
    '_statePayload', '_landPayload', '_stepPayload', '_jumpPayload', '_respawnPayload',
    '_hudState',
  ];

  captureState(out = {}) {
    out.movement = this.movement.captureState(out.movement);
    out.rig = this.rig.captureState(out.rig);
    out.health = this.health.captureState(out.health);
    out.controlEnabled = this.controlEnabled;
    return out;
  }

  restoreState(s) {
    this.movement.restoreState(s.movement);
    this.rig.restoreState(s.rig);
    this.health.restoreState(s.health);
    this.controlEnabled = s.controlEnabled;
  }

  constructor() {
    /** Lets `ai` / `physics` recognise the local player from an owner pointer. */
    this.isPlayer = true;
    this.movement = null;
    this.rig = null;
    this.health = null;
    /** Set at init by `match.register()`. Owns the part hitboxes. */
    this.combatant = null;

    this.controlEnabled = true;

    this._lookFrame = -1;
    // `_prevYaw` used to live here. It was assigned in three places and read in
    // none — `viewmodel.js` has a field of the same name, which is what made it
    // look alive. Found by the snapshot classification above, same as the two
    // dead RNG streams in `84a05c4`: being made to answer "does this rewind"
    // is what surfaces a field that does nothing at all.

    // preallocated event payloads
    this._statePayload = {
      stance: 'stand', state: 'stand', grounded: true, airborne: false,
      speed: 0, health: HEALTH.max, healthFraction: 1, crouched: false,
    };
    this._landPayload = { velocity: 0, surface: 'concrete', position: new THREE.Vector3() };
    this._stepPayload = {
      position: new THREE.Vector3(), surface: 'concrete', running: false,
      left: false, speed: 0, stance: 'stand',
    };
    this._jumpPayload = { position: new THREE.Vector3() };
    this._respawnPayload = { position: new THREE.Vector3() };
    // Preallocated HUD snapshot polled by `ui` (see getHudState).
    this._hudState = {
      health: HEALTH.max, maxHealth: HEALTH.max, dead: false,
      move: 0, crouch: false, airborne: false, position: null,
    };

    this._tmp = new THREE.Vector3();
    /** Last emitted discrete state, compared field-wise so no string is built. */
    this._prev = { state: '', stance: '', grounded: true };
    this._offEvents = [];
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.physics = ctx.get('physics');
    // No stream here. There used to be a `ctx.rng.fork()` on this line and not
    // one line in `src/player/` ever read it — the netcode-5 fork audit found
    // it. It was carried in the snapshot-scope table as simulation state, which
    // is how a dead stream becomes work: the table would have had us capture and
    // restore something with no consumer, and every gate would have agreed.
    // Spread and recoil randomness live in `weapons`; movement is deterministic.

    this.movement = new Movement(ctx, this);
    this.rig = new CameraRig(ctx);
    this.health = new Health(ctx, this.rig);
    this.spectator = new Spectator(ctx);

    // ---- spawn -----------------------------------------------------------
    const spawn = this._resolveSpawn();
    this.movement.init(this.physics, spawn.feet);
    this.movement.yaw = spawn.yaw;
    this.movement.pitch = 0;
    this.rig.reset(STANCE.stand.eye);
    // Aim first. `update` composes the camera ON TOP of the aim now, so a rig
    // that has never had a tick would compose from a zeroed aim and point the
    // camera down -Z at the origin on frame one.
    this.rig.stepAim(1 / 120, this.movement);
    this.rig.update(1 / 60, this.movement, this.health);
    this.rig.applyTo(ctx.camera);

    // ---- enlist ----------------------------------------------------------
    // `match` owns the hitbox rig, on LAYER.PLAYER. Nothing about being hit is
    // special-cased for the player any more: the rig, the part damage scales
    // and the trace that finds them are the same ones a bot gets.
    //
    // Self-hits are prevented by ownership (physics.fireBullet skips the
    // shooter's own colliders), not by hiding the player from MASK.BULLET —
    // which is what makes it possible for the player to be a target at all.
    this.match = ctx.get('match');
    this.combatant = this.match.register(this, {
      team: spawn.team ?? 'alpha',
      name: 'YOU',
      isPlayer: true,
      layer: this.physics.LAYER.PLAYER,
    });

    // ---- incoming damage -------------------------------------------------
    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn));
    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('explosion', (e) => this._onExplosion(e));

    console.info(
      `[player] spawn ${spawn.feet.x.toFixed(1)}, ${spawn.feet.y.toFixed(2)}, ` +
      `${spawn.feet.z.toFixed(1)} · walk ${STANCE.stand.speed} crouch ` +
      `${STANCE.crouch.speed} m/s · jump ${JUMP_SPEED.toFixed(2)} m/s (apex 0.60 m)`
    );
  }

  _resolveSpawn() {
    const world = this.ctx.peek('world');
    const out = { feet: new THREE.Vector3(0, 0.2, 0), yaw: 0, team: null };
    const sp = world?.spawn?.(0);
    if (sp?.position) {
      out.feet.copy(sp.position);
      out.yaw = sp.yaw ?? 0;
      out.team = sp.team ?? null;
    }
    // Physics owns the exact floor; drop onto it so we never start embedded.
    out.feet.y = groundFeetY(this.physics, out.feet);
    return out;
  }

  /* ==================================================================== */
  /* look                                                                 */
  /* ==================================================================== */

  /**
   * Mouse/stick look is consumed once per rendered frame. It happens in the
   * first fixed step when there is one (so movement uses this frame's yaw with
   * zero latency) and in update() otherwise — above 120 fps a frame can contain
   * no fixed step at all and dropping the delta there would feel like a hitch.
   */
  _consumeLook(dt) {
    const frame = this.ctx.time.frame;
    if (frame === this._lookFrame) return;
    this._lookFrame = frame;
    const m = this.movement;
    if (!this.controlEnabled) {
      m.yawRate = 0;
      return;
    }
    const input = this.ctx.input;
    const cfg = this.ctx.config;
    // One sensitivity, always. With no ADS there is no second zoom level to
    // scale against, and a sensitivity that changes underfoot is the fastest
    // way to break aim muscle memory.
    const sens = cfg.sensitivity ?? 1;

    // NOT scaled by `sens` again. `input.look` is ALREADY in radians — `Input`
    // multiplies the raw pointer delta by `config.sensitivity` in its own
    // update, and says so on the field. Multiplying here as well squared it:
    // measured on the shipped build, 1000 counts of mouse travel turned the view
    // 0.277 degrees where 0.0022 rad/count means 126 — a factor of 455, and
    // exactly 0.0022^2. Looking around was effectively impossible, and the
    // symmetry is what hid it: yaw and pitch were wrong by the identical factor,
    // so nothing about the view looked lopsided, it just did not move.
    //
    // The stick below is a different case and DOES want `sens`: `stick.lookX` is
    // a unitless deflection that Input curves but never scales, so this is the
    // only place its rate is set.
    let dYaw = -input.look.x;
    let dPitch = -input.look.y;

    // Gamepad: rate-based, already curved by Input.
    const stick = input.stick;
    if (stick.lookX || stick.lookY) {
      const rate = 3.1 * sens; // rad/s at full deflection
      dYaw -= stick.lookX * rate * dt;
      dPitch -= stick.lookY * rate * dt;
    }
    m.yaw += dYaw;
    m.pitch = clamp(m.pitch + dPitch, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    // Keep yaw bounded so long sessions never lose float precision.
    if (m.yaw > Math.PI) m.yaw -= Math.PI * 2;
    else if (m.yaw < -Math.PI) m.yaw += Math.PI * 2;

    m.yawRate = dt > 1e-5 ? dYaw / dt : 0;

    // Stamp the aim onto the command being simulated. Nothing local reads it —
    // movement uses `m.yaw` directly — but a command without the angles it was
    // issued under cannot be replayed by anyone, which is the point of numbering
    // them. Push, never pull: `core` may not name `player` (rule 3).
    this.ctx.commands?.setView(m.yaw, m.pitch);
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.movement) return;
    // FRAME dt inside a fixed hook, on purpose — audited, not an oversight.
    // `_consumeLook` is gated by `_lookFrame` to run once per rendered frame,
    // and its `dt` scales only the gamepad stick's rate integration; a
    // once-per-frame integration wants the frame's delta, and handing it `h`
    // would quarter stick sensitivity whenever one frame holds four steps.
    // Mouse look never touches `dt` (`input.look` is already the frame's
    // accumulated radians). Look is frame-sampled by the same decision as
    // `commands.sample` — the fallback to `h` covers the rewind harnesses,
    // where one tick per step leaves `time.dt` at zero.
    this._consumeLook(ctx.time.dt > 1e-5 ? ctx.time.dt : h);
    // Freeze time and death both take movement away without taking the camera
    // away — you can still look, which is the difference between "held" and
    // "disconnected". `Movement.applyCommand` zeroes every field when its own
    // controlEnabled is false, so `step` still runs: gravity, friction and the
    // ground probe keep working and the capsule stays settled on the floor.
    this.movement.controlEnabled = this.controlEnabled && !this.frozen && !this.dead;
    this.movement.applyCommand(ctx.commands?.current);
    if (this.controlEnabled) this.movement.step(h);
    // The aim is the simulation's, so it advances on the tick and it advances
    // even with control off — see `CameraRig.stepAim`. After `step`, so the
    // round leaves from where this tick put the body rather than the last one's.
    this.rig.stepAim(h, this.movement);
    // After `step`, so a landing or a footstep produced by THIS tick goes out
    // with this tick rather than waiting for a frame that may hold three more.
    this._drainMovementEvents();
  }

  update(dt, ctx) {
    if (!this.movement) return;
    this._consumeLook(dt);
    // No input latch here any more. Commands belong to ticks, and a frame that
    // contained no tick has nothing to say — `movement.cmd` keeps the last one,
    // which is what `camera.js` wants for its strafe lean anyway.

    this.health.update(dt);

    this.rig.update(dt, this.movement, this.health);
    // Exactly one thing writes the camera per frame. Spectating wins over the
    // first-person rig while the player is down, and the shot harness
    // (controlEnabled false) wins over both — a capture that got dragged into a
    // chase camera because the player happened to be dead would be a photograph
    // of somewhere the shot did not ask for.
    if (this._updateSpectate(dt, ctx)) {
      this.rig.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    } else if (this.controlEnabled) {
      this.rig.applyTo(ctx.camera);
    } else {
      this.rig.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    }

    // The hitbox rig is NOT placed here. `match` does it in lateUpdate, after
    // every host has written its render transform — one placement pass for
    // player and bots alike, so neither can drift a frame ahead of the other.
    this._publishState();
  }

  /**
   * Death camera. Returns true when the spectator took the camera this frame.
   *
   * Cycling is bound to the fire button, which is what every shooter does and
   * what a dead player's hands are already on. It is an EDGE query, so it lives
   * here in `update()` and not in `fixedUpdate()` — see ARCHITECTURE.md rule 7.
   */
  _updateSpectate(dt, ctx) {
    if (!this.dead || !this.controlEnabled) {
      if (this.spectator.target) this.spectator.reset();
      return false;
    }
    const match = this.match;
    if (!match) return false;
    if (ctx.input.enabled && !ctx.input.frozen && ctx.input.firePressed) {
      this.spectator.cycle(match, this.combatant, 1);
    }
    return this.spectator.update(dt, match, this.combatant, ctx.camera, this.physics);
  }

  /**
   * Turn the movement machine's one-shot flags into events + camera impulses.
   *
   * ON THE TICK, because the flags are set on the tick and they are one-shot.
   * Drained from `update`, a frame that contained four fixed steps saw one
   * `stepEvent.pending` — the other three were overwritten before anything read
   * them — so at 30 fps three of every four footsteps never happened. That is
   * not cosmetic in either direction:
   *
   *   footstep  `ai` turns it into `agent.hear(position, 24|11)`. A player at
   *             30 fps was quieter than the same player at 144. `perceive.mjs`
   *             isolated this channel and it carried ALL of the remaining
   *             frame-rate dependence in bot perception — suppress it and every
   *             rate agrees exactly.
   *   land      a hard landing calls `health.damage`. Two landings inside one
   *             frame cost one lot of fall damage.
   *   jump      `rig.addRecoil`, and recoil is part of the AIM (`710c630`), so
   *             the frame owned a channel the tick was given.
   *
   * Camera impulses come along, and that is right rather than tolerated: the
   * springs they kick are integrated in `stepAim`, which is already on the tick.
   * `player:state` stays on the frame — it is a broadcast of current values, not
   * an edge, so nothing is lost by sampling it once per drawn frame.
   */
  _drainMovementEvents() {
    const m = this.movement;

    if (m.landEvent.pending) {
      m.landEvent.pending = false;
      const speed = m.landEvent.speed;
      const mag = this.rig.onLand(speed);
      this._landPayload.velocity = speed;
      this._landPayload.surface = m.landEvent.surface;
      this._landPayload.position.copy(m.position);
      this.ctx.events.emit('player:land', this._landPayload);
      // Fall damage — CoD only hurts you past a real drop.
      const L = CAMERA.land;
      if (speed > L.damageSpeed) {
        this.health.damage((speed - L.damageSpeed) * L.damagePerSpeed, null, { type: 'fall' });
      }
      if (mag > 0.35) this.movement._footHold = FOOTSTEP.landHold;
    }

    if (m.stepEvent.pending) {
      m.stepEvent.pending = false;
      const e = this._stepPayload;
      e.position.set(m.stepEvent.x, m.stepEvent.y, m.stepEvent.z);
      e.surface = m.stepEvent.surface;
      e.running = m.stepEvent.running;
      e.left = m.stepEvent.left;
      e.speed = m.horizontalSpeed;
      e.stance = m.stance;
      this.rig.onFootstep(e.running, m.stance);
      this.ctx.events.emit('player:footstep', e);
    }

    if (m.jumped) {
      m.jumped = false;
      this.rig.addRecoil(-0.35 * DEG, 0, 0, 0.004);
      this._jumpPayload.position.copy(m.position);
      this.ctx.events.emit('player:jump', this._jumpPayload);
    }

  }

  _publishState() {
    const m = this.movement;
    const s = this._statePayload;
    s.state = m.state;
    s.stance = m.stance;
    s.crouched = m.stance !== 'stand';
    s.grounded = m.grounded;
    s.airborne = !m.grounded;
    s.speed = m.horizontalSpeed;
    s.health = this.health.value;
    s.healthFraction = this.health.fraction;
    // Emit only when something discrete actually changed. Field-wise compare,
    // because building a key string every frame would be a per-frame allocation.
    const q = this._prev;
    if (q.state !== s.state || q.stance !== s.stance || q.grounded !== s.grounded) {
      q.state = s.state; q.stance = s.stance; q.grounded = s.grounded;
      this.ctx.events.emit('player:state', s);
    }
  }

  /* ==================================================================== */
  /* incoming damage                                                      */
  /* ==================================================================== */

  _onDamageDealt(e) {
    if (!e) return;
    const t = e.target;
    if (t !== this && t !== 'player' && t?.isPlayer !== true) return;
    // Direction indicators need the *shooter*, not the impact point: `ai` sets
    // `point` to where the round landed (which is the player), and `from` to the
    // muzzle. Using `point` pinned every arc to dead ahead.
    const from = e.from ?? e.source?.position ?? e.point ?? null;
    this.applyDamage(e.amount ?? 0, from, {
      type: 'bullet',
      part: e.part ?? 'torso',
      source: e.source ?? null,
    });
  }

  _onExplosion(e) {
    if (!e?.position) return;
    const eye = this.ctx.camera.position;
    const r = e.radius ?? 5;
    const d = this._tmp.copy(e.position).distanceTo(eye);
    if (d > r * 1.6) return;
    // Occluded blasts still shake you, they just do not wound you.
    const clear = this.physics.lineOfSight(e.position, eye, this.physics.MASK.EXPLOSION);
    const falloff = dpow(clamp01(1 - d / r), 1.6);
    this.rig.addTrauma(clamp01(falloff * 1.4));
    if (clear && falloff > 0.02) {
      this.applyDamage((e.damage ?? 90) * falloff, e.position, { type: 'explosion' });
    }
  }


  /* ==================================================================== */
  /* public API                                                           */
  /* ==================================================================== */

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js. Preallocated and mutated in place.
   */
  getHudState() {
    const h = this._hudState;
    const m = this.movement;
    const hp = this.health;
    h.health = hp.value;
    h.maxHealth = hp.max;
    h.dead = hp.dead;
    // 0..1 against base run speed, which is now the fastest the player can move.
    // `ui` uses this directly as the crosshair-bloom weight, so it must saturate
    // exactly when the spread model does.
    h.move = Math.min(1, m.horizontalSpeed / STANCE.stand.speed);
    h.crouch = m.stance === 'crouch';
    h.airborne = !m.grounded;
    h.position = this.position;
    return h;
  }

  get position() {
    return this.movement.renderPosition;
  }
  get feetPosition() {
    return this.movement.position;
  }
  get eyePosition() {
    return this.rig.eyePosition;
  }
  get velocity() {
    return this.movement.velocity;
  }
  /**
   * The COMPOSED view direction — where the player is looking, bob and shake
   * and all. Audio, spectating and UI want this. A weapon does not: see
   * `aimForward`.
   */
  get forward() {
    return this.rig.forward;
  }
  /* ---- the simulation aim, owned by the fixed tick -------------------- */
  /**
   * Where a round leaves from, and along what.
   *
   * Separate from `eyePosition` / `forward` on purpose — those are the camera,
   * which carries bob, breath sway, trauma shake and render interpolation, none
   * of which anybody decided should steer a bullet. See the header of
   * `camera.js` for the measured sizes and why they are out.
   *
   * Both are live references into the rig, refreshed every tick. Copy before
   * holding one across a step.
   */
  get aimOrigin() {
    return this.rig.aimOrigin;
  }
  get aimForward() {
    return this.rig.aimForward;
  }
  get aimPitch() {
    return this.rig.aimPitch;
  }
  get aimYaw() {
    return this.rig.aimYaw;
  }
  get yaw() {
    return this.movement.yaw;
  }
  get pitch() {
    return this.movement.pitch;
  }
  get speed() {
    return this.movement.speed;
  }
  get horizontalSpeed() {
    return this.movement.horizontalSpeed;
  }
  get character() {
    return this.movement.character;
  }
  get state() {
    return this._statePayload.state;
  }
  get stance() {
    return this.movement.stance;
  }
  get grounded() {
    return this.movement.grounded;
  }
  get airborne() {
    return !this.movement.grounded;
  }
  get eyeHeight() {
    return this.rig.eye;
  }
  get viewKick() {
    return this.rig.viewKick;
  }
  get cameraRig() {
    return this.rig;
  }
  get height() {
    return STANCE[this.movement.stance].height;
  }
  get maxHealth() {
    return this.health.max;
  }
  get healthFraction() {
    return this.health.fraction;
  }
  get lowHealth() {
    return this.health.low;
  }
  get dead() {
    return this.health.dead;
  }
  get damageIndicators() {
    return this.health.indicators;
  }
  get team() {
    return this.combatant?.team ?? null;
  }
  /** Warmup, freeze time, round end — hold position. Polled, see match/index.js. */
  get frozen() {
    return !!this.match?.frozen;
  }
  /**
   * May the trigger do anything right now? `weapons` reads this.
   *
   * It lives here rather than in `weapons` because `weapons` does not depend on
   * `match` and should not start to: a gun is a gun whether or not there is a
   * round on. What it does depend on is the player holding it, which it already
   * peeks — so one getter on the holder covers freeze time, death and the
   * capture harness with no new edge in the dependency graph.
   */
  get canFire() {
    return this.controlEnabled && !this.frozen && !this.dead;
  }
  /** The Combatant being spectated, or null. `ui/spectate.js` reads this. */
  get spectateTarget() {
    return this.dead ? this.spectator.target : null;
  }
  get bobPhase() {
    return this.rig.bobPhase;
  }

  addRecoil(pitch, yaw, roll, punch) {
    this.rig.addRecoil(pitch, yaw, roll, punch);
  }
  addKick(pitch, yaw, roll) {
    this.rig.addKick(pitch, yaw, roll);
  }
  addTrauma(a) {
    this.rig.addTrauma(a);
  }
  /** Alias some subsystems may reach for. */
  addCameraShake(a) {
    this.rig.addTrauma(a);
  }

  applyDamage(amount, from, opts) {
    return this.health.damage(amount, from ?? null, { yaw: this.movement.yaw, ...opts });
  }
  heal(a) {
    this.health.heal(a);
  }

  setControlEnabled(on) {
    this.controlEnabled = !!on;
    this.movement.controlEnabled = this.controlEnabled;
    // Flush held keys. Re-enabling needs no counterpart: the command for the
    // next tick is built from scratch, so there is no latch left to invalidate.
    if (!on) {
      this.movement.applyCommand(null);
      this.movement.velocity.set(0, 0, 0);
    }
  }

  /**
   * Move the player. `eyeOrPos` is the EYE position (that is what the shot
   * harness hands us — it passes the camera transform); `rot` may be a
   * THREE.Euler, an object with `.y`, or a yaw in radians.
   */
  teleport(eyeOrPos, rot) {
    if (!eyeOrPos) return;
    const eyeH = STANCE.stand.eye;
    const feetY = eyeOrPos.y - eyeH;
    if (typeof rot === 'number') {
      this.movement.yaw = rot;
    } else if (rot) {
      this.movement.yaw = rot.y ?? this.movement.yaw;
      this.movement.pitch = clamp(rot.x ?? 0, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    }
    this.movement.teleport(eyeOrPos.x, feetY, eyeOrPos.z);
    this.rig.reset(eyeH);
    // Snap the aim to the new pose instead of waiting for a tick. A harness
    // that teleports and fires in the same breath — `tools/ballistics.mjs`
    // waits two frames, `prewarm` waits none — would otherwise trace from the
    // previous position along the previous heading.
    this.rig.stepAim(0, this.movement);
    this.rig.eyePosition.set(eyeOrPos.x, eyeOrPos.y, eyeOrPos.z);
    this.rig.fov = this.ctx.config.fov;
    this._lookFrame = this.ctx.time.frame;
    this._prev.state = '';
  }

  /**
   * Put the player back at a spawn with full health. This is the ROUND RESET
   * path — with no mid-round respawn, it is only ever called by `match` when a
   * round begins. Pass a spawn point directly (round play assigns them by team)
   * or an index into world.spawnPoints.
   *
   * @param {number|{position: THREE.Vector3, yaw: number}} [where]
   */
  respawn(where = 0) {
    const world = this.ctx.peek('world');
    const sp = typeof where === 'object' && where?.position
      ? where
      : world?.spawn?.(where | 0);
    this.health.reset(true);
    this.spectator.reset();
    if (!sp?.position) return;
    const feetY = groundFeetY(this.physics, sp.position);
    this.movement.yaw = sp.yaw ?? 0;
    this.movement.pitch = 0;
    this.movement.teleport(sp.position.x, feetY, sp.position.z);
    this.rig.reset(STANCE.stand.eye);
    this.rig.stepAim(0, this.movement);
    /**
     * Announce it, because the rules table says respawn clears more than this
     * file owns.
     *
     * "Health, ammo, perception and cover claims are round-scoped and cleared
     * by respawn()" — and ammo lives in `weapons`, which this subsystem does
     * not know about and should not. It reaches `player`, not the other way
     * round; an event is how the direction stays that way.
     *
     * Emitted last, so a listener reading `player.position` gets the seat this
     * fighter is actually standing on rather than the one they died at.
     */
    this._respawnPayload.position.copy(this.movement.position);
    this.ctx.events.emit('player:respawn', this._respawnPayload);
  }

  /** Named states for dev overlays and future shots. */
  debugState(name) {
    const m = this.movement;
    switch (name) {
      case 'crouch':
        m.stanceWant = 'crouch';
        break;
      case 'air':
        m.velocity.y = JUMP_SPEED;
        m.grounded = false;
        break;
      case 'hurt':
        this.health.value = this.health.max * 0.28;
        this.health.lastDamageTime = this.ctx.time.sim;
        this.health.effect = clamp01((HEALTH.lowThreshold - 0.28) / HEALTH.lowThreshold);
        break;
      case 'critical':
        this.health.value = this.health.max * 0.11;
        this.health.lastDamageTime = this.ctx.time.sim;
        this.health.effect = 1;
        this.health.hitFlash = 0.6;
        break;
      case 'reset':
        this.health.reset(true);
        this.health.effect = 0;
        break;
      default:
        break;
    }
    return {
      state: this.state, stance: m.stance, speed: m.horizontalSpeed,
      health: this.health.value,
    };
  }

  /** Snapshot for the dev HUD / debugging. */
  get stats() {
    const m = this.movement;
    return {
      state: this.state,
      stance: m.stance,
      speed: m.horizontalSpeed,
      vertical: m.velocity.y,
      grounded: m.grounded,
      fov: this.rig.fov,
      health: this.health.value,
    };
  }

  dispose() {
    for (const off of this._offEvents) off?.();
    this._offEvents.length = 0;
    // The rig belongs to `match`, which disposes it with the registry. Removing
    // the colliders from here as well would double-free them.
    this.combatant = null;
    this.movement?.dispose();
  }
}
