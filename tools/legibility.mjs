#!/usr/bin/env node
/**
 * CHARACTER LEGIBILITY — is an enemy body readable against the wall behind it?
 *
 * This exists because the question kept being answered by eye, from firefight
 * captures, and the answer kept being wrong. Two live frames are never the same
 * frame: different round counts, sprite vs smoke, different agents in different
 * camo, the camera a few degrees off. Three separate conclusions were drawn from
 * such pairs and all three were artefacts of the comparison rather than findings
 * about the game.
 *
 * So: stage it. Freeze the match, put the player at a fixed spot with a fixed
 * yaw, teleport one agent to a fixed distance straight ahead, halt the engine,
 * and read the actual pixels back. The body is located by rendering-independent
 * means (project its own bone positions to screen space), not by colour, so the
 * measurement cannot beg the question it is asking.
 *
 * Reported per distance:
 *   bodyL / bgL     mean luminance of body pixels and of the same pixels with
 *                   the body taken out
 *   contrast        |bodyL - bgL| / max(bodyL, bgL)   — 0 is invisible
 *   snc             the same step divided by the BACKGROUND's own luma spread
 *   bgSd            that spread
 *   sat             mean saturation of body pixels  — camo that survived
 *   clip            fraction of body pixels above 0.95 luma — blown highlights
 *
 * A body that reads has contrast well clear of 0 and a saturation close to what
 * the same body shows unlit. A body washed by a light goes low-contrast, low-sat
 * and high-clip all at once, which is the signature to watch for.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `snc` ONLY MEANS ANYTHING WHERE THE TARGET IS SMALL
 *
 * Signal-to-clutter exists because mean contrast can look healthy while a
 * silhouette is genuinely hard to pick up: if the wall behind a man varies more
 * than he differs from it, he is inside the noise. But it reads alarmingly low
 * at point-blank range for a reason that is not a defect — 0.34 at 1.5 m — and
 * acting on that would be acting on the metric rather than on the game. At 1.5 m
 * the body covers 23,000 pixels and a quarter of the screen; nobody fails to see
 * it, whatever its luminance does. Detection there is carried by size.
 *
 * The ranges the number governs are the ones where the target is a few dozen
 * pixels, and measured across the length of the hall those are fine:
 *
 *     dist    px    contrast   snc
 *     12 m   288      0.40     1.98
 *     18 m   161      0.42     2.49
 *     24 m    68      0.40     1.82
 *     30 m    52      0.35     1.33
 *
 * Bodies sit at L ~ 0.25 whatever the distance while the far wall climbs to
 * ~0.45, so a man across the depot reads as a dark shape on a light one. Both
 * team uniforms measure the same to within noise (0.34 / 0.60 / 1.33 / 1.69 for
 * vanguard against 0.38 / 0.52 / 1.26 / 1.72 for breacher), so tan-in-a-concrete
 * hall is not the advantage it sounds like. The default distance list therefore
 * spans both regimes; do not conclude anything from the near two alone.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `--against=clutter` — AND THE HYPOTHESIS IT REFUTED
 *
 * A freeze-frame capture reads as though the steel door frames and shelf
 * uprights are the loudest things on screen while enemies are dark smudges, and
 * the obvious conclusion is that the props out-compete the people and the steel
 * should be darkened. Both halves of that measured false:
 *
 *   absolute luminance   door frame 0.774 · shelf upright 0.646 · wall 0.480 ·
 *                        floor 0.247 · frame p99 0.791
 *   Weber contrast       door frame vs its wall 0.38 · BODY vs its wall
 *                        0.34-0.41
 *
 * The frames are brighter, and brightness is not the term that governs
 * detection. Against the same backdrop the body is the equal or louder signal.
 *
 * That left a real gap, though: the yaw sweep below picks the LONGEST clear ray,
 * which in this map always ends on a flat wall, so no staged measurement had
 * ever placed a body in front of shelving or a container edge. `--against=
 * clutter` closes it by scoring candidate yaws on the depth spread of a ray fan
 * through the body's own volume and staging on the worst. Measured (breacher):
 *
 *     dist    wall snc   clutter snc    wall contrast   clutter contrast
 *     12 m      1.26        1.36            0.341           0.408
 *     18 m      1.93        1.31            0.414           0.406
 *     24 m      1.88        1.82            0.395           0.362
 *
 * Broken backdrops cost nothing systematic — at 12 m the FLAT wall is the worse
 * of the two. So the steel was left alone. The mode stays in the suite because
 * it is the only coverage of the cluttered case, and an unmeasured case is where
 * the next lighting change will land.
 *
 *   node tools/legibility.mjs
 *   node tools/legibility.mjs --noflash            # A/B the muzzle light
 *   node tools/legibility.mjs --flash              # fire a flash on the held frame
 *   node tools/legibility.mjs --variant=vanguard   # stage one team's uniform
 *   node tools/legibility.mjs --against=clutter    # stage against broken geometry
 *   node tools/legibility.mjs --d=12,18,24,30
 *   node tools/legibility.mjs --out=shots/legibility
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const OUT = String(args.out ?? 'shots/legibility');
// Point blank, engagement, and two genuinely long looks. The flash cutoff is
// 3 m, so 1.5 straddles it deliberately; 24 covers two thirds of the hall,
// which is where `snc` stops being decorative (see the header).
const DISTANCES = String(args.d ?? '1.5,3,12,24').split(',').map(Number);
/** Which team uniform to stage. Unset takes whoever is first in the pool. */
const WANT = args.variant ? String(args.variant) : null;
/**
 * `wall` (default) stages down the longest clear ray — a flat backdrop.
 * `clutter` stages in front of the most broken geometry the map has at that
 * distance. See the scan in `__STAGE__` for why the second one had to exist.
 */
const AGAINST = String(args.against ?? 'wall');
if (AGAINST !== 'wall' && AGAINST !== 'clutter') {
  console.error(`--against must be wall or clutter, got ${AGAINST}`);
  process.exit(2);
}

// Reject flags this tool does not know.
//
// `--camo=vanguard` looks exactly like the right way to ask for the other team's
// uniform, and it is not — the flag is `--variant`. Unrecognised keys land in
// `args` and are never read, so the run succeeded, staged `breacher` for the
// second time, and printed a table headed 'breacher' under a command that said
// vanguard. This tool's own staging notes warn against reporting one team's
// number as if it were the game's; a typo should not be a way to do that.
const KNOWN = new Set(['port', 'out', 'd', 'variant', 'flash', 'noflash', 'against']);
const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
if (unknown.length) {
  console.error(
    `unknown flag(s): ${unknown.map((k) => `--${k}`).join(' ')}\n` +
    `known: ${[...KNOWN].map((k) => `--${k}`).join(' ')}`
  );
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const vite = await ensureServer(PORT, { name: 'LEGIBILITY' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.addInitScript((v) => { window.__NO_FLASH_LIGHT__ = v; }, !!args.noflash);
// `?capture=1` — deterministic engine seed. `core/engine.js` seeds `ctx.rng`
// from `Math.random()` otherwise, and the world's dressing pass forks that rng
// to pick surface variants, so two loads render the same level with different
// materials on the same props. This gate reads a body against the wall behind
// it; the wall is dressed from that seed. `tools/markings.mjs` measured the
// same effect directly — its hazard-bar contrast read 0.04 on one run and 0.22
// on the next, from nothing but the seed.
await page.goto(`http://127.0.0.1:${PORT}/?capture=1`, { waitUntil: 'load' });
await waitForReady(page, { name: 'LEGIBILITY' });

// The A/B hook has to be installed after boot, because `fx` does not exist
// before it. Same switch observe.mjs uses, so the two tools disagree only about
// what they measure and never about what they are measuring.
await page.evaluate(() => {
  const fx = window.__ENGINE__.ctx.peek('fx');
  if (window.__NO_FLASH_LIGHT__ && fx?.lights) fx.lights.flash = () => {};
});

// Capture mode turns the round loop off (`match/index.js`) so a screenshot gate
// photographs a level rather than whatever phase the machine happened to reach.
// This gate needs the opposite: it stages a live fighter, so it needs the loop.
// Start it explicitly — that keeps the deterministic seed, which is what capture
// mode was turned on for here, without inheriting the shutter policy.
// Two things capture mode switches off, and this gate needs both back. `ai`
// skips `populate()` under a deterministic config (there is a `forcePopulate`
// escape hatch for exactly this), and `match` will not start the round loop.
// Neither is about the seed, which is the only part of capture mode wanted
// here; without them the staging finds no live agent at any distance.
// `populate()` is CALLED, not merely enabled. `forcePopulate` is read inside
// `AiSystem.update`'s one-shot `_navPending` branch, which has already run by
// the time the page reports ready, so setting the flag from here does nothing
// at all — measured: the roster stayed at zero and the round went warmup to
// roundEnd in three seconds because one side had no fighters. `dev/shots.js`
// does the same pair for the same reason. The flag is still set so that a later
// nav rebuild does not undo this.
await page.evaluate(() => {
  const ai = window.__ENGINE__.ctx.get('ai');
  ai.forcePopulate = true;
  if (!ai.agents.length) ai.populate();
  window.__ENGINE__.ctx.get('match').startMatch();
});

// Wait for `live`: during freeze the agents are held at spawn and some are not
// yet skinned, and an unskinned body is not the thing under test.
await page.waitForFunction(
  () => window.__ENGINE__.ctx.get('match').phase === 'live',
  null, { timeout: 60000 }
);

// Install the staging routine once and call it twice per distance — with the
// subject, and without. Two copies of this as inline evaluates would be two
// things to keep in step, and the whole point is that the two passes are
// identical apart from one boolean.
await page.evaluate(() => {
  window.__STAGE__ = async ({ dist, wantFlash, hidden, want, against }) => {
    const e = window.__ENGINE__;
    const match = e.ctx.get('match');
    const player = e.ctx.get('player');
    const ai = e.ctx.get('ai');
    const world = e.ctx.get('world');

    // Face down the long axis of the hall from a team spawn, so there is a wall
    // at a known distance behind the subject and the lighting is the ordinary
    // indoor lighting of the map rather than a doorway's daylight.
    const sp = (world.spawnPoints ?? []).find((s) => s.team === 'alpha');
    if (!sp) return { ok: false, why: 'no alpha spawn' };
    const org = sp.position;

    // The yaw is FOUND, not taken from the spawn.
    //
    // The spawn's own yaw faces up the map, and that used to be the right choice
    // because the lane it faced was 31 m of open floor. The lane was open because
    // the map let the two spawn courts see each other, which was a bug —
    // `tools/reach.mjs` gates it now and `world/warehouse.js` puts a container on
    // each spawn-to-spawn line to break it.
    //
    // The staging did not notice. It kept placing the subject 24 m up a lane that
    // now has 2.6 m of steel across it at 15.5 m, and the projected body mask
    // landed on the container rather than on the body: bodyL 0.393, bgL 0.392,
    // reported as "contrast 0.0018". That reads as a body which has become
    // invisible; the body was simply not in shot.
    //
    // So sweep for the longest unobstructed ray from the spawn at eye height and
    // stage along that instead. It follows the map rather than assuming it, and
    // the ray ends on a wall, which is the backdrop this measurement wants.
    const ph0 = e.ctx.get('physics');
    const EYE0 = 1.66;
    let yaw = sp.yaw ?? 0;
    let clearRun = 0;
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * Math.PI * 2;
      // World convention: forward at yaw is (-sin, 0, -cos).
      const h = ph0.raycast(org.x, EYE0, org.z, -Math.sin(a), 0, -Math.cos(a), 80, ph0.MASK.SIGHT);
      const d = h.hit ? h.distance : 80;
      if (d > clearRun) { clearRun = d; yaw = a; }
    }

    // `--against=clutter`: stage in front of the BROKEN background instead.
    //
    // The sweep above deliberately finds the longest clear ray, and a long clear
    // ray in this map always ends on a flat wall. That is the right backdrop for
    // "does the uniform read against concrete", and it means this tool has never
    // once measured a body standing in front of shelving, a door frame or a
    // container edge — the places where a silhouette actually competes with
    // something. Reporting `min contrast 0.042` over four flat-wall stagings and
    // calling it the game's legibility floor overstates what was tested.
    //
    // Clutter is found geometrically, not chosen by hand: for each candidate yaw
    // fan rays through the volume the body will occupy and score the SPREAD of
    // their hit distances. A flat wall scores ~0; a rack with uprights in front
    // of a far wall scores metres. Picking the worst yaw by that score searches
    // the map rather than assuming where its clutter is, so a map edit cannot
    // quietly move the test off the thing it was written to find.
    let depthSd = 0;
    if (against === 'clutter') {
      let bestSd = -1, bestYaw = yaw, bestClear = clearRun;
      const half = Math.atan2(0.35, dist);
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const ch = ph0.raycast(org.x, EYE0, org.z, -Math.sin(a), 0, -Math.cos(a), 80, ph0.MASK.SIGHT);
        const cd = ch.hit ? ch.distance : 80;
        // The subject must stand clear of geometry, or this measures occlusion
        // rather than clutter — the failure mode the header already documents.
        if (cd < dist + 0.8) continue;
        const ds = [];
        for (let k = -3; k <= 3; k++) {
          const aa = a + (k / 3) * half;
          for (const hy of [0.6, 1.2, 1.7]) {
            const h = ph0.raycast(org.x, hy, org.z, -Math.sin(aa), 0, -Math.cos(aa), 80, ph0.MASK.SIGHT);
            ds.push(h.hit ? h.distance : 80);
          }
        }
        // Only surfaces BEYOND the subject are his background. If a fifth of the
        // fan stops short, something is in front of him at body height and this
        // yaw is an occlusion, not a backdrop.
        const beyond = ds.filter((d) => d > dist);
        if (beyond.length < ds.length * 0.8) continue;
        const m = beyond.reduce((s, v) => s + v, 0) / beyond.length;
        const sd = Math.sqrt(beyond.reduce((s, v) => s + (v - m) * (v - m), 0) / beyond.length);
        if (sd > bestSd) { bestSd = sd; bestYaw = a; bestClear = cd; }
      }
      if (bestSd < 0) return { ok: false, why: `no unoccluded yaw at ${dist} m` };
      yaw = bestYaw; clearRun = bestClear; depthSd = bestSd;
    }

    // `alive`, not `!dead`. Agent has no `dead` field, so `!a.dead` is true for
    // every agent including corpses — the same typo made botfight dump its
    // whole roster as "survivors" and hid the stalemate it was written to find.
    //
    // The variant is selectable because the two team uniforms are not equally
    // visible and taking whichever agent happens to be first in the pool makes
    // the tool report one team's number as if it were the game's. `breacher` is
    // wolf grey in a concrete depot and `vanguard` is tan; they cannot possibly
    // measure the same against a grey wall.
    const subject = ai.agents.find(
      (a) => a.alive && a.mesh && (!want || a.variantName === want));
    if (!subject) return { ok: false, why: `no live ${want ?? 'agent'}` };

    // Freeze the match, through the match's own switch.
    //
    // `agent.frozen` is written every tick by AiSystem from `match.frozen`, so
    // setting it per-agent holds for one tick and the subject then walks. He
    // drifted far enough each frame to re-trigger `reset()` — which sets
    // `group.visible = true` — so the reference pass that was supposed to have
    // no body in it photographed the body, and "contrast" came out at 0.0004.
    // `match.frozen` is a derived getter, so override it on the instance: this
    // is the same state the freeze phase puts fighters in, not a new one.
    if (!window.__FROZEN_PATCHED__) {
      Object.defineProperty(match, 'frozen', { get: () => true, configurable: true });
      window.__FROZEN_PATCHED__ = true;
    }

    // Everyone else off the set. The background band is sampled beside the
    // subject at the same heights, and the first staged frame put a second
    // soldier in it — so "the wall" the body was being compared against was
    // partly another body. Hidden, not moved: moving them would change the
    // lighting the subject sits in.
    for (const a of ai.agents) if (a !== subject && a.group) a.group.visible = false;

    const cam = e.ctx.camera;

    // Pin BOTH bodies every frame, do not merely place them once.
    //
    // `agent.frozen` is rewritten each tick by AiSystem from `match.frozen`, so
    // setting it here holds for exactly one frame and the subject then walks out
    // of shot during the settle. Re-asserting the pose every frame is the only
    // version of this that survives the systems that own these fields.
    const V3s = subject.position.constructor;
    const fwd = new V3s();
    const spot = new V3s();

    // `teleport` takes the EYE position, not the feet, and derives feet from the
    // standing eye height. Read that height off the live player rather than
    // hardcoding it, so a stance-tuning change cannot silently sink the camera
    // into the floor here.
    const eyeH = Math.max(0.5, player.eyePosition.y - player.position.y);

    const pin = () => {
      // `teleport` is the supported way to place the player: writing
      // `player.position` directly leaves the movement state machine holding the
      // old cell and it walks straight back, which is why the subject kept
      // ending up behind the camera.
      player.teleport({ x: org.x, y: org.y + eyeH, z: org.z }, yaw);
      player.velocity?.set(0, 0, 0);
      // Forward comes from the camera the frame is actually rendered with.
      //
      // Deriving it from the spawn yaw and an assumed (-sin, -cos) convention
      // put the subject exactly BEHIND the lens — which projects to five-figure
      // pixel coordinates that grow as the distance shrinks, the signature this
      // spent three staging rewrites producing. The camera cannot be wrong about
      // which way it is pointing.
      cam.updateMatrixWorld(true);
      cam.getWorldDirection(fwd);
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      spot.set(
        cam.position.x + (fwd.x / fl) * dist,
        org.y,
        cam.position.z + (fwd.z / fl) * dist
      );
      // Move the bot through `reset`, the same entry point `match` uses at a
      // round boundary. Assigning `agent.position` moves the logical bot and
      // leaves the physics character controller — which is what actually drives
      // the visual mesh — standing where it was: the body measured 6 m ahead
      // while the mesh was still 12 m away across the hall.
      // `reset()` un-hides the body, so it must not be called once the
      // reference pass has hidden it. With the match frozen the subject holds
      // position and this fires exactly once per staging.
      if (subject.group.visible && subject.position.distanceTo(spot) > 0.05) {
        // Facing the camera. World convention is forward = (-sin y, -cos y), so
        // looking back down the camera's own forward vector is y = atan2(fx, fz),
        // and the AI convention is that shifted by PI (see `aiYaw`). A subject
        // photographed side-on shows a different amount of plate carrier and
        // sleeve than one facing you, which changes the measurement.
        subject.reset(spot, Math.atan2(fwd.x, fwd.z) + Math.PI);
      }
      subject.velocity?.set(0, 0, 0);
      subject.frozen = true;
    };

    // Let the skinning, the shadow map and the TAA history settle on the staged
    // pose. A single frame after a teleport is a frame of motion blur and a
    // rejected TAA history, which measures the teleport rather than the body.
    for (let i = 0; i < 30; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
    pin();

    // The reference pass renders the identical staged scene with the subject
    // taken out, so the background can be read from exactly the pixels the body
    // will occupy. The first version compared the body against a band of wall
    // beside it, and that band landed on a doorway in one run and bare concrete
    // in the next — background luminance swung 0.28 to 0.59 between runs, which
    // is larger than the effect being measured. Same rect, same frame, no band.
    if (hidden) {
      subject.group.visible = false;
      for (let i = 0; i < 6; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
    }

    if (wantFlash) {
      // `tryFire()` is the entry point the observe driver uses; there is no
      // `setTrigger`, and calling a method that does not exist through `?.`
      // fires nothing and reports nothing. The first version of this did
      // exactly that and produced a "flash live" table whose flash irradiance
      // was zero in every row — a clean-looking A/B of one condition against
      // itself.
      const weapons = e.ctx.get('weapons');
      if (typeof weapons.tryFire !== 'function') return { ok: false, why: 'no weapons.tryFire' };
      if (weapons.ammo?.mag === 0) weapons.reload?.();

      // Let the round pass through the subject.
      //
      // He is standing dead centre of the bore by construction, so firing at
      // him kills him — and it did: the 12 m capture came back with "ENEMY
      // ELIMINATED" on screen and the body measured was a corpse mid-ragdoll.
      // Every 6 m and 12 m number from the first three flash runs was that.
      // Disabling his colliders for the shot puts the impact on the wall behind
      // him, which is where a missed round would have gone anyway.
      for (const c of subject.colliders ?? []) c.enabled = false;
      const fired = weapons.tryFire();
      for (const c of subject.colliders ?? []) c.enabled = true;
      if (!fired) return { ok: false, why: 'tryFire refused (cooldown or empty)' };
      // One frame for the light to be pushed into the pool, and stop on it:
      // the pooled flash decays over three or four frames, so waiting longer
      // photographs its tail rather than its peak.
      await new Promise((r) => requestAnimationFrame(r));
    }

    e.stop();

    // Where the body is on screen, from its own bones — never from pixel colour.
    // A colour-based mask would define the body as "the pale region", which is
    // precisely the thing in dispute.
    const cvs = e.ctx.get('render').renderer.domElement;
    const W = cvs.clientWidth;
    const H = cvs.clientHeight;
    const pts = [];
    subject.mesh.updateMatrixWorld(true);
    subject.mesh.traverse((o) => {
      if (o.isBone) {
        const p = o.matrixWorld.elements;
        pts.push({ x: p[12], y: p[13], z: p[14] });
      } else if (o.isSkinnedMesh && o.skeleton) {
        // Bones are not always children of the mesh root — a SkinnedMesh may
        // reference a skeleton whose root sits elsewhere in the graph, and
        // traversing the mesh then finds none at all.
        for (const b of o.skeleton.bones) {
          b.updateMatrixWorld(true);
          const p = b.matrixWorld.elements;
          pts.push({ x: p[12], y: p[13], z: p[14] });
        }
      }
    });
    // Project with three's own Vector3.project, reached through an existing
    // vector's constructor rather than a global. Hand-rolled projection here
    // dropped the off-diagonal terms of the projection matrix and produced
    // six-figure pixel coordinates that read as "the body is off screen".
    const tmp = new V3s();
    let behind = 0;
    const proj = pts.map((p) => {
      // Reject anything not in front of the lens BEFORE the divide. A point
      // behind the camera has negative w, and project() happily returns a
      // mirrored, enormous coordinate for it rather than failing — which is how
      // a mis-staged subject reported as a plausible-looking bounding box.
      tmp.set(p.x, p.y, p.z).applyMatrix4(cam.matrixWorldInverse);
      if (tmp.z > -0.05) { behind++; return null; }
      tmp.set(p.x, p.y, p.z).project(cam);
      return { x: (tmp.x * 0.5 + 0.5) * W, y: (1 - (tmp.y * 0.5 + 0.5)) * H };
    }).filter(Boolean);
    if (!proj.length) {
      return { ok: false, why: `body not in front of lens (${behind}/${pts.length} bones behind; subj ${subject.position.x.toFixed(1)},${subject.position.z.toFixed(1)} cam ${cam.position.x.toFixed(1)},${cam.position.z.toFixed(1)})` };
    }
    const meshW = new V3s();
    subject.mesh.getWorldPosition(meshW);

    const bx0 = Math.min(...proj.map((p) => p.x));
    const bx1 = Math.max(...proj.map((p) => p.x));
    const by0 = Math.min(...proj.map((p) => p.y));
    const by1 = Math.max(...proj.map((p) => p.y));

    // Live flash irradiance at the chest, in the renderer's own units.
    const fx = e.ctx.peek('fx');
    const sun = e.ctx.peek('sky')?.sunLight?.intensity ?? 0;
    let irr = 0;
    for (const en of fx?.lights?.lights ?? []) {
      const l = en.light;
      if (l.intensity <= 0.01) continue;
      const dd = Math.hypot(l.position.x - subject.position.x,
        l.position.y - (subject.position.y + 1.3), l.position.z - subject.position.z);
      const w = l.distance > 0 ? Math.max(0, 1 - (dd / l.distance) ** 4) ** 2 : 1;
      irr += (l.intensity * w) / Math.max(0.01, dd * dd);
    }

    // Is the subject actually in shot?
    //
    // Every number below is computed from pixels inside a box projected from the
    // subject's own bones, and a projection does not know about the wall in
    // front of it. With the subject occluded, "body pixels" and "background
    // pixels" are the same wall, so contrast collapses to zero and the tool
    // reports the most alarming result it has — for the one reason that has
    // nothing to do with legibility. Chest, not head: a head clear of a container
    // with the body behind it is not a readable target either.
    const chest = { x: subject.position.x, y: subject.position.y + 1.15, z: subject.position.z };
    const occluded = !ph0.lineOfSight(cam.position, chest, ph0.MASK.SIGHT);

    return {
      ok: true,
      occluded,
      clearRun: +clearRun.toFixed(1),
      stageYaw: +yaw.toFixed(3),
      depthSd: +depthSd.toFixed(2),
      camo: subject.variantName ?? subject.variant,
      name: subject.combatant?.name,
      box: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)],
      where: {
        cam: [+cam.position.x.toFixed(2), +cam.position.z.toFixed(2)],
        subj: [+subject.position.x.toFixed(2), +subject.position.z.toFixed(2)],
        mesh: [+meshW.x.toFixed(2), +meshW.z.toFixed(2)],
        fwd: [+fwd.x.toFixed(2), +fwd.z.toFixed(2)],
      },
      irr: +irr.toFixed(3), sun: +sun.toFixed(2), vsSun: sun > 0 ? +(irr / sun).toFixed(3) : null,
      // The WHOLE pool, not just what reaches the chest. `--noflash` no-ops
      // `fx.lights.flash` for every caller, so it disables impact and tracer
      // flashes as well as the muzzle one — an A/B against it therefore
      // implicates "some pooled light", and the only way to say which is to
      // list them all with their positions and cutoffs.
      pool: (fx?.lights?.lights ?? [])
        .filter((en) => en.light.intensity > 0.01)
        .map((en) => ({
          cd: +en.light.intensity.toFixed(2),
          cut: +en.light.distance.toFixed(2),
          dCam: +en.light.position.distanceTo(cam.position).toFixed(2),
          dBody: +Math.hypot(en.light.position.x - subject.position.x,
            en.light.position.y - (subject.position.y + 1.3),
            en.light.position.z - subject.position.z).toFixed(2),
        })),
      expo: +e.ctx.get('render').debugExposure().exposure.toFixed(3),
    };
  };
});

const rows = [];
for (const dist of DISTANCES) {
  // --- stage ---------------------------------------------------------------
  const staged = await page.evaluate(async (p) => window.__STAGE__(p),
    { dist, wantFlash: !!args.flash, hidden: false, want: WANT, against: AGAINST });

  if (!staged.ok) { rows.push({ d: dist, status: staged.why }); continue; }
  // Refuse to measure a body that is not visible, rather than measuring the wall
  // in front of it and calling the answer "contrast 0.0018".
  if (staged.occluded) {
    rows.push({
      d: dist,
      status: `OCCLUDED — geometry between the camera and the chest at ${dist} m ` +
        `(longest clear ray from this spawn is ${staged.clearRun} m)`,
    });
    await page.evaluate(() => {
      const e = window.__ENGINE__;
      for (const a of e.ctx.get('ai').agents) if (a.group) a.group.visible = true;
      e.start();
    });
    continue;
  }

  const tag = `d${String(dist).replace('.', '_')}`;
  const buf = await page.screenshot({ path: join(OUT, `${tag}.png`) });
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    for (const a of e.ctx.get('ai').agents) if (a.group) a.group.visible = true;
    e.start();
  });

  // Same staging again with the subject removed: the reference for what is
  // behind him, read from the very pixels he covers.
  const ref = await page.evaluate(async (p) => window.__STAGE__(p),
    { dist, wantFlash: !!args.flash, hidden: true, want: WANT, against: AGAINST });
  if (!ref.ok) { rows.push({ d: dist, status: `reference pass: ${ref.why}` }); continue; }
  const refBuf = await page.screenshot({ path: join(OUT, `${tag}-bg.png`) });
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    for (const a of e.ctx.get('ai').agents) if (a.group) a.group.visible = true;
    e.start();
  });

  // --- measure -------------------------------------------------------------
  const png = PNG.sync.read(buf);
  const refPng = PNG.sync.read(refBuf);
  const [x0, y0, x1, y1] = staged.box;
  // The bone hull is a skeleton, not a silhouette: it runs down the middle of
  // the limbs and misses every outer surface. Inset rather than outset, and
  // sample the torso column only, so no wall pixel can leak into the body mean.
  const cx = (x0 + x1) / 2;
  const halfW = Math.max(2, (x1 - x0) * 0.28);
  const bodyRect = [Math.round(cx - halfW), Math.round(y0 + (y1 - y0) * 0.12),
    Math.round(cx + halfW), Math.round(y0 + (y1 - y0) * 0.55)];
  const stat = (png, r) => {
    let n = 0, lum = 0, lum2 = 0, sat = 0, clip = 0;
    for (let y = Math.max(0, r[1]); y < Math.min(png.height, r[3]); y++) {
      for (let x = Math.max(0, r[0]); x < Math.min(png.width, r[2]); x++) {
        const i = (y * png.width + x) * 4;
        const R = png.data[i] / 255, G = png.data[i + 1] / 255, B = png.data[i + 2] / 255;
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        lum += L; lum2 += L * L;
        sat += mx > 0 ? (mx - mn) / mx : 0; if (L > 0.95) clip++;
        n++;
      }
    }
    if (!n) return null;
    const mean = lum / n;
    return {
      n, L: +mean.toFixed(4),
      // Luma spread inside the rect. On the BACKGROUND rect this is the number
      // that matters and the mean is not: a wall whose own mottling swings as
      // widely as the body-to-wall step is a wall the body does not stand out
      // from, however favourable the means look. Mean contrast can read healthy
      // while a target is genuinely hard to pick up, and this is the term that
      // tells the two apart.
      sd: +Math.sqrt(Math.max(0, lum2 / n - mean * mean)).toFixed(4),
      sat: +(sat / n).toFixed(4), clip: +(clip / n).toFixed(4),
    };
  };

  const body = stat(png, bodyRect), bg = stat(refPng, bodyRect);
  if (!body || !bg) {
    rows.push({ d: dist, status: `sample off screen — box ${staged.box.join(',')} png ${png.width}x${png.height} where ${JSON.stringify(staged.where)}` });
    continue;
  }
  const contrast = +(Math.abs(body.L - bg.L) / Math.max(body.L, bg.L, 1e-6)).toFixed(4);
  rows.push({
    d: dist, camo: staged.camo, vsSun: staged.vsSun, expo: staged.expo,
    // How broken the chosen backdrop is, in metres of depth spread. 0 on `wall`
    // by construction; the whole point of a `clutter` row is that this is large.
    depthSd: staged.depthSd,
    bodyL: body.L, bgL: bg.L, contrast,
    // Signal-to-clutter: the body-to-wall luma step against the wall's own
    // spread. Below 1 the target is a smaller change than the surface behind it
    // varies by on its own, which is what a mottled wall does to a silhouette.
    snc: +(Math.abs(body.L - bg.L) / Math.max(bg.sd, 1e-6)).toFixed(2),
    bgSd: bg.sd, sat: body.sat, clip: body.clip, px: body.n,
    pool: (staged.pool ?? []).map((l) => `${l.cd}cd/r${l.cut}@${l.dBody}m`).join(' ') || '-',
  });
}

await page.evaluate(() => {
  const ai = window.__ENGINE__.ctx.get('ai');
  for (const a of ai.agents) { a.frozen = false; if (a.group) a.group.visible = true; }
});

writeFileSync(join(OUT, 'legibility.json'), JSON.stringify(rows, null, 2));
console.table(rows);
if (errors.length) console.log('errors:\n' + errors.slice(0, 5).join('\n'));

// A row that never produced a measurement is a failure of the tool, and must
// not be allowed to read as a pass. `Math.min` over an all-undefined set with a
// `?? 1` fallback reported "OK, min contrast 1.000" for four staging errors.
const measured = rows.filter((r) => typeof r.contrast === 'number');
/**
 * Above this many body pixels, size carries detection and contrast does not
 * govern.
 *
 * The header already makes this argument for `snc` and then the gate ignored it
 * for `contrast`, so every run ended "LEGIBILITY WARN — 1.5m contrast 0.041 ·
 * 3m contrast 0.068" for a body covering 22,386 and 5,168 pixels. Nobody fails
 * to see a man occupying a quarter of the screen because he happens to match the
 * wall's luminance, and a warning that fires on every clean run is a warning
 * nobody reads by the third time.
 *
 * 1500 px sits between the 3 m row (5,168) and the 12 m row (306), which is the
 * gap between "fills the view" and "a shape you have to pick out". The ranges
 * this tool exists to police are the far ones.
 *
 * `clip` is gated at every distance regardless: a body washed to white is a
 * defect whether it is near or far.
 */
const SIZE_CARRIES = 1500;
/**
 * A floor for `snc`, not a quality target.
 *
 * Six staged measurements across both backdrops span 1.26 to 1.93, and a
 * threshold set anywhere in that band would be a threshold set on six samples.
 * 0.8 sits well below all of them and above the only thing worth catching: a
 * body whose luminance step against its background has fallen below the
 * background's own mottling, which is the state where a silhouette genuinely
 * disappears. It exists so that a lighting or material change that collapses
 * clutter legibility cannot pass while `contrast` still looks healthy — the two
 * numbers came apart in exactly that direction at 12 m, where the flat wall
 * scored the WORSE snc of the pair despite the better-looking mean.
 */
const SNC_FLOOR = 0.8;
const bad = measured.filter(
  (r) => ((r.contrast < 0.08 || r.snc < SNC_FLOOR) && (r.px ?? 0) < SIZE_CARRIES)
    || r.clip > 0.15
);
// Exit codes, because this is in `npm test` now.
//
// It used to end on a console.log and exit 0 whatever it found, which is fine
// for a tool you run by hand and read, and useless in an `&&` chain — the suite
// would have gone green through a staging break that reported every distance as
// unmeasurable. UNRESOLVED means the tool did not answer the question and is the
// harder failure of the two; WARN means it answered and the answer is bad.
let code = 0;
if (measured.length !== rows.length) {
  console.log(`LEGIBILITY UNRESOLVED — ${rows.length - measured.length}/${rows.length} distances did not measure: `
    + rows.filter((r) => !('contrast' in r)).map((r) => `${r.d}m ${r.status}`).join(' · '));
  code = 1;
} else if (bad.length) {
  console.log(`LEGIBILITY WARN — vs ${AGAINST}: `
    + bad.map((b) => `${b.d}m contrast ${b.contrast} snc ${b.snc} clip ${b.clip}`).join(' · '));
  code = 1;
} else {
  // Report BOTH numbers over the same subset: the distances where the target is
  // small enough that these metrics govern detection at all.
  //
  // `snc` was already filtered by SIZE_CARRIES and `contrast` was not, so the
  // headline figure came from whichever row had the smallest contrast — always
  // the 1.5 m one, where this file's own header says the metric is meaningless
  // because the body covers a quarter of the screen. Worse, at that range body
  // and backdrop sit within 0.005 of each other in luminance, so the printed
  // number is the difference of two nearly equal means: measured over six runs
  // it wandered 0.005 to 0.042 while 12 m held 0.24-0.28 and 24 m held
  // 0.29-0.34. Nine times the spread, from the one row that cannot fail.
  //
  // That number was read as the game's legibility floor — by me, twice — and
  // taken as evidence of an exposure-dependent measurement bug that does not
  // exist: `expo` moves 10.0-11.3 across those runs and the far distances barely
  // follow it. The gate was always correct (it applies the same SIZE_CARRIES
  // rule); only the line a human reads was wrong.
  const governed = measured.filter((r) => (r.px ?? 0) < SIZE_CARRIES);
  const worstSnc = Math.min(...governed.map((r) => r.snc));
  const worstContrast = Math.min(...governed.map((r) => r.contrast));
  console.log(`LEGIBILITY OK — ${measured.length} distances vs ${AGAINST}`
    + ` (${governed.length} where size does not carry)`
    + (Number.isFinite(worstContrast) ? `, min contrast ${worstContrast.toFixed(3)}` : '')
    + (Number.isFinite(worstSnc) ? `, min snc ${worstSnc.toFixed(2)}` : '')
    + (AGAINST === 'clutter'
      ? ` · backdrop depth spread ${Math.max(...measured.map((r) => r.depthSd ?? 0)).toFixed(1)} m`
      : ''));
}

await browser.close();
killServer(vite);
process.exit(code);
