/**
 * SPECTATE OVERLAY — one line, low centre, while you are dead.
 *
 * The camera work is not here; it is in `src/player/spectate.js`, because
 * `player` owns the camera transform and two systems writing it on the same
 * frame is a race decided by update order. This file draws a name.
 *
 * Deliberately not a panel. You are watching the game and the game is behind
 * this text, so the text stays out of the way: three lines, no plate, no border.
 */

import { el, setText } from './util.js';

export class SpectateOverlay {
  constructor(parent) {
    this.root = el('div', 'ow-spec', parent);
    el('div', 'dead', this.root, 'ELIMINATED');
    this.who = el('div', 'who', this.root, '');
    this.hint = el('div', 'hint', this.root, 'FIRE — NEXT TEAMMATE');
    this.on = false;
    this._name = null;
  }

  /**
   * @param {object|null} target the Combatant being followed, or null
   * @param {boolean} dead       whether the local player is down
   */
  update(target, dead) {
    const on = !!dead;
    if (on !== this.on) {
      this.on = on;
      this.root.classList.toggle('on', on);
    }
    if (!on) return;

    // No living team-mate is a real state, not an error: you were the last one
    // up, and the round is about to end. Saying so is better than showing an
    // empty line where a name should be.
    const name = target ? target.name : 'NO TEAMMATES LEFT';
    if (name !== this._name) {
      this._name = name;
      setText(this.who, name);
      this.hint.style.visibility = target ? '' : 'hidden';
    }
  }

  dispose() {
    this.root.remove();
  }
}
