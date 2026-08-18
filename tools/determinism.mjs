#!/usr/bin/env node
/**
 * DETERMINISM — capture the whole shot set twice and require the two runs to be
 * byte-identical.
 *
 * WHAT THIS GATES, and why it is not the same thing as a visual-regression test.
 *
 * A golden-image test asks "does the game still look the way it looked last
 * week", and answering it means committing reference PNGs. This asks the
 * narrower question the project's own hard rules are built on: "does the game
 * render the same thing twice". That is the invariant every capture-based tool
 * here depends on — `tools/baseline.mjs`, `tools/imagediff.mjs` and the whole
 * A/B method in `tools/abperf.mjs` are worthless the moment two runs of the same
 * build disagree — and it needs no stored artefacts at all, which is why it can
 * live in `npm test` while `shots/` stays a 292 MB gitignored scratch directory.
 *
 * It is a real gate, not a tautology. The rules it enforces have all been broken
 * in this codebase and each break was invisible until something measured it:
 *
 *   - `Math.random()` in a visual (hard rule 3). `core/engine.js` seeds `ctx.rng`
 *     from it unless capture mode is on, and the world's dressing pass forks that
 *     rng: two loads dressed the same props with different materials, which is
 *     how `tools/markings.mjs` came to read a hazard-bar contrast of 0.04 on one
 *     run and 0.22 on the next.
 *   - A CSS transition or keyframe in the HUD (`ui/index.js` forbids them),
 *     which runs on wall-clock time and lands somewhere different on a pumped
 *     frame depending on how fast the machine is.
 *   - Anything settled by frame COUNT rather than simulated time, when the
 *     engine has a variable timestep — the defect `tools/markings.mjs` carries a
 *     long note about.
 *
 * Both passes run through `baseline.mjs`, so they inherit its isolation (a fresh
 * page per shot), its fixed frame budget and its temporal reset. Anything this
 * catches is therefore in the game, not in the harness.
 *
 *   node tools/determinism.mjs [--port=8080] [--keep]
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { parseArgs } from './harness.mjs';

const args = parseArgs();
const PORT = String(args.port ?? 8080);
const A = 'shots/determinism-a';
const B = 'shots/determinism-b';

const run = (cmd, argv) => new Promise((res) => {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => res({ code, out }));
});

for (const d of [A, B]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });

const passes = [];
for (const out of [A, B]) {
  const r = await run('node', ['tools/baseline.mjs', `--out=${out}`, `--port=${PORT}`]);
  passes.push(r);
  if (r.code !== 0) {
    console.error(`DETERMINISM FAILED — capture pass into ${out} exited ${r.code}`);
    console.error(r.out.split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
}

// tol=0. The point is byte-identity: a tolerance here would be a way to let the
// exact class of drift this exists to catch through, one pixel at a time.
const diff = await run('node', ['tools/imagediff.mjs', `--a=${A}`, `--b=${B}`, '--tol=0']);
// imagediff prints a JSON report; its last lines are braces, which say nothing.
// Count the shots directly instead of scraping them out of it.
const shots = readdirSync(A).filter((f) => f.endsWith('.png')).length;
const tail = diff.out.trim().split('\n').filter((l) => /differ|mismatch|maxDelta|pixels/i.test(l))
  .slice(0, 6).join('\n') || diff.out.trim().split('\n').slice(-3).join('\n');

if (!args.keep) for (const d of [A, B]) rmSync(d, { recursive: true, force: true });

if (diff.code !== 0) {
  console.error(`DETERMINISM FAILED — two runs of the same build differ\n${tail}`);
  process.exit(1);
}
console.log(`DETERMINISM OK — ${shots} shots, two capture passes byte-identical`);
