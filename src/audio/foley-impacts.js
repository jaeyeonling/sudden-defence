/**
 * AUDIO / FOLEY
 *
 * Impacts, footsteps, shell casings, reload mechanics, explosions, body falls
 * and UI. Everything is keyed off the twelve surface names in ARCHITECTURE.md
 * so physics, FX, decals and audio always agree about what was hit.
 *
 * The recurring recipe for a physical impact is:
 *   transient (contact)  +  body (mass)  +  texture (material)  +  debris
 * Which of those four dominates is what makes concrete sound like concrete and
 * flesh sound like flesh; the envelope shapes matter far more than the exact
 * filter frequencies.
 */

import {
  ad, biquad, clamp, gain, hit, osc, saturationCurve, semis, series, shaper,
  struckResonator, sweep,
} from './dsp.js';

/** What a round hitting a surface sounds like, and what a boot on it does. */

/**
 * Per-surface impact recipe.
 *  bodyF/bodyDecay  the mass thump
 *  ring             high-Q partials (metal, glass, wood) or null
 *  tex              { kind, f, q, decay, level } the material texture burst
 *  grains           number of debris grains
 *  bright           transient level 0..1
 *  wet              reverb send
 */
const IMPACT = {
  concrete: {
    bright: 0.85, bodyF: 180, bodyDecay: 0.05, ring: null,
    tex: { kind: 'white', f: 2600, q: 0.9, decay: 0.075, level: 0.75 },
    dust: { f: 1200, decay: 0.3, level: 0.16 }, grains: 5, wet: 0.4,
  },
  plaster: {
    bright: 0.7, bodyF: 220, bodyDecay: 0.035, ring: null,
    tex: { kind: 'white', f: 1900, q: 0.8, decay: 0.05, level: 0.6 },
    dust: { f: 900, decay: 0.42, level: 0.26 }, grains: 6, wet: 0.42,
  },
  metal: {
    bright: 1.0, bodyF: 150, bodyDecay: 0.035,
    ring: [{ f: 1750, q: 34, g: 0.42, decay: 0.28 }, { f: 3120, q: 26, g: 0.3, decay: 0.17 },
      { f: 5400, q: 18, g: 0.18, decay: 0.09 }, { f: 8100, q: 12, g: 0.09, decay: 0.05 }],
    tex: { kind: 'white', f: 5200, q: 1.2, decay: 0.03, level: 0.5 },
    dust: null, grains: 3, wet: 0.5,
  },
  wood: {
    bright: 0.6, bodyF: 320, bodyDecay: 0.055,
    ring: [{ f: 420, q: 14, g: 0.35, decay: 0.11 }, { f: 780, q: 11, g: 0.2, decay: 0.07 },
      { f: 1520, q: 8, g: 0.1, decay: 0.04 }],
    tex: { kind: 'white', f: 1500, q: 1.0, decay: 0.045, level: 0.45 },
    dust: null, grains: 5, wet: 0.32,
  },
  dirt: {
    bright: 0.25, bodyF: 120, bodyDecay: 0.07, ring: null,
    tex: { kind: 'brown', f: 700, q: 0.7, decay: 0.09, level: 0.7 },
    dust: { f: 600, decay: 0.34, level: 0.2 }, grains: 4, wet: 0.2,
  },
  sand: {
    bright: 0.18, bodyF: 105, bodyDecay: 0.055, ring: null,
    tex: { kind: 'white', f: 1500, q: 0.5, decay: 0.13, level: 0.5 },
    dust: { f: 1000, decay: 0.4, level: 0.24 }, grains: 3, wet: 0.16,
  },
  glass: {
    bright: 1.0, bodyF: 500, bodyDecay: 0.02,
    ring: [{ f: 3400, q: 40, g: 0.34, decay: 0.13 }, { f: 5300, q: 34, g: 0.26, decay: 0.1 },
      { f: 7900, q: 26, g: 0.2, decay: 0.07 }, { f: 11200, q: 18, g: 0.12, decay: 0.05 }],
    tex: { kind: 'crackle', f: 6000, q: 0.9, decay: 0.28, level: 0.6 },
    dust: null, grains: 11, wet: 0.46,
  },
  water: {
    bright: 0.3, bodyF: 260, bodyDecay: 0.03, ring: null,
    tex: { kind: 'white', f: 1800, q: 0.8, decay: 0.14, level: 0.75, rise: true },
    dust: null, grains: 4, wet: 0.3, bubbles: true,
  },
  foliage: {
    bright: 0.25, bodyF: 380, bodyDecay: 0.02, ring: null,
    tex: { kind: 'crackle', f: 2600, q: 0.8, decay: 0.16, level: 0.6 },
    dust: null, grains: 7, wet: 0.22,
  },
  fabric: {
    bright: 0.2, bodyF: 150, bodyDecay: 0.045, ring: null,
    tex: { kind: 'white', f: 900, q: 0.6, decay: 0.06, level: 0.4 },
    dust: { f: 700, decay: 0.2, level: 0.1 }, grains: 2, wet: 0.18,
  },
  flesh: {
    bright: 0.35, bodyF: 128, bodyDecay: 0.06, ring: null,
    tex: { kind: 'white', f: 620, q: 1.4, decay: 0.055, level: 0.62 },
    dust: null, grains: 3, wet: 0.24, wet_squelch: true,
  },
  rubber: {
    bright: 0.3, bodyF: 190, bodyDecay: 0.04,
    ring: [{ f: 260, q: 9, g: 0.2, decay: 0.06 }],
    tex: { kind: 'white', f: 1100, q: 0.9, decay: 0.03, level: 0.3 },
    dust: null, grains: 1, wet: 0.2,
  },
};

/* ------------------------------------------------------------------ */
/* Bullet impacts                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o { when, surface, energy (0..1.5), distance }
 */
export function surfaceImpact(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const s = IMPACT[o.surface] ?? IMPACT.concrete;
  const e = clamp(o.energy ?? 1, 0.15, 1.6);
  const jit = semis(rng.range(-2.5, 2.5));
  const out = gain(actx, 0.22);  // VOICE TRIM
  let end = t0 + 0.2;

  /* transient */
  if (s.bright > 0.05) {
    const src = bank.source('white', rng, rng.range(0.9, 1.35));
    const hp = biquad(actx, 'highpass', 3000 * jit, 0.7);
    const g = gain(actx, 0);
    series(src, hp, g).connect(out);
    hit(g.gain, t0, 0.55 * s.bright * e, rng.range(0.003, 0.008));
    src.start(t0, src._offset, 0.04);
  }

  /* body */
  {
    const b = osc(actx, 'sine', s.bodyF * jit);
    const g = gain(actx, 0);
    const drv = shaper(actx, saturationCurve(2.5, 0.4), '2x');
    b.connect(g); series(g, drv).connect(out);
    sweep(b.frequency, t0, s.bodyF * jit * 1.6, s.bodyF * jit * 0.7, s.bodyDecay * 1.5);
    ad(g.gain, t0, 0.5 * e, 0.0015, s.bodyDecay * rng.range(0.85, 1.2));
    b.start(t0); b.stop(t0 + s.bodyDecay * 2.2 + 0.02);
    end = Math.max(end, t0 + s.bodyDecay * 2.2);
  }

  /* material texture */
  {
    const tx = s.tex;
    const src = bank.source(tx.kind, rng, rng.range(0.8, 1.3));
    const bp = biquad(actx, 'bandpass', tx.f * jit, tx.q);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    if (tx.rise) sweep(bp.frequency, t0, tx.f * 0.4, tx.f * 2.2, tx.decay);
    else sweep(bp.frequency, t0, tx.f * 1.5 * jit, tx.f * 0.6 * jit, tx.decay * 1.6);
    ad(g.gain, t0, tx.level * e, tx.rise ? 0.008 : 0.0015, tx.decay * rng.range(0.85, 1.25));
    src.start(t0, src._offset, tx.decay * 3 + 0.05);
    end = Math.max(end, t0 + tx.decay * 3);
  }

  /* resonant ring (metal / glass / wood) */
  if (s.ring) {
    const parts = [];
    for (const p of s.ring) {
      parts.push({
        f: p.f * semis(rng.range(-3, 3)),
        q: p.q * rng.range(0.8, 1.25),
        g: p.g * e,
        decay: p.decay * rng.range(0.75, 1.3),
      });
    }
    const r = struckResonator(actx, bank, rng, t0, parts, 0.0035);
    r.connect(out);
    end = Math.max(end, t0 + 0.4);
  }

  /* dust / powder cloud */
  if (s.dust) {
    const src = bank.source('white', rng, rng.range(0.7, 1.1));
    const lp = biquad(actx, 'lowpass', s.dust.f, 0.8);
    const g = gain(actx, 0);
    series(src, lp, g).connect(out);
    sweep(lp.frequency, t0, s.dust.f * 1.4, s.dust.f * 0.5, s.dust.decay);
    ad(g.gain, t0, s.dust.level * e, 0.02, s.dust.decay * rng.range(0.8, 1.3));
    src.start(t0, src._offset, s.dust.decay * 2 + 0.05);
    end = Math.max(end, t0 + s.dust.decay * 2);
  }

  /* debris grains — chips, splinters, glass shards landing */
  const grains = Math.round(s.grains * clamp(e, 0.3, 1.4));
  for (let i = 0; i < grains; i++) {
    const gt = t0 + rng.range(0.015, 0.06) + i * rng.range(0.01, 0.055);
    const r = struckResonator(actx, bank, rng, gt, [
      { f: rng.range(1800, 9000), q: rng.range(12, 30), g: rng.range(0.02, 0.05) * e, decay: rng.range(0.01, 0.05) },
    ], 0.0018);
    r.connect(out);
    end = Math.max(end, gt + 0.08);
  }

  /* water bubbles */
  if (s.bubbles) {
    for (let i = 0; i < 4; i++) {
      const bt = t0 + rng.range(0.02, 0.18);
      const b = osc(actx, 'sine', rng.range(400, 1400));
      const g = gain(actx, 0);
      b.connect(g); g.connect(out);
      sweep(b.frequency, bt, rng.range(350, 700), rng.range(900, 2200), 0.05);
      hit(g.gain, bt, rng.range(0.04, 0.1) * e, 0.05);
      b.start(bt); b.stop(bt + 0.12);
      end = Math.max(end, bt + 0.14);
    }
  }

  /* flesh squelch */
  if (s.wet_squelch) {
    const src = bank.source('pink', rng, rng.range(0.7, 1.1));
    const bp = biquad(actx, 'bandpass', 380, 2.2);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    sweep(bp.frequency, t0, 260, 900, 0.09);
    ad(g.gain, t0 + 0.004, 0.4 * e, 0.006, 0.1);
    src.start(t0, src._offset, 0.25);
  }

  return { node: out, end: end + 0.05, send: s.wet };
}

/* ------------------------------------------------------------------ */
/* Footsteps                                                          */
/* ------------------------------------------------------------------ */

/** Per-surface footstep character. */
const STEP = {
  concrete: { bodyF: 92, bodyDecay: 0.055, texKind: 'white', texF: 2100, texQ: 0.7, texDecay: 0.045, texLevel: 0.5, scuff: 0.35, grit: 4 },
  plaster:  { bodyF: 100, bodyDecay: 0.05, texKind: 'white', texF: 1800, texQ: 0.7, texDecay: 0.05, texLevel: 0.45, scuff: 0.3, grit: 4 },
  metal:    { bodyF: 120, bodyDecay: 0.05, texKind: 'white', texF: 3200, texQ: 1.0, texDecay: 0.04, texLevel: 0.5, scuff: 0.3, grit: 2,
    ring: [{ f: 620, q: 16, g: 0.24, decay: 0.16 }, { f: 1480, q: 20, g: 0.16, decay: 0.11 }, { f: 2900, q: 14, g: 0.08, decay: 0.06 }] },
  wood:     { bodyF: 110, bodyDecay: 0.06, texKind: 'white', texF: 1300, texQ: 0.8, texDecay: 0.04, texLevel: 0.4, scuff: 0.28, grit: 2,
    ring: [{ f: 260, q: 12, g: 0.26, decay: 0.09 }, { f: 540, q: 9, g: 0.14, decay: 0.05 }] },
  dirt:     { bodyF: 78, bodyDecay: 0.07, texKind: 'brown', texF: 620, texQ: 0.6, texDecay: 0.075, texLevel: 0.62, scuff: 0.45, grit: 6 },
  sand:     { bodyF: 70, bodyDecay: 0.06, texKind: 'white', texF: 1500, texQ: 0.45, texDecay: 0.14, texLevel: 0.6, scuff: 0.7, grit: 3 },
  glass:    { bodyF: 96, bodyDecay: 0.04, texKind: 'crackle', texF: 5200, texQ: 0.8, texDecay: 0.2, texLevel: 0.6, scuff: 0.3, grit: 9 },
  water:    { bodyF: 88, bodyDecay: 0.045, texKind: 'white', texF: 1600, texQ: 0.7, texDecay: 0.17, texLevel: 0.8, scuff: 0.5, grit: 3, splash: true },
  foliage:  { bodyF: 84, bodyDecay: 0.05, texKind: 'crackle', texF: 2400, texQ: 0.7, texDecay: 0.18, texLevel: 0.7, scuff: 0.5, grit: 6 },
  fabric:   { bodyF: 82, bodyDecay: 0.05, texKind: 'white', texF: 800, texQ: 0.6, texDecay: 0.05, texLevel: 0.3, scuff: 0.35, grit: 0 },
  flesh:    { bodyF: 86, bodyDecay: 0.055, texKind: 'white', texF: 520, texQ: 1.2, texDecay: 0.05, texLevel: 0.35, scuff: 0.2, grit: 0 },
  rubber:   { bodyF: 96, bodyDecay: 0.04, texKind: 'white', texF: 1000, texQ: 0.8, texDecay: 0.03, texLevel: 0.28, scuff: 0.2, grit: 0 },
};

/**
 * @param {object} o { when, surface, gait: 'walk'|'run'|'sprint'|'crouch'|'land',
 *                     level, gear (0..1), distance }
 */
export function footstep(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const s = STEP[o.surface] ?? STEP.concrete;
  const gait = o.gait ?? 'walk';
  const weight = gait === 'sprint' ? 1.25 : gait === 'run' ? 1.0 : gait === 'land' ? 1.7 : gait === 'crouch' ? 0.42 : 0.62;
  const lvl = (o.level ?? 1) * weight;
  const jit = semis(rng.range(-3, 3));
  const out = gain(actx, 0.32);  // VOICE TRIM
  let end = t0 + 0.3;

  /* heel/toe transient — two contacts, milliseconds apart, is what reads as a
     foot rather than a hammer. */
  const contacts = gait === 'land' ? 1 : 2;
  for (let c = 0; c < contacts; c++) {
    const ct = t0 + (c === 0 ? 0 : rng.range(0.012, 0.032));
    const cl = c === 0 ? 1 : rng.range(0.35, 0.6);

    const b = osc(actx, 'sine', s.bodyF * jit);
    const bg = gain(actx, 0);
    const drv = shaper(actx, saturationCurve(1.8, 0.5), '2x');
    b.connect(bg); series(bg, drv).connect(out);
    sweep(b.frequency, ct, s.bodyF * jit * 1.7, s.bodyF * jit * 0.75, s.bodyDecay * 1.4);
    ad(bg.gain, ct, 0.42 * lvl * cl, 0.0025, s.bodyDecay * rng.range(0.85, 1.2));
    b.start(ct); b.stop(ct + s.bodyDecay * 2.4 + 0.02);

    const src = bank.source(s.texKind, rng, rng.range(0.8, 1.25));
    const bp = biquad(actx, 'bandpass', s.texF * jit, s.texQ);
    const tg = gain(actx, 0);
    series(src, bp, tg).connect(out);
    sweep(bp.frequency, ct, s.texF * 1.4 * jit, s.texF * 0.55 * jit, s.texDecay * 2);
    ad(tg.gain, ct, s.texLevel * lvl * cl, 0.002, s.texDecay * rng.range(0.8, 1.3));
    src.start(ct, src._offset, s.texDecay * 3 + 0.05);
    end = Math.max(end, ct + s.texDecay * 3);

    if (s.ring && c === 0) {
      const parts = s.ring.map((p) => ({
        f: p.f * semis(rng.range(-2, 2)), q: p.q * rng.range(0.85, 1.2),
        g: p.g * lvl, decay: p.decay * rng.range(0.8, 1.25),
      }));
      struckResonator(actx, bank, rng, ct, parts, 0.003).connect(out);
      end = Math.max(end, ct + 0.3);
    }
  }

  /* scuff — the slide of the sole, longer when running */
  if (s.scuff > 0.05) {
    const st = t0 + rng.range(0.01, 0.04);
    const dur = (gait === 'sprint' ? 0.13 : gait === 'run' ? 0.1 : 0.07) * rng.range(0.8, 1.3);
    const src = bank.source('white', rng, rng.range(0.85, 1.2));
    const bp = biquad(actx, 'bandpass', rng.range(2200, 4200), 0.8);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    sweep(bp.frequency, st, rng.range(2800, 4600), rng.range(1200, 2000), dur);
    ad(g.gain, st, s.scuff * lvl * 0.5, 0.012, dur);
    src.start(st, src._offset, dur * 2);
    end = Math.max(end, st + dur * 2);
  }

  /* grit grains */
  for (let i = 0; i < s.grit; i++) {
    if (rng.float() > 0.55) continue;
    const gt = t0 + rng.range(0.004, 0.09);
    struckResonator(actx, bank, rng, gt, [
      { f: rng.range(2400, 9000), q: rng.range(10, 26), g: rng.range(0.015, 0.05) * lvl, decay: rng.range(0.008, 0.03) },
    ], 0.0015).connect(out);
  }

  /* water splash */
  if (s.splash) {
    const src = bank.source('white', rng, rng.range(0.9, 1.2));
    const bp = biquad(actx, 'bandpass', 900, 0.7);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    sweep(bp.frequency, t0, 700, 3400, 0.16);
    ad(g.gain, t0 + 0.006, 0.45 * lvl, 0.01, 0.2);
    src.start(t0, src._offset, 0.4);
    end = Math.max(end, t0 + 0.42);
  }

  /* gear: sling swivels, mag pouches, buckles — only when moving fast */
  const gear = (o.gear ?? (gait === 'sprint' ? 1 : gait === 'run' ? 0.7 : gait === 'land' ? 0.9 : 0.25));
  if (gear > 0.05) {
    const n = 1 + ((rng.u32() % 3) | 0);
    for (let i = 0; i < n; i++) {
      const gt = t0 + rng.range(0.005, 0.11);
      struckResonator(actx, bank, rng, gt, [
        { f: rng.range(1600, 4200), q: rng.range(18, 40), g: rng.range(0.03, 0.1) * gear * lvl, decay: rng.range(0.03, 0.12) },
        { f: rng.range(4200, 8000), q: rng.range(12, 26), g: rng.range(0.01, 0.04) * gear * lvl, decay: rng.range(0.01, 0.05) },
      ], 0.002).connect(out);
      end = Math.max(end, gt + 0.18);
    }
    // Cloth/webbing rustle.
    const src = bank.source('white', rng, rng.range(0.7, 1.1));
    const bp = biquad(actx, 'bandpass', rng.range(1400, 2600), 0.6);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    ad(g.gain, t0, 0.09 * gear * lvl, 0.02, 0.13);
    src.start(t0, src._offset, 0.3);
  }

  return { node: out, end: end + 0.05, send: 0.3 };
}
