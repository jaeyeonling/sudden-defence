import { P, D } from './atlas.js';
import { resetSpawn } from './particles.js';
import { V2, C, C2, reflect, blackbody } from './util.js';

/** Shared impact vocabulary: the spark burst and the bullet hole every surface starts from. */

/**
 * Per-surface impact recipes.
 *
 * Each one is built from the same vocabulary — a sub-frame flash, ejecta on the
 * reflected cone, a dust/aerosol puff that expands and slows, something that
 * lingers, and a decal — but the timings, colours, masses and drag are picked
 * per material so the frames read differently: sparks skitter off steel,
 * concrete coughs pale dust and spall, wet dirt throws heavy clods that arc,
 * glass sprays glinting shards, flesh atomises.
 *
 * Numbers are metres / seconds / radians. Velocities are what a rifle round
 * actually throws: chips at 4-10 m/s, sparks at 6-16 m/s, aerosols under 3 m/s.
 */

export const TWO_PI = Math.PI * 2;

/** Scratch for the bounce raycast; never allocated per spark. */
const RAY_O = { x: 0, y: 0, z: 0 };
const RAY_D = { x: 0, y: 0, z: 0 };

/**
 * One incandescent spark, authored the way a real one behaves.
 *
 *   - COLOUR is a blackbody ramp, 2500 K at birth down to 1200 K at death, so it
 *     goes orange-white -> deep red instead of staying a white capsule.
 *   - DIRECTION is forced into the impact-normal hemisphere: ejecta that travels
 *     back into the wall (or back toward the shooter) is the single loudest tell
 *     that a spark system is a random-direction emitter.
 *   - LENGTH comes out of the velocity (the shader multiplies `stretch` by the
 *     screen-space speed), so a fast flier is a streak and a tumbling ember is a
 *     speck — they are no longer identical capsules.
 *   - GRAVITY + DRAG give it an arc, and up to two BOUNCES are spawned as
 *     follow-up particles at the surface the first leg actually hits, delayed by
 *     the flight time. That is what makes sparks skitter along a floor instead
 *     of vanishing mid-air.
 *
 * @param {number} bounces how many follow-up legs to spawn (0-2)
 */
export function spark(fx, x, y, z, dx, dy, dz, speed, o) {
  const rng = fx.rng;
  const s = resetSpawn();
  const kelvinHot = o.kelvin ?? 2600;
  blackbody(C, kelvinHot * rng.range(0.92, 1.08));
  blackbody(C2, 1200);
  s.x = x; s.y = y; s.z = z;
  s.vx = dx * speed; s.vy = dy * speed; s.vz = dz * speed;
  s.tile = P.STREAK;
  s.size0 = o.size ?? rng.range(0.007, 0.016);
  s.size1 = s.size0 * 0.4;
  // Length comes out of the INSTANTANEOUS velocity (the shader multiplies this
  // by |view velocity| every frame), so a spark shortens as drag and gravity
  // bleed it off: fast fliers are streaks, tumbling embers are dots, and the
  // same particle is both over its life.
  s.stretch = 0.4;
  s.life = o.life ?? rng.range(0.22, 0.55);
  s.delay = o.delay ?? 0;
  s.drag = o.drag ?? rng.range(1.4, 2.6);
  s.gravity = o.gravity ?? -14;
  s.r0 = C.r; s.g0 = C.g; s.b0 = C.b; s.i0 = (o.intensity ?? 1) * rng.range(6, 13);
  s.r1 = C2.r; s.g1 = C2.g; s.b1 = C2.b; s.i1 = 0.2;
  s.flags = 1;
  s.alphaCurve = 0.45;
  s.soft = 0.05;
  s.seed = rng.float();
  fx.emitAdd(s);

  const bounces = o.bounces ?? 0;
  if (bounces <= 0) return;
  // Where does this leg land? One raycast along the launch direction is a good
  // enough predictor for a 0.2 s ballistic hop, and it costs one BVH walk.
  const ph = fx.physics;
  if (!ph?.raycast) return;
  RAY_O.x = x; RAY_O.y = y; RAY_O.z = z;
  RAY_D.x = dx; RAY_D.y = dy - 0.35; RAY_D.z = dz;
  const l = Math.hypot(RAY_D.x, RAY_D.y, RAY_D.z) || 1;
  RAY_D.x /= l; RAY_D.y /= l; RAY_D.z /= l;
  const reach = Math.min(3.2, speed * 0.22);
  const hit = ph.raycast(RAY_O, RAY_D, reach, ph.MASK?.WORLD ?? 0xffff);
  if (!hit?.hit) return;
  const t = Math.max(0.02, hit.distance / Math.max(1, speed));
  // reflect, lose most of the energy, and keep going with what is left
  reflect(V2, RAY_D.x, RAY_D.y, RAY_D.z, hit.normal.x, hit.normal.y, hit.normal.z);
  V2.x += rng.signed() * 0.25;
  V2.y = Math.abs(V2.y) * 0.8 + 0.25;
  V2.z += rng.signed() * 0.25;
  const bl = Math.hypot(V2.x, V2.y, V2.z) || 1;
  spark(
    fx,
    hit.point.x + hit.normal.x * 0.01,
    hit.point.y + hit.normal.y * 0.01,
    hit.point.z + hit.normal.z * 0.01,
    V2.x / bl,
    V2.y / bl,
    V2.z / bl,
    speed * rng.range(0.22, 0.42),
    {
      delay: (o.delay ?? 0) + t,
      life: rng.range(0.18, 0.4),
      kelvin: 1700,
      intensity: (o.intensity ?? 1) * 0.55,
      size: (o.size ?? 0.01) * 0.8,
      bounces: bounces - 1,
      drag: 2.4,
    }
  );
}

/**
 * A bullet hole is TWO decals, never one.
 *
 * A 5.56 mm round makes a 6-12 mm bore with a crater a couple of centimetres
 * across. The hole tile therefore gets 4.5-7.5 cm of decal — one round of this
 * project shipped it at 16-24 cm, which is why the holes read as wads of chewing
 * gum stuck to the wall rather than as perforations.
 *
 * What actually reads at three metres is not the bore, it is the dust and scorch
 * *around* it, and that is a completely different footprint: 18-30 cm, 8-15 %
 * opacity, no rim structure whatsoever. Painting the two into one tile is what
 * forces the compromise that ruins both.
 */
export function bulletHole(fx, p, n, o) {
  const rng = fx.rng;
  const size = rng.range(o.min, o.max) * (0.9 + (o.e ?? 1) * 0.1);
  fx.addDecal(p, n, {
    tile: o.tile,
    size,
    life: o.life ?? 90,
    // Per-instance roll and mirror: the tile has asymmetric spall cracks, so
    // this is what stops a walked burst from being N copies of one sprite.
    roll: rng.float() * TWO_PI,
    flip: rng.float() < 0.5,
    depth: Math.max(0.03, size * 0.85),
    maxAngle: o.maxAngle ?? 62,
  });
  if (o.halo === false) return;
  // Separate, much larger, structureless dust/scorch wash. Soot on the harder
  // surfaces, pale drift on the powdery ones.
  const sooty = rng.float() < (o.soot ?? 0.35);
  fx.addDecal(p, n, {
    tile: sooty ? D.SCORCH : D.SMUDGE,
    size: rng.range(0.18, 0.30) * (o.haloScale ?? 1),
    life: o.haloLife ?? 40,
    opacity: rng.range(0.08, 0.15) * (sooty ? 0.8 : 1),
    fade: 0.4,
    roll: rng.float() * TWO_PI,
    maxAngle: 74,
  });
}

