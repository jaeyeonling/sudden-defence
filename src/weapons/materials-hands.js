import { BASE, c } from './materials-base.js';

/**
 * Arm surfaces — glove shell, knuckle pads, stitching, sleeve.
 *
 * Split from the weapon table because they are not weapon surfaces: they are
 * built by `hands.js` and the whole point of their tuning is to STOP reading as
 * part of the gun. The note on `glove` below is the measurement that forced
 * them apart — same luminance and near enough the same hue as the receiver, and
 * the hand read as "another anodised part of the weapon".
 *
 * Spread into `WEAPON_MATERIALS` last, in this order, so `Object.keys` is
 * unchanged by the split.
 */
export const HAND_MATERIALS = {
  /**
   * Glove shell: warm dark nomex / goat-leather palm with a visible weave.
   *
   * THE HAND MUST NOT BE THE SAME COLOUR AS THE GUN. Measured on the r3 frames,
   * the glove fingers sampled rgb(101,95,91) — 0.127 linear with B-R = -10 —
   * against a receiver at 0.121 linear, B-R = -7. Same value, near enough the
   * same hue, and the whole hand read as another anodised part of the weapon:
   * "robot armour", "a stack of grey slabs".
   *
   * What separates a hand from a rifle is HUE, not value. The gun is a cool
   * blue-black dielectric (B-R around 0 to -7, deliberately, see `alu`); nomex
   * and leather are warm browns. So the shell tint goes from a cool
   * c(0.30,0.293,0.32) — bluer than it was red — to c(0.30,0.245,0.20), which is
   * a 1.5:1 red-over-blue ratio, and the baked weave tints follow it out of grey
   * into brown. Targets, measured on screen:
   *   fingers 0.35-0.55 stop ABOVE the receiver in luminance
   *   fingers 14-26 code values WARMER (B-R -14..-26 while the gun stays -2..+4)
   * Dropping blue is what does both at once: it warms the hue and takes ~0.15
   * stop off the luminance, which is the direction we want anyway because the
   * receiver got darker when its wear layer came down.
   */
  glove: [
    'fabric',
    {
      ...BASE,
      // Warm the baked weave as well as the tint: a cool-grey base modulated by
      // a warm tint still reads grey wherever the weave is light.
      bake: { seed: 401, tintA: 0x453a30, tintB: 0x2a2320, size: 512 },
      scale: 0.032,
      /**
       * MEASURED WITH A LIVE UNIFORM SWEEP, and this is the single most important
       * number on the viewmodel.
       *
       * The glove and the sleeve were the only two surfaces on the rig that had
       * never been through the viewmodel's exposure calibration. The rest of the
       * gun had: `alu` sits at 0.003 linear, ten times under physical anodising,
       * because the viewmodel light rig (render/index.js `viewKeyScale`, plus the
       * patcher's two-band fill) delivers roughly 20x the irradiance per unit
       * albedo that the world does. Every gun material was quietly crushed to
       * compensate; the arms were not.
       *
       * What that cost, measured by driving `owTintCol` live and reading the
       * framebuffer back on the `weapon` shot:
       *   albedo x1     sleeve rgb(206,188,161)
       *   albedo x0.25  sleeve rgb(191,174,145)
       *   albedo x0.06  sleeve rgb(185,168,139)
       *   albedo x0     sleeve rgb(182,165,136)   <- still cream!
       * i.e. the arm was 4+ stops over and sitting flat on the AgX shoulder,
       * where NOTHING it is made of can be seen. That is the whole content of
       * "a huge untextured tan tube": not a missing texture, an unreadable
       * exposure. It also made the arm the brightest opaque object in the frame
       * (L=191 against sunlit concrete at 126 and shaded plaster at 75), which
       * is why it read as bandage rather than as coyote ripstop.
       *
       * 0.30 -> 0.115 takes the shell to ~0.0051/0.0037/0.0028 linear off the
       * baked weave. That is deliberately in the same family as `alu` (0.0032)
       * and `polymer` (0.0027) — one third of a stop ABOVE the receiver, which is
       * the target the old comment set and never hit, because it was set against
       * a tint that the exposure was swallowing whole.
       *
       * The RATIO is untouched: 0.115/0.094/0.077 is the same 1.5:1 red-over-blue
       * the warm retint established, so the hue separation from the cool gun
       * survives intact.
       */
      /* MEASURED AGAIN after the first pass: 0.115 put the glove at L=45-70 against
       * a sleeve at L=100-120, i.e. 1.3 stops apart, and the hand disappeared into
       * the gun instead of separating from it. A glove and a combat shirt are the
       * same kit at the same wash; 0.19 lands the shell ~0.35 stop under the
       * sleeve, which is the interval the original note asked for. */
      tint: c(0.19, 0.155, 0.127),
      // 0.9+ is non-negotiable: a glove has no gloss lobe at all. The floor
      // stops the fabric ORM dipping into anything that could catch a highlight.
      roughness: [0.92, 0.06, 0.78],
      normalStrength: 1.35,
      // ~1.5 mm weave at this scale, at full albedo/roughness amplitude. With the
      // exposure fixed this is finally visible; at the old amplitude (0.35 albedo)
      // over a blown-out shell it was not.
      detail: [12, 0.85, 0.62, 6],
      /**
       * The wear and grime layers are NOT scaled by `tint`, so they have to be
       * tuned with it. They now also actually DO something: until this pass the
       * glove geometry carried no `color` attribute at all, so vColor was (0,0,0)
       * and every one of these numbers was dead (see Arm.bakeSurfaceMasks).
       */
      wear: [0.34, 0.85, 0.75, 0],
      // Polished leather, not bare metal — the shine on a used glove is where
      // the dye has rubbed off, and that is a darker, warmer BROWN.
      wearColor: 0x2a2118,
      wearMaterial: [0.72, 0.0, 0, 0.4],
      grimeColor: 0x080604,
      /**
       * SHEEN IS A SPECULAR TERM AND IT IS NOT SCALED BY ALBEDO.
       *
       * At 0.28 with a cream sheenColor it was carrying the glove on its own: with
       * the albedo driven to zero the hand still rendered rgb(182,165,136). A
       * retro-reflective cloth lobe is a real thing, but at this rig's light level
       * 0.28 of it is a white veil over the whole hand. 0.07 with a dark brown
       * sheenColor is a faint bloom on the high spots, which is all it should be.
       *
       * `specularIntensity` needs `physical: true` to exist at all. Leather's
       * specular reflectance is ~0.02, not glass's 0.04, so 0.45 is the honest
       * number — and it takes another quarter stop off the flat grazing sheet that
       * made the back of the hand read as armour plate.
       */
      three: {
        physical: true,
        sheen: 0.07,
        sheenRoughness: 0.96,
        sheenColor: 0x201812,
        // 0.45 -> 0.16 with the rest of the viewmodel (see `alu`). Leather's
        // specular reflectance is ~0.02; at 0.04 the back of a gloved hand is a
        // flat Fresnel sheet, which is the "robot armour" read in one number.
        specularIntensity: 0.16,
      },
      // A glove is not an awning: `fabric` ships a 0.20 sun-transmission term
      // (for canvas canopies) that the library merge was handing to the hand.
      cloth: [0, 1, 0, 0],
    },
  ],

  /** Reinforced palm / knuckle pads — rubberised, scuffed. */
  glove_pad: [
    'rubber',
    {
      ...BASE,
      bake: { seed: 307 },
      scale: 0.024,
      // Warm, and a stop under the shell so the pads read as a separate material
      // rather than as bolted-on plate. Recalibrated with the shell (see `glove`):
      // 0.20 -> 0.072 lands the TPR at ~0.0024 linear, half a stop under the
      // glove's 0.0051 — the same interval as before, at a readable exposure.
      tint: c(0.118, 0.095, 0.08),
      roughness: [1.0, 0.0, 0.78],
      /**
       * 1.3 -> 0.7. At 1.3 the rubber surface's own relief was deep enough that
       * every knuckle cap picked up a hard specular break across its middle, and
       * four caps each cut in half is eight facets on the back of one hand: that
       * is the "stack of slabs" read as much as the cap geometry is. A moulded
       * TPR pad is a soft, slightly pebbled surface, not a machined one.
       */
      normalStrength: 0.7,
      detail: [9, 0.95, 0.6, 5],
      wear: [0.4, 0.75, 0.65, 0],
      wearColor: 0x241c14,
      wearMaterial: [0.78, 0.0, 0, 0.35],
      grimeColor: 0x070504,
      // Moulded TPR is a low-reflectance elastomer, not glass. Same reason as
      // `glove`: the flat 0.04 dielectric lobe on four knuckle caps facing the
      // key is the "robot armour" read.
      three: { physical: true, specularIntensity: 0.15 },
    },
  ],

  /**
   * Stitched seam down the outboard side of each finger.
   *
   * At 40 px across the whole hand the four fingers merge into one paddle: the
   * only thing that survives is a light line where the panels are sewn. It is
   * the same leather as the shell at 1.4x the albedo (a seam is a doubled,
   * proud, dye-worn edge), and it is a separate material rather than a vertex
   * colour so it also picks up its own normal and roughness.
   */
  glove_seam: [
    'fabric',
    {
      ...BASE,
      bake: { seed: 401, tintA: 0x453a30, tintB: 0x2a2320, size: 512 },
      scale: 0.02,
      // 1.85x the recalibrated shell (0.115): a seam is a doubled, proud,
      // dye-worn edge, and at 1-3 px wide it needs more separation than 1.4x to
      // survive the AA filter. Same warm ratio as the shell.
      tint: c(0.35, 0.286, 0.234),
      roughness: [0.9, 0.06, 0.74],
      normalStrength: 1.0,
      detail: [24, 0.6, 0.45, 5],
      wear: [0.5, 0.8, 0.7, 0],
      wearColor: 0x3a2d20,
      wearMaterial: [0.7, 0.0, 0, 0.4],
      grimeColor: 0x0a0806,
      three: {
        physical: true,
        sheen: 0.08,
        sheenRoughness: 0.94,
        sheenColor: 0x2a2018,
        specularIntensity: 0.16,
      },
      cloth: [0, 1, 0, 0],
    },
  ],

  /**
   * Combat-shirt sleeve: coyote ripstop, dusty.
   *
   * THE SINGLE WORST SURFACE IN THE BUILD before this pass — see the long note
   * on `glove` for the measurement. The support forearm crosses the lower third
   * of every hipfire frame, and at L=191 it was the brightest opaque thing on
   * screen, 4 stops over, flat on the tone curve's shoulder, and therefore
   * completely without texture whatever its maps said.
   */
  sleeve: [
    'fabric',
    {
      ...BASE,
      bake: { seed: 503, tintA: 0x6e6047, tintB: 0x4c4231, size: 512 },
      // 0.09 -> 0.05: a 50 mm ripstop tile. At 0.09 the base weave was 2.2 px at
      // the distance the support forearm actually sits (0.38-0.5 m) and read as
      // one flat value; the detail layer below carries the thread, this carries
      // the panel-to-panel variation.
      scale: 0.05,
      /**
       * 0.42 -> 0.16, i.e. ~0.020/0.015/0.008 linear off the baked coyote weave.
       * A real sun-bleached coyote ripstop is 0.16-0.20 linear, so this is the
       * same 10x crush the whole gun carries (see `alu`) and lands the sleeve
       * 2/3 of a stop ABOVE the glove, which is right: the shirt is a lighter
       * garment than the gloves and it is the thing that should read as the
       * warmest object on the rig.
       */
      tint: c(0.16, 0.152, 0.138),
      roughness: [0.95, 0.05, 0.8],
      normalStrength: 1.45,
      // ~6 mm ripstop grid at this tile, at full amplitude on both albedo and
      // roughness. Roughness detail matters more than albedo detail here: the
      // viewmodel rig is specular-dominant, so breaking the lobe up is what makes
      // a surface look woven.
      detail: [9, 0.95, 0.7, 6],
      wear: [0.5, 0.9, 0.75, 0],
      // Dust on the fold crowns, not bare white canvas.
      wearColor: 0x4a4034,
      wearMaterial: [0.9, 0.0, 0, 0.45],
      grimeColor: 0x0c0a06,
      /**
       * Sheen 0.45 -> 0.09 and the sheenColor from cream to dark khaki. At 0.45
       * this term alone rendered the sleeve at rgb(182,165,136) with its albedo
       * set to literally zero — it WAS the tan tube. specularIntensity 0.4 is
       * ripstop's ~0.016 reflectance rather than glass's 0.04.
       */
      three: {
        physical: true,
        sheen: 0.09,
        sheenRoughness: 0.96,
        sheenColor: 0x38301f,
        // 0.4 -> 0.14, with the rest of the viewmodel. Ripstop is ~0.016.
        specularIntensity: 0.14,
      },
      // `fabric` in the library is authored for market awnings and ships a 0.20
      // sun-transmission term plus an underside darkening. A sleeve is opaque.
      cloth: [0, 1, 0, 0],
    },
  ],
};
