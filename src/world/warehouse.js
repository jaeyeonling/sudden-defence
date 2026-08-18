/**
 * WAREHOUSE — the map.
 *
 * A 48 x 36 m supply depot, mirrored about Z so neither team gets a better
 * angle. Alpha holds -Z, bravo holds +Z, and everything between them is built
 * from the same half-spec applied twice.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LAYOUT (top-down, +Z up)
 *
 *        ┌──────────────────────────────────┐
 *        │  ▓▓        BRAVO SPAWN       ▓▓  │
 *        │      ┌────────────────┐          │   long wall bays give the
 *   west │  ═══ │                │ ═══      │ east   flanks their own
 *   lane │      │   CENTRE HALL  │          │ lane   sightlines
 *        │  ═══ │   (open, lit)  │ ═══      │
 *        │      └────────────────┘          │
 *        │  ▓▓        ALPHA SPAWN       ▓▓  │
 *        └──────────────────────────────────┘
 *
 *   ▓▓  spawn cover (container pair)
 *   ═══ shelving runs — waist-high, shootable over, walkable between
 *   the partition walls carry two door openings per side
 *
 * Three routes from each spawn: west lane, centre hall, east lane. The lanes
 * are joined to the hall by gaps in the partition walls, so no route is a
 * corridor you cannot leave — a player pushed in a lane can always cut inward.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS LIT THE WAY IT IS
 *
 * A sealed box has no light in it. The roof carries a run of skylights down the
 * centreline, which does three jobs at once: it lights the hall brightest (so
 * the contested ground is the readable ground), it leaves the lanes darker and
 * therefore worth using, and it gives the sun a path in so the CSM cascades and
 * the volumetrics have something to do.
 *
 * The interior volume is published to `render` so the indirect gate knows this
 * is inside — see world/index.js.
 */

import { Rng } from '../core/rng.js';
import { BOX, BOX_FINE } from './kit-base.js';
import { dcos, dsin } from '../core/dmath.js';

/** Interior extents. Walls sit outside these, so this is standable floor. */
// 6 m, not 8. A depot ceiling you can read the underside of makes the space feel
// enclosed; at 8 m the roof left frame and the hall read as an outdoor plaza.
export const HALL = { w: 48, d: 36, h: 6 };
const WALL_T = 0.5;
/** Centre hall footprint — the partition walls run down x = +-CENTRE.hw. */
const CENTRE = { hw: 9.5, hd: 11 };

/**
 * Build the level into `A` (an Assembler). Returns the interior volumes for
 * the indirect gate and the spawn table.
 *
 * Everything authored here is mirrored: `half()` is called with s = -1 and
 * s = +1, and every z is multiplied by s. Authoring the mirror rather than
 * transforming it keeps every vertex in true world space, which is what the
 * collision proxies, the instanced props and the triplanar materials all
 * assume.
 */
export function buildWarehouse(A, rng) {
  const hw = HALL.w * 0.5;
  const hd = HALL.d * 0.5;

  shell(A, rng, hw, hd);
  floorMarkings(A, hw, hd);
  // ONE stream, replayed — not one stream shared.
  //
  // `half()` draws for crate jitter, crate yaw, container colour and pallet
  // loading, so handing both calls the same live `rng` gives the two halves the
  // same LAYOUT and different DETAIL: a crate rotated 0.2 rad at this end and
  // -0.1 rad at that one, one pallet on a rack here and two there. Authored as a
  // mirror, built as two similar rooms.
  //
  // It is not cosmetic. `tools/symmetry.mjs` measures openness — how far you can
  // see from where you stand, which is what decides a firefight — over a lattice
  // covering the whole floor, and compares every point against its partner
  // across the mirror plane. Sharing the stream left 30 of 763 pairs more than
  // 1.5 m apart, one of them 5.7 m: a spot that sees down a lane at one end of
  // the map and sees a crate at the other.
  //
  // Forking the same seed twice replays an identical stream into each half, so
  // the detail mirrors along with the layout. The parent is advanced exactly
  // once, so nothing built after this sees a different sequence.
  const halfSeed = rng.u32();
  for (const s of [-1, 1]) half(A, new Rng(halfSeed), s, hw, hd);
  centreClutter(A, rng);

  return {
    roomVolumes: [{ x: 0, z: 0, w: HALL.w, d: HALL.d, y0: -0.8, y1: HALL.h - 0.08 }],
  };
}

/* ========================================================================== */
/* shell: floor, roof, outer walls, skylights                                 */
/* ========================================================================== */

function shell(A, rng, hw, hd) {
  // ---- floor ----
  A.addBox('floor_concrete', BOX(A), 0, -WALL_T * 0.5, 0, 0, HALL.w, WALL_T, HALL.d);
  A.box('concrete', 0, -WALL_T * 0.5, 0, HALL.w, WALL_T, HALL.d);

  // ---- roof, split either side of the skylight run ----
  // The skylight strip is 5 m wide down the centreline; the roof is two slabs
  // rather than one with a hole, because a merged slab with a hole would need a
  // hole-cut extrusion and this reads identically for a third of the triangles.
  const SKY_HW = 2.5;
  const roofZ = HALL.d;
  const roofW = hw - SKY_HW;
  for (const sx of [-1, 1]) {
    const cx = sx * (SKY_HW + roofW * 0.5);
    A.addBox('roof_screed', BOX(A), cx, HALL.h + WALL_T * 0.5, 0, 0, roofW, WALL_T, roofZ);
    A.box('concrete', cx, HALL.h + WALL_T * 0.5, 0, roofW, WALL_T, roofZ);
  }
  // Glazing over the gap. Collision is a full slab: you cannot shoot the sky
  // out, and a round that hits the roof should stop whether or not it found
  // glass.
  A.addBox('window_glass', BOX_FINE(A), 0, HALL.h + 0.06, 0, 0, SKY_HW * 2, 0.06, roofZ * 0.92);
  A.box('glass', 0, HALL.h + 0.06, 0, SKY_HW * 2, 0.12, roofZ);

  // Roof trusses across the skylight — they cast the bar shadows that make the
  // hall floor read as "under glass" rather than "under nothing".
  for (let i = -5; i <= 5; i++) {
    const z = i * 3.1;
    A.addBox('steel', BOX_FINE(A), 0, HALL.h - 0.2, z, 0, SKY_HW * 2 + 0.6, 0.16, 0.14);
  }

  // ---- outer walls ----
  // Long walls (east/west) carry high windows: light in, no sightline out.
  for (const sx of [-1, 1]) {
    const x = sx * (hw + WALL_T * 0.5);
    A.addBox('plaster_sand', BOX(A), x, HALL.h * 0.5, 0, 0, WALL_T, HALL.h, HALL.d);
    A.box('concrete', x, HALL.h * 0.5, 0, WALL_T, HALL.h, HALL.d);
    for (let i = -3; i <= 3; i++) {
      A.addBox('window_glass', BOX_FINE(A), x - sx * WALL_T * 0.4, 4.5, i * 4.4, 0, 0.08, 1.4, 2.6);
    }
  }
  // End walls (the two spawns) are solid — a spawn you can be shot into from
  // outside is not a spawn.
  for (const sz of [-1, 1]) {
    const z = sz * (hd + WALL_T * 0.5);
    A.addBox('plaster_sand', BOX(A), 0, HALL.h * 0.5, z, 0, HALL.w, HALL.h, WALL_T);
    A.box('concrete', 0, HALL.h * 0.5, z, HALL.w, HALL.h, WALL_T);
  }
}

/* ========================================================================== */
/* floor markings                                                             */
/* ========================================================================== */

/**
 * Painted floor. Purely visual — 1 cm proud of the slab, no collision.
 *
 * Three jobs, and only the first is decoration:
 *
 *   1. Colour. Before this the depot was concrete floor, concrete walls,
 *      concrete partitions and grey steel; every shot came back as one material
 *      lit three ways.
 *   2. Orientation. The map is mirrored about Z, so the two halves are
 *      geometrically identical and a player who turns around twice has no way
 *      to tell which end is theirs. The spawn bays are painted per team, and
 *      that is the only asymmetry in the level.
 *   3. Reading the routes. The walkway lines run the lanes and the hall
 *      perimeter is banded, so the three routes are legible from the floor
 *      rather than only from the walls.
 */
function floorMarkings(A, _hw, _hd) {
  const Y = 0.01;
  const T = 0.02;

  /** Painted walkway edge lines down both lanes. */
  const LANE_X = 19.0;
  for (const sx of [-1, 1]) {
    for (const off of [-0.3, 0.3]) {
      A.addBox('paint_yellow', BOX_FINE(A),
        sx * LANE_X + off, Y, 0, 0, 0.11, T, HALL.d - 1.6);
    }
  }

  /** Hall perimeter: a band on the floor where the centre opens up. */
  const px = CENTRE.hw - 0.45;
  const pz = 13.0;
  for (const sx of [-1, 1]) {
    A.addBox('paint_yellow', BOX_FINE(A), sx * px, Y, 0, 0, 0.13, T, pz * 2);
  }
  for (const sz of [-1, 1]) {
    A.addBox('paint_yellow', BOX_FINE(A), 0, Y, sz * pz, 0, px * 2, T, 0.13);
  }

  /**
   * Spawn bays. A solid painted rectangle at each end plus a hazard-striped
   * threshold, so leaving your own spawn is a visible event.
   */
  const bays = [
    { z: -1, key: 'paint_alpha' },
    { z: 1, key: 'paint_bravo' },
  ];
  for (const bay of bays) {
    const s = bay.z;
    A.addBox(bay.key, BOX(A), 0, Y, s * 16.4, 0, HALL.w - 1.2, T, 3.0);
    // Threshold hatching: short bars across the bay mouth.
    for (let i = -11; i <= 11; i++) {
      A.addBox('paint_yellow', BOX_FINE(A), i * 2.0, Y + 0.002, s * 14.6, 0, 1.0, T, 0.16);
    }
  }
}

/* ========================================================================== */
/* one half of the map, mirrored by `s`                                       */
/* ========================================================================== */

function half(A, rng, s, _hw, _hd) {
  // ---- partition walls that carve out the centre hall ----
  //
  // A CONTINUOUS wall with two door openings, not a row of stubs. The first
  // version left the segments floating with gaps at both ends and the result
  // read as a colonnade — you could see through everywhere, so the lanes were
  // not lanes and the hall was not a room. A real wall with real doors is what
  // makes "which way did they go" a question worth asking.
  //
  // Each opening gets a lintel above it so the wall reads as one surface with
  // holes in it rather than as separate pieces that happen to line up.
  const DOOR_W = 3.2;
  const DOOR_H = 2.7;
  const doorZ = [s * 4.2, s * 9.6];
  const zEnd = s * 13.0;
  for (const sx of [-1, 1]) {
    const x = sx * CENTRE.hw;
    // Wall runs from the hall mouth (z = s*1.2) out to zEnd, minus the doors.
    const edges = [s * 1.2];
    for (const dz of doorZ) {
      edges.push(dz - s * DOOR_W * 0.5, dz + s * DOOR_W * 0.5);
    }
    edges.push(zEnd);
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i];
      const b = edges[i + 1];
      const len = Math.abs(b - a);
      if (len < 0.05) continue;
      const cz = (a + b) * 0.5;
      A.addBox('plaster_cream', BOX(A), x, HALL.h * 0.5, cz, 0, 0.4, HALL.h, len);
      A.box('concrete', x, HALL.h * 0.5, cz, 0.4, HALL.h, len);
    }
    // Lintels over the openings.
    for (const dz of doorZ) {
      const lh = HALL.h - DOOR_H;
      A.addBox('plaster_cream', BOX(A), x, DOOR_H + lh * 0.5, dz, 0, 0.4, lh, DOOR_W);
      A.box('concrete', x, DOOR_H + lh * 0.5, dz, 0.4, lh, DOOR_W);
      // Steel door frame, so the opening is legible from across the hall.
      for (const k of [-1, 1]) {
        A.addBox('steel', BOX_FINE(A), x, DOOR_H * 0.5, dz + k * DOOR_W * 0.5, 0, 0.46, DOOR_H, 0.12);
      }
      A.addBox('steel', BOX_FINE(A), x, DOOR_H, dz, 0, 0.46, 0.12, DOOR_W);
    }
  }

  // ---- spawn cover: a pair of containers between the spawns and the hall ----
  //
  // These sit in the GAPS between spawn points, never in front of one. The
  // first version put them at x = +-8.5, which is exactly where two of the three
  // spawns stand — the player's opening step was into 2.6 m of steel and the
  // walk test measured 0.3 m of travel. Cover you cannot walk out from behind
  // is a wall.
  //
  // Placed here they block the centre-hall sightline into the spawn court while
  // leaving three clear exits: x ~ 0 between them, and the two lanes outboard.
  // `-s` on the yaw, not a bare constant. A mirror about Z maps a yaw to its
  // negative, so a piece placed at +13.8 with the same yaw as its partner at
  // -13.8 is a piece rotated the wrong way — 0.06 rad on a 6.1 m container is
  // 37 cm of edge, on the exact line the spawn court is covered from.
  for (const sx of [-1, 1]) {
    container(A, rng, sx * 7.0, s * 13.8, -s * sx * 0.06);
  }

  // ---- lane shelving: waist-high, shootable over from a crouch ----
  for (const sx of [-1, 1]) {
    const x = sx * 14.5;
    for (let i = 0; i < 2; i++) {
      const z = s * (4.5 + i * 5.5);
      shelfRun(A, rng, x, z, 1.15, s);
    }
  }

  // ---- crate stacks in the hall mouth: the first cover you reach ----
  //
  // x is NOT multiplied by `s`. It used to be, which placed these two by 180 deg
  // rotation while everything around them was placed by reflection: the pair
  // ended up at (6.5, 7.5) and (-6.5, -7.5) where a mirror wants (6.5, 7.5) and
  // (6.5, -7.5). Both are defensible symmetries and the map cannot have one of
  // each — `tools/symmetry.mjs` scores it against both and takes the better,
  // and this was most of what kept the two scores apart.
  crateStack(A, rng, 6.5, s * 7.5, 3, s);
  crateStack(A, rng, -5.0, s * 9.0, 2, s);
}

/* ========================================================================== */
/* pieces                                                                     */
/* ========================================================================== */

/** A 6.1 x 2.44 x 2.6 m shipping container. Full cover, mantle-height roof. */
function container(A, rng, x, z, ry) {
  const W = 6.1;
  const H = 2.6;
  const D = 2.44;
  const key = rng.float() < 0.5 ? 'metal_rust' : 'metal_blue';
  A.addBox(key, BOX(A), x, H * 0.5, z, ry, W, H, D);
  A.box('metal', x, H * 0.5, z, W, H, D, ry);
  // Corrugation: shallow ribs down the long faces, purely visual.
  for (let i = -6; i <= 6; i++) {
    const ox = i * 0.44;
    for (const sd of [-1, 1]) {
      A.addBox(key, BOX_FINE(A),
        x + dcos(ry) * ox, H * 0.5, z - dsin(ry) * ox + sd * (D * 0.5 + 0.02),
        ry, 0.09, H - 0.24, 0.05);
    }
  }
}

/**
 * The bottom bay of a pallet rack: two load levels, uprights, orange beams.
 *
 * `h` is the TOP deck height and it is the gameplay number — 1.15 m puts the
 * deck at the waist, so you shoot over it standing and it is full cover
 * crouched. Everything else here is silhouette.
 *
 * The first version was a single plank on four thin legs and it photographed as
 * a café table: nothing about it said warehouse, and against an all-grey hall
 * it had no read at all. A rack needs three things to be legible — a second
 * level low down, uprights that are continuous top to bottom, and load beams
 * in a colour that is not concrete. The beams are rusted orange for exactly
 * that reason; they are the only warm thing in the lanes.
 */
function shelfRun(A, rng, x, z, h, mir = 1) {
  const W = 1.1;
  const D = 4.2;
  /** Lower load level — pallet height, and the reason the rack reads as a rack. */
  const LOW = 0.34;
  const UP = 0.12;

  for (const level of [LOW, h]) {
    // Deck.
    A.addBox('plywood', BOX_FINE(A), x, level, z, 0, W - 0.04, 0.06, D - 0.24);
    // Load beams front and back: the horizontal that carries the deck.
    for (const sx of [-1, 1]) {
      A.addBox('metal_orange', BOX_FINE(A),
        x + sx * (W * 0.5 - UP * 0.5), level - 0.06, z, 0, UP, 0.12, D);
    }
  }
  // Collision is the top deck only. The lower level is under knee height and
  // giving it a slab would let a player stand on a 34 cm ledge inside cover.
  A.box('wood', x, h, z, W, 0.12, D);

  // Uprights, full height, with a footplate so they meet the floor.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = x + sx * (W * 0.5 - UP * 0.5);
      const pz = z + sz * (D * 0.5 - UP * 0.5);
      A.addBox('steel', BOX_FINE(A), px, h * 0.5 + 0.04, pz, 0, UP, h + 0.08, UP);
      A.addBox('metal_dark', BOX_FINE(A), px, 0.015, pz, 0, 0.26, 0.03, 0.26);
      A.box('metal', px, h * 0.5, pz, 0.16, h, 0.16);
    }
  }
  // End-frame cross brace: a diagonal across the narrow face, one per end.
  for (const sz of [-1, 1]) {
    const pz = z + sz * (D * 0.5 - UP * 0.5);
    A.addBox('steel', BOX_FINE(A), x, h * 0.5, pz, 0, W - UP, 0.05, 0.05);
  }

  // Palletised stock. Both levels, so the rack looks loaded rather than empty.
  for (const level of [LOW, h]) {
    const n = 1 + ((rng.float() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const s = 0.46 + rng.float() * 0.2;
      // `mir` on the along-rack offset and the yaw: both are Z quantities, and
      // the pallets are the only thing on a rack that moves.
      const pz = z + (rng.float() - 0.5) * (D - s - 0.5) * mir;
      const key = rng.float() < 0.35 ? 'wood_prop_dark' : 'wood_prop';
      const pry = (rng.float() * 0.3 - 0.15) * mir;
      A.addBox(key, BOX(A), x, level + 0.06 + s * 0.5, pz, pry, s, s, s);
      if (level === h) A.box('wood', x, level + 0.06 + s * 0.5, pz, s, s, s);
    }
  }
}

/** A stack of wooden crates. `n` is how many, tapering as it goes up. */
function crateStack(A, rng, x, z, n, mir = 1) {
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = 0.92 - i * 0.12;
    const jx = (rng.float() - 0.5) * 0.16;
    // `mir` reflects the offsets that a Z mirror has to reflect. With the same
    // rng stream fed to both halves (see buildWarehouse) this is what turns
    // "the same crates, jittered differently" into an actual mirror image.
    const jz = (rng.float() - 0.5) * 0.16 * mir;
    const ry = (rng.float() - 0.5) * 0.5 * mir;
    A.addBox(rng.float() < 0.35 ? 'wood_prop_dark' : 'wood_prop', BOX(A),
      x + jx, y + s * 0.5, z + jz, ry, s, s, s);
    A.box('wood', x + jx, y + s * 0.5, z + jz, s, s, s, ry);
    y += s;
  }
}

/**
 * Mid: the three pieces that stand on the three spawn-to-spawn lines.
 *
 * There are exactly three routes across this map and, because both spawn rows
 * use the same |x| values against a map mirrored about Z, all three used to run
 * dead straight from one spawn to the opposite one — 31 to 32 m of unbroken
 * sightline at the instant the round went live. `tools/reach.mjs` reported all
 * six ordered pairs open, and `shots/play/01-freeze.png` shows the consequence:
 * an enemy standing in the middle of the hall, in view, during WARMUP.
 *
 * That is not cover being thin, it is the freeze phase not meaning anything.
 * Freeze exists so nobody moves before the bell; if the two courts can see each
 * other, the bell is a starting gun for whoever was already aiming.
 *
 * The island that was here reads in the old comment as "breaks the sightline
 * without blocking it" and was 1.1 m tall, which does neither for an eye at
 * 1.66 m — it was cover for a crouch and a footstool for everyone else. It is
 * now 2.7 m, and the two lanes get a container each on their own line.
 *
 * z = 0 for all three on purpose: the mirror plane is the one place a piece can
 * stand without needing a partner, and it is also the honest place for the
 * break. This blocks the shot you have not moved for, not the shot you walked
 * up the map to earn — step past mid and the lane opens, as it should.
 */
function centreClutter(A, rng) {
  const MID_H = 2.7;
  A.addBox('concrete_dark', BOX(A), 0, MID_H * 0.5, 0, 0, 4.6, MID_H, 2.2);
  A.box('concrete', 0, MID_H * 0.5, 0, 4.6, MID_H, 2.2);
  for (const sx of [-1, 1]) {
    // Yaw 0, not sx * 0.3.
    //
    // A piece standing ON the mirror plane is its own partner, so the only yaw
    // it can carry and still be symmetric is one a Z-flip leaves alone. 0.3 rad
    // is 17 degrees, and it was applied to both mid crates and both lane
    // containers — every one of them presenting a different face to -Z than to
    // +Z, on the three lines the whole map is fought along. This is the one
    // place in the level where "looks a bit more casual" costs a measurable
    // angle, and the angle wins.
    // x = +-2.7 is FLUSH with the block, not 0.4 m off it.
    //
    // The block's edge is at 2.3 and the crate is 0.8 wide, so a centre at 3.1
    // left a 0.4 m slot between them — narrower than the 0.8 m capsule that has
    // to walk through it, sitting on the map's centre line where every crossing
    // happens. Bots repeatedly aimed at the gap, wedged, backed off and came
    // again: `tools/converge.mjs` traced the bounce between (2.6, -0.7) and
    // (1.8, -8.8) more than once, and a player would find the same lip.
    //
    // A gap has to be either wide enough to use or not there. Flush is the
    // better of the two here: it keeps the mid silhouette compact, and the crate
    // still reads as a crate — leaning against the block instead of beside it.
    A.addBox('metal_dark', BOX_FINE(A), sx * 2.7, 0.42, 0, 0, 0.8, 0.84, 0.8);
    A.box('metal', sx * 2.7, 0.42, 0, 0.8, 0.84, 0.8);
    // The lane blockers, on x = +-12.5 because that is where the lane spawns
    // stand. 6.1 m of container spans x 9.45 to 15.55, which is the lane mouth
    // from the partition wall outward, and leaves 8.4 m of lane outboard of it
    // — a chicane, not a plug. `reach.mjs` re-checks connectivity.
    container(A, rng, sx * 12.5, 0, 0);
  }
}

/**
 * Spawn table. Three points per team so a round reset spreads a squad instead
 * of stacking it on one tile.
 *
 * YAW CONVENTION: forward at yaw is (-sin, 0, -cos), so yaw 0 faces -Z. A team
 * standing at -Z needs yaw PI to look up the map. Getting this backwards spawns
 * everyone nose-first into their own back wall.
 *
 * The x values are chosen against the props, not for symmetry alone: +-12.5 is
 * the lane mouth (the shelving runs sit at +-14.5, a clear metre outboard) and
 * 0 is the gap between the two spawn containers. Every one of these has an
 * unobstructed first step up the map — that is the whole job of a spawn point.
 */
export const SPAWNS = [
  [-12.5, -15.5, Math.PI, 'alpha', 'alpha-west'],
  [0, -16, Math.PI, 'alpha', 'alpha-centre'],
  [12.5, -15.5, Math.PI, 'alpha', 'alpha-east'],
  [12.5, 15.5, 0, 'bravo', 'bravo-west'],
  [0, 16, 0, 'bravo', 'bravo-centre'],
  [-12.5, 15.5, 0, 'bravo', 'bravo-east'],
];
