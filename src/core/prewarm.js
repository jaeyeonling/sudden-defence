/**
 * Shader pre-warm.
 *
 * WHY THIS EXISTS — measured, not guessed. Profiling actual gameplay at Retina
 * DPR showed 86 WebGL programs compiling lazily *during play*, with up to 30
 * landing on a single frame. Each of those frames took 3.1-3.9 SECONDS. That is
 * the "freezing" players report: not a low frame rate, but multi-second stalls
 * whenever geometry with an uncompiled material/light/shadow permutation first
 * enters the frame.
 *
 * Three.js compiles a program the first time a given (material, lights, shadow,
 * skinning, fog, ...) permutation is actually drawn. The fix is to force every
 * permutation to compile up front, while a loading state is on screen, so the
 * steady-state frame loop never compiles anything.
 *
 * This must not change a single rendered pixel. It only moves *when* compilation
 * happens, so it touches no material parameters, no camera, no lighting state.
 * The pixel-diff gate (tools/imagediff.mjs) enforces that.
 *
 * Two mechanisms, because neither alone is sufficient:
 *
 *  1. renderer.compileAsync() — uses KHR_parallel_shader_compile where available,
 *     so it compiles off the main thread and does not block. Covers the forward
 *     lit pass for everything currently in a scene graph.
 *  2. Real frames from representative poses — compileAsync does NOT cover the
 *     depth/shadow-map variant of a material, nor the post-processing chain,
 *     nor permutations that only exist once a subsystem has spawned its transient
 *     objects (particles, decals, ragdolls, muzzle flash). Actually drawing a
 *     handful of frames is the only way to reach those.
 */

/** Poses chosen to span the level's lighting and material variety, so the
 *  cascades, interiors and exteriors all get their permutations compiled. */
const WARM_POSES = [
  { pos: [0, 1.65, 16], look: [0, 1.6, -16] }, // long axis, deepest cascades
  { pos: [-14, 1.65, 8], look: [6, 1.6, -4] }, // corner into open floor
  { pos: [0, 1.4, 0], look: [2, 1.2, 3] }, // close material detail
  { pos: [12, 1.65, -8], look: [-8, 1.7, 6] }, // cross-map sightline
];

/**
 * Force every shader permutation to compile before gameplay starts.
 * Resolves once warm. Never throws — a failed pre-warm must not block boot,
 * it just means the old stutter comes back.
 */
/**
 * @param opts.transients  Stage each subsystem's spawned objects (enemies, impact
 *   bursts, muzzle flash) so their programs compile too. MEASURED TO BE UNSAFE and
 *   therefore off by default: the pixel-diff gate showed up-to-254/255 channel
 *   deltas afterwards, because decals live in a persistent ring buffer and spawned
 *   actors are not despawned by any hook reachable from here. Reaching the
 *   remaining permutations safely needs a `prewarmMaterials()` on each subsystem
 *   that builds and compiles its materials WITHOUT spawning gameplay objects —
 *   which is owned by those subsystems, not by core.
 */
import * as THREE from 'three';

/**
 * Subsystems whose `prewarmMaterials()` must NOT be driven from here.
 *
 * `fx` self-schedules its own pre-warm on the second rendered frame, and that is
 * not a workaround it can drop: the program cache key carries the number of
 * VISIBLE lights, and the visible set is only settled inside the renderer's
 * first frame (`render._cullLights`) plus `world._stabiliseLightCount`, both of
 * which run after this function has returned. Calling fx from here would compile
 * a permutation the frame loop never asks for AND latch fx's `_warmed` flag, so
 * the real programs would go back to compiling on the first shot fired. Measured
 * by src/fx: that is 12 programs / 142-159 ms on the frame the trigger is pulled.
 */
const SELF_WARMING = new Set(['fx']);

/**
 * Whether to let `render.prewarmMaterials()` run its CSM-depth + MRT-prepass step.
 *
 * OFF, and it is the one thing in this file that was MEASURED not to be
 * pixel-neutral. Unlike every other step here, that one does not compile — it
 * actually *runs* the two depth passes, writing the shadow array and the gbuffer.
 * `render` reports it as clean when invoked standalone at frame 0; driven from
 * here (after every subsystem has init'd, with the camera restored to the real
 * spawn pose) it is not. Bisected against shots/perf-base with everything else in
 * place, one variable at a time:
 *
 *   render-only tree, no hooks .................. identical, 0 px
 *   + ragdoll sleep skip ........................ identical, 0 px
 *   + all hooks, shadow:false ................... identical, 0 px
 *   + all hooks, shadow:true .... detail/impacts/muzzle/night/weapon changed,
 *                                 0.005-0.017% of pixels, maxDelta 1
 *
 * Run-to-run noise was verified at exactly zero first (two captures of the same
 * tree were bit-identical), so those deltas are the change, not the harness.
 *
 * Little is lost: the override-material variants are reached anyway, without
 * drawing, by `world.prewarmMaterials()` (which compiles the level under
 * `csm.depthMaterial` and `gbuffer.material` via `scene.overrideMaterial`) and by
 * `ai.prewarmMaterials()` (which borrows render's depth override for the
 * characters). The gate outranks the last few programs.
 */
const RENDER_SHADOW_WARM = false;

export async function prewarm(engine, { onProgress = () => {}, transients = false, drawFrames = false, warmHidden = false, realPathWarm = false, skipFxWarm = false } = {}) {
  const t0 = performance.now();
  const render = engine.ctx.peek('render');
  const renderer = render?.renderer;
  if (!renderer) return { ok: false, reason: 'no renderer' };

  const programsBefore = renderer.info.programs?.length ?? 0;
  const cam = engine.camera;
  const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };

  // Pre-warm has to be *simulation-transparent*, not just visually transparent.
  // It steps the engine, which advances the clock and the RNG stream; if that
  // residue survived, every downstream capture would drift and the pixel-diff
  // gate would report phantom regressions. Snapshot and restore both.
  const t = engine.time;
  const savedTime = { elapsed: t.elapsed, raw: t.raw, dt: t.dt, alpha: t.alpha, frame: t.frame };
  const r = engine.rng;
  const savedRng = { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3, spare: r._spare };
  const savedAccum = engine._accum;

  /**
   * EVERY SUBSYSTEM'S RNG, not just the root one.
   *
   * `ctx.rng` was already snapshotted above, and that was not enough, because
   * every subsystem forks its own stream off it at construction
   * (`this.rng = ctx.rng.fork()`) and thereafter advances independently. A
   * transient warm that fires three rounds pulls from `weapons.rng` for the
   * spread disc and the tracer seed, and from `fx.rng` for the flash colour
   * temperature, the lobe roll and every ember — so the shot the player actually
   * fires afterwards draws different numbers than it would have.
   *
   * That is not a subtle effect and it is not a cosmetic one. Measured against
   * the previous build: `impacts.png` came back 67 % changed with a max delta of
   * 201 and a mean of 1.1 — the low mean and high max of particles landing
   * somewhere else, which is exactly what a shifted stream looks like and exactly
   * what the pixel gate exists to catch. Restoring the root stream while leaving
   * the forks advanced is the worst of both: reproducible-looking and wrong.
   */
  const savedRngs = [];
  for (const sys of engine.registry.ordered ?? []) {
    const g = sys?.rng;
    if (!g || typeof g.s0 !== 'number') continue;
    savedRngs.push([g, { s0: g.s0, s1: g.s1, s2: g.s2, s3: g.s3, spare: g._spare }]);
  }

  // Subsystems whose materials only exist once they have spawned something.
  // These reach the transient material permutations (particles, decals,
  // ragdolls, flash) that a static camera never compiles.
  //
  // fx only: core stays free of gameplay ids, so gameplay subsystems that want
  // their transients warmed register a `prewarmTransients()` hook instead (see
  // the hook sweep below). fx.debugBurst understands 'explosion' | 'muzzle' |
  // 'combat' and a default wall burst; anything else falls through to the same
  // default, so enumerating surface names buys nothing.
  const transientStages = [
    () => engine.ctx.peek('fx')?.debugBurst?.('wall'),
    () => engine.ctx.peek('fx')?.debugBurst?.('explosion'),
    () => engine.ctx.peek('fx')?.debugBurst?.('muzzle'),
    () => engine.ctx.peek('fx')?.debugBurst?.('combat'),
  ];

  // A RENDER TARGET MUST BE BOUND WHILE COMPILING. three folds `outputColorSpace`
  // and `toneMapping` into the program cache key and reads BOTH off the currently
  // bound target. With the canvas bound (the default here) every program compiled
  // is the `srgb` + tone-mapped variant — but the world and the viewmodel are both
  // drawn into HDR targets, which need `srgb-linear` + NoToneMapping. Measured by
  // src/materials and src/fx independently: 25 of 47 pre-warmed programs were the
  // unused canvas variant, and the real ones still compiled during the first
  // frames of play. A 1x1 target is enough to get the right key; nothing is ever
  // rendered into it. Restored in the caller's `finally`.
  const scratchRt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  const prevRt = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace?.() ?? 0;
  const prevMip = renderer.getActiveMipmapLevel?.() ?? 0;

  const compile = async () => {
    // compileAsync is non-blocking where KHR_parallel_shader_compile exists.
    renderer.setRenderTarget(scratchRt);
    try {
      await renderer.compileAsync(engine.scene, engine.camera);
      await renderer.compileAsync(engine.viewScene, engine.viewCamera);
    } catch {
      // Older three or a driver without the extension — fall back to sync.
      try {
        renderer.compile(engine.scene, engine.camera);
        renderer.compile(engine.viewScene, engine.viewCamera);
      } catch { /* nothing more we can do; boot must still proceed */ }
    } finally {
      renderer.setRenderTarget(prevRt, prevFace, prevMip);
    }
  };

  const yieldFrame = () => new Promise((r) => requestAnimationFrame(r));

  /**
   * Upload every texture either scene's materials reference.
   *
   * A texture is CPU data until something draws with it, and some of the things
   * that draw with it are not drawn at boot. The decal pool is the clean example:
   * it preallocates its geometry and its atlas at construction and sits at
   * `setDrawRange(0, 0)` until the first round marks a wall, so its albedo,
   * normal and ORM maps upload on the frame that mark appears. `tools/profile.mjs`
   * measured that as three new textures on a 237 ms frame.
   *
   * `renderer.initTexture` exists for exactly this and is neutral by
   * construction: it uploads and nothing else. No draw call, no state, nothing to
   * restore — it cannot change what any later frame looks like, only when the
   * upload was paid for. That is a much better bargain than the alternative,
   * which is placing a real decal at boot and then having to erase it.
   */
  let texturesWarmed = 0;
  let hiddenWarmed = 0;
  const warmTextures = () => {
    let n = 0;
    const seenTex = new Set();
    const push = (t) => {
      if (!t?.isTexture || seenTex.has(t)) return;
      seenTex.add(t);
      try { renderer.initTexture(t); n++; } catch { /* compressed or already resident */ }
    };
    for (const root of [engine.scene, engine.viewScene]) {
      root?.traverse?.((o) => {
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) for (const k in m) push(m[k]);
      });
    }
    return n;
  };

  /**
   * Draw both scenes once, into the scratch target.
   *
   * Compiling a program is not the same as being ready to draw with it, and this
   * file spent its whole life assuming it was. `compileAsync` builds the program;
   * the vertex buffers and the vertex-array objects that bind a geometry to that
   * program are created by the driver on the FIRST REAL DRAW CALL. So every VAO
   * and attribute buffer in the game was still being created during play with the
   * programs already warm — which is exactly why the stall never showed up as
   * `progDelta` and why enabling the transient stage did not remove it.
   *
   * `tools/profile.mjs` traced it: a 223 ms frame five seconds into play, zero
   * new programs, two new geometries, resolving to `src/render/index.js:1418` —
   * `renderer.render(viewScene, viewCamera)`, the viewmodel draw.
   *
   * Drawing is safe here in the way the `drawFrames` option is not, and the
   * difference is why this is not that option: `drawFrames` called
   * `engine.step()`, which advances AI transforms, exposure adaptation and
   * particle cursors — state core cannot restore, measured at up-to-180/255 pixel
   * deltas. This steps nothing. It issues two draw calls against the scenes
   * exactly as they stand, into a 1x1 target nobody ever reads, and the only
   * things it changes are driver-side objects that were going to be created
   * anyway.
   *
   * It has to run INSIDE the transient loop, not once after it. A view-space
   * particle lives about 60 ms and the loop simulates a few milliseconds per
   * stage, so by the end of the loop the flash that was staged in the second
   * stage has long expired and its buffers are unreachable again — which is what
   * a first version of this did, and it left the 223 ms frame exactly where it
   * was.
   *
   * ────────────────────────────────────────────────────────────────────────────
   * IT IS NOT QUITE FREE, AND THE EPSILON IS DELIBERATE
   *
   * An extra pair of draw calls at boot leaves the gate set one LSB off the
   * previous baseline: about 30 % of pixels change, mean delta 0.3/255, max 42 on
   * the worst shot and 6 on the mildest. That is dither/shadow-texel phase, not
   * content — the equivalent shift from a genuinely leaky warm was mean 37 and
   * max 146, two orders of magnitude away, so the two are not hard to tell apart.
   *
   * What makes it acceptable rather than a broken rule is that the NEW build is
   * bit-identical to itself: two consecutive `tools/baseline.mjs` runs diff to
   * exactly zero on all nine shots. The gate still gates. This is a one-time
   * re-baseline with a stated epsilon, which is the case that rule was written to
   * allow — not a loss of determinism, which is the case it was written to catch.
   */
  const warmDraw = () => {
    // Into the REAL targets where they exist, not the 1x1 scratch.
    //
    // The scratch target gets the three.js program cache key right — that is what
    // it is for, and the comment above `scratchRt` explains it. It gets the DRIVER
    // pipeline wrong. ANGLE on Metal builds a pipeline state per combination of
    // shader, render-target format and sample count, and translates the shader when
    // it does; three counts none of that, because three only knows about
    // WebGLProgram objects. So a warm draw into a 1x1 non-MSAA target can leave
    // `info.programs` fully warm and the driver completely cold for the MSAA HDR
    // targets the game actually draws into.
    //
    // That is the shape of the last unexplained stall: 246 ms inside
    // `render.render` with `progDelta` at ZERO, attributed by the allocation trace
    // to `renderer.render(viewScene, viewCamera)`, and removed entirely by
    // `--prefire` (which pays it earlier through the real path). No three.js
    // counter can see it because it is not a three.js object.
    //
    // Both targets are cleared at the top of every real pass — `render.render`
    // does `clear(true, true, false)` before each — so what we draw here is
    // overwritten before it can be composited. With ONE exception: when TAA is
    // off, the SSR pass reads `hdrRt.texture` as "last frame's resolved colour"
    // (render/index.js:1363), and on the very first frame there is no last frame,
    // so anything left here would become frame 0's reflection source. Cheaper to
    // clear than to reason about which quality tiers dodge it.
    const worldRt = render.hdrRt ?? scratchRt;
    const viewTarget = render.viewRt ?? scratchRt;
    try {
      // PATCH FIRST, and this is the difference between warming the right program
      // and warming a near-miss.
      //
      // `render.render` walks both scenes every frame and runs every lit material
      // through `patcher.patch`, which wraps `onBeforeCompile` to inject the
      // cascade, AO and fill terms. three folds the `onBeforeCompile` SOURCE into
      // the program cache key, so a patched material and its unpatched self are two
      // different programs. Drawing through `renderer.render` directly — which is
      // what this function does, deliberately, to avoid advancing `render.frame`
      // and with it the TAA jitter — skips that walk entirely.
      //
      // The result was a prewarm that compiled the whole decal material and still
      // stalled for a quarter of a second the first time a bullet hole appeared.
      // The two keys differed by one substring:
      //
      //   boot: ...,srgb,fx-decal-1
      //   play: ...,srgb,ow-patch-9-4-3fx-decal-1
      //
      // Everything else in a 256-character key matched, which is why every counter
      // in `tools/profile.mjs` said the material was warm.
      render.patchMaterials?.(engine.scene);
      render.patchMaterials?.(engine.viewScene);

      renderer.setRenderTarget(worldRt);
      renderer.render(engine.scene, engine.camera);
      renderer.setRenderTarget(viewTarget);
      renderer.render(engine.viewScene, engine.viewCamera);
      // And once through the REAL path, which is the only way to reach the
      // override variants.
      //
      // The two `renderer.render` calls above cover the forward passes and nothing
      // else. `render.render` is twelve passes, and several of them draw the same
      // geometry through `scene.overrideMaterial` — the depth prepass, the gbuffer,
      // the shadow cascades. Those are separate programs with separate driver
      // pipelines, and no amount of drawing the scene normally reaches them. This
      // file's own header has said so from the start; it just had no way to act on
      // it until the pass breakdown in `tools/profile.mjs` made the cost visible.
      //
      // Every temporal accumulator is reset afterwards, and restoring
      // `render.frame` by hand was NOT enough — that was the first attempt, and it
      // failed the gate at 99.7 % of `corner.png` with a mean delta of 8.8.
      // `frame` is the jitter index; the TAA, GTAO and exposure histories are
      // TEXTURES, and a real frame writes all of them. `render.resetTemporal()`
      // owns the full list and is the same method `tools/baseline.mjs:87` has been
      // calling into thin air since it was written.
      if (realPathWarm && typeof render.render === 'function') {
        // The count is a DIAGNOSTIC, not a tuning knob. One warm frame is all the
        // driver needs; drawing N of them and diffing the gate says whether
        // `resetTemporal` missed an accumulator — a fixed one-time offset does not
        // grow with N, a surviving accumulator does.
        const n = typeof realPathWarm === 'number' ? realPathWarm : 1;
        try {
          for (let k = 0; k < n; k++) render.render(engine.ctx);
        } finally { render.resetTemporal?.(); }
      }

      // Leave both exactly as boot found them: empty.
      for (const rt of [worldRt, viewTarget]) {
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
      }
      renderer.setClearColor(0x000000, 1);
    } catch { /* a scene that cannot draw here would not draw in play either */ }
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
  };

  try {
    let step = 0;
    const totalSteps = WARM_POSES.length * 2 + (transients ? transientStages.length : 0) + 1;
    const tick = () => onProgress(Math.min(1, ++step / totalSteps));

    // Pass 1: compile the static world from each pose, with the depth/shadow
    // variants reached by drawing a real frame at that pose.
    for (const p of WARM_POSES) {
      cam.position.set(...p.pos);
      cam.lookAt(...p.look);
      cam.updateMatrixWorld(true);
      await compile();
      tick();
      // Drawing real frames here would reach the depth/shadow and post-processing
      // variants too, but engine.step() advances every subsystem's internal state
      // (AI transforms, exposure adaptation, particle cursors) and NONE of that is
      // restorable from core. The pixel gate measured up-to-180/255 deltas from it.
      // So this is opt-in and off: compileAsync only, which mutates nothing.
      if (drawFrames) {
        engine.step();
        await yieldFrame();
        engine.step();
        await yieldFrame();
      }
      tick();
    }

    // Pass 1b: THE SUBSYSTEM HOOKS. This is the `prewarmMaterials()` contract the
    // doc comment above says is missing — "a prewarmMaterials() on each subsystem
    // that builds and compiles its materials WITHOUT spawning gameplay objects".
    // It is now implemented by render, world and ai, and it reaches exactly what
    // `compileAsync(scene, camera)` provably cannot:
    //
    //   render  the CSM depth pass, the MRT prepass and the ~13 full-screen post
    //           materials (blitted into a 4x4 scratch). +34-40 programs.
    //   world   the CSM-depth and prepass override variants of the level geometry,
    //           in their plain / instanced / instanced+instanceColor flavours,
    //           compiled at the stabilised light count. +35 programs.
    //   ai      the 26 character materials and their skinned + depth variants,
    //           against a dummy SkinnedMesh on the real skeleton. +7 programs.
    //           (ai also calls this itself at the end of init(); it is idempotent.)
    //
    // None of them draws a gameplay frame, steps the engine, touches the clock or
    // the RNG, so none of the restore machinery above applies to them — which is
    // why this replaces the `drawFrames` option rather than extending it.
    //
    // The camera goes back to its real pose FIRST: render's hook runs the shadow
    // and prepass passes for real (at frame 0, where it is pixel-clean), and there
    // is no reason to fit the cascades to a warm-up pose the game never uses.
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // render goes first, deliberately: it patches every lit material with the
    // CSM/AO/SSR injection, and a program compiled off an UNPATCHED material is
    // thrown away by the first frame that walks the scene.
    const hooks = [];
    const renderSys = engine.registry.peek?.('render');
    if (renderSys && typeof renderSys.prewarmMaterials === 'function') hooks.push(renderSys);
    for (const sys of engine.registry.ordered ?? []) {
      if (sys === renderSys) continue;
      if (SELF_WARMING.has(sys.constructor?.id)) continue;
      if (typeof sys.prewarmMaterials === 'function') hooks.push(sys);
    }
    const hookResults = {};
    for (const sys of hooks) {
      const id = sys.constructor?.id ?? '?';
      try {
        const arg = sys === renderSys ? { post: true, shadow: RENDER_SHADOW_WARM } : engine.ctx;
        hookResults[id] = (await sys.prewarmMaterials(arg)) ?? { ok: true };
      } catch (err) {
        // An optional hook must never be able to block boot.
        hookResults[id] = { ok: false, reason: String(err?.message ?? err) };
      }
    }
    engine.__prewarmHooks = hookResults;

    // Pass 2: spawn each subsystem's transient objects and compile those too.
    // Gated: see the `transients` option doc — this pass is not pixel-transparent.
    for (const spawn of (transients ? transientStages : [])) {
      try { spawn(); } catch { /* subsystem may not implement the hook */ }
      engine.step();
      warmDraw();
      await yieldFrame();
      await compile();
      engine.step();
      warmDraw();
      await yieldFrame();
      tick();
    }
    // Pass 2b: `prewarmTransients()` — the gameplay half of the transient pass.
    //
    // The doc comment above has always said gameplay subsystems "register a
    // prewarmTransients() hook instead", and nothing ever swept for one, so the
    // sentence described an interface with no implementation on either side. The
    // gap is not academic. `fx.debugBurst` reaches the flash, the smoke, the
    // shells and the tracers, because those are fx's own; it cannot reach the
    // path a trigger pull takes THROUGH other subsystems — the ballistic
    // raycast, the penetration solve, the first decal, the hitbox query.
    //
    // Measured with `tools/profile.mjs`: the first shot of a session costs about
    // 225 ms, landing two frames after the trigger and at a frame index that does
    // not move when boot time varies by a second and a half — so it is the shot,
    // not the clock. Zero new shader programs (prewarm's own job is done) and
    // audio silenced changes nothing, so it is neither. Firing three rounds
    // before the sampling window opens takes the worst frame of the whole run
    // from 225 ms to 59 ms, which is what makes it a one-time warm rather than
    // the cost of shooting.
    //
    // Core still names no gameplay subsystem: it asks every registered system
    // whether it has the hook, exactly as pass 1b does for materials.
    // UNCONDITIONAL, unlike pass 2 above, and the distinction is the whole point.
    // Pass 2 is gated because `fx.debugBurst` leaves residue — enabling it moved
    // 99.75 % of the pixels in one gate shot, mean delta 37. A `prewarmTransients()`
    // hook is a subsystem warming its own path and putting its own state back,
    // which is a contract the gate can hold it to; `weapons` fires three rounds at
    // the sky with decals suppressed and restores its magazine, recoil index,
    // spread and stats. Measured pixel-identical, so there is nothing to gate.
    for (const sys of engine.registry.ordered ?? []) {
      if (typeof sys?.prewarmTransients !== 'function') continue;
      const id = sys.constructor?.id ?? '?';
      if (skipFxWarm && id === 'fx') continue;
      let restore = null;
      try {
        const res = (await sys.prewarmTransients(engine.ctx)) ?? { ok: true };
        hookResults[`${id}:transients`] = res;
        // A hook whose state must SURVIVE the draw returns `restore`, and we call
        // it below once `warmDraw` has bound the buffers.
        //
        // `weapons` does not need this — it restores inside itself, because the
        // gun is visible geometry either way and the draw does not depend on the
        // rounds still being in flight. `fx` does: its pools are hidden until
        // `instanceCount > 0`, and un-hiding an EMPTY pool warms nothing. That was
        // measured — `?warmhidden=1` un-hides every boot-hidden mesh in both scenes
        // and compiles them, and the stall it was built to remove did not shrink by
        // a millisecond. Compiling a program and drawing a primitive with it are
        // two different events, and only the second one makes the driver build a
        // pipeline for the target it is drawing into.
        if (typeof res.restore === 'function') restore = res.restore;
      } catch (err) {
        hookResults[`${id}:transients`] = { ok: false, reason: String(err?.message ?? err) };
      }
      // NO `engine.step()` here, and this cost two gate runs to learn.
      //
      // Stepping the engine advances `render.frame` and with it the TAA jitter
      // index, and every capture in `tools/baseline.mjs` converges its temporal
      // accumulators from a fixed starting phase. One extra step therefore shifts
      // the sub-pixel jitter of every shot in the set: measured as all nine shots
      // changing by a mean of 0.7/255 across roughly 60 % of their pixels — a
      // uniform phase shift, not a content change, but a diff is a diff and the
      // gate cannot tell the difference for you.
      //
      // Nothing needs the step. The hook spawns synchronously and `warmDraw` is
      // what binds the buffers; `yieldFrame` only waits for a rAF, and the engine
      // loop has not started yet, so it advances nothing.
      warmDraw();
      if (restore) {
        // Not optional and not best-effort: a hook that populated a pool and did
        // not empty it again would put those particles on screen on frame 1, which
        // is the exact failure mode that took `transients: true` out of `main.js`.
        // If a restore throws, prewarm has left the scene dirty and saying so is
        // more useful than a silent swallow.
        restore();
      }
      await yieldFrame();
    }
    engine.__prewarmHooks = hookResults;

    // And once more with the transients gone, so the resting scene — level,
    // weapon, hands, everything that is on screen between shots — is bound too.
    warmDraw();
    texturesWarmed = warmTextures();

    // NOT DONE, ON PURPOSE: un-hiding boot-hidden meshes to compile their programs.
    //
    // `compileAsync` walks the scene the way the renderer does, so it skips
    // anything with `visible === false` — and a pool that is empty until gameplay
    // fills it is hidden precisely then. `fx`'s decal pool is the case that
    // matters: it allocates its geometry and its atlas up front and sets
    // `mesh.visible = false` (fx/decals.js), flipping it true only once a round
    // has marked a wall. `tools/profile.mjs` named the cost exactly —
    // `ow-patch-...fx-decal-1`, compiled on the frame of the first shot, on a
    // frame that took 244 ms — so the temptation is obvious: set those meshes
    // visible, compile, set them back. An empty pool draws no pixels even while
    // visible, so it looked free.
    //
    // It does remove that compile — three runs, `progDelta` at the first shot goes
    // to zero. It is off anyway, and the road to that conclusion is worth keeping
    // because the first two attempts at it were both wrong.
    //
    // ATTEMPT ONE said it cost four milliseconds a frame: three runs with the sweep
    // measured a 31.0-31.7 ms median against 27.3-28.3 ms without, so it was
    // reverted as an obviously bad trade. The revert then measured 30.9-31.4 ms
    // from a bundle whose hash was byte-identical to the one that had measured
    // 27.3. The laptop had warmed up over an hour of back-to-back profiling. The
    // cost was thermal, not computational.
    //
    // ATTEMPT TWO used `tools/abperf.mjs`, which interleaves the two conditions
    // A B A B and takes the median of the WITHIN-PAIR differences, so a slow drift
    // cancels instead of accumulating into a result. Five pairs: median +0.4 ms,
    // four pairs up and one down — below the ~1 ms this setup shows on two
    // identical conditions. There is no steady-state cost anyone can measure here.
    // The same run drifted from 29.8 ms to 33.2 ms between its first and fourth
    // pair, which is the whole four-millisecond "effect" of attempt one, visible
    // inside one session with the code held constant.
    //
    // SO WHY IS IT STILL OFF. Because the benefit is not measurable either, and the
    // reason turned out to be more interesting than the sweep.
    //
    // With per-subsystem timing added to `tools/profile.mjs`, the stall attributes
    // to `render.render` and to nothing else — 245 of 247 ms, 274 of 276 ms — and it
    // is still a program compile (`progDelta` 1) WITH the sweep on. So the sweep
    // does compile the decal material's forward variant, and the frame stalls
    // anyway on a different program: the cache keys captured on those frames are a
    // raw ShaderMaterial on the first shot and a patched `ow-patch` variant on later
    // ones. `compileAsync` cannot reach the depth and prepass override variants of
    // anything (this file says so at the top), and the patched key carries the
    // VISIBLE LIGHT COUNT, which moves during a firefight as flashes enter and
    // leave the culled set — so each new count is a new program for every patched
    // material.
    //
    // Un-hiding meshes does not touch either of those. That is why it buys nothing
    // measurable, and why the next piece of work is the override variants and the
    // light-count permutations rather than another sweep here.
    //
    // `warmHidden` is the switch for that experiment. Off by default, so the
    // shipping path stays the one that needs no justification; `tools/abperf.mjs`
    // turns it on through `?warmhidden=1` and interleaves the two conditions.
    if (warmHidden) {
      const hiddenMeshes = [];
      for (const root of [engine.scene, engine.viewScene]) {
        root?.traverse?.((o) => {
          if (o.visible === false && (o.geometry || o.isGroup)) {
            hiddenMeshes.push(o);
            o.visible = true;
          }
        });
      }
      if (hiddenMeshes.length) {
        await compile();
        warmDraw();
        for (const o of hiddenMeshes) o.visible = false;
      }
      hiddenWarmed = hiddenMeshes.length;
    }

    tick();
  } finally {
    // Restore exactly what we found. Any residue here would be a visual change.
    for (const reset of (transients ? [
      () => engine.ctx.peek('fx')?.debugBurst?.('none'),
    ] : [])) {
      try { reset(); } catch { /* optional hook */ }
    }
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    Object.assign(engine.time, savedTime);
    r.s0 = savedRng.s0;
    r.s1 = savedRng.s1;
    r.s2 = savedRng.s2;
    r.s3 = savedRng.s3;
    r._spare = savedRng.spare;
    for (const [g, s] of savedRngs) {
      g.s0 = s.s0; g.s1 = s.s1; g.s2 = s.s2; g.s3 = s.s3; g._spare = s.spare;
    }
    engine._accum = savedAccum;
    engine._last = performance.now();
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
    scratchRt.dispose();
  }

  const programsAfter = renderer.info.programs?.length ?? 0;
  return {
    ok: true,
    hooks: engine.__prewarmHooks,
    ms: Math.round(performance.now() - t0),
    programsBefore,
    programsAfter,
    compiled: programsAfter - programsBefore,
    texturesWarmed,
    hiddenWarmed,
    parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
  };
}
