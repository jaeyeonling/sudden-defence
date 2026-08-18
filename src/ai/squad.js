/**
 * AI — squad coordination.
 *
 * The squad exists to stop four individually-sensible soldiers from behaving
 * like one four-headed idiot: it hands out permission to peek so they alternate
 * instead of all leaning out together, shares contact reports so one man
 * spotting you alerts the rest (after a believable call-out delay), rations
 * grenades, and allows only one flanker at a time.
 */

import * as THREE from 'three';

let _nextSquad = 1;

export class Squad {
  /**
   * Snapshot classification (netcode step 5).
   *
   * The squad is the arbiter of who may lean out and who may throw, so all of it
   * rewinds except the roster. `peekHolders` and `flanker` are agent references
   * and go out as ids: a Set of pointers restored raw would hand the peek token
   * to whichever agent the address still reached.
   *
   * `members` is excluded because membership is fixed after the fill —
   * `addMember` runs at spawn and nothing removes (death is `m.alive`, not
   * removal), so the roster is structure rather than state. `peekTokens` is
   * derived from its length and is captured anyway, since it is cheap and being
   * wrong in the excluding direction is the mistake the gate cannot catch.
   */
  static snapshotState = [
    'rng', 'peekTokens', 'peekHolders', 'peekTimer', 'grenadeCooldown',
    'flanker', 'contact', 'hasContact', 'contactAge', '_pending',
  ];
  static excludedState = ['id', 'members'];

  captureState(out = {}) {
    out.rng = this.rng.captureState(out.rng);
    out.peekTokens = this.peekTokens;
    out.peekHolders = [...this.peekHolders].map((a) => a.id);
    out.peekTimer = this.peekTimer;
    out.grenadeCooldown = this.grenadeCooldown;
    out.flanker = this.flanker ? this.flanker.id : null;
    out.contact = [this.contact.x, this.contact.y, this.contact.z];
    out.hasContact = this.hasContact;
    out.contactAge = this.contactAge;
    out._pending = this._pending.map((a) => (a && a.id !== undefined ? a.id : a));
    return out;
  }

  /** `byId` maps an agent id to its instance — see `peekHolders`/`flanker`. */
  restoreState(s, byId) {
    this.rng.restoreState(s.rng);
    this.peekTokens = s.peekTokens;
    this.peekHolders.clear();
    for (const id of s.peekHolders) {
      const a = byId?.get(id);
      if (a) this.peekHolders.add(a);
    }
    this.peekTimer = s.peekTimer;
    this.grenadeCooldown = s.grenadeCooldown;
    this.flanker = s.flanker === null ? null : (byId?.get(s.flanker) ?? null);
    this.contact.set(s.contact[0], s.contact[1], s.contact[2]);
    this.hasContact = s.hasContact;
    this.contactAge = s.contactAge;
    this._pending.length = 0;
    for (const id of s._pending) {
      const a = byId?.get(id);
      if (a) this._pending.push(a);
    }
  }

  constructor(rng) {
    this.id = _nextSquad++;
    this.members = [];
    this.rng = rng;
    this.peekTokens = 1;
    this.peekHolders = new Set();
    this.peekTimer = 0;
    this.grenadeCooldown = 6;
    this.flanker = null;
    this.contact = new THREE.Vector3();
    this.hasContact = false;
    this.contactAge = Infinity;
    this._pending = [];
  }

  add(agent) {
    agent.squad = this;
    this.members.push(agent);
    this.peekTokens = Math.max(1, Math.round(this.members.length * 0.5));
    return agent;
  }

  get alive() {
    let n = 0;
    for (const m of this.members) if (m.alive) n++;
    return n;
  }

  /** Called once per frame by the AI system. */
  update(dt) {
    this.grenadeCooldown -= dt;
    this.contactAge += dt;
    if (this.flanker && (!this.flanker.alive || this.flanker.state !== 'flank')) this.flanker = null;

    // contact sharing: whoever can see the player broadcasts, with a delay
    for (const m of this.members) {
      if (!m.alive) continue;
      if (m.hasTarget && m.targetVisible) {
        this.contact.copy(m.lastKnown);
        this.hasContact = true;
        this.contactAge = 0;
        break;
      }
    }
    if (this.hasContact && this.contactAge < 4) {
      for (const m of this.members) {
        if (!m.alive || m.hasTarget) continue;
        // a call-out only gives a direction to check, never a free kill
        if (m.lastKnownAge > 1.5) {
          m.lastKnown.copy(this.contact);
          m.lastKnownAge = 0.9 + this.rng.float() * 0.8;
          m.alertness = 1;
          if (m.state === 'idle' || m.state === 'patrol') m._setState('alert');
        }
      }
    }

    // rotate the peek tokens so the same man is not always exposed
    this.peekTimer -= dt;
    if (this.peekTimer <= 0) {
      this.peekTimer = 1.1 + this.rng.float() * 1.2;
      this.peekHolders.clear();
    }
  }

  /** Ask to lean out of cover. Only `peekTokens` members may at once. */
  requestPeek(agent, _dt) {
    if (this.peekHolders.has(agent.id)) return true;
    if (this.peekHolders.size >= this.peekTokens) return false;
    this.peekHolders.add(agent.id);
    return true;
  }

  releasePeek(agent) {
    this.peekHolders.delete(agent.id);
  }

  /** One flanker at a time, and only if someone else is holding attention. */
  canFlank(agent) {
    if (this.flanker) return false;
    let shooting = 0;
    for (const m of this.members) {
      if (m !== agent && m.alive && (m.state === 'combat' || m.state === 'suppressed')) shooting++;
    }
    return shooting >= 1;
  }

  claimFlank(agent) {
    this.flanker = agent;
  }

  requestGrenade() {
    if (this.grenadeCooldown > 0) return false;
    this.grenadeCooldown = 14 + this.rng.float() * 12;
    return true;
  }
}
