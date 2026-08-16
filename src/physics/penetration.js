/**
 * Terminal ballistics — material-thickness bullet penetration.
 *
 * A round carries a *penetration budget* expressed in metres of a reference
 * material. Every surface has a `penDepth`: the thickness of that material the
 * reference round defeats. Passing through consumes budget proportional to
 * thickness/penDepth, bleeds damage, and yaws the round slightly (deflection is
 * drawn from ctx.rng so captures reproduce exactly).
 *
 * Thickness is measured by shooting a second ray from just past the entry point
 * and looking for the *backface* of the same object. Level geometry that is
 * modelled as a single-sided plane (very common for drywall and fences) has no
 * backface, so we fall back to a nominal sheet thickness.
 *
 * `bullet:impact` is emitted on entry AND on exit, with `exit: true` on the
 * latter so fx can pick a spall/dust variant instead of a crater.
 */

import { SURFACE_PROPS, surfaceName, MASK } from './surfaces.js';
import { hypot3 } from '../core/dmath.js';

const MAX_LAYERS = 6;
/** How far past an entry point we look for the exit face. */
const EXIT_PROBE = 1.6;
/** Assumed thickness of single-sided geometry, metres. */
const SHEET_THICKNESS = 0.018;

export class Ballistics {
  constructor(phys) {
    this.phys = phys;
    this.rng = null;
    /** Reusable result list; contents are valid until the next fire(). */
    this.impacts = [];
    for (let i = 0; i < MAX_LAYERS * 2 + 2; i++) {
      this.impacts.push({
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        surface: 'concrete',
        exit: false,
        damage: 0,
        distance: 0,
        object: null,
      });
    }
    this.impactCount = 0;
  }

  /**
   * @param {object} o
   *   origin      {x,y,z}
   *   dir         {x,y,z} unit
   *   maxDist     how far the round TRAVELS, metres (default 400)
   *   damage      base damage at the muzzle
   *   penetration budget, 1.0 = 7.62 rifle, 0.35 = pistol, 2.2 = .50 / AP
   *   mask        collision mask (default MASK.BULLET)
   *   dropoff     damage retained at `falloffRange`, 0..1
   *   falloffRange the distance over which damage decays to `dropoff`.
   *               Defaults to `maxDist`.
   *
   * TRAVEL AND FALLOFF ARE SEPARATE, and conflating them cost a real bug.
   * They used to be one number, so tuning the SMG's damage curve down to a 30 m
   * effective range also truncated its TRACE at 30 m: on a 36 m map its rounds
   * stopped existing partway down the hall — no impact, no decal, no hit, and
   * nothing on screen to tell you why. A weapon should get weak at distance,
   * not stop firing.
   *
   * `maxDist` is a performance bound on the raycast. `falloffRange` is a
   * balance number. Nothing good comes of making one of them do both jobs.
   *
   * @returns {number} number of impacts written into `this.impacts`
   */
  fire(o) {
    const phys = this.phys;
    const rng = o.rng ?? this.rng;
    let ox = o.origin.x, oy = o.origin.y, oz = o.origin.z;
    let dx = o.dir.x, dy = o.dir.y, dz = o.dir.z;
    const dl = hypot3(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    let remaining = o.maxDist ?? 400;
    let damage = o.damage ?? 34;
    let power = o.penetration ?? 1.0;
    const mask = o.mask ?? MASK.BULLET;
    const dropoff = o.dropoff ?? 0.55;
    const falloffRange = o.falloffRange ?? o.maxDist ?? 400;
    const startX = ox, startY = oy, startZ = oz;
    const emit = o.emit !== false;

    this.impactCount = 0;

    for (let layer = 0; layer < MAX_LAYERS && remaining > 0.01; layer++) {
      const hit = phys.raycast(ox, oy, oz, dx, dy, dz, remaining, mask);
      if (!hit.hit) break;

      const travelled = hypot3(hit.point.x - startX, hit.point.y - startY, hit.point.z - startZ);
      // Muzzle-to-target energy loss.
      const range01 = Math.min(1, travelled / falloffRange);
      const rangeMul = 1 - (1 - dropoff) * range01 * range01;

      const si = hit.surfaceIndex;
      const props = SURFACE_PROPS[si] ?? SURFACE_PROPS[0];

      this._push(hit.point, hit.normal, si, false, damage * rangeMul, travelled, hit.object);
      if (emit) {
        phys.emitImpact(
          hit.point.x, hit.point.y, hit.point.z,
          hit.normal.x, hit.normal.y, hit.normal.z,
          dx, dy, dz,
          si, damage * rangeMul, false, hit
        );
      }

      // Actors and dynamic bodies take the hit and the round keeps going only
      // if it has plenty of budget left (flesh is soft but a torso is thick).
      if (hit.collider && hit.collider.onHit) {
        hit.collider.onHit(hit, damage * rangeMul, dx, dy, dz);
      }
      if (hit.body) {
        const j = (o.impulse ?? 6) * damage * 0.02;
        hit.body.applyImpulse(dx * j, dy * j, dz * j, hit.point.x, hit.point.y, hit.point.z);
      }
      if (hit.ragdoll) {
        hit.ragdoll.applyImpulse(
          hit.point.x, hit.point.y, hit.point.z,
          dx * damage * 0.9, dy * damage * 0.9, dz * damage * 0.9,
          0.35
        );
      }

      // ---- can we get through? ----
      const budget = props.penDepth * power;
      if (budget <= 1e-4) break;

      const thick = this._measureThickness(hit, dx, dy, dz, mask, Math.min(EXIT_PROBE, remaining));
      if (thick.distance > budget) break; // round stops in the material

      const frac = thick.distance / budget;
      // Exit impact — normal points out of the far face.
      const exDamage = damage * rangeMul * Math.max(0.05, 1 - props.energyLoss * frac);
      this._push(thick.point, thick.normal, si, true, exDamage, travelled + thick.distance, hit.object);
      if (emit) {
        phys.emitImpact(
          thick.point.x, thick.point.y, thick.point.z,
          thick.normal.x, thick.normal.y, thick.normal.z,
          dx, dy, dz,
          si, exDamage, true, hit
        );
      }

      // ---- degrade and continue ----
      damage *= Math.max(0.05, 1 - props.energyLoss * frac);
      power *= Math.max(0, 1 - frac);
      if (power < 0.02 || damage < 1) break;

      if (rng && props.deflect > 0) {
        const spread = props.deflect * frac;
        // Build an orthonormal frame around the current direction and yaw/pitch.
        let ux = 0, uy = 1, uz = 0;
        if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
        let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
        const rl = hypot3(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        const sx = dy * rz - dz * ry, sy = dz * rx - dx * rz, sz = dx * ry - dy * rx;
        const a = rng.gauss() * spread;
        const b = rng.gauss() * spread;
        dx += rx * a + sx * b;
        dy += ry * a + sy * b;
        dz += rz * a + sz * b;
        const nl = hypot3(dx, dy, dz) || 1;
        dx /= nl; dy /= nl; dz /= nl;
      }

      // Step past the exit face and keep flying.
      const eps = 0.004;
      ox = thick.point.x + dx * eps;
      oy = thick.point.y + dy * eps;
      oz = thick.point.z + dz * eps;
      // Decrement by *this segment's* travel, not the total from the muzzle —
      // `travelled` is cumulative and would be double-counted on layer 2+.
      remaining -= hit.distance + thick.distance + eps;
    }

    return this.impactCount;
  }

  /**
   * Distance from an entry hit to where the round leaves the material, plus the
   * exit point and its outward normal.
   */
  _measureThickness(entry, dx, dy, dz, mask, probe) {
    const phys = this.phys;
    const eps = 0.0015;
    const ox = entry.point.x + dx * eps;
    const oy = entry.point.y + dy * eps;
    const oz = entry.point.z + dz * eps;
    const out = this._thick ?? (this._thick = {
      distance: 0,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 0 },
      backface: false,
    });

    const h = phys.raycast(ox, oy, oz, dx, dy, dz, probe, mask);
    const sameSolid =
      h.hit && !h.frontFace &&
      (h.object === entry.object || h.collider === entry.collider);

    if (sameSolid) {
      out.distance = h.distance + eps;
      out.point.x = h.point.x; out.point.y = h.point.y; out.point.z = h.point.z;
      // raycast() reports normals facing the shooter; the exit face's outward
      // normal is the opposite.
      out.normal.x = -h.normal.x; out.normal.y = -h.normal.y; out.normal.z = -h.normal.z;
      out.backface = true;
    } else {
      // Single-sided sheet: nominal thickness along the incidence angle.
      const cos = Math.abs(
        entry.normal.x * dx + entry.normal.y * dy + entry.normal.z * dz
      );
      const t = SHEET_THICKNESS / Math.max(0.2, cos);
      out.distance = t;
      out.point.x = entry.point.x + dx * t;
      out.point.y = entry.point.y + dy * t;
      out.point.z = entry.point.z + dz * t;
      out.normal.x = -entry.normal.x;
      out.normal.y = -entry.normal.y;
      out.normal.z = -entry.normal.z;
      out.backface = false;
    }
    return out;
  }

  _push(point, normal, si, exit, damage, distance, object) {
    if (this.impactCount >= this.impacts.length) return;
    const r = this.impacts[this.impactCount++];
    r.point.x = point.x; r.point.y = point.y; r.point.z = point.z;
    r.normal.x = normal.x; r.normal.y = normal.y; r.normal.z = normal.z;
    r.surface = surfaceName(si);
    r.exit = exit;
    r.damage = damage;
    r.distance = distance;
    r.object = object;
  }
}
