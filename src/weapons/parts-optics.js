import * as THREE from 'three';
import { box, blob, latheZ, tubeZ, rodZ, extrude, roundRect, ring, knurlBand, mergeAll } from './geometry.js';
import { dcos, dsin } from '../core/dmath.js';
import { TAU, addScrew } from './parts.js';

/** Tube sight, mini reflex, and the iron sights they sit behind. */

/**
 * Tube red-dot sight (T2 pattern) on a cantilever mount.
 * Returns the reticle plane's local position so the rig can align it to screen
 * centre in ADS, plus the aperture radius for the vignette.
 *
 * Built centred on (0, 0, 0) in optic space; the caller positions it.
 *
 * WHY THE TUBE IS 52 mm AND NOT 31. The proportions were solved against an eye
 * relief this game no longer has — `defs.js` used to carry the derivation next
 * to an `ads` field, and both went when ADS did — but the conclusion still
 * governs what the player sees, because the optic is on screen in hipfire too.
 * The two numbers pulled in opposite directions: the housing's outer rim
 * subtends `rOuter / relief`, and at 0.078 m of relief the 31 mm tube drew a
 * 512 px ring, HALF THE FRAME HEIGHT, which every critic called oversized;
 * while the sight picture is stopped by the objective bore at `relief + len`,
 * so a longer relief IMPROVES the picture-to-housing ratio (0.53 -> 0.69). Both
 * wanted the same thing and the old value was simply too close. The 52 mm tube
 * with the flared bore lands a 115 px aperture inside a 168 px housing — 31 %
 * of frame height, where a modern shooter frames a tube sight.
 */
export function buildOptic(asm, o) {
  const rTube = o.rTube ?? 0.0155;
  const len = o.len ?? 0.068;
  const matBody = o.matBody ?? 'alu';
  const matSteel = o.matSteel ?? 'steel';
  const y = o.y ?? 0;
  const z = o.z ?? 0;
  const railTop = o.railTop;

  /**
   * SEGMENT BUDGET.
   *
   * In ADS the objective ring is ~250 px across and it is the single largest
   * curve on screen, so it is the one place in the whole game where a 24-gon is
   * COUNTABLE. 56 segments puts the facet sagitta at 250 * (1-cos(3.2 deg)) /2 =
   * 0.2 px, i.e. under the AA threshold. The interior rings matter just as much
   * as the outer one, because a hard dark/light boundary shows faceting far more
   * readily than a shaded exterior does.
   */
  const SEG = 72;
  const SEG_IN = 80;

  /**
   * THE APERTURE BUDGET — the whole reason the ADS frame read as a drainpipe.
   *
   * Looking down a tube from a fixed eye point, the visible sight picture is the
   * SMALLER of two cones: the ocular bore subtended at the eye relief, and the
   * objective bore subtended at (relief + length). With the old geometry — a
   * 70 mm tube, a straight 0.71*rTube bore and 78 mm of eye relief — those were
   *   ocular    0.011 / 0.078  -> 158 px
   *   objective 0.011 / 0.148  ->  87 px
   * so the objective won by a factor of 1.8 and the resulting sight picture was
   * 87 px of a 256 px housing radius: 34%. Measured on ads.png, and it is
   * exactly what "a flat grey wedge where glass should be" and "four concentric
   * rings that shrink the sight picture to a third of the tube" describe. The
   * 69 px of dark tube wall between them is over a quarter of the frame height.
   *
   * The fix is not a material and it is not a segment count. A real red dot beats
   * this by having an objective lens BIGGER than its exit aperture — the bore
   * flares and the front of the housing carries an objective bell. So:
   *
   *   bore   12.2 mm radius at the ocular, FLARING to 16.5 mm at the objective
   *   shell  15.5 mm radius at the ocular, belling to 19.0 mm at the objective
   *   length 52 mm (was 70)
   *   relief 115 mm (was 78, see defs.js eyeRelief)
   *
   * which lands both cones on the same number — the mark of a correctly stopped
   * optical train, and the reason a real sight has no visible second vignette:
   *   ocular    0.0122 / 0.115 -> 118 px
   *   objective 0.0165 / 0.160 -> 115 px
   *   housing   0.0163 / 0.108 -> 168 px
   * A 230 px sight picture inside a 336 px housing: 69% instead of 34%, and the
   * housing itself drops from 50% of frame height to 31%, which is where a modern
   * shooter actually frames a tube sight.
   */
  const rBoreOc = rTube * 0.787; // 12.2 mm on a 15.5 mm tube
  const rBoreOb = rTube * 1.065; // flared to 16.5 mm at the objective
  const rBellOb = rTube * 1.226; // 19.0 mm objective bell
  const zOc = len / 2;
  const zOb = -len / 2;

  /**
   * Main tube: a straight section at the ocular, a conical flare, then the
   * objective bell. Every rim carries a 0.3 mm chamfer face — the only thing on
   * the silhouette that can catch a specular line and say the rim has thickness.
   *
   * The bell is deliberately SMALLER on screen than the ocular rim (135 px against
   * 168 px at the ADS eye point), so it never breaks the housing's outer circle:
   * from behind the sight the silhouette is one clean ring, and from the side in
   * hipfire the bell is what makes the optic read as a red dot rather than a pipe.
   */
  const tube = latheZ(
    [
      [zOb, rBoreOb * 0.995],
      [zOb + 0.0004, rBellOb * 0.99],
      [zOb, rBellOb * 1.008],
      [zOb + 0.0022, rBellOb],
      [zOb + 0.008, rBellOb * 0.995],
      [zOb + 0.014, rTube * 1.1],
      [zOb + 0.022, rTube * 1.01],
      [zOb + 0.03, rTube],
      [zOc - 0.012, rTube],
      [zOc - 0.01, rTube * 1.05],
      [zOc - 0.002, rTube * 1.05],
      [zOc - 0.0003, rTube * 1.02],
      [zOc, rTube * 0.995],
      [zOc, rBoreOc * 1.02],
    ],
    SEG
  );
  asm.add(tube, matBody, { y, z });
  tube.dispose();

  /**
   * Interior: a LIGHT TRAP, not a black hole, and now a CONE rather than a
   * cylinder. `cavity` (0.0015 linear) had nothing for the fill or the bounce off
   * the objective to land on. `optic_tube` is 0.0205 linear at roughness 0.9 with
   * the grazing lobe clamped: still black, but a black with a readable gradient
   * down it. See WeaponMaterials.opticTube().
   *
   * Because the cone opens away from the eye, the wall is seen at a much shallower
   * angle than a cylinder's would be, so it occupies a thin 3 px annulus instead
   * of a 69 px band — which is the geometric half of the drainpipe fix.
   */
  const baffle = latheZ(
    [
      [zOb + 0.001, rBoreOb],
      [zOb + 0.001, rBoreOb * 0.985],
      [zOc - 0.009, rBoreOc * 0.985],
      [zOc - 0.009, rBoreOc],
    ],
    SEG_IN
  );
  asm.add(baffle, 'optic_tube', { y, z });
  baffle.dispose();
  /**
   * NO INTERNAL BAFFLE STEPS. Three shallow rings down the bore were tried, on
   * the theory that each would shade the one behind it and give the trap a
   * gradient. Measured in ADS: they did the opposite. Each step's inner lip is an
   * annulus facing the eye and they rendered as four concentric LIGHT-GREY rings.
   * The gradient has to come from the wall itself, not from geometry in the bore.
   */

  // The ocular clear aperture — everything downstream (vignette, edge ring,
  // reticle vignette) is derived from this one number.
  const lensR = rBoreOc * 0.99;

  /**
   * EYE-RELIEF RING. A real sight has a black field stop right behind the ocular
   * lens: the shoulder between the glass and the tube wall is in shadow from
   * every direction, and it is what frames the sight picture. Without it the
   * aperture edge is the tube's own lit inner wall and the "glass" reads as a
   * drilled hole. It is 1.2 mm deep and no more — anything longer is another
   * concentric ring.
   */
  const relief = latheZ(
    [
      [0, lensR * 0.998],
      [0.0012, lensR * 1.012],
      [0.0034, rBoreOc * 1.01],
      [0.0038, rTube * 1.0],
      [0.0038, rBoreOc],
      [0, rBoreOc],
    ],
    SEG_IN
  );
  asm.add(relief, 'optic_tube', { y, z: z + zOc - 0.0045 });
  relief.dispose();

  // Lens elements — AR-coated glass, both ends, slightly dished. The coating's
  // angle-dependent hue (green on axis, magenta by 70 deg) lives on the
  // material: see WeaponMaterials.glass(). The objective element is the big one,
  // as it is on the real product.
  const lensOc = latheZ(
    [
      [0, 0],
      [-0.0009, lensR * 0.6],
      [-0.0014, lensR],
    ],
    SEG_IN
  );
  const lensOb = latheZ(
    [
      [0, 0],
      [-0.0012, rBoreOb * 0.58],
      [-0.0019, rBoreOb * 0.985],
    ],
    SEG_IN
  );
  asm.add(lensOb, 'glass', { y, z: z + zOb + 0.0055 });
  asm.add(lensOc, 'glass', { y, z: z + zOc - 0.007, ry: Math.PI });
  lensOc.dispose();
  lensOb.dispose();

  /**
   * INNER-EDGE REFLECTION RING.
   *
   * The unmistakable cue that a tube contains glass rather than air is a thin,
   * very bright arc a millimetre inside the objective rim — the inside of the
   * bezel reflected in the front surface of the lens. It is a property of the
   * LENS, so it is a 0.5 mm additive ring sitting on the glass, not a bright
   * band painted onto the bezel. Painting it on the bezel is precisely the
   * failure mode that produced the cream ring around the front lip: a fat, warm,
   * grazing-lit annulus instead of a hairline specular.
   */
  // HAIRLINE, and on the ocular only — the objective's ring is behind two lenses
  // and a light trap, so it can only add haze. At 0.965-0.99 of the clear
  // aperture this is 0.4 mm wide, which is ~4 px at full ADS. The first attempt
  // was 0.9-0.965 at intensity 0.55 and rendered as a 12 px blown-white band
  // right around the sight picture: a worse artefact than the one it replaced.
  {
    const edge = new THREE.RingGeometry(lensR * 0.965, lensR * 0.99, SEG_IN, 1);
    asm.add(edge, 'lens_ring', { y, z: z + zOc - 0.0066 });
    edge.dispose();
  }

  /**
   * TUBE VIGNETTE. 6-8% darkening toward the rim of the exit pupil, from the
   * field stop and the tube wall eating the outer rays. It is a flat disc with a
   * radial alpha ramp (see WeaponMaterials.lensVignette) sitting just inside the
   * ocular glass, so it darkens the sight picture and nothing else.
   */
  const vig = new THREE.CircleGeometry(lensR * 0.995, SEG_IN);
  asm.add(vig, 'lens_vig', { y, z: z + zOc - 0.0085 });
  vig.dispose();

  /**
   * Turrets: windage on the right, elevation on top, each a knurled cap with an
   * engraved click scale. The scale is real geometry in the part's own local
   * space rather than a projected decal, so it can never swim as the viewmodel
   * animates — the same reason the rollmark below is modelled.
   */
  const turret = (() => {
    const parts = [];
    parts.push(
      latheZ(
        [
          [0, 0.0062],
          [0.004, 0.0075],
          [0.0075, 0.0075],
          [0.0085, 0.0068],
          [0.0125, 0.0068],
          [0.0128, 0.006],
          [0.0128, 0],
        ],
        32
      )
    );
    parts.push(knurlBand(0.0072, 0.0052, 26, 0.00032, 3).translate(0, 0, 0.0102));
    return mergeAll(parts);
  })();
  // Engraved click marks around the turret skirt: 12 short recessed dashes and
  // one long index, cut in the cavity material so each reads as a dark line.
  const marks = (() => {
    const parts = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const long = i === 0;
      const h = long ? 0.0026 : 0.0014;
      const t = box(0.00035, h, 0.0006, 0.00008, 1);
      t.rotateZ(a);
      t.translate(dcos(a) * (0.0075 - h * 0.42), dsin(a) * (0.0075 - h * 0.42), 0);
      parts.push(t);
    }
    return mergeAll(parts);
  })();
  // Elevation on top (its local +Z ends up along +Y), windage on the right (+X).
  // The marks sit 5.5 mm up each turret's own axis, on the skirt below the knurl.
  const elev = { y: y + rTube * 0.9, z: z + 0.004, rx: -Math.PI / 2 };
  const wind = { x: rTube * 0.9, y, z: z + 0.004, ry: Math.PI / 2 };
  asm.add(turret, matBody, elev);
  asm.add(turret, matBody, wind);
  asm.add(marks, 'cavity', { ...elev, y: elev.y + 0.0055 });
  asm.add(marks, 'cavity', { ...wind, x: wind.x + 0.0055 });
  turret.dispose();
  marks.dispose();

  // Battery cap / brightness dial on the left.
  const dial = latheZ(
    [
      [0, 0.008],
      [0.005, 0.0092],
      [0.0125, 0.0092],
      [0.0128, 0.008],
      [0.0128, 0],
    ],
    32
  );
  asm.add(dial, matBody, { x: -rTube * 0.9, y, z: z - 0.006, ry: -Math.PI / 2 });
  dial.dispose();
  const dialKnurl = knurlBand(0.0094, 0.006, 26, 0.00028, 3);
  asm.add(dialKnurl, matBody, { x: -rTube * 0.9 - 0.008, y, z: z - 0.006, ry: -Math.PI / 2 });
  dialKnurl.dispose();

  /**
   * Mount: a slim cantilever riser clamped to the rail with two crossbolts.
   * The riser is NARROW (9 mm) and waisted — a full-width block under the tube
   * is the single thing that makes a red dot read as a plumbing fixture when
   * you are looking straight down it in ADS.
   *
   * `mountTop` is TANGENT to the tube's outer wall. It used to be y - rTube*0.35,
   * which put the top face of the riser 5 mm ABOVE the floor of the tube bore —
   * so in ADS a lit grey slab cut clean across the bottom third of the sight
   * picture. The riser must never enter the bore.
   */
  const mountTop = y - rTube;
  const mountH = mountTop - railTop;
  const base = extrude(
    [
      [-0.0092, 0],
      [0.0092, 0],
      [0.0105, -0.0025],
      [0.0072, -mountH * 0.45],
      [0.0072, -mountH + 0.005],
      [0.013, -mountH + 0.0018],
      [0.013, -mountH],
      [-0.013, -mountH],
      [-0.013, -mountH + 0.0018],
      [-0.0072, -mountH + 0.005],
      [-0.0072, -mountH * 0.45],
      [-0.0105, -0.0025],
    ],
    0.03,
    { bevel: 0.0008 }
  );
  asm.add(base, matBody, { y: mountTop, z: z + 0.002 });
  base.dispose();
  // ring clamp around the tube
  const clamp = latheZ(
    [
      [0, rTube],
      [0, rTube + 0.0035],
      [0.0055, rTube + 0.0035],
      [0.0055, rTube],
    ],
    SEG
  );
  asm.add(clamp, matBody, { y, z: z - 0.014 });
  asm.add(clamp, matBody, { y, z: z + 0.012 });
  clamp.dispose();
  for (const cz of [z - 0.0115, z + 0.0145]) {
    addScrew(asm, matSteel, 0.0135, mountTop - 0.004, cz, 0.0028, 'x', 0.01);
  }
  // recoil lug + rail clamp bolts
  const clampBar = box(0.032, 0.006, 0.03, 0.0008, 1);
  asm.add(clampBar, matBody, { y: railTop + 0.001, z: z + 0.002 });
  clampBar.dispose();
  addScrew(asm, matSteel, 0.0165, railTop + 0.001, z - 0.008, 0.003, 'x', 0.012);
  addScrew(asm, matSteel, 0.0165, railTop + 0.001, z + 0.012, 0.003, 'x', 0.012);

  /**
   * RUBBER EYEPIECE BEZEL — and this is the fix for the cream ring.
   *
   * MEASURED, by mapping the ADS frame radially against the known radius of every
   * feature: the bright warm band the critique called "a rim of unpainted MDF" sat
   * at screen radius 225-262 px, which is the tube's own rear rim chamfer and
   * outer flank at 1.00-1.05 rTube. It is not albedo — an anodised oxide at 0.003
   * linear cannot reach 200 sRGB — it is the grazing specular lobe: those two
   * surfaces are nearly edge-on to the eye and they sit right in the reflection
   * path of the viewmodel's warm rim light.
   *
   * Two things are needed and neither works alone. The material clamp (alu_fine
   * specularIntensity, see materials.js) takes the amplitude down; but as long as
   * an ALUMINIUM surface is what the eye is looking at, at 89 degrees of incidence
   * something will always light up. So the rear of the sight stops being aluminium
   * at all: the rubber bezel now covers the bore lip, the whole rear annulus, the
   * rim chamfer AND wraps 6 mm down the outside of the flank, out to 1.10 rTube —
   * past the widest point of the housing, so the entire outer circle of the optic
   * in ADS is moulded rubber. Which is also what a real sight's rubber bumper is
   * for and where it sits.
   *
   * `rubber` rather than `cavity`: cavity is 0.0015 linear and unlit, so it reads
   * as a hole punched in the frame. Moulded rubber is nearly as dark but it takes
   * the mask bake, the micro-relief and a faint shading gradient, so the bezel
   * reads as a surface.
   */
  const cup = latheZ(
    [
      [0, rBoreOc * 0.995],
      [0.0004, rBoreOc * 1.03],
      [0.0009, rTube * 1.02],
      [0.0018, rTube * 1.075],
      [0.0055, rTube * 1.1],
      [0.0072, rTube * 1.09],
      [-0.0042, rTube * 1.085],
      [-0.0048, rTube * 1.03],
    ],
    SEG
  );
  asm.add(cup, 'rubber', { y, z: z + zOc - 0.0012 });
  cup.dispose();
  /**
   * Objective shade. It rides on the BELL now, so it is wider than the tube and
   * (like the bell) still projects inside the ocular rim in ADS — it can never
   * break the housing silhouette. The inside is the light-trap material for the
   * same reason the bore is: a near-cylindrical anodised wall pointed at the sky
   * is the other place the cream ring used to come from.
   */
  const hoodLen = o.hood ?? 0.009;
  const hood = latheZ(
    [
      [0, rBellOb * 1.0],
      [0, rBellOb * 1.05],
      [hoodLen - 0.0003, rBellOb * 1.05],
      [hoodLen, rBellOb * 1.035],
      [hoodLen, rBellOb * 0.99],
    ],
    SEG
  );
  asm.add(hood, matBody, { y, z: z + zOb - hoodLen + 0.0015 });
  hood.dispose();
  const hoodLiner = tubeZ(rBellOb * 1.035, rBellOb * 0.998, hoodLen - 0.0008, SEG, 0.0002);
  asm.add(hoodLiner, 'optic_tube', { y, z: z + zOb - hoodLen * 0.5 + 0.0015 });
  hoodLiner.dispose();
  // A rubber bumper on the objective rim too — same argument as the eyepiece, and
  // it is the part of the optic that faces the camera in hipfire.
  const obBumper = latheZ(
    [
      [0, rBellOb * 1.01],
      [0.0006, rBellOb * 1.075],
      [0.0038, rBellOb * 1.08],
      [0.005, rBellOb * 1.03],
    ],
    SEG
  );
  asm.add(obBumper, 'rubber', { y, z: z + zOb - hoodLen - 0.0035 });
  obBumper.dispose();

  return {
    center: [0, y, z],
    lensZ: z + zOc - 0.007,
    // The exit pupil the reticle vignettes against is the ocular clear aperture.
    apertureR: lensR * 0.94,
    tubeR: rTube,
    len,
  };
}


/** Folding front sight: post, protective ears, hinge, detent. */
export function addFrontSight(asm, matSteel, matAlu, x, railTop, z, up = true) {
  const baseG = box(0.024, 0.008, 0.019, 0.0008, 1);
  asm.add(baseG, matAlu, { x, y: railTop + 0.004, z });
  baseG.dispose();
  const hinge = rodZ(0.0026, 0.0026, 0.026, 10, 0.0003);
  asm.add(hinge, matSteel, { x, y: railTop + 0.008, z: z + 0.006, ry: Math.PI / 2 });
  hinge.dispose();

  const h = up ? 0.03 : 0.006;
  const tilt = up ? 0 : -1.35;
  const earL = extrude(
    [
      [-0.0022, 0],
      [0.0022, 0],
      [0.0022, h],
      [0, h + 0.002],
      [-0.0022, h],
    ],
    0.0075,
    { bevel: 0.0005 }
  );
  const ears = [];
  for (const sx of [-1, 1]) {
    const g = earL.clone();
    g.translate(sx * 0.0088, 0, 0);
    ears.push(g);
  }
  earL.dispose();
  // the post itself
  const post = rodZ(0.0011, 0.0009, h * 0.72, 8, 0.0002);
  post.rotateX(Math.PI / 2);
  post.translate(0, h * 0.36 + 0.002, 0);
  ears.push(post);
  const cross = box(0.019, 0.0022, 0.0055, 0.0004, 1);
  cross.translate(0, h - 0.0012, 0);
  ears.push(cross);
  const g = mergeAll(ears);
  asm.add(g, matSteel, { x, y: railTop + 0.008, z, rx: tilt });
  g.dispose();
}

/** Folding rear sight: aperture wheel, windage drum, protective wings. */
export function addRearSight(asm, matSteel, matAlu, x, railTop, z, up = true) {
  const baseG = box(0.024, 0.0085, 0.022, 0.0008, 1);
  asm.add(baseG, matAlu, { x, y: railTop + 0.0042, z });
  baseG.dispose();
  const h = up ? 0.027 : 0.005;
  const tilt = up ? 0 : 1.35;
  const parts = [];
  const leaf = extrude(
    [
      [-0.011, 0],
      [0.011, 0],
      [0.011, h * 0.55],
      [0.006, h],
      [-0.006, h],
      [-0.011, h * 0.55],
    ],
    0.006,
    { bevel: 0.0006 }
  );
  parts.push(leaf);
  // aperture ring
  const ap = ring(0.0032, 0.0011, 14, 6);
  ap.translate(0, h * 0.66, 0);
  parts.push(ap);
  /**
   * Windage drum — KNURLED, and the knurl is not decoration.
   *
   * MEASURED: as a smooth 12-gon lathe this 10 mm drum rendered as a specular bead
   * at L=188 in hipfire, the brightest thing on the front half of the weapon. It
   * is a metal, so specularIntensity does nothing (three folds albedo into F0 at
   * metalness 1) and dropping F0 twice only moved it by a fifth of a stop — a
   * smooth convex metal facing the viewmodel key IS a mirror by construction and
   * the only thing that breaks a mirror is surface curvature.
   *
   * A real windage drum is knurled so you can turn it with wet fingers. 22 splines
   * scatter the lobe across 22 tiny highlights instead of one bead, which is both
   * correct and self-solving. The segment count also goes 12 -> 20, because a
   * 12-gon on a 10 mm part 0.44 m from the eye has countable facets.
   */
  const drum = latheZ(
    [
      [0, 0],
      [0, 0.0048],
      [0.0035, 0.0052],
      [0.008, 0.0052],
      [0.008, 0],
    ],
    20
  );
  const drumKnurl = knurlBand(0.0053, 0.0042, 22, 0.00028, 3);
  drumKnurl.translate(0, 0, 0.0055);
  const drumG = mergeAll([drum, drumKnurl]);
  drumG.rotateY(Math.PI / 2);
  drumG.translate(0.012, h * 0.3, 0);
  parts.push(drumG);
  const g = mergeAll(parts);
  asm.add(g, matSteel, { x, y: railTop + 0.0085, z, rx: tilt });
  g.dispose();
}


/**
 * Mini reflex sight (RMR pattern): an open frame with a canted glass window,
 * a hood, an emitter housing, a battery tray and two mounting screws.
 * Returned data lets the rig place the floating dot on the optical axis.
 */
export function buildMiniReflex(asm, o) {
  const w = o.w ?? 0.0246;
  const h = o.h ?? 0.021;
  const len = o.len ?? 0.0455;
  const y = o.y ?? 0;
  const z = o.z ?? 0;
  const matBody = o.matBody ?? 'alu';
  const glassTilt = o.tilt ?? 0.16; // rear-canted window, like the real thing

  // Base plate.
  const base = extrude(roundRect(w, len, 0.003, 3), 0.0042, { bevel: 0.0007 });
  asm.add(base, matBody, { y: y + 0.002, z, rx: Math.PI / 2 });
  base.dispose();

  // Two side walls that taper toward the front, joined by the hood.
  const wall = extrude(
    [
      [-len * 0.5, 0],
      [len * 0.42, 0],
      [len * 0.46, h * 0.52],
      [len * 0.3, h * 0.86],
      [-len * 0.42, h],
      [-len * 0.5, h * 0.92],
    ],
    0.0036,
    { bevel: 0.0007 }
  );
  for (const sx of [-1, 1]) {
    asm.add(wall, matBody, { x: sx * (w * 0.5 - 0.0018), y: y + 0.004, z, ry: Math.PI / 2 });
  }
  wall.dispose();

  // Hood over the front, and the emitter housing at the front floor.
  const hood = box(w, 0.0035, 0.011, 0.0008, 1);
  asm.add(hood, matBody, { y: y + h * 0.98, z: z - len * 0.36 });
  hood.dispose();
  const emitter = blob(w - 0.007, 0.0075, 0.012, 0.0016, 2);
  asm.add(emitter, matBody, { y: y + 0.0075, z: z - len * 0.3 });
  emitter.dispose();
  const led = latheZ(
    [
      [0, 0],
      [0, 0.0016],
      [0.0012, 0.0018],
      [0.0012, 0],
    ],
    10
  );
  asm.add(led, 'steel_bright', { y: y + 0.0105, z: z - len * 0.28, rx: -0.5 });
  led.dispose();

  // Battery tray + adjustment screws.
  addScrew(asm, 'steel', 0, y + 0.004, z + len * 0.4, 0.0026, 'y', 0.008);
  addScrew(asm, 'steel', w * 0.5 - 0.002, y + h * 0.5, z + len * 0.28, 0.0022, 'x', 0.006);
  addScrew(asm, 'steel', 0, y + h * 0.86, z + len * 0.1, 0.0022, 'y', 0.006);

  // The window: a real pane, canted back, in a bevelled frame.
  const glassW = w - 0.007;
  const glassH = h * 0.72;
  const pane = extrude(roundRect(glassW, glassH, 0.0015, 3), 0.0012, { bevel: 0.0003 });
  asm.add(pane, 'glass', { y: y + h * 0.56, z: z + len * 0.14, rx: glassTilt });
  pane.dispose();
  const frame = extrude(roundRect(glassW + 0.0028, glassH + 0.0028, 0.0018, 3), 0.0022, {
    bevel: 0.0005,
    holes: [roundRect(glassW - 0.0002, glassH - 0.0002, 0.0014, 3)],
  });
  asm.add(frame, matBody, { y: y + h * 0.56, z: z + len * 0.14, rx: glassTilt });
  frame.dispose();

  return {
    center: [0, y + h * 0.56, z + len * 0.14],
    lensZ: z + len * 0.14,
    apertureR: Math.min(glassW, glassH) * 0.46,
    windowW: glassW * 0.46,
    windowH: glassH * 0.46,
    tilt: glassTilt,
  };
}

