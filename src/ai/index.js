/**
 * AI — enemy characters, navigation, perception, cover selection and combat
 * behaviour.
 *
 * WHAT LIVES WHERE
 *   rig.js        25-bone skeleton, bind pose, weapon anchor points
 *   geo.js        loft/tube/revolve toolkit, skin binder, baked vertex AO
 *   parts.js      body and kit: jacket, plate carrier, pouches, helmet, boots
 *   weapon.js     the carried carbine / long rifle, baked into the character
 *   textures.js   tiling PBR sets: camo cloth, cordura, skin, polymer, steel
 *   soldier.js    variant assembly -> one skinned geometry + material list
 *   clips.js      hand-authored pose layers (idle/walk/run/crouch/hit/recoil…)
 *   animator.js   layered blending + aim, look-at, arm and foot IK
 *   nav.js        walkability grid from the physics BVH, A*, string pulling,
 *                 cover point extraction and scoring
 *   agent.js      one enemy: senses, state machine, gun, hit zones, death
 *   squad.js      peek rotation, contact sharing, flank and grenade rationing
 *
 * PUBLIC API — `const ai = ctx.get('ai')`
 *   ai.spawn(variant, position, yaw, opts) -> Agent, registered with `match`
 *   ai.populate({ perTeam })               fill both teams from world spawns
 *   ai.enemiesOf(agent)                    living enemy Combatants (REUSED array)
 *   ai.agents                              live Agent list
 *   ai.prewarmMaterials()                  await: build + compile every character
 *                                          shader without spawning anything
 *   ai.grid / ai.cover                     navigation + cover queries
 *   ai.stats                               { agents, alive, navMs, coverPts,
 *                                            pathsDeferred, lodIrrelevant }
 *
 * FRAME BUDGETS — navigation and the garrison are built during init(), not on
 * the first frame of play; A* is rationed to `ai.pathsPerFrame` solves per frame;
 * and an actor that provably cannot reach a pixel this frame (see
 * `_updateRelevance`) animates at a third rate and leaves the shadow cascades.
 *
 * EVENTS consumed: weapon:fire, bullet:impact, damage:dealt, explosion,
 *   player:footstep
 * EVENTS emitted: weapon:fire (enemy muzzle), weapon:shell, bullet:tracer,
 *   damage:dealt (enemy hitting the player), actor:death
 */

import * as THREE from 'three';
import { SoldierMaterials } from './textures.js';
import { buildSoldier, resolveMaterials, MATERIAL_SLOTS, VARIANTS } from './soldier.js';
import { RIG } from './rig.js';
import { NavGrid, CoverMap } from './nav.js';
import { Agent, STATE, aiYaw } from './agent.js';
import { Squad } from './squad.js';
import { GroundShadows } from './grounding.js';

/** Shared empty result for enemiesOf() before `match` exists. Never mutated. */
const EMPTY = Object.freeze([]);

/** Simulation tick for every bot, in Hz. See `AiSystem.fixedUpdate`. */
const AI_HZ = 60;
const AI_DT = 1 / AI_HZ;

export class AiSystem {
  static id = 'ai';
  static deps = ['physics', 'world', 'match'];

  async init(ctx) {
    this.ctx = ctx;
    this.match = ctx.get('match');
    this.rng = ctx.rng.fork();
    this.root = new THREE.Group();
    this.root.name = 'ai';
    ctx.scene.add(this.root);

    const t0 = performance.now();
    this.materials = new SoldierMaterials(this.rng.fork(), {
      size: 512,
      anisotropy: ctx.config.q.anisotropy ?? 8,
      camo: ['arid', 'woodland', 'urban'],
    });
    // Contact occlusion under every actor. Without it the cast shadow alone
    // leaves them hovering: see grounding.js.
    this.ground = new GroundShadows(this.root, 16);
    this._variants = new Map();
    this.agents = [];
    this.squads = [];
    this.grid = null;
    this.cover = null;
    this.inspect = false;
    this.debugLog = false;
    /** dev: force the garrison to spawn even in deterministic capture runs */
    this.forcePopulate = false;
    this._navPending = true;
    this.stats = { agents: 0, alive: 0, navMs: 0, coverPts: 0, walkable: 0 };

    /* scratch */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._probe = { y: 0, nx: 0, ny: 1, nz: 0, hit: false };
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._fireEvent = {
      weapon: 'ai_rifle',
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      seed: 0,
      // Sprites and light are gained SEPARATELY: see _flashGain/_flashLight.
      // The sprites have to read as fire at 25 m; the punctual light must not
      // turn the shooter into the brightest object in the frame.
      intensity: 0.12,
      light: 0.006,
      // Size is gained separately from radiance: a 0.12-intensity flash scaled
      // geometrically by 0.12 is 3 mm across and invisible at 20 m.
      flashScale: 0.8,
    };
    this._shellEvent = { position: new THREE.Vector3(), velocity: new THREE.Vector3() };
    this._tracerEvent = { from: this._tracerFrom, to: this._tracerTo, speed: 800 };
    this._grenades = [];
    this._grenadeGeo = null;
    this._grenadeMat = null;

    /* ---- frame budgets and LOD state (see _updateRelevance / requestPath) ---- */
    this._pathBudget = 0;
    this._aiAccum = 0;
    /**
     * A* solves allowed per frame.
     *
     * Upstream this was 2, measured against a 221x221 grid where one solve cost
     * 0.5-1.1 ms and a squad entering combat together asked for six at once.
     * This map's grid is 66x50 — about a twelfth of the cells — so the same
     * millisecond budget buys far more solves, and the old figure was actively
     * harmful: with both teams in combat, requests queued faster than they were
     * served and bots sat at `pathPending` with a cover point claimed and no
     * route to it, which the FSM reads as "moving into position" and answers by
     * holding fire. They stood still, weapons down, for the whole engagement.
     */
    this.pathsPerFrame = 8;
    this.stats.pathsDeferred = 0;
    this._frustum = new THREE.Frustum();
    this._mvp = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this._sweep = new THREE.Sphere();
    this._sun = new THREE.Vector3(0, 1, 0);
    this._lodStats = { irrelevant: 0 };

    this._wireEvents(ctx);
    console.info(
      `[ai] materials ${(performance.now() - t0).toFixed(0)}ms ` +
        `(${this.materials.bakeMs.toFixed(0)}ms texture bake)`
    );
    // The albedo budget is only real if it is measured. Print what every camo
    // bake actually landed on, so a drift out of 0.09-0.32 is visible in the
    // capture log instead of only in the critic's histogram.
    for (const k in this.materials.camoStats ?? {}) {
      const s = this.materials.camoStats[k];
      console.info(
        `[ai] camo ${k}: map mean ${s.mean.toFixed(3)} (was ${s.was.toFixed(3)}) ` +
          `range ${s.min.toFixed(3)}-${s.max.toFixed(3)} sd ${s.sd.toFixed(3)}`
      );
    }

    // Navigation, the garrison and every character shader, DURING BOOT.
    //
    // MEASURED, not guessed: all of this used to land on the first `update()`
    // after the player took control — 224 ms for the 221x221 walkability grid,
    // 19 ms for the cover map and 93/58/57 ms to build the three soldier
    // geometries the first three spawns ask for. One 450 ms freeze, on the frame
    // the player starts playing, plus five character programs compiling over the
    // frames after it (116-328 ms each).
    //
    // Doing it here is behaviour-identical rather than merely similar: no frame
    // has run yet, so `physics`, `world` and `player` are in exactly the state
    // the first update would have found them in, and the order of RNG draws —
    // which is what decides how every soldier is stitched together — is
    // unchanged. `update()` keeps the same code as a fallback for the case where
    // the collision world is not registered yet.
    this._bootNav(ctx);
    await this.prewarmMaterials();
  }

  /**
   * Build navigation and garrison the level at boot. Never throws: if physics
   * has no level yet, `_navPending` stays set and `update()` retries.
   */
  _bootNav(ctx) {
    try {
      this._buildNav();
      if (!this._navPending && (!ctx.config.deterministic || this.forcePopulate)) this.populate();
    } catch (err) {
      this._navPending = true;
      console.warn('[ai] boot nav deferred to the first frame:', err?.message ?? err);
    }
  }

  /**
   * Build every character material and force its shader program to compile,
   * WITHOUT spawning a gameplay object and WITHOUT drawing a frame.
   *
   * This is the hook `src/core/prewarm.js` documents as missing: its `transients`
   * pass reached the character programs by staging a firefight, which left actors
   * and decals behind and blew the pixel gate. Nothing here is a gameplay object.
   *
   *  - `resolveMaterials()` is a pure function of the variant name, so every
   *    material every variant will ever ask for can be created now. It draws no
   *    random numbers, so the RNG stream — and therefore the picture — is
   *    untouched. It MUST be handed `MATERIAL_SLOTS` in the builder's own order:
   *    three sorts opaque draws (including the nine groups inside one soldier) by
   *    the global `Material.id` counter, so creating them in any other order
   *    reorders those draws and flips the depth tie on coplanar surfaces. That is
   *    a measured 2-pixel gate failure, not a theory — see MATERIAL_SLOTS.
   *  - the programs are compiled against a throwaway scene holding ONE dummy
   *    SkinnedMesh. The permutation three compiles is decided by the material
   *    plus the object's features (skinning, vertex colours, uv) and the target
   *    scene's lights, so a 6-triangle stand-in with the real 25-bone skeleton
   *    and the real vertex attributes yields the same programs a soldier does.
   *  - the cascade depth variant is compiled too, by borrowing render's own
   *    override material: `compileAsync` only ever looks at `object.material`, so
   *    the skinned depth program is otherwise not reachable without rendering a
   *    shadow map.
   *
   * Idempotent and never throws — a failed prewarm just means the old stutter.
   */
  async prewarmMaterials() {
    if (this._prewarmed) return this._prewarmed;
    const t0 = performance.now();
    const out = { ok: false, materials: 0, programs: 0, ms: 0 };
    this._prewarmed = out;
    try {
      const mats = [];
      const seen = new Set();
      for (const name in VARIANTS) {
        for (const m of resolveMaterials(name, MATERIAL_SLOTS, this.materials, this._accentFor(name))) {
          if (m && !seen.has(m)) { seen.add(m); mats.push(m); }
        }
      }
      // the thrown grenade's mesh is built on the first throw, mid-firefight
      this._ensureGrenade();
      out.materials = mats.length + 1;

      const r = this.ctx.peek('render');
      if (r?.patcher) {
        for (const m of mats) r.patcher.patch(m);
        r.patcher.patch(this._grenadeMat);
      }
      const renderer = r?.renderer;
      if (!renderer) return out;
      const before = renderer.info.programs?.length ?? 0;

      const scene = new THREE.Scene();
      const { skeleton, root } = RIG.createSkeleton();
      const geo = this._dummySkinGeometry();
      const mesh = new THREE.SkinnedMesh(geo, mats);
      mesh.frustumCulled = false;
      scene.add(root);
      scene.add(mesh);
      mesh.bind(skeleton);

      const compile = async (target) => {
        try {
          await renderer.compileAsync(scene, this.ctx.camera, target);
        } catch {
          try { renderer.compile(scene, this.ctx.camera, target); } catch { /* driver */ }
        }
      };
      await compile(this.ctx.scene);
      // cascade depth: same object, render's own override material
      const depth = r.csm?.depthMaterial;
      if (depth) {
        mesh.material = depth;
        await compile(this.ctx.scene);
      }
      // The grenade is a plain (unskinned) mesh, so it needs its own object —
      // and it has to be warmed IN THE SCENE IT WILL BE DRAWN IN.
      //
      // This used to add it to the scratch scene above and compile that, passing
      // the real scene only as the environment argument. It was not enough. A
      // thrown grenade is parented to `this.root` in the live scene, and the
      // permutation three derives there is not the one the scratch scene
      // produced, so the first throw of the match still compiled a program on
      // the frame it happened. Measured on the production build: a 150-190 ms
      // stall inside `render.render`, `compiledDuringPlay: 1`, and `Mesh#240`
      // appearing the frame before — an `IcosahedronGeometry(0.045, 1)` has
      // exactly 240 vertices, which is what named it.
      //
      // Intermittent, because it needs a bot to actually throw one inside the
      // profiling window: it reproduced on two runs in three. That is also why
      // `?warmhidden=1` looked like a fix and was not — it "removed" the stall on
      // one run out of two by luck.
      //
      // Adding and removing an object around a compile draws nothing, so the
      // pixel gate is unaffected.
      //
      // NOT FULLY CLOSED. This removed the common case; a residue survives at
      // roughly one profile run in six — a ~140 ms frame with one late program,
      // caught and keyed:
      //
      //   frame 865  physical,STANDARD,...,ow-patch-9-4-2   every map flag false
      //
      // Mapless standard material is this grenade and nothing else in the build
      // (shells, decals and the kit all carry maps), and frame 865 of ~900 is a
      // first throw late in a firefight, so the attribution is solid.
      //
      // What is NOT established is why the warmed permutation does not match.
      // The leading candidate is the LIGHT COUNT: three bakes it into the
      // program key, this warm runs at boot with no muzzle flashes alive, and a
      // grenade first drawn while `fx.lights.flash` is lit needs a permutation
      // nothing has compiled. That would explain both the rarity and the timing.
      // It is a hypothesis and has not been tested — testing it needs the
      // program key captured at warm time as well as at the stall, which
      // `tools/profile.mjs` does not currently record.
      //
      // If it holds, the fix is probably not more warming (the count varies) but
      // giving the grenade a material that is already on screen all match — the
      // soldier `polymer` or `steel` set — so it inherits whatever permutation
      // the frame is already using.
      scene.remove(mesh);
      const g = new THREE.Mesh(this._grenadeGeo, this._grenadeMat);
      this.root.add(g);
      try {
        await renderer.compileAsync(this.ctx.scene, this.ctx.camera);
      } catch {
        try { renderer.compile(this.ctx.scene, this.ctx.camera); } catch { /* driver */ }
      }
      this.root.remove(g);

      geo.dispose();
      skeleton.dispose?.();
      out.programs = (renderer.info.programs?.length ?? 0) - before;
      out.ok = true;
    } catch (err) {
      out.error = String(err?.message ?? err);
    }
    out.ms = Math.round(performance.now() - t0);
    console.info(`[ai] prewarmMaterials ${JSON.stringify(out)}`);
    return out;
  }

  /**
   * A 2-triangle skinned stand-in carrying exactly the attributes a soldier's
   * geometry does — position, normal, uv, colour, skinIndex, skinWeight. Three
   * derives half of the shader permutation from the geometry's attributes, so
   * anything missing here would compile the wrong program.
   */
  _dummySkinGeometry() {
    const g = new THREE.BufferGeometry();
    const n = 3;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) w[i * 4] = 1;
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    return g;
  }

  /* ================================================================== */
  /* events                                                             */
  /* ================================================================== */

  _wireEvents(ctx) {
    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));

    on('weapon:fire', (e) => {
      if (!e || !e.origin || e.weapon === 'ai_rifle') return; // ignore our own
      // A gunshot is the loudest thing in the level: everybody hears it, and
      // anyone near the line of fire also feels suppressed by it.
      for (const a of this.agents) {
        if (!a.alive) continue;
        a.hear(e.origin, 90);
        if (e.dir) {
          const d = this._distanceToRay(a.position, e.origin, e.dir, a.eyeHeight);
          if (d < 2.6) a.suppress(0.45 * (1 - d / 2.6) + 0.12);
        }
      }
    });

    on('bullet:impact', (e) => {
      if (!e || !e.point) return;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.point);
        if (d < 3.2) a.suppress(0.5 * (1 - d / 3.2));
        else if (d < 12) a.hear(e.point, 12);
      }
    });

    on('damage:dealt', (e) => {
      if (!e || !(e.target instanceof Agent)) return;
      const a = e.target;
      if (!a.alive) return;
      // No distance falloff here any more. Upstream, damage was scaled by how
      // far the impact was from the PLAYER — a camera-relative fudge that made
      // a firefight at the far end of the map cheaper than the same firefight
      // in front of you. In a team game where bots trade with bots out of the
      // player's sight, that turns a bystander into a damage multiplier. Range
      // falloff belongs to the round's own dropoff curve, which the ballistics
      // solver has already applied by the time this fires.
      a.applyDamage(e.amount, e.from ?? null, {
        part: e.headshot ? 'head' : e.part ?? 'torso',
        point: e.point ?? a.position,
        dir: e.incident,
        source: e.source ?? null,
      });
      if (!a.alive) e.killed = true;
    });

    on('explosion', (e) => {
      if (!e || !e.position) return;
      const radius = e.radius ?? 5;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.position) + 0.001;
        a.hear(e.position, 120);
        if (d > radius) continue;
        if (this.phys && !this.phys.lineOfSight(e.position, a.eye, this.phys.MASK.EXPLOSION)) continue;
        const f = 1 - d / radius;
        this._v.copy(a.position).sub(e.position).normalize();
        a.suppress(1.4 * f);
        // Signature: (amount, fromVec3, opts). This call was left on the OLD
        // four-positional form when `Agent.applyDamage` changed in M4, so a
        // grenade kill passed the string 'torso' where a position belongs; it
        // reached `die()` as the impact point, and `fx.onActorDeath` then asked
        // physics for the ground height under `'torso'.x`. Sixty-three thrown
        // handlers in one match, none of them visible on screen — a grenade
        // just quietly failed to leave a blood decal.
        a.applyDamage((e.damage ?? 100) * f * f, a.eye, {
          part: 'torso',
          point: a.eye,
          dir: this._v,
          source: e.source ?? null,
        });
      }
    });

    on('player:footstep', (e) => {
      if (!e || !e.position) return;
      const loud = e.running ? 24 : 11;
      for (const a of this.agents) if (a.alive) a.hear(e.position, loud);
    });
  }

  _distanceToRay(point, origin, dir, eyeH) {
    const px = point.x - origin.x;
    const py = point.y + eyeH * 0.7 - origin.y;
    const pz = point.z - origin.z;
    const t = Math.max(0, px * dir.x + py * dir.y + pz * dir.z);
    return Math.hypot(px - dir.x * t, py - dir.y * t, pz - dir.z * t);
  }

  /* ================================================================== */
  /* assets                                                             */
  /* ================================================================== */

  /**
   * Team accent for a variant, as an [r, g, b] triple, or null.
   *
   * `match` owns the team colours and `ai` must not import them (hard rule 1),
   * so the lookup runs the other way: find the team whose uniform this variant
   * is. One variant per team makes that unambiguous, and a variant no team wears
   * (`irregular`) correctly gets nothing.
   *
   * The same colour drives the HUD, the killfeed and the spawn bay paint, so a
   * player learns one blue and one red rather than four.
   */
  _accentFor(name) {
    // Dev hook: strip the team colour and change nothing else, so
    // `tools/friendfoe.mjs --noaccent` can measure what that gate reads with no
    // accent at all. That control is the only thing that makes its threshold
    // defensible rather than decorative — it is what showed the two variants are
    // 0.0024 apart on their own. Same idea and same spelling as
    // `window.__NO_FLASH_LIGHT__` in `tools/legibility.mjs`.
    if (typeof window !== 'undefined' && window.__NO_ACCENT__) return null;
    const team = this.match.TEAM_IDS.find((t) => this.match.TEAMS[t].variant === name);
    if (!team) return null;
    const hex = this.match.TEAMS[team].color;
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  variant(name) {
    // Keyed by variant name alone: the accent is a pure function of the name via
    // `_accentFor`, so two calls can never disagree about the same key.
    let v = this._variants.get(name);
    if (!v) {
      const t0 = performance.now();
      v = buildSoldier(name, {
        rng: this.rng.fork(),
        materials: this.materials,
        accent: this._accentFor(name),
      });
      this._variants.set(name, v);
      // Hand the new materials to render immediately rather than waiting for its
      // scene walk: they are all MeshStandardMaterial, so the patcher injects the
      // CSM sun shadow, the screen-space contact shadow, GTAO and the bounce fill
      // into them. Without the shadow term a character is lit by ambient alone
      // and looks pasted onto the ground.
      const r = this.ctx.peek('render');
      if (r?.patcher) for (const m of v.materials) r.patcher.patch(m);
      console.info(
        `[ai] variant "${name}" ${v.stats.triangles | 0} tris / ${v.stats.vertices} verts / ` +
          `${v.materials.length} materials in ${(performance.now() - t0).toFixed(0)}ms`
      );
    }
    return v;
  }

  /** Bone index lookup for the shared rig (used by the ragdoll spec). */
  rigIndex(name) {
    return RIG.index(name);
  }

  get phys() {
    return this._phys ?? (this._phys = this.ctx.peek('physics'));
  }

  /* ================================================================== */
  /* navigation                                                         */
  /* ================================================================== */

  _buildNav() {
    const phys = this.phys;
    const world = this.ctx.peek('world');
    if (!phys) return;
    if (phys.staticWorld.dirty) phys.rebuildStatic();
    if (phys.triangleCount <= 0) return; // level not registered yet — retry next frame
    const bounds =
      world?.bounds?.clone?.() ??
      new THREE.Box3(new THREE.Vector3(-70, -4, -70), new THREE.Vector3(70, 24, 70));
    // Horizontally only. `expandByScalar` grows Y as well, which lifts the
    // grid's floor probe above an interior's roof — see NavGrid's `topY`. The
    // horizontal margin is worth having (it catches walkable ground just past
    // the authored bounds); the vertical one buys nothing and breaks ceilings.
    bounds.min.x -= 2; bounds.max.x += 2;
    bounds.min.z -= 2; bounds.max.z += 2;
    const t0 = performance.now();
    this.grid = new NavGrid(phys, { bounds, cell: 0.8, radius: 0.36, height: 1.78 });
    this.grid.build();
    this.cover = new CoverMap(this.grid, phys);
    this.cover.build({ step: 1, reach: 1.3 });
    this.stats.navMs = performance.now() - t0;
    this.stats.coverPts = this.cover.points.length;
    this.stats.walkable = this.grid.walkableCount;
    this._navPending = false;
    console.info(
      `[ai] nav ${this.grid.nx}x${this.grid.nz} cells · ${this.grid.walkableCount} walkable · ` +
        `${this.cover.points.length} cover points · ${this.stats.navMs.toFixed(0)}ms`
    );
  }

  /** Floor probe used by foot IK and spawning. */
  probeGround(x, z, fromY, out) {
    const phys = this.phys;
    if (!phys) return false;
    const h = phys.raycast(x, fromY, z, 0, -1, 0, 3.2, phys.MASK.WORLD);
    if (!h.hit) return false;
    out.y = h.point.y;
    out.nx = h.normal.x;
    out.ny = h.normal.y;
    out.nz = h.normal.z;
    out.hit = true;
    return true;
  }

  groundAt(x, z, fromY = 40) {
    const phys = this.phys;
    if (!phys) return 0;
    const h = phys.raycast(x, fromY, z, 0, -1, 0, 80, phys.MASK.WORLD);
    if (h.hit) return h.point.y;
    return this.ctx.peek('world')?.groundHeight?.(x, z) ?? 0;
  }

  /**
   * Living enemies of `agent`, as Combatants.
   *
   * This replaces `playerPosition()`, which was the single most consequential
   * line in the old AI: it hardcoded "there is one enemy and it is the camera".
   * Everything downstream — perception, cover scoring, flanking, grenades — was
   * written against that assumption without ever naming it.
   *
   * The returned array belongs to `match` and is REUSED between calls. Iterate
   * it now; never store it.
   */
  enemiesOf(agent) {
    const match = this.match;
    if (!match) return EMPTY;
    return match.enemiesOf(agent.combatant ?? agent);
  }

  /* ================================================================== */
  /* spawning                                                           */
  /* ================================================================== */

  /**
   * Build one bot and enlist it. `opts.team` decides which side it fights for
   * and which camo it wears; both come from the same `match` table, so a bot
   * cannot end up dressed as one team and scored as the other.
   */
  spawn(variantName, position, yaw = 0, opts = {}) {
    const a = new Agent(this, { variant: variantName, position, yaw, ...opts });
    this.agents.push(a);
    // `rig: 'host'` — the agent already owns bone-welded hitbox capsules and
    // keeps them on the animated skeleton. See match/combatant.js.
    a.combatant = this.match.register(a, {
      team: a.team,
      name: opts.name ?? `${a.team === 'alpha' ? 'A' : 'B'}-${a.id}`,
      rig: 'host',
    });
    return a;
  }

  /**
   * Fill both teams from the world's own team spawn points.
   *
   * The version this replaces ranked spawn points by distance FROM THE PLAYER
   * and took the far half, so that enemies were "found rather than spawned on
   * top of". That is exactly the right instinct for a single-player sandbox and
   * exactly wrong here: in a symmetric map the two ends belong to the two teams,
   * and a garrison that positions itself relative to one particular fighter
   * would put half of bravo inside alpha's spawn the moment the player is a
   * member of alpha rather than an intruder.
   *
   * `world.spawnsFor(team)` is the whole assignment now. The player occupies one
   * alpha slot, so alpha fields one fewer bot — `opts.perTeam` counts fighters,
   * not bots, which is the number a scoreboard has to agree with.
   */
  populate(opts = {}) {
    const world = this.ctx.peek('world');
    if (!world || !this.grid) return 0;

    const perTeam = opts.perTeam ?? 4;
    let made = 0;

    for (const team of this.match.TEAM_IDS) {
      // One variant per team, so a side reads as one uniform. See match/teams.js.
      const variant = this.match.TEAMS[team].variant;
      const spawns = world.spawnsFor(team);
      if (!spawns.length) continue;
      // A top-up, not a fill: count EVERY seat already held on this side, bots
      // included. Counting only non-bots made a second call double the roster
      // instead of completing it, which matters the moment anything wants to
      // reinforce a team mid-match rather than build one from nothing.
      const taken = this.match.combatants.filter((c) => c.team === team).length;
      const want = Math.max(0, perTeam - taken);
      if (!want) continue;

      const squad = this.createSquad();
      // Patrol route: every spawn point this team owns, so an idle bot walks its
      // own half of the map instead of wandering into the enemy's.
      const route = spawns.map((s) => s.position.clone());

      for (let m = 0; m < want; m++) {
        const anchor = spawns[m % spawns.length];
        const p = this._scatter(anchor, m);
        const a = this.spawn(variant, p, aiYaw(anchor.yaw) + this.rng.signed() * 0.35, {
          patrol: route,
          team,
        });
        squad.add(a);
        made++;
      }
    }
    console.info(
      `[ai] roster: ${made} bots · alpha ${this.match.aliveCount('alpha')} ` +
      `vs bravo ${this.match.aliveCount('bravo')}`
    );
    return made;
  }

  /**
   * A standable point near `anchor`, jittered so a team does not stack on one
   * tile. Snapped to the nav grid, because a spawn the pathfinder does not
   * believe in is a bot that never takes a step.
   */
  _scatter(anchor, seed) {
    const ang = this.rng.range(0, Math.PI * 2);
    const rad = this.rng.range(0.6, 2.4);
    const p = new THREE.Vector3(
      anchor.position.x + Math.cos(ang) * rad,
      anchor.position.y,
      anchor.position.z + Math.sin(ang) * rad
    );
    const ci = this.grid.nearest(p.x, p.z, anchor.position.y, 6, 1.4);
    if (ci >= 0) {
      p.set(
        this.grid.worldX(ci % this.grid.nx),
        this.grid.floor[ci],
        this.grid.worldZ((ci / this.grid.nx) | 0)
      );
    } else {
      p.y = this.groundAt(p.x, p.z, anchor.position.y + 4);
    }
    return p;
  }

  createSquad() {
    const s = new Squad(this.rng.fork());
    this.squads.push(s);
    return s;
  }

  /* ================================================================== */
  /* firing                                                             */
  /* ================================================================== */

  /** 0 at night, 1 in full daylight. Drives both flash gains below. */
  _daylight() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    const alt = sky?.sunAltitude ?? 0.6; // radians above the horizon
    return Math.min(1, Math.max(0, Math.sin(Math.max(0, alt)) * 4));
  }

  /**
   * SPRITE gain. The flash itself has to be *visible* — a firefight with no fire
   * in it is not a firefight — so this stays high enough to read as burning gas
   * at 10-25 m and is only trimmed in daylight, where the sun is competing.
   */
  _flashGain() {
    return 0.12 + 0.5 * (1 - this._daylight());
  }

  /**
   * LIGHT gain, deliberately separate and two orders of magnitude smaller.
   *
   * The crown sits 0.6 m from the shooter's own chest, so a player-strength
   * 90 cd flash puts 90/0.36 = 250 W/m^2 on him against 4 W/m^2 of sun. That is
   * the whole reason the soldiers used to render BRIGHTER than the sunlit stucco
   * behind them: they were being lit, on the frame the shutter fell, by their own
   * muzzle flash. A real flash is ~1 ms inside a 16 ms frame, so the honest
   * time-averaged contribution in daylight is a highlight on the receiver and
   * nothing more; after dark it is the only light there is and gets to earn its
   * keep. Measured: torso 0.44 -> 0.13 linear, i.e. from 1.9x the sunlit wall to
   * 0.55x, which is what an 0.19-albedo uniform in shade should be.
   */
  _flashLight() {
    const day = this._daylight();
    return 0.006 + 0.05 * (1 - day);
  }

  onAgentFire(agent, origin, dir) {
    const ctx = this.ctx;
    const phys = this.phys;

    // muzzle flash, light and smoke come from fx via the canonical event
    const fe = this._fireEvent;
    fe.origin.copy(origin);
    fe.dir.copy(dir);
    fe.intensity = this._flashGain();
    fe.light = this._flashLight();
    fe.flashScale = 0.8;
    fe.seed = (agent.id * 2654435761 + ctx.time.frame) >>> 0;
    ctx.events.emit('weapon:fire', fe);

    // ejected case
    const se = this._shellEvent;
    se.position.copy(agent.animator.ejectWorld);
    se.velocity.set(dir.z, 0.55, -dir.x).multiplyScalar(2.1).addScaledVector(dir, -0.6);
    ctx.events.emit('weapon:shell', se);

    // the round itself
    let end = null;
    if (phys) {
      // `source` is what makes the round attributable and what excludes the
      // shooter's own hitboxes from its own trace. With that in place there is
      // no second code path: this one call is how a bot hits a bot AND how a bot
      // hits the player.
      // Falloff matched to the player's carbine (dropoff 0.82 over 55 m, see
      // weapons/defs.js). Without it a bot's round defaulted to a 200 m curve,
      // which on a 36 m map is flat — so bots did full damage at every range
      // while the player's SMG dropped to 60% at 25 m. Two sets of physics for
      // the same fight is the one thing a bot game cannot afford.
      //
      // `maxDist` stays long: it bounds the raycast, not the damage. Making it
      // 55 would stop bot rounds from reaching the far wall.
      const impacts = phys.fireBullet({
        origin,
        dir,
        damage: agent.weaponDamage,
        penetration: 0.9,
        dropoff: 0.82,
        falloffRange: 55,
        maxDist: 200,
        source: agent,
        mask: phys.MASK.BULLET,
      });
      if (impacts.length) end = impacts[0].point;
    }

    this._tracerFrom.copy(origin);
    if (end) this._tracerTo.copy(end);
    else this._tracerTo.copy(origin).addScaledVector(dir, 120);
    if ((agent.id + agent.ammo) % 3 === 0) ctx.events.emit('bullet:tracer', this._tracerEvent);
  }

  emitReload(agent) {
    this.ctx.events.emit('weapon:reload', { weapon: 'ai_rifle', phase: 'start', actor: agent });
  }

  /** Grenade geometry + material. Built at prewarm, not on the first throw. */
  _ensureGrenade() {
    if (this._grenadeGeo) return;
    this._grenadeGeo = new THREE.IcosahedronGeometry(0.045, 1);
    this._grenadeMat = new THREE.MeshStandardMaterial({
      color: 0x2c3226,
      roughness: 0.62,
      metalness: 0.85,
    });
  }

  throwGrenade(agent, from, target) {
    const phys = this.phys;
    if (!phys) return;
    this._ensureGrenade();
    const mesh = new THREE.Mesh(this._grenadeGeo, this._grenadeMat);
    this.root.add(mesh);
    // lobbed ballistic solve
    const dx = target.x - from.x, dz = target.z - from.z;
    const dist = Math.max(0.5, Math.hypot(dx, dz));
    const g = Math.abs(phys.gravity);
    const speed = Math.min(18, Math.sqrt(Math.max(4, (dist * g) / 0.95)));
    const vy = speed * 0.62;
    const vh = Math.min(speed, dist / Math.max(0.35, (2 * vy) / g));
    const body = phys.addRigidBody({
      shape: 'sphere',
      radius: 0.05,
      mass: 0.42,
      position: from,
      velocity: { x: (dx / dist) * vh, y: vy, z: (dz / dist) * vh },
      restitution: 0.28,
      friction: 0.7,
      lifetime: 9,
      object3D: mesh,
      surfaceType: 'metal',
    });
    this._grenades.push({ body, mesh, fuse: 2.35, agent });
    agent.animator.fire(0.35);
  }

  _updateGrenades(dt) {
    for (let i = this._grenades.length - 1; i >= 0; i--) {
      const g = this._grenades[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;
      const p = g.body?.position ?? g.mesh.position;
      this.ctx.events.emit('explosion', {
        position: new THREE.Vector3(p.x, p.y, p.z),
        radius: 6.5,
        damage: 120,
        source: g.agent,
      });
      this.phys?.removeRigidBody(g.body);
      this.root.remove(g.mesh);
      this._grenades.splice(i, 1);
    }
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  /**
   * SIMULATION TICK — fixed rate, independent of the frame rate.
   *
   * The bots used to think on the render frame, which the engine's own comment
   * described as where "AI decisions" belong. For a single-player client that is
   * merely untidy; it stops being untidy the moment anything cares that two
   * machines agree. A bot's reaction time, its burst cadence and how far it
   * walks between decisions were all scaled by however long the last frame took,
   * so the same build produced a different fight at 13 fps than at 57 — and this
   * machine produced both today.
   *
   * It also made the harnesses noisy in a way that cost real time to chase:
   * `botfight` runs differed by an order of magnitude in rounds fired, and round
   * length varied 42 s to 94 s on identical code.
   *
   * `AI_HZ` rather than the physics rate: 120 Hz thinking would roughly double
   * the cost of the most expensive subsystem here to no benefit, since nothing
   * in the state machine resolves faster than a perception tick. The accumulator
   * makes the rate a property of `ai`, not of whatever `FIXED_DT` happens to be.
   *
   * One step per fixed frame at most. Letting it catch up in a loop would turn a
   * hitch into a burst of AI work, which is how a hitch becomes a stall.
   */
  fixedUpdate(h, ctx) {
    if (this._navPending || !this.match) return;
    this._aiAccum += h;
    if (this._aiAccum < AI_DT) return;
    this._aiAccum = Math.min(this._aiAccum - AI_DT, AI_DT);
    const dt = AI_DT;

    // A* budget is per SIMULATION tick now, not per rendered frame — otherwise
    // the ration a bot gets depends on how fast the machine draws.
    this._pathBudget = this.pathsPerFrame;

    for (const s of this.squads) s.update(dt);

    // Freeze time, pushed down once per frame rather than polled per agent.
    // `match` is the authority; an Agent only ever sees a boolean, which is why
    // agent.js contains no reference to rounds at all.
    const frozen = this.match.frozen;

    let alive = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.alive) {
        a.frozen = frozen;
        a.simulate(dt, ctx);
        alive++;
      } else if (a.deadTime !== undefined) {
        a.deadTime += dt;
        if (this.debugLog && a.ragdoll && !a._loggedDoll && a.deadTime > 1.2) {
          a._loggedDoll = true;
          const b = a.ragdoll.aabb;
          console.info(
            `[ai] ragdoll ${a.id} settled: ${(b.maxx - b.minx).toFixed(2)} x ` +
              `${(b.maxy - b.miny).toFixed(2)} x ${(b.maxz - b.minz).toFixed(2)} m ` +
              `at y=${b.miny.toFixed(2)} sleeping=${a.ragdoll.sleeping}`
          );
        }
      }
    }
    this._updateGrenades(dt);
    this.stats.agents = this.agents.length;
    this.stats.alive = alive;
    // Grid-snap recoveries since boot — see `_unstick` in agent.js. Visible to
    // a player when it fires, so it is worth being able to see the count.
    this.stats.snapUnsticks = this.snapUnsticks ?? 0;
  }

  /**
   * PRESENTATION — once per rendered frame.
   *
   * Relevance is decided here and not on the simulation tick because it is a
   * question about the CAMERA (see `_updateRelevance`), and the camera only has
   * a final transform once per frame. Skinning follows it for the same reason.
   */
  update(dt, ctx) {
    if (this._navPending) {
      this._buildNav();
      // Populate the level for normal play. Capture runs stay empty unless a
      // shot asks for a tableau, so nobody's screenshot gets a stray patrol
      // wandering through it.
      if (!this._navPending && (!ctx.config.deterministic || this.forcePopulate)) this.populate();
    }
    this._updateRelevance(ctx);
    for (let i = 0; i < this.agents.length; i++) this.agents[i].present(dt);
  }

  lateUpdate() {
    const g = this.ground;
    g.begin();
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.syncHitboxes();
      // Dead men keep their contact: a ragdoll on the floor needs it most.
      g.addActor(a);
    }
    g.end();
  }

  /* ================================================================== */
  /* frame budgets and LOD                                              */
  /* ================================================================== */

  /**
   * A* on the shared grid, rationed. Returns the waypoint count, or -1 when this
   * frame's budget is spent — the caller keeps its old path and asks again next
   * frame, which is invisible at 60 Hz and turns a squad-wide repath (six solves,
   * ~5 ms, on the frame the player opens fire) into two solves per frame.
   */
  requestPath(from, dest, out) {
    if (!this.grid) return 0;
    if (this._pathBudget <= 0) {
      this.stats.pathsDeferred++;
      return -1;
    }
    this._pathBudget--;
    return this.grid.findPath(from, dest, out);
  }

  /** Unit vector pointing AT the sun, however the sky exposes itself. */
  _sunDirection() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    const d = sky?.sunDirection;
    if (d && Number.isFinite(d.x)) this._sun.copy(d);
    else this._sun.set(0.3, 0.8, 0.4);
    if (this._sun.lengthSq() < 1e-8) this._sun.set(0, 1, 0);
    return this._sun.normalize();
  }

  /**
   * Decide, per actor, whether anything it does this frame can reach a pixel.
   *
   * An actor is IRRELEVANT only when both of these hold:
   *   1. its (already 1.45x inflated) bounding sphere, grown by a further 4 m,
   *      misses the camera frustum — so it is not drawn, and no screen-space
   *      effect can sample it either, because it is not in the depth buffer;
   *   2. the volume its sun shadow could possibly darken misses the frustum too.
   *      For a directional light that volume is exactly the actor's sphere swept
   *      along -sunDir: a visible surface can only be shadowed by this actor if
   *      the ray from that surface toward the sun passes through it. Sweeping to
   *      where the ray leaves the level below the floor covers every receiver,
   *      ground or wall, and the 4 m of slack absorbs both the soft-shadow filter
   *      radius (up to ~1 m of cascade texels) and a frame of camera motion.
   *
   * Irrelevant actors animate at a third of the rate and are dropped from the
   * shadow cascades (`userData.owNoShadow`, which render honours per frame). They
   * are still simulated, still shootable, still make noise — only the parts that
   * can exclusively affect pixels are skipped.
   */
  _updateRelevance(ctx) {
    const cam = ctx.camera;
    this._mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._mvp);
    const sun = this._sunDirection();
    // how far a shadow ray can travel before it is under the level
    const floorY = (this.grid ? -6 : -20);
    const sunY = Math.max(0.06, sun.y);
    let irrelevant = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const geo = a.mesh.geometry;
      const bs = geo.boundingSphere;
      if (!bs) { a.lodIrrelevant = false; continue; }
      const s = this._sphere.copy(bs).applyMatrix4(a.mesh.matrixWorld);
      s.radius += 4;
      let visible = this._frustum.intersectsSphere(s);
      if (!visible) {
        const sweep = this._sweep;
        const tMax = Math.min(320, (s.center.y - floorY) / sunY);
        const step = Math.max(2, s.radius * 0.9);
        sweep.radius = s.radius;
        for (let t = step; t <= tMax; t += step) {
          sweep.center.copy(s.center).addScaledVector(sun, -t);
          if (this._frustum.intersectsSphere(sweep)) { visible = true; break; }
        }
      }
      a.lodIrrelevant = !visible;
      if (!visible) irrelevant++;
      a.mesh.userData.owNoShadow = !visible;
    }
    this._lodStats.irrelevant = irrelevant;
    this.stats.lodIrrelevant = irrelevant;
  }

  /* ================================================================== */
  /* NOTE: the staged-tableau block used to live here.                   */
  /*                                                                     */
  /* `_updateStaged`, `_stageSlot`, `debugStage` and `_stageInspect` —   */
  /* about 220 lines that pinned bots into photogenic positions relative */
  /* to the capture camera so screenshots had a firefight in them. All   */
  /* of it was built on `playerPosition()`, and all of it teleported     */
  /* agents. In a round-based team game the spawns are authored, the two */
  /* teams have to start where the map says, and a debug hook that moves */
  /* fighters for the camera is not a debug hook any more — it is a way  */
  /* to silently invalidate every match the harness runs. Deleted.       */
  /* ================================================================== */
  /* ================================================================== */

  dispose() {
    for (const off of this._off ?? []) off();
    for (const a of this.agents) a.dispose();
    this.agents.length = 0;
    this.squads.length = 0;
    for (const g of this._grenades) {
      this.phys?.removeRigidBody(g.body);
      this.root.remove(g.mesh);
    }
    this._grenades.length = 0;
    this._grenadeGeo?.dispose();
    this._grenadeMat?.dispose();
    this.ground?.dispose();
    for (const v of this._variants.values()) v.geometry.dispose();
    this._variants.clear();
    this.materials?.dispose();
    this.root.parent?.remove(this.root);
  }
}

export { VARIANTS, STATE };
