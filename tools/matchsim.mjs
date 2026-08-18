#!/usr/bin/env node
/**
 * Five rounds, start to finish, with nobody at the keyboard — M5's completion
 * criterion.
 *
 * The round loop is the one part of this game that cannot be checked by looking
 * at it, because the interesting failures are all several minutes apart and all
 * look like something else while they are happening:
 *
 *   - respawn silently not reviving the dead -> round 2 opens with three
 *     corpses on the floor and ends by "elimination" in one tick, which reads
 *     as "the round timer is broken"
 *   - freeze not actually freezing -> the round is decided during the phase
 *     that exists to stop it being decided, which reads as "the bots are
 *     aggressive"
 *   - the AI keeping its yaw convention, cover claim or perception across a
 *     reset -> round 1 plays fine and every round after it is subtly wrong,
 *     which reads as nothing at all until you count the scores
 *
 * So this asserts the SHAPE of a match: that every round begins with everybody
 * standing and healthy, that nothing moves during freeze, that each round ends
 * for a stated reason, and that the match terminates on its own.
 *
 * The tempo is compressed and the roster is small, because the thing under test
 * is the state machine, not the tempo table — `TEMPO` in `src/match/round.js`
 * is what a human tunes, and this harness deliberately overrides it so that
 * changing it cannot break the test.
 *
 * DO NOT READ TEAM BALANCE OFF THE DEFAULT MODE. The player is registered and
 * has their input cut, so alpha fields three bots plus a statue: a body that
 * never fires, never takes cover and never moves off the spawn tile. That is the
 * right roster for testing the reset path — the player's respawn is the one that
 * differs from every bot's — and the wrong roster for asking who wins. Measured
 * over three matches it read bravo 12, alpha 2, one draw, which looked exactly
 * like a map or variant bias and was neither; `--noplayer` runs the same match
 * without the statue, and `tools/botfight.mjs` (which unregisters the player for
 * this reason) was balanced the whole time.
 *
 *   node tools/matchsim.mjs
 *   node tools/matchsim.mjs --perTeam=4 --live=60
 *   node tools/matchsim.mjs --noplayer      # balance only, not the reset path
 */
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady, bootUrl } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
const PER_TEAM = Number(args.perTeam ?? 3);
const ROUNDS = Number(args.rounds ?? 5);
/**
 * Compressed tempo. `roundsToWin` is set to ROUNDS so the match can only end by
 * hitting `maxRounds` — otherwise a 3-0 sweep would end it at round 3 and the
 * "five rounds ran" assertion would fail on a match that worked perfectly.
 */
const TEMPO = {
  warmup: Number(args.warmup ?? 1),
  freeze: Number(args.freeze ?? 2),
  live: Number(args.live ?? 45),
  roundEnd: Number(args.roundEnd ?? 1.5),
  matchEnd: 2,
  roundsToWin: ROUNDS,
  maxRounds: ROUNDS,
};
/**
 * How much dead air before a clock expiry stops being a close round.
 *
 * The hunt-when-quiet convergence in `ai/agent.js` arms at 15 s of nobody
 * seeing anybody, and crossing the whole 48x36 hall at patrol pace costs about
 * 20 s more. So a round where the last body fell 35 s before the bell had time
 * to converge and did not, whereas one that went quiet for 20 s is just two
 * survivors holding angles — which is the game working.
 *
 * Scaled with `live` so a `--live=120` run is not judged by a 45 s round's
 * budget, floored at 35 so a very short round cannot make the threshold
 * unreachably tight.
 */
const STALL = Math.max(35, Number(args.live ?? 45) * 0.55);
/** Wall-clock ceiling: every round at its full length, plus slack. */
const BUDGET =
  TEMPO.warmup + ROUNDS * (TEMPO.freeze + TEMPO.live + TEMPO.roundEnd) + 20;

const vite = await ensureServer(PORT, { name: 'MATCHSIM' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
// The stack, not just the message: a bare "reading 'x'" names no frame
// and is unactionable, which is exactly how this one went untriaged.
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(1, 5).join('\n')}`));

await page.goto(bootUrl(PORT), { waitUntil: 'load' });
await waitForReady(page, { name: 'MATCHSIM' });

const NO_PLAYER = !!args.noplayer;

const out = await page.evaluate(
  ({ PER_TEAM, TEMPO, BUDGET, NO_PLAYER }) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.get('ai');
      const match = e.ctx.get('match');
      const player = e.ctx.get('player');

      // The player stays REGISTERED and is only denied input. A round reset has
      // to put the player back on their feet exactly as it does a bot — that is
      // the whole point of the Combatant contract — and unregistering them
      // would remove the one host whose respawn path is different from every
      // other host's.
      player.setControlEnabled(false);
      // ...unless we are asking the balance question instead of the reset
      // question, in which case the statue has to come off the board: it is an
      // extra alpha body that must be found and killed for an elimination and
      // that never shoots back.
      if (NO_PLAYER) {
        // ON THE ROOF, and at z = 0.
        //
        // `unregister` takes the player out of the match; it does NOT take the
        // character capsule out of physics. Parked on the floor it is still a
        // pillar the bots have to path around, and it used to be parked at
        // (-22, -17) — inside alpha's spawn court.
        //
        // That one line was the whole "team balance" investigation. Over 28
        // rounds bravo took 22, which read as a map or an AI bias; swapping only
        // the `team` labels on `SPAWNS` moved the win rate with the SIDE, which
        // read as a map bias specifically. It was neither. `tools/symmetry.mjs`
        // then measured the two halves at 10.09 and 10.03 m mean openness — the
        // map is fair — and re-parking the capsule in the opposite corner turned
        // 0-5 into 3-4 with two draws. The harness was handing one team an
        // obstacle in its own spawn court and then asking which team was better.
        //
        // y = 7.9 is the eye above the 6.5 m roof screed, x = 18 keeps it off
        // the skylight glazing, and z = 0 is the mirror plane: if a parked body
        // ever does leak into the sim again it now leaks into both halves
        // equally instead of deciding the match.
        player.teleport({ x: 18, y: 7.9, z: 0 }, 0);
        match.unregister(player);
      }

      match.stopMatch();               // cancel the auto-started match
      // `populate` is a TOP-UP, so this only adds bots if the boot garrison
      // left a side short. The roster we actually got is measured rather than
      // assumed — asserting a number the boot default already decided would be
      // testing `populate`'s default argument, not the round loop.
      //
      // The `Math.max` is not defensive padding, it is the fix for a measured
      // 3-v-4. The boot garrison fills to 4 a side and COUNTS THE PLAYER as one
      // of alpha's four, so alpha boots with 3 bots plus a player and bravo with
      // 4 bots. `--noplayer` then takes alpha's fourth seat off the board, and a
      // top-up to `PER_TEAM` (3) sees both sides already at or above 3 and adds
      // nobody. Every `--noplayer` round ran alpha 3 v bravo 4.
      //
      // That deficit was the entire "team balance" question: bravo took 31 of 50
      // rounds, and swapping the `team` labels on `SPAWNS` moved the win rate
      // with the side, which looked like proof the map was unfair. It was not —
      // `tools/symmetry.mjs` puts the two halves within 0.06 m of mean openness
      // — the labels also swapped which side the missing man was on. Topping up
      // to the largest side makes it N-v-N whatever the garrison did, and the
      // even-teams assertion below is what stops this coming back.
      const biggest = Math.max(
        ...match.TEAM_IDS.map((t) => match.combatants.filter((c) => c.team === t).length)
      );
      ai.populate({ perTeam: Math.max(PER_TEAM, biggest) });
      const rosterAtStart = match.combatants.length;
      match.startMatch(TEMPO);

      const rounds = [];
      const phases = [];
      const ends = [];
      let matchEnd = null;
      /** Largest distance any fighter covered during a freeze phase, metres. */
      let freezeDrift = 0;
      /**
       * Engine time of the most recent death, any round. Never reset: the
       * round:end reader clamps it to that round's own start, so a value left
       * over from the previous round cannot make this round look busier than
       * it was.
       */
      let lastDeathT = 0;
      /** One record per death: team, where it fell, how far into the round. */
      const deaths = [];

      const off = [
        e.events.on('round:phase', (d) => {
          phases.push({ phase: d.phase, round: d.round, t: +e.time.elapsed.toFixed(1) });
        }),
        e.events.on('round:start', (d) => {
          // Snapshot the roster the instant the round goes live. Anyone dead or
          // hurt here was not reset, and everything downstream is meaningless.
          let dead = 0;
          let hurt = 0;
          for (const c of match.combatants) {
            if (!c.alive) dead++;
            const h = c.host;
            const hp = h.health?.value ?? h.health;
            const max = h.health?.max ?? h.maxHealth;
            if (typeof hp === 'number' && typeof max === 'number' && hp < max) hurt++;
          }
          rounds.push({
            round: d.round,
            t: +e.time.elapsed.toFixed(1),
            roster: match.combatants.length,
            alpha: match.aliveCount('alpha'),
            bravo: match.aliveCount('bravo'),
            deadAtStart: dead,
            hurtAtStart: hurt,
          });
        }),
        e.events.on('combatant:death', (d) => {
          lastDeathT = e.time.elapsed;
          // Where and when each side dies.
          //
          // A win-rate tells you a side is losing and nothing about why, and on
          // a map that `tools/symmetry.mjs` certifies as fair the interesting
          // question is whether the losing team is dying in its own half (being
          // pushed) or in the enemy's (over-extending), and whether it is dying
          // early (walked into something) or late (ground down). Two numbers per
          // death answer both, and cost one event handler.
          const c = d.combatant;
          const liveStart = rounds[rounds.length - 1]?.t ?? e.time.elapsed;
          deaths.push({
            round: c ? rounds.length : rounds.length,
            team: c?.team ?? '?',
            z: c ? +c.position.z.toFixed(1) : null,
            x: c ? +c.position.x.toFixed(1) : null,
            intoRound: +(e.time.elapsed - liveStart).toFixed(1),
          });
        }),
        e.events.on('round:end', (d) => {
          const t = e.time.elapsed;
          const liveStart = rounds[rounds.length - 1]?.t ?? t;
          ends.push({
            round: d.round,
            winner: d.winner,
            reason: d.reason,
            t: +t.toFixed(1),
            alpha: match.aliveCount('alpha'),
            bravo: match.aliveCount('bravo'),
            // How long the round spent with nobody dying before the bell. A
            // round that expires on the clock is a legitimate outcome; a round
            // that expires having seen no combat for a minute is two patrol
            // routes that never intersect. Only the second is a bug, and the
            // reason alone cannot tell them apart.
            silence: +(t - Math.max(lastDeathT, liveStart)).toFixed(1),
            // Who was left, and what they thought they were doing. A stall
            // failure that reports only its duration sends you back to the
            // browser to reproduce something that happens one round in five;
            // the FSM state and `lastKnownAge` of each survivor are the two
            // fields that separate "the hunt never armed" from "it armed and
            // they still walked past each other".
            survivors: match.combatants.filter((c) => c.alive).map((c) => {
              const h = c.host;
              let near = Infinity;
              for (const en of match.enemiesOf(c)) {
                if (en.alive) near = Math.min(near, c.position.distanceTo(en.position));
              }
              return {
                name: c.name,
                team: c.team,
                state: h.state ?? (c.isPlayer ? 'player' : '?'),
                lastKnownAge: Number.isFinite(h.lastKnownAge)
                  ? +h.lastKnownAge.toFixed(1) : 'never',
                moving: h.hasMoveTarget ?? null,
                nearestEnemy: Number.isFinite(near) ? +near.toFixed(1) : null,
              };
            }),
          });
        }),
        e.events.on('match:end', (d) => {
          matchEnd = { winner: d.winner, alpha: d.scores.alpha, bravo: d.scores.bravo };
        }),
      ];

      // Freeze verification: remember where everyone was on the first frame of
      // a freeze and measure how far they got by the last one. Sampling only
      // the endpoints is enough — a fighter that walked out and back would
      // still have left, and this is a phase in which nothing should move.
      let freezeMark = null;

      const start = e.time.elapsed;
      /**
       * Wall clock, alongside the engine clock.
       *
       * Every budget here is in ENGINE seconds, and the loop below exits when
       * `e.time.elapsed - start` passes it. That is the right measure for a match
       * and a useless one for a stall: if the engine stops advancing — a paused
       * loop, a throttled tab, a lost WebGL context — `elapsed` freezes, the
       * budget never expires and this hangs forever with no output. It did,
       * inside `npm test`, for half an hour after `botfight` had passed.
       *
       * 2.5x, not 4x. The engine advances on real dt, so a healthy run's engine
       * seconds and wall seconds track each other closely — the successful runs
       * on record finish 263 s of budget in 213-241 s. Frame rate changes how
       * much thinking happens per simulated second, not how fast the clock runs,
       * so a contended machine does not need much slack here. 2.5x leaves room
       * for a slow browser start and still fails inside eleven minutes instead of
       * hanging the whole suite, which is what it did.
       */
      const wallStart = performance.now();
      const WALL_MS = BUDGET * 2500;
      const tick = () => {
        if (match.phase === 'freeze' || match.phase === 'warmup') {
          if (!freezeMark) {
            freezeMark = match.combatants.map((c) => ({
              c, x: c.position.x, z: c.position.z,
            }));
          } else {
            for (const m of freezeMark) {
              const d = Math.hypot(m.c.position.x - m.x, m.c.position.z - m.z);
              if (d > freezeDrift) freezeDrift = d;
            }
          }
        } else {
          freezeMark = null;
        }

        const elapsed = e.time.elapsed - start;
        const wallStalled = performance.now() - wallStart > WALL_MS;
        if (matchEnd || elapsed > BUDGET || wallStalled) {
          for (const o of off) o();
          done({
            elapsed: +elapsed.toFixed(1),
            rosterAtStart,
            rounds,
            ends,
            matchEnd,
            phases,
            freezeDrift: +freezeDrift.toFixed(3),
            scores: { ...match.scores },
            deaths,
            ranOut: !matchEnd,
            // Distinguishes "the match did not finish" from "the simulation
            // stopped running". The verdict below says which.
            wallStalled,
            wallMs: Math.round(performance.now() - wallStart),
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { PER_TEAM, TEMPO, BUDGET, NO_PLAYER }
);

/* ---------------------------------------------------------------- verdict */

const fail = [];
/**
 * Measured, not assumed. A round must not lose or gain fighters, but how many
 * there were to begin with is `ai.populate`'s business.
 */
const expectRoster = out.rosterAtStart;

if (out.rounds.length !== ROUNDS) {
  fail.push(`${out.rounds.length}/${ROUNDS} rounds started — the loop stalled`);
}
for (let i = 0; i < out.rounds.length; i++) {
  const r = out.rounds[i];
  if (r.round !== i + 1) fail.push(`round numbering jumped: saw ${r.round} at index ${i}`);
  if (r.deadAtStart > 0) {
    fail.push(`round ${r.round} opened with ${r.deadAtStart} fighter(s) still dead — respawn did not revive`);
  }
  if (r.hurtAtStart > 0) {
    fail.push(`round ${r.round} opened with ${r.hurtAtStart} fighter(s) below full health — health did not reset`);
  }
  if (r.roster !== expectRoster) {
    fail.push(`round ${r.round} had ${r.roster} fighters, expected ${expectRoster}`);
  }
  if (r.alpha === 0 || r.bravo === 0) {
    fail.push(`round ${r.round} opened ${r.alpha}v${r.bravo} — a side was empty at the bell`);
  }
  // Even sides, or nothing downstream means anything.
  //
  // This is the assertion whose absence cost the most. Every other gate here
  // passed on a roster that was 3 v 4 in every round of every `--noplayer` run:
  // the roster count was right, both sides were non-empty, the loop ran, the
  // match terminated. What it produced was a 31-19 win record that read as a map
  // bias and survived a spawn-label swap, a geometry audit and a harness rewrite
  // before anyone printed the two numbers side by side.
  if (r.alpha !== r.bravo) {
    fail.push(`round ${r.round} opened ${r.alpha}v${r.bravo} — the sides are not even`);
  }
}
if (out.ends.length !== out.rounds.length) {
  fail.push(`${out.rounds.length} rounds started but ${out.ends.length} ended`);
}
for (const d of out.ends) {
  if (!['elimination', 'time', 'draw'].includes(d.reason)) {
    fail.push(`round ${d.round} ended for an unknown reason "${d.reason}"`);
  }
  if (d.reason === 'elimination' && d.alpha > 0 && d.bravo > 0) {
    fail.push(`round ${d.round} claimed elimination with ${d.alpha}v${d.bravo} still standing`);
  }
  if (d.reason !== 'elimination' && d.silence > STALL) {
    fail.push(
      `round ${d.round} ran ${d.silence}s without a death before the bell ` +
      `(${d.alpha}v${d.bravo} alive) — survivors never found each other:\n    ` +
      d.survivors.map((s) =>
        `${s.name} ${s.state} lastSeen=${s.lastKnownAge}s moving=${s.moving} ` +
        `nearestEnemy=${s.nearestEnemy}m`).join('\n    ')
    );
  }
}
// 0.6 m of slack: a capsule settling onto the floor after a teleport, and the
// character controller depenetrating two fighters that spawned close, both move
// somebody a little. A fighter that WALKED would be metres out.
if (out.freezeDrift > 0.6) {
  fail.push(`someone moved ${out.freezeDrift} m during freeze — the hold is not being enforced`);
}
if (out.wallStalled) {
  fail.push(
    `the engine stopped advancing: ${out.elapsed}s of engine time in ${out.wallMs} ms of ` +
    `wall clock. Not a match failure — the simulation was not running.`
  );
} else if (!out.matchEnd) {
  fail.push(`no match:end inside ${BUDGET}s — the match never terminated`);
} else {
  const total = out.matchEnd.alpha + out.matchEnd.bravo;
  if (total > ROUNDS) fail.push(`scores total ${total} across ${ROUNDS} rounds`);
}
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

/**
 * Where each side died, in one line per team.
 *
 * `z` is signed with alpha at -Z and bravo at +Z, so a team's mean death z read
 * against its own spawn says which way the fight moved: alpha dying at z = +5 is
 * alpha dying deep in bravo's half. Reported rather than asserted — there is no
 * threshold here that means anything yet, and a gate nobody can justify is worse
 * than a number somebody reads.
 */
const byTeam = {};
for (const d of out.deaths) {
  const t = (byTeam[d.team] ??= { n: 0, z: 0, into: 0 });
  t.n++;
  t.z += d.z ?? 0;
  t.into += d.intoRound;
}
const deathLine = Object.entries(byTeam)
  .map(([team, t]) => `${team} died ${t.n}x at mean z ${(t.z / t.n).toFixed(1)} ` +
    `after ${(t.into / t.n).toFixed(1)}s`)
  .join(' · ');

console.log(JSON.stringify(out, null, 2));

const line = out.ends
  .map((d) => `R${d.round} ${d.winner ?? 'draw'}/${d.reason}` +
    (d.reason === 'elimination' ? '' : ` (${d.silence}s quiet)`))
  .join(' · ');
console.log(
  fail.length === 0
    ? `\nMATCHSIM OK — ${out.rounds.length} rounds in ${out.elapsed}s · ${line} · ` +
      `final ${out.matchEnd.alpha}-${out.matchEnd.bravo} ` +
      `(${out.matchEnd.winner ?? 'draw'}) · freeze drift ${out.freezeDrift} m` +
      `\n           ${deathLine}`
    : `\nMATCHSIM FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
killServer(vite);
process.exit(fail.length === 0 ? 0 : 1);
