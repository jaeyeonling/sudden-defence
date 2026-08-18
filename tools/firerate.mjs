import { parseArgs, ensureServer, killServer, launchChromium, waitForReady, bootUrl } from './harness.mjs';
/**
 * Does the rate of fire depend on the frame rate?
 *
 * It should not. RPM is a balance number — `tools/ballistics.mjs` derives every
 * time-to-kill in the game from it — and a balance number that moves with the
 * machine drawing the frames is not a balance number.
 *
 * WHY NOTHING CAUGHT THIS
 *
 * `ballistics.mjs` computes `ttkMs` from `def.rpm`, the value in the table, and
 * drives the gun with `weapons.update(60 / def.rpm)` — a dt chosen to be exactly
 * one shot interval. Under that dt the cadence is trivially perfect. The tool
 * scores the SPEC and never asks whether the running code reproduces it, which
 * is the same shape as the MPX-9 round: correct arithmetic about a number the
 * system does not actually operate at.
 *
 * WHAT THE DEFECT IS
 *
 * `_fireTimer` is set to `60 / rpm` and decremented by the RENDERED FRAME's dt,
 * and the shot leaves on the frame the timer crosses zero. So the interval is
 * quantised UP to a whole number of frames, and the loss is whatever is left
 * over — which depends on the frame rate, not monotonically:
 *
 *     950 rpm wants 63.2 ms
 *       60 fps -> ceil(63.2 / 16.67) = 4 frames = 66.7 ms -> 900 rpm
 *      120 fps -> ceil(63.2 /  8.33) = 8 frames = 66.7 ms -> 900 rpm
 *      144 fps -> ceil(63.2 /  6.94) = 10 frames = 69.4 ms -> 864 rpm
 *
 * A player on a 144 Hz monitor gets a SLOWER gun than one at 60. There is no
 * frame rate at which the printed number is what you get.
 *
 * Usage:
 *   node tools/firerate.mjs                 # gate at the default tolerance
 *   node tools/firerate.mjs --tol=0.02      # tighten
 */


const args = parseArgs();
const PORT = Number(args.port ?? 5173);

/**
 * The frame rates to hold the trigger at. Deliberately not all multiples of the
 * 120 Hz fixed step: 100 and 144 are the awkward ones, where a tick boundary and
 * a frame boundary never line up, and an implementation that only samples on
 * frames shows its worst error there.
 */
const RATES = [30, 60, 100, 120, 144];
/** Seconds of held trigger per measurement. Long enough that one round of
 *  rounding is a small share of the count. */
const HOLD_S = 3;
/** Allowed deviation from the printed RPM. */
const TOL = Number(args.tol ?? 0.03);

const vite = await ensureServer(PORT, { name: 'FIRERATE' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(bootUrl(PORT), { waitUntil: 'load' });
await waitForReady(page, { name: 'FIRERATE' });

const out = await page.evaluate(
  async ({ RATES, HOLD_S }) => {
    const e = window.__ENGINE__;
    const weapons = e.ctx.get('weapons');
    const match = e.ctx.peek('match');
    const player = e.ctx.peek('player');

    match?.stopMatch?.();

    // Control stays ENABLED, and this is the whole precondition.
    //
    // `weapons.update` only reads the trigger when `live`, and `live` folds in
    // `player.canFire`, which is `controlEnabled && !frozen && !dead`. Copying
    // `setControlEnabled(false)` from `ballistics.mjs` — where it exists to
    // freeze the camera so the cone is pure spread — switches the branch under
    // test off, and the tool then reports 0 rpm at every frame rate. Which it
    // did, and it reads exactly like a catastrophic finding.
    player?.setControlEnabled?.(true);
    if (player) {
      player.frozen = false;
      player.dead = false;
    }

    // Hold the trigger the way the device would. `input.fire` reads `down`, so
    // this drives the exact path a real player drives — no debug mode, which
    // takes a different branch in `update` and would measure the harness.
    e.input.enabled = true;
    e.input.frozen = false;
    e.input.down.add('Mouse0');

    // ...and then hand it to the trigger the way the ENGINE does.
    //
    // The trigger moved to `weapons.fixedUpdate` and reads `commands.current`,
    // never the device (hard rule 7: a fixed step is not a frame, so a
    // frame-scoped `pressed` set is not a valid edge there). This loop drives
    // `weapons` directly and never yields, so the engine's own rAF cannot run
    // and cannot build a command — the harness has to build them, with the same
    // public calls the engine makes.
    const cs = e.ctx.commands;
    if (!cs?.build) return { fatal: 'no command stream; the trigger has nothing to read' };
    const BTN = cs.BTN;

    if (player && player.canFire !== true) {
      return { fatal: `player.canFire is ${player.canFire}; the trigger branch is off` };
    }

    // Count at the source. `weapon:fire` is emitted from `lateUpdate` out of a
    // queue, so counting events would measure the drain, not the trigger.
    let shots = 0;
    let stepIdx = 0;
    let firstAt = -1;
    let lastAt = -1;
    const origTry = weapons.tryFire.bind(weapons);
    weapons.tryFire = () => {
      const ok = origTry();
      if (ok) {
        shots++;
        if (firstAt < 0) firstAt = stepIdx;
        lastAt = stepIdx;
      }
      return ok;
    };

    let seq = (cs.seq | 0) + 1;
    /**
     * One tick of the weapon subsystem, command and all.
     *
     * `held`/`edge` are handed in per tick rather than sampled, because the
     * device sample only happens inside an engine frame and there are none here.
     * `endTick` matters: it closes the command so nothing can back-patch it,
     * which is the property that makes a replay mean anything.
     */
    const tick = (h, held, edge) => {
      cs.override = { moveX: 0, moveY: 0, held, edge };
      cs.build(seq++, h);
      weapons.fixedUpdate(h, e.ctx);
      cs.endTick();
    };

    /**
     * One frame of the weapon subsystem, both hooks.
     *
     * `lateUpdate` is not optional here. The weapon SWITCH completes on a clip
     * event from the viewmodel, and the viewmodel is driven from `lateUpdate` —
     * so a pump that calls only `update` leaves `activeId` on the rifle forever.
     */
    const step = (dt) => {
      weapons.update(dt, e.ctx);
      weapons.lateUpdate?.(dt, e.ctx);
    };

    const rows = [];
    for (const id of ['rifle', 'smg', 'pistol']) {
      // Trigger off across the swap: rounds fired mid-holster belong to neither
      // weapon's measurement.
      e.input.down.delete('Mouse0');
      cs.override = { moveX: 0, moveY: 0, held: 0, edge: 0 };
      weapons.setWeapon(id);
      // Switching takes time and BLOCKS the trigger, so run it out and then
      // assert it landed. Timing the swap out by eye is how the first version
      // measured the rifle three times and printed "nominal 800" for a 950 rpm
      // SMG without anything looking wrong.
      for (let i = 0; i < 600 && weapons.activeId !== id; i++) step(1 / 120);
      for (let i = 0; i < 300 && (weapons.switching || weapons.reloading); i++) step(1 / 120);
      e.input.down.add('Mouse0');
      if (weapons.activeId !== id) {
        return { fatal: `setWeapon('${id}') never took; active is '${weapons.activeId}'` };
      }
      const def = weapons.state.def;
      if (def.fireMode !== 'auto' && def.modes?.includes?.('auto')) weapons.setFireMode?.('auto');

      for (const fps of RATES) {
        const dt = 1 / fps;
        // Full magazine every run, refilled as it drains: this measures the
        // TRIGGER, and a reload partway through would measure the reload.
        const s = weapons.state;
        // Semi-automatics take a fresh press per round, so for them RPM is a
        // CAP on how fast clicking can be honoured, not a cadence. Held down,
        // a semi fires exactly once and the tool reports 0 rpm — which is the
        // gun working correctly and the harness asking the wrong question.
        // Clicking every frame asks the right one: does the cap hold, and does
        // it hold at the same value on every machine?
        const semi = s.mode !== 'auto' && s.mode !== 'burst';
        // Every rate starts from the SAME gun state.
        //
        // Without this the runs inherit whatever phase the previous one left the
        // shot clock in: 360 ticks over a 7.579-tick interval is 47.5 rounds, so
        // the count alternated 48/47 down the list and the measured rate read
        // 951/949/951/949/951. That tracks the ORDER of the runs, not their
        // frame rate — and it showed up as a 0.14-degree cone difference that
        // looked exactly like a frame-rate dependence in the spread model.
        weapons._fireTimer = 0;
        weapons._shotIndex = 0;
        weapons._sinceShot = 10;
        weapons._spread = weapons._restSpread(def, weapons.player, weapons._state);

        shots = 0;
        firstAt = -1;
        lastAt = -1;
        // The frame rate is now a property of the CAMERA and nothing else, and
        // this loop says so: the ticks are always 1/120 and `fps` only decides
        // how many rendered frames are interleaved between them. That is the
        // claim under test — a gun whose cadence still moved with `fps` would
        // have to be reading something frame-scoped, which is the defect.
        //
        // A semi takes a fresh press per round, and a press is a one-tick pulse
        // on the command, so it is issued as an EDGE on every tick. Held down,
        // a semi fires exactly once, which is the gun working correctly and the
        // harness asking the wrong question.
        const H = 1 / 120;
        let frameAcc = 0;
        let ticks = 0;
        for (let i = 0; i < Math.round(HOLD_S * 120); i++) {
          stepIdx = i;
          s.mag = def.magSize;
          s.chambered = true;
          tick(H, BTN.fire, semi ? BTN.fire : 0);
          ticks++;
          frameAcc += H;
          while (frameAcc >= dt) {
            step(dt);
            frameAcc -= dt;
          }
        }
        void ticks;
        rows.push({
          id,
          fps,
          mode: s.mode,
          nominal: def.rpm,
          // Rate BETWEEN shots, not shots per wall-clock second.
          //
          // The gun is ready when the trigger is pulled, so the first round
          // leaves immediately and belongs to no interval. Counting it against
          // the elapsed time adds one whole shot to the average, which at 30 fps
          // over three seconds reads as +20 rpm and looks exactly like a defect.
          // `(n - 1)` intervals over `last - first` is what "rate of fire" means.
          // `stepIdx` counts TICKS now, so the interval is in units of 1/120 s
          // and not of the frame. Leaving `dt` here after the loop moved to the
          // tick would have scaled every rate by fps/120 — the rifle would have
          // read 400 rpm at 30 fps and 960 at 144, which looks exactly like the
          // defect this file was written to catch.
          measured:
            shots > 1 ? Math.round(((shots - 1) / ((lastAt - firstAt) * (1 / 120))) * 60) : 0,
          shots,
          // The printed rate is reachable for every weapon now. A semi is capped
          // by how often a PRESS can be delivered, and a press is a one-tick
          // pulse on the command, so the ceiling is 120/s = 7200 rpm rather than
          // the frame rate. In play the edge is OR-accumulated from frames into
          // the tick, so even a 30 fps player clears 1800 rpm.
          reachable: def.rpm,
          /**
           * The CONE after the same held burst, which is the other half of
           * "does the frame rate change this gun".
           *
           * Spread gains per shot and decays per second, and the decay used to
           * run on the rendered frame while the gain ran on the shot — so a
           * player at 144 fps recovered accuracy 2.4x faster between rounds
           * than one at 60, for the same trigger. Nothing measured it, because
           * `ballistics.mjs` drives decay with `weapons.update(60 / def.rpm)`,
           * a dt chosen to be exactly one shot interval: the same shape of
           * blind spot that hid the rate of fire for two years.
           *
           * It rides on the tick now, so this should be identical across rates
           * rather than merely close.
           */
          spread: +weapons.spreadDegrees.toFixed(6),
        });
      }
    }

    e.input.down.delete('Mouse0');
    weapons.tryFire = origTry;
    return rows;
  },
  { RATES, HOLD_S }
);

await browser.close();
killServer(vite);

/* ------------------------------------------------------------------ report */

// A precondition that did not hold is not a measurement of zero. Say which one.
if (out?.fatal) {
  console.log(`\nFIRERATE FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}

const fail = [];
const byWeapon = new Map();
for (const r of out) {
  if (!byWeapon.has(r.id)) byWeapon.set(r.id, []);
  byWeapon.get(r.id).push(r);
}

for (const [id, rows] of byWeapon) {
  const parts = rows.map((r) => {
    const err = (r.measured - r.reachable) / r.reachable;
    if (Math.abs(err) > TOL) {
      fail.push(
        `${id} at ${r.fps} fps: ${r.measured} rpm vs ${r.reachable} reachable ` +
          `(${(err * 100).toFixed(1)} %, over ${(TOL * 100).toFixed(0)} %)`
      );
    }
    return `${r.fps}:${r.measured}`;
  });
  const rpms = rows.map((r) => r.measured);
  const spread = Math.max(...rpms) - Math.min(...rpms);
  // The spread ACROSS frame rates is the fairness question, separate from
  // whether any single rate matches the table. A gun that is uniformly 5 % slow
  // is a balance bug; one that changes with the monitor is an unfair one.
  if (spread / rows[0].nominal > TOL) {
    fail.push(`${id}: ${spread} rpm spread across ${rows.length} frame rates`);
  }
  // The cone, gated as an EXACT invariant rather than a tolerance. Once the
  // decay left the rendered frame the arithmetic is the same on every machine,
  // so anything but equality means something frame-scoped crept back in — and a
  // tolerance sized to "what a player would notice" would wave it through, the
  // way `tools/aim.mjs` found a 1e-4 ceiling waving through a 5e-5 defect.
  const cones = rows.map((r) => r.spread);
  const coneSpread = Math.max(...cones) - Math.min(...cones);
  if (coneSpread > 1e-9) {
    fail.push(
      `${id}: spread cone depends on the frame rate — ` +
      rows.map((r) => `${r.fps}:${r.spread}`).join(' ') +
      ` (${coneSpread.toExponential(2)} deg apart)`
    );
  }
  console.log(
    `  ${id.padEnd(7)} nominal ${rows[0].nominal} · measured ${parts.join(' ')} · ` +
    `cone ${cones[0]}° at every rate`
  );
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
// A run that fired nothing is a failed measurement, not a pass.
if (!out.length || out.some((r) => r.shots === 0)) {
  fail.push('a measurement produced zero rounds — nothing was measured');
}

if (fail.length) {
  console.log(`\nFIRERATE FAILED\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nFIRERATE OK — rate of fire within ${(TOL * 100).toFixed(0)}% of print at every frame rate`);
