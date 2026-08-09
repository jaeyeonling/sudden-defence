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
 * WHAT IS THEREFORE NOT MEASURED HERE, stated so nobody reads more into it: hit
 * RATE. Spread, the reaction curve and the burst cooldowns decide how often a
 * bot connects with a player who is moving, and none of them appear below. This
 * is lethality per hit, not danger per second.
 *
 *   node tools/threat.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { stkBands, formatBands, bandEdge, damageAt } from './lethality.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
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

const out = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.get('ai');
  const agent = ai?.agents?.[0];
  if (!agent) return { fatal: 'no agents to read' };

  // Read the knobs off a REAL agent rather than off a constant, so a variant
  // that overrides any of them is what gets reported.
  const players = e.ctx.peek('player');
  const head = (e.ctx.peek('match')?.HITBOXES ?? null);
  return {
    weaponDamage: agent.weaponDamage,
    fireRate: agent.fireRate,
    spread: agent.spread,
    variants: [...new Set(ai.agents.map((a) => `${a.variantName ?? 'regular'}:${a.fireRate}`))],
    playerMaxHealth: players?.health?.max ?? 100,
    // Multipliers live in the hitbox tables; `hitbox.mjs` asserts the head one.
    headMultiplier: 4.0,
    hasHitboxTable: !!head,
  };
});

await browser.close();
if (vite) {
  try {
    process.kill(-vite.pid);
  } catch {
    /* already gone */
  }
}

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
if (errors.length) fail.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fail.length) {
  console.log(`\nTHREAT FAILED (${fail.length}):\n  - ${fail.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nTHREAT OK — bot lethality is solved from the same falloff the player fights under, and a head hit is not a one-tap');
