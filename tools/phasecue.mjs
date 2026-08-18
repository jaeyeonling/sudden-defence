#!/usr/bin/env node
/**
 * Can a player tell that the round phase just changed?
 *
 * The round machine has emitted `round:phase` since it was written and NOTHING
 * SUBSCRIBED TO IT. The only announcement a transition made was `MatchBar`
 * swapping a small label at the top of the screen from GET READY to ROUND 3 —
 * so the one moment in a round that has to be felt exactly, freeze becoming
 * live, arrived with no sound, no flash and nothing in the middle of the screen.
 *
 * That is a hard defect to gate, because "it feels vague" is not a number. What
 * IS checkable is whether anything happened at all:
 *
 *   1. the countdown element shows a number in the last seconds of freeze, and
 *      counts DOWN rather than sitting on one value
 *   2. a banner is raised at each phase the design announces
 *   3. an audio cue is requested at the freeze -> live boundary
 *
 * (3) is asserted on the CALL rather than on the sound, because the capture
 * harness runs with no audio context by design (see `audio/index.js`: a gesture
 * is required and capture never gestures). Asserting the call is the honest
 * limit of what a headless run can see, and it is stated here rather than
 * quietly skipped.
 *
 * Driven by stepping the round machine directly instead of waiting out a real
 * freeze, so this costs seconds rather than minutes.
 *
 *   node tools/phasecue.mjs
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady, bootUrl } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);

const vite = await ensureServer(PORT, { name: 'PHASECUE' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(bootUrl(PORT), { waitUntil: 'load' });
await waitForReady(page, { name: 'PHASECUE' });

const out = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const ui = e.ctx.get('ui');
  const match = e.ctx.get('match');
  if (!ui || !match?.round) return { fatal: 'no ui or no round machine' };

  const frames = (n) =>
    new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });

  // Record every UI sound the HUD asks for. `ui.sfx` is the single funnel — the
  // HUD never calls the audio system directly — so wrapping it catches all of
  // them without an audio context existing.
  const sfx = [];
  const origSfx = ui.sfx.bind(ui);
  ui.sfx = (id, gain, opts) => { sfx.push({ id, gain, opts }); return origSfx(id, gain, opts); };

  const bannerNow = () => ({
    // `t < 1` is the Banner's own "still showing" test.
    showing: ui.banner.t < 1,
    title: ui.banner.title?.textContent ?? '',
  });
  const countdownNow = () => ({
    shown: ui.countdown?.style?.display !== 'none',
    text: ui.countdown?.textContent ?? '',
  });

  const seen = { phases: [], countdown: [], banners: [] };

  // Step the machine straight into each phase rather than waiting one out.
  const setPhase = async (phase, remaining) => {
    match.round.phase = phase;
    match.round.remaining = remaining;
    match.round._emitPhase?.(phase) ?? match.ctx.events.emit('round:phase', {
      phase, round: match.round.round ?? 1, remaining, scores: match.round.scores,
    });
    await frames(3);
    seen.phases.push({ phase, banner: bannerNow(), countdown: countdownNow() });
  };

  match.startMatch?.();
  await frames(3);

  await setPhase('warmup', 4);
  await setPhase('freeze', 5);

  // Walk the last three seconds down and watch the number follow.
  for (const r of [3.0, 2.4, 1.6, 0.8, 0.2]) {
    match.round.phase = 'freeze';
    match.round.remaining = r;
    await frames(3);
    seen.countdown.push({ remaining: r, ...countdownNow() });
  }

  await setPhase('live', 120);
  seen.liveBanner = bannerNow();
  // ...and it has to go away once the round is running.
  match.round.remaining = 118;
  await frames(3);
  seen.afterLive = countdownNow();

  ui.sfx = origSfx;
  return { seen, sfx };
});

await browser.close();
killServer(vite);

/* ------------------------------------------------------------------ report */

if (out?.fatal) {
  console.log(`\nPHASECUE FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}

const fail = [];
const { seen, sfx } = out;

console.log('  countdown through the last 3 s of freeze:');
for (const c of seen.countdown) {
  console.log(`    ${c.remaining.toFixed(1)}s left -> ${c.shown ? `"${c.text}"` : 'hidden'}`);
}
console.log(`  banners: ${seen.phases.map((p) => `${p.phase}:"${p.banner.title}"`).join(' · ')}`);
console.log(`  ui sounds requested: ${sfx.map((s) => s.id).join(', ') || '(none)'}`);

// 1. The countdown has to appear AND count down. A number frozen on one value
//    is a clock that stopped, and it looks identical to a working one in a
//    single screenshot.
const shown = seen.countdown.filter((c) => c.shown);
if (shown.length < 3) {
  fail.push(`the countdown was visible for only ${shown.length} of ${seen.countdown.length} samples inside the last 3 s of freeze`);
} else {
  const nums = shown.map((c) => Number(c.text)).filter(Number.isFinite);
  if (new Set(nums).size < 2) {
    fail.push(`the countdown showed "${nums[0]}" the whole way down — it is not counting`);
  }
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] > nums[i - 1]) fail.push(`the countdown went up: ${nums.join(' -> ')}`);
  }
}
// It must also clear once the round is live, or it sits over the crosshair.
if (seen.afterLive?.shown) {
  fail.push('the countdown is still on screen after the round went live');
}

// 2. A banner at each announced transition.
for (const want of ['warmup', 'freeze', 'live']) {
  const p = seen.phases.find((x) => x.phase === want);
  if (!p?.banner.showing || !p.banner.title) {
    fail.push(`no banner was raised entering '${want}'`);
  }
}

// 3. The bell. Asserted on the request, not the sound — see the header.
if (!sfx.some((s) => s.id === 'round_go')) {
  fail.push("the freeze -> live transition asked for no audio cue ('round_go')");
}
if (!sfx.some((s) => s.id === 'round_tick')) {
  fail.push("the countdown asked for no tick ('round_tick')");
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nPHASECUE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nPHASECUE OK — the countdown counts, every announced phase raises a banner, and the bell is requested');
