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

const SIM_IDS = ['physics', 'match', 'ai'];
const H = 1000 / 120;

// ---- child mode: boot, fight, hash, print ---------------------------------
if (args.child) {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { stringifyState, parseState } = await import('../src/core/wire.js');
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
    // one would let a field DELETED from the state linger in the hash. Hashed
    // over the WIRE encoding, so a value the wire cannot carry (bare
    // JSON.stringify turns Infinity into null) shows up as a hash difference
    // instead of hiding inside a lossy identity.
    const s = SIM_IDS.map((id) => ctx.get(id).captureState({}));
    return createHash('sha256').update(stringifyState(s)).digest('hex').slice(0, 16);
  };

  let clock = 0;
  engine._last = 0;
  engine._accum = 0.5 / 120; // half-tick cushion — same reasoning as replay.mjs

  // SINK: adopt a source's serialized world before stepping. The payload came
  // through JSON — the wire — so anything the format mangles (typed arrays,
  // class instances, NaN) diverges the hashes and fails the gate honestly.
  //
  // THE CLOCK IS PART OF THE HANDOFF, exactly as replay.mjs documents for the
  // rewind: dt is derived from (now - _last), so the sink must continue the
  // source's clock or the dt doubles round differently and everything
  // downstream of `round.remaining` drifts.
  if (args.handoff) {
    const p = parseState(readFileSync(String(args.handoff), 'utf8'));
    for (const id of SIM_IDS) ctx.get(id).restoreState(p.blob[id]);
    ctx.time.tick = p.time.tick;
    ctx.time.elapsed = p.time.elapsed;
    ctx.time.raw = p.time.raw;
    ctx.time.frame = p.time.frame;
    clock = p.clock;
    engine._last = p.engine.last;
    engine._accum = p.engine.accum;
  }

  const HANDOFF_AT = Number(args.handoffAt ?? 0);
  const out = [];
  for (let i = 1; i <= TICKS; i++) {
    clock += H;
    engine.step(clock);
    // Checkpoints key on the ABSOLUTE tick, so a sink that adopted a handoff
    // mid-match prints lines a source's post-handoff lines compare against
    // directly — same tick, same hash, or the gate says where they parted.
    if ((ctx.time.tick + 1) % EVERY === 0) out.push(`${ctx.time.tick}:${hashState()}`);

    // Desync forensics: dump the FULL state at one tick so a parent (or a
    // human chasing a real desync later) can diff leaves instead of hashes.
    if (args.dumpAt && ctx.time.tick === Number(args.dumpAt)) {
      out.push('DUMP ' + stringifyState(SIM_IDS.map((id) => ctx.get(id).captureState({}))));
    }

    // SOURCE: serialize the world mid-run for a sink to adopt, clock included.
    if (args.emitHandoff && i === HANDOFF_AT) {
      const blob = {};
      for (const id of SIM_IDS) blob[id] = ctx.get(id).captureState({});
      out.push('HANDOFF ' + stringifyState({
        blob,
        time: { tick: ctx.time.tick, elapsed: ctx.time.elapsed, raw: ctx.time.raw, frame: ctx.time.frame },
        engine: { last: engine._last, accum: engine._accum },
        clock,
      }));
    }
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

// ---- parent mode: two children per seed, compare --------------------------
const run = (seed, extra = []) =>
  execFileSync(process.execPath, [
    new URL(import.meta.url).pathname,
    '--child', `--ticks=${TICKS}`, `--every=${EVERY}`, `--seed=${seed}`, ...extra,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');

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

/* ---- phase B: the handoff — join-in-progress with JSON as the wire ------- */
//
// A source sim runs K ticks and serializes its world; a FRESHLY BOOTED sink —
// separate process, its own init, its own allocations — adopts the payload
// and both run M more ticks. Identical hashes mean a server snapshot can
// bring a joining client (or a mispredicted one) to the server's exact state
// through a JSON wire, which is the reconciliation primitive of M8.4 proven
// before any socket exists.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const K = Number(args.k ?? 480);
const M = Number(args.m ?? 600);

const srcOut = run(SEED, [`--ticks=${K + M}`, '--emitHandoff', `--handoffAt=${K}`, `--every=${EVERY}`]);
const handoffLine = srcOut.find((l) => l.startsWith('HANDOFF '));
const srcHashes = srcOut.filter((l) => !l.startsWith('HANDOFF ') && Number(l.split(':')[0]) >= K);

if (!handoffLine) {
  fail.push('phase B: the source emitted no handoff');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'netsim-'));
  const file = join(dir, 'handoff.json');
  writeFileSync(file, handoffLine.slice('HANDOFF '.length));
  const sinkHashes = run(SEED, [`--ticks=${M}`, `--handoff=${file}`]);
  rmSync(dir, { recursive: true, force: true });

  if (!sinkHashes.length || sinkHashes.length !== srcHashes.length) {
    fail.push(`phase B: source made ${srcHashes.length} post-handoff checkpoints, sink made ${sinkHashes.length}`);
  }
  for (let i = 0; i < Math.min(srcHashes.length, sinkHashes.length); i++) {
    if (srcHashes[i] !== sinkHashes[i]) {
      fail.push(`phase B: source and sink diverged at checkpoint ${srcHashes[i]?.split(':')[0]}: ${srcHashes[i]} vs ${sinkHashes[i]}`);
      break;
    }
  }
}

if (fail.length) {
  console.log(`NETSIM FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `NETSIM OK — two independent sims agree at every checkpoint ` +
  `(${a.length} hashes over ${TICKS} ticks, every ${EVERY}; seed ${SEED + 1} disagrees from checkpoint 1), ` +
  `and a fresh process adopting a JSON handoff at tick ${K} tracks the source bit for bit for ${M} more. ` +
  `Server authority's core claims hold with zero lines of netcode.`
);
