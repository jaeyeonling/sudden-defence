import { MATERIALS, ROUGH, DETAIL_TILE, VARIANTS, teamMarkerTint } from './soldier-palette.js';

/**
 * Every material slot a soldier's geometry is grouped by, IN THE ORDER
 * `CharacterBuilder.build()` emits them — which is the order the parts are added
 * above, deduplicated. All three variants use all ten.
 *
 * THE ORDER IS LOad-BEARING, and this is not a style preference. `THREE.Material`
 * hands out globally incrementing ids and three sorts the opaque render list by
 * `material.id` (`painterSortStable`), including the ten groups *within* one
 * soldier. Create them in a different order and the goggle lens draws before its
 * frame instead of after it; with a depth prepass in front, whichever coplanar
 * surface is drawn last wins the equal-depth test. MEASURED: prewarming these in
 * a hand-written order moved 2 pixels of the `combat` shot by 1/255 and failed
 * the pixel gate. `buildSoldier` asserts the order below still matches.
 */
export const MATERIAL_SLOTS = Object.freeze([
  'cloth', 'team', 'gear', 'boot', 'rubber', 'plate', 'polymer', 'skin', 'glass', 'steel',
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

