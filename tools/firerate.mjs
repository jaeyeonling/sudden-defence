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

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
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

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
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

    /**
     * One frame of the weapon subsystem, both hooks.
     *
     * `lateUpdate` is not optional here. The weapon SWITCH completes on a clip
     * event from the viewmodel, and the viewmodel is driven from `lateUpdate` —
     * so a pump that calls only `update` leaves `activeId` on the rifle forever,
     * which is what the first version of this did while cheerfully printing
     * "nominal 800" for a 950 rpm SMG.
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
        const steps = Math.round(HOLD_S * fps);
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
        shots = 0;
        firstAt = -1;
        lastAt = -1;
        for (let i = 0; i < steps; i++) {
          stepIdx = i;
          s.mag = def.magSize;
          s.chambered = true;
          // `firePressed` reads the edge set that `Input.beginFrame` fills, and
          // this harness drives `weapons` directly without an engine frame.
          e.input._pressed.clear();
          if (semi) e.input._pressed.add('Mouse0');
          step(dt);
          if (weapons.fixedUpdate) {
            // Feed the same wall-clock to the fixed step, in 120 Hz slices, so
            // both implementations see the identical amount of time.
            let acc = dt;
            while (acc >= 1 / 120) {
              weapons.fixedUpdate(1 / 120, e.ctx);
              acc -= 1 / 120;
            }
          }
        }
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
          measured:
            shots > 1 ? Math.round(((shots - 1) / ((lastAt - firstAt) * dt)) * 60) : 0,
          shots,
          // A semi cannot beat the frame rate no matter how fast the cap is —
          // one press per frame is one round per frame. Below that the printed
          // number is unreachable for a reason that is not a defect.
          reachable: semi ? Math.min(def.rpm, fps * 60) : def.rpm,
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
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}

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
  console.log(`  ${id.padEnd(7)} nominal ${rows[0].nominal} · measured ${parts.join(' ')}`);
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
