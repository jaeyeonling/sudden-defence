import * as THREE from 'three';
import { CLOTH_LIGHT, MAIN_FRAGMENT, MAIN_VERTEX, PARS_FRAGMENT, PARS_VERTEX } from './shader-glsl.js';

/**
 * Shader patching — what gets injected where, the default uniform set, and
 * `extendMaterial`. The GLSL itself is in `shader-glsl.js`.
 */

/** Chunk overrides applied after the main injection. */
const OVERRIDES = [
  ['#include <color_fragment>', '// vertex colours are masks here, see OW_VCOL_MASKS'],
  ['#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CLOTH_LIGHT],
  ['#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * owORM.g;'],
  ['#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * owORM.b;'],
  ['#include <normal_fragment_maps>', 'normal = owNormalV;'],
  [
    '#include <aomap_fragment>',
    /* glsl */ `
    {
      float ambientOcclusion = ( owORM.r - 1.0 ) * owAoAmt + 1.0;
      reflectedLight.indirectDiffuse *= ambientOcclusion;
      #if defined( USE_CLEARCOAT )
        clearcoatSpecularIndirect *= ambientOcclusion;
      #endif
      #if defined( USE_SHEEN )
        sheenSpecularIndirect *= ambientOcclusion;
      #endif
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        // Specular occlusion on top of an already AO-heavy cavity map wipes out
        // every glint on detailed geometry, so it only gets 60% of the term.
        float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
        float aoSpec = mix( 1.0, clamp( ambientOcclusion, 0.0, 1.0 ), 0.6 );
        reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, aoSpec, material.roughness );
      #endif
    }`,
  ],
];

export const DEFAULT_PARAMS = {
  /** 'planar' (world dominant axis) | 'triplanar' | 'mesh' */
  uvMode: 'planar',
  /** project in the object's local space instead of world space */
  localSpace: false,
  /** metres per texture tile */
  scale: 2,
  /** uv offset */
  offset: [0, 0],
  /** parallax depth in metres; 0 disables */
  parallax: 0,
  parallaxFade: [6, 14],
  parallaxLayers: 22,
  /** detail layer: tiles-per-base-tile, normal strength, albedo strength, fade metres */
  detail: [11, 0.55, 0.35, 16],
  /**
   * Metres the shared detail tile should span in the world.
   *
   * detail[0] is expressed *per base tile*, which silently ties the micro
   * layer's world scale to the macro layer's. A prop-scale variant such as
   * `wood_prop` (scale 0.55 m) with detail[0] = 10 was mapping the 0.25 m
   * detail bake into 55 mm — every 1.6 mm grain became 0.35 mm, i.e. under one
   * pixel at 0.5 m, so the entire micro layer filtered away to nothing and
   * every prop read as flat colour up close. That is measurable: cranking
   * detail[2] from 0.42 to 2.5 on the market stall changed the frame by
   * nothing at all.
   *
   * So detail[0] is now DERIVED from `scale` unless this is set to 0, which
   * keeps the micro tooth at a fixed physical size no matter how the surface
   * is mapped. 0.26 m matches the bake's authored worldSize of 0.25 m.
   */
  detailWorld: 0.26,
  /** macro: world scale, albedo strength, roughness strength, hue strength */
  macro: [0.045, 0.35, 0.1, 0.35],
  /**
   * Macro contrast expansion plus a second, much larger band:
   * [ contrast, bigAmplitude, bigWorldScale, unused ]. 1/bigWorldScale is the
   * period of the macro texture in metres, and its coarsest band is a third of
   * that — so 0.028 gives ~12 m features.
   */
  macroBig: [1, 0, 0.03, 0],
  /**
   * Repair patches on vertical faces: [ coverage 0..1, cell metres,
   * albedo delta, roughness delta ]. 0 coverage disables the layer.
   */
  patch: [0, 2.6, 0.12, -0.08],
  /**
   * Fabric: [ transmission 0..1, underside albedo multiplier, fold amount,
   * unused ]. transmission 0 and multiplier 1 disable the whole cloth layer.
   */
  cloth: [0, 1, 0, 0],
  /** macro-gradient normal tilt on up-facing surfaces (ruts / drifts); 0 = off */
  macroRelief: 0,
  /** de-tiling second-sample blend amount (0 disables the extra fetches) */
  detile: 0,
  /** weathering: dust, rain streaks, ground-splash height, cavity grime */
  weather: [0.35, 0.3, 0.55, 0.4],
  groundY: 0,
  /** vertex-colour masks: wear, grime, extra AO, unused */
  wear: [0.5, 0.7, 0.5, 0],
  /**
   * [ roughness, METALNESS, unused, tint amount ] where the wear mask is 1.
   *
   * The metalness used to default to 0.5, so every worn edge on concrete,
   * plaster, brick, timber, hessian and the road turned half metal and picked
   * up a specular tint it has no business having. Only the metal library
   * entries — which set their own wearMaterial — should ever raise this.
   */
  wearMaterial: [0.42, 0.0, 0, 0.5],
  wearColor: 0x8d8b86,
  dustColor: 0x6b6154,
  grimeColor: 0x2a2620,
  rustColor: 0x6d3a1c,
  tint: 0xffffff,
  normalStrength: 1,
  /** roughness [ scale, offset, minimum ] */
  roughness: [1, 0, 0.06],
  aoStrength: 1,
  alphaMask: false,
  vertexMasks: false,
  noGrad: false,
};

/** THREE.Color already converts hex (sRGB) into the linear working space. */
function col(v) {
  return v instanceof THREE.Color ? v.clone() : new THREE.Color(v);
}

/**
 * Install the extension on a material.
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} p        merged parameters (see DEFAULT_PARAMS)
 * @param {object} shared   { detailNormal, macro }
 */
export function extendMaterial(material, p, shared) {
  // Mesh-UV mode treats `scale` as a repeat count; projected modes treat it as
  // metres per tile.
  const tileScale = p.uvMode === 'mesh' ? p.scale : 1 / p.scale;

  /**
   * Keep the micro tooth at a fixed size in metres (see DEFAULT_PARAMS.detailWorld).
   *
   * Only for surfaces mapped at 0.3 m or coarser — i.e. architecture, ground
   * and world props. A viewmodel part is mapped at 0.02-0.12 m and wants its
   * detail an order of magnitude finer than a wall's; forcing 0.26 m on it
   * would put a 2 mm aggregate tooth on a bolt carrier.
   */
  const dw = p.detailWorld ?? DEFAULT_PARAMS.detailWorld;
  const detailTiles =
    p.uvMode === 'mesh' || !(dw > 0) || p.scale < 0.3
      ? p.detail[0]
      : Math.max(1.2, p.scale / dw);

  const u = {
    owDetailNrm: { value: shared.detailNormal },
    owDetailTex: { value: shared.detailAlbedo ?? shared.detailNormal },
    owMacroTex: { value: shared.macro },
    owTile: { value: new THREE.Vector4(tileScale, tileScale, p.offset[0], p.offset[1]) },
    owDetailP: {
      value: new THREE.Vector4(detailTiles, p.detail[1], p.detail[2], p.detail[3]),
    },
    owMacroP: { value: new THREE.Vector4(...p.macro) },
    owMacroBig: { value: new THREE.Vector4(...(p.macroBig ?? DEFAULT_PARAMS.macroBig)) },
    owPatchP: { value: new THREE.Vector4(...(p.patch ?? DEFAULT_PARAMS.patch)) },
    owClothP: { value: new THREE.Vector4(...(p.cloth ?? DEFAULT_PARAMS.cloth)) },
    owParallaxP: {
      value: new THREE.Vector4(p.parallax, p.parallaxFade[0], p.parallaxFade[1], p.parallaxLayers),
    },
    owWeatherP: { value: new THREE.Vector4(...p.weather) },
    owWearP: { value: new THREE.Vector4(...p.wear) },
    owTintCol: { value: col(p.tint) },
    owDustCol: { value: col(p.dustColor) },
    owGrimeCol: { value: col(p.grimeColor) },
    owRustCol: { value: col(p.rustColor ?? DEFAULT_PARAMS.rustColor) },
    owWearCol: { value: col(p.wearColor) },
    owWearMat: { value: new THREE.Vector4(...p.wearMaterial) },
    owRoughP: {
      value: new THREE.Vector4(
        p.roughness[0],
        p.roughness[1],
        p.detile,
        p.roughness[2] ?? DEFAULT_PARAMS.roughness[2]
      ),
    },
    owNormalAmp: { value: p.normalStrength },
    owGroundY: { value: p.groundY },
    owAoAmt: { value: p.aoStrength },
    owMacroRelief: { value: p.macroRelief ?? 0 },
  };

  const defines = {};
  if (p.uvMode === 'triplanar') defines.OW_TRIPLANAR = '';
  else if (p.uvMode === 'mesh') defines.OW_MESH_UV = '';
  if (p.localSpace) defines.OW_OBJECT_SPACE = '';
  if (p.parallax > 0 && p.uvMode !== 'triplanar') defines.OW_PARALLAX = '';
  if (p.detile > 0 && p.uvMode !== 'triplanar') defines.OW_DETILE = '';
  if (p.weather[0] > 0 || p.weather[1] > 0 || p.weather[2] > 0) defines.OW_WEATHER = '';
  if ((p.patch?.[0] ?? 0) > 0) defines.OW_PATCH = '';
  if ((p.cloth?.[0] ?? 0) > 0 || (p.cloth?.[1] ?? 1) < 1) defines.OW_CLOTH = '';
  if ((p.macroRelief ?? 0) > 0) defines.OW_MACRO_RELIEF = '';
  if (p.vertexMasks) defines.OW_VCOL_MASKS = '';
  if (p.alphaMask) defines.OW_ALPHA_MASK = '';
  if (p.noGrad) defines.OW_NOGRAD = '';

  Object.assign(material.defines ?? (material.defines = {}), defines);
  material.userData.owUniforms = u;
  material.userData.owParams = p;

  const key = Object.keys(defines).sort().join('|');
  material.customProgramCacheKey = () => 'ow:' + key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_VERTEX)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + MAIN_VERTEX);

    // The pars block must land *after* three has declared map / normalMap /
    // roughnessMap, so it hooks the last pars include rather than <common>.
    let fs = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        '#include <clipping_planes_pars_fragment>\n' + PARS_FRAGMENT
      )
      .replace('#include <map_fragment>', MAIN_FRAGMENT);

    for (const [find, repl] of OVERRIDES) fs = fs.replace(find, repl);
    shader.fragmentShader = fs;
  };

  material.needsUpdate = true;
  return material;
}

