import { clamp01, smoothstep } from './noise.js';

/** How each particle tile is painted. Consumed only by `buildParticleAtlas`. */

/* ========================================================================= */
/*  particle tiles                                                           */
/* ========================================================================= */

/**
 * Each painter writes `out = [r,g,b,a]` for a point (x,y) in -1..1.
 * RGB is linear here; it gets sRGB-encoded on the way into the texture.
 */
export const PARTICLE_PAINTERS = [
  // 0 — SMOKE_A: billowing puff, wispy eroded rim
  (n, x, y, r, out) => {
    const w = n.warped(x * 2.05 + 3.7, y * 2.05 - 1.4, 0.8, 5);
    const lump = n.worley(x * 2.4 + 7.1, y * 2.4 + 2.3);
    const tear = n.fbm(x * 7.4 - 6.2, y * 7.4 + 3.9, 3);
    let a = smoothstep(0, 0.58, 1 - r + (w - 0.5) * 0.8 + (lump - 0.45) * 0.26);
    // High-frequency erosion only near the rim: keeps the core dense while the
    // silhouette tears the way real dust does.
    a *= 1 - smoothstep(0.35, 0.95, r) * (1 - tear) * 0.85;
    a *= smoothstep(1.02, 0.66, r);
    const det = n.fbm(x * 4.6 - 2.1, y * 4.6 + 8.4, 4);
    const l = 0.42 + 0.66 * det * det;
    out[0] = l;
    out[1] = l * 0.995;
    out[2] = l * 0.99;
    out[3] = a;
  },
  // 1 — SMOKE_B: cauliflower lobes, denser core
  (n, x, y, r, out) => {
    const cw = 1 - n.worley(x * 3.05 - 4.3, y * 3.05 + 6.7);
    const f = n.fbm(x * 1.9 + 12.2, y * 1.9 - 3.3, 4);
    const tear = n.fbm(x * 8.8 + 1.7, y * 8.8 - 4.4, 3);
    let a = smoothstep(0, 0.52, 1 - r * 1.02 + (cw - 0.42) * 0.68 + (f - 0.5) * 0.46);
    a *= 1 - smoothstep(0.3, 0.92, r) * (1 - tear) * 0.9;
    a *= smoothstep(1.0, 0.6, r);
    const det = n.fbm(x * 6.1 + 4.4, y * 6.1 - 5.2, 4);
    const l = 0.38 + 0.7 * (0.35 * det + 0.65 * cw);
    out[0] = l;
    out[1] = l * 0.99;
    out[2] = l * 0.975;
    out[3] = a;
  },
  // 2 — WISP: torn filaments, drifts and dissipates
  (n, x, y, r, out) => {
    const fil = n.ridged(x * 2.6 + 1.3, y * 1.05 - 6.0, 4);
    const body = smoothstep(0, 0.75, 1 - Math.hypot(x * 1.05, y * 0.78));
    let a = clamp01(smoothstep(0.28, 0.85, fil) * 1.15 + 0.16) * body * body;
    a *= smoothstep(1.05, 0.55, r);
    const l = 0.5 + 0.55 * fil;
    out[0] = l;
    out[1] = l * 0.99;
    out[2] = l * 0.985;
    out[3] = a * 0.9;
  },
  // 3 — DUST: fine grained, sharp-ish falloff, grit specks
  (n, x, y, r, out) => {
    const w = n.warped(x * 3.3 + 21.1, y * 3.3 + 5.9, 0.55, 5);
    const grit = n.fbm(x * 15.5 + 3.3, y * 15.5 - 7.7, 2);
    let a = smoothstep(0, 0.5, 1 - r * 1.04 + (w - 0.5) * 0.86);
    a *= 1 - smoothstep(0.25, 0.9, r) * (1 - grit) * 0.8;
    a *= smoothstep(1.0, 0.62, r);
    // Grain, not snow: a soft ramp instead of a threshold, or every puff wears
    // a scatter of hard white dots.
    const l = 0.48 + 0.42 * w + 0.16 * smoothstep(0.6, 0.92, grit);
    out[0] = Math.min(1, l);
    out[1] = Math.min(1, l * 0.985);
    out[2] = Math.min(1, l * 0.96);
    out[3] = a;
  },
  // 4 — SPARK: point with a tight bloom halo
  (n, x, y, r, out) => {
    const core = Math.exp(-r * r * 26);
    const glow = Math.exp(-r * r * 4.5) * 0.4;
    const a = clamp01(core + glow) * smoothstep(1.0, 0.85, r);
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = a;
  },
  // 5 — STREAK: capsule along +Y, bright head, fading tail (tracers, spark trails)
  (n, x, y, r, out) => {
    const halfW = 0.26 * (0.55 + 0.45 * smoothstep(-1.0, 0.6, y));
    const q = Math.abs(x) / halfW;
    const core = Math.exp(-q * q * 3.0);
    const along = smoothstep(-1.02, -0.55, y) * smoothstep(1.02, 0.72, y);
    const taper = 0.1 + 0.9 * smoothstep(-1.0, 0.85, y);
    const jag = 0.85 + 0.3 * n.fbm(x * 6 + 2.2, y * 3.1 - 8.8, 3);
    let a = core * along * taper * jag;
    a += Math.exp(-(x * x * 90 + (y - 0.72) * (y - 0.72) * 30)) * 0.9; // hot head
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = clamp01(a);
  },
  // 6 — FLASH_LOBE: ONE tongue of burning gas. Root at the -X edge, tip toward
  //     +X. Deliberately one-sided and asymmetric: muzzle.js stamps a handful of
  //     these at independent rolls, so any radial symmetry in the sprite itself
  //     rebuilds the cartoon starburst this replaces. There is no spike term.
  (n, x, y, r, out) => {
    const u = clamp01((x + 1) * 0.5); // 0 at the root, 1 at the tip
    // Width: swells just past the crown where the gas is still choked, then
    // tapers to a torn point. Half-width in painter units.
    const swell = Math.pow(u + 0.02, 0.5) * Math.pow(1 - u, 0.7);
    // The tongue leans and wanders instead of running straight down +X.
    const lean = 0.26 * u * u - 0.07 * u + 0.2 * (n.fbm(u * 2.4 + 4.1, 8.3, 3) - 0.5) * u;
    let w = 0.04 + 1.5 * swell;
    // Shear only the +Y flank: a smooth pressure face on one side, a shredded
    // shear layer on the other, which is what high-speed film actually shows.
    const shear = n.fbm(u * 4.6 - 3.3, y * 2.2 + 1.9, 4);
    const flank = smoothstep(0.0, 0.5, (y - lean) / Math.max(w, 1e-3));
    w *= 1 - flank * (1 - shear) * 0.5;
    const q = (y - lean) / Math.max(w, 1e-3);
    let a = Math.exp(-q * q * 2.0);
    // Tip: the gas has burnt out and is tearing into filaments.
    const frag = n.fbm(u * 6.8 + 12.7, y * 4.4 - 6.4, 4);
    a *= 1 - smoothstep(0.46, 1.0, u) * (1 - frag) * 1.5;
    // Internal turbulence so the body is not a smooth airbrushed blob.
    a *= 0.72 + 0.46 * n.fbm(u * 7.9 - 8.1, y * 3.6 + 15.2, 4);
    // Close the root with a rounded cap, and never let the tip touch the tile
    // edge (a clipped filament reads as a hard rectangle at this intensity).
    a *= smoothstep(-1.0, -0.86, x) * smoothstep(1.0, 0.86, u);
    a += Math.exp(-((x + 0.8) * (x + 0.8) * 13.0 + y * y * 30.0)) * 0.85;
    // Colour: white-hot at the choke, orange through the body, sooty at the
    // shredding tip and along the cool outer edges.
    const edge = clamp01(Math.abs(q) * 0.72);
    const t = clamp01(smoothstep(0.02, 0.72, u) * 0.85 + edge * 0.4);
    const soot = smoothstep(0.62, 1.0, u) * 0.34;
    const den = 0.82 + 0.34 * shear;
    out[0] = clamp01((1 - soot) * den);
    out[1] = clamp01((1 - 0.52 * t) * (1 - soot * 1.3) * den);
    out[2] = clamp01((1 - 0.84 * t) * (1 - soot * 1.6) * den);
    out[3] = clamp01(a);
  },
  // 7 — FLASH_CORE: the choked, boiling gas ball right at the crown. Drawn
  //     small and very hot, so what has to survive clipping is the *silhouette*:
  //     the radius is warped per-direction and the interior churns.
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const lump = n.fbm(Math.cos(ang) * 1.7 + 30.1, Math.sin(ang) * 1.7 + 9.4, 3);
    const churn = n.fbm(x * 3.1 - 5.5, y * 3.1 + 2.2, 4);
    const rr = r * (0.84 + 0.32 * lump) * (0.94 + 0.14 * churn);
    let a = Math.exp(-rr * rr * 15.0) * (0.74 + 0.48 * churn) + Math.exp(-rr * rr * 44) * 0.95;
    a *= smoothstep(1.02, 0.72, r);
    const t = smoothstep(0.0, 0.7, rr);
    out[0] = 1;
    out[1] = 1 - 0.2 * t;
    out[2] = 1 - 0.5 * t;
    out[3] = clamp01(a);
  },
  // 8 — CHIP: solid angular fleck of masonry
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const shape =
      0.52 + 0.34 * n.fbm(Math.cos(ang) * 1.8 + 5.5, Math.sin(ang) * 1.8 + 2.9, 2) - 0.1 * Math.abs(Math.sin(ang * 2.5));
    const a = smoothstep(shape, shape - 0.09, r);
    const facet = n.fbm(x * 3.4 - 4.2, y * 3.4 + 1.1, 3);
    const l = 0.34 + 0.5 * facet + 0.22 * clamp01(0.5 - y);
    out[0] = l;
    out[1] = l * 0.985;
    out[2] = l * 0.955;
    out[3] = a;
  },
  // 9 — SPLINTER: tapered sliver with visible grain
  (n, x, y, r, out) => {
    const bend = 0.16 * Math.sin(y * 2.1 + 1.3);
    const w = 0.155 * (1 - 0.72 * Math.abs(y)) * (0.7 + 0.6 * n.fbm(y * 4.4 + 2.2, 7.7, 2));
    const d = Math.abs(x - bend) / Math.max(0.02, w);
    const a = smoothstep(1.0, 0.72, d) * smoothstep(1.0, 0.9, Math.abs(y));
    const grain = n.fbm(x * 9 + 1.1, y * 2.2 - 3.3, 3);
    const l = 0.3 + 0.5 * grain;
    out[0] = l;
    out[1] = l * 0.82;
    out[2] = l * 0.6;
    out[3] = a;
  },
  // 10 — DROPLET: teardrop with a specular highlight (blood, water)
  (n, x, y, r, out) => {
    const yy = y * 0.92;
    const head = Math.hypot(x, (yy - 0.16) * 1.05) / 0.5;
    const tailW = 0.42 * clamp01(0.9 - yy * 0.75);
    const tail = Math.hypot(x / Math.max(0.03, tailW), (yy + 0.5) * 0.85);
    const a = clamp01(smoothstep(1.0, 0.82, head) + smoothstep(1.0, 0.55, tail) * 0.9);
    const spec = Math.exp(-((x + 0.16) * (x + 0.16) + (yy - 0.3) * (yy - 0.3)) * 26);
    const l = 0.55 + 0.45 * spec + 0.16 * clamp01(0.4 - yy);
    out[0] = Math.min(1, l);
    out[1] = Math.min(1, l * 0.9);
    out[2] = Math.min(1, l * 0.86);
    out[3] = a;
  },
  // 11 — MIST: very soft aerosol cloud (blood mist, fine spray)
  (n, x, y, r, out) => {
    const f = n.fbm(x * 5.2 + 31.4, y * 5.2 - 12.6, 5);
    let a = smoothstep(0.04, 0.9, (1 - r) * 0.95 + (f - 0.5) * 0.95) * 0.78;
    a *= smoothstep(1.02, 0.5, r);
    const l = 0.5 + 0.5 * f;
    out[0] = l;
    out[1] = l * 0.97;
    out[2] = l * 0.96;
    out[3] = a;
  },
  // 12 — SPLASH: sheet of water, dense at the base, shredding at the crown
  (n, x, y, r, out) => {
    const width = 0.66 - 0.3 * smoothstep(-1, 1, y);
    const col = 1 - Math.abs(x) / Math.max(0.05, width);
    const body = n.warped(x * 2.4 + 2.4, y * 1.5 - 9.1, 0.7, 4);
    const shred = n.fbm(x * 5.5 - 1.2, y * 3.0 + 4.4, 4);
    let a = smoothstep(0.0, 0.5, col + (body - 0.5) * 0.55);
    // the higher up the sheet, the more it has broken into ligaments
    a *= 1 - smoothstep(-0.2, 1.0, y) * (1 - shred) * 0.95;
    a *= smoothstep(1.04, 0.84, Math.abs(y));
    const drop = Math.exp(-((x - 0.12) * (x - 0.12) * 55 + (y - 0.74) * (y - 0.74) * 45));
    a = clamp01(a + drop * 0.5);
    const l = 0.58 + 0.42 * body + 0.12 * shred;
    out[0] = Math.min(1, l * 0.94);
    out[1] = Math.min(1, l * 0.98);
    out[2] = Math.min(1, l);
    out[3] = a;
  },
  // 13 — RING: shockwave / ripple annulus
  (n, x, y, r, out) => {
    const ang = Math.atan2(y, x);
    const wob = 1 + 0.055 * (n.fbm(Math.cos(ang) * 3.1 + 6.6, Math.sin(ang) * 3.1 - 2.2, 3) - 0.5);
    const t = (r * wob - 0.74) / 0.16;
    let a = Math.exp(-t * t * 3.2);
    a += smoothstep(0.78, 0.2, r) * 0.1;
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = clamp01(a) * smoothstep(1.0, 0.94, r);
  },
  // 14 — FIRE: dense billow, white-hot core to deep orange rim
  (n, x, y, r, out) => {
    const w = n.warped(x * 2.5 + 9.2, y * 2.5 + 17.5, 0.95, 5);
    let a = smoothstep(0.08, 0.6, 1 - r * 0.98 + (w - 0.5) * 0.8);
    a *= smoothstep(1.02, 0.6, r);
    const heat = clamp01(1.15 - r * 1.35 + (w - 0.5) * 0.65);
    out[0] = 1;
    out[1] = 0.28 + 0.7 * heat;
    out[2] = 0.06 + 0.82 * Math.pow(heat, 2.6);
    out[3] = a;
  },
  // 15 — MOTE: airborne speck, slightly irregular
  (n, x, y, r, out) => {
    const j = 1 + 0.3 * (n.fbm(x * 5 + 44.2, y * 5 - 17.3, 2) - 0.5);
    const a = Math.exp(-(r * j) * (r * j) * 11) * 0.95;
    out[0] = 1;
    out[1] = 0.99;
    out[2] = 0.96;
    out[3] = a * smoothstep(1.0, 0.8, r);
  },
];

