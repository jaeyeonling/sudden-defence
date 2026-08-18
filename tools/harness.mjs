/**
 * HARNESS — the four blocks every tool in this directory used to hand-roll.
 *
 * Before this file existed there were 32 copies of the arg parser, 31 of the
 * port probe, 30 of the chromium launch and 29 of the teardown — and the cost
 * was not aesthetic. `8575e2d` had to fix OW_NO_HMR being absent from exactly
 * the two servers feeding the byte-identity gates, and `7913601` had to add
 * the came-up check to three tools while twenty-five more still fell through
 * to an opaque goto timeout. A guard that must be on ALL of the copies or it
 * is on none of the ones that matter wants to be one copy.
 *
 * What the helpers pin down, on purpose:
 *
 *   - vite is spawned from `node_modules/.bin/vite`, never `npx` — npx adds
 *     per-gate resolution overhead and on a cold cache can reach the registry.
 *   - `--strictPort` always: a silent rebind serves a different tree, which is
 *     precisely the confusion pixelgate's port choice exists to prevent.
 *   - `OW_NO_HMR=1` always, preview included. The dev server must not reload
 *     the page under playwright mid-run; the preview server has no HMR, so the
 *     variable is inert there — cheaper than a conditional nobody re-derives.
 *   - The wait loop is followed by a re-check that FAILS WITH A NAME, so a
 *     server that never came up reads as what it is instead of a 90-second
 *     page.goto timeout.
 *   - A server that was already answering the port belongs to whoever started
 *     it: ensureServer returns null and killServer(null) is a no-op, so no
 *     tool can tear down `npm test`'s shared server.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

/** `--k=v` / `--flag` into { k: 'v', flag: true }. Bare words become flags. */
export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
}

/** Is something answering on 127.0.0.1:port? 400 ms budget, never throws. */
export const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/**
 * Own a vite server on `port`, or defer to whoever already does.
 *
 * Returns the child process when this call spawned one (hand it back to
 * killServer), or null when the port was already answering. On a server that
 * never comes up it prints `<name> FAILED — vite did not come up on :<port>`
 * and exits 1 — after killing the child, so a half-started vite cannot leak
 * into the next tool in the chain.
 */
export async function ensureServer(port, opts = {}) {
  const {
    preview = false,
    root = resolve(import.meta.dirname, '..'),
    tries = 80,
    name = 'HARNESS',
  } = opts;
  if (await portOpen(port)) return null;
  const argv = [...(preview ? ['preview'] : []), '--port', String(port), '--strictPort'];
  const child = spawn(resolve(root, 'node_modules/.bin/vite'), argv, {
    cwd: root,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < tries && !(await portOpen(port)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await portOpen(port))) {
    console.error(`${name} FAILED — vite did not come up on :${port}`);
    killServer(child);
    process.exit(1);
  }
  return child;
}

/** Tear down a server ensureServer spawned. null-safe; never throws. */
export function killServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid); // the whole detached process group
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/**
 * chromium.launch with the flag set the logic gates share: SwiftShader-capable
 * GL so the same harness answers on a headless CI runner and a laptop. Pass
 * `args` to replace the set entirely (the render tools bring their own).
 */
export function launchChromium(opts = {}) {
  return chromium.launch({
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
    ...opts,
  });
}

/**
 * Wait for the page to declare `window.__READY__ === true`, and when it does
 * not, say WHY before dying.
 *
 * Two lessons from the first CI run are folded in here:
 *
 *   1. The default is 300 s, not the 90-120 s the tools used to carry. Boot
 *      bakes every texture through WebGL, and on a 4-core shared runner that
 *      renders with SwiftShader the same bake that takes seconds on the
 *      reference laptop can take minutes. A readiness timeout is not a
 *      performance assertion — profile.mjs owns that question — so the only
 *      thing a tight bound buys here is a flaky gate on slow hardware.
 *   2. On timeout it prints every console error/warning and pageerror it saw,
 *      then exits 1. The first CI failure produced exactly one line —
 *      "Timeout 120000ms exceeded" — because each tool collected pageerrors
 *      into an array nothing printed on this path.
 *
 * Attach it right after newPage() so the listeners see the whole boot.
 */
export async function waitForReady(page, opts = {}) {
  const { name = 'HARNESS', timeout = 300000 } = opts;
  const seen = [];
  const onConsole = (m) => {
    if (m.type() === 'error' || m.type() === 'warning') seen.push(`[${m.type()}] ${m.text()}`);
  };
  const onError = (e) => seen.push(`[pageerror] ${e.message}`);
  page.on('console', onConsole);
  page.on('pageerror', onError);
  try {
    await page.waitForFunction('window.__READY__ === true', null, { timeout });
  } catch {
    console.error(`${name} FAILED — page never reached __READY__ within ${timeout / 1000}s.`);
    console.error(seen.length ? `Boot diagnostics:\n  ${seen.join('\n  ')}` : 'No console errors or pageerrors were emitted — the boot is running, just slow, or hung silently.');
    process.exit(1);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onError);
  }
}
