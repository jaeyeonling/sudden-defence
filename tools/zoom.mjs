#!/usr/bin/env node
/**
 * ZOOM — crop a region out of a capture and magnify it, nearest-neighbour.
 *
 * A 1600x900 frame shown whole is not enough resolution to answer "can you see
 * the enemy". The bot 24 m down the hall is sixty-odd pixels; scaled to fit a
 * review pane he is a smudge, and a smudge is what gets reported. Twice now a
 * conclusion drawn from a full frame ("props out-shout the people", "the enemy
 * has become invisible at 25 m") was reversed the moment the region was cut out
 * and magnified — in both cases the body was perfectly readable and the frame
 * was simply too small to show it.
 *
 * Nearest-neighbour on purpose: interpolation would invent contrast that the
 * renderer never produced, which is the one thing this must not do.
 *
 * This answers "what is actually there". It does not answer "how visible is
 * it" — that is `tools/legibility.mjs`, which measures pixels rather than
 * showing them. Look here first, then measure; do not stop at looking.
 *
 *   node tools/zoom.mjs shots/play2/01-freeze.png out.png 440 400 220 120 5
 *                       <src>                     <dst>   x   y   w   h  <zoom>
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst, sx, sy, sw, sh, sz] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node tools/zoom.mjs <src.png> <dst.png> [x y w h] [zoom]');
  process.exit(2);
}

const img = PNG.sync.read(readFileSync(src));
const x0 = Number(sx ?? 0);
const y0 = Number(sy ?? 0);
const w = Number(sw ?? img.width);
const h = Number(sh ?? img.height);
const z = Math.max(1, Number(sz ?? 1) | 0);

// A non-numeric argument used to sail through: x0 became NaN, the sample loop
// ran zero times, and the stats line printed `L NaN sat NaN hue 0deg` — which
// reads like a measurement rather than like a broken call. It cost a round trip
// to notice the numbers were not numbers. Refuse instead.
for (const [label, v] of [['x', x0], ['y', y0], ['w', w], ['h', h]]) {
  if (!Number.isFinite(v)) {
    console.error(`${label} is not a number (got "${{ x: sx, y: sy, w: sw, h: sh }[label]}")`);
    process.exit(2);
  }
}

// Clamp rather than fail: a region running off the edge is an ordinary mistake
// when you are reading coordinates off a screenshot by eye, and cropping what
// exists is more useful than refusing.
const cw = Math.max(1, Math.min(w, img.width - x0));
const ch = Math.max(1, Math.min(h, img.height - y0));
if (x0 < 0 || y0 < 0 || x0 >= img.width || y0 >= img.height) {
  console.error(`origin ${x0},${y0} is outside ${img.width}x${img.height}`);
  process.exit(2);
}

// Stats over the SOURCE region, not the magnified copy — nearest-neighbour
// scaling would weight every source pixel by z^2 and change nothing, but reading
// them once is cheaper and says what it means.
//
// Hue is reported because the floor markings on this map are a hue signal at
// low luminance: yellow walkway lines and per-team spawn bays sit on a slab of
// nearly the same brightness, so "is the paint doing its job" is a question
// about chroma that a luminance mean cannot answer, and answering it by eye off
// a shadowed capture is how the question kept getting the wrong answer.
let n = 0, sumL = 0, sumL2 = 0, sumS = 0, hx = 0, hy = 0, sR = 0, sG = 0, sB = 0;
for (let y = y0; y < y0 + ch; y++) {
  for (let x = x0; x < x0 + cw; x++) {
    const i = (y * img.width + x) * 4;
    const R = img.data[i] / 255, G = img.data[i + 1] / 255, B = img.data[i + 2] / 255;
    const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), c = mx - mn;
    let h = 0;
    if (c > 1e-6) {
      if (mx === R) h = ((G - B) / c + 6) % 6;
      else if (mx === G) h = (B - R) / c + 2;
      else h = (R - G) / c + 4;
      h *= 60;
    }
    const s = mx > 0 ? c / mx : 0;
    // Circular mean, weighted by saturation: averaging hue as a plain number
    // puts the mean of red (350 deg) and red (10 deg) at cyan, and weighting by
    // saturation stops thousands of grey pixels voting on a hue they do not have.
    hx += Math.cos((h * Math.PI) / 180) * s;
    hy += Math.sin((h * Math.PI) / 180) * s;
    sumL += L; sumL2 += L * L; sumS += s; sR += R; sG += G; sB += B; n++;
  }
}
const meanL = sumL / n;
const meanHue = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360;
// Chroma vector length: how much the region agrees on ONE hue. A grey floor and
// a floor of mixed red and green confetti both average to a hue nobody can see,
// and only this number tells them apart from a real, uniform tint.
const chroma = Math.hypot(hx, hy) / n;
console.log(
  `  L ${meanL.toFixed(3)} sd ${Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL)).toFixed(3)}`
  + ` · sat ${(sumS / n).toFixed(3)} · hue ${meanHue.toFixed(0)}deg chroma ${chroma.toFixed(3)}`
  // Raw channel means alongside the derived numbers. Hue is a ratio and says
  // nothing about which channel moved; when a yellow-painted surface reports a
  // blue hue, the question that settles it is whether R is actually lower than
  // the grey slab beside it or merely lower than B.
  + `\n  rgb ${(sR / n).toFixed(3)} ${(sG / n).toFixed(3)} ${(sB / n).toFixed(3)}`
);

const out = new PNG({ width: cw * z, height: ch * z });
for (let y = 0; y < out.height; y++) {
  for (let x = 0; x < out.width; x++) {
    const si = ((y0 + ((y / z) | 0)) * img.width + x0 + ((x / z) | 0)) * 4;
    const di = (y * out.width + x) * 4;
    out.data[di] = img.data[si];
    out.data[di + 1] = img.data[si + 1];
    out.data[di + 2] = img.data[si + 2];
    out.data[di + 3] = 255;
  }
}
writeFileSync(dst, PNG.sync.write(out));
console.log(`${dst} — ${cw}x${ch} at ${x0},${y0} from ${src} (${img.width}x${img.height}), ${z}x`);
