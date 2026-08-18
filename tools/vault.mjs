#!/usr/bin/env node
/**
 * VAULT — can a bot vault into solid geometry?
 *
 * `AiAgent._tryVault` is a TELEPORT: it lerps the body from `vaultFrom` to
 * `vaultTo` with collision off, so anything the acceptance test fails to notice
 * is not bumped into, it is passed through. That makes its two probes load
 * bearing in a way an ordinary movement check is not.
 *
 * They did not cover the move. The chest probe ran 1.1 m while the landing spot
 * was 1.5 m ahead, so an obstacle between 1.1 and 1.5 m was invisible to the one
 * test that exists to find it — and `world/warehouse.js:centreClutter` builds
 * exactly that shape deliberately: a 0.84 m crate flush against a 2.7 m block,
 * crate at x 2.3..3.1 and block face at 2.3. From x 3.5 facing -X there is a
 * ledge at 0.4 m, a clear chest line to 2.4 m, and a landing spot at x 2.0 —
 * three tenths of a metre inside the block.
 *
 * `tools/botfight.mjs` could only see the consequence, and only sometimes: a
 * survivor standing at floor height inside a solid block, invisible to every
 * line-of-sight test and unable to solve a route out, with the rest of the
 * roster converging on it until the clock ran out. That is a rare stalemate in a
 * 150 s stochastic fight — perhaps one run in four — so it is a bad signal to
 * develop against and a worse one to gate on.
 *
 * This asks the question directly instead. Stand a bot at a few hundred poses
 * around the map's clutter, call the vault, and check every ACCEPTED vault lands
 * somewhere a body can actually be. It is deterministic, it runs in seconds, and
 * it fails on the defect rather than on one of its downstream symptoms.
 *
 * The landing check is a ray cast DOWN from above the roof line, not a clearance
 * ray cast up from the landing point: a ray that starts inside a solid is at the
 * mercy of whether the backend reports back faces, and "is the landing point
 * inside a solid" is precisely the case under test. Asking from outside has no
 * such ambiguity.
 *
 *   node tools/vault.mjs [--port=5173] [--dump]
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady, bootUrl } from './harness.mjs';

const args = parseArgs();
const KNOWN = new Set(['port', 'dump']);
for (const k of Object.keys(args)) {
  if (!KNOWN.has(k)) {
    console.error(`unknown flag --${k}; known: ${[...KNOWN].join(', ')}`);
    process.exit(2);
  }
}
const PORT = Number(args.port ?? 5173);

const vite = await ensureServer(PORT, { name: 'VAULT' });
const stopVite = () => killServer(vite);

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(bootUrl(PORT), { waitUntil: 'load' });
await waitForReady(page, { name: 'VAULT' });

const out = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.get('ai');
  const match = e.ctx.get('match');
  const ph = e.ctx.get('physics');
  match.stopMatch();
  e.ctx.get('player').setControlEnabled(false);

  ai.forcePopulate = true;
  if (ai.agents.length === 0) ai.populate({ perTeam: 1 });
  const bot = ai.agents[0];
  if (!bot) return { error: 'no agent to test with' };

  /**
   * Where to stand. A ring around each piece of clutter the map puts on the
   * ground, at the radii a walking bot actually approaches from, sampled every
   * 15 degrees of yaw so the probe angle is never the lucky one.
   *
   * The centre block and its two flush crates are the shape this test was
   * written for, but the lane containers and the spawn cover are the same class
   * of geometry and cost nothing to include.
   */
  const CENTRES = [
    [0, 0, 'centre block'],
    [2.7, 0, 'mid crate +x'],
    [-2.7, 0, 'mid crate -x'],
    [12.5, 0, 'lane container +x'],
    [-12.5, 0, 'lane container -x'],
    [7, 13.8, 'spawn cover +x/+z'],
    [-7, -13.8, 'spawn cover -x/-z'],
  ];
  const RADII = [1.2, 1.6, 2.0, 2.6, 3.2, 3.8, 4.4];

  const bad = [];
  let accepted = 0;
  let tried = 0;

  for (const [cx, cz, name] of CENTRES) {
    for (const r of RADII) {
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        const px = cx + Math.cos(th) * r;
        const pz = cz + Math.sin(th) * r;
        // Stand on the floor only. A pose that starts inside something is not a
        // vault test, it is a different bug, and including it would make this
        // gate fail for a reason it does not describe.
        const down = ph.raycast(px, 5.5, pz, 0, -1, 0, 7, ph.MASK.WORLD);
        if (!down.hit || Math.abs(down.point.y) > 0.05) continue;

        // Face the centre of the piece: that is the approach that produces the
        // ledge-then-wall geometry, and it is what a bot pathing past it does.
        // forward at yaw is (sin, 0, cos), so this yaw looks from p toward c.
        const yaw = Math.atan2(cx - px, cz - pz);

        bot.position.set(px, 0.01, pz);
        bot.controller?.teleport(px, 0.01, pz);
        bot.yaw = yaw;
        bot.vaultTo = null;
        bot.vaultCooldown = 0;
        tried++;
        bot._tryVault();
        if (!bot.vaultTo) continue;
        accepted++;

        const t = bot.vaultTo;
        const over = ph.raycast(t.x, 5.5, t.z, 0, -1, 0, 7, ph.MASK.WORLD);
        const surface = over.hit ? 5.5 - over.distance : null;
        // The first thing above the landing column has to BE the landing
        // surface. If it is a metre and a half higher, the bot is being sent
        // under a solid.
        if (surface === null || surface - t.y > 1.0) {
          bad.push({
            piece: name,
            from: [+px.toFixed(2), +pz.toFixed(2)],
            yaw: +yaw.toFixed(2),
            to: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
            surfaceAbove: surface === null ? null : +surface.toFixed(2),
          });
        }
      }
    }
  }
  bot.vaultTo = null;
  return { tried, accepted, bad };
});

if (out.error) {
  console.error(`VAULT FAIL — ${out.error}`);
  await browser.close();
  stopVite();
  process.exit(1);
}
if (errors.length) {
  console.error(`VAULT FAIL — page errors: ${errors.slice(0, 3).join(' | ')}`);
  await browser.close();
  stopVite();
  process.exit(1);
}

// A pass with zero accepted vaults would be vacuous — it would also be what you
// get from breaking the vault entirely, which is not a fix.
if (out.accepted === 0) {
  console.error(`VAULT FAIL — ${out.tried} poses and not one vault was accepted; `
    + 'the test is measuring nothing (or vaulting is disabled)');
  await browser.close();
  stopVite();
  process.exit(1);
}

if (out.bad.length) {
  console.error(`VAULT FAIL — ${out.bad.length} of ${out.accepted} accepted vaults land `
    + 'inside geometry:');
  for (const b of out.bad.slice(0, 8)) {
    console.error(`    ${b.piece}: from ${b.from.join(',')} yaw ${b.yaw} -> ${b.to.join('/')}`
      + `, surface above landing at ${b.surfaceAbove}`);
  }
  if (out.bad.length > 8) console.error(`    ... and ${out.bad.length - 8} more`);
  await browser.close();
  stopVite();
  process.exit(1);
}
if (args.dump) console.log(JSON.stringify(out, null, 2));
console.log(`VAULT OK — ${out.accepted} vaults accepted out of ${out.tried} poses, `
  + 'every landing has clear headroom');

await browser.close();
stopVite();
