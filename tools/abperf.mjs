#!/usr/bin/env node
/**
 * PAIRED A/B for frame time — the only honest way to compare two conditions on a
 * machine that drifts.
 *
 * This exists because a comparison was made the wrong way and produced a
 * confident, clean-looking, entirely fabricated result. Two prewarm variants were
 * profiled in two blocks about an hour apart: the first measured a 27.3-28.3 ms
 * median, the second 30.9-31.4 ms, and the obvious reading was that the change
 * cost four milliseconds a frame. Reverting the change measured 30.9-31.4 ms from
 * a bundle whose hash was byte-identical to the one that had measured 27.3. The
 * laptop had warmed up. Nothing about the code had changed at all.
 *
 * Four milliseconds is larger than most changes worth arguing about, so an
 * uncontrolled A/B on this hardware cannot resolve anything — it can only tell you
 * which condition you happened to run first.
 *
 * THE DESIGN, and every part of it is there to kill one confounder:
 *
 *   - ALTERNATING, A B A B A B, never all the As then all the Bs. Drift is slow
 *     compared to one run, so it lands on both conditions roughly equally.
 *   - PAIRED. Each A is differenced against the B beside it, and the statistic is
 *     the median of those differences. A trend that affects both members of a pair
 *     cancels; only the within-pair gap survives.
 *   - ONE BUILD. Conditions are query strings on the same bundle, so a rebuild
 *     cannot creep in as a hidden variable.
 *   - SIGN TEST, not a mean. With four or five pairs, how many pairs agree on the
 *     direction is a claim you can defend; a mean of five noisy numbers is not.
 *
 * Report it as unresolved unless the pairs agree. That is the point of the tool:
 * it is allowed, and expected, to come back with "no measurable difference".
 *
 *   node tools/abperf.mjs --a= --b=warmhidden=1
 *   node tools/abperf.mjs --a= --b=warmhidden=1 --pairs=6 --frames=600
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parseArgs, portOpen, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 600);
const PAIRS = Number(args.pairs ?? 5);
/** Query strings, without the `?`. Empty means the default build path. */
const QA = args.a === true ? '' : String(args.a ?? '');
const QB = args.b === true ? '' : String(args.b ?? '');

if (!(await portOpen(PORT)) && !existsSync(resolve('dist/index.html'))) {
  console.error('ABPERF FAILED — no dist/index.html. Run `npm run build` first.');
  process.exit(1);
}
const server = await ensureServer(PORT, { preview: true, name: 'ABPERF' });

const browser = await launchChromium({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});

/** One run: boot, play a scripted sequence, return the frame-time distribution. */
async function run(query) {
  // A FRESH PAGE per run, not a reload. A reused page keeps its GL context, so the
  // second condition would inherit the first one's warm program cache and driver
  // state — which is precisely the thing under test.
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/${query ? `?${query}` : ''}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForReady(page, { name: 'ABPERF' });
  const bootMs = Date.now() - t0;

  const samples = await page.evaluate((N) => new Promise((done) => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
    const out = [];
    let last = performance.now(), i = 0;
    const tick = () => {
      const now = performance.now();
      out.push(now - last); last = now;
      // Same drive as tools/profile.mjs: orbit, walk, fire in bursts. Identical in
      // both conditions by construction, because it is one function.
      e.camera.rotation.y += 0.006;
      try { e.input.down.add('KeyW'); } catch { /* input may be locked */ }
      if (i % 90 < 30) e.input.down.add('Mouse0'); else e.input.down.delete('Mouse0');
      if (++i >= N) return done(out);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), FRAMES);

  const prewarm = await page.evaluate(() => window.__PREWARM__ ?? null);
  await page.close();

  // Drop the first 60 frames: boot residue, not steady state.
  const warm = samples.slice(60).sort((a, b) => a - b);
  const q = (p) => +warm[Math.min(warm.length - 1, Math.floor(warm.length * p))].toFixed(2);
  return {
    bootMs, p50: q(0.5), p95: q(0.95), p99: q(0.99),
    max: +Math.max(...warm).toFixed(1),
    prewarm, errs: errs.slice(0, 2),
  };
}

const pairs = [];
for (let i = 0; i < PAIRS; i++) {
  // Order flips every pair, so neither condition is systematically the "cold" one
  // within a pair either.
  const first = i % 2 === 0;
  const ra = first ? await run(QA) : null;
  const rb = await run(QB);
  const ra2 = first ? ra : await run(QA);
  pairs.push({ pair: i + 1, aFirst: first, a: ra2, b: rb, dP50: +(rb.p50 - ra2.p50).toFixed(2) });
  console.log(`pair ${i + 1}: A p50 ${ra2.p50} · B p50 ${rb.p50} · B-A ${pairs[i].dP50 > 0 ? '+' : ''}${pairs[i].dP50} ms`
    + `  (max A ${ra2.max} / B ${rb.max})`);
}

const diffs = pairs.map((p) => p.dP50).sort((a, b) => a - b);
const medDiff = diffs[Math.floor(diffs.length / 2)];
const nPos = diffs.filter((d) => d > 0).length;
const nNeg = diffs.filter((d) => d < 0).length;

console.log(JSON.stringify({ QA, QB, FRAMES, PAIRS, pairs, medianDiff: medDiff, nPos, nNeg }, null, 2));

// The verdict is deliberately hard to satisfy. A four-millisecond phantom got
// through once already; the bar is that the pairs agree on a direction AND the
// median difference is bigger than the ~1 ms of within-pair noise this setup shows
// on two identical conditions.
const agree = Math.max(nPos, nNeg);
if (agree < PAIRS - 1 || Math.abs(medDiff) < 1) {
  console.log(`ABPERF UNRESOLVED — median B-A ${medDiff} ms, ${nPos} pairs up / ${nNeg} down.`
    + ` No effect this setup can distinguish from drift.`);
} else {
  console.log(`ABPERF ${medDiff > 0 ? 'B SLOWER' : 'B FASTER'} — median B-A ${medDiff} ms,`
    + ` ${agree}/${PAIRS} pairs agree.`);
}

await browser.close();
killServer(server);
