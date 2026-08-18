import { datan2 } from '../core/dmath.js';
import { clothGeometry, tubeY } from './util-cloth.js';
import { IDENT, LL, BOX, BOX_FINE, BOX_SOFT, BOX_THIN, worldOf, ryOf } from './kit-base.js';

/**
 * WORLD — the modular building kit: walls, balconies, parapets, stairs and the
 * fabric hung off them. Openings live in `kit-openings.js`, damage in
 * `kit-damage.js`, and the panel-space vocabulary all three share in
 * `kit-base.js`.
 */


// ================================================================= balcony ==
export function balcony(A, pm, x, y, w, rng, opts = {}) {
  const d = opts.depth ?? 1.15;
  const box = BOX(A);
  const key = opts.key ?? 'concrete';
  // slab, slightly sagging feel via thickness taper
  A.add(key, BOX_SOFT(A), LL(pm, x, y + 0.06, -d / 2, 0, w, 0.13, d), {
    masks: [0.45, 0.55, 0.3],
  });
  A.box('concrete', ...worldOf(pm, x, y + 0.06, -d / 2), w, 0.16, d, ryOf(pm));
  // brackets underneath
  for (let i = -1; i <= 1; i += 2) {
    A.add(key, box, LL(pm, x + i * (w / 2 - 0.16), y - 0.14, -d * 0.42, 0, 0.11, 0.3, d * 0.75), {
      masks: [0.4, 0.6, 0.4],
    });
  }
  // railing
  if (opts.railing === 'concrete') {
    A.add(key, box, LL(pm, x, y + 0.55, -d + 0.06, 0, w, 0.85, 0.12), { masks: [0.5, 0.5, 0.2] });
    A.add(key, box, LL(pm, x - w / 2 + 0.06, y + 0.55, -d / 2, 0, 0.12, 0.85, d), {
      masks: [0.5, 0.5, 0.2],
    });
    A.add(key, box, LL(pm, x + w / 2 - 0.06, y + 0.55, -d / 2, 0, 0.12, 0.85, d), {
      masks: [0.5, 0.5, 0.2],
    });
    A.box('concrete', ...worldOf(pm, x, y + 0.55, -d + 0.06), w, 0.9, 0.16, ryOf(pm));
  } else {
    const bar = BOX_THIN(A);
    const rk = opts.railKey ?? 'metal_rust';
    // top and mid rails
    A.add(rk, bar, LL(pm, x, y + 1.0, -d + 0.04, 0, w, 0.05, 0.05), { masks: [0.9, 0.45, 0] });
    A.add(rk, bar, LL(pm, x, y + 0.52, -d + 0.04, 0, w, 0.035, 0.035), { masks: [0.9, 0.45, 0] });
    A.add(rk, bar, LL(pm, x - w / 2, y + 1.0, -d / 2 + 0.02, 0, 0.05, 0.05, d), {
      masks: [0.9, 0.45, 0],
    });
    A.add(rk, bar, LL(pm, x + w / 2, y + 1.0, -d / 2 + 0.02, 0, 0.05, 0.05, d), {
      masks: [0.9, 0.45, 0],
    });
    const n = Math.max(4, Math.round(w / 0.17));
    for (let i = 0; i <= n; i++) {
      const bx = x - w / 2 + (i / n) * w;
      A.add(rk, bar, LL(pm, bx, y + 0.53, -d + 0.04, 0, 0.024, 1.0, 0.024), {
        masks: [0.9, 0.5, 0],
      });
    }
    // corner posts
    for (const sx of [-1, 1]) {
      A.add(rk, bar, LL(pm, x + sx * (w / 2), y + 0.53, -d + 0.04, 0, 0.05, 1.05, 0.05), {
        masks: [0.9, 0.5, 0],
      });
      for (let i = 0; i <= 3; i++) {
        A.add(
          rk,
          bar,
          LL(pm, x + sx * (w / 2), y + 0.53, -d + 0.04 + (i / 3) * (d - 0.08), 0, 0.024, 1.0, 0.024),
          { masks: [0.9, 0.5, 0] }
        );
      }
    }
    A.box('metal', ...worldOf(pm, x, y + 0.55, -d + 0.06), w, 0.95, 0.1, ryOf(pm));
  }
  return { x, y, w, d };
}

// ================================================================= parapet ==
/** Roof edge wall with a coping course and scupper gaps. */
export function parapet(A, key, cx, cz, w, d, y, rng, opts = {}) {
  const h = opts.h ?? 0.72;
  const t = opts.t ?? 0.24;
  const box = BOX(A);
  const sides = [
    [cx, cz - d / 2 + t / 2, w, t],
    [cx, cz + d / 2 - t / 2, w, t],
    [cx - w / 2 + t / 2, cz, t, d],
    [cx + w / 2 - t / 2, cz, t, d],
  ];
  const pmI = IDENT;
  for (let i = 0; i < sides.length; i++) {
    const [sx, sz, sw, sd] = sides[i];
    const jitter = rng.range(-0.05, 0.05);
    pmI.identity();
    A.add(
      key,
      box,
      LL(pmI, sx, y + (h + jitter) / 2, sz, 0, sw, h + jitter, sd),
      { masks: [0.5, 0.4, 0.15] }
    );
    // coping: a slightly wider, weathered cap
    A.add(
      opts.copingKey ?? 'concrete',
      BOX_SOFT(A),
      LL(pmI, sx, y + h + jitter + 0.045, sz, 0, sw + 0.09, 0.09, sd + 0.09),
      { masks: [0.75, 0.3, 0.1] }
    );
    A.box('concrete', sx, y + (h + 0.1) / 2, sz, sw, h + 0.1, sd);
  }
  return y + h;
}


// ================================================================= canopies ==
/**
 * A striped cloth canopy. Real market awnings are woven or sewn from bands, and
 * a single flat colour is the fastest way to make fabric read as a tarpaulin —
 * so this splits one continuous catenary surface into alternating colour strips.
 *
 * @param {Array<string>} keys  two or three palette keys to alternate
 * @param {THREE.Matrix4} m     transform for the whole canopy
 */
export function stripedCloth(A, keys, m, w, h, opts = {}) {
  const bands = opts.bands ?? Math.max(3, Math.round(w / 0.38));
  const rng = opts.rng ?? null;
  const seed = (rng ?? { float: () => 0.5 }).float() * 30;
  const segX = Math.max(2, Math.round(24 / bands));
  // `skipBand` tears one strip out of an old tarp: the gap, and the fact that
  // the neighbouring bands then read as separate pieces of cloth, is worth more
  // than any amount of texture on an intact rectangle.
  const skip = opts.skipBand ?? -1;
  const masks = opts.masks ?? [0.3, 0.5, 0.15];
  for (let i = 0; i < bands; i++) {
    if (i === skip) continue;
    const u0 = i / bands;
    const u1 = (i + 1) / bands;
    const g = clothGeometry(w, h, {
      segX: opts.segX ?? segX,
      segY: opts.segY ?? 6,
      sag: opts.sag ?? 0.14,
      wrinkle: opts.wrinkle ?? 0.03,
      bulge: opts.bulge ?? 0.04,
      twist: opts.twist ?? 0,
      thickness: opts.thickness ?? 0.0024,
      hem: opts.hem ?? 1,
      fray: opts.fray ?? 0,
      uRange: [u0, u1],
      seed,
    });
    // per-band weathering: sewn-together strips never age at the same rate
    const gv = rng ? rng.range(0.85, 1.18) : 1;
    A.addOnce(keys[i % keys.length], g, m, {
      masks: [masks[0], Math.min(1, masks[1] * gv), masks[2]],
    });
  }
}

// ================================================================== awning ==
/** Fabric awning over a shopfront: sloped cloth, scalloped edge, steel poles. */
export function awning(A, pm, x, y, w, rng, opts = {}) {
  const d = opts.depth ?? 1.5;
  const key = opts.key ?? 'fabric_red';
  const slope = opts.slope ?? 0.32;
  // the cloth is authored in XY; tip it to the awning slope
  const keys = opts.keys ?? [key, opts.key2 ?? 'fabric_cream'];
  const slack = rng ? rng.range(0.85, 1.45) : 1;
  stripedCloth(A, keys, LL(pm, x, y - slope * 0.5, -d / 2, 0, 1, 1, 1, -Math.PI / 2 + slope), w, d, {
    segY: 6,
    sag: 0.11 * slack,
    wrinkle: 0.026 * slack,
    bulge: 0.055 * slack,
    thickness: 0.0026,
    rng,
    masks: [0.2, 0.45, 0.15],
  });
  // valance hanging off the front edge, scalloped and frayed along the bottom
  stripedCloth(A, keys, LL(pm, x, y - slope - 0.13, -d, 0, 1, 1, 1), w, 0.26, {
    segY: 3,
    sag: 0.05 * slack,
    wrinkle: 0.026 * slack,
    bulge: 0,
    thickness: 0.0026,
    fray: 0.018,
    rng,
    masks: [0.3, 0.5, 0.2],
  });
  // frame
  const bar = BOX_THIN(A);
  for (const sx of [-1, 1]) {
    A.add('metal_rust', bar, LL(pm, x + sx * (w / 2 - 0.05), y - slope * 0.5, -d / 2, 0, 0.04, 0.04, d, -datan2(slope, d)), {
      masks: [0.9, 0.5, 0],
    });
    if (opts.legs) {
      A.add('metal_rust', bar, LL(pm, x + sx * (w / 2 - 0.05), (y - slope) / 2, -d + 0.05, 0, 0.045, y - slope, 0.045), {
        masks: [0.9, 0.55, 0],
      });
    }
  }
  A.add('metal_rust', bar, LL(pm, x, y - slope, -d + 0.03, 0, w, 0.04, 0.04), {
    masks: [0.9, 0.5, 0],
  });
  return { x, y, w, d };
}

// ================================================================ pipework ==
export function drainpipe(A, pm, x, yTop, h, rng, opts = {}) {
  const r = opts.r ?? 0.055;
  const key = opts.key ?? 'metal_rust';
  const pipe = A.cache(`pipe:${r.toFixed(3)}`, () => tubeY(r, 1, { radial: 8 }));
  const z = opts.z ?? -r - 0.02;
  // three sections with visible joints and a slight lean
  const segs = Math.max(2, Math.round(h / 1.6));
  let y = yTop - h;
  for (let i = 0; i < segs; i++) {
    const sh = h / segs;
    A.add(key, pipe, LL(pm, x + (i % 2 ? 0.006 : -0.006), y, z, 0, 1, sh, 1), {
      masks: [0.85, 0.6, 0.1],
    });
    A.add(key, pipe, LL(pm, x, y + sh - 0.03, z, 0, 1.22, 0.075, 1.22), { masks: [0.9, 0.7, 0.2] });
    y += sh;
  }
  // shoe at the bottom kicking out to the street
  A.add(key, pipe, LL(pm, x, yTop - h + 0.02, z + 0.09, 0, 1, 0.3, 1, -0.75), {
    masks: [0.85, 0.7, 0.3],
  });
  // A rainwater head at the top. Without it the pipe simply stops in mid-air,
  // which is what makes a downpipe read as a floating mast rather than as
  // plumbing that goes somewhere.
  A.add(key, BOX_FINE(A), LL(pm, x, yTop - 0.09, z - 0.01, 0, 0.2, 0.2, 0.17), {
    masks: [0.85, 0.65, 0.25],
  });
  A.add('metal_dark', BOX_FINE(A), LL(pm, x, yTop + 0.02, z - 0.01, 0, 0.24, 0.03, 0.2), {
    masks: [0.9, 0.55, 0.2],
  });
  // and the stain the overflow leaves down the render beside it
  A.add(key, BOX_FINE(A), LL(pm, x, yTop - 0.24, z * 0.35, 0, 0.09, 0.3, 0.02), {
    masks: [0.2, 1.0, 0.6],
  });
  // brackets
  for (let i = 1; i < segs; i++) {
    A.add('metal_dark', BOX_FINE(A), LL(pm, x, yTop - h + (i * h) / segs, z * 0.45, 0, 0.16, 0.03, Math.abs(z) * 0.9), {
      masks: [0.9, 0.6, 0.2],
    });
  }
}

