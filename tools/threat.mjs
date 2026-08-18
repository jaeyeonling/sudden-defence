#!/usr/bin/env node
/**
 * How dangerous is a bot?
 *
 * `Agent.weaponDamage` is described in its own source as "the most consequential
 * number in the game", and nothing in the suite could see it. `botfight.mjs` and
 * `matchsim.mjs` are bot-versus-bot, so the number scales both sides at once and
 * only shortens the fight; the thing it actually decides — whether fighting bots
 * is a threat or a chore — was measured by nobody.
 *
 * This is the bots' half of `ballistics.mjs`. Same question, same falloff model,
 * same solved band edges (`tools/lethality.mjs`): how many rounds to kill the
 * player at range, how long that takes at the bot's fire rate, and where a head
 * hit stops being survivable.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT A LIVE ARENA, HAVING BEEN ONE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The first version parked a live player in the open and timed two bots killing
 * it. That framing needs the room to contain nothing else, and this engine has
 * no way to arrange that. Four isolation attempts each failed for a different
 * real reason, and every one of them produced a plausible number first:
 *
 *   herd bystanders to a corner   both teams landed on one spot and brawled,
 *                                 and the enemy roster ran dry
 *   `a.frozen = true`             `ai/index.js` assigns `a.frozen =
 *                                 match.frozen` to every agent every tick, so
 *                                 the value did not survive a step
 *   `match.unregister`            stops new targets but not one already held,
 *                                 so bystanders kept firing — and being
 *                                 unregistered, every death came back
 *                                 attributed to NOBODY, blinding the probe
 *   discard contaminated trials   correct, and left nothing: a single alpha bot
 *                                 was killing the whole bravo team through the
 *                                 lane, head shot after head shot
 *
 * The lesson is not "try harder at isolation". It is that the question was
 * wrong. "How long does a stationary player survive" drags in perception,
 * pathing, cover, grenades and the rest of the roster to answer something that
 * `weaponDamage` decides on its own. Ask the model instead: it is deterministic,
 * it needs no room, and it is the same thing `ballistics.mjs` asks of the
 * player's guns.
 *
 * WHAT IS AND IS NOT MEASURED, stated so nobody reads more into it than it
 * carries. The cone IS measured, by firing 2000 real rounds through
 * `_fireRound` — it is a Gaussian on the direction vector, not the uniform disc
 * the player's weapons use, and computing off the wrong distribution would have
 * flattered the bots. From it comes a hit rate against a stationary torso.
 *
 * What is NOT here is how often a bot is in a position to shoot at all.
 * `botfight.mjs` measures that — 6-10 % of its time in COMBAT — and the danger
 * figures below assume 100 %. They are an upper bound of roughly ten times, and
 * they are still worth printing because every weapon knob scales them and none
 * of them touches that 10 %.
 *
 * Nor is anything here about a target that MOVES.
 *
 *   node tools/threat.mjs
 */
import { stkBands, formatBands, bandEdge, damageAt } from './lethality.mjs';
import { parseArgs, ensureServer, killServer, launchChromium, waitForReady } from './harness.mjs';

const args = parseArgs();
const PORT = Number(args.port ?? 5173);
/** Where the map actually produces fights — `botfight.mjs`, pooled over 8 runs. */
const RANGES = [9, 14, 20];
/**
 * Ceiling on how lethal a single head hit may be, as a fraction of full health.
 *
 * 1.0 is a one-tap from full: bots aim at the chest and spray a cone, so a round
 * that strays onto the head would kill outright, from any range, with no
 * decision by either side. That is a different game rather than a harder one, so
 * the gate refuses to let a damage change cross it silently.
 */
const HEADSHOT_CEIL = Number(args.headceil ?? 0.999);
/**
 * Most rounds a bot may need to kill at the far end of the map's fight ranges.
 *
 * 8, which is roughly what a burst delivers before the cone has opened and the
 * target has moved. Not "how many shots feels right" — that is a design call and
 * belongs in `agent.js` — but a floor under it: past this, a bot cannot close
 * out a fight it is winning, which reads to a player as bots that never commit.
 */
const BURST_CEIL = Number(args.burstceil ?? 8);

const vite = await ensureServer(PORT, { name: 'THREAT' });

const browser = await launchChromium({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?prewarm=0`, { waitUntil: 'load' });
await waitForReady(page, { name: 'THREAT' });

const out = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.get('ai');
  const agent = ai?.agents?.[0];
  if (!agent) return { fatal: 'no agents to read' };

  // Read the knobs off a REAL agent rather than off a constant, so a variant
  // that overrides any of them is what gets reported.
  const players = e.ctx.peek('player');
  const head = (e.ctx.peek('match')?.HITBOXES ?? null);
  /**
   * MEASURE the cone instead of trusting the arithmetic below it.
   *
   * `_fireRound` perturbs the direction VECTOR componentwise and renormalises:
   *
   *     dir.x += gauss() * spread;
   *     dir.y += gauss() * spread * 0.8;
   *     dir.z += gauss() * spread;
   *
   * which is a Gaussian, not the uniform disc the player's weapons use, and is
   * squashed 0.8 vertically. Reading that off the source and computing from it
   * is exactly the habit this whole session has been unpicking, so fire real
   * rounds through the real method and measure what comes out.
   *
   * `onAgentFire` is stubbed for the duration so nothing is actually shot: the
   * direction is the only thing wanted, and spawning 2000 bullets into the level
   * would be a side effect a measurement has no business having.
   */
  const scatter = (() => {
    const a = agent;
    const origOnFire = ai.onAgentFire.bind(ai);
    const dirs = [];
    ai.onAgentFire = (_ag, _origin, dir) => { dirs.push({ x: dir.x, y: dir.y, z: dir.z }); };
    try {
      for (let i = 0; i < 2000; i++) a._fireRound();
    } finally {
      ai.onAgentFire = origOnFire;
    }
    if (dirs.length < 100) return null;
    /**
     * THE AXIS COMES FROM THE ROUNDS, NOT FROM WHERE THE HARNESS THINKS THE GUN
     * IS POINTING.
     *
     * This used to take `animator.muzzleDir` as the reference and measure every
     * round's deviation from it, which quietly asserted that `_fireRound` aims
     * along the animated bore. The moment an experiment moved bot aim onto
     * simulation state, the two axes were merely DIFFERENT and the angle between
     * them was counted as spread: sigma 0.5108 rad, 9 m hit rate 1%, "the bots
     * cannot shoot". The bots were fine. The harness was measuring the wrong
     * angle, and that reading survived long enough to be reported as a game
     * defect before the aim change was reverted.
     *
     * The mean of the returned directions IS the axis — that is what a cone's
     * axis means — and it costs one pass. A measurement that depends on where a
     * second, unrelated piece of code points is a measurement with an opinion.
     */
    const base = { x: 0, y: 0, z: 0 };
    for (const d of dirs) { base.x += d.x; base.y += d.y; base.z += d.z; }
    const bl = Math.hypot(base.x, base.y, base.z);
    if (!(bl > 1e-6)) return null;
    base.x /= bl; base.y /= bl; base.z /= bl;
    // Angle of each round off the aim axis, split into the vertical part and
    // the part in the horizontal plane — the two the model claims differ.
    let sh = 0;
    let sv = 0;
    let n = 0;
    for (const d of dirs) {
      const dot = d.x * base.x + d.y * base.y + d.z * base.z;
      if (!Number.isFinite(dot)) continue;
      // Vertical: difference in elevation angle. Horizontal: difference in
      // heading. Small angles, so the raw differences are the angles.
      const ev = Math.asin(Math.max(-1, Math.min(1, d.y))) - Math.asin(Math.max(-1, Math.min(1, base.y)));
      const eh = Math.atan2(d.x, d.z) - Math.atan2(base.x, base.z);
      const ehw = Math.atan2(Math.sin(eh), Math.cos(eh));
      sv += ev * ev;
      sh += ehw * ehw;
      n++;
    }
    return n ? { n, sigmaH: Math.sqrt(sh / n), sigmaV: Math.sqrt(sv / n) } : null;
  })();

  return {
    weaponDamage: agent.weaponDamage,
    fireRate: agent.fireRate,
    spread: agent.spread,
    burstMin: 3,
    burstMax: 7,
    burstPauseMin: 0.45,
    burstPauseMax: 1.35,
    scatter,
    variants: [...new Set(ai.agents.map((a) => `${a.variantName ?? 'regular'}:${a.fireRate}`))],
    playerMaxHealth: players?.health?.max ?? 100,
    // Multipliers live in the hitbox tables; `hitbox.mjs` asserts the head one.
    headMultiplier: 4.0,
    hasHitboxTable: !!head,
  };
});

await browser.close();
killServer(vite);

/* ------------------------------------------------------------------ report */

if (out?.fatal) {
  console.log(`\nTHREAT FAILED — harness precondition: ${out.fatal}`);
  process.exit(1);
}

const fail = [];
const hp = out.playerMaxHealth;
/**
 * The bot's round, in the shape `lethality.mjs` solves.
 *
 * Falloff numbers are the ones `AiSystem.onAgentFire` passes to `fireBullet` —
 * matched to the player's carbine on purpose, so neither side is fighting a
 * different physics. If that call changes, this has to change with it, and the
 * cross-check below is what catches the drift.
 */
const botRound = { damage: out.weaponDamage, dropoff: 0.82, falloffRange: 55, maxRange: 200 };

const stk = stkBands(botRound, { hp });
const fourEdge = bandEdge(botRound, 4, { hp });
const shotsAt = (d) => Math.ceil(hp / damageAt(botRound, d));
/** Time from the first round to the killing one, at the bot's own cadence. */
const ttk = (shots) => Math.round(((shots - 1) * 1000) / out.fireRate);

console.log(
  `  bot round: ${out.weaponDamage} damage · dropoff 0.82 over 55 m · ` +
  `${out.fireRate}/s · spread ${out.spread} rad · player ${hp} HP`
);
console.log(`  variants: ${out.variants.join(', ')}`);
console.log(`  bands: ${formatBands(stk)}`);
for (const d of RANGES) {
  const n = shotsAt(d);
  console.log(
    `  ${String(d).padStart(3)} m · ${damageAt(botRound, d).toFixed(1)} per hit · ` +
    `${n} shots · ${ttk(n)} ms of sustained fire`
  );
}
/* ---------------------------------------------------- danger per second --- */
/**
 * Lethality per hit is only half the difficulty question. The other half is how
 * OFTEN a bot connects, and that is spread, the burst pattern and the pauses
 * between bursts — none of which appear in a shots-to-kill table.
 *
 * The cone is GAUSSIAN, not the uniform disc the player's weapons use, and that
 * matters more than it sounds: a Gaussian is far denser at the centre, so bots
 * land the middle of the cone much more often than a nominal radius suggests.
 * The vertical is squashed to 0.8 of the horizontal.
 *
 * `erf` via Abramowitz & Stegun 7.1.26 — this needs four digits, not a library.
 */
const erf = (x) => {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  // Written out rather than golfed, because a wrong erf here is a wrong hit rate
  // everywhere and both look plausible.
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-a * a));
};
/** Chance a zero-mean Gaussian of sigma lands inside +-half. */
const within = (half, sigma) => (sigma > 0 ? erf(half / (sigma * Math.SQRT2)) : 1);

const sigH = out.scatter?.sigmaH ?? out.spread;
const sigV = out.scatter?.sigmaV ?? out.spread * 0.8;
/**
 * Torso silhouette, from the hitbox table in `agent.js`: the chest and pelvis
 * capsules are 0.185 and 0.175 in radius and together span roughly Hips to Neck.
 * Half-width is the capsule radius; half-height is half that span.
 */
const TORSO_HALF_W = 0.185;
const TORSO_HALF_H = 0.30;
/** Rounds actually delivered per second once the burst pauses are counted. */
const burstLen = (out.burstMin + out.burstMax) / 2;
const pause = (out.burstPauseMin + out.burstPauseMax) / 2;
const dutyRate = burstLen / (burstLen / out.fireRate + pause);

console.log(
  `  cone: measured sigma ${sigH.toFixed(4)} horizontal / ${sigV.toFixed(4)} vertical rad ` +
  `(declared ${out.spread} and ${(out.spread * 0.8).toFixed(4)}) · ${out.scatter?.n ?? 0} rounds`
);
console.log(
  `  cadence: bursts of ${out.burstMin}-${out.burstMax} at ${out.fireRate}/s with ` +
  `${out.burstPauseMin}-${out.burstPauseMax}s between -> ${dutyRate.toFixed(2)} rounds/s sustained`
);
/**
 * THE FIGURES BELOW ARE AN UPPER BOUND, and by a wide margin.
 *
 * `dutyRate` counts one thing: the pauses between bursts. It assumes a bot that
 * is always in the peek-and-shoot branch of `_combat`, and a bot mostly is not.
 * `tools/botfight.mjs` samples `wantFire` across a real fight and finds a bot in
 * COMBAT is willing to fire 6-10 % of the time, split roughly evenly between
 * three causes: no target held (35 %), running to a cover point with the weapon
 * down (27 %), and the squad peek rotation holding it back (32 %).
 *
 * So multiply what follows by about a tenth to get the fight. The reason it is
 * still printed this way is that this file exists to compare CHANGES to the
 * weapon knobs, and every one of them scales this number and none of them
 * touches the 10 %. Quoting it as an absolute would be the mistake.
 */
/**
 * THE MEASURED CONE MUST BE THE DECLARED CONE.
 *
 * This gate used to print the two and compare neither, and that is not a small
 * omission: moving bot aim off the animated muzzle blew the horizontal sigma
 * from 0.026 to 0.5108 rad — twenty times the declared cone, 9 m hit rate from
 * 51% to 1%, time to kill from 2.2 s to 182.6 s — and THREAT STILL PRINTED OK.
 * Every assertion below it is about the damage model, which was untouched, so
 * nothing noticed that the bots had stopped being able to shoot.
 *
 * A gate that cannot see the difficulty collapse is not a difficulty gate.
 *
 * The 20% band is not a tuning choice: `spread` is a signed-off number
 * (`8c004aa`) and the scatter here is 2000 rounds off the real fire path, so the
 * two agreeing is a mechanism check rather than a taste one. Three baseline runs
 * measured 0.0261 / 0.0262 / 0.0267 against a declared 0.026 — under 3% — so
 * 20% is loose enough to never fire on sampling noise and tight enough that a
 * factor of twenty cannot hide in it.
 */
const CONE_TOL = 0.20;
for (const [axis, measured, declared] of [
  ['horizontal', sigH, out.spread],
  ['vertical', sigV, out.spread * 0.8],
]) {
  const rel = Math.abs(measured - declared) / declared;
  if (rel > CONE_TOL) {
    fail.push(
      `${axis} cone measured ${measured.toFixed(4)} rad against a declared ${declared.toFixed(4)} ` +
      `(${(rel * 100).toFixed(0)}% off) — the fire path is not delivering the spread the model was tuned on`
    );
  }
}

console.log('  danger against a stationary torso, one bot (UPPER BOUND — see note):');
const danger = RANGES.map((d) => {
  const p = within(TORSO_HALF_W, sigH * d) * within(TORSO_HALF_H, sigV * d);
  const dps = p * dutyRate * damageAt(botRound, d);
  return { d, p, dps, ttk: dps > 0 ? hp / dps : Infinity };
});
for (const r of danger) {
  console.log(
    `    ${String(r.d).padStart(3)} m · hit ${(r.p * 100).toFixed(0)}% · ` +
    `${r.dps.toFixed(0)} dps · ${r.ttk === Infinity ? 'never' : `${r.ttk.toFixed(1)}s to kill`}`
  );
}

const headDmg = out.weaponDamage * out.headMultiplier;
console.log(
  `  head hit: ${headDmg.toFixed(0)} against ${hp} HP ` +
  `(${(headDmg / hp).toFixed(2)}x) — ${headDmg >= hp ? 'ONE TAP from full' : 'survivable from full'}`
);

/**
 * THE ONE-TAP CLIFF.
 *
 * This is the gate that earns the file. `weaponDamage` looks like a smooth dial
 * and is not: the head multiplier is 4, so the moment damage reaches a quarter
 * of the player's health a stray round on the head kills from full. Measured
 * while choosing the current value — at 25 the live arena reported a median
 * time-from-first-hit-to-death of 0.00 s, one hit, against 1.88 s at 17.
 *
 * Not a balance opinion. A one-tap may well be wanted one day; what must not
 * happen is crossing it by nudging a damage number and never being told.
 */
if (headDmg >= hp * HEADSHOT_CEIL) {
  fail.push(
    `a bot head hit does ${headDmg.toFixed(0)} against ${hp} HP — bots aim at the chest and ` +
    `spray a ${out.spread} rad cone, so any round that strays onto the head kills from full. ` +
    `Raise --headceil past 1 if that is the intent, but it should be an intent`
  );
}
/**
 * The opposite failure: a bot that cannot finish a fight.
 *
 * Bounded by the MAGAZINE, not by a shot count somebody liked. The first version
 * of this check demanded four rounds to kill and that was a balance opinion
 * smuggled in as an invariant — worse, it contradicted the cliff check directly
 * above it, because four rounds against 100 health needs 25 damage and 25 damage
 * is exactly the one-tap head. Two gates that cannot both be satisfied are two
 * gates that will be edited until one is deleted, and the wrong one usually goes.
 *
 * What is genuinely not negotiable: a bot must be able to kill inside a burst it
 * can actually fire, at the ranges this map produces.
 */
const worst = Math.max(...RANGES.map(shotsAt));
if (worst > BURST_CEIL) {
  fail.push(
    `a bot needs ${worst} rounds to kill at ${RANGES[RANGES.length - 1]} m, over the ${BURST_CEIL} ` +
    `a burst delivers — at ${out.fireRate}/s that is ${ttk(worst)} ms of unbroken fire on one target`
  );
}
if (fourEdge === null && worst > BURST_CEIL) {
  fail.push(`bots cannot finish a fight at any range this map contains`);
}
// And the map has to be inside the useful part of the curve, the same check
// `ballistics.mjs` makes of the player's guns.
if (shotsAt(20) > shotsAt(9) + 2) {
  fail.push(`bot damage falls ${shotsAt(9)} -> ${shotsAt(20)} shots between 9 and 20 m — that is a sniper's curve on a 36 m map`);
}
/**
 * The operating point, in the units the difficulty was actually signed off in.
 *
 * Redundant with the cone check by construction — `p` is a pure function of the
 * two sigmas — and kept anyway, because the cone check speaks about a mechanism
 * and this one speaks about the game. `0f088e5` and `8c004aa` chose a bot that
 * kills a stationary target in about 2 s at 9 m; a change that halves that is a
 * difficulty change and has to be declared rather than discovered.
 *
 * Bands are ±25% of three baseline runs (9 m: 51/50/49, 14 m: 28/26/26,
 * 20 m: 15/14/14) — wider than the 4% those runs actually spanned.
 */
const HIT_BAND = { 9: [0.37, 0.64], 14: [0.20, 0.35], 20: [0.11, 0.19] };
for (const r of danger) {
  const band = HIT_BAND[r.d];
  if (!band) continue;
  if (r.p < band[0] || r.p > band[1]) {
    fail.push(
      `hit rate at ${r.d} m is ${(r.p * 100).toFixed(0)}%, outside the ${(band[0] * 100).toFixed(0)}-` +
      `${(band[1] * 100).toFixed(0)}% band this difficulty was signed off at — if that is intended, ` +
      `move the band and say why`
    );
  }
}

if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nTHREAT FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nTHREAT OK — bot lethality is solved from the same falloff the player fights under, and a head hit is not a one-tap');
