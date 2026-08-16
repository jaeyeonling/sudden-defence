import { CLOTH_TILE } from './textures.js';

/**
 * Soldier palette — the tuned vocabulary every variant is assembled from:
 * texture tiling, roughness trims, the gear albedo budget, the team tints, and
 * the variant table itself.
 *
 * Split out of `soldier.js` because it is what both consumers share:
 * `buildSoldier` reads the gear and accent values while `resolveMaterials`
 * reads the tiling and roughness, and neither needs the other. Nothing here
 * touches THREE or the part library.
 */

/**
 * Metres of surface per texture tile. `cloth` is deliberately large: it is the
 * tile that has to carry the 0.2-0.4 m camo macro blotches, and the 1.5 mm weave
 * it can no longer resolve is supplied by the shader detail layer instead.
 */
export const MATERIALS = {
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
export const ROUGH = { cloth: 0.85 / 0.905, plate: 0.55 / 0.62, boot: 0.7 / 0.79 };

/** Detail tile size in metres — must match `bakeDetail` in textures.js. */
export const DETAIL_TILE = 0.05;

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
export const GEAR = {
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
export const TEAM_ACCENT_STRENGTH = { carrier: 0.85, cloth: 0.45 };

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
export function accentTint(base, accent, strength) {
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
export const TEAM_MARKER_GAIN = 5.5;

/**
 * Material tint for the `team` slot: the accent normalised to unit mean, then
 * scaled by the gain. Unit-mean first so both teams get the same VALUE and
 * differ only in hue — a brighter side would be an easier target.
 *
 * No accent (the teamless `irregular`) falls back to the neutral kit grey the
 * parts wore before the slot existed.
 */
export function teamMarkerTint(accent) {
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
