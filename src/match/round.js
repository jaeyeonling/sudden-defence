/**
 * ROUND — the state machine that turns a firefight into a match.
 *
 * Deliberately pure: no THREE, no physics, no subsystem lookups. It reads two
 * numbers off `match` (`aliveCount('alpha')`, `aliveCount('bravo')`) and calls
 * back into it to reset the level. Everything else is a clock and a score.
 *
 * That constraint is what makes `tools/matchsim.mjs` possible — five rounds can
 * be driven headless at 40x speed without a renderer, because nothing in here
 * cares whether a frame was drawn.
 *
 *   idle -> warmup -> freeze -> live -> roundEnd -> (freeze | matchEnd)
 *
 * `warmup` happens once, at the top of the match. Every round after the first
 * enters at `freeze`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PHASES ARE SHAPED LIKE THIS
 *
 * `freeze` exists so a round has a start. Without it the previous round's
 * roundEnd runs straight into the next round's first shot, and whoever happened
 * to be mid-stride when the reset landed wins the opening duel. Fighters can
 * look during freeze but not move or shoot — that is the whole rule, and it is
 * enforced by `match.frozen`, which player and ai both poll.
 *
 * `roundEnd` exists so the round has an ending you can see. Elimination is
 * instantaneous and would otherwise teleport the survivors to spawn on the same
 * frame the last man dropped, which reads as a bug even when it is not.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEMPO — the numbers that decide how the game feels between fights.
 *
 * This is the one table in the round system worth arguing about. Everything
 * else here is bookkeeping; these seven numbers are the pacing of the whole
 * game, and they are stated in one place so they can be changed in one place.
 *
 * Reference points, for calibration rather than as an argument from authority:
 * Sudden Attack's 섬멸전 runs a short ready period, a round cap in the low
 * minutes, and a first-to-N match. CS:GO freezes for 15-20 s because there is
 * an economy to spend it on; there is no economy here, so freeze is only as
 * long as it takes to breathe and pick a lane.
 *
 * @type {{warmup:number, freeze:number, live:number, roundEnd:number,
 *         matchEnd:number, roundsToWin:number, maxRounds:number}}
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const TEMPO = {
  /** Once, at the top of the match. Long enough to see the map, not to get bored. */
  warmup: 4,
  /** Between rounds. Look, don't move. */
  freeze: 5,
  /** Round time limit. Expiry is judged on survivors — see `_judgeTime`. */
  live: 120,
  /** After the last man drops, before the reset. The kill-cam window. */
  roundEnd: 4,
  /** After the match is decided, before anything is allowed to restart it. */
  matchEnd: 8,
  /** First to this many rounds takes the match. */
  roundsToWin: 5,
  /** Hard cap, so a run of draws cannot go on forever. 5 to win => best of 9. */
  maxRounds: 9,
};

export const PHASE = {
  IDLE: 'idle',
  WARMUP: 'warmup',
  FREEZE: 'freeze',
  LIVE: 'live',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
};

/** Phases in which nobody may move or shoot. `live` is the only one that isn't. */
const FROZEN = new Set([PHASE.IDLE, PHASE.WARMUP, PHASE.FREEZE, PHASE.ROUND_END, PHASE.MATCH_END]);

export class RoundMachine {
  /**
   * Snapshot classification (netcode step 5). The whole machine is simulation
   * apart from its tuning and its reusable event payloads: the phase, the clock
   * inside it, the round number, the scores and the recorded outcomes all decide
   * what happens next.
   *
   * `tempo` is the TEMPO table the user signed off in `72b0699` — configuration,
   * not state.
   */
  static snapshotState = [
    'phase', 'remaining', 'round', 'scores',
    'lastWinner', 'lastReason', 'matchWinner', 'running',
  ];
  static excludedState = [
    'match', 'tempo',
    '_startPayload', '_endPayload', '_matchPayload', '_phasePayload',
  ];

  captureState(out = {}) {
    out.phase = this.phase;
    out.remaining = this.remaining;
    out.round = this.round;
    out.scores = { ...this.scores };
    out.lastWinner = this.lastWinner;
    out.lastReason = this.lastReason;
    out.matchWinner = this.matchWinner;
    out.running = this.running;
    return out;
  }

  restoreState(s) {
    this.phase = s.phase;
    this.remaining = s.remaining;
    this.round = s.round;
    Object.assign(this.scores, s.scores);
    this.lastWinner = s.lastWinner;
    this.lastReason = s.lastReason;
    this.matchWinner = s.matchWinner;
    this.running = s.running;
  }

  /**
   * @param {object} match  the MatchSystem — used for aliveCount, resetRound,
   *                        and the event bus. Nothing else.
   * @param {object} [tempo] overrides for TEMPO, merged over the defaults.
   */
  constructor(match, tempo = {}) {
    this.match = match;
    this.tempo = { ...TEMPO, ...tempo };

    this.phase = PHASE.IDLE;
    /** Seconds left in the current phase. Counts down; UI reads it directly. */
    this.remaining = 0;
    /** 1-based. 0 while idle. */
    this.round = 0;
    this.scores = { alpha: 0, bravo: 0 };
    /** Set at roundEnd, cleared at the next freeze. UI banner reads these. */
    this.lastWinner = null;
    this.lastReason = null;
    this.matchWinner = null;
    this.running = false;

    // Preallocated payloads — these fire a handful of times a match, but the
    // rule is the rule and a leak here would be invisible.
    this._startPayload = { round: 0, scores: this.scores };
    this._endPayload = { round: 0, winner: null, reason: 'elimination', scores: this.scores };
    this._matchPayload = { winner: null, scores: this.scores };
    this._phasePayload = { phase: PHASE.IDLE, round: 0, remaining: 0, scores: this.scores };
  }

  get frozen() {
    return FROZEN.has(this.phase);
  }

  get live() {
    return this.phase === PHASE.LIVE;
  }

  get over() {
    return this.phase === PHASE.MATCH_END;
  }

  /* ==================================================================== */

  /** Begin a match. Resets scores; safe to call on an already-running machine. */
  start() {
    this.running = true;
    this.round = 0;
    this.scores.alpha = 0;
    this.scores.bravo = 0;
    this.matchWinner = null;
    this.lastWinner = null;
    this.lastReason = null;
    this._enter(PHASE.WARMUP, this.tempo.warmup);
    return this;
  }

  /**
   * Halt the machine and unfreeze everyone.
   *
   * Harnesses that want a raw firefight (`tools/botfight.mjs`) call this: they
   * are measuring whether bots can fight, and a round loop resetting the level
   * underneath them would be measuring something else.
   */
  stop() {
    this.running = false;
    this.phase = PHASE.IDLE;
    this.remaining = 0;
  }

  update(dt) {
    if (!this.running || this.phase === PHASE.IDLE) return;
    this.remaining = Math.max(0, this.remaining - dt);

    switch (this.phase) {
      case PHASE.WARMUP:
      case PHASE.FREEZE:
        if (this.remaining <= 0) this._beginRound();
        break;

      case PHASE.LIVE: {
        // Elimination is checked every tick, not on a death event: a grenade or
        // a penetrating round can drop two fighters inside one frame, and an
        // event handler would then judge the round on the first of them.
        const a = this.match.aliveCount('alpha');
        const b = this.match.aliveCount('bravo');
        if (a === 0 || b === 0) {
          this._finishRound(a === b ? null : a > 0 ? 'alpha' : 'bravo', 'elimination');
        } else if (this.remaining <= 0) {
          this._finishRound(this._judgeTime(a, b), 'time');
        }
        break;
      }

      case PHASE.ROUND_END:
        if (this.remaining <= 0) this._afterRound();
        break;

      case PHASE.MATCH_END:
        // Terminal. The machine stays here until something calls start() again.
        break;

      default:
        break;
    }
  }

  /* ==================================================================== */
  /* transitions                                                          */
  /* ==================================================================== */

  _enter(phase, seconds) {
    this.phase = phase;
    this.remaining = seconds;
    const p = this._phasePayload;
    p.phase = phase;
    p.round = this.round;
    p.remaining = seconds;
    this.match.ctx.events.emit('round:phase', p);
  }

  /** Put everyone back on their feet, then hand the level to the players. */
  _beginRound() {
    this.round++;
    this.lastWinner = null;
    this.lastReason = null;
    this.match.resetRound(this.round);
    this._startPayload.round = this.round;
    this.match.ctx.events.emit('round:start', this._startPayload);
    this._enter(PHASE.LIVE, this.tempo.live);
  }

  /**
   * Time expiry is judged on SURVIVORS, not on damage dealt.
   *
   * Damage would reward the side that traded better, which sounds fairer and
   * plays worse: it makes a losing team's best move at 0:10 an aggressive push
   * for chip damage, when the interesting decision at 0:10 is whether to hold
   * what you have. Counting bodies makes staying alive the thing that wins, and
   * a genuine tie is a draw rather than a coin flip.
   */
  _judgeTime(alphaAlive, bravoAlive) {
    if (alphaAlive === bravoAlive) return null;
    return alphaAlive > bravoAlive ? 'alpha' : 'bravo';
  }

  _finishRound(winner, reason) {
    this.lastWinner = winner;
    this.lastReason = winner === null ? 'draw' : reason;
    if (winner) this.scores[winner]++;
    const e = this._endPayload;
    e.round = this.round;
    e.winner = winner;
    e.reason = this.lastReason;
    this.match.ctx.events.emit('round:end', e);
    this._enter(PHASE.ROUND_END, this.tempo.roundEnd);
  }

  /** Decide whether the match continues, then either freeze again or stop. */
  _afterRound() {
    const { roundsToWin, maxRounds } = this.tempo;
    const { alpha, bravo } = this.scores;

    if (alpha >= roundsToWin || bravo >= roundsToWin || this.round >= maxRounds) {
      this.matchWinner = alpha === bravo ? null : alpha > bravo ? 'alpha' : 'bravo';
      this._matchPayload.winner = this.matchWinner;
      this.match.ctx.events.emit('match:end', this._matchPayload);
      this._enter(PHASE.MATCH_END, this.tempo.matchEnd);
      return;
    }
    this._enter(PHASE.FREEZE, this.tempo.freeze);
  }

  /** Snapshot for the HUD and the harnesses. */
  get state() {
    return {
      phase: this.phase,
      round: this.round,
      remaining: +this.remaining.toFixed(2),
      alpha: this.scores.alpha,
      bravo: this.scores.bravo,
      winner: this.lastWinner,
      reason: this.lastReason,
      matchWinner: this.matchWinner,
    };
  }
}
