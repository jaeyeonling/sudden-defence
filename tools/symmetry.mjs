#!/usr/bin/env node
/**
 * Is the map actually fair?
 *
 * `warehouse.js` says it is "mirrored about Z so neither team gets a better
 * angle", and `reach.mjs` proves both teams can walk to each other. Neither of
 * those is fairness. Fairness is that the ground you fight over offers the same
 * angles to whoever approaches it from -Z as from +Z, and nothing in the build
 * checks that — the mirror is authored by hand, one `for (const s of [-1, 1])`
 * at a time, and every piece placed outside that loop is a piece that has to be
 * symmetric by luck.
 *
 * WHY THIS EXISTS
 *
 * Measured over 28 matchsim rounds, bravo took 22. Swapping only the `team`
 * labels on `SPAWNS` — no geometry touched — moved the win rate with the SIDE,
 * not with the team: alpha then took 7 of 8. So the advantage is positional, and
 * a positional advantage on a map advertised as mirrored is a bug in the map.
 *
 * WHAT IT MEASURES
 *
 * Not geometry — sightlines. Two rooms can hold the same volume of concrete and
 * play completely differently, and what actually decides a firefight is how far
 * you can see and be seen from where you are standing. So: a lattice over the
 * whole floor at eye height, a horizontal fan of rays from each point, and the
 * mean unobstructed distance as that point's `openness` in metres.
 *
 * Then every point is compared against its partner under the two symmetries the
 * map could plausibly claim:
 *
 *   mirror   (x, z) -> (x, -z)    what the file says it is
 *   rotation (x, z) -> (-x, -z)   what a mirrored map with hand-placed clutter
 *                                 tends to drift into, and equally fair
 *
 * A map that satisfies EITHER is fair. It is reported against both because
 * which one it is telling you where to look: a break under mirror but not under
 * rotation means the clutter is fine and something outside the mirror loop is
 * not, and vice versa.
 *
 *   node tools/symmetry.mjs
 *   node tools/symmetry.mjs --step=0.75 --rays=48
 */
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const STEP = Number(args.step ?? 1.0);
const RAYS = Number(args.rays ?? 32);
/**
 * How much openness difference between two partner points is a real asymmetry.
 *
 * The fan is quantised — a ray either clears a container edge or it does not —
 * so two genuinely symmetric points a hair either side of an edge can disagree
 * by a metre or so on one ray out of 32, which is a few centimetres of mean. 1.5
 * m of MEAN openness is well above that and well below anything a player would
 * fail to notice: it is roughly the difference between seeing a lane's far end
 * and seeing the crate in front of it.
 */
const TOL = Number(args.tol ?? 1.5);
/**
 * Fraction of partner pairs allowed to exceed TOL, and the mean the whole map
 * must stay under.
 *
 * Both are tight on purpose, because the map now measures EXACTLY symmetric:
 * 0.000 m mean, 0 of 763 pairs over TOL, both halves 9.991 m. That is not luck
 * and it is not a coarse lattice reporting agreement it cannot see — it is what
 * a level authored as a mirror measures once the mirror is actually applied to
 * the props as well as to the walls (see `buildWarehouse` and the `mir` argument
 * threaded through `crateStack` and `shelfRun`).
 *
 * So the gate is set just above zero rather than at whatever the map happened to
 * score. A tolerance chosen to fit the current number is a tolerance that will
 * absorb the next regression: the previous version of this map sat at 3.9%
 * against a 4% limit and passed, while carrying a pair 5.7 m apart.
 */
const MAX_BROKEN = Number(args.maxBroken ?? 0.005);
/** Mean openness delta the better symmetry must stay under, metres. */
const MAX_MEAN = Number(args.maxMean ?? 0.25);

const vite = await ensureServer(PORT, { name: 'SYMMETRY' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

const out = await page.evaluate(({ STEP, RAYS, TOL }) => {
  const EYE = 1.66;
  /** Longer than any sightline the hall affords, so "clear" is a real number. */
  const FAR = 70;

  const e = window.__ENGINE__;
  const ph = e.ctx.get('physics');
  const world = e.ctx.get('world');
  const MASK = ph.MASK.WORLD;

  const b = world.bounds;
  /**
   * A lattice centred on the origin, not on `bounds.min`.
   *
   * This is the whole reason this harness does not reuse `reach.mjs`'s grid.
   * That one starts at `min + step` and lands on x = -23.6 ... 23.2, so the
   * mirror of a cell is half a step off the lattice and every comparison would
   * measure the offset rather than the map. Here the lattice is built outward
   * from 0 in both directions, so (x, z) and (x, -z) are both sample points by
   * construction and the partner lookup is exact.
   */
  const xs = [];
  const zs = [];
  for (let x = STEP * 0.5; x < b.max.x - 1.2; x += STEP) { xs.push(x, -x); }
  for (let z = STEP * 0.5; z < b.max.z - 1.2; z += STEP) { zs.push(z, -z); }
  xs.sort((a, c) => a - c);
  zs.sort((a, c) => a - c);

  const key = (x, z) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const open = new Map();

  const dirs = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }

  let casts = 0;
  for (const x of xs) {
    for (const z of zs) {
      // Skip points inside geometry: a probe standing in a container would
      // report zero openness and pair with a partner standing in fresh air.
      // Straight down from the eye must find floor, and standing up must be
      // possible — the same two conditions `reach.mjs` calls standable.
      const down = ph.raycast(x, EYE, z, 0, -1, 0, EYE + 0.5, MASK);
      casts++;
      if (!down.hit || down.point.y > 0.55) continue;
      if (ph.raycast(x, down.point.y + 0.1, z, 0, 1, 0, 1.7, MASK).hit) continue;

      let sum = 0;
      for (const [dx, dz] of dirs) {
        const h = ph.raycast(x, EYE, z, dx, 0, dz, FAR, MASK);
        casts++;
        sum += h.hit ? h.distance : FAR;
      }
      open.set(key(x, z), sum / RAYS);
    }
  }

  /** Compare every sampled point against its partner under `map`. */
  const compare = (map, tol) => {
    const diffs = [];
    let onlyOne = 0;
    for (const x of xs) {
      for (const z of zs) {
        const a = open.get(key(x, z));
        const [px, pz] = map(x, z);
        const c = open.get(key(px, pz));
        if (a === undefined && c === undefined) continue;
        // One side standable and the other not is the loudest asymmetry there
        // is — a piece of cover that exists at one end of the map and not the
        // other — so it is counted, not skipped.
        if (a === undefined || c === undefined) { onlyOne++; continue; }
        if (z < 0) continue; // each unordered pair once
        diffs.push({ x: +x.toFixed(2), z: +z.toFixed(2), a: +a.toFixed(2), b: +c.toFixed(2), d: +Math.abs(a - c).toFixed(2) });
      }
    }
    diffs.sort((p, q) => q.d - p.d);
    const mean = diffs.length ? diffs.reduce((s, v) => s + v.d, 0) / diffs.length : 0;
    // The mean cannot see a small number of large breaks, which is exactly the
    // shape a hand-placed prop takes: one crate on one side only moves the mean
    // by centimetres and moves the fight by metres. So the outlier count is
    // gated separately from the mean.
    const over = diffs.filter((v) => v.d > tol).length;
    return {
      pairs: diffs.length,
      standableMismatch: onlyOne,
      meanDelta: +mean.toFixed(3),
      overTol: over,
      overTolFrac: diffs.length ? +(over / diffs.length).toFixed(4) : 1,
      worst: diffs.slice(0, 10),
    };
  };

  // Per-half openness: the headline number. If one team's ground is simply
  // more open than the other's, that is the advantage in one figure.
  let sumNeg = 0, nNeg = 0, sumPos = 0, nPos = 0;
  for (const [k, v] of open) {
    const z = Number(k.split(',')[1]);
    if (z < 0) { sumNeg += v; nNeg++; } else { sumPos += v; nPos++; }
  }

  return {
    step: STEP,
    rays: RAYS,
    sampled: open.size,
    casts,
    halves: {
      alphaZneg: { n: nNeg, meanOpenness: +(sumNeg / Math.max(1, nNeg)).toFixed(3) },
      bravoZpos: { n: nPos, meanOpenness: +(sumPos / Math.max(1, nPos)).toFixed(3) },
    },
    mirror: compare((x, z) => [x, -z], TOL),
    rotation: compare((x, z) => [-x, -z], TOL),
  };
}, { STEP, RAYS, TOL });

/* ---------------------------------------------------------------- verdict */

const fail = [];

// The map only has to satisfy ONE of the two. Report against the better of
// them, because failing the mirror while passing the rotation is a fair map
// with a misleading comment, not an unfair map.
const byMean = out.mirror.meanDelta <= out.rotation.meanDelta ? 'mirror' : 'rotation';
const best = out[byMean];

if (best.standableMismatch > 0) {
  fail.push(
    `${best.standableMismatch} sample point(s) stand on floor at one end of the map ` +
    `and inside geometry at the other under ${byMean} — cover exists on one side only`
  );
}
if (best.meanDelta > MAX_MEAN) {
  fail.push(
    `mean openness differs by ${best.meanDelta} m between ${byMean} partners ` +
    `(tolerance ${MAX_MEAN} m) — the two halves do not play the same:\n    ` +
    best.worst.slice(0, 6).map((w) =>
      `(${w.x}, ${w.z}) sees ${w.a} m · partner sees ${w.b} m · Δ${w.d}`).join('\n    ')
  );
}
if (best.overTolFrac > MAX_BROKEN) {
  fail.push(
    `${best.overTol}/${best.pairs} partner pairs (${(best.overTolFrac * 100).toFixed(1)}%) ` +
    `differ by more than ${TOL} m of openness under ${byMean} — ` +
    `allowed ${(MAX_BROKEN * 100).toFixed(0)}%:\n    ` +
    best.worst.slice(0, 6).map((w) =>
      `(${w.x}, ${w.z}) sees ${w.a} m · partner sees ${w.b} m · Δ${w.d}`).join('\n    ')
  );
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

console.log(JSON.stringify(out, null, 2));
console.log(
  fail.length === 0
    ? `\nSYMMETRY OK — ${out.sampled} points · ${byMean} symmetry holds to ` +
      `${best.meanDelta} m mean openness, ${best.overTol}/${best.pairs} pairs over ` +
      `${TOL} m · halves ` +
      `${out.halves.alphaZneg.meanOpenness} / ${out.halves.bravoZpos.meanOpenness} m`
    : `\nSYMMETRY FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
killServer(vite);
process.exit(fail.length === 0 ? 0 : 1);
