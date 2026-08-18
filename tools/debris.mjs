#!/usr/bin/env node
/**
 * DEBRIS — does anything stay in the air after the round has gone?
 *
 *   node tools/debris.mjs [--rounds=60]
 *
 * Reported symptom: "bullets floating in the air". Nothing in this game leaves
 * a bullet in the air — a tracer is a particle with `life = dist / speed` and
 * cannot outlive its flight — but the things a player would reasonably CALL a
 * bullet do persist: ejected brass, dropped magazines, thrown grenades. All
 * three are rigid bodies, and a rigid body that falls asleep off the ground
 * hangs there until its lifetime expires.
 *
 * `_sleepCheck` is the suspect and its own comment is the reason to check it:
 *
 *   "Micro-friction: a body already this slow is being held up by contacts"
 *
 * That is an assertion about contacts made without consulting one. It is
 * correct almost always — gravity pulls a falling body out of the sleep band
 * within a frame — but "almost always" is not what the comment claims, and the
 * failure it would produce is exactly the reported one.
 *
 * WHAT IT DOES
 *
 * Fires a magazine, throws the grenades, waits for the debris to settle, then
 * for every body that fell asleep casts a ray straight down and measures the
 * gap to whatever is underneath. A body at rest on a surface reads a gap of
 * roughly its own radius. Anything meaningfully above that is hanging.
 *
 * The ray is cast DOWN from the body centre rather than testing contacts,
 * because a body wrongly asleep in mid-air has no contacts to inspect — asking
 * the solver would return the same empty answer that let it sleep.
 *
 * That half found nothing: 118 sleeping bodies, every one of them touching
 * something, largest gap -0.023 m. The sleep suspicion above was wrong and is
 * left standing because a gate that only ever asserted the bug it was written
 * for would stop being evidence the moment the code moved.
 *
 * THE HALF THAT FOUND IT is decals. A decal is written into a world-space atlas
 * and lives 80-120 seconds; that is right for concrete and wrong for anything
 * that walks. `flesh` never wrote one, but routing friendly hits to `fabric`
 * (so team-mates spray cloth instead of blood) inherited `fabric`'s 80-second
 * tear — and left it hanging at chest height where the team-mate had been.
 *
 * Measured by POSITION, not by tally: rounds that pass through a fighter mark
 * the concrete behind, and those decals are correct. A count cannot tell the
 * two apart. The probe also asserts it actually hit somebody, because a version
 * that solved the aim once reported a clean zero while every round sailed into
 * the wall behind a bot that had walked away.
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady, bootUrl } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const ROUNDS = Number(args.rounds ?? 60);
/** Metres of clear air under a sleeping body before it counts as hanging. */
const GAP_TOL = 0.06;

const vite = await ensureServer(PORT, { name: 'DEBRIS' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(bootUrl(PORT), { waitUntil: 'load' });
await waitForReady(page, { name: 'DEBRIS' });

const out = await page.evaluate(async (rounds) => {
  const e = window.__ENGINE__;
  const phys = e.ctx.get('physics');
  const wp = e.ctx.get('weapons');
  const player = e.ctx.get('player');
  e.ctx.get('match').stopMatch();
  player.setControlEnabled(false);

  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };

  // Bodies present before we make any, so a pre-existing prop is not counted.
  const before = new Set(phys.bodies.bodies);

  wp.refillAll();
  for (let i = 0; i < rounds; i++) {
    if (!wp.tryFire()) wp.refillAll();
    await frame();
  }
  for (let i = 0; i < 4 && wp.grenades > 0; i++) {
    wp.throwGrenade();
    await frames(20);
  }
  // A magazine fired from the spawn lands eight casings on flat floor, which is
  // the one surface least likely to strand anything. Scatter debris across the
  // whole depot so the shelving, the crates and the island are all sampled —
  // resting on an edge is where a solver leaves things hanging, not on a slab.
  //
  // Seeded LCG, not Math.random: this is a harness and a failure has to be
  // reproducible by rerunning the same command.
  let seed = 0x5eed1234;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 120; i++) {
    phys.spawnDebris(
      { x: (rnd() - 0.5) * 44, y: 1.2 + rnd() * 3.2, z: (rnd() - 0.5) * 32 },
      { x: (rnd() - 0.5) * 6, y: rnd() * 2, z: (rnd() - 0.5) * 6 },
      { size: 0.02 + rnd() * 0.04, surface: 'metal', lifetime: 60 }
    );
    if (i % 12 === 0) await frame();
  }

  // Long enough for a 0.45 s sleep timer plus the fall that precedes it.
  await frames(420);

  // ---- decals on things that walk away ---------------------------------
  //
  // The other half of "floating bullets", and the half that turned out to be
  // real. A decal is written into a world-space atlas for 80-120 seconds; a
  // fighter is somewhere else in two. Fired through `physics.fireBullet` with
  // the same arguments `weapons.tryFire` uses, so the damage filter runs and
  // the friendly substitution in `fx.onImpact` is on the path being tested.
  const fx = e.ctx.get('fx');
  const ai = e.ctx.get('ai');
  const mate = ai.agents.find((a) => a.alive && a.team === player.team);
  const decals = { onMate: 0, onWall: 0 };
  const seen = [];
  const offImpact = e.ctx.events.on('bullet:impact', (ev) => {
    seen.push({ surface: ev.surface, friendly: !!ev.friendly, actor: !!ev.actor, exit: !!ev.exit });
  });
  if (mate) {
    // Fired from two metres in front of the fighter at chest height, not from
    // the player's eye. The eye is where a player shoots from and it is also
    // behind whatever the bot has just walked behind: three runs in, the probe
    // reported a clean zero because every round had stopped in a shelf. The
    // damage filter keys on `source`, not on where the round started, so the
    // friendly path is the same one either way — and a muzzle two metres from
    // the chest cannot miss.
    const RANGE = 2;
    // Count by POSITION, not by tally. Rounds that pass through a fighter go on
    // to mark the concrete behind them, and those decals are correct — a count
    // cannot tell them apart from one written on the fighter. Recording where
    // each decal landed can.
    const marks = [];
    const realAddDecal = fx.addDecal.bind(fx);
    fx.addDecal = (pt, nrm, o) => { marks.push({ x: pt.x, y: pt.y, z: pt.z }); return realAddDecal(pt, nrm, o); };
    for (let i = 0; i < 6; i++) {
      // Re-aimed every shot. A bot keeps walking with the match stopped, and a
      // direction solved once put every round into the wall behind it — which
      // reported a clean zero and proved nothing at all.
      const t = mate.position;
      const eye = { x: t.x + RANGE, y: t.y + 1.1, z: t.z };
      const d = { x: -1, y: 0, z: 0 };
      phys.fireBullet({
        origin: eye, dir: d, damage: 33, penetration: 0.6, dropoff: 0.5,
        falloffRange: 200, maxDist: 200, source: player, mask: phys.MASK.BULLET,
      });
      await frame();
    }
    // Anything inside a 0.6 m column around the fighter, at body height.
    // Inside a 0.45 m column at body height. Tighter than the fighter's reach
    // on purpose: a wall directly behind them is a legitimate mark and must not
    // be counted, and 0.45 m clears the torso without reaching past it.
    const t = mate.position;
    decals.onMate = marks.filter((m) =>
      Math.hypot(m.x - t.x, m.z - t.z) < 0.45 && m.y > t.y + 0.3 && m.y < t.y + 2
    ).length;
    decals.through = marks.length - decals.onMate;

    // Control: straight down into the floor should mark it every time.
    marks.length = 0;
    const before3 = fx.stats.decals;
    for (let i = 0; i < 6; i++) {
      phys.fireBullet({
        origin: player.aimOrigin, dir: { x: 0, y: -1, z: 0 }, damage: 33, penetration: 0.6,
        dropoff: 0.5, falloffRange: 200, maxDist: 200, source: player, mask: phys.MASK.BULLET,
      });
      await frame();
    }
    decals.onWall = fx.stats.decals - before3;
    fx.addDecal = realAddDecal;
  }
  offImpact?.();
  decals.fleshHits = seen.filter((h) => h.surface === 'flesh').length;

  const rows = [];
  let asleep = 0, awake = 0;
  for (const b of phys.bodies.bodies) {
    if (before.has(b)) continue;
    if (!b.sleeping) { awake++; continue; }
    asleep++;
    const r = b.boundRadius ?? 0.02;
    // "What can SUPPORT a body" spelled out, not borrowed. This ray used to
    // wear MASK.BULLET as a stand-in, and when DEBRIS left that mask (brass
    // must not eat bullets — see surfaces.js) the ray started passing through
    // casing stacks: the top of a two-casing pile read as hanging 2.5 m over
    // the floor it was, transitively, resting on. The support question is the
    // level, the props, and other debris — asked by name.
    const hit = phys.raycast(
      { x: b.position.x, y: b.position.y, z: b.position.z },
      { x: 0, y: -1, z: 0 },
      6,
      (phys.MASK?.WORLD ?? 0) | (phys.LAYER?.DEBRIS ?? 0)
    );
    const gap = hit?.hit ? hit.distance - r : Infinity;
    rows.push({
      y: +b.position.y.toFixed(3),
      r: +r.toFixed(3),
      gap: hit?.hit ? +gap.toFixed(3) : null,
      surface: hit?.surface ?? null,
    });
  }
  return { rows, asleep, awake, decals, playerTeam: player.team ?? null, mateTeam: mate?.team ?? null, hadMate: !!mate, total: phys.bodies.bodies.length };
}, ROUNDS);

await browser.close();
killServer(vite);

const hanging = out.rows.filter((r) => r.gap === null || r.gap > GAP_TOL);
const worst = out.rows.reduce((a, r) => (r.gap !== null && (!a || r.gap > a.gap) ? r : a), null);

console.log(`\n  fired on a ${out.mateTeam} team-mate as ${out.playerTeam}`);
console.log(`  decals: ${out.decals.onMate} on a team-mate, ${out.decals.through} on what was behind them, ` +
  `${out.decals.onWall} on the floor (control) · ${out.decals.fleshHits} flesh hits`);
console.log(`\nDEBRIS — ${out.asleep} asleep, ${out.awake} still moving, ${out.total} bodies total`);
if (worst) console.log(`  largest gap under a sleeping body: ${worst.gap} m (radius ${worst.r}, y ${worst.y})`);
for (const r of hanging.slice(0, 8)) {
  console.log(`  HANGING  y ${r.y}  radius ${r.r}  gap ${r.gap ?? 'nothing below within 6 m'}`);
}

const fail = [];
if (!out.asleep) fail.push('nothing came to rest — the probe proves nothing about sleeping bodies');
if (!out.hadMate) fail.push('no live team-mate to shoot — the decal half of the probe did not run');
else if (!out.decals.onWall) fail.push('firing into the floor left no decal — the control failed, so the result below means nothing');
else if (!out.decals.fleshHits) fail.push('no round reached the team-mate — a zero here would be the probe missing, not the bug being fixed');
else if (out.decals.onMate) {
  fail.push(`${out.decals.onMate} decals written where a team-mate was standing — they will hang in the air for 80 s`);
}
if (hanging.length) fail.push(`${hanging.length} of ${out.asleep} sleeping bodies are off the ground`);
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nDEBRIS FAILED (${fail.length}):\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nDEBRIS OK — every one of ${out.asleep} sleeping bodies is resting on something.`);
