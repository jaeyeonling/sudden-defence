#!/usr/bin/env node
/**
 * AUDIO PROBE — headless verification for the audio subsystem.
 *
 * Screenshots say nothing about sound, so this is the audio equivalent of the
 * capture harness. It does two independent things:
 *
 *  1. OFFLINE RENDER — imports src/audio/selftest.js in the page and renders
 *     every voice through the real mixer in an OfflineAudioContext, then checks
 *     each one for silence, NaNs, DC offset and clipping. No gesture needed.
 *
 *  2. LIVE GRAPH — clicks the canvas to satisfy the autoplay policy, waits for
 *     the AudioContext to be running, fires `debugStorm()` (one of every event
 *     through the real event bus), pumps frames, and asserts that nothing threw
 *     and no console error appeared.
 *
 * Usage:
 *   node src/audio/probe.mjs             # both checks
 *   node src/audio/probe.mjs --verbose   # per-case table
 *   node src/audio/probe.mjs --live=0    # offline only
 *
 * The port defaults to 5173, which every other harness also defaults to, and
 * which the gates workflow starts one shared vite on before the suite runs.
 * This file used to default to 5213 — its own port, therefore its own cold
 * vite — and that was invisible until the probe joined test:logic and timed
 * out on CI waiting for __READY__ while the warm server sat idle next to it.
 * If the port is already serving, the server is reused; if not, one is spawned.
 */
import {
  ensureServer, killServer, launchChromium, waitForReady, bootUrl,
} from '../../tools/harness.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
// 600 s, matching harness.mjs. The 120 s this file used to carry predates the
// shared harness and is the exact number that made the level gate's first CI
// run fail on a boot rather than on a level.
const TIMEOUT = Number(args.timeout ?? 600000);
const VERBOSE = !!args.verbose;
const DO_LIVE = args.live !== '0';

/**
 * ABSOLUTE LEVEL — the check this harness did not have.
 *
 * Everything else here asks whether a voice is broken: silent, NaN, clipping,
 * DC-offset. None of that notices a mix that is merely WRONG. `preGain` shipped
 * at 0.22 when the mix wanted 0.34, the whole game ran about 4 dB quiet with
 * `masterComp` never once engaging, and all 21 gates stayed green for it,
 * because "a gunshot makes a sound" and "a gunshot is the right loudness" are
 * different claims and only the first was ever asserted.
 *
 * Six anchors across the range, not every case: the loud end (already sitting
 * on the soft clipper), the reference weapon, and the quiet material that a
 * headroom mistake moves first. If the balance between these six is intact,
 * the 82 cases between them are too.
 *
 * TOL is 1.5 dB. Synthesis is seeded and rendered in an OfflineAudioContext,
 * so a clean run reproduces these to the fourth decimal — the tolerance is
 * headroom against a Chromium version changing a filter, not run-to-run noise.
 * A regression worth catching (the one above was 3.8 dB) clears it twice over.
 *
 * When a deliberate re-tune trips this, re-derive with `--verbose` and move the
 * numbers. Do not widen TOL: a tolerance loose enough to swallow a re-tune is
 * loose enough to swallow the next 4 dB.
 */
const LEVEL_TOL_DB = 1.5;
const LEVEL_ANCHORS = [
  { name: 'explosion@5m',   dbfs: -1.3,  note: 'ceiling — soft clipper, must not move' },
  { name: 'shot:rifle@2m',  dbfs: -3.1,  note: 'the reference weapon; mixer.js PRE_GAIN is derived from this' },
  { name: 'shot:pistol@2m', dbfs: -6.9,  note: 'quietest primary' },
  { name: 'step:concrete',  dbfs: -16.5, note: 'foley floor' },
  { name: 'shot:suppressed@2m', dbfs: -16.7, note: 'must stay near foley, not near a rifle' },
  { name: 'ui:hitmarker',   dbfs: -17.9, note: 'UI bus, no spatialisation' },
];

const dbfs = (peak) => (peak > 0 ? 20 * Math.log10(peak) : -Infinity);

/** @returns {string[]} one line per anchor that drifted past TOL */
function checkLevels(results) {
  const byName = new Map((results ?? []).map((r) => [r.name, r]));
  const bad = [];
  for (const a of LEVEL_ANCHORS) {
    const row = byName.get(a.name);
    if (!row || row.error) { bad.push(`${a.name}: missing from the self test`); continue; }
    const got = dbfs(row.peak);
    const delta = got - a.dbfs;
    if (Math.abs(delta) > LEVEL_TOL_DB) {
      bad.push(
        `${a.name}: ${got.toFixed(2)} dBFS, expected ${a.dbfs} ±${LEVEL_TOL_DB} ` +
        `(${delta > 0 ? '+' : ''}${delta.toFixed(2)} dB) — ${a.note}`
      );
    }
  }
  return bad;
}

const server = await ensureServer(PORT, { name: 'AUDIO' });

// Audio-specific flags only. Everything about the GPU and the renderer comes
// from launchChromium, which is what the other logic gates get: this file used
// to hardcode `--use-angle=metal` — a macOS backend — so on the Linux runner
// there was no usable WebGL path at all and boot never reached __READY__.
const browser = await launchChromium({
  headless: true,
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let exitCode = 0;
try {
  // bootUrl carries `render=0`: a logic gate does not make pixels, and on the
  // shared runner SwiftShader compiling the render pipeline is the entire cost
  // of the boot. Audio needs none of it. `shot=hero` rides along because the
  // live space probe walks the named capture cameras.
  await page.goto(bootUrl(PORT, 'capture=1&shot=hero'), {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await waitForReady(page, { name: 'AUDIO', timeout: TIMEOUT });

  /* ---------------- 1. offline synthesis self-test ---------------- */
  // The first dynamic import of selftest.js can make vite's dep optimizer
  // full-reload the page, which kills the execution context. Retry once.
  const runOffline = () => page.evaluate(async () => {
    const mod = await import('/src/audio/selftest.js');
    return mod.runAudioSelfTest();
  });
  let offline;
  try {
    offline = await runOffline();
  } catch (err) {
    if (!/Execution context was destroyed/.test(String(err?.message))) throw err;
    logs.push('[probe] page reloaded during import (vite dep optimize) — retrying');
    await waitForReady(page, { name: 'AUDIO', timeout: TIMEOUT });
    offline = await runOffline();
  }

  console.log(`\n=== OFFLINE SELF TEST — ${offline.cases} cases, ${offline.ok ? 'PASS' : 'FAIL'} ===`);
  if (VERBOSE) {
    const rows = offline.results ?? [];
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('case', 26)}${pad('peak', 9)}${pad('rms', 10)}${pad('dc', 10)}${pad('centroidHz', 12)}ms`);
    for (const r of rows) {
      if (r.error) { console.log(`${pad(r.name, 26)}ERROR ${r.error}`); continue; }
      console.log(`${pad(r.name, 26)}${pad(r.peak, 9)}${pad(r.rms, 10)}${pad(r.dc, 10)}${pad(r.centroid, 12)}${r.ms}`);
    }
    console.log('\nspace classifier:', JSON.stringify(offline.spaces, null, 1));
  }
  if (offline.failures.length) {
    exitCode = 1;
    console.log('\nFAILURES:');
    for (const f of offline.failures) console.log(' ', JSON.stringify(f));
  }

  const levelDrift = checkLevels(offline.results);
  if (levelDrift.length) {
    exitCode = 1;
    console.log(`\nLEVEL DRIFT — ${levelDrift.length} of ${LEVEL_ANCHORS.length} anchors outside ±${LEVEL_TOL_DB} dB:`);
    for (const line of levelDrift) console.log('  ', line);
    console.log('  Re-derive with --verbose and update LEVEL_ANCHORS if the change was deliberate.');
  } else {
    console.log(`LEVEL OK — ${LEVEL_ANCHORS.length} anchors within ±${LEVEL_TOL_DB} dB`);
  }

  /* ---------------- 2. live graph ---------------------------------- */
  if (DO_LIVE) {
    // A keypress satisfies the autoplay gesture without triggering the game's
    // pointer-lock request (which headless Chromium refuses, noisily).
    await page.keyboard.press('KeyP');
    await page.evaluate(() => window.__AUDIO__?.start?.());
    const live = await page.waitForFunction(
      () => (window.__AUDIO__?.running ? window.__AUDIO__.report() : false),
      null, { timeout: 20000 }
    ).then((h) => h.jsonValue()).catch(() => null);

    if (!live) {
      console.log('\n=== LIVE GRAPH — could not start (autoplay blocked?) ===');
      exitCode = 1;
    } else {
      console.log(`\n=== LIVE GRAPH — ${live.state} @ ${live.sampleRate} Hz ===`);
      // Pump a second of frames so beds/probes run, then storm the event bus.
      const pump = (n) => page.evaluate(
        (k) => new Promise((done) => {
          let i = 0;
          const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }), n);
      await pump(60);
      const storm = await page.evaluate(() => window.__AUDIO__.debugStorm());
      await pump(120);
      const storm2 = await page.evaluate(() => window.__AUDIO__.debugStorm());
      await pump(180);
      const after = await page.evaluate(() => window.__AUDIO__.report());
      console.log('storm 1:', JSON.stringify(storm));
      console.log('storm 2:', JSON.stringify(storm2));
      console.log('report :', JSON.stringify(after, null, 1));
      if (after.errors > 0) exitCode = 1;

      /* --- 3. does the space probe actually read the level? --------- */
      // The gunshot tail is only environmental if this classification tracks
      // the geometry, so walk the camera through the named shots and print it.
      console.log('\n=== SPACE PROBE PER SHOT ===');
      for (const shot of ['hero', 'interior', 'detail', 'sunset']) {
        await page.evaluate((s) => window.__APPLY_SHOT__(s), shot);
        await pump(45);
        const r = await page.evaluate(() => window.__AUDIO__.report());
        const w = r.spaceWeights ?? {};
        const fmt = (v) => (v ?? 0).toFixed(2);
        console.log(
          `${shot.padEnd(10)} -> ${r.space.padEnd(7)}` +
          ` tight ${fmt(w.tight)} room ${fmt(w.room)} street ${fmt(w.street)}` +
          ` tunnel ${fmt(w.tunnel)} open ${fmt(w.open)}` +
          ` | enclosure ${r.enclosure.toFixed(2)} meanFree ${r.meanFree.toFixed(1)}m`
        );
      }
    }
  }

  const IGNORE = /not valid for pointer lock/;
  const bad = logs.filter((l) => /\[error\]|\[pageerror\]|\[audio\]/.test(l) && !IGNORE.test(l));
  console.log(`\n=== CONSOLE (${logs.length} lines, ${bad.length} of interest) ===`);
  for (const l of bad.slice(0, 40)) console.log(' ', l);
  if (bad.some((l) => /\[error\]|\[pageerror\]/.test(l))) exitCode = 1;
} catch (err) {
  console.error('probe failed:', err);
  for (const l of logs.slice(-40)) console.log(' ', l);
  exitCode = 1;
} finally {
  await browser.close();
  // killServer, not child.kill(): ensureServer detaches vite into its own
  // process group, and killing only the leader leaves the server holding 5173
  // for the next gate.
  killServer(server);
}

console.log(exitCode === 0 ? '\nAUDIO PROBE: PASS' : '\nAUDIO PROBE: FAIL');
process.exit(exitCode);
