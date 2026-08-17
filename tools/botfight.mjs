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
import { bandEdge, stkBands, formatBands } from './lethality.mjs';
import { parseArgs, ensureServer, killServer, launchChromium } from './harness.mjs';

const args = parseArgs();
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

const vite = await ensureServer(PORT, { name: 'BOTFIGHT' });

const browser = await launchChromium({
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

      /**
       * Two O(cells) sweeps, run once per long stall by the caller.
       *
       * `probePath` runs the query the bot keeps failing, using its own scratch
       * buffer so it cannot perturb the agent. `reach` floods from the bot cell
       * with EXACTLY the neighbour rules `findPath` expands with and compares
       * what that reaches against what `component` claims — deduction has killed
       * four hypotheses here, so this counts the map instead of arguing about it.
       */
      const deepProbe = (ag) => {
  const probePath = (() => {
                  const g = ai.grid;
                  if (!g?.findPath || !ag.path?.[0]?.clone) return null;
                  let gi = -1;
                  for (let i = 0; i < g.flags.length; i++) {
                    if (g.flags[i] && g.inMainComponent(i)) { gi = i; break; }
                  }
                  if (gi < 0) return null;
                  const dest = {
                    x: g.worldX(gi % g.nx),
                    y: g.floor[gi],
                    z: g.worldZ((gi / g.nx) | 0),
                  };
                  const scratch = [];
                  for (let k = 0; k < 256; k++) scratch.push(ag.path[0].clone());
                  const n = g.findPath(ag.position, dest, scratch);
                  const st = g.nearest(ag.position.x, ag.position.z, ag.position.y);
                  const go = g.nearest(dest.x, dest.z, dest.y);
                  return {
                    n, start: st, goal: go,
                    startComp: g.component ? g.component[st] : null,
                    goalComp: g.component ? g.component[go] : null,
                    destAwayM: +Math.hypot(dest.x - ag.position.x, dest.z - ag.position.z).toFixed(1),
                  };
                })();
                /**
                 * Flood the grid from the bot's own cell using EXACTLY the
                 * neighbour rules `findPath` expands with, and compare the size
                 * of what that reaches against the size `component` claims.
                 *
                 * `component` is built by `_buildComponents` with what looks
                 * like the identical predicate, and A* still reports no route
                 * between two cells it labels the same — so one of the two is
                 * wrong about the map and reading both source functions has not
                 * said which. This counts it. `reached` far below `claimed`
                 * means the label is promising connectivity the pathfinder does
                 * not deliver, and every consumer of `inMainComponent` —
                 * `randomMainPoint`, the same-component early-out in
                 * `findPath`, the whole of `_ensureGoal`'s recovery — is built
                 * on that promise.
                 *
                 * O(cells) and run once per new worst stall, which a harness can
                 * afford and a frame cannot.
                 */
  const reach = (() => {
                  const g = ai.grid;
                  if (!g?.component) return null;
                  const start = g.nearest(ag.position.x, ag.position.z, ag.position.y);
                  if (start < 0) return null;
                  const DXs = [1, -1, 0, 0, 1, 1, -1, -1];
                  const DZs = [0, 0, 1, -1, 1, -1, 1, -1];
                  const seen = new Uint8Array(g.component.length);
                  const stack = [start];
                  seen[start] = 1;
                  let reached = 1;
                  while (stack.length) {
                    const cur = stack.pop();
                    const cx = cur % g.nx;
                    const cz = (cur / g.nx) | 0;
                    const cy = g.floor[cur];
                    for (let d = 0; d < 8; d++) {
                      const dx = DXs[d], dz = DZs[d];
                      const ix = cx + dx, iz = cz + dz;
                      if (!g.walkable(ix, iz)) continue;
                      if (dx && dz) {
                        if (!g.walkable(cx + dx, cz) || !g.walkable(cx, cz + dz)) continue;
                        if (!g.passable(cx, cz, dx, 0) || !g.passable(cx, cz, 0, dz)) continue;
                      } else if (!g.passable(cx, cz, dx, dz)) continue;
                      const ni = g.index(ix, iz);
                      if (seen[ni]) continue;
                      if (Math.abs(g.floor[ni] - cy) > g.maxStep) continue;
                      seen[ni] = 1;
                      reached++;
                      stack.push(ni);
                    }
                  }
                  let claimed = 0;
                  const comp = g.component[start];
                  for (let i = 0; i < g.component.length; i++) {
                    if (g.component[i] === comp) claimed++;
                  }
                  return { start, comp, reached, claimed, mainCells: g.mainComponentCells };
                })();
        return { probePath, reach };
      };

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

      // ENGAGEMENT DISTANCE, because it is what decides whether the SMG is a
      // weapon or a trap.
      //
      // `tools/ballistics.mjs` measures each gun against the range axis and the
      // two primaries cross over: the MPX-9 kills in 189 ms against the M4A1's
      // 225 ms, but its shots-to-kill runs 4/5/6/8 across 5/15/25/35 m while the
      // rifle holds 4 everywhere. Which of those is the better gun is not a
      // property of the guns — it is a property of how far apart people actually
      // are when they shoot, and nothing here had ever measured that.
      //
      // Taken from `damage:dealt`, which carries both the shooter and the impact
      // point. Read immediately: that payload object is REUSED per event
      // (`physics._damagePayload`), so keeping a reference records the last round
      // of the fight N times over instead of N different rounds.
      const hitDist = [];
      const offDmg = e.events.on('damage:dealt', (d) => {
        const p = d.source?.position;
        const q = d.point;
        if (!p || !q) return;
        hitDist.push(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
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

      /**
       * TRIGGER DUTY: of the time a bot spends in COMBAT, what share is it
       * actually willing to fire?
       *
       * `tools/threat.mjs` models danger per second as hit rate times a burst
       * duty cycle, and that duty cycle counts only the pauses BETWEEN bursts.
       * It does not count the other reason a bot holds fire, which `_combat`
       * states plainly: a bot that has claimed a cover point and has not
       * reached it runs with its weapon down and `wantFire` false. Time spent
       * repositioning is invisible to that model, so its figures are an upper
       * bound — and an upper bound nobody measured is just an optimistic guess.
       *
       * Sampled here because this is the only harness that runs a real fight.
       */
      let combatSamples = 0;
      let combatArmed = 0;
      const hold = { noTarget: 0, moving: 0, notPeeking: 0, noSight: 0, stale: 0, onlyTarget: 0, other: 0 };
      const noTargetAge = [];
      const noTargetAware = [];

      const tick = () => {
        peakAgents = Math.max(peakAgents, ai.stats.alive ?? 0);
        for (const ag of ai.agents) {
          if (!ag.alive || ag.state !== 'combat') continue;
          combatSamples++;
          if (ag.wantFire) { combatArmed++; continue; }
          /**
           * WHERE the other 90 % goes, in the order `_combat` decides it.
           *
           * A single "10 % armed" number says bots barely shoot and nothing
           * about which gate is holding them, and the four candidates want
           * completely different answers: repositioning is a movement-speed
           * question, the squad peek permission is a formation question, the
           * peek timer is a pacing question and visibility is a map question.
           * Tuning before knowing which one dominates is how the damage number
           * got raised 40 % for almost no effect.
           */
          /**
           * INDEPENDENT counts, not a priority chain.
           *
           * The first version was `if (!hasTarget) ... else if (moving) ... else
           * if (!peeking)`, which is a decision tree and reads like a cause
           * breakdown. It is not: a sample that is both target-less AND not
           * peeking lands wholly in the first bucket, so "no target 30 %" was
           * never "30 % would fire if the target gate were opened".
           *
           * It was read that way, the target gate was opened, and ten botfights
           * later the number had not moved — because most of those samples are
           * not peeking either. Count each condition on its own, and count the
           * one that actually matters: how many samples are blocked by ONLY the
           * target gate, which is the size of the prize for touching it.
           */
          if (!ag.hasTarget) hold.noTarget++;
          if (ag.cover && ag.position.distanceTo(ag.coverPos) >= 0.85) hold.moving++;
          if (!ag.peeking) hold.notPeeking++;
          if (!ag.targetVisible) hold.noSight++;
          if ((ag.lastKnownAge ?? 99) >= 2.2) hold.stale++;
          // Blocked by the target gate ALONE: peeking, fresh belief, at cover.
          if (!ag.hasTarget && ag.peeking && (ag.lastKnownAge ?? 99) < 2.2) {
            hold.onlyTarget++;
          }
          // Parked, not dead: the question below is open and the collector is
          // one edit from live.
          // eslint-disable-next-line no-constant-condition
          if (false) {
            /**
             * A bot in COMBAT holding no target should not exist.
             *
             * `_sense` only clears `hasTarget` once `lastKnownAge` passes 6.5,
             * and `_combat` bails to ALERT the moment that age passes 5 — so the
             * window is empty by construction and this counter should read zero.
             * It reads a third of all combat time. One of those two readings of
             * the source is wrong and tracing has not said which, so record the
             * two numbers that separate them: a bot that HEARD something has a
             * fresh `lastKnownAge` and low `awareness`, a state-machine lag has
             * a stale age.
             */
            noTargetAge.push(+(ag.lastKnownAge ?? -1).toFixed(1));
            noTargetAware.push(+(ag.awareness ?? -1).toFixed(2));
          }
        }
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
          const rec = stalls.get(ag.id) ?? {
            cur: 0, worst: 0, state: null, at: null,
            // WHY the recovery did not fire, recorded while it is not firing.
            //
            // `Agent._ensureGoal` rescues a bot that wants to move and is not
            // moving, and it did not rescue this one. Its two counters are
            // public, so rather than reasoning about which of its three reset
            // paths ran, watch them: a stall in which `noMoveTime` never
            // reaches 3 s is a stall the recovery could not see, and the peak
            // says by how much it missed.
            //
            // `crept` is the discriminator. This harness calls a bot stalled
            // below 4 mm per frame (0.24 m/s at 60 fps) and `_ensureGoal` calls
            // it progressing above 0.35 m in 3 s (0.117 m/s), so a bot moving
            // between those two speeds is stalled here and healthy there. If
            // `crept` clears 0.35 m the thresholds disagree; if it stays near
            // zero, something reset the counters instead.
            probe: {
              peakNoGoal: 0, peakNoMove: 0, crept: 0,
              sawIdle: false, sawTarget: false, sawPending: false, samples: 0,
            },
            anchor: null,
          };
          if (wants && moved < 0.004) {
            if (rec.cur === 0) {
              rec.probe = {
                peakNoGoal: 0, peakNoMove: 0, crept: 0,
                sawIdle: false, sawTarget: false, sawPending: false, samples: 0,
              };
              rec.anchor = { x: ag.position.x, z: ag.position.z };
            }
            rec.cur += e.time.elapsed - pv.t;
            /**
             * The expensive probes, ONCE per stall and only for a long one.
             *
             * They were computed inside the worst-moment snapshot, which is
             * rebuilt on every sample that beats the record — and during a long
             * stall almost every sample does. That put two O(cells) sweeps
             * inside the rAF callback 120 times a second, so the harness became
             * slowest exactly while the defect it is chasing was happening, and
             * eight consecutive runs stopped reproducing it. A probe that
             * changes the run is not measuring the run.
             */
            if (rec.cur > 3 && !rec.deep) rec.deep = deepProbe(ag);
            const p = rec.probe;
            p.samples++;
            p.peakNoGoal = Math.max(p.peakNoGoal, ag.noGoalTime ?? 0);
            p.peakNoMove = Math.max(p.peakNoMove, ag.noMoveTime ?? 0);
            if (rec.anchor) {
              p.crept = Math.max(p.crept, Math.hypot(
                ag.position.x - rec.anchor.x, ag.position.z - rec.anchor.z
              ));
            }
            if ((ag.desiredSpeed ?? 0) <= 0.1) p.sawIdle = true;
            if (ag.hasMoveTarget) p.sawTarget = true;
            if (ag.pathPending) p.sawPending = true;
            if (rec.cur > rec.worst) {
              rec.worst = rec.cur;
              rec.state = ag.state;
              // Snapshot the probe HERE, with the rest of the worst-moment
              // record. Reporting `rec.probe` directly mixed two different
              // stalls into one line: the probe restarts with each stall and
              // `worst`/`at` only move when a stall beats the record, so a
              // later, shorter stall silently replaced the numbers describing
              // the one being reported. It showed as arithmetic that could not
              // be true — 102 samples across a 10.3 s stall, at 60 fps.
              rec.worstProbe = { ...p };
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
                /**
                 * WHERE the bot is, in the nav grid's terms.
                 *
                 * The probe above establishes that `_ensureGoal` fires and
                 * achieves nothing — `hasMoveTarget` never goes true, so every
                 * `_goTo` it issues finds no route. The obvious next suspect is
                 * that the bot is standing off the main connected component, in
                 * one of the pockets `nav.js` counts, because `randomMainPoint`
                 * only ever picks destinations IN the main component and no
                 * route crosses between them.
                 *
                 * If that is it, the last-resort snap in `_unstick` cannot help
                 * either: `grid.nearest` returns the closest WALKABLE cell and
                 * does not consult `inMainComponent`, so it would move a
                 * stranded bot to another cell of the same pocket.
                 *
                 * Two hypotheses have already died today (creeping, and a
                 * broken recovery). Measure it rather than assume it.
                 */
                grid: (() => {
                  const g = ai.grid;
                  if (!g) return null;
                  const ix = g.cellX(ag.position.x);
                  const iz = g.cellZ(ag.position.z);
                  const onCell = !!g.walkable(ix, iz);
                  const self = onCell ? g.index(ix, iz) : -1;
                  const near = g.nearest(ag.position.x, ag.position.z, ag.position.y);
                  return {
                    onWalkableCell: onCell,
                    selfInMain: self >= 0 ? !!g.inMainComponent(self) : null,
                    near,
                    nearInMain: near >= 0 ? !!g.inMainComponent(near) : null,
                    nearAwayM: near >= 0 ? +Math.hypot(
                      g.worldX(near % g.nx) - ag.position.x,
                      g.worldZ((near / g.nx) | 0) - ag.position.z
                    ).toFixed(2) : null,
                    pocketCells: g.pocketCells,
                    walkableCount: g.walkableCount,
                  };
                })(),
                /**
                 * Run the query the bot keeps failing, right here, right now.
                 *
                 * Everything above says a route should exist: the bot stands on
                 * a walkable main-component cell and `_ensureGoal` routes it to
                 * main-component destinations. Deduction has now killed three
                 * hypotheses in a row, so stop deducing — `findPath` is pure and
                 * side-effect free given its own scratch buffer, so call it and
                 * read the answer instead of arguing about it.
                 *
                 * The destination is the first main cell in index order rather
                 * than a random one, so the result is comparable across runs and
                 * costs the agent no RNG draws (this harness must not perturb
                 * the simulation it is measuring).
                 */
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
          offDmg();
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
            stalls: [...stalls].map(([id, r]) => ({
              id, worst: +r.worst.toFixed(1), state: r.state, at: r.at,
              probe: r.worstProbe && {
                peakNoGoal: +(r.worstProbe.peakNoGoal).toFixed(2),
                peakNoMove: +(r.worstProbe.peakNoMove).toFixed(2),
                crept: +(r.worstProbe.crept).toFixed(3),
                sawIdle: r.worstProbe.sawIdle,
                sawTarget: r.worstProbe.sawTarget,
                sawPending: r.worstProbe.sawPending,
                samples: r.worstProbe.samples,
              },
              deep: r.deep ?? null,
            })).sort((p, q) => q.worst - p.worst),
            triggerDuty: combatSamples ? +(combatArmed / combatSamples).toFixed(3) : null,
            hold,
            noTargetAge: (() => { const v = noTargetAge.slice().sort((a,b)=>a-b); return v.length ? { n: v.length, p10: v[(v.length*0.1)|0], p50: v[(v.length*0.5)|0], p90: v[(v.length*0.9)|0] } : null; })(),
            noTargetAware: (() => { const v = noTargetAware.slice().sort((a,b)=>a-b); return v.length ? { p10: v[(v.length*0.1)|0], p50: v[(v.length*0.5)|0], p90: v[(v.length*0.9)|0] } : null; })(),
            combatSamples,
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
            // The weapon table, so the caller can score these distances against
            // each gun's OWN band edges instead of against a round number.
            //
            // `under15` was a magic 15. It was close to the MPX-9's four-round
            // edge by luck — the edge is 15.8 m at 29 damage and was 11.5 m at
            // 27 — so the one run of this harness that mattered most, the one
            // that justified the damage change, was scored against a threshold
            // that did not track the thing being decided. `tools/lethality.mjs`
            // solves the edge from the same falloff model physics applies.
            weapons: (() => {
              const wp = e.ctx.peek('weapons');
              if (!wp?.states) return null;
              return [...wp.states.entries()].map(([id, s]) => ({
                id,
                label: s.def.label,
                damage: s.def.damage,
                dropoff: s.def.dropoff,
                falloffRange: s.def.falloffRange ?? s.def.maxRange,
                maxRange: s.def.maxRange,
                rpm: s.def.rpm,
              }));
            })(),
            // Percentiles, not a mean: the question is what share of hits land
            // inside the SMG's window, and a mean is dragged around by the long
            // cross-hall tail that no gun is contested at.
            range: (() => {
              if (!hitDist.length) return null;
              const v = hitDist.slice().sort((x, y) => x - y);
              const q = (f) => +v[Math.min(v.length - 1, Math.floor(v.length * f))].toFixed(1);
              const under = (m) => +(v.filter((x) => x <= m).length / v.length).toFixed(2);
              return {
                n: v.length,
                p10: q(0.1), p50: q(0.5), p90: q(0.9),
                under10: under(10), under15: under(15), under25: under(25),
                // Every distance, sorted, one decimal.
                //
                // A single fight produces 20-50 hits, and a p50 out of 21 samples
                // is a coin toss dressed as a measurement — three runs here gave
                // medians of 9.6, 9.9 and 15.9 m, a spread wide enough to move
                // the MPX-9 from "band covers the median comfortably" to "band
                // closes on it". The percentiles above are per-run and stay
                // per-run; this is what lets several runs be POOLED, which is the
                // only honest way to quote a median for the map rather than for
                // an afternoon.
                all: v.map((x) => +x.toFixed(1)),
              };
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
const STALL_CEIL = Number(args.stallceil ?? 6);
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

/**
 * The top stalls with their probes, EVERY run, pass or fail.
 *
 * A number that only appears when it trips the gate is a number nobody can
 * watch drift toward it — and the fault this section exists for reproduces
 * about one run in eight, so waiting for the gate to fire is waiting for a
 * coin. Printing the near-misses turns one run into several samples of the
 * same phenomenon at lower amplitude. Run with `--stallceil=2` to make the
 * gate itself catch them.
 */
if (out.hold && out.combatSamples) {
  const n = out.combatSamples;
  const pct = (v) => `${Math.round((v / n) * 100)}%`;
  console.log(
    `\n  why a bot in COMBAT is not firing: ` +
    `no target ${pct(out.hold.noTarget)} · repositioning ${pct(out.hold.moving)} · ` +
    `not peeking ${pct(out.hold.notPeeking)} · no sight ${pct(out.hold.noSight)} · ` +
    `stale belief ${pct(out.hold.stale)}  (independent, so they overlap)`
  );
  console.log(`    blocked by the TARGET GATE ALONE (peeking, fresh, at cover): ${pct(out.hold.onlyTarget)}`);
  if (out.noTargetAge) {
    console.log(
      `    of the no-target time: lastKnownAge p10/50/90 ` +
      `${out.noTargetAge.p10}/${out.noTargetAge.p50}/${out.noTargetAge.p90}s · ` +
      `awareness ${out.noTargetAware.p10}/${out.noTargetAware.p50}/${out.noTargetAware.p90}`
    );
  }
}

if (out.stalls?.length) {
  console.log('\n─── worst blocked-moves, with the recovery probe ' + '─'.repeat(22));
  for (const s of out.stalls.slice(0, 4)) {
    if (!s.worst) continue;
    const p = s.probe ?? {};
    console.log(
      `  #${s.id} ${String(s.worst).padStart(5)}s in ${String(s.state).padEnd(7)} · ` +
      `_ensureGoal peaks noGoal ${p.peakNoGoal}/1.5 noMove ${p.peakNoMove}/3.0 · ` +
      `crept ${p.crept} m · idle ${p.sawIdle ? 'Y' : 'n'} target ${p.sawTarget ? 'Y' : 'n'} ` +
      `pending ${p.sawPending ? 'Y' : 'n'} · ${p.samples} samples`
    );
    const g = s.at?.grid;
    if (g) {
      console.log(
        `        grid: on a walkable cell ${g.onWalkableCell ? 'Y' : 'n'} · ` +
        `that cell in main component ${g.selfInMain === null ? '—' : g.selfInMain ? 'Y' : 'n'} · ` +
        `nearest() ${g.near} at ${g.nearAwayM} m, in main ${g.nearInMain === null ? '—' : g.nearInMain ? 'Y' : 'n'} · ` +
        `${g.pocketCells} pocket / ${g.walkableCount} walkable`
      );
    }
    const pp = s.deep?.probePath;
    if (pp) {
      console.log(
        `        live findPath to a main cell ${pp.destAwayM} m away -> n=${pp.n} · ` +
        `start cell ${pp.start} (component ${pp.startComp}) -> goal ${pp.goal} (component ${pp.goalComp})`
      );
    }
    const rh = s.deep?.reach;
    if (rh) {
      console.log(
        `        flood from cell ${rh.start}: reaches ${rh.reached} cells · ` +
        `component ${rh.comp} claims ${rh.claimed} · main has ${rh.mainCells}` +
        (rh.reached < rh.claimed ? '   <<< the label over-promises' : '')
      );
    }
  }
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
      `worst blocked-move ${(out.stalls?.[0]?.worst ?? 0)}s` +
      (out.triggerDuty !== null
        ? ` · trigger duty ${Math.round(out.triggerDuty * 100)}% of ${out.combatSamples} combat samples`
        : '') +
      // Reported, not gated. It is an observation about the map that the weapon
      // table has to answer to, and there is no value of it that is a bug.
      (out.range
        ? ` · hits at ${out.range.p10}/${out.range.p50}/${out.range.p90} m ` +
          `(p10/50/90, n=${out.range.n})`
        : '')
    : `\nBOTFIGHT FAILED (${fail.length}):\n  ${fail.join('\n  ')}`
);

/**
 * What this map's distances do to each gun.
 *
 * Reported, never gated. There is no share of hits inside a band that is a
 * defect — it is the observation the weapon table has to answer to, and the
 * answer is a design call. What was wrong before was not the absence of a gate
 * but the absence of the number: the MPX-9 spent a release as a trap pick
 * because "how often is the four-round band actually available" had never been
 * printed anywhere.
 */
if (out.range && out.weapons) {
  console.log('\n─── this map, against the weapon table ' + '─'.repeat(31));
  const v = out.range.all ?? [];
  for (const w of out.weapons) {
    const edge = bandEdge(w, 4);
    const share = Number.isFinite(edge)
      ? v.filter((d) => d <= edge).length / v.length
      : 1;
    console.log(
      `  ${w.label.padEnd(7)} 4-round band ` +
      (Number.isFinite(edge) ? `to ${edge.toFixed(1)} m` : 'everywhere').padEnd(14) +
      `· covers ${(share * 100).toFixed(0)}% of ${v.length} hits · ${formatBands(stkBands(w))}`
    );
  }
}

await browser.close();
killServer(vite);
process.exit(fail.length === 0 ? 0 : 1);
