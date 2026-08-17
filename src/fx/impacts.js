import { P, D } from './atlas.js';
import { resetSpawn } from './particles.js';
import { V, V2, reflect, cone, discOn } from './util.js';
import { TWO_PI, bulletHole } from './impacts-base.js';
import { concrete, metal, plaster } from './impacts-hard.js';

/**
 * Impact effects for the yielding surfaces, and the registry every surface is
 * dispatched through. Concrete, plaster and metal are in `impacts-hard.js`;
 * the shared spark and bullet hole in `impacts-base.js`.
 */

/** Wood: splinters and a brown, resinous puff. */
function wood(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  const rx = (V.x + n.x) * 0.5;
  const ry = (V.y + n.y) * 0.5;
  const rz = (V.z + n.z) * 0.5;
  let s;

  const nSpl = Math.round(11 * q) + 4;
  for (let i = 0; i < nSpl; i++) {
    cone(V2, rng, rx, ry, rz, 0.9, 1.3);
    const sp = rng.range(2.5, 7.5);
    s = resetSpawn();
    s.x = p.x + n.x * 0.01; s.y = p.y + n.y * 0.01; s.z = p.z + n.z * 0.01;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = i % 4 === 0 ? P.CHIP : P.SPLINTER;
    s.size0 = rng.range(0.014, 0.045);
    s.size1 = s.size0;
    s.life = rng.range(0.6, 1.2);
    s.drag = 0.8; s.gravity = -18;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 26;
    s.r0 = 0.44; s.g0 = 0.3; s.b0 = 0.16;
    s.r1 = 0.36; s.g1 = 0.24; s.b1 = 0.13;
    s.alphaCurve = 0.25; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
  }
  const nDust = Math.round(5 * q) + 2;
  for (let i = 0; i < nDust; i++) {
    cone(V2, rng, rx, ry, rz, 1.1, 0.7);
    const sp = rng.range(0.6, 2);
    s = resetSpawn();
    const off = rng.range(0.05, 0.12);
    s.x = p.x + n.x * off; s.y = p.y + n.y * off; s.z = p.z + n.z * off;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.35; s.vz = V2.z * sp;
    s.tile = P.DUST;
    s.size0 = rng.range(0.04, 0.09) * e;
    s.size1 = rng.range(0.24, 0.44) * e;
    s.sizeCurve = 0.45;
    s.life = rng.range(0.45, 0.9); s.drag = 3.4; s.gravity = -0.9;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 1.4;
    s.r0 = 0.46; s.g0 = 0.34; s.b0 = 0.2;
    s.r1 = 0.38; s.g1 = 0.28; s.b1 = 0.17;
    s.alpha = rng.range(0.5, 0.8); s.alphaCurve = 1.5;
    s.soft = 0.09; s.turb = 0.05; s.turbFreq = 2.2; s.seed = rng.float();
    fx.emitLit(s);
  }
  bulletHole(fx, p, n, { tile: D.HOLE_WOOD, min: 0.05, max: 0.075, e, soot: 0.5, haloScale: 0.85 });
}

/** Dirt / sand: a plume you can hide behind, plus heavy ejected clods. */
function ground(fx, p, n, inc, e, sand) {
  const rng = fx.rng;
  const q = fx.pScale;
  const cr = sand ? 0.66 : 0.3;
  const cg = sand ? 0.56 : 0.22;
  const cb = sand ? 0.4 : 0.15;
  let s;

  const nPlume = Math.round(8 * q) + 3;
  for (let i = 0; i < nPlume; i++) {
    cone(V2, rng, n.x, n.y, n.z, 0.75, 0.55);
    const sp = rng.range(1.6, 4.2) * e;
    s = resetSpawn();
    discOn(V, rng, n.x, n.y, n.z, 0.06);
    s.x = p.x + V.x; s.y = p.y + V.y + 0.01; s.z = p.z + V.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = i % 3 === 0 ? P.SMOKE_B : P.DUST;
    s.size0 = rng.range(0.06, 0.13) * e;
    s.size1 = rng.range(0.55, 1.0) * e;
    s.sizeCurve = 0.5;
    s.life = rng.range(0.8, 1.5);
    s.drag = rng.range(2.2, 3.2);
    s.gravity = -1.6;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 1.1;
    s.r0 = cr; s.g0 = cg; s.b0 = cb;
    s.r1 = cr * 0.85; s.g1 = cg * 0.85; s.b1 = cb * 0.85;
    s.alpha = rng.range(0.6, 0.95); s.alphaCurve = 1.4;
    s.soft = 0.14; s.turb = 0.08; s.turbFreq = 1.6; s.seed = rng.float();
    fx.emitLit(s);
  }
  const nClod = Math.round(13 * q) + 5;
  for (let i = 0; i < nClod; i++) {
    cone(V2, rng, n.x, n.y, n.z, 0.95, 1.1);
    const sp = rng.range(3, 9);
    s = resetSpawn();
    s.x = p.x; s.y = p.y + 0.01; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.CHIP;
    s.size0 = rng.range(0.008, sand ? 0.02 : 0.035);
    s.size1 = s.size0;
    s.life = rng.range(0.6, 1.2);
    s.drag = sand ? 1.4 : 0.5;
    s.gravity = -19;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 20;
    s.r0 = cr * 0.8; s.g0 = cg * 0.8; s.b0 = cb * 0.8;
    s.r1 = cr * 0.7; s.g1 = cg * 0.7; s.b1 = cb * 0.7;
    s.alphaCurve = 0.3; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
  }
  // The crater a rifle round digs in soil is 8-15 cm, not a third of a metre;
  // the third of a metre is the *dust* it kicks over the top of it.
  bulletHole(fx, p, n, {
    tile: sand ? D.IMPACT_SAND : D.IMPACT_DIRT,
    min: 0.085,
    max: 0.15,
    e,
    life: 60,
    maxAngle: 78,
    soot: 0,
    haloScale: sand ? 1.15 : 1.0,
    haloLife: 30,
  });
}

/** Glass: glinting shards, fine aerosol, a crack web that stays. */
function glass(fx, p, n, inc, _e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  // Glass throws forward, on the far side of the pane
  const fx0 = inc.x * 0.8 - n.x * 0.2;
  const fy0 = inc.y * 0.8 - n.y * 0.2;
  const fz0 = inc.z * 0.8 - n.z * 0.2;
  let s;

  const nShard = Math.round(14 * q) + 5;
  for (let i = 0; i < nShard; i++) {
    const back = rng.float() < 0.3;
    const ax = back ? -fx0 : fx0;
    const ay = back ? -fy0 : fy0;
    const az = back ? -fz0 : fz0;
    cone(V2, rng, ax, ay, az, 1.0, 1.2);
    const sp = rng.range(2.5, 8);
    s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = rng.float() < 0.4 ? P.SPLINTER : P.CHIP;
    s.size0 = rng.range(0.01, 0.038); s.size1 = s.size0;
    s.life = rng.range(0.7, 1.4);
    s.drag = 0.6; s.gravity = -19;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 30;
    s.r0 = 0.72; s.g0 = 0.8; s.b0 = 0.84;
    s.r1 = 0.6; s.g1 = 0.68; s.b1 = 0.72;
    s.alpha = 0.85; s.alphaCurve = 0.3; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
    // the glint that sells glass: a bright specular twinkle riding the shard
    if (rng.float() < 0.55) {
      s.tile = P.SPARK;
      s.size0 = rng.range(0.01, 0.02); s.size1 = s.size0;
      s.r0 = 0.85; s.g0 = 0.95; s.b0 = 1; s.i0 = rng.range(3, 8);
      s.r1 = 0.8; s.g1 = 0.9; s.b1 = 1; s.i1 = 0.2;
      s.alpha = 1; s.alphaCurve = 1; s.flags = 1;
      fx.emitAdd(s);
    }
  }
  const nMist = Math.round(4 * q) + 1;
  for (let i = 0; i < nMist; i++) {
    cone(V2, rng, fx0, fy0, fz0, 1.2, 0.7);
    s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * 1.6; s.vy = V2.y * 1.6; s.vz = V2.z * 1.6;
    s.tile = P.MIST;
    s.size0 = 0.05; s.size1 = rng.range(0.28, 0.45); s.sizeCurve = 0.45;
    s.life = rng.range(0.35, 0.7); s.drag = 4.2; s.gravity = -3;
    s.rot = rng.float() * TWO_PI;
    s.r0 = 0.8; s.g0 = 0.86; s.b0 = 0.9;
    s.r1 = 0.7; s.g1 = 0.76; s.b1 = 0.8;
    s.alpha = 0.5; s.alphaCurve = 1.6; s.soft = 0.1; s.seed = rng.float();
    fx.emitLit(s);
  }
  fx.addDecal(p, n, {
    tile: rng.float() < 0.5 ? D.GLASS_CRACK : D.HOLE_GLASS,
    size: rng.range(0.3, 0.55),
    life: 120,
    roll: rng.float() * TWO_PI,
    maxAngle: 40,
  });
}

/** Water: a column that rises and collapses, droplets, an expanding ripple. */
function water(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  let s;

  const nCol = Math.round(4 * q) + 2;
  for (let i = 0; i < nCol; i++) {
    s = resetSpawn();
    discOn(V, rng, n.x, n.y, n.z, 0.05);
    s.x = p.x + V.x; s.y = p.y + 0.02; s.z = p.z + V.z;
    s.vx = V.x * 2.5; s.vy = rng.range(2.4, 4.6) * e; s.vz = V.z * 2.5;
    s.tile = P.SPLASH;
    s.size0 = rng.range(0.07, 0.13) * e;
    s.size1 = rng.range(0.3, 0.55) * e;
    s.sizeCurve = 0.55;
    s.life = rng.range(0.4, 0.72);
    s.drag = 1.1; s.gravity = -13;
    s.rot = rng.signed() * 0.25; s.spin = rng.signed() * 0.6;
    s.r0 = 0.7; s.g0 = 0.76; s.b0 = 0.8;
    s.r1 = 0.6; s.g1 = 0.68; s.b1 = 0.72;
    s.alpha = rng.range(0.6, 0.9); s.alphaCurve = 1.5;
    s.soft = 0.1; s.seed = rng.float();
    fx.emitLit(s);
  }
  const nDrop = Math.round(18 * q) + 6;
  for (let i = 0; i < nDrop; i++) {
    cone(V2, rng, n.x, n.y, n.z, 0.85, 0.9);
    const sp = rng.range(2.5, 7.5);
    s = resetSpawn();
    s.x = p.x; s.y = p.y + 0.02; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.DROPLET;
    s.size0 = rng.range(0.008, 0.026); s.size1 = s.size0 * 0.9;
    s.stretch = 0.5;
    s.life = rng.range(0.4, 0.9);
    s.drag = 0.7; s.gravity = -19;
    s.r0 = 0.72; s.g0 = 0.78; s.b0 = 0.82;
    s.r1 = 0.66; s.g1 = 0.72; s.b1 = 0.76;
    s.alpha = 0.8; s.alphaCurve = 0.4; s.soft = 0.05; s.seed = rng.float();
    fx.emitLit(s);
  }
  // fine mist over the impact
  for (let i = 0; i < Math.round(3 * q) + 1; i++) {
    s = resetSpawn();
    s.x = p.x; s.y = p.y + 0.05; s.z = p.z;
    s.vy = 0.7;
    s.tile = P.MIST;
    s.size0 = 0.08; s.size1 = rng.range(0.35, 0.6); s.sizeCurve = 0.5;
    s.life = rng.range(0.5, 0.9); s.drag = 3.4; s.gravity = -1.4;
    s.rot = rng.float() * TWO_PI;
    s.r0 = 0.78; s.g0 = 0.83; s.b0 = 0.86;
    s.r1 = 0.7; s.g1 = 0.75; s.b1 = 0.78;
    s.alpha = 0.4; s.alphaCurve = 1.7; s.soft = 0.12; s.seed = rng.float();
    fx.emitLit(s);
  }
  fx.addDecal(p, n, {
    tile: D.RIPPLE,
    size: rng.range(0.45, 0.7),
    life: 2.6,
    fade: 0.15,
    opacity: 0.8,
    maxAngle: 80,
  });
}

/** Flesh: a dark aerosol cone, heavy droplets, and spatter on what is behind. */
function flesh(fx, p, n, inc, e) {
  const rng = fx.rng;
  const q = fx.pScale;
  // Blood sprays *with* the round, not against it
  const ax = inc.x * 0.75 - n.x * 0.25;
  const ay = inc.y * 0.75 - n.y * 0.25;
  const az = inc.z * 0.75 - n.z * 0.25;
  let s;

  const nMist = Math.round(9 * q) + 4;
  for (let i = 0; i < nMist; i++) {
    cone(V2, rng, ax, ay, az, 0.95, 0.8);
    const sp = rng.range(1.2, 4.5);
    s = resetSpawn();
    s.x = p.x - n.x * 0.02; s.y = p.y - n.y * 0.02; s.z = p.z - n.z * 0.02;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.3; s.vz = V2.z * sp;
    s.tile = i % 3 === 0 ? P.SMOKE_A : P.MIST;
    s.size0 = rng.range(0.035, 0.075) * e;
    s.size1 = rng.range(0.16, 0.34) * e;
    s.sizeCurve = 0.5;
    s.life = rng.range(0.3, 0.62);
    s.drag = rng.range(4.5, 6.5);
    s.gravity = -3.2;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 2;
    s.r0 = 0.34; s.g0 = 0.035; s.b0 = 0.03;
    s.r1 = 0.16; s.g1 = 0.016; s.b1 = 0.014;
    s.alpha = rng.range(0.6, 0.95); s.alphaCurve = 1.5;
    s.soft = 0.08; s.turb = 0.04; s.turbFreq = 3; s.seed = rng.float();
    fx.emitLit(s);
  }
  const nDrop = Math.round(14 * q) + 5;
  for (let i = 0; i < nDrop; i++) {
    cone(V2, rng, ax, ay, az, 1.1, 1.2);
    const sp = rng.range(2, 8);
    s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.DROPLET;
    s.size0 = rng.range(0.007, 0.022); s.size1 = s.size0;
    s.stretch = 0.6;
    s.life = rng.range(0.35, 0.8);
    s.drag = 0.9; s.gravity = -19;
    s.r0 = 0.3; s.g0 = 0.03; s.b0 = 0.025;
    s.r1 = 0.22; s.g1 = 0.022; s.b1 = 0.018;
    s.alpha = 0.95; s.alphaCurve = 0.35; s.soft = 0.05; s.seed = rng.float();
    fx.emitLit(s);
  }
  fx.bloodSpatterBehind(p, inc);
}

/** Foliage: shredded leaf matter, no hole. */
function foliage(fx, p, n, inc, _e) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  for (let i = 0; i < Math.round(10 * q) + 4; i++) {
    cone(V2, rng, V.x, V.y, V.z, 1.3, 1);
    const sp = rng.range(1.5, 5);
    const s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = rng.float() < 0.5 ? P.CHIP : P.SPLINTER;
    s.size0 = rng.range(0.012, 0.035); s.size1 = s.size0;
    s.life = rng.range(0.8, 1.6);
    s.drag = 2.2; s.gravity = -8;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 16;
    s.r0 = 0.14; s.g0 = 0.22; s.b0 = 0.08;
    s.r1 = 0.11; s.g1 = 0.17; s.b1 = 0.06;
    s.alphaCurve = 0.4; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
  }
}

/** Fabric / rubber: dust, fibres and a tear. */
function soft(fx, p, n, inc, e, rubber, onActor = false) {
  const rng = fx.rng;
  const q = fx.pScale;
  reflect(V, inc.x, inc.y, inc.z, n.x, n.y, n.z);
  const rx = (V.x + n.x) * 0.5;
  const ry = (V.y + n.y) * 0.5;
  const rz = (V.z + n.z) * 0.5;
  for (let i = 0; i < Math.round(6 * q) + 2; i++) {
    cone(V2, rng, rx, ry, rz, 1.1, 0.8);
    const sp = rng.range(0.8, 3);
    const s = resetSpawn();
    s.x = p.x + n.x * 0.02; s.y = p.y + n.y * 0.02; s.z = p.z + n.z * 0.02;
    s.vx = V2.x * sp; s.vy = V2.y * sp + 0.3; s.vz = V2.z * sp;
    s.tile = i % 2 ? P.DUST : P.MIST;
    s.size0 = rng.range(0.04, 0.08);
    s.size1 = rng.range(0.2, 0.36);
    s.sizeCurve = 0.45;
    s.life = rng.range(0.4, 0.8); s.drag = 3.8; s.gravity = -1.2;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 1.5;
    if (rubber) {
      s.r0 = 0.1; s.g0 = 0.095; s.b0 = 0.09;
      s.r1 = 0.08; s.g1 = 0.078; s.b1 = 0.075;
    } else {
      s.r0 = 0.5; s.g0 = 0.45; s.b0 = 0.38;
      s.r1 = 0.42; s.g1 = 0.38; s.b1 = 0.32;
    }
    s.alpha = rng.range(0.45, 0.7); s.alphaCurve = 1.5; s.soft = 0.09; s.seed = rng.float();
    fx.emitLit(s);
  }
  for (let i = 0; i < Math.round(5 * q) + 2; i++) {
    cone(V2, rng, rx, ry, rz, 1, 1.2);
    const sp = rng.range(1.5, 4.5);
    const s = resetSpawn();
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.vx = V2.x * sp; s.vy = V2.y * sp; s.vz = V2.z * sp;
    s.tile = P.SPLINTER;
    s.size0 = rng.range(0.01, 0.03); s.size1 = s.size0;
    s.life = rng.range(0.6, 1.2); s.drag = 2.4; s.gravity = -14;
    s.rot = rng.float() * TWO_PI; s.spin = rng.signed() * 18;
    if (rubber) {
      s.r0 = 0.09; s.g0 = 0.085; s.b0 = 0.08;
    } else {
      s.r0 = 0.46; s.g0 = 0.41; s.b0 = 0.34;
    }
    s.r1 = s.r0 * 0.9; s.g1 = s.g0 * 0.9; s.b1 = s.b0 * 0.9;
    s.alphaCurve = 0.35; s.soft = 0.06; s.seed = rng.float();
    fx.emitLit(s);
  }
  // Not on a fighter — see `spawnImpact`. The tear lasts 80 seconds and the
  // fighter does not stay 80 seconds.
  if (!onActor) {
    fx.addDecal(p, n, { tile: D.TEAR, size: rng.range(0.09, 0.15), life: 80, roll: rng.float() * TWO_PI });
  }
}

export const IMPACTS = {
  concrete,
  plaster,
  metal,
  wood,
  dirt: (fx, p, n, i, e) => ground(fx, p, n, i, e, false),
  sand: (fx, p, n, i, e) => ground(fx, p, n, i, e, true),
  glass,
  water,
  flesh,
  foliage,
  fabric: (fx, p, n, i, e, onActor) => soft(fx, p, n, i, e, false, onActor),
  rubber: (fx, p, n, i, e, onActor) => soft(fx, p, n, i, e, true, onActor),
};

/** Dispatch on surface name; unknown surfaces fall back to concrete. */
/**
 * `onActor` says the round hit something that can walk away.
 *
 * Only the recipes that stamp a decal AT THE IMPACT POINT need it, and today
 * that is `soft` (fabric, rubber). A decal lives 80 seconds in a world-space
 * atlas, so one written where a fighter was standing is a bullet hole left
 * hanging in the air after they move.
 *
 * `flesh` is deliberately unaffected: its decal comes from
 * `fx.bloodSpatterBehind`, which raycasts past the target and marks the wall
 * behind — a real surface that will still be there.
 */
export function spawnImpact(fx, point, normal, incident, surface, energy, onActor = false) {
  (IMPACTS[surface] ?? IMPACTS.concrete)(fx, point, normal, incident, energy, onActor);
}

