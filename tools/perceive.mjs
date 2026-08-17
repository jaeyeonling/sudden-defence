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
 * THERE IS NO BLIND SPOT. THE SCENARIO NEVER STAGED THE QUESTION.
 *
 * The re-run was done, on a pinned world with a clean baseline, and
 * `--induce=drawnhead` still scored 0 against a clean 0. Three explanations
 * were checked in order, and only the third survives:
 *
 *   the induction is broken?   No. It resolves the prototype from a live
 *                              combatant and dies fatal if `simHead` is not an
 *                              own descriptor there, and `Combatant.position`
 *                              still resolves to `movement.renderPosition`, so
 *                              the swap really does hand back a drawn pose.
 *   something masks it?        No. `--induce=drawnhead --isolate=player:footstep`
 *                              — induce the defect AND cut the channel suspected
 *                              of overwriting it — is still 0. That combination
 *                              did not exist before; it does now.
 *   nothing to act on?         YES.
 *
 *     guard 3   a bot had a visible target on 100% of sampled ticks
 *     guard 3b  that target was the PLAYER on 0%
 *
 * An `Agent` has no `renderPosition` and no `feetPosition`, so for a BOT target
 * `head` and `simHead` are the same vector and the induction is a no-op. The
 * whole interpolated-pose defect class exists only for the player, and in this
 * span the bots fight each other from the first tick to the last. The induction
 * had nothing to bite.
 *
 * So the note this replaces — "this gate cannot see the defect it was built
 * for" — was wrong, and guard 3 is why it survived: the guard exists to catch
 * exactly this kind of vacuity and it was measuring a PROXY. "Somebody saw
 * something" is not "somebody saw the thing whose pose is interpolated". `3b`
 * asks the real question and fails the run when `--induce=drawnhead` is asked
 * for without it.
 *
 * THAT SCENARIO EXISTS NOW, AND THE QUESTION IS CLOSED. `--stage=playertarget`
 * resets one enemy bot into the player's forward lane (LOS-checked, out loud if
 * no lane is clear) and waits for GENUINE acquisition — the bot's own
 * range/cone/LOS pass, nothing written into perception by hand. Guard 3b goes
 * from 0% to ~88%, and with the question actually staged:
 *
 *     clean       0 field(s)
 *     induced    59 field(s), worst 1.861e+1   — 18.6 METRES
 *
 * The gate sees the defect class it was built for, and sees it loudly: put
 * perception back on the drawn head while a bot is watching the player and
 * `lastKnown` ends up eighteen metres rate-dependent inside two seconds; keep
 * it on the fixed-step head and every rate matches to the bit.
 *
 * Which also closes the oldest open item in this header: the routing of
 * perception to `simHead` (§3.5) was adopted on principle after the commit that
 * claimed to justify it was found reading a contaminated measurement. This is
 * the uncontaminated version — clean control, pinned world, staged question,
 * 0 against 59 — and the principle now has its measurement.
 *
 * TWO OTHER HYPOTHESES DIED, recorded so nobody kills them twice:
 *
 *   LOD             `_updateRelevance` does run on the frame; `--nolod` changes
 *                   nothing.
 *   bullet:impact   bot rounds land on hitboxes posed in `ai.lateUpdate`, on the
 *                   frame — but `--isolate=bullet:impact` is bit-for-bit
 *                   identical to the baseline. The channel carries none of it.
 *
 * ONE OF THOSE TWO WAS NOT DEAD. `bullet:impact` IS THE CARRIER.
 *
 * (LOD survives re-checking. `--nolod` on the pinned world scores 8 fields with
 * the same first divergence as the baseline — it changes nothing, exactly as
 * recorded. That hypothesis is dead on a measurement that now means something.)
 *
 * Both acquittals above were measured before the scenario was pinned, so each
 * ran on a world drawn from `Math.random()` — a different scenario every time,
 * and an acquittal from a world that never spread is not an acquittal. Re-run on
 * the fixed seed, with a clean control and a baseline that does spread:
 *
 *     baseline               8 field(s), first divergence 30:+212 60:+212
 *                                                        100:+212 144:+211
 *     without bullet:impact  0 field(s), every rate clean at every tick
 *
 * Both signals, not just the endpoint. Cut the channel and no rate parts from
 * the control anywhere in the span. `weapon:fire`, tested the same way on the
 * same world, changes nothing at all (8 -> 8, same first divergence), and
 * `player:footstep` was fixed long ago.
 *
 * THE MECHANISM IS STILL OPEN, and the obvious readings have been checked and do
 * NOT explain it — recorded so the next session starts past them:
 *
 *   the trigger      `_runTrigger` is called from `WeaponSystem.fixedUpdate`
 *                    (line ~936). It is DEFINED below `update()`, so a grep that
 *                    credits a call to the nearest hook above it says "frame".
 *                    It is not; the same trap cost this session two false leads.
 *   the firing basis `_eye`/`_aimDir` come from `player.aimOrigin`/`aimForward`,
 *                    which are `CameraRig` snapshot state advanced by `stepAim`
 *                    on the tick. Simulation, and it rewinds.
 *   the raycasts     `_raycastBodies` reads `b.position` and `_raycastRagdolls`
 *                    reads `rd.px/py/pz` — both stepped in `physics.fixedUpdate`,
 *                    and the ragdoll AABB used for the broadphase cull is rebuilt
 *                    inside `step()` too.
 *
 * So the channel is proven and the leak inside it is not. `--trace=<event>` is
 * that next probe, and it has now been run:
 *
 *     control    9 events · same-rate repeat IDENTICAL
 *     30 fps     9 events — POSITION differs on 9
 *       #0 at t1049   control 1.046120,0.022040,18.000000
 *                      30fps  1.045086,0.021079,18.000000
 *
 * SAME COUNT, SAME TICKS, DIFFERENT PLACE. Every rate fires the same nine rounds
 * on the same nine ticks and every one of them lands somewhere else. That rules
 * out both of the other two defects the trace can distinguish: the trigger is
 * not reading frame time (count would move) and the round is not being announced
 * on a frame (tick would move). What is left is the RAY.
 *
 * And the ray's basis looks clean on inspection, which is the interesting part.
 * `_eye`/`_aimDir` come from `player.aimOrigin`/`aimForward`; both, plus the
 * `eye` height they are built from, are written ONLY in `CameraRig.stepAim` —
 * called on the tick — and all three are snapshot state that rewinds. The spread
 * cone draws from the weapons rng, which is snapshot state too.
 *
 * Note `z` is 18.000000 in both: the same wall, hit at a different point. So
 * either the basis differs despite being sim-written, or the ray is stopped by
 * something else first and that something moved.
 *
 * THE RAY WAS TRACED NEXT, and it answers the question the point alone could
 * not. `bullet:impact` carries `incident`, so no instrumentation in `src` was
 * needed:
 *
 *     direction DIFFERS · what it hit the same
 *       control  -0.250794235,-0.044228942,0.967029499
 *        30fps   -0.250831027,-0.044265355,0.967018290
 *
 * Same wall, same surface, same everything downstream — the ROUND IS AIMED
 * DIFFERENTLY, by about 4e-5 in direction. So the ray is not being blocked by a
 * frame-posed collider; nothing is in the way that was not in the way at 120 fps.
 * The hitbox path is not implicated by this measurement.
 *
 * AND THE SHOOTER IS NOT THE PLAYER. The first attempt to split the aim hooked
 * `WeaponSystem._syncAim` and never fired once: this harness drives the player
 * with `held: 0`, so THE PLAYER NEVER SHOOTS in the span. Every impact is a
 * BOT's round, and a bot does not pass through the weapon system's trigger at
 * all — `agent._shoot` calls `physics.fireBullet` directly. The spread cone,
 * `_spread` and the weapons rng were never in this story.
 *
 * Hooked at `fireBullet` instead, which both paths share and which carries the
 * ray as submitted:
 *
 *     submitted by #1 · origin same · dir DIFFERS
 *       dir  -0.250794235268,-0.044228941761,0.967029499171
 *            -0.250831027210,-0.044265355293,0.967018290473
 *
 * SAME BOT, SAME MUZZLE, DIFFERENT AIM. `agent._shoot` builds the direction as
 * `_muzzleDir.copy(this.aimTarget).sub(origin)`, so with the origin identical
 * the difference is entirely in `aimTarget`.
 *
 * WHICH CLOSES A LOOP RATHER THAN ENDING THE HUNT. `aimTarget` is lerped toward
 * `lastKnown` with a wobble scaled by `suppression` — and BOTH of those are
 * raised by `bullet:impact` (`hear` and the suppression pass). So the channel
 * this gate convicted is the one that feeds its own cause. Cutting it goes clean
 * because it opens the loop, not because the leak is inside it.
 *
 * The entry point is therefore EARLIER than the first traced impact (t1049,
 * +211) and this gate cannot see it: it samples six fields — `visible`,
 * `awareness`, `age` and `lastKnown` — and `suppression`, `aimTarget` and the
 * lerp state behind them are not among them. The first divergence it reports
 * (+212, `awareness`) is one tick AFTER the first impact already differed.
 *
 * THE ENTRY POINT, FOUND WITH `--deep`. `time.elapsed` IS FRAME TIME.
 *
 * `--deep` samples a wider set per tick (position, yaw, `aimTarget`,
 * `suppression`, awareness, health, `lastKnown`) without touching the verdict,
 * and asks only what parts FIRST:
 *
 *     144fps  first at tick 839 (+1)  in 21: agent#1.atx, agent#1.aty, ...
 *     100fps  first at tick 840 (+2)  in 21: same
 *      60fps  first at tick 840 (+2)  in 21: same
 *      30fps  first at tick 842 (+4)  in 21: same
 *
 * Not `awareness` at +212 — `aimTarget`, at +1, on EVERY bot at once. Which
 * points straight at the one input all seven share:
 *
 *     // agent.js, _aim()
 *     const wobbleT = this.ctx.time.elapsed * 1.7 + this.id;
 *
 * And `engine.js:147` advances that field ONCE PER FRAME, by the frame's delta:
 *
 *     t.dt = rawDt * t.scale;
 *     t.elapsed += t.dt;          // <- before the fixed-step loop
 *     while (this._accum >= FIXED_DT) { ...fixedUpdate... }
 *
 * So `time.elapsed` is FRAME TIME, not simulation time. Every fixed step inside
 * one frame reads the same already-advanced value, and at a given TICK the value
 * depends on how the frames were divided. A bot's aim wobble is therefore a
 * function of the display rate, which is exactly the +1-tick, all-agents,
 * scales-with-rate signature above.
 *
 * `agent.js` asserts the opposite two hundred lines further down — "`time.elapsed`,
 * not wall clock: simulation time, advanced on the tick, carried by every rewind
 * harness" — and that comment is the justification for feeding it to the pose.
 * It is wrong, and it is not the only simulation consumer: `weapons` builds
 * proxy timers from it and `player/health.js` stamps `lastDamageTime` with it,
 * which puts regeneration timing on the frame rate too.
 *
 * This also explains why cutting `bullet:impact` goes clean without the leak
 * being inside it: the aim difference is ~1e-5 at +1 and needs the impact
 * feedback loop (aim -> round -> hear/suppress -> aim) to grow into anything the
 * six-field verdict can see by +212. And it explains why `replay.mjs` stays
 * BIT-IDENTICAL: one tick per `step` means `elapsed` advances identically, so
 * that gate cannot vary the one thing this defect depends on.
 *
 * THE FIX IS A CORE DECISION, NOT A PATCH HERE: simulation needs its own clock,
 * advanced inside the fixed loop, with every sim consumer repointed at it and
 * `elapsed` left to presentation. Sized and left for its own commit.
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
 * PERCEPTION WAS FRAME-RATE DEPENDENT AND THE DEFAULT SPAN WAS TOO SHORT TO
 * SEE IT. (Both are fixed: the dependence was `time.elapsed` being frame time,
 * and the default span is 480 now — see the note at its definition.) The divergence needs roughly 390 ticks to surface, so a 240-tick span
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
 * THE STANDING SUSPECT: `weapon:fire` IS FLUSHED ON THE FRAME
 *
 * `ai` turns a gunshot into `agent.hear(...)`, which writes `lastKnown` and
 * raises `awareness` — so which TICK a shot lands on steers perception.
 * `WeaponSystem._flushShots` emits `weapon:fire` and is called from
 * `WeaponSystem.lateUpdate`, a FRAME hook, while the shots it flushes were
 * decided on the tick. `0c65020` fixed the ADDRESS a gunshot carries (off the
 * viewmodel, onto the tick) and not the MOMENT it is announced.
 *
 * A hypothesis with a mechanism, not a measurement. `--isolate=weapon:fire` is
 * the test and it has not been run yet.
 *
 * NOT `player:footstep`, THOUGH IT LOOKS LIKE IT SHOULD BE. That one was found
 * and fixed already — see THE DEFECT above — and `_drainMovementEvents` now
 * runs from the fixed step. A grep that attributes an `emit` to the nearest
 * hook ABOVE it in the file says otherwise, because the drain is defined below
 * `update()` and gets credited to it; this note exists because that mistake was
 * made here, and briefly written into this header as fact.
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
 *                           [--seed=N]           which world to measure
 *                           [--trace=<event>]    diff one channel's stream
 *                           [--deep]             what parts FIRST, wider than the verdict
 *                           [--stage=playertarget]  reset an enemy bot to hold the PLAYER
 *                           [--isolate=<event>]  cut one channel, same snapshot
 *                           [--induce=drawnhead|frameevents]  put a defect back
 */
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
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
// 480, raised from 240 — and the history of that number is the tool's own
// lesson in span selection. At 240 this gate was green while the frame-rate
// dependence it exists to catch needed ~390 ticks to surface: the default span
// stopped 150 ticks before its own subject, and the header carried "the green
// at the default is a statement about 2 seconds, not about the simulation" as
// an open wound. It stayed at 240 anyway, deliberately, because raising it
// would have turned the gate red on a defect nobody had located — a red that
// teaches re-running, not fixing. The defect is located and fixed now
// (`time.elapsed` was frame time; simulation runs on `time.sim`), 480 is green
// with a clean control, and the span finally covers the window it was built to
// watch.
const TICKS = Number(args.ticks ?? 480);
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
/** Master rng seed for the page. Pins WHICH world the sweep measures. */
const SEED = Number(args.seed ?? 0x5eed1234) >>> 0;
/** How far the player must travel for guard 1 to pass, metres. */
const MOVED_MIN = 0.5;
/**
 * How far the interpolated position must differ BETWEEN rates for guard 2,
 * metres. One tick at walking speed is ~4 cm, so half a tick of lag is 2 cm;
 * 1 mm is comfortably below anything real and far above float dust.
 */
const LERP_MIN = 1e-3;

const vite = await ensureServer(PORT, { name: 'PERCEIVE' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// `lockstep=1` so the boot is a FRAME COUNT rather than a race. Without it the
// engine free-runs until `__READY__`, which waits on three rAF frames that land
// whenever the machine gets to them, and two invocations reach this line having
// consumed the rng a different number of times — different world, same tick
// number. The `scenario:` line in the report is what makes that checkable.
// `seed` pins the world and `lockstep=1` pins the boot, and BOTH are needed for
// two invocations to be comparable. The seed is the bigger of the two by far:
// without it `Engine` draws its master rng from `Math.random()`, so every run
// was a different scenario and every isolation result in this tool's history
// was a comparison between two worlds that had never met. `lockstep` then makes
// the boot a frame COUNT rather than a race against `__READY__`'s rAF probe.
// `--seed=N` picks a different world on purpose; the `scenario:` line reports
// which one was actually reached.
await page.goto(
  `http://127.0.0.1:${PORT}/?prewarm=0&lockstep=1&seed=${SEED}`,
  { waitUntil: 'load' }
);
await page.waitForFunction("window.__READY__ === true", null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ RATES, TICKS, NOLOD, ISOLATE, INDUCE, TRACE, DEEP, STAGE }) => {
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
    // THE CLOCK IS PART OF THE SCENARIO.
    //
    // Starting from `performance.now()` starts every invocation from a different
    // absolute time, and `engine.step` derives dt as `(now - _last) / 1000`, so
    // the SAME nominal 1/120 s rounds to a different double depending on how
    // large the operands are. `crossengine.mjs` traced 28 leaves of its own
    // control noise to exactly this and pinned a constant; this harness warms
    // for thousands of ticks before it snapshots, which is thousands of chances
    // for that rounding to pick a different world to hand the sweep.
    //
    // A constant here does not make the boot reproducible on its own — the page
    // free-runs until `__READY__`, and `crossengine.mjs` established that
    // `__READY__` waits on three rAF frames that arrive at different wall-clock
    // times, so the rng is already a few draws apart before this line runs. It
    // removes the source this tool controls; `warmed`/`waited`/`kTick` are
    // reported so the remainder is visible rather than assumed.
    const CLOCK0 = 8_000_000; // arbitrary, constant, far from any real `now`
    let clock = CLOCK0;
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

    // `--stage=playertarget` — make a bot hold the PLAYER before the snapshot.
    //
    // The comment above says "while someone is actually looking at the player",
    // and guard 3b measured what the wait actually delivers: a bot with A
    // target on 100% of ticks, the PLAYER as that target on 0%. The bots fight
    // each other; the player stands unnoticed at spawn. That vacuity is what
    // acquitted `--induce=drawnhead` twice — an `Agent` has no interpolated
    // pose, so a defect that lives in the drawn head has nothing to bite until
    // somebody is looking at the one combatant who has one.
    //
    // Staging RESETS one enemy bot into the player's forward lane, facing back
    // at them, and then WAITS for genuine acquisition — the bot's own
    // range/cone/LOS pass sets `target`, nothing is written into perception
    // state by hand. `reset` is the same entry `match` uses between rounds, so
    // the staged world is one the simulation could have produced. The spot is
    // walked outward along the player's facing until the head-to-head ray is
    // clear, because a stage the level geometry happens to block would recreate
    // the very vacuity this exists to remove — and if no clear spot exists the
    // run says so out loud rather than measuring nothing.
    let staged = null;
    if (STAGE === 'playertarget') {
      const phys_ = ctx.peek('physics');
      const player = ctx.get('player'); // shadows the later declaration on purpose — staging runs first
      const bot = (aiSys?.agents ?? []).find((a) => a.alive && a.team !== player.team);
      if (!bot) return { fatal: 'stage=playertarget: no living enemy bot to stage' };
      const yaw = player.aimYaw ?? 0;
      // Player forward in world space — see `health.js`: forward at yaw is (-sin, -cos).
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const eye = { x: player.aimOrigin.x, y: player.aimOrigin.y, z: player.aimOrigin.z };
      let spot = null;
      for (const d of [6, 9, 12, 15]) {
        const c = { x: eye.x + fx * d, y: eye.y, z: eye.z + fz * d };
        if (phys_?.lineOfSight?.(eye, c, phys_.MASK.SIGHT)) { spot = { d, x: c.x, z: c.z }; break; }
      }
      if (!spot) return { fatal: 'stage=playertarget: no clear lane in front of the player at 6-15 m' };
      // Face the bot back along the lane. `reset` speaks the AI convention,
      // which differs from world yaw by PI — `aiYaw` is its own inverse, and
      // `friendfoe.mjs` applies the same +PI for the same reason.
      const back = Math.atan2(-fx, -fz) + Math.PI;
      bot.reset(new (player.aimOrigin.constructor)(spot.x, player.feetPosition.y, spot.z), back);
      let stagedWait = 0;
      const acquired = () => bot.alive && bot.targetVisible && bot.target?.isPlayer;
      while (!acquired() && stagedWait < 600) { tick1(); stagedWait++; }
      if (!acquired()) {
        return { fatal: `stage=playertarget: bot #${bot.id} did not acquire the player within ${stagedWait} ticks at ${spot.d} m` };
      }
      staged = { bot: bot.id, dist: spot.d, stagedWait };
    }

    /* ---- the starting gun ----------------------------------------------- */
    const snap = {};
    for (const id of SIM_IDS) snap[id] = ctx.peek(id).captureState({});
    const kTick = ctx.time.tick;
    // THE WORLD'S FINGERPRINT, not just the tick's. Pinning the clock made the
    // scenario SHAPE reproducible — two invocations now warm the same number of
    // ticks and snapshot at the same tick number — while the STATE at that tick
    // still differs, because the page free-runs until `__READY__` and the rng is
    // already a few draws apart before this harness takes the wheel. A tick
    // number that matches is not a world that matches, and every isolation
    // result in this tool is a comparison between invocations, so the thing that
    // has to match must be printed rather than assumed.
    let snapHash = '(unhashable)';
    try {
      const s = JSON.stringify(snap);
      let h = 0x811c9dc5 >>> 0;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      snapHash = h.toString(16).padStart(8, '0');
    } catch { /* a snapshot that will not serialise still runs; it just cannot be compared */ }
    const clockK = clock;
    const engineK = { last: e._last, accum: e._accum };
    const timeK = {
      elapsed: ctx.time.elapsed, raw: ctx.time.raw,
      alpha: ctx.time.alpha, dt: ctx.time.dt, frame: ctx.time.frame,
    };

    const player = ctx.get('player');
    const ai = ctx.peek('ai');

    /**
     * What a bot knows, as comparable numbers.
     *
     * `lastKnown` is the memory the suspect path writes; `awareness` and
     * `lastKnownAge` are what the FSM reads out of it; `targetVisible` is the
     * ray's own verdict and the one that moves in whole steps rather than
     * smoothly — a bot that sees you one tick later at 144 Hz shows up here
     * before it shows up anywhere else.
     */
    /**
     * DEEP SAMPLE — wider than the gate's verdict, and deliberately not part of
     * it.
     *
     * The six fields above are the QUESTION this gate asks, so widening them
     * would change what a red means. But those six are also why the gate cannot
     * find its own entry point: the first traced round already flew differently
     * one tick BEFORE `awareness` moved, and the state that aimed it —
     * `aimTarget`, and the `suppression` that scales its wobble — is not
     * sampled. This records the upstream fields per tick so "what parts first"
     * can be answered without touching the verdict.
     *
     * `position`/`yaw` are here to catch the case where nothing perceptual
     * diverges at all and the bot is simply somewhere else.
     */
    const deep = () => {
      const rows = [];
      for (const a of [...(ai?.agents ?? [])].sort((x, y) => x.id - y.id)) {
        rows.push({
          id: a.id,
          px: a.position.x, py: a.position.y, pz: a.position.z,
          yaw: a.yaw,
          atx: a.aimTarget.x, aty: a.aimTarget.y, atz: a.aimTarget.z,
          supp: a.suppression ?? 0,
          aw: a.awareness,
          health: a.health,
          lkx: a.lastKnown.x, lky: a.lastKnown.y, lkz: a.lastKnown.z,
        });
      }
      return rows;
    };

    const perception = () => {
      const rows = [];
      for (const a of [...(ai?.agents ?? [])].sort((x, y) => x.id - y.id)) {
        rows.push({
          id: a.id,
          visible: a.targetVisible ? 1 : 0,
          // NOT scored — `FIELDS` decides the verdict and this is not in it.
          // Guard 3 needs it: `--induce=drawnhead` swaps `simHead` for the DRAWN
          // head, and only the player has a drawn pose to differ from its sim
          // one. An Agent has no `renderPosition` and no `feetPosition`, so for
          // a bot target `head` and `simHead` are the same vector and the
          // induction is a no-op. A span where bots only ever fight each other
          // cannot exercise that defect no matter how long it runs.
          onPlayer: a.targetVisible && a.target?.isPlayer ? 1 : 0,
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
    // TRACE: record the stream of one channel per run, so a channel that
    // `--isolate` has already convicted can be asked HOW it differs. Three
    // answers are possible and they are three different defects:
    //   COUNT     the rates do not fire the same number of events
    //   TICK      same events, announced on different ticks
    //   POSITION  same events, same ticks, different payload
    // Isolation can only say "this channel"; it cannot tell these apart, and
    // fixing the wrong one of the three is indistinguishable from fixing none.
    let trace = null;
    // THE AIM'S THREE INPUTS, captured where they are produced.
    //
    // `incident` on the impact is the ray AFTER the spread cone, so a direction
    // difference has three possible sources and the payload alone cannot name
    // one. These two hooks split them: `_syncAim` produces the BASIS and holds
    // the spread MAGNITUDE at the moment it is read, and `rng.disc` is the DRAW.
    // Every one of the three inspects as tick-written snapshot state, so exactly
    // one of them is expected to be lying.
    // Hooked at `physics.fireBullet` rather than at `WeaponSystem._syncAim`,
    // because the first version of this probe never fired: this harness drives
    // the player with `held: 0`, so THE PLAYER NEVER SHOOTS. Every impact in the
    // span is a BOT's round, and a bot does not go through the weapon system's
    // trigger at all — `agent._shoot` calls `fireBullet` directly with a muzzle
    // origin and a direction aimed at `aimTarget`. `fireBullet` is the seam both
    // paths share, and it carries the ray as submitted, before any solve.
    let lastAim = null;
    const ph = ctx.peek('physics');
    if (ph && typeof ph.fireBullet === 'function') {
      const origFire = ph.fireBullet.bind(ph);
      ph.fireBullet = (o) => {
        const d = o?.dir;
        const g = o?.origin;
        lastAim = {
          ax: +(d?.x ?? NaN), ay: +(d?.y ?? NaN), az: +(d?.z ?? NaN),
          ex: +(g?.x ?? NaN), ey: +(g?.y ?? NaN), ez: +(g?.z ?? NaN),
          src: o?.source?.id ?? null,
        };
        return origFire(o);
      };
    }
    ctx.events.emit = (type, payload) => {
      if (blocked && blocked === type) return undefined;
      if (trace && type === TRACE) {
        const p = payload ?? {};
        const pos = p.position ?? p.point ?? p;
        // `incident` is the ray's DIRECTION and it is what splits the last two
        // candidates. A hit point can move for two reasons and they need
        // opposite fixes: the ray was aimed differently (direction moves), or
        // the ray was aimed identically and stopped by something else on the way
        // (direction matches, and `surface`/`actor`/`part` say what stopped it).
        const inc = p.incident;
        trace.push({
          t: ctx.time.tick,
          x: +(pos?.x ?? NaN), y: +(pos?.y ?? NaN), z: +(pos?.z ?? NaN),
          ix: +(inc?.x ?? NaN), iy: +(inc?.y ?? NaN), iz: +(inc?.z ?? NaN),
          surf: p.surface ?? null,
          actor: p.actor?.id ?? null,
          aim: lastAim,
          // `damage` and `part` say WHICH round this was when positions match;
          // without them two impacts a millimetre apart look like one moved.
          d: p.damage ?? null,
          part: p.part ?? null,
        });
      }
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
      trace = TRACE ? [] : null;
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
      const byTickDeep = DEEP ? new Map() : null;
      for (let f = 0; f < frames; f++) {
        clock = clockK + (totalMs * (f + 1)) / frames;
        e.step(clock);
        byTick.set(ctx.time.tick, perception());
        if (byTickDeep) byTickDeep.set(ctx.time.tick, deep());
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
      let sawPlayerTicks = 0;
      for (const rows of byTick.values()) {
        if (rows.some((r) => r.visible === 1)) sawTicks++;
        if (rows.some((r) => r.onPlayer === 1)) sawPlayerTicks++;
      }

      return {
        fps, frames,
        trace: trace ? [...trace] : null,
        landedAt: ctx.time.tick,
        travelled,
        lerpProbe,
        rows: perception(),
        sawTicks,
        sawPlayerTicks,
        samples: byTick.size,
        series: [...byTick.entries()].map(([t, rows]) => [t, rows]),
        deep: byTickDeep ? [...byTickDeep.entries()].map(([t, rows]) => [t, rows]) : null,
      };
    };

    // The gate's own verdict always comes from the CLEAN sweep, so `--induce`
    // and `--isolate` can never turn a red into a green by accident.
    const runs = sweep(null);
    // Both extra conditions run from the SAME snapshot, so the only thing that
    // differs is the one thing being varied.
    const isolated = ISOLATE ? sweep(ISOLATE) : null;
    const induced = INDUCE ? sweep(null, true) : null;
    // BOTH AT ONCE — the only way to ask whether a channel is MASKING the
    // induced defect. `--induce=drawnhead` puts perception back on the drawn
    // pose, which differs 4.2 cm between rates (guard 2), and the gate still
    // scores zero. Either it cannot see that class at all, or something
    // overwrites the induced value before the sample: sight sets `lastKnown`
    // from the head, and `_onHeard` sets it from a SIM position, so a loud
    // enough cue arriving often enough erases the difference every tick.
    // Cutting the suspected masker while the defect is induced separates those.
    const inducedIsolated = INDUCE && ISOLATE ? sweep(ISOLATE, true) : null;

    return {
      kTick, warmed, waited, snapHash, staged, runs, isolated, induced, inducedIsolated,
      isolate: ISOLATE, induce: INDUCE,
      agents: ai?.agents?.length ?? 0,
    };
  },
  {
    RATES, TICKS,
    NOLOD: !!args.nolod,
    TRACE: typeof args.trace === 'string' ? args.trace : null,
    DEEP: !!args.deep,
    STAGE: typeof args.stage === 'string' ? args.stage : null,
    ISOLATE: typeof args.isolate === 'string' ? args.isolate : null,
    INDUCE: typeof args.induce === 'string' ? args.induce : null,
  }
);

await browser.close();
if (!args.keep) killServer(vite);

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
// THE SCENARIO'S FINGERPRINT. Two invocations that print the same three numbers
// snapshotted the same world and their results are comparable; two that do not
// ran different scenarios, and a difference between them says nothing. Every
// isolation claim in this tool's history rests on this being checked.
console.log(`  scenario: warmed ${out.warmed} + settle 360 + waited ${out.waited} -> snapshot at tick ${out.kTick}, world ${out.snapHash}`);
if (out.staged) console.log(`  staged: bot #${out.staged.bot} reset into the player's lane at ${out.staged.dist} m, acquired in ${out.staged.stagedWait} ticks`);

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

/* ---- guard 3b: was the target the PLAYER? ----------------------------- */
//
// "A bot saw something" is not the same question as "a bot saw the thing whose
// pose is interpolated". An Agent has no `renderPosition` and no `feetPosition`,
// so for a BOT target `head` and `simHead` are the same vector — the whole
// interpolated-pose defect class only exists for the player. A span of bots
// fighting each other exercises none of it, however long it runs and however
// busy it looks, and guard 3 passes at 100% throughout.
const minSawPlayer = Math.min(...runs.map((r) => r.sawPlayerTicks ?? 0));
const pctP = runs.map((r) => `${r.fps}fps ${Math.round(((r.sawPlayerTicks ?? 0) / r.samples) * 100)}%`).join(' · ');
console.log(`  guard 3b: that target was the PLAYER on ${pctP} of sampled ticks`);
if (!minSawPlayer && out.induce === 'drawnhead') {
  // Only fatal for the induction that needs it. The gate's own verdict is about
  // perception in general and does not require the player to be the target.
  fail.push(
    `guard 3b: no bot ever held the PLAYER as a visible target, and --induce=drawnhead only ` +
      `differs for the player — the induction had nothing to act on, so "did not go red" says ` +
      `nothing about the gate`
  );
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

/* ---- the deep sample, if one was asked for ---------------------------- */
//
// The verdict's six fields answer "does perception depend on the rate". They
// cannot answer "what parted FIRST", and on this scenario the answer is earlier
// than any of them: the first round already flew differently one tick before
// `awareness` moved. This walks a wider set per tick and names the earliest
// field to move, which is the only thing that points at a cause.
if (control?.deep) {
  const DEEPF = ['px', 'py', 'pz', 'yaw', 'atx', 'aty', 'atz', 'supp', 'aw', 'health', 'lkx', 'lky', 'lkz'];
  console.log(`\n  deep — first field to part, per rate (verdict unaffected):`);
  const c2 = control2?.deep;
  if (c2) {
    const cs = new Map(control.deep);
    let dirty = false;
    for (const [t, rows] of c2) {
      const c = cs.get(t);
      if (!c) continue;
      for (let i = 0; i < rows.length && !dirty; i++) {
        for (const f of DEEPF) if (Math.abs(c[i][f] - rows[i][f]) > TOL) { dirty = true; break; }
      }
      if (dirty) break;
    }
    console.log(`    control      same-rate repeat ${dirty ? 'DIFFERS — read nothing below' : 'IDENTICAL'}`);
    if (dirty) fail.push(`the deep sample is not reproducible at a fixed rate`);
  }
  const cs = new Map(control.deep);
  for (const r of runs) {
    if (r === control || !r.deep) continue;
    let hit = null;
    for (const [t, rows] of r.deep) {
      const c = cs.get(t);
      if (!c) continue;
      const bad = [];
      for (let i = 0; i < rows.length; i++) {
        for (const f of DEEPF) {
          const d = Math.abs(c[i][f] - rows[i][f]);
          if (d > TOL) bad.push({ id: rows[i].id, f, a: c[i][f], b: rows[i][f], d });
        }
      }
      if (bad.length) { hit = { t, bad }; break; }
    }
    if (!hit) { console.log(`    ${String(r.fps).padStart(3)}fps  nothing parts`); continue; }
    const names = [...new Set(hit.bad.map((x) => `agent#${x.id}.${x.f}`))];
    console.log(`    ${String(r.fps).padStart(3)}fps  first at tick ${hit.t} (+${hit.t - out.kTick}) in ${names.length}: ${names.slice(0, 5).join(', ')}`);
    const w = hit.bad.reduce((m, x) => (x.d > m.d ? x : m));
    console.log(`           largest  agent#${w.id}.${w.f}  ${w.a}  vs  ${w.b}  (${w.d.toExponential(3)})`);
  }
}

/* ---- the trace, if one was asked for ---------------------------------- */
//
// `--isolate` convicts a CHANNEL. This asks the next question, which isolation
// structurally cannot: HOW does the stream differ? Three answers, three defects.
if (control?.trace) {
  console.log(`\n  trace — "${args.trace}" stream vs the ${control.fps} fps control:`);
  const key = (e) => `${e.x.toFixed(6)},${e.y.toFixed(6)},${e.z.toFixed(6)}`;
  const c2 = control2?.trace;
  if (c2) {
    const same = c2.length === control.trace.length
      && c2.every((e, i) => e.t === control.trace[i].t && key(e) === key(control.trace[i]));
    console.log(`    control      ${String(control.trace.length).padStart(4)} events · same-rate repeat ${same ? 'IDENTICAL' : 'DIFFERS — read nothing below'}`);
    if (!same) fail.push(`the traced stream is not reproducible at a fixed rate — the trace cannot diagnose anything`);
  }
  for (const r of runs) {
    if (r === control || !r.trace) continue;
    const a = control.trace;
    const b = r.trace;
    if (a.length !== b.length) {
      console.log(`    ${String(r.fps).padStart(3)}fps  ${String(b.length).padStart(4)} events — COUNT differs (control ${a.length}). The rates do not fire the same rounds.`);
      continue;
    }
    // Same count: line them up and ask which of the two remaining fields moved.
    let tickOff = 0;
    let posOff = 0;
    let firstT = null;
    let firstP = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i].t !== b[i].t) { tickOff++; if (firstT === null) firstT = i; }
      if (key(a[i]) !== key(b[i])) { posOff++; if (firstP === null) firstP = i; }
    }
    if (!tickOff && !posOff) {
      console.log(`    ${String(r.fps).padStart(3)}fps  ${String(b.length).padStart(4)} events — IDENTICAL stream`);
      continue;
    }
    const parts = [];
    if (tickOff) parts.push(`TICK differs on ${tickOff}`);
    if (posOff) parts.push(`POSITION differs on ${posOff}`);
    console.log(`    ${String(r.fps).padStart(3)}fps  ${String(b.length).padStart(4)} events — ${parts.join(' · ')}`);
    if (firstT !== null) {
      console.log(`           first tick shift  #${firstT}: control t${a[firstT].t} vs t${b[firstT].t} (${b[firstT].t - a[firstT].t >= 0 ? '+' : ''}${b[firstT].t - a[firstT].t})`);
    }
    if (firstP !== null) {
      const A = a[firstP];
      const B = b[firstP];
      console.log(`           first pos shift   #${firstP} at t${A.t}`);
      console.log(`             control  ${key(A)}   [${A.surf}${A.actor !== null ? ` actor#${A.actor}/${A.part}` : ''}]`);
      console.log(`             ${String(r.fps).padStart(3)}fps   ${key(B)}   [${B.surf}${B.actor !== null ? ` actor#${B.actor}/${B.part}` : ''}]`);
      // THE SPLIT. Same aim + different landing = something stopped the ray.
      // Different aim = the firing basis is not what it claims to be.
      const dirKey = (e) => `${e.ix.toFixed(9)},${e.iy.toFixed(9)},${e.iz.toFixed(9)}`;
      const dirSame = dirKey(A) === dirKey(B);
      const hitSame = A.surf === B.surf && A.actor === B.actor && A.part === B.part;
      console.log(`             direction ${dirSame ? 'IDENTICAL' : 'DIFFERS'} · what it hit ${hitSame ? 'the same' : 'DIFFERENT'}`);
      if (!dirSame) {
        console.log(`               ${dirKey(A)}`);
        console.log(`               ${dirKey(B)}`);
        // `incident` is the ray AFTER the spread cone is applied, so a
        // difference here has three possible sources and this trace separates
        // none of them. Saying "the basis" would be the same mistake as reading
        // an endpoint and calling it a channel.
        // Split the three inputs, if the aim hooks were installed.
        const av = A.aim;
        const bv = B.aim;
        if (!av || !bv) {
          console.log(`             => THE RAY DIFFERS; the \`fireBullet\` hook did not install, so the`);
          console.log(`                submitted origin and direction are not separated from the solve.`);
        } else {
          const v3 = (o, p) => `${o[p + 'x'].toFixed(12)},${o[p + 'y'].toFixed(12)},${o[p + 'z'].toFixed(12)}`;
          const dirSubSame = v3(av, 'a') === v3(bv, 'a');
          const origSame = v3(av, 'e') === v3(bv, 'e');
          console.log(`             submitted by ${av.src === bv.src ? `#${av.src}` : `#${av.src} vs #${bv.src} — DIFFERENT SHOOTER`} · origin ${origSame ? 'same' : 'DIFFERS'} · dir ${dirSubSame ? 'same' : 'DIFFERS'}`);
          if (!origSame) { console.log(`               origin  ${v3(av, 'e')}`); console.log(`                       ${v3(bv, 'e')}`); }
          if (!dirSubSame) { console.log(`               dir     ${v3(av, 'a')}`); console.log(`                       ${v3(bv, 'a')}`); }
          if (av.src !== bv.src) {
            console.log(`             => a DIFFERENT BOT fired this round. The divergence is upstream of`);
            console.log(`                ballistics entirely — who decided to shoot moved.`);
          } else if (!origSame && !dirSubSame) {
            console.log(`             => the shooter's MUZZLE and AIM both moved: the firing pose is`);
            console.log(`                frame-dependent. \`agent._shoot\` builds both from the rig.`);
          } else if (!origSame) {
            console.log(`             => the MUZZLE ORIGIN moved — the shooter's rig is posed differently.`);
          } else if (!dirSubSame) {
            console.log(`             => the AIM moved on a fixed muzzle: \`aimTarget\` differs, which is`);
            console.log(`                perception feeding back into ballistics.`);
          } else {
            console.log(`             => the SAME ray was submitted and landed elsewhere: the solve read`);
            console.log(`                something the frame moved.`);
          }
        }
      } else if (!hitSame) {
        console.log(`             => THE RAY IS BLOCKED DIFFERENTLY. Same aim, stopped by something else —`);
        console.log(`                a collider posed on the frame is in the way. Back on the hitbox path.`);
      } else {
        console.log(`             => same aim, same target, different point: the TARGET moved between rates.`);
      }
    }
  }
  // Say what each answer would mean, so the next session does not have to
  // reconstruct the reasoning from the numbers.
  console.log(`    COUNT differs    -> the trigger or its rationing is reading frame time`);
  console.log(`    TICK differs     -> the round is decided on the tick but ANNOUNCED on a frame`);
  console.log(`    POSITION differs -> the ray reads something the frame moved (pose, interpolated transform)`);
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
  // "Induced is non-zero" only means something when CLEAN IS ZERO. Once the
  // baseline spreads on its own, a red induced run is the baseline's red wearing
  // the induction's name, and the question — can this gate SEE the defect it was
  // built for — is answered by whether the induction MOVED the number.
  const same = ind.diffs.length === base.diffs.length && ind.worst === base.worst;
  // MASKING TEST. A defect this gate cannot see is either outside its reach or
  // being erased before it samples. If inducing changes nothing on its own but
  // changes something once a channel is cut, that channel was overwriting the
  // induced value — which is a fact about the SCENARIO, not about the defect.
  if (out.inducedIsolated) {
    const mi = score(out.inducedIsolated);
    console.log(`    induced + no ${out.isolate.padEnd(11)} ${String(mi.diffs.length).padStart(3)} field(s), worst ${mi.worst.toExponential(3)}`);
    if (!ind.diffs.length && mi.diffs.length) {
      console.log(`    => "${out.isolate}" was MASKING it. The defect is inside this gate's reach;`);
      console.log(`       the scenario was overwriting the induced value before the sample.`);
    } else if (!ind.diffs.length && !mi.diffs.length) {
      console.log(`    => not masked by "${out.isolate}" either — the gate's blindness is its own.`);
    }
  }
  if (!ind.diffs.length) {
    fail.push(`induced "${out.induce}" did NOT go red — this gate cannot see the defect it was built for, so its green means nothing`);
  } else if (same) {
    console.log(`    => INVISIBLE: identical to the clean sweep, field for field and worst for worst.`);
    console.log(`       The induction changed nothing this gate can measure, so a green from it`);
    console.log(`       would not have ruled the defect out. Settle the baseline spread first.`);
  } else if (!base.diffs.length) {
    console.log(`    => the gate sees it — clean is 0 and the induction moved it`);
  } else {
    console.log(`    => the gate MOVED (${base.diffs.length} -> ${ind.diffs.length} fields), but the baseline was already spreading;`);
    console.log(`       the delta is the evidence here, not the red`);
  }
}

if (fail.length) {
  console.log(`\nPERCEIVE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nPERCEIVE OK — what a bot perceives is the same at ${RATES.join('/')} fps`);
