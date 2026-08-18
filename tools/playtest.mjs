#!/usr/bin/env node
/**
 * Headless gameplay smoke test.
 *
 * Drives the engine through its own API rather than through synthetic DOM
 * events: pointer lock is unavailable headless, so faking mousemove would test
 * nothing. Everything here asserts on state the game actually publishes.
 *
 *   node tools/playtest.mjs
 *   node tools/playtest.mjs --port=5173
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);

const vite = await ensureServer(PORT, { name: 'PLAYTEST' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await waitForReady(page, { name: 'PLAYTEST' });

// Rounds off. This harness measures MECHANICS — does W move you, does a round
// land the frame the trigger breaks — and the round loop's opening warmup holds
// the player still by design, which would read here as "movement is broken".
// `tools/matchsim.mjs` is the harness that tests the round loop.
await page.evaluate(() => window.__ENGINE__.ctx.get('match').stopMatch());

// ---- 1. movement: real key events -------------------------------------
// Input listens on window keydown/keyup and does not require pointer lock for
// movement (only look does), so these drive the real input path end to end.
const snap = () => page.evaluate(() => {
  const p = window.__ENGINE__.ctx.get('player');
  return {
    pos: p.position.toArray(),
    speed: p.horizontalSpeed,
    eye: p.eyeHeight,
    stance: p.stance,
    state: p.state,
  };
});

const before = await snap();
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
const walking = await snap();
await page.keyboard.up('KeyW');
await page.waitForTimeout(250);

await page.keyboard.down('ControlLeft');
await page.waitForTimeout(450);
const crouched = await snap();
await page.keyboard.up('ControlLeft');
await page.waitForTimeout(450);
const stoodBack = await snap();

const dist = Math.hypot(walking.pos[0] - before.pos[0], walking.pos[2] - before.pos[2]);

const move = {
  walkedForward: +dist.toFixed(3),
  walkSpeed: +walking.speed.toFixed(2),
  walkState: walking.state,
  crouchEyeDrop: +(before.eye - crouched.eye).toFixed(3),
  stanceWhileHeld: crouched.stance,
  stanceAfterRelease: stoodBack.stance,
};

const result = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const player = e.ctx.get('player');
  const weapons = e.ctx.get('weapons');
  const phys = e.ctx.get('physics');
  const out = {};
  const m = player.movement;

  const frames = (n) =>
    new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });

  // ---- 2. fire: hitscan, impacts, spread, deterministic pattern ----------
  let impacts = 0;
  let tracers = 0;
  let lastImpactFrame = -1;
  const offImpact = e.events.on('bullet:impact', () => {
    impacts++;
    lastImpactFrame = e.time.frame;
  });
  const offTracer = e.events.on('bullet:tracer', () => tracers++);

  // Aim at the far wall (the hall is 32 m deep, we are near the alpha end).
  m.yaw = 0;
  m.pitch = 0;
  await frames(3);

  const fireFrame = e.time.frame;
  const fired = weapons.tryFire();
  out.fired = fired;
  // Hitscan means the impact lands on the SAME frame the trigger broke. A
  // projectile would need several frames to cross the hall.
  out.impactSameFrame = lastImpactFrame === fireFrame;
  out.impactsFromOneShot = impacts;

  const spreadRest = weapons.spreadDegrees;
  for (let i = 0; i < 8; i++) {
    weapons._fireTimer = 0;
    weapons.tryFire();
    await frames(1);
  }
  out.spreadRest = +spreadRest.toFixed(3);
  out.spreadAfterBurst = +weapons.spreadDegrees.toFixed(3);
  out.spreadGrew = weapons.spreadDegrees > spreadRest;
  out.totalImpacts = impacts;
  out.tracers = tracers;
  out.ammoAfter9 = weapons.ammo.mag;

  // The recoil pattern must be identical run to run — it is what a player
  // memorises, so a random one would make the whole spray model a lie.
  const st = weapons.states.get('rifle');
  out.patternHead = Array.from(st.pattern.slice(0, 6)).map((v) => +v.toFixed(6));
  out.patternLength = st.def.recoil.patternLength;

  offImpact();
  offTracer();

  // ---- 3. no ADS anywhere ------------------------------------------------
  out.noAdsOnPlayer = player.adsProgress === undefined && player.setAdsProgress === undefined;
  out.noAdsOnWeapons = weapons.adsProgress === undefined;
  out.viewmodelHasNoReticle = weapons.viewmodel.reticle === undefined;

  // ---- 4. damage model ---------------------------------------------------
  const before = player.health.value;
  player.applyDamage(30, null, { part: 'torso' });
  out.healthAfterHit = player.health.value;
  await frames(120); // ~2 s: a regenerating game would have healed by now
  out.healthAfterWait = player.health.value;
  out.noRegen = player.health.value === before - 30;

  out.staticTris = phys.stats?.staticTris ?? null;
  return out;
});

/**
 * How far does the view actually turn per unit of mouse travel?
 *
 * `config.sensitivity` is radians per pointer count, and `Input` applies it —
 * its `look` field says "in radians after sensitivity" on the line that declares
 * it. `player._consumeLook` applied it a SECOND time, so the real figure was the
 * square: 1000 counts turned the view 0.277 degrees instead of 126, a factor of
 * 455, and looking around was effectively impossible.
 *
 * It survived because the error is symmetric. Yaw and pitch were wrong by the
 * identical factor, so nothing on screen looked skewed or lopsided — the view
 * simply did not move, and no gate here had ever moved a mouse. Every other
 * check drives the player through the API.
 *
 * Asserted as a BAND, not a number, so retuning the default sensitivity is not a
 * test failure while an extra multiply (or a lost one) still is: either mistake
 * moves this by two orders of magnitude, and no plausible retune moves it by
 * more than a factor of a few.
 *
 * `pointerLocked` is forced because headless Chrome never grants a real lock,
 * and pitch is read at the horizon with a small delta so the +/-88 degree clamp
 * cannot truncate the sample the way a full 126 degrees would.
 */
const look = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const input = e.ctx.input;
  const m = e.ctx.get('player').movement;
  const frames = (n) => new Promise((r) => {
    let i = 0;
    const t = () => (++i > n ? r() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  });
  const send = (dx, dy) => e.ctx.canvas.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy })
  );
  const probe = async (dx, dy) => {
    input.pointerLocked = true;
    m.pitch = 0;
    const y0 = m.yaw;
    const p0 = m.pitch;
    for (let i = 0; i < 10; i++) { send(dx, dy); await frames(1); }
    return { yaw: (m.yaw - y0) * 180 / Math.PI, pitch: (m.pitch - p0) * 180 / Math.PI };
  };
  const x = await probe(20, 0);       // 200 counts left/right
  const y = await probe(0, 20);       // 200 counts up/down
  return {
    sensitivity: e.ctx.config.sensitivity,
    yawDeg: Math.abs(x.yaw),
    pitchDeg: Math.abs(y.pitch),
    yawLeak: Math.abs(y.yaw),
    pitchLeak: Math.abs(x.pitch),
  };
});
// 200 counts at the 0.0022 rad/count default is 25.2 degrees.
const LOOK_MIN = 5;
const LOOK_MAX = 90;

const fail = [];
const check = (name, ok, detail) => {
  if (!ok) fail.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

check('walks forward', move.walkedForward > 2, `moved ${move.walkedForward} m`);
check('walk speed ~6 m/s', move.walkSpeed > 5 && move.walkSpeed < 6.5, `${move.walkSpeed}`);
check('crouch lowers eye', move.crouchEyeDrop > 0.3, `${move.crouchEyeDrop} m`);
check('crouch is hold', move.stanceWhileHeld === 'crouch' && move.stanceAfterRelease === 'stand',
  `${move.stanceWhileHeld} -> ${move.stanceAfterRelease}`);
check('fires', result.fired === true);
check('hitscan lands same frame', result.impactSameFrame === true);
check('impact registered', result.impactsFromOneShot > 0);
check('spread grows with fire', result.spreadGrew === true,
  `${result.spreadRest} -> ${result.spreadAfterBurst}`);
check('tracers emitted', result.tracers > 0);
// 30-round magazine plus one in the chamber: nine rounds leaves 22 in the mag.
check('ammo consumed', result.ammoAfter9 === 22, `mag ${result.ammoAfter9}`);
check('recoil pattern present', result.patternHead.some((v) => v !== 0));
check('no ADS on player', result.noAdsOnPlayer === true);
check('no ADS on weapons', result.noAdsOnWeapons === true);
check('no collimator reticle', result.viewmodelHasNoReticle === true);
check('damage applied', result.healthAfterHit === 70, `${result.healthAfterHit}`);
check('no health regen', result.noRegen === true, `health ${result.healthAfterWait} after 2 s`);
check('mouse yaw turns the view', look.yawDeg > LOOK_MIN && look.yawDeg < LOOK_MAX,
  `200 counts -> ${look.yawDeg.toFixed(2)} deg (sensitivity ${look.sensitivity})`);
check('mouse pitch turns the view', look.pitchDeg > LOOK_MIN && look.pitchDeg < LOOK_MAX,
  `200 counts -> ${look.pitchDeg.toFixed(2)} deg`);
// Yaw and pitch share one sensitivity, so they must land on the same figure.
check('look axes match', Math.abs(look.yawDeg - look.pitchDeg) < 0.01 * Math.max(look.yawDeg, 1),
  `yaw ${look.yawDeg.toFixed(2)} vs pitch ${look.pitchDeg.toFixed(2)} deg`);
check('look axes do not cross-talk', look.yawLeak < 1e-6 && look.pitchLeak < 1e-6,
  `yaw leak ${look.yawLeak}, pitch leak ${look.pitchLeak}`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(JSON.stringify({ ...move, ...result }, null, 2));
console.log(fail.length === 0 ? '\nPLAYTEST OK' : `\nPLAYTEST FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);

await browser.close();
killServer(vite);
process.exit(fail.length === 0 ? 0 : 1);
