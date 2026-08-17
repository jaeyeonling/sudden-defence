#!/usr/bin/env node
/**
 * Crop the same region out of two captures and stack them, magnified, into one
 * PNG for eyeball A/B.
 *
 *   node tools/cropcmp.mjs --a=shots/x/boot.png --b=shots/y/boot.png \
 *     --x=1150 --y=450 --w=400 --h=230 --scale=2 --out=/tmp/cmp.png
 *
 * Why this exists: `imagediff.mjs` answers "did pixels move and by how much",
 * which is the right question for a regression gate and the wrong one for
 * "is this better". A mean delta of 3/255 spread over a whole frame can be a
 * sharper shadow edge or a global exposure drift, and the two are indistinguishable
 * in the summary. Viewing the 1920x1080 captures whole does not settle it either,
 * because anything that looks at them scales them down — which destroys exactly
 * the high-frequency detail the question is about.
 *
 * Nearest-neighbour magnification on purpose: the point is to see the actual
 * pixels, not a pleasant interpolation of them. A on top, B below, 4px white gap.
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './harness.mjs';

const args = parseArgs();

const X = Number(args.x ?? 0);
const Y = Number(args.y ?? 0);
const S = Number(args.scale ?? 2);
const OUT = resolve(args.out ?? '/tmp/cropcmp.png');

const src = [args.a, args.b].map((p) => {
  if (!p) throw new Error('need --a and --b');
  return PNG.sync.read(readFileSync(resolve(p)));
});

// Clamp to the smaller of the two images so a mismatched pair fails loudly on
// size rather than silently reading garbage past the end of a row.
const maxW = Math.min(...src.map((i) => i.width));
const maxH = Math.min(...src.map((i) => i.height));
const W = Math.min(Number(args.w ?? 400), maxW - X);
const H = Math.min(Number(args.h ?? 230), maxH - Y);
if (!(W > 0 && H > 0)) throw new Error(`crop ${X},${Y} ${W}x${H} is outside ${maxW}x${maxH}`);

const GAP = 4;
const dst = new PNG({ width: W * S, height: H * S * 2 + GAP });
dst.data.fill(255);

src.forEach((img, k) => {
  const yOff = k * (H * S + GAP);
  for (let y = 0; y < H * S; y++) {
    const sy = Y + Math.floor(y / S);
    for (let x = 0; x < W * S; x++) {
      const si = (sy * img.width + (X + Math.floor(x / S))) * 4;
      const di = ((y + yOff) * dst.width + x) * 4;
      dst.data[di] = img.data[si];
      dst.data[di + 1] = img.data[si + 1];
      dst.data[di + 2] = img.data[si + 2];
      dst.data[di + 3] = 255;
    }
  }
});

writeFileSync(OUT, PNG.sync.write(dst));
console.log(JSON.stringify({ out: OUT, crop: `${W}x${H}+${X}+${Y}`, scale: S, size: `${dst.width}x${dst.height}` }));
