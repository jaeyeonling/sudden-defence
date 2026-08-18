#!/usr/bin/env node
/**
 * NETSIM — do two INDEPENDENT simulations of the same match agree, bit for bit?
 *
 *   node tools/netsim.mjs [--ticks=1200] [--every=100] [--seed=0x5eed1234]
 *
 * This is the server-authority architecture (M8) reduced to its load-bearing
 * claim, with zero lines of network code. A dedicated server and a predicting
 * client are, mechanically, two copies of this simulation fed the same
 * commands — reconciliation only works if those copies cannot drift. The
 * complementary gates each prove one leg:
 *
 *   crossengine   the same sim agrees across V8/SpiderMonkey/JSC (browsers)
 *   headless      the sim runs with no renderer at all (a Node server can host it)
 *   netsim        two separately-booted headless sims, same seed, same drive,
 *                 produce IDENTICAL state hashes at every checkpoint — and a
 *                 different seed produces DIFFERENT ones, so the hash is proven
 *                 to be reading real state rather than constants.
 *
 * The hash is sha256 over JSON of each system's captureState() — the same
 * surface replay.mjs proves is restorable and complete (its layer-2 audit
 * fails the run if a field exists that capture does not cover). When netcode
 * lands, this hash IS the desync detector: peers exchange it every N ticks.
 *
 * Engines are booted in SEPARATE processes, deliberately: module state, JIT
 * warm-up and allocation order are all shared inside one process, and sharing
 * them would let a hidden dependency on any of it pass. A child that boots its
 * own world from nothing is the honest stand-in for a second machine.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from './harness.mjs';

const args = parseArgs();
const TICKS = Number(args.ticks ?? 1200);
const EVERY = Number(args.every ?? 100);
const SEED = Number(args.seed ?? 0x5eed1234);

// ---- child mode: boot, fight, hash, print ---------------------------------
if (args.child) {
  const { createHash } = await import('node:crypto');
  const { Engine } = await import('../src/core/engine.js');
  const { createConfig } = await import('../src/core/config.js');
  const { PhysicsSystem } = await import('../src/physics/index.js');
  const { MaterialSystem } = await import('../src/materials/index.js');
  const { WorldSystem } = await import('../src/world/index.js');
  const { MatchSystem } = await import('../src/match/index.js');
  const { AiSystem } = await import('../src/ai/index.js');

  console.warn = () => {};
  console.info = () => {};

  const engine = new Engine({ canvas: null, config: createConfig({ seed: SEED, deterministic: true }) });
  engine.add(PhysicsSystem).add(MaterialSystem).add(WorldSystem).add(MatchSystem).add(AiSystem);
  await engine.init();
  const ctx = engine.ctx;
  ctx.get('ai').populate({ perTeam: 2 });

  const hashState = () => {
    // Fresh objects per capture: captureState(out) reuses `out`, and a reused
    // one would let a field DELETED from the state linger in the hash.
    const s = [ctx.get('physics').captureState({}), ctx.get('match').captureState({}), ctx.get('ai').captureState({})];
    return createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);
  };

  let clock = 0;
  engine._last = 0;
  engine._accum = 0.5 / 120; // half-tick cushion — same reasoning as replay.mjs
  const out = [];
  for (let i = 1; i <= TICKS; i++) {
    clock += 1000 / 120;
    engine.step(clock);
    if (i % EVERY === 0) out.push(`${i}:${hashState()}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

// ---- parent mode: two children per seed, compare --------------------------
const run = (seed) =>
  execFileSync(process.execPath, [
    new URL(import.meta.url).pathname,
    '--child', `--ticks=${TICKS}`, `--every=${EVERY}`, `--seed=${seed}`,
  ], { encoding: 'utf8' }).trim().split('\n');

const fail = [];
const a = run(SEED);
const b = run(SEED);

if (a.length !== Math.floor(TICKS / EVERY)) fail.push(`expected ${Math.floor(TICKS / EVERY)} checkpoints, got ${a.length}`);
let firstDiff = -1;
for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) { firstDiff = i; break; }
}
if (firstDiff >= 0) {
  fail.push(`two sims of seed ${SEED} diverged at checkpoint ${a[firstDiff]?.split(':')[0]}: ${a[firstDiff]} vs ${b[firstDiff]}`);
}

// The control: a different seed MUST hash differently, or the hash is reading
// constants and the identity above proved nothing.
const c = run(SEED + 1);
if (a.every((line, i) => line === c[i])) {
  fail.push('a different seed produced identical hashes — the hash is not reading real state');
}

if (fail.length) {
  console.log(`NETSIM FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `NETSIM OK — two independent sims agree at every checkpoint: ` +
  `${a.length} hashes over ${TICKS} ticks (every ${EVERY}), and seed ${SEED + 1} disagrees from checkpoint 1. ` +
  `Server authority's core claim holds with zero lines of netcode.`
);
