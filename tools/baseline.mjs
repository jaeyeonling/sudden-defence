#!/usr/bin/env node
/**
 * Rigorous, reproducible shot capture — the regression gate for optimisation work.
 *
 * Differs from shotset.mjs (which is the fast review set for critics) in three ways
 * that matter for byte-comparability:
 *
 *  1. ISOLATION — each shot gets a brand new page. shotset reuses one page for all
 *     11 shots, so particle ages, decal buffers, animation phase and auto-exposure
 *     state leak forward. That leakage is why two shotset runs differ on every shot
 *     except the first one.
 *  2. FIXED FRAME BUDGET — the shot is applied at a known frame index and exactly
 *     `settle` frames are pumped, so temporal accumulators (TAA jitter phase,
 *     exposure adaptation) always converge from the same starting phase.
 *  3. TEMPORAL RESET — asks the renderer to drop its TAA history and snap exposure
 *     before pumping, if it exposes a hook to do so.
 *
 *   node tools/baseline.mjs --out=shots/base --port=8080
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();

const PORT = Number(args.port ?? 5173);
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const SETTLE = Number(args.settle ?? 90);
const OUTDIR = resolve(args.out ?? 'shots/base');
const ROOT = resolve(import.meta.dirname, '..');
// Extra query string appended to every shot URL, e.g. --query=prewarm=0
// The gate pins its own quality instead of inheriting the product default.
//
// Every shot used to boot with no `q`, so the captures silently tracked
// `DEFAULTS.quality`. That makes a product decision — which tier ships — into a
// change in what the pixel gate is even photographing, and the gate is supposed
// to be the thing that DOESN'T move when a decision is made elsewhere. Override
// with `--q=high` when the point is to compare tiers.
const Q = String(args.q ?? 'ultra');
const EXTRA = `&q=${encodeURIComponent(Q)}${args.query ? `&${args.query}` : ''}`;

// This server feeds pixelgate and determinism — the two byte-identity gates —
// so the harness's OW_NO_HMR guard is load-bearing here. 160 tries: the two
// passes of a determinism run can race a cold vite on this machine.
const server = await ensureServer(PORT, { root: ROOT, tries: 160, name: 'BASELINE' });

const browser = await launchChromium({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
         '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio', '--disable-frame-rate-limit'],
});

mkdirSync(OUTDIR, { recursive: true });
const report = { ok: true, outDir: OUTDIR, size: `${W}x${H}`, isolated: true, settle: SETTLE, shots: [], errors: [] };

// Discover the shot list from a throwaway page.
const probe = await browser.newPage({ viewport: { width: W, height: H } });
await probe.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await waitForReady(probe, { name: 'BASELINE' });
const all = await probe.evaluate('Object.keys(window.__SHOTS__ ?? {})');
await probe.close();

const wanted = args.shots ? String(args.shots).split(',').map((s) => s.trim()) : all;

for (const name of wanted) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => m.type() !== 'debug' && logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&shot=${encodeURIComponent(name)}${EXTRA}`,
      { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitForReady(page, { name: 'BASELINE' });

    const applied = await page.evaluate(
      ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }), { s: name, settle: SETTLE });

    // Drop temporal history so accumulation starts from a known phase.
    //
    // This used to read `r?.resetTemporal?.() ?? r?.resetHistory?.() ??
    // r?.invalidateHistory?.()` and NONE of those three methods existed — three
    // chained optional calls that reliably did nothing, for as long as this file
    // has had the comment above claiming otherwise. It never failed a capture,
    // because each shot gets a fresh page and cold accumulators anyway, so there
    // was never a symptom to notice. A missing method is not a fallback chain.
    //
    // `render.resetTemporal()` now exists and this asserts on it: if the renderer
    // stops providing it, the gate must go red rather than silently stop
    // resetting.
    const reset = await page.evaluate(() => {
      const r = window.__ENGINE__?.ctx?.peek?.('render');
      if (typeof r?.resetTemporal !== 'function') return null;
      return r.resetTemporal();
    });
    if (!reset?.ok) {
      console.error(`BASELINE FAILED — render.resetTemporal() unavailable for shot "${name}";`
        + ' temporal accumulators would carry across the settle window.');
      // Tear down before exiting: determinism.mjs runs this file twice on the
      // same port, and an orphaned vite from pass A would be silently reused by
      // pass B — the two passes would no longer be independent.
      await browser.close();
      killServer(server);
      process.exit(1);
    }

    // LOCKSTEP: advance exactly SETTLE engine frames. The page runs no frame loop
    // of its own, so nothing advances during any of the round trips above or
    // during the screenshot below — engine.time.frame at the shutter is a
    // constant (BOOT_FRAMES + SETTLE) on every run and on every machine.
    await page.evaluate((n) => window.__PUMP__(n), SETTLE);
    // Yield two rAFs with the simulation frozen so the compositor has certainly
    // picked up the final rendered frame before the shutter.
    await page.evaluate(() => window.__PRESENT__(2));

    await page.screenshot({ path: `${OUTDIR}/${name}.png`, type: 'png' });
    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    report.shots.push({ shot: name, ok: !applied?.error, info, logs: logs.filter((l) => /pageerror|\[error\]/.test(l)) });
  } catch (e) {
    report.ok = false;
    report.shots.push({ shot: name, ok: false, error: e.message });
  } finally {
    await page.close();
  }
}

report.errors = report.shots.flatMap((s) => s.logs ?? []);
await browser.close();
killServer(server);

writeFileSync(`${OUTDIR}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
