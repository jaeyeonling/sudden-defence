#!/usr/bin/env node
/**
 * Does the rendered frame get a vote on where the round goes?
 *
 * It should not, for two separate reasons that happen to want the same fix.
 *
 * NETCODE. A shot has to be a function of the command stream and the tick it was
 * issued on, or it cannot be stamped, replayed or reconciled. `core/command.js`
 * put the INPUT on the tick; this asks the other half of the question, because
 * `weapons.tryFire()` read `ctx.camera.quaternion` and the camera is composed in
 * `player.update()` — after every fixed step of the frame. The recoil springs
 * were integrated with the frame dt, so the same magazine climbed differently at
 * 60 and 144 fps.
 *
 * FEEL. The composed camera also carries bob, breath sway and trauma shake, so
 * all three steered live rounds. Nobody decided that; it was true because the
 * camera was the only transform in the building. Measured at 20 m against a
 * 0.2 m torso half-width: breath 0.042 m, bob up to 0.087 m, trauma shake at
 * full amplitude 0.47 m — three and a half times the rifle's own cone, so an
 * explosion took more accuracy away than the spread model ever could.
 *
 * WHAT THIS ASSERTS
 *
 *   1. the aim after a fixed span of simulated time is the same at 30, 60, 100,
 *      120 and 144 fps
 *   2. bob, breath and trauma shake move the CAMERA and do not move the IMPACT
 *   3. the shot actually took the player aim path — not the camera fallback in
 *      `_syncAim`, not a leftover `_aimOverride`
 *
 * (2) carries its own validity guard, and it is the load-bearing part of this
 * file. "The impact did not move" is the same observation whether the channels
 * are correctly excluded or the harness simply failed to induce any shake, so
 * each case asserts that the CAMERA moved by a visible amount first. A null
 * result you have not proved you could have falsified is not a null result.
 *
 *   node tools/aim.mjs
 */
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
/** Frame rates to compose the camera at while the tick rate stays 120 Hz. */
const RATES = [30, 60, 100, 120, 144];
/**
 * Fixed steps of recoil decay per rate. 18 ticks at 120 Hz is 0.15 s.
 *
 * Counted in TICKS rather than seconds because the span has to be identical
 * across rates by construction. Driving it in seconds meant
 * `round(0.15 * 30)` = 5 frames = 0.167 s = 20 ticks against 120 fps getting
 * 18, and the harness then reported the extra simulated time as a defect.
 *
 * 18 rather than the 120 this shipped with, because 120 was a probe aimed past
 * its own target: the recoil spring is all but dead after a second, so every
 * frame rate converged on the same near-zero and the spread across them fell
 * under tolerance EVEN WITH the defect reinstated. Measured — stepping the
 * spring on the frame as well as the tick changed the settled value 34-fold
 * (1.38e-4 down to 4.0e-6 rad) while varying only 3.7e-7 BETWEEN rates.
 *
 * The frame-rate dependence lives in the decay, so it has to be read while the
 * spring still has something to decay. 0.15 s is inside the first oscillation,
 * and is roughly the window a player is countering recoil in anyway.
 */
const TICKS = 18;
/**
 * Allowed spread in the aim across those rates, radians.
 *
 * EXACT, near enough. Once the recoil springs left `update`, the rendered frame
 * stops participating in the aim entirely: every rate runs the same 18
 * `fixedUpdate` calls with the same `h`, so the result is not merely close, it
 * is the same arithmetic in the same order. 1e-12 is float dust.
 *
 * This was 1e-4 — "0.0057 degrees, below anything a hitbox can resolve" — which
 * is a sensible-sounding number and the wrong KIND of number. A ceiling set to
 * what a player could notice will pass anything a player would not, and the
 * defect it is here to catch is 5e-5 rad at this span: three per cent, invisible
 * in play, and a total loss of the property the tick rewrite exists to buy.
 * Reinstating the frame-side step slipped straight through 1e-4 and fails this
 * by seven orders of magnitude. Gate the invariant, not the symptom.
 */
const AIM_TOL = Number(args.tol ?? 1e-12);
/**
 * How far the camera has to move for a presentation case to count as induced,
 * radians.
 *
 * 2e-3 is 0.115 degrees. Derived from the smallest channel under test rather
 * than picked round: breath is 0.0021 rad of pitch and 0.0024 of yaw at full
 * amplitude, so driving it peak-to-trough moves the view 0.0064 rad — three
 * times this floor. Anything that cannot clear the floor was not induced, and
 * an uninduced channel that fails to move the impact has proved nothing.
 */
const INDUCE_MIN = 2e-3;
/** How far an impact may move and still be called unchanged, metres. */
const IMPACT_TOL = 1e-3;

const vite = await ensureServer(PORT, { name: 'AIM' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ RATES, TICKS, INDUCE_MIN }) => {
    const e = window.__ENGINE__;
    const player = e.ctx.get('player');
    const weapons = e.ctx.get('weapons');
    const match = e.ctx.peek('match');
    const rig = player.cameraRig;
    const m = player.movement;
    const H = 1 / 120;

    match?.stopMatch?.();

    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });

    // Same stance the ballistics harness uses: the alpha half facing +Z down the
    // long axis, with 34 m of bare floor and a wall behind every range.
    player.setControlEnabled(false);
    player.teleport({ x: 0, y: 0.03 + 1.66, z: -16 }, Math.PI);
    await frames(2);

    if (!player.aimForward) {
      return { fatal: 'player exposes no aimForward; the split is not wired' };
    }
    if (weapons._aimOverride) {
      return { fatal: 'weapons._aimOverride is set before anything fired' };
    }

    /* ---- 1. is the aim frame-rate independent? -------------------------- */
    //
    // The tick rate is 120 Hz in every case; what changes is how many times the
    // CAMERA is composed inside the same simulated second. Before the split,
    // `rig.update` stepped the recoil springs, so composing more often decayed
    // the recoil further and the settled aim moved with the display.
    const ONE_SHOT_PITCH = 0.0085 * 1.7; // an M4A1 first round, radians
    const ONE_SHOT_YAW = 0.0022;
    const climb = [];
    for (const fps of RATES) {
      rig.recoilPitch.reset();
      rig.recoilYaw.reset();
      rig.stepAim(0, m);
      rig.addRecoil(ONE_SHOT_PITCH, ONE_SHOT_YAW, 0, 0);
      // Driven by TICKS, with frames emitted inside them — not by frames with
      // ticks emitted inside. The frame-first version made the span itself
      // rate-dependent: `round(0.15 * 30)` is 5 frames, which is 0.167 s and 20
      // ticks against 120 fps's 18, so it compared different amounts of
      // simulated time and called the difference a defect. The span has to be
      // identical by construction or the comparison means nothing.
      const frameDt = 1 / fps;
      let frameAcc = 0;
      let frames = 0;
      for (let t = 0; t < TICKS; t++) {
        player.fixedUpdate(H, e.ctx);
        frameAcc += H;
        while (frameAcc >= frameDt) {
          player.update(frameDt, e.ctx);
          frameAcc -= frameDt;
          frames++;
        }
      }
      climb.push({ fps, ticks: TICKS, frames, pitch: rig.aimPitch, yaw: rig.aimYaw });
    }
    rig.recoilPitch.reset();
    rig.recoilYaw.reset();
    rig.stepAim(0, m);

    /* ---- 2. do the presentation channels steer a round? ----------------- */
    //
    // Fire with the cone forced shut so the only thing that can move an impact
    // is the aim itself, and take the FIRST entry impact per shot — a round that
    // punches a wall re-enters whatever is behind it, see `ballistics.mjs`.
    let armed = false;
    let hit = null;
    const off = e.events.on('bullet:impact', (p) => {
      if (p.exit || !armed) return;
      armed = false;
      hit = { x: p.point.x, y: p.point.y, z: p.point.z };
    });

    // The COMPOSED rotation, read off the rig rather than off `ctx.camera`.
    //
    // `player.update` only writes the camera when control is enabled, and this
    // harness disables it to hold the body still — so the engine camera is stale
    // here and comparing against it would report "the channel was never induced"
    // for every case, which is a harness fault wearing the costume of a finding.
    // `rig.rotation` is what `applyTo` would have written.
    const camAngles = () => ({ pitch: rig.rotation.x, yaw: rig.rotation.y });

    const shoot = () => {
      const st = weapons.states.get(weapons.activeId);
      st.mag = weapons.current.magSize;
      st.chambered = true;
      weapons._spread = 0;
      weapons._fireTimer = 0;
      // Recoil must not accumulate between the two halves of a comparison, or
      // the second shot differs for a reason that has nothing to do with the
      // channel under test.
      weapons._shotIndex = 0;
      rig.recoilPitch.reset();
      rig.recoilYaw.reset();
      rig.stepAim(0, m);
      armed = true;
      hit = null;
      const ok = weapons.tryFire();
      return ok ? hit : null;
    };

    // Breath is two detuned sines with no closed-form peak, and it is also the
    // SMALLEST channel here — so it has to be driven to its extremes on purpose.
    // Left to run free it wandered 0.0169 degrees between the two shots, which
    // the validity guard correctly refused to accept as an induced change.
    // Scanned rather than solved: twelve seconds at 10 ms covers both periods.
    let tPos = 0, tNeg = 0, vPos = -Infinity, vNeg = Infinity;
    for (let t = 0; t < 12; t += 0.01) {
      const bA = Math.sin(t * 2 * Math.PI * 0.235);
      const bB = Math.sin(t * 2 * Math.PI * 0.155 + 1.7);
      const v = bA * 0.7 + bB * 0.3;
      if (v > vPos) { vPos = v; tPos = t; }
      if (v < vNeg) { vNeg = v; tNeg = t; }
    }
    /** Put the breath channel at a chosen phase and recompose the camera. */
    const setBreath = (t) => {
      rig.breathPhase = t - 1 / 60;
      player.update(1 / 60, e.ctx);
    };

    const cases = [];
    // Every measurement below is taken at the SAME breath phase except the
    // breath case itself, so exactly one channel differs per comparison.
    setBreath(tNeg);
    const baseline = shoot();
    const baseCam = camAngles();

    // -- trauma shake: the biggest of the three, 1.35 deg at full amplitude ---
    rig.addTrauma(1);
    for (let f = 0; f < 3; f++) player.update(1 / 60, e.ctx);
    setBreath(tNeg);
    cases.push({ name: 'shake', cam: camAngles(), hit: shoot() });
    rig.trauma = 0;
    for (let f = 0; f < 3; f++) player.update(1 / 60, e.ctx);

    // -- breath sway: peak to trough, which is twice the one-sided amplitude --
    setBreath(tPos);
    cases.push({ name: 'breath', cam: camAngles(), hit: shoot() });
    setBreath(tNeg);

    // BOB IS NOT SEPARATELY INDUCED HERE, and saying so is cheaper than a case
    // that cannot fail. Its whole amplitude is 0.16 deg of pitch times a weight
    // capped at 1.55, so 0.25 deg at the extreme of a phase this harness cannot
    // set — `stepPhase` is an accumulator fed by real movement, and moving the
    // body would move the origin too, which is a legitimate reason for an impact
    // to shift and would make the result unreadable. A bob case would therefore
    // sit near the validity floor and pass by being too small to see.
    //
    // What covers it instead: bob enters the camera on the same composition line
    // as breath and shake (`camera.js`, "assemble rotation"), and the aim is
    // built in `stepAim` which does not mention it. The two cases above prove
    // that line does not reach a round.

    off();
    player.setControlEnabled(true);

    return {
      climb,
      baseline,
      baseCam,
      cases,
      // Which path did the last shot take? An assertion about the code under
      // test, not about its output: a run where `_syncAim` quietly fell through
      // to the camera would pass every check above for the wrong reason.
      aimSource: weapons._aimOverride
        ? 'override'
        : player.aimForward
          ? 'player'
          : 'camera',
      INDUCE_MIN,
    };
  },
  { RATES, TICKS, INDUCE_MIN }
);

await browser.close();
killServer(vite);

/* ------------------------------------------------------------------ report */

if (out?.fatal) {
  console.log(`\nAIM FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}

const fail = [];

/* 1. frame-rate independence */
const pitches = out.climb.map((c) => c.pitch);
const yaws = out.climb.map((c) => c.yaw);
const spreadP = Math.max(...pitches) - Math.min(...pitches);
const spreadY = Math.max(...yaws) - Math.min(...yaws);
console.log('  recoil settled after 18 ticks (0.15 s), camera composed at:');
for (const c of out.climb) {
  console.log(
    `    ${String(c.fps).padStart(3)} fps · ${String(c.frames).padStart(3)} frames in ${c.ticks} ticks · ` +
    `pitch ${c.pitch.toExponential(3)} · yaw ${c.yaw.toExponential(3)}`
  );
}
if (spreadP > AIM_TOL || spreadY > AIM_TOL) {
  fail.push(
    `aim depends on the frame rate: pitch spread ${spreadP.toExponential(2)} rad, ` +
    `yaw ${spreadY.toExponential(2)} (tolerance ${AIM_TOL.toExponential(0)}) across ` +
    `${RATES.join('/')} fps`
  );
}
// A run in which every rate took a different number of ticks is measuring the
// accumulator, not the aim.
const tickCounts = [...new Set(out.climb.map((c) => c.ticks))];
if (tickCounts.length > 1 && Math.max(...tickCounts) - Math.min(...tickCounts) > 1) {
  fail.push(`fixed-step counts differ by more than one across rates (${tickCounts.join(', ')}) — the span is not equal`);
}

/* 2. presentation channels */
if (!out.baseline) {
  fail.push('the baseline shot recorded no impact — nothing was measured');
} else {
  console.log('\n  presentation channels vs the impact point:');
  for (const c of out.cases) {
    const dCam = Math.hypot(c.cam.pitch - out.baseCam.pitch, c.cam.yaw - out.baseCam.yaw);
    if (!c.hit) {
      fail.push(`${c.name}: the shot recorded no impact — nothing was measured`);
      continue;
    }
    const dHit = Math.hypot(
      c.hit.x - out.baseline.x, c.hit.y - out.baseline.y, c.hit.z - out.baseline.z
    );
    console.log(
      `    ${c.name.padEnd(7)} camera moved ${(dCam * 180 / Math.PI).toFixed(3)}° · ` +
      `impact moved ${(dHit * 1000).toFixed(2)} mm`
    );
    // The validity guard first: if the channel was never induced, "the impact
    // did not move" is a statement about the harness.
    if (dCam < out.INDUCE_MIN) {
      fail.push(
        `${c.name}: the camera moved only ${(dCam * 180 / Math.PI).toFixed(4)}° — ` +
        `the channel was never induced, so an unchanged impact proves nothing`
      );
    } else if (dHit > IMPACT_TOL) {
      fail.push(
        `${c.name}: moved the impact ${(dHit * 1000).toFixed(1)} mm while moving the ` +
        `camera ${(dCam * 180 / Math.PI).toFixed(3)}° — a presentation channel is steering rounds`
      );
    }
  }
}

/* 3. which path the shot took */
if (out.aimSource !== 'player') {
  fail.push(`shots resolved their aim from '${out.aimSource}', not the player's tick-owned aim`);
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);

if (fail.length) {
  console.log(`\nAIM FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `\nAIM OK — aim within ${AIM_TOL.toExponential(0)} rad across ${RATES.length} frame rates · ` +
  `shake and breath move the camera and not the round ` +
  `(bob not separately induced — see the note in the harness)`
);
