import * as THREE from 'three';
import { dsin } from '../core/dmath.js';
import {
  CAMO,
  KIT_CAL,
  TileNoise,
  bake,
  bakeDetail,
  cellDist,
  lum3,
  makeCamoSampler,
  mix,
  mix3,
  ridgeLine,
  smooth,
} from './textures-bake.js';

/**
 * The character material set. The bakes it draws from — tileable noise, the
 * camo generator, the albedo budget — are in `textures-bake.js`; this file is
 * what turns them into materials.
 */

/* ------------------------------------------------------------------ */
/* Silhouette preservation                                             */
/* ------------------------------------------------------------------ */

/**
 * VIEW-DEPENDENT EDGE DARKENING — the second half of the "read as a person
 * against a blown sky" problem, and the half albedo cannot solve.
 *
 * A character standing against a 0.94-linear sky loses its outline for two
 * reasons: the sky is brighter than anything physical the figure can be, and
 * bloom bleeds the sky *over* the last few pixels of him. Both are fixed by the
 * same thing a real photograph gets for free — a body is a closed surface, so at
 * its outline you are looking along the surface, through the full thickness of
 * fabric nap, dust and self-shadowing. Almost nothing comes back.
 *
 * So: outgoing radiance is scaled by `1 - strength * smoothstep(edge,1,1-|N.V|)^power`
 * using the GEOMETRIC normal (not the detail-perturbed one — perturbing the rim
 * makes it crawl). The band is confined to the outer sliver of every curved
 * surface, which is exactly the silhouette, and it takes the specular Fresnel
 * with it: the grazing highlight is precisely what was making the balcony figure
 * read as a piece of sky.
 *
 *   strength 0.62  measured: a 0.09-albedo uniform against 0.94 sky ends at
 *                  ~0.10 screen linear, i.e. > 80 % outline contrast; the AD
 *                  asked for >= 25 %.
 *   edge     0.42  |N.V| < 0.58 — roughly the outer 18 % of a limb's width, so
 *                  it reads as form shading rather than a drawn line.
 *   power    1.9   soft enough that it never becomes a cartoon outline.
 */
export const RIM = { strength: 0.62, edge: 0.42, power: 1.9 };

/* ------------------------------------------------------------------ */
/* Public: the material set                                            */
/* ------------------------------------------------------------------ */

export class SoldierMaterials {
  /**
   * @param rng   deterministic Rng
   * @param opts  { size, anisotropy, camo: string[] }
   */
  constructor(rng, opts = {}) {
    const size = opts.size ?? 512;
    const aniso = opts.anisotropy ?? 8;
    const nz = new TileNoise(rng.fork({ snapshot: false }));
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

    this.sets = {};
    this.materials = new Map();
    this._disposables = [];

    // ---- camouflage cloth, one bake per pattern ------------------------
    // Measure first, then bake through the budget remap, then report what the
    // map actually is. A camo bake that is never measured drifts every time the
    // noise is touched, and the figure goes chalky without anybody noticing.
    this.camoStats = {};
    for (const name of opts.camo ?? ['arid', 'woodland']) {
      const cfg = CAMO[name] ?? CAMO.arid;
      const sample = makeCamoSampler(nz, cfg);
      let s = 0;
      let s2 = 0;
      let mn = Infinity;
      let mx = -Infinity;
      let n = 0;
      this.sets[`camo_${name}`] = bake(
        size,
        (u, v, out) => {
          sample(u, v, out);
          const l = lum3(out.r, out.g, out.b);
          s += l;
          s2 += l * l;
          n++;
          if (l < mn) mn = l;
          if (l > mx) mx = l;
        },
        aniso,
        0.9
      );
      const mean = s / n;
      this.camoStats[name] = {
        mean,
        sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)),
        min: mn,
        max: mx,
        was: sample.srcMean,
      };
    }

    // ---- cordura nylon: webbing, pouches, boot uppers, gloves ----------
    // Base albedo sits at the TOP of the plausible range (0.30) so the assembly
    // can place each piece of kit below it with a vertex tint: pouches 0.19,
    // webbing 0.13, sling 0.12, gloves 0.07, boots 0.055. One material, five
    // values — that internal value hierarchy is what breaks the "one extruded
    // blob" read at 25 m.
    this.sets.nylon = bake(
      size,
      (u, v, out) => {
        // 1000D cordura at 0.26 m/tile: the basket weave is 1 mm, the binding
        // tape and bar-tacks are the things this tile actually has to carry
        const tu = u * 26, tv = v * 26;
        const cell = dsin(tu * Math.PI) * dsin(tv * Math.PI);
        let h = cell * 0.34;
        h += (nz.fbm(u, v, 120, 2) - 0.5) * 0.30;
        // PALS ribbing: 6 mm ribs, but only across the patches of the tile that
        // are webbing rather than plain cordura
        const rib = cellDist(v * 44);
        const ribGate = smooth(0.52, 0.70, nz.fbm(u + 8.3, v, 5, 2));
        h += ribGate * (ridgeLine(rib, 0.30) - 0.5) * 0.30;
        // binding tape + bar-tacks on the hem rows (every 1/3 tile ~ 87 mm)
        const st = cellDist(v * 3);
        const tape = ridgeLine(st, 0.045);
        h += tape * 0.14;
        h += ridgeLine(st, 0.020) * (0.5 + 0.5 * dsin(u * 300)) * 0.30;
        out.h = h;
        const shade = 0.84 + 0.16 * nz.fbm(u, v, 7, 3);
        const base = 0.300 * KIT_CAL * shade;
        out.r = base * 1.05;
        out.g = base * 1.0;
        out.b = base * 0.90;
        // thread is paler and shinier than the webbing
        const thr = ridgeLine(st, 0.020) * (0.25 + 0.25 * dsin(u * 300));
        out.r = mix(out.r, 0.335 * KIT_CAL, thr);
        out.g = mix(out.g, 0.320 * KIT_CAL, thr);
        out.b = mix(out.b, 0.278 * KIT_CAL, thr);
        out.rough = 0.79 - 0.13 * smooth(-0.4, 0.9, h) + 0.05 * (nz.fbm(u + 2, v, 11, 2) - 0.5);
        out.metal = 0;
        out.ao = 0.80 + 0.20 * smooth(-0.5, 1.0, h);
      },
      aniso,
      1.15
    );

    // ---- laminated plate-carrier shell / painted helmet shell ----------
    // A carrier is not webbing: it is a laminate over a foam-backed plate, so it
    // is smoother (0.55-0.70) than the cloth around it and darker than the
    // pouches bolted to it. Quilted stitch grid, scuffed high points.
    this.sets.plate = bake(
      size,
      (u, v, out) => {
        // quilting: a diamond stitch grid pressed into the laminate, and the
        // panels between it bulging over the foam
        const qu = cellDist(u * 5 + v * 2.5);
        const qv = cellDist(u * -2.5 + v * 5);
        let h = -(ridgeLine(qu, 0.045) + ridgeLine(qv, 0.045)) * 0.42;
        h += (1 - Math.max(ridgeLine(qu, 0.30), ridgeLine(qv, 0.30))) * 0.26;
        // laminate grain + abrasion
        const grain = nz.fbm(u, v, 90, 3);
        h += (grain - 0.5) * 0.24;
        const scuff = smooth(0.62, 0.86, nz.ridge(u * 0.7, v * 2.4, 22, 3));
        h -= scuff * 0.18;
        out.h = h;
        // Macro value variation. A carrier is the one part of the kit that is
        // pure flat colour if you let it be, and a flat slab in the middle of
        // the chest is the single loudest "moulded toy" cue on the model: sun
        // fade on the panels that face up, dust settled in the quilting, dried
        // sweat salt along the cummerbund.
        const fade = nz.fbm(u + 3.3, v, 3, 3);
        const soil = nz.fbm(u + 7.7, v + 2.1, 8, 3);
        const shade = 0.74 + 0.40 * fade;
        const base = 0.212 * KIT_CAL * shade;
        out.r = base * 1.04;
        out.g = base * 1.0;
        out.b = base * 0.93;
        // ground-in dust and grease darken the low panels
        out.r = mix(out.r, out.r * 0.66, smooth(0.44, 0.68, soil));
        out.g = mix(out.g, out.g * 0.64, smooth(0.44, 0.68, soil));
        out.b = mix(out.b, out.b * 0.60, smooth(0.44, 0.68, soil));
        // scuffs abrade to a paler, rougher grey
        out.r = mix(out.r, 0.283 * KIT_CAL, scuff * 0.7);
        out.g = mix(out.g, 0.274 * KIT_CAL, scuff * 0.7);
        out.b = mix(out.b, 0.258 * KIT_CAL, scuff * 0.7);
        // 0.55-0.72: laminate, markedly smoother than the 0.87-0.92 cloth
        // around it, and rougher again where it has been abraded
        out.rough = 0.590 + 0.060 * smooth(-0.5, 0.7, -h) + 0.09 * scuff +
          0.05 * smooth(0.44, 0.68, soil) + 0.025 * (nz.fbm(u, v + 5.1, 13, 2) - 0.5);
        out.metal = 0;
        out.ao = 0.82 + 0.18 * smooth(-0.7, 0.7, h);
      },
      aniso,
      1.05
    );

    // ---- skin ---------------------------------------------------------
    this.sets.skin = bake(
      size,
      (u, v, out) => {
        const pores = nz.fbm(u, v, 150, 3);
        const macro = nz.fbm(u, v, 11, 3);
        const fine = nz.fbm(u, v, 320, 2);
        out.h = (pores - 0.5) * 0.5 + (fine - 0.5) * 0.25;
        // Fitzpatrick IV base; per-instance tint shifts it
        const base = [0.295, 0.199, 0.148];
        const flush = [0.330, 0.186, 0.142];
        let col = mix3(base, flush, smooth(0.4, 0.75, macro));
        // stubble / beard shadow band handled by vertex colour; here just
        // follicle speckle
        const st = nz.fbm(u * 1.3, v * 1.3, 110, 2);
        col = mix3(col, [0.115, 0.086, 0.074], smooth(0.62, 0.72, st) * 0.5);
        out.r = col[0]; out.g = col[1]; out.b = col[2];
        out.rough = 0.50 + 0.16 * macro - 0.10 * pores;
        out.metal = 0;
        out.ao = 0.9 + 0.1 * pores;
      },
      aniso,
      0.75
    );

    // ---- glass-filled polymer: weapon furniture, knee pads, buckles ---
    this.sets.polymer = bake(
      size,
      (u, v, out) => {
        // moulded pebble stipple + parting-line sheen
        const stip = nz.fbm(u, v, 128, 3);
        const peb = smooth(0.45, 0.62, nz.fbm(u, v, 64, 2));
        out.h = (stip - 0.5) * 0.6 + peb * 0.35;
        const scr = smooth(0.86, 1.0, nz.ridge(u * 0.6, v * 3.0, 26, 2));
        const v0 = 0.052 * (0.9 + 0.2 * nz.fbm(u, v, 8, 2));
        out.r = mix(v0 * 1.02, 0.20, scr * 0.5);
        out.g = mix(v0, 0.195, scr * 0.5);
        out.b = mix(v0 * 0.98, 0.19, scr * 0.5);
        out.rough = 0.55 - 0.18 * peb + 0.10 * stip - 0.25 * scr;
        out.metal = 0;
        out.ao = 0.88 + 0.12 * stip;
      },
      aniso,
      1.0
    );

    // ---- parkerised / phosphated steel --------------------------------
    this.sets.steel = bake(
      size,
      (u, v, out) => {
        const grain = nz.fbm(u * 0.25, v * 3.0, 90, 3);
        const scratch = smooth(0.80, 1.0, nz.ridge(u * 0.3, v * 6.0, 40, 3));
        const pits = smooth(0.72, 0.9, nz.fbm(u, v, 190, 2));
        out.h = (grain - 0.5) * 0.35 + scratch * 0.5 - pits * 0.45;
        const base = 0.055 + 0.02 * grain;
        // bare steel where the finish has rubbed through
        const bare = scratch * 0.85;
        out.r = mix(base, 0.52, bare);
        out.g = mix(base, 0.53, bare);
        out.b = mix(base * 1.02, 0.55, bare);
        out.rough = mix(0.46 + 0.14 * grain + 0.2 * pits, 0.20, bare);
        out.metal = 1;
        out.ao = 0.9 + 0.1 * grain - 0.2 * pits;
      },
      aniso,
      1.1
    );

    // ---- vulcanised rubber: boot soles, sling pads --------------------
    this.sets.rubber = bake(
      size,
      (u, v, out) => {
        // lug pattern: deep sipes cut between raised blocks
        const lug = Math.max(ridgeLine(cellDist(u * 9), 0.085), ridgeLine(cellDist(v * 5.5), 0.095));
        const grain = nz.fbm(u, v, 160, 3);
        out.h = -lug * 1.1 + (grain - 0.5) * 0.4;
        const c = 0.036 + 0.016 * grain;
        out.r = c; out.g = c * 0.99; out.b = c * 0.97;
        out.rough = 0.82 - 0.1 * grain + 0.08 * lug;
        out.metal = 0;
        out.ao = 0.72 + 0.28 * (1 - lug);
      },
      aniso,
      1.4
    );

    /* ---------------- detail tiles: the high-frequency half -------------- */
    // 5 cm of surface per tile. Blended into the base normal + roughness inside
    // the shader, so a 1.5 mm weave survives no matter how large the base tile
    // has to be to carry the macro camo blotches.
    this.details = {};
    const dsize = Math.min(512, size);

    // ripstop cloth: 2-over-2 twill at ~1.5 mm plus the 7 mm ripstop lattice
    this.details.cloth = bakeDetail(
      dsize,
      (u, v, out) => {
        const threads = 33; // 50 mm / 1.5 mm
        const tu = u * threads, tv = v * threads;
        const wu = dsin(tu * Math.PI * 2);
        const wv = dsin(tv * Math.PI * 2);
        const over = dsin((tu + tv) * Math.PI) > 0;
        let h = (over ? wu * 0.62 + wv * 0.22 : wv * 0.62 + wu * 0.22) * 0.5;
        // ripstop reinforcement lattice: a doubled thread every 8 mm
        h += (ridgeLine(cellDist(u * 6), 0.055) + ridgeLine(cellDist(v * 6), 0.055)) * 0.30;
        // fibre fuzz
        h += (nz.fbm(u, v, 160, 2) - 0.5) * 0.26;
        out.h = h;
        // raised fuzz scatters more: nap crowns read rougher than the valleys
        out.rough = 0.32 * h - 0.18 * (nz.fbm(u + 2.7, v, 90, 2) - 0.5);
      },
      aniso,
      1.05
    );

    // nylon webbing / cordura: chunky basket weave with a resin sheen
    this.details.nylon = bakeDetail(
      dsize,
      (u, v, out) => {
        const cellsU = 25, cellsV = 25; // 2 mm basket
        const cu = Math.abs((((u * cellsU) % 1) + 1) % 1 - 0.5);
        const cv = Math.abs((((v * cellsV) % 1) + 1) % 1 - 0.5);
        const over = dsin((u * cellsU + v * cellsV) * Math.PI) > 0;
        let h = (over ? smooth(0.5, 0.1, cu) : smooth(0.5, 0.1, cv)) * 0.7 - 0.25;
        h += (nz.fbm(u, v, 140, 2) - 0.5) * 0.22;
        out.h = h;
        // the resin on the crowns of the weave is markedly smoother
        out.rough = -0.42 * h + 0.10 * (nz.fbm(u + 4.1, v, 70, 2) - 0.5);
      },
      aniso,
      1.15
    );

    this.bakeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    for (const k in this.sets) {
      const s = this.sets[k];
      this._disposables.push(s.albedo, s.normal, s.orm);
    }
    for (const k in this.details) this._disposables.push(this.details[k]);
  }

  /**
   * Build (and cache) a MeshStandardMaterial for a set.
   * opts: { tint:[r,g,b], rough, metal, normalScale, key, side, transparent,
   *         detail: { set, scale, normal, rough } }
   *
   * Everything here stays a plain MeshStandardMaterial, which is what lets
   * render's MaterialPatcher inject the CSM shadow, the contact shadow, GTAO and
   * SSR into it. The detail layer is added through `onBeforeCompile`, and the
   * patcher chains our hook (it calls the previous one first), so the two
   * coexist. `customProgramCacheKey` is mandatory: without it three would hand
   * the detail-blended program to the skin material, which shares every define.
   */
  get(setName, opts = {}) {
    const d = opts.detail;
    const key = `${setName}|${opts.key ?? ''}|${(opts.tint ?? []).join(',')}|${opts.rough ?? ''}|${
      opts.metal ?? ''
    }|${d ? `${d.set},${d.scale},${d.normal},${d.rough}` : ''}`;
    let m = this.materials.get(key);
    if (m) return m;
    const set = this.sets[setName];
    if (!set) throw new Error(`[ai] unknown material set "${setName}"`);
    m = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      aoMap: set.orm,
      vertexColors: true,
      roughness: opts.rough ?? 1,
      metalness: opts.metal ?? 1,
      color: opts.tint ? new THREE.Color(opts.tint[0], opts.tint[1], opts.tint[2]) : 0xffffff,
      side: opts.side ?? THREE.FrontSide,
      dithering: true,
    });
    m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    m.aoMapIntensity = opts.ao ?? 0.85;
    m.name = `ai_${setName}`;
    this._attachShader(m, d && this.details[d.set] ? d : null, opts.rim);
    this.materials.set(key, m);
    return m;
  }

  /**
   * Install the character shader hooks: the high-frequency detail tile (when the
   * set has one) and the silhouette edge-darkening term (always).
   *
   * Both live in ONE onBeforeCompile because render's MaterialPatcher chains
   * whatever hook it finds — it calls ours first, then injects the CSM shadow,
   * contact shadow, GTAO and bounce fill. `customProgramCacheKey` must describe
   * every branch below or three hands the detail-blended program to the skin
   * material, which shares every define.
   */
  _attachShader(m, d, rimScale = 1) {
    const rim = new THREE.Vector4(
      RIM.strength * rimScale,
      RIM.edge,
      RIM.power,
      0
    );
    const uni = {
      owDetailTex: { value: d ? this.details[d.set] : null },
      owDetailParams: {
        value: new THREE.Vector3(d?.scale ?? 8, d?.normal ?? 0.7, d?.rough ?? 0.2),
      },
      owCharRim: { value: rim },
    };
    m.userData.owDetailUniforms = uni;
    m.userData.owCharRim = uni.owCharRim;
    const tag = `ai-${d ? `detail-${d.set}-${d.scale}` : 'plain'}-rim${rim.x.toFixed(2)}`;
    m.customProgramCacheKey = () => tag;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.owCharRim = uni.owCharRim;
      shader.fragmentShader = 'uniform vec4 owCharRim;\n' + shader.fragmentShader;
      if (d) {
        shader.uniforms.owDetailTex = uni.owDetailTex;
        shader.uniforms.owDetailParams = uni.owDetailParams;
        shader.fragmentShader =
          'uniform sampler2D owDetailTex;\nuniform vec3 owDetailParams;\n' + shader.fragmentShader;
        // roughness: the detail alpha is a signed delta around 0.5
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = clamp( roughnessFactor +
            ( texture2D( owDetailTex, vNormalMapUv * owDetailParams.x ).w - 0.5 ) * owDetailParams.z,
            0.04, 1.0 );`
        );
        // normal: add the detail tangent slope to the base one before the TBN
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `vec3 owMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          owMapN.xy *= normalScale;
          owMapN.xy += ( texture2D( owDetailTex, vNormalMapUv * owDetailParams.x ).xy * 2.0 - 1.0 )
            * owDetailParams.y;
          normal = normalize( tbn * normalize( owMapN ) );`
        );
      }
      // silhouette: darken the grazing sliver of every closed surface, using the
      // geometric normal so the band cannot crawl with the detail tile.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `{
          float owF = 1.0 - abs( dot( normalize( vViewPosition ), nonPerturbedNormal ) );
          float owEdge = pow( smoothstep( owCharRim.y, 1.0, owF ), owCharRim.z );
          outgoingLight *= 1.0 - owCharRim.x * owEdge;
        }
        #include <opaque_fragment>`
      );
    };
  }

  /** Flat material for goggle lenses / optic glass. */
  glass(tint = [0.06, 0.07, 0.08]) {
    let m = this.materials.get('glass');
    if (m) return m;
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(tint[0], tint[1], tint[2]),
      roughness: 0.11,
      metalness: 0.0,
      vertexColors: true,
      envMapIntensity: 1.4,
    });
    m.name = 'ai_glass';
    // A goggle lens is the one place a *bright* grazing highlight is correct, so
    // the edge term runs at half strength: enough that the lens rim does not
    // bloom into the sky, not enough to kill the sheen that makes it read glass.
    this._attachShader(m, null, 0.5);
    this.materials.set('glass', m);
    return m;
  }

  dispose() {
    for (const t of this._disposables) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this._disposables.length = 0;
  }
}

