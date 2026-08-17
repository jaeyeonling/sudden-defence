#!/usr/bin/env node
/**
 * CONTRACT — boot the game and print what the subsystems say they built.
 *
 *   npm run tool:contract
 *
 * NOT A GATE, and the distinction matters enough to write down: every other
 * tool in here asserts something and exits non-zero when it fails. This one
 * asserts nothing. It dumps render's uniforms, world's bounds and spawn table,
 * physics' triangle and node counts, and the boot console — and always exits 0.
 *
 * It is the first thing to run when a gate goes red for a reason that does not
 * name a subsystem, because it answers "what did the engine actually come up
 * as this time" without a harness in the way. The boot log it prints is where
 * the `MATERIAL_SLOTS` assert was visible for the whole span it shipped broken
 * (b1cdcc0 -> a1508a2); nothing consumed that output, so nothing noticed.
 *
 * If you want the picture rather than the numbers, that is `tools/capture.mjs`
 * for one shot or `tools/baseline.mjs` for the comparable set.
 */
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);

const vite = await ensureServer(PORT, { tries: 60, name: 'CONTRACT' });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

const state = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const w = e.ctx.peek('world');
  const p = e.ctx.peek('physics');
  const u = r.patcher.uniforms;
  const pl = e.ctx.peek('player');
  return {
    camera: e.camera.position.toArray().map(v=>+v.toFixed(2)),
    camFov: +e.camera.fov.toFixed(1),
    playerFeet: pl ? pl.position.toArray().map(v=>+v.toFixed(2)) : null,
    playerEye: pl ? pl.eyePosition.toArray().map(v=>+v.toFixed(2)) : null,
    playerState: pl?.state, grounded: pl?.grounded, health: pl?.health?.value ?? null, dead: pl?.dead,
    roomCount: u.owIndirect.value.z,
    roomBox: Array.from(r.patcher.rooms[0] ?? []),
    roomY: Array.from(r.patcher.roomsY[0] ?? []),
    interiorIndirect: u.owIndirect.value.y,
    spawnTeams: w.spawnPoints.map(s => `${s.tag}:${s.team}`),
    bounds: [w.bounds.min.toArray(), w.bounds.max.toArray()],
    staticTris: p.stats?.staticTris ?? p.staticWorld?.triCount ?? null,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('--- logs ---');
console.log(logs.filter(l => /render|world|physics|error|warn/i.test(l)).join('\n'));
await browser.close();
killServer(vite);
process.exit(0);
