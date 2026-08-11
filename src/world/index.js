/**
 * WORLD — the level.
 *
 * This subsystem owns nothing but the wiring: the map itself is authored in
 * `warehouse.js` against an `Assembler`, which merges everything down to a
 * handful of draw calls and authors collision separately from the visual mesh.
 * That separation is why a doorway is a real hole in the collision hull and the
 * BVH stays in the low thousands of triangles.
 *
 * Published contract — every other subsystem meets the map here:
 *
 *   world.bounds                 THREE.Box3, playable area in world space.
 *                                `ai` sizes its nav grid from this.
 *   world.spawnPoints            [{ position, yaw, team, tag }]
 *                                `team` is what makes round-based play possible;
 *                                'alpha' | 'bravo' | null (neutral).
 *   world.spawn(i)               one of the above, index wrapped.
 *   world.spawnsFor(team)        every spawn belonging to a team.
 *   world.roomVolumes            coarse interior boxes, pushed to `render`.
 *
 * The level is authored directly in world space, so there is no level->world
 * transform and none is published.
 */

import * as THREE from 'three';
import { Assembler } from './builder.js';
import { buildWarehouse, SPAWNS, HALL } from './warehouse.js';

export class WorldSystem {
  static id = 'world';
  static deps = ['materials', 'physics'];

  /**
   * Snapshot classification (netcode step 5). Every own field must appear in
   * exactly one of these; `tools/replay.mjs` fails on one that appears in
   * neither, in both, or that no longer exists on the instance.
   *
   * The level is the one subsystem with nothing to rewind. It is assembled once
   * in `init` and never mutated after — the collision BVH, the spawn points and
   * the room volumes are all read-only from the first tick onward. That is a
   * claim the gate now holds this file to rather than a sentence in a document:
   * add a mutable field and the audit will refuse to classify it for you.
   */
  static snapshotState = [];
  static excludedState = ['ctx', 'group', 'assembler', 'spawnPoints', 'bounds', 'roomVolumes'];

  /** Nothing to capture — see `snapshotState`. The hook exists so the gate can
   *  tell "frozen by design" apart from "not done yet". */
  captureState(out = {}) {
    return out;
  }

  restoreState() {}

  async init(ctx) {
    this.ctx = ctx;
    const materials = ctx.get('materials');
    const physics = ctx.get('physics');
    // `snapshot: false` even though this stream is simulation by any reasonable
    // reading — the bake it drives decides what bullets hit. It is excluded
    // because it is spent here and never advanced again: the level is frozen
    // before the first tick, so rewinding to a tick can never need it back.
    // FIXED seed, not the root's phase. The warehouse must be the same
    // building in every boot and in every process — the nav grid, the cover
    // map and the bullet BVH are all baked from it, and a level that varies
    // with boot timing makes every one of those bakes a per-process fact.
    // `snapshot: false` is still right: frozen after boot, nothing rewinds.
    const rng = ctx.rng.fork({ snapshot: false, seed: 0x5eed1e7e });

    this.group = new THREE.Group();
    this.group.name = 'world';
    ctx.scene.add(this.group);

    const t0 = performance.now();
    const A = new Assembler({ materials, rng, render: ctx.peek('render') });
    const built = buildWarehouse(A, rng);
    A.finalize(this.group, physics);
    this.assembler = A;

    this.spawnPoints = SPAWNS.map(([x, z, yaw, team, tag]) => ({
      position: new THREE.Vector3(x, 0, z),
      yaw,
      team,
      tag,
    }));

    const hw = HALL.w * 0.5;
    const hd = HALL.d * 0.5;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-hw, -0.5, -hd),
      new THREE.Vector3(hw, HALL.h, hd)
    );

    // Push, don't be polled: render must not know this subsystem exists.
    this.roomVolumes = built.roomVolumes;
    ctx.peek('render')?.setRoomVolumes(this.roomVolumes);
    materials.setGroundLevel?.(0);

    const s = A.stats;
    console.info(
      `[world] warehouse ${HALL.w}x${HALL.d}m · ${s.drawCalls} draws · ` +
      `${(s.staticTris | 0).toLocaleString()} tris · ${(performance.now() - t0) | 0}ms`
    );
  }

  spawn(i = 0) {
    const n = this.spawnPoints.length;
    return this.spawnPoints[((i % n) + n) % n];
  }

  /** Every spawn belonging to `team`. Falls back to all spawns if none match. */
  spawnsFor(team) {
    const list = this.spawnPoints.filter((s) => s.team === team);
    return list.length > 0 ? list : this.spawnPoints;
  }

  update(dt, ctx) {
    this.assembler?.updateLod?.(ctx.camera);
  }

  dispose() {
    this.assembler?.dispose?.();
    this.group?.removeFromParent();
  }
}
