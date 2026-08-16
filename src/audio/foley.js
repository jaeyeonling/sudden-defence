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
  ad, biquad, clamp, gain, hit, lerp, osc, saturationCurve, semis, series, shaper,
  struckResonator, sweep,
} from './dsp.js';

/**
 * Foley: cloth, brass, reloads, blasts, bodies and the UI. Impacts and
 * footsteps are in `foley-impacts.js`.
 */

/** Cloth movement, used for stance changes and ADS. */
export function cloth(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 1);
  const dur = rng.range(0.13, 0.26);
  const src = bank.source('white', rng, rng.range(0.7, 1.15));
  const bp = biquad(actx, 'bandpass', rng.range(1300, 2400), 0.55);
  const g = gain(actx, 0);
  series(src, bp, g).connect(out);
  sweep(bp.frequency, t0, rng.range(1000, 1600), rng.range(2200, 3400), dur);
  ad(g.gain, t0, 0.3 * lvl, 0.03, dur);
  src.start(t0, src._offset, dur * 2);
  if (rng.float() < 0.6) {
    struckResonator(actx, bank, rng, t0 + rng.range(0.02, 0.1), [
      { f: rng.range(2200, 5200), q: 26, g: 0.05 * lvl, decay: rng.range(0.03, 0.09) },
    ], 0.002).connect(out);
  }
  return { node: out, end: t0 + dur * 2 + 0.15, send: 0.2 };
}

/* ------------------------------------------------------------------ */
/* Shell casings                                                      */
/* ------------------------------------------------------------------ */

/**
 * A casing bounces 2–4 times with shortening intervals and then rolls. Brass on
 * concrete is one of the most recognisable sounds in a shooter; the trick is
 * that each bounce is a *different* set of partials because the shell lands on a
 * different part of itself.
 */
export function shellCasing(actx, bank, rng, o = {}) {
  const t0 = (o.when ?? actx.currentTime) + (o.flight ?? rng.range(0.28, 0.52));
  const surface = o.surface ?? 'concrete';
  const hard = surface === 'metal' || surface === 'concrete' || surface === 'glass' || surface === 'plaster';
  const soft = surface === 'dirt' || surface === 'sand' || surface === 'foliage' || surface === 'fabric';
  const out = gain(actx, 1);
  const base = rng.range(2650, 4200);
  let t = t0;
  let amp = (o.level ?? 1) * (soft ? 0.35 : 1) * rng.range(0.8, 1.1);
  const bounces = soft ? 1 : 2 + ((rng.u32() % 3) | 0);
  let end = t0;
  for (let i = 0; i < bounces; i++) {
    const detune = semis(rng.range(-4, 4));
    struckResonator(actx, bank, rng, t, [
      { f: base * detune, q: rng.range(30, 60), g: 0.95 * amp, decay: rng.range(0.05, 0.13) * (hard ? 1 : 0.5) },
      { f: base * detune * 1.87, q: rng.range(24, 44), g: 0.58 * amp, decay: rng.range(0.03, 0.08) },
      { f: base * detune * 3.1, q: rng.range(16, 30), g: 0.3 * amp, decay: rng.range(0.015, 0.04) },
      { f: base * detune * 0.42, q: 12, g: 0.2 * amp, decay: 0.03 },
    ], 0.0015).connect(out);
    end = t + 0.2;
    t += rng.range(0.045, 0.13) * (i === 0 ? 1 : 0.6);
    amp *= rng.range(0.38, 0.62);
    if (amp < 0.03) break;
  }
  // Roll: a stream of very quiet, very short pings.
  if (hard && rng.float() < 0.55) {
    const rolls = 3 + ((rng.u32() % 5) | 0);
    for (let i = 0; i < rolls; i++) {
      const rt = t + i * rng.range(0.018, 0.05);
      struckResonator(actx, bank, rng, rt, [
        { f: base * semis(rng.range(-5, 5)), q: rng.range(20, 44), g: rng.range(0.03, 0.09) * (o.level ?? 1), decay: rng.range(0.01, 0.03) },
      ], 0.0012).connect(out);
      end = Math.max(end, rt + 0.06);
    }
  }
  return { node: out, end: end + 0.05, send: 0.42 };
}

/* ------------------------------------------------------------------ */
/* Reload foley                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reload mechanics, one call per `weapon:reload` phase. Keeping the phases as
 * separate one-shots (instead of one long sound) is what lets the audio stay
 * locked to the animation whatever its length.
 */
/** The four phases are wildly different in energy; level them per phase. */
const RELOAD_TRIM = { start: 3.2, magout: 3.0, magin: 1.0, end: 1.5 };

export function reloadPhase(actx, bank, rng, phase, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const heavy = o.heavy ?? 1; // LMG/shotgun = heavier hardware
  const out = gain(actx, 0.42 * (RELOAD_TRIM[phase] ?? 1.5)); // VOICE TRIM
  let end = t0 + 0.3;
  const metal = (t, parts, exc = 0.0025) => {
    struckResonator(actx, bank, rng, t, parts, exc).connect(out);
    end = Math.max(end, t + 0.35);
  };
  const rustle = (t, dur, level, f) => {
    const src = bank.source('white', rng, rng.range(0.8, 1.2));
    const bp = biquad(actx, 'bandpass', f, 0.6);
    const g = gain(actx, 0);
    series(src, bp, g).connect(out);
    ad(g.gain, t, level, 0.02, dur);
    src.start(t, src._offset, dur * 2 + 0.05);
    end = Math.max(end, t + dur * 2);
  };

  switch (phase) {
    case 'start':
      // Hand leaves the grip, palm slaps the magwell, mag catch is pressed.
      rustle(t0, 0.18, 0.2, rng.range(1400, 2200));
      metal(t0 + rng.range(0.04, 0.08), [
        { f: 2450 * semis(rng.range(-2, 2)), q: 30, g: 0.55 * heavy, decay: 0.03 },
        { f: 5100, q: 18, g: 0.25, decay: 0.016 },
        { f: 780, q: 10, g: 0.3 * heavy, decay: 0.045 },
      ]);
      break;

    case 'magout': {
      // Spring release, mag scrapes out of the well, then plastic hits the deck.
      metal(t0, [
        { f: 1650 * semis(rng.range(-2, 2)), q: 24, g: 0.65 * heavy, decay: 0.05 },
        { f: 3400, q: 16, g: 0.35, decay: 0.025 },
      ]);
      const st = t0 + 0.03;
      const src = bank.source('white', rng, rng.range(0.9, 1.3));
      const bp = biquad(actx, 'bandpass', 3200, 1.1);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      sweep(bp.frequency, st, 4200, 1600, 0.12);
      ad(g.gain, st, 0.2, 0.01, 0.12);
      src.start(st, src._offset, 0.3);
      // Empty magazine hitting the ground — polymer, not metal.
      const dt = t0 + rng.range(0.16, 0.3);
      metal(dt, [
        { f: 480 * semis(rng.range(-3, 3)), q: 9, g: 0.2, decay: 0.05 },
        { f: 1180, q: 7, g: 0.11, decay: 0.03 },
        { f: 2600, q: 5, g: 0.05, decay: 0.015 },
      ], 0.004);
      end = Math.max(end, dt + 0.3);
      break;
    }

    case 'magin': {
      // Fresh mag guided in, seated with a palm strike: a low thunk plus a sharp
      // latch click. The thunk needs real low end or it feels weightless.
      rustle(t0, 0.12, 0.16, rng.range(1200, 2000));
      const it = t0 + rng.range(0.05, 0.1);
      const b = osc(actx, 'sine', 190 * heavy);
      const bg = gain(actx, 0);
      const drv = shaper(actx, saturationCurve(3, 0.5), '2x');
      b.connect(bg); series(bg, drv).connect(out);
      sweep(b.frequency, it, 230 * heavy, 110 * heavy, 0.06);
      ad(bg.gain, it, 0.4 * heavy, 0.002, 0.055);
      b.start(it); b.stop(it + 0.16);
      metal(it, [
        { f: 1250 * semis(rng.range(-2, 2)), q: 20, g: 0.3 * heavy, decay: 0.06 },
        { f: 2800, q: 26, g: 0.18, decay: 0.03 },
        { f: 6200, q: 14, g: 0.07, decay: 0.012 },
      ], 0.003);
      metal(it + rng.range(0.02, 0.05), [
        { f: 3600, q: 34, g: 0.16, decay: 0.02 },
        { f: 7400, q: 20, g: 0.07, decay: 0.01 },
      ], 0.0015);
      break;
    }

    case 'end':
    default: {
      // Charging handle: scrape, hard rearward stop, spring-driven return, and
      // the bolt slamming into battery.
      const st = t0;
      const src = bank.source('white', rng, rng.range(0.9, 1.25));
      const bp = biquad(actx, 'bandpass', 2600, 1.6);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      sweep(bp.frequency, st, 1800, 4200, 0.07);
      ad(g.gain, st, 0.24, 0.008, 0.07);
      src.start(st, src._offset, 0.2);
      metal(st + 0.06, [
        { f: 1450 * semis(rng.range(-2, 2)), q: 22, g: 0.3 * heavy, decay: 0.05 },
        { f: 3100, q: 18, g: 0.16, decay: 0.022 },
      ]);
      // Spring ring — the metallic "zing" behind the clack.
      metal(st + 0.065, [
        { f: 4900 * semis(rng.range(-3, 3)), q: 46, g: 0.09, decay: 0.16 },
        { f: 7200, q: 38, g: 0.05, decay: 0.1 },
      ], 0.002);
      const bt = st + rng.range(0.1, 0.15);
      const b = osc(actx, 'sine', 150 * heavy);
      const bg = gain(actx, 0);
      b.connect(bg); bg.connect(out);
      sweep(b.frequency, bt, 200 * heavy, 90 * heavy, 0.05);
      ad(bg.gain, bt, 0.38 * heavy, 0.0015, 0.05);
      b.start(bt); b.stop(bt + 0.14);
      metal(bt, [
        { f: 1750, q: 20, g: 0.34 * heavy, decay: 0.05 },
        { f: 3900, q: 15, g: 0.15, decay: 0.02 },
        { f: 8200, q: 10, g: 0.05, decay: 0.008 },
      ], 0.0035);
      break;
    }
  }
  return { node: out, end: end + 0.05, send: 0.3 };
}

/* ------------------------------------------------------------------ */
/* Explosions                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o { when, distance, radius, level }
 * Near: a violent transient, a huge sub sweep and a bright shrapnel spatter.
 * Far: almost no transient, a long rolling low rumble, and a big wet tail.
 */
export function explosion(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const dist = Math.max(0, o.distance ?? 0);
  const size = clamp((o.radius ?? 6) / 6, 0.5, 2.4);
  const near = clamp(1 - dist / 70, 0, 1);
  const far = 1 - near;
  const lvl = (o.level ?? 1) * size;
  const out = gain(actx, 0.42); // VOICE TRIM
  let end = t0 + 1;

  /* detonation transient */
  if (near > 0.05) {
    const src = bank.source('white', rng, rng.range(0.9, 1.2));
    const hp = biquad(actx, 'highpass', 1800, 0.6);
    const drv = shaper(actx, saturationCurve(14, 0.7), '4x');
    const g = gain(actx, 0);
    series(src, hp, drv, g).connect(out);
    hit(g.gain, t0, 0.85 * near * lvl, 0.02);
    src.start(t0, src._offset, 0.1);
  }

  /* sub-bass impact: the thing you feel in your chest */
  {
    const s = osc(actx, 'sine', 110);
    const s2 = osc(actx, 'triangle', 62);
    const g = gain(actx, 0);
    const drv = shaper(actx, saturationCurve(4, 0.6), '2x');
    const lp = biquad(actx, 'lowpass', 220, 0.9);
    s.connect(g); s2.connect(g);
    series(g, drv, lp).connect(out);
    const subDur = (0.55 + size * 0.35) * rng.range(0.9, 1.15);
    sweep(s.frequency, t0, 130 * size, 26, subDur);
    sweep(s2.frequency, t0, 74 * size, 21, subDur * 1.2);
    ad(g.gain, t0, 1.0 * lvl * (0.55 + near * 0.6), 0.008 + far * 0.05, subDur);
    s.start(t0); s2.start(t0);
    s.stop(t0 + subDur * 1.6); s2.stop(t0 + subDur * 1.6);
    end = Math.max(end, t0 + subDur * 1.6);
  }

  /* blast body: broadband noise under a fast-falling lowpass */
  {
    const dur = (0.45 + size * 0.5) * (1 + far * 1.8);
    const src = bank.source('brown', rng, rng.range(0.6, 1.1));
    const lp = biquad(actx, 'lowpass', 6000, 0.8);
    const drv = shaper(actx, saturationCurve(6, 0.5), '2x');
    const g = gain(actx, 0);
    series(src, lp, drv, g).connect(out);
    sweep(lp.frequency, t0, lerp(7000, 700, far), lerp(260, 130, far), dur);
    ad(g.gain, t0, 0.8 * lvl, 0.01 + far * 0.06, dur);
    src.start(t0, src._offset, dur * 1.4 + 0.1);
    end = Math.max(end, t0 + dur * 1.4);
  }

  /* debris / shrapnel: grains scattered over the following second */
  const grains = Math.round(lerp(26, 4, far) * size);
  for (let i = 0; i < grains; i++) {
    const gt = t0 + rng.range(0.02, 0.9) * rng.range(0.3, 1);
    struckResonator(actx, bank, rng, gt, [
      { f: rng.range(700, 7000), q: rng.range(8, 32), g: rng.range(0.02, 0.09) * near * lvl, decay: rng.range(0.01, 0.09) },
    ], 0.002).connect(out);
    end = Math.max(end, gt + 0.15);
  }

  /* dust and settling */
  {
    const dur = 1.0 + size * 0.8;
    const src = bank.source('pink', rng, rng.range(0.5, 0.9));
    const lp = biquad(actx, 'lowpass', 1400, 0.7);
    const g = gain(actx, 0);
    series(src, lp, g).connect(out);
    sweep(lp.frequency, t0, 1600, 320, dur);
    ad(g.gain, t0 + 0.05, 0.2 * lvl * (0.4 + near * 0.6), 0.12, dur);
    src.start(t0 + 0.05, src._offset, dur * 1.3);
    end = Math.max(end, t0 + dur * 1.3);
  }

  return { node: out, end: end + 0.1, send: 0.85 + far * 0.5 };
}

/** A body hitting the ground: mass, gear, and a wet slap. */
export function bodyFall(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 0.4); // VOICE TRIM
  const b = osc(actx, 'sine', 74);
  const bg = gain(actx, 0);
  const drv = shaper(actx, saturationCurve(2.2, 0.55), '2x');
  b.connect(bg); series(bg, drv).connect(out);
  sweep(b.frequency, t0, 96, 44, 0.12);
  ad(bg.gain, t0, 0.6 * lvl, 0.004, 0.13);
  b.start(t0); b.stop(t0 + 0.35);

  const src = bank.source('white', rng, rng.range(0.7, 1.1));
  const lp = biquad(actx, 'lowpass', 900, 0.8);
  const g = gain(actx, 0);
  series(src, lp, g).connect(out);
  ad(g.gain, t0, 0.35 * lvl, 0.006, 0.16);
  src.start(t0, src._offset, 0.4);

  for (let i = 0; i < 5; i++) {
    const gt = t0 + rng.range(0.005, 0.26);
    struckResonator(actx, bank, rng, gt, [
      { f: rng.range(1500, 5200), q: rng.range(16, 40), g: rng.range(0.03, 0.09) * lvl, decay: rng.range(0.02, 0.1) },
    ], 0.002).connect(out);
  }
  return { node: out, end: t0 + 0.6, send: 0.4 };
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

/** Non-diegetic feedback. Short, dry, and deliberately synthetic. */
export function uiSound(actx, bank, rng, kind, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const out = gain(actx, 1);
  const lvl = o.level ?? 1;
  switch (kind) {
    case 'hitmarker': {
      const o1 = osc(actx, 'square', 2400);
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 5200, 0.7);
      o1.connect(g); series(g, lp).connect(out);
      hit(g.gain, t0, 0.55 * lvl, 0.022);
      o1.start(t0); o1.stop(t0 + 0.06);
      break;
    }
    case 'headshot': {
      const o1 = osc(actx, 'square', 3200);
      const o2 = osc(actx, 'square', 4800);
      const g = gain(actx, 0);
      o1.connect(g); o2.connect(g); g.connect(out);
      hit(g.gain, t0, 0.34 * lvl, 0.05);
      o1.start(t0); o2.start(t0 + 0.03);
      o1.stop(t0 + 0.12); o2.stop(t0 + 0.14);
      break;
    }
    /**
     * ── ROUND PHASE CUES ────────────────────────────────────────────────
     *
     * The round machine has always changed phase silently. `MatchBar` swapped a
     * small label at the top of the screen from GET READY to ROUND 3 and that
     * was the entire announcement, so the boundary between not-fighting and
     * fighting — the one moment in a round that a player has to feel exactly —
     * arrived without a sound or a flash.
     *
     * Three cues, pitched apart on purpose so they are told apart with the
     * screen ignored: a dry tick that climbs as the countdown runs out, a bright
     * rising fifth for the bell, and a low settle for the lull between rounds.
     */
    case 'round_tick': {
      // Dry, short, and pitched by `level` so 3-2-1 rises. A metronome, not a
      // melody: it should read as time passing, not as a tune.
      const o1 = osc(actx, 'square', 700 + 260 * (o.step ?? 0));
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 3600, 0.7);
      o1.connect(g); series(g, lp).connect(out);
      hit(g.gain, t0, 0.34 * lvl, 0.03);
      o1.start(t0); o1.stop(t0 + 0.07);
      break;
    }
    case 'round_go': {
      // The bell. A rising perfect fifth an octave over the ticks, so it lands
      // clear of them and cannot be mistaken for another count.
      const a = osc(actx, 'triangle', 1180);
      const b = osc(actx, 'triangle', 1770);
      const g = gain(actx, 0);
      a.connect(g); b.connect(g); g.connect(out);
      ad(g.gain, t0, 0.5 * lvl, 0.006, 0.34);
      a.start(t0); b.start(t0 + 0.045);
      a.stop(t0 + 0.5); b.stop(t0 + 0.5);
      break;
    }
    case 'round_freeze': {
      // Falling, low and soft: the opposite gesture to the bell, so "you may
      // not move" and "go" are never confused when both arrive within seconds.
      const o1 = osc(actx, 'sine', 420);
      const g = gain(actx, 0);
      o1.connect(g); g.connect(out);
      o1.frequency.setValueAtTime(420, t0);
      o1.frequency.exponentialRampToValueAtTime(240, t0 + 0.36);
      ad(g.gain, t0, 0.3 * lvl, 0.02, 0.42);
      o1.start(t0); o1.stop(t0 + 0.5);
      break;
    }
    case 'kill': {
      for (let i = 0; i < 3; i++) {
        const o1 = osc(actx, 'triangle', 900 * Math.pow(1.5, i));
        const g = gain(actx, 0);
        o1.connect(g); g.connect(out);
        ad(g.gain, t0 + i * 0.055, 0.3 * lvl, 0.004, 0.09);
        o1.start(t0 + i * 0.055); o1.stop(t0 + i * 0.055 + 0.2);
      }
      break;
    }
    case 'damage': {
      // Directional pain sting: a dissonant low pair, no melody.
      const o1 = osc(actx, 'sawtooth', 180);
      const o2 = osc(actx, 'sawtooth', 191);
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 1400, 1.4);
      o1.connect(g); o2.connect(g); series(g, lp).connect(out);
      ad(g.gain, t0, 0.42 * lvl, 0.004, 0.22);
      o1.start(t0); o2.start(t0);
      o1.stop(t0 + 0.4); o2.stop(t0 + 0.4);
      break;
    }
    case 'armour': {
      // Ceramic plate strike: brighter and harder than a flesh hitmarker.
      const r = struckResonator(actx, bank, rng, t0, [
        { f: 3900, q: 30, g: 0.09 * lvl, decay: 0.045 },
        { f: 6400, q: 22, g: 0.05 * lvl, decay: 0.025 },
      ], 0.0015);
      r.connect(out);
      break;
    }
    case 'grenade_warn': {
      // Three rising beeps — reads as "danger", not as a notification.
      for (let i = 0; i < 3; i++) {
        const bt = t0 + i * 0.14;
        const o1 = osc(actx, 'square', 1150 * Math.pow(1.19, i));
        const lp = biquad(actx, 'lowpass', 4200, 0.8);
        const g = gain(actx, 0);
        o1.connect(g); series(g, lp).connect(out);
        ad(g.gain, bt, 0.3 * lvl, 0.004, 0.07);
        o1.start(bt); o1.stop(bt + 0.16);
      }
      break;
    }
    case 'regen': {
      // Soft filtered swell: the "you are OK now" cue. Deliberately unpitched.
      const src = bank.source('pink', rng, 0.9);
      const bp = biquad(actx, 'bandpass', 700, 1.1);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      sweep(bp.frequency, t0, 500, 1900, 0.5);
      ad(g.gain, t0, 0.3 * lvl, 0.15, 0.45);
      src.start(t0, src._offset, 0.9);
      const o1 = osc(actx, 'sine', 420);
      const og = gain(actx, 0);
      o1.connect(og); og.connect(out);
      sweep(o1.frequency, t0, 380, 640, 0.45);
      ad(og.gain, t0, 0.12 * lvl, 0.14, 0.4);
      o1.start(t0); o1.stop(t0 + 0.8);
      break;
    }
    case 'lowhealth': {
      const o1 = osc(actx, 'sine', 92);
      const g = gain(actx, 0);
      o1.connect(g); g.connect(out);
      ad(g.gain, t0, 0.45 * lvl, 0.05, 0.55);
      o1.start(t0); o1.stop(t0 + 0.9);
      break;
    }
    default: {
      const o1 = osc(actx, 'sine', 1200);
      const g = gain(actx, 0);
      o1.connect(g); g.connect(out);
      hit(g.gain, t0, 0.26 * lvl, 0.03);
      o1.start(t0); o1.stop(t0 + 0.08);
    }
  }
  return { node: out, end: t0 + 0.9, send: 0 };
}

/**
 * Heartbeat + laboured breathing for low health. Returned so the caller can
 * schedule it repeatedly rather than looping a node.
 */
export function heartbeat(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 0.5); // VOICE TRIM
  for (let i = 0; i < 2; i++) {
    const bt = t0 + i * 0.19;
    const b = osc(actx, 'sine', 58);
    const g = gain(actx, 0);
    b.connect(g); g.connect(out);
    sweep(b.frequency, bt, 72, 42, 0.1);
    ad(g.gain, bt, (i === 0 ? 0.5 : 0.33) * lvl, 0.008, 0.11);
    b.start(bt); b.stop(bt + 0.3);
  }
  return { node: out, end: t0 + 0.6, send: 0.1 };
}

