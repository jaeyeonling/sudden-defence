#!/usr/bin/env node
/**
 * FRIEND / FOE — can you tell which team a man belongs to before he shoots you?
 *
 * In an elimination mode this is not a polish item, it is the mode. Every round
 * is spent deciding, under time pressure, whether a shape at the end of a lane
 * is a teammate or a target. If that decision needs a second look, the mode does
 * not work, and no amount of round tuning will fix it.
 *
 * `match/teams.js` used to claim the job was done by the variant system: one
 * visual variant per team, wolf grey against tan, different helmets, a beard on
 * one side. Staged and measured, that claim was false. The chest pixels of the
 * two team uniforms sat at a chromaticity distance of 0.0123 — for scale, the
 * spawn bay paint gate in `tools/markings.mjs` demands 0.100, and the BROKEN
 * state that gate was written to catch measured 0.036. The two sides were, to
 * the eye and to the meter, the same colour. They had to be: both camo families
 * are calibrated into the same 0.16-0.32 albedo window, because that window is
 * most of what stops a procedural character reading as a plastic toy.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY CHROMATICITY AND NOT LUMINANCE
 *
 * `cr = R/(R+G+B)`, `cg = G/(R+G+B)`. Dividing by the sum cancels any common
 * scale factor, so the number does not move when a body walks from the lit
 * centre of the hall into a shadow. Luminance does — by more than any uniform
 * difference — which is exactly why "one side is darker" is not a usable team
 * read in a map with a 6 m roof and hard sun through the roof lights. The same
 * reasoning, and the same formula, is what `tools/markings.mjs` uses on floor
 * paint. Two gates, one definition of "different colour".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY ONE MAN AT A TIME, IN THE SAME SPOT
 *
 * The obvious staging — stand the two of them side by side and photograph both
 * — is the one that produced the first, wrong, answer of 0.025. Two failures at
 * once, and the second is the instructive one:
 *
 *  - The roster was populated at `perTeam: 4`, and only two of the eight were
 *    ever placed. One of the other six was standing a metre from the lens. Both
 *    sample points landed on THAT man, so the run compared a soldier with
 *    himself and reported the difference as a team separation.
 *  - Even with the roster fixed, two positions are two lighting environments.
 *    A metre of lateral offset changes which roof light dominates, and the
 *    resulting chroma shift is the same order as the effect under test.
 *
 * So each team's man is staged at the SAME point, with the SAME yaw, and
 * photographed alone. Everything except the uniform is held identical by
 * construction rather than by hope, and every other agent is hidden on every
 * frame — `Agent.reset()` restores `group.visible`, so hiding once does nothing
 * (the bug that made `tools/markings.mjs` bimodal for a week).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A DIFFERENCE MASK AND NOT A FIXED RECT
 *
 * A rect over the chest also catches the wall past his shoulder, the sling, and
 * a slice of floor — and it catches DIFFERENT amounts of each for the two
 * variants, because their silhouettes differ on purpose. Instead each team is
 * photographed twice, identical frames apart from one `visible` flag, and only
 * the pixels that actually changed are counted. The body is located by what it
 * occludes, which is independent of what colour it turned out to be. That is
 * the same anti-question-begging rule `tools/legibility.mjs` follows.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE GATE IS ON THE HELMET AND NOT ON THE WHOLE MAN
 *
 * Averaged over every body pixel the finished team read separates by 0.021,
 * against 0.012 with no team colour at all. That is not a failure, it is what
 * averaging a silhouette does: the mark is a few percent of the light the body
 * returns, so it can only shift the mean by a few percent of its own saturation.
 * Clearing any useful bar that way would need a third of the man to be saturated
 * colour, which in this map cannot be bought — the uniform's albedo is 0.09 and
 * raising it is precisely what the budget in `ai/soldier.js` exists to prevent.
 *
 * It is also not how the read works. Nobody integrates a silhouette and compares
 * means; the eye finds the one saturated patch and the team is known.
 *
 * Selecting that patch by SATURATION was tried and is a trap — measured, the
 * most saturated pixels on BOTH teams came back at cr 0.14, blue, for the red
 * side as well. Those are shadowed pixels lit by sky ambient alone, which is
 * bluer than any uniform. Ranking by colour finds the lighting, not the mark.
 *
 * Selecting it by MATERIAL was tried too — hide the `team` material for one pass
 * and the pixels that change are exactly the mark. That is rigorous and it does
 * not work here: auto-exposure responds to the scene's mean luminance, so
 * removing the mark shifts every pixel in the frame slightly and the difference
 * mask covers the whole body. Any difference-mask reading in this engine is only
 * as good as the exposure being pinned.
 *
 * So the region is chosen by LOCATION, in the HEAD BONE'S OWN FRAME: a box
 * riding the helmet dome. Position is independent of what colour the answer
 * turns out to be, which keeps the measurement from begging its own question,
 * and expressing it in the bone's frame keeps it on the dome while idle
 * animation turns and tilts the head. A world-space box does not: it read 0.0912
 * and 0.1109 on the same build, and the swing tracked the pixel count exactly as
 * the dome slid in and out of a fixed rect.
 *
 * The box is deliberately small enough to sit WHOLLY INSIDE the dome. A region
 * strictly inside the mark cannot change what it contains when the mark moves —
 * that, rather than averaging, is what makes this repeatable. It costs pixels,
 * which is why the capture runs at deviceScaleFactor 2.
 *
 * The whole-body figure is reported on every line as context, and as the thing
 * that would catch a uniform quietly reverting to grey.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CONTROLS
 *
 *   --noaccent   strip the team colour (see `AiSystem._accentFor`) and measure
 *                the floor. Run this before ever touching MIN_CHROMA.
 *   --dome=0.11  height of the sample box in the head bone's frame, metres.
 *   --q=...      quality override, for attributing the frame.
 *   --shots      write the staged frames to shots/ff-<team>.png.
 *
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const PORT = process.env.PORT || 5173;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

/**
 * The distance the gate is argued at.
 *
 * 9 m is a lane crossing in this map, not a sniping range: it is about the
 * distance at which two men enter the same bay from opposite doors. If the team
 * read fails here it has failed everywhere that matters, and unlike a long
 * range figure it is not dominated by how many pixels the body happens to cover.
 */
const DIST = +(args.dist ?? 9);

/**
 * Minimum chromaticity distance between the two teams' marks.
 *
 * SET FROM THE MEASURED DISTRIBUTION, not inherited. The first draft of this
 * gate used 0.100 on the argument that a player should not have to learn that
 * "team colour" means one thing on the floor and a weaker thing on a man, so it
 * borrowed the spawn-bay paint figure from `tools/markings.mjs`. That argument
 * is wrong about the physics. Bay paint is a large flat slab under direct light;
 * a helmet is a small curved surface, mostly in its own shade, seen from below.
 * Measured, the dome cannot reach 0.100 under this hall's light without pushing
 * the marker to a brightness that reads as a toy — and the gate would sit inside
 * the run-to-run noise, which is what it did: 0.0912 in one run and 0.1109 in
 * the next, failing and passing the same build.
 *
 * So the threshold comes from the two ends actually measured, with the
 * `--noaccent` control on one side:
 *
 *     no team colour at all   0.0024   (whole body 0.0121 — the state the user
 *                                       reported, and the original diagnosis)
 *     shipped                 0.074 - 0.088   (run to run)
 *
 * 0.050 sits about twenty times above the floor and comfortably below the worst
 * observed pass. It cannot be reached by the two variants' own difference, so
 * anything that quietly drops the accent — a lost material slot, a reverted
 * tint, a variant reassigned — fails it immediately, which is the entire job.
 *
 * Re-derive it rather than nudge it: `--noaccent` gives the floor, three plain
 * runs give the ceiling and the spread.
 */
const MIN_CHROMA = +(args.min ?? 0.05);

/**
 * How different a pixel must be between the two passes to count as body.
 *
 * Well above the renderer's own frame-to-frame noise (TAA jitter and the
 * temporal AO history never settle to exactly zero), and well below any real
 * silhouette edge. Measured noise on an unchanged frame pair is under 0.004.
 */
const MASK_EPS = 0.02;

// THE SERVER THIS TOOL USED TO ASSUME. Every sibling harness spawns vite when
// port 5173 is closed and kills it on exit; this one just navigated, and it
// PASSED for as long as it did by riding servers LEAKED by earlier harness
// crashes — an uncaught exception skips the `process.kill(-vite.pid)` cleanup,
// the orphan keeps listening, and the next tool in the chain finds the port
// open. Kill the orphan and this gate fails with ERR_CONNECTION_REFUSED on a
// perfectly healthy build, which is how the dependency was finally noticed.
// Same block as `botfight.mjs`, `OW_NO_HMR` included — see the note there.
const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
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
// deviceScaleFactor 2, and it is not cosmetic. The mark region has to be small
// enough to sit wholly inside the helmet dome (see the staging note) and at 9 m
// that is a box about 0.18 x 0.10 m — 24 pixels at 1600x900, which is too few to
// average anything from. Doubling the capture scale buys 4x the samples for the
// same staged geometry.
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
});

// `?capture=1` for the deterministic engine seed only. The world's dressing pass
// forks that rng, so without it two runs light the same hall with different
// surfaces and the measurement moves for reasons that have nothing to do with
// uniforms. Capture mode also switches off the round loop and `ai.populate()`,
// and this gate needs both back — see `tools/legibility.mjs` for why the flag
// alone is not enough and `populate()` has to be called by hand.
// `--q=volumetrics=0` appends a quality override, for attributing where the
// team colour is being washed out of the frame.
const EXTRA = args.q ? `&${args.q}` : '';
// BEFORE the navigation, not after. `addInitScript` installs a hook that runs on
// the NEXT document, so registering it after `goto` silently does nothing to the
// page already loaded. A dome-height sweep and a no-accent control were both run
// that way and both reported "no effect" — which was true of the harness, not of
// the game, and very nearly got the whole approach abandoned.
await page.addInitScript((v) => { window.__DOME_UP__ = v; }, +(args.dome ?? 0.105));
await page.addInitScript((v) => { window.__NO_ACCENT__ = v; }, !!args.noaccent);
await page.goto(`http://127.0.0.1:${PORT}/?capture=1${EXTRA}`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

await page.evaluate(() => {
  const ai = window.__ENGINE__.ctx.get('ai');
  ai.forcePopulate = true;
  // 2, not 1: `perTeam` counts FIGHTERS, and the player already holds an alpha
  // seat, so `perTeam: 1` fields no alpha bot at all and the staging finds
  // nobody to photograph. Keep the roster as small as that allows — every extra
  // body is one more thing that can walk into frame, and while the staging does
  // hide them all on every frame, a short roster makes the failure impossible
  // rather than merely handled.
  if (!ai.agents.length) ai.populate({ perTeam: 2 });
  window.__ENGINE__.ctx.get('match').startMatch();
});

await page.waitForFunction(
  () => window.__ENGINE__.ctx.get('match').phase === 'live',
  null,
  { timeout: 60000 }
);

await page.evaluate(() => {
  const DOME_UP = window.__DOME_UP__ ?? 0.105;
  window.__STAGE_FF__ = async ({ team, dist, hidden, markOff }) => {
    const e = window.__ENGINE__;
    const ai = e.ctx.get('ai');
    const player = e.ctx.get('player');
    const cam = e.ctx.camera;
    const subject = ai.agents.find((a) => a.team === team && a.alive);
    if (!subject) return null;

    const V3 = subject.position.constructor;
    const fwd = new V3();
    const spot = new V3();
    // Fixed origin and yaw, shared by both teams. The whole design rests on
    // these two numbers being identical across the two staging calls.
    const org = { x: 0, y: 0, z: -6 };
    const yaw = 0;
    const eyeH = Math.max(0.5, player.eyePosition.y - player.position.y);

    const pin = () => {
      player.teleport({ x: org.x, y: org.y + eyeH, z: org.z }, yaw);
      player.velocity?.set(0, 0, 0);
      // Forward is read off the camera that actually renders the frame rather
      // than derived from `yaw` and an assumed convention — the convention is
      // easy to get backwards, and getting it backwards puts the subject behind
      // the lens where it still projects to plausible-looking coordinates.
      cam.updateMatrixWorld(true);
      cam.getWorldDirection(fwd);
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      spot.set(cam.position.x + (fwd.x / fl) * dist, org.y, cam.position.z + (fwd.z / fl) * dist);

      for (const a of ai.agents) {
        if (a === subject) continue;
        // Every frame, not once: `reset()` sets `visible` back to true, and the
        // round loop resets bodies whenever it feels like it.
        a.group.visible = false;
        a.frozen = true;
        a.velocity?.set(0, 0, 0);
      }
      // `reset()` un-hides, so it must not run during the reference pass.
      if (!hidden && subject.position.distanceTo(spot) > 0.05) {
        subject.reset(spot, Math.atan2(fwd.x, fwd.z) + Math.PI);
      }
      subject.velocity?.set(0, 0, 0);
      subject.frozen = true;
      subject.group.visible = !hidden;
      // The mark pass. Hiding one material of a multi-material mesh drops
      // exactly its geometry group, so the pixels that differ from the full
      // frame ARE the mark — no box, no colour threshold, nothing that moves
      // when the man breathes.
      const mats = Array.isArray(subject.mesh?.material) ? subject.mesh.material : [];
      for (const m of mats) if (m.name === 'ai_team') m.visible = !markOff;
    };

    for (let i = 0; i < 30; i++) {
      pin();
      await new Promise((r) => requestAnimationFrame(r));
    }
    pin();

    const p = subject.position;
    const right = new V3(-fwd.z, 0, fwd.x).normalize();
    const box = (cx, cy, cz, halfW, halfH) => {
      const corners = [];
      for (const dy of [-halfH, halfH]) {
        for (const dx of [-halfW, halfW]) {
          const v = new V3(cx + right.x * dx, cy + dy, cz + right.z * dx);
          v.project(cam);
          corners.push([(v.x + 1) / 2, (1 - v.y) / 2]);
        }
      }
      return {
        u0: Math.min(...corners.map((c) => c[0])),
        u1: Math.max(...corners.map((c) => c[0])),
        v0: Math.min(...corners.map((c) => c[1])),
        v1: Math.max(...corners.map((c) => c[1])),
      };
    };

    // The mark region rides the HEAD BONE'S OWN FRAME, not a world-space box
    // above his feet. Both matter, and the second one is what this gate was
    // failing on: with a fixed world box the reading swung 0.0912 to 0.1109 run
    // to run, and the swing tracked the bravo pixel count (70 to 84) exactly.
    // Idle animation tilts and turns the head a few degrees, the dome slides
    // inside a fixed box, and the box starts sampling brow, chin strap and
    // background instead. Expressing the offset in the bone's local frame makes
    // the sample follow the helmet through the animation.
    //
    // The box is also deliberately small enough to sit WHOLLY INSIDE the dome.
    // A region strictly inside the mark cannot change what it contains when the
    // mark moves; that, rather than any averaging, is what makes this repeatable.
    const headBone = subject.bones?.find?.((x) => x.name === 'Head');
    const h = new V3();
    if (headBone) headBone.localToWorld(h.set(0, DOME_UP, 0));
    else h.set(p.x, p.y + 1.735, p.z);

    return {
      body: box(p.x, p.y + 0.92, p.z, 0.6, 1.0),
      mark: box(h.x, h.y, h.z, 0.085, 0.05),
    };
  };
});

const shoot = async (team, opts) => {
  const rect = await page.evaluate(
    (o) => window.__STAGE_FF__(o),
    { team, dist: DIST, hidden: false, markOff: false, ...opts }
  );
  return { rect, buf: await page.screenshot() };
};

const results = {};
for (const team of ['alpha', 'bravo']) {
  const lit = await shoot(team, {});
  if (!lit.rect) {
    console.error(`FRIENDFOE FAIL — no live ${team} fighter to stage`);
    await browser.close();
    if (vite) try { process.kill(-vite.pid); } catch { /* already gone */ }
    process.exit(1);
  }
  const bg = await shoot(team, { hidden: true });
  if (args.shots) writeFileSync(`shots/ff-${team}.png`, lit.buf);

  const A = PNG.sync.read(lit.buf);
  const B = PNG.sync.read(bg.buf);
  /** Mean chromaticity of the subject's own pixels inside one projected rect. */
  const region = ({ u0, u1, v0, v1 }) => {
    const x0 = Math.max(0, Math.round(u0 * A.width));
    const x1 = Math.min(A.width, Math.round(u1 * A.width));
    const y0 = Math.max(0, Math.round(v0 * A.height));
    const y1 = Math.min(A.height, Math.round(v1 * A.height));
    let R = 0, G = 0, Bl = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * A.width + x) * 4;
        const ar = A.data[i] / 255, ag = A.data[i + 1] / 255, ab = A.data[i + 2] / 255;
        const br = B.data[i] / 255, bg2 = B.data[i + 1] / 255, bb = B.data[i + 2] / 255;
        // Subject pixels only: the ones he actually occluded.
        if (Math.abs(ar - br) + Math.abs(ag - bg2) + Math.abs(ab - bb) < MASK_EPS) continue;
        R += ar; G += ag; Bl += ab; n++;
      }
    }
    const t = Math.max(R + G + Bl, 1e-6);
    return {
      n,
      L: +(0.2126 * (R / n) + 0.7152 * (G / n) + 0.0722 * (Bl / n)).toFixed(3),
      cr: R / t,
      cg: G / t,
    };
  };

  const body = region(lit.rect.body);
  const mark = region(lit.rect.mark);
  if (body.n < 800 || mark.n < 120) {
    console.error(
      `FRIENDFOE FAIL — ${team} resolved to ${body.n} body / ${mark.n} mark pixels; ` +
        `the staging did not put a man on camera`
    );
    await browser.close();
    if (vite) try { process.kill(-vite.pid); } catch { /* already gone */ }
    process.exit(1);
  }
  results[team] = { body, mark };
}

const a = results.alpha, b = results.bravo;
const dist = Math.hypot(a.mark.cr - b.mark.cr, a.mark.cg - b.mark.cg);
const whole = Math.hypot(a.body.cr - b.body.cr, a.body.cg - b.body.cg);
const detail =
  `mark ${a.mark.n}/${b.mark.n}px · alpha cr/cg ${a.mark.cr.toFixed(3)}/${a.mark.cg.toFixed(3)} ` +
  `vs bravo ${b.mark.cr.toFixed(3)}/${b.mark.cg.toFixed(3)} · ` +
  `whole-body separation ${whole.toFixed(4)} (L ${a.body.L}/${b.body.L})`;

await browser.close();
if (vite) try { process.kill(-vite.pid); } catch { /* already gone */ }

if (dist < MIN_CHROMA) {
  console.error(
    `FRIENDFOE FAIL — team mark separation ${dist.toFixed(4)} at ${DIST} m, ` +
      `need ${MIN_CHROMA} · ${detail}`
  );
  process.exit(1);
}
console.log(
  `FRIENDFOE OK — team mark separation ${dist.toFixed(4)} at ${DIST} m ` +
    `(min ${MIN_CHROMA}) · ${detail}`
);
