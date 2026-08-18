import { clamp01, smoothstep } from './noise.js';

/** Decal tiles, and the accumulate-and-blend helpers they paint through. */

/* ========================================================================= */
/*  decal tiles                                                              */
/* ========================================================================= */

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------------- */
/*  bullet holes                                                             */
/* ------------------------------------------------------------------------- */

/**
 * A bullet hole is a LIGHT TRAP in a surface, not a sticker on it.
 *
 * The version this replaces painted the rim at `0.6 + 0.28*crumb + 0.16*powder`
 * — up to 0.9 albedo against a 0.35-albedo wall — so every hole rendered 1.3
 * stops BRIGHTER than the plaster it was in and the wall read as a row of
 * glowing white donuts. The rules now, in linear albedo:
 *
 *   BORE   0.015-0.025. Nothing inside a hole is ever brighter than its host.
 *   RIM    pulverised material, capped at 1.2x the host's albedo.
 *   AO     a contact annulus from 1.0x to 1.9x the bore radius that MULTIPLIES
 *          the host down to ~0.6 at the lip and back to 1.0 at its outer edge.
 *          Under src-alpha-over blending, black at alpha k *is* a multiply by
 *          (1-k), so the AO layer is authored as coverage with zero colour and
 *          the blend does the rest — no second material, no multiply pass.
 *   SPALL  3-5 asymmetric radial cracks, darker than the host.
 *
 * `mixAdd` accumulates premultiplied coverage so overlapping layers average
 * rather than add: no layer can lighten the result of another.
 */
const MIX = new Float64Array(4);

function mixReset() {
  MIX[0] = MIX[1] = MIX[2] = MIX[3] = 0;
}

function mixAdd(cov, r, g, b) {
  if (cov <= 0) return;
  MIX[0] += r * cov;
  MIX[1] += g * cov;
  MIX[2] += b * cov;
  MIX[3] += cov;
}

/** Resolve the accumulator into `out`, feathering alpha by `edge`. */
function mixInto(out, edge) {
  const sum = MIX[3];
  const inv = sum > 1e-6 ? 1 / sum : 0;
  out[0] = MIX[0] * inv;
  out[1] = MIX[1] * inv;
  out[2] = MIX[2] * inv;
  out[3] = clamp01(sum) * edge;
}

/**
 * Contact-occlusion annulus. Full strength at the lip of the bore, gone by
 * 1.9x the bore radius. Returned as *coverage of black*, i.e. 1 - multiplier.
 */
function contactAo(r, rb, peak) {
  if (r <= rb) return peak;
  const t = clamp01((r - rb) / (rb * 0.9));
  // Falls off faster than a smoothstep on purpose. A symmetric ramp still puts
  // ~0.32 of occlusion where the pulverised rim lives (1.3x the bore) and swamps
  // it, so the hole loses its crushed pale collar and reads as a plain dark dot.
  return peak * Math.pow(1 - t, 2.2);
}

/**
 * 3-5 asymmetric radial spall cracks running out of the bore.
 *
 * Angles are unevenly spaced, lengths are unequal and each crack wanders as it
 * runs out of energy, so the tile keeps no rotational symmetry — which, with the
 * per-instance roll and flip the decal system applies, is what stops seven holes
 * walked across a wall from being seven identical copies.
 */
function radialSpall(n, ang, r, seed, count) {
  let c = 0;
  for (let k = 0; k < count; k++) {
    const h = n.fbm(k * 4.7 + seed, k * 2.3 - seed * 0.7, 2);
    const h2 = n.fbm(k * 2.9 - seed, k * 5.1 + seed * 1.3, 2);
    const len = 0.24 + 0.52 * h2;
    if (r > len) continue;
    // uneven spacing: a real spall pattern is never evenly spoked
    const a0 = ((k + (h - 0.5) * 1.5) / count) * TWO_PI + seed;
    let d = ang - a0;
    d -= TWO_PI * Math.round(d / TWO_PI);
    const wob = (n.fbm(r * 7.5 + k * 3.3, seed + k * 1.7, 3) - 0.5) * 0.5;
    // constant-ish physical width, tapering to nothing at the tip
    const w = 0.03 * (1 - r / len) + 0.006;
    const q = (Math.abs(d + wob * r) * r) / w;
    c = Math.max(c, smoothstep(1.0, 0.25, q) * (0.4 + 0.85 * h2) * smoothstep(len, len * 0.55, r));
  }
  return clamp01(c);
}

/**
 * Decal painters write `out = [r,g,b, alpha, height, roughness, metalness]`.
 * height 0.5 == flush with the wall, 0 == deep, 1 == proud.
 */
export const DECAL_PAINTERS = [
  // 0 — bullet hole in concrete: bore, pulverised rim, contact AO, spall cracks
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const jit = n.fbm(Math.cos(ang) * 2.6 + 3.1, Math.sin(ang) * 2.6 - 7.4, 3) - 0.5;
    const rb = 0.185 * (1 + jit * 0.36);
    const bore = smoothstep(rb + 0.028, rb - 0.012, r);
    // Pulverised cement, eroded by noise so the collar never closes into a ring.
    const crumb = Math.pow(n.fbm(x * 5.2 + 2.2, y * 5.2 - 1.1, 4), 1.4);
    const rimT = (r - rb * 1.3) / (0.11 + 0.05 * (jit + 0.5));
    const rim = clamp01(Math.exp(-rimT * rimT * 1.4) * (0.3 + 1.25 * crumb)) * (1 - bore);
    const ao = contactAo(r, rb, 0.40 + 0.12 * crumb) * (1 - bore);
    const crack = radialSpall(n, ang, r, 3.7, 4) * smoothstep(rb * 0.8, rb * 1.25, r);
    const grit =
      Math.pow(clamp01(1 - n.worley(x * 12.5 + 8.8, y * 12.5 - 3.3) * 2.1), 2) *
      smoothstep(0.85, 0.2, r);
    mixReset();
    mixAdd(bore, 0.021, 0.0195, 0.018);
    mixAdd(rim * 0.92, 0.235, 0.222, 0.198); // <= 1.2x a ~0.2 linear host
    mixAdd(grit * 0.4, 0.19, 0.18, 0.163);
    mixAdd(crack * 0.8, 0.045, 0.042, 0.038);
    mixAdd(ao, 0, 0, 0);
    mixInto(out, smoothstep(1.0, 0.74, r));
    out[4] = 0.5 - bore * 0.5 + rim * 0.1 - crack * 0.22 - ao * 0.1;
    out[5] = clamp01(0.99 - rim * 0.05);
    out[6] = 0;
  },
  // 1 — deeper concrete hit: the bore sits in a blown-out spall crater
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const lobes = 0.26 + 0.13 * n.fbm(Math.cos(ang) * 1.7 + 20.5, Math.sin(ang) * 1.7 + 6.6, 3);
    const erode = n.fbm(x * 6.6 + 14.2, y * 6.6 - 8.1, 4);
    const crater = smoothstep(lobes + 0.1, lobes - 0.08, r + (erode - 0.5) * 0.14);
    const rb = 0.105 + 0.028 * n.fbm(Math.cos(ang) * 3 + 1.5, Math.sin(ang) * 3 - 2.5, 2);
    const bore = smoothstep(rb + 0.03, rb - 0.014, r);
    const chips =
      Math.pow(1 - n.worley(x * 13.5 + 8.8, y * 13.5 - 3.3), 2.6) *
      crater *
      (0.4 + 1.1 * n.fbm(x * 5.5 - 1.1, y * 5.5 + 6.2, 3));
    const crack = radialSpall(n, ang, r, 8.2, 5) * smoothstep(rb * 0.9, rb * 1.4, r);
    // The crater floor is fresh fracture: slightly greyer than the weathered
    // face, and sunk, so it also carries its own occlusion.
    const floorAo = crater * 0.34;
    const ao = contactAo(r, lobes * 0.92, 0.34 + 0.14 * chips) * (1 - bore) * (1 - crater * 0.6);
    mixReset();
    mixAdd(bore, 0.020, 0.0185, 0.017);
    mixAdd(crater * 0.64, 0.205 + 0.05 * chips, 0.195 + 0.045 * chips, 0.175 + 0.04 * chips);
    mixAdd(crack * 0.78, 0.042, 0.039, 0.035);
    mixAdd(clamp01(floorAo + ao), 0, 0, 0);
    mixInto(out, smoothstep(1.0, 0.76, r));
    out[4] = 0.5 - bore * 0.5 - crater * 0.24 + chips * 0.12 - crack * 0.2;
    out[5] = 0.99;
    out[6] = 0;
  },
  // 2 — bullet hole in steel: torn petals of bare bright metal
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    // Irregular angular profile: a clean harmonic reads as a stamped hexagon,
    // so the petal function is warped by noise and eroded radially.
    const warp = n.fbm(Math.cos(ang) * 2.2 + 4.4, Math.sin(ang) * 2.2 + 9.1, 3);
    const petal = 0.45 * Math.abs(Math.sin(ang * 2.5 + warp * 5.5)) + 0.55 * warp;
    const rh = 0.14 + 0.035 * petal;
    const hole = smoothstep(rh + 0.03, rh - 0.015, r);
    const lipT = (r - rh * (1.35 + 0.5 * petal)) / (0.07 + 0.09 * petal);
    const grain = n.fbm(x * 9.5 + 1.3, y * 9.5 - 5.6, 3);
    const lip = Math.exp(-lipT * lipT * 2.4) * (0.45 + 1.05 * grain);
    const scuff = smoothstep(0.9, 0.2, r) * n.fbm(x * 7.5 + 6.1, y * 7.5 - 2.2, 3);
    const scratch = Math.pow(clamp01(1 - n.worleyEdge(x * 6 + 2, y * 6 - 8) * 9), 2) * smoothstep(0.85, 0.1, r);
    // Same contact annulus as the masonry tiles: a punched plate has a shadow in
    // the hole, and torn petals throw one on the paint around them.
    const ao = contactAo(r, rh, 0.34) * (1 - hole);
    const a = clamp01(hole + lip * 0.7 + scuff * 0.5 + scratch * 0.3 + ao) * smoothstep(1.0, 0.75, r);
    const bare = clamp01(lip * 0.85 + scratch * 0.45);
    // 0.24, not 0.4: bare torn steel IS bright, but at 0.4 the petal ring came out
    // paler than any plate it could be punched through and read as a white donut.
    const l = hole > 0.5 ? 0.018 : clamp01((0.09 + 0.24 * bare + 0.07 * scuff) * (1 - ao));
    out[0] = l;
    out[1] = l * 0.985;
    out[2] = l * 0.96;
    out[3] = a;
    out[4] = 0.5 - hole * 0.5 + lip * 0.26;
    out[5] = clamp01(0.62 - bare * 0.42);
    out[6] = clamp01(bare * 0.85);
  },
  // 3 — bullet hole in wood: bore, torn fibre lip, contact AO
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const fib = n.fbm(x * 1.6 + 5.5, y * 11.0 - 2.2, 4); // grain runs along X
    const rb = 0.16 * (1 + (fib - 0.5) * 0.34);
    const bore = smoothstep(rb + 0.03, rb - 0.014, r);
    // Fibres tear out along the grain, so the lip is lopsided along X.
    const splinter =
      Math.pow(clamp01(1 - Math.abs(Math.sin(ang * 6.5 + fib * 5)) * 1.05), 3.2) *
      smoothstep(0.52, rb * 0.9, r) *
      (0.45 + 1.0 * n.fbm(x * 7.7 - 2.2, y * 7.7 + 5.5, 3));
    const lipT = (r - rb * 1.25) / 0.1;
    // Fresh wood is lighter than the finish, but "lighter than a 0.07 host" is
    // still 0.12 linear — not the 0.4 the old tile painted.
    const lip = clamp01(Math.exp(-lipT * lipT * 1.5) * (0.4 + 1.1 * fib)) * (1 - bore);
    const ao = contactAo(r, rb, 0.44 + 0.1 * fib) * (1 - bore);
    const crack = radialSpall(n, ang, r, 5.9, 3) * smoothstep(rb * 0.8, rb * 1.3, r);
    mixReset();
    mixAdd(bore, 0.015, 0.0125, 0.010);
    mixAdd(clamp01(lip * 0.85 + splinter * 0.6), 0.125, 0.088, 0.052);
    mixAdd(crack * 0.7, 0.03, 0.022, 0.014);
    mixAdd(ao, 0, 0, 0);
    mixInto(out, smoothstep(1.0, 0.72, r));
    out[4] = 0.5 - bore * 0.5 + splinter * 0.22 - crack * 0.18 - ao * 0.08;
    out[5] = clamp01(0.9 - splinter * 0.1);
    out[6] = 0;
  },
  // 4 — plaster / drywall: crumbly bore, powdered rim, contact AO
  //
  // The reference failure lived here: `0.6 + 0.28*crumb + 0.16*powder` put the
  // rim at up to 0.9 albedo against a 0.35 wall, which is why the measured hole
  // came out 1.3 stops brighter than the plaster around it.
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const jit = n.fbm(Math.cos(ang) * 2.2 + 14.4, Math.sin(ang) * 2.2 + 3.3, 3) - 0.5;
    const rb = 0.195 * (1 + jit * 0.4);
    const bore = smoothstep(rb + 0.032, rb - 0.014, r);
    const crumb =
      Math.pow(1 - n.worley(x * 11.5 - 3.3, y * 11.5 + 7.7), 2.4) *
      (0.35 + 1.2 * n.fbm(x * 4.4 + 9.9, y * 4.4 - 2.2, 3));
    const rimT = (r - rb * 1.26) / (0.12 + 0.05 * (jit + 0.5));
    const rim = clamp01(Math.exp(-rimT * rimT * 1.35) * (0.32 + 1.2 * crumb)) * (1 - bore);
    // A thin veil of powder that has drifted further out, still under the host.
    const powder = smoothstep(0.9, 0.18, r) * n.fbm(x * 3.1 + 8.2, y * 3.1 - 4.4, 4) * 0.3;
    const ao = contactAo(r, rb, 0.40 + 0.12 * crumb) * (1 - bore);
    const crack = radialSpall(n, ang, r, 1.9, 4) * smoothstep(rb * 0.8, rb * 1.25, r);
    mixReset();
    mixAdd(bore, 0.018, 0.0165, 0.015);
    // Lime plaster over mud brick: the pulverised rim keeps the host's ochre
    // hue and is capped at ~1.2x its luminance (0.29 against a 0.24 wall).
    mixAdd(rim * 0.94, 0.305, 0.278, 0.234);
    mixAdd(powder, 0.26, 0.238, 0.20);
    mixAdd(crack * 0.8, 0.04, 0.036, 0.03);
    mixAdd(ao, 0, 0, 0);
    mixInto(out, smoothstep(1.0, 0.75, r));
    out[4] = 0.5 - bore * 0.5 + rim * 0.12 - crack * 0.2 - ao * 0.1;
    out[5] = 1.0;
    out[6] = 0;
  },
  // 5 — glass: radial + concentric crack web, almost no fill
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const radial = Math.pow(clamp01(1 - Math.abs(Math.sin(ang * 5.5 + n.fbm(r * 3 + 2, ang + 4, 3) * 6)) * 1.6), 6);
    const conc = Math.pow(clamp01(1 - Math.abs(Math.sin(r * 17 + n.fbm(x * 2, y * 2, 2) * 4)) * 1.9), 5);
    const web = clamp01(radial * smoothstep(0.98, 0.05, r) + conc * smoothstep(0.95, 0.12, r) * 0.7);
    const rh = 0.055;
    const hole = smoothstep(rh + 0.02, rh - 0.01, r);
    const shatter = Math.pow(clamp01(1 - n.worleyEdge(x * 4.4 + 1.1, y * 4.4 - 6.6) * 8), 3) * smoothstep(0.7, 0.1, r);
    const a = clamp01(web * 0.95 + hole + shatter * 0.8);
    const l = hole > 0.5 ? 0.02 : clamp01(0.5 + 0.45 * web);
    out[0] = l * 0.94;
    out[1] = l * 0.98;
    out[2] = l;
    out[3] = a;
    out[4] = 0.5 - hole * 0.4 + web * 0.2;
    out[5] = clamp01(0.42 - web * 0.3);
    out[6] = 0;
  },
  // 6 — blood splat with satellite droplets
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const edge = 0.44 + 0.3 * n.fbm(Math.cos(ang) * 2.1 + 6.5, Math.sin(ang) * 2.1 - 9.9, 3);
    const wob = n.fbm(x * 5.5 - 3.3, y * 5.5 + 1.7, 4);
    let a = smoothstep(edge, edge - 0.16, r + (wob - 0.5) * 0.16);
    // satellite spatter
    const s = n.worley(x * 4.2 + 3.7, y * 4.2 - 5.5);
    a = clamp01(a + Math.pow(clamp01(1 - s * 3.4), 5) * smoothstep(1.0, 0.42, r) * 0.95);
    const thick = a * (0.25 + 1.35 * Math.pow(n.warped(x * 4.4 - 2.2, y * 4.4 + 4.4, 0.7, 4), 1.5));
    const rim = smoothstep(edge - 0.16, edge, r); // dried, darker at the perimeter
    out[0] = clamp01(0.075 + 0.075 * thick - rim * 0.035);
    out[1] = clamp01(0.009 + 0.017 * thick);
    out[2] = clamp01(0.008 + 0.014 * thick);
    out[3] = a;
    out[4] = 0.5 + thick * 0.12;
    out[5] = clamp01(0.5 - thick * 0.26 + rim * 0.24);
    out[6] = 0;
  },
  // 7 — heavier blood with runs (roll-aligned to gravity by the decal system)
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const edge = 0.4 + 0.22 * n.fbm(Math.cos(ang) * 1.8 + 16.5, Math.sin(ang) * 1.8 + 2.2, 3);
    let a = smoothstep(edge, edge - 0.12, Math.hypot(x, (y + 0.12) * 1.18));
    // Runs hang off the *bottom of the splat* and terminate in a bead. Doing
    // this as a periodic function of x alone striped the whole tile.
    const lane = n.fbm(x * 9.5 + 1.7, 3.3, 2);
    const inLane = Math.pow(clamp01(1 - Math.abs(Math.sin(x * 11.5 + lane * 4)) * 1.5), 5);
    const under = smoothstep(edge * 1.0, edge * 0.25, Math.abs(x));
    const y0 = -edge * 0.8;
    const runLen = (0.3 + 0.55 * lane) * under;
    const t = runLen > 0.02 ? (y0 - y) / runLen : -1;
    const run =
      t > 0 && t < 1
        ? inLane * under * (1 - t * 0.65) * smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.86, t)
        : 0;
    a = clamp01(a + run * 0.9);
    const bead = Math.exp(-(Math.pow((x - (lane - 0.5) * 0.12) * 26, 2) + Math.pow((y - (y0 - runLen)) * 22, 2)));
    a = clamp01(a + bead * inLane * under * 0.85);
    const thick = a * (0.5 + 0.8 * n.fbm(x * 4.4 + 7.7, y * 4.4 - 1.1, 3));
    out[0] = clamp01(0.07 + 0.08 * thick);
    out[1] = clamp01(0.008 + 0.016 * thick);
    out[2] = clamp01(0.007 + 0.013 * thick);
    out[3] = a;
    out[4] = 0.5 + thick * 0.1;
    out[5] = clamp01(0.46 - thick * 0.24);
    out[6] = 0;
  },
  // 8 — scorch: soot with radial streaks
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const streak = 0.55 + 0.55 * n.fbm(Math.cos(ang) * 3.3 + 4.4, Math.sin(ang) * 3.3 - 8.8, 4);
    const body = smoothstep(0.98 * streak, 0.05, r);
    const soot = n.fbm(x * 3.4 + 2.4, y * 3.4 + 12.2, 5);
    const a = clamp01(body * (0.45 + 0.85 * soot));
    const l = clamp01(0.035 + 0.07 * (1 - body) + 0.03 * soot);
    out[0] = l;
    out[1] = l * 0.96;
    out[2] = l * 0.92;
    out[3] = a * 0.92;
    out[4] = 0.5 - body * 0.04;
    out[5] = 1.0;
    out[6] = 0;
  },
  // 9 — dirt impact: dark damp crater with an ejecta collar
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const rh = 0.26 + 0.09 * (n.fbm(Math.cos(ang) * 1.9 + 9.1, Math.sin(ang) * 1.9 - 3.7, 3) - 0.5);
    const crater = smoothstep(rh + 0.09, rh - 0.05, r);
    const collar = Math.exp(-Math.pow((r - rh * 1.5) / 0.24, 2) * 1.7);
    const clods = Math.pow(1 - n.worley(x * 3.9 + 5.2, y * 3.9 + 1.4), 2.4);
    const a = clamp01(crater + collar * 0.85 * (0.4 + clods) + smoothstep(1.0, 0.3, r) * 0.3);
    const l = clamp01(0.045 + 0.06 * (1 - crater) + 0.07 * collar * clods);
    out[0] = l * 1.0;
    out[1] = l * 0.82;
    out[2] = l * 0.62;
    out[3] = a;
    out[4] = 0.5 - crater * 0.4 + collar * clods * 0.2;
    out[5] = 0.96;
    out[6] = 0;
  },
  // 10 — sand impact: pale cone crater, fine ripples
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const rh = 0.3 + 0.07 * (n.fbm(Math.cos(ang) * 2.4 + 1.1, Math.sin(ang) * 2.4 + 8.3, 3) - 0.5);
    const crater = smoothstep(rh + 0.13, rh - 0.06, r);
    const collar = Math.exp(-Math.pow((r - rh * 1.42) / 0.26, 2) * 1.5);
    const grain = n.fbm(x * 11 + 3.3, y * 11 - 6.6, 3);
    // Ejecta rays break the collar so it stops reading as a painted ring.
    const rays =
      Math.pow(clamp01(1 - Math.abs(Math.sin(ang * 4.5 + n.fbm(Math.cos(ang) * 2, Math.sin(ang) * 2, 3) * 6)) * 1.15), 2.5) *
      collar;
    const a = clamp01(crater * 0.8 + collar * 0.45 + rays * 0.45 + smoothstep(1.0, 0.3, r) * 0.3);
    const l = clamp01(0.3 + 0.1 * collar + 0.1 * rays - 0.16 * crater + 0.08 * grain);
    out[0] = l * 1.0;
    out[1] = l * 0.9;
    out[2] = l * 0.72;
    out[3] = a;
    out[4] = 0.5 - crater * 0.3 + collar * 0.12;
    out[5] = 1.0;
    out[6] = 0;
  },
  // 11 — ricochet scrape: long gouge with bright abraded metal
  (n, x, y, r, out) => {
    // The round skids along +X: the gouge is deepest where it bit and tapers
    // out, with abrasion striae running *along* travel, never across it.
    const wander = (n.fbm(x * 2.6 + 2.2, 1.7, 3) - 0.5) * 0.22;
    const taper = smoothstep(-0.95, -0.55, x) * smoothstep(1.0, 0.35, x);
    const w = 0.19 * taper * (0.55 + 0.8 * n.fbm(x * 4.4 - 6.6, 3.3, 3));
    const d = Math.abs(y - wander) / Math.max(0.02, w);
    const gouge = smoothstep(1.15, 0.15, d) * taper;
    // Abrasion is a bundle of parallel scratches: high frequency across the
    // groove, smooth along it.
    const striae =
      Math.pow(clamp01(1 - Math.abs(Math.sin(y * 34 + n.fbm(x * 3.2, 5.5, 2) * 4)) * 1.25), 4) *
      gouge *
      (0.3 + 1.2 * n.fbm(x * 9 + 1.1, y * 2, 3));
    const a = clamp01(gouge * 0.85 + striae * 0.4);
    const l = clamp01(0.18 + 0.34 * striae + 0.16 * gouge);
    out[0] = l;
    out[1] = l * 0.98;
    out[2] = l * 0.95;
    out[3] = a;
    out[4] = 0.5 - gouge * 0.22 + striae * 0.1;
    out[5] = clamp01(0.55 - striae * 0.35);
    out[6] = clamp01(gouge * 0.85);
  },
  // 12 — water ripple: normal-dominated concentric rings
  (n, x, y, r, out) => {
    const wob = 1 + 0.06 * (n.fbm(x * 3 + 6, y * 3 - 2, 3) - 0.5);
    const rings = Math.sin((r * wob) * 22) * Math.exp(-r * r * 2.6);
    const a = clamp01(Math.exp(-r * r * 2.2) * 0.6) * smoothstep(1.0, 0.85, r);
    out[0] = 0.42;
    out[1] = 0.46;
    out[2] = 0.5;
    out[3] = a;
    out[4] = 0.5 + rings * 0.28;
    out[5] = 0.06;
    out[6] = 0;
  },
  // 13 — small glass punch-through
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const rad = Math.pow(clamp01(1 - Math.abs(Math.sin(ang * 4.5 + n.fbm(r * 4 + 1, ang * 2, 3) * 5)) * 1.5), 7);
    const web = rad * smoothstep(0.72, 0.04, r);
    const hole = smoothstep(0.08, 0.05, r);
    const frost = Math.pow(1 - n.worley(x * 7 + 2.2, y * 7 - 3.3), 3) * smoothstep(0.34, 0.04, r);
    const a = clamp01(web * 0.9 + hole + frost * 0.85);
    const l = hole > 0.5 ? 0.02 : clamp01(0.55 + 0.4 * (web + frost));
    out[0] = l * 0.95;
    out[1] = l * 0.99;
    out[2] = l;
    out[3] = a;
    out[4] = 0.5 - hole * 0.4 + (web + frost) * 0.18;
    out[5] = clamp01(0.36 - frost * 0.24);
    out[6] = 0;
  },
  // 14 — generic dust smudge (explosion soiling, sandbag hits, scuffs)
  (n, x, y, r, out) => {
    const w = n.warped(x * 2.2 + 18.8, y * 2.2 - 5.5, 0.8, 5);
    const a = clamp01(smoothstep(0.05, 0.75, (1 - r) + (w - 0.5) * 0.9)) * 0.7;
    const l = clamp01(0.22 + 0.22 * w);
    out[0] = l;
    out[1] = l * 0.96;
    out[2] = l * 0.9;
    out[3] = a;
    out[4] = 0.5;
    out[5] = 1.0;
    out[6] = 0;
  },
  // 15 — torn fabric / foliage puncture
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const rip = Math.pow(clamp01(1 - Math.abs(Math.sin(ang * 2.5 + n.fbm(Math.cos(ang) * 2 + 3, Math.sin(ang) * 2, 2) * 4)) * 1.2), 3);
    const rh = 0.1 + 0.14 * rip;
    const hole = smoothstep(rh + 0.05, rh - 0.02, r);
    const fray = Math.pow(clamp01(1 - n.worleyEdge(x * 8 + 4.4, y * 8 - 1.1) * 9), 2) * smoothstep(0.5, 0.1, r);
    const a = clamp01(hole + fray * 0.9);
    const l = hole > 0.5 ? 0.02 : clamp01(0.18 + 0.3 * fray);
    out[0] = l;
    out[1] = l * 0.94;
    out[2] = l * 0.88;
    out[3] = a;
    out[4] = 0.5 - hole * 0.45 + fray * 0.12;
    out[5] = 0.98;
    out[6] = 0;
  },
];

/* ========================================================================= */
/*  bakers                                                                   */
/* ========================================================================= */

/** Relief strength per decal tile — how hard the derived normal map pushes. */
export const DECAL_RELIEF = [2.6, 3.0, 2.2, 2.4, 2.3, 1.4, 0.8, 0.7, 0.35, 2.4, 1.9, 1.6, 1.1, 1.5, 0.2, 1.7];

