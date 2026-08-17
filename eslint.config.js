/**
 * Lint config — the generic half.
 *
 * The rules that matter most in this repo are not here. Hard rules 2, 3 and 5
 * (no cross-subsystem imports, the engine layer never names gameplay, no
 * `Math.random()`) are checked by `tools/layering.mjs`, which understands the
 * ownership map; rule 6 (allocate nothing per frame) is measured for real by
 * `tools/profile.mjs` against actual heap growth. This file covers what is left:
 * the typos a 66k-line codebase accumulates when nothing has ever looked.
 *
 * Deliberately NOT enabled:
 *
 *   no-console        `console.info` at boot is the interface — `[render] WebGL2
 *                     · high · 4x2048 CSM`, `[world] warehouse 48x36m` — and
 *                     `tools/contract.mjs` reads that log as its output. The
 *                     MATERIAL_SLOTS assert was a `console.warn`.
 *   stylistic rules   formatting is not enforced. 66k lines of consistent
 *                     hand-formatting is not worth a reflow diff that would bury
 *                     every `git blame` in the repo.
 *
 * Globals are listed by hand rather than pulled from the `globals` package,
 * which would be a second dependency for a list this codebase can enumerate.
 * Adding one here should mean the code genuinely started using it.
 */

/** What the browser gives `src/`. */
const BROWSER = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  console: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  Image: 'readonly',
  ImageData: 'readonly',
  OffscreenCanvas: 'readonly',
  HTMLCanvasElement: 'readonly',
  HTMLElement: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  EventTarget: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  PointerEvent: 'readonly',
  WheelEvent: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  AudioContext: 'readonly',
  OfflineAudioContext: 'readonly',
  AudioBuffer: 'readonly',
  AudioWorkletNode: 'readonly',
  PeriodicWave: 'readonly',
  WebGL2RenderingContext: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  crypto: 'readonly',
  devicePixelRatio: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  screen: 'readonly',
  matchMedia: 'readonly',
  getComputedStyle: 'readonly',
  addEventListener: 'readonly',
  removeEventListener: 'readonly',
  dispatchEvent: 'readonly',
  DOMParser: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
};

/** What Node gives `tools/`. */
const NODE = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  require: 'readonly',
  __dirname: 'readonly',
};

const RULES = {
  // Correctness. Every one of these is a bug when it fires, not a preference.
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    // A leading underscore is the codebase's existing "deliberately unused"
    // marker (interface-shaped callbacks, destructured-and-skipped).
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
  }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-fallthrough': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-compare-neg-zero': 'error',
  // `x !== x` is the NaN idiom and `use-isnan` already covers it; this catches
  // the accidental `==` that coerces.
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'shots/**', 'docs/**'],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: BROWSER,
    },
    rules: RULES,
  },
  {
    // `src/**/selftest.js` are dev tools, not shipped game code — physics/selftest
    // opens with `node src/physics/selftest.js` and sets `process.exitCode`.
    // Nothing imports them, so they get node on top of the browser globals the
    // rest of src/ has.
    files: ['src/**/selftest.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...BROWSER, ...NODE },
    },
    rules: RULES,
  },
  {
    files: ['tools/**/*.mjs', 'src/**/*.mjs', 'eslint.config.js', 'vite.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Node AND browser, because a harness genuinely contains both: the file
      // runs in node, but the bodies handed to `page.evaluate` are serialised
      // and executed in the page. `window` inside one of those is correct code,
      // and 271 of the first run's 445 errors were exactly that.
      globals: { ...NODE, ...BROWSER },
    },
    rules: RULES,
  },
];
