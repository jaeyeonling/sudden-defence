import * as THREE from 'three';
import { Noise, clamp01, smoothstep, encodeSrgb } from './noise.js';
import { PARTICLE_PAINTERS } from './atlas-particles.js';
import { DECAL_PAINTERS, DECAL_RELIEF } from './atlas-decals.js';

/**
 * Every FX texture in the game is baked here, once, at load time — there are no
 * image files anywhere in this project.
 *
 * Two atlases:
 *   PARTICLES  RGBA. RGB is a *detail/tint* field (internal density structure,
 *              hot-core gradients) that the shader multiplies by the
 *              per-particle colour; A is coverage.
 *   DECALS     albedo RGBA + normal RGB + ORM (r=ao, g=roughness, b=metalness),
 *              derived from a per-tile height field so bullet holes have real
 *              relief instead of being stickers.
 */

// ---------------------------------------------------------------------------
//  particle atlas layout (4x4)
// ---------------------------------------------------------------------------
export const P = {
  SMOKE_A: 0,
  SMOKE_B: 1,
  WISP: 2,
  DUST: 3,
  SPARK: 4,
  STREAK: 5,
  FLASH_LOBE: 6,
  FLASH_CORE: 7,
  CHIP: 8,
  SPLINTER: 9,
  DROPLET: 10,
  MIST: 11,
  SPLASH: 12,
  RING: 13,
  FIRE: 14,
  MOTE: 15,
};

// ---------------------------------------------------------------------------
//  decal atlas layout (4x4)
// ---------------------------------------------------------------------------
export const D = {
  HOLE_CONCRETE: 0,
  HOLE_CONCRETE_B: 1,
  HOLE_METAL: 2,
  HOLE_WOOD: 3,
  HOLE_PLASTER: 4,
  GLASS_CRACK: 5,
  BLOOD_A: 6,
  BLOOD_B: 7,
  SCORCH: 8,
  IMPACT_DIRT: 9,
  IMPACT_SAND: 10,
  SCRAPE: 11,
  RIPPLE: 12,
  HOLE_GLASS: 13,
  SMUDGE: 14,
  TEAR: 15,
};

const ATLAS_COLS = 4;

/**
 * The atlas builders. The tile painters live next door — `atlas-particles.js`
 * and `atlas-decals.js` — because they are pixel loops and this is the plumbing
 * that lays them out and uploads them.
 */

function makeTexture(data, size, { srgb, mips = true, name }) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = 4;
  t.name = name;
  t.needsUpdate = true;
  return t;
}

/**
 * Bake the particle sprite atlas.
 * @returns {{texture:THREE.DataTexture, cols:number, size:number}}
 */
export function buildParticleAtlas(rng, size = 1024) {
  const n = new Noise(rng);
  const tile = size / ATLAS_COLS;
  const data = new Uint8Array(size * size * 4);
  const out = [0, 0, 0, 0];
  for (let t = 0; t < 16; t++) {
    const paint = PARTICLE_PAINTERS[t];
    const ox = (t % ATLAS_COLS) * tile;
    const oy = Math.floor(t / ATLAS_COLS) * tile;
    for (let py = 0; py < tile; py++) {
      const y = ((py + 0.5) / tile) * 2 - 1;
      for (let px = 0; px < tile; px++) {
        const x = ((px + 0.5) / tile) * 2 - 1;
        const r = Math.hypot(x, y);
        out[0] = out[1] = out[2] = out[3] = 0;
        if (r < 1.45) paint(n, x, y, r, out);
        // A 1px transparent gutter stops bilinear/mip bleed between tiles.
        const gutter =
          px < 1 || py < 1 || px > tile - 2 || py > tile - 2 ? 0 : 1;
        const i = ((oy + py) * size + ox + px) * 4;
        data[i] = encodeSrgb(out[0]) * 255;
        data[i + 1] = encodeSrgb(out[1]) * 255;
        data[i + 2] = encodeSrgb(out[2]) * 255;
        data[i + 3] = clamp01(out[3]) * 255 * gutter;
      }
    }
  }
  return { texture: makeTexture(data, size, { srgb: true, name: 'fx-particles' }), cols: ATLAS_COLS, size };
}

/**
 * Bake the decal atlas: albedo+alpha, a normal map derived from the painted
 * height field, and packed ORM.
 */
export function buildDecalAtlas(rng, size = 1024) {
  const n = new Noise(rng);
  const tile = size / ATLAS_COLS;
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const out = [0, 0, 0, 0, 0.5, 1, 0];

  for (let t = 0; t < 16; t++) {
    const paint = DECAL_PAINTERS[t];
    const ox = (t % ATLAS_COLS) * tile;
    const oy = Math.floor(t / ATLAS_COLS) * tile;
    for (let py = 0; py < tile; py++) {
      const y = ((py + 0.5) / tile) * 2 - 1;
      for (let px = 0; px < tile; px++) {
        const x = ((px + 0.5) / tile) * 2 - 1;
        const r = Math.hypot(x, y);
        out[0] = out[1] = out[2] = out[3] = 0;
        out[4] = 0.5;
        out[5] = 1;
        out[6] = 0;
        if (r < 1.45) paint(n, x, y, r, out);
        const gutter = px < 1 || py < 1 || px > tile - 2 || py > tile - 2 ? 0 : 1;
        const idx = (oy + py) * size + ox + px;
        const i = idx * 4;
        albedo[i] = encodeSrgb(out[0]) * 255;
        albedo[i + 1] = encodeSrgb(out[1]) * 255;
        albedo[i + 2] = encodeSrgb(out[2]) * 255;
        albedo[i + 3] = clamp01(out[3]) * 255 * gutter;
        // ORM: r = baked AO (crevice darkening), g = roughness, b = metalness
        const ao = clamp01(0.35 + 0.65 * smoothstep(0.05, 0.55, out[4]));
        orm[i] = ao * 255;
        orm[i + 1] = clamp01(out[5]) * 255;
        orm[i + 2] = clamp01(out[6]) * 255;
        orm[i + 3] = 255;
        height[idx] = out[4];
      }
    }
  }

  // Height -> tangent-space normal, sampled inside the tile only.
  for (let t = 0; t < 16; t++) {
    const ox = (t % ATLAS_COLS) * tile;
    const oy = Math.floor(t / ATLAS_COLS) * tile;
    const relief = DECAL_RELIEF[t] * (tile / 256);
    for (let py = 0; py < tile; py++) {
      for (let px = 0; px < tile; px++) {
        const cx = Math.min(tile - 2, Math.max(1, px));
        const cy = Math.min(tile - 2, Math.max(1, py));
        const at = (dx, dy) => height[(oy + cy + dy) * size + ox + cx + dx];
        const gx = (at(1, 0) - at(-1, 0)) * relief * 8;
        const gy = (at(0, 1) - at(0, -1)) * relief * 8;
        let nx = -gx;
        let ny = -gy;
        let nz = 1;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        const i = ((oy + py) * size + ox + px) * 4;
        normal[i] = (nx * 0.5 + 0.5) * 255;
        normal[i + 1] = (ny * 0.5 + 0.5) * 255;
        normal[i + 2] = (nz * 0.5 + 0.5) * 255;
        normal[i + 3] = 255;
      }
    }
  }

  return {
    albedo: makeTexture(albedo, size, { srgb: true, name: 'fx-decal-albedo' }),
    normal: makeTexture(normal, size, { srgb: false, name: 'fx-decal-normal' }),
    orm: makeTexture(orm, size, { srgb: false, name: 'fx-decal-orm' }),
    cols: ATLAS_COLS,
    size,
  };
}

/**
 * Brass casing maps: drawn seams, extractor scuffing and a machined-rim
 * roughness break so casings never read as plastic.
 */
export function buildBrassTextures(rng, size = 256) {
  const n = new Noise(rng);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Drawing marks run along the casing axis (V), machining rings across it.
      const draw = n.fbm(u * 42, v * 3.5, 3);
      const rings = Math.sin(v * 190) * 0.5 + 0.5;
      const scuff = Math.pow(clamp01(1 - n.worleyEdge(u * 9, v * 9) * 7), 2);
      h[y * size + x] = 0.5 + (draw - 0.5) * 0.35 + (rings - 0.5) * 0.08 - scuff * 0.25;
      const i = (y * size + x) * 4;
      // AO in the scuffs, roughness up where the brass is abraded.
      orm[i] = clamp01(1 - scuff * 0.55) * 255;
      orm[i + 1] = clamp01(0.19 + 0.3 * scuff + 0.12 * draw) * 255;
      orm[i + 2] = 255;
      orm[i + 3] = 255;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (dx, dy) => h[(((y + dy) % size) + size) % size * size + ((((x + dx) % size) + size) % size)];
      const gx = (at(1, 0) - at(-1, 0)) * 5;
      const gy = (at(0, 1) - at(0, -1)) * 5;
      const nx = -gx;
      const ny = -gy;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      normal[i] = (nx / l * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }
  const nt = makeTexture(normal, size, { srgb: false, name: 'fx-brass-normal' });
  const ot = makeTexture(orm, size, { srgb: false, name: 'fx-brass-orm' });
  nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
  ot.wrapS = ot.wrapT = THREE.RepeatWrapping;
  return { normal: nt, orm: ot };
}

