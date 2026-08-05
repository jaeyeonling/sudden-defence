/**
 * MATCH BAR — round score, phase and clock, top centre.
 *
 * The upstream HUD had this widget and never wired it: a `MatchBar` class, its
 * CSS, and a `ui.setMatch()` entry point, with zero callers anywhere in the
 * game. It was a scoreline for a game that had no score. This version is that
 * shell, filled in and re-shaped for a round game.
 *
 * Two changes from the original beyond the wiring:
 *
 *  - It sits where the compass used to. With no compass and no minimap, the
 *    round score is the only persistent chrome at the top of the screen, and
 *    leaving it in the compass's shadow would have been a hole in the layout.
 *  - It has round pips. "3-2" tells you the score; a row of filled and empty
 *    pips tells you how close the match is to being over, which is the thing
 *    you actually want to know without reading.
 *
 * Everything here is a text/class write against a value already computed by
 * `match`. No animation, no timers — see the note at the top of ui/index.js.
 */

import { el, setText, setStyle, mmss } from './util.js';

/** Below this many seconds left in a live round, the clock turns red. */
const URGENT = 10;

/** Phase -> what the middle of the bar says. */
const LABEL = {
  idle: '',
  warmup: 'WARMUP',
  freeze: 'GET READY',
  live: '',           // replaced by "ROUND n"
  roundEnd: '',       // replaced by the result
  matchEnd: 'MATCH',
};

export class MatchBar {
  constructor(parent) {
    this.root = el('div', 'ow-match', parent);

    const line = el('div', 'ow-match-line', this.root);
    this.us = el('b', 'us', line, '0');
    el('div', 'sep', line);
    this.phase = el('div', 'phase', line, '');
    this.clock = el('div', 'clock', line, '0:00');
    el('div', 'sep', line);
    this.them = el('b', 'them', line, '0');

    this.pips = el('div', 'ow-pips', this.root);
    /** Built lazily so `roundsToWin` can come from the tempo table at runtime. */
    this._pipNodes = [];
    this._pipCount = -1;

    this._lastLabel = null;
    this._lastClockClass = null;
  }

  /**
   * @param {object} s the HUD state block — reads `scoreUs`, `scoreThem`,
   *   `timeLeft`, `phase`, `round`, `roundsToWin`, `roundResult`.
   */
  update(s) {
    const us = s.scoreUs ?? 0;
    const them = s.scoreThem ?? 0;
    setText(this.us, us);
    setText(this.them, them);

    // ---- label ----
    let label = LABEL[s.phase] ?? '';
    if (s.phase === 'live') label = `ROUND ${s.round ?? 1}`;
    else if (s.phase === 'roundEnd') label = s.roundResult ?? 'ROUND OVER';
    if (label !== this._lastLabel) {
      this._lastLabel = label;
      setText(this.phase, label);
    }

    // ---- clock ----
    setText(this.clock, mmss(Math.max(0, s.timeLeft ?? 0)));
    const cls =
      s.phase === 'live'
        ? (s.timeLeft ?? 999) <= URGENT
          ? 'clock urgent'
          : 'clock'
        : 'clock hold';
    if (cls !== this._lastClockClass) {
      this._lastClockClass = cls;
      this.clock.className = cls;
    }

    this._updatePips(us, them, s.roundsToWin ?? 5);
  }

  /**
   * `roundsToWin` pips per side, filled from the middle out so the two sides
   * grow toward each other and a match point is a full row against the gap.
   */
  _updatePips(us, them, toWin) {
    if (this._pipCount !== toWin) {
      this._pipCount = toWin;
      this.pips.textContent = '';
      this._pipNodes.length = 0;
      // us: outermost pip first, so the row fills toward the centre gap
      for (let i = 0; i < toWin; i++) this._pipNodes.push(el('div', 'ow-pip', this.pips));
      el('div', 'gap', this.pips);
      for (let i = 0; i < toWin; i++) this._pipNodes.push(el('div', 'ow-pip', this.pips));
    }
    for (let i = 0; i < toWin; i++) {
      // Left half fills right-to-left; right half fills left-to-right.
      const onUs = toWin - i <= us;
      const onThem = i + 1 <= them;
      applyClass(this._pipNodes[i], onUs ? 'ow-pip us' : 'ow-pip');
      applyClass(this._pipNodes[toWin + i], onThem ? 'ow-pip them' : 'ow-pip');
    }
  }

  setVisible(v) {
    setStyle(this.root, 'display', v ? '' : 'none');
  }

  dispose() {
    this.root.remove();
  }
}

/**
 * Write a className only when it changed — a write is a style invalidation, and
 * this runs on 2N pips every frame. Named `applyClass` because `util.setClass`
 * is a different function with a different signature (node, cls, on).
 */
function applyClass(node, cls) {
  if (node.className !== cls) node.className = cls;
}
