#!/usr/bin/env node
/**
 * Reachability proof for the level — M2's completion criterion.
 *
 * Floods the standable floor with a BFS and asserts that every spawn point of
 * every team lands in the SAME connected component. If alpha cannot walk to
 * bravo the map is not a map, and no amount of it looking right in a screenshot
 * changes that.
 *
 * WHY A FLOOD FILL AND NOT A WALK TEST
 * Driving the character controller from A to B needs a pathfinder, and the
 * pathfinder (`ai/nav.js`) is not ported yet — so a walk test would be testing
 * the thing that does not exist. The flood fill asks physics directly and has
 * no such dependency.
 *
 * WHAT IT APPROXIMATES
 * A cell is standable when there is floor under it at walkable height and a
 * player-radius probe at chest height is clear on all four sides. An edge
 * between neighbours exists when knee-height AND chest-height rays both pass.
 * That is a capsule approximation, not a capsule: a gap narrower than the grid
 * step could read as passable. Door openings here are 3.2 m against a 0.4 m
 * step, so the margin is eight cells wide and the approximation is not load
 * bearing. Tighten STEP if the map ever gets tight geometry.
 *
 *   node tools/reach.mjs
 *   node tools/reach.mjs --dump      # ASCII map of the flood
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  // `OW_NO_HMR=1`: the server this harness owns must not hot-reload.
  //
  // `vite.config.js` has carried the guard and the explanation since the capture
  // harness needed it — a file saved while a run is in flight reloads the page
  // and playwright fails the in-flight `page.evaluate` with "Execution context
  // was destroyed" — and `tools/capture.mjs` was the only tool that set it. Every
  // tool here spawns the same server for the same reason, and in `npm test` the
  // one that wins the race owns it for the whole chain, so the guard has to be on
  // all of them or it is on none of the ones that matter. Cost when nothing is
  // being edited: nothing.
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
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

const out = await page.evaluate(() => {
  const STEP = 0.4;
  /** Player capsule radius, from PlayerSystem's character controller. */
  const RADIUS = 0.4;
  /** Floor must be within this of y=0 relative to the sampled column. */
  const MAX_STEP_UP = 0.55;
  const KNEE = 0.45;
  const CHEST = 1.35;

  const e = window.__ENGINE__;
  const ph = e.ctx.get('physics');
  const world = e.ctx.get('world');
  const MASK = ph.MASK.WORLD;

  const b = world.bounds;
  const x0 = b.min.x + STEP;
  const z0 = b.min.z + STEP;
  const nx = Math.floor((b.max.x - b.min.x - STEP * 2) / STEP);
  const nz = Math.floor((b.max.z - b.min.z - STEP * 2) / STEP);

  const cx = (i) => x0 + i * STEP;
  const cz = (k) => z0 + k * STEP;
  const idx = (i, k) => k * nx + i;

  const ray = (ox, oy, oz, dx, dy, dz, len) => ph.raycast(ox, oy, oz, dx, dy, dz, len, MASK);

  // ---- pass 1: standability -------------------------------------------
  //
  // Drop a probe from just under the ceiling and walk it down the column until
  // it reaches something you could actually step onto.
  //
  // The descent has to tell two situations apart, and `frontFace` is what
  // separates them:
  //
  //   LANDED ON something (front face, i.e. a top surface) that is too high to
  //   step onto — a container roof at 2.6 m, a shelf deck at 1.15 m. The cell
  //   is blocked. Stop.
  //
  //   EXITED something (back face) because the probe began inside it — a door
  //   lintel spans 2.7 to 6 m, so a probe at 5.85 m starts within it and leaves
  //   through its underside. That is an overhang, not an obstacle: duck below
  //   and keep looking for the floor. Without this every doorway reads as
  //   solid and the lanes appear cut off from the hall.
  //
  // Two earlier versions got this wrong. Starting the probe at y=2.0 put it
  // inside the 2.6 m containers, which then reported walkable floor — four
  // phantom rooms. Filtering those by `frontFace` at the y=0 hit failed for a
  // subtler reason: a container's bottom face is coplanar with the floor's top
  // face at exactly y=0, so which one the BVH returns is a floating-point coin
  // flip, and three of four containers were filtered while the fourth was not.
  // Nothing is coplanar at 1.15 / 2.6 / 2.7 m, so the test is sound up here.
  const PROBE_Y = b.max.y - 0.15;
  const floor = new Float32Array(nx * nz).fill(NaN);
  const stand = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const x = cx(i);
      const z = cz(k);

      let oy = PROBE_Y;
      let y = NaN;
      for (let it = 0; it < 6; it++) {
        const g = ray(x, oy, z, 0, -1, 0, oy + 2);
        if (!g.hit) { y = NaN; break; }
        y = g.point.y;
        if (y <= MAX_STEP_UP) break;
        if (g.frontFace !== false) { y = NaN; break; }
        oy = y - 0.02;
      }
      if (!(y <= MAX_STEP_UP) || y < -0.2) continue;
      // Headroom: you must be able to stand up here.
      if (ray(x, y + 0.1, z, 0, 1, 0, 1.7).hit) continue;
      // Capsule girth: four radial probes at chest height.
      let clear = true;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (ray(x, y + CHEST, z, dx, 0, dz, RADIUS).hit) { clear = false; break; }
      }
      if (!clear) continue;
      floor[idx(i, k)] = y;
      stand[idx(i, k)] = 1;
    }
  }

  // ---- pass 2: BFS over passable edges --------------------------------
  const comp = new Int32Array(nx * nz).fill(-1);
  const queue = new Int32Array(nx * nz);
  const passable = (ai, ak, bi, bk) => {
    const ax = cx(ai), az = cz(ak), ay = floor[idx(ai, ak)];
    const by = floor[idx(bi, bk)];
    if (Math.abs(by - ay) > MAX_STEP_UP) return false;
    const dx = cx(bi) - ax;
    const dz = cz(bk) - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    for (const h of [KNEE, CHEST]) {
      if (ray(ax, ay + h, az, ux, 0, uz, len + RADIUS).hit) return false;
    }
    return true;
  };

  let nComp = 0;
  const sizes = [];
  for (let s = 0; s < nx * nz; s++) {
    if (!stand[s] || comp[s] >= 0) continue;
    const id = nComp++;
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const i = cur % nx;
      const k = (cur / nx) | 0;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
        const n = idx(ni, nk);
        if (!stand[n] || comp[n] >= 0) continue;
        if (!passable(i, k, ni, nk)) continue;
        comp[n] = id;
        queue[tail++] = n;
      }
    }
    sizes.push(size);
  }

  // ---- spawns: which component is each in? ----------------------------
  // Snap to the nearest standable cell within a metre; a spawn sitting a few
  // centimetres off a cell centre must not read as "unreachable".
  const spawnInfo = world.spawnPoints.map((sp) => {
    const gi = Math.round((sp.position.x - x0) / STEP);
    const gk = Math.round((sp.position.z - z0) / STEP);
    let best = -1;
    let bestD = Infinity;
    const r = Math.ceil(1.0 / STEP);
    for (let dk = -r; dk <= r; dk++) {
      for (let di = -r; di <= r; di++) {
        const i = gi + di, k = gk + dk;
        if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
        if (!stand[idx(i, k)]) continue;
        const d = di * di + dk * dk;
        if (d < bestD) { bestD = d; best = comp[idx(i, k)]; }
      }
    }
    return {
      tag: sp.tag,
      team: sp.team,
      pos: [sp.position.x, sp.position.z],
      component: best,
      offsetCells: bestD === Infinity ? null : Math.round(Math.sqrt(bestD) * 100) / 100,
    };
  });

  // ---- spawn sightlines ------------------------------------------------
  //
  // Reachability is only half of what a spawn has to be. The other half is
  // that at the instant the round goes live you are not already in somebody's
  // crosshair — which is the entire reason the freeze phase exists, and which
  // freeze cannot provide on its own if the two spawn zones can see each other.
  //
  // Eye height, not floor: a floor-to-floor ray is blocked by any kerb and
  // would pass a map where two teams stare down a lane at each other. 1.6 m is
  // where the shot comes from (`UNITS.playerHeight` 1.78 less `eyeOffset`).
  const EYE = 1.66;
  const seen = [];
  for (const a of spawnInfo) {
    for (const b2 of spawnInfo) {
      if (a.team === b2.team) continue;
      const dx = b2.pos[0] - a.pos[0];
      const dz = b2.pos[1] - a.pos[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      // `.hit`, not the record: `physics.raycast` ALWAYS returns a Hit from its
      // ring pool, so `if (!hit)` is never true and the whole check passes
      // vacuously. Caught by running it against same-team spawn pairs, which
      // stand metres apart on open floor and must see each other — it reported
      // them all as blocked.
      const hit = ray(a.pos[0], EYE, a.pos[1], dx / len, 0, dz / len, len);
      if (!hit.hit) seen.push({ from: a.tag, to: b2.tag, metres: +len.toFixed(1) });
    }
  }

  // ---- phantom nav edges ------------------------------------------------
  //
  // Does the PATHFINDER'S model of the map agree with the map?
  //
  // `ai/nav.js` marks a cell walkable by sampling its centre, and A* connects
  // two walkable cells if both are walkable — `nav.js` checks the cells, never
  // the space between them. At a 0.8 m cell that leaves a hole exactly one
  // wall-thickness wide: geometry thinner than a cell, sitting between two cell
  // centres, is invisible to pathfinding. A* then routes a bot straight through
  // it, the bot walks into the wall, and the recovery is whatever the stuck
  // handler manages.
  //
  // This map survives that by luck rather than design: the partition walls are
  // 0.4 m and happen to land on cell centres. Move one by 40 cm, or add a thin
  // barrier anywhere off the grid, and the pathfinder silently starts lying.
  //
  // So: walk the real `ai.grid`, and for every orthogonally adjacent pair of
  // walkable cells cast knee-height and chest-height rays between the two
  // centres. A blocked ray is an edge A* believes in and physics does not.
  const ai = e.ctx.peek('ai');
  const g = ai?.grid;
  const phantom = [];
  let navPairs = 0;
  if (g) {
    for (let iz = 0; iz < g.nz; iz++) {
      for (let ix = 0; ix < g.nx; ix++) {
        if (!g.walkable(ix, iz)) continue;
        const ax = g.worldX(ix);
        const az = g.worldZ(iz);
        const ay = g.floorAt(ix, iz);
        if (!Number.isFinite(ay)) continue;
        // +x and +z only: every unordered pair is visited exactly once.
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx2 = ix + dx;
          const nz2 = iz + dz;
          if (!g.walkable(nx2, nz2)) continue;
          // `passable`, not just `walkable` on both ends: the question is which
          // edges A* WILL TAKE, and `nav.js` now validates edges at build time.
          // Checking adjacency alone would keep reporting the pairs the
          // pathfinder has already been taught to refuse.
          if (!g.passable(ix, iz, dx, dz)) continue;
          // A* also rejects a step whose floors differ by more than `maxStep`,
          // so a pair the height rule already kills is not an edge it believes
          // in. Without this the check reported 45 "phantom" edges along the top
          // of the east wall — cells 6 m above the floor beside them, which no
          // bot was ever going to be routed onto.
          const by0 = g.floorAt(nx2, nz2);
          if (!Number.isFinite(by0) || Math.abs(by0 - ay) > g.maxStep) continue;
          navPairs++;
          const bx = g.worldX(nx2);
          const bz = g.worldZ(nz2);
          const len = Math.hypot(bx - ax, bz - az);
          const ux = (bx - ax) / len;
          const uz = (bz - az) / len;
          let blocked = false;
          for (const h of [0.45, 1.35]) {
            if (ray(ax, ay + h, az, ux, 0, uz, len).hit) { blocked = true; break; }
          }
          if (blocked && phantom.length < 24) {
            phantom.push({ from: [+ax.toFixed(1), +az.toFixed(1)], to: [+bx.toFixed(1), +bz.toFixed(1)] });
          } else if (blocked) {
            phantom.push(null); // counted, not described
          }
        }
      }
    }
  }

  // ---- nav connectivity ------------------------------------------------
  //
  // The flood above proves the MAP is connected. It says nothing about whether
  // the PATHFINDER's graph is, and those came apart the moment `nav.js` started
  // validating edges: a rule that correctly deletes edges through walls can also
  // delete the last edge through a doorway, and the symptom is not an error —
  // it is bots that walk most of the way and then stop, which reads as an AI
  // problem for as long as you are willing to believe it.
  //
  // Same BFS, over `passable()` and the step-height rule, seeded from the spawn
  // cells. Anything not reached is ground A* cannot deliver a bot to.
  const navComp = new Int32Array(g ? g.nx * g.nz : 0).fill(-1);
  const navSizes = [];
  if (g) {
    const q = new Int32Array(g.nx * g.nz);
    for (let s0 = 0; s0 < g.nx * g.nz; s0++) {
      const sx = s0 % g.nx;
      const sz = (s0 / g.nx) | 0;
      if (!g.walkable(sx, sz) || navComp[s0] >= 0) continue;
      const id = navSizes.length;
      let head = 0, tail = 0;
      q[tail++] = s0;
      navComp[s0] = id;
      let size = 0;
      while (head < tail) {
        const cur = q[head++];
        size++;
        const ix = cur % g.nx;
        const iz = (cur / g.nx) | 0;
        const cy = g.floorAt(ix, iz);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const jx = ix + dx, jz = iz + dz;
          if (!g.walkable(jx, jz)) continue;
          const n = jz * g.nx + jx;
          if (navComp[n] >= 0) continue;
          if (!g.passable(ix, iz, dx, dz)) continue;
          const ny = g.floorAt(jx, jz);
          if (!Number.isFinite(ny) || Math.abs(ny - cy) > g.maxStep) continue;
          navComp[n] = id;
          q[tail++] = n;
        }
      }
      navSizes.push(size);
    }
  }
  const navSpawns = g ? world.spawnPoints.map((sp) => {
    const i = g.nearest(sp.position.x, sp.position.z, sp.position.y);
    return { tag: sp.tag, comp: i >= 0 ? navComp[i] : -1 };
  }) : [];

  // Largest component = the playable floor.
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;

  return {
    nav: {
      present: !!g,
      cell: g?.cell ?? null,
      walkableCells: g?.walkableCount ?? null,
      orphanedCells: g?.orphanedCells ?? null,
      components: navSizes.length,
      componentSizes: navSizes.slice().sort((a, b) => b - a).slice(0, 6),
      spawnComponents: navSpawns,
      pairs: navPairs,
      phantomEdges: phantom.length,
      phantomSample: phantom.filter(Boolean).slice(0, 8),
    },
    sightlines: seen,
    grid: { nx, nz, step: STEP, cells: nx * nz },
    standable: stand.reduce((a, v) => a + v, 0),
    components: sizes.length,
    componentSizes: sizes.slice().sort((a, b) => b - a).slice(0, 6),
    mainComponent: main,
    mainArea: +(sizes[main] * STEP * STEP).toFixed(1),
    spawns: spawnInfo,
    // Flattened for --dump. -1 is solid; otherwise the component id.
    comp: Array.from(comp),
    origin: [x0, z0],
  };
});

const fail = [];
const main = out.mainComponent;
for (const s of out.spawns) {
  if (s.component !== main) {
    fail.push(`${s.tag} at (${s.pos[0]}, ${s.pos[1]}) is in component ${s.component}, not the main floor`);
  }
}
if (out.spawns.length < 2) fail.push('fewer than two spawn points');
const teams = new Set(out.spawns.map((s) => s.team));
if (teams.size < 2) fail.push(`only one team has spawns: ${[...teams]}`);
for (const s of out.sightlines) {
  fail.push(`${s.from} can see ${s.to} across ${s.metres} m at the bell — spawn peek`);
}
// Every edge the pathfinder will take has to be one physics agrees with.
//
// Zero, not a small fraction: an edge A* believes in and the world does not is
// a bot walking into a wall, and `tools/converge.mjs` traced exactly that —
// pinned at x = -10.0 for fifty seconds asking for 3.2 m/s. There is no
// tolerable number of these.
if (out.nav.present && out.nav.phantomEdges > 0) {
  fail.push(
    `${out.nav.phantomEdges}/${out.nav.pairs} nav edges are blocked in physics but ` +
    `passable to A* — the pathfinder will route bots into geometry:\n    ` +
    out.nav.phantomSample.map((p) => `(${p.from}) -> (${p.to})`).join('\n    ')
  );
}
if (!out.nav.present) fail.push('no ai.grid — the nav edge check did not run');
if (out.nav.present) {
  // Every spawn in ONE nav component. A spawn the pathfinder cannot leave is a
  // bot that never joins the round, and it fails silently.
  const cs = new Set(out.nav.spawnComponents.map((s) => s.comp));
  if (cs.size !== 1 || cs.has(-1)) {
    fail.push(
      `spawns land in ${cs.size} nav component(s) (${[...cs].join(', ')}) — ` +
      `A* cannot route between them: ` +
      out.nav.spawnComponents.map((s) => `${s.tag}=${s.comp}`).join(' ')
    );
  }
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (args.dump) {
  // Top-down, +Z down the page so it reads like the layout diagram in
  // warehouse.js flipped: row 0 is the alpha end.
  const { nx, nz, step } = out.grid;
  const [ox, oz] = out.origin;
  const glyph = (c) => (c < 0 ? '#' : c === main ? '.' : String.fromCharCode(97 + (c % 26)));
  const spawnAt = new Map();
  for (const s of out.spawns) {
    const i = Math.round((s.pos[0] - ox) / step);
    const k = Math.round((s.pos[1] - oz) / step);
    spawnAt.set(k * nx + i, s.team === 'alpha' ? 'A' : 'B');
  }
  const lines = [];
  for (let k = 0; k < nz; k++) {
    let row = '';
    for (let i = 0; i < nx; i++) {
      const n = k * nx + i;
      row += spawnAt.get(n) ?? glyph(out.comp[n]);
    }
    lines.push(row);
  }
  console.log(lines.join('\n'));
  console.log('\n# = solid/unstandable   . = main floor   a,b,… = isolated pocket   A/B = spawn\n');
}
delete out.comp;
console.log(JSON.stringify(out, null, 2));
console.log(
  fail.length === 0
    ? `\nREACH OK — all ${out.spawns.length} spawns share one ${out.mainArea} m² floor, ` +
      `no cross-team sightline at the bell · ${out.nav.pairs} nav edges all clear`
    : `\nREACH FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
