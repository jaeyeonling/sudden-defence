import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const portOpen = (p) => new Promise((r) => {
  const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), r(true)));
  s.on('error', () => r(false)); s.setTimeout(400, () => (s.destroy(), r(false)));
});

let vite;
if (!(await portOpen(5173))) {
  vite = spawn('npx', ['vite', '--port', '5173'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await portOpen(5173)); i++) await new Promise(r => setTimeout(r, 250));
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });

const state = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const w = e.ctx.peek('world');
  const p = e.ctx.peek('physics');
  const u = r.patcher.uniforms;
  const pl = e.ctx.peek('player');
  return {
    camera: e.camera.position.toArray().map(v=>+v.toFixed(2)),
    camFov: +e.camera.fov.toFixed(1),
    playerFeet: pl ? pl.position.toArray().map(v=>+v.toFixed(2)) : null,
    playerEye: pl ? pl.eyePosition.toArray().map(v=>+v.toFixed(2)) : null,
    playerState: pl?.state, grounded: pl?.grounded, health: pl?.health?.value ?? null, dead: pl?.dead,
    roomCount: u.owIndirect.value.z,
    roomBox: Array.from(r.patcher.rooms[0] ?? []),
    roomY: Array.from(r.patcher.roomsY[0] ?? []),
    interiorIndirect: u.owIndirect.value.y,
    spawnTeams: w.spawnPoints.map(s => `${s.tag}:${s.team}`),
    bounds: [w.bounds.min.toArray(), w.bounds.max.toArray()],
    staticTris: p.stats?.staticTris ?? p.staticWorld?.triCount ?? null,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('--- logs ---');
console.log(logs.filter(l => /render|world|physics|error|warn/i.test(l)).join('\n'));
await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(0);
