import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/, so the deploy workflow
  // builds with OW_BASE=/sudden-defence/. Everything local — dev, preview,
  // pixelgate, determinism — keeps '/', so no gate hash moves because of this.
  base: process.env.OW_BASE ?? '/',
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  // strictPort here too: profile/abperf ask for 8080, and a silent rebind to
  // 8081 would land a *built-bundle* preview on the port pixelgate chose
  // precisely so its dev server could never be confused with one.
  preview: { host: '127.0.0.1', strictPort: true },
  // `sourcemap: 'hidden'` — the map is still written, so a stack trace from a
  // built bundle can be resolved by hand, but no `//# sourceMappingURL` comment
  // ships and no browser fetches 6.5 MB to render a frame. `true` put a map
  // four times the size of the bundle in front of every visitor.
  build: { target: 'es2022', sourcemap: 'hidden', chunkSizeWarningLimit: 4096 },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
