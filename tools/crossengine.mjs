#!/usr/bin/env node
/**
 * CROSSENGINE — do two different JavaScript engines simulate the same world?
 *
 * THIS IS THE QUESTION THAT PICKS THE NETCODE.
 *
 * Netcode step 5 proved the simulation is reproducible INSIDE one page: snapshot
 * a tick, replay the same commands, arrive at bit-identical state. That buys
 * rollback and lag compensation on one machine. It says nothing about two.
 *
 * If two engines agree, a deterministic architecture is available: peers
 * exchange COMMANDS, each re-simulates, and the wire carries a few bytes per
 * tick. If they disagree, that design is dead on arrival — not "slightly off",
 * dead, because divergence compounds and there is no reconciliation step in a
 * lockstep model. The fallback is server-authoritative state replication, where
 * the server broadcasts truth and clients never need to reproduce it.
 *
 * The choice is not a preference. It is this measurement.
 *
 * WHY ENGINES ARE A PROXY FOR MACHINES
 *
 * IEEE 754 pins +, -, *, / and sqrt to a correctly-rounded result, so those are
 * identical everywhere. It does NOT pin the transcendentals. `Math.sin`,
 * `cos`, `atan2`, `exp`, `pow`, `acos` — and `hypot`, which surprises people
 * because it sits next to `sqrt` in the docs — are all "implementation-
 * approximated" in the spec: an engine may return any value within its own
 * tolerance. V8, SpiderMonkey and JavaScriptCore use different implementations,
 * so where they differ is where two machines running different browsers would
 * differ, and it is a strict superset of where two machines running the SAME
 * browser would.
 *
 * This audit is why the gate exists (counts of call sites under `src/`):
 *
 *     physics   hypot 45 · sin 4 · cos 5 · exp 2 · acos 2
 *     ai        sin 51 · cos 28 · hypot 18 · exp 18 · atan2 5 · acos 3
 *     player    sin 14 · hypot 12 · cos 10 · pow 3
 *     weapons   sin 20 · cos 10 · atan2 1
 *
 * Those are not decorations. `physics`'s 45 `hypot` calls are distances, which
 * decide what a capsule sweep hits.
 *
 * HOW THE COMPARISON IS MADE FAIR
 *
 * Two questions, kept apart, because conflating them would blame the wrong half:
 *
 *   BOOT   dump the world before any driven tick. If engines disagree HERE, the
 *          divergence is in construction — level bake, nav grid, mesh-derived
 *          collision — and nothing about the step loop is implicated yet.
 *   STEP   drive N fixed steps with an identical constant command and dump
 *          again. A disagreement that appears only here is the simulation's.
 *
 * The clock is handed in, exactly one fixed step per `step()` call, so neither
 * engine gets a different number of ticks — the failure `aim.mjs` and
 * `perceive.mjs` both had to fix before their comparisons meant anything.
 *
 * The dump is `captureState` across the six simulation subsystems: the same
 * definition of "state that rewinds" that `replay.mjs` gates, so this cannot
 * drift away from that one. Numbers are compared as bit patterns, not as
 * numbers — a tolerance here would hide exactly the last-bit disagreement the
 * gate exists to find.
 *
 * WHAT A RED HERE MEANS
 *
 * Not that the game is broken. It means one architecture is unavailable, and it
 * should be read as a design input rather than a defect to fix. Chasing bit
 * equality across engines means replacing every transcendental with a fixed
 * implementation, which is a large, permanent tax on a codebase that generates
 * all of its geometry procedurally.
 *
 * WHAT IT SAYS NOW THAT THE CONTROL IS CLEAN
 *
 *     chromium vs chromium#control   IDENTICAL — boot, injected AND stepped
 *     chromium vs firefox            1/2287 leaves differ after 240 ticks
 *                                    (`ai.agents[2].s.animator.phase`)
 *
 * It used to read 25/1777 and 190/1777, and the 25 was the tool's own noise: two
 * processes were not merely out of phase at boot, they were building DIFFERENT
 * WORLDS, because `Engine` drew its master seed from `Math.random()`. Every
 * engine now boots with `?seed=` and `?lockstep=1` and the control is 0.
 *
 * Which finally makes the cross-engine number a measurement rather than an upper
 * bound on noise plus signal. ONE leaf after 240 driven ticks, and it is exactly
 * the shape the audit at the top predicted: `phase` advances by `dt * strideHz`,
 * `strideHz` comes off `st.speed`, and speed is computed with `hypot` — which the
 * spec leaves implementation-approximated. Not a structural disagreement; a
 * last-bit one, in the place the transcendental audit said to look.
 *
 * AND AT 1200 TICKS IT IS STILL ONE LEAF. The same one.
 *
 *     chromium vs chromium#control   identical
 *     chromium vs firefox            1/2324 — `ai.agents[2].s.animator.phase`
 *
 * Ten seconds of simulation and the disagreement did not compound. That is the
 * opposite of what 190/1777 implied, and it is the first evidence this project
 * has that a deterministic architecture is not dead on arrival. Read it as
 * evidence and not as a verdict: `phase` drives the pose, the pose drives
 * `syncHitboxes`, and a round landing on a different bone is exactly how one
 * leaf becomes many. It did not happen in THIS span; a span with the right shot
 * at the right moment is a different measurement.
 *
 * THE CHEAP HALF OF THE FIX IS ALREADY NAMED AT THE TOP OF THIS FILE, and it took
 * until now to notice. The audit says IEEE 754 pins "+, -, *, / and sqrt to a
 * correctly-rounded result" and leaves `hypot` among the approximated ones — but
 * `hypot(x, y, z)` IS `sqrt(x*x + y*y + z*z)` up to overflow handling, and that
 * spelling is correctly rounded everywhere. So the 75 `hypot` call sites in the
 * audit (physics 45, ai 18, player 12) are not part of the "large, permanent
 * tax" the header warns about; they are a mechanical substitution that costs
 * only the overflow range `hypot` exists to protect, which nothing at game
 * coordinates needs. The genuinely hard residue is `sin`/`cos`/`atan2`/`exp`/
 * `acos`, and the divergence measured here traces back through `speed` to
 * distances — i.e. to the cheap half.
 *
 * THE SUBSTITUTION IS DONE AND MEASURED. `src/core/dmath.js` spells `hypot` as
 * sqrt-of-squares for the simulation subsystems (84 call sites; presentation
 * keeps `Math.hypot`), and the run that used to leave one leaf now reads:
 *
 *     chromium vs chromium#control   identical          (1200 ticks)
 *     chromium vs firefox            IDENTICAL          (1200 ticks)
 *     chromium vs webkit             2/2324 — targetYaw on two agents
 *
 * V8 and SpiderMonkey now agree BIT-FOR-BIT over ten seconds of driven combat,
 * boot included. That is the strongest statement this tool has ever been able to
 * make, and it was not available at any earlier point in the project.
 *
 * The webkit residue was the hard half arriving on schedule: `targetYaw` is
 * `atan2`, genuinely implementation-approximated with no cheap respelling. The
 * scope decision came out at "fix the measured site": `src/core/dmath.js` now
 * carries a port of fdlibm's `atan`/`atan2` — every operation pinned arithmetic,
 * so the result is bit-identical by construction and within ~1 ulp of true —
 * substituted across the simulation directories. With that:
 *
 *     chromium vs chromium#control   identical        (1200 ticks)
 *     chromium vs firefox            IDENTICAL        (1200 ticks)
 *     chromium vs webkit             IDENTICAL        (1200 ticks)
 *
 * V8, SPIDERMONKEY AND JAVASCRIPTCORE SIMULATE THE SAME WORLD, bit for bit,
 * over ten seconds of driven combat. The deterministic architecture is
 * AVAILABLE on the evidence this tool was built to produce.
 *
 * Scope of that claim, stated so it cannot inflate: one seed, one span, one
 * scenario. The 3600-tick span (two deaths, grenades in flight) then named the
 * rest, one round at a time:
 *
 *   round 1   webkit 219 leaves: corpse particles. `dacos` (the ragdoll cone
 *             angle) collapsed it to 15 — the SAME 15 firefox shows.
 *   round 2   `dsin`/`dcos`/`dexp`/`dlog`/`dpow`/`dtan` at every simulation
 *             call site, `gauss()`'s Box–Muller included. THE FIFTEEN LEAVES
 *             DID NOT MOVE — bit-identical divergence values across all five
 *             substitution generations, which acquits every one of OUR call
 *             sites: the door is somewhere none of those substitutions touch.
 *   round 3   the trail forensics found the door. First divergence: a GRENADE
 *             IN FLIGHT (`ai._grenades[1].p[0]/p[2]`, tick 1917), and a
 *             grenade's throw origin is `animator.muzzleWorld` — a POSED BONE.
 *             The pose runs through three.js internals (`setFromEuler` and
 *             friends, 15 call sites across the simulation), and INSIDE those
 *             the library calls the engine's own `Math.sin`/`cos`/`atan2`.
 *             Substituting our sites never touched them.
 *
 * So the residue had a name and an address: transcendentals INSIDE three.js,
 * reached from simulation state through the pose path. Of the fifteen
 * three.js-internal call sites, only SIX actually run trig — `setFromEuler`
 * (the pose writer and the player's fire basis) and `setFromAxisAngle` (the
 * aim/look IK); `getWorldQuaternion`, `setFromUnitVectors` and the decompose
 * path are sqrt-and-arithmetic, pinned already, and the one `slerp` is the
 * debris PRESENTATION interpolation. `dquatFromEuler`/`dquatFromAxisAngle`
 * (three.js's own formulas with the trig on dmath) replaced the six, and:
 *
 *     chromium vs chromium#control   identical    (3600 ticks)
 *     chromium vs firefox            IDENTICAL    (3600 ticks)
 *     chromium vs webkit             IDENTICAL    (3600 ticks)
 *
 * Thirty seconds of driven combat — two deaths, ragdolls settling, grenades
 * thrown mid-span and in flight at the dump — and THREE ENGINES AGREE ON EVERY
 * BIT OF EVERY LEAF. This is the strongest statement this tool can currently
 * make, and it is the one it was built to make: the deterministic architecture
 * is available, on evidence that includes the paths that were noise when the
 * tool could not yet measure its own control.
 *
 * `dmath.js` remains the rule: a function is ported when a measurement
 * CONVICTS it, and every function in it was.
 *
 * THE SEED SWEEP FOUND ONE MORE, AND IT DID NOT LOOK LIKE MATH. Seed 1 broke
 * the agreement — corpses only, control clean — and `--rdwatch` (per-tick
 * particle hashes, BITS not quanta; its first quantised version invented a
 * "quiet-tick" entry sixty ticks after the real one) placed the divergence at
 * the ragdoll's BIRTH tick. `physics.__bvhTriHash` acquitted the bake: the
 * triangle soup is bit-identical, because a warehouse sits at right angles and
 * every engine's sin/cos agree at multiples of pi/2. The door was
 * `group.rotation.y = this.yaw` — Object3D's Euler proxy converts through
 * three.js's native setFromEuler, and that quaternion roots every bone's
 * matrixWorld. An arbitrary yaw is exactly where engine libms disagree.
 * `dquatFromEuler` at both write sites, and:
 *
 *     seeds 0x5eed1234, 1, 424242, 1519997492 — three engines, 3600 ticks,
 *     deaths and grenades in every span: IDENTICAL, all four.
 *
 * The control's noise has a known address: state the snapshot does not carry.
 * `tools/perceive.mjs` established that bot rigs are posed in `ai.lateUpdate`,
 * on the frame, and that `MASK.BULLET` contains ACTOR — so which bone a round
 * lands on is a function of animation the snapshot never captured. Two processes
 * reach the injection point having animated differently.
 *
 * SO THE ORDER OF WORK IS FIXED, and it was not obvious before this ran: the
 * hitbox path is not merely the next cleanup, it is the PRECONDITION for
 * measuring cross-machine determinism at all. Until the control is clean, the
 * netcode architecture cannot be chosen on evidence.
 *
 * THERE IS NO POST-UPDATE BONE WRITER. RESOLVED — READ THIS BEFORE HUNTING ONE.
 *
 * A previous session cornered the death-path noise onto a suspected writer that
 * moved the neck AFTER `an.update` returned, on the evidence of two probes that
 * contradicted each other: a checkpoint said the value moved between the
 * animator's return and the tick's end, while an `_onChangeCallback` trap on the
 * same quaternion counted ZERO writes. Both probes were lying, in different ways,
 * and the self-check that says so now runs inside the tool (`PROBE SELF-CHECK`):
 *
 *   trap alive          the trap is fired once by a no-op write to its own values
 *                       at install time, so a silent trap is told apart from a
 *                       detached one. RESULT: alive. It counted honestly.
 *   same agent          the checkpoint re-runs `find(alive)`; a death would hand
 *                       it a different bot than the one hooked. RESULT: same bot.
 *   animator run count  RESULT: 0 over the sampled window, 600 over 1200 ticks.
 *
 * That last number IS the answer. The AI ticks at 60 Hz against a 120 Hz step, so
 * the animator runs every OTHER tick, and it had not run yet in the two-tick
 * window the probes sampled. `neckAtReturn` was therefore a STALE string left
 * over from the warm-up, and comparing it against a live read manufactured a
 * "mutation" that never happened. Over the whole span the trap counts 2400 writes
 * and ZERO outside `an.update`: nothing writes these bones but the animator.
 *
 * What the same run establishes instead, and it is a better finding:
 *
 *   THE POSE DIVERGENCE IS INHERITED ACROSS INJECTION, NOT PRODUCED BY THE STEP
 *   LOOP. The bones already differ at the end of span tick 1 — before the
 *   animator's first run, with zero writes recorded. `restoreState` carries the
 *   animator's DRIVERS (`phase`, `blend`, the timers) but not the bones, on the
 *   documented grounds that `_writePose` re-derives every quaternion from the rig
 *   each call. It does — but not until the animator's next turn, and the capsules
 *   `syncHitboxes` welds to those bones are read on every tick in between. Two
 *   processes therefore enter the span holding different rigs, and one stale tick
 *   is enough to move where a round lands; after that the simulations have
 *   genuinely diverged and every later pose difference is downstream of it.
 *
 * RE-DERIVING THE POSE AT RESTORE DOES NOT FIX IT — MEASURED, NOT ASSUMED.
 *
 * The obvious repair is to let the restore finish the derivation: end
 * `AiSystem.restoreState` with `_drive(0)` per living agent, which re-reads
 * `state` from the restored simulation fields and evaluates the animator with
 * dt = 0. It was tried and it made the control WORSE — 10 leaves to 263 — for
 * two reasons worth writing down, because both are easy to re-propose:
 *
 *   THE HARNESS RESTORES ONE SIDE ONLY. `restoreState` runs under `if (INJECT)`;
 *   the reference process never calls it and enters the span with whatever pose
 *   its own free-running warm-up left. Re-deriving on the injected side alone
 *   moves that side to a pose the reference does not share.
 *
 *   `_drive(0)` IS NOT IDEMPOTENT. It poses from the CURRENT simulation fields,
 *   while a running process's bones hold the pose from its LAST AI TICK. The AI
 *   ticks at 60 Hz against a 120 Hz step, so at an arbitrary capture instant the
 *   pose lags its own drivers by up to one tick — and that lag is not in the
 *   snapshot. `_aiAccum` restores WHEN the next AI tick falls, not what the rig
 *   looked like before it.
 *
 * So the pose is not a pure function of captured state at an arbitrary instant,
 * which is the assumption `animator.js`'s exclusion note rests on. Closing it
 * means either capturing the bones after all, or removing the lag by posing on
 * every step so that pose and drivers are never out of phase.
 *
 * TWO FINDINGS THAT WERE RECORDED HERE AS STANDING, AND ARE BOTH OVERTURNED.
 * They are kept in full because the reasoning that produced them was sound and
 * the conclusions still were not — which is the more useful thing to remember.
 *
 *   BOOT IS NOT REPRODUCIBLE ACROSS ENGINES. "~150 leaves differ before a single
 *   driven tick, including bot spawn positions by 1.6 m. `__READY__` waits on
 *   three rAF frames and engines deliver them at different wall-clock times, so
 *   the free-running boot consumes `ai.rng` a different number of times."
 *
 *   NOW: `boot (pre-inject) identical`, chromium against firefox. The rAF
 *   diagnosis was a real mechanism but only half the cause — `Engine` also drew
 *   its MASTER SEED from `Math.random()`, so the engines were not out of phase
 *   in one world, they were in two. `?seed=` plus `?lockstep=1` and the boot
 *   reproduces across engines exactly.
 *
 *   THE LEVEL BAKE IS ENGINE-DEPENDENT. "`ai.cover.points` has a different
 *   LENGTH on the two engines (364 vs 360) — not different values, a different
 *   number of cover points extracted from the same level. A deterministic
 *   netcode would need the bake shipped rather than recomputed per client."
 *
 *   NOW: the boot dump is identical, `ai.cover` included, so the bake is a
 *   function of the seed and not of the engine. The different LENGTH was
 *   downstream of the different world, not of different arithmetic. Nothing has
 *   to be shipped that the seed cannot rebuild. (`--ignore=ai.cover` stays; it
 *   costs nothing and the day it is needed again it will be for a real reason.)
 *
 * BOTH WERE MEASURED ON UNSEEDED WORLDS, which is the same defect this tool now
 * guards against in others: a finding taken from a scenario that was never the
 * same twice. It cost two architectural conclusions, one of them ("ship the
 * bake") a substantial piece of work that turned out to be unnecessary.
 *
 *   node tools/crossengine.mjs [--ticks=240] [--engines=chromium,firefox]
 *                              [--seed=N]  which world every engine builds
 *                              [--rows=12] [--port=5173] [--ignore=a.b,c.d]
 */
import { parseArgs, ensureServer, killServer, waitForReady } from './harness.mjs';
import { chromium, firefox, webkit } from 'playwright';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const TICKS = Number(args.ticks ?? 240);
const ROWS = Number(args.rows ?? 12);
/** Master rng seed handed to EVERY engine. Pins which world is compared. */
const SEED = Number(args.seed ?? 0x5eed1234) >>> 0;
const LAUNCHERS = { chromium, firefox, webkit };
const ENGINES = String(args.engines ?? 'chromium,firefox')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const e of ENGINES) {
  if (!LAUNCHERS[e]) {
    console.log(`\nCROSSENGINE FAILED — harness: unknown engine "${e}"`);
    process.exit(1);
  }
}
if (ENGINES.length < 2) {
  console.log(`\nCROSSENGINE FAILED — harness: need at least two engines to compare`);
  process.exit(1);
}

const vite = await ensureServer(PORT, { name: 'CROSSENGINE' });

/**
 * Runs inside the page.
 *
 * `INJECT` is the reference engine's `captureState` blob. The second engine
 * RESTORES it before the driven span, which is what makes the comparison about
 * the step loop instead of about the boot.
 *
 * Booting is not reproducible across engines and this gate proved it the hard
 * way: without injection, `physics.characters[n].position` differed by 1.6 m at
 * tick 0 — not a last-bit disagreement but a different draw from `ai.rng`,
 * because `__READY__` waits on THREE rAF FRAMES and two engines take different
 * wall-clock times to deliver them. That is the harness, not the mathematics.
 *
 * THE PARENTHETICAL THAT USED TO SIT HERE IS OUT OF DATE. It read "`lockstep=1`
 * fixes the boot, but it implies `capture=1`, which suppresses `populate()` and
 * leaves an empty arena" — a real constraint, and it has been removed rather
 * than worked around: `lockstep` is independent of capture mode now, and
 * `?seed=` pins the master rng without pinning anything else. This harness boots
 * every engine with both. That closes the rAF-phase half of the divergence AND
 * the half nobody had named — `Engine` drew its master seed from `Math.random()`,
 * so the two processes were not merely out of phase, they were building
 * different worlds and the 1.6 m spawn gap above is what that looks like.
 */
const PROBE = async ({ TICKS, INJECT, NOFIRE, RDWATCH }) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const SIM_IDS = ['physics', 'match', 'world', 'weapons', 'player', 'ai'];

  if (ctx.time.scale !== 1) return { fatal: `time.scale is ${ctx.time.scale}` };
  for (const id of SIM_IDS) {
    const s = ctx.peek(id);
    if (!s?.captureState) return { fatal: `"${id}" has no captureState` };
  }

  // Bit pattern, not the number. Two engines that print the same 17 digits can
  // still hold different doubles, and the whole point here is the last bit.
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (n) => {
    buf.setFloat64(0, n);
    return `${buf.getUint32(0).toString(16)}.${buf.getUint32(4).toString(16)}`;
  };

  /** Flatten `captureState` output to path -> comparable string. */
  const flatten = (v, path, out, seen) => {
    if (v === null || v === undefined) { out.set(path, String(v)); return; }
    const t = typeof v;
    if (t === 'number') { out.set(path, Number.isFinite(v) ? `n:${bits(v)}` : `n:${v}`); return; }
    if (t === 'boolean' || t === 'string') { out.set(path, `${t[0]}:${v}`); return; }
    if (t !== 'object') { out.set(path, `?:${t}`); return; }
    if (seen.has(v)) { out.set(path, '<cycle>'); return; }
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      for (let i = 0; i < v.length; i++) flatten(v[i], `${path}[${i}]`, out, seen);
      return;
    }
    if (Array.isArray(v)) {
      out.set(`${path}.length`, `n:${v.length}`);
      for (let i = 0; i < v.length; i++) flatten(v[i], `${path}[${i}]`, out, seen);
      return;
    }
    for (const k of Object.keys(v)) flatten(v[k], `${path}.${k}`, out, seen);
  };

  const dump = () => {
    const out = new Map();
    const seen = new WeakSet();
    for (const id of SIM_IDS) {
      // Per-subsystem, so a capture that throws names its owner. A server that
      // snapshots on ITS schedule gets no say in which tick it lands on, so
      // "captureState is safe at every tick" is part of the contract — and the
      // first mid-span dump this tool ever took found a tick where it was not.
      try {
        flatten(ctx.peek(id).captureState({}), id, out, seen);
      } catch (err) {
        const top = String(err?.stack ?? err).split('\n').slice(0, 3).join(' <- ');
        out.set(`${id}.__captureThrew`, `s:${top.slice(0, 300)}`);
      }
    }
    return [...out.entries()];
  };

  e.stop();
  let clock = performance.now();
  e._last = clock;
  e._accum = 0.5 / 120; // half a tick of cushion, ON PURPOSE: the driver advances a
  // float clock by H = 1000/120 per step, and at performance.now() magnitudes the
  // rounded delta can land an epsilon BELOW FIXED_DT — a step that runs zero ticks,
  // a 59-of-60 drive, and a gate that fails on some start timestamps and not others.
  // Starting the accumulator mid-band keeps every boundary half a tick away; the
  // cushion never compounds (deltas average H exactly) and _accum is not sim state —
  // it only seeds alpha, which nothing these gates compare reads.
  const H = 1000 / 120;
  const tick1 = () => { clock += H; e.step(clock); };

  // BOOT — before anything is driven. Reported for the record; not the verdict.
  const startTick = ctx.time.tick;
  const boot = dump();
  // THE TRIANGLE SOUP IS NOT IN THE DUMP, and it is an input to everything a
  // corpse does. `captureState` excludes the bake (like `grid`) on the grounds
  // that it is a function of the seed — which is only true if every operation
  // that SHAPES it is pinned, and three.js's geometry generators place their
  // circle vertices with the engine's own sin/cos. Hash the world's actual
  // triangles (as bits, not values) so "the bake is identical" is measured
  // instead of inherited from leaves that quantise the difference away.
  {
    const w = ctx.peek('physics')?.staticWorld;
    if (w?.pos) {
      const u32 = new Uint32Array(w.pos.buffer, w.pos.byteOffset, w.pos.length);
      let h = 0x811c9dc5 >>> 0;
      for (let i = 0; i < u32.length; i++) h = Math.imul(h ^ u32[i], 0x01000193) >>> 0;
      boot.push(['physics.__bvhTriHash', `s:${w.triCount}·${h.toString(16)}`]);
    }
  }

  const round = ctx.peek('match')?.round;
  let warmed = 0;
  while (round && round.phase !== 'live' && warmed < 4000) { tick1(); warmed++; }
  if (round && round.phase !== 'live') return { fatal: `never reached live (${round.phase})` };

  const capture = () => {
    const b = {};
    for (const id of SIM_IDS) b[id] = ctx.peek(id).captureState({});
    return b;
  };

  // Hand the second engine the first one's world.
  // THE CLOCK IS PART OF THE INJECTION, and forgetting it was this tool's own
  // 28-leaf control noise. `engine.step` derives dt as `(now - _last) / 1000`,
  // so two processes whose absolute `performance.now()` differs round the SAME
  // nominal 1/120 s to different doubles — `replay.mjs` §5.2 measured what that
  // buys: 50 ULP on a round timer, one shifted respawn, everything downstream.
  // Both processes therefore restart their clock at the same constant before
  // the span, and the reference does it BEFORE capturing, so tick/elapsed/raw
  // in the snapshot agree with the clock the span will actually run on.
  //
  // Debris is cleared on BOTH sides for the same reason it is cleared at all
  // (not in the snapshot, in `MASK.SIGHT`) — clearing only the injected side
  // was an asymmetry: the reference kept its boot brass.
  const CLOCK0 = 8_000_000; // arbitrary, identical, far from either boot's now
  ctx.peek('physics')?.bodies?.clear?.();
  clock = CLOCK0;
  e._last = clock;
  e._accum = 0.5 / 120; // half a tick of cushion, ON PURPOSE: the driver advances a
  // float clock by H = 1000/120 per step, and at performance.now() magnitudes the
  // rounded delta can land an epsilon BELOW FIXED_DT — a step that runs zero ticks,
  // a 59-of-60 drive, and a gate that fails on some start timestamps and not others.
  // Starting the accumulator mid-band keeps every boundary half a tick away; the
  // cushion never compounds (deltas average H exactly) and _accum is not sim state —
  // it only seeds alpha, which nothing these gates compare reads.

  if (INJECT) {
    for (const id of SIM_IDS) ctx.peek(id).restoreState(INJECT[id]);
    ctx.time.tick = INJECT.__time.tick;
    ctx.time.elapsed = INJECT.__time.elapsed;
    ctx.time.raw = INJECT.__time.raw;
    ctx.time.alpha = INJECT.__time.alpha;
    ctx.time.dt = INJECT.__time.dt;
    ctx.time.frame = INJECT.__time.frame;
  }
  const snapshot = INJECT ? null : capture();
  if (snapshot) {
    snapshot.__time = {
      tick: ctx.time.tick, elapsed: ctx.time.elapsed, raw: ctx.time.raw,
      alpha: ctx.time.alpha, dt: ctx.time.dt, frame: ctx.time.frame,
    };
  }
  // The state both engines actually start the span from. If these differ, the
  // injection did not take and nothing downstream is worth reading.
  const start = dump();

  // Ragdoll forensics. The control's dominant divergence signature is one
  // whole ragdoll's particles, first and alone — which is either a doll BORN
  // different (creation reads something outside the snapshot) or a doll
  // STEPPED apart (integration reads one). Logging the creation tick and a
  // hash of the initial particle state separates the two.
  const phys_ = ctx.peek('physics');
  const rlog = [];
  // Bisect the pose pipeline: hash the Poser accumulator (pre-IK) and the foot
  // probe results after every evaluation, so a birth-pose difference names its
  // half — clip/additive inputs, or the IK chain.
  {
    const ai0 = ctx.peek('ai');
    for (const ag of ai0?.agents ?? []) {
      const an = ag.animator;
      if (!an) continue;
      const protoUpdate = Object.getPrototypeOf(an).update;
      const fbuf = new DataView(new ArrayBuffer(8));
      const mixF = (h, v) => {
        fbuf.setFloat64(0, v);
        h = (h * 31 + fbuf.getUint32(0)) >>> 0;
        return (h * 31 + fbuf.getUint32(4)) >>> 0;
      };
      // Record the FIRST _aimIk call's actual inputs after the span starts:
      // if they match while its output bones differ, the solver is impure; if
      // they differ, the impurity is upstream of it and older than this tick.
      const protoAim = Object.getPrototypeOf(an)._aimIk;
      an._aimIk = function (target, weight) {
        if (!this.__aimLog) {
          const hand = this.bones[this.iHandR];
          const bore = this._v.copy(this.boreLocal).applyQuaternion(this._wq(this.iHandR, this._q2)).normalize();
          const muzzle = this._v2.copy(this.muzzleLocal).applyMatrix4(hand.matrixWorld);
          this.__aimLog = [
            't', target.x.toFixed(9), target.y.toFixed(9), target.z.toFixed(9),
            'w', weight.toFixed(9),
            'bore', bore.x.toFixed(9), bore.y.toFixed(9), bore.z.toFixed(9),
            'mz', muzzle.x.toFixed(9), muzzle.y.toFixed(9), muzzle.z.toFixed(9),
          ].join(',');
        }
        return protoAim.call(this, target, weight);
      };
      const protoLook = Object.getPrototypeOf(an)._lookAt;
      an._lookAt = function (target, weight) {
        if (!this.__lookLog) {
          const wq = this._wq(this.iNeck, this._q2);
          const fwd = this._v.set(0, 0, 1).applyQuaternion(wq);
          const wp = this._wp(this.iNeck, this._v3);
          this.__lookLog = [
            'tgt', target.x.toFixed(9), target.y.toFixed(9), target.z.toFixed(9),
            'w', weight.toFixed(9),
            'fwd', fwd.x.toFixed(9), fwd.y.toFixed(9), fwd.z.toFixed(9),
            'wp', wp.x.toFixed(9), wp.y.toFixed(9), wp.z.toFixed(9),
          ].join(',');
        }
        return protoLook.call(this, target, weight);
      };
      an.update = function (dt, now) {
        protoUpdate.call(this, dt, now);
        let h = 0 >>> 0;
        const d3 = this.P?.d3;
        if (d3) for (let i = 0; i < d3.length; i++) h = mixF(h, d3[i]);
        this.__d3h = h.toString(16);
        let f = 0 >>> 0;
        f = mixF(f, this._footY[0]);
        f = mixF(f, this._footY[1]);
        this.__footh = f.toString(16);
        const nb = this.bones[this.iNeck];
        this.__neckAtReturn = `${nb.quaternion.x.toFixed(9)},${nb.quaternion.y.toFixed(9)},${nb.quaternion.w.toFixed(9)}`;
      };
    }
  }
  if (phys_?.createRagdollFromSkeleton) {
    const orig = phys_.createRagdollFromSkeleton.bind(phys_);
    phys_.createRagdollFromSkeleton = (mesh, opts) => {
      const rd = orig(mesh, opts);
      if (rd) {
        let h = 0 >>> 0;
        const mix = (arr) => { if (arr) for (let i = 0; i < arr.length; i++) h = (h * 31 + ((arr[i] * 1e6) | 0)) >>> 0; };
        mix(rd.px); mix(rd.py); mix(rd.pz);
        mix(rd.qx); mix(rd.qy); mix(rd.qz);
        // Split creation-INPUT from pose-OUTPUT: if the victim's sim fields and
        // animator timelines match while the bones do not, the pose evaluation
        // reads something outside the snapshot; if the timelines already
        // differ, the divergence is upstream and older than this death.
        const a = opts?.actor;
        let bones = 0 >>> 0;
        let sim = '';
        if (a) {
          for (const b of (mesh?.skeleton?.bones ?? [])) {
            bones = (bones * 31 + ((b.quaternion.x * 1e6) | 0)) >>> 0;
            bones = (bones * 31 + ((b.quaternion.w * 1e6) | 0)) >>> 0;
          }
          const an = a.animator;
          sim = [
            a.position.x.toFixed(6), a.position.z.toFixed(6), a.yaw.toFixed(6),
            an?.phase?.toFixed(6), an?.blend?.toFixed(4), an?.state?.clip,
            an?.hitT?.toFixed(4), an?.recoilT?.toFixed(4),
            a.aimTarget.x.toFixed(4), a.aimWeight?.toFixed?.(4),
            `d3:${an?.__d3h}`, `foot:${an?.__footh}`,
          ].join('|');
        }
        rlog.push({
          tick: ctx.time.tick, actor: a?.id ?? -1, hash: h,
          bones: bones.toString(16), sim,
          n: rd.particleCount ?? (rd.px?.length ?? 0),
        });
      }
      return rd;
    };
  }

  const BTN = e.commands.BTN ?? { fire: 1 };
  // Constant, so every tick in both engines receives identical input. A command
  // that varied with the frame index would make this measure the harness.
  //
  // `--nofire` exists because the player's trigger has a KNOWN determinism
  // boundary: the first magazine runs dry at ~270 ticks and the reload is
  // completed by a VIEWMODEL CLIP EVENT — presentation, not in the snapshot, in
  // a different phase in every process. Holding fire past one magazine measures
  // that defect, not the engines.
  e.commands.override = { moveX: 0, moveY: 1, held: NOFIRE ? 0 : BTN.fire, edge: 0 };
  // A dump every 60 ticks. When two runs disagree at N, the FIRST differing
  // window is the diagnosis — `replay.mjs --trace` earned this pattern; at
  // cross-process scale a half-second window is enough to name the event
  // (a death, a reload, a grenade) without dumping 4,600 leaves per tick.
  const trail = [];
  const ai1 = ctx.peek('ai');
  // arm the aim log at span start only
  for (const ag of ai1?.agents ?? []) if (ag.animator) { ag.animator.__aimLog = null; ag.animator.__lookLog = null; }
  // Catch the post-update bone writer red-handed: hook the neck quaternion's
  // change callback on the first alive agent, and record the stack of the
  // first write that lands AFTER an.update has returned this tick.
  let mutStack = null;
  let hookedAgent = null;
  {
    const fa = (ai1?.agents ?? []).find((a) => a.alive);
    const an = fa?.animator;
    const nb = an?.bones?.[an.iNeck];
    if (nb && an) {
      hookedAgent = fa;
      const q = nb.quaternion;
      const orig = q._onChangeCallback;
      an.__inUpdate = false;
      an.__updateCalls = 0;
      const protoU2 = an.update; // the already-wrapped update
      an.update = function (dt, now) {
        this.__inUpdate = true;
        this.__updateCalls++;
        try { protoU2.call(this, dt, now); } finally { this.__inUpdate = false; }
      };
      an.__fires = 0;
      an.__firesOutside = 0;
      an.__hookedQ = q;
      q._onChangeCallback = function () {
        orig.call(this);
        an.__fires++;
        if (!an.__inUpdate) {
          an.__firesOutside++;
          if (!mutStack) mutStack = String(new Error('writer').stack).split('\n').slice(1, 6).join(' <- ');
        }
      };
      // CONTROL FOR THE TRAP ITSELF. The trap and the neck checkpoint contradict
      // each other (value moves, callback silent), so one of them is lying — and
      // an uninstrumented instrument cannot be told apart from a quiet subject.
      // Write the quaternion's own values back into it: a live hook MUST fire,
      // and the state is unchanged because the values are identical.
      q.set(q.x, q.y, q.z, q.w);
      an.__trapAlive = an.__fires > 0;
      an.__fires = 0;
      an.__firesOutside = 0;
      mutStack = null; // the control write is not the writer we are hunting
      an.__agentId = fa.id;
    }
  }
  const boneDump = (ag) => (ag?.mesh?.skeleton?.bones ?? [])
    .map((b, i) => `${i}:${b.quaternion.x.toFixed(9)},${b.quaternion.y.toFixed(9)},${b.quaternion.z.toFixed(9)},${b.quaternion.w.toFixed(9)}`)
    .join(' ');
  const early = [];
  const poseRow = () => {
    const rows = [];
    for (const ag of ai1?.agents ?? []) {
      if (!ag.alive) { rows.push(`a${ag.id}:dead`); continue; }
      let bh = 0 >>> 0, wh = 0 >>> 0;
      for (const b of ag.mesh?.skeleton?.bones ?? []) {
        bh = (bh * 31 + ((b.quaternion.x * 1e6) | 0)) >>> 0;
        bh = (bh * 31 + ((b.quaternion.w * 1e6) | 0)) >>> 0;
      }
      const hips = ag.mesh?.skeleton?.bones?.[0];
      if (hips) for (let i = 0; i < 16; i++) wh = (wh * 31 + ((hips.matrixWorld.elements[i] * 1e5) | 0)) >>> 0;
      rows.push(`a${ag.id}:d3=${ag.animator?.__d3h}:b=${bh.toString(16)}:w=${wh.toString(16)}`);
    }
    return rows.join(' ');
  };
  // Phase-slice tick 1: read the neck after every subsystem hook, so the
  // writer names its phase instead of being inferred from traps that disagree.
  const phaseLog = [];
  {
    const fa0 = (ai1?.agents ?? []).find((a) => a.alive);
    const an0 = fa0?.animator;
    const neckStr = () => {
      const nb = an0?.bones?.[an0.iNeck];
      return nb ? `${nb.quaternion.x.toFixed(9)},${nb.quaternion.y.toFixed(9)}` : '?';
    };
    const ALL = ['physics', 'match', 'world', 'weapons', 'player', 'ai', 'fx', 'render', 'audio', 'ui'];
    for (const id of ALL) {
      const sys = ctx.peek(id);
      if (!sys) continue;
      for (const hook of ['fixedUpdate', 'update', 'lateUpdate']) {
        if (typeof sys[hook] !== 'function') continue;
        const orig = sys[hook].bind(sys);
        sys[hook] = (...args) => {
          const r = orig(...args);
          if (phaseLog.__armed) phaseLog.push(`${id}.${hook}=${neckStr()}`);
          return r;
        };
      }
    }
    phaseLog.__armed = false;
  }

  // RDWATCH — per-tick corpse forensics, for the divergence that only appears
  // on some seeds. Hash every ragdoll's particles every tick, and count the
  // external impulses each receives, so the first differing tick can be read
  // against "did anything from OUTSIDE touch it that tick". A divergence on an
  // impulse tick indicts the impulse path; one on a quiet tick indicts the
  // solver's own arithmetic.
  const rdwatch = [];
  if (RDWATCH && phys_) {
    const RD = Object.getPrototypeOf(phys_.ragdolls?.[0] ?? {});
    // The prototype may not exist yet (no corpse at span start); hook lazily
    // through the factory instead, counting on the wrapped createRagdoll above.
    const hookImpulse = (rd) => {
      if (rd.__impHooked) return;
      rd.__impHooked = true;
      rd.__imp = 0;
      const orig = rd.applyImpulse.bind(rd);
      rd.applyImpulse = (...a) => { rd.__imp++; return orig(...a); };
    };
    rdwatch.hook = hookImpulse;
    void RD;
  }
  const rdRow = () => {
    const rows = [];
    for (let r = 0; r < (phys_?.ragdolls?.length ?? 0); r++) {
      const rd = phys_.ragdolls[r];
      rdwatch.hook?.(rd);
      // BITS, not quantised values. The first version hashed `(x * 1e7) | 0`
      // and reported "births identical, first divergence on a quiet tick 60
      // later" — both of which a sub-quantum divergence at birth would fake:
      // a last-bit difference hides inside the quantum until the two values
      // straddle an integer boundary, and whichever tick that happens on looks
      // like the entry. The dump compares bit patterns for exactly this
      // reason; the per-tick probe has to match it or it is a different (and
      // worse) instrument.
      let h = 0x811c9dc5 >>> 0;
      const mixBits = (arr) => {
        const u = new Uint32Array(arr.buffer, arr.byteOffset, rd.particleCount * 2);
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
      };
      mixBits(rd.px);
      mixBits(rd.py);
      mixBits(rd.pz);
      const imp = rd.__imp ?? 0;
      if (rd.__imp !== undefined) rd.__imp = 0;
      rows.push(`${h.toString(16)}:${imp}${rd.sleeping ? ':s' : ''}`);
    }
    return rows.join(' ');
  };

  for (let i = 0; i < TICKS; i++) {
    phaseLog.__armed = i === 0;
    tick1();
    phaseLog.__armed = false;
    if (RDWATCH) rdwatch.push([ctx.time.tick, rdRow()]);
    if (i < 2) {
      const fa = (ai1?.agents ?? []).find((a) => a.alive);
      const nb = fa?.animator?.bones?.[fa.animator.iNeck];
      const anx = fa?.animator;
      early.push({
        fires: anx?.__fires, firesOutside: anx?.__firesOutside,
        sameQ: anx ? (nb?.quaternion === anx.__hookedQ) : null,
        // Which probe is lying? These three fields decide it:
        //   trapAlive   false  -> the hook is detached; `fires: 0` proves nothing.
        //   sameAgent   false  -> the victim died and `find(alive)` handed the
        //                         checkpoint a DIFFERENT bot than the one hooked,
        //                         so `neckAtReturn` and `neckAtTickEnd` are two
        //                         different bodies and the "mutation" is an artifact.
        //   updateCalls 0      -> `neckAtReturn` is a STALE string from an earlier
        //                         tick (the animator was skipped), so comparing it
        //                         against a live read cannot show a post-update write.
        trapAlive: hookedAgent?.animator?.__trapAlive ?? null,
        sameAgent: hookedAgent ? fa === hookedAgent : null,
        hookedId: hookedAgent?.id ?? null,
        hookedAlive: hookedAgent?.alive ?? null,
        faId: fa?.id ?? null,
        updateCalls: hookedAgent?.animator?.__updateCalls ?? null,
        tick: ctx.time.tick, bones: boneDump(fa),
        aim: fa?.animator?.__aimLog ?? '(no aim yet)',
        look: fa?.animator?.__lookLog ?? '(no look yet)',
        neckAtReturn: fa?.animator?.__neckAtReturn ?? '?',
        neckAtTickEnd: nb ? `${nb.quaternion.x.toFixed(9)},${nb.quaternion.y.toFixed(9)},${nb.quaternion.w.toFixed(9)}` : '?',
      });
    }
    if ((i + 1) % 60 === 0) trail.push({ tick: ctx.time.tick, dump: dump(), pose: poseRow() });
  }
  e.commands.override = null;

  // Span TOTALS for the hooked rig. `early` only samples the first two ticks,
  // which cannot tell "the animator had not come round yet" from "the animator
  // never runs in a stepped span at all" — and those two imply opposite fixes.
  const hookedEnd = hookedAgent?.animator
    ? {
        updateCalls: hookedAgent.animator.__updateCalls,
        fires: hookedAgent.animator.__fires,
        firesOutside: hookedAgent.animator.__firesOutside,
        alive: hookedAgent.alive,
        sameQ: hookedAgent.animator.bones?.[hookedAgent.animator.iNeck]?.quaternion === hookedAgent.animator.__hookedQ,
      }
    : null;

  return {
    startTick, warmed, hookedEnd,
    liveTick: ctx.time.tick,
    boot, start, snapshot, trail, rlog, early, mutStack, phaseLog: [...phaseLog],
    rdwatch: RDWATCH ? rdwatch.map((r) => r) : null,
    stepped: dump(),
    ua: navigator.userAgent,
  };
};

// The reference engine runs TWICE. The second run is the CONTROL: same engine,
// same injected state, different process. It must land on the same numbers, and
// if it does not then nothing this tool says about a DIFFERENT engine is
// attributable to the engine. Discipline 1 of the handoff, in the direction
// people forget: a difference is only a finding once the control shows none.
const PLAN = [ENGINES[0], `${ENGINES[0]}#control`, ...ENGINES.slice(1)];

const results = [];
let inject = null;
for (const label of PLAN) {
  const name = label.replace('#control', '');
  const browser = await LAUNCHERS[name].launch({
    args: name === 'chromium'
      ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
      : [],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let out;
  try {
    // `seed` pins the world and `lockstep=1` pins the boot.
    //
    // BOTH ENGINES GET THE SAME ONES, which is the point: this file's own header
    // records "BOOT IS NOT REPRODUCIBLE ACROSS ENGINES — ~150 leaves differ
    // before a single driven tick, including bot spawn positions by 1.6 m",
    // diagnosed as `__READY__` waiting on three rAF frames that arrive at
    // different wall-clock times, so the free-running boot consumes `ai.rng` a
    // different number of times. That diagnosis was right about the mechanism
    // and incomplete about the cause: `Engine` also drew its master seed from
    // `Math.random()`, so the two processes were not merely out of phase, they
    // were building different worlds. `?seed=` and `?lockstep=1` (both split out
    // of capture mode, which suppresses `ai.populate`) remove each half.
    //
    // What this cannot fix is engine-dependent arithmetic during the bake — see
    // THE LEVEL BAKE IS ENGINE-DEPENDENT below, which is a different finding and
    // survives a pinned seed by construction.
    await page.goto(
      `http://127.0.0.1:${PORT}/?prewarm=0&lockstep=1&seed=${SEED}`,
      { waitUntil: 'load' }
    );
    await waitForReady(page, { name: 'CROSSENGINE' });
    out = await page.evaluate(PROBE, { TICKS, INJECT: inject, NOFIRE: !!args.nofire, RDWATCH: !!args.rdwatch });
    if (!out?.fatal && out?.snapshot) inject = out.snapshot;
  } catch (err) {
    out = { fatal: `${name}: ${String(err?.message ?? err).split('\n')[0]}` };
  }
  await browser.close();
  results.push({ name: label, engine: name, out, errors });
}

if (!args.keep) killServer(vite);

/* ====================================================================== */
/*  Report                                                                */
/* ====================================================================== */

console.log(`\nCROSSENGINE — ${TICKS} fixed steps, same constant command, ${ENGINES.join(' vs ')}`);

const fail = [];
for (const r of results) {
  if (r.out?.fatal) fail.push(`${r.name}: ${r.out.fatal}`);
  if (r.errors?.length) fail.push(`${r.name} page error: ${r.errors[0]}`);
}
if (fail.length) {
  console.log(`\nCROSSENGINE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

const base = results[0];
console.log(`  reference: ${base.name}, ${base.out.boot.length} leaves captured`);
for (const r of results) {
  console.log(`    ${r.name.padEnd(9)} live at tick ${r.out.liveTick} (warmed ${r.out.warmed})`);
}

/**
 * `--ignore=ai.cover` — drop a subtree from every comparison.
 *
 * Earns its place immediately: `ai.cover.points` is a different LENGTH on the
 * two engines (364 vs 360), because the cover map is baked from the level and
 * the bake is itself engine-dependent. `restoreState` writes the values it is
 * given but does not resize the array, so injection cannot paper over it.
 *
 * That is a finding, not an obstacle to route around — but it is a finding
 * about CONSTRUCTION, and it would otherwise mask the separate question of
 * whether the STEP LOOP agrees once both engines hold the same state. A shared
 * bake shipped from a server is a plausible design; a step loop that cannot
 * agree is not.
 */
const IGNORE = String(args.ignore ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ignored = (k) => IGNORE.some((p) => k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`));

const diff = (a, b) => {
  const ma = new Map(a.filter(([k]) => !ignored(k)));
  const mb = new Map(b.filter(([k]) => !ignored(k)));
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const rows = [];
  let n = 0;
  for (const k of keys) {
    const va = ma.get(k), vb = mb.get(k);
    if (va === vb) continue;
    n++;
    if (rows.length < ROWS) rows.push({ path: k, a: va ?? '<absent>', b: vb ?? '<absent>' });
  }
  return { count: n, rows, total: keys.size };
};

let verdict = 'IDENTICAL';
let controlNoise = null;
for (const r of results) {
  if (r === base) continue;

  // Three questions kept apart, because conflating any two would send the next
  // session to the wrong file.
  //
  //   boot    construction, before injection. Expected to differ — booting is
  //           not reproducible across engines (see PROBE). Reported only.
  //   start   after injection. This is the VALIDITY GUARD: if the two engines
  //           do not begin the span from the same state, nothing below means
  //           anything, and a green would be the loudest possible false pass.
  //   stepped the answer. Same state in, same commands, same tick count.
  const b = diff(base.out.boot, r.out.boot);
  const st = diff(base.out.start, r.out.start);
  const s = diff(base.out.stepped, r.out.stepped);

  console.log(`\n  ${base.name} vs ${r.name}`);
  console.log(`    boot (pre-inject)  ${b.count === 0 ? 'identical' : `${b.count}/${b.total} differ — expected, not the verdict`}`);
  console.log(`    start (injected)   ${st.count === 0 ? 'identical' : `${st.count}/${st.total} DIFFER`}`);
  console.log(`    stepped            ${s.count === 0 ? 'identical' : `${s.count}/${s.total} leaves differ`}`);

  if (st.count) {
    for (const row of st.rows) {
      console.log(`      start ${row.path}\n        ${base.name.padEnd(9)} ${row.a}\n        ${r.name.padEnd(9)} ${row.b}`);
    }
    fail.push(`the injected state did not take on ${r.name} (${st.count} leaves) — the span did not start from the same world, so its result is meaningless`);
    verdict = 'INCONCLUSIVE';
    continue;
  }

  for (const row of s.rows) {
    console.log(`      stepped ${row.path}\n        ${base.name.padEnd(16)} ${row.a}\n        ${r.name.padEnd(16)} ${row.b}`);
  }

  if (base.out.early && r.out.early) {
    for (let i = 0; i < Math.min(base.out.early.length, r.out.early.length); i++) {
      const ea = base.out.early[i], eb = r.out.early[i];
      if (ea.bones === eb.bones) continue;
      const ba = ea.bones.split(' '), bb = eb.bones.split(' ');
      const bad = ba.map((x, k) => (x !== bb[k] ? k : -1)).filter((k) => k >= 0);
      console.log(`    first alive agent's bones differ at tick ${ea.tick} (span tick ${i + 1}): bones [${bad.join(',')}]`);
      console.log(`      first _aimIk inputs ${ea.aim === eb.aim ? 'IDENTICAL — the solver output differs on equal inputs' : 'DIFFER:'}`);
      if (ea.aim !== eb.aim) { console.log(`        ${base.name.padEnd(16)} ${ea.aim}`); console.log(`        ${r.name.padEnd(16)} ${eb.aim}`); }
      console.log(`      first _lookAt inputs ${ea.look === eb.look ? 'IDENTICAL' : 'DIFFER:'}`);
      if (base.out.phaseLog && r.out.phaseLog) {
        const pa = base.out.phaseLog, pb = r.out.phaseLog;
        for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
          if (pa[k] !== pb[k]) {
            console.log(`      tick-1 phase where the neck first differs across processes:`);
            console.log(`        ${base.name.padEnd(16)} ${pa[k]}`);
            console.log(`        ${r.name.padEnd(16)} ${pb[k]}`);
            console.log(`        previous phase   ${pa[k - 1] ?? '(start)'} — still equal there`);
            break;
          }
        }
      }
      if (base.out.mutStack) console.log(`      post-update writer (${base.name}): ${base.out.mutStack}`);
      console.log(`      callback fires ${ea.fires}/${eb.fires} · outside update ${ea.firesOutside}/${eb.firesOutside} · same quaternion object ${ea.sameQ}/${eb.sameQ}`);
      // Read the instrument before reading what it measured.
      console.log(`      PROBE SELF-CHECK  trap alive ${ea.trapAlive}/${eb.trapAlive} · hooked agent a${ea.hookedId}(alive ${ea.hookedAlive})/a${eb.hookedId}(alive ${eb.hookedAlive}) · evaluated a${ea.faId}/a${eb.faId} · same agent ${ea.sameAgent}/${eb.sameAgent} · animator update calls ${ea.updateCalls}/${eb.updateCalls}`);
      if (ea.trapAlive === false || eb.trapAlive === false) console.log(`        VERDICT: the TRAP lies — the hook is detached, so 'fires: 0' says nothing about writes.`);
      else if (ea.sameAgent === false || eb.sameAgent === false) console.log(`        VERDICT: the CHECKPOINT lies — it evaluated a different bot than the one hooked; the 'mutation' compares two bodies.`);
      else if (ea.updateCalls === 0 || eb.updateCalls === 0) console.log(`        VERDICT: the CHECKPOINT lies — the animator never ran, so neckAtReturn is stale from an earlier tick.`);
      else if (ea.sameQ === false || eb.sameQ === false) console.log(`        VERDICT: the bone's quaternion OBJECT was replaced — the writer swaps the instance, it does not mutate it.`);
      else console.log(`        VERDICT: both probes hold — a write reached the hooked quaternion without firing its callback (direct _x/_y/_z/_w assignment, or the callback was replaced after we hooked it).`);
      const ha = base.out.hookedEnd, hb = r.out.hookedEnd;
      if (ha && hb) {
        console.log(`      OVER THE WHOLE SPAN  animator update calls ${ha.updateCalls}/${hb.updateCalls} · neck writes ${ha.fires}/${hb.fires} (outside update ${ha.firesOutside}/${hb.firesOutside}) · still alive ${ha.alive}/${hb.alive} · same quaternion ${ha.sameQ}/${hb.sameQ}`);
        if (ha.fires === 0 && hb.fires === 0) console.log(`        -> NOTHING wrote this neck all span, yet the bones differ from span tick 1: the pose divergence is INHERITED across injection, not produced by the step loop. The snapshot does not carry pose.`);
      }
      const mutA = ea.neckAtReturn !== ea.neckAtTickEnd, mutB = eb.neckAtReturn !== eb.neckAtTickEnd;
      console.log(`      neck at update-return ${ea.neckAtReturn === eb.neckAtReturn ? 'IDENTICAL across processes' : 'DIFFERS across processes'} · mutated after return: ${base.name}=${mutA} ${r.name}=${mutB}`);
      if (ea.neckAtReturn !== eb.neckAtReturn) { console.log(`        ${base.name.padEnd(16)} ${ea.neckAtReturn}`); console.log(`        ${r.name.padEnd(16)} ${eb.neckAtReturn}`); }
      if (ea.look !== eb.look) { console.log(`        ${base.name.padEnd(16)} ${ea.look}`); console.log(`        ${r.name.padEnd(16)} ${eb.look}`); }
      for (const k of bad.slice(0, 3)) console.log(`      bone ${k}\n        ${base.name.padEnd(16)} ${ba[k]}\n        ${r.name.padEnd(16)} ${bb[k]}`);
      break;
    }
  }
  if (base.out.rdwatch && r.out.rdwatch) {
    // Per-tick corpse forensics. Each row is `hash:impulsesThisTick[:s]` per
    // ragdoll; the first tick the hashes part, read against the impulse count
    // ON that tick, splits "something from outside touched it" from "the
    // solver's own arithmetic diverged on a quiet fall".
    const rb = new Map(base.out.rdwatch);
    let hit = null;
    for (const [t, row] of r.out.rdwatch) {
      const b = rb.get(t);
      if (b === undefined) continue;
      if (b !== row) { hit = { t, a: b, b: row }; break; }
    }
    if (!hit) {
      console.log(`    rdwatch: every ragdoll hash matches on every tick`);
    } else {
      const da = hit.a.split(' ');
      const db = hit.b.split(' ');
      const bad = da.map((x, k) => (x !== db[k] ? k : -1)).filter((k) => k >= 0);
      console.log(`    rdwatch: first differing tick ${hit.t} — ragdoll[${bad.join(',')}]`);
      for (const k of bad) {
        const [, impA] = da[k].split(':');
        const [, impB] = db[k].split(':');
        console.log(`      ragdoll[${k}]  ${base.name.padEnd(10)} ${da[k]}   ${r.name.padEnd(10)} ${db[k]}`);
        console.log(`      impulses that tick: ${impA}/${impB} — ${impA !== '0' || impB !== '0' ? 'EXTERNAL TOUCH, indict the impulse path' : 'quiet fall, indict the solver arithmetic'}`);
      }
      // context: the surrounding births, to place the tick against a death
      const births = (base.out.rlog ?? []).map((x) => `t${x.tick}·a${x.actor}`).join(' ');
      if (births) console.log(`      births: ${births}`);
    }
  }
  if (base.out.rlog?.length || r.out.rlog?.length) {
    const la = base.out.rlog ?? [], lb = r.out.rlog ?? [];
    const short = (l) => l.map((x) => `t${x.tick}·a${x.actor}·${x.hash.toString(16)}`).join('  ');
    if (short(la) !== short(lb)) {
      console.log(`    ragdoll births differ:`);
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        const x = la[i], y = lb[i];
        if (!x || !y) { console.log(`      #${i}: ${x ? 'only ' + base.name : 'only ' + r.name}`); continue; }
        if (x.hash === y.hash) continue;
        console.log(`      #${i} t${x.tick}/t${y.tick} actor ${x.actor}/${y.actor}`);
        console.log(`        bones  ${x.bones} vs ${y.bones}  ${x.bones === y.bones ? '(SAME — divergence is in ragdoll construction itself)' : '(differ — the pose differs)'}`);
        console.log(`        sim    ${x.sim === y.sim ? 'identical — evaluation reads outside the snapshot' : 'DIFFER — upstream, older than this death:'}`);
        if (x.sim !== y.sim) { console.log(`          ${base.name}: ${x.sim}`); console.log(`          ${r.name}: ${y.sim}`); }
      }
    } else {
      console.log(`    ragdoll births identical: ${short(la) || '(none)'}`);
    }
  } else {
    // Silence is not coverage. A span nobody died in says NOTHING about the
    // death path — the original home of this tool's control noise — and a
    // reader who sees "identical" with no death line would credit the span
    // with more than it measured.
    console.log(`    no ragdoll births in the span — the death path was NOT exercised`);
  }
  if (s.count && base.out.trail && r.out.trail) {
    for (let i = 0; i < Math.min(base.out.trail.length, r.out.trail.length); i++) {
      const ta = base.out.trail[i], tb = r.out.trail[i];
      if (ta.pose !== tb.pose) {
        const ra = ta.pose.split(' '), rb = tb.pose.split(' ');
        const bad = ra.map((x, k) => (x !== rb[k] ? `${x} vs ${rb[k]}` : null)).filter(Boolean);
        console.log(`    pose trail first differs at window tick ${ta.tick}:`);
        for (const line of bad.slice(0, 3)) console.log(`      ${line}`);
      }
      const w = diff(ta.dump, tb.dump);
      if (ta.pose !== tb.pose && !w.count) { console.log(`      (all captured sim leaves still identical in this window)`); break; }
      if (w.count) {
        console.log(`    first differing window: tick ${r.out.trail[i].tick} (${(i + 1) * 60} ticks in) — ${w.count} leaves`);
        for (const row of w.rows.slice(0, 6)) console.log(`      ${row.path}`);
        break;
      }
    }
  }

  if (r.name.endsWith('#control')) {
    controlNoise = s.count;
    if (s.count) {
      console.log(`\n    THE CONTROL IS NOT CLEAN. Two processes of the SAME engine, handed the`);
      console.log(`    same state and the same commands, land on ${s.count} different leaves. Whatever`);
      console.log(`    another engine does cannot be attributed to the engine until this is 0.`);
    }
    continue;
  }
  if (s.count) verdict = 'DIVERGES';
}

if (fail.length) {
  console.log(`\nCROSSENGINE INCONCLUSIVE:\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

if (controlNoise) {
  console.log(`\n  INCONCLUSIVE. The control diverges by ${controlNoise} leaves on its own, so the`);
  console.log(`  cross-engine number is an upper bound on noise + signal and separates neither.`);
  console.log(`  Fix that first: state the snapshot does not carry (animator pose, and the`);
  console.log(`  hitboxes posed from it — see tools/perceive.mjs) is steering the simulation.`);
  verdict = 'INCONCLUSIVE';
} else {
  console.log(`\n  ${verdict === 'IDENTICAL'
    ? 'Engines agree bit for bit. A command-only (deterministic) netcode is on the table.'
    : 'Engines disagree. Lockstep/rollback across heterogeneous clients is NOT available;\n  a server-authoritative model that replicates STATE is the remaining option.'}`);
}

/**
 * Exit 0 by default; `--gate` turns the verdict into a pass/fail.
 *
 * This file used to exit 0 unconditionally, and the reason was right at the
 * time: the engines DIVERGED. A red would have meant "pick the other
 * architecture", and a permanent red for a fact nobody intends to change is a
 * gate everybody learns to skip.
 *
 * THAT PREMISE INVERTED, and the header records how. Five generations of
 * substitution — `hypot` respelt as sqrt-of-squares, fdlibm `atan2`, then
 * `dsin`/`dcos`/`dexp`/`dlog`/`dpow`/`dtan`, then `dquatFromEuler` over the six
 * three.js internals that run trig, then the root yaw — bought bit-identity
 * across V8, SpiderMonkey and JavaScriptCore. IDENTICAL is the state the code
 * is in now, and it was expensive. The way to lose it is one `Math.sin`
 * reintroduced on a simulation path, which no other gate in the suite can see:
 * `determinism` compares a build to itself on one engine, so it stays green
 * through a change that makes two engines disagree.
 *
 * So under `--gate` anything but IDENTICAL is a regression, INCONCLUSIVE
 * included — a control that is not clean means the number measured noise plus
 * signal and separated neither, which is not evidence that the engines agree.
 *
 * The default stays reported-not-gated so that exploratory runs, new-engine
 * spikes and `--ticks` sweeps still answer the design question without failing.
 */
console.log(`\nCROSSENGINE ${verdict}${args.gate ? '' : ' (reported, not gated)'}`);
if (args.gate && verdict !== 'IDENTICAL') process.exit(1);
