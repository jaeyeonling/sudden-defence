#!/usr/bin/env node
/**
 * SIGHT PICTURE — how much of what you are aiming at survives the frame?
 *
 * Two effects in this renderer take the centre of the screen away from the
 * player, and both are invisible in a still capture because both only exist
 * while something is happening:
 *
 *   - camera motion blur, which smears the whole frame while you turn
 *   - the muzzle flash sprite, which is drawn in the viewmodel scene and so
 *     paints over the world at the moment you are trying to see the hit
 *
 * A round-based shooter is decided in the half second after a corner, so "can
 * you read the middle of the screen while turning and firing" is a gameplay
 * question, not a taste one. This measures it.
 *
 * The metric is DETAIL, not brightness: mean Sobel gradient magnitude of luma
 * over a centre rect. Blur destroys gradient and leaves the mean luma almost
 * untouched, so luminance alone reports "nothing happened" on a frame that has
 * been wiped. Clipping is reported alongside it because the flash takes the
 * centre a different way — by blowing it out rather than by smearing it.
 *
 * WHAT IT FOUND, AND WHAT IT EXONERATED
 *
 * The muzzle flash was the suspect, from a capture where the sprite visibly
 * covers the crosshair. It is not the problem: firing costs nothing measurable
 * — the row reads ABOVE 1.0x, because the sprite contributes its own edges to a
 * gradient metric, which is a limitation of the metric and not a benefit of the
 * flash — and clips 0.1 % of the centre. Turning was the problem, and nothing
 * in the still captures could have shown it.
 *
 *     condition                       detail vs still
 *     turn 220/s, no radial ramp            0.61 - 0.64
 *     turn 220/s, ramp at 0.15              0.77 - 0.87
 *     turn 220/s, ramp at 0                 0.91 - 0.96
 *     turn 220/s, blur pass off             0.92 - 0.94
 *     fire                                  1.02 - 1.07
 *
 * THE NOISE FLOOR IS ABOUT 4 %, so read the ranges and not the digits. Two rows
 * that are the same configuration by construction — the live `turn` row with the
 * shipped ramp at 0, and the `ramp 0` control — came out 0.961 and 0.925 in one
 * run. The mean luminance moves with them (0.387 vs 0.395), which points at
 * auto-exposure drifting across the twenty-odd seconds a full run takes; the TAA
 * jitter phase and the blur pass's own frame counter also differ row to row.
 * Anything inside 4 % is not a result. 0.61 against 0.93 is.
 *
 * The last two rows are the same number, and that is the finding: with the
 * centre of the ramp taken to zero the pass costs the sight picture nothing
 * measurable, so there is no remaining trade to make and no reason to keep a
 * token smear at the crosshair. What survives — about 7 % — is the temporal
 * passes upstream rejecting their history on a fast rotation, which is a TAA
 * question and wants separate work; nothing tuned in `motionblur.js` reaches it.
 *
 * AN EARLIER VERSION OF THIS TOOL REPORTED 0.45 / 0.60 / 0.71 FOR THE SAME
 * BUILDS, and every one of those was wrong. It settled the still row at the
 * spawn yaw and then turned the moving rows 37 degrees off it, so the centre
 * rect held different scenery in the two frames and part of every "detail loss"
 * was really "the wall you are now facing is a plainer wall". It also compared
 * builds across separate runs — separate boots, separate rng props, separate sun
 * — which added its own spread. Both are fixed: every row is photographed at the
 * same yaw, and the before/after builds are reproduced from a uniform inside one
 * run. The conclusion drawn from the bad version ("most of the loss is TAA") was
 * the opposite of the truth.
 *
 * Every condition is the same staged frame with exactly one thing changed:
 * match frozen, all bots hidden, player pinned at a fixed spawn with a fixed
 * yaw, engine halted on the frame under test. `still` is the reference, and the
 * other rows are quoted as a fraction of its detail.
 *
 *   node tools/sight.mjs
 *   node tools/sight.mjs --turn=400          # degrees per second
 *   node tools/sight.mjs --out=shots/sight
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const OUT = String(args.out ?? 'shots/sight');
/**
 * 220 deg/s. Not a flick — a flick is over in two frames and nobody expects to
 * read the screen mid-flick. This is the sustained rate you turn at while
 * clearing a corner, which is exactly when you do expect to read it.
 */
const TURN = Number(args.turn ?? 220);

mkdirSync(OUT, { recursive: true });

const vite = await ensureServer(PORT, { name: 'SIGHT' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
await page.waitForFunction(
  () => window.__ENGINE__.ctx.get('match').phase === 'live',
  null, { timeout: 60000 }
);

await page.evaluate(() => {
  // Remember what the build shipped BEFORE any control row overwrites it, so the
  // live rows can be restored to it afterwards.
  const mb0 = window.__ENGINE__.ctx.get('render').motionBlur;
  if (mb0) window.__SHIPPED_CENTRE__ = mb0.blurPass.uniforms.uCentre.value;

  window.__SIGHT__ = async ({ turn, rate, fire, noMb, ramp }) => {
    const e = window.__ENGINE__;
    // `intensity` is the pass's own final mix, so zeroing it returns the input
    // colour untouched. Leaving the pass in the chain rather than removing it
    // keeps the frame budget and every other pass identical between the two
    // rows, which is the only reason the comparison means anything.
    const mb = e.ctx.get('render').motionBlur;
    if (mb) {
      mb.blurPass.uniforms.uParams.value.w = noMb ? 0 : 1;
      // `uCentre = 1` makes the radial ramp mix(1, 1, x) — a no-op — which is
      // exactly the pass as it was before the ramp existed. Reproducing the old
      // build from a uniform rather than from a git checkout means the before
      // and after rows come out of ONE run, on one boot, at one sun angle, with
      // one set of rng-jittered props. Comparing across two runs is how the
      // first version of this tool produced a 0.60 that was really a 0.85.
      // Only the control rows touch this. A default here would mean the live row
      // measures the tool's opinion instead of the build's: with the shipped
      // value at 0 and a `?? 0.15` in this line, `turn` read 0.865 while the
      // `ramp 0` control right below it read 0.905 — two rows that should have
      // been the same number, and the discrepancy was the harness.
      if (ramp !== undefined) mb.blurPass.uniforms.uCentre.value = ramp;
      else if (window.__SHIPPED_CENTRE__ !== undefined) {
        mb.blurPass.uniforms.uCentre.value = window.__SHIPPED_CENTRE__;
      }
    }
    const match = e.ctx.get('match');
    const player = e.ctx.get('player');
    const ai = e.ctx.get('ai');
    const world = e.ctx.get('world');

    const sp = (world.spawnPoints ?? []).find((s) => s.team === 'alpha');
    if (!sp) return { ok: false, why: 'no alpha spawn' };

    // Same freeze switch `legibility.mjs` uses: `match.frozen` is a derived
    // getter that AiSystem copies onto every agent each tick, so overriding it
    // on the instance is the only hold that survives a frame.
    if (!window.__FROZEN_PATCHED__) {
      Object.defineProperty(match, 'frozen', { get: () => true, configurable: true });
      window.__FROZEN_PATCHED__ = true;
    }
    // Bots off the set entirely. A soldier walking through the centre rect
    // would contribute his own object-motion blur to a measurement about the
    // camera's, and there would be no way to tell them apart afterwards.
    for (const a of ai.agents) if (a.group) a.group.visible = false;

    const org = sp.position;
    const eyeH = Math.max(0.5, player.eyePosition.y - player.position.y);

    /**
     * EVERY ROW IS PHOTOGRAPHED AT THE SAME YAW. This is the whole validity of
     * the comparison and the first version got it wrong: it settled the still
     * row at the spawn yaw and then turned the moving rows 10 frames off it, so
     * the two frames were 37 degrees apart and the centre rect held DIFFERENT
     * SCENERY. A gradient difference between them was partly "the wall you are
     * now facing is a plainer wall", which is not a fact about the renderer at
     * all. The still row therefore starts at the end yaw and settles there; the
     * turning rows start 10 frames back and arrive at it.
     */
    const step = (rate * Math.PI) / 180 / 60;
    const FRAMES = 10;
    let yaw = (sp.yaw ?? 0) + (turn ? 0 : step * FRAMES);
    const pin = () => {
      player.teleport({ x: org.x, y: org.y + eyeH, z: org.z }, yaw);
      player.velocity?.set(0, 0, 0);
    };

    // Settle: shadows, TAA history and the velocity buffer all need a few
    // frames of the staged pose before they describe it rather than the
    // teleport that produced it.
    for (let i = 0; i < 30; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }

    if (turn) {
      // Turn for long enough that the velocity buffer is describing a steady
      // rotation. Two frames would measure the acceleration into it.
      for (let i = 0; i < FRAMES; i++) {
        yaw += step;
        pin();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    if (fire) {
      const weapons = e.ctx.get('weapons');
      if (typeof weapons.tryFire !== 'function') return { ok: false, why: 'no weapons.tryFire' };
      if (weapons.ammo?.mag === 0) weapons.reload?.();
      if (!weapons.tryFire()) return { ok: false, why: 'tryFire refused' };
      // One frame: the flash sprite lives 2-3 frames and this is its brightest.
      await new Promise((r) => requestAnimationFrame(r));
    }

    e.stop();
    const cvs = e.ctx.get('render').renderer.domElement;
    return { ok: true, w: cvs.clientWidth, h: cvs.clientHeight, yaw: +yaw.toFixed(3) };
  };
});

/**
 * Mean Sobel gradient magnitude of luma, plus clipping, over a rect.
 *
 * The rect is the centre 36% x 36% of the frame — a little wider than the
 * crosshair and a little narrower than the HUD, so neither the ammo counter nor
 * the health bar can contribute edges to a "detail" number.
 */
function detail(png, rect) {
  const [x0, y0, x1, y1] = rect;
  const L = (x, y) => {
    const i = (y * png.width + x) * 4;
    return (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]) / 255;
  };
  let n = 0, g = 0, lum = 0, clip = 0;
  for (let y = Math.max(1, y0); y < Math.min(png.height - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(png.width - 1, x1); x++) {
      const gx = L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1)
        - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1);
      const gy = L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1)
        - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1);
      const l = L(x, y);
      g += Math.hypot(gx, gy);
      lum += l;
      if (l > 0.95) clip++;
      n++;
    }
  }
  return n ? { n, grad: +(g / n).toFixed(5), L: +(lum / n).toFixed(4), clip: +(clip / n).toFixed(4) } : null;
}

const CONDITIONS = [
  { name: 'still', turn: false, fire: false },
  { name: `turn ${TURN}/s`, turn: true, fire: false },
  { name: 'fire', turn: false, fire: true },
  { name: `turn+fire`, turn: true, fire: true },
  // Motion blur switched off at the pass, so the turn row above has something
  // to be compared against. Without this the tool can say the centre lost half
  // its detail on a turn but not what took it: TAA runs first and rejects its
  // history on a fast rotation, and a reprojection that finds nothing to reuse
  // softens the frame all by itself. Attributing the loss to the pass you
  // happen to be editing is how you tune a knob that was never connected.
  // The two bracketing controls for the turn row: the pass as it was before the
  // radial ramp, and the pass not running at all. Between them they say how much
  // of a turn's cost is the ramp's business and how much belongs to the temporal
  // passes upstream, which no amount of tuning here will reach.
  { name: `turn, no ramp`, turn: true, fire: false, ramp: 1, control: true },
  { name: `turn, ramp 0`, turn: true, fire: false, ramp: 0, control: true },
  { name: `turn, mb off`, turn: true, fire: false, noMb: true, control: true },
];

const rows = [];
for (const c of CONDITIONS) {
  const staged = await page.evaluate(async (p) => window.__SIGHT__(p), { ...c, rate: TURN });
  if (!staged.ok) { rows.push({ cond: c.name, status: staged.why }); continue; }
  const tag = c.name.replace(/[^a-z0-9]+/gi, '-');
  const buf = await page.screenshot({ path: join(OUT, `${tag}.png`) });
  await page.evaluate(() => window.__ENGINE__.start());

  const png = PNG.sync.read(buf);
  const w = png.width, h = png.height;
  const rect = [Math.round(w * 0.32), Math.round(h * 0.32), Math.round(w * 0.68), Math.round(h * 0.68)];
  const d = detail(png, rect);
  if (!d) { rows.push({ cond: c.name, status: 'centre rect off screen' }); continue; }
  rows.push({ cond: c.name, ...d, control: !!c.control });
}

const still = rows.find((r) => r.cond === 'still');
for (const r of rows) {
  if (typeof r.grad === 'number' && still?.grad) r.vsStill = +(r.grad / still.grad).toFixed(3);
}

writeFileSync(join(OUT, 'sight.json'), JSON.stringify(rows, null, 2));
console.table(rows);
if (errors.length) console.log('errors:\n' + errors.slice(0, 5).join('\n'));

const measured = rows.filter((r) => typeof r.grad === 'number');
// Half the detail is the line. Below that the centre of the screen has stopped
// carrying the information the player is looking at it for; a 10-20 % loss is
// the effect doing its job.
// Control rows are excluded. `turn, no ramp` deliberately reinstates the
// behaviour the ramp exists to remove, so leaving it in the verdict would let a
// build fail on its own before-picture — a gate that goes red precisely because
// the fix is working is worse than no gate.
const bad = measured.filter((r) => !r.control && r.cond !== 'still' && (r.vsStill < 0.5 || r.clip > 0.2));
if (measured.length !== rows.length) {
  console.log(`SIGHT UNRESOLVED — ${rows.length - measured.length}/${rows.length} conditions did not measure: `
    + rows.filter((r) => !('grad' in r)).map((r) => `${r.cond} ${r.status}`).join(' · '));
} else if (bad.length) {
  console.log(`SIGHT WARN — ${bad.map((b) => `${b.cond} detail ${b.vsStill}x clip ${b.clip}`).join(' · ')}`);
} else {
  const live = measured.filter((r) => !r.control && r.cond !== 'still');
  console.log(`SIGHT OK — worst ${Math.min(...live.map((r) => r.vsStill)).toFixed(2)}x detail vs still`
    + ` · controls ${measured.filter((r) => r.control).map((r) => `${r.cond} ${r.vsStill}`).join(', ')}`);
}

await browser.close();
killServer(vite);
