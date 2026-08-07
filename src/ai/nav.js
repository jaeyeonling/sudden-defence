/**
 * AI — navigation and cover.
 *
 * NAVIGATION is a dense walkability grid sampled straight out of the physics
 * BVH at boot: one downward ray per cell finds the floor, one upward ray checks
 * standing clearance, and the floor normal gives the slope. That is a navmesh's
 * worth of information for a fraction of the code, and it stays correct for a
 * level the `world` system generated procedurally without any authoring pass.
 *
 *   • A* over the 8-connected grid with a heap, slope and step penalties
 *   • string pulling against a line-of-walk test, so paths hug corners instead
 *     of zig-zagging cell to cell
 *   • per-agent local avoidance so a squad flows around itself
 *
 * COVER is derived from the same grid. Every walkable cell next to a blocker
 * becomes a cover point with a direction and a height class (full / crouch),
 * plus a peek offset that has line of sight past the edge. At runtime cover is
 * scored against the live threat direction, the agent's distance, and what the
 * rest of the squad has already claimed.
 */

import * as THREE from 'three';

const SQRT2 = Math.SQRT2;

/* ------------------------------------------------------------------ */
/* Binary heap for A*                                                  */
/* ------------------------------------------------------------------ */

class Heap {
  constructor(cap) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  /**
   * Grow rather than DROP when the open list is full.
   *
   * This used to `return` silently on overflow, and the capacity was one entry
   * per grid cell. That looks sufficient and is not: A* here has no decrease-key,
   * it re-pushes a cell every time it finds a cheaper route to it, so the open
   * list routinely holds more entries than the grid holds cells. Every dropped
   * entry is a cell the search will never expand, and the failure it produces is
   * indistinguishable from "there is no route" — `findPath` returns 0, `_goTo`
   * reports the destination unreachable, and `_combat` stands still. Measured
   * after the region and height fixes, this was the whole of the remainder: 225
   * failures in 75 s, every one of them start and goal in the SAME region.
   *
   * Doubling is amortised and one-off: the arrays survive between searches, so a
   * grid settles at its working size within the first few paths and never
   * allocates again. That keeps the per-frame allocation rule intact.
   */
  push(i, k) {
    if (this.n >= this.idx.length) {
      const cap = this.idx.length * 2;
      const idx = new Int32Array(cap);
      idx.set(this.idx);
      const key = new Float32Array(cap);
      key.set(this.key);
      this.idx = idx;
      this.key = key;
    }
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p], tk = this.key[p];
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c];
      this.idx[c] = ti; this.key[c] = tk;
      c = p;
    }
  }

  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m], tk = this.key[m];
        this.idx[m] = this.idx[c]; this.key[m] = this.key[c];
        this.idx[c] = ti; this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ */
/* Nav grid                                                            */
/* ------------------------------------------------------------------ */

export class NavGrid {
  constructor(physics, opts = {}) {
    this.physics = physics;
    this.cell = opts.cell ?? 0.8;
    this.radius = opts.radius ?? 0.36;
    this.height = opts.height ?? 1.78;
    this.crouchHeight = opts.crouchHeight ?? 1.15;
    this.maxStep = opts.maxStep ?? 0.45;
    this.maxSlope = Math.cos((opts.maxSlopeDeg ?? 46) * Math.PI / 180);

    const b = opts.bounds;
    this.minX = Math.floor(b.min.x / this.cell) * this.cell;
    this.minZ = Math.floor(b.min.z / this.cell) * this.cell;
    this.nx = Math.max(1, Math.ceil((b.max.x - this.minX) / this.cell));
    this.nz = Math.max(1, Math.ceil((b.max.z - this.minZ) / this.cell));
    /**
     * Where the floor probe starts its drop.
     *
     * INSIDE the bounds, not four metres above them. `b.max.y + 4` is the right
     * answer for an outdoor street, where nothing overhangs the walkable surface
     * and starting high only buys margin. Under a roof it is catastrophic and
     * silent: the first thing a downward ray meets is the roof slab, every cell
     * reports the roof as its floor, and you get a complete, plausible-looking
     * navmesh built across the top of the building. Bots then path over a
     * geometry they are not standing on — they still walk, they still shoot,
     * they just do it against a map that does not exist.
     *
     * This is the same mistake as the +6 m spawn probe in player/index.js, from
     * the same inherited assumption, found the same way: by measuring a number
     * (`floor = 6.5` on a 6 m building) rather than by looking at the screen.
     *
     * `opts.bounds` is the playable volume, so its ceiling is the highest point
     * a player can occupy. Dropping from just under it is correct indoors and
     * costs an outdoor map nothing.
     */
    this.topY = b.max.y - 0.05;

    const n = this.nx * this.nz;
    /** 0 = blocked, 1 = walkable standing, 2 = walkable crouched only */
    this.flags = new Uint8Array(n);
    this.floor = new Float32Array(n);
    this.floor.fill(-Infinity);
    /** how enclosed a cell is: 0 open, 1 hemmed in — used for cover scoring */
    this.enclosure = new Uint8Array(n);

    // A* working set
    this.gScore = new Float32Array(n);
    this.came = new Int32Array(n);
    this.visitStamp = new Int32Array(n);
    /** Cells already expanded this search — see the pop guard in findPath. */
    this.closedStamp = new Int32Array(n);
    this.stamp = 0;
    this.open = new Heap(Math.min(n, 1 << 16));

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._p0 = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this.buildMs = 0;
    this.walkableCount = 0;
  }

  index(ix, iz) {
    return iz * this.nx + ix;
  }

  cellX(x) {
    return Math.round((x - this.minX) / this.cell);
  }

  cellZ(z) {
    return Math.round((z - this.minZ) / this.cell);
  }

  worldX(ix) {
    return this.minX + ix * this.cell;
  }

  worldZ(iz) {
    return this.minZ + iz * this.cell;
  }

  inside(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz;
  }

  /** Sample the physics world. ~2 rays per cell; logged so the cost is visible. */
  build() {
    const t0 = performance.now();
    const phys = this.physics;
    const MASK = phys.MASK.WORLD;
    const r = this.radius;
    let walk = 0;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const i = this.index(ix, iz);
        const x = this.worldX(ix), z = this.worldZ(iz);
        const down = phys.raycast(x, this.topY, z, 0, -1, 0, this.topY + 30, MASK);
        if (!down.hit) continue;
        this.floor[i] = down.point.y;
        if (down.normal.y < this.maxSlope) continue;
        const fy = down.point.y;
        // standing clearance straight up
        const up = phys.raycast(x, fy + 0.25, z, 0, 1, 0, this.height - 0.2, MASK);
        if (!up.hit) this.flags[i] = 1;
        else if (up.distance > this.crouchHeight - 0.25) this.flags[i] = 2;
        else continue;
        // ---- lateral probes at chest height, at TWO different reaches ----
        //
        // This used to be one probe answering two questions, and it could only
        // ever answer the first:
        //
        //   SHOULDER CLEARANCE — "am I wedged into geometry?" A question about
        //   the capsule, so it is asked at the capsule radius.
        //
        //   ENCLOSURE — "is there something here to stand behind?" A question
        //   about cover, and cover you can use is up to a metre away, not 6 cm.
        //
        // Sharing the tight radius made `enclosure` almost always zero, and
        // CoverMap.build() only considers cells with a non-zero enclosure or a
        // non-walkable neighbour. On the dense market street this came from
        // there was enough clutter that the neighbour rule found cover anyway.
        // In an open warehouse it found NOTHING — a measured zero cover points
        // across 2,867 walkable cells, which left every bot with nowhere to take
        // cover and turned a firefight into two lines of men standing in the
        // open shooting at each other until one line ran out.
        //
        // COVER_REACH stays under one cell (0.8 m) on purpose: a blocker further
        // off than the grid resolution is not cover for THIS cell, it is cover
        // for the cell next to it.
        const COVER_REACH = 0.72;
        let tight = 0;
        let near = 0;
        for (let d = 0; d < 4; d++) {
          const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
          const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
          if (!phys.raycastAny(x, fy + 0.95, z, dx, 0, dz, COVER_REACH, MASK)) continue;
          near++;
          if (phys.raycastAny(x, fy + 0.95, z, dx, 0, dz, r + 0.06, MASK)) tight++;
        }
        if (tight >= 3) {
          this.flags[i] = 0;
          continue;
        }
        this.enclosure[i] = near;
        walk++;
      }
    }
    this.walkableCount = walk;

    // ---- edge pass: is the space BETWEEN two walkable cells actually open? ----
    //
    // A cell is sampled at its centre, and until this existed A* connected two
    // cells on the strength of those two samples alone. That leaves a hole
    // exactly one wall-thickness wide: geometry thinner than `cell` sitting
    // between two centres is invisible to the pathfinder, which then routes a
    // bot straight through it.
    //
    // It was not hypothetical. `minZ` is `floor(bounds.min.z / cell) * cell`,
    // which on an 18 m half-depth and a 0.8 m cell lands at -18.4 — 0.4 m
    // outside the hall and INSIDE the 0.5 m end wall. That whole first row
    // sampled as walkable (its down-ray lands on the wall's top face at 6 m,
    // which is flat and has headroom under the roof), so the grid believed in a
    // corridor running the width of the map through the back wall. Measured by
    // `tools/reach.mjs`: 373 of 5,522 adjacent pairs — 6.8 % — were edges A*
    // believed in and physics did not.
    //
    // Two heights because a capsule is not a point: knee catches kerbs and crate
    // edges, chest catches walls and railings. Both are cast between the two
    // cell centres, so the test is exactly the move A* is about to allow.
    //
    // Cost is 4 rays per cell on top of the ~2 the pass above spends, paid once
    // at build. The alternative is paying it forever in bots walking into walls.
    this.edgeX = new Uint8Array(this.nx * this.nz);
    this.edgeZ = new Uint8Array(this.nx * this.nz);
    const KNEE = 0.45;
    const CHEST = 1.35;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        if (!this.walkable(ix, iz)) continue;
        const i = this.index(ix, iz);
        const ax = this.worldX(ix), az = this.worldZ(iz), ay = this.floor[i];
        if (!Number.isFinite(ay)) continue;
        for (const dir of [0, 1]) {
          const jx = ix + (dir === 0 ? 1 : 0);
          const jz = iz + (dir === 0 ? 0 : 1);
          if (!this.walkable(jx, jz)) continue;
          const ux = dir === 0 ? 1 : 0;
          const uz = dir === 0 ? 0 : 1;
          // Three parallel rays, not one down the middle.
          //
          // A bot is a 0.4 m capsule, not a point, so an edge is only usable if
          // a CORRIDOR that wide is clear — and the centre line being clear says
          // nothing about the corridor. The case that matters is a convex
          // corner: path following steers straight at the next waypoint, so a
          // route that grazes the mid block's corner puts the capsule into it
          // while the centre line misses by centimetres. The bot then wedges,
          // `_unstick` frees it, the hunt re-issues the same route, and it wedges
          // again. `tools/converge.mjs` traced twenty seconds of that oscillation
          // between (2.1, -1.4) and (0.2, -6.6), against the block face at
          // z = -1.1.
          //
          // Offsetting by the radius on both sides costs two more rays per
          // height and makes A* refuse the routes the character controller was
          // always going to refuse.
          //
          // 2 cm of overhang at each end, not exactly `cell`.
          //
          // A ray that ENDS on a surface is a coplanar hit, and whether the BVH
          // returns it is a floating-point coin flip — the same trap this
          // codebase documents for the container bottoms sitting on the floor
          // at y=0. It matters here because a cell centre can land exactly on a
          // wall face: the grid runs to x = 24.0 and the east wall's inner face
          // is x = 24.0, so the edge into it was sometimes reported clear.
          // `tools/reach.mjs` caught 45 such pairs with a ray that started a
          // fraction earlier.
          const EPS = 0.02;
          // Perpendicular to the step, in the ground plane.
          const px = -uz;
          const pz = ux;
          let open = true;
          for (const h of [KNEE, CHEST]) {
            for (const off of [0, r, -r]) {
              if (phys.raycastAny(
                ax - ux * EPS + px * off, ay + h, az - uz * EPS + pz * off,
                ux, 0, uz, this.cell + EPS * 2, MASK
              )) { open = false; break; }
            }
            if (!open) break;
          }
          if (open) (dir === 0 ? this.edgeX : this.edgeZ)[i] = 1;
        }
      }
    }

    // Cells with no way in or out are not cells.
    //
    // The in-wall row described above stays "walkable" after the edge pass —
    // every edge touching it is closed, but the cell itself still samples as
    // standable, so `nearest()` would happily snap a destination into the back
    // wall and A* would then fail to find a route to it. `_goTo` reads that
    // failure as "unreachable cover" and drops the move entirely.
    //
    // A cell that no neighbour can reach is one no bot can occupy, whatever the
    // down-ray says. Dropping it costs one more pass over the grid and makes
    // `nearest()` honest.
    // A CELL WITH NO LEGAL MOVE OUT IS NOT A CELL, and "legal" means what A*
    // means by it — see `canStep`. This pass used to ask a weaker question: the
    // four orthogonal neighbours only, no step-height check, and a single sweep.
    // Each of those three shortcuts leaves a different kind of trap standing:
    //
    //   diagonals      a cell whose only opening is a corner, where the corner
    //                  rule then refuses the move
    //   step height    a cell whose neighbours are all a shelf too tall
    //   single sweep   deleting a cell can orphan one already scanned past
    //
    // Measured on this map before the fix: 19 survivors, three of them inside
    // the main component and two of those the exact cells a bot stood on for
    // 34.5 s in `tools/botfight.mjs`. They came in mirror pairs — (-4, -12.8)
    // and (4, -12.8) — which is what a geometry-generated fault looks like on a
    // map gated for symmetry.
    //
    // Iterated to a fixed point. Bounded by the cell count in the worst case and
    // settles in two or three sweeps in practice, at bake time, once.
    let orphaned = 0;
    for (let sweep = 0; ; sweep++) {
      let removed = 0;
      for (let iz = 0; iz < this.nz; iz++) {
        for (let ix = 0; ix < this.nx; ix++) {
          if (!this.walkable(ix, iz)) continue;
          let any = false;
          for (let d = 0; d < 8; d++) {
            if (this.canStep(ix, iz, DX[d], DZ[d])) { any = true; break; }
          }
          if (!any) { this.flags[this.index(ix, iz)] = 0; removed++; }
        }
      }
      orphaned += removed;
      if (!removed) break;
    }
    this.walkableCount -= orphaned;
    this.orphanedCells = orphaned;

    this._buildComponents();

    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * Label every walkable cell with the connected region it belongs to.
   *
   * The orphan pass above deletes cells with NO passable neighbour. It cannot
   * see the other failure: a group of cells that are perfectly connected to each
   * other and to nothing else. A container roof is the example that matters here
   * — several standable cells 2.5 m up, mutually reachable, and cut off from the
   * floor by a step no bot can take.
   *
   * Those pockets were 437 of 2824 walkable cells, and they were expensive out
   * of all proportion to their size, because everything downstream treated an
   * unreachable destination as a routing failure rather than as a bad
   * destination. `CoverMap` offered 256 of its 612 points inside them; a bot in
   * combat picked one, `_goTo` failed, `_combat` read the failure as "cover I
   * cannot use", dropped it and picked again on the very next frame — at
   * `desiredSpeed = 0`, because that branch only moves when it HAS cover it is
   * not standing in. Measured on the shipped build: 96 % of all A* calls failed
   * to find a route, and bots stood still for 46.8 % of live round time, with
   * single stretches of 16 s. From the player's side the bots simply did not
   * move.
   *
   * Adjacency here must match `findPath` exactly — same eight directions, same
   * corner rule, same `maxStep`. A cheaper approximation would label two cells
   * as one region that A* cannot actually walk between, which is the same bug
   * again with an extra step of indirection.
   */
  _buildComponents() {
    const n = this.flags.length;
    if (!this.component || this.component.length !== n) this.component = new Int32Array(n);
    this.component.fill(-1);
    const stack = [];
    let next = 0;
    let mainId = -1;
    let mainSize = 0;
    for (let seed = 0; seed < n; seed++) {
      if (this.component[seed] !== -1 || !this.flags[seed]) continue;
      const id = next++;
      let size = 0;
      this.component[seed] = id;
      stack.push(seed);
      while (stack.length) {
        const cur = stack.pop();
        size++;
        const cx = cur % this.nx;
        const cz = (cur / this.nx) | 0;
        const cy = this.floor[cur];
        for (let d = 0; d < 8; d++) {
          const dx = DX[d], dz = DZ[d];
          const ix = cx + dx, iz = cz + dz;
          // BOTH directions. This label is consumed as a promise of mutual
          // reachability — `randomMainPoint` picks destinations by it,
          // `findPath` short-circuits "no route" by it, `_ensureGoal` recovers
          // by it — and the step relation is not symmetric (see `canStep`), so
          // flooding it one-way put cells in the main component that could be
          // entered and not left. Requiring the return trip on each edge is
          // conservative rather than exact — mutual reachability could still
          // hold through a longer way round — but it errs toward calling a cell
          // unreachable, which costs a destination nobody picks instead of a bot
          // standing still for the rest of the round.
          if (!this.canStep(cx, cz, dx, dz)) continue;
          if (!this.canStep(ix, iz, -dx, -dz)) continue;
          const ni = this.index(ix, iz);
          if (this.component[ni] !== -1) continue;
          this.component[ni] = id;
          stack.push(ni);
        }
      }
      if (size > mainSize) { mainSize = size; mainId = id; }
    }
    this.componentCount = next;
    this.mainComponent = mainId;
    this.mainComponentCells = mainSize;
    this.pocketCells = this.walkableCount - mainSize;
  }

  /** Is this cell part of the one region the match is actually played in? */
  inMainComponent(i) {
    return i >= 0 && this.component ? this.component[i] === this.mainComponent : i >= 0;
  }

  /**
   * A random standable point in the region the match is played in.
   *
   * The escape hatch for "every destination I know about is unreachable". A bot
   * whose whole patrol route is unroutable has no other way to make progress: it
   * re-solves the same three points forever at walking speed with nowhere to
   * walk. Measured once before this existed — 111 s motionless, `desiredSpeed`
   * 3.2 and `hasMoveTarget` false the entire time.
   *
   * Rejection sampling rather than a prebuilt list: the main component is 85 % of
   * the grid, so the expected number of draws is a shade over one, and a list
   * would have to be rebuilt with the grid.
   */
  randomMainPoint(rng, out) {
    const n = this.flags.length;
    if (!n) return null;
    for (let tries = 0; tries < 64; tries++) {
      const i = Math.min(n - 1, (rng.float() * n) | 0);
      if (!this.flags[i] || !this.inMainComponent(i)) continue;
      out.set(this.worldX(i % this.nx), this.floor[i], this.worldZ((i / this.nx) | 0));
      return out;
    }
    return null;
  }

  /**
   * Can a bot step from (ix,iz) to the orthogonally adjacent cell in (dx,dz)?
   *
   * Edges are stored once per pair, on the lower-index cell, so a step in the
   * negative direction reads the neighbour's flag.
   */
  /**
   * Can a bot legally step from (cx, cz) to (cx + dx, cz + dz)?
   *
   * THE definition, in one place, because three things need it and for a long
   * time each had its own: A* expanded with the full rule, `_buildComponents`
   * flooded with the full rule but treated it as symmetric, and the orphan pass
   * used a reduced one — four orthogonal directions, no height check, one pass.
   * That gap is what minted the defect this exists to prevent: 19 walkable cells
   * with NO legal move out at all, three of them labelled inside the main
   * component. A bot that ended up on one could never path anywhere again, and
   * `tools/botfight.mjs` measured one standing in COMBAT for 34.5 s while its
   * recovery fired 23 times and failed 23 times.
   *
   * NOT SYMMETRIC, and that is the subtle half. A diagonal tests the two
   * orthogonal legs adjacent to the ORIGIN, so `canStep(A -> B)` and
   * `canStep(B -> A)` consult opposite corners of the same square and can
   * disagree. `tools/navsanity.mjs` counts both the sinks and the asymmetric
   * edges, and is the gate that keeps this honest.
   */
  canStep(cx, cz, dx, dz) {
    const ix = cx + dx, iz = cz + dz;
    if (!this.walkable(ix, iz)) return false;
    if (dx && dz) {
      if (!this.walkable(cx + dx, cz) || !this.walkable(cx, cz + dz)) return false;
      if (!this.passable(cx, cz, dx, 0) || !this.passable(cx, cz, 0, dz)) return false;
    } else if (!this.passable(cx, cz, dx, dz)) return false;
    const ni = this.index(ix, iz);
    const cur = this.index(cx, cz);
    if (Math.abs(this.floor[ni] - this.floor[cur]) > this.maxStep) return false;
    return true;
  }

  passable(ix, iz, dx, dz) {
    if (dx > 0) return this.edgeX[this.index(ix, iz)] === 1;
    if (dx < 0) return this.inside(ix - 1, iz) && this.edgeX[this.index(ix - 1, iz)] === 1;
    if (dz > 0) return this.edgeZ[this.index(ix, iz)] === 1;
    if (dz < 0) return this.inside(ix, iz - 1) && this.edgeZ[this.index(ix, iz - 1)] === 1;
    return true;
  }

  walkable(ix, iz, crouch = true) {
    if (!this.inside(ix, iz)) return false;
    const f = this.flags[this.index(ix, iz)];
    return crouch ? f !== 0 : f === 1;
  }

  floorAt(ix, iz) {
    return this.floor[this.index(ix, iz)];
  }

  /**
   * Nearest walkable cell to a world point, searched in rings. Pass `y` plus a
   * `yTol` to reject cells on a different storey — otherwise a spawn point in a
   * street happily snaps onto a market stall's table top.
   */
  nearest(x, z, y = null, maxRings = 8, yTol = Infinity) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    const okY = (i) => y === null || Math.abs(this.floor[i] - y) <= yTol;
    /**
     * The exact cell wins only if it is also at the right HEIGHT.
     *
     * This shortcut used to return the cell under (x, z) whenever it was
     * walkable, and `yTol` defaults to Infinity, so height was not consulted at
     * all. Under a container that is wrong in the worst possible way: a bot
     * standing on the floor at y = 0.04 resolved to the container ROOF cell at
     * floor 2.4 — a different connected region, from which no route to anything
     * exists. The bot then failed every path request it made, and `_combat`
     * holds `desiredSpeed = 0` while it has no cover it can reach, so it stood
     * there. Measured over 75 s: 279 routing failures shaped exactly
     * "start component 5, goal component 1".
     *
     * The ring search below already weights the height difference (`* 4`), so
     * rejecting the centre here does not lose the cell — it just makes it
     * compete on the same terms as its neighbours, and a floor cell one ring out
     * beats a roof cell overhead.
     *
     * The gate is one step plus half a cell: a bot on a ramp or a kerb is
     * legitimately off its cell's sampled floor by up to `maxStep`, and half a
     * cell of slack keeps a bot straddling a boundary from flickering between
     * two answers.
     */
    const yGate = this.maxStep + this.cell * 0.5;
    if (this.walkable(cx, cz)) {
      const i0 = this.index(cx, cz);
      if (okY(i0) && (y === null || Math.abs(this.floor[i0] - y) <= yGate)) return i0;
    }
    for (let ring = 1; ring <= maxRings; ring++) {
      let best = -1, bestD = Infinity;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const ix = cx + dx, iz = cz + dz;
          if (!this.walkable(ix, iz)) continue;
          const i = this.index(ix, iz);
          if (!okY(i)) continue;
          let d = dx * dx + dz * dz;
          if (y !== null && Number.isFinite(this.floor[i])) d += (this.floor[i] - y) ** 2 * 4;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * A* between two world points. Writes world-space waypoints into `out`
   * (an array of THREE.Vector3, reused) and returns the count.
   */
  findPath(from, to, out, opts = {}) {
    const start = this.nearest(from.x, from.z, from.y);
    const goal = this.nearest(to.x, to.z, to.y);
    if (start < 0 || goal < 0) return 0;
    // Different regions: there is no route, and the search cannot discover that
    // cheaply — it has to expand the caller's whole component first. On the
    // shipped build 3532 of 3665 searches in a minute were exactly this case,
    // each one walking up to `maxNodes` cells to arrive at the answer this line
    // gives for free.
    if (this.component && this.component[start] !== this.component[goal]) return 0;
    if (start === goal) {
      this._emit(out, 0, to);
      return 1;
    }
    const nx = this.nx;
    const gx = goal % nx, gz = (goal / nx) | 0;
    const cell = this.cell;
    const maxNodes = opts.maxNodes ?? 6000;

    this.stamp++;
    const stamp = this.stamp;
    this.open.clear();
    this.gScore[start] = 0;
    this.came[start] = -1;
    this.visitStamp[start] = stamp;
    this.open.push(start, 0);

    let expanded = 0;
    let found = false;
    while (this.open.n > 0 && expanded < maxNodes) {
      const cur = this.open.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      // Lazy deletion. There is no decrease-key here: finding a cheaper route to
      // a cell re-PUSHES it, so the open list holds stale copies of cells that
      // have already been expanded. Without this guard each of those copies is
      // expanded again, and `expanded` — which is what `maxNodes` bounds — counts
      // the duplicates. Measured on a 3300-cell grid: a five-metre hop from
      // (5.1, 1.8) to (10.4, 1.6) exhausted the 6000-node budget and reported no
      // route. Every same-region routing failure left after the region and height
      // fixes was this, 68 of 68, and every one of them completed when the budget
      // was raised to 400000 — the budget was never the problem, the re-expansion
      // was. With the guard, expansions are bounded by the cell count.
      if (this.closedStamp[cur] === stamp) continue;
      this.closedStamp[cur] = stamp;
      expanded++;
      const cxi = cur % nx, czi = (cur / nx) | 0;
      const cg = this.gScore[cur];
      const cy = this.floor[cur];
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dz = DZ[d];
        const ix = cxi + dx, iz = czi + dz;
        // One definition of a legal step, shared with the component fill and the
        // orphan pass. No corner cutting, no phantom edges, no shelf too tall.
        if (!this.canStep(cxi, czi, dx, dz)) continue;
        const ni = this.index(ix, iz);
        const dy = this.floor[ni] - cy;
        let cost = (dx && dz ? SQRT2 : 1) * cell;
        cost += Math.abs(dy) * 2.2; // prefer flat ground
        if (this.flags[ni] === 2) cost += cell * 1.6; // crouch-only squeeze
        cost += this.enclosure[ni] * cell * 0.25; // avoid scraping walls
        const g = cg + cost;
        if (this.visitStamp[ni] === stamp && g >= this.gScore[ni]) continue;
        this.visitStamp[ni] = stamp;
        this.gScore[ni] = g;
        this.came[ni] = cur;
        const hx = Math.abs(ix - gx), hz = Math.abs(iz - gz);
        const h = (Math.max(hx, hz) + (SQRT2 - 1) * Math.min(hx, hz)) * cell;
        this.open.push(ni, g + h * 1.06);
      }
    }
    if (!found) return 0;

    // walk the parents back, then string-pull
    const raw = this._raw ?? (this._raw = []);
    raw.length = 0;
    let n = goal;
    while (n >= 0) {
      raw.push(n);
      n = this.came[n];
    }
    raw.reverse();
    return this._stringPull(raw, from, to, out);
  }

  _emit(out, i, v) {
    if (!out[i]) out[i] = new THREE.Vector3();
    out[i].copy(v);
  }

  /**
   * Greedy string pull: keep the furthest waypoint still reachable in a
   * straight walkable line from the anchor. Turns a staircase into a corner.
   */
  _stringPull(raw, from, to, out) {
    let count = 0;
    const anchor = this._v.copy(from);
    let i = 0;
    const nx = this.nx;
    const pos = this._v2;
    while (i < raw.length - 1) {
      let best = i + 1;
      for (let j = raw.length - 1; j > i; j--) {
        const c = raw[j];
        pos.set(this.worldX(c % nx), this.floor[c], this.worldZ((c / nx) | 0));
        if (this.lineOfWalk(anchor, pos)) {
          best = j;
          break;
        }
      }
      const c = raw[best];
      pos.set(this.worldX(c % nx), this.floor[c], this.worldZ((c / nx) | 0));
      this._emit(out, count++, pos);
      anchor.copy(pos);
      i = best;
      if (count >= 32) break;
    }
    // finish on the exact goal if we can see it
    if (this.lineOfWalk(anchor, to) && count < 32) this._emit(out, count++, to);
    else if (count === 0) this._emit(out, count++, to);
    return count;
  }

  /** Is the straight segment walkable end to end? */
  lineOfWalk(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.65)));
    let prevY = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      const ix = this.cellX(x), iz = this.cellZ(z);
      if (!this.walkable(ix, iz)) return false;
      const y = this.floor[this.index(ix, iz)];
      if (Math.abs(y - prevY) > this.maxStep) return false;
      prevY = y;
    }
    return true;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

/**
 * A cover point: a spot to stand plus the direction the protection comes from.
 * `high` means the blocker stops a standing shot; otherwise it is crouch cover.
 * `peek` is a lateral offset that clears the edge for shooting.
 */
export class CoverMap {
  constructor(grid, physics) {
    this.grid = grid;
    this.physics = physics;
    this.points = [];
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this.buildMs = 0;
  }

  build(opts = {}) {
    const t0 = performance.now();
    const g = this.grid;
    const phys = this.physics;
    const MASK = phys.MASK.WORLD;
    const step = opts.step ?? 1; // sample every Nth cell
    const reach = opts.reach ?? 1.25;
    this.points.length = 0;
    for (let iz = 1; iz < g.nz - 1; iz += step) {
      for (let ix = 1; ix < g.nx - 1; ix += step) {
        if (!g.walkable(ix, iz)) continue;
        const i = g.index(ix, iz);
        // Cover a bot cannot walk to is not cover, it is a trap: `_combat` reads
        // "picked a point, cannot route to it" as a reason to drop the point and
        // pick again, and stands still while it does. 256 of the 612 points this
        // used to emit were in pockets the floor cannot reach — mostly the
        // container roofs. See `NavGrid._buildComponents`.
        if (!g.inMainComponent(i)) continue;
        if (g.enclosure[i] === 0) {
          // still allow cover next to a blocked cell (thin props, sandbags)
          let adj = false;
          for (let d = 0; d < 4 && !adj; d++) {
            if (!g.walkable(ix + DX[d], iz + DZ[d])) adj = true;
          }
          if (!adj) continue;
        }
        const x = g.worldX(ix), z = g.worldZ(iz), y = g.floor[i];
        // find the strongest blocking direction at chest and knee height
        for (let d = 0; d < 8; d++) {
          const dx = DX[d] / (d < 4 ? 1 : SQRT2);
          const dz = DZ[d] / (d < 4 ? 1 : SQRT2);
          const low = phys.raycast(x, y + 0.55, z, dx, 0, dz, reach, MASK);
          if (!low.hit) continue;
          const high = phys.raycastAny(x, y + 1.32, z, dx, 0, dz, reach, MASK);
          // must be able to shoot over/around: check a peek to both sides
          this.points.push({
            x, y, z,
            dx, dz, // direction the cover faces (toward the blocker)
            high,
            dist: low.distance,
            claimed: -1,
            score: 0,
          });
          break;
        }
      }
    }
    this.buildMs = performance.now() - t0;
    return this;
  }

  /**
   * Best cover for an agent at `pos` against a threat at `threat`.
   * Scoring, in order of weight: does the blocker actually sit between us and
   * the threat, is the spot a sensible distance from both, is it free, and does
   * a peek from it have line of sight (a hole to shoot through).
   */
  pick(pos, threat, opts = {}) {
    const wantMin = opts.minRange ?? 6;
    const wantMax = opts.maxRange ?? 26;
    const claimId = opts.id ?? -1;
    const squad = opts.squad ?? null;
    const maxTravel = opts.maxTravel ?? 22;
    const yRef = opts.yRef ?? null;
    const yTol = opts.yTol ?? Infinity;
    let best = null;
    let bestScore = -Infinity;
    const tx = threat.x, tz = threat.z;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (p.claimed >= 0 && p.claimed !== claimId) continue;
      const toThreatX = tx - p.x, toThreatZ = tz - p.z;
      const dT = Math.hypot(toThreatX, toThreatZ);
      if (dT < 2.5 || dT > 40) continue;
      const travel = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (travel > maxTravel) continue;
      if (yRef !== null && Math.abs(p.y - yRef) > yTol) continue;
      // protection: the blocker must be on the threat side
      const prot = (toThreatX / dT) * p.dx + (toThreatZ / dT) * p.dz;
      if (prot < 0.25) continue;
      let score = prot * 5 + (p.high ? 2.2 : 1.0);
      // range preference
      if (dT < wantMin) score -= (wantMin - dT) * 0.55;
      else if (dT > wantMax) score -= (dT - wantMax) * 0.28;
      score -= travel * 0.16;
      // do not bunch up
      if (squad) {
        for (const other of squad) {
          if (!other || other.id === claimId || !other.alive) continue;
          const d = Math.hypot(other.position.x - p.x, other.position.z - p.z);
          if (d < 3.2) score -= (3.2 - d) * 1.4;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best && claimId >= 0) {
      for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
      best.claimed = claimId;
    }
    return best;
  }

  release(claimId) {
    for (const p of this.points) if (p.claimed === claimId) p.claimed = -1;
  }

  /**
   * Where to lean out from a cover point to shoot: try both sides and pick the
   * one with line of sight from the eye to the threat.
   */
  peekOffset(cover, threat, eyeH, out) {
    const phys = this.physics;
    // lateral axis = perpendicular to the cover facing
    const lx = -cover.dz, lz = cover.dx;
    const from = this._v;
    const to = this._v2.set(threat.x, threat.y, threat.z);
    for (const s of [1, -1, 0]) {
      const px = cover.x + lx * 0.62 * s;
      const pz = cover.z + lz * 0.62 * s;
      from.set(px, cover.y + eyeH, pz);
      if (phys.lineOfSight(from, to, phys.MASK.SIGHT)) {
        out.set(px, cover.y, pz);
        return s;
      }
    }
    out.set(cover.x, cover.y, cover.z);
    return 0;
  }
}
