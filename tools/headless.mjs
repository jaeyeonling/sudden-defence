#!/usr/bin/env node
/**
 * HEADLESS — can the simulation boot and step without a renderer?
 *
 *   node tools/headless.mjs [--ticks=600]
 *
 * THIS IS THE QUESTION THAT PICKS THE OTHER NETCODE.
 *
 * `tools/crossengine.mjs` answered whether a deterministic architecture is
 * AVAILABLE — peers exchange commands and each re-simulates. It is. This asks
 * the complementary question, the one a server-authoritative design turns on:
 * can the simulation run somewhere that has no WebGL context, so a dedicated
 * server can hold the truth and clients replicate it?
 *
 * Neither answer forces the other. Lockstep needs determinism and does not care
 * about headless, because every peer is a browser with a renderer. Server
 * authority needs headless and does not care about determinism, because the
 * server never has to be reproduced. This project has the first; this measures
 * the second.
 *
 * WHAT IT ACTUALLY RUNS
 *
 * `physics`, `materials`, `world`, `match` and `ai` — the subsystems a server
 * needs to own a fight — with `render`, `sky`, `fx`, `audio`, `player`,
 * `weapons` and `ui` left out. No canvas, no `document`, no `window`.
 *
 * `materials` is included ON PURPOSE even though it is the one that wants a
 * renderer: `world` reaches it with `get`, so a server cannot skip it, and the
 * whole question is whether it degrades or dies. It reaches `render` with
 * `peek` and logs "no WebGLRenderer available yet — deferring texture bake", so
 * the prediction is that it degrades. A prediction is not a result.
 *
 * `player` is out because a server has no local player; its commands arrive on
 * the wire through `commands.override`, which `core/command.js` calls "the seam
 * a server plugs into".
 *
 * WHAT A RED MEANS
 *
 * Not that the game is broken — it means server authority costs whatever the
 * failure names, and the number belongs in that decision rather than in a bug
 * tracker. A subsystem that dies on a missing renderer is a real cost; one that
 * merely logs and carries on is not.
 */
import { Engine } from '../src/core/engine.js';
import { createConfig } from '../src/core/config.js';
import { PhysicsSystem } from '../src/physics/index.js';
import { MaterialSystem } from '../src/materials/index.js';
import { WorldSystem } from '../src/world/index.js';
import { MatchSystem } from '../src/match/index.js';
import { AiSystem } from '../src/ai/index.js';
import { parseArgs } from './harness.mjs';

const args = parseArgs();
const TICKS = Number(args.ticks ?? 600);

const notes = [];
const origWarn = console.warn;
const origInfo = console.info;
console.warn = (...a) => { notes.push('[warn] ' + a.join(' ')); };
console.info = (...a) => { notes.push('[info] ' + a.join(' ')); };

const fail = [];
let engine = null;

try {
  const config = createConfig({ seed: 0x5eed1234, deterministic: true });
  engine = new Engine({ canvas: null, config });
  engine.add(PhysicsSystem).add(MaterialSystem).add(WorldSystem).add(MatchSystem).add(AiSystem);
  await engine.init();
} catch (e) {
  console.warn = origWarn; console.info = origInfo;
  console.log(notes.join('\n'));
  console.log(`\nHEADLESS FAILED — init threw:\n  ${e.message}`);
  console.log(e.stack?.split('\n').slice(1, 6).join('\n') ?? '');
  process.exit(1);
}

console.warn = origWarn;
console.info = origInfo;

const ctx = engine.ctx;
const phys = ctx.peek('physics');
const world = ctx.peek('world');
const match = ctx.peek('match');
const ai = ctx.peek('ai');

if (!phys || !world || !match || !ai) fail.push('a subsystem did not come up');

// A world with no collision is a world nothing can stand on.
const tris = phys?.staticWorld?.triCount ?? 0;
if (!tris) fail.push('no static collision baked — the BVH has nothing to trace against');

// Bots, and then a fight. `populate` is what a server would call.
try {
  ai.populate({ perTeam: 2 });
} catch (e) {
  fail.push(`ai.populate threw: ${e.message}`);
}
const spawned = ai.agents?.length ?? 0;
if (spawned < 4) fail.push(`spawned ${spawned} bots, wanted 4`);

// Step the fixed clock by hand. No rAF, no frame loop.
let stepped = 0;
try {
  for (let i = 0; i < TICKS; i++) { engine.step(1 / 120); stepped++; }
} catch (e) {
  fail.push(`step ${stepped} threw: ${e.message}`);
}

const alive = ai.agents?.filter((a) => a.alive).length ?? 0;
const moved = ai.agents?.some((a) => a.position && (a.position.x !== 0 || a.position.z !== 0)) ?? false;
if (stepped === TICKS && !moved) fail.push('nobody moved in the whole span — the sim is not running');

const deferred = notes.filter((n) => /deferring texture bake/.test(n)).length;

console.log(`\nHEADLESS — no canvas, no renderer, ${TICKS} fixed steps`);
console.log(`  subsystems up      physics=${!!phys} materials=${!!ctx.peek('materials')} world=${!!world} match=${!!match} ai=${!!ai}`);
console.log(`  static collision   ${tris} tris`);
console.log(`  bots               ${spawned} spawned, ${alive} alive after ${stepped} ticks`);
console.log(`  texture bakes      ${deferred} deferred (a renderer would have run them)`);
if (notes.length) {
  console.log('\n  boot notes:');
  for (const n of notes.slice(0, 12)) console.log('    ' + n);
  if (notes.length > 12) console.log(`    … ${notes.length - 12} more`);
}

if (fail.length) {
  console.log(`\nHEADLESS FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log('\nHEADLESS OK — the simulation runs with no renderer. Server authority is'
  + ' available on the same evidence crossengine gives lockstep.');
