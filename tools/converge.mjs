#!/usr/bin/env node
/**
 * TWO SURVIVORS, NO LINE OF SIGHT — how long until they find each other?
 *
 * This is the one behaviour that decides whether a round ends by elimination or
 * by the clock, and until now the only instrument for it was `tools/botfight.mjs`
 * — a 5-a-side fight that takes 60-100 s, produces a different scenario every
 * run, and answers the convergence question only as a side effect of answering
 * five others. Tuning against it went badly in a specific and repeatable way:
 * a change would look like an improvement over six runs, then look like a
 * regression over the next six, and both readings were mostly machine load
 * (three botfights in parallel run the sim slower, which changes every timing in
 * it). Three separate conclusions were drawn that way and all three were noise.
 *
 * So: stage it. Two bots, one per side, placed at fixed points with no line of
 * sight between them, nothing else alive, the clock started. The only thing
 * being measured is the time from "neither can see the other" to "one of them
 * has a target". Ten seconds per trial instead of ninety, the same scenario
 * every run, and a number that moves only when the AI moves.
 *
 * The pairs are chosen to span the three routes and the two failure shapes the
 * FSM has actually produced: a stale-contact endgame (`lastKnownAge` finite and
 * old, which is what ALERT hands to PATROL) and a never-saw-anybody round
 * (`lastKnownAge` Infinity, which is what a reset hands to everyone).
 *
 *   node tools/converge.mjs
 *   node tools/converge.mjs --budget=45 --trials=3
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
/** Override for every pair's own budget. Unset uses the per-pair value below. */
const BUDGET = args.budget ? Number(args.budget) : null;
/** Repeats per pair — the AI forks its own rng, so runs are not identical. */
const TRIALS = Number(args.trials ?? 2);
/**
 * Substring filter on the pair name.
 *
 * The failures worth chasing are in the tail, and the tail is expensive: one
 * `cold-lane` trial is 90 s while the other four together are under 20 s, so
 * running the whole table to sample the one pair that is flaky spends most of
 * the wall clock on pairs that were never going to fail.
 */
const ONLY = args.pair ? String(args.pair) : null;

/**
 * Where the two are put, and what they remember.
 *
 * `stale` seeds `lastKnownAge` with a finite old value, which is the state a bot
 * is in when it has just lost a firefight — the endgame case. `null` leaves it
 * Infinity, which is what a round reset produces and which the hunt deliberately
 * does NOT arm on straight away (see `agent.js`, the `dry` condition), so those
 * pairs are expected to take longer and are budgeted for it.
 *
 * Coordinates are (x, z) on a 48 x 36 hall with alpha at -Z. Each pair is a
 * shape that has actually turned up in a botfight dump.
 */
const PAIRS = [
  { name: 'lane-vs-lane', a: [-19, -12], b: [19, 12], stale: 12, budget: 40 },
  { name: 'opposite-mouths', a: [-6, -8], b: [7, 9], stale: 12, budget: 40 },
  { name: 'across-mid', a: [1.4, 2.6], b: [10, 11.8], stale: 12, budget: 40 },
  // The cold pairs get 140 s, and the number comes from the distribution rather
  // than from the mean.
  //
  // A bot that has never seen anyone does not hunt until `aliveTime > 30`. That
  // delay is deliberate — see `agent.js`; arming the hunt at the opening bell
  // turned the round into two teams sprinting at each other across open floor —
  // so a cold pair cannot converge before 30 s however good the AI is, and the
  // 40 s the other pairs use was measuring the design's own delay and calling it
  // a stalemate.
  //
  // Measured on `cold-lane`, opposite corners of the hall: 34.6, 41.6, 42.4,
  // 43.2, 45.8, 47.2 s. 90 s is twice the worst of those.
  //
  // It was briefly set to 140 on the theory that the occasional failure was
  // slowness. It is not: a 140 s run failed with the two still 19.1 m apart and
  // the presser `moving` the whole way, which is the same stall shape at three
  // times the budget. Raising a limit past the point where it can distinguish
  // "slow" from "stuck" does not buy reliability, it buys a gate that no longer
  // reports anything — so this is back to a number the measurements support, and
  // the residual stall is left visible.
  //
  // `cold-mid` converges in 1.6 s and shares the budget only for symmetry; it is
  // the pair that would catch a regression in the cold path quickly.
  { name: 'cold-lane', a: [-19, -12], b: [19, 12], stale: null, budget: 90 },
  { name: 'cold-mid', a: [1.4, 2.6], b: [10, 11.8], stale: null, budget: 90 },
];

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
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

// One-time setup: stop the round loop, take the player off the board, and park
// every bot but the two under test. Done once rather than per trial so a trial
// costs only its own clock.
const setup = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const match = e.ctx.get('match');
  const ai = e.ctx.get('ai');
  const player = e.ctx.get('player');
  match.stopMatch();
  player.setControlEnabled(false);
  // Roof, at z = 0: `unregister` leaves the character capsule in physics, and a
  // capsule on the floor is an obstacle. See the note in `tools/matchsim.mjs`.
  player.teleport({ x: 18, y: 7.9, z: 0 }, 0);
  match.unregister(player);

  // Everyone but the two subjects comes OFF THE MATCH, once.
  //
  // Hiding a bot's mesh and parking it on the roof does not remove it from
  // `match.enemiesOf`, and the hunt goes to the NEAREST enemy — so from alpha's
  // corner at (-19, -12) the spare bots parked around x = 20, z = 0 were 40 m
  // away while the actual subject at (19, 12) was 45 m. The presser spent the
  // trial walking to a point under the roof, `moving` and `hunting` the whole
  // time, converging on nobody.
  //
  // That is the "rare cold-lane stall" this harness was reporting, and it was
  // the harness. It also means every trace taken before this had a third body
  // in it. Unregistering here, once, keeps them out of `enemiesOf` for good —
  // per-trial `reset()` is only ever called on the two that remain.
  const alpha = ai.agents.find((a) => a.team === 'alpha');
  const bravo = ai.agents.find((a) => a.team === 'bravo');
  if (!alpha || !bravo) return { ok: false, why: 'need one bot per side' };
  let parked = 0;
  for (const a of ai.agents) {
    if (a === alpha || a === bravo) continue;
    a.reset({ x: 20 + (a.id % 3), y: 7.4, z: 0 }, 0);
    if (a.group) a.group.visible = false;
    match.unregister(a);
    parked++;
  }
  window.__SUBJECTS__ = { alpha, bravo };
  return { ok: true, parked, roster: match.combatants.length };
});
if (!setup.ok) {
  console.error(`setup failed: ${setup.why}`);
  await browser.close();
  if (vite) process.kill(-vite.pid);
  process.exit(2);
}

const rows = [];
for (const pair of PAIRS) {
  if (ONLY && !pair.name.includes(ONLY)) continue;
  for (let t = 0; t < TRIALS; t++) {
    const r = await page.evaluate(
      ({ pair, BUDGET }) => new Promise((done) => {
        const e = window.__ENGINE__;
        const ai = e.ctx.get('ai');
        const ph = e.ctx.get('physics');

        // The two subjects were chosen and everyone else was unregistered in
        // the one-time setup — see there for why that cannot be done per trial.
        const { alpha, bravo } = window.__SUBJECTS__;

        // `reset`, not an assignment to `position`: the physics character
        // controller drives the mesh, and writing the field moves the logical
        // bot while the body stays where it was.
        alpha.reset({ x: pair.a[0], y: 0.1, z: pair.a[1] }, 0);
        bravo.reset({ x: pair.b[0], y: 0.1, z: pair.b[1] }, Math.PI);
        for (const a of [alpha, bravo]) {
          // BOTH clocks. `lastKnownAge` is what the FSM reads for "where do I go
          // look"; `lastSeenAge` is the sight-only clock the hunt arms on, and
          // seeding only the first would leave every `stale` pair at
          // `lastSeenAge = Infinity` — indistinguishable from a cold pair, which
          // is the other half of this table.
          a.lastKnownAge = pair.stale === null ? Infinity : pair.stale;
          a.lastSeenAge = pair.stale === null ? Infinity : pair.stale;
          a.aliveTime = 0;
          a.hunting = false;
        }

        const t0 = e.time.elapsed;
        // The trial is only valid if it STARTS blind. A pair that can already
        // see each other measures the reaction delay, not the search.
        const startLos = ph.lineOfSight(
          { x: pair.a[0], y: 1.66, z: pair.a[1] },
          { x: pair.b[0], y: 1.66, z: pair.b[1] },
          ph.MASK.SIGHT
        );

        // A once-per-second trace, kept only when the trial fails.
        //
        // The end state of a stalemate says what the two are doing and not how
        // they got there, and those are different questions: "29.8 m apart,
        // presser not moving" is consistent with never having set off, with
        // having closed and then wandered back, and with oscillating around a
        // wall. Guessing between them cost two rounds of speculative edits.
        const trace = [];
        let nextSample = 0;
        let frames = 0;

        const tick = () => {
          const el = e.time.elapsed - t0;
          frames++;
          if (el >= nextSample) {
            nextSample = el + 1;
            trace.push({
              t: +el.toFixed(1),
              gap: +Math.hypot(
                alpha.position.x - bravo.position.x,
                alpha.position.z - bravo.position.z
              ).toFixed(1),
              ax: +alpha.position.x.toFixed(1), az: +alpha.position.z.toFixed(1),
              bx: +bravo.position.x.toFixed(1), bz: +bravo.position.z.toFixed(1),
              a: `${alpha.state[0]}${alpha.hunting ? 'H' : '-'}${alpha.hasMoveTarget ? 'M' : '-'}` +
                `${alpha.pathPending ? 'P' : '-'}${alpha.speed.toFixed(1)}`,
              b: `${bravo.state[0]}${bravo.hunting ? 'H' : '-'}${bravo.hasMoveTarget ? 'M' : '-'}` +
                `${bravo.pathPending ? 'P' : '-'}${bravo.speed.toFixed(1)}`,
            });
          }
          const found = alpha.hasTarget || bravo.hasTarget;
          if (found || el > BUDGET) {
            done({
              startLos,
              seconds: found ? +el.toFixed(1) : null,
              // How many AI ticks the simulated second actually bought.
              //
              // Everything here is measured in ENGINE seconds, and a bot's
              // decisions are per frame — so a machine running at 12 fps gives
              // its bots a third of the thinking per simulated second that one
              // at 40 fps does. They path less often, re-aim less often and
              // converge later, in engine time, with no code change involved.
              // Without this number a loaded machine is indistinguishable from
              // an AI regression, and that confusion has already cost this
              // project two wrong conclusions.
              fps: +(frames / Math.max(0.001, el)).toFixed(1),
              trace: found ? null : trace,
              gap: +Math.hypot(
                alpha.position.x - bravo.position.x,
                alpha.position.z - bravo.position.z
              ).toFixed(1),
              states: [alpha, bravo].map((a) => ({
                team: a.team, state: a.state, hunting: !!a.hunting,
                moving: !!a.hasMoveTarget,
                lastSeen: Number.isFinite(a.lastKnownAge) ? +a.lastKnownAge.toFixed(1) : 'never',
              })),
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
      { pair, BUDGET: BUDGET ?? pair.budget }
    );
    rows.push({ pair: pair.name, stale: pair.stale ?? 'never', budget: BUDGET ?? pair.budget, ...r });
  }
}

/* ---------------------------------------------------------------- verdict */

/**
 * Frames per engine second below which this run has not measured anything.
 *
 * A bot's decisions are per frame and every number here is in ENGINE seconds, so
 * a run at 60 fps gives its bots half the thinking per simulated second that one
 * at 120 does. They path, re-aim and re-acquire half as often, and converge
 * later — with no code change involved.
 *
 * Unloaded this machine measures 105-140. 90 sits just under that band and well
 * clear of the 60 a contended one drops to, which is the split that matters: a
 * 60 fps run failed `lane-vs-lane` at 5.5 m while three unloaded runs of the same
 * pair passed inside 20 s. (The contention was not even this project's — another
 * repo's dev servers were running on the same machine.)
 *
 * It is a floor on measurement VALIDITY, not a performance target —
 * `tools/profile.mjs` owns that question — and it is checked against the run's
 * median rather than per trial, because a machine does not get slow for one pair.
 */
const MIN_FPS = Number(args.minFps ?? 90);

const fail = [];
const degraded = [];
/**
 * Was this run fast enough to mean anything?
 *
 * Decided once for the whole run and BEFORE any trial is judged. Deciding it per
 * trial would let a loaded machine turn each individual failure into a shrug
 * while the run as a whole still printed OK — the vacuous green this repo keeps
 * having to dig itself out of. Either the run measured the AI or it did not.
 */
const fpsAll = rows.map((r) => r.fps).filter((f) => typeof f === 'number').sort((a, b) => a - b);
const medianFps = fpsAll.length ? fpsAll[Math.floor(fpsAll.length / 2)] : 0;
const slow = medianFps < MIN_FPS;

for (const r of rows) {
  if (r.error) { fail.push(`${r.pair}: ${r.error}`); continue; }
  // A pair that could see each other at t=0 measured nothing.
  if (r.startLos) {
    fail.push(`${r.pair}: the two started in line of sight — this pair proves nothing about search`);
    continue;
  }
  if (r.seconds === null) {
    // A trial the machine could not run is not a trial the AI failed.
    //
    // `cold-lane` converges in 37.8-47.0 s across twelve consecutive standalone
    // runs and has never failed one. The two failures on record both happened
    // inside a long `npm test` chain, one of them with a 140 s budget and the
    // pair still 19.1 m apart — which looked like a stall and was a browser
    // getting a third of the frames. Reporting that as an AI defect sends the
    // next person to `agent.js` to look for something that is not there.
    if (slow) {
      degraded.push(`${r.pair} did not converge, but the run was not measurable`);
    } else {
      fail.push(
        `${r.pair} (lastSeen ${r.stale}s): no contact in ${r.budget}s at ${r.fps} fps, ` +
        `${r.gap} m apart — ` +
        r.states.map((s) =>
          `${s.team} ${s.state} hunting=${s.hunting} moving=${s.moving} lastSeen=${s.lastSeen}`).join(' · ')
      );
    }
  }
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

const found = rows.filter((r) => typeof r.seconds === 'number').map((r) => r.seconds).sort((a, b) => a - b);
const median = found.length ? found[Math.floor(found.length / 2)] : null;

console.log(JSON.stringify(rows, null, 2));
// A run that could not be measured is reported as exactly that, and it is an
// error — not a pass with a footnote. The caller needs to know the answer is
// missing, which is different from knowing the answer is good.
if (slow && degraded.length) {
  console.log(
    `\nCONVERGE UNMEASURED — median ${medianFps} fps, below the ${MIN_FPS} fps floor. ` +
    `${degraded.length}/${rows.length} trials did not converge and none of them can be ` +
    `attributed to the AI at this rate. Re-run on an idle machine.`
  );
  await browser.close();
  if (vite) process.kill(-vite.pid);
  process.exit(1);
}
console.log(
  fail.length === 0
    ? `\nCONVERGE OK — ${found.length}/${rows.length} trials made contact · ` +
      `median ${median}s, worst ${found[found.length - 1]}s · ${medianFps} fps`
    : `\nCONVERGE FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
