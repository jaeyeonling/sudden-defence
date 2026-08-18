#!/usr/bin/env node
/**
 * KICK — how much does the VIEW move when you fire?
 *
 *   node tools/kick.mjs [--weapon=rifle] [--burst=10]
 *
 * `ballistics.mjs` already gates where the ROUNDS go: 15.4 degrees of impact
 * climb for the M4A1 over a magazine, measured against a wall. That is the
 * balance number, and it is the one a player learns to pull down against.
 *
 * It is not the number a player feels. Between the trigger and that measurement
 * sit two presentation channels — the camera recoil springs and the viewmodel
 * kick — and NOTHING in the harness looks at either. A build could halve both
 * and every gate would stay green while the gun turned into a laser pointer,
 * because the rounds would still land in the same 15.4 degrees.
 *
 * That is exactly the gap this fills. Reported, not gated: feel is a judgement,
 * and a threshold on it would be a threshold on somebody's taste. What the tool
 * is for is making a change to that taste VISIBLE — you get the numbers before
 * and after, and the argument happens over four figures instead of two
 * adjectives.
 *
 * WHAT IT MEASURES, per weapon
 *
 *   snap      peak view climb from ONE shot, degrees. The single-shot punch.
 *   settle    seconds for that shot to fall back under 10% of its peak.
 *   burst     peak view climb across a held burst, degrees. What a spray feels
 *             like, as opposed to what it hits.
 *   punch     peak positional kick back along the view, centimetres.
 *   vm        peak viewmodel travel, centimetres — the gun in your hands.
 *
 * The camera is sampled on the RENDER frame on purpose. `aimPitch` is the tick
 * quantity and the one the bullet uses; this asks what the eye saw, which is
 * the composed rotation, and the two are allowed to differ by exactly the
 * presentation channels being measured.
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const BURST = Number(args.burst ?? 10);
const WEAPONS = args.weapon ? [String(args.weapon)] : ['rifle', 'smg', 'pistol'];

const vite = await ensureServer(PORT, { name: 'KICK' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await waitForReady(page, { name: 'KICK' });

const out = await page.evaluate(async ({ weapons: ids, burst }) => {
  const e = window.__ENGINE__;
  const wp = e.ctx.get('weapons');
  const player = e.ctx.get('player');
  const rig = player.rig;
  e.ctx.get('match').stopMatch();
  player.setControlEnabled(false);

  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const DEG = 180 / Math.PI;

  // The recoil channel itself, not the composed rotation.
  //
  // The composed view was the first thing tried and it cannot measure settle:
  // idle breathing sway is 0.0021 rad = 0.12 degrees, which is LARGER than 10%
  // of an MPX-9 shot's whole peak. Every weaker weapon would have reported that
  // it never settles, and the reason would have been the player's lungs.
  const viewPitch = () => rig.recoilPitch.value * DEG;
  // The recoil spring itself, not the composed rig transform: the rig also
  // carries sway, bob and the clip pose, and those are not the kick.
  const vmTravel = () => {
    const r = wp.viewmodel?.recPos;
    return r ? Math.hypot(r.x, r.y, r.z) : 0;
  };

  const rows = [];
  for (const id of ids) {
    wp.setWeapon(id);
    await frames(90); // let the draw clip finish and everything settle
    wp.refillAll();
    // Zero the channel explicitly. Idling between weapons is not enough — the
    // climb recovers asymptotically, so the previous weapon's burst is still
    // present at measurement time and lands on the next weapon's peak.
    rig.recoilPitch.reset();
    rig.recoilYaw.reset();
    await frames(2);

    // ---- one shot -------------------------------------------------------
    const base = viewPitch();
    const vmBase = vmTravel();
    // Trace first, reduce after. Peak and settle-below-10%-of-peak cannot both
    // be computed in one forward pass — the threshold is not known until the
    // peak has already gone by.
    const trace = [];
    wp.tryFire();
    for (let i = 0; i < 300; i++) {
      await frame();
      trace.push([viewPitch() - base, Math.abs(rig.punch.value), Math.abs(vmTravel() - vmBase)]);
    }
    const snap = Math.max(...trace.map((t) => t[0]));
    const punch = Math.max(...trace.map((t) => t[1]));
    const vm = Math.max(...trace.map((t) => t[2]));
    const peakAt = trace.findIndex((t) => t[0] === snap);
    let settle = null;
    for (let i = peakAt; i < trace.length; i++) {
      if (trace[i][0] < snap * 0.1) { settle = +((i - peakAt) / 60).toFixed(3); break; }
    }

    // ---- held burst -----------------------------------------------------
    await frames(120);
    wp.refillAll();
    // Zero the channel explicitly. Idling between weapons is not enough — the
    // climb recovers asymptotically, so the previous weapon's burst is still
    // present at measurement time and lands on the next weapon's peak.
    rig.recoilPitch.reset();
    rig.recoilYaw.reset();
    await frames(2);
    const base2 = viewPitch();
    let peak = 0, shots = 0;
    for (let i = 0; i < 240 && shots < burst; i++) {
      if (wp.tryFire()) shots++;
      await frame();
      peak = Math.max(peak, viewPitch() - base2);
    }
    for (let i = 0; i < 30; i++) {
      await frame();
      peak = Math.max(peak, viewPitch() - base2);
    }
    await frames(150);

    rows.push({
      id,
      label: wp.current?.label ?? id,
      snap: +snap.toFixed(3),
      settle,
      shots,
      burst: +peak.toFixed(3),
      punch: +(punch * 100).toFixed(2),
      vm: +(vm * 100).toFixed(2),
    });
  }
  return rows;
}, { weapons: WEAPONS, burst: BURST });

await browser.close();
killServer(vite);

console.log('\nKICK — view movement per shot (reported, not gated)\n');
console.log('  weapon      snap°   settle    burst°  (n)   punch cm   vm cm');
for (const r of out) {
  console.log(
    `  ${r.label.padEnd(10)}  ${String(r.snap).padStart(5)}   ` +
    `${String(r.settle ?? '>4s').padStart(5)}s   ${String(r.burst).padStart(6)} ` +
    `(${String(r.shots).padStart(2)})   ${String(r.punch).padStart(6)}   ${String(r.vm).padStart(5)}`
  );
}
if (errors.length) {
  console.log(`\nKICK page errors: ${errors.slice(0, 2).join(' | ')}`);
  process.exit(1);
}
console.log('');
