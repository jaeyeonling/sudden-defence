import { Engine } from './core/engine.js';
import { createConfig, applyQualityOverrides } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { PhysicsSystem } from './physics/index.js';
import { FxSystem } from './fx/index.js';
import { AudioSystem } from './audio/index.js';
import { WorldSystem } from './world/index.js';
import { MatchSystem } from './match/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing need the loop to free-run.
// Independent of `capture` on purpose. Lockstep answers "how many frames have
// run", which is what a MEASUREMENT harness needs so its boot is a function of a
// frame count rather than of how long the machine took to get here; capture also
// sets `deterministic`, which suppresses `ai.populate` and hands back a world
// with no bots in it. Tying the two meant no harness could have a reproducible
// boot AND a populated level. `tools/perceive.mjs` needs exactly that pair: it
// snapshots a live firefight, and two invocations were landing on different
// worlds because `__READY__` waits on rAF frames that arrive when they arrive.
const lockstep = params.get('lockstep') === '1';

// `?seed=<u32>` pins the master rng without pinning anything else. Separate
// from `?capture=1` for the same reason `lockstep` now is: capture implies
// `deterministic`, which suppresses `ai.populate`, so pinning the world used to
// cost you the bots in it.
const seedParam = params.get('seed');
const seed = seedParam === null ? undefined : (Number(seedParam) >>> 0);

const config = createConfig({
  seed,
  // No `?? 'ultra'` here. That hardcoded fallback shadowed `DEFAULTS.quality`
  // entirely, so the tier named as the default in config.js was never the tier
  // that booted — changing it there had no effect at all, which is exactly how it
  // was found. `createConfig` already falls back to `DEFAULTS`, so passing
  // `undefined` is the whole mechanism.
  ...(params.get('q') ? { quality: params.get('q') } : {}),
  deterministic: capture,
});

// `?q.ssr=0&q.renderScale=0.85` — one feature at a time, on top of the preset.
// A diagnostic for attributing frame cost; see `applyQualityOverrides`.
const qOverrides = [...params.entries()]
  .filter(([k]) => k.startsWith('q.'))
  .map(([k, v]) => [k.slice(2), v]);
if (qOverrides.length) {
  const applied = applyQualityOverrides(config.q, qOverrides);
  console.info('[boot] quality overrides', applied);
  window.__QOVERRIDES__ = applied;
}

const canvas = document.getElementById('game');
const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
//
// M6: the full stack. Engine layer, the warehouse, `match` (teams + combatant
// registry + round loop), the player + weapons, both bot teams, and the HUD.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(PhysicsSystem)
  .add(FxSystem)
  .add(AudioSystem)
  .add(WorldSystem)
  .add(MatchSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(AiSystem)
  .add(UiSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  // textContent, not innerHTML: a stack frame can carry a URL or a source
  // fragment, and this overlay must render exactly what the error said rather
  // than interpret any of it as markup.
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;padding:2rem;color:#f66;background:#000;'
    + 'font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap';
  pre.textContent = `BOOT FAILURE\n\n${err.stack ?? err.message}`;
  document.body.appendChild(pre);
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Without it,
// dozens of programs compile lazily during play — up to 30 on one frame, which
// upstream measured as multi-SECOND stalls. See src/core/prewarm.js.
// Opt out with `?prewarm=0`.
//
// NO `transients: true` HERE, and that is deliberate — it was tried and reverted.
//
// The reasoning behind it was sound and the conclusion was wrong. The static
// camera poses really are only half the job, and `prewarm`'s transient stage
// really does exist to reach the other half. But that stage works by bursting fx
// families through `fx.debugBurst`, and its own doc comment says it is not
// pixel-transparent. Switching it on and running the gate agreed: 99.75 % of the
// pixels in `corner.png` moved, mean delta 37, max 146 — against a hard rule that
// captures stay byte-comparable so an optimisation can be gated on them.
//
// What actually removed the stall was neither of those: it was giving subsystems
// a `prewarmTransients()` hook, and drawing both scenes once so the driver builds
// its vertex arrays at boot rather than on the first trigger pull. Both run
// unconditionally inside `prewarm` now and both are pixel-identical across runs
// and against the previous build, so this call wants no options at all. See
// `src/core/prewarm.js` and `weapons.prewarmTransients()`.
// `?warmhidden=1` is an experiment switch, not a feature: it turns on the sweep
// that compiles boot-hidden meshes' programs, whose steady-state cost is still
// unresolved. `tools/abperf.mjs` interleaves it against the default so the answer
// cannot be manufactured by a warm laptop.
const warmup = params.get('prewarm') === '0'
  ? { ok: false, reason: 'disabled by ?prewarm=0' }
  : await prewarm(engine, {
    warmHidden: params.get('warmhidden') === '1',
    // Draw one real frame through the full pass chain. `?realpath=0` opts out;
    // any other number draws that many, which is a diagnostic and not a knob.
    //
    // This is what removes the last stall, and the numbers are not close:
    //
    //   neither warm ........................... max 246-314 ms
    //   fx pool warm only ...................... max 241 ms
    //   fx pool warm + real path ............... max  56.3 ms
    //
    // A quarter of a second on the first frame of every round — the frame the
    // trigger unlocks and particles, decals and shells draw for the first time.
    //
    // It took two tries to make it pixel-honest, and the first one is worth
    // recording because it looked finished. Restoring `render.frame` by hand puts
    // the TAA jitter INDEX back and leaves the accumulated TEXTURES: 99.7 % of
    // `corner.png` changed, mean delta 8.8, max 186 — a content change, not the
    // uniform sub-pixel phase shift a re-baseline may absorb. Isolating the two
    // switches showed the fx warm contributed none of it (8.836 with fx off,
    // 8.834 with it on) and the real-path pass all of it.
    //
    // `render.resetTemporal()` is the real fix, and it is the method
    // `tools/baseline.mjs:87` had been calling into thin air since it was written
    // — three chained optional calls to methods none of which existed, so the
    // gate's own temporal reset was doing nothing. With it:
    //
    //   off vs on ......... maxDelta 1 on 0-0.195 % of pixels, mean 0.002
    //   on vs on .......... bit-identical
    //   1 frame vs 8 ...... bit-identical  <- no accumulator survives
    //
    // That last row is the one that makes this shippable. A residual that does
    // not grow with the number of warm frames is a fixed one-time offset, not a
    // leak, and one least-significant bit on a fifth of a percent of pixels is
    // the same epsilon this file already accepts for the shadow warm
    // (0.005-0.017 % at maxDelta 1, `src/core/prewarm.js`). The gate still gates:
    // the build is bit-identical to itself.
    realPathWarm: params.get('realpath') === '0'
      ? false
      : (Number(params.get('realpath') ?? 1) || 1),
    // `?fxwarm=0` disables `fx.prewarmTransients()`. Kept as the control that
    // attributes the pixel diff, since the two switches together are what proved
    // the fx hook innocent.
    skipFxWarm: params.get('fxwarm') === '0',
  });
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

engine.start();

// Capture harness handshake: only flag ready once frames have actually landed.
// A frame COUNT, not a rAF race — in lockstep the engine has no loop of its own,
// so the shot always lands at the same engine frame however long boot took.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
