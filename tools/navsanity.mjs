#!/usr/bin/env node
/**
 * Does the nav grid's connectivity LABEL match the moves it will actually make?
 *
 * `nav.js` labels every walkable cell with a connected component and the rest of
 * the AI treats that label as a promise: `randomMainPoint` only ever picks
 * destinations inside the main component, `findPath` returns "no route" for free
 * when two cells disagree on it, and `Agent._ensureGoal` recovers a stranded bot
 * by routing it to a main-component cell. Every one of those is wrong if the
 * label says "connected" and the pathfinder cannot get there.
 *
 * IT SAID EXACTLY THAT. Chased down through `tools/botfight.mjs`, a bot stood in
 * COMBAT for 34.5 s while `_ensureGoal` fired every 1.5 s and achieved nothing.
 * Flooding from its cell with the neighbour rules `findPath` expands with reached
 * ONE cell — itself — while `component` put it in a main component of 2387.
 *
 * WHY. Diagonal moves are not symmetric. Going from A to B diagonally tests the
 * two orthogonal legs adjacent to A:
 *
 *     if (!passable(ax, az, dx, 0) || !passable(ax, az, 0, dz)) continue;
 *
 * Coming back tests the two legs adjacent to B, which are the OTHER two sides of
 * the same square. So a cell can be enterable and not leavable. `_buildComponents`
 * floods with that relation as though it were symmetric, which is what mints a
 * one-way cell inside the main component.
 *
 * WHAT THIS ASSERTS
 *
 *   1. no walkable cell is a SINK: every one has at least one legal move out
 *   2. the main component is STRONGLY connected — a forward flood from a cell
 *      inside it and a REVERSE flood from the same cell both cover exactly the
 *      set the label claims, so every main cell can reach the rest and be
 *      reached by it
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: that every edge is reversible. The first
 * version failed on that and it was the wrong bar — 152 asymmetric edges survive
 * the fix and none of them is a defect, because a one-way corner is only a
 * problem if there is no way round, and the reverse flood is what actually
 * answers that. Demanding symmetric edges would demand geometry that never
 * produces an awkward corner. The count is still printed, because a number that
 * only appears when it trips a gate is a number nobody can watch drift.
 *
 *   node tools/navsanity.mjs
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);

const vite = await ensureServer(PORT, { name: 'NAVSANITY' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await waitForReady(page, { name: 'NAVSANITY' });

const out = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.get('ai');
  const g = ai?.grid;
  if (!g) return { fatal: 'no nav grid' };

  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

  /** The move legality `findPath` expands with, reproduced exactly. */
  const canStep = (cx, cz, dx, dz) => {
    const ix = cx + dx, iz = cz + dz;
    if (!g.walkable(ix, iz)) return false;
    if (dx && dz) {
      if (!g.walkable(cx + dx, cz) || !g.walkable(cx, cz + dz)) return false;
      if (!g.passable(cx, cz, dx, 0) || !g.passable(cx, cz, 0, dz)) return false;
    } else if (!g.passable(cx, cz, dx, dz)) return false;
    const cur = g.index(cx, cz);
    const ni = g.index(ix, iz);
    if (Math.abs(g.floor[ni] - g.floor[cur]) > g.maxStep) return false;
    return true;
  };

  const n = g.flags.length;
  const sinks = [];
  const oneWay = [];
  let walkable = 0;
  for (let i = 0; i < n; i++) {
    if (!g.flags[i]) continue;
    walkable++;
    const cx = i % g.nx;
    const cz = (i / g.nx) | 0;
    let outs = 0;
    for (let d = 0; d < 8; d++) {
      const dx = DX[d], dz = DZ[d];
      if (!canStep(cx, cz, dx, dz)) continue;
      outs++;
      // ...and can it come back the same way?
      if (!canStep(cx + dx, cz + dz, -dx, -dz) && oneWay.length < 40) {
        oneWay.push({
          from: i, to: g.index(cx + dx, cz + dz), dx, dz,
          x: +g.worldX(cx).toFixed(2), z: +g.worldZ(cz).toFixed(2),
          comp: g.component ? g.component[i] : null,
        });
      }
    }
    if (outs === 0 && sinks.length < 40) {
      sinks.push({
        i, x: +g.worldX(cx).toFixed(2), z: +g.worldZ(cz).toFixed(2),
        y: +g.floor[i].toFixed(2),
        comp: g.component ? g.component[i] : null,
        inMain: !!g.inMainComponent(i),
      });
    }
  }

  /**
   * Is the main component STRONGLY connected — can you get out AND back?
   *
   * A forward flood alone cannot answer that. The defect this file was written
   * for was a cell you could walk into and never leave, and a forward flood from
   * a seed elsewhere reaches it happily. Mutual reachability needs the reverse
   * graph too: flood from the same seed following edges BACKWARDS, and if both
   * floods cover every cell the label claims, then from any of them you can
   * reach the seed and the seed can reach you, which is the promise
   * `inMainComponent` is consumed as making.
   *
   * O(cells) each. Cheap enough to do properly, which is the whole reason not to
   * settle for the forward half.
   */
  let mainSeed = -1;
  for (let i = 0; i < n; i++) {
    if (g.flags[i] && g.inMainComponent(i)) { mainSeed = i; break; }
  }
  const flood = (reverse) => {
    if (mainSeed < 0) return 0;
    const seen = new Uint8Array(n);
    const stack = [mainSeed];
    seen[mainSeed] = 1;
    let count = 1;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % g.nx;
      const cz = (cur / g.nx) | 0;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dz = DZ[d];
        // Forward: can I step to the neighbour? Reverse: can the neighbour step
        // to me? The neighbour must be walkable either way before it is asked.
        if (!g.walkable(cx + dx, cz + dz)) continue;
        const ok = reverse
          ? canStep(cx + dx, cz + dz, -dx, -dz)
          : canStep(cx, cz, dx, dz);
        if (!ok) continue;
        const ni = g.index(cx + dx, cz + dz);
        if (seen[ni]) continue;
        seen[ni] = 1;
        count++;
        stack.push(ni);
      }
    }
    return count;
  };
  const reached = flood(false);
  const reachedBack = flood(true);

  return {
    walkable,
    cells: n,
    mainCells: g.mainComponentCells,
    pocketCells: g.pocketCells,
    componentCount: g.componentCount,
    reachedFromMain: reached,
    reachedBackToMain: reachedBack,
    sinks,
    oneWay,
    // Totals, because the lists above are capped for readability.
    sinkCount: (() => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        if (!g.flags[i]) continue;
        const cx = i % g.nx, cz = (i / g.nx) | 0;
        let outs = 0;
        for (let d = 0; d < 8; d++) if (canStep(cx, cz, DX[d], DZ[d])) { outs++; break; }
        if (!outs) c++;
      }
      return c;
    })(),
    oneWayCount: (() => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        if (!g.flags[i]) continue;
        const cx = i % g.nx, cz = (i / g.nx) | 0;
        for (let d = 0; d < 8; d++) {
          const dx = DX[d], dz = DZ[d];
          if (canStep(cx, cz, dx, dz) && !canStep(cx + dx, cz + dz, -dx, -dz)) c++;
        }
      }
      return c;
    })(),
  };
});

await browser.close();
killServer(vite);

if (out?.fatal) {
  console.log(`\nNAVSANITY FAILED — ${out.fatal}`);
  process.exit(1);
}

const fail = [];
console.log(
  `  ${out.walkable} walkable of ${out.cells} cells · ${out.componentCount} components · ` +
  `main ${out.mainCells}, pockets ${out.pocketCells}`
);
console.log(
  `  from a main cell: forward flood reaches ${out.reachedFromMain}, reverse flood ${out.reachedBackToMain} · ` +
  `sinks ${out.sinkCount} · asymmetric edges ${out.oneWayCount} (reported, not gated)`
);

if (out.sinkCount > 0) {
  fail.push(
    `${out.sinkCount} walkable cell(s) have no legal move out — a bot that ends up on one ` +
    `can never path anywhere again, and ${out.sinks.filter((s) => s.inMain).length} of the ` +
    `first ${out.sinks.length} are labelled INSIDE the main component: ` +
    out.sinks.slice(0, 4).map((s) => `#${s.i} (${s.x}, ${s.z}) comp ${s.comp}${s.inMain ? ' MAIN' : ''}`).join(', ')
  );
}
if (out.reachedFromMain !== out.mainCells) {
  fail.push(
    `a forward flood from inside the main component reaches ${out.reachedFromMain} cells against ` +
    `the ${out.mainCells} it claims — the label and the pathfinder disagree about the map`
  );
}
// The half a forward flood cannot see. A cell you can walk INTO and never leave
// is reached by the forward flood and is exactly the defect this file exists for.
if (out.reachedBackToMain !== out.mainCells) {
  fail.push(
    `a REVERSE flood reaches ${out.reachedBackToMain} of the ${out.mainCells} cells labelled main — ` +
    `${out.mainCells - out.reachedBackToMain} of them can be entered and not left, so the component ` +
    `is not strongly connected and \`inMainComponent\` is promising a round trip it cannot deliver`
  );
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nNAVSANITY FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nNAVSANITY OK — no sinks, and the main component is strongly connected (out and back)');
