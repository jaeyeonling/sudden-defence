/**
 * MATCH — who is fighting, on whose side, and whether they are still standing.
 *
 * This subsystem sits between `world` and every gameplay system that has an
 * opinion about the fight, and it exists so that none of them have an opinion
 * about each other. `ai` asks it for targets instead of asking `player` where
 * the player is. `ui` asks it for a score instead of counting corpses. `player`
 * registers with it instead of being special.
 *
 * The round loop lives in `round.js` and the spawn formation in `spawn.js`.
 * Both are pure — no THREE, no subsystem lookups — and this file is the only
 * thing that wires them to the world.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const m = ctx.get('match')`
 * ────────────────────────────────────────────────────────────────────────────
 * REGISTRY
 *   m.register(host, { team, name, isPlayer, layer }) -> Combatant
 *   m.unregister(hostOrCombatant)
 *   m.combatants            all of them, registration order
 *   m.of(host)              the Combatant for a host object, or null
 *   m.enemiesOf(c)          living combatants on the other side
 *   m.alliesOf(c)           living combatants on the same side, excluding c
 *   m.aliveCount(team)      how many of `team` are still up
 *   m.teamOf(host)          'alpha' | 'bravo' | null
 *   m.areEnemies(a, b)      hosts or combatants, either way
 *   m.TEAMS                 the team table (colour, camo, display name)
 *
 * ROUNDS
 *   m.round                 the RoundMachine
 *   m.phase                 'idle'|'warmup'|'freeze'|'live'|'roundEnd'|'matchEnd'
 *   m.frozen                true whenever fighters must hold — POLLED by
 *                           `player` and `ai`, which both already depend on us
 *   m.live                  true only during 'live'
 *   m.scores                { alpha, bravo } rounds won
 *   m.startMatch(tempo?)    begin (or restart) the round loop
 *   m.stopMatch()           halt it and unfreeze everyone
 *   m.resetRound(n)         called BY the round machine; respawns everyone
 *
 * EVENTS EMITTED
 *   combatant:spawn   { combatant }
 *   combatant:death   { combatant, source, part, headshot }
 *   round:phase       { phase, round, remaining, scores }
 *   round:start       { round, scores }
 *   round:end         { round, winner, reason, scores }
 *   match:end         { winner, scores }
 *
 * EVENTS CONSUMED
 *   damage:dealt      attributes damage and detects the transition to dead
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `frozen` IS POLLED AND NOT PUSHED
 *
 * Everywhere else in this codebase the rule is push, not poll — but that rule
 * is about the engine layer, which must never be able to name gameplay. Here
 * the direction is already fixed the other way: `player` and `ai` both declare
 * `match` as a dependency, so reading a flag off it costs one property access
 * and no coupling that did not already exist. Pushing would mean `match`
 * holding references to two specific subsystems and calling setters on them,
 * which is strictly more coupling to achieve strictly less.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY DEATH IS DETECTED HERE AND NOT EMITTED BY THE VICTIM
 *
 * A victim knows it died; it does not reliably know who killed it, and the two
 * hosts disagree about how they would tell you. The player's Health emits
 * `player:death`, a bot's FSM will emit its own thing, and a kill credited off
 * either of those is a kill credited off whichever host happened to be written
 * last. `damage:dealt` already carries source, target, part and amount for
 * every round that lands on anybody, so watching the alive->dead edge from
 * there gives one attribution path for both kinds of fighter.
 */

import { Combatant } from './combatant.js';
import { TEAMS, TEAM_IDS, opposing } from './teams.js';
import { RoundMachine, PHASE, TEMPO } from './round.js';
import { SpawnAssigner } from './spawn.js';

export class MatchSystem {
  /**
   * Snapshot classification (netcode step 5).
   *
   * `combatants` is the roster and it rewinds — but membership does not. Every
   * fighter registers during boot and nothing unregisters, so the restore walks
   * the existing array in place rather than rebuilding it. That is also why
   * `_byHost` is excluded: it is an index over the same array, and an index over
   * a fixed set cannot go stale.
   *
   * `_enemies` and `_allies` are the reusable out-arrays that `enemiesOf` and
   * `alliesOf` return, cleared on entry. Scratch, not memory.
   */
  static snapshotState = ['combatants', 'round', 'spawner', '_started'];
  static excludedState = [
    'TEAMS', 'TEAM_IDS', 'autoStart', 'ctx', 'physics', 'world',
    '_byHost', '_enemies', '_allies', '_deathPayload', '_spawnPayload', '_offEvents',
  ];

  captureState(out = {}) {
    const list = (out.combatants ??= []);
    list.length = 0;
    for (const c of this.combatants) list.push({ id: c.id, s: c.captureState() });
    out.round = this.round.captureState(out.round);
    out.spawner = this.spawner.captureState(out.spawner);
    out._started = this._started;
    return out;
  }

  restoreState(s) {
    // Local, not a field. The first version cached this Map on the instance and
    // the replay gate caught it immediately: `restore did NOT reproduce K` on
    // eight `match._restoreIndex{n}` leaves, because the restore itself had
    // created state the snapshot at K never had. Building it once per restore
    // rather than once per fighter is the part that mattered; keeping it was not.
    const byId = new Map();
    for (const c of this.combatants) byId.set(c.id, c);
    for (const rec of s.combatants) byId.get(rec.id)?.restoreState(rec.s, byId);
    this.round.restoreState(s.round);
    this.spawner.restoreState(s.spawner);
    this._started = s._started;
  }

  static id = 'match';
  static deps = ['world', 'physics'];

  constructor() {
    this.combatants = [];
    this.TEAMS = TEAMS;
    this.TEAM_IDS = TEAM_IDS;
    /** host -> Combatant. Hot path: `damage:dealt` resolves through it. */
    this._byHost = new Map();
    /** Scratch result lists, reused — enemiesOf() runs per bot per tick. */
    this._enemies = [];
    this._allies = [];
    this._deathPayload = { combatant: null, source: null, part: 'torso', headshot: false };
    this._spawnPayload = { combatant: null };
    this._offEvents = [];

    this.round = new RoundMachine(this);
    this.spawner = null;
    /**
     * The round loop starts itself once both sides have a fighter — see
     * `_maybeStart`. Set false to run a level with no round structure at all
     * (capture shots, `tools/botfight.mjs`).
     */
    this.autoStart = true;
    this._started = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.physics = ctx.get('physics');
    this.world = ctx.get('world');
    this.spawner = new SpawnAssigner(this.world, this.physics);

    // A deterministic capture is a photograph of a level, not a match. Letting
    // a round loop run underneath it would mean the shutter falls in warmup on
    // one run and in freeze on the next, and freeze holds every fighter still
    // while warmup does not — so the same shot would photograph two different
    // scenes depending on how fast the machine was.
    if (ctx.config.deterministic) this.autoStart = false;

    // ---- friendly fire ----
    //
    // Off. This is a game rule, not a physics one: a round that passes through
    // a teammate really should hit them, and it does — the impact, the spray
    // and the crack all still happen. It just does not wound.
    //
    // Two reasons, and the second is the one that decided it. Sudden Attack's
    // casual modes have never had friendly fire, so it is what the genre
    // expects. And a bot firing through its own squadmate is a line-of-fire
    // problem, which the AI does not yet solve; measured, it cost one death in
    // four in an eight-bot elimination. Punishing the player for the AI's
    // inability to check who is in front of it is not a difficulty setting.
    //
    // Pushed to physics as a predicate rather than checked in a `damage:dealt`
    // handler, because the latter is only correct while `match` is subscribed
    // before every host — see setDamageFilter().
    // Block ONLY a registered fighter hitting a registered team-mate. Anything
    // unregistered — an explosion with no owner, a world hazard, a shot from
    // something that is not a Combatant — still wounds; "not an enemy" and "on
    // my team" are different statements and only the second should protect you.
    this.physics.setDamageFilter((source, target) => {
      const a = this.of(source);
      const b = this.of(target);
      if (!a || !b || a === b) return true;
      return a.team !== b.team;
    });

    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn));
    on('damage:dealt', (e) => this._onDamage(e));
  }

  /* ==================================================================== */
  /* registry                                                             */
  /* ==================================================================== */

  /**
   * Enlist a host. `layer` is the physics layer its hitboxes live on — PLAYER
   * for the local player, ACTOR for bots. They are separate bits so a system
   * that wants only one kind (a spectator camera, a nav probe) can still say so
   * with a mask, even though bullets now strike both.
   */
  register(host, opts = {}) {
    const existing = this._byHost.get(host);
    if (existing) return existing;
    const c = new Combatant(host, opts);
    c.buildHitboxes(this.physics, opts.layer ?? this.physics.LAYER.ACTOR);
    this.combatants.push(c);
    this._byHost.set(host, c);
    this._spawnPayload.combatant = c;
    this.ctx.events.emit('combatant:spawn', this._spawnPayload);
    return c;
  }

  unregister(x) {
    const c = x instanceof Combatant ? x : this._byHost.get(x);
    if (!c) return;
    c.dispose();
    this._byHost.delete(c.host);
    const i = this.combatants.indexOf(c);
    if (i >= 0) this.combatants.splice(i, 1);
  }

  of(host) {
    return this._byHost.get(host) ?? (host instanceof Combatant ? host : null);
  }

  teamOf(host) {
    return this.of(host)?.team ?? null;
  }

  /* ==================================================================== */
  /* queries                                                              */
  /* ==================================================================== */

  /**
   * Living combatants on the other side.
   *
   * The returned array is REUSED. Read it or copy it before the next call —
   * this is the query an AI perception tick runs every frame for every bot, so
   * handing back a fresh array would allocate once per bot per frame, which is
   * exactly the per-frame garbage ARCHITECTURE.md's fourth hard rule exists to
   * prevent.
   */
  enemiesOf(c) {
    const self = this.of(c);
    const out = this._enemies;
    out.length = 0;
    if (!self) return out;
    const other = opposing(self.team);
    for (const o of this.combatants) {
      if (o.team === other && o.alive) out.push(o);
    }
    return out;
  }

  /** Same team, still up, excluding `c` itself. Also a reused array. */
  alliesOf(c) {
    const self = this.of(c);
    const out = this._allies;
    out.length = 0;
    if (!self) return out;
    for (const o of this.combatants) {
      if (o !== self && o.team === self.team && o.alive) out.push(o);
    }
    return out;
  }

  aliveCount(team) {
    let n = 0;
    for (const c of this.combatants) {
      if (c.alive && (team === undefined || c.team === team)) n++;
    }
    return n;
  }

  /** True when a and b are on opposite sides. Accepts hosts or Combatants. */
  areEnemies(a, b) {
    const ca = this.of(a);
    const cb = this.of(b);
    if (!ca || !cb || !ca.team || !cb.team) return false;
    return ca.team !== cb.team;
  }

  /* ==================================================================== */
  /* damage attribution                                                   */
  /* ==================================================================== */

  /**
   * Record the attacker. Deliberately does NOT decide whether the victim died.
   *
   * `damage:dealt` is emitted by physics from inside the trace, and every host
   * applies its own damage from its own subscription to that same event. Whether
   * this handler sees a decremented health bar therefore depends on the order
   * the subscriptions were registered, which is subsystem init order, which is
   * the dependency graph — `match` initialises before `player` because `player`
   * depends on it, so this runs while the victim is still, on paper, unhurt.
   *
   * Rather than fight that, the alive->dead edge is detected in lateUpdate once
   * every host has settled. This handler only has to leave behind enough to say
   * who did it.
   */
  _onDamage(e) {
    const victim = this.of(e?.target);
    if (!victim) return;
    const shooter = this.of(e.source);

    // Stamp the teams for whoever handles this after us — fx and the killfeed
    // want them and physics has no way to know them.
    e.victimTeam = victim.team;
    e.sourceTeam = shooter?.team ?? null;
    e.friendly = !!(shooter && shooter !== victim && shooter.team === victim.team);

    if (shooter && shooter !== victim) shooter.damageDealt += e.amount ?? 0;
    victim._lastAttacker = shooter ?? null;
    victim._lastPart = e.part ?? 'torso';
    victim._lastHeadshot = !!e.headshot;
  }

  /* ==================================================================== */
  /* rounds                                                               */
  /* ==================================================================== */

  get phase() {
    return this.round.phase;
  }

  /** True whenever fighters must hold. `player` and `ai` poll this every frame. */
  get frozen() {
    return this.round.running && this.round.frozen;
  }

  get live() {
    return !this.round.running || this.round.live;
  }

  get scores() {
    return this.round.scores;
  }

  /** Begin (or restart) the match. `tempo` overrides `round.js`'s TEMPO table. */
  startMatch(tempo) {
    if (tempo) Object.assign(this.round.tempo, tempo);
    this._started = true;
    this.round.start();
    return this.round;
  }

  /** Halt the loop and hand the level back. Everyone unfreezes. */
  stopMatch() {
    this.autoStart = false;
    this._started = true; // do not auto-start again behind the caller's back
    this.round.stop();
  }

  /**
   * Start the loop the first frame both sides have someone in them.
   *
   * It cannot happen at init: `ai` depends on `match`, so it garrisons the
   * level strictly after this system exists, and a round begun before that
   * would open with one team at zero and end by elimination on its first tick.
   */
  _maybeStart() {
    if (this._started || !this.autoStart) return;
    if (this.aliveCount('alpha') === 0 || this.aliveCount('bravo') === 0) return;
    this._started = true;
    this.round.start();
  }

  /**
   * Round reset. Called by the RoundMachine, never directly.
   *
   * Everyone is respawned — including the dead, which is the entire point of a
   * round game — at a formation assigned fresh from the team spawn anchors.
   * Health, ammo, perception and cover claims are the hosts' own business and
   * are cleared by their `respawn()`.
   */
  resetRound() {
    const seats = this.spawner?.assign(this.combatants);
    for (const c of this.combatants) {
      const seat = seats?.get(c);
      if (seat) c.respawn(seat);
    }
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  update(dt) {
    this._maybeStart();
    this.round.update(dt);
  }

  /**
   * The player's hitbox rig is placed on the TICK, from the fixed-step feet —
   * a round lands against simulation state, so the target must be posed by it.
   * Bots place their own rigs at the end of `simulate()`; this covers the
   * 'fractions' rigs (the player), whose host has no tick hook of its own here.
   */
  fixedUpdate() {
    for (const c of this.combatants) c.syncHitboxes();
  }

  /**
   * Death bookkeeping stays on the frame: it only turns an alive->dead
   * transition into exactly one `combatant:death`, and the flag it reads is
   * simulation state that does not move between ticks.
   */
  lateUpdate() {
    for (const c of this.combatants) {
      const alive = c.alive;
      if (!alive && !c._dead) {
        c._dead = true;
        c.deaths++;
        const killer = c._lastAttacker;
        if (killer && killer !== c) {
          // A team kill costs you one instead of paying you one. Nothing in the
          // round rules reads this yet; the scoreboard in M6 does.
          killer.kills += killer.team === c.team ? -1 : 1;
        }
        const d = this._deathPayload;
        d.combatant = c;
        d.source = killer ?? null;
        d.part = c._lastPart ?? 'torso';
        d.headshot = !!c._lastHeadshot;
        this.ctx.events.emit('combatant:death', d);
      } else if (alive && c._dead) {
        // Standing again — a round reset does not need to know this field exists.
        c._dead = false;
      }
    }
  }

  get stats() {
    return {
      combatants: this.combatants.length,
      alpha: this.aliveCount('alpha'),
      bravo: this.aliveCount('bravo'),
      ...this.round.state,
    };
  }

  dispose() {
    for (const off of this._offEvents) off?.();
    this._offEvents.length = 0;
    for (const c of this.combatants) c.dispose();
    this.combatants.length = 0;
    this._byHost.clear();
  }
}

export { Combatant, TEAMS, TEAM_IDS, opposing, RoundMachine, PHASE, TEMPO };
