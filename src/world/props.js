import { pockGeometry } from './kit-damage.js';
import { paintMasks } from './util-accum.js';
import { rockGeometry } from './util.js';
import { PB } from './props-base.js';
import { barrel, bucket, cardboardBox, concreteBlock, crate, gasBottle, jerryCan, jerseyBarrier, sandbag } from './props-containers.js';
import { bottle, brickChunk, can, dustSkirt, litterPaper, plank, rebarBundle, slabShard } from './props-debris.js';
import { palmFrond, palmTree, planter, shrub, signBoard, signHanging, weedTuft } from './props-flora.js';
import { acUnit, cabinet, chair, lampGlass, mattress, pallet, roofVent, satDish, shelfUnit, stall, streetLamp, table, tyre, waterTank } from './props-furniture.js';


/**
 * The prop registry. The builders moved out by category — `props-containers`,
 * `-furniture`, `-debris`, `-flora`, over the vocabulary in `props-base` — and
 * this file is what names them and what a burnt car is made of.
 */


// ================================================================ vehicles ==
/**
 * A burnt-out saloon. Built as one merged geometry per material group and
 * returned so the caller can place one or two — silhouette first: sagging roof,
 * blown glass, missing wheels, doors hanging.
 */
export function burntCar(_rng) {
  const body = new PB();
  const L = 4.35;
  const W = 1.78;
  // main body tub
  body.box(W, 0.5, L, 0, 0.62, 0, { bevel: 0.05, grime: 0.5 });
  body.box(W * 0.99, 0.34, L * 0.62, 0, 0.95, -0.15, { bevel: 0.06, grime: 0.5 });
  // bonnet + boot
  body.box(W * 0.94, 0.13, L * 0.3, 0, 0.94, L * 0.33, { bevel: 0.03, rx: 0.06, wear: 1 });
  body.box(W * 0.94, 0.13, L * 0.22, 0, 0.95, -L * 0.38, { bevel: 0.03, rx: -0.08, wear: 1 });
  // cabin: A/B/C pillars and a sagging roof
  const rh = 1.42;
  for (const sx of [-1, 1]) {
    body.box(0.09, 0.55, 0.1, sx * (W / 2 - 0.08), 1.2, L * 0.14, { rx: 0.35, grime: 0.4 });
    body.box(0.09, 0.5, 0.1, sx * (W / 2 - 0.08), 1.22, -L * 0.02, { grime: 0.4 });
    body.box(0.11, 0.52, 0.12, sx * (W / 2 - 0.08), 1.2, -L * 0.2, { rx: -0.3, grime: 0.4 });
    // sills and door skins
    body.box(0.07, 0.42, L * 0.42, sx * (W / 2 - 0.03), 0.68, 0.05, { bevel: 0.02, wear: 1, grime: 0.5 });
  }
  body.box(W * 0.86, 0.07, L * 0.36, 0, rh - 0.04, -L * 0.04, { bevel: 0.04, wear: 1, grime: 0.6 });
  // wheel arches
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      body.cyl(0.42, 0.1, sx * (W / 2 - 0.04), 0.5, sz * L * 0.31, {
        radial: 12,
        rz: Math.PI / 2,
        open: true,
        grime: 0.5,
      });
    }
  // bumpers
  body.box(W * 0.98, 0.22, 0.16, 0, 0.5, L / 2 - 0.05, { bevel: 0.03, wear: 1, grime: 0.5 });
  body.box(W * 0.98, 0.22, 0.16, 0, 0.5, -L / 2 + 0.05, { bevel: 0.03, wear: 1, grime: 0.5, rz: 0.05 });
  const g = body.build();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    // soot: heaviest around the cabin and upward faces
    const soot = 0.45 + 0.5 * Math.max(0, ny) + 0.3 * Math.max(0, 1 - Math.abs(z) / 1.6);
    out[1] = Math.min(1, out[1] + soot * 0.8);
    out[0] = Math.min(1, out[0] * 0.8);
  });
  return g;
}

// =============================================================== registry ==
/**
 * Register every instanced prototype. Called once, before the level is built.
 * Prototype ids are the vocabulary dressing.js and interiors.js draw from.
 */
export function registerProps(A, rngIn) {
  const rng = rngIn;
  const P = (id, key, geo, opts = {}) => A.proto(id, { geo, key, ...opts });
  /**
   * Mark a prototype as a LOOSE object: something a person dropped, stacked or
   * kicked, which is therefore never plumb and never exactly the nominal size.
   * `tilt` is the maximum knock out of true in radians (0.09 ~ 5 deg) and `sink`
   * pushes it down far enough that the corner the tilt raises does not float off
   * the ground. Fixed things — lamp posts, signs, wall pocks, bottles standing
   * on a table — deliberately do not get one.
   */
  const LOOSE = (tilt, sink) => ({ tilt, sink });

  // containers
  P('crate_a', 'wood_prop', crate(rng, 0.64), { skirt: 0.37, ...LOOSE(0.09, 0.022) });
  P('crate_b', 'wood_prop', crate(rng, 0.48), LOOSE(0.10, 0.018));
  P('crate_c', 'wood_prop_dark', crate(rng, 0.82), { skirt: 0.45, ...LOOSE(0.075, 0.026) });
  P('crate_flat', 'wood_prop', crate(rng, 0.55, false), LOOSE(0.10, 0.02));
  P('box_card_a', 'wood_pale', cardboardBox(rng, 0.46), LOOSE(0.10, 0.016));
  P('box_card_b', 'wood_pale', cardboardBox(rng, 0.34), LOOSE(0.11, 0.012));
  P('barrel_rust', 'metal_rust_prop', barrel(rng), { skirt: 0.28, ...LOOSE(0.085, 0.014) });
  P('barrel_blue', 'metal_blue', barrel(rng, 0.28, 0.9, 2), { skirt: 0.26, ...LOOSE(0.085, 0.014) });
  P('barrel_wood', 'wood_prop_dark', barrel(rng, 0.31, 0.78, 4), { skirt: 0.28, ...LOOSE(0.09, 0.015) });
  P('gas_bottle', 'metal_green', gasBottle(rng), { skirt: 0.18, ...LOOSE(0.07, 0.008) });
  P('bucket', 'metal_rust_prop', bucket(rng), LOOSE(0.12, 0.008));
  P('jerry_can', 'metal_green', jerryCan(rng), LOOSE(0.10, 0.01));

  // cover
  P('sandbag_a', 'burlap', sandbag(rng, 0), LOOSE(0.085, 0.006));
  P('sandbag_b', 'burlap', sandbag(rng, 1), LOOSE(0.09, 0.006));
  P('sandbag_c', 'burlap', sandbag(rng, 2), LOOSE(0.095, 0.006));
  P('jersey', 'concrete_prop', jerseyBarrier(rng), { skirt: 0.69, maxDist: 0 });
  P('block_big', 'concrete_prop', concreteBlock(rng, 1.25, 0.95, 0.85), { skirt: 0.63, ...LOOSE(0.05, 0.03) });
  P('block_small', 'concrete_dark', concreteBlock(rng, 0.55, 0.42, 0.4), { skirt: 0.31, ...LOOSE(0.09, 0.018) });
  P('tyre', 'rubber', tyre(rng), { skirt: 0.33, ...LOOSE(0.10, 0.008) });
  P('tyre_small', 'rubber', tyre(rng, 0.26), LOOSE(0.11, 0.006));
  P('pallet', 'wood_prop', pallet(rng), { skirt: 0.51, ...LOOSE(0.055, 0.02) });

  // furniture
  P('table', 'wood_prop_dark', table(rng, 1.5, 0.78, 0.8), { skirt: 0.57 });
  P('table_small', 'wood_prop', table(rng, 0.9, 0.72, 0.7));
  P('stall', 'wood_prop_dark', stall(rng, 2.3), { skirt: 0.90, maxDist: 0 });
  P('shelf', 'wood_prop_dark', shelfUnit(rng), { skirt: 0.42 });
  P('mattress', 'fabric_cream', mattress(rng), LOOSE(0.06, 0.01));
  P('chair', 'wood_prop', chair(rng), LOOSE(0.05, 0.012));
  P('cabinet', 'wood_prop_dark', cabinet(rng), { skirt: 0.42 });

  // services
  P('ac_unit', 'metal_dark', acUnit(rng));
  P('sat_dish', 'metal_dark', satDish(rng));
  P('water_tank', 'metal_blue', waterTank(rng), { skirt: 0.48 });
  P('roof_vent', 'metal_rust', roofVent(rng));
  P('lamp_post', 'metal_dark', streetLamp(rng), { skirt: 0.25, chunk: false });
  P('lamp_glass', 'lamp_lens', lampGlass(), { chunk: false, castShadow: false });

  // debris
  P('brick_a', 'brick', brickChunk(rng), LOOSE(0.16, 0.006));
  P('brick_b', 'brick', brickChunk(rng), LOOSE(0.16, 0.006));
  P('rock_a', 'concrete_prop', rockGeometry(rng, 0.26, 0, 0.7), { maxDist: 90 });
  P('rock_b', 'concrete_dark', rockGeometry(rng, 0.17, 0, 0.8), { maxDist: 70, castShadow: false });
  P('slab_shard', 'concrete_prop', slabShard(rng), LOOSE(0.14, 0.01));
  P('rebar', 'metal_rust', rebarBundle(rng), LOOSE(0.10, 0.004));
  P('plank_a', 'wood_prop', plank(rng), { maxDist: 90, ...LOOSE(0.06, 0.004) });
  P('plank_b', 'wood_prop_dark', plank(rng), { maxDist: 90, ...LOOSE(0.06, 0.004) });
  P('litter', 'wood_pale', litterPaper(rng), { maxDist: 45, castShadow: false });
  /**
   * Contact fillets. Registered last so `put()` can find it, and never given a
   * skirt of its own. maxDist keeps them off the far half of the map, where
   * the contact line is a pixel wide anyway.
   */
  P('dust_skirt', 'dust_skirt', dustSkirt(rng), { maxDist: 42, castShadow: false });
  P('bottle', 'glass', bottle(rng), { maxDist: 55, castShadow: false });
  P('can', 'steel', can(rng), { maxDist: 45, castShadow: false });

  // vegetation
  const palm = palmTree(rng, 5.4);
  P('palm_trunk', 'wood_dark', palm, { skirt: 0.57, chunk: false });
  P('palm_frond', 'foliage', palmFrond(rng, 2.7), { chunk: false, receiveShadow: true });
  P('shrub', 'foliage', shrub(rng, 0.85));
  P('weeds', 'foliage', weedTuft(rng), { maxDist: 40 });
  P('planter', 'concrete_prop', planter(rng), { skirt: 0.33, ...LOOSE(0.07, 0.014) });

  // signage
  P('sign_board', 'metal_blue', signBoard(rng, 1.6, 0.55), { skirt: 0.18 });
  P('sign_hang', 'metal_green', signHanging(rng));

  // damage
  // 3.2 cm base radius: the callers scale it 0.5-1.5x, so pocks land at 3-10 cm
  // across. At the old 5.5 cm base a single rifle strike was 16 cm wide.
  P('pock', 'concrete_dark', pockGeometry(rng, 0.032), { maxDist: 65, castShadow: false });
  return A;
}

