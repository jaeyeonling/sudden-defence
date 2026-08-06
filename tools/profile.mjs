#!/usr/bin/env node
/**
 * Gameplay profiler — reproduces the conditions a real player hits, which the
 * static-camera capture harness completely misses:
 *
 *  - real device pixel ratio (Retina => 1.5x internal scale, ~3.3 MP not 2.07 MP)
 *  - a moving camera (forces new shadow cascades, new frusta, streaming)
 *  - firing (particles, decals, tracers, muzzle light, audio)
 *  - AI active (skinned meshes, ragdolls, pathfinding)
 *
 * Reports the frame-time DISTRIBUTION and every hitch, because a median frame
 * time hides exactly the stalls that make a game feel broken. Also tracks WebGL
 * program count per frame — a jump in programs on the same frame as a hitch is
 * a shader compilation stall, the classic cause of Three.js hitching.
 *
 * IT PROFILES THE PRODUCTION BUILD, not the dev server, and it starts its own
 * `vite preview` over `dist/` to do it. Every other harness in this directory
 * spawns a server if the port is closed; this one did not, so the only way to
 * run it was to have left something serving on 8080 by hand — and without that
 * it died on ERR_CONNECTION_REFUSED, which reads like a broken tool rather than
 * a missing prerequisite. A profiler nobody can start profiles nothing.
 *
 * The dev server would be the wrong target anyway: unminified, unbundled, one
 * request per module, so both the boot number and the shader-compile timeline
 * would describe Vite rather than the game.
 *
 * DO NOT COMPARE TWO BUILDS FROM TWO SEPARATE BLOCKS OF RUNS. This machine drifts
 * under sustained profiling: a build whose bundle hash was byte-identical measured
 * a median of 27.3-28.3 ms early in a session and 30.9-31.4 ms an hour later, which
 * is larger than most changes worth making. An A/B has to interleave the two
 * conditions — alternate them, several rounds each — or the drift will hand you a
 * clean-looking four-millisecond effect that is really the fan. The controls built
 * into this tool (`--noaudio`, `--prefire`) and into `tools/sight.mjs` (the
 * `ramp`/`mb off` rows) exist so that as much as possible is decided WITHIN one run.
 *
 *   node tools/profile.mjs --port=8080 --dpr=2 --w=1512 --h=982
 *   node tools/profile.mjs --noaudio     # control: is the stall in WebAudio?
 *   node tools/profile.mjs --prefire     # control: is it a one-time first-shot warm?
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 8080);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 900);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  // `dist/` has to exist first, and saying so beats letting the preview server
  // come up empty and the page fail on a missing bundle 90 seconds later.
  if (!existsSync(resolve('dist/index.html'))) {
    console.error('PROFILE FAILED — no dist/index.html. Run `npm run build` first.');
    process.exit(1);
  }
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT)],
    { stdio: 'ignore', detached: true });
  for (let i = 0; i < 80 && !(await portOpen(PORT)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await portOpen(PORT))) {
    console.error(`PROFILE FAILED — vite preview never opened port ${PORT}.`);
    try { process.kill(-server.pid); } catch { /* already gone */ }
    process.exit(1);
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const t0 = Date.now();
const EXTRA = args.query ? `?${args.query}` : '';
await page.goto(`http://127.0.0.1:${PORT}/${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
const bootMs = Date.now() - t0;

// Boot-phase breakdown: how much of that boot was spent where.
const bootMarks = await page.evaluate(() =>
  performance.getEntriesByType('measure').map((m) => ({ name: m.name, ms: +m.duration.toFixed(1) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 25));

const internal = await page.evaluate(() => {
  const r = window.__ENGINE__.ctx.peek('render');
  const gl = r.renderer.getContext();
  return {
    // What the pre-warm thinks it achieved, reported next to what the frame times
    // actually show. `parallel` is the one that decides how to read a `progDelta`
    // hitch at all: without KHR_parallel_shader_compile every compile blocks the
    // main thread, so a single late program is a multi-hundred-millisecond stall
    // and no amount of tuning elsewhere will soften it.
    prewarm: window.__PREWARM__ ?? null,
    pixelRatio: r.renderer.getPixelRatio(),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    megapixels: +((gl.drawingBufferWidth * gl.drawingBufferHeight) / 1e6).toFixed(2),
    quality: window.__ENGINE__.config.quality,
    renderScale: window.__ENGINE__.config.q.renderScale,
  };
});

// WHO allocated, not just how many.
//
// `geoDelta` on a hitch row says two geometries appeared on the frame that cost
// 228 ms. That is the useful half of the diagnosis and it stops exactly where
// the actionable half begins, because "two geometries" describes a decal page, a
// ragdoll, a tracer batch and a shadow cascade equally well — and the reflex is
// to fix whichever one you already suspect. Wrapping the GL entry points that
// back a three.js BufferGeometry and keeping the first stack for each call site
// turns the guess into a name. Cost is one `new Error()` per buffer creation,
// which only happens on allocation, never per frame.
await page.evaluate(() => {
  const seen = new Map();
  window.__ALLOC__ = seen;
  window.__ALLOC_ARMED__ = false;
  window.__ALLOC_FRAME__ = () => 0;
  for (const proto of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
    if (!proto) continue;
    for (const fn of ['createBuffer', 'createTexture', 'createVertexArray']) {
      const orig = proto[fn];
      if (typeof orig !== 'function' || orig.__wrapped) continue;
      const wrapped = function (...a) {
        if (window.__ALLOC_ARMED__) {
          // Trim the wrapper and three's own plumbing off the top; what is left
          // is the call site worth reading.
          // Deep enough to get PAST three.js. The first version kept five
          // frames and every one of them resolved into three/build — true, and
          // useless, because the interesting frame is whichever of our own
          // subsystems asked three to allocate. Renderer internals are five or
          // six frames deep before control returns to `src/`.
          const stack = (new Error().stack ?? '').split('\n').slice(2, 18).join(' | ');
          const key = `${fn} @ ${stack}`;
          const rec = seen.get(key);
          if (rec) rec.n++;
          else seen.set(key, { n: 1, fn, stack, frame: window.__ALLOC_FRAME__() });
        }
        return orig.apply(this, a);
      };
      wrapped.__wrapped = true;
      proto[fn] = wrapped;
    }
  }
});

// WHERE the time went, for the stalls no GL counter can see.
//
// The counters this tool reports cover programs, geometries and textures, and the
// worst frames in a run turned out to have zero of all three: 250-600 ms frames
// that are not a shader compile, not a buffer upload, not a texture. GL had
// nothing to say about them because they are not GL — they are JavaScript, and
// which JavaScript is a question about our own subsystems.
//
// `engine.step` runs four named phases over the registry (fixedUpdate, update,
// lateUpdate, then render.render), so wrapping every registered system's methods
// gives a per-frame breakdown by subsystem for free. The wrapper costs two
// `performance.now()` calls per system per phase — under a microsecond against
// frames measured in the tens of milliseconds — and it only reports the breakdown
// for frames that actually stalled, so the output stays readable.
await page.evaluate(() => {
  const acc = new Map();
  window.__PHASE__ = acc;
  const e = window.__ENGINE__;
  for (const sys of e.registry.ordered ?? []) {
    const id = sys.constructor?.id ?? '?';
    for (const fn of ['fixedUpdate', 'update', 'lateUpdate', 'render']) {
      const orig = sys[fn];
      if (typeof orig !== 'function' || orig.__timed) continue;
      const key = `${id}.${fn}`;
      const wrapped = function (...a) {
        const t = performance.now();
        try { return orig.apply(this, a); } finally {
          acc.set(key, (acc.get(key) ?? 0) + (performance.now() - t));
        }
      };
      wrapped.__timed = true;
      sys[fn] = wrapped;
    }
  }
});

// `--noaudio` silences the audio subsystem at its entry points.
//
// This exists as a CONTROL, not a feature. The first shot of a session costs
// ~225 ms with zero new shader programs, and the counters this tool reports can
// only see GL: a WebAudio graph being built and its first buffers decoded is
// invisible to `programs`, `geometries` and `textures` alike, so a stall living
// there reads as an unexplained frame. Muting Chromium does not help —
// `--mute-audio` silences the speaker, not the decode. Cutting `play`, `ui` and
// `bark` and re-running is the only way to attribute or exonerate it.
if (args.noaudio) {
  await page.evaluate(() => {
    const a = window.__ENGINE__.ctx.peek('audio');
    if (!a) return;
    for (const fn of ['play', 'ui', 'bark']) if (typeof a[fn] === 'function') a[fn] = () => {};
  });
}

// `--prefire` pays the first-shot cost before the sampling window opens.
//
// Also a control. The 225 ms frame lands two frames after the harness first
// presses the trigger, at a frame index that does not move even when boot time
// varies by a second and a half — so it is caused by the shot, not by the clock
// or the round phase. Firing a few rounds before sampling starts says whether
// that cost is a ONE-TIME warm (it vanishes, and belongs in prewarm) or a
// per-shot cost that merely happened to be first (it moves to the next shot).
if (args.prefire) {
  await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const w = e.ctx.peek('weapons');
    for (let i = 0; i < 3; i++) {
      try { w?.tryFire?.(); } catch { /* refused, e.g. mid-cooldown */ }
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

// `--nodecals` blocks bullet holes from ever being written.
//
// The third control, and it exists because the counters ran out. The stall that
// survives everything else costs 250-300 ms inside `render.render` with
// `progDelta`, `geoDelta` and `texDelta` ALL at zero — no new program, no new
// buffer, no new texture. Nothing three.js counts changed, so nothing three.js
// counts can be the cause.
//
// What `lateProgs` did say, before `?warmhidden=1` moved that compile to boot,
// is that the program family arriving late was named `ow-patch-...-fx-decal-1`.
// The decal mesh boots with `visible = false` and zero vertices and flips on at
// the first bullet hole (fx/decals.js:126, :413), which is the one draw in the
// scene that appears mid-run without allocating anything: its geometry and
// attributes are preallocated at boot, so writing the first hole grows no buffer
// and the counters stay flat.
//
// Compiling that program and DRAWING it are different events. `?warmhidden=1`
// un-hides the mesh and compiles it — and the stall got no smaller. If cutting
// decals entirely removes it, the cost is in the first real draw of that mesh
// (a driver pipeline built against the MSAA HDR target), which is reachable.
// If the stall survives with no decals at all, decals are exonerated and the
// `fx-decal` program key was a coincidence of timing.
if (args.visdiff) {
  await page.evaluate(() => { window.__VISDIFF__ = true; });
}

// `--dumpkeys=<substring>`: every program cache key already compiled at boot that
// matches, printed before sampling starts.
//
// `lateProgs` tells you which permutation arrived late. It cannot tell you whether
// prewarm compiled a NEAR-MISS — the same material under a different light count,
// a different output space, a different set of defines — and a near-miss is the
// interesting case, because it means the warm ran and aimed slightly wrong. Two
// keys side by side make the difference legible in a way a single key never does.
if (args.dumpkeys) {
  const keys = await page.evaluate((needle) => (window.__ENGINE__.ctx.get('render')
    .renderer.info.programs ?? [])
    .map((p) => p.cacheKey)
    .filter((k) => k && k.includes(needle)), String(args.dumpkeys));
  console.log(`--- boot-time cache keys matching "${args.dumpkeys}" (${keys.length}):`);
  for (const k of keys) console.log('   ', k);
}

if (args.nodecals) {
  await page.evaluate(() => {
    const fx = window.__ENGINE__.ctx.peek('fx');
    if (fx) fx._suppressDecals = true;
  });
}

// `--passes` breaks `render.render` open into individual `renderer.render` calls.
//
// The per-subsystem timing narrowed the surviving stall to `render.render` and
// then stopped being useful, because `render.render` is a dozen passes: a depth
// prepass, a gbuffer, cascades, SSR, the forward world pass, the viewmodel into
// its own target, and a composite chain. "232 of 234 ms was in render.render" is
// true and tells you nothing about which of those it was.
//
// three funnels every one of them through `renderer.render(scene, camera)`, so
// wrapping that one method and keying by scene identity attributes the cost to a
// pass by name. The label distinguishes the two scenes the engine owns by
// reference — `world` and `view` — because both are `Scene` instances and neither
// carries a name, and anything else (composite quads, the environment probe) gets
// its uuid prefix so a surprise pass cannot hide inside a bucket it does not
// belong to.
//
// Not on by default: it adds a `performance.now()` pair to every pass on every
// frame, which is exactly the kind of overhead that has no business in the
// numbers this tool reports as a baseline.
if (args.passes) {
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const r = e.ctx.get('render').renderer;
    const acc = new Map();
    window.__RPASS__ = acc;
    const orig = r.render.bind(r);
    r.render = (scene, camera) => {
      const label = scene === e.scene ? 'world'
        : scene === e.viewScene ? 'view'
        : `other:${scene?.uuid?.slice(0, 6) ?? '?'}`;
      const t = performance.now();
      try { return orig(scene, camera); }
      finally {
        const ms = performance.now() - t;
        const prev = acc.get(label);
        // Count and WORST-SINGLE-CALL as well as the total. The engine renders the
        // world scene six times a frame — prepass, gbuffer, the shadow cascades,
        // the forward pass — and "world 244 ms over 6 calls" is ambiguous between
        // one pass that stalled and six that each cost forty. `seq` keeps the
        // per-call figures in draw order so the ambiguity does not survive.
        if (prev) { prev.ms += ms; prev.n += 1; prev.worst = Math.max(prev.worst, ms); prev.seq.push(+ms.toFixed(1)); }
        else acc.set(label, { ms, n: 1, worst: ms, seq: [+ms.toFixed(1)] });
      }
    };
  });
}

// Enable player control and run a scripted gameplay sequence while sampling.
await page.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  // Both teams, at their real spawns, fighting for real. The harness used to
  // call `ai.debugStage('firefight')`, which teleported bots into camera framing
  // — that profiled a tableau, not a match. Bots are spawned at boot now, so
  // this only tops up the roster if something started the level empty.
  const ai = e.ctx.peek('ai');
  if (ai && ai.agents.length === 0) ai.populate({ perTeam: 8 });
});

const result = await page.evaluate((FRAMES) => new Promise((done) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const samples = [];
  let last = performance.now(), i = 0;
  // Arm the allocation trace only once play begins: boot legitimately allocates
  // everything, and a log dominated by boot would bury the handful of call sites
  // that fire mid-match.
  window.__ALLOC_FRAME__ = () => i;
  window.__ALLOC_ARMED__ = true;

  // What APPEARED, not just what allocated.
  //
  // A `gl.createBuffer` stack names the frame that first drew a geometry, which
  // is `renderer.render(viewScene, ...)` for everything in the viewmodel and so
  // tells you nothing about which object it was. Geometry construction and first
  // draw are different moments and only the second one is on the stack. Walking
  // the scene graph and reporting names that were not there a frame ago closes
  // that gap from the other end.
  const seenObj = new Set();
  const walk = (root, out) => root?.traverse?.((o) => {
    if (!o.geometry) return;
    const key = `${o.name || o.type}#${o.geometry.attributes?.position?.count ?? 0}`;
    if (seenObj.has(key)) return;
    seenObj.add(key);
    // `Mesh#240` names nothing you can go and pre-warm, and this row exists to
    // be acted on: when it lands on the same frame as a program compile, the
    // question is always "which material, owned by which subsystem". So carry
    // the material and the ancestry out with it. Both are read defensively —
    // this walks live scene graphs mid-run, and a profiler that throws inside
    // its own instrumentation reports nothing at all.
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const chain = [];
    for (let p = o.parent; p && chain.length < 4; p = p.parent) chain.push(p.name || p.type);
    out.push({
      key,
      mat: mat ? `${mat.type}${mat.name ? `:${mat.name}` : ''}` : null,
      visible: !!o.visible,
      parents: chain,
    });
  });
  const appeared = [];

  // `--visdiff`: what became VISIBLE, which is a third distinct moment.
  //
  // `walk` above ignores `visible` on purpose — it answers "is this object in the
  // graph". That makes it blind to the case that matters here: a mesh present and
  // hidden since boot, flipped on mid-run. It was seeded on frame 0, so it never
  // reads as new, and its geometry was built at boot, so it never reads as an
  // allocation either. It is invisible to every counter in this tool and it is
  // exactly what a lazily-drawn material looks like.
  //
  // The pass breakdown made this the question worth asking. The surviving stall is
  // 246 of 249 ms inside ONE call — the sixth render of the world scene, the
  // forward pass into the MSAA HDR target — with the other five world calls at
  // 0.1 ms each and the viewmodel at 0.5. A single pass blocking for a quarter of
  // a second while allocating nothing is a driver building a pipeline for a draw
  // it has not seen before, and the only way to get a new draw into that pass
  // without allocating is for something already there to become visible.
  //
  // Off by default: it traverses the whole world scene every frame.
  const visKey = (o) => `${o.name || o.type}#${o.material?.uuid?.slice(0, 6) ?? '-'}`;
  let prevVis = null;
  const becameVisible = [];
  const seenProg = new Set();
  const lateProgs = [];
  { const seed = []; walk(e.viewScene, seed); walk(e.scene, seed); }

  const phaseAcc = window.__PHASE__;
  const stalls = [];

  // Steady-state cost, which is a different question from stall cost and needs a
  // different statistic.
  //
  // `stalls` only samples frames over 50 ms, so everything above answers "what
  // went wrong on the worst frames" and nothing answers "where do the 28 ms of a
  // NORMAL frame go" — which is the number the player actually experiences as a
  // frame rate. Both accumulators are cleared every frame, so the ordinary frames
  // were being thrown away.
  //
  // Per-key samples, reduced to a MEDIAN rather than a mean: one 250 ms compile
  // inside `render.render` would drag a mean of 900 frames by a quarter of a
  // millisecond per frame and quietly misattribute it as steady-state cost. The
  // median ignores it, which is the whole point.
  const steady = new Map();
  const noteSteady = (key, ms) => {
    let a = steady.get(key);
    if (!a) steady.set(key, (a = []));
    a.push(ms);
  };

  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;

    // The map holds the PREVIOUS frame's phase totals, because this callback runs
    // before the engine steps again. A frame that stalled is therefore explained by
    // the numbers standing here at the top of the frame after it.
    if (dt > 50 && phaseAcc?.size) {
      const top = [...phaseAcc.entries()]
        .filter(([, ms]) => ms > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, ms]) => `${k} ${ms.toFixed(1)}`);
      const rp = window.__RPASS__;
      const passes = rp?.size
        ? [...rp.entries()]
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 6)
          .map(([k, v]) => `${k} ${v.ms.toFixed(1)}(x${v.n}) seq[${v.seq.slice(0, 8).join(' ')}]`)
        : undefined;
      stalls.push({ frame: i, ms: +dt.toFixed(1), top, ...(passes ? { passes } : {}) });
    } else if (i > 60) {
      // Same 60-frame warmup the percentiles drop, and stalls excluded by the
      // branch above — so this is the distribution of ordinary frames only.
      noteSteady('frame', dt);
      if (phaseAcc) for (const [k, ms] of phaseAcc) noteSteady(`phase:${k}`, ms);
      const rp = window.__RPASS__;
      if (rp) for (const [k, v] of rp) noteSteady(`pass:${k}`, v.ms);
    }
    phaseAcc?.clear();
    // Same one-frame lag as `phaseAcc`, and cleared in the same place for the
    // same reason: these totals describe the frame that just ended.
    window.__RPASS__?.clear();

    if (window.__VISDIFF__) {
      const now = new Set();
      e.scene.traverse((o) => { if (o.geometry && o.visible) now.add(visKey(o)); });
      if (prevVis) {
        // `visible` on the object alone, not effective visibility through its
        // ancestors — three culls on the whole chain, so a child of a hidden group
        // reads as visible here and never draws. That would be a false positive if
        // the groups moved, and they do not: the flips this is hunting are on leaf
        // meshes. Worth knowing before reading a name off this list as guilty.
        const fresh = [...now].filter((k) => !prevVis.has(k));
        const gone = [...prevVis].filter((k) => !now.has(k));
        if (fresh.length || gone.length) {
          becameVisible.push({ frame: i, on: fresh.slice(0, 10), off: gone.slice(0, 6) });
        }
      }
      prevVis = now;
    }
    { const fresh = []; walk(e.viewScene, fresh); walk(e.scene, fresh);
      for (const k of fresh) appeared.push({ frame: i, ...k }); }

    // WHICH program, not just how many.
    //
    // `progDelta: 1` on a 240 ms frame is the single most useful number this tool
    // produces and also the least actionable, because one program out of a hundred
    // is not a thing you can go and pre-warm. three keeps a `cacheKey` on every
    // compiled program that spells out the permutation — material type, lights,
    // shadows, skinning, the lot — so diffing the cache against the previous frame
    // turns "a program" into the exact permutation the pre-warm missed.
    // ...and WHICH FIELD of it differs, which is the part that names a fix.
    //
    // Knowing that a permutation arrived late still leaves you guessing at why
    // the warm missed it: the previous round of this hunt ended in a documented
    // hypothesis (light count) that nothing in the tool could confirm or kill.
    // But a cache key is a comma-separated field list, and the program that
    // SHOULD have covered the newcomer is already in the cache — so diffing it
    // against its nearest already-compiled neighbour turns "why" into a field
    // index and a pair of values. One field differing is the answer. Several
    // mean it is a genuinely new material and the warm never had it at all.
    for (const p of r.renderer.info.programs ?? []) {
      const k = p.cacheKey;
      if (!k || seenProg.has(k)) continue;
      if (i > 0) {
        const f = String(k).split(',');
        let best = null;
        for (const q of seenProg) {
          const g = q.split(',');
          if (g.length !== f.length) continue;
          let d = 0;
          const at = [];
          for (let x = 0; x < f.length; x++) {
            if (f[x] === g[x]) continue;
            d++;
            if (at.length < 6) at.push(`#${x} ${g[x] || "''"} -> ${f[x] || "''"}`);
          }
          if (!best || d < best.d) best = { d, at };
        }
        lateProgs.push({
          frame: i,
          lights: (r.lights ?? []).reduce((n, l) => n + (l.light?.visible ? 1 : 0), 0),
          nearest: best,
          key: String(k).slice(0, 200),
        });
      }
      seenProg.add(k);
    }

    // Drive gameplay: orbit the view, walk, and fire in bursts.
    const t = i / 60;
    e.camera.rotation.y += 0.006;
    const mv = e.ctx.peek('player');
    if (mv) { try { e.input.down.add('KeyW'); } catch {} }
    if (i % 90 < 30) { e.input.down.add('Mouse0'); } else { e.input.down.delete('Mouse0'); }

    // VISIBLE LIGHT COUNT, because three folds it into the program cache key.
    //
    // `render._cullLights` sets `light.visible = fade > 0.002` from camera
    // distance, so a light crossing its fade radius changes the count — and every
    // patched material then needs a new program for the new count. That is a
    // plausible mechanism for the 250 ms compiles that keep arriving at random
    // frames mid-match, and it is cheap to confirm or kill: if the count never
    // moves, the mechanism is not this, whatever else it is.
    const visLights = (r.lights ?? []).reduce((n, e) => n + (e.light?.visible ? 1 : 0), 0);
    // MACHINE CONTENTION PROBE — is this number about the build or the box?
    //
    // A fixed amount of arithmetic, timed. It has nothing to do with the game,
    // which is the point: whatever it costs is what the CPU had left to give.
    // Sampled alongside the frames rather than once at the start, because a run
    // that begins on a quiet machine and ends on a busy one is exactly the case
    // that produces a confident wrong answer.
    //
    // No external baseline, deliberately. "How fast should this machine be" is
    // not knowable from inside a run, and a number checked into the repository
    // would bake in whatever this laptop was doing the day it was written. The
    // SPREAD needs no baseline: a saturated core shows up as scheduler jitter,
    // so min and max of the same work diverge.
    let spin = 0;
    if (i % 40 === 0) {
      const t0 = performance.now();
      let acc = 0;
      for (let k = 0; k < 4000000; k++) acc += k % 7;
      spin = performance.now() - t0;
      if (acc === -1) window.__NEVER__ = acc;   // keep the loop from folding away
    }

    samples.push({
      i, dt, visLights, spin,
      progs: r.renderer.info.programs?.length ?? 0,
      calls: r.renderer.info.render.calls,
      tris: r.renderer.info.render.triangles,
      geos: r.renderer.info.memory.geometries,
      texs: r.renderer.info.memory.textures,
      heap: performance.memory ? performance.memory.usedJSHeapSize >> 20 : 0,
    });

    if (++i >= FRAMES) {
      window.__ALLOC_ARMED__ = false;
      const steadyOut = [...steady.entries()]
        .map(([k, a]) => {
          const s = a.sort((x, y) => x - y);
          const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
          return { key: k, n: s.length, p50: q(0.5), p90: q(0.9) };
        })
        .filter((r) => r.p50 >= 0.05) // sub-0.05 ms rows are noise, not budget
        .sort((a, b) => b.p50 - a.p50);
      return done({ samples, appeared, lateProgs, stalls, becameVisible, steady: steadyOut });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), FRAMES);
const appeared = result.appeared ?? [];
const lateProgs = result.lateProgs ?? [];
const stalls = result.stalls ?? [];
const samplesArr = result.samples ?? result;

const allocations = await page.evaluate(() =>
  [...window.__ALLOC__.values()].sort((a, b) => a.frame - b.frame).slice(0, 20));

/**
 * Resolve the minified stacks through the build's own sourcemap.
 *
 * Without this the trace above reads `at e (index-DfVZe82X.js:40:80963)`, which
 * names nothing and cannot be acted on — the whole point of capturing a stack is
 * to get a file and a line, and a profiler that reports mangled identifiers has
 * done the expensive part of the work and thrown away the answer.
 *
 * `source-map-js` is a transitive dependency (vite pulls it in via postcss), so
 * this degrades to the raw frames rather than failing if it ever goes away.
 */
async function resolveStacks(list) {
  let SourceMapConsumer;
  try {
    ({ SourceMapConsumer } = await import('source-map-js'));
  } catch {
    return list.map((a) => ({ ...a, at: '(no sourcemap consumer available)' }));
  }
  const maps = new Map();
  const consumerFor = async (file) => {
    if (maps.has(file)) return maps.get(file);
    let c = null;
    try {
      const raw = await readFile(resolve('dist', file.replace(/^\/+/, '')) + '.map', 'utf8');
      c = new SourceMapConsumer(JSON.parse(raw));
    } catch { /* no map for this file */ }
    maps.set(file, c);
    return c;
  };
  const out = [];
  for (const a of list) {
    const frames = [];
    for (const f of String(a.stack).split(' | ')) {
      const m = f.match(/https?:\/\/[^/]+(\/[^\s):]+):(\d+):(\d+)/);
      if (!m) continue;
      const c = await consumerFor(m[1]);
      const pos = c?.originalPositionFor({ line: Number(m[2]), column: Number(m[3]) });
      frames.push(pos?.source
        ? `${pos.source.replace(/^.*\/(src|node_modules)\//, '$1/')}:${pos.line}${pos.name ? ` ${pos.name}` : ''}`
        : `${m[1]}:${m[2]}:${m[3]}`);
    }
    // `ours` is the payload. Everything above it is three.js doing what it was
    // asked; the question a profile has to answer is who asked.
    const ours = frames.filter((f) => f.startsWith('src/'));
    out.push({
      ...a,
      ours: ours.slice(0, 3).join(' <- ') || '(never leaves three.js — engine-internal)',
      at: frames.slice(0, 4).join(' <- '),
      stack: undefined,
    });
  }
  return out;
}
const allocationsResolved = await resolveStacks(allocations);

// Discard the first 60 frames: control handover and the first shadow-cascade fit
// are one-time costs, not steady state.
//
// `--warmup=0` keeps them, which is how you see the COLD first-load experience:
// a lazily-compiled program lands in exactly those discarded frames, so the
// default view is blind to the stall the pre-warm exists to remove.
const WARMUP = Number(args.warmup ?? 60);
const warm = samplesArr.slice(WARMUP);
const dts = warm.map((s) => s.dt).sort((a, b) => a - b);
const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
const med = q(0.5);

const hitches = warm
  .filter((s) => s.dt > Math.max(2 * med, med + 8))
  .map((s, n, arr) => {
    const prev = warm[warm.indexOf(s) - 1];
    return {
      frame: s.i, ms: +s.dt.toFixed(1),
      progDelta: prev ? s.progs - prev.progs : 0,
      geoDelta: prev ? s.geos - prev.geos : 0,
      texDelta: prev ? s.texs - prev.texs : 0,
    };
  });

const first = warm[0], lastS = warm[warm.length - 1];
/**
 * What the contention probe saw. `spread` is max/min of the same fixed work.
 *
 * 1.0 is a machine that gave every sample the same CPU. Anything far above it
 * means the numbers beside it are partly a measurement of something else.
 */
const spins = samplesArr.map((s) => s.spin).filter((v) => v > 0).sort((a, b) => a - b);
const machine = spins.length >= 3
  ? {
    samples: spins.length,
    minMs: +spins[0].toFixed(2),
    medMs: +spins[spins.length >> 1].toFixed(2),
    p90Ms: +spins[Math.min(spins.length - 1, Math.floor(spins.length * 0.9))].toFixed(2),
    maxMs: +spins[spins.length - 1].toFixed(2),
    // p90 over median, not max over min. The extremes are one sample each, and
    // one sample is exactly what a single GC pause or a JIT tier-up looks like;
    // measured on a healthy run, max/min read 11x while the work itself was
    // stable. A ratio of two order statistics does not move for one outlier.
    spread: +(spins[Math.min(spins.length - 1, Math.floor(spins.length * 0.9))]
      / Math.max(spins[spins.length >> 1], 1e-6)).toFixed(2),
  }
  : null;

const fpsOut = {
  p50: +(1000 / med).toFixed(0),
  p95: +(1000 / q(0.95)).toFixed(0),
  p99: +(1000 / q(0.99)).toFixed(0),
};
const programsOut = {
  start: first.progs,
  end: lastS.progs,
  compiledDuringPlay: lastS.progs - first.progs,
};

console.log(JSON.stringify({
  bootMs,
  bootMarks,
  internal,
  frames: warm.length,
  /** Distinct visible-light counts seen during play, and where they changed. */
  lightCounts: (() => {
    const seen = new Map();
    let prev = null;
    const changes = [];
    for (const s of samplesArr) {
      seen.set(s.visLights, (seen.get(s.visLights) ?? 0) + 1);
      if (prev !== null && s.visLights !== prev) changes.push({ frame: s.i, from: prev, to: s.visLights });
      prev = s.visLights;
    }
    return { histogram: [...seen.entries()].sort((a, b) => a[0] - b[0]), changes: changes.slice(0, 20) };
  })(),
  frameTimeMs: { p1: q(0.01), p50: med, p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
  fps: fpsOut,
  hitchCount: hitches.length,
  hitchPctOfFrames: +((hitches.length / warm.length) * 100).toFixed(2),
  worstHitches: hitches.sort((a, b) => b.ms - a.ms).slice(0, 15),
  programs: programsOut,
  /** CPU contention probe — see the note where `spin` is sampled. */
  machine,
  resources: { geosStart: first.geos, geosEnd: lastS.geos, texStart: first.texs, texEnd: lastS.texs },
  heapMb: { start: first.heap, end: lastS.heap, growth: lastS.heap - first.heap },
  drawCalls: { min: Math.min(...warm.map(s=>s.calls)), max: Math.max(...warm.map(s=>s.calls)) },
  /** GL object allocations during play, earliest first — see the wrapper above. */
  allocations: allocationsResolved,
  /** Geometry-bearing objects that entered a scene during play. */
  appeared: appeared.slice(0, 24),
  becameVisible: (result.becameVisible ?? []).slice(0, 40),
  steady: result.steady ?? [],
  /** Programs compiled after frame 0, with three's own permutation cache key. */
  lateProgs: lateProgs.slice(0, 10),
  /** Per-subsystem breakdown of every frame over 50 ms. */
  stalls: stalls.slice(0, 14),
  errors: errs.slice(0, 6),
}, null, 2));

await browser.close();
// Only ours. A preview server that was already up on this port belongs to
// whoever started it, and killing it would be a surprise to them.
if (server) { try { process.kill(-server.pid); } catch { /* already gone */ } }

/* ------------------------------------------------------------------ gate */

/**
 * `--gate`: turn the profile into a pass/fail the suite can run.
 *
 * WHY THE THRESHOLDS ARE WHERE THEY ARE, and what is deliberately NOT gated:
 *
 * `p50` is a floor with a lot of room under it, not a target. This machine's
 * frame time drifts with its own temperature — the same bundle has measured
 * 27.3 ms early in a session and 31.4 ms an hour later, which is why
 * `tools/abperf.mjs` exists — so a tight median gate would fail on the fan
 * rather than on the code. 35 fps sits well below the 49-56 measured across a
 * dozen runs and still catches a change that halves the frame rate.
 *
 * `stall` is the number that actually describes how the game FEELS. A 150 ms
 * frame is a visible lurch, and no amount of good median hides one.
 *
 * `compiledDuringPlay` is required to be 0. It was bounded at 1 for as long as
 * the job was unfinished, and the thing that finished it was not another idea
 * about renderers but the `nearest` diff added below: a late cache key beside
 * its closest already-compiled neighbour names the field, and the field names
 * the fix. Two rounds of it, both in `ai.prewarmMaterials`:
 *
 *     #4   srgb -> srgb-linear     warming against the canvas, not the HDR target
 *     #35  3    -> 2               numDirLights, which `render` flips when the
 *                                  sky takes the key light over
 *
 * Verified 12 runs clean, from 6 in 12 immediately before the second fix. The
 * bound is 0 now because a residue nobody can attribute is exactly what a bound
 * of 1 lets back in.
 */
if (args.gate) {
  const P50_FPS_FLOOR = 35;
  const STALL_CEIL_MS = 250;
  const LATE_PROGRAM_CEIL = 0;
  const bad = [];
  const p50 = fpsOut.p50;
  const worstStall = stalls.length ? Math.max(...stalls.map((s) => s.ms)) : 0;
  const compiled = programsOut.compiledDuringPlay;
  if (p50 < P50_FPS_FLOOR) bad.push(`p50 ${p50} fps < ${P50_FPS_FLOOR}`);
  if (worstStall > STALL_CEIL_MS) bad.push(`worst frame ${worstStall} ms > ${STALL_CEIL_MS}`);
  if (compiled > LATE_PROGRAM_CEIL) {
    bad.push(`${compiled} shader programs compiled during play > ${LATE_PROGRAM_CEIL}`);
  }
  if (errs.length) bad.push(`page errors: ${errs.slice(0, 2).join(' | ')}`);

  /**
   * THE CPU PROBE IS REPORTED, NOT GATED — and the reason is a failed experiment
   * worth keeping so it is not repeated.
   *
   * The problem is real: this gate spent a day catching a security agent rather
   * than a regression. The same commit measured p50 57 fps and p50 13 fps within
   * an hour while `astxd` held a core at 95 %, and `converge` in the same suite
   * run reported 80 fps against its usual 120. A frame-time gate that cannot
   * tell a slow build from a busy box teaches everyone to ignore it.
   *
   * The attempted fix was to downgrade a failure to UNRESOLVED when the machine
   * was visibly contended, deciding that from the SPREAD of the probe so that no
   * baseline was needed. The reasoning was that a saturated core shows up as
   * scheduler jitter. Measured under a deliberate four-way CPU load, it does
   * not: p50 fell 57 -> 44 fps and the probe's median rose 2.0 -> 2.5 ms, while
   * the spread did not move at all (1.85 -> 1.84). Time-slicing is fair, so
   * contention arrives as a uniform tax, not as variance.
   *
   * So the only signal here is the MEDIAN, and reading an absolute millisecond
   * figure requires a baseline for the machine — which is exactly what this tool
   * cannot have and what a constant checked into the repository would only
   * pretend to be.
   *
   * A downgrade rule built on the wrong statistic is worse than none: it would
   * mask real regressions on quiet machines while still failing on busy ones.
   * The probe stays because a human reading the line can see 2.0 ms and 8.0 ms
   * as different, and that is worth having even when a machine cannot act on it.
   */
  const note = machine
    ? `cpu probe med ${machine.medMs} ms, p90 ${machine.p90Ms} ms, spread ${machine.spread}x`
    : 'cpu probe unavailable';

  console.log(
    bad.length === 0
      ? `\nPROFILE OK — p50 ${p50} fps, p99 ${fpsOut.p99} · worst frame ${worstStall} ms · `
        + `${compiled} late shader program(s) · ${internal.megapixels} MP at dpr ${DPR} · ${note}`
      : `\nPROFILE FAILED (${bad.length}):\n  ${bad.join('\n  ')}\n  (${note} — `
        + `if that median is far above its usual 2 ms, suspect the box before the build)`
  );
  process.exit(bad.length === 0 ? 0 : 1);
}
