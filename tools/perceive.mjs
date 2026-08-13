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
 * WHAT IT FOUND — and what it turned out NOT to have found
 *
 * THE DEFECT: `player._drainMovementEvents` ran on the FRAME. `stepEvent`,
 * `landEvent` and `jumped` are one-shot flags set on the tick, so a frame
 * holding four fixed steps read one and the other three were overwritten
 * unread. At 30 fps three of every four footsteps never happened, and `ai`
 * turns each one into `agent.hear(position, 24|11)` — so a player on a slow
 * display was quieter. `--isolate=player:footstep` collapsed the entire spread
 * to zero, which is what identified it. Draining on the tick took all five
 * rates to an exact match. (`land` carries fall damage and `jump` carries
 * recoil, so two more simulation channels were riding on the frame.)
 *
 * A CORRECTION, because the first reading of this gate was wrong. The spread
 * was first attributed to perception reading the INTERPOLATED head, and the
 * numbers seemed to agree (28 fields, worst 12 m -> 9e-4 m). They were measured
 * with the debris contamination below still present and the footstep defect
 * still live. With both settled, `--induce=drawnhead` — perception put back on
 * the drawn pose, same snapshot, same page — does NOT go red. This gate cannot
 * see that defect in this scenario, most likely because footsteps now refresh
 * `lastKnown` faster than sight does and `awareness` saturates while a bot
 * holds a target.
 *
 * So: routing perception to a fixed-step head is still right by §3.5, and its
 * difficulty cost was measured at zero (`threat`, `botfight` x9) — but THIS GATE
 * DOES NOT JUSTIFY IT, and the commit that said it did was reading a
 * contaminated measurement. Anyone tightening the scenario should re-run
 * `--induce=drawnhead` first; if it still passes, the gate has a blind spot
 * worth closing before it is trusted with that class.
 *
 * TWO OTHER HYPOTHESES DIED, recorded so nobody kills them twice:
 *
 *   LOD             `_updateRelevance` does run on the frame; `--nolod` changes
 *                   nothing.
 *   bullet:impact   bot rounds land on hitboxes posed in `ai.lateUpdate`, on the
 *                   frame — but `--isolate=bullet:impact` is bit-for-bit
 *                   identical to the baseline. The channel carries none of it.
 *
 * NOT IN THE SUITE: THE SCENARIO IS NOT REPRODUCIBLE ENOUGH YET
 *
 * Run alone this gate is green. Run as part of `npm test` it went red, with a
 * signature that says what is missing: all five rates first diverge within one
 * tick of each other (+131, +132) and an `awareness` drops to 0 — a bot DIED
 * inside the span. Bot hitboxes are posed in `ai.lateUpdate`, on the frame, and
 * `MASK.BULLET` contains ACTOR, so which bone a round lands on — and therefore
 * WHEN someone dies — is a function of the frame rate. Everything downstream of
 * that death is a consequence, not a cause.
 *
 * That is a real defect and probably the next one to fix. But until the span
 * either excludes deaths or the hitbox path is settled, this gate is FLAKY, and
 * a flaky gate is worse than a red one: a red gate tells you something, a flaky
 * one teaches the next person to re-run it until it passes.
 *
 * `--isolate=bullet:impact` does NOT catch this. That channel is the NOISE a
 * round makes; this is the DAMAGE it does. Different path, same posed rig.
 *
 * THE CONTROL, AND WHAT IT REVEALED ABOUT THE DEFAULT SPAN
 *
 * Every rate is compared against the 120 fps run, so a difference is evidence
 * about the FRAME RATE only if two runs at the SAME rate agree. The sweep
 * therefore runs 120 fps a SECOND time and scores that pair first; the verdict
 * is gated on it, and a dirty control downgrades the rate number to
 * INCONCLUSIVE instead of reporting the harness's own noise as a finding.
 *
 * The control is clean — and that is what makes the next line worth acting on:
 *
 *     --ticks=240 (default)   control IDENTICAL · rates IDENTICAL
 *     --ticks=480             control IDENTICAL · rates DIFFER, first at ~+393
 *
 * PERCEPTION IS FRAME-RATE DEPENDENT AND THE DEFAULT SPAN IS TOO SHORT TO SEE
 * IT. The divergence needs roughly 390 ticks to surface, so a 240-tick span
 * stops about 150 ticks before its own subject. The green at the default is
 * real — the control says so — but it is a statement about 2 seconds, not about
 * the simulation, and the gate's tolerance is 1e-12 precisely because the
 * authors did not intend it to be a statement about 2 seconds.
 *
 * The field count varies between invocations (23, 47, 64 observed) for the
 * reason the next section gives: each invocation snapshots a different world.
 * That is scenario variance, NOT flakiness — within one invocation the control
 * is bit-identical every time.
 *
 * THE STANDING SUSPECT: EVENTS AI HEARS ARE EMITTED ON THE FRAME
 *
 * `ai` consumes `player:footstep` and `weapon:fire`, and both are emitted from
 * FRAME hooks — `PlayerSystem.update` and `WeaponSystem.update` — while the
 * conditions that produce them are decided on the tick. Earlier fixes addressed
 * the ADDRESS these carry (`82e35f3` put a footstep at the tick that took it,
 * `0c65020` took a gunshot's position off the viewmodel) and not the MOMENT
 * they fire. A bot's `hear()` sets `lastKnown` and raises `awareness`, so which
 * TICK a cue lands on is a function of how often the page composed a frame.
 *
 * That is a hypothesis with a mechanism, not a measurement — `--isolate` has
 * not yet caught it, because the one run attempted landed on a snapshot whose
 * baseline never spread (see the guard on that verdict below).
 *
 * WHY EVERY CONDITION RUNS INSIDE ONE INVOCATION
 *
 * Each run boots the page fresh and snapshots a different world, so comparing
 * one invocation against another compares two scenarios. `--induce=drawnhead`
 * read 0 fields once and 7 the next time on identical flags before this was
 * fixed. `--isolate` and `--induce` are both sweeps from the SAME snapshot, and
 * the gate's own verdict always comes from the clean one.
 *
 *   node tools/perceive.mjs [--port=5173] [--ticks=240] [--nolod] [--tol=N]
 *                           [--isolate=<event>]  cut one channel, same snapshot
 *                           [--induce=drawnhead|frameevents]  put a defect back
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
  async ({ RATES, TICKS, NOLOD, ISOLATE, INDUCE }) => {
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
        for (const a of ai0.agents) a.lodIrrelevant = false;
      }
    }

    // `--induce=drawnhead` — put perception back on the interpolated pose.
    //
    // A guard nobody has watched fire is a guard nobody knows the shape of, and
    // this defect is one `simHead` -> `head` away at all times: three call
    // sites, no type to stop it, and the gate that would otherwise catch it
    // (`replay.mjs`) is blind to this class by construction.
    //
    // TOGGLEABLE, not global, and that distinction cost a wrong reading. Applied
    // for the whole page, `--induce` also corrupts the baseline it is supposed
    // to be measured against — and since every invocation boots fresh and
    // snapshots a different world, comparing an induced RUN against a clean one
    // compares two different scenarios. It read 0 fields once and 7 the next
    // time on identical flags. Both conditions now run from the same snapshot in
    // the same page, which is the only comparison this tool can make.
    let induceProto = null;
    let induceOrig = null;
    if (INDUCE === 'drawnhead') {
      const c0 = ctx.peek('match')?.combatants?.[0];
      if (!c0) return { fatal: 'no combatants to induce against' };
      induceProto = Object.getPrototypeOf(c0);
      induceOrig = Object.getOwnPropertyDescriptor(induceProto, 'simHead');
      if (!induceOrig) return { fatal: 'Combatant has no simHead to induce against' };
    }

    // `--induce=frameevents` — drain the movement edges on the FRAME again.
    //
    // This is the defect this gate actually caught: `stepEvent`/`landEvent`/
    // `jumped` are one-shot flags set on the tick, so a frame holding four fixed
    // steps saw one of them and the other three were overwritten unread.
    let playerProto = null;
    let origDrain = null;
    let origUpdate = null;
    if (INDUCE === 'frameevents') {
      playerProto = Object.getPrototypeOf(ctx.get('player'));
      origDrain = playerProto._drainMovementEvents;
      origUpdate = playerProto.update;
      if (!origDrain || !origUpdate) return { fatal: 'player has no _drainMovementEvents/update to induce against' };
    } else if (INDUCE && INDUCE !== 'drawnhead') {
      return { fatal: `unknown --induce="${INDUCE}"` };
    }

    const setInduced = (on) => {
      if (induceProto) {
        if (on) {
          Object.defineProperty(induceProto, 'simHead', {
            get() { return this.head; },
            configurable: true,
          });
        } else {
          Object.defineProperty(induceProto, 'simHead', induceOrig);
        }
      }
      if (playerProto) {
        if (on) {
          // Neutralise the tick-side call and put one back on the frame.
          playerProto._drainMovementEvents = function () {};
          playerProto.update = function (dt, c) {
            origUpdate.call(this, dt, c);
            origDrain.call(this);
          };
        } else {
          playerProto._drainMovementEvents = origDrain;
          playerProto.update = origUpdate;
        }
      }
    };

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

    // SNAPSHOT WHILE SOMEONE IS ACTUALLY LOOKING AT THE PLAYER.
    //
    // Without this the starting world is whatever tick 1190 happened to be, and
    // guard 3 caught the consequence on a real run: a sweep where no bot ever
    // held a visible target, which measures hearing and calls it perception.
    // `replay.mjs` §1.3 is the same lesson — the scenario is part of the gate,
    // and a green (or a red) from a scenario that cannot exercise the path is
    // worth nothing either way.
    const aiSys = ctx.peek('ai');
    const anyVisible = () => (aiSys?.agents ?? []).some((a) => a.alive && a.targetVisible);
    let waited = 0;
    while (!anyVisible() && waited < 3600) { tick1(); waited++; }
    if (!anyVisible()) {
      return { fatal: `no bot acquired the player within ${waited} ticks of the live phase — nothing to measure` };
    }

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

    /**
     * ISOLATION — cut one event channel and re-run the whole sweep.
     *
     * Every rate starts from the same snapshot, so two CONDITIONS started from
     * that snapshot are a controlled experiment and a comparison BETWEEN RUNS of
     * this tool is not: each invocation boots the page fresh, reaches `live` at
     * a different moment and snapshots a different world. The first attempt at
     * this measured `--no-impact` against a previous invocation's numbers and
     * the two were not comparable — the same mistake `replay.mjs` documents,
     * which is why its induced failures could not be believed until its baseline
     * was green.
     *
     * The cut is made at `events.emit`, which is the narrowest seam that removes
     * a channel without touching the code under test. `fx` and `audio` lose the
     * event too; neither steers anything this gate reads.
     */
    const origEmit = ctx.events.emit.bind(ctx.events);
    let blocked = null;
    ctx.events.emit = (type, payload) => {
      if (blocked && blocked === type) return undefined;
      return origEmit(type, payload);
    };

    const CONTROL_FPS = RATES.includes(120) ? 120 : RATES[0];

    const sweep = (cut, induced = false) => {
      blocked = cut;
      setInduced(induced);
      const out = [];
      for (const fps of RATES) out.push(runOne(fps));
      // THE CONTROL: the reference rate, run a SECOND time from the same
      // snapshot. Every other row in this sweep is compared against the first
      // 120 fps run, so a difference is only evidence about the FRAME RATE if
      // two runs at the SAME rate agree. Without this row the gate cannot tell
      // "composed at a different rate" from "run twice", and a tool that cannot
      // separate those reports its own noise as a finding — which is exactly
      // what `crossengine.mjs` had to fix in itself before its numbers meant
      // anything.
      const c = runOne(CONTROL_FPS);
      c.isControl2 = true;
      out.push(c);
      setInduced(false);
      blocked = null;
      return out;
    };

    const runOne = (fps) => {
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

      return {
        fps, frames,
        landedAt: ctx.time.tick,
        travelled,
        lerpProbe,
        rows: perception(),
        sawTicks,
        samples: byTick.size,
        series: [...byTick.entries()].map(([t, rows]) => [t, rows]),
      };
    };

    // The gate's own verdict always comes from the CLEAN sweep, so `--induce`
    // and `--isolate` can never turn a red into a green by accident.
    const runs = sweep(null);
    // Both extra conditions run from the SAME snapshot, so the only thing that
    // differs is the one thing being varied.
    const isolated = ISOLATE ? sweep(ISOLATE) : null;
    const induced = INDUCE ? sweep(null, true) : null;

    return {
      kTick, runs, isolated, induced,
      isolate: ISOLATE, induce: INDUCE,
      agents: ai?.agents?.length ?? 0,
    };
  },
  {
    RATES, TICKS,
    NOLOD: !!args.nolod,
    ISOLATE: typeof args.isolate === 'string' ? args.isolate : null,
    INDUCE: typeof args.induce === 'string' ? args.induce : null,
  }
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
// The second same-rate run is not a rate — hold it aside so every existing
// comparison below keeps meaning what it meant, and read it first.
const runs = out.runs.filter((r) => !r.isControl2);
const control2 = out.runs.find((r) => r.isControl2);
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

/** Score one sweep the same way, so two conditions are comparable numbers. */
const score = (rs0) => {
  // The same-rate control row is not a rate. Scoring it as one would compare the
  // baseline sweep (which has it held aside) against an isolated sweep that
  // still carried it, and the two numbers would not be the same measurement.
  const rs = rs0.filter((r) => !r.isControl2);
  const ctl = rs.find((r) => r.fps === 120) ?? rs[0];
  const ds = [];
  for (const r of rs) {
    if (r === ctl) continue;
    for (let i = 0; i < r.rows.length; i++) {
      const a = ctl.rows[i];
      const b = r.rows[i];
      if (!a || a.id !== b.id) continue;
      for (const f of FIELDS) {
        const d = Math.abs(a[f] - b[f]);
        if (d > TOL) ds.push({ fps: r.fps, id: b.id, field: f, control: a[f], got: b[f], d });
      }
    }
  }
  const ctlSeries = new Map(ctl.series);
  const firsts = [];
  for (const r of rs) {
    if (r === ctl) continue;
    let firstTick = null;
    for (const [t, rows] of r.series) {
      const c = ctlSeries.get(t);
      if (!c) continue;
      let bad = false;
      for (let i = 0; i < rows.length && !bad; i++) {
        for (const f of FIELDS) if (Math.abs(c[i][f] - rows[i][f]) > TOL) { bad = true; break; }
      }
      if (bad) { firstTick = t; break; }
    }
    firsts.push({ fps: r.fps, firstTick });
  }
  return { diffs: ds, firsts, worst: ds.length ? Math.max(...ds.map((d) => d.d)) : 0 };
};

/* ---- READ THE INSTRUMENT BEFORE READING WHAT IT MEASURED -------------- */
//
// Every row below is compared against the FIRST 120 fps run. That comparison is
// evidence about the frame rate only if two runs at the SAME rate agree, so the
// same-rate pair is scored first and the verdict is gated on it.
let controlNoise = 0;
if (control2) {
  const ds = [];
  for (let i = 0; i < control2.rows.length; i++) {
    const a = control.rows[i];
    const b = control2.rows[i];
    if (!a || a.id !== b.id) continue;
    for (const f of FIELDS) {
      const d = Math.abs(a[f] - b[f]);
      if (d > TOL) ds.push({ id: b.id, field: f, a: a[f], b: b[f], d });
    }
  }
  const cs = new Map(control.series);
  let firstTick = null;
  let firstRows = null;
  for (const [t, rows] of control2.series) {
    const c = cs.get(t);
    if (!c) continue;
    const bad = [];
    for (let i = 0; i < rows.length; i++) {
      for (const f of FIELDS) if (Math.abs(c[i][f] - rows[i][f]) > TOL) bad.push(`agent#${rows[i].id}.${f}`);
    }
    if (bad.length) { firstTick = t; firstRows = bad; break; }
  }
  controlNoise = ds.length;
  if (!ds.length) {
    console.log(`\n  control — ${control.fps} fps run twice from the same snapshot: IDENTICAL`);
  } else {
    console.log(`\n  control — ${control.fps} fps run twice from the same snapshot: ${ds.length} field(s) DIFFER, worst ${Math.max(...ds.map((d) => d.d)).toExponential(3)}`);
    if (firstTick !== null) {
      console.log(`            first differs at tick ${firstTick} (+${firstTick - out.kTick}) in ${firstRows.length}: ${firstRows.slice(0, 4).join(', ')}`);
    }
    for (const d of ds.slice(0, 6)) {
      console.log(`            agent#${String(d.id).padEnd(2)} ${d.field.padEnd(9)} ${d.a}  vs  ${d.b}`);
    }
    fail.push(
      `the control is not clean: ${control.fps} fps run twice differs in ${ds.length} field(s) — ` +
        `nothing below can be attributed to the frame rate until that is 0`
    );
  }
}

const diffs = score(runs).diffs;
for (const r of runs) {
  if (r === control) continue;
  if (r.rows.length !== control.rows.length || r.rows.some((b, i) => control.rows[i]?.id !== b.id)) {
    fail.push(`harness: bot roster differs between ${control.fps} and ${r.fps} fps`);
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
  if (controlNoise) {
    // Do NOT call this a rate dependence. The control moved too, so this number
    // is noise plus signal and this tool separates neither.
    console.log(`  INCONCLUSIVE — the control moved ${controlNoise} field(s) on its own, so ${diffs.length} is an upper bound on noise + signal`);
  } else {
    fail.push(`${diffs.length} perception field(s) depend on the frame rate — what a bot sees is not a function of the tick`);
  }
}

/* ---- the isolation, if one was asked for ------------------------------ */
//
// Both conditions ran from the SAME snapshot in the SAME page, so these two
// numbers are a controlled experiment. Comparing against a previous invocation
// would not be: every run boots fresh and snapshots a different world.
if (out.isolated) {
  const base = score(runs);
  const iso = score(out.isolated);
  console.log(`\n  isolation — "${out.isolate}" suppressed at events.emit, same snapshot:`);
  console.log(`    baseline          ${String(base.diffs.length).padStart(3)} field(s), worst ${base.worst.toExponential(3)}`);
  console.log(`    without ${out.isolate.padEnd(16)} ${String(iso.diffs.length).padStart(3)} field(s), worst ${iso.worst.toExponential(3)}`);
  const b = base.firsts.map((f) => `${f.fps}:${f.firstTick === null ? 'clean' : `+${f.firstTick - out.kTick}`}`).join(' ');
  const i = iso.firsts.map((f) => `${f.fps}:${f.firstTick === null ? 'clean' : `+${f.firstTick - out.kTick}`}`).join(' ');
  console.log(`    first divergence  baseline ${b}   without ${b === i ? '(same)' : i}`);
  // TWO SIGNALS, AND A CHANNEL ONLY CLEARS THE SWEEP IF IT SILENCES BOTH.
  // `diffs` scores the FINAL perception rows; `firsts` scans the whole series
  // for the first tick a rate parts from the control. They can disagree, and
  // the first reading of this verdict did: cutting `player:footstep` took the
  // final rows to 0 while every rate still parted at the SAME tick as the
  // baseline (+242, +242, +241). The spread started exactly as before and
  // happened to re-converge by the last tick. Scoring only the endpoint called
  // that "CARRIES the rate dependence", which the series flatly contradicts.
  const spread = (s) => s.diffs.length || s.firsts.some((f) => f.firstTick !== null);
  if (!spread(base)) {
    // AN ISOLATION AGAINST A CLEAN BASELINE MEASURES NOTHING. Cutting a channel
    // cannot remove a spread that was not there, so "0 without it" is the same
    // reading as "0 with it" and says nothing about the channel. This is not
    // hypothetical: the scenario diverges only in SOME snapshots (see the
    // header — each invocation snapshots a different world), so an isolation
    // run can land on a world that never spreads, and the old wording called
    // that "does not carry it".
    console.log(`    => INCONCLUSIVE: the baseline never spread in this snapshot, so cutting "${out.isolate}" had nothing to remove`);
    console.log(`       re-run with a longer --ticks until the baseline is non-zero, then isolate`);
  } else if (!spread(iso)) {
    console.log(`    => "${out.isolate}" CARRIES the rate dependence — cut it and no rate parts from the control at any tick`);
  } else if (!iso.diffs.length) {
    const w = iso.firsts.filter((f) => f.firstTick !== null).map((f) => `${f.fps}:+${f.firstTick - out.kTick}`).join(' ');
    console.log(`    => "${out.isolate}" does NOT clear it: the final rows agree, but the spread still STARTS (${w})`);
    console.log(`       an endpoint that re-converged is not a channel that carried anything`);
  } else if (iso.diffs.length >= base.diffs.length) {
    console.log(`    => "${out.isolate}" does not carry it — the spread survives without the channel`);
  } else {
    console.log(`    => "${out.isolate}" carries PART of it`);
  }
}

/* ---- the induced failure, if one was asked for ------------------------ */
//
// Same snapshot, same page, defect reinstated. The clean sweep is the gate's
// verdict; this one only has to be RED. If it is not, the gate is not watching
// what its header claims it watches.
if (out.induced) {
  const base = score(runs);
  const ind = score(out.induced);
  console.log(`\n  induced — "${out.induce}", same snapshot:`);
  console.log(`    clean     ${String(base.diffs.length).padStart(3)} field(s), worst ${base.worst.toExponential(3)}`);
  console.log(`    induced   ${String(ind.diffs.length).padStart(3)} field(s), worst ${ind.worst.toExponential(3)}`);
  if (!ind.diffs.length) {
    fail.push(`induced "${out.induce}" did NOT go red — this gate cannot see the defect it was built for, so its green means nothing`);
  } else {
    console.log(`    => the gate sees it`);
  }
}

if (fail.length) {
  console.log(`\nPERCEIVE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nPERCEIVE OK — what a bot perceives is the same at ${RATES.join('/')} fps`);
