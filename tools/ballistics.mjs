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
  async ({ RANGES, MEASURE_AT }) => {
    const e = window.__ENGINE__;
    const match = e.ctx.get('match');
    const weapons = e.ctx.get('weapons');
    const player = e.ctx.get('player');
    const ph = e.ctx.get('physics');

    match.stopMatch();
    player.setControlEnabled(false); // camera frozen => the cone is pure spread

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

    const eye = e.ctx.camera.position.clone();

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
      const def = weapons.current;
      const st = weapons.states.get(id);
      /** Reloading also blocks the trigger; top the magazine up by hand. */
      refill = () => { st.mag = def.magSize; st.chambered = true; };
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
          // Time from the first round leaving the barrel to the killing one.
          ttkMs: Math.round(((stk(body) - 1) * 60000) / def.rpm),
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
        weapons.tryFire();
        sustained.push(+weapons.spreadDegrees.toFixed(3));
        // Advance the clock by exactly one shot interval so decay is real.
        weapons.update(60 / def.rpm, e.ctx);
      }

      // ---- recoil pattern --------------------------------------------------
      let climb = 0;
      let drift = 0;
      let maxDrift = 0;
      const plen = Math.min(def.recoil.patternLength, (st.pattern?.length ?? 0) >> 1);
      for (let i = 0; i < plen; i++) {
        climb += st.pattern[i * 2];
        drift += st.pattern[i * 2 + 1];
        maxDrift = Math.max(maxDrift, Math.abs(drift));
      }

      results[id] = {
        label: def.label,
        rpm: def.rpm,
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
  { RANGES, MEASURE_AT }
);

/* ---------------------------------------------------------------- verdict */

const fail = [];
const warn = [];
const R = out.results;

for (const [id, w] of Object.entries(R)) {
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
for (const [id, w] of Object.entries(R)) {
  const l = w.lethality;
  console.log(
    `${w.label.padEnd(7)} ${String(w.rpm).padStart(4)} rpm · ` +
    `STK ${l['5m'].torso}/${l['15m'].torso}/${l['25m'].torso}/${l['35m'].torso} ` +
    `(5/15/25/35 m) · TTK ${String(l['5m'].ttkMs).padStart(3)} ms · ` +
    `cone@20m still ${w.coneAt20m.standStill.r90} m · ` +
    `climb ${w.patternClimbDeg}°`
  );
}
console.log(
  fail.length === 0
    ? `\nBALLISTICS OK${warn.length ? ` (${warn.length} warning)\n  ${warn.join('\n  ')}` : ''}`
    : `\nBALLISTICS FAILED (${fail.length}):\n  ${fail.join('\n  ')}` +
      (warn.length ? `\n\nwarnings:\n  ${warn.join('\n  ')}` : '')
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
