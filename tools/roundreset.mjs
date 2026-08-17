#!/usr/bin/env node
/**
 * ROUND RESET — does a new round hand the player a full magazine?
 *
 *   node tools/roundreset.mjs
 *
 * The rules table has said this since it was written:
 *
 *   "Scores accumulate, health does not. kills/deaths/damageDealt run for the
 *    whole match. Health, AMMO, perception and cover claims are round-scoped
 *    and cleared by respawn()."
 *
 * Health was. Ammo was not — `player.respawn` restored health and the seat,
 * `weapons` subscribed to no round event at all, and a fighter walked into
 * round four on whatever three rounds they finished round three with. Nothing
 * caught it because nothing looked: `botfight` counts kills, `matchsim` counts
 * rounds, and neither reads a magazine.
 *
 * WHAT IT DOES
 *
 * Spends ammo the way a player does — through `tryFire`, not by assignment —
 * then resets the round and reads the magazine back. Assignment would prove the
 * setter works; firing proves the path a round actually takes does.
 *
 * Reserve is checked too, because refilling the magazine out of an unchanged
 * reserve is the bug this would otherwise hide: it looks fixed for one round
 * and runs the player dry in the fourth.
 *
 * Grenades ride the same contract, and arrived with a worse version of the same
 * bug: the player was issued none at all, ever, while every bot threw them. The
 * probe asserts three separable things — that the round starts with some, that
 * throwing one reaches the world (a count that decrements and spawns nothing is
 * the failure that looks fine on the HUD), and that the reset reissues them.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port ?? 5173);

const portOpen = (port) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
  s.on('error', () => res(false));
  s.setTimeout(400, () => (s.destroy(), res(false)));
});

let vite = null;
if (!(await portOpen(PORT))) {
  vite = spawn('npx', ['vite', '--port', String(PORT)], {
    stdio: 'ignore', detached: true, env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 80 && !(await portOpen(PORT)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const out = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const match = e.ctx.get('match');
  const weapons = e.ctx.get('weapons');
  const player = e.ctx.get('player');

  match.stopMatch();
  player.setControlEnabled(false);

  const frames = (n) => new Promise((res) => {
    let i = 0;
    const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  const read = () => ({
    mag: weapons.ammo.mag,
    reserve: weapons.ammo.reserve,
    magSize: weapons.ammo.magSize,
    grenades: weapons.grenades,
    live: e.ctx.get('ai')._grenades.length,
  });
  const full = read();

  // Spend the magazine the way a player does.
  let fired = 0;
  for (let i = 0; i < 200 && weapons.ammo.mag > 0; i++) {
    if (weapons.tryFire()) fired++;
    await frames(2);
  }
  const spent = read();

  // Burn some reserve too, so a refill that only touches the magazine shows up.
  weapons.reload();
  await frames(360);
  const reloaded = read();
  for (let i = 0; i < 60 && weapons.ammo.mag > 0; i++) {
    weapons.tryFire();
    await frames(2);
  }
  const spentAgain = read();

  // Throw the loadout away too. `throwGrenade` and not an assignment, for the
  // same reason the magazine is drained by firing: the count is only round-
  // scoped if the path that actually spends it is.
  let thrown = 0;
  for (let i = 0; i < 6 && weapons.grenades > 0; i++) {
    if (weapons.throwGrenade()) thrown++;
    await frames(30);
  }
  const spentNades = read();

  match.resetRound();
  await frames(4);
  const afterReset = read();

  return { full, fired, thrown, spent, reloaded, spentAgain, spentNades, afterReset };
});

await browser.close();
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}

const fail = [];
const { full, fired, thrown, spent, spentAgain, spentNades, afterReset } = out;

if (!fired) fail.push('nothing fired — the probe never spent a round, so the reset proves nothing');
if (!full.grenades) fail.push('issued with zero grenades — the player starts the round holding only a rifle');
if (thrown !== full.grenades) {
  fail.push(`threw ${thrown} of ${full.grenades} — throwGrenade refused a grenade the player was holding`);
}
if (spentNades.live <= spentAgain.live) {
  fail.push('nothing reached the grenade pool — the count fell but no grenade exists in the world');
}
if (spentNades.grenades !== 0) fail.push(`${spentNades.grenades} grenades left after throwing them all`);
if (afterReset.grenades !== full.grenades) {
  fail.push(`grenades ${afterReset.grenades}, wanted the issued ${full.grenades} — the frags are not round-scoped`);
}
if (spent.mag >= full.mag) fail.push(`firing did not drain the magazine (${full.mag} -> ${spent.mag})`);
if (spentAgain.reserve >= full.reserve) {
  fail.push(`reserve never fell (${full.reserve} -> ${spentAgain.reserve}); the reserve half is untested`);
}
if (afterReset.mag !== full.mag) {
  fail.push(`magazine ${afterReset.mag}, wanted the issued ${full.mag} after resetRound — ammo is not round-scoped`);
}
if (afterReset.reserve !== full.reserve) {
  fail.push(`reserve ${afterReset.reserve}, wanted ${full.reserve} — the magazine refilled out of a spent reserve`);
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

console.log(`\nROUND RESET — fired ${fired} rounds across two magazines, threw ${thrown} grenades`);
console.log(`  issued      mag ${full.mag}/${full.magSize}  reserve ${full.reserve}  frags ${full.grenades}`);
console.log(`  after fire  mag ${spent.mag}  reserve ${spent.reserve}`);
console.log(`  after both  mag ${spentAgain.mag}  reserve ${spentAgain.reserve}`);
console.log(`  after throw frags ${spentNades.grenades}  live in world ${spentNades.live}`);
console.log(`  after reset mag ${afterReset.mag}  reserve ${afterReset.reserve}  frags ${afterReset.grenades}`);

if (fail.length) {
  console.log(`\nROUNDRESET FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log('\nROUNDRESET OK — a new round issues a full magazine and a full reserve.');
