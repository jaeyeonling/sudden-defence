#!/usr/bin/env node
/**
 * PERCEIVE — does the display refresh rate get a vote on what a bot sees?
 *
 * It should not, and the same argument that put the aim on the tick applies one
 * layer out. `aim.mjs` asks whether a ROUND is a function of the command stream
 * and the tick; this asks whether a bot's PERCEPTION is. Both are simulation:
 * §3.5 of the handoff states the rule as "anything that ends in an event `ai`
 * subscribes to is simulation, however cosmetic it looks locally", and what a
 * bot can see is upstream of every one of those events.
 *
 * THE SUSPECT
 *
 * `Combatant.position` is the INTERPOLATED draw pose, deliberately — hitboxes
 * have to agree with the thing on screen, and at 8 m/s one frame of lag is 13 cm
 * of "I shot exactly where he was". `syncHitboxes` documents that choice and it
 * is the right one for a hitbox.
 *
 * But `agent._sense` derives `c.head` from the same getter, in three places:
 * the range/cone pass, the line-of-sight ray, and `lastKnown.copy(seen.head)` —
 * the bot's memory of where you were. So the point a bot perceives is posed from
 * a value `movement.js` describes as "a function of `alpha`, which a replay does
 * not have". If that is load-bearing, a 144 Hz player is seen at a different
 * point than a 60 Hz one, from an identical simulation.
 *
 * WHY `replay.mjs` CANNOT ANSWER THIS
 *
 * It runs exactly one tick per `step`, so `alpha` takes the same value every
 * time and the interpolation reproduces. Layer 1 is BIT-IDENTICAL with
 * perception on the interpolated head AND on a fixed-step one — measured, not
 * assumed. A gate that cannot separate two implementations cannot price either.
 * This file varies the one thing that gate holds fixed.
 *
 * HOW THE SPAN IS MADE COMPARABLE
 *
 * Ticks first, frames emitted inside them — `aim.mjs` learned this the hard way,
 * and driving frames with ticks inside makes the SPAN itself rate-dependent.
 * Every rate runs the same number of 120 Hz fixed steps from the same restored
 * snapshot; what changes is how often a frame is composed inside them, which is
 * exactly what `alpha` is a function of.
 *
 * The player is driven with a CONSTANT command for the whole span. Not for
 * realism — because `commands.sample` happens on the frame, so a command that
 * varies with the frame index would feed different rates different input and the
 * comparison would measure the harness. A constant is the same on every tick at
 * every rate by construction.
 *
 * THE SNAPSHOT IS THE STARTING GUN
 *
 * Each rate has to begin from an identical world, and netcode step 5 already
 * built that: `captureState`/`restoreState` across six subsystems, proved by
 * `replay.mjs` to reproduce a tick exactly. This is its first use outside that
 * gate.
 *
 * VALIDITY GUARDS — three, and they are the load-bearing part
 *
 * "Perception did not move across rates" is the same observation whether the
 * value is genuinely rate-independent or the harness simply failed to stage the
 * question. So, before the comparison is allowed to mean anything:
 *
 *   1. the player MOVED (a stationary player has `renderPosition == position`,
 *      and the defect is invisible)
 *   2. the interpolated position ACTUALLY DIFFERED between rates (this is the
 *      input the suspect path reads — if it did not vary, nothing could have)
 *   3. at least one bot SAW the player during the span (perception that never
 *      fired proves nothing about perception)
 *
 * WHAT IT FOUND ON ITS FIRST RUNS, in falling order of effect size
 *
 *   28 fields, worst 12 m   perception on the INTERPOLATED head. Routing
 *                           `_sense` to a fixed-step head took 60, 100 and 144
 *                           fps to an exact match with the 120 fps control on
 *                           every common tick, and the end-state spread from
 *                           12 m to nine ten-thousandths of one.
 *   (harness defect)        debris is NOT in the snapshot and IS in `MASK.SIGHT`
 *                           — see the note at the `bodies.clear()` call. Left
 *                           uncleared, this gate was a function of the ORDER of
 *                           `RATES`, which is the kind of result that looks like
 *                           a finding until someone reorders the array.
 *   ~1 mm, still red        something else. 100 and 144 fps match the control;
 *                           30 and 60 do not. NOT LOD (`--nolod` changes
 *                           nothing) and NOT the A* ration (already per tick).
 *                           Remaining suspect: bot rigs are posed in
 *                           `ai.lateUpdate`, on the FRAME, and `MASK.BULLET`
 *                           contains ACTOR — so where a bot's round lands, and
 *                           therefore the `bullet:impact` a third bot hears, is
 *                           posed from an animation. NOT CONFIRMED. The induced
 *                           test for it has not been run.
 *
 * TWO HYPOTHESES DIED HERE, recorded because a dead hypothesis is only cheap if
 * nobody has to kill it twice:
 *
 *   LOD             `_updateRelevance` does run on the frame, and `--nolod`
 *                   changes nothing.
 *   footstep loss   `player:footstep` is emitted in `update`, so at 30 fps
 *                   three of every four steps are overwritten before they fire.
 *                   Draining it on the tick made the spread WORSE — 1 field to
 *                   54 — because more noise amplifies whatever the real cause
 *                   is. A fix that moves the control group is not a fix.
 *
 * THIS GATE IS RED ON PURPOSE AND IS NOT IN THE SUITE.
 *
 * `replay.mjs` was stood up red the same way (`0356129`) and joined the chain
 * only once it passed. A red gate inside the chain makes every run after it
 * ambiguous; a red gate outside it is a measurement waiting for a decision.
 *
 *   node tools/perceive.mjs [--port=5173] [--ticks=240] [--nolod] [--tol=N]
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
 * Frame rates to compose at while the tick rate stays 120 Hz.
 *
 * 120 is in the list as the CONTROL: one frame per tick is what `replay.mjs`
 * runs, so it is the rate the rest are measured against and the one where a
 * defect must NOT show. 144 is the interesting end — more frames than ticks
 * means `alpha` walks a different path every tick.
 */
const RATES = [30, 60, 100, 120, 144];
/**
 * Fixed steps per rate. 240 at 120 Hz is 2 s.
 *
 * Long enough that bots move, look around and re-acquire; short enough to stay
 * inside the command ring's 128... which it is not, and does not need to be:
 * this gate does not replay recorded commands, it re-runs a constant one.
 */
const TICKS = Number(args.ticks ?? 240);
/**
 * How far a perception field may vary across rates before it is a defect.
 *
 * EXACT. Every rate runs identical arithmetic in identical order on the fixed
 * step; the only thing that differs is how many times a frame was composed.
 * If perception is on the tick, the results are not close, they are the same
 * bits — the same argument `aim.mjs` makes for its 1e-12.
 *
 * A tolerance here would be a hole rather than a measurement choice: the defect
 * under test is a few centimetres at walking speed, which is exactly the size a
 * "surely nobody notices" ceiling waves through.
 */
const TOL = Number(args.tol ?? 1e-12);
/** How far the player must travel for guard 1 to pass, metres. */
const MOVED_MIN = 0.5;
/**
 * How far the interpolated position must differ BETWEEN rates for guard 2,
 * metres. One tick at walking speed is ~4 cm, so half a tick of lag is 2 cm;
 * 1 mm is comfortably below anything real and far above float dust.
 */
const LERP_MIN = 1e-3;

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
await page.waitForFunction("window.__READY__ === true", null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ RATES, TICKS, NOLOD }) => {
    const e = window.__ENGINE__;
    const ctx = e.ctx;
    const SIM_IDS = ['physics', 'match', 'world', 'weapons', 'player', 'ai'];

    if (ctx.time.scale !== 1) {
      return { fatal: `time.scale is ${ctx.time.scale}; the tick maths below assumes 1` };
    }
    for (const id of SIM_IDS) {
      const s = ctx.peek(id);
      if (!s) return { fatal: `subsystem "${id}" is not registered` };
      if (!s.captureState || !s.restoreState) {
        return { fatal: `"${id}" has no captureState/restoreState — netcode step 5 is not wired` };
      }
    }

    // `--nolod` — hold every bot at full detail. `_updateRelevance` runs on the
    // FRAME and keys off the camera frustum, so it is the first suspect for any
    // rate dependence that is too large to be interpolation: an LOD decision
    // that changes how often a bot is animated changes it a different number of
    // times per simulated second at 30 fps than at 144.
    //
    // Patched on the prototype, not the instance — an own key here would be a
    // key no subsystem classified, and `replay.mjs` layer 2 fails those.
    if (NOLOD) {
      const ai0 = ctx.peek('ai');
      if (ai0) {
        Object.getPrototypeOf(ai0)._updateRelevance = function () {
          for (const a of this.agents) a.lodIrrelevant = false;
        };
        for (const a of ai0.agents) { a.lodIrrelevant = false; a._animSkip = 0; }
      }
    }

    const H = 1000 / 120;
    e.stop();
    let clock = performance.now();
    e._last = clock;
    e._accum = 0;

    /** One `step` per call is one tick, which is what makes a tick addressable. */
    const tick1 = () => {
      clock += H;
      e.step(clock);
    };

    /* ---- get somewhere worth measuring ---------------------------------- */
    //
    // Warmup is a scenario in which perception cannot be wrong: the player is
    // frozen and the bots have not been released. `replay.mjs` shipped a green
    // gate from inside warmup once already.
    const round = ctx.peek('match')?.round;
    let warmed = 0;
    while (round && round.phase !== 'live' && warmed < 4000) { tick1(); warmed++; }
    if (round && round.phase !== 'live') {
      return { fatal: `never reached the live phase (stuck in "${round.phase}")` };
    }
    // Let the bots spread out and acquire before the snapshot, so the span has
    // live perception in it rather than a roomful of bots still deciding.
    for (let i = 0; i < 360; i++) tick1();

    /* ---- the starting gun ----------------------------------------------- */
    const snap = {};
    for (const id of SIM_IDS) snap[id] = ctx.peek(id).captureState({});
    const kTick = ctx.time.tick;
    const clockK = clock;
    const engineK = { last: e._last, accum: e._accum };
    const timeK = {
      elapsed: ctx.time.elapsed, raw: ctx.time.raw,
      alpha: ctx.time.alpha, dt: ctx.time.dt, frame: ctx.time.frame,
    };

    const player = ctx.get('player');
    const ai = ctx.peek('ai');
    const BTN = e.commands.BTN ?? { fire: 1 };

    /**
     * What a bot knows, as comparable numbers.
     *
     * `lastKnown` is the memory the suspect path writes; `awareness` and
     * `lastKnownAge` are what the FSM reads out of it; `targetVisible` is the
     * ray's own verdict and the one that moves in whole steps rather than
     * smoothly — a bot that sees you one tick later at 144 Hz shows up here
     * before it shows up anywhere else.
     */
    const perception = () => {
      const rows = [];
      for (const a of [...(ai?.agents ?? [])].sort((x, y) => x.id - y.id)) {
        rows.push({
          id: a.id,
          visible: a.targetVisible ? 1 : 0,
          awareness: a.awareness,
          age: Number.isFinite(a.lastKnownAge) ? a.lastKnownAge : -1,
          x: a.lastKnown.x, y: a.lastKnown.y, z: a.lastKnown.z,
        });
      }
      return rows;
    };

    const runs = [];
    for (const fps of RATES) {
      for (const id of SIM_IDS) ctx.peek(id).restoreState(snap[id]);
      // DEBRIS IS NOT IN THE SNAPSHOT, AND IT IS IN `MASK.SIGHT`.
      //
      // `physics.bodies` is classified presentation (§3.2 of the handoff), on
      // the stated grounds that "the bullet trace only looks at the collider set
      // and the static BVH". That is not what `physics._raycastBodies` does: it
      // walks `bodies.bodies` whenever `LAYER.DEBRIS` is in the mask, and
      // `MASK.SIGHT` contains it. Brass on the floor occludes a bot's line of
      // sight, so debris steers perception and the classification is wrong —
      // exactly the hole §1.4 warns about, where a field wrongly declared
      // escapes both replay layers.
      //
      // Until that is settled, this harness must not inherit it: unsnapshotted
      // state means run N starts from whatever run N-1 left on the floor, which
      // would make this gate a function of the ORDER of `RATES`. Clearing gives
      // every rate the same (empty) floor; the debris created during the span
      // is deterministic, because `bodies.step` runs on the fixed step.
      ctx.peek('physics')?.bodies?.clear?.();
      ctx.time.tick = kTick;
      clock = clockK;
      e._last = engineK.last;
      e._accum = engineK.accum;
      ctx.time.elapsed = timeK.elapsed;
      ctx.time.raw = timeK.raw;
      ctx.time.alpha = timeK.alpha;
      ctx.time.dt = timeK.dt;
      ctx.time.frame = timeK.frame;

      // CONSTANT, for the whole span, at every rate. See the header.
      e.commands.override = { moveX: 0, moveY: 1, held: 0, edge: 0 };

      // ONE `step` IS ONE FRAME, and it runs whatever whole ticks the clock it
      // was handed has accumulated. That is the seam this gate needs and it is
      // the opposite of the loop a first version wrote: counting frames inside a
      // per-tick loop composes a frame every tick at every rate, so all five
      // runs were 120 fps wearing different labels and the gate measured nothing.
      //
      // The span is still fixed in TICKS. `frames * 120 === TICKS * fps` has to
      // hold exactly or the rate cannot express this span — checked, not
      // rounded past, because a rate that lands on a different tick count is
      // comparing different amounts of simulated time (`aim.mjs`, TICKS note).
      const frames = Math.round((TICKS * fps) / 120);
      if (frames * 120 !== TICKS * fps) {
        return { fatal: `${TICKS} ticks cannot be expressed at ${fps} fps — pick a tick count divisible by 120/gcd(120,fps)` };
      }
      const startPos = player.feetPosition
        ? { x: player.feetPosition.x, y: player.feetPosition.y, z: player.feetPosition.z }
        : null;
      // Sample the drawn pose on the frame that carries the mid-span tick. The
      // frame boundaries do not line up across rates and that is the point:
      // `alpha` at a given tick is exactly what differs, and guard 2 needs to
      // show it differs before any null result downstream is worth reading.
      let lerpProbe = null;
      const probeTick = kTick + Math.floor(TICKS / 2);

      // Absolute clock, not an accumulated one. `clock += 1000/30` thirty times
      // is not `clock + 1000`, and the drift decided whether the engine's
      // accumulator crossed its last fixed step: 30, 60 and 100 fps landed on
      // tick 1070 while 120 and 144 landed on 1071, so the first version was
      // comparing different amounts of simulated time — the exact defect
      // `aim.mjs` documents in its TICKS note, reintroduced from the other end.
      //
      // Computing each frame's timestamp from the span makes the LAST one
      // exactly `clockK + TICKS * H` at every rate, so every run hands the
      // engine the same total time and takes the same number of fixed steps.
      const totalMs = TICKS * H;
      // Perception keyed by TICK, sampled at every frame boundary.
      //
      // The end state alone cannot separate a cause from its consequences —
      // `replay.mjs` spent two sessions reporting 76 diverged leaves of which
      // the causes were three, until it compared per tick. A rate that composes
      // fewer frames than ticks can only be observed on its own frame
      // boundaries, so the series are sparse and only their COMMON ticks are
      // compared. That is enough to bracket the first divergence.
      const byTick = new Map();
      for (let f = 0; f < frames; f++) {
        clock = clockK + (totalMs * (f + 1)) / frames;
        e.step(clock);
        byTick.set(ctx.time.tick, perception());
        if (!lerpProbe && ctx.time.tick >= probeTick) {
          const p = player.position; // the interpolated draw pose
          lerpProbe = { x: p.x, y: p.y, z: p.z };
        }
      }
      e.commands.override = null;

      const endPos = player.feetPosition
        ? { x: player.feetPosition.x, y: player.feetPosition.y, z: player.feetPosition.z }
        : null;
      const travelled = startPos && endPos
        ? Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y, endPos.z - startPos.z)
        : 0;

      // Guard 3 asks whether perception FIRED during the span, not whether a bot
      // happened to be holding a target on the final tick. The first version
      // asked the latter and reported 1/5, which reads as "this scenario barely
      // works" when in fact bots saw the player throughout and had lost him by
      // the last frame.
      let sawTicks = 0;
      for (const rows of byTick.values()) if (rows.some((r) => r.visible === 1)) sawTicks++;

      runs.push({
        fps, frames,
        landedAt: ctx.time.tick,
        travelled,
        lerpProbe,
        rows: perception(),
        sawTicks,
        samples: byTick.size,
        series: [...byTick.entries()].map(([t, rows]) => [t, rows]),
      });
    }

    return { kTick, runs, agents: ai?.agents?.length ?? 0 };
  },
  { RATES, TICKS, NOLOD: !!args.nolod }
);

await browser.close();
if (vite && !args.keep) try { process.kill(-vite.pid); } catch { /* already gone */ }

/* ====================================================================== */
/*  Report                                                                */
/* ====================================================================== */

if (out.fatal) {
  console.log(`\nPERCEIVE FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}
if (errors.length) {
  console.log(`\nPERCEIVE FAILED — page errors:\n  - ${errors.slice(0, 5).join('\n  - ')}`);
  process.exit(1);
}

const fail = [];
const runs = out.runs;
const control = runs.find((r) => r.fps === 120) ?? runs[0];

console.log(`\nPERCEIVE — ${TICKS} ticks at 120 Hz from one snapshot (tick ${out.kTick}), composed at ${RATES.length} frame rates`);
console.log(`  ${out.agents} bots`);

/* ---- the span has to be the same span at every rate ------------------- */
for (const r of runs) {
  if (r.landedAt !== control.landedAt) {
    fail.push(`harness: ${r.fps} fps landed on tick ${r.landedAt}, the control on ${control.landedAt} — different amounts of simulated time`);
  }
}

/* ---- guard 1: did the player move? ------------------------------------ */
const minTravel = Math.min(...runs.map((r) => r.travelled));
if (minTravel < MOVED_MIN) {
  fail.push(`guard 1: the player travelled ${minTravel.toFixed(3)} m (need ${MOVED_MIN}) — a stationary player has no interpolation, so this span could not have shown the defect`);
} else {
  console.log(`  guard 1: the player moved ${minTravel.toFixed(2)} m`);
}

/* ---- guard 2: did interpolation actually differ between rates? -------- */
let lerpSpread = 0;
for (const r of runs) {
  if (!r.lerpProbe || !control.lerpProbe) continue;
  const d = Math.hypot(
    r.lerpProbe.x - control.lerpProbe.x,
    r.lerpProbe.y - control.lerpProbe.y,
    r.lerpProbe.z - control.lerpProbe.z
  );
  if (d > lerpSpread) lerpSpread = d;
}
if (lerpSpread < LERP_MIN) {
  fail.push(`guard 2: the interpolated pose varied by only ${lerpSpread.toExponential(2)} m across rates (need ${LERP_MIN}) — the input the suspect path reads did not move, so a null result here is the harness's, not the game's`);
} else {
  console.log(`  guard 2: the drawn pose differs by up to ${(lerpSpread * 100).toFixed(1)} cm between rates`);
}

/* ---- guard 3: did anyone actually see anything? ----------------------- */
const minSaw = Math.min(...runs.map((r) => r.sawTicks));
if (!minSaw) {
  fail.push(`guard 3: in at least one run no bot ever had a visible target — perception that never fired proves nothing`);
} else {
  const pct = runs.map((r) => `${r.fps}fps ${Math.round((r.sawTicks / r.samples) * 100)}%`).join(' · ');
  console.log(`  guard 3: a bot had a visible target on ${pct} of sampled ticks`);
}

/* ---- the question --------------------------------------------------- */
const FIELDS = ['visible', 'awareness', 'age', 'x', 'y', 'z'];
const diffs = [];
for (const r of runs) {
  if (r === control) continue;
  for (let i = 0; i < r.rows.length; i++) {
    const a = control.rows[i];
    const b = r.rows[i];
    if (!a || a.id !== b.id) {
      fail.push(`harness: bot roster differs between ${control.fps} and ${r.fps} fps`);
      break;
    }
    for (const f of FIELDS) {
      const d = Math.abs(a[f] - b[f]);
      if (d > TOL) diffs.push({ fps: r.fps, id: b.id, field: f, control: a[f], got: b[f], d });
    }
  }
}

console.log(`\n  frames composed:  ${runs.map((r) => `${r.fps}fps ${r.frames}`).join('  ·  ')}`);

/* ---- where did it start? --------------------------------------------- */
//
// A field that differs at the end of a 2 s span says almost nothing about what
// caused it: two seconds is long enough for a centimetre to become a different
// decision, and a different decision to become a bot somewhere else entirely.
// The first COMMON tick at which a run parts from the control is the diagnosis.
const controlSeries = new Map(control.series);
for (const r of runs) {
  if (r === control) continue;
  let firstTick = null;
  let firstRows = null;
  for (const [t, rows] of r.series) {
    const c = controlSeries.get(t);
    if (!c) continue; // not a tick the control observed — rates sample differently
    const bad = [];
    for (let i = 0; i < rows.length; i++) {
      for (const f of FIELDS) {
        if (Math.abs(c[i][f] - rows[i][f]) > TOL) bad.push(`agent#${rows[i].id}.${f}`);
      }
    }
    if (bad.length) { firstTick = t; firstRows = bad; break; }
  }
  if (firstTick === null) {
    console.log(`    ${String(r.fps).padStart(3)}fps  matches the control on every common tick`);
  } else {
    console.log(`    ${String(r.fps).padStart(3)}fps  first differs at tick ${firstTick} (+${firstTick - out.kTick}) in ${firstRows.length}: ${firstRows.slice(0, 4).join(', ')}`);
  }
}

if (!diffs.length) {
  console.log(`  perception is IDENTICAL across every rate`);
} else {
  const worst = diffs.reduce((m, d) => (d.d > m.d ? d : m));
  console.log(`  perception DIFFERS across rates — ${diffs.length} field(s), worst ${worst.d.toExponential(3)}`);
  for (const d of diffs.slice(0, 12)) {
    console.log(`    ${String(d.fps).padStart(3)}fps  agent#${d.id}.${d.field.padEnd(9)} control ${d.control}  got ${d.got}`);
  }
  fail.push(`${diffs.length} perception field(s) depend on the frame rate — what a bot sees is not a function of the tick`);
}

if (fail.length) {
  console.log(`\nPERCEIVE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nPERCEIVE OK — what a bot perceives is the same at ${RATES.join('/')} fps`);
