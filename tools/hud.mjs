#!/usr/bin/env node
/**
 * HUD wiring — M6's completion criterion.
 *
 * "Die and you spectate; hold Tab and you get a scoreboard." Both are states
 * you cannot reach by looking at a running game on demand, and both fail in
 * ways that look like nothing:
 *
 *   - the match bar reading 0-0 forever because `ui` polled a `peek('match')`
 *     that came back null — indistinguishable from a match nobody has won yet
 *   - hitmarkers gated on the wrong side of `damage:dealt`, so the player gets
 *     a marker every time two bots trade across the map — which reads as "the
 *     hitmarker is too sensitive"
 *   - the spectator camera never leaving the corpse, because the followed
 *     Combatant's yaw was in the AI convention and the chase offset went the
 *     wrong way — a camera pressed into the target's face, which reads as a
 *     near-plane problem
 *
 * So this drives the real DOM: it kills the player through the ordinary damage
 * path, reads what the HUD actually says, presses the actual Tab key, and
 * checks the camera moved somewhere a spectator would stand.
 *
 *   node tools/hud.mjs
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

/* ---- 1. the match bar is driven by `match`, not by a placeholder --------- */

const bar = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const match = e.ctx.get('match');
  const frames = (n) =>
    new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });

  // Deterministic scores. The bar must show what `match` says, so put something
  // in `match` that a placeholder could not have guessed.
  match.startMatch({ warmup: 0.1, freeze: 1.5, live: 90, roundEnd: 1, roundsToWin: 4 });
  match.round.scores.alpha = 3;
  match.round.scores.bravo = 1;
  await frames(4);

  const root = document.querySelector('.ow-match');
  const pips = [...document.querySelectorAll('.ow-pip')];
  return {
    exists: !!root,
    us: document.querySelector('.ow-match .us')?.textContent ?? null,
    them: document.querySelector('.ow-match .them')?.textContent ?? null,
    phase: document.querySelector('.ow-match .phase')?.textContent ?? null,
    clock: document.querySelector('.ow-match .clock')?.textContent ?? null,
    pipCount: pips.length,
    pipsUs: pips.filter((p) => p.classList.contains('us')).length,
    pipsThem: pips.filter((p) => p.classList.contains('them')).length,
    myTeam: e.ctx.get('player').team,
  };
});

/* ---- 2. Tab opens the scoreboard, with a row per fighter ---------------- */

/**
 * Bounded polls, not fixed sleeps.
 *
 * The first version slept 180 ms after each key event and read the class once.
 * That passed, then failed on the next run with the scoreboard still open, then
 * passed again — 180 ms is eleven frames and ought to be plenty, which is
 * exactly what makes a sleep the wrong instrument: when it does lose the race
 * you have no way to tell "the feature is broken" from "the frame was late".
 * Waiting for the condition answers that question by construction.
 */
const sbOpen = () => page.waitForFunction(
  () => document.querySelector('.ow-sb')?.classList.contains('on') === true,
  null, { timeout: 4000 }
);
const sbClosed = () => page.waitForFunction(
  () => document.querySelector('.ow-sb')?.classList.contains('on') === false,
  null, { timeout: 4000 }
);

const closed = await page.evaluate(() => document.querySelector('.ow-sb')?.classList.contains('on'));
await page.keyboard.down('Tab');
await sbOpen().catch(() => {});
const open = await page.evaluate(() => {
  const sb = document.querySelector('.ow-sb');
  const rows = [...document.querySelectorAll('.ow-sb-row')].filter(
    (r) => r.style.display !== 'none'
  );
  const match = window.__ENGINE__.ctx.get('match');
  return {
    on: !!sb?.classList.contains('on'),
    rows: rows.length,
    roster: match.combatants.length,
    youRows: rows.filter((r) => r.classList.contains('you')).length,
    // The local player's side must be the LEFT column, whichever side that is.
    leftLabel: document.querySelector('.ow-sb-col.us .name')?.textContent ?? null,
    leftScore: document.querySelector('.ow-sb-col.us .score')?.textContent ?? null,
  };
});
await page.keyboard.up('Tab');
await sbClosed().catch(() => {});
const reclosed = await page.evaluate(() => ({
  on: !!document.querySelector('.ow-sb')?.classList.contains('on'),
  stillHeld: window.__ENGINE__.ctx.input.action('scoreboard'),
  inputEnabled: window.__ENGINE__.ctx.input.enabled,
}));

/* ---- 2b. the pause menu can actually be dismissed ----------------------- */

/**
 * Closing the menu must LEAVE it closed.
 *
 * `menu.close()` asks for pointer lock back, and a browser refuses that request
 * when the exit it undoes was the user's own Escape — `core/input.js` documents
 * the refusal and swallows it, correctly, since failing to lock is not a game
 * error. `ui`'s "lost the pointer lock, so the player means to pause" rule then
 * saw an unlocked pointer and a closed menu on the very next frame and put the
 * menu straight back up with `time.scale` at 0. Escape and the resume button
 * both bounced off and the match stayed frozen. Measured: reopened three frames
 * after closing.
 *
 * It reached a played build because every gate here drives the game through its
 * API and none had ever opened the menu and then asked to leave it.
 *
 * Staged rather than driven from a real Escape, because headless Chrome never
 * grants pointer lock at all: `_hadPointerLock` never becomes true on its own,
 * so the broken path is unreachable by pressing keys. Setting that one flag is
 * exactly the state a locked player is in the moment they hit Escape.
 */
const resume = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const ui = e.ctx.get('ui');
  const frames = (n) => new Promise((r) => {
    let i = 0;
    const t = () => (++i > n ? r() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  });
  ui._hadPointerLock = true;          // as if the player had been locked in
  ui.menu.show();
  await frames(2);
  const opened = ui.menu.open;
  ui.menu.close();
  await frames(5);
  const out = { opened, stillClosed: !ui.menu.open, scale: e.ctx.time.scale };
  if (ui.menu.open) ui.menu.close();  // leave the page playable for later steps
  return out;
});

/* ---- 3. hit feedback attribution --------------------------------------- */

/**
 * Who gets told about a hit.
 *
 * Both `ui` and `audio` subscribe to `damage:dealt`, and both used to decide
 * "did I land this" by asking whether the TARGET was someone other than the
 * player. That reads correctly in a one-shooter game and is wrong here: fifteen
 * bots trading fire across the map means a hitmarker tick and a floating damage
 * number for every round any of them lands. `ui` was fixed to gate on `source`;
 * `audio` was not, and nothing noticed, because the failure is a sound playing
 * at a plausible moment.
 *
 * So the event is injected directly, with plain objects rather than live
 * combatants. `match`/`ai`/`player` all resolve the target through their own
 * registries and drop a host they do not know, so nothing downstream is
 * disturbed and the player is still alive for the spectate test below.
 *
 * `audio.running` is forced because the graph needs a user gesture that
 * headless will not give, and an unrunnable audio system would pass this by
 * returning early from every branch — a vacuous green. `ui`/`bark` are stubbed
 * so no branch reaches the AudioContext.
 */
const feedback = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const ui = e.ctx.get('ui');
  const audio = e.ctx.get('audio');

  const seen = { uiMark: [], audioUi: [], barks: 0 };
  const realMark = ui.hitmarker.bind(ui);
  const realNum = ui.damageNumber.bind(ui);
  const realAudioUi = audio.ui.bind(audio);
  const realBark = audio.bark.bind(audio);
  const wasRunning = audio.running;

  ui.hitmarker = (kind) => { seen.uiMark.push(kind); };
  ui.damageNumber = () => {};
  audio.ui = (kind) => { seen.audioUi.push(kind); return true; };
  audio.bark = () => { seen.barks++; return true; };
  audio.running = true;

  const hit = (source, target, extra = {}) => ({
    source, target, amount: 24, part: 'torso', headshot: false, killed: false,
    team: target.team ?? null, point: { x: 0, y: 1, z: 0 }, ...extra,
  });
  const bot = (team) => ({ isPlayer: false, team, name: `probe-${team}` });

  try {
    // Forty, not two. The hurt bark is behind `rng.float() < 0.3`, so a pair of
    // hits comes back with no bark half the time and "the victim went silent"
    // is then indistinguishable from a coin toss. At forty the chance of a
    // silent run is 2e-7 and the assertion means what it says.
    const N = 40;
    for (let i = 0; i < N; i++) {
      e.ctx.events.emit('damage:dealt', hit(bot('alpha'), bot('bravo'), { headshot: i % 5 === 0 }));
    }
    const botOnBot = { hits: N, ui: seen.uiMark.length, audio: seen.audioUi.length, barks: seen.barks };

    seen.uiMark.length = 0; seen.audioUi.length = 0;
    e.ctx.events.emit('damage:dealt',
      hit({ isPlayer: true, team: 'alpha', name: 'me' }, bot('bravo'), { headshot: true }));
    const mine = { ui: [...seen.uiMark], audio: [...seen.audioUi] };

    return { botOnBot, mine };
  } finally {
    ui.hitmarker = realMark;
    ui.damageNumber = realNum;
    audio.ui = realAudioUi;
    audio.bark = realBark;
    audio.running = wasRunning;
  }
});

/* ---- 3b. damage numbers accumulate per victim --------------------------- */

/**
 * One number per target, not one per bullet.
 *
 * At 800 rpm a burst lands a hit every 75 ms, and the previous number has only
 * risen 12 px by then — so unmerged numbers overlap and render as a single
 * unreadable digit run ("329" for a 32 and a 29, seen in an observe capture).
 * This drives the real widget through the real event and reads the DOM.
 *
 * Two victims are hit, because "one number on screen" is also what a merge that
 * ignores the key would produce, and that is a different bug wearing the same
 * result.
 */
const dnums = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const ui = e.ctx.get('ui');
  ui.markers.clear();

  const bot = (n) => ({ isPlayer: false, team: 'bravo', name: n });
  const me = { isPlayer: true, team: 'alpha', name: 'me' };
  const victimA = bot('probe-A');
  const victimB = bot('probe-B');
  const hit = (target, amount, extra = {}) => ({
    source: me, target, amount, part: 'torso', headshot: false, killed: false,
    team: 'bravo', point: { x: 0, y: 1, z: 0 }, ...extra,
  });

  // Four rounds into A, one into B, all inside a single frame — the worst case
  // for overlap and the one the capture caught.
  for (const a of [24, 24, 24]) e.ctx.events.emit('damage:dealt', hit(victimA, a));
  e.ctx.events.emit('damage:dealt', hit(victimA, 60, { headshot: true }));
  e.ctx.events.emit('damage:dealt', hit(victimB, 17));

  const live = ui.markers.dnPool.items.filter((i) => i.alive);
  return {
    count: live.length,
    texts: live.map((i) => i.node.textContent).sort(),
    // The headshot arrived last but was not the largest; the class must reflect
    // the strongest kind in the burst rather than the most recent one.
    hsClasses: live.filter((i) => i.node.classList.contains('hs')).length,
  };
});

/* ---- 4. death -> spectate ---------------------------------------------- */

const spec = await page.evaluate(async () => {
  const e = window.__ENGINE__;
  const player = e.ctx.get('player');
  const match = e.ctx.get('match');
  const frames = (n) =>
    new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });

  const camBefore = e.ctx.camera.position.clone();
  const eyeBefore = player.eyePosition.clone();

  // Kill through the ordinary path, not by setting a flag: `health.damage` is
  // what a bullet calls, and the spectator has to react to the same transition
  // the game produces rather than to a bespoke one.
  player.applyDamage(9999, null, { type: 'bullet', part: 'head' });
  // Enough frames for the spectator to pick a target, converge, and for `ui` to
  // see `dead` on its next lateUpdate. The convergence is exponential, so the
  // camera is within a few centimetres of its pose well inside this.
  await frames(12);

  const target = player.spectateTarget;
  const cam = e.ctx.camera.position;
  const specOn = !!document.querySelector('.ow-spec')?.classList.contains('on');

  // A spectator camera should be near the fighter it follows and NOT near the
  // corpse's eye. Both halves matter: a camera that never moved would pass a
  // "distance from the target" test on the frame the target walks past it.
  const dTarget = target
    ? Math.hypot(cam.x - target.head.x, cam.y - target.head.y, cam.z - target.head.z)
    : Infinity;
  const dCorpse = Math.hypot(cam.x - eyeBefore.x, cam.y - eyeBefore.y, cam.z - eyeBefore.z);

  // ---- the camera must never be inside the world --------------------------
  //
  // One frame is not enough to ask this. The settled pose is clamped by
  // construction; what fails is the SMOOTHED pose, which lags the ideal one by
  // the follow time — so the artefact appears only while the subject is moving
  // behind cover and is gone again a few frames later. A single sample at rest
  // reports green through it, which is how `shots/play2/07-spectate.png` came to
  // exist: a concrete slab across half the frame with the spectated body cut in
  // two by it, on a build whose spectate test was passing.
  //
  // So watch it for a while and count the frames on which the segment from the
  // subject's head to the camera is blocked. The subject is a live bot walking
  // the map, so cover comes to it.
  const ph = e.ctx.get('physics');

  // The subject is MOVED, it is not merely watched.
  //
  // The first version of this watched ninety frames of ordinary play and passed
  // with the fix reverted — ninety frames is 0.75 s, and a bot walking at
  // 1.35 m/s does not put a wall between itself and the camera in that time. A
  // gate that cannot go red is not a gate, so it has to create the condition.
  //
  // Displacing the subject across the map is the faithful way to do that,
  // because it is what the game itself does: `shots/play2/07-spectate.png` was
  // taken at "ALPHA WINS 0:01", one round-end reset after the camera had settled
  // somewhere else, and `match.resetRound` teleports every fighter back to a
  // spawn in a single frame. The camera then lerps the whole way across the hall
  // and, unclamped, through everything in between.
  const host = player.spectateTarget?.host;
  if (host?.reset) {
    const p0 = player.spectateTarget.position;
    // Straight across the long axis, so the route passes the partition walls,
    // the mid block and both lane containers.
    host.reset({ x: -p0.x, y: 0.1, z: -p0.z }, 0);
  }

  let camBlocked = 0;
  let camSampled = 0;
  let firstBlock = null;
  for (let i = 0; i < 90; i++) {
    await frames(1);
    const t2 = player.spectateTarget;
    if (!t2) continue;
    camSampled++;
    const c2 = e.ctx.camera.position;
    if (!ph.lineOfSight(t2.head, c2, ph.MASK.SIGHT)) {
      camBlocked++;
      if (!firstBlock) {
        firstBlock = {
          frame: i,
          d: +Math.hypot(c2.x - t2.head.x, c2.y - t2.head.y, c2.z - t2.head.z).toFixed(2),
        };
      }
    }
  }

  // Cycling must land on a different team-mate when there is one to land on.
  const first = target;
  player.spectator.cycle(match, player.combatant, 1);
  await frames(3);
  const second = player.spectateTarget;

  return {
    dead: player.dead,
    specOn,
    targetName: first?.name ?? null,
    targetTeam: first?.team ?? null,
    myTeam: player.team,
    allies: match.alliesOf(player.combatant).length,
    dTarget: +dTarget.toFixed(2),
    dCorpse: +dCorpse.toFixed(2),
    camMoved: +camBefore.distanceTo(cam).toFixed(2),
    camBlocked,
    camSampled,
    firstBlock,
    cycled: !!second && second !== first,
    cycledName: second?.name ?? null,
    viewmodelHidden: e.ctx.get('weapons').viewmodel?.anchor?.visible === false,
    scoreboardAuto: !!document.querySelector('.ow-sb')?.classList.contains('on'),
    crosshairHidden: getComputedStyle(document.querySelector('.ow-cross')).display === 'none' ||
      getComputedStyle(document.querySelector('.ow-cross').parentNode).display === 'none',
  };
});

/* ---------------------------------------------------------------- verdict */

const fail = [];
if (!bar.exists) fail.push('no .ow-match in the DOM — the match bar never mounted');
if (bar.us !== '3' || bar.them !== '1') {
  fail.push(`match bar shows ${bar.us}-${bar.them}, match says 3-1 — it is not reading match`);
}
if (bar.pipCount !== 8) fail.push(`${bar.pipCount} round pips, expected 8 (2 x roundsToWin 4)`);
if (bar.pipsUs !== 3 || bar.pipsThem !== 1) {
  fail.push(`pips filled ${bar.pipsUs}/${bar.pipsThem}, expected 3/1`);
}
if (!bar.clock || !/^\d+:\d\d$/.test(bar.clock)) fail.push(`clock reads "${bar.clock}"`);

if (closed) fail.push('scoreboard was already open before Tab');
if (!open.on) fail.push('Tab did not open the scoreboard');
if (open.rows !== open.roster) {
  fail.push(`scoreboard drew ${open.rows} rows for a roster of ${open.roster}`);
}
if (open.youRows !== 1) fail.push(`${open.youRows} rows marked as the local player, expected 1`);
if (open.leftScore !== '3') {
  fail.push(`left column scored ${open.leftScore}; the player's own side must be on the left`);
}
if (reclosed.on) {
  fail.push(
    `scoreboard stayed open after Tab was released ` +
    `(action held: ${reclosed.stillHeld}, input enabled: ${reclosed.inputEnabled})`
  );
}

if (!resume.opened) fail.push('pause menu did not open when shown');
if (!resume.stillClosed) {
  fail.push('pause menu reopened itself after close — the player cannot resume');
}
if (Math.abs(resume.scale - 1) > 1e-6) {
  fail.push(`time.scale ${resume.scale} after closing the menu, expected 1 — the match stays frozen`);
}

if (feedback.botOnBot.ui !== 0) {
  fail.push(`${feedback.botOnBot.ui} HUD hitmarkers for two bots shooting each other`);
}
if (feedback.botOnBot.audio !== 0) {
  fail.push(`${feedback.botOnBot.audio} hitmarker sounds for two bots shooting each other`);
}
// The victim's voice is world audio and must survive the gating — removing it
// would also make the counts above zero, and that is not the same fix.
if (feedback.botOnBot.barks === 0) fail.push('bot-on-bot hits stopped making any sound at all');
if (feedback.mine.ui.length !== 1 || feedback.mine.ui[0] !== 'head') {
  fail.push(`player headshot drew HUD ${JSON.stringify(feedback.mine.ui)}, expected ["head"]`);
}
if (!feedback.mine.audio.includes('headshot')) {
  fail.push(`player headshot played ${JSON.stringify(feedback.mine.audio)}, expected a headshot cue`);
}

if (dnums.count !== 2) {
  fail.push(
    `5 hits on 2 victims drew ${dnums.count} damage numbers, expected 2 ` +
    `(${JSON.stringify(dnums.texts)})`
  );
}
if (!dnums.texts.includes('132')) {
  fail.push(`no accumulated 132 among ${JSON.stringify(dnums.texts)} — 24+24+24+60 did not merge`);
}
if (!dnums.texts.includes('17')) {
  fail.push(`the second victim's 17 is missing from ${JSON.stringify(dnums.texts)}`);
}
if (dnums.hsClasses !== 1) {
  fail.push(`${dnums.hsClasses} numbers marked as headshots, expected 1`);
}

if (!spec.dead) fail.push('applyDamage(9999) did not kill the player');
if (!spec.specOn) fail.push('no spectate overlay after death');
if (spec.allies > 0) {
  if (!spec.targetName) fail.push('died with living team-mates but spectated nobody');
  if (spec.targetTeam !== spec.myTeam) {
    fail.push(`spectating ${spec.targetTeam}, the player is ${spec.myTeam} — following an enemy`);
  }
  if (spec.dTarget > 5) fail.push(`camera is ${spec.dTarget} m from the followed fighter`);
  if (spec.dTarget < 0.4) fail.push(`camera is ${spec.dTarget} m from them — inside their head`);
  if (spec.camMoved < 0.5) fail.push('camera never left the corpse');
  if (!spec.cycled) fail.push('fire/cycle did not change the spectated fighter');
  if (spec.camSampled < 60) {
    fail.push(`only ${spec.camSampled}/90 frames had a spectate target — the watch did not run`);
  } else if (spec.camBlocked > 0) {
    fail.push(
      `the spectate camera was inside geometry on ${spec.camBlocked}/${spec.camSampled} frames ` +
      `(first at frame ${spec.firstBlock?.frame}, ${spec.firstBlock?.d} m from the subject) — ` +
      `the smoothed position is not being clamped`
    );
  }
}
if (!spec.viewmodelHidden) fail.push('the dead player is still holding a rifle on screen');
if (!spec.crosshairHidden) fail.push('the dead player still has a crosshair');
if (!spec.scoreboardAuto) fail.push('scoreboard did not open on death');
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

console.log(
  JSON.stringify({ bar, scoreboard: { closed, open, reclosed }, feedback, dnums, spec }, null, 2)
);
console.log(
  fail.length === 0
    ? `\nHUD OK — bar ${bar.us}-${bar.them} (${bar.pipsUs}/${bar.pipsThem} pips) · ` +
      `scoreboard ${open.rows} rows · spectating ${spec.targetName} at ${spec.dTarget} m ` +
      `(clear on ${spec.camSampled - spec.camBlocked}/${spec.camSampled} frames)` +
      (spec.cycled ? ` -> ${spec.cycledName}` : '')
    : `\nHUD FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
