import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { Pass, hdrTarget } from './pass.js';

/**
 * Per-object motion blur driven by the velocity buffer.
 *
 * Velocity is dilated over a tile so a fast object bleeds *outside* its own
 * silhouette (a blur that stops at the object's edge is the giveaway of a
 * naive implementation), samples are depth-weighted so the background does
 * not smear over a foreground object, and the shutter is expressed as a real
 * fraction of the frame time so the amount of blur is frame-rate independent.
 */

const TILE_MAX = /* glsl */ `
precision highp float;
uniform sampler2D tVelocity;
uniform vec2 uTexel;      // texel size of the full-res velocity buffer
varying vec2 vUv;
// 8x8 taps spread over the 16x16 source tile centred on this output texel.
void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = 0.0;
  for ( int y = 0; y < 8; y ++ ) {
    for ( int x = 0; x < 8; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 3.5 ) * 2.0 * uTexel;
      vec2 v = texture2D( tVelocity, vUv + o ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

const BLUR = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tTile;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uParams;   // x shutter, y maxRadiusPx, z frame, w intensity
uniform float uCentre;  // how much of the smear survives at the crosshair
varying vec2 vUv;

#define OW_MB_TAPS 12

void main() {
  vec4 centre = texture2D( tColor, vUv );
  vec2 tileVel = texture2D( tTile, vUv ).rg;
  vec2 ownVel = texture2D( tVelocity, vUv ).rg;

  vec2 vel = length( tileVel ) > length( ownVel ) ? tileVel : ownVel;
  vel *= uParams.x;

  // The crosshair is not a place to put a blur.
  //
  // The velocity buffer does not distinguish a moving object from a moving
  // camera, so at a turn rate you would actually clear a corner at — 220 deg/s,
  // which is 3.7 deg per frame, 73 px at this FOV, 31 px after the 0.42 shutter
  // — every pixel on screen carries that smear, the middle of the frame
  // included. Measured with tools/sight.mjs: mean Sobel gradient over the
  // centre 36 % of the frame fell to 0.57x of the standing value while the mean
  // luminance moved by 0.4 %. The screen was not darker or brighter; two fifths
  // of the detail in it had simply gone, on the frames a round-based shooter is
  // decided on. (Brightness is why this went unnoticed by eye for so long — you
  // have to measure gradient to see it at all.)
  //
  // Cutting the shutter globally would buy that back by deleting the effect.
  // The effect is worth keeping where it does its job, and its job is at the
  // edges: peripheral smear is what sells the speed of a turn, and nobody is
  // reading the edge of the frame. So the smear is scaled down toward the
  // centre and left alone outboard of it. Object blur inside the ramp goes with
  // it, which is the right trade twice over — a sprinting enemy at the
  // crosshair is exactly the thing you must not smear.
  //
  // The ramp reaches full strength only at r = 1.05, i.e. past the middle of
  // each edge. A first attempt at 0.25 -> 0.85 gained noticeably less, because
  // the sight region is wider than the crosshair: the corners of the centre
  // 36 % of the frame sit at r = 0.51, where that ramp had already restored half
  // the smear. Clearing a corner is not looking at one pixel.
  float r = length( vUv - 0.5 ) * 2.0;
  vel *= mix( uCentre, 1.0, smoothstep( 0.40, 1.05, r ) );

  float pixels = length( vel * uResolution );
  if ( pixels < 1.0 ) { gl_FragColor = centre; return; }

  float maxPx = uParams.y;
  if ( pixels > maxPx ) vel *= maxPx / pixels;

  float centreDepth = texture2D( tDepth, vUv ).r;
  float cov = texture2D( tNormal, vUv ).z;
  if ( cov < 0.5 ) centreDepth = 1e5;

  float jitter = owIGN( gl_FragCoord.xy + uParams.z * 2.717 ) - 0.5;

  vec3 sum = centre.rgb;
  float wsum = 1.0;
  for ( int i = 1; i <= OW_MB_TAPS; i ++ ) {
    float t = ( float( i ) + jitter ) / float( OW_MB_TAPS );
    vec2 o = vel * ( t - 0.5 );
    for ( int s = 0; s < 2; s ++ ) {
      vec2 uv = vUv + ( s == 0 ? o : -o );
      if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
      float d = texture2D( tDepth, uv ).r;
      float c = texture2D( tNormal, uv ).z;
      if ( c < 0.5 ) d = 1e5;
      // a sample that is much further away than the centre is background
      // leaking in — down-weight it
      float w = 1.0 - smoothstep( 0.0, 1.5, ( d - centreDepth ) / max( 1.0, centreDepth ) );
      w = mix( 0.15, 1.0, clamp( w, 0.0, 1.0 ) ) * ( 1.0 - t * 0.35 );
      sum += texture2D( tColor, uv ).rgb * w;
      wsum += w;
    }
  }

  vec3 blurred = sum / wsum;
  gl_FragColor = vec4( mix( centre.rgb, blurred, uParams.w ), centre.a );
}
`;

export class MotionBlur {
  constructor() {
    this.tilePass = new Pass('ow-mb-tile', TILE_MAX, {
      tVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.blurPass = new Pass('ow-mb', BLUR, {
      tColor: { value: null },
      tVelocity: { value: null },
      tTile: { value: null },
      tDepth: { value: null },
      tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0.5, 48, 0, 1) },
      /**
       * Fraction of the smear kept at the crosshair — zero. See the ramp in
       * BLUR for why, and `tools/sight.mjs` for the measurement that chose it:
       * 0.15 measured 0.77-0.87x of the standing centre detail and 0.0 measured
       * 0.91-0.96x, which is the floor the pass not running at all reaches
       * (0.92-0.94x) — the same number inside a 4 % noise floor. The residual
       * belongs to the temporal passes upstream, so there is nothing left here
       * to win and no reason to keep a token smear.
       */
      uCentre: { value: 0.0 },
    });
    this.tileRt = null;
    this.outRt = null;
  }

  setSize(w, h) {
    this.tileRt?.dispose();
    this.outRt?.dispose();
    const tw = Math.max(1, Math.ceil(w / 16));
    const th = Math.max(1, Math.ceil(h / 16));
    this.tileRt = hdrTarget(tw, th, { format: THREE.RGFormat, name: 'mb-tile' });
    this.outRt = hdrTarget(w, h, { name: 'mb' });
    this.tilePass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurPass.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.blurPass.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, colorTexture, gbuffer, frame, shutter) {
    this.tilePass.uniforms.tVelocity.value = gbuffer.velocityTexture;
    this.tilePass.render(renderer, this.tileRt);

    const u = this.blurPass.uniforms;
    u.tColor.value = colorTexture;
    u.tVelocity.value = gbuffer.velocityTexture;
    u.tTile.value = this.tileRt.texture;
    u.tDepth.value = gbuffer.depthTexture;
    u.tNormal.value = gbuffer.normalTexture;
    u.uParams.value.x = shutter;
    u.uParams.value.z = frame % 64;
    this.blurPass.render(renderer, this.outRt);
    return this.outRt.texture;
  }

  dispose() {
    this.tileRt?.dispose();
    this.outRt?.dispose();
    this.tilePass.dispose();
    this.blurPass.dispose();
  }
}
