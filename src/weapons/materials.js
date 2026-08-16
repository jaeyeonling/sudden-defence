import * as THREE from 'three';
import { hypot2 } from '../core/dmath.js';
import { WEAPON_MATERIALS } from './materials-table.js';

/**
 * How much of the sky hemisphere a shouldered weapon actually sees. Applied to
 * every weapon/hand material's envMapIntensity — see WeaponMaterials.get() —
 * AND to `viewScene.environmentIntensity` in index.js, which is the one that
 * actually bites: three ignores `material.envMapIntensity` for a material lit by
 * `scene.environment` alone.
 */
export const ENV_OCCLUSION = 0.24;

/**
 * Resolves and caches the weapon materials, plus the couple of custom
 * materials that have no library equivalent (optic glass, illuminated reticle).
 * Those two are owned here and disposed here.
 */
export class WeaponMaterials {
  constructor(ctx) {
    this.ctx = ctx;
    this.lib = ctx.peek('materials');
    this.cache = new Map();
    this.owned = [];
    this.ownedTex = [];
    this._rimTex = null;
    this._fallbacks = new Map();
  }

  /** @returns {THREE.Material} */
  get(key) {
    if (key === 'cavity') return this.cavity();
    if (key === 'optic_tube') return this.opticTube();
    if (key === 'glass') return this.glass();
    if (key === 'lens_ring') return this.lensRing();
    if (key === 'lens_vig') return this.lensVignette();
    let m = this.cache.get(key);
    if (m) return m;
    const def = WEAPON_MATERIALS[key];
    if (def && this.lib) {
      m = this.lib.get(def[0], def[1]);
      // The viewmodel is drawn with its own near plane; nothing about it should
      // write into the world's shadow cascades.
      m.shadowSide = THREE.FrontSide;
      // A weapon held at the shoulder sees maybe half the sky: the shooter's own
      // head, chest and arms block the rest, and the sight, the mount and the
      // magwell shade each other. Without this the gun samples the full bright
      // sky IBL while the street around it is in shade, which is the single most
      // obvious "sticker pasted on the frame" tell. The opts above are unique to
      // this subsystem, so the library instance being tuned here is ours alone.
      m.envMapIntensity = ENV_OCCLUSION;
      m.needsUpdate = true;
    } else {
      m = this._fallback(key);
    }
    this.cache.set(key, m);
    return m;
  }

  /** Used only if the materials subsystem is unavailable (standalone harness). */
  _fallback(key) {
    let m = this._fallbacks.get(key);
    if (m) return m;
    const metal =
      key === 'steel' || key === 'steel_bright' || key === 'steel_black' || key === 'brass' || key === 'copper';
    m = new THREE.MeshStandardMaterial({
      color: key === 'brass' ? 0xb08d3a : metal ? 0x3a3d42 : 0x2a2b2e,
      roughness: metal ? 0.38 : 0.72,
      metalness: metal ? 1 : 0,
    });
    this._fallbacks.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * The inside of the optic tube: a LIGHT TRAP, not a cavity.
   *
   * `cavity()` is 0x030405 — 0.0015 linear — which is blacker than any real
   * surface and, being effectively zero, has nothing for the fill or the bounce
   * off the objective to land on. The result was measured in ads.png: the tube
   * interior sampled rgb(27,36,53), i.e. it was carrying nothing but a flat blue
   * env term, so the objective read as "a flat grey gradient disc".
   *
   * A real anodised/flocked tube bore is 0.018-0.025 linear: black, but a black
   * you can see a gradient across. Roughness 0.9 and a hard specular clamp keep
   * it from doing what the old cavity did at grazing incidence, which is throw
   * the cream ring around the front lip that the critique measured.
   */
  opticTube() {
    const key = 'optic_tube';
    let m = this.cache.get(key);
    if (m) return m;
    // 0x272a2c is 0.0205 linear — the middle of the band.
    m = new THREE.MeshPhysicalMaterial({
      color: 0x1d2023,
      roughness: 0.9,
      metalness: 0,
      // The whole point: no grazing lobe. MeshStandardMaterial hard-codes
      // specularF90 = 1.0, so a matte black tube wall lights up like chrome to
      // any ray that skims it — which is every ray just outside the exit pupil
      // when the eye is on the optical axis.
      specularIntensity: 0.12,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide,
    });
    m.name = 'ow-optic-tube';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * The bright inner-edge reflection ring just inside the objective rim.
   *
   * Looking into a real coated objective the one unmistakable cue is a thin,
   * very bright arc where the inside of the bezel is reflected in the glass. It
   * is a specular feature of the lens, so it does not belong on the bezel
   * geometry (which is what produced the fat cream ring) — it is its own 0.4 mm
   * ring, unlit and additive, sitting on the glass.
   */
  lensRing(intensity = 0.14) {
    const key = `lensRing:${intensity}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x9fc4d8).multiplyScalar(intensity),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    });
    m.name = 'ow-lens-ring';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * Optic glass — an AR-coated dielectric, not a smoked window.
   *
   * A broadband AR stack leaves a residual reflection whose hue swings with
   * angle: green at normal incidence (the stack is tuned for the red and blue
   * ends, so what it fails to kill is the middle) through violet to magenta by
   * ~70 degrees. That swing is the single cue that says "there is glass in the
   * tube", and it is driven by Fresnel, so it is built out of two terms that
   * peak at opposite ends of the angle range:
   *   specularColor  tints F0, i.e. NORMAL incidence  -> green
   *   sheen          is a grazing lobe                -> magenta
   * with three's iridescence (a real thin film) filling in the transition.
   */
  glass(tint = 0x3b6e8c) {
    const key = `glass:${tint}`;
    let m = this.cache.get(key);
    if (m) return m;
    // A multi-coated red-dot objective transmits ~88% on axis with a faint cool
    // cast, and throws a strong bluish-magenta sheen at grazing angles. Opacity
    // is the *absorption*, so it has to stay low: at 0.3 the sight reads as a
    // smoked lens and the world behind it goes muddy.
    m = new THREE.MeshPhysicalMaterial({
      color: 0x121c22,
      transparent: true,
      opacity: 0.1,
      // 0.03: inside the 0.02-0.04 band. Below 0.02 the reflection collapses to
      // a single pixel-sized sun spot and the lens reads as a hole again.
      roughness: 0.03,
      metalness: 0,
      ior: 1.52,
      reflectivity: 0.55,
      specularIntensity: 1,
      // GREEN at normal incidence — the residual an AR stack cannot cancel.
      specularColor: new THREE.Color(0x59c489),
      /**
       * The AR stack. A broadband anti-reflective coating IS a thin film, so the
       * physically-correct way to get "cyan on axis, magenta at the rim" is
       * three's iridescence term rather than a hand-authored gradient: the
       * thickness range below is a real 5-layer MgF2/TiO2 stack (310-560 nm),
       * which swings the reflected hue from cyan-green through violet to magenta
       * across the last ~25 degrees of view angle. Without this the lens shows
       * the raw world and there is no cue that there is any glass in the tube at
       * all — which is exactly what the critique measured.
       */
      iridescence: 1,
      iridescenceIOR: 1.4,
      iridescenceThicknessRange: [220, 560],
      /**
       * MAGENTA at grazing — sheen is a pure Fresnel-weighted rim lobe, so it is
       * ~0 down the axis and dominant by 70 degrees, which is exactly the swing a
       * coated objective makes as you roll off it.
       *
       * 0.85 / roughness 0.08 -> 0.42 / 0.30. MEASURED in the ADS frame: a tight
       * magenta rim lobe on a curved lens element, sampled against an 8-bit
       * framebuffer with the composite's grain on top, resolved as a field of
       * violet chroma speckle across the whole optic — read as compression
       * artefacts rather than as a coating. Halving the amplitude and quadrupling
       * the lobe width keeps the hue swing and takes the noise out of it.
       */
      sheen: 0.42,
      sheenColor: new THREE.Color(0xa856b8),
      sheenRoughness: 0.3,
      envMapIntensity: 2.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      premultipliedAlpha: true,
    });
    m.name = 'ow-optic-glass';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * Radial alpha ramp, 1 at the rim and 0 in the middle.
   *
   * Used by the tube vignette and the eye-relief ring: a real sight darkens
   *6-8% toward the edge of the exit pupil because the field stop and the tube
   * wall eat the outer rays, and that soft darkening is a large part of why
   * looking through glass looks different from looking through a hole.
   */
  _rimRamp() {
    if (this._rimTex) return this._rimTex;
    const N = 64;
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N - 0.5;
        const v = (y + 0.5) / N - 0.5;
        const r = Math.min(1, hypot2(u, v) * 2);
        // flat centre, then a smooth ramp over the outer third of the aperture
        const t = Math.max(0, (r - 0.8) / 0.2);
        const a = t * t * (3 - 2 * t);
        const i = (y * N + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.needsUpdate = true;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    this._rimTex = t;
    this.ownedTex.push(t);
    return t;
  }

  /**
   * Tube vignette: an unlit dark disc that sits just behind the ocular lens and
   * is transparent in the middle, opaque-ish at the rim. `strength` is the peak
   * darkening at the very edge of the aperture.
   */
  lensVignette(strength = 0.34) {
    const key = `vignette:${strength}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = new THREE.MeshBasicMaterial({
      color: 0x05070a,
      transparent: true,
      opacity: strength,
      alphaMap: this._rimRamp(),
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    });
    m.name = 'ow-lens-vignette';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /**
   * The reticle's dark outline. Additive blending cannot draw anything darker
   * than the background, so the 0.5 px keyline that keeps a 2 px dot legible
   * against a blown-out sky has to be a separate normally-blended ring.
   */
  reticleOutline(opacity = 0.8) {
    const key = `reticleOutline:${opacity}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = new THREE.MeshBasicMaterial({
      color: 0x14060a,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    m.name = 'ow-reticle-outline';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** Additive, unlit, depth-tested reticle. */
  reticle(color = 0xff2a12, intensity = 6.5) {
    const key = `reticle:${color}:${intensity}`;
    let m = this.cache.get(key);
    if (m) return m;
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    });
    m.name = 'ow-reticle';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  /** Matte black interior — bores, lens housings, ejection port cavity. */
  cavity() {
    const key = 'cavity';
    let m = this.cache.get(key);
    if (m) return m;
    // Truly black and truly matte. Anything with a specular lobe left in it
    // catches the sky from inside the optic tube and paints a bright crescent
    // across the bottom of the sight picture — and MeshStandardMaterial has no
    // way to say "no specular lobe", because it hard-codes F0 = 0.04 and
    // specularF90 = 1.0. Every engraved rollmark stroke, bore and port cavity on
    // the gun uses this material, and at grazing incidence they were all lighting
    // up like glass. MeshPhysicalMaterial with specularIntensity 0.04 is the same
    // black with the Fresnel taken out.
    m = new THREE.MeshPhysicalMaterial({
      color: 0x0a0c0e,
      roughness: 1,
      metalness: 0,
      specularIntensity: 0.04,
      envMapIntensity: 0.18,
      side: THREE.DoubleSide,
    });
    m.name = 'ow-cavity';
    this.cache.set(key, m);
    this.owned.push(m);
    return m;
  }

  dispose() {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
    for (const t of this.ownedTex) t.dispose();
    this.ownedTex.length = 0;
    this._rimTex = null;
    this.cache.clear();
    this._fallbacks.clear();
  }
}
