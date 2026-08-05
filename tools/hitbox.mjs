#!/usr/bin/env node
/**
 * Hitbox proof for the local player — M3's completion criterion.
 *
 * The criterion is "a headshot on the PLAYER registers", and the reason it needs
 * a harness rather than a screenshot is that the failure mode is silent. A rig
 * that is 10 cm too low, a torso capsule whose cap swallows the head, a lateral
 * offset built off the wrong yaw convention — all of them still hit the player
 * for a normal amount of damage. You do not notice you have lost headshots; you
 * notice six months later that nobody ever one-taps.
 *
 * So every probe here asserts the PART, not just that damage landed.
 *
 *   node tools/hitbox.mjs
 *   node tools/hitbox.mjs --dump    # every probe's result, not just failures
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  // `OW_NO_HMR=1`: the server this harness owns must not hot-reload.
  //
  // `vite.config.js` has carried the guard and the explanation since the capture
  // harness needed it — a file saved while a run is in flight reloads the page
  // and playwright fails the in-flight `page.evaluate` with "Execution context
  // was destroyed" — and `tools/capture.mjs` was the only tool that set it. Every
  // tool here spawns the same server for the same reason, and in `npm test` the
  // one that wins the race owns it for the whole chain, so the guard has to be on
  // all of them or it is on none of the ones that matter. Cost when nothing is
  // being edited: nothing.
  vite = spawn('npx', ['vite', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OW_NO_HMR: '1' },
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
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const ph = e.ctx.get('physics');
  const match = e.ctx.get('match');
  const player = e.ctx.get('player');
  const RIFLE = { damage: 33, penetration: 1.0, maxDist: 60 };

  // Park the player on a known spawn facing +Z, with control off so nothing
  // moves under the probes. teleport() takes the EYE, not the feet.
  //
  // Rounds off first: a round reset would respawn the player mid-probe — at a
  // scattered spawn seat, not the exact metre these probes are measured
  // against — and every remaining assertion would then be aimed at empty air.
  match.stopMatch();
  player.setControlEnabled(false);
  const FEET = { x: -12.5, y: 0.03, z: -15.5 };
  const YAW = Math.PI; // forward = (-sin, 0, -cos) = (0,0,+1)
  player.teleport({ x: FEET.x, y: FEET.y + 1.66, z: FEET.z }, YAW);
  await window.__PUMP__(2); // let match.lateUpdate place the rig

  const c = player.combatant;
  const feet = { x: c.position.x, y: c.position.y, z: c.position.z };
  const H = c.height;
  // Player right in world space at this yaw = (cos, 0, -sin) = (-1, 0, 0).
  const RIGHT = { x: Math.cos(YAW), z: -Math.sin(YAW) };

  /** Fire one round at a point on the player and report what it struck. */
  const probe = (name, dy, lateral, expectPart) => {
    player.health.reset(true);
    const tx = feet.x + RIGHT.x * lateral;
    const tz = feet.z + RIGHT.z * lateral;
    const ty = feet.y + dy;
    let got = null;
    const off = e.events.on('damage:dealt', (d) => {
      if (!got && d.target === player) {
        got = { part: d.part, amount: d.amount, headshot: d.headshot, team: d.victimTeam };
      }
    });
    // Shoot from 2.5 m in front (the player faces +Z, so stand at +Z of them)
    // straight down -Z. Close enough that no prop can get between.
    ph.fireBullet({
      origin: { x: tx, y: ty, z: tz + 2.5 },
      dir: { x: 0, y: 0, z: -1 },
      source: null,
      ignore: null,
      mask: ph.MASK.BULLET,
      ...RIFLE,
    });
    off();
    const healthAfter = player.health.value;
    player.health.reset(true);
    return { name, expectPart, dy: +dy.toFixed(3), lateral, healthAfter, ...(got ?? { part: null }) };
  };

  const probes = [
    probe('head', H * 0.925, 0, 'head'),
    probe('chest', H * 0.7, 0, 'torso'),
    probe('gut', H * 0.5, 0, 'torso'),
    probe('leg', H * 0.25, 0, 'leg'),
    probe('arm', H * 0.68, 0.26, 'arm'),
  ];

  // ---- self-exclusion: the player's own trace must pass through the player --
  player.health.reset(true);
  let selfHits = 0;
  const offSelf = e.events.on('damage:dealt', (d) => {
    if (d.target === player) selfHits++;
  });
  const cam = e.camera;
  cam.updateMatrixWorld();
  ph.fireBullet({
    origin: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
    dir: { x: 0, y: 0, z: 1 },
    source: player,
    mask: ph.MASK.BULLET,
    ...RIFLE,
  });
  offSelf();
  player.health.reset(true);

  // ---- one-tap: a rifle headshot must take a full-health player to zero -----
  const lethal = probe('lethal-head', H * 0.925, 0, 'head');
  const diedOnHeadshot = lethal.healthAfter <= 0;

  player.setControlEnabled(true);

  return {
    feet,
    height: +H.toFixed(3),
    team: c.team,
    isPlayer: c.isPlayer,
    colliders: c.colliders.length,
    parts: c.colliders.map((x) => x.part),
    probes,
    selfHits,
    diedOnHeadshot,
    headDamage: lethal.amount,
    registry: match.stats,
  };
});

const fail = [];
for (const p of out.probes) {
  if (p.part !== p.expectPart) {
    fail.push(`probe "${p.name}" struck ${p.part ?? 'NOTHING'}, expected ${p.expectPart}`);
  }
}
if (out.selfHits > 0) {
  fail.push(`the player's own round hit the player ${out.selfHits}x — owner exclusion is not working`);
}
if (!out.diedOnHeadshot) {
  fail.push(`a rifle headshot dealt ${out.headDamage?.toFixed(1)} and did not kill a 100 HP player`);
}
// head + torso + 2 arms + 2 legs.
if (out.colliders !== 6) fail.push(`expected 6 hitboxes, got ${out.colliders}: ${out.parts}`);
if (!out.team) fail.push('the player registered with no team');
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (args.dump) console.log(JSON.stringify(out, null, 2));
else console.log(JSON.stringify({ ...out, probes: out.probes.map((p) => `${p.name} -> ${p.part} ${p.amount?.toFixed(1)}`) }, null, 2));

console.log(
  fail.length === 0
    ? `\nHITBOX OK — ${out.colliders} parts, headshot ${out.headDamage.toFixed(0)} dmg (lethal), no self-hits`
    : `\nHITBOX FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
