#!/usr/bin/env node
/**
 * Bot-vs-bot elimination — M4's completion criterion.
 *
 * "The bots fight each other to elimination without a player." That sentence is
 * the whole test, and it is worth having as a harness rather than as a thing you
 * squint at on screen, because every way it can fail looks like something else
 * from the outside:
 *
 *   - perception still resolving to the player -> both teams walk to the spawn
 *     and stand there, which reads as "pathfinding is broken"
 *   - `enemiesOf` returning allies -> a team shoots itself out, which reads as
 *     "the bots are stupid"
 *   - hitboxes on the wrong layer -> everyone fires forever and nobody drops,
 *     which reads as "damage is too low"
 *
 * So this asserts the shape of the fight, not just that it ended: both sides
 * deal damage, kills are credited across teams rather than within them, and the
 * match actually terminates.
 *
 * The player is unregistered from `match` and parked out of the way. "Without a
 * player" is the criterion, and leaving it registered but inert held an alpha
 * seat — which made every run a 3-v-4 and told you more about the roster than
 * about the AI.
 *
 *   node tools/botfight.mjs
 *   node tools/botfight.mjs --seconds=90 --perTeam=6
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
 * 150 s, raised from 110, which was raised from 75.
 *
 * Each raise has had the same cause: the fight got longer for a reason someone
 * chose. 75 -> 110 was the clean round reset, which added the walk from the
 * spawns to every run. 110 -> 150 is the map — `world/warehouse.js` gained a
 * container on each spawn-to-spawn line to stop the two spawn courts seeing each
 * other at the bell, and cover that stops an opening peek also stops a quick
 * elimination.
 *
 * Measured across eleven runs on the new map: 27, 37, 42, 49, 53, 68, 69, 73,
 * 80, 92, 93 s. 110 sits inside that spread, which is a coin toss dressed as a
 * gate — it failed one run in six with every survivor still in COMBAT. 150 is
 * clear of the longest by 57 s.
 *
 * Raising a budget is the wrong fix for a stalemate and the right one for a
 * slower fight, so the `ranOut` message below now says which it saw rather than
 * leaving the next person to guess.
 */
const SECONDS = Number(args.seconds ?? 150);
const PER_TEAM = Number(args.perTeam ?? 5);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let vite = null;
if (!(await portOpen(PORT))) {
  // `OW_NO_HMR=1`: the server this harness owns must not hot-reload.
  //
  // `vite.config.js` has carried the guard and the explanation since the capture
  // harness needed it — a file saved while a run is in flight reloads the page
  // and playwright fails the in-flight `page.evaluate` with "Execution context
  // was destroyed" — and `tools/capture.mjs` was the only tool that set it. Every
  // tool here spawns the same server for the same reason, and in `npm test` the
  // one that wins the race owns it for the whole chain, so the guard has to be on
  // all of them or it is on none of the ones that matter. Cost when nothing is
  // being edited: nothing.
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
  ({ SECONDS, PER_TEAM }) =>
    new Promise((done) => {
      const e = window.__ENGINE__;
      const ai = e.ctx.get('ai');
      const match = e.ctx.get('match');
      const player = e.ctx.get('player');

      // "Without a player" is the criterion, so take the player out of the
      // roster rather than merely parking it. Leaving it registered but inert
      // held an alpha seat, which made every run a 3-v-4 — and in an elimination
      // fight a one-man deficit compounds (the side that lands the first kill
      // spends the rest of the round a man up), so the numbers said more about
      // the roster than about the AI.
      // Rounds off. This harness asks one question — can bots fight each other
      // to elimination — and the round loop would answer a different one: it
      // freezes the opening seconds, and the moment a side is wiped it resets
      // the level and stands everyone back up, so "was anyone eliminated" stops
      // being observable. `tools/matchsim.mjs` tests the loop itself.
      match.stopMatch();

      player.setControlEnabled(false);
      // On the roof at z = 0, not in a corner of the floor. `unregister` takes
      // the player out of the match but leaves the character capsule in physics,
      // so a parked body is an obstacle — and this one was parked inside alpha's
      // spawn court, which is most of why this harness reported alpha losing 5-1
      // while dealing a third of bravo's damage. See the long note in
      // `tools/matchsim.mjs`, and `tools/symmetry.mjs` for the map's own verdict.
      player.teleport({ x: 18, y: 7.9, z: 0 }, 0);
      match.unregister(player);

      // Now a genuine N-a-side. populate() is a top-up, so this completes both
      // teams rather than doubling them.
      ai.populate({ perTeam: PER_TEAM });

      // Start from a clean, symmetric state.
      //
      // Several seconds pass between the level booting and this callback
      // running — page load, shader compilation, __READY__ — and the bots fight
      // through all of it. Measured over three runs, that pre-roll consistently
      // handed bravo the match (alpha dealt 24, 164 and 609 damage against
      // bravo's 750, 788 and 771): whichever side happened to be winning when
      // the harness looked up was already a man up and stayed that way.
      //
      // resetRound() is the round machine's own reset, so this also means the
      // fight being measured starts from exactly the formation a real round
      // starts from, rather than from wherever the pre-roll left everybody.
      match.resetRound();

      const deaths = [];
      const off = e.events.on('combatant:death', (d) => {
        deaths.push({
          victim: d.combatant.name,
          victimTeam: d.combatant.team,
          killer: d.source?.name ?? null,
          killerTeam: d.source?.team ?? null,
          headshot: !!d.headshot,
          part: d.part,
          t: +e.time.elapsed.toFixed(1),
        });
      });

      const start = e.time.elapsed;
      const stallPrev = new Map();
      const stalls = new Map();
      const roster = {
        alpha: match.aliveCount('alpha'),
        bravo: match.aliveCount('bravo'),
        agents: ai.agents.length,
      };
      let peakAgents = 0;

      /**
       * Which bots ever acquired an enemy, by team.
       *
       * "Dealt no damage" cannot tell a broken team from a beaten one, and both
       * happen here: a 5-a-side with no respawns compounds first blood, so a
       * side can legitimately be wiped having fired and missed — one run landed
       * at 23 damage, which is a single burst away from zero. Failing on the
       * damage figure alone therefore fails on bad luck, and the failure it is
       * actually written to catch — perception resolving to nobody, so a whole
       * side never sees an enemy — is the one where `hasTarget` was never true.
       */
      const acquired = { alpha: 0, bravo: 0 };

      const tick = () => {
        peakAgents = Math.max(peakAgents, ai.stats.alive ?? 0);
        for (const ag of ai.agents) {
          if (ag.alive && ag.hasTarget && ag.team) acquired[ag.team]++;
        }
        /**
         * A bot that WANTS to move and does not.
         *
         * Not "a bot that is not moving" — planting at a cover point and
         * shooting is the whole of `_combat`, and a bot doing that legitimately
         * holds still for tens of seconds. The defect this catches is the
         * contradictory state: `desiredSpeed` set, and the world position not
         * changing anyway. That is what an unroutable destination looks like
         * from the outside, and it is how the nav faults found here presented —
         * a bot at `desiredSpeed` 3.2 with `hasMoveTarget` false, motionless for
         * 111 s, while the player watched a statue.
         */
        for (const ag of ai.agents) {
          if (!ag.alive || match.frozen) { stallPrev.delete(ag.id); continue; }
          const pv = stallPrev.get(ag.id);
          stallPrev.set(ag.id, { x: ag.position.x, z: ag.position.z, t: e.time.elapsed });
          if (!pv) continue;
          const wants = (ag.desiredSpeed ?? 0) > 0.1;
          const moved = Math.hypot(ag.position.x - pv.x, ag.position.z - pv.z);
          const rec = stalls.get(ag.id) ?? { cur: 0, worst: 0, state: null, at: null };
          if (wants && moved < 0.004) {
            rec.cur += e.time.elapsed - pv.t;
            if (rec.cur > rec.worst) {
              rec.worst = rec.cur;
              rec.state = ag.state;
              // The state AT the worst moment, not just its length. "8 s in
              // combat" says a bot was stuck and nothing about why; the unstick
              // path only arms on `lastMoveBlocked && speed > 0.5`, so whether
              // those two were true is the whole diagnosis, and it is only
              // observable while it is happening.
              rec.at = {
                pos: [+ag.position.x.toFixed(2), +ag.position.z.toFixed(2)],
                speed: +(ag.speed ?? 0).toFixed(2),
                desired: +(ag.desiredSpeed ?? 0).toFixed(2),
                blocked: !!ag.controller?.lastMoveBlocked,
                grounded: !!ag.grounded,
                stuckTimer: +(ag.stuckTimer ?? 0).toFixed(2),
                stuckCount: ag.stuckCount ?? 0,
                path: `${ag.pathIndex ?? -1}/${ag.pathLen ?? -1}`,
                moveTarget: !!ag.hasMoveTarget,
                pending: !!ag.pathPending,
              };
            }
          } else rec.cur = 0;
          stalls.set(ag.id, rec);
        }
        const elapsed = e.time.elapsed - start;
        const a = match.aliveCount('alpha');
        const b = match.aliveCount('bravo');
        const over = a === 0 || b === 0;
        if (over || elapsed > SECONDS) {
          off();
          const byTeam = {};
          for (const c of match.combatants) {
            const t = (byTeam[c.team] ??= { kills: 0, deaths: 0, damage: 0 });
            t.kills += c.kills;
            t.deaths += c.deaths;
            t.damage += Math.round(c.damageDealt);
          }
          done({
            roster,
            // A* rationing, reported rather than assumed. `_ensureGoal` skips a
            // bot whose path is still queued, so a starved budget and a genuine
            // stall look identical from the outside.
            pathsDeferred: ai.stats?.pathsDeferred ?? null,
            pathsPerFrame: ai.pathsPerFrame,
            stalls: [...stalls].map(([id, r]) => ({ id, worst: +r.worst.toFixed(1), state: r.state, at: r.at }))
              .sort((p, q) => q.worst - p.worst),
            elapsed: +elapsed.toFixed(1),
            ranOut: !over,
            aliveAlpha: a,
            aliveBravo: b,
            deaths,
            byTeam,
            acquired,
            teamKills: deaths.filter((d) => d.killer && d.killerTeam === d.victimTeam).length,
            unattributed: deaths.filter((d) => !d.killer).length,
            headshots: deaths.filter((d) => d.headshot).length,
            peakAgents,
            aiStats: ai.stats,
            // Who is left, and what are they doing? A stalemate reported as a
            // bare "no side was eliminated" says nothing about whether the
            // survivors are hunting each other, standing still, or stuck on
            // geometry — and that is the only question worth asking about it.
            survivors: over ? null : ai.agents.filter((x) => x.alive).map((x) => ({
              n: x.combatant?.name, team: x.team, state: x.state,
              hasTarget: !!x.hasTarget, visible: !!x.targetVisible,
              awareness: +(x.awareness ?? 0).toFixed(2),
              lastKnownAge: Number.isFinite(x.lastKnownAge) ? +x.lastKnownAge.toFixed(1) : null,
              speed: +(x.speed ?? 0).toFixed(2),
              // Y, not just X and Z.
              //
              // The floor is at 0 and the centre block is 2.7 m tall, so the
              // height is the single number that separates "wedged in a corner"
              // from "standing on a roof" — and this dump used to drop it. Two
              // stalemates were read as a bot embedded INSIDE the centre island
              // because (1.9, -0.7) is inside its footprint when you only have
              // the footprint.
              at: [+x.position.x.toFixed(1), +x.position.y.toFixed(2), +x.position.z.toFixed(1)],
              // Is it hunting, and does it have anywhere to go? A patrol bot at
              // speed 0 is either holding by the mutual-pursuit rule (by design)
              // or has no route it can solve (a bug), and those look identical
              // from outside.
              hunting: !!x.hunting,
              moving: !!x.hasMoveTarget,
              // Distance to the nearest living enemy, and whether it can see it.
              // A stalemate where everyone is 30 m apart is a different failure
              // from one where two men are 4 m apart and blind to each other.
              // Is this bot standing INSIDE something?
              //
              // Cast down from above the roof line at the bot's own x/z. Open
              // floor answers ~0; anything else is the underside of whatever the
              // bot is buried in, and its height names the piece. Asking from a
              // known-outside point avoids the question of whether the physics
              // backend reports back-face hits for a ray that starts inside a
              // solid, which is exactly the case under investigation.
              overhead: (() => {
                const ph = e.ctx.get('physics');
                const h = ph.raycast(x.position.x, 5.5, x.position.z, 0, -1, 0, 7, ph.MASK.WORLD);
                return h.hit ? +(5.5 - h.distance).toFixed(2) : null;
              })(),
              nearest: (() => {
                let d = Infinity;
                let who = null;
                for (const en of ai.enemiesOf(x)) {
                  const dd = x.position.distanceTo(en.position);
                  if (dd < d) { d = dd; who = en; }
                }
                if (!who) return null;
                const ph = e.ctx.get('physics');
                return {
                  n: who.name ?? null,
                  d: +d.toFixed(1),
                  los: !!ph.lineOfSight(x.head ?? x.position, who.head ?? who.position),
                };
              })(),
            })),
            // Does the mutual-pursuit tie-break favour a side?
            //
            // Of two bots hunting each other the lower-id one closes and the
            // other holds its angle, and holding an angle is an advantage. The
            // id is a creation counter, so the split is whatever the boot order
            // happens to produce: measured on the standard roster, alpha
            // [1,2,3,8,9] against bravo [4,5,6,7,10], alpha closes on 17 of 25
            // pairs. This map is gated on mirror symmetry
            // (`tools/symmetry.mjs`); a standing per-team handicap in the AI
            // bends the same invariant from the other side.
            //
            // Reported rather than gated tightly, because the harm is
            // undemonstrated — 20 botfights gave alpha 7 / bravo 13, not
            // significant — and because a scramble is not a fix: hashing the id
            // was tried and landed on 20%, further from even than the 68% it
            // replaced. Five fixed ids a side cannot be spread evenly by luck.
            // The number is printed every run so a drift is seen rather than
            // argued about.
            //
            // The comparison is `this.id > other.id` in `agent.js` PATROL and is
            // reproduced here because it is one operator; if it ever grows into
            // a function, call that instead of copying it.
            pressShare: (() => {
              const A = ai.agents.filter((x) => x.team === 'alpha');
              const B = ai.agents.filter((x) => x.team === 'bravo');
              let alphaPresses = 0;
              let pairs = 0;
              for (const a of A) {
                for (const b of B) {
                  pairs++;
                  if (a.id < b.id) alphaPresses++;
                }
              }
              // The raw ids as well as the share. The share alone cannot tell
              // "the rank is team-correlated" from "the harness is modelling the
              // roster wrong", and an assumption about how ids are handed out is
              // exactly what produced a wrong prediction here once already.
              return pairs
                ? {
                  pairs,
                  alpha: +(alphaPresses / pairs).toFixed(3),
                  alphaIds: A.map((x) => x.id),
                  bravoIds: B.map((x) => x.id),
                }
                : null;
            })(),
            survivorGap: over ? null : (() => {
              const live = ai.agents.filter((x) => x.alive);
              if (live.length !== 2) return null;
              const ph = e.ctx.get('physics');
              return {
                d: +live[0].position.distanceTo(live[1].position).toFixed(1),
                los: !!ph.lineOfSight(live[0].head ?? live[0].position,
                  live[1].head ?? live[1].position, ph.MASK.SIGHT),
              };
            })(),
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { SECONDS, PER_TEAM }
);

const fail = [];
/** Legitimate one-sided results, reported but not failed. See `acquired`. */
const routed = [];
const lostAlpha = out.deaths.filter((d) => d.victimTeam === 'alpha').length;
const lostBravo = out.deaths.filter((d) => d.victimTeam === 'bravo').length;

if (out.deaths.length === 0) {
  fail.push('nobody died in the whole run — the bots never engaged each other');
}
// NOT "both sides must lose someone". An earlier version asserted that and it
// was wrong: in an elimination fight one side sweeping is an ordinary outcome,
// because concentrated fire compounds — whoever lands the first kill spends the
// rest of the round a man up.
//
// What actually has to be true is that both sides FOUND targets and shot at
// them. A team that deals zero damage across a whole match is the signature of
// broken perception, and that is the thing worth failing on.
for (const team of ['alpha', 'bravo']) {
  if ((out.byTeam[team]?.damage ?? 0) <= 0) {
    if (!out.acquired[team]) {
      fail.push(
        `${team} dealt no damage AND never acquired a target across ${out.elapsed}s — ` +
        `perception is resolving to nobody for that side`
      );
    } else {
      routed.push(
        `${team} was wiped for 0 damage having held a target on ${out.acquired[team]} frames`
      );
    }
  }
}
// 0.85, not 0.5: with five a side there are only 25 cross-team pairs, so the
// split is coarse and a tight bound would fail on lumpiness rather than on bias.
// What has to be impossible is the degenerate case: one side pressing in every
// pair, which is what strictly team-ordered ids would produce. The measured 68%
// is reported, not failed on — see the note where pressShare is computed.
if (out.pressShare && (out.pressShare.alpha > 0.85 || out.pressShare.alpha < 0.15)) {
  fail.push(`mutual-pursuit tie-break favours a side: alpha closes on `
    + `${(out.pressShare.alpha * 100).toFixed(0)}% of ${out.pressShare.pairs} cross-team pairs `
    + '— the rank is correlated with team, so one side always holds the angle');
}
if (out.teamKills > 0) {
  fail.push(`${out.teamKills} team kill(s) — enemiesOf() is handing bots their own side`);
}
if (out.unattributed > out.deaths.length * 0.25) {
  fail.push(`${out.unattributed}/${out.deaths.length} deaths had no killer — attribution is dropping shots`);
}
// The part on a death record has to come from a hitbox, and the two hitbox
// tables in this codebase (`ai/agent.js` HITBOXES and `match/combatant.js`
// HITBOXES) both use these four lowercase labels. Anything else is a BONE name,
// and bone names come from exactly one place: `physics.raycast` resolving a hit
// against a RAGDOLL, which used to emit `damage:dealt` for a body on the floor
// and overwrite the victim's attribution between the fatal round and the death
// record. The symptom was a headshot recorded as `part: 'Head', headshot:
// false` — the flag is `part === 'head'`, and the bone is capitalised — so the
// vocabulary is the tell, and it is cheaper and sharper to check than either
// symptom.
const PARTS = new Set(['head', 'torso', 'arm', 'leg']);
const alien = out.deaths.filter((d) => d.part && !PARTS.has(d.part));
if (alien.length) {
  fail.push(`${alien.length} death(s) record a part outside the hitbox vocabulary `
    + `(${[...new Set(alien.map((d) => d.part))].join(', ')}) — `
    + 'that is a bone name, so a corpse hit is being counted as a wound');
}
// And a head hit has to BE a headshot. The two fields are set from the same
// `part` one line apart in `physics.emitImpact`, so disagreeing means something
// rewrote one of them after the fact.
const mismatched = out.deaths.filter((d) => (d.part === 'head') !== !!d.headshot);
if (mismatched.length) {
  fail.push(`${mismatched.length} death(s) disagree between part and headshot flag `
    + `(${mismatched.map((d) => `${d.victim} part=${d.part} headshot=${d.headshot}`).join('; ')})`);
}
if (out.ranOut) {
  // Say WHICH of the two failures this is.
  //
  // "No side was eliminated" covers a stalemate — survivors who cannot find
  // each other, which is the bug this harness exists to catch — and a fight
  // that was simply still going at the bell, which is a budget that is too
  // short. They want opposite fixes, and the bare message sent me to the AI
  // twice for what turned out to be the second one: the dump showed all three
  // survivors in COMBAT, targets visible, moving at 4 m/s.
  const engaged = (out.survivors ?? []).filter((s) => s.hasTarget || s.state === 'combat').length;
  const roll = (out.survivors ?? []).map((s) =>
    `${s.n} ${s.state} target=${s.hasTarget} lastSeen=${s.lastKnownAge}s`
    + ` at ${s.at.join("/")} spd ${s.speed} hunt=${s.hunting} moving=${s.moving} under=${s.overhead}`
    + (s.nearest ? ` nearest ${s.nearest.n} ${s.nearest.d}m los=${s.nearest.los}` : '')
  ).join('\n    ');
  fail.push(
    (engaged > 0
      ? `still fighting at the ${SECONDS}s bell (alpha ${out.aliveAlpha}, bravo ${out.aliveBravo}) ` +
        `— ${engaged} survivor(s) engaged, so this is the budget, not a stalemate`
      : `no side was eliminated inside ${SECONDS}s (alpha ${out.aliveAlpha}, bravo ${out.aliveBravo}) ` +
        `— nobody was engaged at the bell, which is a stalemate`) +
    (roll ? `:\n    ${roll}` : '')
  );
}
/**
 * A bot may stand still. It may not stand still while trying to walk.
 *
 * A bot holding cover reports `desiredSpeed` 0 and never enters this count at
 * all, which is what makes the count meaningful: everything in it is a bot whose
 * own state machine asked for a speed it did not get.
 *
 * 6 s, down from the 8 this shipped with, and the reason is worth keeping. 8 was
 * set while the worst case was a bot with a speed and no waypoint. The spread it
 * was covering for was wide — six runs gave 1.5, 2.0, 1.2, 11.2, 11.9 and 57.6 s
 * — and the long ones all shared a signature the short ones did not:
 * `moveTarget` false, `speed` 0, `stuckCount` 0. Not blocked. Never started, and
 * therefore invisible to an unstick path that arms on
 * `lastMoveBlocked && speed > 0.5`. `Agent._ensureGoal` rescues that case now.
 *
 * After the fix, six runs: 1.2, 1.2, 1.6, 1.6, 2.9, 3.5 s — every one a bot with
 * a route, genuinely shoving at geometry, unstick counter ticking. 6 is a little
 * under twice the top of that.
 *
 * The `at` snapshot recorded above is what separated the two readings. "8 s in
 * combat" is a duration; it took the state at the worst moment to show that two
 * completely different faults were being averaged into one number.
 */
const STALL_CEIL = 6;
const stalled = (out.stalls ?? []).filter((s) => s.worst > STALL_CEIL);
if (stalled.length) {
  fail.push(
    `${stalled.length} bot(s) tried to move and did not: ` +
    // With the snapshot, not just the duration. The two faults this gate has
    // caught so far were indistinguishable by length and obvious by state.
    stalled.slice(0, 4)
      .map((s) => `#${s.id} ${s.worst}s in ${s.state} ${JSON.stringify(s.at ?? {})}`)
      .join(', ') +
    ` (ceiling ${STALL_CEIL}s)`
  );
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

console.log(JSON.stringify(out, null, 2));
console.log(
  fail.length === 0
    ? `\nBOTFIGHT OK — ${out.deaths.length} kills in ${out.elapsed}s · ` +
      `alpha lost ${lostAlpha} dealt ${out.byTeam.alpha?.damage ?? 0}, ` +
      `bravo lost ${lostBravo} dealt ${out.byTeam.bravo?.damage ?? 0} · ` +
      `${out.headshots} headshots, 0 team kills · ` +
      // Reported every run, like pressShare: a stall figure that only appears
      // when it trips the gate is a number nobody can see drifting toward it.
      `worst blocked-move ${(out.stalls?.[0]?.worst ?? 0)}s`
    : `\nBOTFIGHT FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

await browser.close();
if (vite) process.kill(-vite.pid);
process.exit(fail.length === 0 ? 0 : 1);
