#!/usr/bin/env node
/**
 * CROSSENGINE — do two different JavaScript engines simulate the same world?
 *
 * THIS IS THE QUESTION THAT PICKS THE NETCODE.
 *
 * Netcode step 5 proved the simulation is reproducible INSIDE one page: snapshot
 * a tick, replay the same commands, arrive at bit-identical state. That buys
 * rollback and lag compensation on one machine. It says nothing about two.
 *
 * If two engines agree, a deterministic architecture is available: peers
 * exchange COMMANDS, each re-simulates, and the wire carries a few bytes per
 * tick. If they disagree, that design is dead on arrival — not "slightly off",
 * dead, because divergence compounds and there is no reconciliation step in a
 * lockstep model. The fallback is server-authoritative state replication, where
 * the server broadcasts truth and clients never need to reproduce it.
 *
 * The choice is not a preference. It is this measurement.
 *
 * WHY ENGINES ARE A PROXY FOR MACHINES
 *
 * IEEE 754 pins +, -, *, / and sqrt to a correctly-rounded result, so those are
 * identical everywhere. It does NOT pin the transcendentals. `Math.sin`,
 * `cos`, `atan2`, `exp`, `pow`, `acos` — and `hypot`, which surprises people
 * because it sits next to `sqrt` in the docs — are all "implementation-
 * approximated" in the spec: an engine may return any value within its own
 * tolerance. V8, SpiderMonkey and JavaScriptCore use different implementations,
 * so where they differ is where two machines running different browsers would
 * differ, and it is a strict superset of where two machines running the SAME
 * browser would.
 *
 * This audit is why the gate exists (counts of call sites under `src/`):
 *
 *     physics   hypot 45 · sin 4 · cos 5 · exp 2 · acos 2
 *     ai        sin 51 · cos 28 · hypot 18 · exp 18 · atan2 5 · acos 3
 *     player    sin 14 · hypot 12 · cos 10 · pow 3
 *     weapons   sin 20 · cos 10 · atan2 1
 *
 * Those are not decorations. `physics`'s 45 `hypot` calls are distances, which
 * decide what a capsule sweep hits.
 *
 * HOW THE COMPARISON IS MADE FAIR
 *
 * Two questions, kept apart, because conflating them would blame the wrong half:
 *
 *   BOOT   dump the world before any driven tick. If engines disagree HERE, the
 *          divergence is in construction — level bake, nav grid, mesh-derived
 *          collision — and nothing about the step loop is implicated yet.
 *   STEP   drive N fixed steps with an identical constant command and dump
 *          again. A disagreement that appears only here is the simulation's.
 *
 * The clock is handed in, exactly one fixed step per `step()` call, so neither
 * engine gets a different number of ticks — the failure `aim.mjs` and
 * `perceive.mjs` both had to fix before their comparisons meant anything.
 *
 * The dump is `captureState` across the six simulation subsystems: the same
 * definition of "state that rewinds" that `replay.mjs` gates, so this cannot
 * drift away from that one. Numbers are compared as bit patterns, not as
 * numbers — a tolerance here would hide exactly the last-bit disagreement the
 * gate exists to find.
 *
 * WHAT A RED HERE MEANS
 *
 * Not that the game is broken. It means one architecture is unavailable, and it
 * should be read as a design input rather than a defect to fix. Chasing bit
 * equality across engines means replacing every transcendental with a fixed
 * implementation, which is a large, permanent tax on a codebase that generates
 * all of its geometry procedurally.
 *
 * WHAT IT ACTUALLY SAYS TODAY: NOT YET
 *
 *     chromium vs chromium#control   25/1777 leaves differ after 240 ticks
 *     chromium vs firefox           190/1777
 *
 * The control is two processes of the SAME engine, injected with the same state
 * and fed the same commands. It should be 0 and it is 25, so the cross-engine
 * number is noise plus signal and this tool separates neither. 190 against 25 is
 * suggestive and that is all it is.
 *
 * The control's noise has a known address: state the snapshot does not carry.
 * `tools/perceive.mjs` established that bot rigs are posed in `ai.lateUpdate`,
 * on the frame, and that `MASK.BULLET` contains ACTOR — so which bone a round
 * lands on is a function of animation the snapshot never captured. Two processes
 * reach the injection point having animated differently.
 *
 * SO THE ORDER OF WORK IS FIXED, and it was not obvious before this ran: the
 * hitbox path is not merely the next cleanup, it is the PRECONDITION for
 * measuring cross-machine determinism at all. Until the control is clean, the
 * netcode architecture cannot be chosen on evidence.
 *
 * Two findings survive the inconclusive verdict, because neither depends on the
 * control being clean:
 *
 *   BOOT IS NOT REPRODUCIBLE ACROSS ENGINES. ~150 leaves differ before a single
 *   driven tick, including bot spawn positions by 1.6 m. `__READY__` waits on
 *   three rAF frames and engines deliver them at different wall-clock times, so
 *   the free-running boot consumes `ai.rng` a different number of times.
 *
 *   THE LEVEL BAKE IS ENGINE-DEPENDENT. `ai.cover.points` has a different LENGTH
 *   on the two engines (364 vs 360) — not different values, a different number
 *   of cover points extracted from the same level. `restoreState` writes values
 *   but does not resize, so injection cannot hide it (`--ignore=ai.cover` sets
 *   it aside to ask the step-loop question separately). A deterministic netcode
 *   would need the bake shipped rather than recomputed per client.
 *
 *   node tools/crossengine.mjs [--ticks=240] [--engines=chromium,firefox]
 *                              [--rows=12] [--port=5173] [--ignore=a.b,c.d]
 */
import { chromium, firefox, webkit } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
const TICKS = Number(args.ticks ?? 240);
const ROWS = Number(args.rows ?? 12);
const LAUNCHERS = { chromium, firefox, webkit };
const ENGINES = String(args.engines ?? 'chromium,firefox')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const e of ENGINES) {
  if (!LAUNCHERS[e]) {
    console.log(`\nCROSSENGINE FAILED — harness: unknown engine "${e}"`);
    process.exit(1);
  }
}
if (ENGINES.length < 2) {
  console.log(`\nCROSSENGINE FAILED — harness: need at least two engines to compare`);
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

/**
 * Runs inside the page.
 *
 * `INJECT` is the reference engine's `captureState` blob. The second engine
 * RESTORES it before the driven span, which is what makes the comparison about
 * the step loop instead of about the boot.
 *
 * Booting is not reproducible across engines and this gate proved it the hard
 * way: without injection, `physics.characters[n].position` differed by 1.6 m at
 * tick 0 — not a last-bit disagreement but a different draw from `ai.rng`,
 * because `__READY__` waits on THREE rAF FRAMES and two engines take different
 * wall-clock times to deliver them. That is the harness, not the mathematics.
 * (`lockstep=1` fixes the boot, but it implies `capture=1`, which suppresses
 * `populate()` and leaves an empty arena.)
 */
const PROBE = async ({ TICKS, INJECT }) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const SIM_IDS = ['physics', 'match', 'world', 'weapons', 'player', 'ai'];

  if (ctx.time.scale !== 1) return { fatal: `time.scale is ${ctx.time.scale}` };
  for (const id of SIM_IDS) {
    const s = ctx.peek(id);
    if (!s?.captureState) return { fatal: `"${id}" has no captureState` };
  }

  // Bit pattern, not the number. Two engines that print the same 17 digits can
  // still hold different doubles, and the whole point here is the last bit.
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (n) => {
    buf.setFloat64(0, n);
    return `${buf.getUint32(0).toString(16)}.${buf.getUint32(4).toString(16)}`;
  };

  /** Flatten `captureState` output to path -> comparable string. */
  const flatten = (v, path, out, seen) => {
    if (v === null || v === undefined) { out.set(path, String(v)); return; }
    const t = typeof v;
    if (t === 'number') { out.set(path, Number.isFinite(v) ? `n:${bits(v)}` : `n:${v}`); return; }
    if (t === 'boolean' || t === 'string') { out.set(path, `${t[0]}:${v}`); return; }
    if (t !== 'object') { out.set(path, `?:${t}`); return; }
    if (seen.has(v)) { out.set(path, '<cycle>'); return; }
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      for (let i = 0; i < v.length; i++) flatten(v[i], `${path}[${i}]`, out, seen);
      return;
    }
    if (Array.isArray(v)) {
      out.set(`${path}.length`, `n:${v.length}`);
      for (let i = 0; i < v.length; i++) flatten(v[i], `${path}[${i}]`, out, seen);
      return;
    }
    for (const k of Object.keys(v)) flatten(v[k], `${path}.${k}`, out, seen);
  };

  const dump = () => {
    const out = new Map();
    const seen = new WeakSet();
    for (const id of SIM_IDS) flatten(ctx.peek(id).captureState({}), id, out, seen);
    return [...out.entries()];
  };

  e.stop();
  let clock = performance.now();
  e._last = clock;
  e._accum = 0;
  const H = 1000 / 120;
  const tick1 = () => { clock += H; e.step(clock); };

  // BOOT — before anything is driven. Reported for the record; not the verdict.
  const startTick = ctx.time.tick;
  const boot = dump();

  const round = ctx.peek('match')?.round;
  let warmed = 0;
  while (round && round.phase !== 'live' && warmed < 4000) { tick1(); warmed++; }
  if (round && round.phase !== 'live') return { fatal: `never reached live (${round.phase})` };

  const capture = () => {
    const b = {};
    for (const id of SIM_IDS) b[id] = ctx.peek(id).captureState({});
    return b;
  };

  // Hand the second engine the first one's world.
  if (INJECT) {
    for (const id of SIM_IDS) ctx.peek(id).restoreState(INJECT[id]);
    // Debris is not in the snapshot and IS in `MASK.SIGHT` (see perceive.mjs),
    // so it would arrive at the span differently on each engine.
    ctx.peek('physics')?.bodies?.clear?.();
  }
  const snapshot = INJECT ? null : capture();
  // The state both engines actually start the span from. If these differ, the
  // injection did not take and nothing downstream is worth reading.
  const start = dump();

  const BTN = e.commands.BTN ?? { fire: 1 };
  // Constant, so every tick in both engines receives identical input. A command
  // that varied with the frame index would make this measure the harness.
  e.commands.override = { moveX: 0, moveY: 1, held: BTN.fire, edge: 0 };
  for (let i = 0; i < TICKS; i++) tick1();
  e.commands.override = null;

  return {
    startTick, warmed,
    liveTick: ctx.time.tick,
    boot, start, snapshot,
    stepped: dump(),
    ua: navigator.userAgent,
  };
};

// The reference engine runs TWICE. The second run is the CONTROL: same engine,
// same injected state, different process. It must land on the same numbers, and
// if it does not then nothing this tool says about a DIFFERENT engine is
// attributable to the engine. Discipline 1 of the handoff, in the direction
// people forget: a difference is only a finding once the control shows none.
const PLAN = [ENGINES[0], `${ENGINES[0]}#control`, ...ENGINES.slice(1)];

const results = [];
let inject = null;
for (const label of PLAN) {
  const name = label.replace('#control', '');
  const browser = await LAUNCHERS[name].launch({
    args: name === 'chromium'
      ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
      : [],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let out;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
    out = await page.evaluate(PROBE, { TICKS, INJECT: inject });
    if (!out?.fatal && out?.snapshot) inject = out.snapshot;
  } catch (err) {
    out = { fatal: `${name}: ${String(err?.message ?? err).split('\n')[0]}` };
  }
  await browser.close();
  results.push({ name: label, engine: name, out, errors });
}

if (vite && !args.keep) try { process.kill(-vite.pid); } catch { /* already gone */ }

/* ====================================================================== */
/*  Report                                                                */
/* ====================================================================== */

console.log(`\nCROSSENGINE — ${TICKS} fixed steps, same constant command, ${ENGINES.join(' vs ')}`);

const fail = [];
for (const r of results) {
  if (r.out?.fatal) fail.push(`${r.name}: ${r.out.fatal}`);
  if (r.errors?.length) fail.push(`${r.name} page error: ${r.errors[0]}`);
}
if (fail.length) {
  console.log(`\nCROSSENGINE FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

const base = results[0];
console.log(`  reference: ${base.name}, ${base.out.boot.length} leaves captured`);
for (const r of results) {
  console.log(`    ${r.name.padEnd(9)} live at tick ${r.out.liveTick} (warmed ${r.out.warmed})`);
}

/**
 * `--ignore=ai.cover` — drop a subtree from every comparison.
 *
 * Earns its place immediately: `ai.cover.points` is a different LENGTH on the
 * two engines (364 vs 360), because the cover map is baked from the level and
 * the bake is itself engine-dependent. `restoreState` writes the values it is
 * given but does not resize the array, so injection cannot paper over it.
 *
 * That is a finding, not an obstacle to route around — but it is a finding
 * about CONSTRUCTION, and it would otherwise mask the separate question of
 * whether the STEP LOOP agrees once both engines hold the same state. A shared
 * bake shipped from a server is a plausible design; a step loop that cannot
 * agree is not.
 */
const IGNORE = String(args.ignore ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ignored = (k) => IGNORE.some((p) => k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`));

const diff = (a, b) => {
  const ma = new Map(a.filter(([k]) => !ignored(k)));
  const mb = new Map(b.filter(([k]) => !ignored(k)));
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const rows = [];
  let n = 0;
  for (const k of keys) {
    const va = ma.get(k), vb = mb.get(k);
    if (va === vb) continue;
    n++;
    if (rows.length < ROWS) rows.push({ path: k, a: va ?? '<absent>', b: vb ?? '<absent>' });
  }
  return { count: n, rows, total: keys.size };
};

let verdict = 'IDENTICAL';
let controlNoise = null;
for (const r of results) {
  if (r === base) continue;

  // Three questions kept apart, because conflating any two would send the next
  // session to the wrong file.
  //
  //   boot    construction, before injection. Expected to differ — booting is
  //           not reproducible across engines (see PROBE). Reported only.
  //   start   after injection. This is the VALIDITY GUARD: if the two engines
  //           do not begin the span from the same state, nothing below means
  //           anything, and a green would be the loudest possible false pass.
  //   stepped the answer. Same state in, same commands, same tick count.
  const b = diff(base.out.boot, r.out.boot);
  const st = diff(base.out.start, r.out.start);
  const s = diff(base.out.stepped, r.out.stepped);

  console.log(`\n  ${base.name} vs ${r.name}`);
  console.log(`    boot (pre-inject)  ${b.count === 0 ? 'identical' : `${b.count}/${b.total} differ — expected, not the verdict`}`);
  console.log(`    start (injected)   ${st.count === 0 ? 'identical' : `${st.count}/${st.total} DIFFER`}`);
  console.log(`    stepped            ${s.count === 0 ? 'identical' : `${s.count}/${s.total} leaves differ`}`);

  if (st.count) {
    for (const row of st.rows) {
      console.log(`      start ${row.path}\n        ${base.name.padEnd(9)} ${row.a}\n        ${r.name.padEnd(9)} ${row.b}`);
    }
    fail.push(`the injected state did not take on ${r.name} (${st.count} leaves) — the span did not start from the same world, so its result is meaningless`);
    verdict = 'INCONCLUSIVE';
    continue;
  }

  for (const row of s.rows) {
    console.log(`      stepped ${row.path}\n        ${base.name.padEnd(16)} ${row.a}\n        ${r.name.padEnd(16)} ${row.b}`);
  }

  if (r.name.endsWith('#control')) {
    controlNoise = s.count;
    if (s.count) {
      console.log(`\n    THE CONTROL IS NOT CLEAN. Two processes of the SAME engine, handed the`);
      console.log(`    same state and the same commands, land on ${s.count} different leaves. Whatever`);
      console.log(`    another engine does cannot be attributed to the engine until this is 0.`);
    }
    continue;
  }
  if (s.count) verdict = 'DIVERGES';
}

if (fail.length) {
  console.log(`\nCROSSENGINE INCONCLUSIVE:\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}

if (controlNoise) {
  console.log(`\n  INCONCLUSIVE. The control diverges by ${controlNoise} leaves on its own, so the`);
  console.log(`  cross-engine number is an upper bound on noise + signal and separates neither.`);
  console.log(`  Fix that first: state the snapshot does not carry (animator pose, and the`);
  console.log(`  hitboxes posed from it — see tools/perceive.mjs) is steering the simulation.`);
  verdict = 'INCONCLUSIVE';
} else {
  console.log(`\n  ${verdict === 'IDENTICAL'
    ? 'Engines agree bit for bit. A command-only (deterministic) netcode is on the table.'
    : 'Engines disagree. Lockstep/rollback across heterogeneous clients is NOT available;\n  a server-authoritative model that replicates STATE is the remaining option.'}`);
}

// Deliberately exit 0 either way. This is a design measurement, not a defect
// gate: a red would mean "pick the other architecture", and wiring that into
// `npm test` would make every future run fail for a fact nobody intends to
// change. See the header.
console.log(`\nCROSSENGINE ${verdict} (reported, not gated)`);
