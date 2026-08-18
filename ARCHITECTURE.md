# SUDDEN DEFENCE — engine contract

**Read this before writing code. It is the only coordination mechanism.**

A browser FPS: round-based team elimination against bots. WebGL2 + Three.js r185,
no external art assets — every texture, mesh, animation and sound is generated
procedurally at load time. No netcode; both teams are filled locally.

The engine layer is ported from a Call of Duty-style sandbox shooter. The port was
possible *only* because that project actually kept the rules below — there was not
one `import` from the engine layer into gameplay. Keep them, or the next port out
of this codebase will be impossible.

## Hard rules

1. **You own your directory. Never edit files outside it.**
2. **Never import another subsystem's module.** Get it at runtime:
   `const fx = ctx.get('fx')`. This is what makes parallel work safe, and it is
   what let 31k lines of engine move here untouched.
3. **The engine layer must never reach into gameplay.** `render`, `materials`,
   `sky`, `physics`, `fx`, `audio` and `core` must not name `world`, `player`,
   `weapons`, `ai`, `ui` or `match` — not even through `peek()`. When the engine
   needs something gameplay knows, gameplay **pushes** it:
   `render.setRoomVolumes(...)`, `fx.setMuzzleTransform(...)`. Never the reverse.
4. **No new npm dependencies.** `three` only. No CDN fetches, no external
   images/HDRIs/models/audio files — the game must run fully offline.
5. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` (see
   `src/core/rng.js`) or a `ctx.rng.fork()` you keep. Capture reproducibility
   depends on it, and so does the deterministic spray pattern.
6. **Allocate nothing per-frame.** Preallocate vectors, matrices and arrays in
   `init()` and reuse. A `new THREE.Vector3()` inside `update()` is a bug.
7. **Edge queries only in `update()`.** `input.pressed` / `input.released` are
   frame-scoped; reading them from `fixedUpdate()` misses or double-counts.
   If you want an edge on the fixed step, do not solve it locally — read
   `ctx.commands.current` instead. `core/command.js` folds every frame's presses
   into the next tick's command, so nothing is dropped at 240 fps and nothing is
   counted twice at 60. See **The command stream** below.
8. **Bots are pooled, never registered.** Spawn/despawn happens inside a
   subsystem's own pool. Adding or removing *systems* at runtime invalidates the
   Registry's method cache and is not supported.
9. **Dispose what you create.** Geometries, materials, textures and render
   targets get freed in `dispose()`.
10. `npm run build` must pass and `node tools/capture.mjs --shot=boot` must
    produce a frame after your change. If you break the boot, nobody else can work.

## File size

**800 lines is the working limit, and eleven files are over it on purpose.**

Twenty-six were over when this was written down. Fifteen came apart cleanly,
because the number was reporting a real problem: several unrelated concerns
sharing a file. `weapons/parts.js` was 2,073 lines of barrel, receiver,
furniture, magazine and optics; `world/props.js` was forty prop builders and a
registry. Those are now six files each, and every consumer's import list says
which part of the subsystem it actually depends on.

The other eleven are over the limit because ONE CLASS FILLS THE FILE:

| file | lines | the class | |
|---|---|---|---|
| `ai/agent.js` | 2371 | `Agent` | 97% |
| `render/index.js` | 1779 | `RenderSystem` | 93% |
| `fx/index.js` | 1461 | `FxSystem` | 97% |
| `weapons/index.js` | 1391 | `WeaponSystem` | 94% |
| `ai/index.js` | 1388 | `AiSystem` | 95% |
| `physics/index.js` | 1310 | `PhysicsSystem` | 83% |
| `physics/bvh.js` | 938 | `StaticWorld` | 83% |
| `audio/index.js` | 915 | `AudioSystem` | 92% |
| `weapons/viewmodel.js` | 900 | `Viewmodel` | 88% |
| `sky/index.js` | 882 | `SkySystem` | 84% |
| `player/index.js` | 850 | `PlayerSystem` | 87% |

Regenerate the whole table with `node tools/layering.mjs --sizes` — all four
columns, including the class span, which the table used to maintain by hand.
That column drifted twice (once in each direction) before the tool printed it;
a hand-maintained column drifts in whichever direction the last editor
expected.

There is no file split that helps here: in every row the class alone is at or
near the limit (`Viewmodel` is 796 of `weapons/viewmodel.js`'s 900 lines), so
deleting everything around it would still leave a file this table has to
explain.

Two shapes, and they want different things:

- **Subsystem entry points.** Line count is API AREA, not depth.
  `physics/index.js` exposes about thirty methods — `raycast`, `sphereCast`,
  `capsuleCast`, `createCharacter`, `fireBullet`, `explode` — most of them five
  to twenty lines delegating to `bvh.js`, `character.js`, `rigidbody.js`,
  `ragdoll.js`. Splitting the facade breaks the single surface `ctx.get(id)`
  reaches, which is rule 2's whole point.
- **State machines.** `Agent` shares one blackboard across every concern:
  `lastKnownAge` is read by eleven methods, `suppression` by ten. Lifting
  `_think`/`_combat`/`_move` into another file makes them functions that take
  the agent back as an argument — a syntax move, not a split — and rule 6 pins
  the scratch vectors to the instance anyway. `static snapshotState` also
  nails the object down as one netcode unit.

**What is allowed, and what is required.** Data and constants outside a class
may be lifted when it aids findability — `ai/agent-tuning.js` holds the ranges,
aim drop, hitbox capsules and muzzle offset, which are the only lines in that
file anyone edits to change how the AI feels. Do not lift methods to make the
number smaller. A file over 800 lines must be one of the two shapes above, and
its header must say which — the marker is the literal string
`OVER THE 800-LINE LIMIT`, and `tools/layering.mjs` fails the run if a file
crosses the limit without one. The check reads the raw file rather than the
stripped one, deliberately: the limit is about the file a person has to open,
and letting a 2,000-line file pass by being mostly prose would invert it.

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 120 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

`ctx` provides: `scene`, `camera`, `viewScene`, `viewCamera`, `canvas`,
`config`, `events`, `input`, `commands`, `time`, `rng`, `get(id)`, `peek(id)`,
`has(id)`.

- `scene` / `camera` — the world. `viewScene` / `viewCamera` — the first-person
  weapon, drawn separately so it can never clip through walls.
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame, tick }`. Use `alpha`
  to interpolate rendered transforms between physics steps. `frame` counts what
  was drawn and depends on the machine; `tick` counts what was simulated and
  does not — key anything a server would have to agree with us about on `tick`.
- `config.q` — the active quality preset (`src/core/config.js`). Never exceed a
  budget: `q.taa`, `q.gtao`, `q.ssr`, `q.shadowMapSize`, `q.particleBudget`,
  `q.decalBudget`.

## The command stream

`core/command.js`. The engine samples the input device once per **frame** and
seals it into one numbered command per **tick**, before any `fixedUpdate` runs.
Gameplay reads `ctx.commands.current` and never touches `ctx.input` on the fixed
step.

```
frame:  beginFrame -> commands.sample(input)      // OR presses into pending
tick:   commands.build(tick) -> fixedUpdate xN -> commands.endTick()
```

Why it is not just a latch:

- **Presses accumulate, and are consumed once.** A frame that produced no tick
  hands its press to the frame that does. Before this, a crouch pressed and
  released inside three 240 fps frames simply never happened, and a jump survived
  only because the latch poked the jump buffer on the side.
- **Commands are addressable.** `commands.get(seq)` reaches 128 ticks back
  (1.07 s at 120 Hz). Client-side prediction replays exactly this.
- **The source is swappable.** Set `commands.override = { moveX, moveY, held,
  edge }` and the local keyboard is ignored. That is the seam a server plugs
  into; `tools/observe.mjs` already drives the player through it.
- **Angles are pushed, never pulled.** `player` calls `commands.setView(yaw,
  pitch)` from its own `fixedUpdate`, because `core` may not name `player`
  (rule 3). Patches are refused once the tick is closed, so history is honest.

**Firing is on the tick too**, since `b7b42e2`. `BTN` carries `fire` and
`reload` (`core/command.js`), `weapons.fixedUpdate` runs the trigger off
`commands.current`, and the viewmodel and muzzle FX still ride the frame behind
it — which is the split that made the move possible. What forced it was a
measurement rather than tidiness: spread decay was integrated per frame, so how
fast a cone recovered depended on the monitor. `tools/firerate.mjs` gates the
result at five frame rates.

## Netcode readiness (M8)

The target is a server-authoritative FPS with client prediction, and the
codebase is built to the line just before a socket exists. Everything below is
gated, not promised:

| claim | gate |
|---|---|
| the same sim agrees across V8 / SpiderMonkey / JSC | `crossengine` |
| the sim runs with no renderer (a Node server can host it) | `headless` |
| two independently booted sims stay hash-identical for 1,200 ticks | `netsim` |
| a fresh process adopting a serialized snapshot tracks the source bit for bit | `netsim` (handoff) |
| a command survives the wire with every bit intact | `cmdstream` (wire) |

`src/core/wire.js` is the wire format: `stringifyState`/`parseState` carry the
snapshot (JSON plus the three numbers JSON destroys — its first run caught
`lastKnownAge: Infinity` arriving as `null` and turning into "spotted an enemy
16 ms ago" on the far side), and `encodeCommand`/`decodeCommand` carry one
command in 46 bytes, floats kept Float64 because a predicting client
re-simulates the exact ticks the server will and quantised inputs would spend
the whole `dmath.js` determinism budget at the first byte.

**The round clock and the death reap still run on the FRAME** (`match.update`
/ `match.lateUpdate`), and the migration now has an ACCEPTANCE GATE instead of
a hunch: `node tools/replay.mjs --trace --chunk=4` re-simulates the same
recorded commands under a 30 fps frame composition and diffs every leaf — and
today it names exactly one, `match.round.remaining`, because a clock
integrated from frame dt cannot survive a different frame division. When the
migration lands, that run must come back BIT-IDENTICAL.

The migration was attempted twice and reverted twice, and the second hunt is
worth its ledger. `perceive` goes red at 30 fps only, with agent#4's
position/yaw/aimTarget parting FOUR TICKS into the drive (`--deep`) — before
any perception field moves — while the round riders (phase/round/remaining)
stay identical at the divergence. The aim wobble was acquitted (`time.sim` is
a tick-derived getter, `engine.js:69`, shipped in `2869d64`); brass occluding
sight was convicted of a DIFFERENT crime (see MASK.SIGHT) without clearing
this one; and three isolation "convictions" (weapon:fire, weapon:shot, then a
channel that never fires at all) collapsed together when `--isolate=nope:never`
also cleared the divergence — perceive's isolation harness itself leaks
undeclared state between sweeps and cannot convict anything until that is
found (its header now says so). What remains true: something an agent's
steering reads inside four ticks is a function of the frame composition, in
some fight configurations, and it is not the round clock, the wobble clock,
the shot announcement or the brass. The hunt resumes with `--deep` at the
divergence window and the null-channel control run FIRST.

The engine's backlog shed (`MAX_SUBSTEPS`, then `_accum = 0`) stays as it is,
deliberately: under server authority a client that sheds falls behind and is
CORRECTED by the next snapshot — the server, driven tick-by-tick, never sheds.
Only a lockstep design (where every peer must simulate every tick) would need
that policy changed, and this is not one.

What a real server still needs, in order: the round-on-tick migration above, a
transport (WebRTC or WebTransport), `player`/`weapons` bootable without
`render` so the server can simulate its clients (they currently declare it as
a dep), and a third kind of host — a remote player wearing the bot rig. The
seams they plug into (`commands.override`, the wire, the handoff) are the
parts this section certifies.

## Ownership map

| id | directory | owns | status |
|---|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, post, CSM shadows, final composite | ported |
| `materials` | `src/materials/` | procedural PBR textures, shared material library | ported |
| `sky` | `src/sky/` | physical sky, time of day, IBL, volumetrics | ported |
| `physics` | `src/physics/` | BVH broadphase, raycasts, character collision, rigid bodies, ragdolls, penetration | ported |
| `fx` | `src/fx/` | GPU particles, muzzle flash, tracers, impacts, decals, shells | ported |
| `audio` | `src/audio/` | synthesized weapon/foley audio, spatialisation, reverb, occlusion | ported |
| `world` | `src/world/` | level geometry, props, static collision, spawn points | done (M2) |
| `match` | `src/match/` | teams, combatant registry, round FSM, scoring, spawn assignment | done (M3 registry, M5 rounds) |
| `player` | `src/player/` | movement state machine, camera feel, health | done (M1); hitboxes now belong to `match` |
| `ai` | `src/ai/` | bot characters, navigation, perception, combat behaviour | done (M4) |
| `weapons` | `src/weapons/` | weapon meshes, viewmodel rig, recoil, spread, hitscan ballistics | done (M7) |
| `ui` | `src/ui/` | HUD, crosshair, hitmarkers, match bar, scoreboard, spectate | done (M6) |

Shared, owned by the lead (do not edit): `src/core/`, `src/main.js`,
`src/dev/`, `tools/`, `vite.config.js`.

## Game rules the code must express

Deliberate departures from the shooter this engine came from. If code disagrees
with this table, the code is wrong.

| rule | meaning |
|---|---|
| **No ADS** | Hipfire only. Accuracy comes from a crosshair spread model, not from a sight picture. `render._readAds()` is hardwired to 0. |
| **Deterministic spray** | Recoil follows a fixed seeded `[pitch, yaw]` pattern that a player can memorise. Springs drive the *viewmodel kick* only — never the point of impact. |
| **Hitscan** | Rounds land the frame they are fired. No travel time, no drop. |
| **No sprint / slide / mantle / lean / prone** | Stand, crouch, jump. That is the whole movement vocabulary. |
| **No health regen** | Damage is permanent for the round. Health resets on round start, never mid-round. |
| **Headshots are lethal** | Part-scaled damage, `head` ~4x. This applies to the **player too** — the player carries the same part capsules a bot does. |
| **Rounds, not respawns** | Death is final until the round ends. Dead players spectate. |
| **No friendly fire** | A round through a team-mate still impacts, sprays and cracks; it does not wound. Enforced by `physics.setDamageFilter()`, which `match` installs — *not* by a `damage:dealt` handler, because that would depend on subscription order. |
| **One variant per team** | `alpha` is `breacher` (urban camo), `bravo` is `vanguard` (arid). A side reads as one uniform. Friend/foe recognition with no outline shaders and no nameplates. |
| **Freeze time holds, it does not blind** | During `warmup`/`freeze`/`roundEnd` nobody may move or shoot, but everybody may still look — and bots keep sensing. A bot that spent the freeze blind would lose the opening duel to a player who spent it watching a doorway. |
| **Time expiry is judged on survivors** | Not on damage dealt. Counting damage would make the losing team's best move at 0:10 a push for chip damage; counting bodies makes staying alive the thing that wins. Equal survivors is a draw. |
| **Scores accumulate, health does not** | `kills`/`deaths`/`damageDealt` run for the whole match. Health, ammo, perception and cover claims are round-scoped and cleared by `respawn()`. |

## Combatant contract

Every fighting entity — the player included — is registered with `match` and
exposes the same shape. This symmetry is the point: bots shoot bots, bots shoot
the player, and one damage path serves all of it.

```js
{
  id, team,                        // 'alpha' | 'bravo'
  alive, isPlayer, name,
  position, head, height, velocity, // live references, do not retain copies
  colliders,                       // physics colliders, each { part, damageScale }
  kills, deaths, damageDealt,
  applyDamage(amount, part, source, from),
  respawn({ position, yaw }),      // round reset; yaw is the WORLD convention
}
```

`respawn` forwards to `host.respawn(point)`. Both hosts implement it —
`player.respawn` natively, `Agent.respawn` as a wrapper that converts to the AI
yaw convention before calling its own pooled `reset()`. `match` never learns
which kind of fighter it is resetting.

`match.combatants` · `match.of(host)` · `match.enemiesOf(c)` ·
`match.alliesOf(c)` · `match.aliveCount(team)` · `match.areEnemies(a, b)`.

`enemiesOf` and `alliesOf` return a **reused** array — copy before the next call.

### The rig

`src/match/combatant.js` builds six colliders per fighter, sized as fractions of
the current stance height so crouching rescales for free:

| part | shape | scale | note |
|---|---|---|---|
| head | sphere | 4.00 | one-tap with the rifle (33 × 4 = 132 vs 100 HP) |
| torso | **box** | 1.00 | a box, not a capsule — see below |
| arm ×2 | capsule | 0.75 | |
| leg ×2 | capsule | 0.70 | the two capsules overlap at the centreline |

The torso is a box because a capsule's spherical cap bulges above its segment by
its own radius: a torso topping out at the collarbone still has geometry around
the ears, a horizontal round at eye height enters that cap *before* the head
(closer, because it is fatter), and physics honestly reports a headshot as a body
shot. Shoulders are flat; a box has a flat top at exactly the height you ask for.

### Self-hits

Every trace starts at the shooter's eye, which is inside the shooter's own head
sphere. `LAYER.PLAYER` and `LAYER.ACTOR` are therefore both in `MASK.BULLET`, and
the shooter is excluded by **ownership** instead:
`physics.fireBullet({ source, ignore })` skips colliders whose `owner` is
`ignore` (defaulting to `source`) for the whole trace, exit probes included.
There is no "shoot the player" code path outside the ballistics solver.

Proven by `npm run test:hitbox`.

## The round loop

```
idle -> warmup -> freeze -> live -> roundEnd -> (freeze | matchEnd)
```

`warmup` runs once, at the top of the match; every round after the first enters
at `freeze`. `src/match/round.js` is pure — no THREE, no subsystem lookups, just
a clock, a score and two calls back into `match` — which is what lets
`tools/matchsim.mjs` drive five rounds headless.

**The tempo table lives in one place.** `TEMPO` at the top of `round.js` holds
the seven numbers that decide how the game feels between fights (freeze length,
round cap, kill-cam window, rounds to win). Nothing else in the codebase should
grow its own copy of any of them.

`match.frozen` is **polled**, not pushed — `player` and `ai` both already declare
`match` as a dependency, so reading a flag off it adds no edge to the graph,
while pushing would mean `match` holding references to two named subsystems.
The push-not-poll rule is about the engine layer, which must never be able to
name gameplay at all; this is gameplay talking to gameplay along an edge that
already exists.

- `player` — `movement.controlEnabled` goes false while frozen, so `step()` still
  runs (gravity, friction, the ground probe) but every command reads zero. Look
  is untouched.
- `weapons` — gates on `player.canFire`, *not* on `match`. A gun is a gun whether
  or not there is a round on; what it depends on is the player holding it, which
  it already peeks.
- `ai` — pushes the flag down to each Agent once per frame, so `agent.js` contains
  no reference to rounds. `Agent._hold()` clears movement intent rather than
  merely ignoring it: a bot that kept a claimed cover point across the freeze
  would break for it on the first live frame, having chosen where to go before
  the round it is going there for existed.

**Spawn formation is deterministic** (`match/spawn.js`), unlike the AI's boot
garrison, which scatters with `rng`. A round reset happens five to nine times a
match at the same anchors; offsets drawn fresh each time would eventually land
two fighters 15 cm apart and let the character controller shove one of them
somewhere neither chose. Slot index in, golden-angle spiral offset out, no state.

### Harnesses turn the loop off

`playtest`, `hitbox` and `botfight` all call `match.stopMatch()` first. They
measure mechanics — does W move you, does a headshot kill, can bots fight — and
the round loop would answer a different question underneath them. `botfight` then
calls `match.resetRound()` to start its fight from the spawns: before it did,
several seconds of page load and shader compilation were a live firefight, and
whichever side was ahead when the harness looked up stayed ahead (measured:
bravo took three runs in a row, alpha dealing 24, 164 and 609 damage against
750, 788 and 771).

### Two yaw conventions

They differ by exactly `PI`, both are internally consistent, and the mismatch is
invisible until something walks into a wall:

| used by | forward | yaw 0 faces |
|---|---|---|
| `world`, `player`, `weapons` | `(-sin y, 0, -cos y)` | `-Z` |
| `ai` (all of `agent.js`) | `( sin y, 0,  cos y)` | `+Z` |

`world.spawnPoints[].yaw` is authored in the **world** convention — it has to be,
the player reads the same table. `ai/index.js` converts at the one boundary where
it enters the AI (`aiYaw`). Handing a spawn yaw to an Agent unconverted spawns the
whole roster facing its own back wall.

### Interior probes

Anything that finds the floor by dropping a ray from above must start **inside**
the playable volume. This has now bitten three times, each from an inherited
constant tuned for an outdoor map with nothing overhead:

| site | was | symptom |
|---|---|---|
| `player._resolveSpawn` | `spawn.y + 6` | player spawned on the roof of a 6 m building |
| `fx/ambience._shimmer` | `camera.y + 6` | heat shimmer stacked on the ceiling |
| `ai/nav.js` `NavGrid.topY` | `bounds.max.y + 4` | the entire navmesh built across the roof |

The nav one is the instructive case: it produced a complete, plausible-looking
grid — 2,867 walkable cells, bots pathing and shooting — that simply described a
different surface than the one they stood on. It was found by reading a number
(`floor = 6.5` on a 6 m building), not by looking at the screen.

`bounds.expandByScalar()` is the related trap: it grows Y too, which lifts a probe
back above the roof. Expand X/Z only.

## The HUD

A DOM+CSS overlay driven from `lateUpdate`. **Nothing animates on a CSS keyframe
or transition** — every value is integrated from `dt`. A CSS transition runs on
wall-clock time, so a pumped capture frame would find it in a different place
depending on how fast the machine was; the same property is what lets the whole
HUD stop when the game pauses. New widgets follow the rule.

`ui` depends on `match`, not `peek`s it. Everything at the top of the screen
comes from there, and a HUD that silently renders `0-0` forever because a peek
came back null is worse than one that fails to boot.

### Deleted on the way over

| | why |
|---|---|
| `minimap.js` (603 lines) | A 48×36 m symmetric depot with three lanes is a map you learn in two rounds. A minimap of it is a second screen showing what the first already does. |
| `Compass` | A heading strip for a level with no navigation problem. |
| `demo.js` | A scripted firefight timeline that existed to give screenshots a HUD with numbers in it, back when nothing drove the HUD. `match` drives it now, and a debug timeline that overwrites live match state photographs a game that is not happening. |

The match bar inherits the compass's slot at top centre — and its **scrim**. The
skylight runs up the middle of the frame, so top centre is the one place where
the background is routinely blown-out cloud; the compass carried a feathered
dark plate for exactly this reason and left a note saying so. A text shadow
alone gives grey glyphs on white sky.

### Hitmarkers gate on `source`, not on `target`

Upstream asked "is the target NOT the player", which is correct in a game with
one shooter and wrong in one with a roster of them: every round a bot lands on another
bot would draw the player a hitmarker for a fight across the map. Same for the
killfeed, which is now built from one event (`combatant:death`, emitted by the
only thing that knows both ends of a kill) rather than from two de-duplicated
with a 0.3 s window.

### Spectating is split across two subsystems, on purpose

| | where | why |
|---|---|---|
| camera | `src/player/spectate.js` | `player` owns the camera transform, full stop. Two systems writing `ctx.camera.position` on one frame is a race decided by update order, and update order is the dependency graph. |
| overlay | `src/ui/spectate.js` | reads `player.spectateTarget` and draws a name |

It follows a living team-mate over the shoulder rather than going free-cam:
free-cam through walls is a wallhack handed to the player for the price of
dying, and death lasts a whole round here. The chase pose is traced against
`MASK.SIGHT` so the camera cannot clip through the crate its subject is hiding
behind — which would show the player the far side of their own cover, exactly
the information spectating exists to deny.

`Combatant.viewYaw` is what makes one chase camera work for both kinds of
fighter: it returns `host.worldYaw ?? host.yaw`, and `Agent.worldYaw` applies
`aiYaw` (a shift of π, its own inverse). Without it the camera would sit in
front of a bot's face and behind the player's head.

Proven by `npm run test:hud`.

## World contract

| member | meaning |
|---|---|
| `world.bounds` | `THREE.Box3` of the playable area, world space. `ai` sizes its nav grid from this. |
| `world.spawnPoints` | `[{ position, yaw, team, tag }]`. `team` is `'alpha' \| 'bravo' \| null`. |
| `world.spawn(i)` | one of the above, index wrapped |
| `world.spawnsFor(team)` | every spawn belonging to a team |
| `world.roomVolumes` | coarse interior boxes; pushed to `render.setRoomVolumes()` at init |

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects.

**The names below are load-bearing** — `fx` and `audio` hang a dozen effects and
sounds each off them. The EventBus does not warn on an unknown type
(`registry.js`), so renaming one does not throw — it silently kills every effect
and sound hanging off it. Payloads here are the fields a consumer may rely on;
emitters may carry more.

| event | payload | emitted by |
|---|---|---|
| `weapon:fire` | `{ weapon, origin, dir, seed }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'magout'\|'magin'\|'end' }` | weapons |
| `weapon:shell` | `{ position, velocity, weapon }` | weapons |
| `bullet:impact` | `{ point, normal, surface, damage, exit, actor, part, friendly }` | physics |
| `bullet:tracer` | `{ from, to, speed }` | weapons |
| `damage:dealt` | `{ target, source, amount, part, headshot, team, point, killed }` | physics |
| `damage:taken` | `{ amount, health, direction, critical, from }` | player |
| `combatant:spawn` | `{ combatant }` | match |
| `combatant:death` | `{ combatant, source, part, headshot }` | match |
| `actor:death` | `{ actor, point, impulse, headshot }` | ai / player |
| `player:land` | `{ position, surface, velocity }` | player |
| `player:footstep` | `{ position, surface, running, left, speed, stance }` — `fx` draws nothing unless `running` | player |
| `player:jump` / `player:respawn` | `{ position }` — respawn is what refills every magazine (`weapons`) | player |
| `player:state` | `{ state, stance, grounded, airborne, speed, health, healthFraction }`, on discrete change only | player |
| `round:phase` | `{ phase, round, remaining, scores }` | match |
| `round:start` | `{ round, scores }` | match |
| `round:end` | `{ round, winner, reason: 'elimination'\|'time'\|'draw', scores }` | match |
| `match:end` | `{ winner, scores }` | match |
| `explosion` | `{ position, radius, damage }` | any |

`damage:dealt` carries **`source`** as well as `target`. With bots shooting each
other, "the target is not me" is no longer the same question as "I landed this
shot" — anything that reacts to a hit (hitmarkers, killfeed, hit sounds) must gate
on `source`.

`damage:dealt.killed` is emitted as `false` and **back-filled by the target's own
listener** (`ai` patches it once `applyDamage` lands), so it is only truthful for
subscribers registered *after* the gameplay layer. Anything wired earlier —
engine-layer audio, for instance — must take its kill signal from
`combatant:death` instead, which `match` emits knowing both ends.

## Shared surface types

`concrete · metal · wood · dirt · sand · glass · water · foliage · fabric ·
flesh · rubber · plaster`

One vocabulary shared by physics (penetration depth, friction), fx (impact
particles, decals) and audio (impact and footstep timbre). A mesh declares its own
via `mesh.userData.surface`.
