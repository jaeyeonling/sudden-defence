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
 *   node tools/replay.mjs [--port=5173] [--k=60] [--n=180]
 *                         [--maxdepth=12] [--nodump] [--keep]
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
 * Tick to compare at. N-K must stay under CMD_HISTORY (128) — past that the
 * ring has rolled over the commands the replay needs and the failure would be
 * the harness running out of history, not the game diverging.
 */
const N = Number(args.n ?? 180);

if (N - K >= 128) {
  console.log(`REPLAY FAILED — harness: N-K is ${N - K}, the command ring holds 128`);
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
  async ({ K, N, MAXDEPTH, NODUMP }) => {
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
        for (const k of Object.keys(v)) {
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
    const declOf = (o) => {
      const C = o?.constructor;
      const s = Array.isArray(C?.snapshotState) ? C.snapshotState : null;
      const x = Array.isArray(C?.excludedState) ? C.excludedState : null;
      return s && x ? { snap: new Set(s), exc: new Set(x) } : null;
    };

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

    return {
      tickAt: ctx.time.tick,
      leaves: d0a.map.size,
      entities: d0a.entities,
      stats: d0a.stats,
      stable,
      sensitive,
      nodes,
      snapForks: snapForks === null ? null : snapForks.length,
      hooks,
      missing,
    };
  },
  { K, N, MAXDEPTH: Number(args.maxdepth ?? 12), NODUMP: !!args.nodump }
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

console.log(`\nREPLAY — snapshot K=${K}, compare N=${N} (${N - K} ticks of history, ring holds 128)`);
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
console.log(`    NOT IMPLEMENTED — needs the replay loop over commands.get(seq)`);
fail.push(
  'layer 1 has never run: the invariant this gate is named for — restore K, replay, arrive ' +
  'bit-identical at N — is still unproven. Layers 0, 2 and 3 passing means the dump works, ' +
  'every field is classified and every stream is registered; it does not mean a rewind is correct.'
);

if (fail.length) {
  console.log(`\nREPLAY FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

console.log(`\nREPLAY OK`);
