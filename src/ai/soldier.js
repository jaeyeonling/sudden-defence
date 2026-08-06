/**
 * AI — soldier assembly. Turns the part library into a finished, skinned,
 * material-grouped character. One geometry per visual variant, shared by every
 * instance of that variant; only the skeleton is per-instance.
 */

import * as THREE from 'three';
import { RIG, GRIP_R, GRIP_L, BORE_DIR } from './rig.js';
import { CharacterBuilder, Noise, appendMesh, computeNormals, emptyMesh } from './geo.js';
import * as P from './parts.js';
import { buildWeapon } from './weapon.js';
import { CLOTH_TILE } from './textures.js';

/**
 * Metres of surface per texture tile. `cloth` is deliberately large: it is the
 * tile that has to carry the 0.2-0.4 m camo macro blotches, and the 1.5 mm weave
 * it can no longer resolve is supplied by the shader detail layer instead.
 */
const MATERIALS = {
  cloth: { tile: CLOTH_TILE },
  plate: { tile: 0.42 },
  gear: { tile: 0.26 },
  // Same cordura bake as the gear, different tint and roughness — see the
  // `team` case in resolveMaterials.
  team: { tile: 0.26 },
  // Boots and gloves share the cordura bake with the pouches but NOT its
  // roughness: leather-and-rubber footwear is markedly smoother than webbing,
  // and having the whole kit sit at one gloss is half of why the figure reads as
  // one extruded blob. Own material name -> own geometry group -> own roughness.
  boot: { tile: 0.26 },
  skin: { tile: 0.20 },
  polymer: { tile: 0.15 },
  steel: { tile: 0.18 },
  rubber: { tile: 0.11 },
  glass: { tile: 1.0 },
};

/**
 * Roughness multiplier per material set, applied on top of the baked roughness
 * map so the *relative* variation the bake carries is preserved.
 *
 *   cloth 0.85   matte ripstop, map averages 0.905
 *   plate 0.55   laminate over foam, map averages 0.62
 *   boot  0.70   waxed leather / rubber, cordura map averages 0.79
 *
 * These three are the values the silhouette needs: at 25 m the only thing that
 * separates a plate carrier from the jacket under it is the width of its
 * specular lobe.
 */
const ROUGH = { cloth: 0.85 / 0.905, plate: 0.55 / 0.62, boot: 0.7 / 0.79 };

/** Detail tile size in metres — must match `bakeDetail` in textures.js. */
const DETAIL_TILE = 0.05;

/**
 * ALBEDO BUDGET (linear, after the vertex tint multiplies the map)
 *
 * MEASURED, not asserted — `node src/ai/selftest.mjs` prints this table from the
 * geometry and the real bakes, and `SoldierMaterials` prints the cloth map's mean
 * and range at boot. Current values:
 *
 *   uniform cloth      0.092-0.094   map mean 0.104, every texel in 0.040-0.152
 *   helmet cover       0.064         deliberately off the uniform value
 *   mag/admin pouches  0.058-0.076
 *   knee + elbow pads  0.057-0.063
 *   carrier            0.047         laminate, and smoother than the cloth
 *   webbing / sling    0.051-0.054
 *   boots              0.032
 *   gloves             0.032-0.048
 *   skin               0.152-0.190
 *
 * Real desert multicam is 0.18-0.32 and that is what this used to target, but the
 * environment it stands in currently behaves like 0.05-0.09 albedo on screen
 * (see the measurement table in textures.js), so a physically-honest uniform
 * rendered brighter than sunlit plaster and read as a white mannequin. The whole
 * kit is therefore scaled by one documented constant, `KIT_CAL`, which keeps the
 * *hierarchy* — cloth brightest, pouches under it, carrier under that, boots and
 * gloves darkest — because that internal value structure is what breaks the "one
 * extruded blob" read at 25 m. Raise `CLOTH_BUDGET.mean` and `KIT_CAL` together
 * if the world's albedo is ever brought up to physical values.
 */
const GEAR = {
  webbing: [0.70, 0.70, 0.70],
  sling: [0.70, 0.70, 0.70],
  pouch: [0.84, 0.84, 0.84],
  pouchAlt: [0.76, 0.76, 0.76],
  dump: [0.72, 0.72, 0.72],
  belt: [0.62, 0.61, 0.57],
  pad: [0.55, 0.55, 0.55],
  strap: [0.56, 0.56, 0.56],
  wrap: [0.56, 0.54, 0.50],
  glove: [0.38, 0.372, 0.363],
  boot: [0.22, 0.209, 0.198],
  lace: [0.21, 0.204, 0.198],
  // A hard ballistic mask is moulded polymer, not webbing: near-black with a
  // clean sheen, which is what makes the lower face read as a mask at 35 m
  // instead of another patch of tan cloth.
  mask: [0.62, 0.63, 0.66],
};

/**
 * How hard the team colour is pushed into the plate carrier's vertex tint.
 *
 * Friend/foe was supposed to rest on camo family alone (wolf grey against tan,
 * see `breacher` below). It does not work. Measured at 9 m, the chest pixels of
 * the two team variants sit at a chromaticity distance of 0.0123 — for scale,
 * `tools/markings.mjs` demands 0.100 between the two spawn bays, and the broken
 * state that gate was written to catch measured 0.036. The two uniforms are, to
 * the eye, the same colour. Under the warehouse's own light they have to be:
 * both camo sets are calibrated into the same 0.16-0.32 albedo window, and that
 * window is most of what "reads as a soldier and not a toy" means here.
 *
 * So the team read gets its own surface instead of being asked to fall out of
 * the camo. The plate carrier is the one it should be: it is the largest flat
 * area on the body, it faces the shooter from the front AND the back, and it is
 * the only part in the whole build that draws with material slot `plate`, so
 * tinting it touches nothing else.
 *
 * Two properties of the vertex-tint path matter more than the number:
 *
 *  - it multiplies into the albedo, so the AO / grime / dust / wear bake in
 *    `geo.js` survives on top of it. A flat emissive panel would erase all of
 *    it, which is what the first attempt at this did.
 *  - it adds no geometry. Geometry construction draws from the shared RNG
 *    stream, so a new part would shift every downstream random draw and repaint
 *    the whole picture; changing a colour cannot. The capture baseline moves by
 *    exactly the carrier and nothing else.
 *
 * 0.85 rather than 1.0: at full strength the carrier goes to the flat HUD blue
 * and stops looking like dyed nylon under a shadow. 0.85 keeps a little of the
 * variant's own plate value in it and still measures far past the gate.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THE UNIFORM IS TINTED TOO, AND MORE GENTLY
 *
 * The carrier alone was tried first and measured 0.0538 head-on at 9 m — half
 * the gate. The reason is visible the moment the shot is staged rather than
 * imagined: a man at low ready holds his rifle ACROSS HIS CHEST, and both
 * forearms with it. The largest flat panel on the body is one of the least
 * visible surfaces from the front, and the pixels a shooter actually integrates
 * are sleeves, shoulders, thighs and helmet.
 *
 * So the garment carries the team read and the carrier reinforces it, rather
 * than the carrier carrying it alone. `CLOTH` is deliberately about half the
 * carrier's strength: enough that the two sides are never confusable at a
 * glance, gentle enough that the camo macro pattern still reads as camo and not
 * as a solid team jersey. Both go through the same value-preserving path, so
 * neither changes the albedo window the whole character set is calibrated to.
 *
 * Head wrap, gloves and boots are deliberately left out. A figure tinted from
 * crown to sole is a paper cut-out; leaving the extremities in their own kit
 * colours is what keeps the internal value structure that makes a procedural
 * character read as a person. Helmet and shoulders are also not tinted here —
 * they are the bright marker instead, on the `team` material slot.
 */
const TEAM_ACCENT_STRENGTH = { carrier: 0.85, cloth: 0.45 };

/**
 * Turn a team colour into a vertex tint that rotates hue and never clips.
 *
 * The accent is normalised so its LARGEST channel is 1, not so its mean is 1.
 * Mean-normalising is the obvious choice — it holds luminance, which is exactly
 * what a hue-only push wants — and it does not work, because `geo.js` finishes
 * every baked vertex colour with `clamp01`. Any channel asked to go above 1 is
 * silently truncated, so a mean-normalised tint does not rotate hue at all: it
 * applies the REDUCTIONS and throws the boost away.
 *
 * That is not a rounding error, and it showed up as an asymmetry between the
 * sides. Alpha's blue survived, because its boosted channel was one it could
 * afford to lose while red came down hard. Bravo's red WAS the clipped channel,
 * so the tan uniform lost green and blue, gained nothing, and photographed
 * olive. One team looked blue and the other looked like nobody in particular.
 *
 * Max-normalising holds every channel at or below 1, so the tint is purely
 * subtractive and both sides get the shift they asked for. It costs a little
 * luminance; that is the price of the clamp, and it is paid evenly.
 *
 * The bright marker path does NOT use this. A material `color` is a uniform
 * rather than a clamped attribute, so it can go above 1 — see `teamMarkerTint`.
 */
function accentTint(base, accent, strength) {
  if (!accent) return base;
  const peak = Math.max(accent[0], accent[1], accent[2]);
  if (!(peak > 1e-4)) return base;
  return base.map((c, i) => c * (1 + strength * (accent[i] / peak - 1)));
}

/**
 * The bright team marker — helmet shell and shoulder flashes.
 *
 * Everything above rotates hue while holding value, and on its own that is not
 * enough. MEASURED, and this is the finding the design turns on: with the two
 * teams' albedo forced to PURE BLUE and PURE RED — a chromaticity distance of
 * about 0.5 in the albedo itself — the staged 9 m frame separated by 0.0332.
 * A factor of fifteen is lost between the texture and the pixel.
 *
 * It is not the post chain. Attributed by running the gate with each pass off:
 *
 *     default 0.0332 · q=low 0.0332 · volumetrics off 0.0267 · gtao off 0.0297
 *     · bloom off 0.0337
 *
 * `q=low` disables gtao, ssr AND volumetrics together and does not move the
 * number at all, so nothing in post is washing this out. The cause is upstream
 * and simpler: THE UNIFORM IS NEARLY BLACK. Cloth albedo is 0.092 (see the
 * budget table above) while the same pixels leave the frame at luminance 0.31,
 * so most of what reaches the eye is light the surface never coloured. Hue
 * applied to a 0.09 albedo has no energy to carry it, and the pixels that DO
 * carry energy — face, gloves, the weapon's steel and polymer, every specular
 * highlight — are exactly the ones no team owns.
 *
 * The answer is therefore not a stronger tint on a dark surface, which the
 * pure-primary measurement rules out completely. It is a SMALL AREA OF GENUINELY
 * BRIGHT COLOUR, and it has to be a MATERIAL colour rather than a vertex tint
 * for the clamp reason above. `gain` multiplies value as well as hue, taking the
 * marker to an albedo around 0.25 — a painted helmet and shoulder flashes, which
 * is both what the measurement demands and what a real unit does when it has to
 * be told apart at a glance.
 *
 * Helmet and shoulders specifically: they are the two places on a man that a
 * rifle held at low ready cannot cover. The plate carrier is the largest flat
 * panel on the body and, staged and photographed, mostly forearms.
 *
 * The albedo budget survives because the marker is a few percent of the
 * silhouette. The rule it must not break is the hierarchy in the budget note —
 * cloth brightest, kit under it, boots and gloves darkest — and a helmet flash
 * sits outside that hierarchy rather than inverting it.
 */
const TEAM_MARKER_GAIN = 5.5;

/**
 * Material tint for the `team` slot: the accent normalised to unit mean, then
 * scaled by the gain. Unit-mean first so both teams get the same VALUE and
 * differ only in hue — a brighter side would be an easier target.
 *
 * No accent (the teamless `irregular`) falls back to the neutral kit grey the
 * parts wore before the slot existed.
 */
function teamMarkerTint(accent) {
  if (!accent) return [0.7, 0.7, 0.7];
  const mean = (accent[0] + accent[1] + accent[2]) / 3;
  if (!(mean > 1e-4)) return [0.7, 0.7, 0.7];
  return accent.map((c) => (c / mean) * TEAM_MARKER_GAIN);
}

/**
 * Visual variants. Each is a different silhouette, not a recolour: helmet vs
 * wrapped head, full plate vs chest rig, carbine vs long rifle.
 *
 * The three tints are hue shifts at roughly unit luminance — value is set per
 * part by the table above, so a variant can change colour family without
 * dragging every piece of its kit out of the albedo budget.
 */
export const VARIANTS = {
  vanguard: {
    camo: 'arid',
    clothTint: [1.03, 1.0, 0.94],
    gearTint: [1.08, 0.98, 0.80], // coyote brown
    plateTint: [1.02, 0.96, 0.84],
    skinTint: [1.0, 0.94, 0.88],
    helmet: true,
    helmetCover: true,
    helmetTint: [0.72, 0.72, 0.68],
    goggles: true,
    gogglesDown: true,
    faceWrap: true,
    beard: false,
    kneePads: true,
    fullCarrier: true,
    weapon: 'carbine',
    bulk: 1.0,
    scale: 1.0,
  },
  irregular: {
    camo: 'woodland',
    clothTint: [0.98, 1.02, 0.94],
    gearTint: [0.92, 0.96, 0.74], // olive drab
    plateTint: [0.90, 0.94, 0.80],
    skinTint: [0.86, 0.80, 0.74],
    helmet: false,
    headWrap: true,
    goggles: false,
    // dark wrap-around shooting glasses: the bare head needs a hard horizontal
    // dark band at the eye line or it is a featureless egg at 35 m
    shades: true,
    faceWrap: true,
    beard: true,
    kneePads: false,
    fullCarrier: false,
    weapon: 'ak',
    bulk: 0.94,
    scale: 0.985,
  },
  breacher: {
    camo: 'urban',
    clothTint: [0.98, 0.99, 1.02],
    gearTint: [0.84, 0.86, 0.90], // wolf grey
    plateTint: [0.86, 0.88, 0.92],
    skinTint: [1.06, 0.98, 0.92],
    helmet: true,
    helmetCover: false, // bare painted shell instead of a cloth cover
    helmetTint: [0.82, 0.83, 0.86],
    // goggles parked on the shell (not over the eyes like vanguard) plus a hard
    // ballistic half-mask: same helmet family, completely different head read
    goggles: true,
    gogglesDown: false,
    faceWrap: true,
    maskHard: true,
    beard: true,
    kneePads: true,
    fullCarrier: true,
    weapon: 'carbine',
    // 1.0 / 1.0, not 1.06 / 1.025.
    //
    // `breacher` and `vanguard` are the two TEAM uniforms (see match/teams.js),
    // and a symmetric elimination mode cannot hand one side a bigger body. The
    // cost was not cosmetic: `scale` multiplies the hitbox capsule radii
    // (agent.js, `radius: r * this.scale`) and the group scale stretches their
    // endpoints with it, so at 1.025 every alpha fighter presented a hitbox
    // 2.5 % longer and 2.5 % wider — about 5 % more area — than the bravo
    // fighter shooting at him, in both directions, every round of every match.
    //
    // `bulk` came down for the opposite reason. It thickens the jacket torso
    // mesh (parts.js) and nothing else, so at 1.06 the visible chest stood
    // ~1 cm proud of the capsule that registers hits: a round placed on the
    // edge of a breacher's silhouette passed through him. Whatever the number,
    // mesh and hitbox have to agree, and the way to guarantee that is to leave
    // the reference build alone.
    //
    // Nothing is lost from friend/foe reading, which never rested on 2.5 % of
    // height: the sides are told apart by camo family (wolf grey against tan),
    // by the head — bare painted shell with the goggles parked up and a hard
    // ballistic half-mask, against a covered helmet with the goggles down —
    // and by the beard. `irregular` keeps its 0.985 because it belongs to no
    // team; if it is ever assigned one, it has to come to 1.0 first.
    bulk: 1.0,
    scale: 1.0,
  },
};

const bp = (name) => {
  const v = RIG.bindPos[RIG.index(name)];
  return [v.x, v.y, v.z];
};

/**
 * Build one variant.
 * @returns { geometry, materials: THREE.Material[], weapon, stats }
 */
export function buildSoldier(name, { rng, materials, accent = null }) {
  const V = VARIANTS[name] ?? VARIANTS.vanguard;
  const nz = new Noise(rng.fork());
  const B = new CharacterBuilder(RIG, { noise: nz, materials: MATERIALS });

  // The team read. `uniform` goes on the issued garment, `marker` on the plate
  // carrier; both hold their input's value and only rotate its hue. With no
  // accent both are the identity, which is what `irregular` gets.
  const uniform = (c) => accentTint(c, accent, TEAM_ACCENT_STRENGTH.cloth);
  const carrierTint = (c) => accentTint(c, accent, TEAM_ACCENT_STRENGTH.carrier);

  const shR = bp('UpperArmR'), elR = bp('ForearmR'), wrR = bp('HandR');
  const shL = bp('UpperArmL'), elL = bp('ForearmL'), wrL = bp('HandL');
  const hipR = bp('UpLegR'), knR = bp('LegR'), anR = bp('FootR');
  const hipL = bp('UpLegL'), knL = bp('LegL'), anL = bp('FootL');
  const head = bp('Head');

  /* ---------------- occlusion proxies (drives baked vertex AO) -------- */
  B.occlude([0, 0.95, -0.01], [0, 1.42, 0.0], 0.155, 1.0); // torso core
  B.occlude([0, 1.17, 0.130], [0, 1.40, 0.138], 0.11, 1.0); // front plate
  B.occlude([0, 1.20, -0.105], [0, 1.40, -0.112], 0.105, 0.8); // back plate
  B.occlude([-0.17, 1.16, 0.02], [-0.17, 1.30, 0.02], 0.055, 0.7); // right side
  B.occlude([0.17, 1.16, 0.02], [0.17, 1.30, 0.02], 0.055, 0.7);
  B.occlude([0, 1.60, 0.0], [0, 1.80, -0.01], 0.122, 1.0); // helmet interior
  B.occlude([-0.09, 1.655, 0.05], [0.09, 1.655, 0.05], 0.055, 1.0); // brim shadow
  B.occlude(shR, elR, 0.058, 0.7);
  B.occlude(shL, elL, 0.058, 0.7);
  B.occlude(hipR, knR, 0.085, 0.8);
  B.occlude(hipL, knL, 0.085, 0.8);
  B.occlude([0, 0.90, -0.01], [0, 1.05, -0.01], 0.15, 0.8); // belt line
  // strap crossings — shoulder yokes and the diagonal sling run. These are the
  // places a real uniform is darkest: sweat, webbing dye and ground-in dust all
  // collect where nylon rubs cloth.
  B.occlude([-0.085, 1.42, 0.06], [-0.085, 1.42, -0.06], 0.048, 1.0);
  B.occlude([0.085, 1.42, 0.06], [0.085, 1.42, -0.06], 0.048, 1.0);
  B.occlude([-0.13, 1.40, 0.055], [0.10, 1.10, 0.115], 0.032, 0.9); // sling diagonal
  B.occlude([-0.02, 1.02, 0.10], [-0.02, 1.02, -0.10], 0.10, 0.6); // carrier hem
  // cuffs, elbows and knees: the three places a uniform is always ground in
  B.occlude(wrR, [wrR[0], wrR[1] + 0.05, wrR[2]], 0.044, 0.9);
  B.occlude(wrL, [wrL[0], wrL[1] + 0.05, wrL[2]], 0.044, 0.9);
  B.occlude(elR, [elR[0], elR[1] - 0.02, elR[2] - 0.01], 0.052, 0.8);
  B.occlude(elL, [elL[0], elL[1] - 0.02, elL[2] - 0.01], 0.052, 0.8);
  B.occlude(knR, [knR[0], knR[1] - 0.03, knR[2] + 0.01], 0.072, 0.8);
  B.occlude(knL, [knL[0], knL[1] - 0.03, knL[2] + 0.01], 0.072, 0.8);
  B.occlude([anR[0], anR[1] + 0.09, anR[2]], [anR[0], anR[1] + 0.15, anR[2]], 0.062, 0.8);
  B.occlude([anL[0], anL[1] + 0.09, anL[2]], [anL[0], anL[1] + 0.15, anL[2]], 0.062, 0.8);
  B.occlude(GRIP_R, [GRIP_R[0] + BORE_DIR[0] * 0.4, GRIP_R[1] + BORE_DIR[1] * 0.4 + 0.09, GRIP_R[2] + BORE_DIR[2] * 0.4], 0.045, 0.6);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.078;
    B.occlude([x, 1.20, 0.160], [x, 1.28, 0.164], 0.040, 0.8); // mag pouches
  }

  /* ---------------- uniform ------------------------------------------ */
  B.add(P.jacketTorso(nz, { bulk: V.bulk }), {
    material: 'cloth',
    bones: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'ClavicleR', 'ClavicleL', 'UpperArmR', 'UpperArmL'],
    bias: [1, 1, 1, 1, 0.8, 0.55, 0.55, 0.30, 0.30],
    colour: uniform([1, 1, 1]),
    grime: 0.85,
    dirt: 0.20,
    dust: 0.34,
    wear: 0.08,
    name: 'jacket',
  });
  B.add(P.pelvis(nz), {
    material: 'cloth',
    bones: ['Hips', 'Spine', 'UpLegR', 'UpLegL'],
    bias: [1, 0.7, 0.5, 0.5],
    colour: uniform([0.97, 0.97, 0.97]),
    grime: 0.9,
    dirt: 0.35,
    dust: 0.2,
    name: 'pelvis',
  });
  B.add(P.collar(nz), {
    material: 'cloth',
    bones: ['Neck', 'Spine2', 'Head'],
    bias: [1, 0.8, 0.3],
    colour: uniform([0.92, 0.92, 0.91]),
    grime: 1.0,
    dust: 0.3,
    name: 'collar',
  });

  // sleeves
  for (const [sh, el, wr, side, suffix] of [
    [shR, elR, wrR, -1, 'R'],
    [shL, elL, wrL, 1, 'L'],
  ]) {
    // deltoid cap. The sleeve tube alone meets the torso in a socket, which is
    // half of the "tube arms" read; this gives the shoulder an actual shape and
    // a highlight to catch the key light on.
    B.add(P.shoulderCap(nz, sh, side), {
      // Shoulder flash, not uniform cloth. See TEAM_MARKER_GAIN.
      material: 'team',
      bones: [`Clavicle${suffix}`, `UpperArm${suffix}`, 'Spine2'],
      bias: [0.8, 1, 0.4],
      colour: [1, 1, 1],
      grime: 0.7,
      dust: 0.5,
      wear: 0.06,
      name: `shoulder${suffix}`,
    });
    B.add(
      P.limbTube(nz, [sh[0] + side * 0.012, sh[1] + 0.055, sh[2]], el, wr,
        [0.050, 0.062, 0.056, 0.050, 0.046, 0.042, 0.038], {
        rings: 22,
        seg: 16,
        fold: 0.0016,
        // 3 mm creases: at 35 m that is sub-pixel as displacement but the normals
        // it generates are what put light and shade *inside* the sleeve outline.
        crease: 0.0030,
        bend: [0, 0, -1], // sleeve bunches inside the elbow
      }),
      {
        material: 'cloth',
        bones: [`Clavicle${suffix}`, `UpperArm${suffix}`, `Forearm${suffix}`, `Hand${suffix}`, 'Spine2'],
        bias: [0.5, 1, 1, 0.7, 0.25],
        colour: uniform([1, 1, 1]),
        grime: 0.8,
        dirt: 0.15,
        dust: 0.3,
        wear: 0.12,
        name: `sleeve${suffix}`,
      }
    );
    // elbow reinforcement patch
    B.add(
      P.limbTube(
        nz,
        [el[0] * 0.98 + sh[0] * 0.02, el[1] + 0.05, el[2] - 0.005],
        el,
        [el[0] * 0.98 + wr[0] * 0.02, el[1] - 0.05, el[2] + 0.004],
        [0.050, 0.054, 0.050],
        { rings: 5, seg: 14, fold: 0.001 }
      ),
      {
        material: 'gear',
        bones: [`UpperArm${suffix}`, `Forearm${suffix}`],
        bias: [1, 1],
        colour: GEAR.pad,
        grime: 1.0,
        dirt: 0.25,
        dust: 0.22,
        wear: 0.16,
        name: `elbowPad${suffix}`,
      }
    );
  }

  // trousers
  for (const [hip, kn, an, suffix] of [
    [hipR, knR, anR, 'R'],
    [hipL, knL, anL, 'L'],
  ]) {
    B.add(
      P.limbTube(nz, hip, kn, [an[0], an[1] + 0.085, an[2] + 0.008],
        [0.090, 0.085, 0.076, 0.068, 0.062, 0.060, 0.064], {
        rings: 24,
        seg: 17,
        fold: 0.0018,
        // trousers crease harder than sleeves and stack on the boot cuff
        crease: 0.0042,
        bend: [0, 0, -1], // gathers behind the knee
      }),
      {
        material: 'cloth',
        bones: ['Hips', `UpLeg${suffix}`, `Leg${suffix}`, `Foot${suffix}`],
        bias: [0.6, 1, 1, 0.5],
        colour: uniform([0.98, 0.98, 0.97]),
        grime: 0.8,
        dirt: 0.72,
        dust: 0.22,
        wear: 0.10,
        name: `leg${suffix}`,
      }
    );
    // cargo pocket on the outer thigh
    const side = suffix === 'R' ? -1 : 1;
    B.add(
      P.pouch(nz, {
        hx: 0.052, hy: 0.070, hz: 0.026,
        x: hip[0] + side * 0.062, y: hip[1] - 0.16, z: 0.026,
        rz: side * 0.06, ry: side * 0.55, bend: 0.11,
      }),
      {
        material: 'cloth',
        bones: [`UpLeg${suffix}`, 'Hips'],
        bias: [1, 0.4],
        colour: uniform([0.95, 0.95, 0.94]),
        grime: 0.9,
        dirt: 0.5,
        dust: 0.4,
        wear: 0.16,
        name: `cargo${suffix}`,
      }
    );
    if (V.kneePads) {
      B.add(P.kneePad(nz, kn, side), {
        material: 'gear',
        bones: [`Leg${suffix}`, `UpLeg${suffix}`],
        bias: [1, 0.5],
        colour: GEAR.pad,
        grime: 1.0,
        dirt: 0.9,
        dust: 0.28,
        wear: 0.20,
        name: `knee${suffix}`,
      });
    }
    // boots
    B.add(P.boot(nz, an, side), {
      material: 'boot',
      bones: [`Leg${suffix}`, `Foot${suffix}`, `Toe${suffix}`],
      bias: [0.55, 1, 0.6],
      colour: GEAR.boot,
      grime: 0.9,
      dirt: 0.85,
      dust: 0.5,
      wear: 0.3,
      name: `boot${suffix}`,
    });
    B.add(P.bootSole(an), {
      material: 'rubber',
      bones: [`Foot${suffix}`, `Toe${suffix}`],
      bias: [1, 0.8],
      grime: 0.9,
      dirt: 1.0,
      name: `sole${suffix}`,
    });
    B.add(P.bootLaces(an), {
      material: 'boot',
      bone: `Foot${suffix}`,
      colour: GEAR.lace,
      grime: 0.9,
      dirt: 0.85,
      name: `laces${suffix}`,
    });
  }

  /* ---------------- load-bearing gear -------------------------------- */
  B.add(P.plateCarrier(nz, V), {
    material: 'plate',
    bones: ['Spine', 'Spine1', 'Spine2', 'ClavicleR', 'ClavicleL'],
    bias: [0.7, 1, 1, 0.45, 0.45],
    // The team surface. See TEAM_ACCENT_STRENGTH — with no accent this is the
    // original neutral grey, so `irregular` (which belongs to no team) is
    // untouched.
    colour: carrierTint([0.72, 0.72, 0.72]),
    grime: 0.85,
    dirt: 0.3,
    dust: 0.30,
    wear: 0.18,
    name: 'carrier',
  });
  B.add(P.carrierWebbing(), {
    material: 'gear',
    bones: ['Spine1', 'Spine2'],
    bias: [1, 1],
    colour: GEAR.webbing,
    grime: 1.0,
    dust: 0.3,
    wear: 0.26,
    name: 'webbing',
  });

  // magazine pouches across the front, deliberately not evenly loaded
  const nPouch = V.fullCarrier ? 3 : 2;
  for (let i = 0; i < nPouch; i++) {
    const t = nPouch === 1 ? 0.5 : i / (nPouch - 1);
    const x = (t - 0.5) * (nPouch > 2 ? 0.156 : 0.09);
    B.add(
      P.pouch(nz, {
        hx: 0.033, hy: 0.056, hz: 0.034,
        x, y: 1.236 + rng.range(-0.006, 0.006), z: 0.148,
        rx: -0.10, rz: rng.range(-0.05, 0.05),
        lidTilt: i === 1 ? -0.5 : 0,
        bend: 0.26,
      }),
      {
        material: 'gear',
        bones: ['Spine1', 'Spine2', 'Spine'],
        bias: [1, 0.8, 0.4],
        colour: i === 1 ? GEAR.pouchAlt : GEAR.pouch,
        grime: 0.9,
        dirt: 0.25,
        dust: 0.5,
        wear: 0.30,
        name: `magPouch${i}`,
      }
    );
    // a magazine sticking out of the open pouch
    if (i === 1) {
      const mag = P.pouch(nz, {
        hx: 0.0145, hy: 0.042, hz: 0.023,
        x, y: 1.308, z: 0.152, rx: -0.12,
      });
      B.add(mag, {
        material: 'polymer',
        bones: ['Spine1', 'Spine2'],
        bias: [1, 0.8],
        grime: 0.4,
        wear: 0.2,
        name: 'spareMag',
      });
    }
  }

  // radio on the left chest, admin pouch on the right, IFAK on the belt
  B.add(
    P.pouch(nz, {
      hx: 0.032, hy: 0.058, hz: 0.028,
      x: 0.112, y: 1.336, z: 0.118, ry: 0.35, rz: 0.10, bend: 0.24,
    }),
    {
      material: 'gear',
      bones: ['Spine2', 'ClavicleL', 'Spine1'],
      bias: [1, 0.5, 0.5],
      colour: GEAR.pouchAlt,
      grime: 0.9,
      dust: 0.5,
      wear: 0.22,
      name: 'radio',
    }
  );
  // antenna
  {
    const ant = P.pouch(nz, { hx: 0.005, hy: 0.075, hz: 0.005, x: 0.116, y: 1.424, z: 0.104, rx: -0.18 });
    B.add(ant, {
      material: 'polymer',
      bones: ['Spine2', 'ClavicleL'],
      bias: [1, 0.6],
      grime: 0.3,
      name: 'antenna',
    });
  }
  B.add(P.belt(nz), {
    material: 'gear',
    bones: ['Hips', 'Spine'],
    bias: [1, 0.5],
    colour: GEAR.belt,
    grime: 1.0,
    dirt: 0.4,
    dust: 0.25,
    wear: 0.26,
    name: 'belt',
  });
  B.add(P.hipPouch(nz, -1), {
    material: 'gear',
    bones: ['Hips', 'Spine'],
    bias: [1, 0.4],
    colour: GEAR.dump,
    grime: 0.95,
    dirt: 0.6,
    dust: 0.45,
    wear: 0.26,
    name: 'dumpPouch',
  });

  /* ---------------- head --------------------------------------------- */
  const wrapped = V.faceWrap;
  B.add(P.headMesh(nz, head, {}), {
    material: 'skin',
    bone: 'Head',
    colour: [1, 1, 1],
    grime: 0.3,
    dirt: 0.06,
    name: 'head',
  });
  B.add(P.nose(nz, head), { material: 'skin', bone: 'Head', grime: 0.25, name: 'nose' });
  B.add(P.ear(nz, head, -1), { material: 'skin', bone: 'Head', grime: 0.45, name: 'earR' });
  B.add(P.ear(nz, head, 1), { material: 'skin', bone: 'Head', grime: 0.45, name: 'earL' });
  for (const side of [-1, 1]) {
    B.add(P.eyeball(head, side), {
      material: 'polymer',
      bone: 'Head',
      colour: [0.55, 0.5, 0.45],
      grime: 0.2,
      name: 'eye',
    });
  }
  // neck
  B.add(
    P.limbTube(nz, [head[0], head[1] - 0.10, head[2] - 0.012], [head[0], head[1] - 0.05, head[2] - 0.008], [head[0], head[1], head[2]],
      [0.058, 0.056, 0.054], { rings: 5, seg: 14, fold: 0.001 }),
    {
      material: 'skin',
      bones: ['Neck', 'Head', 'Spine2'],
      bias: [1, 0.7, 0.4],
      grime: 0.5,
      name: 'neck',
    }
  );

  if (wrapped) {
    // A hard ballistic mask is moulded polymer on the *same* geometry: the seam
    // and the bridge fold read as the mask's edge and nose vent instead of a
    // cloth hem, and it lands far darker than any cloth in the kit, which is
    // what gives that variant a legible face at range.
    B.add(P.faceWrap(nz, head, V), {
      material: V.maskHard ? 'polymer' : 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.5],
      colour: V.maskHard ? GEAR.mask : V.helmet ? GEAR.wrap : [0.78, 0.74, 0.66],
      grime: V.maskHard ? 0.5 : 0.85,
      dirt: V.maskHard ? 0.1 : 0.2,
      dust: V.maskHard ? 0.2 : 0.3,
      wear: V.maskHard ? 0.3 : 0.1,
      name: 'faceWrap',
    });
  }

  if (V.helmet) {
    // A covered helmet is CLOTH, not plastic: the camo cover is the single
    // biggest reason a helmet reads as a helmet rather than a bowling ball. Its
    // tint deliberately lands off the uniform value so the head separates from
    // the torso at range. A bare shell goes on the laminate set instead.
    B.add(P.helmet(nz, head, V), {
      // Painted team shell, rather than the variant's own cover or plate. See
      // TEAM_MARKER_GAIN: this is the single most visible surface on a man who
      // is behind cover, and it is never occluded by his own weapon.
      material: 'team',
      bone: 'Head',
      colour: V.helmetTint ?? [1, 1, 1],
      grime: 0.6,
      dirt: 0.2,
      dust: 0.55,
      wear: 0.4,
      name: 'helmet',
    });
    B.add(P.helmetHardware(nz, head), {
      material: 'polymer',
      bone: 'Head',
      grime: 0.5,
      wear: 0.3,
      name: 'helmetHW',
    });
    B.add(P.chinStrap(head), {
      material: 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.4],
      colour: GEAR.strap,
      grime: 0.95,
      dust: 0.25,
      wear: 0.18,
      name: 'chinStrap',
    });
    if (V.goggles) {
      const g = P.goggles(head, V.gogglesDown);
      B.add(g.frame, { material: 'polymer', bone: 'Head', grime: 0.4, wear: 0.35, name: 'goggleFrame' });
      B.add(g.strap, {
        material: 'gear',
        bone: 'Head',
        colour: GEAR.strap,
        grime: 0.85,
        dust: 0.3,
        name: 'goggleStrap',
      });
      B.add(P.goggleLens(head, V.gogglesDown), {
        material: 'glass',
        bone: 'Head',
        colour: [1, 1, 1],
        grime: 0.15,
        name: 'goggleLens',
      });
    }
  } else if (V.headWrap) {
    const wrap = P.headScarf(nz, head);
    B.add(wrap, {
      // hue comes from the variant's cloth tint; the VALUE sits below the uniform
      // so the head is never the brightest thing on the figure
      material: 'cloth',
      bone: 'Head',
      colour: [0.82, 0.80, 0.76],
      grime: 0.8,
      dirt: 0.25,
      dust: 0.4,
      wear: 0.14,
      name: 'shemagh',
    });
  }

  if (V.shades) {
    const s = P.sunglasses(head);
    B.add(s.frame, { material: 'polymer', bone: 'Head', grime: 0.4, wear: 0.3, name: 'shadeFrame' });
    B.add(s.lens, {
      material: 'glass',
      bone: 'Head',
      colour: [1, 1, 1],
      grime: 0.2,
      name: 'shadeLens',
    });
  }

  /* ---------------- hands + weapon ----------------------------------- */
  const bore = new THREE.Vector3(...BORE_DIR).normalize();
  const palmR = new THREE.Vector3(-0.55, 0.35, -0.75).normalize();
  const palmL = new THREE.Vector3(0.75, 0.30, -0.60).normalize();
  const gripAxisR = new THREE.Vector3(0.18, 0.92, -0.34).normalize(); // down the grip
  const gripAxisL = bore.clone();

  B.add(P.glove(nz, wrR, [gripAxisR.x, gripAxisR.y, gripAxisR.z], [palmR.x, palmR.y, palmR.z], -1), {
    material: 'boot',
    bones: ['HandR', 'ForearmR'],
    bias: [1, 0.35],
    colour: GEAR.glove,
    grime: 0.9,
    dirt: 0.3,
    dust: 0.25,
    wear: 0.28,
    name: 'gloveR',
  });
  B.add(P.knuckleGuard(wrR, [gripAxisR.x, gripAxisR.y, gripAxisR.z], [palmR.x, palmR.y, palmR.z]), {
    material: 'polymer',
    bone: 'HandR',
    grime: 0.5,
    wear: 0.35,
    name: 'knuckleR',
  });
  B.add(P.glove(nz, wrL, [gripAxisL.x, gripAxisL.y, gripAxisL.z], [palmL.x, palmL.y, palmL.z], 1), {
    material: 'boot',
    bones: ['HandL', 'ForearmL'],
    bias: [1, 0.35],
    colour: GEAR.glove,
    grime: 0.9,
    dirt: 0.3,
    dust: 0.25,
    wear: 0.28,
    name: 'gloveL',
  });
  B.add(P.knuckleGuard(wrL, [gripAxisL.x, gripAxisL.y, gripAxisL.z], [palmL.x, palmL.y, palmL.z]), {
    material: 'polymer',
    bone: 'HandL',
    grime: 0.5,
    wear: 0.35,
    name: 'knuckleL',
  });

  const W = buildWeapon(nz, V.weapon, rng);
  B.add(W.steel, { material: 'steel', bone: 'HandR', grime: 0.55, wear: 0.25, name: 'wpnSteel' });
  B.add(W.polymer, { material: 'polymer', bone: 'HandR', grime: 0.5, wear: 0.3, name: 'wpnPoly' });
  B.add(W.rubber, { material: 'rubber', bone: 'HandR', grime: 0.6, name: 'wpnRubber' });
  if (W.glass.p.length) {
    B.add(W.glass, { material: 'glass', bone: 'HandR', grime: 0.1, name: 'wpnGlass' });
  }

  // sling: body-bound so it stays on the chest as the arms move
  B.add(P.sling(W.foregrip, W.stockTop), {
    material: 'gear',
    bones: ['Spine2', 'Spine1', 'ClavicleR', 'ClavicleL', 'Hips'],
    bias: [1, 0.8, 0.5, 0.5, 0.3],
    colour: GEAR.sling,
    grime: 1.0,
    dust: 0.2,
    wear: 0.22,
    name: 'sling',
  });

  const built = B.build();
  // Guard the prewarm contract: see MATERIAL_SLOTS.
  if (built.materialNames.join() !== MATERIAL_SLOTS.filter((s) => built.materialNames.includes(s)).join()) {
    console.warn(
      `[ai] material slot order changed (${built.materialNames.join()}); ` +
        'update MATERIAL_SLOTS or prewarmMaterials will reorder opaque draws'
    );
  }
  const mats = resolveMaterials(name, built.materialNames, materials, accent);

  return {
    geometry: built.geometry,
    materials: mats,
    parts: built.parts,
    weapon: W,
    stats: { vertices: built.vertices, triangles: built.triangles },
    variant: V,
  };
}

/**
 * Every material slot a soldier's geometry is grouped by, IN THE ORDER
 * `CharacterBuilder.build()` emits them — which is the order the parts are added
 * above, deduplicated. All three variants use all nine.
 *
 * THE ORDER IS LOad-BEARING, and this is not a style preference. `THREE.Material`
 * hands out globally incrementing ids and three sorts the opaque render list by
 * `material.id` (`painterSortStable`), including the nine groups *within* one
 * soldier. Create them in a different order and the goggle lens draws before its
 * frame instead of after it; with a depth prepass in front, whichever coplanar
 * surface is drawn last wins the equal-depth test. MEASURED: prewarming these in
 * a hand-written order moved 2 pixels of the `combat` shot by 1/255 and failed
 * the pixel gate. `buildSoldier` asserts the order below still matches.
 */
export const MATERIAL_SLOTS = Object.freeze([
  'cloth', 'gear', 'boot', 'rubber', 'plate', 'polymer', 'skin', 'glass', 'steel', 'team',
]);

/**
 * Resolve a variant's material slot names to real materials.
 *
 * Split out of `buildSoldier` on purpose: `AiSystem.prewarmMaterials()` needs
 * every material a variant will ever ask for so their shader programs can be
 * compiled while a loading screen is up, and it must be able to get them WITHOUT
 * building a single triangle (geometry construction draws from the shared RNG
 * stream, so doing it early would move every downstream random draw and change
 * the picture). `SoldierMaterials.get()` is a pure function of its key and opts,
 * so calling it early is free of side effects.
 *
 * `detail` is the second half of the two-scale system: the base tile carries the
 * macro camo and the garment seams, this tile carries the weave and the webbing
 * ribbing. `scale` converts the base tile's UVs (metres / tile) into the detail
 * tile's, so the physical size of a thread is identical on a sleeve, a pouch and
 * a boot without any per-part tuning.
 */
export function resolveMaterials(name, slots, materials, accent = null) {
  const V = VARIANTS[name] ?? VARIANTS.vanguard;
  const named = (m, n) => { m.name = n; return m; };
  const detail = (set, matName, normal, rough) => ({
    set,
    scale: MATERIALS[matName].tile / DETAIL_TILE,
    normal,
    rough,
  });
  return slots.map((n) => {
    switch (n) {
      case 'cloth':
        return materials.get(`camo_${V.camo}`, {
          key: name,
          tint: V.clothTint,
          rough: ROUGH.cloth,
          metal: 1,
          // 1.15, not 1.0: the base tile now carries a 1-2 cm crease field and
          // the folds have to actually catch the key light at 25 m.
          normalScale: 1.15,
          detail: detail('cloth', 'cloth', 0.45, 0.16),
        });
      case 'plate':
        return materials.get('plate', {
          key: name,
          tint: V.plateTint,
          rough: ROUGH.plate,
          normalScale: 1.0,
          detail: detail('nylon', 'plate', 0.45, 0.10),
        });
      case 'team':
        // The one surface allowed off the albedo budget, and the only one whose
        // brightness comes from the MATERIAL rather than the vertex tint —
        // `geo.js` runs every baked vertex colour through `clamp01`, so a tint
        // above 1 is silently truncated and buys nothing. A material colour is a
        // plain uniform, so this is where a value gain can actually live.
        //
        // Roughness 1.0 and metalness 0, deliberately the most matte surface on
        // the character: a specular lobe is white, and white is what dilutes the
        // mark. At the plate's 0.55 the dome carried a broad highlight that cost
        // measurable chroma. This is flat paint, not laminate.
        return named(
          materials.get('nylon', {
            key: `${name}_team`,
            tint: teamMarkerTint(accent),
            rough: 1.0,
            metal: 0,
            normalScale: 0.9,
            detail: detail('nylon', 'gear', 0.5, 0.14),
          }),
          // Named so `tools/friendfoe.mjs` can find it in the mesh's material
          // array and hide exactly this group for one pass. That is how the gate
          // locates the mark: by material identity, which is independent of both
          // the pose and the colour under test.
          'ai_team'
        );
      case 'gear':
        return materials.get('nylon', {
          key: name,
          tint: V.gearTint,
          normalScale: 1.1,
          detail: detail('nylon', 'gear', 0.5, 0.14),
        });
      case 'boot':
        return materials.get('nylon', {
          key: `${name}_boot`,
          tint: V.gearTint,
          rough: ROUGH.boot,
          normalScale: 1.1,
          detail: detail('nylon', 'boot', 0.5, 0.10),
        });
      case 'skin':
        return materials.get('skin', { key: name, tint: V.skinTint, normalScale: 0.8, ao: 0.6 });
      case 'polymer':
        return materials.get('polymer', { key: name, normalScale: 1.0 });
      case 'steel':
        return materials.get('steel', { key: name, normalScale: 1.0 });
      case 'rubber':
        return materials.get('rubber', { key: name, normalScale: 1.2 });
      case 'glass':
        return materials.glass();
      default:
        return materials.get('polymer', { key: name });
    }
  });
}
