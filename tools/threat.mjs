#!/usr/bin/env node
/**
 * How long does a player live?
 *
 * `Agent.weaponDamage` is described in its own source as "the most consequential
 * number in the game", and nothing in the suite could see it. `botfight.mjs` and
 * `matchsim.mjs` are bot-versus-bot, so raising it scales both sides at once and
 * only makes fights shorter; the thing it actually decides — whether a fight
 * against bots is a threat or a chore — was measured by nobody.
 *
 * So measure it directly. Park a live, registered player in the open at a fixed
 * range with clear line of sight, give it no way to fight back, and time how long
 * it takes N bots to kill it. That is the difficulty setting, in seconds.
 *
 * WHAT IT IS NOT. Not a balance verdict — a stationary player who never shoots
 * or takes cover is a floor, not a fight, and the number will always be shorter
 * than real play. Its value is COMPARATIVE: run it before and after a change to
 * `weaponDamage`, `spread`, the reaction curve or the burst cooldowns and read
 * the difference. A single absolute reading means very little.
 *
 * Ranges are the ones the map actually produces (`botfight.mjs` pools hit
 * distances: p25 9.3, p50 14.4, p75 19.8 m), so the medians below are sampled
 * where fights happen rather than where a test bench is convenient.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOT IN `npm test`, AND WHY
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It is a diagnostic, not a gate, because it is not trustworthy enough to be
 * one yet. Known fault, visible in its own output: the enemy roster attrits.
 * `stopMatch` means no respawns, and one enemy dies during the first trial —
 * grenades are the likely culprit, since two bots stood 2.2 m apart both
 * throwing at the same player will catch each other — after which every later
 * trial reports `only 1 live enemies left` and measures nothing.
 *
 * That is reported rather than hidden: an earlier version `break`ed out of the
 * loop instead, so a range would print one sample and no failure, which reads
 * as a quiet result rather than as a harness that ran out of people.
 *
 * Eight instrument faults were found and fixed while building it — wrong health
 * accessor, `damage:dealt` filtered on an identity it never carries, bots picked
 * without regard to team so the player's own side was stood in front of it,
 * non-participants herded onto one spot where they killed each other,
 * `undefined` slipping through a `!== null` filter, bots dropped in facing away
 * from the target, a 20 m range with a container in the lane, and the silent
 * truncation above. Each of them produced a plausible number first.
 *
 *   node tools/threat.mjs
 *   node tools/threat.mjs --bots=1 --trials=5
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
/**
 * Engagement ranges, taken from the pooled hit distances this map produces
 * (`botfight.mjs`: p25 9.3, p50 14.4, p75 19.8 m).
 *
 * 20 m is NOT in the default set, and the reason is a property of the lane
 * rather than of the guns: the warehouse puts a container across the
 * spawn-to-spawn line, so bots stood off 20 m down the long axis from z=-16
 * have no line of sight and the trial is rejected before it starts. Four of
 * four, every time. Pass `--ranges=9,14,20` to see it reported as such.
 */
const RANGES = (args.ranges ? String(args.ranges).split(',').map(Number) : [9, 14]);
const BOTS = Number(args.bots ?? 2);
const TRIALS = Number(args.trials ?? 4);
/** Give up on a trial after this long and record it as a survival. */
const CAP_S = Number(args.cap ?? 25);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  vite = spawn('npx', ['vite', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 80 && !(await portOpen(PORT)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const out = await page.evaluate(
  async ({ RANGES, BOTS, TRIALS, CAP_S }) => {
    const e = window.__ENGINE__;
    const ai = e.ctx.get('ai');
    const match = e.ctx.get('match');
    const player = e.ctx.get('player');
    const ph = e.ctx.get('physics');

    match.stopMatch();

    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const tick = () => (++i >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });

    // The player must be a REGISTERED, LIVE combatant or nothing will shoot at
    // it — `botfight.mjs` unregisters it for the opposite reason, and copying
    // that here would measure a room with nobody in it.
    if (!match.combatants.includes?.(player) && match.register) {
      try { match.register(player); } catch { /* already in */ }
    }

    // Control off so it cannot fight back, look around or take cover. This is a
    // floor measurement on purpose: the same posture every trial, so the only
    // thing that changes between runs is the thing being changed.
    player.setControlEnabled(false);

    const sample = ai.agents[0];
    const knobs = sample ? {
      weaponDamage: sample.weaponDamage,
      spread: sample.spread,
      fireRate: sample.fireRate,
    } : null;

    const rows = [];
    for (const range of RANGES) {
      const times = [];
      for (let t = 0; t < TRIALS; t++) {
        // Down the long axis with bare floor between, the same corridor
        // `ballistics.mjs` measures cones in, so line of sight is not in doubt.
        const pz = -16;
        player.respawn?.({ position: { x: 0, y: 0.03, z: pz }, yaw: Math.PI });
        player.teleport({ x: 0, y: 0.03 + 1.66, z: pz }, Math.PI);
        player.health.reset?.(true);
        await frames(2);

        // Stand the bots off at `range`, spread across the lane so they are not
        // all firing through one another.
        // ENEMIES of the player, and nobody else in the room.
        //
        // This took whichever bots happened to be alive, which meant it could
        // stand the player's OWN TEAM in front of it — they do not shoot, so the
        // trial measured a staring contest — while the rest of the roster fought
        // each other in the background and wandered into the lane. It showed as
        // `dead` bots in the end-of-trial dump at a range where the player was
        // supposed to be the only thing being shot at.
        const foes = ai.agents.filter((a) => a.alive && a.team && a.team !== player.team);
        const live = foes.slice(0, BOTS);
        // `continue` with a reason, not `break`. Breaking truncated the run
        // silently: a range would report a single trial and no failure, which
        // reads as a quiet result rather than as a harness that ran out of
        // people to shoot the player. The roster does empty — `stopMatch` means
        // no respawns — so this has to degrade visibly.
        if (live.length < BOTS) {
          times.push({ s: null, reason: `only ${foes.length} live enemies left` });
          continue;
        }
        // Everyone else is FROZEN where they stand, not herded into a corner.
        //
        // Parking both teams on one spot turned the corner into a brawl: they
        // killed each other, the enemy roster ran dry, and `live.length < BOTS`
        // broke the trial loop after a single trial — a run that reports one
        // sample and no failure looks like a quiet result rather than a harness
        // eating itself. `frozen` routes an agent to `_hold`, so it neither
        // fights nor dies nor wanders into the lane.
        for (const a of ai.agents) {
          if (live.includes(a)) { a.frozen = false; continue; }
          a.frozen = true;
        }
        live.forEach((a, i) => {
          const off = (i - (BOTS - 1) / 2) * 2.2;
          a.controller?.teleport?.(off, 0.03, pz + range);
          a.position.set(off, 0.03, pz + range);
          a.hasTarget = false;
          a.awareness = 0;
          // Facing the player. Perception is a cone in front, so a bot dropped
          // in pointing the other way spends the trial turning round: at 14 m,
          // five trials of six ran out the 25 s cap before anyone had fired.
          // That is a measurement of where the harness happened to leave a
          // heading, not of how dangerous a bot is once it is in a fight.
          a.yaw = Math.atan2(-off, range);
        });
        await frames(2);

        // A trial in which nobody could see the player is not a measurement.
        const los = live.some((a) =>
          ph.lineOfSight(a.head ?? a.position, player.eyePosition, ph.MASK.SIGHT));
        if (!los) { times.push({ s: null, reason: 'no line of sight' }); continue; }

        /**
         * Two clocks, because the trial contains two different questions and
         * only one of them moves when a damage number moves.
         *
         *   ACQUIRE   spawn -> first round on target. Perception cone, the
         *             reaction curve, whether a bot happened to be facing the
         *             right way. This is where nearly all the variance lives:
         *             measured at 9 m with damage 17, four trials gave 0.3,
         *             12.1, 17.8 and 22.0 s.
         *   LETHAL    first hit -> death. Shots to kill, fire rate, and how
         *             often the cone connects. This is the one `weaponDamage`
         *             is for, and it is quiet enough to compare.
         *
         * Reporting only the sum is what made the first version unusable for
         * the comparison it exists to make.
         */
        // Watched on the PLAYER'S HP, not on `damage:dealt`.
        //
        // The event carries `target = p.actor`, which is the physics actor and
        // not this object, so filtering it by identity counted zero hits through
        // a trial that ended in a death — a probe reporting nothing looks exactly
        // like a probe that is broken. Health is the thing being measured, it is
        // a public getter, and it cannot be wrong about whether the player was
        // shot.
        const t0 = e.time.elapsed;
        const hp0 = player.health.value ?? 100;
        let firstHit = -1;
        let hits = 0;
        let prevHp = hp0;
        let died = false;
        while (e.time.elapsed - t0 < CAP_S) {
          await frames(1);
          const hp = player.health.value ?? 100;
          if (hp < prevHp - 0.01) {
            hits++;
            if (firstHit < 0) firstHit = e.time.elapsed;
          }
          prevHp = hp;
          if (player.dead || hp <= 0) { died = true; break; }
        }
        // WHY nothing happened, for the trials where nothing happened.
        //
        // "no hits" and "no shots" look identical from a damage counter and want
        // opposite fixes — a cone too wide versus a bot that never pulls the
        // trigger. `wantFire` is gated on `peeking` (see `_combat`), so a bot
        // that decides to advance or hold cover instead of peeking is silent no
        // matter how lethal its rounds would have been.
        const why = died ? null : live.map((a) => ({
          state: a.state,
          d: +a.position.distanceTo(player.position).toFixed(1),
          target: !!a.hasTarget,
          visible: !!a.targetVisible,
          peeking: !!a.peeking,
          wantFire: !!a.wantFire,
        }));
        times.push({
          s: died ? +(e.time.elapsed - t0).toFixed(2) : null,
          why,
          acquire: firstHit >= 0 ? +(firstHit - t0).toFixed(2) : null,
          lethal: died && firstHit >= 0 ? +(e.time.elapsed - firstHit).toFixed(2) : null,
          hits,
          reason: died ? 'killed' : 'survived the cap',
          hp: Math.round(player.health.value ?? -1),
        });
        player.health.reset?.(true);
        await frames(2);
      }
      rows.push({ range, times });
    }

    player.setControlEnabled(true);
    player.health.reset?.(true);
    return { knobs, rows, bots: BOTS };
  },
  { RANGES, BOTS, TRIALS, CAP_S }
);

await browser.close();
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ report */

const fail = [];
if (!out?.rows?.length) {
  console.log('\nTHREAT FAILED — no trials ran');
  process.exit(1);
}

console.log(
  `  bot knobs: damage ${out.knobs?.weaponDamage} (player HP 100 -> ` +
  `${Math.ceil(100 / (out.knobs?.weaponDamage || 1))} shots) · ` +
  `spread ${out.knobs?.spread} rad · fireRate ${out.knobs?.fireRate}/s · ${out.bots} bot(s)`
);

let measured = 0;
// `undefined` is not `null`: a trial that never got line of sight has no
// `acquire` key at all, and a `!== null` filter waved it straight through into
// `toFixed`. Finite-only, and an empty set is null rather than NaN.
const median = (v) => {
  const f = v.filter(Number.isFinite).sort((a, b) => a - b);
  return f.length ? f[Math.floor(f.length / 2)] : null;
};
for (const r of out.rows) {
  const dead = r.times.filter((t) => t.s !== null);
  measured += dead.length;
  const ttd = median(dead.map((t) => t.s));
  const lethal = median(dead.map((t) => t.lethal));
  const acquire = median(r.times.map((t) => t.acquire));
  const survived = r.times.length - dead.length;
  console.log(
    `  ${String(r.range).padStart(3)} m · ` +
    `acquire ${acquire === null ? '  —  ' : `${acquire.toFixed(2)}s`} · ` +
    // The comparable half, printed with its spread because that is what says
    // whether a difference between two runs is a difference at all.
    `LETHAL ${lethal === null ? '  —  ' : `${lethal.toFixed(2)}s`} ` +
    `[${dead.map((t) => (t.lethal ?? 0).toFixed(1)).join(', ')}] · ` +
    `hits ${median(r.times.map((t) => t.hits)) ?? 0} · ` +
    `ttd ${ttd === null ? 'never' : `${ttd.toFixed(1)}s`}` +
    (survived ? ` · ${survived} survived the cap` : '')
  );
  // WHY the trials that produced nothing produced nothing.
  //
  // The harness already knew and did not say: a trial with no line of sight is
  // rejected before the clock starts and only leaves a `reason`, which nothing
  // printed. So "0 hits at 20 m" read as "bots will not engage at range" when it
  // may just be a container in the lane — a conclusion about the AI drawn from a
  // fact about the map, which is the same mistake in a different costume.
  const reasons = {};
  for (const t of r.times) reasons[t.reason ?? '—'] = (reasons[t.reason ?? '—'] ?? 0) + 1;
  const spread = Object.entries(reasons).map(([k, v]) => `${v}x ${k}`).join(', ');
  if (!r.times.every((t) => t.reason === 'killed')) {
    console.log(`        outcomes: ${spread}`);
  }
  const why = r.times.find((t) => t.why)?.why;
  if (why) {
    console.log(`        at the bell: ` + why.map((w) =>
      `${w.state} ${w.d}m target=${w.target} visible=${w.visible} peeking=${w.peeking} wantFire=${w.wantFire}`
    ).join(' | '));
  }
}

// A run in which the player never died measured nothing — the same shape as a
// harness that failed to put anybody in the room, which is exactly why it is
// asserted rather than reported as a very high number.
if (measured === 0) {
  fail.push('the player survived every trial at every range — nothing was measured');
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nTHREAT FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nTHREAT OK — comparative only; read it against a previous run, not on its own');
