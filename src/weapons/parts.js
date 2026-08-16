import { box, latheZ, rodZ, dome, ring, screw, picatinny } from './geometry.js';

/**
 * Weapon parts — the shared hardware every other parts file bolts on with:
 * pins, screws, QD sockets, sling loops, rail sections, and a live round.
 *
 * The builders that use them moved out by assembly: `parts-barrel`,
 * `-receiver`, `-furniture`, `-magazine`, `-optics`. Measured, every
 * cross-file reference points HERE and none point sideways.
 */

/**
 * Reusable firearm components.
 *
 * Each function bolts a real mechanical assembly onto an `Assembly` at a given
 * offset. Everything is authored from published dimensions (an AR-15 upper
 * receiver really is 198 mm long with a 21.2 mm rail and a 66 mm optic height
 * over bore), because proportion is what the eye checks first — no amount of
 * texture detail rescues a receiver that is 30% too fat.
 *
 * Weapon-local space: +X right, +Y up, -Z toward the muzzle. The origin is the
 * shooting hand's anchor (the web of the thumb, top-rear of the pistol grip),
 * which is also what the viewmodel rig positions.
 */

export const TAU = Math.PI * 2;

/** Overall length of each muzzle device, so callers can lay out the barrel. */
export const MUZZLE_LEN = { brake: 0.062, a2: 0.0483, comp: 0.058, trilug: 0.042 };

/* -------------------------------------------------------------------------- */
/*  small hardware                                                            */
/* -------------------------------------------------------------------------- */

/** Cross pin with a domed head (takedown pins, trigger/hammer pins). */
export function addPin(asm, mat, x, y, z, r = 0.0022, len = 0.02) {
  asm.add(rodZ(r, r, len, 12, 0.0004), mat, { x, y, z, ry: Math.PI / 2 });
  asm.add(dome(r * 1.25, 10, 0.5), mat, { x: x + len / 2, y, z, ry: -Math.PI / 2 });
  asm.add(dome(r * 1.25, 10, 0.5), mat, { x: x - len / 2, y, z, ry: Math.PI / 2 });
}

/** Hex-socket screw, head facing +axis. */
export function addScrew(asm, mat, x, y, z, rHead = 0.0022, axis = 'y', len = 0.008) {
  const g = screw(rHead, rHead * 0.55, rHead * 0.5, len, 10);
  const rot = axis === 'y' ? { rx: Math.PI / 2 } : axis === 'x' ? { ry: -Math.PI / 2 } : {};
  asm.add(g, mat, { x, y, z, ...rot });
  g.dispose();
}

/** QD sling swivel socket: a countersunk cup with a steel insert. */
export function addQdSocket(asm, matBody, matSteel, x, y, z, axis = 'x', r = 0.0055) {
  const cup = latheZ(
    [
      [0, r * 0.55],
      [0, r * 1.5],
      [0.0012, r * 1.62],
      [0.006, r * 1.62],
      [0.006, r * 0.9],
    ],
    14
  );
  const inner = latheZ(
    [
      [0.004, 0],
      [0.004, r * 0.55],
      [0, r * 0.55],
    ],
    12
  );
  const rot = axis === 'x' ? { ry: Math.PI / 2 } : axis === 'y' ? { rx: -Math.PI / 2 } : {};
  asm.add(cup, matBody, { x, y, z, ...rot });
  asm.add(inner, matSteel, { x, y, z, ...rot });
  cup.dispose();
  inner.dispose();
}

/** Fixed sling loop — a flat steel eye. */
export function addSlingLoop(asm, mat, x, y, z, radius = 0.008, rot = {}) {
  const g = ring(radius, 0.0016, 14, 6);
  asm.add(g, mat, { x, y, z, ...rot });
  g.dispose();
}

/** A live cartridge: brass case, shoulder, neck, copper FMJ tip. */
export function cartridge(caseLen = 0.0446, rimR = 0.00495, bulletLen = 0.019) {
  const neckR = rimR * 0.72;
  const brass = latheZ(
    [
      [0, 0],
      [0, rimR],
      [0.0012, rimR * 0.97],
      [caseLen * 0.62, rimR * 0.965],
      [caseLen * 0.78, neckR],
      [caseLen, neckR],
    ],
    16
  );
  const bullet = latheZ(
    [
      [caseLen - 0.004, neckR * 0.98],
      [caseLen + bulletLen * 0.45, neckR * 0.98],
      [caseLen + bulletLen * 0.8, neckR * 0.62],
      [caseLen + bulletLen, neckR * 0.16],
      [caseLen + bulletLen + 0.0004, 0],
    ],
    16
  );
  return { brass, bullet, length: caseLen + bulletLen };
}

/** Fired case — same brass, no bullet, slightly belled mouth. */
export function emptyCase(caseLen = 0.0446, rimR = 0.00495) {
  const neckR = rimR * 0.72;
  return latheZ(
    [
      [0, 0],
      [0, rimR],
      [0.0012, rimR * 0.97],
      [caseLen * 0.62, rimR * 0.965],
      [caseLen * 0.78, neckR],
      [caseLen, neckR * 1.02],
      [caseLen, neckR * 0.86],
      [caseLen * 0.8, neckR * 0.86],
    ],
    16
  );
}

/* -------------------------------------------------------------------------- */
/*  rails                                                                     */
/* -------------------------------------------------------------------------- */

/** Picatinny run along Z, top face at `y`. */
export function addRail(asm, mat, z0, z1, y, x = 0, opts = {}) {
  const len = Math.abs(z1 - z0);
  const baseH = opts.baseH ?? 0.0042;
  const topH = opts.topH ?? 0.0032;
  const waist = opts.waist ?? 0.0157;
  const cz = (z0 + z1) / 2;
  const yb = y - baseH - topH;
  const g = picatinny(len, opts);
  asm.add(g, mat, { x, y: yb, z: cz });
  g.dispose();
  /**
   * SLOT FLOORS.
   *
   * A recoil slot is a 5.35 mm gap with a 3.2 mm deep floor that in real light is
   * always in shadow. Left in the rail's own aluminium the floor caught the sky
   * at exactly the same rate as the tooth tops, so a rail read as a ladder of
   * flat near-white bars instead of a row of cavities — the single loudest
   * artefact on the whole weapon.
   *
   * The strip is exactly the width of a tooth's foot, so it is occluded by the
   * teeth everywhere except inside the slots, where it becomes the floor.
   */
  if (opts.slotFloor !== false) {
    const floor = box(waist * 0.99, 0.0014, len - 0.0004, 0.0002, 1);
    asm.add(floor, 'cavity', { x, y: yb + baseH - 0.0003, z: cz });
    floor.dispose();
  }
}

