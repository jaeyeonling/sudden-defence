#!/usr/bin/env node
/**
 * PLAY SESSION — drive a real match and photograph it.
 *
 * Not a pass/fail harness. The other seven tools answer questions I already
 * knew to ask; this one exists to surface the ones I did not. It plays a match
 * through the ordinary input path, stops at each state a player actually sees,
 * and writes a frame out for a human (or me) to look at.
 *
 * States captured, in order:
 *   freeze    the opening hold — can you read the bar, is the map legible
 *   live      first frame of play
 *   contact   the first frame in which an enemy is on screen
 *   firing    mid-burst, muzzle flash and reticle bloom
 *   hurt      after taking damage — arcs, vignette, health
 *   scoreboard  Tab held mid-round
 *   dead      the spectate camera
 *   roundEnd  the result banner
 *
 * Telemetry is collected the whole way: frame time percentiles, phase timings,
 * damage in and out, and any console error. A dropped frame at the moment the
 * round starts is exactly the sort of thing a screenshot cannot show and a p99
 * can.
 *
 *   node tools/observe.mjs
 *   node tools/observe.mjs --out=shots/play --seconds=90
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
const OUT = String(args.out ?? 'shots/play');

mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
// The stack, not just the message. A bare "Cannot read properties of null"
// with no frame is unactionable, and that is exactly what the first run of
// this tool produced five times.
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  // THREE reports texture-unit exhaustion and program-link trouble as warnings,
  // and a warning that silently unbinds a sampler renders as a white model.
  else if (m.type() === 'warning') errors.push(`warn: ${m.text()}`);
});

await page.addInitScript((v) => { window.__NO_FLASH_LIGHT__ = v; }, !!args.noflash);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

/**
 * Install a scripted player.
 *
 * It is not an AI and does not need to be: it walks toward the centre of the
 * map, turns to face whichever enemy `match` says is closest, and pulls the
 * trigger when one is both visible and roughly in front of it. What is being
 * observed is the GAME, and a driver good enough to reach a firefight is
 * sufficient for that.
 */
await page.evaluate(() => {
  const e = window.__ENGINE__;
  const match = e.ctx.get('match');
  const player = e.ctx.get('player');
  const weapons = e.ctx.get('weapons');
  const ph = e.ctx.get('physics');

  const log = { frames: [], events: [], shots: 0, hits: 0, catchTicks: 0, catchLit: 0, catchNear: 0, burst: 0, burstOff: 0, lineAlly: 0, lineEnemy: 0, lineWorld: 0, lineNone: 0, lineSelf: 0 };
  window.__LOG__ = log;
  for (const t of ['round:phase', 'round:start', 'round:end', 'match:end', 'combatant:death']) {
    e.events.on(t, (d) => log.events.push({
      t: +e.time.elapsed.toFixed(2),
      type: t,
      phase: d?.phase,
      round: d?.round,
      winner: d?.winner,
      reason: d?.reason,
      victim: d?.combatant?.name,
      killer: d?.source?.name,
    }));
  }
  e.events.on('damage:dealt', (d) => {
    if (d?.source === player || d?.source?.isPlayer) log.hits++;
  });

  const m = player.movement;
  const c = player.combatant;
  const tmp = { x: 0, y: 0, z: 0 };

  window.__DRIVE__ = true;
  window.__SEEN_ENEMY__ = false;
  window.__FIRING__ = false;

  const fx = e.ctx.peek('fx');
  // A/B switch for the pooled muzzle light (`node tools/observe.mjs --noflash`).
  //
  // The muzzle sprite, its bloom and the punctual light all land on the same
  // pixels at the same instant, so a washed-out body next to a flash has three
  // plausible causes and no amount of staring at one frame separates them.
  // No-op the light and shoot the same state: whatever is left is not the light.
  if (window.__NO_FLASH_LIGHT__ && fx?.lights) fx.lights.flash = () => {};
  const render = e.ctx.get('render');
  log.trace = [];

  const drive = () => {
    log.frames.push(+(e.time.dt * 1000).toFixed(2));
    if (log.frames.length > 20000) log.frames.shift();

    // Per-frame illumination trace.
    //
    // Every probe so far ran AFTER a screenshot, and a screenshot round-trip is
    // ~100 ms — six frames, long enough for a 90 ms muzzle flash to decay and a
    // TAA history to converge. That is why every after-the-fact dump came back
    // clean while the photograph did not: the instrument was never pointed at
    // the frame in question. Sample inside the frame loop instead and keep a
    // short ring, then read the ring out once the capture has been taken.
    if (log.trace.length > 400) log.trace.shift();
    log.trace.push({
      f: log.frames.length,
      seen: !!window.__SEEN_ENEMY__,
      exp: +render.debugExposure().exposure.toFixed(3),
      // Live flash lights and their distance to the nearest enemy body — a
      // muzzle flash on the PLAYER's own barrel is 3 m from a soldier standing
      // in the doorway and 0.5 m from the camera.
      li: (fx?.lights?.lights ?? [])
        .filter((l) => l.light.intensity > 0.01)
        .map((l) => `${l.light.intensity.toFixed(0)}@${l.light.position.distanceTo(player.position).toFixed(1)}m/r${l.light.distance.toFixed(0)}`),
    });

    // Halt on the worst-lit frame of a firefight.
    //
    // A muzzle flash lives 3-4 frames and a Playwright screenshot costs ~6, so
    // every "firing" shot this harness ever took was of a frame with the flash
    // already gone — which is how a flash bright enough to erase the enemy's
    // camo survived eight capture runs unseen. Stopping the engine leaves the
    // last drawn frame on the canvas, so the photograph can be taken at leisure
    // of a frame that has a live flash AND a body close enough to be washed by
    // it. That combination is the readability case that actually matters: the
    // frame on which you are shooting the man you are trying to see.
    if (window.__CATCH_FLASH__ && !window.__FLASH_HELD__) {
      log.catchTicks++;
      // 1 cd, not 3. The threshold has to sit below the peak it is hunting or
      // the catch silently never fires, and the peak is a tuning value that
      // moves — it has already been cut by a factor of six once. A gate whose
      // constant is tied to the thing under test is a gate that reports "no
      // problem" the moment the test becomes interesting.
      const lit = (fx?.lights?.lights ?? []).some((l) => l.light.intensity > 1);
      if (lit) {
        log.catchLit++;
        for (const en of match.enemiesOf(c)) {
          const d = en.position.distanceTo(player.position);
          if (d > 20) continue;
          log.catchNear++;
          if (ph.lineOfSight(player.eyePosition, en.head, ph.MASK.SIGHT)) {
            // Record what he is receiving, not just that he is there. The whole
            // question is a ratio against the sun, and it can only be read on
            // the frame that was photographed.
            let irr = 0;
            for (const en2 of fx?.lights?.lights ?? []) {
              const l = en2.light;
              if (l.intensity <= 0.01) continue;
              const dd = Math.hypot(l.position.x - en.position.x,
                l.position.y - (en.position.y + 1.3), l.position.z - en.position.z);
              const w = l.distance > 0 ? Math.max(0, 1 - (dd / l.distance) ** 4) ** 2 : 1;
              irr += (l.intensity * w) / Math.max(0.01, dd * dd);
            }
            const sun = e.ctx.peek('sky')?.sunLight?.intensity ?? 0;
            window.__FLASH_HELD__ = { d: +d.toFixed(2), name: en.name,
              irr: +irr.toFixed(2), sun: +sun.toFixed(2), vsSun: sun > 0 ? +(irr / sun).toFixed(2) : null };
            e.stop();
            break;
          }
        }
      }
    }

    // Hold the engine the instant a named phase begins.
    //
    // `roundEnd` is a few seconds long and a screenshot needs the harness to be
    // waiting on it at the right moment; twice it was busy photographing the
    // spectate camera and the banner came and went unrecorded. Latching on the
    // transition and halting removes the race entirely — the frame waits for
    // the camera instead of the other way round.
    if (window.__HOLD_PHASE__ && match.phase === window.__HOLD_PHASE__) {
      // Let the phase settle before halting. Every HUD value is integrated from
      // dt (no CSS transitions, by design), so the first frame of `roundEnd` has
      // the result banner at essentially zero opacity — halting on the
      // transition itself photographed an unreadable grey ghost and made the
      // banner look like a contrast defect. Three quarters of a second in is
      // what a player actually sees.
      log.holdT = (log.holdT ?? 0) + e.time.dt;
      if (log.holdT > 0.75) {
        window.__HELD_PHASE__ = match.phase;
        window.__HOLD_PHASE__ = null;
        log.holdT = 0;
        e.stop();
      }
    }

    // Release the seam the moment this harness stops driving.
    //
    // `override` is a LATCH: once set, `CommandStream.build` reads it every tick
    // forever and the device is ignored. This block sets it and used to have no
    // matching clear, so turning `__DRIVE__` off left the player pinned at
    // moveX/moveY 0 — indistinguishable from a movement bug, and now also from a
    // dead trigger, because `held` carries `BTN.fire` since the trigger moved to
    // the tick. Nothing depended on the leak while observe only ever drove; it
    // would have been someone else's afternoon the first time it did not.
    if (!window.__DRIVE__ || player.dead || match.frozen) {
      if (e.ctx.commands.override) e.ctx.commands.override = null;
    }

    if (window.__DRIVE__ && !player.dead && !match.frozen) {
      // Drive through the command stream, not by poking `movement.cmd`. The
      // stream rebuilds `cmd` from a command every tick, so a direct poke would
      // survive for at most one step and only when the rAF happened to land in
      // the right half of a frame. An override IS a command source — the same
      // seam a server plugs into — so this is stable by construction.
      const ov = (e.ctx.commands.override ??= { moveX: 0, moveY: 0, held: 0, edge: 0 });
      ov.moveX = 0;
      ov.moveY = 0;

      // Nearest living enemy, by `match` — the same query the bots use.
      const enemies = match.enemiesOf(c);
      let best = null;
      let bestD = Infinity;
      for (const en of enemies) {
        const d = en.position.distanceTo(player.position);
        if (d < bestD) { bestD = d; best = en; }
      }

      if (best) {
        const h = best.head;
        const eye = player.eyePosition;
        const dx = h.x - eye.x;
        const dy = h.y - eye.y;
        const dz = h.z - eye.z;
        // World convention: forward = (-sin yaw, -cos yaw).
        const want = Math.atan2(-dx, -dz);
        let dyaw = want - m.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        // Turn at a human-ish rate rather than snapping: a snap would hide any
        // problem that only shows up while the camera is moving.
        m.yaw += Math.max(-0.09, Math.min(0.09, dyaw));
        m.pitch = Math.max(-0.6, Math.min(0.6, Math.atan2(dy, Math.hypot(dx, dz))));

        const clear = ph.lineOfSight(eye, h, ph.MASK.SIGHT);
        window.__SEEN_ENEMY__ = window.__SEEN_ENEMY__ || (clear && bestD < 30);
        // Aim to a TARGET SIZE, not to a fixed angle.
        //
        // The gate used to be a flat 0.06 rad, which is 1.5 m of lateral error at
        // 25 m — wider than the man being shot at. Every accuracy figure this
        // harness ever reported (5 %, 3 %, 8 %) was therefore a measurement of
        // the driver's slop rather than of the weapon, and it would have gone on
        // reading ~5 % no matter what the spray patterns did. Half a torso is
        // 0.25 m, so gate on the angle that subtends.
        const aimed = Math.abs(dyaw) < Math.atan2(0.25, Math.max(1, bestD));
        window.__FIRING__ = false;
        // Burst discipline. Held full-auto walks the recoil pattern off the
        // target and never lets it reset — the pattern reset needs 0.6 s of
        // trigger-off — so a driver that never releases is testing the top of
        // the pattern and nothing else. Six and off is what a player does.
        if (log.burst > 6) {
          log.burstOff = (log.burstOff ?? 0) + e.time.dt;
          if (log.burstOff > 0.65) { log.burst = 0; log.burstOff = 0; }
        }
        // Do not shoot your own team in the back.
        //
        // The LOS gate above uses MASK.SIGHT, which contains no bodies at all,
        // so it reports a clear lane straight through a teammate. Ask the
        // bullet's question with the bullet's mask and classify the first thing
        // it meets; `line.ally` then measures how often the map denies the
        // player a shot he can see, which is a playability number rather than a
        // harness artefact.
        const dd = tmp;
        dd.x = h.x - eye.x; dd.y = h.y - eye.y; dd.z = h.z - eye.z;
        const dl = Math.hypot(dd.x, dd.y, dd.z) || 1;
        // Start clear of the shooter's OWN capsule. MASK.BULLET contains PLAYER,
        // and a ray from the eye begins inside it, so an unoffset probe reports
        // the shooter as the first thing every single time — which is exactly
        // what the first version of this did, and it read as "every round is
        // blocked by a teammate" when nothing was in the lane at all. 0.55 m
        // clears the capsule; an ally closer than that is not a firing lane
        // problem worth modelling.
        const ox = eye.x + (dd.x / dl) * 0.55;
        const oy = eye.y + (dd.y / dl) * 0.55;
        const oz = eye.z + (dd.z / dl) * 0.55;
        const first = ph.raycast(ox, oy, oz, dd.x / dl, dd.y / dl, dd.z / dl, bestD, ph.MASK.BULLET);
        const fcb = first?.hit ? first.actor?.combatant ?? first.actor : null;
        const ftm = fcb === c ? null : fcb?.team;
        if (!first?.hit) log.lineNone++;
        else if (fcb === c) log.lineSelf++;
        else if (!ftm) log.lineWorld++;
        else if (ftm === c.team) log.lineAlly++;
        else log.lineEnemy++;
        const friendlyBlocked = !!ftm && ftm === c.team;

        if (clear && aimed && !friendlyBlocked && bestD < 30 && log.burst <= 6) {
          if (weapons.tryFire()) {
            log.shots++;
            log.burst = (log.burst ?? 0) + 1;
            window.__FIRING__ = true;
          }
        } else {
          // Close the distance when there is nobody to shoot at.
          ov.moveY = bestD > 12 ? 1 : 0;
        }
        if (weapons.ammo.mag === 0) weapons.reload();
      }
    }
    requestAnimationFrame(drive);
  };
  requestAnimationFrame(drive);
});

/* ------------------------------------------------------------------ shots */

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  return name;
};

/** Wait for a predicate evaluated in the page, or give up. */
const until = (fn, ms = 30000) =>
  page.waitForFunction(fn, null, { timeout: ms, polling: 'raf' }).then(() => true, () => false);

const taken = [];

// freeze: the opening hold
if (await until(() => ['warmup', 'freeze'].includes(window.__ENGINE__.ctx.get('match').phase), 12000)) {
  taken.push(await shot('01-freeze'));
}
// live
if (await until(() => window.__ENGINE__.ctx.get('match').phase === 'live', 20000)) {
  await page.waitForTimeout(400);
  taken.push(await shot('02-live'));
}
// first sight of an enemy
if (await until(() => window.__SEEN_ENEMY__ === true, 45000)) {
  // Stop the engine, do not merely stop the driver.
  //
  // Two frames are comparable only if nothing moved between them, and a
  // screenshot costs ~6 frames. Freezing the driver leaves the bots walking;
  // setting `agent.frozen` does not stop them either. Halting the loop leaves
  // the last drawn frame on the canvas, so what is photographed is the frame
  // the condition fired on rather than whatever the game had moved on to.
  await page.evaluate(() => {
    window.__DRIVE__ = false;
    window.__ENGINE__.stop();
  });
  taken.push(await shot('03-contact'));
  console.log('contact:', JSON.stringify(await page.evaluate(() => {
    const e = window.__ENGINE__;
    const p = e.ctx.get('player');
    const at = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    const sky = e.ctx.peek('sky');
    return {
      player: at(p.position),
      yaw: +p.movement.yaw.toFixed(3),
      expo: e.ctx.get('render').debugExposure(),
      hour: sky?.timeOfDay,
      sunAlt: sky?.sunAltitude,
      sunI: sky?.sunLight?.intensity,
      // What the nearest body is ACTUALLY receiving from the flash pool, in the
      // renderer's own units, on this exact frame.
      //
      // Eyeballing two captures against each other kept producing wrong answers
      // because they were never the same frame — different round counts, sprite
      // vs smoke, and (worse) different agents wearing different camo, so a tan
      // arid soldier read as "washed out" next to a grey urban one who was not.
      // The window is three.js's own punctual falloff, `(1-(d/cut)^4)^2 / d^2`,
      // clamped to zero past the cutoff. Ratio against the sun is the number
      // that decides this: below ~1 the flash is a highlight, above ~4 it is a
      // white-out no camo survives.
      flashAt: (() => {
        const ai = e.ctx.get('ai');
        const fx = e.ctx.peek('fx');
        let best = null; let bd = Infinity;
        for (const a of ai.agents) {
          const d = a.position.distanceTo(p.position);
          if (!a.dead && a.mesh?.visible && d < bd) { bd = d; best = a; }
        }
        if (!best) return null;
        const cx = best.position.x; const cy = best.position.y + 1.3; const cz = best.position.z;
        const sun = sky?.sunLight?.intensity ?? 0;
        const live = [];
        let total = 0;
        for (const en of fx?.lights?.lights ?? []) {
          const l = en.light;
          if (l.intensity <= 0.01) continue;
          const dx = l.position.x - cx; const dy = l.position.y - cy; const dz = l.position.z - cz;
          const d = Math.hypot(dx, dy, dz);
          const cut = l.distance;
          const w = cut > 0 ? Math.max(0, 1 - (d / cut) ** 4) ** 2 : 1;
          const irr = (l.intensity * w) / Math.max(0.01, d * d);
          total += irr;
          live.push({ cd: +l.intensity.toFixed(1), d: +d.toFixed(2), cut, w: +w.toFixed(3), irr: +irr.toFixed(2) });
        }
        return { agent: best.combatant?.name, camo: best.variantName ?? best.variant,
          dPlayer: +bd.toFixed(2), sun: +sun.toFixed(2),
          irr: +total.toFixed(2), vsSun: sun > 0 ? +(total / sun).toFixed(2) : null, live };
      })(),
      // The nearest agent's ACTUAL materials, read on the defect frame itself.
      mats: (() => {
        const ai = e.ctx.get('ai');
        let best = null; let bd = Infinity;
        for (const a of ai.agents) {
          const d = a.position.distanceTo(p.position);
          if (!a.dead && a.mesh?.visible && d < bd) { bd = d; best = a; }
        }
        if (!best?.mesh) return null;
        const out = [];
        best.mesh.traverse((o) => {
          if (!o.isMesh && !o.isSkinnedMesh) return;
          const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of ms) {
            out.push({
              obj: o.name || o.type, skinned: !!o.isSkinnedMesh, vis: o.visible,
              m: m.name, col: m.color?.getHexString(),
              map: m.map ? `${m.map.image?.width}x${m.map.image?.height}v${m.map.version}` : null,
              orm: !!m.aoMap, nrm: !!m.normalMap,
              rough: +(m.roughness ?? -1).toFixed(2), metal: +(m.metalness ?? -1).toFixed(2),
              em: m.emissive?.getHexString(), emI: m.emissiveIntensity,
              prog: m.version, opa: m.opacity, type: m.type,
            });
          }
        });
        return { agent: best.combatant?.name, d: +bd.toFixed(1), out };
      })(),
      near: e.ctx.get('ai').agents
        .map((a) => ({
          n: a.combatant?.name, team: a.team, variant: a.variantName ?? a.variant,
          dead: !!a.dead, vis: a.mesh?.visible,
          d: +a.position.distanceTo(p.position).toFixed(1),
          at: at(a.position),
          state: a.state,
        }))
        .filter((a) => a.d < 14)
        .sort((x, y) => x.d - y.d),
    };
  })));
  // Read the ring back. The contact capture is already on disk, so the frames
  // around `seen` flipping are the ones the photograph shows.
  console.log('trace:', JSON.stringify(await page.evaluate(() => {
    const t = window.__LOG__.trace;
    const i = t.findIndex((x) => x.seen);
    return t.slice(Math.max(0, i - 4), i + 10);
  })));
  await page.evaluate(() => {
    window.__ENGINE__.start();
    window.__DRIVE__ = true;
  });
}
// mid-burst
if (await until(() => window.__FIRING__ === true, 45000)) {
  taken.push(await shot('04-firing'));
}
// the flash frame itself, held (see __CATCH_FLASH__ in the driver)
await page.evaluate(() => { window.__CATCH_FLASH__ = true; });
const flashOk = await until(() => window.__FLASH_HELD__ != null, 25000);
console.log('catch:', JSON.stringify(await page.evaluate(() => {
  const l = window.__LOG__;
  return { ticks: l.catchTicks, lit: l.catchLit, near: l.catchNear };
})));
if (flashOk) {
  const held = await page.evaluate(() => window.__FLASH_HELD__);
  taken.push(await shot('04b-flash-on-enemy'));
  console.log(`flash held: ${held.name} at ${held.d} m · ${held.irr} vs sun ${held.sun} = ${held.vsSun}x`);
  await page.evaluate(() => {
    window.__CATCH_FLASH__ = false;
    window.__ENGINE__.start();
  });
}
// hurt — taken naturally if the bots land one, forced if they do not.
//
// The driver now wins most fights outright, and for three runs that silently
// dropped `05-hurt`, `07-spectate` and `08-roundend` from the capture set: the
// states were conditional on the scripted player PLAYING BADLY. A harness whose
// coverage shrinks as the game improves is backwards. Wait briefly for real
// damage, then inflict it through the ordinary Combatant path so the hurt HUD,
// the spectate camera and the round banner are photographed every run.
if (!(await until(() => {
  const p = window.__ENGINE__.ctx.get('player');
  return !p.dead && p.health.value < p.health.max * 0.85;
}, 20000))) {
  await page.evaluate(() => {
    const p = window.__ENGINE__.ctx.get('player');
    p.combatant.applyDamage(30, 'chest', null);
  });
  await page.waitForTimeout(120);
}
taken.push(await shot('05-hurt'));
// scoreboard, held mid-round
await page.keyboard.down('Tab');
await until(() => document.querySelector('.ow-sb')?.classList.contains('on') === true, 4000);
taken.push(await shot('06-scoreboard'));
await page.keyboard.up('Tab');
await page.waitForTimeout(200);

// round end banner, caught by halting on the transition rather than racing it
await page.evaluate(() => { window.__HOLD_PHASE__ = 'roundEnd'; });
if (await until(() => window.__HELD_PHASE__ === 'roundEnd', 90000)) {
  taken.push(await shot('08-roundend'));
  await page.evaluate(() => { window.__ENGINE__.start(); });
}

// death -> spectate. Forced for the same reason as the hurt frame above.
await page.evaluate(() => {
  const p = window.__ENGINE__.ctx.get('player');
  if (!p.dead) p.combatant.applyDamage(500, 'head', null);
});
if (await until(() => window.__ENGINE__.ctx.get('player').dead === true, 20000)) {
  await page.waitForTimeout(900); // let the chase camera settle
  taken.push(await shot('07-spectate'));
}
// second round, live again — proves the reset is watchable, not just assertable
if (await until(() => {
  const m = window.__ENGINE__.ctx.get('match');
  return m.phase === 'live' && m.round.round >= 2;
}, 60000)) {
  await page.waitForTimeout(300);
  taken.push(await shot('09-round2'));
}

/* -------------------------------------------------------------- telemetry */

const tel = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const log = window.__LOG__;
  const f = [...log.frames].sort((a, b) => a - b);
  const pct = (p) => (f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(2) : null);
  const match = e.ctx.get('match');
  const player = e.ctx.get('player');
  const ai = e.ctx.peek('ai');
  return {
    frameMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1), n: f.length },
    fps50: f.length ? Math.round(1000 / pct(0.5)) : null,
    shots: log.shots,
    hits: log.hits,
    accuracy: log.shots ? +(log.hits / log.shots).toFixed(3) : null,
    line: { ally: log.lineAlly, enemy: log.lineEnemy, world: log.lineWorld, none: log.lineNone, self: log.lineSelf },
    playerKills: player.combatant?.kills ?? 0,
    playerDeaths: player.combatant?.deaths ?? 0,
    scores: { ...match.scores },
    round: match.round.round,
    phase: match.phase,
    aiStats: ai?.stats,
    events: log.events.slice(0, 60),
  };
});

console.log(JSON.stringify(tel, null, 2));
console.log(`\ncaptured: ${taken.join(', ')}`);
if (errors.length) console.log(`\nERRORS (${errors.length}):\n  ${errors.slice(0, 6).join('\n  ')}`);
console.log(
  `\nOBSERVE — ${tel.fps50} fps median (p95 ${tel.frameMs.p95} ms, p99 ${tel.frameMs.p99} ms) · ` +
  `player ${tel.playerKills}k/${tel.playerDeaths}d, ${tel.hits}/${tel.shots} rounds on target · ` +
  `round ${tel.round}, ${tel.scores.alpha}-${tel.scores.bravo}`
);

await browser.close();
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}
