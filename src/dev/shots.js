/**
 * Capture harness — named camera poses plus a deterministic frame pump.
 *
 * Two things here are load-bearing and were both learned the hard way upstream:
 *
 * 1. LOCKSTEP. The engine must not schedule its own frames while the driver is
 *    doing round trips (waitForFunction, evaluate, the screenshot RPC). The
 *    number of frames that fit inside those round trips is wall-clock dependent,
 *    so `engine.time.frame` at the shutter drifts run to run — and TAA jitter,
 *    GTAO/SSR noise rotation (`frame % 64`) and exposure adaptation are all
 *    phase-locked to the absolute frame index. In lockstep the only thing that
 *    advances a frame is __PUMP__.
 *
 * 2. FIXED FAKE CLOCK. In capture mode `rawDt` is forced to exactly 1000/60 on
 *    every frame including the first, whatever stamped `_last` before it
 *    (Engine.start and prewarm both assign performance.now()).
 *
 * Gameplay debug hooks are called through `peek()?.` so this file stays valid
 * while those subsystems do not exist yet. They light up on their own as the
 * milestones land.
 */

import * as THREE from 'three';

/**
 * Named shots. Poses are world space, authored against `src/world/warehouse.js`
 * — a 48 x 36 x 6 m depot mirrored about Z. Landmarks the poses depend on:
 *
 *   outer walls   x = +-24, z = +-18        skylight run   x = +-2.5, roof 6 m
 *   partitions    x = +-9.5, doors at |z| = 4.2 and 9.6
 *   lane shelving x = +-14.5, |z| = 4.5 and 10   (walk line is |x| ~ 12)
 *   spawn cover   x = +-7,  |z| = 13.8      centre island  origin, 4.6 x 2.2
 *
 * Eye height is 1.66 m (STANCE.stand.eye), so poses sit at that unless the shot
 * is deliberately crouched or leaning in on a prop.
 *
 * @type {Record<string, {pos: number[], look: number[], fov?: number, apply?: Function}>}
 */
export const SHOTS = {
  /** Down the long axis from the bravo end — deepest cascades, most of the map. */
  boot: {
    pos: [0, 1.66, 16.5],
    look: [0, 1.4, -17],
  },
  /** Alpha centre spawn, looking up the map — the player's first frame. */
  spawn: {
    pos: [0, 1.66, -16],
    look: [0, 1.5, 17],
  },
  /** West lane between the outer wall and the shelving — the darker route. */
  lane: {
    pos: [-12, 1.66, -12.5],
    look: [-11, 1.5, 11],
  },
  /**
   * The centre hall from its alpha-side corner: the island, the skylight above
   * it, the far partition doors behind.
   *
   * The look target is the ISLAND, not the far corner. A 45-degree diagonal from
   * here runs straight into the x = +9.5 partition and the wall fills half the
   * frame — which is what the first version of this pose did, and it photographed
   * a concrete slab rather than the room the whole map is built around.
   */
  hall: {
    pos: [-7.6, 1.66, -9.2],
    look: [0.5, 0.9, 0.5],
  },
  /** A partition doorway head on: the lintel, the frame, the lane beyond. */
  corner: {
    pos: [-4.5, 1.66, -4.2],
    look: [-16, 1.45, -4.6],
  },
  /** Close on the hall-mouth crate stack — material detail, contact shadow. */
  detail: {
    pos: [4.2, 1.4, 5.4],
    look: [6.5, 0.8, 7.5],
  },
  /**
   * The two spawn bays, looking down at the painted floor.
   *
   * `world/warehouse.js:floorMarkings` gives the paint three jobs, and the
   * second one — per-team bay colour as the map's ONLY asymmetry, so a player
   * who has turned around twice can tell which end is his — is a gameplay claim
   * rather than decoration. Neither `spawn` nor `boot` can check it: both stand
   * ON their own bay looking up the map, so the bay under the camera is out of
   * frame and the far one sits behind the centre block. The claim went
   * unphotographed for that reason alone, not because anyone judged it fine.
   *
   * These look DOWN and BACK at the bay from just outside it, which is the
   * geometry that shows the paint. Capture both and compare: if `bay_alpha` does
   * not read cool against `bay_bravo`'s warm, job 2 is not being done.
   *
   * Stand back at 6 m and up at 2.4 rather than at eye height 4 m out: the bay
   * runs z = 14.9..17.9 and its hazard threshold sits at 14.6, and from the
   * closer pose the hatching fell below the bottom of the frame — so the shot
   * could photograph job 2 but not job 3. `tools/markings.mjs` measures both
   * out of these two frames.
   */
  bay_alpha: {
    pos: [0, 2.4, -10.0],
    look: [0, 0, -16.0],
  },
  bay_bravo: {
    pos: [0, 2.4, 10.0],
    look: [0, 0, 16.0],
  },
  /**
   * Both teams on the floor, from the alpha end.
   *
   * Deterministic capture runs deliberately do NOT garrison the level (see
   * `AiSystem._bootNav`) — moving actors would make every baseline shot a
   * different image. This shot opts back in explicitly, so there is one frame
   * that shows the rosters, the two camo sets and the ground shadows. It is not
   * a baseline candidate and should not be added to one.
   */
  bots: {
    pos: [0, 1.66, -15],
    look: [0, 1.5, 14],
    apply: (e) => {
      const ai = e.ctx.peek('ai');
      if (!ai) return;
      ai.forcePopulate = true;
      if (ai.agents.length === 0) ai.populate({ perTeam: 5 });
    },
  },
  /**
   * The HUD with a live match behind it.
   *
   * `match` does not auto-start in a deterministic run (a round loop would put
   * the shutter in warmup on one run and freeze on the next, and those are
   * different scenes), so this starts one explicitly with fixed scores. The
   * numbers are chosen to exercise the bar rather than to be plausible: an
   * asymmetric score so the pip rows differ, and a live phase so the clock is
   * the ordinary colour rather than the hold amber.
   */
  hud: {
    pos: [0, 1.66, -15],
    look: [0, 1.5, 14],
    apply: (e) => {
      const ai = e.ctx.peek('ai');
      if (ai) {
        ai.forcePopulate = true;
        if (ai.agents.length === 0) ai.populate({ perTeam: 5 });
      }
      const match = e.ctx.peek('match');
      if (!match) return;
      match.startMatch({ warmup: 0, freeze: 0, live: 78, roundEnd: 4, roundsToWin: 5 });
      match.round.scores.alpha = 3;
      match.round.scores.bravo = 2;
      match.round.round = 6;
      match.round.phase = 'live';
      match.round.remaining = 78;
      e.ctx.peek('ui')?.killfeed?.push({ attacker: 'YOU', victim: 'B-4', headshot: true, mine: true });
      e.ctx.peek('ui')?.killfeed?.push({ attacker: 'B-2', victim: 'A-3', attackerFriendly: false });
    },
  },
  /** Transient burst against the partition: particles, decals, impact fx. */
  impacts: {
    pos: [4, 1.6, -2],
    look: [-9, 1.5, -6],
    apply: (e) => e.ctx.peek('fx')?.debugBurst?.('wall'),
  },
};

export function installShotApi(engine, { capture, lockstep = false } = {}) {
  window.__SHOTS__ = SHOTS;

  /**
   * `opts.grabFrame` is how many frames the harness pumps before the shutter.
   * Shots whose subject is a transient (a muzzle flash lives ~52 ms) need it so
   * they can land the event on the captured frame instead of guessing.
   */
  window.__APPLY_SHOT__ = (name, opts = {}) => {
    const shot = SHOTS[name];
    if (!shot) return { error: `unknown shot "${name}"`, available: Object.keys(SHOTS) };

    // Freeze live input and hand the camera to the shot.
    engine.input.frozen = true;
    engine.input.enabled = false;
    const player = engine.ctx.peek('player');
    player?.setControlEnabled?.(false);

    const cam = engine.camera;
    cam.position.fromArray(shot.pos);
    cam.lookAt(new THREE.Vector3().fromArray(shot.look));
    if (shot.fov) {
      cam.fov = shot.fov;
      cam.updateProjectionMatrix();
    }
    // Keep the player capsule under the camera so gameplay systems stay coherent.
    player?.teleport?.(cam.position, cam.rotation);

    // Shots are applied back to back in one browser session, so clear the
    // previous shot's *looping* debug state first — otherwise `impacts` is still
    // walking rounds across a wall while a later shot is being photographed.
    engine.ctx.peek('fx')?.debugBurst?.('none');
    engine.ctx.peek('weapons')?.debugPose?.('idle');
    engine.ctx.peek('ui')?.debugState?.('clean');

    if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
    shot.apply?.(engine, opts);

    engine.events.emit('shot:applied', { name, shot });
    return { applied: name, pos: shot.pos, fov: shot.fov ?? engine.config.fov };
  };

  if (capture) {
    engine.input.frozen = true;
    let fake = 0;
    engine.step = ((orig) =>
      function () {
        this._last = fake;
        fake += 1000 / 60;
        return orig.call(this, fake);
      })(engine.step);
  }

  window.__RENDER_INFO__ = null;
  const snapInfo = () => {
    const r = engine.ctx.peek('render');
    window.__RENDER_INFO__ = {
      frame: engine.time.frame,
      calls: r?.renderer?.info.render.calls ?? 0,
      tris: r?.renderer?.info.render.triangles ?? 0,
      programs: r?.renderer?.info.programs?.length ?? 0,
      textures: r?.renderer?.info.memory.textures ?? 0,
      geometries: r?.renderer?.info.memory.geometries ?? 0,
      ms: engine.time.dt * 1000,
    };
  };

  if (lockstep) {
    engine.start = function () { this._running = true; };
    window.__LOCKSTEP__ = true;

    // THE PUMP CARRIES ITS OWN CLOCK.
    //
    // It used to call `engine.step()` with no argument and rely on capture mode
    // having monkey-patched `step` to ignore the argument and use a fake
    // monotonic clock. That coupling is why lockstep could not be used without
    // `?capture=1` — and capture also sets `config.deterministic`, which makes
    // `ai.populate` skip, so any harness that wanted a REPRODUCIBLE BOOT had to
    // accept a world with no bots in it. A pump that supplies its own clock has
    // no such dependency; under capture the patched `step` ignores this argument
    // exactly as before, so nothing about the pixel gate changes.
    let pumped = 0;

    /** Advance exactly `n` engine frames, one per rAF so each is presented. */
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        engine.step((pumped += 1000 / 60));
        snapInfo();
        if (++i >= n) resolve(engine.time.frame);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /** Yield `n` rAFs WITHOUT stepping, so the compositor picks up the last
     *  rendered frame before the screenshot. Advances no simulation state. */
    window.__PRESENT__ = (n = 2) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  } else {
    window.__LOCKSTEP__ = false;
    // Free-running: the engine drives itself, __PUMP__ just waits out n frames.
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    window.__PRESENT__ = window.__PUMP__;
    const info = () => { snapInfo(); requestAnimationFrame(info); };
    requestAnimationFrame(info);
  }

  return { pump: window.__PUMP__, present: window.__PRESENT__, lockstep: !!lockstep };
}
