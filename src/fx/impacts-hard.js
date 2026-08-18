import { P, D } from './atlas.js';
import { resetSpawn } from './particles.js';
import { V, V2, C, C2, reflect, cone, discOn, blackbody, towardHemi, clampCone, COS55 } from './util.js';
import { screenAngle } from './muzzle.js';
import { TWO_PI, bulletHole, spark } from './impacts-base.js';

/** Concrete, plaster and metal — the three that spall. */

/** Concrete / brick / stone: pale dust, spall chips, a wisp that hangs. */
export function concrete(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  const rx = (V.x + n.x) * 0.5;
  const ry = (V.y + n.y) * 0.5;
  const rz = (V.z + n.z) * 0.5;

  // muzzle-side flash of pulverised, incandescent grit — two frames only
  let s = resetSpawn();
  s.x = p.x + n.x * 0.01; s.y = p.y + n.y * 0.01; s.z = p.z + n.z * 0.01;
  s.tile = P.FLASH_CORE;
  s.size0 = 0.045 * e; s.size1 = 0.19 * e; s.sizeCurve = 0.42;
  s.life = 0.07; s.drag = 6;
  s.r0 = 1; s.g0 = 0.72; s.b0 = 0.4; s.i0 = 10 * e;
  s.r1 = 1; s.g1 = 0.4; s.b1 = 0.12; s.i1 = 0;
  s.alphaCurve = 0.7; s.soft = 0.25; s.seed = rng.float();
  fx.emitAdd(s);

  // Dust cough, in THREE sub-puffs with different lifetimes and sizes: a single
  // population expanding at one rate is a smudge, three staggered ones read as
  // an aerosol. Colour is the struck surface's own albedo — warm ochre concrete
  // dust, not the cold grey-blue it used to be, which is what a neutral grey
  // particle becomes once the blue sky term lights it.
  //
  // `sunSide` self-shadows the puff along the sun: the sub-puffs launched away
  // from the sun start dimmer, so the cluster has a lit side and a shadow side.
  const nDust = Math.round(9 * q) + 3;
  const sun = fx.sunWorld();
  for (let i = 0; i < nDust; i++) {
    const band = i % 3; // 0 fast+small, 1 mid, 2 slow lingering veil
    cone(V2, rng, rx, ry, rz, band === 0 ? 0.85 : 1.25, 0.7);
    towardHemi(V2, n.x, n.y, n.z, 0.05);
    const sp = band === 0 ? rng.range(1.8, 3.2) : band === 1 ? rng.range(0.9, 1.9) : rng.range(0.4, 1.0);
    s = resetSpawn();
    discOn(V, rng, n.x, n.y, n.z, 0.09);
    const off = rng.range(0.05, 0.16);
    s.x = p.x + V.x + n.x * off;
    s.y = p.y + V.y + n.y * off;
    s.z = p.z + V.z + n.z * off;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.45; s.vz = V2.z * sp;
    s.tile = band === 2 ? P.SMOKE_A : P.DUST;
    s.size0 = rng.range(0.045, 0.1) * e * (band === 0 ? 0.8 : 1);
    s.size1 = rng.range(0.3, 0.62) * e * (band === 2 ? 1.35 : 1);
    // BILLOW, not scale: each band has its own size-vs-life exponent and its own
    // ignition delay, so the cluster keeps unfurling new lobes for a second
    // instead of every sprite growing in lockstep (which is what makes a plume
    // read as one smudge being zoomed).
    s.sizeCurve = band === 0 ? 0.3 : band === 1 ? 0.5 : 0.78;
    s.delay = band === 0 ? 0 : rng.range(0.02, band === 1 ? 0.09 : 0.2);
    s.life = band === 0 ? rng.range(0.22, 0.4) : band === 1 ? rng.range(0.5, 0.85) : rng.range(1.1, 1.8);
    s.drag = band === 0 ? rng.range(5, 7) : rng.range(2.6, 4.0);
    s.gravity = -0.7;
    s.rot = rng.float() * TWO_PI;
    s.spin = rng.signed() * 1.5;
    // Warm ochre mortar dust carrying the host's albedo hue, split into a sun
    // side and a shadow side: a full stop of lambert between the sub-puffs
    // thrown into the light and the ones thrown away from it. A flat tint here
    // is what sampled as the uniform rgb(163,156,145) grey-white blur.
    const lit = 0.68 + 0.72 * Math.max(0, V2.x * sun.x + V2.y * sun.y + V2.z * sun.z);
    s.r0 = 0.56 * lit; s.g0 = 0.462 * lit; s.b0 = 0.33 * lit; s.i0 = 1;
    s.r1 = 0.45 * lit; s.g1 = 0.365 * lit; s.b1 = 0.26 * lit; s.i1 = 1;
    s.alpha = rng.range(0.4, 0.72) * (band === 2 ? 0.7 : 1);
    s.alphaCurve = 1.5;
    s.soft = 0.09;
    s.turb = 0.05; s.turbFreq = 2.4; s.seed = rng.float();
    fx.emitLit(s);
  }

  // Directional ejecta cone: a tight 0.3 s jet of pulverised surface thrown
  // straight down the reflected ray. This is the cue that tells you which way
  // the round was travelling, and no amount of radial dust supplies it.
  const nJet = Math.round(5 * q) + 2;
  for (let i = 0; i < nJet; i++) {
    cone(V2, rng, rx, ry, rz, 0.34, 1.6);
    const sp = rng.range(3.4, 7.5);
    s = resetSpawn();
    s.x = p.x + n.x * 0.02; s.y = p.y + n.y * 0.02; s.z = p.z + n.z * 0.02;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.2; s.vz = V2.z * sp;
    s.tile = P.DUST;
    s.size0 = rng.range(0.025, 0.05) * e;
    s.size1 = rng.range(0.14, 0.26) * e;
    s.sizeCurve = 0.5;
    s.life = rng.range(0.18, 0.32);
    s.drag = rng.range(6, 9);
    s.gravity = -1.2;
    s.rot = rng.float() * TWO_PI;
    s.spin = rng.signed() * 2.2;
    s.r0 = 0.58; s.g0 = 0.475; s.b0 = 0.34;
    s.r1 = 0.47; s.g1 = 0.38; s.b1 = 0.27;
    s.alpha = rng.range(0.35, 0.6);
    s.alphaCurve = 1.2;
    s.soft = 0.08;
    s.seed = rng.float();
    fx.emitLit(s);
  }

  // spall: solid chips on the reflected cone, real ballistic arcs
  const nChip = Math.round(9 * q) + 3;
  for (let i = 0; i < nChip; i++) {
    cone(V2, rng, rx, ry, rz, 0.85, 1.4);
    const sp = rng.range(3.5, 9.5);
    s = resetSpawn();
    s.x = p.x + n.x * 0.01; s.y = p.y + n.y * 0.01; s.z = p.z + n.z * 0.01;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.CHIP;
    s.size0 = rng.range(0.008, 0.026);
    s.size1 = s.size0 * 0.9;
    s.life = rng.range(0.5, 1.0);
    s.drag = 0.35;
    s.gravity = -19;
    s.rot = rng.float() * TWO_PI;
    s.spin = rng.signed() * 22;
    s.r0 = 0.5; s.g0 = 0.48; s.b0 = 0.45; s.i0 = 1;
    s.r1 = 0.42; s.g1 = 0.4; s.b1 = 0.38; s.i1 = 1;
    s.alphaCurve = 0.25;
    s.soft = 0.06;
    s.seed = rng.float();
    fx.emitLit(s);
  }

  // aggregate sparks — concrete has flint in it, you see a few every hit
  const nSpark = Math.round(4 * q);
  for (let i = 0; i < nSpark; i++) {
    cone(V2, rng, rx, ry, rz, 0.85, 1.2);
    towardHemi(V2, n.x, n.y, n.z, 0.12);
    // +-55 deg about the surface normal. Without the clamp a fan this wide
    // throws sparks sideways past the camera, which is what makes a burst read
    // as a random-direction emitter instead of as ejecta.
    clampCone(V2, n.x, n.y, n.z, COS55);
    spark(fx, p.x + n.x * 0.01, p.y + n.y * 0.01, p.z + n.z * 0.01, V2.x, V2.y, V2.z, rng.range(3, 8), {
      intensity: 0.7,
      // one bounce for the first couple: cheap, and it is what makes them
      // skitter off the pavement instead of evaporating
      bounces: i < 2 ? 1 : 0,
    });
  }

  // the wisp that hangs in the air afterwards and gives the frame its aftermath
  const nWisp = Math.round(2 * q) + 1;
  for (let i = 0; i < nWisp; i++) {
    cone(V2, rng, n.x, n.y, n.z, 1.0, 0.6);
    s = resetSpawn();
    s.x = p.x + n.x * 0.16 + V2.x * 0.07;
    s.y = p.y + n.y * 0.16 + V2.y * 0.07;
    s.z = p.z + n.z * 0.16 + V2.z * 0.07;
    s.vx = V2.x * 0.35; s.vy = 0.42 + rng.range(0, 0.25); s.vz = V2.z * 0.35;
    s.tile = i % 2 ? P.WISP : P.SMOKE_B;
    s.size0 = rng.range(0.12, 0.2) * e;
    s.size1 = rng.range(0.7, 1.2) * e;
    s.sizeCurve = 0.75;
    s.life = rng.range(1.7, 2.9);
    s.drag = 1.5;
    s.gravity = 0.28; // buoyant
    s.rot = rng.float() * TWO_PI;
    s.spin = rng.signed() * 0.5;
    s.r0 = 0.55; s.g0 = 0.49; s.b0 = 0.40;
    s.r1 = 0.46; s.g1 = 0.41; s.b1 = 0.34;
    s.alpha = rng.range(0.28, 0.46);
    s.alphaCurve = 1.35;
    s.soft = 0.14;
    s.turb = 0.14; s.turbFreq = 1.1; s.seed = rng.float();
    fx.emitLit(s);
  }

  bulletHole(fx, p, n, {
    tile: rng.float() < 0.5 ? D.HOLE_CONCRETE : D.HOLE_CONCRETE_B,
    min: 0.05,
    max: 0.075,
    e,
    soot: 0.4,
    haloScale: 1.1,
  });
}

/** Plaster / drywall: white powder, crumbs, no sparks. */
export function plaster(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  const rx = (V.x + n.x * 1.3) * 0.5;
  const ry = (V.y + n.y * 1.3) * 0.5;
  const rz = (V.z + n.z * 1.3) * 0.5;
  let s;
  const PSUN = fx.sunWorld();
  const nDust = Math.round(8 * q) + 3;
  for (let i = 0; i < nDust; i++) {
    cone(V2, rng, rx, ry, rz, 1.3, 0.6);
    towardHemi(V2, n.x, n.y, n.z, 0.05);
    const sp = rng.range(0.6, 2.2);
    s = resetSpawn();
    const off = rng.range(0.05, 0.14);
    s.x = p.x + n.x * off; s.y = p.y + n.y * off; s.z = p.z + n.z * off;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.4; s.vz = V2.z * sp;
    s.tile = i % 2 ? P.DUST : P.MIST;
    const band = i % 3;
    s.size0 = rng.range(0.05, 0.11) * e * (band === 0 ? 0.8 : 1);
    s.size1 = rng.range(0.34, 0.62) * e * (band === 2 ? 1.3 : 1);
    // billow: per-band growth exponent + ignition delay (see concrete())
    s.sizeCurve = band === 0 ? 0.3 : band === 1 ? 0.48 : 0.78;
    s.delay = band === 0 ? 0 : rng.range(0.02, band === 1 ? 0.1 : 0.22);
    // three lifetimes: the flash of powder, the body of the puff, the veil
    s.life = band === 0 ? rng.range(0.25, 0.45) : band === 1 ? rng.range(0.7, 1.2) : rng.range(1.4, 2.2);
    s.drag = band === 0 ? rng.range(5, 7) : rng.range(2.6, 3.8);
    s.gravity = -0.55;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 1.2;
    // Lime plaster over mud brick: the dust is the host's OWN ochre, not a pale
    // neutral, and it carries a full stop of lambert between the sub-puffs
    // thrown into the sun and the ones thrown away from it.
    const lit = 0.68 + 0.74 * Math.max(0, V2.x * PSUN.x + V2.y * PSUN.y + V2.z * PSUN.z);
    s.r0 = 0.74 * lit; s.g0 = 0.63 * lit; s.b0 = 0.465 * lit;
    s.r1 = 0.63 * lit; s.g1 = 0.53 * lit; s.b1 = 0.385 * lit;
    s.alpha = rng.range(0.42, 0.72) * (band === 2 ? 0.7 : 1); s.alphaCurve = 1.6;
    s.soft = 0.09; s.turb = 0.06; s.turbFreq = 2; s.seed = rng.float();
    fx.emitLit(s);
  }
  const nChip = Math.round(7 * q) + 2;
  for (let i = 0; i < nChip; i++) {
    cone(V2, rng, rx, ry, rz, 0.95, 1.3);
    const sp = rng.range(2, 6);
    s = resetSpawn();
    s.x = p.x + n.x * 0.01; s.y = p.y + n.y * 0.01; s.z = p.z + n.z * 0.01;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.CHIP;
    s.size0 = rng.range(0.007, 0.02); s.size1 = s.size0;
    s.life = rng.range(0.5, 0.9); s.drag = 0.5; s.gravity = -19;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 18;
    s.r0 = 0.72; s.g0 = 0.65; s.b0 = 0.52;
    s.r1 = 0.64; s.g1 = 0.575; s.b1 = 0.46;
    s.alphaCurve = 0.25; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
  }
  // 0.3 s directional ejecta along the reflected ray
  for (let i = 0; i < Math.round(4 * q) + 2; i++) {
    cone(V2, rng, rx, ry, rz, 0.32, 1.6);
    const sp = rng.range(3, 6.5);
    s = resetSpawn();
    s.x = p.x + n.x * 0.02; s.y = p.y + n.y * 0.02; s.z = p.z + n.z * 0.02;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.2; s.vz = V2.z * sp;
    s.tile = P.DUST;
    s.size0 = rng.range(0.022, 0.045) * e;
    s.size1 = rng.range(0.12, 0.24) * e;
    s.sizeCurve = 0.5;
    s.life = rng.range(0.18, 0.3);
    s.drag = rng.range(6, 9);
    s.gravity = -1.1;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 2.2;
    s.r0 = 0.77; s.g0 = 0.66; s.b0 = 0.485;
    s.r1 = 0.65; s.g1 = 0.55; s.b1 = 0.40;
    s.alpha = rng.range(0.35, 0.6); s.alphaCurve = 1.2;
    s.soft = 0.08; s.seed = rng.float();
    fx.emitLit(s);
  }
  bulletHole(fx, p, n, { tile: D.HOLE_PLASTER, min: 0.045, max: 0.07, e, soot: 0.15 });
}

/** Steel: the sparks are the whole story. Bright, streaked, short-lived. */
export function metal(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  const grazing = 1 - Math.abs(inc.x * n.x + inc.y * n.y + inc.z * n.z); // 0 head-on, 1 sliding
  const rx = V.x * 0.8 + n.x * 0.2;
  const ry = V.y * 0.8 + n.y * 0.2;
  const rz = V.z * 0.8 + n.z * 0.2;

  // ricochet flash: one tongue of incandescent gas+grit thrown along the
  // reflected ray, gone in 3 frames. FLASH_LOBE is rooted at its -X edge, so it
  // is rolled to the ray's screen angle and slid out to put that root on the
  // impact point instead of straddling it.
  let s = resetSpawn();
  const rlen = 0.5 * e * 0.3;
  s.x = p.x + n.x * 0.012 + rx * rlen;
  s.y = p.y + n.y * 0.012 + ry * rlen;
  s.z = p.z + n.z * 0.012 + rz * rlen;
  s.tile = P.FLASH_LOBE;
  // 0.30 m, not 0.58: at half a metre across and this radiance the tongue and the
  // core fused into one clipped white ball through the bloom and the spark shower
  // behind it — the actual subject of a steel hit — stopped reading at all.
  s.size0 = 0.08 * e; s.size1 = 0.3 * e; s.sizeCurve = 0.38;
  s.life = 0.07; s.drag = 8;
  s.rot = screenAngle(fx, false, rx, ry, rz) + rng.signed() * 0.2;
  s.r0 = 1; s.g0 = 0.6; s.b0 = 0.26; s.i0 = 9 * e;
  s.r1 = 1; s.g1 = 0.5; s.b1 = 0.16; s.i1 = 0;
  s.alphaCurve = 0.6; s.soft = 0.2; s.seed = rng.float();
  fx.emitAdd(s);
  s = resetSpawn();
  s.x = p.x + n.x * 0.012; s.y = p.y + n.y * 0.012; s.z = p.z + n.z * 0.012;
  s.tile = P.FLASH_CORE;
  s.size0 = 0.03 * e; s.size1 = 0.11 * e; s.sizeCurve = 0.4;
  s.life = 0.075; s.drag = 8;
  // 24, not 40: a ricochet is a spark burst, not a light bulb. Above ~30 the
  // bloom turns the whole hit into a white ball and the spark shower behind it
  // stops reading.
  s.r0 = 1; s.g0 = 0.97; s.b0 = 0.92; s.i0 = 24 * e;
  s.r1 = 1; s.g1 = 0.55; s.b1 = 0.2; s.i1 = 0;
  s.alphaCurve = 0.5; s.soft = 0.2; s.seed = rng.float();
  fx.emitAdd(s);

  // spark shower — velocity-aligned streaks, flickering, tight around the
  // reflected ray with a few long fliers
  const nSpark = Math.round(20 * q) + 6;
  for (let i = 0; i < nSpark; i++) {
    const flier = rng.float() < 0.22;
    cone(V2, rng, rx, ry, rz, grazing > 0.55 ? 0.5 : 0.9, flier ? 2.4 : 1.1);
    // Never back into the plate: a spark leaving steel travels away from it,
    // and never wider than +-55 deg off the normal.
    towardHemi(V2, n.x, n.y, n.z, 0.1);
    clampCone(V2, n.x, n.y, n.z, COS55);
    spark(
      fx,
      p.x + n.x * 0.012,
      p.y + n.y * 0.012,
      p.z + n.z * 0.012,
      V2.x, V2.y, V2.z,
      flier ? rng.range(11, 17) : rng.range(4.5, 11),
      {
        size: rng.range(0.008, 0.017),
        life: flier ? rng.range(0.4, 0.72) : rng.range(0.2, 0.5),
        intensity: 1.1,
        kelvin: 2500,
        // the long fliers are the ones you watch bounce
        bounces: flier ? 2 : i < 3 ? 1 : 0,
      }
    );
  }
  // a handful of round embers that survive longer and land
  const nEmber = Math.round(5 * q);
  for (let i = 0; i < nEmber; i++) {
    cone(V2, rng, rx, ry, rz, 1.0, 1);
    towardHemi(V2, n.x, n.y, n.z, 0.1);
    clampCone(V2, n.x, n.y, n.z, COS55);
    const sp = rng.range(2, 6);
    s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.SPARK;
    s.size0 = rng.range(0.008, 0.016); s.size1 = s.size0 * 0.6;
    s.life = rng.range(0.5, 1.0);
    // A real arc: these are the ones you watch fall and land.
    s.drag = 1.6; s.gravity = -13;
    blackbody(C, 2100);
    blackbody(C2, 1150);
    s.r0 = C.r; s.g0 = C.g; s.b0 = C.b; s.i0 = rng.range(5, 10);
    s.r1 = C2.r; s.g1 = C2.g; s.b1 = C2.b; s.i1 = 0.1;
    s.alphaCurve = 0.7; s.flags = 1; s.soft = 0.05; s.seed = rng.float();
    fx.emitAdd(s);
  }

  // hot metal vapour: thin, dark, short
  const nSm = Math.round(2 * q) + 1;
  for (let i = 0; i < nSm; i++) {
    cone(V2, rng, n.x, n.y, n.z, 1.1, 0.7);
    s = resetSpawn();
    s.x = p.x + n.x * 0.1; s.y = p.y + n.y * 0.1; s.z = p.z + n.z * 0.1;
    s.vx = V2.x * 0.7; s.vy = V2.y * 0.7 + 0.5; s.vz = V2.z * 0.7;
    s.tile = P.WISP;
    s.size0 = 0.05; s.size1 = rng.range(0.3, 0.5); s.sizeCurve = 0.6;
    s.life = rng.range(0.6, 1.1); s.drag = 2.4; s.gravity = 0.4;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 1.4;
    s.r0 = 0.2; s.g0 = 0.19; s.b0 = 0.18;
    s.r1 = 0.26; s.g1 = 0.25; s.b1 = 0.24;
    s.alpha = rng.range(0.3, 0.5); s.alphaCurve = 1.7;
    s.soft = 0.1; s.turb = 0.09; s.turbFreq = 1.8; s.seed = rng.float();
    fx.emitLit(s);
  }

  fx.haze(p.x + n.x * 0.06, p.y + n.y * 0.06, p.z + n.z * 0.06, 0.15, 2.6, 0.13, 0.45);

  if (grazing > 0.6) {
    fx.addDecal(p, n, {
      tile: D.SCRAPE,
      size: rng.range(0.16, 0.28),
      life: 70,
      roll: rng.float() * TWO_PI,
    });
  } else {
    bulletHole(fx, p, n, {
      tile: D.HOLE_METAL,
      min: 0.045,
      max: 0.07,
      e,
      soot: 0.85, // steel scorches; it does not powder
      haloScale: 0.8,
      haloLife: 55,
    });
  }
}
