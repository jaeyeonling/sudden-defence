#!/usr/bin/env node
/**
 * MARKINGS — does the painted floor still do its job?
 *
 * `world/warehouse.js:floorMarkings` gives the paint three jobs, and two of them
 * are gameplay claims rather than decoration:
 *
 *   2. Orientation. The map is mirrored about Z, so the two halves are
 *      geometrically identical. The per-team spawn bay colour is THE ONLY
 *      asymmetry in the level — it is how a player who has turned around twice
 *      knows which end is his.
 *   3. Route reading. The lane walkway lines and the hazard hatching at each bay
 *      mouth are how the three routes read off the floor.
 *
 * Both failed silently for the whole life of this map and nothing caught it.
 * Measured on the shipped build: the alpha bay rendered hue 230 degrees and the
 * bravo bay 225 degrees — five degrees apart, against a 197-degree difference
 * between their source tints — and the yellow hazard bars rendered hue 213 at
 * Weber contrast 0.008 against the slab they sit on. Blue paint, red paint and
 * yellow paint all arrived on screen as the same grey-blue.
 *
 * The cause was not the paint. `interiorIndirect` was 0.035, a number tuned on a
 * 120 m outdoor map where "interior" meant a shop off a sunlit street; under a
 * roofed depot it is the exposure of the entire game. The bay was rendering at
 * 1/46th of the scene radiance the same material produces unoccluded, and at
 * that level the grade's shadowTint (+0.022 blue) is larger than the albedo
 * signal. Every hue in the level collapsed toward the tint of the shadows.
 *
 * That is a whole-renderer parameter, so anything that touches lighting,
 * tone mapping or the grade can silently undo it. Hence a gate.
 *
 * WHY IT MEASURES THE GRADED SCREENSHOT AND NOT SCENE RADIANCE: the claim is
 * about what a player can tell apart, and the tone curve and grade are between
 * the renderer and the player. A version of this that measured pre-post radiance
 * would have passed happily while the grade flattened the frame.
 *
 * WHY SAMPLE POINTS ARE PROJECTED AND NOT TYPED IN: picking rectangles off a
 * capture by eye is how, during this investigation, the back wall got measured
 * as the floor twice and a roof deck got measured as a spawn bay once. The
 * sample box is projected from a world coordinate, and a region whose luminance
 * spread is too high is reported as a STRADDLE failure rather than averaged into
 * a meaningless number.
 *
 *   node tools/markings.mjs [--port=5173] [--out=shots/markings]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const KNOWN = new Set(['port', 'out']);
for (const k of Object.keys(args)) {
  if (!KNOWN.has(k)) {
    console.error(`unknown flag --${k}; known: ${[...KNOWN].join(', ')}`);
    process.exit(2);
  }
}
const PORT = Number(args.port ?? 5173);
const OUT = String(args.out ?? 'shots/markings');
const W = 1600;
const H = 900;

/**
 * What to measure, and from where.
 *
 * Each entry names a shot, a world point on the surface under test, and what
 * that surface is supposed to look like. The two bays are photographed from
 * their own dedicated shots because neither `spawn` nor `boot` can see a bay:
 * both stand ON one looking up the map.
 */
// x = -4, not 0: both bay shots look straight down their own bay, so x = 0 is
// the screen centre and the screen centre is where the crosshair is drawn. The
// first version sampled the reticle and the straddle guard below caught it.
// -4 is still a hazard-bar centre (the bars are laid at x = i * 2.0).
// `box` is [half-width, half-height] in NDC. The hazard bars are 1.0 m wide and
// only 0.16 m deep, so at 4.6 m they are a few pixels tall: a square sample box
// straddled the slab and its luminance swung between 0.27 and 0.15 across runs.
// A wide, short box stays on the bar.
const SUBJECTS = [
  { shot: 'bay_alpha', name: 'alpha bay', point: [-4, 0.021, -16.4], key: 'alpha', box: [0.006, 0.006] },
  { shot: 'bay_bravo', name: 'bravo bay', point: [-4, 0.021, 16.4], key: 'bravo', box: [0.006, 0.006] },
  { shot: 'bay_bravo', name: 'hazard bar', point: [-4, 0.023, 14.6], key: 'hazard', box: [0.016, 0.0025] },
  { shot: 'bay_bravo', name: 'slab', point: [-4, 0.001, 12.6], key: 'slab', box: [0.016, 0.006] },
];

/**
 * Thresholds, in CIE-style chromaticity distance (see chromaDist below).
 * Calibrated against both states of the defect this gate exists for; the
 * measured numbers are printed in the OK/FAIL line so a drift is legible
 * without re-deriving them.
 */
// Measured on the shipped build, four consecutive runs, identical to three
// decimals now that the seed is pinned: bay 0.165, hazard contrast 0.21 /
// colour 0.067. The defect state this gate was written against measured bay
// 0.036. 0.100 sits between them with room on both sides — well clear of the
// broken reading, and far enough below the healthy one that retinting the paint
// or retuning the grade does not fail the suite for no reason.
const BAY_SEP = 0.100;
const HAZ_SEP = 0.020;
const HAZ_CONTRAST = 0.15;
/**
 * Maximum luminance spread inside a sample box before it is treated as
 * straddling two surfaces rather than measuring one.
 */
const SD_CEIL = 0.12;

const vite = await ensureServer(PORT, { name: 'MARKINGS' });
const stopVite = () => killServer(vite);

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const fail = async (msg) => {
  console.error(`MARKINGS FAIL — ${msg}`);
  await browser.close();
  stopVite();
  process.exit(1);
};

/**
 * `?capture=1` — deterministic engine seed.
 *
 * `core/engine.js` seeds `ctx.rng` from `Math.random()` unless capture mode is
 * on, and the world's dressing pass forks that rng to pick surface variants. So
 * two loads of the same build render the same level with different materials on
 * the same props: diffing two captures of this shot showed the pair of leaning
 * barriers flanking the bravo bay swapping between grey concrete and a dark red
 * marble, which moves the bounce onto the floor beside them. The hazard-bar
 * contrast in this gate's own report read 0.04 on one run and 0.22 on the next
 * from that alone. The paint is not seeded, so the bay figure was unaffected —
 * but a colour gate should not be reading a different room each time it runs.
 *
 * Capture mode also stops the match auto-starting (`match/index.js`), which
 * removes round transitions and the `Agent.reset()` that comes with them.
 */
await page.goto(`http://127.0.0.1:${PORT}/?capture=1`, { waitUntil: 'load' });
await waitForReady(page, { name: 'MARKINGS' });
/**
 * Settle by SIMULATED SECONDS, not by frame count.
 *
 * The auto exposure adapts on `dt`, and this project's engine runs a variable
 * timestep, so a fixed number of frames is a variable amount of adaptation. On
 * a quiet machine 90 frames is about 0.75 s of it; on a loaded one — this
 * machine hosts other repositories' dev servers, and `tools/converge.mjs`
 * reported 60 fps instead of 120 in the same suite run — the same 90 frames is
 * 1.5 s, a different exposure, a different place on the tone curve, and a
 * different amount of the grade's blue shadowTint riding on the darks.
 *
 * Measured: standalone, five runs gave bay separation 0.143-0.145 and hazard
 * colour 0.042-0.046. Inside a loaded `npm test` the same build measured 0.121
 * and 0.003 — the hazard figure a twentieth of its usual value, and low enough
 * that the gate passed on its other arm rather than on the thing it is named
 * for. A colour gate whose reading depends on what else is running on the box
 * is not measuring the renderer.
 *
 * The frame cap is a backstop: if the page stalls, fail on the timeout above
 * rather than spin here forever.
 */
const settle = (seconds) => page.evaluate(
  (s) => new Promise((r) => {
    const e = window.__ENGINE__;
    const t0 = e.time.elapsed;
    let frames = 0;
    const tick = () => (
      (e.time.elapsed - t0 >= s || ++frames > 2000)
        ? r(+(e.time.elapsed - t0).toFixed(2))
        : requestAnimationFrame(tick)
    );
    requestAnimationFrame(tick);
  }), seconds);

/** Saturation-weighted circular mean hue, plus luminance stats, over a box. */
function measure(img, cx, cy, box) {
  const [hw, hh] = box;
  const x0 = Math.max(0, Math.round((cx - hw) * img.width));
  const x1 = Math.min(img.width, Math.round((cx + hw) * img.width));
  const y0 = Math.max(0, Math.round((cy - hh) * img.height));
  const y1 = Math.min(img.height, Math.round((cy + hh) * img.height));
  let n = 0, sumL = 0, sumL2 = 0, sumS = 0, hx = 0, hy = 0, sR = 0, sG = 0, sB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const R = img.data[i] / 255, G = img.data[i + 1] / 255, B = img.data[i + 2] / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), c = mx - mn;
      let h = 0;
      if (c > 1e-6) {
        if (mx === R) h = ((G - B) / c + 6) % 6;
        else if (mx === G) h = (B - R) / c + 2;
        else h = (R - G) / c + 4;
        h *= 60;
      }
      const s = mx > 0 ? c / mx : 0;
      hx += Math.cos((h * Math.PI) / 180) * s;
      hy += Math.sin((h * Math.PI) / 180) * s;
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      sumL += L; sumL2 += L * L; sumS += s; n++;
      sR += R; sG += G; sB += B;
    }
  }
  if (n === 0) return null;
  const meanL = sumL / n;
  // CIE-style chromaticity, r = R/(R+G+B). Normalising by total intensity is
  // what makes this comparable across passes: the frame runs through an
  // adapting auto exposure, so absolute saturation of the same surface moved
  // from 0.28 to 0.17 between two runs of this very tool and a threshold on it
  // was flaky on the boundary. A ratio of channels is not.
  const tot = Math.max(sR + sG + sB, 1e-6);
  return {
    n,
    L: meanL,
    sd: Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL)),
    sat: sumS / n,
    cr: sR / tot,
    cg: sG / tot,
    hue: ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360,
  };
}

const rows = {};
const shots = [...new Set(SUBJECTS.map((s) => s.shot))];
for (const shot of shots) {
  const applied = await page.evaluate((n) => window.__APPLY_SHOT__(n), shot);
  if (applied?.error) await fail(`${applied.error}`);

  // 2.5 simulated seconds: comfortably past the exposure adaptation, and the
  // same amount of it whatever the frame rate happens to be.
  await settle(2.5);

  // Everyone off the set, AFTER the settle. This gate measures FLOOR PAINT, and
  // a spawn bay is by definition where that team's soldiers stand.
  //
  // Without this the bravo reading was bimodal: runs gave hue 346, 213, 336,
  // 199, 302, 135 while alpha sat at 217 every time and the exposure moved less
  // than half a stop. The projected sample lands at pixel (1114, 437) and a bot
  // stands there about half the time; a soldier in grey camo reads close enough
  // to the slab that the straddle guard sees one uniform surface and passes it.
  // Bay separation swung 0.086-0.160 against a 0.070 threshold on that alone.
  //
  // WHY AFTER AND NOT BEFORE: it was before, and it did nothing. Hiding is a
  // one-shot write to `group.visible`, and `Agent.reset()` sets that flag back
  // to true on every round transition (agent.js). The bravo shot is taken last,
  // five-plus simulated seconds into the page, which is exactly when the match
  // leaves warmup and resets the cast. Two captures taken with the hide in place
  // still had a soldier standing in the bay. Hiding after the settle puts the
  // write inside the same frame budget as the screenshot, where nothing resets.
  //
  // `tools/legibility.mjs` hides the cast for the same reason.
  await page.evaluate(() => {
    const ai = window.__ENGINE__.ctx.peek('ai');
    for (const a of ai?.agents ?? []) if (a.group) a.group.visible = false;
  });
  // A short second settle so the temporal history (TAA, SSR, GTAO) reconverges
  // on the floor the bot was standing in front of, rather than screenshotting a
  // ghost of him. Short enough that a round transition inside it is unlikely,
  // and if one happens the straddle guard is the backstop.
  await settle(0.35);

  const png = `${OUT}-${shot}.png`;
  mkdirSync(dirname(png), { recursive: true });
  const buf = await page.screenshot();
  writeFileSync(png, buf);
  const img = PNG.sync.read(buf);

  for (const sub of SUBJECTS.filter((s) => s.shot === shot)) {
    const uv = await page.evaluate((p) => {
      const cam = window.__ENGINE__.camera;
      cam.updateMatrixWorld(true);
      const v = new (Object.getPrototypeOf(cam.position).constructor)(p[0], p[1], p[2]);
      v.project(cam);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) return null;
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    }, sub.point);
    if (!uv) await fail(`${sub.name}: world point ${sub.point} is off screen in shot "${shot}"`);
    // The exposure this frame was actually metered at, recorded alongside the
    // colour. Settling by simulated time removed the frame-rate dependence, but
    // a suite run still produced bravo at hue 182 against 347 standalone, and
    // "the number moved and I do not know what moved it" is the position this
    // whole investigation kept starting from. `legibility.mjs` reports the same
    // field per row for the same reason.
    const expo = await page.evaluate(
      () => +window.__ENGINE__.ctx.get('render').debugExposure().exposure.toFixed(3));
    const m = measure(img, uv[0], uv[1], sub.box);
    if (!m) await fail(`${sub.name}: empty sample box at uv ${uv}`);
    if (m.sd > SD_CEIL) {
      await fail(`${sub.name}: sample box straddles surfaces `
        + `(luminance sd ${m.sd.toFixed(3)} > ${SD_CEIL}) — the pose or the point moved`);
    }
    rows[sub.key] = { ...sub, ...m, uv, expo };
  }
}

const bad = [];

/**
 * Distance between two surfaces in chromaticity, i.e. "are these two different
 * COLOURS" with brightness divided out.
 *
 * Hue separation was the first thing tried here and it is the wrong statistic:
 * hue is an angle, and the angle of a nearly-grey patch is noise. In the broken
 * build the hazard bars measured hue 111 degrees against a slab at 230 — a
 * 119-degree separation that would have sailed through — while both were in
 * fact the same grey-blue at saturation 0.15. Chromaticity distance cannot do
 * that: two greys are close no matter what angle their residual noise points.
 */
const chromaDist = (a, b) => Math.hypot(a.cr - b.cr, a.cg - b.cg);

// Job 2: the two bays are the only asymmetry in the level, so a player who has
// turned around twice has to be able to tell them apart at a glance.
const baySep = chromaDist(rows.alpha, rows.bravo);
if (baySep < BAY_SEP) {
  bad.push(`bay colour separation ${baySep.toFixed(3)} < ${BAY_SEP} `
    + `— the two ends of the map look the same`);
}

// Job 3: the hazard hatching has to come off the slab it is painted on. It may
// do that on colour or on brightness — a yellow bar on grey concrete has both —
// but it has to do it on one of them. In the broken build it had neither:
// Weber contrast 0.008 and a chromaticity distance inside the noise.
const hazCw = Math.abs(rows.hazard.L - rows.slab.L) / Math.max(rows.hazard.L, rows.slab.L, 1e-6);
const hazSep = chromaDist(rows.hazard, rows.slab);
if (hazCw < HAZ_CONTRAST && hazSep < HAZ_SEP) {
  bad.push(`hazard bars vs slab: contrast ${hazCw.toFixed(3)} < ${HAZ_CONTRAST} AND colour `
    + `separation ${hazSep.toFixed(3)} < ${HAZ_SEP} — neither carries`);
}

const fmt = (k) => `${rows[k].name} rg ${rows[k].cr.toFixed(3)}/${rows[k].cg.toFixed(3)}`
  + ` L ${rows[k].L.toFixed(2)} hue ${rows[k].hue.toFixed(0)} expo ${rows[k].expo}`;
if (bad.length) {
  console.error(`MARKINGS FAIL — ${bad.join(' · ')}`);
  console.error(`  ${['alpha', 'bravo', 'hazard', 'slab'].map(fmt).join(' · ')}`);
  await browser.close();
  stopVite();
  process.exit(1);
}

console.log(`MARKINGS OK — bay colour separation ${baySep.toFixed(3)} `
  + `(alpha hue ${rows.alpha.hue.toFixed(0)}deg vs bravo ${rows.bravo.hue.toFixed(0)}deg) · `
  + `hazard vs slab contrast ${hazCw.toFixed(2)}, colour ${hazSep.toFixed(3)}`
  + ` · expo ${rows.alpha.expo}/${rows.bravo.expo}`);

await browser.close();
stopVite();
