#!/usr/bin/env node
/**
 * PIXELGATE — did this commit change the picture, and did anyone mean it?
 *
 *   node tools/pixelgate.mjs            compare against the committed manifest
 *   node tools/pixelgate.mjs --accept   adopt the current picture as the manifest
 *
 * WHAT THIS ANSWERS THAT `determinism.mjs` DOES NOT
 *
 * `determinism` captures the shot set twice and requires the two passes to be
 * byte-identical. That proves the build is reproducible against ITSELF, in one
 * process, on one machine, in one minute. It cannot notice a change, because
 * both of its passes contain it. Two runs that are equally wrong pass.
 *
 * That is not hypothetical. `MATERIAL_SLOTS` had the `team` slot appended to a
 * list the builder emits second, from b1cdcc0 until the commit that added this
 * file. `buildSoldier` asserted the order and printed a warning on EVERY boot
 * for the whole of that span, 80.3 % of `boot.png` was wrong, and the suite was
 * green the entire time — because the only tool that compares against a STORED
 * picture (`baseline.mjs` + `imagediff.mjs`) was not wired to anything.
 *
 * So this gate carries the one piece of state the others cannot: what the
 * picture looked like at the last commit somebody looked at it.
 *
 * WHY HASHES AND NOT PNGs
 *
 * `.gitignore` says `shots/` is "780 MB of PNGs. Regenerate with
 * tools/baseline.mjs." Committing an 11-shot 1920x1080 baseline would be ~40 MB
 * per re-baseline, and re-baselining is a normal event. A SHA-256 per shot is
 * about a kilobyte and answers the question the gate exists to ask — WHICH shot
 * moved — while giving up the one it does not need to answer on the spot: where
 * inside the shot. For that, capture the previous commit and run `imagediff`:
 *
 *   git stash && node tools/baseline.mjs --out=shots/before && git stash pop
 *   node tools/baseline.mjs --out=shots/after
 *   node tools/imagediff.mjs --a=shots/before --b=shots/after --tol=0
 *
 * THIS GATE IS PINNED TO ONE MACHINE, ON PURPOSE
 *
 * A hash is a hash of pixels, and pixels come from a GPU. `baseline.mjs` runs
 * chromium on `--use-angle=metal`; the same build under SwiftShader on a Linux
 * runner produces a completely different, equally correct picture. A manifest
 * captured here would go red on every shot there, for no defect — which is the
 * failure mode that teaches people to ignore a gate, and ignoring a gate is
 * exactly what let the `MATERIAL_SLOTS` warning live for as long as it did.
 *
 * So the manifest records the environment it was taken in and this REFUSES to
 * compare across a mismatch rather than reporting a false red. It belongs on
 * the reference machine, beside `profile` and `determinism`, for the same
 * reason those two are there.
 *
 * WHY `--accept` IS A FLAG AND NOT A PROMPT
 *
 * Most picture changes are deliberate, so the manifest moves often. The point
 * is not to make that hard; it is to make it EXPLICIT and reviewable — the
 * manifest diff lands in the same commit as the change that caused it, and a
 * reviewer can see that the author knew. A gate that warns and exits 0 would be
 * the `MATERIAL_SLOTS` warning again, in a new file.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from './harness.mjs';

const args = parseArgs();

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'tools/pixelgate.json');
const OUT = 'shots/pixelgate';
// Its own port, not 8080. `profile.mjs` puts a `vite preview` (the BUILT bundle)
// there and `determinism.mjs` puts a `vite dev` there, and every harness here
// reuses an already-open port rather than spawning its own. Sharing 8080 would
// mean that if `profile` ever left its preview up, this would photograph the
// production bundle, hash it against a dev-server manifest, and report a
// difference that is about which server answered rather than about the code.
const PORT = String(args.port ?? 8081);
const ACCEPT = Boolean(args.accept);

/**
 * What has to match before two hash sets are comparable at all.
 *
 * `angle` is spelled out rather than derived because `baseline.mjs` hardcodes
 * `--use-angle=metal`: if that line ever grows a platform branch, this constant
 * has to be updated with it, and a stale value here is a caught mismatch rather
 * than a silent comparison of two different renderers.
 */
const env = () => ({
  platform: process.platform,
  arch: process.arch,
  angle: 'metal',
  capture: { q: 'ultra', size: '1920x1080', settle: 90 },
});

const run = (cmd, argv) => new Promise((res) => {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => res({ code, out }));
});

if (existsSync(join(ROOT, OUT))) rmSync(join(ROOT, OUT), { recursive: true, force: true });

const cap = await run('node', ['tools/baseline.mjs', `--out=${OUT}`, `--port=${PORT}`]);
if (cap.code !== 0) {
  console.error(`PIXELGATE FAILED — capture exited ${cap.code}`);
  console.error(cap.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}

const dir = join(ROOT, OUT);
const shots = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
    .map((f) => [f.replace(/\.png$/, ''), createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])
);
const count = Object.keys(shots).length;
if (!count) {
  console.error('PIXELGATE FAILED — the capture produced no shots.');
  process.exit(1);
}
if (!args.keep) rmSync(dir, { recursive: true, force: true });

const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;

if (ACCEPT) {
  const moved = prev
    ? Object.keys(shots).filter((k) => prev.shots?.[k] !== shots[k])
    : Object.keys(shots);
  writeFileSync(MANIFEST, `${JSON.stringify({ env: env(), shots }, null, 2)}\n`);
  console.log(
    `PIXELGATE ACCEPTED — ${count} shots recorded, ${moved.length} changed` +
    (moved.length ? `:\n  ${moved.join('\n  ')}` : '') +
    '\nCommit tools/pixelgate.json with the change that caused it.'
  );
  process.exit(0);
}

if (!prev) {
  console.error(
    'PIXELGATE FAILED — no manifest. Run `node tools/pixelgate.mjs --accept` once to record\n' +
    'the current picture, and commit tools/pixelgate.json.'
  );
  process.exit(1);
}

// A different renderer is not a regression, and calling it one would train
// everybody to skip the gate. Say so and stand down.
const a = JSON.stringify(prev.env), b = JSON.stringify(env());
if (a !== b) {
  console.log(
    'PIXELGATE SKIPPED — the manifest was captured in a different environment, so its\n' +
    'hashes describe a different renderer, not a different build.\n' +
    `  manifest: ${a}\n  here:     ${b}\n` +
    'This gate is pinned to the reference machine, like profile and determinism.'
  );
  process.exit(0);
}

const changed = Object.keys(shots).filter((k) => prev.shots[k] !== shots[k]);
const added = Object.keys(shots).filter((k) => !(k in prev.shots));
const gone = Object.keys(prev.shots).filter((k) => !(k in shots));

if (!changed.length && !added.length && !gone.length) {
  console.log(`PIXELGATE OK — ${count} shots identical to the manifest.`);
  process.exit(0);
}

console.log(
  `PIXELGATE FAILED — the picture moved and the manifest did not.\n` +
  [
    ...changed.map((s) => `  changed  ${s}`),
    ...added.map((s) => `  new      ${s}`),
    ...gone.map((s) => `  missing  ${s}`),
  ].join('\n') +
  '\n\nIf this was deliberate: `node tools/pixelgate.mjs --accept` and commit the manifest.\n' +
  'To see WHERE it moved, capture the previous commit and diff — see the header.'
);
process.exit(1);
