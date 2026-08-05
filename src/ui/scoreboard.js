/**
 * SCOREBOARD — held on Tab.
 *
 * Reads `match` directly rather than being fed a snapshot. That is a deliberate
 * exception to how the rest of this HUD works (`ui/index.js` distributes one
 * state object to every widget) and it is worth stating why: the scoreboard
 * wants *per-fighter* rows, and copying twelve fighters' worth of name, team,
 * kills, deaths, damage and alive-flag into the shared state block every frame
 * — to be read only on the frames Tab is held — would be a per-frame copy in
 * service of an occasional read.
 *
 * So it takes the roster and pulls what it needs, and only while it is open.
 * Closed, it costs one boolean compare a frame.
 *
 * Row DOM is pooled and reused. The roster is fixed for a whole match, so after
 * the first open this rebuilds nothing.
 */

import { el, setText } from './util.js';

/** Sort: alive before dead, then kills, then damage, then stable by id. */
function rank(a, b) {
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  if (b.kills !== a.kills) return b.kills - a.kills;
  if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;
  return a.id - b.id;
}

class Column {
  constructor(parent, side) {
    this.root = el('div', `ow-sb-col ${side}`, parent);
    const head = el('div', 'ow-sb-head', this.root);
    this.name = el('div', 'name', head, '');
    this.score = el('div', 'score', head, '0');
    this.alive = el('div', null, head, '');

    const cols = el('div', 'ow-sb-cols', this.root);
    el('div', null, cols, 'OPERATOR');
    el('div', 'v', cols, 'K');
    el('div', 'v', cols, 'D');
    el('div', 'v', cols, 'DMG');

    this.rows = [];
    this._list = [];
  }

  _row(i) {
    let r = this.rows[i];
    if (!r) {
      const node = el('div', 'ow-sb-row', this.root);
      r = {
        node,
        n: el('div', 'n', node, ''),
        k: el('div', 'v k', node, '0'),
        d: el('div', 'v', node, '0'),
        dmg: el('div', 'v', node, '0'),
        cls: 'ow-sb-row',
      };
      this.rows[i] = r;
    }
    return r;
  }

  update(label, score, roster) {
    setText(this.name, label);
    setText(this.score, score);

    const list = this._list;
    list.length = 0;
    let alive = 0;
    for (const c of roster) {
      list.push(c);
      if (c.alive) alive++;
    }
    list.sort(rank);
    setText(this.alive, `${alive} UP`);

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const r = this._row(i);
      const cls =
        'ow-sb-row' + (c.alive ? '' : ' down') + (c.isPlayer ? ' you' : '');
      if (r.cls !== cls) {
        r.cls = cls;
        r.node.className = cls;
      }
      r.node.style.display = '';
      setText(r.n, c.name);
      setText(r.k, c.kills);
      setText(r.d, c.deaths);
      setText(r.dmg, Math.round(c.damageDealt));
    }
    for (let i = list.length; i < this.rows.length; i++) {
      this.rows[i].node.style.display = 'none';
    }
  }
}

export class Scoreboard {
  constructor(parent) {
    this.root = el('div', 'ow-sb', parent);
    this.left = new Column(this.root, 'us');
    this.right = new Column(this.root, 'them');
    this.open = false;
    /** Roster buckets, reused — see the note at the top about per-frame copies. */
    this._us = [];
    this._them = [];
  }

  setOpen(v) {
    if (this.open === v) return;
    this.open = v;
    this.root.classList.toggle('on', v);
  }

  /**
   * @param {object} match  the MatchSystem
   * @param {string} myTeam which side the local player is on — decides which
   *   column is "us". A scoreboard that always put alpha on the left would make
   *   the player read the team names before reading the score.
   */
  update(match, myTeam) {
    if (!this.open || !match) return;
    const us = this._us;
    const them = this._them;
    us.length = 0;
    them.length = 0;
    const mine = myTeam ?? match.TEAM_IDS[0];
    for (const c of match.combatants) (c.team === mine ? us : them).push(c);

    const other = mine === match.TEAM_IDS[0] ? match.TEAM_IDS[1] : match.TEAM_IDS[0];
    this.left.update(match.TEAMS[mine]?.name ?? mine, match.scores[mine] ?? 0, us);
    this.right.update(match.TEAMS[other]?.name ?? other, match.scores[other] ?? 0, them);
  }

  dispose() {
    this.root.remove();
  }
}
