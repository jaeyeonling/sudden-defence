#!/usr/bin/env node
/**
 * Weapon measurement — M7's instrument.
 *
 * Balance arguments made from a table of numbers are arguments about the table.
 * This measures what the numbers actually DO on this map, at this map's ranges,
 * through the real fire path:
 *
 *   - shots to kill, torso and head, at 5 / 15 / 25 / 35 m, after range falloff
 *   - the spread cone in METRES at 20 m, for each stance and for sustained fire
 *   - the recoil pattern's total climb, and that it is byte-identical run to run
 *
 * The two things worth knowing before reading the output:
 *
 * `spreadHip` is a HALF-angle in degrees, applied as `tan(spread) * disc`, so
 * the honest question is "how many metres wide is the cone where I am actually
 * fighting" — 2.05 degrees sounds tight and is 0.72 m of radius at 20 m, which
 * is wider than a torso.
 *
 * Falloff is `1 - (1 - dropoff) * (travelled/falloffRange)^2`. It used to read
 * `maxRange`, which is in the hundreds of metres, so on a 48x36 m depot the
 * ratio never left the flat part of that parabola: every weapon did full damage
 * everywhere and the range axis — the thing that is supposed to separate an SMG
 * from a carbine — did not exist. `falloffRange` (55/30/38) is what fixed it,
 * and the STK row in the summary is where you check it is still true.
 *
 * WHAT THIS TOOL CANNOT TELL YOU is which side of a crossover matters, because
 * that is a fact about the map and not about the guns. `tools/botfight.mjs`
 * measures it — shooter-to-impact distance on every hit, median 13-15 m across
 * runs — and the two have to be read together. A four-round band that closes
 * before that median is a gun nobody should pick, however good its top line
 * looks here; that is exactly what the MPX-9 was until its damage went to 29.
 *
 *   node tools/ballistics.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { stkBands, formatBands, bandEdge } from './lethality.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
const RANGES = [5, 15, 25, 35];
/** Where the cone is measured. Median engagement distance on this map. */
const MEASURE_AT = 20;
/**
 * The frame time every TTK below is measured at.
 *
 * 60, because it is both the commonest operating point and the one the fire
 * timer used to be worst at for the rifle (-10 %). It is one rate on purpose —
 * sweeping five of them is `tools/firerate.mjs`'s job, and duplicating the sweep
 * here would be two implementations of the same measurement free to disagree.
 * What this needs is narrower: is the cadence this tool prints TTKs from the
 * cadence the code produces, right here, right now.
 */
const TTK_FPS = 60;
/** Seconds of fire per weapon for that measurement. */
const TTK_HOLD_S = 3;
/** How far the measured rate may sit from the printed one before it is a fault. */
const RPM_TOL = 0.05;
/**
 * Median shooter-to-impact distance on this map, in metres.
 *
 * NOT a design choice — a reading, and the only reason it is a constant here is
 * that the tool that takes it is a different process. `tools/botfight.mjs`
 * records every hit's distance; POOLED across eight fights (n=255) the current
 * warehouse gives p25 9.3, p50 14.4, p75 19.8 m.
 *
 * Pooled, because a single fight yields 20-40 hits and its p50 is a coin toss
 * dressed as a measurement — the eight runs behind this number had per-run
 * medians of 7.3, 12.2, 13.8, 14.4, 14.6, 16.1, 16.5 and 20.0 m. Quoting any
 * one of those would move the MPX-9 verdict; quoting the pool does not.
 *
 * It is used for ONE thing: warning when a primary's four-round band closes in
 * front of the distance people actually fight at, which is what made the MPX-9 a
 * trap pick at 27 damage (band 11.5 m, 29 % of hits). Re-derive it whenever
 * `world/warehouse.js` moves — cover is what sets it.
 */
const MEDIAN_ENGAGEMENT = Number(args.median ?? 14.4);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  // `OW_NO_HMR=1`: the server this harness owns must not hot-reload.
  //
  // `vite.config.js` has carried the guard and the explanation since the capture
  // harness needed it — a file saved while a run is in flight reloads the page
  // and playwright fails the in-flight `page.evaluate` with "Execution context
  // was destroyed" — and `tools/capture.mjs` was the only tool that set it. Every
  // tool here spawns the same server for the same reason, and in `npm test` the
  // one that wins the race owns it for the whole chain, so the guard has to be on
  // all of them or it is on none of the ones that matter. Cost when nothing is
  // being edited: nothing.
  vite = spawn('npx', ['vite', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 80 && !(await portOpen(PORT)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ RANGES, MEASURE_AT, TTK_FPS, TTK_HOLD_S }) => {
    const e = window.__ENGINE__;
    const match = e.ctx.get('match');
    const weapons = e.ctx.get('weapons');
    const player = e.ctx.get('player');

    match.stopMatch();
    player.setControlEnabled(false);

    /**
     * Hold the aim still, so the cone that comes out is PURE SPREAD.
     *
     * `setControlEnabled(false)` alone used to do this, and only by accident:
     * with control off `player.update` never called `rig.applyTo`, so the engine
     * camera was frozen — and `tryFire` traced from the camera. The recoil the
     * rig accumulated went nowhere. Now that rounds follow the rig's aim
     * directly, that accidental isolation is gone and the accumulation is
     * visible: `measure` fires 240 rounds without stepping the engine, so 240
     * recoil impulses pile up unintegrated and then unwind all at once during
     * the next weapon swap. Measured, that put the SMG cone at 18.5 m and the
     * pistol at 26.4 m while the rifle — measured first, before anything had
     * accumulated — came out correct at 0.132 m.
     *
     * So say it outright. The recoil pattern is measured separately below
     * (`patternClimbDeg`); it has no business inside the spread figure.
     */
    const freezeAim = () => {
      const rig = player.cameraRig;
      rig.recoilPitch.reset();
      rig.recoilYaw.reset();
      rig.recoilRoll.reset();
      rig.stepAim(0, player.movement);
    };

    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });

    // Stand in the alpha half facing +Z down the long axis; the far wall is
    // 34 m away, so every measurement range has bare floor and a wall behind it.
    const FEET = { x: 0, y: 0.03, z: -16 };
    const EYE_H = 1.66;
    const YAW = Math.PI; // world convention: forward = (-sin, -cos) = (0, +1)
    player.teleport({ x: FEET.x, y: FEET.y + EYE_H, z: FEET.z }, YAW);
    await frames(2);

    /**
     * The AIM origin, which is where rounds actually leave from.
     *
     * NOT `ctx.camera.position`, which is what this read for its whole life.
     * `player.update` only writes the engine camera while control is enabled
     * and this harness disables it two lines up — so the camera stays wherever
     * the boot frames left it, at the spawn, and never learns about the
     * teleport. That was invisible while `tryFire` ALSO traced from the camera:
     * origin, direction and this reference point were the same stale transform,
     * so the cone came out right and the tool was quietly measuring a stance it
     * was not standing in. The moment the round started leaving from the tick's
     * eye (`player/camera.js`), projecting impacts from the camera reported
     * 90th-percentile cone radii of 17, 56 and 71 metres.
     */
    const eye = player.aimOrigin.clone();
    // Assert the aim landed where the teleport asked, because everything below
    // is measured relative to it and "the reference point is somewhere else"
    // reads exactly like "this weapon is wildly inaccurate".
    const aimDrift = Math.hypot(
      eye.x - FEET.x, eye.y - (FEET.y + EYE_H), eye.z - FEET.z
    );
    if (aimDrift > 0.05) {
      return { fatal: `aim origin is ${aimDrift.toFixed(2)} m from the teleport target` };
    }

    /* ---- falloff, straight off the model physics actually applies -------- */
    const rangeMul = (def, d) => {
      const r01 = Math.min(1, d / (def.falloffRange ?? def.maxRange));
      return 1 - (1 - def.dropoff) * r01 * r01;
    };
    const stk = (dmg, hp = 100) => Math.ceil(hp / dmg);

    /* ---- cone measurement ------------------------------------------------ */
    //
    // Fired through `weapons.tryFire()` so this is the real path — the same
    // rng disc, the same `tan(spread)`, the same trace from the eye. Impacts
    // are caught off `bullet:impact` and projected onto the plane at
    // MEASURE_AT metres, which is what "the cone at 20 m" actually means.
    let refill = () => {};
    const measure = async (setup, shots, gapFrames) => {
      const pts = [];
      /**
       * One sample per SHOT, not per impact.
       *
       * `physics` emits `bullet:impact` on entry and exit of every layer, and
       * filtering `p.exit` is not enough: a round that punches through the far
       * wall re-enters whatever stands behind it and emits a second ENTRY. The
       * penetration solver deflects it on the way through, so that second point
       * is scattered — and projecting it onto the 20 m plane by `dz` treats the
       * scatter as if it had come out of the muzzle.
       *
       * Measured: 240 rifle rounds produced 480 samples, r50 0.137 m (which is
       * exactly `tan(0.48 * 0.82 deg) * 20`, i.e. the cone, correct) but r90
       * 0.347 m — the 90th percentile had walked off the end of the real group
       * and into the post-penetration tail. The SMG and pistol lack the power to
       * get through and reported 240/240, which is why the gate accused the
       * rifle of being the least accurate weapon in the game.
       *
       * The cone is where the round LEAVES, so only the first impact counts.
       */
      let armed = false;
      const off = e.events.on('bullet:impact', (p) => {
        if (p.exit || !armed) return;
        armed = false;
        const dx = p.point.x - eye.x;
        const dy = p.point.y - eye.y;
        const dz = p.point.z - eye.z;
        const t = dz !== 0 ? MEASURE_AT / dz : 0;
        if (t <= 0) return;
        pts.push([dx * t, dy * t]);
      });
      setup();
      let fired = 0;
      for (let i = 0; i < shots; i++) {
        refill();
        weapons._fireTimer = 0;
        freezeAim();
        armed = true;
        if (weapons.tryFire()) fired++;
        setup(); // re-clamp the cone to the stance floor for the next round
        if (gapFrames) await frames(gapFrames);
      }
      off();
      // Radius that contains 90% of the group — a mean would be dragged around
      // by the disc's centre bias and a max by one flier.
      const r = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
      return {
        fired,
        n: r.length,
        r50: r.length ? +r[Math.floor(r.length * 0.5)].toFixed(3) : null,
        r90: r.length ? +r[Math.min(r.length - 1, Math.floor(r.length * 0.9))].toFixed(3) : null,
      };
    };

    const results = {};
    for (const id of ['rifle', 'smg', 'pistol']) {
      // Wait for the swap to LAND, not for a guessed number of frames.
      // `setWeapon` runs a holster+draw animation and `tryFire` refuses while
      // `switching` is true — the first version slept 30 frames, measured the
      // previous weapon's def, and fired zero rounds into every cone sample.
      weapons.setWeapon(id);
      for (let i = 0; i < 240 && (weapons.activeId !== id || weapons.switching); i++) {
        await frames(1);
      }
      // These are the only real engine frames in the run, so they are the only
      // place unintegrated recoil can unwind. Land the aim before measuring.
      freezeAim();
      const def = weapons.current;
      const st = weapons.states.get(id);
      /** Reloading also blocks the trigger; top the magazine up by hand. */
      refill = () => { st.mag = def.magSize; st.chambered = true; };
      refill();

      // ---- the cadence every TTK below is derived from, MEASURED -----------
      //
      // This used to read `def.rpm` — the number in the table — and that is a
      // claim about the code, not a reading of it. The claim was false for the
      // whole life of this tool: `_fireTimer` rounded each interval up to a
      // whole frame, so at 60 fps the M4A1 ran at 720 rpm and the MPX-9 at 900.
      // Every TTK printed here was short, by a DIFFERENT fraction per gun
      // (-10 % against -5.3 %), which means the matchup this tool exists to
      // arbitrate was partly the monitor's. `_advanceFireTimer` carries the
      // overshoot now and `tools/firerate.mjs` gates it across five frame
      // rates; what is left for this tool is to stop asserting the input.
      //
      // Driven through `tryFire()` rather than the held-trigger path because
      // `player.setControlEnabled(false)` above — which this tool needs, to
      // freeze the camera so the cone is pure spread — switches the trigger
      // branch off. `_advanceFireTimer` runs before that gate, so the timer
      // arithmetic under test is live either way.
      const dtFixed = 1 / TTK_FPS;
      const auto = (def.modes ?? []).includes('auto');
      let shots = 0;
      let tFirst = -1;
      let tLast = -1;
      let clock = 0;
      weapons._fireTimer = 0;
      for (let i = 0; i < Math.round(TTK_HOLD_S * TTK_FPS); i++) {
        refill();
        freezeAim();
        // `fixedUpdate`, because the shot clock and the cone live on the tick
        // now. `update` is the viewmodel and the muzzle flash and would advance
        // neither. Driven directly rather than through a command because this
        // measures the CLOCK, not the trigger: `tryFire` is called by hand below
        // exactly as the cone measurement does it.
        weapons.fixedUpdate(dtFixed, e.ctx);
        clock += dtFixed;
        // The real auto path is `while (tryFire())`: a frame that lasted two
        // intervals owes two rounds. A semi gets one press, so one round —
        // and its printed rpm is a CAP on clicking, not a cadence, so it is
        // only reachable up to one round per frame.
        let fired = 0;
        if (auto) { while (weapons.tryFire()) fired++; }
        else if (weapons.tryFire()) fired = 1;
        if (fired) {
          shots += fired;
          if (tFirst < 0) tFirst = clock;
          tLast = clock;
        }
      }
      // Rate BETWEEN shots. The gun is ready when the loop starts, so the first
      // round belongs to no interval and counting it against elapsed time adds a
      // whole shot to the average — which reads as a defect and is not one.
      const measuredRpm =
        shots > 1 ? Math.round(((shots - 1) / (tLast - tFirst)) * 60) : 0;
      const reachableRpm = auto ? def.rpm : Math.min(def.rpm, TTK_FPS * 60);
      weapons._fireTimer = 0;
      refill();

      // ---- lethality ----
      const table = {};
      for (const d of RANGES) {
        const mul = rangeMul(def, d);
        const body = def.damage * mul;
        table[`${d}m`] = {
          dmg: +body.toFixed(1),
          torso: stk(body),
          head: stk(body * 4),
          // Time from the first round leaving the barrel to the killing one,
          // at the cadence the code actually produces.
          ttkMs: measuredRpm
            ? Math.round(((stk(body) - 1) * 60000) / measuredRpm)
            : null,
          // What the table claims it would be. Kept alongside rather than
          // dropped: when the two diverge, the gap is the finding.
          ttkNominalMs: Math.round(((stk(body) - 1) * 60000) / def.rpm),
        };
      }

      // ---- cone, one shot at a time with a long gap so spread sits at rest --
      const rest = {};
      const stances = {
        crouchStill: () => { weapons._state.crouch = true; weapons._state.speed = 0; },
        standStill: () => { weapons._state.crouch = false; weapons._state.speed = 0; },
        walking: () => { weapons._state.crouch = false; weapons._state.speed = 4; },
        airborne: () => { weapons._state.airborne = true; weapons._state.speed = 4; },
      };
      for (const [name, set] of Object.entries(stances)) {
        // Force the floor: `_restSpread` is recomputed every update from the
        // stance block, so set it and clamp the cone to it before firing.
        set();
        weapons._spread = weapons._restSpread(def, player, weapons._state);
        // 240 rounds, not 40.
        //
        // `r90` is a single order statistic, and out of 40 samples it is the 36th
        // value — noisy enough that this gate went red once in four runs while
        // three consecutive re-runs passed. The failing number was 0.204 m against
        // a 0.200 m threshold: a 2 % difference decided by which four rounds
        // happened to fly widest, reported as "the first shot is a coin flip". A
        // flaky gate is worse than no gate, because the first thing it teaches you
        // is to re-run it until it goes green.
        //
        // The fix is resolution, not a looser threshold: the threshold is a torso
        // half-width and means something, so it is the estimate that has to get
        // better. Six times the sample shrinks the sampling error on r90 by roughly
        // 2.5x, and costs a fraction of a second in a harness that already spends
        // seconds waiting out weapon-swap animations.
        rest[name] = await measure(() => {
          weapons._spread = weapons._restSpread(def, player, weapons._state);
        }, 240, 0);
        // measure() fires the rounds back to back, which would grow the cone —
        // so the setup re-clamps to the floor before each. Re-clamp after too.
        weapons._state.airborne = false;
      }
      weapons._state.crouch = false;
      weapons._state.speed = 0;

      // ---- sustained fire: the cone after a held trigger -------------------
      // No re-clamp: this is what the spread model does when you hold it down.
      weapons._spread = def.spreadHip;
      const sustained = [];
      for (let i = 0; i < 20; i++) {
        refill();
        weapons._fireTimer = 0;
        freezeAim();
        weapons.tryFire();
        sustained.push(+weapons.spreadDegrees.toFixed(3));
        // Advance the clock by exactly one shot interval so decay is real.
        // `fixedUpdate`: spread decay moved to the tick with the shot clock,
        // because the cone a round leaves through is simulation whatever draws
        // it. Calling `update` here decayed nothing and reported a cone that
        // only ever grew.
        weapons.fixedUpdate(60 / def.rpm, e.ctx);
      }

      // ---- recoil pattern --------------------------------------------------
      // The CUMULATIVE path of the muzzle, which is what a player learns —
      // per-shot deltas are what the table stores, and reading those tells you
      // nothing about the shape they trace.
      let climb = 0;
      let drift = 0;
      let maxDrift = 0;
      let right = 0;      // furthest the muzzle ever gets to the right
      let left = 0;       // ...and to the left. Together: is it a snake or a hook?
      let perShotClimb = 0;
      let killBurstLateral = 0; // worst |lateral| inside the four rounds that kill
      let crossings = 0;
      let prev = 0;
      const plen = Math.min(def.recoil.patternLength, (st.pattern?.length ?? 0) >> 1);
      for (let i = 0; i < plen; i++) {
        perShotClimb = Math.max(perShotClimb, st.pattern[i * 2]);
        climb += st.pattern[i * 2];
        drift += st.pattern[i * 2 + 1];
        maxDrift = Math.max(maxDrift, Math.abs(drift));
        right = Math.max(right, drift);
        left = Math.min(left, drift);
        if (i > 0 && Math.sign(drift) !== Math.sign(prev)) crossings++;
        prev = drift;
        if (i < 4) killBurstLateral = Math.max(killBurstLateral, Math.abs(drift));
      }

      results[id] = {
        label: def.label,
        rpm: def.rpm,
        measuredRpm,
        reachableRpm,
        measuredAtFps: TTK_FPS,
        measuredShots: shots,
        magSize: def.magSize,
        damage: def.damage,
        dropoff: def.dropoff,
        falloffRange: def.falloffRange ?? def.maxRange,
        maxRange: def.maxRange,
        // The whole point: how much of the falloff curve this map can reach.
        rangeUsedAt35m: +(35 / (def.falloffRange ?? def.maxRange)).toFixed(3),
        spreadHip: def.spreadHip,
        spreadPerShot: def.spreadPerShot,
        spreadMax: def.spreadMax,
        spreadDecay: def.spreadDecay,
        // Does the cone grow at all at this rate of fire? Decay is per second,
        // gain is per shot; below break-even a held trigger never opens up.
        decayPerShot: +(def.spreadDecay / (def.rpm / 60)).toFixed(3),
        growsUnderFire: def.spreadPerShot > def.spreadDecay / (def.rpm / 60),
        lethality: table,
        coneAt20m: rest,
        sustainedSpread: sustained,
        patternClimbDeg: +((climb * 180) / Math.PI).toFixed(2),
        patternDriftDeg: +((maxDrift * 180) / Math.PI).toFixed(2),
        patternRightDeg: +((right * 180) / Math.PI).toFixed(2),
        patternLeftDeg: +((left * 180) / Math.PI).toFixed(2),
        patternLateralDeg: +(((right - left) * 180) / Math.PI).toFixed(2),
        patternPerShotClimbDeg: +((perShotClimb * 180) / Math.PI).toFixed(3),
        patternKillBurstLateralDeg: +((killBurstLateral * 180) / Math.PI).toFixed(3),
        patternCrossings: crossings,
        /** The declared shape, carried out so the gate can hold it to it. */
        signature: def.recoil.signature ?? null,
        patternLen: plen,
        patternHead: Array.from((st.pattern ?? []).slice(0, 4)).map((v) => +v.toFixed(6)),
      };
    }

    weapons.setWeapon('rifle');
    player.setControlEnabled(true);
    return {
      results,
      // Longest sightline the map affords, for calibrating maxRange.
      mapDiagonal: +Math.hypot(48, 36).toFixed(1),
      torsoHalfWidth: 0.2,
    };
  },
  { RANGES, MEASURE_AT, TTK_FPS, TTK_HOLD_S }
);

/* ---------------------------------------------------------------- verdict */

// A precondition that did not hold is not a measurement. Say which one.
if (out?.fatal) {
  console.log(`\nBALLISTICS FAILED — harness precondition: ${out.fatal}`);
  await browser.close();
  if (vite) {
    try {
      process.kill(-vite.pid);
    } catch {
      /* already gone */
    }
  }
  process.exit(1);
}

const fail = [];
const warn = [];
const R = out.results;

/**
 * Where each weapon's shots-to-kill steps, solved rather than sampled.
 *
 * The 5/15/25/35 grid above cannot show this and the whole balance argument
 * turns on it: the MPX-9's four-round band closes at 15.8 m, which the grid
 * straddles. See `tools/lethality.mjs`.
 */
for (const w of Object.values(R)) {
  w.torsoBands = stkBands(w).map((b) => ({ shots: b.shots, to: b.to === Infinity ? null : +b.to.toFixed(1) }));
  const oneTapHead = bandEdge(w, 1, { mult: 4 });
  w.headOneTapTo = oneTapHead === Infinity ? null : oneTapHead === null ? 0 : +oneTapHead.toFixed(1);
  w.fourRoundTo = bandEdge(w, 4);
}

for (const [id, w] of Object.entries(R)) {
  // 0. The cadence this tool's own TTKs are derived from has to be the cadence
  //    the code produces. Before `_advanceFireTimer` carried its overshoot, it
  //    was not, and every number in the summary was quietly wrong — see the long
  //    note at the measurement. A tool that scores the spec cannot notice that
  //    the spec is not what runs.
  if (w.measuredShots < 2) {
    fail.push(`${id}: fired ${w.measuredShots} round(s) in ${TTK_HOLD_S}s — the cadence was not measured`);
  } else {
    const err = (w.measuredRpm - w.reachableRpm) / w.reachableRpm;
    if (Math.abs(err) > RPM_TOL) {
      fail.push(
        `${id}: measured ${w.measuredRpm} rpm at ${TTK_FPS} fps against ${w.reachableRpm} reachable ` +
        `(${(err * 100).toFixed(1)} %) — every TTK below is derived from this, so the table is fiction`
      );
    }
  }

  // 1. The falloff curve has to be reachable on this map. Below ~0.35 of
  //    maxRange the parabola is flat enough that damage is constant, which
  //    deletes the range axis entirely.
  if (w.rangeUsedAt35m < 0.35) {
    fail.push(
      `${id}: at 35 m a round has travelled only ${(w.rangeUsedAt35m * 100) | 0}% of ` +
      `maxRange (${w.maxRange} m) — falloff is inert, ${w.label} does ` +
      `${w.lethality['5m'].dmg} at 5 m and ${w.lethality['35m'].dmg} at 35 m`
    );
  }

  // 2. The cone at the median engagement range has to be smaller than a torso,
  //    standing still, or the crosshair is a suggestion.
  // A measurement that produced no rounds is a FAILED measurement, not a pass.
  // The first version compared `null > 0.2`, which is false, so the SMG — whose
  // trace had been truncated to 30 m and never reached the 34 m wall — sailed
  // through the accuracy check having fired forty rounds into nothing.
  for (const [stance, m] of Object.entries(w.coneAt20m)) {
    if (m.n === 0) {
      fail.push(`${id}/${stance}: fired ${m.fired} rounds and recorded 0 impacts — nothing was measured`);
    } else if (m.n !== m.fired) {
      // One sample per round, or the percentile is over the wrong population.
      // Fewer means rounds flew past the wall into nothing; more would mean the
      // per-shot arming in `measure` has been undone and penetration exits are
      // being counted as muzzle scatter again.
      fail.push(`${id}/${stance}: ${m.fired} rounds produced ${m.n} samples — one shot is not one point`);
    }
  }
  const still = w.coneAt20m.standStill.r90;
  if (still !== null && still > out.torsoHalfWidth) {
    fail.push(
      `${id}: standing still, 90% of rounds land inside ${still} m at 20 m — ` +
      `a torso is ${out.torsoHalfWidth} m half-width, so the first shot is a coin flip`
    );
  }

  // 3. A spread model that cannot grow is not a spread model.
  if (!w.growsUnderFire) {
    fail.push(
      `${id}: spreadPerShot ${w.spreadPerShot} <= decay-per-shot ${w.decayPerShot} ` +
      `at ${w.rpm} rpm — holding the trigger never opens the cone`
    );
  }

  // 4. Roles. Not a hard fail: this is the thing M7 is for.
  const close = w.lethality['5m'];
  const far = w.lethality['35m'];
  if (close.torso === far.torso && id !== 'rifle') {
    warn.push(`${id}: ${close.torso} shots to kill at BOTH 5 m and 35 m — no range identity`);
  }

  // 4b. THE SPRAY IS THE SHAPE IT SAYS IT IS.
  //
  //     Four numbers make each pattern (`pitch`, `climbShape`, `drift`,
  //     `driftShape`/`driftBias`) and a fifth — the seed — decides which
  //     particular squiggle comes out of them. Nothing tied any of that to the
  //     prose beside it, and the prose was wrong: all three weapons passed a
  //     total-climb check while the M4A1 wandered sideways through its killing
  //     burst and the MPX-9, described as the gun you counter by sweeping
  //     across a body, swept 4.99 degrees left and 0.18 right.
  //
  //     `recoil.signature` in `defs.js` is that intent written as data. This is
  //     the half that makes it mean something.
  const sig = w.signature;
  if (!sig) {
    warn.push(`${id}: no recoil signature declared — its shape is unchecked`);
  } else {
    const band = (label, v, [lo, hi]) => {
      if (v < lo || v > hi) {
        fail.push(`${id}: ${label} ${v}° is outside the declared ${lo}–${hi}°`);
      }
    };
    band('pattern climb', w.patternClimbDeg, sig.climbDeg);
    band('lateral travel', w.patternLateralDeg, sig.lateralDeg);
    if (sig.perShotClimbDeg) {
      band('worst per-shot climb', w.patternPerShotClimbDeg, sig.perShotClimbDeg);
    }
    // The first four rounds are the ones that kill at every range this map
    // contains, so a weapon that declares a straight opening has to deliver one
    // there specifically — a magazine-wide average would hide it completely.
    if (sig.killBurstLateralDeg !== null && sig.killBurstLateralDeg !== undefined &&
        w.patternKillBurstLateralDeg > sig.killBurstLateralDeg) {
      fail.push(
        `${id}: the killing burst wanders ${w.patternKillBurstLateralDeg}° sideways, ` +
        `over the declared ${sig.killBurstLateralDeg}° — the first four rounds are not a straight line`
      );
    }
    const R = w.patternRightDeg;
    const L = -w.patternLeftDeg;
    if (sig.lean === 'right' && R <= L) {
      fail.push(`${id}: declares a right-hand hook and travels ${L}° left against ${R}° right`);
    } else if (sig.lean === 'left' && L <= R) {
      fail.push(`${id}: declares a left-hand hook and travels ${R}° right against ${L}° left`);
    } else if (sig.lean === 'both') {
      // A snake has to actually change sides, and do it evenly. One-sided
      // "wander" is a hook with extra steps, and it is what this weapon was.
      const bal = Math.min(R, L) / Math.max(R, L, 1e-9);
      if (bal < 0.7 || w.patternCrossings < 2) {
        fail.push(
          `${id}: declares a two-way snake but travels ${R}° right / ${L}° left ` +
          `(balance ${bal.toFixed(2)}, needs 0.70) and crosses centre ${w.patternCrossings}× (needs 2)`
        );
      }
    }
  }

  // 5. The band that is the reason to carry the gun has to reach the distance
  //    people fight at. This is the MPX-9 lesson stated as a check: at 27 damage
  //    its four-round band closed at 11.5 m against a median engagement of 13,
  //    so the fastest kill in the game was unavailable in most of the fights it
  //    was tuned for — a close-range specialist on paper and a trap pick in
  //    play. A grid of four ranges cannot see this; the solved edge can.
  if (id !== 'pistol' && Number.isFinite(w.fourRoundTo) && w.fourRoundTo < MEDIAN_ENGAGEMENT) {
    warn.push(
      `${id}: four-round band closes at ${w.fourRoundTo.toFixed(1)} m, inside the ` +
      `${MEDIAN_ENGAGEMENT} m median engagement — the top line is unreachable in most fights`
    );
  }
}

// 5. Two weapons that kill in the same number of shots at the same range with
//    the same fire rate are the same weapon.
const ttk5 = Object.entries(R).map(([id, w]) => [id, w.lethality['5m'].ttkMs]);
if (ttk5[0][1] === ttk5[1][1]) {
  warn.push(`${ttk5[0][0]} and ${ttk5[1][0]} have identical close TTK (${ttk5[0][1]} ms)`);
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

console.log(JSON.stringify(out, null, 2));
console.log('\n─── summary ' + '─'.repeat(58));
for (const [, w] of Object.entries(R)) {
  const l = w.lethality;
  console.log(
    `${w.label.padEnd(7)} ${String(w.measuredRpm).padStart(4)} rpm measured (print ${w.rpm}) · ` +
    `STK ${l['5m'].torso}/${l['15m'].torso}/${l['25m'].torso}/${l['35m'].torso} ` +
    `(5/15/25/35 m) · TTK ${String(l['5m'].ttkMs).padStart(3)} ms · ` +
    `cone@20m still ${w.coneAt20m.standStill.r90} m · ` +
    `climb ${w.patternClimbDeg}°`
  );
  // The solved ladder, which is what a balance argument is actually about.
  console.log(
    `${' '.repeat(8)}bands ${formatBands(stkBands(w))}` +
    ` · head 1-tap ${w.headOneTapTo === null ? 'everywhere' : `to ${w.headOneTapTo} m`}`
  );
  // The spray, as a shape rather than as one number.
  console.log(
    `${' '.repeat(8)}spray climb ${w.patternClimbDeg}° (worst shot ${w.patternPerShotClimbDeg}°) · ` +
    `lateral ${w.patternLateralDeg}° [R ${w.patternRightDeg} / L ${w.patternLeftDeg}, ${w.patternCrossings}× centre] · ` +
    `kill burst ${w.patternKillBurstLateralDeg}° off line`
  );
}
console.log(`\nmedian engagement taken as ${MEDIAN_ENGAGEMENT} m (tools/botfight.mjs)`);
console.log(
  fail.length === 0
    ? `\nBALLISTICS OK${warn.length ? ` (${warn.length} warning)\n  ${warn.join('\n  ')}` : ''}`
    : `\nBALLISTICS FAILED (${fail.length}):\n  ${fail.join('\n  ')}` +
      (warn.length ? `\n\nwarnings:\n  ${warn.join('\n  ')}` : '')
);

await browser.close();
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}
process.exit(fail.length === 0 ? 0 : 1);
