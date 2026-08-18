# sudden-defence

@ARCHITECTURE.md is the contract — read it before writing code. This file exists
so it is in context before the first edit; it adds nothing the contract doesn't
say.

`tools/layering.mjs` (runs in every `npm test`) mechanically enforces the
cross-import ban, the engine-never-names-gameplay rule, the `Math.random()` ban
and the 800-line marker. The rules it CANNOT check are the ones to hold in your
head while editing:

- **Allocate nothing per frame.** No `new THREE.Vector3()`, no array/object
  literal, inside `update()` / `fixedUpdate()` / `lateUpdate()`. Preallocate in
  `init()` and reuse.
- **Edge input only in `update()`.** `input.pressed`/`released` are
  frame-scoped; on the fixed step read `ctx.commands.current` instead.
- **Dispose what you create.** Geometries, materials, textures, render targets —
  freed in `dispose()`.
- **No CSS keyframes or transitions in the HUD.** Every animated value is
  integrated from `dt`.
- **Never copy a tempo/timing constant.** Read `match.round.tempo` at runtime.

Verify before finishing: `npm run build` passes and
`node tools/capture.mjs --shot=boot` produces a frame. `npm run test:logic` is
the machine-independent gate set; `test:render`/`test:perf` are pinned to the
reference machine.
