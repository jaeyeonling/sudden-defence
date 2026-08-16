#!/usr/bin/env node
/**
 * LAYERING — the hard rules, executable.
 *
 *   npm run test:layering
 *
 * `ARCHITECTURE.md` opens with "Read this before writing code. It is the only
 * coordination mechanism," and then states rules 2, 3 and 5 as prose. Prose is
 * checked by whoever remembers to check it. This checks three of them on every
 * run, in about a second, with no browser and no dependency:
 *
 *   rule 2  a subsystem never imports another subsystem's module. They meet at
 *           runtime through `ctx.get(id)`. This is the rule that let 31k lines
 *           of engine move here from another project untouched, and it is the
 *           one that quietly stops being true first.
 *   rule 3  the engine layer must never NAME gameplay — not even through
 *           `peek()`. When the engine needs something gameplay knows, gameplay
 *           pushes it down.
 *   rule 5  no `Math.random()`. Capture reproducibility depends on it, and so
 *           does the deterministic spray.
 *
 * WHY THIS STRIPS COMMENTS FIRST, WHICH IS MOST OF THE FILE'S DIFFICULTY
 *
 * A naive grep for these patterns is wrong in the direction that wastes the
 * most time: it reports the codebase's own prose about the rules as violations
 * of them. Measured on this tree, grepping `peek\('player'\)` returns two hits,
 * and BOTH are comments explaining why the code below them does not do that —
 * `audio/index.js` ("Combatant identity WITHOUT peek('player')") and
 * `core/command.js` ("Engine-layer rule 3 is why this is a push"). Grepping
 * `Math.random` returns five, four of which are prose and one of which is the
 * documented boot seed.
 *
 * So a checker that does not understand comments does not merely produce noise;
 * it produces noise that is densest exactly where the code is most careful,
 * which teaches you to stop running it. Comments come out first.
 *
 * WHAT IT DOES NOT DO
 *
 * Rules 1, 4 and 6-10 are not checked. Directory ownership is a review
 * question, dependencies are visible in `package.json`, and per-frame
 * allocation is already measured for real by `tools/profile.mjs` — which
 * reports actual heap growth over 840 frames rather than guessing from syntax.
 * A static approximation of a rule that has a dynamic measurement is worse than
 * nothing, because it can be green while the measurement is red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/**
 * `core` is in the engine layer for rule 3 — it must not name gameplay, and
 * `core/command.js` carries a comment saying exactly that where it would have
 * been convenient to peek. But it is NOT a peer for rule 2.
 *
 * ARCHITECTURE.md's ownership map lists `src/core/` under "Shared, owned by the
 * lead", not as a subsystem, and there is no `ctx.get('core')` to reach it
 * with — core is what PROVIDES ctx. Importing `core/dmath.js` is not a rule 2
 * violation, it is the required pattern: the whole cross-engine determinism
 * result rests on every simulation directory importing those functions rather
 * than calling `Math.sin` for itself. Treating it as a peer reports 52
 * violations on a clean tree, all of them the thing the code is supposed to do.
 */
const SHARED = ['core'];
const ENGINE = ['render', 'materials', 'sky', 'physics', 'fx', 'audio', ...SHARED];
const GAMEPLAY = ['world', 'player', 'weapons', 'ai', 'ui', 'match'];
const SUBSYSTEMS = [...ENGINE, ...GAMEPLAY];
/** Peers for rule 2: everything a `ctx.get(id)` can return. */
const PEERS = SUBSYSTEMS.filter((s) => !SHARED.includes(s));

/**
 * `Math.random()` is legal in exactly one place: drawing the master seed at
 * boot when the caller did not pin one. `config.js` documents the option and
 * `engine.js` performs the draw. Everything downstream forks from `ctx.rng`.
 */
const SEED_SITES = ['core/engine.js'];

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

/**
 * Remove comments, and nothing else.
 *
 * Not a parser — a scanner that tracks the four states a `/` can be in, which
 * is what it takes to avoid treating `'https://x'` as a line comment or a `//`
 * inside a template literal as one. Newlines are preserved so reported line
 * numbers still point at the source.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | tick
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'tick';
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i++; continue;
    }
    // inside a string: copy through, honour escapes, and bail on a newline so a
    // malformed quote cannot swallow the rest of the file.
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'tick' && c === '`')) state = 'code';
    else if (c === '\n' && state !== 'tick') state = 'code';
    out += c; i++;
  }
  return out;
}

const fail = [];
const counts = { files: 0, imports: 0, lookups: 0 };

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).split('\\').join('/');
  const owner = rel.split('/')[0];
  if (!SUBSYSTEMS.includes(owner)) continue; // main.js, dev/ — not subsystems
  counts.files++;

  const code = stripComments(readFileSync(abs, 'utf8'));
  const at = (idx) => code.slice(0, idx).split('\n').length;

  // Rule 2 — a cross-subsystem import. `../<other>/…`, or an absolute-ish
  // `src/<other>/…`. Same-directory and `./sub/…` imports are the point of the
  // rule, not a violation of it.
  for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    counts.imports++;
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare specifier: `three`
    const other = spec.match(/(?:^|\/)(?:\.\.\/)+([a-z]+)\//)?.[1]
      ?? spec.match(/(?:^|\/)src\/([a-z]+)\//)?.[1];
    if (other && PEERS.includes(other) && other !== owner) {
      fail.push(`rule 2  ${rel}:${at(m.index)} imports '${spec}' — use ctx.get('${other}')`);
    }
  }

  // Rule 3 — the engine layer naming gameplay, through any of the three
  // lookups. `peek` is called out in the rule because it is the one that looks
  // harmless.
  if (ENGINE.includes(owner)) {
    for (const m of code.matchAll(/\b(?:get|peek|has)\(\s*['"]([a-z]+)['"]\s*\)/g)) {
      counts.lookups++;
      if (GAMEPLAY.includes(m[1])) {
        fail.push(`rule 3  ${rel}:${at(m.index)} engine layer names gameplay '${m[1]}' — gameplay must push`);
      }
    }
  }

  // Rule 5 — Math.random(), anywhere but the documented seed draw.
  if (!SEED_SITES.includes(rel)) {
    for (const m of code.matchAll(/\bMath\.random\s*\(/g)) {
      fail.push(`rule 5  ${rel}:${at(m.index)} Math.random() — use ctx.rng or a fork`);
    }
  }
}

if (fail.length) {
  console.log(`LAYERING FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `LAYERING OK — ${counts.files} files across ${SUBSYSTEMS.length} subsystems · ` +
  `${counts.imports} imports, none crossing · ${counts.lookups} engine-layer lookups, none naming gameplay · ` +
  `Math.random() only in ${SEED_SITES.join(', ')}`
);
