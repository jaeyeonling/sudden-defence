#!/usr/bin/env node
/**
 * REPLAY — snapshot a tick, run on, restore, replay the same commands, and
 * require the world to arrive at bit-identical state.
 *
 * THE INVARIANT
 *
 *   Snapshot at tick K. Simulate to N. Restore K. Feed the SAME commands
 *   K+1..N. The state at N must be EXACTLY what it was the first time.
 *
 * Exactly. Not close. A tolerance here would not be a measurement choice, it
 * would be a hole: the whole point of this gate is to catch a field that the
 * snapshot forgot, and a forgotten field's first divergence is usually tiny.
 * `aim.mjs` learned the same thing the hard way — its 1e-4 ceiling passed a
 * 5e-5 defect until the bound was derived from the invariant (bit-identity)
 * instead of from what a human would notice.
 *
 * WHY THE COMPARISON IS EXHAUSTIVE AND NOT A CHECKLIST
 *
 * The obvious gate hashes a few numbers — player position, bot count, score —
 * and goes green. That gate cannot fail for the reason this work will actually
 * break: a field nobody thought to list. Whoever writes the snapshot writes the
 * checklist, so the checklist agrees with the snapshot by construction.
 *
 * This is not hypothetical. The handoff for this work shipped a hand-written
 * table of "mutable simulation state" and it was wrong twice in the other
 * direction as well — two RNG streams listed as simulation that no line of code
 * ever read (`84a05c4`). A table is wrong quietly. So:
 *
 *   LAYER 1 — VALUE.     Walk the simulation objects, dump every scalar leaf,
 *                        diff the maps. A field missing from the snapshot keeps
 *                        its post-N value across the restore and then diverges.
 *   LAYER 2 — STRUCTURE. Every own key of a simulation subsystem must be either
 *                        captured or explicitly declared presentation. Catches
 *                        the omission that layer 1 cannot: a field that did not
 *                        happen to move during this scenario.
 *   LAYER 3 — STREAMS.   Every stream registered `fork({ snapshot: true })` must
 *                        appear in the capture. The registry and the per-
 *                        subsystem hooks are deliberately redundant; layer 3 is
 *                        where the redundancy pays.
 *
 * LAYER 0 EXISTS SO THIS PROBE CAN BE SEEN TO WORK
 *
 * A probe that reports nothing looks exactly like a probe that is broken
 * (`profile.mjs --stallms` carries the same note). Layers 1-3 cannot run until
 * `captureState` exists, so this file would otherwise be a gate that fails for
 * one uninformative reason and proves nothing about its own comparison.
 *
 * Layer 0 runs today, against the live game:
 *
 *   0a  the same tick dumped twice is identical      — the dump is stable
 *   0b  tick T and tick T+1 dump differently         — the dump is sensitive
 *
 * 0a alone would pass on a dump that returned the empty map. 0b is what makes
 * 0a mean something.
 *
 * Both have an induced failure, because a guard nobody has watched fire is a
 * guard nobody knows the shape of:
 *
 *   --maxdepth=6   cut the walk short. Reports 483 truncated branches and fails.
 *   --nodump       flatten every number to a constant. This one earned its keep
 *                  on the first run: 0b originally asserted "some leaf moved"
 *                  and PASSED while blind, because 21 strings and flags moved
 *                  on their own. 0b now asserts on NUMBERS moving, which is
 *                  where positions, timers and rng words live.
 *
 * WHAT THIS GATE DOES NOT PROVE
 *
 * Layer 2 lets a subsystem declare a key presentation, and layer 1 then skips
 * it. A field wrongly declared escapes both. That is a recorded human claim
 * rather than an oversight — a different failure class, and a greppable one —
 * but it is a hole and it is stated here rather than left for someone to find.
 *
 * Local replay only. Nothing here says two MACHINES agree; see §5 of the
 * handoff. Same build, same page, same floating-point unit.
 *
 * Layer 1 has two of its own:
 *
 *   --drop=weapons._spread   write the field's value at N over the captured one,
 *                            so it does not rewind. This is what a snapshot that
 *                            forgot the field would do.
 *   --tamper                 change one recorded command mid-span, so the replay
 *                            feeds input the original pass never saw.
 *
 *   node tools/replay.mjs [--port=5173] [--k=60] [--span=110]
 *                         [--maxdepth=12] [--nodump]
 *                         [--drop=sys.field] [--tamper] [--keep]
 */
import { chromium } from 'playwright';
import net from 'node:net';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
/** Tick to snapshot at. Far enough in that the world is not in its boot pose. */
const K = Number(args.k ?? 60);
/**
 * How many ticks to replay. A SPAN, not an absolute N: the snapshot is taken
 * once the round reaches its live phase, and where that lands depends on the
 * tempo rather than on anything this file should hardcode.
 *
 * Must stay under CMD_HISTORY (128) — past that the ring has rolled over the
 * commands the replay needs, and the failure would be the harness running out
 * of history rather than the game diverging.
 */
const SPAN = Number(args.span ?? 110);
/** How many differing leaves to print. Above 40 the values are omitted. */
const ROWS = Number(args.rows ?? 16);

if (SPAN >= 128) {
  console.log(`REPLAY FAILED — harness: span is ${SPAN}, the command ring holds 128`);
  process.exit(1);
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  vite = spawn('npx', ['vite', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 80 && !(await portOpen(PORT)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ K, SPAN, MAXDEPTH, NODUMP, DROP, TAMPER, ROWS, NOLOD }) => {
    const e = window.__ENGINE__;
    const ctx = e.ctx;

    /* ================================================================== *
     *  The dump                                                          *
     * ================================================================== */

    /**
     * Which subsystems hold simulation state. Presentation subsystems (render,
     * fx, audio, ui, sky, materials) are absent on purpose: their state is
     * allowed to differ across a replay and comparing it would produce failures
     * that mean nothing.
     *
     * `world` is here as a root but holds no mutable state — the level is baked
     * before the first tick. If it ever grows some, this list is already asking
     * the question.
     */
    const SIM_IDS = ['physics', 'match', 'world', 'weapons', 'player', 'ai'];

    /**
     * How a value is turned into something comparable.
     *
     * Floats are compared as their exact bit pattern, not as numbers: `Object.is`
     * would already separate 0 from -0, but writing the value through a
     * Float64Array and reading two uint32s also makes the failure report show
     * WHICH bits moved, which is the difference between "position drifted" and
     * "position is a different value entirely".
     */
    /**
     * A declaring object's two lists, or null. Defined up here because BOTH
     * layers need it: layer 2 audits against it and layer 1's walk skips the
     * excluded half.
     *
     * Cached per constructor — `declOf` runs once per object per dump, and a
     * dump visits half a million leaves.
     */
    const declCache = new Map();
    const declOf = (o) => {
      const C = o?.constructor;
      if (!C) return null;
      if (declCache.has(C)) return declCache.get(C);
      const s = Array.isArray(C.snapshotState) ? C.snapshotState : null;
      const x = Array.isArray(C.excludedState) ? C.excludedState : null;
      const d = s && x ? { snap: new Set(s), exc: new Set(x) } : null;
      declCache.set(C, d);
      return d;
    };

    const f64 = new Float64Array(1);
    const u32 = new Uint32Array(f64.buffer);
    const scalar = (v) => {
      if (typeof v === 'number') {
        // `--nodump` flattens every number to a constant. The dump then still
        // has half a million leaves and still passes 0a, and 0b is the only
        // thing that notices it has gone blind — which is precisely the claim
        // 0b exists to make.
        if (NODUMP) return 'n:blind';
        f64[0] = v;
        return `n:${u32[0].toString(16)}.${u32[1].toString(16)}`;
      }
      if (typeof v === 'boolean') return `b:${v}`;
      if (typeof v === 'string') return `s:${v}`;
      if (v === null) return 'null';
      if (v === undefined) return 'undef';
      if (typeof v === 'bigint') return `big:${v}`;
      return null;
    };

    /**
     * Typed arrays are hashed rather than expanded. A ragdoll's particle buffer
     * is thousands of floats and expanding it would bury every other finding in
     * the report; the hash still diverges if any element does. FNV-1a over the
     * bytes, which is enough for "did this change" and makes no claim beyond it.
     */
    const hashBytes = (buf) => {
      const b = new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
      let h = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) {
        h ^= b[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16);
    };

    // Exposed as `--maxdepth` so the depth-cap failure can be induced on demand.
    // A guard nobody has watched fire is a guard nobody knows the shape of; this
    // is the same reason `profile.mjs` has `--stallms`.
    const MAX_DEPTH = MAXDEPTH;

    /**
     * Walk `root`, writing every scalar leaf into `out` keyed by its path.
     *
     * The pruning is the whole design problem. Recursing blindly reaches a
     * material, then a texture, then a canvas, and never comes back. Pruning at
     * `Object3D` instead loses `agent.group.position` — which IS the bot's
     * simulated position. So `Object3D` is neither followed nor dropped: its
     * transform is recorded and its children are not.
     */
    const walk = (root, rootName, out, stats, barrier) => {
      const seen = new WeakSet();
      const rec = (v, path, depth) => {
        // Every subsystem holds `ctx`, and `ctx` reaches the engine, the
        // registry and every other subsystem — so an unguarded walk arrives at
        // the same object down dozens of paths and the depth cap, not the
        // design, decides which copy survives. The first run of this gate
        // reported `physics.characters[0].owner.movement.ctx.engine.commands`
        // and cut 4413 branches to do it.
        //
        // A foreign root is recorded as a reference and not followed. It gets
        // walked under its own name instead, once.
        if (v !== null && typeof v === 'object' && v !== root && barrier.has(v)) {
          out.set(path, `ref:${barrier.get(v)}`);
          return;
        }
        const s = scalar(v);
        if (s !== null) {
          out.set(path, s);
          return;
        }
        if (typeof v === 'function') return;
        if (typeof v !== 'object') return;
        if (depth > MAX_DEPTH) {
          stats.depthCut++;
          // Report WHERE, not just how many. A count tells you the dump is
          // incomplete; the path tells you whether to raise the cap or to prune
          // a structure that has no business being walked at all.
          if (stats.deepPaths.length < 40) stats.deepPaths.push(path);
          return;
        }
        if (seen.has(v)) return;
        seen.add(v);

        if (ArrayBuffer.isView(v)) {
          out.set(path, `ta:${v.length}:${hashBytes(v)}`);
          return;
        }
        // DOM, WebGL, WebAudio. All presentation, all bottomless.
        if (v.nodeType !== undefined || typeof v.connect === 'function') {
          stats.pruned++;
          return;
        }
        // three's leaf resources. `isX` flags are three's own tagging.
        if (v.isMaterial || v.isTexture || v.isBufferGeometry || v.isWebGLRenderer ||
            v.isScene || v.isCamera || v.isLight || v.isSkeleton) {
          stats.pruned++;
          return;
        }
        if (v.isVector3 || v.isVector2 || v.isVector4 || v.isQuaternion || v.isEuler) {
          for (const k of ['x', 'y', 'z', 'w', 'order']) {
            if (v[k] !== undefined) rec(v[k], `${path}.${k}`, depth + 1);
          }
          return;
        }
        if (v.isMatrix4 || v.isMatrix3) {
          out.set(path, `m:${v.elements.join(',')}`);
          return;
        }
        if (v.isObject3D) {
          // Transform yes, subtree no. Bones below here are driven by the
          // animator, which is presentation and is allowed to differ.
          rec(v.position, `${path}.position`, depth + 1);
          rec(v.quaternion, `${path}.quaternion`, depth + 1);
          rec(v.scale, `${path}.scale`, depth + 1);
          rec(v.visible, `${path}.visible`, depth + 1);
          return;
        }
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) rec(v[i], `${path}[${i}]`, depth + 1);
          return;
        }
        if (v instanceof Map) {
          for (const [k, val] of v) rec(val, `${path}{${String(k)}}`, depth + 1);
          return;
        }
        if (v instanceof Set) {
          // Order-independent: a Set that yields the same members in a different
          // order is the same Set, and reporting that as divergence would be a
          // harness defect dressed as a finding.
          out.set(path, `set:${[...v].map((x) => String(scalar(x) ?? '?')).sort().join('|')}`);
          return;
        }
        // Honour the classification. Layer 2 has already forced every own key of
        // a declaring object into exactly one list; layer 1 compares the
        // snapshot half and skips the other. Without this the dump compares
        // viewmodel poses, HUD bags and animator scratch, all of which are
        // ALLOWED to differ across a rewind — and a gate that fails on 2000
        // legitimate differences cannot show you the one that matters.
        //
        // This is the hole named in the header: a field wrongly placed in
        // `excludedState` escapes here as well as in layer 2. That is a recorded
        // human claim rather than an oversight, and it is greppable.
        const d = declOf(v);
        for (const k of Object.keys(v)) {
          if (d && d.exc.has(k)) continue;
          rec(v[k], `${path}.${k}`, depth + 1);
        }
      };
      rec(root, rootName, 0);
    };

    /**
     * Objects the walk must not cross into: every subsystem (simulation or
     * presentation), plus the engine spine. Presentation subsystems are in here
     * without being dumped, which is how `render` stays out of the comparison
     * even though `player` holds a reference to it.
     */
    //
    // `Registry` keeps `#systems` private, so the ids are listed rather than
    // enumerated. A missing id here does not corrupt the comparison, it only
    // lets the walk cross into that subsystem down someone else's path — and
    // that shows up as a non-zero `depthCut`, which the gate fails on. The list
    // is checked, not trusted.
    const ALL_IDS = ['render', 'materials', 'sky', 'physics', 'fx', 'world',
      'match', 'player', 'weapons', 'ai', 'audio', 'ui'];

    /**
     * Entities are barriers too, and for the same reason one level down.
     *
     * Agents reach each other through `squad.members`, and cover candidates
     * reach back through `_cand[].host`, so the walk wanders the roster before
     * arriving anywhere — the first run with the subsystem barrier in place was
     * still cutting 550 branches, every one of them shaped
     * `physics.colliders[].owner.squad.members[]._cand[].host.def.weapon.…`.
     * Path length there is not depth in the data, it is the walk going in
     * circles.
     *
     * Naming them is also the thing §2.1 of the handoff demands of the snapshot
     * itself: an entity has to be addressable by a STABLE id, not by a pointer
     * or a position in an array that a pool reorders. If these names turn out
     * not to be stable, this gate is where that shows up — as a diff between
     * two runs that simulated the same thing.
     */
    const entityRoots = () => {
      const rs = [];
      const ai = ctx.peek('ai');
      const match = ctx.peek('match');
      for (const a of [...(ai?.agents ?? [])].sort((x, y) => x.id - y.id)) {
        rs.push([`agent#${a.id}`, a]);
      }
      // Squads carry no id of their own; creation order is the only handle, and
      // `ai.squads` is append-only (`createSquad` pushes, nothing splices).
      (ai?.squads ?? []).forEach((s, i) => rs.push([`squad#${i}`, s]));
      for (const c of [...(match?.combatants ?? [])].sort((x, y) => x.id - y.id)) {
        rs.push([`combatant#${c.id}`, c]);
      }
      return rs;
    };

    const buildBarrier = (entities) => {
      const b = new Map();
      for (const id of ALL_IDS) {
        const s = ctx.peek(id);
        if (s) b.set(s, id);
      }
      for (const [name, obj] of entities) b.set(obj, name);
      b.set(ctx, 'ctx');
      b.set(e, 'engine');
      if (ctx.registry) b.set(ctx.registry, 'registry');
      if (e.commands) b.set(e.commands, 'commands');
      if (ctx.scene) b.set(ctx.scene, 'scene');
      if (ctx.input) b.set(ctx.input, 'input');
      if (ctx.config) b.set(ctx.config, 'config');
      return b;
    };

    const dumpAll = () => {
      const out = new Map();
      const stats = { pruned: 0, depthCut: 0, deepPaths: [] };
      const entities = entityRoots();
      const barrier = buildBarrier(entities);
      for (const id of SIM_IDS) {
        const sys = ctx.peek(id);
        if (sys) walk(sys, id, out, stats, barrier);
      }
      for (const [name, obj] of entities) walk(obj, name, out, stats, barrier);
      return { map: out, stats, entities: entities.length };
    };

    /**
     * `numeric` is counted apart from the total, and 0b asserts on it rather
     * than on the total.
     *
     * The `--nodump` control is what forced this. Blinding every number still
     * left 23 leaves moving — strings, flags, a BVH scratch buffer's hash — so
     * `count > 0` was satisfied by a dump that could not see a single simulated
     * quantity. Positions, velocities, timers and RNG words are all numbers;
     * "the dump is sensitive" has to mean sensitive to those.
     */
    const diff = (a, b, limit = 12) => {
      const rows = [];
      let n = 0, numeric = 0;
      const keys = new Set([...a.keys(), ...b.keys()]);
      for (const k of keys) {
        const va = a.get(k), vb = b.get(k);
        if (va === vb) continue;
        n++;
        if (typeof va === 'string' && va.startsWith('n:') && va !== 'n:blind') numeric++;
        if (rows.length < limit) rows.push({ path: k, a: va ?? '<absent>', b: vb ?? '<absent>' });
      }
      return { count: n, numeric, rows };
    };

    /* ================================================================== *
     *  Take the clock                                                    *
     * ================================================================== */

    // `engine.step(now)` derives dt from the timestamp it is handed, so feeding
    // it exactly one fixed step of wall clock runs exactly one tick. That is the
    // seam the replay loop will use; driving rAF instead would put a variable
    // number of ticks in each call and make "tick K" unaddressable.
    //
    // Two pieces of engine state have to be handed over with the clock, and
    // neither is optional: `_last` is the timestamp the next dt is measured
    // against (leave it and the first synthetic step sees however long the
    // browser took to get here), and `_accum` is the leftover fraction of a tick
    // from the last real frame (leave it and the first call runs two). The gate
    // drove to tick 62 asking for 60 before this existed — which is the
    // precondition assertion below earning its place on its first run.
    const H = 1000 / 120;
    if (ctx.time.scale !== 1) {
      return { fatal: `time.scale is ${ctx.time.scale}; the tick maths below assumes 1` };
    }
    e.stop();
    let clock = performance.now();
    e._last = clock;
    e._accum = 0;
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) {
        clock += H;
        e.step(clock);
      }
    };

    const startTick = ctx.time.tick;
    tick(Math.max(0, K - startTick));
    if (ctx.time.tick !== K) {
      return { fatal: `drove to tick ${ctx.time.tick}, wanted ${K} — step() is not one tick per call` };
    }

    /**
     * GET TO A TICK WHERE SOMETHING HAPPENS.
     *
     * The first version snapshotted at 61 and compared at 180 — half a second to
     * a second and a half at 120 Hz, which is entirely inside the 4 s warmup. The
     * player is frozen, the round has not started, and the span moved 70 leaves
     * out of 4589. Both induced failures PASSED against that: dropping
     * `weapons._spread` from the snapshot changed nothing because nothing was
     * shooting, and tampering with a command's `moveX` changed nothing because
     * nobody was moving. A green from that scenario is worth exactly as much as
     * `converge` would be with the bots asleep.
     *
     * So: fast-forward to the live phase, and then drive the player. `override`
     * is the seam `observe.mjs` already uses; `build` ignores it entirely once
     * the replay starts, so what the original pass sees is what the ring holds.
     */
    // `--nolod` — hold every agent at full animation rate.
    //
    // `AiSystem._updateRelevance` marks an actor irrelevant when the CAMERA
    // cannot see it, and `Agent._drive` then evaluates its pose one frame in
    // three. The pose drives `syncHitboxes`, the hitboxes are what line-of-sight
    // tests hit, and line of sight is what perception is. If that chain is real,
    // a camera-keyed optimisation is deciding which bot notices whom — and the
    // replay, whose camera is not restored, diverges in exactly the perception
    // fields. This flag is the control that says whether that story is true.
    if (NOLOD) {
      const ai = ctx.peek('ai');
      if (ai) {
        ai._updateRelevance = () => { for (const a of ai.agents) a.lodIrrelevant = false; };
        for (const a of ai.agents) { a.lodIrrelevant = false; a._animSkip = 0; }
      }
    }

    const round = ctx.peek('match')?.round;
    let warmed = 0;
    while (round && round.phase !== 'live' && warmed < 4000) { tick(1); warmed++; }
    if (round && round.phase !== 'live') {
      return { fatal: `never reached the live phase (stuck in "${round.phase}" after ${warmed} ticks)` };
    }

    /* ================================================================== *
     *  LAYER 0 — is this probe alive?                                    *
     * ================================================================== */

    const d0a = dumpAll();
    const d0b = dumpAll();
    const stable = diff(d0a.map, d0b.map);

    tick(1);
    const d0c = dumpAll();
    const sensitive = diff(d0a.map, d0c.map);

    /* ================================================================== *
     *  LAYER 3 — the stream registry                                     *
     * ================================================================== */

    const snapForks = typeof ctx.rng.snapshotForks === 'function' ? ctx.rng.snapshotForks() : null;

    /* ================================================================== *
     *  LAYERS 1 and 2 — need the snapshot API                            *
     * ================================================================== */

    /**
     * The classification a subsystem must publish:
     *
     *   static snapshotState     — keys that rewind with the world
     *   static excludedState — keys that do not
     *
     * Every own key must appear in exactly one. Not "should": the audit fails on
     * an unclassified key, on a key in both, and on a declared key that no
     * longer exists. The last one matters most over time — a list that keeps
     * naming a field somebody renamed is a list that has stopped describing the
     * object, and it goes stale silently.
     *
     * `captureState` is then checked to actually emit every `snapshotState` key,
     * which is what keeps the declaration from being a wish.
     */
    /**
     * The audit recurses, because the unit of classification is not the
     * subsystem.
     *
     * `player.rig` is one key and only HALF of it rewinds: the aim origin and
     * the recoil springs do, while bob, breath, shake, dip, step, punch and roll
     * are composed per rendered frame and must not. Classifying `rig` whole
     * would force a choice between capturing seven presentation springs and
     * dropping the recoil integrator — the handoff calls this out in §2 and a
     * flat list cannot say it.
     *
     * So any object that publishes its own pair of lists is audited as a node in
     * its own right, under a dotted path. Anything that does not is a leaf and
     * is captured or excluded whole.
     */
    const auditNode = (obj, path, seen, outNodes) => {
      const d = declOf(obj);
      const own = Object.keys(obj);
      const node = {
        path,
        declares: !!d,
        capture: typeof obj.captureState === 'function',
        restore: typeof obj.restoreState === 'function',
        ownKeys: own.length,
        unclassified: [],
        doubleClassified: [],
        stale: [],
        uncaptured: [],
      };
      outNodes.push(node);
      if (!d) return;

      for (const k of own) {
        const inS = d.snap.has(k), inX = d.exc.has(k);
        if (inS && inX) node.doubleClassified.push(k);
        else if (!inS && !inX) node.unclassified.push(k);
      }
      const ownSet = new Set(own);
      for (const k of [...d.snap, ...d.exc]) if (!ownSet.has(k)) node.stale.push(k);

      if (node.capture) {
        try {
          const emitted = new Set(Object.keys(obj.captureState({}) ?? {}));
          for (const k of d.snap) if (!emitted.has(k)) node.uncaptured.push(k);
        } catch (err) {
          node.captureThrew = String(err?.message ?? err);
        }
      }

      // Recurse into EVERY object-valued snapshot key, declared or not. Skipping
      // the undeclared ones would let an object with state hide behind a parent
      // that named it once — the same "captured wholesale" assumption that the
      // hand-written table made about `player.rig`, where it was wrong. An
      // undeclared child is reported, not failed: a plain `{x, y}` bag really is
      // a leaf its parent can copy, and layer 1 covers it either way.
      const descend = (v, p) => {
        if (v === null || typeof v !== 'object' || seen.has(v)) return;
        if (ArrayBuffer.isView(v) || v.isVector3 || v.isQuaternion) return;
        seen.add(v);
        // A container is not a node — its ELEMENTS are. Auditing `combatants`
        // itself reported "8 keys, undeclared", which is a true statement about
        // an array's indices and says nothing about the eight fighters in it.
        if (Array.isArray(v)) { v.forEach((el, i) => descend(el, `${p}[${i}]`)); return; }
        if (v instanceof Map) { for (const [k2, el] of v) descend(el, `${p}{${String(k2)}}`); return; }
        // A bag whose every value is a scalar is a leaf, not a node. `{x, y, z}`,
        // `round.scores`, `movement.stepEvent` — the parent declared the whole
        // field as snapshot and `captureState` has to emit it, so there is
        // nothing left for a classification of its own to decide. Auditing them
        // put 97 rows of `characters[n].position  3 keys · undeclared` in a
        // report whose job is to make the real gaps visible.
        if (!declOf(v) && Object.values(v).every((x) => x === null || typeof x !== 'object')) return;
        auditNode(v, p, seen, outNodes);
      };
      for (const k of d.snap) descend(obj[k], `${path}.${k}`);
    };

    const nodes = [];
    const hooks = SIM_IDS.map((id) => {
      const sys = ctx.peek(id);
      if (!sys) return { id, present: false };
      const before = nodes.length;
      auditNode(sys, id, new WeakSet([sys]), nodes);
      const root = nodes[before];
      return { id, present: true, ...root };
    });

    const missing = hooks.filter((h) => h.present && !(h.capture && h.restore)).map((h) => h.id);

    /* ================================================================== *
     *  LAYER 1 — the invariant                                           *
     * ================================================================== */

    let layer1 = null;
    if (!missing.length) {
      const capture = () => {
        const blob = {};
        for (const id of SIM_IDS) {
          const sys = ctx.peek(id);
          if (sys) blob[id] = sys.captureState(blob[id]);
        }
        return blob;
      };
      const restore = (blob) => {
        for (const id of SIM_IDS) ctx.peek(id)?.restoreState(blob[id]);
      };

      // We are standing at K+1 after layer 0 stepped one tick; go back to K's
      // neighbourhood by simply treating here as the snapshot point.
      const kTick = ctx.time.tick;
      const snap = capture();
      const atK = dumpAll();

      // THE CLOCK IS PART OF THE REWIND, and leaving it out is a harness defect
      // that looks exactly like a snapshot defect.
      //
      // `engine.step` derives dt as `(now - _last) / 1000`, so the same nominal
      // 1/120 s produces a slightly different double depending on how large the
      // two timestamps are. The replay runs later than the original pass, so its
      // dt sequence rounds differently — 50 ULP on `round.remaining` after 119
      // ticks, which moved a round transition, which changed when a respawn drew
      // from `ai.rng`, which diverged every stream downstream of it. Twenty-three
      // leaves, one cause, none of them the snapshot's fault.
      const clockK = clock;
      const engineK = { last: e._last, accum: e._accum };
      const timeK = {
        elapsed: ctx.time.elapsed, raw: ctx.time.raw,
        alpha: ctx.time.alpha, dt: ctx.time.dt, frame: ctx.time.frame,
      };

      // Count draws per stream, both passes.
      //
      // An rng leaf that differs says the stream advanced a different number of
      // times and nothing else. The count says WHICH stream and BY HOW MANY,
      // which is the difference between "the snapshot is wrong somewhere" and
      // "agent#4 drew three times too few". Wrapping `u32` is enough: `float`,
      // `range`, `int`, `signed`, `pick` and `disc` all go through it.
      const streams = [ctx.rng, ...ctx.rng.snapshotForks()];
      const counts = new Map();
      for (const r of streams) {
        const orig = r.u32.bind(r);
        r.u32 = function () { counts.set(this, (counts.get(this) ?? 0) + 1); return orig(); };
      }
      const readCounts = () => {
        const m = new Map();
        for (const r of streams) m.set(r, counts.get(r) ?? 0);
        return m;
      };
      const zero = () => { for (const r of streams) counts.set(r, 0); };
      // Name them the way the dump does, so a count lines up with a failing leaf.
      const streamName = new Map();
      streamName.set(ctx.rng, 'root');
      for (const id of SIM_IDS) {
        const sys = ctx.peek(id);
        if (sys?.rng) streamName.set(sys.rng, `${id}.rng`);
      }
      for (const a of ctx.peek('ai')?.agents ?? []) if (a.rng) streamName.set(a.rng, `agent#${a.id}.rng`);
      (ctx.peek('ai')?.squads ?? []).forEach((s, i) => { if (s.rng) streamName.set(s.rng, `squad#${i}.rng`); });

      // A fixed span, not a fixed N: `live` starts wherever the tempo puts it.
      const span = SPAN;
      zero();
      // Drive the player for the whole span. A stationary player with a cold
      // trigger is a scenario in which most of the snapshot cannot be wrong.
      const BTN = e.commands.BTN ?? { fire: 1 };
      e.commands.override = { moveX: 0, moveY: 0, held: 0, edge: 0 };
      const driveAt = (i) => {
        const o = e.commands.override;
        o.moveX = Math.sin(i * 0.11);
        o.moveY = Math.cos(i * 0.07);
        // Hold the trigger in bursts so the spread cone winds up and decays, and
        // so `weapons.rng` is actually consumed.
        o.held = (i % 40) < 22 ? BTN.fire : 0;
        o.edge = (i % 40) === 0 ? BTN.fire : 0;
      };
      for (let i = 0; i < span; i++) { driveAt(i); tick(1); }
      e.commands.override = null;
      const drawsA = readCounts();
      const expected = dumpAll();
      const nTick = ctx.time.tick;
      const N_ = nTick;

      // Two separate questions, and conflating them cost a diagnosis.
      //
      //   moved   — did the span change anything? If K and N are the same world
      //             the replay is a no-op and would pass while proving nothing.
      //   exact   — does restoring K reproduce K? This is where an incomplete
      //             capture shows up FIRST, in the field that failed to come
      //             back, instead of 119 ticks later as whatever that field
      //             happened to steer.
      //
      // The first version only counted `moved` and called it "restore moved N
      // leaves back", which is not what that number means.
      const moved = diff(atK.map, expected.map);

      // `--drop=weapons._spread` — make one field NOT rewind, by writing its
      // value at N over the captured one. That is exactly what a snapshot which
      // forgot the field would do, and it is the induced failure §4.3 of the
      // handoff asks for before any of this is believed.
      let dropped = null;
      if (DROP) {
        const dot = DROP.indexOf('.');
        const sysId = DROP.slice(0, dot), key = DROP.slice(dot + 1);
        const sys = ctx.peek(sysId);
        if (!sys) dropped = `no subsystem "${sysId}"`;
        else if (!(key in sys)) dropped = `"${sysId}" has no field "${key}"`;
        else {
          const live = sys.captureState({});
          if (!(key in live)) dropped = `"${sysId}.captureState" does not emit "${key}"`;
          else { snap[sysId][key] = live[key]; dropped = `ok: ${DROP} restored to its value at N`; }
        }
      }

      restore(snap);
      const afterRestore = dumpAll();
      const restoreExact = diff(atK.map, afterRestore.map, 12);

      ctx.time.tick = kTick;
      clock = clockK;
      e._last = engineK.last;
      e._accum = engineK.accum;
      ctx.time.elapsed = timeK.elapsed;
      ctx.time.raw = timeK.raw;
      ctx.time.alpha = timeK.alpha;
      ctx.time.dt = timeK.dt;
      ctx.time.frame = timeK.frame;
      // `--tamper` — change one recorded command. The replay then feeds input
      // the original pass never saw, and a comparison that still passes is a
      // comparison that is not looking at the simulation.
      let tampered = null;
      if (TAMPER) {
        const mid = kTick + Math.floor(span / 2);
        const c = e.commands.get(mid);
        if (!c) tampered = `command ${mid} is no longer in the ring`;
        else { c.moveX = c.moveX + 1; tampered = `ok: command ${mid} moveX +1`; }
      }

      let replayError = null;
      zero();
      try {
        e.commands.beginReplay(nTick);
        for (let i = 0; i < span; i++) {
          clock += H;
          e.step(clock);
        }
      } catch (err) {
        replayError = String(err?.message ?? err);
      } finally {
        e.commands.endReplay();
      }

      const drawsB = readCounts();
      const actual = dumpAll();
      const drift = diff(expected.map, actual.map, ROWS);

      const drawGap = [];
      for (const r of streams) {
        const a = drawsA.get(r) ?? 0, b = drawsB.get(r) ?? 0;
        if (a !== b) drawGap.push({ name: streamName.get(r) ?? '<unnamed>', a, b });
      }

      layer1 = {
        drawGap, dropped, tampered,
        kTick, nTick, span,
        replayError,
        landedAt: ctx.time.tick,
        moved: { count: moved.count, numeric: moved.numeric },
        restoreExact: { count: restoreExact.count, numeric: restoreExact.numeric, rows: restoreExact.rows },
        drift: { count: drift.count, numeric: drift.numeric, rows: drift.rows },
        leaves: expected.map.size,
      };
    }

    return {
      tickAt: ctx.time.tick,
      leaves: d0a.map.size,
      entities: d0a.entities,
      stats: d0a.stats,
      stable,
      sensitive,
      nodes,
      layer1,
      snapForks: snapForks === null ? null : snapForks.length,
      hooks,
      missing,
    };
  },
  {
    K, SPAN,
    ROWS: Number(args.rows ?? 16),
    NOLOD: !!args.nolod,
    MAXDEPTH: Number(args.maxdepth ?? 12),
    NODUMP: !!args.nodump,
    DROP: typeof args.drop === 'string' ? args.drop : null,
    TAMPER: !!args.tamper,
  }
);

await browser.close();
if (vite && !args.keep) try { process.kill(-vite.pid); } catch { /* already gone */ }

/* ====================================================================== */
/*  Report                                                                */
/* ====================================================================== */

if (out.fatal) {
  console.log(`\nREPLAY FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}
if (errors.length) {
  console.log(`\nREPLAY FAILED — page errors:\n  - ${errors.slice(0, 5).join('\n  - ')}`);
  process.exit(1);
}

const fail = [];

console.log(`\nREPLAY — ${SPAN} ticks replayed from the live phase (ring holds 128)`);
console.log(`\n  layer 0 — is the dump worth trusting?`);
console.log(`    ${out.leaves} scalar leaves across ${out.hooks.filter((h) => h.present).length} subsystem roots + ${out.entities} entity roots`);
console.log(`    ${out.stats.pruned} presentation objects pruned, ${out.stats.depthCut} branches hit the depth cap`);

if (out.leaves === 0) {
  fail.push('the dump is empty — every root pruned, so layers 1 and 2 would pass on nothing');
}
if (out.stats.depthCut !== 0) {
  // A depth cut is state the dump silently declined to look at, which is the
  // exact shape of the omission this gate exists to catch. It is a failure and
  // not a warning: "exhaustive except for 4413 branches" is not exhaustive.
  fail.push(`${out.stats.depthCut} branches hit the depth cap — the dump is not exhaustive, so a missing field could hide behind one`);
  const shapes = new Map();
  for (const p of out.stats.deepPaths) {
    const shape = p.replace(/\[\d+\]/g, '[]').replace(/\{[^}]*\}/g, '{}');
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`      x${n}  ${shape}`);
  }
}
if (out.stable.count !== 0) {
  fail.push(`0a: the same tick dumped twice differs in ${out.stable.count} places — the dump reads something that is not state`);
  for (const r of out.stable.rows) console.log(`      ${r.path}  ${r.a} -> ${r.b}`);
} else {
  console.log(`    0a  same tick, dumped twice: identical`);
}
if (out.sensitive.numeric === 0) {
  fail.push(`0b: one tick moved ${out.sensitive.count} leaves but not one NUMBER — positions, timers and rng words are numbers, so the dump is blind to the simulation and 0a proved nothing`);
} else {
  console.log(`    0b  one tick apart: ${out.sensitive.count} leaves moved (${out.sensitive.numeric} numeric)`);
  for (const r of out.sensitive.rows.slice(0, 4)) console.log(`      ${r.path}  ${r.a} -> ${r.b}`);
}

console.log(`\n  layer 3 — streams registered as snapshot targets`);
if (out.snapForks === null) {
  fail.push('ctx.rng.snapshotForks() is missing — the fork registry is not wired');
} else {
  console.log(`    ${out.snapForks} registered via fork({ snapshot: true })`);
  if (out.snapForks === 0) fail.push('no stream registered as a snapshot target, which cannot be right');
}

console.log(`\n  layer 2 — is every own key classified? (${out.nodes.length} nodes)`);
for (const n of out.nodes) {
  if (!n.declares) {
    console.log(`    ${n.path.padEnd(22)} ${String(n.ownKeys).padStart(3)} keys · NO snapshotState/excludedState`);
    continue;
  }
  const bad = n.unclassified.length + n.doubleClassified.length + n.stale.length + n.uncaptured.length;
  console.log(`    ${n.path.padEnd(22)} ${String(n.ownKeys).padStart(3)} keys · ${bad === 0 ? 'all classified' : `${bad} problem(s)`}`);
  const show = (label, arr) => {
    if (!arr.length) return;
    console.log(`      ${label}: ${arr.slice(0, 14).join(', ')}${arr.length > 14 ? ` (+${arr.length - 14})` : ''}`);
  };
  show('unclassified', n.unclassified);
  show('in BOTH lists', n.doubleClassified);
  show('declared but absent', n.stale);
  show('declared snapshot, not emitted', n.uncaptured);
  if (n.captureThrew) console.log(`      captureState threw: ${n.captureThrew}`);

  if (n.unclassified.length) fail.push(`${n.path}: ${n.unclassified.length} key(s) classified as neither`);
  if (n.doubleClassified.length) fail.push(`${n.path}: ${n.doubleClassified.length} key(s) in both lists`);
  if (n.stale.length) fail.push(`${n.path}: ${n.stale.length} declared key(s) no longer exist — the list has stopped describing the object`);
  if (n.uncaptured.length) fail.push(`${n.path}: ${n.uncaptured.length} key(s) declared snapshot but captureState does not emit them`);
  if (n.captureThrew) fail.push(`${n.path}: captureState threw`);
}
if (out.missing.length) {
  fail.push(`no captureState/restoreState on: ${out.missing.join(', ')} — layers 1 and 2 cannot run`);
}

console.log(`\n  layer 1 — capture K, run to N, restore K, replay the same commands`);
const L1 = out.layer1;
if (!L1) {
  fail.push('layer 1 did not run because the snapshot hooks are incomplete — see layer 2');
} else {
  console.log(`    K=${L1.kTick} -> N=${L1.nTick} (${L1.span} ticks), ${L1.leaves} leaves compared`);
  if (L1.dropped) console.log(`    --drop: ${L1.dropped}`);
  if (L1.tampered) console.log(`    --tamper: ${L1.tampered}`);
  if (L1.replayError) {
    fail.push(`layer 1: the replay threw — ${L1.replayError}`);
  }
  if (L1.landedAt !== L1.nTick) {
    fail.push(`layer 1: replay landed on tick ${L1.landedAt}, not ${L1.nTick} — it did not simulate the same span`);
  }
  // Did the span do anything? A replay between two identical worlds is green
  // and worthless — the shape this repo keeps finding, one gate at a time.
  if (L1.moved.count === 0) {
    fail.push('layer 1: K and N are the same world, so the replay proves nothing');
  } else {
    console.log(`    the span moved ${L1.moved.count} leaves (${L1.moved.numeric} numeric)`);
  }
  // Does restoring K reproduce K? This localises an incomplete capture to the
  // field that failed to come back, rather than to whatever it steered 119
  // ticks later.
  if (L1.restoreExact.count === 0) {
    console.log(`    restore reproduced K exactly`);
  } else {
    console.log(`    restore did NOT reproduce K — ${L1.restoreExact.count} leaves wrong (${L1.restoreExact.numeric} numeric)`);
    for (const r of L1.restoreExact.rows) console.log(`      ${r.path}\n        at K  ${r.a}\n        after ${r.b}`);
    fail.push(`layer 1: restoring the snapshot did not reproduce tick K in ${L1.restoreExact.count} places — the capture is incomplete`);
  }
  if (L1.drawGap?.length) {
    console.log(`    rng draws that differ between the two passes:`);
    for (const g of L1.drawGap.slice(0, 10)) {
      console.log(`      ${g.name.padEnd(18)} original ${g.a}  replay ${g.b}  (${g.b - g.a >= 0 ? '+' : ''}${g.b - g.a})`);
    }
  } else if (L1.drift.count) {
    console.log(`    every rng stream drew the same number of times — the divergence is not a draw count`);
  }
  if (L1.drift.count === 0) {
    console.log(`    replayed to N: BIT-IDENTICAL`);
  } else {
    console.log(`    replayed to N: ${L1.drift.count} leaves differ (${L1.drift.numeric} numeric)`);
    for (const r of L1.drift.rows) console.log(ROWS > 40 ? `      ${r.path}` : `      ${r.path}\n        expected ${r.a}\n        got      ${r.b}`);
    fail.push(`layer 1: ${L1.drift.count} leaves diverged after the replay — the snapshot is incomplete or a restore is wrong`);
  }
}

if (fail.length) {
  console.log(`\nREPLAY FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

console.log(`\nREPLAY OK`);
