import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { WeaponMaterials, ENV_OCCLUSION } from './materials.js';
import { Viewmodel } from './viewmodel.js';
import { WEAPON_DEFS, buildRecoilPattern, SPREAD_MODS } from './defs.js';
import { buildRifle } from './models/rifle.js';
import { buildSmg } from './models/smg.js';
import { buildPistol } from './models/pistol.js';
import { clamp, clamp01, lerp, damp, DEG } from './mathx.js';

/**
 * WEAPONS — weapon meshes, the first-person viewmodel rig, recoil, spread,
 * sway, bob, reload/inspect animation and hitscan fire.
 *
 * NO ADS. This is a hipfire game: accuracy is the spread cone plus the
 * deterministic recoil pattern, and the crosshair lives in the HUD. There is no
 * sight picture, no zoom and no collimator.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   geometry.js   hard-surface kit: chamfered boxes, lathes, extrusions,
 *                 Picatinny rail, M-LOK, knurling, screws, and the Assembly
 *                 that merges everything down to a handful of draw calls.
 *   parts.js      real firearm components built from published dimensions:
 *                 receivers, barrels, muzzle devices, handguards, stocks,
 *                 grips, magazines, optics, iron sights, triggers.
 *   models/*.js   the three weapons assembled from those parts.
 *   hands.js      gloved hands + sleeved arms, two-bone IK from the hand.
 *   viewmodel.js  the animation stack (sway/bob/lag/recoil/clips).
 *   clips.js      keyframed reload / inspect / draw timelines.
 *   defs.js       every tuning number, plus the deterministic recoil patterns.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const wp = ctx.get('weapons')`
 * ────────────────────────────────────────────────────────────────────────────
 *   wp.current            { id, label, class, mode, magSize, ... } (the def)
 *   wp.ammo               { mag, chambered, reserve, magSize, total, empty }
 *   wp.fireMode           'auto' | 'burst' | 'semi'
 *   wp.spreadDegrees      live cone half-angle — drive the crosshair gap with it
 *   wp.reloading / wp.firing / wp.switching / wp.inspecting
 *   wp.weaponIds          ['rifle','smg','pistol']
 *   wp.setWeapon(id)      draw/holster animated swap
 *   wp.nextWeapon()
 *   wp.cycleFireMode()
 *   wp.reload()           no-op if full or empty of reserve
 *   wp.inspect()
 *   wp.tryFire()          honours fire mode + rpm; returns true if a shot left
 *   wp.viewmodel          the rig (fx/ui may read muzzle/eject transforms)
 *   wp.muzzleWorld(v3)    world-space muzzle, for anything that needs it
 *   wp.debugPose(kind)    'idle' | 'fire'  (the capture harness)
 *   wp.stats              { tris, drawCalls, live, fired }
 *
 * EVENTS EMITTED  (all canonical, see ARCHITECTURE.md)
 *   weapon:fire    { weapon, origin, dir, seed }
 *   weapon:shell   { position, velocity }
 *   weapon:reload  { weapon, phase: 'start'|'magout'|'magin'|'end' }
 *   bullet:tracer  { from, to, speed }
 * `bullet:impact` comes from physics, because physics owns penetration.
 * Anything else (ammo counts, fire mode, the current weapon) is a getter on
 * this object rather than an event, so no new event types are introduced.
 */
export class WeaponSystem {
  static id = 'weapons';
  static deps = ['materials', 'physics'];

  /**
   * Snapshot classification (netcode step 5).
   *
   * `_pendingShots` and `_pendingFirst` are simulation despite living on the
   * bridge between a tick and a frame. `tryFire` increments the counter and
   * `_flushShots` drains it into `weapon:fire`, which `ai/index.js` turns into
   * `agent.hear(origin, 90)` — the loudest cue in the game. A counter that was
   * not restored would be a volley of shots the replay's bots never heard.
   *
   * `_shellQueue` and `_droppedMags` ARE excluded, and only became safe to
   * exclude in this commit: their velocity and spin used to be jittered off the
   * simulation stream, so the number of casings in flight moved the next
   * bullet. `fxRng` owns that now, which is what makes them ordinary brass.
   *
   * `_state` is rewritten from `player` at the top of every fixed step, so it is
   * derived — but it is captured anyway. Being wrong in the excluding direction
   * is the one mistake this gate cannot catch (layer 1 skips what layer 2 says
   * to skip), and restoring a derived field costs nothing.
   */
  static snapshotState = [
    'states', 'activeId', 'rng',
    '_fireTimer', '_burstLeft', '_burstCooldown', '_semiLatch',
    '_spread', '_shotIndex', '_sinceShot', '_fireSeed',
    '_switchTimer', '_switchTo', '_reloadPhase', '_pendingReloadEmpty',
    '_pendingShots', '_pendingFirst', '_state',
  ];
  static excludedState = [
    'ctx', 'fxRng', 'mats', 'player', 'fx', 'physics', 'viewmodel', 'stats', '_off',
    'debugMode', '_debugFrame', '_scriptFrames', '_aimOverride',
    '_shellQueue', '_droppedMags', '_magPools', '_disc', '_hudState',
    '_muzzle', '_eye', '_dir', '_tracerTo', '_right', '_up', '_tmp',
    '_aimDir', '_aimQuat', '_aimEuler',
    '_tracerPayload', '_firePayload', '_reloadPayload', '_shellPayload',
  ];

  captureState(out = {}) {
    const st = (out.states ??= {});
    for (const k of Object.keys(st)) delete st[k];
    for (const [id, s] of this.states) st[id] = { ...s };
    out.rng = this.rng.captureState(out.rng);
    out._state = { ...this._state };
    for (const k of WeaponSystem.snapshotState) {
      if (k === 'states' || k === 'rng' || k === '_state') continue;
      out[k] = this[k];
    }
    return out;
  }

  restoreState(s) {
    for (const [id, v] of Object.entries(s.states)) {
      const cur = this.states.get(id);
      if (cur) Object.assign(cur, v);
    }
    this.rng.restoreState(s.rng);
    Object.assign(this._state, s._state);
    for (const k of WeaponSystem.snapshotState) {
      if (k === 'states' || k === 'rng' || k === '_state') continue;
      this[k] = s[k];
    }
  }

  constructor() {
    this.viewmodel = null;
    this.states = new Map();
    this.activeId = 'rifle';
    this.debugMode = null;

    this._fireTimer = 0;
    this._burstLeft = 0;
    this._burstCooldown = 0;
    this._semiLatch = false;
    this._spread = 0;
    this._shotIndex = 0;
    this._sinceShot = 10;
    this._switchTimer = 0;
    this._switchTo = null;
    this._reloadPhase = null;

    this._muzzle = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._tracerPayload = { from: this._muzzle, to: this._tracerTo, speed: 0, weapon: null };
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._aimDir = new THREE.Vector3();
    /**
     * The firing basis, resolved once per shot in `_syncAim`.
     *
     * Not the camera. The camera carries bob, breath sway and trauma shake, and
     * reading it here is how all three came to steer live rounds — see the
     * header of `player/camera.js` for what that measured. `player` owns the aim
     * now and steps it on the fixed tick.
     */
    this._aimQuat = new THREE.Quaternion();
    this._aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    /**
     * Set to `{ pitch, yaw }` to aim without a player: `prewarmTransients`
     * fires three rounds at the ceiling before anything has ticked. It used to
     * do that by writing `ctx.camera.rotation.x` and putting it back, which
     * worked only because the camera WAS the aim.
     */
    this._aimOverride = null;
    this._firePayload = { weapon: null, origin: new THREE.Vector3(), dir: new THREE.Vector3(), seed: 0 };
    this._reloadPayload = { weapon: null, phase: 'start' };
    // `weapon:shell` carries the canonical { position, velocity } plus the real
    // case dimensions and a spin, so fx can size and tumble the brass instead of
    // guessing: a 9x19 case is less than half the length of a 5.56x45 one.
    this._shellPayload = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      weapon: null,
      caseLen: 0.0446,
      caseRadius: 0.00495,
      spin: 0,
    };
    this._pendingShots = 0;
    this._pendingFirst = false;

    // Declared here rather than appearing on first use. All six used to spring
    // into existence partway through a match — `_disc` on the first shot,
    // `_magPools` on the first reload, the debug pair only under a harness — and
    // the snapshot audit reported each as declared-but-absent. Two of them
    // (`_fireSeed`, `_pendingReloadEmpty`) are snapshot state, so a capture taken
    // before the first shot could not have restored them. The rest are here for
    // the same reason `Health.lastPart` is: a field that exists from construction
    // is a field a snapshot can reason about at any tick.
    this._fireSeed = 0;
    this._pendingReloadEmpty = false;
    this._disc = { x: 0, y: 0 };
    this._magPools = new Map();
    this._debugFrame = 0;
    this._scriptFrames = 0;

    // Deferred shell ejections (a case leaves the port a few ms after the shot).
    this._shellQueue = [];
    for (let i = 0; i < 8; i++) {
      this._shellQueue.push({ t: -1, pos: new THREE.Vector3(), vel: new THREE.Vector3() });
    }
    this._droppedMags = [];
    this._state = {
      speed: 0,
      crouch: false,
      airborne: false,
      trigger: false,
      empty: false,
    };
    // Preallocated HUD snapshot handed to `ui` (see getHudState).
    this._hudState = {
      name: '', mode: 'auto', ammo: 0, reserve: 0, magSize: 0,
      reloading: false, reloadProgress: 0, spread: 0, firing: false,
    };
  }

  /* ====================================================================== */
  /*  init                                                                  */
  /* ====================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    // Two streams, for the same reason `ai` has two.
    //
    // `rng` is simulation and nothing else may touch it: the spread cone draws
    // from it on every shot (`_disc`) and the recoil pattern seed comes off it.
    //
    // `fxRng` is brass and dropped magazines. Four of this file's six draws used
    // to come out of the simulation stream to jitter a casing's velocity and
    // spin — so how many shells happened to be mid-flight decided where the NEXT
    // BULLET WENT. Nothing measured it because both looked like "weapon
    // randomness". It is the same defect `variant()` had against `ai.rng`
    // (`84a05c4`), one subsystem over.
    this.rng = ctx.rng.fork({ snapshot: true });
    this.fxRng = ctx.rng.fork({ snapshot: false });
    this.mats = new WeaponMaterials(ctx);
    this.viewmodel = new Viewmodel(ctx, this.mats);
    // three only honours `material.envMapIntensity` when the material carries its
    // OWN `envMap`; for a material lit by `scene.environment` the renderer
    // overwrites that uniform with `scene.environmentIntensity` every frame
    // (WebGLRenderer.setProgram, the isMeshStandardMaterial branch). The
    // viewmodel is drawn from its own scene, so ENV_OCCLUSION — how much of the
    // sky a shouldered weapon actually sees, see materials.js — has to be
    // expressed there or it is silently a no-op.
    ctx.viewScene.environmentIntensity = ENV_OCCLUSION;
    this.viewmodel.onClipEvent = (name, clip) => this._onClipEvent(name, clip);

    const t0 = performance.now();
    const builders = { rifle: buildRifle, smg: buildSmg, pistol: buildPistol };
    let tris = 0;
    for (const id of ['rifle', 'smg', 'pistol']) {
      const def = { ...WEAPON_DEFS[id] };
      def.cycleTime = 60 / def.rpm;
      const model = builders[id]();
      const entry = this.viewmodel.addWeapon(model, def);
      tris += entry.tris;
      this.states.set(id, {
        def,
        pattern: buildRecoilPattern(def, Rng),
        mag: def.magSize,
        chambered: true,
        reserve: def.reserve,
        mode: def.modes[0],
        modeIndex: 0,
      });
    }
    this.viewmodel.setActive(this.activeId);
    this.viewmodel.play('draw');

    // Player hooks (all optional: the viewmodel works standalone).
    this.player = ctx.peek('player');
    this.fx = ctx.peek('fx');
    this.physics = ctx.peek('physics');
    this._off = [];
    this._off.push(
      ctx.events.on('player:land', (e) => this.viewmodel.land(Math.abs(e?.velocity ?? 3)))
    );
    this._off.push(ctx.events.on('player:jump', () => this.viewmodel.jump()));

    this.stats = { tris, drawCalls: 0, live: 0, fired: 0 };
    console.info(
      `[weapons] ${this.states.size} weapons · ${(tris / 1000).toFixed(1)}k tris viewmodel · ` +
        `built in ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /* ====================================================================== */
  /*  public getters                                                        */
  /* ====================================================================== */

  get state() {
    return this.states.get(this.activeId);
  }

  get current() {
    return this.state?.def ?? null;
  }

  get weaponIds() {
    return [...this.states.keys()];
  }

  get ammo() {
    const s = this.state;
    if (!s) return { mag: 0, chambered: false, reserve: 0, magSize: 0, total: 0, empty: true };
    const mag = s.mag;
    const ch = s.chambered ? 1 : 0;
    return {
      mag: mag + ch,
      inMag: mag,
      chambered: s.chambered,
      reserve: s.reserve,
      magSize: s.def.magSize,
      total: mag + ch + s.reserve,
      empty: mag + ch === 0,
    };
  }

  get fireMode() {
    return this.state?.mode ?? 'semi';
  }


  get reloading() {
    const n = this.viewmodel?.clipName;
    return n === 'reloadTac' || n === 'reloadEmpty';
  }

  get inspecting() {
    return this.viewmodel?.clipName === 'inspect';
  }

  get switching() {
    return this._switchTo !== null;
  }

  get firing() {
    return this._sinceShot < 0.12;
  }

  /** Current spread cone half-angle in degrees — the crosshair should use this. */
  get spreadDegrees() {
    return this._spread;
  }

  muzzleWorld(out) {
    return this.viewmodel.muzzleWorld(out ?? this._tmp);
  }

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js; the object is preallocated and
   * mutated in place because `ui` reads it once per frame and never keeps it.
   */
  getHudState() {
    const h = this._hudState;
    const s = this.state;
    if (!s) return h;
    const a = this.ammo;
    const vm = this.viewmodel;
    h.name = s.def.label ?? s.def.id;
    h.mode = s.mode;
    // `a.mag` counts the chambered round, so a topped-off rifle is 31. The HUD
    // draws one pip per round against magSize, so clamp the *display* to the
    // magazine capacity rather than overflowing the pip strip.
    h.ammo = Math.min(a.mag, a.magSize);
    h.reserve = a.reserve;
    h.magSize = a.magSize;
    h.reloading = this.reloading;
    // 0..1 through the active reload clip; the bar is meaningless otherwise.
    h.reloadProgress = h.reloading && vm?.clip?.duration
      ? Math.min(1, vm.clipT / vm.clip.duration)
      : 0;
    // `ui` maps this to reticle bloom as 4 + spread * 40 px, so hand it a
    // normalised 0..1 rather than raw degrees.
    h.spread = Math.min(1, Math.max(0, this._spread / 6));
    h.firing = this.firing;
    return h;
  }

  /* ====================================================================== */
  /*  weapon management                                                     */
  /* ====================================================================== */

  setWeapon(id) {
    if (!this.states.has(id) || id === this.activeId || this._switchTo) return false;
    this._switchTo = id;
    this._switchTimer = this.viewmodel.play('holster');
    return true;
  }

  nextWeapon() {
    const ids = this.weaponIds;
    const i = ids.indexOf(this.activeId);
    return this.setWeapon(ids[(i + 1) % ids.length]);
  }

  cycleFireMode() {
    const s = this.state;
    if (!s || s.def.modes.length < 2) return s?.mode;
    s.modeIndex = (s.modeIndex + 1) % s.def.modes.length;
    s.mode = s.def.modes[s.modeIndex];
    this._burstLeft = 0;
    return s.mode;
  }

  reload() {
    const s = this.state;
    if (!s || this.reloading || this.switching) return false;
    if (s.mag >= s.def.magSize || s.reserve <= 0) return false;
    this.viewmodel.stopClip();
    const empty = s.mag === 0 && !s.chambered;
    this.viewmodel.play(empty ? 'reloadEmpty' : 'reloadTac');
    this._pendingReloadEmpty = empty;
    return true;
  }

  inspect() {
    if (this.reloading || this.switching || this.inspecting) return false;
    this.viewmodel.play('inspect');
    return true;
  }

  /* ====================================================================== */
  /*  firing                                                                */
  /* ====================================================================== */

  canFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching) return false;
    if (this._fireTimer > 0) return false;
    return s.chambered;
  }

  /** One round leaves the barrel. Returns false if the trigger clicked dry. */
  /**
   * Resolve the firing basis: `_eye` (origin), `_aimDir` (forward) and
   * `_aimQuat` (the frame the spread cone is built in).
   *
   * Three sources, in falling order of authority:
   *
   *   1. `_aimOverride`   an explicit pose. `prewarmTransients` only.
   *   2. `player`         the simulation aim, stepped on the fixed tick. This
   *                       is the path every real shot takes.
   *   3. `ctx.camera`     a weapons-only harness with no player registered.
   *
   * The camera fallback is the old behaviour and it is kept deliberately narrow.
   * Two aim sources that can silently disagree is exactly the defect this split
   * exists to remove, so it is reached only when there is no aim to be had, and
   * `tools/aim.mjs` asserts that the real path is the one being taken.
   */
  _syncAim() {
    const o = this._aimOverride;
    if (o) {
      this._aimEuler.set(o.pitch, o.yaw, 0);
      this._aimQuat.setFromEuler(this._aimEuler);
      this._aimDir.set(0, 0, -1).applyQuaternion(this._aimQuat);
      if (o.origin) this._eye.copy(o.origin);
      return;
    }
    const p = this.player ?? (this.player = this.ctx.peek('player'));
    if (p?.aimForward) {
      this._aimEuler.set(p.aimPitch, p.aimYaw, 0);
      this._aimQuat.setFromEuler(this._aimEuler);
      this._aimDir.copy(p.aimForward).normalize();
      this._eye.copy(p.aimOrigin);
      return;
    }
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._aimQuat.copy(cam.quaternion);
    this._aimDir.set(0, 0, -1).applyQuaternion(this._aimQuat).normalize();
    this._eye.setFromMatrixPosition(cam.matrixWorld);
  }

  tryFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching || this._fireTimer > 0) return false;
    if (!s.chambered) {
      // Dry: lock the bolt back and let the player know by feel.
      this.viewmodel.boltHold = 1;
      this._fireTimer = 0.25;
      return false;
    }
    if (this.inspecting) this.viewmodel.stopClip();

    const def = s.def;
    const first = this._sinceShot > 0.35;
    // ---- feed the next round ----
    s.chambered = false;
    if (s.mag > 0) {
      s.mag--;
      s.chambered = true;
    } else {
      this.viewmodel.boltHold = 1;
    }

    // ---- deterministic recoil pattern ----
    const idx = Math.min(this._shotIndex, def.recoil.patternLength - 1);
    const pitch = s.pattern[idx * 2];
    const yaw = s.pattern[idx * 2 + 1];
    this._shotIndex++;

    // ---- aim: the tick's aim + a spread cone ----
    this._syncAim();
    this._dir.copy(this._aimDir);
    const spreadRad = this._spread * DEG;
    if (spreadRad > 1e-5) {
      const d = this.rng.disc(this._disc ?? (this._disc = { x: 0, y: 0 }));
      this._right.set(1, 0, 0).applyQuaternion(this._aimQuat);
      this._up.set(0, 1, 0).applyQuaternion(this._aimQuat);
      this._dir
        .addScaledVector(this._right, Math.tan(spreadRad) * d.x)
        .addScaledVector(this._up, Math.tan(spreadRad) * d.y)
        .normalize();
    }

    // ---- hitscan ----
    //
    // The round lands on the frame it is fired: no travel time, no drop. At the
    // ranges this game plays at, leading a target is a skill nobody asked for
    // and it makes a shot that looked centred read as a miss. The spread cone
    // above is the only thing between the crosshair and the hit.
    //
    // The trace starts at the EYE, not the muzzle, so what the crosshair covers
    // is what gets hit. A muzzle-origin trace sits right and low of the sightline
    // and clips its own cover when you shoot around a left-hand corner. The
    // muzzle still owns the flash and the tracer, which are cosmetic.
    this.viewmodel.muzzleWorld(this._muzzle);
    const seed = this.rng.u32();
    this.physics.fireBullet({
      origin: this._eye,
      dir: this._dir,
      damage: def.damage,
      penetration: def.penetration,
      dropoff: def.dropoff,
      // Travel vs. falloff — two fields on purpose, see penetration.js.
      falloffRange: def.falloffRange ?? def.maxRange,
      maxDist: def.maxRange,
      source: this.player,
      mask: this.physics.MASK.BULLET,
    });
    if (this.stats.fired % def.tracerEvery === 0) this._emitTracer(def);

    // ---- feedback ----
    this.viewmodel.addRecoil(pitch, yaw, first);
    const p = this.player;
    if (p?.addRecoil) {
      // The camera climb is the learnable part; the viewmodel kick is the feel.
      p.addRecoil(pitch, yaw, def.recoil.roll * 0.35, def.recoil.punch);
    }
    this._spread = Math.min(def.spreadMax, this._spread + def.spreadPerShot);
    // `+=`, NOT `=`. See `_advanceFireTimer` — the overshoot this carries is the
    // difference between the printed RPM and the one the player gets.
    this._fireTimer += 60 / def.rpm;
    this._sinceShot = 0;
    this.stats.fired++;
    this._pendingShots++;
    this._pendingFirst = this._pendingFirst || first;
    this._fireSeed = seed;

    // Shell leaves the port shortly after the shot, once the bolt is back.
    this._queueShell(Math.min(0.05, this._fireTimer * 0.45));
    return true;
  }

  /**
   * Fire a few rounds at boot so the player's first real shot is not the one that
   * pays for the whole path.
   *
   * `core/prewarm.js` compiles every shader and bursts every fx family, and
   * neither reaches this: a trigger pull goes out through `physics.fireBullet`
   * into the penetration solve, the surface lookup, the first decal and the
   * hitbox query, none of which is fx's and none of which any camera pose
   * touches. Measured with `tools/profile.mjs`, the cost of that is about 225 ms
   * on the frame the trigger is first pulled — the worst frame in a 900-frame
   * run by a factor of four, with zero new shader programs and with audio
   * silenced making no difference. Firing three rounds before the sampling window
   * opens takes the worst frame of the entire run down to 59 ms.
   *
   * WHAT MAKES IT HARMLESS is not that the rounds are fake — they are real, which
   * is the point, and a fake one would warm a path nobody walks. It is that
   * everything they leave behind is put back:
   *
   *   - aimed at the sky, so the trace leaves the level and cannot damage a
   *     fighter, mark a wall or wake a bot. It still runs the full solve; a
   *     bullet that hits nothing does the same raycast as one that hits a head.
   *   - decals suppressed, so nothing is written into the atlas that a capture
   *     would then have to explain.
   *   - ammo, shot index, spread, fire timer and stats restored, so the player
   *     starts the round with a full magazine, a fresh recoil pattern and a
   *     scoreboard that has not counted three rounds nobody fired.
   *
   * The camera is NOT restored here: `prewarm` already snapshots and restores it
   * around the whole pass, and doing it twice would only add a way to disagree.
   */
  prewarmTransients() {
    const s = this.state;
    if (!s) return { ok: false, reason: 'no weapon state' };
    const fx = this.ctx.peek('fx');
    const saved = {
      mag: s.mag, chambered: s.chambered, reserve: s.reserve,
      shotIndex: this._shotIndex, spread: this._spread,
      fireTimer: this._fireTimer, sinceShot: this._sinceShot,
      fired: this.stats.fired, decals: fx?._suppressDecals,
      // DEFERRED WORK, which is the part that is easy to miss and the part the
      // pixel gate actually caught. `tryFire` does not emit its own feedback: it
      // increments `_pendingShots`, stamps `_fireSeed` and queues shells, and
      // `update()` turns all of that into flashes, tracers, audio and brass on
      // some later frame. Nothing steps the engine during prewarm, so without
      // this the three warm rounds sat in the queue and detonated on the first
      // frame of play — three flashes, three shells and a seeded fx burst nobody
      // fired. Measured before restoring it: every shot in the gate set shifted
      // by a mean of ~0.4/255 over a third of its pixels.
      pendingShots: this._pendingShots,
      pendingFirst: this._pendingFirst,
      fireSeed: this._fireSeed,
      shells: this._shellQueue.map((q) => q.t),
      boltHold: this.viewmodel?.boltHold,
    };
    if (fx) fx._suppressDecals = true;
    // Straight up. The roof is solid collision, but a round leaving at this pitch
    // exits through the skylight run rather than into anything a player will look
    // at, and either way the solve it performs is the one being warmed.
    //
    // Posed on the AIM, not by writing `ctx.camera.rotation.x` and putting it
    // back. That worked only while the camera was the aim, and it meant a warm
    // pass mutated a transform three other subsystems read. The yaw and origin
    // come from wherever the player currently is; pitch is the only thing this
    // needs to choose.
    const p = this.player ?? (this.player = this.ctx.peek('player'));
    this._aimOverride = {
      pitch: -Math.PI * 0.48,
      yaw: p?.aimYaw ?? 0,
      origin: p?.aimOrigin ?? this.ctx.camera.position,
    };
    let fired = 0;
    let flashed = 0;
    for (let i = 0; i < 3; i++) {
      s.mag = Math.max(1, s.mag);
      s.chambered = true;
      this._fireTimer = 0;
      if (!this.tryFire()) continue;
      fired++;
      // Emit the flash HERE, inside the warm, instead of leaving it queued.
      //
      // Both halves of this matter and a first version got each of them wrong in
      // turn. Leaving the queue alone warmed the flash beautifully — because the
      // three rounds detonated on the first frame of play, which is a leak the
      // pixel gate caught as a mean delta of 0.4/255 across every shot. Clearing
      // the queue fixed the gate and put the 243 ms stall straight back, because
      // the flash is exactly where the remaining cost is: one program and three
      // textures. Flushing it now gets the warm without the residue.
      flashed += this._flushShots(this.ctx);
    }
    if (fx) fx._suppressDecals = saved.decals;
    this._aimOverride = null;
    s.mag = saved.mag;
    s.chambered = saved.chambered;
    s.reserve = saved.reserve;
    this._shotIndex = saved.shotIndex;
    this._spread = saved.spread;
    this._fireTimer = saved.fireTimer;
    this._sinceShot = saved.sinceShot;
    this.stats.fired = saved.fired;
    this._pendingShots = saved.pendingShots;
    this._pendingFirst = saved.pendingFirst;
    this._fireSeed = saved.fireSeed;
    for (let i = 0; i < this._shellQueue.length; i++) this._shellQueue[i].t = saved.shells[i];
    // The springs the warm rounds loaded. `addRecoil` is additive on the
    // viewmodel and on the camera, and `prewarm` restores the camera's TRANSFORM
    // but not the spring driving it, so the kick would still be unwinding on the
    // first frame the player sees. These are the same resets `debugPose` uses to
    // put the viewmodel into a settled pose for a capture — an existing, tested
    // path, rather than a `resetSprings?.()` that would silently no-op.
    const vm = this.viewmodel;
    if (vm) {
      vm.recPos.reset();
      vm.recRot.reset();
      vm.boltHold = saved.boltHold;
      vm.boltCycle = 0;
    }
    return { ok: fired > 0, fired, flashed };
  }

  _queueShell(delay) {
    for (const q of this._shellQueue) {
      if (q.t < 0) {
        q.t = delay;
        return q;
      }
    }
    return null;
  }

  /* ====================================================================== */
  /*  reload / clip callbacks                                               */
  /* ====================================================================== */

  _onClipEvent(name, clipName) {
    const s = this.state;
    const isReload = clipName === 'reloadTac' || clipName === 'reloadEmpty';
    switch (name) {
      case 'start':
        if (isReload) this._emitReload('start');
        break;
      case 'magout':
        if (isReload) this._emitReload('magout');
        break;
      case 'magdrop':
        if (isReload) this._dropMagazine();
        break;
      case 'magin':
        if (isReload) {
          this._emitReload('magin');
          this._completeReload(clipName === 'reloadEmpty');
        }
        break;
      case 'boltrelease':
        this.viewmodel.boltHold = 0;
        break;
      case 'end':
        if (isReload) {
          this._emitReload('end');
          this.viewmodel.boltHold = 0;
        }
        if (clipName === 'holster' && this._switchTo) {
          this.activeId = this._switchTo;
          this._switchTo = null;
          this.viewmodel.setActive(this.activeId);
          this.viewmodel.play('draw');
          this._shotIndex = 0;
          this._spread = 0;
        }
        break;
      default:
        break;
    }
  }

  /**
   * The chambered-round model: a tactical reload keeps the round in the chamber
   * and gives you magSize+1; an empty reload has to feed one out of the fresh
   * magazine, so you end up with exactly magSize.
   */
  _completeReload(empty) {
    const s = this.state;
    if (!s) return;
    const want = s.def.magSize - s.mag;
    const take = Math.min(want, s.reserve);
    s.reserve -= take;
    s.mag += take;
    if (empty && !s.chambered && s.mag > 0) {
      s.mag--;
      s.chambered = true;
    }
    this._shotIndex = 0;
  }

  _emitReload(phase) {
    this._reloadPayload.weapon = this.current;
    this._reloadPayload.phase = phase;
    this.ctx.events.emit('weapon:reload', this._reloadPayload);
  }

  /** Spawn the discarded magazine as a real rigid body in the world. */
  _dropMagazine() {
    const phys = this.physics ?? (this.physics = this.ctx.peek('physics'));
    const w = this.viewmodel.active;
    if (!w) return;
    const proxy = this._magProxy(w);
    if (!proxy) return;
    const mag = w.parts.magazine;
    mag.updateMatrixWorld();
    proxy.group.position.setFromMatrixPosition(mag.matrixWorld);
    proxy.group.quaternion.setFromRotationMatrix(mag.matrixWorld);
    proxy.group.visible = true;
    // Magazine geometry hangs below its origin, so bias the body centre down.
    const half = w.magLen * 0.45;
    proxy.group.position.y -= half * 0.4;

    const vel = this._tmp.set(0, -0.7, 0);
    const pv = this.player?.velocity;
    if (pv) vel.add(pv);
    vel.x += this.fxRng.signed() * 0.25;
    vel.z += this.fxRng.signed() * 0.25;

    if (phys?.spawnDebris) {
      proxy.body = phys.spawnDebris(proxy.group.position, vel, {
        size: Math.max(0.02, w.magLen * 0.28),
        surface: 'rubber',
        mass: 0.38,
        lifetime: 22,
        restitution: 0.18,
        object3D: proxy.group,
      });
      proxy.until = this.ctx.time.elapsed + 22;
    } else {
      proxy.until = this.ctx.time.elapsed + 2;
    }
  }

  /** Two reusable world-space magazine props per weapon. */
  _magProxy(w) {
    if (!this._magPools) this._magPools = new Map();
    let pool = this._magPools.get(w.id);
    if (!pool) {
      pool = [];
      for (let i = 0; i < 2; i++) {
        const group = new THREE.Object3D();
        group.name = `dropped-mag-${w.id}-${i}`;
        group.visible = false;
        // Share the viewmodel's geometry and materials; the world copy needs no
        // resources of its own.
        w.parts.magazine.traverse((o) => {
          if (o.isMesh) {
            const m = new THREE.Mesh(o.geometry, o.material);
            m.position.copy(o.position);
            m.quaternion.copy(o.quaternion);
            m.castShadow = true;
            group.add(m);
          }
        });
        this.ctx.scene.add(group);
        pool.push({ group, body: null, until: 0 });
        this._droppedMags.push(pool[i]);
      }
      this._magPools.set(w.id, pool);
    }
    // Reuse the oldest.
    let best = pool[0];
    for (const p of pool) if (p.until < best.until) best = p;
    if (best.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(best.body);
    best.body = null;
    return best;
  }

  /* ====================================================================== */
  /*  tick — everything that decides IF and WHEN a round leaves               */
  /* ====================================================================== */

  /**
   * The shot clock, the cone and the trigger, on the fixed step.
   *
   * NETCODE STEP 4, and the last one the single-player build can do. `457cc65`
   * made the interval carry its overshoot so the RATE stopped being the
   * monitor's; `710c630` moved the AIM off the composed camera so the DIRECTION
   * stopped being the frame's. Both left the trigger itself in `update`, which
   * meant the tick a round belonged to was still "whichever one happened to be
   * last before the frame that fired it".
   *
   * Read from `ctx.commands.current`, never from the device. That is hard rule 7
   * — an edge query in a fixed step has to come from the command, because the
   * device's `pressed` set is frame-scoped and a fixed step is not a frame. It is
   * also the whole point: a command is addressable, a keyboard is not.
   *
   * The SPREAD moves here too, and it is not a free rider. `spreadDecay * dt` on
   * the rendered frame made the cone frame-rate dependent in exactly the way the
   * fire timer was — the cone a round leaves through is simulation, whatever
   * draws it.
   *
   * WHAT STAYS ON THE FRAME: the viewmodel, muzzle flash, brass, tracers, weapon
   * selection, fire-mode cycling and inspect. None of them decide where a round
   * goes or when it leaves, and the viewmodel in particular is driven from
   * `lateUpdate` because its clip events complete a weapon swap.
   */
  fixedUpdate(h, ctx) {
    const s = this.state;
    if (!s) return;
    const def = s.def;
    const input = ctx.input;
    const player = this.player ?? (this.player = ctx.peek('player'));
    const st = this._state;

    this._sinceShot += h;
    this._advanceFireTimer(h, def);
    if (this._burstCooldown > 0) this._burstCooldown -= h;

    // ---- spread recovery -------------------------------------------------
    const rest = this._restSpread(def, player, st);
    this._spread = Math.max(rest, this._spread - def.spreadDecay * h);
    if (this._sinceShot > 0.6) this._shotIndex = 0;

    st.speed = player?.horizontalSpeed ?? player?.speed ?? 0;
    st.crouch = player?.stance === 'crouch';
    st.airborne = player?.airborne === true;
    st.empty = s.mag === 0 && !s.chambered;

    if (!this._live(input, player)) return;

    // No command stream means no trigger. NOT a fall back to the device: two
    // sources for one decision is the defect this file has spent three commits
    // removing, and a harness that drives `weapons` directly can build commands
    // itself — `CommandStream.build` is public and `commands.BTN` names the bits.
    const cmd = ctx.commands?.current;
    if (!cmd) return;
    const BTN = ctx.commands.BTN;
    const held = (cmd.held & BTN.fire) !== 0;
    const pressed = (cmd.edge & BTN.fire) !== 0;

    if (cmd.edge & BTN.reload) this.reload();
    this._runTrigger(h, held, pressed, def, s);
    st.trigger = held && this.canFire();
    // Auto-reload on a dry trigger pull, like every modern shooter.
    if (pressed && st.empty) this.reload();
  }

  /**
   * "A real player is driving": not the capture harness, not a scripted debug
   * pose, not a dead or frozen one.
   *
   * `player.canFire` folds in freeze time, round end and death. It is read
   * through the player rather than from `match` directly so this subsystem keeps
   * its two dependencies (materials, physics) and never learns that rounds
   * exist. A missing player (a weapons-only harness) reads as fireable.
   */
  _live(input, player) {
    return (
      !input.frozen &&
      input.enabled !== false &&
      this.debugMode === null &&
      player?.canFire !== false
    );
  }

  /* ====================================================================== */
  /*  frame                                                                 */
  /* ====================================================================== */

  update(dt, ctx) {
    const s = this.state;
    if (!s) return;
    const input = ctx.input;
    const player = this.player ?? (this.player = ctx.peek('player'));

    // Hands off the screen while the player is down. The viewmodel is drawn in
    // a separate scene at the camera's origin, so a spectator camera following
    // a team-mate 20 m away would still have the dead player's rifle floating
    // in front of it.
    if (this.viewmodel?.anchor) this.viewmodel.anchor.visible = player?.dead !== true;

    const live = this._live(input, player);

    // ---- input -----------------------------------------------------------
    // What is left here is the UI half: choosing a weapon, a fire mode, or to
    // look at the thing. Edges are legal in `update` (hard rule 7) and none of
    // these change what a round does.
    if (live) {
      if (input.pressed('KeyB')) this.cycleFireMode();
      if (input.pressed('KeyI')) this.inspect();
      if (input.actionPressed('weapon1')) this.setWeapon('rifle');
      if (input.actionPressed('weapon2')) this.setWeapon('smg');
      if (input.actionPressed('weapon3')) this.setWeapon('pistol');
      if (input.actionPressed('swapWeapon')) this.nextWeapon();
      if (input.wheel) this.nextWeapon();
    } else if (this.debugMode) {
      // The capture harness fires by frame number, not by trigger, and it is a
      // frame-numbered thing by definition — `tools/capture.mjs` names the
      // frames it wants a muzzle flash on. It sets `_fireTimer` to zero and
      // calls `tryFire` directly, so none of the tick machinery is involved.
      this._runDebug(ctx);
      this._state.trigger = this._sinceShot < 0.09;
    }
  }

  /**
   * One tracer per `tracerEvery` rounds: muzzle to wherever the round landed.
   *
   * Drawn from the MUZZLE even though the round was traced from the eye — a
   * tracer that starts at the bridge of your nose looks wrong, and this is the
   * one place where the cosmetic origin and the ballistic origin should differ.
   */
  _emitTracer(def) {
    const phys = this.physics;
    let dist = Math.min(def.maxRange, 260);
    if (phys) {
      const hit = phys.raycast(
        this._eye.x, this._eye.y, this._eye.z,
        this._dir.x, this._dir.y, this._dir.z,
        dist, phys.MASK.BULLET
      );
      if (hit?.hit) dist = Math.max(0.5, hit.distance);
    }
    this._tracerTo.copy(this._eye).addScaledVector(this._dir, dist);
    this._tracerPayload.speed = def.muzzleVelocity;
    this._tracerPayload.weapon = def;
    this.ctx.events.emit('bullet:tracer', this._tracerPayload);
  }

  /**
   * Run the shot clock down, KEEPING the overshoot.
   *
   * This used to be `if (this._fireTimer > 0) this._fireTimer -= dt;`, with
   * `tryFire` then ASSIGNING `60 / rpm`. Between them those two lines threw away
   * however far past zero the frame had carried the timer, every single shot. So
   * the interval was rounded up to a whole number of frames and the loss was
   * whatever the remainder happened to be — which depends on the frame rate, and
   * not even monotonically. Measured with `tools/firerate.mjs`, holding the
   * trigger for three seconds:
   *
   *     M4A1, printed 800 rpm
   *       30 fps  600      60 fps  720      100 fps  760
   *      120 fps  720     144 fps  780
   *
   * A player on a 144 Hz monitor got a gun 30 % faster than one at 30 fps, and
   * nobody at all got 800. Worse for balance: the error differs BETWEEN guns
   * (-10 % rifle, -5.3 % SMG at 60 fps), so the matchup between them moved with
   * the monitor too — which quietly undermines every TTK in
   * `tools/ballistics.mjs`, since those are computed from the printed number.
   *
   * Carrying the overshoot makes the long-run rate exact at ANY frame rate: the
   * time a shot is early is repaid by the next one being late.
   *
   * The floor is one interval. Without it the timer runs unboundedly negative
   * while the trigger is up, and the first squeeze after a quiet minute would
   * empty half a magazine in one frame. One interval of credit means at most one
   * catch-up shot — which is right, because a frame that really did last two
   * intervals really did contain two shots.
   */
  _advanceFireTimer(dt, def) {
    this._fireTimer -= dt;
    const floor = -(60 / (def?.rpm || 600));
    if (this._fireTimer < floor) this._fireTimer = floor;
  }

  /** Fire-mode state machine. */
  _runTrigger(dt, held, pressed, def, s) {
    switch (s.mode) {
      case 'auto':
        // Loop, because one frame can owe more than one round. `tryFire` stops
        // it the moment the timer goes positive, and the floor above bounds the
        // credit at one interval, so this runs at most twice.
        if (held) while (this.tryFire());
        break;
      case 'burst':
        if (pressed && this._burstLeft === 0 && this._burstCooldown <= 0) {
          this._burstLeft = def.burstCount;
        }
        if (this._burstLeft > 0 && this._fireTimer <= 0) {
          if (this.tryFire()) {
            this._burstLeft--;
            // `+=` for the same reason as the auto path: a burst whose interval
            // is rounded up per round is a burst whose cadence is the monitor's.
            this._fireTimer += 60 / def.burstRpm;
            if (this._burstLeft === 0) this._burstCooldown = def.burstDelay;
          } else {
            this._burstLeft = 0;
          }
        }
        break;
      default: // semi
        if (pressed) this.tryFire();
        break;
    }
  }

  /**
   * The floor the cone decays back to. This is the whole accuracy model now
   * that there is no ADS: stand still and crouch to shoot tight, move or jump
   * and pay for it. `airborne` is the harshest multiplier on purpose — a
   * jumping player must not be able to win a duel with a spray.
   */
  _restSpread(def, player, st) {
    let base = def.spreadHip;
    if (st.crouch) base *= SPREAD_MODS.crouch;
    if (st.speed < 0.4) base *= SPREAD_MODS.still;
    else if (st.speed > 3.2) base *= SPREAD_MODS.walking;
    if (st.airborne) base *= SPREAD_MODS.airborne;
    return base;
  }

  /**
   * Turn queued shots into `weapon:fire` events.
   *
   * Extracted from `lateUpdate` so the pre-warm can drive it without stepping the
   * engine. A shot does not emit its own flash: `tryFire` bumps `_pendingShots`
   * and this runs once the viewmodel pose is final, which is the only moment the
   * muzzle transform is right. The pre-warm has to reach it, because the flash is
   * where the remaining first-shot cost lives — one shader program and three
   * textures, measured at 243 ms — and it cannot get there by stepping the engine
   * without shifting the TAA jitter phase of every capture in the gate set.
   */
  _flushShots(ctx) {
    if (this._pendingShots <= 0) return 0;
    const vm = this.viewmodel;
    const n = this._pendingShots;
    vm.muzzleWorld(this._firePayload.origin);
    vm.boreDir(this._firePayload.dir);
    this._firePayload.weapon = this.current;
    this._firePayload.seed = this._fireSeed >>> 0;
    for (let i = 0; i < n; i++) ctx.events.emit('weapon:fire', this._firePayload);
    this._pendingShots = 0;
    this._pendingFirst = false;
    return n;
  }

  lateUpdate(dt, ctx) {
    const vm = this.viewmodel;
    if (!vm) return;
    vm.update(dt, this._state);

    // ---- muzzle flash / audio, now that the pose is final ---------------
    this._flushShots(ctx);

    // ---- deferred shell ejection ---------------------------------------
    for (const q of this._shellQueue) {
      if (q.t < 0) continue;
      q.t -= dt;
      if (q.t > 0) continue;
      q.t = -1;
      vm.ejectWorld(this._shellPayload.position);
      vm.ejectVelocity(this._shellPayload.velocity, 2.3 + this.fxRng.float() * 1.2);
      const pv = this.player?.velocity;
      if (pv) this._shellPayload.velocity.add(pv);
      this._shellPayload.velocity.y += 1.1;
      this._shellPayload.weapon = this.current;
      const shell = vm.active?.shell;
      this._shellPayload.caseLen = shell?.caseLen ?? 0.0446;
      this._shellPayload.caseRadius = shell?.rimR ?? 0.00495;
      this._shellPayload.spin = 28 + this.fxRng.float() * 34;
      ctx.events.emit('weapon:shell', this._shellPayload);
    }

    // ---- retire dropped magazines --------------------------------------
    if (this._droppedMags.length) {
      const now = ctx.time.elapsed;
      for (const p of this._droppedMags) {
        if (p.group.visible && p.until && now > p.until) {
          p.group.visible = false;
          if (p.body && this.physics?.removeRigidBody) {
            this.physics.removeRigidBody(p.body);
            p.body = null;
          }
        }
      }
    }
  }

  /* ====================================================================== */
  /*  capture harness                                                       */
  /* ====================================================================== */

  /**
   * Freeze the viewmodel in a photogenic state.
   * The harness applies a shot, then pumps `SETTLE` frames before grabbing the
   * frame, so 'fire' schedules a short burst that peaks right at the capture.
   */
  debugPose(kind = 'idle', opts = {}) {
    const vm = this.viewmodel;
    this.debugMode = kind;
    this.setWeaponImmediate('rifle');
    vm.stopClip();
    vm.recPos.reset();
    vm.recRot.reset();
    vm.settle.reset();
    vm.lag.reset();
    vm.lagRot.reset();
    vm.boltHold = 0;
    vm.boltCycle = 0;
    vm.bobPhase = 0;
    vm._angVel.yaw = 0;
    vm._angVel.pitch = 0;
    vm._hasPrev = false;
    // A fixed, non-zero noise phase: a settled but not artificially symmetric pose.
    vm.noiseT = 12.37;
    vm.debugFrozen = true;
    this._spread = 2.05;
    this._sinceShot = 10;
    this._debugFrame = 0;

    const s = this.state;
    if (s) {
      s.mag = kind === 'fire' ? 22 : s.def.magSize;
      s.chambered = true;
      s.reserve = s.def.reserve;
    }

    this._state.speed = 0;
    this._state.trigger = false;
    // Frames (at the harness's fixed 60 Hz) on which to fire for the 'fire'
    // shot. The burst has to land at the END of the harness's settle window: a
    // flash core lives 52 ms (~3 frames), so the last rounds must leave the
    // barrel a frame or two before the grab or there is nothing to photograph.
    // `grabFrame` is how many frames the harness will pump — it is a CLI flag
    // (`--settle`), so it cannot be hard-coded here. The offsets below straddle
    // the grab because the harness pumps on its own rAF chain, which can land a
    // frame either side of the engine's.
    // A flash core lives 52 ms — about three frames at 60 Hz — while the exact
    // frame the shutter lands on is only known to within a handful of frames
    // (the harness pumps its settle count on its own rAF chain, then the
    // screenshot RPC costs a few more). So: three spaced rounds early to fill
    // the frame with drifting smoke, brass in flight and a tracer, then a
    // sustained tail on a 2-frame cadence, so a flash is lit continuously
    // across the whole uncertainty window.
    //
    // The cadence was 3 frames, which is the flash core's own lifetime rounded
    // UP: measured across settle 86/88/90/92/94, frame 90 landed in the trough
    // between two cores and photographed a dying flash (10k hot pixels against
    // 26-29k on either side). Two frames guarantees overlap.
    if (kind === 'fire') {
      const grab = Math.round(opts?.grabFrame ?? 90);
      const frames = [grab - 26, grab - 19, grab - 12];
      for (let f = grab - 6; f <= grab + 18; f += 2) frames.push(f);
      this._scriptFrames = frames.filter((f) => f >= 2);
    } else {
      this._scriptFrames = null;
    }
    return kind;
  }

  /** Swap without the draw animation (harness + debug only). */
  setWeaponImmediate(id) {
    if (!this.states.has(id)) return false;
    this._switchTo = null;
    this.activeId = id;
    this.viewmodel.setActive(id);
    return true;
  }

  _runDebug(ctx) {
    this._debugFrame = (this._debugFrame ?? 0) + 1;
    const frames = this._scriptFrames;
    if (!frames) return;
    for (const f of frames) {
      if (f === this._debugFrame) {
        this._fireTimer = 0;
        this.tryFire();
      }
    }
  }

  /* ====================================================================== */

  resize() {}

  dispose() {
    for (const off of this._off ?? []) off();
    for (const p of this._droppedMags) {
      p.group.removeFromParent();
      if (p.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(p.body);
    }
    this._droppedMags.length = 0;
    this.viewmodel?.dispose();
    this.mats?.dispose();
  }
}
